import { describe, expect, test } from 'bun:test'

import { OUTBOUND_FLOOD_ERROR, type ChannelRouter } from '@/channels/router'
import type { OutboundMessage, SendResult } from '@/channels/types'

import { TOOL_RESULT_PREFIX } from './channel-reply'
import { createChannelSendTool } from './channel-send'

function fakeRouter(
  handler: (msg: OutboundMessage) => Promise<SendResult>,
  options: {
    consecutiveCount?: number
    finishGithubReviewThreadCloseout?: ChannelRouter['finishGithubReviewThreadCloseout']
  } = {},
): ChannelRouter {
  return {
    route: async () => {},
    send: handler,
    getConsecutiveSendCount: () => options.consecutiveCount ?? 0,
    getSendRate: () => ({ count: 0, windowMs: 5_000 }),
    registerOutbound: () => {},
    unregisterOutbound: () => {},
    registerReaction: () => {},
    unregisterReaction: () => {},
    react: async () => ({ ok: true }),
    queueReactionAfterReply: async () => ({ ok: true }),
    registerRemoveReaction: () => {},
    unregisterRemoveReaction: () => {},
    removeReaction: async () => ({ ok: true }),
    registerTyping: () => {},
    unregisterTyping: () => {},
    setTypingCapability: () => {},
    setTypingHeartbeatInterval: () => {},
    setAdapterConfigured: () => {},
    registerChannelNameResolver: () => {},
    unregisterChannelNameResolver: () => {},
    registerSelfIdentity: () => {},
    unregisterSelfIdentity: () => {},
    registerMembership: () => {},
    unregisterMembership: () => {},
    registerHistory: () => {},
    unregisterHistory: () => {},
    fetchHistory: async () => ({ ok: false, error: 'history-not-supported' }),
    registerMessageGet: () => {},
    unregisterMessageGet: () => {},
    getMessage: async () => ({ ok: false, error: 'message-get-not-supported', code: 'not-supported' }),
    registerList: () => {},
    unregisterList: () => {},
    listChannels: async () => ({ ok: false, error: 'list-not-supported', code: 'not-supported' }),
    registerEditMessage: () => {},
    unregisterEditMessage: () => {},
    editMessage: async () => ({ ok: false, error: 'message-edit-not-supported', code: 'not-supported' }),
    registerFetchAttachment: () => {},
    unregisterFetchAttachment: () => {},
    fetchAttachment: async () => ({ ok: false, error: 'no fetchAttachment callback registered for "slack-bot"' }),
    registerReviewThreadResolver: () => {},
    unregisterReviewThreadResolver: () => {},
    resolveReviewThread: async () => ({ ok: true }),
    registerReviewStateResolver: () => {},
    unregisterReviewStateResolver: () => {},
    getReviewState: async () => ({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true }),
    registerReviewSubmitter: () => {},
    unregisterReviewSubmitter: () => {},
    submitReview: async () => ({ ok: true, reviewId: 1, state: 'COMMENTED' }),
    lookupInboundAttachment: () => null,
    listInboundAttachmentIds: () => [],
    registerHistoryAttachments: () => {},
    getSelfAliases: () => [],
    stop: async () => {},
    tearDownAllLive: async () => {},
    markRestartAbortForAllLive: async () => {},
    writeInterruptedSubagentHandoff: async () => false,
    liveCount: () => 0,
    executeCommand: async () => ({ kind: 'no-live-session' }),
    injectSubagentCompletionReminder: () => ({ kind: 'no-live-session' }),
    injectPrVerdictActivity: () => ({ kind: 'delivered', count: 0 }),
    ...(options.finishGithubReviewThreadCloseout !== undefined
      ? { finishGithubReviewThreadCloseout: options.finishGithubReviewThreadCloseout }
      : {}),
    noteGithubReviewOutput: () => ({ kind: 'no-live-session' }),
    markTurnSkipped: () => ({ kind: 'no-live-session' }),
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
  }
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelSendTool>['execute']>[4]

async function runTool(
  tool: ReturnType<typeof createChannelSendTool>,
  params: Parameters<ReturnType<typeof createChannelSendTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('createChannelSendTool', () => {
  test('forwards parameters to router.send and reports success', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelSendTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
    })
    const result = await runTool(tool, {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hi',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hi',
    })
    expect(result.details).toEqual({ ok: true })
  })

  test('passes preview suppression to the router for an outbound post', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelSendTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
    })
    await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      text: 'https://example.org',
      link_previews: false,
    })
    expect(calls[0]?.link_previews).toBe(false)
  })

  test('strips a trailing tool-call leak from text, sending only the prose', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelSendTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
    })
    const result = await runTool(tool, {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hmm, not really sure about that one\n\nskip_response({ reason: "no new info" })',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).toBe('hmm, not really sure about that one')
    expect(calls[0]!.text).not.toContain('skip_response')
    expect(result.details).toMatchObject({ ok: true })
  })

  test('surfaces messageId and messageIds from the router result in details', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true, messageId: '1700.0001', messageIds: ['1700.0001', '1700.0002'] })),
    })
    const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'hi' })
    expect(result.details).toEqual({ ok: true, messageId: '1700.0001', messageIds: ['1700.0001', '1700.0002'] })
  })

  test('forwards an optional thread when provided', async () => {
    const captured: { thread: string | null | undefined } = { thread: undefined }
    const tool = createChannelSendTool({
      router: fakeRouter(async (msg) => {
        captured.thread = msg.thread ?? null
        return { ok: true }
      }),
    })
    await runTool(tool, {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: 't42',
      text: 'in thread',
    })
    expect(captured.thread).toBe('t42')
  })

  test('reports denial back to the agent without throwing', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' })),
    })
    const result = await runTool(tool, {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c-blocked',
      text: 'nope',
    })
    expect(result.details).toEqual({ ok: false, error: 'denied by allow rules' })
    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('denied')
  })

  test('reports outbound flood denial back to the agent without posting', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: false, error: OUTBOUND_FLOOD_ERROR, code: 'outbound-flood' })),
    })
    const result = await runTool(tool, {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'ㅋ'.repeat(500),
    })
    expect(result.details).toEqual({ ok: false, error: OUTBOUND_FLOOD_ERROR })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('channel_send denied')
    expect(text).toContain(OUTBOUND_FLOOD_ERROR)
  })

  test('first send (count=1) returns the delivery confirmation with echoed text', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 1 }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      text: 'first reply',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('posted to slack-bot:T0/C0: "first reply"')
    expect(text.startsWith('---')).toBe(true)
    expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(text).not.toContain(TOOL_RESULT_PREFIX)
  })

  test('second consecutive send appends a soft yield hint', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 2 }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      text: 'continuing',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('posted to slack-bot:T0/C0: "continuing"')
    expect(text).toContain('2nd consecutive message')
    expect(text).toContain('continue only if')
  })

  test('third+ consecutive send appends a firm yield hint with the count', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 5 }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      text: 'still going',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('5th consecutive message')
    expect(text).toContain('end your turn now')
    expect(text).toContain('"still going"')
  })

  test('consecutive-send hint is fenced as a SYSTEM MESSAGE so persona-rich models cannot read it as chat', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 4 }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      text: 'still going',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(text).toContain('Do not acknowledge or reply to this notice')
    expect(text).toMatch(/---\s*\n\*\*\[SYSTEM MESSAGE/)
    expect(text).toMatch(/Do not acknowledge or reply to this notice\.\*\*\s*\n---/)
  })

  test('thread-mismatch hint is also fenced as a SYSTEM MESSAGE', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
    })
    const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'oops' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(text).toContain('Do not acknowledge or reply to this notice')
    expect(text).toContain('origin thread is "1700000000.000100"')
  })

  test('denied sends never carry the hint suffix', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' }), {
        consecutiveCount: 7,
      }),
    })
    const result = await runTool(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C-blocked',
      text: 'no',
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('denied')
    expect(text).not.toContain('consecutive')
  })

  describe('thread-mismatch hint', () => {
    test('warns when posting to the same conversation as origin but dropping the thread', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'oops' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to slack-bot:T0/C0: "oops"')
      expect(text).toContain('origin thread is "1700000000.000100"')
      expect(text).toContain('channel root')
      expect(text).toContain('channel_reply')
    })

    test('does NOT warn when the model passes the matching thread explicitly', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: '1700000000.000100',
        text: 'in thread',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to slack-bot:T0/C0: "in thread"')
      expect(text).not.toContain('origin thread')
    })

    test('does NOT warn when the model deliberately posts to a DIFFERENT chat', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C-other',
        text: 'cross-channel post',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to slack-bot:T0/C-other: "cross-channel post"')
      expect(text).not.toContain('origin thread')
    })

    test('does NOT warn when the origin had no thread to begin with (channel-root origin)', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: 'channel-root reply',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to slack-bot:T0/C0: "channel-root reply"')
      expect(text).not.toContain('origin thread')
    })

    test('does NOT warn when no origin is supplied (cron / non-channel session)', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'cron post' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to slack-bot:T0/C0: "cron post"')
      expect(text).not.toContain('origin thread')
    })

    test('does NOT warn on adapter mismatch (cross-platform post)', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'd1',
        text: 'cross-platform',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to discord-bot:g1/d1: "cross-platform"')
      expect(text).not.toContain('origin thread')
    })

    test('combines with the consecutive-send hint when both fire', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 2 }),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'oops twice' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('posted to slack-bot:T0/C0: "oops twice"')
      expect(text).toContain('2nd consecutive message')
      expect(text).toContain('origin thread is "1700000000.000100"')
    })

    test('does not fire on a denied send even when addressing matches', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: false, error: 'denied' })),
        origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1700000000.000100' },
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'no' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('denied')
      expect(text).not.toContain('origin thread')
    })
  })

  describe('attachments', () => {
    test('forwards attachments to router.send', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: 'see attached',
        attachments: [{ path: '/agent/report.pdf' }],
      })
      expect(calls[0]?.attachments).toEqual([{ path: '/agent/report.pdf' }])
      expect(calls[0]?.text).toBe('see attached')
    })

    test('allows attachments without text', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        attachments: [{ path: '/agent/a.png' }],
      })
      expect(result.details).toEqual({ ok: true })
      expect(calls[0]?.text).toBeUndefined()
      expect(calls[0]?.attachments).toEqual([{ path: '/agent/a.png' }])
    })

    test('rejects when neither text nor attachments are provided', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, { adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })
      expect(calls).toHaveLength(0)
      expect(result.details).toEqual({ ok: false, error: 'missing text and attachments' })
    })

    test('echo summarizes filenames when text+attachments are sent', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true })),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: 'caption',
        attachments: [{ path: '/agent/a.png' }, { path: '/agent/b.pdf', filename: 'report.pdf' }],
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('"caption"')
      expect(text).toContain('2 file(s)')
      expect(text).toContain('a.png')
      expect(text).toContain('report.pdf')
    })
  })

  describe('no-reply misuse guard', () => {
    test('blocks the send when text is exactly "NO_REPLY" and never invokes router.send', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'NO_REPLY' })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('silent-turn signal')
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_send denied')
      expect(text).toContain('silent-turn signal')
      expect(text).not.toContain('posted to')
    })

    test('blocks on whitespace-padded "NO_REPLY" (mirrors router trim semantics)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: '  NO_REPLY\n',
      })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
    })

    test('does NOT block when "NO_REPLY" appears as a substring inside a real message', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: 'NO_REPLY means stay silent',
      })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('does NOT block on lowercase or other casings (must match exactly)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'no_reply' })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('blocks the parenthesized "(NO_REPLY)" form (mirrors router lenience)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: '(NO_REPLY)',
      })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('silent-turn signal')
    })

    for (const loud of ['**NO_REPLY**', '`NO_REPLY`', '*NO_REPLY*']) {
      test(`blocks the loud ${loud} form (mirrors router lenience)`, async () => {
        const calls: OutboundMessage[] = []
        const tool = createChannelSendTool({
          router: fakeRouter(async (msg) => {
            calls.push(msg)
            return { ok: true }
          }),
        })
        const result = await runTool(tool, { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: loud })
        expect(calls).toHaveLength(0)
        expect(result.details).toMatchObject({ ok: false })
        expect((result.details as { error: string }).error).toContain('silent-turn signal')
      })
    }
  })

  describe('upstream empty-response sentinel guard', () => {
    test('blocks `(Empty response: {...stop_reason...})` so thinking content + signature never reach the channel', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text:
          "(Empty response: {'content': [{'type': 'thinking', 'thinking': 'leak', " +
          "'signature': 'EpQC...'}], 'stop_reason': 'end_turn'})",
      })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('Empty response')
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_send denied')
      expect(text).not.toContain('posted to')
    })

    test('does NOT block legit prose mentioning "Empty response" without the python-dict shape', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: 'Empty response from the cache layer; retrying now.',
      })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('does NOT block when the sentinel substring appears mid-message', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: "I saw the line `(Empty response: {'stop_reason': 'end_turn'})` in the logs; investigating.",
      })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })
  })

  describe('Kimi tool-call delimiter leak guard', () => {
    test('blocks raw `<|tool_call_argument_begin|>...<|tool_calls_section_end|>` tokens from reaching the channel', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: 'channel_send:0<|tool_call_argument_begin|>{"text": "hi"}<|tool_calls_section_end|>',
      })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('provider tool-call control tokens')
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_send denied')
      expect(text).not.toContain('posted to')
    })

    test('does NOT block legit prose mentioning tool names without Kimi delimiter tokens', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })
      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        text: 'I will call channel_send:0 next.',
      })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })
  })

  describe('structured router failures surface as denials', () => {
    test('duplicate code from router renders as channel_send denied with router error text', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: false, error: 'Duplicate not sent. ...', code: 'duplicate' })),
      })
      const result = await runTool(tool, {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: 'same body',
      })
      expect(result.details).toEqual({ ok: false, error: 'Duplicate not sent. ...' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_send denied')
      expect(text).toContain('Duplicate not sent')
    })

    test('turn-cap code from router renders as channel_send denied', async () => {
      const tool = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: false, error: 'Send-cap reached for this turn ...', code: 'turn-cap' })),
      })
      const result = await runTool(tool, {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: 'eleventh',
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_send denied')
      expect(text).toContain('Send-cap reached')
    })
  })

  describe('channel_send resolve_review_thread required-choice enforcement', () => {
    test('denies a github PR review-thread text send that omits the resolve choice', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })

      const result = await runTool(tool, {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:585',
        thread: 'RC_kwABC',
        text: 'okay I checked, it is addressed.',
      })

      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('resolve_review_thread')
      const rendered = (result.content[0] as { text: string }).text
      expect(rendered).toContain('channel_send denied')
      expect(rendered).not.toContain('posted to')
    })

    test('denies a non-English (Korean) close-out send that omits the resolve choice', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })

      const result = await runTool(tool, {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:585',
        thread: 'RC_kwABC',
        text: '확인했고 반영됐어요.',
      })

      expect(calls).toHaveLength(0)
      expect((result.details as { error: string }).error).toContain('resolve_review_thread')
    })

    test('proceeds when the resolve choice is an explicit false (thread kept open)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })

      const result = await runTool(tool, {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:585',
        thread: 'RC_kwABC',
        text: 'Still looking into this one.',
        resolve_review_thread: false,
      })

      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('records an explicit false only after its exact-thread send succeeds', async () => {
      const decisions: string[] = []
      const success = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: true }), {
          finishGithubReviewThreadCloseout: ({ decision }) => decisions.push(decision),
        }),
      })
      const failure = createChannelSendTool({
        router: fakeRouter(async () => ({ ok: false, error: 'send failed' }), {
          finishGithubReviewThreadCloseout: ({ decision }) => decisions.push(decision),
        }),
      })
      const params = {
        adapter: 'github' as const,
        workspace: 'acme/widgets',
        chat: 'pr:585',
        thread: 'RC_kwABC',
        text: 'This remains open for a concrete reason.',
        resolve_review_thread: false,
      }

      await runTool(success, params)
      await runTool(failure, params)

      expect(decisions).toEqual(['left-open'])
    })

    test('exempts an attachments-only github review-thread send (no text to acknowledge)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })

      const result = await runTool(tool, {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:585',
        thread: 'RC_kwABC',
        attachments: [{ path: '/agent/diff.png' }],
      })

      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('does not require the choice on a github PR send outside a review thread (no thread)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })

      const result = await runTool(tool, {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:585',
        text: 'General note on the PR.',
      })

      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('does not require the choice on a non-github thread send', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
      })

      const result = await runTool(tool, {
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: '1700.0001',
        text: 'done',
      })

      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('an explicit true still drives the resolve-before-post path', async () => {
      const order: string[] = []
      const tool = createChannelSendTool({
        router: {
          ...fakeRouter(async () => {
            order.push('send')
            return { ok: true }
          }),
          resolveReviewThread: async (req) => {
            order.push(`resolve:${req.rootCommentId}`)
            return { ok: true }
          },
        },
      })

      const result = await runTool(tool, {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:585',
        thread: 'RC_kwABC',
        text: 'Verified — fix looks solid.',
        resolve_review_thread: true,
      })

      expect(result.details).toEqual({ ok: true })
      expect(order).toEqual(['resolve:RC_kwABC', 'send'])
    })

    test('reports success without posting when the thread was already resolved', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelSendTool({
        router: {
          ...fakeRouter(async (msg) => {
            calls.push(msg)
            return { ok: true }
          }),
          resolveReviewThread: async () => ({ ok: true, alreadyResolved: true }),
        },
      })

      const result = await runTool(tool, {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:585',
        thread: 'RC_kwABC',
        text: 'Verified — fix looks solid.',
        resolve_review_thread: true,
      })

      expect(calls).toHaveLength(0)
      expect(result.details).toEqual({ ok: true })
      const rendered = (result.content[0] as { text: string }).text
      expect(rendered).toContain('already resolved')
      expect(rendered).toContain('no acknowledgement comment was posted')
    })
  })
})
