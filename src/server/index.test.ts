import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import type { AgentSession, CreateSessionOptions } from '@/agent'
import { LiveSubagentRegistry } from '@/agent/live-subagents'
import type { CreateSessionForSubagent, SubagentRegistry } from '@/agent/subagents'
import { readContinuationState } from '@/agent/todo/continuation-state'
import { recordTurnOutcome, runIdleContinuation } from '@/agent/todo/continuation-wiring'
import { resolveTodoScope } from '@/agent/todo/scope'
import { writeTodos } from '@/agent/todo/store'
import { renderShard } from '@/bundled-plugins/memory/frontmatter'
import { topicShardPath, topicsDir } from '@/bundled-plugins/memory/paths'
import { createMemorySearchTool } from '@/bundled-plugins/memory/search-tool'
import type { CronJob } from '@/cron'
import { createPermissionService, type PermissionService } from '@/permissions'
import { createHookBus, type HookBus, type PluginRegistry } from '@/plugin'
import { emptyRegistry } from '@/plugin/registry'
import { createPluginRuntime, type PluginRuntime } from '@/run/plugin-runtime'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import type { ServerMessage, TunnelLogsServerMessage } from '@/shared'
import { isWindows } from '@/shared'
import { createStream, type StreamMessage } from '@/stream'
import { expectStable, waitFor as waitForState } from '@/test-helpers/wait-for'
import type { TunnelManager, TunnelState } from '@/tunnels'

import type { CommandOutbound, CommandRunner } from './command-runner'
import { createServer, type ServerLogger } from './index'

const onWindows = isWindows()

function makeRuntime(opts: { registry: PluginRegistry; hooks: HookBus }): PluginRuntime {
  return createPluginRuntime({
    registry: opts.registry,
    hooks: opts.hooks,
    subagents: {},
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: false,
    loadedPlugins: [],
    materializedSkills: null,
  })
}

const EMPTY_REGISTRY: PluginRegistry = emptyRegistry()

function makeRuntimeWith(opts: { subagents: SubagentRegistry }): PluginRuntime {
  return createPluginRuntime({
    registry: EMPTY_REGISTRY,
    hooks: createHookBus(),
    subagents: opts.subagents,
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: false,
    loadedPlugins: [],
    materializedSkills: null,
  })
}

type SessionEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }

let server: ReturnType<ReturnType<typeof createServer>['start']> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

function createFakeSession(): AgentSession & {
  emit: (event: SessionEvent) => void
  abortCalls: number
  promptCalls: string[]
  disposeCalls: number
  resolvePrompt: () => void
  rejectPrompt: (err: Error) => void
} {
  const subscribers = new Set<(event: SessionEvent) => void>()
  let pendingPromptResolve: (() => void) | null = null
  let pendingPromptReject: ((err: Error) => void) | null = null
  const fake = {
    subscribe: (fn: (event: SessionEvent) => void) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    prompt: async (text: string) => {
      fake.promptCalls.push(text)
      await new Promise<void>((resolve, reject) => {
        pendingPromptResolve = resolve
        pendingPromptReject = reject
      })
    },
    abort: async () => {
      fake.abortCalls++
      pendingPromptResolve?.()
      pendingPromptResolve = null
      pendingPromptReject = null
    },
    dispose: () => {
      fake.disposeCalls++
    },
    emit: (event: SessionEvent) => {
      for (const fn of subscribers) fn(event)
    },
    resolvePrompt: () => {
      pendingPromptResolve?.()
      pendingPromptResolve = null
      pendingPromptReject = null
    },
    rejectPrompt: (err: Error) => {
      pendingPromptReject?.(err)
      pendingPromptResolve = null
      pendingPromptReject = null
    },
    sessionManager: {
      getLeafEntry: () => undefined,
    },
    abortCalls: 0,
    disposeCalls: 0,
    promptCalls: [] as string[],
  }
  return fake as unknown as ReturnType<typeof createFakeSession>
}

async function startWithSession(
  session: AgentSession,
  extra: {
    stream?: ReturnType<typeof createStream>
    sessionFactory?: SessionFactory
    agentDir?: string
    pluginRegistry?: PluginRegistry
    pluginHooks?: HookBus
    logger?: ServerLogger
    commandRunnerFactory?: (outbound: CommandOutbound) => CommandRunner
    tunnelManager?: TunnelManager
    runtimeVersion?: string
    containerName?: string
    recordTurnOutcome?: typeof recordTurnOutcome
    runIdleContinuation?: typeof runIdleContinuation
  } = {},
): Promise<{ url: string }> {
  const pluginRuntime =
    extra.pluginRegistry !== undefined && extra.pluginHooks !== undefined
      ? makeRuntime({ registry: extra.pluginRegistry, hooks: extra.pluginHooks })
      : undefined
  const built = createServer({
    port: 0,
    createSession: async () => session,
    ...(extra.stream ? { stream: extra.stream } : {}),
    ...(extra.sessionFactory ? { sessionFactory: extra.sessionFactory } : {}),
    ...(extra.agentDir !== undefined ? { agentDir: extra.agentDir } : {}),
    ...(pluginRuntime ? { pluginRuntime } : {}),
    ...(extra.logger ? { logger: extra.logger } : {}),
    ...(extra.commandRunnerFactory ? { commandRunnerFactory: extra.commandRunnerFactory } : {}),
    ...(extra.tunnelManager ? { tunnelManager: extra.tunnelManager } : {}),
    ...(extra.runtimeVersion !== undefined ? { runtimeVersion: extra.runtimeVersion } : {}),
    ...(extra.containerName !== undefined ? { containerName: extra.containerName } : {}),
    ...(extra.recordTurnOutcome ? { recordTurnOutcome: extra.recordTurnOutcome } : {}),
    ...(extra.runIdleContinuation ? { runIdleContinuation: extra.runIdleContinuation } : {}),
  }).start()
  server = built
  return { url: `ws://localhost:${built.port}` }
}

async function connectTunnelLogs(url: string): Promise<{
  ws: WebSocket
  received: TunnelLogsServerMessage[]
  waitFor: (
    predicate: (msg: TunnelLogsServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<TunnelLogsServerMessage>
}> {
  const ws = new WebSocket(url)
  const received: TunnelLogsServerMessage[] = []
  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)) as TunnelLogsServerMessage)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (err) => reject(err), { once: true })
  })
  const waitFor = async (
    predicate: (msg: TunnelLogsServerMessage) => boolean,
    timeoutMs = 1000,
  ): Promise<TunnelLogsServerMessage> => {
    const existing = received.find(predicate)
    if (existing) return existing
    return await new Promise<TunnelLogsServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for tunnel log message')), timeoutMs)
      const onMessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as TunnelLogsServerMessage
        if (predicate(msg)) {
          clearTimeout(timer)
          ws.removeEventListener('message', onMessage)
          resolve(msg)
        }
      }
      ws.addEventListener('message', onMessage)
    })
  }
  return { ws, received, waitFor }
}

async function connect(url: string): Promise<{
  ws: WebSocket
  received: ServerMessage[]
  waitFor: (predicate: (msg: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>
}> {
  const ws = new WebSocket(url)
  const received: ServerMessage[] = []
  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)) as ServerMessage)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (err) => reject(err), { once: true })
  })
  const waitFor = async (predicate: (msg: ServerMessage) => boolean, timeoutMs = 1000): Promise<ServerMessage> => {
    const existing = received.find(predicate)
    if (existing) return existing
    return await new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs)
      const onMessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage
        if (predicate(msg)) {
          clearTimeout(timer)
          ws.removeEventListener('message', onMessage)
          resolve(msg)
        }
      }
      ws.addEventListener('message', onMessage)
    })
  }
  return { ws, received, waitFor }
}

