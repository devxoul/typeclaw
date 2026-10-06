import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InstagramChatSummary, InstagramMessageSummary } from 'agent-messenger/instagram'

import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage, OutboundMessage } from '@/channels/types'
import { waitFor } from '@/test-helpers/wait-for'

import {
  createInstagramAdapter,
  createInstagramHistoryCallback,
  createOutboundCallback,
  resolveInstagramListenerCtor,
  type ConnectedPayload,
  type InstagramClientShape,
  type InstagramListenerShape,
} from './instagram'

const SILENT = { info: () => {}, warn: () => {}, error: () => {} }
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'instagram-recovery-'))
  tempDirs.push(dir)
  return dir
}

class FakeListener implements InstagramListenerShape {
  connected?: (payload: ConnectedPayload) => void
  message?: (message: InstagramMessageSummary) => void
  error?: (error: Error) => void
  disconnected?: () => void
  started = false
  stopped = false
  start = async (): Promise<void> => {
    this.started = true
  }
  stop = (): void => {
    this.stopped = true
  }
  on(event: 'connected', handler: (payload: ConnectedPayload) => void): this
  on(event: 'message', handler: (message: InstagramMessageSummary) => void): this
  on(event: 'error', handler: (error: Error) => void): this
  on(event: 'disconnected', handler: () => void): this
  on(event: string, handler: unknown): this {
    if (event === 'connected') this.connected = handler as (payload: ConnectedPayload) => void
    if (event === 'message') this.message = handler as (message: InstagramMessageSummary) => void
    if (event === 'error') this.error = handler as (error: Error) => void
    if (event === 'disconnected') this.disconnected = handler as () => void
    return this
  }
  off(): this {
    return this
  }
}

function chat(overrides: Partial<InstagramChatSummary> = {}): InstagramChatSummary {
  return {
    id: 'T1',
    name: 'Alice',
    type: 'private',
    is_group: false,
    participant_count: 2,
    unread_count: 0,
    ...overrides,
  }
}

function msg(overrides: Partial<InstagramMessageSummary> = {}): InstagramMessageSummary {
  return {
    id: 'M1',
    thread_id: 'T1',
    from: 'U_other',
    from_name: 'Alice',
    timestamp: '2025-01-02T00:00:00.000Z',
    is_outgoing: false,
    type: 'text',
    text: 'hello bot',
    ...overrides,
  }
}

type FakeInstagramClient = InstagramClientShape & {
  loginCalls: Array<{ credentials: { username: string; password: string } | undefined; accountId: string | undefined }>
}

function fakeClient(overrides: Partial<InstagramClientShape> = {}): FakeInstagramClient {
  const loginCalls: Array<{
    credentials: { username: string; password: string } | undefined
    accountId: string | undefined
  }> = []
  const base: FakeInstagramClient = {
    loginCalls,
    login: async function (this: FakeInstagramClient, credentials, accountId): Promise<FakeInstagramClient> {
      loginCalls.push({ credentials, accountId })
      return this
    },
    getProfile: async () => ({ user_id: 'U_self', username: 'bot', full_name: null, profile_pic_url: null }),
    listChats: async () => [chat()],
    getMessages: async () => [],
    sendMessage: async (threadId, text) =>
      msg({ id: 'M_sent', thread_id: threadId, from: 'U_self', text, is_outgoing: true }),
    getUserId: () => 'U_self',
  }
  return Object.assign(base, overrides)
}

describe('resolveInstagramListenerCtor', () => {
  test('resolves the installed 2.28.0 module to hybrid (realtime)', () => {
    expect(resolveInstagramListenerCtor().transport).toBe('hybrid')
  })
})

