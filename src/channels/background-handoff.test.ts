import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { ClaimedBackgroundInventory } from './background-handoff'
import { BackgroundHandoffInventory } from './background-handoff'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'typeclaw-inventory-'))
  directories.push(directory)
  const errors: unknown[] = []
  const writer = new BackgroundHandoffInventory(directory, {
    processEpoch: 'writer',
    onError: (error) => errors.push(error),
  })
  const boot = new BackgroundHandoffInventory(directory, {
    processEpoch: 'boot',
    onError: (error) => errors.push(error),
  })
  const input = {
    parentSessionId: 'parent',
    parentSessionFile: '/sessions/parent.jsonl',
    key: { adapter: 'slack' as const, workspace: 'workspace', chat: 'chat', thread: 'thread' },
    taskId: 'first',
    subagentName: 'worker',
    startedAt: 1,
  }
  const pendingDirectory = join(directory, 'channels', 'background-handoffs')
  return { directory, writer, boot, input, pendingDirectory, errors }
}

async function pendingPath(directory: string): Promise<string> {
  const files = await readdir(directory)
  const file = files.find((file) => /^[a-f0-9]{64}\.json$/.test(file))
  if (!file) throw new Error('Expected pending inventory')
  return join(directory, file)
}
async function claimOne(inventory: BackgroundHandoffInventory): Promise<ClaimedBackgroundInventory> {
  const claims = await inventory.claim()
  expect(claims).toHaveLength(1)
  const claim = claims[0]
  if (!claim) throw new Error('Expected one owned inventory')
  return claim
}

