import { describe, expect, test, vi } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import {
  collectResourceSample,
  countDetachedProcesses,
  formatResourceSample,
  HEARTBEAT_MS,
  nextWatermark,
  parsePpidFromStat,
  type ResourceSample,
  RSS_GROWTH_MARGIN_BYTES,
  shouldEmitSample,
  startResourceSampler,
  type SampleWatermark,
} from './resource-sample'

const MB = 1024 * 1024

function sample(overrides: Partial<ResourceSample> = {}): ResourceSample {
  return {
    rssBytes: 100 * MB,
    shmUsedBytes: 10 * MB,
    shmTotalBytes: 2048 * MB,
    detachedProcesses: 2,
    ...overrides,
  }
}

function watermark(overrides: Partial<SampleWatermark> = {}): SampleWatermark {
  return { rssBytes: 100 * MB, shmUsedBytes: 10 * MB, detachedProcesses: 2, emittedAt: 1_000, ...overrides }
}

describe('parsePpidFromStat', () => {
  test('reads ppid from an ordinary record', () => {
    expect(parsePpidFromStat('42 (bash) S 1 42 42 0 -1 4194304')).toBe(1)
  })

  test('survives a comm containing spaces and parentheses', () => {
    // given an executable literally named `weird ) name`, which breaks both a
    // whitespace split and a search for the first ')'
    expect(parsePpidFromStat('42 (weird ) name) S 7 42 42')).toBe(7)
  })

  test('returns null for a malformed record', () => {
    expect(parsePpidFromStat('nonsense')).toBeNull()
    expect(parsePpidFromStat('')).toBeNull()
  })
})