describe('createOutboundCallback', () => {
  const tag = async (): Promise<string> => 'tag'

  test('sends markdown-stripped plain text and maps id', async () => {
    const sent: Array<{ chat: string; text: string }> = []
    const cb = createOutboundCallback({
      client: {
        sendMessage: async (chat, text) => {
          sent.push({ chat, text })
          return msg({ id: 'M', thread_id: chat, text })
        },
      },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({
      adapter: 'instagram',
      workspace: '@instagram-dm',
      chat: 'T1',
      text: '**hi**',
    } as OutboundMessage)
    expect(res).toEqual({ ok: true, messageId: 'M', messageIds: ['M'] })
    expect(sent).toEqual([{ chat: 'T1', text: 'hi' }])
  })

  test('rejects attachments, empty text, and wrong adapter', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => msg() },
      logger: SILENT,
      formatChannelTag: tag,
    })
    expect(
      (
        await cb({
          adapter: 'instagram',
          workspace: '@instagram-dm',
          chat: 'T1',
          text: 'hi',
          attachments: [{ path: '/tmp/x.png' }],
        } as OutboundMessage)
      ).ok,
    ).toBe(false)
    expect(
      (await cb({ adapter: 'instagram', workspace: '@instagram-dm', chat: 'T1', text: '' } as OutboundMessage)).ok,
    ).toBe(false)
    expect((await cb({ adapter: 'line', workspace: '@line-dm', chat: 'T1', text: 'hi' } as OutboundMessage)).ok).toBe(
      false,
    )
  })
})

