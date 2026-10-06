import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_RECONCILE_COOLDOWN_MS,
  loadReconcileCooldownStore,
  reconcileCooldownPath,
} from './reconcile-cooldown-store'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'reconcile-cooldown-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('ReconcileCooldownStore', () => {
  test('a fresh store reports no PR as cooling down', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(store.isCoolingDown('acme/widgets', 700, 1_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
  })

  test('a marked PR cools down within the window and clears after it', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await store.markReplayed('acme/widgets', 700, 1_000)
    expect(
      store.isCoolingDown(
        'acme/widgets',
        700,
        1_000 + DEFAULT_RECONCILE_COOLDOWN_MS - 1,
        DEFAULT_RECONCILE_COOLDOWN_MS,
      ),
    ).toBe(true)
    expect(
      store.isCoolingDown('acme/widgets', 700, 1_000 + DEFAULT_RECONCILE_COOLDOWN_MS, DEFAULT_RECONCILE_COOLDOWN_MS),
    ).toBe(false)
  })

  test('cancellation during the marker write rolls it back before a replacement store loads', async () => {
    // given a pass whose adapter stops while its marker write is in flight
    const stale = await loadReconcileCooldownStore(agentDir, silentLogger)
    let loading: ReturnType<typeof loadReconcileCooldownStore> | undefined

    // when a replacement adapter loads the store once the marker is on disk but
    // before the stale pass has observed its cancellation
    const marking = stale.markReplayed('acme/widgets', 700, 1_000, () => {
      loading = loadReconcileCooldownStore(agentDir, silentLogger)
      return true
    })
    const replacement = await marking.then(() => loading!)

    // then the unlaunched replay left no cooldown, so it can still be replayed
    expect(await marking).toBe(false)
    expect(replacement.isCoolingDown('acme/widgets', 700, 1_001, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
    const reloaded = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(reloaded.isCoolingDown('acme/widgets', 700, 1_001, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
  })

  test('an uncancelled marker write reports the marker as kept', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(await store.markReplayed('acme/widgets', 700, 1_000, () => false)).toBe(true)
    expect(store.isCoolingDown('acme/widgets', 700, 1_001, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(true)
  })

  test('markers survive a reload (persist to disk)', async () => {
    const first = await loadReconcileCooldownStore(agentDir, silentLogger)
    await first.markReplayed('acme/widgets', 700, 5_000)

    const reloaded = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(reloaded.isCoolingDown('acme/widgets', 700, 5_000 + 1, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(true)
  })

  test('markers are keyed per repo and per PR id', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await store.markReplayed('acme/widgets', 700, 1_000)
    expect(store.isCoolingDown('acme/other', 700, 1_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
    expect(store.isCoolingDown('acme/widgets', 701, 1_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
  })

  test('clear removes only the target PR marker and persists the removal', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await store.markReplayed('acme/widgets', 700, 1_000)
    await store.markReplayed('acme/widgets', 701, 1_000)
    await store.markReplayed('acme/other', 700, 1_000)

    await store.clear('acme/widgets', 700)

    const reloaded = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(reloaded.isCoolingDown('acme/widgets', 700, 1_001, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
    expect(reloaded.isCoolingDown('acme/widgets', 701, 1_001, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(true)
    expect(reloaded.isCoolingDown('acme/other', 700, 1_001, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(true)
  })

  test('prune drops markers for PRs no longer open in that repo', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await store.markReplayed('acme/widgets', 700, 1_000)
    await store.markReplayed('acme/widgets', 800, 1_000)
    await store.prune('acme/widgets', new Set([800]), 2_000)
    expect(store.isCoolingDown('acme/widgets', 700, 2_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
    expect(store.isCoolingDown('acme/widgets', 800, 2_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(true)
  })

  test('prune does not touch markers from other repos', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await store.markReplayed('acme/widgets', 700, 1_000)
    await store.markReplayed('acme/other', 700, 1_000)
    await store.prune('acme/widgets', new Set<number>(), 2_000)
    expect(store.isCoolingDown('acme/other', 700, 2_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(true)
  })

  test('prune drops markers older than the retention window even if still open', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await store.markReplayed('acme/widgets', 700, 0)
    const wayLater = 8 * 24 * 60 * 60 * 1000
    await store.prune('acme/widgets', new Set([700]), wayLater)
    expect(store.isCoolingDown('acme/widgets', 700, wayLater, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
  })

  test('a corrupted store file is ignored and starts fresh', async () => {
    await writeFile(reconcileCooldownPath(agentDir).replace(/[^/]+$/, ''), '', 'utf8').catch(() => {})
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(agentDir, 'channels'), { recursive: true })
    await writeFile(reconcileCooldownPath(agentDir), '{ not json', 'utf8')
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(store.isCoolingDown('acme/widgets', 700, 1_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
  })

  test('an unknown file version is ignored', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(agentDir, 'channels'), { recursive: true })
    await writeFile(
      reconcileCooldownPath(agentDir),
      JSON.stringify({ version: 999, markers: [{ repo: 'acme/widgets', prId: 700, lastReplayAt: 1_000 }] }),
      'utf8',
    )
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    expect(store.isCoolingDown('acme/widgets', 700, 1_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
  })

  test('markReplayed rolls back the in-memory marker and rethrows when the write fails', async () => {
    const { writeFile: realWriteFile } = await import('node:fs/promises')
    await realWriteFile(join(agentDir, 'channels'), 'not a directory', 'utf8')

    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    let threw = false
    try {
      await store.markReplayed('acme/widgets', 700, 1_000)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(store.isCoolingDown('acme/widgets', 700, 1_000, DEFAULT_RECONCILE_COOLDOWN_MS)).toBe(false)
  })

  test('the persisted file is valid JSON with a version and markers array', async () => {
    const store = await loadReconcileCooldownStore(agentDir, silentLogger)
    await store.markReplayed('acme/widgets', 700, 1_000)
    const raw = await readFile(reconcileCooldownPath(agentDir), 'utf8')
    const parsed = JSON.parse(raw) as { version: number; markers: unknown[] }
    expect(parsed.version).toBe(1)
    expect(parsed.markers).toEqual([{ repo: 'acme/widgets', prId: 700, lastReplayAt: 1_000 }])
  })
})
