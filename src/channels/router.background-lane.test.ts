import { expect, test } from 'bun:test'
import { mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AfterToolCallContext, AfterToolCallResult, StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'

import type { AgentSession } from '@/agent'

import { BackgroundObligationStore } from './background-obligations'
import { createChannelRouter, SESSION_GRACE_HARD_TTL_MS } from './router'
import { defaultHistoryConfig } from './schema'
import type { ChannelKey, InboundMessage } from './types'

const KEY: ChannelKey = { adapter: 'discord-bot', workspace: 'workspace', chat: 'channel', thread: null }

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
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

// The same controlled parent-session boundary as router.test.ts; storage and routing are real.
class ParentSession {
  prompts: string[] = []
  aborted = 0
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
    streamFunction: (() => undefined) as unknown as StreamFn,
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
    this.aborted++
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
      message: assistant(text, stopReason),
    }
  }
}

async function fixture(
  onDurability?: NonNullable<ConstructorParameters<typeof BackgroundObligationStore>[1]>['onDurability'],
) {
  const dir = await mkdtemp(join(tmpdir(), 'router-background-lane-'))
  const store = new BackgroundObligationStore(dir, {
    epoch: 'lane-regression',
    ...(onDurability ? { onDurability } : {}),
  })
  const sessions: ParentSession[] = []
  const sent: string[] = []
  const logs: string[] = []
  let now = 1000
  let messageId = 0
  const router = createChannelRouter({
    agentDir: dir,
    backgroundObligations: store,
    now: () => now,
    configForAdapter: () => ({
      enabled: true,
      history: defaultHistoryConfig(),
      engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
    }),
    permissions: {
      has: () => true,
      resolveRole: () => 'owner',
      compareRoleSeverity: () => 1,
      permissionsForRole: () => undefined,
      describe: () => ({ role: 'owner', permissions: ['channel.respond'] }),
      replaceRoles: () => {},
    },
    logger: { info: (text) => logs.push(text), warn: (text) => logs.push(text), error: (text) => logs.push(text) },
    createSessionForChannel: async ({ existingSessionId }) => {
      const session = new ParentSession()
      sessions.push(session)
      return {
        session: session as unknown as AgentSession,
        sessionId: existingSessionId ?? `parent-${sessions.length}`,
        dispose: async () => {},
      }
    },
  })
  router.registerOutbound(KEY.adapter, async (message) => {
    sent.push(message.text ?? '')
    return { ok: true }
  })
  function inbound(text: string): InboundMessage {
    return {
      ...KEY,
      text,
      externalMessageId: `message-${++messageId}`,
      authorId: 'human',
      authorName: 'Human',
      authorIsBot: false,
      isBotMention: true,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: now,
    }
  }
  const flush = () => router.__testing!.flushDebounce(KEY)
  await router.route(inbound('open parent'))
  await flush()
  async function accept(taskId: string) {
    return router.acceptBackgroundResponse({
      parentSessionId: 'parent-1',
      key: KEY,
      taskId,
      subagentName: 'explorer',
      startedAt: now,
      accountIdentity: 'test-account',
      triggeringAuthorId: 'human',
    })
  }
  const complete = (taskId: string) =>
    router.injectSubagentCompletionReminder({
      parentSessionId: 'parent-1',
      channelKey: KEY,
      taskId,
      subagent: 'explorer',
      ok: true,
      durationMs: 20,
    })
  async function reply(session: ParentSession, text: string, parentSessionId = 'parent-1') {
    const backgroundCoverage = await router.captureBackgroundResultCoverage!(parentSessionId)
    expect((await router.send({ ...KEY, text })).ok).toBe(true)
    await session.agent.afterToolCall!({
      assistantMessage: assistant(''),
      toolCall: { type: 'toolCall', id: 'reply', name: 'channel_reply', arguments: { text } },
      args: { text },
      result: { content: [{ type: 'text', text: 'sent' }], details: { ok: true, backgroundCoverage } },
      isError: false,
      context: { messages: [] },
    } as AfterToolCallContext)
    session.finish(text, 'aborted')
  }
  async function independent(label: string) {
    for (const session of sessions)
      session.onPrompt = async () => {
        session.finish('NO_REPLY')
      }
    await router.route(inbound(label))
    await flush()
    expect(sessions.flatMap((session) => session.prompts).some((prompt) => prompt.includes(label))).toBe(true)
  }
  return {
    dir,
    store,
    router,
    sessions,
    sent,
    logs,
    inbound,
    flush,
    accept,
    complete,
    reply,
    independent,
    advance: () => {
      now += SESSION_GRACE_HARD_TTL_MS + 1
    },
  }
}

