import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Controller, RestartOptions } from '@/container'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { composeRestart, type ComposeRestartEvent } from './restart'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-compose-restart-'))
})

afterEach(async () => {
  await rmTempDir(root)
})

// Malformed JSON so validateConfig short-circuits before real Docker calls;
// see src/compose/start.test.ts for the full rationale.
async function makeInvalidAgent(parent: string, name: string): Promise<void> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'typeclaw.json'), 'this is not json\n')
}

async function makeValidAgent(parent: string, name: string): Promise<void> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'typeclaw.json'), '{}\n')
}

describe('composeRestart events', () => {
  test('emits agent-start then agent-done for every discovered agent', async () => {
    await makeInvalidAgent(root, 'alpha')
    await makeInvalidAgent(root, 'bravo')

    const events: ComposeRestartEvent[] = []
    const { results } = await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    expect(results).toHaveLength(2)
    expect(results.every((r) => !r.ok)).toBe(true)

    const starts = events.filter((e) => e.kind === 'agent-start').map((e) => e.name)
    const dones = events.filter((e) => e.kind === 'agent-done').map((e) => e.name)
    expect(new Set(starts)).toEqual(new Set(['alpha', 'bravo']))
    expect(new Set(dones)).toEqual(new Set(['alpha', 'bravo']))
  })

  test('does not emit agent-stopped when validateConfig rejects (guard ordering)', async () => {
    await makeInvalidAgent(root, 'alpha')

    const events: ComposeRestartEvent[] = []
    await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    expect(events.some((e) => e.kind === 'agent-stopped')).toBe(false)
  })

  test('per-agent event ordering: start < (optional stopped) < done', async () => {
    await makeInvalidAgent(root, 'alpha')
    await makeInvalidAgent(root, 'bravo')

    const events: ComposeRestartEvent[] = []
    await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    for (const name of ['alpha', 'bravo']) {
      const startIdx = events.findIndex((e) => e.kind === 'agent-start' && e.name === name)
      const doneIdx = events.findIndex((e) => e.kind === 'agent-done' && e.name === name)
      expect(startIdx).toBeGreaterThanOrEqual(0)
      expect(doneIdx).toBeGreaterThan(startIdx)

      const stoppedIdx = events.findIndex((e) => e.kind === 'agent-stopped' && e.name === name)
      if (stoppedIdx >= 0) {
        expect(stoppedIdx).toBeGreaterThan(startIdx)
        expect(stoppedIdx).toBeLessThan(doneIdx)
      }
    }
  })

  test('agent-done carries the same AgentResult as the returned results', async () => {
    await makeInvalidAgent(root, 'alpha')

    const events: ComposeRestartEvent[] = []
    const { results } = await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    const done = events.find((e) => e.kind === 'agent-done')
    expect(done).toBeDefined()
    if (done?.kind !== 'agent-done') throw new Error('unreachable')
    expect(done.result).toEqual(results[0]!)
  })

  test('emits no events when no agents are discovered', async () => {
    const events: ComposeRestartEvent[] = []
    const { agents, results } = await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    expect(agents).toEqual([])
    expect(results).toEqual([])
    expect(events).toEqual([])
  })

  test('runs without onProgress', async () => {
    await makeInvalidAgent(root, 'alpha')
    const { results } = await composeRestart({ rootCwd: root, preferredHostPort: 8973 })
    expect(results).toHaveLength(1)
  })

  test('keeps inherited build output away from the live compose board', async () => {
    await makeValidAgent(root, 'alpha')
    let restartOptions: RestartOptions | undefined
    const restart: Controller['restart'] = async (options) => {
      restartOptions = options
      options.onWarning?.('captured warning')
      return { ok: false, reason: 'simulated failure' }
    }

    const { results } = await composeRestart({ rootCwd: root, preferredHostPort: 8973 }, { restart })

    expect(restartOptions?.streamOutput).toBe(false)
    expect(results[0]).toEqual({
      name: 'alpha',
      ok: false,
      reason: 'simulated failure',
      warnings: ['captured warning'],
    })
  })

  test('collects stop-phase warnings in the per-agent result', async () => {
    await makeValidAgent(root, 'alpha')
    const restart: Controller['restart'] = async (options) => {
      options.onWarning?.('dead logs unavailable')
      options.onStopped?.({ ok: true, containerName: 'alpha', running: false })
      return { ok: false, reason: 'simulated start failure' }
    }

    const { results } = await composeRestart({ rootCwd: root, preferredHostPort: 8973 }, { restart })

    expect(results[0]?.warnings).toEqual(['dead logs unavailable'])
  })

  test('checks fleet memory once after every agent settled instead of per agent', async () => {
    // given two agents where bravo's restart is held open until released
    await makeValidAgent(root, 'alpha')
    await makeValidAgent(root, 'bravo')
    const skipFlags: Array<boolean | undefined> = []
    const { promise: bravoReleased, resolve: releaseBravo } = Promise.withResolvers<void>()
    const { promise: alphaDone, resolve: markAlphaDone } = Promise.withResolvers<void>()
    const restart: Controller['restart'] = async (options) => {
      skipFlags.push(options.skipMemoryOversubscriptionCheck)
      if (options.cwd.endsWith('bravo')) await bravoReleased
      return { ok: true, stop: { ok: true, containerName: 'x', running: true }, start: successfulStart() }
    }
    const settled = new Set<string>()
    const settledAtCheck: string[][] = []
    const checkMemory = async (): Promise<string[]> => {
      settledAtCheck.push([...settled].toSorted())
      return ['Agent memory limits total 12.0GiB against 8.0GiB of Docker memory.']
    }

    // when alpha has finished but bravo is still restarting
    const pending = composeRestart(
      {
        rootCwd: root,
        preferredHostPort: 8973,
        onProgress: (event) => {
          if (event.kind !== 'agent-done') return
          settled.add(event.name)
          if (event.name === 'alpha') markAlphaDone()
        },
      },
      { restart, checkMemory },
    )
    await alphaDone

    // then the fleet check has not run yet
    expect(settledAtCheck).toEqual([])

    // when bravo settles
    releaseBravo()
    const result = await pending

    // then the fleet check runs exactly once, only after both agents settled
    expect(skipFlags).toEqual([true, true])
    expect(settledAtCheck).toEqual([['alpha', 'bravo']])
    expect(result.memoryWarning).toEqual(['Agent memory limits total 12.0GiB against 8.0GiB of Docker memory.'])
    expect(result.results.every((r) => r.ok && r.warnings?.length === 0)).toBe(true)
  })

  test('skips the fleet memory check when no agent came up', async () => {
    await makeValidAgent(root, 'alpha')
    const restart: Controller['restart'] = async () => ({ ok: false, reason: 'simulated failure' })
    let checks = 0
    const checkMemory = async (): Promise<null> => {
      checks += 1
      return null
    }

    const result = await composeRestart({ rootCwd: root, preferredHostPort: 8973 }, { restart, checkMemory })

    expect(checks).toBe(0)
    expect(result.memoryWarning).toBeNull()
  })
})

function successfulStart() {
  return {
    ok: true as const,
    plan: {
      containerName: 'x',
      imageTag: 'x:latest',
      buildContext: '/tmp/test-agent',
      dockerfile: '/tmp/test-agent/Dockerfile',
      runArgs: [],
      needsBuild: false,
      hostPort: 8973,
      tuiToken: null,
      memoryLimitBytes: 6 * 1024 * 1024 * 1024,
    },
    containerId: 'a'.repeat(64),
    built: false,
    hostPort: 8973,
    tuiToken: null,
    hostd: { state: 'disabled' as const },
    alreadyRunning: false,
    autoUpgrade: { kind: 'up-to-date' as const, installedVersion: '0.0.0' },
    skippedPlugins: [],
    dockerfileWarnings: [],
  }
}
