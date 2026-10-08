import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { z } from 'zod'

import { parseRecoveryRecord, recoveryPayload, recoveryPayloadDigest } from './continuity-types'
import type { RecoveryFailure, RecoveryLease, RecoveryReceipt, RecoveryRecord } from './continuity-types'

const operations = new Map<string, Promise<void>>()
const idPattern = /^[a-f0-9]{64}$/
export type RecoveryOutboxOptions = {
  epoch?: string
  now?: () => number
  onError?: (error: unknown) => void
  /** Fault-injection boundary; production callers leave this unset. */
  onDurability?: (
    phase: 'temp-synced' | 'replaced' | 'directory-synced' | 'retirement-synced' | 'retired',
    record: RecoveryRecord,
  ) => void | Promise<void>
}
/**
 * Immutable fence left when a terminal record leaves the active outbox. It keeps only the frozen
 * payload digest and terminal dispatch state, so a later import of the same frozen transfer
 * resolves to the finished delivery instead of creating a new send, without retaining the payload.
 */
export type RecoveryRetirement = {
  schemaVersion: 1
  deliveryId: string
  payloadDigest: string
  retiredAt: number
  dispatch: Pick<
    RecoveryRecord,
    'generation' | 'attempts' | 'lease' | 'receipt' | 'failure' | 'suppression' | 'boundAccountIdentity'
  > & { state: 'delivered' | 'suppressed' }
}
const retirementSchema = z
  .object({
    schemaVersion: z.literal(1),
    deliveryId: z.string().regex(idPattern),
    payloadDigest: z.string().regex(idPattern),
    retiredAt: z.number().finite().nonnegative(),
    // Nested dispatch fields are validated in full when a fence is joined back to its payload.
    dispatch: z
      .object({
        state: z.enum(['delivered', 'suppressed']),
        generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        lease: z.unknown().optional(),
        receipt: z.unknown().optional(),
        failure: z.unknown().optional(),
        suppression: z.unknown().optional(),
        boundAccountIdentity: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict()

async function syncDirectory(path: string): Promise<void> {
  // POSIX process-death durability. Windows lacks directory-sync power-loss guarantees.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class RecoveryOutbox {
  readonly epoch: string
  private readonly directory: string
  private readonly retiredDirectory: string
  private readonly now: () => number
  private readonly options: RecoveryOutboxOptions
  private readonly pending = new Set<Promise<unknown>>()
  private readonly importListeners = new Set<(record: RecoveryRecord) => void>()

  constructor(agentDir: string, options: RecoveryOutboxOptions = {}) {
    this.directory = resolve(agentDir, 'channels', 'recovery-outbox')
    this.retiredDirectory = join(this.directory, 'retired')
    this.epoch = options.epoch ?? randomUUID()
    this.now = options.now ?? Date.now
    this.options = options
  }

  private path(id: string): string {
    if (!idPattern.test(id)) throw new Error('Invalid recovery delivery ID')
    return join(this.directory, `${id}.json`)
  }

  private async read(id: string): Promise<RecoveryRecord | undefined> {
    let bytes: string
    try {
      bytes = await readFile(this.path(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const record = parseRecoveryRecord(JSON.parse(bytes))
    if (record.deliveryId !== id) throw new Error(`Recovery filename identity mismatch: ${id}`)
    return record
  }

  private async readRetirement(id: string): Promise<RecoveryRetirement | undefined> {
    let bytes: string
    try {
      bytes = await readFile(join(this.retiredDirectory, basename(this.path(id))), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const fence = retirementSchema.parse(JSON.parse(bytes)) as RecoveryRetirement
    if (fence.deliveryId !== id) throw new Error(`Recovery retirement identity mismatch: ${id}`)
    return fence
  }

  private async publish(record: RecoveryRecord, exclusive = false): Promise<boolean> {
    parseRecoveryRecord(record)
    await mkdir(this.directory, { recursive: true })
    // Persist newly created directory entries all the way through channels to agentDir.
    await syncDirectory(dirname(dirname(this.directory)))
    await syncDirectory(dirname(this.directory))
    const path = this.path(record.deliveryId)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.options.onDurability?.('temp-synced', record)
      if (exclusive) {
        try {
          await link(temp, path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
          throw error
        }
      } else await rename(temp, path)
      await this.options.onDurability?.('replaced', record)
      await syncDirectory(this.directory)
      await this.options.onDurability?.('directory-synced', record)
      return true
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  private serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const path = this.path(id)
    const result = (operations.get(path) ?? Promise.resolve()).then(action)
    const settled = result.then(
      () => {},
      () => {},
    )
    operations.set(path, settled)
    this.pending.add(result)
    void settled.then(() => {
      this.pending.delete(result)
      if (operations.get(path) === settled) operations.delete(path)
    })
    return result
  }

  import(input: RecoveryRecord): Promise<RecoveryRecord> {
    const record = parseRecoveryRecord(input)
    return this.serialized(record.deliveryId, async () => {
      const existing = await this.read(record.deliveryId)
      if (existing) {
        if (recoveryPayload(existing) !== recoveryPayload(record))
          throw new Error(`Conflicting recovery import: ${record.deliveryId}`)
        // An import acknowledges durability even after a previous directory-sync failure.
        await syncDirectory(this.directory)
        return existing
      }
      const retired = await this.readRetirement(record.deliveryId)
      if (retired) {
        // A finished delivery stays finished: re-importing its frozen transfer never queues another send.
        if (retired.payloadDigest !== recoveryPayloadDigest(record))
          throw new Error(`Conflicting recovery import: ${record.deliveryId}`)
        const {
          state: _state,
          generation: _generation,
          attempts: _attempts,
          lease: _lease,
          receipt: _receipt,
          failure: _failure,
          suppression: _suppression,
          nextAttemptAt: _next,
          boundAccountIdentity: _bound,
          ...payload
        } = record
        return parseRecoveryRecord({ ...payload, ...retired.dispatch })
      }
      if (
        record.state !== 'pending' ||
        record.generation !== 1 ||
        record.attempts !== 0 ||
        record.failure ||
        record.nextAttemptAt !== undefined ||
        record.boundAccountIdentity !== undefined
      )
        throw new Error('Recovery import must be an initial pending transfer')
      if (!(await this.publish(record, true))) {
        const winner = await this.read(record.deliveryId)
        if (!winner || recoveryPayload(winner) !== recoveryPayload(record))
          throw new Error(`Conflicting recovery import: ${record.deliveryId}`)
        await syncDirectory(this.directory)
        return winner
      }
      for (const listener of this.importListeners) listener(record)
      return record
    })
  }

  /** Called after each new record becomes durable; listeners must not throw. */
  subscribe(listener: (record: RecoveryRecord) => void): () => void {
    this.importListeners.add(listener)
    return () => this.importListeners.delete(listener)
  }

  /**
   * Moves a terminal record out of the active outbox once its source has acknowledged it and
   * validates as resolved. The fence is durable before the active file is removed, so every crash
   * point leaves the record, the fence, or both (the next retirement converges them).
   */
  retire(id: string, expectedGeneration: number): Promise<boolean> {
    return this.serialized(id, async () => {
      const record = await this.read(id)
      if (!record) return (await this.readRetirement(id)) !== undefined
      if (record.generation !== expectedGeneration || (record.state !== 'delivered' && record.state !== 'suppressed'))
        return false
      const payloadDigest = recoveryPayloadDigest(record)
      const prior = await this.readRetirement(id)
      if (prior && prior.payloadDigest !== payloadDigest) throw new Error(`Conflicting recovery retirement: ${id}`)
      if (!prior) {
        const fence: RecoveryRetirement = {
          schemaVersion: 1,
          deliveryId: id,
          payloadDigest,
          retiredAt: this.now(),
          dispatch: {
            state: record.state === 'delivered' ? 'delivered' : 'suppressed',
            generation: record.generation,
            attempts: record.attempts,
            ...(record.lease ? { lease: record.lease } : {}),
            ...(record.receipt ? { receipt: record.receipt } : {}),
            ...(record.failure ? { failure: record.failure } : {}),
            ...(record.suppression ? { suppression: record.suppression } : {}),
            ...(record.boundAccountIdentity !== undefined ? { boundAccountIdentity: record.boundAccountIdentity } : {}),
          },
        }
        await mkdir(this.retiredDirectory, { recursive: true })
        await syncDirectory(this.directory)
        const path = join(this.retiredDirectory, `${id}.json`)
        const temp = `${path}.${randomUUID()}.tmp`
        try {
          const handle = await open(temp, 'wx', 0o600)
          try {
            await handle.writeFile(`${JSON.stringify(fence)}\n`, 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temp, path)
          await syncDirectory(this.retiredDirectory)
        } finally {
          await unlink(temp).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
      }
      await this.options.onDurability?.('retirement-synced', record)
      await unlink(this.path(id))
      await syncDirectory(this.directory)
      await this.options.onDurability?.('retired', record)
      return true
    })
  }

  retired(id: string): Promise<RecoveryRetirement | undefined> {
    return this.serialized(id, () => this.readRetirement(id))
  }

  async listRetired(): Promise<RecoveryRetirement[]> {
    let names: string[]
    try {
      names = await readdir(this.retiredDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const fences: RecoveryRetirement[] = []
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const fence = await this.retired(name.slice(0, -5))
        if (fence) fences.push(fence)
      } catch (error) {
        if (this.options.onError) this.options.onError(error)
        else console.error('Recovery retirement fence unavailable:', name, error)
      }
    }
    return fences
  }

  get(id: string): Promise<RecoveryRecord | undefined> {
    return this.serialized(id, () => this.read(id))
  }

  async list(): Promise<RecoveryRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: RecoveryRecord[] = []
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const record = await this.get(name.slice(0, -5))
        if (record) records.push(record)
      } catch (error) {
        if (this.options.onError) this.options.onError(error)
        else console.error('Recovery outbox record unavailable:', name, error)
      }
    }
    return records
  }

  lease(id: string, expectedGeneration: number): Promise<RecoveryLease | undefined> {
    return this.serialized(id, async () => {
      const record = await this.read(id)
      if (
        !record ||
        record.generation !== expectedGeneration ||
        record.state === 'delivered' ||
        record.state === 'suppressed'
      )
        return undefined
      if (record.state === 'leased' && record.lease?.epoch === this.epoch) return undefined
      if (record.nextAttemptAt !== undefined && record.nextAttemptAt > this.now()) return undefined
      const lease = {
        epoch: this.epoch,
        generation: record.generation + 1,
        attemptId: randomUUID(),
        acquiredAt: this.now(),
      }
      const { failure: _failure, nextAttemptAt: _next, ...rest } = record
      await this.publish({
        ...rest,
        state: 'leased',
        generation: lease.generation,
        lease,
        attempts: record.attempts + 1,
      })
      return lease
    })
  }

  repairLease(id: string, lease: RecoveryLease): Promise<boolean> {
    return this.serialized(id, async () => {
      const record = await this.read(id)
      if (!record || record.state !== 'leased' || !this.owns(record, lease)) return false
      // Visible bytes may follow a failed directory sync; republish before reuse.
      await this.publish(record)
      return true
    })
  }

  delivered(id: string, lease: RecoveryLease, receipt: RecoveryReceipt): Promise<boolean> {
    return this.serialized(id, async () => {
      const record = await this.read(id)
      if (!record || !this.owns(record, lease)) return false
      if (record.receipt)
        return (
          record.receipt.confirmedAt === receipt.confirmedAt &&
          record.receipt.messageId === receipt.messageId &&
          JSON.stringify(record.receipt.messageIds) === JSON.stringify(receipt.messageIds)
        )
      if (record.state !== 'leased' && record.state !== 'suppressed') return false
      await this.publish({ ...record, state: record.state === 'suppressed' ? 'suppressed' : 'delivered', receipt })
      return true
    })
  }

  bindAccount(id: string, lease: RecoveryLease, identity: string): Promise<boolean> {
    return this.serialized(id, async () => {
      const record = await this.read(id)
      if (!record || record.state !== 'leased' || !this.owns(record, lease)) return false
      if (record.accountIdentity !== 'unbound-legacy') return record.accountIdentity === identity
      if (record.boundAccountIdentity !== undefined) return record.boundAccountIdentity === identity
      await this.publish({ ...record, boundAccountIdentity: identity })
      return true
    })
  }

  fail(id: string, lease: RecoveryLease, failure: RecoveryFailure): Promise<boolean> {
    return this.serialized(id, async () => {
      const record = await this.read(id)
      if (!record || record.state !== 'leased' || !this.owns(record, lease)) return false
      const blocked =
        failure.kind === 'permission' ||
        failure.kind === 'identity' ||
        failure.kind === 'target' ||
        failure.kind === 'configuration'
      const { lease: _lease, ...rest } = record
      const delay = Math.max(
        failure.retryAfter ?? 0,
        Math.min(60_000, 1000 * 2 ** Math.min(record.attempts - 1, 6)) * (0.8 + Math.random() * 0.4),
      )
      await this.publish({
        ...rest,
        state: blocked ? 'blocked' : 'pending',
        failure,
        ...(!blocked ? { nextAttemptAt: this.now() + delay } : {}),
      })
      return true
    })
  }

  suppress(id: string, reason: string, decisionId: string): Promise<boolean> {
    return this.serialized(id, async () => {
      const record = await this.read(id)
      if (!record || record.state === 'delivered') return false
      if (record.state === 'suppressed')
        return record.suppression?.reason === reason && record.suppression.decisionId === decisionId
      const { nextAttemptAt: _next, ...rest } = record
      await this.publish({
        ...rest,
        generation: record.generation + 1,
        state: 'suppressed',
        suppression: { reason, decisionId },
      })
      return true
    })
  }

  private owns(record: RecoveryRecord, lease: RecoveryLease): boolean {
    return (
      lease.epoch === this.epoch &&
      record.lease?.epoch === lease.epoch &&
      record.lease.generation === lease.generation &&
      record.lease.attemptId === lease.attemptId &&
      record.lease.acquiredAt === lease.acquiredAt
    )
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending)
  }
}
