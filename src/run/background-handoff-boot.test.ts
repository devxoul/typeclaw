import { afterEach, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { peekRestartHandoff, writeRestartHandoff } from '@/agent/restart-handoff'
import { LegacyBackgroundHandoffReader } from '@/channels/background-handoff'
import { createLegacyRecoveryNotice } from '@/channels/background-handoff'
import { BackgroundObligationStore } from '@/channels/background-obligations'
import { saveChannelSessions } from '@/channels/persistence'
import { RecoveryOutbox } from '@/channels/recovery-outbox'
import { channelKeyId } from '@/channels/types'

import { bootBackgroundObligations, bootChannelRestartGreeting } from './background-handoff-boot'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const key = { adapter: 'discord-bot' as const, workspace: 'w', chat: 'c', thread: 't' }
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'obligation-migration-'))
  dirs.push(dir)
  const directory = join(dir, 'channels/background-handoffs')
  await mkdir(directory, { recursive: true })
  const id = createHash('sha256')
    .update(JSON.stringify([channelKeyId(key), 'parent']))
    .digest('hex')
  const record = {
    schemaVersion: 1 as const,
    generationId: randomUUID(),
    processEpoch: 'dead',
    parentSessionId: 'parent',
    key,
    parentChat: 'parent-room',
    triggeringAuthorId: 'author',
    tasks: [{ taskId: 'task', subagentName: 'worker', startedAt: 1, accountIdentity: 'actor' }],
  }
  await writeFile(join(directory, `${id}.json`), JSON.stringify(record))
  return { dir, record }
}

for (const field of ['kind', 'adapter', 'workspace', 'chat', 'parentChat', 'lastInboundAuthorId'] as const) {
  test(`legacy migration freezes principal ${field} through preparation and reboot`, async () => {
    const { dir, record } = await setup()
    const reader = new LegacyBackgroundHandoffReader(dir, { processEpoch: 'first' })
    const claim = (await reader.claim())[0]!
    const notice = createLegacyRecoveryNotice(record)
    const changed = {
      ...notice,
      principal: {
        ...notice.principal,
        [field]: field === 'kind' ? 'tui' : field === 'adapter' ? 'slack-bot' : 'OTHER',
      },
    } as typeof notice
    await expect(reader.prepareRecovery(claim, changed)).rejects.toThrow()
    const prepared = await reader.prepareRecovery(claim, notice)
    await expect(reader.prepareRecovery(claim, changed)).rejects.toThrow()
    const outbox = new RecoveryOutbox(dir, { epoch: 'next' })
    const obligations = new BackgroundObligationStore(dir, { epoch: 'next' })
    await bootBackgroundObligations({
      obligations,
      outbox,
      inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'next' }),
    })
    expect(await outbox.list()).toEqual([prepared])
    expect((await obligations.list())[0]!.principal).toEqual({
      kind: 'channel',
      adapter: key.adapter,
      workspace: key.workspace,
      chat: key.chat,
      parentChat: 'parent-room',
      lastInboundAuthorId: 'author',
    })
  })
}

for (const boundary of ['source-prepared', 'json-prepared', 'imported', 'json-owned', 'retired']) {
  test(`migration death ${boundary} preserves original transfer and JSON authority over two boots`, async () => {
    const { dir, record } = await setup()
    const expected = createLegacyRecoveryNotice(record)
    const worker = join(dir, 'worker.ts')
    const readerModule = new URL('../channels/background-handoff.ts', import.meta.url).href
    const storeModule = new URL('../channels/background-obligations.ts', import.meta.url).href
    const outboxModule = new URL('../channels/recovery-outbox.ts', import.meta.url).href
    await writeFile(
      worker,
      `
import {LegacyBackgroundHandoffReader} from ${JSON.stringify(readerModule)};
import {BackgroundObligationStore} from ${JSON.stringify(storeModule)};
import {RecoveryOutbox} from ${JSON.stringify(outboxModule)};
const dir=process.argv[2],boundary=process.argv[3],pause=async(point)=>{console.log(JSON.stringify({boundary:point}));await Bun.stdin.text();throw Error('crash boundary resumed without termination');};
const reader=new LegacyBackgroundHandoffReader(dir,{processEpoch:'first'});
const store=new BackgroundObligationStore(dir,{epoch:'first',onDurability:async(phase,row)=>{if(phase==='directory-synced'&&((boundary==='json-prepared'&&row.phase==='notice-prepared')||(boundary==='json-owned'&&row.phase==='notice-owned')))await pause(boundary);}});
const outbox=new RecoveryOutbox(dir,{epoch:'first'});
const prepare=reader.prepareRecovery.bind(reader);reader.prepareRecovery=async(...args)=>{const result=await prepare(...args);if(boundary==='source-prepared')await pause('source-prepared');return result;};
const imported=outbox.import.bind(outbox);outbox.import=async(record)=>{const result=await imported(record);if(boundary==='imported')await pause('imported');return result;};
const retire=reader.retire.bind(reader);reader.retire=async(...args)=>{await retire(...args);if(boundary==='retired')await pause('retired');};
await store.migrateLegacy(reader,outbox);throw Error('crash boundary not reached');`,
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
      expect(await new Response(child.stderr).text()).toBe('')
      // Windows TerminateProcess does not expose POSIX signal metadata.
      if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
    } finally {
      child.kill('SIGKILL')
      await child.exited
      reader.releaseLock()
    }
    const obligations = new BackgroundObligationStore(dir, { epoch: 'second' })
    const outbox = new RecoveryOutbox(dir, { epoch: 'second' })
    await bootBackgroundObligations({
      obligations,
      outbox,
      inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'second' }),
    })
    expect((await outbox.list()).map((row) => row.deliveryId)).toEqual([expected.deliveryId])
    const rows = await obligations.list()
    expect(rows.map((row) => [row.taskId, row.phase, row.legacyCoverage?.id])).toEqual([
      ['task', 'notice-owned', expected.covers[0]!.id],
    ])
    await bootBackgroundObligations({
      obligations: new BackgroundObligationStore(dir, { epoch: 'third' }),
      outbox,
      inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'third' }),
    })
    expect((await obligations.list()).map((row) => row.obligationId)).toEqual([rows[0]!.obligationId])
    expect((await outbox.list()).map((row) => row.deliveryId)).toEqual([expected.deliveryId])
    expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toEqual([])
  })
}

