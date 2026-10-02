import type {
  RemoveReactionCallback,
  ReactionCallback,
  ReactionErrorCode,
  ReactionRef,
  ReactionResult,
  PrepareOwnReactionCallback,
  RemoveOwnReactionCallback,
  RemoveOwnReactionResult,
} from '@/channels/types'

import { describeError } from '../../describe-error'
import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import {
  buildOutboundPermissionGuidance,
  type GithubAuthType,
  isOutboundPermissionDenial,
  type OutboundEndpointKind,
} from './permission-guidance'

// The reactable target, distinguished by the webhook event the inbound came
// from. The router collapses every github inbound to the same `chat`/
// `externalMessageId` pair, so this kind — known only at classification time —
// is what selects the right Reactions endpoint. `issue` covers both issue and
// PR bodies (GitHub models a PR body as an issue for reactions); `discussion`
// is unsupported until the GraphQL `addReaction` path lands, so the classifier
// does not stamp it today.
export type GithubReactionTarget =
  | { kind: 'issue'; owner: string; repo: string; issueNumber: number }
  | { kind: 'issue-comment'; owner: string; repo: string; commentId: number }
  | { kind: 'pr-review-comment'; owner: string; repo: string; commentId: number }

export type GithubReactionRemovalTarget =
  | { kind: 'issue'; owner: string; repo: string; issueNumber: number; reactionId: number }
  | { kind: 'issue-comment'; owner: string; repo: string; commentId: number; reactionId: number }
  | { kind: 'pr-review-comment'; owner: string; repo: string; commentId: number; reactionId: number }

export function encodeGithubReactionRef(target: GithubReactionTarget): ReactionRef {
  return { adapter: 'github', value: JSON.stringify(target) }
}

export function decodeGithubReactionRef(ref: ReactionRef): GithubReactionTarget | null {
  if (ref.adapter !== 'github') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(ref.value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const t = parsed as Record<string, unknown>
  if (t.op !== undefined) return null
  const owner = typeof t.owner === 'string' ? t.owner : null
  const repo = typeof t.repo === 'string' ? t.repo : null
  if (owner === null || repo === null) return null
  if (t.kind === 'issue' && typeof t.issueNumber === 'number') {
    return { kind: 'issue', owner, repo, issueNumber: t.issueNumber }
  }
  if ((t.kind === 'issue-comment' || t.kind === 'pr-review-comment') && typeof t.commentId === 'number') {
    return { kind: t.kind, owner, repo, commentId: t.commentId }
  }
  return null
}

export function encodeGithubRemovalRef(target: GithubReactionRemovalTarget): ReactionRef {
  return { adapter: 'github', value: JSON.stringify({ op: 'remove', ...target }) }
}

export function decodeGithubRemovalRef(ref: ReactionRef): GithubReactionRemovalTarget | null {
  if (ref.adapter !== 'github') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(ref.value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const t = parsed as Record<string, unknown>
  const owner = typeof t.owner === 'string' ? t.owner : null
  const repo = typeof t.repo === 'string' ? t.repo : null
  if (t.op !== 'remove' || owner === null || repo === null || typeof t.reactionId !== 'number') return null
  if (t.kind === 'issue' && typeof t.issueNumber === 'number') {
    return { kind: 'issue', owner, repo, issueNumber: t.issueNumber, reactionId: t.reactionId }
  }
  if ((t.kind === 'issue-comment' || t.kind === 'pr-review-comment') && typeof t.commentId === 'number') {
    return { kind: t.kind, owner, repo, commentId: t.commentId, reactionId: t.reactionId }
  }
  return null
}

// GitHub's Reactions API takes a fixed vocabulary of content strings. Map the
// adapter-generic emoji name onto it; anything outside the set is reported as
// `unsupported` so the model gets a clear signal rather than a silent 422.
const REACTION_CONTENT: Record<string, string> = {
  eyes: 'eyes',
  '+1': '+1',
  thumbsup: '+1',
  '-1': '-1',
  thumbsdown: '-1',
  laugh: 'laugh',
  hooray: 'hooray',
  tada: 'hooray',
  confused: 'confused',
  heart: 'heart',
  rocket: 'rocket',
}

export function createGithubReactionCallback(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  authType: GithubAuthType
  fetchImpl?: typeof fetch
}): ReactionCallback {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'github') return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    const content = REACTION_CONTENT[req.emoji.replace(/^:|:$/g, '')]
    if (content === undefined) {
      return { ok: false, error: `github does not support reaction "${req.emoji}"`, code: 'unsupported' }
    }
    const target = decodeGithubReactionRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable github reaction ref', code: 'unsupported' }

    const endpoint = reactionEndpoint(target)
    const endpointKind: OutboundEndpointKind =
      target.kind === 'pr-review-comment' ? 'pr-review-comment-reaction' : 'issue-reaction'
    return await postReaction(
      fetchImpl,
      await deps.token({ repoSlug: `${target.owner}/${target.repo}` }),
      endpoint,
      target,
      {
        content,
        authType: deps.authType,
        endpointKind,
      },
    )
  }
}

