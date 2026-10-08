import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { z } from 'zod'

import type { MatchableOrigin } from '../permissions/resolve'
import type { BackgroundObligation, BackgroundObligationRef, BackgroundObligationStore } from './background-obligations'
import { parseBackgroundObligation } from './background-obligations'
import { parseRecoveryRecord, recoveryPayload } from './continuity-types'
import type { RecoveryNoticeCause, RecoveryRecord } from './continuity-types'
import { createRecoveryNotice, recoveryNoticePartitionKey } from './recovery-notice'
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
type InboundReference = { messageId?: string; receiptId?: string }
/** An input that still owes a response or a notice keeps its full admission provenance. */
export type OpenInboundRecord = InboundRef & {
  schemaVersion: 1
  identity: string
  accountIdentity: string
  target: ChannelKey
  principal: MatchableOrigin
  epoch: string
  acceptedAt: number
  reference?: InboundReference
  sourceParentSessionId?: string
  phase: 'admitted' | 'turn-owned' | 'notice-prepared' | 'notice-owned'
  claim?: { turnId: string; ownerSessionId?: string; epoch: string; generation: number }
  transfer?: RecoveryRecord
}
/**
 * Closed authority, kept indefinitely because no adapter replay floor is proven. It holds only what a
 * later delivery or stale callback is judged against: the exact identity (`inputId`), the terminal
 * generation and outcome, the frozen author fence, the Slack message representative (`messageKey`,
 * ordered by `acceptedAt`), the platform reference, and the delivery of the frozen notice that
 * covered it (whose payload the journal keeps once per delivery).
 */
export type ClosedInboundRecord = InboundRef & {
  phase: 'closed'
  acceptedAt: number
  reference?: InboundReference
  principalDigest: string
  messageKey?: string
  outcome: InboundOutcome
  noticeDeliveryId?: string
}
export type InboundRecord = OpenInboundRecord | ClosedInboundRecord
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
/** The schema-1 row every decision line carries in full, closed rows included. */
type JournalRow = Omit<OpenInboundRecord, 'phase'> & { phase: InboundRecord['phase']; outcome?: InboundOutcome }
type Owner = { turnId: string; ownerSessionId?: string; target: ChannelKey; fromTurnId?: string }
type Change = { expected: InboundRef; row: JournalRow }
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
  /** Absent only on receipts carried over from a schema-1 snapshot. */
  epoch?: string
  type: string
  decisionDigest: string
  payloadDigest: string
  requestDigest?: string
  inboundRefs: InboundRef[]
  backgroundRefs: BackgroundObligationRef[]
}
/** Snapshot written before tombstones: every row in full. Read-only compatibility. */
type LegacySnapshot = {
  schemaVersion: 1
  seq: number
  type: 'snapshot'
  rows: JournalRow[]
  decisions: Decision[]
  receipts: DecisionReceipt[]
}
type SnapshotOpenRow = Omit<OpenInboundRecord, 'transfer'> & { notice?: string }
type Snapshot = {
  schemaVersion: 2
  seq: number
  type: 'snapshot'
  /** Frozen transfer payloads, once per delivery; rows refer to them by deliveryId. */
  notices: RecoveryRecord[]
  open: SnapshotOpenRow[]
  closed: ClosedInboundRecord[]
  /** Mixed decisions whose background application is not yet recorded, in full. */
  decisions: Decision[]
  receipts: DecisionReceipt[]
}
type Line = Decision | Applied | LegacySnapshot | Snapshot
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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const principalDigest = (principal: MatchableOrigin) => digest(['principal', principal])
/** Below this much growth the journal is never rewritten; above it, once growth reaches the last snapshot's size. */
const COMPACTION_FLOOR_BYTES = 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024
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
const hex = z.string().regex(/^[a-f0-9]{64}$/)
const referenceSchema = z.object({ messageId: nonempty.optional(), receiptId: nonempty.optional() }).strict()
const outcomeSchema = z
  .object({
    kind: z.enum(['delivered', 'intentionally-suppressed']),
    decisionId: nonempty,
    reason: z.string().optional(),
    deliveryId: nonempty.optional(),
  })
  .strict()
const rowSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputId: hex,
    generation: positive,
    identity: nonempty,
    accountIdentity: nonempty,
    epoch: nonempty,
    acceptedAt: z.number().finite().nonnegative(),
    target: z.unknown(),
    principal: z.unknown(),
    reference: referenceSchema.optional(),
    sourceParentSessionId: nonempty.optional(),
    phase: z.enum(['admitted', 'turn-owned', 'notice-prepared', 'notice-owned', 'closed']),
    claim: z
      .object({ turnId: nonempty, ownerSessionId: nonempty.optional(), epoch: nonempty, generation: positive })
      .strict()
      .optional(),
    transfer: z.unknown().optional(),
    outcome: outcomeSchema.optional(),
  })
  .strict()
