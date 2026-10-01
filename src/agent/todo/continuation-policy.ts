import { createHash } from 'node:crypto'

import { incompleteTodos, type Todo } from './store'

export const DEFAULT_MAX_AUTO_TURNS = 3
export const DEFAULT_MAX_CUMULATIVE_TOKENS = 25_000
export const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60_000
export const DEFAULT_STAGNATION_LIMIT = 2

export type ContinuationLimits = {
  maxAutoTurns: number
  maxCumulativeTokens: number
  maxWallClockMs: number
  stagnationLimit: number
}

export const DEFAULT_CONTINUATION_LIMITS: ContinuationLimits = {
  maxAutoTurns: DEFAULT_MAX_AUTO_TURNS,
  maxCumulativeTokens: DEFAULT_MAX_CUMULATIVE_TOKENS,
  maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
  stagnationLimit: DEFAULT_STAGNATION_LIMIT,
}

// A continuation episode is the unit a budget applies to. It opens when the
// first auto-nudge fires after a real user turn (or restart recovery) and
// resets only on the next REAL user prompt — never on the runtime's own
// injected prompts. Persisting it lets the budgets survive a restart so a
// crash-loop cannot reset the ceiling.
export type ContinuationEpisode = {
  episodeId: string
  startedAt: number
  autoTurnCount: number
  cumulativeTokens: number
  failureCount: number
  stagnationCount: number
  lastIncompleteHash: string | null
}

// The outcome of the most recently completed turn, recorded from the
// `message_end` subscription (authoritative) or a prompt `finally` fallback.
// `stopReason: 'unknown'` is the fail-closed value: an idle that sees it does
// not auto-inject. `'error'` also fails closed: the turn's final assistant
// message failed (provider error or runtime fault), and re-nudging it would
// only repeat the failed request. `'length'` is a budget truncation (the turn
// ran out of output tokens, often mid-thinking) — a legitimate unfinished turn
// that the continuation budget/stagnation guards are designed to bound, so it
// is continuation-eligible, NOT fail-closed.
export type TurnOutcome = {
  turnId: string
  stopReason: 'stop' | 'length' | 'aborted' | 'error' | 'unknown'
  // Trusted runtime provenance for the one intentional abort that is safe to
  // continue. Optional so older state files remain valid.
  termination?: 'terminal-after-channel-reply'
  endedAt: number
  // Total tokens the just-completed turn consumed (from the assistant
  // message's usage). Accumulated into the episode's cumulativeTokens so the
  // token ceiling reflects real spend. Optional for older state files and for
  // turns whose usage was unavailable; missing counts as 0.
  tokens?: number
}

export type ContinuationState = {
  episode: ContinuationEpisode | null
  lastTurnOutcome: TurnOutcome | null
  // One-shot suppressor: the restart kick prompt owns the first post-restart
  // idle, so the first idle after a restart consumes this and skips exactly
  // one injection.
  suppressNextIdleNudgeReason: 'restart-kick' | null
  // Durable user-abort suppressor (policy D1). Set when a turn ends via
  // explicit user abort; cleared only by the next real user turn. While set,
  // no auto-continuation fires regardless of episode budget.
  autoResumeBlockedUntilRealUserTurn: boolean
  // One-shot marker the graceful-restart shutdown sets per scope before it
  // aborts an in-flight turn. It tells onTurnOutcome that the imminent 'aborted'
  // outcome is a restart lifecycle transition, not a user stop, so the durable
  // D1 block above must NOT arm. Consumed on the next turn outcome so it never
  // masks a later genuine user abort.
  restartAbortPending: boolean
}

export function emptyContinuationState(): ContinuationState {
  return {
    episode: null,
    lastTurnOutcome: null,
    suppressNextIdleNudgeReason: null,
    autoResumeBlockedUntilRealUserTurn: false,
    restartAbortPending: false,
  }
}

