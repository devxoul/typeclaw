import { readdirSync, readFileSync, statfsSync } from 'node:fs'

import { readOomEvents, unclaimedOomEvents, type OomEventsReader } from '@/container/oom-events'

const BYTES_PER_MB = 1024 * 1024

export type ResourceSample = {
  rssBytes: number
  shmUsedBytes: number | null
  shmTotalBytes: number | null
  detachedProcesses: number | null
}

// Processes reparented to PID 1 inside the container: anything the agent
// detached on purpose (a tmux server, a background dev server) plus anything
// left behind by a call that died. This count is the cheapest signal that
// something is accumulating across a container's life, and unlike
// /proc/<pid>/environ it is readable regardless of the per-tool sandbox's child
// user namespace — /proc/<pid>/stat is world-readable, environ is not.
export function countDetachedProcesses(procRoot = '/proc', selfPid = process.pid): number | null {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return null
  }

  let count = 0
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    // PID 1 is the init shim itself, never its own orphan.
    if (pid === 1) continue
    // The agent runtime is itself a child of the init shim: the container runs
    // with `--init` and the entrypoint execs Bun, so the agent normally sits at
    // PID 2 with PPID 1. Counting it would give every clean container a
    // permanent floor of 1 and bury the first real orphan in the noise.
    if (pid === selfPid) continue
    let raw: string
    try {
      raw = readFileSync(`${procRoot}/${entry}/stat`, 'utf8')
    } catch {
      // The process exited between readdir and read. Normal, not an error.
      continue
    }
    if (parsePpidFromStat(raw) === 1) count++
  }
  return count
}

// `/proc/<pid>/stat` is `pid (comm) state ppid ...`, and `comm` is the raw
// executable name — it can contain spaces AND parentheses, so neither a plain
// whitespace split nor a search for the FIRST ')' is correct. The kernel's own
// documented parse is to seek the LAST ')' and read fields after it, which is
// what this does: field 0 is state, field 1 is ppid.
export function parsePpidFromStat(raw: string): number | null {
  const close = raw.lastIndexOf(')')
  if (close < 0) return null
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const ppid = Number(fields[1])
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null
}

export function readShmUsage(path = '/dev/shm'): { usedBytes: number; totalBytes: number } | null {
  try {
    const fs = statfsSync(path)
    const totalBytes = fs.blocks * fs.bsize
    const usedBytes = (fs.blocks - fs.bfree) * fs.bsize
    return { usedBytes, totalBytes }
  } catch {
    return null
  }
}

export function collectResourceSample(
  options: { procRoot?: string; shmPath?: string; selfPid?: number } = {},
): ResourceSample {
  const shm = readShmUsage(options.shmPath)
  return {
    rssBytes: process.memoryUsage().rss,
    shmUsedBytes: shm?.usedBytes ?? null,
    shmTotalBytes: shm?.totalBytes ?? null,
    detachedProcesses: countDetachedProcesses(options.procRoot, options.selfPid),
  }
}

export function formatResourceSample(sample: ResourceSample): string {
  const mb = (bytes: number | null): string => (bytes === null ? '?' : String(Math.round(bytes / BYTES_PER_MB)))
  return [
    `rss_mb=${mb(sample.rssBytes)}`,
    `shm_used_mb=${mb(sample.shmUsedBytes)}`,
    `shm_total_mb=${mb(sample.shmTotalBytes)}`,
    `detached_procs=${sample.detachedProcesses ?? '?'}`,
  ].join(' ')
}

export type SampleWatermark = {
  rssBytes: number
  shmUsedBytes: number
  detachedProcesses: number
  emittedAt: number
}

// Emit on growth, not on a clock.
//
// A steady heartbeat drowns the signal in identical lines and still misses the
// moment a number moved, while emitting every sample makes a 14-day log mostly
// noise. A leak is precisely a sequence of new high-water marks, so emitting
// only when one is set — with a margin so ordinary churn stays quiet — turns the
// log into the growth curve an OOM post-mortem actually needs. The periodic
// floor keeps a flat container from going completely silent, which is itself
// evidence.
export const RSS_GROWTH_MARGIN_BYTES = 128 * BYTES_PER_MB
export const SHM_GROWTH_MARGIN_BYTES = 64 * BYTES_PER_MB
export const HEARTBEAT_MS = 30 * 60 * 1000

export function shouldEmitSample(previous: SampleWatermark | null, sample: ResourceSample, now: number): boolean {
  if (previous === null) return true
  if (now - previous.emittedAt >= HEARTBEAT_MS) return true
  if (sample.rssBytes >= previous.rssBytes + RSS_GROWTH_MARGIN_BYTES) return true
  if ((sample.shmUsedBytes ?? 0) >= previous.shmUsedBytes + SHM_GROWTH_MARGIN_BYTES) return true
  if ((sample.detachedProcesses ?? 0) > previous.detachedProcesses) return true
  return false
}

export function nextWatermark(previous: SampleWatermark | null, sample: ResourceSample, now: number): SampleWatermark {
  return {
    rssBytes: Math.max(previous?.rssBytes ?? 0, sample.rssBytes),
    shmUsedBytes: Math.max(previous?.shmUsedBytes ?? 0, sample.shmUsedBytes ?? 0),
    detachedProcesses: Math.max(previous?.detachedProcesses ?? 0, sample.detachedProcesses ?? 0),
    emittedAt: now,
  }
}

export const SAMPLE_INTERVAL_MS = 60_000

export type ResourceSamplerOptions = {
  intervalMs?: number
  collect?: () => ResourceSample
  emit?: (line: string) => void
  now?: () => number
  readOomEvents?: OomEventsReader
}

// Returns a stop function rather than running forever so the caller owns the
// lifetime. `unref` keeps a container that is otherwise done from being held
// open by the sampler alone.
export function startResourceSampler(options: ResourceSamplerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS
  const collect = options.collect ?? (() => collectResourceSample())
  const emit = options.emit ?? ((line: string) => console.info(line))
  const now = options.now ?? (() => Date.now())
  const readEvents = options.readOomEvents ?? readOomEvents
  let previousOomEvents = readEvents()

  let watermark: SampleWatermark | null = null
  const tick = (): void => {
    try {
      const currentOomEvents = readEvents()
      if (currentOomEvents !== null) {
        const events = previousOomEvents === null ? null : unclaimedOomEvents(previousOomEvents, currentOomEvents)
        previousOomEvents = currentOomEvents
        if (events !== null) {
          const pressure = events.reachedLimit
            ? 'container reached its memory limit'
            : 'no container memory-limit event recorded (possible Docker VM/ancestor pressure)'
          emit(
            `[resource] OOM kill observed (oom_kill ${events.from}→${events.to}); runtime survived — a subprocess was killed; ${pressure}` +
              (events.claimed.length === 0 ? '' : `; claimed by ${events.claimed.join(', ')}`),
          )
        }
      }
      const sample = collect()
      const at = now()
      if (!shouldEmitSample(watermark, sample, at)) return
      watermark = nextWatermark(watermark, sample, at)
      emit(`[resource-sample] ${formatResourceSample(sample)}`)
    } catch (err) {
      // A sampler must never be able to take the agent down.
      emit(`[resource-sample] failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
