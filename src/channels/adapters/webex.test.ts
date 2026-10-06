import { describe, expect, test } from 'bun:test'

import type { WebexListener, WebexMessage } from 'agent-messenger/webex'

import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { InboundMessage, OutboundMessage } from '@/channels/types'
import type { WebexAccountRecord } from '@/secrets/schema'

import {
  createOutboundCallback,
  createTypingCallback,
  createWebexAdapter,
  createWebexHistoryCallback,
  type WebexAdapterLogger,
} from './webex'
import type { WebexInboundMessage } from './webex-classify'
import { createWebexPrefetchLimiter } from './webex-prefetch-limiter'

const config = channelsSchema.parse({ webex: {} }).webex!

function logger(): WebexAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

function account(overrides: Partial<WebexAccountRecord> = {}): WebexAccountRecord {
  return {
    account_id: 'account-1',
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: 1_800_000_000,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function inbound(overrides: Partial<WebexInboundMessage> = {}): WebexInboundMessage {
  return {
    id: 'msg-1',
    ref: 'msg-1',
    roomId: 'room-1',
    roomRef: 'room-1',
    personId: 'user-1',
    personRef: 'user-1',
    personEmail: 'user@example.com',
    text: 'hello typeclaw',
    created: '2026-01-01T00:00:00.000Z',
    roomType: 'group',
    mentionedPeople: [],
    mentionedPeopleRefs: [],
    mentionedGroups: [],
    files: [],
    raw: {} as WebexInboundMessage['raw'],
    ...overrides,
  }
}

class FakeListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()
  stopped = false

  on(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  async start(): Promise<void> {
    this.emit('connected', undefined)
  }

  stop(): void {
    this.stopped = true
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
}

function router(): ChannelRouter & { routed: InboundMessage[]; registered: string[]; unregistered: string[] } {
  const routed: InboundMessage[] = []
  const registered: string[] = []
  const unregistered: string[] = []
  return {
    routed,
    registered,
    unregistered,
    route: async (msg: InboundMessage) => {
      routed.push(msg)
      return { kind: 'accepted' as const, inputId: msg.externalMessageId, generation: 0 }
    },
    registerOutbound: (adapter: string) => registered.push(`outbound:${adapter}`),
    unregisterOutbound: (adapter: string) => unregistered.push(`outbound:${adapter}`),
    registerTyping: (adapter: string) => registered.push(`typing:${adapter}`),
    unregisterTyping: (adapter: string) => unregistered.push(`typing:${adapter}`),
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
    registerEditMessage: (adapter: string) => registered.push(`edit:${adapter}`),
    unregisterEditMessage: (adapter: string) => unregistered.push(`edit:${adapter}`),
  } as unknown as ChannelRouter & { routed: InboundMessage[]; registered: string[]; unregistered: string[] }
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return { adapter: 'webex', workspace: 'room-1', chat: 'room-1', text: 'hello', ...overrides }
}

function webexMessage(overrides: Partial<WebexMessage> = {}): WebexMessage {
  return {
    id: 'm',
    ref: 'm',
    roomId: 'room-1',
    roomRef: 'room-1',
    roomType: 'group',
    text: 'hi',
    personId: 'p',
    personRef: 'p',
    personEmail: 'p@example.com',
    created: '2026-01-01T00:00:00.000Z',
    files: [],
    ...overrides,
  }
}

describe('webex outbound', () => {
  function outboundClient() {
    const sends: Array<{ roomId: string; text: string; parentId?: string }> = []
    const uploads: Array<{ roomId: string; filename: string; text?: string; parentId?: string }> = []
    return {
      sends,
      uploads,
      client: {
        sendMessage: async (roomId: string, text: string, options?: { parentId?: string }) => {
          sends.push({ roomId, text, parentId: options?.parentId })
          return webexMessage({ ref: 'sent', text })
        },
        uploadFile: async (
          roomId: string,
          file: { content: Blob; filename: string },
          options?: { text?: string; parentId?: string },
        ) => {
          uploads.push({ roomId, filename: file.filename, text: options?.text, parentId: options?.parentId })
          return webexMessage({ ref: `up-${uploads.length}` })
        },
      },
    }
  }

  test('returns the sent message ref as messageId for a plain-text send', async () => {
    const { client } = outboundClient()
    const cb = createOutboundCallback({ client, logger: logger(), formatChannelTag: async () => 'room=room-1' })

    const result = await cb(outbound({ text: 'hi' }))

    expect(result).toEqual({ ok: true, messageId: 'sent', messageIds: ['sent'] })
  })

  test('surfaces the upload ref as the anchor for a text+file send', async () => {
    const { sends, uploads, client } = outboundClient()
    const cb = createOutboundCallback({
      client,
      logger: logger(),
      formatChannelTag: async () => 'room=room-1',
      readFile: async (path) => ({ content: new Blob(['data']), filename: path.split('/').pop() ?? 'x' }),
    })

    const result = await cb(outbound({ text: 'caption', thread: 'root-1', attachments: [{ path: '/tmp/a.txt' }] }))

    expect(result).toEqual({ ok: true, messageId: 'up-1', messageIds: ['up-1'] })
    expect(sends).toEqual([])
    expect(uploads).toEqual([{ roomId: 'room-1', filename: 'a.txt', text: 'caption', parentId: 'root-1' }])
  })

  test('lists every upload ref in send order for a multi-file send', async () => {
    const { uploads, client } = outboundClient()
    const cb = createOutboundCallback({
      client,
      logger: logger(),
      formatChannelTag: async () => 'room=room-1',
      readFile: async (path) => ({ content: new Blob(['data']), filename: path.split('/').pop() ?? 'x' }),
    })

    const result = await cb(
      outbound({ text: 'caption', thread: 'root-1', attachments: [{ path: '/tmp/a.txt' }, { path: '/tmp/b.txt' }] }),
    )

    expect(result).toEqual({ ok: true, messageId: 'up-1', messageIds: ['up-1', 'up-2'] })
    expect(uploads).toEqual([
      { roomId: 'room-1', filename: 'a.txt', text: 'caption', parentId: 'root-1' },
      { roomId: 'room-1', filename: 'b.txt', text: undefined, parentId: 'root-1' },
    ])
  })

  test('surfaces the upload ref for an attachment-only send', async () => {
    const { uploads, client } = outboundClient()
    const cb = createOutboundCallback({
      client,
      logger: logger(),
      formatChannelTag: async () => 'room=room-1',
      readFile: async (path) => ({ content: new Blob(['data']), filename: path.split('/').pop() ?? 'x' }),
    })

    const result = await cb(outbound({ text: '', attachments: [{ path: '/tmp/a.txt' }] }))

    expect(result).toEqual({ ok: true, messageId: 'up-1', messageIds: ['up-1'] })
    expect(uploads).toEqual([{ roomId: 'room-1', filename: 'a.txt', text: undefined, parentId: undefined }])
  })

  test('returns ok false when an upload fails', async () => {
    const cb = createOutboundCallback({
      client: {
        sendMessage: async () => webexMessage({ ref: 'unused' }),
        uploadFile: async () => Promise.reject(new Error('upload boom')),
      },
      logger: logger(),
      formatChannelTag: async () => 'room=room-1',
      readFile: async () => ({ content: new Blob(['data']), filename: 'a.txt' }),
    })

    await expect(cb(outbound({ text: '', attachments: [{ path: '/tmp/a.txt' }] }))).resolves.toEqual({
      ok: false,
      error: 'upload boom',
    })
  })
})

describe('createWebexAdapter', () => {
  test('start logs in with account token and wires listener/router callbacks', async () => {
    const calls: unknown[] = []
    const r = router()
    const listener = new FakeListener()
    const adapter = createWebexAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account({ device_url: 'device-url' }) },
      createClient: () =>
        ({
          login: async (opts: unknown) => calls.push(opts),
          testAuth: async () => ({ id: 'self-blob', ref: 'self-1', emails: ['self@example.com'], displayName: 'Self' }),
          listMemberships: async () => [],
          listMessages: async () => [],
          sendMessage: async () => ({ id: 'sent' }),
          uploadFile: async () => ({ id: 'uploaded' }),
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createWebexAdapter>[0]['createClient']>>,
      createListener: () => listener as unknown as WebexListener,
    })

    await adapter.start()

    expect(calls).toEqual([{ token: 'access-1', deviceUrl: 'device-url', tokenType: 'password' }])
    expect(adapter.isConnected()).toBe(true)
    expect(r.registered).toEqual([
      'outbound:webex',
      'typing:webex',
      'typing-cap:webex=true',
      'names:webex',
      'self:webex',
      'history:webex',
      'fetch:webex',
      'membership:webex',
      'edit:webex',
    ])
  })

  test('auth log prints the bot person ref', async () => {
    // base64url of ciscospark://us/PEOPLE/b278882e-b28b-4cc4-b08b-4b08db7369db
    const personId = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9iMjc4ODgyZS1iMjhiLTRjYzQtYjA4Yi00YjA4ZGI3MzY5ZGI'
    const log = logger()
    const adapter = createWebexAdapter({
      router: router(),
      configRef: () => config,
      logger: log,
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        ({
          login: async () => {},
          testAuth: async () => ({
            id: personId,
            ref: 'b278882e-b28b-4cc4-b08b-4b08db7369db',
            emails: ['typeey@example.com'],
            displayName: 'Typeey',
          }),
          listMemberships: async () => [],
          listMessages: async () => [],
          sendMessage: async () => ({ id: 'sent' }),
          uploadFile: async () => ({ id: 'uploaded' }),
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createWebexAdapter>[0]['createClient']>>,
      createListener: () => new FakeListener() as unknown as WebexListener,
    })

    await adapter.start()

    expect(log.lines).toContain('info:[webex] authenticated as Typeey (b278882e-b28b-4cc4-b08b-4b08db7369db)')
  })

  test('missing account throws the documented error', async () => {
    const adapter = createWebexAdapter({
      router: router(),
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => null },
    })

    await expect(adapter.start()).rejects.toThrow('no Webex account in secrets.json#channels.webex')
  })

  test('message_created routes through classifyInbound', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createWebexAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      selfAliasesRef: () => ['typeclaw'],
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        ({
          login: async () => {},
          testAuth: async () => ({ id: 'self-blob', ref: 'self-1', emails: ['self@example.com'], displayName: 'Self' }),
          listMemberships: async () => [],
          listMessages: async () => [],
          sendMessage: async () => ({ id: 'sent' }),
          uploadFile: async () => ({ id: 'uploaded' }),
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createWebexAdapter>[0]['createClient']>>,
      createListener: () => listener as unknown as WebexListener,
    })

    await adapter.start()
    listener.emit('message_created', inbound())
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.adapter).toBe('webex')
    expect(r.routed[0]?.isBotMention).toBe(true)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:webex')
  })

  test('inbound/routed logs print event refs', async () => {
    // base64url of ciscospark://us/ROOM/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    const roomId = 'Y2lzY29zcGFyazovL3VzL1JPT00vYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl'
    // base64url of ciscospark://us/MESSAGE/99999999-8888-7777-6666-555555555555
    const msgId = 'Y2lzY29zcGFyazovL3VzL01FU1NBR0UvOTk5OTk5OTktODg4OC03Nzc3LTY2NjYtNTU1NTU1NTU1NTU1'
    const log = logger()
    const listener = new FakeListener()
    const adapter = createWebexAdapter({
      router: router(),
      configRef: () => config,
      logger: log,
      selfAliasesRef: () => ['typeclaw'],
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        ({
          login: async () => {},
          testAuth: async () => ({ id: 'self-blob', ref: 'self-1', emails: ['self@example.com'], displayName: 'Self' }),
          listMemberships: async () => [],
          listMessages: async () => [],
          sendMessage: async () => ({ id: 'sent' }),
          uploadFile: async () => ({ id: 'uploaded' }),
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createWebexAdapter>[0]['createClient']>>,
      createListener: () => listener as unknown as WebexListener,
    })

    await adapter.start()
    listener.emit(
      'message_created',
      inbound({
        id: msgId,
        ref: '99999999-8888-7777-6666-555555555555',
        roomId,
        roomRef: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        text: 'hello typeclaw',
      }),
    )
    await adapter.stop()

    const inboundLine = log.lines.find((l) => l.includes('inbound id='))
    expect(inboundLine).toContain('id=99999999-8888-7777-6666-555555555555')
    expect(inboundLine).toContain('room=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(inboundLine).not.toContain('Y2lz')
  })
})

describe('createWebexHistoryCallback reply attribution', () => {
  const message = (over: Partial<WebexMessage>): WebexMessage => ({
    id: 'm',
    ref: 'm',
    roomId: 'room-1',
    roomRef: 'room-1',
    roomType: 'group',
    text: 'hi',
    personId: 'p',
    personRef: 'p',
    personEmail: 'p@example.com',
    created: '2026-01-01T00:00:00.000Z',
    files: [],
    ...over,
  })

  const historyOf = async (messages: WebexMessage[], botPersonId: string | null) => {
    const cb = createWebexHistoryCallback({
      client: { listMessages: async () => messages },
      logger: logger(),
      botPersonIdRef: () => botPersonId,
    })
    const res = await cb({ chat: 'room-1', thread: null, limit: 50 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok history result')
    return res.messages
  }

  test('numbers every history file so each is separately addressable', async () => {
    const history = await historyOf(
      [
        message({
          ref: 'm-1',
          text: 'two files',
          files: ['https://webexapis.com/v1/contents/AAA/photo.png', 'https://webexapis.com/v1/contents/BBB/doc.pdf'],
        }),
      ],
      'bot-1',
    )

    expect(history[0]?.text).toBe(
      'two files\n[Webex attachment #1: file name=photo.png]\n[Webex attachment #2: file name=doc.pdf]',
    )
    expect(history[0]?.attachments?.map((a) => [a.id, a.ref])).toEqual([
      [1, 'https://webexapis.com/v1/contents/AAA/photo.png'],
      [2, 'https://webexapis.com/v1/contents/BBB/doc.pdf'],
    ])
  })

  test('leaves replyToBotMessageId null when the threaded parent was authored by a human', async () => {
    const parent = message({ id: 'parent-blob', ref: 'parent-1', personId: 'human-blob-1', personRef: 'human-1' })
    const child = message({
      id: 'child-blob',
      ref: 'child-1',
      personId: 'human-blob-2',
      personRef: 'human-2',
      parentId: 'parent-blob',
      parentRef: 'parent-1',
    })
    const history = await historyOf([parent, child], 'bot-1')
    expect(history.find((m) => m.externalMessageId === 'child-1')?.replyToBotMessageId).toBeNull()
  })

  test('attributes replyToBotMessageId when the threaded parent was authored by the bot', async () => {
    const parent = message({ id: 'parent-blob', ref: 'parent-1', personId: 'bot-blob', personRef: 'bot-1' })
    const child = message({
      id: 'child-blob',
      ref: 'child-1',
      personId: 'human-blob-2',
      personRef: 'human-2',
      parentId: 'parent-blob',
      parentRef: 'parent-1',
    })
    const history = await historyOf([parent, child], 'bot-1')
    expect(history.find((m) => m.externalMessageId === 'child-1')?.replyToBotMessageId).toBe('parent-1')
  })

  test('leaves replyToBotMessageId null when the threaded parent is outside the fetched batch', async () => {
    const child = message({
      id: 'child-blob',
      ref: 'child-1',
      personId: 'human-blob-2',
      personRef: 'human-2',
      parentId: 'parent-unknown-blob',
      parentRef: 'parent-unknown',
    })
    const history = await historyOf([child], 'bot-1')
    expect(history.find((m) => m.externalMessageId === 'child-1')?.replyToBotMessageId).toBeNull()
  })

  test('logs prefetch rate-limit skips at info with skipReason, not warn', async () => {
    const log = logger()
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => Promise.reject(Object.assign(new Error('HTTP 429'), { code: 'http_429' })),
      },
      logger: log,
      botPersonIdRef: () => 'bot-1',
    })

    const res = await cb({ chat: 'room-1', thread: null, limit: 50, prefetch: true })

    expect(res).toEqual({ ok: false, error: 'HTTP 429', skipReason: 'rate-limited' })
    expect(log.lines.some((l) => l.startsWith('info:') && l.includes('rate limited'))).toBe(true)
    expect(log.lines.some((l) => l.startsWith('warn:'))).toBe(false)
  })

  test('warns (no skipReason) on a 429 from an explicit non-prefetch read', async () => {
    const log = logger()
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => Promise.reject(Object.assign(new Error('HTTP 429'), { code: 'http_429' })),
      },
      logger: log,
      botPersonIdRef: () => 'bot-1',
    })

    const res = await cb({ chat: 'room-1', thread: null, limit: 50 })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.skipReason).toBeUndefined()
    expect(log.lines.some((l) => l.startsWith('warn:'))).toBe(true)
  })

  test('still logs non-rate-limit failures at warn', async () => {
    const log = logger()
    const cb = createWebexHistoryCallback({
      client: { listMessages: async () => Promise.reject(new Error('boom')) },
      logger: log,
      botPersonIdRef: () => 'bot-1',
    })

    const res = await cb({ chat: 'room-1', thread: null, limit: 50, prefetch: true })

    expect(res.ok).toBe(false)
    expect(log.lines.some((l) => l.startsWith('warn:') && l.includes('boom'))).toBe(true)
  })

  test('skips a same-room prefetch without calling listMessages when the limiter cannot admit', async () => {
    let calls = 0
    const blockUntil = Promise.withResolvers<void>()
    const limiter = createWebexPrefetchLimiter({ concurrency: 1, admitTimeoutMs: 20 })
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => {
          calls++
          await blockUntil.promise
          return [] as WebexMessage[]
        },
      },
      logger: logger(),
      botPersonIdRef: () => 'bot-1',
      limiter,
    })

    const held = cb({ chat: 'room-1', thread: null, limit: 50, prefetch: true })
    const skipped = await cb({ chat: 'room-1', thread: null, limit: 50, prefetch: true })

    expect(skipped).toEqual({
      ok: false,
      error: 'prefetch skipped: rate-limit backpressure',
      skipReason: 'rate-limited',
    })
    expect(calls).toBe(1)
    blockUntil.resolve()
    await held
    expect(calls).toBe(1)
  })

  test('an explicit (non-prefetch) read bypasses the limiter even under backpressure', async () => {
    let prefetchCalls = 0
    let explicitCalls = 0
    const blockPrefetch = Promise.withResolvers<void>()
    const limiter = createWebexPrefetchLimiter({ concurrency: 1, admitTimeoutMs: 20 })
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async (_chat, opts) => {
          // The prefetch caller over-requests by one; use the limit to tell the
          // two callers apart so blocking is independent of scheduling order.
          if ((opts?.max ?? 0) === 99) {
            prefetchCalls++
            await blockPrefetch.promise
          } else {
            explicitCalls++
          }
          return [] as WebexMessage[]
        },
      },
      logger: logger(),
      botPersonIdRef: () => 'bot-1',
      limiter,
    })

    const heldPrefetch = cb({ chat: 'room-1', thread: null, limit: 99, prefetch: true })
    const explicit = await cb({ chat: 'room-1', thread: null, limit: 50 })

    expect(explicit.ok).toBe(true)
    expect(explicitCalls).toBe(1)
    blockPrefetch.resolve()
    await heldPrefetch
    expect(prefetchCalls).toBe(1)
  })

  test('does not throttle prefetches for different rooms', async () => {
    let calls = 0
    const blockUntil = Promise.withResolvers<void>()
    const limiter = createWebexPrefetchLimiter({ concurrency: 1, admitTimeoutMs: 20 })
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => {
          calls++
          await blockUntil.promise
          return [] as WebexMessage[]
        },
      },
      logger: logger(),
      botPersonIdRef: () => 'bot-1',
      limiter,
    })

    const held = cb({ chat: 'room-1', thread: null, limit: 50, prefetch: true })
    const other = cb({ chat: 'room-2', thread: null, limit: 50, prefetch: true })

    blockUntil.resolve()
    const [a, b] = await Promise.all([held, other])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(calls).toBe(2)
  })
})

