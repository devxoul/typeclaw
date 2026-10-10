// The host daemon is a single long-lived Bun process, and a runtime fault in it
// takes every host-side service down with it: credential renewal, the
// portbroker, container self-restart. Worse, Bun's crash handler can wedge
// instead of exiting (observed in the field: a segfault left the process
// spinning at 100% CPU for days, holding the pidfile). Nothing re-spawned it
// until an operator happened to run a host CLI command.
//
// So `_hostd` is a thin parent that runs the real daemon as a child and keeps
// it alive: a child that exits non-zero is respawned, and a child that stops
// answering its control socket is SIGKILLed and respawned. The parent does
// nothing but spawn, probe, and kill, which keeps it off the fetch/WebSocket/
// timer-heavy paths where the runtime faults have been observed.
//
// A clean (code 0) child exit is an intentional shutdown — the version-drift
// `shutdown` RPC or SIGTERM — so the parent exits with it and the next CLI call
// respawns the pair, exactly as before the watchdog existed.

export type WatchdogWorkerExit = { code: number | null; signal: string | null }

export type WatchdogWorker = {
  pid: number
  exited: Promise<WatchdogWorkerExit>
  kill: (signal: NodeJS.Signals) => void
}

export type WatchdogOptions = {
  spawnWorker: () => WatchdogWorker
  probe: () => Promise<boolean>
  onLog: (message: string) => void
  probeIntervalMs?: number
  // A freshly spawned child needs time to bind its socket; probe misses inside
  // this window don't count unless the child has already answered once.
  startupGraceMs?: number
  maxMisses?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  // A child that stayed up this long was healthy, so the next respawn starts
  // from the initial backoff again instead of the crash-loop ceiling.
  healthyResetMs?: number
  // `spawn.ts` escalates SIGTERM to SIGKILL on this parent after 2s, so the
  // child must be forced down inside that window or it outlives the parent.
  stopGraceMs?: number
}

export type Watchdog = {
  done: Promise<number>
  stop: () => Promise<void>
}

const DEFAULT_PROBE_INTERVAL_MS = 10_000
const DEFAULT_STARTUP_GRACE_MS = 30_000
const DEFAULT_MAX_MISSES = 3
const DEFAULT_INITIAL_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 60_000
const DEFAULT_HEALTHY_RESET_MS = 5 * 60_000
const DEFAULT_STOP_GRACE_MS = 1_500
const KILL_WAIT_MS = 5_000

type SuperviseOutcome =
  | { kind: 'stopped' }
  | { kind: 'exited'; exit: WatchdogWorkerExit }
  | { kind: 'unresponsive'; misses: number }

