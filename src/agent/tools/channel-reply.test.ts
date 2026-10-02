import { describe, expect, test } from 'bun:test'

import { createGithubReviewThreadResolver } from '@/channels/adapters/github/review-thread-resolver'
import {
  __resetReviewVerdictGuardForTest,
  registerGithubReviewRound,
} from '@/channels/github-review-verdict-coordinator'
import { OUTBOUND_FLOOD_ERROR, type ChannelRouter } from '@/channels/router'
import type { OutboundMessage, SendResult } from '@/channels/types'

import {
  createChannelReplyTool,
  ECHO_MAX_CHARS,
  renderEcho,
  renderOutboundEcho,
  TOOL_RESULT_PREFIX,
  type ChannelReplyOrigin,
} from './channel-reply'

function fakeRouter(
  handler: (msg: OutboundMessage) => Promise<SendResult>,
  options: {
    consecutiveCount?: number
    qualifyingWorkObserved?: boolean
    resolveReviewThread?: ChannelRouter['resolveReviewThread']
    getReviewState?: ChannelRouter['getReviewState']
    finishGithubReviewThreadCloseout?: ChannelRouter['finishGithubReviewThreadCloseout']
  } = {},
): ChannelRouter {
  return {
    route: async () => {},
    send: handler,
    hasQualifyingWorkThisLogicalTurn: () => options.qualifyingWorkObserved ?? false,
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
    registerPrepareOwnReaction: () => {},
    unregisterPrepareOwnReaction: () => {},
    registerRemoveOwnReaction: () => {},
    unregisterRemoveOwnReaction: () => {},
    removeOwnReaction: async () => ({ ok: true }),
    recoverWaitingReactions: async () => {},
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
    resolveReviewThread: options.resolveReviewThread ?? (async () => ({ ok: true })),
    registerReviewStateResolver: () => {},
    unregisterReviewStateResolver: () => {},
    getReviewState:
      options.getReviewState ??
      (async () => ({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true })),
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

const slackThreadOrigin: ChannelReplyOrigin = {
  adapter: 'slack-bot',
  workspace: 'T0',
  chat: 'C0',
  thread: '1700000000.000100',
}

const slackChannelRootOrigin: ChannelReplyOrigin = {
  adapter: 'slack-bot',
  workspace: 'T0',
  chat: 'C0',
  thread: null,
}

type ChannelReplyParams = {
  text?: string
  attachments?: { path: string; filename?: string }[]
  link_previews?: boolean
  more_work_this_turn: boolean
  resolve_review_thread?: boolean
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelReplyTool>['execute']>[4]

// `more_work_this_turn` is schema-required; this helper defaults it to `false` (terminal) so
// tests not exercising the more_work_this_turn path stay terse. Keep the divergence.
async function runTool(
  tool: ReturnType<typeof createChannelReplyTool>,
  params: Omit<ChannelReplyParams, 'more_work_this_turn'> & {
    more_work_this_turn?: boolean
  },
) {
  return tool.execute(
    'id',
    { ...params, more_work_this_turn: params.more_work_this_turn ?? false },
    undefined,
    undefined,
    fakeCtx,
  )
}

describe('createChannelReplyTool', () => {
  test('denies an unsupported completion claim before posting it', async () => {
    let sent = 0
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => {
        sent++
        return { ok: true }
      }),
      origin: slackThreadOrigin,
    })

    const result = await runTool(tool, { text: '반영했어' })

    expect(sent).toBe(0)
    expect(result.details).toMatchObject({ ok: false })
    expect((result.content[0] as { text: string }).text).toContain('perform the work')
  })

  test('allows a completion claim after qualifying work was observed', async () => {
    let sent = 0
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async () => {
          sent++
          return { ok: true }
        },
        { qualifyingWorkObserved: true },
      ),
      origin: slackThreadOrigin,
    })

    const result = await runTool(tool, { text: 'I saved it' })

    expect(sent).toBe(1)
    expect(result.details).toMatchObject({ ok: true })
  })

  test('addresses the message from the origin and forwards text to router.send', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'hi' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: '1700000000.000100',
      text: 'hi',
    })
    expect(result.details).toEqual({ ok: true })
  })

  test('passes preview suppression to the router for an origin reply', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: slackThreadOrigin,
    })
    await runTool(tool, { text: 'https://example.org', link_previews: false, more_work_this_turn: false })
    expect(calls[0]?.link_previews).toBe(false)
  })

  test('surfaces messageId and messageIds from the router result in details', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true, messageId: 'ts1', messageIds: ['ts1', 'ts2'] })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'hi' })
    expect(result.details).toEqual({ ok: true, messageId: 'ts1', messageIds: ['ts1', 'ts2'] })
  })

  test('strips a trailing tool-call leak from text, sending only the prose', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, {
      text: 'hmm, not really sure about that one\n\nskip_response({ reason: "no new info" })',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).toBe('hmm, not really sure about that one')
    expect(calls[0]!.text).not.toContain('skip_response')
    expect(result.details).toMatchObject({ ok: true })
  })

  test('combines more_work_this_turn with messageId when a mid-turn ack carries an id', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true, messageId: 'ts9', messageIds: ['ts9'] })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'working on it', more_work_this_turn: true })
    expect(result.details).toEqual({ ok: true, more_work_this_turn: true, messageId: 'ts9', messageIds: ['ts9'] })
  })

  test('passes thread=null verbatim when origin is a channel-root session', async () => {
    const captured: { thread: string | null | undefined } = { thread: undefined }
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        captured.thread = msg.thread ?? null
        return { ok: true }
      }),
      origin: slackChannelRootOrigin,
    })
    await runTool(tool, { text: 'top-level' })
    expect(captured.thread).toBeNull()
  })

  test('reports the origin chat AND echoes the sent text inside the SYSTEM MESSAGE fence', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'hi' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('posted to slack-bot:T0/C0: "hi"')
    expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(text.startsWith('---')).toBe(true)
  })

  test('echoes JSON-quoted text so the model can detect duplicates across iterations', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'hello, I am here!' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('"hello, I am here!"')
  })

  test('truncates echo past 500 chars and includes total length so context cost stays bounded', async () => {
    const long = 'a'.repeat(ECHO_MAX_CHARS * 4)
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: long })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain(`(${long.length} chars total)`)
    expect(text).toContain('...')
    expect(text.length).toBeLessThan(long.length)
  })

  test('reports denial back to the agent without throwing', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'nope' })
    expect(result.details).toEqual({ ok: false, error: 'denied by allow rules' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('channel_reply denied')
    expect(text).toContain('denied by allow rules')
  })

  test('reports outbound flood denial back to the agent without posting', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: false, error: OUTBOUND_FLOOD_ERROR, code: 'outbound-flood' })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'ㅋ'.repeat(500) })
    expect(result.details).toEqual({ ok: false, error: OUTBOUND_FLOOD_ERROR })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('channel_reply denied')
    expect(text).toContain(OUTBOUND_FLOOD_ERROR)
  })

  describe('tool-result framing', () => {
    // The self-reply loop (PR #481): a persona-rich model read its own
    // echoed prose as a fresh user turn and replied to it. The weak prefix
    // was insufficient, so the success result — which carries the model's
    // own words — must sit inside the strong SYSTEM MESSAGE fence with no
    // unfenced prose ahead of it.
    test('success branch wraps the echo in the SYSTEM MESSAGE fence so the model cannot read it as a user message', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'hi' })
      const text = (result.content[0] as { text: string }).text
      expect(text.startsWith('---')).toBe(true)
      expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
      expect(text).toContain('your OWN already-delivered message')
      expect(text).toContain('Do not acknowledge or reply to it')
      expect(text).not.toContain(TOOL_RESULT_PREFIX)
    })

    test('denial branch keeps the lighter prefix (no echoed prose to misread)', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' })),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'nope' })
      const text = (result.content[0] as { text: string }).text
      expect(text.startsWith(TOOL_RESULT_PREFIX)).toBe(true)
      expect(text).toContain('channel_reply denied')
    })

    test('fence wraps the echo even when the consecutive-send hint is appended', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 2 }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'continuing' })
      const text = (result.content[0] as { text: string }).text
      expect(text.startsWith('---')).toBe(true)
      expect(text).toContain('your OWN already-delivered message')
      expect(text).toContain('2nd consecutive message')
    })
  })

  test('second consecutive reply appends a soft yield hint', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 2 }),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'continuing' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('posted to slack-bot:T0/C0: "continuing"')
    expect(text).toContain('2nd consecutive message')
  })

  test('consecutive-send hint is fenced as a SYSTEM MESSAGE so persona-rich models cannot read it as chat', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true }), { consecutiveCount: 2 }),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'continuing' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(text).toContain('Do not acknowledge or reply to this notice')
    expect(text).toMatch(/---\s*\n\*\*\[SYSTEM MESSAGE/)
    expect(text).toMatch(/Do not acknowledge or reply to this notice\.\*\*\s*\n---/)
  })

  // PR #481: the model answered its own conversational reply ("you're
  // welcome!") because the echo of that text reached it with only the weak
  // prefix. The seductive prose must never appear ahead of the fence — the
  // model's first token of the tool result must be the fence opener.
  test('a conversational reply is echoed only INSIDE the fence, never as leading prose', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: "You're welcome! Happy to help 🌸" })
    const text = (result.content[0] as { text: string }).text
    expect(text.startsWith('---\n**[SYSTEM MESSAGE — not from a human]**')).toBe(true)
    const fenceBodyStart = text.indexOf('**[SYSTEM MESSAGE — not from a human]**')
    expect(text.indexOf("You're welcome!")).toBeGreaterThan(fenceBodyStart)
    expect(text).toContain('your OWN already-delivered message')
    expect(text).toContain('Do not acknowledge or reply to it')
  })

  // The model controls `attachment.filename`, so a conversational filename
  // ("You're welcome!.txt") is model-authored prose in the result too. The
  // fence must cover it the same way it covers the text echo — it must never
  // lead the result as unfenced prose.
  test('a conversational attachment filename is echoed only INSIDE the fence', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, {
      attachments: [{ path: '/agent/a.txt', filename: "You're welcome! Happy to help 🌸.txt" }],
    })
    const text = (result.content[0] as { text: string }).text
    expect(text.startsWith('---\n**[SYSTEM MESSAGE — not from a human]**')).toBe(true)
    const fenceBodyStart = text.indexOf('**[SYSTEM MESSAGE — not from a human]**')
    expect(text.indexOf("You're welcome!")).toBeGreaterThan(fenceBodyStart)
  })

  describe('renderEcho', () => {
    test('JSON-quotes short text', () => {
      expect(renderEcho('hi')).toBe('"hi"')
    })

    test('preserves multibyte characters under the limit', () => {
      expect(renderEcho('héllo wörld 🌍 café')).toBe('"héllo wörld 🌍 café"')
    })

    test('escapes embedded quotes via JSON.stringify', () => {
      expect(renderEcho('she said "hi"')).toBe('"she said \\"hi\\""')
    })

    test('truncates and reports total length past the limit', () => {
      const long = 'x'.repeat(ECHO_MAX_CHARS + 1)
      const out = renderEcho(long)
      expect(out).toContain(`(${long.length} chars total)`)
      expect(out).toContain('...')
    })

    test('does NOT truncate at exactly the limit (boundary)', () => {
      const exact = 'y'.repeat(ECHO_MAX_CHARS)
      const out = renderEcho(exact)
      expect(out).toBe(JSON.stringify(exact))
      expect(out).not.toContain('...')
    })
  })

  test('queries consecutive send count using the origin thread, not a hardcoded null', async () => {
    const queriedKeys: { adapter: string; workspace: string; chat: string; thread: string | null | undefined }[] = []
    const tool = createChannelReplyTool({
      router: {
        ...fakeRouter(async () => ({ ok: true })),
        getConsecutiveSendCount: (key) => {
          queriedKeys.push({ adapter: key.adapter, workspace: key.workspace, chat: key.chat, thread: key.thread })
          return 0
        },
      },
      origin: slackThreadOrigin,
    })
    await runTool(tool, { text: 'hi' })
    expect(queriedKeys).toHaveLength(1)
    expect(queriedKeys[0]).toEqual({
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: '1700000000.000100',
    })
  })

  test('denied replies never carry the consecutive hint suffix', async () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' }), { consecutiveCount: 7 }),
      origin: slackThreadOrigin,
    })
    const result = await runTool(tool, { text: 'no' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('denied')
    expect(text).not.toContain('consecutive')
  })

  test('schema rejects empty text via tool definition (smoke check on parameters)', () => {
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true })),
      origin: slackThreadOrigin,
    })
    expect(tool.name).toBe('channel_reply')
    expect(tool.label).toBe('Channel Reply')
    expect(tool.description).toContain('default way to respond')
  })

  describe('more_work_this_turn flag (mid-turn status reply)', () => {
    test('surfaces more_work_this_turn: true in details so the router keeps the turn alive', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'working on it…', more_work_this_turn: true })
      expect(result.details).toEqual({ ok: true, more_work_this_turn: true })
    })

    test('omits more_work_this_turn from details by default so the reply stays terminal', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'done' })
      expect(result.details).toEqual({ ok: true })
    })

    test('more_work_this_turn: false stays terminal (only true keeps the turn alive)', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'done', more_work_this_turn: false })
      expect(result.details).toEqual({ ok: true })
    })

    test('a denied reply never carries more_work_this_turn (no turn to keep alive)', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: false, error: 'denied by allow rules' })),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'nope', more_work_this_turn: true })
      expect(result.details).toEqual({ ok: false, error: 'denied by allow rules' })
    })

    test('more_work_this_turn is the one required parameter (so the schema rejects a reply that omits it)', () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: true })),
        origin: slackThreadOrigin,
      })
      expect((tool.parameters as { required?: readonly string[] }).required).toEqual(['more_work_this_turn'])
    })
  })

  describe('attachments', () => {
    test('forwards attachments and text to router.send', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      await runTool(tool, { text: 'see attached', attachments: [{ path: '/agent/r.pdf' }] })
      expect(calls[0]).toMatchObject({
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: '1700000000.000100',
        text: 'see attached',
        attachments: [{ path: '/agent/r.pdf' }],
      })
    })

    test('allows attachments without text', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackChannelRootOrigin,
      })
      const result = await runTool(tool, { attachments: [{ path: '/agent/a.png' }] })
      expect(result.details).toEqual({ ok: true })
      expect(calls[0]?.text).toBeUndefined()
    })

    test('rejects when neither text nor attachments are provided', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, {})
      expect(calls).toHaveLength(0)
      expect(result.details).toEqual({ ok: false, error: 'missing text and attachments' })
    })
  })

  describe('no-reply misuse guard', () => {
    test('blocks the send when text is exactly "NO_REPLY" and never invokes router.send', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'NO_REPLY' })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('silent-turn signal')
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_reply denied')
      expect(text).toContain('silent-turn signal')
      expect(text).not.toContain('posted to')
    })

    test('blocks on whitespace-padded "NO_REPLY" (mirrors router trim semantics)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: '\tNO_REPLY  ' })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
    })

    test('does NOT block when "NO_REPLY" appears as a substring inside a real message', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'I will reply NO_REPLY only when asked' })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('does NOT block on lowercase or other casings (must match exactly)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'no_reply' })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })

    test('blocks the parenthesized "(NO_REPLY)" form (mirrors router lenience)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: '(NO_REPLY)' })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('silent-turn signal')
    })

    for (const loud of ['**NO_REPLY**', '`NO_REPLY`', '*NO_REPLY*']) {
      test(`blocks the loud ${loud} form (mirrors router lenience)`, async () => {
        const calls: OutboundMessage[] = []
        const tool = createChannelReplyTool({
          router: fakeRouter(async (msg) => {
            calls.push(msg)
            return { ok: true }
          }),
          origin: slackThreadOrigin,
        })
        const result = await runTool(tool, { text: loud })
        expect(calls).toHaveLength(0)
        expect(result.details).toMatchObject({ ok: false })
        expect((result.details as { error: string }).error).toContain('silent-turn signal')
      })
    }
  })

  describe('upstream empty-response sentinel guard', () => {
    test('blocks `(Empty response: {...stop_reason...})` so thinking content + signature never reach the channel', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, {
        text:
          "(Empty response: {'content': [{'type': 'thinking', 'thinking': 'leak', " +
          "'signature': 'EpQC...'}], 'stop_reason': 'end_turn'})",
      })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('Empty response')
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_reply denied')
      expect(text).not.toContain('posted to')
    })

    test('does NOT block legit prose mentioning "Empty response" without the python-dict shape', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'Empty response from the cache layer; retrying now.' })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })
  })

  describe('Kimi tool-call delimiter leak guard', () => {
    test('blocks raw `<|tool_call_argument_begin|>...<|tool_calls_section_end|>` tokens from reaching the channel', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, {
        text: 'channel_reply:0<|tool_call_argument_begin|>{"text": "hi"}<|tool_calls_section_end|>',
      })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('provider tool-call control tokens')
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_reply denied')
      expect(text).not.toContain('posted to')
    })

    test('blocks the per-call begin marker even when section markers are absent (partial parser leak)', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, {
        text: '<|tool_call_begin|>functions.channel_reply:0<|tool_call_argument_begin|>{"text": "hi"}<|tool_call_end|>',
      })
      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
    })

    test('does NOT block legit prose mentioning tool names without Kimi delimiter tokens', async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, {
        text: 'I called channel_reply:0 in the earlier turn, here are the results.',
      })
      expect(calls).toHaveLength(1)
      expect(result.details).toEqual({ ok: true })
    })
  })

  describe('structured router failures surface as denials', () => {
    test('duplicate code from router renders as channel_reply denied with router error text', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: false, error: 'Duplicate not sent. ...', code: 'duplicate' })),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'same body' })
      expect(result.details).toEqual({ ok: false, error: 'Duplicate not sent. ...' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_reply denied')
      expect(text).toContain('Duplicate not sent')
      expect(text).not.toContain('posted to')
    })

    test('turn-cap code from router renders as channel_reply denied', async () => {
      const tool = createChannelReplyTool({
        router: fakeRouter(async () => ({ ok: false, error: 'Send-cap reached for this turn ...', code: 'turn-cap' })),
        origin: slackThreadOrigin,
      })
      const result = await runTool(tool, { text: 'eleventh message' })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain('channel_reply denied')
      expect(text).toContain('Send-cap reached')
    })
  })
})

