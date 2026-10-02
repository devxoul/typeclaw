import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { TelegramBotClient, TelegramBotListener } from 'agent-messenger/telegrambot'
import type { TelegramBotUser, TelegramMessage } from 'agent-messenger/telegrambot'

import { readResponseBodyBounded } from '@/agent/network/response-body'
import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  readAttachmentErrorSnippet,
  readAttachmentResponse,
} from '@/channels/fetch-attachment'
import type { MembershipResolver, MembershipResolverFailure, MembershipResolverResult } from '@/channels/membership'
import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
import { fallbackChannelAccountIdentity } from '@/channels/types'
import type {
  ChannelNameResolver,
  ChannelSelfIdentityResolver,
  FetchAttachmentCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
  TypingCallback,
  TypingTarget,
} from '@/channels/types'

import { describeError } from '../describe-error'
import { withOutboundAccount } from './outbound-account'
import { classifyInbound, type InboundDropReason, TELEGRAM_WORKSPACE } from './telegram-bot-classify'
import { createTelegramEditMessageCallback } from './telegram-bot-edit'
import { toTelegramMarkdownV2 } from './telegram-bot-format'

export const TELEGRAM_API_BASE = 'https://api.telegram.org'

// Only subscribe to update kinds the adapter actually classifies. Edits
// (`edited_message`, `edited_channel_post`) are deliberately omitted so
// Telegram does not deliver them — discord-bot.ts and slack-bot.ts also
// skip edits today, and quietly receiving them via `allowedUpdates` would
// advance the SDK's offset past the edit without any classification or
// log line, making "agent missed an edit" invisible.
const TELEGRAM_ALLOWED_UPDATES = ['message', 'channel_post']

// Outbound is rendered through `toTelegramMarkdownV2` and sent with
// `parse_mode: 'MarkdownV2'`. The formatter takes the model's common
// Markdown (`**bold**`, `*italic*`, `` `code` ``, fenced blocks,
// `[label](url)`) and emits MarkdownV2 with every reserved char escaped
// in the right region (outside-entity vs `code`/`pre` vs link-url),
// guaranteeing Telegram's parser will never reject the output. See
// `telegram-bot-format.ts` for the exact rules. Plain text — no
// formatting markers — round-trips through the formatter unchanged
// modulo escaped specials, so this is a safe default with no opt-out.

export type TelegramBotAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: TelegramBotAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

// Test seams for `createTelegramBotAdapter`. Production callers omit these
// and the real SDK constructors are used; tests inject fakes to drive
// listener events deterministically (especially the silent-startup and
// inflight-during-stop paths that the real SDK doesn't expose hooks for).
export type TelegramBotClientFactory = () => TelegramBotClient
export type TelegramBotListenerFactory = (
  client: TelegramBotClient,
  options: ConstructorParameters<typeof TelegramBotListener>[1],
) => TelegramBotListener

export type TelegramBotAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  token: string
  logger?: TelegramBotAdapterLogger
  createClient?: TelegramBotClientFactory
  createListener?: TelegramBotListenerFactory
}

export type TelegramBotAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export function createTypingCallback(deps: {
  token: string
  logger: TelegramBotAdapterLogger
  formatChannelTag?: (chat: string) => Promise<string>
  fetchImpl?: typeof fetch
}): TypingCallback {
  const { token, logger, formatChannelTag } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'telegram-bot') return
    // Telegram's `sendChatAction` indicator auto-expires after ~5s. We
    // re-fire on each router tick (every 8s while debouncing/generating);
    // a missed beat just gaps the indicator. There is no explicit clear,
    // so the 'stop' phase is a no-op.
    if (target.phase === 'stop') return
    const tag = formatChannelTag ? await formatChannelTag(target.chat) : `chat=${target.chat}`
    const body: Record<string, unknown> = { chat_id: target.chat, action: 'typing' }
    const threadId = parseThreadId(target.thread)
    if (threadId !== undefined) body.message_thread_id = threadId
    try {
      const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        logger.warn(`[telegram-bot] typing ${tag} status=${response.status}`)
      }
    } catch (err) {
      logger.warn(`[telegram-bot] typing ${tag} failed: ${describeError(err)}`)
    }
  }
}