describe('createInstagramHistoryCallback', () => {
  test('maps messages', async () => {
    const cb = createInstagramHistoryCallback({
      client: {
        getMessages: async () => [msg({ from: 'U_self', is_outgoing: true }), msg({ id: 'M2', from_name: undefined })],
      },
      logger: SILENT,
      selfUserIdRef: () => 'U_self',
    })
    const res = await cb({ chat: 'T1', thread: null, limit: 50 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.messages[0]!.isBot).toBe(true)
    expect(res.messages[1]!.authorName).toBe('U_other')
  })
})

describe('createInstagramAdapter lifecycle', () => {
  test('supports polling listener, registers callbacks, and routes inbound', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    const router = makeRouterStub((m) => routed.push(m))
    const adapter = createInstagramAdapter({
      router,
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerCtorResolver: () => ({
        ctor: class {
          constructor() {
            return listener
          }
        } as never,
        transport: 'polling',
      }),
      credentialsStore: {
        getAccount: async () => ({ account_id: 'U_self', username: 'bot', created_at: '', updated_at: '' }),
      },
    })
    await adapter.start()
    listener.connected?.({ userId: 'U_self' })
    expect(adapter.isConnected()).toBe(true)
    expect(router.registered.outbound).toBe(true)
    listener.message?.(msg())
    await waitFor(() => routed.length > 0)
    expect(routed[0]!.workspace).toBe('@instagram-dm')
    await adapter.stop()
    expect(router.registered.outbound).toBe(false)
  })

  test('supports hybrid listener connected payload with transport', async () => {
    const listener = new FakeListener()
    const adapter = createInstagramAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerCtorResolver: () => ({
        ctor: class {
          constructor() {
            return listener
          }
        } as never,
        transport: 'hybrid',
      }),
      credentialsStore: {
        getAccount: async () => ({ account_id: 'U_self', username: 'bot', created_at: '', updated_at: '' }),
      },
    })
    await adapter.start()
    expect(() => listener.connected?.({ userId: 'U_self', transport: 'realtime' })).not.toThrow()
    expect(adapter.isConnected()).toBe(true)
    await adapter.stop()
  })

  test('starts with stored-session login using the metadata account id', async () => {
    const client = fakeClient()
    const adapter = createInstagramAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client,
      listenerCtorResolver: () => ({
        ctor: class {
          constructor() {
            return new FakeListener()
          }
        } as never,
        transport: 'polling',
      }),
      credentialsStore: {
        getAccount: async () => ({ account_id: 'ig-account' }),
      },
    })

    await adapter.start()

    expect(client.loginCalls).toEqual([{ credentials: undefined, accountId: 'ig-account' }])
    await adapter.stop()
  })

  test('recovers every unseen message in chronological order after restart', async () => {
    const agentDir = await tempAgentDir()
    const listener = new FakeListener()
    const firstRouter = makeRouterStub(() => {})
    const first = createInstagramAdapter({
      agentDir,
      router: firstRouter,
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient({ getMessages: async () => [msg()] }),
      listenerCtorResolver: listenerResolver(listener),
    })
    await first.start()
    await first.stop()

    const routed: InboundMessage[] = []
    const second = createInstagramAdapter({
      agentDir,
      router: makeRouterStub((message) => routed.push(message)),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient({
        getMessages: async () => [
          msg(),
          msg({ id: 'M2', timestamp: '2025-01-02T00:00:01.000Z', text: 'second' }),
          msg({ id: 'M3', timestamp: '2025-01-02T00:00:02.000Z', text: 'third' }),
        ],
      }),
      listenerCtorResolver: listenerResolver(new FakeListener()),
    })
    await second.start()

    expect(routed.map((message) => message.externalMessageId)).toEqual(['M2', 'M3'])
    await second.stop()
  })

  test('does not checkpoint until durable admission completes and retries a failed admission', async () => {
    const listener = new FakeListener()
    const entered = deferred<void>()
    const durable = deferred<void>()
    const marks: string[] = []
    let attempts = 0
    const router = makeRouterStub(() => {})
    router.route = async (message) => {
      attempts++
      entered.resolve()
      await durable.promise
      if (attempts === 1) throw new Error('journal sync failed')
      return { kind: 'duplicate', inputId: message.externalMessageId }
    }
    const store = await memoryContinuityStore({ onMark: (id) => marks.push(id) })
    const adapter = createInstagramAdapter({
      router,
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      now: () => Date.parse('2025-01-02T00:00:00.000Z'),
      client: fakeClient({ getMessages: async () => [] }),
      continuityStore: store,
      listenerCtorResolver: listenerResolver(listener),
    })
    await adapter.start()
    const incoming = msg({ id: 'M-durable', timestamp: '2025-01-02T00:00:01.000Z' })
    listener.message?.(incoming)
    await entered.promise
    expect(marks).toEqual([])
    durable.resolve()
    await adapter.stop()
    expect(marks).toEqual([])
    await adapter.start()
    listener.message?.(incoming)
    await waitFor(() => marks.includes('M-durable'))
    expect(attempts).toBe(2)
    expect(marks).toEqual(['M-durable'])
    await adapter.stop()
  })

  test('routes messages that arrive during bootstrap before checkpointing them', async () => {
    const listener = new FakeListener()
    const historyFetchEntered = deferred<void>()
    const historyReady = deferred<void>()
    const events: string[] = []
    let history = [msg({ id: 'M-old', timestamp: '2025-01-01T00:00:00.000Z' })]
    const store = await memoryContinuityStore({
      onMark: (messageId) => events.push(`mark:${messageId}`),
    })
    const adapter = createInstagramAdapter({
      router: makeRouterStub((message) => events.push(`route:${message.externalMessageId}`)),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      now: () => Date.parse('2025-01-02T00:00:00.000Z'),
      client: fakeClient({
        getMessages: async () => {
          historyFetchEntered.resolve()
          await historyReady.promise
          return history
        },
      }),
      continuityStore: store,
      listenerCtorResolver: listenerResolver(listener),
    })

    const starting = adapter.start()
    await historyFetchEntered.promise
    history = [...history, msg({ id: 'M-new', timestamp: '2025-01-02T00:00:01.000Z' })]
    historyReady.resolve()
    await starting

    expect(events).toEqual(['route:M-new', 'mark:M-new'])
    await adapter.stop()
  })

  test('backfills a polling burst without routing the newest message twice', async () => {
    const agentDir = await tempAgentDir()
    const listener = new FakeListener()
    let history = [msg()]
    let historyCalls = 0
    const routed: InboundMessage[] = []
    const adapter = createInstagramAdapter({
      agentDir,
      router: makeRouterStub((message) => routed.push(message)),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient({
        getMessages: async () => {
          historyCalls++
          return history
        },
      }),
      listenerCtorResolver: listenerResolver(listener),
    })
    await adapter.start()
    listener.connected?.({ userId: 'U_self', transport: 'polling' })
    await waitFor(() => historyCalls === 2)
    history = [
      msg(),
      msg({ id: 'M2', timestamp: '2025-01-02T00:00:01.000Z', text: 'second' }),
      msg({ id: 'M3', timestamp: '2025-01-02T00:00:02.000Z', text: 'third' }),
    ]

    listener.message?.(history[2]!)
    listener.connected?.({ userId: 'U_self', transport: 'realtime' })
    await waitFor(() => routed.length === 2)

    expect(routed.map((message) => message.externalMessageId)).toEqual(['M2', 'M3'])
    await adapter.stop()
  })

  test('does not let a failed earlier message get overtaken during recovery', async () => {
    const agentDir = await tempAgentDir()
    const first = createInstagramAdapter({
      agentDir,
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient({ getMessages: async () => [msg()] }),
      listenerCtorResolver: listenerResolver(new FakeListener()),
    })
    await first.start()
    await first.stop()

    const listener = new FakeListener()
    const attempts: string[] = []
    let failM2 = true
    const history = [
      msg(),
      msg({ id: 'M2', timestamp: '2025-01-02T00:00:01.000Z' }),
      msg({ id: 'M3', timestamp: '2025-01-02T00:00:02.000Z' }),
    ]
    const adapter = createInstagramAdapter({
      agentDir,
      router: makeRouterStub((message) => {
        attempts.push(message.externalMessageId)
        if (message.externalMessageId === 'M2' && failM2) throw new Error('route failed')
      }),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient({ getMessages: async () => history }),
      listenerCtorResolver: listenerResolver(listener),
    })
    await adapter.start()
    expect(attempts).toEqual(['M2'])

    failM2 = false
    listener.message?.(history[2]!)
    await waitFor(() => attempts.length === 3)

    expect(attempts).toEqual(['M2', 'M2', 'M3'])
    await adapter.stop()
  })

  test('retries failed bootstrap seeding without replaying existing history', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    let seedCalls = 0
    let seeded = false
    const adapter = createInstagramAdapter({
      router: makeRouterStub((message) => routed.push(message)),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient({ getMessages: async () => [msg(), msg({ id: 'M2' })] }),
      continuityStore: {
        knowsThread: () => seeded,
        hasMessage: () => seeded,
        seedThread: async () => {
          seedCalls++
          if (seedCalls === 1) throw new Error('disk full')
          seeded = true
        },
        markMessage: async () => {},
      },
      listenerCtorResolver: listenerResolver(listener),
    })
    await adapter.start()
    listener.connected?.({ userId: 'U_self', transport: 'polling' })
    await waitFor(() => seedCalls === 2)

    expect(routed).toEqual([])
    await adapter.stop()
  })

  test('does not replay bootstrap history when seeding still fails on a polling event', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    let seedCalls = 0
    const adapter = createInstagramAdapter({
      router: makeRouterStub((message) => routed.push(message)),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient({ getMessages: async () => [msg(), msg({ id: 'M2' })] }),
      continuityStore: {
        knowsThread: () => false,
        hasMessage: () => false,
        seedThread: async () => {
          seedCalls++
          throw new Error('disk full')
        },
        markMessage: async () => {},
      },
      listenerCtorResolver: listenerResolver(listener),
    })
    await adapter.start()

    listener.connected?.({ userId: 'U_self', transport: 'realtime' })
    listener.message?.(msg({ id: 'M2' }))
    await waitFor(() => seedCalls >= 3)

    expect(routed).toEqual([])
    await adapter.stop()
  })

  test('recovers only post-start messages when a dormant chat first becomes visible', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    const history = [
      msg({ id: 'M-old', thread_id: 'T2', timestamp: '2025-01-01T00:00:00.000Z' }),
      msg({ id: 'M-new-1', thread_id: 'T2', timestamp: '2025-01-02T00:00:01.000Z' }),
      msg({ id: 'M-new-2', thread_id: 'T2', timestamp: '2025-01-02T00:00:02.000Z' }),
    ]
    const adapter = createInstagramAdapter({
      router: makeRouterStub((message) => routed.push(message)),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      now: () => Date.parse('2025-01-02T00:00:00.000Z'),
      client: fakeClient({
        listChats: async () => [chat()],
        getMessages: async (threadId) =>
          threadId === 'T2' ? history : [msg({ timestamp: '2025-01-01T00:00:00.000Z' })],
      }),
      continuityStore: await memoryContinuityStore(),
      listenerCtorResolver: listenerResolver(listener),
    })
    await adapter.start()

    listener.connected?.({ userId: 'U_self', transport: 'realtime' })
    listener.message?.(history[2]!)
    await waitFor(() => routed.length === 2)

    expect(routed.map((message) => message.externalMessageId)).toEqual(['M-new-1', 'M-new-2'])
    await adapter.stop()
  })

  test('warns once when recovery windows are saturated', async () => {
    const listener = new FakeListener()
    const warnings: string[] = []
    let listChatsCalls = 0
    let saturatedHistoryCalls = 0
    const chats = Array.from({ length: 100 }, (_, index) => chat({ id: `T${index}` }))
    const messages = Array.from({ length: 200 }, (_, index) => msg({ id: `M${index}`, thread_id: 'T0' }))
    const adapter = createInstagramAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
      client: fakeClient({
        listChats: async () => {
          listChatsCalls++
          return chats
        },
        getMessages: async (threadId) => {
          if (threadId !== 'T0') return []
          saturatedHistoryCalls++
          return messages
        },
      }),
      continuityStore: await memoryContinuityStore(),
      listenerCtorResolver: listenerResolver(listener),
    })
    await adapter.start()
    listener.connected?.({ userId: 'U_self', transport: 'realtime' })
    await waitFor(() => listChatsCalls >= 3 && saturatedHistoryCalls >= 2)

    expect(warnings.filter((message) => message.includes('recovery chat list reached'))).toHaveLength(1)
    expect(warnings.filter((message) => message.includes('recovery history reached'))).toHaveLength(1)
    await adapter.stop()
  })

  test('ignores listener messages emitted after stop', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    const adapter = createInstagramAdapter({
      router: makeRouterStub((message) => routed.push(message)),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerCtorResolver: listenerResolver(listener),
    })
    await adapter.start()
    await adapter.stop()

    listener.message?.(msg())
    await Bun.sleep(10)

    expect(routed).toEqual([])
  })
})

