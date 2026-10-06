import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import { registerOrJoinReplyReviewRound } from '@/channels/github-review-verdict-coordinator'
import type { GithubReviewOn } from '@/channels/schema'
import type {
  GithubReviewFollowupRound,
  GithubReviewThreadCloseout,
  InboundMessage,
  RouteReceipt,
} from '@/channels/types'

import { describeError } from '../../describe-error'
import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import { removeRequestedReviewer } from './decoy-reviewer'
import { createBoundedMap, type BoundedMap, type DeliveryDedup } from './dedup'
import { isGithubEventAllowed } from './event-allowlist'
import { encodeGithubReactionRef, type GithubReactionTarget } from './reactions'
import { fetchSelfReviewBlocking } from './review-state'
import { invalidateGithubReviewSubmission } from './review-submitter'
import { listUnresolvedSelfReviewThreads, type UnresolvedSelfReviewThread } from './review-thread-resolver'

export type GithubInboundLogger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export type GithubWebhookHandlerOptions = {
  webhookSecret: string
  dedup: DeliveryDedup
  allowlist: () => readonly string[]
  selfId: () => string | null
  selfLogin: () => string | null
  // Defaults to 'pat' when omitted. In 'app' mode classifyReviewRequest also
  // matches the App's decoy reviewer login; see resolveDecoyReviewerLogin.
  authType?: () => 'pat' | 'app'
  // Defaults to true when omitted. When it returns false, every inbound carries
  // an appended operator-policy note telling the agent not to submit an APPROVE
  // review; the github skill keys off that note to downgrade approve→COMMENT.
  allowApprove?: () => boolean
  // Which pull_request action triggers an agent code review. Defaults to
  // 'review_requested' when omitted, preserving the request-driven behavior.
  // 'opened' additionally wakes the bot to review every PR the moment it opens;
  // 'off' suppresses the dedicated review-trigger synthesis entirely (an
  // explicit review_requested no longer wakes a session). Orthogonal to the
  // eventAllowlist (the outer "process this webhook?" gate) — this is the inner
  // "does an admitted pull_request event become a review-trigger inbound?" gate.
  reviewOn?: () => GithubReviewOn
  route: (message: InboundMessage) => Promise<RouteReceipt>
  logger: GithubInboundLogger
  // Optional: resolves whether the bot is a member of the given team. When
  // omitted, team-reviewer requests are silently dropped (the v1 fallback
  // behavior). The adapter wires this in production; tests inject a fake.
  isBotInTeam?: (input: { org: string; slug: string; login: string }) => Promise<boolean>
  // App-auth only: mints a repo-scoped token used to drop the decoy reviewer
  // once the bot's own review lands. Omitted under PAT auth (no decoy exists).
  authToken?: (context?: GithubAuthContext) => Promise<string>
  // Schedules the decoy-drop off the webhook ACK path so the 200 stays fast.
  // Defaults to fire-and-forget; tests inject a recorder to await the task.
  scheduleBackgroundTask?: (task: () => Promise<void>) => void
  sleepImpl?: (ms: number) => Promise<void>
  fetchImpl?: typeof fetch
  generateReviewRoundId?: () => string
  now?: () => number
  abortGithubPrTurn?: (
    workspace: string,
    prNumber: number,
    reason: string,
  ) => Promise<
    | { kind: 'aborted'; matchedSessions: number; matchedReviewers: number; abortFailures: number }
    | { kind: 'no-live-session' }
  >
  clearReconcileCooldown?: (workspace: string, prId: number) => Promise<'cleared' | 'not-initialized'>
}

export const GITHUB_REVIEW_STATE_UNKNOWN_TTL_MS = 2 * 60_000

type ReplyReviewRoundResolution =
  | { kind: 'round'; round: GithubReviewFollowupRound }
  | { kind: 'clear' }
  | { kind: 'unknown'; expiresAt: number }

export function createGithubWebhookHandler(options: GithubWebhookHandlerOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const body = await req.text()
    const signature = req.headers.get('x-hub-signature-256') ?? ''
    if (!(await verifySignature(body, options.webhookSecret, signature))) {
      options.logger.warn('[github] webhook rejected: bad signature')
      return new Response('bad signature', { status: 401 })
    }

    const delivery = req.headers.get('x-github-delivery') ?? ''
    const event = req.headers.get('x-github-event') ?? ''
    const payload = parseJson(body)
    if (payload === null) return ok()
    // The HTTP request is only transport; event handling is the shared core.
    await processVerifiedGithubDelivery(options, { event, delivery, payload })
    return ok()
  }
}

// Post-verification core shared by the live HTTP handler AND the missed-delivery
// recovery sweep (recover-failed-deliveries.ts), which pulls lost payloads from
// GitHub's authenticated deliveries API and re-injects them with no HTTP request
// or signature. Routing both through this one function is the load-bearing
// invariant: recovery must never become a second, divergent event pipeline.
// `delivery` is the `X-GitHub-Delivery` GUID (stable across redeliveries, equal
// to a delivery's `guid`) used as the dedup key, so a recovered event and its
// later/duplicate live delivery collapse to one route. HMAC is the caller's job:
// the live handler verifies the body; the sweep trusts the authenticated API.
export async function processVerifiedGithubDelivery(
  options: GithubWebhookHandlerOptions,
  input: { event: string; delivery: string; payload: Record<string, unknown>; recovered?: true },
): Promise<void> {
  const { event, delivery, payload } = input
  const action = readString(payload, 'action')
  const eventAllowed = isGithubEventAllowed(options.allowlist(), event, action)
  let staleRecoveredDraft = false
  if (input.recovered === true && eventAllowed && event === 'pull_request' && action === 'converted_to_draft') {
    const repository = readRepository(payload)
    const prNumber = readNumber(readRecord(payload.pull_request), 'number')
    if (repository !== null && prNumber !== null) {
      staleRecoveredDraft = !(await recoveredPullRequestIsStillDraft(
        options,
        repository,
        prNumber,
        `${repository.owner}/${repository.name}`,
      ))
    }
  }
  const isSynchronize = event === 'pull_request' && action === 'synchronize'
  if (!isSynchronize && delivery !== '') {
    if (options.dedup.has(delivery)) {
      options.logger.info(`[github] duplicate delivery ignored id=${delivery}`)
      return
    }
    // Reserve the delivery id synchronously before routing awaits so a live
    // webhook and the recovery sweep can never both route the same event. A
    // recovered draft's retryable freshness read is the sole earlier await; a
    // concurrent live delivery reserves here first and wins this dedup check.
    // Synchronize uses its own synchronous,
    // releasable head-SHA reservation so a failed redelivery can retry. JS is
    // single-threaded: nothing else runs between this has-check and add, so the
    // reservation is atomic. The awaits and classify that follow are all
    // throw-safe, so reserving early cannot strand a routable event.
    options.dedup.add(delivery)
  }

  if (!eventAllowed || staleRecoveredDraft) return

  // This control event must run before the self-author drop: a maintainer can
  // draft the bot's PR, and the bot can draft its own PR. Either action must
  // still stop review work instead of silently leaving the reviewer running.
  if (event === 'pull_request' && action === 'converted_to_draft') {
    const repository = readRepository(payload)
    const pr = readRecord(payload.pull_request)
    const prNumber = readNumber(pr, 'number')
    if (repository === null || prNumber === null) {
      options.logger.warn('[github] draft abort skipped: delivery missing repository or pull request number')
      return
    }
    const workspace = `${repository.owner}/${repository.name}`
    invalidateGithubReviewSubmission(workspace, prNumber)
    scheduleDraftAbort({ workspace, prNumber, prId: readNumber(pr, 'id'), options })
    return
  }

  const selfId = options.selfId()
  const selfLogin = options.selfLogin()
  const author = readAuthor(event, payload)
  if (author !== null && isSelfAuthor(author, selfId, selfLogin)) {
    maybeScheduleDecoyReviewerDrop({ event, action, payload, selfLogin, options })
    options.logger.info(
      `[github] dropped self-authored ${event}${action !== null ? `.${action}` : ''} from @${author.login}`,
    )
    return
  }

  // A push to an open PR (`synchronize`) is not a message to react to — it is
  // a trigger to re-evaluate the bot's own outstanding review obligations on
  // this PR: unresolved review threads it authored AND a sticky
  // CHANGES_REQUESTED block (which leaves no threads when filed as a top-level
  // verdict — the black hole this path closes). Both need an API round-trip,
  // so it runs OFF the ACK path (like the decoy-reviewer drop) and only wakes a
  // session when an obligation is outstanding. Returning here also keeps
  // synchronize out of the generic awareness-only fallthrough below.
  if (isSynchronize) {
    scheduleReviewFollowup({ payload, selfId, selfLogin, options })
    return
  }

  const teamIsBotMember = await resolveTeamMembership(event, payload, options)
  const reviewCommentParent = await resolveReviewCommentParent(event, payload, selfId, selfLogin, options)
  const replyReviewRound = await resolveReplyReviewRound(event, payload, selfLogin, reviewCommentParent, options)
  const classified = classifyGithubInbound(event, payload, selfLogin, {
    teamIsBotMember,
    authType: options.authType?.() ?? 'pat',
    reviewOn: options.reviewOn?.() ?? 'review_requested',
    ...(reviewCommentParent !== null ? { reviewCommentParent } : {}),
  })
  if (classified === null) return

  const routed =
    replyReviewRound?.kind === 'round'
      ? { ...classified, githubReviewRound: replyReviewRound.round }
      : replyReviewRound?.kind === 'unknown' && classified.githubReviewThreadCloseout !== undefined
        ? {
            ...classified,
            githubReviewThreadCloseout: {
              ...classified.githubReviewThreadCloseout,
              deferUntil: { kind: 'review-state-unknown' as const, expiresAt: replyReviewRound.expiresAt },
            },
          }
        : classified

  // GitHub transport acknowledgment is not a durable admission receipt.
  void Promise.resolve()
    .then(() =>
      options.route(
        withApprovalPolicy(
          {
            ...routed,
            receiptId: delivery,
            accountIdentity: selfId === null ? undefined : `github:${selfId}`,
          },
          options.allowApprove?.() ?? true,
        ),
      ),
    )
    .catch((error: unknown) => {
      options.logger.error(`[github] route failed: ${describeError(error)}`)
    })
}

