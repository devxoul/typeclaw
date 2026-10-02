import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { OutboundMessage, SendResult } from '@/channels/types'

import type { ChannelToolLogger } from './channel-log'
import { createSkipResponseTool } from './skip-response'

type MarkTurnSkippedResult = ReturnType<ChannelRouter['markTurnSkipped']>

function fakeRouter(
  opts: {
    markResult?: MarkTurnSkippedResult
    sendHandler?: (msg: OutboundMessage) => Promise<SendResult>
    markCalls?: Array<{ parentSessionId: string; reason: string }>
  } = {},
): ChannelRouter {
  return {
    route: async () => {},
    send: opts.sendHandler ?? (async () => ({ ok: false, error: 'no adapter', code: 'no-adapter' as const })),
    getConsecutiveSendCount: () => 0,
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
    fetchAttachment: async () => ({ ok: false, error: 'no fetchAttachment' }),
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
    noteGithubReviewOutput: () => ({ kind: 'no-live-session' }),
    markTurnSkipped: (args) => {
      opts.markCalls?.push({ parentSessionId: args.parentSessionId, reason: args.reason })
      return opts.markResult ?? { kind: 'recorded', keyId: 'discord-bot:g1:c1' }
    },
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
  }
}

function memoryLogger(): { logger: ChannelToolLogger; warns: string[] } {
  const warns: string[] = []
  return {
    warns,
    logger: { warn: (m) => warns.push(m) },
  }
}

const fakeCtx = {} as Parameters<ReturnType<typeof createSkipResponseTool>['execute']>[4]

async function runTool(
  tool: ReturnType<typeof createSkipResponseTool>,
  params: Parameters<ReturnType<typeof createSkipResponseTool>['execute']>[1],
) {
  return tool.execute('toolcall_1', params, undefined, undefined, fakeCtx)
}

describe('createSkipResponseTool', () => {
  test('happy path: calls markTurnSkipped with sessionId+reason and returns suppressed=true', async () => {
    const markCalls: Array<{ parentSessionId: string; reason: string }> = []
    const tool = createSkipResponseTool({
      router: fakeRouter({ markCalls }),
      sessionId: 'ses_abc',
    })
    const result = await runTool(tool, { reason: 'no new info to add' })

    expect(markCalls).toEqual([{ parentSessionId: 'ses_abc', reason: 'no new info to add' }])
    expect(result.details).toEqual({ ok: true, suppressed: true, reason: 'no new info to add' })
    expect(result.content[0]?.type).toBe('text')
    const body = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(body).toContain('skip_response accepted')
    expect(body).toContain('"no new info to add"')
    expect(body).toContain('do not call channel_reply')
  })

  test('reason is trimmed before being forwarded so leading/trailing whitespace does not pollute logs', async () => {
    const markCalls: Array<{ parentSessionId: string; reason: string }> = []
    const tool = createSkipResponseTool({
      router: fakeRouter({ markCalls }),
      sessionId: 'ses_abc',
    })
    await runTool(tool, { reason: '   trimmed reason   ' })

    expect(markCalls[0]?.reason).toBe('trimmed reason')
  })

  test('empty reason (whitespace-only) is rejected without calling markTurnSkipped', async () => {
    const markCalls: Array<{ parentSessionId: string; reason: string }> = []
    const { logger, warns } = memoryLogger()
    const tool = createSkipResponseTool({
      router: fakeRouter({ markCalls }),
      sessionId: 'ses_abc',
      logger,
    })
    const result = await runTool(tool, { reason: '     ' })

    expect(markCalls).toEqual([])
    expect(result.details).toMatchObject({ ok: false, suppressed: false, error: 'empty reason' })
    expect(warns.some((w) => w.includes('empty reason'))).toBe(true)
  })

  test('recorded-after-send: tool accepts as a terminal no-op (reply stands, nothing more sent)', async () => {
    const markCalls: Array<{ parentSessionId: string; reason: string }> = []
    const tool = createSkipResponseTool({
      router: fakeRouter({
        markCalls,
        markResult: { kind: 'recorded-after-send', keyId: 'discord-bot:g1:c1' },
      }),
      sessionId: 'ses_abc',
    })
    const result = await runTool(tool, { reason: 'waiting for reviewer subagent' })

    expect(result.details).toMatchObject({
      ok: true,
      suppressed: false,
      reason: 'waiting for reviewer subagent',
    })
    expect(result.details.error).toBeUndefined()
    const body = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(body).toContain('skip_response accepted')
    expect(body).toContain('End your turn now')
    expect(markCalls).toHaveLength(1)
  })

  test('no live session: tool still returns ok but suppressed=false and logs a warning', async () => {
    const { logger, warns } = memoryLogger()
    const tool = createSkipResponseTool({
      router: fakeRouter({ markResult: { kind: 'no-live-session' } }),
      sessionId: 'ses_unmatched',
      logger,
    })
    const result = await runTool(tool, { reason: 'whatever' })

    expect(result.details).toEqual({ ok: true, suppressed: false, reason: 'whatever' })
    const body = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(body).toContain('no live channel session found')
    expect(warns.some((w) => w.includes('no live channel session for sessionId=ses_unmatched'))).toBe(true)
  })

  test('tool schema: name, label, and parameters expose the structured-silence contract to the model', () => {
    const tool = createSkipResponseTool({ router: fakeRouter(), sessionId: 'ses_x' })
    expect(tool.name).toBe('skip_response')
    expect(tool.label).toBe('Skip Response')
    expect(tool.description).toContain('NO_REPLY')
    expect(tool.description).toContain('channel_reply')
    expect(tool.description).toContain('logs')
    // Parameter schema must require a string `reason` with a finite max so
    // the model cannot dump unbounded chain-of-thought into operator logs.
    const reasonProp = (tool.parameters as { properties: { reason: { maxLength?: number; minLength?: number } } })
      .properties.reason
    expect(reasonProp.minLength).toBe(1)
    expect(reasonProp.maxLength).toBe(500)
  })
})