function listenerResolver(
  listener: FakeListener,
): NonNullable<Parameters<typeof createInstagramAdapter>[0]['listenerCtorResolver']> {
  return () => ({
    ctor: class {
      constructor() {
        return listener
      }
    } as never,
    transport: 'hybrid',
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function memoryContinuityStore(options: { onMark?: (messageId: string) => void } = {}) {
  const threads = new Map<string, Set<string>>()
  return {
    knowsThread: (accountId: string, threadId: string) => threads.has(`${accountId}:${threadId}`),
    hasMessage: (accountId: string, threadId: string, messageId: string) =>
      threads.get(`${accountId}:${threadId}`)?.has(messageId) ?? false,
    seedThread: async (accountId: string, threadId: string, messageIds: readonly string[]) => {
      threads.set(`${accountId}:${threadId}`, new Set(messageIds))
    },
    markMessage: async (accountId: string, threadId: string, messageId: string) => {
      options.onMark?.(messageId)
      const key = `${accountId}:${threadId}`
      const ids = threads.get(key) ?? new Set<string>()
      ids.add(messageId)
      threads.set(key, ids)
    },
  }
}

function makeRouterStub(onRoute: (m: InboundMessage) => void) {
  const registered = { outbound: false, history: false, nameResolver: false }
  return {
    registered,
    route: async (m: InboundMessage) => {
      onRoute(m)
      return { kind: 'accepted' as const, inputId: m.externalMessageId, generation: 0 }
    },
    registerSelfIdentity: () => {},
    unregisterSelfIdentity: () => {},
    registerOutbound: () => {
      registered.outbound = true
    },
    unregisterOutbound: () => {
      registered.outbound = false
    },
    registerHistory: () => {
      registered.history = true
    },
    unregisterHistory: () => {
      registered.history = false
    },
    registerChannelNameResolver: () => {
      registered.nameResolver = true
    },
    unregisterChannelNameResolver: () => {
      registered.nameResolver = false
    },
  } as unknown as Parameters<typeof createInstagramAdapter>[0]['router'] & { registered: typeof registered }
}
