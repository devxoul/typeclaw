import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile, appendFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MatchableOrigin } from '../permissions/resolve'
import { BackgroundObligationStore } from './background-obligations'
import { InboundJournal } from './inbound-journal'
import { RecoveryOutbox } from './recovery-outbox'
import type { ChannelKey } from './types'
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
  expect(boot.get(a.inputId)?.outcome?.decisionId).toBe('stop')
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
  expect(journal.get(a.inputId)?.outcome?.deliveryId).toBe(notice.deliveryId)
  await journal.close()
  const boot = new InboundJournal(dir, { epoch: 'again' })
  await boot.importOldEpoch(outbox)
  expect(await outbox.list()).toHaveLength(1)
  expect(await boot.validateNotice(notice)).toBe('resolved')
  await boot.close()
})

test('independent process death at compaction boundaries retains admissions and never appends an unlinked handle', async () => {
  const module = import.meta.resolve('./inbound-journal.ts')
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
    await killAtBoundary(
      dir,
      `import { InboundJournal } from ${JSON.stringify(module)}; const j = new InboundJournal(${JSON.stringify(dir)},{epoch:'child',onDurability:async phase => { if (phase === ${JSON.stringify(boundary)}) { console.log(${JSON.stringify(JSON.stringify(token))}); await Bun.stdin.text(); throw new Error('Crash boundary resumed'); } }}); await j.admit(${JSON.stringify(input)}); await j.compact();`,
      token,
    )
    const boot = new InboundJournal(dir, { epoch: 'boot' })
    await boot.initialize()
    expect((await boot.admit(input)).kind).toBe('duplicate')
    await boot.admit({ ...input, messageId: 'after' })
    await boot.close()
    const final = new InboundJournal(dir, { epoch: 'last' })
    await final.initialize()
    expect(
      final
        .list()
        .map((r) => r.reference?.messageId)
        .sort(),
    ).toEqual(['after', 'm'])
    await final.close()
  }
}, 20000)

test('duplicate decision identity remains strict after compaction, while generations and event revisions reject stale ownership', async () => {
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
  expect((await boot.admit({ ...input, eventKind: 'edit', revision: '1' })).kind).toBe('accepted')
  expect((await boot.admit({ ...input, eventKind: 'edit', revision: '2' })).kind).toBe('accepted')
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

test('complete schema/state/sequence corruption in retained snapshots is never truncated', async () => {
  type CorruptSnapshot = {
    rows: Array<{ target: { adapter: string }; principal: { kind: string }; generation: number; rawContent?: string }>
    receipts: Array<{ seq: number }>
    seq: number
  }
  const mutations = [
    (snapshot: CorruptSnapshot) => {
      snapshot.rows[0]!.target.adapter = 'unknown'
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.rows[0]!.principal.kind = 'unknown'
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.rows[0]!.generation = -1
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.receipts[0]!.seq = snapshot.seq + 1
    },
    (snapshot: CorruptSnapshot) => {
      snapshot.rows[0]!.rawContent = 'not allowed'
    },
  ]
  for (const mutate of mutations) {
    const dir = await directory()
    const journal = new InboundJournal(dir)
    await journal.admit(input)
    await journal.compact()
    await journal.close()
    const snapshot = JSON.parse(await readFile(journal.path, 'utf8'))
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
        const accepted=await j.admit(${JSON.stringify(input)}); let refs=[{inputId:accepted.inputId,generation:accepted.generation}];
        const child=await bg.accept({taskId:'child',parentSessionId:'p',accountIdentity:'bot',target,principal:${JSON.stringify(principal)}}); const ready=await bg.resultReady(child.obligationId); let backgroundRefs=[{obligationId:ready.obligationId,generation:ready.generation}];
        if(${JSON.stringify(operation)}==='move'){const claimed=await bg.withTargetLane(target,()=>j.claim(refs,{turnId:'first',target},backgroundRefs,'first-claim'));refs=claimed.inboundRefs;backgroundRefs=claimed.backgroundRefs;}
        armed=true; await bg.withTargetLane(target,async ()=>{if(${JSON.stringify(operation)}==='claim')await j.claim(refs,{turnId:'op',target},backgroundRefs,'op');else if(${JSON.stringify(operation)}==='move')await j.move(refs,{fromTurnId:'first',turnId:'op',target},backgroundRefs,'op');else await j.prepareNotice(refs,target,backgroundRefs)});`
      await killAtBoundary(dir, source, token)
      const bg = new BackgroundObligationStore(dir, { epoch: 'new' })
      const journal = new InboundJournal(dir, { backgroundObligations: bg })
      await journal.initialize()
      const row = journal.list()[0]!
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
  expect(journal.get(first.inputId)?.principal).toEqual(principal)
  expect(journal.get(second.inputId)?.principal).toEqual(secondPrincipal)
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
  expect(journal.list().map((row) => row.outcome?.decisionId)).toEqual(['multi-author-reply', 'multi-author-reply'])
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