describe('createServer tool event forwarding', () => {
  test('rejects TUI websocket upgrades without the expected token', async () => {
    const built = createServer({ port: 0, createSession: async () => createFakeSession(), tuiToken: 'secret' }).start()
    server = built

    const ws = new WebSocket(`ws://localhost:${built.port}`)

    await new Promise<void>((resolve) => ws.addEventListener('close', () => resolve(), { once: true }))
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  test('accepts TUI websocket upgrades with the expected token', async () => {
    const built = createServer({ port: 0, createSession: async () => createFakeSession(), tuiToken: 'secret' }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}?token=secret`)

    await expect(waitFor((m) => m.type === 'connected')).resolves.toMatchObject({ type: 'connected' })
    ws.close()
  })

  test('forwards toolCallId, name, and args from tool_execution_start', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'Read', args: { path: '/x' } })

    const msg = await waitFor((m) => m.type === 'tool_start')
    if (msg.type !== 'tool_start') throw new Error('unreachable')
    expect(msg).toMatchObject({ type: 'tool_start', toolCallId: 'tc-1', name: 'Read', args: { path: '/x' } })
    expect(typeof msg.ts).toBe('number')
    ws.close()
  })

  test('forwards toolCallId, name, error, result, and a non-negative durationMs from tool_execution_end', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-2', toolName: 'Bash', args: 'ls' })
    await waitFor((m) => m.type === 'tool_start')
    session.emit({ type: 'tool_execution_end', toolCallId: 'tc-2', toolName: 'Bash', result: 'a\nb', isError: false })

    const msg = await waitFor((m) => m.type === 'tool_end')
    expect(msg.type).toBe('tool_end')
    if (msg.type !== 'tool_end') throw new Error('unreachable')
    expect(msg.toolCallId).toBe('tc-2')
    expect(msg.name).toBe('Bash')
    expect(msg.error).toBe(false)
    expect(msg.result).toBe('a\nb')
    expect(msg.durationMs).toBeGreaterThanOrEqual(0)
    ws.close()
  })

  test('uses durationMs=0 when tool_execution_end arrives without a matching start', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_end', toolCallId: 'orphan', toolName: 'X', result: null, isError: true })

    const msg = await waitFor((m) => m.type === 'tool_end')
    if (msg.type !== 'tool_end') throw new Error('unreachable')
    expect(msg.durationMs).toBe(0)
    expect(msg.error).toBe(true)
    ws.close()
  })

  test('forwards assistant message_end with stopReason=error as a TUI error event (LLM-side failures like billing/rate-limit do not throw)', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-5.4-nano',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        errorMessage: 'Your account is not active, please check your billing details on our website.',
        timestamp: Date.now(),
      },
    } as unknown as SessionEvent)

    const msg = await waitFor((m) => m.type === 'error')
    if (msg.type !== 'error') throw new Error('unreachable')
    expect(msg.message).toBe('Your account is not active, please check your billing details on our website.')
    ws.close()
  })

  test('falls back to a generic message when stopReason=error has no errorMessage', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: undefined,
      },
    } as unknown as SessionEvent)

    const msg = await waitFor((m) => m.type === 'error')
    if (msg.type !== 'error') throw new Error('unreachable')
    expect(msg.message).toBe('LLM call failed')
    ws.close()
  })

  test('does not surface an error event for non-assistant message_end (user/toolResult)', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    let errorSeen = false
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage
      if (m.type === 'error') errorSeen = true
    })

    session.emit({
      type: 'message_end',
      message: { role: 'user', content: 'hello', timestamp: Date.now() },
    } as unknown as SessionEvent)

    // Sentinel: emit a tool_start so we have something to await on; if an
    // error were fired for the user message it would arrive before this.
    session.emit({ type: 'tool_execution_start', toolCallId: 'sentinel', toolName: 'Read', args: {} })
    await waitFor((m) => m.type === 'tool_start')

    expect(errorSeen).toBe(false)
    ws.close()
  })

  test('does not surface an error event for stopReason=aborted (TUI shows abort feedback elsewhere)', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    let errorSeen = false
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage
      if (m.type === 'error') errorSeen = true
    })

    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
      },
    } as unknown as SessionEvent)

    session.emit({ type: 'tool_execution_start', toolCallId: 'sentinel-2', toolName: 'Read', args: {} })
    await waitFor((m) => m.type === 'tool_start')

    expect(errorSeen).toBe(false)
    ws.close()
  })
})

describe('createServer todo continuation (drain re-entrancy)', () => {
  test('consumes an idle continuation in the same drain pass instead of stalling', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'server-todo-cont-'))
    const origin = { kind: 'tui', sessionId: 'x' } as const
    const scope = resolveTodoScope(origin)!
    // Pre-seed an incomplete todo AND a safe (stop) turn outcome so the idle
    // path is eligible to inject. This isolates the property under test — that
    // the drain loop CONSUMES the continuation — from the async outcome-capture
    // timing, which is exercised separately at the unit layer.
    await writeTodos(agentDir, scope, [{ content: 'finish the work', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin, turnId: 'seed', stopReason: 'stop' })

    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, {
      agentDir,
      stream,
      sessionFactory: createSessionFactory({ agentDir }),
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'prompt', text: 'do thing' }))
    await waitForState(() => session.promptCalls.length === 1)
    session.resolvePrompt()

    // The continuation must be consumed by the SAME drain loop — a second
    // prompt() call lands without any further user input. If the old
    // publish-through-stream path were still in place, draining would already
    // be true and this would hang until timeout: the stranded item generates
    // no further wake-up, so no tight deadline is needed to prove the fix.
    // Use the shared contention-tolerant default (30s) rather than a fixed
    // short timeout, which starves and false-fails under oversubscription.
    await waitForState(() => session.promptCalls.length === 2)
    expect(session.promptCalls[1]).toContain('Incomplete todo items remain')
    session.resolvePrompt()
    ws.close()
  })
})

describe('createServer todo continuation (outcome-write ordering)', () => {
  const origin = { kind: 'tui', sessionId: 'seed' } as const
  const scope = resolveTodoScope(origin)!

  function emitAssistantEnd(session: ReturnType<typeof createFakeSession>, stopReason: 'stop' | 'error'): void {
    session.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason },
    } as unknown as SessionEvent)
  }

  // Seeds an incomplete todo plus a persisted SAFE (stop) outcome from a prior
  // turn — the stale state a premature idle decision would wrongly act on — and
  // starts one real user turn. Every idle decision's injected/not result is
  // recorded so tests can await the decision instead of sleeping.
  async function startTodoTurn(seams: { recordTurnOutcome?: typeof recordTurnOutcome } = {}) {
    const agentDir = await mkdtemp(join(tmpdir(), 'server-todo-order-'))
    await writeTodos(agentDir, scope, [{ content: 'finish the work', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin, turnId: 'prior', stopReason: 'stop' })
    const decisions: boolean[] = []
    const warnings: string[] = []
    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      agentDir,
      stream: createStream(),
      sessionFactory: createSessionFactory({ agentDir }),
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
      ...seams,
      runIdleContinuation: async (args) => {
        const injected = await runIdleContinuation(args)
        decisions.push(injected)
        return injected
      },
    })
    const conn = await connect(url)
    await conn.waitFor((m) => m.type === 'connected')
    conn.ws.send(JSON.stringify({ type: 'prompt', text: 'do thing' }))
    await waitForState(() => session.promptCalls.length === 1)
    const lastStopReason = async () =>
      (await readContinuationState(agentDir, scope)).lastTurnOutcome?.stopReason ?? null
    return { ...conn, session, decisions, warnings, lastStopReason }
  }

  test('idle decision waits for a pending error write instead of continuing on the prior stop', async () => {
    const gate = Promise.withResolvers<void>()
    const t = await startTodoTurn({
      recordTurnOutcome: async (args) => {
        await gate.promise
        await recordTurnOutcome(args)
      },
    })
    emitAssistantEnd(t.session, 'error')
    t.session.resolvePrompt()
    await t.waitFor((m) => m.type === 'done')
    gate.resolve()

    await waitForState(() => t.decisions.length === 1)
    expect(t.decisions).toEqual([false])
    expect(t.session.promptCalls).toHaveLength(1)
    expect(await t.lastStopReason()).toBe('error')
    t.ws.close()
  })

  test('a slow earlier stop write cannot land after the later error write', async () => {
    const gate = Promise.withResolvers<void>()
    const landed: string[] = []
    const t = await startTodoTurn({
      recordTurnOutcome: async (args) => {
        if (args.stopReason === 'stop') await gate.promise
        await recordTurnOutcome(args)
        landed.push(args.stopReason)
      },
    })
    emitAssistantEnd(t.session, 'stop')
    emitAssistantEnd(t.session, 'error')
    t.session.resolvePrompt()
    await t.waitFor((m) => m.type === 'done')
    gate.resolve()

    await waitForState(() => t.decisions.length === 1)
    expect(landed).toEqual(['stop', 'error'])
    expect(t.decisions).toEqual([false])
    expect(t.session.promptCalls).toHaveLength(1)
    expect(await t.lastStopReason()).toBe('error')
    t.ws.close()
  })

  test('a failed latest outcome write fails closed, and the next successful turn continues again', async () => {
    let failNext = true
    const t = await startTodoTurn({
      recordTurnOutcome: async (args) => {
        if (failNext) {
          failNext = false
          throw new Error('synthetic disk failure')
        }
        await recordTurnOutcome(args)
      },
    })
    emitAssistantEnd(t.session, 'error')
    t.session.resolvePrompt()
    await waitForState(() => t.warnings.some((w) => w.includes('failed outcome write')))
    expect(t.decisions).toEqual([])
    expect(t.session.promptCalls).toHaveLength(1)
    // The prior persisted stop is still on disk; only the fail-closed check kept
    // the idle path from acting on it.
    expect(await t.lastStopReason()).toBe('stop')

    // One failure must not poison the chain: a later safe turn continues.
    t.ws.send(JSON.stringify({ type: 'prompt', text: 'try again' }))
    await waitForState(() => t.session.promptCalls.length === 2)
    emitAssistantEnd(t.session, 'stop')
    t.session.resolvePrompt()
    await waitForState(() => t.session.promptCalls.length === 3)
    expect(t.decisions).toEqual([true])
    expect(t.session.promptCalls[2]).toContain('Incomplete todo items remain')
    t.session.resolvePrompt()
    t.ws.close()
  })

  test('a real user prompt that arrives while the outcome write is pending runs before any continuation', async () => {
    const gate = Promise.withResolvers<void>()
    const t = await startTodoTurn({
      recordTurnOutcome: async (args) => {
        await gate.promise
        await recordTurnOutcome(args)
      },
    })
    emitAssistantEnd(t.session, 'stop')
    t.session.resolvePrompt()
    await t.waitFor((m) => m.type === 'done')
    t.ws.send(JSON.stringify({ type: 'prompt', text: 'user follow-up' }))
    await t.waitFor((m) => m.type === 'queue_state' && m.pending.some((p) => p.text === 'user follow-up'))
    gate.resolve()

    await waitForState(() => t.session.promptCalls.length === 2)
    expect(t.session.promptCalls[1]).toContain('user follow-up')
    expect(t.decisions).toEqual([])
    t.session.resolvePrompt()
    t.ws.close()
  })
})

describe('createServer abort handling (no stream — fallback path)', () => {
  test('client { type: "abort" } invokes session.abort()', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'prompt', text: 'do thing' }))
    await waitForState(() => session.promptCalls.length > 0)
    expect(session.promptCalls).toEqual([expect.stringContaining('do thing')])
    expect(session.abortCalls).toBe(0)

    ws.send(JSON.stringify({ type: 'abort' }))
    await waitFor((m) => m.type === 'done')
    expect(session.abortCalls).toBe(1)
    ws.close()
  })

  test('abort with no in-flight prompt is still a safe no-op', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'abort' }))
    await waitForState(() => session.abortCalls > 0)
    expect(session.abortCalls).toBe(1)
    ws.close()
  })

  test('attention escalation bumps to xhigh then resets to the captured default', async () => {
    // The fallback path must reset from the session's CREATION-time level, not the
    // live getter — otherwise the first escalated turn poisons the second turn's
    // reset target. Enhance the fake with a real thinkingLevel getter that tracks
    // setThinkingLevel so the second turn observes the moved value, exposing a
    // bug if the production code reads the getter instead of the captured default.
    const session = createFakeSession()
    const thinkingCalls: string[] = []
    let currentLevel = 'low'
    Object.defineProperty(session, 'thinkingLevel', { get: () => currentLevel, configurable: true })
    ;(session as unknown as { setThinkingLevel: (l: string) => void }).setThinkingLevel = (level) => {
      thinkingCalls.push(level)
      currentLevel = level
    }

    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'prompt', text: 'ultrathink, do it properly' }))
    await waitForState(() => session.promptCalls.length === 1)
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    ws.send(JSON.stringify({ type: 'prompt', text: 'add a comment' }))
    await waitForState(() => session.promptCalls.length === 2)
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    expect(thinkingCalls).toEqual(['xhigh', 'low'])
    ws.close()
  })

  test('an aborted question turn does not seed cross-turn escalation', async () => {
    // given: turn 1 is a question that aborts; turn 2 is also a question. Mode-3
    // escalation must NOT fire on turn 2, because the aborted turn never produced
    // a usable assistant turn and must not poison the prior-signal state.
    const session = createFakeSession()
    const thinkingCalls: string[] = []
    let currentLevel: string | undefined
    let leafStop: string | undefined
    Object.defineProperty(session, 'thinkingLevel', { get: () => currentLevel, configurable: true })
    ;(session as unknown as { setThinkingLevel: (l: string) => void }).setThinkingLevel = (level) => {
      thinkingCalls.push(level)
      currentLevel = level
    }
    ;(session.sessionManager as unknown as { getLeafEntry: () => unknown }).getLeafEntry = () =>
      leafStop === undefined ? undefined : { type: 'message', message: { role: 'assistant', stopReason: leafStop } }

    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    leafStop = 'aborted'
    ws.send(JSON.stringify({ type: 'prompt', text: 'why did the container crash on startup?' }))
    await waitForState(() => session.promptCalls.length === 1)
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    leafStop = 'stop'
    ws.send(JSON.stringify({ type: 'prompt', text: 'how do i actually fix this properly now?' }))
    await waitForState(() => session.promptCalls.length === 2)
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    // then: neither turn escalates — turn 1's question signal was never stored,
    // so turn 2's lone question has no question-dominant predecessor.
    expect(thinkingCalls).toEqual([])
    ws.close()
  })
})

describe('createServer restart handling', () => {
  // Bun 1.3.14 on Windows can fail to deliver a server ws.send() performed
  // synchronously inside the WebSocket message callback, so this branch's
  // restart_result never reaches the client and the wait times out. POSIX
  // covers it; the async accepted-path/notice tests below cover Windows.
  test.skipIf(onWindows)('reports restart unavailable when no container name is configured', async () => {
    // given
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    try {
      await waitFor((m) => m.type === 'connected')

      // when
      ws.send(JSON.stringify({ type: 'restart' }))

      // then
      await expect(waitFor((m) => m.type === 'restart_result', 5000)).resolves.toEqual({
        type: 'restart_result',
        status: 'failed',
        error: 'restart unavailable: no container name configured',
      })
    } finally {
      ws.close()
    }
  })

  // Bun 1.3.14 on Windows can hang when a Bun.serve handler reads the body of
  // a loopback fetch POST via req.json(); the fake hostd below blocks on
  // `await req.json()` to assert the body, so sendHttp's fetch never gets a
  // reply and times out. The body/auth shape is verified on POSIX; the Windows
  // success path is covered by the notice test, whose hostd skips the body read.
  test.skipIf(onWindows)('accepts restart when hostd ACKs the container restart RPC', async () => {
    // given
    const requests: Array<{ auth: string | null; body: unknown }> = []
    const hostd = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push({ auth: req.headers.get('authorization'), body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const oldUrl = process.env.TYPECLAW_HOSTD_URL
    const oldToken = process.env.TYPECLAW_HOSTD_TOKEN
    process.env.TYPECLAW_HOSTD_URL = `http://127.0.0.1:${hostd.port}`
    process.env.TYPECLAW_HOSTD_TOKEN = 'secret'
    let ws: WebSocket | null = null
    try {
      const session = createFakeSession()
      const { url } = await startWithSession(session, { containerName: 'coder' })
      const connected = await connect(url)
      ws = connected.ws
      const { waitFor } = connected
      await waitFor((m) => m.type === 'connected')

      // when
      ws.send(JSON.stringify({ type: 'restart' }))

      // then
      await expect(waitFor((m) => m.type === 'restart_result', 5000)).resolves.toEqual({
        type: 'restart_result',
        status: 'accepted',
        message: 'restart scheduled; reconnecting when the new container is up',
      })
      expect(requests).toEqual([
        {
          auth: 'Bearer secret',
          body: { kind: 'restart', containerName: 'coder', build: false },
        },
      ])
    } finally {
      ws?.close()
      if (oldUrl === undefined) delete process.env.TYPECLAW_HOSTD_URL
      else process.env.TYPECLAW_HOSTD_URL = oldUrl
      if (oldToken === undefined) delete process.env.TYPECLAW_HOSTD_TOKEN
      else process.env.TYPECLAW_HOSTD_TOKEN = oldToken
      hostd.stop(true)
    }
  })

  test('publishes the container-restarting notice so the resumed session gets restart-self', async () => {
    // given: an accepting hostd and a real stream. The server must fan out the
    // container-restarting broadcast for the originating session — that
    // broadcast is what subscribeRestartNotice turns into the
    // typeclaw.restart-self JSONL entry the rebooted container resumes from.
    const hostd = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const oldUrl = process.env.TYPECLAW_HOSTD_URL
    const oldToken = process.env.TYPECLAW_HOSTD_TOKEN
    process.env.TYPECLAW_HOSTD_URL = `http://127.0.0.1:${hostd.port}`
    process.env.TYPECLAW_HOSTD_TOKEN = 'secret'
    try {
      const stream = createStream()
      const broadcasts: StreamMessage[] = []
      stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => broadcasts.push(msg))

      const session = createFakeSession()
      const { url } = await startWithSession(session, { containerName: 'coder', stream })
      const { ws, waitFor } = await connect(url)
      const connected = await waitFor((m) => m.type === 'connected')
      if (connected.type !== 'connected') throw new Error('unreachable')

      // when
      ws.send(JSON.stringify({ type: 'restart' }))
      const result = await waitFor((m) => m.type === 'restart_result')

      // then: the broadcast is published synchronously before an ACCEPTED
      // restart_result is sent, so only a failed restart can arrive with no
      // broadcast. Assert acceptance first so such a failure reports the
      // hostd error instead of a bare empty-array mismatch.
      expect(result).toMatchObject({ type: 'restart_result', status: 'accepted' })
      // The broadcast names the originating session so its
      // subscribeRestartNotice (covered in agent/index.test.ts) appends
      // restart-self rather than the sibling notice
      expect(broadcasts).toHaveLength(1)
      expect(broadcasts[0]?.payload).toMatchObject({
        kind: 'container-restarting',
        originatingSessionId: connected.sessionId,
      })
      ws.close()
    } finally {
      if (oldUrl === undefined) delete process.env.TYPECLAW_HOSTD_URL
      else process.env.TYPECLAW_HOSTD_URL = oldUrl
      if (oldToken === undefined) delete process.env.TYPECLAW_HOSTD_TOKEN
      else process.env.TYPECLAW_HOSTD_TOKEN = oldToken
      hostd.stop(true)
    }
  })
})

describe('createServer session persistence wiring', () => {
  function makeStubFactory() {
    const created: SessionManager[] = []
    const factory: SessionFactory = {
      createPersisted: () => {
        const mgr = SessionManager.inMemory()
        created.push(mgr)
        return mgr
      },
      sessionDir: () => '/stub/sessions',
    }
    return { factory, created }
  }

  test('invokes sessionFactory.createPersisted() once per ws open and forwards the manager into createSession', async () => {
    // given
    const session = createFakeSession()
    const { factory, created } = makeStubFactory()
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      sessionFactory: factory,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // then
    expect(created).toHaveLength(1)
    expect(observed).toHaveLength(1)
    expect(observed[0]?.sessionManager).toBe(created[0])

    ws.close()
  })

  test('forwards the live permission service into every TUI session', async () => {
    const session = createFakeSession()
    const permissions = {} as PermissionService
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      permissions,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
    }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((message) => message.type === 'connected')

    expect(observed).toHaveLength(1)
    expect(observed[0]?.permissions).toBe(permissions)
    ws.close()
  })

  test('produces a fresh sessionManager for each ws connection', async () => {
    // given
    const session = createFakeSession()
    const { factory, created } = makeStubFactory()
    const built = createServer({
      port: 0,
      sessionFactory: factory,
      createSession: async () => session,
    }).start()
    server = built
    const url = `ws://localhost:${built.port}`

    // when
    const a = await connect(url)
    await a.waitFor((m) => m.type === 'connected')
    const b = await connect(url)
    await b.waitFor((m) => m.type === 'connected')

    // then
    expect(created).toHaveLength(2)
    expect(created[0]).not.toBe(created[1])

    a.ws.close()
    b.ws.close()
  })

  test('omits sessionManager from createSession options when no factory is configured (preserves in-memory default)', async () => {
    // given
    const session = createFakeSession()
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // then
    expect(observed).toHaveLength(1)
    expect(observed[0]?.sessionManager).toBeUndefined()

    ws.close()
  })

  test('connected message carries the persisted session file id when a factory is configured', async () => {
    // given
    const session = createFakeSession()
    const { factory } = makeStubFactory()
    const { url } = await startWithSession(session, { sessionFactory: factory })

    // when
    const { ws, waitFor } = await connect(url)
    const connected = await waitFor((m) => m.type === 'connected')

    // then
    if (connected.type !== 'connected') throw new Error('unreachable')
    expect(connected.sessionId).toBeDefined()
    expect(connected.sessionId.length).toBeGreaterThan(0)

    ws.close()
  })

  test('connected message carries the configured runtimeVersion as serverVersion', async () => {
    // given
    const session = createFakeSession()
    const { url } = await startWithSession(session, { runtimeVersion: '9.9.9-test' })

    // when
    const { ws, waitFor } = await connect(url)
    const connected = await waitFor((m) => m.type === 'connected')

    // then
    if (connected.type !== 'connected') throw new Error('unreachable')
    expect(connected.serverVersion).toBe('9.9.9-test')

    ws.close()
  })

  test('connected message omits serverVersion when runtimeVersion is not configured', async () => {
    // given
    const session = createFakeSession()
    const { url } = await startWithSession(session)

    // when
    const { ws, waitFor } = await connect(url)
    const connected = await waitFor((m) => m.type === 'connected')

    // then
    if (connected.type !== 'connected') throw new Error('unreachable')
    expect(connected.serverVersion).toBeUndefined()

    ws.close()
  })
})

