// WebexListener + WebexListenerEventMap/Options require agent-messenger/webex (PR #239);
// loginWithPassword path requires PR #238. Both land via the linked upstream.
import { WebexClient, WebexListener } from 'agent-messenger/webex'
import type {
  WebexListenerEventMap,
  WebexListenerOptions,
  WebexMembership,
  WebexMessage,
  WebexPerson,
} from 'agent-messenger/webex'

import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  readAttachmentErrorSnippet,
  readAttachmentResponse,
} from '@/channels/fetch-attachment'
import {
  MEMBERSHIP_ENUMERATION_CAP,
  type MembershipResolver,
  type MembershipResolverFailure,
  type MembershipResolverResult,
} from '@/channels/membership'
import { deriveMembershipFromHistory } from '@/channels/membership-from-history'
import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
import { fallbackChannelAccountIdentity } from '@/channels/types'
import type {
  ChannelHistoryMessage,
  ChannelSelfIdentityResolver,
  FetchAttachmentCallback,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
  TypingCallback,
  TypingTarget,
} from '@/channels/types'
import type { WebexAccountRecord } from '@/secrets/schema'

import { describeError } from '../describe-error'
import { withOutboundAccount } from './outbound-account'
import { createWebexChannelNameResolver } from './webex-channel-resolver'
import { classifyInbound, type InboundDropReason, type WebexInboundMessage } from './webex-classify'
import { createWebexEditMessageCallback } from './webex-edit'
import { resolveWebexBodyText, splitWebexFiles } from './webex-format'
import { createWebexPrefetchLimiter, isWebexRateLimitError, type WebexPrefetchLimiter } from './webex-prefetch-limiter'
import { enrichWebexMessageReference } from './webex-reference'

export type WebexAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: WebexAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type WebexListenerTokenClient = { getToken: () => string }
export type WebexClientFactory = () => WebexClient
export type WebexListenerFactory = (client: WebexListenerTokenClient, options: WebexListenerOptions) => WebexListener

export type WebexCredentialStore = {
  getAccount(id?: string): Promise<WebexAccountRecord | null>
}

export type WebexAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: WebexAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: WebexCredentialStore
  createClient?: WebexClientFactory
  createListener?: WebexListenerFactory
  listenerOptions?: Omit<WebexListenerOptions, 'ignoreSelfMessages'>
  fetchImpl?: typeof fetch
}

export type WebexAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export type WebexOutboundFile = { content: Blob; filename: string }
export type WebexFileReader = (path: string) => Promise<WebexOutboundFile>

