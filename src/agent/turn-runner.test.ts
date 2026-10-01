import { describe, expect, test } from 'bun:test'

import type { ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import { isFailoverWorthy, wrapTransformContextWithLocalFailureMarker } from './provider-error'
import {
  PATIENT_OVERLOAD_RETRIES,
  PATIENT_OVERLOAD_WINDOW_MS,
  RESPONSIVE_OVERLOAD_RETRIES,
  RESPONSIVE_OVERLOAD_WINDOW_MS,
} from './retry-same-ref'
import { ThrottleCircuit } from './throttle-circuit'
import { promptPersistentTurnWithFallback } from './turn-runner'

const REF_A = 'openai/gpt-5.4-nano' as ModelRef
const REF_B = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' as ModelRef
const CODEX_TERRA_REF = 'openai-codex/gpt-5.5' as ModelRef
const CODEX_SOL_REF = 'openai-codex/gpt-5.4' as ModelRef
const CODEX_LUNA_REF = 'openai-codex/gpt-5.4-mini' as ModelRef
const ANTHROPIC_REF = 'anthropic/claude-sonnet-5' as ModelRef

// A context-preparation failure whose text merely echoes a codex TTFB timeout,
// marked by the same wrapper sessions install around transformContext.
const LOCAL_TTFB_LOOKALIKE = await wrapTransformContextWithLocalFailureMarker(async () => {
  throw new Error('openai-codex timed out before response headers after 30000ms (typeclaw observer timeout)')
})([]).then(
  () => '',
  (err: unknown) => (err as Error).message,
)

type FakeEvent = { type: string; message?: unknown; assistantMessageEvent?: { type: string; delta?: string } }

function fakeSession(
  behaviors: Array<
    | 'soft-throttle'
    | 'soft-503'
    | 'soft-billing'
    | 'text-then-throttle'
    | 'tool-then-throttle'
    | 'hard-observer-timeout'
    | 'hard-observer-ttfb-timeout'
    | 'soft-observer-ttfb-timeout'
    | 'soft-local-ttfb-lookalike'
    | 'text-then-success'
    | 'success'
  >,
  onPrompt?: () => void,
) {
  const events: Array<(event: FakeEvent) => void> = []
  const prompted: string[] = []
  const setModels: ModelRef[] = []
  const session = {
    prompt: async (text: string) => {
      prompted.push(text)
      const behavior = behaviors.shift() ?? 'success'
      onPrompt?.()
      if (behavior === 'hard-observer-timeout') {
        throw new Error('anthropic SSE body idle for 120000ms (typeclaw observer timeout)')
      }
      if (behavior === 'hard-observer-ttfb-timeout') {
        throw new Error('openai-codex timed out before response headers after 30000ms (typeclaw observer timeout)')
      }
      if (behavior === 'text-then-throttle') {
        for (const cb of events)
          cb({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })
      }
      if (behavior === 'text-then-success') {
        for (const cb of events)
          cb({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'still working' } })
      }
      if (behavior === 'tool-then-throttle') {
        for (const cb of events) cb({ type: 'tool_execution_start' })
      }
      if (behavior !== 'success' && behavior !== 'text-then-success') {
        const message =
          behavior === 'soft-billing'
            ? 'billing required'
            : behavior === 'soft-503'
              ? '503 Service Unavailable'
              : behavior === 'soft-observer-ttfb-timeout'
                ? 'openai-codex timed out before response headers after 30000ms (typeclaw observer timeout)'
                : behavior === 'soft-local-ttfb-lookalike'
                  ? LOCAL_TTFB_LOOKALIKE
                  : 'server_is_overloaded'
        for (const cb of events) {
          cb({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: message } })
        }
      }
    },
    subscribe: (cb: (event: FakeEvent) => void) => {
      events.push(cb)
      return () => {
        const idx = events.indexOf(cb)
        if (idx >= 0) events.splice(idx, 1)
      }
    },
    abortRetry: () => {},
    setModel: async (_model: unknown) => {},
  } as unknown as AgentSession
  return { session, prompted, setModels }
}

