import { describe, expect, spyOn, test } from 'bun:test'

import { z } from 'zod'

import { noopPermissionService } from '@/permissions'
import type { HookBus, PluginRegistry } from '@/plugin'
import { createStream } from '@/stream'

import * as agentIndex from './index'
import type { AgentSession, PluginSessionWiring } from './index'
import { LiveSubagentRegistry } from './live-subagents'
import {
  createSubagentConsumer,
  defaultCreateSessionForSubagent,
  INCOMPLETE_REVIEW_VERDICT,
  invokeSubagent,
  startSubagent,
  type Subagent,
  validateSubagentPayload,
} from './subagents'

function makeFakeHookBus(events: string[]): HookBus {
  return {
    registerAll: () => {},
    unregisterAll: () => {},
    runSessionStart: async () => {},
    runSessionEnd: async (e) => {
      events.push(`end:${e.sessionId}`)
    },
    runSessionIdle: async (e) => {
      events.push(`idle:${e.sessionId}:${e.parentTranscriptPath ?? '-'}`)
    },
    runSessionPrompt: async () => {},
    runSessionTurnStart: async () => {},
    runSessionTurnEnd: async () => {},
    runToolBefore: async () => undefined,
    runToolAfter: async () => {},
    count: () => 0,
  }
}

function fakeSession(): { session: AgentSession; calls: { prompt: string[]; disposed: number } } {
  const calls = { prompt: [] as string[], disposed: 0 }
  const session = {
    prompt: async (text: string) => {
      calls.prompt.push(text)
    },
    dispose: () => {
      calls.disposed += 1
    },
  } as unknown as AgentSession
  return { session, calls }
}

describe('validateSubagentPayload', () => {
  test('returns parsed payload when schema matches', () => {
    // given
    const schema = z.object({ id: z.string() })
    const subagent: Subagent<{ id: string }> = { systemPrompt: 'X', payloadSchema: schema }

    // when
    const result = validateSubagentPayload('test', subagent, { id: 'abc' })

    // then
    expect(result).toEqual({ id: 'abc' })
  })

  test('throws when schema does not match', () => {
    // given
    const schema = z.object({ id: z.string() })
    const subagent: Subagent<{ id: string }> = { systemPrompt: 'X', payloadSchema: schema }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, { id: 42 })).toThrow(/invalid payload/)
  })

  test('throws when subagent has no schema but payload is provided', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, { foo: 'bar' })).toThrow(/does not accept a payload/)
  })

  test('error message describes the received value type to disambiguate undefined vs null vs object', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, null)).toThrow(/received null/)
    expect(() => validateSubagentPayload('test', subagent, { foo: 1 })).toThrow(/received object/)
    expect(() => validateSubagentPayload('test', subagent, [1, 2])).toThrow(/received array/)
    expect(() => validateSubagentPayload('test', subagent, 'oops')).toThrow(/received string/)
  })

  test('passes when subagent has no schema and payload is undefined', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when
    const result = validateSubagentPayload('test', subagent, undefined)

    // then
    expect(result).toBeUndefined()
  })
})

