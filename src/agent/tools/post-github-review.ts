import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import {
  recordReview,
  recordReviewOutput,
  type ReviewResultCoverage,
  type ReviewVerdict,
} from '@/channels/github-review-turn-ledger'
import { createSharedReviewVerdictGuard, type ReviewVerdictGuard } from '@/channels/github-review-verdict-coordinator'
import type { ChannelRouter } from '@/channels/router'
import type { ReviewFinding, SubmitReviewRequest } from '@/channels/types'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { type ChannelReplyOrigin, TOOL_RESULT_PREFIX } from './channel-reply'
import { fenceToolResult } from './runtime-notice'

type PostGithubReviewDetails = {
  ok: boolean
  error?: string
  code?: string
  fallback?: 'comment'
  messageId?: string
  messageIds?: readonly string[]
  reviewId?: number
  state?: string
  downgraded?: boolean
  reanchored?: ReviewFinding[]
}

export function createPostGithubReviewTool(options: {
  router: ChannelRouter
  origin: ChannelReplyOrigin
  sessionId: string
  logger?: ChannelToolLogger
  verdictGuard?: ReviewVerdictGuard
}) {
  const { router, origin, sessionId, logger = consoleChannelLogger } = options
  const verdictGuard = options.verdictGuard ?? createSharedReviewVerdictGuard()
  return defineTool({
    name: 'post_github_review',
    label: 'Post GitHub PR Review',
    description:
      'GitHub channel sessions only. Submit a formal PR review. The adapter resolves the head SHA, validates diff anchors, moves out-of-diff findings into the body, enforces approval policy, and verifies the posted review.',
    parameters: Type.Object({
      event: Type.Union([Type.Literal('APPROVE'), Type.Literal('REQUEST_CHANGES'), Type.Literal('COMMENT')]),
      body: Type.String({ minLength: 1 }),
      comments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ minLength: 1 }),
            line: Type.Integer({ minimum: 1 }),
            side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
            start_line: Type.Optional(Type.Integer({ minimum: 1 })),
            start_side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
            body: Type.String({ minLength: 1 }),
          }),
          { minItems: 1 },
        ),
      ),
      head_sha: Type.Optional(
        Type.String({
          pattern: '^[0-9a-fA-F]{40}$',
          description:
            'Full SHA of the commit your review covers. When set, the review is only posted if the PR head is still this commit.',
        }),
      ),
    }),
    async execute(toolCallId, params) {
      if (origin.adapter !== 'github') return denied(logger, 'post_github_review is only supported on github sessions.')
      const prNumber = parsePrNumber(origin.chat)
      if (prNumber === null) return denied(logger, `invalid GitHub review target: ${origin.chat}`)
      const verdict = decisiveVerdict(params.event)
      const coordinationCallId = `${sessionId}:${toolCallId}`
      if (verdict !== null) {
        const blocked = await verdictGuard.guard({
          callId: coordinationCallId,
          workspace: origin.workspace,
          prNumber,
          verdict,
          ...(origin.githubReviewRound !== undefined ? { round: origin.githubReviewRound } : {}),
          thread: origin.thread,
          ...(params.head_sha !== undefined ? { reviewedHeadSha: params.head_sha } : {}),
          retainDuplicateLease: params.event === 'REQUEST_CHANGES',
        })
        if (blocked !== null) {
          if (
            params.event === 'REQUEST_CHANGES' &&
            blocked.kind === 'duplicate' &&
            blocked.duplicateSource === 'standing'
          ) {
            let fallbackLanded = false
            try {
              const fallback = await postDuplicateRequestChangesComment({
                router,
                origin,
                sessionId,
                prNumber,
                body: params.body,
                comments: (params.comments ?? []).map(toReviewFinding),
                logger,
              })
              fallbackLanded = fallback.landed
              return fallback.result
            } finally {
              // The retained lease only serializes OVERLAPPING siblings. Recording the
              // landing is what stops the sequential ones: sibling thread sessions of
              // the same PR finish minutes apart, and without this each would see the
              // same `standing` block and publish its own copy of the review.
              if (blocked.leaseRetained === true) {
                await verdictGuard.release({
                  callId: coordinationCallId,
                  outcome: fallbackLanded ? 'fallback-landed' : 'failed',
                })
              }
            }
          }
          return denied(logger, blocked.reason)
        }
      }
      const request: SubmitReviewRequest = {
        adapter: 'github',
        workspace: origin.workspace,
        chat: origin.chat,
        event: params.event,
        body: params.body,
        comments: (params.comments ?? []).map(toReviewFinding),
        ...(params.head_sha !== undefined ? { expectedHeadSha: params.head_sha } : {}),
      }
      let releaseAsLanded = false
      try {
        const coverage = await captureCoverage(router, sessionId)
        const result = await router.submitReview({
          ...request,
          sourceSessionId: sessionId,
          ...(coverage.expectedAccountIdentity !== undefined
            ? { expectedAccountIdentity: coverage.expectedAccountIdentity }
            : {}),
        })
        if (!result.ok) {
          // A POST whose verification failed may already have landed. Keep the
          // short conservative shield, but never credit an unverified ledger.
          releaseAsLanded = verdict !== null && result.submitted === true
          return denied(logger, result.error, result.code)
        }

        const effective = effectiveReviewState(result.state)
        if (effective === null)
          return denied(logger, `GitHub returned an unknown verified review state: ${result.state}`)
        releaseAsLanded = verdict !== null && effective === verdict
        await creditVerifiedReview({
          sessionId,
          workspace: origin.workspace,
          prNumber,
          effective,
          ...coverage,
          ...(result.commitSha !== undefined ? { commitSha: result.commitSha } : {}),
        })

        const receipt = renderReceipt(
          result.reviewId,
          result.state,
          result.downgraded === true,
          result.reanchored ?? [],
        )
        const details: PostGithubReviewDetails = {
          ok: true,
          reviewId: result.reviewId,
          state: result.state,
          ...(result.downgraded === true ? { downgraded: true } : {}),
          ...(result.reanchored !== undefined ? { reanchored: result.reanchored } : {}),
        }
        return { content: [{ type: 'text' as const, text: fenceToolResult(receipt) }], details }
      } finally {
        if (verdict !== null) {
          await verdictGuard.release({
            callId: coordinationCallId,
            outcome: releaseAsLanded ? 'formal-landed' : 'failed',
          })
        }
      }
    },
  })
}

