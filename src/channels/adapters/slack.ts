import { basename } from 'node:path'

import {
  SlackClient,
  SlackListener,
  type SlackMessage,
  type SlackRTMMessageEvent,
  type SlackRTMReactionEvent,
} from 'agent-messenger/slack'

import { DEFAULT_ATTACHMENT_MAX_BYTES, enforceAttachmentMetadataSize } from '@/channels/fetch-attachment'
import {
  MEMBERSHIP_ENUMERATION_CAP,
  type MembershipResolver,
  type MembershipResolverFailure,
  type MembershipResolverResult,
} from '@/channels/membership'
import { deriveMembershipFromHistory } from '@/channels/membership-from-history'
import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
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
} from '@/channels/types'
import { chunkMarkdown } from '@/markdown'
import type { SlackAccountRecord } from '@/secrets/schema'

import { describeError } from '../describe-error'
import { downloadSlackAttachment, type SlackAttachmentFetch } from './slack-attachment-download'
import { createSlackAuthorResolver } from './slack-author-resolver'
import { slackTsToMillis } from './slack-bot-time'
import { createSlackChannelResolver } from './slack-channel-resolver'
import { classifyInbound, type InboundDropReason, type SlackConversationType, splitSlackFiles } from './slack-classify'
import { createSlackUserEditMessageCallback } from './slack-edit'
import { createSlackReactionCallback, createSlackRemoveReactionCallback } from './slack-reactions'
import { createSlackOwnReactionCallbacks } from './slack-reactions'
import { invalidSlackThreadTs } from './slack-thread-ts'

export type SlackAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: SlackAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

const LISTENER_CONNECT_TIMEOUT_MS = 15_000

export type SlackCredentialStore = {
  getAccount(id?: string): Promise<SlackAccountRecord | null>
}

export type SlackAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: SlackAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: SlackCredentialStore
  createClient?: () => SlackClient
  createListener?: (client: SlackClient) => SlackListener
}

export type SlackAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export type SlackFileReader = (path: string) => Promise<Buffer>

export function createSlackOutboundCallback(deps: {
  client: Pick<SlackClient, 'sendMessage' | 'uploadFile'>
  logger: SlackAdapterLogger
  formatChannelTag: (chat: string) => Promise<string>
  readFile?: SlackFileReader
  resolvePath?: (path: string) => string
}): OutboundCallback {
  const readFile = deps.readFile ?? defaultReadFile
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'slack') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) return { ok: false, error: 'message has neither text nor attachments' }
    const tag = await deps.formatChannelTag(msg.chat)
    const threadTs = msg.replyTo?.externalMessageId ?? msg.thread ?? undefined
    const invalidThread = invalidSlackThreadTs(threadTs)
    if (invalidThread !== null) return { ok: false, error: invalidThread }
    deps.logger.info(
      `[slack] outbound ${tag} text_len=${text.length} attachments=${attachments.length}${threadTs !== undefined ? ` thread=${threadTs}` : ''}`,
    )
    try {
      if (text !== '') {
        for (const chunk of chunkMarkdown(text, 11_500)) await deps.client.sendMessage(msg.chat, chunk, threadTs)
      }
      for (const attachment of attachments) {
        const path = deps.resolvePath ? deps.resolvePath(attachment.path) : attachment.path
        const buffer = await readFile(path)
        const filename = attachment.filename ?? basename(path)
        await deps.client.uploadFile([msg.chat], buffer, filename)
      }
      // The user-account SDK send APIs return no posted-message id, so no reaction target ref is available.
      return { ok: true }
    } catch (err) {
      const message = describeError(err)
      deps.logger.error(`[slack] outbound failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createSlackHistoryCallback(deps: {
  client: Pick<SlackClient, 'getMessages'>
  logger: SlackAdapterLogger
}): HistoryCallback {
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    try {
      const messages = await deps.client.getMessages(args.chat, { limit: clampLimit(args.limit, 100) })
      return { ok: true, messages: messages.map(mapSlackHistoryMessage).reverse() }
    } catch (err) {
      const message = describeError(err)
      deps.logger.warn(`[slack] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createSlackMembershipResolver(deps: {
  client: Pick<SlackClient, 'listChannelMembers'>
  logger: SlackAdapterLogger
  historyCallback: HistoryCallback
  selfUserIdRef: () => string | null
  now?: () => number
}): MembershipResolver {
  const now = deps.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'slack') return { kind: 'permanent' } satisfies MembershipResolverFailure
    if (key.workspace === '@dm') return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }
    try {
      const members = await deps.client.listChannelMembers(key.chat)
      const capped = members.slice(0, MEMBERSHIP_ENUMERATION_CAP)
      const selfUserId = deps.selfUserIdRef()
      let bots = 0
      const humanMemberIds: string[] = []
      for (const member of capped) {
        if (selfUserId !== null && member === selfUserId) bots++
        else humanMemberIds.push(member)
      }
      const truncated = members.length >= MEMBERSHIP_ENUMERATION_CAP
      if (truncated) return { humans: humanMemberIds.length, bots, fetchedAt: now(), truncated }
      return { humans: humanMemberIds.length, bots, fetchedAt: now(), truncated, humanMemberIds }
    } catch (err) {
      deps.logger.warn(
        `[slack] membership channel=${key.chat} failed: ${describeError(err)}; deriving from recent history`,
      )
      return await deriveMembershipFromHistory({
        fetchHistory: (limit) => deps.historyCallback({ chat: key.chat, thread: key.thread, limit }),
        now,
      })
    }
  }
}