test('failed durable import retains JSON and legacy source for a later boot', async () => {
  const { dir } = await setup()
  const outbox = new RecoveryOutbox(dir, { epoch: 'first' })
  outbox.import = async () => {
    throw new Error('disk unavailable')
  }
  const obligations = new BackgroundObligationStore(dir, { epoch: 'first' })
  await expect(
    bootBackgroundObligations({
      obligations,
      outbox,
      inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'first' }),
    }),
  ).rejects.toThrow('disk unavailable')
  expect((await obligations.list()).map((row) => row.phase)).toEqual(['notice-prepared'])
  expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toHaveLength(1)
  const next = new RecoveryOutbox(dir, { epoch: 'second' })
  await bootBackgroundObligations({
    obligations: new BackgroundObligationStore(dir, { epoch: 'second' }),
    outbox: next,
    inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'second' }),
  })
  expect((await obligations.list()).map((row) => row.phase)).toEqual(['notice-owned'])
  expect((await next.list()).map((row) => row.deliveryId)).toEqual([
    (await obligations.list())[0]!.transfer!.deliveryId,
  ])
})

test('changed mapping and disabled adapter do not redirect or discard migrated work', async () => {
  const { dir } = await setup()
  await saveChannelSessions(dir, [{ ...key, sessionId: 'different', participants: [] }])
  const obligations = new BackgroundObligationStore(dir, { epoch: 'boot' })
  const outbox = new RecoveryOutbox(dir, { epoch: 'boot' })
  await bootBackgroundObligations({
    obligations,
    outbox,
    inventory: new LegacyBackgroundHandoffReader(dir, { processEpoch: 'boot' }),
  })
  expect((await outbox.list()).map((row) => row.target)).toEqual([key])
  expect((await obligations.list()).map((row) => row.parentSessionId)).toEqual(['parent'])
})

test('corrupt prepared coverage retains original legacy bytes without a send intent', async () => {
  const { dir } = await setup()
  const reader = new LegacyBackgroundHandoffReader(dir, { processEpoch: 'first' })
  const claim = (await reader.claim())[0]!
  await reader.prepareRecovery(claim, createLegacyRecoveryNotice(claim.record))
  const source = JSON.parse(await readFile(claim.claimPath, 'utf8'))
  source.recoveryTransfer.record.covers[0].id = '0'.repeat(64)
  const bytes = JSON.stringify(source)
  await writeFile(claim.claimPath, bytes)
  const errors: unknown[] = []
  const outbox = new RecoveryOutbox(dir, { epoch: 'second' })
  await bootBackgroundObligations({
    obligations: new BackgroundObligationStore(dir, { epoch: 'second' }),
    outbox,
    inventory: new LegacyBackgroundHandoffReader(dir, {
      processEpoch: 'second',
      onError: (error) => errors.push(error),
    }),
  })
  expect(await readFile(claim.claimPath, 'utf8')).toBe(bytes)
  expect(await outbox.list()).toEqual([])
})

test('ordinary channel restart greeting survives without a lost-work model directive', async () => {
  const { dir } = await setup()
  await saveChannelSessions(dir, [{ ...key, sessionId: 'parent', participants: [] }])
  await writeRestartHandoff(dir, {
    schemaVersion: 2,
    restartedAt: new Date().toISOString(),
    originatingSessionId: 'parent',
    originatingSessionFile: 'missing.jsonl',
    origin: { kind: 'channel', key },
    interruptedSubagents: ['worker'],
  })
  let resumed = false,
    released = false
  await bootChannelRestartGreeting({
    agentDir: dir,
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

test('channel restart greeting leaves an ordinary TUI handoff for reconnect', async () => {
  const { dir } = await setup()
  const handoff = {
    schemaVersion: 2 as const,
    restartedAt: new Date().toISOString(),
    originatingSessionId: 'tui-parent',
    originatingSessionFile: 'tui.jsonl',
    origin: { kind: 'tui' as const },
  }
  await writeRestartHandoff(dir, handoff)
  await bootChannelRestartGreeting({
    agentDir: dir,
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
