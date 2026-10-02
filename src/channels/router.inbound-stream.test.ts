import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import type { PermissionService } from '@/permissions'
import { createStream, type StreamMessage } from '@/stream'

import { createChannelRouter } from './router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from './schema'
import type { InboundMessage } from './types'

const baseConfig: ChannelAdapterConfig = {
  engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
  enabled: true,
  history: defaultHistoryConfig(),
}

class FakeSession {
  agent: { afterToolCall?: unknown; streamFunction: unknown; signal?: AbortSignal; abort: () => void } = {
    streamFunction: () => undefined,
    abort: () => {},
  }
  prompt = async (): Promise<void> => {}
  abort = async (): Promise<void> => {}
  dispose = (): void => {}
  subscribe = (): (() => void) => () => {}
}

const grantAll: PermissionService = {
  has: () => true,
  resolveRole: () => 'owner',
  compareRoleSeverity: () => 1,
  permissionsForRole: () => undefined,
  describe: () => ({ role: 'owner', permissions: ['channel.respond'] }),
  replaceRoles: () => {},
}

const denyAll: PermissionService = {
  has: () => false,
  resolveRole: () => 'guest',
  compareRoleSeverity: () => undefined,
  permissionsForRole: () => undefined,
  describe: () => ({ role: 'guest', permissions: [] }),
  replaceRoles: () => {},
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: 'discord-bot',
    workspace: 'g1',
    chat: 'c1',
    thread: null,
    text: 'hello bot',
    externalMessageId: 'm1',
    accountIdentity: 'proof-account',
    authorId: 'alice',
    authorName: 'Alice',
    authorIsBot: false,
    isBotMention: true,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts: 1_700_000_000_000,
    ...over,
  }
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'router-inbound-stream-'))
}

function captureInboundBroadcasts(stream: ReturnType<typeof createStream>): StreamMessage[] {
  const captured: StreamMessage[] = []
  stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const payload = msg.payload as { kind?: unknown } | null
    if (payload?.kind === 'channel-inbound') captured.push(msg)
  })
  return captured
}

describe('router publishes channel-inbound broadcasts', () => {
  test('engaged inbound publishes with decision=engage', async () => {
    const dir = await tempDir()
    const stream = createStream()
    const captured = captureInboundBroadcasts(stream)
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      permissions: grantAll,
      stream,
      createSessionForChannel: async () => ({
        session: new FakeSession() as unknown as AgentSession,
        sessionId: 'ses_1',
        dispose: async () => {},
      }),
    })

    await router.route(inbound({ text: 'hey @bot help me' }))

    expect(captured).toHaveLength(1)
    const p = captured[0]!.payload as Record<string, unknown>
    expect(p.kind).toBe('channel-inbound')
    expect(p.decision).toBe('engage')
    expect(p.adapter).toBe('discord-bot')
    expect(p.authorId).toBe('alice')
    expect(p.text).toBe('hey @bot help me')
    expect(p.isBotMention).toBe(true)
    expect(p.sessionId).toBe('ses_1')
  })

  test('denied inbound publishes with decision=denied (still visible in inspect)', async () => {
    const dir = await tempDir()
    const stream = createStream()
    const captured = captureInboundBroadcasts(stream)
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      permissions: denyAll,
      stream,
      createSessionForChannel: async () => ({
        session: new FakeSession() as unknown as AgentSession,
        sessionId: 'ses_1',
        dispose: async () => {},
      }),
    })

    await router.route(inbound())

    expect(captured).toHaveLength(1)
    const p = captured[0]!.payload as Record<string, unknown>
    expect(p.decision).toBe('denied')
    expect(p.sessionId).toBeUndefined()
  })

  test('observed inbound publishes with decision=observe', async () => {
    const dir = await tempDir()
    const stream = createStream()
    const captured = captureInboundBroadcasts(stream)
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      permissions: grantAll,
      stream,
      createSessionForChannel: async () => ({
        session: new FakeSession() as unknown as AgentSession,
        sessionId: 'ses_1',
        dispose: async () => {},
      }),
    })

    await router.route(
      inbound({
        text: 'plain chat between humans',
        authorId: 'bob',
        authorName: 'Bob',
        isBotMention: false,
        isDm: false,
        replyToBotMessageId: null,
        mentionsOthers: true,
      }),
    )

    expect(captured).toHaveLength(1)
    const p = captured[0]!.payload as Record<string, unknown>
    expect(p.decision).toBe('observe')
    expect(p.isBotMention).toBe(false)
  })

  test('claim intercept publishes with decision=claim', async () => {
    const dir = await tempDir()
    const stream = createStream()
    const captured = captureInboundBroadcasts(stream)
    const sent: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      permissions: denyAll,
      stream,
      claimHandler: async () => ({ kind: 'consumed', reply: 'role claimed' }),
      createSessionForChannel: async () => ({
        session: new FakeSession() as unknown as AgentSession,
        sessionId: 'ses_1',
        dispose: async () => {},
      }),
    })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ isDm: true, text: 'claim-7K9M-2X3R' }))

    expect(captured).toHaveLength(1)
    const p = captured[0]!.payload as Record<string, unknown>
    expect(p.decision).toBe('claim')
    expect(sent).toEqual(['role claimed'])
  })
})
