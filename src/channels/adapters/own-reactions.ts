import type { AdapterId } from '@/channels/schema'
import type {
  PrepareOwnReactionCallback,
  ReactionErrorCode,
  ReactionRef,
  RemoveOwnReactionCallback,
  RemoveOwnReactionResult,
} from '@/channels/types'

import { describeError } from '../describe-error'

export function createOwnReactionCallbacks<T>(deps: {
  adapter: AdapterId
  identity: () => string | null | Promise<string | null>
  decode: (ref: ReactionRef) => T | null
  encode: (target: T) => ReactionRef
  emoji: (emoji: string) => string | null
  remove: (target: T, emoji: string) => Promise<unknown>
  classify: (error: unknown) => ReactionErrorCode
  absent: (error: unknown) => boolean
}): { prepare: PrepareOwnReactionCallback; remove: RemoveOwnReactionCallback } {
  return {
    prepare: async (req) => {
      if (req.adapter !== deps.adapter) return null
      const target = deps.decode(req.reactionRef)
      const emoji = deps.emoji(req.emoji)
      if (target === null || emoji === null || emoji === '') return null
      const accountIdentity = await deps.identity()
      return accountIdentity ? { accountIdentity, target: deps.encode(target), emoji } : null
    },
    remove: async (req): Promise<RemoveOwnReactionResult> => {
      if (req.adapter !== deps.adapter) return { ok: false, code: 'unsupported', error: 'wrong reaction adapter' }
      const target = deps.decode(req.target)
      const emoji = deps.emoji(req.emoji)
      if (target === null || emoji === null || emoji === '')
        return { ok: false, code: 'unsupported', error: 'invalid reaction target or emoji' }
      try {
        const identity = await deps.identity()
        if (!identity || identity !== req.expectedAccountIdentity)
          return { ok: false, code: 'identity', error: 'authenticated reaction account changed or unavailable' }
        await deps.remove(target, emoji)
        return { ok: true }
      } catch (error) {
        if (deps.absent(error)) return { ok: true }
        const code = deps.classify(error)
        const retryAfter =
          typeof error === 'object' && error !== null && 'retryAfter' in error && typeof error.retryAfter === 'number'
            ? error.retryAfter * 1000
            : undefined
        return {
          ok: false,
          code:
            code === 'permission-denied'
              ? 'permission'
              : code === 'rate-limited'
                ? 'rate-limit'
                : code === 'unsupported'
                  ? 'unsupported'
                  : 'transient',
          error: describeError(error),
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        }
      }
    },
  }
}
