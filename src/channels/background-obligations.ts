import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { z } from 'zod'

import type { MatchableOrigin } from '../permissions/resolve'
import { createLegacyRecoveryNotice } from './background-handoff'
import type { LegacyBackgroundHandoffReader } from './background-handoff'
import { parseRecoveryRecord } from './continuity-types'
import type { RecoveryNoticeCause, RecoveryRecord } from './continuity-types'
import { createRecoveryNotice, sameRecoveryPrincipal } from './recovery-notice'
import type { RecoveryOutbox } from './recovery-outbox'
import { channelKeyId, type ChannelKey } from './types'

export type BackgroundObligationRef = { obligationId: string; generation: number }
export type BackgroundApplicationReceipt = {
  transitionId: string
  decisionDigest: string
  expectedGeneration: number
  resultingGeneration: number
}
export type BackgroundObligation = BackgroundObligationRef & {
  schemaVersion: 1
  taskId: string
  parentSessionId: string
  parentSessionFile?: string
  accountIdentity: string
  target: ChannelKey
  principal: MatchableOrigin
  acceptedAt: number
  epoch: string
  phase: 'accepted' | 'result-ready' | 'turn-owned' | 'notice-prepared' | 'notice-owned' | 'closed'
  completionId?: string
  claim?: { turnId: string; ownerSessionId?: string; epoch: string; generation: number }
  transfer?: RecoveryRecord
  legacyCoverage?: { id: string; generation: number }
  outcome?: { kind: 'delivered' | 'intentionally-suppressed'; decisionId: string; reason?: string; deliveryId?: string }
  applications: BackgroundApplicationReceipt[]
}
export type BackgroundAcceptance = {
  taskId: string
  parentSessionId: string
  parentSessionFile?: string
  accountIdentity: string
  target?: ChannelKey
  key?: ChannelKey
  principal?: MatchableOrigin
  triggeringAuthorId?: string
  parentChat?: string
  acceptedAt?: number
  startedAt?: number
  subagentName?: string
  legacyGeneration?: string
}
export type BackgroundDecision = { transitionId: string; decisionDigest: string }
const queues = new Map<string, Promise<void>>()
/**
 * Process-wide lookup index per store directory, shared by every instance in this process. One
 * directory scan builds it and every write in this process extends it, so completion lookups read
 * only exact candidates. Provenance (taskId) and frozen transfers never change once written, and
 * closed rows stay on disk as tombstones, so entries are only ever added. The directory has one
 * writer process; a new instance (a new boot or test phase) discards the cached index.
 */
type ObligationIndex = {
  byTask: Map<string, Set<string>>
  byDelivery: Map<string, Set<string>>
  ready: Promise<void>
}
const indexes = new Map<string, ObligationIndex>()
function indexRow(directory: string, row: BackgroundObligation) {
  const index = indexes.get(directory)
  if (!index) return
  const add = (map: Map<string, Set<string>>, key: string) => {
    const ids = map.get(key) ?? new Set<string>()
    ids.add(row.obligationId)
    map.set(key, ids)
  }
  add(index.byTask, row.taskId)
  if (row.transfer) add(index.byDelivery, row.transfer.deliveryId)
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return
  const fd = await open(path, 'r')
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}
const nonempty = z.string().min(1)
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const backgroundSchema = z
  .object({
    schemaVersion: z.literal(1),
    obligationId: z.string().regex(/^[a-f0-9]{64}$/),
    generation,
    taskId: nonempty,
    parentSessionId: nonempty,
    parentSessionFile: nonempty.optional(),
    accountIdentity: nonempty,
    target: z.unknown(),
    principal: z.unknown(),
    acceptedAt: z.number().finite().nonnegative(),
    epoch: nonempty,
    phase: z.enum(['accepted', 'result-ready', 'turn-owned', 'notice-prepared', 'notice-owned', 'closed']),
    completionId: nonempty.optional(),
    claim: z
      .object({
        turnId: nonempty,
        ownerSessionId: nonempty.optional(),
        epoch: nonempty,
        generation,
      })
      .strict()
      .optional(),
    transfer: z.unknown().optional(),
    legacyCoverage: z.object({ id: nonempty, generation }).strict().optional(),
    outcome: z
      .object({
        kind: z.enum(['delivered', 'intentionally-suppressed']),
        decisionId: nonempty,
        reason: z.string().optional(),
        deliveryId: nonempty.optional(),
      })
      .strict()
      .optional(),
    applications: z.array(
      z
        .object({
          transitionId: nonempty,
          decisionDigest: nonempty,
          expectedGeneration: generation,
          resultingGeneration: generation,
        })
        .strict(),
    ),
  })
  .strict()
