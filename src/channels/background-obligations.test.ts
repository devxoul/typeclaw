import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundObligationStore } from './background-obligations'
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
