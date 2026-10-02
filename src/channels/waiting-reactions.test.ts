import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as filesystem from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReactionRequest, RemoveOwnReactionResult } from './types'
import { createWaitingReactionCoordinator } from './waiting-reactions'

const dirs: string[] = []
afterEach(() => {
  mock.restore()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'waiting-reactions-'))
  dirs.push(dir)
  return dir
}
const req: ReactionRequest = {
  adapter: 'slack-bot',
  workspace: 'workspace',
  chat: 'chat',
  reactionRef: { adapter: 'slack-bot', value: 'message' },
  emoji: 'eyes',
}
const prepare = async (request: ReactionRequest) => ({
  accountIdentity: 'account',
  target: request.reactionRef,
  emoji: request.emoji.replaceAll(':', ''),
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { resolve, promise }
}

function transport() {
  let present = false
  return {
    get present() {
      return present
    },
    add: async () => {
      present = true
      return { ok: true as const }
    },
    remove: async () => {
      present = false
      return { ok: true as const }
    },
  }
}

test('overlapping canonical owners release only the final presence and stale handles cannot retire a new generation', async () => {
  const remote = transport()
  const coordinator = createWaitingReactionCoordinator({ agentDir: directory(), prepare, ...remote })
  const first = coordinator.acquire(req)
  const second = coordinator.acquire({ ...req, emoji: ':eyes:' })
  await Promise.all([first.ready, second.ready])
  await coordinator.release(first)
  expect(remote.present).toBe(true)
  await coordinator.release(second)
  expect(remote.present).toBe(false)
  const third = coordinator.acquire(req)
  await third.ready
  await coordinator.release(first)
  expect(remote.present).toBe(true)
  await coordinator.release({ ...third })
  expect(remote.present).toBe(true)
  await coordinator.release(third)
  expect(remote.present).toBe(false)
})

test('new owner restores presence acquired during in-flight removal', async () => {
  const remote = transport()
  const started = deferred<void>()
  const finish = deferred<void>()
  const coordinator = createWaitingReactionCoordinator({
    agentDir: directory(),
    prepare,
    add: remote.add,
    remove: async () => {
      started.resolve()
      await finish.promise
      return remote.remove()
    },
  })
  const first = coordinator.acquire(req)
  await first.ready
  const releasing = coordinator.release(first)
  await started.promise
  const second = coordinator.acquire(req, true)
  finish.resolve()
  await releasing
  await second.ready
  expect(remote.present).toBe(true)
  await coordinator.recover()
  expect(remote.present).toBe(true)
})

test('synchronous reservation protects an owner whose preparation is still pending from recovery', async () => {
  const agentDir = directory()
  const remote = transport()
  const old = createWaitingReactionCoordinator({ agentDir, epoch: 'old', prepare, ...remote })
  await old.acquire(req).ready
  const gate = deferred<void>()
  const current = createWaitingReactionCoordinator({
    agentDir,
    epoch: 'new',
    prepare: async (request) => {
      await gate.promise
      return prepare(request)
    },
    ...remote,
  })
  const handle = current.acquire(req)
  const recovery = current.recover()
  gate.resolve()
  await recovery
  await handle.ready
  expect(remote.present).toBe(true)
  await current.release(handle)
  expect(remote.present).toBe(false)
})

test('protected acknowledgment survives reboot and temporary owner cleanup; healthy explicit retirement is allowed', async () => {
  const agentDir = directory()
  const remote = transport()
  const first = createWaitingReactionCoordinator({ agentDir, epoch: 'old', prepare, ...remote })
  const acknowledgment = first.acquire(req, true)
  await acknowledgment.ready
  const next = createWaitingReactionCoordinator({ agentDir, epoch: 'new', prepare, ...remote })
  await next.recover()
  expect(remote.present).toBe(true)
  const temporary = next.acquire(req)
  await temporary.ready
  await next.release(temporary)
  expect(remote.present).toBe(true)
  // A protected handle is intentionally retired by its healthy owning runtime.
  await first.release(acknowledgment)
  expect(remote.present).toBe(false)
})

test('blocked identity and retry results remain durable and later recovery removes the original account tuple', async () => {
  const agentDir = directory()
  let now = Date.now()
  spyOn(Date, 'now').mockImplementation(() => now)
  const remote = transport()
  let result: RemoveOwnReactionResult = { ok: false, code: 'identity', error: 'account changed' }
  const first = createWaitingReactionCoordinator({ agentDir, prepare, add: remote.add, remove: async () => result })
  const handle = first.acquire(req)
  await handle.ready
  await first.release(handle)
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  const file = readdirSync(journalDir).find((name) => name.endsWith('.json'))!
  expect(JSON.parse(readFileSync(join(journalDir, file), 'utf8')).failure.code).toBe('identity')
  const next = createWaitingReactionCoordinator({
    agentDir,
    prepare,
    add: remote.add,
    remove: async (request) => {
      expect(request.expectedAccountIdentity).toBe('account')
      if (!result.ok) return result
      return remote.remove()
    },
  })
  result = { ok: false, code: 'rate-limit', error: 'later', retryAfter: 10 }
  await next.recover()
  expect(remote.present).toBe(true)
  expect(JSON.parse(readFileSync(join(journalDir, file), 'utf8')).failure.retryAfter).toBe(10)
  result = { ok: true }
  await next.recover()
  expect(remote.present).toBe(true)
  now += 10
  await next.recover()
  expect(remote.present).toBe(false)
})

test('unwritable journal skips add and leaves routing ready resolved', async () => {
  const agentDir = directory()
  writeFileSync(join(agentDir, 'channels'), 'not a directory')
  const remote = transport()
  const coordinator = createWaitingReactionCoordinator({ agentDir, prepare, ...remote })
  const handle = coordinator.acquire(req)
  expect(await handle.ready).toBeNull()
  expect(remote.present).toBe(false)
  await coordinator.release(handle)
})

test('healthy temporary-to-protected conversion does not remove the acknowledgment presence', async () => {
  const agentDir = directory()
  const remote = transport()
  const current = createWaitingReactionCoordinator({ agentDir, prepare, ...remote })
  const temporary = current.acquire(req)
  await temporary.ready
  const snapshots: Array<{ desired: string; owners: Array<{ ownerId: string; protected: boolean }> }> = []
  const rename = filesystem.renameSync
  spyOn(filesystem, 'renameSync').mockImplementation((source, destination) => {
    rename(source, destination)
    if (String(destination).endsWith('.json')) {
      snapshots.push(JSON.parse(readFileSync(destination, 'utf8')))
    }
  })
  const released = current.release(temporary)
  const acknowledgment = current.acquire(req, true)
  await released
  await acknowledgment.ready
  expect(remote.present).toBe(true)
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  const file = readdirSync(journalDir).find((name) => name.endsWith('.json'))!
  const record = JSON.parse(readFileSync(join(journalDir, file), 'utf8'))
  expect(record.desired).toBe('present')
  expect(record.owners).toEqual([
    {
      ownerId: acknowledgment.ownerId,
      epoch: acknowledgment.epoch,
      generation: acknowledgment.generation,
      protected: true,
    },
  ])
  // Every published retirement includes the protected successor in the SAME
  // durable replacement: death between writes cannot expose release-only state.
  expect(snapshots.length).toBeGreaterThan(0)
  for (const snapshot of snapshots) {
    expect(snapshot.desired).toBe('present')
    expect(snapshot.owners.some((owner) => owner.ownerId === acknowledgment.ownerId && owner.protected)).toBe(true)
  }
  const reboot = createWaitingReactionCoordinator({ agentDir, prepare, ...remote })
  await reboot.recover()
  expect(remote.present).toBe(true)
})

test('supervisor recovery ticks coalesce while transport is stalled', async () => {
  const agentDir = directory()
  const remote = transport()
  const old = createWaitingReactionCoordinator({ agentDir, prepare, ...remote })
  await old.acquire(req).ready
  const gate = deferred<void>()
  const started = deferred<void>()
  let removals = 0
  const current = createWaitingReactionCoordinator({
    agentDir,
    prepare,
    add: remote.add,
    remove: async () => {
      removals++
      started.resolve()
      await gate.promise
      return remote.remove()
    },
  })
  const recovery = current.recover('slack-bot')
  await started.promise
  const ticks = Array.from({ length: 20 }, () => current.recover('slack-bot'))
  gate.resolve()
  await Promise.all([recovery, ...ticks])
  expect(removals).toBe(1)
  expect(remote.present).toBe(false)
})

test('canonical target aliases across workspace and chat share presence ownership', async () => {
  const remote = transport()
  const coordinator = createWaitingReactionCoordinator({ agentDir: directory(), prepare, ...remote })
  const first = coordinator.acquire(req)
  const alias = coordinator.acquire({ ...req, workspace: 'alias-workspace', chat: 'alias-chat' })
  await Promise.all([first.ready, alias.ready])
  await coordinator.release(first)
  expect(remote.present).toBe(true)
  await coordinator.release(alias)
  expect(remote.present).toBe(false)
})

test('failed add response still retires transport presence when released', async () => {
  const remote = transport()
  const coordinator = createWaitingReactionCoordinator({
    agentDir: directory(),
    prepare,
    add: async () => {
      await remote.add()
      return { ok: false, code: 'transient', error: 'response lost' }
    },
    remove: remote.remove,
  })
  const handle = coordinator.acquire(req)
  expect(await handle.ready).toBeNull()
  expect(remote.present).toBe(true)
  await coordinator.release(handle)
  expect(remote.present).toBe(false)
})

test('definite unsupported add never removes an existing transport presence', async () => {
  const remote = transport()
  await remote.add()
  const coordinator = createWaitingReactionCoordinator({
    agentDir: directory(),
    prepare,
    add: async () => ({ ok: false, code: 'unsupported', error: 'not supported' }),
    remove: remote.remove,
  })
  const handle = coordinator.acquire(req)
  expect(await handle.ready).toBeNull()
  await coordinator.release(handle)
  await coordinator.recover()
  expect(remote.present).toBe(true)
})

for (const platform of ['native', 'win32'] as const) {
  test(`generation changed by an independent writer after intent sync fences stale transport cleanup (${platform})`, async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      if (platform === 'win32') Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
      const agentDir = directory()
      const remote = transport()
      const coordinator = createWaitingReactionCoordinator({ agentDir, prepare, ...remote })
      const handle = coordinator.acquire(req)
      await handle.ready
      const journalDir = join(agentDir, 'channels', 'waiting-reactions')
      const journal = join(journalDir, readdirSync(journalDir).find((name) => name.endsWith('.json'))!)
      const read = filesystem.readFileSync
      let advanced = false
      let advancedGeneration = 0
      // The final journal read follows file fsync, rename, and any required directory fsync.
      // A file-fsync hook sees the old journal before rename; Windows has no later directory fsync.
      spyOn(filesystem, 'readFileSync').mockImplementation(((path, options) => {
        const content = read(path, options)
        if (advanced || path !== journal || typeof content !== 'string') return content
        const record = JSON.parse(content)
        if (record.phase !== 'removing') return content
        const writer = Bun.spawnSync([
          process.execPath,
          '-e',
          `
          import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
          const path = ${JSON.stringify(journal)}
          const record = JSON.parse(readFileSync(path, 'utf8'))
          record.generation++
          const fd = openSync(path + '.writer', 'wx')
          try {
            writeFileSync(fd, JSON.stringify(record))
            fsyncSync(fd)
          } finally {
            closeSync(fd)
          }
          renameSync(path + '.writer', path)
          if (process.platform !== 'win32') {
            const directory = openSync(${JSON.stringify(journalDir)}, 'r')
            try { fsyncSync(directory) } finally { closeSync(directory) }
          }
        `,
        ])
        expect(writer.exitCode).toBe(0)
        advanced = true
        advancedGeneration = record.generation + 1
        return read(path, options)
      }) as typeof filesystem.readFileSync)
      await coordinator.release(handle)
      expect(advanced).toBe(true)
      expect(remote.present).toBe(true)
      expect(JSON.parse(read(journal, 'utf8')).generation).toBe(advancedGeneration)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })
}

