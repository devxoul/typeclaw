import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { peekRestartHandoff, writeRestartHandoff, type RestartHandoff } from '@/agent/restart-handoff'
import { BackgroundHandoffInventory } from '@/channels/background-handoff'
import { saveChannelSessions } from '@/channels/persistence'
import { type ChannelKey, channelKeyId } from '@/channels/types'

import { bootBackgroundHandoffs } from './background-handoff-boot'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const key: ChannelKey = { adapter: 'discord-bot', workspace: 'w', chat: 'c', thread: 't' }
async function setup(keys = [key]) {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-boot-inventory-'))
  dirs.push(dir)
  const old = new BackgroundHandoffInventory(dir, { processEpoch: 'old' })
  for (const [i, k] of keys.entries()) {
    await old.add({
      parentSessionId: `parent-${i}`,
      parentSessionFile: `parent-${i}.jsonl`,
      key: k,
      triggeringAuthorId: 'launch-author',
      taskId: `task-${i}`,
      subagentName: `worker-${i}`,
      startedAt: 1,
      triggerReactionRef: { adapter: k.adapter, value: 'message-target-not-reaction-instance' },
    })
  }
  await saveChannelSessions(
    dir,
    keys.map((k, i) => ({
      ...k,
      sessionId: `parent-${i}`,
      sessionFile: `parent-${i}.jsonl`,
      participants: [],
      lastInboundAt: Date.now(),
    })),
  )
  return { dir, old, inventory: new BackgroundHandoffInventory(dir, { processEpoch: 'new' }) }
}

test('merges accepted restart before one reservation; old inventory survives age and retires before wake', async () => {
  const { dir, old, inventory } = await setup()
  await old.add({
    parentSessionId: 'parent-0',
    parentSessionFile: 'parent-0.jsonl',
    key,
    taskId: 'sibling',
    subagentName: 'worker-0',
    startedAt: 2,
  })
  await writeRestartHandoff(dir, {
    schemaVersion: 2,
    restartedAt: new Date().toISOString(),
    originatingSessionId: 'parent-0',
    originatingSessionFile: 'parent-0.jsonl',
    origin: { kind: 'channel', key },
    triggeringAuthorId: 'explicit-author',
  })
  const seen: RestartHandoff[] = []
  const events: string[] = []
  let removals = 0
  const router = {
    removeReaction: async () => {
      removals++
    },
    reserveRestartHandoff: (handoff: RestartHandoff) => {
      seen.push(handoff)
      events.push('reserve')
      return {
        keyId: channelKeyId(key),
        sawInbound: false,
        release: () => {
          events.push('release')
        },
        resume: async () => {
          expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toEqual([])
          events.push('wake')
        },
      }
    },
  }
  await bootBackgroundHandoffs({
    agentDir: dir,
    inventory,
    router,
    configured: () => true,
    startAdapters: async () => {
      events.push('start')
    },
    onError: (error) => {
      throw error
    },
  })
  expect(seen.map((h) => [h.triggeringAuthorId, h.interruptedSubagents])).toEqual([['explicit-author', ['worker-0']]])
  expect(events.slice(0, 3)).toEqual(['reserve', 'start', 'wake'])
  expect(removals).toBe(0)
  seen.length = 0
  await bootBackgroundHandoffs({
    agentDir: dir,
    inventory,
    router,
    configured: () => true,
    startAdapters: async () => {},
    onError: () => {},
  })
  expect(seen).toEqual([])
})

test('mapping replacement and unconfigured adapters retire without waking; other threads recover', async () => {
  const keys = [key, { ...key, thread: 'replacement' }, { ...key, thread: 'disabled' }]
  const { dir, inventory } = await setup(keys)
  await saveChannelSessions(
    dir,
    keys.map((k, i) => ({ ...k, sessionId: i === 1 ? 'successor' : `parent-${i}`, participants: [] })),
  )
  const wakes: string[] = []
  await bootBackgroundHandoffs({
    agentDir: dir,
    inventory,
    configured: (k) => k.thread !== 'disabled',
    startAdapters: async () => {},
    onError: () => {},
    router: {
      reserveRestartHandoff: (h) => ({
        keyId: channelKeyId(key),
        sawInbound: false,
        release: () => {},
        resume: async () => {
          wakes.push(h.originatingSessionId)
        },
      }),
    },
  })
  expect(wakes).toEqual(['parent-0'])
  expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toEqual([])
})

