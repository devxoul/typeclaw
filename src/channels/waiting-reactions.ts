import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import type {
  ChannelKey,
  OwnReactionTarget,
  ReactionRef,
  ReactionRequest,
  ReactionResult,
  RemoveOwnReactionRequest,
  RemoveOwnReactionResult,
} from './types'

export interface WaitingReactionHandle {
  readonly req: ReactionRequest
  readonly ownerId: string
  readonly ready: Promise<ReactionRef | null>
  readonly generation: number
  readonly epoch: string
}

export interface ProtectedAcknowledgmentScope {
  conversation: ChannelKey
  kind: string
}

interface ProtectedAcknowledgmentIdentity extends ProtectedAcknowledgmentScope {
  id: string
  target: ReactionRef
  emoji: string
}

function sameConversation(first: ChannelKey, second: ChannelKey): boolean {
  return (
    first.adapter === second.adapter &&
    first.workspace === second.workspace &&
    first.chat === second.chat &&
    (first.thread ?? null) === (second.thread ?? null)
  )
}

function acknowledgmentIdentity(
  scope: ProtectedAcknowledgmentScope,
  prepared: OwnReactionTarget,
): ProtectedAcknowledgmentIdentity {
  const conversation = { ...scope.conversation, thread: scope.conversation.thread ?? null }
  const target = { ...prepared.target }
  return {
    conversation,
    kind: scope.kind,
    target,
    emoji: prepared.emoji,
    id: createHash('sha256')
      .update(
        JSON.stringify([
          conversation.adapter,
          conversation.workspace,
          conversation.chat,
          conversation.thread,
          target.adapter,
          target.value,
          prepared.emoji,
          scope.kind,
        ]),
      )
      .digest('hex'),
  }
}

interface Owner {
  ownerId: string
  generation: number
  epoch: string
  protected: boolean
  acknowledgment?: ProtectedAcknowledgmentIdentity
}
interface TupleRecord {
  schemaVersion: 1
  desired: 'present' | 'absent'
  key: string
  req: ReactionRequest
  prepared: OwnReactionTarget
  generation: number
  owners: Owner[]
  phase: 'adding' | 'present' | 'removing' | 'blocked' | 'absent'
  failure?: RemoveOwnReactionResult
  retryAt?: number
}
interface Reservation {
  handle: WaitingReactionHandle
  protected: boolean
  acknowledgmentScope?: ProtectedAcknowledgmentScope
  released: boolean
  key?: string
  prepared?: OwnReactionTarget
  preparation: Promise<void>
}