test('corrupted journal never authorizes removal of an unsafe target', async () => {
  const agentDir = directory()
  const remote = transport()
  const coordinator = createWaitingReactionCoordinator({ agentDir, prepare, ...remote })
  await coordinator.acquire(req).ready
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  const file = readdirSync(journalDir).find((name) => name.endsWith('.json'))!
  const journal = join(journalDir, file)
  const original = JSON.parse(readFileSync(journal, 'utf8'))
  const changes = [
    (record: typeof original) => {
      record.prepared.target.value = 'another-message'
    },
    (record: typeof original) => {
      record.generation = -1
    },
    (record: typeof original) => {
      record.owners[0].protected = 'false'
    },
    (record: typeof original) => {
      record.req.chat = null
    },
    (record: typeof original) => {
      record.schemaVersion = 2
    },
  ]
  for (const change of changes) {
    const record = structuredClone(original)
    change(record)
    writeFileSync(journal, JSON.stringify(record))
    const reboot = createWaitingReactionCoordinator({ agentDir, prepare, ...remote })
    await reboot.recover()
    expect(remote.present).toBe(true)
  }
})

for (const crash of ['before-intent', 'after-add', 'after-protected-add'] as const) {
  test(`independent runtime recovery after process death ${crash}`, async () => {
    const agentDir = directory()
    const modulePath = join(import.meta.dir, 'waiting-reactions.ts')
    const script = join(agentDir, 'crash.ts')
    const presence = join(agentDir, 'remote-presence')
    writeFileSync(
      script,
      `
      import { writeFileSync } from 'node:fs'
      import { createWaitingReactionCoordinator } from ${JSON.stringify(modulePath)}
      const coordinator = createWaitingReactionCoordinator({
        agentDir: ${JSON.stringify(agentDir)}, epoch: 'dead-runtime',
        prepare: async req => {
          if (${JSON.stringify(crash)} === 'before-intent') process.kill(process.pid, 'SIGKILL')
          return { accountIdentity: 'account', target: req.reactionRef, emoji: req.emoji }
        },
        add: async () => {
          writeFileSync(${JSON.stringify(presence)}, 'present')
          process.kill(process.pid, 'SIGKILL')
          return { ok: true }
        }, remove: async () => ({ ok: true }),
      })
      await coordinator.acquire(${JSON.stringify(req)}, ${crash === 'after-protected-add'}).ready
    `,
    )
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).not.toBe(0)
    let removal = false
    const coordinator = createWaitingReactionCoordinator({
      agentDir,
      prepare,
      add: async () => ({ ok: true }),
      remove: async () => {
        // This is the persistent stand-in for transport-side presence across process death.
        expect(readFileSync(presence, 'utf8')).toBe('present')
        writeFileSync(presence, 'absent')
        removal = true
        return { ok: true }
      },
    })
    await coordinator.recover()
    expect(removal).toBe(crash === 'after-add')
    if (crash === 'after-add') expect(readFileSync(presence, 'utf8')).toBe('absent')
    if (crash === 'after-protected-add') expect(readFileSync(presence, 'utf8')).toBe('present')
  })
}

