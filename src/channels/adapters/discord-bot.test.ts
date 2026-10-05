import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  DiscordBotClient,
  DiscordBotListener,
  DiscordGatewayMessageCreateEvent,
  DiscordMessage,
} from 'agent-messenger/discordbot'
import { DiscordIntent } from 'agent-messenger/discordbot'

import type { ChannelRouter } from '@/channels/router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { FetchHistoryResult, HistoryCallback, InboundMessage, OutboundMessage } from '@/channels/types'
import type { ChannelKey } from '@/channels/types'

import {
  createDiscordBotAdapter,
  createDiscordHistoryCallback,
  createDiscordListCallback,
  createDiscordMembershipResolver,
  createDiscordMessageGetCallback,
  createInteractionHandler,
  createOutboundCallback,
  createTypingCallback,
  DISCORD_BOT_INTENTS,
  DISCORD_HISTORY_LIMIT_MAX,
  DISCORD_SLASH_COMMAND_NAMES,
} from './discord-bot'
import { encodeDiscordReactionRef } from './discord-bot-reactions'
import { DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT } from './discord-bot-slash-commands'

const provenanceConfig: ChannelAdapterConfig = {
  enabled: true,
  engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: 'off' },
  history: defaultHistoryConfig(),
}

describe('discord-bot gateway intents', () => {
  test('includes MessageContent (privileged) so inbound messages carry text', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.MessageContent).toBe(DiscordIntent.MessageContent)
  })

  test('includes DirectMessages so DMs are delivered to the gateway', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.DirectMessages).toBe(DiscordIntent.DirectMessages)
  })

  test('includes GuildMessages so guild channel messages are delivered', () => {
    expect(DISCORD_BOT_INTENTS & DiscordIntent.GuildMessages).toBe(DiscordIntent.GuildMessages)
  })
})

describe('discord-bot lifecycle', () => {
  test('reports live gateway state while retaining bot identity across reconnects', async () => {
    const listener = new FakeDiscordBotListener()
    const router = new FakeDiscordBotRouter()
    const adapter = createDiscordBotAdapter({
      router: router.value,
      configRef: () => lifecycleConfig(),
      token: 'token-1',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      createClient: () => fakeDiscordBotClient(),
      createListener: () => listener.value,
    })

    expect(adapter.isConnected()).toBe(false)
    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    expect(router.selfIdentity?.('@dm')).toEqual({ id: 'bot-1' })

    listener.emit('disconnected', 'transport closed')
    expect(adapter.isConnected()).toBe(false)
    expect(router.selfIdentity?.('@dm')).toEqual({ id: 'bot-1' })

    listener.emit('connected', connectedInfo())
    expect(adapter.isConnected()).toBe(true)

    listener.emit('error', new Error('temporary gateway transport error'))
    expect(adapter.isConnected()).toBe(true)

    listener.emit('error', new Error('Discord gateway closed with non-recoverable code 4004'))
    expect(adapter.isConnected()).toBe(false)
    expect(router.selfIdentity?.('@dm')).toEqual({ id: 'bot-1' })

    listener.emit('connected', connectedInfo())
    expect(adapter.isConnected()).toBe(true)

    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
    expect(listener.stopped).toBe(true)
    expect(router.unregistered).toEqual(router.registered)
  })

  test('logs the nested reason of a gateway ErrorEvent, never [object ErrorEvent]', async () => {
    // given: a ws 'error' fires with an ErrorEvent, which is not an Error
    const errors: string[] = []
    const listener = new FakeDiscordBotListener()
    const router = new FakeDiscordBotRouter()
    const adapter = createDiscordBotAdapter({
      router: router.value,
      configRef: () => lifecycleConfig(),
      token: 'token-1',
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      createClient: () => fakeDiscordBotClient(),
      createListener: () => listener.value,
    })
    await adapter.start()

    // when
    const errorEvent = {
      [Symbol.toStringTag]: 'ErrorEvent',
      type: 'error',
      error: new Error('Unexpected server response: 401'),
    }
    expect(String(errorEvent)).toBe('[object ErrorEvent]')
    listener.emit('error', errorEvent)

    // then
    const logged = errors.find((m) => m.startsWith('[discord-bot] gateway error:'))
    expect(logged).toBe('[discord-bot] gateway error: Unexpected server response: 401')
    expect(logged).not.toContain('[object ErrorEvent]')

    await adapter.stop()
  })

  test('logs the nested reason when listener startup fails with an ErrorEvent', async () => {
    // given: the outage shape, surfaced through the start-failure rollback path
    const errors: string[] = []
    const errorEvent = {
      [Symbol.toStringTag]: 'ErrorEvent',
      type: 'error',
      error: new Error('WebSocket closed: 1006 abnormal closure'),
    }
    const listener = new FakeDiscordBotListener({ failStart: errorEvent })
    const router = new FakeDiscordBotRouter()
    const adapter = createDiscordBotAdapter({
      router: router.value,
      configRef: () => lifecycleConfig(),
      token: 'token-1',
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      createClient: () => fakeDiscordBotClient(),
      createListener: () => listener.value,
    })

    // when
    await expect(adapter.start()).rejects.toBe(errorEvent)

    // then
    const logged = errors.find((m) => m.startsWith('[discord-bot] listener start failed:'))
    expect(logged).toBe('[discord-bot] listener start failed: WebSocket closed: 1006 abnormal closure')
    expect(logged).not.toContain('[object ErrorEvent]')
  })

  test('remains disconnected when listener startup fails', async () => {
    const listener = new FakeDiscordBotListener({ failStart: true })
    const router = new FakeDiscordBotRouter()
    const adapter = createDiscordBotAdapter({
      router: router.value,
      configRef: () => lifecycleConfig(),
      token: 'token-1',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      createClient: () => fakeDiscordBotClient(),
      createListener: () => listener.value,
    })

    await expect(adapter.start()).rejects.toThrow('start failed')
    expect(adapter.isConnected()).toBe(false)
    expect(router.unregistered).toEqual(router.registered)
  })
})

