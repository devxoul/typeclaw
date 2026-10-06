import { describe, expect, test } from 'bun:test'

import type { InboundMessage } from '@/channels/types'

import { DEFAULT_RECONCILE_COOLDOWN_MS, type ReconcileCooldownStore } from './reconcile-cooldown-store'
import { reconcileOpenPrs, type ReconcileOpenPrsOptions } from './reconcile-open-prs'
import type { TeamMembershipChecker } from './team-membership'

type PrFixture = {
  number: number
  id: number
  title?: string
  draft?: boolean
  authorLogin?: string
  authorId?: number
  authorType?: 'User' | 'Bot'
  headRef?: string
  baseRef?: string
  updatedAt?: string
  requestedReviewers?: string[]
  requestedTeams?: string[]
  selfReviewed?: boolean
  reviewerLogin?: string
  reviewerType?: 'User' | 'Bot'
}

function prJson(pr: PrFixture): Record<string, unknown> {
  return {
    number: pr.number,
    id: pr.id,
    title: pr.title ?? `PR ${pr.number}`,
    draft: pr.draft ?? false,
    updated_at: pr.updatedAt ?? '2026-01-01T00:00:00Z',
    user: { login: pr.authorLogin ?? 'alice', id: pr.authorId ?? 10, type: pr.authorType ?? 'User' },
    head: { ref: pr.headRef ?? 'feature' },
    base: { ref: pr.baseRef ?? 'main' },
    requested_reviewers: (pr.requestedReviewers ?? []).map((login) => ({ login })),
    requested_teams: (pr.requestedTeams ?? []).map((slug) => ({ slug })),
  }
}

function teamChecker(memberSlugs: readonly string[]): TeamMembershipChecker {
  return async ({ slug }) => memberSlugs.includes(slug)
}

function reviewsJson(pr: PrFixture): Array<Record<string, unknown>> {
  if (!pr.selfReviewed) return []
  return [{ state: 'COMMENTED', user: { login: pr.reviewerLogin ?? 'bot', type: pr.reviewerType ?? 'Bot' } }]
}

// Serves /pulls (list) and /pulls/{n}/reviews for a single repo from fixtures.
function fakeGithub(prs: PrFixture[]): typeof fetch {
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const reviewsMatch = url.match(/\/pulls\/(\d+)\/reviews/)
    if (reviewsMatch) {
      const number = Number(reviewsMatch[1])
      const pr = prs.find((p) => p.number === number)
      return Response.json(pr ? reviewsJson(pr) : [])
    }
    if (url.includes('/pulls?')) {
      return Response.json(prs.map(prJson))
    }
    return new Response('unexpected', { status: 500 })
  }
  return Object.assign(fn, { preconnect: () => {} }) as typeof fetch
}

function baseOptions(
  overrides: Partial<ReconcileOpenPrsOptions> & { routed: InboundMessage[] },
): ReconcileOpenPrsOptions {
  const { routed, ...rest } = overrides
  return {
    repos: ['acme/widgets'],
    reviewOn: 'opened',
    selfLogin: 'bot',
    authType: 'pat',
    token: async () => 'tok',
    route: async (m) => {
      routed.push(m)
      return { kind: 'observed' as const }
    },
    logger: { info: () => {}, warn: () => {} },
    fetchImpl: fakeGithub([]),
    ...rest,
  }
}

