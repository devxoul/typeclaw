import { afterEach, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile, appendFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { MatchableOrigin } from '../permissions/resolve'
import { BackgroundObligationStore } from './background-obligations'
import { RECOVERY_NOTICE_TEXT } from './continuity-types'
import type { RecoveryRecord } from './continuity-types'
import { InboundJournal } from './inbound-journal'
import type { ClosedInboundRecord, InboundAdmission, InboundRecord, OpenInboundRecord } from './inbound-journal'
import { RecoveryOutbox } from './recovery-outbox'
import { channelKeyId } from './types'
import type { ChannelKey } from './types'
function openRow(row: InboundRecord | undefined): OpenInboundRecord {
  if (!row || row.phase === 'closed') throw new Error(`Expected an open inbound row, got ${row?.phase}`)
  return row
}
function closedRow(row: InboundRecord | undefined): ClosedInboundRecord {
  if (row?.phase !== 'closed') throw new Error(`Expected a closed inbound row, got ${row?.phase}`)
  return row
}
const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
const target: ChannelKey = { adapter: 'slack-bot', workspace: 'w', chat: 'c', thread: 't' }
const principal: MatchableOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'w',
  chat: 'c',
  lastInboundAuthorId: 'human',
}
const input = { accountIdentity: 'bot', target, principal, messageId: 'm', eventKind: 'message', revision: '0' }
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'inbound-journal-'))
  directories.push(dir)
  return dir
}

