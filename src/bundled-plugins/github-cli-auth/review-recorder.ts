import { readFile } from 'node:fs/promises'

import {
  captureReviewResultCoverage,
  recordReview,
  recordReviewOutput,
  type ReviewResultCoverage,
} from '@/channels/github-review-turn-ledger'
import type { ContentPart, ToolResult } from '@/plugin'

import {
  detectReviewOutput,
  detectReviewSubmission,
  detectReviewSubmissionAttempt,
  type DetectedReview,
  type DetectedReviewOutput,
  type ReviewSubmissionAttempt,
} from './gh-review-detect'
import { detectReviewDump, type ReviewDumpDecision } from './gh-review-inline-detect'

// Bridges the bash `gh` interceptor to the false-receipt ledger: at tool.before
// we detect a review-submission command (resolving its --input file), stash it by
// callId, and at tool.after we credit the ledger ONLY if the command actually
// succeeded. Strict success detection is the safe bias here — wrongly crediting a
// review that never landed would re-open the false-receipt hole, so an ambiguous
// result is treated as "not landed" and left uncredited.
//
// A post-execution BACKSTOP runs when pre-detection produced no pending entry: the
// REST create-review response is authoritative (it echoes the landed review's
// `state` and the PR url), so we can credit a verdict whose command shape dodged
// the before-detector. This only arms the dedupe window for the NEXT submission —
// it cannot un-land a duplicate already posted — but that is precisely what the
// sequential fan-out incident needed: the first landed APPROVE must arm the shield.
// The backstop is gated on a tool.before submission-ATTEMPT marker so it never
// fires for a reviews-list READ whose response happens to carry a decisive state.

const pending = new Map<string, DetectedReview>()
const submissionAttempts = new Map<string, ReviewSubmissionAttempt>()
// COMMENT-only submissions, stashed apart from `pending`: a decisive verdict is
// credited to the false-receipt ledger via recordReview (which also fans to the
// output observer), so only non-verdict COMMENTs need their own output credit.
const pendingCommentOutput = new Map<string, DetectedReviewOutput>()
const pendingCoverage = new Map<string, ReviewResultCoverage>()

export function discardReviewCommand(callId: string): void {
  pending.delete(callId)
  pendingCommentOutput.delete(callId)
  submissionAttempts.delete(callId)
  pendingCoverage.delete(callId)
}

const MAX_INPUT_BYTES = 1_000_000

export type NoteReviewResult = {
  dump: ReviewDumpDecision
  detected: DetectedReview | null
}

export async function noteReviewCommand(args: {
  callId: string
  command: string
  sessionId?: string
}): Promise<NoteReviewResult> {
  discardReviewCommand(args.callId)
  const inputFileContents = await readInputFile(args.command)
  const detected = detectReviewSubmission({ command: args.command, inputFileContents })
  if (detected !== null) pending.set(args.callId, detected)
  // Record submission INTENT even when the verdict could not be extracted (a
  // missed shape): only such a command may later arm the backstop, so a reviews
  // READ — which is not an attempt — can never be miscredited as a landed review.
  else {
    // A COMMENT review carries no verdict, so it dodges `pending` above — stash it
    // here so a successful COMMENT still credits review OUTPUT (not the verdict
    // ledger) and suppresses the router's empty-turn fallback. It is stashed
    // INSTEAD of a submission attempt: the backstop only ever credits a decisive
    // verdict, so arming it for a COMMENT would just leave a stale attempt entry
    // that `commitReviewIfSucceeded`'s COMMENT branch returns before clearing.
    const output = detectReviewOutput({ command: args.command, inputFileContents })
    if (output !== null && output.state === 'COMMENT') {
      pendingCommentOutput.set(args.callId, output)
    } else {
      const attempt = detectReviewSubmissionAttempt(args.command)
      if (attempt !== null) submissionAttempts.set(args.callId, attempt)
    }
  }
  if (pending.has(args.callId) || pendingCommentOutput.has(args.callId) || submissionAttempts.has(args.callId)) {
    try {
      pendingCoverage.set(
        args.callId,
        args.sessionId === undefined ? {} : await captureReviewResultCoverage(args.sessionId),
      )
    } catch (error) {
      discardReviewCommand(args.callId)
      throw error
    }
  }
  return { dump: detectReviewDump({ command: args.command, inputFileContents }), detected }
}

