import { afterEach, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { peekRestartHandoff, writeRestartHandoff } from '@/agent/restart-handoff'
import { LegacyBackgroundHandoffReader } from '@/channels/background-handoff'
import { createLegacyRecoveryNotice } from '@/channels/background-handoff'
import { BackgroundObligationStore } from '@/channels/background-obligations'
import type { BackgroundAcceptance } from '@/channels/background-obligations'
import { RECOVERY_NOTICE_TEXT } from '@/channels/continuity-types'
import type { RecoveryRecord } from '@/channels/continuity-types'
import { InboundJournal } from '@/channels/inbound-journal'
import type { InboundAdmission } from '@/channels/inbound-journal'
import { saveChannelSessions } from '@/channels/persistence'
import { RecoveryDispatcher } from '@/channels/recovery-dispatcher'
import { RecoveryOutbox } from '@/channels/recovery-outbox'
import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig } from '@/channels/schema'
import { channelKeyId } from '@/channels/types'
import type { ChannelKey } from '@/channels/types'
import { noopPermissionService } from '@/permissions'
import type { MatchableOrigin } from '@/permissions/resolve'

import { bootBackgroundObligations, bootChannelRestartGreeting } from './background-handoff-boot'

const dirs: string[] = []
const journals: InboundJournal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const key = { adapter: 'discord-bot' as const, workspace: 'w', chat: 'c', thread: 't' }
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'obligation-migration-'))
  dirs.push(dir)
  const directory = join(dir, 'channels/background-handoffs')
  await mkdir(directory, { recursive: true })
  const id = createHash('sha256')
    .update(JSON.stringify([channelKeyId(key), 'parent']))
    .digest('hex')
  const record = {
    schemaVersion: 1 as const,
    generationId: randomUUID(),
    processEpoch: 'dead',
    parentSessionId: 'parent',
    key,
    parentChat: 'parent-room',
    triggeringAuthorId: 'author',
    tasks: [{ taskId: 'task', subagentName: 'worker', startedAt: 1, accountIdentity: 'actor' }],
  }
  await writeFile(join(directory, `${id}.json`), JSON.stringify(record))
  return { dir, record }
}

type Runtime = {
  dir: string
  inboundJournal: InboundJournal
  obligations: BackgroundObligationStore
  outbox: RecoveryOutbox
}
/** A new runtime models a new process: the previous runtime's single journal writer is gone. */
async function runtime(dir: string, epoch: string, outbox = new RecoveryOutbox(dir, { epoch })): Promise<Runtime> {
  for (const journal of journals.splice(0)) await journal.close()
  const obligations = new BackgroundObligationStore(dir, { epoch })
  const inboundJournal = new InboundJournal(dir, { backgroundObligations: obligations })
  journals.push(inboundJournal)
  return { dir, inboundJournal, obligations, outbox }
}
async function boot(
  dir: string,
  epoch: string,
  options: { outbox?: RecoveryOutbox; inventory?: LegacyBackgroundHandoffReader } = {},
): Promise<Runtime> {
  const booted = await runtime(dir, epoch, options.outbox)
  await bootBackgroundObligations({
    inboundJournal: booted.inboundJournal,
    obligations: booted.obligations,
    outbox: booted.outbox,
    inventory: options.inventory ?? new LegacyBackgroundHandoffReader(dir, { processEpoch: epoch }),
  })
  return booted
}

const room: ChannelKey = { adapter: 'discord-bot', workspace: 'guild', chat: 'room', thread: 'topic' }
const alice: MatchableOrigin = {
  kind: 'channel',
  adapter: 'discord-bot',
  workspace: 'guild',
  chat: 'room',
  lastInboundAuthorId: 'alice',
}
type OldRuntime = { journal: InboundJournal; background: BackgroundObligationStore }
/** The interrupted runtime: every row shares one acceptance time so timing cannot partition. */
async function oldRuntime(dir: string, run: (old: OldRuntime) => Promise<void>): Promise<void> {
  const background = new BackgroundObligationStore(dir, { epoch: 'old', now: () => 1_000 })
  const journal = new InboundJournal(dir, { backgroundObligations: background, now: () => 1_000 })
  try {
    await journal.initialize()
    await run({ journal, background })
  } finally {
    await journal.close()
  }
}
const admit = async (journal: InboundJournal, messageId: string, overrides: Partial<InboundAdmission> = {}) =>
  (
    await journal.admit({
      accountIdentity: 'bot',
      target: room,
      principal: alice,
      messageId,
      eventKind: 'message',
      revision: '0',
      ownerSessionId: 'parent',
      ...overrides,
    })
  ).inputId
const launch = (background: BackgroundObligationStore, taskId: string, overrides: Partial<BackgroundAcceptance> = {}) =>
  background.accept({
    taskId,
    parentSessionId: 'parent',
    accountIdentity: 'bot',
    target: room,
    principal: alice,
    ...overrides,
  })
