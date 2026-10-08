import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundObligationStore } from './background-obligations'
import { LIVE_TURN_ENDED_NOTICE_TEXT, RECOVERY_NOTICE_TEXT } from './continuity-types'
import { createRecoveryNotice } from './recovery-notice'
import { RecoveryOutbox } from './recovery-outbox'
const target = { adapter: 'discord-bot' as const, workspace: 'w', chat: 'c', thread: 't' }
const acceptance = { taskId: 'task', parentSessionId: 'parent', target, accountIdentity: 'actor' }
test('completion never resurrects, captured generations fence outcomes and application receipts repair idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obligation-'))
  try {
    const store = new BackgroundObligationStore(dir, { epoch: 'one' })
    expect(await store.resultReady({ parentSessionId: 'parent', taskId: 'missing' })).toBeUndefined()
    const accepted = await store.accept(acceptance)
    await expect(store.claim([accepted], { turnId: 'turn', target })).rejects.toThrow('coverage')
    const ready = (await store.resultReady(accepted.obligationId))!
    const decision = { transitionId: 'claim', decisionDigest: 'exact-claim' }
    const claimed = await store.claim([ready], { turnId: 'turn', target }, decision)
    expect(await store.claim([ready], { turnId: 'turn', target }, decision)).toEqual(claimed)
    await expect(store.claim([accepted], { turnId: 'other', target })).rejects.toThrow('coverage')
    await expect(store.settle([accepted], { kind: 'delivered', decisionId: 'stale' })).rejects.toThrow('coverage')
    const moved = await store.move(
      claimed,
      { fromTurnId: 'turn', turnId: 'turn', ownerSessionId: 'successor', target },
      { transitionId: 'move', decisionDigest: 'exact-move' },
    )
    await expect(store.claim([ready], { turnId: 'turn', target }, decision)).rejects.toThrow('superseded')
    expect((await store.get(accepted.obligationId))?.claim?.ownerSessionId).toBe('successor')
    await store.settle(moved, { kind: 'delivered', decisionId: 'reply' })
    await store.settle(moved, { kind: 'delivered', decisionId: 'reply' })
    await expect(store.claim([ready], { turnId: 'turn', target }, decision)).rejects.toThrow('superseded')
    await expect(
      store.move(
        claimed,
        { fromTurnId: 'turn', turnId: 'turn', ownerSessionId: 'successor', target },
        { transitionId: 'move', decisionDigest: 'exact-move' },
      ),
    ).rejects.toThrow('superseded')
    expect((await store.get(accepted.obligationId))?.phase).toBe('closed')
    expect(await store.resultReady(accepted.obligationId)).toBeUndefined()
    expect((await store.accept(acceptance)).phase).toBe('closed')
    expect((await store.get(accepted.obligationId))?.applications.map((r) => r.transitionId).slice(1)).toEqual([
      'claim',
      'move',
      'reply',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('failed persistence freezes dependent progress without inventing outcomes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obligation-freeze-'))
  try {
    let fail = false
    const store = new BackgroundObligationStore(dir, {
      onDurability: (phase) => {
        if (fail && phase === 'temp-synced') throw new Error('disk unavailable')
      },
    })
    const row = await store.accept(acceptance)
    fail = true
    await expect(store.settle([row], { kind: 'delivered', decisionId: 'reply' })).rejects.toThrow('disk unavailable')
    await expect(store.resultReady(row.obligationId)).rejects.toThrow('frozen')
    expect((await store.get(row.obligationId))?.phase).toBe('accepted')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
for (const boundary of ['temp-synced', 'replaced', 'directory-synced', 'notice-prepared', 'notice-owned'])
  test(`independent process death at ${boundary} preserves owed work and stable notice across two reboots`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'obligation-death-'))
    try {
      const source = new URL('./background-obligations.ts', import.meta.url).href
      const outboxSource = new URL('./recovery-outbox.ts', import.meta.url).href
      const worker = join(dir, 'worker.ts')
      await writeFile(
        worker,
        `import {BackgroundObligationStore} from ${JSON.stringify(source)}; import {RecoveryOutbox} from ${JSON.stringify(outboxSource)};
const boundary=${JSON.stringify(boundary)},pause=async(point)=>{console.log(JSON.stringify({boundary:point}));await Bun.stdin.text();throw Error('crash boundary resumed without termination');};
const store=new BackgroundObligationStore(${JSON.stringify(dir)},{epoch:'dead',onDurability:async(phase,row)=>{if(row.phase==='result-ready' && phase===boundary)await pause(phase)}});
const accepted=await store.accept(${JSON.stringify(acceptance)});const row=await store.resultReady(accepted.obligationId);
const prepared=await store.prepareNotice(row.obligationId,row.generation);if(boundary==='notice-prepared')await pause('notice-prepared');
const outbox=new RecoveryOutbox(${JSON.stringify(dir)},{epoch:'dead'});await outbox.import(prepared.transfer);await store.ownNotice(prepared.obligationId,prepared.generation,prepared.transfer.deliveryId);
if(boundary==='notice-owned')await pause('notice-owned');throw Error('crash boundary not reached');`,
      )
      const child = Bun.spawn([process.execPath, worker], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      const reader = child.stdout.getReader()
      try {
        const ready = await reader.read()
        expect(ready.done).toBe(false)
        expect(JSON.parse(new TextDecoder().decode(ready.value))).toEqual({ boundary })
        child.kill('SIGKILL')
        expect(await child.exited).not.toBe(0)
        expect(await new Response(child.stderr).text()).toBe('')
        // Windows TerminateProcess does not expose POSIX signal metadata.
        if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
      } finally {
        child.kill('SIGKILL')
        await child.exited
        reader.releaseLock()
      }
      const next = new BackgroundObligationStore(dir, { epoch: 'boot-two' }),
        outbox = new RecoveryOutbox(dir, { epoch: 'boot-two' })
      await next.importOldEpoch(outbox)
      const notices = await outbox.list()
      expect(notices.map((r) => r.state)).toEqual(['pending'])
      const sourceRow = (await next.list())[0]!
      expect(sourceRow.phase).toBe('notice-owned')
      expect(await next.validateNotice(notices[0]!)).toBe('open')
      await expect(next.validateNotice({ ...notices[0]!, accountIdentity: 'other' })).rejects.toThrow('conflicts')
      await expect(
        next.validateNotice({
          ...notices[0]!,
          covers: notices[0]!.covers.map((cover) => ({ ...cover, generation: cover.generation + 1 })),
        }),
      ).rejects.toThrow('ownership')
      const third = new BackgroundObligationStore(dir, { epoch: 'boot-three' })
      await third.importOldEpoch(outbox)
      expect((await outbox.list()).map((r) => r.deliveryId)).toEqual([notices[0]!.deliveryId])
      const lease = await outbox.lease(notices[0]!.deliveryId, 1)
      await outbox.delivered(notices[0]!.deliveryId, lease!, { confirmedAt: 3 })
      await third.importOldEpoch(outbox)
      expect((await third.get(sourceRow.obligationId))?.outcome?.kind).toBe('delivered')
      expect(await third.validateNotice(notices[0]!)).toBe('resolved')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

test('source suppression closes captured notice coverage before outbox propagation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obligation-suppression-'))
  try {
    const store = new BackgroundObligationStore(dir, { epoch: 'old' })
    const accepted = await store.accept(acceptance)
    const prepared = (await store.prepareNotice(accepted.obligationId, accepted.generation))!
    const outbox = new RecoveryOutbox(dir, { epoch: 'old' })
    const notice = await outbox.import(prepared.transfer!)
    await store.ownNotice(prepared.obligationId, prepared.generation, notice.deliveryId)
    await store.suppressNoticeCoverage(notice, { decisionId: 'stop', reason: 'Explicit stop' })
    expect((await outbox.get(notice.deliveryId))?.state).toBe('pending')
    expect((await store.get(accepted.obligationId))?.outcome).toEqual({
      kind: 'intentionally-suppressed',
      decisionId: 'stop',
      reason: 'Explicit stop',
      deliveryId: notice.deliveryId,
    })
    expect(await store.validateNotice(notice)).toBe('resolved')
    const reboot = new BackgroundObligationStore(dir, { epoch: 'new' })
    await reboot.importOldEpoch(outbox)
    expect(await reboot.validateNotice(notice)).toBe('resolved')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const malformed of ['zero-generation', 'future-generation', 'duplicate-transition']) {
  test(`malformed durable ${malformed} receipt cannot grant claim ownership`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'obligation-corruption-'))
    try {
      const store = new BackgroundObligationStore(dir)
      const accepted = await store.accept(acceptance)
      const ready = (await store.resultReady(accepted.obligationId))!
      const path = join(dir, 'channels/background-obligations', `${accepted.obligationId}.json`)
      const row = JSON.parse(await readFile(path, 'utf8'))
      if (malformed === 'zero-generation') {
        row.applications[0].expectedGeneration = 0
        row.applications[0].resultingGeneration = 1
      } else if (malformed === 'future-generation') {
        row.applications[0].expectedGeneration = row.generation
        row.applications[0].resultingGeneration = row.generation + 1
      } else {
        row.applications.push({ ...row.applications[0] })
      }
      const bytes = JSON.stringify(row)
      await writeFile(path, bytes)
      await expect(store.claim([ready], { turnId: 'turn', target })).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(bytes)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('parent/task lookups are indexed, keep closed tombstones authoritative, and never resurrect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obligation-index-'))
  try {
    const store = new BackgroundObligationStore(dir, { epoch: 'one' })
    const accepted = await store.accept(acceptance)
    const other = { ...target, chat: 'other-room' }
    const sibling = await store.accept({ ...acceptance, parentSessionId: 'sibling', target: other })
    expect((await store.lookup('parent', 'task'))?.obligationId).toBe(accepted.obligationId)
    expect((await store.lookup('sibling', 'task'))?.obligationId).toBe(sibling.obligationId)
    expect(await store.lookup('parent', 'missing')).toBeUndefined()
    expect(await store.lookup('stranger', 'task')).toBeUndefined()
    // A successor on the same destination resolves the predecessor's task; another destination cannot.
    expect((await store.lookupTask('task', target))?.obligationId).toBe(accepted.obligationId)
    expect((await store.lookupTask('task', other))?.obligationId).toBe(sibling.obligationId)
    expect(await store.lookupTask('task', { ...target, thread: 'elsewhere' })).toBeUndefined()
    // Rows written by another instance in this process stay visible.
    const late = await new BackgroundObligationStore(dir, { epoch: 'one' }).accept({ ...acceptance, taskId: 'late' })
    expect((await store.lookup('parent', 'late'))?.obligationId).toBe(late.obligationId)
    const after = await store.accept({ ...acceptance, taskId: 'after-index' })
    expect((await store.lookup('parent', 'after-index'))?.obligationId).toBe(after.obligationId)
    // Lookups read exact candidates, not the directory: an unreadable unrelated row cannot fail them.
    await writeFile(join(dir, 'channels/background-obligations', `${'f'.repeat(64)}.json`), '{corrupt')
    await expect(store.list()).rejects.toThrow()
    expect((await store.lookup('parent', 'task'))?.obligationId).toBe(accepted.obligationId)
    // A closed row stays the task's authority: late completion and re-acceptance cannot reopen it.
    const ready = (await store.resultReady({ parentSessionId: 'parent', taskId: 'task' }))!
    await store.settle([ready], { kind: 'delivered', decisionId: 'answered' })
    expect(await store.lookup('parent', 'task')).toMatchObject({ phase: 'closed' })
    expect(await store.resultReady({ parentSessionId: 'parent', taskId: 'task' })).toBeUndefined()
    expect((await store.accept(acceptance)).phase).toBe('closed')
    // The acceptance identity fence still rejects another author for the same task.
    await expect(store.accept({ ...acceptance, triggeringAuthorId: 'intruder' })).rejects.toThrow(
      'Conflicting background acceptance',
    )
    expect(await store.lookup('parent', 'task')).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'delivered', decisionId: 'answered' },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('notice preparation freezes its cause: restart stays the default v1 transfer, live-turn-ended is distinct', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obligation-cause-'))
  try {
    const store = new BackgroundObligationStore(dir, { epoch: 'one' })
    const restartRow = await store.accept(acceptance)
    const liveRow = await store.accept({ ...acceptance, taskId: 'live' })
    const restart = (await store.prepareNotice(restartRow.obligationId, restartRow.generation))!.transfer!
    const live = (await store.prepareNotice(liveRow.obligationId, liveRow.generation, 'live-turn-ended'))!.transfer!
    expect(restart).toMatchObject({ schemaVersion: 1, text: RECOVERY_NOTICE_TEXT })
    expect('cause' in restart).toBe(false)
    expect(restart).toEqual(
      createRecoveryNotice({
        target,
        accountIdentity: 'actor',
        principal: restartRow.principal,
        covers: [{ store: 'background', id: restartRow.obligationId, generation: 2, parentSessionId: 'parent' }],
        recoveryGeneration: `${restartRow.obligationId}:2`,
        transferId: restart.transferId,
        sourceParentSessionId: 'parent',
        createdAt: restart.createdAt,
      }),
    )
    expect(live).toMatchObject({ schemaVersion: 2, cause: 'live-turn-ended', text: LIVE_TURN_ENDED_NOTICE_TEXT })
    // Frozen at preparation: a later request with another cause returns the original transfer.
    expect((await store.prepareNotice(liveRow.obligationId, liveRow.generation))!.transfer).toEqual(live)
    expect(
      (await store.prepareNotice(restartRow.obligationId, restartRow.generation, 'live-turn-ended'))!.transfer,
    ).toEqual(restart)
    // Boot recovery re-imports each frozen transfer unchanged.
    const outbox = new RecoveryOutbox(dir, { epoch: 'reboot' })
    await new BackgroundObligationStore(dir, { epoch: 'reboot' }).importOldEpoch(outbox)
    expect((await outbox.list()).map((record) => record.deliveryId).sort()).toEqual(
      [restart.deliveryId, live.deliveryId].sort(),
    )
    expect(await outbox.get(live.deliveryId)).toEqual(live)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
