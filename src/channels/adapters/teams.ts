import { TeamsClient, TeamsError, TeamsListener } from 'agent-messenger/teams'
import type { TeamsListenerEventMap, TeamsMessage, TeamsUser } from 'agent-messenger/teams'

import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
import { fallbackChannelAccountIdentity } from '@/channels/types'
import type {
  ChannelHistoryMessage,
  ChannelSelfIdentityResolver,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  OutboundCallback,
  OutboundMessage,
  SendResult,
} from '@/channels/types'
import type { TeamsAccountRecord } from '@/secrets/schema'

import { describeError } from '../describe-error'
import { withOutboundAccount } from './outbound-account'
import {
  classifyChannelInbound,
  classifyChatInbound,
  teamsEchoTextKey,
  type InboundDropReason,
  type TeamsInboundEvent,
} from './teams-classify'
import { createTeamsEditMessageCallback } from './teams-edit'
import { TEAMS_OUTBOUND_FORMAT } from './teams-format'
import { ContainerTeamsClient } from './teams-id-token'
import { decodeTeamsConversationKey } from './teams-key'

// `TeamsChat` is not exported from agent-messenger/teams, so derive its shape
// from the client method that returns it — this stays in lockstep with the SDK
// without depending on a named export the package chose to keep internal.
export type TeamsChatInfo = Awaited<ReturnType<TeamsClient['listChats']>>[number]

export type TeamsAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: TeamsAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type TeamsClientFactory = () => TeamsClient
export type TeamsListenerFactory = (client: TeamsClient) => TeamsListener

export type TeamsCredentialStore = {
  getAccount(id?: string): Promise<TeamsAccountRecord | null>
}

export type TeamsAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: TeamsAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: TeamsCredentialStore
  createClient?: TeamsClientFactory
  createListener?: TeamsListenerFactory
  now?: () => number
}

export type TeamsAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

const TEAMS_LISTENER_START_TIMEOUT_MS = 20_000

// The Teams user-account SDK has NO self-identity boundary: `testAuth()` returns
// the literal id `'ME'`, while realtime/history authors carry the real MRI from
// `resource.from`. So an id comparison can never recognize the agent's own
// message echoing back over the trouter socket. Instead every successful send
// records a (chat, normalized-text) fingerprint; an inbound that matches a
// recent unconsumed fingerprint in the same chat is treated as the echo of our
// own send and dropped. The author-name / `'ME'` checks are a fast path; the
// short content-only window is the fallback for when the platform does not
// stamp the outbound back with our display name.
const SELF_ECHO_TTL_MS = 2 * 60_000
const SELF_ECHO_CONTENT_ONLY_TTL_MS = 5_000
const MAX_SENT_ECHOES = 200

type SentEcho = { chatId: string; textKey: string; sentAt: number; consumed: boolean }