describe('invokeSubagent', () => {
  test('throws on unknown subagent name', async () => {
    // when / then
    await expect(
      invokeSubagent('missing', {
        registry: {},
        createSessionForSubagent: async () => fakeSession().session,
        agentDir: '/agent',
        userPrompt: 'hi',
      }),
    ).rejects.toThrow(/unknown subagent: missing/)
  })

  test('default execution prompts the session with the user prompt and disposes', async () => {
    // given
    const { session, calls } = fakeSession()
    const registry = { greeter: { systemPrompt: 'You are a greeter.' } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'say hello',
    })

    // then
    expect(calls.prompt).toEqual([expect.stringContaining('say hello')])
    expect(calls.disposed).toBe(1)
  })

  test('a `profile` field in the validated payload is threaded to createSessionForSubagent as profileOverride', async () => {
    // given
    const captured: { profileOverride?: string }[] = []
    const registry = {
      worker: {
        systemPrompt: 'X',
        profile: 'default',
        payloadSchema: z.object({ prompt: z.string().optional(), profile: z.string().optional() }).passthrough(),
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('worker', {
      registry,
      createSessionForSubagent: async (_subagent, options) => {
        captured.push({ profileOverride: options?.profileOverride })
        return fakeSession().session
      },
      agentDir: '/agent',
      userPrompt: 'do the thing',
      payload: { prompt: 'do the thing', profile: 'deep' },
    })

    // then
    expect(captured).toHaveLength(1)
    expect(captured[0]!.profileOverride).toBe('deep')
  })

  test('no `profile` in the payload leaves profileOverride undefined (subagent keeps its declared profile)', async () => {
    // given
    const captured: { profileOverride?: string }[] = []
    const registry = {
      worker: {
        systemPrompt: 'X',
        profile: 'default',
        payloadSchema: z.object({ prompt: z.string().optional(), profile: z.string().optional() }).passthrough(),
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('worker', {
      registry,
      createSessionForSubagent: async (_subagent, options) => {
        captured.push({ profileOverride: options?.profileOverride })
        return fakeSession().session
      },
      agentDir: '/agent',
      userPrompt: 'do the thing',
      payload: { prompt: 'do the thing' },
    })

    // then
    expect(captured[0]!.profileOverride).toBeUndefined()
  })

  test('a payload whose schema strips `profile` leaves profileOverride undefined (fast-tier pin survives a parent override)', async () => {
    // given: a worker whose schema drops `profile`, exactly like scout/explorer
    const captured: { profileOverride?: string }[] = []
    const registry = {
      worker: {
        systemPrompt: 'X',
        profile: 'fast',
        payloadSchema: z
          .object({ prompt: z.string().optional() })
          .passthrough()
          .transform(({ profile: _profile, ...rest }) => rest),
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('worker', {
      registry,
      createSessionForSubagent: async (_subagent, options) => {
        captured.push({ profileOverride: options?.profileOverride })
        return fakeSession().session
      },
      agentDir: '/agent',
      userPrompt: 'do the thing',
      payload: { prompt: 'do the thing', profile: 'deep' },
    })

    // then
    expect(captured[0]!.profileOverride).toBeUndefined()
  })

  test('handler receives validated payload and runs runSession when called', async () => {
    // given
    const { session, calls } = fakeSession()
    const schema = z.object({ name: z.string() })
    const registry = {
      greeter: {
        systemPrompt: 'You are a greeter.',
        payloadSchema: schema,
        handler: async (ctx, runSession) => {
          await runSession({ userPrompt: `hello ${ctx.payload.name}` })
        },
      } satisfies Subagent<{ name: string }>,
    }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'unused default',
      payload: { name: 'Neo' },
    })

    // then
    expect(calls.prompt).toEqual([expect.stringContaining('hello Neo')])
    expect(calls.disposed).toBe(1)
  })

  test('passes the completed assistant response to the handler before disposal', async () => {
    const listeners = new Set<(event: unknown) => void>()
    let captured = null as string | null
    const session = {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      prompt: async () => {
        for (const listener of listeners) {
          listener({
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: 'fix: repair app' }] },
          })
        }
        expect(captured).toBeNull()
      },
      dispose: () => {},
    } as unknown as AgentSession
    await invokeSubagent('message', {
      registry: {
        message: {
          systemPrompt: 'Return a commit message.',
          handler: async (_ctx, runSession) => {
            await runSession({
              onFinalMessage: (text) => {
                captured = text
              },
            })
          },
        },
      },
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'choose a message',
    })
    expect(captured).toBe('fix: repair app')
  })

  test('handler callback receives terminal assistant text, not an earlier review block or nonempty message', async () => {
    for (const [name, messages, expected] of [
      ['message', ['first answer', ''], null],
      ['reviewer', ['<review>approved</review>', 'final plain-language summary'], 'final plain-language summary'],
      ['researcher', ['<report>findings</report>', 'final plain-language summary'], 'final plain-language summary'],
    ] as const) {
      const listeners = new Set<(event: unknown) => void>()
      const session = {
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        prompt: async () => {
          for (const content of messages) {
            for (const listener of listeners) listener({ type: 'message_end', message: { role: 'assistant', content } })
          }
        },
        dispose: () => {},
      } as unknown as AgentSession
      let received = 'not-called' as string | null
      await invokeSubagent(name, {
        registry: {
          [name]: {
            systemPrompt: 'Return final text.',
            handler: async (_ctx, runSession) => {
              await runSession({
                onFinalMessage: (text) => {
                  received = text
                },
              })
            },
          },
        },
        createSessionForSubagent: async () => session,
        agentDir: '/agent',
        userPrompt: 'q',
      })
      expect(received).toBe(expected)
    }
  })

  test('handler callback discards earlier text after a soft provider failure', async () => {
    const listeners = new Set<(event: unknown) => void>()
    let leafMessage: unknown
    const session = {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      prompt: async () => {
        for (const listener of listeners) {
          listener({ type: 'message_end', message: { role: 'assistant', content: 'stale subject' } })
          leafMessage = {
            role: 'assistant',
            content: 'feat: incomplete',
            stopReason: 'error',
            errorMessage: 'provider failed',
          }
          listener({ type: 'message_end', message: leafMessage })
        }
      },
      dispose: () => {},
      sessionManager: { getLeafEntry: () => ({ type: 'message', message: leafMessage }) },
    } as unknown as AgentSession
    let received = 'not-called' as string | null
    await invokeSubagent('message', {
      registry: {
        message: {
          systemPrompt: 'Return a commit message.',
          handler: async (_ctx, runSession) => {
            await runSession({
              onFinalMessage: (text) => {
                received = text
              },
            })
          },
        },
      },
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'choose a message',
    })
    expect(received).toBeNull()
  })

  test('handler may skip the session entirely', async () => {
    // given
    const { session, calls } = fakeSession()
    const registry = {
      lazy: {
        systemPrompt: 'X',
        handler: async () => {
          // intentionally never call runSession
        },
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('lazy', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'whatever',
    })

    // then
    expect(calls.prompt).toEqual([])
    expect(calls.disposed).toBe(0)
  })

  test('handler may call runSession multiple times, creating fresh sessions each time', async () => {
    // given
    const fakes: ReturnType<typeof fakeSession>[] = []
    const registry = {
      twice: {
        systemPrompt: 'X',
        handler: async (_ctx, runSession) => {
          await runSession({ userPrompt: 'first' })
          await runSession({ userPrompt: 'second' })
        },
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('twice', {
      registry,
      createSessionForSubagent: async () => {
        const f = fakeSession()
        fakes.push(f)
        return f.session
      },
      agentDir: '/agent',
      userPrompt: 'unused',
    })

    // then
    expect(fakes).toHaveLength(2)
    expect(fakes[0]!.calls.prompt).toEqual([expect.stringContaining('first')])
    expect(fakes[1]!.calls.prompt).toEqual([expect.stringContaining('second')])
    expect(fakes[0]!.calls.disposed).toBe(1)
    expect(fakes[1]!.calls.disposed).toBe(1)
  })

  test('payload validation errors surface before any session is created', async () => {
    // given
    let createCalled = false
    const schema = z.object({ id: z.string() })
    const registry = {
      strict: { systemPrompt: 'X', payloadSchema: schema, handler: async () => {} } satisfies Subagent<{ id: string }>,
    }

    // when / then
    await expect(
      invokeSubagent('strict', {
        registry,
        createSessionForSubagent: async () => {
          createCalled = true
          return fakeSession().session
        },
        agentDir: '/agent',
        userPrompt: 'x',
        payload: { id: 42 },
      }),
    ).rejects.toThrow(/invalid payload/)
    expect(createCalled).toBe(false)
  })

  test('disposes the session even when the prompt throws', async () => {
    // given
    const calls = { disposed: 0 }
    const session = {
      prompt: async () => {
        throw new Error('boom')
      },
      dispose: () => {
        calls.disposed += 1
      },
    } as unknown as AgentSession
    const registry = { fragile: { systemPrompt: 'X' } satisfies Subagent }

    // when / then
    await expect(
      invokeSubagent('fragile', {
        registry,
        createSessionForSubagent: async () => session,
        agentDir: '/agent',
        userPrompt: 'crash',
      }),
    ).rejects.toThrow(/boom/)
    expect(calls.disposed).toBe(1)
  })

  test('fires session.idle and session.end on the supplied HookBus around runSession', async () => {
    // given
    const { session } = fakeSession()
    const events: string[] = []
    const hooks = makeFakeHookBus(events)
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => ({
        session,
        hooks,
        sessionId: 'sub-sess-1',
        getTranscriptPath: () => '/tmp/sub-transcript.jsonl',
      }),
      agentDir: '/agent',
      userPrompt: 'hi',
    })

    // then
    expect(events).toEqual(['idle:sub-sess-1:/tmp/sub-transcript.jsonl', 'end:sub-sess-1'])
  })

  test('appends retrievalContext.results from session.turn.start to the subagent prompt text', async () => {
    // given: a turn-start hook that injects per-turn memory (vector agents)
    const { session, calls } = fakeSession()
    const hooks = makeFakeHookBus([])
    hooks.runSessionTurnStart = async (e) => {
      if (e.retrievalContext !== undefined) e.retrievalContext.results = '# Memory\n\nsubagent fact'
    }
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => ({ session, hooks, sessionId: 'sub-mem', agentDir: '/agent' }),
      agentDir: '/agent',
      userPrompt: 'hi there',
    })

    // then: the prompt carries the user text, the time anchor, and injected memory
    expect(calls.prompt).toHaveLength(1)
    expect(calls.prompt[0]).toContain('hi there')
    expect(calls.prompt[0]).toContain('# Memory\n\nsubagent fact')
  })

  test('fires session.end even when the prompt throws so plugins can react to abnormal subagent termination', async () => {
    // given
    const events: string[] = []
    const hooks = makeFakeHookBus(events)
    const session = {
      prompt: async () => {
        throw new Error('subagent boom')
      },
      dispose: () => {},
    } as unknown as AgentSession
    const registry = { fragile: { systemPrompt: 'X' } satisfies Subagent }

    // when / then
    await expect(
      invokeSubagent('fragile', {
        registry,
        createSessionForSubagent: async () => ({ session, hooks, sessionId: 'sub-boom' }),
        agentDir: '/agent',
        userPrompt: 'crash',
      }),
    ).rejects.toThrow(/subagent boom/)
    expect(events).toEqual(['end:sub-boom'])
  })
})

