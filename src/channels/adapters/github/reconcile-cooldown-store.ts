import { randomUUID } from 'node:crypto'
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
//
// A launch marker is a reservation owned by one replay attempt (`replayId`).
// The attempt keeps it once the router durably admits the replay, and rolls
// back only its own reservation when the replay was never admitted, so a later
// pass retries the PR instead of losing it for a whole cooldown window.

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
  // The attempt that owns this launch reservation. Markers written before
  // reservations had owners omit it: they keep their cooldown meaning, and no
  // attempt's rollback can remove them.
  replayId?: string
}

export type ReconcileReplayReservation = {
  readonly replayId: string
}

export type ReconcileReplayOptions = {
  now: number
  cooldownMs: number
  // The reconcile pass runs detached from its adapter lifecycle. Once this
  // flips, the replay this reservation would guard is never dispatched.
  isCancelled?: () => boolean
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
  // Snapshot as of this instance's most recent read or write of the file. It
  // can be stale across store instances, so it must not decide a launch; only
  // markReplayed's serialized check against the latest file does.
  isCoolingDown: (repo: string, prId: number, now: number, cooldownMs: number) => boolean
  // Persists a launch reservation BEFORE the synthetic inbound is routed: a
  // crash between reserving and session creation must not re-trigger a replay
  // on the next restart. Resolves null without launching when the latest
  // persisted marker is still cooling down (another attempt holds it), or when
  // `isCancelled` flipped — a reservation written before the cancellation was
  // observed is rolled back inside the same serialized write. Rejects when the
  // reservation could not be persisted; the caller must not route then.
  markReplayed: (
    repo: string,
    prId: number,
    options: ReconcileReplayOptions,
  ) => Promise<ReconcileReplayReservation | null>
  // Releases a reservation whose replay was not durably admitted. Removes the
  // marker only while it is still owned by `replayId`, so an older attempt
  // settling late never erases a newer attempt's reservation. Rejects when the
  // release could not be persisted: the cooldown then still stands.
  rollbackReplay: (repo: string, prId: number, replayId: string) => Promise<void>
  // Unconditionally forgets the PR's marker, whichever attempt owns it.
  clear: (repo: string, prId: number) => Promise<void>
  prune: (repo: string, openPrIds: ReadonlySet<number>, now: number) => Promise<void>
}

// One mutation lane per cooldown file, shared by every store instance in this
// process. A stopped adapter's detached pass and its replacement hold separate
// instances of the same file; each mutation re-reads the file inside the lane
// and applies only its own change, so no instance rewrites the file from a
// stale snapshot, erases another attempt's reservation, or races another write
// on the shared tmp path. Lane tasks do file I/O only — never await a router
// receipt — so a replacement store load queued behind them waits for writes,
// not for pending routing.
const fileLanes = new Map<string, Promise<void>>()

function onFileLane<T>(path: string, task: () => Promise<T>): Promise<T> {
  const result = (fileLanes.get(path) ?? Promise.resolve()).then(task)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  fileLanes.set(path, tail)
  void tail.then(() => {
    if (fileLanes.get(path) === tail) fileLanes.delete(path)
  })
  return result
}

