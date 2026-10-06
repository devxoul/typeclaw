import { basename } from 'node:path'

import {
  KakaoCredentialManager,
  KakaoTalkClient as RealKakaoTalkClient,
  KakaoTalkListener as RealKakaoTalkListener,
  type AttachmentInput,
  type KakaoChat,
  type KakaoMarkReadResult,
  type KakaoMember,
  type KakaoMessage,
  type KakaoProfile,
  type KakaoReplyTarget,
  type KakaoSendResult,
  type KakaoTalkListenerEventMap,
  type KakaoTalkPushEmoticonEvent,
  type KakaoTalkPushMessageEvent,
  type KakaoTypingResult,
} from 'agent-messenger/kakaotalk'
import type { KakaoAccountCredentials, KakaoConfig, PendingLoginState } from 'agent-messenger/kakaotalk'

import { prependQuoteAnchor, type ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
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
  InboundAttachment,
} from '@/channels/types'

import { describeError } from '../describe-error'
import {
  emoticonEventToMessageEvent,
  splitEmoticonInbound,
  splitHistoryInbound,
  splitInbound,
} from './kakaotalk-attachment'
import { createKakaoAuthorResolver, type KakaoAuthorResolver } from './kakaotalk-author-resolver'
import { createKakaoChannelResolver, type KakaoChannelResolver } from './kakaotalk-channel-resolver'
import { classifyInbound, type InboundDropReason } from './kakaotalk-classify'
import { createFetchAttachmentCallback } from './kakaotalk-fetch-attachment'
import { toKakaoPlainText } from './kakaotalk-format'
import { createKakaoMembershipResolver } from './kakaotalk-membership'
import { createKakaoTypingCallback, kakaoTypingClassFromLookup, KAKAO_TYPING_HEARTBEAT_MS } from './kakaotalk-typing'

// Structural duck-type of the upstream KakaoTalkClient class. The upstream
// type is a class with private fields, and TypeScript treats those
// nominally — test fakes that match the public surface get rejected.
// Declaring this as an interface lets fakes satisfy it without inheriting
// private state. The cast on the const below bridges the runtime class
// onto this interface; the real upstream class satisfies every method.
export interface KakaoTalkClient {
  login(
    credentials?: { oauthToken: string; userId: string; deviceUuid?: string; deviceType?: 'pc' | 'tablet' },
    accountId?: string,
  ): Promise<this>
  getChats(options?: { all?: boolean; search?: string }): Promise<KakaoChat[]>
  getMessages(chatId: string, options?: { count?: number; from?: string }): Promise<KakaoMessage[]>
  sendMessage(chatId: string, text: string, options?: { replyTo?: KakaoReplyTarget }): Promise<KakaoSendResult>
  sendAttachment(
    chatId: string,
    data: Uint8Array | Buffer,
    filename: string,
    mimeType?: string,
  ): Promise<KakaoSendResult>
  sendAttachment(chatId: string, attachments: ReadonlyArray<AttachmentInput>): Promise<KakaoSendResult>
  markRead(chatId: string, logId: string, opts?: { linkId?: string }): Promise<KakaoMarkReadResult>
  sendTyping(chatId: string, opts?: { linkId?: string }): Promise<KakaoTypingResult>
  getProfile(): Promise<KakaoProfile>
  getMembers(chatId: string): Promise<KakaoMember[]>
  lookupAuthorName(chatId: string, authorId: number): string | null
  close(): void
}

export interface KakaoTalkListener {
  start(): Promise<void>
  stop(): void
  on<K extends keyof KakaoTalkListenerEventMap>(
    event: K,
    listener: (...args: KakaoTalkListenerEventMap[K]) => void,
  ): this
  off<K extends keyof KakaoTalkListenerEventMap>(
    event: K,
    listener: (...args: KakaoTalkListenerEventMap[K]) => void,
  ): this
}

export type KakaoCredentialStore = {
  load(): Promise<KakaoConfig>
  save(config: KakaoConfig): Promise<void>
  getAccount(id?: string): Promise<KakaoAccountCredentials | null>
  setAccount(account: KakaoAccountCredentials): Promise<void>
  removeAccount(id: string): Promise<void>
  listAccounts(): Promise<Array<KakaoAccountCredentials & { is_current: boolean }>>
  setCurrentAccount(id: string): Promise<void>
  savePendingLogin(state: PendingLoginState): Promise<void>
  loadPendingLogin(): Promise<PendingLoginState | null>
  clearPendingLogin(): Promise<void>
}