// Webex resolves any `parentId` to the thread root, so threading a reply and
// replying to a specific message land in the same thread. `replyTo` (the native
// quote anchor the router sets in native mode) is the more precise target, so it
// wins over `msg.thread` when present — both `sendMessage` and `uploadFile`
// accept `parentId`, so attachment replies thread natively too (unlike
// Discord/Telegram, where uploads land bare).
//
// `uploadFile` carries `text` + `parentId` in one multipart POST, so a
// text+single-file message is one call (Slack's `initial_comment` shape). With
// multiple files the first upload carries the text and every upload carries the
// parentId; remaining uploads are bare so the text is not duplicated.
export function createOutboundCallback(deps: {
  client: Pick<WebexClient, 'sendMessage' | 'uploadFile'>
  logger: WebexAdapterLogger
  formatChannelTag: (chat: string) => Promise<string>
  readFile?: WebexFileReader
  resolvePath?: (path: string) => string
}): OutboundCallback {
  const { client, logger, formatChannelTag, resolvePath } = deps
  const readFile = deps.readFile ?? defaultReadFile
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'webex') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) return { ok: false, error: 'message has neither text nor attachments' }

    const tag = await formatChannelTag(msg.chat)
    const parentId = msg.replyTo?.externalMessageId ?? msg.thread ?? undefined
    logger.info(
      `[webex] outbound ${tag} text_len=${text.length} attachments=${attachments.length}${parentId !== undefined ? ` parent=${parentId}` : ''}`,
    )

    try {
      if (attachments.length > 0) {
        const uploadedRefs: string[] = []
        for (const [index, attachment] of attachments.entries()) {
          const path = resolvePath ? resolvePath(attachment.path) : attachment.path
          const file = await readFile(path)
          if (attachment.filename !== undefined) file.filename = attachment.filename
          const carriesText = index === 0 && text !== ''
          const sent = await client.uploadFile(msg.chat, file, {
            ...(carriesText ? { text } : {}),
            ...(parentId !== undefined ? { parentId } : {}),
          })
          uploadedRefs.push(sent.ref)
          logger.info(`[webex] uploaded id=${sent.ref} filename=${file.filename} ${tag}`)
        }
        // First upload carries the text and is the thread parent, so it is the reply anchor.
        return { ok: true, messageId: uploadedRefs[0], messageIds: uploadedRefs }
      }

      const sent = await client.sendMessage(msg.chat, text, parentId !== undefined ? { parentId } : undefined)
      logger.info(`[webex] sent id=${sent.ref} ${tag}`)
      return { ok: true, messageId: sent.ref, messageIds: [sent.ref] }
    } catch (err) {
      const message = describeError(err)
      logger.error(`[webex] outbound failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

async function defaultReadFile(path: string): Promise<WebexOutboundFile> {
  return { content: Bun.file(path), filename: path.split('/').pop() ?? 'attachment' }
}

// Webex's typing indicator does not auto-expire, so unlike Telegram both phases
// are load-bearing: 'tick' raises it (re-fired on each router heartbeat) and
// 'stop' explicitly clears it once the turn ends.
//
// The router fires ticks fire-and-forget (`void fireTyping(live, 'tick')`) and
// relies on adapters with explicit clears to order 'stop' after any in-flight
// 'tick' — see router.ts stopTypingHeartbeat ("The FIFO inside the slack adapter
// ensures this clear lands AFTER any in-flight 'tick'"). Without serialization a
// slow `setTyping(room, true)` could resolve AFTER the `setTyping(room, false)`
// clear and strand the persistent indicator on. So calls are chained through a
// per-room FIFO (mirroring createSlackTypingTracker) BEFORE awaiting any slow
// work, guaranteeing on-the-wire order matches enqueue order.
//
// A swallowed error never surfaces to the router — a dropped indicator is
// cosmetic and must not abort a send or teardown.
export function createTypingCallback(deps: {
  client: Pick<WebexClient, 'setTyping'>
  logger: WebexAdapterLogger
  formatChannelTag?: (chat: string) => Promise<string>
}): TypingCallback {
  const { client, logger, formatChannelTag } = deps
  const queues = new Map<string, Promise<void>>()
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'webex') return
    const typing = target.phase === 'tick'
    const prev = queues.get(target.chat) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => client.setTyping(target.chat, typing))
      .catch(async (err: unknown) => {
        const tag = formatChannelTag ? await formatChannelTag(target.chat) : `room=${target.chat}`
        logger.warn(`[webex] typing ${tag} phase=${target.phase} failed: ${describeError(err)}`)
      })
    queues.set(target.chat, next)
    void next.finally(() => {
      if (queues.get(target.chat) === next) queues.delete(target.chat)
    })
    await next
  }
}

export function createWebexHistoryCallback(deps: {
  client: Pick<WebexClient, 'listMessages'>
  logger: WebexAdapterLogger
  botPersonIdRef: () => string | null
  limiter?: WebexPrefetchLimiter
}): HistoryCallback {
  const limiter = deps.limiter ?? createWebexPrefetchLimiter()
  const listMessages = (args: FetchHistoryArgs) =>
    deps.client.listMessages(args.chat, { max: clampLimit(args.limit, 100) })
  const toHistory = (messages: WebexMessage[]): FetchHistoryResult => {
    const authorById = new Map(messages.map((m) => [m.ref, m.personRef]))
    const botPersonId = deps.botPersonIdRef()
    return { ok: true, messages: messages.map((m) => mapWebexHistoryMessage(m, botPersonId, authorById)).reverse() }
  }
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    try {
      // Only best-effort reads (cold-start prefetch, membership fallback) submit
      // to the per-room limiter. Explicit channel_history reads bypass it so a
      // user-initiated look-back is never declined by prefetch backpressure.
      if (args.prefetch !== true) {
        return toHistory(await listMessages(args))
      }
      const outcome = await limiter.run(args.chat, () => listMessages(args))
      if (!outcome.admitted) {
        deps.logger.info('[webex] history prefetch skipped: rate-limit backpressure')
        return { ok: false, error: 'prefetch skipped: rate-limit backpressure', skipReason: 'rate-limited' }
      }
      return toHistory(outcome.value)
    } catch (err) {
      const message = describeError(err)
      if (args.prefetch === true && isWebexRateLimitError(err)) {
        deps.logger.info(`[webex] history prefetch skipped: rate limited (${message})`)
        return { ok: false, error: message, skipReason: 'rate-limited' }
      }
      deps.logger.warn(`[webex] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createWebexMembershipResolver(deps: {
  client: Pick<WebexClient, 'listMemberships'>
  logger: WebexAdapterLogger
  historyCallback: HistoryCallback
  botPersonIdRef: () => string | null
  now?: () => number
}): MembershipResolver {
  const now = deps.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'webex') return { kind: 'permanent' } satisfies MembershipResolverFailure
    if (key.workspace === '@dm') return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }
    try {
      const memberships: WebexMembership[] = await deps.client.listMemberships(key.chat, {
        max: MEMBERSHIP_ENUMERATION_CAP,
      })
      // Below the cap the enumeration is complete and authoritative, so it must
      // NOT be marked truncated: `resolveEffectiveHumans` only trusts a fresh
      // untruncated read over persisted speakers, and the `Math.max()` truncated
      // path lets a stale/legacy email-keyed participant double-count the same
      // human and silence the solo-human fallback.
      const truncated = memberships.length >= MEMBERSHIP_ENUMERATION_CAP
      // WebexMembership has no bot/person type field, so only the self bot can be
      // classified; peer bots count as humans here (they still reach the agent
      // via mention/reply/sticky triggers regardless of this count).
      const botPersonId = deps.botPersonIdRef()
      const humanMemberIds: string[] = []
      let bots = 0
      for (const member of memberships) {
        if (botPersonId !== null && member.personRef === botPersonId) bots++
        else humanMemberIds.push(member.personRef)
      }
      if (truncated) {
        return { humans: humanMemberIds.length, bots, fetchedAt: now(), truncated }
      }
      return { humans: humanMemberIds.length, bots, fetchedAt: now(), truncated, humanMemberIds }
    } catch (err) {
      deps.logger.warn(
        `[webex] membership room=${key.chat} failed: ${describeError(err)}; deriving from recent history`,
      )
      return await deriveMembershipFromHistory({
        fetchHistory: (limit) => deps.historyCallback({ chat: key.chat, thread: key.thread, limit, prefetch: true }),
        now,
      })
    }
  }
}

