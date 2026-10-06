import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AttachmentInput,
  KakaoChat,
  KakaoMarkReadResult,
  KakaoMember,
  KakaoMessage,
  KakaoProfile,
  KakaoReplyTarget,
  KakaoSendResult,
  KakaoTalkListenerEventMap,
  KakaoTalkPushMessageEvent,
  KakaoTypingResult,
} from 'agent-messenger/kakaotalk'

import { createChannelRouter as createRealChannelRouter, type ChannelRouter } from '@/channels/router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { TypingCallback } from '@/channels/types'

import {
  createKakaotalkAdapter,
  createOutboundCallback,
  type KakaoTalkClient,
  type KakaoTalkListener,
} from './kakaotalk'

type EventKey = keyof KakaoTalkListenerEventMap

class FakeListener implements KakaoTalkListener {
  startThrows: Error | null = null
  startCalls = 0
  stopCalls = 0
  private handlers: Partial<Record<EventKey, Array<(...args: never[]) => void>>> = {}

  async start(): Promise<void> {
    this.startCalls++
    if (this.startThrows !== null) throw this.startThrows
  }

  stop(): void {
    this.stopCalls++
  }

  on<K extends EventKey>(event: K, listener: (...args: KakaoTalkListenerEventMap[K]) => void): this {
    const list = (this.handlers[event] ?? []) as Array<(...args: never[]) => void>
    list.push(listener as (...args: never[]) => void)
    this.handlers[event] = list
    return this
  }

  off<K extends EventKey>(event: K, listener: (...args: KakaoTalkListenerEventMap[K]) => void): this {
    const list = this.handlers[event]
    if (list) {
      const idx = list.indexOf(listener as (...args: never[]) => void)
      if (idx !== -1) list.splice(idx, 1)
    }
    return this
  }

  emit<K extends EventKey>(event: K, ...args: KakaoTalkListenerEventMap[K]): void {
    const list = this.handlers[event] ?? []
    for (const fn of list) (fn as (...args: KakaoTalkListenerEventMap[K]) => void)(...args)
  }
}

function isAttachmentInputArray(
  x: Uint8Array | Buffer | ReadonlyArray<AttachmentInput>,
): x is ReadonlyArray<AttachmentInput> {
  return Array.isArray(x)
}

class FakeClient implements KakaoTalkClient {
  loginCalls = 0
  sendMessageCalls: Array<{ chatId: string; text: string; replyTo?: KakaoReplyTarget }> = []
  getMessagesCalls: Array<{ chatId: string; opts?: { count?: number; from?: string } }> = []
  getMessagesResult: KakaoMessage[] = []
  getMessagesError: Error | null = null
  getMembersCalls: string[] = []
  closed = false
  profileResult: KakaoProfile = {
    user_id: '999',
    nickname: 'Self',
    profile_image_url: null,
    original_profile_image_url: null,
    status_message: null,
    account_display_id: null,
  }
  chats: KakaoChat[] = []
  membersByChat: Map<string, KakaoMember[]> = new Map()
  inlineNamesByChat: Map<string, Map<number, string>> = new Map()
  getMembersError: Error | null = null
  sendResult: KakaoSendResult = { success: true, status_code: 0, chat_id: '111', log_id: 'L1', sent_at: 0 }
  markReadCalls: Array<{ chatId: string; logId: string; opts?: { linkId?: string } }> = []
  markReadResult: KakaoMarkReadResult = { success: true, status_code: 0, chat_id: '111', watermark: 'L1' }
  markReadError: Error | null = null

  async login(): Promise<this> {
    this.loginCalls++
    return this
  }

  async getChats(): Promise<KakaoChat[]> {
    return this.chats
  }

  async getMessages(chatId: string, opts?: { count?: number; from?: string }): Promise<KakaoMessage[]> {
    this.getMessagesCalls.push({ chatId, ...(opts !== undefined ? { opts } : {}) })
    if (this.getMessagesError !== null) throw this.getMessagesError
    return this.getMessagesResult
  }

