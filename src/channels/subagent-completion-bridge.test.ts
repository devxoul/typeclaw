import { expect, test } from 'bun:test'

import { createStream } from '@/stream'

import { createSubagentCompletionBridge } from './subagent-completion-bridge'

const completion = {
  kind: 'subagent.completed' as const,
  taskId: 'task',
  subagent: 'explorer',
  parentSessionId: 'parent',
  ok: true,
  durationMs: 100,
}

test('failed durable completion admission is contained and does not retry the child', async () => {
  const stream = createStream()
  const warned = Promise.withResolvers<string>()
  let admissions = 0
  const bridge = createSubagentCompletionBridge({
    stream,
    router: {
      injectSubagentCompletionReminder: async () => {
        admissions++
        throw new Error('disk unavailable')
      },
    },
    logger: { info: () => {}, warn: warned.resolve },
  })
  stream.publish({ target: { kind: 'broadcast' }, payload: completion })
  expect(await warned.promise).toContain('response remains owed')
  expect(admissions).toBe(1)
  bridge.stop()
})

test('absent-parent diagnostic waits for durable admission', async () => {
  const stream = createStream()
  const admission = Promise.withResolvers<void>()
  const warned = Promise.withResolvers<string>()
  const warnings: string[] = []
  const bridge = createSubagentCompletionBridge({
    stream,
    router: {
      injectSubagentCompletionReminder: async () => {
        await admission.promise
        return { kind: 'no-live-session' }
      },
    },
    logger: {
      info: () => {},
      warn: (message) => {
        warnings.push(message)
        warned.resolve(message)
      },
    },
  })
  stream.publish({ target: { kind: 'broadcast' }, payload: completion })
  await Promise.resolve()
  expect(warnings).toEqual([])
  admission.resolve()
  expect(await warned.promise).toContain('no live session')
  bridge.stop()
})