test('Windows skips directory sync but synchronizes intent files before add', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const sync = filesystem.fsyncSync
  let fileSyncs = 0
  spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    if (filesystem.fstatSync(fd).isDirectory()) throw new Error('Windows cannot sync directories')
    sync(fd)
    fileSyncs++
  })
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const coordinator = createWaitingReactionCoordinator({
      agentDir: directory(),
      prepare,
      add: async () => {
        expect(fileSyncs).toBe(1)
        return { ok: true }
      },
      remove: async () => ({ ok: true }),
    })
    const handle = coordinator.acquire(req)
    expect(await handle.ready).toEqual(req.reactionRef)
    expect(fileSyncs).toBe(2)
    await coordinator.release(handle)
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

test('POSIX directory sync errors still refuse add after real file sync', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const sync = filesystem.fsyncSync
  let fileSyncs = 0
  let adds = 0
  spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    if (filesystem.fstatSync(fd).isDirectory()) throw Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    sync(fd)
    fileSyncs++
  })
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    const coordinator = createWaitingReactionCoordinator({
      agentDir: directory(),
      prepare,
      add: async () => {
        adds++
        return { ok: true }
      },
      remove: async () => ({ ok: true }),
    })
    expect(await coordinator.acquire(req).ready).toBeNull()
    expect(fileSyncs).toBe(1)
    expect(adds).toBe(0)
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