  async sendMessage(chatId: string, text: string, options?: { replyTo?: KakaoReplyTarget }): Promise<KakaoSendResult> {
    this.sendMessageCalls.push({
      chatId,
      text,
      ...(options?.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
    })
    return this.sendResult
  }

  sendAttachmentCalls: Array<
    | { kind: 'single'; chatId: string; data: Uint8Array | Buffer; filename: string; mimeType?: string }
    | { kind: 'array'; chatId: string; attachments: ReadonlyArray<AttachmentInput> }
  > = []
  attachmentResult: KakaoSendResult = { success: true, status_code: 0, chat_id: '111', log_id: 'L-att', sent_at: 0 }

  sendAttachment(
    chatId: string,
    data: Uint8Array | Buffer,
    filename: string,
    mimeType?: string,
  ): Promise<KakaoSendResult>
  sendAttachment(chatId: string, attachments: ReadonlyArray<AttachmentInput>): Promise<KakaoSendResult>
  async sendAttachment(
    chatId: string,
    dataOrAttachments: Uint8Array | Buffer | ReadonlyArray<AttachmentInput>,
    filename?: string,
    mimeType?: string,
  ): Promise<KakaoSendResult> {
    if (isAttachmentInputArray(dataOrAttachments)) {
      this.sendAttachmentCalls.push({ kind: 'array', chatId, attachments: dataOrAttachments })
    } else {
      this.sendAttachmentCalls.push({
        kind: 'single',
        chatId,
        data: dataOrAttachments,
        filename: filename!,
        ...(mimeType !== undefined ? { mimeType } : {}),
      })
    }
    return this.attachmentResult
  }

  async markRead(chatId: string, logId: string, opts?: { linkId?: string }): Promise<KakaoMarkReadResult> {
    this.markReadCalls.push({ chatId, logId, ...(opts !== undefined ? { opts } : {}) })
    if (this.markReadError !== null) throw this.markReadError
    return this.markReadResult
  }

  sendTypingCalls: Array<{ chatId: string; opts?: { linkId?: string } }> = []
  sendTypingResult: KakaoTypingResult = { success: true, status_code: 0, chat_id: '111' }
  sendTypingError: Error | null = null
  sendTypingGate: Promise<void> | null = null
  async sendTyping(chatId: string, opts?: { linkId?: string }): Promise<KakaoTypingResult> {
    if (this.sendTypingGate !== null) await this.sendTypingGate
    this.sendTypingCalls.push({ chatId, ...(opts !== undefined ? { opts } : {}) })
    if (this.sendTypingError !== null) throw this.sendTypingError
    return this.sendTypingResult
  }

  profileError: Error | null = null
  async getProfile(): Promise<KakaoProfile> {
    if (this.profileError !== null) throw this.profileError
    return this.profileResult
  }

  async getMembers(chatId: string): Promise<KakaoMember[]> {
    this.getMembersCalls.push(chatId)
    if (this.getMembersError !== null) throw this.getMembersError
    return this.membersByChat.get(chatId) ?? []
  }

  lookupAuthorName(chatId: string, authorId: number): string | null {
    return this.inlineNamesByChat.get(chatId)?.get(authorId) ?? null
  }

  close(): void {
    this.closed = true
  }
}

const adapterCfg = (over: Partial<ChannelAdapterConfig> = {}): ChannelAdapterConfig => ({
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
  ...over,
})

let agentDir: string
const routers: ChannelRouter[] = []

function createChannelRouter(options: Parameters<typeof createRealChannelRouter>[0]): ChannelRouter {
  const router = createRealChannelRouter(options)
  routers.push(router)
  return router
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-adapter-'))
})

afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.stop()))
  await rm(agentDir, { recursive: true, force: true })
})