describe('createServer restart-handoff consumption', () => {
  // pi's SessionManager._persist no-ops until the first assistant message is
  // appended (line 549-557 of pi 0.67.3's session-manager.js). For the seed
  // session to land on disk so the server can reopen it, the seed has to
  // include a user + assistant turn before the restart-self custom message.
  // In production, the originating session has run many turns before the
  // restart fires, so this matches reality.
  async function makeAgentDirWithSession(): Promise<{
    agentDir: string
    sessionsDir: string
    sessionId: string
    sessionFile: string
  }> {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-server-handoff-'))
    const sessionsDir = join(agentDir, 'sessions')
    const seedFactory = createSessionFactory({ agentDir })
    const seedManager = seedFactory.createPersisted()
    const now = Date.now()
    seedManager.appendMessage({ role: 'user', content: 'hi', timestamp: now })
    seedManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      api: 'fake',
      provider: 'fake',
      model: 'fake',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
      stopReason: 'stop',
      timestamp: now + 1,
    })
    seedManager.appendCustomMessageEntry('typeclaw.restart-self', 'restart instruction', false)
    const sessionFile = seedManager.getSessionFile()
    if (!sessionFile) throw new Error('expected persisted session file')
    return { agentDir, sessionsDir, sessionId: seedManager.getSessionId(), sessionFile }
  }

  async function writeHandoff(
    agentDir: string,
    payload: { restartedAt: string; originatingSessionId: string; originatingSessionFile: string },
  ): Promise<void> {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(agentDir, '.typeclaw'), { recursive: true })
    await writeFile(
      join(agentDir, '.typeclaw', 'restart-pending.json'),
      JSON.stringify({ schemaVersion: 1, ...payload }),
      'utf8',
    )
  }

  test('reopens the originating session and fires a kick prompt when a fresh handoff is present', async () => {
    // given
    const { agentDir, sessionId, sessionFile } = await makeAgentDirWithSession()
    await writeHandoff(agentDir, {
      restartedAt: new Date().toISOString(),
      originatingSessionId: sessionId,
      originatingSessionFile: basename(sessionFile),
    })

    const session = createFakeSession()
    const stream = createStream()
    const observed: CreateSessionOptions[] = []
    const factory = createSessionFactory({ agentDir })
    const built = createServer({
      port: 0,
      agentDir,
      sessionFactory: factory,
      stream,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    const connected = await waitFor((m) => m.type === 'connected')

    // then
    if (connected.type !== 'connected') throw new Error('unreachable')
    expect(connected.sessionId).toBe(sessionId)
    await waitForState(() => session.promptCalls.length > 0)
    expect(session.promptCalls).toHaveLength(1)
    expect(session.promptCalls[0]).toContain(' ')
    expect(session.promptCalls[0]).toMatch(/<current-time>.*<\/current-time>/)

    ws.close()
  })

  test('cold-starts a fresh session when no handoff file is present', async () => {
    // given
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-server-handoff-cold-'))

    const session = createFakeSession()
    const stream = createStream()
    const factory = createSessionFactory({ agentDir })
    const built = createServer({
      port: 0,
      agentDir,
      sessionFactory: factory,
      stream,
      createSession: async () => session,
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    const connected = await waitFor((m) => m.type === 'connected')

    // then
    if (connected.type !== 'connected') throw new Error('unreachable')
    expect(connected.sessionId).not.toBe('')
    await expectStable(() => session.promptCalls.length > 0, { durationMs: 200, intervalMs: 50 })
    expect(session.promptCalls).toEqual([])

    ws.close()
  })

  test('ignores an expired handoff file (>60s old) and cold-starts instead', async () => {
    // given
    const { agentDir, sessionId, sessionFile } = await makeAgentDirWithSession()
    await writeHandoff(agentDir, {
      restartedAt: new Date(Date.now() - 90_000).toISOString(),
      originatingSessionId: sessionId,
      originatingSessionFile: basename(sessionFile),
    })

    const session = createFakeSession()
    const stream = createStream()
    const factory = createSessionFactory({ agentDir })
    const built = createServer({
      port: 0,
      agentDir,
      sessionFactory: factory,
      stream,
      createSession: async () => session,
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    const connected = await waitFor((m) => m.type === 'connected')

    // then
    if (connected.type !== 'connected') throw new Error('unreachable')
    expect(connected.sessionId).not.toBe(sessionId)
    await expectStable(() => session.promptCalls.length > 0, { durationMs: 200, intervalMs: 50 })
    expect(session.promptCalls).toEqual([])

    ws.close()
  })

  test('handoff is consumed exactly once across multiple ws opens (second ws is a fresh session)', async () => {
    // given
    const { agentDir, sessionId, sessionFile } = await makeAgentDirWithSession()
    await writeHandoff(agentDir, {
      restartedAt: new Date().toISOString(),
      originatingSessionId: sessionId,
      originatingSessionFile: basename(sessionFile),
    })

    const sessions: ReturnType<typeof createFakeSession>[] = []
    const stream = createStream()
    const factory = createSessionFactory({ agentDir })
    const built = createServer({
      port: 0,
      agentDir,
      sessionFactory: factory,
      stream,
      createSession: async () => {
        const s = createFakeSession()
        sessions.push(s)
        return s
      },
    }).start()
    server = built
    const url = `ws://localhost:${built.port}`

    // when
    const a = await connect(url)
    const connectedA = await a.waitFor((m) => m.type === 'connected')
    if (connectedA.type !== 'connected') throw new Error('unreachable')
    a.ws.close()

    const b = await connect(url)
    const connectedB = await b.waitFor((m) => m.type === 'connected')

    // then
    if (connectedB.type !== 'connected') throw new Error('unreachable')
    expect(connectedA.sessionId).toBe(sessionId)
    expect(connectedB.sessionId).not.toBe(sessionId)

    b.ws.close()
  })
})

describe('createServer TUI subagent orchestration wiring', () => {
  test('forwards liveSubagentRegistry, subagentRegistry (from runtimeSnapshot), and createSessionForSubagent into createSession on ws open', async () => {
    // given
    const session = createFakeSession()
    const liveSubagentRegistry = new LiveSubagentRegistry()
    const subagents: SubagentRegistry = { scout: { systemPrompt: 's', visibility: 'public' } }
    const createSessionForSubagent: CreateSessionForSubagent = async () =>
      ({ session, hooks: {} as HookBus, sessionId: 'sub' }) as never
    const pluginRuntime = makeRuntimeWith({ subagents })
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
      agentDir: '/agent',
      pluginRuntime,
      liveSubagentRegistry,
      createSessionForSubagent,
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // then
    expect(observed).toHaveLength(1)
    expect(observed[0]?.liveSubagentRegistry).toBe(liveSubagentRegistry)
    expect(observed[0]?.subagentRegistry).toBe(subagents)
    expect(observed[0]?.createSessionForSubagent).toBe(createSessionForSubagent)

    ws.close()
  })

  test('omits each orchestration field when the corresponding ServerOption is unset (regression: gate stays closed for tests that did not opt in)', async () => {
    // given
    const session = createFakeSession()
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // then
    expect(observed).toHaveLength(1)
    expect(observed[0]?.liveSubagentRegistry).toBeUndefined()
    expect(observed[0]?.subagentRegistry).toBeUndefined()
    expect(observed[0]?.createSessionForSubagent).toBeUndefined()

    ws.close()
  })

  test('subagentRegistry stays bound to the snapshot taken at ws open (later pluginRuntime swap does not affect already-connected session)', async () => {
    // given
    const session = createFakeSession()
    const firstSubagents: SubagentRegistry = { scout: { systemPrompt: 'first', visibility: 'public' } }
    const pluginRuntime = makeRuntimeWith({ subagents: firstSubagents })
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      createSession: async (options = {}) => {
        observed.push(options)
        return session
      },
      agentDir: '/agent',
      pluginRuntime,
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')
    pluginRuntime.swap({
      registry: EMPTY_REGISTRY,
      hooks: createHookBus(),
      subagents: { explorer: { systemPrompt: 'second', visibility: 'public' } },
      pluginSubagentByShim: new WeakMap(),
      hasAnyPluginContent: false,
      loadedPlugins: [],
      materializedSkills: null,
    })

    // then
    expect(observed[0]?.subagentRegistry).toBe(firstSubagents)

    ws.close()
  })
})

describe('createServer TUI permission wiring', () => {
  test('lets an owner TUI search memory without a memory-specific permission gate', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-server-memory-permissions-'))
    await mkdir(topicsDir(agentDir), { recursive: true })
    await writeFile(
      topicShardPath(agentDir, 'tui-memory-access'),
      renderShard(
        { heading: 'The launch phrase is aurora compass.', cites: 0, days: 1, lastReinforced: '2026-07-14' },
        'The launch phrase is aurora compass.\nfragments:',
      ),
      'utf8',
    )
    const permissions = createPermissionService()
    const session = createFakeSession()
    const searchCompleted = Promise.withResolvers<{ queryResult: unknown; topicResult: unknown }>()
    const built = createServer({
      port: 0,
      agentDir,
      permissions,
      createSession: async (options = {}) => {
        try {
          const origin = options.origin
          const sessionPermissions = options.permissions
          if (origin?.kind !== 'tui' || sessionPermissions === undefined) {
            throw new Error('missing TUI permission wiring')
          }
          const tool = createMemorySearchTool()
          const context = {
            signal: undefined,
            sessionId: origin.sessionId,
            agentDir,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
          }
          const queryResult = (await tool.execute(tool.parameters.parse({ query: 'aurora compass' }), context)).details
          const topicResult = (await tool.execute(tool.parameters.parse({ topic: 'tui-memory-access' }), context))
            .details
          searchCompleted.resolve({ queryResult, topicResult })
          return session
        } catch (error) {
          searchCompleted.reject(error)
          throw error
        }
      },
    }).start()
    server = built

    try {
      const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
      // `connected` is intentionally sent only after async session creation.
      // Await the operation under test directly so filesystem contention cannot
      // race the websocket helper's short transport-message deadline.
      const { queryResult, topicResult } = await searchCompleted.promise
      await waitFor((message) => message.type === 'connected')

      expect(queryResult).toMatchObject({ matches: [{ source: 'topic', slug: 'tui-memory-access' }] })
      expect(topicResult).toMatchObject({ matches: [{ source: 'topic', slug: 'tui-memory-access' }] })
      ws.close()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})

describe('createServer with stream — input queueing bugfix', () => {
  test('a single prompt is published to the stream, drained, and yields a done message', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'prompt', text: 'hello' }))
    await waitForState(() => session.promptCalls.length > 0)
    expect(session.promptCalls).toEqual([expect.stringContaining('hello')])

    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    // then
    expect(session.promptCalls).toEqual([expect.stringContaining('hello')])

    ws.close()
  })

  test('stream drain appends retrieval context populated by session.turn.start hooks', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const agentDir = await mkdtemp(join(tmpdir(), 'server-retrieval-'))
    const hooks = createHookBus()
    hooks.registerAll(
      'retriever',
      agentDir,
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.turn.start': (event) => {
          expect(event.userPrompt).toBe('hello')
          if (event.retrievalContext === undefined) throw new Error('missing retrievalContext')
          event.retrievalContext.results = '## Retrieved memory\n\n### Topic\n\nExcerpt'
        },
      },
    )
    const { url } = await startWithSession(session, {
      stream,
      agentDir,
      pluginRegistry: EMPTY_REGISTRY,
      pluginHooks: hooks,
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'prompt', text: 'hello' }))
    await waitForState(() => session.promptCalls.length > 0)

    // then
    const prompt = session.promptCalls[0] ?? ''
    expect(prompt).toContain('<current-time>')
    expect(prompt).toContain('hello')
    expect(prompt).toContain('## Retrieved memory\n\n### Topic\n\nExcerpt')

    session.resolvePrompt()
    ws.close()
    await rm(agentDir, { recursive: true, force: true })
  })

  test('emits prompt_started before invoking session.prompt() so the TUI can render execution-order history', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))
    const started = await waitFor((m) => m.type === 'prompt_started')

    // then: prompt_started arrived; session.prompt was called with the same text
    if (started.type !== 'prompt_started') throw new Error('unreachable')
    expect(started.text).toBe('hi')
    expect(started.messageId).toBeDefined()
    expect(session.promptCalls).toEqual([expect.stringContaining('hi')])

    session.resolvePrompt()
    ws.close()
  })

  test('two concurrent prompts are serialized via the drain loop (no concurrent session.prompt calls)', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: fire two prompts back-to-back while the first is still in flight
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await waitForState(() => session.promptCalls.length > 0)
    await expectStable(() => session.promptCalls.length > 1, { durationMs: 15, description: 'second prompt' })

    // then: only the first reached session.prompt — the second is queued
    expect(session.promptCalls).toEqual([expect.stringContaining('first')])

    // when: first completes
    session.resolvePrompt()
    await waitForState(() => session.promptCalls.length === 2)

    // then: second now reaches session.prompt
    expect(session.promptCalls).toEqual([expect.stringContaining('first'), expect.stringContaining('second')])

    session.resolvePrompt()
    ws.close()
  })

  test('queue_state is pushed to the client when prompts are queued and drained', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor, received } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: send two prompts; only the first should be in flight, the second should be visible in queue_state
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await waitForState(() => {
      const states = received.filter(
        (m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state',
      )
      const last = states[states.length - 1]
      return last && last.pending.length > 0
    })

    const queueStates = received.filter(
      (m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state',
    )
    expect(queueStates.length).toBeGreaterThan(0)
    const last = queueStates[queueStates.length - 1]!
    expect(last.pending.map((p) => p.text)).toEqual(['second'])

    session.resolvePrompt()
    await waitForState(() => session.promptCalls.length === 2)
    session.resolvePrompt()
    ws.close()
  })

  test('queue_cancel removes a queued prompt before it drains', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor, received } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await waitForState(() => {
      const last = received
        .filter((m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state')
        .at(-1)
      return last && last.pending.length > 0
    })

    const queueStateBefore = received
      .filter((m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state')
      .at(-1)
    expect(queueStateBefore?.pending.map((p) => p.text)).toEqual(['second'])
    const queuedId = queueStateBefore!.pending[0]!.id

    // when: cancel the queued one
    ws.send(JSON.stringify({ type: 'queue_cancel', messageId: queuedId }))
    await waitForState(() => {
      const last = received
        .filter((m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state')
        .at(-1)
      return last !== undefined && last.pending.length === 0
    })

    // then: queue is empty
    const queueStateAfter = received
      .filter((m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state')
      .at(-1)
    expect(queueStateAfter?.pending).toEqual([])

    // and: when first completes, second is NOT processed
    session.resolvePrompt()
    await expectStable(() => session.promptCalls.length > 1, { durationMs: 20, description: 'second prompt' })
    expect(session.promptCalls).toEqual([expect.stringContaining('first')])

    ws.close()
  })

  test('broadcast stream messages are forwarded to the client as notification', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'mood', value: 'happy' } })

    // then
    const msg = await waitFor((m) => m.type === 'notification')
    if (msg.type !== 'notification') throw new Error('unreachable')
    expect(msg.payload).toEqual({ kind: 'mood', value: 'happy' })

    ws.close()
  })

  test('stream messages targeted at a different sessionId are not delivered to this session', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: publish to a different session id
    stream.publish({
      target: { kind: 'session', sessionId: 'someone-else' },
      payload: { kind: 'prompt', text: 'not for us' },
    })
    await expectStable(() => session.promptCalls.length > 0, { durationMs: 15, description: 'foreign prompt' })

    // then: nothing reaches this session.prompt
    expect(session.promptCalls).toEqual([])

    ws.close()
  })

  test('an interrupt-delivery prompt aborts the in-flight prompt before sending the new one', async () => {
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: first prompt starts
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    await waitForState(() => session.promptCalls.length > 0)
    expect(session.promptCalls).toEqual([expect.stringContaining('first')])
    expect(session.abortCalls).toBe(0)

    // when: interrupt-delivery prompt arrives
    ws.send(JSON.stringify({ type: 'prompt', text: 'urgent', delivery: 'interrupt' }))
    await waitForState(() => session.abortCalls >= 1 && session.promptCalls.some((p) => p.includes('urgent')))

    // then: abort was called, then second prompt was sent
    expect(session.abortCalls).toBeGreaterThanOrEqual(1)
    expect(session.promptCalls.some((p) => p.includes('urgent'))).toBe(true)

    session.resolvePrompt()
    ws.close()
  })

  test('close() unsubscribes from the stream so further publishes do not error', async () => {
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.close()
    await waitForState(() => ws.readyState === WebSocket.CLOSED)

    // when: publish a broadcast after close
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'noise' } })

    // then: no crash; the test passes if we get here
    expect(true).toBe(true)
  })
})