describe('discord-bot provenance enrichment', () => {
  test('startup resolves workspace and thread parent names for historical fragments', async () => {
    const listener = fakeBotListener()
    const logs: string[] = []
    const resolved: unknown[] = []
    const adapter = createDiscordBotAdapter({
      agentDir: '/agent',
      router: noopRouter(),
      configRef: () => provenanceConfig,
      token: 'test-token',
      logger: {
        info: (message) => logs.push(`info:${message}`),
        warn: (message) => logs.push(`warn:${message}`),
        error: (message) => logs.push(`error:${message}`),
      },
      createClient: () => ({ login: async () => {} }) as unknown as DiscordBotClient,
      createListener: () => listener as unknown as DiscordBotListener,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/channels/301')) {
          return Response.json({ id: '301', name: 'release-thread', type: 11, parent_id: '302' })
        }
        if (url.endsWith('/channels/302')) return Response.json({ id: '302', name: 'development', type: 0 })
        if (url.endsWith('/guilds/201')) return Response.json({ id: '201', name: 'Example Guild' })
        return new Response(null, { status: 404 })
      }) as typeof fetch,
      enrichHistoricalProvenance: async (agentDir, resolve, options) => {
        expect(agentDir).toBe('/agent')
        expect(options.adapter).toBe('discord-bot')
        resolved.push(await resolve({ adapter: 'discord-bot', workspace: '201', chat: '301', thread: null }))
        return { scanned: 1, attempted: 1, resolved: 1, failed: 0, timedOut: 0, changed: true }
      },
    })

    await adapter.start()
    await Bun.sleep(0)

    expect(resolved).toEqual([
      {
        where: {
          adapter: 'discord-bot',
          workspace: '201',
          workspaceName: 'Example Guild',
          chat: '301',
          chatName: 'release-thread',
          thread: null,
          parentChat: '302',
          parentChatName: 'development',
        },
        parentChecked: true,
      },
    ])
    expect(logs).toContain(
      'info:[discord-bot] historical provenance enrichment scanned=1 attempted=1 resolved=1 failed=0 timed_out=0 changed=true',
    )
  })

  test('historical enrichment failure never fails adapter startup', async () => {
    const listener = fakeBotListener()
    const warns: string[] = []
    const adapter = createDiscordBotAdapter({
      agentDir: '/agent',
      router: noopRouter(),
      configRef: () => provenanceConfig,
      token: 'test-token',
      logger: { info: () => {}, warn: (message) => warns.push(message), error: () => {} },
      createClient: () => ({ login: async () => {} }) as unknown as DiscordBotClient,
      createListener: () => listener as unknown as DiscordBotListener,
      enrichHistoricalProvenance: async () => {
        throw new Error('maintenance unavailable')
      },
    })

    await expect(adapter.start()).resolves.toBeUndefined()
    await Bun.sleep(0)
    expect(warns).toContain('[discord-bot] historical provenance enrichment failed: maintenance unavailable')
  })

  test('live thread capture includes parent id and parent name before routing', async () => {
    const listener = fakeBotListener()
    const routed: InboundMessage[] = []
    const adapter = createDiscordBotAdapter({
      router: noopRouter((message) => routed.push(message)),
      configRef: () => provenanceConfig,
      token: 'test-token',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createClient: () => ({ login: async () => {} }) as unknown as DiscordBotClient,
      createListener: () => listener as unknown as DiscordBotListener,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/channels/301')) {
          return Response.json({ id: '301', name: 'release-thread', type: 11, parent_id: '302' })
        }
        if (url.endsWith('/channels/302')) return Response.json({ id: '302', name: 'development', type: 0 })
        if (url.endsWith('/guilds/201')) return Response.json({ id: '201', name: 'Example Guild' })
        return new Response(null, { status: 204 })
      }) as typeof fetch,
    })
    await adapter.start()
    listener.emit('connected', { user: { id: '999', username: 'typeclaw' } })
    listener.emit('message_create', {
      type: 'MESSAGE_CREATE',
      id: '401',
      channel_id: '301',
      guild_id: '201',
      author: { id: '501', username: 'alice', bot: false },
      content: 'thread message',
      timestamp: '2026-01-01T00:00:00.000Z',
    } satisfies DiscordGatewayMessageCreateEvent)
    await adapter.stop()

    expect(routed[0]?.room).toEqual({ kind: 'thread', parentChat: '302', parentChatName: 'development' })
  })
})

function noopRouter(route?: (message: InboundMessage) => void): ChannelRouter {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'route'
          ? async (message: InboundMessage) => {
              route?.(message)
            }
          : () => {},
    },
  ) as ChannelRouter
}

function fakeBotListener(): {
  on(event: string, handler: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
  start(): Promise<void>
  stop(): void
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    emit: (event, ...args) => handlers.get(event)?.forEach((handler) => handler(...args)),
    start: async () => {},
    stop: () => {},
  }
}
describe('createTypingCallback', () => {
  let originalFetch: typeof fetch
  let calls: Array<{ url: string; init: RequestInit }>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('POSTs to /channels/{chat}/typing with bot token authorization', async () => {
    const cb = createTypingCallback({
      token: 'tok-abc',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, phase: 'tick' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/c1/typing')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot tok-abc')
  })

  test('uses thread id as the channel id when thread is set', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 'thr-9', phase: 'tick' })
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/thr-9/typing')
  })

  test('non-OK responses are logged but do not throw', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 429 })) as unknown as typeof fetch
    const warns: string[] = []
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, phase: 'tick' })
    expect(warns.some((m) => m.includes('429'))).toBe(true)
  })

  test('fetch rejection is swallowed and logged', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const warns: string[] = []
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, phase: 'tick' })
    expect(warns.some((m) => m.includes('network down'))).toBe(true)
  })

  test('rejects non-discord adapter without calling fetch', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null, phase: 'tick' })
    expect(calls).toHaveLength(0)
  })

  test('phase=stop is a no-op (Discord typing auto-expires; extra POST would re-arm it)', async () => {
    const cb = createTypingCallback({
      token: 'tok',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await cb({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, phase: 'stop' })
    expect(calls).toHaveLength(0)
  })
})