export function createOutboundCallback(deps: {
  client: Pick<TeamsClient, 'sendChatMessage' | 'sendMessage'>
  logger: TeamsAdapterLogger
  // Reserve the self-echo fingerprint BEFORE the send is awaited and return a
  // rollback. Teams delivers a send back over the listener socket, and that
  // echo can arrive before the send resolves — reserving after the await would
  // leave a window where the agent's own message routes back in. The key is the
  // conversation id the echo will carry (chatId for chats, channelId for
  // channels). The rollback drops the reservation if the send ultimately fails.
  reserveEcho?: (conversationId: string, text: string) => () => void
}): OutboundCallback {
  const { client, logger } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'teams') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    const text = msg.text ?? ''
    if (text === '') return { ok: false, error: 'message has no text' }
    const decoded = decodeTeamsConversationKey(msg.chat)
    if (decoded === null) return { ok: false, error: `unsupported Teams conversation id: ${msg.chat}` }

    const conversationId = decoded.kind === 'chat' ? decoded.chatId : decoded.channelId
    logger.info(`[teams] outbound ${decoded.kind}=${conversationId} text_len=${text.length}`)
    const rollbackEcho = deps.reserveEcho?.(conversationId, text)
    try {
      const sent =
        decoded.kind === 'chat'
          ? await client.sendChatMessage(decoded.chatId, text, TEAMS_OUTBOUND_FORMAT)
          : await client.sendMessage(
              decoded.teamId,
              decoded.channelId,
              text,
              msg.thread ?? undefined,
              TEAMS_OUTBOUND_FORMAT,
            )
      logger.info(`[teams] sent id=${sent.id} ${decoded.kind}=${conversationId}`)
      return { ok: true, messageId: sent.id, messageIds: [sent.id] }
    } catch (err) {
      rollbackEcho?.()
      const message = describeError(err)
      logger.error(`[teams] outbound failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createTeamsHistoryCallback(deps: {
  client: Pick<TeamsClient, 'getChatMessages' | 'getMessages'>
  logger: TeamsAdapterLogger
  selfIdRef: () => string | null
}): HistoryCallback {
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const decoded = decodeTeamsConversationKey(args.chat)
    if (decoded === null) return { ok: false, error: `unsupported Teams conversation id: ${args.chat}` }
    const limit = clampLimit(args.limit, 100)
    try {
      const messages =
        decoded.kind === 'chat'
          ? await deps.client.getChatMessages(decoded.chatId, limit)
          : await deps.client.getMessages(decoded.teamId, decoded.channelId, limit)
      const selfId = deps.selfIdRef()
      return { ok: true, messages: messages.map((m) => mapTeamsHistoryMessage(m, selfId)).reverse() }
    } catch (err) {
      const message = describeError(err)
      deps.logger.warn(`[teams] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createTeamsAdapter(options: TeamsAdapterOptions): TeamsAdapter {
  const logger = options.logger ?? consoleLogger
  const now = options.now ?? Date.now
  let loadedAccount: TeamsAccountRecord | null = null
  const createClient = options.createClient ?? (() => new ContainerTeamsClient(() => loadedAccount))
  const createListener = options.createListener ?? ((client) => new TeamsListener(client))
  const client = createClient()
  let listener: TeamsListener | null = null
  let self: TeamsUser | null = null
  let chatsById = new Map<string, TeamsChatInfo>()
  let channelTeamMap = new Map<string, string>()
  let sentEchoes: SentEcho[] = []
  let started = false
  let realtimeConnected = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const selfIdentityResolver: ChannelSelfIdentityResolver = () =>
    self !== null ? { id: self.id, username: self.userPrincipalName ?? self.email ?? self.displayName } : null

  const reserveEcho = (chatId: string, text: string): (() => void) => {
    const echo: SentEcho = { chatId, textKey: teamsEchoTextKey(text), sentAt: now(), consumed: false }
    sentEchoes.push(echo)
    if (sentEchoes.length > MAX_SENT_ECHOES) sentEchoes = sentEchoes.slice(-MAX_SENT_ECHOES)
    return () => {
      const index = sentEchoes.indexOf(echo)
      if (index !== -1) sentEchoes.splice(index, 1)
    }
  }

  const isSelfEcho = (event: TeamsInboundEvent): boolean => {
    const conversationId = echoConversationId(event)
    const textKey = teamsEchoTextKey(event.content)
    const authorName = event.author.displayName.trim().toLocaleLowerCase()
    const selfName = (self?.displayName ?? '').trim().toLocaleLowerCase()
    const nowMs = now()
    for (const echo of sentEchoes) {
      if (echo.consumed || echo.chatId !== conversationId || echo.textKey !== textKey) continue
      const age = nowMs - echo.sentAt
      if (age > SELF_ECHO_TTL_MS) continue
      const authorLooksSelf =
        event.author.id === 'ME' || (selfName !== '' && authorName === selfName) || authorName === 'me'
      if (authorLooksSelf || age <= SELF_ECHO_CONTENT_ONLY_TTL_MS) {
        echo.consumed = true
        return true
      }
    }
    return false
  }

  const outboundCallback = withOutboundAccount(createOutboundCallback({ client, logger, reserveEcho }), (workspace) =>
    fallbackChannelAccountIdentity('teams', workspace, self?.id),
  )
  const historyCallback = createTeamsHistoryCallback({ client, logger, selfIdRef: () => self?.id ?? null })
  const editMessageCallback = createTeamsEditMessageCallback({ client })

  const refreshChats = async (): Promise<void> => {
    const chats = await client.listChats()
    chatsById = new Map(chats.map((chat) => [chat.id, chat]))
  }

  const resolveChat = async (chatId: string): Promise<TeamsChatInfo | undefined> => {
    const cached = chatsById.get(chatId)
    if (cached !== undefined) return cached
    try {
      await refreshChats()
    } catch (err) {
      logger.warn(`[teams] chat refresh failed: ${describeError(err)}`)
    }
    return chatsById.get(chatId)
  }

  // For a channel event the SDK resolves teamId out-of-band and populates it on
  // the event; `channelTeamMap` is only a defensive fallback for the rare case
  // the SDK emits a channel-typed event with teamId missing. channelId always
  // equals the conversation id (== event.chatId) for channels.
  const resolveChannel = (event: TeamsInboundEvent): { teamId: string; channelId: string } | null => {
    const channelId = event.channelId ?? event.chatId
    const teamId = event.teamId ?? channelTeamMap.get(channelId)
    if (teamId === undefined || channelId === '') return null
    return { teamId, channelId }
  }

  const handleMessage = async (event: TeamsInboundEvent): Promise<void> => {
    const selfSnapshot = self
    inflightInbounds++
    try {
      if (isSelfEcho(event)) {
        logger.info(`[teams] dropped id=${event.id} reason=self_echo`)
        return
      }
      const aliases = options.selfAliasesRef?.() ?? []
      let verdict
      if (event.conversationType === 'channel') {
        const channel = resolveChannel(event)
        verdict =
          channel === null
            ? ({ kind: 'drop', reason: 'unknown_channel' } as const)
            : classifyChannelInbound(event, options.configRef(), selfSnapshot, channel, aliases)
      } else {
        const chat = await resolveChat(event.chatId)
        verdict = classifyChatInbound(event, options.configRef(), selfSnapshot, chat, aliases)
      }
      if (verdict.kind === 'drop') {
        logger.info(`[teams] dropped id=${event.id} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }
      logger.info(
        `[teams] routed id=${event.id} ${event.conversationType}=${event.chatId} mention=${verdict.payload.isBotMention} dm=${verdict.payload.isDm}`,
      )
      await options.router.route({
        ...verdict.payload,
        accountIdentity: fallbackChannelAccountIdentity('teams', verdict.payload.workspace, selfSnapshot?.id),
        eventKind: 'message',
        revision: 'original',
      })
    } catch (err) {
      logger.error(`[teams] handleInbound failed: ${describeError(err)}`)
    } finally {
      inflightInbounds--
      if (inflightInbounds === 0 && stopWaiters.length > 0) {
        const waiters = stopWaiters
        stopWaiters = []
        for (const w of waiters) w()
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      realtimeConnected = false
      try {
        const account = await (options.credentialsStore ?? null)?.getAccount()
        if (account === null || account === undefined) {
          throw new Error('no Teams account in secrets.json#channels.teams (run typeclaw init to authenticate)')
        }
        warnIfTokenExpiring(account, logger, now())
        await client.login({
          token: account.access_token,
          ...(account.token_expires_at !== undefined ? { tokenExpiresAt: account.token_expires_at } : {}),
          accountType: account.account_type,
          ...(account.region !== undefined ? { region: account.region } : {}),
        })
        self = await client.testAuth()
        loadedAccount = account
        await refreshChats()
        // Best-effort channelId->teamId map: the SDK already resolves teamId on
        // channel events, so this only backs the defensive fallback in
        // resolveChannel. A failure here must not block startup.
        try {
          channelTeamMap = await client.buildChannelTeamMap()
        } catch (err) {
          logger.warn(`[teams] channel-team map build failed: ${describeError(err)}`)
        }
        logger.info(`[teams] authenticated as ${self.displayName}, ${chatsById.size} chats`)
      } catch (err) {
        started = false
        realtimeConnected = false
        self = null
        loadedAccount = null
        chatsById = new Map()
        channelTeamMap = new Map()
        logger.error(`[teams] login failed: ${describeError(err)}`)
        throw err
      }

      // REST auth succeeded, so send/history/self-identity work regardless of
      // whether the realtime listener can connect. Register them now and NEVER
      // unregister them on a listener failure — realtime is a best-effort
      // add-on, not a precondition for the adapter being usable.
      options.router.registerOutbound('teams', outboundCallback)
      options.router.registerSelfIdentity('teams', selfIdentityResolver)
      options.router.registerHistory('teams', historyCallback)
      options.router.registerEditMessage('teams', editMessageCallback)

      listener = createListener(client)
      const activeListener = listener
      const isActive = (): boolean => listener === activeListener && started

      // The realtime trouter listener needs an id_token the container mints from
      // the account's AAD refresh token. When that is unavailable (legacy
      // extracted-token account, expired refresh token, or a genuine trouter
      // outage) the SDK rejects — and, crucially, on a still-running listener it
      // schedules an UNBOUNDED reconnect that re-fails and re-emits `error`
      // forever. Rather than fail the whole adapter (or let it log-loop), tear
      // the listener down and keep running REST-only: send/read still work, we
      // just don't get proactively woken by inbound Teams messages.
      const degradeToRestOnly = (cause: Error): void => {
        if (listener !== activeListener) return
        realtimeConnected = false
        listener?.stop()
        listener = null
        logger.warn(
          `[teams] realtime listener unavailable, continuing REST-only (send/read work, no proactive inbound): ${describeError(cause)}`,
        )
      }

      listener.on('connected', () => {
        if (!isActive()) return
        realtimeConnected = true
        logger.info('[teams] connected')
      })
      listener.on('disconnected', () => {
        if (!isActive()) return
        realtimeConnected = false
        logger.warn('[teams] disconnected')
      })
      // A post-connect `error` for the unrecoverable id_token failure would
      // otherwise loop forever through the SDK's reconnect (each retry re-mints
      // nothing and re-emits `error`). Degrade to REST-only on that specific
      // cause so the loop stops; transient socket errors keep just logging and
      // let the SDK's own reconnect recover them.
      listener.on('error', (err: TeamsListenerEventMap['error'][0]) => {
        if (!isActive()) return
        if (isUnrecoverableRealtimeAuthError(err)) {
          degradeToRestOnly(err)
          return
        }
        logger.error(`[teams] listener error: ${describeError(err)}`)
      })
      listener.on('message', (event: TeamsListenerEventMap['message'][0]) => {
        void handleMessage(event)
      })

      // The SDK emits `connected` asynchronously, only after the trouter
      // WebSocket registers an endpoint — it is NOT raised synchronously by
      // `listener.start()`. So attach the connected/error race BEFORE start()
      // and await it, rather than sampling a flag right after start() returns.
      const connectedWait = waitForTeamsConnected(listener)
      try {
        await listener.start()
        await connectedWait.promise
        logger.info('[teams] realtime listener connected')
      } catch (err) {
        // Tear down the connected wait first: if `listener.start()` itself
        // rejected, `connectedWait.promise` was never awaited, so its timer and
        // handlers would otherwise linger and reject later unhandled.
        connectedWait.cancel()
        degradeToRestOnly(err instanceof Error ? err : new Error(describeError(err)))
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      realtimeConnected = false
      options.router.unregisterOutbound('teams', outboundCallback)
      options.router.unregisterSelfIdentity('teams', selfIdentityResolver)
      options.router.unregisterHistory('teams', historyCallback)
      options.router.unregisterEditMessage('teams', editMessageCallback)
      listener?.stop()
      listener = null
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      self = null
      chatsById = new Map()
      channelTeamMap = new Map()
      sentEchoes = []
    },

    isConnected(): boolean {
      return started && self !== null && realtimeConnected
    },
  }
}

// Returns the connected/error/timeout race plus a `cancel` that tears down the
// timer and listener handlers. `cancel` is load-bearing: if `listener.start()`
// itself rejects, the caller never awaits `promise`, so without cancellation
// the 20s timer would linger and the promise could later reject with no handler
// (an unhandled rejection). Cancelling resolves the promise as a no-op so it
// stays handled.
function waitForTeamsConnected(
  listener: TeamsListener,
  timeoutMs = TEAMS_LISTENER_START_TIMEOUT_MS,
): { promise: Promise<void>; cancel: () => void } {
  let settled = false
  let onConnected: () => void = () => {}
  let onError: (err: Error) => void = () => {}
  let resolveNoop: () => void = () => {}
  let timer: ReturnType<typeof setTimeout>
  const cleanup = (): void => {
    clearTimeout(timer)
    listener.off('connected', onConnected)
    listener.off('error', onError)
  }
  const promise = new Promise<void>((resolve, reject) => {
    resolveNoop = resolve
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    onConnected = (): void => settle(resolve)
    onError = (err: Error): void => settle(() => reject(err))
    timer = setTimeout(
      () => settle(() => reject(new Error(`Teams listener did not connect within ${timeoutMs}ms`))),
      timeoutMs,
    )
    listener.on('connected', onConnected)
    listener.on('error', onError)
  })
  const cancel = (): void => {
    if (settled) return
    settled = true
    cleanup()
    resolveNoop()
  }
  return { promise, cancel }
}

// Both `getChatMessages` and `getMessages` already strip HTML and set
// `author.id` to the real MRI (never `'ME'`), so bot-authored history can only
// be recognized when the caller knows that MRI — which the SDK does not
// surface. `selfId` is therefore best-effort: it flags nothing in practice
// today, but leaving the comparison in place means history attribution starts
// working for free if a future SDK version exposes the real self id.
function mapTeamsHistoryMessage(msg: TeamsMessage, selfId: string | null): ChannelHistoryMessage {
  const ts = Date.parse(msg.timestamp)
  return {
    externalMessageId: msg.id,
    authorId: msg.author.id,
    authorName: msg.author.displayName,
    text: msg.content,
    ts: Number.isFinite(ts) ? ts : 0,
    isBot: selfId !== null && msg.author.id === selfId,
    replyToBotMessageId: null,
  }
}

function warnIfTokenExpiring(account: TeamsAccountRecord, logger: TeamsAdapterLogger, nowMs: number): void {
  if (account.token_expires_at === undefined) return
  const expiresAt = Date.parse(account.token_expires_at)
  if (!Number.isFinite(expiresAt)) return
  if (expiresAt <= nowMs) {
    logger.warn('[teams] access token is already expired; the adapter will fail until credentials are refreshed')
  } else if (expiresAt - nowMs <= 10 * 60_000) {
    logger.warn('[teams] access token expires soon; long-running sessions will stop until credentials are refreshed')
  }
}

// The SDK throws a `TeamsError` with code `no_id_token` when it cannot obtain
// the trouter id_token. In the container that never self-heals (the token is
// minted from the AAD refresh token, so if minting fails once it keeps failing
// every reconnect), so treat it as the signal to stop the doomed reconnect loop
// and degrade. Transient socket errors carry other codes / plain Errors and are
// left for the SDK's own reconnect to recover.
function isUnrecoverableRealtimeAuthError(err: unknown): boolean {
  return err instanceof TeamsError && err.code === 'no_id_token'
}

// The echo the socket delivers back for our own send carries the conversation
// id it was sent to: the channelId for a channel send, the chatId otherwise.
// (channelId == chatId for channel events today, but prefer channelId so the
// ledger stays correct if the SDK ever distinguishes them.)
function echoConversationId(event: TeamsInboundEvent): string {
  if (event.conversationType === 'channel') return event.channelId ?? event.chatId
  return event.chatId
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_content':
      return ' (message had no text)'
    case 'unknown_chat':
      return ' (chat id not found even after refresh)'
    case 'unknown_channel':
      return ' (channel message missing a resolvable teamId)'
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}