export const PR_APPROVAL_DISABLED_NOTE =
  'Operator policy: PR approval is disabled for this agent ' +
  '(`channels.github.review.approve: false`). If you review a PR and the ' +
  'verdict is `approve`, submit a `COMMENT` review instead of `APPROVE` — post ' +
  'the findings, but never formally approve.'

// The generic note's "submit a COMMENT instead of APPROVE" advice is wrong for a
// blocking re-review round: a COMMENT does not supersede a standing
// CHANGES_REQUESTED, so following it posts a non-decisive comment, never trips
// the dismissal guard, and strands the round with every sibling gated. This note
// is appended AFTER followupInstruction, so the generic wording would also be the
// last instruction the model reads and would win over the dismissal directive.
export const PR_APPROVAL_DISABLED_BLOCKING_NOTE =
  'Operator policy: PR approval is disabled for this agent ' +
  '(`channels.github.review.approve: false`). Never submit an `APPROVE` review. ' +
  'To clear your standing `CHANGES_REQUESTED` on this re-review, DISMISS it — a ' +
  '`COMMENT` review does not clear the block and leaves this follow-up round stranded.'

// Gating PR approval lives here (inbound text), not at the bash layer: the
// review is posted via `gh api --input <file>`, so the `event: APPROVE` value
// sits in a temp file the gh-cli-auth command interceptor never inspects. The
// note rides on every inbound (cheap: one line, only when an operator has
// opted out) so it reaches the agent for both webhook review requests and
// plain-language "@bot review this" asks, which arrive on arbitrary inbounds.
function withApprovalPolicy(message: InboundMessage, allowApprove: boolean, carriesBlocking = false): InboundMessage {
  if (allowApprove) return message
  const note = carriesBlocking ? PR_APPROVAL_DISABLED_BLOCKING_NOTE : PR_APPROVAL_DISABLED_NOTE
  const text = message.text === '' ? note : `${message.text}\n\n${note}`
  return { ...message, text }
}

// GitHub auto-records the App as a reviewer the moment its review posts, but
// leaves the decoy user pinned as a perpetual "review requested". When the bot
// drops its own review (the self-authored event we're about to discard), fire a
// background DELETE to remove the decoy. The DELETE is authenticated as the App,
// so the resulting review_request_removed webhook has the bot actor as sender
// and is dropped by classifyReviewRequest's self-loop guard — no fresh session.
function maybeScheduleDecoyReviewerDrop(input: {
  event: string
  action: string | null
  payload: Record<string, unknown>
  selfLogin: string | null
  options: GithubWebhookHandlerOptions
}): void {
  const { event, action, payload, selfLogin, options } = input
  if (event !== 'pull_request_review' || action !== 'submitted') return
  if (selfLogin === null) return
  const authToken = options.authToken
  if (authToken === undefined) return
  if ((options.authType?.() ?? 'pat') !== 'app') return
  const decoyLogin = resolveDecoyReviewerLogin(selfLogin, 'app')
  if (decoyLogin === null) return

  const repository = readRepository(payload)
  const pr = readRecord(payload.pull_request)
  const pullNumber = readNumber(pr, 'number')
  if (repository === null || pullNumber === null) return

  const fetchImpl = options.fetchImpl ?? fetch
  const schedule = options.scheduleBackgroundTask ?? defaultScheduleBackgroundTask
  const target = `${repository.owner}/${repository.name}#${pullNumber}`
  schedule(async () => {
    // authToken can throw (installation lookup / token mint), and a thrown
    // failure must still warn — the default scheduler swallows rejections, so
    // catching here is the only place the failure is observable.
    try {
      const token = await authToken({ repoSlug: `${repository.owner}/${repository.name}` })
      const result = await removeRequestedReviewer({
        fetchImpl,
        token,
        owner: repository.owner,
        repo: repository.name,
        pullNumber,
        reviewerLogin: decoyLogin,
      })
      if (result.kind === 'failed') {
        options.logger.warn(`[github] failed to drop decoy reviewer @${decoyLogin} from ${target}: ${result.reason}`)
      }
    } catch (err) {
      options.logger.warn(`[github] failed to drop decoy reviewer @${decoyLogin} from ${target}: ${describeError(err)}`)
    }
  })
}

function defaultScheduleBackgroundTask(task: () => Promise<void>): void {
  void task().catch(() => {})
}

async function recoveredPullRequestIsStillDraft(
  options: GithubWebhookHandlerOptions,
  repository: { owner: string; name: string },
  prNumber: number,
  workspace: string,
): Promise<boolean> {
  if (options.authToken === undefined) {
    throw new Error(`recovered draft freshness check unavailable for ${workspace}#${prNumber}: auth unavailable`)
  }
  try {
    const token = await options.authToken({ repoSlug: workspace })
    const response = await (options.fetchImpl ?? fetch)(
      `${GITHUB_API_BASE}/repos/${repository.owner}/${repository.name}/pulls/${prNumber}`,
      { headers: githubJsonHeaders(token) },
    )
    if (!response.ok) {
      throw new Error(`pull request fetch returned ${response.status}`)
    }
    const current = readRecord(await response.json().catch(() => null))
    const draft = readBoolean(current, 'draft')
    if (draft === null) {
      throw new Error('pull request response missing draft state')
    }
    if (!draft) {
      options.logger.info(`[github] recovered draft abort skipped for ${workspace}#${prNumber}: pull request is ready`)
    }
    return draft
  } catch (err) {
    throw new Error(`recovered draft freshness check failed for ${workspace}#${prNumber}: ${describeError(err)}`)
  }
}

