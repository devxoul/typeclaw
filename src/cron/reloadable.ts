import type { SubagentRegistry } from '@/agent/subagents'
import type { Reloadable, ReloadResult } from '@/reload'

import { loadCron } from './index'
import type { JobDiff, Scheduler } from './scheduler'
import type { CronJob, HandlerJob, ParsedCronJob } from './schema'

export type CreateCronReloadableOptions = {
  cwd: string
  scheduler: Scheduler
  // Internal jobs (e.g. dreaming) survive cron.json reloads. The reloadable
  // recomputes them on every reload so config-driven changes propagate too.
  internalJobs?: () => CronJob[]
  // Resolved per reload so plugin reloads (registered earlier) are visible
  // when cron re-validates job.subagent references.
  getSubagents?: () => SubagentRegistry
}

export function createCronReloadable({
  cwd,
  scheduler,
  internalJobs,
  getSubagents,
}: CreateCronReloadableOptions): Reloadable {
  return {
    scope: 'cron',
    description: 'cron jobs from cron.json',
    reload: async () => doReload({ cwd, scheduler, internalJobs, getSubagents }),
  }
}

async function doReload({
  cwd,
  scheduler,
  internalJobs,
  getSubagents,
}: CreateCronReloadableOptions): Promise<ReloadResult> {
  const subagents = getSubagents?.()
  const loaded = await loadCron(cwd, { mode: 'boot', ...(subagents !== undefined ? { subagents } : {}) })
  if (!loaded.ok) {
    return { scope: 'cron', ok: false, reason: loaded.reason }
  }
  const warnings = loaded.warnings ?? []
  for (const warning of warnings) {
    console.error(`[cron] skipped invalid job on reload: ${warning.reason}`)
  }
  const userJobs = loaded.file?.jobs ?? []

  // Wipe-guard: refuse a reload that would drop every user job *because they
  // failed to parse* (not because the file was intentionally emptied) while a
  // schedule is live, so a fat-fingered edit can't silently wipe running crons.
  // A valid empty file has no warnings and passes through as intentional
  // deletion. The live user-job baseline comes from the scheduler (single
  // source of truth) minus the internal/plugin jobs, which are always present
  // and must not count as "user jobs exist".
  const internalIds = new Set((internalJobs?.() ?? []).map((job) => job.id))
  const liveUserJobCount = scheduler.currentJobs().filter((job) => !internalIds.has(job.id)).length
  if (warnings.length > 0 && userJobs.length === 0 && liveUserJobCount > 0) {
    const reason = warnings.map((w) => w.reason).join('; ')
    return {
      scope: 'cron',
      ok: false,
      reason: `every configured user cron job is invalid; live schedule preserved: ${reason}`,
    }
  }

  const nextJobs: CronJob[] = [...userJobs, ...(internalJobs?.() ?? [])]

  let diff: JobDiff
  try {
    diff = scheduler.replaceJobs(nextJobs)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { scope: 'cron', ok: false, reason: `apply failed (schedule unchanged): ${message}` }
  }

  return { scope: 'cron', ok: true, summary: formatSummary(diff, nextJobs.length), details: plainDiff(diff) }
}

// `details` lands in the reload tool result, which pi structuredClones on every
// later request in that session. A plugin handler job's function would make
// that clone throw DataCloneError and wedge the session, so details carry data only.
type CronJobData = ParsedCronJob | Omit<HandlerJob, 'handler'>
type CronReloadDetails = Record<keyof JobDiff, CronJobData[]>

function plainDiff(diff: JobDiff): CronReloadDetails {
  const plain = (jobs: CronJob[]): CronJobData[] =>
    jobs.map((job) => {
      if (job.kind !== 'handler') return job
      const { handler: _handler, ...data } = job
      return data
    })
  return {
    added: plain(diff.added),
    removed: plain(diff.removed),
    updated: plain(diff.updated),
    unchanged: plain(diff.unchanged),
  }
}

function formatSummary(diff: JobDiff, total: number): string {
  return `${total} jobs (added ${diff.added.length}, removed ${diff.removed.length}, updated ${diff.updated.length}, unchanged ${diff.unchanged.length})`
}