describe('createSubagentConsumer', () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {} }

  function fakeAgentSession(prompts: string[]): AgentSession {
    return {
      prompt: async (text: string) => {
        prompts.push(text)
      },
      dispose: () => {},
    } as unknown as AgentSession
  }

  test('dispatches a new-session message to the registered subagent handler', async () => {
    // given
    const stream = createStream()
    const handlerCalls: { payload: unknown }[] = []
    const registry = {
      greeter: {
        systemPrompt: 'X',
        payloadSchema: z.object({ who: z.string() }),
        handler: async (ctx) => {
          handlerCalls.push({ payload: ctx.payload })
        },
      } satisfies Subagent<{ who: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      logger: silent,
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'greeter' }, payload: { who: 'neo' } })
    await new Promise((r) => setImmediate(r))

    // then
    expect(handlerCalls).toEqual([{ payload: { who: 'neo' } }])

    consumer.stop()
  })

  test('preserves a system spawnedByOrigin through JSON parse (not dropped to guest)', async () => {
    // given: a streamed spawn whose spawnedByOrigin is a system origin —
    // exactly how the memory plugin's spawn reaches a stream consumer once
    // serialized. Regression guard for SESSION_ORIGIN_KINDS dropping 'system'.
    const stream = createStream()
    const captured: { spawnedByOrigin?: unknown }[] = []
    // No custom handler: only the session path threads spawnedByOrigin into
    // createSessionForSubagent. A handler-based subagent never sees the origin.
    const registry = {
      'memory-logger': {
        systemPrompt: 'X',
        payloadSchema: z.object({ agentDir: z.string() }),
      } satisfies Subagent<{ agentDir: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async (_subagent, options) => {
        captured.push({ spawnedByOrigin: options?.spawnedByOrigin })
        return fakeAgentSession([])
      },
      logger: silent,
    })
    consumer.start()

    // when
    const systemOrigin = { kind: 'system', component: 'memory-logger' }
    stream.publish({
      target: {
        kind: 'new-session',
        subagent: 'memory-logger',
        spawnedByOriginJson: JSON.stringify(systemOrigin),
      },
      payload: { agentDir: '/agent' },
    })
    await new Promise((r) => setImmediate(r))

    // then: the system origin survived parsing and reached the spawn
    expect(captured).toHaveLength(1)
    expect(captured[0]!.spawnedByOrigin).toEqual(systemOrigin)

    consumer.stop()
  })

  test('warns and ignores messages for unregistered subagent names', async () => {
    // given
    const stream = createStream()
    const warnings: string[] = []
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => ({}),
      agentDir: '/agent',
      logger: { ...silent, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'no-such-thing' }, payload: null })
    await new Promise((r) => setImmediate(r))

    // then
    expect(warnings.some((w) => /no registered subagent/.test(w))).toBe(true)

    consumer.stop()
  })

  test('coalesces concurrent invocations using inFlightKey', async () => {
    // given: a slow subagent and an inFlightKey that ignores payload, so two
    // concurrent messages collapse into one execution.
    const stream = createStream()
    const handlerCalls: number[] = []
    let resolveFirst: () => void = () => {}
    const registry = {
      slow: {
        systemPrompt: 'X',
        handler: async () => {
          handlerCalls.push(1)
          await new Promise<void>((r) => {
            resolveFirst = r
          })
        },
      } satisfies Subagent,
    }
    const warnings: string[] = []
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      inFlightKey: (name) => name,
      logger: { ...silent, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    // when: two messages fire while the first is still running
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: undefined })
    await new Promise((r) => setImmediate(r))
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: undefined })
    await new Promise((r) => setImmediate(r))

    // then: only one handler call so far; the second was coalesced
    expect(handlerCalls).toEqual([1])
    expect(warnings.some((w) => /previous run still in progress/.test(w))).toBe(true)

    resolveFirst()
    await new Promise((r) => setImmediate(r))
    consumer.stop()
  })

  test('different inFlightKey buckets allow concurrent execution', async () => {
    // given
    const stream = createStream()
    const concurrent: string[] = []
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })
    const registry = {
      bucketed: {
        systemPrompt: 'X',
        payloadSchema: z.object({ id: z.string() }),
        handler: async (ctx) => {
          concurrent.push(`start:${ctx.payload.id}`)
          await gate
          concurrent.push(`end:${ctx.payload.id}`)
        },
      } satisfies Subagent<{ id: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      inFlightKey: (name, payload) => `${name}:${(payload as { id: string }).id}`,
      logger: silent,
    })
    consumer.start()

    // when: two messages with different IDs fire while the first is gated
    stream.publish({ target: { kind: 'new-session', subagent: 'bucketed' }, payload: { id: 'a' } })
    stream.publish({ target: { kind: 'new-session', subagent: 'bucketed' }, payload: { id: 'b' } })
    await new Promise((r) => setImmediate(r))

    // then: both handlers started before either finished
    expect(concurrent.filter((s) => s.startsWith('start:'))).toEqual(['start:a', 'start:b'])

    releaseGate()
    await new Promise((r) => setImmediate(r))
    consumer.stop()
  })

  test('removes inFlight entry when handler throws', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const registry = {
      explodes: {
        systemPrompt: 'X',
        handler: async () => {
          throw new Error('boom')
        },
      } satisfies Subagent,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      logger: { ...silent, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'explodes' }, payload: undefined })
    await new Promise((r) => setImmediate(r))

    // then: the error was logged and inFlight is now empty
    expect(errors.some((e) => /boom/.test(e))).toBe(true)
    expect(consumer.inFlightCount()).toBe(0)

    consumer.stop()
  })

  test('timeoutMs releases the inFlight coalesce key when a spawn exceeds its ceiling', async () => {
    // given: a subagent whose handler never settles (mirrors a wedged
    // provider call) and a 30ms timeoutMs. Without the ceiling, the second
    // spawn would stay coalesce-skipped forever; with it, the timeout fires,
    // the key releases, and the second spawn proceeds.
    const stream = createStream()
    const warnings: string[] = []
    const completions: string[] = []
    let firstStarted = false
    const registry = {
      wedge: {
        systemPrompt: 'X',
        timeoutMs: 30,
        handler: async () => {
          if (!firstStarted) {
            firstStarted = true
            await new Promise<void>(() => {})
            return
          }
          completions.push('second')
        },
      } satisfies Subagent,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      logger: { ...silent, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    // when: first spawn wedges, then a second spawn fires after the timeout
    stream.publish({ target: { kind: 'new-session', subagent: 'wedge' }, payload: undefined })
    await new Promise((r) => setTimeout(r, 50))
    stream.publish({ target: { kind: 'new-session', subagent: 'wedge' }, payload: undefined })
    await new Promise((r) => setTimeout(r, 30))

    // then: the timeout was logged with attribution, the coalesce key was
    // released, and the second spawn ran to completion.
    expect(warnings.some((w) => /timed out after 30ms/.test(w) && /releasing coalesce key/.test(w))).toBe(true)
    expect(completions).toEqual(['second'])
    expect(consumer.inFlightCount()).toBe(0)

    consumer.stop()
  })

  test('undefined timeoutMs preserves legacy behavior (waits for the spawn to settle)', async () => {
    // given: a slow subagent with no timeoutMs. The first spawn must
    // complete before the second runs — same coalescing semantics as before
    // this surface existed.
    const stream = createStream()
    const completions: string[] = []
    let releaseFirst: () => void = () => {}
    const registry = {
      slow: {
        systemPrompt: 'X',
        handler: async (ctx) => {
          const id = (ctx.payload as { id: string }).id
          if (id === 'first') {
            await new Promise<void>((r) => {
              releaseFirst = r
            })
          }
          completions.push(id)
        },
        payloadSchema: z.object({ id: z.string() }),
      } satisfies Subagent<{ id: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      inFlightKey: (name) => name,
      logger: silent,
    })
    consumer.start()

    // when: two spawns fire while the first is gated
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: { id: 'first' } })
    await new Promise((r) => setImmediate(r))
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: { id: 'second' } })
    await new Promise((r) => setImmediate(r))

    // then: only the first started; the second was coalesce-skipped
    expect(completions).toEqual([])

    // when: release the first
    releaseFirst()
    await new Promise((r) => setImmediate(r))

    // then: only the first completed; the coalesce-skipped second was dropped
    // by the consumer (not re-queued) — same as today's behavior.
    expect(completions).toEqual(['first'])
    expect(consumer.inFlightCount()).toBe(0)

    consumer.stop()
  })

  test('logs LLM soft errors emitted via message_end during prompt() so `typeclaw logs` surfaces them', async () => {
    // given: a subagent whose underlying session emits a message_end with
    // stopReason=error during prompt(), mirroring how pi-coding-agent
    // reports billing/rate-limit failures (resolves normally, doesn't throw).
    const stream = createStream()
    const errors: string[] = []
    type Listener = (event: { type: string; message?: unknown }) => void
    const sessionWithSubscribe = (): AgentSession => {
      const listeners = new Set<Listener>()
      return {
        prompt: async () => {
          for (const cb of listeners) {
            cb({
              type: 'message_end',
              message: { role: 'assistant', stopReason: 'error', errorMessage: 'billing failed' },
            })
          }
        },
        dispose: () => {},
        subscribe: (cb: Listener) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
      } as unknown as AgentSession
    }
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => sessionWithSubscribe(),
      logger: { ...silent, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'greeter' }, payload: undefined })
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors.some((e) => /\[subagent\] greeter: LLM call failed: billing failed/.test(e))).toBe(true)

    consumer.stop()
  })
})