const KakaoTalkClient = RealKakaoTalkClient as unknown as new () => KakaoTalkClient
const KakaoTalkListener = RealKakaoTalkListener as unknown as new (client: KakaoTalkClient) => KakaoTalkListener

export type KakaotalkAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: KakaotalkAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type KakaotalkAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: KakaotalkAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: KakaoCredentialStore
  // Deprecated compatibility path for old tests/callers. Production uses
  // credentialsStore so secrets.json remains the credential source of truth.
  credentialsDir?: string
  client?: KakaoTalkClient
  listenerFactory?: (client: KakaoTalkClient) => KakaoTalkListener
  // Test seam for KICKOUT auto-recovery. Production uses Date.now and
  // setTimeout. Tests inject deterministic clocks/schedulers so they can
  // assert the recovery semantics without real-time waits.
  now?: () => number
  scheduleRecovery?: (fn: () => void, delayMs: number) => void
}

// LOCO emits KICKOUT when the same device_uuid logs in elsewhere. Three
// shapes converge on this one signal:
//   1. Init handoff — `typeclaw init` left a brief session that the
//      container's re-login kicks. One delayed reconnect resolves it.
//   2. Ghost session — a previous run's LOCO connection is still
//      half-alive server-side and ping-pongs with our reconnect for
//      ~1-2 minutes until it times out. Old one-shot recovery
//      reconnected once, got kicked again, and died — the bug this
//      state machine exists to fix.
//   3. Real conflict — another device or process holds the same
//      device_uuid. Our retries can't win this fight; we should give up
//      cleanly so the user notices and intervenes.
// One signal, three shapes: we always try to recover, but with a
// strictly bounded budget. Within an episode we allow KICKOUT_RECOVERY_
// _DELAYS_MS.length retries spaced by the listed delays; an episode is
// declared successful only after the reconnect stays connected for
// SUCCESS_MS (bare `connected` is too weak — ghost ping-pong reconnects
// for seconds before getting kicked again). Past the budget or the
// MAX_ELAPSED cap we let the session die. After a successful episode
// the state resets, so a fresh KICKOUT hours later gets a fresh
// episode rather than being permanently locked out.
const KICKOUT_RECOVERY_SUCCESS_MS = 60_000
const KICKOUT_RECOVERY_MAX_ELAPSED_MS = 5 * 60_000
const KICKOUT_RECOVERY_DELAYS_MS: readonly number[] = [2_000, 10_000, 60_000]

export type KakaotalkAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export const KAKAO_HISTORY_LIMIT_MAX = 200

// How far back to scan for a reply target's source message. Matches the upstream
// CLI's window; an anchored reply targets the message just answered, so the
// target is almost always near the head of this window.
const KAKAO_REPLY_LOOKUP_COUNT = 100

function formatLabel(name: string | undefined, id: string, prefix = ''): string {
  if (name === undefined || name === '' || name === id) return id
  return `${prefix}${name}(${id})`
}

async function readAttachmentBuffer(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  return await readFile(path)
}

