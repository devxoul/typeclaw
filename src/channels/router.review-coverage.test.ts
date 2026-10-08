import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'

import type { AgentSession } from '@/agent'
import { createPostGithubReviewTool } from '@/agent/tools/post-github-review'

import { BackgroundObligationStore, type BackgroundObligationRef } from './background-obligations'
import { recoveryNoticeCause } from './continuity-types'
import {
  __resetReviewObserverForTest,
  recordReview,
  resetReviewTurn,
  setReviewOutputObserver,
  type ReviewOutputObserver,
} from './github-review-turn-ledger'
import type { ReviewVerdictGuard } from './github-review-verdict-coordinator'
import { RecoveryOutbox } from './recovery-outbox'
import { createChannelRouter } from './router'
import { defaultHistoryConfig } from './schema'
import type { ChannelKey, InboundMessage } from './types'

const KEY: ChannelKey = { adapter: 'github', workspace: 'example/project', chat: 'pr:7', thread: null }
const SESSION_ID = 'review-parent'

// Controlled model boundary, as in router.background-lane.test.ts; routing and files are real.
class ParentSession {
  prompts: string[] = []
  leaf: SessionEntry | undefined
  onPrompt: () => Promise<void> = async () => this.finish('NO_REPLY')
  agent = {
    controller: new AbortController(),
    get signal() {
      return this.controller.signal
    },
    state: { messages: [] as Array<{ role: string; stopReason?: string }> },
    abort() {
      this.controller.abort()
    },
    continue: async () => {},
    streamFunction: (() => undefined) as unknown as StreamFn,
    afterToolCall: undefined,
  }
  sessionManager = {
    getLeafEntry: () => this.leaf,
    getEntry: () => this.leaf,
    getBranch: () => (this.leaf ? [this.leaf] : []),
    appendMessage: () => 'appended',
  }
  prompt = async (text: string) => {
    this.prompts.push(text)
    this.agent.controller = new AbortController()
    await this.onPrompt()
  }
  abort = async () => this.agent.abort()
  refreshContext = () => {}
  dispose = () => {}
  setThinkingLevel = () => {}
  subscribe = () => () => {}
  finish(text: string) {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'test-model',
      stopReason: 'stop',
      timestamp: 1000,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    this.leaf = { type: 'message', id: 'leaf', parentId: null, timestamp: new Date(1000).toISOString(), message }
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'router-review-coverage-'))
  const store = new BackgroundObligationStore(dir, { epoch: 'review-before-boot' })
  const session = new ParentSession()
  const sent: string[] = []
  const outputs: Parameters<ReviewOutputObserver>[0][] = []
  let messageId = 0
  const router = createChannelRouter({
    agentDir: dir,
    backgroundObligations: store,
    now: () => 1000,
    configForAdapter: () => ({
      enabled: true,
      history: defaultHistoryConfig(),
      engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
    }),
    permissions: {
      has: () => true,
      resolveRole: () => 'owner',
      compareRoleSeverity: () => 1,
      permissionsForRole: () => undefined,
      describe: () => ({ role: 'owner', permissions: ['channel.respond'] }),
      replaceRoles: () => {},
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    createSessionForChannel: async () => ({
      session: session as unknown as AgentSession,
      sessionId: SESSION_ID,
      dispose: async () => {},
    }),
  })
  const outbound: Parameters<typeof router.registerOutbound>[1] = async (message) => {
    sent.push(message.text ?? '')
    return { ok: true }
  }
  router.registerOutbound('github', outbound)
  setReviewOutputObserver(async (output) => {
    outputs.push(output)
    await router.noteGithubReviewOutput(output)
  })
  async function turn(text: string) {
    const inbound: InboundMessage = {
      ...KEY,
      text,
      externalMessageId: `message-${++messageId}`,
      accountIdentity: 'review-account',
      authorId: 'human',
      authorName: 'Human',
      authorIsBot: false,
      isBotMention: true,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: 1000,
    }
    await router.route(inbound)
    await router.__testing!.flushDebounce(KEY)
  }
  await turn('open parent')
  const accept = (taskId: string) =>
    router.acceptBackgroundResponse({
      parentSessionId: SESSION_ID,
      key: KEY,
      taskId,
      subagentName: 'explorer',
      startedAt: 1000,
      accountIdentity: 'review-account',
      triggeringAuthorId: 'human',
    })
  const fetch = (taskId: string) => router.attachBackgroundResultCoverage({ parentSessionId: SESSION_ID, taskId })
  async function cleanup() {
    await router.stop()
    resetReviewTurn(SESSION_ID)
    __resetReviewObserverForTest()
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, store, router, session, sent, outputs, turn, accept, fetch, cleanup, outbound }
}

