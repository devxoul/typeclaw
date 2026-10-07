import {
  SlackBotClient,
  SlackBotListener,
  type SlackFile,
  type SlackSocketModeSlashCommandArgs,
} from 'agent-messenger/slackbot'

import { DEFAULT_ATTACHMENT_MAX_BYTES, enforceAttachmentMetadataSize } from '@/channels/fetch-attachment'
import {
  MEMBERSHIP_CACHE_TRANSIENT_TTL_MS,
  MEMBERSHIP_CACHE_TTL_MS,
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
  ChannelListEntry,
  ChannelSelfIdentityResolver,
  FetchAttachmentCallback,
  FetchHistoryArgs,
  FetchHistoryResult,
  GetMessageArgs,
  GetMessageResult,
  HistoryCallback,
  ListCallback,
  ListChannelsArgs,
  ListChannelsResult,
  MessageGetCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
  TypingCallback,
  TypingTarget,
} from '@/channels/types'
import { chunkMarkdown } from '@/markdown'

import { describeError } from '../describe-error'
import { addSlackMentionHints } from './mention-hints'
import { withOutboundAccount } from './outbound-account'
import { createBotRecoveryCallbacks, sendBotRecovery } from './recovery-correlation'
import { downloadSlackAttachment, type SlackAttachmentFetch } from './slack-attachment-download'
import { createSlackAuthorResolver, type SlackAuthorResolver } from './slack-bot-author-resolver'
import { createSlackChannelResolver } from './slack-bot-channel-resolver'
import {
  classifyInbound,
  describeSlackFile,
  type InboundDropReason,
  isRouteableSlackMessageSubtype,
  renderPlaceholder,
  type SlackInboundAppMentionEvent,
  type SlackInboundMessageEvent,
} from './slack-bot-classify'
import { createSlackDedupe, type SlackDedupeReservation } from './slack-bot-dedupe'
import { createSlackEditMessageCallback } from './slack-bot-edit'
import {
  createSlackReactionCallback,
  createSlackRemoveReactionCallback,
  encodeSlackReactionRef,
} from './slack-bot-reactions'
import { createSlackOwnReactionCallbacks } from './slack-bot-reactions'
import { enrichSlackReferenceContext } from './slack-bot-reference'
import {
  buildSlashAckPayload,
  commandResultReply,
  parseSlashCommand,
  parseThreadCommand,
  SLACK_SLASH_REPLY_FAILED,
  type ThreadCommandInput,
} from './slack-bot-slash-commands'
import { slackTsToMillis } from './slack-bot-time'
import { toSlackMrkdwn } from './slack-format'
import { admitSlackInbound, type SlackInboundSource } from './slack-inbound-revision'
import { invalidSlackThreadTs } from './slack-thread-ts'

// One slash command per logical agent gesture. Mirrors the discord-bot
// SLASH_COMMANDS constant so the cross-platform set stays consistent — when
// we add a new command (e.g. /memory), it appears in both adapters together.
// The actual registration lives in the Slack App Manifest at src/cli/ui.ts;
// this constant is the runtime allow-list that gates which delivered
// slash_commands events we route vs drop. The ui.test.ts manifest-drift
// test asserts equality between this set and SLACK_APP_MANIFEST.features.
// slash_commands so the two can never silently diverge.
export const SLACK_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(['help', 'stop', 'reload', 'restart'])

// Resolvers fall back to the raw id on failure, so a name equal to the id
// means resolution failed; we render the bare id rather than `id(id)`. The
// prefix is intentionally only applied to the named form so we never log
// `#C0DEPLOY` when resolution fails.
function formatLabel(name: string | undefined, id: string, prefix = ''): string {
  if (name === undefined || name === '' || name === id) return id
  return `${prefix}${name}(${id})`
}

export type SlackBotAdapterLoggerLike = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type SlashCommandHandlerDeps = {
  router: Pick<ChannelRouter, 'executeCommand'>
  knownCommandNames: ReadonlySet<string>
  logger: SlackBotAdapterLoggerLike
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
}

// Ack-first invariant: the handler must call args.ack() exactly once on
// every path AND must do so before any slow network work (resolver calls,
// post-ack logging). Slack's 3s ack deadline starts when the slash command
// envelope arrives on the WebSocket; missing it shows the user
// "/stop didn't respond in time". The synchronous executeCommand happy
// path is fast (in-memory map lookup + abort), so ack-after-execute is
// safe; everything else (formatChannelTag, post-ack logging) runs after.
//
// Ack failure handling: a thrown ack on the happy path is logged but does
// NOT trigger the catch-all error-ack below, which would attempt a second
// ack call and break the exactly-once contract.
export function createSlashCommandHandler(
  deps: SlashCommandHandlerDeps,
): (args: SlackSocketModeSlashCommandArgs) => Promise<void> {
  return async ({ ack, body }) => {
    const parsed = parseSlashCommand(body, deps.knownCommandNames)
    if (parsed.kind === 'ignore') {
      deps.logger.warn(`[slack-bot] slash command dropped reason=${parsed.reason} command=${body.command}`)
      try {
        ack(buildSlashAckPayload(SLACK_SLASH_REPLY_FAILED))
      } catch (err) {
        deps.logger.warn(`[slack-bot] slash command ack (drop path) failed: ${describeError(err)}`)
      }
      return
    }
    const { command } = parsed

    // Pre-ACK log: bare ids only (no formatChannelTag — would burn ack budget
    // on a slow Slack API minute via the channel-name resolver).
    deps.logger.info(
      `[slack-bot] slash /${command.name} invoker=${command.invokerId} team=${command.key.workspace} channel=${command.key.chat}`,
    )

    let result: Awaited<ReturnType<typeof deps.router.executeCommand>>
    try {
      result = await deps.router.executeCommand(command.key, command.name, {
        invokerId: command.invokerId,
      })
    } catch (err) {
      deps.logger.error(`[slack-bot] slash command handler failed: ${describeError(err)}`)
      try {
        ack(buildSlashAckPayload(SLACK_SLASH_REPLY_FAILED))
      } catch (ackErr) {
        deps.logger.warn(`[slack-bot] slash command error-ack failed: ${describeError(ackErr)}`)
      }
      return
    }

    const replyContent = commandResultReply(result)

    // Final ack on the happy path: own try/catch so a thrown ack here does
    // NOT cascade into the error-path ack above (which would violate the
    // exactly-once contract). The abort already happened server-side; only
    // the user-visible confirmation is lost.
    try {
      ack(buildSlashAckPayload(replyContent))
    } catch (err) {
      deps.logger.warn(`[slack-bot] slash command ack failed: ${describeError(err)}`)
    }

    // Decorative post-ack logging: resolve channel names now that the 3s
    // budget is no longer a concern. Best-effort.
    try {
      const inboundTag = await deps.formatChannelTag(command.key.workspace, command.key.chat)
      deps.logger.info(`[slack-bot] slash /${command.name} result=${result.kind} ${inboundTag}`)
    } catch (err) {
      deps.logger.info(
        `[slack-bot] slash /${command.name} result=${result.kind} (channel-tag resolution failed: ${describeError(err)})`,
      )
    }
  }
}

export type ThreadCommandReplyPoster = (args: { chat: string; thread: string | null; text: string }) => Promise<void>

export type ThreadCommandHandlerDeps = {
  router: Pick<ChannelRouter, 'executeCommand'>
  knownCommandNames: ReadonlySet<string>
  postReply: ThreadCommandReplyPoster
  logger: SlackBotAdapterLoggerLike
}

export type ThreadCommandOutcome = { kind: 'not-a-command' } | { kind: 'duplicate' } | { kind: 'executed' }

