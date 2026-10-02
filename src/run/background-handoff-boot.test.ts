import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { peekRestartHandoff, writeRestartHandoff } from '@/agent/restart-handoff'
import { BackgroundHandoffInventory } from '@/channels/background-handoff'
import { saveChannelSessions } from '@/channels/persistence'
import { RecoveryOutbox } from '@/channels/recovery-outbox'
import type { ChannelKey } from '@/channels/types'

import {
  bootBackgroundHandoffs,
  importBackgroundRecoveryNotices,
  prepareBackgroundRecoveryNotice,
} from './background-handoff-boot'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const key: ChannelKey = { adapter: 'discord-bot', workspace: 'w', chat: 'c', thread: 't' }
async function setup(accountIdentity?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-import-'))
  dirs.push(dir)
  const inventory = new BackgroundHandoffInventory(dir, { processEpoch: 'dead' })
  await inventory.add({
    parentSessionId: 'parent',
    parentSessionFile: 'missing.jsonl',
    key,
    taskId: 'task',
    subagentName: 'worker',
    startedAt: 1,
    triggeringAuthorId: 'author',
    accountIdentity,
  })
  return dir
}

test('conflicting sibling identities freeze sorted diagnostics through preparation and reboot', async () => {
  const dir = await setup('actor-B')
  const writer = new BackgroundHandoffInventory(dir, { processEpoch: 'dead' })
  await writer.add({
    parentSessionId: 'parent',
    key,
    taskId: 'second',
    subagentName: 'worker',
    startedAt: 2,
    accountIdentity: 'actor-A',
  })
  await writer.add({ parentSessionId: 'parent', key, taskId: 'unbound', subagentName: 'worker', startedAt: 3 })
  const first = new BackgroundHandoffInventory(dir, { processEpoch: 'first' })
  const claim = (await first.claim())[0]!
  const prepared = await first.prepareRecovery(claim, await prepareBackgroundRecoveryNotice(claim))
  expect(prepared.accountIdentity).toBe('unbound-legacy')
  expect(prepared.accountIdentityConflict).toEqual(['actor-A', 'actor-B'])
  expect(prepared.covers.map((coverage) => coverage.store)).toEqual(['inventory', 'inventory', 'inventory'])
  await expect(
    first.prepareRecovery(claim, { ...prepared, accountIdentityConflict: ['actor-A', 'actor-C'] }),
  ).rejects.toThrow('Conflicting background recovery transfer')
  const outbox = new RecoveryOutbox(dir, { epoch: 'next' })
  await importBackgroundRecoveryNotices({
    inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'next' }),
    outbox,
    prepare: async () => {
      throw new Error('frozen source must be reused')
    },
    onError: (error) => {
      throw error
    },
  })
  expect(await outbox.list()).toEqual([prepared])
  expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toEqual([])
})

test('source validation rejects conflict diagnostics that disagree with admitted rows', async () => {
  const dir = await setup('actor-B')
  const writer = new BackgroundHandoffInventory(dir, { processEpoch: 'dead' })
  await writer.add({
    parentSessionId: 'parent',
    key,
    taskId: 'second',
    subagentName: 'worker',
    startedAt: 2,
    accountIdentity: 'actor-A',
  })
  const first = new BackgroundHandoffInventory(dir, { processEpoch: 'first' })
  const claim = (await first.claim())[0]!
  const record = await prepareBackgroundRecoveryNotice(claim)
  await expect(
    first.prepareRecovery(claim, { ...record, accountIdentityConflict: ['actor-A', 'actor-C'] }),
  ).rejects.toThrow('does not cover its source')
  await first.prepareRecovery(claim, record)
  const source = JSON.parse(await readFile(claim.claimPath, 'utf8'))
  source.recoveryTransfer.record.accountIdentityConflict = ['actor-A', 'actor-C']
  await writeFile(claim.claimPath, JSON.stringify(source))
  const errors: unknown[] = []
  const outbox = new RecoveryOutbox(dir)
  await importBackgroundRecoveryNotices({
    inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'next', onError: (error) => errors.push(error) }),
    outbox,
    prepare: prepareBackgroundRecoveryNotice,
    onError: (error) => errors.push(error),
  })
  expect(await outbox.list()).toEqual([])
  expect(errors.map(String)).toEqual([expect.stringContaining('does not cover its source')])
  expect(await readFile(claim.claimPath, 'utf8')).toBe(JSON.stringify(source))
})