describe('createServer subagent.completed broadcast → session reminder injection', () => {
  test('matching parentSessionId enqueues a <system-reminder> prompt', async () => {
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    const connected = await waitFor((m) => m.type === 'connected')
    if (connected.type !== 'connected') throw new Error('unreachable')
    const sessionId = connected.sessionId

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_xyz',
        subagent: 'explorer',
        parentSessionId: sessionId,
        ok: true,
        durationMs: 5_000,
      },
    })

    await waitForState(() => session.promptCalls.length > 0)
    const text = session.promptCalls[0] ?? ''
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('explorer')
    expect(text).toContain('bg_xyz')
    expect(text).toContain('completed')
    expect(text).toContain('subagent_output')

    session.resolvePrompt()
    ws.close()
  })

  test('non-matching parentSessionId is ignored (no reminder enqueued)', async () => {
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_other',
        subagent: 'explorer',
        parentSessionId: 'someone-else',
        ok: true,
        durationMs: 100,
      },
    })

    await expectStable(() => session.promptCalls.length > 0, {
      durationMs: 20,
      description: 'foreign completion reminder',
    })
    expect(session.promptCalls).toEqual([])

    ws.close()
  })

  test('failed subagent reminder includes error message and FAILED marker', async () => {
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    const connected = await waitFor((m) => m.type === 'connected')
    if (connected.type !== 'connected') throw new Error('unreachable')

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_err',
        subagent: 'explorer',
        parentSessionId: connected.sessionId,
        ok: false,
        durationMs: 1_500,
        error: 'provider rate limit',
      },
    })

    await waitForState(() => session.promptCalls.length > 0)
    const text = session.promptCalls[0] ?? ''
    expect(text).toContain('FAILED')
    expect(text).toContain('provider rate limit')

    session.resolvePrompt()
    ws.close()
  })

  test('non subagent.completed broadcasts do not enqueue prompts', async () => {
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    const connected = await waitFor((m) => m.type === 'connected')
    if (connected.type !== 'connected') throw new Error('unreachable')

    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'something-else',
        parentSessionId: connected.sessionId,
      },
    })

    await expectStable(() => session.promptCalls.length > 0, {
      durationMs: 20,
      description: 'unrelated broadcast',
    })
    expect(session.promptCalls).toEqual([])

    ws.close()
  })
})

