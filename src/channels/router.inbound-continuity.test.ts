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
import { BackgroundObligationStore, type BackgroundObligation } from './background-obligations'
import {
  LIVE_TURN_ENDED_NOTICE_TEXT,
  RECOVERY_NOTICE_TEXT,
  recoveryNoticeCause,
  recoveryPayload,
  type RecoveryRecord,
} from './continuity-types'
import { InboundJournal } from './inbound-journal'
import { RecoveryDispatcher } from './recovery-dispatcher'
import { RecoveryOutbox } from './recovery-outbox'
import { createChannelRouter, SESSION_GRACE_HARD_TTL_MS, SESSION_IDLE_MS } from './router'
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
  private leaves = 0
  private listeners: Array<(event: unknown) => void> = []
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
  subscribe = (listener: (event: unknown) => void) => {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener)
    }
  }
  // Each assistant message is a new transcript entry, as in a real session.
  finish(text: string, stopReason: AssistantMessage['stopReason'] = 'stop') {
    this.leaf = {
      type: 'message',
      id: `leaf-${++this.leaves}`,
      parentId: null,
      timestamp: new Date(1000).toISOString(),
      message: assistantMessage(text, stopReason),
    }
  }
  // The provider rejects the call: the SDK emits the failed assistant message and ends the turn on it.
  failProvider(errorMessage: string) {
    const message = { ...assistantMessage('', 'error'), errorMessage }
    for (const listener of this.listeners) listener({ type: 'message_end', message })
    this.finish('', 'error')
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
  const durability: { failType?: string } = {}
  const journal = new InboundJournal(dir, {
    backgroundObligations: store,
    epoch: store.epoch,
    onDurability: (phase, record) => {
      if (
        durability.failType &&
        phase === 'append-written' &&
        record &&
        typeof record === 'object' &&
        'type' in record &&
        record.type === durability.failType
      )
        throw new Error('controlled prepared source durability failure')
    },
  })
  await journal.initialize()
  const noticeTransitions = new Map<string, PromiseWithResolvers<void>>()
  const noticeTransition = (id: string, phase: 'suppressed' | 'retired') => {
    const key = `${id}:${phase}`
    let signal = noticeTransitions.get(key)
    if (!signal) {
      signal = Promise.withResolvers<void>()
      noticeTransitions.set(key, signal)
    }
    return signal
  }
  const outbox = new RecoveryOutbox(dir, {
    epoch: store.epoch,
    onDurability: (phase, record) => {
      if (phase === 'retired') noticeTransition(record.deliveryId, 'retired').resolve()
      if (phase === 'directory-synced' && record.state === 'suppressed')
        noticeTransition(record.deliveryId, 'suppressed').resolve()
    },
  })
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
    // Holds every outbound whose text starts with `text` until released.
    held?: { text: string; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    // The transport rejects every outbound whose text starts with this prefix.
    reject?: string
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
    if (held !== undefined && message.text?.startsWith(held.text)) {
      held.entered.resolve()
      await held.release.promise
    }
    if (message.text === FAILING_TEXT || (state.reject !== undefined && message.text?.startsWith(state.reject)))
      return { ok: false, error: 'controlled transport failure' }
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
  // Message ID → admitted input ID: a settled row keeps only a minimal tombstone.
  const admitted = new Map<string, string>()
  const route = async (text: string): Promise<string> => {
    const event = inbound(text)
    const receipt = await router.route(event)
    if (receipt.kind === 'accepted') admitted.set(event.externalMessageId, receipt.inputId)
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
    durability,
    outbox,
    noticeTransition,
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
    inputRow: (messageId: string) => {
      const inputId = admitted.get(messageId)
      return inputId === undefined ? undefined : journal.get(inputId)
    },
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
    // channel_reply({ more_work_this_turn: true }): a progress reply that keeps the turn alive.
    continueReply: async (session: ParentSession, text: string, sessionId = 'parent-1') => {
      const backgroundCoverage = await router.captureBackgroundResultCoverage!(sessionId)
      const inboundCoverage = await router.captureInboundResultCoverage!(sessionId)
      expect((await router.send({ ...key, text })).ok).toBe(true)
      await afterTool(
        session,
        'channel_reply',
        { text, more_work_this_turn: true },
        { content: [], details: { ok: true, more_work_this_turn: true, backgroundCoverage, inboundCoverage } },
      )
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
    // Boot recovery of the directory under `epoch`; the first call stops the live process.
    reboot: async (epoch = 'reboot'): Promise<number> => {
      if (!state.closed) {
        await router.stop()
        await journal.close()
        state.closed = true
      }
      const bootStore = new BackgroundObligationStore(dir, { epoch })
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
        await f.reply(parent, 'It is noon.')
      }
      const different = await f.route('Different topic: what time is it?')
      if (carrier === 'an earlier turn') await f.complete('earlier-task')
      else await f.complete('stranger-task', 'parent-9')
      await f.flush()

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('Different topic')
      // The new turn answers only what it owns; the abandoned request ended with its own live turn.
      expect(f.inputRow(different)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      expect(f.inputRow(request)?.phase).toBe('notice-owned')
      const notices = await f.outbox.list()
      expect(notices).toHaveLength(1)
      expect(notices[0]!.covers.map((cover) => cover.id)).toEqual([f.inputRow(request)!.inputId])
      expect(notices[0]!.principal).toMatchObject({ kind: 'channel', lastInboundAuthorId: 'human' })
      expect(recoveryNoticeCause(notices[0]!)).toBe('live-turn-ended')
      expect(notices[0]!.text).toBe(LIVE_TURN_ENDED_NOTICE_TEXT)
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
      // The wake consumes the result and ends silent without starting more work: silence cannot
      // answer a child result, so its turn transfers it as ended in this process, not as a restart.
      await f.complete('child-a')
      await f.flush()
      const abandoned = await f.childRow('child-a')
      expect(abandoned?.phase).toBe('notice-owned')
      const notices = await f.outbox.list()
      expect(notices).toHaveLength(1)
      expect(notices[0]!.covers.map((cover) => cover.id)).toEqual([abandoned!.obligationId])
      expect(recoveryNoticeCause(notices[0]!)).toBe('live-turn-ended')

      parent.onPrompt = async () => f.reply(parent, 'Here is the answer.')
      // A completion with no durable obligation is a generic wake.
      if (next === 'an unrelated wake') await f.complete('untracked-task')
      else await f.route('What time is it?')
      await f.flush()

      expect(f.sent).toEqual(['Here is the answer.'])
      expect(await f.childRow('child-a')).toEqual(abandoned)
      expect(await f.outbox.list()).toEqual(notices)
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

// Live-turn outcomes in a process that never restarts: a promise, a provider failure or a
// lifecycle end decides owed coverage at the turn that owned it, never through a restart notice
// and never through a later unrelated reply.

for (const progress of [
  { name: 'an English status send', text: "I'll check and get back to you.", continueReply: false },
  { name: 'a Korean status send', text: '확인해볼게요, 잠시만요.', continueReply: false },
  { name: 'an English more_work_this_turn reply', text: 'Let me check that.', continueReply: true },
  { name: 'a Korean more_work_this_turn reply', text: '확인해볼게요.', continueReply: true },
] as const) {
  test(`${progress.name} then NO_REPLY ends the request with a live-turn-ended notice, never a restart`, async () => {
    const f = await debtFixture()
    try {
      const parent = f.sessions[0]!
      parent.onPrompt = async () => {
        if (progress.continueReply) await f.continueReply(parent, progress.text)
        else await f.channelSend(parent, { text: progress.text })
        parent.finish('NO_REPLY')
      }
      const request = await f.route('Why did the deploy fail?')
      await f.flush()

      // The progress message promised an answer, so the silence after it settles nothing. The
      // turn's own end transfers the request durably, before any later message arrives.
      expect(f.sent).toEqual([progress.text])
      const row = f.inputRow(request)!
      expect(row.phase).toBe('notice-owned')
      const notices = await f.outbox.list()
      expect(notices).toHaveLength(1)
      expect(notices[0]!.covers.map((cover) => cover.id)).toEqual([row.inputId])
      expect(recoveryNoticeCause(notices[0]!)).toBe('live-turn-ended')
      expect(notices[0]!.text).toBe(LIVE_TURN_ENDED_NOTICE_TEXT)

      // An unrelated "Thanks!" is answered on its own; its reply never answers the earlier request.
      parent.onPrompt = async () => f.reply(parent, 'You are welcome.')
      const thanks = await f.route('Thanks!')
      await f.flush()
      expect(f.inputRow(thanks)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      expect(f.inputRow(request)?.phase).toBe('notice-owned')
      expect(await f.outbox.list()).toEqual(notices)

      // Boot recovery re-imports the frozen live notice and adds no restart notice for this epoch.
      expect(await f.reboot()).toBe(1)
      const recovered = await new RecoveryOutbox(f.dir).list()
      expect(recovered.map((notice) => notice.deliveryId)).toEqual([notices[0]!.deliveryId])
      expect(recovered.some((notice) => notice.text === RECOVERY_NOTICE_TEXT)).toBe(false)
    } finally {
      await f.cleanup()
    }
  })
}

for (const delivery of ['lands', 'is rejected'] as const) {
  test(`a provider-error notice that ${delivery} never settles a consumed child result`, async () => {
    const f = await debtFixture()
    try {
      const parent = f.sessions[0]!
      if (delivery === 'is rejected') f.state.reject = '⚠️'
      parent.onPrompt = async () => {
        await f.accept('lookup')
        await f.complete('lookup')
        await f.router.attachBackgroundResultCoverage({ parentSessionId: 'parent-1', taskId: 'lookup' })
        parent.failProvider('401 Unauthorized: invalid api key')
      }
      const request = await f.route('Summarize the lookup.')
      await f.flush()

      const child = (await f.childRow('lookup'))!
      const notices = await f.outbox.list()
      expect(notices.every((notice) => recoveryNoticeCause(notice) === 'live-turn-ended')).toBe(true)
      expect(child.phase).toBe('notice-owned')
      const covered = notices.flatMap((notice) => notice.covers.map((cover) => cover.id)).sort()
      if (delivery === 'lands') {
        expect(f.sent.filter((text) => text.startsWith('⚠️'))).toHaveLength(1)
        // The landed notice answers the request it captured; the consumed result stays owed.
        expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
        expect(covered).toEqual([child.obligationId])
      } else {
        // A rejected notice answered nothing: request and result both stay owed, durably.
        expect(f.sent).toEqual([])
        expect(f.inputRow(request)?.phase).toBe('notice-owned')
        expect(covered).toEqual([f.inputRow(request)!.inputId, child.obligationId].sort())
      }

      f.state.reject = undefined
      parent.onPrompt = async () => f.reply(parent, 'You are welcome.')
      const thanks = await f.route('Thanks!')
      await f.flush()
      expect(f.inputRow(thanks)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      expect(await f.outbox.list()).toEqual(notices)
      expect(await f.reboot()).toBe(notices.length)
    } finally {
      await f.cleanup()
    }
  })
}

test('a provider-error notice settles only the generation it captured before sending', async () => {
  const f = await debtFixture()
  try {
    const parent = f.sessions[0]!
    const held = f.hold('⚠️')
    parent.onPrompt = async () => parent.failProvider('401 Unauthorized: invalid api key')
    const request = await f.route('Summarize the incident.')
    const draining = f.flush()
    await held.entered.promise
    // /stop decides the request while the notice is still in flight.
    await f.route('/stop')
    held.release.resolve()
    await draining

    expect(f.sent.filter((text) => text.startsWith('⚠️'))).toHaveLength(1)
    expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'intentionally-suppressed' } })
    expect(await f.outbox.list()).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('/stop after a promise-only turn suppresses the live-turn-ended notice before it is sent', async () => {
  const f = await debtFixture()
  let dispatcher: RecoveryDispatcher | undefined
  try {
    const parent = f.sessions[0]!
    parent.onPrompt = async () => {
      await f.channelSend(parent, { text: '확인해볼게요, 잠시만요.' })
      parent.finish('NO_REPLY')
    }
    const request = await f.route('배포가 왜 실패했는지 확인해줘.')
    await f.flush()
    const [notice] = await f.outbox.list()
    expect(recoveryNoticeCause(notice!)).toBe('live-turn-ended')

    // The dispatcher's stop authority, without waking it: the notice is still unsent.
    dispatcher = new RecoveryDispatcher(f.outbox, f.router, {
      backgroundObligations: f.store,
      inboundJournal: f.journal,
    })
    await f.route('/stop')

    expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'intentionally-suppressed' } })
    const pending = await f.outbox.get(notice!.deliveryId)
    const retired = pending === undefined ? await f.outbox.retired(notice!.deliveryId) : undefined
    expect(pending?.state ?? retired?.dispatch.state).toBe('suppressed')
    expect(f.sent).toEqual(['확인해볼게요, 잠시만요.', 'Stopped the current turn.'])
  } finally {
    await dispatcher?.stop()
    await f.cleanup()
  }
})

// A deferred child that vanished without reporting back leaves two independent debts: the
// request, which its live turn already ended with a live-turn-ended notice, and the child's own
// result. That result stays owed and untransferred in the live epoch, so a late completion can
// still land; only a restart that really ends the child hands it to boot recovery, as its own
// notice. Repeated boots re-import both unchanged, and no row is ever covered twice.
async function expectChildRecoveredApart(
  f: {
    dir: string
    childRow: (taskId: string) => Promise<BackgroundObligation | undefined>
    reboot: (epoch?: string) => Promise<number>
  },
  live: RecoveryRecord,
  inputId: string,
  taskId: string,
) {
  const child = (await f.childRow(taskId))!
  expect(child.phase).toBe('accepted')
  expect(child.transfer).toBeUndefined()
  const coverage = (notice: RecoveryRecord) => ({
    deliveryId: notice.deliveryId,
    cause: recoveryNoticeCause(notice),
    text: notice.text,
    covers: notice.covers.map((cover) => ({ store: cover.store, id: cover.id, generation: cover.generation })),
  })
  const boots: unknown[] = []
  for (const epoch of ['first-boot', 'second-boot']) {
    await f.reboot(epoch)
    const recovered = await new RecoveryOutbox(f.dir).list()
    // The request keeps exactly the live notice that ended it.
    expect(recovered.filter((notice) => notice.covers.some((cover) => cover.id === inputId)).map(coverage)).toEqual([
      coverage(live),
    ])
    // The child is recovered alone, as ended by the restart.
    const childNotices = recovered.filter((notice) => notice.covers.some((cover) => cover.id === child.obligationId))
    expect(childNotices.map((notice) => notice.covers.map((cover) => [cover.store, cover.id]))).toEqual([
      [['background', child.obligationId]],
    ])
    expect(recoveryNoticeCause(childNotices[0]!)).toBe('restart')
    expect(childNotices[0]!.text).toBe(RECOVERY_NOTICE_TEXT)
    // Nothing else is owed.
    expect(recovered.map((notice) => notice.deliveryId).sort()).toEqual(
      [live.deliveryId, childNotices[0]!.deliveryId].sort(),
    )
    boots.push(recovered.map(coverage).sort((a, b) => a.deliveryId.localeCompare(b.deliveryId)))
  }
  expect(boots[1]).toEqual(boots[0])
}

test('idle eviction transfers debt its deferred child abandoned and keeps the session when that fails', async () => {
  const f = await debtFixture()
  try {
    const parent = f.sessions[0]!
    f.deferToChild(parent, 'research')
    const request = await f.route('Please research the incident.')
    await f.flush()
    f.state.now += SESSION_IDLE_MS + 1

    // A running deferred child pins the session and keeps its debt live.
    await f.router.__testing!.runIdleGc()
    expect(f.router.liveCount()).toBe(1)
    expect(f.inputRow(request)?.phase).toBe('turn-owned')

    // The child disappears without reporting back. A failed transfer keeps the session and its ownership.
    f.running.delete('parent-1')
    const prepareNotice = f.journal.prepareNotice.bind(f.journal)
    f.journal.prepareNotice = (async () => {
      throw new Error('controlled transfer failure')
    }) as typeof f.journal.prepareNotice
    await f.router.__testing!.runIdleGc()
    expect(f.router.liveCount()).toBe(1)
    expect(f.inputRow(request)?.phase).toBe('turn-owned')
    expect(await f.outbox.list()).toEqual([])

    f.journal.prepareNotice = prepareNotice
    await f.router.__testing!.runIdleGc()
    expect(f.router.liveCount()).toBe(0)
    expect(f.inputRow(request)?.phase).toBe('notice-owned')
    const notices = await f.outbox.list()
    expect(notices.map((notice) => notice.covers.map((cover) => cover.id))).toEqual([[f.inputRow(request)!.inputId]])
    expect(recoveryNoticeCause(notices[0]!)).toBe('live-turn-ended')
    await expectChildRecoveredApart(f, notices[0]!, f.inputRow(request)!.inputId, 'research')
  } finally {
    await f.cleanup()
  }
})

test('stale rollover hands abandoned debt to its successor, which ends it without a restart notice', async () => {
  const f = await debtFixture()
  try {
    const parent = f.sessions[0]!
    f.deferToChild(parent, 'research')
    const request = await f.route('Please research the incident.')
    await f.flush()
    f.running.delete('parent-1')
    f.state.now += SESSION_GRACE_HARD_TTL_MS + 1
    f.state.onSessionCreated = (successor) => {
      successor.onPrompt = async () => f.reply(successor, 'It is noon.', 'parent-2')
    }
    const next = await f.route('Different question: what time is it?')
    await f.flush()

    expect(f.sessions).toHaveLength(2)
    expect(f.sessions[1]!.prompts).toHaveLength(1)
    expect(f.inputRow(next)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(f.inputRow(request)?.phase).toBe('notice-owned')
    const notices = await f.outbox.list()
    expect(notices.map((notice) => notice.covers.map((cover) => cover.id))).toEqual([[f.inputRow(request)!.inputId]])
    expect(recoveryNoticeCause(notices[0]!)).toBe('live-turn-ended')
    // The successor's unrelated reply answered only its own request.
    await expectChildRecoveredApart(f, notices[0]!, f.inputRow(request)!.inputId, 'research')
  } finally {
    await f.cleanup()
  }
})

// Fail only this fixture's publication boundary; the source stores remain healthy.
function interruptNoticeImport(outbox: RecoveryOutbox, published: boolean) {
  const original = outbox.import.bind(outbox)
  let blocked = true
  outbox.import = async (record) => {
    if (!blocked) return original(record)
    if (published) await original(record)
    throw new Error('controlled frozen notice import failure')
  }
  return () => {
    blocked = false
    outbox.import = original
  }
}

interface DeferredNoticeFixture {
  sessions: ParentSession[]
  deferToChild: (session: ParentSession, taskId: string) => void
  route: (text: string) => Promise<string>
  flush: () => Promise<void>
  consumeThenDefer: (request?: string) => Promise<string | undefined>
  running: Map<string, number>
  state: { now: number }
  inputRow: (messageId: string) => { inputId: string } | undefined
  childRow: (taskId: string) => Promise<BackgroundObligation | undefined>
  journal: InboundJournal
  store: BackgroundObligationStore
}

async function deferredNoticeDebt(f: DeferredNoticeFixture, shape: 'inbound' | 'background' | 'mixed') {
  let request: string | undefined
  if (shape === 'inbound') {
    f.deferToChild(f.sessions[0]!, 'child-b')
    request = await f.route('Keep this original request separate.')
    await f.flush()
  } else {
    request = await f.consumeThenDefer(shape === 'mixed' ? 'Keep this original request separate.' : undefined)
  }
  f.running.delete('parent-1')
  f.state.now += SESSION_IDLE_MS + 1
  const inputId = request ? f.inputRow(request)!.inputId : undefined
  const backgroundId = shape === 'inbound' ? undefined : (await f.childRow('child-a'))!.obligationId
  return {
    inputId,
    backgroundId,
    frozen: async () => {
      const row = inputId ? f.journal.get(inputId) : await f.store.get(backgroundId!)
      if (!row || !('transfer' in row) || !row.transfer) throw new Error('Expected frozen source debt')
      return structuredClone(row.transfer)
    },
    expectPhase: async (phase: 'turn-owned' | 'notice-prepared' | 'notice-owned' | 'closed') => {
      if (inputId) expect(f.journal.get(inputId)?.phase).toBe(phase)
      if (backgroundId) expect((await f.store.get(backgroundId))?.phase).toBe(phase)
    },
  }
}

for (const published of [false, true]) {
  for (const shape of ['inbound', 'background', 'mixed'] as const) {
    test(`prepared transfer retry preserves ${shape} debt ${published ? 'after' : 'before'} publication and dispatches without reboot`, async () => {
      const f = await debtFixture()
      let restore = () => {}
      let dispatcher: RecoveryDispatcher | undefined
      try {
        const debt = await deferredNoticeDebt(f, shape)
        const prompts = f.sessions.map((session) => session.prompts.slice())
        restore = interruptNoticeImport(f.outbox, published)
        await f.router.__testing!.runIdleGc()
        expect(f.router.liveCount()).toBe(1)
        await debt.expectPhase('notice-prepared')
        const frozen = await debt.frozen()
        expect(frozen.text).toBe(LIVE_TURN_ENDED_NOTICE_TEXT)
        expect(await f.outbox.list()).toEqual(published ? [frozen] : [])
        if (published) {
          await expect(
            shape === 'background' ? f.store.validateNotice(frozen) : f.journal.validateNotice(frozen),
          ).rejects.toThrow()
        }
        if (debt.backgroundId) {
          const row = (await f.store.get(debt.backgroundId))!
          expect(row.generation).toBe(frozen.covers.find((cover) => cover.id === debt.backgroundId)!.generation)
          // Standalone preparation retains its stale claim; mixed preparation clears it.
          if (shape === 'background') expect(row.claim!.generation).toBeLessThan(row.generation)
          else expect(row.claim).toBeUndefined()
        }
        await f.router.__testing!.runIdleGc()
        expect(f.router.liveCount()).toBe(1)
        await debt.expectPhase('notice-prepared')
        expect(await debt.frozen()).toEqual(frozen)
        expect(f.journal.health().available).toBe(true)

        restore()
        await f.router.__testing!.runIdleGc()
        expect(f.router.liveCount()).toBe(0)
        await debt.expectPhase('notice-owned')
        expect(await f.outbox.list()).toEqual([frozen])
        expect(await (shape === 'background' ? f.store.validateNotice(frozen) : f.journal.validateNotice(frozen))).toBe(
          'open',
        )
        const errors: unknown[] = []
        dispatcher = new RecoveryDispatcher(f.outbox, f.router, {
          backgroundObligations: f.store,
          inboundJournal: f.journal,
          onError: (error) => errors.push(error),
        })
        await dispatcher.wake()
        await f.noticeTransition(frozen.deliveryId, 'retired').promise
        await dispatcher.stop()
        await debt.expectPhase('closed')
        expect(f.sent).toEqual([frozen.text])
        expect(errors).toEqual([])
        expect(await f.outbox.list()).toEqual([])
        expect(await f.outbox.retired(frozen.deliveryId)).toBeDefined()
        expect((await f.outbox.import(frozen)).state).toBe('delivered')
        await f.router.__testing!.runIdleGc()
        expect(f.sessions.map((session) => session.prompts)).toEqual(prompts)
        expect(f.sessions.every((session) => session.providerRequests === 0)).toBe(true)
        for (const epoch of ['prepared-retry-boot-1', 'prepared-retry-boot-2']) {
          await f.reboot(epoch)
          const recovered = new RecoveryOutbox(f.dir)
          expect((await recovered.list()).some((notice) => notice.deliveryId === frozen.deliveryId)).toBe(false)
          expect((await recovered.import(frozen)).state).toBe('delivered')
        }
        expect(f.sent).toEqual([frozen.text])
      } finally {
        restore()
        await dispatcher?.stop()
        await f.cleanup()
      }
    })
  }
}

for (const shape of ['background', 'mixed'] as const) {
  for (const failure of ['false', 'throw', 'terminal'] as const) {
    test(`prepared transfer retry checks ${shape} ownership ${failure} without losing its retry vehicle`, async () => {
      const f = await debtFixture()
      const ownNotice = f.store.ownNotice.bind(f.store)
      try {
        const debt = await deferredNoticeDebt(f, shape)
        f.store.ownNotice = async () => {
          if (failure === 'throw') throw new Error('controlled ownership write failure')
          return undefined
        }
        await f.router.__testing!.runIdleGc()
        expect(f.router.liveCount()).toBe(1)
        await debt.expectPhase('notice-prepared')
        const frozen = await debt.frozen()
        await f.router.__testing!.runIdleGc()
        expect(f.router.liveCount()).toBe(1)
        expect(await debt.frozen()).toEqual(frozen)
        if (failure === 'terminal') {
          await f.outbox.suppress(frozen.deliveryId, 'user_stop', 'terminal-before-source-ack')
          const terminal = (await f.outbox.list())[0]!
          expect(await f.outbox.retire(terminal.deliveryId, terminal.generation)).toBe(true)
        } else f.store.ownNotice = ownNotice
        await f.router.__testing!.runIdleGc()
        expect(f.router.liveCount()).toBe(0)
        await debt.expectPhase(failure === 'terminal' ? 'closed' : 'notice-owned')
        if (failure !== 'terminal') expect(recoveryPayload(await debt.frozen())).toBe(recoveryPayload(frozen))
        expect((await f.outbox.import(frozen)).state).toBe(failure === 'terminal' ? 'suppressed' : 'pending')
        expect(f.sent).toEqual([])
      } finally {
        f.store.ownNotice = ownNotice
        await f.cleanup()
      }
    })
  }
}

for (const next of ['new request', 'completion wake'] as const) {
  test(`prepared transfer retry precedes ${next} and leaves queued input intact on failure`, async () => {
    const f = await debtFixture()
    let restore = () => {}
    try {
      const debt = await deferredNoticeDebt(f, 'mixed')
      restore = interruptNoticeImport(f.outbox, true)
      await f.router.__testing!.runIdleGc()
      const frozen = await debt.frozen()
      // Stay within freshness: this case exercises consume, not stale rollover.
      f.state.now = 1020
      const parent = f.sessions[0]!
      const prompts = parent.prompts.length
      parent.onPrompt = async () => f.reply(parent, 'Only the new work is answered.')
      let request: string | undefined
      if (next === 'new request') request = await f.route('A completely different question.')
      else await f.complete('child-b')
      await expect(f.flush()).rejects.toThrow('controlled frozen notice import failure')
      expect(parent.prompts).toHaveLength(prompts)
      await debt.expectPhase('notice-prepared')
      if (request) expect(f.inputRow(request)?.phase).toBe('admitted')
      else expect((await f.childRow('child-b'))?.phase).toBe('result-ready')
      restore()
      await f.flush()
      expect(parent.prompts).toHaveLength(prompts + 1)
      await debt.expectPhase('notice-owned')
      expect(await f.outbox.list()).toEqual([frozen])
      if (request) expect(f.inputRow(request)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      else expect(await f.childRow('child-b')).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
      expect(f.sent).toEqual(['Only the new work is answered.'])
    } finally {
      restore()
      await f.cleanup()
    }
  })
}

for (const boundary of ['account replacement', 'stale rollover', 'reload', 'refused handoff'] as const) {
  test(`prepared transfer retry survives ${boundary} with the original frozen principal`, async () => {
    const f = await debtFixture(boundary === 'refused handoff' ? { handoffRetryItemLimit: 0 } : {})
    let restore = () => {}
    try {
      const debt = await deferredNoticeDebt(f, 'mixed')
      const originalPrompts = f.sessions[0]!.prompts.length
      let queuedRequest: string | undefined
      restore = interruptNoticeImport(f.outbox, false)
      if (boundary === 'refused handoff') f.running.set('parent-1', f.state.now)
      if (boundary === 'account replacement') f.state.account = 'account-b'
      if (boundary === 'stale rollover') {
        await f.router.__testing!.runIdleGc()
        f.state.now += SESSION_GRACE_HARD_TTL_MS + 1
        f.state.onSessionCreated = (session) => {
          session.onPrompt = async () => f.reply(session, 'Fresh answer.', 'parent-2')
        }
        await f.route('Fresh question after rollover.')
        await expect(f.flush()).rejects.toThrow('controlled frozen notice import failure')
      } else {
        await expect(f.router.tearDownAllLive()).rejects.toThrow('controlled frozen notice import failure')
        expect(f.router.liveCount()).toBe(1)
        if (boundary === 'reload') {
          f.state.now = 1020
          queuedRequest = await f.route('New input while reload storage is unavailable.')
          await expect(f.flush()).rejects.toThrow('controlled frozen notice import failure')
          expect(f.inputRow(queuedRequest)?.phase).toBe('admitted')
          expect(f.sessions[0]!.prompts).toHaveLength(originalPrompts)
          f.state.successorSessionId = 'parent-2'
          f.state.onSessionCreated = (session) => {
            session.onPrompt = async () => f.reply(session, 'Reloaded answer.', 'parent-2')
          }
        }
        await expect(f.router.tearDownAllLive()).rejects.toThrow('controlled frozen notice import failure')
      }
      await debt.expectPhase('notice-prepared')
      const frozen = await debt.frozen()
      expect(frozen).toMatchObject({
        accountIdentity: 'account-a',
        sourceParentSessionId: 'parent-1',
        principal: { kind: 'channel', lastInboundAuthorId: 'human' },
      })
      restore()
      if (boundary === 'stale rollover') await f.flush()
      else await f.router.tearDownAllLive()
      if (queuedRequest) {
        await f.flush()
        expect(f.inputRow(queuedRequest)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
        expect(f.sessions[0]!.prompts).toHaveLength(originalPrompts)
        expect(f.sessions.at(-1)!.prompts).toHaveLength(1)
      }
      await debt.expectPhase('notice-owned')
      expect(await f.outbox.list()).toEqual([frozen])
      if (boundary === 'account replacement') expect(await f.router.validateRecovery(frozen)).toBeDefined()
      expect(f.logs.some((line) => line.includes('Invalid journal move'))).toBe(false)
    } finally {
      restore()
      await f.cleanup()
    }
  })
}

for (const partition of ['principal', 'account'] as const) {
  test(`prepared transfer retry keeps ${partition} partitions separate after one partition publishes`, async () => {
    const f = await debtFixture({ handoffRetryItemLimit: 0 })
    const original = f.outbox.import.bind(f.outbox)
    try {
      const receipts = []
      for (const author of ['alice', 'bob']) {
        if (partition === 'account' && author === 'bob') f.state.account = 'account-b'
        receipts.push(
          await f.router.route(
            f.inbound(`Question from ${author}`, { authorId: partition === 'principal' ? author : 'human' }),
          ),
        )
      }
      let failed: RecoveryRecord | undefined
      f.outbox.import = async (record) => {
        if (
          partition === 'account'
            ? record.accountIdentity === 'account-b'
            : record.principal.kind === 'channel' && record.principal.lastInboundAuthorId === 'bob'
        ) {
          failed = structuredClone(record)
          throw new Error('controlled partition failure')
        }
        return original(record)
      }
      await expect(f.router.tearDownAllLive()).rejects.toThrow('controlled partition failure')
      expect(f.router.liveCount()).toBe(1)
      const first = (await f.outbox.list())[0]!
      expect(first).toMatchObject({
        accountIdentity: 'account-a',
        principal: { lastInboundAuthorId: partition === 'principal' ? 'alice' : 'human' },
      })
      await expect(f.router.tearDownAllLive()).rejects.toThrow('controlled partition failure')
      expect(await f.outbox.list()).toEqual([first])
      expect(failed).toBeDefined()
      f.outbox.import = original
      await f.router.tearDownAllLive()
      const notices = await f.outbox.list()
      expect(notices.map(recoveryPayload).sort()).toEqual([first, failed!].map(recoveryPayload).sort())
      const ids = receipts.flatMap((receipt) => (receipt.kind === 'accepted' ? [receipt.inputId] : []))
      expect(notices.flatMap((notice) => notice.covers.map((cover) => cover.id)).sort()).toEqual(ids.sort())
      for (const id of ids) expect(f.journal.get(id)?.phase).toBe('notice-owned')
      expect(f.sessions[0]!.prompts).toHaveLength(1)
    } finally {
      f.outbox.import = original
      await f.cleanup()
    }
  })
}

test('prepared transfer retry retires reboxed retry identities before a successor can move them', async () => {
  const f = await debtFixture({ handoffRetryItemLimit: 0 })
  let restore = () => {}
  try {
    const parent = f.sessions[0]!
    parent.onPrompt = async () => {
      await f.router.tearDownAllLive()
      parent.finish('', 'length')
    }
    restore = interruptNoticeImport(f.outbox, true)
    const request = await f.route('Answer this request.')
    await expect(f.flush()).rejects.toThrow('controlled frozen notice import failure')
    expect(f.router.liveCount()).toBe(1)
    const row = f.inputRow(request)
    expect(row?.phase).toBe('notice-prepared')
    if (!row || row.phase !== 'notice-prepared' || !row.transfer) throw new Error('Expected prepared source transfer')
    const frozen = structuredClone(row.transfer)
    const prompts = parent.prompts.length
    await expect(f.flush()).rejects.toThrow('controlled frozen notice import failure')
    expect(parent.prompts).toHaveLength(prompts)
    restore()
    await f.flush()
    expect(f.inputRow(request)?.phase).toBe('notice-owned')
    expect(await f.outbox.list()).toEqual([frozen])
    expect(parent.prompts).toHaveLength(prompts)
    expect(f.logs.some((line) => line.includes('Invalid journal move'))).toBe(false)
    await f.router.tearDownAllLive()
    f.state.successorSessionId = 'parent-2'
    f.state.onSessionCreated = (session) => {
      session.onPrompt = async () => f.reply(session, 'A new answer.', 'parent-2')
    }
    const next = await f.route('A new request.')
    await f.flush()
    expect(f.inputRow(next)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.outbox.list()).toEqual([frozen])
  } finally {
    restore()
    await f.cleanup()
  }
})

for (const published of [false, true]) {
  for (const shape of ['inbound', 'background', 'mixed'] as const) {
    test(`prepared transfer retry cannot resurrect stopped ${shape} debt ${published ? 'after' : 'before'} publication`, async () => {
      const f = await debtFixture()
      let restore = () => {}
      let dispatcher: RecoveryDispatcher | undefined
      try {
        const debt = await deferredNoticeDebt(f, shape)
        restore = interruptNoticeImport(f.outbox, published)
        await f.router.__testing!.runIdleGc()
        const frozen = await debt.frozen()
        // No dispatcher stop handler: withdrawal must not depend on an outbox record.
        await f.route('/stop')
        await debt.expectPhase('closed')
        if (debt.inputId)
          expect(f.journal.get(debt.inputId)).toMatchObject({ outcome: { kind: 'intentionally-suppressed' } })
        if (debt.backgroundId)
          expect(await f.store.get(debt.backgroundId)).toMatchObject({ outcome: { kind: 'intentionally-suppressed' } })
        expect((await f.childRow('child-b'))?.phase).toBe('accepted')
        restore()
        await f.route('/stop')
        await f.router.__testing!.runIdleGc()
        dispatcher = new RecoveryDispatcher(f.outbox, f.router, {
          backgroundObligations: f.store,
          inboundJournal: f.journal,
        })
        await dispatcher.wake()
        if (published) {
          await f.noticeTransition(frozen.deliveryId, 'suppressed').promise
          await dispatcher.stop()
          dispatcher = new RecoveryDispatcher(f.outbox, f.router, {
            backgroundObligations: f.store,
            inboundJournal: f.journal,
          })
          await dispatcher.wake()
          await f.noticeTransition(frozen.deliveryId, 'retired').promise
        }
        await dispatcher.stop()
        expect(f.sent.filter((text) => text === frozen.text)).toEqual([])
        expect(await f.outbox.list()).toEqual([])
        for (const epoch of ['stopped-prepared-1', 'stopped-prepared-2']) {
          await f.reboot(epoch)
          expect(
            (await new RecoveryOutbox(f.dir).list()).some((record) =>
              record.covers.some((cover) => cover.id === debt.inputId || cover.id === debt.backgroundId),
            ),
          ).toBe(false)
        }
      } finally {
        restore()
        await dispatcher?.stop()
        await f.cleanup()
      }
    })
  }
}

test('prepared transfer retry retains an expired handoff until frozen source ownership completes', async () => {
  const f = await debtFixture({ failCreationAttempts: [2], handoffRetryRetentionMs: 50 })
  let restore = () => {}
  try {
    f.deferToChild(f.sessions[0]!, 'child-b')
    const request = await f.route('Keep the expired request owed.')
    await f.flush()
    await f.router.tearDownAllLive()
    expect(f.router.liveCount()).toBe(0)
    f.state.now += 100
    restore = interruptNoticeImport(f.outbox, true)
    await f.router.__testing!.runIdleGc()
    const row = f.inputRow(request)
    expect(row?.phase).toBe('notice-prepared')
    if (!row || row.phase !== 'notice-prepared' || !row.transfer) throw new Error('Expected prepared source transfer')
    const frozen = structuredClone(row.transfer)
    await f.router.__testing!.runIdleGc()
    expect(f.inputRow(request)?.phase).toBe('notice-prepared')
    expect(await f.outbox.list()).toEqual([frozen])
    restore()
    await f.router.__testing!.runIdleGc()
    expect(f.inputRow(request)?.phase).toBe('notice-owned')
    expect(await f.outbox.list()).toEqual([frozen])
    f.state.successorSessionId = 'parent-2'
    f.state.onSessionCreated = (session) => {
      session.onPrompt = async () => f.reply(session, 'Only this new request.', 'parent-2')
    }
    const next = await f.route('New question after expiry.')
    await f.flush()
    expect(f.inputRow(next)).toMatchObject({ phase: 'closed', outcome: { kind: 'delivered' } })
    expect(await f.outbox.list()).toEqual([frozen])
  } finally {
    restore()
    await f.cleanup()
  }
})

for (const decision of ['notice-owned', 'outcome-decided'] as const) {
  test(`prepared transfer retry fails closed when durable ${decision} fails`, async () => {
    const f = await debtFixture()
    let restore = () => {}
    try {
      await deferredNoticeDebt(f, 'mixed')
      restore = interruptNoticeImport(f.outbox, true)
      await f.router.__testing!.runIdleGc()
      restore()
      f.durability.failType = decision
      if (decision === 'notice-owned') await f.router.__testing!.runIdleGc()
      else await f.route('/stop')
      expect(f.journal.health().available).toBe(false)
      expect(() => f.journal.list()).toThrow('frozen')
      expect(() => f.store.assertAvailable()).toThrow('frozen')
      expect(f.router.liveCount()).toBe(1)
      expect(f.logs.some((line) => line.includes('controlled prepared source durability failure'))).toBe(true)
      expect((await f.outbox.list())[0]!.state).toBe('pending')
      expect(f.sent.some((text) => text === LIVE_TURN_ENDED_NOTICE_TEXT)).toBe(false)
    } finally {
      restore()
      await f.cleanup()
    }
  })
}
