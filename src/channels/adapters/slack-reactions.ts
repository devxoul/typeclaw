import type { SlackClient } from 'agent-messenger/slack'

import type {
  ReactionCallback,
  ReactionErrorCode,
  ReactionRef,
  ReactionResult,
  RemoveReactionCallback,
} from '@/channels/types'

import { describeError } from '../describe-error'
import { createOwnReactionCallbacks } from './own-reactions'

export type SlackReactionTarget = { channel: string; ts: string }
export type SlackReactionRemovalTarget = { channel: string; ts: string; emoji: string }

export function encodeSlackReactionRef(target: SlackReactionTarget): ReactionRef {
  return { adapter: 'slack', value: JSON.stringify(target) }
}

export function decodeSlackReactionRef(ref: ReactionRef): SlackReactionTarget | null {
  if (ref.adapter !== 'slack') return null
  const parsed = parseRecord(ref.value)
  if (parsed === null || parsed.op !== undefined) return null
  const channel = typeof parsed.channel === 'string' ? parsed.channel : null
  const ts = typeof parsed.ts === 'string' ? parsed.ts : null
  if (channel === null || ts === null) return null
  return { channel, ts }
}

export function encodeSlackRemovalRef(target: SlackReactionRemovalTarget): ReactionRef {
  return { adapter: 'slack', value: JSON.stringify({ op: 'remove', ...target }) }
}

export function decodeSlackRemovalRef(ref: ReactionRef): SlackReactionRemovalTarget | null {
  if (ref.adapter !== 'slack') return null
  const parsed = parseRecord(ref.value)
  if (parsed === null || parsed.op !== 'remove') return null
  const channel = typeof parsed.channel === 'string' ? parsed.channel : null
  const ts = typeof parsed.ts === 'string' ? parsed.ts : null
  const emoji = typeof parsed.emoji === 'string' ? parsed.emoji : null
  if (channel === null || ts === null || emoji === null) return null
  return { channel, ts, emoji }
}

export function createSlackReactionCallback(deps: { client: Pick<SlackClient, 'addReaction'> }): ReactionCallback {
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'slack') return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    const target = decodeSlackReactionRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable slack reaction ref', code: 'unsupported' }
    const emoji = normalizeEmoji(req.emoji)
    try {
      await deps.client.addReaction(target.channel, target.ts, emoji)
    } catch (err) {
      const code = slackErrorCode(err)
      if (code === 'already_reacted') return { ok: true, reactionRef: encodeSlackRemovalRef({ ...target, emoji }) }
      return { ok: false, error: describeError(err), code: classifySlackError(code) }
    }
    return { ok: true, reactionRef: encodeSlackRemovalRef({ ...target, emoji }) }
  }
}

export function createSlackRemoveReactionCallback(deps: {
  client: Pick<SlackClient, 'removeReaction'>
}): RemoveReactionCallback {
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'slack') return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    const target = decodeSlackRemovalRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable slack reaction removal ref', code: 'unsupported' }
    try {
      await deps.client.removeReaction(target.channel, target.ts, target.emoji)
    } catch (err) {
      const code = slackErrorCode(err)
      if (code === 'no_reaction') return { ok: true }
      return { ok: false, error: describeError(err), code: classifySlackError(code) }
    }
    return { ok: true }
  }
}

function normalizeEmoji(emoji: string): string {
  return emoji.replace(/^:|:$/g, '')
}

function slackErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
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
  client: Pick<SlackClient, 'removeReaction'>
  identity: () => string | null | Promise<string | null>
}) {
  return createOwnReactionCallbacks({
    adapter: 'slack',
    identity: deps.identity,
    decode: decodeSlackReactionRef,
    encode: encodeSlackReactionRef,
    emoji: normalizeEmoji,
    remove: (target, emoji) => deps.client.removeReaction(target.channel, target.ts, emoji),
    classify: (error) => classifySlackError(slackErrorCode(error)),
    absent: (error) => slackErrorCode(error) === 'no_reaction',
  })
}