const WEBEX_ATTACHMENT_HOSTS = new Set(['webexapis.com', 'api.ciscospark.com'])

export function createFetchAttachmentCallback(deps: {
  tokenRef: () => string | null
  logger: WebexAdapterLogger
  fetchImpl?: typeof fetch
}): FetchAttachmentCallback {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async ({ ref, filename, maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES }) => {
    const token = deps.tokenRef()
    if (token === null) return { ok: false, error: 'webex account token is not available' }
    let url: URL
    try {
      url = new URL(ref)
    } catch {
      return { ok: false, error: `invalid Webex file URL: ${ref}` }
    }
    // The bearer token must never leave over plaintext: an allowlisted host
    // on http:// would still leak the credential, so gate on https before the
    // host check.
    if (url.protocol !== 'https:') {
      return { ok: false, error: `Webex file URL must use https: ${url.protocol}//${url.hostname}` }
    }
    if (!isAllowedWebexFileHost(url.hostname)) {
      return { ok: false, error: `not a Webex file URL: ${url.hostname}` }
    }
    try {
      const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        const body = await readAttachmentErrorSnippet(res)
        const message = `webex file fetch ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`
        deps.logger.error(`[webex] fetchAttachment failed for ${url.toString()}: ${message}`)
        return { ok: false, error: message }
      }
      const buffer = await readAttachmentResponse(res, maxBytes)
      const inferredFilename = filename ?? url.pathname.split('/').pop() ?? 'attachment'
      const contentType = res.headers.get('content-type') ?? undefined
      return {
        ok: true,
        buffer,
        filename: inferredFilename,
        ...(contentType !== undefined ? { mimetype: contentType } : {}),
        size: buffer.length,
      }
    } catch (err) {
      const message = describeError(err)
      deps.logger.error(`[webex] fetchAttachment failed for ${url.toString()}: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createWebexAdapter(options: WebexAdapterOptions): WebexAdapter {
  const logger = options.logger ?? consoleLogger
  const createClient = options.createClient ?? (() => new WebexClient())
  const createListener =
    options.createListener ?? ((client, listenerOptions) => new WebexListener(client, listenerOptions))
  const client = createClient()
  const fetchImpl = options.fetchImpl ?? fetch
  let listener: WebexListener | null = null
  let botPerson: WebexPerson | null = null
  let currentToken: string | null = null
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createWebexChannelNameResolver({ client })
  const selfIdentityResolver: ChannelSelfIdentityResolver = () =>
    botPerson !== null ? { id: botPerson.ref, username: botPerson.emails[0] ?? botPerson.displayName } : null

  const formatChannelTag = async (chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'webex', workspace: chat, chat, thread: null }).catch(
      (): ResolvedChannelNames => ({}),
    )
    const label = names.chatName ?? null
    return label === null || label === chat ? `room=${chat}` : `room=${label}(${chat})`
  }

  const historyCallback = createWebexHistoryCallback({ client, logger, botPersonIdRef: () => botPerson?.ref ?? null })
  const membershipResolver = createWebexMembershipResolver({
    client,
    logger,
    historyCallback,
    botPersonIdRef: () => botPerson?.ref ?? null,
  })
  const outboundCallback = withOutboundAccount(
    createOutboundCallback({ client, logger, formatChannelTag }),
    (workspace) => fallbackChannelAccountIdentity('webex', workspace, botPerson?.ref),
  )
  const typingCallback = createTypingCallback({ client, logger, formatChannelTag })
  const fetchAttachmentCallback = createFetchAttachmentCallback({ tokenRef: () => currentToken, logger, fetchImpl })
  const editMessageCallback = createWebexEditMessageCallback({ adapter: 'webex', client })

  const handleMessage = async (event: WebexInboundMessage): Promise<void> => {
    inflightInbounds++
    const botSnapshot = botPerson
    try {
      const tag = await formatChannelTag(event.roomRef)
      logger.info(`[webex] inbound id=${event.ref} author=${event.personEmail} ${tag} text_len=${event.text.length}`)
      const verdict = classifyInbound(
        event,
        options.configRef(),
        botSnapshot?.ref ?? null,
        options.selfAliasesRef?.() ?? [],
        botSnapshot?.emails[0] ?? null,
      )
      if (verdict.kind === 'drop') {
        logger.info(`[webex] dropped id=${event.ref} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }
      const payload = await enrichWebexMessageReference({
        client,
        inbound: verdict.payload,
        parentRef: event.parentRef,
        botPersonId: botSnapshot?.ref ?? null,
      })
      logger.info(
        `[webex] routed id=${event.ref} ${tag} mention=${payload.isBotMention} reply=${payload.replyToBotMessageId !== null}`,
      )
      await options.router.route({
        ...payload,
        accountIdentity: fallbackChannelAccountIdentity('webex', payload.workspace, botSnapshot?.ref),
        eventKind: 'message',
        revision: 'original',
      })
    } catch (err) {
      logger.error(`[webex] handleInbound failed: ${describeError(err)}`)
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
      try {
        const account = await (options.credentialsStore ?? null)?.getAccount()
        if (account === null || account === undefined) {
          throw new Error('no Webex account in secrets.json#channels.webex (run typeclaw init to authenticate)')
        }
        currentToken = account.access_token
        await client.login({ token: account.access_token, deviceUrl: account.device_url, tokenType: 'password' })
        botPerson = await client.testAuth()
        logger.info(`[webex] authenticated as ${botPerson.displayName} (${botPerson.ref})`)
      } catch (err) {
        started = false
        currentToken = null
        botPerson = null
        logger.error(`[webex] login failed: ${describeError(err)}`)
        throw err
      }

      listener = createListener(
        { getToken: () => currentToken ?? '' },
        { ...options.listenerOptions, ignoreSelfMessages: true },
      )
      let listenerConnected = false
      let listenerStartupError: Error | null = null
      listener.on('connected', () => {
        listenerConnected = true
        connected = true
      })
      listener.on('disconnected', (reason: string) => {
        connected = false
        logger.warn(`[webex] disconnected: ${reason}`)
      })
      listener.on('error', (err: unknown) => {
        const error = err instanceof Error ? err : new Error(describeError(err))
        if (!listenerConnected && listenerStartupError === null) listenerStartupError = error
        logger.error(`[webex] listener error: ${describeError(err)}`)
      })
      listener.on('message_created', (event: WebexListenerEventMap['message_created'][0]) => {
        void handleMessage(event)
      })

      options.router.registerOutbound('webex', outboundCallback)
      options.router.registerTyping('webex', typingCallback)
      options.router.setTypingCapability('webex', true)
      options.router.registerChannelNameResolver('webex', channelResolver)
      options.router.registerSelfIdentity('webex', selfIdentityResolver)
      options.router.registerHistory('webex', historyCallback)
      options.router.registerFetchAttachment('webex', fetchAttachmentCallback)
      options.router.registerMembership('webex', membershipResolver)
      options.router.registerEditMessage('webex', editMessageCallback)

      const rollbackStart = (reason: string, cause: Error): never => {
        options.router.unregisterOutbound('webex', outboundCallback)
        options.router.unregisterTyping('webex', typingCallback)
        options.router.setTypingCapability('webex', false)
        options.router.unregisterChannelNameResolver('webex', channelResolver)
        options.router.unregisterSelfIdentity('webex', selfIdentityResolver)
        options.router.unregisterHistory('webex', historyCallback)
        options.router.unregisterFetchAttachment('webex', fetchAttachmentCallback)
        options.router.unregisterMembership('webex', membershipResolver)
        options.router.unregisterEditMessage('webex', editMessageCallback)
        listener?.stop()
        listener = null
        botPerson = null
        currentToken = null
        connected = false
        started = false
        logger.error(`[webex] ${reason}: ${describeError(cause)}`)
        throw cause
      }

      try {
        await listener.start()
      } catch (err) {
        rollbackStart('listener start threw', err instanceof Error ? err : new Error(describeError(err)))
      }
      if (!listenerConnected) {
        rollbackStart(
          'listener start failed silently',
          listenerStartupError ?? new Error('listener.start() returned without emitting connected'),
        )
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('webex', outboundCallback)
      options.router.unregisterTyping('webex', typingCallback)
      options.router.setTypingCapability('webex', false)
      options.router.unregisterChannelNameResolver('webex', channelResolver)
      options.router.unregisterSelfIdentity('webex', selfIdentityResolver)
      options.router.unregisterHistory('webex', historyCallback)
      options.router.unregisterFetchAttachment('webex', fetchAttachmentCallback)
      options.router.unregisterMembership('webex', membershipResolver)
      options.router.unregisterEditMessage('webex', editMessageCallback)
      listener?.stop()
      listener = null
      connected = false
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      botPerson = null
      currentToken = null
    },

    isConnected(): boolean {
      return started && botPerson !== null && connected
    },
  }
}

