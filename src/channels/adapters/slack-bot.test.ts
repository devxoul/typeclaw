import { describe, expect, test } from 'bun:test'

import type { SlackBotClient, SlackBotListener, SlackFile, SlackMessage } from 'agent-messenger/slackbot'

import { MEMBERSHIP_CACHE_TRANSIENT_TTL_MS } from '@/channels/membership'
import type { ChannelRouter } from '@/channels/router'
import { channelsSchema, defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { ChannelKey, FetchHistoryResult, HistoryCallback, OutboundMessage } from '@/channels/types'
import { SLACK_APP_MANIFEST } from '@/cli/ui'

import {
  createOutboundCallback,
  createSlackBotAdapter,
  createSlackHistoryCallback,
  createSlackListCallback,
  createSlackMembershipResolver,
  createSlackMessageGetCallback,
  createSlackReferenceFetch,
  createSlackTypingTracker,
  createSlashCommandHandler,
  createThreadCommandHandler,
  createTypingCallback,
  promoteAppMentionToMessage,
  SLACK_HISTORY_LIMIT_MAX,
  SLACK_SLASH_COMMAND_NAMES,
} from './slack-bot'
import { classifyInbound, type SlackInboundAppMentionEvent } from './slack-bot-classify'
import { createSlackDedupe } from './slack-bot-dedupe'
import { encodeSlackReactionRef } from './slack-bot-reactions'

class FakeSlackBotListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()

  on(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  async start(): Promise<void> {}

  stop(): void {}

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
}

function lifecycleRouter(): ChannelRouter {
  const noop = (): void => {}
  return {
    route: async () => {},
    executeCommand: async () => ({ kind: 'unknown-command' }),
    registerOutbound: noop,
    unregisterOutbound: noop,
    registerReaction: noop,
    unregisterReaction: noop,
    registerRemoveReaction: noop,
    unregisterRemoveReaction: noop,
    registerTyping: noop,
    unregisterTyping: noop,
    setTypingCapability: noop,
    registerChannelNameResolver: noop,
    unregisterChannelNameResolver: noop,
    registerSelfIdentity: noop,
    unregisterSelfIdentity: noop,
    registerMembership: noop,
    unregisterMembership: noop,
    registerHistory: noop,
    unregisterHistory: noop,
    registerMessageGet: noop,
    unregisterMessageGet: noop,
    registerList: noop,
    unregisterList: noop,
    registerEditMessage: noop,
    unregisterEditMessage: noop,
    registerFetchAttachment: noop,
    unregisterFetchAttachment: noop,
  } as unknown as ChannelRouter
}

describe('createSlackBotAdapter', () => {
  test('reports Socket Mode disconnects and reconnects independently of authenticated identity', async () => {
    const listener = new FakeSlackBotListener()
    const adapter = createSlackBotAdapter({
      router: lifecycleRouter(),
      configRef: () => channelsSchema.parse({ 'slack-bot': {} })['slack-bot']!,
      token: 'xoxb-test',
      appToken: 'xapp-test',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createClient: () =>
        ({
          login: async () => {},
          testAuth: async () => ({ user_id: 'U0123456789', team_id: 'T0123456789' }),
        }) as unknown as SlackBotClient,
      createListener: () => listener as unknown as SlackBotListener,
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(false)

    listener.emit('connected', { app_id: 'A0123456789' })
    expect(adapter.isConnected()).toBe(true)

    listener.emit('error', { code: 'socket_error' })
    expect(adapter.isConnected()).toBe(true)

    listener.emit('disconnected', undefined)
    expect(adapter.isConnected()).toBe(false)

    listener.emit('connected', { app_id: 'A0123456789' })
    expect(adapter.isConnected()).toBe(true)

    listener.emit('error', { code: 'disconnect_terminal' })
    expect(adapter.isConnected()).toBe(false)

    listener.emit('connected', { app_id: 'A0123456789' })
    expect(adapter.isConnected()).toBe(true)

    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
  })
})

describe('slack-bot createTypingCallback', () => {
  type SetStatusCall = { channel: string; threadTs: string; status: string }
  type ClearCall = { chat: string; thread: string | null | undefined }

  function makeFakeTracker(behavior: 'ok' | 'reject' = 'ok'): {
    tracker: {
      setStatus: (chat: string, threadTs: string, status: string) => Promise<void>
      clearAfterSend: (chat: string, thread: string | null | undefined) => Promise<void>
    }
    calls: SetStatusCall[]
    clears: ClearCall[]
  } {
    const calls: SetStatusCall[] = []
    const clears: ClearCall[] = []
    return {
      calls,
      clears,
      tracker: {
        setStatus: async (channel, threadTs, status) => {
          calls.push({ channel, threadTs, status })
          if (behavior === 'reject') throw new Error('channel_not_found')
        },
        clearAfterSend: async (chat, thread) => {
          clears.push({ chat, thread })
        },
      },
    }
  }

  test('calls tracker.setStatus with chat + thread when target is in a thread', async () => {
    // given
    const { tracker, calls } = makeFakeTracker()
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    await cb({
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      chat: 'C0CHANNEL',
      thread: '1700000000.000100',
      phase: 'tick',
    })
    // then
    expect(calls).toEqual([{ channel: 'C0CHANNEL', threadTs: '1700000000.000100', status: 'is typing...' }])
  })

  test('calls setStatus on a flat DM using typingThread when thread is null', async () => {
    // given
    const { tracker, calls } = makeFakeTracker()
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    await cb({
      adapter: 'slack-bot',
      workspace: '@dm',
      chat: 'D0DM',
      thread: null,
      typingThread: '1700000000.000100',
      phase: 'tick',
    })
    // then
    expect(calls).toEqual([{ channel: 'D0DM', threadTs: '1700000000.000100', status: 'is typing...' }])
  })

  test('phase=stop on a flat DM clears using typingThread', async () => {
    // given
    const { tracker, calls, clears } = makeFakeTracker()
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    await cb({
      adapter: 'slack-bot',
      workspace: '@dm',
      chat: 'D0DM',
      thread: null,
      typingThread: '1700000000.000100',
      phase: 'stop',
    })
    // then
    expect(calls).toHaveLength(0)
    expect(clears).toEqual([{ chat: 'D0DM', thread: '1700000000.000100' }])
  })

  test('typingThread takes precedence over thread when both are present', async () => {
    // given
    const { tracker, calls } = makeFakeTracker()
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    await cb({
      adapter: 'slack-bot',
      workspace: '@dm',
      chat: 'D0DM',
      thread: '1700000000.000999',
      typingThread: '1700000000.000100',
      phase: 'tick',
    })
    // then
    expect(calls).toEqual([{ channel: 'D0DM', threadTs: '1700000000.000100', status: 'is typing...' }])
  })

  test('is a no-op (logs info, no API call) for top-level chats without a thread', async () => {
    // given
    const { tracker, calls } = makeFakeTracker()
    const infos: string[] = []
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null, phase: 'tick' })
    // then
    expect(calls).toHaveLength(0)
    expect(infos.some((m) => m.includes('top-level chat'))).toBe(true)
  })

  test('warns (does not throw) when Slack rejects the API call', async () => {
    // given
    const calls: SetStatusCall[] = []
    const warns: string[] = []
    const tracker = createSlackTypingTracker({
      client: {
        setAssistantStatus: async (channel, threadTs, status) => {
          calls.push({ channel, threadTs, status })
          throw new Error('channel_not_found')
        },
      },
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    // when
    await cb({
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      chat: 'C0CHANNEL',
      thread: '1700000000.000100',
      phase: 'tick',
    })
    // then
    expect(calls).toHaveLength(1)
    expect(warns.some((m) => m.includes('typing') && m.includes('channel_not_found'))).toBe(true)
  })

  test('rejects non-slack adapter without API call or logging', async () => {
    // given
    const { tracker, calls } = makeFakeTracker()
    const infos: string[] = []
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'discord-bot', workspace: '1', chat: '2', thread: '3', phase: 'tick' })
    // then
    expect(calls).toHaveLength(0)
    expect(infos).toHaveLength(0)
  })

  test('phase=stop in a thread routes to clearAfterSend (not setStatus)', async () => {
    // given
    const { tracker, calls, clears } = makeFakeTracker()
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    await cb({
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      chat: 'C0CHANNEL',
      thread: '1700000000.000100',
      phase: 'stop',
    })
    // then
    expect(calls).toHaveLength(0)
    expect(clears).toEqual([{ chat: 'C0CHANNEL', thread: '1700000000.000100' }])
  })

  test('phase=stop on a top-level chat is a silent no-op (no clearAfterSend, no log)', async () => {
    // given
    const { tracker, calls, clears } = makeFakeTracker()
    const infos: string[] = []
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    })
    // when
    await cb({ adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null, phase: 'stop' })
    // then
    expect(calls).toHaveLength(0)
    expect(clears).toHaveLength(0)
    expect(infos).toHaveLength(0)
  })

  test('flat DM tick then stop ends cleared even when the tick tag resolves last', async () => {
    // Reproduces the router's call order after a reply: a re-arm 'tick' fires
    // (fire-and-forget) then the turn-end 'stop' fires. The bug let a slow
    // formatChannelTag on the tick defer its FIFO enqueue past the stop's
    // clear, stranding "is typing...". The real FIFO is wired in to assert the
    // observable Slack status, not an internal call order.
    // given
    const statuses: string[] = []
    const tracker = createSlackTypingTracker({
      client: { setAssistantStatus: async (_chat, _thread, status) => void statuses.push(status) },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const tagGates: Array<() => void> = []
    const cb = createTypingCallback({
      typingTracker: tracker,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      formatChannelTag: () => new Promise<string>((resolve) => tagGates.push(() => resolve('tag'))),
    })
    const dm = { adapter: 'slack-bot' as const, workspace: '@dm', chat: 'D0DM', thread: null }
    const anchor = '1700000000.000100'

    // when: tick enters first, stop second (router order)
    const tickDone = cb({ ...dm, typingThread: anchor, phase: 'tick' })
    const stopDone = cb({ ...dm, typingThread: anchor, phase: 'stop' })
    // resolve tags in REVERSE: stop's tag first, tick's tag last
    tagGates[1]?.()
    tagGates[0]?.()
    await Promise.all([tickDone, stopDone])

    // then: regardless of tag timing, the last status on the wire is the clear
    expect(statuses.at(-1)).toBe('')
  })
})

describe('createSlackTypingTracker', () => {
  type SetStatusCall = { channel: string; threadTs: string; status: string }

  function makeDeferredClient(): {
    client: { setAssistantStatus: (channel: string, threadTs: string, status: string) => Promise<void> }
    calls: SetStatusCall[]
    pending: Array<{ resolve: () => void; reject: (err: Error) => void }>
    settledOrder: string[]
  } {
    const calls: SetStatusCall[] = []
    const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
    const settledOrder: string[] = []
    return {
      calls,
      pending,
      settledOrder,
      client: {
        setAssistantStatus: (channel, threadTs, status) => {
          calls.push({ channel, threadTs, status })
          const idx = calls.length - 1
          return new Promise<void>((resolve, reject) => {
            pending.push({
              resolve: () => {
                settledOrder.push(`${idx}:${status}`)
                resolve()
              },
              reject,
            })
          })
        },
      },
    }
  }

  // Flush all pending microtasks so chained `.then()` continuations run
  // before the next assertion. The tracker queues calls via promise
  // chaining, so the first client call is reached on the next microtask
  // tick rather than synchronously.
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  test('serializes calls per (chat, thread) so an explicit clear lands AFTER an in-flight typing call', async () => {
    // given
    const { client, pending, settledOrder } = makeDeferredClient()
    const tracker = createSlackTypingTracker({
      client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    // when
    const typingPromise = tracker.setStatus('C0', 'T0', 'is typing...')
    const clearPromise = tracker.clearAfterSend('C0', 'T0')
    await flushMicrotasks()
    expect(pending).toHaveLength(1)
    pending[0]!.resolve()
    await typingPromise
    await flushMicrotasks()
    expect(pending).toHaveLength(2)
    pending[1]!.resolve()
    await clearPromise
    // then
    expect(settledOrder).toEqual(['0:is typing...', '1:'])
  })

  test('does not block calls for a different (chat, thread) pair', async () => {
    // given
    const { client, pending } = makeDeferredClient()
    const tracker = createSlackTypingTracker({
      client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const a = tracker.setStatus('C0', 'T0', 'is typing...')
    // when
    const b = tracker.setStatus('C0', 'T1', 'is typing...')
    const c = tracker.setStatus('C1', 'T0', 'is typing...')
    await flushMicrotasks()
    // then
    expect(pending).toHaveLength(3)
    pending[0]!.resolve()
    pending[1]!.resolve()
    pending[2]!.resolve()
    await Promise.all([a, b, c])
  })

  test('clearAfterSend with no thread is a no-op (top-level chats have no typing indicator)', async () => {
    const { client, calls } = makeDeferredClient()
    const tracker = createSlackTypingTracker({
      client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await tracker.clearAfterSend('C0', null)
    await tracker.clearAfterSend('C0', undefined)
    await tracker.clearAfterSend('C0', '')
    expect(calls).toHaveLength(0)
  })

  test('a failing typing call does not poison the queue for the next call', async () => {
    // given
    const { client, pending } = makeDeferredClient()
    const warns: string[] = []
    const tracker = createSlackTypingTracker({
      client,
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    const first = tracker.setStatus('C0', 'T0', 'is typing...')
    const second = tracker.clearAfterSend('C0', 'T0')
    await flushMicrotasks()
    expect(pending).toHaveLength(1)
    pending[0]!.reject(new Error('channel_not_found'))
    await first
    await flushMicrotasks()
    // when
    expect(pending).toHaveLength(2)
    pending[1]!.resolve()
    await second
    // then
    expect(warns.some((m) => m.includes('channel_not_found'))).toBe(true)
  })
})

describe('createSlackMembershipResolver', () => {
  type FetchCall = { url: string; init: RequestInit }
  type HistoryCall = { chat: string; thread: string | null; limit: number }

  function fakeFetch(responses: Response[]): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return responses.shift() ?? slackResponse({ ok: false, error: 'rate_limited' })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  function slackResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function fakeHistory(result: FetchHistoryResult | (() => Promise<FetchHistoryResult>)): {
    cb: HistoryCallback
    calls: HistoryCall[]
  } {
    const calls: HistoryCall[] = []
    const cb: HistoryCallback = async (args) => {
      calls.push({ chat: args.chat, thread: args.thread, limit: args.limit })
      return typeof result === 'function' ? await result() : result
    }
    return { cb, calls }
  }

  function emptyHistory(): HistoryCallback {
    return fakeHistory({ ok: true, messages: [] }).cb
  }

  test('DM short-circuits without hitting Slack or history', async () => {
    const { fn, calls } = fakeFetch([])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 10,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: '@dm', chat: 'D1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 10,
      truncated: false,
    })
    expect(calls).toHaveLength(0)
  })

  test('MPIM classification drives real multi-human membership enumeration', async () => {
    const verdict = classifyInbound(
      {
        type: 'message',
        channel: 'G0MPIM',
        channel_type: 'mpim',
        user: 'U1',
        text: '함께 확인해 주세요',
        ts: '1700000000.000100',
      },
      {
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      },
      { teamId: 'T1', botUserId: 'UBOT' },
    )
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    const { fn } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 3 } }),
      slackResponse({ ok: true, members: ['U1', 'U2', 'UBOT'] }),
      slackResponse({ ok: true, members: [{ id: 'UBOT', is_bot: true }] }),
    ])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 15,
    })

    await expect(
      resolver({
        adapter: verdict.payload.adapter,
        workspace: verdict.payload.workspace,
        chat: verdict.payload.chat,
        thread: verdict.payload.thread,
      }),
    ).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 15,
      truncated: false,
      humanMemberIds: ['U1', 'U2'],
    })
  })

  test('small channel classifies members against the bulk users.list bot set', async () => {
    const { fn, calls } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 3 } }),
      slackResponse({ ok: true, members: ['U1', 'UBOT', 'U2'] }),
      slackResponse({
        ok: true,
        members: [
          { id: 'UBOT', is_bot: true },
          { id: 'U2', is_bot: false },
        ],
      }),
    ])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 20,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 20,
      truncated: false,
      humanMemberIds: ['U1', 'U2'],
    })
    expect(calls.map((c) => c.url)).toEqual([
      'https://slack.com/api/conversations.info',
      'https://slack.com/api/conversations.members',
      'https://slack.com/api/users.list',
    ])
  })

  test('classifies members with no per-member users.info when the bot set covers them', async () => {
    const { fn, calls } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 4 } }),
      slackResponse({ ok: true, members: ['U1', 'U2', 'UBOT', 'U3'] }),
      slackResponse({ ok: true, members: [{ id: 'UBOT', is_bot: true }] }),
    ])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 30,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toMatchObject({
      humans: 3,
      bots: 1,
      humanMemberIds: ['U1', 'U2', 'U3'],
    })
    expect(calls.filter((c) => c.url.endsWith('/users.info'))).toHaveLength(0)
  })

  test('a lurking bot never seen in history is still counted via the bulk set', async () => {
    const { fn } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 2 } }),
      slackResponse({ ok: true, members: ['U_HUMAN', 'U_LURKER_BOT'] }),
      slackResponse({ ok: true, members: [{ id: 'U_LURKER_BOT', is_bot: true }] }),
    ])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 30,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toMatchObject({
      humans: 1,
      bots: 1,
      humanMemberIds: ['U_HUMAN'],
    })
  })

  test('reuses the bulk bot set across calls instead of re-fetching users.list', async () => {
    const { fn, calls } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 2 } }),
      slackResponse({ ok: true, members: ['U1', 'UBOT'] }),
      slackResponse({ ok: true, members: [{ id: 'UBOT', is_bot: true }] }),
      slackResponse({ ok: true, channel: { num_members: 2 } }),
      slackResponse({ ok: true, members: ['U1', 'UBOT'] }),
    ])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 40,
    })

    const key = { adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null } as const
    await resolver(key)
    await resolver(key)

    expect(calls.filter((c) => c.url.endsWith('/users.list'))).toHaveLength(1)
  })

  test('falls back to per-member users.info when users.list fails', async () => {
    const { fn, calls } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 2 } }),
      slackResponse({ ok: true, members: ['U1', 'UBOT'] }),
      slackResponse({ ok: false, error: 'ratelimited' }),
      slackResponse({ ok: true, user: { is_bot: false } }),
      slackResponse({ ok: true, user: { is_bot: true } }),
    ])
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 50,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toMatchObject({
      humans: 1,
      bots: 1,
      humanMemberIds: ['U1'],
    })
    expect(calls.filter((c) => c.url.endsWith('/users.info'))).toHaveLength(2)
  })

  test('does not cache a transient users.info failure (retries on the next read)', async () => {
    const { fn, calls } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 1 } }),
      slackResponse({ ok: true, members: ['UBOT'] }),
      slackResponse({ ok: false, error: 'ratelimited' }),
      // users.list fails -> fall back to users.info for UBOT, which also fails
      // transiently the first time, then succeeds (is_bot true) on retry.
      slackResponse({ ok: false, error: 'ratelimited' }),
      slackResponse({ ok: true, channel: { num_members: 1 } }),
      slackResponse({ ok: true, members: ['UBOT'] }),
      slackResponse({ ok: false, error: 'ratelimited' }),
      slackResponse({ ok: true, user: { is_bot: true } }),
    ])
    let clock = 0
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => clock,
    })
    const key = { adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null } as const

    // first read: transient failure must NOT memoize UBOT as human
    await expect(resolver(key)).resolves.toMatchObject({ humans: 1, bots: 0 })
    // advance past the users.list negative-cache cooldown so the next read retries
    clock = MEMBERSHIP_CACHE_TRANSIENT_TTL_MS + 1
    await expect(resolver(key)).resolves.toMatchObject({ humans: 0, bots: 1, humanMemberIds: [] })
    void calls
  })

  test('negative-caches a users.list failure instead of re-crawling every read', async () => {
    const calls: string[] = []
    const fn = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      if (url.endsWith('/conversations.info')) return slackResponse({ ok: true, channel: { num_members: 1 } })
      if (url.endsWith('/conversations.members')) return slackResponse({ ok: true, members: ['U1'] })
      if (url.endsWith('/users.list')) return slackResponse({ ok: false, error: 'ratelimited' })
      if (url.endsWith('/users.info')) return slackResponse({ ok: true, user: { is_bot: false } })
      return slackResponse({ ok: false, error: 'unexpected' })
    }) as unknown as typeof fetch

    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 0,
    })
    const key = { adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null } as const

    await resolver(key)
    await resolver(key)
    await resolver(key)

    // users.list attempted once within the cooldown, not once per read
    expect(calls.filter((u) => u.endsWith('/users.list'))).toHaveLength(1)
  })

  test('does not reuse a bot set warmed for one workspace to classify another', async () => {
    const usersListCalls: string[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/conversations.info')) return slackResponse({ ok: true, channel: { num_members: 1 } })
      if (url.endsWith('/conversations.members')) return slackResponse({ ok: true, members: ['UBOT'] })
      if (url.endsWith('/users.list')) {
        const body = String((init?.body as string | undefined) ?? '')
        usersListCalls.push(body)
        // UBOT is a bot in workspace A only; in B it is an unknown (human).
        return usersListCalls.length === 1
          ? slackResponse({ ok: true, members: [{ id: 'UBOT', is_bot: true }] })
          : slackResponse({ ok: true, members: [] })
      }
      return slackResponse({ ok: false, error: 'unexpected' })
    }) as unknown as typeof fetch

    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 0,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'A', chat: 'C1', thread: null })).resolves.toMatchObject({
      bots: 1,
      humans: 0,
    })
    await expect(resolver({ adapter: 'slack-bot', workspace: 'B', chat: 'C1', thread: null })).resolves.toMatchObject({
      bots: 0,
      humans: 1,
    })
    expect(usersListCalls).toHaveLength(2)
  })

  test('large channel (>cap) falls back to history-derived count', async () => {
    const { fn, calls } = fakeFetch([slackResponse({ ok: true, channel: { num_members: 80 } })])
    const { cb, calls: historyCalls } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'UALICE',
          authorName: 'alice',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'BBOT',
          authorName: 'bot',
          text: 'beep',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 30,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 30,
      truncated: true,
    })
    expect(calls).toHaveLength(1)
    expect(historyCalls).toEqual([{ chat: 'C1', thread: null, limit: 100 }])
  })

  test('missing_scope on conversations.info falls back to history-derived count', async () => {
    const { fn } = fakeFetch([slackResponse({ ok: false, error: 'missing_scope' })])
    const { cb } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'UALICE',
          authorName: 'alice',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 40,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 0,
      fetchedAt: 40,
      truncated: true,
    })
  })

  test('not_in_channel on conversations.members falls back to history-derived count', async () => {
    const { fn } = fakeFetch([
      slackResponse({ ok: true, channel: { num_members: 3 } }),
      slackResponse({ ok: false, error: 'not_in_channel' }),
    ])
    const { cb } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'UDEV',
          authorName: 'dev',
          text: 'q',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'BBOT',
          authorName: 'b',
          text: 'a',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 50,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 50,
      truncated: true,
    })
  })

  test('rate-limit style errors return transient failures (no fallback)', async () => {
    const { fn } = fakeFetch([slackResponse({ ok: false, error: 'rate_limited' })])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      kind: 'transient',
    })
    expect(historyCalls).toHaveLength(0)
  })

  test('permanent failure + history failure surfaces transient (cache retries soon)', async () => {
    const { fn } = fakeFetch([slackResponse({ ok: false, error: 'missing_scope' })])
    const { cb } = fakeHistory({ ok: false, error: 'boom' })
    const resolver = createSlackMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
    })

    await expect(resolver({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null })).resolves.toEqual({
      kind: 'transient',
    })
  })
})

