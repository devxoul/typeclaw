import { githubReviewerWorkKey } from '@/channels/github-repo'
import type {
  ReviewFinding,
  ReviewSubmitter,
  SubmitReviewErrorCode,
  SubmitReviewRequest,
  SubmitReviewResult,
} from '@/channels/types'

import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import { createBoundedMap } from './dedup'

const MAX_HEAD_STABILITY_ATTEMPTS = 3

// Bounded because a long-lived container accumulates one entry per drafted PR
// forever otherwise. Eviction is fail-safe: a submission that captured a bumped
// generation sees the evicted key read back as 0, mismatches, and is denied —
// eviction can only cancel a submission, never resurrect a cancelled one.
const reviewSubmissionGenerations = createBoundedMap<string, number>()

export function invalidateGithubReviewSubmission(workspace: string, prNumber: number): void {
  const key = githubReviewerWorkKey(workspace, prNumber)
  reviewSubmissionGenerations.set(key, currentReviewSubmissionGeneration(workspace, prNumber) + 1)
}

export function createGithubReviewSubmitter(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  allowApprove: () => boolean
  accountIdentity?: () => Promise<string | undefined>
  fetchImpl?: typeof fetch
}): ReviewSubmitter {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (req): Promise<SubmitReviewResult> => {
    if (req.adapter !== 'github') return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    const target = parseTarget(req)
    if (target === null) {
      return {
        ok: false,
        error: `unparseable github review target (workspace=${req.workspace}, chat=${req.chat})`,
        code: 'transient',
      }
    }
    const submissionGeneration = currentReviewSubmissionGeneration(req.workspace, target.prNumber)

    const token = await deps.token({ repoSlug: `${target.owner}/${target.repo}` })
    const stable = await fetchStableAnchors(fetchImpl, token, target)
    if (!stable.ok) return stable
    if (
      req.expectedHeadSha !== undefined &&
      req.expectedHeadSha.toLocaleLowerCase() !== stable.headSha.toLocaleLowerCase()
    ) {
      return {
        ok: false,
        error: `GitHub pull request head is ${stable.headSha}, not the reviewed commit ${req.expectedHeadSha}; re-review the current head before submitting`,
        code: 'transient',
      }
    }

    const { inline, reanchored } = partitionComments(req.comments, stable.anchors)
    const downgraded = req.event === 'APPROVE' && !deps.allowApprove()
    const event = downgraded ? 'COMMENT' : req.event
    if (req.expectedAccountIdentity !== undefined && (await deps.accountIdentity?.()) !== req.expectedAccountIdentity) {
      return { ok: false, error: 'GitHub review account identity changed or unavailable', code: 'permission-denied' }
    }
    if (currentReviewSubmissionGeneration(req.workspace, target.prNumber) !== submissionGeneration) {
      return {
        ok: false,
        error: 'PR converted to draft; review submission cancelled',
        code: 'transient',
      }
    }
    // Once this call dispatches fetch(), GitHub may already have accepted the
    // review. Let posting, verification, and accounting settle after that
    // boundary; cancelling mid-flight would leave duplicate/state ambiguity.
    const posted = await postReview(fetchImpl, token, target, {
      event,
      body: appendReanchored(req.body, reanchored),
      commitId: stable.headSha,
      comments: inline,
    })
    if (!posted.ok) return posted
    const verified = await verifyReview(fetchImpl, token, target, posted.reviewId, event)
    if (!verified.ok) return { ...verified, submitted: true }
    return {
      ok: true,
      reviewId: verified.reviewId,
      state: verified.state,
      commitSha: stable.headSha,
      ...(downgraded ? { downgraded: true } : {}),
      ...(reanchored.length > 0 ? { reanchored } : {}),
    }
  }
}

function currentReviewSubmissionGeneration(workspace: string, prNumber: number): number {
  return reviewSubmissionGenerations.get(githubReviewerWorkKey(workspace, prNumber)) ?? 0
}

