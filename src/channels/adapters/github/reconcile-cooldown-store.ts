import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { describeError } from '../../describe-error'
import { canonicalGithubRepo } from '../../github-repo'

// Durable per-PR replay cooldown for the open-PR reconcile pass.
//
// The reconcile pass (reconcile-open-prs.ts) runs on every adapter start() and
// replays every open PR that has no POSTED review yet. That predicate is wrong
// under two real conditions:
//   1. Review work happens in a subagent that a container restart can kill
//      before it posts — the PR still reads "unreviewed" and gets replayed on
//      the NEXT start, re-triggering the exact work the restart just lost.
//   2. `updatedAt`-keyed message dedup breaks the moment any activity bumps the
//      PR's updatedAt, so an in-progress review is replayed again.
// With a churning tunnel (cloudflare-quick mints a fresh URL every restart) the
// adapter restarts many times a day, turning a rare-event "floor" into a
// re-review storm.
//
// This store decouples replay eligibility from adapter lifecycle: a PR is
// replayed at most once per cooldown window, keyed by a durable
// `repo#prId` marker that survives restarts. A genuinely-missed `opened` is
// still recovered — the periodic reconcile tick retries after the cooldown
// expires — without a restart being required. The marker records when a replay
// was LAUNCHED (not when a review completed): posted-review suppression stays
// the authoritative "done" signal in reconcile-open-prs.ts; this store only
// bounds retry frequency.

const FILE_VERSION = 1

// A PR that still needs review is replayed at most once per this window. Long
// enough that ~20 restarts/day collapse to a single daily retry, short enough
// that an interrupted review is retried the same day.
export const DEFAULT_RECONCILE_COOLDOWN_MS = 24 * 60 * 60 * 1000

// Markers older than this are pruned on save even if their PR is still open, so
// a long-lived PR that was reviewed once cannot pin its marker forever. Any PR
// that still needs review re-earns a fresh marker on the next eligible tick.
const MARKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type ReconcileMarker = {
  repo: string
  prId: number
  lastReplayAt: number
}

type FileV1 = {
  version: 1
  markers: ReconcileMarker[]
}

export type ReconcileCooldownLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: ReconcileCooldownLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function reconcileCooldownPath(agentDir: string): string {
  return join(agentDir, 'channels', 'github-reconcile.json')
}

function markerKey(repo: string, prId: number): string {
  return `${canonicalGithubRepo(repo)}#${prId}`
}

export type ReconcileCooldownStore = {
  isCoolingDown: (repo: string, prId: number, now: number, cooldownMs: number) => boolean
  // Flush BEFORE routing the synthetic inbound: a crash between marking and
  // session creation must not re-trigger a replay on the next restart.
  // Resolves false when `isCancelled` flipped during the write; the marker is
  // then rolled back within the same tracked write, because the replay it
  // guarded will never be dispatched.
  markReplayed: (repo: string, prId: number, now: number, isCancelled?: () => boolean) => Promise<boolean>
  clear: (repo: string, prId: number) => Promise<void>
  prune: (repo: string, openPrIds: ReadonlySet<number>, now: number) => Promise<void>
}

// Writes in flight per cooldown file, shared across store instances. A stopped
// adapter's detached reconcile pass may still be persisting or rolling back a
// marker when a replacement adapter loads the file; loading waits for those
// writes (never for router receipts) so it can't read a marker about to vanish.
const pendingWrites = new Map<string, Set<Promise<unknown>>>()

function trackWrite<T>(path: string, write: Promise<T>): Promise<T> {
  let pending = pendingWrites.get(path)
  if (pending === undefined) {
    pending = new Set()
    pendingWrites.set(path, pending)
  }
  const settled = write.then(
    () => undefined,
    () => undefined,
  )
  pending.add(settled)
  void settled.then(() => {
    pending.delete(settled)
    if (pending.size === 0 && pendingWrites.get(path) === pending) pendingWrites.delete(path)
  })
  return write
}

export async function loadReconcileCooldownStore(
  agentDir: string,
  logger: ReconcileCooldownLogger = consoleLogger,
): Promise<ReconcileCooldownStore> {
  const path = reconcileCooldownPath(agentDir)
  await Promise.all(pendingWrites.get(path) ?? [])
  const markers = new Map<string, ReconcileMarker>()
  for (const marker of await readMarkers(path, logger)) {
    markers.set(markerKey(marker.repo, marker.prId), marker)
  }

  const flush = async (): Promise<void> => {
    const payload: FileV1 = { version: FILE_VERSION, markers: Array.from(markers.values()) }
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  return {
    isCoolingDown(repo, prId, now, cooldownMs): boolean {
      const marker = markers.get(markerKey(repo, prId))
      if (marker === undefined) return false
      return now - marker.lastReplayAt < cooldownMs
    },
    // Roll the in-memory marker back and rethrow if the disk write fails, so the
    // caller skips routing rather than replaying a PR with no durable record —
    // otherwise a restart would replay it immediately, defeating the cooldown.
    markReplayed(repo, prId, now, isCancelled): Promise<boolean> {
      const key = markerKey(repo, prId)
      const previous = markers.get(key)
      const restore = () => {
        if (previous === undefined) markers.delete(key)
        else markers.set(key, previous)
      }
      return trackWrite(
        path,
        (async () => {
          markers.set(key, { repo, prId, lastReplayAt: now })
          try {
            await flush()
          } catch (err) {
            restore()
            throw err
          }
          if (isCancelled?.() !== true) return true
          restore()
          await flush()
          return false
        })(),
      )
    },
    clear(repo, prId): Promise<void> {
      const key = markerKey(repo, prId)
      const previous = markers.get(key)
      if (previous === undefined) return Promise.resolve()
      return trackWrite(
        path,
        (async () => {
          markers.delete(key)
          try {
            await flush()
          } catch (err) {
            markers.set(key, previous)
            throw err
          }
        })(),
      )
    },
    async prune(repo, openPrIds, now): Promise<void> {
      let changed = false
      for (const [key, marker] of markers) {
        const stale = now - marker.lastReplayAt >= MARKER_RETENTION_MS
        const closed = marker.repo === repo && !openPrIds.has(marker.prId)
        if (stale || closed) {
          markers.delete(key)
          changed = true
        }
      }
      if (changed) {
        try {
          await trackWrite(path, flush())
        } catch (err) {
          logger.error(`[github] failed to persist reconcile cooldown: ${describeError(err)}`)
        }
      }
    },
  }
}

async function readMarkers(path: string, logger: ReconcileCooldownLogger): Promise<ReconcileMarker[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.error(`[github] ${path} corrupted: ${describeError(err)}; starting fresh`)
    return []
  }
  if (!isObject(parsed)) {
    logger.warn(`[github] ${path} not an object; ignored`)
    return []
  }
  const version = (parsed as { version?: unknown }).version
  if (version !== FILE_VERSION) {
    logger.warn(`[github] ${path} version ${String(version)} not supported (expected ${FILE_VERSION}); ignored`)
    return []
  }
  const file = parsed as FileV1
  if (!Array.isArray(file.markers)) return []
  return file.markers.filter(isValidMarker)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidMarker(v: unknown): v is ReconcileMarker {
  if (!isObject(v)) return false
  const r = v as Record<string, unknown>
  return typeof r.repo === 'string' && typeof r.prId === 'number' && typeof r.lastReplayAt === 'number'
}