describe('slack-bot promoteAppMentionToMessage', () => {
  const baseAppMention: SlackInboundAppMentionEvent = {
    type: 'app_mention',
    channel: 'C0CHANNEL',
    user: 'UALICE',
    text: '<@UBOT> hi there',
    ts: '1700000000.000100',
  }

  test('produces a message-shaped event suitable for the classifier', () => {
    const promoted = promoteAppMentionToMessage(baseAppMention)

    expect(promoted.type).toBe('message')
    expect(promoted.channel).toBe('C0CHANNEL')
    expect(promoted.channel_type).toBe('channel')
    expect(promoted.user).toBe('UALICE')
    expect(promoted.text).toBe('<@UBOT> hi there')
    expect(promoted.ts).toBe('1700000000.000100')
  })

  test('preserves thread_ts when present so threaded mentions stay threaded', () => {
    const promoted = promoteAppMentionToMessage({ ...baseAppMention, thread_ts: '1699999999.000099' })

    expect(promoted.thread_ts).toBe('1699999999.000099')
  })

  test('promoted event classifies as a routed mention end-to-end', () => {
    const promoted = promoteAppMentionToMessage(baseAppMention)
    const verdict = classifyInbound(
      promoted,
      {
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      },
      { teamId: 'T0ACME', botUserId: 'UBOT' },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      chat: 'C0CHANNEL',
      isBotMention: true,
      isDm: false,
    })
  })
})

