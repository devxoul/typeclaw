import { describe, expect, test } from 'bun:test'

import { createChannelRouter, type ChannelRouter } from '@/channels/router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { ChannelHistoryMessage, FetchHistoryArgs, GetMessageArgs, ListChannelsArgs } from '@/channels/types'

import { createChannelReadTool } from './channel-read'

function emptyAdapterConfig(): ChannelAdapterConfig {
  return {
    engagement: { trigger: ['mention'], stickiness: 'off' },
    enabled: true,
    history: defaultHistoryConfig(),
  }
}

function makeRouter(): ChannelRouter {
  return createChannelRouter({
    agentDir: '/tmp/test-channel-read',
    configForAdapter: () => emptyAdapterConfig(),
  })
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelReadTool>['execute']>[4]

async function runTool(
  tool: ReturnType<typeof createChannelReadTool>,
  params: Parameters<ReturnType<typeof createChannelReadTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

function userMessage(overrides: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage {
  return {
    externalMessageId: 'm1',
    authorId: 'UALICE',
    authorName: 'Alice',
    text: 'hello',
    ts: 1_700_000_000_000,
    isBot: false,
    replyToBotMessageId: null,
    ...overrides,
  }
}

describe('createChannelReadTool — mode: history', () => {
  test('passes the agent-supplied address through to fetchHistory verbatim', async () => {
    // given
    const seen: FetchHistoryArgs[] = []
    const router = makeRouter()
    router.registerHistory('slack-bot', async (args) => {
      seen.push(args)
      return { ok: true, messages: [userMessage()] }
    })
    const tool = createChannelReadTool({ router })

    // when
    await runTool(tool, { mode: 'history', adapter: 'slack-bot', workspace: 'T0', chat: 'C9', thread: 'th1', limit: 5 })

    // then
    expect(seen).toEqual([{ chat: 'C9', thread: 'th1', limit: 5 }])
  })

  test('renders messages oldest-first with a BOT marker for the agent own replies', async () => {
    // given
    const router = makeRouter()
    router.registerHistory('slack-bot', async () => ({
      ok: true,
      messages: [
        userMessage({ externalMessageId: '001700000000.000001', text: 'first' }),
        userMessage({ externalMessageId: '001700000000.000002', authorName: 'Bot', isBot: true, text: 'second' }),
      ],
    }))
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'history', adapter: 'slack-bot', workspace: 'T0', chat: 'C9' })

    // then
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('[message_id=001700000000.000001] Alice (<@UALICE>): first')
    expect(text).toContain('[message_id=001700000000.000002] BOT (Bot): second')
    expect(text).toContain('Alice (<@UALICE>): first')
    expect(text).toContain('BOT (Bot): second')
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
  })

  test('renders non-Latin author and body intact (multi-language)', async () => {
    // given a Korean author and message body
    const router = makeRouter()
    router.registerHistory('slack-bot', async () => ({
      ok: true,
      messages: [userMessage({ authorName: '김철수', text: '확인했어요' })],
    }))
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'history', adapter: 'slack-bot', workspace: 'T0', chat: 'C9' })

    // then
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('김철수')
    expect(text).toContain('확인했어요')
  })

  test('surfaces a nextCursor paging hint when more messages are available', async () => {
    // given
    const router = makeRouter()
    router.registerHistory('slack-bot', async () => ({ ok: true, messages: [userMessage()], nextCursor: 'CUR2' }))
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'history', adapter: 'slack-bot', workspace: 'T0', chat: 'C9' })

    // then
    expect((result.content[0] as { text: string }).text).toContain('cursor: "CUR2"')
    expect(result.details).toMatchObject({ ok: true, nextCursor: 'CUR2' })
  })

  test('requires chat and does not call the adapter when chat is omitted', async () => {
    // given
    let called = false
    const router = makeRouter()
    router.registerHistory('slack-bot', async () => {
      called = true
      return { ok: true, messages: [] }
    })
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'history', adapter: 'slack-bot', workspace: 'T0' })

    // then
    expect(called).toBe(false)
    expect(result.details.ok).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('requires `chat`')
  })

  test('returns the adapter error when no history callback is registered', async () => {
    // given a router with no history callback for the adapter
    const router = makeRouter()
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'history', adapter: 'discord-bot', workspace: 'G0', chat: 'C9' })

    // then
    expect(result.details.ok).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('history-not-supported')
  })
})