// Synchronous reservation: the adapter marks the dedupe ring inside this hook,
// which the handler calls before its first `await`. Two duplicate Slack
// deliveries can both clear `dedupe.check()` on the same JS tick; whichever
// reserves first wins and returns `true`, the loser returns `false` and aborts
// — so a control command never runs twice across the check→execute window.
export type ThreadCommandReserve = () => boolean

// Routes a `!cmd` thread message through the SAME router.executeCommand path as
// native slashes, then posts the outcome back into the thread. Returns
// 'not-a-command' (caller proceeds with normal classify/route), 'duplicate'
// (a racing delivery already reserved this event — caller stops silently), or
// 'executed' (command handled — caller stops; it is not agent input).
export function createThreadCommandHandler(
  deps: ThreadCommandHandlerDeps,
): (input: ThreadCommandInput, reserve: ThreadCommandReserve) => Promise<ThreadCommandOutcome> {
  return async (input, reserve) => {
    const parsed = parseThreadCommand(input, deps.knownCommandNames)
    if (parsed.kind === 'ignore') {
      return { kind: 'not-a-command' }
    }
    // Reserve synchronously, before any await, to close the check→execute race.
    if (!reserve()) {
      return { kind: 'duplicate' }
    }
    const { command } = parsed
    deps.logger.info(
      `[slack-bot] thread-command !${command.name} invoker=${command.invokerId} team=${command.key.workspace} channel=${command.key.chat} thread=${command.key.thread ?? '(none)'}`,
    )

    // null = stay silent. A shared Slack channel can host many agents; each one
    // receives this message and runs its own executeCommand. Only the agent that
    // actually had a running turn gets 'handled'; every bystander gets
    // 'no-live-session'. Posting "Nothing to stop" from each bystander would spam
    // the thread, so a no-live-session outcome posts nothing at all.
    let reply: string | null
    try {
      const result = await deps.router.executeCommand(command.key, command.name, {
        invokerId: command.invokerId,
      })
      reply = result.kind === 'no-live-session' ? null : commandResultReply(result)
      deps.logger.info(`[slack-bot] thread-command !${command.name} result=${result.kind}`)
    } catch (err) {
      deps.logger.error(`[slack-bot] thread-command !${command.name} failed: ${describeError(err)}`)
      reply = SLACK_SLASH_REPLY_FAILED
    }

    if (reply !== null) {
      try {
        await deps.postReply({ chat: input.channel, thread: input.threadTs, text: reply })
      } catch (err) {
        deps.logger.warn(`[slack-bot] thread-command reply post failed: ${describeError(err)}`)
      }
    }
    return { kind: 'executed' }
  }
}

// app_mention payloads omit channel_type and never carry a subtype, so we
// promote them to a message-shaped event for the shared classifier. The
// promoted event is classified as a regular channel message; the
// `<@BOT_USER_ID>` substring inside `text` is what makes the classifier
// mark it as a mention. `edited` is carried over because an app_mention for an
// edit lacks the previous body and must stay subject to the edit gate.
export function promoteAppMentionToMessage(event: SlackInboundAppMentionEvent): SlackInboundMessageEvent {
  return {
    type: 'message',
    channel: event.channel,
    channel_type: 'channel',
    user: event.user,
    text: event.text,
    ts: event.ts,
    ...(event.thread_ts !== undefined ? { thread_ts: event.thread_ts } : {}),
    ...(event.event_ts !== undefined ? { event_ts: event.event_ts } : {}),
    ...(event.client_msg_id !== undefined ? { client_msg_id: event.client_msg_id } : {}),
    ...(event.edited !== undefined ? { edited: event.edited as SlackInboundMessageEvent['edited'] } : {}),
  }
}

export type SlackBotAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: SlackBotAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type SlackBotAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  token: string
  appToken: string
  logger?: SlackBotAdapterLogger
  // Read live so an `applied`-class reload of `alias` flows through to
  // thread anchoring without restart. Optional: omitted means the
  // classifier behaves as before (no alias-driven thread anchoring), so
  // tests and ad-hoc adapter constructions stay backwards-compatible.
  selfAliasesRef?: () => readonly string[]
  fetchImpl?: typeof fetch
  createClient?: () => SlackBotClient
  createListener?: (client: SlackBotClient, appToken: string) => SlackBotListener
}

export type SlackBotAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

// Slack's only bot-accessible typing-style signal is `assistant.threads.
// setStatus`, which is scoped to AI Assistant threads and requires a
// `thread_ts`. The classic `user_typing` is RTM-only and rejects bot
// tokens, so there is nothing to send for top-level (non-threaded) chats —
// we log and bail in that case. Slack auto-clears the status when the bot
// posts its reply (per the assistant.threads.setStatus docs), but the
// router heartbeat (~every 8s) and the outbound postMessage can race: an
// in-flight setStatus("is typing...") that lands AFTER postMessage will
// re-set the indicator, and Slack's server-side timeout won't clear it
// for ~2 minutes. The fix is per-thread serialization (see
// `createSlackTypingTracker`) plus an explicit empty-string setStatus
// queued by the outbound callback after every successful send.
//
// Slack rejects calls in non-Assistant channels with `channel_not_found` /
// `not_in_channel`-style errors; we surface those as a single warn line
// per heartbeat (matching the Discord adapter's non-2xx handling) rather
// than escalating to error, because the bot may simply be deployed in a
// regular channel.
export type SlackTypingTracker = {
  setStatus: (chat: string, threadTs: string, status: string) => Promise<void>
  clearAfterSend: (chat: string, threadTs: string | null | undefined) => Promise<void>
}

export function createSlackTypingTracker(deps: {
  client: Pick<SlackBotClient, 'setAssistantStatus'>
  logger: SlackBotAdapterLogger
}): SlackTypingTracker {
  const { client, logger } = deps
  const queues = new Map<string, Promise<void>>()
  // Monotonic per-tracker counter so the three lifecycle log lines for one
  // call (queued → sent → ok) can be correlated by id even when many calls
  // for the same (chat, thread) interleave on the wire.
  let nextCallId = 0

  const enqueue = (chat: string, threadTs: string, status: string): Promise<void> => {
    const key = `${chat}\x00${threadTs}`
    const callId = nextCallId++
    // queue depth BEFORE this call is added — tells us whether the FIFO is
    // back-pressuring (depth>0) or this call gets to fly straight to Slack.
    const queueDepthBefore = queues.has(key) ? 1 : 0
    logger.info(
      `[slack-bot] typing call=${callId} chat=${chat} thread=${threadTs} status="${status}" queued (depth=${queueDepthBefore})`,
    )
    const prev = queues.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => {
        logger.info(`[slack-bot] typing call=${callId} sending`)
        return client.setAssistantStatus(chat, threadTs, status)
      })
      .then(() => {
        logger.info(`[slack-bot] typing call=${callId} ok`)
      })
      .catch((err: unknown) => {
        logger.warn(
          `[slack-bot] typing call=${callId} chat=${chat} thread=${threadTs} status="${status}" failed: ${describeError(err)}`,
        )
      })
    queues.set(key, next)
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
    return next
  }

  return {
    setStatus: (chat, threadTs, status) => enqueue(chat, threadTs, status),
    clearAfterSend: async (chat, threadTs) => {
      if (threadTs === null || threadTs === undefined || threadTs === '') return
      await enqueue(chat, threadTs, '')
    },
  }
}