describe('createKakaotalkAdapter — start/stop lifecycle', () => {
  test('login + getProfile + listener.start are called in order', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })

    await adapter.start()

    expect(client.loginCalls).toBe(1)
    expect(listener.startCalls).toBe(1)
    expect(adapter.isConnected()).toBe(false)

    listener.emit('connected', { userId: '999' })
    expect(adapter.isConnected()).toBe(true)

    await adapter.stop()
    expect(listener.stopCalls).toBe(1)
    expect(client.closed).toBe(true)
    expect(adapter.isConnected()).toBe(false)

    await router.stop()
  })

  test('does NOT register router callbacks when listener.start() throws', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    listener.startThrows = new Error('socket refused')
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })

    await expect(adapter.start()).rejects.toThrow('socket refused')

    // The router should not hold any kakaotalk callbacks. Easiest way to
    // assert this without poking router internals: send an outbound
    // through the router and verify no callback fires (the send returns
    // an error rather than reaching our fake client).
    const send = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'hi',
    })
    expect(send.ok).toBe(false)
    expect(client.sendMessageCalls).toHaveLength(0)

    await router.stop()
  })

  test('start() failure tears down the half-wired listener defensively so handlers do not leak', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    listener.startThrows = new Error('boom')
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })

    await expect(adapter.start()).rejects.toThrow()
    expect(listener.stopCalls).toBe(1)

    await adapter.stop()
    expect(listener.stopCalls).toBe(1)

    await router.stop()
  })

  test('throws a classified error when getProfile() returns 401 (stale sub-device token)', async () => {
    const client = new FakeClient()
    client.profileError = new Error('Profile request failed: 401')
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })

    await expect(adapter.start()).rejects.toThrow(/sub-device session is stale/)
    await expect(adapter.start()).rejects.toThrow(/typeclaw channel reauth kakaotalk/)

    await router.stop()
  })

  test('re-throws an unclassified getProfile error verbatim (no 401-specific message)', async () => {
    const client = new FakeClient()
    client.profileError = new Error('Profile request failed: 503')
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })

    await expect(adapter.start()).rejects.toThrow(/Profile request failed: 503/)
    await expect(adapter.start()).rejects.not.toThrow(/sub-device session is stale/)

    await router.stop()
  })

  test('registers a stateless typing callback + 4s heartbeat on start, routes a tick to client.sendTyping, and unregisters + disables on stop', async () => {
    const client = new FakeClient()
    // Seed the two chats as authoritative group chats so the resolver classifies
    // them as `send` (typing consults it live via classifyChat). A chat absent
    // from getChats is registered provisionally and still sends — see the
    // dedicated getChats-omitted regression test below.
    const groupChat = (id: string): KakaoChat => ({
      chat_id: id,
      type: 10,
      display_name: 'Team',
      title: null,
      active_members: 4,
      unread_count: 0,
      last_message: null,
    })
    client.chats = [groupChat('111'), groupChat('222')]
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })

    // Spy on the real router's typing wiring: capture the registered callback,
    // the capability toggles, and the heartbeat-interval override so we can
    // drive a tick through the exact callback the adapter handed the router and
    // assert teardown ordering.
    const events: string[] = []
    let registeredTyping: TypingCallback | null = null
    let heartbeatInterval = -1
    const realRegisterTyping = router.registerTyping.bind(router)
    const realUnregisterTyping = router.unregisterTyping.bind(router)
    const realSetTypingCapability = router.setTypingCapability.bind(router)
    const realSetTypingHeartbeatInterval = router.setTypingHeartbeatInterval.bind(router)
    router.registerTyping = (adapter, cb) => {
      if (adapter === 'kakaotalk') registeredTyping = cb
      events.push(`register:${adapter}`)
      return realRegisterTyping(adapter, cb)
    }
    router.unregisterTyping = (adapter, cb) => {
      events.push(`unregister:${adapter}`)
      return realUnregisterTyping(adapter, cb)
    }
    router.setTypingCapability = (adapter, supported) => {
      events.push(`cap:${adapter}=${String(supported)}`)
      return realSetTypingCapability(adapter, supported)
    }
    router.setTypingHeartbeatInterval = (adapter, intervalMs) => {
      if (adapter === 'kakaotalk') heartbeatInterval = intervalMs
      return realSetTypingHeartbeatInterval(adapter, intervalMs)
    }

    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    expect(registeredTyping).not.toBeNull()
    expect(events).toContain('register:kakaotalk')
    expect(events).toContain('cap:kakaotalk=true')
    // The adapter must register a heartbeat below the ~5s expiry so the router
    // paces the refresh with margin against scheduler/network jitter.
    expect(heartbeatInterval).toBe(4000)

    // A tick reaches client.sendTyping; the callback holds no timer of its own.
    await registeredTyping!({
      adapter: 'kakaotalk',
      workspace: '@kakao-group',
      chat: '111',
      thread: null,
      phase: 'tick',
    })
    expect(client.sendTypingCalls).toEqual([{ chatId: '111' }])

    // Prove adapter.stop() invalidates queued typing work (via typing.reset()),
    // driving the exact callback the router holds: block tick 1 mid-send, queue
    // tick 2 behind it, stop the adapter, then release tick 1. Only the
    // in-flight tick 1 may reach the client; the queued tick 2 must be dropped.
    let releaseBlocked: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseBlocked = resolve
    })
    client.sendTypingGate = gate
    const blockedChat = '222'
    const firstTick = registeredTyping!({
      adapter: 'kakaotalk',
      workspace: '@kakao-group',
      chat: blockedChat,
      thread: null,
      phase: 'tick',
    })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const beforeQueued = client.sendTypingCalls.length
    const secondTick = registeredTyping!({
      adapter: 'kakaotalk',
      workspace: '@kakao-group',
      chat: blockedChat,
      thread: null,
      phase: 'tick',
    })

    await adapter.stop()

    expect(events).toContain('unregister:kakaotalk')
    expect(events).toContain('cap:kakaotalk=false')

    releaseBlocked?.()
    await Promise.all([firstTick, secondTick])
    for (let i = 0; i < 5; i++) await Promise.resolve()
    // Exactly one more packet (the in-flight tick 1); tick 2 was dropped by the
    // generation reset adapter.stop() performed.
    expect(client.sendTypingCalls.length).toBe(beforeQueued + 1)

    await router.stop()
  })

  test('sends typing for a chat getChats omits (provisional @kakao-group) — the inbound push proves it is real', async () => {
    // Regression: a stale sub-device session returns a partial getChats list that
    // omits an active chat, so an inbound push registers it provisionally as
    // @kakao-group. Suppressing typing for provisional entries disabled the
    // indicator for the entire lifetime of exactly the chats a user is actively
    // messaging (observed in 0.45.1). The provisional bucket is @kakao-group
    // (never @kakao-open), and a provisional-that-is-actually-OpenChat fails soft,
    // so typing must send.
    const client = new FakeClient()
    client.chats = [] // getChats omits the chat entirely
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })

    let registeredTyping: TypingCallback | null = null
    const realRegisterTyping = router.registerTyping.bind(router)
    router.registerTyping = (adapter, cb) => {
      if (adapter === 'kakaotalk') registeredTyping = cb
      return realRegisterTyping(adapter, cb)
    }

    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    // An inbound push from a chat the adapter can't resolve via getChats registers
    // it provisionally as @kakao-group (the real production path).
    listener.emit('message', {
      type: 'MSG',
      chat_id: '888',
      log_id: 'L1',
      author_id: 222,
      author_name: 'Someone',
      message: 'hi',
      message_type: 1,
      attachment: null,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    await registeredTyping!({
      adapter: 'kakaotalk',
      workspace: '@kakao-group',
      chat: '888',
      thread: null,
      phase: 'tick',
    })
    expect(client.sendTypingCalls).toEqual([{ chatId: '888' }])

    await adapter.stop()
    await router.stop()
  })
})