const closedSchema = z
  .object({
    inputId: hex,
    generation: positive,
    phase: z.literal('closed'),
    acceptedAt: z.number().finite().nonnegative(),
    reference: referenceSchema.optional(),
    principalDigest: hex,
    messageKey: hex.optional(),
    outcome: outcomeSchema,
    noticeDeliveryId: hex.optional(),
  })
  .strict()
const inboundExpectedSchema = z
  .object({
    inputId: hex,
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
const backgroundExpectedSchema = z.object({ obligationId: hex, generation: positive }).strict()
const decisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    seq: positive,
    transitionId: nonempty,
    epoch: nonempty,
    type: z.enum(['admitted', 'turn-claimed', 'ownership-moved', 'outcome-decided', 'notice-prepared', 'notice-owned']),
    changes: z.array(z.object({ expected: inboundExpectedSchema, row: z.unknown() }).strict()),
    backgroundChanges: z.array(z.object({ expected: backgroundExpectedSchema, row: z.unknown() }).strict()),
    requestDigest: hex.optional(),
  })
  .strict()
const legacyReceiptSchema = z
  .object({
    transitionId: nonempty,
    seq: positive,
    type: decisionSchema.shape.type,
    decisionDigest: hex,
    payloadDigest: hex,
    requestDigest: hex.optional(),
    inboundRefs: z.array(inboundExpectedSchema),
    backgroundRefs: z.array(backgroundExpectedSchema),
  })
  .strict()
const receiptSchema = legacyReceiptSchema.extend({ epoch: nonempty.optional() }).strict()
const legacySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    seq: positive,
    type: z.literal('snapshot'),
    rows: z.array(z.unknown()),
    decisions: z.array(z.unknown()),
    receipts: z.array(legacyReceiptSchema),
  })
  .strict()
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    seq: positive,
    type: z.literal('snapshot'),
    notices: z.array(z.unknown()),
    open: z.array(z.unknown()),
    closed: z.array(closedSchema),
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
    decisionDigest: hex,
  })
  .strict()
