import { describe, expect, test } from 'bun:test'

import {
  type ContinuationState,
  DEFAULT_CONTINUATION_LIMITS,
  decideContinuation,
  emptyContinuationState,
  hasRealProgress,
  hashIncomplete,
  parseContinuationState,
  type TurnOutcome,
} from './continuation-policy'
import type { Todo } from './store'

const STOP: TurnOutcome = { turnId: 't1', stopReason: 'stop', endedAt: 1000 }
const INCOMPLETE: Todo[] = [{ content: 'do the thing', status: 'pending' }]

let counter = 0
const newEpisodeId = () => `ep_${counter++}`

function baseState(overrides: Partial<ContinuationState> = {}): ContinuationState {
  return { ...emptyContinuationState(), lastTurnOutcome: STOP, ...overrides }
}

function decide(state: ContinuationState, todos: Todo[] = INCOMPLETE, now = 2000) {
  return decideContinuation({ state, todos, limits: DEFAULT_CONTINUATION_LIMITS, now, newEpisodeId })
}

describe('hashIncomplete', () => {
  test('is stable under reordering and whitespace churn', () => {
    const a: Todo[] = [
      { content: 'alpha', status: 'pending' },
      { content: 'beta', status: 'in_progress' },
    ]
    const b: Todo[] = [
      { content: 'beta', status: 'in_progress' },
      { content: '  alpha  ', status: 'pending' },
    ]
    expect(hashIncomplete(a)).toBe(hashIncomplete(b))
  })

  test('ignores completed/cancelled todos', () => {
    const a: Todo[] = [{ content: 'x', status: 'pending' }]
    const b: Todo[] = [
      { content: 'x', status: 'pending' },
      { content: 'done', status: 'completed' },
    ]
    expect(hashIncomplete(a)).toBe(hashIncomplete(b))
  })

  test('changes when incomplete content materially changes', () => {
    const a: Todo[] = [{ content: 'x', status: 'pending' }]
    const b: Todo[] = [{ content: 'y', status: 'pending' }]
    expect(hashIncomplete(a)).not.toBe(hashIncomplete(b))
  })
})

describe('hasRealProgress', () => {
  test('true only when the incomplete count shrinks', () => {
    const before: Todo[] = [
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'pending' },
    ]
    const fewer: Todo[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ]
    const reworded: Todo[] = [
      { content: 'a-renamed', status: 'pending' },
      { content: 'b', status: 'pending' },
    ]
    expect(hasRealProgress(before, fewer)).toBe(true)
    expect(hasRealProgress(before, reworded)).toBe(false)
  })
})

describe('parseContinuationState (fail-closed validation)', () => {
  test('round-trips a fully valid state', () => {
    const state: ContinuationState = {
      episode: {
        episodeId: 'e',
        startedAt: 1,
        autoTurnCount: 2,
        cumulativeTokens: 100,
        failureCount: 0,
        stagnationCount: 1,
        lastIncompleteHash: 'abc',
      },
      lastTurnOutcome: { turnId: 't', stopReason: 'stop', endedAt: 9 },
      suppressNextIdleNudgeReason: 'restart-kick',
      autoResumeBlockedUntilRealUserTurn: true,
      restartAbortPending: false,
    }
    expect(parseContinuationState(state)).toEqual(state)
  })

  test('non-object input falls back to empty', () => {
    expect(parseContinuationState(null)).toEqual(emptyContinuationState())
    expect(parseContinuationState('nope')).toEqual(emptyContinuationState())
  })

  test('a malformed episode with missing counters collapses to null (no ceiling bypass)', () => {
    const corrupt = { episode: { episodeId: 'e', startedAt: 1 }, lastTurnOutcome: null }
    expect(parseContinuationState(corrupt).episode).toBeNull()
  })

  test('an episode counter that is NaN collapses to null', () => {
    const corrupt = {
      episode: {
        episodeId: 'e',
        startedAt: 1,
        autoTurnCount: Number.NaN,
        cumulativeTokens: 0,
        failureCount: 0,
        stagnationCount: 0,
        lastIncompleteHash: null,
      },
    }
    expect(parseContinuationState(corrupt).episode).toBeNull()
  })

  test('an unknown stopReason collapses the outcome to null (idle then fails closed)', () => {
    const corrupt = { lastTurnOutcome: { turnId: 't', stopReason: 'bananas', endedAt: 1 } }
    expect(parseContinuationState(corrupt).lastTurnOutcome).toBeNull()
  })

  test('an unknown termination provenance is dropped and cannot authorize an abort', () => {
    const persisted = {
      lastTurnOutcome: {
        turnId: 't',
        stopReason: 'aborted',
        termination: 'something-else',
        endedAt: 1,
      },
    }
    const state = parseContinuationState(persisted)
    expect(state.lastTurnOutcome).toEqual({ turnId: 't', stopReason: 'aborted', endedAt: 1 })
    expect(decide(state)).toEqual({ kind: 'skip', reason: 'turn-not-safe' })
  })

  test('a length stopReason round-trips (budget truncation is continuation-eligible)', () => {
    const state = { lastTurnOutcome: { turnId: 't', stopReason: 'length', endedAt: 1 } }
    expect(parseContinuationState(state).lastTurnOutcome).toEqual({ turnId: 't', stopReason: 'length', endedAt: 1 })
  })

  test('an unknown suppressor value is dropped', () => {
    const corrupt = { suppressNextIdleNudgeReason: 'something-else' }
    expect(parseContinuationState(corrupt).suppressNextIdleNudgeReason).toBeNull()
  })
})

