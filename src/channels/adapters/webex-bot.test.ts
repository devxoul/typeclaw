import { describe, expect, test } from 'bun:test'

import type { WebexBotListener } from 'agent-messenger/webexbot'

import { MEMBERSHIP_ENUMERATION_CAP } from '@/channels/membership'
import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { OutboundMessage } from '@/channels/types'

import {
  createFetchAttachmentCallback,
  createOutboundCallback,
  createWebexBotAdapter,
  createWebexHistoryCallback,
  createWebexMembershipResolver,
  type WebexBotAdapterLogger,
} from './webex-bot'
import type { WebexInboundMessage } from './webex-bot-classify'
import { createWebexPrefetchLimiter } from './webex-prefetch-limiter'

const config = channelsSchema.parse({ 'webex-bot': {} })['webex-bot']!

function logger(): WebexBotAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

describe('webex outbound', () => {
  function outboundClient() {
    const sends: Array<{ roomId: string; text: string; markdown?: boolean; parentId?: string }> = []
    const uploads: Array<{ roomId: string; filename: string; text?: string; parentId?: string }> = []
    return {
      sends,
      uploads,
      client: {
        sendMessage: async (
          roomId: string,
          text: string,
          options?: { markdown?: boolean; parentId?: string; files?: string[] },
        ) => {
          sends.push({ roomId, text, markdown: options?.markdown, parentId: options?.parentId })
          return webexMessage({ id: 'sent-blob', ref: 'sent', text })
        },
        uploadFile: async (
          roomId: string,
          file: { content: Blob; filename: string },
          options?: { text?: string; markdown?: boolean; parentId?: string },
        ) => {
          uploads.push({ roomId, filename: file.filename, text: options?.text, parentId: options?.parentId })
          return webexMessage({ id: `up-${uploads.length}-blob`, ref: `up-${uploads.length}` })
        },
      },
    }
  }

  test('sends a plain-text message with no parentId for a non-threaded reply', async () => {
    const { sends, uploads, client } = outboundClient()
    const cb = createOutboundCallback({ client, logger: logger(), formatChannelTag: async () => 'room=Room(room-1)' })

    // given: Korean body to keep the path script-agnostic
    const result = await cb(outbound({ text: '**안녕하세요**' }))

    expect(result).toEqual({ ok: true, messageId: 'sent', messageIds: ['sent'] })
    // markdown is omitted so Webex's E2E path does not render verbatim HTML
    expect(sends).toEqual([{ roomId: 'room-1', text: '**안녕하세요**', markdown: undefined, parentId: undefined }])
    expect(uploads).toEqual([])
  })

  test('threads a text reply under msg.thread via parentId', async () => {
    const { sends, client } = outboundClient()
    const cb = createOutboundCallback({ client, logger: logger(), formatChannelTag: async () => 'room=room-1' })

    await cb(outbound({ text: 'hi', thread: 'root-1' }))

    expect(sends).toEqual([{ roomId: 'room-1', text: 'hi', markdown: undefined, parentId: 'root-1' }])
  })

  test('prefers replyTo over msg.thread for the parentId anchor', async () => {
    const { sends, client } = outboundClient()
    const cb = createOutboundCallback({ client, logger: logger(), formatChannelTag: async () => 'room=room-1' })

    await cb(outbound({ text: 'hi', thread: 'root-1', replyTo: { externalMessageId: 'msg-7' } }))

    expect(sends[0]?.parentId).toBe('msg-7')
  })

  test('uploads a text+file message in one call carrying text and parentId', async () => {
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

  test('uploads multiple files with text only on the first, parentId on all', async () => {
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

  test('uploads an attachment-only message with no text', async () => {
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

  test('honors an explicit attachment filename over the path basename', async () => {
    const { uploads, client } = outboundClient()
    const cb = createOutboundCallback({
      client,
      logger: logger(),
      formatChannelTag: async () => 'room=room-1',
      readFile: async () => ({ content: new Blob(['data']), filename: 'from-disk.bin' }),
    })

    await cb(outbound({ text: '', attachments: [{ path: '/tmp/a.txt', filename: 'report.pdf' }] }))

    expect(uploads[0]?.filename).toBe('report.pdf')
  })

  test('resolves attachment paths through resolvePath before reading', async () => {
    const read: string[] = []
    const cb = createOutboundCallback({
      client: outboundClient().client,
      logger: logger(),
      formatChannelTag: async () => 'room=room-1',
      resolvePath: (p) => p.replace('/agent/', '/host/mounts/agent/'),
      readFile: async (path) => {
        read.push(path)
        return { content: new Blob(['data']), filename: 'a.txt' }
      },
    })

    await cb(outbound({ text: '', attachments: [{ path: '/agent/a.txt' }] }))

    expect(read).toEqual(['/host/mounts/agent/a.txt'])
  })

  test('returns ok false when an upload fails', async () => {
    const cb = createOutboundCallback({
      client: {
        sendMessage: async () => webexMessage({ id: 'unused' }),
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

  test('rejects a message with neither text nor attachments', async () => {
    const cb = createOutboundCallback({
      client: outboundClient().client,
      logger: logger(),
      formatChannelTag: async () => 'room=room-1',
    })

    await expect(cb(outbound({ text: '' }))).resolves.toEqual({
      ok: false,
      error: 'message has neither text nor attachments',
    })
  })
})

describe('webex history and membership', () => {
  test('maps newest-first history to oldest-first', async () => {
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => [
          webexMessage({
            id: 'new-blob',
            ref: 'new',
            text: 'new',
            personId: 'user-2-blob',
            personRef: 'user-2',
            created: '2026-01-02T00:00:00Z',
          }),
          webexMessage({
            id: 'old-blob',
            ref: 'old',
            text: 'old',
            personId: 'bot-blob',
            personRef: 'bot-1',
            created: '2026-01-01T00:00:00Z',
          }),
        ],
      },
      logger: logger(),
      botPersonIdRef: () => 'bot-1',
    })

    const result = await cb({ chat: 'room-1', thread: null, limit: 10 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => [m.externalMessageId, m.text, m.isBot])).toEqual([
      ['old', 'old', true],
      ['new', 'new', false],
    ])
    expect(result.nextCursor).toBeUndefined()
  })

  test('numbers every history file so each is separately addressable', async () => {
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => [
          webexMessage({
            id: 'files-blob',
            ref: 'files',
            text: 'two files',
            files: ['https://webexapis.com/v1/contents/AAA/photo.png', 'https://webexapis.com/v1/contents/BBB/doc.pdf'],
          }),
        ],
      },
      logger: logger(),
      botPersonIdRef: () => 'bot-1',
    })

    const result = await cb({ chat: 'room-1', thread: null, limit: 10 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages[0]?.text).toBe(
      'two files\n[Webex attachment #1: file name=photo.png]\n[Webex attachment #2: file name=doc.pdf]',
    )
    expect(result.messages[0]?.attachments?.map((a) => [a.id, a.ref])).toEqual([
      [1, 'https://webexapis.com/v1/contents/AAA/photo.png'],
      [2, 'https://webexapis.com/v1/contents/BBB/doc.pdf'],
    ])
  })

  test('returns ok false on history failure', async () => {
    const cb = createWebexHistoryCallback({
      client: { listMessages: async () => Promise.reject(new Error('down')) },
      logger: logger(),
      botPersonIdRef: () => null,
    })

    await expect(cb({ chat: 'room-1', thread: null, limit: 10 })).resolves.toEqual({ ok: false, error: 'down' })
  })

  test('logs prefetch rate-limit skips at info with skipReason, not warn', async () => {
    const log = logger()
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => Promise.reject(Object.assign(new Error('Rate limited'), { code: 'rate_limited' })),
      },
      logger: log,
      botPersonIdRef: () => null,
    })

    const res = await cb({ chat: 'room-1', thread: null, limit: 10, prefetch: true })

    expect(res).toEqual({ ok: false, error: 'Rate limited', skipReason: 'rate-limited' })
    expect(log.lines.some((l) => l.startsWith('info:') && l.includes('rate limited'))).toBe(true)
    expect(log.lines.some((l) => l.startsWith('warn:'))).toBe(false)
  })

  test('warns (no skipReason) on a 429 from an explicit non-prefetch read', async () => {
    const log = logger()
    const cb = createWebexHistoryCallback({
      client: {
        listMessages: async () => Promise.reject(Object.assign(new Error('Rate limited'), { code: 'rate_limited' })),
      },
      logger: log,
      botPersonIdRef: () => null,
    })

    const res = await cb({ chat: 'room-1', thread: null, limit: 10 })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.skipReason).toBeUndefined()
    expect(log.lines.some((l) => l.startsWith('warn:'))).toBe(true)
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
          return []
        },
      },
      logger: logger(),
      botPersonIdRef: () => null,
      limiter,
    })

    const held = cb({ chat: 'room-1', thread: null, limit: 10, prefetch: true })
    const skipped = await cb({ chat: 'room-1', thread: null, limit: 10, prefetch: true })

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
          // Distinguish callers by limit (not call order) so the test is immune
          // to the limiter deferring its work by a microtask.
          if ((opts?.max ?? 0) === 99) {
            prefetchCalls++
            await blockPrefetch.promise
          } else {
            explicitCalls++
          }
          return []
        },
      },
      logger: logger(),
      botPersonIdRef: () => null,
      limiter,
    })

    const heldPrefetch = cb({ chat: 'room-1', thread: null, limit: 99, prefetch: true })
    const explicit = await cb({ chat: 'room-1', thread: null, limit: 10 })

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
          return []
        },
      },
      logger: logger(),
      botPersonIdRef: () => null,
      limiter,
    })

    const held = cb({ chat: 'room-1', thread: null, limit: 10, prefetch: true })
    const other = cb({ chat: 'room-2', thread: null, limit: 10, prefetch: true })

    blockUntil.resolve()
    const [a, b] = await Promise.all([held, other])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(calls).toBe(2)
  })

  test('resolves direct and group membership, falling back to history on failure', async () => {
    const history = createWebexHistoryCallback({
      client: {
        listMessages: async () => [
          webexMessage({ personId: 'user-1-blob', personRef: 'user-1' }),
          webexMessage({ personId: 'bot-blob', personRef: 'bot-1' }),
        ],
      },
      logger: logger(),
      botPersonIdRef: () => 'bot-1',
    })
    let fail = false
    const resolver = createWebexMembershipResolver({
      client: {
        listMemberships: async () => {
          if (fail) throw new Error('nope')
          return [membership('bot-1'), membership('user-1'), membership('user-2')]
        },
      },
      logger: logger(),
      historyCallback: history,
      botPersonIdRef: () => 'bot-1',
      now: () => 123,
    })

    await expect(resolver({ adapter: 'webex-bot', workspace: '@dm', chat: 'dm-1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 123,
      truncated: false,
    })
    await expect(
      resolver({ adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', thread: null }),
    ).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 123,
      truncated: false,
      humanMemberIds: ['user-1', 'user-2'],
    })
    fail = true
    await expect(
      resolver({ adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', thread: null }),
    ).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 123,
      truncated: true,
    })
  })

  test('marks membership truncated and omits humanMemberIds when the read hits the enumeration cap', async () => {
    const members = Array.from({ length: MEMBERSHIP_ENUMERATION_CAP }, (_, i) => membership(`user-${i}`))
    const resolver = createWebexMembershipResolver({
      client: { listMemberships: async () => members },
      logger: logger(),
      historyCallback: createWebexHistoryCallback({
        client: { listMessages: async () => [] },
        logger: logger(),
        botPersonIdRef: () => 'bot-1',
      }),
      botPersonIdRef: () => 'bot-1',
      now: () => 123,
    })

    await expect(
      resolver({ adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', thread: null }),
    ).resolves.toEqual({
      humans: MEMBERSHIP_ENUMERATION_CAP,
      bots: 0,
      fetchedAt: 123,
      truncated: true,
    })
  })
})

describe('webex fetch attachment', () => {
  test('downloads Webex content URLs with bearer auth', async () => {
    const calls: Array<{ url: string; auth?: string }> = []
    const cb = createFetchAttachmentCallback({
      token: 'token-1',
      logger: logger(),
      fetchImpl: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          calls.push({ url: String(input), auth: headers.get('authorization') ?? undefined })
          return new Response('file-body', { headers: { 'content-type': 'text/plain' } })
        },
        { preconnect: () => {} },
      ),
    })

    const result = await cb({ ref: 'https://cdn.webexcontent.com/files/a.txt' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('a.txt')
    expect(result.buffer.toString()).toBe('file-body')
    expect(calls).toEqual([{ url: 'https://cdn.webexcontent.com/files/a.txt', auth: 'Bearer token-1' }])
  })

  test('rejects non-Webex hosts', async () => {
    const cb = createFetchAttachmentCallback({ token: 'token-1', logger: logger() })

    await expect(cb({ ref: 'https://example.com/file.txt' })).resolves.toEqual({
      ok: false,
      error: 'not a Webex file URL: example.com',
    })
  })

  test('refuses http:// on allowlisted hosts without leaking the bearer token', async () => {
    // given: a fetch impl that records every call so we can assert none happened
    const calls: string[] = []
    const cb = createFetchAttachmentCallback({
      token: 'token-1',
      logger: logger(),
      fetchImpl: Object.assign(
        async (input: RequestInfo | URL) => {
          calls.push(String(input))
          return new Response('file-body')
        },
        { preconnect: () => {} },
      ),
    })

    // when: an allowlisted host is requested over plaintext http
    const apex = await cb({ ref: 'http://webexapis.com/file.txt' })
    const subdomain = await cb({ ref: 'http://cdn.webexcontent.com/files/a.txt' })

    // then: both are refused and the credentialed fetch is never issued
    expect(apex).toEqual({ ok: false, error: 'Webex file URL must use https: http://webexapis.com' })
    expect(subdomain).toEqual({ ok: false, error: 'Webex file URL must use https: http://cdn.webexcontent.com' })
    expect(calls).toEqual([])
  })
})

describe('webex lifecycle', () => {
  test('starts, registers callbacks, routes messages, and stops cleanly', async () => {
    const listener = new FakeListener()
    const router = new FakeRouter()
    const adapter = createWebexBotAdapter({
      router: router.value,
      configRef: () => config,
      token: 'token-1',
      logger: logger(),
      createClient: () => fakeClient(),
      createListener: () => listener.value,
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    expect(router.registered).toEqual([
      'outbound',
      'channelNameResolver',
      'selfIdentity',
      'history',
      'fetchAttachment',
      'membership',
      'editMessage',
    ])
    expect(router.selfIdentity?.('@dm')).toEqual({ id: 'bot-ref-1', username: 'bot@example.com' })

    listener.emit('message_created', inbound({ mentionedPeople: ['bot-blob'], mentionedPeopleRefs: ['bot-ref-1'] }))
    await router.waitForRoutes(1)
    expect(router.routes[0]?.externalMessageId).toBe('msg-1')

    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
    expect(router.unregistered).toEqual(router.registered)
  })

  test('auth log prints the bot person ref', async () => {
    const personId = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9iMjc4ODgyZS1iMjhiLTRjYzQtYjA4Yi00YjA4ZGI3MzY5ZGI'
    const log = logger()
    const adapter = createWebexBotAdapter({
      router: new FakeRouter().value,
      configRef: () => config,
      token: 'token-1',
      logger: log,
      createClient: () =>
        ({
          ...fakeClient(),
          testAuth: async () => ({
            id: personId,
            ref: 'b278882e-b28b-4cc4-b08b-4b08db7369db',
            emails: ['typeey@example.com'],
            displayName: 'Typeey',
            orgId: 'org-1',
            type: 'bot',
            created: '',
          }),
        }) as ReturnType<typeof fakeClient>,
      createListener: () => new FakeListener().value,
    })

    await adapter.start()

    expect(log.lines).toContain('info:[webex-bot] authenticated as Typeey (b278882e-b28b-4cc4-b08b-4b08db7369db)')
  })

  test('rolls back registrations when listener start fails', async () => {
    const listener = new FakeListener({ failStart: true })
    const router = new FakeRouter()
    const adapter = createWebexBotAdapter({
      router: router.value,
      configRef: () => config,
      token: 'token-1',
      logger: logger(),
      createClient: () => fakeClient(),
      createListener: () => listener.value,
    })

    await expect(adapter.start()).rejects.toThrow('start failed')
    expect(router.unregistered).toEqual(router.registered)
    expect(adapter.isConnected()).toBe(false)
  })

  test('stop before connected is a no-op', async () => {
    const adapter = createWebexBotAdapter({
      router: new FakeRouter().value,
      configRef: () => config,
      token: 'token-1',
      logger: logger(),
      createClient: () => fakeClient(),
      createListener: () => new FakeListener().value,
    })

    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
  })
})

class FakeListener {
  private handlers = new Map<string, Array<(arg: unknown) => void>>()
  readonly value = this as unknown as WebexBotListener

  constructor(private readonly options: { failStart?: boolean } = {}) {}

  on(event: string, listener: (arg: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }

  off(): this {
    return this
  }

  once(event: string, listener: (arg: unknown) => void): this {
    return this.on(event, listener)
  }

  async start(): Promise<void> {
    if (this.options.failStart) throw new Error('start failed')
    this.emit('connected', { connected: true, status: 'connected' })
  }

  async stop(): Promise<void> {}

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }
}

class FakeRouter {
  readonly registered: string[] = []
  readonly unregistered: string[] = []
  readonly routes: Array<{ externalMessageId: string }> = []
  selfIdentity: ((workspace: string) => { id: string; username?: string } | null) | null = null
  private waiters: Array<() => void> = []
  readonly value = {
    route: async (msg: { externalMessageId: string }) => {
      this.routes.push(msg)
      const waiters = this.waiters
      this.waiters = []
      for (const waiter of waiters) waiter()
      return { kind: 'accepted' as const, inputId: msg.externalMessageId, generation: 0 }
    },
    registerOutbound: () => this.registered.push('outbound'),
    unregisterOutbound: () => this.unregistered.push('outbound'),
    registerChannelNameResolver: () => this.registered.push('channelNameResolver'),
    unregisterChannelNameResolver: () => this.unregistered.push('channelNameResolver'),
    registerSelfIdentity: (_adapter: string, cb: (workspace: string) => { id: string; username?: string } | null) => {
      this.selfIdentity = cb
      this.registered.push('selfIdentity')
    },
    unregisterSelfIdentity: () => this.unregistered.push('selfIdentity'),
    registerHistory: () => this.registered.push('history'),
    unregisterHistory: () => this.unregistered.push('history'),
    registerFetchAttachment: () => this.registered.push('fetchAttachment'),
    unregisterFetchAttachment: () => this.unregistered.push('fetchAttachment'),
    registerMembership: () => this.registered.push('membership'),
    unregisterMembership: () => this.unregistered.push('membership'),
    registerEditMessage: () => this.registered.push('editMessage'),
    unregisterEditMessage: () => this.unregistered.push('editMessage'),
  } as unknown as ChannelRouter

  async waitForRoutes(count: number): Promise<void> {
    if (this.routes.length >= count) return
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
}

function fakeClient() {
  return {
    login: async () => fakeClient(),
    getToken: () => 'token-1',
    testAuth: async () => ({
      id: 'bot-1',
      ref: 'bot-ref-1',
      emails: ['bot@example.com'],
      displayName: 'Bot',
      orgId: 'org-1',
      type: 'bot',
      created: '',
    }),
    sendMessage: async () => webexMessage({ id: 'sent-blob', ref: 'sent' }),
    getSpace: async () => ({
      id: 'room-blob-1',
      ref: 'room-1',
      title: 'Room',
      type: 'group',
      isLocked: false,
      lastActivity: '',
      created: '',
      creatorId: '',
    }),
    listMessages: async () => [],
    listMemberships: async () => [],
    getMessage: async () => webexMessage({ id: 'parent-blob', ref: 'parent', text: 'parent' }),
  } as unknown as ReturnType<NonNullable<Parameters<typeof createWebexBotAdapter>[0]['createClient']>>
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return { adapter: 'webex-bot', workspace: 'room-1', chat: 'room-1', text: 'hello', ...overrides }
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
    text: 'hello',
    created: '2026-01-01T00:00:00Z',
    roomType: 'group',
    mentionedPeople: [],
    mentionedPeopleRefs: [],
    mentionedGroups: [],
    files: [],
    raw: {} as WebexInboundMessage['raw'],
    ...overrides,
  }
}

function webexMessage(overrides: Partial<ReturnType<typeof webexMessageShape>> = {}) {
  return { ...webexMessageShape(), ...overrides }
}

function webexMessageShape() {
  return {
    id: 'msg-1',
    ref: 'msg-1',
    roomId: 'room-1',
    roomRef: 'room-1',
    roomType: 'group' as const,
    text: 'hello',
    personId: 'user-1',
    personRef: 'user-1',
    personEmail: 'user@example.com',
    created: '2026-01-01T00:00:00Z',
    files: [] as string[],
  }
}

function membership(personId: string) {
  return {
    id: `m-${personId}`,
    ref: `m-${personId}`,
    roomId: 'room-1',
    roomRef: 'room-1',
    personId,
    personRef: personId,
    personEmail: `${personId}@example.com`,
    personDisplayName: personId,
    isModerator: false,
    created: '',
  }
}