describe('durable running-child inventory', () => {
  test('publishes complete sibling payload once and removes only terminal tasks', async () => {
    const { writer, boot, input } = await fixture()
    const first = await writer.add({
      ...input,
      triggeringAuthorId: 'first-author',
      triggerReactionRef: { adapter: 'slack', value: 'message-1' },
    })
    const duplicate = await writer.add({ ...input, subagentName: 'must-not-overwrite' })
    expect(duplicate).toEqual(first)
    await writer.add({ ...input, taskId: 'second', subagentName: 'other', triggeringAuthorId: 'latest-author' })
    await writer.remove(first)
    const claim = await claimOne(boot)
    expect(claim.record.parentSessionFile).toBe('parent.jsonl')
    expect(claim.record.triggeringAuthorId).toBe('latest-author')
    expect(claim.record.tasks).toEqual([{ taskId: 'second', subagentName: 'other', startedAt: 1 }])
    expect(await boot.claim()).toEqual([])
  })

  test('interleaved queued snapshots never resurrect removed work or lose later additions', async () => {
    const { writer, boot, input } = await fixture()
    const first = await writer.add(input)
    const secondPromise = writer.add({ ...input, taskId: 'second' })
    const removeFirst = writer.remove(first)
    const thirdPromise = writer.add({ ...input, taskId: 'third' })
    const second = await secondPromise
    const removeSecond = writer.remove(second)
    await Promise.all([removeFirst, thirdPromise, removeSecond, writer.flush()])
    const claim = await claimOne(boot)
    expect(claim.record.tasks.map((task) => task.taskId)).toEqual(['third'])
  })

  test('last removal unlinks and duplicate removal cannot create a pending file', async () => {
    const { writer, boot, input, pendingDirectory } = await fixture()
    const identity = await writer.add(input)
    await writer.remove(identity)
    await writer.remove(identity)
    expect(await readdir(pendingDirectory)).toEqual([])
    expect(await boot.claim()).toEqual([])
  })

  test('old generation and wrong epoch callbacks cannot remove a reused task ID', async () => {
    const { writer, boot, input } = await fixture()
    const old = await writer.add(input)
    await writer.remove(old)
    const fresh = await writer.add(input)
    expect(fresh.generationId).not.toBe(old.generationId)
    await writer.remove(old)
    await writer.remove({ ...fresh, processEpoch: 'wrong' })
    const claim = await claimOne(boot)
    expect(claim.record.tasks.map((task) => task.taskId)).toEqual([input.taskId])
    expect(claim.record.generationId).toBe(fresh.generationId)
  })

  test('claim-specific retirement and terminal callbacks preserve newly published generations', async () => {
    const { writer, boot, input } = await fixture()
    const old = await writer.add(input)
    const claim = await claimOne(boot)
    await writer.remove(old)
    expect(JSON.parse(await readFile(claim.claimPath, 'utf8')).tasks[0].taskId).toBe('first')
    const fresh = await writer.add({ ...input, taskId: 'fresh' })
    await writer.remove({ ...old, taskId: 'fresh' })
    await boot.retire(claim)
    await boot.retire(claim)
    const newClaim = await claimOne(boot)
    expect(newClaim.record.generationId).toBe(fresh.generationId)
    expect(newClaim.record.tasks.map((task) => task.taskId)).toEqual(['fresh'])
  })

  test('skips current process work and rejects mixing prior-epoch launches', async () => {
    const { writer, boot, input } = await fixture()
    await writer.add(input)
    expect(await writer.claim()).toEqual([])
    await expect(boot.add({ ...input, taskId: 'new' })).rejects.toThrow()
    const claim = await claimOne(boot)
    expect(claim.record.tasks.map((task) => task.taskId)).toEqual(['first'])
  })

  test('invalid transcript fails admission and failed queue operation does not block later work', async () => {
    const { writer, boot, input } = await fixture()
    await expect(writer.add({ ...input, parentSessionFile: `bad${String.fromCharCode(0)}.jsonl` })).rejects.toThrow()
    await expect(writer.add({ ...input, parentSessionFile: '.jsonl' })).rejects.toThrow()
    await writer.add(input)
    const claim = await claimOne(boot)
    expect(claim.record.tasks.map((task) => task.taskId)).toEqual(['first'])
  })

  test('malformed, mismatched hash, and traversal records are isolated from valid parents', async () => {
    const { writer, boot, input, pendingDirectory, errors } = await fixture()
    await writer.add(input)
    const path = await pendingPath(pendingDirectory)
    const valid = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(join(pendingDirectory, `${'a'.repeat(64)}.json`), JSON.stringify(valid))
    await writeFile(join(pendingDirectory, `${'b'.repeat(64)}.json`), '{broken')
    await writer.add({ ...input, parentSessionId: 'unsafe' })
    const paths = await readdir(pendingDirectory)
    for (const file of paths) {
      const candidate = join(pendingDirectory, file)
      if (candidate === path || file.startsWith('a'.repeat(64)) || file.startsWith('b'.repeat(64))) continue
      const record = JSON.parse(await readFile(candidate, 'utf8'))
      record.parentSessionFile = '../escape.jsonl'
      await writeFile(candidate, JSON.stringify(record))
    }
    const claims = await boot.claim()
    expect(claims.map((claim) => claim.record.parentSessionId)).toEqual(['parent'])
    expect(errors).toHaveLength(3)
  })

  test('sweeps only generated temps older than boot, preserving unrelated and fresh files', async () => {
    const { directory, writer, input, pendingDirectory } = await fixture()
    await writer.add(input)
    const path = await pendingPath(pendingDirectory)
    const old = `${path}.${randomUUID()}.tmp`
    const fresh = `${path}.${randomUUID()}.tmp`
    const unrelated = join(pendingDirectory, 'operator.tmp')
    const malformed = `${path}.not-a-uuid.tmp`
    await Promise.all([old, fresh, unrelated, malformed].map((file) => writeFile(file, 'temporary')))
    await utimes(old, 1, 1)
    await utimes(fresh, 2000000000, 2000000000)
    const boot = new BackgroundHandoffInventory(directory, { processEpoch: 'boot', now: () => 100000 })
    expect(await boot.claim()).toHaveLength(1)
    expect(await readdir(pendingDirectory)).toEqual(
      expect.arrayContaining(['operator.tmp', basename(fresh), basename(malformed)]),
    )
    await expect(readFile(old)).rejects.toThrow()
  })

  test('rejects retirement outside owned claim namespace', async () => {
    const { writer, boot, input, directory } = await fixture()
    await writer.add(input)
    const claim = await claimOne(boot)
    const protectedFile = join(directory, 'protected.json')
    await writeFile(protectedFile, 'keep')
    await expect(boot.retire({ ...claim, claimPath: protectedFile })).rejects.toThrow()
    expect(await readFile(protectedFile, 'utf8')).toBe('keep')
  })

  test('independent boot processes own all siblings once and old retirement preserves new work', async () => {
    const { directory, writer, input, pendingDirectory } = await fixture()
    await writer.add(input)
    await writer.add({ ...input, taskId: 'second' })
    const modulePath = import.meta.resolve('./background-handoff')
    const worker = join(directory, 'claim-worker.ts')
    await writeFile(
      worker,
      `import { BackgroundHandoffInventory } from ${JSON.stringify(modulePath)};
const inventory = new BackgroundHandoffInventory(process.argv[2], {processEpoch: process.argv[3]});
console.log(JSON.stringify(await inventory.claim()));`,
    )
    const processes = Array.from({ length: 6 }, (_, index) =>
      Bun.spawn([process.execPath, worker, directory, `boot-${index}`], { stdout: 'pipe', stderr: 'pipe' }),
    )
    const results = await Promise.all(
      processes.map(async (child) => {
        const output = await new Response(child.stdout).text()
        const error = await new Response(child.stderr).text()
        expect(await child.exited).toBe(0)
        expect(error).toBe('')
        return JSON.parse(output) as ClaimedBackgroundInventory[]
      }),
    )
    const claims = results.flat()
    expect(claims).toHaveLength(1)
    expect(claims[0]!.record.tasks.map((task) => task.taskId)).toEqual(['first', 'second'])
    const fresh = await writer.add({ ...input, taskId: 'fresh' })
    const retireWorker = join(directory, 'retire-worker.ts')
    await writeFile(
      retireWorker,
      `import { BackgroundHandoffInventory } from ${JSON.stringify(modulePath)};
await new BackgroundHandoffInventory(process.argv[2]).retire(JSON.parse(process.argv[3]));`,
    )
    const retire = Bun.spawn([process.execPath, retireWorker, directory, JSON.stringify(claims[0])], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await retire.exited).toBe(0)
    const record = JSON.parse(await readFile(await pendingPath(pendingDirectory), 'utf8'))
    expect(record.generationId).toBe(fresh.generationId)
    expect(record.tasks.map((task: { taskId: string }) => task.taskId)).toEqual(['fresh'])
  })

  test('published launch intent survives SIGKILL of its independent writer', async () => {
    const { directory, boot, input } = await fixture()
    const modulePath = import.meta.resolve('./background-handoff')
    const worker = join(directory, 'killed-writer.ts')
    await writeFile(
      worker,
      `import { BackgroundHandoffInventory } from ${JSON.stringify(modulePath)};
const writer = new BackgroundHandoffInventory(process.argv[2], {processEpoch: 'killed-writer'});
await writer.add(JSON.parse(process.argv[3]));
console.log('published');
await new Response(Bun.stdin.stream()).text();`,
    )
    const child = Bun.spawn([process.execPath, worker, directory, JSON.stringify(input)], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const reader = child.stdout.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value).trimEnd()).toBe('published')
      child.kill('SIGKILL')
      await child.exited
      const claim = await claimOne(boot)
      expect(claim.record.processEpoch).toBe('killed-writer')
      expect(claim.record.tasks.map((task) => task.taskId)).toEqual(['first'])
      expect(await boot.claim()).toEqual([])
    } finally {
      child.kill()
      reader.releaseLock()
    }
  })

  for (const scenario of ['updated-bytes', 'peer-retired', 'current-epoch'] as const) {
    test(`paused independent reader handles ${scenario} without stale ownership`, async () => {
      const { directory, writer, boot, input, pendingDirectory } = await fixture()
      const first = await writer.add(input)
      const modulePath = import.meta.resolve('./background-handoff')
      const worker = join(directory, 'paused-reader.ts')
      // Only pause the first read boundary. All bytes and rename ownership use real files.
      await writeFile(
        worker,
        `import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';
const realRead = fs.readFile;
let paused = false;
mock.module('node:fs/promises', () => ({ ...fs, readFile: async (...args) => {
  const bytes = await realRead(...args);
  if (!paused && String(args[0]).endsWith('.json')) {
    paused = true;
    console.log('ready');
    await new Response(Bun.stdin.stream()).text();
  }
  return bytes;
}}));
// Load after installing the read-boundary pause; a static import runs too early.
const { BackgroundHandoffInventory } = await import(${JSON.stringify(modulePath)});
const inventory = new BackgroundHandoffInventory(process.argv[2], {processEpoch: 'paused'});
console.log(JSON.stringify(await inventory.claim()));`,
      )
      const child = Bun.spawn([process.execPath, worker, directory], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      const reader = child.stdout.getReader()
      try {
        const ready = await reader.read()
        expect(new TextDecoder().decode(ready.value).trimEnd()).toBe('ready')
        if (scenario === 'updated-bytes') {
          await writer.add({ ...input, taskId: 'second' })
          await writer.remove(first)
        } else if (scenario === 'peer-retired') {
          const claim = await claimOne(boot)
          await boot.retire(claim)
        } else {
          const path = await pendingPath(pendingDirectory)
          const record = JSON.parse(await readFile(path, 'utf8'))
          await writeFile(path, JSON.stringify({ ...record, processEpoch: 'paused' }))
        }
        child.stdin.write('continue')
        child.stdin.end()
        let output = ''
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          output += new TextDecoder().decode(chunk.value)
        }
        expect(await child.exited).toBe(0)
        expect(await new Response(child.stderr).text()).toBe('')
        const claims = JSON.parse(output) as ClaimedBackgroundInventory[]
        if (scenario === 'updated-bytes') {
          expect(claims).toHaveLength(1)
          expect(claims[0]!.record.tasks.map((task) => task.taskId)).toEqual(['second'])
        } else {
          expect(claims).toEqual([])
          if (scenario === 'current-epoch') {
            const record = JSON.parse(await readFile(await pendingPath(pendingDirectory), 'utf8'))
            expect(record.processEpoch).toBe('paused')
          } else {
            await writer.add({ ...input, taskId: 'fresh' })
            const claim = await claimOne(boot)
            expect(claim.record.tasks.map((task) => task.taskId)).toEqual(['fresh'])
          }
        }
      } finally {
        child.kill()
        reader.releaseLock()
      }
    })
  }

  test('read and diagnostic failures do not strand unrelated parent claims', async () => {
    const { directory, writer, input, pendingDirectory } = await fixture()
    await writer.add(input)
    await mkdir(join(pendingDirectory, `${'a'.repeat(64)}.json`))
    const boot = new BackgroundHandoffInventory(directory, {
      onError: () => {
        throw new Error('logger unavailable')
      },
    })
    const claims = await boot.claim()
    expect(claims.map((claim) => claim.record.parentSessionId)).toEqual(['parent'])
  })
})