test('an active parent fetch retires its queued completion before terminal reply and later human input', async () => {
  const f = await fixture()
  try {
    const ref = await f.accept('queued-fetch')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const parent = f.sessions[0]!
    parent.onPrompt = async () => {
      entered.resolve()
      await release.promise
      await f.router.attachBackgroundResultCoverage({ parentSessionId: 'parent-1', taskId: 'queued-fetch' })
      await f.reply(parent, 'Final result is 42.')
    }
    await f.router.route(f.inbound('active question'))
    const drain = f.flush()
    await entered.promise
    await f.complete('queued-fetch')
    release.resolve()
    await drain
    await f.flush()
    expect((await f.store.get(ref.obligationId))?.phase).toBe('closed')
    expect(f.sent).toEqual(['Final result is 42.'])
    await f.independent('unrelated human question after fetch')
    expect(f.logs.some((log) => log.includes('Invalid background'))).toBe(false)
  } finally {
    await f.router.stop()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('stop waits for an in-flight real claim and withdraws its current generation without another notice', async () => {
  const f = await fixture()
  try {
    const ref = await f.accept('stop-claim')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const claim = f.store.claim.bind(f.store)
    f.store.claim = async (...args) => {
      entered.resolve()
      await release.promise
      return claim(...args)
    }
    const parent = f.sessions[0]!
    parent.onPrompt = async () => {
      if (!parent.agent.signal.aborted)
        await new Promise<void>((resolve) =>
          parent.agent.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      parent.finish('NO_REPLY')
    }
    await f.complete('stop-claim')
    await entered.promise
    const stopLaneRequested = Promise.withResolvers<void>()
    const withTargetLane = f.store.withTargetLane.bind(f.store)
    f.store.withTargetLane = (target, action) => {
      stopLaneRequested.resolve()
      return withTargetLane(target, action)
    }
    const stopping = f.router.route(f.inbound('/stop'))
    await stopLaneRequested.promise
    release.resolve()
    await stopping
    await f.flush()
    expect(parent.aborted).toBeGreaterThan(0)
    const row = await f.store.get(ref.obligationId)
    expect(row?.phase).toBe('closed')
    expect(row?.outcome?.kind).toBe('intentionally-suppressed')
    expect(row?.applications.at(-1)?.expectedGeneration).toBe(row!.claim!.generation)
    expect(f.sent).toEqual(['Stopped the current turn.'])
    await f.independent('unrelated human question after claim stop')
    expect(f.sent).toEqual(['Stopped the current turn.'])
  } finally {
    await f.router.stop()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('a genuine filesystem settlement failure reports an error but stop still aborts and later input progresses', async () => {
  let obstructed = false
  let failSettlement = false
  const f = await fixture(async (phase, row) => {
    if (!failSettlement || phase !== 'temp-synced' || row.phase !== 'closed') return
    await rename(directory, saved)
    await writeFile(directory, 'not a directory')
    obstructed = true
  })
  const directory = join(f.dir, 'channels', 'background-obligations')
  const saved = `${directory}-saved`
  try {
    const ref = await f.accept('stop-write-failure')
    const entered = Promise.withResolvers<void>()
    const parent = f.sessions[0]!
    parent.onPrompt = async () => {
      await f.router.attachBackgroundResultCoverage({ parentSessionId: 'parent-1', taskId: 'stop-write-failure' })
      entered.resolve()
      await new Promise<void>((resolve) =>
        parent.agent.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      parent.finish('NO_REPLY')
    }
    await f.router.route(f.inbound('fetch before stop'))
    const drain = f.flush()
    await entered.promise
    // The real closed-row temp file is synced; obstruct its rename, not a mocked settle call.
    failSettlement = true
    let error: unknown
    try {
      await f.router.route(f.inbound('/stop'))
    } catch (caught) {
      error = caught
    }
    expect(parent.aborted).toBeGreaterThan(0)
    expect(error !== undefined || f.logs.some((log) => /ENOTDIR|background.*fail|stop.*fail/i.test(log))).toBe(true)
    expect(obstructed).toBe(true)
    await unlink(directory)
    await rename(saved, directory)
    obstructed = false
    failSettlement = false
    await drain
    expect((await f.store.get(ref.obligationId))?.phase).toBe('turn-owned')
    await f.independent('unrelated human question after failed withdrawal')
  } finally {
    if (obstructed) {
      await unlink(directory)
      await rename(saved, directory)
    }
    await f.router.stop()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('seed 0x5eedc0de: randomized claim/fetch/settle/stop/rollover schedules never starve independent input', async () => {
  let state = 0x5eedc0de
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  for (let scenario = 0; scenario < 24; scenario++) {
    const f = await fixture()
    try {
      const taskId = `seeded-${scenario}`
      const ref = await f.accept(taskId)
      if ((random() & 1) === 1) {
        f.advance()
        await f.independent(`independent seed scenario ${scenario} rollover before completion`)
        expect(f.sessions.length).toBe(2)
      }
      const actions = ['fetch', 'settle', 'stop', 'rollover'] as const
      const order = [...actions]
      for (let i = order.length - 1; i > 0; i--) {
        const j = random() % (i + 1)
        const previous = order[i]!
        order[i] = order[j]!
        order[j] = previous
      }
      const claimFirst = (random() & 1) === 1
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const parent = f.sessions.at(-1)!
      const parentSessionId = `parent-${f.sessions.length}`
      parent.onPrompt = async () => {
        entered.resolve()
        await release.promise
        for (const action of order) {
          if (parent.agent.signal.aborted) break
          if (action === 'fetch') await f.router.attachBackgroundResultCoverage({ parentSessionId, taskId })
          if (action === 'settle')
            await f.router.markTurnSkipped({ parentSessionId, reason: 'seeded explicit suppression' })
          if (action === 'stop') await f.router.route(f.inbound('/stop'))
          if (action === 'rollover') await f.router.tearDownAllLive()
          const row = await f.store.get(ref.obligationId)
          if (row?.phase === 'turn-owned') expect(row.claim?.generation).toBe(row.generation)
          if (row?.phase === 'closed') expect(row.outcome?.kind).toBe('intentionally-suppressed')
          if (row?.phase === 'turn-owned' || row?.phase === 'closed') {
            expect(f.router.__testing!.pendingReminderCount(KEY) ?? 0).toBe(0)
          }
        }
        parent.finish('NO_REPLY')
      }
      let drain: Promise<void>
      if (claimFirst) {
        await f.complete(taskId)
        drain = f.flush()
      } else {
        await f.router.route(f.inbound('active seeded prompt'))
        drain = f.flush()
        await entered.promise
        await f.complete(taskId)
      }
      await entered.promise
      release.resolve()
      await drain
      await f.flush()
      expect((await f.store.get(ref.obligationId))?.phase).toBe('closed')
      expect(f.router.__testing!.pendingReminderCount(KEY) ?? 0).toBe(0)
      await f.independent(`independent seed scenario ${scenario} before rollover`)
      const count = f.sessions.length
      f.advance()
      await f.independent(`independent seed scenario ${scenario} after rollover`)
      expect(f.sessions.length).toBe(count + 1)
      expect(f.logs.some((log) => log.includes('Invalid background'))).toBe(false)
    } finally {
      await f.router.stop()
      await rm(f.dir, { recursive: true, force: true })
    }
  }
}, 30_000)
