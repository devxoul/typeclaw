import {
  LineClient as RealLineClient,
  type LineCredentialManager,
  LineListener as RealLineListener,
  type LineAccountCredentials,
  type LineChat,
  type LineConfig,
  type LineListenerEventMap,
  type LineMessage,
  type LineProfile,
  type LinePushMessageEvent,
  type LineSendResult,
} from 'agent-messenger/line'

import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
import { fallbackChannelAccountIdentity } from '@/channels/types'
import type {
  ChannelSelfIdentityResolver,
  ChannelHistoryMessage,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
} from '@/channels/types'

import { describeError } from '../describe-error'
import { splitInboundLine } from './line-attachment'
import { createLineChannelResolver } from './line-channel-resolver'
import { classifyInbound } from './line-classify'
import { toLinePlainText } from './line-format'
import { LINE_TOKEN_REFRESH_SKEW_MS, nextRefreshDelayMs } from './line-token'
import { withOutboundAccount } from './outbound-account'

// Structural duck-type of the upstream LineClient class. Declaring this as an
// interface (rather than reusing the nominal class type) lets test fakes
// satisfy the public surface without inheriting the class's private fields.
// The cast on the const below bridges the runtime class onto this interface.
export interface LineClient {
  login(credentials?: LineAccountCredentials): Promise<this>
  getProfile(): Promise<LineProfile>
  getChats(options?: { limit?: number }): Promise<LineChat[]>
  getMessages(chatId: string, options?: { count?: number }): Promise<LineMessage[]>
  sendMessage(chatId: string, text: string): Promise<LineSendResult>
  close(): void
  // Optional on the structural type: older SDK builds predate the refresh
  // surface, so the adapter feature-detects both before using them and a
  // missing method degrades to "no proactive refresh" rather than a crash.
  ensureFreshAuthToken?: (options?: { skewMs?: number }) => Promise<string | null>
  onTokenUpdate?: (listener: (authToken: string) => void) => void
}

export interface LineListener {
  start(): Promise<void>
  stop(): void
  on<K extends keyof LineListenerEventMap>(event: K, listener: (...args: LineListenerEventMap[K]) => void): this
  off<K extends keyof LineListenerEventMap>(event: K, listener: (...args: LineListenerEventMap[K]) => void): this
}

export type LineCredentialStore = {
  load(): Promise<LineConfig>
  getAccount(id?: string): Promise<LineAccountCredentials | null>
  setAccount?(account: LineAccountCredentials): Promise<void>
}

const LineClient = RealLineClient as unknown as new (credManager?: LineCredentialManager) => LineClient
const LineListener = RealLineListener as unknown as new (client: LineClient) => LineListener

export type LineAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: LineAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type LineAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: LineAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: LineCredentialStore
  client?: LineClient
  clientFactory?: (credManager?: LineCredentialManager) => LineClient
  listenerFactory?: (client: LineClient) => LineListener
  now?: () => number
}

export type LineAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export const LINE_HISTORY_LIMIT_MAX = 200

