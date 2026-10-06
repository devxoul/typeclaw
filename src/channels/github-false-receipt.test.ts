import { afterEach, describe, expect, test } from 'bun:test'

import { checkFalseReceipt } from './github-false-receipt'
import { recordResolvedThread, recordReview, resetReviewTurn } from './github-review-turn-ledger'

const S = 'ses_fr'
const WS = 'acme/widgets'

afterEach(() => resetReviewTurn(S))

function base(over: Partial<Parameters<typeof checkFalseReceipt>[0]> = {}): Parameters<typeof checkFalseReceipt>[0] {
  return {
    sessionId: S,
    adapter: 'github',
    workspace: WS,
    chat: 'pr:12',
    thread: null,
    text: '',
    moreWorkThisTurn: false,
    resolveReviewThread: false,
    ...over,
  }
}

describe('checkFalseReceipt — scope gates', () => {
  test('non-github adapter is always allowed', () => {
    expect(checkFalseReceipt(base({ adapter: 'slack-bot', text: 'Approved!' })).kind).toBe('allow')
  })

  test('non-pr github chat is allowed', () => {
    expect(checkFalseReceipt(base({ chat: 'issue:12', text: 'Approved!' })).kind).toBe('allow')
  })
})

describe('checkFalseReceipt — verdict false receipts', () => {
  test('terminal "Approved" with no review this turn is BLOCKED', () => {
    expect(checkFalseReceipt(base({ text: 'Approved!' })).kind).toBe('block')
  })

  test('terminal "Approved" AFTER a real APPROVE review is allowed', async () => {
    await recordReview({ sessionId: S, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    expect(checkFalseReceipt(base({ text: 'Approved — thanks!' })).kind).toBe('allow')
  })

  test('a real REQUEST_CHANGES does not satisfy an approve claim', async () => {
    await recordReview({ sessionId: S, workspace: WS, prNumber: 12, verdict: 'REQUEST_CHANGES' })
    expect(checkFalseReceipt(base({ text: 'Approved!' })).kind).toBe('block')
  })

  test('terminal "requesting changes" with no review is BLOCKED', () => {
    expect(checkFalseReceipt(base({ text: 'Requesting changes here.' })).kind).toBe('block')
  })

  test('more_work_this_turn:true downgrades a hard verdict claim to a warn', () => {
    expect(checkFalseReceipt(base({ text: 'Approved!', moreWorkThisTurn: true })).kind).toBe('warn')
  })

  test('soft signal warns, never blocks', () => {
    expect(checkFalseReceipt(base({ text: 'looks good' })).kind).toBe('warn')
  })

  test('unrelated text is allowed', () => {
    expect(checkFalseReceipt(base({ text: 'Can you rebase onto main?' })).kind).toBe('allow')
  })
})

describe('checkFalseReceipt — resolve false receipts', () => {
  test('"resolved" ack in a thread without the flag is BLOCKED', () => {
    expect(checkFalseReceipt(base({ thread: '555', text: 'That resolves it, thanks!' })).kind).toBe('block')
  })

  test('"resolved" ack WITH the flag is allowed', () => {
    expect(
      checkFalseReceipt(base({ thread: '555', text: 'That resolves it, thanks!', resolveReviewThread: true })).kind,
    ).toBe('allow')
  })

  test('"resolved" ack after the thread was resolved this turn is allowed', () => {
    recordResolvedThread({ sessionId: S, workspace: WS, prNumber: 12, rootCommentId: '555' })
    expect(checkFalseReceipt(base({ thread: '555', text: 'That resolves it, thanks!' })).kind).toBe('allow')
  })

  test('a resolve claim on a PR root (no thread) is allowed (not a thread close-out)', () => {
    expect(checkFalseReceipt(base({ thread: null, text: 'That resolves it.' })).kind).toBe('allow')
  })
})