describe('createKakaotalkAdapter — outbound', () => {
  test('returns ok:true and forwards text when no attachments', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    const result = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'hello',
    })
    expect(result).toEqual({ ok: true, messageId: 'L1', messageIds: ['L1'] })
    expect(client.sendMessageCalls).toEqual([{ chatId: '111', text: 'hello' }])

    await adapter.stop()
    await router.stop()
  })

  test('strips Markdown formatting before sending (KakaoTalk has no rich text)', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    const result = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'Fixed\n1. **JSON leak** — `formatAuthorLine` added',
    })
    expect(result.ok).toBe(true)
    expect(client.sendMessageCalls).toEqual([{ chatId: '111', text: 'Fixed\n1. JSON leak — formatAuthorLine added' }])

    await adapter.stop()
    await router.stop()
  })

  test('uploads attachments via sendAttachment when present (no text)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kakao-att-'))
    const filepath = join(dir, 'photo.jpg')
    await writeFile(filepath, Buffer.from('fake-image-bytes'))

    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()

    const result = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      attachments: [{ path: filepath }],
    })
    expect(result.ok).toBe(true)
    expect(client.sendMessageCalls).toHaveLength(0)
    expect(client.sendAttachmentCalls).toHaveLength(1)
    const call = client.sendAttachmentCalls[0]!
    expect(call.kind).toBe('array')
    if (call.kind !== 'array') return
    expect(call.chatId).toBe('111')
    expect(call.attachments).toHaveLength(1)
    expect(call.attachments[0]!.filename).toBe('photo.jpg')

    await adapter.stop()
    await router.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('uploads files first, then posts text when both are provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kakao-att-'))
    const filepath = join(dir, 'spec.pdf')
    await writeFile(filepath, Buffer.from('fake-pdf'))

    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()

    const result = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '222',
      text: 'see attached',
      attachments: [{ path: filepath, filename: 'specification.pdf' }],
    })
    expect(result.ok).toBe(true)
    expect(client.sendAttachmentCalls).toHaveLength(1)
    expect(client.sendMessageCalls).toEqual([{ chatId: '222', text: 'see attached' }])
    const call = client.sendAttachmentCalls[0]!
    expect(call.kind).toBe('array')
    if (call.kind !== 'array') return
    expect(call.attachments[0]!.filename).toBe('specification.pdf')

    await adapter.stop()
    await router.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('returns ok:false when the attachment file is missing (does not silently drop)', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    await adapter.start()

    const result = await router.send({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'hi',
      attachments: [{ path: '/nonexistent/path/photo.jpg' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('readFile failed')
    expect(client.sendMessageCalls).toHaveLength(0)
    expect(client.sendAttachmentCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })
})

describe('createOutboundCallback — native reply', () => {
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }
  const formatChannelTag = async () => 'tag'
  const kakaoMessage = (over: Partial<KakaoMessage>): KakaoMessage => ({
    log_id: 'L0',
    type: 1,
    author_id: 0,
    author_name: null,
    message: '',
    attachment: null,
    sent_at: 0,
    ...over,
  })
  const replySource = { adapter: 'kakaotalk' as const, authorId: '7', authorName: 'Alice', text: 'original?' }

  test('resolves the reply target from history and sends a native reply (no blockquote)', async () => {
    const client = new FakeClient()
    client.getMessagesResult = [
      kakaoMessage({ log_id: '500', author_id: 7, message: 'original?', type: 1 }),
      kakaoMessage({ log_id: '501', author_id: 3, message: 'noise', type: 1 }),
    ]
    const cb = createOutboundCallback({ client, logger: noopLogger, formatChannelTag })

    const result = await cb({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'replying',
      replyTo: { externalMessageId: '500', source: replySource },
    })

    expect(result.ok).toBe(true)
    expect(client.getMessagesCalls).toEqual([{ chatId: '111', opts: { count: 100 } }])
    expect(client.sendMessageCalls).toEqual([
      { chatId: '111', text: 'replying', replyTo: { log_id: '500', author_id: 7, message: 'original?', type: 1 } },
    ])
  })

  test('mirrors the source message type into the reply target (non-text source)', async () => {
    const client = new FakeClient()
    client.getMessagesResult = [kakaoMessage({ log_id: '500', author_id: 7, message: 'photo', type: 2 })]
    const cb = createOutboundCallback({ client, logger: noopLogger, formatChannelTag })

    await cb({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'nice pic',
      replyTo: { externalMessageId: '500', source: replySource },
    })

    expect(client.sendMessageCalls[0]?.replyTo?.type).toBe(2)
  })

  test('degrades to a blockquote fallback when the target is not in recent history', async () => {
    const client = new FakeClient()
    client.getMessagesResult = [kakaoMessage({ log_id: '999', message: 'someone else' })]
    const cb = createOutboundCallback({ client, logger: noopLogger, formatChannelTag })

    const result = await cb({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'replying',
      replyTo: { externalMessageId: '500', source: replySource },
    })

    expect(result.ok).toBe(true)
    expect(client.sendMessageCalls).toHaveLength(1)
    const call = client.sendMessageCalls[0]!
    expect(call.replyTo).toBeUndefined()
    expect(call.text).toContain('> Alice: original?')
    expect(call.text).toContain('replying')
  })

  test('degrades to a blockquote fallback when the history fetch throws', async () => {
    const client = new FakeClient()
    client.getMessagesError = new Error('network down')
    const cb = createOutboundCallback({ client, logger: noopLogger, formatChannelTag })

    const result = await cb({
      adapter: 'kakaotalk',
      workspace: '@kakao-dm',
      chat: '111',
      text: 'replying',
      replyTo: { externalMessageId: '500', source: replySource },
    })

    expect(result.ok).toBe(true)
    expect(client.sendMessageCalls[0]?.replyTo).toBeUndefined()
    expect(client.sendMessageCalls[0]?.text).toContain('> Alice: original?')
  })

  test('sends plainly when there is no replyTo (no history lookup)', async () => {
    const client = new FakeClient()
    const cb = createOutboundCallback({ client, logger: noopLogger, formatChannelTag })

    await cb({ adapter: 'kakaotalk', workspace: '@kakao-dm', chat: '111', text: 'hello' })

    expect(client.getMessagesCalls).toHaveLength(0)
    expect(client.sendMessageCalls).toEqual([{ chatId: '111', text: 'hello' }])
  })
})

describe('createKakaotalkAdapter — KICKOUT recovery', () => {
  type ScheduledTask = { fn: () => void; delay: number }
  type RecoveryHarness = {
    listener: FakeListener
    adapter: ReturnType<typeof createKakaotalkAdapter>
    router: ReturnType<typeof createChannelRouter>
    logs: Array<{ level: string; msg: string }>
    tasks: ScheduledTask[]
    advance: (ms: number) => void
    nowMs: () => number
  }

  const buildHarness = (agentDirArg: string): RecoveryHarness => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir: agentDirArg, configForAdapter: () => adapterCfg() })
    const logs: Array<{ level: string; msg: string }> = []
    const tasks: ScheduledTask[] = []
    let nowMs = 1_000_000
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
      logger: {
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'error', msg }),
      },
      now: () => nowMs,
      scheduleRecovery: (fn, delay) => {
        tasks.push({ fn, delay })
      },
    })
    return {
      listener,
      adapter,
      router,
      logs,
      tasks,
      advance: (ms) => {
        nowMs += ms
      },
      nowMs: () => nowMs,
    }
  }

  test('starts a recovery episode on a KICKOUT inside the post-init window and reconnects with the first delay', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    expect(h.listener.startCalls).toBe(1)

    h.listener.emit('connected', { userId: '999' })
    expect(h.adapter.isConnected()).toBe(true)

    h.advance(5_000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))

    expect(h.adapter.isConnected()).toBe(false)
    const reconnect = h.tasks.find((t) => t.delay === 2_000)
    expect(reconnect).toBeDefined()
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('attempt 1/3'))).toBe(true)

    reconnect?.fn()
    expect(h.listener.startCalls).toBe(2)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('survives ghost-session ping-pong by retrying with growing delays before giving up', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })

    const kick = (): void => h.listener.emit('error', new Error('Session kicked — another device logged in'))

    const expectedDelays = [2_000, 10_000, 60_000] as const
    for (const [i, delay] of expectedDelays.entries()) {
      h.advance(1_000)
      kick()
      const reconnect = h.tasks.at(-1)
      expect(reconnect?.delay).toBe(delay)
      h.advance(delay)
      reconnect?.fn()
      expect(h.listener.startCalls).toBe(i + 2)
      h.listener.emit('connected', { userId: '999' })
    }

    h.advance(1_000)
    kick()
    expect(h.listener.startCalls).toBe(expectedDelays.length + 1)
    expect(
      h.logs.some(
        (l) =>
          l.level === 'error' &&
          l.msg.includes('DEAD after KICKOUT') &&
          (l.msg.includes('attempt(s) exhausted') || l.msg.includes('budget exhausted')),
      ),
    ).toBe(true)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('gives up with budget-exhausted reason when stalled retries push past the wall-clock cap', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })

    const kick = (): void => h.listener.emit('error', new Error('Session kicked — another device logged in'))

    // Two quick KICKOUTs consume attempts 1 and 2 (delays 2_000 and
    // 10_000), then we sit at the recovered listener for ~4.5 minutes
    // before a third KICKOUT arrives. The third attempt's 60_000 delay
    // would push elapsed-in-episode past the 300_000 cap, so we should
    // give up via the budget branch rather than scheduling attempt 3.
    h.advance(1_000)
    kick()
    const reconnect1 = h.tasks.at(-1)
    h.advance(2_000)
    reconnect1?.fn()
    h.listener.emit('connected', { userId: '999' })

    h.advance(1_000)
    kick()
    const reconnect2 = h.tasks.at(-1)
    h.advance(10_000)
    reconnect2?.fn()
    h.listener.emit('connected', { userId: '999' })

    const tasksBeforeStallKick = h.tasks.length
    h.advance(4 * 60 * 1000 + 30_000)
    kick()

    expect(h.tasks.length).toBe(tasksBeforeStallKick)
    expect(h.logs.some((l) => l.level === 'error' && l.msg.includes('budget exhausted'))).toBe(true)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('a stable recovered connection ends the episode and re-arms recovery for a much-later KICKOUT', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })

    h.advance(5_000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))
    const reconnect = h.tasks.at(-1)
    expect(reconnect?.delay).toBe(2_000)
    h.advance(2_000)
    reconnect?.fn()
    expect(h.listener.startCalls).toBe(2)

    h.listener.emit('connected', { userId: '999' })
    const stabilityCheck = h.tasks.at(-1)
    expect(stabilityCheck?.delay).toBe(60_000)
    h.advance(60_000)
    stabilityCheck?.fn()

    expect(h.logs.some((l) => l.level === 'info' && l.msg.includes('recovery episode succeeded'))).toBe(true)

    const tasksBeforeFreshKick = h.tasks.length
    h.advance(10 * 60 * 1000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))
    const freshReconnect = h.tasks.at(-1)
    expect(h.tasks.length).toBe(tasksBeforeFreshKick + 1)
    expect(freshReconnect?.delay).toBe(2_000)
    const attemptOneLogs = h.logs.filter((l) => l.level === 'warn' && l.msg.includes('attempt 1/3'))
    expect(attemptOneLogs.length).toBe(2)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('a brief reconnect that gets kicked again does NOT count as episode success', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })

    h.advance(5_000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))
    const reconnect = h.tasks.at(-1)
    expect(reconnect?.delay).toBe(2_000)
    h.advance(2_000)
    reconnect?.fn()
    h.listener.emit('connected', { userId: '999' })
    const stabilityCheck = h.tasks.at(-1)
    expect(stabilityCheck?.delay).toBe(60_000)

    h.advance(1_000)
    h.listener.emit('error', new Error('Session kicked — another device logged in'))

    h.advance(60_000)
    stabilityCheck?.fn()
    expect(h.logs.some((l) => l.msg.includes('recovery episode succeeded'))).toBe(false)

    await h.adapter.stop()
    await h.router.stop()
  })

  test('non-KICKOUT errors do not start a recovery episode or flip connected', async () => {
    const h = buildHarness(agentDir)
    await h.adapter.start()
    h.listener.emit('connected', { userId: '999' })
    expect(h.adapter.isConnected()).toBe(true)

    h.listener.emit('error', new Error('socket closed unexpectedly'))

    expect(h.tasks).toHaveLength(0)
    expect(h.adapter.isConnected()).toBe(true)

    await h.adapter.stop()
    await h.router.stop()
  })
})

