import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { parseRecoveryRecord, recoveryPayload } from './continuity-types'
import type { RecoveryFailure, RecoveryLease, RecoveryReceipt, RecoveryRecord } from './continuity-types'

const operations = new Map<string, Promise<void>>()
const idPattern = /^[a-f0-9]{64}$/
export type RecoveryOutboxOptions = {
  epoch?: string
  now?: () => number
  onError?: (error: unknown) => void
  /** Fault-injection boundary; production callers leave this unset. */
  onDurability?: (
    phase: 'temp-synced' | 'replaced' | 'directory-synced',
    record: RecoveryRecord,
  ) => void | Promise<void>
}

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
  private readonly now: () => number
  private readonly options: RecoveryOutboxOptions
  private readonly pending = new Set<Promise<unknown>>()

  constructor(agentDir: string, options: RecoveryOutboxOptions = {}) {
    this.directory = resolve(agentDir, 'channels', 'recovery-outbox')
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
      return record
    })
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