describe('createServer fires session.idle hook after every prompt completion', () => {
  function stubSessionFactory(opts: { transcriptPath?: string }): SessionFactory {
    return {
      sessionDir: () => '/tmp/test-sessions',
      createPersisted: () =>
        ({
          getSessionId: () => 'ses_fake',
          getSessionFile: () => opts.transcriptPath,
        }) as unknown as SessionManager,
    }
  }

  test('runSessionIdle is called once per successful prompt completion (with transcript path)', async () => {
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const idleEvents: { sessionId: string; parentTranscriptPath: string | undefined }[] = []
    const hooks = createHookBus()
    hooks.registerAll(
      'p',
      '/agent',
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.idle': (event) => {
          idleEvents.push({ sessionId: event.sessionId, parentTranscriptPath: event.parentTranscriptPath })
        },
      },
    )

    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/test-sessions/ses_fake.jsonl' }),
      agentDir: '/agent',
      pluginRegistry: emptyRegistry(),
      pluginHooks: hooks,
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await waitForState(() => session.promptCalls.length > 0)
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')
    await waitForState(() => idleEvents.length > 0)

    expect(idleEvents).toHaveLength(1)
    expect(idleEvents[0]?.sessionId).toBe('ses_fake')
    expect(idleEvents[0]?.parentTranscriptPath).toBe('/tmp/test-sessions/ses_fake.jsonl')
    ws.close()
  })

  test('runSessionIdle is called even when the prompt throws', async () => {
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const idleEvents: string[] = []
    const hooks = createHookBus()
    hooks.registerAll(
      'p',
      '/agent',
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.idle': (event) => {
          idleEvents.push(event.sessionId)
        },
      },
    )

    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/x.jsonl' }),
      agentDir: '/agent',
      pluginRegistry: emptyRegistry(),
      pluginHooks: hooks,
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await waitForState(() => session.promptCalls.length > 0)
    session.rejectPrompt(new Error('llm boom'))
    await waitFor((m) => m.type === 'error')
    await waitForState(() => idleEvents.length > 0)

    expect(idleEvents).toHaveLength(1)
    ws.close()
  })

  test('completes a prompt cleanly when no plugin hooks are attached (no idle hook to fire)', async () => {
    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/x.jsonl' }),
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await waitForState(() => session.promptCalls.length > 0)
    session.resolvePrompt()
    const done = await waitFor((m) => m.type === 'done')

    expect(done.type).toBe('done')
    ws.close()
  })
})