describe('startSubagent', () => {
  function subscribableFakeSession(): {
    session: AgentSession
    calls: { prompt: string[]; disposed: number }
    emit: (event: unknown) => void
  } {
    const calls = { prompt: [] as string[], disposed: 0 }
    const listeners = new Set<(event: unknown) => void>()
    const session = {
      prompt: async (text: string) => {
        calls.prompt.push(text)
      },
      dispose: () => {
        calls.disposed += 1
      },
      subscribe: (l: (event: unknown) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      abort: async () => {},
    } as unknown as AgentSession
    return {
      session,
      calls,
      emit: (event) => {
        for (const l of listeners) l(event)
      },
    }
  }

  test('handle promise resolves before completion settles, with the taskId we provided', async () => {
    // given
    const { session } = subscribableFakeSession()
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { handle, completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'hi',
      taskId: 'bg_xyz',
    })

    // then
    const h = await handle
    expect(h.taskId).toBe('bg_xyz')
    await completion
  })

  test('completion resolves ok=true when prompt finishes', async () => {
    // given
    const { session, calls } = subscribableFakeSession()
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'hello',
      taskId: 'bg_1',
    })
    const result = await completion

    // then
    expect(result.ok).toBe(true)
    expect(calls.prompt).toEqual([expect.stringContaining('hello')])
    expect(calls.disposed).toBe(1)
  })

  test('completion captures the final assistant message', async () => {
    // given
    const listeners = new Set<(event: unknown) => void>()
    const session = {
      prompt: async () => {
        for (const l of listeners) l({ type: 'message_end', message: { content: 'Found 42 results.' } })
      },
      dispose: () => {},
      subscribe: (l: (event: unknown) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_msg',
    })
    const result = await completion

    // then
    if (result.ok) {
      expect(result.finalMessage).toBe('Found 42 results.')
    } else {
      throw new Error(`expected ok=true, got error: ${result.error}`)
    }
  })

  function emittingSession(messages: { role?: string; content: unknown }[]): AgentSession {
    const listeners = new Set<(event: unknown) => void>()
    return {
      prompt: async () => {
        for (const message of messages) for (const l of listeners) l({ type: 'message_end', message })
      },
      dispose: () => {},
      subscribe: (l: (event: unknown) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      abort: async () => {},
    } as unknown as AgentSession
  }

  async function captureFinal(messages: { role?: string; content: unknown }[]): Promise<string | undefined> {
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => emittingSession(messages),
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_cap',
    })
    const result = await completion
    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    return result.finalMessage
  }

  test('a trailing summary does not clobber an earlier <review> block (the production regression)', async () => {
    const review = '<review>\n<verdict>request-changes</verdict>\n</review>'
    const final = await captureFinal([
      { role: 'assistant', content: review },
      { role: 'assistant', content: 'Review delivered in the <review> block above.' },
    ])
    expect(final).toBe(review)
  })

  test('a revised <review> block wins over an earlier one (last valid block, not first)', async () => {
    const stale = '<review>\n<verdict>approve</verdict>\n</review>'
    const revised = '<review>\n<verdict>request-changes</verdict>\n</review>'
    const final = await captureFinal([
      { role: 'assistant', content: stale },
      { role: 'assistant', content: revised },
    ])
    expect(final).toBe(revised)
  })

  test('returns only the <review> block, stripping same-message preamble and trailing chatter', async () => {
    const review = '<review>\n<verdict>request-changes</verdict>\n</review>'
    const final = await captureFinal([
      { role: 'assistant', content: `Here is the review:\n${review}\nDone — let me know.` },
    ])
    expect(final).toBe(review)
  })

  test('returns the last <review> block when a single message contains more than one', async () => {
    const first = '<review>\n<verdict>approve</verdict>\n</review>'
    const second = '<review>\n<verdict>request-changes</verdict>\n</review>'
    const final = await captureFinal([{ role: 'assistant', content: `${first}\n\nrevised:\n${second}` }])
    expect(final).toBe(second)
  })

  test('a bare <review> mention inside fenced text is not treated as a review block', async () => {
    const incidental = 'The diff adds a `<review>` literal but never closes it; flagging that.'
    const final = await captureFinal([{ role: 'assistant', content: incidental }])
    expect(final).toBe(incidental)
  })

  test('falls back to the last assistant message when no <review> block is present', async () => {
    const final = await captureFinal([
      { role: 'assistant', content: 'first pass' },
      { role: 'assistant', content: 'second pass' },
    ])
    expect(final).toBe('second pass')
  })

  test('a non-assistant message_end (user/toolResult echo) does not clobber the assistant final message', async () => {
    const final = await captureFinal([
      { role: 'assistant', content: 'the real answer' },
      { role: 'toolResult', content: 'tool echo that should be ignored' },
    ])
    expect(final).toBe('the real answer')
  })

  test('completion resolves ok=false with error message when prompt throws', async () => {
    // given
    const session = {
      prompt: async () => {
        throw new Error('boom')
      },
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_err',
    })
    const result = await completion

    // then
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('boom')
    }
  })

  test('completion resolves ok=false when the session was aborted by the loop guard', async () => {
    const session = {
      prompt: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
      getAbortReason: () => 'loop_guard:block',
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_loop_abort',
    })
    const result = await completion

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('loop_guard:block')
  })

  test('loop-guard failure preserves an already-captured assistant message', async () => {
    const listeners = new Set<(event: unknown) => void>()
    const session = {
      prompt: async () => {
        for (const listener of listeners) {
          listener({ type: 'message_end', message: { role: 'assistant', content: 'Partial but useful analysis.' } })
        }
      },
      dispose: () => {},
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      abort: async () => {},
      getAbortReason: () => 'loop_guard:deferred_block',
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_loop_recover',
    })
    const result = await completion

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.finalMessage).toBe('Partial but useful analysis.')
  })

  test('loop-guard failure captures output through the awaited agent event stream', async () => {
    const agentListeners = new Set<(event: unknown) => void>()
    const session = {
      agent: {
        subscribe: (listener: (event: unknown) => void) => {
          agentListeners.add(listener)
          return () => agentListeners.delete(listener)
        },
      },
      prompt: async () => {
        for (const listener of agentListeners) {
          listener({ type: 'message_end', message: { role: 'assistant', content: 'Captured before settlement.' } })
        }
      },
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
      getAbortReason: () => 'loop_guard:block',
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_loop_awaited_capture',
    })
    const result = await completion

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.finalMessage).toBe('Captured before settlement.')
  })

  test('a non-loop abort reason keeps the existing successful completion semantics', async () => {
    const session = {
      prompt: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
      getAbortReason: () => 'user_cancelled',
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_other_abort',
    })

    expect((await completion).ok).toBe(true)
  })

  test('timeoutMs settles completion with ok=false when prompt wedges (parent gets woken, not stranded)', async () => {
    // given: a session whose prompt never resolves, and a subagent with a tiny timeout
    let abortCount = 0
    const session = {
      prompt: () => new Promise<void>(() => {}),
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {
        abortCount += 1
      },
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X', timeoutMs: 20 } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_timeout',
    })
    const result = await completion

    // then: the spawn fails (so spawn_subagent fires the FAILED broadcast) and the session is aborted
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('timed out')
    }
    expect(abortCount).toBe(1)
  })

  test('a timeout preserves an already-captured final message so a near-miss result is not discarded', async () => {
    // given: a session that emits a final report, then wedges before settling — the
    // production shape of a researcher that produced its <report> then hit the ceiling
    const listeners = new Set<(event: unknown) => void>()
    const session = {
      prompt: () =>
        new Promise<void>(() => {
          for (const l of listeners)
            l({ type: 'message_end', message: { role: 'assistant', content: 'The finished report body.' } })
        }),
      dispose: () => {},
      subscribe: (l: (event: unknown) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X', timeoutMs: 20 } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_recover',
    })
    const result = await completion

    // then: still a failure (the contract was not honored), but the report rides along
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('timed out')
      expect(result.finalMessage).toBe('The finished report body.')
    }
  })

  test('a timeout with no captured message yields ok=false and no finalMessage', async () => {
    // given: a wedge that never emits any assistant message before the ceiling
    const session = {
      prompt: () => new Promise<void>(() => {}),
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X', timeoutMs: 20 } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_no_recover',
    })
    const result = await completion

    // then
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.finalMessage).toBeUndefined()
    }
  })

  function scriptedResearcherSession(turns: { role?: string; content: unknown }[][]): {
    session: AgentSession
    prompts: string[]
  } {
    const prompts: string[] = []
    const listeners = new Set<(event: unknown) => void>()
    let turnIndex = 0
    const session = {
      prompt: async (text: string) => {
        prompts.push(text)
        const messages = turns[turnIndex] ?? []
        turnIndex++
        for (const message of messages) for (const l of listeners) l({ type: 'message_end', message })
      },
      dispose: () => {},
      subscribe: (l: (event: unknown) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      abort: async () => {},
    } as unknown as AgentSession
    return { session, prompts }
  }

  test('a loop-aborted researcher fails before required-block retries can mask the lifecycle error', async () => {
    const { session, prompts } = scriptedResearcherSession([
      [{ role: 'assistant', content: '<analysis>unfinished</analysis>' }],
    ])
    Object.assign(session, { getAbortReason: () => 'loop_guard:block' })
    const registry = { researcher: { systemPrompt: 'X' } satisfies Subagent }

    const { completion } = startSubagent('researcher', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'research',
      taskId: 'bg_research_loop_abort',
    })
    const result = await completion

    expect(result.ok).toBe(false)
    expect(prompts).toHaveLength(1)
  })

  async function runResearcher(turns: { role?: string; content: unknown }[][]) {
    const { session, prompts } = scriptedResearcherSession(turns)
    const registry = { researcher: { systemPrompt: 'X' } satisfies Subagent }
    const { completion } = startSubagent('researcher', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_researcher',
    })
    const result = await completion
    return { result, prompts }
  }

  function wedgeAfterEmitting(content: string): AgentSession {
    const listeners = new Set<(event: unknown) => void>()
    return {
      prompt: () =>
        new Promise<void>(() => {
          for (const l of listeners) l({ type: 'message_end', message: { role: 'assistant', content } })
        }),
      dispose: () => {},
      subscribe: (l: (event: unknown) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      abort: async () => {},
    } as unknown as AgentSession
  }

  test('researcher: a <report> on the first turn is returned with no recovery nudge', async () => {
    const report = '<report>\n<summary>done</summary>\n</report>'
    const { result, prompts } = await runResearcher([
      [{ role: 'assistant', content: `Writing it now.\n${report}\nFinished.` }],
    ])
    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    expect(result.finalMessage).toBe(report)
    expect(prompts).toHaveLength(1)
  })

  test('researcher: the last <report> block wins within a turn', async () => {
    const stale = '<report>\n<confidence>low</confidence>\n</report>'
    const revised = '<report>\n<confidence>high</confidence>\n</report>'
    const { result, prompts } = await runResearcher([[{ role: 'assistant', content: `${stale}\n${revised}` }]])
    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    expect(result.finalMessage).toBe(revised)
    expect(prompts).toHaveLength(1)
  })

  test('researcher: ends with <analysis> but no <report> → recovers on the nudge (guard, not loud failure)', async () => {
    const report = '<report>\n<summary>recovered</summary>\n</report>'
    const { result, prompts } = await runResearcher([
      [{ role: 'assistant', content: '<analysis>\nplan\n</analysis>' }],
      [{ role: 'assistant', content: report }],
    ])
    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    expect(result.finalMessage).toBe(report)
    expect(prompts).toHaveLength(2) // initial + one recovery nudge
  })

  test('researcher: the recovery nudge asks for the <report> as text and forbids tools', async () => {
    const { prompts } = await runResearcher([
      [{ role: 'assistant', content: '<analysis>\nplan\n</analysis>' }],
      [{ role: 'assistant', content: '<report>\n<summary>ok</summary>\n</report>' }],
    ])
    expect(prompts[1]).toContain('<report>')
    expect(prompts[1]).toContain('Do NOT call any tools')
    expect(prompts[1]).toContain('write_report')
  })

  test('researcher: exhausting the nudge budget installs an honest fallback <report> (not stale preamble, not loud failure)', async () => {
    const analysis = '<analysis>\n**Literal Request**: ...\n</analysis>'
    const { result, prompts } = await runResearcher([
      [{ role: 'assistant', content: analysis }],
      [{ role: 'assistant', content: 'still working, no block yet' }],
      [{ role: 'assistant', content: 'still no block' }],
    ])
    if (!result.ok) throw new Error(`expected ok=true (guard, not loud failure), got error: ${result.error}`)
    expect(prompts).toHaveLength(3) // initial + 2 nudges (MAX_REQUIRED_BLOCK_RETRIES)
    expect(result.finalMessage).toContain('<report>')
    expect(result.finalMessage).toContain('could not complete')
    expect(result.finalMessage).toContain('low')
    expect(result.finalMessage).not.toContain('<analysis>')
  })

  test('researcher: a timeout after a <report> was captured rides the report along (recoverable near-miss)', async () => {
    const report = '<report>\n<summary>done before the ceiling</summary>\n</report>'
    const registry = { researcher: { systemPrompt: 'X', timeoutMs: 20 } satisfies Subagent }
    const { completion } = startSubagent('researcher', {
      registry,
      createSessionForSubagent: async () => wedgeAfterEmitting(report),
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_researcher_timeout',
    })
    const result = await completion
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('timed out')
      expect(result.finalMessage).toBe(report)
    }
  })

  test('researcher: a timeout with only an <analysis> preamble captured has no recoverable report', async () => {
    const registry = { researcher: { systemPrompt: 'X', timeoutMs: 20 } satisfies Subagent }
    const { completion } = startSubagent('researcher', {
      registry,
      createSessionForSubagent: async () => wedgeAfterEmitting('<analysis>\nplan\n</analysis>'),
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_researcher_timeout_norecover',
    })
    const result = await completion
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.finalMessage).toBeUndefined()
    }
  })

  test('a <report> block from a non-researcher subagent is not specially extracted (returned as free-form text)', async () => {
    const withReport = 'Here is my answer.\n<report>\n<summary>x</summary>\n</report>'
    const final = await captureFinal([{ role: 'assistant', content: withReport }])
    expect(final).toBe(withReport)
  })

  async function runReviewer(turns: { role?: string; content: unknown }[][]) {
    const { session, prompts } = scriptedResearcherSession(turns)
    const registry = { reviewer: { systemPrompt: 'X' } satisfies Subagent }
    const { completion } = startSubagent('reviewer', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_reviewer',
    })
    const result = await completion
    return { result, prompts }
  }

  test('reviewer: a <review> on the first turn is returned with no recovery nudge', async () => {
    const review = '<review>\n<verdict>approve</verdict>\n</review>'
    const { result, prompts } = await runReviewer([[{ role: 'assistant', content: `Looking now.\n${review}\nDone.` }]])
    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    expect(result.finalMessage).toBe(review)
    expect(prompts).toHaveLength(1)
  })

  test('reviewer: ends with prose but no <review> → recovers on the nudge (guard, not silent drop)', async () => {
    const review = '<review>\n<verdict>request-changes</verdict>\n</review>'
    const { result, prompts } = await runReviewer([
      [{ role: 'assistant', content: 'I read the diff and have concerns.' }],
      [{ role: 'assistant', content: review }],
    ])
    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    expect(result.finalMessage).toBe(review)
    expect(prompts).toHaveLength(2)
  })

  test('reviewer: the recovery nudge asks for the <review> as text and forbids tools/gh, not write_report', async () => {
    const { prompts } = await runReviewer([
      [{ role: 'assistant', content: 'still analyzing' }],
      [{ role: 'assistant', content: '<review>\n<verdict>comment</verdict>\n</review>' }],
    ])
    expect(prompts[1]).toContain('<review>')
    expect(prompts[1]).toContain('Do NOT call any tools')
    expect(prompts[1]).toContain('<verdict>')
    expect(prompts[1]).not.toContain('write_report')
  })

  test('reviewer: the recovery nudge steers an undecided review to the sentinel, not a real comment verdict', async () => {
    // given: a reviewer that gets nudged (first turn has no block)
    const { prompts } = await runReviewer([
      [{ role: 'assistant', content: 'still analyzing' }],
      [{ role: 'assistant', content: '<review>\n<verdict>approve</verdict>\n</review>' }],
    ])
    // then: the "could not decide" branch routes through the non-verdict sentinel —
    // a real <verdict>comment</verdict> here would be upgradeable on re-review
    expect(prompts[1]).toContain(INCOMPLETE_REVIEW_VERDICT)
    expect(prompts[1]).not.toContain('<verdict>comment</verdict>')
  })

  test('reviewer: exhausting the nudge budget installs an honest fallback <review> with a non-verdict sentinel (never a decisive verdict)', async () => {
    const { result, prompts } = await runReviewer([
      [{ role: 'assistant', content: 'reading the files' }],
      [{ role: 'assistant', content: 'still no verdict' }],
      [{ role: 'assistant', content: 'still nothing' }],
    ])
    if (!result.ok) throw new Error(`expected ok=true (guard, not silent drop), got error: ${result.error}`)
    expect(prompts).toHaveLength(3)
    expect(result.finalMessage).toContain('<review>')
    expect(result.finalMessage).toContain('could not complete')
    expect(result.finalMessage).toContain(`<verdict>${INCOMPLETE_REVIEW_VERDICT}</verdict>`)
  })

  type FailingTurn =
    | { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }
    | { throws: string }

  function providerFailingSession(turns: FailingTurn[][]) {
    const prompts: string[] = []
    const listeners = new Set<(event: unknown) => void>()
    let turnIndex = 0
    let leafMessage: unknown
    const session = {
      prompt: async (text: string) => {
        prompts.push(text)
        const messages = turns[turnIndex] ?? []
        turnIndex++
        for (const message of messages) {
          if ('throws' in message) throw new Error(message.throws)
          leafMessage = message
          for (const l of listeners) l({ type: 'message_end', message })
        }
      },
      dispose: () => {},
      subscribe: (l: (event: unknown) => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      },
      abort: async () => {},
      sessionManager: {
        getLeafEntry: () => (leafMessage === undefined ? undefined : { type: 'message', message: leafMessage }),
      },
    } as unknown as AgentSession
    return { session, prompts }
  }

  async function runReviewerOn(session: AgentSession) {
    const registry = { reviewer: { systemPrompt: 'X' } satisfies Subagent }
    const { completion } = startSubagent('reviewer', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_reviewer_provider',
    })
    return completion
  }

  const OVERLOADED = { role: 'assistant', stopReason: 'error', errorMessage: 'Overloaded' }

  test('reviewer: an upstream provider failure spends ZERO nudges (re-prompting a dead provider is pointless)', async () => {
    const { session, prompts } = providerFailingSession([[OVERLOADED]])

    const result = await runReviewerOn(session)

    if (!result.ok) throw new Error(`expected ok=true (guard, not silent drop), got error: ${result.error}`)
    expect(prompts).toHaveLength(1)
    expect(result.finalMessage).toContain('UPSTREAM PROVIDER FAILURE')
    expect(result.finalMessage).toContain(`<verdict>${INCOMPLETE_REVIEW_VERDICT}</verdict>`)
  })

  test('reviewer: a provider failure is not reported as the reviewer failing to reach a verdict', async () => {
    const { session } = providerFailingSession([[OVERLOADED]])

    const result = await runReviewerOn(session)

    if (!result.ok) throw new Error('expected ok=true')
    expect(result.finalMessage).not.toContain('INCOMPLETE REVIEW')
    expect(result.finalMessage).toContain('infrastructure failure')
  })

  test('reviewer: a model that merely omits the block still gets the full nudge budget and the model-fault wording', async () => {
    const { session, prompts } = providerFailingSession([
      [{ role: 'assistant', content: 'reading the files' }],
      [{ role: 'assistant', content: 'still nothing' }],
      [{ role: 'assistant', content: 'still nothing' }],
    ])

    const result = await runReviewerOn(session)

    if (!result.ok) throw new Error('expected ok=true')
    expect(prompts).toHaveLength(3)
    expect(result.finalMessage).toContain('INCOMPLETE REVIEW')
    expect(result.finalMessage).not.toContain('UPSTREAM PROVIDER FAILURE')
  })

  test('reviewer: a nudge that dies on the provider stops the loop instead of burning the last attempt', async () => {
    const { session, prompts } = providerFailingSession([
      [{ role: 'assistant', content: 'reading the files' }],
      [OVERLOADED],
      [{ role: 'assistant', content: 'never reached' }],
    ])

    const result = await runReviewerOn(session)

    if (!result.ok) throw new Error('expected ok=true')
    expect(prompts).toHaveLength(2)
    expect(result.finalMessage).toContain('UPSTREAM PROVIDER FAILURE')
  })

  test('reviewer: a THROWN overload on the initial turn still reaches the provider-failure fallback', async () => {
    const { session, prompts } = providerFailingSession([[{ throws: '429 Too Many Requests' }]])

    const result = await runReviewerOn(session)

    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    expect(prompts).toHaveLength(1)
    expect(result.finalMessage).toContain('UPSTREAM PROVIDER FAILURE')
    expect(result.finalMessage).toContain(`<verdict>${INCOMPLETE_REVIEW_VERDICT}</verdict>`)
  })

  test('reviewer: a THROWN overload on a nudge turn stops the loop and names the provider', async () => {
    const { session, prompts } = providerFailingSession([
      [{ role: 'assistant', content: 'reading the files' }],
      [{ throws: 'Overloaded' }],
      [{ role: 'assistant', content: 'never reached' }],
    ])

    const result = await runReviewerOn(session)

    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    expect(prompts).toHaveLength(2)
    expect(result.finalMessage).toContain('UPSTREAM PROVIDER FAILURE')
  })

  test('reviewer: an unrecognized exception still fails the subagent instead of being masked as an outage', async () => {
    const { session } = providerFailingSession([[{ throws: 'TypeError: cannot read property of undefined' }]])

    const result = await runReviewerOn(session)

    expect(result.ok).toBe(false)
  })

  test('a subagent with no required block still FAILS on a thrown overload (no fallback to render it)', async () => {
    // given: explorer has no requiredBlockTag, so there is no synthetic-result
    // surface -- absorbing the throw here would report a clean run for a turn
    // that never happened
    const { session } = providerFailingSession([[{ throws: 'Overloaded' }]])
    const registry = { explorer: { systemPrompt: 'X' } satisfies Subagent }

    const { completion } = startSubagent('explorer', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_explorer_overload',
    })
    const result = await completion

    expect(result.ok).toBe(false)
  })

  test('reviewer: the incomplete-review fallback can never carry a decisive verdict (re-review upgrade safety)', async () => {
    // given: a reviewer that exhausts its retries without reaching a verdict
    const { result } = await runReviewer([
      [{ role: 'assistant', content: 'reading the files' }],
      [{ role: 'assistant', content: 'still nothing' }],
      [{ role: 'assistant', content: 'still nothing' }],
    ])
    if (!result.ok) throw new Error(`expected ok=true, got error: ${result.error}`)
    // then: the ONLY verdict token in the fallback is the non-verdict sentinel —
    // so the parent's re-review override cannot upgrade it to APPROVE/REQUEST_CHANGES
    const verdict = result.finalMessage?.match(/<verdict>([\s\S]*?)<\/verdict>/)?.[1]
    expect(verdict).toBe(INCOMPLETE_REVIEW_VERDICT)
    expect(INCOMPLETE_REVIEW_VERDICT).not.toBe('approve')
    expect(INCOMPLETE_REVIEW_VERDICT).not.toBe('request-changes')
    expect(INCOMPLETE_REVIEW_VERDICT).not.toBe('comment')
  })

  test('reviewer: a timeout after a <review> was captured rides the review along (recoverable near-miss)', async () => {
    const review = '<review>\n<verdict>approve</verdict>\n</review>'
    const registry = { reviewer: { systemPrompt: 'X', timeoutMs: 20 } satisfies Subagent }
    const { completion } = startSubagent('reviewer', {
      registry,
      createSessionForSubagent: async () => wedgeAfterEmitting(review),
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_reviewer_timeout',
    })
    const result = await completion
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('timed out')
      expect(result.finalMessage).toBe(review)
    }
  })

  test('reviewer: a run that ends with no assistant text at all still gets an honest fallback (the stranded-review bug)', async () => {
    const { result, prompts } = await runReviewer([[{ role: 'assistant', content: '' }], [], []])
    if (!result.ok) throw new Error(`expected ok=true (guard converts the silent drop), got error: ${result.error}`)
    expect(result.finalMessage).toContain('<review>')
    expect(result.finalMessage).toContain(`<verdict>${INCOMPLETE_REVIEW_VERDICT}</verdict>`)
    expect(prompts).toHaveLength(3)
  })

  test('without timeoutMs a slow prompt keeps completion pending (legacy unbounded behavior preserved)', async () => {
    // given: a session whose prompt has not resolved yet, and no timeout declared
    let resolvePrompt: () => void = () => {}
    const session = {
      prompt: () =>
        new Promise<void>((r) => {
          resolvePrompt = r
        }),
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_unbounded',
    })
    let settled = false
    void completion.then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 30))

    // then: still pending — no ceiling fired
    expect(settled).toBe(false)
    resolvePrompt()
    await completion
    expect(settled).toBe(true)
  })

  test('onSession fires once with the live session and abort handle', async () => {
    // given
    const { session } = subscribableFakeSession()
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }
    let captured: { abortCount: number } | null = null

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_session',
      onSession: (event) => {
        captured = { abortCount: 0 }
        void event.abort().then(() => {
          if (captured) captured.abortCount += 1
        })
      },
    })
    await completion

    // then
    expect(captured).not.toBeNull()
    expect(captured!.abortCount).toBe(1)
  })

  test('parallel starts with different taskIds run concurrently (proves handle settles independently)', async () => {
    // given
    let resolveProm1: () => void = () => {}
    let resolveProm2: () => void = () => {}
    const session1 = {
      prompt: async () =>
        new Promise<void>((r) => {
          resolveProm1 = r
        }),
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    const session2 = {
      prompt: async () =>
        new Promise<void>((r) => {
          resolveProm2 = r
        }),
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }
    let createCount = 0

    // when
    const start1 = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => {
        createCount += 1
        return session1
      },
      agentDir: '/agent',
      userPrompt: 'q1',
      taskId: 'bg_a',
    })
    const start2 = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => {
        createCount += 1
        return session2
      },
      agentDir: '/agent',
      userPrompt: 'q2',
      taskId: 'bg_b',
    })
    const h1 = await start1.handle
    const h2 = await start2.handle

    // then
    expect(h1.taskId).toBe('bg_a')
    expect(h2.taskId).toBe('bg_b')
    expect(createCount).toBe(2)
    // Both handles resolved before either prompt finished — proves non-blocking shape.
    resolveProm1()
    resolveProm2()
    await Promise.all([start1.completion, start2.completion])
  })

  test('invokeSubagent (the wrapper) still returns Promise<void> and runs unchanged', async () => {
    // given (this asserts no behavioral regression from the refactor)
    const { session, calls } = fakeSession()
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const result = await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'wrapper',
    })

    // then
    expect(result).toBeUndefined()
    expect(calls.prompt).toEqual([expect.stringContaining('wrapper')])
    expect(calls.disposed).toBe(1)
  })
})

