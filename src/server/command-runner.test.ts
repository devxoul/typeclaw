import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import { noopPermissionService } from '@/permissions'
import { createHookBus } from '@/plugin'
import type { PluginCommand, PluginRegistry } from '@/plugin'
import { defineCommand } from '@/plugin/define'
import { emptyRegistry, type RegisteredCommand } from '@/plugin/registry'
import { createPluginRuntime, type PluginRuntime } from '@/run/plugin-runtime'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import { isWindows } from '@/shared'

import {
  bindSignalToSession,
  createCommandRunner,
  runExecForCommand,
  runPromptForCommand,
  type CommandOutbound,
  type CommandSpawnSubagent,
} from './command-runner'

const onWindows = isWindows()

type CapturedFrame =
  | { kind: 'stdout'; callId: string; chunk: string }
  | { kind: 'stderr'; callId: string; chunk: string }
  | { kind: 'exit'; callId: string; code: number }
  | { kind: 'error'; callId: string; message: string }

function makeRuntime(commands: RegisteredCommand[]): PluginRuntime {
  const registry: PluginRegistry = { ...emptyRegistry(), commands }
  return createPluginRuntime({
    registry,
    hooks: createHookBus(),
    subagents: {},
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: commands.length > 0,
    loadedPlugins: [],
    materializedSkills: null,
  })
}

function makeOutboundCapture(): { outbound: CommandOutbound; frames: CapturedFrame[]; decodeStdout: () => string } {
  const frames: CapturedFrame[] = []
  const outbound: CommandOutbound = {
    stdout(callId, chunk) {
      frames.push({ kind: 'stdout', callId, chunk: new TextDecoder().decode(chunk) })
    },
    stderr(callId, chunk) {
      frames.push({ kind: 'stderr', callId, chunk: new TextDecoder().decode(chunk) })
    },
    exit(callId, code) {
      frames.push({ kind: 'exit', callId, code })
    },
    error(callId, message) {
      frames.push({ kind: 'error', callId, message })
    },
  }
  const decodeStdout = () =>
    frames
      .filter((f) => f.kind === 'stdout')
      .map((f) => (f as { chunk: string }).chunk)
      .join('')
  return { outbound, frames, decodeStdout }
}

