import { afterEach, describe, expect, test } from 'bun:test'

import { hasResolvedThread } from '@/channels/github-review-turn-ledger'
import { resetReviewTurn } from '@/channels/github-review-turn-ledger'
import type { ChannelRouter } from '@/channels/router'
import type {
  OutboundMessage,
  ReviewThreadResolveRequest,
  ReviewThreadResolveResult,
  SendResult,
} from '@/channels/types'

import { createChannelSendTool } from './channel-send'

const SESSION = 'ses_cs_resolve'

afterEach(() => resetReviewTurn(SESSION))

function fakeRouter(handlers: {
  onSend?: (msg: OutboundMessage) => SendResult
  onResolve?: (req: ReviewThreadResolveRequest) => ReviewThreadResolveResult
  getReviewState?: ChannelRouter['getReviewState']
}): ChannelRouter {
  return {
    route: async () => {},
    send: async (msg) => handlers.onSend?.(msg) ?? { ok: true },
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
    fetchHistory: async () => ({ ok: false, error: 'x' }),
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
    fetchAttachment: async () => ({ ok: false, error: 'x' }),
    registerReviewThreadResolver: () => {},
    unregisterReviewThreadResolver: () => {},
    resolveReviewThread: async (req) => handlers.onResolve?.(req) ?? { ok: true },
    registerReviewStateResolver: () => {},
    unregisterReviewStateResolver: () => {},
    getReviewState:
      handlers.getReviewState ??
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
    noteGithubReviewOutput: () => ({ kind: 'no-live-session' }),
    markTurnSkipped: () => ({ kind: 'no-live-session' }),
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
  }
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelSendTool>['execute']>[4]

async function run(
  tool: ReturnType<typeof createChannelSendTool>,
  params: Parameters<ReturnType<typeof createChannelSendTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('channel_send resolve_review_thread', () => {
  test('resolves the thread before posting and records the ledger', async () => {
    const order: string[] = []
    const resolveCalls: ReviewThreadResolveRequest[] = []
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          order.push('send')
          return { ok: true }
        },
        onResolve: (req) => {
          order.push('resolve')
          resolveCalls.push(req)
          return { ok: true }
        },
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      thread: '555',
      text: 'addressed in abc123 — resolving',
      resolve_review_thread: true,
    })

    expect(result.details).toEqual({ ok: true })
    expect(order).toEqual(['resolve', 'send'])
    expect(resolveCalls[0]).toEqual({
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      rootCommentId: '555',
    })
    expect(
      hasResolvedThread({ sessionId: SESSION, workspace: 'acme/widgets', prNumber: 12, rootCommentId: '555' }),
    ).toBe(true)
  })

  test('blocks the send when the resolve fails for a hard reason', async () => {
    let sent = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          sent++
          return { ok: true }
        },
        onResolve: () => ({ ok: false, error: 'refusing: not author', code: 'not-author' }),
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      thread: '555',
      text: 'addressed — resolving',
      resolve_review_thread: true,
    })

    expect(sent).toBe(0)
    expect((result.details as { ok: boolean }).ok).toBe(false)
    expect((result.details as { error: string }).error).toContain('could not resolve review thread')
    expect(
      hasResolvedThread({ sessionId: SESSION, workspace: 'acme/widgets', prNumber: 12, rootCommentId: '555' }),
    ).toBe(false)
  })

  test('posts a no-match resolve but warns and does not record the ledger', async () => {
    let sent = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          sent++
          return { ok: true }
        },
        onResolve: () => ({ ok: false, error: 'gone', code: 'no-match' }),
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      thread: '555',
      text: 'ack',
      resolve_review_thread: true,
    })

    // The reply still posts (no-match is non-blocking — the thread may be gone),
    // but the model must be told the resolve did not fire so it can re-target,
    // and the ledger must NOT record a resolution that never happened.
    expect(sent).toBe(1)
    expect((result.details as { ok: boolean }).ok).toBe(true)
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('555')
    expect(rendered).toContain('was not resolved')
    expect(
      hasResolvedThread({ sessionId: SESSION, workspace: 'acme/widgets', prNumber: 12, rootCommentId: '555' }),
    ).toBe(false)
  })

  test('rejects resolve_review_thread without a thread', async () => {
    let resolved = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onResolve: () => {
          resolved++
          return { ok: true }
        },
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      text: 'no thread',
      resolve_review_thread: true,
    })

    expect(resolved).toBe(0)
    expect((result.details as { ok: boolean }).ok).toBe(false)
    expect((result.details as { error: string }).error).toContain('requires a `thread`')
  })

  test('rejects resolve_review_thread on a non-github adapter', async () => {
    let resolved = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onResolve: () => {
          resolved++
          return { ok: true }
        },
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: 't1',
      text: 'resolving',
      resolve_review_thread: true,
    })

    expect(resolved).toBe(0)
    expect((result.details as { ok: boolean }).ok).toBe(false)
    expect((result.details as { error: string }).error).toContain('only supported on github')
  })

  test('denies a thread text send that omits the resolve choice, resolving nothing', async () => {
    let resolved = 0
    let sent = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          sent++
          return { ok: true }
        },
        onResolve: () => {
          resolved++
          return { ok: true }
        },
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      thread: '555',
      text: 'just a comment, keeping open',
    })

    expect(resolved).toBe(0)
    expect(sent).toBe(0)
    expect((result.details as { ok: boolean }).ok).toBe(false)
    expect((result.details as { error: string }).error).toContain('resolve_review_thread')
  })

  test('does not resolve when the flag is an explicit false (thread kept open)', async () => {
    let resolved = 0
    let sent = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          sent++
          return { ok: true }
        },
        onResolve: () => {
          resolved++
          return { ok: true }
        },
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      thread: '555',
      text: 'just a comment, keeping open',
      resolve_review_thread: false,
    })

    expect(resolved).toBe(0)
    expect(sent).toBe(1)
    expect((result.details as { ok: boolean }).ok).toBe(true)
  })
})

