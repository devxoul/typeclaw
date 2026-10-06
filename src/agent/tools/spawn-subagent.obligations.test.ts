import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundObligationStore } from '@/channels/background-obligations'

import type { AgentSession } from '../index'
import { LiveSubagentRegistry } from '../live-subagents'
import type { CreateSessionForSubagent } from '../subagents'
import { createSpawnSubagentTool, type CreateSpawnSubagentToolOptions } from './spawn-subagent'

function fixture(
  router: CreateSpawnSubagentToolOptions['router'],
  create?: CreateSessionForSubagent,
  options: Partial<CreateSpawnSubagentToolOptions> = {},
) {
  let launches = 0
  const done = Promise.withResolvers<void>()
  const registry = new LiveSubagentRegistry()
  const tool = createSpawnSubagentTool({
    registry: { explorer: { visibility: 'public', systemPrompt: 'Explore.' } },
    liveRegistry: registry,
    createSessionForSubagent:
      create ??
      (async () => {
        launches++
        return {
          sessionId: 'child',
          prompt: () => done.promise,
          subscribe: () => () => {},
          abort: async () => {},
          dispose: () => {},
        } as unknown as AgentSession
      }),
    agentDir: '/tmp',
    parentSessionId: 'parent',
    getOrigin: () => ({ kind: 'channel', adapter: 'slack', workspace: 'team', chat: 'room', thread: 'thread' }),
    generateTaskId: () => 'task',
    router,
    ...options,
  })
  return {
    spawn: (signal?: AbortSignal) =>
      tool.execute('call', { subagent_type: 'explorer', prompt: 'inspect' }, signal, undefined, {} as never),
    launches: () => launches,
    done,
    registry,
  }
}

test('channel child cannot start before durable response admission, without a transcript prerequisite', async () => {
  const accepted = Promise.withResolvers<{ obligationId: string; generation: number }>()
  const f = fixture({
    acceptBackgroundResponse: () => accepted.promise,
    suppressUnstartedBackgroundResponse: async () => {},
  })
  const result = f.spawn()
  await Promise.resolve()
  expect(f.launches()).toBe(0)
  accepted.resolve({ obligationId: 'obligation', generation: 1 })
  expect((await result).details).toMatchObject({ ok: true, mode: 'background' })
  expect(f.launches()).toBe(1)
  f.done.resolve()
})

test('admission failure prevents execution and releases the duplicate reservation', async () => {
  let fail = true
  const f = fixture({
    acceptBackgroundResponse: async () => {
      if (fail) throw new Error('disk unavailable')
      return { obligationId: 'obligation', generation: 1 }
    },
    suppressUnstartedBackgroundResponse: async () => {},
  })
  expect((await f.spawn()).details).toMatchObject({ ok: false })
  expect(f.launches()).toBe(0)
  fail = false
  expect((await f.spawn()).details).toMatchObject({ ok: true })
  expect(f.launches()).toBe(1)
  f.done.resolve()
})

test('abort during admission suppresses only the proven unstarted launch before returning', async () => {
  const accepted = Promise.withResolvers<{ obligationId: string; generation: number }>()
  const suppressed = Promise.withResolvers<void>()
  const suppressing = Promise.withResolvers<void>()
  const controller = new AbortController()
  const f = fixture({
    acceptBackgroundResponse: () => accepted.promise,
    suppressUnstartedBackgroundResponse: async () => {
      suppressing.resolve()
      await suppressed.promise
    },
  })
  let returned = false
  const result = f.spawn(controller.signal).then((value) => {
    returned = true
    return value
  })
  controller.abort()
  accepted.resolve({ obligationId: 'obligation', generation: 1 })
  await suppressing.promise
  expect(f.launches()).toBe(0)
  expect(returned).toBe(false)
  suppressed.resolve()
  expect((await result).details).toMatchObject({ ok: false })
})

test('failure after invocation never suppresses an uncertain started response', async () => {
  let suppressed = false
  const f = fixture(
    {
      acceptBackgroundResponse: async () => ({ obligationId: 'obligation', generation: 1 }),
      suppressUnstartedBackgroundResponse: async () => {
        suppressed = true
      },
    },
    async () => {
      throw new Error('session initialization failed')
    },
  )
  expect((await f.spawn()).details).toMatchObject({ ok: false })
  expect(suppressed).toBe(false)
})

test('account lookup cannot drift the admitted permission principal or launch before durable admission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spawn-principal-'))
  try {
    const store = new BackgroundObligationStore(dir, { epoch: 'test' })
    const lookup = Promise.withResolvers<string>()
    const lookingUp = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<void>()
    const releaseAdmission = Promise.withResolvers<void>()
    const origin = {
      kind: 'channel' as const,
      adapter: 'discord-bot' as const,
      workspace: 'team',
      chat: 'thread-room',
      thread: null,
      parentChat: 'original-room',
      lastInboundAuthorId: 'original-author',
    }
    const f = fixture(
      {
        acceptBackgroundResponse: async (input) => {
          const row = await store.accept(input)
          admitted.resolve()
          await releaseAdmission.promise
          return { obligationId: row.obligationId, generation: row.generation }
        },
        suppressUnstartedBackgroundResponse: async () => {},
      },
      undefined,
      {
        getOrigin: () => origin,
        getAccountIdentity: () => {
          lookingUp.resolve()
          return lookup.promise
        },
      },
    )
    const spawned = f.spawn()
    await lookingUp.promise
    origin.parentChat = 'later-room'
    origin.lastInboundAuthorId = 'later-author'
    lookup.resolve('actor')
    await admitted.promise
    expect(f.launches()).toBe(0)
    expect((await store.list())[0]!.principal).toEqual({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: 'team',
      chat: 'thread-room',
      parentChat: 'original-room',
      lastInboundAuthorId: 'original-author',
    })
    releaseAdmission.resolve()
    expect((await spawned).details).toMatchObject({ ok: true, mode: 'background' })
    expect(f.launches()).toBe(1)
    f.done.resolve()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
