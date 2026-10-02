import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { EditMessageRequest, EditMessageResult } from '@/channels/types'

import { createChannelEditTool } from './channel-edit'

function fakeRouter(handler: (req: EditMessageRequest) => Promise<EditMessageResult>): ChannelRouter {
  return {
    route: async () => {},
    send: async () => ({ ok: true }),
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
    registerTyping: () => {},
    unregisterTyping: () => {},
    setTypingCapability: () => {},
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
    editMessage: handler,
    registerFetchAttachment: () => {},
    unregisterFetchAttachment: () => {},
    fetchAttachment: async () => ({ ok: false, error: 'no fetchAttachment callback registered' }),
    registerReviewThreadResolver: () => {},
    unregisterReviewThreadResolver: () => {},
    resolveReviewThread: async () => ({ ok: true }),
    registerReviewStateResolver: () => {},
    unregisterReviewStateResolver: () => {},
    getReviewState: async () => ({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true }),
    lookupInboundAttachment: () => null,
    listInboundAttachmentIds: () => [],
    registerHistoryAttachments: () => {},
    getSelfAliases: () => [],
    stop: async () => {},
    tearDownAllLive: async () => {},
    markRestartAbortForAllLive: async () => {},
    liveCount: () => 0,
    executeCommand: async () => ({ kind: 'no-live-session' }),
    injectSubagentCompletionReminder: async () => ({ kind: 'no-live-session' }),
    injectPrVerdictActivity: () => ({ kind: 'delivered', count: 0 }),
    noteGithubReviewOutput: async () => ({ kind: 'no-live-session' }),
    markTurnSkipped: async () => ({ kind: 'no-live-session' }),
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
  } as unknown as ChannelRouter
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelEditTool>['execute']>[4]

const params = (over: Record<string, unknown> = {}) => ({
  adapter: 'slack-bot' as const,
  workspace: 'T1',
  chat: 'C1',
  message_id: '1700000000.000100',
  text: 'corrected body',
  ...over,
})

function run(
  tool: ReturnType<typeof createChannelEditTool>,
  p: Parameters<ReturnType<typeof createChannelEditTool>['execute']>[1],
) {
  return tool.execute('id', p, undefined, undefined, fakeCtx)
}

const silentLogger = { warn: () => {} }

function errorOf(details: unknown): string {
  return (details as { error?: string }).error ?? ''
}

describe('channel_edit tool', () => {
  test('forwards adapter/workspace/chat/message_id/text to router.editMessage', async () => {
    const captured: EditMessageRequest[] = []
    const tool = createChannelEditTool({
      router: fakeRouter(async (req) => {
        captured.push(req)
        return { ok: true }
      }),
    })

    const res = await run(tool, params())

    expect(res.details).toEqual({ ok: true })
    expect(captured).toEqual([
      { adapter: 'slack-bot', workspace: 'T1', chat: 'C1', messageId: '1700000000.000100', text: 'corrected body' },
    ])
  })

  test('passes an optional thread through to the router', async () => {
    const captured: EditMessageRequest[] = []
    const tool = createChannelEditTool({
      router: fakeRouter(async (req) => {
        captured.push(req)
        return { ok: true }
      }),
    })

    await run(tool, params({ thread: 'root-ts' }))

    expect(captured[0]).toMatchObject({ thread: 'root-ts' })
  })

  test('surfaces a router failure as a denial with the adapter-scoped error and code', async () => {
    const tool = createChannelEditTool({
      router: fakeRouter(async () => ({ ok: false, error: 'cant_update_message', code: 'permission-denied' })),
      logger: silentLogger,
    })

    const res = await run(tool, params())

    expect(res.details).toMatchObject({ ok: false, code: 'permission-denied' })
    expect(errorOf(res.details)).toContain('cant_update_message')
  })

  test('passes the not-supported code through so agents can branch on it', async () => {
    const tool = createChannelEditTool({
      router: fakeRouter(async () => ({ ok: false, error: 'message-edit-not-supported', code: 'not-supported' })),
      logger: silentLogger,
    })

    const res = await run(tool, params({ adapter: 'kakaotalk' }))

    expect(res.details).toMatchObject({ ok: false, code: 'not-supported' })
  })

  test('passes the adapter-unavailable code through so agents can retry after re-auth', async () => {
    const tool = createChannelEditTool({
      router: fakeRouter(async () => ({
        ok: false,
        error: 'message-edit-adapter-unavailable',
        code: 'adapter-unavailable',
      })),
      logger: silentLogger,
    })

    const res = await run(tool, params({ adapter: 'telegram-bot' }))

    expect(res.details).toMatchObject({ ok: false, code: 'adapter-unavailable' })
  })

  test('strips a leaked <think> block from the replacement before calling the router', async () => {
    const captured: EditMessageRequest[] = []
    const tool = createChannelEditTool({
      router: fakeRouter(async (req) => {
        captured.push(req)
        return { ok: true }
      }),
    })

    const res = await run(tool, params({ text: '<think>hidden</think>the real edit' }))

    expect(res.details).toEqual({ ok: true })
    expect(captured[0]?.text).toBe('the real edit')
  })

  test('denies an edit that is only a think block before it reaches the router', async () => {
    let called = false
    const tool = createChannelEditTool({
      router: fakeRouter(async () => {
        called = true
        return { ok: true }
      }),
      logger: silentLogger,
    })

    const res = await run(tool, params({ text: '<think>just reasoning</think>' }))

    expect(called).toBe(false)
    expect(res.details).toMatchObject({ ok: false })
    expect(errorOf(res.details)).toContain('empty after removing reasoning')
  })

  test('blocks a NO_REPLY body before it reaches the router', async () => {
    let called = false
    const tool = createChannelEditTool({
      router: fakeRouter(async () => {
        called = true
        return { ok: true }
      }),
      logger: silentLogger,
    })

    const res = await run(tool, params({ text: 'NO_REPLY' }))

    expect(called).toBe(false)
    expect(res.details).toMatchObject({ ok: false })
    expect(errorOf(res.details)).toContain('NO_REPLY')
  })
})