export function createTypingCallback(deps: {
  typingTracker: Pick<SlackTypingTracker, 'setStatus' | 'clearAfterSend'>
  logger: SlackBotAdapterLogger
  formatChannelTag?: (workspace: string, chat: string) => Promise<string>
}): TypingCallback {
  const { typingTracker, logger, formatChannelTag } = deps
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'slack-bot') return
    // DMs are flat (thread null) but setStatus still needs a real message ts;
    // `typingThread` carries the inbound ts for exactly that case. Real channel
    // threads keep using `thread`. Either way the status is keyed on one ts.
    const statusThread =
      target.typingThread !== undefined && target.typingThread !== '' ? target.typingThread : target.thread
    if (statusThread === undefined || statusThread === null || statusThread === '') {
      if (target.phase === 'tick') {
        const tag = formatChannelTag
          ? await formatChannelTag(target.workspace, statusThread ?? target.chat)
          : `channel=${statusThread ?? target.chat}`
        logger.info(`[slack-bot] typing (no-op, top-level chat) ${tag}`)
      }
      return
    }
    // Append to the per-(chat,thread) FIFO BEFORE awaiting anything: the FIFO
    // only orders calls once setStatus/clearAfterSend is reached, so awaiting
    // `formatChannelTag` first opens an unordered gap where a fire-and-forget
    // re-arm 'tick' (router send() after a reply) can enqueue "is typing..."
    // AFTER the turn-end 'stop' clear. Flat DMs have no threaded-reply
    // auto-clear, so that strands the indicator until Slack's ~2-min timeout.
    const enqueued =
      target.phase === 'stop'
        ? typingTracker.clearAfterSend(target.chat, statusThread)
        : typingTracker.setStatus(target.chat, statusThread, 'is typing...')
    await enqueued
  }
}

export const SLACK_HISTORY_LIMIT_MAX = 200

const SLACK_API_BASE = 'https://slack.com/api'

type SlackRawHistoryMessage = {
  ts: string
  type?: string
  subtype?: string
  user?: string
  bot_id?: string
  text?: string
  thread_ts?: string
  parent_user_id?: string
  files?: SlackFile[]
}

type SlackHistoryResponse = {
  ok: boolean
  error?: string
  messages?: SlackRawHistoryMessage[]
  response_metadata?: { next_cursor?: string }
}

type SlackConversationInfoResponse = {
  ok: boolean
  error?: string
  channel?: { num_members?: number }
}

type SlackConversationsListChannel = {
  id?: string
  name?: string
  is_im?: boolean
  is_mpim?: boolean
  is_member?: boolean
}

type SlackConversationsListResponse = {
  ok: boolean
  error?: string
  channels?: SlackConversationsListChannel[]
  response_metadata?: { next_cursor?: string }
}

type SlackConversationMembersResponse = {
  ok: boolean
  error?: string
  members?: string[]
}

type SlackUserInfoResponse = {
  ok: boolean
  error?: string
  user?: { is_bot?: boolean; deleted?: boolean }
}

type SlackUsersListResponse = {
  ok: boolean
  error?: string
  members?: Array<{ id?: string; is_bot?: boolean }>
  response_metadata?: { next_cursor?: string }
}

const USERS_LIST_PAGE_LIMIT = 200
const USERS_LIST_MAX_PAGES = 50

export function createSlackMembershipResolver(deps: {
  token: string
  logger: SlackBotAdapterLogger
  historyCallback: HistoryCallback
  fetchImpl?: typeof fetch
  now?: () => number
}): MembershipResolver {
  const fetchFn = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const userBotCache = new Map<string, boolean>()

  // Keyed by workspace. One resolver instance is bound to a single token/team
  // today, but the router dispatches by adapter (not by adapter+workspace), so
  // scoping the warm set by `key.workspace` keeps a set built for one workspace
  // from ever classifying another's members if a multi-workspace mode is added.
  const botSetCache = new Map<string, { ids: ReadonlySet<string>; fetchedAt: number }>()
  const botSetFailedAt = new Map<string, number>()
  const botSetInFlight = new Map<string, Promise<ReadonlySet<string> | null>>()

  const warmBotSet = async (workspace: string): Promise<ReadonlySet<string> | null> => {
    const cached = botSetCache.get(workspace)
    if (cached !== undefined && now() - cached.fetchedAt < MEMBERSHIP_CACHE_TTL_MS) return cached.ids
    // Negative-cache a failed warm so a rate-limited workspace doesn't re-run
    // the full paginated `users.list` crawl on every membership read — that
    // would keep the hot path expensive under the exact failure this PR fixes.
    // Members fall back to per-id `users.info` during the cooldown.
    const failedAt = botSetFailedAt.get(workspace)
    if (failedAt !== undefined && now() - failedAt < MEMBERSHIP_CACHE_TRANSIENT_TTL_MS) return null
    const inFlight = botSetInFlight.get(workspace)
    if (inFlight !== undefined) return await inFlight
    const promise = fetchWorkspaceBotIds(fetchFn, deps.token, deps.logger)
      .then((ids) => {
        if (ids !== null) {
          botSetCache.set(workspace, { ids, fetchedAt: now() })
          botSetFailedAt.delete(workspace)
        } else {
          botSetFailedAt.set(workspace, now())
        }
        return ids
      })
      .finally(() => {
        botSetInFlight.delete(workspace)
      })
    botSetInFlight.set(workspace, promise)
    return await promise
  }

  return async (key): Promise<MembershipResolverResult> => {
    if (key.workspace === '@dm') return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }

    const fallback = (): Promise<MembershipResolverResult> =>
      deriveMembershipFromHistory({
        fetchHistory: (limit) => deps.historyCallback({ chat: key.chat, thread: key.thread, limit }),
        now,
      })

    const info = await slackApi<SlackConversationInfoResponse>(fetchFn, deps.token, 'conversations.info', {
      channel: key.chat,
    })
    if (!info.ok) {
      // missing_scope / not_in_channel: the bot cannot see the channel's
      // member list at all, but `conversations.history` (or app_mention
      // delivery) usually still works enough to derive recent speakers.
      // Treat any permanent failure here as a signal to fall back rather
      // than propagate "I don't know" upstream — same shape as Discord's
      // 403 path.
      if (info.failure.kind === 'permanent') {
        deps.logger.warn(
          `[slack-bot] membership info channel=${key.chat} failed permanently: ${info.reason}; deriving from recent message authors`,
        )
        return await fallback()
      }
      deps.logger.warn(`[slack-bot] membership info channel=${key.chat} failed: ${info.reason}`)
      return info.failure
    }

    const total = Math.max(0, Math.floor(info.value.channel?.num_members ?? 0))
    if (total > MEMBERSHIP_ENUMERATION_CAP) {
      // Beyond the enumeration cap, the recent-speakers count is more
      // useful for engagement than a raw channel-wide approximation that
      // double-counts lurkers.
      return await fallback()
    }

    const members = await slackApi<SlackConversationMembersResponse>(fetchFn, deps.token, 'conversations.members', {
      channel: key.chat,
      limit: String(MEMBERSHIP_ENUMERATION_CAP),
    })
    if (!members.ok) {
      if (members.failure.kind === 'permanent') {
        deps.logger.warn(
          `[slack-bot] membership members channel=${key.chat} failed permanently: ${members.reason}; deriving from recent message authors`,
        )
        return await fallback()
      }
      deps.logger.warn(`[slack-bot] membership members channel=${key.chat} failed: ${members.reason}`)
      return members.failure
    }

    // Reached only for channels at or under the cap (larger ones returned
    // `truncated` above). `conversations.members` gives ids with no bot/human
    // flag and Slack has no bulk-classify-ids call, so per-member `users.info`
    // is an N+1 that exceeds the router cold-fetch timeout near the cap; the
    // read then returns null and engagement misreads the busy channel as solo.
    // Classify against a workspace bot-id set from one paginated `users.list`
    // (bots are a small set, shared across channels). `users.info` stays as a
    // per-id fallback for ids minted after the last warm, keeping `bots` and
    // `humanMemberIds` exact for `grant_role`'s "no peer bot present" proof.
    const memberIds = members.value.members ?? []
    const botSet = await warmBotSet(key.workspace)
    let bots = 0
    const humanMemberIds: string[] = []
    for (const userId of memberIds) {
      const isBot =
        botSet?.has(userId) ?? (await resolveSlackUserIsBot(fetchFn, deps.token, userId, deps.logger, userBotCache))
      if (isBot) bots++
      else humanMemberIds.push(userId)
    }
    return { humans: humanMemberIds.length, bots, fetchedAt: now(), truncated: false, humanMemberIds }
  }
}

