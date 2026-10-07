import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_RECONCILE_COOLDOWN_MS,
  loadReconcileCooldownStore,
  reconcileCooldownPath,
  type ReconcileCooldownStore,
} from './reconcile-cooldown-store'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const REPO = 'acme/widgets'
const WINDOW = DEFAULT_RECONCILE_COOLDOWN_MS

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'reconcile-cooldown-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

function reserve(store: ReconcileCooldownStore, prId: number, now: number, isCancelled?: () => boolean) {
  return store.markReplayed(REPO, prId, { now, cooldownMs: WINDOW, isCancelled })
}

async function coolingAfterReload(prId: number, now = 1_001, repo = REPO): Promise<boolean> {
  const reloaded = await loadReconcileCooldownStore(agentDir, silentLogger)
  return reloaded.isCoolingDown(repo, prId, now, WINDOW)
}

// A directory at the tmp path makes every write fail until it is removed.
function blockWrites(): () => Promise<void> {
  const tmp = `${reconcileCooldownPath(agentDir)}.tmp`
  mkdirSync(join(tmp, 'occupied'), { recursive: true })
  return () => rm(tmp, { recursive: true, force: true })
}

describe('ReconcileCooldownStore', () => {
  test('a fresh store reports no PR as cooling down', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(store.isCoolingDown(REPO, 700, 1_000, WINDOW)).toBe(false)
  })

  test('a reservation cools its PR down for the window and only then can be reserved again', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    const first = await reserve(store, 700, 1_000)
    expect(first).not.toBeNull()
    expect(store.isCoolingDown(REPO, 700, 1_000 + WINDOW - 1, WINDOW)).toBe(true)
    expect(store.isCoolingDown(REPO, 700, 1_000 + WINDOW, WINDOW)).toBe(false)

    expect(await reserve(store, 700, 1_000 + WINDOW - 1)).toBeNull()
    const second = await reserve(store, 700, 1_000 + WINDOW)
    expect(second).not.toBeNull()
    expect(second!.replayId).not.toBe(first!.replayId)
  })

  test('reservations survive a reload and are keyed per repo and per PR id', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await reserve(store, 700, 5_000)

    expect(await coolingAfterReload(700, 5_001)).toBe(true)
    expect(await coolingAfterReload(700, 5_001, 'acme/other')).toBe(false)
    expect(await coolingAfterReload(701, 5_001)).toBe(false)
  })

  test('a store loaded before another instance reserved cannot reserve the same PR again', async () => {
    // given two store instances loaded before either reserves (stale adapter + replacement)
    const stale = await loadReconcileCooldownStore(agentDir, silentLogger)
    const replacement = await loadReconcileCooldownStore(agentDir, silentLogger)

    // when both reserve PR 700 concurrently
    const results = await Promise.all([reserve(stale, 700, 1_000), reserve(replacement, 700, 1_000)])

    // then exactly one attempt may launch
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    // and a later reservation from the stale snapshot is refused too
    expect(await reserve(stale, 700, 1_002)).toBeNull()
    expect(await reserve(replacement, 700, 1_002)).toBeNull()
  })

  test('rollbackReplay durably releases the attempt that owns the reservation', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    const reservation = await reserve(store, 700, 1_000)

    await store.rollbackReplay(REPO, 700, reservation!.replayId)

    expect(store.isCoolingDown(REPO, 700, 1_001, WINDOW)).toBe(false)
    expect(await coolingAfterReload(700)).toBe(false)
    expect(await reserve(store, 700, 1_001)).not.toBeNull()
  })

  test("an older attempt's rollback preserves a newer reservation for the same PR at the same timestamp", async () => {
    // given an old attempt that reserved PR 700 at t=1000
    const old = await loadReconcileCooldownStore(agentDir, silentLogger)
    const oldReservation = await reserve(old, 700, 1_000)

    // and a replacement lifecycle that cleared it (draft conversion) and
    // re-reserved the same PR on the same clock reading
    const replacement = await loadReconcileCooldownStore(agentDir, silentLogger)
    await replacement.clear(REPO, 700)
    const newReservation = await reserve(replacement, 700, 1_000)
    expect(newReservation).not.toBeNull()

    // when the old attempt fails late and rolls back from its stale instance
    await old.rollbackReplay(REPO, 700, oldReservation!.replayId)

    // then the newer reservation still stands, on disk and for its owner
    expect(await coolingAfterReload(700, 1_000)).toBe(true)
    expect(old.isCoolingDown(REPO, 700, 1_000, WINDOW)).toBe(true)
    await replacement.rollbackReplay(REPO, 700, newReservation!.replayId)
    expect(await coolingAfterReload(700, 1_000)).toBe(false)
  })

  test('clear removes only the target PR marker, whichever attempt owns it', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await reserve(store, 700, 1_000)
    await reserve(store, 701, 1_000)
    await store.markReplayed('acme/other', 700, { now: 1_000, cooldownMs: WINDOW })
    const other = await loadReconcileCooldownStore(agentDir, silentLogger)

    await other.clear(REPO, 700)

    expect(await coolingAfterReload(700)).toBe(false)
    expect(await coolingAfterReload(701)).toBe(true)
    expect(await coolingAfterReload(700, 1_001, 'acme/other')).toBe(true)
  })

  test('concurrent mutations from separate instances keep every marker and leave a valid file', async () => {
    const a = await loadReconcileCooldownStore(agentDir, silentLogger)
    const b = await loadReconcileCooldownStore(agentDir, silentLogger)
    const seeded = await reserve(a, 999, 1_000)

    const ids = Array.from({ length: 12 }, (_, i) => 100 + i)
    await Promise.all([
      ...ids.map((id, i) => reserve(i % 2 === 0 ? a : b, id, 1_000)),
      b.rollbackReplay(REPO, 999, seeded!.replayId),
    ])

    for (const id of ids) expect(await coolingAfterReload(id)).toBe(true)
    expect(await coolingAfterReload(999)).toBe(false)
    const parsed = JSON.parse(await readFile(reconcileCooldownPath(agentDir), 'utf8')) as {
      version: number
      markers: Array<{ prId: number }>
    }
    expect(parsed.version).toBe(1)
    expect(parsed.markers.map((m) => m.prId).sort((x, y) => x - y)).toEqual(ids)
  })

  test('a reservation cancelled before it is written leaves no marker', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(await reserve(store, 700, 1_000, () => true)).toBeNull()
    expect(await coolingAfterReload(700)).toBe(false)
  })

  test('cancellation observed once the marker is on disk rolls it back before a replacement store loads', async () => {
    // given a pass whose adapter stops right after its marker reached disk
    const stale = await loadReconcileCooldownStore(agentDir, silentLogger)
    let loading: Promise<ReconcileCooldownStore> | undefined

    // when a replacement adapter starts loading at that moment
    const marking = reserve(stale, 700, 1_000, () => {
      if (!readMarkerFile().includes('"prId": 700')) return false
      loading ??= loadReconcileCooldownStore(agentDir, silentLogger)
      return true
    })

    // then the unlaunched replay left no cooldown for the replacement or a reload
    expect(await marking).toBeNull()
    expect(loading).toBeDefined()
    expect((await loading!).isCoolingDown(REPO, 700, 1_001, WINDOW)).toBe(false)
    expect(await coolingAfterReload(700)).toBe(false)
  })

  test('a cancelled reservation that cannot be rolled back rejects instead of claiming release', async () => {
    // given a pass whose adapter stops right after its marker reached disk, at
    // a moment the rollback write cannot persist
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    let unblock: (() => Promise<void>) | undefined
    const marking = reserve(store, 700, 1_000, () => {
      if (!readMarkerFile().includes('"prId": 700')) return false
      unblock ??= blockWrites()
      return true
    })

    // then the failure surfaces and the reservation is still in force
    await expect(marking).rejects.toThrow('not rolled back')
    expect(await coolingAfterReload(700)).toBe(true)
    await unblock!()
  })

  test('a failed reservation write throws and leaves no cooldown', async () => {
    await writeFile(join(agentDir, 'channels'), 'not a directory', 'utf8')
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)

    await expect(reserve(store, 700, 1_000)).rejects.toThrow()
    expect(store.isCoolingDown(REPO, 700, 1_000, WINDOW)).toBe(false)
  })

  test('a failed rollback rejects and the cooldown still stands until a rollback persists', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    const reservation = await reserve(store, 700, 1_000)
    const unblock = blockWrites()

    await expect(store.rollbackReplay(REPO, 700, reservation!.replayId)).rejects.toThrow()
    expect(store.isCoolingDown(REPO, 700, 1_001, WINDOW)).toBe(true)
    expect(await coolingAfterReload(700)).toBe(true)

    await unblock()
    await store.rollbackReplay(REPO, 700, reservation!.replayId)
    expect(await coolingAfterReload(700)).toBe(false)
  })

  test('prune drops markers for PRs no longer open in that repo only', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await reserve(store, 700, 1_000)
    await reserve(store, 800, 1_000)
    await store.markReplayed('acme/other', 700, { now: 1_000, cooldownMs: WINDOW })

    await store.prune(REPO, new Set([800]), 2_000)

    expect(await coolingAfterReload(700, 2_000)).toBe(false)
    expect(await coolingAfterReload(800, 2_000)).toBe(true)
    expect(await coolingAfterReload(700, 2_000, 'acme/other')).toBe(true)
  })

  test('prune drops markers older than the retention window even if still open', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await reserve(store, 700, 0)
    const wayLater = 8 * 24 * 60 * 60 * 1000
    await store.prune(REPO, new Set([700]), wayLater)
    expect(await coolingAfterReload(700, 1)).toBe(false)
  })

  test('prune from a stale instance neither resurrects a released marker nor erases a newer one', async () => {
    // given a stale instance that saw reservations for 600, 700 and 800
    const stale = await loadReconcileCooldownStore(agentDir, silentLogger)
    await reserve(stale, 600, 1_000)
    const released = await reserve(stale, 700, 1_000)
    await reserve(stale, 800, 1_000)
    // and another instance that released 700 and reserved 900 afterwards
    const current = await loadReconcileCooldownStore(agentDir, silentLogger)
    await current.rollbackReplay(REPO, 700, released!.replayId)
    await reserve(current, 900, 1_000)

    // when the stale instance prunes after PR 600 closed
    await stale.prune(REPO, new Set([700, 800, 900]), 2_000)

    // then only the closed PR's marker is dropped from the latest state
    expect(await coolingAfterReload(600)).toBe(false)
    expect(await coolingAfterReload(700)).toBe(false)
    expect(await coolingAfterReload(800)).toBe(true)
    expect(await coolingAfterReload(900)).toBe(true)
  })

  test('a version-1 marker written before reservations had owners keeps its cooldown', async () => {
    // given a file written by a release that predates replay ownership
    await mkdir(join(agentDir, 'channels'), { recursive: true })
    const legacy = { repo: REPO, prId: 700, lastReplayAt: 1_000 }
    await writeFile(reconcileCooldownPath(agentDir), JSON.stringify({ version: 1, markers: [legacy] }), 'utf8')
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)

    // then it still cools the PR down and no attempt's rollback removes it
    expect(store.isCoolingDown(REPO, 700, 1_001, WINDOW)).toBe(true)
    expect(await reserve(store, 700, 1_001)).toBeNull()
    const fresh = await reserve(store, 701, 1_001)
    await store.rollbackReplay(REPO, 700, fresh!.replayId)
    expect(await coolingAfterReload(700)).toBe(true)

    // and new writes stay version 1 with the legacy marker unchanged
    const parsed = JSON.parse(await readFile(reconcileCooldownPath(agentDir), 'utf8')) as {
      version: number
      markers: Array<Record<string, unknown>>
    }
    expect(parsed.version).toBe(1)
    expect(parsed.markers).toContainEqual(legacy)
    expect(parsed.markers).toContainEqual({ repo: REPO, prId: 701, lastReplayAt: 1_001, replayId: fresh!.replayId })

    // while the intentional unconditional clear still removes it
    await store.clear(REPO, 700)
    expect(await coolingAfterReload(700)).toBe(false)
  })

  test('a corrupted store file is ignored and starts fresh', async () => {
    await mkdir(join(agentDir, 'channels'), { recursive: true })
    await writeFile(reconcileCooldownPath(agentDir), '{ not json', 'utf8')
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(store.isCoolingDown(REPO, 700, 1_000, WINDOW)).toBe(false)
    expect(await reserve(store, 700, 1_000)).not.toBeNull()
    expect(await coolingAfterReload(700)).toBe(true)
  })

  test('an unknown file version is ignored', async () => {
    await mkdir(join(agentDir, 'channels'), { recursive: true })
    await writeFile(
      reconcileCooldownPath(agentDir),
      JSON.stringify({ version: 999, markers: [{ repo: REPO, prId: 700, lastReplayAt: 1_000 }] }),
      'utf8',
    )
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(store.isCoolingDown(REPO, 700, 1_000, WINDOW)).toBe(false)
  })
})

function readMarkerFile(): string {
  try {
    return readFileSync(reconcileCooldownPath(agentDir), 'utf8')
  } catch {
    return ''
  }
}