function mapWebexHistoryMessage(
  msg: WebexMessage,
  botPersonId: string | null,
  authorById: ReadonlyMap<string, string>,
): ChannelHistoryMessage {
  const { text, attachments } = splitWebexFiles(resolveWebexBodyText(msg), msg.files)
  const ts = Date.parse(msg.created)
  return {
    externalMessageId: msg.ref,
    authorId: msg.personRef,
    authorName: msg.personEmail,
    text,
    ts: Number.isFinite(ts) ? ts : 0,
    isBot: botPersonId !== null && msg.personRef === botPersonId,
    // Webex history carries parentId but not the parent's author, so a bare
    // parentId cannot prove the reply targeted the agent. Only attribute it to
    // the bot when the parent (resolved from the same history batch) was
    // bot-authored — mirrors the live enrichWebexMessageReference rule and
    // avoids marking human-authored threaded parents as replies to the agent.
    replyToBotMessageId:
      botPersonId !== null && msg.parentRef !== undefined && authorById.get(msg.parentRef) === botPersonId
        ? msg.parentRef
        : null,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

function isAllowedWebexFileHost(hostname: string): boolean {
  return WEBEX_ATTACHMENT_HOSTS.has(hostname) || hostname.endsWith('.webexcontent.com')
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_content':
      return ' (message had no text and no files)'
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}
