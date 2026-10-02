import { afterEach, describe, expect, test } from 'bun:test'

import {
  __resetReviewObserverForTest,
  hasResolvedThread,
  hasReview,
  recordResolvedThread,
  recordReview,
  recordVerifiedDismissal,
  recordReviewOutput,
  resetReviewTurn,
  setReviewObserver,
  setReviewOutputObserver,
} from './github-review-turn-ledger'

const S1 = 'ses_one'
const S2 = 'ses_two'
const WS = 'acme/widgets'

afterEach(() => {
  resetReviewTurn(S1)
  resetReviewTurn(S2)
  __resetReviewObserverForTest()
})

describe('review ledger', () => {
  test('records and reads back a verdict for the same pr', async () => {
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(true)
  })

  test('a recorded APPROVE does not satisfy a REQUEST_CHANGES query', async () => {
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'REQUEST_CHANGES' })).toBe(false)
  })

  test('verdicts are isolated per pr number', async () => {
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 99, verdict: 'APPROVE' })).toBe(false)
  })

  test('verdicts are isolated per session', async () => {
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S2, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(false)
  })

  test('resetReviewTurn clears only the target session', async () => {
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    await recordReview({ sessionId: S2, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    resetReviewTurn(S1)
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(false)
    expect(hasReview({ sessionId: S2, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(true)
  })
})

describe('review observer', () => {
  test('fires the observer with the landed verdict on recordReview', async () => {
    const seen: unknown[] = []
    setReviewObserver((args) => seen.push(args))
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(seen).toEqual([{ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' }])
  })

  test('a thrown observer never breaks the ledger record', async () => {
    setReviewObserver(() => {
      throw new Error('boom')
    })
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    // the record still landed despite the observer throwing
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(true)
  })

  test('__resetReviewObserverForTest detaches the observer', async () => {
    const seen: unknown[] = []
    setReviewObserver((args) => seen.push(args))
    __resetReviewObserverForTest()
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(seen).toEqual([])
  })

  test('recordResolvedThread does not fire the verdict observer', () => {
    const seen: unknown[] = []
    setReviewObserver((args) => seen.push(args))
    recordResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })
    expect(seen).toEqual([])
  })

  test('a verified dismissal fires the round-completion observer without crediting a verdict', () => {
    const seen: unknown[] = []
    setReviewObserver((args) => seen.push(args))

    recordVerifiedDismissal({ sessionId: S1, workspace: WS, prNumber: 12 })

    expect(seen).toEqual([{ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'DISMISSED' }])
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(false)
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'REQUEST_CHANGES' })).toBe(false)
  })
})

describe('review-output observer', () => {
  test('a recorded verdict also fires the output observer with the same state', async () => {
    const seen: unknown[] = []
    setReviewOutputObserver((args) => {
      seen.push(args)
    })
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(seen).toEqual([{ sessionId: S1, workspace: WS, prNumber: 12, state: 'APPROVE' }])
  })

  test('recordReviewOutput COMMENT fires the output observer but not the verdict ledger', async () => {
    const output: unknown[] = []
    const verdicts: unknown[] = []
    setReviewOutputObserver((args) => {
      output.push(args)
    })
    setReviewObserver((args) => verdicts.push(args))

    await recordReviewOutput({ sessionId: S1, workspace: WS, prNumber: 12, state: 'COMMENT' })

    // given a COMMENT: the router-facing output signal fires
    expect(output).toEqual([{ sessionId: S1, workspace: WS, prNumber: 12, state: 'COMMENT' }])
    // but the false-receipt ledger is untouched — a COMMENT must never satisfy hasReview
    expect(verdicts).toEqual([])
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(false)
  })

  test('a thrown output observer never breaks the ledger record', async () => {
    setReviewOutputObserver(() => {
      throw new Error('boom')
    })
    await recordReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(hasReview({ sessionId: S1, workspace: WS, prNumber: 12, verdict: 'APPROVE' })).toBe(true)
  })

  test('__resetReviewObserverForTest detaches the output observer', async () => {
    const seen: unknown[] = []
    setReviewOutputObserver((args) => {
      seen.push(args)
    })
    __resetReviewObserverForTest()
    await recordReviewOutput({ sessionId: S1, workspace: WS, prNumber: 12, state: 'COMMENT' })
    expect(seen).toEqual([])
  })
})

describe('resolved-thread ledger', () => {
  test('records and reads back a resolved thread', () => {
    recordResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })
    expect(hasResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })).toBe(true)
  })

  test('a different root comment is not considered resolved', () => {
    recordResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })
    expect(hasResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '777' })).toBe(false)
  })

  test('resetReviewTurn clears resolved threads for the session', () => {
    recordResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })
    resetReviewTurn(S1)
    expect(hasResolvedThread({ sessionId: S1, workspace: WS, prNumber: 12, rootCommentId: '555' })).toBe(false)
  })
})