describe('createSlackHistoryCallback', () => {
  type FetchCall = { url: string; init: RequestInit }

  function fakeFetch(response: unknown): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function permissiveConfig(): ChannelAdapterConfig {
    return {
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }
  }

  test('uses conversations.replies when thread is set, with channel + ts in the body', async () => {
    // given
    const { fn, calls } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1700000000.000100', user: 'UALICE', text: 'parent', thread_ts: '1700000000.000100' },
        { ts: '1700000001.000200', user: 'UBOB', text: 'reply', thread_ts: '1700000000.000100' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'xoxb-tok',
      logger: silentLogger(),
      botUserIdRef: () => 'UBOT',
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0CHANNEL', thread: '1700000000.000100', limit: 10 })
    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://slack.com/api/conversations.replies')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer xoxb-tok')
    expect(headers['Content-Type']).toContain('application/x-www-form-urlencoded')
    const body = (calls[0]!.init.body as string) ?? ''
    const params = new URLSearchParams(body)
    expect(params.get('channel')).toBe('C0CHANNEL')
    expect(params.get('ts')).toBe('1700000000.000100')
    expect(params.get('limit')).toBe('10')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.externalMessageId)).toEqual(['1700000000.000100', '1700000001.000200'])
  })

  test('uses conversations.history when thread is null', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'xoxb-tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'C0CHANNEL', thread: null, limit: 5 })
    // then
    expect(calls[0]!.url).toBe('https://slack.com/api/conversations.history')
    const params = new URLSearchParams(calls[0]!.init.body as string)
    expect(params.get('channel')).toBe('C0CHANNEL')
    expect(params.get('ts')).toBeNull()
  })

  test('reverses conversations.history (newest-first) into oldest-first', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1700000003.000300', user: 'UC', text: 'newest' },
        { ts: '1700000002.000200', user: 'UB', text: 'middle' },
        { ts: '1700000001.000100', user: 'UA', text: 'oldest' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.text)).toEqual(['oldest', 'middle', 'newest'])
  })

  test('omits Slack system subtypes from history context', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1700000003.000300', user: 'UB', text: 'after topic' },
        { ts: '1700000002.000200', user: 'UALICE', subtype: 'channel_topic', text: 'set the channel topic:\nUpdates' },
        { ts: '1700000001.000100', user: 'UA', text: 'before topic' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.text)).toEqual(['before topic', 'after topic'])
  })

  test('keeps /me messages in history context', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [{ ts: '1700000001.000100', user: 'UALICE', subtype: 'me_message', text: '<@UBOT> waves' }],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => 'UBOT',
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.text)).toEqual(['<@UBOT> waves'])
  })

  test('preserves conversations.replies order (already oldest-first)', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1700000001.000100', user: 'UA', text: 'first', thread_ts: '1700000001.000100' },
        { ts: '1700000002.000200', user: 'UB', text: 'second', thread_ts: '1700000001.000100' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: '1700000001.000100', limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.text)).toEqual(['first', 'second'])
  })

  test('maps files on history messages into attachments and bakes placeholders into text', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        {
          ts: '1700000000.000100',
          user: 'UALICE',
          subtype: 'file_share',
          text: '이 사진 머임??',
          thread_ts: '1700000000.000100',
          files: [{ id: 'F123', name: 'photo.png', mimetype: 'image/png' }],
        },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: '1700000000.000100', limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'F123', filename: 'photo.png', mimetype: 'image/png' },
    ])
    expect(msg.text).toBe('이 사진 머임??\n[Slack attachment #1: file image/png name=photo.png]')
  })

  test('omits attachments and leaves text untouched when a history message has no files', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [{ ts: '1.1', user: 'UALICE', text: 'plain text' }],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.attachments).toBeUndefined()
    expect(msg.text).toBe('plain text')
  })

  test('renders file-only history message (no text) as placeholder-only text', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        {
          ts: '1.1',
          user: 'UALICE',
          files: [{ id: 'F9', name: 'doc.pdf', mimetype: 'application/pdf' }],
        },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe('[Slack attachment #1: file application/pdf name=doc.pdf]')
    expect(msg.attachments).toHaveLength(1)
  })

  test('marks bot_message subtype as isBot', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1.1', user: 'UALICE', text: 'human' },
        { ts: '2.2', subtype: 'bot_message', bot_id: 'B123', text: 'from a bot' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const byTs = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m.isBot]))
    expect(byTs['1.1']).toBe(false)
    expect(byTs['2.2']).toBe(true)
  })

  test('marks our own bot user id as isBot even when subtype is missing', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1.1', user: 'UBOT', text: 'self message via web api' },
        { ts: '2.2', user: 'UHUMAN', text: 'human reply' },
      ],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => 'UBOT',
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const byTs = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m.isBot]))
    expect(byTs['1.1']).toBe(true)
    expect(byTs['2.2']).toBe(false)
  })

  test('exposes nextCursor when Slack returns response_metadata.next_cursor', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [{ ts: '1.1', user: 'UA', text: 'a' }],
      response_metadata: { next_cursor: 'cur-page-2' },
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBe('cur-page-2')
  })

  test('omits nextCursor when Slack returns an empty cursor', async () => {
    // given
    const { fn } = fakeFetch({ ok: true, messages: [], response_metadata: { next_cursor: '' } })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBeUndefined()
  })

  test('passes cursor through verbatim on follow-up calls', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'C0', thread: null, limit: 10, cursor: 'cur-page-2' })
    // then
    const params = new URLSearchParams(calls[0]!.init.body as string)
    expect(params.get('cursor')).toBe('cur-page-2')
  })

  test('clamps limit to SLACK_HISTORY_LIMIT_MAX', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'C0', thread: null, limit: 999 })
    // then
    const params = new URLSearchParams(calls[0]!.init.body as string)
    expect(params.get('limit')).toBe(String(SLACK_HISTORY_LIMIT_MAX))
  })

  test('returns ok:false with the slack error string when ok=false', async () => {
    // given
    const { fn } = fakeFetch({ ok: false, error: 'channel_not_found' })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'channel_not_found' })
  })

  test('swallows fetch rejection into ok:false (does not throw)', async () => {
    // given
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'network down' })
  })

  test('admits per-channel allow rule (channel:C0) without a workspace at fetch time', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [] })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0CHANNEL', thread: null, limit: 10 })
    // then
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(true)
  })

  test('resolves authorName to display names when an authorResolver is provided', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [
        { ts: '1.1', user: 'UALICE', text: 'hi' },
        { ts: '2.2', user: 'UBOB', text: 'yo' },
      ],
    })
    const resolved: string[] = []
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      authorResolver: {
        resolve: async (id) => {
          resolved.push(id)
          return id === 'UALICE' ? 'alice.s' : 'Bob Jones'
        },
      },
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const byTs = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m.authorName]))
    expect(byTs['1.1']).toBe('alice.s')
    expect(byTs['2.2']).toBe('Bob Jones')
    expect(resolved.sort()).toEqual(['UALICE', 'UBOB'])
  })

  test('leaves bot_id-only authors unresolved (no users.info entry exists)', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [{ ts: '1.1', subtype: 'bot_message', bot_id: 'B123', text: 'from a bot' }],
    })
    const resolved: string[] = []
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      authorResolver: {
        resolve: async (id) => {
          resolved.push(id)
          return 'should-not-be-used'
        },
      },
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages[0]!.authorName).toBe('B123')
    expect(resolved).toEqual([])
  })

  test('falls back to the raw id in authorName when no authorResolver is provided', async () => {
    // given
    const { fn } = fakeFetch({
      ok: true,
      messages: [{ ts: '1.1', user: 'UALICE', text: 'hi' }],
    })
    const cb = createSlackHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages[0]!.authorName).toBe('UALICE')
  })
})