describe('createKakaotalkAdapter — author name resolution', () => {
  const groupChat = (id: string, members: number): KakaoChat => ({
    chat_id: id,
    type: 10,
    display_name: 'Team',
    title: null,
    active_members: members,
    unread_count: 0,
    last_message: null,
  })

  const buildMember = (user_id: string, nickname: string): KakaoMember => ({
    user_id,
    nickname,
    profile_image_url: null,
    full_profile_image_url: null,
    original_profile_image_url: null,
    status_message: null,
    country_iso: null,
    user_type: 100,
    open_token: null,
    open_profile_link_id: null,
    open_permission: null,
  })

  test('uses event.author_name (free PR #187 path) without firing GETMEM', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    // Intercept route so the engagement turn (and its membership GETMEM read)
    // never runs — this isolates the author-resolution path under test.
    const routed: { authorName: string }[] = []
    router.route = async (event) => {
      routed.push({ authorName: event.authorName })
      return { kind: 'accepted' as const, inputId: event.externalMessageId, generation: 0 }
    }
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [groupChat('111', 4)]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L42',
      author_id: 222,
      author_name: 'Alice',
      message: 'hello',
      message_type: 1,
      attachment: null,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(routed).toEqual([{ authorName: 'Alice' }])
    expect(client.getMembersCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })

  test('inbound log prefers author_name over the opaque author_id', async () => {
    const lines: string[] = []
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
      logger: { info: (m) => lines.push(m), warn: () => {}, error: () => {} },
    })
    client.chats = [groupChat('111', 4)]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L42',
      author_id: 222,
      author_name: 'Alice',
      message: 'hello',
      message_type: 1,
      attachment: null,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    const inboundLine = lines.find((l) => l.includes('inbound log_id='))
    expect(inboundLine).toContain('author=Alice')
    expect(inboundLine).not.toContain('author=222')

    await adapter.stop()
    await router.stop()
  })

  test('falls back to GETMEM when event.author_name is null', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [groupChat('111', 50)]
    client.membersByChat.set('111', [buildMember('222', 'Bob')])
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L77',
      author_id: 222,
      author_name: null,
      message: 'hi from a non-display member',
      message_type: 1,
      attachment: null,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    // Author resolution falls back to GETMEM for chat 111 (the membership
    // resolver also reads the roster on engagement, so assert containment
    // rather than an exact call list).
    expect(client.getMembersCalls).toContain('111')

    await adapter.stop()
    await router.stop()
  })

  test('does not fire GETMEM for self-author drops', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [groupChat('111', 50)]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L01',
      author_id: 999,
      author_name: null,
      message: 'self message',
      message_type: 1,
      attachment: null,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(client.getMembersCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })
})