export function createChannelNameResolver(deps: {
  client: Pick<TelegramBotClient, 'getChat'>
  ttlMs?: number
  now?: () => number
}): ChannelNameResolver {
  const ttlMs = deps.ttlMs ?? 24 * 60 * 60 * 1000
  const now = deps.now ?? Date.now
  const cache = new Map<string, { value: string; expiresAt: number }>()

  return async (key): Promise<ResolvedChannelNames> => {
    if (key.adapter !== 'telegram-bot') return {}
    const cached = cache.get(key.chat)
    if (cached && cached.expiresAt > now()) {
      return { chatName: cached.value }
    }
    try {
      const chat = await deps.client.getChat(key.chat)
      const name = chatLabel(chat)
      if (name === null) return {}
      cache.set(key.chat, { value: name, expiresAt: now() + ttlMs })
      return { chatName: name }
    } catch {
      return {}
    }
  }
}

function chatLabel(chat: {
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}): string | null {
  if (chat.title !== undefined && chat.title !== '') return chat.title
  if (chat.username !== undefined && chat.username !== '') return `@${chat.username}`
  const first = chat.first_name ?? ''
  const last = chat.last_name ?? ''
  if (first === '' && last === '') return null
  return last === '' ? first : `${first} ${last}`
}

export function createTelegramMembershipResolver(deps: {
  client: Pick<TelegramBotClient, 'getChat' | 'getChatMemberCount'>
  logger: TelegramBotAdapterLogger
  now?: () => number
}): MembershipResolver {
  const now = deps.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'telegram-bot') return { kind: 'permanent' } satisfies MembershipResolverFailure
    try {
      const chat = await deps.client.getChat(key.chat)
      // 1:1 chats have no /members endpoint and are exactly the bot + the
      // user; report the canonical pair so the engagement layer can apply
      // the DM trigger without a network round-trip per inbound.
      if (chat.type === 'private') {
        return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }
      }
      const count = await deps.client.getChatMemberCount(key.chat)
      const total = Math.max(0, Math.floor(count))
      // Telegram's Bot API does not expose a per-member listing for groups
      // beyond `getChatAdministrators`, so we cannot split humans from
      // bots cheaply. We KNOW the bot itself is a member of any group it
      // received a message from, so report `bots: 1` and put the rest in
      // `humans` — that is the minimal honest split. Returning `bots: 0`
      // would falsely suggest the agent is alone with humans and break
      // engagement's bot-loop suppression heuristics. We always set
      // `truncated: true` for groups so engagement treats the count as
      // approximate rather than authoritative.
      const bots = 1
      const humans = Math.max(0, total - bots)
      return {
        humans,
        bots,
        fetchedAt: now(),
        truncated: true,
      }
    } catch (err) {
      deps.logger.warn(`[telegram-bot] membership chat=${key.chat} failed: ${describeError(err)}`)
      return { kind: 'transient' } satisfies MembershipResolverFailure
    }
  }
}

