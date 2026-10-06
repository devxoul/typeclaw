import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundHandoffInventory } from '@/channels/background-handoff'
import { createStream } from '@/stream'

import type { AgentSession } from '../index'
import { LiveSubagentRegistry } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import type { CreateSessionForSubagent } from '../subagents'
import { createSpawnSubagentTool } from './spawn-subagent'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const origin: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack',
  workspace: 'team',
  chat: 'room',
  thread: 'thread',
  lastInboundAuthorId: 'author',
}
const key = { adapter: 'slack' as const, workspace: 'team', chat: 'room', thread: 'thread' }
async function fixture(
  options: { create?: CreateSessionForSubagent; registry?: LiveSubagentRegistry; timeoutMs?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-source-inventory-'))
  dirs.push(dir)
  const inventory = new BackgroundHandoffInventory(dir)
  const registry = options.registry ?? new LiveSubagentRegistry(inventory)
  const done = Promise.withResolvers<void>()
  const terminal = Promise.withResolvers<void>()
  const recordCompletion = registry.recordCompletionIfRunning.bind(registry)
  registry.recordCompletionIfRunning = (taskId, completion) => {
    const won = recordCompletion(taskId, completion)
    terminal.resolve()
    return won
  }
  let launches = 0
  let aborts = 0
  const stream = createStream()
  const tool = createSpawnSubagentTool({
    registry: {
      explorer: {
        visibility: 'public',
        systemPrompt: 'Explore.',
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
      reviewer: { visibility: 'public', systemPrompt: 'Review.' },
    },
    liveRegistry: registry,
    createSessionForSubagent:
      options.create ??
      (async () => {
        launches++
        return {
          sessionId: 'child',
          prompt: () => done.promise,
          subscribe: () => () => {},
          abort: async () => {
            aborts++
          },
          dispose: () => {},
        } as unknown as AgentSession
      }),
    agentDir: dir,
    parentSessionId: 'parent',
    getOrigin: () => origin,
    getSessionFile: () => join(dir, 'sessions', 'parent.jsonl'),
    generateTaskId: () => 'task',
    stream,
  })
  const spawn = (params = { subagent_type: 'explorer', prompt: 'inspect' }, signal?: AbortSignal) =>
    tool.execute('call', params, signal, undefined, {} as never)
  const recover = () => new BackgroundHandoffInventory(dir).claim()
  return {
    inventory,
    registry,
    done,
    terminal,
    stream,
    spawn,
    recover,
    launches: () => launches,
    aborts: () => aborts,
    dir,
  }
}
async function checkpoint(f: {
  done: { resolve: () => void }
  terminal: { promise: Promise<void> }
  inventory: BackgroundHandoffInventory
}) {
  f.done.resolve()
  await f.terminal.promise
  await f.inventory.flush()
}

test('direct channel launch is durable before session execution, with author but no result bodies', async () => {
  const f = await fixture()
  expect((await f.spawn()).details).toMatchObject({ ok: true, mode: 'background' })
  expect(f.launches()).toBe(1)
  const claims = await f.recover()
  expect(claims[0]?.record).toMatchObject({
    parentSessionId: 'parent',
    triggeringAuthorId: 'author',
    tasks: [{ taskId: 'task', subagentName: 'explorer' }],
  })
  await checkpoint(f)
})

test('factory rejection retires never-registered intent', async () => {
  const f = await fixture({
    create: async () => {
      throw new Error('factory refused')
    },
  })
  expect((await f.spawn()).details).toMatchObject({ ok: false })
  await f.inventory.flush()
  expect(await f.recover()).toEqual([])
})

test('missing transcript prevents execution with visible error', async () => {
  const f = await fixture()
  let launches = 0
  const tool = createSpawnSubagentTool({
    registry: { explorer: { visibility: 'public', systemPrompt: 'Explore.' } },
    liveRegistry: f.registry,
    createSessionForSubagent: async () => {
      launches++
      throw new Error('must not execute')
    },
    agentDir: f.dir,
    parentSessionId: 'parent',
    getOrigin: () => origin,
  })
  const result = await tool.execute(
    'call',
    { subagent_type: 'explorer', prompt: 'inspect' },
    undefined,
    undefined,
    {} as never,
  )
  expect(result.details).toMatchObject({ ok: false })
  expect(launches).toBe(0)
  expect(await f.recover()).toEqual([])
})

test('parent aborted across persistence await never starts execution', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const persisted = Promise.withResolvers<void>()
  const releaseWrite = Promise.withResolvers<void>()
  const add = f.inventory.add.bind(f.inventory)
  f.inventory.add = async (input) => {
    const identity = await add(input)
    persisted.resolve()
    await releaseWrite.promise
    return identity
  }
  const spawning = f.spawn(undefined, controller.signal)
  await persisted.promise
  expect(f.launches()).toBe(0)
  controller.abort()
  releaseWrite.resolve()
  expect((await spawning).details).toMatchObject({ ok: false })
  await f.inventory.flush()
  expect(f.launches()).toBe(0)
  expect(await f.recover()).toEqual([])
})

test('actual completion removes inventory even with absent parent and no completion consumer', async () => {
  const f = await fixture()
  await f.spawn()
  await checkpoint(f)
  expect(f.registry.get('task')?.status).toBe('completed')
  expect(await f.recover()).toEqual([])
  expect(f.registry.recordCompletionIfRunning('task', { ok: false, durationMs: 1 })).toBe(false)
})

test('source timeout terminalizes and retires despite unfinished physical execution', async () => {
  const f = await fixture({ timeoutMs: 10 })
  await f.spawn()
  // Exercise the source's real timeout integration, awaiting its terminal signal.
  await f.terminal.promise
  await f.inventory.flush()
  expect(f.registry.get('task')?.status).toBe('failed')
  expect(await f.recover()).toEqual([])
  await checkpoint(f)
})

test('ordinary physical abort retains inventory until completion checkpoint', async () => {
  const f = await fixture()
  await f.spawn()
  await f.registry.get('task')!.abort()
  expect(f.registry.get('task')?.status).toBe('running')
  expect((await f.recover())[0]?.record.tasks[0]?.taskId).toBe('task')
  await checkpoint(f)
})

test('work-key logical termination retires without awaiting physical abort and preserves sibling', async () => {
  const f = await fixture()
  const abort = Promise.withResolvers<void>()
  const first = await f.inventory.add({
    key,
    parentSessionId: 'parent',
    parentSessionFile: join(f.dir, 'sessions', 'parent.jsonl'),
    taskId: 'first',
    subagentName: 'explorer',
    startedAt: 1,
  })
  const sibling = await f.inventory.add({
    key,
    parentSessionId: 'parent',
    parentSessionFile: join(f.dir, 'sessions', 'parent.jsonl'),
    taskId: 'sibling',
    subagentName: 'explorer',
    startedAt: 2,
  })
  for (const [taskId, identity, workKey] of [
    ['first', first, 'work'],
    ['sibling', sibling, 'other'],
  ] as const) {
    f.registry.register({
      taskId,
      sessionId: taskId,
      parentSessionId: 'parent',
      subagentName: 'explorer',
      startedAt: 1,
      status: 'running',
      background: true,
      backgroundLaunch: identity,
      workKey,
      abort: () => abort.promise,
    })
  }
  const cancel = f.registry.cancelRunningByWorkKey('work', 'draft')
  await f.inventory.flush()
  expect(f.registry.get('first')?.status).toBe('failed')
  expect(f.registry.recordCompletionIfRunning('first', { ok: true, durationMs: 1 })).toBe(false)
  expect((await f.recover())[0]?.record.tasks.map((t) => t.taskId)).toEqual(['sibling'])
  abort.resolve()
  expect(await cancel).toEqual({ matched: 1, cancelled: 1, failures: 0 })
})

test('successfully aborted declined registration retires pending launch', async () => {
  const f = await fixture()
  const original = f.registry.registerIfWorkKeyActive.bind(f.registry)
  f.registry.registerIfWorkKeyActive = (live, registration) => {
    registration.cancelled = true
    return original(live, registration)
  }
  const result = await f.spawn({
    subagent_type: 'reviewer',
    prompt: 'review',
    review_identity: {
      repo: 'owner/repo',
      pull_request: 1,
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      review_kind: 'review',
    },
  } as never)
  expect(result.details).toMatchObject({ ok: false })
  await f.inventory.flush()
  expect(f.aborts()).toBe(1)
  expect(await f.recover()).toEqual([])
  f.done.resolve()
})

test('registration exception explicitly retires successfully aborted attempt', async () => {
  const f = await fixture()
  f.registry.register = () => {
    throw new Error('registration refused')
  }
  expect((await f.spawn()).details).toMatchObject({ ok: false })
  await f.inventory.flush()
  expect(f.aborts()).toBe(1)
  expect(await f.recover()).toEqual([])
  f.done.resolve()
})

test('terminal storage failure does not suppress real completion broadcast', async () => {
  const f = await fixture()
  await f.spawn()
  f.inventory.remove = async () => {
    throw new Error('disk refused terminal deletion')
  }
  await checkpoint(f)
  expect(f.registry.get('task')?.status).toBe('completed')
  expect(f.stream.scan({ target: { kind: 'broadcast' } }).map((message) => message.payload)).toContainEqual(
    expect.objectContaining({ kind: 'subagent.completed', taskId: 'task', ok: true }),
  )
  expect((await f.recover())[0]?.record.tasks[0]?.taskId).toBe('task')
})

test('registry disposal retains running inventory rather than implying termination', async () => {
  const f = await fixture()
  await f.spawn()
  f.registry.unregister('task')
  f.registry.clear()
  expect((await f.recover())[0]?.record.tasks[0]?.taskId).toBe('task')
  f.done.resolve()
})

test('SIGKILL after actual source launch preserves one parent-group claim for another process', async () => {
  const f = await fixture()
  const script = join(f.dir, 'crash-source.ts')
  await Bun.write(
    script,
    `
    import { BackgroundHandoffInventory } from ${JSON.stringify(import.meta.resolve('@/channels/background-handoff'))};
    import { LiveSubagentRegistry } from ${JSON.stringify(import.meta.resolve('../live-subagents'))};
    import { createSpawnSubagentTool } from ${JSON.stringify(import.meta.resolve('./spawn-subagent'))};
    const inventory = new BackgroundHandoffInventory(${JSON.stringify(f.dir)});
    const tool = createSpawnSubagentTool({
      registry: { explorer: { visibility: 'public', systemPrompt: 'Explore.' } },
      liveRegistry: new LiveSubagentRegistry(inventory),
      createSessionForSubagent: async () => ({
        sessionId: 'child', prompt: () => new Promise(() => {}),
        subscribe: () => () => {}, abort: async () => {}, dispose: () => {}
      }),
      agentDir: ${JSON.stringify(f.dir)}, parentSessionId: 'parent',
      getSessionFile: () => 'parent.jsonl', getOrigin: () => (${JSON.stringify(origin)}),
      generateTaskId: () => 'process-child'
    });
    const result = await tool.execute('call', {subagent_type: 'explorer', prompt: 'inspect'}, undefined, undefined, {});
    console.log(JSON.stringify(result.details));
    await Bun.stdin.text();
  `,
  )
  const child = Bun.spawn([process.execPath, script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const reader = child.stdout.getReader()
  try {
    const ready = await reader.read()
    expect(JSON.parse(new TextDecoder().decode(ready.value))).toMatchObject({ ok: true, mode: 'background' })
    child.kill('SIGKILL')
    await child.exited
    const recoveryScript = join(f.dir, 'recover.ts')
    await Bun.write(
      recoveryScript,
      `
      import { BackgroundHandoffInventory } from ${JSON.stringify(import.meta.resolve('@/channels/background-handoff'))};
      const inventory = new BackgroundHandoffInventory(${JSON.stringify(f.dir)});
      const claims = await inventory.claim();
      console.log(JSON.stringify(claims.map(c => c.record.tasks.map(t => t.taskId))));
      for (const claim of claims) await inventory.retire(claim);
    `,
    )
    const recovery = Bun.spawn([process.execPath, recoveryScript], { stdout: 'pipe', stderr: 'pipe' })
    expect(JSON.parse(await new Response(recovery.stdout).text())).toEqual([['process-child']])
    expect(await recovery.exited).toBe(0)
    const repeat = Bun.spawn([process.execPath, recoveryScript], { stdout: 'pipe', stderr: 'pipe' })
    expect(JSON.parse(await new Response(repeat.stdout).text())).toEqual([])
    expect(await repeat.exited).toBe(0)
  } finally {
    reader.releaseLock()
    child.kill()
    await child.exited
  }
})

test('persistence failure releases admission and never invokes the child factory', async () => {
  const f = await fixture()
  const add = f.inventory.add.bind(f.inventory)
  f.inventory.add = async () => {
    throw new Error('publication refused')
  }
  expect((await f.spawn()).details).toMatchObject({ ok: false })
  expect(f.launches()).toBe(0)
  f.inventory.add = add
  expect((await f.spawn()).details).toMatchObject({ ok: true, mode: 'background' })
  expect(f.launches()).toBe(1)
  await checkpoint(f)
  expect(await f.recover()).toEqual([])
})

test('declined registration with failed abort retains the still-live child until actual failure', async () => {
  const finished = Promise.withResolvers<void>()
  const f = await fixture({
    create: async () =>
      ({
        sessionId: 'child',
        prompt: () => finished.promise,
        subscribe: () => () => {},
        abort: async () => {
          throw new Error('abort refused')
        },
        dispose: () => {},
      }) as unknown as AgentSession,
  })
  const register = f.registry.registerIfWorkKeyActive.bind(f.registry)
  f.registry.registerIfWorkKeyActive = (live, registration) => {
    registration.cancelled = true
    return register(live, registration)
  }
  const result = await f.spawn({
    subagent_type: 'reviewer',
    prompt: 'review',
    review_identity: {
      repo: 'owner/repo',
      pull_request: 1,
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      review_kind: 'review',
    },
  } as never)
  expect(result.details).toMatchObject({ ok: false })
  expect(f.registry.get('task')?.status).toBe('running')
  finished.reject(new Error('execution failed'))
  await f.terminal.promise
  await f.inventory.flush()
  expect(f.registry.get('task')?.completion?.error).toBe('execution failed')
  expect(await f.recover()).toEqual([])
})

test('foreground, TUI, cron and nested launches never enter the channel inventory', async () => {
  const f = await fixture()
  for (const [index, launchOrigin, foreground] of [
    [0, origin, true],
    [1, { kind: 'tui', sessionId: 'parent' }, false],
    [2, { kind: 'cron', jobId: 'job', jobKind: 'prompt' }, false],
    [3, { kind: 'subagent', subagent: 'outer', parentSessionId: 'channel-parent', spawnedByOrigin: origin }, false],
  ] as const) {
    const tool = createSpawnSubagentTool({
      registry: { explorer: { visibility: 'public', systemPrompt: 'Explore.' } },
      liveRegistry: f.registry,
      createSessionForSubagent: async () =>
        ({
          sessionId: `child-${index}`,
          prompt: async () => {},
          subscribe: () => () => {},
          abort: async () => {},
          dispose: () => {},
        }) as unknown as AgentSession,
      agentDir: f.dir,
      parentSessionId: 'parent',
      getOrigin: () => launchOrigin,
      getSessionFile: () => 'parent.jsonl',
      generateTaskId: () => `excluded-${index}`,
      allowBackgroundFromSubagent: true,
    })
    expect(
      (
        await tool.execute(
          'call',
          { subagent_type: 'explorer', prompt: 'inspect', run_in_foreground: foreground },
          undefined,
          undefined,
          {} as never,
        )
      ).details,
    ).toMatchObject({ ok: true })
  }
  await f.inventory.flush()
  expect(await f.recover()).toEqual([])
})

test('failed registration and failed physical cleanup keep evidence until real completion', async () => {
  const finished = Promise.withResolvers<void>()
  const f = await fixture({
    create: async () =>
      ({
        sessionId: 'child',
        prompt: () => finished.promise,
        subscribe: () => () => {},
        abort: async () => {
          throw new Error('abort refused')
        },
        dispose: () => {},
      }) as unknown as AgentSession,
  })
  f.registry.register = () => {
    throw new Error('registration refused')
  }
  const removed = Promise.withResolvers<void>()
  const remove = f.inventory.remove.bind(f.inventory)
  let retirements = 0
  f.inventory.remove = async (identity) => {
    retirements++
    await remove(identity)
    removed.resolve()
  }
  expect((await f.spawn()).details).toMatchObject({ ok: false })
  expect(retirements).toBe(0)
  expect(f.registry.get('task')).toBeUndefined()
  finished.resolve()
  await removed.promise
  expect(retirements).toBe(1)
  expect(await f.recover()).toEqual([])
})

test('terminal delete failure cannot mask physical work-key cancellation failure', async () => {
  const f = await fixture()
  await f.spawn()
  const live = f.registry.get('task')!
  live.workKey = 'work'
  live.abort = async () => {
    throw new Error('physical abort refused')
  }
  f.inventory.remove = async () => {
    throw new Error('terminal delete refused')
  }
  expect(await f.registry.cancelRunningByWorkKey('work', 'draft')).toEqual({ matched: 1, cancelled: 0, failures: 1 })
  expect(live.status).toBe('failed')
  expect(live.completion?.error).toBe('cancelled: draft')
  expect((await f.recover())[0]?.record.tasks[0]?.taskId).toBe('task')
  f.done.resolve()
})
