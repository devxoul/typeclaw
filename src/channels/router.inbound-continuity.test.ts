import { expect, test } from 'bun:test'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AfterToolCallContext, AfterToolCallResult, StreamFn } from '@earendil-works/pi-agent-core'
import { normalizeContext, Type, type AssistantMessage } from '@earendil-works/pi-ai'
import { SessionManager, type ExtensionToolContext, type SessionEntry } from '@earendil-works/pi-coding-agent'

import { createSessionWithDispose, type AgentSession } from '../agent'
import { createChannelSendTool, type ChannelSendOrigin } from '../agent/tools/channel-send'
import { reloadConfig } from '../config/config'
import { noopPermissionService } from '../permissions'
import { createStream } from '../stream'
import { BackgroundObligationStore } from './background-obligations'
import { InboundJournal } from './inbound-journal'
import { RecoveryDispatcher } from './recovery-dispatcher'
import { RecoveryOutbox } from './recovery-outbox'
import { createChannelRouter } from './router'
import { defaultHistoryConfig } from './schema'
import type { ChannelKey, InboundMessage, OutboundCallback } from './types'

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

// Router-owned delivery debt: origin channel_send receipts, completion carriers
// and reload handoffs. The router, journal, background store, outbox and the
// channel_send tool are real; only the model session and the transport are
// controlled, so every assertion reads durable journal/outbox state.

