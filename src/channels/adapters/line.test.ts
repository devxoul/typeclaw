import { describe, expect, test } from 'bun:test'

import type {
  LineAccountCredentials,
  LineChat,
  LineListenerEventMap,
  LineMessage,
  LineProfile,
  LineSendResult,
} from 'agent-messenger/line'

import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage, OutboundMessage } from '@/channels/types'
import { waitFor } from '@/test-helpers/wait-for'

import {
  createLineAdapter,
  createLineHistoryCallback,
  createOutboundCallback,
  type LineClient,
  type LineListener,
} from './line'

const SILENT = { info: () => {}, warn: () => {}, error: () => {} }

function profile(): LineProfile {
  return { mid: 'U_self', display_name: 'Bot' }
}

class FakeListener implements LineListener {
  handlers: Partial<{ [K in keyof LineListenerEventMap]: (...args: LineListenerEventMap[K]) => void }> = {}
  started = false
  stopped = false
  start = async (): Promise<void> => {
    this.started = true
  }
  stop = (): void => {
    this.stopped = true
  }
  on = <K extends keyof LineListenerEventMap>(event: K, listener: (...args: LineListenerEventMap[K]) => void): this => {
    this.handlers[event] = listener as never
    return this
  }
  off = (): this => this
  emit<K extends keyof LineListenerEventMap>(event: K, ...args: LineListenerEventMap[K]): void {
    this.handlers[event]?.(...(args as never))
  }
}

function fakeClient(overrides: Partial<LineClient> = {}): LineClient {
  return {
    login: async function (this: LineClient) {
      return this
    },
    getProfile: async () => profile(),
    getChats: async () => [{ chat_id: 'C1', type: 'user', display_name: 'Alice' } satisfies LineChat],
    getMessages: async () => [],
    sendMessage: async (chat_id): Promise<LineSendResult> => ({
      success: true,
      chat_id,
      message_id: 'M_sent',
      sent_at: '2025-01-01T00:00:00.000Z',
    }),
    close: () => {},
    ...overrides,
  }
}

describe('createOutboundCallback', () => {
  const tag = async (): Promise<string> => 'tag'

  test('sends markdown-stripped plain text via sendMessage', async () => {
    const sent: Array<{ chat: string; text: string }> = []
    const cb = createOutboundCallback({
      client: {
        sendMessage: async (chat, text) => {
          sent.push({ chat, text })
          return { success: true, chat_id: chat, message_id: 'M', sent_at: '' }
        },
      },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({ adapter: 'line', workspace: '@line-dm', chat: 'C1', text: '**hi**' } as OutboundMessage)
    expect(res).toEqual({ ok: true, messageId: 'M', messageIds: ['M'] })
    expect(sent).toEqual([{ chat: 'C1', text: 'hi' }])
  })

  test('accepts a preview preference without changing unsupported platform sends', async () => {
    const sent: string[] = []
    const cb = createOutboundCallback({
      client: {
        sendMessage: async (_chat, text) => {
          sent.push(text)
          return { success: true, chat_id: 'C1', message_id: 'M', sent_at: '' }
        },
      },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({
      adapter: 'line',
      workspace: '@line-dm',
      chat: 'C1',
      text: 'https://example.org',
      link_previews: false,
    })
    expect(res.ok).toBe(true)
    expect(sent).toEqual(['https://example.org'])
  })

  test('rejects an outbound carrying attachments', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => ({ success: true, chat_id: 'C1', message_id: 'M', sent_at: '' }) },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({
      adapter: 'line',
      workspace: '@line-dm',
      chat: 'C1',
      text: 'hi',
      attachments: [{ path: '/tmp/x.png' }],
    } as OutboundMessage)
    expect(res.ok).toBe(false)
  })

  test('rejects an empty message', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => ({ success: true, chat_id: 'C1', message_id: 'M', sent_at: '' }) },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({ adapter: 'line', workspace: '@line-dm', chat: 'C1', text: '' } as OutboundMessage)
    expect(res.ok).toBe(false)
  })

  test('rejects a message for a different adapter', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => ({ success: true, chat_id: 'C1', message_id: 'M', sent_at: '' }) },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({ adapter: 'slack-bot', workspace: 'w', chat: 'C1', text: 'hi' } as OutboundMessage)
    expect(res.ok).toBe(false)
  })
})