describe('promptPersistentTurnWithFallback', () => {
  test('advances to the next ref on throttle before assistant output or tools', async () => {
    const fake = fakeSession(['soft-throttle', 'success'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_B)
    expect(fake.prompted).toEqual(['hello', 'hello'])
    expect(fake.setModels).toEqual([REF_B])
  })

  test('fails over to the next ref when the first ref throws an observer stall timeout (with isFailoverWorthy)', async () => {
    // given: ref A hard-throws an observer stall timeout before any output; ref B succeeds
    const fake = fakeSession(['hard-observer-timeout', 'success'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    // then: the stall rotated to REF_B and succeeded — no failure surfaced to the caller
    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_B)
    expect(fake.setModels).toEqual([REF_B])
    expect(result.attempts[0]).toMatchObject({ ref: REF_A, outcome: 'hard' })
  })

  test('does not advance when the throttle happens after assistant text', async () => {
    const fake = fakeSession(['text-then-throttle'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.prompted).toEqual(['hello'])
    expect(fake.setModels).toEqual([])
  })

  test('does not advance when the throttle happens after tool execution starts', async () => {
    const fake = fakeSession(['tool-then-throttle'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.setModels).toEqual([])
  })

  test('reports tool execution to the caller on the turn that then fails', async () => {
    // given: the same non-advancing shape as above. Callers need the signal on
    // exactly this path — the turn is unrecoverable AND may have already
    // committed a side effect — so it is delivered by callback rather than on
    // the result, which the hard-throw path never returns.
    const fake = fakeSession(['tool-then-throttle'])
    let toolStarts = 0
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
      onToolExecutionStarted: () => {
        toolStarts++
      },
    })

    expect(result.success).toBe(false)
    expect(toolStarts).toBe(1)
  })

  test('leaves the caller unaware of tool execution when no tool ran', async () => {
    const fake = fakeSession(['soft-throttle'])
    let toolStarts = 0
    await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
      onToolExecutionStarted: () => {
        toolStarts++
      },
    })

    expect(toolStarts).toBe(0)
  })

  test('does not advance for non-throttle soft errors', async () => {
    const fake = fakeSession(['soft-billing'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.setModels).toEqual([])
  })

  test('single-ref profiles fail fast without retrying the same ref', async () => {
    const fake = fakeSession(['soft-throttle', 'success'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(fake.prompted).toEqual(['hello'])
    expect(fake.setModels).toEqual([])
  })

  test('skips an open primary circuit and probes it again after cooldown', async () => {
    let t = 1_000
    const circuit = new ThrottleCircuit({ now: () => t })
    circuit.recordThrottle({ profile: 'default', ref: REF_A })
    circuit.recordThrottle({ profile: 'default', ref: REF_A })
    const fake = fakeSession(['success'])

    const skipped = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      profile: 'default',
      session: fake.session,
      text: 'hello',
      circuit,
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(skipped.success).toBe(true)
    expect(skipped.refUsed).toBe(REF_B)
    expect(fake.setModels).toEqual([REF_B])

    t += 180_001
    const probe = fakeSession(['success'])
    const probed = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      profile: 'default',
      session: probe.session,
      text: 'hello',
      circuit,
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        probe.setModels.push(ref)
      },
    })

    expect(probed.refUsed).toBe(REF_A)
    expect(probe.setModels).toEqual([])
  })

  test('records codex observer TTFB timeouts against one provider circuit across refs', async () => {
    const circuit = new ThrottleCircuit()

    for (const ref of [CODEX_TERRA_REF, CODEX_SOL_REF]) {
      const fake = fakeSession(['hard-observer-ttfb-timeout', 'success'])
      const result = await promptPersistentTurnWithFallback({
        refs: [ref, ANTHROPIC_REF],
        currentModelRef: ref,
        profile: 'default',
        session: fake.session,
        text: 'hello',
        circuit,
        shouldFailover: (err) => isFailoverWorthy(err.message),
        setModelForRef: async (nextRef) => {
          fake.setModels.push(nextRef)
        },
      })
      expect(result.success).toBe(true)
    }

    expect(circuit.isProviderOpen({ profile: 'default', ref: CODEX_LUNA_REF })).toBe(true)
    expect(circuit.isOpen({ profile: 'default', ref: CODEX_TERRA_REF })).toBe(false)
    expect(circuit.isOpen({ profile: 'default', ref: CODEX_SOL_REF })).toBe(false)
  })

  test('a local preparation failure echoing a codex TTFB timeout neither retries, fails over, nor trips the provider circuit', async () => {
    const circuit = new ThrottleCircuit()

    for (const ref of [CODEX_TERRA_REF, CODEX_SOL_REF]) {
      const fake = fakeSession(['soft-local-ttfb-lookalike', 'success'])
      const result = await promptPersistentTurnWithFallback({
        refs: [ref, ANTHROPIC_REF],
        currentModelRef: ref,
        profile: 'default',
        session: fake.session,
        text: 'hello',
        circuit,
        shouldFailover: (err) => isFailoverWorthy(err.message),
        setModelForRef: async (nextRef) => {
          fake.setModels.push(nextRef)
        },
      })
      // then: surfaced on the one attempt, with no same-ref replay or failover
      expect(result).toMatchObject({ success: false, refUsed: ref })
      expect(fake.prompted).toEqual(['hello'])
      expect(fake.setModels).toEqual([])
    }

    // then: unlike the real codex TTFB timeouts above, two of these leave codex usable
    expect(circuit.isProviderOpen({ profile: 'default', ref: CODEX_LUNA_REF })).toBe(false)
    expect(circuit.isOpen({ profile: 'default', ref: CODEX_TERRA_REF })).toBe(false)
  })

  test('attempts terra, sol, then routes to anthropic in one turn as the codex provider breaker opens mid-chain', async () => {
    const circuit = new ThrottleCircuit({ now: () => 1_000 })
    const fake = fakeSession(['soft-observer-ttfb-timeout', 'soft-observer-ttfb-timeout', 'success'])
    const attemptedRefs: ModelRef[] = []

    const result = await promptPersistentTurnWithFallback({
      refs: [CODEX_TERRA_REF, CODEX_SOL_REF, ANTHROPIC_REF],
      currentModelRef: CODEX_TERRA_REF,
      profile: 'default',
      session: fake.session,
      text: 'hello',
      circuit,
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
      beforeAttempt: (ref) => {
        attemptedRefs.push(ref)
      },
    })

    expect(attemptedRefs).toEqual([CODEX_TERRA_REF, CODEX_SOL_REF, ANTHROPIC_REF])
    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(ANTHROPIC_REF)
  })

  test('attempts only terra and sol (not luna) for a codex-only chain when the breaker opens mid-chain', async () => {
    const circuit = new ThrottleCircuit({ now: () => 1_000 })
    const fake = fakeSession(['soft-observer-ttfb-timeout', 'soft-observer-ttfb-timeout'])
    const attemptedRefs: ModelRef[] = []

    const result = await promptPersistentTurnWithFallback({
      refs: [CODEX_TERRA_REF, CODEX_SOL_REF, CODEX_LUNA_REF],
      currentModelRef: CODEX_TERRA_REF,
      profile: 'default',
      session: fake.session,
      text: 'hello',
      circuit,
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
      beforeAttempt: (ref) => {
        attemptedRefs.push(ref)
      },
    })

    expect(attemptedRefs).toEqual([CODEX_TERRA_REF, CODEX_SOL_REF])
    expect(result.success).toBe(false)
  })

  test('surfaces on the last attempted ref when a mid-chain trip strands trailing codex refs', async () => {
    // [anthropic, terra, sol, luna]: anthropic fails over, terra+sol TTFB-timeout
    // and open the breaker at sol. luna would now be skipped, so the turn must
    // surface on sol (the last ATTEMPTED ref) — not fall through and report luna,
    // which was never attempted.
    const circuit = new ThrottleCircuit({ now: () => 1_000 })
    const fake = fakeSession(['soft-throttle', 'soft-observer-ttfb-timeout', 'soft-observer-ttfb-timeout'])
    const attemptedRefs: ModelRef[] = []

    const result = await promptPersistentTurnWithFallback({
      refs: [ANTHROPIC_REF, CODEX_TERRA_REF, CODEX_SOL_REF, CODEX_LUNA_REF],
      currentModelRef: ANTHROPIC_REF,
      profile: 'default',
      session: fake.session,
      text: 'hello',
      circuit,
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
      beforeAttempt: (ref) => {
        attemptedRefs.push(ref)
      },
    })

    expect(attemptedRefs).toEqual([ANTHROPIC_REF, CODEX_TERRA_REF, CODEX_SOL_REF])
    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(CODEX_SOL_REF)
  })

  test('skips every codex ref while its provider circuit is open and uses the first non-codex fallback', async () => {
    const circuit = new ThrottleCircuit()
    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_TERRA_REF })
    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_SOL_REF })
    const fake = fakeSession(['success'])

    const result = await promptPersistentTurnWithFallback({
      refs: [CODEX_TERRA_REF, CODEX_SOL_REF, ANTHROPIC_REF, CODEX_LUNA_REF],
      currentModelRef: CODEX_TERRA_REF,
      profile: 'default',
      session: fake.session,
      text: 'hello',
      circuit,
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(ANTHROPIC_REF)
    expect(result.attempts).toEqual([{ ref: ANTHROPIC_REF, outcome: 'success' }])
    expect(fake.prompted).toEqual(['hello'])
    expect(fake.setModels).toEqual([ANTHROPIC_REF])
  })

  test('an open codex provider circuit surfaces a codex-only chain after one attempt', async () => {
    const circuit = new ThrottleCircuit()
    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_TERRA_REF })
    circuit.recordProviderTrip({ profile: 'default', ref: CODEX_SOL_REF })
    const fake = fakeSession(['hard-observer-ttfb-timeout'])

    await expect(
      promptPersistentTurnWithFallback({
        refs: [CODEX_TERRA_REF, CODEX_SOL_REF, CODEX_LUNA_REF],
        currentModelRef: CODEX_TERRA_REF,
        profile: 'default',
        session: fake.session,
        text: 'hello',
        circuit,
        shouldFailover: (err) => isFailoverWorthy(err.message),
        setModelForRef: async (ref) => {
          fake.setModels.push(ref)
        },
      }),
    ).rejects.toThrow('timed out before response headers')

    expect(fake.prompted).toEqual(['hello'])
    expect(fake.setModels).toEqual([])
  })

  test('a codex 503 opens only the existing per-ref circuit', async () => {
    const circuit = new ThrottleCircuit()

    for (let turn = 0; turn < 2; turn++) {
      const fake = fakeSession(['soft-503', 'success'])
      await promptPersistentTurnWithFallback({
        refs: [CODEX_TERRA_REF, ANTHROPIC_REF],
        currentModelRef: CODEX_TERRA_REF,
        profile: 'default',
        session: fake.session,
        text: 'hello',
        circuit,
        shouldFailover: (err) => isFailoverWorthy(err.message),
        setModelForRef: async (ref) => {
          fake.setModels.push(ref)
        },
      })
    }

    expect(circuit.isOpen({ profile: 'default', ref: CODEX_TERRA_REF })).toBe(true)
    expect(circuit.isProviderOpen({ profile: 'default', ref: CODEX_TERRA_REF })).toBe(false)
  })

  test('detects a soft error from the leaf entry when event subscriptions are skipped', async () => {
    const fake = fakeSession(['success'])
    const session = Object.assign(fake.session, {
      sessionManager: {
        getLeafEntry: () => ({
          type: 'message',
          message: { role: 'assistant', stopReason: 'error', errorMessage: 'server_is_overloaded' },
        }),
      },
    }) as AgentSession

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      skipProviderErrorSubscription: true,
      detectSoftErrorFromLeaf: true,
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.refUsed).toBe(REF_B)
    expect(fake.setModels).toEqual([REF_B])
  })

  test('a subagent leaf error AFTER a tool ran does not fail over (idempotency holds with subscriptions skipped)', async () => {
    const fake = fakeSession(['tool-then-throttle'])
    const session = Object.assign(fake.session, {
      sessionManager: {
        getLeafEntry: () => ({
          type: 'message',
          message: { role: 'assistant', stopReason: 'error', errorMessage: 'server_is_overloaded' },
        }),
      },
    }) as AgentSession

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      skipProviderErrorSubscription: true,
      detectSoftErrorFromLeaf: true,
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        fake.setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.setModels).toEqual([])
  })

  test('after a one-time failover, the next logical turn re-probes the primary from the head of the chain', async () => {
    const circuit = new ThrottleCircuit()

    const turn1 = fakeSession(['soft-throttle', 'success'])
    let active = REF_A
    const r1 = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: active,
      session: turn1.session,
      text: 'one',
      circuit,
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        turn1.setModels.push(ref)
        active = ref
      },
    })
    expect(r1.refUsed).toBe(REF_B)
    expect(active).toBe(REF_B)

    const turn2 = fakeSession(['success'])
    const r2 = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: active,
      session: turn2.session,
      text: 'two',
      circuit,
      shouldFailover: (err) => /overloaded/i.test(err.message),
      setModelForRef: async (ref) => {
        turn2.setModels.push(ref)
        active = ref
      },
    })

    expect(r2.refUsed).toBe(REF_A)
    expect(turn2.setModels).toEqual([REF_A])
  })
})

