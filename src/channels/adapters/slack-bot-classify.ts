import type { SlackFile, SlackSocketModeAppMentionEvent, SlackSocketModeMessageEvent } from 'agent-messenger/slackbot'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

import { encodeSlackReactionRef } from './slack-bot-reactions'
import { hasSlackMessageShareAttachments } from './slack-bot-reference'
import { slackTsToMillis } from './slack-bot-time'
import { normalizeSlackInbound, slackInboundRevision } from './slack-inbound-revision'

export type SlackInboundMessageEvent = SlackSocketModeMessageEvent
export type SlackInboundAppMentionEvent = SlackSocketModeAppMentionEvent

export type InboundDropReason =
  | 'self_author' // event.user === botUserId; we never route our own messages back to ourselves
  | 'no_user' // event has no `user` field (e.g. system messages: channel_join, message_changed)
  | 'slack_system_message' // non-replyable Slack message subtype events (e.g. channel_topic)
  | 'empty_text' // event has neither text nor files — nothing for the agent to act on
  | 'pre_connect' // bot identity is not known yet, so mention/self/reply classification cannot be trusted

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type SlackInboundContext = {
  teamId: string
  botUserId: string | null
  // Lowered self-aliases (`alias` from typeclaw.json plus the implicit
  // basename(agentDir)). When a top-level message contains one of these
  // but no `<@bot>` mention, the classifier still anchors `thread` on
  // `event.ts` so the bot's reply lands in a thread under the user's
  // message instead of as a fragmented top-level post. Optional for
  // backward compatibility — omitted means "behave like before, no
  // alias-driven thread anchoring". The router's `computeSelfAliases`
  // is the source of truth; the adapter just forwards it.
  selfAliases?: readonly string[]
}

// All decision logic for "should this Socket Mode message event be routed to
// the agent?" lives here so it can be unit-tested in isolation. The adapter
// is left as a thin shell that handles SDK lifecycle and translates this
// verdict into log lines + router calls. Adding a new drop reason MUST extend
// InboundDropReason — there is no `default` log path, so the type system
// forces logging to stay exhaustive.
export function classifyInbound(
  event: SlackInboundMessageEvent,
  _config: ChannelAdapterConfig,
  context: SlackInboundContext,
): InboundClassification {
  event = normalizeSlackInbound(event)
  // Self-drop is the hard floor: never route our own messages back to
  // ourselves. The check requires `botUserId` (post-auth.test); before that,
  // fail closed below because mention, reply, and self classification all
  // depend on the bot identity.
  if (context.botUserId !== null && event.user === context.botUserId) {
    return { kind: 'drop', reason: 'self_author' }
  }
  if (event.user === undefined || event.user === '') {
    // System events (channel_join, message_changed, …) have no `user`;
    // they were also the ONLY way previously to flag bot_message subtype
    // events with no user. Now that we accept peer bots, a `bot_message`
    // subtype WITH a user (rare, but happens for legacy integrations) is
    // routed; subtype + no user still drops as `no_user`.
    return { kind: 'drop', reason: 'no_user' }
  }

  if (!isRouteableSlackMessageSubtype(event.subtype)) {
    return { kind: 'drop', reason: 'slack_system_message' }
  }

  const rawText = event.text ?? ''
  const { text, attachments } = splitInbound(event)
  const slackAttachments = Array.isArray(event.attachments) ? event.attachments : undefined
  if (text === '' && !hasSlackMessageShareAttachments(slackAttachments)) return { kind: 'drop', reason: 'empty_text' }

  const isDm = event.channel_type === 'im'
  const workspace = isDm ? '@dm' : context.teamId

  if (context.botUserId === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }

  // Mention parsing runs against the raw user-typed text only — the
  // appended `[Slack attachment #N: ...]` placeholder contains metadata
  // that must not be misread as mentions or group broadcasts.
  // Group mentions (`<!here>`, `<!channel>`, `<!everyone>`) are coerced to
  // direct mentions: the user fired a broadcast that explicitly includes the
  // bot, and from the engagement layer's perspective there is no meaningful
  // difference between "@bot, look at this" and "@channel, look at this" —
  // both are an invitation to participate. Treating them identically also
  // means the existing 'mention' trigger in typeclaw.json catches both
  // without any new config surface.
  const hasGroupMention = GROUP_MENTION_PATTERN.test(rawText)
  const isBotMention = hasGroupMention || rawText.includes(`<@${context.botUserId}>`)
  // Top-level alias addressing (e.g. "Momo!" / "@Momo" by name) is engagement-equivalent
  // to a `<@bot>` mention (see engagement.ts: alias is unconditional and
  // ranks alongside explicit triggers). Anchor `thread` on the inbound
  // ts in that case too, so the bot's reply threads under the user's
  // message rather than landing as a sibling top-level post. Mention
  // wins the OR short-circuit; alias matching only runs when no @ was
  // found, keeping the cost negligible in mention-heavy channels.
  const aliasMatched = !isBotMention && matchesAnyAlias(rawText, context.selfAliases ?? [])
  const thread = event.thread_ts ?? (!isDm && (isBotMention || aliasMatched) ? event.ts : null)
  // DMs stay flat (`thread` null), but Slack's typing status still needs a real
  // message ts; anchor it on the inbound so the indicator renders without
  // threading the reply. `assistant.threads.setStatus` accepts any live channel
  // message ts, confirmed against the API.
  const typingThread = isDm && thread === null ? event.ts : undefined

  // A reply is "to the bot" only when the thread parent was authored by the
  // bot. Slack surfaces the parent author via `parent_user_id` on every
  // reply event; without that match we don't know who authored the parent
  // and MUST NOT engage on the `reply` trigger — otherwise every threaded
  // reply between two humans (or two peer bots) wakes us up. The thread
  // root itself shares its ts with thread_ts and carries no parent_user_id.
  const isReply = event.thread_ts !== undefined && event.thread_ts !== event.ts
  const replyToBotMessageId =
    isReply && context.botUserId !== null && event.parent_user_id === context.botUserId ? event.thread_ts! : null

  const mentionedUserIds = extractMentionedUserIds(rawText)
  const mentionsOthers = mentionedUserIds.length > 0 && !mentionedUserIds.includes(context.botUserId)

  // Symmetric to `replyToBotMessageId` above: a reply whose parent author
  // is identifiable AND is not the bot is a reply-to-other. The engagement
  // layer uses this to suppress the solo-human fallback so the bot stays
  // quiet when two humans (or a peer bot and a human) hold a thread side-
  // conversation in a busy channel — the exact incident this fix addresses.
  const replyToOtherMessageId =
    isReply &&
    event.parent_user_id !== undefined &&
    event.parent_user_id !== '' &&
    event.parent_user_id !== context.botUserId
      ? event.thread_ts!
      : null

  // Slack signals "this message was authored by a bot" via either a non-empty
  // bot_id or subtype === 'bot_message'. Either is sufficient.
  const authorIsBot = (event.bot_id !== undefined && event.bot_id !== '') || event.subtype === 'bot_message'

  return {
    kind: 'route',
    payload: {
      adapter: 'slack-bot',
      workspace,
      chat: event.channel,
      thread,
      ...(thread !== null ? { room: { kind: 'thread' as const } } : {}),
      ...(typingThread !== undefined ? { typingThread } : {}),
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      externalMessageId: event.ts,
      accountIdentity: `slack-bot:${context.teamId}:${context.botUserId}`,
      eventKind: 'message',
      revision: slackInboundRevision(event),
      reactionRef: encodeSlackReactionRef({ channel: event.channel, ts: event.ts }),
      authorId: event.user,
      authorName: event.user,
      authorIsBot,
      isBotMention,
      replyToBotMessageId,
      mentionsOthers,
      replyToOtherMessageId,
      isDm,
      ts: slackTsToMillis(event.ts),
    },
  }
}