test('settled tuples retire and missing-file stale capabilities cannot affect later protected owners', async () => {
  const agentDir = directory()
  const remote = transport()
  const coordinator = createWaitingReactionCoordinator({ agentDir, prepare, ...remote })
  const first = coordinator.acquire(req)
  await first.ready
  await coordinator.release(first)
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  expect(readdirSync(journalDir)).toEqual([])
  await coordinator.release(first)
  await coordinator.recover()
  expect(readdirSync(journalDir)).toEqual([])
  const protectedOwner = coordinator.acquire(req, true)
  await protectedOwner.ready
  await coordinator.release(first)
  await coordinator.release({ ...protectedOwner })
  await coordinator.recover()
  expect(remote.present).toBe(true)
  const journal = join(journalDir, readdirSync(journalDir)[0]!)
  expect(JSON.parse(readFileSync(journal, 'utf8')).owners).toEqual([
    {
      ownerId: protectedOwner.ownerId,
      generation: protectedOwner.generation,
      epoch: protectedOwner.epoch,
      protected: true,
    },
  ])
})

test('unchanged protected and deferred unresolved recovery performs no writes and yields during scanning', async () => {
  const agentDir = directory()
  const old = createWaitingReactionCoordinator({
    agentDir,
    epoch: 'old',
    prepare,
    add: async () => ({ ok: true }),
    remove: async () => ({ ok: false, code: 'rate-limit', error: 'later', retryAfter: 60_000 }),
  })
  const count = 256
  for (let i = 0; i < count; i++) {
    const handle = old.acquire({ ...req, reactionRef: { ...req.reactionRef, value: String(i) } }, i % 2 === 0)
    await handle.ready
    if (i % 2 !== 0) await old.release(handle)
  }
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  const before = readdirSync(journalDir).map((file) => [file, readFileSync(join(journalDir, file), 'utf8')])
  const read = filesystem.readFileSync
  let scanned = 0
  let scannedAtTimer = -1
  let timer!: NodeJS.Timeout
  // This integration probes real event-loop starvation; fake time cannot exercise fs scan scheduling.
  spyOn(filesystem, 'readFileSync').mockImplementation(((...args: Parameters<typeof filesystem.readFileSync>) => {
    if (String(args[0]).endsWith('.json')) {
      scanned++
      if (scanned === 1)
        timer = setTimeout(() => {
          scannedAtTimer = scanned
        }, 0)
    }
    return read(...args)
  }) as typeof filesystem.readFileSync)
  const write = spyOn(filesystem, 'writeFileSync')
  const rename = spyOn(filesystem, 'renameSync')
  const unlink = spyOn(filesystem, 'unlinkSync')
  const reboot = createWaitingReactionCoordinator({
    agentDir,
    epoch: 'new',
    prepare,
    add: async () => {
      throw new Error('protected presence must not be added again')
    },
    remove: async () => {
      throw new Error('retry window must defer removal')
    },
  })
  await reboot.recover()
  clearTimeout(timer)
  expect(scanned).toBe(count)
  expect(scannedAtTimer).toBeGreaterThan(0)
  expect(scannedAtTimer).toBeLessThan(count)
  expect(write).not.toHaveBeenCalled()
  expect(rename).not.toHaveBeenCalled()
  expect(unlink).not.toHaveBeenCalled()
  expect(readdirSync(journalDir).map((file) => [file, read(join(journalDir, file), 'utf8')])).toEqual(before)
})