describe('createDiscordMembershipResolver', () => {
  type FetchCall = { url: string; init: RequestInit }
  type HistoryCall = { chat: string; thread: string | null; limit: number }

  function fakeFetch(responses: Response[]): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return responses.shift() ?? new Response(null, { status: 500 })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
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

  test('DM short-circuits without hitting Discord or history', async () => {
    const { fn, calls } = fakeFetch([])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 42,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: '@dm', chat: 'd1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 42,
      truncated: false,
    })
    expect(calls).toHaveLength(0)
  })

  // A fully public channel: @everyone can VIEW_CHANNEL (no deny overwrite),
  // so the channel-scoped count equals the guild count. Members carry no roles
  // beyond @everyone; the guild's @everyone role grants VIEW_CHANNEL (0x400).
  function publicChannelGuild(): { channel: unknown; guild: unknown } {
    return {
      channel: { type: 0, permission_overwrites: [] },
      guild: { owner_id: 'owner', roles: [{ id: 'g1', permissions: String(0x400) }] },
    }
  }

  test('small guild enumerates members for an exact bot/human split (public channel)', async () => {
    const { fn, calls } = fakeFetch([
      jsonResponse({ approximate_member_count: 3 }),
      jsonResponse([{ user: { id: 'u1' } }, { user: { id: 'b1', bot: true } }, { user: { id: 'u2', bot: false } }]),
      jsonResponse(publicChannelGuild().channel),
      jsonResponse(publicChannelGuild().guild),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
      humanMemberIds: ['u1', 'u2'],
    })
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/guilds/g1/preview')
    expect(calls[1]!.url).toBe('https://discord.com/api/v10/guilds/g1/members?limit=100')
    const scopedUrls = calls.slice(2).map((c) => c.url)
    expect(scopedUrls).toContain('https://discord.com/api/v10/channels/c1')
    expect(scopedUrls).toContain('https://discord.com/api/v10/guilds/g1')
  })

  test('scopes visibility to key.thread when set, not the parent key.chat', async () => {
    // given a forward-compatible key shape (chat = parent, thread = thread id);
    // visibility must be evaluated against the thread channel, not the parent.
    const { fn, calls } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([
        { user: { id: 'u1', bot: false }, roles: [] },
        { user: { id: 'b1', bot: true }, roles: [] },
      ]),
      jsonResponse(publicChannelGuild().channel),
      jsonResponse(publicChannelGuild().guild),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    // when the inbound is anchored at a thread
    await expect(
      resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'parent-c1', thread: 'thread-t9' }),
    ).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
      humanMemberIds: ['u1'],
    })

    // then the channel object fetched is the thread, not the parent
    const scopedUrls = calls.slice(2).map((c) => c.url)
    expect(scopedUrls).toContain('https://discord.com/api/v10/channels/thread-t9')
    expect(scopedUrls).not.toContain('https://discord.com/api/v10/channels/parent-c1')
  })

  test('private channel: @everyone denied VIEW_CHANNEL, only the agent bot allowed → bots:1, humans:1', async () => {
    // given: the exact production shape — guild has 1 human (owner) + 3 bots,
    // but #typeey denies @everyone VIEW_CHANNEL (0x400) and allows only the
    // agent's own bot. The owner (human) bypasses overwrites; the two peer
    // bots have no allow overwrite, so they are not channel-visible.
    const VIEW = 0x400
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 4 }),
      jsonResponse([
        { user: { id: 'owner', bot: false }, roles: [] },
        { user: { id: 'peerbotA', bot: true }, roles: [] },
        { user: { id: 'agentbot', bot: true }, roles: [] },
        { user: { id: 'peerbotB', bot: true }, roles: [] },
      ]),
      jsonResponse({
        type: 0,
        permission_overwrites: [
          { id: 'g1', type: 0, allow: '0', deny: String(VIEW) },
          { id: 'agentbot', type: 1, allow: String(VIEW), deny: '0' },
        ],
      }),
      jsonResponse({ owner_id: 'owner', roles: [{ id: 'g1', permissions: '0' }] }),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    // then: only owner (human) + agentbot (bot) are visible → the single-human
    // grant_role relaxation can fire.
    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
      humanMemberIds: ['owner'],
    })
  })

  test('ADMINISTRATOR role bypasses a channel deny overwrite', async () => {
    const VIEW = 0x400
    const ADMIN = 0x8
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([
        { user: { id: 'admin', bot: false }, roles: ['adminRole'] },
        { user: { id: 'agentbot', bot: true }, roles: [] },
      ]),
      jsonResponse({
        type: 0,
        permission_overwrites: [
          { id: 'g1', type: 0, allow: '0', deny: String(VIEW) },
          { id: 'agentbot', type: 1, allow: String(VIEW), deny: '0' },
        ],
      }),
      jsonResponse({
        owner_id: 'someone-else',
        roles: [
          { id: 'g1', permissions: '0' },
          { id: 'adminRole', permissions: String(ADMIN) },
        ],
      }),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
      humanMemberIds: ['admin'],
    })
  })

  test('a member referencing an unknown role fails closed to history fallback', async () => {
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([{ user: { id: 'u1', bot: false }, roles: ['ghostRole'] }]),
      jsonResponse({ type: 0, permission_overwrites: [] }),
      jsonResponse({ owner_id: 'owner', roles: [{ id: 'g1', permissions: String(0x400) }] }),
    ])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 0,
      bots: 0,
      fetchedAt: 100,
      truncated: true,
    })
    expect(historyCalls).toHaveLength(1)
  })

  test('a thread channel fails closed to history fallback (visibility not modelled)', async () => {
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 3 }),
      jsonResponse([{ user: { id: 'u1', bot: false }, roles: [] }]),
      jsonResponse({ type: 11, permission_overwrites: [] }),
      jsonResponse({ owner_id: 'owner', roles: [{ id: 'g1', permissions: String(0x400) }] }),
    ])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 0,
      bots: 0,
      fetchedAt: 100,
      truncated: true,
    })
    expect(historyCalls).toHaveLength(1)
  })

  test('channel fetch failure fails closed to history fallback', async () => {
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([{ user: { id: 'u1', bot: false }, roles: [] }]),
      new Response(null, { status: 403 }),
      jsonResponse({ owner_id: 'owner', roles: [{ id: 'g1', permissions: String(0x400) }] }),
    ])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 0,
      bots: 0,
      fetchedAt: 100,
      truncated: true,
    })
    expect(historyCalls).toHaveLength(1)
  })

  test('an unidentifiable visible human drops humanMemberIds (counts-only)', async () => {
    const { fn } = fakeFetch([
      jsonResponse({ approximate_member_count: 2 }),
      jsonResponse([
        { user: { bot: false }, roles: [] },
        { user: { id: 'b1', bot: true }, roles: [] },
      ]),
      jsonResponse(publicChannelGuild().channel),
      jsonResponse(publicChannelGuild().guild),
    ])
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: emptyHistory(),
      fetchImpl: fn,
      now: () => 100,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 100,
      truncated: false,
    })
  })

  test('large guild (>cap) falls back to history-derived count', async () => {
    const { fn, calls } = fakeFetch([jsonResponse({ approximate_member_count: 75 })])
    const { cb, calls: historyCalls } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'alice',
          authorName: 'alice',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'bob',
          authorName: 'bob',
          text: 'hey',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '3',
          authorId: 'b1',
          authorName: 'b1',
          text: 'beep',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 200,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 200,
      truncated: true,
    })
    expect(calls).toHaveLength(1)
    expect(historyCalls).toEqual([{ chat: 'c1', thread: null, limit: 100 }])
  })

  test('403 from member fetch falls back to history-derived count', async () => {
    const { fn } = fakeFetch([jsonResponse({ approximate_member_count: 10 }), new Response(null, { status: 403 })])
    const { cb } = fakeHistory({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: 'alice',
          authorName: 'alice',
          text: 'hi',
          ts: 0,
          isBot: false,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '2',
          authorId: 'toto',
          authorName: 'toto',
          text: 'hey',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
        {
          externalMessageId: '3',
          authorId: 'penpen',
          authorName: 'penpen',
          text: 'oi',
          ts: 0,
          isBot: true,
          replyToBotMessageId: null,
        },
      ],
    })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 300,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      humans: 1,
      bots: 2,
      fetchedAt: 300,
      truncated: true,
    })
  })

  test('403 from member fetch + history failure surfaces a transient (cache retries soon)', async () => {
    const { fn } = fakeFetch([jsonResponse({ approximate_member_count: 10 }), new Response(null, { status: 403 })])
    const { cb } = fakeHistory({ ok: false, error: 'rate-limited' })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 0,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      kind: 'transient',
    })
  })

  test('non-403 member-fetch failure propagates without falling back to history', async () => {
    const { fn } = fakeFetch([jsonResponse({ approximate_member_count: 10 }), new Response(null, { status: 500 })])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
      now: () => 0,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      kind: 'transient',
    })
    expect(historyCalls).toHaveLength(0)
  })

  test('403 from guild preview is a permanent resolver failure (no fallback)', async () => {
    const { fn } = fakeFetch([new Response(null, { status: 403 })])
    const { cb, calls: historyCalls } = fakeHistory({ ok: true, messages: [] })
    const resolver = createDiscordMembershipResolver({
      token: 'tok',
      logger: silentLogger(),
      historyCallback: cb,
      fetchImpl: fn,
    })

    await expect(resolver({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })).resolves.toEqual({
      kind: 'permanent',
    })
    expect(historyCalls).toHaveLength(0)
  })
})

