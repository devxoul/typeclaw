import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Reloadable, ReloadResult } from '@/reload'

import { createCronReloadable } from './reloadable'
import type { JobDiff, Scheduler } from './scheduler'
import type { CronJob } from './schema'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cron-reload-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

function recordingScheduler(): Scheduler & { replacements: CronJob[][] } {
  const replacements: CronJob[][] = []
  let live: CronJob[] = []
  return {
    replacements,
    start: () => {},
    stop: () => {},
    replaceJobs: (jobs) => {
      replacements.push([...jobs])
      live = [...jobs]
      return { added: jobs, removed: [], updated: [], unchanged: [] } as JobDiff
    },
    currentJobs: () => live,
  }
}

function failingScheduler(error: Error): Scheduler {
  return {
    start: () => {},
    stop: () => {},
    replaceJobs: () => {
      throw error
    },
    currentJobs: () => [],
  }
}

async function asFailure(r: Promise<ReloadResult>): Promise<Extract<ReloadResult, { ok: false }>> {
  const result = await r
  if (result.ok) throw new Error(`expected failure, got: ${JSON.stringify(result)}`)
  return result
}

async function asSuccess(r: Promise<ReloadResult>): Promise<Extract<ReloadResult, { ok: true }>> {
  const result = await r
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`)
  return result
}

describe('createCronReloadable', () => {
  test('exposes scope=cron with a description', () => {
    const reloadable: Reloadable = createCronReloadable({ cwd: agentDir, scheduler: recordingScheduler() })
    expect(reloadable.scope).toBe('cron')
    expect(reloadable.description).toMatch(/cron/i)
  })

  test('reloads from cron.json and replaces jobs in the scheduler', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]?.map((j) => j.id)).toEqual(['a'])
    expect(result.summary).toMatch(/added 1/)
  })

  test('absent cron.json is treated as zero jobs (still reloads)', async () => {
    const scheduler = recordingScheduler()
    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toEqual([[]])
    expect(result.summary).toMatch(/0 jobs/)
  })

  test('does NOT touch the scheduler when cron.json has invalid JSON', async () => {
    const scheduler = recordingScheduler()
    await writeFile(join(agentDir, 'cron.json'), '{ not valid json')

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asFailure(reloadable.reload())

    expect(scheduler.replacements).toEqual([])
    expect(result.reason).toMatch(/cron\.json/i)
  })

  test('does NOT touch the scheduler when cron.json fails schema validation', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'bad id with spaces', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asFailure(reloadable.reload())

    expect(scheduler.replacements).toEqual([])
    expect(result.reason).toMatch(/id/i)
  })

  test('isolates a job with an invalid cron expression and applies the rest (per-job survivability)', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [
          { id: 'good', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' },
          { id: 'bad', schedule: 'not-a-cron', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' },
        ],
      }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]?.map((j) => j.id)).toEqual(['good'])
  })

  test('isolates a duplicate id, keeps the first occurrence, and applies the rest', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [
          { id: 'dup', schedule: '* * * * *', kind: 'prompt', prompt: 'a', scheduledByRole: 'owner' },
          { id: 'dup', schedule: '0 * * * *', kind: 'prompt', prompt: 'b', scheduledByRole: 'owner' },
        ],
      }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]?.map((j) => j.id)).toEqual(['dup'])
  })

  test('still fails closed on file-level errors (invalid JSON already covered; top-level schema)', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'ok', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }, 42],
      }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    await asFailure(reloadable.reload())

    expect(scheduler.replacements).toEqual([])
  })

  test('preserves the live schedule when every user job is now invalid (no accidental wipe)', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'good', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )
    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    await asSuccess(reloadable.reload())
    expect(scheduler.replacements).toHaveLength(1)

    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'broken', schedule: 'not-a-cron', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )
    const result = await asFailure(reloadable.reload())

    expect(result.reason).toMatch(/not-a-cron/)
    expect(scheduler.replacements).toHaveLength(1)
  })

  test('a valid empty file is an intentional deletion and applies zero jobs (not a wipe-guard)', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'good', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )
    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    await asSuccess(reloadable.reload())

    await writeFile(join(agentDir, 'cron.json'), JSON.stringify({ jobs: [] }))
    await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(2)
    expect(scheduler.replacements[1]).toEqual([])
  })

  test('all-invalid user jobs still apply when nothing was running before (no schedule to preserve)', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'broken', schedule: 'not-a-cron', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]).toEqual([])
  })

  test('the wipe-guard still applies plugin jobs are unaffected: internal jobs survive a preserved reload', async () => {
    const scheduler = recordingScheduler()
    const internal: CronJob = {
      id: '__internal_test_job',
      schedule: '0 4 * * *',
      enabled: true,
      kind: 'prompt',
      prompt: '(internal)',
      subagent: 'dreaming',
      payload: { agentDir: '/x' },
    }
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'good', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )
    const reloadable = createCronReloadable({ cwd: agentDir, scheduler, internalJobs: () => [internal] })
    await asSuccess(reloadable.reload())

    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'broken', schedule: 'not-a-cron', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )
    await asFailure(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
  })

  test('returns an ok=false result when scheduler.replaceJobs throws (belt-and-suspenders)', async () => {
    const scheduler = failingScheduler(new Error('apply blew up'))
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asFailure(reloadable.reload())

    expect(result.reason).toMatch(/apply blew up/)
  })

  test('merges internalJobs() with user jobs on reload', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'user-job', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      }),
    )
    const internal: CronJob = {
      id: '__internal_test_job',
      schedule: '0 4 * * *',
      enabled: true,
      kind: 'prompt',
      prompt: '(internal)',
      subagent: 'dreaming',
      payload: { agentDir: '/x' },
    }

    const reloadable = createCronReloadable({
      cwd: agentDir,
      scheduler,
      internalJobs: () => [internal],
    })
    await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]?.map((j) => j.id)).toEqual(['user-job', '__internal_test_job'])
  })

  test('absent cron.json with internalJobs() still hands the internal jobs to the scheduler', async () => {
    const scheduler = recordingScheduler()
    const internal: CronJob = {
      id: '__internal_test_job',
      schedule: '0 4 * * *',
      enabled: true,
      kind: 'prompt',
      prompt: '(internal)',
      subagent: 'dreaming',
      payload: { agentDir: '/x' },
    }

    const reloadable = createCronReloadable({
      cwd: agentDir,
      scheduler,
      internalJobs: () => [internal],
    })
    const result = await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]?.map((j) => j.id)).toEqual(['__internal_test_job'])
    expect(result.summary).toMatch(/added 1/)
  })

  test('summary describes added/removed/updated/unchanged counts', async () => {
    let diff: JobDiff = { added: [], removed: [], updated: [], unchanged: [] }
    const scheduler: Scheduler = {
      start: () => {},
      stop: () => {},
      replaceJobs: () => diff,
      currentJobs: () => [],
    }
    diff = {
      added: [job('a')],
      removed: [job('r')],
      updated: [job('u'), job('u2')],
      unchanged: [job('k1'), job('k2'), job('k3')],
    }
    await writeFile(join(agentDir, 'cron.json'), JSON.stringify({ jobs: [] }))

    const result = await asSuccess(createCronReloadable({ cwd: agentDir, scheduler }).reload())

    expect(result.summary).toContain('added 1')
    expect(result.summary).toContain('removed 1')
    expect(result.summary).toContain('updated 2')
    expect(result.summary).toContain('unchanged 3')
  })

  test('details include the diff for downstream consumption', async () => {
    const scheduler: Scheduler = {
      start: () => {},
      stop: () => {},
      replaceJobs: () => ({
        added: [job('new')],
        removed: [],
        updated: [],
        unchanged: [],
      }),
      currentJobs: () => [],
    }
    await writeFile(join(agentDir, 'cron.json'), JSON.stringify({ jobs: [] }))

    const result = await asSuccess(createCronReloadable({ cwd: agentDir, scheduler }).reload())

    const details = result.details as { added: { id: string }[] }
    expect(details.added.map((j) => j.id)).toEqual(['new'])
  })

  test('details stay structured-cloneable when plugin handler jobs are in the diff', async () => {
    // The reload tool puts details into the session transcript, which pi
    // structuredClones before every provider request.
    const handlerJob: CronJob = {
      id: 'memory-dreaming',
      schedule: '*/30 * * * *',
      kind: 'handler',
      enabled: true,
      handler: async () => {},
    }
    const scheduler: Scheduler = {
      start: () => {},
      stop: () => {},
      replaceJobs: () => ({
        added: [handlerJob],
        removed: [handlerJob],
        updated: [handlerJob],
        unchanged: [handlerJob],
      }),
      currentJobs: () => [],
    }
    await writeFile(join(agentDir, 'cron.json'), JSON.stringify({ jobs: [] }))

    const result = await asSuccess(createCronReloadable({ cwd: agentDir, scheduler }).reload())

    const cloned = structuredClone(result.details) as Record<string, unknown[]>
    for (const key of ['added', 'removed', 'updated', 'unchanged']) {
      expect(cloned[key]).toEqual([{ id: 'memory-dreaming', schedule: '*/30 * * * *', kind: 'handler', enabled: true }])
    }
  })
})

function job(id: string): CronJob {
  return { id, schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: true }
}