for (const field of ['adapter', 'workspace', 'chat', 'parentChat', 'lastInboundAuthorId'] as const) {
  test(`prepared recovery rejects changed principal ${field} and retains source evidence`, async () => {
    const dir = await setup('actor')
    const writer = new BackgroundHandoffInventory(dir, { processEpoch: 'dead' })
    await writer.add({
      parentSessionId: 'parent',
      key,
      taskId: 'thread-task',
      subagentName: 'worker',
      startedAt: 2,
      parentChat: 'PARENT',
      triggeringAuthorId: 'ALICE',
      accountIdentity: 'actor',
    })
    const inventory = new BackgroundHandoffInventory(dir, { processEpoch: 'first' })
    const claim = (await inventory.claim())[0]!
    const notice = await prepareBackgroundRecoveryNotice(claim)
    if (notice.principal.kind !== 'channel') throw new Error('Expected channel recovery principal')
    const changed = {
      ...notice,
      principal: { ...notice.principal, [field]: field === 'adapter' ? 'slack-bot' : 'OTHER' },
    } as typeof notice
    await expect(inventory.prepareRecovery(claim, changed)).rejects.toThrow('does not cover its source')
    const prepared = await inventory.prepareRecovery(claim, notice)
    await expect(inventory.prepareRecovery(claim, changed)).rejects.toThrow('Conflicting background recovery transfer')
    const outbox = new RecoveryOutbox(dir, { epoch: 'next' })
    const errors: unknown[] = []
    await importBackgroundRecoveryNotices({
      inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'next' }),
      outbox,
      prepare: async () => {
        throw new Error('prepared principal must be reused')
      },
      onError: (error) => errors.push(error),
    })
    expect(errors).toEqual([])
    expect(await outbox.list()).toEqual([prepared])
  })
}

for (const boundary of ['before-import', 'after-import', 'after-source-owned', 'after-retire', 'inside-startup']) {
  test(`process death ${boundary} keeps stable delivery through two boots without model work`, async () => {
    const dir = await setup('discord-bot:actor')
    const worker = join(dir, 'worker.ts')
    const inventoryModule = new URL('../channels/background-handoff.ts', import.meta.url).href
    const outboxModule = new URL('../channels/recovery-outbox.ts', import.meta.url).href
    const bootModule = new URL('./background-handoff-boot.ts', import.meta.url).href
    await writeFile(
      worker,
      `
import {BackgroundHandoffInventory} from ${JSON.stringify(inventoryModule)};
import {RecoveryOutbox} from ${JSON.stringify(outboxModule)};
import {bootBackgroundHandoffs,prepareBackgroundRecoveryNotice} from ${JSON.stringify(bootModule)};
const inventory=new BackgroundHandoffInventory(process.argv[2],{processEpoch:'first-boot'});
const outbox=new RecoveryOutbox(process.argv[2],{epoch:'first-boot'});
const die=async(point)=>{console.log(JSON.stringify({boundary:point}));await Bun.stdin.text();throw Error('crash boundary resumed without termination');};
const boundary=process.argv[3];
const originalImport=outbox.import.bind(outbox);
outbox.import=async(record)=>{if(boundary==='before-import')await die('before-import');const result=await originalImport(record);if(boundary==='after-import')await die('after-import');return result;};
const own=inventory.ownRecovery.bind(inventory);
inventory.ownRecovery=async(...args)=>{const result=await own(...args);if(boundary==='after-source-owned')await die('after-source-owned');return result;};
const retire=inventory.retire.bind(inventory);
inventory.retire=async(claim)=>{await retire(claim);if(boundary==='after-retire')await die('after-retire');};
await bootBackgroundHandoffs({agentDir:process.argv[2],inventory,recovery:{outbox,prepare:prepareBackgroundRecoveryNotice},router:{reserveRestartHandoff(){throw Error('model work forbidden');}},configured:()=>true,onError:error=>{throw error},startAdapters:async()=>{await die('inside-startup');}});
`,
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
      if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
      expect(await new Response(child.stderr).text()).toBe('')
    } finally {
      child.kill('SIGKILL')
      await child.exited
      reader.releaseLock()
    }
    const before = await new RecoveryOutbox(dir, { epoch: 'inspect' }).list()
    const importedIds: string[] = []
    for (const epoch of ['second-boot', 'third-boot']) {
      const outbox = new RecoveryOutbox(dir, { epoch })
      await importBackgroundRecoveryNotices({
        inventory: new BackgroundHandoffInventory(dir, { processEpoch: epoch }),
        outbox,
        prepare: prepareBackgroundRecoveryNotice,
        onError: (error) => {
          throw error
        },
      })
      const records = await outbox.list()
      expect(records).toHaveLength(1)
      expect(records[0]!.target).toEqual(key)
      expect(records[0]!.accountIdentity).toBe('discord-bot:actor')
      importedIds.push(records[0]!.deliveryId)
    }
    expect(importedIds[1]).toBe(importedIds[0])
    if (before.length) expect(before[0]!.deliveryId).toBe(importedIds[0]!)
    expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toEqual([])
  })
}