describe('createDiscordHistoryCallback', () => {
  type FetchCall = { url: string; init: RequestInit }

  function fakeFetch(jsonOrStatus: unknown[] | { status: number }): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      if (Array.isArray(jsonOrStatus)) {
        return new Response(JSON.stringify(jsonOrStatus), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(null, { status: jsonOrStatus.status })
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

  test('GETs /channels/{chat}/messages with bot token authorization', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'bot-tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'channel-id', thread: null, limit: 10 })
    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.url.startsWith('https://discord.com/api/v10/channels/channel-id/messages?')).toBe(true)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bot bot-tok')
    const params = new URL(calls[0]!.url).searchParams
    expect(params.get('limit')).toBe('10')
    expect(params.get('before')).toBeNull()
  })

  test('uses args.thread as the channel id when set, falling back to args.chat otherwise', async () => {
    // given (matches the inbound classifier convention: chat = thread channel id, thread = null)
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'thread-channel-id', thread: null, limit: 10 })
    // then
    expect(calls[0]!.url.startsWith('https://discord.com/api/v10/channels/thread-channel-id/messages?')).toBe(true)

    // and given (forward-compatible: a future caller passes a non-null thread)
    const { fn: fn2, calls: calls2 } = fakeFetch([])
    const cb2 = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn2,
    })
    // when
    await cb2({ chat: 'parent-channel-id', thread: 'thread-id', limit: 10 })
    // then
    expect(calls2[0]!.url.startsWith('https://discord.com/api/v10/channels/thread-id/messages?')).toBe(true)
  })

  test('reverses Discord newest-first ordering into oldest-first', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '3',
        channel_id: 'c1',
        author: { id: 'u3', username: 'C', bot: false },
        content: 'newest',
        timestamp: '2026-04-27T00:00:03Z',
      },
      {
        id: '2',
        channel_id: 'c1',
        author: { id: 'u2', username: 'B', bot: false },
        content: 'middle',
        timestamp: '2026-04-27T00:00:02Z',
      },
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'A', bot: false },
        content: 'oldest',
        timestamp: '2026-04-27T00:00:01Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages.map((m) => m.text)).toEqual(['oldest', 'middle', 'newest'])
  })

  test('maps attachments on history messages into attachments and bakes placeholders into text', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'A', bot: false },
        content: 'what is this?',
        timestamp: '2026-04-27T00:00:01Z',
        attachments: [{ url: 'https://cdn.example/photo.png', filename: 'photo.png', content_type: 'image/png' }],
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'https://cdn.example/photo.png', filename: 'photo.png', mimetype: 'image/png' },
    ])
    expect(msg.text).toBe('what is this?\n[Discord attachment #1: file image/png name=photo.png]')
  })

  test('omits attachments and leaves text untouched when a history message has no media', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'A', bot: false },
        content: 'plain text',
        timestamp: '2026-04-27T00:00:01Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.attachments).toBeUndefined()
    expect(msg.text).toBe('plain text')
  })

  test('renders media-only history message (no text) as placeholder-only text and numbers across media kinds', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'A', bot: false },
        content: '',
        timestamp: '2026-04-27T00:00:01Z',
        attachments: [{ url: 'https://cdn.example/a.jpg', filename: 'a.jpg', content_type: 'image/jpeg' }],
        sticker_items: [{ id: 's1', name: 'wave', format_type: 1 }],
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe(
      '[Discord attachment #1: file image/jpeg name=a.jpg]\n[Discord attachment #2: sticker name=wave]',
    )
    expect(msg.attachments).toHaveLength(2)
    expect(msg.attachments!.map((a) => a.id)).toEqual([1, 2])
  })

  test('resolves a thread-starter (empty body + referenced_message) to the opener author and text', async () => {
    // given: Discord returns the type-21 starter with empty content/bot author;
    // the real opener lives only in referenced_message
    const { fn } = fakeFetch([
      {
        id: 'starter-1',
        channel_id: 'thread-t1',
        type: 21,
        author: { id: 'system-bot', username: 'Discord', bot: true },
        content: '',
        timestamp: '2026-04-27T00:00:01Z',
        message_reference: { message_id: 'opener-1', channel_id: 'parent-c1' },
        referenced_message: {
          id: 'opener-1',
          channel_id: 'parent-c1',
          author: { id: 'u-human', username: 'alice', global_name: 'Alice', bot: false },
          content: 'the question that started the thread',
          timestamp: '2026-04-26T23:59:00Z',
        },
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'thread-t1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe('the question that started the thread')
    expect(msg.authorId).toBe('u-human')
    expect(msg.authorName).toBe('Alice')
    expect(msg.isBot).toBe(false)
    // keeps the starter's own id/ts so dedup and ordering stay correct
    expect(msg.externalMessageId).toBe('starter-1')
    expect(msg.ts).toBe(Date.parse('2026-04-27T00:00:01Z'))
  })

  test('carries the opener attachments when a thread-starter opener has media but no text', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: 'starter-1',
        channel_id: 'thread-t1',
        type: 21,
        author: { id: 'system-bot', username: 'Discord', bot: true },
        content: '',
        timestamp: '2026-04-27T00:00:01Z',
        message_reference: { message_id: 'opener-1', channel_id: 'parent-c1' },
        referenced_message: {
          id: 'opener-1',
          channel_id: 'parent-c1',
          author: { id: 'u-human', username: 'alice', bot: false },
          content: '',
          timestamp: '2026-04-26T23:59:00Z',
          attachments: [{ url: 'https://cdn.example/p.png', filename: 'p.png', content_type: 'image/png' }],
        },
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'thread-t1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe('[Discord attachment #1: file image/png name=p.png]')
    expect(msg.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'https://cdn.example/p.png', filename: 'p.png', mimetype: 'image/png' },
    ])
    expect(msg.authorId).toBe('u-human')
  })

  test('keeps the starter own body when it has content (does not override with referenced_message)', async () => {
    // given: a normal reply (type 19) carries both its own content and a referenced_message
    const { fn } = fakeFetch([
      {
        id: 'reply-1',
        channel_id: 'c1',
        type: 19,
        author: { id: 'u-bob', username: 'bob', bot: false },
        content: 'my reply text',
        timestamp: '2026-04-27T00:00:02Z',
        message_reference: { message_id: 'orig-1', channel_id: 'c1' },
        referenced_message: {
          id: 'orig-1',
          channel_id: 'c1',
          author: { id: 'u-alice', username: 'alice', bot: false },
          content: 'the original',
          timestamp: '2026-04-27T00:00:01Z',
        },
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe('my reply text')
    expect(msg.authorId).toBe('u-bob')
    expect(msg.replyToBotMessageId).toBe('orig-1')
  })

  test('does NOT remap an empty-body non-starter (type 19/23) carrying referenced_message', async () => {
    // given: an empty-body REPLY (19) and CONTEXT_MENU_COMMAND (23) both carry
    // referenced_message but are not thread starters; they must stay attributed
    // to their own author, never the referenced message's
    const { fn } = fakeFetch([
      {
        id: 'reply-1',
        channel_id: 'c1',
        type: 19,
        author: { id: 'u-bob', username: 'bob', bot: false },
        content: '',
        timestamp: '2026-04-27T00:00:02Z',
        message_reference: { message_id: 'orig-1', channel_id: 'c1' },
        referenced_message: {
          id: 'orig-1',
          channel_id: 'c1',
          author: { id: 'u-alice', username: 'alice', bot: false },
          content: 'the original',
          timestamp: '2026-04-27T00:00:01Z',
        },
      },
      {
        id: 'ctx-1',
        channel_id: 'c1',
        type: 23,
        author: { id: 'u-carol', username: 'carol', bot: false },
        content: '',
        timestamp: '2026-04-27T00:00:03Z',
        message_reference: { message_id: 'orig-1', channel_id: 'c1' },
        referenced_message: {
          id: 'orig-1',
          channel_id: 'c1',
          author: { id: 'u-alice', username: 'alice', bot: false },
          content: 'the original',
          timestamp: '2026-04-27T00:00:01Z',
        },
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const byId = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m]))
    expect(byId['reply-1']!.authorId).toBe('u-bob')
    expect(byId['reply-1']!.text).toBe('')
    expect(byId['ctx-1']!.authorId).toBe('u-carol')
    expect(byId['ctx-1']!.text).toBe('')
  })

  test('leaves an empty-body starter untouched when referenced_message is null (opener deleted)', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: 'starter-1',
        channel_id: 'thread-t1',
        type: 21,
        author: { id: 'system-bot', username: 'Discord', bot: true },
        content: '',
        timestamp: '2026-04-27T00:00:01Z',
        message_reference: { message_id: 'opener-1', channel_id: 'parent-c1' },
        referenced_message: null,
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'thread-t1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const msg = result.messages[0]!
    expect(msg.text).toBe('')
    expect(msg.authorId).toBe('system-bot')
  })

  test('marks author.bot as isBot', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u-human', username: 'human', bot: false },
        content: 'hi',
        timestamp: '2026-04-27T00:00:01Z',
      },
      {
        id: '2',
        channel_id: 'c1',
        author: { id: 'u-bot', username: 'a-bot', bot: true },
        content: 'auto',
        timestamp: '2026-04-27T00:00:02Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    const byId = Object.fromEntries(result.messages.map((m) => [m.externalMessageId, m.isBot]))
    expect(byId['1']).toBe(false)
    expect(byId['2']).toBe(true)
  })

  test('marks our own bot user id as isBot even when author.bot is missing', async () => {
    // given
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u-bot' },
        content: 'self',
        timestamp: '2026-04-27T00:00:01Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => 'u-bot',
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages[0]!.isBot).toBe(true)
  })

  test('sets nextCursor to the oldest message id when the page is full', async () => {
    // given (limit=2 and exactly 2 messages returned → there may be more before)
    const { fn } = fakeFetch([
      {
        id: '5',
        channel_id: 'c1',
        author: { id: 'u', username: 'u', bot: false },
        content: 'b',
        timestamp: '2026-04-27T00:00:05Z',
      },
      {
        id: '4',
        channel_id: 'c1',
        author: { id: 'u', username: 'u', bot: false },
        content: 'a',
        timestamp: '2026-04-27T00:00:04Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 2 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBe('4')
  })

  test('omits nextCursor when the page is not full (channel start reached)', async () => {
    // given (limit=10 but only 1 message returned)
    const { fn } = fakeFetch([
      {
        id: '1',
        channel_id: 'c1',
        author: { id: 'u', username: 'u', bot: false },
        content: 'a',
        timestamp: '2026-04-27T00:00:01Z',
      },
    ])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    if (!result.ok) throw new Error('expected ok')
    expect(result.nextCursor).toBeUndefined()
  })

  test('passes cursor through as ?before= verbatim', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'c1', thread: null, limit: 10, cursor: 'snowflake-42' })
    // then
    const params = new URL(calls[0]!.url).searchParams
    expect(params.get('before')).toBe('snowflake-42')
  })

  test('clamps limit to DISCORD_HISTORY_LIMIT_MAX', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'c1', thread: null, limit: 999 })
    // then
    const params = new URL(calls[0]!.url).searchParams
    expect(params.get('limit')).toBe(String(DISCORD_HISTORY_LIMIT_MAX))
  })

  test('returns ok:false on non-2xx response (does not throw)', async () => {
    // given
    const { fn } = fakeFetch({ status: 429 })
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'http 429' })
  })

  test('swallows fetch rejection into ok:false', async () => {
    // given
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'c1', thread: null, limit: 10 })
    // then
    expect(result).toEqual({ ok: false, error: 'network down' })
  })

  test('admits per-channel allow rule (channel:<id>) without a workspace at fetch time', async () => {
    // given
    const { fn, calls } = fakeFetch([])
    const cb = createDiscordHistoryCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'channel-id', thread: null, limit: 10 })
    // then
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(true)
  })
})

