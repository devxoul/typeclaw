import { describe, expect, test } from 'bun:test'

import type { SubmitReviewRequest } from '@/channels/types'

import * as githubReviewSubmitter from './review-submitter'

type SeenPost = { event: string; body: string; commit_id: string; comments: unknown[] }

function fakeGithub(options: {
  patch?: string
  postStatus?: number
  seen?: SeenPost[]
  headShas?: string[]
  verifyState?: string
}) {
  let pullReads = 0
  let postedEvent = 'COMMENT'
  return Object.assign(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = String(url)
      const method = init?.method ?? 'GET'
      if (method === 'GET' && href.endsWith('/pulls/7')) {
        const headSha = options.headShas?.[pullReads] ?? options.headShas?.at(-1) ?? 'head-sha'
        pullReads++
        return json({ head: { sha: headSha } })
      }
      if (method === 'GET' && href.endsWith('/pulls/7/files?per_page=100')) {
        return json([{ filename: 'src/app.ts', patch: options.patch ?? '@@ -1,3 +1,4 @@\n old()\n+new()\n kept()' }])
      }
      if (method === 'POST' && href.endsWith('/pulls/7/reviews')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as SeenPost
        postedEvent = body.event
        options.seen?.push(body)
        return json({ id: 123, state: stateFor(body.event) }, options.postStatus ?? 200)
      }
      if (method === 'GET' && href.endsWith('/pulls/7/reviews/123')) {
        return json({ id: 123, state: options.verifyState ?? stateFor(postedEvent) })
      }
      return new Response('missing route', { status: 404 })
    },
    { preconnect: () => {} },
  )
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function stateFor(event: string): string {
  if (event === 'APPROVE') return 'APPROVED'
  if (event === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED'
  return 'COMMENTED'
}

function request(overrides: Partial<SubmitReviewRequest> = {}): SubmitReviewRequest {
  return {
    adapter: 'github',
    workspace: 'acme/widgets',
    chat: 'pr:7',
    event: 'COMMENT',
    body: 'summary',
    comments: [{ path: 'src/app.ts', line: 2, body: 'inline' }],
    ...overrides,
  }
}

function submitter(fetchImpl: typeof fetch, allowApprove = true) {
  return githubReviewSubmitter.createGithubReviewSubmitter({
    token: async () => 'example-token',
    allowApprove: () => allowApprove,
    fetchImpl,
  })
}

describe('github review submitter', () => {
  test('account rotation before the review POST cannot submit old account coverage', async () => {
    const seen: SeenPost[] = []
    let actor = 'github:account-a'
    const transport = fakeGithub({ seen })
    const submit = githubReviewSubmitter.createGithubReviewSubmitter({
      token: async () => 'example-token',
      allowApprove: () => true,
      accountIdentity: async () => actor,
      fetchImpl: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url).endsWith('/files?per_page=100')) actor = 'github:account-b'
          return transport(url, init)
        },
        { preconnect: () => {} },
      ),
    })
    const oldAccount = await submit(request({ event: 'APPROVE', expectedAccountIdentity: 'github:account-a' }))
    expect(oldAccount).toMatchObject({ ok: false, code: 'permission-denied' })
    expect(seen).toEqual([])
    const currentAccount = await submit(request({ event: 'APPROVE', expectedAccountIdentity: 'github:account-b' }))
    expect(currentAccount).toMatchObject({ ok: true, state: 'APPROVED' })
    expect(seen.map((review) => review.event)).toEqual(['APPROVE'])
  })

  test('scoped formal review fails closed when the authenticated actor is unavailable', async () => {
    const seen: SeenPost[] = []
    const submit = submitter(fakeGithub({ seen }))
    expect(await submit(request({ expectedAccountIdentity: 'github:account-a' }))).toMatchObject({
      ok: false,
      code: 'permission-denied',
    })
    expect(seen).toEqual([])
  })

  test('posts valid anchors against the resolved PR head and verifies the exact review', async () => {
    const seen: SeenPost[] = []
    const result = await submitter(fakeGithub({ seen }))(request())

    expect(result).toEqual({ ok: true, reviewId: 123, state: 'COMMENTED', commitSha: 'head-sha' })
    expect(seen[0]).toMatchObject({ commit_id: 'head-sha', comments: [{ path: 'src/app.ts', line: 2 }] })
  })

  test('posts only while the PR head is still the reviewed commit', async () => {
    const seen: SeenPost[] = []
    const reviewed = await submitter(fakeGithub({ seen }))(request({ event: 'APPROVE', expectedHeadSha: 'HEAD-SHA' }))
    const stale = await submitter(fakeGithub({ seen, headShas: ['newer-sha'] }))(
      request({ event: 'APPROVE', expectedHeadSha: 'head-sha' }),
    )

    expect(reviewed).toMatchObject({ ok: true, state: 'APPROVED' })
    expect(stale).toMatchObject({ ok: false, code: 'transient' })
    expect(stale.ok === false && stale.error).toContain('newer-sha')
    expect(seen).toHaveLength(1)
  })

  test('demotes out-of-diff findings into the review body', async () => {
    const seen: SeenPost[] = []
    const finding = { path: 'src/app.ts', line: 99, body: 'outside diff' }
    const result = await submitter(fakeGithub({ seen }))(request({ comments: [finding] }))

    expect(result).toMatchObject({ ok: true, reanchored: [finding] })
    expect(seen[0]?.comments).toEqual([])
    expect(seen[0]?.body).toContain('src/app.ts:99')
  })

  test('demotes malformed multiline ranges even when both endpoint lines are in the diff', async () => {
    const seen: SeenPost[] = []
    const finding = {
      path: 'src/app.ts',
      line: 2,
      side: 'RIGHT' as const,
      startLine: 3,
      startSide: 'RIGHT' as const,
      body: 'reversed range',
    }
    const result = await submitter(fakeGithub({ seen }))(request({ comments: [finding] }))

    expect(result).toMatchObject({ ok: true, reanchored: [finding] })
    expect(seen[0]?.comments).toEqual([])
  })

  test('serializes start_side whenever start_line is present and preserves LEFT ranges', async () => {
    const seen: SeenPost[] = []
    const patch = '@@ -1,3 +1,3 @@\n-oldOne()\n-oldTwo()\n+newOne()\n+newTwo()\n kept()'
    await submitter(fakeGithub({ seen, patch }))(
      request({
        comments: [
          { path: 'src/app.ts', line: 2, startLine: 1, startSide: 'RIGHT', body: 'right range' },
          { path: 'src/app.ts', line: 2, side: 'LEFT', startLine: 1, startSide: 'LEFT', body: 'left range' },
        ],
      }),
    )

    expect(seen[0]?.comments).toEqual([
      {
        path: 'src/app.ts',
        line: 2,
        side: 'RIGHT',
        body: 'right range',
        start_line: 1,
        start_side: 'RIGHT',
      },
      {
        path: 'src/app.ts',
        line: 2,
        side: 'LEFT',
        body: 'left range',
        start_line: 1,
        start_side: 'LEFT',
      },
    ])
  })

  test('reanchors partial multiline ranges instead of serializing partial metadata', async () => {
    const seen: SeenPost[] = []
    const finding = { path: 'src/app.ts', line: 2, startSide: 'RIGHT' as const, body: 'partial range' }
    const result = await submitter(fakeGithub({ seen }))(request({ comments: [finding] }))

    expect(result).toMatchObject({ ok: true, reanchored: [finding] })
    expect(seen[0]?.comments).toEqual([])
  })

  test('requires verification state to match the submitted event', async () => {
    for (const event of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const) {
      const result = await submitter(fakeGithub({ verifyState: 'DISMISSED' }))(request({ event }))
      expect(result).toMatchObject({ ok: false, submitted: true, code: 'transient' })
    }
  })

  test('retries anchor collection when the head changes and submits only a stable head', async () => {
    const seen: SeenPost[] = []
    const result = await submitter(fakeGithub({ seen, headShas: ['old', 'new', 'new', 'new'] }))(request())

    expect(result).toMatchObject({ ok: true })
    expect(seen[0]?.commit_id).toBe('new')
  })

  test('fails transiently when the head never stabilizes within the retry bound', async () => {
    const seen: SeenPost[] = []
    const result = await submitter(fakeGithub({ seen, headShas: ['a', 'b', 'c', 'd', 'e', 'f'] }))(request())

    expect(result).toMatchObject({ ok: false, code: 'transient' })
    expect(seen).toEqual([])
  })

  test('downgrades APPROVE to COMMENT when operator policy disables approval', async () => {
    const seen: SeenPost[] = []
    const result = await submitter(fakeGithub({ seen }), false)(request({ event: 'APPROVE' }))

    expect(result).toMatchObject({ ok: true, downgraded: true })
    expect(seen[0]?.event).toBe('COMMENT')
  })

  test('preserves APPROVE when operator policy allows it', async () => {
    const seen: SeenPost[] = []
    await submitter(fakeGithub({ seen }), true)(request({ event: 'APPROVE' }))
    expect(seen[0]?.event).toBe('APPROVE')
  })

  test('denies a submission when its PR generation is invalidated before POST dispatch', async () => {
    const filesRequested = Promise.withResolvers<void>()
    const releaseFiles = Promise.withResolvers<void>()
    let postCount = 0
    const baseFetch = fakeGithub({ seen: [] })
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/pulls/7/files?per_page=100')) {
          filesRequested.resolve()
          await releaseFiles.promise
        }
        if (init?.method === 'POST' && url.endsWith('/pulls/7/reviews')) postCount++
        return baseFetch(input, init)
      },
      { preconnect: () => {} },
    ) as typeof fetch

    const pending = submitter(fetchImpl)(request())
    await filesRequested.promise
    githubReviewSubmitter.invalidateGithubReviewSubmission('acme/widgets', 7)
    releaseFiles.resolve()

    expect(await pending).toEqual({
      ok: false,
      error: 'PR converted to draft; review submission cancelled',
      code: 'transient',
    })
    expect(postCount).toBe(0)
  })

  test('lets an already-dispatched submission finish verification after invalidation', async () => {
    const postDispatched = Promise.withResolvers<void>()
    const releasePost = Promise.withResolvers<void>()
    let verificationReads = 0
    const baseFetch = fakeGithub({ seen: [] })
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (init?.method === 'POST' && url.endsWith('/pulls/7/reviews')) {
          postDispatched.resolve()
          await releasePost.promise
        }
        if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/pulls/7/reviews/123')) verificationReads++
        return baseFetch(input, init)
      },
      { preconnect: () => {} },
    ) as typeof fetch

    const pending = submitter(fetchImpl)(request())
    await postDispatched.promise
    githubReviewSubmitter.invalidateGithubReviewSubmission('acme/widgets', 7)
    releasePost.resolve()

    expect(await pending).toEqual({ ok: true, reviewId: 123, state: 'COMMENTED', commitSha: 'head-sha' })
    expect(verificationReads).toBe(1)
  })

  test('classifies a rejected post and validates targets before mutation', async () => {
    const denied = await submitter(fakeGithub({ postStatus: 403 }))(request())
    expect(denied).toMatchObject({ ok: false, code: 'permission-denied' })

    const seen: SeenPost[] = []
    const submit = submitter(fakeGithub({ seen }))
    for (const invalid of [request({ workspace: 'acme' }), request({ chat: 'issue:7' }), request({ chat: 'pr:1e2' })]) {
      expect(await submit(invalid)).toMatchObject({ ok: false })
    }
    expect(seen).toEqual([])
  })
})
