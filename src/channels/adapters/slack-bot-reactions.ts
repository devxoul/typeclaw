import type { SlackBotClient } from 'agent-messenger/slackbot'

import type {
  ReactionCallback,
  ReactionErrorCode,
  ReactionRef,
  ReactionResult,
  RemoveReactionCallback,
} from '@/channels/types'

import { describeError } from '../describe-error'
import { createOwnReactionCallbacks } from './own-reactions'

// The reactable target on Slack: a message is addressed by its channel id plus
// the message `ts`. The classifier stamps this because `ts` is the inbound's
// own message timestamp — the same value that becomes `externalMessageId`
// downstream, but kept in an opaque ref so the router/tool never have to know
// Slack's addressing. Mirrors the GitHub `GithubReactionTarget` precedent.
export type SlackReactionTarget = { channel: string; ts: string }

// Removal needs the emoji name too: Slack's `reactions.remove` is keyed by
// (channel, ts, name), unlike GitHub's per-reaction id. We fold the emoji that
// was added into the removal ref so `RemoveReactionCallback` can reconstruct
// the exact call without the caller tracking it.
export type SlackReactionRemovalTarget = { channel: string; ts: string; emoji: string }

export function encodeSlackReactionRef(target: SlackReactionTarget): ReactionRef {
  return { adapter: 'slack-bot', value: JSON.stringify(target) }
}

export function decodeSlackReactionRef(ref: ReactionRef): SlackReactionTarget | null {
  if (ref.adapter !== 'slack-bot') return null
  const parsed = parseRecord(ref.value)
  if (parsed === null) return null
  if (parsed.op !== undefined) return null
  const channel = typeof parsed.channel === 'string' ? parsed.channel : null
  const ts = typeof parsed.ts === 'string' ? parsed.ts : null
  if (channel === null || ts === null) return null
  return { channel, ts }
}

export function encodeSlackRemovalRef(target: SlackReactionRemovalTarget): ReactionRef {
  return { adapter: 'slack-bot', value: JSON.stringify({ op: 'remove', ...target }) }
}

export function decodeSlackRemovalRef(ref: ReactionRef): SlackReactionRemovalTarget | null {
  if (ref.adapter !== 'slack-bot') return null
  const parsed = parseRecord(ref.value)
  if (parsed === null || parsed.op !== 'remove') return null
  const channel = typeof parsed.channel === 'string' ? parsed.channel : null
  const ts = typeof parsed.ts === 'string' ? parsed.ts : null
  const emoji = typeof parsed.emoji === 'string' ? parsed.emoji : null
  if (channel === null || ts === null || emoji === null) return null
  return { channel, ts, emoji }
}

// Slack accepts any custom-emoji name the workspace has, so unlike GitHub there
// is no fixed allow-list to validate against up front — an unknown name comes
// back as `invalid_name` from the API, which we map to `unsupported`. We only
// strip surrounding colons here; the SDK does the same, but normalizing first
// keeps the removal ref's stored name canonical.
function normalizeEmoji(emoji: string): string {
  return emoji.replace(/^:|:$/g, '')
}

export function createSlackReactionCallback(deps: { client: Pick<SlackBotClient, 'addReaction'> }): ReactionCallback {
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'slack-bot') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    }
    const target = decodeSlackReactionRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable slack reaction ref', code: 'unsupported' }
    const emoji = normalizeEmoji(req.emoji)
    try {
      await deps.client.addReaction(target.channel, target.ts, emoji)
    } catch (err) {
      // `already_reacted` is the desired end state, not a failure: a duplicate
      // engage (or a retried tool call) that re-adds the same emoji must read
      // as success so the model/runtime don't surface a spurious error.
      const code = slackErrorCode(err)
      if (code === 'already_reacted') {
        return { ok: true, reactionRef: encodeSlackRemovalRef({ ...target, emoji }) }
      }
      return { ok: false, error: withScopeHint(code, describeError(err)), code: classifySlackError(code) }
    }
    return { ok: true, reactionRef: encodeSlackRemovalRef({ ...target, emoji }) }
  }
}

export function createSlackRemoveReactionCallback(deps: {
  client: Pick<SlackBotClient, 'removeReaction'>
}): RemoveReactionCallback {
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'slack-bot') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    }
    const target = decodeSlackRemovalRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable slack reaction removal ref', code: 'unsupported' }
    try {
      await deps.client.removeReaction(target.channel, target.ts, target.emoji)
    } catch (err) {
      // `no_reaction` means the reaction is already gone — the desired end
      // state for a removal, so treat it as success (idempotent), mirroring the
      // `already_reacted` handling on the add path.
      const code = slackErrorCode(err)
      if (code === 'no_reaction') return { ok: true }
      return { ok: false, error: describeError(err), code: classifySlackError(code) }
    }
    return { ok: true }
  }
}

// SlackBotError carries the raw Slack API error string on `.code`. We read it
// structurally (not by instanceof) so a re-thrown or wrapped error still maps
// correctly, falling back to the message when no code is present.
function slackErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

// `reactions:write` is the scope the bot token needs for both add and remove.
// On `missing_scope` the bare Slack error is uninformative, so append the
// concrete operator fix — mirroring GitHub's permission-guidance precedent —
// since autoReactOnEngage surfaces this to host logs on every engaged inbound
// until the scope is granted.
function withScopeHint(code: string | null, error: string): string {
  if (code !== 'missing_scope') return error
  return `${error} (Slack bot token needs the \`reactions:write\` scope; reinstall/reauthorize the app with that scope.)`
}

function classifySlackError(code: string | null): ReactionErrorCode {
  switch (code) {
    case 'invalid_name':
    case 'no_item_specified':
      return 'unsupported'
    case 'missing_scope':
    case 'not_in_channel':
    case 'is_archived':
    case 'not_authed':
    case 'invalid_auth':
      return 'permission-denied'
    case 'message_not_found':
    case 'channel_not_found':
      return 'not-found'
    case 'ratelimited':
    case 'rate_limited':
    case 'slack_webapi_rate_limited_error':
      return 'rate-limited'
    default:
      return 'transient'
  }
}

function parseRecord(value: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

export function createSlackOwnReactionCallbacks(deps: {
  client: Pick<SlackBotClient, 'removeReaction'>
  identity: () => string | null | Promise<string | null>
}) {
  return createOwnReactionCallbacks({
    adapter: 'slack-bot',
    identity: deps.identity,
    decode: decodeSlackReactionRef,
    encode: encodeSlackReactionRef,
    emoji: normalizeEmoji,
    remove: (target, emoji) => deps.client.removeReaction(target.channel, target.ts, emoji),
    classify: (error) => classifySlackError(slackErrorCode(error)),
    absent: (error) => slackErrorCode(error) === 'no_reaction',
  })
}