describe('createDiscordMessageGetCallback', () => {
  type FetchCall = { url: string; init: RequestInit }

  function fakeFetch(jsonOrStatus: unknown | { status: number }): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      if (typeof jsonOrStatus === 'object' && jsonOrStatus !== null && 'status' in jsonOrStatus) {
        return new Response(null, { status: (jsonOrStatus as { status: number }).status })
      }
      return new Response(JSON.stringify(jsonOrStatus), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  const silentLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} })

  test('GETs the single-message endpoint and maps the message', async () => {
    // given
    const { fn, calls } = fakeFetch({
      id: 'M1',
      channel_id: 'C0',
      author: { id: 'u1', username: 'Alice', bot: false },
      content: 'the one message',
      timestamp: '2026-04-27T00:00:01Z',
    })
    const cb = createDiscordMessageGetCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, messageId: 'M1' })
    // then
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/C0/messages/M1')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bot tok')
    if (!result.ok) throw new Error('expected ok')
    expect(result.message.externalMessageId).toBe('M1')
    expect(result.message.text).toBe('the one message')
  })

  test('uses thread as the channel id when given', async () => {
    // given
    const { fn, calls } = fakeFetch({
      id: 'M2',
      channel_id: 'TH1',
      author: { id: 'u1', username: 'A', bot: false },
      content: 'in thread',
      timestamp: '2026-04-27T00:00:01Z',
    })
    const cb = createDiscordMessageGetCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    await cb({ chat: 'C0', thread: 'TH1', messageId: 'M2' })
    // then
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/channels/TH1/messages/M2')
  })

  test('maps a 404 to a soft not-found', async () => {
    // given
    const { fn } = fakeFetch({ status: 404 })
    const cb = createDiscordMessageGetCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, messageId: 'GONE' })
    // then
    expect(result).toEqual({ ok: false, error: 'message not found', code: 'not-found' })
  })

  test('surfaces non-404 http errors verbatim', async () => {
    // given
    const { fn } = fakeFetch({ status: 403 })
    const cb = createDiscordMessageGetCallback({
      token: 'tok',
      logger: silentLogger(),
      botUserIdRef: () => null,
      fetchImpl: fn,
    })
    // when
    const result = await cb({ chat: 'C0', thread: null, messageId: 'M1' })
    // then
    expect(result).toEqual({ ok: false, error: 'http 403' })
  })
})

describe('createDiscordListCallback', () => {
  type FetchCall = { url: string; init: RequestInit }

  function fakeFetch(jsonOrStatus: unknown[] | { status: number }): { fn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      if (Array.isArray(jsonOrStatus)) {
        return new Response(JSON.stringify(jsonOrStatus), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(null, { status: jsonOrStatus.status })
    }) as unknown as typeof fetch
    return { fn, calls }
  }

  const silentLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} })

  test('GETs the guild channels endpoint and maps readable types with kind', async () => {
    // given text (0), announcement (5), forum (15), media (16), public thread (11)
    const { fn, calls } = fakeFetch([
      { id: 'C1', name: 'general', type: 0 },
      { id: 'A1', name: 'news', type: 5 },
      { id: 'F1', name: 'help-forum', type: 15 },
      { id: 'M1', name: 'clips', type: 16 },
      { id: 'T1', name: 'spinoff', type: 11 },
    ])
    const cb = createDiscordListCallback({ token: 'tok', logger: silentLogger(), fetchImpl: fn })
    // when
    const result = await cb({ workspace: 'G0', limit: 50 })
    // then
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/guilds/G0/channels')
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries).toEqual([
      { chat: 'C1', name: '#general', kind: 'channel' },
      { chat: 'A1', name: '#news', kind: 'channel' },
      { chat: 'F1', name: '#help-forum', kind: 'channel' },
      { chat: 'M1', name: '#clips', kind: 'channel' },
      { chat: 'T1', name: '#spinoff', kind: 'thread' },
    ])
  })

  test('drops non-message channel types (category, voice, stage)', async () => {
    // given a category (4), voice (2), and stage (13) channel mixed with one text channel
    const { fn } = fakeFetch([
      { id: 'CAT', name: 'Information', type: 4 },
      { id: 'VOICE', name: 'General Voice', type: 2 },
      { id: 'STAGE', name: 'Town Hall', type: 13 },
      { id: 'C1', name: 'general', type: 0 },
    ])
    const cb = createDiscordListCallback({ token: 'tok', logger: silentLogger(), fetchImpl: fn })
    // when
    const result = await cb({ workspace: 'G0', limit: 50 })
    // then only the text channel survives — non-message types are not readable chats
    if (!result.ok) throw new Error('expected ok')
    expect(result.entries).toEqual([{ chat: 'C1', name: '#general', kind: 'channel' }])
  })

  test('surfaces http errors verbatim', async () => {
    // given
    const { fn } = fakeFetch({ status: 403 })
    const cb = createDiscordListCallback({ token: 'tok', logger: silentLogger(), fetchImpl: fn })
    // when
    const result = await cb({ workspace: 'G0', limit: 50 })
    // then
    expect(result).toEqual({ ok: false, error: 'http 403' })
  })
})

