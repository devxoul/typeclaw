import { describe, expect, test } from 'bun:test'

import type { SlackListener, SlackRTMMessageEvent } from 'agent-messenger/slack'

import type { MembershipResolver } from '@/channels/membership'
import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { InboundMessage, OutboundCallback } from '@/channels/types'
import type { SlackAccountRecord } from '@/secrets/schema'

import { createSlackAdapter, createSlackHistoryCallback, type SlackAdapterLogger } from './slack'
import type { SlackInboundMessageEvent } from './slack-classify'

const config = channelsSchema.parse({ slack: {} }).slack!

function logger(): SlackAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

function account(overrides: Partial<SlackAccountRecord> = {}): SlackAccountRecord {
  return {
    account_id: 'T0123456789',
    token: 'xoxc-test',
    cookie: 'xoxd-test',
    workspace_id: 'T0123456789',
    workspace_name: 'Acme',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

type ConnectMode = 'sync' | 'async' | 'never'

class FakeListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()
  stopped = false
  failStart = false
  connectMode: ConnectMode = 'sync'
  emitErrorOnStart: unknown = null

  on(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  async start(): Promise<void> {
    if (this.failStart) throw new Error('boom')
    if (this.emitErrorOnStart !== null) queueMicrotask(() => this.emit('error', this.emitErrorOnStart))
    if (this.connectMode === 'sync') this.emitConnected()
    else if (this.connectMode === 'async') queueMicrotask(() => this.emitConnected())
  }

  emitConnected(): void {
    this.emit('connected', { self: { id: 'USELF' }, team: { id: 'T0123456789' } })
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
  membership?: MembershipResolver
} {
  const routed: InboundMessage[] = []
  const registered: string[] = []
  const unregistered: string[] = []
  const r = {
    outbound: undefined as OutboundCallback | undefined,
    membership: undefined as MembershipResolver | undefined,
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
    registerMembership: (adapter: string, resolver: MembershipResolver) => {
      registered.push(`membership:${adapter}`)
      r.membership = resolver
    },
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
    membership?: MembershipResolver
  }
}

describe('createSlackAdapter', () => {
  test('start logs in and wires listener/router callbacks with typing disabled', async () => {
    const calls: unknown[] = []
    const r = router()
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        ({
          login: async (opts: unknown) => calls.push(opts),
          testAuth: async () => ({ user_id: 'USELF', team_id: 'T0123456789', user: 'alice', team: 'Acme' }),
          getChannel: async () => ({ id: 'C0123456789', name: 'general' }),
          getUser: async () => ({ id: 'UUSER', name: 'alice', real_name: 'Alice' }),
          getMessages: async () => [],
          listChannelMembers: async () => [],
          sendMessage: async () => ({ ts: '1', text: 'ok', type: 'message' }),
          uploadFile: async () => ({
            id: 'F1',
            name: 'a.txt',
            title: 'a.txt',
            mimetype: 'text/plain',
            size: 1,
            url_private: '',
            created: 1,
            user: 'USELF',
          }),
          downloadFile: async () => ({
            buffer: Buffer.from('x'),
            file: {
              id: 'F1',
              name: 'a.txt',
              title: 'a.txt',
              mimetype: 'text/plain',
              size: 1,
              url_private: '',
              created: 1,
              user: 'USELF',
            },
          }),
          addReaction: async () => {},
          removeReaction: async () => {},
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createSlackAdapter>[0]['createClient']>>,
      createListener: () => new FakeListener() as unknown as SlackListener,
    })

    await adapter.start()

    expect(calls).toEqual([{ token: 'xoxc-test', cookie: 'xoxd-test' }])
    expect(adapter.isConnected()).toBe(true)
    expect(r.registered).toEqual([
      'outbound:slack',
      'typing-cap:slack=false',
      'names:slack',
      'self:slack',
      'history:slack',
      'fetch:slack',
      'membership:slack',
      'reaction:slack',
      'remove-reaction:slack',
      'edit:slack',
    ])
  })

  test('message routes through classifyInbound and stop unregisters callbacks', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      selfAliasesRef: () => ['typeclaw'],
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as SlackListener,
    })

    await adapter.start()
    listener.emit('message', {
      type: 'message',
      channel: 'C0123456789',
      user: 'UUSER',
      text: 'typeclaw hi',
      ts: '1770000000.000100',
    } satisfies SlackRTMMessageEvent)
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.adapter).toBe('slack')
    expect(r.routed[0]?.isBotMention).toBe(false)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:slack')
    expect(r.unregistered).toContain('remove-reaction:slack')
  })

  test('subtype-less RTM file messages reach the router with the same attachment descriptors as history', async () => {
    for (const [text, expectedText] of [
      ['', '[Slack attachment #1: file application/pdf name=report.pdf]'],
      ['please review', 'please review\n[Slack attachment #1: file application/pdf name=report.pdf]'],
    ] as const) {
      const r = router()
      const listener = new FakeListener()
      const adapter = createSlackAdapter({
        router: r,
        configRef: () => config,
        logger: logger(),
        credentialsStore: { getAccount: async () => account() },
        createClient: () => fakeClient(),
        createListener: () => listener as unknown as SlackListener,
      })

      await adapter.start()
      listener.emit('message', {
        type: 'message',
        channel: 'C0123456789',
        user: 'UUSER',
        text,
        ts: '1770000000.000100',
        files: [
          {
            id: 'F0001',
            name: 'report.pdf',
            title: 'report.pdf',
            mimetype: 'application/pdf',
            size: 1024,
            url_private: 'https://files.slack.com/files-pri/T1-F0001/report.pdf',
            created: 1,
            user: 'UUSER',
          },
        ],
      } satisfies SlackInboundMessageEvent)
      await adapter.stop()

      expect(r.routed).toHaveLength(1)
      expect(r.routed[0]?.text).toBe(expectedText)
      expect(r.routed[0]?.externalMessageId).toBe('1770000000.000100')
      expect(r.routed[0]?.attachments).toEqual([
        { id: 1, kind: 'file', ref: 'F0001', filename: 'report.pdf', mimetype: 'application/pdf' },
      ])
    }
  })

  test('G-prefixed conversations use Slack metadata to distinguish MPIMs from private channels', async () => {
    for (const [channel, isMpim, expectedWorkspace] of [
      ['G0MPIM', true, 'T0123456789'],
      ['G0PRIVATE', false, 'T0123456789'],
    ] as const) {
      const r = router()
      const listener = new FakeListener()
      const adapter = createSlackAdapter({
        router: r,
        configRef: () => config,
        logger: logger(),
        credentialsStore: { getAccount: async () => account() },
        createClient: () =>
          fakeClient({
            listDMs: async () => [{ id: channel, user: 'UUSER', is_mpim: isMpim }],
            listChannelMembers: async () => ['UUSER', 'UOTHER', 'USELF'],
          }),
        createListener: () => listener as unknown as SlackListener,
      })

      await adapter.start()
      listener.emit('message', {
        type: 'message',
        channel,
        user: 'UUSER',
        text: 'private conversation',
        ts: '1770000000.000100',
      } satisfies SlackRTMMessageEvent)
      const membership = isMpim
        ? await r.membership?.({ adapter: 'slack', workspace: 'T0123456789', chat: channel, thread: null })
        : undefined
      await adapter.stop()

      expect(r.routed[0]?.workspace).toBe(expectedWorkspace)
      if (isMpim) {
        expect(membership).toEqual({
          humans: 2,
          bots: 1,
          fetchedAt: expect.any(Number),
          truncated: false,
          humanMemberIds: ['UUSER', 'UOTHER'],
        })
      }
    }
  })

  test('outbound sends messages through SlackClient.sendMessage', async () => {
    const sent: unknown[] = []
    const r = router()
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ sendMessage: async (...args: unknown[]) => void sent.push(args) }),
      createListener: () => new FakeListener() as unknown as SlackListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'slack',
      workspace: 'T0123456789',
      chat: 'C0123456789',
      text: 'hello',
    })

    expect(result).toEqual({ ok: true })
    expect(sent).toEqual([['C0123456789', 'hello', undefined]])
  })

  test('user Slack sends reject malformed thread ids and preserve valid ids', async () => {
    const sent: unknown[] = []
    let uploads = 0
    const r = router()
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          sendMessage: async (...args: unknown[]) => void sent.push(args),
          uploadFile: async () => {
            uploads++
            throw new Error('unexpected upload')
          },
        }),
      createListener: () => new FakeListener() as unknown as SlackListener,
    })
    await adapter.start()
    const target = { adapter: 'slack' as const, workspace: 'T0123456789', chat: 'C0123456789', text: 'hello' }
    expect(await r.outbound?.({ ...target, thread: '1700000000.0001' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Slack thread'),
    })
    expect(await r.outbound?.({ ...target, replyTo: { externalMessageId: '1700000000.0001' } })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Slack thread'),
    })
    expect(
      await r.outbound?.({
        ...target,
        text: undefined,
        attachments: [{ path: '/agent/a.png' }],
        thread: '1700000000.0001',
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Slack thread') })
    expect(uploads).toBe(0)
    expect(
      await r.outbound?.({
        ...target,
        thread: '1700000000.000100',
        replyTo: { externalMessageId: '1700000000.0001' },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Slack thread') })
    expect(sent).toHaveLength(0)
    expect(await r.outbound?.({ ...target, thread: '1700000000.000100' })).toEqual({ ok: true })
    expect(sent).toEqual([['C0123456789', 'hello', '1700000000.000100']])
    expect(
      await r.outbound?.({
        ...target,
        thread: '1700000000.0001',
        replyTo: { externalMessageId: '1700000000.000200' },
      }),
    ).toEqual({ ok: true })
    expect(sent[1]).toEqual(['C0123456789', 'hello', '1700000000.000200'])
    await adapter.stop()
  })

  test('listener start failure rolls back registrations', async () => {
    const r = router()
    const listener = new FakeListener()
    listener.failStart = true
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as SlackListener,
    })

    await expect(adapter.start()).rejects.toThrow('boom')

    expect(adapter.isConnected()).toBe(false)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:slack')
    expect(r.unregistered).toContain('remove-reaction:slack')
  })

  test('start resolves when connected is emitted asynchronously after start()', async () => {
    // given: the real SlackListener emits 'connected' on the later `hello` frame,
    // not synchronously inside start()
    const r = router()
    const listener = new FakeListener()
    listener.connectMode = 'async'
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as SlackListener,
    })

    await adapter.start()

    expect(adapter.isConnected()).toBe(true)
  })

  test('reports RTM disconnects and reconnects', async () => {
    const listener = new FakeListener()
    const adapter = createSlackAdapter({
      router: router(),
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as SlackListener,
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)

    listener.emit('disconnected', undefined)
    expect(adapter.isConnected()).toBe(false)

    listener.emitConnected()
    expect(adapter.isConnected()).toBe(true)

    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
  })

  test('an error before connected rolls back with the real reason, not [object ErrorEvent]', async () => {
    const r = router()
    const log = logger()
    const listener = new FakeListener()
    listener.connectMode = 'never'
    listener.emitErrorOnStart = { type: 'error', message: 'invalid_auth' }
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: log,
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as SlackListener,
    })

    await expect(adapter.start()).rejects.toThrow('invalid_auth')
    expect(adapter.isConnected()).toBe(false)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:slack')
    expect(log.lines).toContain('error:[slack] listener error: invalid_auth')
    expect(log.lines.some((line) => line.includes('[object'))).toBe(false)
  })
})