const groups = (records: RecoveryRecord[]) => normalize(records.map((record) => record.covers.map((c) => c.id)))
const normalize = (ids: string[][]) =>
  ids.map((group) => [...group].sort()).sort((a, b) => a.join().localeCompare(b.join()))
async function newDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'continuity-boot-'))
  dirs.push(dir)
  return dir
}

/** Real router transport and dispatcher authority checks; only the adapter transport is controlled. */
async function dispatch(
  booted: Runtime,
  options: { sends: number; beforeWake?: (dispatcher: RecoveryDispatcher) => Promise<void> },
) {
  const sent: { deliveryId?: string; chat: string; text: string }[] = []
  const errors: unknown[] = []
  const settled = Promise.withResolvers<void>()
  const router = createChannelRouter({
    agentDir: booted.dir,
    backgroundObligations: booted.obligations,
    inboundJournal: booted.inboundJournal,
    recoveryOutbox: booted.outbox,
    configForAdapter: () => ({
      enabled: true,
      engagement: { trigger: ['dm'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }),
    permissions: { ...noopPermissionService, has: () => true },
    logger: { info() {}, warn() {}, error() {} },
  })
  router.registerRecoveryAdapter(room.adapter, {
    accountIdentity: async () => 'bot',
    cachedAccountIdentity: () => 'bot',
    reconcile: async () => ({ status: 'unreconcilable' }),
  })
  router.registerOutbound(room.adapter, async (message) => {
    sent.push({
      deliveryId: message.sendOptions?.accounting === 'recovery' ? message.sendOptions.deliveryId : undefined,
      chat: message.chat,
      text: message.text ?? '',
    })
    if (sent.length === options.sends) settled.resolve()
    return { ok: true, messageId: `notice-${sent.length}` }
  })
  const dispatcher = new RecoveryDispatcher(booted.outbox, router, {
    backgroundObligations: booted.obligations,
    inboundJournal: booted.inboundJournal,
    onError: (error) => {
      errors.push(error)
      // Expected-send runs must not hide an authority failure behind a timeout.
      if (options.sends === 0) settled.resolve()
      else settled.reject(error)
    },
  })
  try {
    await options.beforeWake?.(dispatcher)
    await dispatcher.wake()
    await settled.promise
  } finally {
    await dispatcher.stop()
    await router.stop()
  }
  return { sent, errors }
}

test('two admitted inputs and a compatible child recover as one notice, one send and one closing receipt', async () => {
  const dir = await newDirectory()
  let claimed = '',
    queued = '',
    child = ''
  await oldRuntime(dir, async ({ journal, background }) => {
    claimed = await admit(journal, 'first')
    queued = await admit(journal, 'second')
    await background.withTargetLane(room, () =>
      journal.claim(journal.resolve([claimed]), { turnId: 'turn', ownerSessionId: 'parent', target: room }),
    )
    const accepted = await launch(background, 'child')
    child = (await background.resultReady(accepted.obligationId))!.obligationId
  })
  const booted = await boot(dir, 'boot')
  const records = await booted.outbox.list()
  expect(records).toHaveLength(1)
  const notice = records[0]!
  expect(notice).toMatchObject({
    state: 'pending',
    attempts: 0,
    target: room,
    accountIdentity: 'bot',
    principal: alice,
    sourceParentSessionId: 'parent',
    text: RECOVERY_NOTICE_TEXT,
  })
  // Preparation advances each source exactly once; notice ownership keeps the covered generation.
  expect(notice.covers.map((c) => [c.store, c.id, c.generation]).sort()).toEqual(
    [
      ['background', child, 3],
      ['inbound', claimed, 3],
      ['inbound', queued, 2],
    ].sort(),
  )
  for (const id of [claimed, queued])
    expect(booted.inboundJournal.get(id)).toMatchObject({ phase: 'notice-owned', transfer: notice })
  const owned = (await booted.obligations.get(child))!
  expect(owned).toMatchObject({ phase: 'notice-owned', generation: 3, transfer: { deliveryId: notice.deliveryId } })
  expect(owned.applications.map((r) => [r.expectedGeneration, r.resultingGeneration])).toEqual([
    [1, 2],
    [2, 3],
  ])

  const { sent, errors } = await dispatch(booted, { sends: 1 })
  expect(errors).toEqual([])
  expect(sent).toEqual([{ deliveryId: notice.deliveryId, chat: room.chat, text: RECOVERY_NOTICE_TEXT }])
  for (const id of [claimed, queued])
    expect(booted.inboundJournal.get(id)).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'delivered', deliveryId: notice.deliveryId },
    })
  expect(await booted.obligations.get(child)).toMatchObject({
    phase: 'closed',
    outcome: { kind: 'delivered', deliveryId: notice.deliveryId },
  })
  // Closed sources are never reintroduced by a later boot.
  const later = await boot(dir, 'later')
  expect((await later.outbox.list()).map((r) => [r.deliveryId, r.state])).toEqual([[notice.deliveryId, 'delivered']])
})