test('retirement keeps absence while a new canonical reservation is still preparing', async () => {
  const agentDir = directory()
  const remote = transport()
  const removing = deferred<void>()
  const finishRemoval = deferred<void>()
  const preparing = deferred<void>()
  let prepares = 0
  const coordinator = createWaitingReactionCoordinator({
    agentDir,
    prepare: async (request) => {
      if (++prepares > 1) await preparing.promise
      return prepare(request)
    },
    add: remote.add,
    remove: async () => {
      removing.resolve()
      await finishRemoval.promise
      return remote.remove()
    },
  })
  const first = coordinator.acquire(req)
  await first.ready
  const release = coordinator.release(first)
  await removing.promise
  const successor = coordinator.acquire(req, true)
  finishRemoval.resolve()
  await release
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  const files = readdirSync(journalDir)
  expect(files.length).toBe(1)
  expect(JSON.parse(readFileSync(join(journalDir, files[0]!), 'utf8')).phase).toBe('absent')
  preparing.resolve()
  await successor.ready
  await coordinator.release(first)
  await coordinator.recover()
  expect(remote.present).toBe(true)
  expect(JSON.parse(readFileSync(join(journalDir, files[0]!), 'utf8')).owners).toEqual([
    { ownerId: successor.ownerId, generation: successor.generation, epoch: successor.epoch, protected: true },
  ])
})