describe('renderOutboundEcho', () => {
  test('text only renders the JSON-quoted text', () => {
    expect(renderOutboundEcho('hi', undefined)).toBe('"hi"')
  })

  test('attachments only renders count and filenames', () => {
    expect(renderOutboundEcho(undefined, [{ path: '/agent/a.png' }, { path: '/agent/b.pdf' }])).toBe(
      '2 file(s): a.png, b.pdf',
    )
  })

  test('both combines echo and filename summary', () => {
    expect(renderOutboundEcho('caption', [{ path: '/agent/a.png' }])).toBe('"caption" + 1 file(s): a.png')
  })

  test('attachment.filename overrides the basename in the echo', () => {
    expect(renderOutboundEcho(undefined, [{ path: '/agent/tmp-XYZ.bin', filename: 'report.pdf' }])).toBe(
      '1 file(s): report.pdf',
    )
  })

  test('empty input renders a sentinel', () => {
    expect(renderOutboundEcho(undefined, undefined)).toBe('(empty)')
    expect(renderOutboundEcho('', [])).toBe('(empty)')
  })
})

const githubThreadOrigin: ChannelReplyOrigin = {
  adapter: 'github',
  workspace: 'acme/widgets',
  chat: 'pr:585',
  thread: '3343107661',
}

