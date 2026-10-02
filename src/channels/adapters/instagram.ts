import * as instagramModule from 'agent-messenger/instagram'
import {
  InstagramClient as RealInstagramClient,
  InstagramCredentialManager,
  InstagramListener as RealInstagramListener,
} from 'agent-messenger/instagram'
import type { InstagramChatSummary, InstagramMessageSummary } from 'agent-messenger/instagram'

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
import { createInstagramChannelResolver } from './instagram-channel-resolver'
import { classifyInbound } from './instagram-classify'
import { loadInstagramContinuityStore, type InstagramContinuityStore } from './instagram-continuity-store'
import { toInstagramPlainText } from './instagram-format'
import { withOutboundAccount } from './outbound-account'

export interface InstagramClientShape {
  login(credentials?: { username: string; password: string }, accountId?: string): Promise<this>
  getProfile(): Promise<{ user_id: string; username: string; full_name: string | null; profile_pic_url: string | null }>
  listChats(limit?: number): Promise<InstagramChatSummary[]>
  getMessages(threadId: string, limit?: number): Promise<InstagramMessageSummary[]>
  sendMessage(threadId: string, text: string): Promise<InstagramMessageSummary>
  getUserId(): string | null
  fetchIrisBootstrap?: () => Promise<unknown>
  getSessionState?: () => unknown
}

export type ConnectedPayload = { userId: string; transport?: 'realtime' | 'polling' }

export interface InstagramListenerShape {
  start(): Promise<void> | void
  stop(): void
  on(event: 'connected', handler: (payload: ConnectedPayload) => void): this
  on(event: 'message', handler: (message: InstagramMessageSummary) => void): this
  on(event: 'error', handler: (error: Error) => void): this
  on(event: 'disconnected', handler: () => void): this
  off(event: 'connected', handler: (payload: ConnectedPayload) => void): this
  off(event: 'message', handler: (message: InstagramMessageSummary) => void): this
  off(event: 'error', handler: (error: Error) => void): this
  off(event: 'disconnected', handler: () => void): this
}

const InstagramClient = RealInstagramClient as unknown as new (
  credManager?: InstagramCredentialManager,
) => InstagramClientShape

export type InstagramListenerCtor = new (
  client: InstagramClientShape,
  options?: {
    pollInterval?: number
    realtimeRetryBaseMs?: number
    realtimeRetryMaxMs?: number
    disableRealtime?: boolean
    connackTimeoutMs?: number
  },
) => InstagramListenerShape

export function resolveInstagramListenerCtor(): { ctor: InstagramListenerCtor; transport: 'hybrid' | 'polling' } {
  const maybeHybrid = (instagramModule as Record<string, unknown>).InstagramHybridListener
  if (typeof maybeHybrid === 'function')
    return { ctor: maybeHybrid as unknown as InstagramListenerCtor, transport: 'hybrid' }
  return { ctor: RealInstagramListener as unknown as InstagramListenerCtor, transport: 'polling' }
}

export type InstagramCredentialStore = {
  getAccount(id?: string): Promise<{ account_id: string } | null>
}

export type InstagramAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: InstagramAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type InstagramAdapterOptions = {
  agentDir?: string
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: InstagramAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: InstagramCredentialStore
  client?: InstagramClientShape
  clientFactory?: (credManager?: InstagramCredentialManager) => InstagramClientShape
  listenerCtorResolver?: () => { ctor: InstagramListenerCtor; transport: 'hybrid' | 'polling' }
  continuityStore?: InstagramContinuityStore
  now?: () => number
}

export type InstagramAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export const INSTAGRAM_HISTORY_LIMIT_MAX = 200
const INSTAGRAM_RECOVERY_CHAT_LIMIT = 100

