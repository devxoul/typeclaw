import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { archiveContainerLogs, type DockerLogArchiveRuntime } from './log-archive'
import type { DockerExec, DockerExecResult } from './shared'
import { planStop, stop } from './stop'

const CONTAINER_ID = 'a'.repeat(64)
const archiveLogs = async () => ({ ok: true as const, status: 'archived' as const, path: '/archive.log' })

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-stop-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('planStop', () => {
  test('derives container name from the folder basename', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(planStop(folder)).toEqual({ containerName: 'coder' })
  })
})

type ContainerScenario = { exists: false } | { exists: true; running: boolean }

type FakeOptions = {
  scenario: ContainerScenario
  stopFails?: boolean
  rmStderr?: string
  rmExitCode?: number
  rmFindsRunning?: boolean
  inspectExitCode?: number
  inspectStderr?: string
  inspectStdout?: string
  // Models Docker's async removal-drain after `docker rm`. The container
  // does NOT immediately disappear from `docker inspect`. It only transitions
  // to "no such container" after the inspect probe has been called this
  // many times (simulating the drain completing). Default 0 — no drain
  // delay — i.e. inspect reports "gone" the very next call. Set to a
  // positive integer to exercise waitForRemoval's polling loop; set high
  // enough to exhaust the configured timeout to exercise the timeout branch.
  // Applies BOTH to the "in-progress" non-zero rm and to the exit-0 rm
  // (OrbStack/Docker Desktop under load acknowledge the rm before draining).
  drainAfterInspectCalls?: number
  lifeStatus?: 'running' | 'exited' | 'dead' | 'removing'
  statusProbeExitCode?: number
  statusProbeStderr?: string
}