describe('createServer surfaces LLM errors to logger', () => {
  function stubSessionFactory(): SessionFactory {
    return {
      sessionDir: () => '/tmp/test-sessions',
      createPersisted: () =>
        ({
          getSessionId: () => 'ses_fake',
          getSessionFile: () => undefined,
        }) as unknown as SessionManager,
    }
  }

  const silentLogger: ServerLogger = { info: () => {}, warn: () => {}, error: () => {} }

  test('logs to logger.error when session.prompt() throws in the drain-loop path (so typeclaw logs surfaces the failure)', async () => {
    const errors: string[] = []
    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory(),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await waitForState(() => session.promptCalls.length > 0)
    session.rejectPrompt(new Error('llm boom'))
    const errFrame = await waitFor((m) => m.type === 'error')

    if (errFrame.type !== 'error') throw new Error('unreachable')
    expect(errFrame.message).toBe('llm boom')
    expect(errors.some((e) => /\[server\] ses_fake: prompt failed: llm boom/.test(e))).toBe(true)
    ws.close()
  })

  test('logs to logger.error when session.prompt() throws in the fallback path (no stream)', async () => {
    const errors: string[] = []
    const session = createFakeSession()

    const { url } = await startWithSession(session, {
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    const { ws, waitFor } = await connect(url)
    const opened = await waitFor((m) => m.type === 'connected')
    if (opened.type !== 'connected') throw new Error('unreachable')

    ws.send(JSON.stringify({ type: 'prompt', text: 'hello' }))
    await waitForState(() => session.promptCalls.length > 0)
    session.rejectPrompt(new Error('fallback boom'))
    const errFrame = await waitFor((m) => m.type === 'error')

    if (errFrame.type !== 'error') throw new Error('unreachable')
    expect(errFrame.message).toBe('fallback boom')
    expect(errors.some((e) => /\[server\] .+: prompt failed: fallback boom/.test(e))).toBe(true)
    ws.close()
  })

  test('logs to logger.error when the assistant message ends with stopReason: error (non-throwing upstream LLM failure)', async () => {
    const errors: string[] = []
    const session = createFakeSession()

    const { url } = await startWithSession(session, {
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'billing: account inactive' },
    } as unknown as Parameters<typeof session.emit>[0])

    const errFrame = await waitFor((m) => m.type === 'error')
    if (errFrame.type !== 'error') throw new Error('unreachable')
    expect(errFrame.message).toBe('billing: account inactive')
    expect(errors.some((e) => /\[server\] .+: LLM call failed: billing: account inactive/.test(e))).toBe(true)
    ws.close()
  })

  test('does not log when the assistant message ends with stopReason: aborted (user pressed Escape)', async () => {
    const errors: string[] = []
    const session = createFakeSession()

    const { url } = await startWithSession(session, {
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'aborted' },
    } as unknown as Parameters<typeof session.emit>[0])

    await expectStable(() => errors.length > 0, { durationMs: 15, description: 'aborted-error log' })
    expect(errors).toEqual([])
    ws.close()
  })
})

