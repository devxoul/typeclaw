// PR line comments arrive as `pull_request_review_comment` webhooks. The
// expected reply path is `POST /pulls/{N}/comments/{rootId}/replies`, not the
// PR-root `POST /issues/{N}/comments` endpoint — a reply to the issues
// endpoint posts at the bottom of the PR conversation, completely detached
// from the line comment thread the user was working in. This file covers
// the end-to-end path that ships in production: the github webhook handler
// classifies the inbound, the channel_reply tool reads `thread` from the
// session origin and forwards it to router.send, and the github outbound
// callback picks the replies endpoint based on that thread.
//
// The unit-level pieces (classifyGithubInbound, channel_reply forwarding,
// outbound endpoint selection) are each tested in their own files. This
// file exists to lock the chain together — a regression in any one link
// silently reroutes line-comment replies to the PR root, which is exactly
// the bug this test is here to prevent.
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'

import { createChannelReplyTool, type ChannelReplyOrigin } from '@/agent/tools/channel-reply'
import type { ChannelRouter } from '@/channels/router'
import type { InboundMessage, OutboundMessage, SendResult } from '@/channels/types'

import { createDeliveryDedup } from './dedup'
import { createGithubWebhookHandler } from './inbound'
import { createGithubOutboundCallback } from './outbound'

const silent = { info: () => {}, warn: () => {}, error: () => {} }

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelReplyTool>['execute']>[4]

function fakeRouter(handler: (msg: OutboundMessage) => Promise<SendResult>): ChannelRouter {
  return {
    route: async () => {},
    acceptBackgroundResponse: async () => {
      throw new Error('Unexpected background admission')
    },
    suppressUnstartedBackgroundResponse: async () => {
      throw new Error('Unexpected background suppression')
    },
    attachBackgroundResultCoverage: async () => {
      throw new Error('Unexpected background coverage')
    },
    send: handler,
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
    registerPrepareOwnReaction: () => {},
    unregisterPrepareOwnReaction: () => {},
    registerRemoveOwnReaction: () => {},
    unregisterRemoveOwnReaction: () => {},
    removeReaction: async () => ({ ok: true }),
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
    fetchAttachment: async () => ({ ok: false, error: 'no fetchAttachment callback registered' }),
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
    liveCount: () => 0,
    executeCommand: async () => ({ kind: 'no-live-session' }),
    injectSubagentCompletionReminder: async () => ({ kind: 'no-live-session' }),
    injectPrVerdictActivity: () => ({ kind: 'delivered', count: 0 }),
    noteGithubReviewOutput: async () => ({ kind: 'no-live-session' }),
    markTurnSkipped: async () => ({ kind: 'no-live-session' }),
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
  }
}

function signedRequest(body: string, event: string, delivery: string, secret = 'secret'): Request {
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  return new Request('https://example.com/github', {
    method: 'POST',
    headers: { 'x-hub-signature-256': sig, 'x-github-event': event, 'x-github-delivery': delivery },
    body,
  })
}

function reviewCommentPayload(options: { rootId: number; commentId: number }): Record<string, unknown> {
  // `in_reply_to_id` is the root comment id when this comment is a reply
  // inside an existing thread. For the root comment itself, GitHub omits
  // `in_reply_to_id`, and the inbound classifier falls back to the
  // comment's own id so the thread key matches across root and replies.
  return {
    action: 'created',
    repository: { name: 'project', owner: { login: 'acme' } },
    pull_request: { number: 7 },
    comment: {
      id: options.commentId,
      ...(options.commentId === options.rootId ? {} : { in_reply_to_id: options.rootId }),
      body: 'please clarify this line',
      created_at: '2026-01-01T00:00:00Z',
      user: { login: 'alice', id: 10, type: 'User' },
    },
  }
}

// Captures the InboundMessage the webhook handler hands to the router so we
// can construct the same ChannelReplyOrigin the production router would
// build for this session (see router.ts buildLiveOrigin: thread is copied
// verbatim from the inbound event's thread).
async function classifyWebhook(payload: Record<string, unknown>): Promise<InboundMessage> {
  let routed: InboundMessage | undefined
  const handler = createGithubWebhookHandler({
    webhookSecret: 'secret',
    dedup: createDeliveryDedup(),
    allowlist: () => ['pull_request_review_comment.created'],
    selfId: () => '99',
    selfLogin: () => 'typeclaw-bot',
    logger: silent,
    route: (msg) => {
      routed = msg
    },
  })
  const body = JSON.stringify(payload)
  const response = await handler(signedRequest(body, 'pull_request_review_comment', 'd-1'))
  expect(response.status).toBe(200)
  expect(routed).toBeDefined()
  return routed as InboundMessage
}