describe('createChannelReadTool — mode: message', () => {
  test('passes the address through to getMessage verbatim and renders the message', async () => {
    // given
    const seen: GetMessageArgs[] = []
    const router = makeRouter()
    router.registerMessageGet('discord-bot', async (args) => {
      seen.push(args)
      return { ok: true, message: userMessage({ externalMessageId: '000987654321', text: 'the one message' }) }
    })
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, {
      mode: 'message',
      adapter: 'discord-bot',
      workspace: 'G0',
      chat: 'C9',
      message_id: 'M123',
    })

    // then
    expect(seen).toEqual([{ chat: 'C9', thread: null, messageId: 'M123' }])
    const content = result.content[0]
    if (content?.type !== 'text') throw new Error('expected text content')
    expect(content.text).toContain('[message_id=000987654321] Alice')
    expect(content.text).toContain('the one message')
    expect(result.details).toMatchObject({ ok: true, count: 1 })
  })

  test('requires message_id', async () => {
    // given
    const router = makeRouter()
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'message', adapter: 'discord-bot', workspace: 'G0', chat: 'C9' })

    // then
    expect(result.details.ok).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('requires `message_id`')
  })

  test('surfaces a not-found miss as a soft error', async () => {
    // given
    const router = makeRouter()
    router.registerMessageGet('discord-bot', async () => ({ ok: false, error: 'gone', code: 'not-found' }))
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, {
      mode: 'message',
      adapter: 'discord-bot',
      workspace: 'G0',
      chat: 'C9',
      message_id: 'M123',
    })

    // then
    expect(result.details.ok).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('gone')
  })

  test('returns not-supported when no message-get callback is registered', async () => {
    // given
    const router = makeRouter()
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, {
      mode: 'message',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C9',
      message_id: 'M1',
    })

    // then
    expect(result.details.ok).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('message-get-not-supported')
  })
})

describe('createChannelReadTool — mode: list', () => {
  test('passes workspace/limit through and renders entries with chat ids', async () => {
    // given
    const seen: ListChannelsArgs[] = []
    const router = makeRouter()
    router.registerList('slack-bot', async (args) => {
      seen.push(args)
      return {
        ok: true,
        entries: [
          { chat: 'C1', name: '#general', kind: 'channel', isMember: true },
          { chat: 'C2', name: '#random', kind: 'channel', isMember: false },
        ],
      }
    })
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'list', adapter: 'slack-bot', workspace: 'T0', limit: 50 })

    // then
    expect(seen).toEqual([{ workspace: 'T0', limit: 50 }])
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('#general (chat=C1, channel, member)')
    expect(text).toContain('#random (chat=C2, channel, not-member)')
  })

  test('surfaces a nextCursor paging hint', async () => {
    // given
    const router = makeRouter()
    router.registerList('slack-bot', async () => ({
      ok: true,
      entries: [{ chat: 'C1', name: '#general', kind: 'channel' }],
      nextCursor: 'LCUR',
    }))
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'list', adapter: 'slack-bot', workspace: 'T0' })

    // then
    expect((result.content[0] as { text: string }).text).toContain('cursor: "LCUR"')
  })

  test('returns not-supported when no list callback is registered', async () => {
    // given
    const router = makeRouter()
    const tool = createChannelReadTool({ router })

    // when
    const result = await runTool(tool, { mode: 'list', adapter: 'discord-bot', workspace: 'G0' })

    // then
    expect(result.details.ok).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('list-not-supported')
  })
})