describe('discord-bot createOutboundCallback', () => {
  type SendCall = { chat: string; content: string; options?: { thread_id?: string; reply_to?: string } }
  type UploadCall = { url: string; payload: unknown; file: File }

  function makeFakeClient(behavior: { sendMessage?: 'ok' | 'reject' } = {}): {
    client: Pick<DiscordBotClient, 'sendMessage'>
    sends: SendCall[]
  } {
    const sends: SendCall[] = []
    return {
      sends,
      client: {
        sendMessage: async (chat, content, options) => {
          sends.push({ chat, content, options })
          if (behavior.sendMessage === 'reject') throw new Error('discord_send_failed')
          return {
            id: `m${sends.length}`,
            channel_id: chat,
            author: { id: 'b1', username: 'bot' },
            content,
            timestamp: '',
          } as DiscordMessage
        },
      },
    }
  }

  // Fake Discord create-message endpoint. Echoes back the filename declared in
  // payload_json.attachments, which is what real Discord names the attachment.
  function makeUploadFetch(responses: Array<'ok' | 429 | '429-no-header' | '429-long' | 500> = []): {
    fetchImpl: typeof fetch
    uploads: UploadCall[]
  } {
    const uploads: UploadCall[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const body = init?.body as FormData
      const payload = JSON.parse(body.get('payload_json') as string) as { attachments: Array<{ filename: string }> }
      uploads.push({ url, payload, file: body.get('files[0]') as File })
      const behavior = responses[uploads.length - 1] ?? 'ok'
      if (behavior === 429) {
        return new Response('{"retry_after":0}', { status: 429, headers: { 'retry-after': '0' } })
      }
      if (behavior === '429-no-header') return new Response('{}', { status: 429 })
      if (behavior === '429-long') {
        return new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
      }
      if (behavior === 500) return new Response('boom', { status: 500 })
      const filename = payload.attachments[0]?.filename ?? 'unknown'
      return new Response(JSON.stringify({ attachments: [{ id: `f${uploads.length}`, filename, size: 3 }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    return { fetchImpl, uploads }
  }

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} }
  }

  function makeMsg(overrides: Partial<OutboundMessage>): OutboundMessage {
    return { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hi', ...overrides } as OutboundMessage
  }

  const tag = async (_w: string, _c: string) => 'guild=g1 channel=c1'

  function makeOutbound(deps: Omit<Parameters<typeof createOutboundCallback>[0], 'token'> & { token?: string }) {
    return createOutboundCallback({ token: 'bot-tok', ...deps })
  }

  async function writeTempFile(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'discord-upload-'))
    const path = join(dir, name)
    await writeFile(path, 'png')
    return path
  }

  test('text-only path posts via sendMessage and never uploads', async () => {
    // given
    const { client, sends } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag, fetchImpl })
    // when
    const result = await cb(makeMsg({ text: 'hello' }))
    // then
    expect(result).toEqual({
      ok: true,
      messageId: 'm1',
      messageIds: ['m1'],
      reactionRef: encodeDiscordReactionRef({ channel: 'c1', message: 'm1' }),
    })
    expect(uploads).toHaveLength(0)
    expect(sends).toEqual([{ chat: 'c1', content: 'hello', options: undefined }])
  })

  test('threaded text-only post forwards thread_id to sendMessage', async () => {
    const { client, sends } = makeFakeClient()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag })
    await cb(makeMsg({ text: 'hello', thread: 't1' }))
    expect(sends).toEqual([{ chat: 'c1', content: 'hello', options: { thread_id: 't1' } }])
  })

  test('converts a markdown table into Discord inline-code rows before sending', async () => {
    const { client, sends } = makeFakeClient()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag })
    const table = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
    await cb(makeMsg({ text: table }))
    expect(sends).toEqual([{ chat: 'c1', content: '**`a  b`**\n`1  2`', options: undefined }])
  })

  test('forwards replyTo.externalMessageId as the reply_to send option (native reply)', async () => {
    const { client, sends } = makeFakeClient()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag })
    await cb(makeMsg({ text: 'on it', replyTo: { externalMessageId: 'parent-9' } }))
    expect(sends).toEqual([{ chat: 'c1', content: 'on it', options: { reply_to: 'parent-9' } }])
  })

  test('combines thread_id and reply_to when both apply', async () => {
    const { client, sends } = makeFakeClient()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag })
    await cb(makeMsg({ text: 'on it', thread: 't1', replyTo: { externalMessageId: 'parent-9' } }))
    expect(sends).toEqual([{ chat: 'c1', content: 'on it', options: { thread_id: 't1', reply_to: 'parent-9' } }])
  })

  test('attachments-only post uploads each file with no follow-up sendMessage', async () => {
    const { client, sends } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag, fetchImpl })
    const a = await writeTempFile('a.png')
    const b = await writeTempFile('b.pdf')
    const result = await cb(makeMsg({ text: undefined, attachments: [{ path: a }, { path: b }] }))
    expect(result.ok).toBe(true)
    expect(uploads.map((u) => u.url)).toEqual([
      'https://discord.com/api/v10/channels/c1/messages',
      'https://discord.com/api/v10/channels/c1/messages',
    ])
    expect(sends).toHaveLength(0)
  })

  test('declares the original filename in payload_json.attachments so Discord does not name it by index', async () => {
    // given
    const { client } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch()
    const infos: string[] = []
    const cb = makeOutbound({
      client,
      logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
      formatChannelTag: tag,
      fetchImpl,
    })
    const english = await writeTempFile('report.pdf')
    const korean = await writeTempFile('보고서 최종.pdf')
    // when
    await cb(makeMsg({ text: undefined, attachments: [{ path: english }, { path: korean }] }))
    // then
    expect(uploads.map((u) => u.payload)).toEqual([
      { attachments: [{ id: 0, filename: 'report.pdf' }] },
      { attachments: [{ id: 0, filename: '보고서 최종.pdf' }] },
    ])
    expect(uploads.map((u) => u.file.name)).toEqual(['report.pdf', '보고서 최종.pdf'])
    expect(infos.some((m) => m.includes('filename=보고서 최종.pdf'))).toBe(true)
  })

  test('honors the OutboundAttachment filename override over the on-disk basename', async () => {
    const { client } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag, fetchImpl })
    const path = await writeTempFile('tmp-3f9a2.png')
    await cb(makeMsg({ text: undefined, attachments: [{ path, filename: 'chart.png' }] }))
    expect(uploads[0]?.payload).toEqual({ attachments: [{ id: 0, filename: 'chart.png' }] })
    expect(uploads[0]?.file.name).toBe('chart.png')
  })

  test('attachment-only reply carries message_reference in payload_json (native reply)', async () => {
    const { client, sends } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag, fetchImpl })
    const path = await writeTempFile('screen.png')

    const result = await cb(
      makeMsg({ text: undefined, attachments: [{ path }], replyTo: { externalMessageId: 'parent-77' } }),
    )

    expect(result.ok).toBe(true)
    expect(sends).toHaveLength(0)
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.payload).toEqual({
      attachments: [{ id: 0, filename: 'screen.png' }],
      message_reference: { message_id: 'parent-77' },
    })
  })

  test('only the FIRST file of a multi-attachment reply carries message_reference', async () => {
    const { client } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag, fetchImpl })
    const first = await writeTempFile('a.png')
    const second = await writeTempFile('b.png')

    await cb(
      makeMsg({
        text: undefined,
        attachments: [{ path: first }, { path: second }],
        replyTo: { externalMessageId: 'parent-88' },
      }),
    )

    expect(uploads.map((u) => u.payload)).toEqual([
      { attachments: [{ id: 0, filename: 'a.png' }], message_reference: { message_id: 'parent-88' } },
      { attachments: [{ id: 0, filename: 'b.png' }] },
    ])
  })

  test('text+attachment reply keeps the reference on the text send, not the file upload', async () => {
    const { client, sends } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag, fetchImpl })
    const path = await writeTempFile('a.png')

    await cb(makeMsg({ text: 'here you go', attachments: [{ path }], replyTo: { externalMessageId: 'parent-99' } }))

    expect(uploads.map((u) => u.payload)).toEqual([{ attachments: [{ id: 0, filename: 'a.png' }] }])
    expect(sends).toEqual([{ chat: 'c1', content: 'here you go', options: { reply_to: 'parent-99' } }])
  })

  test('text+attachments uploads first, then posts text in same channel', async () => {
    // given
    const order: string[] = []
    const { client, sends } = makeFakeClient()
    const { fetchImpl: baseFetch } = makeUploadFetch()
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      order.push('upload')
      return baseFetch(...args)
    }) as unknown as typeof fetch
    const recordingClient = {
      sendMessage: async (...args: Parameters<DiscordBotClient['sendMessage']>) => {
        order.push('send')
        return client.sendMessage(...args)
      },
    }
    const cb = makeOutbound({ client: recordingClient, logger: silentLogger(), formatChannelTag: tag, fetchImpl })
    const path = await writeTempFile('a.png')
    // when
    await cb(makeMsg({ text: 'caption', attachments: [{ path }] }))
    // then
    expect(order).toEqual(['upload', 'send'])
    expect(sends).toEqual([{ chat: 'c1', content: 'caption', options: undefined }])
  })

  test('threaded text+attachments warns about file landing in channel root and still threads the text', async () => {
    // given
    const { client, sends } = makeFakeClient()
    const { fetchImpl } = makeUploadFetch()
    const warns: string[] = []
    const cb = makeOutbound({
      client,
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
      formatChannelTag: tag,
      fetchImpl,
    })
    const path = await writeTempFile('a.png')
    // when
    await cb(makeMsg({ text: 'caption', thread: 't1', attachments: [{ path }] }))
    // then
    expect(sends).toEqual([{ chat: 'c1', content: 'caption', options: { thread_id: 't1' } }])
    expect(warns.some((m) => m.includes('channel root, not thread t1'))).toBe(true)
  })

  test('retries a rate-limited upload after the Retry-After delay instead of failing the send', async () => {
    const { client } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch([429, 'ok'])
    const sleeps: number[] = []
    const cb = makeOutbound({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    })
    const path = await writeTempFile('a.png')
    const result = await cb(makeMsg({ text: undefined, attachments: [{ path }] }))
    expect(result.ok).toBe(true)
    expect(uploads).toHaveLength(2)
    expect(sleeps).toEqual([0])
  })

  test('waits out the full Retry-After cooldown rather than capping it', async () => {
    const { client } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch(['429-long', 'ok'])
    const sleeps: number[] = []
    const cb = makeOutbound({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    })
    const path = await writeTempFile('a.png')
    const result = await cb(makeMsg({ text: undefined, attachments: [{ path }] }))
    expect(result.ok).toBe(true)
    expect(uploads).toHaveLength(2)
    expect(sleeps).toEqual([30_000])
  })

  test('waits the one-second fallback when a 429 carries no Retry-After header', async () => {
    const { client } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch(['429-no-header', 'ok'])
    const sleeps: number[] = []
    const cb = makeOutbound({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    })
    const path = await writeTempFile('a.png')
    const result = await cb(makeMsg({ text: undefined, attachments: [{ path }] }))
    expect(result.ok).toBe(true)
    expect(uploads).toHaveLength(2)
    expect(sleeps).toEqual([1_000])
  })

  test('upload failure aborts before sendMessage runs', async () => {
    const { client, sends } = makeFakeClient()
    const { fetchImpl } = makeUploadFetch([500])
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag, fetchImpl })
    const path = await writeTempFile('a.png')
    const result = await cb(makeMsg({ text: 'caption', attachments: [{ path }] }))
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error : '').toContain('uploadFile failed')
    expect(sends).toHaveLength(0)
  })

  test('rejects when message has neither text nor attachments', async () => {
    const { client } = makeFakeClient()
    const cb = makeOutbound({ client, logger: silentLogger(), formatChannelTag: tag })
    const result = await cb(makeMsg({ text: undefined, attachments: [] }))
    expect(result.ok).toBe(false)
  })

  test('honors resolvePath for reading, but names the file from the agent-facing path', async () => {
    const { client } = makeFakeClient()
    const { fetchImpl, uploads } = makeUploadFetch()
    const real = await writeTempFile('a.png')
    const cb = makeOutbound({
      client,
      logger: silentLogger(),
      formatChannelTag: tag,
      fetchImpl,
      resolvePath: (p) => (p === '/agent/out/a.png' ? real : p),
    })
    const result = await cb(makeMsg({ text: undefined, attachments: [{ path: '/agent/out/a.png' }] }))
    expect(result.ok).toBe(true)
    expect(uploads[0]?.payload).toEqual({ attachments: [{ id: 0, filename: 'a.png' }] })
  })
})

