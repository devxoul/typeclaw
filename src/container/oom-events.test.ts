import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readMemoryLimitMiB, readOomEvents, toolOomNote, unclaimedOomEvents } from './oom-events'

describe('cgroup OOM evidence', () => {
  test('reads both v2 counters, rejecting missing, malformed and v1 files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oom-events-'))
    try {
      const events = join(dir, 'memory.events')
      const limit = join(dir, 'memory.max')
      writeFileSync(events, 'low 0\noom 3\noom_kill 2\noom_group_kill 0\n')
      writeFileSync(limit, String(512 * 1048576))
      expect(readOomEvents(events)).toEqual({ oom: 3, oomKill: 2 })
      expect(readMemoryLimitMiB(limit)).toBe(512)
      writeFileSync(limit, 'max')
      expect(readMemoryLimitMiB(limit)).toBeNull()
      writeFileSync(events, 'oom_kill 2\n')
      expect(readOomEvents(events)).toBeNull()
      expect(readOomEvents(join(dir, 'missing'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('labels a concurrent container-limit event and kill without identifying a victim', () => {
    const lines: string[] = []
    const before = { oom: 3, oomKill: 4 }
    const note = toolOomNote(before, 137, 'bash', {
      read: () => ({ oom: 4, oomKill: 5 }),
      limitMiB: () => 512,
      log: (s) => lines.push(s),
    })
    expect(note).toContain('OOM kill was observed while this command ran')
    expect(note).toContain('container reached its memory limit (512 MiB)')
    expect(lines).toEqual([
      '[tool] bash subprocess SIGKILL; OOM kill observed while command ran; the container reached its memory limit (512 MiB)',
    ])
    expect(unclaimedOomEvents(before, { oom: 4, oomKill: 5 })).toBeNull()
  })

  test('a kill without container-limit evidence reports the configured limit, not that it was reached', () => {
    const lines: string[] = []
    const note = toolOomNote({ oom: 6, oomKill: 30 }, 137, 'plugin exec', {
      read: () => ({ oom: 6, oomKill: 31 }),
      limitMiB: () => 512,
      log: (s) => lines.push(s),
    })
    expect(note).toContain('without a container memory-limit event (configured limit 512 MiB)')
    expect(note).not.toContain('reached its memory limit')
    expect(lines).toEqual([
      '[tool] plugin exec subprocess SIGKILL; OOM kill observed while command ran; without a container memory-limit event (configured limit 512 MiB)',
    ])
  })

  test('a sampler tick preceding a tool completion emits only one operator line', () => {
    const before = { oom: 40, oomKill: 40 }
    expect(unclaimedOomEvents(before, { oom: 40, oomKill: 41 })).toEqual({
      from: 40,
      to: 41,
      claimed: [],
      reachedLimit: false,
    })
    const lines: string[] = []
    const note = toolOomNote(before, 137, 'cron exec', {
      read: () => ({ oom: 40, oomKill: 41 }),
      limitMiB: () => null,
      log: (s) => lines.push(s),
    })
    expect(note).toContain('OOM kill was observed')
    expect(lines).toEqual([])
  })

  test('unclaimed OOM events are reported alongside claimed tool kills', () => {
    const before = { oom: 20, oomKill: 20 }
    expect(
      toolOomNote(before, 137, 'cron exec', {
        read: () => ({ oom: 21, oomKill: 21 }),
        limitMiB: () => null,
      }),
    ).not.toBeNull()
    expect(unclaimedOomEvents(before, { oom: 21, oomKill: 22 })).toEqual({
      from: 20,
      to: 22,
      claimed: ['cron exec'],
      reachedLimit: true,
    })
  })

  test('unchanged, unreadable, and non-SIGKILL results do not infer an OOM', () => {
    const lines: string[] = []
    const before = { oom: 10, oomKill: 10 }
    const log = (s: string): void => {
      lines.push(s)
    }
    expect(toolOomNote(before, 137, 'bash', { read: () => before, log })).toBeNull()
    expect(toolOomNote(before, 137, 'bash', { read: () => null, log })).toBeNull()
    expect(toolOomNote(null, 137, 'bash', { read: () => ({ oom: 11, oomKill: 11 }), log })).toBeNull()
    expect(
      toolOomNote(before, 1, 'bash', {
        read: () => {
          throw new Error('unexpected read')
        },
        log,
      }),
    ).toBeNull()
    expect(lines).toEqual([])
    expect(unclaimedOomEvents(before, { oom: 10, oomKill: 11 })).toEqual({
      from: 10,
      to: 11,
      claimed: [],
      reachedLimit: false,
    })
  })
})
