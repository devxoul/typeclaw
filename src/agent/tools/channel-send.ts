import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import { checkFalseReceipt } from '@/channels/github-false-receipt'
import { evaluateRereviewGuard } from '@/channels/github-rereview-guard'
import { recordResolvedThread } from '@/channels/github-review-turn-ledger'
import {
  containsKimiToolDelimiter,
  isNoReplySignal,
  isUpstreamEmptyResponseSentinel,
  stripTrailingLeakedToolCall,
  type ChannelRouter,
} from '@/channels/router'
import { ADAPTER_IDS, type AdapterId } from '@/channels/schema'
import type { GithubReviewFollowupRound } from '@/channels/types'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { renderOutboundEcho, TOOL_RESULT_PREFIX } from './channel-reply'
import { fenceRuntimeNotice, fenceToolResult } from './runtime-notice'

export type ChannelSendOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  githubReviewRound?: GithubReviewFollowupRound
}

export type CreateChannelSendToolOptions = {
  router: ChannelRouter
  // Optional channel origin for the session this tool is wired into. When
  // present, the tool can detect "you posted to the same conversation but
  // dropped the thread" and surface that as a hint in the tool result, so
  // the model can self-correct on its next turn. Absent for sessions whose
  // origin isn't a channel (e.g. cron prompts that send to channels).
  origin?: ChannelSendOrigin
  // Scopes the per-turn false-receipt ledger for github resolve close-outs.
  // Defaults to '' when absent (cron / non-channel sessions); the guard then
  // finds no recorded action and falls back to its safe default.
  sessionId?: string
  logger?: ChannelToolLogger
}