describe('channel_send re-review stranding guard', () => {
  test('blocks a close-out while the bot still holds CHANGES_REQUESTED, resolving nothing', async () => {
    let resolved = 0
    let sent = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          sent += 1
          return { ok: true }
        },
        onResolve: () => {
          resolved += 1
          return { ok: true }
        },
        getReviewState: async () => ({ ok: true, selfBlocking: true, selfBlockingReviewId: null, approve: true }),
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      thread: '555',
      text: 'addressed in abc123 — resolving',
      resolve_review_thread: true,
    })

    expect((result.details as { ok: boolean }).ok).toBe(false)
    expect(resolved).toBe(0)
    expect(sent).toBe(0)
  })

  test('honors the dismissal branch when approval is disabled', async () => {
    const tool = createChannelSendTool({
      router: fakeRouter({
        getReviewState: async () => ({ ok: true, selfBlocking: true, selfBlockingReviewId: null, approve: false }),
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      thread: '555',
      text: 'that resolves it',
      resolve_review_thread: true,
    })

    expect((result.details as { ok: boolean; error?: string }).ok).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('dismiss')
  })

  test('blocks a no-thread close-out PR comment while the bot still blocks the PR', async () => {
    let sent = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          sent += 1
          return { ok: true }
        },
        getReviewState: async () => ({ ok: true, selfBlocking: true, selfBlockingReviewId: null, approve: true }),
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      text: 'Verified — that closes it, thanks!',
    })

    expect((result.details as { ok: boolean }).ok).toBe(false)
    expect(sent).toBe(0)
  })

  test('allows a no-thread plain discussion comment on a PR', async () => {
    let sent = 0
    let queried = false
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          sent += 1
          return { ok: true }
        },
        getReviewState: async () => {
          queried = true
          return { ok: true, selfBlocking: true, selfBlockingReviewId: null, approve: true }
        },
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:12',
      text: 'Thanks for the context — that makes sense.',
    })

    expect((result.details as { ok: boolean }).ok).toBe(true)
    expect(sent).toBe(1)
    expect(queried).toBe(false)
  })

  test('blocks a no-thread LGTM comment while GitHub still requires formal review', async () => {
    let sent = 0
    const tool = createChannelSendTool({
      router: fakeRouter({
        onSend: () => {
          sent += 1
          return { ok: true }
        },
        getReviewState: async () => ({
          ok: true,
          selfBlocking: false,
          selfBlockingReviewId: null,
          approve: true,
          reviewDecision: 'REVIEW_REQUIRED',
        }),
      }),
      sessionId: SESSION,
    })

    const result = await run(tool, {
      adapter: 'github',
      workspace: 'acme/widgets',
      chat: 'pr:653',
      text: 'LGTM — the dedupe is scoped to the per-session turn boundary exactly as described.',
    })

    expect((result.details as { ok: boolean }).ok).toBe(false)
    expect(sent).toBe(0)
    expect((result.content[0] as { text: string }).text).toContain('formal GitHub review')
  })
})