const STOP_REASONS = new Set<TurnOutcome['stopReason']>(['stop', 'length', 'aborted', 'error', 'unknown'])

// Validate a persisted state object field-by-field and fail closed: any field
// that does not match the expected shape is dropped to its empty value rather
// than trusted. A partially-written file or a newer/older schema must never
// surface a malformed `episode` whose `undefined`/`NaN` counters would compare
// false against the ceilings and so bypass the token-burst guard. A malformed
// episode collapses to `null` (a fresh episode opens on the next decision); a
// malformed outcome collapses to `null` (the idle path then fails closed, not
// auto-injecting).
export function parseContinuationState(value: unknown): ContinuationState {
  if (typeof value !== 'object' || value === null) return emptyContinuationState()
  const v = value as Record<string, unknown>
  return {
    episode: parseEpisode(v.episode),
    lastTurnOutcome: parseOutcome(v.lastTurnOutcome),
    suppressNextIdleNudgeReason: v.suppressNextIdleNudgeReason === 'restart-kick' ? 'restart-kick' : null,
    autoResumeBlockedUntilRealUserTurn: v.autoResumeBlockedUntilRealUserTurn === true,
    restartAbortPending: v.restartAbortPending === true,
  }
}

function parseEpisode(value: unknown): ContinuationEpisode | null {
  if (typeof value !== 'object' || value === null) return null
  const e = value as Record<string, unknown>
  if (typeof e.episodeId !== 'string') return null
  if (!isFiniteNumber(e.startedAt)) return null
  if (!isFiniteNumber(e.autoTurnCount)) return null
  if (!isFiniteNumber(e.cumulativeTokens)) return null
  if (!isFiniteNumber(e.failureCount)) return null
  if (!isFiniteNumber(e.stagnationCount)) return null
  if (e.lastIncompleteHash !== null && typeof e.lastIncompleteHash !== 'string') return null
  return {
    episodeId: e.episodeId,
    startedAt: e.startedAt,
    autoTurnCount: e.autoTurnCount,
    cumulativeTokens: e.cumulativeTokens,
    failureCount: e.failureCount,
    stagnationCount: e.stagnationCount,
    lastIncompleteHash: e.lastIncompleteHash,
  }
}