describe('invokeSubagent — background drain lifecycle', () => {
  function drainSession(): { session: AgentSession; calls: { prompt: string[]; disposed: number } } {
    const calls = { prompt: [] as string[], disposed: 0 }
    const session = {
      prompt: async (text: string) => {
        calls.prompt.push(text)
      },
      dispose: () => {
        calls.disposed += 1
      },
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    return { session, calls }
  }

  function registerChild(
    reg: LiveSubagentRegistry,
    parentSessionId: string,
    taskId: string,
    background: boolean,
  ): void {
    reg.register({
      taskId,
      sessionId: `ses_${taskId}`,
      subagentName: 'scout',
      parentSessionId,
      background,
      startedAt: 0,
      status: 'running',
      abort: async () => {},
    })
    reg.recordCompletion(taskId, { ok: true, durationMs: 10 })
  }

  test('a completed synchronous child does not trigger a drain re-prompt', async () => {
    // given: an opted-in subagent whose session already has a COMPLETED sync
    // child in the registry (its result was returned inline by the tool call).
    const { session, calls } = drainSession()
    const reg = new LiveSubagentRegistry()
    const sessionId = 'ses_subagent'
    registerChild(reg, sessionId, 'sync_child', false)
    const registry = { greeter: { systemPrompt: 'X', canBackgroundSpawnSubagents: true } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => ({
        session,
        sessionId,
        backgroundDrain: { stream: createStream(), sessionId, liveRegistry: reg },
      }),
      agentDir: '/agent',
      userPrompt: 'go',
    })

    // then: only the initial prompt ran; no reminder for the sync child.
    expect(calls.prompt.length).toBe(1)
    expect(calls.disposed).toBe(1)
  })

  test('a completed background child triggers exactly one drain re-prompt', async () => {
    // given: same setup but the completed child was a BACKGROUND spawn.
    const { session, calls } = drainSession()
    const reg = new LiveSubagentRegistry()
    const sessionId = 'ses_subagent'
    registerChild(reg, sessionId, 'bg_child', true)
    const registry = { greeter: { systemPrompt: 'X', canBackgroundSpawnSubagents: true } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => ({
        session,
        sessionId,
        backgroundDrain: { stream: createStream(), sessionId, liveRegistry: reg },
      }),
      agentDir: '/agent',
      userPrompt: 'go',
    })

    // then: initial prompt + one reminder prompt for the background child.
    expect(calls.prompt.length).toBe(2)
    expect(calls.prompt[1]).toContain('bg_child')
    expect(calls.disposed).toBe(1)
  })

  test('no backgroundDrain capability keeps the one-shot path (no drain)', async () => {
    // given: a completed background child exists, but the session result carries
    // NO backgroundDrain capability — the subagent must stay one-shot.
    const { session, calls } = drainSession()
    const reg = new LiveSubagentRegistry()
    const sessionId = 'ses_subagent'
    registerChild(reg, sessionId, 'bg_child', true)
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => ({ session, sessionId }),
      agentDir: '/agent',
      userPrompt: 'go',
    })

    // then: exactly one prompt, no drain.
    expect(calls.prompt.length).toBe(1)
    expect(calls.disposed).toBe(1)
  })
})

