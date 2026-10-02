import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { ReactionRef, ReactionRequest, ReactionResult } from '@/channels/types'

import { createChannelReactTool, type ChannelReactOrigin } from './channel-react'

function fakeRouter(queueReactionAfterReply: (req: ReactionRequest) => Promise<ReactionResult>): ChannelRouter {
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
    queueReactionAfterReply,
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
    editMessage: async () => ({ ok: false, error: 'message-edit-not-supported', code: 'not-supported' }),
    registerFetchAttachment: () => {},
    unregisterFetchAttachment: () => {},
    fetchAttachment: async () => ({ ok: false, error: 'no fetchAttachment' }),
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
    resumeRestartHandoff: async () => {},
  } as unknown as ChannelRouter
}

const githubOrigin: ChannelReactOrigin = {
  adapter: 'github',
  workspace: 'acme/project',
  chat: 'pr:7',
  thread: null,
}

const githubReactionRef: ReactionRef = {
  adapter: 'github',
  value: '{"kind":"issue","owner":"acme","repo":"project","issueNumber":7}',
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelReactTool>['execute']>[4]
const run = (tool: ReturnType<typeof createChannelReactTool>, emoji: string) =>
  tool.execute('id', { emoji }, undefined, undefined, fakeCtx)

describe('createChannelReactTool', () => {
  test('queues the triggering-inbound reaction ref and emoji via queueReactionAfterReply', async () => {
    let captured: ReactionRequest | undefined
    const tool = createChannelReactTool({
      router: fakeRouter(async (req) => {
        captured = req
        return { ok: true }
      }),
      origin: githubOrigin,
      getReactionRef: () => githubReactionRef,
      logger: { warn: () => {} },
    })

    const result = await run(tool, 'eyes')

    expect(result.details).toEqual({ ok: true })
    expect(captured).toEqual({
      adapter: 'github',
      workspace: 'acme/project',
      chat: 'pr:7',
      thread: null,
      reactionRef: githubReactionRef,
      emoji: 'eyes',
    })
  })

  test('resolves the reaction ref at execute time, not at tool-build time', async () => {
    // Regression: the tool is built once per session, but the reaction target
    // is per-turn. A statically captured ref is the session-creation snapshot
    // (always undefined), so every call would deny. The getter must be read on
    // execute so each turn reacts to its own triggering message.
    let current: ReactionRef | undefined
    let captured: ReactionRequest | undefined
    const tool = createChannelReactTool({
      router: fakeRouter(async (req) => {
        captured = req
        return { ok: true }
      }),
      origin: githubOrigin,
      getReactionRef: () => current,
      logger: { warn: () => {} },
    })

    const denied = await run(tool, 'eyes')
    expect(denied.details).toEqual({ ok: false, error: 'this conversation has no message to react to' })

    current = githubReactionRef
    const ok = await run(tool, 'rocket')
    expect(ok.details).toEqual({ ok: true })
    expect(captured?.reactionRef).toEqual(githubReactionRef)
    expect(captured?.emoji).toBe('rocket')
  })

  test('denies when the conversation has no reaction target', async () => {
    let called = false
    const tool = createChannelReactTool({
      router: fakeRouter(async () => {
        called = true
        return { ok: true }
      }),
      origin: githubOrigin,
      getReactionRef: () => undefined,
      logger: { warn: () => {} },
    })

    const result = await run(tool, 'eyes')

    expect(result.details).toEqual({ ok: false, error: 'this conversation has no message to react to' })
    expect(called).toBe(false)
  })

  test('surfaces a router.react failure as a denied tool result', async () => {
    const tool = createChannelReactTool({
      router: fakeRouter(async () => ({ ok: false, error: 'boom', code: 'permission-denied' })),
      origin: githubOrigin,
      getReactionRef: () => githubReactionRef,
      logger: { warn: () => {} },
    })

    const result = await run(tool, 'eyes')

    expect(result.details.ok).toBe(false)
  })
})