export function runWatchdog(opts: WatchdogOptions): Watchdog {
  const probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const startupGraceMs = opts.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS
  const maxMisses = opts.maxMisses ?? DEFAULT_MAX_MISSES
  const initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  const healthyResetMs = opts.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const log = opts.onLog

  let stopping = false
  let resolveStop: () => void = () => {}
  const stopRequested = new Promise<'stop'>((resolve) => {
    resolveStop = () => resolve('stop')
  })

  const done = (async (): Promise<number> => {
    let backoffMs = initialBackoffMs
    while (!stopping) {
      const startedAt = Date.now()
      let worker: WatchdogWorker
      try {
        worker = opts.spawnWorker()
      } catch (error) {
        log(`failed to spawn host daemon worker: ${error instanceof Error ? error.message : String(error)}`)
        if (await sleepOrStop(backoffMs)) break
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
        continue
      }
      log(`started host daemon worker pid ${worker.pid}`)

      const outcome = await supervise(worker)
      if (outcome.kind === 'stopped') break
      if (outcome.kind === 'exited' && outcome.exit.code === 0) {
        log(`host daemon worker pid ${worker.pid} exited cleanly; watchdog exiting`)
        return 0
      }

      if (Date.now() - startedAt >= healthyResetMs) backoffMs = initialBackoffMs
      const reason =
        outcome.kind === 'exited'
          ? `exited unexpectedly (${describeExit(outcome.exit)})`
          : `stopped answering its control socket (${outcome.misses} missed probes) and was killed`
      log(`host daemon worker pid ${worker.pid} ${reason}; respawning in ${backoffMs}ms`)
      if (await sleepOrStop(backoffMs)) break
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    }
    return 0
  })()

  return {
    done,
    stop: async () => {
      stopping = true
      resolveStop()
      await done
    },
  }

  async function supervise(worker: WatchdogWorker): Promise<SuperviseOutcome> {
    const spawnedAt = Date.now()
    const exit = worker.exited.then((result) => ({ kind: 'exit' as const, result }))
    let answeredOnce = false
    let misses = 0

    while (true) {
      const wake = await Promise.race([exit, stopRequested, sleep(probeIntervalMs).then(() => 'tick' as const)])
      if (wake === 'stop') {
        await terminate(worker, exit)
        return { kind: 'stopped' }
      }
      if (wake !== 'tick') return { kind: 'exited', exit: wake.result }

      // A stalled probe can take its full timeout; stop must not wait it out,
      // or spawn.ts SIGKILLs this parent before the worker is down.
      const answered = await Promise.race([opts.probe().catch(() => false), exit.then(() => null), stopRequested])
      if (answered === 'stop') {
        await terminate(worker, exit)
        return { kind: 'stopped' }
      }
      if (answered === null) continue
      if (answered) {
        answeredOnce = true
        misses = 0
        continue
      }
      if (!answeredOnce && Date.now() - spawnedAt < startupGraceMs) continue
      misses += 1
      if (misses < maxMisses) continue

      // A wedged Bun crash handler does not run signal handlers, so SIGTERM
      // would just burn the wait; go straight to SIGKILL.
      worker.kill('SIGKILL')
      if ((await Promise.race([exit, sleep(KILL_WAIT_MS).then(() => 'timeout' as const)])) === 'timeout') {
        log(`host daemon worker pid ${worker.pid} did not exit after SIGKILL; respawning anyway`)
      }
      return { kind: 'unresponsive', misses }
    }
  }

  async function terminate(worker: WatchdogWorker, exit: Promise<unknown>): Promise<void> {
    worker.kill('SIGTERM')
    if ((await Promise.race([exit, sleep(stopGraceMs).then(() => 'timeout' as const)])) !== 'timeout') return
    worker.kill('SIGKILL')
    await Promise.race([exit, sleep(KILL_WAIT_MS)])
  }

  async function sleepOrStop(ms: number): Promise<boolean> {
    return (await Promise.race([stopRequested, sleep(ms).then(() => 'slept' as const)])) === 'stop'
  }
}

export type OrphanWatchOptions = {
  // Passed from the parent rather than read from `process.ppid` at startup: a
  // parent that dies before the worker finishes loading would otherwise be
  // captured as the already-reparented pid and never noticed.
  watchdogPid: number
  onOrphaned: () => void
  getParentPid?: () => number
  exit?: (code: number) => void
  intervalMs?: number
  // Graceful shutdown awaits restore and renewal drains with no deadline of
  // their own, and no supervisor is left to force it, so cap it here.
  exitDeadlineMs?: number
}

const DEFAULT_ORPHAN_CHECK_INTERVAL_MS = 2_000
const DEFAULT_ORPHAN_EXIT_DEADLINE_MS = 3_000

// A worker whose watchdog parent was SIGKILLed would keep the socket and
// renewal timers alive with no pidfile pointing at it, so the next CLI call
// could neither reach a fresh daemon nor reap this one. Exits within
// intervalMs + exitDeadlineMs of the parent dying.
export function watchForOrphaning(opts: OrphanWatchOptions): () => void {
  const getParentPid = opts.getParentPid ?? (() => process.ppid)
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const exitDeadlineMs = opts.exitDeadlineMs ?? DEFAULT_ORPHAN_EXIT_DEADLINE_MS
  let interval: ReturnType<typeof setInterval> | undefined

  const check = (): boolean => {
    if (getParentPid() === opts.watchdogPid) return false
    if (interval) clearInterval(interval)
    setTimeout(() => exit(1), exitDeadlineMs)
    opts.onOrphaned()
    return true
  }

  if (check()) return () => {}
  interval = setInterval(check, opts.intervalMs ?? DEFAULT_ORPHAN_CHECK_INTERVAL_MS)
  interval.unref()
  return () => clearInterval(interval)
}

export function spawnProcessWorker(cmd: string[]): WatchdogWorker {
  const proc = Bun.spawn({
    cmd,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env },
  })
  return {
    pid: proc.pid,
    exited: proc.exited.then(() => ({ code: proc.exitCode, signal: proc.signalCode })),
    kill: (signal) => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal)
    },
  }
}

function describeExit(exit: WatchdogWorkerExit): string {
  if (exit.signal) return `signal ${exit.signal}`
  return `code ${exit.code}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