describe('createKakaotalkAdapter — inbound attachments and emoticons', () => {
  // The integration tests below intercept router.route to capture the
  // synthesized InboundMessage payload the adapter actually routes. The
  // mutation check matters here: if a future refactor inlines
  // event.message back into the handler and drops splitInbound, the
  // markRead path keeps working but the agent stops seeing attachments —
  // these assertions are what would catch that regression.
  type RoutedInbound = Parameters<ChannelRouter['route']>[0]

  const setupCaptured = async (
    overrides: Partial<{ chatType: number; activeMembers: number }> = {},
  ): Promise<{
    client: FakeClient
    listener: FakeListener
    router: ChannelRouter
    adapter: ReturnType<typeof createKakaotalkAdapter>
    routed: RoutedInbound[]
    stop: () => Promise<void>
  }> => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const routed: RoutedInbound[] = []
    const originalRoute = router.route
    router.route = async (event) => {
      routed.push(event)
      return { kind: 'accepted' as const, inputId: event.externalMessageId, generation: 0 }
    }
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [
      {
        chat_id: '111',
        type: overrides.chatType ?? 0,
        display_name: 'Other',
        title: null,
        active_members: overrides.activeMembers ?? 2,
        unread_count: 0,
        last_message: null,
      },
    ]
    await adapter.start()
    listener.emit('connected', { userId: '999' })
    return {
      client,
      listener,
      router,
      adapter,
      routed,
      stop: async () => {
        await adapter.stop()
        router.route = originalRoute
        await router.stop()
      },
    }
  }

  test('routes a photo-with-caption with the attachment summary appended to the caption text', async () => {
    const ctx = await setupCaptured()

    ctx.listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L42',
      author_id: 111,
      author_name: 'Alice',
      message: 'check this out',
      message_type: 2,
      attachment: { w: 100, h: 100, mt: 'image/jpeg', url: 'https://example.com/x.jpg' },
      sent_at: 1_730_000_000_000,
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(ctx.routed).toHaveLength(1)
    expect(ctx.routed[0]?.text).toBe('check this out\n[KakaoTalk attachment #1: photo 100x100 image/jpeg]')
    expect(ctx.routed[0]?.attachments).toEqual([
      { id: 1, kind: 'photo', ref: 'https://example.com/x.jpg', mimetype: 'image/jpeg', width: 100, height: 100 },
    ])
    expect(ctx.client.markReadCalls[0]?.logId).toBe('L42')

    await ctx.stop()
  })

  test('routes an attachment-only photo (empty caption) instead of dropping it via empty_text', async () => {
    const ctx = await setupCaptured()

    ctx.listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L43',
      author_id: 111,
      author_name: 'Alice',
      message: '',
      message_type: 2,
      attachment: { w: 100, h: 100, mt: 'image/jpeg', url: 'https://example.com/x.jpg' },
      sent_at: 1_730_000_000_000,
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(ctx.routed).toHaveLength(1)
    expect(ctx.routed[0]?.text).toBe('[KakaoTalk attachment #1: photo 100x100 image/jpeg]')
    expect(ctx.routed[0]?.attachments?.[0]?.ref).toBe('https://example.com/x.jpg')

    await ctx.stop()
  })

  test('routes an attachment-only file (no caption) so files survive the empty_text drop', async () => {
    const ctx = await setupCaptured()

    ctx.listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L44',
      author_id: 111,
      author_name: 'Alice',
      message: '',
      message_type: 18,
      attachment: { name: 'spec.pdf', mt: 'application/pdf', size: 12345 },
      sent_at: 1_730_000_000_000,
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(ctx.routed).toHaveLength(1)
    expect(ctx.routed[0]?.text).toBe('[KakaoTalk attachment #1: file application/pdf name=spec.pdf size=12345]')
    expect(ctx.routed[0]?.attachments).toEqual([
      { id: 1, kind: 'file', ref: '', filename: 'spec.pdf', mimetype: 'application/pdf', sizeBytes: 12345 },
    ])

    await ctx.stop()
  })

  test('routes an emoticon event with the synthesized sticker text so allow-rules + engagement match plain MSG', async () => {
    const ctx = await setupCaptured()

    ctx.listener.emit('emoticon', {
      type: 'EMOTICON',
      chat_id: '111',
      log_id: 'L77',
      author_id: 111,
      author_name: 'Alice',
      message_type: 12,
      emoticon_kind: 'sticker',
      pack_id: '4412724',
      sticker_path: '4412724.emot_001.webp',
      sent_at: 1_730_000_000_000,
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(ctx.routed).toHaveLength(1)
    expect(ctx.routed[0]?.text).toBe('[KakaoTalk attachment #1: sticker name=4412724.emot_001.webp]')
    expect(ctx.routed[0]?.attachments).toEqual([{ id: 1, kind: 'sticker', ref: '', filename: '4412724.emot_001.webp' }])
    expect(ctx.routed[0]?.externalMessageId).toBe('L77')
    expect(ctx.routed[0]?.authorId).toBe('111')
    expect(ctx.client.markReadCalls[0]?.logId).toBe('L77')

    await ctx.stop()
  })

  test('drops self-authored stickers so two bots cannot ping-pong via emoticons', async () => {
    const ctx = await setupCaptured()

    ctx.listener.emit('emoticon', {
      type: 'EMOTICON',
      chat_id: '111',
      log_id: 'L78',
      author_id: 999,
      author_name: null,
      message_type: 12,
      emoticon_kind: 'sticker',
      pack_id: '1',
      sticker_path: '1.emot_001.webp',
      sent_at: 1_730_000_000_000,
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(ctx.routed).toHaveLength(0)
    expect(ctx.client.sendMessageCalls).toHaveLength(0)

    await ctx.stop()
  })

  test('drops self-authored photos for the same self-loop reason as text and stickers', async () => {
    const ctx = await setupCaptured()

    ctx.listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L79',
      author_id: 999,
      author_name: null,
      message: '',
      message_type: 2,
      attachment: { w: 50, h: 50, mt: 'image/png', url: 'https://example.com/self.png' },
      sent_at: 1_730_000_000_000,
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(ctx.routed).toHaveLength(0)

    await ctx.stop()
  })

  test('drops empty-text MSG events with no attachment (LOCO noise) without inventing a placeholder', async () => {
    const ctx = await setupCaptured()

    ctx.listener.emit('message', {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L80',
      author_id: 111,
      author_name: 'Alice',
      message: '',
      message_type: 99,
      attachment: null,
      sent_at: 1_730_000_000_000,
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(ctx.routed).toHaveLength(0)

    await ctx.stop()
  })
})

describe('createKakaotalkAdapter — inbound classification', () => {
  test('drops self_author when author equals authenticated user_id', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [
      {
        chat_id: '111',
        type: 0,
        display_name: 'Other',
        title: null,
        active_members: 2,
        unread_count: 0,
        last_message: null,
      },
    ]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    const event: KakaoTalkPushMessageEvent = {
      type: 'MSG',
      chat_id: '111',
      log_id: 'L42',
      author_id: 999,
      author_name: null,
      message: 'hi',
      message_type: 1,
      attachment: null,
      sent_at: Date.now(),
    }
    listener.emit('message', event)

    // Give the async handler a turn.
    await new Promise((r) => setTimeout(r, 0))

    expect(client.sendMessageCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })

  test('routes a message from a chat that getChats omits under @kakao-group instead of dropping unknown_chat', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const logs: string[] = []
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
      logger: {
        info: (m) => logs.push(m),
        warn: (m) => logs.push(m),
        error: (m) => logs.push(m),
      },
    })
    client.chats = []
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', {
      type: 'MSG',
      chat_id: '468625891988320',
      log_id: 'L3838',
      author_id: 24228244,
      author_name: 'Alice',
      message: 'hi',
      message_type: 1,
      attachment: null,
      sent_at: 1_730_000_000_000,
    })
    await new Promise((r) => setTimeout(r, 10))

    const dropped = logs.find((m) => m.includes('reason=unknown_chat'))
    expect(dropped).toBeUndefined()
    const routed = logs.find((m) => m.includes('routed log_id=L3838'))
    expect(routed).toBeDefined()
    expect(routed).toContain('bucket=@kakao-group')
    const provisional = logs.find((m) => m.includes('provisional chat=468625891988320'))
    expect(provisional).toBeDefined()

    await adapter.stop()
    await router.stop()
  })
})

