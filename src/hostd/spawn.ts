import { existsSync } from 'node:fs'
import { appendFile, lstat, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'

import lockfile from 'proper-lockfile'

import { isWindows } from '@/shared'

import { isDaemonReachable, send } from './client'
import { ensureDirs, lockfilePath, logfilePath, pidfilePath, socketPath } from './paths'
import type { HttpInfoResult, VersionResult } from './protocol'
import { computeSourceVersion, resolveSrcRoot, UNVERSIONED_SENTINEL } from './version'

export type EnsureDaemonOptions = {
  cliEntry: string
  spawnTimeoutMs?: number
  // Test seam: tests inject a deterministic version probe + respawn so the
  // unit test can exercise the drift path without spawning a real daemon.
  expectedVersion?: string
  // Test seam: parks execution inside the spawn lock, just before spawning, so a
  // test can prove a concurrent caller cannot enter the critical section.
  onSpawnEnter?: () => Promise<void>
}

export type EnsureDaemonResult =
  | { ok: true; pid: number; spawned: boolean; respawned: boolean; httpPort: number }
  | { ok: false; reason: string }

const DEFAULT_SPAWN_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50
const EXIT_SETTLE_MS = 500
// proper-lockfile refreshes the held lock's mtime every `stale/2` ms, so a lock
// held across the full spawn (readiness poll + EXIT_SETTLE_MS grace) is never
// seen as stale by a contender — only a crashed holder, whose refresh timer
// died with it, is reclaimed. Mirrors the models/secrets locks' 30s ceiling.
const LOCK_STALE_MS = 30_000
// A pidfile child that is still unreachable this long after it was spawned is
// wedged (e.g. stuck in Bun's crash handler after a segfault), not slow-booting.
// The pidfile is written at spawn time, so its mtime is the child's birth time.
const WEDGED_DAEMON_AGE_MS = 30_000
const SHUTDOWN_EXIT_GRACE_MS = 2_000
const KILL_GRACE_MS = 2_000
const LOCK_RETRY_BACKOFF = {
  factor: 1,
  minTimeout: POLL_INTERVAL_MS,
  maxTimeout: POLL_INTERVAL_MS,
  randomize: false,
} as const

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  if (await isDaemonReachable()) {
    const expected = opts.expectedVersion ?? (await deriveExpectedVersion(opts.cliEntry))
    const httpPort = await readHttpPort()
    if ((await daemonVersionMatches(expected)) && httpPort !== null) {
      return { ok: true, pid: await readPidQuiet(), spawned: false, respawned: false, httpPort }
    }
    const shutdownOk = await requestShutdownAndWait()
    if (!shutdownOk) {
      return { ok: false, reason: 'daemon version drifted but shutdown request did not complete' }
    }
    await ensureDirs()
    const respawn = await spawnUnderLock(opts)
    if (!respawn.ok) return respawn
    return { ...respawn, respawned: true }
  }

  await ensureDirs()
  const result = await spawnUnderLock(opts)
  if (!result.ok) return result
  return { ...result, respawned: false }
}

async function deriveExpectedVersion(cliEntry: string): Promise<string> {
  const srcRoot = resolveSrcRoot(cliEntry)
  if (srcRoot === null) return UNVERSIONED_SENTINEL
  return computeSourceVersion({ srcRoot })
}

// A `version` reply that doesn't deserialize cleanly (e.g. a pre-feature
// daemon that doesn't recognize the kind) is treated as a mismatch. Same for
// any non-ok response. Conservative: it's safer to over-respawn than to keep
// running stale code.
async function daemonVersionMatches(expected: string): Promise<boolean> {
  const reply = await send({ kind: 'version' }, { timeoutMs: 1_000 })
  if (!reply.ok) return false
  const result = reply.result as VersionResult | undefined
  if (!result || typeof result.version !== 'string') return false
  return result.version === expected
}

async function readHttpPort(): Promise<number | null> {
  const reply = await send({ kind: 'http-info' }, { timeoutMs: 1_000 })
  if (!reply.ok) return null
  const result = reply.result as HttpInfoResult | undefined
  return typeof result?.port === 'number' && result.port > 0 && result.port <= 65535 ? result.port : null
}