async function killAtBoundary(dir: string, source: string, token: unknown) {
  const script = join(dir, 'child.ts')
  await writeFile(script, source)
  const child = Bun.spawn([process.execPath, script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const reader = child.stdout.getReader()
  try {
    let text = ''
    while (!text.includes('\n')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Child exited before boundary: ${await new Response(child.stderr).text()}`)
      text += new TextDecoder().decode(chunk.value)
    }
    expect(JSON.parse(text.trim())).toEqual(token)
    child.kill('SIGKILL')
    expect(await child.exited).not.toBe(0)
    if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
    expect(await new Response(child.stderr).text()).toBe('')
  } finally {
    child.kill('SIGKILL')
    await child.exited
    reader.releaseLock()
  }
}

test('close before initialization runs never creates a journal or admits work', async () => {
  const dir = await directory()
  const failures: unknown[] = []
  const journal = new InboundJournal(dir, { onError: (error) => failures.push(error) })
  journal.subscribeFailure((error) => failures.push(error))
  const initializing = journal.initialize()
  const closing = journal.close()
  await Promise.all([initializing, closing])
  await expect(stat(join(dir, 'channels'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(journal.admit(input)).rejects.toThrow('frozen')
  expect(failures).toEqual([])
  expect(journal.health().available).toBe(false)
})

test('shutdown at initialization boundaries cannot reopen a torn journal after directory teardown', async () => {
  for (const boundary of ['initialization-directory-created', 'initialization-read'] as const) {
    const dir = await directory()
    const seed = new InboundJournal(dir)
    await seed.admit(input)
    await seed.close()
    await appendFile(seed.path, '{"schemaVersion":1,"seq":2')
    const before = await readFile(seed.path)
    let reached!: () => void
    let resume!: () => void
    const entered = new Promise<void>((resolve) => {
      reached = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const failures: unknown[] = []
    const background = new BackgroundObligationStore(dir)
    const journal = new InboundJournal(dir, {
      backgroundObligations: background,
      onError: (error) => failures.push(error),
      async onDurability(phase) {
        if (phase !== boundary) return
        reached()
        await gate
      },
    })
    journal.subscribeFailure((error) => failures.push(error))
    const initializing = journal.initialize()
    await entered
    journal.cancelInitialization()
    const closing = journal.close()
    expect(await readFile(journal.path)).toEqual(before)
    await rm(dir, { recursive: true, force: true })
    resume()
    await Promise.all([initializing, closing])
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(failures).toEqual([])
    expect(journal.health().available).toBe(false)
    expect(() => background.assertAvailable()).toThrow('frozen')
    await expect(journal.admit(input)).rejects.toThrow('frozen')
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    // A different runtime can acquire the canceled writer's path.
    const reboot = new InboundJournal(dir)
    expect((await reboot.admit(input)).kind).toBe('accepted')
    await reboot.close()
  }
})

test('canceling startup leaves an operational writer durable and retains its failure fence', async () => {
  const dir = await directory()
  const background = new BackgroundObligationStore(dir)
  const failure = new Error('durable write failed')
  const failures: unknown[] = []
  let armed = false
  const journal = new InboundJournal(dir, {
    backgroundObligations: background,
    onError: (error) => failures.push(error),
    onDurability(phase) {
      if (armed && phase === 'append-written') throw failure
    },
  })
  journal.subscribeFailure((error) => failures.push(error))
  const admitted = await journal.admit(input)
  if (admitted.kind !== 'accepted') throw new Error('missing admission')
  journal.cancelInitialization()
  await journal.settle([{ inputId: admitted.inputId, generation: admitted.generation }], {
    kind: 'intentionally-suppressed',
    decisionId: 'shutdown-closeout',
  })
  armed = true
  await expect(journal.admit({ ...input, messageId: 'next' })).rejects.toThrow('durable write failed')
  expect(failures).toEqual([failure, failure])
  expect(journal.health().available).toBe(false)
  expect(() => background.assertAvailable()).toThrow('frozen')
  await journal.close()
})

test('settled dedupe survives serialized concurrent compaction and admission', async () => {
  const dir = await directory()
  let journal = new InboundJournal(dir, { epoch: 'one' })
  const a = await journal.admit(input)
  if (a.kind !== 'accepted') throw new Error('missing admission')
  await journal.settle([{ inputId: a.inputId, generation: a.generation }], {
    kind: 'intentionally-suppressed',
    decisionId: 'silence',
  })
  await journal.close()
  journal = new InboundJournal(dir, { epoch: 'two' })
  await journal.initialize()
  const [, b] = await Promise.all([journal.compact(), journal.admit({ ...input, messageId: 'b' })])
  expect(b.kind).toBe('accepted')
  await journal.close()
  journal = new InboundJournal(dir, { epoch: 'three' })
  await journal.initialize()
  expect(await journal.admit(input)).toEqual({
    kind: 'duplicate',
    inputId: a.inputId,
    outcome: { kind: 'intentionally-suppressed', decisionId: 'silence' },
  })
  expect(
    journal
      .list()
      .map((r) => r.reference?.messageId)
      .sort(),
  ).toEqual(['b', 'm'])
  await journal.close()
})

test('torn tail truncates before immediate append and exact admissions survive reboot without compaction', async () => {
  const dir = await directory()
  const original = new InboundJournal(dir, { epoch: 'original' })
  const first = await original.admit(input)
  await original.close()
  await appendFile(original.path, '{"schemaVersion":1,"seq":2')
  const writer = new InboundJournal(dir, { epoch: 'writer' })
  await writer.initialize()
  const second = await writer.admit({ ...input, messageId: 'second' })
  await writer.close()
  const boot = new InboundJournal(dir, { epoch: 'boot' })
  await boot.initialize()
  expect(
    boot
      .list()
      .map((row) => row.inputId)
      .sort(),
  ).toEqual([first.inputId, second.inputId].sort())
  expect(
    boot
      .list()
      .map((row) => row.reference?.messageId)
      .sort(),
  ).toEqual(['m', 'second'])
  expect((await boot.admit(input)).kind).toBe('duplicate')
  expect((await boot.admit({ ...input, messageId: 'second' })).kind).toBe('duplicate')
  await boot.close()
})

test('complete corruption and unknown versions preserve bytes and freeze every background target', async () => {
  for (const corruption of ['not-json\n', '{"schemaVersion":9,"seq":2}\n']) {
    const dir = await directory()
    const journal = new InboundJournal(dir)
    await journal.admit(input)
    await journal.close()
    await appendFile(journal.path, corruption)
    const before = await readFile(journal.path)
    const bg = new BackgroundObligationStore(dir)
    const boot = new InboundJournal(dir, { backgroundObligations: bg })
    await expect(boot.initialize()).rejects.toThrow()
    expect(await readFile(journal.path)).toEqual(before)
    expect(() => bg.assertAvailable()).toThrow('frozen')
    await expect(
      bg.accept({
        taskId: 'other',
        parentSessionId: 'parent',
        target: { ...target, chat: 'other' },
        accountIdentity: 'bot',
        principal,
      }),
    ).rejects.toThrow('frozen')
    await boot.close()
  }
})

test('invalid mixed coverage writes nothing and crash repair applies original decision before later work', async () => {
  const dir = await directory()
  let armed = false
  const bg = new BackgroundObligationStore(dir, { epoch: 'one' })
  const journal = new InboundJournal(dir, {
    backgroundObligations: bg,
    onDurability(phase, record) {
      if (
        armed &&
        phase === 'append-synced' &&
        record &&
        typeof record === 'object' &&
        'type' in record &&
        record.type === 'outcome-decided'
      )
        throw new Error('power loss')
    },
  })
  const a = await journal.admit(input)
  if (a.kind !== 'accepted') throw new Error('missing admission')
  const child = await bg.accept({
    taskId: 'child',
    parentSessionId: 'parent',
    target,
    principal,
    accountIdentity: 'bot',
  })
  const refs = [{ inputId: a.inputId, generation: a.generation }]
  const backgroundRefs = [{ obligationId: child.obligationId, generation: child.generation }]
  const size = (await readFile(journal.path)).length
  await expect(
    bg.withTargetLane(target, () => journal.claim(refs, { turnId: 'turn', target }, backgroundRefs)),
  ).rejects.toThrow('claim')
  expect((await readFile(journal.path)).length).toBe(size)
  armed = true
  await expect(
    bg.withTargetLane(target, () =>
      journal.settle(refs, { kind: 'intentionally-suppressed', decisionId: 'stop' }, backgroundRefs, target),
    ),
  ).rejects.toThrow('power loss')
  expect((await bg.get(child.obligationId))?.phase).toBe('accepted')
  expect(() => bg.assertAvailable()).toThrow('frozen')
  await journal.close()
  const nextBg = new BackgroundObligationStore(dir, { epoch: 'two' })
  const boot = new InboundJournal(dir, { backgroundObligations: nextBg })
  await boot.initialize()
  expect(closedRow(boot.get(a.inputId)).outcome.decisionId).toBe('stop')
  expect((await nextBg.get(child.obligationId))?.outcome?.decisionId).toBe('stop')
  await boot.repair()
  expect((await nextBg.get(child.obligationId))?.applications.filter((r) => r.transitionId === 'stop')).toHaveLength(1)
  await expect(boot.settle([a], { kind: 'delivered', decisionId: 'stale' }, [], target)).rejects.toThrow('coverage')
  await boot.close()
})

test('old epoch transfers import before ownership; terminal receipt acknowledgment never recreates a notice', async () => {
  const dir = await directory()
  const old = new InboundJournal(dir, { epoch: 'old' })
  const a = await old.admit(input)
  await old.close()
  const journal = new InboundJournal(dir, { epoch: 'new' })
  const outbox = new RecoveryOutbox(dir, { epoch: 'new' })
  await journal.importOldEpoch(outbox)
  const records = await outbox.list()
  expect(records).toHaveLength(1)
  const notice = records[0]!
  expect(await journal.validateNotice(notice)).toBe('open')
  const lease = await outbox.lease(notice.deliveryId, notice.generation)
  if (!lease) throw new Error('Notice lease unavailable')
  expect(await outbox.delivered(notice.deliveryId, lease, { confirmedAt: Date.now() })).toBe(true)
  const delivered = (await outbox.get(notice.deliveryId))!
  await journal.acknowledgeNotice(delivered)
  await journal.acknowledgeNotice(delivered)
  expect(closedRow(journal.get(a.inputId)).outcome.deliveryId).toBe(notice.deliveryId)
  await journal.close()
  const boot = new InboundJournal(dir, { epoch: 'again' })
  await boot.importOldEpoch(outbox)
  expect(await outbox.list()).toHaveLength(1)
  expect(await boot.validateNotice(notice)).toBe('resolved')
  await boot.close()
})

test('independent process death at each automatic compaction boundary leaves the valid old or new journal and never appends an unlinked handle', async () => {
  const module = import.meta.resolve('./inbound-journal.ts')
  const outboxModule = import.meta.resolve('./recovery-outbox.ts')
  for (const boundary of [
    'append-synced',
    'temp-synced',
    'handle-closed',
    'replaced',
    'directory-synced',
    'reopened',
  ]) {
    const dir = await directory()
    const token = { boundary }
    // Maintenance starts only after the history exists, so its first automatic compaction is the one killed.
    await killAtBoundary(
      dir,
      `import { InboundJournal } from ${JSON.stringify(module)}; import { RecoveryOutbox } from ${JSON.stringify(outboxModule)};
      let armed = false; const input = ${JSON.stringify(input)};
      const j = new InboundJournal(${JSON.stringify(dir)},{epoch:'child',compactionFloorBytes:1,onDurability:async phase => { if (armed && phase === ${JSON.stringify(boundary)}) { console.log(${JSON.stringify(JSON.stringify(token))}); await Bun.stdin.text(); throw new Error('Crash boundary resumed'); } }});
      const answered = await j.admit({...input,messageId:'answered'});
      await j.settle([{inputId:answered.inputId,generation:1}],{kind:'delivered',decisionId:'answer'});
      const noticed = await j.admit({...input,messageId:'noticed'});
      await j.importPrepared(new RecoveryOutbox(${JSON.stringify(dir)},{epoch:'child'}), await j.prepareNotice([{inputId:noticed.inputId,generation:1}], input.target));
      armed = true; await j.admit(input); j.startMaintenance(); await j.flush();`,
      token,
    )
    const lines = (await readFile(join(dir, 'channels', 'inbound-continuity.jsonl'), 'utf8')).split('\n')
    const replaced = ['replaced', 'directory-synced', 'reopened'].includes(boundary)
    expect(JSON.parse(lines[0]!)).toMatchObject(
      replaced ? { schemaVersion: 2, type: 'snapshot' } : { type: 'admitted' },
    )
    for (const epoch of ['boot', 'last']) {
      const boot = new InboundJournal(dir, { epoch })
      await boot.initialize()
      expect((await boot.admit(input)).kind).toBe('duplicate')
      expect(await boot.admit({ ...input, messageId: 'answered', revision: '1' })).toMatchObject({
        kind: 'duplicate',
        outcome: { kind: 'delivered', decisionId: 'answer' },
      })
      const noticed = openRow(boot.list().find((row) => row.reference?.messageId === 'noticed'))
      expect(noticed.phase).toBe('notice-owned')
      expect(await boot.validateNotice(noticed.transfer!)).toBe('open')
      // The first admission after recovery lands in the installed file and survives the next boot.
      if (epoch === 'boot') expect((await boot.admit({ ...input, messageId: 'after' })).kind).toBe('accepted')
      expect(
        boot
          .list()
          .map((r) => r.reference?.messageId)
          .sort(),
      ).toEqual(['after', 'answered', 'm', 'noticed'])
      await boot.close()
    }
  }
}, 30000)

test('duplicate decision identity remains strict after compaction, generations reject stale ownership and a closed Slack message stays answered', async () => {
  const dir = await directory()
  const journal = new InboundJournal(dir, { epoch: 'one' })
  const a = await journal.admit(input)
  const refs = [{ inputId: a.inputId, generation: 1 }]
  const owner = { turnId: 'a', ownerSessionId: 'session', target }
  const claim = await journal.claim(refs, owner, [], 'claim-a')
  expect(await journal.claim(refs, owner, [], 'claim-a')).toEqual(claim)
  await journal.compact()
  expect(await journal.claim(refs, owner, [], 'claim-a')).toEqual(claim)
  await expect(journal.claim(refs, { ...owner, turnId: 'other' }, [], 'claim-a')).rejects.toThrow(
    'Conflicting duplicate',
  )
  await expect(journal.move(refs, { ...owner, fromTurnId: 'a', turnId: 'b' }, [], 'move-stale')).rejects.toThrow(
    'coverage',
  )
  const moved = await journal.move(claim.inboundRefs, { ...owner, fromTurnId: 'a', turnId: 'b' }, [], 'move-b')
  const outcome = { kind: 'delivered' as const, decisionId: 'answer' }
  const settled = await journal.settle(moved.inboundRefs, outcome)
  await journal.compact()
  expect(await journal.settle(moved.inboundRefs, outcome)).toEqual(settled)
  await journal.close()
  const boot = new InboundJournal(dir, { epoch: 'two' })
  await boot.initialize()
  await expect(boot.claim(refs, owner, [], 'claim-a')).rejects.toThrow('superseded')
  await expect(boot.settle(moved.inboundRefs, { ...outcome, kind: 'intentionally-suppressed' })).rejects.toThrow(
    'Conflicting duplicate',
  )
  // Later Slack revisions of the answered message neither reopen nor re-admit it.
  expect(await boot.admit({ ...input, revision: '1' })).toEqual({ kind: 'duplicate', inputId: a.inputId, outcome })
  expect(boot.list()).toHaveLength(1)
  await boot.close()
})

test('independent mixed stop death followed by complete midfile corruption freezes all backgrounds; verified repair applies stop once', async () => {
  const dir = await directory()
  const token = { boundary: 'mixed-stop-before-json' }
  const source = `import { InboundJournal } from ${JSON.stringify(import.meta.resolve('./inbound-journal.ts'))}; import { BackgroundObligationStore } from ${JSON.stringify(import.meta.resolve('./background-obligations.ts'))};
    const bg = new BackgroundObligationStore(${JSON.stringify(dir)},{epoch:'old'});
    const j = new InboundJournal(${JSON.stringify(dir)},{backgroundObligations:bg,onDurability:async (phase,record) => { if (phase==='append-synced' && record.type==='outcome-decided') { console.log(${JSON.stringify(JSON.stringify(token))}); await Bun.stdin.text(); throw new Error('Crash boundary resumed'); } }});
    const a = await j.admit(${JSON.stringify(input)}); const child = await bg.accept({taskId:'child',parentSessionId:'p',accountIdentity:'bot',target:${JSON.stringify(target)},principal:${JSON.stringify(principal)}});
    await bg.withTargetLane(${JSON.stringify(target)},()=>j.settle([{inputId:a.inputId,generation:a.generation}],{kind:'intentionally-suppressed',decisionId:'stop'},[{obligationId:child.obligationId,generation:child.generation}],${JSON.stringify(target)}));`
  await killAtBoundary(dir, source, token)
  const path = join(dir, 'channels', 'inbound-continuity.jsonl')
  const good = await readFile(path)
  const lines = good.toString().split('\n')
  lines.splice(1, 0, 'not-json')
  await writeFile(path, lines.join('\n'))
  const corrupt = await readFile(path)
  const bg = new BackgroundObligationStore(dir, { epoch: 'new' })
  const broken = new InboundJournal(dir, { backgroundObligations: bg })
  await expect(broken.initialize()).rejects.toThrow()
  expect(await readFile(path)).toEqual(corrupt)
  const child = (await bg.list())[0]!
  expect(child.phase).toBe('accepted')
  await expect(
    bg.claim([{ obligationId: child.obligationId, generation: child.generation }], { turnId: 'bad', target }),
  ).rejects.toThrow('frozen')
  await expect(bg.prepareNotice(child.obligationId, child.generation)).rejects.toThrow('frozen')
  await expect(
    bg.accept({
      taskId: 'different',
      parentSessionId: 'other',
      accountIdentity: 'bot',
      target: { ...target, chat: 'other' },
      principal,
    }),
  ).rejects.toThrow('frozen')
  await broken.close()
  await writeFile(path, good)
  const repairedBg = new BackgroundObligationStore(dir, { epoch: 'repair' })
  const repaired = new InboundJournal(dir, { backgroundObligations: repairedBg })
  await repaired.initialize()
  expect((await repairedBg.get(child.obligationId))?.outcome).toEqual({
    kind: 'intentionally-suppressed',
    decisionId: 'stop',
  })
  await repaired.compact()
  await repaired.close()
  const finalBg = new BackgroundObligationStore(dir, { epoch: 'last' })
  const final = new InboundJournal(dir, { backgroundObligations: finalBg })
  await final.initialize()
  expect((await finalBg.get(child.obligationId))?.applications.filter((r) => r.transitionId === 'stop')).toHaveLength(1)
  expect((await final.admit(input)).kind).toBe('duplicate')
  await final.close()
}, 20000)

test('actual append fsync EIO rejects admission and freezes cached and dependent progress in an isolated process', async () => {
  const dir = await directory()
  const script = join(dir, 'sync-failure.ts')
  await writeFile(
    script,
    `import {open,stat} from 'node:fs/promises'; import assert from 'node:assert/strict'; import {InboundJournal} from ${JSON.stringify(import.meta.resolve('./inbound-journal.ts'))}; import {BackgroundObligationStore} from ${JSON.stringify(import.meta.resolve('./background-obligations.ts'))};
    const probe=await open(${JSON.stringify(join(dir, 'probe'))},'w'); const prototype=Object.getPrototypeOf(probe); const original=prototype.sync; await probe.close(); let armed=false; let failures=0;
    const bg=new BackgroundObligationStore(${JSON.stringify(dir)},{epoch:'one'}); const journal=new InboundJournal(${JSON.stringify(dir)},{backgroundObligations:bg,onDurability:phase=>{if(phase==='append-written')armed=true}});
    prototype.sync=async function(){const metadata=await this.stat(); if(armed && metadata.isFile() && metadata.ino===(await stat(journal.path)).ino){failures++; const error=new Error('simulated EIO'); error.code='EIO'; throw error;} return original.call(this)};
    try {await assert.rejects(journal.admit(${JSON.stringify(input)}),/simulated EIO/); assert.equal(failures,1); assert.equal(journal.health().available,false); assert.throws(()=>journal.list(),/frozen/); await assert.rejects(bg.accept({taskId:'blocked',parentSessionId:'p',accountIdentity:'bot',target:${JSON.stringify(target)},principal:${JSON.stringify(principal)}}),/frozen/); console.log(JSON.stringify({rejected:true,frozen:true,failures}));} finally {prototype.sync=original;await journal.close()}`,
  )
  const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toEqual({ rejected: true, frozen: true, failures: 1 })
})

test('complete schema/state/sequence/tombstone/notice corruption in retained snapshots is never truncated', async () => {
  type CorruptSnapshot = {
    schemaVersion: number
    seq: number
    notices: Array<{ covers: Array<{ generation: number }> }>
    open: Array<{
      target: { adapter: string }
      principal: { kind: string }
      generation: number
      rawContent?: string
      transfer?: unknown
    }>
    closed: Array<{ phase: string; principalDigest: string; noticeDeliveryId?: string; identity?: string }>
    receipts: Array<{ seq: number }>
  }
  const mutations = [
    (snapshot: CorruptSnapshot) => {
      snapshot.open[0]!.target.adapter = 'unknown'
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.open[0]!.principal.kind = 'unknown'
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.open[0]!.generation = -1
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.open[0]!.rawContent = 'not allowed'
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.open[0]!.transfer = snapshot.notices[0]
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.receipts[0]!.seq = snapshot.seq + 1
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.schemaVersion = 3
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.closed.find((row) => !row.noticeDeliveryId)!.phase = 'admitted'
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.closed.find((row) => !row.noticeDeliveryId)!.principalDigest = 'not-a-digest'
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.closed.find((row) => !row.noticeDeliveryId)!.identity = 'smuggled full identity'
    },
    (snapshot: CorruptSnapshot) => {
      // The author fence no longer matches the frozen notice that closed the input.
      snapshot.closed.find((row) => row.noticeDeliveryId)!.principalDigest = '0'.repeat(64)
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.closed.find((row) => row.noticeDeliveryId)!.noticeDeliveryId = '0'.repeat(64)
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.notices[0]!.covers[0]!.generation += 1
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.notices.push(snapshot.notices[0]!)
    },
  ]
  for (const mutate of mutations) {
    const dir = await directory()
    const journal = new InboundJournal(dir)
    const open = await journal.admit(input)
    await journal.claim([{ inputId: open.inputId, generation: 1 }], { turnId: 'turn', target }, [], 'claim-a')
    const answered = await journal.admit({ ...input, messageId: 'answered' })
    await journal.settle([{ inputId: answered.inputId, generation: 1 }], { kind: 'delivered', decisionId: 'answer' })
    const noticed = await journal.admit({ ...input, messageId: 'noticed' })
    const transfer = await journal.prepareNotice([{ inputId: noticed.inputId, generation: 1 }], target)
    await journal.suppressNoticeCoverage(transfer, { decisionId: 'stop', reason: 'user-stop' })
    await journal.compact()
    await journal.close()
    const snapshot = JSON.parse(await readFile(journal.path, 'utf8'))
    expect(snapshot).toMatchObject({ schemaVersion: 2, open: [{}], closed: [{}, {}], notices: [{}] })
    mutate(snapshot)
    const corrupt = `${JSON.stringify(snapshot)}\n`
    await writeFile(journal.path, corrupt)
    const boot = new InboundJournal(dir)
    await expect(boot.initialize()).rejects.toThrow()
    expect(await readFile(journal.path, 'utf8')).toBe(corrupt)
    await boot.close()
  }
})

test('independent mixed claim move and notice crashes repair exact JSON receipts before allowing successors', async () => {
  for (const operation of ['claim', 'move', 'notice']) {
    for (const phase of ['append-synced', 'mixed-json-applied']) {
      const dir = await directory()
      const token = { operation, phase }
      const type = operation === 'claim' ? 'turn-claimed' : operation === 'move' ? 'ownership-moved' : 'notice-prepared'
      const source = `import {InboundJournal} from ${JSON.stringify(import.meta.resolve('./inbound-journal.ts'))}; import {BackgroundObligationStore} from ${JSON.stringify(import.meta.resolve('./background-obligations.ts'))};
        let armed=false; const target=${JSON.stringify(target)}; const bg=new BackgroundObligationStore(${JSON.stringify(dir)},{epoch:'old'});
        const j=new InboundJournal(${JSON.stringify(dir)},{backgroundObligations:bg,onDurability:async (phase,record)=>{if(armed && phase===${JSON.stringify(phase)} && record.type===${JSON.stringify(type)}){console.log(${JSON.stringify(JSON.stringify(token))});await Bun.stdin.text();throw new Error('Crash boundary resumed')}}});
        const accepted=await j.admit(${JSON.stringify({ ...input, ownerSessionId: 'p' })}); let refs=[{inputId:accepted.inputId,generation:accepted.generation}];
        const child=await bg.accept({taskId:'child',parentSessionId:'p',accountIdentity:'bot',target,principal:${JSON.stringify(principal)}}); const ready=await bg.resultReady(child.obligationId); let backgroundRefs=[{obligationId:ready.obligationId,generation:ready.generation}];
        if(${JSON.stringify(operation)}==='move'){const claimed=await bg.withTargetLane(target,()=>j.claim(refs,{turnId:'first',target},backgroundRefs,'first-claim'));refs=claimed.inboundRefs;backgroundRefs=claimed.backgroundRefs;}
        armed=true; await bg.withTargetLane(target,async ()=>{if(${JSON.stringify(operation)}==='claim')await j.claim(refs,{turnId:'op',target},backgroundRefs,'op');else if(${JSON.stringify(operation)}==='move')await j.move(refs,{fromTurnId:'first',turnId:'op',target},backgroundRefs,'op');else await j.prepareNotice(refs,target,backgroundRefs)});`
      await killAtBoundary(dir, source, token)
      const bg = new BackgroundObligationStore(dir, { epoch: 'new' })
      const journal = new InboundJournal(dir, { backgroundObligations: bg })
      await journal.initialize()
      const row = openRow(journal.list()[0])
      const child = (await bg.list())[0]!
      const generation = operation === 'move' ? 3 : 2
      expect(row.generation).toBe(generation)
      expect(child.generation).toBe(operation === 'move' ? 4 : 3)
      expect(row.phase).toBe(operation === 'notice' ? 'notice-prepared' : 'turn-owned')
      expect(child.phase).toBe(operation === 'notice' ? 'notice-prepared' : 'turn-owned')
      if (operation !== 'notice') {
        expect(row.claim?.turnId).toBe('op')
        expect(child.claim?.turnId).toBe('op')
        expect(child.claim?.epoch).toBe('old')
      } else {
        expect(child.transfer?.deliveryId).toBe(row.transfer?.deliveryId)
        expect(row.transfer?.covers.map((c) => c.store).sort()).toEqual(['background', 'inbound'])
      }
      const decisionId = operation === 'notice' ? `prepare:${row.transfer!.transferId}` : 'op'
      const application = child.applications.find((r) => r.transitionId === decisionId)!
      expect(application.expectedGeneration).toBe(child.generation - 1)
      await journal.repair()
      expect(
        (await bg.get(child.obligationId))?.applications.filter((r) => r.transitionId === decisionId),
      ).toHaveLength(1)
      await expect(
        bg.withTargetLane(target, () =>
          journal.settle(
            [{ inputId: row.inputId, generation: 1 }],
            { kind: 'delivered', decisionId: 'stale' },
            [],
            target,
          ),
        ),
      ).rejects.toThrow('coverage')
      if (operation === 'notice') {
        const outbox = new RecoveryOutbox(dir, { epoch: 'new' })
        await journal.importOldEpoch(outbox)
        expect(await journal.validateNotice((await outbox.list())[0]!)).toBe('open')
      }
      await journal.compact()
      await journal.close()
      const finalBg = new BackgroundObligationStore(dir, { epoch: 'last' })
      const final = new InboundJournal(dir, { backgroundObligations: finalBg })
      await final.initialize()
      expect(
        (await finalBg.get(child.obligationId))?.applications.filter((r) => r.transitionId === decisionId),
      ).toHaveLength(1)
      expect(final.list()[0]!.generation).toBe(generation)
      if (operation === 'notice') {
        // The frozen transfer, now kept once per delivery, still acknowledges and closes both stores.
        const outbox = new RecoveryOutbox(dir, { epoch: 'last' })
        const notice = (await outbox.list())[0]!
        const lease = await outbox.lease(notice.deliveryId, notice.generation)
        if (!lease) throw new Error('Notice lease unavailable')
        expect(await outbox.delivered(notice.deliveryId, lease, { confirmedAt: Date.now() })).toBe(true)
        const delivered = (await outbox.get(notice.deliveryId))!
        await finalBg.withTargetLane(target, () => final.acknowledgeNotice(delivered))
        expect(closedRow(final.list()[0])).toMatchObject({
          outcome: { kind: 'delivered', deliveryId: notice.deliveryId },
          noticeDeliveryId: notice.deliveryId,
        })
        expect((await finalBg.get(child.obligationId))?.phase).toBe('closed')
        await final.compact()
        await final.close()
        const againBg = new BackgroundObligationStore(dir, { epoch: 'again' })
        const again = new InboundJournal(dir, { backgroundObligations: againBg })
        await again.initialize()
        const bytes = await readFile(again.path)
        expect(await again.validateNotice(delivered)).toBe('resolved')
        await againBg.withTargetLane(target, () => again.acknowledgeNotice(delivered))
        expect(await readFile(again.path)).toEqual(bytes)
        await again.close()
        continue
      }
      await final.close()
    }
  }
}, 20000)

test('multi-author logical turns preserve each provenance and notice transfers partition principals', async () => {
  const dir = await directory()
  const bg = new BackgroundObligationStore(dir, { epoch: 'one' })
  const journal = new InboundJournal(dir, { backgroundObligations: bg })
  const first = await journal.admit({ ...input, ownerSessionId: 'parent' })
  const secondPrincipal: MatchableOrigin = { ...principal, lastInboundAuthorId: 'second' }
  const second = await journal.admit({
    ...input,
    messageId: 'second',
    principal: secondPrincipal,
    ownerSessionId: 'parent',
  })
  const child = await bg.accept({
    taskId: 'child',
    parentSessionId: 'parent',
    accountIdentity: 'bot',
    target,
    principal,
  })
  const ready = (await bg.resultReady(child.obligationId))!
  const refs = [
    { inputId: first.inputId, generation: 1 },
    { inputId: second.inputId, generation: 1 },
  ]
  const claimed = await bg.withTargetLane(target, () =>
    journal.claim(refs, { turnId: 'turn', ownerSessionId: 'parent', target }, [
      { obligationId: ready.obligationId, generation: ready.generation },
    ]),
  )
  expect(openRow(journal.get(first.inputId)).principal).toEqual(principal)
  expect(openRow(journal.get(second.inputId)).principal).toEqual(secondPrincipal)
  const before = await readFile(journal.path)
  await expect(
    bg.withTargetLane(target, () =>
      journal.prepareNotice(claimed.inboundRefs, target, claimed.backgroundRefs, 'parent'),
    ),
  ).rejects.toThrow('partitioned by principal')
  expect(await readFile(journal.path)).toEqual(before)
  await bg.withTargetLane(target, () =>
    journal.settle(
      claimed.inboundRefs,
      { kind: 'delivered', decisionId: 'multi-author-reply' },
      claimed.backgroundRefs,
      target,
    ),
  )
  expect(journal.list().map((row) => closedRow(row).outcome.decisionId)).toEqual([
    'multi-author-reply',
    'multi-author-reply',
  ])
  expect((await bg.get(child.obligationId))?.outcome?.decisionId).toBe('multi-author-reply')
  await journal.close()
})

test('queued and moved notice coverage freezes parent coordinates for exact parent stop', async () => {
  const dir = await directory()
  const journal = new InboundJournal(dir, { epoch: 'one' })
  const queued = await journal.admit({ ...input, ownerSessionId: 'queued-parent' })
  const queuedTransfer = await journal.prepareNotice(
    [{ inputId: queued.inputId, generation: 1 }],
    target,
    [],
    'queued-parent',
  )
  expect(queuedTransfer.sourceParentSessionId).toBe('queued-parent')
  expect(queuedTransfer.covers).toEqual([
    { store: 'inbound', id: queued.inputId, generation: 2, parentSessionId: 'queued-parent' },
  ])
  const owned = await journal.admit({ ...input, messageId: 'owned', ownerSessionId: 'old-parent' })
  const claim = await journal.claim([{ inputId: owned.inputId, generation: 1 }], {
    turnId: 'first',
    ownerSessionId: 'old-parent',
    target,
  })
  const moved = await journal.move(claim.inboundRefs, {
    fromTurnId: 'first',
    turnId: 'new-turn',
    ownerSessionId: 'new-parent',
    target,
  })
  const transfer = await journal.prepareNotice(moved.inboundRefs, target, [], 'fallback-parent')
  expect(transfer.sourceParentSessionId).toBe('new-parent')
  expect(transfer.covers[0]?.parentSessionId).toBe('new-parent')
  await journal.compact()
  await journal.close()
  const boot = new InboundJournal(dir, { epoch: 'two' })
  await boot.initialize()
  expect((await boot.prepareNotice(moved.inboundRefs, target, [], 'fallback-parent')).deliveryId).toBe(
    transfer.deliveryId,
  )
  await expect(boot.prepareNotice(moved.inboundRefs, target, [], 'different-fallback')).rejects.toThrow(
    'Conflicting duplicate',
  )
  await boot.close()
})

test('a covered child must share the notice effective parent; a claimed owner supersedes its launch parent', async () => {
  const dir = await directory()
  const bg = new BackgroundObligationStore(dir, { epoch: 'one' })
  const journal = new InboundJournal(dir, { backgroundObligations: bg })
  const owned = await journal.admit({ ...input, ownerSessionId: 'parent' })
  const launched = await bg.accept({
    taskId: 'foreign',
    parentSessionId: 'other',
    accountIdentity: 'bot',
    target,
    principal,
  })
  const foreign = (await bg.resultReady(launched.obligationId))!
  const refs = [{ inputId: owned.inputId, generation: 1 }]
  const before = await readFile(journal.path)
  await expect(
    bg.withTargetLane(target, () =>
      journal.prepareNotice(refs, target, [{ obligationId: foreign.obligationId, generation: foreign.generation }]),
    ),
  ).rejects.toThrow('partitioned by owner')
  expect(await readFile(journal.path)).toEqual(before)
  expect(await bg.get(foreign.obligationId)).toEqual(foreign)
  const adopted = await bg.withTargetLane(target, () =>
    bg.claim([{ obligationId: foreign.obligationId, generation: foreign.generation }], {
      turnId: 'turn',
      ownerSessionId: 'parent',
      target,
    }),
  )
  const transfer = await bg.withTargetLane(target, () => journal.prepareNotice(refs, target, adopted))
  expect(transfer.sourceParentSessionId).toBe('parent')
  expect(transfer.covers.map((c) => [c.store, c.id, c.generation]).sort()).toEqual(
    [
      ['background', foreign.obligationId, foreign.generation + 2],
      ['inbound', owned.inputId, 2],
    ].sort(),
  )
  await journal.close()
})

test('a known background freeze rejects a mixed decision before it is durable and leaves admission open', async () => {
  const dir = await directory()
  const bg = new BackgroundObligationStore(dir, { epoch: 'one' })
  const journal = new InboundJournal(dir, { backgroundObligations: bg })
  const owned = await journal.admit({ ...input, ownerSessionId: 'parent' })
  const launched = await bg.accept({
    taskId: 'child',
    parentSessionId: 'parent',
    accountIdentity: 'bot',
    target,
    principal,
  })
  const ready = (await bg.resultReady(launched.obligationId))!
  const refs = [{ inputId: owned.inputId, generation: 1 }]
  const brefs = [{ obligationId: ready.obligationId, generation: ready.generation }]
  const owner = { turnId: 'turn', ownerSessionId: 'parent', target }
  bg.setFrozen(new Error('legacy migration failed'))
  const before = await readFile(journal.path)
  await expect(bg.withTargetLane(target, () => journal.claim(refs, owner, brefs, 'mixed-claim'))).rejects.toThrow(
    'frozen',
  )
  expect(await readFile(journal.path)).toEqual(before)
  expect(journal.health().available).toBe(true)
  expect(journal.get(owned.inputId)).toMatchObject({ phase: 'admitted', generation: 1 })
  expect((await journal.admit({ ...input, messageId: 'unrelated' })).kind).toBe('accepted')
  bg.setFrozen(undefined)
  const claimed = await bg.withTargetLane(target, () => journal.claim(refs, owner, brefs, 'mixed-claim'))
  expect(claimed.backgroundRefs).toEqual([{ obligationId: ready.obligationId, generation: ready.generation + 1 }])
  expect((await bg.get(ready.obligationId))?.applications.filter((r) => r.transitionId === 'mixed-claim')).toHaveLength(
    1,
  )
  await journal.close()
})

test('partial two-child JSON claim repairs chronologically with background frozen through all-applied', async () => {
  const dir = await directory()
  const token = { boundary: 'first-child-json-applied' }
  const source = `import {InboundJournal} from ${JSON.stringify(import.meta.resolve('./inbound-journal.ts'))}; import {BackgroundObligationStore} from ${JSON.stringify(import.meta.resolve('./background-obligations.ts'))};
    let armed=false; const target=${JSON.stringify(target)}; const principal=${JSON.stringify(principal)};
    const bg=new BackgroundObligationStore(${JSON.stringify(dir)},{epoch:'old',onDurability:async(phase,row)=>{if(armed && phase==='directory-synced' && row.taskId==='first' && row.phase==='turn-owned'){console.log(${JSON.stringify(JSON.stringify(token))});await Bun.stdin.text();throw new Error('Crash boundary resumed')}}});
    const journal=new InboundJournal(${JSON.stringify(dir)},{backgroundObligations:bg});const a=await journal.admit(${JSON.stringify(input)});
    const backgroundRefs=[];for(const taskId of ['first','second']){const child=await bg.accept({taskId,parentSessionId:'p',accountIdentity:'bot',target,principal});const ready=await bg.resultReady(child.obligationId);backgroundRefs.push({obligationId:ready.obligationId,generation:ready.generation})}
    armed=true;await bg.withTargetLane(target,()=>journal.claim([{inputId:a.inputId,generation:1}],{turnId:'batch',target},backgroundRefs,'batch-claim'));`
  await killAtBoundary(dir, source, token)
  const bg = new BackgroundObligationStore(dir, { epoch: 'new' })
  const partial = await bg.list()
  expect(partial.find((row) => row.taskId === 'first')?.phase).toBe('turn-owned')
  expect(partial.find((row) => row.taskId === 'second')?.phase).toBe('result-ready')
  let freezeObserved = false
  const journal = new InboundJournal(dir, {
    backgroundObligations: bg,
    onDurability: async (phase) => {
      if (phase !== 'mixed-json-applied') return
      expect(() => bg.assertAvailable()).toThrow('frozen')
      await expect(
        bg.accept({
          taskId: 'other-target',
          parentSessionId: 'other',
          accountIdentity: 'bot',
          target: { ...target, chat: 'other' },
          principal,
        }),
      ).rejects.toThrow('frozen')
      freezeObserved = true
    },
  })
  await journal.initialize()
  expect(freezeObserved).toBe(true)
  expect(journal.health().available).toBe(true)
  for (const row of await bg.list()) {
    expect(row.phase).toBe('turn-owned')
    expect(row.claim?.turnId).toBe('batch')
    expect(row.generation).toBe(3)
    expect(row.applications.filter((receipt) => receipt.transitionId === 'batch-claim')).toHaveLength(1)
  }
  await journal.close()
}, 20000)

test('actual journal handle is closed before replace and subsequent append uses a distinct reopened handle', async () => {
  const dir = await directory()
  const script = join(dir, 'handle-lifetime.ts')
  await writeFile(
    script,
    `import {open,stat} from 'node:fs/promises'; import assert from 'node:assert/strict'; import {InboundJournal} from ${JSON.stringify(import.meta.resolve('./inbound-journal.ts'))};
    const probe=await open(${JSON.stringify(join(dir, 'probe'))},'w');const prototype=Object.getPrototypeOf(probe);const originalSync=prototype.sync;await probe.close();
    const handles=[];let closedBeforeReplace=false;let firstHandle;
    const journal=new InboundJournal(${JSON.stringify(dir)},{epoch:'one',onDurability:phase=>{if(phase==='handle-closed'){assert.ok(firstHandle,'No real journal handle captured');assert.equal(firstHandle.fd,-1,'Compaction must actually close journal handle before replace');closedBeforeReplace=true}}});
    prototype.sync=async function(){const metadata=await this.stat();if(metadata.isFile()){const current=await stat(journal.path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error});if(current && current.ino===metadata.ino && !handles.includes(this))handles.push(this)}return originalSync.call(this)};
    try {
      const first=await journal.admit(${JSON.stringify(input)});firstHandle=handles[0];assert.ok(firstHandle);await journal.compact();assert.equal(closedBeforeReplace,true);
      const after=await journal.admit({...${JSON.stringify(input)},messageId:'after'});assert.equal(handles.length,2);assert.notEqual(handles[1],firstHandle);assert.notEqual(handles[1].fd,-1);assert.equal(firstHandle.fd,-1);
      await journal.close();assert.equal(handles[1].fd,-1);prototype.sync=originalSync;
      const boot=new InboundJournal(${JSON.stringify(dir)},{epoch:'two'});await boot.initialize();assert.deepEqual(boot.list().map(row=>row.inputId).sort(),[first.inputId,after.inputId].sort());console.log(JSON.stringify({closedBeforeReplace,distinctHandles:handles[0]!==handles[1],messages:boot.list().map(row=>row.reference.messageId).sort()}));await boot.close();
    } finally {prototype.sync=originalSync;await journal.close()}`,
  )
  const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toEqual({ closedBeforeReplace: true, distinctHandles: true, messages: ['after', 'm'] })
})

const slackMessage = (adapter: 'slack' | 'slack-bot' = 'slack-bot'): InboundAdmission => ({
  accountIdentity: `${adapter}:T1:UBOT`,
  target: { adapter, workspace: 'T1', chat: 'C1', thread: null },
  principal: { kind: 'channel', adapter, workspace: 'T1', chat: 'C1', lastInboundAuthorId: 'U1' },
  messageId: '1700000000.000100',
  eventKind: 'message',
  revision: 'original',
  ownerSessionId: 'parent',
})

for (const adapter of ['slack', 'slack-bot'] as const) {
  for (const phase of ['admitted', 'closed', 'notice-owned'] as const) {
    for (const compacted of [false, true]) {
      test(`${adapter} legacy edited-only ${phase} row${compacted ? ' (compacted)' : ''} answers a later original delivery unchanged`, async () => {
        const dir = await directory()
        const message = slackMessage(adapter)
        const legacy = new InboundJournal(dir, { epoch: 'legacy' })
        // Schema-1 rows admitted under the per-edit policy carry the edit ts as their revision.
        const edited = await legacy.admit({ ...message, revision: '1700000001.000200' })
        if (phase === 'closed')
          await legacy.settle(legacy.resolve([edited.inputId]), { kind: 'delivered', decisionId: 'answer' })
        if (phase === 'notice-owned')
          await legacy.importPrepared(
            new RecoveryOutbox(dir, { epoch: 'legacy' }),
            await legacy.prepareNotice(legacy.resolve([edited.inputId]), message.target),
          )
        if (compacted) await legacy.compact()
        await legacy.close()
        const bytes = await readFile(legacy.path)
        const journal = new InboundJournal(dir, { epoch: 'new' })
        await journal.initialize()
        const row = journal.get(edited.inputId)!
        expect(row.phase).toBe(phase)
        expect(journal.lookupAdmission(message)).toEqual(row)
        expect(await journal.admit(message)).toEqual({
          kind: 'duplicate',
          inputId: edited.inputId,
          outcome: row.phase === 'closed' ? row.outcome : undefined,
        })
        expect(journal.list()).toEqual([row])
        expect(await readFile(journal.path)).toEqual(bytes)
        await journal.close()
      })
    }
  }
}

test('a Slack message is one admission across routing-thread shapes; its debt never follows the new thread', async () => {
  const dir = await directory()
  const message = slackMessage()
  const journal = new InboundJournal(dir)
  const root = await journal.admit(message)
  const before = journal.get(root.inputId)
  for (const thread of [message.messageId!, 'other-thread'])
    expect(await journal.admit({ ...message, target: { ...message.target, thread } })).toMatchObject({
      kind: 'duplicate',
      inputId: root.inputId,
    })
  expect(journal.get(root.inputId)).toEqual(before)
  const threadedDir = await directory()
  const threaded = new InboundJournal(threadedDir)
  const reply = await threaded.admit({ ...message, target: { ...message.target, thread: message.messageId! } })
  expect(await threaded.admit(message)).toMatchObject({ kind: 'duplicate', inputId: reply.inputId })
  expect(
    (
      await threaded.admit({
        ...message,
        messageId: '1700000002.000300',
        target: { ...message.target, thread: message.messageId! },
      })
    ).kind,
  ).toBe('accepted')
  // Racing deliveries of one message in different thread shapes serialize to one admission.
  const racingDir = await directory()
  const racing = new InboundJournal(racingDir)
  const results = await Promise.all([
    racing.admit(message),
    racing.admit({ ...message, target: { ...message.target, thread: message.messageId! } }),
  ])
  expect(results.map((r) => r.kind).sort()).toEqual(['accepted', 'duplicate'])
  expect(new Set(results.map((r) => r.inputId)).size).toBe(1)
  expect(racing.list()).toHaveLength(1)
  await Promise.all([journal.close(), threaded.close(), racing.close()])
})

test('a different author on the same Slack message is a conflict in lookup and admission, never a fresh slot', async () => {
  const dir = await directory()
  const message = slackMessage()
  const journal = new InboundJournal(dir)
  await journal.admit(message)
  const bytes = await readFile(journal.path)
  const impostor: InboundAdmission = {
    ...message,
    target: { ...message.target, thread: 'elsewhere' },
    revision: '1700000001.000200',
    principal: { kind: 'channel', adapter: 'slack-bot', workspace: 'T1', chat: 'C1', lastInboundAuthorId: 'U2' },
  }
  expect(() => journal.lookupAdmission(impostor)).toThrow('Conflicting duplicate admission principal')
  await expect(journal.admit(impostor)).rejects.toThrow('Conflicting duplicate admission principal')
  expect(await readFile(journal.path)).toEqual(bytes)
  expect(journal.health().available).toBe(true)
  expect((await journal.admit({ ...message, messageId: '1700000002.000300' })).kind).toBe('accepted')
  await journal.close()
})

test('Slack message namespaces stay independent; revision and thread do not; other identities keep exact dedupe', async () => {
  const dir = await directory()
  const message = slackMessage('slack')
  const journal = new InboundJournal(dir)
  const base = await journal.admit(message)
  const otherWorkspace = { ...message.target, workspace: 'T2' }
  const otherChat = { ...message.target, chat: 'C2' }
  const independent: InboundAdmission[] = [
    { ...message, accountIdentity: 'slack:T1:UOTHER' },
    { ...slackMessage('slack-bot'), accountIdentity: message.accountIdentity },
    { ...message, target: otherWorkspace, principal: { ...message.principal, workspace: 'T2' } as MatchableOrigin },
    { ...message, target: otherChat, principal: { ...message.principal, chat: 'C2' } as MatchableOrigin },
    { ...message, messageId: '1700000002.000300' },
    { ...message, eventKind: 'app_mention' },
  ]
  for (const admission of independent) expect((await journal.admit(admission)).kind).toBe('accepted')
  for (const admission of [
    { ...message, revision: '1700000001.000200' },
    { ...message, target: { ...message.target, thread: message.messageId! } },
  ])
    expect(await journal.admit(admission)).toMatchObject({ kind: 'duplicate', inputId: base.inputId })
  // Non-Slack revisions and Slack receipt-only identities keep exact-identity semantics.
  const discord: InboundAdmission = {
    ...message,
    accountIdentity: 'discord-bot:B',
    target: { adapter: 'discord-bot', workspace: 'G', chat: 'R', thread: null },
    principal: { kind: 'channel', adapter: 'discord-bot', workspace: 'G', chat: 'R', lastInboundAuthorId: 'U1' },
    messageId: 'M1',
  }
  const receiptOnly: InboundAdmission = { ...message, messageId: undefined, receiptId: 'R1' }
  for (const exact of [discord, receiptOnly]) {
    const first = await journal.admit(exact)
    expect(await journal.admit(exact)).toMatchObject({ kind: 'duplicate', inputId: first.inputId })
    expect((await journal.admit({ ...exact, revision: 'second' })).kind).toBe('accepted')
    expect((await journal.admit({ ...exact, target: { ...exact.target, thread: 'other' } })).kind).toBe('accepted')
  }
  expect(journal.list()).toHaveLength(1 + independent.length + 2 * 3)
  await journal.close()
})

test('multiple legacy revisions keep every row and receipt; a new delivery resolves deterministically and stale claims still fail', async () => {
  const dir = await directory()
  const message = slackMessage()
  const path = join(dir, 'channels', 'inbound-continuity.jsonl')
  // Two revisions admitted under the previous per-edit policy, with identical acceptance times.
  const rows = ['1700000001.000200', '1700000003.000400'].map((revision) => {
    const identity = JSON.stringify([
      dirname(dirname(path)),
      message.accountIdentity,
      channelKeyId(message.target),
      message.messageId,
      message.eventKind,
      revision,
    ])
    const inputId = createHash('sha256')
      .update(JSON.stringify(['inbound', identity]))
      .digest('hex')
    return {
      schemaVersion: 1,
      inputId,
      identity,
      generation: 1,
      accountIdentity: message.accountIdentity,
      target: message.target,
      principal: message.principal,
      epoch: 'legacy',
      acceptedAt: 1_000,
      phase: 'admitted',
      reference: { messageId: message.messageId },
      sourceParentSessionId: 'parent',
    }
  })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    rows
      .map((row, index) =>
        JSON.stringify({
          schemaVersion: 1,
          seq: index + 1,
          transitionId: `admit:${row.inputId}`,
          epoch: 'legacy',
          type: 'admitted',
          changes: [{ expected: { inputId: row.inputId, generation: 0 }, row }],
          backgroundChanges: [],
        }),
      )
      .map((line) => `${line}\n`)
      .join(''),
  )
  const [representative, other] = rows.map((row) => row.inputId).sort()
  if (!representative || !other) throw new Error('Expected two seeded legacy rows')
  const journal = new InboundJournal(dir, { epoch: 'one' })
  await journal.initialize()
  expect(
    journal
      .list()
      .map((row) => row.inputId)
      .sort(),
  ).toEqual([representative, other])
  const owner = { turnId: 'turn', ownerSessionId: 'parent', target: message.target }
  await journal.claim([{ inputId: representative, generation: 1 }], owner, [], 'claim-representative')
  const outbox = new RecoveryOutbox(dir, { epoch: 'one' })
  const transfer = await journal.prepareNotice([{ inputId: other, generation: 1 }], message.target)
  await journal.importPrepared(outbox, transfer)
  await journal.compact()
  await journal.close()

  const boot = new InboundJournal(dir, { epoch: 'two' })
  await boot.initialize()
  const retained = boot.list()
  expect(retained).toHaveLength(2)
  // The representative is chosen per message: a new original, an exact redelivery of either legacy
  // revision, and any thread shape all resolve to the same row and outcome.
  const representativeRow = boot.get(representative)!
  const revisions = rows.map((row) => JSON.parse(row.identity)[5] as string)
  for (const revision of ['original', ...revisions])
    for (const thread of [null, message.messageId!]) {
      const delivery = { ...message, revision, target: { ...message.target, thread } }
      expect(await boot.admit(delivery)).toEqual({ kind: 'duplicate', inputId: representative, outcome: undefined })
      expect(boot.lookupAdmission(delivery)).toEqual(representativeRow)
    }
  expect(representativeRow.phase).toBe('turn-owned')
  expect(boot.get(other)?.phase).toBe('notice-owned')
  expect(boot.list()).toEqual(retained)
  expect(await boot.prepareNotice([{ inputId: other, generation: 1 }], message.target)).toEqual(transfer)
  // The retained claim receipt still binds its identity; the old epoch's ownership is superseded.
  await expect(
    boot.claim([{ inputId: representative, generation: 1 }], owner, [], 'claim-representative'),
  ).rejects.toThrow('superseded')
  expect(boot.get(representative)).toMatchObject({ phase: 'turn-owned', generation: 2, target: message.target })
  await expect(boot.claim([{ inputId: representative, generation: 1 }], { ...owner, turnId: 'late' })).rejects.toThrow(
    'coverage',
  )
  await boot.close()
})

const tombstoneFields = [
  'inputId',
  'generation',
  'phase',
  'acceptedAt',
  'reference',
  'principalDigest',
  'messageKey',
  'outcome',
  'noticeDeliveryId',
]
type SnapshotLine = {
  schemaVersion: number
  type: string
  notices: Array<{ deliveryId: string }>
  open: Array<Record<string, unknown>>
  closed: Array<Record<string, unknown>>
  decisions: unknown[]
  receipts: Array<{ transitionId: string; type: string; epoch?: string }>
}
async function firstLine(journal: InboundJournal): Promise<SnapshotLine> {
  return JSON.parse((await readFile(journal.path, 'utf8')).split('\n')[0]!)
}
const slackTs = (index: number) => `1700000000.${String(index).padStart(6, '0')}`

test('production maintenance compacts by new growth into minimal tombstones; compaction and two reboots keep every dedupe and transition fence', async () => {
  const dir = await directory()
  const message = slackMessage()
  const owner = { turnId: 'turn', ownerSessionId: 'parent', target: message.target }
  let rewrites = 0
  const boot = async (epoch: string) => {
    const journal = new InboundJournal(dir, {
      epoch,
      compactionFloorBytes: 16 * 1024,
      onDurability: (phase) => {
        if (phase === 'replaced') rewrites++
      },
    })
    await journal.initialize()
    journal.startMaintenance()
    await journal.flush()
    return journal
  }
  // Router-shaped work: an unnamed claim and a fresh UUID decision for the terminal outcome.
  const answer = async (journal: InboundJournal, index: number) => {
    const admitted = await journal.admit({ ...message, messageId: slackTs(index) })
    if (admitted.kind !== 'accepted') throw new Error('Expected a fresh admission')
    const claimed = await journal.claim([{ inputId: admitted.inputId, generation: 1 }], {
      ...owner,
      turnId: `turn-${index}`,
    })
    await journal.settle(claimed.inboundRefs, { kind: 'delivered', decisionId: randomUUID() })
    return admitted.inputId
  }
  let journal = await boot('one')
  const answered: string[] = []
  for (let index = 0; index < 60; index++) answered.push(await answer(journal, index))
  const kept = await journal.admit({ ...message, messageId: '1700000099.000001' })
  const named = await journal.admit({ ...message, messageId: '1700000099.000002' })
  if (kept.kind !== 'accepted' || named.kind !== 'accepted') throw new Error('Expected fresh admissions')
  const keptRefs = [{ inputId: kept.inputId, generation: 1 }]
  const claim = await journal.claim(keptRefs, owner, [], 'claim-kept')
  const outcome = { kind: 'delivered' as const, decisionId: 'answer-named' }
  const settled = await journal.settle([{ inputId: named.inputId, generation: 1 }], outcome)
  await journal.flush()
  expect(rewrites).toBeGreaterThan(0)

  const expectFences = async (current: InboundJournal, rebooted: boolean) => {
    const original = slackTs(0)
    for (const delivery of [
      { ...message, messageId: original, revision: '1700000001.000200' },
      { ...message, messageId: original, target: { ...message.target, thread: original } },
    ])
      expect(await current.admit(delivery)).toMatchObject({
        kind: 'duplicate',
        inputId: answered[0],
        outcome: { kind: 'delivered' },
      })
    const impostor: InboundAdmission = {
      ...message,
      messageId: original,
      target: { ...message.target, thread: 'elsewhere' },
      principal: { ...message.principal, lastInboundAuthorId: 'U2' } as MatchableOrigin,
    }
    expect(() => current.lookupAdmission(impostor)).toThrow('Conflicting duplicate admission principal')
    await expect(current.admit(impostor)).rejects.toThrow('Conflicting duplicate admission principal')
    expect(await current.settle([{ inputId: named.inputId, generation: 1 }], outcome)).toEqual(settled)
    await expect(
      current.settle([{ inputId: named.inputId, generation: 1 }], { ...outcome, kind: 'intentionally-suppressed' }),
    ).rejects.toThrow('Conflicting duplicate')
    if (rebooted) await expect(current.claim(keptRefs, owner, [], 'claim-kept')).rejects.toThrow('superseded')
    else expect(await current.claim(keptRefs, owner, [], 'claim-kept')).toEqual(claim)
    await expect(current.claim(keptRefs, { ...owner, turnId: 'other' }, [], 'claim-kept')).rejects.toThrow(
      'Conflicting duplicate',
    )
    await expect(current.claim(keptRefs, { ...owner, turnId: 'late' })).rejects.toThrow('coverage')
    await expect(
      current.settle([{ inputId: answered[0]!, generation: 2 }], { kind: 'delivered', decisionId: 'late' }),
    ).rejects.toThrow('coverage')
    for (const row of current.list().filter((row) => row.phase === 'closed'))
      expect(Object.keys(row).filter((key) => !tombstoneFields.includes(key))).toEqual([])
  }
  await expectFences(journal, false)
  let snapshot = await firstLine(journal)
  expect(snapshot).toMatchObject({ schemaVersion: 2, type: 'snapshot', decisions: [], notices: [] })
  expect(snapshot.closed.length).toBeGreaterThan(0)
  for (const row of snapshot.closed) {
    expect(Object.keys(row).filter((key) => !tombstoneFields.includes(key))).toEqual([])
    expect(row.messageKey).toMatch(/^[a-f0-9]{64}$/)
  }
  // Admission and journal-minted claim IDs are answered by the rows themselves; no receipt keeps them.
  expect(
    snapshot.receipts.filter(
      (r) => r.transitionId.startsWith('admit:') || (r.type === 'turn-claimed' && r.transitionId !== 'claim-kept'),
    ),
  ).toEqual([])
  // A maintenance check without new growth never rewrites.
  const settledRewrites = rewrites
  journal.startMaintenance()
  await journal.flush()
  expect(rewrites).toBe(settledRewrites)
  await journal.close()

  const bytes = await readFile(journal.path)
  const inode = (await stat(journal.path)).ino
  journal = await boot('two')
  expect(rewrites).toBe(settledRewrites)
  expect(await readFile(journal.path)).toEqual(bytes)
  expect((await stat(journal.path)).ino).toBe(inode)
  await expectFences(journal, true)
  for (let index = 60; rewrites === settledRewrites && index < 2_000; index++)
    answered.push(await answer(journal, index))
  await journal.flush()
  expect(rewrites).toBeGreaterThan(settledRewrites)
  snapshot = await firstLine(journal)
  // The ended epoch's bare-UUID decisions were normalized away at boot; caller-named fences remain.
  expect(
    snapshot.receipts
      .filter((r) => r.epoch === 'one')
      .map((r) => r.transitionId)
      .sort(),
  ).toEqual(['answer-named', 'claim-kept'])
  await journal.close()

  journal = await boot('three')
  await expectFences(journal, true)
  expect(openRow(journal.get(kept.inputId))).toMatchObject({ phase: 'turn-owned', claim: { turnId: 'turn' } })
  await journal.close()
}, 30000)

test('a frozen notice is kept once per delivery and still validates, acknowledges, reimports and repeats after closure and compaction', async () => {
  const dir = await directory()
  const journal = new InboundJournal(dir, { epoch: 'one' })
  const outbox = new RecoveryOutbox(dir, { epoch: 'one' })
  const first = await journal.admit({ ...input, ownerSessionId: 'parent' })
  const second = await journal.admit({ ...input, messageId: 'second', ownerSessionId: 'parent' })
  const refs = [
    { inputId: first.inputId, generation: 1 },
    { inputId: second.inputId, generation: 1 },
  ]
  const transfer = await journal.prepareNotice(refs, target)
  const imported = await journal.importPrepared(outbox, transfer)
  expect(await journal.validateNotice(imported)).toBe('open')
  const lease = await outbox.lease(imported.deliveryId, imported.generation)
  if (!lease) throw new Error('Notice lease unavailable')
  expect(await outbox.delivered(imported.deliveryId, lease, { confirmedAt: Date.now() })).toBe(true)
  const delivered = (await outbox.get(imported.deliveryId))!
  await journal.acknowledgeNotice(delivered)
  for (const ref of refs)
    expect(closedRow(journal.get(ref.inputId))).toMatchObject({
      noticeDeliveryId: transfer.deliveryId,
      outcome: { kind: 'delivered', deliveryId: transfer.deliveryId },
    })
  await journal.compact()
  await journal.close()
  const snapshot = await firstLine(journal)
  expect(snapshot.notices.map((notice) => notice.deliveryId)).toEqual([transfer.deliveryId])
  expect(snapshot.closed.map((row) => row.noticeDeliveryId)).toEqual([transfer.deliveryId, transfer.deliveryId])

  for (const epoch of ['two', 'three']) {
    const boot = new InboundJournal(dir, { epoch })
    await boot.initialize()
    const bytes = await readFile(boot.path)
    expect(await boot.validateNotice(delivered)).toBe('resolved')
    await boot.acknowledgeNotice(delivered)
    expect(await boot.importPrepared(outbox, transfer)).toMatchObject({ deliveryId: transfer.deliveryId })
    expect(await boot.prepareNotice(refs, target)).toEqual(transfer)
    await expect(boot.prepareNotice(refs, target, [], undefined, 'live-turn-ended')).rejects.toThrow(
      'Conflicting duplicate notice preparation',
    )
    // A record whose frozen payload differs is never accepted as this delivery's authority.
    await expect(boot.validateNotice({ ...delivered, createdAt: delivered.createdAt + 1 })).rejects.toThrow(
      'Invalid inbound notice authority',
    )
    expect(await readFile(boot.path)).toEqual(bytes)
    await boot.close()
  }
})

test('a live-turn-ended transfer freezes its own notice; restart preparation keeps its original identity', async () => {
  const journal = new InboundJournal(await directory(), { epoch: 'one' })
  const transfers: RecoveryRecord[] = []
  for (const cause of ['live-turn-ended', undefined] as const) {
    const admitted = await journal.admit({ ...input, messageId: cause ?? 'restart', ownerSessionId: 'parent' })
    const refs = [{ inputId: admitted.inputId, generation: 1 }]
    const transfer = await journal.prepareNotice(refs, target, [], 'parent', cause)
    expect(await journal.prepareNotice(refs, target, [], 'parent', cause)).toEqual(transfer)
    await expect(
      journal.prepareNotice(refs, target, [], 'parent', cause ? 'restart' : 'live-turn-ended'),
    ).rejects.toThrow('Conflicting duplicate notice preparation')
    // Either cause keeps the transfer identity derived from the covered refs alone.
    expect(transfer.transferId).toBe(
      createHash('sha256')
        .update(`["inbound-transfer",[{"generation":1,"inputId":"${admitted.inputId}"}],[]]`)
        .digest('hex'),
    )
    transfers.push(transfer)
  }
  await journal.close()
  const [ended, restarted] = transfers
  expect(restarted).toMatchObject({ schemaVersion: 1, templateVersion: 1, locale: 'en', text: RECOVERY_NOTICE_TEXT })
  expect(restarted).not.toHaveProperty('cause')
  expect(ended).toMatchObject({ schemaVersion: 2, cause: 'live-turn-ended' })
  expect(ended!.text).not.toBe(RECOVERY_NOTICE_TEXT)
})

test('a legacy full-row snapshot and decision log fold once into tombstones and compact to the minimal shape', async () => {
  const dir = await directory()
  const message = slackMessage()
  const legacy = new InboundJournal(dir, { epoch: 'legacy' })
  const outbox = new RecoveryOutbox(dir, { epoch: 'legacy' })
  const answered = await legacy.admit(message)
  const claimed = await legacy.claim([{ inputId: answered.inputId, generation: 1 }], {
    turnId: 'turn',
    ownerSessionId: 'parent',
    target: message.target,
  })
  await legacy.settle(claimed.inboundRefs, { kind: 'delivered', decisionId: randomUUID() })
  const noticed = await legacy.admit({ ...message, messageId: '1700000002.000300' })
  const transfer = await legacy.prepareNotice([{ inputId: noticed.inputId, generation: 1 }], message.target)
  const imported = await legacy.importPrepared(outbox, transfer)
  await legacy.suppressNoticeCoverage(imported, { decisionId: 'stop:legacy', reason: 'user-stop' })
  const open = await legacy.admit({ ...message, messageId: '1700000003.000400' })
  await legacy.close()
  // The pre-tombstone snapshot shape: every row in full, with one bare-UUID and one named receipt.
  type LegacyLine = { seq: number; changes?: Array<{ row: { inputId: string } }> }
  const lines: LegacyLine[] = (await readFile(legacy.path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const rows = new Map<string, unknown>()
  for (const line of lines) for (const change of line.changes ?? []) rows.set(change.row.inputId, change.row)
  const receipt = (transitionId: string, seq: number) => ({
    transitionId,
    seq,
    type: 'turn-claimed',
    decisionDigest: 'a'.repeat(64),
    payloadDigest: 'b'.repeat(64),
    inboundRefs: [{ inputId: open.inputId, generation: 1 }],
    backgroundRefs: [],
  })
  const legacySnapshot = {
    schemaVersion: 1,
    seq: lines.at(-1)!.seq,
    type: 'snapshot',
    rows: [...rows.values()],
    decisions: [],
    receipts: [receipt(randomUUID(), 1), receipt('claim-legacy', 2)],
  }
  await writeFile(legacy.path, `${JSON.stringify(legacySnapshot)}\n`)
  const bytes = await readFile(legacy.path)

  const boot = new InboundJournal(dir, { epoch: 'new' })
  await boot.initialize()
  expect(await readFile(boot.path)).toEqual(bytes)
  expect(closedRow(boot.get(answered.inputId))).not.toHaveProperty('principal')
  expect(closedRow(boot.get(noticed.inputId)).noticeDeliveryId).toBe(transfer.deliveryId)
  expect(openRow(boot.get(open.inputId)).principal).toEqual(message.principal)
  expect(await boot.admit({ ...message, revision: 'edited' })).toMatchObject({
    kind: 'duplicate',
    inputId: answered.inputId,
    outcome: { kind: 'delivered' },
  })
  expect(await boot.validateNotice(imported)).toBe('resolved')
  await boot.compact()
  await boot.close()
  const snapshot = await firstLine(boot)
  expect(snapshot).toMatchObject({ schemaVersion: 2, notices: [{ deliveryId: transfer.deliveryId }] })
  expect(snapshot.open.map((row) => row.inputId)).toEqual([open.inputId])
  expect(snapshot.closed.map((row) => row.inputId).sort()).toEqual([answered.inputId, noticed.inputId].sort())
  // The bare UUID from the ended legacy epoch is unreachable; the named receipt is kept as it was.
  expect(snapshot.receipts.map((r) => r.transitionId)).toEqual(['claim-legacy'])
  const again = new InboundJournal(dir, { epoch: 'again' })
  await again.initialize()
  expect(again.lookupAdmission({ ...message, target: { ...message.target, thread: message.messageId! } })).toEqual(
    again.get(answered.inputId),
  )
  expect(await again.validateNotice(imported)).toBe('resolved')
  await again.close()
})

test('the boot pass streams chunk-spanning multibyte lines, truncates only a torn tail and freezes on an invalid complete line', async () => {
  const dir = await directory()
  const journal = new InboundJournal(dir, { epoch: 'one' })
  const korean = '확인해볼게요'.repeat(60)
  const ids: string[] = []
  for (let index = 0; index < 120; index++)
    ids.push((await journal.admit({ ...input, messageId: `${korean}-${index}` })).inputId)
  await journal.close()
  const valid = await readFile(journal.path)
  expect(valid.length).toBeGreaterThan(4 * 64 * 1024)
  // A torn append that stops inside a multibyte character.
  const torn = Buffer.from(`{"schemaVersion":1,"seq":121,"note":"${korean}`)
  await appendFile(journal.path, torn.subarray(0, torn.length - 1))
  const boot = new InboundJournal(dir, { epoch: 'two' })
  await boot.initialize()
  expect(await readFile(boot.path)).toEqual(valid)
  expect(
    boot
      .list()
      .map((row) => row.inputId)
      .sort(),
  ).toEqual([...ids].sort())
  await boot.close()
  // A complete line that is not valid UTF-8 is corruption: freeze and keep every byte.
  const corrupt = Buffer.from(valid)
  const lastLine = corrupt.lastIndexOf(10, corrupt.length - 2) + 1
  corrupt[corrupt.indexOf('확', lastLine)] = 0xff
  await writeFile(boot.path, corrupt)
  const background = new BackgroundObligationStore(dir, { epoch: 'three' })
  const frozen = new InboundJournal(dir, { backgroundObligations: background })
  await expect(frozen.initialize()).rejects.toThrow()
  expect(await readFile(boot.path)).toEqual(corrupt)
  expect(() => background.assertAvailable()).toThrow('frozen')
  await frozen.close()
})

test('maintenance lifecycle: close skips a queued compaction, waits for one in progress, and a failed compaction freezes dependents', async () => {
  const seed = async (dir: string) => {
    const journal = new InboundJournal(dir, { epoch: 'seed' })
    for (let index = 0; index < 4; index++) await journal.admit({ ...input, messageId: `m${index}` })
    await journal.close()
    return readFile(journal.path)
  }
  const temps = async (dir: string) => (await readdir(join(dir, 'channels'))).filter((name) => name.endsWith('.tmp'))

  // Queued but not started: close() wins and the journal is left exactly as it was.
  const queuedDir = await directory()
  const queuedBytes = await seed(queuedDir)
  const queued = new InboundJournal(queuedDir, { epoch: 'queued', compactionFloorBytes: 1 })
  await queued.initialize()
  queued.startMaintenance()
  await queued.close()
  expect(await readFile(queued.path)).toEqual(queuedBytes)

  // In progress: close() waits for the reopened handle and then releases the writer.
  const runningDir = await directory()
  await seed(runningDir)
  let paused!: () => void
  let resume!: () => void
  const reached = new Promise<void>((resolve) => {
    paused = resolve
  })
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  const running = new InboundJournal(runningDir, {
    epoch: 'running',
    compactionFloorBytes: 1,
    async onDurability(phase) {
      if (phase !== 'temp-synced') return
      paused()
      await gate
    },
  })
  await running.initialize()
  running.startMaintenance()
  await reached
  const closing = running.close()
  // The paused compaction holds the writer queue, so close() cannot have settled yet.
  expect(await Promise.race([closing.then(() => 'closed'), Promise.resolve('waiting')])).toBe('waiting')
  resume()
  await closing
  expect(running.health().available).toBe(false)
  expect(await firstLine(running)).toMatchObject({ schemaVersion: 2, type: 'snapshot' })
  const successor = new InboundJournal(runningDir, { epoch: 'successor' })
  expect((await successor.admit({ ...input, messageId: 'm0' })).kind).toBe('duplicate')
  await successor.close()

  // Failure before replace removes only its own temp file; failure after replace keeps the installed
  // snapshot. Either way the writer, cached reads and dependent background progress freeze.
  for (const boundary of ['temp-synced', 'replaced'] as const) {
    const dir = await directory()
    const bytes = await seed(dir)
    const failures: unknown[] = []
    const background = new BackgroundObligationStore(dir, { epoch: boundary })
    const journal = new InboundJournal(dir, {
      backgroundObligations: background,
      compactionFloorBytes: 1,
      onError: (error) => failures.push(error),
      onDurability(phase) {
        if (phase === boundary) throw new Error(`compaction failed at ${boundary}`)
      },
    })
    await journal.initialize()
    journal.startMaintenance()
    await journal.flush()
    expect(failures).toHaveLength(1)
    expect(journal.health().available).toBe(false)
    expect(() => journal.list()).toThrow('frozen')
    expect(() => background.assertAvailable()).toThrow('frozen')
    await expect(journal.admit({ ...input, messageId: 'blocked' })).rejects.toThrow('frozen')
    expect(await temps(dir)).toEqual([])
    if (boundary === 'temp-synced') expect(await readFile(journal.path)).toEqual(bytes)
    else expect(await firstLine(journal)).toMatchObject({ schemaVersion: 2, type: 'snapshot' })
    await journal.close()
    const reboot = new InboundJournal(dir, { epoch: `${boundary}-reboot` })
    await reboot.initialize()
    expect(reboot.list()).toHaveLength(4)
    await reboot.close()
  }
})

test('a compaction swap keeps reads and dependents available, holds writes until reopen, and a failed reopen freezes', async () => {
  const hold = () => {
    let paused!: () => void
    let resume!: () => void
    const reached = new Promise<void>((resolve) => {
      paused = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    return { reached, gate, paused: () => paused(), resume: () => resume() }
  }
  for (const held of ['handle-closed', 'replaced', 'directory-synced'] as const) {
    const dir = await directory()
    const events: string[] = []
    const swap = hold()
    const background = new BackgroundObligationStore(dir, { epoch: held })
    const journal = new InboundJournal(dir, {
      backgroundObligations: background,
      async onDurability(phase, record) {
        const type = record && typeof record === 'object' && 'type' in record ? String(record.type) : undefined
        events.push(phase === 'append-written' ? `append:${type}` : phase)
        if (phase !== held) return
        swap.paused()
        await swap.gate
      },
    })
    const answered = await journal.admit(input)
    await journal.settle([{ inputId: answered.inputId, generation: 1 }], { kind: 'delivered', decisionId: 'answer' })
    const compaction = journal.compact()
    await swap.reached
    // Mid-swap there is no open handle, yet the healthy journal and its dependents stay readable.
    expect(journal.health().available).toBe(true)
    expect(() => journal.assertAvailable()).not.toThrow()
    expect(() => background.assertAvailable()).not.toThrow()
    expect(closedRow(journal.get(answered.inputId)).outcome.decisionId).toBe('answer')
    expect(journal.resolve([answered.inputId])).toEqual([{ inputId: answered.inputId, generation: 2 }])
    expect(journal.lookupAdmission({ ...input, revision: '1' })?.inputId).toBe(answered.inputId)
    const write = journal.admit({ ...input, messageId: 'during-swap' })
    expect(await Promise.race([write.then(() => 'written'), Promise.resolve('waiting')])).toBe('waiting')
    swap.resume()
    await compaction
    expect((await write).kind).toBe('accepted')
    // The queued admission went only through the installed file's reopened handle.
    expect(events.lastIndexOf('append:admitted')).toBeGreaterThan(events.indexOf('reopened'))
    await journal.close()
    const reboot = new InboundJournal(dir, { epoch: `${held}-reboot` })
    await reboot.initialize()
    expect(
      reboot
        .list()
        .map((row) => row.reference?.messageId)
        .sort(),
    ).toEqual(['during-swap', 'm'])
    await reboot.close()
  }

  // A swap whose reopen genuinely fails freezes the writer, dependents and queued work; nothing is
  // written through the closed handle or into the installed snapshot.
  const dir = await directory()
  const swap = hold()
  const failures: unknown[] = []
  const background = new BackgroundObligationStore(dir, { epoch: 'reopen-failure' })
  const journal = new InboundJournal(dir, {
    backgroundObligations: background,
    onError: (error) => failures.push(error),
    async onDurability(phase) {
      if (phase !== 'directory-synced') return
      swap.paused()
      await swap.gate
    },
  })
  const aborted: unknown[] = []
  journal.subscribeFailure((error) => aborted.push(error))
  await journal.admit(input)
  // Both outcomes are observed from creation, so neither expected rejection is ever unhandled.
  const compaction = Promise.allSettled([journal.compact()])
  await swap.reached
  const write = Promise.allSettled([journal.admit({ ...input, messageId: 'during-swap' })])
  // A regular file at the parent path makes traversal fail even where opening a directory succeeds.
  // Both the saved snapshot and the obstruction stay inside the fixture's cleanup directory.
  const parent = dirname(journal.path)
  const savedParent = `${parent}.installed`
  const installed = join(savedParent, basename(journal.path))
  await rename(parent, savedParent)
  await writeFile(parent, 'reopen blocked')
  swap.resume()
  const [compacted] = await compaction
  const [written] = await write
  expect(compacted).toMatchObject({ status: 'rejected', reason: expect.any(Error) })
  expect(written).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('frozen') } })
  expect(failures).toHaveLength(1)
  expect(aborted).toEqual(failures)
  expect(journal.health().available).toBe(false)
  expect(() => journal.get('0'.repeat(64))).toThrow('frozen')
  expect(() => background.assertAvailable()).toThrow('frozen')
  const lines = (await readFile(installed, 'utf8')).split('\n').filter(Boolean)
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]!)).toMatchObject({ schemaVersion: 2, type: 'snapshot' })
  await journal.close()
})