describe('defaultCreateSessionForSubagent — plugin hook wiring', () => {
  const subagent: Subagent<unknown> = { systemPrompt: 'X', payloadSchema: z.unknown() }

  function fakePluginWiring(): PluginSessionWiring {
    return {
      registry: { skills: [] } as unknown as PluginRegistry,
      hooks: makeFakeHookBus([]),
      sessionId: 'ses_sub',
      agentDir: '/agent',
    }
  }

  test('forwards plugins AND permissions into createSession so the subagent runs tool hooks WITH sandboxing', async () => {
    // given: a built-in subagent created WITH plugin wiring + the permission service
    const spy = spyOn(agentIndex, 'createSession').mockResolvedValue(fakeSession().session)
    const plugins = fakePluginWiring()
    const permissions = noopPermissionService
    try {
      // when
      await defaultCreateSessionForSubagent(subagent, { name: 'explore', plugins, permissions })

      // then: createSession receives BOTH. plugins wraps builtin bash with
      // tool.before (token + guards); permissions is what makes that wrapper
      // apply applyBashSandbox/applyTmpPathRedirect — both are required or the
      // subagent gets the token with the sandbox off.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]?.plugins).toBe(plugins)
      expect(spy.mock.calls[0]?.[0]?.permissions).toBe(permissions)
    } finally {
      spy.mockRestore()
    }
  })

  test('omits plugins and permissions when none supplied (standalone/test callers stay unwrapped)', async () => {
    const spy = spyOn(agentIndex, 'createSession').mockResolvedValue(fakeSession().session)
    try {
      await defaultCreateSessionForSubagent(subagent, { name: 'explore' })

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[0]?.plugins).toBeUndefined()
      expect(spy.mock.calls[0]?.[0]?.permissions).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})
