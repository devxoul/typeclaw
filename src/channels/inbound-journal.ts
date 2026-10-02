import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { z } from 'zod'

import type { MatchableOrigin } from '../permissions/resolve'
import type { BackgroundObligation, BackgroundObligationRef, BackgroundObligationStore } from './background-obligations'
import { parseBackgroundObligation } from './background-obligations'
import { parseRecoveryRecord, recoveryPayload } from './continuity-types'
import type { RecoveryRecord } from './continuity-types'
import { createRecoveryNotice } from './recovery-notice'
import type { RecoveryOutbox } from './recovery-outbox'
import { channelKeyId } from './types'
import type { ChannelKey } from './types'

export type InboundRef = { inputId: string; generation: number }
export type InboundOutcome = {
  kind: 'delivered' | 'intentionally-suppressed'
  decisionId: string
  reason?: string
  deliveryId?: string
}
export type InboundRecord = InboundRef & {
  schemaVersion: 1
  identity: string
  accountIdentity: string
  target: ChannelKey
  principal: MatchableOrigin
  epoch: string
  acceptedAt: number
  reference?: { messageId?: string; receiptId?: string }
  sourceParentSessionId?: string
  phase: 'admitted' | 'turn-owned' | 'notice-prepared' | 'notice-owned' | 'closed'
  claim?: { turnId: string; ownerSessionId?: string; epoch: string; generation: number }
  transfer?: RecoveryRecord
  outcome?: InboundOutcome
}
export type InboundAdmission = {
  accountIdentity: string
  target: ChannelKey
  principal: MatchableOrigin
  messageId?: string
  eventKind: string
  revision: string
  receiptId?: string
  reference?: { messageId?: string; receiptId?: string }
  ownerSessionId?: string
}
type Owner = { turnId: string; ownerSessionId?: string; target: ChannelKey; fromTurnId?: string }
type Change = { expected: InboundRef; row: InboundRecord }
type BackgroundChange = { expected: BackgroundObligationRef; row: BackgroundObligation }
type Decision = {
  schemaVersion: 1
  seq: number
  transitionId: string
  epoch: string
  type: string
  changes: Change[]
  backgroundChanges: BackgroundChange[]
  requestDigest?: string
}
type Applied = {
  schemaVersion: 1
  seq: number
  transitionId: string
  epoch: string
  type: 'mixed-applied'
  decisionId: string
  decisionDigest: string
}
type DecisionReceipt = {
  transitionId: string
  seq: number
  type: string
  decisionDigest: string
  payloadDigest: string
  requestDigest?: string
  inboundRefs: InboundRef[]
  backgroundRefs: BackgroundObligationRef[]
}
type Snapshot = {
  schemaVersion: 1
  seq: number
  type: 'snapshot'
  rows: InboundRecord[]
  decisions: Decision[]
  receipts: DecisionReceipt[]
}
type Line = Decision | Applied | Snapshot
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0
const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const activeWriters = new Map<string, InboundJournal>()
async function syncDirectory(path: string) {
  let fd: FileHandle
  try {
    fd = await open(path, 'r')
  } catch (error) {
    if (
      process.platform === 'win32' &&
      ['EPERM', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      return
    throw error
  }
  try {
    await fd.sync()
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error
  } finally {
    await fd.close()
  }
}
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonempty = z.string().min(1)
const rowSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputId: z.string().regex(/^[a-f0-9]{64}$/),
    generation: positive,
    identity: nonempty,
    accountIdentity: nonempty,
    epoch: nonempty,
    acceptedAt: z.number().finite().nonnegative(),
    target: z.unknown(),
    principal: z.unknown(),
    reference: z.object({ messageId: nonempty.optional(), receiptId: nonempty.optional() }).strict().optional(),
    sourceParentSessionId: nonempty.optional(),
    phase: z.enum(['admitted', 'turn-owned', 'notice-prepared', 'notice-owned', 'closed']),
    claim: z
      .object({ turnId: nonempty, ownerSessionId: nonempty.optional(), epoch: nonempty, generation: positive })
      .strict()
      .optional(),
    transfer: z.unknown().optional(),
    outcome: z
      .object({
        kind: z.enum(['delivered', 'intentionally-suppressed']),
        decisionId: nonempty,
        reason: z.string().optional(),
        deliveryId: nonempty.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
const inboundExpectedSchema = z
  .object({
    inputId: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
const backgroundExpectedSchema = z
  .object({ obligationId: z.string().regex(/^[a-f0-9]{64}$/), generation: positive })
  .strict()
const decisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    seq: positive,
    transitionId: nonempty,
    epoch: nonempty,
    type: z.enum(['admitted', 'turn-claimed', 'ownership-moved', 'outcome-decided', 'notice-prepared', 'notice-owned']),
    changes: z.array(z.object({ expected: inboundExpectedSchema, row: z.unknown() }).strict()),
    backgroundChanges: z.array(z.object({ expected: backgroundExpectedSchema, row: z.unknown() }).strict()),
    requestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
const receiptSchema = z
  .object({
    transitionId: nonempty,
    seq: positive,
    type: decisionSchema.shape.type,
    decisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    requestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    inboundRefs: z.array(inboundExpectedSchema),
    backgroundRefs: z.array(backgroundExpectedSchema),
  })
  .strict()
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    seq: positive,
    type: z.literal('snapshot'),
    rows: z.array(z.unknown()),
    decisions: z.array(z.unknown()),
    receipts: z.array(receiptSchema),
  })
  .strict()
const appliedSchema = z
  .object({
    schemaVersion: z.literal(1),
    seq: positive,
    transitionId: nonempty,
    epoch: nonempty,
    type: z.literal('mixed-applied'),
    decisionId: nonempty,
    decisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
function validateRow(row: InboundRecord) {
  rowSchema.parse(row)
  if (digest(['inbound', row.identity]) !== row.inputId) throw new Error('Invalid inbound journal identity')
  createRecoveryNotice({
    target: row.target,
    accountIdentity: row.accountIdentity,
    principal: row.principal,
    covers: [{ store: 'inbound', id: row.inputId, generation: row.generation }],
    transferId: row.inputId,
    recoveryGeneration: row.inputId,
    createdAt: row.acceptedAt,
  })
  if (
    (row.phase === 'closed') !== !!row.outcome ||
    (row.claim && (row.phase !== 'turn-owned' || row.claim.generation !== row.generation))
  )
    throw new Error('Invalid inbound state fields')
  if (!['admitted', 'turn-owned', 'notice-prepared', 'notice-owned', 'closed'].includes(row.phase))
    throw new Error('Invalid inbound phase')
  if (
    row.phase === 'turn-owned' &&
    (!row.claim || !row.claim.turnId || !row.claim.epoch || row.claim.generation !== row.generation)
  )
    throw new Error('Invalid inbound claim generation')
  if (
    row.phase === 'closed' &&
    (!row.outcome || !['delivered', 'intentionally-suppressed'].includes(row.outcome.kind) || !row.outcome.decisionId)
  )
    throw new Error('Invalid inbound outcome')
  if (row.phase.startsWith('notice-') && !row.transfer) throw new Error('Missing inbound transfer')
  if (row.transfer) {
    parseRecoveryRecord(row.transfer)
    if (
      row.transfer.accountIdentity !== row.accountIdentity ||
      channelKeyId(row.transfer.target) !== channelKeyId(row.target) ||
      canonical(row.transfer.principal) !== canonical(row.principal) ||
      !row.transfer.covers.some((c) => c.store === 'inbound' && c.id === row.inputId && c.generation <= row.generation)
    )
      throw new Error('Invalid inbound transfer coverage')
  }
}

/** Single-runtime writer. Callers hold the background target lane through coverage reads and cache publication. */
export class InboundJournal {
  readonly epoch: string
  readonly path: string
  private fd?: FileHandle
  private sequence = 0
  private rows = new Map<string, InboundRecord>()
  private decisions = new Map<string, Decision>()
  private receipts = new Map<string, DecisionReceipt>()
  private applied = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private initializing?: Promise<void>
  private initialized = false
  private initializationCancelled = false
  private closing?: Promise<void>
  private frozen?: unknown
  private readonly background?: BackgroundObligationStore
  private readonly failureListeners = new Set<(error: unknown) => void>()
  constructor(
    agentDir: string,
    private readonly options: {
      epoch?: string
      backgroundObligations?: BackgroundObligationStore
      onError?: (error: unknown) => void
      now?: () => number
      onDurability?: (
        phase:
          | 'initialization-directory-created'
          | 'initialization-read'
          | 'append-written'
          | 'append-synced'
          | 'mixed-json-applied'
          | 'temp-synced'
          | 'handle-closed'
          | 'replaced'
          | 'directory-synced'
          | 'reopened',
        record?: unknown,
      ) => void | Promise<void>
      onSync?: (milliseconds: number) => void
    } = {},
  ) {
    this.path = resolve(agentDir, 'channels', 'inbound-continuity.jsonl')
    this.background = options.backgroundObligations
    this.epoch = this.background?.epoch ?? options.epoch ?? randomUUID()
    if (options.epoch && options.epoch !== this.epoch) throw new Error('Continuity epoch mismatch')
    this.frozen = new Error('Inbound journal initialization pending')
    this.background?.setFrozen(this.frozen)
  }
  private fail(error: unknown) {
    // Canceled startup has no runtime owner to fence or replay.
    if (this.initializationCancelled) return
    this.frozen = error
    this.background?.setFrozen(error)
    for (const listener of this.failureListeners) listener(error)
    this.options.onError?.(error)
  }
  subscribeFailure(listener: (error: unknown) => void): () => void {
    this.failureListeners.add(listener)
    return () => {
      this.failureListeners.delete(listener)
    }
  }
  assertAvailable() {
    if (this.initializationCancelled || this.frozen !== undefined || !this.fd)
      throw new Error('Inbound continuity frozen pending repair', { cause: this.frozen })
  }
  health() {
    return {
      available: !this.initializationCancelled && this.frozen === undefined && !!this.fd,
      error: this.frozen,
      sequence: this.sequence,
    }
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action)
    this.queue = result.then(
      () => {},
      () => {},
    )
    return result
  }
  /** Stop startup before teardown; an operational writer remains available for durable closeout. */
  cancelInitialization() {
    if (!this.initialized) this.initializationCancelled = true
  }
  initialize() {
    return (this.initializing ??= this.serialized(async () => {
      if (this.initializationCancelled) return
      try {
        if (activeWriters.has(this.path) && activeWriters.get(this.path) !== this)
          throw new Error('Inbound journal already has a writer')
        activeWriters.set(this.path, this)
        await mkdir(dirname(this.path), { recursive: true })
        await this.options.onDurability?.('initialization-directory-created')
        if (this.initializationCancelled) return
        await syncDirectory(dirname(dirname(this.path)))
        if (this.initializationCancelled) return
        let bytes: Buffer
        try {
          bytes = await readFile(this.path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          bytes = Buffer.alloc(0)
        }
        await this.options.onDurability?.('initialization-read')
        if (this.initializationCancelled) return
        const end = bytes.lastIndexOf(10) + 1
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
        for (const line of text.split('\n').slice(0, -1)) this.fold(JSON.parse(line))
        if (end !== bytes.length) {
          // Windows append handles cannot truncate; repair durably before opening the writer.
          const repair = await open(this.path, 'r+')
          if (this.initializationCancelled) {
            await repair.close()
            return
          }
          try {
            await repair.truncate(end)
            await repair.sync()
          } finally {
            await repair.close()
          }
        }
        if (this.initializationCancelled) return
        this.fd = await open(this.path, 'a+', 0o600)
        if (this.initializationCancelled) return
        await syncDirectory(dirname(this.path))
        if (this.initializationCancelled) return
        await this.repairInternal()
        if (this.initializationCancelled) return
        this.initialized = true
      } catch (error) {
        if (this.initializationCancelled) return
        this.fail(error)
        throw error
      } finally {
        if (this.initializationCancelled) {
          try {
            await this.fd?.close()
          } finally {
            this.fd = undefined
            if (activeWriters.get(this.path) === this) activeWriters.delete(this.path)
          }
        }
      }
    }))
  }
  private fold(line: Line) {
    if (!line || line.schemaVersion !== 1 || !integer(line.seq)) throw new Error('Invalid journal version or sequence')
    if (line.type === 'snapshot') {
      const snap = line as Snapshot
      snapshotSchema.parse(snap)
      if (this.sequence) throw new Error('Invalid journal snapshot position')
      for (const row of snap.rows) {
        validateRow(row)
        if (this.rows.has(row.inputId)) throw new Error('Duplicate snapshot input')
        this.rows.set(row.inputId, row)
      }
      const sequences = new Set<number>()
      for (const receipt of snap.receipts) {
        if (receipt.seq > snap.seq || sequences.has(receipt.seq) || this.receipts.has(receipt.transitionId))
          throw new Error('Invalid snapshot receipt sequence')
        sequences.add(receipt.seq)
        for (const ref of receipt.inboundRefs) {
          const row = this.rows.get(ref.inputId)
          if (!row || ref.generation < 1 || ref.generation > row.generation)
            throw new Error('Snapshot receipt has invalid generation')
        }
        this.receipts.set(receipt.transitionId, receipt)
      }
      for (const decision of snap.decisions) {
        this.validateDecision(decision)
        if (
          decision.seq > snap.seq ||
          sequences.has(decision.seq) ||
          this.receipts.has(decision.transitionId) ||
          this.decisions.has(decision.transitionId) ||
          !decision.backgroundChanges.length
        )
          throw new Error('Invalid pending snapshot decision')
        sequences.add(decision.seq)
        for (const change of decision.changes) {
          if (canonical(this.rows.get(change.row.inputId)) !== canonical(change.row))
            throw new Error('Snapshot pending decision conflicts with source')
        }
        this.decisions.set(decision.transitionId, decision)
      }
    } else {
      if (line.seq !== this.sequence + 1) throw new Error('Noncontiguous journal sequence')
      if (line.type === 'mixed-applied') {
        const receipt = line as Applied
        appliedSchema.parse(receipt)
        const decision = this.decisions.get(receipt.decisionId)
        if (
          !decision ||
          digest(decision) !== receipt.decisionDigest ||
          receipt.transitionId !== `applied:${receipt.decisionId}`
        )
          throw new Error('Invalid mixed application receipt')
        this.applied.add(receipt.decisionId)
      } else {
        const decision = line as Decision
        this.validateDecision(decision)
        const previous = this.decisions.get(decision.transitionId)
        const compacted = this.receipts.get(decision.transitionId)
        if (compacted && compacted.decisionDigest !== digest(decision))
          throw new Error('Conflicting compacted transition identity')
        if (previous) {
          if (canonical(previous) !== canonical(decision)) throw new Error('Conflicting duplicate journal transition')
        } else if (!compacted) {
          for (const change of decision.changes) this.validateChange(change, decision.type)
          for (const change of decision.changes) this.rows.set(change.row.inputId, change.row)
          this.decisions.set(decision.transitionId, decision)
        }
      }
    }
    this.sequence = line.seq
  }
  private validateDecision(decision: Decision) {
    decisionSchema.parse(decision)
    if (!decision.changes.length && !decision.backgroundChanges.length) throw new Error('Empty journal decision')
    if (decision.type === 'admitted' && (decision.changes.length !== 1 || decision.backgroundChanges.length))
      throw new Error('Admission must cover exactly one input')
    const seen = new Set<string>()
    for (const c of decision.changes) {
      validateRow(c.row)
      if (!c.expected || c.expected.inputId !== c.row.inputId || seen.has(c.row.inputId))
        throw new Error('Invalid or duplicate inbound coverage')
      seen.add(c.row.inputId)
    }
    for (const c of decision.backgroundChanges) {
      parseBackgroundObligation(c.row)
      if (
        !id(c.expected.obligationId) ||
        !integer(c.expected.generation) ||
        c.row.obligationId !== c.expected.obligationId ||
        c.row.generation !== c.expected.generation + 1 ||
        seen.has(c.row.obligationId)
      )
        throw new Error('Invalid background decision coverage')
      seen.add(c.row.obligationId)
    }
    const coverage = [...decision.changes.map((c) => c.row), ...decision.backgroundChanges.map((c) => c.row)]
    const first = coverage[0]!
    const phases: Record<string, string> = {
      admitted: 'admitted',
      'turn-claimed': 'turn-owned',
      'ownership-moved': 'turn-owned',
      'outcome-decided': 'closed',
      'notice-prepared': 'notice-prepared',
      'notice-owned': 'notice-owned',
    }
    for (const row of coverage) {
      if (
        row.phase !== phases[decision.type] ||
        row.accountIdentity !== first.accountIdentity ||
        channelKeyId(row.target) !== channelKeyId(first.target)
      )
        throw new Error('Conflicting journal decision scope')
      if (decision.type === 'outcome-decided' && canonical(row.outcome) !== canonical(first.outcome))
        throw new Error('Conflicting journal outcome coverage')
      if (decision.type === 'notice-prepared' && canonical(row.transfer) !== canonical(first.transfer))
        throw new Error('Conflicting frozen transfer coverage')
      if (decision.type === 'notice-prepared' && canonical(row.principal) !== canonical(first.principal))
        throw new Error('Notice coverage must be partitioned by principal')
    }
  }
  private validateChange(change: Change, type: string) {
    const before = this.rows.get(change.expected.inputId)
    const after = change.row
    if (type === 'admitted') {
      if (before || change.expected.generation !== 0 || after.generation !== 1 || after.phase !== 'admitted')
        throw new Error('Invalid journal admission')
      return
    }
    if (
      !before ||
      before.generation !== change.expected.generation ||
      before.phase === 'closed' ||
      after.generation !== before.generation + (type === 'notice-owned' ? 0 : 1) ||
      before.identity !== after.identity ||
      before.epoch !== after.epoch ||
      before.accountIdentity !== after.accountIdentity ||
      canonical(before.target) !== canonical(after.target) ||
      canonical(before.principal) !== canonical(after.principal)
    )
      throw new Error('Stale or conflicting journal generation')
    if (
      canonical([before.acceptedAt, before.reference, before.sourceParentSessionId]) !==
      canonical([after.acceptedAt, after.reference, after.sourceParentSessionId])
    )
      throw new Error('Inbound transition changes immutable reference metadata')
    if (
      type === 'turn-claimed' &&
      (!['admitted', 'turn-owned'].includes(before.phase) ||
        after.phase !== 'turn-owned' ||
        (before.claim && (before.claim.turnId !== after.claim?.turnId || before.claim.epoch !== after.claim?.epoch)))
    )
      throw new Error('Invalid journal claim')
    if (type === 'ownership-moved' && (before.phase !== 'turn-owned' || after.phase !== 'turn-owned'))
      throw new Error('Invalid journal move')
    if (type === 'outcome-decided' && after.phase !== 'closed') throw new Error('Invalid journal outcome')
    if (type === 'notice-prepared' && (before.transfer || after.phase !== 'notice-prepared'))
      throw new Error('Invalid notice preparation')
    if (
      type === 'notice-owned' &&
      (before.phase !== 'notice-prepared' ||
        after.phase !== 'notice-owned' ||
        canonical(before.transfer) !== canonical(after.transfer))
    )
      throw new Error('Invalid notice ownership')
  }
  private async append(line: Line, repair = false) {
    if (repair) {
      if (!this.fd) throw new Error('Journal repair has no file handle')
    } else this.assertAvailable()
    try {
      const start = performance.now()
      await this.fd!.writeFile(`${JSON.stringify(line)}\n`)
      await this.options.onDurability?.('append-written', line)
      await this.fd!.sync()
      this.options.onSync?.(performance.now() - start)
      await this.options.onDurability?.('append-synced', line)
      this.fold(line)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }
  private async applyBackground(decision: Decision, repair = false) {
    if (!decision.backgroundChanges.length || this.applied.has(decision.transitionId)) return
    if (!this.background) throw new Error('Mixed decision requires background store')
    const identity = { transitionId: decision.transitionId, decisionDigest: digest(decision) }
    for (const change of decision.backgroundChanges) {
      if (this.initializationCancelled) return
      const apply = (current: Readonly<BackgroundObligation>) => {
        const next = change.row
        if (
          canonical([
            current.taskId,
            current.parentSessionId,
            current.parentSessionFile,
            current.accountIdentity,
            current.target,
            current.principal,
            current.epoch,
            current.acceptedAt,
          ]) !==
          canonical([
            next.taskId,
            next.parentSessionId,
            next.parentSessionFile,
            next.accountIdentity,
            next.target,
            next.principal,
            next.epoch,
            next.acceptedAt,
          ])
        )
          throw new Error('Mixed decision changes immutable background provenance')
        if (
          decision.type === 'turn-claimed' &&
          (current.transfer ||
            !['result-ready', 'turn-owned'].includes(current.phase) ||
            (current.claim &&
              (current.claim.turnId !== next.claim?.turnId ||
                current.claim.epoch !== next.claim?.epoch ||
                current.claim.ownerSessionId !== next.claim?.ownerSessionId)))
        )
          throw new Error('Mixed claim changes background owner')
        if (decision.type === 'ownership-moved' && current.phase !== 'turn-owned')
          throw new Error('Mixed move has no prior background owner')
        if (decision.type === 'notice-prepared' && current.transfer) throw new Error('Mixed transfer already prepared')
        return copy(next)
      }
      const row = repair
        ? await this.background.applyJournalDecision(change.expected, identity, apply)
        : await this.background.apply(change.expected, identity, apply)
      const receipt = row?.applications.find((r) => r.transitionId === identity.transitionId)
      if (
        !receipt ||
        receipt.decisionDigest !== identity.decisionDigest ||
        receipt.expectedGeneration !== change.expected.generation ||
        receipt.resultingGeneration !== change.row.generation
      )
        throw new Error('Mixed application conflict')
    }
    await this.options.onDurability?.('mixed-json-applied', decision)
    if (this.initializationCancelled) return
    await this.append(
      {
        schemaVersion: 1,
        seq: this.sequence + 1,
        transitionId: `applied:${decision.transitionId}`,
        epoch: this.epoch,
        type: 'mixed-applied',
        decisionId: decision.transitionId,
        decisionDigest: digest(decision),
      },
      repair,
    )
  }
  private async repairInternal() {
    this.background?.setFrozen(new Error('Inbound journal repair pending'))
    try {
      for (const decision of [...this.decisions.values()].sort((a, b) => a.seq - b.seq)) {
        if (this.initializationCancelled) return
        if (!decision.backgroundChanges.length || this.applied.has(decision.transitionId)) continue
        const target = decision.backgroundChanges[0]!.row.target
        await this.background!.withTargetLane(target, () => this.applyBackground(decision, true))
      }
      if (this.initializationCancelled) return
      this.frozen = undefined
      this.background?.setFrozen(undefined)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }
  repair() {
    return this.serialized(async () => {
      this.assertAvailable()
      await this.repairInternal()
    })
  }
  private async commit(
    type: string,
    changes: Change[],
    backgroundChanges: BackgroundChange[],
    transitionId: string = randomUUID(),
    requestDigest?: string,
  ) {
    this.assertAvailable()
    const receipt = this.receipts.get(transitionId)
    if (receipt) {
      if (receipt.payloadDigest !== digest([type, changes, backgroundChanges]))
        throw new Error('Conflicting duplicate transition identity')
      return receipt
    }
    const previous = this.decisions.get(transitionId)
    if (previous) {
      if (
        canonical([previous.type, previous.changes, previous.backgroundChanges]) !==
        canonical([type, changes, backgroundChanges])
      )
        throw new Error('Conflicting duplicate transition identity')
      await this.applyBackground(previous)
      return previous
    }
    const decision: Decision = {
      schemaVersion: 1,
      seq: this.sequence + 1,
      epoch: this.epoch,
      transitionId,
      type,
      changes,
      backgroundChanges,
      requestDigest,
    }
    this.validateDecision(decision)
    for (const change of changes) this.validateChange(change, type)
    await this.append(decision)
    try {
      await this.applyBackground(decision)
    } catch (error) {
      this.fail(error)
      throw error
    }
    return decision
  }
  async admit(
    input: InboundAdmission,
  ): Promise<
    | { kind: 'accepted'; inputId: string; generation: number }
    | { kind: 'duplicate'; inputId: string; outcome?: InboundOutcome }
  > {
    await this.initialize()
    return this.serialized(async () => {
      this.assertAvailable()
      if (
        !input.accountIdentity ||
        !input.eventKind ||
        typeof input.revision !== 'string' ||
        !(input.messageId || input.receiptId)
      )
        throw new Error('Missing inbound continuity identity')
      const identity = canonical([
        dirname(dirname(this.path)),
        input.accountIdentity,
        channelKeyId(input.target),
        input.messageId ?? input.receiptId,
        input.eventKind,
        input.revision,
      ])
      const inputId = digest(['inbound', identity])
      const existing = this.rows.get(inputId)
      if (existing) {
        if (canonical(existing.principal) !== canonical(input.principal))
          throw new Error('Conflicting duplicate admission principal')
        return { kind: 'duplicate' as const, inputId, outcome: copy(existing.outcome ?? null) ?? undefined }
      }
      const row: InboundRecord = {
        schemaVersion: 1,
        inputId,
        identity,
        generation: 1,
        accountIdentity: input.accountIdentity,
        target: copy(input.target),
        principal: copy(input.principal),
        epoch: this.epoch,
        acceptedAt: (this.options.now ?? Date.now)(),
        phase: 'admitted',
        reference: { messageId: input.messageId, receiptId: input.receiptId },
        sourceParentSessionId: input.ownerSessionId,
      }
      await this.commit('admitted', [{ expected: { inputId, generation: 0 }, row }], [], `admit:${inputId}`)
      return { kind: 'accepted' as const, inputId, generation: 1 }
    })
  }
  get(inputId: string) {
    this.assertAvailable()
    const row = this.rows.get(inputId)
    return row ? copy(row) : undefined
  }
  list() {
    this.assertAvailable()
    return [...this.rows.values()].map(copy)
  }
  resolve(ids: readonly string[]): InboundRef[] {
    return ids.map((inputId) => {
      const row = this.get(inputId)
      if (!row) throw new Error('Unknown inbound ID')
      return { inputId, generation: row.generation }
    })
  }
  private coverage(refs: InboundRef[], target: ChannelKey) {
    const seen = new Set<string>()
    return refs.map((ref) => {
      const row = this.get(ref.inputId)
      if (
        !row ||
        seen.has(ref.inputId) ||
        row.generation !== ref.generation ||
        row.phase === 'closed' ||
        channelKeyId(row.target) !== channelKeyId(target)
      )
        throw new Error('Invalid inbound coverage')
      seen.add(ref.inputId)
      return row
    })
  }
  private async backgroundCoverage(refs: BackgroundObligationRef[], target: ChannelKey, inbound: InboundRecord[]) {
    if (refs.length && !this.background) throw new Error('Missing background store')
    const seen = new Set<string>()
    const rows: BackgroundObligation[] = []
    for (const ref of refs) {
      const row = await this.background!.get(ref.obligationId)
      if (
        !row ||
        seen.has(ref.obligationId) ||
        row.generation !== ref.generation ||
        row.phase === 'closed' ||
        channelKeyId(row.target) !== channelKeyId(target) ||
        (inbound.length && row.accountIdentity !== inbound[0]!.accountIdentity)
      )
        throw new Error('Invalid mixed background coverage')
      seen.add(ref.obligationId)
      rows.push(row)
    }
    return rows
  }
  private result(rows: InboundRecord[], background: BackgroundObligation[]) {
    return {
      inboundRefs: rows.map((r) => ({ inputId: r.inputId, generation: r.generation })),
      backgroundRefs: background.map((r) => ({ obligationId: r.obligationId, generation: r.generation })),
    }
  }
  claim(refs: InboundRef[], owner: Owner, backgroundRefs: BackgroundObligationRef[] = [], decisionId?: string) {
    return this.changeOwner('turn-claimed', refs, owner, backgroundRefs, decisionId)
  }
  move(
    refs: InboundRef[],
    owner: Owner & { fromTurnId: string },
    backgroundRefs: BackgroundObligationRef[] = [],
    decisionId?: string,
  ) {
    return this.changeOwner('ownership-moved', refs, owner, backgroundRefs, decisionId)
  }
  private async repeated(transitionId: string | undefined, requestDigest: string) {
    this.assertAvailable()
    const receipt = transitionId ? this.receipts.get(transitionId) : undefined
    const previous = transitionId ? this.decisions.get(transitionId) : undefined
    const identity = receipt ?? previous
    if (!identity) return undefined
    if (identity.requestDigest !== requestDigest) throw new Error('Conflicting duplicate transition identity')
    if (previous) await this.applyBackground(previous)
    const result = receipt
      ? copy({ inboundRefs: receipt.inboundRefs, backgroundRefs: receipt.backgroundRefs })
      : this.result(
          previous!.changes.map((c) => c.row),
          previous!.backgroundChanges.map((c) => c.row),
        )
    if (identity.type === 'turn-claimed' || identity.type === 'ownership-moved') {
      for (const ref of result.inboundRefs) {
        const row = this.get(ref.inputId)
        if (!row || row.generation !== ref.generation || row.phase !== 'turn-owned' || row.claim?.epoch !== this.epoch)
          throw new Error('Journal ownership decision superseded')
      }
      for (const ref of result.backgroundRefs) {
        const row = await this.background?.get(ref.obligationId)
        if (!row || row.generation !== ref.generation || row.phase !== 'turn-owned' || row.claim?.epoch !== this.epoch)
          throw new Error('Background ownership decision superseded')
      }
    }
    return result
  }
  private changeOwner(
    type: string,
    refs: InboundRef[],
    owner: Owner,
    brefs: BackgroundObligationRef[],
    decisionId?: string,
  ) {
    return this.serialized(async () => {
      const requestDigest = digest([type, refs, owner, brefs])
      const repeated = await this.repeated(decisionId, requestDigest)
      if (repeated) return repeated
      const rows = this.coverage(refs, owner.target)
      const bg = await this.backgroundCoverage(brefs, owner.target, rows)
      for (const row of [...rows, ...bg]) {
        if (
          row.transfer ||
          (type === 'ownership-moved'
            ? row.claim?.turnId !== owner.fromTurnId
            : row.claim &&
              (row.claim.turnId !== owner.turnId ||
                row.claim.epoch !== this.epoch ||
                row.claim.ownerSessionId !== owner.ownerSessionId)) ||
          ('obligationId' in row && type === 'turn-claimed' && !['result-ready', 'turn-owned'].includes(row.phase))
        )
          throw new Error('Invalid claim owner')
      }
      const next = rows.map((row) => ({
        ...row,
        generation: row.generation + 1,
        phase: 'turn-owned' as const,
        claim: {
          turnId: owner.turnId,
          ownerSessionId: owner.ownerSessionId,
          epoch: this.epoch,
          generation: row.generation + 1,
        },
      }))
      const nextBg = bg.map((row) => ({
        ...row,
        generation: row.generation + 1,
        phase: 'turn-owned' as const,
        claim: {
          turnId: owner.turnId,
          ownerSessionId: owner.ownerSessionId,
          epoch: this.epoch,
          generation: row.generation + 1,
        },
      }))
      await this.commit(
        type,
        next.map((row, i) => ({ expected: refs[i]!, row })),
        nextBg.map((row, i) => ({ expected: brefs[i]!, row })),
        decisionId,
        requestDigest,
      )
      return this.result(next, nextBg)
    })
  }
  settle(refs: InboundRef[], outcome: InboundOutcome, brefs: BackgroundObligationRef[] = [], target?: ChannelKey) {
    return this.serialized(async () => {
      const requestDigest = digest(['outcome-decided', refs, outcome, brefs, target])
      const repeated = await this.repeated(outcome.decisionId, requestDigest)
      if (repeated) return repeated
      const destination =
        target ??
        this.get(refs[0]?.inputId ?? '')?.target ??
        (brefs[0] ? (await this.background?.get(brefs[0].obligationId))?.target : undefined)
      if (!destination) {
        if (!refs.length && !brefs.length) return this.result([], [])
        throw new Error('Missing outcome target')
      }
      const rows = this.coverage(refs, destination)
      const bg = await this.backgroundCoverage(brefs, destination, rows)
      const next = rows.map((row) => ({
        ...row,
        generation: row.generation + 1,
        phase: 'closed' as const,
        outcome,
        claim: undefined,
      }))
      const nextBg = bg.map((row) => ({
        ...row,
        generation: row.generation + 1,
        phase: 'closed' as const,
        outcome,
        claim: undefined,
      }))
      await this.commit(
        'outcome-decided',
        next.map((row, i) => ({ expected: refs[i]!, row })),
        nextBg.map((row, i) => ({ expected: brefs[i]!, row })),
        outcome.decisionId,
        requestDigest,
      )
      return this.result(next, nextBg)
    })
  }
  prepareNotice(
    refs: InboundRef[],
    target: ChannelKey,
    brefs: BackgroundObligationRef[] = [],
    ownerSessionId?: string,
  ) {
    return this.serialized(async () => {
      this.assertAvailable()
      const requestDigest = digest(['notice-prepared', refs, target, brefs, ownerSessionId])
      const transitionId = `prepare:${digest(['inbound-transfer', refs, brefs])}`
      const prior = this.decisions.get(transitionId)
      const receipt = this.receipts.get(transitionId)
      if (prior || receipt) {
        if ((prior ?? receipt)!.requestDigest !== requestDigest)
          throw new Error('Conflicting duplicate notice preparation')
        const transfer = prior?.changes[0]?.row.transfer ?? this.get(receipt!.inboundRefs[0]!.inputId)?.transfer
        if (!transfer || channelKeyId(transfer.target) !== channelKeyId(target))
          throw new Error('Conflicting duplicate notice preparation')
        return copy(transfer)
      }
      const rows = this.coverage(refs, target)
      const bg = await this.backgroundCoverage(brefs, target, rows)
      if (!rows.length) throw new Error('Inbound notice requires inbound coverage')
      if ([...rows, ...bg].some((row) => canonical(row.principal) !== canonical(rows[0]!.principal)))
        throw new Error('Notice coverage must be partitioned by principal')
      if ([...rows, ...bg].some((row) => row.transfer)) throw new Error('Already transferred coverage')
      const transferId = digest(['inbound-transfer', refs, brefs])
      const parents = rows.map((row) => row.claim?.ownerSessionId ?? ownerSessionId ?? row.sourceParentSessionId)
      if (new Set(parents).size !== 1) throw new Error('Notice coverage must be partitioned by owner')
      const transfer = createRecoveryNotice({
        target,
        accountIdentity: rows[0]!.accountIdentity,
        principal: rows[0]!.principal,
        transferId,
        recoveryGeneration: transferId,
        sourceParentSessionId: parents[0],
        covers: [
          ...refs.map((r, i) => ({
            store: 'inbound' as const,
            id: r.inputId,
            generation: r.generation + 1,
            ...(parents[i] ? { parentSessionId: parents[i] } : {}),
          })),
          ...brefs.map((r, i) => ({
            store: 'background' as const,
            id: r.obligationId,
            generation: r.generation + 1,
            parentSessionId: bg[i]!.parentSessionId,
          })),
        ],
      })
      const next = rows.map((row) => ({
        ...row,
        generation: row.generation + 1,
        phase: 'notice-prepared' as const,
        transfer,
        claim: undefined,
      }))
      const nextBg = bg.map((row) => ({
        ...row,
        generation: row.generation + 1,
        phase: 'notice-prepared' as const,
        transfer,
        claim: undefined,
      }))
      await this.commit(
        'notice-prepared',
        next.map((row, i) => ({ expected: refs[i]!, row })),
        nextBg.map((row, i) => ({ expected: brefs[i]!, row })),
        `prepare:${transferId}`,
        requestDigest,
      )
      return transfer
    })
  }
  async importPrepared(outbox: RecoveryOutbox, transfer: RecoveryRecord) {
    this.assertAvailable()
    parseRecoveryRecord(transfer)
    for (const cover of transfer.covers.filter((c) => c.store === 'inbound')) {
      const row = this.get(cover.id)
      if (!row?.transfer || recoveryPayload(row.transfer) !== recoveryPayload(transfer))
        throw new Error('Prepared frozen payload mismatch')
    }
    const imported = await outbox.import(transfer)
    await this.serialized(async () => {
      const rows = transfer.covers.filter((c) => c.store === 'inbound').map((c) => this.get(c.id))
      if (rows.some((row) => !row || row.transfer?.deliveryId !== transfer.deliveryId))
        throw new Error('Prepared transfer mismatch')
      for (const c of transfer.covers.filter((c) => c.store === 'background')) {
        const row = await this.background?.ownNotice(c.id, c.generation, transfer.deliveryId)
        if (!row && imported.state !== 'delivered' && imported.state !== 'suppressed')
          throw new Error('Background notice ownership conflict')
      }
      const pending = rows.filter((row): row is InboundRecord => !!row && row.phase === 'notice-prepared')
      if (pending.length)
        await this.commit(
          'notice-owned',
          pending.map((row) => ({
            expected: { inputId: row.inputId, generation: row.generation },
            row: { ...row, phase: 'notice-owned' },
          })),
          [],
          `owned:${transfer.transferId}`,
        )
    })
    await this.acknowledgeNotice(imported)
    return imported
  }
  lookupAdmission(input: Omit<InboundAdmission, 'principal'> & { principal?: MatchableOrigin }) {
    this.assertAvailable()
    const identity = canonical([
      dirname(dirname(this.path)),
      input.accountIdentity,
      channelKeyId(input.target),
      input.messageId ?? input.receiptId,
      input.eventKind,
      input.revision,
    ])
    return this.get(digest(['inbound', identity]))
  }
  async importOldEpoch(outbox: RecoveryOutbox) {
    await this.initialize()
    for (const source of this.list()) {
      if (source.phase === 'closed' || (source.epoch === this.epoch && !source.transfer)) continue
      const action = async () => {
        const current = this.get(source.inputId)!
        if (current.phase === 'closed') return
        const transfer =
          current.transfer ??
          (await this.prepareNotice([{ inputId: current.inputId, generation: current.generation }], current.target))
        await this.importPrepared(outbox, transfer)
      }
      if (this.background) await this.background.withTargetLane(source.target, action)
      else await action()
    }
  }
  async validateNotice(record: RecoveryRecord): Promise<'open' | 'resolved'> {
    this.assertAvailable()
    let open = false
    parseRecoveryRecord(record)
    for (const cover of record.covers.filter((c) => c.store === 'inbound')) {
      const row = this.get(cover.id)
      if (!row?.transfer || recoveryPayload(row.transfer) !== recoveryPayload(record))
        throw new Error('Invalid inbound notice authority')
      if (row.phase === 'closed') continue
      if (row.phase !== 'notice-owned' || row.generation !== cover.generation)
        throw new Error('Inbound notice not owned')
      open = true
    }
    if (record.covers.some((c) => c.store === 'background')) {
      if (!this.background) throw new Error('Missing background authority')
      if ((await this.background.validateNotice(record)) === 'open') open = true
    }
    return open ? 'open' : 'resolved'
  }
  async acknowledgeNotice(record: RecoveryRecord) {
    if (!['delivered', 'suppressed'].includes(record.state)) return
    await this.closeNotice(record, {
      kind: record.state === 'delivered' ? 'delivered' : 'intentionally-suppressed',
      decisionId: record.suppression?.decisionId ?? `recovery:${record.deliveryId}`,
      deliveryId: record.deliveryId,
      reason: record.suppression?.reason,
    })
  }
  suppressNoticeCoverage(record: RecoveryRecord, decision: { decisionId: string; reason: string }) {
    return this.closeNotice(record, { kind: 'intentionally-suppressed', ...decision, deliveryId: record.deliveryId })
  }
  private async closeNotice(record: RecoveryRecord, outcome: InboundOutcome) {
    parseRecoveryRecord(record)
    const refs: InboundRef[] = []
    const bg: BackgroundObligationRef[] = []
    for (const c of record.covers) {
      if (c.store === 'inbound') {
        const row = this.get(c.id)
        if (!row?.transfer || recoveryPayload(row.transfer) !== recoveryPayload(record))
          throw new Error('Inbound receipt mismatch')
        if (row.phase !== 'closed') refs.push({ inputId: c.id, generation: c.generation })
      }
      if (c.store === 'background') {
        const row = await this.background?.get(c.id)
        if (!row?.transfer || recoveryPayload(row.transfer) !== recoveryPayload(record))
          throw new Error('Background receipt mismatch')
        if (row.phase !== 'closed') bg.push({ obligationId: c.id, generation: c.generation })
      }
    }
    if (refs.length || bg.length) await this.settle(refs, outcome, bg, record.target)
  }
  compact() {
    return this.serialized(async () => {
      this.assertAvailable()
      const receipts = new Map(this.receipts)
      const pending: Decision[] = []
      for (const decision of this.decisions.values()) {
        if (decision.backgroundChanges.length && !this.applied.has(decision.transitionId)) {
          pending.push(decision)
          continue
        }
        const result = this.result(
          decision.changes.map((c) => c.row),
          decision.backgroundChanges.map((c) => c.row),
        )
        receipts.set(decision.transitionId, {
          transitionId: decision.transitionId,
          seq: decision.seq,
          type: decision.type,
          decisionDigest: digest(decision),
          payloadDigest: digest([decision.type, decision.changes, decision.backgroundChanges]),
          requestDigest: decision.requestDigest,
          ...result,
        })
      }
      const snapshot: Snapshot = {
        schemaVersion: 1,
        seq: Math.max(1, this.sequence),
        type: 'snapshot',
        rows: [...this.rows.values()],
        decisions: pending,
        receipts: [...receipts.values()],
      }
      const temp = `${this.path}.${randomUUID()}.tmp`
      try {
        const fd = await open(temp, 'wx', 0o600)
        try {
          await fd.writeFile(`${JSON.stringify(snapshot)}\n`)
          await fd.sync()
        } finally {
          await fd.close()
        }
        await this.options.onDurability?.('temp-synced', snapshot)
        await this.fd!.close()
        this.fd = undefined
        await this.options.onDurability?.('handle-closed', snapshot)
        await rename(temp, this.path)
        await this.options.onDurability?.('replaced', snapshot)
        await syncDirectory(dirname(this.path))
        await this.options.onDurability?.('directory-synced', snapshot)
        this.fd = await open(this.path, 'a+', 0o600)
        this.sequence = snapshot.seq
        this.receipts = receipts
        this.decisions = new Map(pending.map((d) => [d.transitionId, d]))
        this.applied.clear()
        await this.options.onDurability?.('reopened', snapshot)
      } catch (error) {
        this.fail(error)
        throw error
      }
    })
  }
  async flush() {
    await this.queue
  }
  close() {
    this.cancelInitialization()
    return (this.closing ??= this.serialized(async () => {
      try {
        await this.fd?.close()
      } finally {
        this.fd = undefined
        if (activeWriters.get(this.path) === this) activeWriters.delete(this.path)
      }
    }))
  }
}