test('adapter startup failure releases every blocked reservation and never wakes', async () => {
  const keys = [key, { ...key, thread: 'second' }]
  const { dir, inventory } = await setup(keys)
  const blocked: Promise<string>[] = []
  const released: string[] = []
  let wakes = 0
  await expect(
    bootBackgroundHandoffs({
      agentDir: dir,
      inventory,
      configured: () => true,
      onError: () => {},
      startAdapters: async () => {
        throw new Error('adapter failed')
      },
      router: {
        reserveRestartHandoff: (h) => {
          const { promise, resolve } = Promise.withResolvers<string>()
          blocked.push(
            promise.then((parent) => {
              released.push(parent)
              return parent
            }),
          )
          return {
            keyId: channelKeyId(key),
            sawInbound: false,
            release: () => resolve(h.originatingSessionId),
            resume: async () => {
              wakes++
            },
          }
        },
      },
    }),
  ).rejects.toThrow('adapter failed')
  expect(released.sort()).toEqual(['parent-0', 'parent-1'])
  expect((await Promise.all(blocked)).sort()).toEqual(['parent-0', 'parent-1'])
  expect(wakes).toBe(0)
})

test('reserve, retirement and resume errors are isolated and release surviving gates', async () => {
  const keys = [key, { ...key, thread: 'second' }, { ...key, thread: 'third' }]
  const { dir, inventory } = await setup(keys)
  const errors: unknown[] = []
  const retire = inventory.retire.bind(inventory)
  inventory.retire = async (claim) => {
    if (claim.record.parentSessionId === 'parent-1') throw new Error('retire failed')
    await retire(claim)
  }
  const events: string[] = []
  await bootBackgroundHandoffs({
    agentDir: dir,
    inventory,
    configured: () => true,
    onError: (e) => {
      errors.push(e)
    },
    startAdapters: async () => {},
    router: {
      reserveRestartHandoff: (h) => {
        if (h.originatingSessionId === 'parent-0') throw new Error('reserve failed')
        return {
          keyId: channelKeyId(key),
          sawInbound: false,
          release: () => {
            events.push(`release:${h.originatingSessionId}`)
          },
          resume: async () => {
            if (h.originatingSessionId === 'parent-1') throw new Error('resume failed')
            events.push(`wake:${h.originatingSessionId}`)
          },
        }
      },
    },
  })
  expect(errors.map(String).sort()).toEqual(
    ['Error: reserve failed', 'Error: retire failed', 'Error: resume failed'].sort(),
  )
  expect(events).toContain('release:parent-1')
  expect(events).toContain('release:parent-2')
  expect(events).toContain('wake:parent-2')
})

test.each(['different-parent', 'expired', 'tui'] as const)(
  'ordinary %s handoff never suppresses valid inventory recovery',
  async (kind) => {
    const { dir, inventory } = await setup()
    await writeRestartHandoff(dir, {
      schemaVersion: 2,
      restartedAt: new Date(kind === 'expired' ? 0 : Date.now()).toISOString(),
      originatingSessionId: 'other-parent',
      originatingSessionFile: 'other-parent.jsonl',
      origin: kind === 'tui' ? { kind: 'tui' } : { kind: 'channel', key },
      triggeringAuthorId: 'other-author',
    })
    const wakes: RestartHandoff[] = []
    await bootBackgroundHandoffs({
      agentDir: dir,
      inventory,
      configured: () => true,
      startAdapters: async () => {},
      onError: () => {},
      router: {
        reserveRestartHandoff: (handoff) => ({
          keyId: channelKeyId(key),
          sawInbound: false,
          release: () => {},
          resume: async () => {
            wakes.push(handoff)
          },
        }),
      },
    })
    expect(
      wakes.map((handoff) => [handoff.originatingSessionId, handoff.triggeringAuthorId, handoff.interruptedSubagents]),
    ).toEqual([['parent-0', 'launch-author', ['worker-0']]])
    if (kind === 'tui') expect((await peekRestartHandoff(dir))?.origin).toEqual({ kind: 'tui' })
  },
)