describe('createSlackMessageGetCallback', () => {
  type FetchCall = { url: string; init: RequestInit }

  function fakeFetch(response: unknown): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  const silentLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} })

  test('fetches one message via conversations.history and maps it', async () => {
    // given
    const { fn, calls } = fakeFetch({ ok: true, messages: [{ ts: '170.001', user: 'UALICE', text: 'the one' }] })
    const cb = createSlackMessageGetCallback({
      token: 'xoxb-tok',
      logger: silentLogger(),
      botUserIdRef: () => 'UBOT',
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, messageId: '170.001' })
    // then
    expect(calls[0]!.url).toBe('https://slack.com/api/conversations.history')
    const params = new URLSearchParams(calls[0]!.init.body as string)
    expect(params.get('channel')).toBe('C0')
    expect(params.get('latest')).toBe('170.001')
    expect(params.get('inclusive')).toBe('true')
    if (!result.ok) throw new Error('expected ok')
    expect(result.message.externalMessageId).toBe('170.001')
    expect(result.message.text).toBe('the one')
  })

  test('uses conversations.replies when a thread is given', async () => {
    // given
    const { fn, calls } = fakeFetch({
      ok: true,
      messages: [{ ts: '170.002', user: 'UB', text: 'target reply' }],
    })
    const cb = createSlackMessageGetCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: '170.000', messageId: '170.002' })
    // then the replies call is windowed to the single target ts (ts = thread root)
    // so a reply past the first page is not wrongly reported not-found
    expect(calls[0]!.url).toBe('https://slack.com/api/conversations.replies')
    const params = new URLSearchParams(calls[0]!.init.body as string)
    expect(params.get('ts')).toBe('170.000')
    expect(params.get('oldest')).toBe('170.002')
    expect(params.get('latest')).toBe('170.002')
    expect(params.get('inclusive')).toBe('true')
    expect(params.get('limit')).toBe('1')
    if (!result.ok) throw new Error('expected ok')
    expect(result.message.text).toBe('target reply')
  })

  test('returns not-found when the requested ts is absent from the payload', async () => {
    // given
    const { fn } = fakeFetch({ ok: true, messages: [{ ts: '999.999', user: 'UA', text: 'other' }] })
    const cb = createSlackMessageGetCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, messageId: '170.001' })
    // then
    expect(result).toEqual({ ok: false, error: 'message not found', code: 'not-found' })
  })

  test('surfaces a slack api error verbatim', async () => {
    // given
    const { fn } = fakeFetch({ ok: false, error: 'channel_not_found' })
    const cb = createSlackMessageGetCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'CBAD', thread: null, messageId: '1.1' })
    // then
    expect(result).toEqual({ ok: false, error: 'channel_not_found' })
  })
})