function parseOutcome(value: unknown): TurnOutcome | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (typeof o.turnId !== 'string') return null
  if (typeof o.stopReason !== 'string' || !STOP_REASONS.has(o.stopReason as TurnOutcome['stopReason'])) return null
  if (!isFiniteNumber(o.endedAt)) return null
  return {
    turnId: o.turnId,
    stopReason: o.stopReason as TurnOutcome['stopReason'],
    endedAt: o.endedAt,
    ...(o.termination === 'terminal-after-channel-reply' ? { termination: o.termination } : {}),
    ...(isFiniteNumber(o.tokens) ? { tokens: o.tokens } : {}),
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// Canonical hash of the INCOMPLETE todos only. Normalization (sort by id or
// normalized text, collapse whitespace, include status) makes the hash stable
// under reordering and cosmetic edits so it is a usable stagnation heuristic.
// It is deliberately NOT used as proof of progress — see hasRealProgress.
export function hashIncomplete(todos: readonly Todo[]): string {
  const incomplete = incompleteTodos(todos)
  const canonical = incomplete
    .map((t) => ({
      id: t.id ?? '',
      status: t.status,
      content: t.content.trim().replace(/\s+/g, ' '),
    }))
    .sort((a, b) => {
      const ka = a.id !== '' ? a.id : a.content
      const kb = b.id !== '' ? b.id : b.content
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// "Real progress" is stricter than "the hash changed": the incomplete set must
// shrink. Text churn (reword/reorder/split) does not count, which is what
// closes the fake-progress loophole. Only a drop in the number of incomplete
// items resets the stagnation counter.
export function hasRealProgress(prev: readonly Todo[], next: readonly Todo[]): boolean {
  return incompleteTodos(next).length < incompleteTodos(prev).length
}

export type ContinuationDecision =
  | { kind: 'inject'; episode: ContinuationEpisode }
  | { kind: 'skip'; reason: ContinuationSkipReason }

export type ContinuationSkipReason =
  | 'no-incomplete-todos'
  | 'restart-kick-suppressed'
  | 'user-abort-blocked'
  | 'turn-not-safe'
  | 'max-auto-turns'
  | 'max-tokens'
  | 'max-wall-clock'
  | 'stagnation'

// Pure decision: given the current persisted state, the current todos, the
// last turn outcome, a fresh episode-id factory, and `now`, decide whether to
// inject a continuation and return the episode to persist. The caller is
// responsible for persisting `episode` from an `inject` result before actually
// injecting. Fails closed on every ambiguity.
export function decideContinuation(args: {
  state: ContinuationState
  todos: readonly Todo[]
  limits: ContinuationLimits
  now: number
  newEpisodeId: () => string
}): ContinuationDecision {
  const { state, todos, limits, now } = args

  if (incompleteTodos(todos).length === 0) return { kind: 'skip', reason: 'no-incomplete-todos' }

  if (state.suppressNextIdleNudgeReason === 'restart-kick') {
    return { kind: 'skip', reason: 'restart-kick-suppressed' }
  }

  if (state.autoResumeBlockedUntilRealUserTurn) return { kind: 'skip', reason: 'user-abort-blocked' }

  const outcome = state.lastTurnOutcome
  const isSafeTerminalReply = outcome?.termination === 'terminal-after-channel-reply'
  // A failed final turn never auto-continues, even with terminal-reply
  // provenance: that exception only vouches for an intentional abort after a
  // landed reply, not for a turn whose last LLM request failed. Retries the
  // turn already ran replace this outcome if they succeed, and the next real
  // user turn records a fresh outcome, so this only stops runtime self-nudges.
  if (
    outcome === null ||
    outcome.stopReason === 'error' ||
    (outcome.stopReason === 'unknown' && !isSafeTerminalReply) ||
    (outcome.stopReason === 'aborted' && !isSafeTerminalReply)
  ) {
    return { kind: 'skip', reason: 'turn-not-safe' }
  }

  const hash = hashIncomplete(todos)
  const base: ContinuationEpisode = state.episode ?? {
    episodeId: args.newEpisodeId(),
    startedAt: now,
    autoTurnCount: 0,
    cumulativeTokens: 0,
    failureCount: 0,
    stagnationCount: 0,
    lastIncompleteHash: null,
  }

  // Fold the just-completed turn's token spend into the episode BEFORE checking
  // the ceiling, so the budget reflects what the previous auto-turn actually
  // cost. `lastTurnOutcome.tokens` is the spend of the turn that drove this
  // idle; missing usage counts as 0.
  const episode: ContinuationEpisode = {
    ...base,
    cumulativeTokens: base.cumulativeTokens + (outcome.tokens ?? 0),
  }

  if (episode.autoTurnCount >= limits.maxAutoTurns) return { kind: 'skip', reason: 'max-auto-turns' }
  if (episode.cumulativeTokens >= limits.maxCumulativeTokens) return { kind: 'skip', reason: 'max-tokens' }
  if (now - episode.startedAt >= limits.maxWallClockMs) return { kind: 'skip', reason: 'max-wall-clock' }

  const stagnated = episode.lastIncompleteHash === hash
  const stagnationCount = stagnated ? episode.stagnationCount + 1 : episode.stagnationCount
  if (stagnationCount >= limits.stagnationLimit) return { kind: 'skip', reason: 'stagnation' }

  return {
    kind: 'inject',
    episode: {
      ...episode,
      autoTurnCount: episode.autoTurnCount + 1,
      stagnationCount,
      lastIncompleteHash: hash,
    },
  }
}
