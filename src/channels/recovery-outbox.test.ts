import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LIVE_TURN_ENDED_NOTICE_TEXT,
  parseRecoveryRecord,
  RECOVERY_NOTICE_TEXT,
  recoveryDeliveryId,
  recoveryNoticeCause,
  recoveryPayload,
  recoveryPayloadDigest,
  validateRecoveryRecord,
} from './continuity-types'
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
  operation: 'import' | 'lease' | 'delivered' | 'retire',
  phase: 'temp-synced' | 'replaced' | 'directory-synced' | 'retirement-synced' | 'retired',
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
    else { const lease = await store.lease(record.deliveryId, record.generation); if (!lease) throw new Error('missing lease'); if (operation !== 'lease') await store.delivered(record.deliveryId, lease, {confirmedAt:200,messageId:'remote-message'}); if (operation === 'retire') await store.retire(record.deliveryId, lease.generation); }
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

const golden = {
  target: { adapter: 'slack-bot' as const, workspace: 'w', chat: 'c', thread: 't' },
  accountIdentity: 'actor-1',
  principal: {
    kind: 'channel' as const,
    adapter: 'slack-bot' as const,
    workspace: 'w',
    chat: 'c',
    lastInboundAuthorId: 'human',
  },
  sourceParentSessionId: 'golden-parent',
  covers: [{ store: 'inbound' as const, id: 'golden-input', generation: 2, parentSessionId: 'golden-parent' }],
  transferId: 'golden-transfer',
  recoveryGeneration: 'golden-generation',
  createdAt: 100,
}
// sha256 of the frozen RFC v1 identity tuple; computed independently of the implementation.
const GOLDEN_RESTART_ID = 'd3355b17bf84aabc9a2f6dfd06c23b5980f125f89fd8afc39ddec870c0adf7bf'
const GOLDEN_LIVE_ID = 'eb58949391d20527e2e672a36c4ff364ed7496bbc50efaf17d350a37e0920cad'

describe('recovery notice causes', () => {
  test('restart remains the frozen en/v1 record: identity, template, payload and old bytes unchanged', async () => {
    // Exactly the record shape every earlier release persisted.
    const legacy = {
      schemaVersion: 1,
      deliveryId: GOLDEN_RESTART_ID,
      purpose: 'interruption-notice',
      target: golden.target,
      accountIdentity: golden.accountIdentity,
      principal: golden.principal,
      sourceParentSessionId: golden.sourceParentSessionId,
      covers: golden.covers,
      transferId: golden.transferId,
      recoveryGeneration: golden.recoveryGeneration,
      templateVersion: 1,
      locale: 'en',
      text: "⚠️ I restarted before I could confirm a reply to your earlier request. I didn't rerun it automatically — please ask again if you still need it.",
      createdAt: 100,
      generation: 1,
      state: 'pending',
      attempts: 0,
    }
    const restart = createRecoveryNotice(golden)
    expect(restart).toEqual(parseRecoveryRecord(legacy))
    expect(createRecoveryNotice({ ...golden, cause: 'restart' })).toEqual(restart)
    expect(restart.deliveryId).toBe(GOLDEN_RESTART_ID)
    expect(restart.text).toBe(RECOVERY_NOTICE_TEXT)
    expect('cause' in restart).toBe(false)
    expect(recoveryNoticeCause(restart)).toBe('restart')
    const canonical = (value: object) =>
      JSON.stringify(
        Object.entries(value)
          .filter(([, field]) => field !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      )
    expect(recoveryPayload(restart)).toBe(
      JSON.stringify([
        GOLDEN_RESTART_ID,
        'interruption-notice',
        'slack-bot',
        'w',
        'c',
        't',
        'actor-1',
        null,
        canonical(golden.principal),
        'golden-parent',
        golden.covers.map(canonical).sort(),
        'golden-transfer',
        'golden-generation',
        1,
        'en',
        RECOVERY_NOTICE_TEXT,
        100,
      ]),
    )
    // A record file written by an earlier release is read and re-imported without being rewritten.
    const dir = await directory()
    const path = join(dir, 'channels', 'recovery-outbox', `${GOLDEN_RESTART_ID}.json`)
    await mkdir(join(dir, 'channels', 'recovery-outbox'), { recursive: true })
    const bytes = `${JSON.stringify(legacy)}\n`
    await writeFile(path, bytes)
    const store = new RecoveryOutbox(dir, { epoch: 'upgraded' })
    expect(await store.import(restart)).toEqual(restart)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await store.lease(GOLDEN_RESTART_ID, 1)).toBeDefined()
  })

  test('live-turn-ended is a distinct versioned record that never claims a restart', async () => {
    const live = createRecoveryNotice({ ...golden, cause: 'live-turn-ended' })
    expect(live.deliveryId).toBe(GOLDEN_LIVE_ID)
    expect(live).toMatchObject({
      schemaVersion: 2,
      purpose: 'interruption-notice',
      cause: 'live-turn-ended',
      templateVersion: 1,
      locale: 'en',
      text: LIVE_TURN_ENDED_NOTICE_TEXT,
    })
    expect(recoveryNoticeCause(live)).toBe('live-turn-ended')
    expect(live.text).not.toContain('restart')
    expect(recoveryPayload(live)).not.toBe(recoveryPayload(createRecoveryNotice(golden)))
    // Each cause pins its own template, version and identity seed.
    for (const malformed of [
      { ...live, text: RECOVERY_NOTICE_TEXT },
      { ...live, cause: undefined },
      { ...live, schemaVersion: 1 },
      { ...live, cause: 'restart' },
      { ...live, templateVersion: 2 },
      { ...live, deliveryId: GOLDEN_RESTART_ID },
      { ...createRecoveryNotice(golden), cause: 'live-turn-ended' },
      { ...createRecoveryNotice(golden), text: LIVE_TURN_ENDED_NOTICE_TEXT },
    ])
      expect(validateRecoveryRecord(malformed)).toBe(false)
    // Durable like any notice: it survives reboot and a landed receipt is never re-leased.
    const dir = await directory()
    const first = new RecoveryOutbox(dir, { epoch: 'live' })
    await first.import(live)
    const restart = await first.import(createRecoveryNotice(golden))
    expect(restart.deliveryId).not.toBe(live.deliveryId)
    const lease = (await first.lease(live.deliveryId, 1))!
    expect(await first.delivered(live.deliveryId, lease, { confirmedAt: 5, messageId: 'live-posted' })).toBe(true)
    const reboot = new RecoveryOutbox(dir, { epoch: 'reboot' })
    const recovered = await reboot.import(live)
    expect(recovered).toMatchObject({ state: 'delivered', cause: 'live-turn-ended', text: LIVE_TURN_ENDED_NOTICE_TEXT })
    expect(await reboot.lease(live.deliveryId, recovered.generation)).toBeUndefined()
  })
})