function registerCommand(
  name: string,
  command: PluginCommand | { surface: 'host' | 'container' | 'either' },
): RegisteredCommand {
  return {
    pluginName: 'test-plugin',
    commandName: name,
    command: command as PluginCommand,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

const noopSpawn: CommandSpawnSubagent = async () => {}

function makeSessionFactoryForTest(): { sessionFactory: SessionFactory; agentDir: string } {
  const agentDir = mkdtempSync(join(tmpdir(), 'typeclaw-cmdrunner-'))
  return { sessionFactory: createSessionFactory({ agentDir }), agentDir }
}

function makeRunner(commands: RegisteredCommand[], wrapOutbound?: (outbound: CommandOutbound) => CommandOutbound) {
  const { outbound, frames, decodeStdout } = makeOutboundCapture()
  const runtime = makeRuntime(commands)
  const { sessionFactory, agentDir } = makeSessionFactoryForTest()
  const runner = createCommandRunner({
    pluginRuntime: runtime,
    permissions: noopPermissionService,
    spawnSubagent: noopSpawn,
    agentDir,
    runtimeVersion: '0.0.0-test',
    containerName: 'test-agent',
    outbound: wrapOutbound === undefined ? outbound : wrapOutbound(outbound),
    sessionFactory,
    channelRouter: undefined,
  })
  return { runner, frames, decodeStdout, agentDir }
}

async function waitForExit(frames: CapturedFrame[], callId: string, timeoutMs = 2_000): Promise<CapturedFrame> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exit = frames.find((f) => f.kind === 'exit' && f.callId === callId)
    if (exit !== undefined) return exit
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timeout waiting for command_exit ${callId}; got ${JSON.stringify(frames)}`)
}

describe('CommandRunner', () => {
  test('QA-C1: host-surface command is rejected with a host-only message', async () => {
    const cmd = defineCommand({
      surface: 'host',
      description: 'host-only',
      run: async () => 0,
    })
    const { runner, frames } = makeRunner([registerCommand('host-only', cmd)])

    runner.start({ callId: 'a1', name: 'host-only', args: undefined }, null)
    await waitForExit(frames, 'a1')

    expect(frames.find((f) => f.kind === 'error')?.message ?? '').toMatch(/host-only/)
    expect(frames.find((f) => f.kind === 'exit')?.code ?? -1).toBe(1)
  })

  test('QA-C2: unknown command name → command_error with exit 1', async () => {
    const { runner, frames } = makeRunner([])
    runner.start({ callId: 'b1', name: 'nope', args: undefined }, null)
    await waitForExit(frames, 'b1')
    expect(frames.find((f) => f.kind === 'error')?.message ?? '').toMatch(/not registered/)
  })

  test('QA-C3: bad args → command_error with exit 2; run is never invoked', async () => {
    let ran = false
    const cmd = defineCommand({
      surface: 'container',
      description: 'needs name',
      args: z.object({ name: z.string() }),
      run: async () => {
        ran = true
        return 0
      },
    })
    const { runner, frames } = makeRunner([registerCommand('typed', cmd)])

    runner.start({ callId: 'c1', name: 'typed', args: { wrong: 'shape' } }, null)
    await waitForExit(frames, 'c1')
    expect(frames.find((f) => f.kind === 'error')).toBeDefined()
    expect(frames.find((f) => f.kind === 'exit')?.code ?? -1).toBe(2)
    expect(ran).toBe(false)
  })

  test('QA-C4: container command writes to stdout and exits 0', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'hello',
      run: async (ctx) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode('hello'))
        writer.releaseLock()
        return 0
      },
    })
    const { runner, frames, decodeStdout } = makeRunner([registerCommand('hello', cmd)])

    runner.start({ callId: 'd1', name: 'hello', args: undefined }, null)
    await waitForExit(frames, 'd1')
    expect(decodeStdout()).toBe('hello')
    expect(frames.find((f) => f.kind === 'exit')?.code ?? -1).toBe(0)
  })

  test('QA-C5: stdin chunks are visible to the command', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'echo stdin',
      run: async (ctx) => {
        const reader = ctx.stdin.getReader()
        let collected = ''
        while (true) {
          const next = await reader.read()
          if (next.done) break
          collected += new TextDecoder().decode(next.value)
        }
        reader.releaseLock()
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(collected))
        writer.releaseLock()
        return 0
      },
    })
    const { runner, frames, decodeStdout } = makeRunner([registerCommand('catstdin', cmd)])

    runner.start({ callId: 'e1', name: 'catstdin', args: undefined }, null)
    runner.feedStdin('e1', btoa('hello '))
    runner.feedStdin('e1', btoa('world'))
    runner.endStdin('e1')

    await waitForExit(frames, 'e1')
    expect(decodeStdout()).toBe('hello world')
  })

  test('QA-C6: abort sets ctx.signal.aborted; command resolves cleanly', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'await signal',
      run: async (ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve()
            return
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return 42
      },
    })
    const { runner, frames } = makeRunner([registerCommand('hang', cmd)])

    runner.start({ callId: 'f1', name: 'hang', args: undefined }, null)
    await new Promise((r) => setTimeout(r, 10))
    runner.abort('f1', 'user requested')

    const exit = await waitForExit(frames, 'f1')
    if (exit.kind === 'exit') expect(exit.code).toBe(42)
  })

  test('QA-C7: either-surface dispatches like container with no permissions ctx', async () => {
    const cmd = defineCommand({
      surface: 'either',
      description: 'either',
      run: async (ctx) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(`agentDir=${ctx.agentDir}`))
        writer.releaseLock()
        return 0
      },
    })
    const { runner, frames, decodeStdout, agentDir } = makeRunner([registerCommand('eitheristic', cmd)])
    runner.start({ callId: 'g1', name: 'eitheristic', args: undefined }, null)
    await waitForExit(frames, 'g1')
    expect(decodeStdout()).toBe(`agentDir=${agentDir}`)
  })

  test('QA-C8: concurrent commands with distinct callIds do not interfere', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'tagged',
      args: z.object({ tag: z.string() }),
      run: async (ctx, args) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(`tag:${args.tag}`))
        writer.releaseLock()
        return 0
      },
    })
    const { runner, frames } = makeRunner([registerCommand('tagged', cmd)])

    runner.start({ callId: 'h1', name: 'tagged', args: { tag: 'A' } }, null)
    runner.start({ callId: 'h2', name: 'tagged', args: { tag: 'B' } }, null)

    await waitForExit(frames, 'h1')
    await waitForExit(frames, 'h2')

    const h1Out = frames
      .filter((f) => f.kind === 'stdout' && f.callId === 'h1')
      .map((f) => (f as { chunk: string }).chunk)
      .join('')
    const h2Out = frames
      .filter((f) => f.kind === 'stdout' && f.callId === 'h2')
      .map((f) => (f as { chunk: string }).chunk)
      .join('')
    expect(h1Out).toBe('tag:A')
    expect(h2Out).toBe('tag:B')
  })

  test('QA-C9: abortForOwner aborts every in-flight command tied to the given owner key', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'await signal',
      run: async (ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve()
            return
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return 0
      },
    })
    const { runner, frames } = makeRunner([registerCommand('hang', cmd)])

    const owner = {}
    runner.start({ callId: 'i1', name: 'hang', args: undefined }, owner)
    runner.start({ callId: 'i2', name: 'hang', args: undefined }, owner)
    await new Promise((r) => setTimeout(r, 10))

    runner.abortForOwner(owner)
    await waitForExit(frames, 'i1')
    await waitForExit(frames, 'i2')
    expect(runner.inFlightCount()).toBe(0)
  })

  test('duplicate callId is rejected with command_error', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'hang',
      run: async (ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
        return 0
      },
    })
    const { runner, frames } = makeRunner([registerCommand('hang', cmd)])

    runner.start({ callId: 'dup', name: 'hang', args: undefined }, null)
    runner.start({ callId: 'dup', name: 'hang', args: undefined }, null)

    expect(frames.filter((f) => f.kind === 'error').length).toBeGreaterThanOrEqual(1)
    expect(frames.find((f) => f.kind === 'error')?.message ?? '').toMatch(/already in flight/)

    runner.abort('dup', 'cleanup')
    await waitForExit(frames, 'dup')
  })

  test('isolated:true warning lands on the per-command stderr (visible to caller)', async () => {
    const pluginWarnings: string[] = []
    const cmd = defineCommand({
      surface: 'container',
      description: 'noop',
      run: async () => 0,
    })
    const registered: RegisteredCommand = {
      pluginName: 'test',
      commandName: 'noop',
      command: cmd,
      logger: { info: () => {}, warn: (m) => pluginWarnings.push(m), error: () => {} },
    }
    const { runner, frames } = makeRunner([registered])
    runner.start({ callId: 'iso', name: 'noop', args: undefined, isolated: true }, null)
    await waitForExit(frames, 'iso')

    // Per-command stderr frames are emitted by the runner outbound; assert
    // the isolated warning shows up there, NOT on the plugin's boot-time
    // logger (which writes to container logs the caller never reads).
    const stderrText = frames
      .filter((f) => f.kind === 'stderr')
      .map((f) => (f as { chunk: string }).chunk)
      .join('')
    expect(stderrText).toMatch(/isolated=true/)
    expect(pluginWarnings.length).toBe(0)
  })

  test('consecutive ctx.logger lines reach stderr in order, all before command_exit', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'chatty',
      run: async (ctx) => {
        ctx.logger.info('first')
        ctx.logger.warn('second')
        ctx.logger.error('third')
        return 0
      },
    })
    const { runner, frames } = makeRunner([registerCommand('chatty', cmd)])
    runner.start({ callId: 'chatty', name: 'chatty', args: undefined }, null)
    await waitForExit(frames, 'chatty')

    // One shared sink backs all three lines, so they must arrive whole and in
    // call order — asserting the exact payload, not just membership.
    const stderrText = frames
      .filter((f) => f.kind === 'stderr')
      .map((f) => (f as { chunk: string }).chunk)
      .join('')
    expect(stderrText).toBe(
      '[command:test-plugin] info: first\n[command:test-plugin] warn: second\n[command:test-plugin] error: third\n',
    )

    // And every one of them must precede command_exit: the server drops the
    // call's websocket route as it emits exit, so a later frame is discarded.
    const kinds = frames.map((f) => f.kind)
    expect(kinds.lastIndexOf('stderr')).toBeLessThan(kinds.indexOf('exit'))
    expect(frames.filter((f) => f.kind === 'error').length).toBe(0)
  })

  test('a throwing stderr sink still reaches command_exit instead of stranding the call', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'chatty',
      run: async (ctx) => {
        ctx.logger.info('first')
        ctx.logger.warn('second')
        return 0
      },
    })
    const { runner, frames } = makeRunner([registerCommand('chatty', cmd)], (outbound) => ({
      ...outbound,
      stderr() {
        throw new Error('sink failure')
      },
    }))
    runner.start({ callId: 'boom', name: 'chatty', args: undefined }, null)
    const exit = await waitForExit(frames, 'boom')

    // A throwing sink errors the stream, and per the Streams standard it stays
    // errored — those lines cannot be delivered by any amount of retrying, and
    // this pins that we do not pretend otherwise. What must still hold is that
    // the write lock is released and the drain settles, so the command reports
    // its own exit code rather than hanging behind a stuck queue.
    expect((exit as { code: number }).code).toBe(0)
  })

  test('ctx.origin is subagent-shaped with parent TUI origin in spawnedByOrigin', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'inspect origin',
      run: async (ctx) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(JSON.stringify(ctx.origin)))
        writer.releaseLock()
        return 0
      },
    })
    const { runner, frames, decodeStdout } = makeRunner([registerCommand('inspect', cmd)])
    runner.start({ callId: 'orig-1', name: 'inspect', args: undefined }, null)
    await waitForExit(frames, 'orig-1')

    const parsed = JSON.parse(decodeStdout()) as {
      kind: string
      subagent: string
      parentSessionId: string
      spawnedByOrigin?: { kind: string; sessionId: string }
    }
    expect(parsed.kind).toBe('subagent')
    expect(parsed.subagent).toBe('plugin-command:inspect')
    expect(parsed.parentSessionId).toBe('command:inspect:orig-1')
    expect(parsed.spawnedByOrigin?.kind).toBe('tui')
    expect(parsed.spawnedByOrigin?.sessionId).toBe('command:inspect:orig-1')
  })

  test('ctx.subagent receives spawnedByOrigin matching the command session origin', async () => {
    const calls: { name: string; payload: unknown; options: unknown }[] = []
    const capturingSpawn: CommandSpawnSubagent = async (name, payload, options) => {
      calls.push({ name, payload, options })
    }
    const cmd = defineCommand({
      surface: 'container',
      description: 'spawns a subagent',
      run: async (ctx) => {
        await ctx.subagent('child', { hello: 'world' })
        return 0
      },
    })
    const { outbound, frames } = makeOutboundCapture()
    const runtime = makeRuntime([registerCommand('parent', cmd)])
    const { sessionFactory, agentDir } = makeSessionFactoryForTest()
    const runner = createCommandRunner({
      pluginRuntime: runtime,
      permissions: noopPermissionService,
      spawnSubagent: capturingSpawn,
      agentDir,
      runtimeVersion: '0.0.0-test',
      containerName: 'test-agent',
      outbound,
      sessionFactory,
      channelRouter: undefined,
    })
    runner.start({ callId: 'sub-1', name: 'parent', args: undefined }, null)
    await waitForExit(frames, 'sub-1')

    expect(calls.length).toBe(1)
    const opts = calls[0]?.options as { spawnedByOrigin?: { kind: string }; parentSessionId?: string } | undefined
    expect(opts?.spawnedByOrigin?.kind).toBe('subagent')
    expect(opts?.parentSessionId).toBe('command:parent:sub-1')
  })
})

describe('bindSignalToSession', () => {
  test('calls session.abort when the signal fires before detach', () => {
    const aborts: number[] = []
    const session = {
      abort: async () => {
        aborts.push(1)
      },
    }
    const controller = new AbortController()
    const detach = bindSignalToSession(controller.signal, session)
    expect(aborts.length).toBe(0)

    controller.abort('user requested')
    expect(aborts.length).toBe(1)

    detach()
  })

  test('aborts the session immediately when the signal is already aborted', () => {
    const aborts: number[] = []
    const session = {
      abort: async () => {
        aborts.push(1)
      },
    }
    const controller = new AbortController()
    controller.abort('pre-aborted')
    bindSignalToSession(controller.signal, session)
    expect(aborts.length).toBe(1)
  })

  test('does not abort the session when the signal never fires (clean prompt completion)', () => {
    const aborts: number[] = []
    const session = {
      abort: async () => {
        aborts.push(1)
      },
    }
    const controller = new AbortController()
    const detach = bindSignalToSession(controller.signal, session)
    detach()
    controller.abort('too late')
    expect(aborts.length).toBe(0)
  })
})

describe('runExecForCommand', () => {
  test('runs a fast command to completion and captures stdio + exit code', async () => {
    const controller = new AbortController()
    const result = await runExecForCommand(
      ['echo hello && echo bye >&2 && exit 3'] as unknown as TemplateStringsArray,
      [],
      {
        cwd: '/tmp',
        signal: controller.signal,
      },
    )
    expect(result.stdout).toBe('hello\n')
    expect(result.stderr).toBe('bye\n')
    expect(result.exitCode).toBe(3)
  })

  test.skipIf(process.platform !== 'linux')('plugin exec shell and grandchild inherit OOM priority', async () => {
    const result = await runExecForCommand(
      ['cat /proc/self/oom_score_adj; sh -c "cat /proc/self/oom_score_adj"'] as unknown as TemplateStringsArray,
      [],
      { cwd: '/tmp', signal: new AbortController().signal },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual(['600', '600'])
  })

  // Windows lacks POSIX process-group signals; covered on Unix. #899
  test.skipIf(onWindows)('aborts a long-running shell promptly via process-group SIGTERM', async () => {
    // Spawn a shell that sleeps for 30s with a background grandchild also
    // sleeping. Abort after 50ms and assert the process exits well before
    // the natural completion — this only happens if the process-group kill
    // (negative-pid) reaches the grandchild; a single-pid SIGTERM on sh
    // alone would leave the orphaned sleep keeping the stdout pipe open.
    const controller = new AbortController()
    const started = Date.now()
    const promise = runExecForCommand(['sleep 30 & wait'] as unknown as TemplateStringsArray, [], {
      cwd: '/tmp',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort('user'), 50)
    const result = await promise
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(2_000)
    // Exit code is non-zero on signalled termination; the exact value
    // depends on whether SIGTERM or SIGKILL won the escalation race, so
    // we just assert the process did NOT exit cleanly.
    expect(result.exitCode).not.toBe(0)
  })

  test('runs to completion when signal never fires (clean path leaves no timer leak)', async () => {
    const controller = new AbortController()
    const result = await runExecForCommand(['echo done'] as unknown as TemplateStringsArray, [], {
      cwd: '/tmp',
      signal: controller.signal,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('done\n')
  })

  // Shebang + chmod are POSIX-only; the local-bin PATH contract is exercised
  // on Unix where the agent container runs. #899
  test.skipIf(onWindows)('resolves a bare command from cwd node_modules/.bin', async () => {
    // given: an executable shim installed only in cwd/node_modules/.bin
    const cwd = mkdtempSync(join(tmpdir(), 'typeclaw-exec-localbin-'))
    const binDir = join(cwd, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const shim = join(binDir, 'agent-localtool')
    writeFileSync(shim, '#!/bin/sh\nprintf "localbin:%s\\n" "$1"\n')
    chmodSync(shim, 0o755)

    // when: the plugin calls it by bare name (no bunx, no path)
    const controller = new AbortController()
    const result = await runExecForCommand(['agent-localtool ok'] as unknown as TemplateStringsArray, [], {
      cwd,
      signal: controller.signal,
    })

    // then: it resolves and runs instead of failing with 127
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('localbin:ok\n')
  })

  test.skipIf(onWindows)('still runs global/absolute commands when cwd has no node_modules/.bin', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'typeclaw-exec-noLocalbin-'))
    const controller = new AbortController()
    const result = await runExecForCommand(['echo global-ok'] as unknown as TemplateStringsArray, [], {
      cwd,
      signal: controller.signal,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('global-ok\n')
  })
})

describe('CommandRunner — review follow-ups', () => {
  test('frames are ordered: stdout chunks precede the command_exit for the same callId', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'ordered output',
      run: async (ctx) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode('one'))
        await writer.write(new TextEncoder().encode('two'))
        writer.releaseLock()
        return 0
      },
    })
    const { runner, frames } = makeRunner([registerCommand('ordered', cmd)])
    runner.start({ callId: 'ord-1', name: 'ordered', args: undefined }, null)
    await waitForExit(frames, 'ord-1')

    const forCall = frames.filter((f) => f.callId === 'ord-1').map((f) => f.kind)
    expect(forCall).toEqual(['stdout', 'stdout', 'exit'])
  })

  test('a callId is reusable after its first command completes', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'short',
      run: async () => 0,
    })
    const { runner, frames } = makeRunner([registerCommand('short', cmd)])

    runner.start({ callId: 'reuse', name: 'short', args: undefined }, null)
    await waitForExit(frames, 'reuse')
    // waitForExit resolves on the outbound exit frame, but the runner's
    // inFlight.delete fires in the chained .finally — let that microtask
    // flush so the second start() sees a clean slate.
    await new Promise((r) => setTimeout(r, 10))

    const firstFrameCount = frames.length
    runner.start({ callId: 'reuse', name: 'short', args: undefined }, null)
    // Poll for a NEW exit frame, distinct from the first one. waitForExit
    // returns the first match it finds, which may still be the first run's
    // frame; assert that frames grew past the prior baseline.
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (
        frames.length > firstFrameCount &&
        frames.some((f, idx) => idx >= firstFrameCount && f.kind === 'exit' && f.callId === 'reuse')
      )
        break
      await new Promise((r) => setTimeout(r, 5))
    }

    const exits = frames.filter((f) => f.kind === 'exit' && f.callId === 'reuse')
    expect(exits.length).toBe(2)
    expect(frames.filter((f) => f.kind === 'error').length).toBe(0)
  })

  test('abort closes ctx.stdin so commands blocked on read complete', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'reads stdin to EOF',
      run: async (ctx) => {
        const reader = ctx.stdin.getReader()
        const next = await reader.read()
        reader.releaseLock()
        return next.done ? 0 : 99
      },
    })
    const { runner, frames } = makeRunner([registerCommand('stdin-reader', cmd)])
    runner.start({ callId: 'sr-1', name: 'stdin-reader', args: undefined }, null)
    await new Promise((r) => setTimeout(r, 20))
    runner.abort('sr-1', 'cleanup')
    const exit = await waitForExit(frames, 'sr-1')
    if (exit.kind === 'exit') expect(exit.code).toBe(0)
  })

  test('abortForOwner closes ctx.stdin for every command tied to the owner', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'reads stdin to EOF',
      run: async (ctx) => {
        const reader = ctx.stdin.getReader()
        const next = await reader.read()
        reader.releaseLock()
        return next.done ? 0 : 99
      },
    })
    const { runner, frames } = makeRunner([registerCommand('stdin-reader', cmd)])
    const owner = {}
    runner.start({ callId: 'o1', name: 'stdin-reader', args: undefined }, owner)
    runner.start({ callId: 'o2', name: 'stdin-reader', args: undefined }, owner)
    await new Promise((r) => setTimeout(r, 20))
    runner.abortForOwner(owner)
    const e1 = await waitForExit(frames, 'o1')
    const e2 = await waitForExit(frames, 'o2')
    if (e1.kind === 'exit') expect(e1.code).toBe(0)
    if (e2.kind === 'exit') expect(e2.code).toBe(0)
  })

  test('parentOrigin (when provided) becomes ctx.origin.spawnedByOrigin', async () => {
    const cmd = defineCommand({
      surface: 'container',
      description: 'inspect provenance',
      run: async (ctx) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(JSON.stringify(ctx.origin)))
        writer.releaseLock()
        return 0
      },
    })
    const { runner, frames, decodeStdout } = makeRunner([registerCommand('provenance', cmd)])

    const parentOrigin = {
      kind: 'cron' as const,
      jobId: 'nightly-checks',
      jobKind: 'exec' as const,
      scheduledByRole: 'member',
    }
    runner.start({ callId: 'p-1', name: 'provenance', args: undefined, parentOrigin }, null)
    await waitForExit(frames, 'p-1')

    const parsed = JSON.parse(decodeStdout()) as {
      kind: string
      spawnedByOrigin?: { kind?: string; jobId?: string; scheduledByRole?: string }
    }
    expect(parsed.kind).toBe('subagent')
    expect(parsed.spawnedByOrigin?.kind).toBe('cron')
    expect(parsed.spawnedByOrigin?.jobId).toBe('nightly-checks')
    expect(parsed.spawnedByOrigin?.scheduledByRole).toBe('member')
  })
})

describe('runPromptForCommand', () => {
  // Regression guard: ctx.prompt sessions used to fall through to
  // SessionManager.inMemory() (no sessionManager passed to
  // createSessionWithDispose), which silently dropped every plugin
  // cron-handler / plugin-command LLM call from `typeclaw usage` reports
  // even though Fireworks still billed them. The persisted SessionManager
  // is what makes the session JSONL exist on disk; the session-meta stamp
  // in src/agent/index.ts only fires when getSessionFile() is defined.
  test('hands createSessionWithDispose a persisted sessionManager rooted under sessions/', async () => {
    const { sessionFactory, agentDir } = makeSessionFactoryForTest()
    const runtime = makeRuntime([])
    let captured: { sessionManager: { getSessionFile: () => string | undefined } } | undefined
    const fakeCreate = async (options: unknown): Promise<{ session: object; dispose: () => Promise<void> }> => {
      captured = options as typeof captured
      const session = {
        prompt: async () => {},
        getLastAssistantText: () => 'ok',
        dispose: () => {},
        abort: async () => {},
      }
      return { session: session as object, dispose: async () => {} }
    }

    const result = await runPromptForCommand({
      text: 'hi',
      origin: { kind: 'cron', jobId: 'test', jobKind: 'handler', scheduledByOrigin: { kind: 'config-file' } },
      runtime,
      agentDir,
      permissions: noopPermissionService,
      signal: new AbortController().signal,
      runtimeVersion: '0.0.0-test',
      containerName: 'test-agent',
      sessionFactory,
      _createSession: fakeCreate as Parameters<typeof runPromptForCommand>[0]['_createSession'],
    })

    expect(result).toBe('ok')
    expect(captured).toBeDefined()
    const sessionFile = captured!.sessionManager.getSessionFile()
    expect(typeof sessionFile).toBe('string')
    expect(sessionFile).toContain(sessionFactory.sessionDir())
  })

  test('each call gets a fresh sessionManager (distinct files per invocation)', async () => {
    const { sessionFactory, agentDir } = makeSessionFactoryForTest()
    const runtime = makeRuntime([])
    const seen: string[] = []
    const fakeCreate = async (options: unknown): Promise<{ session: object; dispose: () => Promise<void> }> => {
      const file = (options as { sessionManager: { getSessionFile: () => string } }).sessionManager.getSessionFile()
      seen.push(file)
      const session = {
        prompt: async () => {},
        getLastAssistantText: () => '',
        dispose: () => {},
        abort: async () => {},
      }
      return { session: session as object, dispose: async () => {} }
    }

    const origin = {
      kind: 'cron' as const,
      jobId: 'test',
      jobKind: 'handler' as const,
      scheduledByOrigin: { kind: 'config-file' as const },
    }
    for (let i = 0; i < 3; i++) {
      await runPromptForCommand({
        text: `tick ${i}`,
        origin,
        runtime,
        agentDir,
        permissions: noopPermissionService,
        signal: new AbortController().signal,
        runtimeVersion: '0.0.0-test',
        containerName: 'test-agent',
        sessionFactory,
        _createSession: fakeCreate as Parameters<typeof runPromptForCommand>[0]['_createSession'],
      })
    }
    expect(new Set(seen).size).toBe(3)
  })

  // Regression guard: command/handler sessions must fire session.turn.start so
  // vector memory can append retrievalContext.results to the prompt text,
  // mirroring the TUI/channel/cron/subagent paths.
  test('fires session.turn.start and appends retrievalContext.results to the command prompt', async () => {
    const { sessionFactory, agentDir } = makeSessionFactoryForTest()
    const hooks = createHookBus()
    hooks.registerAll(
      'retriever',
      agentDir,
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.turn.start': (event) => {
          if (event.retrievalContext !== undefined) event.retrievalContext.results = '# Memory\n\ncommand fact'
        },
      },
    )
    const runtime = createPluginRuntime({
      registry: emptyRegistry(),
      hooks,
      subagents: {},
      pluginSubagentByShim: new WeakMap(),
      hasAnyPluginContent: false,
      loadedPlugins: [],
      materializedSkills: null,
    })
    let promptedText = ''
    const fakeCreate = async (): Promise<{ session: object; dispose: () => Promise<void> }> => ({
      session: {
        prompt: async (text: string) => {
          promptedText = text
        },
        getLastAssistantText: () => 'ok',
        dispose: () => {},
        abort: async () => {},
      } as object,
      dispose: async () => {},
    })

    await runPromptForCommand({
      text: 'run the report',
      origin: { kind: 'cron', jobId: 'test', jobKind: 'handler', scheduledByOrigin: { kind: 'config-file' } },
      runtime,
      agentDir,
      permissions: noopPermissionService,
      signal: new AbortController().signal,
      runtimeVersion: '0.0.0-test',
      containerName: 'test-agent',
      sessionFactory,
      _createSession: fakeCreate as Parameters<typeof runPromptForCommand>[0]['_createSession'],
    })

    expect(promptedText).toContain('run the report')
    expect(promptedText).toContain('# Memory\n\ncommand fact')
  })

  // Regression guard: cron-handler / plugin-command ctx.prompt sessions used to
  // be created without channelRouter, so buildChannelTools emitted no
  // channel_send. A handler told to post to a channel then had no tool and
  // burned a runaway bash loop trying to find one. The router must reach
  // createSessionWithDispose.
  test('forwards channelRouter to createSessionWithDispose so channel_send is wired', async () => {
    const { sessionFactory, agentDir } = makeSessionFactoryForTest()
    const runtime = makeRuntime([])
    const sentinelRouter = { __sentinel: 'router' } as unknown as Parameters<
      typeof runPromptForCommand
    >[0]['channelRouter']
    let captured: { channelRouter?: unknown } | undefined
    const fakeCreate = async (options: unknown): Promise<{ session: object; dispose: () => Promise<void> }> => {
      captured = options as typeof captured
      const session = {
        prompt: async () => {},
        getLastAssistantText: () => 'ok',
        dispose: () => {},
        abort: async () => {},
      }
      return { session: session as object, dispose: async () => {} }
    }

    await runPromptForCommand({
      text: 'post to channel',
      origin: { kind: 'cron', jobId: 'test', jobKind: 'handler', scheduledByOrigin: { kind: 'config-file' } },
      runtime,
      agentDir,
      permissions: noopPermissionService,
      signal: new AbortController().signal,
      runtimeVersion: '0.0.0-test',
      containerName: 'test-agent',
      sessionFactory,
      channelRouter: sentinelRouter,
      _createSession: fakeCreate as Parameters<typeof runPromptForCommand>[0]['_createSession'],
    })

    expect(captured).toBeDefined()
    expect(captured!.channelRouter).toBe(sentinelRouter)
  })
})