describe('reconcileOpenPrs', () => {
  test("reviewOn 'opened' replays a non-draft, un-reviewed PR as a review trigger", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(baseOptions({ routed, fetchImpl: fakeGithub([{ number: 7, id: 700, title: 'Add thing' }]) }))
    expect(routed).toHaveLength(1)
    const msg = routed[0]
    expect(msg?.chat).toBe('pr:7')
    expect(msg?.isBotMention).toBe(true)
    expect(msg?.text).toContain('opened PR #7: "Add thing"')
    expect(msg?.text).toContain('Please review the changes line-by-line')
    expect(msg?.externalMessageId).toBe('pr-700-reconcile-2026-01-01T00:00:00Z')
  })

  test("reviewOn 'opened' skips a draft PR", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(baseOptions({ routed, fetchImpl: fakeGithub([{ number: 7, id: 700, draft: true }]) }))
    expect(routed).toHaveLength(0)
  })

  test("reviewOn 'opened' skips a PR the bot already reviewed", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(baseOptions({ routed, fetchImpl: fakeGithub([{ number: 7, id: 700, selfReviewed: true }]) }))
    expect(routed).toHaveLength(0)
  })

  test("reviewOn 'opened' skips a PR the bot opened itself", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        fetchImpl: fakeGithub([{ number: 7, id: 700, authorLogin: 'bot', authorType: 'Bot' }]),
      }),
    )
    expect(routed).toHaveLength(0)
  })

  test("reviewOn 'off' replays nothing", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(baseOptions({ routed, reviewOn: 'off', fetchImpl: fakeGithub([{ number: 7, id: 700 }]) }))
    expect(routed).toHaveLength(0)
  })

  test("reviewOn 'review_requested' replays only when the bot is a requested reviewer", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        reviewOn: 'review_requested',
        fetchImpl: fakeGithub([
          { number: 7, id: 700, requestedReviewers: ['bot'] },
          { number: 8, id: 800, requestedReviewers: ['someone-else'] },
          { number: 9, id: 900, requestedReviewers: [] },
        ]),
      }),
    )
    expect(routed.map((m) => m.chat)).toEqual(['pr:7'])
  })

  test("reviewOn 'review_requested' replays a draft when the bot is requested (draft state irrelevant here)", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        reviewOn: 'review_requested',
        fetchImpl: fakeGithub([{ number: 7, id: 700, draft: true, requestedReviewers: ['bot'] }]),
      }),
    )
    expect(routed.map((m) => m.chat)).toEqual(['pr:7'])
  })

  test("reviewOn 'review_requested' replays when review is requested from a team the bot is in", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        reviewOn: 'review_requested',
        isBotInTeam: teamChecker(['reviewers']),
        fetchImpl: fakeGithub([
          { number: 7, id: 700, requestedTeams: ['reviewers'] },
          { number: 8, id: 800, requestedTeams: ['other-team'] },
        ]),
      }),
    )
    expect(routed.map((m) => m.chat)).toEqual(['pr:7'])
  })

  test("reviewOn 'review_requested' skips team requests when no membership checker is provided", async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        reviewOn: 'review_requested',
        fetchImpl: fakeGithub([{ number: 7, id: 700, requestedTeams: ['reviewers'] }]),
      }),
    )
    expect(routed).toHaveLength(0)
  })

  test('App decoy: matches the bare-slug requested reviewer and skips a decoy-opened PR', async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        reviewOn: 'review_requested',
        selfLogin: 'typey[bot]',
        authType: 'app',
        fetchImpl: fakeGithub([
          { number: 7, id: 700, requestedReviewers: ['typey'] },
          { number: 8, id: 800, authorLogin: 'typey', requestedReviewers: ['typey'] },
        ]),
      }),
    )
    expect(routed.map((m) => m.chat)).toEqual(['pr:7'])
  })

  test('a null selfLogin replays nothing (identity not yet resolved)', async () => {
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(baseOptions({ routed, selfLogin: null, fetchImpl: fakeGithub([{ number: 7, id: 700 }]) }))
    expect(routed).toHaveLength(0)
  })

  test('a per-repo fetch failure is isolated and reported, not thrown', async () => {
    const routed: InboundMessage[] = []
    const failing = Object.assign(async () => new Response('boom', { status: 500 }), {
      preconnect: () => {},
    }) as typeof fetch
    const outcomes = await reconcileOpenPrs(baseOptions({ routed, fetchImpl: failing }))
    expect(routed).toHaveLength(0)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ repo: 'acme/widgets' })
    expect('error' in outcomes[0]!).toBe(true)
  })

  test('a malformed repo slug is reported without a fetch', async () => {
    const routed: InboundMessage[] = []
    let fetched = false
    const spyFetch = Object.assign(
      async () => {
        fetched = true
        return Response.json([])
      },
      { preconnect: () => {} },
    ) as typeof fetch
    const outcomes = await reconcileOpenPrs(baseOptions({ routed, repos: ['not-a-slug'], fetchImpl: spyFetch }))
    expect(fetched).toBe(false)
    expect(outcomes[0]).toMatchObject({ repo: 'not-a-slug', error: 'malformed repo slug' })
  })
})