function scheduleDraftAbort(input: {
  workspace: string
  prNumber: number
  prId: number | null
  options: GithubWebhookHandlerOptions
}): void {
  const { workspace, prNumber, prId, options } = input
  const target = `${workspace}#${prNumber}`
  const schedule = options.scheduleBackgroundTask ?? defaultScheduleBackgroundTask
  schedule(async () => {
    const abortPromise = runGithubPrAbort(options, workspace, prNumber, target)
    const cooldownPromise = clearDraftReconcileCooldown(options, workspace, prId, target)
    const [outcome] = await Promise.all([abortPromise, cooldownPromise])
    if (outcome === null) return
    if (outcome.kind === 'no-live-session') {
      options.logger.info(`[github] draft abort ${target}: no-live-session`)
      return
    }
    options.logger.info(
      `[github] draft abort ${target}: sessions=${outcome.matchedSessions} reviewers=${outcome.matchedReviewers} failures=${outcome.abortFailures}`,
    )
  })
}

async function runGithubPrAbort(
  options: GithubWebhookHandlerOptions,
  workspace: string,
  prNumber: number,
  target: string,
): Promise<
  | { kind: 'aborted'; matchedSessions: number; matchedReviewers: number; abortFailures: number }
  | { kind: 'no-live-session' }
  | null
> {
  if (options.abortGithubPrTurn === undefined) {
    options.logger.info(`[github] draft abort unavailable for ${target}: router callback not registered`)
    return null
  }
  try {
    return await options.abortGithubPrTurn(workspace, prNumber, 'pull request converted to draft')
  } catch (err) {
    options.logger.warn(`[github] draft abort failed for ${target}: ${describeError(err)}`)
    return null
  }
}

async function clearDraftReconcileCooldown(
  options: GithubWebhookHandlerOptions,
  workspace: string,
  prId: number | null,
  target: string,
): Promise<void> {
  if (prId === null) {
    options.logger.warn(`[github] draft reconcile cooldown clear skipped for ${target}: pull request id missing`)
    return
  }
  if (options.clearReconcileCooldown === undefined) {
    options.logger.info(`[github] draft reconcile cooldown clear skipped for ${target}: store not initialized`)
    return
  }
  try {
    const outcome = await options.clearReconcileCooldown(workspace, prId)
    if (outcome === 'not-initialized') {
      options.logger.info(`[github] draft reconcile cooldown clear skipped for ${target}: store not initialized`)
    }
  } catch (err) {
    options.logger.warn(`[github] draft reconcile cooldown clear failed for ${target}: ${describeError(err)}`)
  }
}

const MAX_REVIEW_FOLLOWUP_ATTEMPTS = 3
const REVIEW_FOLLOWUP_RETRY_BASE_MS = 1000
const REVIEW_FOLLOWUP_DEDUP_LIMIT = 1000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ReviewFollowupDedupState = {
  reservations: BoundedMap<string, 'pending' | 'completed'>
  failures: BoundedMap<string, number>
}

// This state cannot live in createGithubWebhookHandler's closure because the
// exported processVerifiedGithubDelivery core is also called directly by the
// recovery sweep. Keying by the shared options identity gives both paths one
// handler-scoped state while allowing it to be garbage-collected. It stays
// separate from options.dedup because that add-only delivery cache has no
// release path, which would recreate the transient-failure retry hole here.
const reviewFollowupDedupByHandler = new WeakMap<GithubWebhookHandlerOptions, ReviewFollowupDedupState>()

function reviewFollowupDedup(options: GithubWebhookHandlerOptions): ReviewFollowupDedupState {
  const existing = reviewFollowupDedupByHandler.get(options)
  if (existing !== undefined) return existing
  const created: ReviewFollowupDedupState = {
    reservations: createBoundedMap(REVIEW_FOLLOWUP_DEDUP_LIMIT),
    failures: createBoundedMap(REVIEW_FOLLOWUP_DEDUP_LIMIT),
  }
  reviewFollowupDedupByHandler.set(options, created)
  return created
}

function scheduleReviewFollowup(input: {
  payload: Record<string, unknown>
  selfId: string | null
  selfLogin: string | null
  options: GithubWebhookHandlerOptions
}): void {
  const { payload, selfId, selfLogin, options } = input
  if (selfLogin === null) return
  const authToken = options.authToken
  if (authToken === undefined) return

  const repository = readRepository(payload)
  const pr = readRecord(payload.pull_request)
  const pullNumber = readNumber(pr, 'number')
  if (repository === null || pullNumber === null) return
  const headSha = readString(readRecord(pr?.head), 'sha')

  // Same webhook head SHA can arrive on several deliveries (a multi-commit push
  // emits one synchronize per ref update). Dedup the follow-up on the head SHA
  // so a single push wakes at most one re-review, distinct from the per-delivery
  // dedup above. When headSha is absent we cannot dedup, so we skip the followup
  // rather than risk a re-review storm.
  if (headSha === null) {
    options.logger.warn(`[github] synchronize for ${repository.owner}/${repository.name}#${pullNumber} has no head sha`)
    return
  }
  const followupKey = `${repository.owner}/${repository.name}#${pullNumber}:${headSha}`
  const followupDedup = reviewFollowupDedup(options)
  if (followupDedup.reservations.has(followupKey)) return
  if ((followupDedup.failures.get(followupKey) ?? 0) >= MAX_REVIEW_FOLLOWUP_ATTEMPTS) return
  followupDedup.reservations.set(followupKey, 'pending')

  const reviewOn = options.reviewOn?.() ?? 'review_requested'
  const fetchImpl = options.fetchImpl ?? fetch
  const schedule = options.scheduleBackgroundTask ?? defaultScheduleBackgroundTask
  const sleepImpl = options.sleepImpl ?? defaultSleep
  const generateReviewRoundId = options.generateReviewRoundId ?? randomUUID
  const target = `${repository.owner}/${repository.name}#${pullNumber}`

  const runFollowupAttempt = async (): Promise<'completed' | 'retry'> => {
    try {
      const token = await authToken({ repoSlug: `${repository.owner}/${repository.name}` })
      const threads = await listUnresolvedSelfReviewThreads({
        token,
        selfLogin,
        owner: repository.owner,
        repo: repository.name,
        prNumber: pullNumber,
        fetchImpl,
      })
      if (!threads.ok) {
        options.logger.warn(`[github] review-thread recheck failed for ${target}: ${threads.error}`)
        return 'retry'
      }

      // A held CHANGES_REQUESTED is the bot's own obligation regardless of how
      // reviews are triggered, so re-evaluate it on push unless review is off.
      let selfBlocking = false
      if (reviewOn !== 'off') {
        const blocking = await fetchSelfReviewBlocking({
          token,
          selfLogin,
          owner: repository.owner,
          repo: repository.name,
          prNumber: pullNumber,
          fetchImpl,
        })
        if (blocking.ok) selfBlocking = blocking.selfBlocking
        else {
          options.logger.warn(`[github] review-state recheck failed for ${target}: ${blocking.error}`)
          // Thread and verdict obligations form one follow-up attempt. Routing
          // only the known threads would mark this SHA complete and permanently
          // lose a blocking-review obligation, so fail the whole attempt and let
          // the scheduled job retry both lookups before anything is routed.
          return 'retry'
        }
      }

      if (threads.threads.length === 0) {
        if (selfBlocking) {
          const round = buildReviewRound(repository, pullNumber, headSha, null, generateReviewRoundId)
          await options.route(
            withApprovalPolicy(
              buildReviewFollowupInbound({
                repository,
                pullNumber,
                headSha,
                thread: null,
                selfBlocking: true,
                round,
                title: readString(pr, 'title'),
                accountIdentity: selfId === null ? undefined : `github:${selfId}`,
              }),
              options.allowApprove?.() ?? true,
              true,
            ),
          )
        }
        return 'completed'
      }

      const round = selfBlocking
        ? buildReviewRound(
            repository,
            pullNumber,
            headSha,
            String(threads.threads[0]!.rootCommentId),
            generateReviewRoundId,
          )
        : undefined
      for (const [index, thread] of threads.threads.entries()) {
        // Deliver the PR-level blocking obligation through exactly one sibling
        // thread session. A landed verdict is already fanned across every live
        // sibling PR session by injectPrVerdictActivity, while asking all of them
        // to submit it would recreate a cross-session verdict race.
        const carriesBlockingObligation = selfBlocking && index === 0
        await options.route(
          withApprovalPolicy(
            buildReviewFollowupInbound({
              repository,
              pullNumber,
              headSha,
              thread,
              selfBlocking: carriesBlockingObligation,
              ...(round !== undefined ? { round } : {}),
              title: readString(pr, 'title'),
              accountIdentity: selfId === null ? undefined : `github:${selfId}`,
            }),
            options.allowApprove?.() ?? true,
            carriesBlockingObligation,
          ),
        )
      }
      return 'completed'
    } catch (err) {
      options.logger.warn(`[github] review followup failed for ${target}: ${describeError(err)}`)
      return 'retry'
    }
  }

  schedule(async () => {
    for (let attempt = 1; attempt <= MAX_REVIEW_FOLLOWUP_ATTEMPTS; attempt += 1) {
      if ((await runFollowupAttempt()) === 'completed') {
        followupDedup.reservations.set(followupKey, 'completed')
        followupDedup.failures.delete(followupKey)
        return
      }
      if (attempt < MAX_REVIEW_FOLLOWUP_ATTEMPTS) {
        await sleepImpl(REVIEW_FOLLOWUP_RETRY_BASE_MS * 2 ** (attempt - 1))
      }
    }

    followupDedup.reservations.delete(followupKey)
    const failures = (followupDedup.failures.get(followupKey) ?? 0) + MAX_REVIEW_FOLLOWUP_ATTEMPTS
    followupDedup.failures.set(followupKey, failures)
    options.logger.warn(
      `[github] review followup retry cap exhausted for ${target} head=${headSha} attempts=${failures}; a new head or adapter restart is required to retry`,
    )
  })
}