test('corrupt transcript, changed mapping, disabled adapter do not redirect or discard notices', async () => {
  const dir = await setup()
  await mkdir(join(dir, 'sessions'), { recursive: true })
  await writeFile(join(dir, 'sessions', 'missing.jsonl'), '{"corrupt transcript')
  await saveChannelSessions(dir, [{ ...key, chat: 'replacement', sessionId: 'successor', participants: [] }])
  const outbox = new RecoveryOutbox(dir, { epoch: 'boot' })
  await bootBackgroundHandoffs({
    agentDir: dir,
    inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'boot' }),
    recovery: { outbox, prepare: prepareBackgroundRecoveryNotice },
    configured: () => false,
    router: {
      reserveRestartHandoff: () => {
        throw new Error('model must not run')
      },
    },
    startAdapters: async () => {},
    onError: (error) => {
      throw error
    },
  })
  const records = await outbox.list()
  expect(records).toHaveLength(1)
  expect(records[0]!.target).toEqual(key)
  expect(records[0]!.accountIdentity).toBe('unbound-legacy')
})

test('failed durable import retains prepared claim for a later boot', async () => {
  const dir = await setup()
  const outbox = new RecoveryOutbox(dir, { epoch: 'first' })
  outbox.import = async () => {
    throw new Error('disk unavailable')
  }
  const errors: unknown[] = []
  await importBackgroundRecoveryNotices({
    inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'first' }),
    outbox,
    prepare: prepareBackgroundRecoveryNotice,
    onError: (error) => errors.push(error),
  })
  expect(errors).toHaveLength(1)
  expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toHaveLength(1)
  const next = new RecoveryOutbox(dir, { epoch: 'next' })
  await importBackgroundRecoveryNotices({
    inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'next' }),
    outbox: next,
    prepare: async () => {
      throw new Error('must reuse frozen preparation')
    },
    onError: (error) => {
      throw error
    },
  })
  expect(await next.list()).toHaveLength(1)
})

test('corrupt prepared coverage is retained and never imported to a different target', async () => {
  const dir = await setup()
  const first = new BackgroundHandoffInventory(dir, { processEpoch: 'first' })
  const claim = (await first.claim())[0]!
  await first.prepareRecovery(claim, await prepareBackgroundRecoveryNotice(claim))
  const source = JSON.parse(await readFile(claim.claimPath, 'utf8'))
  source.recoveryTransfer.record.target.chat = 'unauthorized-replacement'
  await writeFile(claim.claimPath, JSON.stringify(source))
  const errors: unknown[] = []
  const outbox = new RecoveryOutbox(dir, { epoch: 'second' })
  await importBackgroundRecoveryNotices({
    inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'second', onError: (error) => errors.push(error) }),
    outbox,
    prepare: prepareBackgroundRecoveryNotice,
    onError: (error) => errors.push(error),
  })
  expect(errors).toHaveLength(1)
  expect(await outbox.list()).toEqual([])
  expect(await readFile(claim.claimPath, 'utf8')).toBe(JSON.stringify(source))
})

test('ordinary channel restart greeting survives while lost-work directive stays out of model', async () => {
  const dir = await setup()
  await saveChannelSessions(dir, [{ ...key, sessionId: 'parent', participants: [] }])
  await writeRestartHandoff(dir, {
    schemaVersion: 2,
    restartedAt: new Date().toISOString(),
    originatingSessionId: 'parent',
    originatingSessionFile: 'missing.jsonl',
    origin: { kind: 'channel', key },
    interruptedSubagents: ['worker'],
  })
  let resumed = false
  let released = false
  await bootBackgroundHandoffs({
    agentDir: dir,
    inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'boot' }),
    recovery: { outbox: new RecoveryOutbox(dir, { epoch: 'boot' }), prepare: prepareBackgroundRecoveryNotice },
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

test('channel inventory import leaves an ordinary TUI handoff for reconnect', async () => {
  const dir = await setup()
  const handoff = {
    schemaVersion: 2 as const,
    restartedAt: new Date().toISOString(),
    originatingSessionId: 'tui-parent',
    originatingSessionFile: 'tui.jsonl',
    origin: { kind: 'tui' as const },
  }
  await writeRestartHandoff(dir, handoff)
  await bootBackgroundHandoffs({
    agentDir: dir,
    inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'boot' }),
    recovery: { outbox: new RecoveryOutbox(dir, { epoch: 'boot' }), prepare: prepareBackgroundRecoveryNotice },
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