export function createOutboundCallback(deps: {
  client: Pick<InstagramClientShape, 'sendMessage'>
  logger: InstagramAdapterLogger
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
}): OutboundCallback {
  const { client, logger, formatChannelTag } = deps
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'instagram') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    if (msg.attachments !== undefined && msg.attachments.length > 0) {
      return { ok: false, error: 'instagram adapter does not support outbound attachments' }
    }
    const text = toInstagramPlainText(msg.text ?? '')
    if (text === '') return { ok: false, error: 'message has no text' }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(`[instagram] outbound ${tag} text_len=${text.length}`)
    try {
      const result = await client.sendMessage(msg.chat, text)
      logger.info(`[instagram] sent message_id=${result.id} ${tag}`)
      return { ok: true, messageId: result.id, messageIds: [result.id] }
    } catch (err) {
      const message = describeError(err)
      logger.error(`[instagram] sendMessage failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createInstagramHistoryCallback(deps: {
  client: Pick<InstagramClientShape, 'getMessages'>
  logger: InstagramAdapterLogger
  selfUserIdRef: () => string | null
}): HistoryCallback {
  const { client, logger, selfUserIdRef } = deps
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const limit = clampLimit(args.limit, INSTAGRAM_HISTORY_LIMIT_MAX)
    try {
      const messages = await client.getMessages(args.chat, limit)
      const selfId = selfUserIdRef()
      const mapped: ChannelHistoryMessage[] = messages.map((m) => {
        const parsed = Date.parse(m.timestamp)
        return {
          externalMessageId: m.id,
          authorId: m.from,
          authorName: m.from_name ?? m.from,
          text: m.text ?? '',
          ts: Number.isNaN(parsed) ? 0 : parsed,
          isBot: selfId !== null && (m.from === selfId || m.is_outgoing),
          replyToBotMessageId: null,
        }
      })
      return { ok: true, messages: mapped }
    } catch (err) {
      const message = describeError(err)
      logger.warn(`[instagram] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createInstagramAdapter(options: InstagramAdapterOptions): InstagramAdapter {
  const logger = options.logger ?? consoleLogger
  const buildClient = options.clientFactory ?? ((cm?: InstagramCredentialManager) => new InstagramClient(cm))
  const client = options.client ?? buildClient(new InstagramCredentialManager())
  let listener: InstagramListenerShape | null = null
  let selfUserId: string | null = null
  const selfIdentityResolver: ChannelSelfIdentityResolver = () => (selfUserId === null ? null : { id: selfUserId })
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []
  let continuityStore: InstagramContinuityStore | null = options.continuityStore ?? null
  let activeTransport: 'realtime' | 'polling' = 'polling'
  let inboundQueue = Promise.resolve()
  let adapterStartedAt = 0
  const bootstrapBaselines = new Map<string, readonly string[]>()
  const recoveryLimitWarnedThreads = new Set<string>()
  let recoveryChatLimitWarned = false

  const channelResolver = createInstagramChannelResolver({ client, logger })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver
      .resolve({ adapter: 'instagram', workspace, chat, thread: null })
      .catch(() => ({}) as ResolvedChannelNames)
    return `bucket=${workspace} chat=${formatLabel(names.chatName, chat)}`
  }

  const historyCallback = createInstagramHistoryCallback({ client, logger, selfUserIdRef: () => selfUserId })
  const outboundCallback = withOutboundAccount(
    createOutboundCallback({ client, logger, formatChannelTag }),
    (workspace) => fallbackChannelAccountIdentity('instagram', workspace, selfUserId),
  )

  const processInbound = async (message: InstagramMessageSummary, inboundSelfId: string | null): Promise<boolean> => {
    inflightInbounds++
    try {
      if (channelResolver.lookupChat(message.thread_id) === null) {
        await channelResolver.refresh()
        if (channelResolver.lookupChat(message.thread_id) === null) {
          channelResolver.ingestProvisional(message.thread_id)
          logger.warn(
            `[instagram] provisional chat=${message.thread_id} message_id=${message.id} bucket=@instagram-group reason=not_in_listChats`,
          )
        }
      }

      const bucket = channelResolver.lookupChat(message.thread_id)?.workspace ?? '@instagram-group'
      const inboundTag = await formatChannelTag(bucket, message.thread_id)
      logger.info(
        `[instagram] inbound message_id=${message.id} author=${message.from} ${inboundTag} type=${message.type} text_len=${(message.text ?? '').length}`,
      )

      const verdict = classifyInbound(message, options.configRef(), {
        selfUserId: inboundSelfId,
        lookupChat: (id) => channelResolver.lookupChat(id),
        ...(options.selfAliasesRef ? { selfAliases: options.selfAliasesRef() } : {}),
      })
      if (verdict.kind === 'drop') {
        logger.info(`[instagram] dropped message_id=${message.id} reason=${verdict.reason}`)
        return true
      }

      logger.info(
        `[instagram] routed message_id=${message.id} ${inboundTag} mention=${verdict.payload.isBotMention} dm=${verdict.payload.isDm}`,
      )
      const receipt = await options.router.route({
        ...verdict.payload,
        accountIdentity: fallbackChannelAccountIdentity('instagram', verdict.payload.workspace, inboundSelfId),
        eventKind: 'message',
        revision: 'original',
      })
      return (
        receipt.kind === 'accepted' ||
        receipt.kind === 'duplicate' ||
        receipt.kind === 'observed' ||
        receipt.kind === 'denied' ||
        receipt.kind === 'control'
      )
    } catch (err) {
      logger.error(`[instagram] handleInbound failed: ${describeError(err)}`)
      return false
    } finally {
      inflightInbounds--
      if (inflightInbounds === 0 && stopWaiters.length > 0) {
        const waiters = stopWaiters
        stopWaiters = []
        for (const w of waiters) w()
      }
    }
  }

  const deliverUnseen = async (message: InstagramMessageSummary): Promise<boolean> => {
    const accountId = selfUserId
    if (
      continuityStore !== null &&
      accountId !== null &&
      continuityStore.hasMessage(accountId, message.thread_id, message.id)
    ) {
      return true
    }
    if (!(await processInbound(message, accountId))) return false
    // Checkpoint only after the router accepts the message. A crash can replay
    // once, but persisting first would silently lose a message when routing fails.
    if (continuityStore !== null && accountId !== null) {
      await continuityStore.markMessage(accountId, message.thread_id, message.id)
    }
    return true
  }

  const fetchRecoveryMessages = async (threadId: string): Promise<InstagramMessageSummary[]> => {
    const messages = await client.getMessages(threadId, INSTAGRAM_HISTORY_LIMIT_MAX)
    if (messages.length === INSTAGRAM_HISTORY_LIMIT_MAX && !recoveryLimitWarnedThreads.has(threadId)) {
      recoveryLimitWarnedThreads.add(threadId)
      logger.warn(
        `[instagram] recovery history reached limit=${INSTAGRAM_HISTORY_LIMIT_MAX} chat=${threadId}; older unseen messages cannot be recovered without upstream pagination`,
      )
    }
    return messages.toSorted((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
  }

  const establishUnknownThread = async (
    threadId: string,
    messages: readonly InstagramMessageSummary[],
  ): Promise<void> => {
    if (continuityStore === null || selfUserId === null) return
    const bootstrapIds = bootstrapBaselines.get(threadId)
    const baselineIds = bootstrapIds ?? messages.filter(isBeforeAdapterStart).map((message) => message.id)
    await continuityStore.seedThread(selfUserId, threadId, baselineIds)
    bootstrapBaselines.delete(threadId)
  }

  const reconcileThread = async (threadId: string): Promise<boolean> => {
    if (continuityStore === null || selfUserId === null) return true
    const messages = await fetchRecoveryMessages(threadId)
    if (!continuityStore.knowsThread(selfUserId, threadId)) await establishUnknownThread(threadId, messages)
    for (const message of messages) {
      if (!(await deliverUnseen(message))) return false
    }
    return true
  }

  const reconcileAll = async (): Promise<void> => {
    const chats = await client.listChats(INSTAGRAM_RECOVERY_CHAT_LIMIT)
    warnIfChatLimitReached(chats.length)
    for (const chat of chats) {
      try {
        await reconcileThread(chat.id)
      } catch (err) {
        logger.error(`[instagram] recovery failed chat=${chat.id}: ${describeError(err)}`)
      }
    }
  }

  const seedBootstrap = async (): Promise<void> => {
    const chats = await client.listChats(INSTAGRAM_RECOVERY_CHAT_LIMIT)
    warnIfChatLimitReached(chats.length)
    for (const chat of chats) {
      try {
        if (continuityStore === null || selfUserId === null || continuityStore.knowsThread(selfUserId, chat.id)) {
          await reconcileThread(chat.id)
          continue
        }
        const messages = await fetchRecoveryMessages(chat.id)
        const baselineIds = messages.filter(isBeforeAdapterStart).map((message) => message.id)
        bootstrapBaselines.set(chat.id, baselineIds)
        await continuityStore.seedThread(selfUserId, chat.id, baselineIds)
        bootstrapBaselines.delete(chat.id)
        for (const message of messages) {
          if (!(await deliverUnseen(message))) break
        }
      } catch (err) {
        logger.error(`[instagram] bootstrap failed chat=${chat.id}: ${describeError(err)}`)
      }
    }
  }

  const warnIfChatLimitReached = (chatCount: number): void => {
    if (chatCount !== INSTAGRAM_RECOVERY_CHAT_LIMIT || recoveryChatLimitWarned) return
    recoveryChatLimitWarned = true
    logger.warn(
      `[instagram] recovery chat list reached limit=${INSTAGRAM_RECOVERY_CHAT_LIMIT}; older chats cannot be recovered without upstream pagination`,
    )
  }

  const isBeforeAdapterStart = (message: InstagramMessageSummary): boolean => {
    const timestamp = Date.parse(message.timestamp)
    return Number.isNaN(timestamp) || timestamp < adapterStartedAt
  }

  const enqueueInbound = (task: () => Promise<void>): void => {
    inboundQueue = inboundQueue.then(task).catch((err: unknown) => {
      logger.error(`[instagram] recovery failed: ${describeError(err)}`)
    })
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      adapterStartedAt = (options.now ?? Date.now)()

      try {
        const credentialStore = options.credentialsStore ?? null
        if (credentialStore !== null) {
          const account = await credentialStore.getAccount()
          if (account === null) {
            throw new Error(
              'no Instagram account in secrets.json#channels.instagram (run typeclaw channel add instagram)',
            )
          }
          await client.login(undefined, account.account_id)
        } else {
          await client.login()
        }
      } catch (err) {
        started = false
        logger.error(`[instagram] login failed: ${describeError(err)}`)
        throw err
      }

      try {
        const profile = await client.getProfile()
        selfUserId = profile.user_id
        logger.info(`[instagram] authenticated as ${profile.username} (${profile.user_id})`)
      } catch (err) {
        started = false
        logger.error(`[instagram] getProfile failed: ${describeError(err)}`)
        throw err
      }

      if (continuityStore === null && options.agentDir !== undefined) {
        continuityStore = await loadInstagramContinuityStore(options.agentDir, logger)
      }

      try {
        await channelResolver.refresh()
      } catch (err) {
        logger.warn(`[instagram] initial chat list fetch failed: ${describeError(err)}`)
      }

      try {
        await seedBootstrap()
      } catch (err) {
        logger.warn(`[instagram] initial recovery failed: ${describeError(err)}`)
      }

      const resolved = (options.listenerCtorResolver ?? resolveInstagramListenerCtor)()
      listener = new resolved.ctor(client, { pollInterval: 5_000 })
      logger.info(`[instagram] listener transport=${resolved.transport}`)
      listener.on('connected', ({ userId, transport = 'polling' }) => {
        if (!started) return
        connected = true
        activeTransport = transport
        logger.info(`[instagram] connected (user_id=${userId}, transport=${transport})`)
        enqueueInbound(reconcileAll)
      })
      listener.on('disconnected', () => {
        if (!started) return
        connected = false
        logger.warn('[instagram] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        if (!started) return
        logger.error(`[instagram] listener error: ${describeError(err)}`)
      })
      listener.on('message', (message) => {
        if (!started) return
        const transport = activeTransport
        enqueueInbound(async () => {
          const unknownThread =
            continuityStore !== null &&
            selfUserId !== null &&
            !continuityStore.knowsThread(selfUserId, message.thread_id)
          if ((transport === 'polling' || unknownThread) && !(await reconcileThread(message.thread_id))) return
          await deliverUnseen(message)
        })
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
        logger.error(`[instagram] listener start failed: ${describeError(err)}`)
        throw err
      }

      options.router.registerOutbound('instagram', outboundCallback)
      options.router.registerSelfIdentity('instagram', selfIdentityResolver)
      options.router.registerChannelNameResolver('instagram', channelResolver.resolve)
      options.router.registerHistory('instagram', historyCallback)
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('instagram', outboundCallback)
      options.router.unregisterSelfIdentity('instagram', selfIdentityResolver)
      options.router.unregisterChannelNameResolver('instagram', channelResolver.resolve)
      options.router.unregisterHistory('instagram', historyCallback)
      listener?.stop()
      await inboundQueue
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener = null
      selfUserId = null
      connected = false
    },

    isConnected(): boolean {
      return connected && selfUserId !== null
    },
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

function formatLabel(name: string | undefined, id: string): string {
  if (name === undefined || name === '' || name === id) return id
  return `${name}(${id})`
}
