import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ChannelRouter } from '@/channels/router'
import type {
  FetchAttachmentResult,
  FetchHistoryResult,
  InboundAttachment,
  OutboundMessage,
  SendResult,
} from '@/channels/types'

import { createChannelFetchAttachmentTool } from './channel-fetch-attachment'
import { createChannelHistoryTool } from './channel-history'
import type { ChannelToolLogger } from './channel-log'
import { createChannelReplyTool } from './channel-reply'
import { createChannelSendTool } from './channel-send'

type CapturedLogger = ChannelToolLogger & { warnings: string[] }

function captureLogger(): CapturedLogger {
  const warnings: string[] = []
  return {
    warnings,
    warn: (m) => {
      warnings.push(m)
    },
  }
}

type RouterOverrides = {
  send?: (msg: OutboundMessage) => Promise<SendResult>
  fetchHistory?: () => Promise<FetchHistoryResult>
  fetchAttachment?: () => Promise<FetchAttachmentResult>
  attachments?: readonly InboundAttachment[]
}

function fakeRouter(overrides: RouterOverrides = {}): ChannelRouter {
  return {
    route: async () => {},
    send: overrides.send ?? (async () => ({ ok: true })),
    getConsecutiveSendCount: () => 0,
    getSendRate: () => ({ count: 0, windowMs: 5_000 }),
    registerOutbound: () => {},
    unregisterOutbound: () => {},
    registerRecoveryAdapter: () => {},
    unregisterRecoveryAdapter: () => {},
    getRecoveryAccountIdentity: async () => undefined,
    validateRecovery: async () => undefined,
    reconcileRecovery: async () => ({ status: 'unreconcilable' }),
    setRecoveryStopHandler: () => {},
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
    fetchHistory: overrides.fetchHistory ?? (async () => ({ ok: false, error: 'history-not-supported' })),
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
    fetchAttachment: overrides.fetchAttachment ?? (async () => ({ ok: false, error: 'no callback' })),
    registerReviewThreadResolver: () => {},
    unregisterReviewThreadResolver: () => {},
    resolveReviewThread: async () => ({ ok: true }),
    registerReviewStateResolver: () => {},
    unregisterReviewStateResolver: () => {},
    getReviewState: async () => ({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true }),
    registerReviewSubmitter: () => {},
    unregisterReviewSubmitter: () => {},
    submitReview: async () => ({ ok: true, reviewId: 1, state: 'COMMENTED' }),
    lookupInboundAttachment: (args) => overrides.attachments?.find((attachment) => attachment.id === args.id) ?? null,
    listInboundAttachmentIds: () => (overrides.attachments ?? []).map((attachment) => attachment.id),
    registerHistoryAttachments: () => {},
    getSelfAliases: () => [],
    stop: async () => {},
    tearDownAllLive: async () => {},
    markRestartAbortForAllLive: async () => {},
    liveCount: () => 0,
    executeCommand: async () => ({ kind: 'no-live-session' }),
    injectSubagentCompletionReminder: () => ({ kind: 'no-live-session' }),
    injectPrVerdictActivity: () => ({ kind: 'delivered', count: 0 }),
    noteGithubReviewOutput: () => ({ kind: 'no-live-session' }),
    markTurnSkipped: () => ({ kind: 'no-live-session' }),
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
  }
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelSendTool>['execute']>[4]
const attachmentOrigin = { adapter: 'slack-bot' as const, workspace: 'T0', chat: 'C0', thread: null }

describe('channel_send failure logging', () => {
  test('logs router.send rejection with adapter+chat context', async () => {
    const logger = captureLogger()
    const tool = createChannelSendTool({
      router: fakeRouter({ send: async () => ({ ok: false, error: 'denied by allow rules' }) }),
      logger,
    })
    await tool.execute(
      'id',
      { adapter: 'slack-bot', workspace: 'T0', chat: 'C-blocked', text: 'no' },
      undefined,
      undefined,
      fakeCtx,
    )
    expect(logger.warnings).toEqual(['[channels] channel_send failed: slack-bot:T0/C-blocked: denied by allow rules'])
  })

  test('logs the early validation failure when text and attachments are both missing', async () => {
    const logger = captureLogger()
    const tool = createChannelSendTool({ router: fakeRouter(), logger })
    await tool.execute('id', { adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toEqual(['[channels] channel_send failed: missing text and attachments'])
  })

  test('logs the NO_REPLY misuse denial before any router.send call', async () => {
    const logger = captureLogger()
    const calls: OutboundMessage[] = []
    const tool = createChannelSendTool({
      router: fakeRouter({
        send: async (msg) => {
          calls.push(msg)
          return { ok: true }
        },
      }),
      logger,
    })
    await tool.execute(
      'id',
      { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'NO_REPLY' },
      undefined,
      undefined,
      fakeCtx,
    )
    expect(calls).toHaveLength(0)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('[channels] channel_send failed:')
    expect(logger.warnings[0]).toContain('silent-turn signal')
  })

  test('does NOT log on a successful send', async () => {
    const logger = captureLogger()
    const tool = createChannelSendTool({ router: fakeRouter({ send: async () => ({ ok: true }) }), logger })
    await tool.execute(
      'id',
      { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', text: 'hi' },
      undefined,
      undefined,
      fakeCtx,
    )
    expect(logger.warnings).toEqual([])
  })
})

describe('channel_reply failure logging', () => {
  const origin = { adapter: 'slack-bot' as const, workspace: 'T0', chat: 'C0', thread: '1700000000.0001' }

  test('logs router.send rejection with origin context', async () => {
    const logger = captureLogger()
    const tool = createChannelReplyTool({
      router: fakeRouter({ send: async () => ({ ok: false, error: 'channel_not_found' }) }),
      origin,
      logger,
    })
    await tool.execute('id', { text: 'hi', more_work_this_turn: false }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toEqual(['[channels] channel_reply failed: slack-bot:T0/C0: channel_not_found'])
  })

  test('logs early validation when text and attachments are both missing', async () => {
    const logger = captureLogger()
    const tool = createChannelReplyTool({ router: fakeRouter(), origin, logger })
    await tool.execute('id', { more_work_this_turn: false }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toEqual(['[channels] channel_reply failed: missing text and attachments'])
  })

  test('does NOT log on a successful reply', async () => {
    const logger = captureLogger()
    const tool = createChannelReplyTool({ router: fakeRouter({ send: async () => ({ ok: true }) }), origin, logger })
    await tool.execute('id', { text: 'ok', more_work_this_turn: false }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toEqual([])
  })
})

describe('channel_history failure logging', () => {
  test('logs fetchHistory upstream errors with adapter+chat context', async () => {
    const logger = captureLogger()
    const tool = createChannelHistoryTool({
      router: fakeRouter({ fetchHistory: async () => ({ ok: false, error: 'rate_limited' }) }),
      origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
      logger,
    })
    await tool.execute('id', { scope: 'channel' }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toEqual(['[channels] channel_history failed: slack-bot:C0: rate_limited'])
  })

  test('logs the thread-scope-on-channel-root denial without calling fetchHistory', async () => {
    const logger = captureLogger()
    let called = false
    const tool = createChannelHistoryTool({
      router: fakeRouter({
        fetchHistory: async () => {
          called = true
          return { ok: true, messages: [] }
        },
      }),
      origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
      logger,
    })
    await tool.execute('id', { scope: 'thread' }, undefined, undefined, fakeCtx)
    expect(called).toBe(false)
    expect(logger.warnings).toEqual(['[channels] channel_history failed: thread-scope-requires-thread-session'])
  })

  test('does NOT log on a successful fetchHistory', async () => {
    const logger = captureLogger()
    const tool = createChannelHistoryTool({
      router: fakeRouter({ fetchHistory: async () => ({ ok: true, messages: [] }) }),
      origin: { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
      logger,
    })
    await tool.execute('id', { scope: 'channel' }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toEqual([])
  })
})

describe('channel_fetch_attachment failure logging', () => {
  let inboxDir: string

  beforeEach(async () => {
    inboxDir = await mkdtemp(join(tmpdir(), 'channel-fetch-log-'))
  })

  afterEach(async () => {
    await rm(inboxDir, { recursive: true, force: true })
  })

  test('logs fetchAttachment upstream errors', async () => {
    const logger = captureLogger()
    const tool = createChannelFetchAttachmentTool({
      router: fakeRouter({
        fetchAttachment: async () => ({ ok: false, error: 'file_not_found' }),
        attachments: [{ id: 1, kind: 'file', ref: 'Fxxx' }],
      }),
      origin: attachmentOrigin,
      inboxDir,
      logger,
    })
    await tool.execute('id', { attachment_id: 1 }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toEqual(['[channels] channel_fetch_attachment failed: slack-bot: file_not_found'])
  })

  test('logs local write failures separately from upstream errors', async () => {
    const logger = captureLogger()
    const tool = createChannelFetchAttachmentTool({
      router: fakeRouter({
        fetchAttachment: async () => ({
          ok: true,
          filename: 'note.txt',
          buffer: Buffer.from([1, 2, 3]),
          size: 3,
          mimetype: 'text/plain',
        }),
        attachments: [{ id: 1, kind: 'file', ref: 'Fxxx' }],
      }),
      origin: attachmentOrigin,
      // Pointing at a path that exists as a FILE forces mkdir(recursive) to throw ENOTDIR.
      // This exercises the write-failure branch without mocking node:fs.
      inboxDir: join(devNull, 'not-a-dir'),
      logger,
    })
    await tool.execute('id', { attachment_id: 1 }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('[channels] channel_fetch_attachment failed:')
    expect(logger.warnings[0]).toContain('write failed:')
  })

  test('does NOT log on a successful fetch+write', async () => {
    const logger = captureLogger()
    const tool = createChannelFetchAttachmentTool({
      router: fakeRouter({
        fetchAttachment: async () => ({
          ok: true,
          filename: 'note.txt',
          buffer: Buffer.from([1, 2, 3]),
          size: 3,
          mimetype: 'text/plain',
        }),
        attachments: [{ id: 1, kind: 'file', ref: 'Fxxx' }],
      }),
      origin: attachmentOrigin,
      inboxDir,
      logger,
    })
    await tool.execute('id', { ref: 'Fxxx' }, undefined, undefined, fakeCtx)
    expect(logger.warnings).toEqual([])
  })
})