describe('createWebexAdapter createTypingCallback', () => {
  test('phase=tick raises the indicator via setTyping(room, true)', async () => {
    const calls: Array<{ room: string; typing?: boolean }> = []
    const cb = createTypingCallback({
      client: { setTyping: async (room, typing) => void calls.push({ room, typing }) },
      logger: logger(),
    })

    await cb({ adapter: 'webex', workspace: 'webex', chat: 'room-1', thread: null, phase: 'tick' })

    expect(calls).toEqual([{ room: 'room-1', typing: true }])
  })

  test('phase=stop clears the indicator via setTyping(room, false)', async () => {
    const calls: Array<{ room: string; typing?: boolean }> = []
    const cb = createTypingCallback({
      client: { setTyping: async (room, typing) => void calls.push({ room, typing }) },
      logger: logger(),
    })

    await cb({ adapter: 'webex', workspace: 'webex', chat: 'room-1', thread: null, phase: 'stop' })

    expect(calls).toEqual([{ room: 'room-1', typing: false }])
  })

  test('ignores targets for other adapters', async () => {
    let called = false
    const cb = createTypingCallback({
      client: {
        setTyping: async () => {
          called = true
        },
      },
      logger: logger(),
    })

    await cb({ adapter: 'slack-bot', workspace: 'slack', chat: 'C1', thread: null, phase: 'tick' })

    expect(called).toBe(false)
  })

  test('swallows setTyping failures and logs a warning rather than throwing', async () => {
    const log = logger()
    const cb = createTypingCallback({
      client: {
        setTyping: async () => {
          throw new Error('webex 429')
        },
      },
      logger: log,
    })

    await cb({ adapter: 'webex', workspace: 'webex', chat: 'room-1', thread: null, phase: 'tick' })

    expect(log.lines.some((l) => l.startsWith('warn:[webex] typing') && l.includes('webex 429'))).toBe(true)
  })

  test('serializes per-room so a slow tick still completes before the stop clear (false applied last)', async () => {
    // given: a held tick whose setTyping(true) only resolves after stop is fired
    const completed: boolean[] = []
    let releaseTick: (() => void) | undefined
    const tickGate = new Promise<void>((resolve) => {
      releaseTick = resolve
    })
    const cb = createTypingCallback({
      client: {
        setTyping: async (_room, typing) => {
          if (typing === true) await tickGate
          completed.push(typing === true)
        },
      },
      logger: logger(),
    })

    // when: tick fires (and stalls), then stop fires before the tick is released
    const tick = cb({ adapter: 'webex', workspace: 'webex', chat: 'room-1', thread: null, phase: 'tick' })
    const stop = cb({ adapter: 'webex', workspace: 'webex', chat: 'room-1', thread: null, phase: 'stop' })
    releaseTick?.()
    await Promise.all([tick, stop])

    // then: the FIFO ran true before false, so the clear is the last call on the wire
    expect(completed).toEqual([true, false])
  })

  test('does not serialize across distinct rooms', async () => {
    const order: string[] = []
    let releaseRoomA: (() => void) | undefined
    const gateA = new Promise<void>((resolve) => {
      releaseRoomA = resolve
    })
    const cb = createTypingCallback({
      client: {
        setTyping: async (room) => {
          if (room === 'room-A') await gateA
          order.push(room)
        },
      },
      logger: logger(),
    })

    const a = cb({ adapter: 'webex', workspace: 'webex', chat: 'room-A', thread: null, phase: 'tick' })
    const b = cb({ adapter: 'webex', workspace: 'webex', chat: 'room-B', thread: null, phase: 'tick' })
    await b
    releaseRoomA?.()
    await a

    // room-B is not blocked behind room-A's stalled call
    expect(order).toEqual(['room-B', 'room-A'])
  })
})