export function isRouteableSlackMessageSubtype(subtype: string | undefined): boolean {
  return subtype === undefined || subtype === 'bot_message' || subtype === 'file_share' || subtype === 'me_message'
}

// Slack encodes user mentions inline as `<@U…>` (or `<@W…>` for some org
// accounts, and `<@U…|fallback>` when the client supplied a label). Pull
// every distinct id out of the text — duplicates collapse so the caller
// can do a clean `includes()` check against the bot's own id.
const MENTION_PATTERN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

// Slack's group mention markup uses `!` (not `@`) and may carry an optional
// `|label` suffix, same as user mentions. We deliberately exclude the
// `<!subteam^ID>` form — engaging on every user-group ping would require
// knowing which subteams the bot is a member of, which is outside what
// Socket Mode events surface to us.
const GROUP_MENTION_PATTERN = /<!(?:here|channel|everyone)(?:\|[^>]*)?>/

function extractMentionedUserIds(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    seen.add(match[1]!)
  }
  return Array.from(seen)
}

type SplitInbound = { text: string; attachments: InboundAttachment[] }

function splitInbound(event: SlackInboundMessageEvent): SplitInbound {
  const rawText = event.text ?? ''
  const attachments = describeSlackMedia(event)
  if (attachments.length === 0) return { text: rawText, attachments: [] }
  const summary = attachments.map(renderPlaceholder).join('\n')
  const text = rawText === '' ? summary : `${rawText}\n${summary}`
  return { text, attachments }
}

function describeSlackMedia(event: SlackInboundMessageEvent): InboundAttachment[] {
  return (event.files ?? []).map((file, index) => describeSlackFile(file, index + 1))
}

export function describeSlackFile(file: SlackFile, id: number): InboundAttachment {
  return {
    id,
    kind: 'file',
    ref: file.id,
    filename: file.name,
    mimetype: file.mimetype,
  }
}

export function renderPlaceholder(attachment: InboundAttachment): string {
  const parts: string[] = [`Slack attachment #${attachment.id}: ${attachment.kind}`]
  if (attachment.mimetype !== undefined) parts.push(attachment.mimetype)
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  return `[${parts.join(' ')}]`
}
