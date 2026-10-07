import type { SlackFile, SlackRTMMessageEvent } from 'agent-messenger/slack'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

import { slackTsToMillis } from './slack-bot-time'
import { encodeSlackReactionRef } from './slack-reactions'

export type SlackInboundMessageEvent = SlackRTMMessageEvent & {
  channel_type?: string
  // Modern RTM file messages are subtype-less but retain the `files` array.
  files?: SlackFile[]
  is_mpim?: boolean
  // `message_changed` envelopes carry the edited message and its previous body;
  // admitSlackInbound validates both before anything reads them.
  message?: unknown
  previous_message?: unknown
}

export type SlackConversationType = 'im' | 'mpim' | 'channel'

export type InboundDropReason =
  | 'self_author'
  | 'no_user'
  | 'slack_system_message'
  | 'empty_text'
  | 'pre_connect'
  | 'unverified_edit'
  | 'edit_without_new_mention'
  | 'edited_control'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type SlackInboundContext = {
  teamId: string
  selfUserId: string | null
  selfAliases?: readonly string[]
  conversationType?: SlackConversationType
}

import { addressesSlackSelf, admitSlackInbound } from './slack-inbound-revision'

export function classifyInbound(
  event: SlackInboundMessageEvent,
  _config: ChannelAdapterConfig,
  context: SlackInboundContext,
): InboundClassification {
  // Edits are gated on the raw envelope before normalization drops its subtype.
  // RTM has no app_mention stream, so every user-session delivery is a 'message'.
  const admission = admitSlackInbound(event, context.selfUserId)
  if (admission.kind === 'drop') return { kind: 'drop', reason: admission.reason }
  event = admission.event
  if (context.selfUserId !== null && event.user === context.selfUserId) return { kind: 'drop', reason: 'self_author' }
  if (event.user === undefined || event.user === '') return { kind: 'drop', reason: 'no_user' }
  if (!isRouteableSlackMessageSubtype(event.subtype)) return { kind: 'drop', reason: 'slack_system_message' }
  const rawText = event.text ?? ''
  const { text, attachments } = splitSlackFiles(rawText, event.files)
  if (text === '') return { kind: 'drop', reason: 'empty_text' }
  if (context.selfUserId === null) return { kind: 'drop', reason: 'pre_connect' }

  const conversationType = classifyConversation(event, context.conversationType)
  const isDm = conversationType === 'im'
  const workspace = isDm ? '@dm' : context.teamId
  const isBotMention = addressesSlackSelf(rawText, context.selfUserId)
  const aliasMatched = !isBotMention && matchesAnyAlias(rawText, context.selfAliases ?? [])
  const thread = event.thread_ts ?? (!isDm && (isBotMention || aliasMatched) ? event.ts : null)
  const mentionedUserIds = extractMentionedUserIds(rawText)
  const mentionsOthers = mentionedUserIds.length > 0 && !mentionedUserIds.includes(context.selfUserId)

  return {
    kind: 'route',
    payload: {
      adapter: 'slack',
      workspace,
      chat: event.channel,
      thread,
      ...(thread !== null ? { room: { kind: 'thread' as const } } : {}),
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      externalMessageId: event.ts,
      accountIdentity: `slack:${context.teamId}:${context.selfUserId}`,
      eventKind: 'message',
      // One engagement per Slack message: edits never mint a new revision.
      revision: 'original',
      reactionRef: encodeSlackReactionRef({ channel: event.channel, ts: event.ts }),
      authorId: event.user,
      authorName: event.user,
      authorIsBot: false,
      isBotMention,
      // RTM user-session replies do not include parent_user_id; a pure classifier
      // cannot prove parent authorship without an async Slack lookup.
      replyToBotMessageId: null,
      mentionsOthers,
      replyToOtherMessageId: null,
      isDm,
      ts: slackTsToMillis(event.ts),
    },
  }
}

function classifyConversation(
  event: SlackInboundMessageEvent,
  resolvedType: SlackConversationType | undefined,
): SlackConversationType {
  if (event.channel_type === 'im' || event.channel_type === 'mpim' || event.channel_type === 'channel') {
    return event.channel_type
  }
  if (event.is_mpim === true) return 'mpim'
  if (resolvedType !== undefined) return resolvedType
  return event.channel.startsWith('D') ? 'im' : 'channel'
}

export function isRouteableSlackMessageSubtype(subtype: string | undefined): boolean {
  return subtype === undefined || subtype === 'me_message'
}

// Live inbound and REST history share the same attachment rendering contract.
// Registering the ref
// without also baking a `#N` placeholder into the text is not enough: the
// agent has no way to learn the id exists, so look_at_channel_attachment stays
// unreachable in practice.
export function splitSlackFiles(text: string, files: readonly SlackFile[] | undefined): SplitSlackFiles {
  const attachments = (files ?? []).map(describeSlackFile)
  if (attachments.length === 0) return { text, attachments: [] }
  const summary = attachments.map(renderPlaceholder).join('\n')
  return { text: text === '' ? summary : `${text}\n${summary}`, attachments }
}

type SplitSlackFiles = { text: string; attachments: InboundAttachment[] }

function describeSlackFile(file: SlackFile, index: number): InboundAttachment {
  return {
    id: index + 1,
    kind: 'file',
    ref: file.id,
    filename: file.name,
    mimetype: file.mimetype,
  }
}

function renderPlaceholder(attachment: InboundAttachment): string {
  const parts: string[] = [`Slack attachment #${attachment.id}: ${attachment.kind}`]
  if (attachment.mimetype !== undefined) parts.push(attachment.mimetype)
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  return `[${parts.join(' ')}]`
}

const MENTION_PATTERN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

function extractMentionedUserIds(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    seen.add(match[1]!)
  }
  return Array.from(seen)
}