export function createOutboundCallback(deps: {
  client: Pick<KakaoTalkClient, 'sendMessage' | 'sendAttachment' | 'getMessages'>
  logger: KakaotalkAdapterLogger
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
  readFile?: (path: string) => Promise<Buffer>
}): OutboundCallback {
  const { client, logger, formatChannelTag } = deps
  const readFile = deps.readFile ?? readAttachmentBuffer
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'kakaotalk') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const text = toKakaoPlainText(msg.text ?? '')
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) {
      return { ok: false, error: 'message has neither text nor attachments' }
    }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(`[kakaotalk] outbound ${tag} text_len=${text.length} attachments=${attachments.length}`)

    const logIds: string[] = []
    // KakaoTalk has no shared text-with-file send (Slack's initial_comment) — files first, then text.
    if (attachments.length > 0) {
      let items: AttachmentInput[]
      try {
        items = await Promise.all(
          attachments.map(async (a) => {
            // basename (not split('/')) so a native-Windows host's backslash
            // attachment paths still yield just the filename (issue #899).
            const filename = a.filename ?? (basename(a.path) || 'file')
            const data = await readFile(a.path)
            return { data, filename }
          }),
        )
      } catch (err) {
        const message = describeError(err)
        logger.error(`[kakaotalk] readFile failed: ${message}`)
        return { ok: false, error: `readFile failed: ${message}` }
      }
      try {
        const result = await client.sendAttachment(msg.chat, items)
        if (!result.success) {
          logger.error(`[kakaotalk] sendAttachment status_code=${result.status_code} ${tag}`)
          return { ok: false, error: `kakaotalk attachment send failed with status ${result.status_code}` }
        }
        logIds.push(result.log_id)
        logger.info(`[kakaotalk] uploaded log_id=${result.log_id} attachments=${items.length} ${tag}`)
      } catch (err) {
        const message = describeError(err)
        logger.error(`[kakaotalk] sendAttachment failed: ${message}`)
        return { ok: false, error: message }
      }
    }

    if (text !== '') {
      // KakaoTalk's native reply payload is built from the *source* message
      // (author, original text, type), which the SDK does not derive from a
      // bare log_id — we resolve it from recent history. If that lookup can't
      // find the target (scrolled past the window, or the fetch failed), we
      // degrade to the same blockquote anchor the router uses for quote-mode
      // adapters, so the reply still visibly references the right message.
      let outboundText = text
      let replyTarget: KakaoReplyTarget | undefined
      if (msg.replyTo !== undefined) {
        replyTarget = await resolveKakaoReplyTarget(client, msg.chat, msg.replyTo.externalMessageId, logger)
        if (replyTarget === undefined && msg.replyTo.source !== undefined) {
          outboundText = prependQuoteAnchor(text, msg.replyTo.source)
        }
      }
      try {
        const result = await client.sendMessage(
          msg.chat,
          outboundText,
          replyTarget !== undefined ? { replyTo: replyTarget } : undefined,
        )
        if (!result.success) {
          logger.error(`[kakaotalk] sendMessage status_code=${result.status_code} ${tag}`)
          return { ok: false, error: `kakaotalk send failed with status ${result.status_code}` }
        }
        logIds.push(result.log_id)
        logger.info(`[kakaotalk] sent log_id=${result.log_id} ${tag}`)
      } catch (err) {
        const message = describeError(err)
        logger.error(`[kakaotalk] sendMessage failed: ${message}`)
        return { ok: false, error: message }
      }
    }

    // The text send is the message an agent replies to, so when both an
    // attachment and text went out the text log_id (last in `logIds`) is the
    // anchor; attachment-only sends fall back to the attachment log_id.
    const anchor = logIds.length > 0 ? logIds[logIds.length - 1] : undefined
    return { ok: true, messageId: anchor, messageIds: logIds }
  }
}

// KakaoTalk replies need the full source message, not just its log_id. Resolve
// it from the chat's recent history (matching the upstream CLI's approach).
// Returns undefined when the target isn't in the fetched window or the fetch
// throws — the caller degrades to the blockquote fallback in that case.
async function resolveKakaoReplyTarget(
  client: Pick<KakaoTalkClient, 'getMessages'>,
  chatId: string,
  externalMessageId: string,
  logger: KakaotalkAdapterLogger,
): Promise<KakaoReplyTarget | undefined> {
  try {
    const messages = await client.getMessages(chatId, { count: KAKAO_REPLY_LOOKUP_COUNT })
    const target = messages.find((m) => m.log_id === externalMessageId)
    if (target === undefined) {
      logger.warn(`[kakaotalk] reply target log_id=${externalMessageId} not in last ${KAKAO_REPLY_LOOKUP_COUNT}`)
      return undefined
    }
    return { log_id: target.log_id, author_id: target.author_id, message: target.message, type: target.type }
  } catch (err) {
    logger.warn(`[kakaotalk] reply target lookup failed: ${describeError(err)}`)
    return undefined
  }
}