// A persistent-session fake that supports same-ref retry via agent.continue().
// `prompt` runs the first behavior; `continue` runs subsequent ones WITHOUT
// re-appending a user message — mirroring the real SDK recipe we depend on.
// `userMessages` lets tests assert the user message is never duplicated.
type RetryBehavior =
  | 'throw-transient'
  | 'throw-before-assistant'
  | 'soft-transient'
  | 'soft-throttle'
  | 'soft-observer-ttfb-timeout'
  | 'success'

function retryableFakeSession(behaviors: RetryBehavior[], onAttempt?: () => void) {
  const listeners: Array<(event: FakeEvent) => void> = []
  const messages: Array<{ role: string; stopReason?: string }> = []
  let idx = 0
  const run = (viaContinue: boolean) => {
    const behavior = behaviors[Math.min(idx, behaviors.length - 1)]!
    idx++
    onAttempt?.()
    if (!viaContinue) messages.push({ role: 'user' })
    if (behavior === 'throw-before-assistant') {
      // provider dies before writing any assistant message: trailing leaf stays 'user'
      throw new Error('provider_transport_failure')
    }
    if (behavior === 'throw-transient') {
      messages.push({ role: 'assistant', stopReason: 'error' })
      throw new Error('socket hang up')
    }
    if (behavior === 'soft-transient' || behavior === 'soft-throttle' || behavior === 'soft-observer-ttfb-timeout') {
      messages.push({ role: 'assistant', stopReason: 'error' })
      const errorMessage =
        behavior === 'soft-throttle'
          ? '429 Too Many Requests'
          : behavior === 'soft-observer-ttfb-timeout'
            ? 'openai-codex timed out before response headers after 30000ms (typeclaw observer timeout)'
            : 'ECONNRESET'
      for (const cb of listeners)
        cb({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage } })
      return
    }
    messages.push({ role: 'assistant', stopReason: 'stop' })
  }
  const session = {
    prompt: async () => run(false),
    subscribe: (cb: (event: FakeEvent) => void) => {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    setModel: async () => {},
    agent: {
      state: {
        get messages() {
          return messages
        },
        set messages(v: Array<{ role: string; stopReason?: string }>) {
          messages.length = 0
          messages.push(...v)
        },
      },
      continue: async () => run(true),
    },
  } as unknown as AgentSession
  return { session, userMessages: () => messages.filter((m) => m.role === 'user').length, attempts: () => idx }
}

