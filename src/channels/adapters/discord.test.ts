import { describe, expect, test } from 'bun:test'

import type { DiscordGatewayMessageCreateEvent, DiscordListener } from 'agent-messenger/discord'

import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { InboundMessage, OutboundCallback } from '@/channels/types'
import type { DiscordAccountRecord } from '@/secrets/schema'

import { createDiscordAdapter, createDiscordHistoryCallback, type DiscordAdapterLogger } from './discord'

const config = channelsSchema.parse({ discord: {} }).discord!

function logger(): DiscordAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

function account(overrides: Partial<DiscordAccountRecord> = {}): DiscordAccountRecord {
  return {
    account_id: '100000000000000001',
    token: 'discord-token-test',
    username: 'self',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

class FakeListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()
  stopped = false
  failStart = false

  on(event: string, handler: (value: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }

  async start(): Promise<void> {
    if (this.failStart) throw new Error('boom')
    this.emit('connected', { user: { id: '100000000000000001', username: 'self' }, sessionId: 'session-1' })
  }

  stop(): void {
    this.stopped = true
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
}

function router(): ChannelRouter & {
  routed: InboundMessage[]
  registered: string[]
  unregistered: string[]
  outbound?: OutboundCallback
} {
  const routed: InboundMessage[] = []
  const registered: string[] = []
  const unregistered: string[] = []
  const r = {
    outbound: undefined as OutboundCallback | undefined,
    routed,
    registered,
    unregistered,
    route: async (msg: InboundMessage) => {
      routed.push(msg)
    },
    registerOutbound: (adapter: string, cb: OutboundCallback) => {
      registered.push(`outbound:${adapter}`)
      r.outbound = cb
    },
    unregisterOutbound: (adapter: string) => unregistered.push(`outbound:${adapter}`),
    setTypingCapability: (adapter: string, supported: boolean) =>
      registered.push(`typing-cap:${adapter}=${String(supported)}`),
    registerChannelNameResolver: (adapter: string) => registered.push(`names:${adapter}`),
    unregisterChannelNameResolver: (adapter: string) => unregistered.push(`names:${adapter}`),
    registerSelfIdentity: (adapter: string) => registered.push(`self:${adapter}`),
    unregisterSelfIdentity: (adapter: string) => unregistered.push(`self:${adapter}`),
    registerHistory: (adapter: string) => registered.push(`history:${adapter}`),
    unregisterHistory: (adapter: string) => unregistered.push(`history:${adapter}`),
    registerFetchAttachment: (adapter: string) => registered.push(`fetch:${adapter}`),
    unregisterFetchAttachment: (adapter: string) => unregistered.push(`fetch:${adapter}`),
    registerMembership: (adapter: string) => registered.push(`membership:${adapter}`),
    unregisterMembership: (adapter: string) => unregistered.push(`membership:${adapter}`),
    registerReaction: (adapter: string) => registered.push(`reaction:${adapter}`),
    unregisterReaction: (adapter: string) => unregistered.push(`reaction:${adapter}`),
    registerRemoveReaction: (adapter: string) => registered.push(`remove-reaction:${adapter}`),
    unregisterRemoveReaction: (adapter: string) => unregistered.push(`remove-reaction:${adapter}`),
    registerPrepareOwnReaction: () => {},
    unregisterPrepareOwnReaction: () => {},
    registerRemoveOwnReaction: () => {},
    unregisterRemoveOwnReaction: () => {},
    registerEditMessage: (adapter: string) => registered.push(`edit:${adapter}`),
    unregisterEditMessage: (adapter: string) => unregistered.push(`edit:${adapter}`),
  }
  return r as unknown as ChannelRouter & {
    routed: InboundMessage[]
    registered: string[]
    unregistered: string[]
    outbound?: OutboundCallback
  }
}

describe('createDiscordAdapter', () => {
  test('start logs in and wires listener/router callbacks with typing disabled', async () => {
    const calls: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ login: async (opts: unknown) => calls.push(opts) }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()

    expect(calls).toEqual([{ token: 'discord-token-test' }])
    expect(adapter.isConnected()).toBe(true)
    expect(r.registered).toEqual([
      'outbound:discord',
      'typing-cap:discord=false',
      'names:discord',
      'self:discord',
      'history:discord',
      'fetch:discord',
      'membership:discord',
      'reaction:discord',
      'remove-reaction:discord',
      'edit:discord',
    ])
  })

  test('message routes through classifyInbound and stop unregisters callbacks', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      selfAliasesRef: () => ['typeclaw'],
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as DiscordListener,
    })

    await adapter.start()
    listener.emit('message_create', {
      type: 'MESSAGE_CREATE',
      id: '400000000000000004',
      channel_id: '300000000000000003',
      guild_id: '200000000000000002',
      author: { id: '500000000000000005', username: 'alice' },
      content: 'typeclaw hi',
      timestamp: '2026-01-01T00:00:00.000Z',
    } satisfies DiscordGatewayMessageCreateEvent)
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.adapter).toBe('discord')
    expect(r.routed[0]?.isBotMention).toBe(true)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:discord')
    expect(r.unregistered).toContain('remove-reaction:discord')
  })

  test('captures Discord thread parent id and name before routing', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getChannel: async (id: string) =>
            id === '300000000000000003'
              ? {
                  id,
                  guild_id: '200000000000000002',
                  name: 'topic-thread',
                  type: 11,
                  parent_id: '300000000000000099',
                }
              : { id, guild_id: '200000000000000002', name: 'development', type: 0 },
        }),
      createListener: () => listener as unknown as DiscordListener,
    })

    await adapter.start()
    listener.emit('message_create', {
      type: 'MESSAGE_CREATE',
      id: '400000000000000004',
      channel_id: '300000000000000003',
      guild_id: '200000000000000002',
      author: { id: '500000000000000005', username: 'alice' },
      content: 'thread message',
      timestamp: '2026-01-01T00:00:00.000Z',
    } satisfies DiscordGatewayMessageCreateEvent)
    await adapter.stop()

    expect(r.routed[0]?.room).toEqual({
      kind: 'thread',
      parentChat: '300000000000000099',
      parentChatName: 'development',
    })
  })

  test('a known DM routes successfully without channel metadata resolution', async () => {
    const r = router()
    const listener = new FakeListener()
    let channelMetadataCalls = 0
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getChannel: async () => {
            channelMetadataCalls++
            return { id: '300000000000000003', name: 'should-not-resolve', type: 0 }
          },
        }),
      createListener: () => listener as unknown as DiscordListener,
    })

    await adapter.start()
    listener.emit('message_create', {
      type: 'MESSAGE_CREATE',
      id: '400000000000000004',
      channel_id: '300000000000000003',
      author: { id: '500000000000000005', username: 'alice' },
      content: 'private message',
      timestamp: '2026-01-01T00:00:00.000Z',
    } satisfies DiscordGatewayMessageCreateEvent)
    await adapter.stop()

    expect(r.routed[0]?.workspace).toBe('@dm')
    expect(r.routed[0]?.room).toBeUndefined()
    expect(channelMetadataCalls).toBe(0)
  })

  test('adapter start triggers observable resolver-backed historical provenance maintenance', async () => {
    const r = router()
    const listener = new FakeListener()
    const log = logger()
    const calls: string[] = []
    const adapter = createDiscordAdapter({
      agentDir: '/agent',
      router: r,
      configRef: () => config,
      logger: log,
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as DiscordListener,
      enrichHistoricalProvenance: async (agentDir, resolve, options) => {
        calls.push(agentDir)
        expect(options.adapter).toBe('discord')
        const resolved = await resolve({
          adapter: 'discord',
          workspace: '200000000000000002',
          chat: '300000000000000003',
          thread: null,
        })
        expect(resolved.where.workspaceName).toBe('Example Guild')
        expect(resolved.parentChecked).toBe(true)
        return { scanned: 1, attempted: 1, resolved: 1, failed: 0, timedOut: 0, changed: true }
      },
    })

    await adapter.start()
    await Bun.sleep(0)

    expect(calls).toEqual(['/agent'])
    expect(log.lines).toContain(
      'info:[discord] historical provenance enrichment scanned=1 attempted=1 resolved=1 failed=0 timed_out=0 changed=true',
    )
  })

  test('outbound sends messages through DiscordClient.sendMessage', async () => {
    const sent: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ sendMessage: async (...args: unknown[]) => void sent.push(args) }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      text: 'hello',
    })

    expect(result).toEqual({ ok: true })
    expect(sent).toEqual([['300000000000000003', 'hello', undefined]])
  })

  test('outbound forwards replyTo as the reply_to option on the first text chunk (native reply)', async () => {
    const sent: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ sendMessage: async (...args: unknown[]) => void sent.push(args) }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      text: 'on it',
      replyTo: { externalMessageId: '900000000000000009' },
    })

    expect(result).toEqual({ ok: true })
    expect(sent).toEqual([['300000000000000003', 'on it', { reply_to: '900000000000000009' }]])
  })

  test('attachment-only reply forwards reply_to on the first file upload (native reply)', async () => {
    const uploads: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ uploadFile: async (...args: unknown[]) => void uploads.push(args) }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      attachments: [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }],
      replyTo: { externalMessageId: '900000000000000009' },
    })

    expect(result).toEqual({ ok: true })
    expect(uploads).toEqual([
      ['300000000000000003', '/tmp/a.png', { reply_to: '900000000000000009' }],
      ['300000000000000003', '/tmp/b.png', undefined],
    ])
  })

  test('text+attachment reply keeps reply_to on the text send, files upload bare', async () => {
    const uploads: unknown[] = []
    const sent: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          uploadFile: async (...args: unknown[]) => void uploads.push(args),
          sendMessage: async (...args: unknown[]) => void sent.push(args),
        }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      text: 'here you go',
      attachments: [{ path: '/tmp/a.png' }],
      replyTo: { externalMessageId: '900000000000000009' },
    })

    expect(result).toEqual({ ok: true })
    expect(uploads).toEqual([['300000000000000003', '/tmp/a.png', undefined]])
    expect(sent).toEqual([['300000000000000003', 'here you go', { reply_to: '900000000000000009' }]])
  })

  test('outbound uploads attachments before posting text', async () => {
    // given an outbound with both an attachment and text
    const calls: string[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          uploadFile: async () => void calls.push('upload'),
          sendMessage: async () => {
            calls.push('send')
            return { id: '1', channel_id: '3', author: { id: '0', username: 'self' }, content: 'ok', timestamp: '' }
          },
        }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    // when
    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      text: 'hello',
      attachments: [{ path: '/tmp/a.txt' }],
    })

    // then the upload happens first so a failed upload never leaves text-only posted
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['upload', 'send'])
  })

  test('listener start failure rolls back registrations', async () => {
    const r = router()
    const listener = new FakeListener()
    listener.failStart = true
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as DiscordListener,
    })

    await expect(adapter.start()).rejects.toThrow('boom')

    expect(adapter.isConnected()).toBe(false)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:discord')
    expect(r.unregistered).toContain('remove-reaction:discord')
  })
})