describe('createLineHistoryCallback', () => {
  test('maps messages and flags the bot author', async () => {
    const messages: LineMessage[] = [
      {
        message_id: 'M1',
        chat_id: 'C1',
        author_id: 'U_self',
        author_name: 'Bot',
        text: 'mine',
        content_type: 'text',
        sent_at: '2025-01-02T00:00:00.000Z',
      },
      {
        message_id: 'M2',
        chat_id: 'C1',
        author_id: 'U_other',
        text: 'theirs',
        content_type: 'text',
        sent_at: '2025-01-02T00:01:00.000Z',
      },
    ]
    const cb = createLineHistoryCallback({
      client: { getMessages: async () => messages },
      logger: SILENT,
      selfUserIdRef: () => 'U_self',
    })
    const result = await cb({ chat: 'C1', thread: null, limit: 50 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages[0]!.isBot).toBe(true)
    expect(result.messages[1]!.isBot).toBe(false)
    expect(result.messages[1]!.authorName).toBe('U_other')
    expect(result.messages[0]!.ts).toBe(Date.parse('2025-01-02T00:00:00.000Z'))
  })
})

describe('createLineAdapter lifecycle', () => {
  test('authenticates, registers callbacks, and routes an inbound', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    const router = makeRouterStub((m) => routed.push(m))

    const adapter = createLineAdapter({
      router,
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerFactory: () => listener,
      credentialsStore: {
        load: async () => ({ current_account: 'U_self', accounts: {} }),
        getAccount: async () => ({
          account_id: 'U_self',
          auth_token: 't',
          device: 'DESKTOPMAC',
          created_at: '',
          updated_at: '',
        }),
      },
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(false)
    listener.emit('connected', { account_id: 'U_self' })
    expect(adapter.isConnected()).toBe(true)
    expect(router.registered.outbound).toBe(true)
    expect(router.registered.history).toBe(true)
    expect(router.registered.nameResolver).toBe(true)

    const message = {
      type: 'message' as const,
      chat_id: 'C1',
      message_id: 'M1',
      author_id: 'U_other',
      text: 'hello bot',
      content_type: 'text',
      content_metadata: {},
      sent_at: '2025-01-02T00:00:00.000Z',
    }
    listener.emit('message', message)
    await waitFor(() => routed.length > 0)
    expect(routed[0]!.text).toBe('hello bot')
    expect(routed[0]!.workspace).toBe('@line-dm')

    await adapter.stop()
    expect(listener.stopped).toBe(true)
    expect(router.registered.outbound).toBe(false)
  })

  test('wires the credentials store as the client credential manager so listener re-login resolves it', async () => {
    // given a store-backed client whose no-arg login() (the LineListener reconnect
    // path) resolves credentials only through its injected credential manager
    const store = {
      load: async () => ({ current_account: 'U_self', accounts: {} }),
      getAccount: async () => ({
        account_id: 'U_self',
        auth_token: 't',
        device: 'DESKTOPMAC' as const,
        created_at: '',
        updated_at: '',
      }),
    }
    let factoryCredManager: unknown
    const buildStoreBackedClient = (credManager?: unknown): LineClient => {
      factoryCredManager = credManager
      return fakeClient({
        login: async function (this: LineClient, credentials) {
          if (credentials === undefined) {
            const account = await (credManager as typeof store | undefined)?.getAccount()
            if (!account) throw new Error('No account found. Call loginWithQR() or loginWithEmail() first.')
          }
          return this
        },
      })
    }

    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      clientFactory: buildStoreBackedClient as never,
      listenerFactory: () => new FakeListener(),
      credentialsStore: store,
    })

    // when the adapter starts (no explicit client injected)
    await adapter.start()

    // then the factory received the credentials store as the credential manager,
    // so an argument-less re-login resolves the account instead of throwing
    expect(factoryCredManager).toBe(store)
    const reLoginClient = buildStoreBackedClient(factoryCredManager)
    await expect(reLoginClient.login()).resolves.toBeDefined()
  })

  test('start throws when no account is stored', async () => {
    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerFactory: () => new FakeListener(),
      credentialsStore: { load: async () => ({ current_account: null, accounts: {} }), getAccount: async () => null },
    })
    await expect(adapter.start()).rejects.toThrow(/no LINE account/)
  })
})