test('a fresh coordinator retires only the genuine reply conversation acknowledgments', async () => {
  const agentDir = directory()
  const remote = transport()
  const conversation = { adapter: req.adapter, workspace: req.workspace, chat: req.chat, thread: null }
  const scope = { conversation, kind: 'github_review_output' }
  await createWaitingReactionCoordinator({ agentDir, epoch: 'old', prepare, ...remote }).acquire(req, true, scope).ready
  const current = createWaitingReactionCoordinator({ agentDir, epoch: 'new', prepare, ...remote })
  await current.recover()
  expect(remote.present).toBe(true)
  const temporary = current.acquire(req)
  await temporary.ready
  await current.release(temporary)
  expect(remote.present).toBe(true)
  await current.retireAcknowledgments({ ...conversation, thread: 'other-thread' })
  expect(remote.present).toBe(true)
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  const file = readdirSync(journalDir).find((name) => name.endsWith('.json'))!
  const protectedOwner = JSON.parse(readFileSync(join(journalDir, file), 'utf8')).owners[0]
  expect(protectedOwner.acknowledgment).toMatchObject({
    conversation,
    target: req.reactionRef,
    emoji: 'eyes',
    kind: scope.kind,
  })
  const replyConversation = { ...conversation }
  const retirement = current.retireAcknowledgments(replyConversation)
  replyConversation.chat = 'changed-after-reply'
  await retirement
  expect(remote.present).toBe(false)
  expect(readdirSync(journalDir).filter((name) => name.endsWith('.json'))).toEqual([])
})

test('conversation retirement captures old owners without sweeping a newer acknowledgment', async () => {
  const agentDir = directory()
  const remote = transport()
  const conversation = { adapter: req.adapter, workspace: req.workspace, chat: req.chat, thread: null }
  const scope = { conversation, kind: 'awaiting_background_child' }
  const old = createWaitingReactionCoordinator({ agentDir, epoch: 'old', prepare, ...remote }).acquire(req, true, scope)
  await old.ready
  const current = createWaitingReactionCoordinator({ agentDir, epoch: 'new', prepare, ...remote })
  const retirement = current.retireAcknowledgments(conversation)
  const newer = current.acquire(req, true, scope)
  await Promise.all([retirement, newer.ready])
  expect(remote.present).toBe(true)
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  const file = readdirSync(journalDir).find((name) => name.endsWith('.json'))!
  const record = JSON.parse(readFileSync(join(journalDir, file), 'utf8'))
  expect(record.owners.map((owner: { ownerId: string }) => owner.ownerId)).toEqual([newer.ownerId])
  expect(record.owners[0].generation).toBe(newer.generation)
  await current.recover()
  expect(remote.present).toBe(true)
  await current.retireAcknowledgments(conversation)
  expect(remote.present).toBe(false)
})

test('conversation retirement rejects a stale captured acknowledgment generation', async () => {
  const agentDir = directory()
  const remote = transport()
  const conversation = { adapter: req.adapter, workspace: req.workspace, chat: req.chat, thread: null }
  const scope = { conversation, kind: 'github_review_output' }
  const old = createWaitingReactionCoordinator({ agentDir, epoch: 'old', prepare, ...remote }).acquire(req, true, scope)
  await old.ready
  const read = filesystem.readFileSync
  let advanced = false
  spyOn(filesystem, 'readFileSync').mockImplementation(((...args: Parameters<typeof filesystem.readFileSync>) => {
    const contents = read(...args)
    if (!advanced && String(args[0]).endsWith('.json') && typeof contents === 'string') {
      const record = JSON.parse(contents)
      if (record.owners.some((owner: { ownerId: string }) => owner.ownerId === old.ownerId)) {
        record.owners[0].generation++
        record.generation++
        writeFileSync(String(args[0]), JSON.stringify(record))
        advanced = true
      }
    }
    return contents
  }) as typeof filesystem.readFileSync)
  const current = createWaitingReactionCoordinator({ agentDir, epoch: 'new', prepare, ...remote })
  await current.retireAcknowledgments(conversation)
  expect(advanced).toBe(true)
  expect(remote.present).toBe(true)
  const journalDir = join(agentDir, 'channels', 'waiting-reactions')
  const file = readdirSync(journalDir).find((name) => name.endsWith('.json'))!
  const record = JSON.parse(readFileSync(join(journalDir, file), 'utf8'))
  expect(record.owners[0].ownerId).toBe(old.ownerId)
  expect(record.owners[0].generation).toBe(old.generation + 1)
})