export function createOutboundCallback(deps: {
  client: Pick<TelegramBotClient, 'sendMessage' | 'sendDocument'>
  logger: TelegramBotAdapterLogger
  formatChannelTag: (chat: string) => Promise<string>
  resolvePath?: (path: string) => string
}): OutboundCallback {
  const { client, logger, formatChannelTag, resolvePath } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'telegram-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) {
      return { ok: false, error: 'message has neither text nor attachments' }
    }
    const tag = await formatChannelTag(msg.chat)
    logger.info(
      `[telegram-bot] outbound ${tag} text_len=${text.length} attachments=${attachments.length}${msg.thread !== null && msg.thread !== undefined ? ` thread=${msg.thread}` : ''}`,
    )

    // Telegram has no combined "text + attachment" send for arbitrary
    // documents — `sendDocument` accepts a `caption` but it shares
    // Telegram's 1024-char limit, so we send them as separate calls
    // (uploads first so the agent's text comment lands in the chat after
    // the file the user is meant to read). Failure on any upload aborts:
    // the file is the load-bearing piece, the text post is best-effort
    // after every upload succeeds.
    //
    // Forum-topic asymmetry: agent-messenger's `sendDocument` does not
    // accept `message_thread_id`, so when the session is in a forum
    // topic the file lands in the chat root while the text post below
    // does carry the topic id. Mirror discord-bot.ts:389-394's warning
    // so the gap shows up in operator triage.
    const threadId = parseThreadId(msg.thread)
    for (const attachment of attachments) {
      const path = resolvePath ? resolvePath(attachment.path) : attachment.path
      try {
        const sent = await withUploadFilename(path, attachment.filename, (uploadPath) =>
          client.sendDocument(msg.chat, uploadPath),
        )
        logger.info(`[telegram-bot] uploaded message_id=${sent.message_id} ${tag}`)
        if (threadId !== undefined) {
          logger.warn(
            `[telegram-bot] uploaded file landed in chat root, not topic ${threadId}: ` +
              'agent-messenger sendDocument does not accept message_thread_id',
          )
        }
      } catch (err) {
        const message = describeError(err)
        logger.error(`[telegram-bot] sendDocument failed for ${path}: ${message}`)
        return { ok: false, error: `sendDocument failed: ${message}` }
      }
    }

    if (text === '') {
      return { ok: true }
    }

    try {
      const rendered = toTelegramMarkdownV2(text)
      const sendOptions: {
        message_thread_id?: number
        reply_to_message_id?: number
        parse_mode: 'MarkdownV2'
        link_preview_options?: { is_disabled: boolean }
      } = { parse_mode: 'MarkdownV2' }
      if (threadId !== undefined) sendOptions.message_thread_id = threadId
      if (msg.link_previews === false) sendOptions.link_preview_options = { is_disabled: true }
      const replyToId = parseTelegramMessageId(msg.replyTo?.externalMessageId)
      if (replyToId !== undefined) sendOptions.reply_to_message_id = replyToId
      const sent = await client.sendMessage(msg.chat, rendered, sendOptions)
      logger.info(`[telegram-bot] sent message_id=${sent.message_id} ${tag}`)
      const id = String(sent.message_id)
      return { ok: true, messageId: id, messageIds: [id] }
    } catch (err) {
      const message = describeError(err)
      logger.error(`[telegram-bot] sendMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

// agent-messenger's `sendDocument` names the upload after the path's basename
// and takes no filename argument, so honoring the OutboundAttachment
// `filename` override means uploading from a copy that carries that name.
// The copy lives in a private temp dir removed right after the send.
async function withUploadFilename<T>(
  path: string,
  filename: string | undefined,
  upload: (uploadPath: string) => Promise<T>,
): Promise<T> {
  const name = filename !== undefined ? basename(filename) : ''
  if (name === '' || name === basename(path)) return upload(path)
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-telegram-upload-'))
  try {
    const staged = join(dir, name)
    await copyFile(path, staged)
    return await upload(staged)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function parseThreadId(thread: string | null | undefined): number | undefined {
  if (thread === null || thread === undefined || thread === '') return undefined
  const n = Number(thread)
  return Number.isFinite(n) ? n : undefined
}

function parseTelegramMessageId(id: string | null | undefined): number | undefined {
  if (id === null || id === undefined || id === '') return undefined
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

type TelegramFileResponse = {
  ok: boolean
  result?: { file_id: string; file_unique_id: string; file_size?: number; file_path?: string }
  description?: string
}

// Telegram's file download is a two-step protocol: `getFile` returns a
// short-lived `file_path`, then the file lives at
// `api.telegram.org/file/bot<TOKEN>/<file_path>`. `ref` here is the
// `file_id` carried in structured InboundAttachment.ref. The agent only sees
// `[Telegram attachment #N: ...]` and passes that id through the
// `channel_fetch_attachment` tool; the router resolves it to this callback.
//
// SSRF boundary: `ref` is `encodeURIComponent`'d into a query parameter
// of a fixed `api.telegram.org/bot<TOKEN>/getFile?file_id=...` URL, so
// no `ref` value can redirect the request off-platform. We reject empty
// strings to fail fast with a clear error and `://` to catch the
// obvious "agent passed a URL" mistake before round-tripping it to
// Telegram, which would return a useless 400. We do NOT block `/` —
// real Telegram file_ids never contain it, but if a future SDK encodes
// extra metadata that does, we want the call to reach Telegram and
// surface the real error rather than ours.
export function createFetchAttachmentCallback(deps: {
  token: string
  logger: TelegramBotAdapterLogger
  fetchImpl?: typeof fetch
}): FetchAttachmentCallback {
  const { token, logger } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  return async ({ ref, filename, maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES }) => {
    if (ref === '' || ref.includes('://')) {
      return { ok: false, error: `invalid Telegram file_id: ${ref}` }
    }
    let metaResponse: Response
    try {
      metaResponse = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(ref)}`)
    } catch (err) {
      const message = describeError(err)
      logger.error(`[telegram-bot] getFile failed for ${ref}: ${message}`)
      return { ok: false, error: `getFile failed: ${message}` }
    }
    if (!metaResponse.ok) {
      const body = await metaResponse.text().catch(() => '')
      const message = `getFile ${metaResponse.status} ${metaResponse.statusText}${body !== '' ? `: ${body.slice(0, 200)}` : ''}`
      logger.error(`[telegram-bot] getFile failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
    let meta: TelegramFileResponse
    try {
      const bytes = await readResponseBodyBounded(metaResponse, 64 * 1024)
      meta = JSON.parse(bytes.toString('utf8')) as TelegramFileResponse
    } catch (err) {
      return { ok: false, error: `getFile parse failed: ${describeError(err)}` }
    }
    if (!meta.ok || meta.result === undefined || meta.result.file_path === undefined) {
      const message = meta.description ?? 'getFile returned no file_path'
      return { ok: false, error: message }
    }
    const filePath = meta.result.file_path
    const downloadUrl = `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`
    let response: Response
    try {
      response = await fetchImpl(downloadUrl)
    } catch (err) {
      const message = describeError(err)
      logger.error(`[telegram-bot] download failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
    if (!response.ok) {
      const body = await readAttachmentErrorSnippet(response)
      const message = `download ${response.status} ${response.statusText}${body !== '' ? `: ${body.slice(0, 200)}` : ''}`
      logger.error(`[telegram-bot] download failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
    let buffer: Buffer
    try {
      buffer = await readAttachmentResponse(response, maxBytes)
    } catch (err) {
      const message = describeError(err)
      logger.error(`[telegram-bot] download failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
    const inferredFilename = filename ?? filePath.split('/').pop() ?? 'attachment'
    const contentType = response.headers.get('content-type') ?? undefined
    logger.info(
      `[telegram-bot] downloaded file_id=${ref} name=${inferredFilename} size=${buffer.length}${contentType !== undefined ? ` type=${contentType}` : ''}`,
    )
    return {
      ok: true,
      buffer,
      filename: inferredFilename,
      ...(contentType !== undefined ? { mimetype: contentType } : {}),
      size: buffer.length,
    }
  }
}

export function createTelegramBotAdapter(options: TelegramBotAdapterOptions): TelegramBotAdapter {
  const logger = options.logger ?? consoleLogger
  const createClient = options.createClient ?? (() => new TelegramBotClient())
  const createListener =
    options.createListener ?? ((client, listenerOptions) => new TelegramBotListener(client, listenerOptions))
  const client = createClient()
  let listener: TelegramBotListener | null = null
  let botUser: TelegramBotUser | null = null
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createChannelNameResolver({ client })

  // Telegram addresses by `@username`, not by the numeric id, so surface
  // `username` when the bot has one; the id is kept for completeness.
  const selfIdentityResolver: ChannelSelfIdentityResolver = () =>
    botUser !== null
      ? { id: String(botUser.id), ...(botUser.username !== undefined ? { username: botUser.username } : {}) }
      : null

  const formatChannelTag = async (chat: string): Promise<string> => {
    const names = await channelResolver({
      adapter: 'telegram-bot',
      workspace: TELEGRAM_WORKSPACE,
      chat,
      thread: null,
    }).catch((): ResolvedChannelNames => ({}))
    const label = names.chatName ?? null
    return label === null || label === chat ? `chat=${chat}` : `chat=${label}(${chat})`
  }

  const typingCallback = createTypingCallback({
    token: options.token,
    logger,
    formatChannelTag,
  })

  const membershipResolver = createTelegramMembershipResolver({ client, logger })

  const outboundCallback = withOutboundAccount(
    createOutboundCallback({
      client,
      logger,
      formatChannelTag,
    }),
    (workspace) =>
      fallbackChannelAccountIdentity('telegram-bot', workspace, botUser === null ? undefined : String(botUser.id)),
  )

  const fetchAttachmentCallback = createFetchAttachmentCallback({ token: options.token, logger })
  const editMessageCallback = createTelegramEditMessageCallback({ client })

  const handleMessage = async (event: TelegramMessage): Promise<void> => {
    inflightInbounds++
    // Snapshot bot identity at dispatch time. `botUser` is module-level
    // mutable state and `stop()` may null it concurrently with our awaits
    // below; without this snapshot, an inbound that was already dispatched
    // before `stop()` arrived could resume with `botUser=null` and drop
    // as `pre_connect`, losing a legitimate message.
    const botSnapshot = botUser
    try {
      const tag = await formatChannelTag(String(event.chat.id))
      const fromLabel = event.from?.username ?? event.from?.first_name ?? String(event.from?.id ?? '?')
      const text = event.text ?? event.caption ?? ''
      logger.info(
        `[telegram-bot] inbound message_id=${event.message_id} author=${fromLabel} ${tag} text_len=${text.length}`,
      )

      const verdict = classifyInbound(event, options.configRef(), botSnapshot)
      if (verdict.kind === 'drop') {
        logger.info(
          `[telegram-bot] dropped message_id=${event.message_id} reason=${verdict.reason}${dropHint(verdict.reason)}`,
        )
        return
      }

      logger.info(
        `[telegram-bot] routed message_id=${event.message_id} ${tag} mention=${verdict.payload.isBotMention} reply=${verdict.payload.replyToBotMessageId !== null}`,
      )
      await options.router.route({
        ...verdict.payload,
        accountIdentity: fallbackChannelAccountIdentity(
          'telegram-bot',
          verdict.payload.workspace,
          botSnapshot === null ? undefined : String(botSnapshot.id),
        ),
        eventKind: 'message',
        revision: 'original',
      })
    } catch (err) {
      logger.error(`[telegram-bot] handleInbound failed: ${describeError(err)}`)
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
        await client.login({ token: options.token })
      } catch (err) {
        started = false
        logger.error(`[telegram-bot] login failed: ${describeError(err)}`)
        throw err
      }

      // Preflight `getMe()` so an invalid token surfaces here as a thrown
      // error instead of silently emitting `'error'` from inside the
      // listener and leaving us in `started=true` with a dead poller. The
      // listener itself calls `getMe()` internally on `start()` but
      // catches the failure and returns normally — see
      // node_modules/agent-messenger/dist/src/platforms/telegrambot/listener.js
      // around the `try { this.cachedUser = await getMe() }` block.
      try {
        botUser = await client.getMe()
        const handle = botUser.username !== undefined ? `@${botUser.username}` : botUser.first_name
        logger.info(`[telegram-bot] authenticated as ${handle} (${botUser.id})`)
      } catch (err) {
        started = false
        botUser = null
        logger.error(`[telegram-bot] getMe failed (likely invalid token): ${describeError(err)}`)
        throw err
      }

      listener = createListener(client, {
        timeoutSeconds: 30,
        allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
        dropPendingUpdates: true,
      })
      // Track whether the listener emitted `connected` during start(). The
      // SDK's `start()` returns normally even when `deleteWebhook` or
      // (less importantly, since we already preflighted) `getMe` fails
      // internally — see
      // node_modules/agent-messenger/dist/src/platforms/telegrambot/listener.js
      // lines 36-60 (try/catch around each setup step that emits 'error'
      // and returns rather than throwing). Without this flag, a failed
      // startup leaves us with `started=true`, callbacks registered, and
      // a dead poller. We use the SDK's own `connected` event as the
      // single source of truth for "the listener is actually running".
      let listenerConnected = false
      let listenerStartupError: Error | null = null
      listener.on('connected', (info) => {
        listenerConnected = true
        botUser = info.user
      })
      listener.on('disconnected', () => {
        logger.warn('[telegram-bot] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(describeError(err))
        if (!listenerConnected && listenerStartupError === null) {
          listenerStartupError = error
        }
        logger.error(`[telegram-bot] listener error: ${describeError(err)}`)
      })
      listener.on('message', (event) => {
        void handleMessage(event)
      })
      listener.on('channel_post', (event) => {
        void handleMessage(event)
      })

      options.router.registerOutbound('telegram-bot', outboundCallback)
      options.router.registerTyping('telegram-bot', typingCallback)
      options.router.setTypingCapability('telegram-bot', true)
      options.router.registerChannelNameResolver('telegram-bot', channelResolver)
      options.router.registerSelfIdentity('telegram-bot', selfIdentityResolver)
      options.router.registerFetchAttachment('telegram-bot', fetchAttachmentCallback)
      options.router.registerMembership('telegram-bot', membershipResolver)
      options.router.registerEditMessage('telegram-bot', editMessageCallback)

      const rollbackStart = (reason: string, cause: Error): never => {
        options.router.unregisterOutbound('telegram-bot', outboundCallback)
        options.router.unregisterTyping('telegram-bot', typingCallback)
        options.router.setTypingCapability('telegram-bot', false)
        options.router.unregisterChannelNameResolver('telegram-bot', channelResolver)
        options.router.unregisterSelfIdentity('telegram-bot', selfIdentityResolver)
        options.router.unregisterFetchAttachment('telegram-bot', fetchAttachmentCallback)
        options.router.unregisterMembership('telegram-bot', membershipResolver)
        options.router.unregisterEditMessage('telegram-bot', editMessageCallback)
        listener?.stop()
        listener = null
        botUser = null
        started = false
        logger.error(`[telegram-bot] ${reason}: ${describeError(cause)}`)
        throw cause
      }

      try {
        await listener.start()
      } catch (err) {
        rollbackStart('listener start threw', err instanceof Error ? err : new Error(describeError(err)))
      }
      if (!listenerConnected) {
        const cause = listenerStartupError ?? new Error('listener.start() returned without emitting connected')
        rollbackStart('listener start failed silently', cause)
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('telegram-bot', outboundCallback)
      options.router.unregisterTyping('telegram-bot', typingCallback)
      options.router.setTypingCapability('telegram-bot', false)
      options.router.unregisterChannelNameResolver('telegram-bot', channelResolver)
      options.router.unregisterSelfIdentity('telegram-bot', selfIdentityResolver)
      options.router.unregisterFetchAttachment('telegram-bot', fetchAttachmentCallback)
      options.router.unregisterMembership('telegram-bot', membershipResolver)
      options.router.unregisterEditMessage('telegram-bot', editMessageCallback)
      // Stop the listener BEFORE waiting for inflight handlers. The SDK's
      // `stop()` aborts the in-flight `getUpdates` long-poll and
      // increments its generation counter so any pending dispatch is
      // dropped. Doing this before the wait bounds the drain: nothing
      // new can land in `handleMessage()`, so `inflightInbounds` only
      // decreases.
      listener?.stop()
      listener = null
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      // Null `botUser` only AFTER inflight handlers have drained.
      // `handleMessage` snapshots `botUser` at dispatch time so this is
      // belt-and-suspenders, but freeing the reference here keeps
      // `isConnected()` honest after stop completes.
      botUser = null
    },

    isConnected(): boolean {
      return botUser !== null
    },
  }
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'no_user':
      return ' (channel post / anonymous; cannot attribute to an author)'
    case 'empty_text':
      return ' (message had no text and no recognized media; check Telegram privacy mode in @BotFather)'
    case 'pre_connect':
    case 'self_author':
      return ''
  }
}
