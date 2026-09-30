import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type { ChannelKey, ReactionRef } from './types'
import { channelKeyId } from './types'

export type BackgroundInventoryRecord = {
  schemaVersion: 1
  generationId: string
  processEpoch: string
  parentSessionId: string
  parentSessionFile: string
  key: ChannelKey
  triggeringAuthorId?: string
  tasks: {
    taskId: string
    subagentName: string
    startedAt: number
    triggerReactionRef?: ReactionRef
  }[]
}

export type BackgroundLaunchIdentity = {
  parentSessionId: string
  key: ChannelKey
  taskId: string
  generationId: string
  processEpoch: string
}

export type ClaimedBackgroundInventory = { record: BackgroundInventoryRecord; claimPath: string }
type LaunchInput = Pick<
  BackgroundInventoryRecord,
  'parentSessionId' | 'parentSessionFile' | 'key' | 'triggeringAuthorId'
> &
  BackgroundInventoryRecord['tasks'][number]

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

async function readRecord(path: string, hash: string): Promise<BackgroundInventoryRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  const record: unknown = JSON.parse(raw)
  if (
    !object(record) ||
    record.schemaVersion !== 1 ||
    !validKey(record.key) ||
    typeof record.parentSessionId !== 'string' ||
    !record.parentSessionId ||
    !validSessionFile(record.parentSessionFile) ||
    typeof record.generationId !== 'string' ||
    !generationPattern.test(record.generationId) ||
    typeof record.processEpoch !== 'string' ||
    !record.processEpoch ||
    (record.triggeringAuthorId !== undefined && typeof record.triggeringAuthorId !== 'string') ||
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
        validReaction(task.triggerReactionRef),
    ) ||
    new Set(record.tasks.map((task) => task.taskId)).size !== record.tasks.length ||
    recordHash(record.key, record.parentSessionId) !== hash
  ) {
    throw new Error(`Malformed background inventory: ${path}`)
  }
  return record as BackgroundInventoryRecord
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

export class BackgroundHandoffInventory {
  readonly processEpoch: string
  private readonly directory: string
  private readonly bootStartedAt: number
  private readonly pending = new Set<Promise<unknown>>()
  private readonly onError: (error: unknown) => void

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

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    )
    return promise
  }

  add(input: LaunchInput): Promise<BackgroundLaunchIdentity> {
    // Capture caller-owned metadata before queueing, not when its filesystem turn arrives.
    const snapshot = structuredClone(input)
    const hash = recordHash(snapshot.key, snapshot.parentSessionId)
    const path = join(this.directory, `${hash}.json`)
    return this.track(
      serialized(path, async () => {
        const file = basename(snapshot.parentSessionFile)
        if (
          !validSessionFile(file) ||
          !validKey(snapshot.key) ||
          !snapshot.parentSessionId ||
          !snapshot.taskId ||
          typeof snapshot.subagentName !== 'string' ||
          !Number.isFinite(snapshot.startedAt) ||
          !validReaction(snapshot.triggerReactionRef)
        )
          throw new Error('Invalid background launch metadata')
        await mkdir(this.directory, { recursive: true })
        await syncDirectory(dirname(this.directory))
        await syncDirectory(dirname(dirname(this.directory)))
        let record = await readRecord(path, hash)
        if (record && record.processEpoch !== this.processEpoch) {
          throw new Error('Prior-process background inventory must be claimed before launching')
        }
        if (!record) {
          record = {
            schemaVersion: 1,
            generationId: randomUUID(),
            processEpoch: this.processEpoch,
            parentSessionId: snapshot.parentSessionId,
            parentSessionFile: file,
            key: snapshot.key,
            triggeringAuthorId: snapshot.triggeringAuthorId,
            tasks: [],
          }
        }
        if (!record.tasks.some((task) => task.taskId === snapshot.taskId)) {
          const next = {
            ...record,
            triggeringAuthorId: snapshot.triggeringAuthorId ?? record.triggeringAuthorId,
            tasks: [
              ...record.tasks,
              {
                taskId: snapshot.taskId,
                subagentName: snapshot.subagentName,
                startedAt: snapshot.startedAt,
                triggerReactionRef: snapshot.triggerReactionRef,
              },
            ],
          }
          if (!(await publish(path, next, record.tasks.length === 0))) {
            throw new Error('Concurrent runtime inventory publication is unsupported')
          }
        }
        return {
          parentSessionId: record.parentSessionId,
          key: record.key,
          taskId: snapshot.taskId,
          generationId: record.generationId,
          processEpoch: record.processEpoch,
        }
      }),
    )
  }

  remove(identity: BackgroundLaunchIdentity): Promise<void> {
    const snapshot = structuredClone(identity)
    const hash = recordHash(snapshot.key, snapshot.parentSessionId)
    const path = join(this.directory, `${hash}.json`)
    return this.track(
      serialized(path, async () => {
        const record = await readRecord(path, hash)
        if (!record || record.generationId !== snapshot.generationId || record.processEpoch !== snapshot.processEpoch)
          return
        const tasks = record.tasks.filter((task) => task.taskId !== snapshot.taskId)
        if (tasks.length === record.tasks.length) return
        if (tasks.length === 0) await removeFile(path)
        else await publish(path, { ...record, tasks }, false)
      }),
    )
  }

  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(this.pending)
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
        if (claim) claims.push(claim)
      } catch (error) {
        if (!missing(error)) this.report(error)
      }
    }
    return claims
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
    return this.track(serialized(path, () => removeFile(path)))
  }
}