describe('createSlackListCallback', () => {
  type FetchCall = { url: string; init: RequestInit }

  function fakeFetch(response: unknown): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  const silentLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} })

  test('maps conversations.list entries with kind and membership', async () => {
    // given
    const { fn, calls } = fakeFetch({
      ok: true,
      channels: [
        { id: 'C1', name: 'general', is_member: true },
        { id: 'D1', is_im: true, is_member: true },
        { id: 'G1', name: 'crew', is_mpim: true, is_member: false },
      ],
    })
    const cb = createSlackListCallback({ token: 'tok', logger: silentLogger(), fetchImpl: fn })
    // when
    const result = await cb({ workspace: 'T0', limit: 50 })
    // then
    expect(calls[0]!.url).toBe('https://slack.com/api/conversations.list')
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries).toEqual([
      { chat: 'C1', name: '#general', kind: 'channel', isMember: true },
      { chat: 'D1', name: 'D1', kind: 'dm', isMember: true },
      { chat: 'G1', name: '#crew', kind: 'group', isMember: false },
    ])
  })

  test('passes a paging cursor through and surfaces nextCursor', async () => {
    // given
    const { fn, calls } = fakeFetch({
      ok: true,
      channels: [{ id: 'C1', name: 'general', is_member: true }],
      response_metadata: { next_cursor: 'NEXT' },
    })
    const cb = createSlackListCallback({ token: 'tok', logger: silentLogger(), fetchImpl: fn })
    // when
    const result = await cb({ workspace: 'T0', limit: 50, cursor: 'PREV' })
    // then
    expect(new URLSearchParams(calls[0]!.init.body as string).get('cursor')).toBe('PREV')
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBe('NEXT')
  })

  test('surfaces a slack api error verbatim', async () => {
    // given
    const { fn } = fakeFetch({ ok: false, error: 'missing_scope' })
    const cb = createSlackListCallback({ token: 'tok', logger: silentLogger(), fetchImpl: fn })
    // when
    const result = await cb({ workspace: 'T0', limit: 50 })
    // then
    expect(result).toEqual({ ok: false, error: 'missing_scope' })
  })
})

describe('createSlackReferenceFetch', () => {
  function fakeFetch(response: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
  }

  test('resolves authorName to a display name when an authorResolver is provided', async () => {
    // given
    const fetchMessage = createSlackReferenceFetch({
      token: 'tok',
      fetchImpl: fakeFetch({ ok: true, messages: [{ user: 'UALICE', text: 'root text' }] }),
      authorResolver: { resolve: async (id) => (id === 'UALICE' ? 'alice.s' : id) },
    })
    // when
    const result = await fetchMessage('C1', '1700.000001')
    // then
    expect(result).toEqual({ authorId: 'UALICE', authorName: 'alice.s', text: 'root text' })
  })

  test('leaves bot_id authors unresolved (no users.info entry exists)', async () => {
    // given
    const resolved: string[] = []
    const fetchMessage = createSlackReferenceFetch({
      token: 'tok',
      fetchImpl: fakeFetch({ ok: true, messages: [{ bot_id: 'B123', text: 'from a bot' }] }),
      authorResolver: {
        resolve: async (id) => {
          resolved.push(id)
          return 'should-not-be-used'
        },
      },
    })
    // when
    const result = await fetchMessage('C1', '1700.000001')
    // then
    expect(result).toEqual({ authorId: 'B123', authorName: 'B123', text: 'from a bot' })
    expect(resolved).toEqual([])
  })

  test('falls back to the raw id when no authorResolver is provided', async () => {
    // given
    const fetchMessage = createSlackReferenceFetch({
      token: 'tok',
      fetchImpl: fakeFetch({ ok: true, messages: [{ user: 'UALICE', text: 'root text' }] }),
    })
    // when
    const result = await fetchMessage('C1', '1700.000001')
    // then
    expect(result).toEqual({ authorId: 'UALICE', authorName: 'UALICE', text: 'root text' })
  })
})