async function postDuplicateRequestChangesComment(args: {
  router: ChannelRouter
  origin: ChannelReplyOrigin
  sessionId: string
  prNumber: number
  body: string
  comments: readonly ReviewFinding[]
  logger: ChannelToolLogger
}) {
  const coverage = await captureCoverage(args.router, args.sessionId)
  const result = await args.router.send(
    {
      adapter: 'github',
      workspace: args.origin.workspace,
      chat: args.origin.chat,
      thread: null,
      text: renderFallbackComment(args.body, args.comments),
    },
    {
      accountingTarget: args.origin,
      ...(coverage.expectedAccountIdentity !== undefined
        ? { expectedAccountIdentity: coverage.expectedAccountIdentity }
        : {}),
    },
  )
  if (!result.ok) return { landed: false, result: denied(args.logger, result.error, result.code) }

  await recordReviewOutput({
    sessionId: args.sessionId,
    workspace: args.origin.workspace,
    prNumber: args.prNumber,
    state: 'COMMENT',
    ...coverage,
  })

  const details: PostGithubReviewDetails = {
    ok: true,
    fallback: 'comment',
    ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
    ...(result.messageIds !== undefined ? { messageIds: result.messageIds } : {}),
  }
  return {
    landed: true,
    result: {
      content: [
        {
          type: 'text' as const,
          text: fenceToolResult(
            'GitHub PR comment posted because the existing CHANGES_REQUESTED review is still active.',
          ),
        },
      ],
      details,
    },
  }
}

function renderFallbackComment(body: string, comments: readonly ReviewFinding[]): string {
  if (comments.length === 0) return body
  return [
    body,
    '',
    '---',
    '',
    ...comments.flatMap((comment) => [`**${markdownCodeSpan(renderLocation(comment))}**`, '', comment.body, '']),
  ]
    .slice(0, -1)
    .join('\n')
}

function renderLocation(comment: ReviewFinding): string {
  const lines = comment.startLine !== undefined ? `${comment.startLine}-${comment.line}` : String(comment.line)
  const side = comment.side === 'LEFT' ? ' (old revision)' : ''
  return `${comment.path.replace(/[\r\n]+/g, ' ')}:${lines}${side}`
}

