import type { DiscordBotClient } from 'agent-messenger/discordbot'

import type {
  ReactionCallback,
  ReactionErrorCode,
  ReactionRef,
  ReactionResult,
  RemoveReactionCallback,
} from '@/channels/types'

import { describeError } from '../describe-error'
import { createOwnReactionCallbacks } from './own-reactions'

// The reactable target on Discord: a message is addressed by its channel id
// plus the message id. The classifier stamps this because both values are on
// the gateway event but `chat`/`externalMessageId` are the only ones that
// survive into the routed payload — keeping them paired in an opaque ref means
// the router/tool never have to reassemble Discord's addressing.
export type DiscordReactionTarget = { channel: string; message: string }

// `RemoveReactionRequest` carries no emoji (the router only round-trips the
// success ref), so removal needs the resolved unicode folded into the ref:
// Discord's DELETE is keyed by (channel, message, emoji). Mirrors Slack's
// removal-ref pattern; GitHub instead carries a per-reaction id.
export type DiscordReactionRemovalTarget = { channel: string; message: string; emoji: string }

export function encodeDiscordReactionRef(target: DiscordReactionTarget): ReactionRef {
  return { adapter: 'discord-bot', value: JSON.stringify(target) }
}

export function decodeDiscordReactionRef(ref: ReactionRef): DiscordReactionTarget | null {
  if (ref.adapter !== 'discord-bot') return null
  const parsed = parseRecord(ref.value)
  if (parsed === null || parsed.op !== undefined) return null
  const channel = typeof parsed.channel === 'string' ? parsed.channel : null
  const message = typeof parsed.message === 'string' ? parsed.message : null
  if (channel === null || message === null) return null
  return { channel, message }
}

export function encodeDiscordRemovalRef(target: DiscordReactionRemovalTarget): ReactionRef {
  return { adapter: 'discord-bot', value: JSON.stringify({ op: 'remove', ...target }) }
}

export function decodeDiscordRemovalRef(ref: ReactionRef): DiscordReactionRemovalTarget | null {
  if (ref.adapter !== 'discord-bot') return null
  const parsed = parseRecord(ref.value)
  if (parsed === null || parsed.op !== 'remove') return null
  const channel = typeof parsed.channel === 'string' ? parsed.channel : null
  const message = typeof parsed.message === 'string' ? parsed.message : null
  const emoji = typeof parsed.emoji === 'string' ? parsed.emoji : null
  if (channel === null || message === null || emoji === null) return null
  return { channel, message, emoji }
}

// Discord's reaction endpoint takes the literal unicode emoji (URL-encoded by
// the SDK), NOT a `:name:` shortcode — the agent passes adapter-generic bare
// names (`+1`, `rocket`), so we translate here. The set mirrors GitHub's fixed
// reaction vocabulary so the same `channel_react({ emoji })` call works on both
// platforms, plus a few extra chat-native acks. An unmapped name is reported as
// `unsupported` rather than forwarded, so a typo gets a clear signal instead of
// Discord's opaque `10014 Unknown Emoji`.
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

export function createDiscordReactionCallback(deps: {
  client: Pick<DiscordBotClient, 'addReaction'>
}): ReactionCallback {
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'discord-bot') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    }
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
  client: Pick<DiscordBotClient, 'removeReaction'>
}): RemoveReactionCallback {
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'discord-bot') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    }
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

// DiscordBotError exposes the Discord error code on `.code` as a string. We
// read it structurally so a wrapped/re-thrown error still classifies. The
// numeric codes are Discord's documented JSON error codes; `http_4xx` is the
// SDK's fallback when no JSON code is present.
function classifyDiscordError(err: unknown): ReactionErrorCode {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
  switch (code) {
    case '10003': // Unknown Channel
    case '10008': // Unknown Message
    case 'http_404':
      return 'not-found'
    case '50001': // Missing Access
    case '50013': // Missing Permissions
    case 'http_403':
    case 'http_401':
      return 'permission-denied'
    case '10014': // Unknown Emoji
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
  client: Pick<DiscordBotClient, 'removeReaction'>
  identity: () => string | null | Promise<string | null>
}) {
  return createOwnReactionCallbacks({
    adapter: 'discord-bot',
    identity: deps.identity,
    decode: decodeDiscordReactionRef,
    encode: encodeDiscordReactionRef,
    emoji: (emoji) => resolveEmoji(emoji) ?? (Object.values(EMOJI_UNICODE).includes(emoji) ? emoji : null),
    remove: (target, emoji) => deps.client.removeReaction(target.channel, target.message, emoji),
    classify: classifyDiscordError,
    absent: (error) => classifyDiscordError(error) === 'not-found',
  })
}