describe('promptPersistentTurnWithFallback no-progress envelope', () => {
  test('surfaces after three logical no-header attempts without starting another attempt', async () => {
    const fake = retryableFakeSession([
      'soft-observer-ttfb-timeout',
      'soft-observer-ttfb-timeout',
      'soft-observer-ttfb-timeout',
      'success',
    ])
    const attemptedRefs: ModelRef[] = []

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B, ANTHROPIC_REF],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      beforeAttempt: (ref) => {
        attemptedRefs.push(ref)
      },
      now: () => 0,
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_B)
    expect(fake.attempts()).toBe(3)
    expect(attemptedRefs).toEqual([REF_A, REF_B])
  })

  test('deep patient mode does not stack patient retries onto repeated TTFB failures', async () => {
    // Three no-progress attempts are the safe minimum: primary + its one
    // ordinary transient replay + one cross-ref fallback. Patient capacity
    // retries must not multiply this TTFB envelope.
    const fake = retryableFakeSession([
      'soft-observer-ttfb-timeout',
      'soft-observer-ttfb-timeout',
      'soft-observer-ttfb-timeout',
      'success',
    ])

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, ANTHROPIC_REF],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'review this',
      retryPolicy: 'patient',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      now: () => 0,
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(ANTHROPIC_REF)
    expect(fake.attempts()).toBe(3)
  })

  test('surfaces at 60 seconds of cumulative no-progress before three attempts', async () => {
    let nowMs = 0
    const fake = retryableFakeSession(['soft-observer-ttfb-timeout', 'soft-observer-ttfb-timeout', 'success'], () => {
      nowMs += 30_000
    })

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      now: () => nowMs,
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.attempts()).toBe(2)
  })

  test('accrues only per-attempt elapsed, so a backward clock jump cannot prematurely exhaust the cap', async () => {
    // A large backward jump between attempts (simulating an NTP/system-clock
    // correction) must not inflate cumulativeNoProgressMs: each attempt only
    // contributes its own positive elapsed, clamped at 0 by max(0, ...).
    const elapsedPerAttempt = [10_000, 10_000, 10_000]
    let nowMs = 1_000_000_000
    let idx = 0
    const fake = retryableFakeSession(
      ['soft-observer-ttfb-timeout', 'soft-observer-ttfb-timeout', 'soft-observer-ttfb-timeout'],
      () => {
        nowMs += elapsedPerAttempt[idx]!
        idx++
        nowMs -= 500_000_000
      },
    )

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      now: () => nowMs,
    })

    // Surfaces on the 3-attempt cap, not the time cap (each attempt's real
    // elapsed is 10s; the backward jumps must not have accrued negative or
    // inflated time that would trip the 60s cap early or hide the count cap).
    expect(result.success).toBe(false)
    expect(fake.attempts()).toBe(3)
  })

  test('does not abort a progressing stream that runs past 60 seconds', async () => {
    let nowMs = 0
    const fake = fakeSession(['text-then-success'], () => {
      nowMs = 60_001
    })

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      now: () => nowMs,
    })

    expect(nowMs).toBeGreaterThan(60_000)
    expect(result.success).toBe(true)
    expect(fake.prompted).toEqual(['hello'])
  })

  test('keeps post-tool observer-timeout replay blocked', async () => {
    const listeners = new Set<(event: FakeEvent) => void>()
    const messages: Array<{ role: string; stopReason?: string }> = []
    let continueCalls = 0
    const setModels: ModelRef[] = []
    const session = {
      prompt: async () => {
        messages.push({ role: 'user' }, { role: 'assistant', stopReason: 'error' })
        for (const cb of listeners) cb({ type: 'tool_execution_start' })
        for (const cb of listeners) {
          cb({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'openai-codex timed out before response headers after 30000ms (typeclaw observer timeout)',
            },
          })
        }
      },
      subscribe: (cb: (event: FakeEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      agent: {
        state: { messages },
        continue: async () => {
          continueCalls++
        },
      },
    } as unknown as AgentSession

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async (ref) => {
        setModels.push(ref)
      },
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(continueCalls).toBe(0)
    expect(setModels).toEqual([])
  })

  test('does not count a 429 toward the no-progress attempt limit', async () => {
    const fake = retryableFakeSession([
      'soft-throttle',
      'soft-observer-ttfb-timeout',
      'soft-observer-ttfb-timeout',
      'success',
    ])

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B, ANTHROPIC_REF],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      now: () => 0,
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(ANTHROPIC_REF)
    expect(fake.attempts()).toBe(4)
  })
})