async function fetchStableAnchors(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
): Promise<{ ok: true; headSha: string; anchors: Set<string> } | (SubmitReviewResult & { ok: false })> {
  for (let attempt = 0; attempt < MAX_HEAD_STABILITY_ATTEMPTS; attempt++) {
    const before = await fetchPull(fetchImpl, token, target)
    if (!before.ok) return before
    const anchors = await fetchAnchors(fetchImpl, token, target)
    if (!anchors.ok) return anchors
    const after = await fetchPull(fetchImpl, token, target)
    if (!after.ok) return after
    if (before.headSha === after.headSha) return { ok: true, headSha: before.headSha, anchors: anchors.anchors }
  }
  return { ok: false, error: 'GitHub pull request head changed during anchor collection', code: 'transient' }
}

type ReviewTarget = { owner: string; repo: string; prNumber: number }

function parseTarget(req: SubmitReviewRequest): ReviewTarget | null {
  const [owner, repo, ...rest] = req.workspace.split('/')
  const match = /^pr:(\d+)$/.exec(req.chat)
  const prNumber = match === null ? null : parseDecimalId(match[1])
  if (!owner || !repo || rest.length > 0 || prNumber === null) return null
  return { owner, repo, prNumber }
}

function parseDecimalId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

async function fetchPull(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
): Promise<{ ok: true; headSha: string } | (SubmitReviewResult & { ok: false })> {
  const response = await githubFetch(fetchImpl, token, pullUrl(target))
  if (!response.ok) return responseError(response, 'GitHub pull request fetch')
  const body = await readJson<PullResponse>(response)
  if (typeof body?.head?.sha !== 'string' || body.head.sha === '') {
    return { ok: false, error: 'GitHub pull request response missing head.sha', code: 'transient' }
  }
  return { ok: true, headSha: body.head.sha }
}

async function fetchAnchors(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
): Promise<{ ok: true; anchors: Set<string> } | (SubmitReviewResult & { ok: false })> {
  const anchors = new Set<string>()
  let url: string | null = `${pullUrl(target)}/files?per_page=100`
  while (url !== null) {
    const response = await githubFetch(fetchImpl, token, url)
    if (!response.ok) return responseError(response, 'GitHub pull request files fetch')
    const body = await readJson<PullFilesResponse>(response)
    if (!Array.isArray(body)) {
      return { ok: false, error: 'GitHub pull request files response was not an array', code: 'transient' }
    }
    for (const file of body) {
      if (typeof file.filename === 'string' && typeof file.patch === 'string') {
        addPatchAnchors(anchors, file.filename, file.patch)
      }
    }
    url = nextLink(response.headers.get('link'))
  }
  return { ok: true, anchors }
}

function addPatchAnchors(anchors: Set<string>, path: string, patch: string): void {
  let left = 0
  let right = 0
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk !== null) {
      left = Number(hunk[1])
      right = Number(hunk[2])
      continue
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue
    if (raw.startsWith('+')) {
      anchors.add(anchorKey(path, right, 'RIGHT'))
      right += 1
    } else if (raw.startsWith('-')) {
      anchors.add(anchorKey(path, left, 'LEFT'))
      left += 1
    } else if (raw.startsWith(' ')) {
      anchors.add(anchorKey(path, right, 'RIGHT'))
      left += 1
      right += 1
    }
  }
}

function partitionComments(
  comments: readonly ReviewFinding[],
  anchors: ReadonlySet<string>,
): { inline: ReviewFinding[]; reanchored: ReviewFinding[] } {
  const inline: ReviewFinding[] = []
  const reanchored: ReviewFinding[] = []
  for (const comment of comments) {
    const side = comment.side ?? 'RIGHT'
    const lineOk = anchors.has(anchorKey(comment.path, comment.line, side))
    const startSide = comment.startSide ?? side
    const rangePaired = (comment.startLine === undefined) === (comment.startSide === undefined)
    const startOk =
      rangePaired &&
      (comment.startLine === undefined ||
        (startSide === side &&
          comment.startLine <= comment.line &&
          anchors.has(anchorKey(comment.path, comment.startLine, startSide))))
    ;(lineOk && startOk ? inline : reanchored).push(comment)
  }
  return { inline, reanchored }
}

