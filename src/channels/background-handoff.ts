import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { validateRecoveryRecord, type RecoveryRecord } from './continuity-types'
import { createRecoveryNotice } from './recovery-notice'
import type { ChannelKey, ReactionRef } from './types'
import { channelKeyId } from './types'

export type BackgroundInventoryRecord = {
  schemaVersion: 1
  generationId: string
  processEpoch: string
  parentSessionId: string
  parentSessionFile?: string
  key: ChannelKey
  triggeringAuthorId?: string
  parentChat?: string
  accountIdentity?: string
  recoveryTransfer?: { phase: 'notice-prepared' | 'notice-owned'; record: RecoveryRecord }
  tasks: {
    taskId: string
    subagentName: string
    startedAt: number
    accountIdentity?: string
    triggerReactionRef?: ReactionRef
  }[]
}

export type BackgroundRecoveryIdentity = {
  accountIdentity: string
  accountIdentityConflict?: string[]
}

/** Resolve admitted task evidence; legacy group identity applies only to absent row fields. */
export function resolveBackgroundRecoveryIdentity(record: BackgroundInventoryRecord): BackgroundRecoveryIdentity {
  const identities = [
    ...new Set(
      record.tasks
        .map((task) => task.accountIdentity ?? record.accountIdentity ?? 'unbound-legacy')
        .filter((identity) => identity !== 'unbound-legacy'),
    ),
  ].sort()
  if (identities.length === 1) return { accountIdentity: identities[0]! }
  return {
    accountIdentity: 'unbound-legacy',
    ...(identities.length > 1 ? { accountIdentityConflict: identities } : {}),
  }
}

/** Frozen PR1 identity; upgrading the source must not create another delivery. */
export function createLegacyRecoveryNotice(source: BackgroundInventoryRecord): RecoveryRecord {
  const identity = JSON.stringify([channelKeyId(source.key), source.parentSessionId, source.generationId])
  return createRecoveryNotice({
    target: source.key,
    ...resolveBackgroundRecoveryIdentity(source),
    principal: {
      kind: 'channel',
      adapter: source.key.adapter,
      workspace: source.key.workspace,
      chat: source.key.chat,
      ...(source.parentChat !== undefined ? { parentChat: source.parentChat } : {}),
      ...(source.triggeringAuthorId ? { lastInboundAuthorId: source.triggeringAuthorId } : {}),
    },
    covers: source.tasks.map((task) => ({
      store: 'inventory' as const,
      id: createHash('sha256').update(`inventory:${identity}:${task.taskId}`).digest('hex'),
      generation: 1,
    })),
    recoveryGeneration: `${source.generationId}:${source.parentSessionId}`,
    transferId: createHash('sha256').update(`inventory-transfer:${identity}`).digest('hex'),
    sourceParentSessionId: source.parentSessionId,
  })
}

function transferMatchesSource(source: BackgroundInventoryRecord, transfer: RecoveryRecord): boolean {
  const resolved = resolveBackgroundRecoveryIdentity(source)
  const identity = JSON.stringify([channelKeyId(source.key), source.parentSessionId, source.generationId])
  const expectedIds = source.tasks
    .map((task) => createHash('sha256').update(`inventory:${identity}:${task.taskId}`).digest('hex'))
    .sort()
  return (
    channelKeyId(transfer.target) === channelKeyId(source.key) &&
    transfer.sourceParentSessionId === source.parentSessionId &&
    transfer.principal.kind === 'channel' &&
    transfer.principal.adapter === source.key.adapter &&
    transfer.principal.workspace === source.key.workspace &&
    transfer.principal.chat === source.key.chat &&
    transfer.principal.parentChat === source.parentChat &&
    transfer.principal.lastInboundAuthorId === (source.triggeringAuthorId || undefined) &&
    transfer.accountIdentity === resolved.accountIdentity &&
    JSON.stringify(transfer.accountIdentityConflict) === JSON.stringify(resolved.accountIdentityConflict) &&
    transfer.recoveryGeneration === `${source.generationId}:${source.parentSessionId}` &&
    transfer.transferId === createHash('sha256').update(`inventory-transfer:${identity}`).digest('hex') &&
    transfer.covers.every((coverage) => coverage.store === 'inventory' && coverage.generation === 1) &&
    JSON.stringify(transfer.covers.map((coverage) => coverage.id).sort()) === JSON.stringify(expectedIds)
  )
}

export type ClaimedBackgroundInventory = { record: BackgroundInventoryRecord; claimPath: string }

