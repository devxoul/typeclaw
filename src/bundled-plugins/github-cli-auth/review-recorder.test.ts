import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __resetReviewObserverForTest,
  hasReview,
  resetReviewTurn,
  type ReviewOutputState,
  type ReviewResultCoverage,
  setReviewCoverageCapture,
  setReviewOutputObserver,
} from '@/channels/github-review-turn-ledger'
import {
  __resetReviewVerdictGuardForTest,
  createApproveIdempotencyGuard,
} from '@/channels/github-review-verdict-coordinator'
import { InboundJournal } from '@/channels/inbound-journal'
import type { ToolResult } from '@/plugin'

import {
  capturedReviewAccountIdentity,
  commitReviewIfSucceeded,
  discardReviewCommand,
  dismissalMutationSucceeded,
  noteReviewCommand,
} from './review-recorder'

const SESSION = 'ses_recorder'
const WS = 'acme/widgets'

afterEach(() => {
  resetReviewTurn(SESSION)
  __resetReviewVerdictGuardForTest()
  __resetReviewObserverForTest()
})

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

const SUCCESS_OUTPUT = '{"id":1,"node_id":"PRR_abc","state":"APPROVED"}'
const FAILURE_OUTPUT = 'gh: Validation Failed (HTTP 422)'

describe('review recorder', () => {
  const coverageCommands = [
    { lane: 'verdict', flags: '-f event=APPROVE', state: 'APPROVED' },
    { lane: 'COMMENT', flags: '-f event=COMMENT', state: 'COMMENTED' },
    { lane: 'backstop', flags: '-X POST --input -', state: 'APPROVED' },
  ]

  test.each(coverageCommands)(
    '$lane credits only coverage captured before the remote submission',
    async ({ lane, flags, state }) => {
      const a = { obligationId: 'background-a', generation: 1 }
      const b = { obligationId: 'background-b', generation: 2 }
      const inbound = { inputId: 'request-a', generation: 1 }
      let current: ReviewResultCoverage = {
        inboundCoverage: [inbound],
        backgroundCoverage: [a],
        expectedAccountIdentity: 'github:1',
      }
      setReviewCoverageCapture(async () => current)
      const observed: ReviewResultCoverage[] = []
      setReviewOutputObserver((output) => {
        observed.push({ inboundCoverage: output.inboundCoverage, backgroundCoverage: output.backgroundCoverage })
      })
      const callId = `coverage-${lane}`
      const command = `gh api /repos/${WS}/pulls/5/reviews ${flags}`
      const remote = Promise.withResolvers<ToolResult>()
      const result = textResult(`{"state":"${state}","pull_request_url":"https://api.github.com/repos/${WS}/pulls/5"}`)

      await noteReviewCommand({ sessionId: SESSION, callId, command })
      const after = remote.promise.then((result) => commitReviewIfSucceeded({ sessionId: SESSION, callId, result }))
      // While the remote submission is pending, a later fetched result joins the
      // current turn and the original reference changes. Neither belongs to it.
      current.backgroundCoverage?.push(b)
      a.generation = 9
      current.inboundCoverage?.push({ inputId: 'request-b', generation: 2 })
      inbound.generation = 9
      current.expectedAccountIdentity = 'github:2'
      expect(capturedReviewAccountIdentity(callId)).toBe('github:1')
      remote.resolve(result)
      await after
      expect(observed).toEqual([
        {
          inboundCoverage: [{ inputId: 'request-a', generation: 1 }],
          backgroundCoverage: [{ obligationId: 'background-a', generation: 1 }],
        },
      ])
      expect(capturedReviewAccountIdentity(callId)).toBeUndefined()

      current = { backgroundCoverage: [b] }
      await noteReviewCommand({ sessionId: SESSION, callId, command })
      await commitReviewIfSucceeded({ sessionId: SESSION, callId, result })
      expect(observed[1]).toEqual({ inboundCoverage: [], backgroundCoverage: [b] })
      await commitReviewIfSucceeded({ sessionId: SESSION, callId, result })
      expect(observed).toHaveLength(2)
    },
  )

  test.each(coverageCommands)(
    '$lane capture failure removes pending records and cannot credit a retry',
    async ({ lane, flags, state }) => {
      const callId = `failed-capture-${lane}`
      const command = `gh api /repos/${WS}/pulls/5/reviews ${flags}`
      const result = textResult(`{"state":"${state}","pull_request_url":"https://api.github.com/repos/${WS}/pulls/5"}`)
      const observed: ReviewResultCoverage[] = []
      setReviewOutputObserver((output) => {
        observed.push({ backgroundCoverage: output.backgroundCoverage })
      })
      setReviewCoverageCapture(async () => {
        throw new Error('coverage unavailable')
      })
      await expect(noteReviewCommand({ sessionId: SESSION, callId, command })).rejects.toThrow('coverage unavailable')
      expect(await commitReviewIfSucceeded({ sessionId: SESSION, callId, result })).toEqual({
        committed: false,
        landedFromResult: null,
      })
      expect(observed).toEqual([])
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)

      const b = { obligationId: 'background-b', generation: 2 }
      setReviewCoverageCapture(async () => ({ backgroundCoverage: [b] }))
      await noteReviewCommand({ sessionId: SESSION, callId, command })
      await commitReviewIfSucceeded({ sessionId: SESSION, callId, result })
      expect(observed).toEqual([{ backgroundCoverage: [b] }])
    },
  )

  test('discarded or replaced commands cannot credit stale review output', async () => {
    setReviewCoverageCapture(async () => ({ backgroundCoverage: [{ obligationId: 'background-a', generation: 1 }] }))
    const observed: ReviewOutputState[] = []
    setReviewOutputObserver((output) => {
      observed.push(output.state)
    })
    const command = `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`
    await noteReviewCommand({ sessionId: SESSION, callId: 'discarded', command })
    discardReviewCommand('discarded')
    await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'discarded', result: textResult(SUCCESS_OUTPUT) })
    await noteReviewCommand({ sessionId: SESSION, callId: 'replaced', command })
    await noteReviewCommand({ sessionId: SESSION, callId: 'replaced', command: `gh pr view 5 -R ${WS}` })
    await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'replaced', result: textResult(SUCCESS_OUTPUT) })
    expect(observed).toEqual([])
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test.each(['APPROVE', 'COMMENT'] as const)(
    'late %s callback cannot close newer same-target ownership',
    async (state) => {
      const dir = mkdtempSync(join(tmpdir(), 'review-coverage-'))
      const journal = new InboundJournal(dir)
      const target = { adapter: 'github' as const, workspace: WS, chat: 'pr:5', thread: null }
      try {
        const admitted = await journal.admit({
          target,
          accountIdentity: 'github:bot',
          principal: { kind: 'channel', adapter: 'github', workspace: WS, chat: 'pr:5', lastInboundAuthorId: 'human' },
          messageId: 'request',
          eventKind: 'message',
          revision: '1',
        })
        if (admitted.kind !== 'accepted') throw new Error('Expected new admission')
        const claimed = await journal.claim([{ inputId: admitted.inputId, generation: admitted.generation }], {
          target,
          turnId: 'old-turn',
          ownerSessionId: SESSION,
        })
        setReviewCoverageCapture(async () => ({ inboundCoverage: claimed.inboundRefs, backgroundCoverage: [] }))
        await noteReviewCommand({
          callId: 'stale-coverage',
          sessionId: SESSION,
          command: `gh api /repos/${WS}/pulls/5/reviews -f event=${state}`,
        })
        const moved = await journal.move(claimed.inboundRefs, {
          target,
          fromTurnId: 'old-turn',
          turnId: 'new-turn',
          ownerSessionId: SESSION,
        })
        setReviewCoverageCapture(async () => ({ inboundCoverage: moved.inboundRefs, backgroundCoverage: [] }))
        setReviewOutputObserver(async (args) => {
          await journal.settle(
            args.inboundCoverage ?? [],
            { kind: 'delivered', decisionId: 'landed-review' },
            [],
            target,
          )
        })
        const result = await commitReviewIfSucceeded({
          sessionId: SESSION,
          callId: 'stale-coverage',
          result: textResult(`{"id":1,"state":"${state === 'COMMENT' ? 'COMMENTED' : 'APPROVED'}"}`),
        })
        expect(result.committed).toBe(state === 'APPROVE')
        expect(journal.get(admitted.inputId)).toMatchObject({ phase: 'turn-owned', claim: { turnId: 'new-turn' } })
        await journal.settle(moved.inboundRefs, { kind: 'delivered', decisionId: 'new-result' }, [], target)
        expect(journal.get(admitted.inputId)?.phase).toBe('closed')
      } finally {
        await journal.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  test('failed pre-execution coverage capture discards the submission attempt', async () => {
    setReviewCoverageCapture(async () => {
      throw new Error('journal frozen')
    })
    await expect(
      noteReviewCommand({
        sessionId: SESSION,
        callId: 'failed-capture',
        command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
      }),
    ).rejects.toThrow('journal frozen')
    expect(
      await commitReviewIfSucceeded({
        sessionId: SESSION,
        callId: 'failed-capture',
        result: textResult(SUCCESS_OUTPUT),
      }),
    ).toEqual({ committed: false, landedFromResult: null })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('accepts only an explicit DISMISSED mutation result', () => {
    expect(dismissalMutationSucceeded(textResult('{"id":1,"state":"DISMISSED"}'))).toBe(true)
    expect(dismissalMutationSucceeded(textResult('gh: Validation Failed (HTTP 422)'))).toBe(false)
    expect(dismissalMutationSucceeded(textResult('{"id":1,"state":"CHANGES_REQUESTED"}'))).toBe(false)
  })
  test('credits the ledger when an inline-field APPROVE succeeds', async () => {
    await noteReviewCommand({
      callId: 'c1',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c1', result: textResult(SUCCESS_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(true)
  })

  test.each(['APPROVE', 'COMMENT'] as const)('awaits settlement of a recognized %s command', async (state) => {
    await noteReviewCommand({
      callId: 'delayed',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=${state}`,
    })
    const entered = Promise.withResolvers<void>()
    const settlement = Promise.withResolvers<void>()
    setReviewOutputObserver(async () => {
      entered.resolve()
      await settlement.promise
    })
    let returned = false
    const result = commitReviewIfSucceeded({
      sessionId: SESSION,
      callId: 'delayed',
      result: textResult(`{"id":1,"state":"${state === 'COMMENT' ? 'COMMENTED' : 'APPROVED'}"}`),
    }).then((value) => {
      returned = true
      return value
    })
    await entered.promise
    await Promise.resolve()
    expect(returned).toBe(false)
    settlement.resolve()
    expect((await result).committed).toBe(state === 'APPROVE')
  })

  test('retains a landed verdict and consumes its attempt when settlement rejects', async () => {
    await noteReviewCommand({
      callId: 'failed-settlement',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    setReviewOutputObserver(async () => {
      throw new Error('settlement storage unavailable')
    })
    const args = { sessionId: SESSION, callId: 'failed-settlement', result: textResult(SUCCESS_OUTPUT) }
    expect(await commitReviewIfSucceeded(args)).toEqual({ committed: true, landedFromResult: null })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(true)
    expect(await commitReviewIfSucceeded(args)).toEqual({ committed: false, landedFromResult: null })
  })

  test('does NOT credit when the command failed', async () => {
    await noteReviewCommand({
      callId: 'c2',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c2', result: textResult(FAILURE_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('does NOT credit on an ambiguous result (fail closed)', async () => {
    await noteReviewCommand({
      callId: 'c3',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c3', result: textResult('(no recognizable output)') })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('reads the verdict from an --input file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-rec-'))
    const file = join(dir, 'review.json')
    writeFileSync(file, '{"event":"REQUEST_CHANGES","body":"x"}')
    try {
      await noteReviewCommand({
        callId: 'c4',
        command: `gh api -X POST /repos/${WS}/pulls/9/reviews --input ${file}`,
      })
      await commitReviewIfSucceeded({
        sessionId: SESSION,
        callId: 'c4',
        result: textResult('{"node_id":"PRR_z","state":"CHANGES_REQUESTED"}'),
      })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 9, verdict: 'REQUEST_CHANGES' })).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-review gh command is ignored', async () => {
    await noteReviewCommand({ callId: 'c5', command: `gh pr view 5 -R ${WS}` })
    await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c5', result: textResult(SUCCESS_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('credits a `gh pr review --approve` from its porcelain confirmation line', async () => {
    await noteReviewCommand({ callId: 'c6', command: `gh pr review 42 --approve -R ${WS}` })
    await commitReviewIfSucceeded({
      sessionId: SESSION,
      callId: 'c6',
      result: textResult(`✓ Approved pull request ${WS}#42`),
    })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'APPROVE' })).toBe(true)
  })

  test('credits a `gh pr review --request-changes` from its porcelain confirmation line', async () => {
    await noteReviewCommand({ callId: 'c7', command: `gh pr review 42 --request-changes -R ${WS}` })
    await commitReviewIfSucceeded({
      sessionId: SESSION,
      callId: 'c7',
      result: textResult(`+ Requested changes to pull request ${WS}#42`),
    })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'REQUEST_CHANGES' })).toBe(true)
  })

  test('does NOT credit a porcelain command whose output is missing the confirmation (fail closed)', async () => {
    await noteReviewCommand({ callId: 'c8', command: `gh pr review 42 --approve -R ${WS}` })
    await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c8', result: textResult('(no recognizable output)') })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'APPROVE' })).toBe(false)
  })

  describe('post-execution backstop (pre-detection missed)', () => {
    const LANDED_APPROVED = `{"id":7,"node_id":"PRR_x","state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/77"}`

    // The backstop now fires only after tool.before saw a real POST submission
    // attempt whose verdict it could not extract. A heredoc-bodied POST with the
    // payload in a separate file the before-detector did not resolve is the
    // canonical "attempt seen, verdict missed" case used to arm these tests.
    async function noteMissedAttempt(callId: string, prNumber: number): Promise<void> {
      await noteReviewCommand({
        callId,
        command: `gh api -X POST /repos/${WS}/pulls/${prNumber}/reviews --input /tmp/missing-${prNumber}.json`,
      })
    }

    test('credits a landed APPROVE from the REST response for an attempted POST whose verdict was missed', async () => {
      await noteMissedAttempt('b1', 77)
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b1', result: textResult(LANDED_APPROVED) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(true)
    })

    test('preserves recovered landed identity for the lag shield when settlement fails', async () => {
      await noteMissedAttempt('backstop-settlement-failure', 77)
      setReviewOutputObserver(async () => {
        throw new Error('settlement storage unavailable')
      })
      const result = await commitReviewIfSucceeded({
        sessionId: SESSION,
        callId: 'backstop-settlement-failure',
        result: textResult(LANDED_APPROVED),
      })
      expect(result).toMatchObject({
        committed: true,
        landedFromResult: { workspace: WS, prNumber: 77, verdict: 'APPROVE' },
      })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(true)
    })

    test('credits a landed CHANGES_REQUESTED from the REST response', async () => {
      await noteMissedAttempt('b2', 78)
      const out = `{"state":"CHANGES_REQUESTED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/78"}`
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b2', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 78, verdict: 'REQUEST_CHANGES' })).toBe(true)
    })

    test('does NOT credit a reviews-list READ whose response array carries a decisive state', async () => {
      // given: a GET that LISTS existing reviews (no -X POST) — not a submission
      await noteReviewCommand({ callId: 'bread', command: `gh api /repos/${WS}/pulls/84/reviews` })
      // when: the response array contains an existing APPROVED review + a pulls URL
      const out = `[{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/84"}]`
      const result = await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'bread', result: textResult(out) })
      // then: no attempt marker was recorded, so the backstop never runs
      expect(result.committed).toBe(false)
      expect(result.landedFromResult).toBeNull()
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 84, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit when no submission attempt was recorded at all', async () => {
      const result = await commitReviewIfSucceeded({
        sessionId: SESSION,
        callId: 'bnone',
        result: textResult(LANDED_APPROVED),
      })
      expect(result.committed).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit when the attempted PR does not match the PR in the response', async () => {
      await noteMissedAttempt('bmismatch', 85)
      const out = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/999"}`
      const result = await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'bmismatch', result: textResult(out) })
      expect(result.committed).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 999, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit when the state is present but a failure marker is also present (fail closed)', async () => {
      await noteMissedAttempt('b3', 79)
      const out = `gh: Validation Failed (HTTP 422) {"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/79"}`
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b3', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 79, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit a decisive state with no recoverable PR url', async () => {
      await noteMissedAttempt('b4', 77)
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b4', result: textResult('{"state":"APPROVED"}') })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit a COMMENT review state', async () => {
      await noteMissedAttempt('b5', 80)
      const out = `{"state":"COMMENTED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/80"}`
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b5', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 80, verdict: 'APPROVE' })).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 80, verdict: 'REQUEST_CHANGES' })).toBe(false)
    })

    test('the pending-entry path takes precedence over the backstop', async () => {
      await noteReviewCommand({ callId: 'b6', command: `gh api /repos/${WS}/pulls/81/reviews -f event=APPROVE` })
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b6', result: textResult(SUCCESS_OUTPUT) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 81, verdict: 'APPROVE' })).toBe(true)
    })

    test('a pending-path commit returns no landedFromResult (release arms the shield)', async () => {
      await noteReviewCommand({ callId: 'b7', command: `gh api /repos/${WS}/pulls/82/reviews -f event=APPROVE` })
      const result = await commitReviewIfSucceeded({
        sessionId: SESSION,
        callId: 'b7',
        result: textResult(SUCCESS_OUTPUT),
      })
      expect(result.committed).toBe(true)
      expect(result.landedFromResult).toBeNull()
    })

    test('the backstop result returns landedFromResult for the caller to arm the shield', async () => {
      await noteMissedAttempt('b8', 83)
      const out = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/83"}`
      const result = await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b8', result: textResult(out) })
      expect(result.committed).toBe(true)
      expect(result.landedFromResult).toEqual({ workspace: WS, prNumber: 83, verdict: 'APPROVE', source: 'api' })
    })
  })

  // Mirrors the plugin's tool.after wiring (index.ts): commitReviewIfSucceeded ->
  // verdictGuard.noteLandedReview for the backstop path, then the next submission
  // hits guard(). Proves the advertised "arm the dedupe window" actually holds for
  // the fallback path — the gap the reviewer flagged.
  describe('integration: backstop arms the idempotency lag shield', () => {
    function makeGuard(headSha: string | null) {
      return createApproveIdempotencyGuard({
        resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
        resolveHeadSha: async () => headSha,
      })
    }

    test('pre-detection missed, REST response detected, next same-commit APPROVE is blocked while GitHub returns NONE', async () => {
      const guard = makeGuard('sha-abc')
      // given: a POST create-review whose verdict the before-detector missed (no
      // pending, no guard() reservation) but whose submission intent it DID record
      await noteReviewCommand({
        callId: 'i1',
        command: `gh api -X POST /repos/${WS}/pulls/90/reviews --input /tmp/missing-90.json`,
      })
      // and: only the REST result proves the landed verdict
      const out = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/90"}`
      const result = await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'i1', result: textResult(out) })
      // when: the plugin wires the recovered verdict into the guard, as tool.after does
      expect(result.landedFromResult).not.toBeNull()
      if (result.landedFromResult !== null) await guard.noteLandedReview(result.landedFromResult)
      // then: a second engagement turn's same-commit APPROVE is deduped even though
      // GitHub's reviews read still lags (NONE)
      const dup = await guard.guard({ callId: 'i2', workspace: WS, prNumber: 90, verdict: 'APPROVE' })
      expect(dup?.block).toBe(true)
    })
  })

  describe('COMMENT review output', () => {
    function captureOutput(): ReviewOutputState[] {
      const states: ReviewOutputState[] = []
      setReviewOutputObserver((args) => {
        states.push(args.state)
      })
      return states
    }

    test('credits review output (not the verdict ledger) for a successful COMMENT', async () => {
      const states = captureOutput()
      await noteReviewCommand({
        callId: 'cm1',
        command: `gh api -X POST /repos/${WS}/pulls/91/reviews -f event=COMMENT -f body=notes`,
      })
      const out = `{"state":"COMMENTED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/91"}`
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'cm1', result: textResult(out) })

      // the output observer sees the COMMENT, but it never enters the verdict ledger
      expect(states).toEqual(['COMMENT'])
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 91, verdict: 'APPROVE' })).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 91, verdict: 'REQUEST_CHANGES' })).toBe(false)
    })

    test('a POST COMMENT does not leave a stale submission-attempt entry behind', async () => {
      captureOutput()
      // given: a COMMENT POST that succeeds — this is also a POST to the reviews
      // endpoint, so the OLD code armed the backstop attempt AND returned early,
      // never clearing it
      await noteReviewCommand({
        callId: 'cm2',
        command: `gh api -X POST /repos/${WS}/pulls/92/reviews -f event=COMMENT -f body=notes`,
      })
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'cm2', result: textResult('{"state":"COMMENTED"}') })

      // when: a later commit reuses the same callId with a decisive-verdict response,
      // a stale attempt would let the backstop credit a verdict that no command posted
      const landed = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/92"}`
      const result = await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'cm2', result: textResult(landed) })

      // then: no stale attempt remained, so nothing is credited
      expect(result.committed).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 92, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit output when the COMMENT command failed (fail closed)', async () => {
      const states = captureOutput()
      await noteReviewCommand({
        callId: 'cm3',
        command: `gh api -X POST /repos/${WS}/pulls/93/reviews -f event=COMMENT -f body=notes`,
      })
      await commitReviewIfSucceeded({ sessionId: SESSION, callId: 'cm3', result: textResult(FAILURE_OUTPUT) })
      expect(states).toEqual([])
    })
  })
})