export async function loadReconcileCooldownStore(
  agentDir: string,
  logger: ReconcileCooldownLogger = consoleLogger,
): Promise<ReconcileCooldownStore> {
  const path = reconcileCooldownPath(agentDir)
  let markers = await onFileLane(path, async () => {
    try {
      return await readMarkers(path, logger)
    } catch (err) {
      logger.error(`[github] ${path} unreadable: ${describeError(err)}; starting fresh`)
      return new Map<string, ReconcileMarker>()
    }
  })

  // Lane-only helpers. `latest` refreshes this instance's view from disk and
  // hands back a working copy; `persist` publishes the copy once it is on disk.
  // A mutation that fails before the rename leaves the file and view unchanged.
  const latest = async (): Promise<Map<string, ReconcileMarker>> => {
    markers = await readMarkers(path, logger)
    return new Map(markers)
  }
  const persist = async (next: Map<string, ReconcileMarker>): Promise<void> => {
    await writeMarkers(path, next)
    markers = next
  }

  return {
    isCoolingDown(repo, prId, now, cooldownMs): boolean {
      const marker = markers.get(markerKey(repo, prId))
      if (marker === undefined) return false
      return now - marker.lastReplayAt < cooldownMs
    },
    markReplayed(repo, prId, { now, cooldownMs, isCancelled }): Promise<ReconcileReplayReservation | null> {
      return onFileLane(path, async () => {
        const next = await latest()
        if (isCancelled?.() === true) return null
        const key = markerKey(repo, prId)
        const previous = next.get(key)
        if (previous !== undefined && now - previous.lastReplayAt < cooldownMs) return null
        const replayId = randomUUID()
        next.set(key, { repo, prId, lastReplayAt: now, replayId })
        await persist(next)
        if (isCancelled?.() !== true) return { replayId }
        const restored = new Map(next)
        if (previous === undefined) restored.delete(key)
        else restored.set(key, previous)
        try {
          await persist(restored)
        } catch (err) {
          throw new Error(`cancelled replay reservation was not rolled back: ${describeError(err)}`, { cause: err })
        }
        return null
      })
    },
    rollbackReplay(repo, prId, replayId): Promise<void> {
      return onFileLane(path, async () => {
        const next = await latest()
        const key = markerKey(repo, prId)
        if (next.get(key)?.replayId !== replayId) return
        next.delete(key)
        await persist(next)
      })
    },
    clear(repo, prId): Promise<void> {
      return onFileLane(path, async () => {
        const next = await latest()
        if (!next.delete(markerKey(repo, prId))) return
        await persist(next)
      })
    },
    async prune(repo, openPrIds, now): Promise<void> {
      try {
        await onFileLane(path, async () => {
          const next = await latest()
          let changed = false
          for (const [key, marker] of next) {
            const stale = now - marker.lastReplayAt >= MARKER_RETENTION_MS
            const closed = marker.repo === repo && !openPrIds.has(marker.prId)
            if (stale || closed) {
              next.delete(key)
              changed = true
            }
          }
          if (changed) await persist(next)
        })
      } catch (err) {
        logger.error(`[github] failed to persist reconcile cooldown: ${describeError(err)}`)
      }
    },
  }
}

async function writeMarkers(path: string, markers: ReadonlyMap<string, ReconcileMarker>): Promise<void> {
  const payload: FileV1 = { version: FILE_VERSION, markers: Array.from(markers.values()) }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

// A missing file is an empty store and unparseable content is replaced on the
// next write, but any other read failure throws: a mutation that treated an
// unreadable file as empty would overwrite every other PR's marker.
async function readMarkers(path: string, logger: ReconcileCooldownLogger): Promise<Map<string, ReconcileMarker>> {
  const markers = new Map<string, ReconcileMarker>()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return markers
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.error(`[github] ${path} corrupted: ${describeError(err)}; starting fresh`)
    return markers
  }
  if (!isObject(parsed)) {
    logger.warn(`[github] ${path} not an object; ignored`)
    return markers
  }
  if (parsed.version !== FILE_VERSION) {
    logger.warn(`[github] ${path} version ${String(parsed.version)} not supported (expected ${FILE_VERSION}); ignored`)
    return markers
  }
  if (!Array.isArray(parsed.markers)) return markers
  for (const entry of parsed.markers) {
    const marker = parseMarker(entry)
    if (marker !== null) markers.set(markerKey(marker.repo, marker.prId), marker)
  }
  return markers
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseMarker(v: unknown): ReconcileMarker | null {
  if (!isObject(v)) return null
  const { repo, prId, lastReplayAt, replayId } = v
  if (typeof repo !== 'string' || typeof prId !== 'number' || typeof lastReplayAt !== 'number') return null
  if (replayId === undefined) return { repo, prId, lastReplayAt }
  return typeof replayId === 'string' ? { repo, prId, lastReplayAt, replayId } : null
}