export function createGithubRemoveReactionCallback(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  authType: GithubAuthType
  fetchImpl?: typeof fetch
}): RemoveReactionCallback {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (req): Promise<ReactionResult> => {
    if (req.adapter !== 'github') return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    const target = decodeGithubRemovalRef(req.reactionRef)
    if (target === null) return { ok: false, error: 'unparseable github reaction removal ref', code: 'unsupported' }

    const endpoint = removeReactionEndpoint(target)
    const endpointKind: OutboundEndpointKind =
      target.kind === 'pr-review-comment' ? 'pr-review-comment-reaction' : 'issue-reaction'
    return await deleteReaction(fetchImpl, await deps.token({ repoSlug: `${target.owner}/${target.repo}` }), endpoint, {
      authType: deps.authType,
      endpointKind,
    })
  }
}

function reactionEndpoint(target: GithubReactionTarget): string {
  const base = `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}`
  switch (target.kind) {
    case 'issue':
      return `${base}/issues/${target.issueNumber}/reactions`
    case 'issue-comment':
      return `${base}/issues/comments/${target.commentId}/reactions`
    case 'pr-review-comment':
      return `${base}/pulls/comments/${target.commentId}/reactions`
  }
}

function removeReactionEndpoint(target: GithubReactionRemovalTarget): string {
  const base = `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}`
  switch (target.kind) {
    case 'issue':
      return `${base}/issues/${target.issueNumber}/reactions/${target.reactionId}`
    case 'issue-comment':
      return `${base}/issues/comments/${target.commentId}/reactions/${target.reactionId}`
    case 'pr-review-comment':
      return `${base}/pulls/comments/${target.commentId}/reactions/${target.reactionId}`
  }
}

async function postReaction(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  target: GithubReactionTarget,
  options: { content: string; authType: GithubAuthType; endpointKind: OutboundEndpointKind },
): Promise<ReactionResult> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: githubJsonHeaders(token),
      body: JSON.stringify({ content: options.content }),
    })
  } catch (err) {
    return { ok: false, error: describeError(err), code: 'transient' }
  }
  // 201 = reaction created, 200 = the actor already left this same reaction.
  // Both are success: an :eyes: that's already there is the desired end state,
  // so a duplicate webhook delivery (or a retried engage) must not surface an error.
  if (response.status === 200 || response.status === 201) {
    const reactionId = await readReactionId(response)
    if (reactionId === null) return { ok: true }
    return { ok: true, reactionRef: encodeGithubRemovalRef(removalTargetFor(target, reactionId)) }
  }
  const text = await response.text().catch(() => '')
  const baseError = `GitHub API ${response.status}${text !== '' ? `: ${text}` : ''}`
  if (isOutboundPermissionDenial(response.status, text)) {
    return {
      ok: false,
      error: `${baseError}${buildOutboundPermissionGuidance({ authType: options.authType, endpointKind: options.endpointKind })}`,
      code: 'permission-denied',
    }
  }
  return { ok: false, error: baseError, code: classifyStatus(response.status) }
}

async function deleteReaction(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  options: { authType: GithubAuthType; endpointKind: OutboundEndpointKind },
): Promise<ReactionResult> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'DELETE',
      headers: githubJsonHeaders(token),
    })
  } catch (err) {
    return { ok: false, error: describeError(err), code: 'transient' }
  }
  if (response.status === 204) return { ok: true }
  const text = await response.text().catch(() => '')
  const baseError = `GitHub API ${response.status}${text !== '' ? `: ${text}` : ''}`
  if (isOutboundPermissionDenial(response.status, text)) {
    return {
      ok: false,
      error: `${baseError}${buildOutboundPermissionGuidance({ authType: options.authType, endpointKind: options.endpointKind })}`,
      code: 'permission-denied',
    }
  }
  return { ok: false, error: baseError, code: classifyStatus(response.status) }
}

function removalTargetFor(target: GithubReactionTarget, reactionId: number): GithubReactionRemovalTarget {
  switch (target.kind) {
    case 'issue':
      return { kind: 'issue', owner: target.owner, repo: target.repo, issueNumber: target.issueNumber, reactionId }
    case 'issue-comment':
      return { kind: 'issue-comment', owner: target.owner, repo: target.repo, commentId: target.commentId, reactionId }
    case 'pr-review-comment':
      return {
        kind: 'pr-review-comment',
        owner: target.owner,
        repo: target.repo,
        commentId: target.commentId,
        reactionId,
      }
  }
}

async function readReactionId(response: Response): Promise<number | null> {
  const body = await response.json().catch(() => null)
  if (typeof body !== 'object' || body === null) return null
  const id = (body as Record<string, unknown>).id
  return typeof id === 'number' ? id : null
}