describe('discord-bot slash command declarations', () => {
  test('declares help, stop, reload, and restart', () => {
    expect(DISCORD_SLASH_COMMAND_NAMES).toEqual(new Set(['help', 'stop', 'reload', 'restart']))
  })
})

describe('createInteractionHandler', () => {
  type CapturedCall = { url: string; init: RequestInit }
  type RouterCall = { key: ChannelKey; name: string; invokerId: string; parentChat?: string }
  type RouterResult =
    | { kind: 'handled'; name: string; reply?: string }
    | { kind: 'no-live-session' }
    | { kind: 'permission-denied' }
    | { kind: 'unknown-command'; name: string }

  function setup(
    routerImpl: (key: ChannelKey, name: string, invokerId: string) => Promise<RouterResult>,
    formatChannelTagImpl?: (workspace: string, chat: string) => Promise<string>,
  ): {
    handler: ReturnType<typeof createInteractionHandler>
    fetchCalls: CapturedCall[]
    routerCalls: RouterCall[]
    logs: { info: string[]; warn: string[]; error: string[] }
  } {
    const fetchCalls: CapturedCall[] = []
    const routerCalls: RouterCall[] = []
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const fetchImpl = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      return new Response('', { status: 204 })
    }) as unknown as typeof fetch
    const handler = createInteractionHandler({
      router: {
        executeCommand: async (key, name, options) => {
          routerCalls.push({
            key,
            name,
            invokerId: options.invokerId,
            ...(options.parentChat !== undefined ? { parentChat: options.parentChat } : {}),
          })
          return routerImpl(key, name, options.invokerId)
        },
      },
      knownCommandNames: DISCORD_SLASH_COMMAND_NAMES,
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
      formatChannelTag: formatChannelTagImpl ?? (async (workspace, chat) => `guild=${workspace} channel=${chat}`),
      fetchImpl,
    })
    return { handler, fetchCalls, routerCalls, logs }
  }

  function interaction(over: Record<string, unknown> = {}): Parameters<ReturnType<typeof createInteractionHandler>>[0] {
    return {
      type: 'INTERACTION_CREATE',
      id: 'i-1',
      application_id: 'app-1',
      token: 'tok-abc',
      channel_id: 'c1',
      guild_id: 'g1',
      member: { user: { id: 'u-alice' } },
      data: { name: 'stop', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT },
      ...over,
    } as Parameters<ReturnType<typeof createInteractionHandler>>[0]
  }

  test('/stop interaction routes to executeCommand with the correct ChannelKey, forwards the invoker, and acks Discord', async () => {
    const { handler, fetchCalls, routerCalls } = setup(async () => ({ kind: 'handled', name: 'stop' }))

    await handler(interaction())

    expect(routerCalls).toEqual([
      {
        key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null },
        name: 'stop',
        invokerId: 'u-alice',
      },
    ])
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('https://discord.com/api/v10/interactions/i-1/tok-abc/callback')
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.data.content).toContain('Stopped')
    expect(body.data.flags).toBe(64)
  })

  test('/stop interaction forwards its Discord thread parent to executeCommand', async () => {
    const { handler, routerCalls } = setup(async () => ({ kind: 'handled', name: 'stop' }))
    const event = interaction({
      channel_id: '100000000000000001',
      guild_id: '100000000000000002',
    }) as Parameters<ReturnType<typeof createInteractionHandler>>[0] & {
      channel: { id: string; type: number; parent_id: string }
    }
    event.channel = {
      id: '100000000000000001',
      type: 11,
      parent_id: '100000000000000003',
    }

    await handler(event)

    expect(routerCalls[0]?.parentChat).toBe('100000000000000003')
  })

  test('/help interaction acks with the handler-provided command list', async () => {
    const helpText = 'Available commands:\n/help — List available commands\n/stop — Abort the current turn'
    const { handler, fetchCalls } = setup(async () => ({ kind: 'handled', name: 'help', reply: helpText }))

    await handler(interaction({ data: { name: 'help', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT } }))

    expect(fetchCalls).toHaveLength(1)
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.data.content).toBe(helpText)
    expect(body.data.flags).toBe(64)
  })

  test('cold-channel /stop acks with "nothing to stop" and does not retry', async () => {
    const { handler, fetchCalls, routerCalls } = setup(async () => ({ kind: 'no-live-session' }))

    await handler(interaction())

    expect(routerCalls).toHaveLength(1)
    expect(fetchCalls).toHaveLength(1)
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.data.content).toBe('Nothing to stop — no active turn in this channel. Send a new message to start one.')
  })

  test('non-CHAT_INPUT interactions (buttons, modals, autocomplete) are silently dropped', async () => {
    const { handler, fetchCalls, routerCalls, logs } = setup(async () => ({ kind: 'handled', name: 'stop' }))

    await handler(interaction({ data: { name: 'stop', type: 2 } }))

    expect(routerCalls).toEqual([])
    expect(fetchCalls).toEqual([])
    expect(logs.warn).toEqual([])
  })

  test('unknown registered command name is dropped with a warn log (defensive)', async () => {
    const { handler, fetchCalls, routerCalls, logs } = setup(async () => ({ kind: 'handled', name: 'stop' }))

    await handler(interaction({ data: { name: 'totally-not-stop', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT } }))

    expect(routerCalls).toEqual([])
    expect(fetchCalls).toEqual([])
    expect(logs.warn.some((m) => m.includes('unknown-command'))).toBe(true)
  })

  test('DM interaction (no guild) maps workspace to @dm and resolves invoker from user.id', async () => {
    const { handler, routerCalls } = setup(async () => ({ kind: 'handled', name: 'stop' }))

    await handler(
      interaction({
        guild_id: undefined,
        member: undefined,
        user: { id: 'u-bob', username: 'bob' },
      }),
    )

    expect(routerCalls).toEqual([
      {
        key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
        name: 'stop',
        invokerId: 'u-bob',
      },
    ])
  })

  test('ack failure is logged but does not throw (abort already happened server-side)', async () => {
    const fetchCalls: CapturedCall[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      return new Response('{"message":"Unknown interaction"}', { status: 404 })
    }) as unknown as typeof fetch
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const handler = createInteractionHandler({
      router: { executeCommand: async () => ({ kind: 'handled', name: 'stop' }) },
      knownCommandNames: DISCORD_SLASH_COMMAND_NAMES,
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
      formatChannelTag: async () => 'guild=g1 channel=c1',
      fetchImpl,
    })

    await handler(interaction())

    expect(logs.warn.some((m) => m.includes('ack failed'))).toBe(true)
    expect(logs.error).toEqual([])
  })

  test('exception inside executeCommand is caught and logged as error', async () => {
    const { handler, logs } = setup(async () => {
      throw new Error('router exploded')
    })

    await handler(interaction())

    expect(logs.error.some((m) => m.includes('router exploded'))).toBe(true)
  })

  test('permission-denied result acks with the permission-denied message (visible to invoker)', async () => {
    const { handler, fetchCalls } = setup(async () => ({ kind: 'permission-denied' }))

    await handler(interaction())

    expect(fetchCalls).toHaveLength(1)
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.data.content).toMatch(/permission/i)
    expect(body.data.flags).toBe(64)
  })

  test('ack is sent BEFORE the slow formatChannelTag completes (3s budget protection)', async () => {
    // Fixed clock — measure when ack is sent relative to formatChannelTag.
    const events: Array<{ at: number; kind: 'router-call' | 'ack-sent' | 'channel-tag-resolved' }> = []
    let clock = 0
    const tick = (): number => ++clock

    const fetchCalls: CapturedCall[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      events.push({ at: tick(), kind: 'ack-sent' })
      return new Response('', { status: 204 })
    }) as unknown as typeof fetch

    let releaseTag: (() => void) | undefined
    const tagPromise = new Promise<string>((resolve) => {
      releaseTag = () => {
        events.push({ at: tick(), kind: 'channel-tag-resolved' })
        resolve('guild=g1-name channel=c1-name')
      }
    })

    const handler = createInteractionHandler({
      router: {
        executeCommand: async () => {
          events.push({ at: tick(), kind: 'router-call' })
          return { kind: 'handled', name: 'stop' }
        },
      },
      knownCommandNames: DISCORD_SLASH_COMMAND_NAMES,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      formatChannelTag: () => tagPromise,
      fetchImpl,
    })

    const handlerDone = handler(interaction())
    // Wait long enough for router.executeCommand and ack to complete, but
    // hold formatChannelTag back. If the ack-first ordering is correct, the
    // ack already fired before we release the tag.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fetchCalls).toHaveLength(1)
    expect(events.map((e) => e.kind)).toEqual(['router-call', 'ack-sent'])

    releaseTag!()
    await handlerDone

    expect(events.map((e) => e.kind)).toEqual(['router-call', 'ack-sent', 'channel-tag-resolved'])
  })
})