export function createSlackFetchAttachmentCallback(deps: {
  client: Pick<SlackClient, 'getFileInfo'>
  tokenRef: () => string | null
  cookieRef?: () => string | null
  fetchImpl?: SlackAttachmentFetch
  logger: SlackAdapterLogger
}): FetchAttachmentCallback {
  return async ({ ref, filename, maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES }) => {
    try {
      const metadata = await deps.client.getFileInfo(ref)
      enforceAttachmentMetadataSize(metadata.size, maxBytes)
      const token = deps.tokenRef()
      if (token === null) throw new Error('Slack attachment credential is unavailable')
      const cookie = deps.cookieRef?.() ?? undefined
      const { buffer } = await downloadSlackAttachment({
        metadata,
        token,
        ...(cookie === undefined ? {} : { cookie }),
        maxBytes,
        fetchImpl: deps.fetchImpl,
      })
      return {
        ok: true,
        buffer,
        filename: filename ?? metadata.name ?? 'attachment',
        mimetype: metadata.mimetype,
        size: buffer.length,
      }
    } catch (err) {
      const message = describeError(err)
      deps.logger.error(`[slack] fetchAttachment failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createSlackAdapter(options: SlackAdapterOptions): SlackAdapter {
  const logger = options.logger ?? consoleLogger
  const createClient = options.createClient ?? (() => new SlackClient())
  const createListener = options.createListener ?? ((client) => new SlackListener(client))
  const client = createClient()
  let listener: SlackListener | null = null
  let selfUserId: string | null = null
  let selfName: string | null = null
  let teamId = ''
  let teamName: string | null = null
  let accountToken: string | null = null
  let accountCookie: string | null = null
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []
  const conversationTypes = new Map<string, SlackConversationType>()

  const channelResolver = createSlackChannelResolver({ client, teamNameRef: () => teamName })
  const authorResolver = createSlackAuthorResolver({ client })
  const selfIdentityResolver: ChannelSelfIdentityResolver = () =>
    selfUserId !== null ? { id: selfUserId, username: selfName ?? selfUserId } : null
  const formatChannelTag = async (chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'slack', workspace: teamId, chat, thread: null }).catch(
      (): ResolvedChannelNames => ({}),
    )
    const label = names.chatName ?? null
    return label === null || label === chat ? `channel=${chat}` : `channel=${label}(${chat})`
  }
  const historyCallback = createSlackHistoryCallback({ client, logger })
  const membershipResolver = createSlackMembershipResolver({
    client,
    logger,
    historyCallback,
    selfUserIdRef: () => selfUserId,
  })
  const outboundCallback = createSlackOutboundCallback({ client, logger, formatChannelTag })
  const fetchAttachmentCallback = createSlackFetchAttachmentCallback({
    client,
    logger,
    tokenRef: () => accountToken,
    cookieRef: () => accountCookie,
  })
  const reactionCallback = createSlackReactionCallback({ client })
  const removeReactionCallback = createSlackRemoveReactionCallback({ client })
  const ownReaction = createSlackOwnReactionCallbacks({
    client,
    identity: async () => {
      const self = await client.testAuth()
      return self.team_id && self.user_id ? `${self.team_id}:${self.user_id}` : null
    },
  })
  const editMessageCallback = createSlackUserEditMessageCallback({ client })

  const resolveConversationType = async (event: SlackRTMMessageEvent): Promise<SlackConversationType | undefined> => {
    if (!event.channel.startsWith('G')) return undefined
    const cached = conversationTypes.get(event.channel)
    if (cached !== undefined) return cached
    return await client.listDMs().then(
      (conversations) => {
        const type: SlackConversationType = conversations.some(
          (conversation) => conversation.id === event.channel && conversation.is_mpim,
        )
          ? 'mpim'
          : 'channel'
        conversationTypes.set(event.channel, type)
        return type
      },
      (error: unknown) => {
        logger.warn(`[slack] conversation metadata failed channel=${event.channel}: ${describeError(error)}`)
        return 'channel'
      },
    )
  }

  const handleMessage = async (event: SlackRTMMessageEvent): Promise<void> => {
    inflightInbounds++
    try {
      const tag = await formatChannelTag(event.channel)
      logger.info(
        `[slack] inbound id=${event.ts} author=${event.user ?? '(none)'} ${tag} text_len=${(event.text ?? '').length}`,
      )
      const verdict = classifyInbound(event, options.configRef(), {
        teamId,
        selfUserId,
        selfAliases: options.selfAliasesRef?.() ?? [],
        conversationType: await resolveConversationType(event),
      })
      if (verdict.kind === 'drop') {
        logger.info(`[slack] dropped id=${event.ts} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }
      const payload = { ...verdict.payload, authorName: await authorResolver.resolve(verdict.payload.authorId) }
      logger.info(`[slack] routed id=${event.ts} ${tag} mention=${payload.isBotMention}`)
      await options.router.route(payload)
    } catch (err) {
      logger.error(`[slack] handleInbound failed: ${describeError(err)}`)
    } finally {
      inflightInbounds--
      if (inflightInbounds === 0 && stopWaiters.length > 0) {
        const waiters = stopWaiters
        stopWaiters = []
        for (const w of waiters) w()
      }
    }
  }

  const handleReaction = (kind: 'added' | 'removed', event: SlackRTMReactionEvent): void => {
    logger.info(`[slack] reaction_${kind} channel=${event.item.channel} ts=${event.item.ts} emoji=${event.reaction}`)
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      try {
        const account = await (options.credentialsStore ?? null)?.getAccount()
        if (account === null || account === undefined) {
          throw new Error('no Slack account in secrets.json#channels.slack (run typeclaw init to authenticate)')
        }
        await client.login({ token: account.token, cookie: account.cookie })
        accountToken = account.token
        accountCookie = account.cookie
        const auth = await client.testAuth()
        selfUserId = auth.user_id
        selfName = auth.user ?? auth.user_id
        teamId = auth.team_id
        teamName = auth.team ?? account.workspace_name ?? null
        logger.info(`[slack] authenticated as ${selfName} (${selfUserId}) team=${teamName ?? teamId}`)
      } catch (err) {
        started = false
        selfUserId = null
        accountToken = null
        accountCookie = null
        teamId = ''
        logger.error(`[slack] login failed: ${describeError(err)}`)
        throw err
      }

      listener = createListener(client)
      let listenerConnected = false
      let listenerStartupError: Error | null = null

      // SlackListener.start() resolves as soon as the WebSocket is opened, but
      // 'connected' is only emitted later when Slack sends the `hello` frame. A
      // synchronous post-start check therefore always fails the race. Gate
      // startup on a deferred settled by the 'connected'/'error' handlers below.
      let settleStartup: (() => void) | null = null
      let failStartup: ((err: Error) => void) | null = null
      const startupTimer = setTimeout(() => {
        failStartup?.(new Error(`listener did not connect within ${LISTENER_CONNECT_TIMEOUT_MS}ms`))
      }, LISTENER_CONNECT_TIMEOUT_MS)
      const connectedPromise = new Promise<void>((resolve, reject) => {
        settleStartup = () => {
          clearTimeout(startupTimer)
          resolve()
        }
        failStartup = (err) => {
          clearTimeout(startupTimer)
          reject(err)
        }
      })

      listener.on('connected', (info) => {
        listenerConnected = true
        connected = true
        selfUserId = info.self.id
        teamId = info.team.id
        settleStartup?.()
      })
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[slack] disconnected')
      })
      listener.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(describeError(err))
        if (!listenerConnected && listenerStartupError === null) {
          listenerStartupError = error
          failStartup?.(error)
        }
        logger.error(`[slack] listener error: ${describeError(err)}`)
      })
      listener.on('message', (event) => void handleMessage(event))
      listener.on('reaction_added', (event) => handleReaction('added', event))
      listener.on('reaction_removed', (event) => handleReaction('removed', event))

      options.router.registerOutbound('slack', outboundCallback)
      options.router.setTypingCapability('slack', false)
      options.router.registerChannelNameResolver('slack', channelResolver)
      options.router.registerSelfIdentity('slack', selfIdentityResolver)
      options.router.registerHistory('slack', historyCallback)
      options.router.registerFetchAttachment('slack', fetchAttachmentCallback)
      options.router.registerMembership('slack', membershipResolver)
      options.router.registerReaction('slack', reactionCallback)
      options.router.registerRemoveReaction('slack', removeReactionCallback)
      options.router.registerPrepareOwnReaction('slack', ownReaction.prepare)
      options.router.registerRemoveOwnReaction('slack', ownReaction.remove)
      options.router.registerEditMessage('slack', editMessageCallback)

      const rollbackStart = (reason: string, cause: Error): never => {
        options.router.unregisterOutbound('slack', outboundCallback)
        options.router.setTypingCapability('slack', false)
        options.router.unregisterChannelNameResolver('slack', channelResolver)
        options.router.unregisterSelfIdentity('slack', selfIdentityResolver)
        options.router.unregisterHistory('slack', historyCallback)
        options.router.unregisterFetchAttachment('slack', fetchAttachmentCallback)
        options.router.unregisterMembership('slack', membershipResolver)
        options.router.unregisterReaction('slack', reactionCallback)
        options.router.unregisterRemoveReaction('slack', removeReactionCallback)
        options.router.unregisterPrepareOwnReaction('slack', ownReaction.prepare)
        options.router.unregisterRemoveOwnReaction('slack', ownReaction.remove)
        options.router.unregisterEditMessage('slack', editMessageCallback)
        clearTimeout(startupTimer)
        listener?.stop()
        listener = null
        selfUserId = null
        accountToken = null
        connected = false
        started = false
        logger.error(`[slack] ${reason}: ${describeError(cause)}`)
        throw cause
      }

      try {
        await Promise.all([listener.start(), connectedPromise])
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(describeError(err))
        const reason = listenerStartupError !== null ? 'listener start failed' : 'listener start threw'
        rollbackStart(reason, cause)
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      accountToken = null
      options.router.unregisterOutbound('slack', outboundCallback)
      options.router.setTypingCapability('slack', false)
      options.router.unregisterChannelNameResolver('slack', channelResolver)
      options.router.unregisterSelfIdentity('slack', selfIdentityResolver)
      options.router.unregisterHistory('slack', historyCallback)
      options.router.unregisterFetchAttachment('slack', fetchAttachmentCallback)
      options.router.unregisterMembership('slack', membershipResolver)
      options.router.unregisterReaction('slack', reactionCallback)
      options.router.unregisterRemoveReaction('slack', removeReactionCallback)
      options.router.unregisterPrepareOwnReaction('slack', ownReaction.prepare)
      options.router.unregisterRemoveOwnReaction('slack', ownReaction.remove)
      options.router.unregisterEditMessage('slack', editMessageCallback)
      listener?.stop()
      listener = null
      connected = false
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      selfUserId = null
    },

    isConnected(): boolean {
      return started && selfUserId !== null && connected
    },
  }
}

async function defaultReadFile(path: string): Promise<Buffer> {
  return Buffer.from(await Bun.file(path).arrayBuffer())
}

function mapSlackHistoryMessage(msg: SlackMessage): ChannelHistoryMessage {
  const { text, attachments } = splitSlackFiles(msg.text, msg.files)
  return {
    externalMessageId: msg.ts,
    authorId: msg.user ?? msg.username ?? 'unknown',
    authorName: msg.username ?? msg.user ?? 'unknown',
    text,
    ts: slackTsToMillis(msg.ts),
    isBot: false,
    replyToBotMessageId: null,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_text':
      return ' (message had no text)'
    case 'pre_connect':
    case 'self_author':
    case 'no_user':
    case 'slack_system_message':
      return ''
  }
}