function classifyStatus(status: number): ReactionErrorCode {
  if (status === 403) return 'permission-denied'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limited'
  return 'transient'
}

export function createGithubOwnReactionCallbacks(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  getSelf: () => Promise<{ id: number }>
  authType: GithubAuthType
  fetchImpl?: typeof fetch
}): { prepare: PrepareOwnReactionCallback; remove: RemoveOwnReactionCallback } {
  const fetchImpl = deps.fetchImpl ?? fetch
  const prepare: PrepareOwnReactionCallback = async (req) => {
    const target = decodeGithubReactionRef(req.reactionRef)
    const emoji = REACTION_CONTENT[req.emoji.replace(/^:|:$/g, '')]
    if (req.adapter !== 'github' || target === null || emoji === undefined) return null
    const self = await deps.getSelf()
    if (!Number.isSafeInteger(self.id) || self.id <= 0) return null
    return { accountIdentity: String(self.id), target: encodeGithubReactionRef(target), emoji }
  }
  const remove: RemoveOwnReactionCallback = async (req) => {
    const target = decodeGithubReactionRef(req.target)
    const emoji = REACTION_CONTENT[req.emoji.replace(/^:|:$/g, '')]
    if (req.adapter !== 'github' || target === null || emoji === undefined)
      return { ok: false, code: 'unsupported', error: 'invalid GitHub reaction target or emoji' }
    try {
      const self = await deps.getSelf()
      if (!Number.isSafeInteger(self.id) || self.id <= 0 || String(self.id) !== req.expectedAccountIdentity)
        return { ok: false, code: 'identity', error: 'authenticated GitHub actor changed or unavailable' }
      const token = await deps.token({ repoSlug: `${target.owner}/${target.repo}` })
      const endpoint = reactionEndpoint(target)
      let next: string | null = `${endpoint}?per_page=100`
      const visited = new Set<string>()
      const ownIds = new Set<number>()
      // Finish enumeration before deleting: a failed later page must leave every reaction intact.
      while (next !== null) {
        if (visited.has(next)) return { ok: false, code: 'transient', error: 'cyclic GitHub reaction pagination' }
        visited.add(next)
        const response: Response = await fetchImpl(next, { headers: githubJsonHeaders(token) })
        if (response.status === 404)
          return { ok: false, code: 'permission', error: 'GitHub reaction target inaccessible' }
        if (!response.ok) return await ownReactionHttpError(response)
        const rows: unknown = await response.json()
        if (!Array.isArray(rows)) return { ok: false, code: 'transient', error: 'invalid GitHub reaction page' }
        for (const row of rows) {
          if (typeof row !== 'object' || row === null)
            return { ok: false, code: 'transient', error: 'invalid GitHub reaction row' }
          const reaction = row as { id?: unknown; content?: unknown; user?: { id?: unknown } | null }
          if (reaction.content === emoji && reaction.user?.id === self.id) {
            if (typeof reaction.id !== 'number' || !Number.isSafeInteger(reaction.id) || reaction.id <= 0)
              return { ok: false, code: 'transient', error: 'invalid GitHub reaction id' }
            ownIds.add(reaction.id)
          }
        }
        const link: string | null = response.headers.get('link')
        const match: RegExpMatchArray | null | undefined = link
          ?.split(',')
          .map((part) => part.trim())
          .find((part) => /;\s*rel="next"/.test(part))
          ?.match(/^<([^>]+)>/)
        next = match?.[1] ?? null
        if (next !== null) {
          const url = new URL(next)
          if (url.origin !== new URL(GITHUB_API_BASE).origin || url.pathname !== new URL(endpoint).pathname)
            return { ok: false, code: 'transient', error: 'invalid GitHub reaction pagination destination' }
        }
      }
      for (const id of ownIds) {
        const response = await fetchImpl(`${endpoint}/${id}`, { method: 'DELETE', headers: githubJsonHeaders(token) })
        if (response.status !== 204 && response.status !== 404) return await ownReactionHttpError(response)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, code: 'transient', error: describeError(error) }
    }
  }
  return { prepare, remove }
}

async function ownReactionHttpError(response: Response): Promise<RemoveOwnReactionResult> {
  const text = await response.text().catch(() => '')
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after') ||
        /rate limit/i.test(text)))
  const retry = Number(response.headers.get('retry-after'))
  return {
    ok: false,
    code: rateLimited
      ? 'rate-limit'
      : response.status === 401 || response.status === 403 || response.status === 404
        ? 'permission'
        : 'transient',
    error: `GitHub API ${response.status}: ${text}`,
    ...(rateLimited && response.headers.has('retry-after') && Number.isFinite(retry) && retry >= 0
      ? { retryAfter: retry * 1000 }
      : {}),
  }
}