test('authors, accounts, threads and captured parents partition notices; reordered principal keys do not', async () => {
  const dir = await newDirectory()
  const reordered = {
    lastInboundAuthorId: 'alice',
    chat: 'room',
    workspace: 'guild',
    adapter: 'discord-bot',
    kind: 'channel',
  } as const
  // A third order: whichever inbound row seeds the frozen principal, the child's serialization differs.
  const shuffled = {
    chat: 'room',
    kind: 'channel',
    lastInboundAuthorId: 'alice',
    adapter: 'discord-bot',
    workspace: 'guild',
  } as const
  const ids: Record<string, string> = {}
  await oldRuntime(dir, async ({ journal, background }) => {
    ids.base = await admit(journal, 'base')
    ids.reordered = await admit(journal, 'reordered', { principal: reordered })
    ids.reorderedChild = (await launch(background, 'reordered-child', { principal: shuffled })).obligationId
    ids.bob = await admit(journal, 'bob', { principal: { ...alice, lastInboundAuthorId: 'bob' } })
    ids.account = await admit(journal, 'account', { accountIdentity: 'other-bot' })
    ids.accountChild = (await launch(background, 'account-child', { accountIdentity: 'other-bot' })).obligationId
    ids.thread = await admit(journal, 'thread', { target: { ...room, thread: 'other-topic' } })
    ids.parent = await admit(journal, 'parent', { ownerSessionId: 'other-parent' })
    ids.lonely = (await launch(background, 'lonely-child', { parentSessionId: 'lonely-parent' })).obligationId
  })
  const booted = await boot(dir, 'boot')
  const records = await booted.outbox.list()
  expect(groups(records)).toEqual(
    normalize([
      [ids.base!, ids.reordered!, ids.reorderedChild!],
      [ids.bob!],
      [ids.account!, ids.accountChild!],
      [ids.thread!],
      [ids.parent!],
      [ids.lonely!],
    ]),
  )
  const by = (id: string) => records.find((r) => r.covers.some((c) => c.id === id))!
  expect(by(ids.account!).accountIdentity).toBe('other-bot')
  expect(by(ids.thread!).target.thread).toBe('other-topic')
  expect(by(ids.parent!).sourceParentSessionId).toBe('other-parent')
  expect(by(ids.lonely!)).toMatchObject({ sourceParentSessionId: 'lonely-parent', covers: [{ store: 'background' }] })
  // Dispatch authority accepts the reordered child as the same frozen principal.
  await booted.obligations.withTargetLane(room, async () =>
    expect(await booted.inboundJournal.validateNotice(by(ids.base!))).toBe('open'),
  )
})

test('a claimed parent supersedes the origin parent and the current mapping when grouping', async () => {
  const dir = await newDirectory()
  let moved = '',
    queued = '',
    claimedChild = '',
    originChild = ''
  await oldRuntime(dir, async ({ journal, background }) => {
    moved = await admit(journal, 'moved', { ownerSessionId: 'origin' })
    const accepted = await launch(background, 'claimed-child', { parentSessionId: 'origin' })
    const ready = (await background.resultReady(accepted.obligationId))!
    claimedChild = ready.obligationId
    await background.withTargetLane(room, () =>
      journal.claim(journal.resolve([moved]), { turnId: 'successor-turn', ownerSessionId: 'successor', target: room }, [
        { obligationId: ready.obligationId, generation: ready.generation },
      ]),
    )
    queued = await admit(journal, 'queued', { ownerSessionId: 'successor' })
    originChild = (await launch(background, 'origin-child', { parentSessionId: 'origin' })).obligationId
  })
  await saveChannelSessions(dir, [{ ...room, sessionId: 'current-mapping', participants: [] }])
  const records = await (await boot(dir, 'boot')).outbox.list()
  expect(groups(records)).toEqual(normalize([[moved, queued, claimedChild], [originChild]]))
  expect(records.find((r) => r.covers.length === 3)?.sourceParentSessionId).toBe('successor')
  expect(records.find((r) => r.covers.length === 1)?.sourceParentSessionId).toBe('origin')
})