describe('decideContinuation', () => {
  test('injects on the happy path and opens an episode with autoTurnCount 1', () => {
    const d = decide(baseState())
    expect(d.kind).toBe('inject')
    if (d.kind === 'inject') {
      expect(d.episode.autoTurnCount).toBe(1)
      expect(d.episode.lastIncompleteHash).toBe(hashIncomplete(INCOMPLETE))
    }
  })

  test('skips when there are no incomplete todos', () => {
    const d = decide(baseState(), [{ content: 'done', status: 'completed' }])
    expect(d).toEqual({ kind: 'skip', reason: 'no-incomplete-todos' })
  })

  test('skips and is fail-closed when no turn outcome is recorded', () => {
    const d = decide(baseState({ lastTurnOutcome: null }))
    expect(d).toEqual({ kind: 'skip', reason: 'turn-not-safe' })
  })

  test('skips when the last turn was a user abort', () => {
    const d = decide(baseState({ lastTurnOutcome: { turnId: 't', stopReason: 'aborted', endedAt: 1 } }))
    expect(d).toEqual({ kind: 'skip', reason: 'turn-not-safe' })
  })

  test('injects only for an aborted turn trusted as a terminal channel reply', () => {
    const d = decide(
      baseState({
        lastTurnOutcome: {
          turnId: 't',
          stopReason: 'aborted',
          termination: 'terminal-after-channel-reply',
          endedAt: 1,
        },
      }),
    )
    expect(d.kind).toBe('inject')
  })

  test('trusts terminal channel-reply provenance independently of the transport stop reason', () => {
    const d = decide(
      baseState({
        lastTurnOutcome: {
          turnId: 't',
          stopReason: 'unknown',
          termination: 'terminal-after-channel-reply',
          endedAt: 1,
        },
      }),
    )
    expect(d.kind).toBe('inject')
  })

  test('injects after a length truncation (budget exhaustion is continuation-eligible)', () => {
    const d = decide(baseState({ lastTurnOutcome: { turnId: 't', stopReason: 'length', endedAt: 1 } }))
    expect(d.kind).toBe('inject')
  })

  test('skips after a failed final turn even with incomplete todos and budget left', () => {
    const episode = {
      episodeId: 'e',
      startedAt: 1500,
      autoTurnCount: 1,
      cumulativeTokens: 0,
      failureCount: 0,
      stagnationCount: 0,
      lastIncompleteHash: 'prev',
    }
    const d = decide(baseState({ lastTurnOutcome: { turnId: 't', stopReason: 'error', endedAt: 1 }, episode }))
    expect(d).toEqual({ kind: 'skip', reason: 'turn-not-safe' })
  })

  test('terminal channel-reply provenance does not authorize continuing a failed turn', () => {
    const d = decide(
      baseState({
        lastTurnOutcome: {
          turnId: 't',
          stopReason: 'error',
          termination: 'terminal-after-channel-reply',
          endedAt: 1,
        },
      }),
    )
    expect(d).toEqual({ kind: 'skip', reason: 'turn-not-safe' })
  })

  test('a failed turn blocks only that idle: a later successful outcome continues the same episode', () => {
    const episode = {
      episodeId: 'e',
      startedAt: 1500,
      autoTurnCount: 1,
      cumulativeTokens: 0,
      failureCount: 0,
      stagnationCount: 0,
      lastIncompleteHash: 'prev',
    }
    const failed = baseState({ lastTurnOutcome: { turnId: 't1', stopReason: 'error', endedAt: 1 }, episode })
    expect(decide(failed)).toEqual({ kind: 'skip', reason: 'turn-not-safe' })

    const recovered = { ...failed, lastTurnOutcome: { turnId: 't2', stopReason: 'stop', endedAt: 2 } as TurnOutcome }
    const d = decide(recovered)
    expect(d.kind).toBe('inject')
    if (d.kind === 'inject') {
      expect(d.episode.episodeId).toBe('e')
      expect(d.episode.autoTurnCount).toBe(2)
    }
  })

  test('skips while the user-abort durable suppressor is set', () => {
    const d = decide(baseState({ autoResumeBlockedUntilRealUserTurn: true }))
    expect(d).toEqual({ kind: 'skip', reason: 'user-abort-blocked' })
  })

  test('consumes the restart-kick one-shot and skips exactly that idle', () => {
    const d = decide(baseState({ suppressNextIdleNudgeReason: 'restart-kick' }))
    expect(d).toEqual({ kind: 'skip', reason: 'restart-kick-suppressed' })
  })

  test('skips at the max-auto-turns ceiling', () => {
    const state = baseState({
      episode: {
        episodeId: 'e',
        startedAt: 0,
        autoTurnCount: DEFAULT_CONTINUATION_LIMITS.maxAutoTurns,
        cumulativeTokens: 0,
        failureCount: 0,
        stagnationCount: 0,
        lastIncompleteHash: null,
      },
    })
    expect(decide(state)).toEqual({ kind: 'skip', reason: 'max-auto-turns' })
  })

  test('skips at the token ceiling', () => {
    const state = baseState({
      episode: {
        episodeId: 'e',
        startedAt: 0,
        autoTurnCount: 0,
        cumulativeTokens: DEFAULT_CONTINUATION_LIMITS.maxCumulativeTokens,
        failureCount: 0,
        stagnationCount: 0,
        lastIncompleteHash: null,
      },
    })
    expect(decide(state)).toEqual({ kind: 'skip', reason: 'max-tokens' })
  })

  test('accumulates the just-completed turn tokens into the episode', () => {
    const state = baseState({ lastTurnOutcome: { turnId: 't', stopReason: 'stop', endedAt: 1, tokens: 1234 } })
    const d = decide(state)
    expect(d.kind).toBe('inject')
    if (d.kind === 'inject') expect(d.episode.cumulativeTokens).toBe(1234)
  })

  test('token spend across turns crosses the ceiling and stops continuation', () => {
    const nearCeiling = DEFAULT_CONTINUATION_LIMITS.maxCumulativeTokens - 100
    const state = baseState({
      lastTurnOutcome: { turnId: 't', stopReason: 'stop', endedAt: 1, tokens: 200 },
      episode: {
        episodeId: 'e',
        startedAt: 1500,
        autoTurnCount: 1,
        cumulativeTokens: nearCeiling,
        failureCount: 0,
        stagnationCount: 0,
        lastIncompleteHash: 'prev',
      },
    })
    // nearCeiling + 200 >= maxCumulativeTokens → the folded spend trips the gate.
    expect(decide(state)).toEqual({ kind: 'skip', reason: 'max-tokens' })
  })

  test('skips at the wall-clock ceiling', () => {
    const state = baseState({
      episode: {
        episodeId: 'e',
        startedAt: 0,
        autoTurnCount: 0,
        cumulativeTokens: 0,
        failureCount: 0,
        stagnationCount: 0,
        lastIncompleteHash: null,
      },
    })
    const now = DEFAULT_CONTINUATION_LIMITS.maxWallClockMs + 1
    expect(decide(state, INCOMPLETE, now)).toEqual({ kind: 'skip', reason: 'max-wall-clock' })
  })

  test('stops on stagnation when the incomplete hash is unchanged across the limit', () => {
    const hash = hashIncomplete(INCOMPLETE)
    const state = baseState({
      episode: {
        episodeId: 'e',
        startedAt: 1500,
        autoTurnCount: 1,
        cumulativeTokens: 0,
        failureCount: 0,
        stagnationCount: DEFAULT_CONTINUATION_LIMITS.stagnationLimit - 1,
        lastIncompleteHash: hash,
      },
    })
    expect(decide(state)).toEqual({ kind: 'skip', reason: 'stagnation' })
  })

  test('does not count stagnation when the incomplete hash changed', () => {
    const state = baseState({
      episode: {
        episodeId: 'e',
        startedAt: 1500,
        autoTurnCount: 1,
        cumulativeTokens: 0,
        failureCount: 0,
        stagnationCount: DEFAULT_CONTINUATION_LIMITS.stagnationLimit - 1,
        lastIncompleteHash: 'a-different-hash',
      },
    })
    const d = decide(state)
    expect(d.kind).toBe('inject')
    if (d.kind === 'inject') expect(d.episode.stagnationCount).toBe(DEFAULT_CONTINUATION_LIMITS.stagnationLimit - 1)
  })
})