/** One runtime owns this journal. A new epoch takes over only after the old runtime stops. */
export function createWaitingReactionCoordinator(options: {
  agentDir: string
  epoch?: string
  add: (req: ReactionRequest, prepared: OwnReactionTarget) => Promise<ReactionResult>
  prepare: (req: ReactionRequest) => Promise<OwnReactionTarget | null>
  remove: (req: RemoveOwnReactionRequest) => Promise<RemoveOwnReactionResult>
}) {
  const epoch = options.epoch ?? randomUUID()
  const directory = join(options.agentDir, 'channels', 'waiting-reactions')
  let ownerGeneration = 0
  const reservations = new Map<string, Reservation>()
  const tupleReservations = new Map<string, Set<Reservation>>()
  const preparing = new Set<Reservation>()
  const retiredOwners = new Set<string>()
  const lanes = new Map<string, Promise<unknown>>()
  const snapshots = new WeakMap<TupleRecord, string>()

  function lane<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    lanes.set(key, next)
    void next
      .finally(() => {
        if (lanes.get(key) === next) lanes.delete(key)
      })
      .catch(() => {})
    return next
  }

  function path(key: string): string {
    return join(directory, `${key}.json`)
  }

  function syncDirectory(directoryPath: string): void {
    // Windows dev cannot fsync directories; ordinary file fsync remains mandatory.
    if (process.platform === 'win32') return
    const fd = openSync(directoryPath, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  function saveIfChanged(record: TupleRecord): void {
    record.desired = record.owners.length > 0 ? 'present' : 'absent'
    if (snapshots.get(record) !== JSON.stringify(record)) save(record)
  }

  function retireAbsent(record: TupleRecord): void {
    if (record.phase !== 'absent' || record.owners.length > 0 || live(record.key).length > 0) return
    if ([...preparing].some((owner) => !owner.released && owner.handle.req.adapter === record.req.adapter)) return
    const latest = load(record.key)
    if (
      !latest ||
      latest.phase !== 'absent' ||
      latest.generation !== record.generation ||
      latest.owners.length > 0 ||
      live(record.key).length > 0
    )
      return
    try {
      unlinkSync(path(record.key))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    syncDirectory(directory)
  }

  function save(record: TupleRecord): void {
    record.desired = record.owners.length > 0 ? 'present' : 'absent'
    const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = join(directory, `${record.key}.${randomUUID()}.tmp`)
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(record))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, path(record.key))
      syncDirectory(directory)
      if (createdDirectory) {
        for (const parent of [join(options.agentDir, 'channels'), options.agentDir]) {
          syncDirectory(parent)
        }
      }
      snapshots.set(record, JSON.stringify(record))
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') report(cleanupError)
      }
      throw error
    }
  }

  function load(key: string): TupleRecord | undefined {
    try {
      const record = JSON.parse(readFileSync(path(key), 'utf8')) as TupleRecord
      const validRef = (ref: ReactionRef | undefined) =>
        ref !== null &&
        typeof ref === 'object' &&
        typeof ref.adapter === 'string' &&
        typeof ref.value === 'string' &&
        ref.value.length > 0
      const validString = (value: unknown) => typeof value === 'string' && value.length > 0
      const validAcknowledgment = (owner: Owner): boolean => {
        const acknowledgment = owner.acknowledgment
        if (acknowledgment === undefined) return true
        if (
          !owner.protected ||
          !acknowledgment ||
          !validString(acknowledgment.kind) ||
          !validString(acknowledgment.id) ||
          !validRef(acknowledgment.target) ||
          !acknowledgment.conversation ||
          acknowledgment.conversation.adapter !== record.req?.adapter ||
          !validString(acknowledgment.conversation.workspace) ||
          !validString(acknowledgment.conversation.chat) ||
          (acknowledgment.conversation.thread != null && typeof acknowledgment.conversation.thread !== 'string') ||
          acknowledgment.target.adapter !== record.prepared?.target.adapter ||
          acknowledgment.target.value !== record.prepared?.target.value ||
          acknowledgment.emoji !== record.prepared?.emoji
        )
          return false
        return acknowledgment.id === acknowledgmentIdentity(acknowledgment, record.prepared).id
      }
      if (
        !record ||
        record.schemaVersion !== 1 ||
        record.key !== key ||
        !Number.isSafeInteger(record.generation) ||
        record.generation < 0 ||
        !['adding', 'present', 'removing', 'blocked', 'absent'].includes(record.phase) ||
        !['present', 'absent'].includes(record.desired) ||
        !record.req ||
        !validString(record.req.adapter) ||
        !validString(record.req.workspace) ||
        !validString(record.req.chat) ||
        !validString(record.req.emoji) ||
        !validRef(record.req.reactionRef) ||
        (record.req.thread != null && typeof record.req.thread !== 'string') ||
        !record.prepared ||
        !validString(record.prepared.accountIdentity) ||
        !validString(record.prepared.emoji) ||
        !validRef(record.prepared.target) ||
        record.prepared.target.adapter !== record.req.adapter ||
        record.req.reactionRef.adapter !== record.req.adapter ||
        !Array.isArray(record.owners) ||
        record.owners.some(
          (owner) =>
            !owner ||
            !validString(owner.ownerId) ||
            !validString(owner.epoch) ||
            typeof owner.protected !== 'boolean' ||
            !Number.isSafeInteger(owner.generation) ||
            owner.generation < 1 ||
            !validAcknowledgment(owner),
        ) ||
        record.desired !== (record.owners.length > 0 ? 'present' : 'absent') ||
        new Set(record.owners.map((owner) => owner.ownerId)).size !== record.owners.length ||
        (record.retryAt !== undefined && (!Number.isFinite(record.retryAt) || record.retryAt < 0)) ||
        (record.failure !== undefined &&
          (record.failure.ok !== false ||
            !['unsupported', 'transient', 'rate-limit', 'permission', 'identity'].includes(record.failure.code) ||
            typeof record.failure.error !== 'string' ||
            (record.failure.retryAfter !== undefined &&
              (!Number.isFinite(record.failure.retryAfter) || record.failure.retryAfter < 0)))) ||
        createHash('sha256')
          .update(
            JSON.stringify([
              record.req.adapter,
              record.prepared.accountIdentity,
              record.prepared.target.adapter,
              record.prepared.target.value,
              record.prepared.emoji,
            ]),
          )
          .digest('hex') !== key
      ) {
        throw new Error('Invalid waiting reaction journal')
      }
      snapshots.set(record, JSON.stringify(record))
      record.owners = record.owners.filter(
        (owner) => !retiredOwners.has(owner.ownerId) && (owner.protected || owner.epoch === epoch),
      )
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  function live(key: string): Reservation[] {
    return [...(tupleReservations.get(key) ?? [])].filter((owner) => !owner.released)
  }

  function mergeOwners(record: TupleRecord): void {
    for (const owner of live(record.key)) {
      if (
        !record.owners.some(
          (item) => item.ownerId === owner.handle.ownerId && item.generation === owner.handle.generation,
        )
      ) {
        record.owners.push({
          ownerId: owner.handle.ownerId,
          generation: owner.handle.generation,
          epoch,
          protected: owner.protected,
          ...(owner.acknowledgmentScope
            ? { acknowledgment: acknowledgmentIdentity(owner.acknowledgmentScope, record.prepared) }
            : {}),
        })
      }
    }
  }

  async function ensurePresent(
    record: TupleRecord,
    acquiredPreparation?: OwnReactionTarget,
  ): Promise<ReactionRef | null> {
    mergeOwners(record)
    record.generation++
    if (record.phase === 'present') {
      saveIfChanged(record)
      return record.prepared.target
    }
    const captured = acquiredPreparation ?? live(record.key).find((owner) => owner.prepared)?.prepared
    const prepared = captured ?? (await options.prepare(record.req))
    if (
      !prepared ||
      prepared.accountIdentity !== record.prepared.accountIdentity ||
      prepared.target.adapter !== record.prepared.target.adapter ||
      prepared.target.value !== record.prepared.target.value ||
      prepared.emoji !== record.prepared.emoji
    )
      return null
    record.prepared = prepared
    record.phase = 'adding'
    delete record.failure
    delete record.retryAt
    // Fsync the intent before the transport can observe the add, including a crash inside add.
    save(record)
    if (record.owners.length === 0) return null
    const result = await options.add(record.req, record.prepared)
    if (!result.ok) {
      // Unsupported is a definite preflight refusal, not an uncertain transport outcome.
      if (result.code === 'unsupported') {
        record.phase = 'absent'
        save(record)
      }
      return null
    }
    record.phase = 'present'
    save(record)
    return record.prepared.target
  }

  async function ensureAbsent(record: TupleRecord): Promise<void> {
    // Preparation publishes canonical reservations before it queues work on this lane.
    await Promise.all(
      [...preparing]
        .filter((owner) => owner.handle.req.adapter === record.req.adapter)
        .map((owner) => owner.preparation),
    )
    mergeOwners(record)
    if (record.owners.length > 0) {
      if (live(record.key).length > 0 && record.phase !== 'present') await ensurePresent(record)
      else saveIfChanged(record)
      return
    }
    if (record.phase === 'absent') {
      retireAbsent(record)
      return
    }
    if (record.retryAt !== undefined && Date.now() < record.retryAt) {
      saveIfChanged(record)
      return
    }
    record.generation++
    record.phase = 'removing'
    save(record)
    const generation = record.generation
    // No await between the final owner/generation check and transport invocation.
    const latest = load(record.key)
    if (!latest || latest.generation !== generation || latest.owners.length > 0 || live(record.key).length > 0) return
    let result: RemoveOwnReactionResult
    try {
      result = await options.remove({
        adapter: record.req.adapter,
        workspace: record.req.workspace,
        chat: record.req.chat,
        thread: record.req.thread,
        target: record.prepared.target,
        emoji: record.prepared.emoji,
        expectedAccountIdentity: record.prepared.accountIdentity,
      })
    } catch (error) {
      result = { ok: false, code: 'transient', error: String(error) }
    }
    if (!result.ok) {
      record.phase = 'blocked'
      record.failure = result
      const delay = result.retryAfter ?? (result.code === 'transient' || result.code === 'rate-limit' ? 1_000 : 0)
      record.retryAt = Date.now() + Math.max(0, delay)
      save(record)
      return
    }
    // Publish absence before retirement; pending canonical owners still rely on this tuple.
    record.phase = 'absent'
    delete record.failure
    delete record.retryAt
    save(record)
    if (live(record.key).length > 0) await ensurePresent(record)
    else retireAbsent(record)
  }

  function report(error: unknown): void {
    console.warn('[waiting-reactions] Durable reaction operation failed:', error)
  }

  function acquire(
    req: ReactionRequest,
    protectedPresence = false,
    acknowledgmentScope?: ProtectedAcknowledgmentScope,
  ): WaitingReactionHandle {
    const ownerId = randomUUID()
    let resolveReady!: (ref: ReactionRef | null) => void
    const ready = new Promise<ReactionRef | null>((resolve) => {
      resolveReady = resolve
    })
    const handle: WaitingReactionHandle = {
      req: { ...req, reactionRef: { ...req.reactionRef } },
      ownerId,
      generation: ++ownerGeneration,
      epoch,
      ready,
    }
    const reservation: Reservation = {
      handle,
      protected: protectedPresence,
      ...(protectedPresence && acknowledgmentScope
        ? {
            acknowledgmentScope: {
              conversation: { ...acknowledgmentScope.conversation },
              kind: acknowledgmentScope.kind,
            },
          }
        : {}),
      released: false,
      preparation: Promise.resolve(),
    }
    // Reserve synchronously: release/recovery must see this owner even before prepare resolves.
    reservations.set(ownerId, reservation)
    preparing.add(reservation)
    const preparationKey = `prepare:${JSON.stringify(handle.req)}`
    reservation.preparation = lane(preparationKey, async () => {
      const prepared = await options.prepare(handle.req)
      if (!prepared) return
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            handle.req.adapter,
            prepared.accountIdentity,
            prepared.target.adapter,
            prepared.target.value,
            prepared.emoji,
          ]),
        )
        .digest('hex')
      reservation.key = key
      reservation.prepared = prepared
      let owners = tupleReservations.get(key)
      if (!owners) {
        owners = new Set()
        tupleReservations.set(key, owners)
      }
      owners.add(reservation)
      void lane(key, async () => {
        if (reservation.released) return null
        const record: TupleRecord = load(key) ?? {
          schemaVersion: 1,
          desired: 'present',
          key,
          req: handle.req,
          prepared,
          generation: 0,
          owners: [],
          phase: 'adding',
        }
        record.prepared = prepared
        return ensurePresent(record, prepared)
      }).then(resolveReady, (error) => {
        report(error)
        resolveReady(null)
      })
    })
      .catch((error) => {
        report(error)
      })
      .finally(() => {
        preparing.delete(reservation)
        if (!reservation.key) resolveReady(null)
      })
    return handle
  }

  async function release(handle: WaitingReactionHandle): Promise<void> {
    const owner = reservations.get(handle.ownerId)
    // Handles are capability tokens: a stale/foreign callback cannot retire another owner.
    if (!owner || owner.handle !== handle || owner.released) return
    owner.released = true
    retiredOwners.add(handle.ownerId)
    await owner.preparation
    if (!owner.key) {
      reservations.delete(handle.ownerId)
      retiredOwners.delete(handle.ownerId)
      return
    }
    try {
      await lane(owner.key, async () => {
        const record = load(owner.key!)
        if (!record) return
        record.owners = record.owners.filter(
          (item) =>
            item.ownerId !== handle.ownerId || item.generation !== handle.generation || item.epoch !== handle.epoch,
        )
        await ensureAbsent(record)
      })
      retiredOwners.delete(handle.ownerId)
    } catch (error) {
      report(error)
    }
    const owners = tupleReservations.get(owner.key)
    owners?.delete(owner)
    if (owners?.size === 0) tupleReservations.delete(owner.key)
    reservations.delete(handle.ownerId)
  }

  // Only the router's genuine-reply decision may use this path. Capture live
  // capabilities now; future acknowledgments in the same conversation survive.
  async function retireAcknowledgments(conversation: ChannelKey): Promise<void> {
    const capturedConversation = { ...conversation }
    const current = [...reservations.values()].filter(
      (owner) =>
        !owner.released &&
        owner.protected &&
        owner.acknowledgmentScope &&
        sameConversation(owner.acknowledgmentScope.conversation, capturedConversation),
    )
    const capturedIds = new Set(current.map((owner) => owner.handle.ownerId))
    const releases = current.map((owner) => release(owner.handle))
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(error)
      await Promise.all(releases)
      return
    }
    for (let offset = 0; offset < files.length; offset += 16) {
      await setImmediate()
      await Promise.all(
        files
          .slice(offset, offset + 16)
          .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
          .map(async (file) => {
            const key = file.slice(0, -5)
            try {
              const record = load(key)
              if (!record) return
              const claims = record.owners.filter(
                (owner) =>
                  owner.protected &&
                  owner.acknowledgment &&
                  sameConversation(owner.acknowledgment.conversation, capturedConversation) &&
                  (owner.epoch !== epoch || capturedIds.has(owner.ownerId) || !reservations.has(owner.ownerId)),
              )
              if (claims.length === 0) return
              await lane(key, async () => {
                const latest = load(key)
                if (!latest) return
                latest.owners = latest.owners.filter(
                  (owner) =>
                    !claims.some(
                      (claim) =>
                        owner.ownerId === claim.ownerId &&
                        owner.generation === claim.generation &&
                        owner.epoch === claim.epoch &&
                        owner.acknowledgment?.id === claim.acknowledgment?.id,
                    ),
                )
                await ensureAbsent(latest)
              })
            } catch (error) {
              report(error)
            }
          }),
      )
    }
    await Promise.all(releases)
  }

  const recoveries = new Map<string, Promise<void>>()
  const recoveringTuples = new Map<string, Promise<void>>()

  async function recoverRecords(adapter?: ReactionRequest['adapter']): Promise<void> {
    await Promise.all(
      [...preparing]
        .filter((owner) => !adapter || owner.handle.req.adapter === adapter)
        .map((owner) => owner.preparation),
    )
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(error)
      return
    }
    for (let offset = 0; offset < files.length; offset += 16) {
      // Bound synchronous tuple work and give reply timers a turn even for protected history.
      await setImmediate()
      await Promise.all(
        files
          .slice(offset, offset + 16)
          .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
          .map((file) => {
            const key = file.slice(0, -5)
            const existing = recoveringTuples.get(key)
            if (existing) return existing
            const pending = lane(key, async () => {
              const record = load(key)
              if (!record || (adapter && record.req.adapter !== adapter)) return
              await ensureAbsent(record)
            })
              .catch(report)
              .finally(() => {
                recoveringTuples.delete(key)
              })
            recoveringTuples.set(key, pending)
            return pending
          }),
      )
    }
  }

  function recover(adapter?: ReactionRequest['adapter']): Promise<void> {
    const key = adapter ?? '*'
    const existing = recoveries.get(key)
    if (existing) return existing
    const pending = recoverRecords(adapter).finally(() => {
      recoveries.delete(key)
    })
    recoveries.set(key, pending)
    return pending
  }

  return { acquire, release, recover, retireAcknowledgments }
}