const hashPattern = '[a-f0-9]{64}'
const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const pendingPattern = new RegExp(`^${hashPattern}\\.json$`)
const claimedPattern = new RegExp(`^(${hashPattern})\\.${uuidPattern}\\.json$`)
const tempPattern = new RegExp(`^${hashPattern}\\.json\\.${uuidPattern}\\.tmp$`)
const generationPattern = new RegExp(`^${uuidPattern}$`)
// Single active runtime writer; boot readers can compete for rename ownership.
// Sharing queues also prevents two collaborators in that runtime taking stale snapshots.
const operations = new Map<string, Promise<void>>()

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function serialized<T>(path: string, action: () => Promise<T>): Promise<T> {
  const result = (operations.get(path) ?? Promise.resolve()).then(action)
  const settled = result.then(
    () => {},
    () => {},
  )
  operations.set(path, settled)
  try {
    return await result
  } finally {
    if (operations.get(path) === settled) operations.delete(path)
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Container runtime is POSIX. Windows dev does not support directory fsync.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path)
    await syncDirectory(dirname(path))
  } catch (error) {
    if (!missing(error)) throw error
  }
}

function recordHash(key: ChannelKey, parentSessionId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([channelKeyId(key), parentSessionId]))
    .digest('hex')
}

function validSessionFile(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    file.endsWith('.jsonl') &&
    file !== '.jsonl' &&
    basename(file) === file &&
    !file.includes('\\') &&
    !file.includes(String.fromCharCode(0)) &&
    file !== '..'
  )
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validKey(value: unknown): value is ChannelKey {
  return (
    object(value) &&
    typeof value.adapter === 'string' &&
    value.adapter.length > 0 &&
    typeof value.workspace === 'string' &&
    typeof value.chat === 'string' &&
    (value.thread === null || typeof value.thread === 'string')
  )
}

function validReaction(value: unknown): boolean {
  return value === undefined || (object(value) && typeof value.adapter === 'string' && typeof value.value === 'string')
}

class InvalidBackgroundInventory extends Error {}

async function readRecord(path: string, hash: string): Promise<BackgroundInventoryRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  let record: unknown
  try {
    record = JSON.parse(raw)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new InvalidBackgroundInventory(`Malformed background inventory: ${path}`, { cause: error })
  }
  if (
    !object(record) ||
    record.schemaVersion !== 1 ||
    !validKey(record.key) ||
    typeof record.parentSessionId !== 'string' ||
    !record.parentSessionId ||
    (record.parentSessionFile !== undefined && !validSessionFile(record.parentSessionFile)) ||
    typeof record.generationId !== 'string' ||
    !generationPattern.test(record.generationId) ||
    typeof record.processEpoch !== 'string' ||
    !record.processEpoch ||
    (record.triggeringAuthorId !== undefined && typeof record.triggeringAuthorId !== 'string') ||
    (record.parentChat !== undefined && (typeof record.parentChat !== 'string' || !record.parentChat)) ||
    (record.accountIdentity !== undefined && (typeof record.accountIdentity !== 'string' || !record.accountIdentity)) ||
    (record.recoveryTransfer !== undefined &&
      (!object(record.recoveryTransfer) ||
        !['notice-prepared', 'notice-owned'].includes(String(record.recoveryTransfer.phase)) ||
        !validateRecoveryRecord(record.recoveryTransfer.record))) ||
    !Array.isArray(record.tasks) ||
    record.tasks.length === 0 ||
    !record.tasks.every(
      (task) =>
        object(task) &&
        typeof task.taskId === 'string' &&
        task.taskId.length > 0 &&
        typeof task.subagentName === 'string' &&
        typeof task.startedAt === 'number' &&
        Number.isFinite(task.startedAt) &&
        (task.accountIdentity === undefined ||
          (typeof task.accountIdentity === 'string' && task.accountIdentity.length > 0)) &&
        validReaction(task.triggerReactionRef),
    ) ||
    new Set(record.tasks.map((task) => task.taskId)).size !== record.tasks.length ||
    recordHash(record.key, record.parentSessionId) !== hash
  ) {
    throw new InvalidBackgroundInventory(`Malformed background inventory: ${path}`)
  }
  const validated = record as BackgroundInventoryRecord
  if (validated.recoveryTransfer && !transferMatchesSource(validated, validated.recoveryTransfer.record)) {
    throw new InvalidBackgroundInventory(`Background recovery transfer does not cover its source: ${path}`)
  }
  return validated
}

async function publish(path: string, record: BackgroundInventoryRecord, exclusive: boolean): Promise<boolean> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (exclusive) {
      try {
        await link(temp, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    } else {
      await rename(temp, path)
    }
    await syncDirectory(dirname(path))
    return true
  } finally {
    await removeFile(temp)
  }
}

export class LegacyBackgroundHandoffReader {
  /** Upgrade-only legacy reader. New launches are admitted by BackgroundObligationStore. */
  readonly processEpoch: string
  private readonly directory: string
  private readonly bootStartedAt: number
  private readonly onError: (error: unknown) => void
  private readonly ownedClaims = new Set<string>()

  constructor(
    agentDir: string,
    options: { processEpoch?: string; now?: () => number; onError?: (error: unknown) => void } = {},
  ) {
    this.directory = resolve(agentDir, 'channels', 'background-handoffs')
    this.processEpoch = options.processEpoch ?? randomUUID()
    this.bootStartedAt = (options.now ?? Date.now)()
    this.onError = options.onError ?? ((error) => console.error('[background-handoff]', error))
    if (!this.processEpoch) throw new Error('Background inventory requires a process epoch')
  }

