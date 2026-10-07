import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import lockfile from 'proper-lockfile'

import { isWindows } from '@/shared'

import { isDaemonReachable } from './client'
import { startDaemon, type Daemon } from './daemon'
import { ensureDirs, lockfilePath, logfilePath, pidfilePath, socketPath } from './paths'
import { ensureDaemon } from './spawn'

let home: string
let prev: string | undefined
let daemon: Daemon | null = null

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-spawn-'))
  prev = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
  daemon = null
})

afterEach(async () => {
  if (daemon) await daemon.stop().catch(() => {})
  if (prev === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prev
  await rm(home, { recursive: true, force: true })
})

async function expectDaemonEndpointListening(): Promise<void> {
  if (isWindows()) {
    expect(await isDaemonReachable(500)).toBe(true)
    return
  }
  expect(existsSync(socketPath())).toBe(true)
}

async function expectDaemonEndpointGone(): Promise<void> {
  if (isWindows()) {
    expect(await isDaemonReachable(50)).toBe(false)
    return
  }
  expect(existsSync(socketPath())).toBe(false)
}

describe('ensureDaemon', () => {
  test('reuses a reachable daemon when the version matches', async () => {
    daemon = await startDaemon({
      version: 'matching-hash',
      gcIntervalMs: 1_000_000,
    })

    const result = await ensureDaemon({
      cliEntry: '/nowhere/cli.ts',
      expectedVersion: 'matching-hash',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spawned).toBe(false)
    expect(result.respawned).toBe(false)
  })

  test('detects drift when the daemon advertises a different version, shuts it down, then attempts a respawn', async () => {
    daemon = await startDaemon({
      version: 'old',
      gcIntervalMs: 1_000_000,
    })
    await expectDaemonEndpointListening()

    const result = await ensureDaemon({
      cliEntry: '/nonexistent/cli.ts',
      expectedVersion: 'new',
      spawnTimeoutMs: 100,
    })

    // After detecting drift, ensureDaemon sends `shutdown` and waits for the
    // socket to disappear (which it does, because daemon.stop unlinks it).
    // Then it tries to respawn the daemon at the dummy CLI entry, which
    // fails. The end-to-end behavior we want to assert: the stale daemon was
    // torn down (socket gone) and ensureDaemon did NOT reuse it.
    daemon = null
    await expectDaemonEndpointGone()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).toContain('reachable')
  })

  test('happy path: socket missing -> spawns a new daemon (when cliEntry resolves)', async () => {
    await expectDaemonEndpointGone()

    const result = await ensureDaemon({
      cliEntry: '/nonexistent/cli.ts',
      spawnTimeoutMs: 100,
    })

    // Production path requires a real CLI entry; the dummy path makes the
    // spawned child fail fast. spawnDaemonDetached races the child's exit
    // against a grace window, so the failure is classified as EXITED regardless
    // of scheduler timing — not left as the ambiguous "not reachable yet". The
    // reaped pidfile must not linger, and we must not fall into the drift path.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).not.toContain('drift')
    expect(result.reason.toLowerCase()).toContain('exited')
    expect(existsSync(pidfilePath())).toBe(false)
  })

  test('adopts a live-but-unreachable child instead of spawning a second daemon', async () => {
    // given: a previous spawn left a live child that never bound the socket —
    // simulated by a harmless long-lived process recorded in the pidfile
    if (isWindows()) return
    await expectDaemonEndpointGone()
    const child = await spawnFakeHostd()
    try {
      await mkdir(dirname(pidfilePath()), { recursive: true })
      await writeFile(pidfilePath(), `${child.pid}\n`)

      // when: ensureDaemon runs while that child is alive but unreachable
      const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 150 })

      // then: it adopts and polls the existing child (times out), never spawning
      // a second daemon — the pidfile still points at OUR child, untouched
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('did not become reachable yet')
      expect(readFileSync(pidfilePath(), 'utf8').trim()).toBe(String(child.pid))
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('replaces a wedged daemon that stayed unreachable past the boot window', async () => {
    // given: a host daemon process spawned long ago that never answers its
    // socket — e.g. stuck in Bun's crash handler after a segfault
    if (isWindows()) return
    await expectDaemonEndpointGone()
    const child = await spawnFakeHostd()
    try {
      await writeAgedPidfile(child.pid)

      // when: ensureDaemon runs against it
      const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 150 })

      // then: the wedged process is terminated and a fresh spawn is attempted
      // (which fails on the dummy cliEntry) instead of adopting it forever
      expect(await exitedWithin(child, 5_000)).toBe(true)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('exited before becoming reachable')
      expect(readFileSync(logfilePath(), 'utf8')).toContain(`replaced unresponsive host daemon pid ${child.pid}`)
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('escalates to SIGKILL when a wedged daemon ignores SIGTERM', async () => {
    // given: a wedged daemon whose SIGTERM handler never lets it exit, like a
    // process spinning inside Bun's crash handler
    if (isWindows()) return
    await expectDaemonEndpointGone()
    const child = await spawnFakeHostd({ ignoreSigterm: true })
    try {
      await writeAgedPidfile(child.pid)

      // when: ensureDaemon replaces it
      const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 150 })

      // then: SIGTERM is not enough, so it is SIGKILLed and the replacement
      // spawn is still attempted
      expect(await exitedWithin(child, 10_000)).toBe(true)
      expect(child.signalCode).toBe('SIGKILL')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('exited before becoming reachable')
    } finally {
      child.kill('SIGKILL')
    }
  })

  for (const [label, cmd] of [
    [
      'a bun process that only mentions _hostd',
      [process.execPath, '-e', 'setInterval(() => "_hostd", 1_000)', '_hostd'],
    ],
    ['a shell loop grepping for _hostd', ['sh', '-c', 'while :; do grep -q _hostd /dev/null; sleep 1; done']],
    [
      'a monitor carrying the full launch signature as arguments',
      ['sh', '-c', 'while :; do sleep 1; done', 'watch', '/usr/local/bin/bun', '/repo/src/cli/index.ts', '_hostd'],
    ],
    [
      'a bun process carrying the full launch signature as arguments',
      [
        process.execPath,
        '-e',
        'setInterval(() => {}, 1_000)',
        '/usr/local/bin/bun',
        '/repo/src/cli/index.ts',
        '_hostd',
      ],
    ],
  ] as const) {
    test(`never signals an aged pidfile pid reused by ${label}`, async () => {
      // given: an aged pidfile whose pid the OS recycled to an unrelated
      // process whose command text happens to contain `_hostd`
      if (isWindows()) return
      await expectDaemonEndpointGone()
      const unrelated = Bun.spawn({ cmd: [...cmd], stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      unrelated.unref()
      try {
        await writeAgedPidfile(unrelated.pid)

        // when: ensureDaemon runs
        const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 150 })

        // then: the unrelated process is left alone and treated as before
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.reason).toContain('did not become reachable yet')
        expect(unrelated.exitCode).toBeNull()
        expect(unrelated.signalCode).toBeNull()
      } finally {
        unrelated.kill('SIGKILL')
      }
    })
  }

  test('reaps a drifted daemon that acknowledged shutdown but never exited', async () => {
    // given: a reachable daemon on an old version whose process will unlink its
    // socket on shutdown but linger — modelled by the in-process daemon serving
    // the socket plus a host daemon process recorded in the pidfile
    if (isWindows()) return
    daemon = await startDaemon({ version: 'old', gcIntervalMs: 1_000_000 })
    const lingering = await spawnFakeHostd()
    try {
      await writeFile(pidfilePath(), `${lingering.pid}\n`)

      // when: ensureDaemon detects drift and requests shutdown
      await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', expectedVersion: 'new', spawnTimeoutMs: 100 })
      daemon = null

      // then: the process that did not exit is reaped, so it can't keep holding
      // the HTTP control port or run renewals next to the fresh daemon
      expect(await exitedWithin(lingering, 5_000)).toBe(true)
      expect(readFileSync(logfilePath(), 'utf8')).toContain(
        `reaped host daemon pid ${lingering.pid} that acknowledged shutdown but did not exit`,
      )
    } finally {
      lingering.kill('SIGKILL')
    }
  })

  test('a short-timeout caller never clears or replaces an actively held spawn lock', async () => {
    // given: another caller holds the spawn lock — e.g. one sitting in the
    // exit-settle grace inside spawnDaemonDetached, which can outlast a short
    // spawnTimeoutMs. We hold it directly so the interleaving is deterministic.
    if (isWindows()) return
    await expectDaemonEndpointGone()
    await ensureDirs()
    const release = await lockfile.lock(lockfilePath(), {
      lockfilePath: lockfilePath(),
      realpath: false,
      stale: 30_000,
      retries: 0,
    })

    try {
      // when: a caller with a short spawn timeout contends for the same lock
      const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 100 })

      // then: it backs off as contended rather than clearing the held lock and
      // racing a second spawn — the pre-fix bug would have cleared+reacquired it
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason.toLowerCase()).toContain('in progress')
      // the lock is still held by us and was never reaped by the contender
      expect(existsSync(lockfilePath())).toBe(true)
    } finally {
      await release()
    }
    // and: once we release, the lock is gone — proving the contender left it intact
    expect(existsSync(lockfilePath())).toBe(false)
  })

  test('reclaims a legacy file lock whose recorded pid has exited', async () => {
    // given: an abandoned legacy-format lock (a regular FILE) recording a pid
    // that has since exited — would otherwise wedge the directory lock forever
    if (isWindows()) return
    await expectDaemonEndpointGone()
    await ensureDirs()
    const deadPid = await spawnAndReapPid()
    await writeFile(lockfilePath(), `${deadPid}\n`)

    // when: a spawn runs against that stale legacy file
    const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 100 })

    // then: the legacy file is reclaimed and the spawn reaches the spawn path
    // (fails on the dummy cliEntry) rather than being locked out forever
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).not.toContain('in progress')
    expect(existsSync(lockfilePath())).toBe(false)
  })

  test('preserves a fresh legacy file lock whose recorded pid is still alive', async () => {
    // given: a fresh legacy-format lock recording a live pid (a co-existing
    // old-binary caller mid-spawn, before its daemon is reachable) — not stolen
    if (isWindows()) return
    await expectDaemonEndpointGone()
    await ensureDirs()
    await writeFile(lockfilePath(), `${process.pid}\n`)

    // when: a spawn runs while that legacy lock is held by a live pid
    const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 100 })

    // then: the live legacy lock is left intact and the caller backs off
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).toContain('in progress')
    expect(readFileSync(lockfilePath(), 'utf8').trim()).toBe(String(process.pid))
  })

  test('reclaims an aged legacy file lock even when its recorded pid is live (pid reuse)', async () => {
    // given: an OLD legacy file recording a live pid — the classic pid-reuse
    // trap where the OS reassigned the dead daemon's pid to an unrelated live
    // process. Backdating the mtime past the stale grace makes it reclaimable
    // despite the live pid, so it can't wedge startup permanently.
    if (isWindows()) return
    await expectDaemonEndpointGone()
    await ensureDirs()
    await writeFile(lockfilePath(), `${process.pid}\n`)
    const aged = new Date(Date.now() - 35_000)
    await utimes(lockfilePath(), aged, aged)

    // when: a spawn runs against the aged-but-live-pid legacy file
    const result = await ensureDaemon({ cliEntry: '/nonexistent/cli.ts', spawnTimeoutMs: 100 })

    // then: it is reclaimed (age overrides pid liveness) and the spawn proceeds
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).not.toContain('in progress')
    expect(existsSync(lockfilePath())).toBe(false)
  })

  test('only one concurrent caller enters the spawn path; the other is locked out', async () => {
    if (isWindows()) return
    await expectDaemonEndpointGone()

    const entered = deferred()
    const release = deferred()
    let spawnEntries = 0

    // given: caller A acquires the lock and parks inside the critical section,
    // just past lock-acquire, holding the lock open
    const first = ensureDaemon({
      cliEntry: '/nonexistent/cli.ts',
      spawnTimeoutMs: 100,
      onSpawnEnter: async () => {
        spawnEntries++
        entered.resolve()
        await release.promise
      },
    })

    try {
      await entered.promise

      // when: caller B runs while A still holds the lock
      const second = await ensureDaemon({
        cliEntry: '/nonexistent/cli.ts',
        spawnTimeoutMs: 100,
        onSpawnEnter: async () => {
          spawnEntries++
        },
      })

      // then: B is locked out and never reaches the spawn path — exactly one
      // caller entered the critical section, so no second daemon can race
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.reason.toLowerCase()).toContain('in progress')
      expect(spawnEntries).toBe(1)
    } finally {
      release.resolve()
      await first
    }
    expect(spawnEntries).toBe(1)
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// A long-lived process launched with the real daemon signature
// (`bun <...>/src/cli/index.ts _hostd`) that never binds the socket. Resolves
// once the script is running, so any SIGTERM handler is already installed.
async function spawnFakeHostd({ ignoreSigterm = false } = {}): Promise<ReturnType<typeof Bun.spawn>> {
  const entry = join(home, 'fake-typeclaw', 'src', 'cli', 'index.ts')
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(
    entry,
    `${ignoreSigterm ? "process.on('SIGTERM', () => {})\n" : ''}setInterval(() => {}, 1_000)\nconsole.log('ready')\n`,
  )
  const child = Bun.spawn({
    cmd: [process.execPath, entry, '_hostd'],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  child.unref()
  const reader = child.stdout.getReader()
  let seen = ''
  while (!seen.includes('ready')) {
    const { value, done } = await reader.read()
    if (done) throw new Error('fake host daemon exited before becoming ready')
    seen += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return child
}

async function writeAgedPidfile(pid: number): Promise<void> {
  await ensureDirs()
  await writeFile(pidfilePath(), `${pid}\n`)
  const aged = new Date(Date.now() - 60_000)
  await utimes(pidfilePath(), aged, aged)
}

async function exitedWithin(child: ReturnType<typeof Bun.spawn>, ms: number): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), ms))
  return Promise.race([child.exited.then(() => true as const), timeout])
}

// Spawns a trivial process, waits for it to exit, and returns its now-dead pid —
// a real reaped pid is a more faithful "dead process" than an invented large
// number, whose out-of-range signal may not surface as ESRCH.
async function spawnAndReapPid(): Promise<number> {
  const child = Bun.spawn({ cmd: [process.execPath, '-e', ''], stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  await child.exited
  return child.pid
}