describe('promptPersistentTurnWithFallback same-ref retry', () => {
  test('an authorized retry resumes from a completed tool result despite tool activity', async () => {
    const listeners = new Set<(event: FakeEvent) => void>()
    const messages: Array<{ role: string; stopReason?: string }> = []
    let promptCalls = 0
    let continueCalls = 0
    const session = {
      prompt: async () => {
        promptCalls++
        messages.push(
          { role: 'user' },
          { role: 'assistant', stopReason: 'toolUse' },
          { role: 'toolResult' },
          { role: 'assistant', stopReason: 'error' },
        )
        for (const cb of listeners) cb({ type: 'tool_execution_start' })
        for (const cb of listeners) cb({ type: 'tool_execution_end' })
        for (const cb of listeners) {
          cb({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'WebSocket closed 1000' },
          })
        }
      },
      subscribe: (cb: (event: FakeEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      agent: {
        state: { messages },
        continue: async () => {
          continueCalls++
          messages.push({ role: 'assistant', stopReason: 'stop' })
        },
      },
    } as unknown as AgentSession

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      authorizeRetryAfterCompletedToolResult: () => true,
    })

    expect(result.success).toBe(true)
    expect(promptCalls).toBe(1)
    expect(continueCalls).toBe(1)
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  test('an authorized post-tool capacity retry waits the selected overload delay', async () => {
    // given: an overload arriving right after a completed tool result, and a
    // retryRandom that would make the ORDINARY blip curve sleep its 1000ms max.
    // The overload budget picks 0ms, so consulting retryRandom at all means the
    // post-tool path fell back to the wrong curve.
    const listeners = new Set<(event: FakeEvent) => void>()
    const messages: Array<{ role: string; stopReason?: string }> = []
    let continueCalls = 0
    let randomCalls = 0
    const session = {
      prompt: async () => {
        messages.push(
          { role: 'user' },
          { role: 'assistant', stopReason: 'toolUse' },
          { role: 'toolResult' },
          { role: 'assistant', stopReason: 'error' },
        )
        for (const cb of listeners) cb({ type: 'tool_execution_start' })
        for (const cb of listeners) cb({ type: 'tool_execution_end' })
        for (const cb of listeners) {
          cb({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'server_is_overloaded' },
          })
        }
      },
      subscribe: (cb: (event: FakeEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      agent: {
        state: { messages },
        continue: async () => {
          continueCalls++
          messages.push({ role: 'assistant', stopReason: 'stop' })
        },
      },
    } as unknown as AgentSession

    const startedAt = performance.now()
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      authorizeRetryAfterCompletedToolResult: () => true,
      overloadBackoffMs: () => 0,
      retryRandom: () => {
        randomCalls++
        return 1
      },
    })

    expect(result.success).toBe(true)
    expect(continueCalls).toBe(1)
    expect(randomCalls).toBe(0)
    expect(performance.now() - startedAt).toBeLessThan(500)
  })

  test('authorization alone cannot retry an unsafe transcript tail', async () => {
    const listeners = new Set<(event: FakeEvent) => void>()
    const messages = [{ role: 'user' }, { role: 'assistant', stopReason: 'error' }]
    const originalMessages = messages.map((message) => ({ ...message }))
    let continueCalls = 0
    const session = {
      prompt: async () => {
        for (const cb of listeners) cb({ type: 'tool_execution_start' })
        for (const cb of listeners) {
          cb({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'WebSocket closed 1000' },
          })
        }
      },
      subscribe: (cb: (event: FakeEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      agent: {
        state: { messages },
        continue: async () => {
          continueCalls++
        },
      },
    } as unknown as AgentSession

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      authorizeRetryAfterCompletedToolResult: () => true,
    })

    expect(result.success).toBe(false)
    expect(result.lastError?.message).toBe('WebSocket closed 1000')
    expect(continueCalls).toBe(0)
    expect(messages).toEqual(originalMessages)
  })

  test('passes authorization through for late revalidation before transcript mutation', async () => {
    const listeners = new Set<(event: FakeEvent) => void>()
    const messages = [{ role: 'toolResult' }, { role: 'assistant', stopReason: 'error' }]
    const originalMessages = messages.map((message) => ({ ...message }))
    let authorizationChecks = 0
    let continueCalls = 0
    const session = {
      prompt: async () => {
        for (const cb of listeners) cb({ type: 'tool_execution_start' })
        for (const cb of listeners) {
          cb({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'WebSocket closed 1000' },
          })
        }
      },
      subscribe: (cb: (event: FakeEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      agent: {
        state: { messages },
        continue: async () => {
          continueCalls++
        },
      },
    } as unknown as AgentSession

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      authorizeRetryAfterCompletedToolResult: () => {
        authorizationChecks++
        return authorizationChecks === 1
      },
    })

    expect(result.success).toBe(false)
    expect(authorizationChecks).toBe(2)
    expect(continueCalls).toBe(0)
    expect(messages).toEqual(originalMessages)
  })

  test('authorization and a safe transcript cannot retry a non-retryable provider error', async () => {
    const listeners = new Set<(event: FakeEvent) => void>()
    const messages = [{ role: 'toolResult' }, { role: 'assistant', stopReason: 'error' }]
    const originalMessages = messages.map((message) => ({ ...message }))
    let continueCalls = 0
    const session = {
      prompt: async () => {
        for (const cb of listeners) cb({ type: 'tool_execution_start' })
        for (const cb of listeners) {
          cb({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: '401 Unauthorized' },
          })
        }
      },
      subscribe: (cb: (event: FakeEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      agent: {
        state: { messages },
        continue: async () => {
          continueCalls++
        },
      },
    } as unknown as AgentSession

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
      authorizeRetryAfterCompletedToolResult: () => true,
    })

    expect(result.success).toBe(false)
    expect(result.lastError?.message).toBe('401 Unauthorized')
    expect(continueCalls).toBe(0)
    expect(messages).toEqual(originalMessages)
  })

  test('does not relax tool-activity retry gating without caller authorization', async () => {
    const listeners = new Set<(event: FakeEvent) => void>()
    const messages = [{ role: 'toolResult' }, { role: 'assistant', stopReason: 'error' }]
    let continueCalls = 0
    const session = {
      prompt: async () => {
        for (const cb of listeners) cb({ type: 'tool_execution_start' })
        for (const cb of listeners) {
          cb({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'WebSocket closed 1000' },
          })
        }
      },
      subscribe: (cb: (event: FakeEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      agent: {
        state: { messages },
        continue: async () => {
          continueCalls++
        },
      },
    } as unknown as AgentSession

    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A, REF_B],
      currentModelRef: REF_A,
      session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
    })

    expect(result.success).toBe(false)
    expect(result.refUsed).toBe(REF_A)
    expect(continueCalls).toBe(0)
    expect(messages).toHaveLength(2)
  })

  test('a transient soft error recovers via agent.continue without duplicating the user message', async () => {
    const fake = retryableFakeSession(['soft-transient', 'success'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.attempts()).toBe(2) // one prompt + one continue-retry
    expect(fake.userMessages()).toBe(1) // continue() did NOT re-append the user message
  })

  test('a transient hard throw recovers via agent.continue on the same ref', async () => {
    const fake = retryableFakeSession(['throw-transient', 'success'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
    })

    expect(result.success).toBe(true)
    expect(fake.userMessages()).toBe(1)
  })

  test('recovers a transport failure that died BEFORE the assistant stream started (the reported incident)', async () => {
    // given: first attempt throws provider_transport_failure with only a user leaf
    // in state (no assistant message written); the same-ref continue() then succeeds
    const fake = retryableFakeSession(['throw-before-assistant', 'success'])
    const result = await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hello',
      circuit: new ThrottleCircuit(),
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
    })

    expect(result.success).toBe(true)
    expect(result.refUsed).toBe(REF_A)
    expect(fake.attempts()).toBe(2) // prompt threw pre-stream, continue() recovered
    expect(fake.userMessages()).toBe(1) // no duplicate user message
  })

  test('a single turn does not self-trip the throttle circuit across same-ref retries', async () => {
    // given: the ref keeps failing transiently for the whole retry budget
    const circuit = new ThrottleCircuit()
    const fake = retryableFakeSession(['soft-transient', 'soft-transient', 'soft-transient'])
    await promptPersistentTurnWithFallback({
      refs: [REF_A],
      currentModelRef: REF_A,
      profile: 'default',
      session: fake.session,
      text: 'hello',
      circuit,
      // ECONNRESET is retryable-same-ref but NOT failover-worthy, so shouldFailover
      // is false — no throttle should be recorded at all here.
      shouldFailover: (err) => isFailoverWorthy(err.message),
      setModelForRef: async () => {},
    })

    // one throttle record would need THRESHOLD(2) to open; a single turn must not
    // reach it — the circuit stays closed for REF_A.
    expect(circuit.isOpen({ profile: 'default', ref: REF_A })).toBe(false)
  })
})