const THREAD_KEY: ChannelKey = { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' }
const GITHUB_THREAD_KEY: ChannelKey = { adapter: 'github', workspace: 'acme/repo', chat: 'pr:7', thread: '101' }
const FAILING_TEXT = 'This post is rejected by the transport.'

function assistantMessage(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test-model',
    stopReason,
    timestamp: 1000,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

// Controlled model-session boundary: the router installs its real after-tool
// hook and output cap on `agent`; `providerRequests` counts stream calls that
// reach the provider through them.
class ParentSession {
  prompts: string[] = []
  providerRequests = 0
  leaf: SessionEntry | undefined
  onPrompt: (text: string) => Promise<void> = async () => {
    this.finish('NO_REPLY')
  }
  agent = {
    controller: new AbortController(),
    get signal() {
      return this.controller.signal
    },
    state: { messages: [] as Array<{ role: string; stopReason?: string }> },
    abort() {
      this.controller.abort()
    },
    continue: async () => {},
    streamFunction: (async () => {
      this.providerRequests++
    }) as unknown as StreamFn,
    afterToolCall: undefined as undefined | ((ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>),
  }
  sessionManager = {
    getLeafEntry: () => this.leaf,
    getEntry: () => this.leaf,
    getBranch: () => (this.leaf ? [this.leaf] : []),
    appendMessage: () => 'appended',
  }
  prompt = async (text: string) => {
    this.prompts.push(text)
    this.agent.controller = new AbortController()
    await this.onPrompt(text)
  }
  abort = async () => {
    this.agent.abort()
  }
  refreshContext = () => {}
  dispose = () => {}
  setThinkingLevel = () => {}
  subscribe = () => () => {}
  finish(text: string, stopReason: AssistantMessage['stopReason'] = 'stop') {
    this.leaf = {
      type: 'message',
      id: 'leaf',
      parentId: null,
      timestamp: new Date(1000).toISOString(),
      message: assistantMessage(text, stopReason),
    }
  }
}

type SendParams = {
  text?: string
  adapter?: ChannelKey['adapter']
  workspace?: string
  chat?: string
  // null posts at the channel root; omitted keeps the conversation's thread.
  thread?: string | null
  resolve_review_thread?: boolean
  attachments?: Array<{ path: string }>
}

async function debtFixture(
  options: {
    key?: ChannelKey
    handoffRetryItemLimit?: number
    handoffRetryByteLimit?: number
    handoffRetryRetentionMs?: number
    failCreationAttempts?: readonly number[]
  } = {},
) {
  const key = options.key ?? THREAD_KEY
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-router-debt-'))
  const store = new BackgroundObligationStore(dir)
  const journal = new InboundJournal(dir, { backgroundObligations: store, epoch: store.epoch })
  await journal.initialize()
  const outbox = new RecoveryOutbox(dir, { epoch: store.epoch })
  const sessions: ParentSession[] = []
  // `existingSessionId` per factory call: undefined is a cold start, an id is a rehydrated successor.
  const creations: Array<string | undefined> = []
  const sent: string[] = []
  const running = new Map<string, number>()
  const logs: string[] = []
  const state: {
    now: number
    account: string
    messages: number
    closed: boolean
    held?: { text: string; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    // Lets a test script a successor's model behavior before the router prompts it.
    onSessionCreated?: (session: ParentSession) => void
    // Rehydrations come back under this session ID instead of the requested one.
    successorSessionId?: string
  } = { now: 1000, account: 'account-a', messages: 0, closed: false }
  const router = createChannelRouter({
    agentDir: dir,
    backgroundObligations: store,
    inboundJournal: journal,
    recoveryOutbox: outbox,
    ...(options.handoffRetryItemLimit !== undefined ? { handoffRetryItemLimit: options.handoffRetryItemLimit } : {}),
    ...(options.handoffRetryByteLimit !== undefined ? { handoffRetryByteLimit: options.handoffRetryByteLimit } : {}),
    ...(options.handoffRetryRetentionMs !== undefined
      ? { handoffRetryRetentionMs: options.handoffRetryRetentionMs }
      : {}),
    now: () => state.now,
    newestRunningChildSubagentStartedAt: (sessionId) => running.get(sessionId) ?? null,
    configForAdapter: () => ({
      enabled: true,
      history: defaultHistoryConfig(),
      engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: 'off' },
    }),
    permissions: { ...noopPermissionService, has: () => true },
    logger: { info() {}, warn() {}, error: (message) => logs.push(message) },
    createSessionForChannel: async ({ existingSessionId }) => {
      creations.push(existingSessionId)
      if (options.failCreationAttempts?.includes(creations.length)) {
        throw new Error(`controlled session creation failure ${creations.length}`)
      }
      const session = new ParentSession()
      sessions.push(session)
      state.onSessionCreated?.(session)
      return {
        // The controlled boundary implements the session surface the router touches.
        session: session as unknown as AgentSession,
        sessionId:
          existingSessionId === undefined
            ? `parent-${sessions.length}`
            : (state.successorSessionId ?? existingSessionId),
        dispose: async () => {},
      }
    },
  })
  const outbound: OutboundCallback = async (message) => {
    const held = state.held
    if (held !== undefined && held.text === message.text) {
      held.entered.resolve()
      await held.release.promise
    }
    if (message.text === FAILING_TEXT) return { ok: false, error: 'controlled transport failure' }
    sent.push(message.text ?? `[attachments: ${(message.attachments ?? []).map((file) => file.path).join(', ')}]`)
    return { ok: true }
  }
  router.registerOutbound(key.adapter, outbound)
  if (key.adapter !== 'discord-bot') router.registerOutbound('discord-bot', outbound)
  router.registerRecoveryAdapter(key.adapter, {
    accountIdentity: async () => state.account,
    cachedAccountIdentity: () => state.account,
    reconcile: async () => ({ status: 'unreconcilable' }),
  })
  const inbound = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
    ...key,
    text,
    externalMessageId: `m-${++state.messages}`,
    accountIdentity: state.account,
    authorId: 'human',
    authorName: 'Human',
    authorIsBot: false,
    isBotMention: true,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts: state.now,
    ...over,
  })
  const route = async (text: string): Promise<string> => {
    const event = inbound(text)
    await router.route(event)
    return event.externalMessageId
  }
  const flush = () => router.__testing!.flushDebounce(key)
  const afterTool = async (
    session: ParentSession,
    name: string,
    args: Record<string, unknown>,
    result: AfterToolCallContext['result'],
  ) => {
    await session.agent.afterToolCall!({
      assistantMessage: assistantMessage(''),
      toolCall: { type: 'toolCall', id: `${name}-call`, name, arguments: args },
      args,
      result,
      isError: false,
      context: { messages: [] },
    } as AfterToolCallContext)
  }
  // Opens the conversation; the session is `parent-1`.
  await route('open the conversation')
  await flush()
  const debt = {
    dir,
    key,
    store,
    journal,
    outbox,
    router,
    sessions,
    creations,
    sent,
    running,
    state,
    logs,
    inbound,
    route,
    flush,
    inputRow: (messageId: string) => journal.list().find((row) => row.reference?.messageId === messageId),
    childRow: async (taskId: string) => (await store.list()).find((row) => row.taskId === taskId),
    // Real channel_send tool from the `parent-1` session, followed by the router's after-tool hook as agent-core runs it.
    channelSend: async (session: ParentSession, params: SendParams, origin: ChannelSendOrigin | null = { ...key }) => {
      const tool = createChannelSendTool({
        router,
        ...(origin !== null ? { origin } : {}),
        sessionId: 'parent-1',
        logger: { warn() {} },
      })
      const thread = params.thread === undefined ? key.thread : params.thread
      const args = {
        adapter: params.adapter ?? key.adapter,
        workspace: params.workspace ?? key.workspace,
        chat: params.chat ?? key.chat,
        ...(thread !== null ? { thread } : {}),
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.resolve_review_thread !== undefined ? { resolve_review_thread: params.resolve_review_thread } : {}),
        ...(params.attachments !== undefined ? { attachments: params.attachments } : {}),
      }
      // The tool never reads its extension context.
      const result = await tool.execute('send-call', args, undefined, undefined, {} as ExtensionToolContext)
      await afterTool(session, 'channel_send', args, result)
      return result
    },
    // channel_reply's capture/send/hook protocol from the given session.
    reply: async (session: ParentSession, text: string, sessionId = 'parent-1') => {
      const backgroundCoverage = await router.captureBackgroundResultCoverage!(sessionId)
      const inboundCoverage = await router.captureInboundResultCoverage!(sessionId)
      expect((await router.send({ ...key, text })).ok).toBe(true)
      await afterTool(
        session,
        'channel_reply',
        { text },
        { content: [], details: { ok: true, backgroundCoverage, inboundCoverage } },
      )
      session.finish(text, 'aborted')
    },
    accept: (taskId: string, parentSessionId = 'parent-1') =>
      router.acceptBackgroundResponse({
        parentSessionId,
        key,
        taskId,
        subagentName: 'explorer',
        startedAt: state.now,
        accountIdentity: state.account,
        triggeringAuthorId: 'human',
      }),
    complete: (taskId: string, parentSessionId = 'parent-1') =>
      router.injectSubagentCompletionReminder({
        parentSessionId,
        channelKey: key,
        taskId,
        subagent: 'explorer',
        ok: true,
        durationMs: 20,
      }),
    // The model spawns a background child for this request and ends its turn waiting on it.
    deferToChild: (session: ParentSession, taskId: string, during?: () => Promise<void>) => {
      session.onPrompt = async () => {
        await router.acceptBackgroundResponse({
          parentSessionId: 'parent-1',
          key,
          taskId,
          subagentName: 'explorer',
          startedAt: state.now,
          accountIdentity: state.account,
          triggeringAuthorId: 'human',
        })
        running.set('parent-1', state.now)
        await during?.()
        session.finish('NO_REPLY')
      }
    },
    hold: (text: string) => {
      const held = { text, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      state.held = held
      return held
    },
    reboot: async (): Promise<number> => {
      await router.stop()
      await journal.close()
      state.closed = true
      const bootStore = new BackgroundObligationStore(dir, { epoch: 'reboot' })
      const bootJournal = new InboundJournal(dir, { backgroundObligations: bootStore, epoch: bootStore.epoch })
      const bootOutbox = new RecoveryOutbox(dir, { epoch: bootStore.epoch })
      try {
        await bootJournal.initialize()
        await bootJournal.importOldEpoch(bootOutbox)
        await bootStore.importOldEpoch(bootOutbox)
        return (await bootOutbox.list()).length
      } finally {
        await bootJournal.close()
      }
    },
    cleanup: async () => {
      if (!state.closed) {
        await router.stop()
        await journal.close()
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
  return {
    ...debt,
    // The deferring turn consumes child-a's completion, starts child-b and waits on it. With a
    // request, that request first defers to child-a; without one, child-a carries no inbound debt.
    consumeThenDefer: async (request?: string, during?: () => Promise<void>) => {
      const parent = sessions[0]!
      let messageId: string | undefined
      if (request === undefined) {
        await debt.accept('child-a')
      } else {
        debt.deferToChild(parent, 'child-a')
        messageId = await route(request)
        await flush()
        running.delete('parent-1')
      }
      state.now += 10
      debt.deferToChild(parent, 'child-b', during)
      await debt.complete('child-a')
      await flush()
      return messageId
    },
  }
}

test('an exact-origin channel_send closes its captured inbound and fetched child while the turn keeps running', async () => {
  const f = await debtFixture()
  try {
    const parent = f.sessions[0]!
    parent.onPrompt = async () => {
      await f.accept('lookup')
      await f.complete('lookup')
      await f.router.attachBackgroundResultCoverage({ parentSessionId: 'parent-1', taskId: 'lookup' })
      expect((await f.channelSend(parent, { text: 'The deployment finished at 14:02.' })).details).toMatchObject({
        ok: true,
      })
      // Non-terminal: the provider follow-up after the send still goes out.
      await parent.agent.streamFunction(
        {} as Parameters<StreamFn>[0],
        normalizeContext({ systemPrompt: '', messages: [], tools: [] }),
      )
      parent.finish('NO_REPLY')
    }
    const request = await f.route('When did the deployment finish?')
    await f.flush()

    expect(parent.providerRequests).toBe(1)
    expect(f.sent).toEqual(['The deployment finished at 14:02.'])
    expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.childRow('lookup')).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })

    parent.onPrompt = async () => {
      parent.finish('NO_REPLY')
    }
    await f.route('Thanks!')
    await f.flush()
    expect(await f.outbox.list()).toEqual([])
    expect(await f.reboot()).toBe(0)
  } finally {
    await f.cleanup()
  }
})

for (const scenario of [
  { name: 'a post to another thread', params: { thread: '1700000000.999999', text: 'Posted in a sibling thread.' } },
  { name: 'a post at the channel root instead of the origin thread', params: { thread: null, text: 'Root post.' } },
  { name: 'a post to another chat', params: { chat: 'C1', text: 'Posted in another channel.' } },
  { name: 'a post to another workspace', params: { workspace: 'T1', text: 'Posted in another workspace.' } },
  {
    name: 'a post through another adapter',
    params: { adapter: 'discord-bot', workspace: 'G0', chat: 'D0', thread: null, text: 'Posted on Discord.' },
  },
  { name: 'a send from a session without a channel origin', params: { text: 'Cron-style post.' }, origin: null },
  { name: 'a failed send', params: { text: FAILING_TEXT } },
  { name: 'an English progress status', params: { text: "I'll check and get back to you." } },
  { name: 'a Korean progress status', params: { text: '확인해볼게요, 잠시만요.' } },
] satisfies Array<{ name: string; params: SendParams; origin?: null }>) {
  test(`origin debt stays owed after ${scenario.name}`, async () => {
    const f = await debtFixture()
    try {
      const parent = f.sessions[0]!
      let request = ''
      let phaseAfterSend: string | undefined
      parent.onPrompt = async () => {
        await f.channelSend(parent, scenario.params, 'origin' in scenario ? scenario.origin : undefined)
        phaseAfterSend = f.inputRow(request)?.phase
        parent.finish('NO_REPLY')
      }
      request = await f.route('Please look into this.')
      await f.flush()
      expect(phaseAfterSend).toBe('turn-owned')
      expect(f.sent.includes(scenario.params.text)).toBe(scenario.params.text !== FAILING_TEXT)
    } finally {
      await f.cleanup()
    }
  })
}

test('a GitHub already-resolved channel_send no-op settles no origin debt', async () => {
  const f = await debtFixture({ key: GITHUB_THREAD_KEY })
  try {
    f.router.registerReviewThreadResolver('github', async () => ({ ok: true, alreadyResolved: true }))
    f.router.registerReviewStateResolver('github', async () => ({
      ok: true,
      selfBlocking: false,
      selfBlockingReviewId: null,
      approve: true,
    }))
    const parent = f.sessions[0]!
    let request = ''
    let phaseAfterSend: string | undefined
    parent.onPrompt = async () => {
      const result = await f.channelSend(parent, {
        text: 'Addressed in abc123, resolving.',
        resolve_review_thread: true,
      })
      expect(result.details).toEqual({ ok: true })
      phaseAfterSend = f.inputRow(request)?.phase
      parent.finish('NO_REPLY')
    }
    request = await f.route('Can you resolve this thread?')
    await f.flush()
    expect(f.sent).toEqual([])
    expect(phaseAfterSend).toBe('turn-owned')
  } finally {
    await f.cleanup()
  }
})

for (const supersede of ['newer input', 'stop', 'account transfer'] as const) {
  test(`a held origin channel_send settles only its captured generation after ${supersede}`, async () => {
    const f = await debtFixture()
    try {
      const parent = f.sessions[0]!
      const held = f.hold('The report is ready.')
      let newer = ''
      let newerPhaseAfterSend: string | undefined
      parent.onPrompt = async () => {
        // Later turns (the newer input's own) stay quiet.
        parent.onPrompt = async () => {
          parent.finish('NO_REPLY')
        }
        const sending = f.channelSend(parent, { text: 'The report is ready.' })
        await held.entered.promise
        if (supersede === 'newer input') newer = await f.route('One more question.')
        if (supersede === 'stop') await f.route('/stop')
        if (supersede === 'account transfer') {
          f.state.account = 'account-b'
          expect((await f.router.send({ ...f.key, text: 'Status probe.' })).ok).toBe(false)
        }
        held.release.resolve()
        expect((await sending).details).toMatchObject({ ok: true })
        if (newer !== '') newerPhaseAfterSend = f.inputRow(newer)?.phase
        parent.finish('NO_REPLY')
      }
      const request = await f.route('Please send the report.')
      await f.flush()

      expect(f.sent).toContain('The report is ready.')
      if (supersede === 'newer input') {
        expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
        expect(newerPhaseAfterSend).toBe('admitted')
        expect(f.sessions[0]!.prompts.some((prompt) => prompt.includes('One more question.'))).toBe(true)
      }
      if (supersede === 'stop') {
        expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'intentionally-suppressed' } })
      }
      if (supersede === 'account transfer') {
        expect(f.inputRow(request)?.phase).not.toBe('closed')
        const notices = await f.outbox.list()
        expect(notices).toMatchObject([{ state: 'pending', accountIdentity: 'account-a' }])
        expect(notices[0]!.covers.map((cover) => cover.id)).toEqual([f.inputRow(request)!.inputId])
      }
    } finally {
      await f.cleanup()
    }
  })
}

