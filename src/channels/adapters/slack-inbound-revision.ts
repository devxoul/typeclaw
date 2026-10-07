import { parseCommand } from '@/commands'
import { extractClaimCode } from '@/role-claim/code'

// Slack engages at most once per message. Every admitted delivery keeps the
// original message ts as its identity and revision 'original'; the inbound
// journal's per-message latch rejects any later delivery of a message it has
// already admitted, whatever its revision or routing thread. This gate decides
// only whether an edit may be treated as a first engagement at all:
//
// - A raw `message_changed` envelope must prove a fresh explicit address: the
//   previous body has no self/group mention and the new body has one. Typo
//   fixes, unchanged or removed mentions and unfurl/metadata updates drop.
// - An `app_mention` carrying a valid `edited` marker may engage without the
//   previous body when it explicitly addresses this account. That is a
//   first-engagement fallback, not proof the edit added the mention.
// - A flattened `message` carrying `edited` cannot prove anything and drops.
// - An edit is never control traffic: known slash commands and claim codes in
//   an edit-derived delivery drop before any handler sees them. An app_mention
//   without `edited` is indistinguishable from an original and stays on the
//   original path, so this guarantee covers known edits only.
//
// The decision is stateless so a cold dedupe cache or a restart cannot widen it.

export type SlackInboundSource = 'message' | 'app_mention'

export type SlackEditDropReason = 'pre_connect' | 'unverified_edit' | 'edit_without_new_mention' | 'edited_control'

export type SlackInboundAdmission<T> =
  | { kind: 'admit'; event: T; isEdit: boolean }
  | { kind: 'drop'; reason: SlackEditDropReason }

const SLACK_TS_PATTERN = /^\d+\.\d+$/

// Slack's group mention markup uses `!` (not `@`) and may carry an optional
// `|label` suffix. `<!subteam^ID>` is deliberately excluded: engaging on every
// user-group ping would require knowing the account's subteam membership.
const GROUP_MENTION_PATTERN = /<!(?:here|channel|everyone)(?:\|[^>]*)?>/

// Group broadcasts address everyone present, including this account, so they
// count as an explicit mention alongside `<@self>`.
export function addressesSlackSelf(text: string, selfUserId: string): boolean {
  return GROUP_MENTION_PATTERN.test(text) || text.includes(`<@${selfUserId}>`)
}

export function admitSlackInbound<T extends { subtype?: string; channel: string; ts: string }>(
  event: T,
  selfUserId: string | null,
  source: SlackInboundSource = 'message',
): SlackInboundAdmission<T> {
  if (event.subtype === 'message_changed') return admitRawEdit(event, selfUserId)
  if (!('edited' in event) || event.edited === undefined) return { kind: 'admit', event, isEdit: false }
  if (source !== 'app_mention' || !validEditRevision(recordOf(event.edited)?.ts, event.ts))
    return { kind: 'drop', reason: 'unverified_edit' }
  if (selfUserId === null) return { kind: 'drop', reason: 'pre_connect' }
  const text = 'text' in event && typeof event.text === 'string' ? event.text : ''
  if (!addressesSlackSelf(text, selfUserId)) return { kind: 'drop', reason: 'edit_without_new_mention' }
  return admitEdit(event, text)
}

function admitRawEdit<T extends { channel: string; ts: string }>(
  event: T,
  selfUserId: string | null,
): SlackInboundAdmission<T> {
  const message = 'message' in event ? recordOf(event.message) : null
  const previous = 'previous_message' in event ? recordOf(event.previous_message) : null
  if (message === null || previous === null) return { kind: 'drop', reason: 'unverified_edit' }
  const { ts, text } = message
  if (
    typeof ts !== 'string' ||
    typeof text !== 'string' ||
    typeof previous.text !== 'string' ||
    previous.ts !== ts ||
    !validEditRevision(recordOf(message.edited)?.ts, ts)
  )
    return { kind: 'drop', reason: 'unverified_edit' }
  if (selfUserId === null) return { kind: 'drop', reason: 'pre_connect' }
  if (addressesSlackSelf(previous.text, selfUserId) || !addressesSlackSelf(text, selfUserId))
    return { kind: 'drop', reason: 'edit_without_new_mention' }
  const subtype = typeof message.subtype === 'string' ? message.subtype : undefined
  // Keep the original message ts as the replyable identity, not the envelope ts.
  return admitEdit({ ...event, ...message, channel: event.channel, ts, subtype }, text)
}

function admitEdit<T>(event: T, text: string): SlackInboundAdmission<T> {
  if (parseCommand(text) !== null || extractClaimCode(text) !== null) return { kind: 'drop', reason: 'edited_control' }
  return { kind: 'admit', event, isEdit: true }
}

// A real edit marker is a Slack ts distinct from the message's own ts.
function validEditRevision(revision: unknown, messageTs: string): boolean {
  return typeof revision === 'string' && SLACK_TS_PATTERN.test(revision) && revision !== messageTs
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}