export function createKakaoHistoryCallback(deps: {
  client: Pick<KakaoTalkClient, 'getMessages'>
  logger: KakaotalkAdapterLogger
  authorResolver: Pick<KakaoAuthorResolver, 'resolve'>
  selfUserIdRef: () => string | null
}): HistoryCallback {
  const { client, logger, authorResolver, selfUserIdRef } = deps
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const limit = clampLimit(args.limit, KAKAO_HISTORY_LIMIT_MAX)
    try {
      const messages = await client.getMessages(args.chat, {
        count: limit,
        ...(args.cursor !== undefined && args.cursor !== '' ? { from: args.cursor } : {}),
      })
      const selfId = selfUserIdRef()
      const mapped: ChannelHistoryMessage[] = await Promise.all(
        messages.map(async (m) => {
          const authorId = String(m.author_id)
          const authorName = m.author_name ?? (await authorResolver.resolve(authorId, args.chat)) ?? authorId
          const { text, attachments } = splitHistoryInbound(m)
          return {
            externalMessageId: m.log_id,
            authorId,
            authorName,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ts: m.sent_at * 1000,
            isBot: selfId !== null && authorId === selfId,
            replyToBotMessageId: null,
          }
        }),
      )
      return { ok: true, messages: mapped }
    } catch (err) {
      const message = describeError(err)
      logger.warn(`[kakaotalk] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

export function createKakaotalkAdapter(options: KakaotalkAdapterOptions): KakaotalkAdapter {
  const logger = options.logger ?? consoleLogger
  const client = options.client ?? new KakaoTalkClient()
  const now = options.now ?? Date.now
  const scheduleRecovery =
    options.scheduleRecovery ??
    ((fn: () => void, delayMs: number): void => {
      setTimeout(fn, delayMs)
    })
  let listener: KakaoTalkListener | null = null
  let selfUserId: string | null = null
  const selfIdentityResolver: ChannelSelfIdentityResolver = () => (selfUserId === null ? null : { id: selfUserId })
  let connected = false
  let started = false
  let lastConnectedAt: number | null = null
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  type RecoveryEpisode = {
    startedAt: number
    attemptCount: number
    pendingStabilityCheck: boolean
  }
  let recoveryEpisode: RecoveryEpisode | null = null

  const resetRecoveryEpisode = (): void => {
    recoveryEpisode = null
  }

  const channelResolver = createKakaoChannelResolver({ client, logger, selfUserId: () => selfUserId })
  const authorResolver = createKakaoAuthorResolver({ client, logger })
  const membershipResolver = createKakaoMembershipResolver({
    client,
    selfUserIdRef: () => selfUserId,
    logger,
  })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver
      .resolve({ adapter: 'kakaotalk', workspace, chat, thread: null })
      .catch(() => ({}) as ResolvedChannelNames)
    return `bucket=${workspace} chat=${formatLabel(names.chatName, chat, '#')}`
  }

  const historyCallback = createKakaoHistoryCallback({
    client,
    logger,
    authorResolver,
    selfUserIdRef: () => selfUserId,
  })

  const outboundCallback = createOutboundCallback({
    client,
    logger,
    formatChannelTag,
  })

  const typing = createKakaoTypingCallback({
    logger,
    sendTyping: (chatId, opts) => client.sendTyping(chatId, opts),
    classifyChat: (chatId) => kakaoTypingClassFromLookup(channelResolver.lookupChat(chatId)),
    formatChannelTag,
  })

  const fetchAttachmentCallback = createFetchAttachmentCallback({ logger })

  const handleMessageEvent = async (event: KakaoTalkPushMessageEvent): Promise<void> => {
    const { text, attachments } = splitInbound(event)
    await processInbound({ ...event, message: text }, attachments)
  }

  const handleEmoticonEvent = async (event: KakaoTalkPushEmoticonEvent): Promise<void> => {
    // Stickers arrive on a separate listener event in agent-messenger
    // 2.15.0 and have no `message` field. We wrap them into the same
    // MSG-shaped payload classifyInbound expects so the engagement /
    // self-author / unknown-chat rules apply identically across plain
    // messages and stickers — there is no second classifier to keep in
    // sync.
    const { attachments } = splitEmoticonInbound(event)
    await processInbound(emoticonEventToMessageEvent(event), attachments)
  }

  const processInbound = async (
    event: KakaoTalkPushMessageEvent,
    attachments: readonly InboundAttachment[] = [],
  ): Promise<void> => {
    inflightInbounds++
    try {
      if (channelResolver.lookupChat(event.chat_id) === null) {
        await channelResolver.refresh()
        if (channelResolver.lookupChat(event.chat_id) === null) {
          // The push event itself proves the chat exists, even when
          // getChats({all:true}) does not surface it (e.g. memo chats,
          // certain open chats, recently-joined groups that haven't
          // propagated). Resolve the real kind from a per-chat member read
          // so the message is no longer silently dropped as unknown_chat,
          // falling back to the strictest @kakao-group bucket when that read
          // yields nothing. The next real refresh re-confirms the entry.
          const bucket = await channelResolver.ingestProvisional(event.chat_id)
          logger.warn(
            `[kakaotalk] provisional chat=${event.chat_id} log_id=${event.log_id} bucket=${bucket} reason=not_in_getchats`,
          )
        }
      }

      const inboundTag = await formatChannelTag(
        channelResolver.lookupChat(event.chat_id)?.workspace ?? '@kakao-group',
        event.chat_id,
      )
      logger.info(
        `[kakaotalk] inbound log_id=${event.log_id} author=${event.author_name ?? event.author_id} ${inboundTag} type=${event.message_type} text_len=${event.message.length}`,
      )

      // Ack the message BEFORE classify/route so the sender's unread "1"
      // (the yellow unread badge) clears even when we drop the message (self-author,
      // unknown chat, empty text, etc.). The receiver of a kakao adapter is
      // expected to behave like a "read it as soon as it arrives" client —
      // the agent has observed the bytes, so the user should see the read
      // acknowledgement regardless of what we decide to do with the message
      // downstream. Open-chat skip is enforced inside markReadIfSupported.
      markReadIfSupported({ client, event, channelResolver, logger })

      const verdict = classifyInbound(event, options.configRef(), {
        selfUserId,
        lookupChat: (id) => channelResolver.lookupChat(id),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(options.selfAliasesRef ? { selfAliases: options.selfAliasesRef() } : {}),
      })
      if (verdict.kind === 'drop') {
        logger.info(`[kakaotalk] dropped log_id=${event.log_id} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }

      const inlineName = event.author_name
      const resolvedName = inlineName ?? (await authorResolver.resolve(verdict.payload.authorId, verdict.payload.chat))
      const enriched = {
        ...verdict.payload,
        authorName: resolvedName ?? verdict.payload.authorId,
      }
      logger.info(
        `[kakaotalk] routed log_id=${event.log_id} ${inboundTag} mention=${enriched.isBotMention} reply=${enriched.replyToBotMessageId !== null} dm=${enriched.isDm}`,
      )
      await options.router.route(enriched)
    } catch (err) {
      logger.error(`[kakaotalk] handleInbound failed: ${describeError(err)}`)
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
      lastConnectedAt = null
      resetRecoveryEpisode()
      try {
        const credentialStore =
          options.credentialsStore ??
          (options.credentialsDir !== undefined ? new KakaoCredentialManager(options.credentialsDir) : null)
        if (credentialStore !== null) {
          const account = await credentialStore.getAccount()
          if (account === null) {
            throw new Error(
              options.credentialsDir !== undefined
                ? `no KakaoTalk account in ${options.credentialsDir}/kakaotalk-credentials.json (run typeclaw init to authenticate)`
                : 'no KakaoTalk account in secrets.json#channels.kakaotalk (run typeclaw init to authenticate)',
            )
          }
          await client.login({
            oauthToken: account.oauth_token,
            userId: account.user_id,
            deviceUuid: account.device_uuid,
            deviceType: account.device_type,
          })
        } else {
          // Fall back to the SDK's env-var-driven path. Honors
          // AGENT_MESSENGER_CONFIG_DIR set by the Dockerfile, otherwise
          // ~/.config/agent-messenger.
          await client.login()
        }
      } catch (err) {
        started = false
        logger.error(`[kakaotalk] login failed: ${describeError(err)}`)
        throw err
      }

      try {
        const profile = await client.getProfile()
        selfUserId = profile.user_id
        logger.info(`[kakaotalk] authenticated as ${profile.nickname || profile.user_id} (${profile.user_id})`)
      } catch (err) {
        started = false
        if (isKakaoUnauthorizedError(err)) {
          const message =
            'KakaoTalk sub-device session is stale (server returned 401 on getProfile). ' +
            'This usually means the ~7-day token TTL has expired and the hostd renewal cron has not refreshed it yet — ' +
            'either because the agent was just initialized without stored credentials, or because the encryption key ' +
            'is missing/wrong. Run `typeclaw channel reauth kakaotalk` to mint fresh tokens, then `typeclaw reload`.'
          logger.error(`[kakaotalk] ${message}`)
          throw new Error(message)
        }
        logger.error(`[kakaotalk] getProfile failed: ${describeError(err)}`)
        throw err
      }

      try {
        await channelResolver.refresh()
      } catch (err) {
        logger.warn(`[kakaotalk] initial chat list fetch failed: ${describeError(err)}`)
      }

      listener = options.listenerFactory ? options.listenerFactory(client) : new KakaoTalkListener(client)
      const activeListener = listener
      const scheduleStabilityCheck = (): void => {
        if (recoveryEpisode === null) return
        if (recoveryEpisode.pendingStabilityCheck) return
        recoveryEpisode.pendingStabilityCheck = true
        const expectedConnectedAt = lastConnectedAt
        scheduleRecovery(() => {
          if (recoveryEpisode === null) return
          recoveryEpisode.pendingStabilityCheck = false
          if (!started || listener !== activeListener) return
          if (!connected || lastConnectedAt !== expectedConnectedAt) return
          logger.info(
            `[kakaotalk] KICKOUT recovery episode succeeded after ${recoveryEpisode.attemptCount} attempt(s); session is stable.`,
          )
          resetRecoveryEpisode()
        }, KICKOUT_RECOVERY_SUCCESS_MS)
      }
      listener.on('connected', (info) => {
        connected = true
        lastConnectedAt = now()
        logger.info(`[kakaotalk] connected (user_id=${info.userId})`)
        if (recoveryEpisode !== null) scheduleStabilityCheck()
      })
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[kakaotalk] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[kakaotalk] listener error: ${describeError(err)}`)
        if (!isKickoutError(err)) return
        // KICKOUT closes the SDK session and skips scheduleReconnect, so
        // without intervention the adapter goes silent. We must either
        // start/continue a recovery episode or surface the dead state.
        connected = false
        if (!started) return
        const tNow = now()
        if (recoveryEpisode === null) {
          recoveryEpisode = { startedAt: tNow, attemptCount: 0, pendingStabilityCheck: false }
        }
        const episode = recoveryEpisode
        const elapsedInEpisode = tNow - episode.startedAt
        const nextAttemptIndex = episode.attemptCount
        const delayMs = KICKOUT_RECOVERY_DELAYS_MS[nextAttemptIndex]
        if (delayMs === undefined || elapsedInEpisode + delayMs > KICKOUT_RECOVERY_MAX_ELAPSED_MS) {
          const reason =
            delayMs === undefined
              ? `${KICKOUT_RECOVERY_DELAYS_MS.length} attempt(s) exhausted`
              : `${Math.round(KICKOUT_RECOVERY_MAX_ELAPSED_MS / 1000)}s recovery budget exhausted`
          logger.error(
            `[kakaotalk] session is DEAD after KICKOUT — ${reason}. ` +
              'Likely a real cross-device login is fighting our session. ' +
              'Stop the other client, then run `typeclaw restart`. ' +
              'If the conflict persists, run `typeclaw channel reauth kakaotalk` to mint a fresh sub-device session ' +
              '(the existing device_uuid is preserved by default so the new login skips phone-passcode confirmation).',
          )
          resetRecoveryEpisode()
          return
        }
        episode.attemptCount = nextAttemptIndex + 1
        logger.warn(
          `[kakaotalk] KICKOUT during recovery episode (attempt ${episode.attemptCount}/${KICKOUT_RECOVERY_DELAYS_MS.length}, episode_elapsed=${Math.round(elapsedInEpisode)}ms); reconnecting in ${delayMs}ms.`,
        )
        scheduleRecovery(() => {
          if (!started || listener !== activeListener) return
          if (recoveryEpisode !== episode) return
          activeListener.start().catch((retryErr) => {
            logger.error(
              `[kakaotalk] KICKOUT auto-recovery failed: ${describeError(retryErr)}. Run \`typeclaw restart\` to retry.`,
            )
          })
        }, delayMs)
      })
      listener.on('message', (event) => {
        void handleMessageEvent(event)
      })
      listener.on('emoticon', (event) => {
        void handleEmoticonEvent(event)
      })
      listener.on('member_joined', () => {
        void channelResolver.refresh()
      })
      listener.on('member_left', () => {
        void channelResolver.refresh()
      })

      try {
        await listener.start()
      } catch (err) {
        // Tear down defensively. Handlers (including the new 'emoticon'
        // one) were already wired before start(), and a partial start can
        // leave LOCO sockets half-open in the SDK. Without an explicit
        // stop here, a later adapter.stop() short-circuits on
        // !started and the listener leaks; with it, the SDK closes its
        // resources and our handler closures become unreachable.
        try {
          listener.stop()
        } catch {
          // ignore — best-effort cleanup, the start failure is what we surface
        }
        listener = null
        started = false
        logger.error(`[kakaotalk] listener start failed: ${describeError(err)}`)
        throw err
      }

      // Registration intentionally happens AFTER listener.start() resolves
      // so a start failure cannot leave the router pointing at callbacks
      // belonging to a half-initialized adapter (the listener is closed,
      // but outboundCallback would still send via a dead client). Stop()
      // unregisters in the inverse order.
      options.router.registerOutbound('kakaotalk', outboundCallback)
      options.router.registerSelfIdentity('kakaotalk', selfIdentityResolver)
      options.router.registerTyping('kakaotalk', typing.callback)
      options.router.setTypingCapability('kakaotalk', true)
      // KakaoTalk expires the indicator ~5s after the last packet, faster than
      // the default 8s heartbeat, so the router paces our refresh at 4s and the
      // callback holds no timer of its own.
      options.router.setTypingHeartbeatInterval('kakaotalk', KAKAO_TYPING_HEARTBEAT_MS)
      options.router.registerChannelNameResolver('kakaotalk', channelResolver.resolve)
      options.router.registerHistory('kakaotalk', historyCallback)
      options.router.registerFetchAttachment('kakaotalk', fetchAttachmentCallback)
      options.router.registerMembership('kakaotalk', membershipResolver)
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('kakaotalk', outboundCallback)
      options.router.unregisterSelfIdentity('kakaotalk', selfIdentityResolver)
      options.router.unregisterTyping('kakaotalk', typing.callback)
      options.router.setTypingCapability('kakaotalk', false)
      typing.reset()
      options.router.unregisterChannelNameResolver('kakaotalk', channelResolver.resolve)
      options.router.unregisterHistory('kakaotalk', historyCallback)
      options.router.unregisterFetchAttachment('kakaotalk', fetchAttachmentCallback)
      options.router.unregisterMembership('kakaotalk', membershipResolver)
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
        // close() throwing on a half-initialized client is benign; the
        // session is gone either way and there's nothing to recover.
      }
      selfUserId = null
      connected = false
      lastConnectedAt = null
      resetRecoveryEpisode()
    },

    isConnected(): boolean {
      return connected && selfUserId !== null
    },
  }
}