describe('channel_reply resolve_review_thread', () => {
  test('resolves the thread before posting the acknowledgement', async () => {
    const order: string[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async () => {
          order.push('send')
          return { ok: true }
        },
        {
          resolveReviewThread: async (req) => {
            order.push(`resolve:${req.rootCommentId}`)
            return { ok: true }
          },
        },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Verified — fix looks solid.', resolve_review_thread: true })

    expect(order).toEqual(['resolve:3343107661', 'send'])
    expect(result.details).toEqual({ ok: true })
  })

  test('reports success without posting when the thread was already resolved', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        { resolveReviewThread: async () => ({ ok: true, alreadyResolved: true }) },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Verified — fix looks solid.', resolve_review_thread: true })

    expect(calls).toHaveLength(0)
    expect(result.details).toEqual({ ok: true })
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('already resolved')
    expect(rendered).toContain('no acknowledgement comment was posted')
  })

  test('posts only one acknowledgement when concurrent close-outs target the same thread', async () => {
    let resolved = false
    let mutations = 0
    const fetchImpl = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
        if (body.query.includes('resolveReviewThread(input')) {
          mutations += 1
          resolved = true
          return new Response(
            JSON.stringify({
              data: { resolveReviewThread: { thread: { id: 'PRRT_CONCURRENT', isResolved: true } } },
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'PRRT_CONCURRENT',
                        isResolved: resolved,
                        comments: {
                          nodes: [
                            {
                              databaseId: Number(githubThreadOrigin.thread),
                              author: { __typename: 'Bot', login: 'bot' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          { status: 200 },
        )
      },
      { preconnect: () => {} },
    )
    const resolveReviewThread = createGithubReviewThreadResolver({
      token: async () => 'tok',
      selfLogin: () => 'bot[bot]',
      fetchImpl,
    })
    const sent: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          sent.push(msg)
          return { ok: true }
        },
        { resolveReviewThread },
      ),
      origin: githubThreadOrigin,
    })

    const results = await Promise.all([
      runTool(tool, { text: 'Verified — fix looks solid.', resolve_review_thread: true }),
      runTool(tool, { text: 'Verified — fix looks solid.', resolve_review_thread: true }),
    ])
    const rendered = results.map((result) => (result.content[0] as { text: string }).text)

    expect(results.every((result) => result.details.ok)).toBe(true)
    expect(rendered.filter((text) => text.includes('already resolved'))).toHaveLength(1)
    expect(rendered.filter((text) => text.includes('posted to github:acme/widgets/pr:585'))).toHaveLength(1)
    expect(mutations).toBe(1)
    expect(sent).toHaveLength(1)
  })

  test('blocks the reply when the resolve fails', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        { resolveReviewThread: async () => ({ ok: false, error: 'GitHub GraphQL 403', code: 'permission-denied' }) },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Looks resolved.', resolve_review_thread: true })

    expect(calls).toHaveLength(0)
    expect(result.details).toEqual({ ok: false, error: 'could not resolve review thread: GitHub GraphQL 403' })
  })

  test('refuses to resolve a thread the bot did not author and does not post', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        {
          resolveReviewThread: async () => ({
            ok: false,
            error: 'refusing to resolve thread authored by @human (not @bot[bot])',
            code: 'not-author',
          }),
        },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Thanks!', resolve_review_thread: true })

    expect(calls).toHaveLength(0)
    expect(result.details.ok).toBe(false)
  })

  test('posts a no-match resolve (non-blocking) but warns the resolve did not fire', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        { resolveReviewThread: async () => ({ ok: false, error: 'no thread', code: 'no-match' }) },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Done.', resolve_review_thread: true })

    expect(calls).toHaveLength(1)
    expect(result.details.ok).toBe(true)
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('3343107661')
    expect(rendered).toContain('was not resolved')
  })

  test('blocks the reply on an HTTP 404 lookup (not-found is NOT no-match)', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        { resolveReviewThread: async () => ({ ok: false, error: 'GitHub GraphQL 404', code: 'not-found' }) },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Done.', resolve_review_thread: true })

    expect(calls).toHaveLength(0)
    expect(result.details.ok).toBe(false)
  })

  test('rejects the flag on a non-github origin without posting', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: slackThreadOrigin,
    })

    const result = await runTool(tool, { text: 'hi', resolve_review_thread: true })

    expect(calls).toHaveLength(0)
    expect(result.details.ok).toBe(false)
  })

  test('rejects the flag when the github origin has no thread', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: { adapter: 'github', workspace: 'acme/widgets', chat: 'pr:585', thread: null },
    })

    const result = await runTool(tool, { text: 'hi', resolve_review_thread: true })

    expect(calls).toHaveLength(0)
    expect(result.details.ok).toBe(false)
  })

  test('does not attempt resolution on an explicit false (thread stays open)', async () => {
    let resolveCalled = false
    let sent = 0
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async () => {
          sent++
          return { ok: true }
        },
        {
          resolveReviewThread: async () => {
            resolveCalled = true
            return { ok: true, alreadyResolved: true }
          },
        },
      ),
      origin: githubThreadOrigin,
    })

    await runTool(tool, { text: 'plain reply', resolve_review_thread: false })

    expect(resolveCalled).toBe(false)
    expect(sent).toBe(1)
  })

  test('records an explicit false only after its exact-thread reply succeeds', async () => {
    const decisions: string[] = []
    const success = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true }), {
        finishGithubReviewThreadCloseout: ({ decision }) => decisions.push(decision),
      }),
      origin: githubThreadOrigin,
    })
    const failure = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: false, error: 'send failed' }), {
        finishGithubReviewThreadCloseout: ({ decision }) => decisions.push(decision),
      }),
      origin: githubThreadOrigin,
    })

    await runTool(success, { text: 'This remains open for a concrete reason.', resolve_review_thread: false })
    await runTool(failure, { text: 'This remains open for a concrete reason.', resolve_review_thread: false })

    expect(decisions).toEqual(['left-open'])
  })
})