describe('slack-bot createOutboundCallback', () => {
  type PostCall = { channel: string; text: string; options?: { thread_ts?: string; blocks?: unknown[] } }
  type UploadCall = {
    channel: string
    bytes: number
    filename: string
    options?: { thread_ts?: string; title?: string; initial_comment?: string }
  }

  function makeFakeClient(behavior: { postMessage?: 'ok' | 'reject'; uploadFile?: 'ok' | 'reject' } = {}): {
    client: Pick<SlackBotClient, 'postMessage' | 'uploadFile'>
    posts: PostCall[]
    uploads: UploadCall[]
  } {
    const posts: PostCall[] = []
    const uploads: UploadCall[] = []
    return {
      posts,
      uploads,
      client: {
        postMessage: async (channel, text, options) => {
          posts.push({ channel, text, options })
          if (behavior.postMessage === 'reject') throw new Error('slack_post_failed')
          return { ts: `ts${posts.length}`, text, type: 'message' } as SlackMessage
        },
        uploadFile: async (channel, file, filename, options) => {
          uploads.push({ channel, bytes: file.length, filename, options })
          if (behavior.uploadFile === 'reject') throw new Error('slack_upload_failed')
          return {
            id: `F${uploads.length}`,
            name: filename,
            title: filename,
            mimetype: 'application/octet-stream',
            size: file.length,
            url_private: '',
            created: 0,
            user: 'U1',
          } as SlackFile
        },
      },
    }
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function permissive(): ChannelAdapterConfig {
    return {
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }
  }

  function makeMsg(overrides: Partial<OutboundMessage>): OutboundMessage {
    return { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'hi', ...overrides } as OutboundMessage
  }

  const tag = async (_w: string, _c: string) => 'team=T0 channel=C0'
  const fakeRead = async (_path: string) => Buffer.from('test-bytes')

  test('text-only path sends a markdown block with the GFM text', async () => {
    // given
    const { client, posts, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    // when
    const result = await cb(makeMsg({ text: 'hello' }))
    // then
    expect(result).toEqual({
      ok: true,
      messageId: 'ts1',
      messageIds: ['ts1'],
      reactionRef: encodeSlackReactionRef({ channel: 'C0', ts: 'ts1' }),
    })
    expect(uploads).toHaveLength(0)
    expect(posts).toEqual([
      {
        channel: 'C0',
        text: 'hello',
        options: { blocks: [{ type: 'markdown', text: 'hello' }] },
      },
    ])
  })

  test('disables both link and media previews for a link-heavy message', async () => {
    const { client, posts } = makeFakeClient()
    const cb = createOutboundCallback({ client, logger: silentLogger(), formatChannelTag: tag })
    await cb(makeMsg({ text: 'https://example.org', link_previews: false }))
    expect(posts[0]?.options).toMatchObject({ unfurl_links: false, unfurl_media: false })
  })

  test('text-only path preserves GitHub-flavored markdown verbatim in the block payload', async () => {
    // given
    const { client, posts } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    const gfm = '## Heading\n\nI checked the **deployment** logs.\n\n| col | val |\n|-----|-----|\n| a   | 1   |'
    // when
    await cb(makeMsg({ text: gfm }))
    // then
    expect(posts).toHaveLength(1)
    const post = posts[0]!
    expect(post.text).toBe(gfm)
    expect(post.options?.blocks).toEqual([{ type: 'markdown', text: gfm }])
  })

  test('threaded text-only post forwards thread_ts alongside the markdown block', async () => {
    const { client, posts } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(makeMsg({ text: 'hello', thread: '1700.000100' }))
    expect(posts).toEqual([
      {
        channel: 'C0',
        text: 'hello',
        options: {
          thread_ts: '1700.000100',
          blocks: [{ type: 'markdown', text: 'hello' }],
        },
      },
    ])
  })

  test('oversize text splits into multiple posts; subsequent chunks thread under the first', async () => {
    // given
    const { client, posts } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    const para = 'word '.repeat(2400).trim()
    const huge = `${para}\n\n${para}\n\n${para}`
    // when
    const result = await cb(makeMsg({ text: huge }))
    // then
    expect(result.ok).toBe(true)
    expect(posts.length).toBeGreaterThan(1)
    expect(posts[0]!.options?.thread_ts).toBeUndefined()
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i]!.options?.thread_ts).toBe('ts1')
    }
    for (const post of posts) {
      const blocks = post.options?.blocks
      expect(Array.isArray(blocks)).toBe(true)
      expect(blocks?.length).toBe(1)
    }
    if (!result.ok) throw new Error('expected ok')
    expect(result.messageId).toBe('ts1')
    expect(result.messageIds).toEqual(posts.map((_, i) => `ts${i + 1}`))
  })

  test('oversize text in an existing thread keeps every chunk on that thread', async () => {
    const { client, posts } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    const para = 'word '.repeat(2400).trim()
    const huge = `${para}\n\n${para}\n\n${para}`
    await cb(makeMsg({ text: huge, thread: '1700.000100' }))
    expect(posts.length).toBeGreaterThan(1)
    for (const post of posts) {
      expect(post.options?.thread_ts).toBe('1700.000100')
    }
  })

  test('text+single-attachment folds text into initial_comment and never calls postMessage', async () => {
    // given
    const { client, posts, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    // when
    await cb(makeMsg({ text: 'caption', attachments: [{ path: '/agent/a.png' }] }))
    // then
    expect(posts).toHaveLength(0)
    expect(uploads).toEqual([{ channel: 'C0', bytes: 10, filename: 'a.png', options: { initial_comment: 'caption' } }])
  })

  test('attachment caption converts GFM to Slack mrkdwn (initial_comment cannot carry a markdown block)', async () => {
    // given
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    // when
    await cb(
      makeMsg({ text: '**Status Distribution**\n- Planned: 235', attachments: [{ path: '/agent/report.xlsx' }] }),
    )
    // then
    expect(uploads[0]!.options?.initial_comment).toBe('*Status Distribution*\n- Planned: 235')
  })

  test('multi-attachment puts caption only on the FIRST upload; rest are bare', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(makeMsg({ text: 'caption', attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }] }))
    expect(uploads).toEqual([
      { channel: 'C0', bytes: 10, filename: 'a.png', options: { initial_comment: 'caption' } },
      { channel: 'C0', bytes: 10, filename: 'b.pdf', options: {} },
    ])
  })

  test('threaded uploads forward thread_ts on every attachment', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(
      makeMsg({
        text: 'caption',
        thread: '1700.000100',
        attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }],
      }),
    )
    expect(uploads).toEqual([
      {
        channel: 'C0',
        bytes: 10,
        filename: 'a.png',
        options: { thread_ts: '1700.000100', initial_comment: 'caption' },
      },
      { channel: 'C0', bytes: 10, filename: 'b.pdf', options: { thread_ts: '1700.000100' } },
    ])
  })

  test('attachment.filename overrides the path basename', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(makeMsg({ text: undefined, attachments: [{ path: '/agent/tmp-XYZ.bin', filename: 'report.pdf' }] }))
    expect(uploads[0]!.filename).toBe('report.pdf')
  })

  test('attachments-only post (no text) uploads bare, not as initial_comment', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    await cb(makeMsg({ text: undefined, attachments: [{ path: '/agent/a.png' }] }))
    expect(uploads).toEqual([{ channel: 'C0', bytes: 10, filename: 'a.png', options: {} }])
  })

  test('upload failure aborts the loop and returns ok:false', async () => {
    const { client, uploads } = makeFakeClient({ uploadFile: 'reject' })
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    const result = await cb(
      makeMsg({ text: 'caption', attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }] }),
    )
    expect(result.ok).toBe(false)
    expect(uploads).toHaveLength(1)
  })

  test('readFile failure surfaces as ok:false without calling uploadFile', async () => {
    const { client, uploads } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: async () => {
        throw new Error('ENOENT: no such file')
      },
    })
    const result = await cb(makeMsg({ text: undefined, attachments: [{ path: '/agent/missing.png' }] }))
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error : '').toContain('readFile failed')
    expect(uploads).toHaveLength(0)
  })

  test('rejects when message has neither text nor attachments', async () => {
    const { client } = makeFakeClient()
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
    })
    const result = await cb(makeMsg({ text: undefined, attachments: [] }))
    expect(result.ok).toBe(false)
  })

  test('threaded postMessage triggers typingTracker.clearAfterSend so the indicator does not stay stuck', async () => {
    // given
    const { client, posts } = makeFakeClient()
    const clearCalls: Array<{ chat: string; thread: string | null | undefined }> = []
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async (chat, thread) => {
          clearCalls.push({ chat, thread })
        },
      },
    })
    // when
    const result = await cb(makeMsg({ text: 'hello', thread: '1700.000100' }))
    // then
    expect(result.ok).toBe(true)
    expect(posts).toHaveLength(1)
    expect(clearCalls).toEqual([{ chat: 'C0', thread: '1700.000100' }])
  })

  test('top-level postMessage still calls clearAfterSend (tracker decides the no-op)', async () => {
    const { client } = makeFakeClient()
    const clearCalls: Array<{ chat: string; thread: string | null | undefined }> = []
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async (chat, thread) => {
          clearCalls.push({ chat, thread })
        },
      },
    })
    await cb(makeMsg({ text: 'hello' }))
    expect(clearCalls).toEqual([{ chat: 'C0', thread: undefined }])
  })

  test('flat DM send posts top-level but clears the status on typingThread', async () => {
    // given
    const { client, posts } = makeFakeClient()
    const clearCalls: Array<{ chat: string; thread: string | null | undefined }> = []
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async (chat, thread) => {
          clearCalls.push({ chat, thread })
        },
      },
    })
    // when
    const result = await cb(makeMsg({ chat: 'D0', text: 'hi', thread: null, typingThread: '1700.000100' }))
    // then
    expect(result.ok).toBe(true)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.options?.thread_ts).toBeUndefined()
    expect(clearCalls).toEqual([{ chat: 'D0', thread: '1700.000100' }])
  })

  test('threaded uploadFile triggers clearAfterSend after the LAST attachment', async () => {
    // given
    const { client, uploads } = makeFakeClient()
    const clearCalls: Array<{ chat: string; thread: string | null | undefined }> = []
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async (chat, thread) => {
          clearCalls.push({ chat, thread })
        },
      },
    })
    // when
    await cb(
      makeMsg({
        text: 'caption',
        thread: '1700.000100',
        attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }],
      }),
    )
    // then
    expect(uploads).toHaveLength(2)
    expect(clearCalls).toEqual([{ chat: 'C0', thread: '1700.000100' }])
  })

  test('failed postMessage does not call clearAfterSend (no message was actually sent)', async () => {
    const { client } = makeFakeClient({ postMessage: 'reject' })
    const clearCalls: Array<unknown> = []
    const cb = createOutboundCallback({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      readFile: fakeRead,
      typingTracker: {
        clearAfterSend: async () => {
          clearCalls.push({})
        },
      },
    })
    const result = await cb(makeMsg({ text: 'hello', thread: '1700.000100' }))
    expect(result.ok).toBe(false)
    expect(clearCalls).toHaveLength(0)
  })
})