// The review turn ended still owing `owed`: a review never answers a result it did not capture,
// so the turn's own end transferred it in this process as a durable live-turn-ended notice.
async function proveLiveNotice(
  dir: string,
  store: BackgroundObligationStore,
  owed: BackgroundObligationRef,
  closed?: BackgroundObligationRef,
) {
  const row = (await store.get(owed.obligationId))!
  expect(row.phase).toBe('notice-owned')
  const notices = (await new RecoveryOutbox(dir).list()).filter((notice) =>
    notice.covers.some((cover) => cover.id === owed.obligationId),
  )
  expect(notices).toHaveLength(1)
  expect(notices[0]!.state).toBe('pending')
  expect(recoveryNoticeCause(notices[0]!)).toBe('live-turn-ended')
  expect(notices[0]!.covers.find((cover) => cover.id === owed.obligationId)).toEqual({
    store: 'background',
    id: owed.obligationId,
    generation: row.generation,
    parentSessionId: SESSION_ID,
  })
  if (closed) expect((await store.get(closed.obligationId))?.phase).toBe('closed')
}

const allowReview: ReviewVerdictGuard = {
  guard: async () => null,
  release: async () => {},
  noteLandedReview: async () => {},
}

for (const publication of ['APPROVE', 'COMMENT', 'duplicate-request-changes-comment'] as const) {
  test(`${publication} held remote publication settles only results fetched before submission`, async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const a = await f.accept('result-a')
      const b = await f.accept('result-b')
      const fallback = publication === 'duplicate-request-changes-comment'
      if (fallback) {
        f.router.unregisterOutbound('github', f.outbound)
        f.router.registerOutbound('github', async (message) => {
          entered.resolve()
          await release.promise
          f.sent.push(message.text ?? '')
          return { ok: true, messageId: 'fallback-comment' }
        })
      } else {
        f.router.registerReviewSubmitter('github', async () => {
          entered.resolve()
          await release.promise
          return { ok: true, reviewId: 91, state: publication === 'APPROVE' ? 'APPROVED' : 'COMMENTED' }
        })
      }
      const tool = createPostGithubReviewTool({
        router: f.router,
        origin: KEY,
        sessionId: SESSION_ID,
        verdictGuard: fallback
          ? {
              ...allowReview,
              guard: async () => ({
                block: true,
                kind: 'duplicate',
                duplicateSource: 'standing',
                leaseRetained: true,
                reason: 'Existing review remains active.',
              }),
            }
          : allowReview,
      })
      let before: BackgroundObligationRef[] = []
      f.session.onPrompt = async () => {
        await f.fetch('result-a')
        before = await f.router.captureBackgroundResultCoverage!(SESSION_ID)
        const result = await tool.execute(
          'held-review',
          { event: fallback ? 'REQUEST_CHANGES' : publication, body: 'Review findings.' },
          undefined,
          undefined,
          {} as Parameters<typeof tool.execute>[4],
        )
        expect(result.details).toMatchObject({ ok: true })
        f.session.finish('')
      }
      const drain = f.turn('review the changes')
      await entered.promise
      await f.fetch('result-b')
      expect((await f.store.get(a.obligationId))?.phase).toBe('turn-owned')
      expect((await f.store.get(b.obligationId))?.phase).toBe('turn-owned')
      release.resolve()
      await drain
      expect(f.outputs.map((output) => output.backgroundCoverage)).toEqual([before])
      expect(before.map((ref) => ref.obligationId)).toEqual([a.obligationId])
      expect((await f.store.get(a.obligationId))?.outcome?.kind).toBe('delivered')
      expect(f.session.prompts).toHaveLength(2)
      expect(f.sent).toEqual(fallback ? ['Review findings.'] : [])
      await proveLiveNotice(f.dir, f.store, b, a)
    } finally {
      release.resolve()
      await f.cleanup()
    }
  })
}

test('uncaptured direct review recognition suppresses empty-output fallback without settling fetched work', async () => {
  const f = await fixture()
  try {
    const a = await f.accept('uncaptured-result')
    f.session.onPrompt = async () => {
      await f.fetch('uncaptured-result')
      await recordReview({ sessionId: SESSION_ID, workspace: KEY.workspace, prNumber: 7, verdict: 'APPROVE' })
      f.session.finish('')
    }
    await f.turn('review the changes')
    expect(f.session.prompts).toHaveLength(2)
    expect(f.sent).toEqual([])
    await proveLiveNotice(f.dir, f.store, a)
  } finally {
    await f.cleanup()
  }
})
