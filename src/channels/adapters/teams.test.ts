import { describe, expect, test } from 'bun:test'

import { TeamsError } from 'agent-messenger/teams'
import type {
  TeamsListener,
  TeamsMessage,
  TeamsMessageFormat,
  TeamsRealtimeMessage,
  TeamsUser,
} from 'agent-messenger/teams'

import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { InboundMessage, OutboundCallback, OutboundMessage } from '@/channels/types'
import type { TeamsAccountRecord } from '@/secrets/schema'

import {
  createOutboundCallback,
  createTeamsAdapter,
  createTeamsHistoryCallback,
  type TeamsAdapterLogger,
  type TeamsChatInfo,
} from './teams'

const config = channelsSchema.parse({ teams: {} }).teams!

const SELF: TeamsUser = { id: 'ME', displayName: 'Typeey', userPrincipalName: 'typeey@example.com' }

function logger(): TeamsAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

function account(overrides: Partial<TeamsAccountRecord> = {}): TeamsAccountRecord {
  return {
    account_id: 'account-1',
    access_token: 'access-1',
    account_type: 'work',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function realtime(overrides: Partial<TeamsRealtimeMessage> = {}): TeamsRealtimeMessage {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    conversationType: 'chat',
    content: 'hello typeclaw',
    mentions: [],
    author: { id: 'user-1', displayName: 'Alice' },
    messageType: 'RichText/Html',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const CHANNEL_KEY = 'channel:team-guid:19:abc@thread.tacv2'

// A Teams mention marker plus the bare characters Teams' HTML renderer would
// otherwise swallow — the exact content whose rendering the format choice decides.
const MARKUP_TEXT = '<at id="0">Alice</at> compare 1 < 2 && 3 > 2'

function channelRealtime(overrides: Partial<TeamsRealtimeMessage> = {}): TeamsRealtimeMessage {
  return realtime({
    id: 'ch-1',
    chatId: '19:abc@thread.tacv2',
    conversationType: 'channel',
    teamId: 'team-guid',
    channelId: '19:abc@thread.tacv2',
    ...overrides,
  })
}

function teamsMessage(overrides: Partial<TeamsMessage> = {}): TeamsMessage {
  return {
    id: 'm',
    channel_id: 'chat-1',
    author: { id: 'user-1', displayName: 'Alice' },
    content: 'hi',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return { adapter: 'teams', workspace: 'teams', chat: 'chat:chat-1', text: 'hello', ...overrides }
}

const groupChat: TeamsChatInfo = { id: 'chat-1', type: 'group' } as TeamsChatInfo

class FakeListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()
  stopped = false
  startImpl: () => Promise<void> = async () => {
    // Real TeamsListener emits `connected` asynchronously after start()
    // resolves; mirror that so the adapter's await-connected path is exercised.
    queueMicrotask(() => this.emit('connected', { endpointId: 'ep-1' }))
  }

  on(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  off(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((h) => h !== handler),
    )
  }

  async start(): Promise<void> {
    await this.startImpl()
  }

  stop(): void {
    this.stopped = true
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
}

type TestRouter = ChannelRouter & {
  routed: InboundMessage[]
  registered: string[]
  unregistered: string[]
  outboundCb: OutboundCallback | null
}

function router(): TestRouter {
  const routed: InboundMessage[] = []
  const registered: string[] = []
  const unregistered: string[] = []
  const state = { outboundCb: null as OutboundCallback | null }
  return {
    routed,
    registered,
    unregistered,
    get outboundCb() {
      return state.outboundCb
    },
    route: async (msg: InboundMessage) => {
      routed.push(msg)
      return { kind: 'accepted' as const, inputId: msg.externalMessageId, generation: 0 }
    },
    registerOutbound: (adapter: string, cb: OutboundCallback) => {
      registered.push(`outbound:${adapter}`)
      state.outboundCb = cb
    },
    unregisterOutbound: (adapter: string) => unregistered.push(`outbound:${adapter}`),
    registerSelfIdentity: (adapter: string) => registered.push(`self:${adapter}`),
    unregisterSelfIdentity: (adapter: string) => unregistered.push(`self:${adapter}`),
    registerHistory: (adapter: string) => registered.push(`history:${adapter}`),
    unregisterHistory: (adapter: string) => unregistered.push(`history:${adapter}`),
    registerEditMessage: (adapter: string) => registered.push(`edit:${adapter}`),
    unregisterEditMessage: (adapter: string) => unregistered.push(`edit:${adapter}`),
    getSelfAliases: () => [],
  } as unknown as TestRouter
}

type ClientOverrides = {
  chats?: TeamsChatInfo[]
  channelTeamMap?: Map<string, string>
  sendChatMessage?: (chatId: string, content: string, format?: TeamsMessageFormat) => Promise<TeamsMessage>
  sendMessage?: (
    teamId: string,
    channelId: string,
    content: string,
    rootMessageId?: string,
    format?: TeamsMessageFormat,
  ) => Promise<TeamsMessage>
  getChatMessages?: (chatId: string, limit?: number) => Promise<TeamsMessage[]>
  getMessages?: (teamId: string, channelId: string, limit?: number) => Promise<TeamsMessage[]>
  testAuth?: () => Promise<TeamsUser>
}

function fakeClient(overrides: ClientOverrides = {}) {
  const sends: Array<{ chatId: string; content: string; format?: TeamsMessageFormat }> = []
  const channelSends: Array<{
    teamId: string
    channelId: string
    content: string
    rootMessageId?: string
    format?: TeamsMessageFormat
  }> = []
  const client = {
    login: async () => {},
    testAuth: overrides.testAuth ?? (async () => SELF),
    listChats: async () => overrides.chats ?? [groupChat],
    buildChannelTeamMap: async () => overrides.channelTeamMap ?? new Map<string, string>(),
    sendChatMessage:
      overrides.sendChatMessage ??
      (async (chatId: string, content: string, format?: TeamsMessageFormat) => {
        sends.push({ chatId, content, format })
        return teamsMessage({ id: 'sent', content })
      }),
    sendMessage:
      overrides.sendMessage ??
      (async (
        teamId: string,
        channelId: string,
        content: string,
        rootMessageId?: string,
        format?: TeamsMessageFormat,
      ) => {
        channelSends.push({ teamId, channelId, content, rootMessageId, format })
        return teamsMessage({ id: 'sent-ch', content })
      }),
    getChatMessages: overrides.getChatMessages ?? (async () => []),
    getMessages: overrides.getMessages ?? (async () => []),
  }
  return { sends, channelSends, client }
}

function adapterWith(deps: {
  r: ReturnType<typeof router>
  listener: FakeListener
  client: ReturnType<typeof fakeClient>['client']
  log?: TeamsAdapterLogger
  aliases?: readonly string[]
  store?: { getAccount: () => Promise<TeamsAccountRecord | null> }
  now?: () => number
}) {
  return createTeamsAdapter({
    router: deps.r,
    configRef: () => config,
    logger: deps.log ?? logger(),
    ...(deps.aliases ? { selfAliasesRef: () => deps.aliases! } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    credentialsStore: deps.store ?? { getAccount: async () => account() },
    createClient: () =>
      deps.client as unknown as ReturnType<NonNullable<Parameters<typeof createTeamsAdapter>[0]['createClient']>>,
    createListener: () => deps.listener as unknown as TeamsListener,
  })
}

describe('teams outbound', () => {
  test('sends to the decoded chat id and returns the sent message id', async () => {
    const { sends, client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    const result = await cb(outbound({ text: 'hi' }))

    expect(result).toEqual({ ok: true, messageId: 'sent', messageIds: ['sent'] })
    expect(sends).toEqual([{ chatId: 'chat-1', content: 'hi', format: 'text' }])
  })

  test('sends a channel key via sendMessage(teamId, channelId, rootMessageId)', async () => {
    const { channelSends, client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    const result = await cb(outbound({ chat: CHANNEL_KEY, text: 'deploying', thread: 'root-9' }))

    expect(result).toEqual({ ok: true, messageId: 'sent-ch', messageIds: ['sent-ch'] })
    expect(channelSends).toEqual([
      {
        teamId: 'team-guid',
        channelId: '19:abc@thread.tacv2',
        content: 'deploying',
        rootMessageId: 'root-9',
        format: 'text',
      },
    ])
  })

  // Pins TEAMS_OUTBOUND_FORMAT at both send boundaries: without it an upstream
  // default flip would silently turn relayed user text into live Teams markup.
  test('passes format text for a chat send so Teams markup is not interpreted', async () => {
    const { sends, client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    await cb(outbound({ text: MARKUP_TEXT }))

    expect(sends).toEqual([{ chatId: 'chat-1', content: MARKUP_TEXT, format: 'text' }])
  })

  test('passes format text for a channel send so Teams markup is not interpreted', async () => {
    const { channelSends, client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    await cb(outbound({ chat: CHANNEL_KEY, text: MARKUP_TEXT }))

    expect(channelSends).toEqual([
      {
        teamId: 'team-guid',
        channelId: '19:abc@thread.tacv2',
        content: MARKUP_TEXT,
        rootMessageId: undefined,
        format: 'text',
      },
    ])
  })

  test('rejects an undecodable routing key', async () => {
    const { client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    expect(await cb(outbound({ chat: 'bogus/key' }))).toEqual({
      ok: false,
      error: 'unsupported Teams conversation id: bogus/key',
    })
  })

  test('rejects an empty message', async () => {
    const { client } = fakeClient()
    const cb = createOutboundCallback({ client, logger: logger() })

    expect(await cb(outbound({ text: '' }))).toEqual({ ok: false, error: 'message has no text' })
  })

  test('surfaces a send failure as ok false', async () => {
    const { client } = fakeClient({
      sendChatMessage: async () => {
        throw new Error('send boom')
      },
    })
    const cb = createOutboundCallback({ client, logger: logger() })

    await expect(cb(outbound({ text: 'hi' }))).resolves.toEqual({ ok: false, error: 'send boom' })
  })

  test('reserves the echo before sending and does not roll it back on success', async () => {
    const rollbacks: number[] = []
    let rolledBack = 0
    const { client } = fakeClient()
    const cb = createOutboundCallback({
      client,
      logger: logger(),
      reserveEcho: (chatId, text) => {
        rollbacks.push(1)
        expect({ chatId, text }).toEqual({ chatId: 'chat-1', text: 'hi there' })
        return () => {
          rolledBack++
        }
      },
    })

    await cb(outbound({ text: 'hi there' }))

    expect(rollbacks).toHaveLength(1)
    expect(rolledBack).toBe(0)
  })

  test('rolls back the reserved echo when the send throws', async () => {
    let rolledBack = 0
    const { client } = fakeClient({
      sendChatMessage: async () => {
        throw new Error('send boom')
      },
    })
    const cb = createOutboundCallback({
      client,
      logger: logger(),
      reserveEcho: () => () => {
        rolledBack++
      },
    })

    await cb(outbound({ text: 'hi there' }))

    expect(rolledBack).toBe(1)
  })
})

describe('teams history', () => {
  test('maps chat messages to chronological history', async () => {
    const { client } = fakeClient({
      getChatMessages: async () => [
        teamsMessage({ id: 'newer', content: 'reply' }),
        teamsMessage({ id: 'older', content: 'question' }),
      ],
    })
    const cb = createTeamsHistoryCallback({ client, logger: logger(), selfIdRef: () => 'ME' })

    const res = await cb({ chat: 'chat:chat-1', thread: null, limit: 50 })

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok history')
    expect(res.messages.map((m) => m.externalMessageId)).toEqual(['older', 'newer'])
  })

  test('fetches channel history via getMessages(teamId, channelId)', async () => {
    const calls: Array<{ teamId: string; channelId: string }> = []
    const { client } = fakeClient({
      getMessages: async (teamId, channelId) => {
        calls.push({ teamId, channelId })
        return [teamsMessage({ id: 'ch-msg' })]
      },
    })
    const cb = createTeamsHistoryCallback({ client, logger: logger(), selfIdRef: () => 'ME' })

    const res = await cb({ chat: CHANNEL_KEY, thread: null, limit: 50 })

    expect(res.ok).toBe(true)
    expect(calls).toEqual([{ teamId: 'team-guid', channelId: '19:abc@thread.tacv2' }])
  })

  test('rejects an undecodable routing key', async () => {
    const { client } = fakeClient()
    const cb = createTeamsHistoryCallback({ client, logger: logger(), selfIdRef: () => null })

    expect(await cb({ chat: 'bogus', thread: null, limit: 50 })).toEqual({
      ok: false,
      error: 'unsupported Teams conversation id: bogus',
    })
  })
})

describe('createTeamsAdapter', () => {
  test('start logs in with the account token and wires router callbacks', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await adapter.start()

    expect(adapter.isConnected()).toBe(true)
    expect(r.registered).toEqual(['outbound:teams', 'self:teams', 'history:teams', 'edit:teams'])

    await adapter.stop()
  })

  test('missing account throws the documented error', async () => {
    const adapter = adapterWith({
      r: router(),
      listener: new FakeListener(),
      client: fakeClient().client,
      store: { getAccount: async () => null },
    })

    await expect(adapter.start()).rejects.toThrow('no Teams account in secrets.json#channels.teams')
  })

  test('a realtime group message that matches an alias routes', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({ r, listener, client: fakeClient().client, aliases: ['typeclaw'] })

    await adapter.start()
    listener.emit('message', realtime())
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.adapter).toBe('teams')
    expect(r.routed[0]?.chat).toBe('chat:chat-1')
    expect(r.routed[0]?.isBotMention).toBe(true)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:teams')
  })

  test('drops an inbound that echoes a message the agent just sent (content-only window)', async () => {
    const r = router()
    const listener = new FakeListener()
    let clock = 1_000
    const adapter = adapterWith({ r, listener, client: fakeClient().client, now: () => clock })

    await adapter.start()
    // given the agent sends "on it" through its own registered outbound callback
    expect(r.outboundCb).not.toBeNull()
    await r.outboundCb!(outbound({ text: 'on it' }))
    // when that exact text echoes back 1s later from an author we cannot prove is self
    clock += 1_000
    listener.emit(
      'message',
      realtime({ id: 'echo-1', content: 'on it', author: { id: 'user-1', displayName: 'Alice' } }),
    )
    await adapter.stop()

    // then the recent-send fingerprint drops it inside the 5s content-only window
    expect(r.routed).toHaveLength(0)
  })

  test('does not drop a repeat of the agent text once the content-only window has passed', async () => {
    const r = router()
    const listener = new FakeListener()
    let clock = 1_000
    const adapter = adapterWith({ r, listener, client: fakeClient().client, now: () => clock })

    await adapter.start()
    await r.outboundCb!(outbound({ text: 'on it' }))
    // 6s later a human genuinely typing the same short phrase is NOT an echo
    clock += 6_000
    listener.emit(
      'message',
      realtime({ id: 'human-1', content: 'on it', author: { id: 'user-1', displayName: 'Alice' } }),
    )
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
  })

  test('drops a self-name-authored echo across the full echo TTL', async () => {
    const r = router()
    const listener = new FakeListener()
    let clock = 1_000
    const adapter = adapterWith({ r, listener, client: fakeClient().client, now: () => clock })

    await adapter.start()
    await r.outboundCb!(outbound({ text: 'status update' }))
    // 30s later (past the content-only window) an author whose display name IS
    // the bot's name echoes the text back → still suppressed
    clock += 30_000
    listener.emit(
      'message',
      realtime({ id: 'echo-2', content: 'status update', author: { id: 'x', displayName: 'Typeey' } }),
    )
    await adapter.stop()

    expect(r.routed).toHaveLength(0)
  })

  test('a DM without any alias still engages', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({
      r,
      listener,
      client: fakeClient({ chats: [{ id: 'chat-1', type: 'oneOnOne' } as TeamsChatInfo] }).client,
    })

    await adapter.start()
    listener.emit('message', realtime({ content: 'no alias here' }))
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.isDm).toBe(true)
    expect(r.routed[0]?.mentionsOthers).toBe(false)
  })

  test('refreshes chats once when a realtime chatId is unknown, then routes', async () => {
    const r = router()
    const listener = new FakeListener()
    let listChatsCalls = 0
    const { client } = fakeClient({
      chats: [],
      getChatMessages: async () => [],
    })
    // first listChats (start) returns nothing; the on-miss refresh discovers the chat
    client.listChats = async () => {
      listChatsCalls++
      return listChatsCalls === 1 ? [] : [{ id: 'chat-9', type: 'oneOnOne' } as TeamsChatInfo]
    }
    const adapter = adapterWith({ r, listener, client })

    await adapter.start()
    listener.emit('message', realtime({ chatId: 'chat-9' }))
    await adapter.stop()

    expect(listChatsCalls).toBe(2)
    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.chat).toBe('chat:chat-9')
  })

  test('reports unhealthy while realtime is disconnected and recovers when it reconnects', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    listener.emit('disconnected', undefined)
    expect(adapter.isConnected()).toBe(false)

    listener.emit('connected', { endpointId: 'ep-2' })
    expect(adapter.isConnected()).toBe(true)

    await adapter.stop()
  })

  test('degrades to REST-only when the id_token becomes unmintable after a successful connect', async () => {
    const r = router()
    const listener = new FakeListener()
    const log = logger()
    const { client, sends } = fakeClient()
    const adapter = adapterWith({ r, listener, client, log })

    // given the listener connected fine at start
    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    const errorsBefore = log.lines.filter((l) => l.startsWith('error:')).length

    // when a later reconnect can no longer mint the id_token (expired refresh
    // token, outage): the SDK re-emits the same no_id_token error on every retry
    listener.emit('error', new TeamsError('no id_token', 'no_id_token'))
    listener.emit('error', new TeamsError('no id_token', 'no_id_token'))

    // then the listener is torn down (stopping the SDK's unbounded reconnect
    // loop) and no error lines are logged — it degrades to REST-only instead
    expect(listener.stopped).toBe(true)
    expect(log.lines.filter((l) => l.startsWith('error:')).length).toBe(errorsBefore)
    expect(log.lines.some((l) => l.includes('continuing REST-only'))).toBe(true)
    // REST send/read remain registered, but realtime health is reported truthfully
    expect(adapter.isConnected()).toBe(false)
    expect(r.unregistered).toEqual([])
    await r.outboundCb!(outbound({ text: 'still available' }))
    expect(sends).toEqual([{ chatId: 'chat-1', content: 'still available', format: 'text' }])

    await adapter.stop()
  })

  test('keeps the listener alive on a transient error so the SDK can reconnect', async () => {
    const r = router()
    const listener = new FakeListener()
    const log = logger()
    const adapter = adapterWith({ r, listener, client: fakeClient().client, log })

    await adapter.start()
    // a transient socket error is NOT the unrecoverable id_token failure, so the
    // adapter leaves the listener running for the SDK's own reconnect to recover
    listener.emit('error', new Error('websocket hiccup'))

    expect(listener.stopped).toBe(false)
    expect(log.lines.some((l) => l.startsWith('error:') && l.includes('websocket hiccup'))).toBe(true)

    await adapter.stop()
  })

  test('is not usable after stop', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
    // a late event from the stopped listener must not resurrect usable state
    listener.emit('connected', { endpointId: 'ep-stale' })
    expect(adapter.isConnected()).toBe(false)
  })

  test('degrades to REST-only when the listener errors before connecting', async () => {
    const r = router()
    const listener = new FakeListener()
    listener.startImpl = async () => {
      queueMicrotask(() => listener.emit('error', new Error('trouter down')))
    }
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    // start() resolves (does not throw): REST send/read remain usable
    await adapter.start()
    expect(adapter.isConnected()).toBe(false)
    // the REST callbacks stay registered — only the listener is torn down
    expect(r.registered).toEqual(['outbound:teams', 'self:teams', 'history:teams', 'edit:teams'])
    expect(r.unregistered).toEqual([])
    expect(listener.stopped).toBe(true)

    await adapter.stop()
  })

  test('degrades to REST-only when a listener error arrives after start() resolves', async () => {
    const r = router()
    const listener = new FakeListener()
    // start() resolves without connecting; the error lands on the next tick,
    // so the adapter must be awaiting the connected/error race (not sampling a
    // flag synchronously) to observe it before degrading.
    listener.startImpl = async () => {
      queueMicrotask(() => listener.emit('error', new Error('late trouter failure')))
    }
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await adapter.start()
    expect(adapter.isConnected()).toBe(false)
    expect(r.unregistered).toEqual([])
    expect(listener.stopped).toBe(true)

    await adapter.stop()
  })

  test('degrades to REST-only when listener.start() rejects synchronously', async () => {
    const r = router()
    const listener = new FakeListener()
    // start() rejects itself and never emits a `connected`/`error` event, so
    // the adapter must cancel the connected-wait in the rejection path (not
    // hang for the full 20s timeout) and still degrade cleanly.
    listener.startImpl = async () => {
      throw new Error('start rejected')
    }
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await adapter.start()
    expect(adapter.isConnected()).toBe(false)
    expect(r.unregistered).toEqual([])
    expect(listener.stopped).toBe(true)

    await adapter.stop()
  })

  test('suppresses an echo delivered before the send promise resolves', async () => {
    const r = router()
    const listener = new FakeListener()
    // Hold sendChatMessage open so the echo lands while the send is in flight —
    // the fingerprint must already be reserved (before the await), or the
    // agent's own message routes back in.
    const release = Promise.withResolvers<TeamsMessage>()
    const adapter = adapterWith({
      r,
      listener,
      client: fakeClient({ sendChatMessage: () => release.promise }).client,
    })

    await adapter.start()
    const sendResult = r.outboundCb!(outbound({ text: 'working on it' }))
    listener.emit('message', realtime({ id: 'echo-live', content: 'working on it' }))
    release.resolve(teamsMessage({ id: 'sent' }))
    await sendResult
    await adapter.stop()

    expect(r.routed).toHaveLength(0)
  })

  test('routes a normal message even if a concurrent send is rolled back on failure', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({
      r,
      listener,
      client: fakeClient({
        sendChatMessage: async () => {
          throw new Error('send failed')
        },
      }).client,
    })

    await adapter.start()
    // A failed send rolls back its reservation, so an unrelated human message
    // with the same text is NOT wrongly suppressed.
    await r.outboundCb!(outbound({ text: 'hello there' }))
    listener.emit('message', realtime({ id: 'human', content: 'hello there' }))
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
  })

  test('routes a channel message addressed by a structured mention', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = adapterWith({ r, listener, client: fakeClient().client })

    await adapter.start()
    listener.emit(
      'message',
      channelRealtime({ content: 'ship it', mentions: [{ id: '0', displayName: 'Typeey', mri: '8:orgid:self' }] }),
    )
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.chat).toBe(CHANNEL_KEY)
    expect(r.routed[0]?.isDm).toBe(false)
    expect(r.routed[0]?.isBotMention).toBe(true)
  })

  test('suppresses a channel self-echo keyed by channelId', async () => {
    const r = router()
    const listener = new FakeListener()
    let clock = 1_000
    const adapter = adapterWith({ r, listener, client: fakeClient().client, now: () => clock })

    await adapter.start()
    await r.outboundCb!(outbound({ chat: CHANNEL_KEY, text: 'deploy done' }))
    clock += 1_000
    listener.emit('message', channelRealtime({ id: 'ch-echo', content: 'deploy done' }))
    await adapter.stop()

    expect(r.routed).toHaveLength(0)
  })
})