describe('slack-bot slash command allow-list', () => {
  test('includes help, stop, reload, and restart', () => {
    expect(new Set(SLACK_SLASH_COMMAND_NAMES)).toEqual(new Set(['help', 'stop', 'reload', 'restart']))
  })
})

describe('createSlashCommandHandler', () => {
  type AckCall = Record<string, unknown> | undefined
  type RouterCall = { key: ChannelKey; name: string; invokerId: string }
  type RouterResult =
    | { kind: 'handled'; name: string }
    | { kind: 'no-live-session' }
    | { kind: 'permission-denied' }
    | { kind: 'ambiguous'; matchCount: number }
    | { kind: 'unknown-command'; name: string }

  function setup(routerImpl: (key: ChannelKey, name: string, invokerId: string) => Promise<RouterResult>): {
    handler: ReturnType<typeof createSlashCommandHandler>
    routerCalls: RouterCall[]
    logs: { info: string[]; warn: string[]; error: string[] }
  } {
    const routerCalls: RouterCall[] = []
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const handler = createSlashCommandHandler({
      router: {
        executeCommand: async (key, name, options) => {
          routerCalls.push({ key, name, invokerId: options.invokerId })
          return routerImpl(key, name, options.invokerId)
        },
      },
      knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
      formatChannelTag: async (workspace, chat) => `team=${workspace} channel=${chat}`,
    })
    return { handler, routerCalls, logs }
  }

  function makeArgs(
    overrideBody: Partial<{
      command: string
      text: string
      user_id: string
      channel_id: string
      team_id: string
    }> = {},
  ): { args: Parameters<ReturnType<typeof createSlashCommandHandler>>[0]; acks: AckCall[] } {
    const acks: AckCall[] = []
    const ack = (payload?: Record<string, unknown>): void => {
      acks.push(payload)
    }
    const args = {
      ack,
      envelope_id: 'env-1',
      body: {
        command: '/stop',
        text: '',
        user_id: 'U-alice',
        channel_id: 'C-general',
        team_id: 'T-acme',
        ...overrideBody,
      },
    } as Parameters<ReturnType<typeof createSlashCommandHandler>>[0]
    return { args, acks }
  }

  test('/stop routes to executeCommand with invokerId and acks ephemerally with success text', async () => {
    const { handler, routerCalls } = setup(async () => ({ kind: 'handled', name: 'stop' }))
    const { args, acks } = makeArgs()

    await handler(args)

    expect(routerCalls).toEqual([
      {
        key: { adapter: 'slack-bot', workspace: 'T-acme', chat: 'C-general', thread: null },
        name: 'stop',
        invokerId: 'U-alice',
      },
    ])
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ response_type: 'ephemeral' })
    expect((acks[0] as { text: string }).text).toContain('Stopped')
  })

  test('cold-channel /stop acks with "nothing to stop"', async () => {
    const { handler } = setup(async () => ({ kind: 'no-live-session' }))
    const { args, acks } = makeArgs()

    await handler(args)

    expect(acks).toHaveLength(1)
    expect((acks[0] as { text: string }).text).toContain('Nothing to stop')
  })

  test('permission-denied result acks with the permission-denied message', async () => {
    const { handler } = setup(async () => ({ kind: 'permission-denied' }))
    const { args, acks } = makeArgs()

    await handler(args)

    expect(acks).toHaveLength(1)
    expect((acks[0] as { text: string }).text).toMatch(/permission/i)
  })

  test('ambiguous result acks with guidance to invoke from inside the thread', async () => {
    const { handler } = setup(async () => ({ kind: 'ambiguous', matchCount: 2 }))
    const { args, acks } = makeArgs()

    await handler(args)

    expect(acks).toHaveLength(1)
    expect((acks[0] as { text: string }).text).toMatch(/multiple|thread/i)
  })

  test('DM channel ids resolve to workspace=@dm', async () => {
    const { handler, routerCalls } = setup(async () => ({ kind: 'handled', name: 'stop' }))
    const { args } = makeArgs({ user_id: 'U-bob', channel_id: 'D-bob' })

    await handler(args)

    expect(routerCalls[0]!.key.workspace).toBe('@dm')
    expect(routerCalls[0]!.key.chat).toBe('D-bob')
  })

  test('unknown commands are dropped and acked with the failure message', async () => {
    const { handler, routerCalls, logs } = setup(async () => ({ kind: 'handled', name: 'stop' }))
    const { args, acks } = makeArgs({ command: '/totally-not-stop' })

    await handler(args)

    expect(routerCalls).toEqual([])
    expect(logs.warn.some((m) => m.includes('unknown-command'))).toBe(true)
    expect(acks).toHaveLength(1)
  })

  test('executeCommand exception is caught, acked with failure, and logged', async () => {
    const { handler, logs } = setup(async () => {
      throw new Error('router exploded')
    })
    const { args, acks } = makeArgs()

    await handler(args)

    expect(logs.error.some((m) => m.includes('router exploded'))).toBe(true)
    expect(acks).toHaveLength(1)
    expect((acks[0] as { text: string }).text).toMatch(/internal error|Could not stop/i)
  })

  test('acks exactly once when ack on happy path throws (does NOT cascade into error-path ack)', async () => {
    // B1 + B2 fix from review: pre-fix, a thrown ack on the success path
    // entered the outer catch which called ack again. Test asserts the
    // exactly-once contract.
    let ackCallCount = 0
    const handler = createSlashCommandHandler({
      router: { executeCommand: async () => ({ kind: 'handled', name: 'stop' }) },
      knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      formatChannelTag: async () => 'team=T-acme channel=C-general',
    })
    const args = {
      ack: () => {
        ackCallCount++
        throw new Error('socket gone')
      },
      envelope_id: 'env-1',
      body: {
        command: '/stop',
        text: '',
        user_id: 'U-alice',
        channel_id: 'C-general',
        team_id: 'T-acme',
      },
    } as Parameters<ReturnType<typeof createSlashCommandHandler>>[0]

    await handler(args)

    expect(ackCallCount).toBe(1)
  })

  test('manifest slash_commands list and runtime allow-list stay in sync (B3 drift guard)', () => {
    const manifestNames = SLACK_APP_MANIFEST.features.slash_commands.map((c) => c.command.replace(/^\//, ''))
    const allowList = Array.from(SLACK_SLASH_COMMAND_NAMES).sort()
    expect(manifestNames.slice().sort()).toEqual(allowList)
  })

  test('ack fires BEFORE the slow formatChannelTag completes (3s budget protection)', async () => {
    const events: Array<'router-call' | 'ack-sent' | 'channel-tag-resolved'> = []
    let releaseTag: (() => void) | undefined
    const tagPromise = new Promise<string>((resolve) => {
      releaseTag = () => {
        events.push('channel-tag-resolved')
        resolve('team=T-acme channel=C-general')
      }
    })
    const handler = createSlashCommandHandler({
      router: {
        executeCommand: async () => {
          events.push('router-call')
          return { kind: 'handled', name: 'stop' }
        },
      },
      knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      formatChannelTag: () => tagPromise,
    })
    const ack = (): void => {
      events.push('ack-sent')
    }
    const args = {
      ack,
      envelope_id: 'env-1',
      body: {
        command: '/stop',
        text: '',
        user_id: 'U-alice',
        channel_id: 'C-general',
        team_id: 'T-acme',
      },
    } as Parameters<ReturnType<typeof createSlashCommandHandler>>[0]

    const done = handler(args)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(events).toEqual(['router-call', 'ack-sent'])

    releaseTag!()
    await done

    expect(events).toEqual(['router-call', 'ack-sent', 'channel-tag-resolved'])
  })
})