export function createChannelSendTool({
  router,
  origin,
  sessionId = '',
  logger = consoleChannelLogger,
}: CreateChannelSendToolOptions) {
  return defineTool({
    name: 'channel_send',
    label: 'Channel Send',
    description:
      'Post a message to an external messenger channel. Specify adapter, workspace, chat, and text. ' +
      'For Discord guild channels, workspace is the guild id; for Slack team channels, workspace is ' +
      'the team id (e.g. "T0ACME"). For DMs on either platform, workspace is the literal "@dm". ' +
      'On failure (no adapter registered, or the adapter-level send failed), the call returns ' +
      '{ ok: false, error }. On success it returns { ok: true } and, when reported, `messageId` ' +
      '(an adapter-reported id of a posted message) and `messageIds` (reported posted-message ids in ' +
      'send order). To continue the same conversation, reuse its existing `thread`/root coordinates ' +
      'or use `channel_reply`. A returned id starts a thread only where the adapter accepts a message ' +
      'id as `thread` (e.g. a new top-level Slack post); other adapters use different thread ids. ' +
      'Some adapters do not report ids. ' +
      'There is no auto-reply: the only way for an agent to post is via this tool.',
    parameters: Type.Object({
      adapter: Type.Union(
        ADAPTER_IDS.map((a) => Type.Literal(a)),
        { description: 'Adapter id. Supported: "discord-bot", "slack-bot".' },
      ),
      workspace: Type.String({
        description:
          'Discord guild id or Slack team id (e.g. "T0ACME"); use "@dm" for direct-message channels on either platform.',
        minLength: 1,
      }),
      chat: Type.String({
        description:
          'Channel id. Discord channel id (numeric snowflake) or Slack channel id (e.g. "C0CHANNEL", "D0DMID").',
        minLength: 1,
      }),
      thread: Type.Optional(
        Type.String({
          description:
            'Optional thread id. For Discord, the thread channel id. For Slack, the parent message thread_ts.',
          minLength: 1,
        }),
      ),
      text: Type.Optional(
        Type.String({
          description:
            'The message body. Use Discord syntax `<@USER_ID>` for Discord mentions or Slack syntax `<@USER_ID>` for Slack mentions (Slack user ids start with "U"). Optional only when `attachments` is set; one of `text` or `attachments` must be present.',
          minLength: 1,
        }),
      ),
      link_previews: Type.Optional(
        Type.Boolean({
          description:
            'Set false to suppress link/media previews on Slack bot and Telegram bot text posts. True or omitted preserves platform defaults. Ignored on other adapters. Slack file-upload captions are not covered.',
        }),
      ),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({
              description:
                'Absolute path inside the agent container to the file to upload (e.g. "/agent/workspace/report.pdf"). The runtime reads the file just before the API call.',
              minLength: 1,
            }),
            filename: Type.Optional(
              Type.String({
                description:
                  'Filename to display in the chat. Defaults to the basename of `path`. Useful when the on-disk name carries a tempdir suffix the user should not see.',
                minLength: 1,
              }),
            ),
          }),
          {
            description:
              "Optional files to upload alongside the text. Slack: `text` is sent as the first file's caption (single Slack message). Discord: each file is uploaded individually (no caption support upstream), then `text` is posted as a separate message; uploads land in the channel root even when `thread` is set.",
            minItems: 1,
          },
        ),
      ),
      resolve_review_thread: Type.Optional(
        Type.Boolean({
          description:
            'GitHub review threads ONLY — ignored on every other adapter and on a github send that has no `thread`. ' +
            'Set `true` to close out a review thread you authored once you have confirmed the new commits address your concern: pass the thread\'s root comment id as `thread`, an acknowledgement (e.g. "addressed in <sha> — resolving") as `text`, and this flag. ' +
            'This is the post-push close-out path: a `pull_request.synchronize` recheck lists your unresolved threads, and you call this once per addressed thread. ' +
            "Safe by default — the runtime resolves BEFORE posting and ONLY if the thread's root comment is yours, refusing (and blocking the send) on a human reviewer's thread. " +
            'REQUIRED on a github PR review-thread send that has both a `thread` and `text`: pass `false` to post your reply while keeping the thread open (not addressed, partial fix, disagreement) — omitting it there is denied. Outside that scope (no `thread`, no `text`, or a non-github adapter) it may be left unset.',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const adapter = params.adapter as AdapterId
      let bodyText = params.text
      const attachments = params.attachments
      if ((bodyText === undefined || bodyText === '') && (attachments === undefined || attachments.length === 0)) {
        logger.warn(formatChannelToolFailure('channel_send', 'missing text and attachments'))
        return {
          content: [
            { type: 'text' as const, text: 'channel_send denied: must provide `text`, `attachments`, or both.' },
          ],
          details: { ok: false, error: 'missing text and attachments' },
        }
      }

      const noReplyError = noReplyMisuseError(bodyText)
      if (noReplyError) {
        logger.warn(formatChannelToolFailure('channel_send', noReplyError))
        return {
          content: [{ type: 'text' as const, text: `channel_send denied: ${noReplyError}` }],
          details: { ok: false, error: noReplyError },
        }
      }

      const upstreamSentinelError = upstreamEmptyResponseSentinelError(bodyText)
      if (upstreamSentinelError) {
        logger.warn(formatChannelToolFailure('channel_send', upstreamSentinelError))
        return {
          content: [{ type: 'text' as const, text: `channel_send denied: ${upstreamSentinelError}` }],
          details: { ok: false, error: upstreamSentinelError },
        }
      }

      const kimiLeakError = kimiToolCallLeakError(bodyText)
      if (kimiLeakError) {
        logger.warn(formatChannelToolFailure('channel_send', kimiLeakError))
        return {
          content: [{ type: 'text' as const, text: `channel_send denied: ${kimiLeakError}` }],
          details: { ok: false, error: kimiLeakError },
        }
      }

      // Prose-then-trailing-call leak (mirrors router.ts validateChannelTurn):
      // the model put a real reply plus a serialized trailing tool call in the
      // `text` arg. Strip the plumbing and keep the prose rather than denying,
      // so the legitimate reply still reaches the channel. Whole-message calls
      // (no prose prefix) are untouched here and left to the router's recovery.
      if (bodyText !== undefined) {
        const trailingLeak = stripTrailingLeakedToolCall(bodyText)
        if (trailingLeak !== null && trailingLeak.text !== '') {
          logger.warn(
            formatChannelToolFailure('channel_send', `stripped trailing_tool_call_leak tool=${trailingLeak.toolName}`),
          )
          bodyText = trailingLeak.text
        }
      }

      // Required-choice guard (mirrors channel_reply): a github PR review-thread
      // send with text must make an explicit resolve_review_thread choice. The
      // `pull_request.synchronize` recheck routes the post-push close-out HERE
      // via channel_send, and the model kept acknowledging "addressed" without
      // the flag, stranding the thread — channel_reply forced the choice but
      // channel_send did not, so the most-used resolve path was the least
      // guarded. A send is always terminal, so there is no more-work exemption.
      const missingResolveChoice = missingReviewThreadResolveChoiceError({
        adapter,
        chat: params.chat,
        thread: params.thread ?? null,
        text: bodyText,
        resolveReviewThread: params.resolve_review_thread,
      })
      if (missingResolveChoice) {
        logger.warn(formatChannelToolFailure('channel_send', missingResolveChoice))
        return {
          content: [{ type: 'text' as const, text: `channel_send denied: ${missingResolveChoice}` }],
          details: { ok: false, error: missingResolveChoice },
        }
      }

      const wantsResolve = params.resolve_review_thread === true
      const falseReceipt = checkFalseReceipt({
        sessionId,
        adapter,
        workspace: params.workspace,
        chat: params.chat,
        thread: params.thread ?? null,
        text: bodyText,
        moreWorkThisTurn: false,
        resolveReviewThread: wantsResolve,
      })
      if (falseReceipt.kind === 'block') {
        logger.warn(formatChannelToolFailure('channel_send', falseReceipt.reason))
        return {
          content: [{ type: 'text' as const, text: `channel_send denied: ${falseReceipt.reason}` }],
          details: { ok: false, error: falseReceipt.reason },
        }
      }
      const falseReceiptNotice = falseReceipt.kind === 'warn' ? falseReceipt.notice : null

      // Re-review stranding guard (mirrors channel_reply): block a thread
      // close-out / verdict ack while the bot still holds its own
      // CHANGES_REQUESTED on this PR, before the resolve mutates the thread.
      const rereview = await evaluateRereviewGuard({
        adapter,
        workspace: params.workspace,
        chat: params.chat,
        thread: params.thread ?? null,
        text: bodyText,
        wantsResolve,
        moreWorkThisTurn: false,
        getReviewState: (req) => router.getReviewState(req),
        ...(origin !== undefined &&
        origin.adapter === adapter &&
        origin.workspace === params.workspace &&
        origin.chat === params.chat &&
        origin.thread === (params.thread ?? null) &&
        origin.githubReviewRound !== undefined
          ? { round: origin.githubReviewRound }
          : {}),
      })
      if (rereview.block) {
        logger.warn(formatChannelToolFailure('channel_send', rereview.reason))
        return {
          content: [{ type: 'text' as const, text: `channel_send denied: ${rereview.reason}` }],
          details: { ok: false, error: rereview.reason },
        }
      }

      // Resolve BEFORE posting (mirrors channel_reply): a failed resolve must
      // block the acknowledgement so the bot never posts "addressed — resolving"
      // next to a still-open thread. The router enforces that only the bot's own
      // threads can be resolved.
      let resolveMissNotice: string | null = null
      if (wantsResolve) {
        const resolve = await resolveReviewThreadBeforeSend(router, {
          adapter,
          workspace: params.workspace,
          chat: params.chat,
          thread: params.thread ?? null,
        })
        if (resolve.kind === 'block') {
          logger.warn(formatChannelToolFailure('channel_send', resolve.error))
          return {
            content: [{ type: 'text' as const, text: `channel_send denied: ${resolve.error}` }],
            details: { ok: false, error: resolve.error },
          }
        }
        if (resolve.kind === 'already-resolved') {
          router.finishGithubReviewThreadCloseout?.({
            sessionId,
            workspace: params.workspace,
            prNumber: parseGithubPrNumber(params.chat),
            thread: params.thread ?? null,
            decision: 'resolved',
          })
          return {
            content: [{ type: 'text' as const, text: alreadyResolvedHint(params.thread ?? null) }],
            details: { ok: true },
          }
        }
        // `no-match`: the thread listed cleanly but nothing is rooted at this
        // comment (gone, or a mispaired id from the bare-id follow-up list). It
        // stays non-blocking so a genuinely-deleted thread's ack still posts,
        // but the resolve did NOT happen — surface it so the model re-targets,
        // and skip the ledger so a phantom resolution can't suppress this
        // thread on a later sweep.
        if (resolve.kind === 'no-match') {
          resolveMissNotice = resolveMissHint(params.thread ?? null)
        } else {
          recordResolvedThreadFromSend(sessionId, params.workspace, params.chat, params.thread ?? null)
          router.finishGithubReviewThreadCloseout?.({
            sessionId,
            workspace: params.workspace,
            prNumber: parseGithubPrNumber(params.chat),
            thread: params.thread ?? null,
            decision: 'resolved',
          })
        }
      }

      const result = await router.send({
        adapter,
        workspace: params.workspace,
        chat: params.chat,
        ...(params.thread !== undefined ? { thread: params.thread } : {}),
        ...(bodyText !== undefined ? { text: bodyText } : {}),
        ...(params.link_previews !== undefined ? { link_previews: params.link_previews } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      })

      if (!result.ok) {
        logger.warn(
          formatChannelToolFailure(
            'channel_send',
            `${params.adapter}:${params.workspace}/${params.chat}: ${result.error}`,
          ),
        )
      }
      if (
        result.ok &&
        params.resolve_review_thread === false &&
        adapter === 'github' &&
        params.thread != null &&
        /^pr:\d+$/.test(params.chat)
      ) {
        router.finishGithubReviewThreadCloseout?.({
          sessionId,
          workspace: params.workspace,
          prNumber: parseGithubPrNumber(params.chat),
          thread: params.thread ?? null,
          decision: 'left-open',
        })
      }
      const details: { ok: boolean; error?: string; messageId?: string; messageIds?: readonly string[] } = result.ok
        ? {
            ok: true,
            ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
            ...(result.messageIds !== undefined ? { messageIds: result.messageIds } : {}),
          }
        : { ok: false, error: result.error }
      // Success wraps the echoed sent text in the strong SYSTEM MESSAGE fence;
      // denials keep the lighter prefix. See channel-reply.ts for the full
      // rationale (PR #481 self-reply loop).
      if (result.ok) {
        const echo = renderOutboundEcho(bodyText, attachments)
        const receipt =
          `posted to ${params.adapter}:${params.workspace}/${params.chat}: ${echo}` +
          (result.messageId !== undefined ? `\nmessage_id=${JSON.stringify(result.messageId)}` : '') +
          (result.messageIds !== undefined ? `\nmessage_ids=${JSON.stringify(result.messageIds)}` : '')
        const hints: string[] = []
        const consecutive = consecutiveSendHint(
          router.getConsecutiveSendCount({
            adapter,
            workspace: params.workspace,
            chat: params.chat,
            thread: params.thread ?? null,
          }),
        )
        if (consecutive) hints.push(consecutive)

        const threadMismatch = threadMismatchHint(origin, {
          adapter,
          workspace: params.workspace,
          chat: params.chat,
          thread: params.thread,
        })
        if (threadMismatch) hints.push(threadMismatch)

        if (falseReceiptNotice !== null) hints.push(fenceRuntimeNotice(falseReceiptNotice))

        if (resolveMissNotice !== null) hints.push(resolveMissNotice)

        return {
          content: [{ type: 'text' as const, text: `${fenceToolResult(receipt)}${hints.join('')}` }],
          details,
        }
      }
      return {
        content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}channel_send denied: ${result.error}` }],
        details,
      }
    },
  })
}

function parseGithubPrNumber(chat: string): number {
  const match = /^pr:(\d+)$/.exec(chat)
  return match === null ? 0 : Number(match[1])
}

function missingReviewThreadResolveChoiceError(input: {
  adapter: AdapterId
  chat: string
  thread: string | null
  text: string | undefined
  resolveReviewThread: boolean | undefined
}): string {
  const isGithubPrReviewThread = input.adapter === 'github' && /^pr:\d+$/.test(input.chat) && input.thread !== null
  const hasText = input.text !== undefined && input.text.trim() !== ''
  if (!isGithubPrReviewThread || !hasText || input.resolveReviewThread !== undefined) {
    return ''
  }
  return (
    'This is a github PR review-thread send with text, so `resolve_review_thread` is required: ' +
    'set it to `true` when the concern is fixed and this bot-authored thread should be closed (the runtime ' +
    'resolves before posting and only on your own thread), or `false` to leave it open. You omitted it; ' +
    're-call channel_send with an explicit boolean.'
  )
}

type ResolveOutcome =
  | { kind: 'resolved' }
  | { kind: 'already-resolved' }
  | { kind: 'no-match' }
  | { kind: 'block'; error: string }

async function resolveReviewThreadBeforeSend(
  router: ChannelRouter,
  target: { adapter: AdapterId; workspace: string; chat: string; thread: string | null },
): Promise<ResolveOutcome> {
  if (target.adapter !== 'github') {
    return { kind: 'block', error: 'resolve_review_thread is only supported on github sends.' }
  }
  if (target.thread === null) {
    return { kind: 'block', error: 'resolve_review_thread requires a `thread` (the review thread root comment id).' }
  }
  const result = await router.resolveReviewThread({
    adapter: target.adapter,
    workspace: target.workspace,
    chat: target.chat,
    rootCommentId: target.thread,
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
      `your reply posted, but that thread was not resolved (it may be already gone, or you passed the wrong root ` +
      `comment id). If a different thread should close, re-call channel_send with the correct \`thread\`.`,
  )
}

function recordResolvedThreadFromSend(sessionId: string, workspace: string, chat: string, thread: string | null): void {
  if (thread === null) return
  const m = /^pr:(\d+)$/.exec(chat)
  if (m === null) return
  const prNumber = Number(m[1])
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return
  recordResolvedThread({ sessionId, workspace, prNumber, rootCommentId: thread })
}

// Returns a behavioral hint when the model posted to the SAME conversation
// as the session's origin (same adapter+workspace+chat) but DROPPED the
// thread. This catches the "model forgot to copy thread verbatim" failure
// mode without blocking legitimate intent — if leaving the thread was on
// purpose (e.g. "let's start in a new thread"), the model can ignore this hint; if it
// wasn't, the next channel_send (or channel_reply) can correct course.
//
// Only fires when the origin had a thread to begin with — channel-root
// sessions can't have a "missing thread" problem.
//
// Body is fenced via `fenceRuntimeNotice` for the same reason the
// consecutive-send hint is — see that helper's comment for the failure
// mode (Kimi-K2.x reading trailing tool-result prose as a chat instruction
// and replying to it in-character).
function threadMismatchHint(
  origin: ChannelSendOrigin | undefined,
  sent: { adapter: AdapterId; workspace: string; chat: string; thread: string | undefined },
): string {
  if (!origin) return ''
  if (origin.thread === null) return ''
  if (sent.thread !== undefined) return ''
  if (origin.adapter !== sent.adapter) return ''
  if (origin.workspace !== sent.workspace) return ''
  if (origin.chat !== sent.chat) return ''
  return fenceRuntimeNotice(
    `note: this session's origin thread is ${JSON.stringify(origin.thread)} but you posted to channel root. ` +
      `if breaking out of the thread was intentional, ignore this; otherwise prefer \`channel_reply\` ` +
      `or pass \`thread: ${JSON.stringify(origin.thread)}\` on your next channel_send.`,
  )
}

// Blocks a specific misuse: the model tried to send a silent-turn signal
// (e.g. `NO_REPLY`, `(NO_REPLY)`) as a channel message. Those forms belong
// in the model's *visible response* when no channel tool is called (see
// session-origin.ts and router.ts validateChannelTurn), NOT in the body of
// a sent message. We short-circuit BEFORE router.send so the signal never
// reaches the chat. Detection delegates to `isNoReplySignal` so the router
// and both tools stay in lockstep. Empty/undefined text is fine — that
// means "attachments-only send", not a signal.
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

// Defense-in-depth mirror of the recovery-path guard in router.ts. Blocks
// the upstream "(Empty response: {...})" sentinel from being sent verbatim
// as a channel message — the body of that sentinel carries the model's
// thinking content and Anthropic's tamper-proof signature, which must
// never reach a channel reader. Shape detection lives in
// `isUpstreamEmptyResponseSentinel` so all call sites stay in lockstep.
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
    'Re-issue the intended channel send as plain user-visible text only.'
  )
}

// Returns a behavioral hint to nudge the model toward yielding when it has
// been the only voice in the conversation for several messages. The router
// increments its counter AFTER router.send returns, so a count of 1 means
// "this is the second consecutive bot message in this chat:thread" — which
// is the first count where a hint is warranted. Empty string at count <= 1
// preserves the original tool-result text for the common single-reply case.
// Mirror of channel-reply.ts; body wrapped via `fenceRuntimeNotice`.
function consecutiveSendHint(countAfterSend: number): string {
  if (countAfterSend <= 1) return ''
  const body =
    countAfterSend === 2
      ? 'this is your 2nd consecutive message in this conversation; continue only if the reply genuinely needs splitting.'
      : `${countAfterSend}th consecutive message with no user reply; end your turn now unless the user explicitly asked for a multi-step response.`
  return fenceRuntimeNotice(body)
}