type SlackApiResult<T> = { ok: true; value: T } | { ok: false; reason: string; failure: MembershipResolverFailure }

async function slackApi<T>(
  fetchFn: typeof fetch,
  token: string,
  method: string,
  fields: Record<string, string>,
): Promise<SlackApiResult<T>> {
  const body = new URLSearchParams(fields)
  let raw: { ok?: boolean; error?: string }
  try {
    const response = await fetchFn(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: body.toString(),
    })
    raw = (await response.json()) as { ok?: boolean; error?: string }
  } catch (err) {
    return { ok: false, reason: describeError(err), failure: { kind: 'transient' } }
  }
  if (raw.ok !== true) {
    const reason = raw.error ?? 'unknown slack error'
    return { ok: false, reason, failure: slackFailureForError(reason) }
  }
  return { ok: true, value: raw as T }
}

async function resolveSlackUserIsBot(
  fetchFn: typeof fetch,
  token: string,
  userId: string,
  logger: SlackBotAdapterLogger,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const cached = cache.get(userId)
  if (cached !== undefined) return cached
  const info = await slackApi<SlackUserInfoResponse>(fetchFn, token, 'users.info', { user: userId })
  if (!info.ok) {
    logger.warn(`[slack-bot] membership users.info user=${userId} failed: ${info.reason}`)
    // Only a definitive answer is cached. A transient failure (429/network)
    // must not be memoized as "human" — that would poison classification until
    // restart and let a peer bot read as human, skewing engagement and
    // `grant_role`'s "no peer bot" proof. Default this read to human (the
    // safe, count-conservative direction) but let the next read retry.
    if (info.failure.kind === 'permanent') cache.set(userId, false)
    return false
  }
  const isBot = info.value.user?.is_bot === true
  cache.set(userId, isBot)
  return isBot
}

// Enumerates the workspace and returns the set of bot user ids. Slack has no
// server-side `is_bot` filter, so we page the full `users.list` and keep only
// bots — a complete pass is required so silent lurking bots (never seen in
// history) are still counted, which `grant_role`'s "no peer bot" proof relies
// on. Returns null on any failure so the caller can fall back to per-id
// `users.info` rather than trusting an incomplete set. Page count is bounded so
// a pathologically large workspace cannot stall the read indefinitely.
async function fetchWorkspaceBotIds(
  fetchFn: typeof fetch,
  token: string,
  logger: SlackBotAdapterLogger,
): Promise<ReadonlySet<string> | null> {
  const botIds = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < USERS_LIST_MAX_PAGES; page++) {
    const fields: Record<string, string> = { limit: String(USERS_LIST_PAGE_LIMIT) }
    if (cursor !== undefined && cursor !== '') fields.cursor = cursor
    const res = await slackApi<SlackUsersListResponse>(fetchFn, token, 'users.list', fields)
    if (!res.ok) {
      logger.warn(`[slack-bot] users.list failed: ${res.reason}; falling back to per-member classification`)
      return null
    }
    for (const member of res.value.members ?? []) {
      if (member.is_bot === true && typeof member.id === 'string') botIds.add(member.id)
    }
    cursor = res.value.response_metadata?.next_cursor
    if (cursor === undefined || cursor === '') return botIds
  }
  logger.warn(`[slack-bot] users.list exceeded ${USERS_LIST_MAX_PAGES} pages; bot set may be incomplete`)
  return null
}

function slackFailureForError(error: string): MembershipResolverFailure {
  if (['invalid_auth', 'not_authed', 'not_in_channel', 'channel_not_found', 'missing_scope'].includes(error)) {
    return { kind: 'permanent' }
  }
  return { kind: 'transient' }
}

// Direct fetch to Slack's Web API. agent-messenger's SlackBotClient
// covers postMessage / setAssistantStatus / testAuth / uploadFile /
// downloadFile but not conversations.history or conversations.replies,
// so history calls go through fetch using the same pattern the Discord
// adapter uses for /typing. Slack uses application/x-www-form-urlencoded
// for these endpoints; JSON works too when paired with the right
// Content-Type but URL-encoded is what every client library defaults to
// and is the most-tested wire format.
export function createSlackHistoryCallback(deps: {
  token: string
  logger: SlackBotAdapterLogger
  botUserIdRef: () => string | null
  authorResolver?: SlackAuthorResolver
  fetchImpl?: typeof fetch
}): HistoryCallback {
  const { token, logger, botUserIdRef, authorResolver } = deps
  const fetchFn = deps.fetchImpl ?? fetch
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const limit = clampLimit(args.limit, SLACK_HISTORY_LIMIT_MAX)
    const endpoint = args.thread === null ? 'conversations.history' : 'conversations.replies'
    const body = new URLSearchParams()
    body.set('channel', args.chat)
    body.set('limit', String(limit))
    if (args.thread !== null) body.set('ts', args.thread)
    if (args.cursor !== undefined && args.cursor !== '') body.set('cursor', args.cursor)

    let raw: SlackHistoryResponse
    try {
      const response = await fetchFn(`${SLACK_API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: body.toString(),
      })
      raw = (await response.json()) as SlackHistoryResponse
    } catch (err) {
      const message = describeError(err)
      logger.warn(`[slack-bot] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }

    if (!raw.ok) {
      return { ok: false, error: raw.error ?? 'unknown slack error' }
    }

    const botUserId = botUserIdRef()
    const rawMessages = (raw.messages ?? []).filter((message) => isRouteableSlackMessageSubtype(message.subtype))
    const mapped = rawMessages.map((m) => mapSlackMessage(m, botUserId))
    // History payloads carry no profile, so mapSlackMessage echoes the raw
    // id into authorName; resolve it here so prompts show display names.
    // Only msg.user authors are resolvable — bot_id-only messages have no
    // users.info entry. The resolver caches/coalesces, so repeated authors
    // cost one lookup each.
    if (authorResolver !== undefined) {
      const resolver = authorResolver
      const botId = botUserIdRef()
      await Promise.all(
        mapped.map(async (message, index) => {
          message.text = await addSlackMentionHints(message.text, resolver.resolve, { botUserId: botId })
          const userId = rawMessages[index]?.user
          if (userId === undefined || userId === '') return
          message.authorName = await resolver.resolve(userId)
        }),
      )
    }
    // Slack's `conversations.history` returns newest-first; `replies`
    // returns oldest-first. Normalize to oldest-first so the agent always
    // reads chronological order regardless of scope.
    if (args.thread === null) mapped.reverse()

    const nextCursor = raw.response_metadata?.next_cursor
    if (nextCursor !== undefined && nextCursor !== '') {
      return { ok: true, messages: mapped, nextCursor }
    }
    return { ok: true, messages: mapped }
  }
}

