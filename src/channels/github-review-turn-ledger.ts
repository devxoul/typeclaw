// In-process record of REAL github review actions performed during the current
// turn, shared across two plugin boundaries: github-cli-auth records a formal
// review / thread-resolve here after the `gh` command SUCCEEDS, and channel-reply
// consults it before sending a verdict/close-out reply. If the agent claims a
// verdict in prose but this ledger shows no matching action this turn, the reply
// is a false receipt (see channel-reply.ts). State is per-session and reset at
// turn start, so a claim must be backed by an action in the SAME turn.

import type { BackgroundObligationRef } from './background-obligations'
import type { InboundRef } from './inbound-journal'

export type ReviewResultCoverage = {
  inboundCoverage?: InboundRef[]
  backgroundCoverage?: BackgroundObligationRef[]
  expectedAccountIdentity?: string
}

let reviewCoverageCapture: ((sessionId: string) => Promise<ReviewResultCoverage>) | null = null

export function setReviewCoverageCapture(capture: typeof reviewCoverageCapture): void {
  reviewCoverageCapture = capture
}

export async function captureReviewResultCoverage(sessionId: string): Promise<ReviewResultCoverage> {
  const coverage = await reviewCoverageCapture?.(sessionId)
  return {
    inboundCoverage: coverage?.inboundCoverage?.map((ref) => ({ ...ref })) ?? [],
    backgroundCoverage: coverage?.backgroundCoverage?.map((ref) => ({ ...ref })) ?? [],
    ...(coverage?.expectedAccountIdentity !== undefined
      ? { expectedAccountIdentity: coverage.expectedAccountIdentity }
      : {}),
  }
}

export type ReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES'
export type ReviewRoundOutcome = ReviewVerdict | 'DISMISSED'

export type ReviewObserver = (args: {
  sessionId: string
  workspace: string
  prNumber: number
  verdict: ReviewRoundOutcome
  // The commit the landed review is attached to, when the publisher knows it.
  commitSha?: string
}) => void

// A formal review LANDED this turn, of ANY state — the two decisive verdicts PLUS
// a non-decisive COMMENT. This signal ONLY tells the channel router "the agent
// already delivered output via the GitHub review API this turn" so an empty
// completion afterward doesn't fire the empty-turn fallback. It is deliberately
// NOT stored in the false-receipt ledger (`reviewsByPr`): a COMMENT carries no
// verdict-claim risk and must never satisfy `hasReview()`.
export type ReviewOutputState = ReviewVerdict | 'COMMENT'

export type ReviewOutputObserver = (
  args: {
    sessionId: string
    workspace: string
    prNumber: number
    state: ReviewOutputState
  } & ReviewResultCoverage,
) => void | Promise<void>

type PrKey = string
type ThreadKey = string

const reviewsByPr = new Map<PrKey, Set<ReviewVerdict>>()
const resolvedThreads = new Set<ThreadKey>()

// A single process-wide observer notified AFTER a verdict is recorded, so the
// run-side wiring can fan a landed verdict out over the broadcast bus to sibling
// PR sessions (see github-verdict-activity.ts) WITHOUT giving the github-cli-auth
// plugin stream access. Registered once at boot from run/index.ts. The ledger
// stays the single seam where "a formal verdict happened" is known across the
// plugin/channels boundary, which is why it owns this hook.
let reviewObserver: ReviewObserver | null = null
let reviewOutputObserver: ReviewOutputObserver | null = null

export function setReviewObserver(observer: ReviewObserver | null): void {
  reviewObserver = observer
}

export function setReviewOutputObserver(observer: ReviewOutputObserver | null): void {
  reviewOutputObserver = observer
}

export function __resetReviewObserverForTest(): void {
  reviewObserver = null
  reviewOutputObserver = null
  reviewCoverageCapture = null
}

function prKey(sessionId: string, workspace: string, prNumber: number): PrKey {
  return `${sessionId}::${workspace}::${prNumber}`
}

function threadKey(sessionId: string, workspace: string, prNumber: number, rootCommentId: string): ThreadKey {
  return `${sessionId}::${workspace}::${prNumber}::${rootCommentId}`
}

export function resetReviewTurn(sessionId: string): void {
  for (const key of reviewsByPr.keys()) {
    if (key.startsWith(`${sessionId}::`)) reviewsByPr.delete(key)
  }
  for (const key of resolvedThreads) {
    if (key.startsWith(`${sessionId}::`)) resolvedThreads.delete(key)
  }
}

export async function recordReview(
  args: {
    sessionId: string
    workspace: string
    prNumber: number
    verdict: ReviewVerdict
    commitSha?: string
  } & ReviewResultCoverage,
): Promise<void> {
  const key = prKey(args.sessionId, args.workspace, args.prNumber)
  const set = reviewsByPr.get(key) ?? new Set<ReviewVerdict>()
  set.add(args.verdict)
  reviewsByPr.set(key, set)
  // Notify AFTER the record lands and never let an observer failure corrupt the
  // ledger write — the false-receipt guard depends on this record being durable.
  if (reviewObserver !== null) {
    try {
      reviewObserver({
        sessionId: args.sessionId,
        workspace: args.workspace,
        prNumber: args.prNumber,
        verdict: args.verdict,
        ...(args.commitSha !== undefined ? { commitSha: args.commitSha } : {}),
      })
    } catch {
      // swallow: a broken broadcast must not break verdict bookkeeping
    }
  }
  // A decisive verdict IS review output too — fan it to the output observer so the
  // router's empty-turn guard sees it without a second detection path.
  await recordReviewOutput({
    sessionId: args.sessionId,
    workspace: args.workspace,
    prNumber: args.prNumber,
    state: args.verdict,
    ...(args.inboundCoverage !== undefined ? { inboundCoverage: args.inboundCoverage } : {}),
    ...(args.backgroundCoverage !== undefined ? { backgroundCoverage: args.backgroundCoverage } : {}),
  })
}

export function recordVerifiedDismissal(args: { sessionId: string; workspace: string; prNumber: number }): void {
  if (reviewObserver === null) return
  try {
    reviewObserver({ ...args, verdict: 'DISMISSED' })
  } catch {
    // A broken round wakeup must not turn a verified GitHub mutation into a tool failure.
  }
}

export async function recordReviewOutput(
  args: {
    sessionId: string
    workspace: string
    prNumber: number
    state: ReviewOutputState
  } & ReviewResultCoverage,
): Promise<void> {
  if (reviewOutputObserver === null) return
  try {
    await reviewOutputObserver(args)
  } catch {
    // The review already landed remotely. Settlement failure must not authorize a mutation retry.
  }
}

export function hasReview(args: {
  sessionId: string
  workspace: string
  prNumber: number
  verdict: ReviewVerdict
}): boolean {
  return reviewsByPr.get(prKey(args.sessionId, args.workspace, args.prNumber))?.has(args.verdict) ?? false
}

export function recordResolvedThread(args: {
  sessionId: string
  workspace: string
  prNumber: number
  rootCommentId: string
}): void {
  resolvedThreads.add(threadKey(args.sessionId, args.workspace, args.prNumber, args.rootCommentId))
}

export function hasResolvedThread(args: {
  sessionId: string
  workspace: string
  prNumber: number
  rootCommentId: string
}): boolean {
  return resolvedThreads.has(threadKey(args.sessionId, args.workspace, args.prNumber, args.rootCommentId))
}