describe('PR line comment → channel_reply → /pulls/{N}/comments/{T}/replies', () => {
  test('reply to a root line comment posts under that comment as a thread', async () => {
    const inbound = await classifyWebhook(reviewCommentPayload({ rootId: 555, commentId: 555 }))
    expect(inbound.chat).toBe('pr:7')
    expect(inbound.thread).toBe('555')

    const calls: Array<{ url: string; method: string }> = []
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        calls.push({ url, method: init?.method ?? 'GET' })
        return new Response(JSON.stringify({ id: 999 }), { status: 201 })
      },
      { preconnect: () => {} },
    ) as typeof fetch
    const outbound = createGithubOutboundCallback({
      token: async () => 'tok',
      authType: 'app',
      logger: silent,
      fetchImpl,
    })

    const origin: ChannelReplyOrigin = {
      adapter: 'github',
      workspace: inbound.workspace,
      chat: inbound.chat,
      thread: inbound.thread,
    }
    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => outbound(msg)),
      origin,
      logger: silent,
    })

    const result = await tool.execute(
      'id',
      { text: 'sure, here is the rationale', more_work_this_turn: false, resolve_review_thread: false },
      undefined,
      undefined,
      fakeCtx,
    )

    expect(result.details).toMatchObject({ ok: true, messageId: '999', messageIds: ['999'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      url: 'https://api.github.com/repos/acme/project/pulls/7/comments/555/replies',
      method: 'POST',
    })
  })

  test('reply to a follow-up line comment posts under the root, not the comment itself', async () => {
    // Realistic GitHub shape: comment 556 is a reply inside the thread
    // started by comment 555. The webhook carries in_reply_to_id=555, so
    // the inbound thread MUST resolve to 555 (the root) — otherwise the
    // reply would create a sibling thread keyed on 556 and fragment the
    // conversation.
    const inbound = await classifyWebhook(reviewCommentPayload({ rootId: 555, commentId: 556 }))
    expect(inbound.thread).toBe('555')

    const calls: Array<{ url: string; method: string }> = []
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        calls.push({ url, method: init?.method ?? 'GET' })
        return new Response(JSON.stringify({ id: 999 }), { status: 201 })
      },
      { preconnect: () => {} },
    ) as typeof fetch
    const outbound = createGithubOutboundCallback({
      token: async () => 'tok',
      authType: 'app',
      logger: silent,
      fetchImpl,
    })

    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => outbound(msg)),
      origin: { adapter: 'github', workspace: inbound.workspace, chat: inbound.chat, thread: inbound.thread },
      logger: silent,
    })
    await tool.execute(
      'id',
      { text: 'got it', more_work_this_turn: false, resolve_review_thread: false },
      undefined,
      undefined,
      fakeCtx,
    )

    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/project/pulls/7/comments/555/replies')
  })

  test('regression guard: outbound MUST NOT fall back to /issues/{N}/comments when thread is set', async () => {
    // This is the failure mode the user reported: a PR line-comment reply
    // arriving at the PR root instead of the line-comment thread. If
    // outbound ever stops honoring `msg.thread` for PRs and falls back to
    // the issues-comments endpoint, this assertion catches it.
    const inbound = await classifyWebhook(reviewCommentPayload({ rootId: 200, commentId: 201 }))
    const calls: Array<{ url: string }> = []
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        calls.push({ url })
        return new Response(JSON.stringify({ id: 1 }), { status: 201 })
      },
      { preconnect: () => {} },
    ) as typeof fetch
    const outbound = createGithubOutboundCallback({
      token: async () => 'tok',
      authType: 'app',
      logger: silent,
      fetchImpl,
    })

    const tool = createChannelReplyTool({
      router: fakeRouter(async (msg) => outbound(msg)),
      origin: { adapter: 'github', workspace: inbound.workspace, chat: inbound.chat, thread: inbound.thread },
      logger: silent,
    })
    await tool.execute(
      'id',
      { text: 'reply', more_work_this_turn: false, resolve_review_thread: false },
      undefined,
      undefined,
      fakeCtx,
    )

    expect(calls[0]?.url).toContain('/pulls/7/comments/200/replies')
    expect(calls[0]?.url).not.toContain('/issues/7/comments')
  })
})
