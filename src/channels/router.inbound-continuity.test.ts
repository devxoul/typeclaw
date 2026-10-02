import { expect, test } from 'bun:test'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Type } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createSessionWithDispose } from '../agent'
import { reloadConfig } from '../config/config'
import { noopPermissionService } from '../permissions'
import { createStream } from '../stream'
import { BackgroundObligationStore } from './background-obligations'
import { InboundJournal } from './inbound-journal'
import { RecoveryDispatcher } from './recovery-dispatcher'
import { RecoveryOutbox } from './recovery-outbox'
import { createChannelRouter } from './router'
import { defaultHistoryConfig } from './schema'
import type { InboundMessage } from './types'

const event: InboundMessage = {
  adapter: 'discord-bot',
  workspace: 'guild',
  chat: 'room',
  thread: null,
  accountIdentity: 'proof-account',
  externalMessageId: 'A',
  eventKind: 'message',
  revision: '',
  authorId: 'alice',
  authorName: 'Alice',
  authorIsBot: false,
  isBotMention: true,
  isDm: false,
  mentionsOthers: false,
  replyToBotMessageId: null,
  replyToOtherMessageId: null,
  text: 'Please answer.',
  ts: 1000,
}

async function fixture(options: { failAdmission?: boolean; handoffRetryItemLimit?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-inbound-behavior-'))
  await writeFile(
    join(dir, 'typeclaw.json'),
    JSON.stringify({ models: { default: { model: 'anthropic/claude-sonnet-4-6' } } }),
  )
  reloadConfig(dir)
  const background = new BackgroundObligationStore(dir)
  const journal = new InboundJournal(dir, {
    backgroundObligations: background,
    epoch: background.epoch,
    onDurability: (phase, record) => {
      if (
        options.failAdmission &&
        phase === 'append-written' &&
        record &&
        typeof record === 'object' &&
        'type' in record &&
        record.type === 'admitted'
      )
        throw new Error('controlled admission durability failure')
    },
  })
  await journal.initialize()
  const outbox = new RecoveryOutbox(dir, { epoch: background.epoch })
  const counters = { prompts: 0, aborts: 0, reactions: 0, publications: 0, allowed: true }
  const stream = createStream()
  const unsubscribe = stream.subscribe({ target: { kind: 'broadcast' } }, (message) => {
    if (
      message.payload &&
      typeof message.payload === 'object' &&
      'kind' in message.payload &&
      message.payload.kind === 'channel-inbound'
    )
      counters.publications++
  })
  const manager = SessionManager.create(dir, join(dir, 'sessions'))
  const router = createChannelRouter({
    agentDir: dir,
    inboundJournal: journal,
    backgroundObligations: background,
    recoveryOutbox: outbox,
    handoffRetryItemLimit: options.handoffRetryItemLimit,
    stream,
    permissions: { ...noopPermissionService, has: () => counters.allowed },
    logger: { info() {}, warn() {}, error() {} },
    configForAdapter: () => ({
      enabled: true,
      engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }),
    createSessionForChannel: async ({ origin, originRef }) => {
      // Before any assistant entry, reload can reopen the same session identity
      // through the router's supplied factory without provider execution.
      const result = await createSessionWithDispose({
        sessionManager: manager,
        systemPromptOverride: 'Answer using channel tools.',
        tools: [],
        customTools: [],
        origin,
        originRef,
      })
      const prompt = result.session.prompt.bind(result.session)
      result.session.prompt = async (...args) => {
        counters.prompts++
        return prompt(...args)
      }
      const abort = result.session.abort.bind(result.session)
      result.session.abort = async () => {
        counters.aborts++
        return abort()
      }
      return { session: result.session, sessionId: result.session.sessionId, dispose: result.dispose }
    },
  })
  router.registerReaction(event.adapter, async (request) => {
    counters.reactions++
    return { ok: false, code: 'unsupported', error: request.emoji }
  })
  router.registerOutbound(event.adapter, async () => ({ ok: true }))
  const dispatcher = new RecoveryDispatcher(outbox, router, {
    backgroundObligations: background,
    inboundJournal: journal,
  })
  return {
    router,
    journal,
    outbox,
    counters,
    cleanup: async () => {
      unsubscribe()
      await dispatcher.stop()
      await router.stop()
      await journal.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('denied, observed and control receipts create no durable inbound obligations', async () => {
  const state = await fixture()
  try {
    state.counters.allowed = false
    expect(await state.router.route(event)).toEqual({ kind: 'denied' })
    expect(state.journal.list()).toEqual([])
    state.counters.allowed = true
    expect(
      await state.router.route({ ...event, externalMessageId: 'ambient', isBotMention: false, mentionsOthers: true }),
    ).toEqual({ kind: 'observed' })
    expect(state.journal.list()).toEqual([])
    expect(await state.router.route({ ...event, externalMessageId: 'control', text: '/not-a-command' })).toEqual({
      kind: 'control',
    })
    expect(state.journal.list()).toEqual([])
    expect(state.counters.prompts).toBe(0)
  } finally {
    await state.cleanup()
  }
})

test('admission durability failure rejects before publish, reaction and prompt; stop can still abort', async () => {
  const state = await fixture({ failAdmission: true })
  try {
    await expect(state.router.route({ ...event, reactionRef: { adapter: event.adapter, value: 'A' } })).rejects.toThrow(
      'controlled admission durability failure',
    )
    expect(state.counters.publications).toBe(0)
    expect(state.counters.reactions).toBe(0)
    expect(state.counters.prompts).toBe(0)
    expect(state.journal.health().available).toBe(false)
    expect(await state.router.route({ ...event, externalMessageId: 'stop', text: '/stop' })).toEqual({
      kind: 'control',
    })
    expect(state.counters.aborts).toBeGreaterThan(0)
    expect(state.counters.prompts).toBe(0)
  } finally {
    await state.cleanup()
  }
})

test('reload loss partitions multiple principals and stop suppresses every transferred notice without prompting', async () => {
  const state = await fixture({ handoffRetryItemLimit: 0 })
  try {
    const a = await state.router.route(event)
    const b = await state.router.route({ ...event, externalMessageId: 'B', authorId: 'bob', authorName: 'Bob' })
    expect(a.kind).toBe('accepted')
    expect(b.kind).toBe('accepted')
    await state.router.tearDownAllLive()
    const notices = await state.outbox.list()
    expect(
      notices
        .map((notice) => {
          if (notice.principal.kind !== 'channel') throw new Error('Expected channel notice principal')
          return notice.principal.lastInboundAuthorId
        })
        .sort(),
    ).toEqual(['alice', 'bob'])
    expect(notices.flatMap((notice) => notice.covers.map((cover) => cover.id)).sort()).toEqual(
      state.journal
        .list()
        .map((row) => row.inputId)
        .sort(),
    )
    expect(
      notices.every(
        (notice) =>
          notice.sourceParentSessionId &&
          notice.covers.every((cover) => cover.parentSessionId === notice.sourceParentSessionId),
      ),
    ).toBe(true)
    expect(
      await state.router.route({ ...event, externalMessageId: 'ambient', authorId: 'bob', isBotMention: false }),
    ).toEqual({ kind: 'observed' })
    expect(await state.router.route({ ...event, externalMessageId: 'stop', text: '/stop' })).toEqual({
      kind: 'control',
    })
    expect((await state.outbox.list()).map((notice) => notice.state)).toEqual(['suppressed', 'suppressed'])
    expect(state.journal.list()).toMatchObject([
      { phase: 'closed', outcome: { kind: 'intentionally-suppressed' } },
      { phase: 'closed', outcome: { kind: 'intentionally-suppressed' } },
    ])
    expect(state.counters.prompts).toBe(0)
  } finally {
    await state.cleanup()
  }
})

test('journal failure cancels an in-flight SDK turn before tools or follow-up provider requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-inbound-freeze-'))
  await writeFile(
    join(dir, 'typeclaw.json'),
    JSON.stringify({ models: { default: { model: 'anthropic/claude-sonnet-4-6' } } }),
  )
  reloadConfig(dir)
  const priorKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'freeze-proof'
  const priorFetch = globalThis.fetch
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let failAdmission = false
  let providers = 0
  let effects = 0
  const background = new BackgroundObligationStore(dir)
  const journal = new InboundJournal(dir, {
    backgroundObligations: background,
    onDurability: (phase, record) => {
      if (
        failAdmission &&
        phase === 'append-written' &&
        record &&
        typeof record === 'object' &&
        'type' in record &&
        record.type === 'admitted'
      )
        throw new Error('controlled in-flight durability failure')
    },
  })
  await journal.initialize()
  const router = createChannelRouter({
    agentDir: dir,
    inboundJournal: journal,
    backgroundObligations: background,
    permissions: { ...noopPermissionService, has: () => true },
    logger: { info() {}, warn() {}, error() {} },
    configForAdapter: () => ({
      enabled: true,
      engagement: { trigger: ['dm'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }),
    createSessionForChannel: async ({ origin, originRef }) => {
      const result = await createSessionWithDispose({
        sessionManager: SessionManager.create(dir, join(dir, 'sessions')),
        systemPromptOverride: 'Execute effect.',
        tools: ['effect'],
        origin,
        originRef,
        customTools: [
          {
            name: 'effect',
            label: 'effect',
            description: 'Write a file.',
            parameters: Type.Object({}),
            execute: async () => {
              effects++
              await writeFile(join(dir, 'side-effect'), 'executed')
              return { content: [{ type: 'text', text: 'done' }], details: {} }
            },
          },
        ],
      })
      return { session: result.session, sessionId: result.session.sessionId, dispose: result.dispose }
    },
  })
  router.registerRecoveryAdapter(event.adapter, {
    accountIdentity: async () => event.accountIdentity!,
    cachedAccountIdentity: () => event.accountIdentity!,
    reconcile: async () => ({ status: 'unreconcilable' }),
  })
  router.registerOutbound(event.adapter, async () => ({ ok: true }))
  globalThis.fetch = Object.assign(
    async () => {
      providers++
      entered.resolve()
      await release.promise
      return new Response(
        [
          'event: message_start',
          `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}`,
          '',
          'event: content_block_start',
          `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'effect', name: 'effect', input: {} } })}`,
          '',
          'event: content_block_delta',
          `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })}`,
          '',
          'event: content_block_stop',
          'data: {"type":"content_block_stop","index":0}',
          '',
          'event: message_delta',
          `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })}`,
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
    { preconnect: priorFetch.preconnect },
  )
  try {
    expect((await router.route({ ...event, isDm: true })).kind).toBe('accepted')
    const drain = router.__testing!.flushDebounce(event).catch(() => undefined)
    await entered.promise
    failAdmission = true
    await expect(router.route({ ...event, isDm: true, externalMessageId: 'B' })).rejects.toThrow(
      'controlled in-flight durability failure',
    )
    expect(journal.health().available).toBe(false)
    release.resolve()
    await drain
    expect(effects).toBe(0)
    expect(providers).toBe(1)
    await expect(access(join(dir, 'side-effect'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    release.resolve()
    globalThis.fetch = priorFetch
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = priorKey
    await router.stop()
    await journal.close()
    await rm(dir, { recursive: true, force: true })
  }
})