function validateRow(row: JournalRow) {
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
// Boot has no live owner: the captured claim owner supersedes the immutable admission/launch parent.
const inboundPartition = (row: OpenInboundRecord) =>
  recoveryNoticePartitionKey({
    target: row.target,
    accountIdentity: row.accountIdentity,
    principal: row.principal,
    parentSessionId: row.claim?.ownerSessionId ?? row.sourceParentSessionId,
  })
const backgroundPartition = (row: BackgroundObligation) =>
  recoveryNoticePartitionKey({
    target: row.target,
    accountIdentity: row.accountIdentity,
    principal: row.principal,
    parentSessionId: row.claim?.ownerSessionId ?? row.parentSessionId,
  })
/**
 * A Slack message is its ts within the authenticated account's workspace/chat. Routing thread and
 * edit revision are delivery shapes of that one message, so a single admission answers all of them.
 * The key is a digest so a closed tombstone can keep it without the identity it was derived from.
 */
const slackMessageKey = (input: {
  root: string
  accountIdentity: string
  target: ChannelKey
  messageId?: string
  eventKind: string
}) =>
  (input.target.adapter === 'slack' || input.target.adapter === 'slack-bot') && input.messageId
    ? digest([
        'slack-message',
        input.root,
        input.accountIdentity,
        input.target.adapter,
        input.target.workspace,
        input.target.chat,
        input.messageId,
        input.eventKind,
      ])
    : undefined
/** Derived from the stored identity tuple; rows that cannot be decoded keep exact-identity dedupe only. */
function storedSlackMessageKey(row: JournalRow) {
  const messageId = row.reference?.messageId
  if (!messageId || (row.target.adapter !== 'slack' && row.target.adapter !== 'slack-bot')) return undefined
  let tuple: unknown
  try {
    tuple = JSON.parse(row.identity)
  } catch {
    return undefined
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 6 ||
    typeof tuple[0] !== 'string' ||
    typeof tuple[4] !== 'string' ||
    !tuple[4] ||
    tuple[1] !== row.accountIdentity ||
    tuple[2] !== channelKeyId(row.target) ||
    tuple[3] !== messageId
  )
    return undefined
  return slackMessageKey({
    root: tuple[0],
    accountIdentity: row.accountIdentity,
    target: row.target,
    messageId,
    eventKind: tuple[4],
  })
}
/** The closed form of a full row: identity, terminal state and fences only. */
function tombstone(row: JournalRow): ClosedInboundRecord {
  const messageKey = storedSlackMessageKey(row)
  return {
    inputId: row.inputId,
    generation: row.generation,
    phase: 'closed',
    acceptedAt: row.acceptedAt,
    ...(row.reference ? { reference: row.reference } : {}),
    principalDigest: principalDigest(row.principal),
    ...(messageKey ? { messageKey } : {}),
    outcome: row.outcome!,
    ...(row.transfer ? { noticeDeliveryId: row.transfer.deliveryId } : {}),
  }
}

/** Single-runtime writer. Callers hold the background target lane through coverage reads and cache publication. */
export class InboundJournal {
  readonly epoch: string
  readonly path: string
  private fd?: FileHandle
  private sequence = 0
  /** Open rows in full, closed rows as tombstones. Never pruned: no replay floor is proven. */
  private rows = new Map<string, InboundRecord>()
  /** Slack message key → representative inputId; rebuilt from durable rows, never persisted. */
  private slackMessages = new Map<string, string>()
  /** Frozen transfer payload, once per delivery; rows refer to it by deliveryId. */
  private notices = new Map<string, RecoveryRecord>()
  /** Mixed decisions not yet recorded as applied: the only decision bodies kept. */
  private decisions = new Map<string, Decision>()
  /** Idempotency fences a caller can still present; see `retainsReceipt`. */
  private receipts = new Map<string, DecisionReceipt>()
  /** Transition IDs this writer minted itself and never handed to any caller. */
  private minted = new Set<string>()
  private snapshotBytes = 0
  private growthBytes = 0
  private maintaining = false
  private compactionQueued = false
  /**
   * True only while a healthy compaction swaps the closed handle for the installed file's reopened
   * one. The writer queue is held for the whole swap, so in-memory state stays authoritative and
   * readable; no write can run until the replacement handle exists.
   */
  private swapping = false
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
          | 'compaction-started'
          | 'temp-synced'
          | 'handle-closed'
          | 'replaced'
          | 'directory-synced'
          | 'reopened',
        record?: unknown,
      ) => void | Promise<void>
      onSync?: (milliseconds: number) => void
      /** Internal: growth below which maintenance never rewrites. Not operator configuration. */
      compactionFloorBytes?: number
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
  /** Operational: initialized writer, not cancelled, frozen or closed, holding a handle or mid-swap. */
  assertAvailable() {
    if (this.initializationCancelled || this.frozen !== undefined || !(this.fd || this.swapping))
      throw new Error('Inbound continuity frozen pending repair', { cause: this.frozen })
  }
  health() {
    return {
      available: !this.initializationCancelled && this.frozen === undefined && !!(this.fd || this.swapping),
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
        const { end, size } = await this.load()
        await this.options.onDurability?.('initialization-read')
        if (this.initializationCancelled) return
        if (end !== size) {
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
  /**
   * One strict pass over the durable journal: each LF-terminated line is decoded as fatal UTF-8,
   * parsed and folded as it is read, so only normalized state is retained. Bytes after the last LF
   * are a torn append and are reported for truncation; any complete line that fails throws and
   * leaves the file untouched.
   */
  private async load(): Promise<{ end: number; size: number }> {
    let handle: FileHandle
    try {
      handle = await open(this.path, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { end: 0, size: 0 }
    }
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      let partial: Buffer[] = []
      let size = 0
      let end = 0
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (!bytesRead) break
        const view = chunk.subarray(0, bytesRead)
        let start = 0
        for (let lf = view.indexOf(10); lf !== -1; lf = view.indexOf(10, start)) {
          const line = partial.length ? Buffer.concat([...partial, view.subarray(start, lf)]) : view.subarray(start, lf)
          partial = []
          let text = decoder.decode(line)
          // A whole-file decode skipped one leading byte-order mark; per-line decoding keeps that rule.
          if (end === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
          this.fold(JSON.parse(text) as Line, line.length + 1)
          start = lf + 1
          end = size + start
        }
        if (start < bytesRead) partial.push(Buffer.from(view.subarray(start)))
        size += bytesRead
      }
      return { end, size }
    } finally {
      await handle.close()
    }
  }
  private fold(line: Line, bytes: number) {
    if (!line || !integer(line.seq)) throw new Error('Invalid journal version or sequence')
    if (line.type === 'snapshot') {
      if (line.schemaVersion !== 1 && line.schemaVersion !== 2) throw new Error('Invalid journal version or sequence')
      if (this.sequence) throw new Error('Invalid journal snapshot position')
      if (line.schemaVersion === 2) this.foldSnapshot(line)
      else this.foldLegacySnapshot(line as LegacySnapshot)
      this.snapshotBytes = bytes
      this.growthBytes = 0
    } else {
      if (line.schemaVersion !== 1) throw new Error('Invalid journal version or sequence')
      if (line.seq !== this.sequence + 1) throw new Error('Noncontiguous journal sequence')
      if (line.type === 'mixed-applied') this.foldApplied(line as Applied)
      else this.foldDecision(line as Decision)
      this.growthBytes += bytes
    }
    this.sequence = line.seq
  }
  private foldLegacySnapshot(snap: LegacySnapshot) {
    legacySnapshotSchema.parse(snap)
    for (const row of snap.rows) {
      validateRow(row)
      if (this.rows.has(row.inputId)) throw new Error('Duplicate snapshot input')
      this.install(row)
      this.indexSlackMessage(this.rows.get(row.inputId)!)
    }
    this.foldSnapshotHistory(snap.seq, snap.receipts, snap.decisions)
  }
  private foldSnapshot(snap: Snapshot) {
    snapshotSchema.parse(snap)
    for (const value of snap.notices) {
      const notice = parseRecoveryRecord(value)
      if (this.notices.has(notice.deliveryId)) throw new Error('Duplicate snapshot notice')
      this.notices.set(notice.deliveryId, notice)
    }
    const referenced = new Set<string>()
    for (const value of snap.open) {
      const { notice, ...fields } = value as SnapshotOpenRow & { transfer?: unknown }
      if (fields.transfer !== undefined) throw new Error('Inline transfer in compact snapshot')
      const transfer = notice === undefined ? undefined : this.notices.get(notice)
      if (notice !== undefined && !transfer) throw new Error('Unknown snapshot notice')
      const row = (transfer ? { ...fields, transfer } : fields) as JournalRow
      validateRow(row)
      if (row.phase === 'closed') throw new Error('Closed row in open snapshot section')
      if (this.rows.has(row.inputId)) throw new Error('Duplicate snapshot input')
      this.rows.set(row.inputId, row as OpenInboundRecord)
      this.indexSlackMessage(row as OpenInboundRecord)
      if (transfer) referenced.add(transfer.deliveryId)
    }
    for (const row of snap.closed) {
      if (this.rows.has(row.inputId)) throw new Error('Duplicate snapshot input')
      if (row.noticeDeliveryId !== undefined) {
        const transfer = this.notices.get(row.noticeDeliveryId)
        if (
          !transfer ||
          principalDigest(transfer.principal) !== row.principalDigest ||
          !transfer.covers.some((c) => c.store === 'inbound' && c.id === row.inputId && c.generation <= row.generation)
        )
          throw new Error('Invalid closed notice coverage')
        referenced.add(transfer.deliveryId)
      }
      this.rows.set(row.inputId, row)
      this.indexSlackMessage(row)
    }
    if (referenced.size !== this.notices.size) throw new Error('Unreferenced snapshot notice')
    this.foldSnapshotHistory(snap.seq, snap.receipts, snap.decisions)
  }
  private foldSnapshotHistory(seq: number, receipts: DecisionReceipt[], decisions: Decision[]) {
    const sequences = new Set<number>()
    const transitions = new Set<string>()
    for (const receipt of receipts) {
      if (receipt.seq > seq || sequences.has(receipt.seq) || transitions.has(receipt.transitionId))
        throw new Error('Invalid snapshot receipt sequence')
      sequences.add(receipt.seq)
      transitions.add(receipt.transitionId)
      for (const ref of receipt.inboundRefs) {
        const row = this.rows.get(ref.inputId)
        if (!row || ref.generation < 1 || ref.generation > row.generation)
          throw new Error('Snapshot receipt has invalid generation')
      }
      if (this.retainsReceipt(receipt.transitionId, receipt.epoch)) this.receipts.set(receipt.transitionId, receipt)
    }
    for (const decision of decisions) {
      this.validateDecision(decision)
      if (
        decision.seq > seq ||
        sequences.has(decision.seq) ||
        transitions.has(decision.transitionId) ||
        !decision.backgroundChanges.length
      )
        throw new Error('Invalid pending snapshot decision')
      sequences.add(decision.seq)
      transitions.add(decision.transitionId)
      for (const change of decision.changes) {
        const current = this.rows.get(change.row.inputId)
        const expected = change.row.phase === 'closed' ? tombstone(change.row) : change.row
        if (canonical(current) !== canonical(expected))
          throw new Error('Snapshot pending decision conflicts with source')
      }
      this.decisions.set(decision.transitionId, decision)
    }
  }
  private foldDecision(decision: Decision) {
    this.validateDecision(decision)
    const pending = this.decisions.get(decision.transitionId)
    const receipt = this.receipts.get(decision.transitionId)
    if (receipt && receipt.decisionDigest !== digest(decision))
      throw new Error('Conflicting compacted transition identity')
    if (pending) {
      if (canonical(pending) !== canonical(decision)) throw new Error('Conflicting duplicate journal transition')
      return
    }
    if (receipt) return
    for (const change of decision.changes) this.validateChange(change, decision.type)
    for (const change of decision.changes) {
      this.install(change.row)
      // Only admission creates a row; later transitions keep its immutable identity.
      if (decision.type === 'admitted') this.indexSlackMessage(this.rows.get(change.row.inputId)!)
    }
    // A mixed decision stays in full until its background application is recorded.
    if (decision.backgroundChanges.length) this.decisions.set(decision.transitionId, decision)
    else this.remember(decision)
  }
  private foldApplied(receipt: Applied) {
    appliedSchema.parse(receipt)
    const decision = this.decisions.get(receipt.decisionId)
    if (
      !decision ||
      digest(decision) !== receipt.decisionDigest ||
      receipt.transitionId !== `applied:${receipt.decisionId}`
    )
      throw new Error('Invalid mixed application receipt')
    this.decisions.delete(receipt.decisionId)
    this.remember(decision)
  }
  /** Applied history is normalized at once: a full decision body never outlives its application. */
  private remember(decision: Decision) {
    if (this.minted.delete(decision.transitionId) || !this.retainsReceipt(decision.transitionId, decision.epoch)) return
    this.receipts.set(decision.transitionId, {
      transitionId: decision.transitionId,
      seq: decision.seq,
      epoch: decision.epoch,
      type: decision.type,
      decisionDigest: digest(decision),
      payloadDigest: digest([decision.type, decision.changes, decision.backgroundChanges]),
      ...(decision.requestDigest !== undefined ? { requestDigest: decision.requestDigest } : {}),
      ...this.result(
        decision.changes.map((c) => c.row),
        decision.backgroundChanges.map((c) => c.row),
      ),
    })
  }
  /**
   * A receipt only matters to a caller that can still present its transition ID. Admission IDs are
   * answered by the permanent row itself. A bare UUID is a runtime-local handle: once the epoch that
   * minted or received it has ended, no live caller holds it and no durable record re-issues one.
   * Derived and caller-named IDs (`prepare:`, `owned:`, `recovery:`, stop IDs, …) stay indefinitely.
   */
  private retainsReceipt(transitionId: string, epoch: string | undefined) {
    if (transitionId.startsWith('admit:')) return false
    return !(uuid.test(transitionId) && epoch !== this.epoch)
  }
  /** Keeps open rows in full and closed rows as tombstones; the frozen transfer is stored once per delivery. */
  private install(row: JournalRow) {
    let transfer = row.transfer
    if (transfer) {
      const frozen = this.notices.get(transfer.deliveryId)
      if (frozen && canonical(frozen) !== canonical(transfer)) throw new Error('Conflicting frozen transfer payload')
      if (frozen) transfer = frozen
      else this.notices.set(transfer.deliveryId, transfer)
    }
    this.rows.set(
      row.inputId,
      row.phase === 'closed' ? tombstone(row) : ((transfer ? { ...row, transfer } : row) as OpenInboundRecord),
    )
  }
  private frozenNotice(row: InboundRecord | undefined): RecoveryRecord | undefined {
    if (!row) return undefined
    if (row.phase !== 'closed') return row.transfer
    return row.noticeDeliveryId === undefined ? undefined : this.notices.get(row.noticeDeliveryId)
  }
  private indexSlackMessage(row: InboundRecord) {
    const key = row.phase === 'closed' ? row.messageKey : storedSlackMessageKey(row)
    if (!key) return
    const current = this.rows.get(this.slackMessages.get(key) ?? '')
    // Historical per-revision rows all stay; the earliest admission deterministically represents the message.
    if (
      current &&
      current.inputId !== row.inputId &&
      (current.acceptedAt < row.acceptedAt || (current.acceptedAt === row.acceptedAt && current.inputId < row.inputId))
    )
      return
    this.slackMessages.set(key, row.inputId)
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
    if (!repair) this.assertAvailable()
    // Appends run on the writer queue, never inside a compaction swap: only a real open handle is written.
    const fd = this.fd
    if (!fd) throw new Error('Journal append has no open handle')
    try {
      const start = performance.now()
      const text = `${JSON.stringify(line)}\n`
      await fd.writeFile(text)
      await this.options.onDurability?.('append-written', line)
      await fd.sync()
      this.options.onSync?.(performance.now() - start)
      await this.options.onDurability?.('append-synced', line)
      this.fold(line, Buffer.byteLength(text))
    } catch (error) {
      this.fail(error)
      throw error
    }
    this.scheduleCompaction()
  }
  private async applyBackground(decision: Decision, repair = false) {
    if (!decision.backgroundChanges.length || !this.decisions.has(decision.transitionId)) return
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
    requestedTransitionId?: string,
    requestDigest?: string,
  ) {
    this.assertAvailable()
    const transitionId = requestedTransitionId ?? randomUUID()
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
    if (backgroundChanges.length) {
      // A known background freeze rejects a mixed decision before it is durable; once written, only
      // journal repair may apply it, so a write the store cannot follow would poison every admission.
      if (!this.background) throw new Error('Mixed decision requires background store')
      this.background.assertAvailable()
    }
    if (requestedTransitionId === undefined) this.minted.add(transitionId)
    try {
      await this.append(decision)
    } catch (error) {
      this.minted.delete(transitionId)
      throw error
    }
    try {
      await this.applyBackground(decision)
    } catch (error) {
      this.fail(error)
      throw error
    }
    return decision
  }
  /**
   * The one duplicate authority for admission and pre-routing lookup. A Slack message resolves to its
   * representative row whatever revision or thread shape arrives; only identities outside the message
   * index (other adapters, receipt-only, undecodable rows) use exact identity. A duplicate returns the
   * existing row untouched (its debt never follows a new routing thread), and a different author is a
   * conflict, never a fresh slot — closed or open.
   */
  private existingAdmission(input: InboundAdmission) {
    const root = dirname(dirname(this.path))
    const identity = canonical([
      root,
      input.accountIdentity,
      channelKeyId(input.target),
      input.messageId ?? input.receiptId,
      input.eventKind,
      input.revision,
    ])
    const inputId = digest(['inbound', identity])
    const message = slackMessageKey({ root, ...input })
    const representative = message ? this.slackMessages.get(message) : undefined
    const existing = this.rows.get(representative ?? inputId)
    if (
      existing &&
      (existing.phase === 'closed' ? existing.principalDigest : principalDigest(existing.principal)) !==
        principalDigest(input.principal)
    )
      throw new Error('Conflicting duplicate admission principal')
    return { identity, inputId, existing }
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
      const { identity, inputId, existing } = this.existingAdmission(input)
      if (existing)
        return {
          kind: 'duplicate' as const,
          inputId: existing.inputId,
          outcome: existing.phase === 'closed' ? copy(existing.outcome) : undefined,
        }
      const row: OpenInboundRecord = {
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
  get(inputId: string): InboundRecord | undefined {
    this.assertAvailable()
    const row = this.rows.get(inputId)
    return row ? copy(row) : undefined
  }
  list(): InboundRecord[] {
    this.assertAvailable()
    return [...this.rows.values()].map(copy)
  }
  resolve(ids: readonly string[]): InboundRef[] {
    this.assertAvailable()
    return ids.map((inputId) => {
      const row = this.rows.get(inputId)
      if (!row) throw new Error('Unknown inbound ID')
      return { inputId, generation: row.generation }
    })
  }
  private coverage(refs: InboundRef[], target: ChannelKey): OpenInboundRecord[] {
    const seen = new Set<string>()
    return refs.map((ref) => {
      const row = this.rows.get(ref.inputId)
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
  private async backgroundCoverage(refs: BackgroundObligationRef[], target: ChannelKey, inbound: OpenInboundRecord[]) {
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
  private result(
    rows: ReadonlyArray<{ inputId: string; generation: number }>,
    background: ReadonlyArray<{ obligationId: string; generation: number }>,
  ) {
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
        const row = this.rows.get(ref.inputId)
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
      const first = this.rows.get(refs[0]?.inputId ?? '')
      if (first?.phase === 'closed') throw new Error('Invalid inbound coverage')
      const destination =
        target ?? first?.target ?? (brefs[0] ? (await this.background?.get(brefs[0].obligationId))?.target : undefined)
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
  /**
   * Freezes a notice over owed coverage. `cause` picks the template: `restart` (the default) is the
   * RFC boot-recovery notice with its original request digest; `live-turn-ended` is a same-process
   * turn that ended unanswered and is frozen as its own distinct record.
   */
  prepareNotice(
    refs: InboundRef[],
    target: ChannelKey,
    brefs: BackgroundObligationRef[] = [],
    ownerSessionId?: string,
    cause: RecoveryNoticeCause = 'restart',
  ) {
    return this.serialized(async () => {
      this.assertAvailable()
      // Restart keeps the pre-cause request digest so earlier preparation receipts still match.
      const requestDigest = digest(
        cause === 'restart'
          ? ['notice-prepared', refs, target, brefs, ownerSessionId]
          : ['notice-prepared', refs, target, brefs, ownerSessionId, cause],
      )
      const transitionId = `prepare:${digest(['inbound-transfer', refs, brefs])}`
      const prior = this.decisions.get(transitionId)
      const receipt = this.receipts.get(transitionId)
      if (prior || receipt) {
        if ((prior ?? receipt)!.requestDigest !== requestDigest)
          throw new Error('Conflicting duplicate notice preparation')
        const transfer =
          prior?.changes[0]?.row.transfer ?? this.frozenNotice(this.rows.get(receipt!.inboundRefs[0]!.inputId))
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
      // A covered child must share the notice's stop authority, not only its destination.
      const backgroundParents = bg.map((row) => row.claim?.ownerSessionId ?? ownerSessionId ?? row.parentSessionId)
      if (new Set([...parents, ...backgroundParents]).size !== 1)
        throw new Error('Notice coverage must be partitioned by owner')
      const transfer = createRecoveryNotice({
        target,
        accountIdentity: rows[0]!.accountIdentity,
        principal: rows[0]!.principal,
        transferId,
        recoveryGeneration: transferId,
        sourceParentSessionId: parents[0],
        cause,
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
      const frozen = this.frozenNotice(this.rows.get(cover.id))
      if (!frozen || recoveryPayload(frozen) !== recoveryPayload(transfer))
        throw new Error('Prepared frozen payload mismatch')
    }
    const imported = await outbox.import(transfer)
    await this.serialized(async () => {
      this.assertAvailable()
      const rows = transfer.covers.filter((c) => c.store === 'inbound').map((c) => this.rows.get(c.id))
      if (rows.some((row) => this.frozenNotice(row)?.deliveryId !== transfer.deliveryId))
        throw new Error('Prepared transfer mismatch')
      for (const c of transfer.covers.filter((c) => c.store === 'background')) {
        const row = await this.background?.ownNotice(c.id, c.generation, transfer.deliveryId)
        if (!row && imported.state !== 'delivered' && imported.state !== 'suppressed')
          throw new Error('Background notice ownership conflict')
      }
      const pending = rows.filter((row): row is OpenInboundRecord => !!row && row.phase === 'notice-prepared')
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
  /** Pre-routing duplicate check; the same resolver and author fence as admission. */
  lookupAdmission(input: InboundAdmission): InboundRecord | undefined {
    this.assertAvailable()
    const { existing } = this.existingAdmission(input)
    return existing ? copy(existing) : undefined
  }
  /**
   * Boot transfer of inbound authority no live turn can still answer. Issued transfers re-import
   * unchanged first, so a late matching row forms its own notice instead of mutating one. Remaining
   * old-epoch rows become one mixed notice per recovery partition, joined by compatible old-epoch
   * children; unmatched children keep the background store's singleton fallback.
   */
  async importOldEpoch(outbox: RecoveryOutbox) {
    await this.initialize()
    this.assertAvailable()
    const background = this.background
    const issued = new Map<string, { target: ChannelKey; inputIds: string[] }>()
    for (const row of this.rows.values()) {
      if (row.phase === 'closed' || !row.transfer) continue
      const transfer = issued.get(row.transfer.deliveryId)
      if (transfer) transfer.inputIds.push(row.inputId)
      else issued.set(row.transfer.deliveryId, { target: row.target, inputIds: [row.inputId] })
    }
    for (const { target, inputIds } of issued.values()) {
      const reimport = async () => {
        this.assertAvailable()
        for (const inputId of inputIds) {
          const row = this.rows.get(inputId)
          if (row?.phase === 'closed' || !row?.transfer) continue
          await this.importPrepared(outbox, row.transfer)
          return
        }
      }
      await (background ? background.withTargetLane(target, reimport) : reimport())
    }
    const owedInbound = (row: InboundRecord | undefined): row is OpenInboundRecord =>
      !!row && row.phase !== 'closed' && !row.transfer && row.epoch !== this.epoch
    const owedBackground = (row: BackgroundObligation | undefined): row is BackgroundObligation =>
      !!row && row.phase !== 'closed' && !row.transfer && row.epoch !== this.epoch
    const partitions = new Map<string, { target: ChannelKey; inputIds: string[]; backgroundIds: string[] }>()
    for (const row of this.rows.values()) {
      if (!owedInbound(row)) continue
      const key = inboundPartition(row)
      const partition = partitions.get(key) ?? { target: row.target, inputIds: [], backgroundIds: [] }
      partitions.set(key, partition)
      partition.inputIds.push(row.inputId)
    }
    if (background && partitions.size) {
      for (const row of await background.list())
        if (owedBackground(row)) partitions.get(backgroundPartition(row))?.backgroundIds.push(row.obligationId)
    }
    for (const [key, partition] of partitions) {
      const transfer = async () => {
        this.assertAvailable()
        // The boot snapshot is not authority: cover only rows still open in this exact partition.
        const rows = partition.inputIds
          .map((id) => this.rows.get(id))
          .filter((row): row is OpenInboundRecord => owedInbound(row) && inboundPartition(row) === key)
        if (!rows.length) return
        const children: BackgroundObligation[] = []
        for (const id of partition.backgroundIds) {
          const row = await background!.get(id)
          if (owedBackground(row) && backgroundPartition(row) === key) children.push(row)
        }
        const prepared = await this.prepareNotice(
          rows
            .sort((a, b) => a.acceptedAt - b.acceptedAt || a.inputId.localeCompare(b.inputId))
            .map((row) => ({ inputId: row.inputId, generation: row.generation })),
          partition.target,
          children
            .sort((a, b) => a.acceptedAt - b.acceptedAt || a.obligationId.localeCompare(b.obligationId))
            .map((row) => ({ obligationId: row.obligationId, generation: row.generation })),
        )
        await this.importPrepared(outbox, prepared)
      }
      await (background ? background.withTargetLane(partition.target, transfer) : transfer())
    }
  }
  async validateNotice(record: RecoveryRecord): Promise<'open' | 'resolved'> {
    this.assertAvailable()
    let open = false
    parseRecoveryRecord(record)
    for (const cover of record.covers.filter((c) => c.store === 'inbound')) {
      const row = this.rows.get(cover.id)
      const frozen = this.frozenNotice(row)
      if (!row || !frozen || recoveryPayload(frozen) !== recoveryPayload(record))
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
    this.assertAvailable()
    parseRecoveryRecord(record)
    const refs: InboundRef[] = []
    const bg: BackgroundObligationRef[] = []
    for (const c of record.covers) {
      if (c.store === 'inbound') {
        const row = this.rows.get(c.id)
        const frozen = this.frozenNotice(row)
        if (!row || !frozen || recoveryPayload(frozen) !== recoveryPayload(record))
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
  /**
   * Starts growth-driven compaction once boot recovery has finished. A compaction is queued on the
   * writer's own queue when the bytes appended since the last snapshot reach the larger of a fixed
   * floor and that snapshot's size, so rewrite work stays proportional to new growth (tombstones kept
   * forever never cause repeated rewrites) and a journal that is not growing is never rewritten.
   * Checked here and after each append; `close()` stops it.
   */
  startMaintenance() {
    if (this.closing || this.initializationCancelled) return
    this.maintaining = true
    this.scheduleCompaction()
  }
  private scheduleCompaction() {
    if (
      !this.maintaining ||
      this.compactionQueued ||
      this.growthBytes < Math.max(this.options.compactionFloorBytes ?? COMPACTION_FLOOR_BYTES, this.snapshotBytes)
    )
      return
    this.compactionQueued = true
    void this.serialized(async () => {
      this.compactionQueued = false
      // Shutdown or a freeze after scheduling leaves the growth for the next boot to compact.
      if (!this.maintaining || this.frozen !== undefined || !this.fd) return
      await this.compactInternal()
    }).catch(() => {
      // compactInternal froze the journal and reported the failure through fail().
    })
  }
  compact() {
    return this.serialized(() => this.compactInternal())
  }
  /**
   * Rewrites the journal as one compact snapshot of the already-normalized state: temp sync, close the
   * old handle, replace, directory sync, reopen. Any failure freezes the writer; it never appends
   * through a handle to an unlinked file.
   */
  private async compactInternal() {
    this.assertAvailable()
    // The writer stall starts here, before the snapshot is materialized and written.
    await this.options.onDurability?.('compaction-started')
    const snapshot = this.snapshot()
    const text = `${JSON.stringify(snapshot)}\n`
    const temp = `${this.path}.${randomUUID()}.tmp`
    let ownsTemp = false
    try {
      const fd = await open(temp, 'wx', 0o600)
      ownsTemp = true
      try {
        await fd.writeFile(text)
        await fd.sync()
      } finally {
        await fd.close()
      }
      await this.options.onDurability?.('temp-synced', snapshot)
      const previous = this.fd!
      this.swapping = true
      this.fd = undefined
      await previous.close()
      await this.options.onDurability?.('handle-closed', snapshot)
      await rename(temp, this.path)
      ownsTemp = false
      await this.options.onDurability?.('replaced', snapshot)
      await syncDirectory(dirname(this.path))
      await this.options.onDurability?.('directory-synced', snapshot)
      this.fd = await open(this.path, 'a+', 0o600)
      this.swapping = false
      this.sequence = snapshot.seq
      this.snapshotBytes = Buffer.byteLength(text)
      this.growthBytes = 0
      await this.options.onDurability?.('reopened', snapshot)
    } catch (error) {
      // A failed swap freezes before the swap flag clears, so no instant reports a healthy journal.
      this.fail(error)
      this.swapping = false
      // Only this compaction's own never-installed temp file is removed.
      if (ownsTemp) await unlink(temp).catch(() => {})
      throw error
    }
  }
  private snapshot(): Snapshot {
    const open: SnapshotOpenRow[] = []
    const closed: ClosedInboundRecord[] = []
    for (const row of this.rows.values()) {
      if (row.phase === 'closed') {
        closed.push(row)
        continue
      }
      const { transfer, ...fields } = row
      open.push(transfer ? { ...fields, notice: transfer.deliveryId } : fields)
    }
    return {
      schemaVersion: 2,
      seq: Math.max(1, this.sequence),
      type: 'snapshot',
      notices: [...this.notices.values()],
      open,
      closed,
      decisions: [...this.decisions.values()],
      receipts: [...this.receipts.values()],
    }
  }
  async flush() {
    await this.queue
  }
  close() {
    this.cancelInitialization()
    // A queued compaction that has not started is skipped; one in progress finishes before the handle closes.
    this.maintaining = false
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