function appendReanchored(body: string, reanchored: readonly ReviewFinding[]): string {
  if (reanchored.length === 0) return body
  const findings = reanchored
    .map((finding) => `- ${finding.path}:${finding.line} (${finding.side ?? 'RIGHT'}): ${finding.body}`)
    .join('\n')
  return `${body}\n\nOut-of-diff findings moved from inline comments:\n${findings}`
}

async function postReview(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
  review: { event: SubmitReviewRequest['event']; body: string; commitId: string; comments: ReviewFinding[] },
): Promise<{ ok: true; reviewId: number } | (SubmitReviewResult & { ok: false })> {
  const response = await githubFetch(fetchImpl, token, `${pullUrl(target)}/reviews`, {
    method: 'POST',
    body: JSON.stringify({
      event: review.event,
      body: review.body,
      commit_id: review.commitId,
      comments: review.comments.map(toGithubComment),
    }),
  })
  if (!response.ok) return responseError(response, 'GitHub review submit')
  const posted = await readJson<{ id?: unknown }>(response)
  if (typeof posted?.id !== 'number') {
    return { ok: false, error: 'GitHub review submit response missing review id', code: 'transient' }
  }
  return { ok: true, reviewId: posted.id }
}

function toGithubComment(comment: ReviewFinding): Record<string, unknown> {
  return {
    path: comment.path,
    line: comment.line,
    side: comment.side ?? 'RIGHT',
    body: comment.body,
    ...(comment.startLine !== undefined && comment.startSide !== undefined
      ? { start_line: comment.startLine, start_side: comment.startSide }
      : {}),
  }
}

async function verifyReview(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
  reviewId: number,
  event: SubmitReviewRequest['event'],
): Promise<{ ok: true; reviewId: number; state: string } | (SubmitReviewResult & { ok: false })> {
  const response = await githubFetch(fetchImpl, token, `${pullUrl(target)}/reviews/${reviewId}`)
  if (!response.ok) return responseError(response, 'GitHub review verify')
  const body = await readJson<{ id?: unknown; state?: unknown }>(response)
  const expectedState =
    event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED'
  if (body?.id !== reviewId || body.state !== expectedState) {
    return {
      ok: false,
      error: 'GitHub review verification response did not match the posted review',
      code: 'transient',
    }
  }
  return { ok: true, reviewId, state: expectedState }
}

async function githubFetch(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, headers: { ...githubJsonHeaders(token), ...headersRecord(init.headers) } })
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 599 })
  }
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T
  } catch (error) {
    void error
    return null
  }
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers
}

async function responseError(response: Response, label: string): Promise<SubmitReviewResult & { ok: false }> {
  const text = await response.text()
  return {
    ok: false,
    error: `${label} ${response.status}${text !== '' ? `: ${text}` : ''}`,
    code: response.status === 422 ? 'bad-anchor' : classifyStatus(response.status),
  }
}

function classifyStatus(status: number): SubmitReviewErrorCode {
  if (status === 401 || status === 403) return 'permission-denied'
  if (status === 404) return 'not-found'
  return 'transient'
}

function nextLink(header: string | null): string | null {
  if (header === null) return null
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (match !== null) return match[1] ?? null
  }
  return null
}

function pullUrl(target: ReviewTarget): string {
  return `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`
}

function anchorKey(path: string, line: number, side: 'LEFT' | 'RIGHT'): string {
  return `${path}\0${side}\0${line}`
}

type PullResponse = { head?: { sha?: unknown } }
type PullFilesResponse = Array<{ filename?: unknown; patch?: unknown }>