describe('createLineAdapter token refresh', () => {
  function expiringToken(expSecondsFromNow: number, nowMs: number): string {
    const b64 = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
    const exp = Math.floor(nowMs / 1000) + expSecondsFromNow
    return `${b64({ alg: 'HS256' })}.${b64({ exp })}.sig`
  }

  function storeWithAccount(authToken: string) {
    const saved: LineAccountCredentials[] = []
    const account: LineAccountCredentials = {
      account_id: 'U_self',
      auth_token: authToken,
      device: 'DESKTOPMAC',
      created_at: '',
      updated_at: '',
    }
    return {
      saved,
      store: {
        load: async () => ({ current_account: 'U_self', accounts: { U_self: account } }),
        getAccount: async () => account,
        setAccount: async (next: LineAccountCredentials) => {
          saved.push(next)
        },
      },
    }
  }

  test('refreshes a near-expiry token at startup and persists the new token', async () => {
    const nowMs = 1_781_000_000_000
    const { saved, store } = storeWithAccount(expiringToken(60, nowMs))
    const client = fakeClient({
      ensureFreshAuthToken: async () => 'fresh-token',
    })

    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client,
      listenerFactory: () => new FakeListener(),
      credentialsStore: store,
      now: () => nowMs,
    })

    await adapter.start()

    expect(saved).toHaveLength(1)
    expect(saved[0]!.auth_token).toBe('fresh-token')
    expect(saved[0]!.account_id).toBe('U_self')
    await adapter.stop()
  })

  test('persists a token delivered via the onTokenUpdate event', async () => {
    const nowMs = 1_781_000_000_000
    const { saved, store } = storeWithAccount(expiringToken(60 * 60 * 24 * 30, nowMs))
    let tokenListener: ((t: string) => void) | undefined
    const client = fakeClient({
      onTokenUpdate: (listener) => {
        tokenListener = listener
      },
    })

    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client,
      listenerFactory: () => new FakeListener(),
      credentialsStore: store,
      now: () => nowMs,
    })

    await adapter.start()
    expect(tokenListener).toBeDefined()
    tokenListener!('rotated-token')
    await waitFor(() => saved.length > 0)

    expect(saved.at(-1)!.auth_token).toBe('rotated-token')
    await adapter.stop()
  })

  test('retries persistence with the same token after a failed write', async () => {
    const nowMs = 1_781_000_000_000
    const account: LineAccountCredentials = {
      account_id: 'U_self',
      auth_token: expiringToken(60 * 60 * 24 * 30, nowMs),
      device: 'DESKTOPMAC',
      created_at: '',
      updated_at: '',
    }
    const saved: LineAccountCredentials[] = []
    let failNext = true
    const store = {
      load: async () => ({ current_account: 'U_self', accounts: { U_self: account } }),
      getAccount: async () => account,
      setAccount: async (next: LineAccountCredentials) => {
        if (failNext) {
          failNext = false
          throw new Error('secrets-patch failed: hostd unreachable')
        }
        saved.push(next)
      },
    }
    let tokenListener: ((t: string) => void) | undefined
    const client = fakeClient({
      onTokenUpdate: (listener) => {
        tokenListener = listener
      },
    })

    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client,
      listenerFactory: () => new FakeListener(),
      credentialsStore: store,
      now: () => nowMs,
    })

    await adapter.start()

    tokenListener!('rotated-token')
    await waitFor(() => failNext === false)
    expect(saved).toHaveLength(0)

    tokenListener!('rotated-token')
    await waitFor(() => saved.length > 0)
    expect(saved.at(-1)!.auth_token).toBe('rotated-token')
    await adapter.stop()
  })

  test('a refresh failure at startup is non-fatal', async () => {
    const nowMs = 1_781_000_000_000
    const { saved, store } = storeWithAccount(expiringToken(60, nowMs))
    const client = fakeClient({
      ensureFreshAuthToken: async () => {
        throw new Error('refresh endpoint 500')
      },
    })

    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client,
      listenerFactory: () => new FakeListener(),
      credentialsStore: store,
      now: () => nowMs,
    })

    await expect(adapter.start()).resolves.toBeUndefined()
    expect(saved).toHaveLength(0)
    await adapter.stop()
  })

  test('a client without the refresh surface starts cleanly (SDK version skew)', async () => {
    const nowMs = 1_781_000_000_000
    const { saved, store } = storeWithAccount(expiringToken(60, nowMs))
    const client = fakeClient()

    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client,
      listenerFactory: () => new FakeListener(),
      credentialsStore: store,
      now: () => nowMs,
    })

    await expect(adapter.start()).resolves.toBeUndefined()
    expect(saved).toHaveLength(0)
    await adapter.stop()
  })
})

function makeRouterStub(onRoute: (m: InboundMessage) => void) {
  const registered = { outbound: false, history: false, nameResolver: false }
  return {
    registered,
    route: async (m: InboundMessage) => onRoute(m),
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
  } as unknown as Parameters<typeof createLineAdapter>[0]['router'] & {
    registered: { outbound: boolean; history: boolean; nameResolver: boolean }
  }
}
