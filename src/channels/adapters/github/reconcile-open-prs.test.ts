import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InboundMessage, RouteReceipt } from '@/channels/types'

import {
  DEFAULT_RECONCILE_COOLDOWN_MS,
  loadReconcileCooldownStore,
  type ReconcileCooldownStore,
} from './reconcile-cooldown-store'
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

const ACCEPTED: RouteReceipt = { kind: 'accepted', inputId: 'input', generation: 1 }

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
      return ACCEPTED
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

describe('reconcileOpenPrs cooldown', () => {
  const REPO = 'acme/widgets'
  const WINDOW = DEFAULT_RECONCILE_COOLDOWN_MS
  const silentStoreLogger = { info: () => {}, warn: () => {}, error: () => {} }
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'reconcile-open-prs-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  function loadStore(): Promise<ReconcileCooldownStore> {
    return loadReconcileCooldownStore(agentDir, silentStoreLogger)
  }

  async function coolingAfterReload(prId: number, now = 1_001, repo = REPO): Promise<boolean> {
    return (await loadStore()).isCoolingDown(repo, prId, now, WINDOW)
  }

  async function seedMarker(prId: number, now: number): Promise<void> {
    await (await loadStore()).markReplayed(REPO, prId, { now, cooldownMs: WINDOW })
  }

  test('replays a never-reconciled PR and keeps its cooldown once the router admits it', async () => {
    const routed: InboundMessage[] = []
    const outcomes = await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: await loadStore(),
        now: () => 1_000,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routed.map((m) => m.chat)).toEqual(['pr:7'])
    expect(outcomes).toEqual([{ repo: REPO, scanned: 1, replayed: 1 }])
    expect(await coolingAfterReload(700)).toBe(true)
  })

  test('skips a PR replayed within the cooldown window (restart within cooldown)', async () => {
    await seedMarker(700, 1_000)
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: await loadStore(),
        now: () => 1_000 + WINDOW - 1,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routed).toHaveLength(0)
  })

  test('an updatedAt change within the cooldown does NOT re-trigger a replay', async () => {
    await seedMarker(700, 1_000)
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: await loadStore(),
        now: () => 1_000 + 60_000,
        fetchImpl: fakeGithub([{ number: 7, id: 700, updatedAt: '2026-02-02T00:00:00Z' }]),
      }),
    )
    expect(routed).toHaveLength(0)
  })

  test('retries a still-unreviewed PR after the cooldown expires', async () => {
    await seedMarker(700, 1_000)
    const routed: InboundMessage[] = []
    const now = 1_000 + WINDOW + 1
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: await loadStore(),
        now: () => now,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routed.map((m) => m.chat)).toEqual(['pr:7'])
    expect(await coolingAfterReload(700, now + 1)).toBe(true)
  })

  test('a posted review suppresses replay even when the cooldown has expired', async () => {
    await seedMarker(700, 1_000)
    const routed: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: await loadStore(),
        now: () => 1_000 + WINDOW + 1,
        fetchImpl: fakeGithub([{ number: 7, id: 700, selfReviewed: true }]),
      }),
    )
    expect(routed).toHaveLength(0)
  })

  test('prunes markers of PRs that are no longer open and keeps open ones', async () => {
    await seedMarker(700, 1_000)
    await seedMarker(900, 1_000)
    await reconcileOpenPrs(
      baseOptions({
        routed: [],
        cooldownStore: await loadStore(),
        now: () => 2_000,
        fetchImpl: fakeGithub([
          { number: 7, id: 700, selfReviewed: true },
          { number: 8, id: 800 },
        ]),
      }),
    )
    expect(await coolingAfterReload(700, 2_001)).toBe(true)
    expect(await coolingAfterReload(800, 2_001)).toBe(true)
    expect(await coolingAfterReload(900, 2_001)).toBe(false)
  })

  test('does NOT route when persisting the reservation fails', async () => {
    await writeFile(join(agentDir, 'channels'), 'not a directory', 'utf8')
    const routed: InboundMessage[] = []
    const warnings: string[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: await loadStore(),
        now: () => 1_000,
        logger: { info: () => {}, warn: (m) => warnings.push(m) },
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routed).toHaveLength(0)
    expect(warnings.some((w) => w.includes('PR #7') && w.includes('cooldown persist failed'))).toBe(true)
  })

  test('a rejected replay does not stop the remaining PRs or repos and is retried on later passes and after reload', async () => {
    // given a route that rejects acme/widgets PR #7 on its first two attempts
    let failuresLeft = 2
    const attempts: string[] = []
    const warnings: string[] = []
    const pass = (store: ReconcileCooldownStore) =>
      reconcileOpenPrs(
        baseOptions({
          routed: [],
          repos: [REPO, 'acme/other'],
          route: async (m) => {
            attempts.push(`${m.workspace} ${m.chat}`)
            if (m.workspace === REPO && m.chat === 'pr:7' && failuresLeft-- > 0) {
              throw new Error('journal append failed')
            }
            return ACCEPTED
          },
          cooldownStore: store,
          now: () => 1_000,
          logger: { info: () => {}, warn: (w) => warnings.push(w) },
          fetchImpl: fakeGithub([
            { number: 7, id: 700 },
            { number: 8, id: 800 },
          ]),
        }),
      )

    // when the first pass runs, every other PR is still replayed and admitted
    const store = await loadStore()
    expect(await pass(store)).toEqual([
      { repo: REPO, scanned: 2, replayed: 1 },
      { repo: 'acme/other', scanned: 2, replayed: 2 },
    ])
    expect(attempts).toEqual([`${REPO} pr:7`, `${REPO} pr:8`, 'acme/other pr:7', 'acme/other pr:8'])
    expect(warnings.some((w) => w.includes(`${REPO}: PR #7`) && w.includes('journal append failed'))).toBe(true)

    // then a later pass on the same store retries only the failed PR
    attempts.length = 0
    await pass(store)
    expect(attempts).toEqual([`${REPO} pr:7`])

    // and so does a pass after the store reloads, whose admission is kept
    attempts.length = 0
    expect(await pass(await loadStore())).toEqual([
      { repo: REPO, scanned: 2, replayed: 1 },
      { repo: 'acme/other', scanned: 2, replayed: 0 },
    ])
    expect(attempts).toEqual([`${REPO} pr:7`])
    attempts.length = 0
    await pass(await loadStore())
    expect(attempts).toEqual([])
  })

  test('only accepted or duplicate receipts keep the cooldown; observed, denied and control release it', async () => {
    const receipts: Record<string, RouteReceipt> = {
      'pr:1': ACCEPTED,
      'pr:2': { kind: 'duplicate', inputId: 'input-2' },
      'pr:3': { kind: 'observed' },
      'pr:4': { kind: 'denied' },
      'pr:5': { kind: 'control' },
    }
    const prs = [1, 2, 3, 4, 5].map((number) => ({ number, id: number * 100 }))
    const attempts: string[] = []
    const infos: string[] = []
    const pass = async () =>
      reconcileOpenPrs(
        baseOptions({
          routed: [],
          route: async (m) => {
            attempts.push(m.chat)
            return receipts[m.chat]!
          },
          cooldownStore: await loadStore(),
          now: () => 1_000,
          logger: { info: (m) => infos.push(m), warn: () => {} },
          fetchImpl: fakeGithub(prs),
        }),
      )

    expect(await pass()).toEqual([{ repo: REPO, scanned: 5, replayed: 2 }])
    expect(infos.some((m) => m.includes('replayed 2/5'))).toBe(true)
    for (const [number, kind] of [
      [3, 'observed'],
      [4, 'denied'],
      [5, 'control'],
    ] as const) {
      expect(infos.some((m) => m.includes(`PR #${number}`) && m.includes(kind))).toBe(true)
    }
    const cooling = await Promise.all(prs.map((pr) => coolingAfterReload(pr.id)))
    expect(cooling).toEqual([true, true, false, false, false])

    attempts.length = 0
    await pass()
    expect(attempts).toEqual(['pr:3', 'pr:4', 'pr:5'])
  })

  test('a pass stopped after reserving but before dispatch releases its reservation and routes nothing', async () => {
    // given a stop that lands right after the reservation is persisted
    let cancelled = false
    const real = await loadStore()
    const store: ReconcileCooldownStore = {
      ...real,
      markReplayed: async (...args) => {
        const reservation = await real.markReplayed(...args)
        cancelled = true
        return reservation
      },
    }
    const routed: InboundMessage[] = []

    await reconcileOpenPrs(
      baseOptions({
        routed,
        cooldownStore: store,
        now: () => 1_000,
        isCancelled: () => cancelled,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )

    expect(routed).toHaveLength(0)
    expect(await coolingAfterReload(700)).toBe(false)
  })

  async function stopDuringDispatch(settle: (route: PromiseWithResolvers<RouteReceipt>) => void) {
    let cancelled = false
    const dispatched = Promise.withResolvers<void>()
    const route = Promise.withResolvers<RouteReceipt>()
    const attempts: string[] = []
    const pass = reconcileOpenPrs(
      baseOptions({
        routed: [],
        route: (m) => {
          attempts.push(m.chat)
          dispatched.resolve()
          return route.promise
        },
        cooldownStore: await loadStore(),
        now: () => 1_000,
        isCancelled: () => cancelled,
        fetchImpl: fakeGithub([
          { number: 7, id: 700 },
          { number: 8, id: 800 },
        ]),
      }),
    )
    await dispatched.promise
    cancelled = true
    // A replacement adapter loads the store while the stale route is pending.
    const replacement = await loadStore()
    const coolingWhilePending = replacement.isCoolingDown(REPO, 700, 1_001, WINDOW)
    settle(route)
    return { coolingWhilePending, outcomes: await pass, attempts }
  }

  test('stopping during a dispatched replay neither clears an admitted cooldown nor blocks a replacement load', async () => {
    const result = await stopDuringDispatch((route) => route.resolve(ACCEPTED))

    expect(result.coolingWhilePending).toBe(true)
    expect(result.outcomes).toEqual([{ repo: REPO, scanned: 2, replayed: 1 }])
    expect(result.attempts).toEqual(['pr:7'])
    expect(await coolingAfterReload(700)).toBe(true)
    expect(await coolingAfterReload(800)).toBe(false)
  })

  test('a dispatched replay that fails after the adapter stopped releases its own reservation', async () => {
    const result = await stopDuringDispatch((route) => route.reject(new Error('router stopped')))

    expect(result.coolingWhilePending).toBe(true)
    expect(result.outcomes).toEqual([{ repo: REPO, scanned: 2, replayed: 0 }])
    expect(await coolingAfterReload(700)).toBe(false)
  })

  test('an old attempt failing after a newer pass re-reserved the PR on the same clock keeps the newer cooldown', async () => {
    // given an old lifecycle whose replay of PR #7 is still being routed
    let oldCancelled = false
    const oldDispatched = Promise.withResolvers<void>()
    const oldRoute = Promise.withResolvers<RouteReceipt>()
    const oldPass = reconcileOpenPrs(
      baseOptions({
        routed: [],
        route: () => {
          oldDispatched.resolve()
          return oldRoute.promise
        },
        cooldownStore: await loadStore(),
        now: () => 1_000,
        isCancelled: () => oldCancelled,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    await oldDispatched.promise
    oldCancelled = true

    // and a replacement lifecycle that cleared the marker (draft conversion)
    // and re-reserved PR #7 at the identical timestamp
    const replacement = await loadStore()
    await replacement.clear(REPO, 700)
    const routedByReplacement: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed: routedByReplacement,
        cooldownStore: replacement,
        now: () => 1_000,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routedByReplacement.map((m) => m.chat)).toEqual(['pr:7'])

    // when the old attempt's route finally rejects
    oldRoute.reject(new Error('superseded live session creation discarded'))
    await oldPass

    // then the replacement's cooldown survives the old attempt's rollback
    expect(await coolingAfterReload(700, 1_000)).toBe(true)
    const routedLater: InboundMessage[] = []
    await reconcileOpenPrs(
      baseOptions({
        routed: routedLater,
        cooldownStore: await loadStore(),
        now: () => 1_000,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    expect(routedLater).toHaveLength(0)
  })

  test("a replacement's very next pass retries a PR whose older attempt was released after the replacement loaded", async () => {
    // given an old lifecycle whose replay of PR #7 is still being routed
    let oldCancelled = false
    const oldDispatched = Promise.withResolvers<void>()
    const oldRoute = Promise.withResolvers<RouteReceipt>()
    const oldPass = reconcileOpenPrs(
      baseOptions({
        routed: [],
        route: () => {
          oldDispatched.resolve()
          return oldRoute.promise
        },
        cooldownStore: await loadStore(),
        now: () => 1_000,
        isCancelled: () => oldCancelled,
        fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
      }),
    )
    await oldDispatched.promise
    oldCancelled = true

    // and a replacement store loaded while that reservation is genuinely current
    const replacement = await loadStore()
    const replacementPass = async (): Promise<string[]> => {
      const routed: InboundMessage[] = []
      await reconcileOpenPrs(
        baseOptions({
          routed,
          cooldownStore: replacement,
          now: () => 1_000,
          fetchImpl: fakeGithub([{ number: 7, id: 700 }]),
        }),
      )
      return routed.map((m) => m.chat)
    }

    // then the replacement does not launch PR #7 a second time meanwhile
    expect(await replacementPass()).toEqual([])

    // when the old attempt's route rejects and it releases its own reservation
    oldRoute.reject(new Error('router stopped'))
    await oldPass

    // then the replacement's very next pass, on the same clock reading, retries it
    expect(await replacementPass()).toEqual(['pr:7'])
    expect(await coolingAfterReload(700, 1_000)).toBe(true)
  })

  test('concurrent passes from stale store snapshots launch each PR only once', async () => {
    const stores = [await loadStore(), await loadStore()]
    const routed: InboundMessage[] = []

    await Promise.all(
      stores.map((store) =>
        reconcileOpenPrs(
          baseOptions({
            routed,
            cooldownStore: store,
            now: () => 1_000,
            fetchImpl: fakeGithub([
              { number: 7, id: 700 },
              { number: 8, id: 800 },
            ]),
          }),
        ),
      ),
    )

    expect(routed.map((m) => m.chat).sort()).toEqual(['pr:7', 'pr:8'])
  })

  test('a rollback that cannot persist is reported, keeps the cooldown, and does not stop the remaining PRs', async () => {
    const real = await loadStore()
    const store: ReconcileCooldownStore = {
      ...real,
      rollbackReplay: async () => {
        throw new Error('ENOSPC: disk full')
      },
    }
    const attempts: string[] = []
    const warnings: string[] = []

    const outcomes = await reconcileOpenPrs(
      baseOptions({
        routed: [],
        route: async (m) => {
          attempts.push(m.chat)
          if (m.chat === 'pr:7') throw new Error('route failed')
          return ACCEPTED
        },
        cooldownStore: store,
        now: () => 1_000,
        logger: { info: () => {}, warn: (w) => warnings.push(w) },
        fetchImpl: fakeGithub([
          { number: 7, id: 700 },
          { number: 8, id: 800 },
        ]),
      }),
    )

    expect(attempts).toEqual(['pr:7', 'pr:8'])
    expect(outcomes).toEqual([{ repo: REPO, scanned: 2, replayed: 1 }])
    expect(warnings.some((w) => w.includes('PR #7') && w.includes('NOT released') && w.includes('ENOSPC'))).toBe(true)
    expect(await coolingAfterReload(700)).toBe(true)
  })
})