describe('countDetachedProcesses', () => {
  let root: string

  async function writeProc(pid: string, ppid: number, comm = 'proc'): Promise<void> {
    await mkdir(join(root, pid), { recursive: true })
    await writeFile(join(root, pid, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1`)
  }

  test('counts only processes reparented to PID 1', async () => {
    root = await mkdtemp(join(tmpdir(), 'typeclaw-proc-'))
    try {
      // given one orphaned tmux server, one orphaned browser, and one ordinary
      // child of a live shell
      await writeProc('1', 0, 'init')
      await writeProc('100', 1, 'tmux: server')
      await writeProc('101', 1, 'chrome')
      await writeProc('102', 100, 'bash')
      await mkdir(join(root, 'self'), { recursive: true })

      expect(await countDetachedProcesses(root, 999)).toBe(2)
    } finally {
      await rmTempDir(root)
    }
  })

  test('excludes the agent itself, which is a child of the init shim', async () => {
    root = await mkdtemp(join(tmpdir(), 'typeclaw-proc-'))
    try {
      // given a container as it actually boots: docker-init at PID 1, the agent
      // exec'd at PID 2 with PPID 1, and ONE genuine orphan
      await writeProc('1', 0, 'docker-init')
      await writeProc('2', 1, 'bun')
      await writeProc('50', 1, 'sleep')

      // then a clean container reports the orphan only, not a permanent
      // floor of 1 caused by counting the agent
      expect(await countDetachedProcesses(root, 2)).toBe(1)
    } finally {
      await rmTempDir(root)
    }
  })

  test('reports zero for a container with no orphans at all', async () => {
    root = await mkdtemp(join(tmpdir(), 'typeclaw-proc-'))
    try {
      await writeProc('1', 0, 'docker-init')
      await writeProc('2', 1, 'bun')

      expect(await countDetachedProcesses(root, 2)).toBe(0)
    } finally {
      await rmTempDir(root)
    }
  })

  test('returns null when /proc cannot be read', () => {
    expect(countDetachedProcesses(join(tmpdir(), 'typeclaw-proc-does-not-exist'))).toBeNull()
  })
})

describe('shouldEmitSample', () => {
  test('always emits the first sample', () => {
    expect(shouldEmitSample(null, sample(), 0)).toBe(true)
  })

  test('stays quiet when nothing grew', () => {
    expect(shouldEmitSample(watermark(), sample(), 2_000)).toBe(false)
  })

  test('emits on a new rss high-water mark beyond the margin', () => {
    const grown = sample({ rssBytes: 100 * MB + RSS_GROWTH_MARGIN_BYTES })

    expect(shouldEmitSample(watermark(), grown, 2_000)).toBe(true)
  })

  test('ignores ordinary rss churn below the margin', () => {
    const churn = sample({ rssBytes: 120 * MB })

    expect(shouldEmitSample(watermark(), churn, 2_000)).toBe(false)
  })

  test('emits on any new detached process, with no margin', () => {
    // given one more process reparented to init than we have ever seen —
    // a leak is counted in processes, so there is no noise floor to absorb
    const grown = sample({ detachedProcesses: 3 })

    expect(shouldEmitSample(watermark(), grown, 2_000)).toBe(true)
  })

  test('emits a heartbeat so a flat container is not silent', () => {
    expect(shouldEmitSample(watermark(), sample(), 1_000 + HEARTBEAT_MS)).toBe(true)
  })
})

describe('nextWatermark', () => {
  test('only ever rises', () => {
    const previous = watermark({ rssBytes: 500 * MB, detachedProcesses: 9 })

    const next = nextWatermark(previous, sample({ rssBytes: 10 * MB, detachedProcesses: 1 }), 5_000)

    expect(next.rssBytes).toBe(500 * MB)
    expect(next.detachedProcesses).toBe(9)
    expect(next.emittedAt).toBe(5_000)
  })

  test('treats an unreadable reading as zero rather than a drop to unknown', () => {
    const next = nextWatermark(null, sample({ shmUsedBytes: null, detachedProcesses: null }), 0)

    expect(next.shmUsedBytes).toBe(0)
    expect(next.detachedProcesses).toBe(0)
  })
})

describe('formatResourceSample', () => {
  test('renders every field in megabytes', () => {
    expect(formatResourceSample(sample())).toBe('rss_mb=100 shm_used_mb=10 shm_total_mb=2048 detached_procs=2')
  })

  test('renders unreadable values as ? rather than zero', () => {
    const line = formatResourceSample(sample({ shmUsedBytes: null, shmTotalBytes: null, detachedProcesses: null }))

    expect(line).toContain('shm_used_mb=?')
    expect(line).toContain('detached_procs=?')
  })
})

describe('startResourceSampler', () => {
  test('emits growth and suppresses flat samples', async () => {
    const lines: string[] = []
    let rss = 100 * MB
    let clock = 0
    const stop = startResourceSampler({
      intervalMs: 1,
      collect: () => sample({ rssBytes: rss }),
      emit: (line) => lines.push(line),
      now: () => clock,
    })
    try {
      await Bun.sleep(20)
      const afterFlat = lines.length
      rss = 100 * MB + RSS_GROWTH_MARGIN_BYTES * 2
      clock += 1
      await Bun.sleep(20)

      // the first sample always lands, flat samples add nothing, and growth
      // produces exactly one more line
      expect(afterFlat).toBe(1)
      expect(lines.length).toBe(2)
      expect(lines[0]).toContain('[resource-sample]')
    } finally {
      stop()
    }
  })

  test('logs unclaimed container-limit and external-pressure kills separately, never flat/unreadable counters', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let counter: { oom: number; oomKill: number } | null = { oom: 2, oomKill: 2 }
    const stop = startResourceSampler({
      intervalMs: 2,
      collect: () => sample(),
      readOomEvents: () => counter,
      emit: (line) => lines.push(line),
    })
    try {
      vi.advanceTimersByTime(2)
      counter = { oom: 3, oomKill: 3 }
      vi.advanceTimersByTime(2)
      counter = null
      vi.advanceTimersByTime(2)
      counter = { oom: 3, oomKill: 3 }
      vi.advanceTimersByTime(2)
      counter = { oom: 3, oomKill: 4 }
      vi.advanceTimersByTime(2)
      expect(lines.filter((line) => line.includes('OOM kill observed'))).toEqual([
        '[resource] OOM kill observed (oom_kill 2→3); runtime survived — a subprocess was killed; container reached its memory limit',
        '[resource] OOM kill observed (oom_kill 3→4); runtime survived — a subprocess was killed; no container memory-limit event recorded (possible Docker VM/ancestor pressure)',
      ])
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  test('never throws out of a failing collect', async () => {
    const lines: string[] = []
    const stop = startResourceSampler({
      intervalMs: 1,
      collect: () => {
        throw new Error('proc unreadable')
      },
      emit: (line) => lines.push(line),
    })
    try {
      await Bun.sleep(20)
      expect(lines.some((line) => line.includes('failed: proc unreadable'))).toBe(true)
    } finally {
      stop()
    }
  })
})

describe('collectResourceSample', () => {
  test('always reports a real rss even when proc and shm are unreadable', () => {
    const result = collectResourceSample({
      procRoot: join(tmpdir(), 'typeclaw-proc-missing'),
      shmPath: join(tmpdir(), 'typeclaw-shm-missing'),
    })

    expect(result.rssBytes).toBeGreaterThan(0)
    expect(result.detachedProcesses).toBeNull()
    expect(result.shmUsedBytes).toBeNull()
  })
})