test('multi-child partitions leave current-epoch work and closed sources untouched', async () => {
  const dir = await newDirectory()
  const ids: Record<string, string> = {}
  await oldRuntime(dir, async ({ journal, background }) => {
    ids.input = await admit(journal, 'input')
    ids.ready = (await background.resultReady((await launch(background, 'ready')).obligationId))!.obligationId
    ids.running = (await launch(background, 'running')).obligationId
    ids.answered = await admit(journal, 'answered')
    await journal.settle(journal.resolve([ids.answered]), { kind: 'delivered', decisionId: 'answered' })
    const done = await launch(background, 'done')
    await background.withTargetLane(room, () =>
      journal.settle(
        [],
        { kind: 'delivered', decisionId: 'done' },
        [{ obligationId: done.obligationId, generation: done.generation }],
        room,
      ),
    )
    ids.done = done.obligationId
  })
  const booted = await runtime(dir, 'boot')
  const current = await admit(booted.inboundJournal, 'current')
  const currentChild = (await launch(booted.obligations, 'current-child')).obligationId
  const answeredBefore = booted.inboundJournal.get(ids.answered!)
  await bootBackgroundObligations({
    inboundJournal: booted.inboundJournal,
    obligations: booted.obligations,
    outbox: booted.outbox,
    inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'boot' }),
  })
  expect(groups(await booted.outbox.list())).toEqual(normalize([[ids.input!, ids.ready!, ids.running!]]))
  expect(booted.inboundJournal.get(current)).toMatchObject({ phase: 'admitted', generation: 1 })
  expect(booted.inboundJournal.get(current)?.transfer).toBeUndefined()
  expect(await booted.obligations.get(currentChild)).toMatchObject({ phase: 'accepted', generation: 1 })
  expect(booted.inboundJournal.get(ids.answered!)).toEqual(answeredBefore)
  expect(await booted.obligations.get(ids.done!)).toMatchObject({ phase: 'closed', outcome: { decisionId: 'done' } })
})

test('issued singleton, mixed and legacy transfers keep identity; a late matching row gets its own notice', async () => {
  const { dir, record } = await setup()
  let mixed!: RecoveryRecord
  let singleton!: RecoveryRecord
  let late = ''
  await oldRuntime(dir, async ({ journal, background }) => {
    const input = await admit(journal, 'input')
    const child = (await background.resultReady((await launch(background, 'mixed-child')).obligationId))!
    mixed = await background.withTargetLane(room, () =>
      journal.prepareNotice(journal.resolve([input]), room, [
        { obligationId: child.obligationId, generation: child.generation },
      ]),
    )
    const prepared = await launch(background, 'singleton-child')
    singleton = (await background.prepareNotice(prepared.obligationId, prepared.generation))!.transfer!
    late = await admit(journal, 'late')
  })
  const first = await boot(dir, 'first')
  const issued = await first.outbox.list()
  expect(issued.map((r) => r.deliveryId).sort()).toEqual(
    [
      mixed.deliveryId,
      singleton.deliveryId,
      createLegacyRecoveryNotice(record).deliveryId,
      issued.find((r) => r.covers.some((c) => c.id === late))!.deliveryId,
    ].sort(),
  )
  expect(issued.find((r) => r.deliveryId === mixed.deliveryId)).toEqual(mixed)
  expect(issued.find((r) => r.deliveryId === singleton.deliveryId)).toEqual(singleton)
  expect(issued.find((r) => r.covers.some((c) => c.id === late))?.covers.map((c) => c.id)).toEqual([late])
  const second = await boot(dir, 'second')
  expect(await second.outbox.list()).toEqual(issued)
})