describe('promptPersistentTurnWithFallback overload retry on the last usable ref', () => {
  const patientOpts = {
    circuit: new ThrottleCircuit(),
    shouldFailover: (err: Error) => isFailoverWorthy(err.message),
    setModelForRef: async () => {},
    overloadBackoffMs: () => 0,
  }

  test('rides out a capacity outage on a single-ref chain and recovers', async () => {
    const fake = retryableFakeSession(['soft-throttle', 'soft-throttle', 'soft-throttle', 'success'])

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [ANTHROPIC_REF],
      currentModelRef: ANTHROPIC_REF,
      session: fake.session,
      text: 'review this',
      retryPolicy: 'patient',
    })

    expect(result.success).toBe(true)
    expect(fake.attempts()).toBe(4)
  })

  test('a responsive call site rides out a brief dip on a single-ref chain', async () => {
    const fake = retryableFakeSession(['soft-throttle', 'soft-throttle', 'success'])

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [ANTHROPIC_REF],
      currentModelRef: ANTHROPIC_REF,
      session: fake.session,
      text: 'hi',
      retryPolicy: 'responsive',
    })

    expect(result.success).toBe(true)
    expect(fake.attempts()).toBe(3)
    expect(fake.userMessages()).toBe(1)
  })

  test('omitting retryPolicy still recovers, on the responsive budget', async () => {
    const fake = retryableFakeSession(['soft-throttle', 'success'])

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [ANTHROPIC_REF],
      currentModelRef: ANTHROPIC_REF,
      session: fake.session,
      text: 'hi',
    })

    expect(result.success).toBe(true)
    expect(fake.attempts()).toBe(2)
  })

  test('gives up once the responsive retry budget is exhausted', async () => {
    const fake = retryableFakeSession(['soft-throttle'])

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [ANTHROPIC_REF],
      currentModelRef: ANTHROPIC_REF,
      session: fake.session,
      text: 'hi',
      retryPolicy: 'responsive',
    })

    expect(result.success).toBe(false)
    expect(fake.attempts()).toBe(RESPONSIVE_OVERLOAD_RETRIES + 1)
  })

  test('a responsive turn waits far less than a patient one', async () => {
    expect(RESPONSIVE_OVERLOAD_RETRIES).toBeLessThan(PATIENT_OVERLOAD_RETRIES)
    expect(RESPONSIVE_OVERLOAD_WINDOW_MS).toBeLessThan(PATIENT_OVERLOAD_WINDOW_MS)
  })

  test('a responsive non-terminal ref fails OVER instead of waiting', async () => {
    const fake = retryableFakeSession(['soft-throttle', 'success'])
    const attemptedRefs: ModelRef[] = []

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [REF_A, ANTHROPIC_REF],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'hi',
      retryPolicy: 'responsive',
      beforeAttempt: (ref) => {
        attemptedRefs.push(ref)
      },
    })

    expect(result.success).toBe(true)
    expect(attemptedRefs).toEqual([REF_A, ANTHROPIC_REF])
    expect(fake.attempts()).toBe(2)
  })

  test('gives up once the patient retry budget is exhausted', async () => {
    const fake = retryableFakeSession(['soft-throttle'])

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [ANTHROPIC_REF],
      currentModelRef: ANTHROPIC_REF,
      session: fake.session,
      text: 'review this',
      retryPolicy: 'patient',
    })

    expect(result.success).toBe(false)
    expect(fake.attempts()).toBe(PATIENT_OVERLOAD_RETRIES + 1)
  })

  test('stops retrying once the patient window has elapsed', async () => {
    const fake = retryableFakeSession(['soft-throttle'])
    let clock = 0

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [ANTHROPIC_REF],
      currentModelRef: ANTHROPIC_REF,
      session: fake.session,
      text: 'review this',
      retryPolicy: 'patient',
      now: () => {
        clock += PATIENT_OVERLOAD_WINDOW_MS
        return clock
      },
    })

    expect(result.success).toBe(false)
    expect(fake.attempts()).toBeLessThan(PATIENT_OVERLOAD_RETRIES + 1)
  })

  test('rejects a retry whose backoff would start after the advertised window', async () => {
    // given: a clock that lands 50ms inside the window, leaving no room for the
    // 100ms backoff -- elapsed alone still passes, elapsed + backoff does not
    const BACKOFF_MS = 100
    const STEP_MS = PATIENT_OVERLOAD_WINDOW_MS - 50
    let clock = 0
    const fake = retryableFakeSession(['soft-throttle'], () => {
      clock += STEP_MS
    })

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [ANTHROPIC_REF],
      currentModelRef: ANTHROPIC_REF,
      session: fake.session,
      text: 'review this',
      retryPolicy: 'patient',
      overloadBackoffMs: () => BACKOFF_MS,
      now: () => clock,
    })

    // then: only the first retry is taken. A window check that ignored the
    // backoff would have accepted a second one and started it past the deadline.
    expect(result.success).toBe(false)
    expect(fake.attempts()).toBe(2)
  })

  test('a non-terminal ref fails OVER immediately instead of waiting patiently', async () => {
    const fake = retryableFakeSession(['soft-throttle', 'soft-throttle', 'success'])
    const attemptedRefs: ModelRef[] = []

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [REF_A, ANTHROPIC_REF],
      currentModelRef: REF_A,
      session: fake.session,
      text: 'review this',
      retryPolicy: 'patient',
      beforeAttempt: (ref) => {
        attemptedRefs.push(ref)
      },
    })

    expect(result.success).toBe(true)
    expect(attemptedRefs).toEqual([REF_A, ANTHROPIC_REF])
    expect(fake.attempts()).toBe(3)
  })

  test('refuses a patient replay after the model already produced output', async () => {
    const fake = fakeSession(['text-then-throttle', 'success'])

    const result = await promptPersistentTurnWithFallback({
      ...patientOpts,
      refs: [ANTHROPIC_REF],
      currentModelRef: ANTHROPIC_REF,
      session: fake.session,
      text: 'review this',
      retryPolicy: 'patient',
    })

    expect(result.success).toBe(false)
    expect(fake.prompted).toHaveLength(1)
  })
})