class FakeDiscordBotListener {
  private handlers = new Map<string, Array<(arg: unknown) => void>>()
  readonly value = this as unknown as DiscordBotListener
  stopped = false

  constructor(private readonly options: { failStart?: boolean | unknown } = {}) {}

  on(event: string, listener: (arg: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }

  async start(): Promise<void> {
    const { failStart } = this.options
    if (failStart === undefined || failStart === false) {
      this.emit('connected', connectedInfo())
      return
    }
    throw failStart === true ? new Error('start failed') : failStart
  }

  stop(): void {
    this.stopped = true
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }
}

class FakeDiscordBotRouter {
  readonly registered: string[] = []
  readonly unregistered: string[] = []
  selfIdentity: ((workspace: string) => { id: string; username?: string } | null) | null = null
  readonly value = {
    route: async () => {},
    registerOutbound: () => this.registered.push('outbound'),
    unregisterOutbound: () => this.unregistered.push('outbound'),
    registerReaction: () => this.registered.push('reaction'),
    unregisterReaction: () => this.unregistered.push('reaction'),
    registerRemoveReaction: () => this.registered.push('removeReaction'),
    unregisterRemoveReaction: () => this.unregistered.push('removeReaction'),
    registerPrepareOwnReaction: () => {},
    unregisterPrepareOwnReaction: () => {},
    registerRemoveOwnReaction: () => {},
    unregisterRemoveOwnReaction: () => {},
    registerTyping: () => this.registered.push('typing'),
    unregisterTyping: () => this.unregistered.push('typing'),
    setTypingCapability: (_adapter: string, supported: boolean) =>
      (supported ? this.registered : this.unregistered).push('typingCapability'),
    registerChannelNameResolver: () => this.registered.push('channelNameResolver'),
    unregisterChannelNameResolver: () => this.unregistered.push('channelNameResolver'),
    registerSelfIdentity: (_adapter: string, cb: (workspace: string) => { id: string; username?: string } | null) => {
      this.selfIdentity = cb
      this.registered.push('selfIdentity')
    },
    unregisterSelfIdentity: () => this.unregistered.push('selfIdentity'),
    registerHistory: () => this.registered.push('history'),
    unregisterHistory: () => this.unregistered.push('history'),
    registerMessageGet: () => this.registered.push('messageGet'),
    unregisterMessageGet: () => this.unregistered.push('messageGet'),
    registerList: () => this.registered.push('list'),
    unregisterList: () => this.unregistered.push('list'),
    registerEditMessage: () => this.registered.push('editMessage'),
    unregisterEditMessage: () => this.unregistered.push('editMessage'),
    registerFetchAttachment: () => this.registered.push('fetchAttachment'),
    unregisterFetchAttachment: () => this.unregistered.push('fetchAttachment'),
    registerMembership: () => this.registered.push('membership'),
    unregisterMembership: () => this.unregistered.push('membership'),
  } as unknown as ChannelRouter
}

function connectedInfo() {
  return { user: { id: 'bot-1', username: 'Typeey' }, sessionId: 'session-1' }
}

function lifecycleConfig(): ChannelAdapterConfig {
  return {
    engagement: { trigger: ['mention'], stickiness: 'off' },
    enabled: true,
    history: defaultHistoryConfig(),
  }
}

function fakeDiscordBotClient() {
  return {
    login: async () => fakeDiscordBotClient(),
  } as unknown as ReturnType<NonNullable<Parameters<typeof createDiscordBotAdapter>[0]['createClient']>>
}