for (const mode of ['coalesced follow-up', 'wake only', 'still-running child'] as const) {
  test(`a deferred request survives a ${mode} completion path without an interruption notice`, async () => {
    const f = await debtFixture()
    try {
      const parent = f.sessions[0]!
      f.deferToChild(parent, 'deferred-task')
      const request = await f.route('Please investigate the outage.')
      await f.flush()
      expect(f.inputRow(request)?.phase).toBe('turn-owned')

      f.state.now += 10
      if (mode !== 'still-running child') f.running.delete('parent-1')
      const prompts: string[] = []
      let carriedIntoFollowUp: string[] = []
      parent.onPrompt = async (text) => {
        prompts.push(text)
        if (text.includes('deferred-task')) {
          await f.reply(parent, 'The outage came from an expired certificate.')
          return
        }
        // The follow-up turn while the child still runs: it now owns the deferred request too.
        carriedIntoFollowUp = (await f.router.captureInboundResultCoverage!('parent-1')).map((ref) => ref.inputId)
        await f.reply(parent, 'The database is healthy.')
      }
      const followUp = mode === 'wake only' ? undefined : await f.route('Any update?')
      if (mode === 'still-running child') {
        await f.flush()
        expect(await f.outbox.list()).toEqual([])
        expect(carriedIntoFollowUp.sort()).toEqual(
          [f.inputRow(request)!.inputId, f.inputRow(followUp!)!.inputId].sort(),
        )
        f.running.delete('parent-1')
      }
      await f.complete('deferred-task')
      await f.flush()

      expect(await f.outbox.list()).toEqual([])
      if (mode === 'coalesced follow-up') {
        expect(prompts).toHaveLength(1)
        expect(prompts[0]).toContain('Any update?')
        expect(prompts[0]).toContain('deferred-task')
      } else {
        expect(prompts.at(-1)).toContain('deferred-task')
      }
      expect(f.sent).toEqual(
        mode === 'still-running child'
          ? ['The database is healthy.', 'The outage came from an expired certificate.']
          : ['The outage came from an expired certificate.'],
      )
      expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      if (followUp !== undefined) {
        expect(f.inputRow(followUp)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      }
      expect(await f.childRow('deferred-task')).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    } finally {
      await f.cleanup()
    }
  })
}

for (const carrier of ['another parent', 'an earlier turn'] as const) {
  test(`a completion from ${carrier} does not carry an abandoned deferred request`, async () => {
    const f = await debtFixture()
    try {
      const parent = f.sessions[0]!
      if (carrier === 'an earlier turn') {
        parent.onPrompt = async () => {
          await f.accept('earlier-task')
          await f.reply(parent, 'Started the export.')
        }
        await f.route('Start the export.')
        await f.flush()
        f.state.now += 10
      } else {
        await f.accept('stranger-task', 'parent-9')
      }
      f.deferToChild(parent, 'abandoned-task')
      const request = await f.route('Please investigate the outage.')
      await f.flush()
      // The deferred child disappears without ever reporting back.
      f.running.delete('parent-1')
      f.state.now += 10
      const prompts: string[] = []
      parent.onPrompt = async (text) => {
        prompts.push(text)
        parent.finish('NO_REPLY')
      }
      await f.route('Different topic: what time is it?')
      if (carrier === 'an earlier turn') await f.complete('earlier-task')
      else await f.complete('stranger-task', 'parent-9')
      await f.flush()

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('Different topic')
      const notices = await f.outbox.list()
      expect(notices).toHaveLength(1)
      expect(notices[0]!.covers.map((cover) => cover.id)).toEqual([f.inputRow(request)!.inputId])
      expect(notices[0]!.principal).toMatchObject({ kind: 'channel', lastInboundAuthorId: 'human' })
    } finally {
      await f.cleanup()
    }
  })
}

for (const reload of ['idle', 'mid-drain'] as const) {
  test(`a ${reload} reload hands a request and its consumed result to a successor that closes both`, async () => {
    const f = await debtFixture()
    try {
      const request = (await f.consumeThenDefer(
        'Please research the incident.',
        reload === 'mid-drain' ? () => f.router.tearDownAllLive() : undefined,
      ))!
      // Idle: the successor comes back under a new session ID, is reloaded again and takes a
      // follow-up while the original parent's child still runs, so no check may use its own ID.
      if (reload === 'idle') {
        f.state.successorSessionId = 'parent-2'
        await f.router.tearDownAllLive()
        await f.router.tearDownAllLive()
      }

      expect(await f.outbox.list()).toEqual([])
      expect(f.creations).toEqual(reload === 'idle' ? [undefined, 'parent-1', 'parent-2'] : [undefined, 'parent-1'])
      const successor = f.sessions.at(-1)!
      expect(successor.prompts).toEqual([])
      expect(f.inputRow(request)?.phase).toBe('turn-owned')
      expect((await f.childRow('child-a'))?.phase).toBe('turn-owned')
      const inputs = [request]
      if (reload === 'idle') {
        // The follow-up turn takes over the deferred coverage and keeps waiting on the child.
        inputs.push(await f.route('Any progress?'))
        await f.flush()
        expect(successor.prompts).toHaveLength(1)
        expect(await f.outbox.list()).toEqual([])
      }

      successor.onPrompt = async () =>
        f.reply(successor, 'The incident was a DNS misconfiguration.', reload === 'idle' ? 'parent-2' : 'parent-1')
      f.running.delete('parent-1')
      await f.complete('child-b')
      await f.flush()

      const prompts = reload === 'idle' ? 2 : 1
      expect(successor.prompts).toHaveLength(prompts)
      expect(successor.prompts.at(-1)).toContain('child-b')
      expect(f.sessions[0]!.prompts).toHaveLength(3)
      expect(f.sent).toEqual(['The incident was a DNS misconfiguration.'])
      for (const input of inputs) {
        expect(f.inputRow(input)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      }
      for (const task of ['child-a', 'child-b']) {
        expect(await f.childRow(task)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      }
      // Late duplicate completions find closed rows: no wake, no prompt, nothing owed after reboot.
      expect((await f.complete('child-a')).kind).toBe('no-live-session')
      expect((await f.complete('child-b')).kind).toBe('no-live-session')
      await f.flush()
      expect(successor.prompts).toHaveLength(prompts)
      expect(await f.outbox.list()).toEqual([])
      expect(await f.reboot()).toBe(0)
    } finally {
      await f.cleanup()
    }
  })
}

test("the original parent's completion waits on the handoff of a successor that took over its work", async () => {
  const f = await debtFixture({ failCreationAttempts: [3] })
  try {
    const request = (await f.consumeThenDefer('Please research the incident.'))!
    f.state.successorSessionId = 'parent-2'
    await f.router.tearDownAllLive()
    // parent-2's follow-up turn takes over the request and the consumed result; child-b stays parent-1's.
    const followUp = await f.route('Any progress?')
    await f.flush()
    expect(f.sessions[1]!.prompts).toHaveLength(1)
    // parent-2's own reload cannot recreate a session, so the coverage waits in the handoff.
    await f.router.tearDownAllLive()
    expect(f.router.liveCount()).toBe(0)
    expect(await f.outbox.list()).toEqual([])
    f.running.delete('parent-1')
    expect((await f.complete('child-b')).kind).toBe('delivered')

    f.state.onSessionCreated = (successor) => {
      successor.onPrompt = async () => f.reply(successor, 'The incident was a DNS misconfiguration.', 'parent-2')
    }
    await f.router.tearDownAllLive()
    await f.flush()

    expect(f.creations).toEqual([undefined, 'parent-1', 'parent-2', 'parent-2'])
    const successor = f.sessions.at(-1)!
    expect(successor.prompts).toHaveLength(1)
    expect(successor.prompts[0]).toContain('child-b')
    expect(f.sent).toEqual(['The incident was a DNS misconfiguration.'])
    for (const input of [request, followUp]) {
      expect(f.inputRow(input)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    }
    for (const task of ['child-a', 'child-b']) {
      expect(await f.childRow(task)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    }
    expect(await f.outbox.list()).toEqual([])
    expect(await f.reboot()).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test('a coalesced follow-up and the next completion carry the consumed result of the deferring turn', async () => {
  const f = await debtFixture()
  try {
    const request = (await f.consumeThenDefer('Please investigate the outage.'))!
    const parent = f.sessions[0]!
    parent.onPrompt = async () => f.reply(parent, 'The certificate expired; the database is healthy.')
    f.running.delete('parent-1')
    const followUp = await f.route('Is the database healthy too?')
    await f.complete('child-b')
    await f.flush()

    expect(parent.prompts).toHaveLength(4)
    expect(parent.prompts[3]).toContain('Is the database healthy too?')
    expect(parent.prompts[3]).toContain('child-b')
    expect(f.sent).toEqual(['The certificate expired; the database is healthy.'])
    for (const input of [request, followUp]) {
      expect(f.inputRow(input)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    }
    for (const task of ['child-a', 'child-b']) {
      expect(await f.childRow(task)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    }
    expect(await f.outbox.list()).toEqual([])
    expect(await f.reboot()).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test('a completion-only turn that consumed a result and waited on another child closes both', async () => {
  const f = await debtFixture()
  try {
    await f.consumeThenDefer()
    expect((await f.childRow('child-a'))?.phase).toBe('turn-owned')
    const inputs = f.journal.list()
    const parent = f.sessions[0]!
    parent.onPrompt = async () => f.reply(parent, 'Both checks finished: all green.')
    f.running.delete('parent-1')
    await f.complete('child-b')
    await f.flush()

    expect(parent.prompts).toHaveLength(3)
    expect(f.sent).toEqual(['Both checks finished: all green.'])
    for (const task of ['child-a', 'child-b']) {
      expect(await f.childRow(task)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    }
    // No synthetic inbound row carried the result.
    expect(f.journal.list()).toEqual(inputs)
    expect(await f.outbox.list()).toEqual([])
    expect(await f.reboot()).toBe(0)
  } finally {
    await f.cleanup()
  }
})

for (const stale of ['claimed by another owner', 'already closed'] as const) {
  test(`a consumed result ${stale} stays untouched while the request and the next child deliver`, async () => {
    const f = await debtFixture()
    try {
      const request = (await f.consumeThenDefer('Please investigate the outage.'))!
      const consumed = (await f.childRow('child-a'))!
      const refs = [{ obligationId: consumed.obligationId, generation: consumed.generation }]
      if (stale === 'claimed by another owner') {
        await f.store.move(refs, {
          fromTurnId: consumed.claim!.turnId,
          turnId: 'foreign-turn',
          ownerSessionId: 'parent-9',
          target: f.key,
        })
      } else {
        await f.journal.settle([], { kind: 'delivered', decisionId: 'answered-elsewhere' }, refs, f.key)
      }
      const before = await f.childRow('child-a')
      const parent = f.sessions[0]!
      parent.onPrompt = async () => f.reply(parent, 'The certificate expired.')
      f.running.delete('parent-1')
      await f.complete('child-b')
      await f.flush()

      expect(f.sent).toEqual(['The certificate expired.'])
      expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      expect(await f.childRow('child-b')).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      expect(await f.childRow('child-a')).toEqual(before)
    } finally {
      await f.cleanup()
    }
  })
}

test('a consumed result re-owned by another session under the same turn is not carried forward', async () => {
  const f = await debtFixture()
  try {
    await f.consumeThenDefer()
    const consumed = (await f.childRow('child-a'))!
    await f.store.move([{ obligationId: consumed.obligationId, generation: consumed.generation }], {
      fromTurnId: consumed.claim!.turnId,
      turnId: consumed.claim!.turnId,
      ownerSessionId: 'parent-9',
      target: f.key,
    })
    const before = await f.childRow('child-a')
    const parent = f.sessions[0]!
    parent.onPrompt = async () => f.reply(parent, 'The second check finished.')
    f.running.delete('parent-1')
    await f.complete('child-b')
    await f.flush()

    expect(f.sent).toEqual(['The second check finished.'])
    expect(await f.childRow('child-b')).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.childRow('child-a')).toEqual(before)
  } finally {
    await f.cleanup()
  }
})

for (const next of ['an unrelated wake', 'a new request'] as const) {
  test(`${next} does not acquire a consumed result its turn abandoned`, async () => {
    const f = await debtFixture()
    try {
      const parent = f.sessions[0]!
      await f.accept('child-a')
      // The wake consumes the result and ends silent without starting more work.
      await f.complete('child-a')
      await f.flush()
      const abandoned = await f.childRow('child-a')
      expect(abandoned?.phase).toBe('turn-owned')

      parent.onPrompt = async () => f.reply(parent, 'Here is the answer.')
      // A completion with no durable obligation is a generic wake.
      if (next === 'an unrelated wake') await f.complete('untracked-task')
      else await f.route('What time is it?')
      await f.flush()

      expect(f.sent).toEqual(['Here is the answer.'])
      if (next === 'an unrelated wake') {
        expect(await f.childRow('child-a')).toEqual(abandoned)
        expect(await f.outbox.list()).toEqual([])
      } else {
        // A human batch with no deferred work pending transfers it, as for abandoned requests.
        expect((await f.childRow('child-a'))?.phase).toBe('notice-owned')
        const notices = await f.outbox.list()
        expect(notices).toHaveLength(1)
        expect(notices[0]!.covers.map((cover) => cover.id)).toEqual([abandoned!.obligationId])
      }
    } finally {
      await f.cleanup()
    }
  })
}

test('a mid-drain reload carries the queued follow-up and the child-deferred request into one successor lineage', async () => {
  const f = await debtFixture()
  try {
    const parent = f.sessions[0]!
    let followUp = ''
    f.deferToChild(parent, 'research', async () => {
      await f.router.tearDownAllLive()
      followUp = await f.route('Also check the database.')
    })
    const request = await f.route('Please research the incident.')
    await f.flush()

    const successor = f.sessions[1]!
    expect(successor.prompts).toHaveLength(1)
    expect(successor.prompts[0]).toContain('Also check the database.')
    expect(await f.outbox.list()).toEqual([])

    successor.onPrompt = async () => f.reply(successor, 'Both the DNS and the database are healthy now.')
    f.running.delete('parent-1')
    await f.complete('research')
    await f.flush()

    expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(f.inputRow(followUp)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.childRow('research')).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.outbox.list()).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('repeated reloads and a failed successor recreate keep one owner for the deferred request', async () => {
  const f = await debtFixture({ failCreationAttempts: [3] })
  try {
    const parent = f.sessions[0]!
    f.deferToChild(parent, 'research')
    const request = await f.route('Please research the incident.')
    await f.flush()

    await f.router.tearDownAllLive()
    await f.router.tearDownAllLive()
    // The third creation fails: no live session, the handoff stays pending, nothing is transferred.
    expect(f.router.liveCount()).toBe(0)
    expect(await f.outbox.list()).toEqual([])
    f.running.delete('parent-1')
    // The completion waits on the pending handoff instead of being dropped.
    expect((await f.complete('research')).kind).toBe('delivered')

    f.state.onSessionCreated = (successor) => {
      successor.onPrompt = async () => f.reply(successor, 'The incident was a DNS misconfiguration.')
    }
    await f.router.tearDownAllLive()
    await f.flush()
    expect(f.creations).toEqual([undefined, 'parent-1', 'parent-1', 'parent-1'])
    const successor = f.sessions[2]!
    expect(successor.prompts).toHaveLength(1)
    expect(successor.prompts[0]).toContain('research')

    expect(f.sent).toEqual(['The incident was a DNS misconfiguration.'])
    expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.childRow('research')).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.outbox.list()).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('stop withdraws a child-deferred request a reload successor adopted', async () => {
  const f = await debtFixture()
  try {
    const parent = f.sessions[0]!
    f.deferToChild(parent, 'research')
    const request = await f.route('Please research the incident.')
    await f.flush()
    await f.router.tearDownAllLive()

    await f.route('/stop')
    expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'intentionally-suppressed' } })
    expect(f.sent).toEqual(['Stopped the current turn.'])
    expect(await f.outbox.list()).toEqual([])
  } finally {
    await f.cleanup()
  }
})

for (const loss of ['account rotation', 'handoff capacity', 'handoff expiry'] as const) {
  test(`${loss} ends a reload handoff as one notice under the original principal and account`, async () => {
    const f = await debtFixture(
      loss === 'handoff capacity'
        ? { handoffRetryItemLimit: 0 }
        : loss === 'handoff expiry'
          ? { failCreationAttempts: [2], handoffRetryRetentionMs: 50 }
          : {},
    )
    try {
      const parent = f.sessions[0]!
      f.deferToChild(parent, 'research')
      const request = await f.route('Please research the incident.')
      await f.flush()
      if (loss === 'account rotation') f.state.account = 'account-b'
      await f.router.tearDownAllLive()
      if (loss === 'handoff expiry') {
        expect(await f.outbox.list()).toEqual([])
        f.state.now += 100
        // The next session for this conversation finds the handoff past retention.
        await f.route('Unrelated new question.')
        await f.flush()
      }

      const notices = await f.outbox.list()
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({
        accountIdentity: 'account-a',
        principal: { kind: 'channel', lastInboundAuthorId: 'human' },
      })
      expect(notices[0]!.covers.map((cover) => cover.id)).toEqual([f.inputRow(request)!.inputId])
      expect(f.inputRow(request)?.phase).not.toBe('turn-owned')
      if (loss !== 'handoff expiry') expect(f.creations).toEqual([undefined])
    } finally {
      await f.cleanup()
    }
  })
}

test('an attachments-only channel_send to the origin closes the request it answers', async () => {
  const f = await debtFixture()
  try {
    const parent = f.sessions[0]!
    let details: unknown
    parent.onPrompt = async () => {
      details = (await f.channelSend(parent, { attachments: [{ path: '/agent/workspace/report.pdf' }] })).details
      parent.finish('NO_REPLY')
    }
    const request = await f.route('Please attach the report.')
    await f.flush()

    expect(details).toMatchObject({ ok: true })
    expect(f.sent).toEqual(['[attachments: /agent/workspace/report.pdf]'])
    expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.reboot()).toBe(0)
  } finally {
    await f.cleanup()
  }
})

for (const path of ['text /stop', 'native slash stop'] as const) {
  test(`${path} with no live session withdraws a pending reload handoff so a later session never answers it`, async () => {
    const f = await debtFixture({ failCreationAttempts: [2] })
    try {
      const parent = f.sessions[0]!
      f.deferToChild(parent, 'research')
      const request = await f.route('Please research the incident.')
      await f.flush()
      // The reload successor fails to start: the work waits in the handoff, with no live session.
      await f.router.tearDownAllLive()
      expect(f.router.liveCount()).toBe(0)
      f.running.delete('parent-1')
      expect((await f.complete('research')).kind).toBe('delivered')

      if (path === 'text /stop') {
        expect(await f.router.route(f.inbound('/stop'))).toEqual({ kind: 'control' })
        expect(f.sent).toEqual(['Stopped the current turn.'])
      } else {
        // Slack slash commands carry no thread; the conversation's handoff is still found.
        expect(await f.router.executeCommand({ ...f.key, thread: null }, 'stop', { invokerId: 'human' })).toEqual({
          kind: 'handled',
          name: 'stop',
          reply: 'Stopped the current turn.',
        })
      }
      expect(f.router.liveCount()).toBe(0)
      expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'intentionally-suppressed' } })
      expect(await f.childRow('research')).toMatchObject({
        phase: 'closed',
        outcome: { kind: 'intentionally-suppressed' },
      })

      const prompts: string[] = []
      f.state.onSessionCreated = (session) => {
        session.onPrompt = async (text) => {
          prompts.push(text)
          if (text.includes('research')) await f.reply(session, 'The incident was a DNS misconfiguration.')
          else session.finish('NO_REPLY')
        }
      }
      await f.router.tearDownAllLive()
      const next = await f.route('A different question.')
      await f.flush()

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('A different question.')
      expect(prompts[0]).not.toContain('research')
      expect(f.sent).not.toContain('The incident was a DNS misconfiguration.')
      expect(f.inputRow(next)?.phase).toBe('closed')
      expect(await f.outbox.list()).toEqual([])
    } finally {
      await f.cleanup()
    }
  })
}

test('/stop with neither a live session nor a reload handoff stays a no-op', async () => {
  const f = await debtFixture()
  try {
    await f.router.tearDownAllLive()
    expect(f.router.liveCount()).toBe(0)
    expect(await f.router.route(f.inbound('/stop'))).toEqual({ kind: 'control' })
    expect(await f.router.executeCommand(f.key, 'stop', { invokerId: 'human' })).toEqual({ kind: 'no-live-session' })
    expect(f.sent).toEqual([])
  } finally {
    await f.cleanup()
  }
})

for (const cap of ['per-key item limit', 'per-key byte limit', 'global byte limit'] as const) {
  test(`a completion wake that would exceed the ${cap} is refused without touching the handoff`, async () => {
    const f = await debtFixture({
      failCreationAttempts: [2],
      ...(cap === 'per-key item limit' ? { handoffRetryItemLimit: 1 } : {}),
      ...(cap === 'per-key byte limit' ? { handoffRetryByteLimit: 1024 } : {}),
      // Above the fixed global budget, so only the global bound can refuse.
      ...(cap === 'global byte limit' ? { handoffRetryByteLimit: 128 * 1024 * 1024 } : {}),
    })
    try {
      const parent = f.sessions[0]!
      f.deferToChild(parent, 'research')
      const request = await f.route('Please research the incident.')
      await f.flush()
      await f.router.tearDownAllLive()
      expect(f.router.liveCount()).toBe(0)
      f.running.delete('parent-1')

      // A failed child's error text is carried verbatim into its wake.
      const error = 'x'.repeat(cap === 'global byte limit' ? 64 * 1024 * 1024 : cap === 'per-key byte limit' ? 2048 : 1)
      const completion = await f.router.injectSubagentCompletionReminder({
        parentSessionId: 'parent-1',
        channelKey: f.key,
        taskId: 'research',
        subagent: 'explorer',
        ok: false,
        error,
        durationMs: 20,
      })

      expect(completion).toEqual({ kind: 'no-live-session' })
      expect(f.logs.some((line) => line.includes(cap) && line.includes('result stays owed'))).toBe(true)
      expect(await f.childRow('research')).toMatchObject({ phase: 'result-ready' })
      expect(f.inputRow(request)?.phase).toBe('turn-owned')
      expect(await f.outbox.list()).toEqual([])

      // The handoff is intact: its successor adopts the deferred request, and no wake was added to prompt it.
      await f.router.tearDownAllLive()
      await f.flush()
      expect(f.router.liveCount()).toBe(1)
      expect(f.sessions[1]!.prompts).toEqual([])
      expect((await f.router.captureInboundResultCoverage!('parent-1')).map((ref) => ref.inputId)).toEqual([
        f.inputRow(request)!.inputId,
      ])
    } finally {
      await f.cleanup()
    }
  })
}

test('a redelivered message is a duplicate for its author and a conflict for anyone else, in any routing thread', async () => {
  const f = await debtFixture()
  try {
    const parent = f.sessions[0]!
    parent.onPrompt = async () => f.reply(parent, 'Here is the summary.')
    const original = f.inbound('Please summarize the thread.')
    expect((await f.router.route(original)).kind).toBe('accepted')
    await f.flush()
    const rows = f.journal.list()
    const creations = [...f.creations]

    for (const thread of [original.thread, null]) {
      expect(await f.router.route({ ...original, thread })).toMatchObject({ kind: 'duplicate' })
      await expect(f.router.route({ ...original, thread, authorId: 'mallory', authorName: 'Mallory' })).rejects.toThrow(
        'Conflicting duplicate admission principal',
      )
    }
    await f.flush()

    expect(f.journal.list()).toEqual(rows)
    expect(f.creations).toEqual(creations)
    expect(parent.prompts).toHaveLength(2)
    expect(f.sent).toEqual(['Here is the summary.'])
  } finally {
    await f.cleanup()
  }
})

test('/stop leaves a reload handoff that holds only observed context alone', async () => {
  const f = await debtFixture({ failCreationAttempts: [2] })
  try {
    let recoveryStops = 0
    f.router.setRecoveryStopHandler(async () => {
      recoveryStops++
    })
    // An idle bystander: since its last turn the conversation only observed chatter.
    expect(
      await f.router.route(f.inbound('ambient chatter between humans', { isBotMention: false, mentionsOthers: true })),
    ).toEqual({ kind: 'observed' })
    await f.router.tearDownAllLive()
    expect(f.router.liveCount()).toBe(0)

    expect(await f.router.executeCommand(f.key, 'stop', { invokerId: 'human' })).toEqual({ kind: 'no-live-session' })
    expect(await f.router.executeCommand({ ...f.key, thread: null }, 'stop', { invokerId: 'human' })).toEqual({
      kind: 'no-live-session',
    })
    expect(await f.router.route(f.inbound('/stop'))).toEqual({ kind: 'control' })
    expect(f.sent).toEqual([])
    expect(recoveryStops).toBe(0)

    // The observed context still reaches the next session.
    const prompts: string[] = []
    f.state.onSessionCreated = (session) => {
      session.onPrompt = async (text) => {
        prompts.push(text)
        session.finish('NO_REPLY')
      }
    }
    await f.route('Now please answer.')
    await f.flush()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('ambient chatter between humans')
    expect(prompts[0]).toContain('Now please answer.')
  } finally {
    await f.cleanup()
  }
})