function buildReviewFollowupInbound(input: {
  repository: { owner: string; name: string }
  pullNumber: number
  headSha: string
  thread: UnresolvedSelfReviewThread | null
  selfBlocking: boolean
  round?: GithubReviewFollowupRound
  title: string | null
  accountIdentity?: string
}): InboundMessage {
  const { repository, pullNumber, headSha, thread, selfBlocking, round, title } = input
  const titleSegment = title !== null && title.trim() !== '' ? `: "${title}"` : ''
  const text =
    `PR #${pullNumber}${titleSegment} received new commits (now at ${headSha.slice(0, 7)}). ` +
    followupInstruction(thread, selfBlocking)

  return {
    adapter: 'github',
    workspace: `${repository.owner}/${repository.name}`,
    chat: `pr:${pullNumber}`,
    thread: thread === null ? null : String(thread.rootCommentId),
    ...(round !== undefined ? { githubReviewRound: round } : {}),
    text,
    externalMessageId: `pr-${pullNumber}-recheck-${headSha}${thread === null ? '' : `-thread-${thread.rootCommentId}`}`,
    eventKind: 'pull_request:synchronize:review-followup',
    // Verdict coordination round IDs are attempt-local. Durable admission uses
    // the platform head revision, stable across partial retries and redelivery.
    revision: headSha,
    accountIdentity: input.accountIdentity,
    authorId: 'github-system',
    authorName: 'github',
    authorIsBot: false,
    isBotMention: true,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts: 0,
  }
}

function buildReviewRound(
  repository: { owner: string; name: string },
  prNumber: number,
  headSha: string,
  carrierThread: string | null,
  generateRoundId: () => string,
): GithubReviewFollowupRound {
  return {
    kind: 'push',
    roundId: generateRoundId(),
    workspace: `${repository.owner}/${repository.name}`,
    prNumber,
    headSha,
    carrierThread,
  }
}

function followupInstruction(thread: UnresolvedSelfReviewThread | null, selfBlocking: boolean): string {
  const threadPart =
    thread !== null
      ? `This session is scoped to one unresolved review thread you authored. Check whether the new commits ` +
        `addressed its concern. If addressed, use channel_reply with a short acknowledgement and ` +
        `resolve_review_thread: true; if not, reply with resolve_review_thread: false (or leave it):\n` +
        `${renderThreadLine(thread)}\n`
      : ''
  // A held CHANGES_REQUESTED never clears itself: GitHub keeps the block until a
  // fresh APPROVE or dismissal, so a blocking follow-up must always end with a
  // submitted verdict — the "end without replying" escape hatch is reserved for
  // the thread-only path, where leaving every thread open is a valid no-op.
  const blockingPart = selfBlocking
    ? `Your latest review on this PR is still CHANGES_REQUESTED, which keeps the PR blocked until you ` +
      `submit a fresh review. Re-review the current head against the concerns from that blocking review ` +
      `and always end with a new verdict: if the commits resolve your concerns, submit an APPROVE when ` +
      `approval is enabled, or DISMISS your prior CHANGES_REQUESTED when approval is disabled; if concerns ` +
      `remain, submit a new ` +
      `CHANGES_REQUESTED explaining what is still blocking. `
    : ''
  const tail = selfBlocking ? '' : 'If none are addressed, end your turn without replying.'
  return `${threadPart}${blockingPart}${tail}`
}

function renderThreadLine(thread: UnresolvedSelfReviewThread): string {
  const where = thread.path !== null ? ` on ${thread.path}${thread.line !== null ? `:${thread.line}` : ''}` : ''
  const concern = thread.snippet !== null ? ` — "${thread.snippet}"` : ''
  return `- thread ${thread.rootCommentId}${where}${concern}`
}