export function createOutboundCallback(deps: {
  client: Pick<LineClient, 'sendMessage'>
  logger: LineAdapterLogger
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
}): OutboundCallback {
  const { client, logger, formatChannelTag } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'line') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    // LINE's SDK exposes text sends only — there is no attachment upload
    // primitive, so an outbound carrying attachments is rejected loudly
    // rather than silently dropping the files.
    if (msg.attachments !== undefined && msg.attachments.length > 0) {
      return { ok: false, error: 'line adapter does not support outbound attachments' }
    }
    const text = toLinePlainText(msg.text ?? '')
    if (text === '') {
      return { ok: false, error: 'message has no text' }
    }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(`[line] outbound ${tag} text_len=${text.length}`)
    try {
      const result = await client.sendMessage(msg.chat, text)
      if (!result.success) {
        logger.error(`[line] sendMessage non-success ${tag}`)
        return { ok: false, error: 'line send failed' }
      }
      logger.info(`[line] sent message_id=${result.message_id} ${tag}`)
      return { ok: true, messageId: result.message_id, messageIds: [result.message_id] }
    } catch (err) {
      const message = describeError(err)
      logger.error(`[line] sendMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createLineHistoryCallback(deps: {
  client: Pick<LineClient, 'getMessages'>
  logger: LineAdapterLogger
  selfUserIdRef: () => string | null
}): HistoryCallback {
  const { client, logger, selfUserIdRef } = deps
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const limit = clampLimit(args.limit, LINE_HISTORY_LIMIT_MAX)
    try {
      const messages = await client.getMessages(args.chat, { count: limit })
      const selfId = selfUserIdRef()
      const mapped: ChannelHistoryMessage[] = messages.map((m) => {
        const parsed = Date.parse(m.sent_at)
        return {
          externalMessageId: m.message_id,
          authorId: m.author_id,
          authorName: m.author_name ?? m.author_id,
          text: m.text ?? '',
          ts: Number.isNaN(parsed) ? 0 : parsed,
          isBot: selfId !== null && m.author_id === selfId,
          replyToBotMessageId: null,
        }
      })
      return { ok: true, messages: mapped }
    } catch (err) {
      const message = describeError(err)
      logger.warn(`[line] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

export function createLineAdapter(options: LineAdapterOptions): LineAdapter {
  const logger = options.logger ?? consoleLogger
  // LineListener.connect() re-calls client.login() with NO arguments on every
  // (re)connect, which resolves credentials via the client's credential manager
  // rather than the explicit account start() passes. Wire the secrets.json store
  // in as that manager (same structural cast as src/init/line-auth.ts) so the
  // reconnect path doesn't fall through to the SDK's default file-based manager
  // and loop forever on "No account found".
  const credManager = options.credentialsStore as unknown as LineCredentialManager | undefined
  const buildClient = options.clientFactory ?? ((cm?: LineCredentialManager) => new LineClient(cm))
  const client = options.client ?? buildClient(credManager)
  let listener: LineListener | null = null
  let selfUserId: string | null = null
  const selfIdentityResolver: ChannelSelfIdentityResolver = () => (selfUserId === null ? null : { id: selfUserId })
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  // currentAuthToken tracks the freshest known token for refresh SCHEDULING;
  // lastPersistedToken is the dedupe marker and only advances after a write to
  // secrets actually succeeds, so a failed persist can be retried with the same
  // token instead of being silently swallowed by the dedupe early-return.
  let currentAuthToken: string | null = null
  let lastPersistedToken: string | null = null
  const now = options.now ?? Date.now

  const channelResolver = createLineChannelResolver({ client, logger })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver
      .resolve({ adapter: 'line', workspace, chat, thread: null })
      .catch(() => ({}) as ResolvedChannelNames)
    return `bucket=${workspace} chat=${formatLabel(names.chatName, chat)}`
  }

  const historyCallback = createLineHistoryCallback({
    client,
    logger,
    selfUserIdRef: () => selfUserId,
  })

  const outboundCallback = withOutboundAccount(
    createOutboundCallback({ client, logger, formatChannelTag }),
    (workspace) => fallbackChannelAccountIdentity('line', workspace, selfUserId),
  )

  // The SDK's AuthService updates the LIVE client's token in-place and emits this
  // event; we mirror it into secrets.json so the next container start boots from a
  // fresh token instead of a dead one. The refresh token (which rotates on use)
  // stays the SDK FileStorage's responsibility and is never copied here.
  const persistAuthToken = async (authToken: string): Promise<void> => {
    currentAuthToken = authToken
    if (authToken === lastPersistedToken) return
    const store = options.credentialsStore
    if (!store?.setAccount) return
    try {
      const account = await store.getAccount()
      if (account === null) return
      await store.setAccount({ ...account, auth_token: authToken, updated_at: new Date(now()).toISOString() })
      lastPersistedToken = authToken
      logger.info('[line] persisted refreshed auth token to secrets')
    } catch (err) {
      logger.warn(`[line] failed to persist refreshed auth token: ${describeError(err)}`)
    }
  }

  const refreshNow = async (): Promise<void> => {
    if (!client.ensureFreshAuthToken) return
    try {
      const token = await client.ensureFreshAuthToken({ skewMs: LINE_TOKEN_REFRESH_SKEW_MS })
      if (token) await persistAuthToken(token)
    } catch (err) {
      logger.warn(`[line] token refresh failed: ${describeError(err)}`)
    }
  }

  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    if (!client.ensureFreshAuthToken) return
    const token = currentAuthToken
    const delay = token ? nextRefreshDelayMs(token, now()) : LINE_TOKEN_REFRESH_SKEW_MS
    refreshTimer = setTimeout(() => {
      void (async () => {
        if (!started) return
        await refreshNow()
        if (started) scheduleRefresh()
      })()
    }, delay)
    refreshTimer.unref?.()
  }

  const processInbound = async (event: LinePushMessageEvent): Promise<void> => {
    const inboundSelfId = selfUserId
    inflightInbounds++
    try {
      if (channelResolver.lookupChat(event.chat_id) === null) {
        await channelResolver.refresh()
        if (channelResolver.lookupChat(event.chat_id) === null) {
          // The push event itself proves the chat exists even when GETCHATS
          // hasn't surfaced it yet. Register a provisional @line-group entry
          // (the strictest multi-party bucket) so the message is not silently
          // dropped as unknown_chat; the next refresh upgrades it.
          channelResolver.ingestProvisional(event.chat_id)
          logger.warn(
            `[line] provisional chat=${event.chat_id} message_id=${event.message_id} bucket=@line-group reason=not_in_getchats`,
          )
        }
      }

      const bucket = channelResolver.lookupChat(event.chat_id)?.workspace ?? '@line-group'
      const inboundTag = await formatChannelTag(bucket, event.chat_id)
      const { text, attachments } = splitInboundLine(event)
      logger.info(
        `[line] inbound message_id=${event.message_id} author=${event.author_id} ${inboundTag} content_type=${event.content_type} text_len=${text.length} attachments=${attachments.length}`,
      )

      const verdict = classifyInbound(event, options.configRef(), {
        selfUserId: inboundSelfId,
        lookupChat: (id) => channelResolver.lookupChat(id),
        text,
        attachments,
        ...(options.selfAliasesRef ? { selfAliases: options.selfAliasesRef() } : {}),
      })
      if (verdict.kind === 'drop') {
        logger.info(`[line] dropped message_id=${event.message_id} reason=${verdict.reason}`)
        return
      }

      logger.info(
        `[line] routed message_id=${event.message_id} ${inboundTag} mention=${verdict.payload.isBotMention} dm=${verdict.payload.isDm}`,
      )
      await options.router.route({
        ...verdict.payload,
        accountIdentity: fallbackChannelAccountIdentity('line', verdict.payload.workspace, inboundSelfId),
        eventKind: 'message',
        revision: 'original',
      })
    } catch (err) {
      logger.error(`[line] handleInbound failed: ${describeError(err)}`)
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
      client.onTokenUpdate?.((authToken) => {
        void persistAuthToken(authToken)
      })

      try {
        const credentialStore = options.credentialsStore ?? null
        if (credentialStore !== null) {
          const account = await credentialStore.getAccount()
          if (account === null) {
            throw new Error('no LINE account in secrets.json#channels.line (run typeclaw init to authenticate)')
          }
          currentAuthToken = account.auth_token
          lastPersistedToken = account.auth_token
          await client.login(account)
        } else {
          await client.login()
        }
      } catch (err) {
        started = false
        logger.error(`[line] login failed: ${describeError(err)}`)
        throw err
      }

      await refreshNow()
      scheduleRefresh()

      try {
        const profile = await client.getProfile()
        selfUserId = profile.mid
        logger.info(`[line] authenticated as ${profile.display_name || profile.mid} (${profile.mid})`)
      } catch (err) {
        started = false
        logger.error(`[line] getProfile failed: ${describeError(err)}`)
        throw err
      }

      try {
        await channelResolver.refresh()
      } catch (err) {
        logger.warn(`[line] initial chat list fetch failed: ${describeError(err)}`)
      }

      listener = options.listenerFactory ? options.listenerFactory(client) : new LineListener(client)
      listener.on('connected', (info) => {
        connected = true
        logger.info(`[line] connected (account_id=${info.account_id})`)
      })
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[line] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[line] listener error: ${describeError(err)}`)
      })
      listener.on('message', (event) => {
        void processInbound(event)
      })

      try {
        await listener.start()
      } catch (err) {
        try {
          listener.stop()
        } catch {
          // best-effort cleanup; the start failure is what we surface
        }
        listener = null
        started = false
        logger.error(`[line] listener start failed: ${describeError(err)}`)
        throw err
      }

      // Registration happens AFTER listener.start() resolves so a start
      // failure cannot leave the router pointing at callbacks for a
      // half-initialized adapter. stop() unregisters in inverse order.
      options.router.registerOutbound('line', outboundCallback)
      options.router.registerSelfIdentity('line', selfIdentityResolver)
      options.router.registerChannelNameResolver('line', channelResolver.resolve)
      options.router.registerHistory('line', historyCallback)
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
      options.router.unregisterOutbound('line', outboundCallback)
      options.router.unregisterSelfIdentity('line', selfIdentityResolver)
      options.router.unregisterChannelNameResolver('line', channelResolver.resolve)
      options.router.unregisterHistory('line', historyCallback)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
      try {
        client.close()
      } catch {
        // close() throwing on a half-initialized client is benign.
      }
      selfUserId = null
      connected = false
    },

    isConnected(): boolean {
      return connected && selfUserId !== null
    },
  }
}

function formatLabel(name: string | undefined, id: string): string {
  if (name === undefined || name === '' || name === id) return id
  return `${name}(${id})`
}