describe('createKakaotalkAdapter — mark read on every inbound', () => {
  const dmChat = (id: string): KakaoChat => ({
    chat_id: id,
    type: 0,
    display_name: 'Other',
    title: null,
    active_members: 2,
    unread_count: 0,
    last_message: null,
  })

  const groupChat = (id: string, members: number): KakaoChat => ({
    chat_id: id,
    type: 10,
    display_name: 'Team',
    title: null,
    active_members: members,
    unread_count: 0,
    last_message: null,
  })

  const openChat = (id: string): KakaoChat => ({
    chat_id: id,
    type: 13,
    display_name: 'Open Room',
    title: null,
    active_members: 50,
    unread_count: 0,
    last_message: null,
  })

  const accepted = (chatId: string, logId: string, authorId = 111): KakaoTalkPushMessageEvent => ({
    type: 'MSG',
    chat_id: chatId,
    log_id: logId,
    author_id: authorId,
    author_name: 'Alice',
    message: 'hello',
    message_type: 1,
    attachment: null,
    sent_at: 1_730_000_000_000,
  })

  test('fires markRead for a routed inbound', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [dmChat('111')]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', accepted('111', 'L42'))
    await new Promise((r) => setTimeout(r, 50))

    expect(client.markReadCalls).toEqual([{ chatId: '111', logId: 'L42' }])

    await adapter.stop()
    await router.stop()
  })

  test('still fires markRead when classification drops the message (self-author, not-in-allow, etc.)', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const router = createChannelRouter({ agentDir, configForAdapter: () => adapterCfg() })
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => adapterCfg(),
      client,
      listenerFactory: () => listener,
    })
    client.chats = [dmChat('111')]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    // authorId 999 matches the fake profile's user_id → self_author drop.
    // The contract changed: we still want the unread "1" to clear, so
    // markRead must fire even though the message never reaches the router.
    listener.emit('message', accepted('111', 'L42', 999))
    await new Promise((r) => setTimeout(r, 50))

    expect(client.markReadCalls).toEqual([{ chatId: '111', logId: 'L42' }])
    expect(client.sendMessageCalls).toHaveLength(0)

    await adapter.stop()
    await router.stop()
  })

  test('skips markRead for open-chat bucket (linkId not yet wired through resolver)', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    const cfg = adapterCfg()
    const router = createChannelRouter({ agentDir, configForAdapter: () => cfg })
    const logs: string[] = []
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => cfg,
      client,
      listenerFactory: () => listener,
      logger: {
        info: (m) => logs.push(m),
        warn: (m) => logs.push(m),
        error: (m) => logs.push(m),
      },
    })
    client.chats = [openChat('555')]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', accepted('555', 'L77'))
    await new Promise((r) => setTimeout(r, 50))

    expect(client.markReadCalls).toHaveLength(0)
    const skipped = logs.find((m) => m.includes('mark-read skipped') && m.includes('open_chat_link_id_unsupported'))
    expect(skipped).toBeDefined()

    await adapter.stop()
    await router.stop()
  })

  test('markRead rejection is logged and never bubbles out of the handler', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    client.markReadError = new Error('LOCO packet timeout')
    const cfg = adapterCfg()
    const router = createChannelRouter({ agentDir, configForAdapter: () => cfg })
    const logs: string[] = []
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => cfg,
      client,
      listenerFactory: () => listener,
      logger: {
        info: (m) => logs.push(m),
        warn: (m) => logs.push(m),
        error: (m) => logs.push(m),
      },
    })
    client.chats = [groupChat('222', 5)]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', accepted('222', 'L11'))
    await new Promise((r) => setTimeout(r, 50))

    expect(client.markReadCalls).toHaveLength(1)
    const failure = logs.find((m) => m.includes('mark-read failed') && m.includes('LOCO packet timeout'))
    expect(failure).toBeDefined()

    await adapter.stop()
    await router.stop()
  })

  test('markRead non-success status is surfaced as a warn log', async () => {
    const client = new FakeClient()
    const listener = new FakeListener()
    client.markReadResult = { success: false, status_code: -500, chat_id: '222', watermark: 'L11' }
    const cfg = adapterCfg()
    const router = createChannelRouter({ agentDir, configForAdapter: () => cfg })
    const logs: string[] = []
    const adapter = createKakaotalkAdapter({
      router,
      configRef: () => cfg,
      client,
      listenerFactory: () => listener,
      logger: {
        info: (m) => logs.push(m),
        warn: (m) => logs.push(m),
        error: (m) => logs.push(m),
      },
    })
    client.chats = [groupChat('222', 5)]
    await adapter.start()
    listener.emit('connected', { userId: '999' })

    listener.emit('message', accepted('222', 'L11'))
    await new Promise((r) => setTimeout(r, 50))

    const nonSuccess = logs.find((m) => m.includes('mark-read non-success') && m.includes('status_code=-500'))
    expect(nonSuccess).toBeDefined()

    await adapter.stop()
    await router.stop()
  })
})