export async function verifySignature(body: string, secret: string, sigHeader: string): Promise<boolean> {
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(sigHeader)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function githubEventRevision(payload: Record<string, unknown>): string {
  const subject =
    readRecord(payload.comment) ??
    readRecord(payload.review) ??
    readRecord(payload.pull_request) ??
    readRecord(payload.issue) ??
    readRecord(payload.discussion)
  const head = readRecord(readRecord(payload.pull_request)?.head)
  const reviewer = readRecord(payload.requested_reviewer) ?? readRecord(payload.requested_team)
  return JSON.stringify([
    readString(subject, 'updated_at') ?? readString(subject, 'submitted_at') ?? readString(subject, 'created_at'),
    readString(head, 'sha'),
    readNumber(reviewer, 'id'),
  ])
}

export function classifyGithubInbound(
  event: string,
  payload: Record<string, unknown>,
  selfLogin: string | null,
  options?: {
    teamIsBotMember?: boolean
    authType?: 'pat' | 'app'
    reviewOn?: GithubReviewOn
    reviewCommentParent?: ReviewCommentParent
  },
): InboundMessage | null {
  const repository = readRepository(payload)
  if (repository === null) return null
  const mention = resolveBotMentionLogins(selfLogin, options?.authType ?? 'pat')
  const base = {
    adapter: 'github' as const,
    workspace: `${repository.owner}/${repository.name}`,
    eventKind: `${event}:${readString(payload, 'action') ?? 'event'}`,
    revision: githubEventRevision(payload),
    isDm: false,
    mentionsOthers: false,
    replyToOtherMessageId: null,
  }

  if (event === 'issue_comment') {
    const issue = readRecord(payload.issue)
    const comment = readRecord(payload.comment)
    if (issue === null || comment === null) return null
    const number = readNumber(issue, 'number')
    const id = readNumber(comment, 'id')
    if (number === null || id === null) return null
    const isPullRequest = readRecord(issue.pull_request) !== null
    const user = readUser(comment.user)
    return buildInbound(
      { ...base, chat: `${isPullRequest ? 'pr' : 'issue'}:${number}`, thread: null },
      comment.body,
      id,
      user,
      mention,
      comment.created_at,
      { kind: 'issue-comment', owner: repository.owner, repo: repository.name, commentId: id },
    )
  }

  if (event === 'pull_request_review_comment') {
    const pr = readRecord(payload.pull_request)
    const comment = readRecord(payload.comment)
    if (pr === null || comment === null) return null
    const number = readNumber(pr, 'number')
    const id = readNumber(comment, 'id')
    if (number === null || id === null) return null
    const parentId = readNumber(comment, 'in_reply_to_id')
    const root = parentId ?? id
    const parent =
      parentId !== null && options?.reviewCommentParent?.parentId === parentId ? options.reviewCommentParent : null
    const commenter = readUser(comment.user)
    const githubReviewThreadCloseout: GithubReviewThreadCloseout | undefined =
      parent?.isSelf === true && commenter !== null && !isBotUser(commenter)
        ? { workspace: base.workspace, prNumber: number, rootCommentId: String(root) }
        : undefined
    const directedAtBot =
      parentId === null &&
      isSelfPr(readUser(pr.user), selfLogin, options?.authType ?? 'pat') &&
      commenter !== null &&
      !isSelfAuthor(commenter, null, selfLogin)
    return buildInbound(
      { ...base, chat: `pr:${number}`, thread: String(root) },
      comment.body,
      id,
      commenter,
      mention,
      comment.created_at,
      { kind: 'pr-review-comment', owner: repository.owner, repo: repository.name, commentId: id },
      false,
      {
        suppressSticky: true,
        ...(directedAtBot ? { forceBotMention: true } : {}),
        replyToBotMessageId: parent?.isSelf === true ? String(parent.parentId) : null,
        replyToOtherMessageId: parent?.isSelf === false ? String(parent.parentId) : null,
        ...(githubReviewThreadCloseout !== undefined ? { githubReviewThreadCloseout } : {}),
      },
    )
  }

  if (event === 'discussion_comment') {
    const discussion = readRecord(payload.discussion)
    const comment = readRecord(payload.comment)
    if (discussion === null || comment === null) return null
    const number = readNumber(discussion, 'number')
    const id = readNumber(comment, 'id')
    if (number === null || id === null) return null
    return buildInbound(
      { ...base, chat: `discussion:${number}`, thread: null },
      comment.body,
      id,
      readUser(comment.user),
      mention,
      comment.created_at,
      null,
    )
  }

  if (event === 'issues') {
    const issue = readRecord(payload.issue)
    if (issue === null) return null
    const number = readNumber(issue, 'number')
    const id = readNumber(issue, 'id') ?? number
    if (number === null || id === null) return null
    const action = readString(payload, 'action')
    const opener = readUser(issue.user)
    const hasBody = readString(issue, 'body')?.trim() ? true : false
    const text =
      action === 'opened'
        ? bodyOrOpenedTitle(issue.body, opener, 'issue', number, readString(issue, 'title'))
        : issue.body
    return buildInbound(
      { ...base, chat: `issue:${number}`, thread: null },
      text,
      id,
      opener,
      mention,
      issue.created_at,
      { kind: 'issue', owner: repository.owner, repo: repository.name, issueNumber: number },
      action === 'opened' && !hasBody,
    )
  }

  if (event === 'pull_request') {
    const pr = readRecord(payload.pull_request)
    if (pr === null) return null
    const number = readNumber(pr, 'number')
    const id = readNumber(pr, 'id') ?? number
    if (number === null || id === null) return null
    const action = readString(payload, 'action')
    const reviewOn = options?.reviewOn ?? 'review_requested'
    if (action === 'review_requested' || action === 'review_request_removed') {
      // `off` disables the dedicated review trigger: these two actions exist
      // only to drive review-request behavior here, so under `off` they wake no
      // session rather than falling through to awareness-only context.
      if (reviewOn === 'off') return null
      return classifyReviewRequest({
        action,
        payload,
        pr,
        number,
        base,
        selfLogin,
        authType: options?.authType ?? 'pat',
        teamIsBotMember: options?.teamIsBotMember,
      })
    }
    // `ready_for_review` (draft→ready) is a fresh review opportunity, so it
    // reuses the `opened` paths: same review trigger, same title-only awareness
    // text. The draft skip in classifyOpenedReviewTrigger is a no-op here since
    // the PR is non-draft once ready — preserving "review when no longer draft".
    const isOpenLike = action === 'opened' || action === 'ready_for_review'
    if (isOpenLike && reviewOn === 'opened') {
      // Draft opened under `review.on: "opened"`: skip cleanly (null wakes no
      // session) and wait for the `ready_for_review` trigger. Must NOT fall
      // through to the awareness path below, where a multi-collaborator repo
      // silently `observed`s it — a draft whose `ready_for_review` delivery is
      // later lost would then never get reviewed. `review_requested`
      // on a draft is unaffected: it returns above via classifyReviewRequest.
      if (readBoolean(pr, 'draft') === true) return null
      const trigger = classifyOpenedReviewTrigger({
        payload,
        pr,
        number,
        base,
        selfLogin,
        authType: options?.authType ?? 'pat',
      })
      if (trigger !== null) return trigger
    }
    const opener = readUser(pr.user)
    const hasBody = readString(pr, 'body')?.trim() ? true : false
    const prText = isOpenLike ? bodyOrOpenedTitle(pr.body, opener, 'PR', number, readString(pr, 'title')) : pr.body
    return buildInbound(
      { ...base, chat: `pr:${number}`, thread: null },
      prText,
      id,
      opener,
      mention,
      pr.created_at,
      { kind: 'issue', owner: repository.owner, repo: repository.name, issueNumber: number },
      isOpenLike && !hasBody,
    )
  }

  if (event === 'pull_request_review') {
    const pr = readRecord(payload.pull_request)
    const review = readRecord(payload.review)
    if (pr === null || review === null) return null
    const number = readNumber(pr, 'number')
    const id = readNumber(review, 'id')
    if (number === null || id === null) return null
    const reviewer = readUser(review.user)
    const body = readString(review, 'body')
    const hasBody = body !== null && body.trim() !== ''
    // A body-less COMMENTED review is the container GitHub submits when a user
    // replies inline to a review thread; those replies arrive separately as
    // pull_request_review_comment events. Synthesizing "@x submitted a review"
    // here duplicates that traffic with a contentless line that trips the
    // solo-human engagement fallback into a reflexive "Thanks for the review!".
    // APPROVED / CHANGES_REQUESTED are real verdicts, so their synthesis stays.
    if (!hasBody && isCommentedReviewState(readString(review, 'state'))) return null
    const text = hasBody
      ? body
      : reviewer !== null
        ? synthesizeReviewStateText(reviewer.login, number, readString(pr, 'title'), readString(review, 'state'))
        : ''
    const directedAtBot =
      isSelfPr(readUser(pr.user), selfLogin, options?.authType ?? 'pat') &&
      reviewer !== null &&
      !isSelfAuthor(reviewer, null, selfLogin) &&
      isActionableReviewState(readString(review, 'state'))
    return buildInbound(
      { ...base, chat: `pr:${number}`, thread: null },
      text,
      id,
      reviewer,
      mention,
      review.submitted_at,
      null,
      !hasBody,
      { suppressSticky: true, ...(directedAtBot ? { forceBotMention: true } : {}) },
    )
  }

  if (event === 'discussion') {
    const discussion = readRecord(payload.discussion)
    if (discussion === null) return null
    const number = readNumber(discussion, 'number')
    const id = readNumber(discussion, 'id') ?? number
    if (number === null || id === null) return null
    const action = readString(payload, 'action')
    const opener = readUser(discussion.user)
    const hasBody = readString(discussion, 'body')?.trim() ? true : false
    const text =
      action === 'created'
        ? bodyOrOpenedTitle(discussion.body, opener, 'discussion', number, readString(discussion, 'title'))
        : discussion.body
    return buildInbound(
      { ...base, chat: `discussion:${number}`, thread: null },
      text,
      id,
      opener,
      mention,
      discussion.created_at,
      null,
      action === 'created' && !hasBody,
    )
  }

  return null
}

type ReviewRequestInput = {
  action: 'review_requested' | 'review_request_removed'
  payload: Record<string, unknown>
  pr: Record<string, unknown>
  number: number
  base: Pick<InboundMessage, 'adapter' | 'workspace' | 'isDm' | 'mentionsOthers' | 'replyToOtherMessageId'>
  selfLogin: string | null
  authType: 'pat' | 'app'
  teamIsBotMember: boolean | undefined
}

type ReviewCommentParent = { isSelf: boolean; parentId: number }

type BuildInboundOptions = {
  suppressSticky?: boolean
  replyToBotMessageId?: string | null
  replyToOtherMessageId?: string | null
  githubReviewThreadCloseout?: GithubReviewThreadCloseout
  // Forces isBotMention=true with no @-handle in the body. A review (or
  // top-level review comment) on a PR the agent ITSELF authored is directed at
  // the bot — the inverse of review_requested — so it engages even though the
  // reviewer never types `@bot`. Paired with suppressSticky so reviews on OTHER
  // people's PRs still observe-only (preserving the PR #672 fix).
  forceBotMention?: boolean
}

// A GitHub App can never be a `requested_reviewer` — that field only holds
// real user accounts, and the App actor (`slug[bot]`) is not one. The
// supported workaround is a decoy user account named after the App that an
// operator requests instead (see docs/content/docs/internals/github-decoy-reviewer.mdx).
// Its login is, by convention, the App slug — i.e. `selfLogin` with the
// `[bot]` suffix removed (`my-app[bot]` → `my-app`). This is the single seam
// where that login is resolved: when the decoy account's real login diverges
// from the slug, a future config field replaces this derivation without
// touching the matcher. PAT auth has no decoy (the bot IS a real user that can
// be requested directly), so it returns null.
const BOT_LOGIN_SUFFIX = '[bot]'

function resolveDecoyReviewerLogin(selfLogin: string, authType: 'pat' | 'app'): string | null {
  if (authType !== 'app') return null
  if (!selfLogin.endsWith(BOT_LOGIN_SUFFIX)) return null
  const slug = selfLogin.slice(0, -BOT_LOGIN_SUFFIX.length)
  return slug !== '' ? slug : null
}

// The @-handles that count as "addressed to us" in inbound body text. Under
// App auth `selfLogin` is the actor login `slug[bot]`, but GitHub renders a
// human's mention of the App as `@slug` (the bare slug — the decoy account's
// login), with no `[bot]` suffix and no way to type one. Matching only against
// `selfLogin` therefore never sees `@typeey` for a `typeey[bot]` actor, so a
// direct "@typeey review again" lands with isBotMention=false and falls through
// the engagement mention gate. Include the decoy slug so the bare-slug mention
// is recognized. Under PAT auth the bot IS a real user, so there is no decoy
// and only `selfLogin` applies.
export type BotMentionLogins = readonly string[]

export function resolveBotMentionLogins(selfLogin: string | null, authType: 'pat' | 'app'): BotMentionLogins {
  if (selfLogin === null) return []
  const decoyLogin = resolveDecoyReviewerLogin(selfLogin, authType)
  return decoyLogin !== null ? [selfLogin, decoyLogin] : [selfLogin]
}

// GitHub login chars are ASCII letters, digits, and hyphen. A `@login` token is
// a real mention of `login` only when the char right after it is not one of
// these — otherwise `@${login}` is a prefix of a longer, different login. This
// matters for the App decoy slug: `resolveBotMentionLogins('typeclaw[bot]')`
// yields the bare slug `typeclaw`, and a naive substring check would treat
// `@typeclaw-bot` (a different user) as a self-mention. The trailing `[` of
// `@typeclaw[bot]` is not a login char, so the full actor handle still matches.
const LOGIN_CHAR = /[A-Za-z0-9-]/

function textMentionsBot(text: string, mentionLogins: BotMentionLogins): boolean {
  return mentionLogins.some((login) => mentionsLogin(text, login))
}

function mentionsLogin(text: string, login: string): boolean {
  const token = `@${login}`
  let from = 0
  for (;;) {
    const at = text.indexOf(token, from)
    if (at === -1) return false
    const next = text[at + token.length]
    if (next === undefined || !LOGIN_CHAR.test(next)) return true
    from = at + 1
  }
}

function classifyReviewRequest(input: ReviewRequestInput): InboundMessage | null {
  const { action, payload, pr, number, base, selfLogin, authType, teamIsBotMember } = input
  if (selfLogin === null) return null
  const decoyLogin = resolveDecoyReviewerLogin(selfLogin, authType)
  const sender = readUser(payload.sender)
  if (sender === null) return null
  // Self-loop guard: if the bot (or its decoy) requested/un-requested the
  // review, drop the event. The bot adding itself as a reviewer would
  // otherwise wake a fresh session every time it self-assigns.
  if (sender.login === selfLogin || (decoyLogin !== null && sender.login === decoyLogin)) return null

  const requestedUser = readUser(payload.requested_reviewer)
  const requestedTeam = readReviewerTeam(payload.requested_team)

  const isMeAsUser =
    requestedUser !== null &&
    (requestedUser.login === selfLogin || (decoyLogin !== null && requestedUser.login === decoyLogin))
  const isMyTeam = requestedTeam !== null && teamIsBotMember === true
  if (!isMeAsUser && !isMyTeam) return null

  const title = readString(pr, 'title') ?? `#${number}`
  const head = readString(readRecord(pr.head), 'ref')
  const baseRef = readString(readRecord(pr.base), 'ref')
  const branchSegment = head !== null && baseRef !== null ? ` Branch: ${head} → ${baseRef}.` : ''
  const verbed =
    action === 'review_requested'
      ? isMyTeam
        ? `requested a review from team @${requestedTeam?.slug} (you're a member of) on PR #${number}: "${title}".`
        : `requested your review on PR #${number}: "${title}".`
      : isMyTeam
        ? `removed the review request for team @${requestedTeam?.slug} on PR #${number}: "${title}".`
        : `removed your review request on PR #${number}: "${title}".`
  const closing =
    action === 'review_requested'
      ? ' Please review the changes line-by-line and post your feedback.'
      : ' You can stop any in-progress review.'
  const text = `@${sender.login} ${verbed}${branchSegment}${closing}`

  // Synthesize a stable per-event externalMessageId. The PR's `updated_at`
  // changes on every review-request mutation, so combining it with the PR id
  // and the action keeps separate "requested → removed → requested again"
  // events from collapsing into one dedup'd id.
  const updatedAt = readString(pr, 'updated_at') ?? ''
  const prId = readNumber(pr, 'id') ?? number
  const externalMessageId = `pr-${prId}-${action}-${updatedAt}`

  return {
    ...base,
    chat: `pr:${number}`,
    thread: null,
    text,
    externalMessageId,
    authorId: String(sender.id),
    authorName: sender.login,
    authorIsBot: sender.type === 'Bot',
    isBotMention: true,
    replyToBotMessageId: null,
    ts: updatedAt !== '' ? Date.parse(updatedAt) || 0 : 0,
  }
}

type OpenedReviewTriggerInput = {
  payload: Record<string, unknown>
  pr: Record<string, unknown>
  number: number
  base: Pick<InboundMessage, 'adapter' | 'workspace' | 'isDm' | 'mentionsOthers' | 'replyToOtherMessageId'>
  selfLogin: string | null
  authType: 'pat' | 'app'
}

function classifyOpenedReviewTrigger(input: OpenedReviewTriggerInput): InboundMessage | null {
  const { payload, pr, number, base, selfLogin, authType } = input
  if (selfLogin === null) return null
  const sender = readUser(payload.sender) ?? readUser(pr.user)
  if (sender === null) return null
  // Defensive self-loop guard mirroring classifyReviewRequest: the handler-level
  // self-author drop already discards bot-opened PRs, but the decoy account is a
  // distinct login, so a decoy-opened PR would otherwise wake a self-review.
  const decoyLogin = resolveDecoyReviewerLogin(selfLogin, authType)
  if (sender.login === selfLogin || (decoyLogin !== null && sender.login === decoyLogin)) return null

  const title = readString(pr, 'title') ?? `#${number}`
  const head = readString(readRecord(pr.head), 'ref')
  const baseRef = readString(readRecord(pr.base), 'ref')
  const branchSegment = head !== null && baseRef !== null ? ` Branch: ${head} → ${baseRef}.` : ''
  const text =
    `@${sender.login} opened PR #${number}: "${title}".${branchSegment}` +
    ' Please review the changes line-by-line and post your feedback.'

  const updatedAt = readString(pr, 'updated_at') ?? ''
  const prId = readNumber(pr, 'id') ?? number
  const externalMessageId = `pr-${prId}-opened-${updatedAt}`

  return {
    ...base,
    chat: `pr:${number}`,
    thread: null,
    text,
    externalMessageId,
    authorId: String(sender.id),
    authorName: sender.login,
    authorIsBot: sender.type === 'Bot',
    isBotMention: true,
    replyToBotMessageId: null,
    ts: updatedAt !== '' ? Date.parse(updatedAt) || 0 : 0,
  }
}

export type GithubReviewerTeam = { slug: string; id: number; org: string | null }

export function readReviewerTeam(value: unknown): GithubReviewerTeam | null {
  const team = readRecord(value)
  const slug = readString(team, 'slug')
  const id = readNumber(team, 'id')
  if (slug === null || id === null) return null
  const org = readString(readRecord(team?.organization), 'login')
  return { slug, id, org }
}

function buildInbound(
  key: Pick<
    InboundMessage,
    'adapter' | 'workspace' | 'chat' | 'thread' | 'isDm' | 'mentionsOthers' | 'replyToOtherMessageId'
  >,
  rawText: unknown,
  id: number,
  user: GithubUser | null,
  mention: BotMentionLogins,
  rawTs: unknown,
  reactionTarget: GithubReactionTarget | null,
  synthesizedAwareness = false,
  options?: BuildInboundOptions,
): InboundMessage | null {
  if (user === null) return null
  const text = typeof rawText === 'string' ? rawText : ''
  // A body-less inbound reaches engagement as contentless text; in a solo-human
  // channel the fallback engages on it and the agent replies with a generic
  // greeting. The other adapters drop empty text at their classifier — this is
  // the matching guard. Events whose empty body still carries signal (review
  // state, opened-PR/issue title) synthesize non-empty text upstream and so
  // never reach this drop.
  if (text.trim() === '') return null
  // Synthesized awareness lines carry an `@author` prefix describing who acted;
  // that handle is the author, never a third-party mention of the bot, so the
  // body-text mention heuristic must not fire on it.
  const isBotMention = options?.forceBotMention === true || (!synthesizedAwareness && textMentionsBot(text, mention))
  const replyToBotMessageId = options?.replyToBotMessageId ?? null
  const replyToOtherMessageId = options?.replyToOtherMessageId ?? key.replyToOtherMessageId
  return {
    ...key,
    text,
    externalMessageId: String(id),
    ...(reactionTarget !== null ? { reactionRef: encodeGithubReactionRef(reactionTarget) } : {}),
    authorId: String(user.id),
    authorName: user.login,
    authorIsBot: isBotUser(user),
    isBotMention,
    ...(options?.suppressSticky === true ? { suppressSticky: true } : {}),
    ...(options?.githubReviewThreadCloseout !== undefined
      ? { githubReviewThreadCloseout: options.githubReviewThreadCloseout }
      : {}),
    replyToBotMessageId,
    replyToOtherMessageId,
    ts: typeof rawTs === 'string' ? Date.parse(rawTs) || 0 : 0,
  }
}

function bodyOrOpenedTitle(
  rawBody: unknown,
  opener: GithubUser | null,
  kind: 'issue' | 'PR' | 'discussion',
  number: number,
  title: string | null,
): string {
  const body = typeof rawBody === 'string' ? rawBody : ''
  if (body.trim() !== '' || opener === null) return body
  const label = title !== null && title.trim() !== '' ? `: "${title}"` : ''
  return `@${opener.login} opened ${kind} #${number}${label}.`
}

// Neutral phrasing per review state — must never imply a review was requested
// or that action is needed; a COMMENTED review in particular must not read as
// "please review", which is the review-request path's wording.
function synthesizeReviewStateText(
  reviewer: string,
  number: number,
  title: string | null,
  state: string | null,
): string {
  const label = title !== null && title.trim() !== '' ? `: "${title}"` : ''
  // GitHub's pull_request_review webhook can send the state in either case
  // depending on the source (webhook payload vs REST), so normalize before
  // matching — an unmatched state would silently fall back to the neutral verb.
  const normalized = state?.toLowerCase() ?? null
  const verb =
    normalized === 'approved'
      ? 'approved'
      : normalized === 'changes_requested'
        ? 'requested changes on'
        : 'submitted a review on'
  return `@${reviewer} ${verb} PR #${number}${label}.`
}

// A review on the agent's own PR engages it only when there is something to act
// on. APPROVED clears the PR and needs no reply, so engaging would just produce
// "thanks" churn; it stays awareness-only. COMMENTED and CHANGES_REQUESTED (and
// any non-approval state) carry feedback the agent should address. State case
// varies by payload source (webhook vs REST), so normalize before matching.
function isActionableReviewState(state: string | null): boolean {
  return state?.toLowerCase() !== 'approved'
}

function isCommentedReviewState(state: string | null): boolean {
  return state?.toLowerCase() === 'commented'
}

async function resolveTeamMembership(
  event: string,
  payload: Record<string, unknown>,
  options: GithubWebhookHandlerOptions,
): Promise<boolean | undefined> {
  if (event !== 'pull_request') return undefined
  const action = readString(payload, 'action')
  if (action !== 'review_requested' && action !== 'review_request_removed') return undefined
  const team = readReviewerTeam(payload.requested_team)
  if (team === null) return undefined
  const selfLogin = options.selfLogin()
  if (selfLogin === null) return false
  if (options.isBotInTeam === undefined) return false
  // The team payload sometimes omits `organization.login`. Fall back to the
  // repository owner, which is the only org GitHub can legally route team
  // reviewers from on a given PR.
  const org = team.org ?? readRepository(payload)?.owner ?? null
  if (org === null) return false
  try {
    return await options.isBotInTeam({ org, slug: team.slug, login: selfLogin })
  } catch (err) {
    options.logger.warn(`[github] team membership lookup failed: ${describeError(err)}`)
    return false
  }
}

async function resolveReviewCommentParent(
  event: string,
  payload: Record<string, unknown>,
  selfId: string | null,
  selfLogin: string | null,
  options: GithubWebhookHandlerOptions,
): Promise<ReviewCommentParent | null> {
  if (event !== 'pull_request_review_comment') return null
  const comment = readRecord(payload.comment)
  const parentId = readNumber(comment, 'in_reply_to_id')
  if (parentId === null) return null
  const repository = readRepository(payload)
  if (repository === null) return null
  const authToken = options.authToken
  if (authToken === undefined) return null

  try {
    const token = await authToken({ repoSlug: `${repository.owner}/${repository.name}` })
    const fetchImpl = options.fetchImpl ?? fetch
    const response = await fetchImpl(
      `${GITHUB_API_BASE}/repos/${repository.owner}/${repository.name}/pulls/comments/${parentId}`,
      { headers: githubJsonHeaders(token) },
    )
    if (!response.ok) return null
    const raw = (await response.json().catch(() => null)) as unknown
    const user = readUser(readRecord(raw)?.user)
    if (user === null) return null
    return { parentId, isSelf: isSelfAuthor(user, selfId, selfLogin) }
  } catch {
    return null
  }
}

async function resolveReplyReviewRound(
  event: string,
  payload: Record<string, unknown>,
  selfLogin: string | null,
  parent: ReviewCommentParent | null,
  options: GithubWebhookHandlerOptions,
): Promise<ReplyReviewRoundResolution | null> {
  if (event !== 'pull_request_review_comment' || parent?.isSelf !== true) return null
  const comment = readRecord(payload.comment)
  const parentId = readNumber(comment, 'in_reply_to_id')
  if (parentId === null || parent.parentId !== parentId) return null
  const expiresAt = (options.now ?? Date.now)() + GITHUB_REVIEW_STATE_UNKNOWN_TTL_MS
  if (selfLogin === null) return { kind: 'unknown', expiresAt }
  const repository = readRepository(payload)
  const pr = readRecord(payload.pull_request)
  const prNumber = readNumber(pr, 'number')
  const headSha = readString(readRecord(pr?.head), 'sha')
  const authToken = options.authToken
  if (repository === null || prNumber === null || headSha === null || authToken === undefined) {
    return { kind: 'unknown', expiresAt }
  }

  const target = `${repository.owner}/${repository.name}#${prNumber}`
  try {
    const token = await authToken({ repoSlug: `${repository.owner}/${repository.name}` })
    const blocking = await fetchSelfReviewBlocking({
      token,
      selfLogin,
      owner: repository.owner,
      repo: repository.name,
      prNumber,
      fetchImpl: options.fetchImpl ?? fetch,
    })
    if (!blocking.ok) {
      options.logger.warn(`[github] reply review-state lookup failed for ${target}: ${blocking.error}`)
      return { kind: 'unknown', expiresAt }
    }
    if (!blocking.selfBlocking) return { kind: 'clear' }
    if (blocking.selfBlockingReviewId === null) return { kind: 'unknown', expiresAt }
    return {
      kind: 'round',
      round: registerOrJoinReplyReviewRound({
        workspace: `${repository.owner}/${repository.name}`,
        prNumber,
        headSha,
        blockingReviewId: blocking.selfBlockingReviewId,
        thread: String(parentId),
        ...(options.now !== undefined ? { now: options.now } : {}),
        generateRoundId: options.generateReviewRoundId ?? randomUUID,
      }),
    }
  } catch (err) {
    options.logger.warn(`[github] reply review-state lookup failed for ${target}: ${describeError(err)}`)
    return { kind: 'unknown', expiresAt }
  }
}

function readRepository(payload: Record<string, unknown>): { owner: string; name: string } | null {
  const repository = readRecord(payload.repository)
  const owner = readRecord(repository?.owner)
  const ownerLogin = readString(owner, 'login')
  const name = readString(repository, 'name')
  if (ownerLogin === null || name === null) return null
  return { owner: ownerLogin, name }
}

function readAuthor(event: string, payload: Record<string, unknown>): GithubUser | null {
  for (const candidate of eventAuthorCandidates(event, payload)) {
    const user = readUser(readRecord(candidate)?.user)
    if (user !== null) return user
  }
  // Every GitHub webhook payload carries `sender` — the actor who triggered the
  // delivery. It is the universal fallback so events not enumerated above (and
  // any future ones the user adds to eventAllowlist) still drop self-authored
  // deliveries instead of slipping past the guard.
  return readUser(payload.sender)
}

// Maps each event to the entity whose `user` is the true author of THIS event,
// listed before broader containers. A pull_request_review payload ships both
// `pull_request` (the PR author) and `review` (the reviewer); the self-author
// drop must see the reviewer, so `review` must come first. PR #455's flat order
// (`pull_request` before `review`) made a self-review on someone else's PR
// resolve to the PR author, slip past the drop, and loop (see PR #460).
//
// `pull_request` and `pull_request_review_thread` carry only the `pull_request`
// container, whose `user` is the PR OPENER — not the actor of this delivery.
// For these events the self-author question is "who triggered the action?"
// (review_requested, edited, reopened, resolved, …), which is always
// `payload.sender`, never the opener. Mapping them to `[]` makes readAuthor
// skip the opener and fall through to the `sender` fallback. PR #462's
// `['pull_request']` resolved to the opener, so a human action on a
// bot-opened PR matched the bot and was wrongly dropped (the inbound landed
// as awareness-only "Recent context" and the agent never replied).
const PRIMARY_AUTHOR_KEYS: Record<string, readonly string[]> = {
  issue_comment: ['comment'],
  pull_request_review_comment: ['comment'],
  discussion_comment: ['comment'],
  commit_comment: ['comment'],
  pull_request_review: ['review'],
  pull_request_review_thread: [],
  issues: ['issue'],
  pull_request: [],
  discussion: ['discussion'],
  release: ['release'],
}

const FALLBACK_AUTHOR_KEYS = ['comment', 'review', 'issue', 'pull_request', 'discussion', 'release'] as const

function eventAuthorCandidates(event: string, payload: Record<string, unknown>): unknown[] {
  const keys = PRIMARY_AUTHOR_KEYS[event] ?? FALLBACK_AUTHOR_KEYS
  return keys.map((key) => payload[key])
}

// Matches by id OR login. Issue #452 captured a self-responding loop where
// the id-only guard didn't fire and the bot replied to its own comments ~8
// times in a row. Login is the second line of defense and aligns with the
// slack/discord/telegram/kakaotalk adapters, which all drop self-authored
// events at the classifier layer.
function isSelfAuthor(author: GithubUser, selfId: string | null, selfLogin: string | null): boolean {
  if (selfId !== null && String(author.id) === selfId) return true
  if (selfLogin !== null && author.login === selfLogin) return true
  return false
}

function isBotUser(user: GithubUser): boolean {
  return user.type === 'Bot'
}

// Whether the PR's OPENER is this agent. Distinct from isSelfAuthor (which
// guards self-loops on the event ACTOR by id/login): here we have only the
// `pull_request.user` from a review payload, no id to compare, and under App
// auth the bot opens PRs as the decoy account (login = slug, e.g. `typeey`),
// not the actor login `typeey[bot]`. So this matches selfLogin AND the decoy
// slug — mirroring resolveBotMentionLogins.
function isSelfPr(prUser: GithubUser | null, selfLogin: string | null, authType: 'pat' | 'app'): boolean {
  if (prUser === null || selfLogin === null) return false
  return resolveBotMentionLogins(selfLogin, authType).includes(prUser.login)
}

type GithubUser = { login: string; id: number; type?: string }

function readUser(value: unknown): GithubUser | null {
  const user = readRecord(value)
  const login = readString(user, 'login')
  const id = readNumber(user, 'id')
  if (login === null || id === null) return null
  const type = readString(user, 'type') ?? undefined
  return { login, id, ...(type !== undefined ? { type } : {}) }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown
    return readRecord(parsed)
  } catch {
    return null
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(obj: Record<string, unknown> | null, key: string): string | null {
  const value = obj?.[key]
  return typeof value === 'string' ? value : null
}

function readNumber(obj: Record<string, unknown> | null, key: string): number | null {
  const value = obj?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(obj: Record<string, unknown> | null, key: string): boolean | null {
  const value = obj?.[key]
  return typeof value === 'boolean' ? value : null
}

function ok(): Response {
  return new Response('ok', { status: 200 })
}