describe('channel_reply resolve_review_thread required-choice enforcement', () => {
  test('denies a terminal github review-thread text reply that omits the resolve choice', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Thanks for the context — makes sense.' })

    expect(calls).toHaveLength(0)
    expect(result.details).toMatchObject({ ok: false })
    expect((result.details as { error: string }).error).toContain('resolve_review_thread')
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('channel_reply denied')
    expect(rendered).not.toContain('posted to')
  })

  test('proceeds when the resolve choice is an explicit false (thread kept open)', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Still looking into this one.', resolve_review_thread: false })

    expect(calls).toHaveLength(1)
    expect(result.details).toEqual({ ok: true })
  })

  test('exempts a mid-turn status reply (more_work_this_turn:true) when it makes no close-out choice', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'On it — checking the diff now.', more_work_this_turn: true })

    expect(calls).toHaveLength(1)
    expect(result.details).toEqual({ ok: true, more_work_this_turn: true })
  })

  for (const resolveReviewThread of [true, false]) {
    test(`rejects resolve_review_thread:${resolveReviewThread} on a mid-turn status reply`, async () => {
      const calls: OutboundMessage[] = []
      const tool = createChannelReplyTool({
        router: fakeRouter(async (msg) => {
          calls.push(msg)
          return { ok: true }
        }),
        origin: githubThreadOrigin,
      })

      const result = await runTool(tool, {
        text: 'Still checking.',
        more_work_this_turn: true,
        resolve_review_thread: resolveReviewThread,
      })

      expect(calls).toHaveLength(0)
      expect(result.details).toMatchObject({ ok: false })
      expect((result.details as { error: string }).error).toContain('more_work_this_turn')
    })
  }

  test('exempts an attachments-only github review-thread reply (no text to acknowledge)', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { attachments: [{ path: '/agent/diff.png' }] })

    expect(calls).toHaveLength(1)
    expect(result.details).toEqual({ ok: true })
  })

  test('does not require the choice on a github PR reply outside a review thread (thread === null)', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: { adapter: 'github', workspace: 'acme/widgets', chat: 'pr:585', thread: null },
    })

    const result = await runTool(tool, { text: 'General note on the PR.' })

    expect(calls).toHaveLength(1)
    expect(result.details).toEqual({ ok: true })
  })

  test('does not require the choice on a non-github review-thread reply', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => {
        calls.push(msg)
        return { ok: true }
      }),
      origin: slackThreadOrigin,
    })

    const result = await runTool(tool, { text: 'done' })

    expect(calls).toHaveLength(1)
    expect(result.details).toEqual({ ok: true })
  })

  test('an explicit true still drives the existing resolve-before-post path', async () => {
    const order: string[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async () => {
          order.push('send')
          return { ok: true }
        },
        {
          resolveReviewThread: async (req) => {
            order.push(`resolve:${req.rootCommentId}`)
            return { ok: true }
          },
        },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Verified — fix looks solid.', resolve_review_thread: true })

    expect(order).toEqual(['resolve:3343107661', 'send'])
    expect(result.details).toEqual({ ok: true })
  })
})