function parse(value: unknown): BackgroundObligation {
  backgroundSchema.parse(value)
  // The shared notice parser below validates the opaque target/principal/transfer fields.
  const row = value as BackgroundObligation
  // Reuse the shared destination/principal validator without creating any send intent.
  createRecoveryNotice({
    target: row.target,
    accountIdentity: row.accountIdentity,
    principal: row.principal,
    covers: [{ store: 'background', id: row.obligationId, generation: row.generation }],
    transferId: row.obligationId,
    recoveryGeneration: row.obligationId,
    createdAt: row.acceptedAt,
  })
  if (
    (row.phase === 'closed') !== !!row.outcome ||
    (row.phase === 'turn-owned' && !row.claim) ||
    ((row.phase === 'notice-prepared' || row.phase === 'notice-owned') && !row.transfer)
  )
    throw new Error('Invalid background obligation phase')
  if (row.outcome && (!['delivered', 'intentionally-suppressed'].includes(row.outcome.kind) || !row.outcome.decisionId))
    throw new Error('Invalid background outcome')
  if (
    row.claim &&
    (typeof row.claim.turnId !== 'string' ||
      !row.claim.turnId ||
      typeof row.claim.epoch !== 'string' ||
      !row.claim.epoch ||
      (row.claim.ownerSessionId !== undefined &&
        (typeof row.claim.ownerSessionId !== 'string' || !row.claim.ownerSessionId)) ||
      !Number.isSafeInteger(row.claim.generation) ||
      row.claim.generation < 1 ||
      row.claim.generation > row.generation ||
      (row.phase === 'turn-owned' && row.claim.generation !== row.generation))
  )
    throw new Error('Invalid background claim')
  if (row.transfer) {
    parseRecoveryRecord(row.transfer)
    if (
      channelKeyId(row.transfer.target) !== channelKeyId(row.target) ||
      row.transfer.accountIdentity !== row.accountIdentity ||
      !sameRecoveryPrincipal(row.transfer.principal, row.principal) ||
      !row.transfer.covers.some(
        (cover) =>
          (cover.store === 'background' && cover.id === row.obligationId && cover.generation <= row.generation) ||
          (cover.store === 'inventory' &&
            cover.id === row.legacyCoverage?.id &&
            cover.generation === row.legacyCoverage?.generation),
      )
    )
      throw new Error('Invalid background transfer coverage')
  }
  const transitionIds = new Set<string>()
  for (const receipt of row.applications) {
    if (
      typeof receipt.transitionId !== 'string' ||
      !receipt.transitionId ||
      typeof receipt.decisionDigest !== 'string' ||
      !receipt.decisionDigest ||
      !Number.isSafeInteger(receipt.expectedGeneration) ||
      receipt.expectedGeneration < 1 ||
      receipt.resultingGeneration !== receipt.expectedGeneration + 1 ||
      receipt.resultingGeneration > row.generation ||
      transitionIds.has(receipt.transitionId)
    )
      throw new Error('Invalid background application receipt')
    transitionIds.add(receipt.transitionId)
  }
  return row
}
export class BackgroundObligationStore {
  readonly epoch: string
  private readonly directory: string
  private frozen?: unknown
  constructor(
    agentDir: string,
    private readonly options: {
      epoch?: string
      now?: () => number
      onError?: (error: unknown) => void
      onDurability?: (
        phase: 'temp-synced' | 'replaced' | 'directory-synced',
        row: BackgroundObligation,
      ) => void | Promise<void>
    } = {},
  ) {
    this.directory = resolve(agentDir, 'channels', 'background-obligations')
    this.epoch = options.epoch ?? randomUUID()
    indexes.delete(this.directory)
  }
  assertAvailable() {
    this.check()
  }
  /** PR3 journal repair must finish before any dependent background progress. */
  setFrozen(error?: unknown) {
    this.frozen = error
  }
  private check() {
    if (this.frozen !== undefined)
      throw new Error('Background continuity frozen pending journal repair', { cause: this.frozen })
  }
  private path(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid obligation ID')
    return join(this.directory, `${id}.json`)
  }
  private serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (queues.get(key) ?? Promise.resolve()).then(action)
    const settled = result.then(
      () => {},
      () => {},
    )
    queues.set(key, settled)
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key)
    })
    return result
  }
  run<T>(target: ChannelKey, action: () => Promise<T>) {
    return this.serialize(`${this.directory}:lane:${channelKeyId(target)}`, async () => {
      this.check()
      return action()
    })
  }
  // The lane serializes ownership/cache decisions, including ordinary input.
  // Dependent durable mutations enforce the freeze themselves; lane acquisition
  // alone must not block unrelated input or a parent's abort.
  withTargetLane<T>(target: ChannelKey, action: () => Promise<T>) {
    return this.serialize(`${this.directory}:lane:${channelKeyId(target)}`, action)
  }
  private async read(id: string) {
    try {
      const row = parse(JSON.parse(await readFile(this.path(id), 'utf8')))
      if (row.obligationId !== id) throw new Error('Background filename identity mismatch')
      return row
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private async write(row: BackgroundObligation) {
    parse(row)
    try {
      await mkdir(this.directory, { recursive: true })
      await syncDirectory(dirname(dirname(this.directory)))
      await syncDirectory(dirname(this.directory))
    } catch (error) {
      this.frozen = error
      throw error
    }
    const path = this.path(row.obligationId)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const fd = await open(temp, 'wx', 0o600)
      try {
        await fd.writeFile(`${JSON.stringify(row)}\n`)
        await fd.sync()
      } finally {
        await fd.close()
      }
      await this.options.onDurability?.('temp-synced', row)
      await rename(temp, path)
      // Visible to a concurrent directory scan from here on; keep the lookup index in step.
      indexRow(this.directory, row)
      await this.options.onDurability?.('replaced', row)
      await syncDirectory(this.directory)
      await this.options.onDurability?.('directory-synced', row)
    } catch (error) {
      this.frozen = error
      throw error
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          this.frozen = error
          throw error
        }
      })
    }
  }
  get(id: string) {
    return this.serialize(this.path(id), () => this.read(id))
  }
  async list() {
    let files: string[]
    try {
      files = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const rows: BackgroundObligation[] = []
    for (const file of files.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      const row = await this.get(file.slice(0, -5))
      if (!row) continue
      indexRow(this.directory, row)
      rows.push(row)
    }
    return rows
  }
  /** Builds the lookup index with one directory scan per process; later lookups never scan. */
  private async index(): Promise<ObligationIndex> {
    const existing = indexes.get(this.directory)
    if (existing) {
      await existing.ready
      return existing
    }
    const index: ObligationIndex = { byTask: new Map(), byDelivery: new Map(), ready: Promise.resolve() }
    indexes.set(this.directory, index)
    // Registered before the scan starts, so a row renamed in after its readdir is added by write().
    index.ready = this.list().then(
      () => undefined,
      (error: unknown) => {
        if (indexes.get(this.directory) === index) indexes.delete(this.directory)
        throw error
      },
    )
    await index.ready
    return index
  }
  private async indexedRows(map: 'byTask' | 'byDelivery', key: string) {
    const rows: BackgroundObligation[] = []
    // Sorted IDs keep the previous canonical choice: the first matching file in directory order.
    for (const id of [...((await this.index())[map].get(key) ?? [])].sort()) {
      const row = await this.get(id)
      if (row) rows.push(row)
    }
    return rows
  }
  /** Exact parent/task row, closed tombstones included so a late completion cannot reopen work. */
  async lookup(parentSessionId: string, taskId: string) {
    return (await this.indexedRows('byTask', taskId)).find(
      (row) => row.parentSessionId === parentSessionId && row.taskId === taskId,
    )
  }
  /** Task row on one destination, for a successor session fetching a predecessor's result. */
  async lookupTask(taskId: string, target: ChannelKey) {
    return (await this.indexedRows('byTask', taskId)).find(
      (row) => row.taskId === taskId && channelKeyId(row.target) === channelKeyId(target),
    )
  }
  private async deliveryRows(deliveryId: string) {
    return (await this.indexedRows('byDelivery', deliveryId)).filter((row) => row.transfer?.deliveryId === deliveryId)
  }
  accept(input: BackgroundAcceptance): Promise<BackgroundObligation> {
    const target = input.target ?? input.key
    if (!target) return Promise.reject(new Error('Background acceptance requires target'))
    const obligationId = hash([
      'background',
      input.accountIdentity,
      channelKeyId(target),
      input.parentSessionId,
      input.taskId,
      input.legacyGeneration ?? null,
    ])
    const principal: MatchableOrigin = input.principal ?? {
      kind: 'channel',
      adapter: target.adapter,
      workspace: target.workspace,
      chat: target.chat,
      ...(input.parentChat ? { parentChat: input.parentChat } : {}),
      ...(input.triggeringAuthorId ? { lastInboundAuthorId: input.triggeringAuthorId } : {}),
    }
    return this.serialize(this.path(obligationId), async () => {
      this.check()
      const existing = await this.read(obligationId)
      if (existing) {
        if (JSON.stringify(existing.principal) !== JSON.stringify(principal))
          throw new Error('Conflicting background acceptance')
        try {
          await syncDirectory(this.directory)
        } catch (error) {
          this.frozen = error
          throw error
        }
        return existing
      }
      const row: BackgroundObligation = {
        schemaVersion: 1,
        obligationId,
        generation: 1,
        taskId: input.taskId,
        parentSessionId: input.parentSessionId,
        ...(input.parentSessionFile ? { parentSessionFile: input.parentSessionFile } : {}),
        accountIdentity: input.accountIdentity,
        target,
        principal,
        acceptedAt: input.acceptedAt ?? input.startedAt ?? (this.options.now ?? Date.now)(),
        epoch: this.epoch,
        phase: 'accepted',
        applications: [],
      }
      await this.write(row)
      return row
    })
  }
  async resultReady(input: string | { parentSessionId: string; taskId: string }, completionId?: string) {
    this.check()
    const id =
      typeof input === 'string' ? input : (await this.lookup(input.parentSessionId, input.taskId))?.obligationId
    if (!id) return undefined
    const row = await this.get(id)
    if (!row || row.phase === 'closed' || row.transfer) return undefined
    const stableId = completionId ?? hash(['completion', id])
    const decision = { transitionId: `completion:${stableId}`, decisionDigest: hash(['result-ready', id, stableId]) }
    if (row.completionId && row.completionId !== stableId) throw new Error('Conflicting background completion')
    const previous = row.applications.find((receipt) => receipt.transitionId === decision.transitionId)
    return this.apply(
      { obligationId: id, generation: previous?.expectedGeneration ?? row.generation },
      decision,
      (current) => ({
        ...current,
        completionId: stableId,
        phase: current.claim ? 'turn-owned' : 'result-ready',
      }),
    )
  }
  apply(
    ref: BackgroundObligationRef,
    decision: BackgroundDecision,
    change: (row: Readonly<BackgroundObligation>) => BackgroundObligation,
  ) {
    return this.applyDecision(ref, decision, change, false)
  }
  /** Only journal replay may apply a committed decision while dependent work is frozen. */
  applyJournalDecision(
    ref: BackgroundObligationRef,
    decision: BackgroundDecision,
    change: (row: Readonly<BackgroundObligation>) => BackgroundObligation,
  ) {
    return this.applyDecision(ref, decision, change, true)
  }
  private applyDecision(
    ref: BackgroundObligationRef,
    decision: BackgroundDecision,
    change: (row: Readonly<BackgroundObligation>) => BackgroundObligation,
    journalRepair: boolean,
  ) {
    return this.serialize(this.path(ref.obligationId), async () => {
      if (!journalRepair) this.check()
      const row = await this.read(ref.obligationId)
      if (!row) return undefined
      const receipt = row.applications.find((item) => item.transitionId === decision.transitionId)
      if (receipt) {
        if (receipt.decisionDigest !== decision.decisionDigest || receipt.expectedGeneration !== ref.generation)
          throw new Error('Conflicting background transition receipt')
        try {
          await syncDirectory(this.directory)
        } catch (error) {
          this.frozen = error
          throw error
        }
        return row
      }
      if (row.generation !== ref.generation || row.phase === 'closed') return undefined
      const next = change(row)
      next.generation = row.generation + 1
      next.applications = [
        ...row.applications,
        { ...decision, expectedGeneration: row.generation, resultingGeneration: next.generation },
      ]
      await this.write(next)
      return next
    })
  }
  async claim(
    refs: BackgroundObligationRef[],
    owner: { turnId: string; ownerSessionId?: string; target: ChannelKey },
    decision?: BackgroundDecision,
  ): Promise<BackgroundObligationRef[]> {
    this.check()
    // Validate all coverage before publishing any owner. Caller holds target lane until caches update.
    for (const ref of refs) {
      const row = await this.get(ref.obligationId)
      const applied =
        decision &&
        row?.applications.find(
          (item) =>
            item.transitionId === decision.transitionId &&
            item.decisionDigest === decision.decisionDigest &&
            item.expectedGeneration === ref.generation,
        )
      if (
        applied &&
        (!row ||
          row.generation !== applied.resultingGeneration ||
          row.phase !== 'turn-owned' ||
          !row.claim ||
          row.claim.turnId !== owner.turnId ||
          row.claim.ownerSessionId !== owner.ownerSessionId ||
          row.claim.epoch !== this.epoch ||
          row.claim.generation !== row.generation)
      )
        throw new Error('Background claim decision superseded')
      if (
        !applied &&
        (!row ||
          row.generation !== ref.generation ||
          (row.phase !== 'result-ready' && row.phase !== 'turn-owned') ||
          row.transfer ||
          (row.claim &&
            (row.claim.turnId !== owner.turnId ||
              row.claim.ownerSessionId !== owner.ownerSessionId ||
              row.claim.epoch !== this.epoch)) ||
          channelKeyId(row.target) !== channelKeyId(owner.target))
      )
        throw new Error('Invalid background claim coverage')
    }
    const committed: BackgroundObligationRef[] = []
    const identity = decision ?? { transitionId: randomUUID(), decisionDigest: hash(['claim', refs, owner]) }
    for (const ref of refs) {
      const row = await this.apply(ref, identity, (current) => ({
        ...current,
        phase: 'turn-owned',
        claim: {
          turnId: owner.turnId,
          ownerSessionId: owner.ownerSessionId,
          epoch: this.epoch,
          generation: current.generation + 1,
        },
      }))
      if (
        !row ||
        row.generation !== ref.generation + 1 ||
        row.phase !== 'turn-owned' ||
        !row.claim ||
        row.claim.turnId !== owner.turnId ||
        row.claim.ownerSessionId !== owner.ownerSessionId ||
        row.claim.epoch !== this.epoch ||
        row.claim.generation !== row.generation
      )
        throw new Error('Background claim decision superseded')
      committed.push({ obligationId: row.obligationId, generation: row.generation })
    }
    return committed
  }
  async move(
    refs: BackgroundObligationRef[],
    owner: { fromTurnId: string; turnId: string; ownerSessionId?: string; target: ChannelKey },
    decision?: BackgroundDecision,
  ): Promise<BackgroundObligationRef[]> {
    const identity = decision ?? { transitionId: randomUUID(), decisionDigest: hash(['move', refs, owner]) }
    for (const ref of refs) {
      const row = await this.get(ref.obligationId)
      const applied = row?.applications.find(
        (item) =>
          item.transitionId === identity.transitionId &&
          item.decisionDigest === identity.decisionDigest &&
          item.expectedGeneration === ref.generation,
      )
      if (
        applied &&
        (!row ||
          row.generation !== applied.resultingGeneration ||
          row.phase !== 'turn-owned' ||
          !row.claim ||
          row.claim.turnId !== owner.turnId ||
          row.claim.ownerSessionId !== owner.ownerSessionId ||
          row.claim.epoch !== this.epoch ||
          row.claim.generation !== row.generation)
      )
        throw new Error('Background move decision superseded')
      if (
        !applied &&
        (!row ||
          row.generation !== ref.generation ||
          row.phase !== 'turn-owned' ||
          row.claim?.turnId !== owner.fromTurnId ||
          channelKeyId(row.target) !== channelKeyId(owner.target))
      )
        throw new Error('Invalid background move coverage')
    }
    const committed: BackgroundObligationRef[] = []
    for (const ref of refs) {
      const row = await this.apply(ref, identity, (current) => ({
        ...current,
        claim: {
          turnId: owner.turnId,
          ownerSessionId: owner.ownerSessionId,
          epoch: this.epoch,
          generation: current.generation + 1,
        },
      }))
      if (
        !row ||
        row.generation !== ref.generation + 1 ||
        row.phase !== 'turn-owned' ||
        !row.claim ||
        row.claim.turnId !== owner.turnId ||
        row.claim.ownerSessionId !== owner.ownerSessionId ||
        row.claim.epoch !== this.epoch ||
        row.claim.generation !== row.generation
      )
        throw new Error('Background move decision superseded')
      committed.push({ obligationId: row.obligationId, generation: row.generation })
    }
    return committed
  }
  async settle(
    refs: BackgroundObligationRef[],
    outcome: NonNullable<BackgroundObligation['outcome']>,
    decision?: BackgroundDecision,
  ) {
    const identity = decision ?? { transitionId: outcome.decisionId, decisionDigest: hash(['outcome', refs, outcome]) }
    for (const ref of refs) {
      const row = await this.get(ref.obligationId)
      const applied = row?.applications.find(
        (item) =>
          item.transitionId === identity.transitionId &&
          item.decisionDigest === identity.decisionDigest &&
          item.expectedGeneration === ref.generation,
      )
      if (!applied && (!row || row.generation !== ref.generation || row.phase === 'closed'))
        throw new Error('Invalid background outcome coverage')
    }
    for (const ref of refs) {
      const row = await this.apply(ref, identity, (current) => ({ ...current, phase: 'closed', outcome }))
      if (!row) throw new Error('Background outcome generation changed')
    }
  }
  /**
   * Freezes this child's transfer. Boot recovery keeps the default `restart`; a same-process
   * abandonment passes `live-turn-ended`. An already-frozen transfer is returned unchanged.
   */
  async prepareNotice(id: string, expectedGeneration: number, cause: RecoveryNoticeCause = 'restart') {
    const ref = { obligationId: id, generation: expectedGeneration }
    const row = await this.get(id)
    if (!row || row.phase === 'closed') return undefined
    if (row.transfer) return row
    return this.apply(
      ref,
      {
        transitionId: `notice:${id}:${expectedGeneration}`,
        // The restart digest is frozen; another cause for the same generation conflicts with it.
        decisionDigest: hash(
          cause === 'restart' ? ['notice', id, expectedGeneration] : ['notice', id, expectedGeneration, cause],
        ),
      },
      (current) => {
        const generation = current.generation + 1
        const transfer = createRecoveryNotice({
          target: current.target,
          accountIdentity: current.accountIdentity,
          principal: current.principal,
          covers: [{ store: 'background', id, generation, parentSessionId: current.parentSessionId }],
          recoveryGeneration: `${id}:${generation}`,
          transferId: hash(['background-transfer', id, generation]),
          sourceParentSessionId: current.parentSessionId,
          cause,
        })
        return { ...current, phase: 'notice-prepared', transfer }
      },
    )
  }
  async ownNotice(id: string, expectedGeneration: number, deliveryId: string) {
    // Outbox ownership does not advance source coverage: the frozen covered generation stays authoritative.
    return this.serialize(this.path(id), async () => {
      this.check()
      const row = await this.read(id)
      if (
        !row ||
        row.generation !== expectedGeneration ||
        row.transfer?.deliveryId !== deliveryId ||
        row.phase === 'closed'
      )
        return undefined
      if (row.phase !== 'notice-owned') {
        row.phase = 'notice-owned'
        await this.write(row)
      }
      return row
    })
  }
  async validateNotice(record: RecoveryRecord): Promise<'open' | 'resolved'> {
    const coverage = record.covers.filter((item) => item.store === 'background')
    if (!coverage.length) {
      if (!record.covers.every((cover) => cover.store === 'inventory')) return 'open'
      const migrated = await this.deliveryRows(record.deliveryId)
      for (const row of migrated) {
        if (
          !row.legacyCoverage ||
          row.transfer?.covers.some((cover) => cover.store !== 'inventory') ||
          !record.covers.some(
            (cover) => cover.id === row.legacyCoverage?.id && cover.generation === row.legacyCoverage?.generation,
          ) ||
          channelKeyId(row.target) !== channelKeyId(record.target) ||
          row.accountIdentity !== record.accountIdentity ||
          JSON.stringify(row.principal) !== JSON.stringify(record.principal)
        )
          throw new Error('Legacy recovery provenance is not independent')
        if (row.phase !== 'closed' && row.phase !== 'notice-owned')
          throw new Error('Legacy recovery ownership is not ready')
      }
      return migrated.length && migrated.every((row) => row.phase === 'closed') ? 'resolved' : 'open'
    }
    this.check()
    let open = false
    for (const cover of coverage) {
      const row = await this.get(cover.id)
      if (
        !row ||
        channelKeyId(row.target) !== channelKeyId(record.target) ||
        row.accountIdentity !== record.accountIdentity ||
        !sameRecoveryPrincipal(row.principal, record.principal) ||
        row.transfer?.deliveryId !== record.deliveryId
      )
        throw new Error('Recovery coverage conflicts with background authority')
      if (row.phase === 'closed') continue
      if (row.generation !== cover.generation || row.phase !== 'notice-owned')
        throw new Error('Recovery background ownership is not ready')
      open = true
    }
    return open ? 'open' : 'resolved'
  }
  async acknowledgeNotice(record: RecoveryRecord) {
    if (record.state !== 'delivered' && record.state !== 'suppressed') return
    const refs: BackgroundObligationRef[] = record.covers
      .filter((cover) => cover.store === 'background')
      .map((cover) => ({ obligationId: cover.id, generation: cover.generation }))
    if (record.covers.some((cover) => cover.store === 'inventory')) {
      for (const row of await this.deliveryRows(record.deliveryId)) {
        if (
          row.legacyCoverage &&
          row.transfer?.deliveryId === record.deliveryId &&
          record.covers.some(
            (cover) =>
              cover.store === 'inventory' &&
              cover.id === row.legacyCoverage?.id &&
              cover.generation === row.legacyCoverage?.generation,
          )
        )
          refs.push({ obligationId: row.obligationId, generation: row.generation })
      }
    }
    for (const ref of refs) {
      const row = await this.get(ref.obligationId)
      if (row?.phase === 'closed') continue
      if (!row || row.transfer?.deliveryId !== record.deliveryId)
        throw new Error('Recovery receipt does not match background transfer')
      await this.settle([ref], {
        kind: record.state === 'delivered' ? 'delivered' : 'intentionally-suppressed',
        decisionId: record.suppression?.decisionId ?? `recovery:${record.deliveryId}`,
        deliveryId: record.deliveryId,
        reason: record.suppression?.reason,
      })
    }
  }
  async suppressNoticeCoverage(record: RecoveryRecord, decision: { decisionId: string; reason: string }) {
    const refs: BackgroundObligationRef[] = []
    for (const cover of record.covers.filter((item) => item.store === 'background')) {
      const row = await this.get(cover.id)
      if (
        !row ||
        row.transfer?.deliveryId !== record.deliveryId ||
        channelKeyId(row.target) !== channelKeyId(record.target) ||
        row.accountIdentity !== record.accountIdentity
      )
        throw new Error('Suppression does not match background notice coverage')
      if (row.phase !== 'closed') refs.push({ obligationId: row.obligationId, generation: cover.generation })
    }
    if (record.covers.some((cover) => cover.store === 'inventory')) {
      for (const row of await this.deliveryRows(record.deliveryId)) {
        if (row.phase === 'closed') continue
        if (
          !row.legacyCoverage ||
          !record.covers.some(
            (cover) =>
              cover.store === 'inventory' &&
              cover.id === row.legacyCoverage?.id &&
              cover.generation === row.legacyCoverage?.generation,
          )
        )
          throw new Error('Suppression does not match legacy notice coverage')
        refs.push({ obligationId: row.obligationId, generation: row.generation })
      }
    }
    if (refs.length)
      await this.settle(refs, { kind: 'intentionally-suppressed', ...decision, deliveryId: record.deliveryId })
  }
  async migrateLegacy(reader: LegacyBackgroundHandoffReader, outbox: RecoveryOutbox) {
    this.check()
    for (const claim of await reader.claim()) {
      await this.run(claim.record.key, async () => {
        const source = claim.record
        const identity = JSON.stringify([channelKeyId(source.key), source.parentSessionId, source.generationId])
        const transfer =
          source.recoveryTransfer?.record ?? (await reader.prepareRecovery(claim, createLegacyRecoveryNotice(source)))
        const migratedIds: string[] = []
        for (const task of source.tasks) {
          const legacyId = createHash('sha256').update(`inventory:${identity}:${task.taskId}`).digest('hex')
          const accepted = await this.accept({
            taskId: task.taskId,
            parentSessionId: source.parentSessionId,
            parentSessionFile: source.parentSessionFile,
            accountIdentity: transfer.accountIdentity,
            target: source.key,
            principal: transfer.principal,
            acceptedAt: task.startedAt,
            legacyGeneration: source.generationId,
          })
          migratedIds.push(accepted.obligationId)
          if (accepted.phase === 'closed') continue
          if (accepted.transfer) {
            if (accepted.transfer.deliveryId !== transfer.deliveryId || accepted.legacyCoverage?.id !== legacyId)
              throw new Error('Conflicting legacy obligation transfer')
          } else {
            await this.apply(
              accepted,
              {
                transitionId: `legacy-transfer:${source.generationId}:${task.taskId}`,
                decisionDigest: hash(['legacy-transfer', transfer.deliveryId, legacyId]),
              },
              (row) => ({
                ...row,
                phase: 'notice-prepared',
                transfer,
                legacyCoverage: { id: legacyId, generation: 1 },
              }),
            )
          }
        }
        const imported = await outbox.import(transfer)
        for (const id of migratedIds) {
          const row = await this.get(id)
          if (row && row.phase !== 'closed' && row.transfer?.deliveryId === transfer.deliveryId)
            await this.ownNotice(row.obligationId, row.generation, transfer.deliveryId)
        }
        await reader.ownRecovery(claim, transfer)
        await this.acknowledgeNotice(imported)
        await reader.retire(claim)
      })
    }
  }
  async importOldEpoch(outbox: RecoveryOutbox) {
    this.check()
    for (const source of await this.list()) {
      if (source.phase === 'closed' || (source.epoch === this.epoch && !source.transfer)) continue
      await this.run(source.target, async () => {
        const prepared = source.transfer ? source : await this.prepareNotice(source.obligationId, source.generation)
        if (!prepared?.transfer) return
        const imported = await outbox.import(prepared.transfer)
        await this.ownNotice(prepared.obligationId, prepared.generation, imported.deliveryId)
        await this.acknowledgeNotice(imported)
      })
    }
  }
  async flush() {
    await Promise.all(
      [...queues.entries()].filter(([key]) => key.startsWith(this.directory)).map(([, pending]) => pending),
    )
  }
}

export { parse as parseBackgroundObligation }