describe('createThreadCommandHandler', () => {
  type RouterCall = { key: ChannelKey; name: string; invokerId: string }
  type RouterResult =
    | { kind: 'handled'; name: string }
    | { kind: 'no-live-session' }
    | { kind: 'permission-denied' }
    | { kind: 'ambiguous'; matchCount: number }
    | { kind: 'unknown-command'; name: string }
  type ReplyCall = { chat: string; thread: string | null; text: string }

  function setup(over?: {
    routerImpl?: (key: ChannelKey, name: string, invokerId: string) => Promise<RouterResult>
    postReplyImpl?: (args: ReplyCall) => Promise<void>
  }): {
    handler: ReturnType<typeof createThreadCommandHandler>
    routerCalls: RouterCall[]
    replies: ReplyCall[]
    logs: { info: string[]; warn: string[]; error: string[] }
  } {
    const routerCalls: RouterCall[] = []
    const replies: ReplyCall[] = []
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const handler = createThreadCommandHandler({
      router: {
        executeCommand: async (key, name, options) => {
          routerCalls.push({ key, name, invokerId: options.invokerId })
          return (over?.routerImpl ?? (async () => ({ kind: 'handled', name: 'stop' }) as RouterResult))(
            key,
            name,
            options.invokerId,
          )
        },
      },
      knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
      postReply: async (args) => {
        replies.push(args)
        if (over?.postReplyImpl) await over.postReplyImpl(args)
      },
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
    })
    return { handler, routerCalls, replies, logs }
  }

  const baseInput = {
    text: '!stop',
    channel: 'C-general',
    threadTs: '1700.0001',
    isDm: false,
    teamId: 'T-acme',
    invokerId: 'U-alice',
  }

  // Default reserve: always wins. Tracks call count so tests can assert the
  // handler reserves only for recognised commands.
  function makeReserve(result = true): { reserve: () => boolean; calls: () => number } {
    let calls = 0
    return {
      reserve: () => {
        calls++
        return result
      },
      calls: () => calls,
    }
  }

  test('!stop in a thread executes with a thread-targeted key and replies into the thread', async () => {
    const { handler, routerCalls, replies } = setup()

    const outcome = await handler(baseInput, makeReserve().reserve)

    expect(outcome).toEqual({ kind: 'executed' })
    expect(routerCalls).toEqual([
      {
        key: { adapter: 'slack-bot', workspace: 'T-acme', chat: 'C-general', thread: '1700.0001' },
        name: 'stop',
        invokerId: 'U-alice',
      },
    ])
    expect(replies).toHaveLength(1)
    expect(replies[0]!.chat).toBe('C-general')
    expect(replies[0]!.thread).toBe('1700.0001')
    expect(replies[0]!.text).toContain('Stopped')
  })

  test('non-! message passes through as not-a-command without reserving', async () => {
    const { handler, routerCalls, replies } = setup()
    const r = makeReserve()

    const outcome = await handler({ ...baseInput, text: 'stop the turn please' }, r.reserve)

    expect(outcome).toEqual({ kind: 'not-a-command' })
    expect(routerCalls).toHaveLength(0)
    expect(replies).toHaveLength(0)
    expect(r.calls()).toBe(0)
  })

  test('!unknown (not a known command) passes through as not-a-command without reserving', async () => {
    const { handler, routerCalls, replies } = setup()
    const r = makeReserve()

    const outcome = await handler({ ...baseInput, text: '!nice work everyone' }, r.reserve)

    expect(outcome).toEqual({ kind: 'not-a-command' })
    expect(routerCalls).toHaveLength(0)
    expect(replies).toHaveLength(0)
    expect(r.calls()).toBe(0)
  })

  test('a lost reserve race short-circuits to duplicate (no router call, no reply)', async () => {
    const { handler, routerCalls, replies } = setup()

    const outcome = await handler(baseInput, makeReserve(false).reserve)

    expect(outcome).toEqual({ kind: 'duplicate' })
    expect(routerCalls).toHaveLength(0)
    expect(replies).toHaveLength(0)
  })

  test('reserve fires before the router await (sync reservation closes the race)', async () => {
    const order: string[] = []
    const { handler } = setup({
      routerImpl: async () => {
        order.push('execute')
        return { kind: 'handled', name: 'stop' }
      },
    })
    const reserve = (): boolean => {
      order.push('reserve')
      return true
    }

    await handler(baseInput, reserve)

    expect(order).toEqual(['reserve', 'execute'])
  })

  test('permission-denied result maps to the permission-denied reply', async () => {
    const { handler, replies } = setup({ routerImpl: async () => ({ kind: 'permission-denied' }) })

    await handler(baseInput, makeReserve().reserve)

    expect(replies[0]!.text).toContain('permission')
  })

  test('no-live-session posts nothing (a bystander agent stays silent in a shared channel)', async () => {
    const { handler, routerCalls, replies, logs } = setup({
      routerImpl: async () => ({ kind: 'no-live-session' }),
    })

    const outcome = await handler(baseInput, makeReserve().reserve)

    expect(outcome).toEqual({ kind: 'executed' })
    expect(routerCalls).toHaveLength(1)
    expect(replies).toHaveLength(0)
    expect(logs.info.some((l) => l.includes('result=no-live-session'))).toBe(true)
  })

  test('top-level !stop (no thread) targets a thread:null key', async () => {
    const { handler, routerCalls } = setup()

    await handler({ ...baseInput, threadTs: null }, makeReserve().reserve)

    expect(routerCalls[0]!.key.thread).toBe(null)
  })

  test('executeCommand exception is caught and replies with the failure text', async () => {
    const { handler, replies, logs } = setup({
      routerImpl: async () => {
        throw new Error('boom')
      },
    })

    const outcome = await handler(baseInput, makeReserve().reserve)

    expect(outcome).toEqual({ kind: 'executed' })
    expect(replies[0]!.text).toContain('internal error')
    expect(logs.error.some((l) => l.includes('boom'))).toBe(true)
  })

  test('a failing reply post is swallowed (still returns executed)', async () => {
    const { handler, logs } = setup({
      postReplyImpl: async () => {
        throw new Error('slack down')
      },
    })

    const outcome = await handler(baseInput, makeReserve().reserve)

    expect(outcome).toEqual({ kind: 'executed' })
    expect(logs.warn.some((l) => l.includes('reply post failed'))).toBe(true)
  })

  test('two concurrent duplicate deliveries through a real dedupe execute exactly once', async () => {
    let executions = 0
    let releaseRouter: (() => void) | undefined
    const routerGate = new Promise<void>((resolve) => {
      releaseRouter = resolve
    })
    const { handler } = setup({
      routerImpl: async () => {
        executions++
        await routerGate
        return { kind: 'handled', name: 'stop' }
      },
    })

    const dedupe = createSlackDedupe()
    const event = { channel: 'C-general', ts: '1700.0001', client_msg_id: 'cmid-1' }
    const reserve = (): boolean => {
      if (dedupe.check(event) !== null) return false
      dedupe.mark(event)
      return true
    }

    // Both deliveries start before the router resolves, mirroring the message +
    // app_mention double-delivery interleaving.
    const first = handler(baseInput, reserve)
    const second = handler(baseInput, reserve)
    releaseRouter!()
    const [a, b] = await Promise.all([first, second])

    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(['duplicate', 'executed'])
    expect(executions).toBe(1)
  })
})