describe('channel_reply re-review stranding guard', () => {
  test('blocks a thread close-out while the bot still holds CHANGES_REQUESTED, resolving nothing', async () => {
    const calls: OutboundMessage[] = []
    let resolveCalled = false
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        {
          resolveReviewThread: async () => {
            resolveCalled = true
            return { ok: true }
          },
          getReviewState: async () => ({ ok: true, selfBlocking: true, selfBlockingReviewId: null, approve: true }),
        },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Verified — that closes it, thanks!', resolve_review_thread: true })

    expect(result.details.ok).toBe(false)
    expect(resolveCalled).toBe(false)
    expect(calls).toHaveLength(0)
    expect((result.content[0] as { text: string }).text).toContain('APPROVE')
  })

  test('allows the close-out once the bot no longer blocks the PR', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        { getReviewState: async () => ({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true }) },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Verified — that closes it, thanks!', resolve_review_thread: true })

    expect(result.details.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('resolves and acknowledges a non-carrier sibling once GitHub says the block is gone', async () => {
    const round = {
      kind: 'push',
      roundId: 'test-round',
      workspace: 'acme/widgets',
      prNumber: 644,
      headSha: 'sha-round',
      carrierThread: '111',
    } as const
    registerGithubReviewRound(round)
    const order: string[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async () => {
          order.push('ack')
          return { ok: true }
        },
        {
          getReviewState: async () => ({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true }),
          resolveReviewThread: async () => {
            order.push('resolve')
            return { ok: true }
          },
          finishGithubReviewThreadCloseout: ({ decision }) => {
            expect(decision).toBe('resolved')
            order.push('finish')
          },
        },
      ),
      origin: {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:644',
        thread: '222',
        githubReviewRound: round,
      },
    })

    const result = await runTool(tool, {
      text: 'This thread concern is addressed.',
      resolve_review_thread: true,
    })

    expect(result.details.ok).toBe(true)
    expect(order).toEqual(['resolve', 'finish', 'ack'])
    __resetReviewVerdictGuardForTest()
  })

  test('fails closed when review state cannot be verified', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        { getReviewState: async () => ({ ok: false, error: 'GitHub reviews 503', code: 'transient' }) },
      ),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, { text: 'Verified — that closes it, thanks!', resolve_review_thread: true })

    expect(result.details.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test('does not query review state for a plain discussion reply', async () => {
    let queried = false
    const tool = createChannelReplyTool({
      router: fakeRouter(async () => ({ ok: true }), {
        getReviewState: async () => {
          queried = true
          return { ok: true, selfBlocking: true, selfBlockingReviewId: null, approve: true }
        },
      }),
      origin: githubThreadOrigin,
    })

    const result = await runTool(tool, {
      text: 'Thanks for the context — makes sense.',
      resolve_review_thread: false,
    })

    expect(result.details.ok).toBe(true)
    expect(queried).toBe(false)
  })

  test('blocks a warn-tier "Looks good" PR comment while the bot still blocks the PR (PR #649)', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        { getReviewState: async () => ({ ok: true, selfBlocking: true, selfBlockingReviewId: null, approve: true }) },
      ),
      origin: { adapter: 'github', workspace: 'acme/widgets', chat: 'pr:649', thread: null },
    })

    const result = await runTool(tool, {
      text: 'Looks good — the remaining leak paths are fixed. Tests are green, so this is a solid cleanup. ✨',
    })

    expect(result.details.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect((result.content[0] as { text: string }).text).toContain('APPROVE')
  })

  test('allows a warn-tier "Looks good" PR comment when the bot holds no block', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        { getReviewState: async () => ({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true }) },
      ),
      origin: { adapter: 'github', workspace: 'acme/widgets', chat: 'pr:649', thread: null },
    })

    const result = await runTool(tool, { text: 'Looks good, nice work!' })

    expect(result.details.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('blocks a warn-tier LGTM PR comment while GitHub still requires formal review (PR #653)', async () => {
    const calls: OutboundMessage[] = []
    const tool = createChannelReplyTool({
      router: fakeRouter(
        async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
        {
          getReviewState: async () => ({
            ok: true,
            selfBlocking: false,
            selfBlockingReviewId: null,
            approve: true,
            reviewDecision: 'REVIEW_REQUIRED',
          }),
        },
      ),
      origin: { adapter: 'github', workspace: 'acme/widgets', chat: 'pr:653', thread: null },
    })

    const result = await runTool(tool, {
      text: 'LGTM — the dedupe is scoped to the per-session turn boundary exactly as described.',
    })

    expect(result.details.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect((result.content[0] as { text: string }).text).toContain('formal GitHub review')
  })
})
