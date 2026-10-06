import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import type { BackgroundObligationRef } from '@/channels/background-obligations'
import { checkCompletionClaim } from '@/channels/completion-claim'
import { checkFalseReceipt } from '@/channels/github-false-receipt'
import { evaluateRereviewGuard } from '@/channels/github-rereview-guard'
import {
  containsKimiToolDelimiter,
  isNoReplySignal,
  isUpstreamEmptyResponseSentinel,
  stripTrailingLeakedToolCall,
  type ChannelRouter,
} from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import type { GithubReviewFollowupRound } from '@/channels/types'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { fenceRuntimeNotice, fenceToolResult } from './runtime-notice'

export type ChannelReplyOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  githubReviewRound?: GithubReviewFollowupRound
}

export type CreateChannelReplyToolOptions = {
  router: ChannelRouter
  origin: ChannelReplyOrigin
  // Scopes the per-turn false-receipt ledger. Defaults to '' when a caller (e.g.
  // a focused test) has no session; the guard then simply finds no recorded
  // action and falls back to its safe default.
  sessionId?: string
  logger?: ChannelToolLogger
}

// channel_reply is the happy-path companion to channel_send for channel-routed
// sessions. The session's origin already pins the conversation we're inside
// (adapter, workspace, chat, thread), so the model shouldn't have to copy
// those fields verbatim every turn — that copying is exactly where it has
// historically dropped `thread` and posted to channel root by accident.
//
// channel_reply takes only `text` and addresses the message from the origin.
// channel_send remains for posting somewhere else (different chat, breaking
// out of a thread, sending DMs from a channel session, etc.).
export function createChannelReplyTool({
  router,
  origin,
  sessionId = '',
  logger = consoleChannelLogger,
}: CreateChannelReplyToolOptions) {
  return defineTool({
    name: 'channel_reply',
    label: 'Channel Reply',
    description:
      'Reply in the current conversation. This is your default way to respond to a channel session — ' +
      'addressing fields (adapter, workspace, chat, thread) are filled in from the session origin, so ' +
      'you only supply the text. To post somewhere else (different chat, break out of the current ' +
      'thread, etc.), use `channel_send` instead. ' +
      'On success the result carries adapter-reported posted-message ids (`messageId` and `messageIds` ' +
      'in send order) when available. For follow-ups, reuse `channel_reply` or the existing ' +
      '`channel_send` thread/root coordinates; a returned id starts a thread only where the adapter ' +
      'accepts a message id as `thread` (e.g. a new top-level Slack post).',
    parameters: Type.Object({
      text: Type.Optional(
        Type.String({
          description:
            'The message body. Use platform mention syntax `<@USER_ID>` for Slack/Discord mentions. Optional only when `attachments` is set.',
          minLength: 1,
        }),
      ),
      link_previews: Type.Optional(
        Type.Boolean({
          description:
            'Set false to suppress link/media previews on Slack bot and Telegram bot text replies. True or omitted preserves platform defaults. Ignored on other adapters. Slack file-upload captions are not covered.',
        }),
      ),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({
              description: 'Absolute path inside the agent container to the file to upload.',
              minLength: 1,
            }),
            filename: Type.Optional(Type.String({ minLength: 1 })),
          }),
          {
            description:
              'Optional files to attach. Slack folds `text` into the first file as a caption (single message). Discord uploads files separately and may post `text` as a follow-up message; uploaded files land in channel root even when replying inside a thread (upstream limitation).',
            minItems: 1,
          },
        ),
      ),
      more_work_this_turn: Type.Boolean({
        description:
          'REQUIRED on every channel_reply — you must explicitly choose, there is no default. Set `true` when this reply is a mid-turn status update (e.g. "working on it…") and you still have MORE WORK to do THIS turn — fetching data, running a tool, spawning a subagent, then replying again; `true` keeps the turn alive so that follow-up actually runs. ' +
          'Set `false` when this reply is your final message for the turn (the common case). ' +
          'This choice is mandatory precisely because a missing value used to default to ending the turn silently: a successful reply ends the turn unless `more_work_this_turn` is `true`, so a `false` on an ack you meant to keep working from drops the work you promised. ' +
          'Do not set `true` just to seem responsive; only when genuine multi-step work follows in the same turn.',
      }),
      resolve_review_thread: Type.Optional(
        Type.Boolean({
          description:
            'GitHub PR review threads ONLY. On a TERMINAL (`more_work_this_turn:false`) github PR review-thread reply that carries `text`, this is REQUIRED: you must set it to `true` or `false` and omitting it is rejected — you will be told to re-call with an explicit choice. (It stays a normal optional field everywhere else: ignored on Slack/Discord/Telegram/KakaoTalk and any non-github session, on github replies outside a review thread, on attachments-only replies, and on mid-turn `more_work_this_turn:true` status updates — leave it unset there.) ' +
            'Set `true` when your `text` acknowledges the concern is fixed/verified/addressed (e.g. "verified at <sha>", "thanks, that resolves it"): the runtime resolves the thread BEFORE posting, so the close-out actually happens in this same turn — a successful reply ends the turn, so a resolve deferred to "later" never runs. ' +
            "Set `false` when the thread should stay open (partial fix, disagreement, mid-discussion). It is safe to set `true` by default: the runtime resolves ONLY if the thread's root comment is yours — it refuses (and blocks the reply) on a human reviewer's thread, so you never close someone else's open question. You need not pre-check authorship; let the runtime enforce ownership.",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      let text = params.text
      const attachments = params.attachments
      const keepTurnAlive = params.more_work_this_turn === true
      if ((text === undefined || text === '') && (attachments === undefined || attachments.length === 0)) {
        logger.warn(formatChannelToolFailure('channel_reply', 'missing text and attachments'))
        return {
          content: [
            { type: 'text' as const, text: 'channel_reply denied: must provide `text`, `attachments`, or both.' },
          ],
          details: { ok: false, error: 'missing text and attachments' },
        }
      }

      const noReplyError = noReplyMisuseError(text)
      if (noReplyError) {
        logger.warn(formatChannelToolFailure('channel_reply', noReplyError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${noReplyError}` }],
          details: { ok: false, error: noReplyError },
        }
      }

      const upstreamSentinelError = upstreamEmptyResponseSentinelError(text)
      if (upstreamSentinelError) {
        logger.warn(formatChannelToolFailure('channel_reply', upstreamSentinelError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${upstreamSentinelError}` }],
          details: { ok: false, error: upstreamSentinelError },
        }
      }

      const kimiLeakError = kimiToolCallLeakError(text)
      if (kimiLeakError) {
        logger.warn(formatChannelToolFailure('channel_reply', kimiLeakError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${kimiLeakError}` }],
          details: { ok: false, error: kimiLeakError },
        }
      }

      // Prose-then-trailing-call leak (mirrors router.ts + channel-send.ts):
      // strip a serialized trailing tool call while keeping the real reply
      // prose, rather than denying and stranding the user's answer.
      if (text !== undefined) {
        const trailingLeak = stripTrailingLeakedToolCall(text)
        if (trailingLeak !== null && trailingLeak.text !== '') {
          logger.warn(
            formatChannelToolFailure('channel_reply', `stripped trailing_tool_call_leak tool=${trailingLeak.toolName}`),
          )
          text = trailingLeak.text
        }
      }

      if (keepTurnAlive && params.resolve_review_thread !== undefined) {
        const error =
          '`resolve_review_thread` is a terminal close-out decision and cannot be combined with ' +
          '`more_work_this_turn: true`. Send a status without the decision, then close out the thread in a terminal reply.'
        logger.warn(formatChannelToolFailure('channel_reply', error))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${error}` }],
          details: { ok: false, error },
        }
      }

      // Required-choice guard: a terminal github review-thread text reply must
      // make an explicit resolve_review_thread choice. The model kept silently
      // omitting the flag after acknowledging a fix, leaving the thread open;
      // forcing the choice (the discipline `continue` already enforces) closes
      // the loop where prose instructions did not. The field stays optional in
      // the schema precisely so omission is still detectable here (vs explicit
      // false). Runs before the resolve/guards so a missing choice never acts.
      const missingResolveChoice = missingReviewThreadResolveChoiceError({
        origin,
        text,
        moreWorkThisTurn: keepTurnAlive,
        resolveReviewThread: params.resolve_review_thread,
      })
      if (missingResolveChoice) {
        logger.warn(formatChannelToolFailure('channel_reply', missingResolveChoice))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${missingResolveChoice}` }],
          details: { ok: false, error: missingResolveChoice },
        }
      }

      // False-receipt guard: deny a terminal reply that CLAIMS a PR verdict /
      // thread close-out the agent never actually performed this turn. Warn-tier
      // claims fall through and have their notice appended on success below.
      const falseReceipt = checkFalseReceipt({
        sessionId,
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        text,
        moreWorkThisTurn: keepTurnAlive,
        resolveReviewThread: params.resolve_review_thread === true,
      })
      if (falseReceipt.kind === 'block') {
        logger.warn(formatChannelToolFailure('channel_reply', falseReceipt.reason))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${falseReceipt.reason}` }],
          details: { ok: false, error: falseReceipt.reason },
        }
      }
      const falseReceiptNotice = falseReceipt.kind === 'warn' ? falseReceipt.notice : null

      const completionClaim = checkCompletionClaim({
        text,
        qualifyingWorkObserved: router.hasQualifyingWorkThisLogicalTurn?.(origin) === true,
      })
      if (completionClaim.kind === 'block') {
        logger.warn(formatChannelToolFailure('channel_reply', completionClaim.reason))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${completionClaim.reason}` }],
          details: { ok: false, error: completionClaim.reason },
        }
      }
      const completionClaimNotice = completionClaim.kind === 'warn' ? completionClaim.notice : null

      // Re-review stranding guard: block a thread close-out / verdict ack while
      // the bot still holds its own CHANGES_REQUESTED on this PR, so it can't
      // silently leave the PR blocked (PR #644). Runs before the resolve so a
      // blocked close-out never mutates the thread.
      const rereview = await evaluateRereviewGuard({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        text,
        wantsResolve: params.resolve_review_thread === true,
        moreWorkThisTurn: keepTurnAlive,
        getReviewState: (req) => router.getReviewState(req),
        ...(origin.githubReviewRound !== undefined ? { round: origin.githubReviewRound } : {}),
      })
      if (rereview.block) {
        logger.warn(formatChannelToolFailure('channel_reply', rereview.reason))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${rereview.reason}` }],
          details: { ok: false, error: rereview.reason },
        }
      }

      // Resolve BEFORE posting: a successful channel_reply ends the turn, so a
      // resolve attempted "after" the ack would never run (the exact bug this
      // flag fixes). Resolve-failure blocks the reply so the agent never posts
      // a "looks resolved" ack next to a still-open thread; the router enforces
      // that only the bot's own threads can be resolved.
      let resolveMissNotice: string | null = null
      if (params.resolve_review_thread === true) {
        const resolve = await resolveReviewThreadBeforeReply(router, origin)
        if (resolve.kind === 'block') {
          logger.warn(formatChannelToolFailure('channel_reply', resolve.error))
          return {
            content: [{ type: 'text' as const, text: `channel_reply denied: ${resolve.error}` }],
            details: { ok: false, error: resolve.error },
          }
        }
        if (resolve.kind === 'already-resolved') {
          router.finishGithubReviewThreadCloseout?.({
            sessionId,
            workspace: origin.workspace,
            prNumber: parseGithubPrNumber(origin.chat),
            thread: origin.thread,
            decision: 'resolved',
          })
          return {
            content: [{ type: 'text' as const, text: alreadyResolvedHint(origin.thread) }],
            details: { ok: true, ...(keepTurnAlive ? { more_work_this_turn: true } : {}) },
          }
        }
        // `no-match` stays non-blocking (the thread may be genuinely gone) but
        // the resolve did NOT run, so tell the model instead of posting a clean
        // receipt that hides the miss. Mirrors channel_send.
        if (resolve.kind === 'no-match') {
          resolveMissNotice = resolveMissHint(origin.thread)
        } else {
          router.finishGithubReviewThreadCloseout?.({
            sessionId,
            workspace: origin.workspace,
            prNumber: parseGithubPrNumber(origin.chat),
            thread: origin.thread,
            decision: 'resolved',
          })
        }
      }

      const backgroundCoverage = (await router.captureBackgroundResultCoverage?.(sessionId)) ?? []
      const result = await router.send({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        ...(text !== undefined ? { text } : {}),
        ...(params.link_previews !== undefined ? { link_previews: params.link_previews } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      })

      if (!result.ok) {
        logger.warn(
          formatChannelToolFailure(
            'channel_reply',
            `${origin.adapter}:${origin.workspace}/${origin.chat}: ${result.error}`,
          ),
        )
      }
      if (
        result.ok &&
        params.resolve_review_thread === false &&
        origin.adapter === 'github' &&
        origin.thread !== null &&
        /^pr:\d+$/.test(origin.chat)
      ) {
        router.finishGithubReviewThreadCloseout?.({
          sessionId,
          workspace: origin.workspace,
          prNumber: parseGithubPrNumber(origin.chat),
          thread: origin.thread,
          decision: 'left-open',
        })
      }
      // `more_work_this_turn` is read by the router's terminal hook (installChannelReplyTerminalHook),
      // not by this tool — it suppresses the post-reply abort so a multi-step turn
      // keeps going. Success-only: a denied reply never ran, so there is no turn to keep.
      const details: {
        ok: boolean
        error?: string
        more_work_this_turn?: boolean
        messageId?: string
        messageIds?: readonly string[]
        backgroundCoverage?: BackgroundObligationRef[]
      } = result.ok
        ? {
            ok: true,
            backgroundCoverage,
            ...(keepTurnAlive ? { more_work_this_turn: true } : {}),
            ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
            ...(result.messageIds !== undefined ? { messageIds: result.messageIds } : {}),
          }
        : { ok: false, error: result.error }
      // Echo the delivered text back to the model. The adapter classifier
      // drops self-authored messages on the inbound path (`self_author`),
      // so the bot otherwise has ZERO visibility into what it just said —
      // not in the next iteration's context, not in later turns' history.
      // Without this echo, a model that splits a multi-part reply has no
      // way to tell "did I already send part 1?" from "I haven't started
      // yet", and routinely re-sends near-duplicates within the same turn
      // (observed in production: two consecutive identical greeting messages
      // to one prompt).
      //
      // The echo is the model's OWN words, which is uniquely seductive to
      // "reply" to, so on the success path we wrap the whole result in the
      // strong SYSTEM MESSAGE fence (`fenceToolResult`) rather than the weak
      // `[system: tool result...]` prefix — the prefix did not stop Kimi from
      // answering its own echo and looping (PR #481). Denials carry no echoed
      // prose (just machine error text), so they keep the lighter prefix.
      if (result.ok) {
        const echo = renderOutboundEcho(text, attachments)
        const receipt =
          `posted to ${origin.adapter}:${origin.workspace}/${origin.chat}: ${echo}` +
          (result.messageId !== undefined ? `\nmessage_id=${JSON.stringify(result.messageId)}` : '') +
          (result.messageIds !== undefined ? `\nmessage_ids=${JSON.stringify(result.messageIds)}` : '')
        const hint = consecutiveSendHint(
          router.getConsecutiveSendCount({
            adapter: origin.adapter,
            workspace: origin.workspace,
            chat: origin.chat,
            thread: origin.thread,
          }),
        )
        // Keep fenceToolResult here — do NOT "unify" the success branch back to
        // TOOL_RESULT_PREFIX to match the denial branch below. The prefix is
        // intentionally weaker and is safe ONLY because denials carry no echoed
        // prose; the success result does, and the weak prefix let Kimi loop.
        const warnings = [falseReceiptNotice, completionClaimNotice].filter(
          (notice): notice is string => notice !== null,
        )
        const warnNote = warnings.length > 0 ? fenceRuntimeNotice(warnings.join('\n\n')) : ''
        const missNote = resolveMissNotice ?? ''
        return {
          content: [{ type: 'text' as const, text: `${fenceToolResult(receipt)}${hint}${warnNote}${missNote}` }],
          details,
        }
      }
      return {
        content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}channel_reply denied: ${result.error}` }],
        details,
      }
    },
  })
}

function parseGithubPrNumber(chat: string): number {
  const match = /^pr:(\d+)$/.exec(chat)
  return match === null ? 0 : Number(match[1])
}

// Returns the denial string when a terminal github PR review-thread text reply
// omits an explicit resolve_review_thread choice, or '' when no choice is owed.
// Scoped by `^pr:\d+$` (not just thread !== null) so a future threaded github
// context can't be forced into a resolve choice that means nothing there.
function missingReviewThreadResolveChoiceError(input: {
  origin: ChannelReplyOrigin
  text: string | undefined
  moreWorkThisTurn: boolean
  resolveReviewThread: boolean | undefined
}): string {
  const isGithubPrReviewThread =
    input.origin.adapter === 'github' && /^pr:\d+$/.test(input.origin.chat) && input.origin.thread !== null
  const hasText = input.text !== undefined && input.text.trim() !== ''
  if (!isGithubPrReviewThread || !hasText || input.moreWorkThisTurn || input.resolveReviewThread !== undefined) {
    return ''
  }
  return (
    'This is a terminal github PR review-thread reply with text, so `resolve_review_thread` is required: ' +
    'set it to `true` when the concern is fixed and this bot-authored thread should be closed (the runtime ' +
    'resolves before posting and only on your own thread), or `false` to leave it open. You omitted it; ' +
    're-call channel_reply with an explicit boolean.'
  )
}

// `block` when the resolve should stop the reply, `no-match` when the thread is
// gone (non-blocking — the reply posts but the caller warns), `resolved` on
// success. Every hard failure — wrong author, permission denial, HTTP 404 on a
// misdirected lookup, transient API error — blocks, so the agent never claims a
// thread is settled when the resolve did not actually run.
type ResolveOutcome =
  | { kind: 'resolved' }
  | { kind: 'already-resolved' }
  | { kind: 'no-match' }
  | { kind: 'block'; error: string }

async function resolveReviewThreadBeforeReply(
  router: ChannelRouter,
  origin: ChannelReplyOrigin,
): Promise<ResolveOutcome> {
  if (origin.adapter !== 'github') {
    return { kind: 'block', error: 'resolve_review_thread is only supported on github sessions.' }
  }
  if (origin.thread === null) {
    return {
      kind: 'block',
      error: 'resolve_review_thread requires replying inside a review thread (no thread on this origin).',
    }
  }
  const result = await router.resolveReviewThread({
    adapter: origin.adapter,
    workspace: origin.workspace,
    chat: origin.chat,
    rootCommentId: origin.thread,
  })
  if (result.ok) return { kind: result.alreadyResolved === true ? 'already-resolved' : 'resolved' }
  if (result.code === 'no-match') return { kind: 'no-match' }
  return { kind: 'block', error: `could not resolve review thread: ${result.error}` }
}

function alreadyResolvedHint(thread: string | null): string {
  return fenceRuntimeNotice(
    `review thread ${JSON.stringify(thread)} was already resolved; no acknowledgement comment was posted.`,
  )
}

// The model asked to resolve but no thread was rooted at this comment. Fenced
// as a runtime notice (not chat prose) so a persona-rich model reads it as
// tool feedback and re-targets, rather than replying to it in-character.
function resolveMissHint(thread: string | null): string {
  return fenceRuntimeNotice(
    `you set resolve_review_thread but no unresolved review thread is rooted at comment ${JSON.stringify(thread)} — ` +
      `your reply posted, but that thread was not resolved (it may be already gone, or the thread id is stale). ` +
      `If a thread should still close, resolve it on the correct thread.`,
  )
}

// Tool results reach the model as USER-role messages (OpenAI / Anthropic
// tool-API contract — the engine cannot tag them as system). Without this
// marker a persona-rich model reads its own echo as a fresh user inbound
// and replies to itself. Observed in production: Kimi K2 on KakaoTalk
// re-invoked after a successful send saw only the echo as new context
// and hallucinated a goodbye trigger from it. Mirrored verbatim in
// channel-send.ts so both tools share one greppable marker.
export const TOOL_RESULT_PREFIX = '[system: tool result, not a user message] '

export const ECHO_MAX_CHARS = 500

export function renderEcho(text: string): string {
  if (text.length <= ECHO_MAX_CHARS) return JSON.stringify(text)
  return `${JSON.stringify(text.slice(0, ECHO_MAX_CHARS))}... (${text.length} chars total)`
}

// DO NOT remove this echo or replace it with a hash/length-only "receipt" to
// stop the self-reply loop (PR #481). That trade was tried and rejected: the
// echo is the model's only view of what it already said (the inbound path
// drops self-authored messages), so without the FULL text a split reply
// re-sends near-duplicates — the exact bug 58c62c1 added the echo to fix, and
// a fingerprint cannot catch paraphrased near-dupes. The loop is solved by
// FENCING this echo (see fenceToolResult call site below), not by removing it.
export function renderOutboundEcho(
  text: string | undefined,
  attachments: ReadonlyArray<{ path: string; filename?: string }> | undefined,
): string {
  const hasText = text !== undefined && text !== ''
  const hasAttachments = attachments !== undefined && attachments.length > 0
  if (hasText && hasAttachments) {
    const filenames = attachments.map((a) => a.filename ?? a.path.split('/').pop() ?? a.path)
    return `${renderEcho(text)} + ${attachments.length} file(s): ${filenames.join(', ')}`
  }
  if (hasText) return renderEcho(text)
  if (hasAttachments) {
    const filenames = attachments.map((a) => a.filename ?? a.path.split('/').pop() ?? a.path)
    return `${attachments.length} file(s): ${filenames.join(', ')}`
  }
  return '(empty)'
}

// Mirror of the same guard used by channel_send. Blocks any silent-turn
// signal (per `isNoReplySignal`) from being sent as a message body — same
// misuse, same denial, regardless of which sending tool the model picked.
// Returns '' when text is undefined (attachments-only reply, can't be
// misusing the signal) or when text is non-empty and not a signal.
function noReplyMisuseError(text: string | undefined): string {
  if (text === undefined) return ''
  if (text.trim() === '') return ''
  if (!isNoReplySignal(text)) return ''
  return (
    '`NO_REPLY` is the silent-turn signal, not a message body. ' +
    'To stay silent, end your turn with `NO_REPLY` as your entire visible response and NO channel tool call. ' +
    'To send an actual reply, call this tool again with different text.'
  )
}

// Mirror of the same guard used by channel_send. Blocks the upstream
// `(Empty response: ...)` debug sentinel from being sent verbatim — that
// payload carries the model's thinking content and signature, never a
// real user-facing message.
function upstreamEmptyResponseSentinelError(text: string | undefined): string {
  if (text === undefined) return ''
  if (!isUpstreamEmptyResponseSentinel(text)) return ''
  return (
    'refusing to forward an upstream `(Empty response: ...)` sentinel; ' +
    "that string is a provider-SDK debug dump containing the model's thinking content and signature, " +
    'not a message body. End your turn silently (visible text empty or `NO_REPLY`) instead.'
  )
}

function kimiToolCallLeakError(text: string | undefined): string {
  if (text === undefined) return ''
  if (!containsKimiToolDelimiter(text)) return ''
  return (
    'refusing to forward raw provider tool-call control tokens; these are chat-template ' +
    'delimiters that should have been parsed into a real tool call upstream. ' +
    'Re-issue the intended channel reply as plain user-visible text only.'
  )
}

// Mirror of the same hint used by channel_send. Kept identical so the model
// sees the same yield signal regardless of which tool it picked. The body
// is wrapped via `fenceRuntimeNotice` (in `./runtime-notice`) so persona-rich
// models cannot read the trailing prose as a chat instruction and reply to
// it in-character. See that helper's comment for the failure mode that
// motivated the framing.
function consecutiveSendHint(countAfterSend: number): string {
  if (countAfterSend <= 1) return ''
  const body =
    countAfterSend === 2
      ? 'this is your 2nd consecutive message in this conversation; continue only if the reply genuinely needs splitting.'
      : `${countAfterSend}th consecutive message with no user reply; end your turn now unless the user explicitly asked for a multi-step response.`
  return fenceRuntimeNotice(body)
}
