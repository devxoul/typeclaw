import { describe, expect, test } from 'bun:test'

import {
  runWatchdog,
  spawnProcessWorker,
  watchForOrphaning,
  type WatchdogOptions,
  type WatchdogWorker,
} from './watchdog'

const LIVE = 'setInterval(() => {}, 1000)'
const CRASH = 'process.exit(3)'
const CLEAN = 'process.exit(0)'

const FAST = {
  probeIntervalMs: 20,
  startupGraceMs: 0,
  maxMisses: 2,
  initialBackoffMs: 10,
  maxBackoffMs: 40,
  stopGraceMs: 200,
} satisfies Partial<WatchdogOptions>

type Harness = { workers: WatchdogWorker[]; logs: string[]; spawnWorker: () => WatchdogWorker }

function harness(scripts: (index: number) => string): Harness {
  const workers: WatchdogWorker[] = []
  const logs: string[] = []
  return {
    workers,
    logs,
    spawnWorker: () => {
      const worker = spawnProcessWorker([process.execPath, '-e', scripts(workers.length)])
      workers.push(worker)
      return worker
    },
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(10)
  }
}

describe('runWatchdog', () => {
  test('exits with the worker when the worker exits cleanly', async () => {
    // given
    const h = harness(() => CLEAN)

    // when
    const watchdog = runWatchdog({
      ...FAST,
      spawnWorker: h.spawnWorker,
      probe: async () => true,
      onLog: (m) => h.logs.push(m),
    })

    // then
    expect(await watchdog.done).toBe(0)
    expect(h.workers).toHaveLength(1)
    expect(h.logs.at(-1)).toContain('exited cleanly')
  })

  test('respawns a worker that crashes', async () => {
    // given
    const h = harness((index) => (index === 0 ? CRASH : LIVE))

    // when
    const watchdog = runWatchdog({
      ...FAST,
      spawnWorker: h.spawnWorker,
      probe: async () => true,
      onLog: (m) => h.logs.push(m),
    })
    await waitFor(() => h.workers.length === 2)

    // then
    expect(h.logs.some((m) => m.includes('exited unexpectedly (code 3)'))).toBe(true)
    await watchdog.stop()
  })

  test('kills and respawns a live worker that stops answering probes', async () => {
    // given: the first worker answers once, then goes silent like a wedged crash handler
    const h = harness(() => LIVE)
    let probes = 0
    const probe = async (): Promise<boolean> => {
      probes += 1
      return h.workers.length > 1 || probes === 1
    }

    // when
    const watchdog = runWatchdog({ ...FAST, spawnWorker: h.spawnWorker, probe, onLog: (m) => h.logs.push(m) })
    await waitFor(() => h.workers.length === 2)

    // then
    const first = h.workers[0]!
    expect(await first.exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(isAlive(first.pid)).toBe(false)
    expect(h.logs.some((m) => m.includes('stopped answering its control socket'))).toBe(true)
    await watchdog.stop()
  })

  test('does not kill a booting worker inside the startup grace window', async () => {
    // given
    const h = harness(() => LIVE)

    // when
    const watchdog = runWatchdog({
      ...FAST,
      startupGraceMs: 60_000,
      spawnWorker: h.spawnWorker,
      probe: async () => false,
      onLog: (m) => h.logs.push(m),
    })
    await Bun.sleep(FAST.probeIntervalMs * (FAST.maxMisses + 3))

    // then
    expect(h.workers).toHaveLength(1)
    expect(isAlive(h.workers[0]!.pid)).toBe(true)
    await watchdog.stop()
  })

  test('backs off exponentially, capped, while the worker crash-loops', async () => {
    // given
    const h = harness(() => CRASH)

    // when
    const watchdog = runWatchdog({
      ...FAST,
      spawnWorker: h.spawnWorker,
      probe: async () => true,
      onLog: (m) => h.logs.push(m),
    })
    await waitFor(() => h.workers.length >= 5)
    await watchdog.stop()

    // then
    const delays = h.logs.flatMap((m) => /respawning in (\d+)ms/.exec(m)?.[1] ?? []).map(Number)
    expect(delays.slice(0, 4)).toEqual([10, 20, 40, 40])
  })

  test('stop() terminates the worker and resolves done', async () => {
    // given
    const h = harness(() => LIVE)
    const watchdog = runWatchdog({
      ...FAST,
      spawnWorker: h.spawnWorker,
      probe: async () => true,
      onLog: (m) => h.logs.push(m),
    })
    await waitFor(() => h.workers.length === 1)

    // when
    await watchdog.stop()

    // then
    expect(await watchdog.done).toBe(0)
    expect(await h.workers[0]!.exited).toEqual({ code: null, signal: 'SIGTERM' })
    expect(h.workers).toHaveLength(1)
  })

  // Windows has no catchable SIGTERM: process.kill terminates outright, so a
  // worker cannot ignore it there.
  test.skipIf(process.platform === 'win32')('stop() force-kills a worker that ignores SIGTERM', async () => {
    // given
    const h = harness(() => `process.on('SIGTERM', () => {}); ${LIVE}`)
    const watchdog = runWatchdog({
      ...FAST,
      spawnWorker: h.spawnWorker,
      probe: async () => true,
      onLog: (m) => h.logs.push(m),
    })
    await waitFor(() => h.workers.length === 1)
    await Bun.sleep(200)

    // when
    await watchdog.stop()

    // then
    expect(await h.workers[0]!.exited).toEqual({ code: null, signal: 'SIGKILL' })
  })

  test.skipIf(process.platform === 'win32')(
    'stop() during a stalled probe still kills the worker within the 2s spawn.ts escalation window',
    async () => {
      // given: a probe that hangs past its interval, and a worker that ignores SIGTERM
      const h = harness(() => `process.on('SIGTERM', () => {}); ${LIVE}`)
      let probing = false
      const probe = (): Promise<boolean> => {
        probing = true
        return new Promise(() => {})
      }
      const watchdog = runWatchdog({
        ...FAST,
        stopGraceMs: 1_500,
        spawnWorker: h.spawnWorker,
        probe,
        onLog: (m) => h.logs.push(m),
      })
      await waitFor(() => probing)
      await Bun.sleep(200)

      // when
      const stoppedAt = Date.now()
      await watchdog.stop()

      // then
      expect(await h.workers[0]!.exited).toEqual({ code: null, signal: 'SIGKILL' })
      expect(Date.now() - stoppedAt).toBeLessThan(2_000)
    },
  )
})

describe('watchForOrphaning', () => {
  test('starts graceful shutdown and hard-exits when the watchdog parent goes away', async () => {
    // given: a graceful shutdown that never finishes, like a stalled restore or drain
    let parentPid = 100
    const orphaned: number[] = []
    const exits: number[] = []
    watchForOrphaning({
      watchdogPid: 100,
      getParentPid: () => parentPid,
      onOrphaned: () => orphaned.push(Date.now()),
      exit: (code) => exits.push(code),
      intervalMs: 10,
      exitDeadlineMs: 50,
    })
    await Bun.sleep(30)
    expect(orphaned).toHaveLength(0)

    // when
    parentPid = 1

    // then
    await waitFor(() => exits.length > 0)
    expect(orphaned).toHaveLength(1)
    expect(exits).toEqual([1])
  })

  test('notices a parent that died before the worker started watching', async () => {
    // given: the worker was already reparented by the time it checks
    const orphaned: string[] = []
    const exits: number[] = []

    // when
    watchForOrphaning({
      watchdogPid: 100,
      getParentPid: () => 1,
      onOrphaned: () => orphaned.push('orphaned'),
      exit: (code) => exits.push(code),
      intervalMs: 60_000,
      exitDeadlineMs: 10,
    })

    // then
    expect(orphaned).toEqual(['orphaned'])
    await waitFor(() => exits.length > 0)
  })

  test('stays quiet while the watchdog parent is alive', async () => {
    // given
    const orphaned: string[] = []
    const stop = watchForOrphaning({
      watchdogPid: 100,
      getParentPid: () => 100,
      onOrphaned: () => orphaned.push('orphaned'),
      exit: () => {},
      intervalMs: 5,
    })

    // when
    await Bun.sleep(40)
    stop()

    // then
    expect(orphaned).toHaveLength(0)
  })
})