describe('createDiscordHistoryCallback', () => {
  function historyMessage(overrides: Record<string, unknown> = {}) {
    return {
      id: '400000000000000004',
      channel_id: '300000000000000003',
      author: { id: '500000000000000005', username: 'alice' },
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  async function fetchHistory(messages: unknown[]) {
    const callback = createDiscordHistoryCallback({
      client: { getMessages: async () => messages } as unknown as Parameters<
        typeof createDiscordHistoryCallback
      >[0]['client'],
      logger: logger(),
    })
    return await callback({ chat: '300000000000000003', thread: null, limit: 10 })
  }

  test('a captionless image in history is addressable and carries its CDN ref', async () => {
    const result = await fetchHistory([
      historyMessage({
        content: '',
        attachments: [
          {
            id: '1',
            filename: 'image.png',
            size: 1024,
            url: 'https://cdn.discordapp.com/attachments/1/2/image.png',
            content_type: 'image/webp',
          },
        ],
      }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [message] = result.messages
    expect(message?.text).toBe('[Discord attachment #1: file image/webp name=image.png]')
    expect(message?.attachments).toEqual([
      {
        id: 1,
        kind: 'file',
        ref: 'https://cdn.discordapp.com/attachments/1/2/image.png',
        filename: 'image.png',
        mimetype: 'image/webp',
      },
    ])
  })

  test('placeholder ids line up one-to-one with the structured refs', async () => {
    const result = await fetchHistory([
      historyMessage({
        content: 'two files',
        attachments: [
          { id: '1', filename: 'a.png', size: 1, url: 'https://cdn.discordapp.com/attachments/1/2/a.png' },
          {
            id: '2',
            filename: 'b.pdf',
            size: 1,
            url: 'https://cdn.discordapp.com/attachments/1/3/b.pdf',
            content_type: 'application/pdf',
          },
        ],
      }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const message = result.messages[0]
    expect(message?.text).toBe(
      'two files\n[Discord attachment #1: file name=a.png]\n[Discord attachment #2: file application/pdf name=b.pdf]',
    )
    expect(message?.attachments?.map((a) => [a.id, a.ref])).toEqual([
      [1, 'https://cdn.discordapp.com/attachments/1/2/a.png'],
      [2, 'https://cdn.discordapp.com/attachments/1/3/b.pdf'],
    ])
  })

  test('text-only history messages are untouched and carry no attachments key', async () => {
    const result = await fetchHistory([historyMessage()])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages[0]?.text).toBe('hello')
    expect(result.messages[0]?.attachments).toBeUndefined()
  })
})

function fakeClient(
  overrides: Record<string, unknown> = {},
): ReturnType<NonNullable<Parameters<typeof createDiscordAdapter>[0]['createClient']>> {
  return {
    login: async () => {},
    testAuth: async () => ({ id: '100000000000000001', username: 'self', global_name: 'Self' }),
    getChannel: async () => ({ id: '300000000000000003', guild_id: '200000000000000002', name: 'general', type: 0 }),
    getServer: async () => ({ id: '200000000000000002', name: 'Example Guild' }),
    getUser: async () => ({ id: '500000000000000005', username: 'alice', global_name: 'Alice' }),
    getMessages: async () => [],
    sendMessage: async () => ({
      id: '400000000000000004',
      channel_id: '300000000000000003',
      author: { id: '100000000000000001', username: 'self' },
      content: 'ok',
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    uploadFile: async () => ({
      id: '700000000000000007',
      filename: 'a.txt',
      size: 1,
      url: 'https://cdn.example.invalid/a.txt',
    }),
    addReaction: async () => {},
    removeReaction: async () => {},
    ...overrides,
  } as unknown as ReturnType<NonNullable<Parameters<typeof createDiscordAdapter>[0]['createClient']>>
}