function markReadIfSupported(deps: {
  client: Pick<KakaoTalkClient, 'markRead'>
  event: KakaoTalkPushMessageEvent
  channelResolver: Pick<KakaoChannelResolver, 'lookupChat'>
  logger: KakaotalkAdapterLogger
}): void {
  const { client, event, channelResolver, logger } = deps
  const bucket = channelResolver.lookupChat(event.chat_id)?.workspace
  if (bucket === '@kakao-open') {
    // Open chats require the LOCO `li` (linkId) field on NOTIREAD; without
    // it the server returns a non-success status. The resolver does not
    // surface linkId today, so rather than send a doomed ack we skip and
    // log once. Wiring linkId through the resolver is a follow-up.
    logger.info(
      `[kakaotalk] mark-read skipped chat=${event.chat_id} log=${event.log_id} reason=open_chat_link_id_unsupported`,
    )
    return
  }
  client.markRead(event.chat_id, event.log_id).then(
    (result) => {
      if (!result.success) {
        logger.warn(
          `[kakaotalk] mark-read non-success status_code=${result.status_code} chat=${event.chat_id} log=${event.log_id}`,
        )
      }
    },
    (err) => {
      logger.warn(`[kakaotalk] mark-read failed: ${describeError(err)} chat=${event.chat_id} log=${event.log_id}`)
    },
  )
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'unknown_chat':
      return ' (chat not in cache after refresh and provisional registration; check earlier resolver-refresh-failed warnings)'
    case 'bot_message':
      return ' (LOCO message_type=71 is KakaoTalk notification/feed; official accounts like KakaoTalk Customer Center / Kakao Account / login alerts)'
    case 'empty_text':
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}

function isKickoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.message.includes('kicked') || err.message.includes('KICKOUT')
}

// String-match on agent-messenger's `Profile request failed: ${status}`
// error format (see kakaotalk/client.js:544). The SDK throws KakaoTalkError
// with code='profile_request_failed' for any non-2xx status, so we have to
// inspect the message to tell 401 (expired sub-device token, needs renewal)
// apart from 5xx (transient server issue). Until the SDK exposes a typed
// `unauthorized` code, this is the realistic detection path.
function isKakaoUnauthorizedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /Profile request failed: 401\b/.test(err.message)
}