export type CommitReviewResult = {
  // Whether a verdict was credited this turn (drives verdictGuard.release()).
  committed: boolean
  // Set ONLY on the backstop path (pre-detection missed): the caller must arm the
  // idempotency lag shield with this, since no guard() reservation exists to do it
  // via release(). Null on the pending path, where release() arms the shield.
  landedFromResult: DetectedReview | null
}

export function dismissalMutationSucceeded(result: ToolResult): boolean {
  const text = collectText(result.content)
  return !FAILURE_MARKERS.some((marker) => text.includes(marker)) && /"state"\s*:\s*"DISMISSED"/.test(text)
}

export async function commitReviewIfSucceeded(args: {
  sessionId: string
  callId: string
  result: ToolResult
}): Promise<CommitReviewResult> {
  const text = collectText(args.result.content)
  const coverage = pendingCoverage.get(args.callId) ?? {}
  pendingCoverage.delete(args.callId)
  const detected = pending.get(args.callId)
  if (detected !== undefined) {
    pending.delete(args.callId)
    if (!looksSucceeded(detected, text)) return { committed: false, landedFromResult: null }
    await recordReview({
      sessionId: args.sessionId,
      workspace: detected.workspace,
      prNumber: detected.prNumber,
      verdict: detected.verdict,
      ...coverage,
    })
    return { committed: true, landedFromResult: null }
  }

  // A COMMENT review credits review OUTPUT only (never the verdict ledger). Same
  // fail-closed success bias as verdicts: an ambiguous result stays uncredited.
  const comment = pendingCommentOutput.get(args.callId)
  if (comment !== undefined) {
    pendingCommentOutput.delete(args.callId)
    if (commentReviewSucceeded(text)) {
      await recordReviewOutput({
        sessionId: args.sessionId,
        workspace: comment.workspace,
        prNumber: comment.prNumber,
        state: 'COMMENT',
        ...coverage,
      })
    }
    return { committed: false, landedFromResult: null }
  }

  // The backstop runs ONLY for a command that tool.before saw as a real
  // submission attempt (POST create-review) but whose verdict it could not
  // extract. This excludes a reviews-list READ outright, and the PR-match below
  // rejects a stray pulls URL for a different PR in the output.
  const attempt = submissionAttempts.get(args.callId)
  if (attempt === undefined) return { committed: false, landedFromResult: null }
  submissionAttempts.delete(args.callId)

  const landed = detectLandedReviewFromResult(text)
  if (landed === null) return { committed: false, landedFromResult: null }
  if (landed.workspace !== attempt.workspace || landed.prNumber !== attempt.prNumber) {
    return { committed: false, landedFromResult: null }
  }
  await recordReview({
    sessionId: args.sessionId,
    workspace: landed.workspace,
    prNumber: landed.prNumber,
    verdict: landed.verdict,
    ...coverage,
  })
  return { committed: true, landedFromResult: landed }
}

// Authoritative post-execution credit from a REST create-review response, used
// only when pre-detection missed (no pending entry). Requires ALL of: a decisive
// landed `state`, a recoverable PR identity from the echoed `pull_request_url`,
// and no failure marker — so a partial/garbled capture or an unrelated success
// line cannot fabricate a verdict. COMMENT and DISMISSED are not decisive and are
// ignored, matching the before-detector's scope.
function detectLandedReviewFromResult(text: string): DetectedReview | null {
  if (FAILURE_MARKERS.some((m) => text.includes(m))) return null
  const verdict = landedVerdictFromState(text)
  if (verdict === null) return null
  const pr = prFromPullRequestUrl(text)
  if (pr === null) return null
  return { workspace: pr.workspace, prNumber: pr.prNumber, verdict, source: 'api' }
}