describe('createServer plugin hooks', () => {
  test('fires session.start with the session id and agentDir on websocket open', async () => {
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const fired: { sessionId: string; agentDir: string }[] = []
    const hooks = createHookBus()
    hooks.registerAll(
      'p',
      '/agent',
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.start': (event) => {
          fired.push({ sessionId: event.sessionId, agentDir: event.agentDir })
        },
      },
    )

    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      pluginRegistry: emptyRegistry(),
      pluginHooks: hooks,
      agentDir: '/agent',
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    expect(fired).toHaveLength(1)
    expect(fired[0]?.agentDir).toBe('/agent')
    ws.close()
  })

  test('awaits session.end before resolving the close handler', async () => {
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const endResolve: { fn: (() => void) | null } = { fn: null }
    let ended = false
    const hooks = createHookBus()
    hooks.registerAll(
      'p',
      '/agent',
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.end': () =>
          new Promise<void>((resolve) => {
            endResolve.fn = () => {
              ended = true
              resolve()
            }
          }),
      },
    )

    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      pluginRegistry: emptyRegistry(),
      pluginHooks: hooks,
      agentDir: '/agent',
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.close()
    const releaseEnd = await waitForState(() => endResolve.fn)
    expect(ended).toBe(false)
    expect(session.disposeCalls).toBe(0)
    releaseEnd()
    await waitForState(() => ended && session.disposeCalls > 0)
    expect(ended).toBe(true)
    expect(session.disposeCalls).toBe(1)
  })
})

describe('createServer session lifecycle', () => {
  test('disposes the underlying AgentSession on websocket close', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.close()
    await waitForState(() => session.disposeCalls > 0)

    expect(session.disposeCalls).toBe(1)
  })
})

describe('createServer scoped reload', () => {
  test('reload without scope runs reloadAll and returns every scope result', async () => {
    // given
    const { ReloadRegistry } = await import('@/reload')
    const reloadRegistry = new ReloadRegistry()
    reloadRegistry.register({
      scope: 'config',
      description: 'config',
      reload: async () => ({ scope: 'config', ok: true, summary: 'cfg ok' }),
    })
    reloadRegistry.register({
      scope: 'cron',
      description: 'cron',
      reload: async () => ({ scope: 'cron', ok: true, summary: 'cron ok' }),
    })

    const session = createFakeSession()
    const built = createServer({
      port: 0,
      reloadAll: () => reloadRegistry.reloadAll(),
      reloadRegistry,
      createSession: async () => session,
    }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'reload' }))
    const result = await waitFor((m) => m.type === 'reload_result')

    // then
    if (result.type !== 'reload_result') throw new Error('unreachable')
    expect(result.results.map((r) => r.scope)).toEqual(['config', 'cron'])
    ws.close()
  })

  test('reload with scope runs only that reloadable and returns a single result', async () => {
    // given
    const { ReloadRegistry } = await import('@/reload')
    const calls: string[] = []
    const reloadRegistry = new ReloadRegistry()
    reloadRegistry.register({
      scope: 'config',
      description: 'config',
      reload: async () => {
        calls.push('config')
        return { scope: 'config', ok: true, summary: 'cfg ok' }
      },
    })
    reloadRegistry.register({
      scope: 'cron',
      description: 'cron',
      reload: async () => {
        calls.push('cron')
        return { scope: 'cron', ok: true, summary: 'cron ok' }
      },
    })

    const session = createFakeSession()
    const built = createServer({
      port: 0,
      reloadAll: () => reloadRegistry.reloadAll(),
      reloadRegistry,
      createSession: async () => session,
    }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'reload', scope: 'cron' }))
    const result = await waitFor((m) => m.type === 'reload_result')

    // then
    if (result.type !== 'reload_result') throw new Error('unreachable')
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.scope).toBe('cron')
    expect(calls).toEqual(['cron'])
    ws.close()
  })

  test('reload with unknown scope returns a single failure result', async () => {
    // given
    const { ReloadRegistry } = await import('@/reload')
    const reloadRegistry = new ReloadRegistry()
    reloadRegistry.register({
      scope: 'config',
      description: 'config',
      reload: async () => ({ scope: 'config', ok: true, summary: 'cfg ok' }),
    })

    const session = createFakeSession()
    const built = createServer({
      port: 0,
      reloadAll: () => reloadRegistry.reloadAll(),
      reloadRegistry,
      createSession: async () => session,
    }).start()
    server = built

    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'reload', scope: 'no-such-scope' }))
    const result = await waitFor((m) => m.type === 'reload_result')

    // then
    if (result.type !== 'reload_result') throw new Error('unreachable')
    expect(result.results).toHaveLength(1)
    const first = result.results[0]
    expect(first?.scope).toBe('no-such-scope')
    expect(first?.ok).toBe(false)
    ws.close()
  })
})