function fakeCooldownStore(initial: ReadonlyArray<{ repo: string; prId: number; lastReplayAt: number }> = []): {
  store: ReconcileCooldownStore
  markers: Map<string, number>
  pruned: Array<{ repo: string; ids: number[] }>
} {
  const markers = new Map<string, number>()
  for (const m of initial) markers.set(`${m.repo}#${m.prId}`, m.lastReplayAt)
  const pruned: Array<{ repo: string; ids: number[] }> = []
  const store: ReconcileCooldownStore = {
    isCoolingDown: (repo, prId, now, cooldownMs) => {
      const at = markers.get(`${repo}#${prId}`)
      return at !== undefined && now - at < cooldownMs
    },
    markReplayed: async (repo, prId, now) => {
      markers.set(`${repo}#${prId}`, now)
      return true
    },
    clear: async (repo, prId) => {
      markers.delete(`${repo}#${prId}`)
    },
    prune: async (repo, openPrIds) => {
      pruned.push({ repo, ids: Array.from(openPrIds) })
    },
  }
  return { store, markers, pruned }
}

describe('reconcileOpenPrs cooldown', () => {
  test('replays a never-reconciled PR and records the marker before routing', async () => {
    const routed: InboundMessage[] = []
    const { store, markers } = fakeCooldownStore()
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: store,
        now: () => 1_000,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routed.map((m) => m.chat)).toEqual(['pr:7'])
    expect(markers.get('acme/widgets#700')).toBe(1_000)
  })

  test('skips a PR replayed within the cooldown window (restart within cooldown)', async () => {
    const routed: InboundMessage[] = []
    const { store } = fakeCooldownStore([{ repo: 'acme/widgets', prId: 700, lastReplayAt: 1_000 }])
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: store,
        now: () => 1_000 + DEFAULT_RECONCILE_COOLDOWN_MS - 1,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routed).toHaveLength(0)
  })

  test('an updatedAt change within the cooldown does NOT re-trigger a replay', async () => {
    const routed: InboundMessage[] = []
    const { store } = fakeCooldownStore([{ repo: 'acme/widgets', prId: 700, lastReplayAt: 1_000 }])
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: store,
        now: () => 1_000 + 60_000,
        fetchImpl: fakeGithub([{ number: 7, id: 700, updatedAt: '2026-02-02T00:00:00Z' }]),
      }),
    )
    expect(routed).toHaveLength(0)
  })

  test('retries a still-unreviewed PR after the cooldown expires', async () => {
    const routed: InboundMessage[] = []
    const { store, markers } = fakeCooldownStore([{ repo: 'acme/widgets', prId: 700, lastReplayAt: 1_000 }])
    const now = 1_000 + DEFAULT_RECONCILE_COOLDOWN_MS + 1
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: store,
        now: () => now,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routed.map((m) => m.chat)).toEqual(['pr:7'])
    expect(markers.get('acme/widgets#700')).toBe(now)
  })

  test('a posted review suppresses replay even when the cooldown has expired', async () => {
    const routed: InboundMessage[] = []
    const { store } = fakeCooldownStore([{ repo: 'acme/widgets', prId: 700, lastReplayAt: 1_000 }])
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: store,
        now: () => 1_000 + DEFAULT_RECONCILE_COOLDOWN_MS + 1,
        fetchImpl: fakeGithub([{ number: 7, id: 700, selfReviewed: true }]),
      }),
    )
    expect(routed).toHaveLength(0)
  })

  test('prunes the cooldown store with the currently-open PR ids', async () => {
    const routed: InboundMessage[] = []
    const { store, pruned } = fakeCooldownStore()
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: store,
        now: () => 1_000,
        fetchImpl: fakeGithub([
          { number: 7, id: 700 },
          { number: 8, id: 800, selfReviewed: true },
        ]),
      }),
    )
    expect(pruned).toEqual([{ repo: 'acme/widgets', ids: [700, 800] }])
  })

  test('does NOT route when persisting the cooldown marker fails', async () => {
    const routed: InboundMessage[] = []
    const { store } = fakeCooldownStore()
    const failingStore: ReconcileCooldownStore = {
      ...store,
      markReplayed: async () => {
        throw new Error('ENOSPC: disk full')
      },
    }
    const warnings: string[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: failingStore,
        now: () => 1_000,
        logger: { info: () => {}, warn: (m) => warnings.push(m) },
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routed).toHaveLength(0)
    expect(warnings.some((w) => w.includes('cooldown persist failed'))).toBe(true)
  })
})
