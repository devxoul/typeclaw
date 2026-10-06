import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseRecoveryRecord, recoveryDeliveryId, validateRecoveryRecord } from './continuity-types'
import type { RecoveryRecord } from './continuity-types'
import { createRecoveryNotice } from './recovery-notice'
import { RecoveryOutbox } from './recovery-outbox'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-outbox-'))
  directories.push(dir)
  return dir
}
function notice(): RecoveryRecord {
  return createRecoveryNotice({
    target: { adapter: 'slack-bot', workspace: 'w', chat: 'c', thread: 't' },
    accountIdentity: 'actor-1',
    principal: { kind: 'channel', adapter: 'slack-bot', workspace: 'w', chat: 'c', lastInboundAuthorId: 'human' },
    covers: [{ store: 'inventory', id: 'parent:inventory-generation:task', generation: 1, parentSessionId: 'parent' }],
    recoveryGeneration: 'inventory-generation:parent',
    transferId: 'transfer-1',
    createdAt: 100,
  })
}
async function crash(
  dir: string,
  record: RecoveryRecord,
  operation: 'import' | 'lease' | 'delivered',
  phase: 'temp-synced' | 'replaced' | 'directory-synced',
): Promise<void> {
  const source = `
    import { RecoveryOutbox } from ${JSON.stringify(new URL('./recovery-outbox.ts', import.meta.url).href)};
    const record = JSON.parse(process.env.RECORD);
    const operation = process.env.OPERATION;
    const store = new RecoveryOutbox(process.env.DIR, {epoch:'child', async onDurability(phase, value) {
      const expected = operation === 'import' ? 'pending' : operation === 'lease' ? 'leased' : 'delivered';
      if (phase === process.env.PHASE && value.state === expected) {
        console.log(JSON.stringify({operation,phase,state:value.state,deliveryId:value.deliveryId}));
        await Bun.stdin.text();
        throw new Error('crash boundary resumed without termination');
      }
    }});
    if (operation === 'import') await store.import(record);
    else { const lease = await store.lease(record.deliveryId, record.generation); if (!lease) throw new Error('missing lease'); if (operation === 'delivered') await store.delivered(record.deliveryId, lease, {confirmedAt:200,messageId:'remote-message'}); }
    throw new Error('crash boundary not reached');
  `
  const child = Bun.spawn([process.execPath, '-e', source], {
    env: { ...process.env, RECORD: JSON.stringify(record), DIR: dir, OPERATION: operation, PHASE: phase },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  try {
    const ready = await reader.read()
    expect(ready.done).toBe(false)
    expect(JSON.parse(new TextDecoder().decode(ready.value))).toEqual({
      operation,
      phase,
      state: operation === 'import' ? 'pending' : operation === 'lease' ? 'leased' : 'delivered',
      deliveryId: record.deliveryId,
    })
    child.kill('SIGKILL')
    const code = await child.exited
    expect(await new Response(child.stderr).text()).toBe('')
    expect(code).not.toBe(0)
    // Windows TerminateProcess has no POSIX signal metadata; the blocked boundary and hard kill remain mandatory.
    if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
  } finally {
    child.kill('SIGKILL')
    await child.exited
    reader.releaseLock()
  }
}

describe('recovery outbox durable ownership', () => {
  test('conflict diagnostics are strict immutable payload and survive first-lease binding', async () => {
    const dir = await directory()
    const record = createRecoveryNotice({
      ...notice(),
      accountIdentity: 'unbound-legacy',
      accountIdentityConflict: ['actor-A', 'actor-B'],
    })
    for (const conflict of [
      [],
      ['actor-A'],
      ['actor-B', 'actor-A'],
      ['actor-A', 'actor-A'],
      ['', 'actor-B'],
      ['actor-A', 'unbound-legacy'],
    ]) {
      expect(validateRecoveryRecord({ ...record, accountIdentityConflict: conflict })).toBe(false)
    }
    const bound = { ...record, accountIdentity: 'actor-A' }
    expect(validateRecoveryRecord({ ...bound, deliveryId: recoveryDeliveryId(bound) })).toBe(false)
    const store = new RecoveryOutbox(dir, { epoch: 'first' })
    await store.import(record)
    await expect(store.import({ ...record, accountIdentityConflict: ['actor-A', 'actor-C'] })).rejects.toThrow(
      'Conflicting recovery import',
    )
    await expect(store.import({ ...record, accountIdentityConflict: undefined })).rejects.toThrow(
      'Conflicting recovery import',
    )
    const lease = (await store.lease(record.deliveryId, 1))!
    expect(await store.bindAccount(record.deliveryId, lease, 'actor-C')).toBe(true)
    const reboot = new RecoveryOutbox(dir, { epoch: 'next' })
    const persisted = (await reboot.import(record))!
    expect(persisted.accountIdentityConflict).toEqual(['actor-A', 'actor-B'])
    expect(persisted.boundAccountIdentity).toBe('actor-C')
  })
  for (const phase of ['temp-synced', 'replaced', 'directory-synced'] as const) {
    test(`death during import at ${phase} repeats the same transfer`, async () => {
      const dir = await directory()
      const record = notice()
      await crash(dir, record, 'import', phase)
      const store = new RecoveryOutbox(dir, { epoch: 'boot-2' })
      const before = await store.get(record.deliveryId)
      expect(before?.state).toBe(phase === 'temp-synced' ? undefined : 'pending')
      expect(await store.import(record)).toEqual(record)
      const lease = await store.lease(record.deliveryId, 1)
      expect(lease).toBeDefined()
      expect(await store.delivered(record.deliveryId, lease!, { confirmedAt: 300 })).toBe(true)
      const reboot = new RecoveryOutbox(dir, { epoch: 'boot-3' })
      expect((await reboot.import(record)).state).toBe('delivered')
      expect(await reboot.lease(record.deliveryId, 2)).toBeUndefined()
    })
  }

  test('dead process lease is reclaimed; stale owner cannot acknowledge or fail', async () => {
    const dir = await directory()
    const record = notice()
    const first = new RecoveryOutbox(dir, { epoch: 'first' })
    await first.import(record)
    await crash(dir, record, 'lease', 'directory-synced')
    const dead = (await first.get(record.deliveryId))!
    expect(dead.state).toBe('leased')
    const reboot = new RecoveryOutbox(dir, { epoch: 'next' })
    expect(await reboot.lease(record.deliveryId, 1)).toBeUndefined()
    const lease = (await reboot.lease(record.deliveryId, dead.generation))!
    expect(lease.generation).toBe(dead.generation + 1)
    const stale = new RecoveryOutbox(dir, { epoch: 'child' })
    expect(await stale.delivered(record.deliveryId, dead.lease!, { confirmedAt: 400 })).toBe(false)
    expect(await stale.fail(record.deliveryId, dead.lease!, { kind: 'transient', safeReason: 'timeout' })).toBe(false)
    expect(await reboot.delivered(record.deliveryId, lease, { confirmedAt: 401 })).toBe(true)
  })

  test('same epoch concurrent requests never overlap dispatch leases', async () => {
    const dir = await directory()
    const record = notice()
    const one = new RecoveryOutbox(dir, { epoch: 'same' })
    const two = new RecoveryOutbox(dir, { epoch: 'same' })
    await one.import(record)
    const leases = await Promise.all([one.lease(record.deliveryId, 1), two.lease(record.deliveryId, 1)])
    expect(leases.filter(Boolean)).toHaveLength(1)
    expect(await two.lease(record.deliveryId, 2)).toBeUndefined()
  })

  for (const phase of ['temp-synced', 'replaced', 'directory-synced'] as const) {
    test(`receipt death at ${phase} preserves receipt-before-source-ack semantics`, async () => {
      const dir = await directory()
      const record = notice()
      await new RecoveryOutbox(dir).import(record)
      await crash(dir, record, 'delivered', phase)
      const reboot = new RecoveryOutbox(dir, { epoch: 'next' })
      const recovered = (await reboot.import(record))!
      if (phase === 'temp-synced') {
        expect(recovered.state).toBe('leased')
        expect(recovered.receipt).toBeUndefined()
        expect(await reboot.lease(record.deliveryId, recovered.generation)).toBeDefined()
      } else {
        expect(recovered.state).toBe('delivered')
        expect(recovered.receipt?.messageId).toBe('remote-message')
        expect(await reboot.lease(record.deliveryId, recovered.generation)).toBeUndefined()
      }
    })
  }

  test('import conflicts preserve existing transfer and coverage order is immaterial', async () => {
    const dir = await directory()
    const store = new RecoveryOutbox(dir)
    const input = notice()
    input.covers.push({ store: 'inventory', id: 'second', generation: 1 })
    input.deliveryId = recoveryDeliveryId(input)
    const record = parseRecoveryRecord(input)
    await store.import(record)
    expect((await store.import({ ...record, covers: [...record.covers].reverse() })).deliveryId).toBe(record.deliveryId)
    await expect(store.import({ ...record, transferId: 'different' })).rejects.toThrow('Conflicting recovery import')
    await expect(store.import({ ...record, principal: { kind: 'tui' } })).rejects.toThrow('Conflicting recovery import')
    expect((await store.get(record.deliveryId))?.transferId).toBe(record.transferId)
    expect(createRecoveryNotice({ ...record, createdAt: 999 }).deliveryId).toBe(record.deliveryId)
  })

  test('blocked destinations remain owed and retry after authorized restoration', async () => {
    const dir = await directory()
    const store = new RecoveryOutbox(dir, { epoch: 'e', now: () => 500 })
    const record = notice()
    await store.import(record)
    const lease = (await store.lease(record.deliveryId, 1))!
    expect(await store.fail(record.deliveryId, lease, { kind: 'identity', safeReason: 'Account changed' })).toBe(true)
    const reboot = new RecoveryOutbox(dir, { epoch: 'restored' })
    const blocked = (await reboot.get(record.deliveryId))!
    expect(blocked.state).toBe('blocked')
    const retry = (await reboot.lease(record.deliveryId, blocked.generation))!
    expect(await reboot.delivered(record.deliveryId, retry, { confirmedAt: 600 })).toBe(true)
  })

  test('Retry-After is a lower bound and suppression prevents retry while retaining landed receipt', async () => {
    const dir = await directory()
    let now = 1000
    const store = new RecoveryOutbox(dir, { epoch: 'e', now: () => now })
    const record = notice()
    await store.import(record)
    const first = (await store.lease(record.deliveryId, 1))!
    await store.fail(record.deliveryId, first, { kind: 'rate-limit', safeReason: 'Rate limited', retryAfter: 10_000 })
    expect((await store.get(record.deliveryId))?.nextAttemptAt).toBe(11_000)
    expect(await store.lease(record.deliveryId, first.generation)).toBeUndefined()
    now = 11_000
    const retry = (await store.lease(record.deliveryId, first.generation))!
    expect(await store.suppress(record.deliveryId, 'Stopped', 'decision')).toBe(true)
    expect(await store.fail(record.deliveryId, retry, { kind: 'transient', safeReason: 'Timeout' })).toBe(false)
    expect(await store.delivered(record.deliveryId, retry, { confirmedAt: now, messageId: 'landed' })).toBe(true)
    const terminal = (await store.get(record.deliveryId))!
    expect(terminal.state).toBe('suppressed')
    expect(terminal.receipt?.messageId).toBe('landed')
    expect(await store.lease(record.deliveryId, terminal.generation)).toBeUndefined()
    expect(await store.suppress(record.deliveryId, 'Stopped', 'decision')).toBe(true)
    expect(await store.suppress(record.deliveryId, 'Different', 'other')).toBe(false)
  })

  test('legacy binding survives reboot and unbound transfer re-import without redirect', async () => {
    const dir = await directory()
    const record = createRecoveryNotice({ ...notice(), accountIdentity: 'unbound-legacy' })
    const store = new RecoveryOutbox(dir, { epoch: 'e' })
    await store.import(record)
    const lease = (await store.lease(record.deliveryId, 1))!
    expect(await store.bindAccount(record.deliveryId, lease, 'authenticated')).toBe(true)
    expect(await store.bindAccount(record.deliveryId, lease, 'other')).toBe(false)
    const reboot = new RecoveryOutbox(dir, { epoch: 'reboot' })
    const imported = await reboot.import(record)
    expect(imported.boundAccountIdentity).toBe('authenticated')
    const next = (await reboot.lease(record.deliveryId, imported.generation))!
    expect(await reboot.bindAccount(record.deliveryId, next, 'other')).toBe(false)
  })

  test('schema corruption is retained and independent destinations still progress', async () => {
    const dir = await directory()
    const errors: unknown[] = []
    const store = new RecoveryOutbox(dir, { onError: (error) => errors.push(error) })
    const record = notice()
    await store.import(record)
    const broken = createRecoveryNotice({ ...record, recoveryGeneration: 'other' })
    await store.import(broken)
    const path = join(dir, 'channels', 'recovery-outbox', `${broken.deliveryId}.json`)
    const bytes = JSON.stringify({ ...broken, state: 'delivered' })
    await writeFile(path, bytes)
    expect((await store.list()).map((item) => item.deliveryId)).toEqual([record.deliveryId])
    expect(errors).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    await expect(store.get(broken.deliveryId)).rejects.toThrow()
    for (const malformed of [
      { ...record, schemaVersion: 2 },
      { ...record, generation: 0 },
      { ...record, deliveryId: 'a'.repeat(64) },
      { ...record, state: 'leased' },
      { ...record, state: 'suppressed' },
      { ...record, covers: [...record.covers, ...record.covers] },
      { ...record, unknown: true },
    ])
      expect(validateRecoveryRecord(malformed)).toBe(false)
    expect(await store.lease(record.deliveryId, 1)).toBeDefined()
  })

  test('failed persistence rejects admission instead of returning memory acceptance', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'channels'), 'not a directory')
    const store = new RecoveryOutbox(dir)
    await expect(store.import(notice())).rejects.toThrow()
    await rm(join(dir, 'channels'))
    expect(await store.get(notice().deliveryId)).toBeUndefined()
    expect((await store.import(notice())).state).toBe('pending')
  })

  test('directory-sync failure never acknowledges receipt; reboot repairs committed receipt without resend', async () => {
    const dir = await directory()
    const record = notice()
    const store = new RecoveryOutbox(dir, {
      epoch: 'e',
      onDurability(phase, value) {
        if (phase === 'replaced' && value.state === 'delivered') throw new Error('directory sync unavailable')
      },
    })
    await store.import(record)
    const lease = (await store.lease(record.deliveryId, 1))!
    await expect(store.delivered(record.deliveryId, lease, { confirmedAt: 700 })).rejects.toThrow(
      'directory sync unavailable',
    )
    const reboot = new RecoveryOutbox(dir, { epoch: 'next' })
    const recovered = await reboot.import(record)
    expect(recovered.receipt?.confirmedAt).toBe(700)
    expect(await reboot.lease(record.deliveryId, recovered.generation)).toBeUndefined()
  })

  test('lease token must match captured attempt and epoch, not only generation', async () => {
    const dir = await directory()
    const record = notice()
    const store = new RecoveryOutbox(dir, { epoch: 'e' })
    await store.import(record)
    const lease = (await store.lease(record.deliveryId, 1))!
    for (const forged of [
      { ...lease, attemptId: 'different' },
      { ...lease, epoch: 'other' },
      { ...lease, acquiredAt: lease.acquiredAt + 1 },
      { ...lease, generation: lease.generation + 1 },
    ]) {
      expect(await store.delivered(record.deliveryId, forged, { confirmedAt: 700 })).toBe(false)
      expect(await store.fail(record.deliveryId, forged, { kind: 'transient', safeReason: 'Timeout' })).toBe(false)
    }
    expect(await store.delivered(record.deliveryId, lease, { confirmedAt: 700, messageId: 'message' })).toBe(true)
    expect(await store.delivered(record.deliveryId, lease, { messageId: 'message', confirmedAt: 700 })).toBe(true)
    expect(await store.delivered(record.deliveryId, lease, { confirmedAt: 701 })).toBe(false)
  })
})