describe('createSlackHistoryCallback', () => {
  function file(overrides: Record<string, unknown> = {}) {
    return {
      id: 'F0001',
      name: 'image.png',
      title: 'image.png',
      mimetype: 'image/png',
      size: 1024,
      url_private: 'https://files.slack.com/files-pri/T1-F0001/image.png',
      created: 1,
      user: 'U123',
      ...overrides,
    }
  }

  async function fetchHistory(messages: unknown[]) {
    const callback = createSlackHistoryCallback({
      client: { getMessages: async () => messages } as unknown as Parameters<
        typeof createSlackHistoryCallback
      >[0]['client'],
      logger: logger(),
    })
    return await callback({ chat: 'C123', thread: null, limit: 10 })
  }

  test('a captionless file in history is addressable by the id it renders', async () => {
    const result = await fetchHistory([{ ts: '1700000000.000100', text: '', type: 'message', files: [file()] }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages[0]?.text).toBe('[Slack attachment #1: file image/png name=image.png]')
    expect(result.messages[0]?.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'F0001', filename: 'image.png', mimetype: 'image/png' },
    ])
  })

  test('placeholder ids line up one-to-one with the structured refs', async () => {
    const result = await fetchHistory([
      {
        ts: '1700000000.000100',
        text: 'two files',
        type: 'message',
        files: [file(), file({ id: 'F0002', name: 'b.pdf', mimetype: 'application/pdf' })],
      },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages[0]?.text).toBe(
      'two files\n[Slack attachment #1: file image/png name=image.png]\n[Slack attachment #2: file application/pdf name=b.pdf]',
    )
    expect(result.messages[0]?.attachments?.map((a) => [a.id, a.ref])).toEqual([
      [1, 'F0001'],
      [2, 'F0002'],
    ])
  })

  test('text-only history messages are untouched and carry no attachments key', async () => {
    const result = await fetchHistory([{ ts: '1700000000.000100', text: 'hello', type: 'message' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages[0]?.text).toBe('hello')
    expect(result.messages[0]?.attachments).toBeUndefined()
  })
})

function fakeClient(
  overrides: Record<string, unknown> = {},
): ReturnType<NonNullable<Parameters<typeof createSlackAdapter>[0]['createClient']>> {
  return {
    login: async () => {},
    testAuth: async () => ({ user_id: 'USELF', team_id: 'T0123456789', user: 'self', team: 'Acme' }),
    getChannel: async () => ({ id: 'C0123456789', name: 'general' }),
    getUser: async () => ({ id: 'UUSER', name: 'alice', real_name: 'Alice' }),
    getMessages: async () => [],
    listChannelMembers: async () => [],
    sendMessage: async () => ({ ts: '1', text: 'ok', type: 'message' }),
    uploadFile: async () => ({
      id: 'F1',
      name: 'a.txt',
      title: 'a.txt',
      mimetype: 'text/plain',
      size: 1,
      url_private: '',
      created: 1,
      user: 'USELF',
    }),
    downloadFile: async () => ({
      buffer: Buffer.from('x'),
      file: {
        id: 'F1',
        name: 'a.txt',
        title: 'a.txt',
        mimetype: 'text/plain',
        size: 1,
        url_private: '',
        created: 1,
        user: 'USELF',
      },
    }),
    addReaction: async () => {},
    removeReaction: async () => {},
    ...overrides,
  } as unknown as ReturnType<NonNullable<Parameters<typeof createSlackAdapter>[0]['createClient']>>
}