function markdownCodeSpan(value: string): string {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length))
  const delimiter = '`'.repeat(longestRun + 1)
  const padded = value.startsWith('`') || value.endsWith('`') ? ` ${value} ` : value
  return `${delimiter}${padded}${delimiter}`
}

function parsePrNumber(chat: string): number | null {
  const match = /^pr:(\d+)$/.exec(chat)
  if (match?.[1] === undefined) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function decisiveVerdict(event: SubmitReviewRequest['event']): ReviewVerdict | null {
  return event === 'APPROVE' || event === 'REQUEST_CHANGES' ? event : null
}

function effectiveReviewState(state: string): ReviewVerdict | 'COMMENT' | null {
  if (state === 'APPROVED') return 'APPROVE'
  if (state === 'CHANGES_REQUESTED') return 'REQUEST_CHANGES'
  if (state === 'COMMENTED') return 'COMMENT'
  return null
}

async function creditVerifiedReview(
  args: {
    sessionId: string
    workspace: string
    prNumber: number
    effective: ReviewVerdict | 'COMMENT'
    commitSha?: string
  } & ReviewResultCoverage,
): Promise<void> {
  if (args.effective === 'COMMENT') {
    await recordReviewOutput({
      sessionId: args.sessionId,
      workspace: args.workspace,
      prNumber: args.prNumber,
      state: 'COMMENT',
      ...(args.inboundCoverage !== undefined ? { inboundCoverage: args.inboundCoverage } : {}),
      ...(args.backgroundCoverage !== undefined ? { backgroundCoverage: args.backgroundCoverage } : {}),
    })
    return
  }
  // recordReview retains the verdict before awaiting the output owner's settlement.
  await recordReview({
    sessionId: args.sessionId,
    workspace: args.workspace,
    prNumber: args.prNumber,
    verdict: args.effective,
    ...(args.inboundCoverage !== undefined ? { inboundCoverage: args.inboundCoverage } : {}),
    ...(args.backgroundCoverage !== undefined ? { backgroundCoverage: args.backgroundCoverage } : {}),
    ...(args.commitSha !== undefined ? { commitSha: args.commitSha } : {}),
  })
}

async function captureCoverage(router: ChannelRouter, sessionId: string): Promise<ReviewResultCoverage> {
  const expectedAccountIdentity = await router.captureTurnAccountIdentity?.(sessionId, 'github')
  return {
    inboundCoverage: (await router.captureInboundResultCoverage?.(sessionId)) ?? [],
    backgroundCoverage: (await router.captureBackgroundResultCoverage?.(sessionId)) ?? [],
    ...(expectedAccountIdentity !== undefined ? { expectedAccountIdentity } : {}),
  }
}

function denied(logger: ChannelToolLogger, error: string, code?: string) {
  logger.warn(formatChannelToolFailure('post_github_review', error))
  const details: PostGithubReviewDetails = { ok: false, error, ...(code !== undefined ? { code } : {}) }
  return {
    content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}post_github_review denied: ${error}` }],
    details,
  }
}

function toReviewFinding(comment: {
  path: string
  line: number
  side?: 'LEFT' | 'RIGHT'
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
  body: string
}): ReviewFinding {
  return {
    path: comment.path,
    line: comment.line,
    ...(comment.side !== undefined ? { side: comment.side } : {}),
    ...(comment.start_line !== undefined ? { startLine: comment.start_line } : {}),
    ...(comment.start_side !== undefined ? { startSide: comment.start_side } : {}),
    body: comment.body,
  }
}

function renderReceipt(
  reviewId: number,
  state: string,
  downgraded: boolean,
  reanchored: readonly ReviewFinding[],
): string {
  const notes = [
    downgraded ? 'APPROVE was downgraded to COMMENT by operator policy.' : null,
    reanchored.length > 0
      ? `${reanchored.length} out-of-diff finding(s) moved into the review body: ${reanchored.map((finding) => `${finding.path}:${finding.line}`).join(', ')}.`
      : null,
  ].filter((note): note is string => note !== null)
  return [`GitHub review posted: id=${reviewId}, state=${state}.`, ...notes].join('\n')
}