describe('recovery outbox terminal retirement', () => {
  test('retirement keeps only an immutable fence and replayed imports return the finished delivery', async () => {
    const dir = await directory()
    const store = new RecoveryOutbox(dir, { epoch: 'e', now: () => 900 })
    const imported: string[] = []
    const unsubscribe = store.subscribe((record) => imported.push(record.deliveryId))
    const record = notice()
    await store.import(record)
    await store.import(record)
    expect(imported).toEqual([record.deliveryId])
    expect(await store.retire(record.deliveryId, 1)).toBe(false)
    const lease = (await store.lease(record.deliveryId, 1))!
    expect(await store.retire(record.deliveryId, lease.generation)).toBe(false)
    expect(await store.delivered(record.deliveryId, lease, { confirmedAt: 901, messageId: 'posted' })).toBe(true)
    expect(await store.retire(record.deliveryId, 1)).toBe(false)
    expect(await store.retire(record.deliveryId, lease.generation)).toBe(true)
    expect(await store.retire(record.deliveryId, lease.generation)).toBe(true)
    expect(await store.get(record.deliveryId)).toBeUndefined()
    expect(await store.list()).toEqual([])
    const fence = (await store.retired(record.deliveryId))!
    expect(fence).toEqual({
      schemaVersion: 1,
      deliveryId: record.deliveryId,
      payloadDigest: recoveryPayloadDigest(record),
      retiredAt: 900,
      dispatch: {
        state: 'delivered',
        generation: lease.generation,
        attempts: 1,
        lease,
        receipt: { confirmedAt: 901, messageId: 'posted' },
      },
    })
    // The fence does not duplicate the frozen payload.
    expect(JSON.stringify(fence)).not.toContain(record.text)
    expect(await store.listRetired()).toEqual([fence])
    const reboot = new RecoveryOutbox(dir, { epoch: 'reboot' })
    const replay = await reboot.import(record)
    expect(replay).toMatchObject({
      deliveryId: record.deliveryId,
      state: 'delivered',
      receipt: { messageId: 'posted' },
    })
    expect(recoveryPayload(replay)).toBe(recoveryPayload(record))
    expect(await reboot.list()).toEqual([])
    expect(await reboot.lease(record.deliveryId, replay.generation)).toBeUndefined()
    expect(await reboot.suppress(record.deliveryId, 'late-stop', 'late')).toBe(false)
    await expect(reboot.import({ ...record, transferId: 'other' })).rejects.toThrow('Conflicting recovery import')
    expect(imported).toEqual([record.deliveryId])
    unsubscribe()
    await store.import(createRecoveryNotice({ ...record, recoveryGeneration: 'after-unsubscribe' }))
    expect(imported).toEqual([record.deliveryId])
  })

  test('a suppressed record that never dispatched retires to a suppression fence', async () => {
    const dir = await directory()
    const store = new RecoveryOutbox(dir, { epoch: 'e' })
    const record = notice()
    await store.import(record)
    expect(await store.suppress(record.deliveryId, 'user_stop', 'stop-decision')).toBe(true)
    expect(await store.retire(record.deliveryId, 2)).toBe(true)
    expect((await store.retired(record.deliveryId))?.dispatch).toEqual({
      state: 'suppressed',
      generation: 2,
      attempts: 0,
      suppression: { reason: 'user_stop', decisionId: 'stop-decision' },
    })
    expect(await new RecoveryOutbox(dir, { epoch: 'reboot' }).import(record)).toMatchObject({
      state: 'suppressed',
      suppression: { decisionId: 'stop-decision' },
    })
  })

  for (const phase of ['retirement-synced', 'retired'] as const) {
    test(`death during retirement at ${phase} never re-queues the delivery`, async () => {
      const dir = await directory()
      const record = notice()
      await new RecoveryOutbox(dir).import(record)
      await crash(dir, record, 'retire', phase)
      const reboot = new RecoveryOutbox(dir, { epoch: 'next' })
      const active = await reboot.get(record.deliveryId)
      expect(active?.state).toBe(phase === 'retirement-synced' ? 'delivered' : undefined)
      expect((await reboot.retired(record.deliveryId))?.dispatch.state).toBe('delivered')
      expect((await reboot.import(record)).state).toBe('delivered')
      if (active) expect(await reboot.retire(record.deliveryId, active.generation)).toBe(true)
      expect(await reboot.list()).toEqual([])
      expect((await reboot.import(record)).receipt?.messageId).toBe('remote-message')
      expect(await reboot.lease(record.deliveryId, 3)).toBeUndefined()
    })
  }
})