  private report(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      /* Logging must not strand other records. */
    }
  }

  private async files(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).sort()
    } catch (error) {
      if (!missing(error)) this.report(error)
      return []
    }
  }

  async claim(): Promise<ClaimedBackgroundInventory[]> {
    const claims: ClaimedBackgroundInventory[] = []
    // A process can die after rename, preparation, or import. Claimed bytes
    // remain a source until durable outbox ownership permits retirement.
    const claimDirectory = join(this.directory, 'claimed')
    let abandoned: string[] = []
    try {
      abandoned = (await readdir(claimDirectory)).sort()
    } catch (error) {
      if (!missing(error)) this.report(error)
    }
    for (const file of abandoned) {
      const match = claimedPattern.exec(file)
      if (!match) continue
      try {
        const claimPath = join(claimDirectory, file)
        const record = await readRecord(claimPath, match[1]!)
        if (record && record.processEpoch !== this.processEpoch && !this.ownedClaims.has(claimPath)) {
          this.ownedClaims.add(claimPath)
          claims.push({ record, claimPath })
        }
      } catch (error) {
        this.report(error)
      }
    }
    for (const file of await this.files()) {
      const path = join(this.directory, file)
      try {
        if (tempPattern.test(file)) {
          if ((await stat(path)).mtimeMs < this.bootStartedAt) await removeFile(path)
          continue
        }
        if (!pendingPattern.test(file)) continue
        const hash = file.slice(0, -5)
        const claim = await serialized(path, async () => {
          const before = await readRecord(path, hash)
          if (!before || before.processEpoch === this.processEpoch) return undefined
          const claimDirectory = join(this.directory, 'claimed')
          await mkdir(claimDirectory, { recursive: true })
          const claimPath = join(claimDirectory, `${hash}.${randomUUID()}.json`)
          try {
            await rename(path, claimPath)
          } catch (error) {
            if (missing(error)) return undefined
            throw error
          }
          await syncDirectory(claimDirectory)
          await syncDirectory(this.directory)
          // The renamed bytes, not the earlier read, are the owned generation.
          const record = await readRecord(claimPath, hash)
          if (!record) return undefined
          if (record.processEpoch === this.processEpoch) {
            await link(claimPath, path)
            await syncDirectory(this.directory)
            await removeFile(claimPath)
            return undefined
          }
          return { record, claimPath }
        })
        if (claim) {
          this.ownedClaims.add(claim.claimPath)
          claims.push(claim)
        }
      } catch (error) {
        if (!missing(error)) this.report(error)
      }
    }
    return claims
  }

  async prepareRecovery(claim: ClaimedBackgroundInventory, record: RecoveryRecord): Promise<RecoveryRecord> {
    return this.updateRecovery(claim, 'notice-prepared', record)
  }

  async ownRecovery(claim: ClaimedBackgroundInventory, record: RecoveryRecord): Promise<RecoveryRecord> {
    return this.updateRecovery(claim, 'notice-owned', record)
  }

  private async updateRecovery(
    claim: ClaimedBackgroundInventory,
    phase: 'notice-prepared' | 'notice-owned',
    recovery: RecoveryRecord,
  ): Promise<RecoveryRecord> {
    const path = resolve(claim.claimPath)
    const match = claimedPattern.exec(basename(path))
    if (dirname(path) !== join(this.directory, 'claimed') || !match) throw new Error('Invalid inventory claim')
    return serialized(path, async () => {
      const current = await readRecord(path, match[1]!)
      if (!current || current.generationId !== claim.record.generationId)
        throw new Error('Background inventory generation changed during transfer')
      const existing = current.recoveryTransfer
      if (existing && JSON.stringify(existing.record) !== JSON.stringify(recovery))
        throw new Error('Conflicting background recovery transfer')
      const frozen = existing?.record ?? recovery
      if (!validateRecoveryRecord(frozen)) throw new Error('Invalid background recovery payload')
      if (!transferMatchesSource(current, frozen))
        throw new Error('Background recovery transfer does not cover its source')
      if (existing?.phase === 'notice-owned') return frozen
      const next = { ...current, recoveryTransfer: { phase, record: frozen } }
      await publish(path, next, false)
      claim.record = next
      return frozen
    })
  }

  retire(claim: ClaimedBackgroundInventory): Promise<void> {
    const path = resolve(claim.claimPath)
    const match = claimedPattern.exec(basename(path))
    if (
      dirname(path) !== join(this.directory, 'claimed') ||
      !match ||
      match[1] !== recordHash(claim.record.key, claim.record.parentSessionId)
    ) {
      return Promise.reject(new Error('Invalid background inventory claim path'))
    }
    return serialized(path, async () => {
      const current = await readRecord(path, match[1]!)
      if (!current) return
      if (current.generationId !== claim.record.generationId)
        throw new Error('Background inventory generation changed before retirement')
      await removeFile(path)
    })
  }
}
