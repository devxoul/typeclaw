import { afterEach, describe, expect, test } from 'bun:test'

import {
  __resetReviewObserverForTest,
  hasReview,
  resetReviewTurn,
  setReviewObserver,
  setReviewOutputObserver,
} from '@/channels/github-review-turn-ledger'
import {
  __resetReviewVerdictGuardForTest,
  abortGithubReviewStateForPr,
  configureReviewVerdictCoordinator,
} from '@/channels/github-review-verdict-coordinator'
import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig } from '@/channels/schema'
import type { OutboundMessage, SubmitReviewRequest } from '@/channels/types'

import { createPostGithubReviewTool } from './post-github-review'

function router() {
  return createChannelRouter({
    agentDir: '/tmp/typeclaw-post-review-test',
    configForAdapter: () => ({
      allow: ['*'],
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }),
  })
}

const githubOrigin = { adapter: 'github' as const, workspace: 'acme/widgets', chat: 'pr:7', thread: null }
const slackOrigin = { adapter: 'slack-bot' as const, workspace: 'T0', chat: 'C0', thread: null }
const fakeCtx = {} as Parameters<ReturnType<typeof createPostGithubReviewTool>['execute']>[4]
const sessionId = 'post-review-session'

async function run(tool: ReturnType<typeof createPostGithubReviewTool>, params: Parameters<typeof tool.execute>[1]) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('post_github_review', () => {
  afterEach(() => {
    resetReviewTurn(sessionId)
    resetReviewTurn('concurrent-session')
    __resetReviewObserverForTest()
    __resetReviewVerdictGuardForTest()
  })

  test.each([
    ['APPROVE', 'APPROVED'],
    ['COMMENT', 'COMMENTED'],
  ] as const)('awaits delayed output settlement for %s before returning a receipt', async (event, state) => {
    const channelRouter = router()
    channelRouter.registerReviewSubmitter('github', async () => ({ ok: true, reviewId: 91, state }))
    const entered = Promise.withResolvers<void>()
    const settlement = Promise.withResolvers<void>()
    setReviewOutputObserver(async () => {
      entered.resolve()
      await settlement.promise
    })
    let returned = false
    const result = run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event,
      body: 'summary',
    }).then((receipt) => {
      returned = true
      return receipt
    })
    await entered.promise
    await Promise.resolve()
    expect(returned).toBe(false)
    settlement.resolve()
    expect((await result).details).toMatchObject({ ok: true, reviewId: 91 })
  })

  test('keeps a landed review successful and deduped when output settlement rejects', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: true, reviewId: 92, state: 'APPROVED' }
    })
    setReviewOutputObserver(async () => {
      throw new Error('settlement storage unavailable')
    })
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })
    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({
      ok: true,
      reviewId: 92,
    })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(true)
    expect((await run(tool, { event: 'APPROVE', body: 'retry' })).details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
  })

  test('is gated to GitHub-origin sessions', async () => {
    const result = await run(createPostGithubReviewTool({ router: router(), origin: slackOrigin, sessionId }), {
      event: 'COMMENT',
      body: 'summary',
    })
    expect(result.details).toMatchObject({ ok: false })
  })

  test('maps snake_case anchors and returns adapter verification details', async () => {
    const channelRouter = router()
    const requests: SubmitReviewRequest[] = []
    channelRouter.registerReviewSubmitter('github', async (request) => {
      requests.push(request)
      return {
        ok: true,
        reviewId: 44,
        state: 'COMMENTED',
        downgraded: true,
        reanchored: [{ path: 'src/app.ts', line: 99, body: 'outside' }],
      }
    })
    const output: unknown[] = []
    setReviewOutputObserver((event) => {
      output.push(event)
    })
    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'APPROVE',
      body: 'summary',
      comments: [{ path: 'src/app.ts', line: 10, side: 'RIGHT', start_line: 8, start_side: 'RIGHT', body: 'finding' }],
    })

    expect(requests[0]?.comments).toEqual([
      { path: 'src/app.ts', line: 10, side: 'RIGHT', startLine: 8, startSide: 'RIGHT', body: 'finding' },
    ])
    expect(result.details).toMatchObject({ ok: true, reviewId: 44, downgraded: true })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
    expect(output).toEqual([
      { sessionId, workspace: githubOrigin.workspace, prNumber: 7, state: 'COMMENT', backgroundCoverage: [] },
    ])
    expect(result.content[0]).toMatchObject({ type: 'text' })
    if (result.content[0]?.type === 'text') expect(result.content[0].text).toContain('out-of-diff')
  })

  test.each([
    ['APPROVE', 'APPROVED', 'APPROVE'],
    ['REQUEST_CHANGES', 'CHANGES_REQUESTED', 'REQUEST_CHANGES'],
  ] as const)('credits the verified effective %s state to the session ledger', async (event, state, verdict) => {
    const channelRouter = router()
    channelRouter.registerReviewSubmitter('github', async () => ({ ok: true, reviewId: 45, state }))
    const output: unknown[] = []
    setReviewOutputObserver((value) => {
      output.push(value)
    })

    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event,
      body: 'summary',
    })

    expect(result.details).toMatchObject({ ok: true, state })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict })).toBe(true)
    expect(output).toEqual([
      { sessionId, workspace: githubOrigin.workspace, prNumber: 7, state: verdict, backgroundCoverage: [] },
    ])
  })

  test('binds the verdict to the reviewed head and reports the landed commit to round completion', async () => {
    const channelRouter = router()
    const requests: SubmitReviewRequest[] = []
    channelRouter.registerReviewSubmitter('github', async (request) => {
      requests.push(request)
      return { ok: true, reviewId: 47, state: 'APPROVED', commitSha: 'c'.repeat(40) }
    })
    const landed: unknown[] = []
    setReviewObserver((review) => landed.push(review))

    await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'APPROVE',
      body: 'summary',
      head_sha: 'c'.repeat(40),
    })

    expect(requests[0]?.expectedHeadSha).toBe('c'.repeat(40))
    expect(landed).toEqual([
      { sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE', commitSha: 'c'.repeat(40) },
    ])
  })

  test('failed or unknown verification receives no ledger credit', async () => {
    const channelRouter = router()
    let state: 'failure' | 'unknown' = 'failure'
    channelRouter.registerReviewSubmitter('github', async () =>
      state === 'failure'
        ? { ok: false, error: 'verification failed', code: 'transient' }
        : { ok: true, reviewId: 46, state: 'PENDING' },
    )
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    state = 'unknown'
    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
  })

  test('shares effective-state and in-flight coordination with the github-cli-auth guard', async () => {
    let effective: 'NONE' | 'APPROVED' = 'APPROVED'
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      await firstGate
      return { ok: true, reviewId: 47, state: 'APPROVED' }
    })

    const effectiveDuplicate = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }),
      { event: 'APPROVE', body: 'summary' },
    )
    expect(effectiveDuplicate.details).toMatchObject({ ok: false })
    expect(submissions).toBe(0)

    effective = 'NONE'
    const first = run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'APPROVE',
      body: 'summary',
    })
    await Bun.sleep(0)
    const concurrent = await run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: githubOrigin,
        sessionId: 'concurrent-session',
      }),
      { event: 'REQUEST_CHANGES', body: 'summary' },
    )
    expect(concurrent.details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
    releaseFirst()
    expect((await first).details).toMatchObject({ ok: true })
  })

  test('serializes concurrent formal verdicts from sibling thread sessions', async () => {
    const resolverStarted = Promise.withResolvers<void>()
    const releaseResolver = Promise.withResolvers<void>()
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => {
        resolverStarted.resolve()
        await releaseResolver.promise
        return { ok: true, effective: 'NONE' }
      },
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: true, reviewId: 50, state: 'APPROVED' }
    })
    const first = run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: { ...githubOrigin, thread: '101' },
        sessionId,
      }),
      { event: 'APPROVE', body: 'summary' },
    )
    const second = run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: { ...githubOrigin, thread: '202' },
        sessionId: 'concurrent-session',
      }),
      { event: 'APPROVE', body: 'summary' },
    )
    await resolverStarted.promise
    releaseResolver.resolve()
    const [landed, concurrent] = await Promise.all([first, second])

    expect(landed.details).toMatchObject({ ok: true })
    expect(concurrent.details).toMatchObject({
      ok: false,
      error:
        'Another session in this agent is already submitting a formal review verdict for this pull request. ' +
        'Only one verdict may land per PR — do not submit a second review; the in-flight one will post.',
    })
    expect(submissions).toBe(1)
  })

  test('rejects a non-carrier sibling verdict before the submitter', async () => {
    let reads = 0
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => {
        reads += 1
        return { ok: true, effective: 'NONE' }
      },
      resolveHeadSha: async () => 'sha-round',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: true, reviewId: 52, state: 'APPROVED' }
    })
    const tool = createPostGithubReviewTool({
      router: channelRouter,
      origin: {
        ...githubOrigin,
        thread: '202',
        githubReviewRound: {
          kind: 'push',
          roundId: 'test-round',
          workspace: githubOrigin.workspace,
          prNumber: 7,
          headSha: 'sha-round',
          carrierThread: '101',
        },
      },
      sessionId: 'concurrent-session',
    })

    const result = await run(tool, { event: 'REQUEST_CHANGES', body: 'still blocked' })

    expect(result.details).toMatchObject({ ok: false, error: expect.stringContaining('designated') })
    expect(reads).toBe(0)
    expect(submissions).toBe(0)
  })

  test('posts a duplicate REQUEST_CHANGES as one top-level PR comment', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    const reviews: SubmitReviewRequest[] = []
    const comments: OutboundMessage[] = []
    channelRouter.registerReviewSubmitter('github', async (request) => {
      reviews.push(request)
      return { ok: true, reviewId: 48, state: 'CHANGES_REQUESTED' }
    })
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true, messageId: '91', messageIds: ['91'] }
    })
    const output: unknown[] = []
    setReviewOutputObserver((value) => {
      output.push(value)
    })

    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'The overall flow still needs revision.',
      comments: [
        { path: 'src/rules.ts', line: 12, side: 'RIGHT', body: 'Evaluate only the selected offer here.' },
        {
          path: 'src/search.ts',
          line: 30,
          side: 'RIGHT',
          start_line: 26,
          start_side: 'RIGHT',
          body: 'Keep exhaustive discovery in the automatic path.',
        },
        { path: 'src/legacy.ts', line: 14, side: 'LEFT', body: 'This deleted line still carries the bug.' },
        {
          path: 'src/removed.ts',
          line: 24,
          side: 'LEFT',
          start_line: 20,
          start_side: 'LEFT',
          body: 'This removed block needs a replacement.',
        },
      ],
    })

    expect(reviews).toEqual([])
    expect(comments).toEqual([
      {
        adapter: 'github',
        workspace: githubOrigin.workspace,
        chat: githubOrigin.chat,
        thread: null,
        text: [
          'The overall flow still needs revision.',
          '',
          '---',
          '',
          '**`src/rules.ts:12`**',
          '',
          'Evaluate only the selected offer here.',
          '',
          '**`src/search.ts:26-30`**',
          '',
          'Keep exhaustive discovery in the automatic path.',
          '',
          '**`src/legacy.ts:14 (old revision)`**',
          '',
          'This deleted line still carries the bug.',
          '',
          '**`src/removed.ts:20-24 (old revision)`**',
          '',
          'This removed block needs a replacement.',
        ].join('\n'),
      },
    ])
    expect(result.details).toEqual({ ok: true, fallback: 'comment', messageId: '91', messageIds: ['91'] })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'REQUEST_CHANGES' })).toBe(
      false,
    )
    expect(output).toEqual([
      { sessionId, workspace: githubOrigin.workspace, prNumber: 7, state: 'COMMENT', backgroundCoverage: [] },
    ])
  })

  test('serializes duplicate REQUEST_CHANGES fallbacks until outbound delivery completes', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      await firstGate
      return { ok: true }
    })

    const first = run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'first',
    })
    await Bun.sleep(0)
    const second = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId: 'concurrent-session' }),
      { event: 'REQUEST_CHANGES', body: 'second' },
    )

    expect(second.details).toMatchObject({ ok: false })
    expect(comments).toHaveLength(1)
    releaseFirst()
    expect((await first).details).toMatchObject({ ok: true, fallback: 'comment' })
  })

  // Regression: two sibling thread sessions of one PR each finished a
  // re-review minutes apart, each hit the same standing CHANGES_REQUESTED block, and
  // each published its own copy of the review as a top-level PR comment.
  function standingChangesRequested(headSha: () => string) {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => headSha(),
    })
  }

  test('publishes the duplicate-review comment once across sequential sibling sessions', async () => {
    standingChangesRequested(() => 'sha-1')
    const channelRouter = router()
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })

    const first = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'first sibling',
    })
    const second = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId: 'concurrent-session' }),
      { event: 'REQUEST_CHANGES', body: 'second sibling' },
    )

    expect(first.details).toMatchObject({ ok: true, fallback: 'comment' })
    expect(second.details).toMatchObject({ ok: false })
    expect(comments).toHaveLength(1)
  })

  test('lets a sibling retry the duplicate-review comment when the first delivery failed', async () => {
    standingChangesRequested(() => 'sha-1')
    const channelRouter = router()
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      if (comments.length === 0) {
        comments.push(message)
        return { ok: false, error: 'GitHub API 502' }
      }
      comments.push(message)
      return { ok: true }
    })

    const failed = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'first sibling',
    })
    const retry = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId: 'concurrent-session' }),
      { event: 'REQUEST_CHANGES', body: 'second sibling' },
    )

    expect(failed.details).toMatchObject({ ok: false })
    expect(retry.details).toMatchObject({ ok: true, fallback: 'comment' })
    expect(comments).toHaveLength(2)
  })

  test('publishes a fresh duplicate-review comment once the PR head advances', async () => {
    let head = 'sha-1'
    standingChangesRequested(() => head)
    const channelRouter = router()
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'REQUEST_CHANGES', body: 'before push' })).details).toMatchObject({ ok: true })
    head = 'sha-2'
    expect((await run(tool, { event: 'REQUEST_CHANGES', body: 'after push' })).details).toMatchObject({ ok: true })
    expect(comments).toHaveLength(2)
  })

  test('scopes the duplicate-review comment suppression to one pull request', async () => {
    standingChangesRequested(() => 'sha-1')
    const channelRouter = router()
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })

    const onPr7 = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'pr 7',
    })
    const onPr8 = await run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: { ...githubOrigin, chat: 'pr:8' },
        sessionId: 'concurrent-session',
      }),
      { event: 'REQUEST_CHANGES', body: 'pr 8' },
    )

    expect(onPr7.details).toMatchObject({ ok: true, fallback: 'comment' })
    expect(onPr8.details).toMatchObject({ ok: true, fallback: 'comment' })
    expect(comments).toHaveLength(2)
  })

  test('keeps a recent-landed REQUEST_CHANGES cooldown duplicate denied without an authoritative standing block', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: true, reviewId: 49, state: 'CHANGES_REQUESTED' }
    })
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'REQUEST_CHANGES', body: 'first' })).details).toMatchObject({ ok: true })
    expect((await run(tool, { event: 'REQUEST_CHANGES', body: 'follow-up' })).details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
    expect(comments).toHaveLength(0)
  })

  test('blocks a sequential sibling verdict on the recent-landed cooldown', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: true, reviewId: 51, state: 'APPROVED' }
    })
    const firstTool = createPostGithubReviewTool({
      router: channelRouter,
      origin: { ...githubOrigin, thread: '101' },
      sessionId,
    })
    const secondTool = createPostGithubReviewTool({
      router: channelRouter,
      origin: { ...githubOrigin, thread: '202' },
      sessionId: 'concurrent-session',
    })

    expect((await run(firstTool, { event: 'APPROVE', body: 'first' })).details).toMatchObject({ ok: true })
    const second = await run(secondTool, { event: 'APPROVE', body: 'follow-up' })

    expect(second.details).toMatchObject({
      ok: false,
      error: expect.stringContaining('already holds a standing APPROVED review'),
    })
    expect(submissions).toBe(1)
  })

  test('blocks an unknown-head retry before and after an aborted dispatched review verifies', async () => {
    const resolvedHeads: Array<string | null> = ['sha-1', null, 'sha-1', 'sha-1']
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => resolvedHeads.shift() ?? null,
    })
    const channelRouter = router()
    const dispatched = Promise.withResolvers<void>()
    const finishVerification = Promise.withResolvers<void>()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      dispatched.resolve()
      await finishVerification.promise
      return { ok: true, reviewId: 53, state: 'APPROVED' }
    })
    const first = run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'APPROVE',
      body: 'first',
    })

    await dispatched.promise
    abortGithubReviewStateForPr(githubOrigin.workspace, 7)

    const beforeSettlement = await run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: githubOrigin,
        sessionId: 'concurrent-session',
      }),
      { event: 'APPROVE', body: 'retry before verification' },
    )
    expect(beforeSettlement.details).toMatchObject({ ok: false, error: expect.stringContaining('settling') })
    expect(submissions).toBe(1)

    finishVerification.resolve()
    expect((await first).details).toMatchObject({ ok: true })

    const afterSettlement = await run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: githubOrigin,
        sessionId: 'after-settlement-session',
      }),
      { event: 'APPROVE', body: 'retry after verification' },
    )

    expect(afterSettlement.details).toMatchObject({
      ok: false,
      error: expect.stringContaining('already holds a standing APPROVED review'),
    })
    expect(submissions).toBe(1)
  })

  test('keeps adversarial finding paths inside a single Markdown code span', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })

    await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'summary',
      comments: [{ path: '`@team\n## injected.ts`', line: 4, body: 'finding' }],
    })

    expect(comments[0]?.text).toContain('`` `@team ## injected.ts`:4 ``')
    expect(comments[0]?.text).not.toContain('\n## injected.ts')
  })

  test('keeps concurrent REQUEST_CHANGES blocked instead of posting a fallback comment', async () => {
    const channelRouter = router()
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })
    const verdictGuard = {
      guard: async () => ({ block: true as const, kind: 'concurrent' as const, reason: 'already submitting' }),
      release: async () => {},
      noteLandedReview: async () => {},
    }

    const result = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId, verdictGuard }),
      { event: 'REQUEST_CHANGES', body: 'summary' },
    )

    expect(result.details).toMatchObject({ ok: false, error: 'already submitting' })
    expect(comments).toEqual([])
  })

  test('reports a failed duplicate-review comment fallback', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    channelRouter.registerOutbound('github', async () => ({
      ok: false,
      error: 'GitHub API 403: Issues permission required',
      code: 'callback-rejected',
    }))

    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'summary',
    })

    expect(result.details).toEqual({
      ok: false,
      error: 'GitHub API 403: Issues permission required',
      code: 'callback-rejected',
    })
  })

  test('retains a conservative dedupe shield when POST succeeded but verification outcome is unknown', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: false, error: 'verification timed out', code: 'transient', submitted: true }
    })
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    expect((await run(tool, { event: 'APPROVE', body: 'retry' })).details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
  })
})