function fakeDockerExec(options: FakeOptions): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = []
  let scenario = options.scenario
  let inspectsAfterRm = 0
  let rmReturned = false
  const exec: DockerExec = async (args): Promise<DockerExecResult> => {
    calls.push(args)
    if (args[0] === 'inspect') {
      if (args.includes('{{.State.Status}}')) {
        return {
          exitCode: options.statusProbeExitCode ?? 0,
          stdout: `${options.lifeStatus ?? 'exited'}\n`,
          stderr: options.statusProbeStderr ?? '',
        }
      }
      if (rmReturned) {
        inspectsAfterRm += 1
        if (inspectsAfterRm > (options.drainAfterInspectCalls ?? 0)) {
          scenario = { exists: false }
        }
      }
      if (options.inspectExitCode !== undefined && options.inspectExitCode !== 0 && !rmReturned) {
        return { exitCode: options.inspectExitCode, stdout: '', stderr: options.inspectStderr ?? '' }
      }
      if (!scenario.exists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      return { exitCode: 0, stdout: options.inspectStdout ?? `${CONTAINER_ID}|${scenario.running}\n`, stderr: '' }
    }
    if (args[0] === 'stop') {
      if (options.stopFails) return { exitCode: 1, stdout: '', stderr: 'docker stop failed' }
      if (scenario.exists) scenario = { exists: true, running: false }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'rm') {
      if (options.rmFindsRunning && !args.includes('-f')) {
        scenario = { exists: true, running: true }
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            'Error response from daemon: You cannot remove a running container. Stop the container before attempting removal',
        }
      }
      const exitCode = options.rmExitCode ?? 0
      const stderr = options.rmStderr ?? ''
      rmReturned = true
      // Exit 0 from `docker rm` does NOT mean the container is gone on
      // OrbStack under load — the daemon acknowledges the rm before
      // draining. Defer the scenario transition to the inspect drain logic
      // above so tests with drainAfterInspectCalls > 0 model the real race
      // window. drainAfterInspectCalls === 0 (the default) still flips
      // scenario on the very next inspect probe, so existing exit-0 tests
      // continue to see "gone" immediately.
      return { exitCode, stdout: '', stderr }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

describe('stop (composition)', () => {
  test('returns ok with running=false when the container does not exist', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: false } })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(false)
    expect(calls.find((c) => c[0] === 'stop')).toBeUndefined()
    expect(calls.find((c) => c[0] === 'rm')).toBeUndefined()
  })

  test('calls docker stop THEN docker rm when the container is running', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: true } })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(true)
    const stopIdx = calls.findIndex((c) => c[0] === 'stop')
    const rmIdx = calls.findIndex((c) => c[0] === 'rm')
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(rmIdx).toBeGreaterThan(stopIdx)
  })

  test('skips docker stop but still issues ID-keyed non-force rm when the container exists in stopped state', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false } })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(false)
    expect(calls.find((c) => c[0] === 'stop')).toBeUndefined()
    expect(calls.find((c) => c[0] === 'rm')).toEqual(['rm', CONTAINER_ID])
  })

  test('removes a stopped container after publishing its rotated log archive above 64 MiB', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false } })
    const runtime: DockerLogArchiveRuntime = {
      inspectLogConfig: async () => ({
        exitCode: 0,
        stdout: '{"Type":"json-file","Config":{"max-size":"20m","max-file":"5"}}',
        stderr: '',
      }),
      resolveDockerBinary: () => '/usr/bin/docker',
      capture: async ({ maxBytes, output }) => {
        if (maxBytes !== 100_000_000) throw new Error('unexpected capture limit')
        await output.truncate(68 * 1024 * 1024)
        return { exitCode: 0, overflowed: false, stderrExcerpt: '', timedOut: false }
      },
    }
    let snapshot: string | undefined
    const result = await stop({
      cwd: root,
      exec,
      archiveLogs: async (input) => {
        const archive = await archiveContainerLogs(input, runtime)
        if (archive.ok) snapshot = archive.path
        return archive
      },
    })

    expect(result.ok).toBe(true)
    expect(snapshot).toBeDefined()
    expect((await stat(snapshot!)).size).toBe(68 * 1024 * 1024)
    expect(calls.find((call) => call[0] === 'rm')).toEqual(['rm', CONTAINER_ID])
  })

  test('preserves a stopped container when unbounded logs exceed the archive limit', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false } })
    const result = await stop({
      cwd: root,
      exec,
      archiveLogs: async (input) =>
        await archiveContainerLogs(input, {
          inspectLogConfig: async () => ({ exitCode: 0, stdout: '{"Type":"json-file","Config":{}}', stderr: '' }),
          resolveDockerBinary: () => '/usr/bin/docker',
          capture: async () => ({ exitCode: -1, overflowed: true, stderrExcerpt: '', timedOut: false }),
        }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(`docker logs --timestamps ${CONTAINER_ID}`)
    expect(calls.find((call) => call[0] === 'rm')).toBeUndefined()
  })

  test('restart stop phase reports stale OOM after archival and before removal', async () => {
    const fake = fakeDockerExec({ scenario: { exists: true, running: false } })
    const events: string[] = []
    const exec: DockerExec = async (args, options) => {
      if (args[0] === 'inspect' && args.some((arg) => arg.includes('{{.State.OOMKilled}}'))) {
        return { exitCode: 0, stdout: `${CONTAINER_ID}|false|true|137|6442450944|2026-09-29T04:58:43Z\n`, stderr: '' }
      }
      if (args[0] === 'rm') events.push('remove')
      return fake.exec(args, options)
    }
    const result = await stop({
      cwd: root,
      exec,
      archiveLogs: async () => {
        events.push('archive')
        return { ok: true, status: 'archived', path: '/archive.log' }
      },
      onWarning: (message) => events.push(message),
    })
    expect(result.ok).toBe(true)
    expect(events).toEqual([
      'archive',
      'agent runtime was SIGKILLed (137) and the container recorded an OOM kill during this run (likely container memory limit 6144 MiB). Restart the agent and reduce memory-heavy parallel work.',
      'remove',
    ])
  })

  test('tolerates "no such container" from docker rm (user removed it out-of-band)', async () => {
    const { exec } = fakeDockerExec({
      scenario: { exists: true, running: true },
      rmExitCode: 1,
      rmStderr: 'Error: No such container: vanished',
    })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(true)
  })

  test('waits for the drain when docker rm returns "removal already in progress" and succeeds', async () => {
    // given: docker stop succeeded, but rm finds the container is being
    // removed by something else (peer typeclaw stop / OrbStack async cleanup
    // / hostd GC). Docker will finish the drain a few hundred ms later.
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: true },
      rmExitCode: 1,
      rmStderr: 'Error response from daemon: removal of container vanished is already in progress',
      drainAfterInspectCalls: 2,
    })

    // when
    const result = await stop({ cwd: root, exec, archiveLogs })

    // then: stop reports success, AND we polled inspect at least until the
    // container actually disappeared — caller can safely docker run --name
    expect(result.ok).toBe(true)
    const inspectAfterRm = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c[0] === 'inspect')
      .filter(({ i }) => i > calls.findIndex((cc) => cc[0] === 'rm'))
    expect(inspectAfterRm.length).toBeGreaterThanOrEqual(2)
  })

  test('waits for the drain when docker rm returns exit 0 but the container is still in inspect (OrbStack under load)', async () => {
    // given: a stopped container. `docker rm` returns exit 0 but Docker
    // has not yet finished draining — `inspect` still sees the container
    // for two more probes. This is the canonical OrbStack-under-load
    // failure mode behind `typeclaw compose restart`'s "Conflict. The
    // container name is already in use" — stop() returning before the
    // drain completes lets the subsequent start() race the daemon.
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: true },
      rmExitCode: 0,
      drainAfterInspectCalls: 2,
    })

    // when
    const result = await stop({ cwd: root, exec, archiveLogs })

    // then: stop reports success only AFTER inspect confirmed the name is
    // free — at least one inspect probe must run between rm and return.
    expect(result.ok).toBe(true)
    const rmIdx = calls.findIndex((c) => c[0] === 'rm')
    const inspectAfterRm = calls.slice(rmIdx + 1).filter((c) => c[0] === 'inspect')
    expect(inspectAfterRm.length).toBeGreaterThanOrEqual(1)
  })

  test('surfaces a clear error when docker rm fails for a non-recoverable reason', async () => {
    const { exec } = fakeDockerExec({
      scenario: { exists: true, running: false },
      rmExitCode: 1,
      rmStderr: 'permission denied',
    })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/docker rm failed.*permission denied/)
  })

  test('surfaces a clear error when docker stop itself fails (does not proceed to rm)', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: true },
      stopFails: true,
    })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/docker stop failed/)
    expect(calls.find((c) => c[0] === 'rm')).toBeUndefined()
  })

  test('preserves the container when inspect fails and its logs cannot be safely identified', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: false },
      inspectExitCode: 1,
      inspectStderr: 'Error response from daemon: removal of container abc is already in progress',
    })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/preserving container.*logs/i)
    expect(calls.find((c) => c[0] === 'rm')).toBeUndefined()
  })

  test.each([`short|false\n`, `${CONTAINER_ID}|unknown\n`, `${'A'.repeat(64)}|true\n`])(
    'preserves the container without stop/archive/rm for malformed inspect output: %s',
    async (inspectStdout) => {
      const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: true }, inspectStdout })
      let archived = false

      const result = await stop({
        cwd: root,
        exec,
        archiveLogs: async () => {
          archived = true
          return { ok: true, status: 'archived', path: '/archive.log' }
        },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/malformed.*preserving/i)
      expect(archived).toBe(false)
      expect(calls.some((call) => call[0] === 'stop' || call[0] === 'rm')).toBe(false)
    },
  )

  test('short-circuits without docker rm when docker inspect reports the container truly does not exist', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: false },
      inspectExitCode: 1,
      inspectStderr: 'Error: No such container: anderson',
    })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(false)
    expect(calls.find((c) => c[0] === 'rm')).toBeUndefined()
  })

  test('treats docker inspect "no such object" as an absent container', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: false },
      inspectExitCode: 1,
      inspectStderr: 'Error: No such object: anderson',
    })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(false)
    expect(calls.some((call) => call[0] === 'stop' || call[0] === 'rm')).toBe(false)
  })

  test('archives after graceful stop and before removal, targeting the inspected ID', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: true } })
    const orderedArchive = async ({ containerId }: { containerId: string }) => {
      calls.push(['archive', containerId])
      return { ok: true as const, status: 'archived' as const, path: '/archive.log' }
    }

    const result = await stop({ cwd: root, exec, archiveLogs: orderedArchive })

    expect(result.ok).toBe(true)
    const stopIndex = calls.findIndex((call) => call[0] === 'stop')
    const archiveIndex = calls.findIndex((call) => call[0] === 'archive')
    const removeIndex = calls.findIndex((call) => call[0] === 'rm')
    expect(archiveIndex).toBeGreaterThan(stopIndex)
    expect(removeIndex).toBeGreaterThan(archiveIndex)
    expect(calls[archiveIndex]).toEqual(['archive', CONTAINER_ID])
    expect(calls[removeIndex]).toEqual(['rm', CONTAINER_ID])
  })

  test('passes the configured log retention period to archival', async () => {
    const { exec } = fakeDockerExec({ scenario: { exists: true, running: false } })
    await writeFile(join(root, 'typeclaw.json'), JSON.stringify({ logs: { retentionDays: 30 } }))
    let archiveInput: { agentDir: string; containerId: string; retentionDays?: number } | undefined

    const result = await stop({
      cwd: root,
      exec,
      archiveLogs: async (input) => {
        archiveInput = input
        return { ok: true, status: 'archived', path: '/archive.log' }
      },
    })

    expect(result.ok).toBe(true)
    expect(archiveInput).toEqual({ agentDir: root, containerId: CONTAINER_ID, retentionDays: 30 })
  })

  test.each([
    ['malformed JSON', '{ not json'],
    ['an unrelated schema error', JSON.stringify({ models: { default: 'not-a-known-model' } })],
  ])('falls back to 14-day archival and removes the container when config has %s', async (_kind, config) => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false } })
    await writeFile(join(root, 'typeclaw.json'), config)
    let retentionDays: number | undefined

    const result = await stop({
      cwd: root,
      exec,
      archiveLogs: async (input) => {
        retentionDays = input.retentionDays
        return { ok: true, status: 'archived', path: '/archive.log' }
      },
    })

    expect(result.ok).toBe(true)
    expect(retentionDays).toBe(14)
    expect(calls.find((call) => call[0] === 'rm')).toEqual(['rm', CONTAINER_ID])
  })

  test('preserves the same container ID if it resumes after archival', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false }, rmFindsRunning: true })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/running container.*preserving/i)
    expect(calls.find((call) => call[0] === 'rm')).toEqual(['rm', CONTAINER_ID])
    expect(calls.some((call) => call[0] === 'rm' && call.includes('-f'))).toBe(false)
  })

  test('does not remove the container when archival fails', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false } })
    const failingArchive = async () => ({ ok: false as const, kind: 'failed' as const, reason: 'disk full' })

    const result = await stop({ cwd: root, exec, archiveLogs: failingArchive })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/archive.*disk full/i)
    expect(calls.find((call) => call[0] === 'rm')).toBeUndefined()
  })

  test('warns and continues with non-force removal when Docker says logs are permanently unavailable', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false } })
    const warnings: string[] = []

    const result = await stop({
      cwd: root,
      exec,
      archiveLogs: async () => ({ ok: false, kind: 'unavailable', reason: 'terminal Docker state' }),
      onWarning: (warning) => warnings.push(warning),
    })

    expect(result.ok).toBe(true)
    expect(calls).toContainEqual(['rm', CONTAINER_ID])
    expect(calls.some((call) => call.includes('--force'))).toBe(false)
    expect(warnings).toEqual([expect.stringContaining('no new snapshot was captured')])
  })

  test('keeps ordinary archive failures fatal without issuing any rm', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false } })
    const warnings: string[] = []

    const result = await stop({
      cwd: root,
      exec,
      archiveLogs: async () => ({ ok: false, kind: 'failed', reason: 'disk full' }),
      onWarning: (warning) => warnings.push(warning),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Could not archive logs.*disk full.*Preserving/)
    expect(calls.some((call) => call[0] === 'rm')).toBe(false)
    expect(warnings).toEqual([])
  })

  test('diagnoses a non-benign removal failure stuck in removing without forcing it', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: false },
      rmExitCode: 1,
      rmStderr: 'permission denied',
      lifeStatus: 'removing',
    })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('docker rm failed: permission denied')
    expect(result.reason).toContain('Restart Docker or OrbStack')
    expect(calls.some((call) => call.includes('-f') || call.includes('--force'))).toBe(false)
  })

  test('diagnoses a timed-out removal drain when Docker reports the container dead', async () => {
    const now = spyOn(Date, 'now')
    let timestamp = 0
    now.mockImplementation(() => (timestamp += 10_001))
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: false },
      drainAfterInspectCalls: Number.MAX_SAFE_INTEGER,
      lifeStatus: 'dead',
    })

    try {
      const result = await stop({ cwd: root, exec, archiveLogs })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.reason).toContain('still being removed by docker after 10s')
      expect(result.reason).toContain('marked this container dead')
      expect(calls.some((call) => call.includes('-f') || call.includes('--force'))).toBe(false)
    } finally {
      now.mockRestore()
    }
  })

  test('keeps the pre-existing removal error byte-identical when the status probe is unreadable', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: false },
      rmExitCode: 1,
      rmStderr: 'permission denied',
      statusProbeExitCode: 1,
      statusProbeStderr: 'daemon unavailable',
    })

    const result = await stop({ cwd: root, exec, archiveLogs })

    expect(result).toEqual({ ok: false, reason: 'docker rm failed: permission denied' })
    expect(calls.some((call) => call.includes('-f') || call.includes('--force'))).toBe(false)
  })
})