test('grouped stop suppresses every covered source while a different-parent partition still delivers', async () => {
  const dir = await newDirectory()
  let input = '',
    child = '',
    other = ''
  await oldRuntime(dir, async ({ journal, background }) => {
    input = await admit(journal, 'input')
    child = (await background.resultReady((await launch(background, 'child')).obligationId))!.obligationId
    other = await admit(journal, 'other', { ownerSessionId: 'other-parent' })
  })
  const booted = await boot(dir, 'boot')
  const records = await booted.outbox.list()
  const stopped = records.find((r) => r.sourceParentSessionId === 'parent')!
  const surviving = records.find((r) => r.sourceParentSessionId === 'other-parent')!
  expect(groups(records)).toEqual(normalize([[input, child], [other]]))
  const { sent } = await dispatch(booted, {
    sends: 1,
    beforeWake: (dispatcher) => dispatcher.suppressParent(room, 'parent'),
  })
  expect(sent.map((s) => s.deliveryId)).toEqual([surviving.deliveryId])
  expect(await booted.outbox.get(stopped.deliveryId)).toMatchObject({ state: 'suppressed' })
  expect(booted.inboundJournal.get(input)).toMatchObject({
    phase: 'closed',
    outcome: { kind: 'intentionally-suppressed', reason: 'user-stop' },
  })
  expect(await booted.obligations.get(child)).toMatchObject({
    phase: 'closed',
    outcome: { kind: 'intentionally-suppressed', reason: 'user-stop' },
  })
  expect(booted.inboundJournal.get(other)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
})

test('stop during a known background freeze appends nothing and keeps admission; a repaired boot closes the group once', async () => {
  const dir = await newDirectory()
  let input = '',
    child = ''
  await oldRuntime(dir, async ({ journal, background }) => {
    input = await admit(journal, 'input')
    child = (await background.resultReady((await launch(background, 'child')).obligationId))!.obligationId
  })
  const legacyKey = { ...room, chat: 'legacy-room' }
  const legacyDir = join(dir, 'channels/background-handoffs')
  await mkdir(legacyDir, { recursive: true })
  const legacyId = createHash('sha256')
    .update(JSON.stringify([channelKeyId(legacyKey), 'legacy-parent']))
    .digest('hex')
  await writeFile(
    join(legacyDir, `${legacyId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      generationId: randomUUID(),
      processEpoch: 'dead',
      parentSessionId: 'legacy-parent',
      key: legacyKey,
      triggeringAuthorId: 'alice',
      tasks: [{ taskId: 'legacy-task', subagentName: 'worker', startedAt: 1, accountIdentity: 'bot' }],
    }),
  )
  // Legacy migration fails after grouped staging issued the mixed notice: only background progress freezes.
  const booted = await runtime(dir, 'boot')
  const importing = booted.outbox.import.bind(booted.outbox)
  booted.outbox.import = async (record) => {
    if (record.covers.some((cover) => cover.store === 'inventory')) throw new Error('disk unavailable')
    return importing(record)
  }
  await expect(
    bootBackgroundObligations({
      inboundJournal: booted.inboundJournal,
      obligations: booted.obligations,
      outbox: booted.outbox,
      inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'boot' }),
    }),
  ).rejects.toThrow('disk unavailable')
  const mixed = (await booted.outbox.list())[0]!
  expect(mixed.covers.map((c) => c.id).sort()).toEqual([input, child].sort())
  const childPath = join(dir, 'channels/background-obligations', `${child}.json`)
  const journalBytes = await readFile(booted.inboundJournal.path)
  const childBytes = await readFile(childPath)
  const frozen = await dispatch(booted, {
    sends: 0,
    beforeWake: async (dispatcher) => {
      await expect(dispatcher.suppressParent(room, 'parent')).rejects.toThrow('frozen')
    },
  })
  expect(frozen.sent).toEqual([])
  expect(booted.inboundJournal.health().available).toBe(true)
  expect(await readFile(booted.inboundJournal.path)).toEqual(journalBytes)
  expect(await readFile(childPath)).toEqual(childBytes)
  expect(await booted.outbox.get(mixed.deliveryId)).toEqual(mixed)
  const unrelated = await admit(booted.inboundJournal, 'unrelated', { ownerSessionId: 'other-parent' })
  expect(booted.inboundJournal.get(unrelated)).toMatchObject({ phase: 'admitted' })

  const repaired = await boot(dir, 'repaired')
  expect(await repaired.outbox.get(mixed.deliveryId)).toEqual(mixed)
  const { sent } = await dispatch(repaired, {
    sends: 2,
    beforeWake: (dispatcher) => dispatcher.suppressParent(room, 'parent'),
  })
  expect(sent.map((s) => s.chat).sort()).toEqual(['legacy-room', 'room'])
  expect(await repaired.outbox.get(mixed.deliveryId)).toMatchObject({ state: 'suppressed' })
  expect(repaired.inboundJournal.get(input)).toMatchObject({ phase: 'closed', outcome: { reason: 'user-stop' } })
  const stopped = (await repaired.obligations.get(child))!
  expect(stopped).toMatchObject({ phase: 'closed', outcome: { reason: 'user-stop' } })
  expect(stopped.applications.filter((r) => r.transitionId === stopped.outcome!.decisionId)).toHaveLength(1)
  expect(repaired.inboundJournal.get(unrelated)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
})

const corruptions: Record<string, (row: Record<string, unknown> & { transfer: RecoveryRecord }) => void> = {
  principal: (row) => {
    row.principal = { ...alice, lastInboundAuthorId: 'mallory' }
  },
  account: (row) => {
    row.accountIdentity = 'other-bot'
  },
  generation: (row) => {
    row.generation = 1
  },
  'frozen payload': (row) => {
    row.transfer.covers[0]!.generation += 1
  },
}
for (const [field, corrupt] of Object.entries(corruptions)) {
  test(`corrupt journal ${field} fails closed before any transport`, async () => {
    const dir = await newDirectory()
    let issued = ''
    await oldRuntime(dir, async ({ journal, background }) => {
      issued = await admit(journal, 'issued')
      const transfer = await journal.prepareNotice(journal.resolve([issued]), room)
      await journal.importPrepared(new RecoveryOutbox(dir, { epoch: 'old' }), transfer)
      await admit(journal, 'pending')
      await launch(background, 'child')
      await journal.compact()
    })
    const path = join(dir, 'channels/inbound-continuity.jsonl')
    const snapshot = JSON.parse(await readFile(path, 'utf8'))
    corrupt(snapshot.rows.find((row: { inputId: string }) => row.inputId === issued))
    const bytes = `${JSON.stringify(snapshot)}\n`
    await writeFile(path, bytes)
    const outboxBefore = await new RecoveryOutbox(dir).list()
    const booted = await runtime(dir, 'boot')
    await expect(
      bootBackgroundObligations({
        inboundJournal: booted.inboundJournal,
        obligations: booted.obligations,
        outbox: booted.outbox,
        inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'boot' }),
      }),
    ).rejects.toThrow()
    expect(() => booted.obligations.assertAvailable()).toThrow('frozen')
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await booted.outbox.list()).toEqual(outboxBefore)
    const { sent, errors } = await dispatch(booted, { sends: 0 })
    expect(sent).toEqual([])
    expect(errors.length).toBeGreaterThan(0)
    expect(await booted.outbox.list()).toEqual(outboxBefore)
  })
}

test('corrupt child JSON stops grouped preparation instead of guessing partition independence', async () => {
  const dir = await newDirectory()
  let input = '',
    child = ''
  await oldRuntime(dir, async ({ journal, background }) => {
    input = await admit(journal, 'input')
    child = (await launch(background, 'child')).obligationId
  })
  const path = join(dir, 'channels/background-obligations', `${child}.json`)
  const row = JSON.parse(await readFile(path, 'utf8'))
  row.principal.kind = 'unknown'
  const bytes = `${JSON.stringify(row)}\n`
  await writeFile(path, bytes)
  const booted = await runtime(dir, 'boot')
  await expect(
    bootBackgroundObligations({
      inboundJournal: booted.inboundJournal,
      obligations: booted.obligations,
      outbox: booted.outbox,
      inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'boot' }),
    }),
  ).rejects.toThrow()
  expect(() => booted.obligations.assertAvailable()).toThrow('frozen')
  expect(await readFile(path, 'utf8')).toBe(bytes)
  expect(booted.inboundJournal.get(input)).toMatchObject({ phase: 'admitted', generation: 1 })
  expect(await booted.outbox.list()).toEqual([])
})

const bootWorker = `
import { LegacyBackgroundHandoffReader } from ${JSON.stringify(import.meta.resolve('../channels/background-handoff.ts'))};
import { BackgroundObligationStore } from ${JSON.stringify(import.meta.resolve('../channels/background-obligations.ts'))};
import { InboundJournal } from ${JSON.stringify(import.meta.resolve('../channels/inbound-journal.ts'))};
import { RecoveryOutbox } from ${JSON.stringify(import.meta.resolve('../channels/recovery-outbox.ts'))};
import { bootBackgroundObligations } from ${JSON.stringify(import.meta.resolve('./background-handoff-boot.ts'))};
const [dir, boundary] = process.argv.slice(-2);
const stdin = Bun.stdin.text();
const pause = async () => { console.log(JSON.stringify({ boundary })); await stdin; throw Error('crash boundary resumed'); };
const obligations = new BackgroundObligationStore(dir, { epoch: 'dying', onDurability: async (phase, row) => {
  if (phase !== 'directory-synced') return;
  if (boundary === 'partial-child-prepared' && row.phase === 'notice-prepared') await pause();
  if (boundary === 'partial-child-owned' && row.phase === 'notice-owned') await pause();
}});
const journal = new InboundJournal(dir, { backgroundObligations: obligations, onDurability: async (phase, record) => {
  if (phase !== 'append-synced') return;
  if (boundary === 'prepare-synced' && record.type === 'notice-prepared') await pause();
  if (boundary === 'mixed-applied' && record.type === 'mixed-applied') await pause();
}});
const outbox = new RecoveryOutbox(dir, { epoch: 'dying' });
const importing = outbox.import.bind(outbox);
outbox.import = async (record) => {
  if (boundary === 'before-import') await pause();
  const result = await importing(record);
  if (boundary === 'after-import') await pause();
  return result;
};
await bootBackgroundObligations({ inboundJournal: journal, obligations, outbox, inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'dying' }) });
throw Error('crash boundary not reached');
`

for (const boundary of [
  'prepare-synced',
  'partial-child-prepared',
  'mixed-applied',
  'before-import',
  'after-import',
  'partial-child-owned',
]) {
  test(`grouped boot death at ${boundary} converges on one transfer and full source closure over two boots`, async () => {
    const dir = await newDirectory()
    const ids: string[] = []
    await oldRuntime(dir, async ({ journal, background }) => {
      const claimed = await admit(journal, 'claimed')
      await background.withTargetLane(room, () =>
        journal.claim(journal.resolve([claimed]), { turnId: 'turn', ownerSessionId: 'parent', target: room }),
      )
      const ready = (await background.resultReady((await launch(background, 'ready')).obligationId))!
      ids.push(claimed, await admit(journal, 'queued'), ready.obligationId)
      ids.push((await launch(background, 'running')).obligationId)
    })
    const child = Bun.spawn([process.execPath, '--eval', bootWorker, dir, boundary], {
      cwd: join(import.meta.dir, '../..'),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const reader = child.stdout.getReader()
    try {
      let output = ''
      while (!output.includes('\n')) {
        const next = await reader.read()
        if (next.done) throw new Error(`Worker exited before ${boundary}: ${await new Response(child.stderr).text()}`)
        output += new TextDecoder().decode(next.value)
      }
      expect(JSON.parse(output.trim())).toEqual({ boundary })
      child.kill('SIGKILL')
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toBe('')
      // Windows TerminateProcess does not expose POSIX signal metadata.
      if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
    } finally {
      reader.releaseLock()
      child.kill('SIGKILL')
      await child.exited
    }
    const second = await boot(dir, 'second')
    const records = await second.outbox.list()
    expect(groups(records)).toEqual(normalize([ids]))
    const notice = records[0]!
    for (const cover of notice.covers) {
      const row =
        cover.store === 'inbound' ? second.inboundJournal.get(cover.id) : await second.obligations.get(cover.id)
      expect(row).toMatchObject({ phase: 'notice-owned', generation: cover.generation })
      expect(row?.transfer?.deliveryId).toBe(notice.deliveryId)
    }
    const third = await boot(dir, 'third')
    expect(await third.outbox.list()).toEqual(records)
    const { sent } = await dispatch(third, { sends: 1 })
    expect(sent.map((s) => s.deliveryId)).toEqual([notice.deliveryId])
    for (const id of ids) {
      const row = third.inboundJournal.get(id) ?? (await third.obligations.get(id))
      expect(row).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered', deliveryId: notice.deliveryId } })
    }
  }, 30_000)
}

for (const field of ['kind', 'adapter', 'workspace', 'chat', 'parentChat', 'lastInboundAuthorId'] as const) {
  test(`legacy migration freezes principal ${field} through preparation and reboot`, async () => {
    const { dir, record } = await setup()
    const reader = new LegacyBackgroundHandoffReader(dir, { processEpoch: 'first' })
    const claim = (await reader.claim())[0]!
    const notice = createLegacyRecoveryNotice(record)
    const changed = {
      ...notice,
      principal: {
        ...notice.principal,
        [field]: field === 'kind' ? 'tui' : field === 'adapter' ? 'slack-bot' : 'OTHER',
      },
    } as typeof notice
    await expect(reader.prepareRecovery(claim, changed)).rejects.toThrow()
    const prepared = await reader.prepareRecovery(claim, notice)
    await expect(reader.prepareRecovery(claim, changed)).rejects.toThrow()
    const { outbox, obligations } = await boot(dir, 'next')
    expect(await outbox.list()).toEqual([prepared])
    expect((await obligations.list())[0]!.principal).toEqual({
      kind: 'channel',
      adapter: key.adapter,
      workspace: key.workspace,
      chat: key.chat,
      parentChat: 'parent-room',
      lastInboundAuthorId: 'author',
    })
  })
}

for (const boundary of ['source-prepared', 'json-prepared', 'imported', 'json-owned', 'retired']) {
  test(`migration death ${boundary} preserves original transfer and JSON authority over two boots`, async () => {
    const { dir, record } = await setup()
    const expected = createLegacyRecoveryNotice(record)
    const worker = join(dir, 'worker.ts')
    const readerModule = new URL('../channels/background-handoff.ts', import.meta.url).href
    const storeModule = new URL('../channels/background-obligations.ts', import.meta.url).href
    const outboxModule = new URL('../channels/recovery-outbox.ts', import.meta.url).href
    await writeFile(
      worker,
      `
import {LegacyBackgroundHandoffReader} from ${JSON.stringify(readerModule)};
import {BackgroundObligationStore} from ${JSON.stringify(storeModule)};
import {RecoveryOutbox} from ${JSON.stringify(outboxModule)};
const dir=process.argv[2],boundary=process.argv[3],pause=async(point)=>{console.log(JSON.stringify({boundary:point}));await Bun.stdin.text();throw Error('crash boundary resumed without termination');};
const reader=new LegacyBackgroundHandoffReader(dir,{processEpoch:'first'});
const store=new BackgroundObligationStore(dir,{epoch:'first',onDurability:async(phase,row)=>{if(phase==='directory-synced'&&((boundary==='json-prepared'&&row.phase==='notice-prepared')||(boundary==='json-owned'&&row.phase==='notice-owned')))await pause(boundary);}});
const outbox=new RecoveryOutbox(dir,{epoch:'first'});
const prepare=reader.prepareRecovery.bind(reader);reader.prepareRecovery=async(...args)=>{const result=await prepare(...args);if(boundary==='source-prepared')await pause('source-prepared');return result;};
const imported=outbox.import.bind(outbox);outbox.import=async(record)=>{const result=await imported(record);if(boundary==='imported')await pause('imported');return result;};
const retire=reader.retire.bind(reader);reader.retire=async(...args)=>{await retire(...args);if(boundary==='retired')await pause('retired');};
await store.migrateLegacy(reader,outbox);throw Error('crash boundary not reached');`,
    )
    const child = Bun.spawn([process.execPath, worker, dir, boundary], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
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
    const { obligations, outbox } = await boot(dir, 'second')
    expect((await outbox.list()).map((row) => row.deliveryId)).toEqual([expected.deliveryId])
    const rows = await obligations.list()
    expect(rows.map((row) => [row.taskId, row.phase, row.legacyCoverage?.id])).toEqual([
      ['task', 'notice-owned', expected.covers[0]!.id],
    ])
    await boot(dir, 'third', { outbox })
    expect((await obligations.list()).map((row) => row.obligationId)).toEqual([rows[0]!.obligationId])
    expect((await outbox.list()).map((row) => row.deliveryId)).toEqual([expected.deliveryId])
    expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toEqual([])
  })
}

test('failed durable import retains JSON and legacy source for a later boot', async () => {
  const { dir } = await setup()
  const outbox = new RecoveryOutbox(dir, { epoch: 'first' })
  outbox.import = async () => {
    throw new Error('disk unavailable')
  }
  await expect(boot(dir, 'first', { outbox })).rejects.toThrow('disk unavailable')
  const obligations = new BackgroundObligationStore(dir, { epoch: 'inspection' })
  expect((await obligations.list()).map((row) => row.phase)).toEqual(['notice-prepared'])
  expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toHaveLength(1)
  const next = await boot(dir, 'second')
  expect((await obligations.list()).map((row) => row.phase)).toEqual(['notice-owned'])
  expect((await next.outbox.list()).map((row) => row.deliveryId)).toEqual([
    (await obligations.list())[0]!.transfer!.deliveryId,
  ])
})

test('changed mapping and disabled adapter do not redirect or discard migrated work', async () => {
  const { dir } = await setup()
  await saveChannelSessions(dir, [{ ...key, sessionId: 'different', participants: [] }])
  const { obligations, outbox } = await boot(dir, 'boot')
  expect((await outbox.list()).map((row) => row.target)).toEqual([key])
  expect((await obligations.list()).map((row) => row.parentSessionId)).toEqual(['parent'])
})

test('corrupt prepared coverage retains original legacy bytes without a send intent', async () => {
  const { dir } = await setup()
  const reader = new LegacyBackgroundHandoffReader(dir, { processEpoch: 'first' })
  const claim = (await reader.claim())[0]!
  await reader.prepareRecovery(claim, createLegacyRecoveryNotice(claim.record))
  const source = JSON.parse(await readFile(claim.claimPath, 'utf8'))
  source.recoveryTransfer.record.covers[0].id = '0'.repeat(64)
  const bytes = JSON.stringify(source)
  await writeFile(claim.claimPath, bytes)
  const errors: unknown[] = []
  const { outbox } = await boot(dir, 'second', {
    inventory: new LegacyBackgroundHandoffReader(dir, {
      processEpoch: 'second',
      onError: (error) => errors.push(error),
    }),
  })
  expect(await readFile(claim.claimPath, 'utf8')).toBe(bytes)
  expect(await outbox.list()).toEqual([])
})

test('ordinary channel restart greeting survives without a lost-work model directive', async () => {
  const { dir } = await setup()
  await saveChannelSessions(dir, [{ ...key, sessionId: 'parent', participants: [] }])
  await writeRestartHandoff(dir, {
    schemaVersion: 2,
    restartedAt: new Date().toISOString(),
    originatingSessionId: 'parent',
    originatingSessionFile: 'missing.jsonl',
    origin: { kind: 'channel', key },
    interruptedSubagents: ['worker'],
  })
  let resumed = false,
    released = false
  await bootChannelRestartGreeting({
    agentDir: dir,
    configured: () => true,
    startAdapters: async () => {},
    onError: (error) => {
      throw error
    },
    router: {
      reserveRestartHandoff: (handoff) => {
        expect(handoff.interruptedSubagents).toBeUndefined()
        return {
          keyId: 'target',
          sawInbound: false,
          resume: async () => {
            resumed = true
          },
          release: () => {
            released = true
          },
        }
      },
    },
  })
  expect(resumed).toBe(true)
  expect(released).toBe(true)
  expect(await peekRestartHandoff(dir)).toBeNull()
})

test('channel restart greeting leaves an ordinary TUI handoff for reconnect', async () => {
  const { dir } = await setup()
  const handoff = {
    schemaVersion: 2 as const,
    restartedAt: new Date().toISOString(),
    originatingSessionId: 'tui-parent',
    originatingSessionFile: 'tui.jsonl',
    origin: { kind: 'tui' as const },
  }
  await writeRestartHandoff(dir, handoff)
  await bootChannelRestartGreeting({
    agentDir: dir,
    configured: () => true,
    startAdapters: async () => {},
    onError: (error) => {
      throw error
    },
    router: {
      reserveRestartHandoff: () => {
        throw new Error('TUI must not be consumed by channels')
      },
    },
  })
  expect(await peekRestartHandoff(dir)).toEqual(handoff)
})
