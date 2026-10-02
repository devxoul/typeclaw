import type { DiscordClient } from 'agent-messenger/discord'

import type {
  ReactionCallback,
  ReactionErrorCode,
  ReactionRef,
  ReactionResult,
  RemoveReactionCallback,
} from '@/channels/types'

import { describeError } from '../describe-error'
import { createOwnReactionCallbacks } from './own-reactions'

export type DiscordReactionTarget = { channel: string; message: string }
export type DiscordReactionRemovalTarget = { channel: string; message: string; emoji: string }

export function encodeDiscordReactionRef(target: DiscordReactionTarget): ReactionRef {
  return { adapter: 'discord', value: JSON.stringify(target) }
}

export function decodeDiscordReactionRef(ref: ReactionRef): DiscordReactionTarget | null {
  if (ref.adapter !== 'discord') return null
  const parsed = parseRecord(ref.value)
  if (parsed === null || parsed.op !== undefined) return null
  const channel = typeof parsed.channel === 'string' ? parsed.channel : null
  const message = typeof parsed.message === 'string' ? parsed.message : null
  if (channel === null || message === null) return null
  return { channel, message }
}

export function encodeDiscordRemovalRef(target: DiscordReactionRemovalTarget): ReactionRef {
  return { adapter: 'discord', value: JSON.stringify({ op: 'remove', ...target }) }
}

export function decodeDiscordRemovalRef(ref: ReactionRef): DiscordReactionRemovalTarget | null {
  if (ref.adapter !== 'discord') return null
  const parsed = parseRecord(ref.value)
  if (parsed === null || parsed.op !== 'remove') return null
  const channel = typeof parsed.channel === 'string' ? parsed.channel : null
  const message = typeof parsed.message === 'string' ? parsed.message : null
  const emoji = typeof parsed.emoji === 'string' ? parsed.emoji : null
  if (channel === null || message === null || emoji === null) return null
  return { channel, message, emoji }
}

const EMOJI_UNICODE: Record<string, string> = {
  eyes: '👀',
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  laugh: '😄',
  hooray: '🎉',
  tada: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  white_check_mark: '✅',
  'white-check-mark': '✅',
  check: '✅',
  fire: '🔥',
  eye: '👁️',
  raised_hands: '🙌',
  zipper_mouth_face: '🤐',
  hourglass_flowing_sand: '⏳',
}

function resolveEmoji(emoji: string): string | null {
  const name = emoji.replace(/^:|:$/g, '')
  return EMOJI_UNICODE[name] ?? null
}

export function createDiscordReactionCallback(deps: { client: Pick<DiscordClient, 'addReaction'> }): ReactionCallback {
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'discord') return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    const unicode = resolveEmoji(req.emoji)
    if (unicode === null) {
      return { ok: false, error: `discord does not support reaction "${req.emoji}"`, code: 'unsupported' }
    }
    const target = decodeDiscordReactionRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable discord reaction ref', code: 'unsupported' }
    try {
      await deps.client.addReaction(target.channel, target.message, unicode)
    } catch (err) {
      return { ok: false, error: describeError(err), code: classifyDiscordError(err) }
    }
    return { ok: true, reactionRef: encodeDiscordRemovalRef({ ...target, emoji: unicode }) }
  }
}

export function createDiscordRemoveReactionCallback(deps: {
  client: Pick<DiscordClient, 'removeReaction'>
}): RemoveReactionCallback {
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'discord') return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    const target = decodeDiscordRemovalRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable discord reaction removal ref', code: 'unsupported' }
    try {
      await deps.client.removeReaction(target.channel, target.message, target.emoji)
    } catch (err) {
      return { ok: false, error: describeError(err), code: classifyDiscordError(err) }
    }
    return { ok: true }
  }
}

function classifyDiscordError(err: unknown): ReactionErrorCode {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
  switch (code) {
    case '10003':
    case '10008':
    case 'http_404':
      return 'not-found'
    case '50001':
    case '50013':
    case 'http_403':
    case 'http_401':
      return 'permission-denied'
    case '10014':
      return 'unsupported'
    case 'http_429':
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

export function createDiscordOwnReactionCallbacks(deps: {
  client: Pick<DiscordClient, 'removeReaction'>
  identity: () => string | null | Promise<string | null>
}) {
  return createOwnReactionCallbacks({
    adapter: 'discord',
    identity: deps.identity,
    decode: decodeDiscordReactionRef,
    encode: encodeDiscordReactionRef,
    emoji: (emoji) => resolveEmoji(emoji) ?? (Object.values(EMOJI_UNICODE).includes(emoji) ? emoji : null),
    remove: (target, emoji) => deps.client.removeReaction(target.channel, target.message, emoji),
    classify: classifyDiscordError,
    absent: (error) => classifyDiscordError(error) === 'not-found',
  })
}