async function requestShutdownAndWait(): Promise<boolean> {
  const pid = await readPidQuiet()
  const reply = await send({ kind: 'shutdown' }, { timeoutMs: 1_000 })
  if (!reply.ok) return false
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (isWindows()) {
      if (!(await isDaemonReachable(POLL_INTERVAL_MS))) return true
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    if (!existsSync(socketPath())) {
      await reapLingeringDaemon(pid)
      return true
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

// The daemon unlinks its socket at the end of stop(), before exiting. A daemon
// that never makes it to exit (observed in the field: "stopping" logged, process
// alive for days) keeps its HTTP control port and renewal timers, so the fresh
// daemon falls back to another port and two daemons run against one home.
async function reapLingeringDaemon(pid: number): Promise<void> {
  if (pid <= 0) return
  if (await waitForExit(pid, SHUTDOWN_EXIT_GRACE_MS)) return
  if (!(await isHostdProcess(pid))) return
  const reaped = await terminateProcess(pid)
  await appendSpawnLog(
    reaped
      ? `reaped host daemon pid ${pid} that acknowledged shutdown but did not exit`
      : `host daemon pid ${pid} acknowledged shutdown but did not exit and could not be terminated`,
  )
}

type SpawnAttemptResult = { ok: true; pid: number; spawned: boolean; httpPort: number } | { ok: false; reason: string }

async function spawnUnderLock(opts: EnsureDaemonOptions): Promise<SpawnAttemptResult> {
  const lock = await acquireSpawnLock(opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS)
  if (lock.kind === 'contended') {
    // Another caller holds the spawn lock. If a daemon came up meanwhile, reuse
    // it; otherwise that caller is still mid-spawn, so back off without racing a
    // second spawn. proper-lockfile reclaims a crashed holder's lock on its own
    // (its mtime refresh timer dies with the process), so there's no lock to
    // clear here — the ownership-unsafe manual clear is gone.
    if (await isDaemonReachable()) {
      const httpPort = await readHttpPort()
      if (httpPort === null) return { ok: false, reason: 'daemon did not report an HTTP control port' }
      return { ok: true, pid: await readPidQuiet(), spawned: false, httpPort }
    }
    return { ok: false, reason: 'another daemon spawn is in progress' }
  }

  try {
    if (await isDaemonReachable()) {
      const httpPort = await readHttpPort()
      if (httpPort === null) return { ok: false, reason: 'daemon did not report an HTTP control port' }
      return { ok: true, pid: await readPidQuiet(), spawned: false, httpPort }
    }
    // A prior spawn attempt can leave a live-but-not-yet-listening child (its
    // readiness poll timed out without killing it — see spawnDaemonDetached).
    // Spawning a second daemon would race two processes for the same socket, so
    // adopt the existing child and poll IT for readiness instead of re-spawning.
    const existingPid = await livePidfileChild()
    if (existingPid !== null) {
      if (!(await isWedgedDaemon(existingPid))) {
        const ready = await pollForReadiness(opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS)
        if (ready === null) return { ok: false, reason: 'daemon spawned but did not become reachable yet' }
        return { ok: true, pid: existingPid, spawned: false, httpPort: ready }
      }
      // Adopting a wedged daemon would block every future start forever, so
      // replace it. Only reached after isDaemonReachable() failed above.
      if (!(await terminateProcess(existingPid))) {
        await appendSpawnLog(`host daemon pid ${existingPid} is unresponsive and could not be terminated`)
        return { ok: false, reason: `host daemon pid ${existingPid} is unresponsive and could not be terminated` }
      }
      await appendSpawnLog(`replaced unresponsive host daemon pid ${existingPid}`)
    }
    await opts.onSpawnEnter?.()
    return await spawnDaemonDetached(opts)
  } finally {
    await lock.release()
  }
}

// Reads the pidfile and returns its pid only if that process is still alive
// (signal 0 = existence check, no signal delivered). Returns null when the
// pidfile is absent/garbage or the process has exited — i.e. nothing to adopt.
async function livePidfileChild(): Promise<number | null> {
  const pid = await readPidQuiet()
  if (pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

async function isWedgedDaemon(pid: number): Promise<boolean> {
  if (isWindows()) return false
  let spawnedAtMs: number
  try {
    spawnedAtMs = (await stat(pidfilePath())).mtimeMs
  } catch {
    return false
  }
  if (Date.now() - spawnedAtMs < WEDGED_DAEMON_AGE_MS) return false
  return isHostdProcess(pid)
}

// PID-reuse guard: a pidfile pid is only signalled when its full command line
// is exactly the three-token launch signature from spawnDaemonDetached — the
// bun executable, the typeclaw CLI entry, `_hostd` — so a recycled pid that
// mentions `_hostd`, or passes the whole signature as arguments to another
// program (`watch … pgrep -f bun …/cli/index.ts _hostd`), is never killed.
// Tokens are whitespace-free: `ps` joins argv with spaces, so a path containing
// spaces is ambiguous and fails closed (adopted, never signalled).
const HOSTD_COMMAND_SIGNATURE = /^(?:\S*\/)?bun \S*\/(?:cli\/index\.ts|typeclaw) _hostd$/

async function isHostdProcess(pid: number): Promise<boolean> {
  if (isWindows()) return false
  try {
    const proc = Bun.spawn({
      cmd: ['ps', '-o', 'command=', '-p', String(pid)],
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return HOSTD_COMMAND_SIGNATURE.test(out.trim())
  } catch {
    return false
  }
}

// SIGTERM first so a merely-hung event loop can still run its shutdown handler;
// SIGKILL for a process that can't (e.g. spinning inside a crash handler).
async function terminateProcess(pid: number): Promise<boolean> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return true
      return false
    }
    if (await waitForExit(pid, KILL_GRACE_MS)) return true
  }
  return false
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(POLL_INTERVAL_MS)
  }
  return true
}

async function appendSpawnLog(message: string): Promise<void> {
  await appendFile(logfilePath(), `${new Date().toISOString()} [hostd-spawn] ${message}\n`).catch(() => {})
}

async function pollForReadiness(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDaemonReachable()) {
      const httpPort = await readHttpPort()
      if (httpPort !== null) return httpPort
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

async function spawnDaemonDetached(opts: EnsureDaemonOptions): Promise<SpawnAttemptResult> {
  // Bun.spawn() with `stdout: <number>` consumes the file descriptor by
  // dup()-ing it into the child; the parent's handle remains valid until we
  // close it. Closing too early would race the dup. We hold the FileHandle
  // open across spawn() and close it only after the child has been launched.
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(logfilePath(), 'a')
  } catch (error) {
    return { ok: false, reason: `failed to open daemon log: ${stringify(error)}` }
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({
      cmd: [process.execPath, opts.cliEntry, '_hostd'],
      stdin: 'ignore',
      stdout: handle.fd,
      stderr: handle.fd,
      env: { ...process.env },
    })
  } catch (error) {
    handle.close().catch(() => {})
    return { ok: false, reason: `failed to spawn daemon: ${stringify(error)}` }
  }
  proc.unref()
  handle.close().catch(() => {})

  try {
    await writeFile(pidfilePath(), `${proc.pid}\n`)
  } catch (error) {
    try {
      proc.kill('SIGTERM')
    } catch {}
    return { ok: false, reason: `failed to write daemon pidfile: ${stringify(error)}` }
  }

  const httpPort = await pollForReadiness(opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS)
  if (httpPort !== null) return { ok: true, pid: proc.pid, spawned: true, httpPort }

  // Timed out waiting for readiness. A still-running child is "slow-booting",
  // not "wedged" — killing it would throw away a daemon that's about to come up
  // and force every caller into a respawn loop. Only reap a child that already
  // EXITED: that's a genuine failure with a dangling pidfile to clean. A
  // live-but-not-ready child is left running so the caller can re-probe it (see
  // registerWithDaemon's retry) — the next ensureDaemon() fast-paths through
  // isDaemonReachable() once its socket binds.
  //
  // `proc.exitCode` is a non-blocking snapshot, so a child that fails fast (e.g.
  // a bad CLI entry) can still read as `null` here if the readiness deadline
  // lands in the narrow window between the process exiting and Bun reaping it.
  // Give it a bounded grace to settle by racing `proc.exited`; this makes the
  // exited-vs-slow-booting classification deterministic instead of dependent on
  // scheduler timing, without ever killing a still-live child.
  if (proc.exitCode === null) await settleExit(proc, EXIT_SETTLE_MS)
  if (proc.exitCode !== null) {
    try {
      const raw = await readFile(pidfilePath(), 'utf8').catch(() => '')
      if (raw.trim() === String(proc.pid)) await unlink(pidfilePath())
    } catch {}
    return { ok: false, reason: 'daemon exited before becoming reachable' }
  }
  return { ok: false, reason: 'daemon spawned but did not become reachable yet' }
}

async function settleExit(proc: ReturnType<typeof Bun.spawn>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs)
  })
  try {
    await Promise.race([proc.exited.then(() => undefined), grace])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type LockResult = { kind: 'acquired'; release: () => Promise<void> } | { kind: 'contended' }

async function acquireSpawnLock(timeoutMs: number): Promise<LockResult> {
  const path = lockfilePath()
  await clearLegacyFileLock(path)
  const retries = Math.max(1, Math.ceil(timeoutMs / POLL_INTERVAL_MS))
  try {
    const release = await lockfile.lock(path, {
      lockfilePath: path,
      realpath: false,
      stale: LOCK_STALE_MS,
      retries: { ...LOCK_RETRY_BACKOFF, retries },
    })
    return { kind: 'acquired', release: () => release().catch(() => {}) }
  } catch (error) {
    if (errorCode(error) === 'ELOCKED') return { kind: 'contended' }
    throw error
  }
}

// The pre-proper-lockfile daemon left the lock as a regular FILE at this path.
// proper-lockfile locks by creating a DIRECTORY there, so a stale legacy file
// makes mkdir fail EEXIST (reported as ELOCKED) while its own reclaim rmdir
// fails ENOTDIR — wedging startup forever after an upgrade. Clear an abandoned
// legacy file, but never a live one: a co-existing old-binary caller mid-spawn
// may hold it before its daemon is reachable. The recorded pid is only a hint
// (pids get recycled), so it's trusted only while the file is fresh; an aged
// file is reclaimed regardless. Directories (a live proper-lockfile lock) and
// symlinks are left untouched.
async function clearLegacyFileLock(path: string): Promise<void> {
  let observed: Awaited<ReturnType<typeof lstat>>
  try {
    observed = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  if (!observed.isFile()) return

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'EISDIR') return
    throw error
  }

  const pid = Number.parseInt(raw.trim(), 10)
  const hasValidPid = Number.isSafeInteger(pid) && pid > 0
  const isFresh = Date.now() - observed.mtimeMs < LOCK_STALE_MS
  // A bare pid is only trustworthy briefly: pid reuse would otherwise let an
  // abandoned legacy file (whose recorded pid the OS reassigned to an unrelated
  // process) look "held" forever. So preserve only a FRESH file that is either
  // held by a live pid or still within the grace for a not-yet-written pid; once
  // the file ages past LOCK_STALE_MS, reclaim it regardless of pid liveness.
  if (isFresh && (!hasValidPid || processExists(pid))) return

  try {
    const current = await lstat(path)
    if (!current.isFile() || current.dev !== observed.dev || current.ino !== observed.ino) return
    await unlink(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'EPERM') return
    throw error
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we may not signal it — still alive.
    return errorCode(error) !== 'ESRCH'
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

async function readPidQuiet(): Promise<number> {
  try {
    const raw = await readFile(pidfilePath(), 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(pid) ? pid : 0
  } catch {
    return 0
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