describe('createServer cron_list handler', () => {
  async function makeEmptyRegistry(): Promise<PluginRegistry> {
    const { emptyRegistry } = await import('@/plugin/registry')
    return emptyRegistry()
  }

  function promptJob(id: string, schedule = '*/5 * * * *'): CronJob {
    return {
      id,
      schedule,
      enabled: true,
      kind: 'prompt',
      prompt: 'do it',
      scheduledByRole: 'owner',
    }
  }

  test('responds with ok: false when agentDir is not configured', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'cron_list', requestId: 'req-1' }))
    const reply = await waitFor((m) => m.type === 'cron_list_result')

    if (reply.type !== 'cron_list_result') throw new Error('unreachable')
    expect(reply.requestId).toBe('req-1')
    expect(reply.result.ok).toBe(false)
    if (reply.result.ok) throw new Error('unreachable')
    expect(reply.result.reason).toContain('agentDir')
    ws.close()
  })

  test('returns user jobs from cron.json and plugin jobs from registry, merged', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cron-list-'))
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'user-job', schedule: '0 * * * *', kind: 'prompt', prompt: 'hi', scheduledByRole: 'owner' }],
      }),
    )

    const registry = await makeEmptyRegistry()
    registry.cronJobs.push({
      pluginName: 'memory',
      localId: 'dreaming',
      globalId: '__plugin_memory_dreaming',
      job: { ...promptJob('__plugin_memory_dreaming', '*/30 * * * *'), subagent: 'dreaming' } as CronJob,
    })

    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      agentDir,
      pluginRegistry: registry,
      pluginHooks: createHookBus(),
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'cron_list', requestId: 'req-merge' }))
    const reply = await waitFor((m) => m.type === 'cron_list_result')

    if (reply.type !== 'cron_list_result') throw new Error('unreachable')
    expect(reply.requestId).toBe('req-merge')
    if (!reply.result.ok) throw new Error(`unexpected failure: ${reply.result.reason}`)
    expect(reply.result.jobs).toHaveLength(2)
    const ids = reply.result.jobs.map((j) => j.id).sort()
    expect(ids).toEqual(['__plugin_memory_dreaming', 'user-job'])
    const plugin = reply.result.jobs.find((j) => j.source.kind === 'plugin')!
    expect(plugin.source).toEqual({ kind: 'plugin', pluginName: 'memory', localId: 'dreaming' })
    expect(plugin.subagent).toBe('dreaming')
    const user = reply.result.jobs.find((j) => j.source.kind === 'user')!
    expect(user.id).toBe('user-job')
    expect(typeof reply.result.nowMs).toBe('number')
    ws.close()
  })

  test('returns ok: true with empty jobs when neither source has any', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cron-list-empty-'))
    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      agentDir,
      pluginRegistry: await makeEmptyRegistry(),
      pluginHooks: createHookBus(),
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'cron_list', requestId: 'req-empty' }))
    const reply = await waitFor((m) => m.type === 'cron_list_result')

    if (reply.type !== 'cron_list_result' || !reply.result.ok) throw new Error('unreachable')
    expect(reply.result.jobs).toEqual([])
    ws.close()
  })

  test('returns ok: false when cron.json is invalid JSON', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cron-list-badjson-'))
    await writeFile(join(agentDir, 'cron.json'), '{ this is not json')

    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      agentDir,
      pluginRegistry: await makeEmptyRegistry(),
      pluginHooks: createHookBus(),
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'cron_list', requestId: 'req-bad' }))
    const reply = await waitFor((m) => m.type === 'cron_list_result')

    if (reply.type !== 'cron_list_result') throw new Error('unreachable')
    expect(reply.result.ok).toBe(false)
    if (reply.result.ok) throw new Error('unreachable')
    expect(reply.result.reason).toContain('cron.json')
    ws.close()
  })

  test('reports invalid subagent reference when plugin runtime is available', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cron-list-bad-subagent-'))
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [
          {
            id: 'refs-missing',
            schedule: '*/5 * * * *',
            kind: 'prompt',
            prompt: 'hi',
            scheduledByRole: 'owner',
            subagent: 'no-such-subagent',
          },
        ],
      }),
    )

    const session = createFakeSession()
    const { url } = await startWithSession(session, {
      agentDir,
      pluginRegistry: await makeEmptyRegistry(),
      pluginHooks: createHookBus(),
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'cron_list', requestId: 'req-bad-sub' }))
    const reply = await waitFor((m) => m.type === 'cron_list_result')

    if (reply.type !== 'cron_list_result') throw new Error('unreachable')
    expect(reply.result.ok).toBe(false)
    if (reply.result.ok) throw new Error('unreachable')
    expect(reply.result.reason).toContain('no-such-subagent')
    ws.close()
  })
})

describe('createServer tunnel handlers', () => {
  function makeTunnelManager(): TunnelManager & { appendLog: (name: string, line: string) => void } {
    const states: TunnelState[] = [
      {
        name: 'github-webhook',
        provider: 'cloudflare-quick',
        for: { kind: 'channel', name: 'github' },
        url: 'https://example.trycloudflare.com',
        status: 'healthy',
        lastUrlAt: 123,
        detail: 'connected',
      },
      {
        name: 'demo',
        provider: 'external',
        for: { kind: 'manual' },
        url: 'https://demo.example.com',
        status: 'healthy',
        lastUrlAt: 456,
        detail: 'external URL configured',
      },
    ]
    const logs = new Map<string, string[]>([
      ['github-webhook', ['first', 'second']],
      ['demo', ['demo-line']],
    ])
    const subscribers = new Map<string, Set<(line: string) => void>>()
    return {
      start: async () => {},
      stop: async () => {},
      snapshot: () => states,
      urlFor: (name) => states.find((state) => state.name === name)?.url ?? null,
      tail: (name) => logs.get(name) ?? [],
      subscribeToLogs: (name, cb) => {
        const set = subscribers.get(name) ?? new Set<(line: string) => void>()
        subscribers.set(name, set)
        set.add(cb)
        return () => set.delete(cb)
      },
      appendLog: (name, line) => {
        logs.get(name)?.push(line)
        for (const cb of subscribers.get(name) ?? []) cb(line)
      },
    }
  }

  test('tunnel_list_request returns the configured tunnels', async () => {
    const manager = makeTunnelManager()
    const { url } = await startWithSession(createFakeSession(), { tunnelManager: manager })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'tunnel_list_request', requestId: 'tunnels' }))
    const reply = await waitFor((m) => m.type === 'tunnel_list_response')

    if (reply.type !== 'tunnel_list_response' || !reply.ok) throw new Error('unreachable')
    expect(reply.requestId).toBe('tunnels')
    expect(reply.tunnels.map((entry) => entry.name)).toEqual(['github-webhook', 'demo'])
    ws.close()
  })

  test('tunnel_status_request returns one tunnel and errors for unknown names', async () => {
    const manager = makeTunnelManager()
    const { url } = await startWithSession(createFakeSession(), { tunnelManager: manager })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'tunnel_status_request', requestId: 'known', name: 'demo' }))
    const known = await waitFor((m) => m.type === 'tunnel_status_response' && m.requestId === 'known')
    ws.send(JSON.stringify({ type: 'tunnel_status_request', requestId: 'missing', name: 'missing' }))
    const missing = await waitFor((m) => m.type === 'tunnel_status_response' && m.requestId === 'missing')

    if (known.type !== 'tunnel_status_response' || !known.ok) throw new Error('unreachable')
    expect(known.tunnel.name).toBe('demo')
    if (missing.type !== 'tunnel_status_response' || missing.ok) throw new Error('unreachable')
    expect(missing.error).toContain('unknown tunnel')
    ws.close()
  })

  test('/tunnel-logs follow=false sends snapshot then end', async () => {
    const manager = makeTunnelManager()
    const built = createServer({
      port: 0,
      createSession: async () => createFakeSession(),
      tunnelManager: manager,
    }).start()
    server = built
    const { ws, waitFor } = await connectTunnelLogs(`ws://localhost:${built.port}/tunnel-logs`)

    ws.send(JSON.stringify({ type: 'subscribe', name: 'github-webhook', follow: false }))
    const snapshot = await waitFor((m) => m.type === 'snapshot')
    const end = await waitFor((m) => m.type === 'end')

    if (snapshot.type !== 'snapshot') throw new Error('unreachable')
    expect(snapshot.lines).toEqual(['first', 'second'])
    expect(end.type).toBe('end')
    ws.close()
  })

  test('/tunnel-logs follow=true streams appended lines', async () => {
    const manager = makeTunnelManager()
    const built = createServer({
      port: 0,
      createSession: async () => createFakeSession(),
      tunnelManager: manager,
    }).start()
    server = built
    const { ws, waitFor } = await connectTunnelLogs(`ws://localhost:${built.port}/tunnel-logs`)

    ws.send(JSON.stringify({ type: 'subscribe', name: 'github-webhook', follow: true }))
    await waitFor((m) => m.type === 'snapshot')
    manager.appendLog('github-webhook', 'live')
    const line = await waitFor((m) => m.type === 'line')

    expect(line).toEqual({ type: 'line', line: 'live' })
    ws.close()
  })

  test('/tunnel-logs unknown tunnel sends error then end', async () => {
    const manager = makeTunnelManager()
    const built = createServer({
      port: 0,
      createSession: async () => createFakeSession(),
      tunnelManager: manager,
    }).start()
    server = built
    const { ws, waitFor } = await connectTunnelLogs(`ws://localhost:${built.port}/tunnel-logs`)

    ws.send(JSON.stringify({ type: 'subscribe', name: 'missing', follow: false }))
    const error = await waitFor((m) => m.type === 'error')
    const end = await waitFor((m) => m.type === 'end')

    if (error.type !== 'error') throw new Error('unreachable')
    expect(error.message).toContain('unknown tunnel')
    expect(end.type).toBe('end')
    ws.close()
  })

  test('/tunnel-logs rejects websocket upgrades without the expected token', async () => {
    const manager = makeTunnelManager()
    const built = createServer({
      port: 0,
      createSession: async () => createFakeSession(),
      tunnelManager: manager,
      tuiToken: 'secret',
    }).start()
    server = built

    const ws = new WebSocket(`ws://localhost:${built.port}/tunnel-logs`)

    await new Promise<void>((resolve) => ws.addEventListener('close', () => resolve(), { once: true }))
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
})