// The create-review response echoes `"state": "APPROVED" | "CHANGES_REQUESTED"`.
// Tolerant of the spacing both `gh api` (compact) and a piped `jq .` (pretty)
// produce.
function landedVerdictFromState(text: string): DetectedReview['verdict'] | null {
  if (/"state"\s*:\s*"APPROVED"/.test(text)) return 'APPROVE'
  if (/"state"\s*:\s*"CHANGES_REQUESTED"/.test(text)) return 'REQUEST_CHANGES'
  return null
}

// The review object carries `"pull_request_url":
// "https://api.github.com/repos/<owner>/<repo>/pulls/<n>"`, the authoritative PR
// identity for the landed review. Recovered here so a shape-dodging command is
// still credited to the right PR.
function prFromPullRequestUrl(text: string): { workspace: string; prNumber: number } | null {
  const m = /\/repos\/([^/\s"]+)\/([^/\s"]+)\/pulls\/(\d+)\b/.exec(text)
  if (m === null) return null
  const prNumber = Number(m[3])
  if (!Number.isSafeInteger(prNumber)) return null
  return { workspace: `${m[1]}/${m[2]}`, prNumber }
}

async function readInputFile(command: string): Promise<string | null> {
  const path = inputFilePath(command)
  if (path === null) return null
  try {
    const buf = await readFile(path)
    if (buf.byteLength > MAX_INPUT_BYTES) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

function inputFilePath(command: string): string | null {
  const m = /(?:^|\s)--input(?:=|\s+)(\S+)/.exec(command)
  if (m === null) return null
  const raw = m[1] as string
  if (raw === '-') return null
  return stripQuotes(raw)
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1)
  }
  return value
}

// Success markers are vector-specific. The REST endpoints echo the created
// review JSON; the `gh pr review` porcelain prints a plain confirmation line
// ("✓ Approved pull request OWNER/REPO#N" / "+ Requested changes to pull
// request …", from cli/cli pkg/cmd/pr/review). Matching REST JSON markers
// against porcelain output left every `gh pr review --approve` uncredited, so a
// later "Approved" reply in the same turn was wrongly blocked.
const API_SUCCESS_MARKERS = [
  '"node_id":"PRR_',
  '"state":"APPROVED"',
  '"state":"CHANGES_REQUESTED"',
  '"state": "APPROVED"',
]
const PR_REVIEW_SUCCESS_MARKERS = ['Approved pull request', 'Requested changes to pull request']
// COMMENT vectors: REST echoes `"state":"COMMENTED"`; the `gh pr review --comment`
// porcelain prints "Reviewed pull request …". Covers both spacings of the JSON.
const COMMENT_SUCCESS_MARKERS = ['"state":"COMMENTED"', '"state": "COMMENTED"', 'Reviewed pull request']
const FAILURE_MARKERS = ['gh: ', 'HTTP 4', 'HTTP 5', 'Bad credentials', 'Not Found', 'Validation Failed']

function commentReviewSucceeded(text: string): boolean {
  if (FAILURE_MARKERS.some((m) => text.includes(m))) return false
  return COMMENT_SUCCESS_MARKERS.some((m) => text.includes(m))
}

// Require a success marker AND no failure marker, so a partial/garbled capture
// fails closed (uncredited).
function looksSucceeded(detected: DetectedReview, text: string): boolean {
  if (FAILURE_MARKERS.some((m) => text.includes(m))) return false
  const markers = detected.source === 'pr-review' ? PR_REVIEW_SUCCESS_MARKERS : API_SUCCESS_MARKERS
  return markers.some((m) => text.includes(m))
}

function collectText(content: readonly ContentPart[]): string {
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}