// Fetch one message by ts. Slack has no by-id endpoint, so we window
// conversations.history (channel root) or conversations.replies (thread) to a
// single ts via oldest=latest=messageId, inclusive=true, limit=1 — without the
// window, a long thread is cursor-paginated and a reply past the first page
// would be wrongly reported not-found. conversations.replies still needs `ts`
// set to the thread ROOT to identify the thread. Reuses mapSlackMessage so a
// single message renders identically to a history entry.
export function createSlackMessageGetCallback(deps: {
  token: string
  logger: SlackBotAdapterLogger
  botUserIdRef: () => string | null
  authorResolver?: SlackAuthorResolver
  fetchImpl?: typeof fetch
}): MessageGetCallback {
  const { token, logger, botUserIdRef, authorResolver } = deps
  const fetchFn = deps.fetchImpl ?? fetch
  return async (args: GetMessageArgs): Promise<GetMessageResult> => {
    const body = new URLSearchParams()
    body.set('channel', args.chat)
    if (args.thread !== null) body.set('ts', args.thread)
    body.set('oldest', args.messageId)
    body.set('latest', args.messageId)
    body.set('inclusive', 'true')
    body.set('limit', '1')
    const endpoint = args.thread === null ? 'conversations.history' : 'conversations.replies'

    let raw: SlackHistoryResponse
    try {
      const response = await fetchFn(`${SLACK_API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: body.toString(),
      })
      raw = (await response.json()) as SlackHistoryResponse
    } catch (err) {
      const message = describeError(err)
      logger.warn(`[slack-bot] message get failed: ${message}`)
      return { ok: false, error: message }
    }

    if (!raw.ok) return { ok: false, error: raw.error ?? 'unknown slack error' }

    const botUserId = botUserIdRef()
    const found = (raw.messages ?? []).find((m) => m.ts === args.messageId)
    if (found === undefined) return { ok: false, error: 'message not found', code: 'not-found' }

    const message = mapSlackMessage(found, botUserId)
    if (authorResolver !== undefined && found.user !== undefined && found.user !== '') {
      message.text = await addSlackMentionHints(message.text, authorResolver.resolve, { botUserId })
      message.authorName = await authorResolver.resolve(found.user)
    }
    return { ok: true, message }
  }
}

// List channels the bot can see via conversations.list. Maps Slack channel
// types to ChannelListEntry.kind; `is_member` from the API populates isMember.
export function createSlackListCallback(deps: {
  token: string
  logger: SlackBotAdapterLogger
  fetchImpl?: typeof fetch
}): ListCallback {
  const { token, logger } = deps
  const fetchFn = deps.fetchImpl ?? fetch
  return async (args: ListChannelsArgs): Promise<ListChannelsResult> => {
    const body = new URLSearchParams()
    body.set('limit', String(clampLimit(args.limit, 200)))
    body.set('types', 'public_channel,private_channel,mpim,im')
    if (args.cursor !== undefined && args.cursor !== '') body.set('cursor', args.cursor)

    let raw: SlackConversationsListResponse
    try {
      const response = await fetchFn(`${SLACK_API_BASE}/conversations.list`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: body.toString(),
      })
      raw = (await response.json()) as SlackConversationsListResponse
    } catch (err) {
      const message = describeError(err)
      logger.warn(`[slack-bot] channel list failed: ${message}`)
      return { ok: false, error: message }
    }

    if (!raw.ok) return { ok: false, error: raw.error ?? 'unknown slack error' }

    const entries = (raw.channels ?? []).map((c) => mapSlackChannelEntry(c))
    const nextCursor = raw.response_metadata?.next_cursor
    if (nextCursor !== undefined && nextCursor !== '') return { ok: true, entries, nextCursor }
    return { ok: true, entries }
  }
}

function mapSlackChannelEntry(c: SlackConversationsListChannel): ChannelListEntry {
  const kind: ChannelListEntry['kind'] = c.is_im === true ? 'dm' : c.is_mpim === true ? 'group' : 'channel'
  const name = c.name !== undefined && c.name !== '' ? `#${c.name}` : (c.id ?? 'unknown')
  return {
    chat: c.id ?? 'unknown',
    name,
    kind,
    ...(c.is_member !== undefined ? { isMember: c.is_member } : {}),
  }
}

function mapSlackMessage(msg: SlackRawHistoryMessage, botUserId: string | null): ChannelHistoryMessage {
  const isBot =
    msg.subtype === 'bot_message' ||
    (msg.user !== undefined && botUserId !== null && msg.user === botUserId) ||
    (msg.bot_id !== undefined && (msg.user === undefined || msg.user === ''))
  // Slack's parent_user_id is set on thread replies and points at the
  // author of the parent message. When that parent author is our bot, we
  // expose this as `replyToBotMessageId = thread_ts` so the agent can
  // recognize threads it started — same convention as the inbound
  // classifier uses for live messages.
  const replyToBotMessageId =
    msg.thread_ts !== undefined &&
    msg.parent_user_id !== undefined &&
    botUserId !== null &&
    msg.parent_user_id === botUserId
      ? msg.thread_ts
      : null
  // The history fetch bypasses the inbound classifier, so files on
  // already-posted messages (e.g. an image on a thread root the agent is
  // later @-mentioned under) must be mapped here too — otherwise they are
  // silently dropped and look_at_channel_attachment can never resolve them.
  // Mirror splitInbound: bake placeholders into text and carry the structured
  // attachments so the router can resolve ids.
  const attachments = (msg.files ?? []).map((file, index) => describeSlackFile(file, index + 1))
  const rawText = msg.text ?? ''
  const text =
    attachments.length === 0
      ? rawText
      : rawText === ''
        ? attachments.map(renderPlaceholder).join('\n')
        : `${rawText}\n${attachments.map(renderPlaceholder).join('\n')}`
  return {
    externalMessageId: msg.ts,
    authorId: msg.user ?? msg.bot_id ?? 'unknown',
    authorName: msg.user ?? msg.bot_id ?? 'unknown',
    text,
    ts: slackTsToMillis(msg.ts),
    isBot,
    replyToBotMessageId,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

// Slack supports text+file in a single API call via `initial_comment`, and
// honors `thread_ts` on every upload — both luxuries Discord lacks. So we
// fold `text` into the FIRST attachment's `initial_comment` rather than
// posting it separately, which preserves the "single message" appearance
// in the Slack UI (one notification, one anchored thread reply, one event
// in the bot's own channel history).
//
// Multi-attachment behavior: each attachment is uploaded sequentially. The
// first carries the comment; the rest are uploaded bare. Sequential not
// parallel because (a) order matters for users' visual scan and (b) Slack
// rate-limits aggressive parallel uploads on the bot's behalf.
//
// Failure semantics mirror the Discord adapter: any upload failure aborts
// and returns ok:false. The text-only fallback (no attachments) keeps the
// original `postMessage` path so message routing and rate limits behave
// exactly as before for the common case.
async function readAttachmentBuffer(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  return await readFile(path)
}

// Slack's `markdown` block (introduced March 2026) accepts standard
// GitHub-flavored Markdown and renders it correctly — the agent no longer
// needs to translate `**bold**` → `*bold*`, tables, headings, etc. by hand.
// We send every text-only message as a `markdown` block, with `text` set
// to the original GFM as the notification fallback (Slack truncates that
// for previews; raw GFM artifacts there are acceptable).
//
// The cumulative payload limit on `markdown` blocks is 12,000 characters.
// We allow 11,500 to leave headroom for the block envelope and split with
// `chunkMarkdown` so structural blocks (tables, code fences) survive the
// split intact. Multi-chunk messages thread under the first chunk: chunks
// 2..N reuse the first chunk's `ts` as `thread_ts` so a long reply
// surfaces as one threaded conversation in the Slack UI.
export const SLACK_MARKDOWN_BLOCK_LIMIT = 11_500

type MarkdownBlock = { type: 'markdown'; text: string }

function buildMarkdownBlock(text: string): MarkdownBlock {
  return { type: 'markdown', text }
}

export function createOutboundCallback(deps: {
  client: Pick<SlackBotClient, 'postMessage' | 'uploadFile'>
  logger: SlackBotAdapterLogger
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
  readFile?: (path: string) => Promise<Buffer>
  typingTracker?: Pick<SlackTypingTracker, 'clearAfterSend'>
  token?: string
  fetchImpl?: typeof fetch
}): OutboundCallback {
  const { client, logger, formatChannelTag, typingTracker } = deps
  const readFile = deps.readFile ?? readAttachmentBuffer
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'slack-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    if (msg.sendOptions?.accounting === 'recovery') {
      if (!deps.token) return { ok: false, error: 'recovery-token-unavailable' }
      return sendBotRecovery('slack-bot', deps.token, msg, deps.fetchImpl)
    }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) {
      return { ok: false, error: 'message has neither text nor attachments' }
    }
    const invalidThread = invalidSlackThreadTs(msg.thread)
    if (invalidThread !== null) return { ok: false, error: invalidThread }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(
      `[slack-bot] outbound ${tag} text_len=${text.length} attachments=${attachments.length}${msg.thread ? ` thread=${msg.thread}` : ''}`,
    )

    if (attachments.length === 0) {
      const chunks = chunkMarkdown(text, SLACK_MARKDOWN_BLOCK_LIMIT)
      const explicitThread = msg.thread !== undefined && msg.thread !== null ? msg.thread : null
      let threadTs: string | null = explicitThread
      const sentTs: string[] = []
      try {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!
          const options: { thread_ts?: string; blocks?: unknown[]; unfurl_links?: boolean; unfurl_media?: boolean } = {
            blocks: [buildMarkdownBlock(chunk)],
          }
          if (threadTs !== null) options.thread_ts = threadTs
          if (msg.link_previews === false) {
            options.unfurl_links = false
            options.unfurl_media = false
          }
          const sent = await client.postMessage(msg.chat, chunk, options)
          sentTs.push(sent.ts)
          logger.info(
            `[slack-bot] sent ts=${sent.ts} ${tag} chunk=${i + 1}/${chunks.length} blocks=markdown len=${chunk.length}`,
          )
          // Anchor follow-up chunks to the first message so a long reply
          // surfaces as one threaded conversation rather than a stream of
          // top-level posts.
          if (threadTs === null && chunks.length > 1) threadTs = sent.ts
        }
        if (typingTracker) await typingTracker.clearAfterSend(msg.chat, msg.typingThread ?? msg.thread)
        return {
          ok: true,
          messageId: sentTs[0],
          messageIds: sentTs,
          reactionRef: encodeSlackReactionRef({ channel: msg.chat, ts: sentTs[0]! }),
        }
      } catch (err) {
        const message = describeError(err)
        logger.error(`[slack-bot] postMessage failed: ${message}`)
        return { ok: false, error: message }
      }
    }

    const threadTs = msg.thread !== undefined && msg.thread !== null ? msg.thread : undefined
    for (const [index, attachment] of attachments.entries()) {
      const filename = attachment.filename ?? attachment.path.split('/').pop() ?? 'file'
      let buffer: Buffer
      try {
        buffer = await readFile(attachment.path)
      } catch (err) {
        const message = describeError(err)
        logger.error(`[slack-bot] readFile failed for ${attachment.path}: ${message}`)
        return { ok: false, error: `readFile failed: ${message}` }
      }
      const isFirst = index === 0
      const uploadOptions: { thread_ts?: string; initial_comment?: string } = {}
      if (threadTs !== undefined) uploadOptions.thread_ts = threadTs
      // A file caption cannot carry a `markdown` block (files.uploadV2 has no
      // `blocks` param), so it is parsed as Slack mrkdwn. Convert the agent's
      // GFM (`**bold**`) to mrkdwn (`*bold*`) here — the text-only path above
      // relies on the native markdown block and needs no conversion.
      if (isFirst && text !== '') uploadOptions.initial_comment = toSlackMrkdwn(text)
      try {
        const file = await client.uploadFile(msg.chat, buffer, filename, uploadOptions)
        logger.info(`[slack-bot] uploaded id=${file.id} filename=${file.name} size=${file.size} ${tag}`)
      } catch (err) {
        const message = describeError(err)
        logger.error(`[slack-bot] uploadFile failed for ${attachment.path}: ${message}`)
        return { ok: false, error: `uploadFile failed: ${message}` }
      }
    }
    if (typingTracker) await typingTracker.clearAfterSend(msg.chat, msg.typingThread ?? msg.thread)
    return { ok: true }
  }
}

// Slack file URLs (`url_private`) require Bearer auth and an html-page is
// returned for unauthenticated GETs, so the agent cannot fetch them via a
// plain HTTP tool. Routing through the SDK's `downloadFile(fileId)` is
// the only path that works — it issues `files.info` to fetch metadata
// (mimetype + name) then GETs `url_private` with the bot token. The
// classifiers now keep the bare `Fxxxx` id in structured InboundAttachment.ref
// (legacy persisted state may still carry the old prompt-visible `id=` shape,
// which channel_fetch_attachment strips before reaching this callback).
export function createFetchAttachmentCallback(deps: {
  client: Pick<SlackBotClient, 'getFileInfo'>
  token: string
  fetchImpl?: SlackAttachmentFetch
  logger: SlackBotAdapterLogger
}): FetchAttachmentCallback {
  const { client, logger } = deps
  return async ({ ref, filename, maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES }) => {
    const fileId = ref.trim()
    if (!/^F[A-Z0-9]+$/.test(fileId)) {
      return { ok: false, error: `invalid Slack file id: ${ref}` }
    }
    try {
      const metadata = await client.getFileInfo(fileId)
      enforceAttachmentMetadataSize(metadata.size, maxBytes)
      const { buffer } = await downloadSlackAttachment({
        metadata,
        token: deps.token,
        maxBytes,
        fetchImpl: deps.fetchImpl,
      })
      logger.info(`[slack-bot] downloaded id=${fileId} name=${metadata.name} size=${buffer.length}`)
      return {
        ok: true,
        buffer,
        filename: filename ?? metadata.name,
        mimetype: metadata.mimetype,
        size: buffer.length,
      }
    } catch (err) {
      const message = describeError(err)
      logger.error(`[slack-bot] downloadFile failed for ${fileId}: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createSlackReferenceFetch(deps: {
  token: string
  fetchImpl: typeof fetch
  authorResolver?: SlackAuthorResolver
}) {
  return async (channelId: string, messageTs: string) => {
    const url = new URL('https://slack.com/api/conversations.replies')
    url.searchParams.set('channel', channelId)
    url.searchParams.set('ts', messageTs)
    url.searchParams.set('limit', '1')
    const response = await deps.fetchImpl(url, { headers: { Authorization: `Bearer ${deps.token}` } })
    if (!response.ok) return null
    const body = recordValue(await response.json())
    if (body === null || body.ok !== true) return null
    const messages = arrayField(body, 'messages')
    const first = recordValue(messages[0])
    if (first === null) return null
    const userId = stringField(first, 'user')
    const authorId = userId ?? stringField(first, 'bot_id')
    const text = stringField(first, 'text')
    if (authorId === null || text === null) return null
    const authorName =
      userId !== null && deps.authorResolver !== undefined ? await deps.authorResolver.resolve(userId) : authorId
    return { authorId, authorName, text }
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function arrayField(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function createSlackBotAdapter(options: SlackBotAdapterOptions): SlackBotAdapter {
  const logger = options.logger ?? consoleLogger
  const client = options.createClient?.() ?? new SlackBotClient()
  const fetchImpl = options.fetchImpl ?? fetch
  const recoveryCallbacks = createBotRecoveryCallbacks('slack-bot', options.token, fetchImpl, (workspace) =>
    botUserId !== null && teamId !== null && (workspace === undefined || workspace === '@dm' || workspace === teamId)
      ? `slack-bot:${teamId}:${botUserId}`
      : undefined,
  )
  let listener: SlackBotListener | null = null
  let botUserId: string | null = null
  let teamId: string | null = null
  let socketConnected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const authorResolver = createSlackAuthorResolver({ token: options.token })
  const channelResolver = createSlackChannelResolver({ token: options.token })

  // Slack mentions by id (`<@U…>`), so no username form. Read live off the
  // closure so a reconnect re-running auth.test stays reflected; one team
  // per token in practice, so `workspace` is ignored.
  const selfIdentityResolver: ChannelSelfIdentityResolver = () => (botUserId !== null ? { id: botUserId } : null)

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'slack-bot', workspace, chat, thread: null }).catch(
      () => ({}) as ResolvedChannelNames,
    )
    const workspacePart = workspace === '@dm' ? 'dm' : `team=${formatLabel(names.workspaceName, workspace)}`
    const chatPart = `channel=${formatLabel(names.chatName, chat, '#')}`
    return `${workspacePart} ${chatPart}`
  }

  const typingTracker = createSlackTypingTracker({ client, logger })

  const typingCallback = createTypingCallback({
    typingTracker,
    logger,
    formatChannelTag,
  })

  const historyCallback = createSlackHistoryCallback({
    token: options.token,
    logger,
    botUserIdRef: () => botUserId,
    authorResolver,
  })

  const messageGetCallback = createSlackMessageGetCallback({
    token: options.token,
    logger,
    botUserIdRef: () => botUserId,
    authorResolver,
  })

  const listCallback = createSlackListCallback({ token: options.token, logger })

  const membershipResolver = createSlackMembershipResolver({
    token: options.token,
    logger,
    historyCallback,
  })

  const outboundCallback = withOutboundAccount(
    createOutboundCallback({
      client,
      token: options.token,
      fetchImpl,
      logger,
      formatChannelTag,
      typingTracker,
    }),
    (workspace) => recoveryCallbacks.cachedAccountIdentity?.(workspace),
  )

  const fetchAttachmentCallback = createFetchAttachmentCallback({ client, logger, token: options.token })

  const reactionCallback = createSlackReactionCallback({ client })
  const removeReactionCallback = createSlackRemoveReactionCallback({ client })
  const ownReaction = createSlackOwnReactionCallbacks({
    client,
    identity: async () => {
      const self = await client.testAuth()
      return self.team_id && self.user_id ? `${self.team_id}:${self.user_id}` : null
    },
  })
  const editMessageCallback = createSlackEditMessageCallback({ token: options.token, fetchImpl })

  const dedupe = createSlackDedupe()

  const handleSlashCommand = createSlashCommandHandler({
    router: options.router,
    knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
    logger,
    formatChannelTag,
  })

  const handleThreadCommand = createThreadCommandHandler({
    router: options.router,
    knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
    logger,
    postReply: async ({ chat, thread, text }) => {
      const result = await outboundCallback({
        adapter: 'slack-bot',
        workspace: teamId ?? 'unknown',
        chat,
        ...(thread !== null ? { thread } : {}),
        text,
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
    },
  })

  // Gate raw edits before dedupe, commands and reference enrichment. `source`
  // is the listener that delivered the event: app_mention promotion rewrites
  // its type to 'message', so it cannot be recovered from the event itself.
  const handleMessageEvent = async (rawEvent: SlackInboundMessageEvent, source: SlackInboundSource): Promise<void> => {
    const inboundTeamId = teamId
    const inboundBotId = botUserId
    let admissionReservation: SlackDedupeReservation | undefined
    inflightInbounds++
    try {
      if (inboundTeamId === null) {
        logger.warn(`[slack-bot] dropped ts=${rawEvent.ts} reason=pre_connected (team_id unknown)`)
        return
      }

      // A rejected edit must not reach `!cmd` interception: edited control
      // text would otherwise execute without a fresh, original gesture.
      const admission = admitSlackInbound(rawEvent, inboundBotId, source)
      if (admission.kind === 'drop') {
        logger.info(`[slack-bot] dropped ts=${rawEvent.ts} reason=${admission.reason} (source=${source})`)
        return
      }
      const event = admission.event
      const text = event.text ?? ''
      const userId = event.user ?? 'unknown'
      const inboundWorkspace = event.channel_type === 'im' ? '@dm' : inboundTeamId
      const commandInput = {
        text,
        channel: event.channel,
        threadTs: event.thread_ts ?? null,
        isDm: event.channel_type === 'im',
        teamId: inboundTeamId,
        invokerId: userId,
      }
      if (admission.isEdit && parseThreadCommand(commandInput, SLACK_SLASH_COMMAND_NAMES).kind === 'parsed') {
        logger.info(`[slack-bot] dropped ts=${event.ts} reason=edited_control (source=${source})`)
        return
      }

      const verdict = classifyInbound(rawEvent, options.configRef(), {
        teamId: inboundTeamId,
        botUserId: inboundBotId,
        source,
        ...(options.selfAliasesRef ? { selfAliases: options.selfAliasesRef() } : {}),
      })
      const isBotMention = verdict.kind === 'route' && verdict.payload.isBotMention
      const dedupeMatch = dedupe.check(event, isBotMention)
      if (dedupeMatch !== null) {
        logger.info(
          `[slack-bot] dropped ts=${event.ts} reason=duplicate_delivery (source=${source}, matched=${dedupeMatch})`,
        )
        return
      }

      // Intercept `!cmd` before acting on the classifier verdict: commands are
      // control traffic, not agent messages. Retain self-author/userless floors.
      // The handler reserves synchronously before executing, and a consumed
      // command cannot later promote into a mention.
      if (event.user !== undefined && event.user !== '' && (inboundBotId === null || event.user !== inboundBotId)) {
        let commandReserved = false
        const reserve = (): boolean => {
          if (dedupe.check(event, isBotMention) !== null) return false
          dedupe.mark(event, true)
          commandReserved = true
          return true
        }
        const outcomePromise = handleThreadCommand(commandInput, reserve)
        // The handler reserves synchronously before its first await. Do not
        // await a non-command: regular delivery must reserve in this same tick.
        if (commandReserved) {
          await outcomePromise
          return
        }
      }

      if (verdict.kind === 'drop') {
        logger.info(`[slack-bot] dropped ts=${event.ts} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }

      admissionReservation = dedupe.reserve(event, isBotMention)
      const [resolvedUserName, inboundTag] = await Promise.all([
        event.user !== undefined && event.user !== '' ? authorResolver.resolve(event.user) : Promise.resolve(userId),
        formatChannelTag(inboundWorkspace, event.channel),
      ])
      logger.info(
        `[slack-bot] inbound source=${source} ts=${event.ts} user=${formatLabel(resolvedUserName, userId)} ${inboundTag} text_len=${text.length}`,
      )
      const hintedText = await addSlackMentionHints(verdict.payload.text, authorResolver.resolve, {
        botUserId: inboundBotId,
      })
      const slackAttachments = Array.isArray(event.attachments) ? event.attachments : undefined
      const referenceResult = await enrichSlackReferenceContext({
        text: hintedText,
        channelId: event.channel,
        messageTs: event.ts,
        ...(slackAttachments !== undefined ? { attachments: slackAttachments } : {}),
        fetchMessage: createSlackReferenceFetch({ token: options.token, fetchImpl, authorResolver }),
      })
      const enriched = {
        ...verdict.payload,
        text: hintedText,
        authorName: resolvedUserName,
        ...(referenceResult.referenceContext !== undefined
          ? { referenceContext: referenceResult.referenceContext }
          : {}),
      }
      const routedTag = await formatChannelTag(enriched.workspace, enriched.chat)
      logger.info(
        `[slack-bot] routed ts=${event.ts} ${routedTag} mention=${enriched.isBotMention} reply=${enriched.replyToBotMessageId !== null}`,
      )
      await options.router.route(enriched)
      admissionReservation.commit()
    } catch (err) {
      admissionReservation?.rollback()
      logger.error(`[slack-bot] handleInbound failed: ${describeError(err)}`)
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
        logger.error(`[slack-bot] login failed: ${describeError(err)}`)
        throw err
      }

      // auth.test resolves the bot's identity and team. We need both: teamId
      // becomes the `workspace` field on every inbound, and botUserId is how
      // we recognize self-authored messages and mentions. Failure here is
      // fatal — without these we can't classify anything correctly.
      try {
        const auth = await client.testAuth()
        botUserId = auth.user_id
        teamId = auth.team_id
        logger.info(`[slack-bot] authenticated as ${auth.user ?? auth.user_id} in team ${auth.team ?? auth.team_id}`)
      } catch (err) {
        started = false
        logger.error(`[slack-bot] auth.test failed: ${describeError(err)}`)
        throw err
      }

      listener =
        options.createListener?.(client, options.appToken) ??
        new SlackBotListener(client, { appToken: options.appToken })
      listener.on('connected', (info) => {
        socketConnected = started
        logger.info(`[slack-bot] connected (app_id=${info.app_id ?? 'unknown'})`)
      })
      listener.on('disconnected', () => {
        socketConnected = false
        logger.warn('[slack-bot] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        if (recordValue(err)?.code === 'disconnect_terminal') socketConnected = false
        logger.error(`[slack-bot] socket-mode error: ${describeError(err)}`)
      })
      listener.on('message', ({ ack, event }) => {
        // Ack first so Slack stops retrying; failure to ack causes duplicate
        // deliveries within seconds. Then process asynchronously.
        ack()
        // Cast at the SDK boundary: upstream types this event with a
        // `[key: string]: unknown` catchall for fields it does not
        // declare (parent_user_id, client_msg_id, files). The Slack
        // wire format does carry them as typed strings/arrays — see
        // SlackInboundMessageEvent's header comment in slack-bot-classify.
        void handleMessageEvent(event as SlackInboundMessageEvent, 'message')
      })
      // app_mention is required for mentions in channels where the bot is
      // NOT a member: in that case Slack does not fire a `message` event
      // (it requires `*:history` scope + membership), only `app_mention`
      // (which only requires `app_mentions:read`). The dedupe ring buffer
      // collapses the in-channel double-delivery when both events fire.
      listener.on('app_mention', ({ ack, event }) => {
        ack()
        void handleMessageEvent(promoteAppMentionToMessage(event as SlackInboundAppMentionEvent), 'app_mention')
      })
      listener.on('slash_commands', (args) => {
        // The handler owns the ack call itself (the ack payload carries the
        // user-visible reply text), so we do NOT ack here. inflightInbounds
        // wrapping mirrors handleMessageEvent so stop() can drain the
        // handler before tearing down the listener — otherwise a /stop
        // arriving during stop() would lose its ack and the user sees
        // "didn't respond in time" even though the abort succeeded.
        inflightInbounds++
        void handleSlashCommand(args).finally(() => {
          inflightInbounds--
          if (inflightInbounds === 0 && stopWaiters.length > 0) {
            const waiters = stopWaiters
            stopWaiters = []
            for (const w of waiters) w()
          }
        })
      })

      options.router.registerOutbound('slack-bot', outboundCallback)
      options.router.registerRecoveryAdapter('slack-bot', recoveryCallbacks)
      options.router.registerReaction('slack-bot', reactionCallback)
      options.router.registerRemoveReaction('slack-bot', removeReactionCallback)
      options.router.registerPrepareOwnReaction('slack-bot', ownReaction.prepare)
      options.router.registerRemoveOwnReaction('slack-bot', ownReaction.remove)
      options.router.registerTyping('slack-bot', typingCallback)
      options.router.setTypingCapability('slack-bot', true)
      options.router.registerChannelNameResolver('slack-bot', channelResolver)
      options.router.registerSelfIdentity('slack-bot', selfIdentityResolver)
      options.router.registerHistory('slack-bot', historyCallback)
      options.router.registerMessageGet('slack-bot', messageGetCallback)
      options.router.registerList('slack-bot', listCallback)
      options.router.registerEditMessage('slack-bot', editMessageCallback)
      options.router.registerFetchAttachment('slack-bot', fetchAttachmentCallback)
      options.router.registerMembership('slack-bot', membershipResolver)

      try {
        await listener.start()
      } catch (err) {
        // Listener failed after registration — roll back every callback so a
        // failed start leaves no router state behind (stop() returns early on
        // !started and would otherwise skip cleanup), mirroring the github
        // adapter's rollback path.
        options.router.unregisterOutbound('slack-bot', outboundCallback)
        options.router.unregisterRecoveryAdapter('slack-bot', recoveryCallbacks)
        options.router.unregisterReaction('slack-bot', reactionCallback)
        options.router.unregisterRemoveReaction('slack-bot', removeReactionCallback)
        options.router.unregisterPrepareOwnReaction('slack-bot', ownReaction.prepare)
        options.router.unregisterRemoveOwnReaction('slack-bot', ownReaction.remove)
        options.router.unregisterTyping('slack-bot', typingCallback)
        options.router.setTypingCapability('slack-bot', false)
        options.router.unregisterChannelNameResolver('slack-bot', channelResolver)
        options.router.unregisterSelfIdentity('slack-bot', selfIdentityResolver)
        options.router.unregisterHistory('slack-bot', historyCallback)
        options.router.unregisterMessageGet('slack-bot', messageGetCallback)
        options.router.unregisterList('slack-bot', listCallback)
        options.router.unregisterEditMessage('slack-bot', editMessageCallback)
        options.router.unregisterFetchAttachment('slack-bot', fetchAttachmentCallback)
        options.router.unregisterMembership('slack-bot', membershipResolver)
        listener = null
        botUserId = null
        teamId = null
        socketConnected = false
        started = false
        logger.error(`[slack-bot] listener start failed: ${describeError(err)}`)
        throw err
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      socketConnected = false
      options.router.unregisterOutbound('slack-bot', outboundCallback)
      options.router.unregisterReaction('slack-bot', reactionCallback)
      options.router.unregisterRemoveReaction('slack-bot', removeReactionCallback)
      options.router.unregisterPrepareOwnReaction('slack-bot', ownReaction.prepare)
      options.router.unregisterRemoveOwnReaction('slack-bot', ownReaction.remove)
      options.router.unregisterTyping('slack-bot', typingCallback)
      options.router.setTypingCapability('slack-bot', false)
      options.router.unregisterChannelNameResolver('slack-bot', channelResolver)
      options.router.unregisterSelfIdentity('slack-bot', selfIdentityResolver)
      options.router.unregisterHistory('slack-bot', historyCallback)
      options.router.unregisterRecoveryAdapter('slack-bot', recoveryCallbacks)
      options.router.unregisterMessageGet('slack-bot', messageGetCallback)
      options.router.unregisterList('slack-bot', listCallback)
      options.router.unregisterEditMessage('slack-bot', editMessageCallback)
      options.router.unregisterFetchAttachment('slack-bot', fetchAttachmentCallback)
      options.router.unregisterMembership('slack-bot', membershipResolver)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
      botUserId = null
      teamId = null
    },

    isConnected(): boolean {
      return started && socketConnected
    },
  }
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_text':
    case 'no_user':
    case 'pre_connect':
    case 'self_author':
    case 'slack_system_message':
    case 'unverified_edit':
    case 'edit_without_new_mention':
    case 'edited_control':
      return ''
  }
}
