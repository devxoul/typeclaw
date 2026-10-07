import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename } from 'node:path'

import { createAssistantMessageEventStream, type AssistantMessage, type ToolResultMessage } from '@earendil-works/pi-ai'
import { type SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'

import { createSession, renderTurnRoleAnchor, renderTurnTimeAnchor, type AgentSession } from '@/agent'
import { applyTurnThinkingLevel, getQuestionSignal, type QuestionSignal } from '@/agent/attention-escalation'
import { resolveFallbackChain } from '@/agent/model-fallback'
import { applyModelRuntimeOverrides } from '@/agent/model-overrides'
import { forgetSharedLoopGuardTool } from '@/agent/plugin-tools'
import { detectHardProviderError, isFailoverWorthy, subscribeProviderErrors } from '@/agent/provider-error'
import type { RestartHandoff } from '@/agent/restart-handoff'
import type { ChannelParticipant, SessionOrigin } from '@/agent/session-origin'
import { renderSubagentCompletionReminder } from '@/agent/subagent-completion-reminder'
import {
  armRestartKickForOrigin,
  clearAbortSuppressionForOrigin,
  extractTurnUsage,
  markRestartAbortPendingForOrigin,
  recordTurnOutcome,
  recordTurnStart,
  runIdleContinuation,
} from '@/agent/todo/continuation-wiring'
import { defuseRuntimeMarkers } from '@/agent/tools/runtime-notice'
import { SUBAGENT_OUTPUT_TOOL_NAME } from '@/agent/tools/subagent-output'
import { promptPersistentTurnWithFallback } from '@/agent/turn-runner'
import { type Command, type CommandPermission, type CommandResult, createCommandRegistry } from '@/commands'
import { getConfig, resolveModel } from '@/config'
import { CORE_PERMISSIONS, type PermissionService } from '@/permissions'
import type { HookBus } from '@/plugin'
import { extractClaimCode } from '@/role-claim'
import type { Stream } from '@/stream'

import { extractMentionedUserIds } from './adapters/mention-hints'
import {
  BackgroundObligationStore,
  type BackgroundObligation,
  type BackgroundObligationRef,
} from './background-obligations'
import { formatChannelCommandHelp } from './commands'
import { isQualifyingWorkResult } from './completion-claim'
import { detectContinuationWillingness } from './continuation-willingness'
import type { RecoveryFailure, RecoveryRecord } from './continuity-types'
import { describeError } from './describe-error'
import {
  countEffectiveHumans,
  decideEngagement,
  grantStickyForReplyTargets,
  isMultiHumanGroup,
  StickyLedger,
  type EngagementDecision,
} from './engagement'
import { checkFalseReceipt } from './github-false-receipt'
import { githubReviewerWorkKey } from './github-repo'
import { evaluateRereviewGuard } from './github-rereview-guard'
import { resetReviewTurn, type ReviewOutputState, type ReviewRoundOutcome } from './github-review-turn-ledger'
import {
  canPromoteGithubReviewRoundTo,
  abortGithubReviewStateForPr,
  completeGithubReviewRound,
  forgetGithubReviewRound,
  githubReviewRoundKey,
  githubReviewRoundPersistence,
  hasGithubReviewRoundDismissalAttempt,
  isGithubReviewRoundComplete,
  isGithubReviewRoundPending,
  isGithubReviewRoundSuperseded,
  promoteGithubReviewRound,
  registerGithubReviewRound,
  restoreGithubReviewRound,
  resetGithubReviewRoundCompletion,
  resetGithubReviewRoundCompletionForPr,
  validateGithubReviewRound,
} from './github-review-verdict-coordinator'
import { renderPrVerdictStandDownReminder } from './github-verdict-activity'
import { InboundJournal, type InboundRef } from './inbound-journal'
import {
  MEMBERSHIP_COLD_FETCH_TIMEOUT_MS,
  type MembershipCount,
  type MembershipResolver,
  type MembershipResolverResult,
} from './membership'
import { createMembershipCache, type MembershipCache } from './membership-cache'
import { checkOutboundFlood } from './outbound-flood-filter'
import { updateParticipants } from './participants'
import {
  channelsSessionsPath,
  findRecord,
  loadChannelSessions,
  saveChannelSessions,
  type ChannelSessionRecord,
} from './persistence'
import { recoveryNoticePartitionKey } from './recovery-notice'
import { RecoveryOutbox } from './recovery-outbox'
import {
  ADAPTER_READ_CAPABILITIES,
  ADAPTER_WRITE_CAPABILITIES,
  QUOTED_REPLY_EXCERPT_MAX_CHARS,
  type AdapterId,
  type ChannelAdapterConfig,
  type ReadCapability,
  type WriteCapability,
} from './schema'
import type {
  ChannelHistoryMessage,
  ChannelKey,
  ChannelNameResolver,
  ChannelSelfIdentity,
  ChannelSelfIdentityResolver,
  EditMessageCallback,
  EditMessageRequest,
  EditMessageResult,
  FetchAttachmentArgs,
  FetchAttachmentCallback,
  FetchAttachmentResult,
  FetchHistoryArgs,
  FetchHistoryResult,
  GetMessageArgs,
  GetMessageResult,
  HistoryCallback,
  InboundAttachment,
  GithubReviewFollowupRound,
  GithubReviewThreadCloseout,
  InboundMessage,
  RouteReceipt,
  InboundReferenceContext,
  ListCallback,
  ListChannelsArgs,
  ListChannelsResult,
  MessageGetCallback,
  RemoveReactionCallback,
  RemoveReactionRequest,
  OwnReactionTarget,
  PrepareOwnReactionCallback,
  RemoveOwnReactionCallback,
  RemoveOwnReactionRequest,
  RemoveOwnReactionResult,
  OutboundCallback,
  OutboundMessage,
  QuoteAnchorSource,
  ReactionCallback,
  ReactionRef,
  ReactionRequest,
  ReactionResult,
  ResolvedChannelNames,
  ReviewSubmitter,
  ReviewStateRequest,
  ReviewStateResolver,
  ReviewStateResult,
  ReviewThreadResolveRequest,
  ReviewThreadResolveResult,
  ReviewThreadResolver,
  SendErrorCode,
  SendResult,
  SubmitReviewRequest,
  SubmitReviewResult,
  TypingCallback,
} from './types'
import { channelKeyId, fallbackChannelAccountIdentity } from './types'
import type { RecoveryAdapterCallbacks, RecoveryReconcileResult, SendOptions as TransportSendOptions } from './types'
import { createWaitingReactionCoordinator, type WaitingReactionHandle } from './waiting-reactions'

export const INITIAL_DEBOUNCE_MS = 600
export const HOT_DEBOUNCE_MS = 1500
export const MAX_DEBOUNCE_MS = 4000
export const HOT_THRESHOLD_MS = 3000
export const MAX_CONSECUTIVE_ABORTS = 3
export const CONTEXT_BUFFER_SIZE = 20
// Observed ("Recent context") messages are awareness-only and replayed in full
// on every turn (uncached), so one long paste would otherwise re-bloat every
// subsequent turn until it ages out. Cap each observed message's text; the
// addressed current message is never capped (it's the actual request).
export const OBSERVED_MESSAGE_MAX_CHARS = 800
// A bare @mention (no text of its own) is a "wake up and look" ping, not a
// question — the user is signalling that a recent un-responded message is what
// they want a reply to. The wake-request nudge only fires when such a ping
// lands within this window of a recent observed message, so a mention that
// arrives long after the channel went quiet does not misread stale scrollback
// as the thing to answer.
export const WAKE_REQUEST_LOOKBACK_MS = 60_000
// Discord's typing indicator expires after ~10s; an 8s heartbeat keeps it
// continuously visible while we debounce + generate without spamming the API.
// This is the default; an adapter whose platform expires the indicator sooner
// registers a shorter interval via `setTypingHeartbeatInterval` (e.g. KakaoTalk
// auto-expires after ~5s) so the router itself paces the refresh — the adapter
// callback stays stateless instead of running its own timer.
export const TYPING_HEARTBEAT_MS = 8000
// A stuck model call or an agent that never yields should not keep re-arming
// platform-side typing forever. Slack Assistant status in particular has a
// documented 2-minute timeout, so repeatedly refreshing it after that point
// turns a temporary status into a permanent-looking artifact.
//
// The cap is measured from `live.typingStartedAt`, which is refreshed by
// these signals of life (see `bumpTypingActivity`):
//   1. Each new `drain()` iteration (a new turn is starting).
//   2. Each `tool_execution_end` from the agent session (a tool just
//      completed — the prompt is progressing, not stuck).
//   3. Each streaming token (`message_update` carrying a `text_delta` or
//      `thinking_delta`) — the model is actively generating, even on a
//      pure-text reply that calls no tools.
// Signal 3 is what keeps a long conversational reply (no tool calls, just
// minutes of streamed text or extended thinking) under the cap: without it,
// such a turn emits no `tool_execution_end` and the indicator was paused
// mid-generation. A genuinely stuck model call — no tokens, no tools — still
// trips the cap. The cap exists to catch *silence*, not duration.
export const MAX_TYPING_HEARTBEAT_MS = 2 * 60 * 1000

// Idle GC: a LiveSession whose `lastInboundAt` is older than
// SESSION_IDLE_MS gets evicted on the next GC tick. Persistence
// (channels/sessions.json) is intentionally untouched — the next inbound
// rehydrates from disk against the same sessionId, so the on-disk
// transcript continues across the eviction. The point is to free memory
// (LiveSession holds an open SessionManager + transcript in RAM) and to
// give the next conversation a fresh start without forcing the user to
// notice anything. `lastInboundAt` is bumped only by *engaged* inbounds
// (see scheduleDebouncedDrain), so passive observation alone won't keep
// a session warm forever — that's intentional. The session is seeded
// with `now()` at creation (not `0`) so a freshly-created observe-only
// session gets a full SESSION_IDLE_MS window before its first GC sweep,
// not a 56-year-old idle reading from `Date.now() - 0`.
export const SESSION_IDLE_MS = 30 * 60 * 1000
export const SESSION_GC_INTERVAL_MS = 60 * 1000

// Hard cap on tool-initiated outbound sends per (chat:thread) per turn.
// The original loop-incident emitted ~50 sends in one turn; even
// legitimate split replies rarely cross 8. 10 leaves headroom for
// genuine multi-part answers while definitively stopping runaway loops.
// Enforced inside router.send for `source: 'tool'` callers; system
// recovery paths (`source: 'system'`) bypass.
export const MAX_CHANNEL_SENDS_PER_TURN = 10
export const ENGAGE_REACTION_EMOJI = 'eyes'
export const CONTINUATION_REACTION_EMOJI = 'hourglass_flowing_sand'
// Best-effort "zipping it / going quiet" ack dropped on the triggering message
// when the model disengages (channel_disengage); fire-and-forget like engage :eyes:.
export const DISENGAGE_REACTION_EMOJI = 'zipper_mouth_face'
// Per-adapter fallback for platforms that cannot render the default. GitHub's
// Reactions API is a fixed 8-emoji set with no zipper-mouth; 'confused' is the
// closest "stepping back" signal it can post, so a GitHub disengage still acks
// instead of silently no-op'ing on the unsupported result.
const DISENGAGE_REACTION_EMOJI_OVERRIDES: Partial<Record<AdapterId, string>> = {
  github: 'confused',
}

export function disengageReactionEmojiFor(adapter: AdapterId): string {
  return DISENGAGE_REACTION_EMOJI_OVERRIDES[adapter] ?? DISENGAGE_REACTION_EMOJI
}

type SilentAckReason = 'github_review_output' | 'awaiting_background_child'

// Wake nudge pushed into a resumed channel session at boot so drain() has a
// non-empty batch and fires a turn. The substantive instruction the model acts
// on is the `typeclaw.restart-self` entry already in the reopened JSONL (pi
// hydrates it as a user message); this nudge only triggers the turn. Uses the
// repo's SYSTEM MESSAGE framing (see composeTurnPrompt) so persona-rich models
// do not reply to it as if a human wrote it.
export const RESTART_RESUME_WAKE_REMINDER = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'The container just restarted and this session was resumed. Act on the',
  'restart instructions already in your context. Do not acknowledge or reply to',
  'this notice itself.',
  '',
  '---',
].join('\n')

// Ceiling on tool-source channel sends that a same-turn router policy DENIED
// without delivering — `skip-locked`, `turn-cap`, or `duplicate`. Such denials
// return a soft error and do NOT increment `consecutiveSends`, so a model that
// ignores the denial and retries never trips `MAX_CHANNEL_SENDS_PER_TURN`.
// Both production livelocks had this shape: the model alternated a no-op
// `skip_response` with a denied `channel_reply` (~200-400x in one
// `session.prompt()`) — the interleaving defeated the byte-identical
// loop-guard's 5-in-a-row streak, and the denials bypassed the send cap. One
// turn was all `skip-locked`, the other all `duplicate` (byte-identical text).
// Past this ceiling we ABORT the run's AbortSignal (`agent.abort()`), which
// ends the turn on the next assistant stream. We can't just throw: the pi tool
// executor catches a tool's throw into an error result and the turn continues.
// Counted per send-target and only when NO concurrent reservation for that
// target is in flight, so a legitimate parallel send-burst (one winner + many
// same-tick duplicate/cap denials) is never mistaken for a loop. Reset at turn
// start alongside `turnSeq`.
export const MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN = 3
// Per-request output-token cap for channel sessions, threaded into the agent's
// stream options to override pi-ai's model max-tokens default, which 0.87.1
// clamps to the remaining context window (`buildBaseOptions` in
// @earendil-works/pi-ai/dist/api/simple-options.js:10-18). Without it, Fireworks'
// kimi-k2p6-turbo — which degenerates into single-token repetition on the
// post-tool follow-up turn — can run the model's full output capability
// (~116s of garbage) before `stopReason: 'length'`. The terminal-reply hook
// below removes the turn that triggers this; the cap bounds any other path that
// still reaches a channel LLM call. 4096 fits a thinking block plus a nontrivial
// reply (healthy channel turns observed at ~317 output tokens including
// reasoning). Deliberately NOT lowered in `providers.ts`, where `maxTokens` is
// the model's true capability that compaction math reads.
export const CHANNEL_MAX_OUTPUT_TOKENS = 4096
// Raised output-token budget threaded into the ONE re-prompt that follows a
// `stopReason:'length'` empty turn. The default 4096 backstop bounds kimi's
// degenerate repetition loop, but it is the same ceiling a *legitimate*
// reasoning-heavy turn hits when it spends the whole pool thinking and emits no
// prose — re-prompting under the identical cap reproduces the truncation. A
// `length` truncation that the byte-identical loop guard did NOT catch is
// evidence of genuine reasoning starved for room, not a repetition loop, so the
// turn that IS looping still can't burn the model's full output capability. Consumed
// one-shot via `LiveSession.nextPromptMaxTokens`, then reset at the next real
// user turn so the raised budget never leaks past the turn that needed it.
export const CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS = 16384
// Ceiling on automatic re-prompts for a turn that ended with NO user-facing
// reply AND no attempted send — the pure "the model burned its budget thinking
// and produced nothing" failure. The canonical trigger is Fireworks'
// kimi-k2p6-turbo spiraling into a long reasoning loop on an ambiguous request
// until it hits CHANNEL_MAX_OUTPUT_TOKENS (`stopReason: 'length'`); the same
// path also catches a provider/router `aborted` leaf that left no recoverable
// prose. Each retry injects EMPTY_TURN_RETRY_NUDGE as a reminder-only turn (no
// new inbound) so `drain()` re-runs `session.prompt()` against the same branch.
// Bounded because a genuinely stuck model would otherwise re-loop forever; on
// exhaustion the user gets EMPTY_TURN_FALLBACK_TEXT instead of dead air. Reset
// at turn start alongside `turnSeq`. Deliberately NOT applied to turns that
// ATTEMPTED a send this turn (skip-locked or policy-denied) — those already
// thrashed the send path, so a re-prompt would just re-thrash; they skip
// straight to the fallback. See validateChannelTurn's candidate===null branch.
export const MAX_EMPTY_TURN_RETRIES = 2

// Separate, tiny budget for the tool-call-leak self-correction retry. Kept
// apart from MAX_EMPTY_TURN_RETRIES so a persistently-leaking model cannot
// consume the empty-turn budget (or vice versa) and so it can't livelock: one
// nudged retry, then on a second leak we suppress and stay silent. A leaked
// call is a clean protocol miss, not budget exhaustion — one reminder is
// usually enough, and silence is safer than an unbounded re-prompt loop.
export const MAX_TOOL_LEAK_RETRIES = 1
// Reminder-only nudge injected before a tool-call-leak retry. The model wrote a
// tool call as its visible message text instead of actually calling the tool,
// so we suppressed the plumbing and ask it to redo the turn properly. Same
// SYSTEM MESSAGE framing as the other reminder-only nudges.
export const TOOL_CALL_LEAK_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your previous turn wrote a tool call (e.g. `channel_reply(...)`,',
  '`channel_react(...)`, `skip_response(...)`) as plain message TEXT instead of',
  'actually invoking the tool. That text was suppressed — it was NOT sent to the',
  'channel — because raw tool-call syntax must never be posted as a message. This',
  'is an automated signal from the channel router, not a message from anyone in',
  'the chat. **Do not acknowledge or reply to this notice itself.**',
  '',
  'Redo the turn correctly: to reply, call your channel reply tool; to react or',
  'disengage, call that tool; to stay silent, call `skip_response({ reason })`.',
  'Emit a real tool call — do not type its syntax as your answer.',
  '',
  '---',
].join('\n')
// Reminder-only nudge injected before an empty-turn retry. Uses the repo's
// SYSTEM MESSAGE framing (see composeTurnPrompt) so persona-rich models do not
// reply to the notice itself. Names the actual failure (the prior turn ran out
// of its output budget mid-reasoning and produced no reply) and asks the model
// to keep its thinking short and answer directly — the empty turn was budget
// exhaustion, not a forgotten tool call, so a "reply directly" nudge alone
// would re-loop. The matching retry re-prompt also runs with a raised budget
// (CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS) so the room actually exists.
export const EMPTY_TURN_RETRY_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your previous turn ran out of its output budget before sending a reply — it',
  'spent the whole turn thinking and produced nothing for the channel. This is',
  'an automated signal from the channel router, not a message from anyone in',
  'the chat. **Do not acknowledge or reply to this notice itself.**',
  '',
  'Answer the last user message now: keep any reasoning brief and send a direct',
  'reply via your channel reply tool. If you genuinely have nothing to say,',
  'reply with `NO_REPLY`.',
  '',
  '---',
].join('\n')
// Reminder-only nudge for the stranded-toolUse-after-send retry. Distinct from
// EMPTY_TURN_RETRY_NUDGE: that one diagnoses output-budget exhaustion and tells
// the model to "answer directly", which makes a stranded investigation RE-RUN
// its tools and strand again. Here the model already sent a `more_work_this_turn: true`
// status ack and did real tool work; the turn just ended on an unanswered
// toolUse before final prose. The prior toolUse/toolResult entries are still in
// this session's branch on the re-prompt, so the recovery is to STOP, read what
// it already gathered, and reply — not to start the investigation over.
export const STRANDED_TOOLUSE_CONTINUATION_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your previous turn sent a brief status reply, did some tool work, then ended',
  'before sending the answer it promised. This is an automated signal from the',
  'channel router, not a message from anyone in the chat. **Do not acknowledge or',
  'reply to this notice itself.**',
  '',
  'Do NOT start the investigation over. The tool results you already gathered are',
  'still in this conversation above — read them, summarize what you found, and',
  'send your reply now via your channel reply tool. Only call more tools if a',
  'specific fact is genuinely still missing. If you truly have nothing to say,',
  'reply with `NO_REPLY`.',
  '',
  '---',
].join('\n')
// Posted to the channel (via the `source:'system'` one-shot bypass) when an
// empty turn cannot be recovered AND retries are exhausted (or are skipped
// because the turn thrashed the send path). Replaces the historical silent
// drop so the human is never left staring at dead air after a degenerate turn.
export const EMPTY_TURN_FALLBACK_TEXT =
  "⚠️ I got stuck putting together a reply and couldn't finish. Could you rephrase or try again?"
export const GITHUB_REVIEW_THREAD_CLOSEOUT_FALLBACK_TEXT =
  "I wasn't able to complete this follow-up. Leaving this thread open for manual review."
// Distinct from EMPTY_TURN_RETRY_NUDGE: that one diagnoses budget exhaustion
// ("ran out of output budget"), which is FALSE for a clean `stop` with empty
// text. This nudge names the real failure — a turn that ended sending nothing
// to a message addressed to the agent in a one-on-one conversation — and steers
// the model to either answer or record the silence explicitly (skip_response /
// NO_REPLY) rather than ending empty again.
export const COLD_START_REPLY_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your previous turn ended without sending anything, but the last message was',
  'addressed to you in a direct, one-on-one conversation — ending silent there',
  'reads as ignoring the person. This is an automated signal from the channel',
  'router, not a message from anyone in the chat. **Do not acknowledge or reply',
  'to this notice itself.**',
  '',
  'Answer the last user message now via your channel reply tool. If you truly',
  'have nothing to add, call `skip_response({ reason })` (preferred) or end with',
  'exactly `NO_REPLY` so the silence is recorded — do not just end empty.',
  '',
  '---',
].join('\n')
// Reminder-only nudge for the empty-stop-after-tool-work retry. Distinct from
// both EMPTY_TURN_RETRY_NUDGE (which misdiagnoses a clean `stop` as output-budget
// exhaustion and, per its own docstring, makes the model RE-RUN its tools and
// strand again) and STRANDED_TOOLUSE_CONTINUATION_NUDGE (which assumes a
// `more_work_this_turn: true` status reply already landed). Here NO send landed,
// the model gathered real
// tool results, then the final completion came back as a bare empty `stop` — the
// Fireworks/gpt empty-completion degeneration. The recovery is to READ the results
// already in this branch, summarize, and reply — NOT to re-investigate. The
// trailing NO_REPLY escape is what makes the rare research-then-decline false
// positive self-correct on the first retry instead of forcing the fallback.
export const EMPTY_STOP_AFTER_TOOL_WORK_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your previous turn gathered information with your tools, then ended without',
  'sending any reply — the final completion came back empty. This is an automated',
  'signal from the channel router, not a message from anyone in the chat. **Do not',
  'acknowledge or reply to this notice itself.**',
  '',
  'Do NOT re-run your tools. The results you already gathered are still in this',
  'conversation above — read them, summarize what you found, and send your reply',
  'now via your channel reply tool. Only call more tools if a specific fact is',
  'genuinely still missing. If you truly have nothing to say, reply with `NO_REPLY`.',
  '',
  '---',
].join('\n')
// At most one continuation nudge per logical turn. Stricter than the empty-turn
// retry budget (2) because the turn ALREADY delivered a user-facing reply — this
// is a one-shot correction offer, not recovery from no output.
export const MAX_WILLINGNESS_NUDGES = 1
// Injected when a reply that ended the turn (terminal-reply abort) promised to
// keep working but omitted `more_work_this_turn: true`. Reminder-only, SYSTEM MESSAGE
// framing so persona-rich models do not reply to the notice itself.
// Leads with the DELIVERY imperative, mirroring SEND_WILLINGNESS_NUDGE below. An
// earlier revision closed on a bare "If there is nothing left to do, reply with
// `NO_REPLY`" and production models took that door after doing the promised work:
// "nothing left to DO" reads as satisfied the moment the investigation finishes,
// so the turn exited silent while still holding the answer. Splitting "no work
// left" from "nothing to report", and scoping NO_REPLY to already-delivered, is
// the load-bearing part of this wording — do not collapse it back.
export const WILLINGNESS_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your last reply promised the human you would keep working, but the turn ended',
  'right after sending — a successful channel reply ends the turn unless you set',
  '`more_work_this_turn: true` on it. This is an automated signal from the channel',
  'router, not a message from anyone in the chat. **Do not acknowledge or reply to',
  'this notice itself.**',
  '',
  'Someone is waiting on the result you just promised. Do the work now (fetch data,',
  'run a tool, spawn a subagent) and post what you find — and on any further status',
  'reply that precedes more work this turn, set `more_work_this_turn: true`. If you',
  'already did the work, post the conclusion you reached: having no work left is NOT',
  'the same as having nothing to report, and a promise that never lands reads to the',
  'human as being ignored.',
  '',
  '`NO_REPLY` is correct ONLY if the result you promised is already in the channel.',
  '',
  '---',
].join('\n')
// Injected when a `channel_send` ack tripped continuation-willingness, the model
// did fresh work after it, then ended on an EMPTY `stop` leaf — the answer was
// computed but never sent (the Kimi/Fireworks empty-completion flake). Distinct
// from WILLINGNESS_NUDGE: that path is a `channel_reply` that ended the turn and
// needs `more_work_this_turn: true`; this path is a `channel_send` (which never ends the
// turn) whose follow-up degenerated, so the model just needs to emit the reply it
// already worked out. Shares MAX_WILLINGNESS_NUDGES so a turn can't double-nudge.
// Scopes NO_REPLY the same way WILLINGNESS_NUDGE does, and for the same reason:
// both nudges share `willingnessNudges`, so both are covered by the
// `no_reply_after_willingness_nudge` fallback. A nudge that still advertised
// NO_REPLY as an ordinary exit would contradict the guard that answers it.
export const SEND_WILLINGNESS_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'You said you would keep working this turn and did the work, but the turn ended',
  'without sending the result — nothing reached the channel after your last',
  'message. This is an automated signal from the channel router, not a message',
  'from anyone in the chat. **Do not acknowledge or reply to this notice itself.**',
  '',
  'Send the answer you just worked out now via your channel send tool. Post what',
  'you found even if the finding is "no change" or "it failed" — someone is waiting',
  'on the result you promised, and having no work left is not the same as having',
  'nothing to report.',
  '',
  '`NO_REPLY` is correct ONLY if the result you promised is already in the channel.',
  '',
  '---',
].join('\n')
// Rolling window for outbound send-rate telemetry. 5s matches Discord's
// rate-limit shape (5 msg / 5 s / channel) and comfortably covers Slack's
// 1 msg/s sustained. The window is observational; exceeding the burst
// threshold below escalates the per-send log to a warning.
export const SEND_RATE_WINDOW_MS = 5_000
// Above this in-window count, the per-send log line escalates to a
// `send_rate_warning` so a burst stands out in the log stream. Every
// send still emits a structured log line regardless of rate — this
// constant only controls when the warning marker appears.
export const SEND_RATE_WARN_THRESHOLD = 3
export const OUTBOUND_FLOOD_ERROR = 'outbound message denied: content looks like a repeated-character flood'

/**
 * Soft freshness boundary: the age of the last engaged inbound past which the
 * provider's server-side KV prompt-cache for this session's prefix is assumed
 * cold. Set to the LLM provider's KV-cache TTL (5 min) so a session reused
 * WITHIN this window is guaranteed a cache hit on the provider side.
 *
 * Reaching this boundary no longer forces an immediate rollover. Between the
 * soft boundary and SESSION_GRACE_HARD_TTL_MS, the live path defers to a
 * cost-aware grace decision (see `isGraceWorthReusing`): a session whose fixed
 * base context (rendered system prompt + injected memory + prefetched channel
 * context) still costs more to rebuild than its accumulated transcript is
 * reused for one more turn rather than torn down. This targets the common
 * channel shape — a human replying a few minutes past the cache TTL — where a
 * full cold-start rebuild of a large memory/index-mode base context dominates
 * the cost of carrying a modest transcript forward.
 *
 * Unlike SESSION_IDLE_MS (which evicts the in-memory entry without rollover), a
 * rollover triggers a full tearDownLive + recreate on the next engaged inbound.
 * The old session's transcript is preserved on disk; only the in-memory live
 * entry and sessions.json pointer are replaced.
 */
export const SESSION_FRESHNESS_TTL_MS = 5 * 60 * 1000

/**
 * Hard ceiling on the cost-aware grace window. Past this age the live session is
 * rolled over unconditionally regardless of base-vs-transcript cost: the grace
 * decision only defers rollover, it never makes the session immortal. Bounding
 * grace at 2x the soft TTL keeps a never-quite-idle session from accumulating an
 * ever-growing, fully-uncached prefix (every turn past the soft boundary re-sends
 * the whole prefix at no provider-cache discount) and prevents grace from
 * silently becoming an unbounded TTL increase.
 */
export const SESSION_GRACE_HARD_TTL_MS = 10 * 60 * 1000

/**
 * Leak guard — NOT a freshness cap. A running background subagent pins its parent
 * channel session against idle GC and stale-rollover for as long as the child is
 * actually running, because the next inbound would otherwise start a fresh session
 * that has lost track of the in-flight task and spawns a DUPLICATE child, and — the
 * bug this backstop is sized around — a completion arriving after teardown has no
 * live session to deliver its system-reminder to and is silently dropped.
 *
 * The pin is bounded only so a genuinely stuck/wedged child cannot make the session
 * immortal. Subagent `timeoutMs` is optional (operator declares none), so a hung
 * child stays `status: 'running'` forever; without this ceiling its parent session
 * would leak indefinitely. Past this age the child is treated as stuck: GC/rollover
 * proceeds and the session falls back to completion-reroute.
 *
 * Sized as an ANOMALY threshold, deliberately far above any legitimate run (deep
 * operator work is minutes-to-an-hour, not hours), so it never fires for real work.
 * The prior 45m value was close enough to plausible deep work to turn a legitimate
 * long run into a routine drop — the reported 65m completion loss. 6h is clearly
 * "this child is wedged," not "this child is busy".
 */
export const SESSION_CHILD_STUCK_BACKSTOP_MS = 6 * 60 * 60 * 1000

/**
 * Cost-aware grace decision for the soft→hard TTL band. Returns true when reusing
 * the (now cache-cold) live session is cheaper than a fresh cold-start.
 *
 * After the soft TTL the provider prefix is cold either way, so the choice is:
 *   - rollover: pay to rebuild the fixed base context (system prompt + memory +
 *     prefetched context) plus a fresh first model call, OR
 *   - reuse: re-send the cold base context PLUS the accumulated transcript.
 *
 * Rollover only wins once the transcript a reused session would carry forward
 * exceeds the base context a rollover would rebuild. We approximate both with the
 * session transcript file: `baseContextBytes` is its size captured right after
 * cold-start (the rendered prompt before any user turn), and the live delta is
 * the growth since. While `baseContextBytes > transcriptDeltaBytes`, the fixed
 * rebuild is the larger cost and grace is worth it. A `baseContextBytes` of 0
 * (no transcript path available) disables grace — fail closed to the prior
 * roll-over-at-soft-TTL behavior.
 */
export function isGraceWorthReusing(baseContextBytes: number, transcriptDeltaBytes: number): boolean {
  if (baseContextBytes <= 0) return false
  return baseContextBytes > transcriptDeltaBytes
}

function defaultMeasureTranscriptBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// Watchdog ceiling for ensureLive's full async chain (resolve names →
// fetch membership → open session manager → persist mapping → prefetch
// history). A legitimate cold-start completes in well under a second;
// values above ~10s are always either a hung Discord REST call or a
// rate-limited retry storm. 30s leaves headroom for slow disks or a
// truly large transcript replay without making operator-noticed hangs
// indistinguishable from normal latency. On timeout the throw evicts
// the `creating` map entry so the next inbound retries from scratch
// instead of awaiting the same dead promise forever.
export const ENSURE_LIVE_TIMEOUT_MS = 30_000

const RELOAD_HANDOFF_RETENTION_MS = 15 * 60_000
const MAX_PENDING_RELOAD_HANDOFF_KEYS = 100
const MAX_PENDING_RELOAD_HANDOFF_ITEMS_PER_KEY = 1_000
const MAX_PENDING_RELOAD_HANDOFF_BYTES_PER_KEY = 8 * 1024 * 1024
const MAX_PENDING_RELOAD_HANDOFF_BYTES_TOTAL = 64 * 1024 * 1024

// Thrown by ensureLive() when a teardown (roles reload or shutdown) raced
// ahead of an in-flight creation. route() has no special handling — it
// propagates to the adapter's outer catch, dropping this one inbound. The
// next inbound creates a fresh, post-reload session, which is the intended
// outcome: a message that arrived mid-reload is cheap to drop, far cheaper
// than answering it through a session built with the stale role.
export class StaleLiveSessionError extends Error {
  constructor(keyId: string) {
    super(`[channels] ${keyId}: live session creation raced a teardown; discarded`)
    this.name = 'StaleLiveSessionError'
  }
}

// Per-callback ceilings inside the ensureLive chain. The outer watchdog
// catches the worst case, but per-step timeouts give better log
// attribution (which step hung) AND graceful degradation: a hung name
// resolver still lets engagement run on IDs alone, a hung history fetch
// still lets the agent answer without prefetched context. Both paths
// loop over registered callbacks and currently `await` each unbounded.
// 5s matches Discord's median REST p99 with comfortable headroom.
export const RESOLVE_CHANNEL_NAMES_TIMEOUT_MS = 5_000
export const FETCH_HISTORY_TIMEOUT_MS = 5_000

export const HISTORY_ATTACHMENT_LIMIT = 50

// Watchdog over the whole session.idle hook chain. The drain loop awaits
// `fireSessionIdle` between turns; a single hung plugin handler (e.g. a
// memory-logger awaiting a network call that never resolves) wedges the
// loop with `live.draining` stuck `true`, which means subsequent mention
// inbounds enqueue silently and never fire. Observe-decisions still log
// because engagement runs in `route()` before the draining check, so the
// symptom from logs alone is "thread receives observed lines forever
// after the last `prompted elapsed_ms=...`". Bounding the chain here
// matches the ensureLive watchdog (30s) so a misbehaving plugin
// degrades the current turn instead of bricking the channel until
// container restart. Per-handler attribution lives in plugin/hooks.ts.
export const SESSION_IDLE_TIMEOUT_MS = 30_000

// Two-axis loop guard for peer-bot conversation. Peer bots route into
// engagement under the SAME rules as humans, so a small ring (A→B→C→A) or
// a fast cascade can otherwise ping-pong without bound. The guard trips
// when EITHER axis hits its limit and clears on the next human inbound.
//
// Why two axes:
// - The since-human counter catches slow rings that would never fill a
//   60s window (3 bots replying every 30s = 4 turns/min, never trips a
//   60s sliding count).
// - The 60s window catches fast bursts that would never accumulate enough
//   total turns to pressure the since-human counter (a single bot reflex
//   replying to its own mention 5x in 2s).
//
// The model receives a non-fatal warning prepended into composeTurnPrompt
// when tripped; the LLM decides whether to keep replying. Hard interrupt
// is intentionally not part of v1 (would require pi-coding-agent abort
// semantics during in-flight tool calls).
export const PEER_BOT_TURNS_WINDOW_MS = 60_000
export const MAX_PEER_BOT_TURNS_IN_WINDOW = 5
export const MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN = 5

export type RouterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: RouterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type CreateSessionForChannel = (params: {
  key: ChannelKey
  existingSessionId?: string
  // Basename of the JSONL file the prior session wrote to, captured at
  // creation time and persisted in channels/sessions.json. Used for
  // reopening — without this, sessionId alone is insufficient because
  // pi-coding-agent prefixes filenames with an ISO timestamp at write time
  // that the UUID does not encode. Optional for forward-compat with v2
  // mappings that predate the `sessionFile` field.
  existingSessionFile?: string
  participants: readonly ChannelParticipant[]
  origin: SessionOrigin
  // Mutable holder the router updates per turn (with the current turn's
  // lastInboundAuthorId, participants, etc.) so tool.before events stamp
  // the live actor identity rather than the cold-start snapshot. The
  // factory is expected to pass this through to createSession as
  // `options.originRef`.
  originRef: { current: SessionOrigin | undefined }
}) => Promise<{
  session: ChannelAgentSession
  sessionId: string
  dispose: () => Promise<void>
  hooks?: HookBus
  getTranscriptPath?: () => string | undefined
}>

export type ConfigForAdapter = (adapter: ChannelKey['adapter']) => ChannelAdapterConfig | undefined

type QueuedInbound = {
  inputId: string
  text: string
  referenceContext?: InboundReferenceContext
  attachments?: readonly InboundAttachment[]
  authorId: string
  authorName: string
  authorIsBot: boolean
  externalMessageId: string
  reactionRef?: ReactionRef
  engageReaction?: WaitingReactionHandle
  isBotMention: boolean
  isBotMentionOnly?: boolean
  replyToBotMessageId: string | null
  isDm: boolean
  typingThread?: string
  receivedAt: number
  // Original platform timestamp (Slack/Discord), in ms since epoch. Used
  // by composeTurnPrompt to render an ISO 8601 prefix on each line so the
  // model sees when each message was actually posted, not when the router
  // happened to dequeue it. Zero means "unknown" (the formatter omits the
  // prefix for those).
  ts: number
  githubReviewRound?: GithubReviewFollowupRound
  githubReviewThreadCloseout?: GithubReviewThreadCloseout
}

type ObservedInbound = {
  text: string
  referenceContext?: InboundReferenceContext
  attachments?: readonly InboundAttachment[]
  authorId: string
  authorName: string
  authorIsBot: boolean
  receivedAt: number
  ts: number
  // Distinguishes scrollback that was bulk-loaded at session cold-start
  // (`prefetch`) from messages that actually arrived in the channel after
  // the session went live (`observed`). Both share the same in-memory
  // shape because the model sees them identically in the prompt's
  // "Recent context" block, but the quote-anchor decision must treat them
  // differently: prefetched scrollback is HISTORICAL context, not new
  // chatter that happened between the primary inbound and the agent's
  // reply. Counting prefetch entries as "intervening" would fire the
  // anchor on every fresh-thread first turn (the prefetch stamps
  // `receivedAt = now()` AFTER the inbound was received during ensureLive,
  // so by primary-vs-observed timestamp comparison they always look
  // "later"). See captureQuoteCandidate.
  source: 'prefetch' | 'observed'
}

type TimedAttachment = { ts: number; attachment: InboundAttachment }

type ChannelAgentSession = AgentSession & { getAbortReason?: () => string | undefined }

// Provenance of a queued system reminder, which decides whether the
// reminder-only drain iteration it drives CONTINUES the current logical turn or
// OPENS a new one.
//
// `retry` — the router's own turn-recovery ladder asking the SAME logical turn
// to try again (empty-turn, tool-leak, stranded-tooluse, cold-start,
// empty-stop, willingness). Per-logical-turn attribution and the recovery
// budgets must survive these, or the ladder would refill its own budget and
// loop forever.
//
// `wakeup` — work injected from OUTSIDE the session's own turn machinery: a
// finished background subagent, a restart resume, a PR-verdict stand-down.
// These are a new episode that merely happens to arrive without a user
// message, so carrying the previous turn's attribution into them is wrong.
//
// The todo/idle continuation is deliberately `retry`, not `wakeup`: it is the
// same work episode continuing, and its turn must keep citing the durable work
// already completed.
//
// Provenance is per ENTRY rather than a single session-level flag because both
// kinds can coalesce into one iteration; a wakeup in the batch opens a new
// logical turn regardless of what else it rode in with. Matching on reminder
// TEXT was rejected: a wakeup body that happened to equal a nudge constant
// would silently misclassify, and every future enqueue site would inherit the
// default instead of being forced to choose.
type PendingSystemReminder = {
  text: string
  kind: 'retry' | 'wakeup'
  githubReviewRoundKey?: string
  backgroundObligationId?: string
  inboundRetry?: { inputIds: string[]; turnId: string }
  backgroundRetry?: {
    turnId: string
    obligationIds: string[]
    emptyTurnRetries: number
    toolLeakRetries: number
    willingnessNudges: number
    nextPromptMaxTokens: number | undefined
  }
}

// Identity-only snapshot of the deferred durable coverage a session reloaded
// mid-obligation still owes (typically a turn waiting on a running background
// child). The journal claims stay authoritative under `turnId`/`ownerSessionId`
// until the successor's in-lane consume moves them; nothing here prompts.
type PendingReloadCoverage = {
  inboundIds: string[]
  backgroundIds: string[]
  turnId: string
  ownerSessionId: string
  logicalTurnStartedAt: number
  coverageDeferredSince: number | null
  turnAccountIdentity?: string
  // Author context a completion-only wake needs for author-scoped role
  // resolution, exactly as the reloaded session would have restored it.
  lastTurnAuthorId: string | null
  lastTurnAuthorIds: string[]
}

type PendingReloadHandoff = {
  key: ChannelKey
  // Session the work was retained from. A /stop that finds no live session
  // withdraws this session's transferred notices, as a live stop would.
  sessionId: string
  inbounds: QueuedInbound[]
  observed: ObservedInbound[]
  reminders: PendingSystemReminder[]
  coverage: PendingReloadCoverage | null
  retainedAt: number
  estimatedBytes: number
}

const STOP_COMMAND_REPLY = 'Stopped the current turn.'

const retryReminder = (text: string): PendingSystemReminder => ({ text, kind: 'retry' })

const wakeupReminder = (text: string): PendingSystemReminder => ({ text, kind: 'wakeup' })

const githubReviewRoundWakeupReminder = (text: string, round: GithubReviewFollowupRound): PendingSystemReminder => ({
  text,
  kind: 'wakeup',
  githubReviewRoundKey: githubReviewRoundKey(round),
})

type LiveSession = {
  key: ChannelKey
  keyId: string
  // Structural room shape from the inbound (thread + optional parent channel).
  // Kept on the session so membership scoping can reach the parent channel for
  // platforms (Discord) where the thread is its own channel and the key alone
  // cannot express "this is a thread in channel X". Updated per inbound in route().
  room: InboundMessage['room']
  session: ChannelAgentSession
  activeModelRef: ReturnType<typeof resolveFallbackChain>[number]
  // The session's creation-time thinking level, captured once. A later escalated
  // turn moves `session.thinkingLevel` to `high`, so the live getter can't be the
  // reset target — this preserves the real default across the session's lifetime.
  turnThinkingDefault: AgentSession['thinkingLevel']
  // Last COMPLETED real user turn's question shape, for cross-turn "Jeff Bezos"
  // escalation. Read by the next turn; committed from pendingUserTurnSignal only
  // when a logical turn finishes (no empty-turn retry queued).
  lastQuestionSignal: QuestionSignal | null
  // A real user turn's question shape captured at turn start but not yet
  // committed: a `length`/`aborted` truncation spans the original batch plus
  // reminder-only retry iterations, so the signal commits to lastQuestionSignal
  // only when that whole logical turn completes (success or fallback), never
  // from the truncated attempt and never leaving stale state across the turn.
  pendingUserTurnSignal: { signal: QuestionSignal } | null
  sessionId: string
  dispose: () => Promise<void>
  hooks: HookBus | undefined
  getTranscriptPath: (() => string | undefined) | undefined
  participants: ChannelParticipant[]
  resolvedNames: ResolvedChannelNames
  originRef: { current: SessionOrigin | undefined }
  githubReviewRound: GithubReviewFollowupRound | null
  // A real-user reply to one of this agent's own review-thread roots must end
  // with a reply on that exact thread. This spans reminder-only retry iterations.
  githubReviewThreadCloseout:
    | (GithubReviewThreadCloseout & {
        startedAt: number
        correctionAttempts: number
        deferred: boolean
      })
    | null
  githubReviewThreadCloseoutDecisionTurn: number | null
  // Round key of a close-out that arrived while the round was still pending
  // completion. Replayed once the round completes; see replayPendingRoundCloseouts.
  pendingGithubReviewRoundCloseout: string | null
  promptQueue: QueuedInbound[]
  contextBuffer: ObservedInbound[]
  // Attachments of the messages composing the in-flight turn. drain()
  // splices promptQueue/contextBuffer empty BEFORE calling prompt(), but
  // the model only requests an attachment (look_at_channel_attachment /
  // channel_fetch_attachment) DURING prompt() — by which point both queues
  // are empty. This turn-scoped snapshot, populated right after the splice
  // and cleared when the turn ends, is what the lookup reads so a freshly-
  // arrived attachment stays resolvable for the whole turn it belongs to.
  currentTurnAttachments: readonly InboundAttachment[]
  // Refs from an explicit channel_history look-back. A prior-turn attachment is
  // replayed to the model as a text placeholder but its ref is gone from every
  // turn-scoped queue above, so look_at/fetch can't resolve it; stashing the
  // fetched refs here makes the same `attachment_id: N` resolvable. MUST be
  // searched LAST so a live `#1` still wins over a historical `#1` (the
  // newest-first collision rule lookupInboundAttachment documents). Bounded,
  // never persisted, never exposes the ref to the model. historyTimedAttachments
  // is the ts-tagged source of truth (ordered oldest→newest, deduped by id);
  // historyAttachments is its flat projection consumed by the lookup helpers.
  historyTimedAttachments: readonly TimedAttachment[]
  historyAttachments: InboundAttachment[]
  draining: boolean
  // Every drain invocation still running, including the tail it executes after
  // `draining` flips back to false. `drain()` deliberately no-ops while a drain
  // owns the session, so a fire-and-forget `void drain(live)` is otherwise
  // unobservable; this is the only handle a caller can await to know the turn
  // actually landed. Entries remove themselves on settle.
  activeDrains: Set<Promise<void>>
  debounceTimer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setInterval> | null
  typingStartedAt: number
  typingTimedOut: boolean
  typingStopPromise: Promise<void> | null
  // Monotonic heartbeat generation. Captured when a heartbeat starts and
  // bumped when it stops. `clearInterval` cannot cancel a timer callback that
  // already came due, so a stale 'tick' can still run AFTER stopTypingHeartbeat
  // enqueued its clear — on Slack that re-sets "is typing..." after the empty-
  // string clear and strands the indicator (Slack's status has no auto-expiry).
  // A 'tick' fired with a stale epoch is dropped before it reaches the adapter.
  typingEpoch: number
  // True only while `live.session.prompt()` is actively running. Gates the
  // deferred typing revival: a revival queued behind an in-flight cap-trip
  // 'stop' must NOT re-arm the heartbeat once the prompt has finished, or it
  // leaks a timer that fires past the turn's end.
  promptInFlight: boolean
  lastInboundAt: number
  // Transcript-file size (bytes) captured immediately after cold-start, before
  // any user turn — a proxy for the fixed base-context rebuild cost (rendered
  // system prompt + injected memory + prefetched channel context). Read by the
  // soft-TTL grace decision against the current transcript size to weigh reuse
  // vs rollover. 0 when no transcript path is available, which disables grace.
  baseContextBytes: number
  firstUnprocessedAt: number
  currentTurnAuthorId: string | null
  currentTurnAuthorIds: Set<string>
  // Reaction target of the inbound that triggered THIS turn (the last item in
  // the drained batch, mirroring `currentTurnAuthorId`). Surfaced on the live
  // origin so `channel_react` reacts to the triggering message, not whichever
  // inbound happens to be latest in the queue. Null on reminder-only turns.
  currentTurnReactionRef: ReactionRef | null
  // True when the inbound that triggered THIS turn (the message
  // `currentTurnReactionRef` points at — last item of the drained batch) was
  // EXPLICITLY addressed to the bot: a DM, an @-mention/alias (`isBotMention`
  // folds plain-name matching in at the adapter classify layer), or a reply to
  // the bot's own message. Gates the PERSISTENT :eyes: for deferred background
  // work (see `armSilentTurnAck`): an addressed request may retain a progress
  // marker while a child runs, but ambient human-to-human chatter must leave no
  // mark. Explicit NO_REPLY and skip_response turns never use this flag to add a
  // reaction. Computed from the SAME message the reaction targets so eligibility
  // and target cannot disagree. Reset with `currentTurnReactionRef` in the drain
  // finally; preserved across reminder-only iterations exactly like it.
  currentTurnExplicitlyAddressed: boolean
  // Typing-status anchor of the inbound that triggered THIS turn (last item in
  // the drained batch, mirroring `currentTurnReactionRef`). Adapter-opaque ts
  // carried only to the typing path; null when the triggering inbound supplied
  // none (every non-DM inbound, and reminder-only turns).
  currentTurnTypingThread: string | null
  // Every flat-DM typingThread anchor a 'tick' set a non-expiring status on but
  // that has not yet been cleared. In a flat DM each inbound stamps its OWN ts
  // as `typingThread`, so `currentTurnTypingThread` migrates from ts=A to ts=B
  // when a second message coalesces a new turn before the first turn's stop. A
  // single-anchor stop would then clear only B and strand A's "is typing..."
  // forever (Slack has no auto-expiry). Recording every ticked anchor lets the
  // stop clear ALL of them, not just the latest. An anchor is added when its
  // 'tick' dispatches and removed when its 'stop' clear dispatches.
  dirtyTypingThreads: Set<string>
  // Captured durable owners for this coalesced turn. Releasing one owner
  // cannot remove another turn's or a protected acknowledgment's presence.
  currentTurnEngageReactions: WaitingReactionHandle[]
  // Model-requested `channel_react` reactions for THIS turn, held until the turn
  // ends. Flushed to the adapter only if the agent actually replied this turn;
  // discarded on silence (skip_response / empty / errored turns) so the bot never
  // leaves a reaction on a message it merely looked at (e.g. cron lookaround).
  pendingTurnReactions: ReactionRequest[]
  // Armed when output landed outside the channel (a GitHub review) or was
  // deliberately deferred to a background child. Explicit NO_REPLY and
  // skip_response turns do not arm it: opting out must leave no reaction behind.
  // Stamped with `turnSeq` so a stale flag from a crashed turn cannot leak into
  // the next one. Tuple arbitration preserves protected acknowledgment
  // presence when temporary engagement ownership is retired.
  silentAckTurn: { turnSeq: number; reason: SilentAckReason } | null
  // Temporary continuation indicators are owned across turns until result,
  // silence, stop, teardown, or recovery explicitly releases their owner.
  activeContinuationReactions: WaitingReactionHandle[]
  lastTurnAuthorIds: Set<string>
  // Mirror of currentTurnAuthorId at end-of-turn (the LAST speaker of the
  // prior batch), preserved across the drain finally-block which resets
  // currentTurnAuthorId to null. Read by the reminder-only branch in
  // drain() so a system-reminder wakeup carries the same author the prior
  // turn's tool.before saw — matching "last speaker" semantics (not "first
  // inserted into Set"), so a multi-author prior turn like alice→bob
  // restores `bob`, the same identity normal turns would have used.
  lastTurnAuthorId: string | null
  consecutiveAborts: number
  // Per-(chat:thread) count of bot messages sent without intervening user
  // input being rendered into the model's context. Reset at the top of each
  // drain() iteration that picks up a non-empty batch (= a new user turn is
  // about to be shown to the model). channel_send reads this BEFORE calling
  // router.send so the hint reflects the position of the about-to-happen send
  // (n-th in a row), nudging the model to yield without forcing it to.
  // Queue of `<system-reminder>...</system-reminder>` strings to prepend
  // into the next turn's user-message body. Populated by
  // `injectSubagentCompletionReminder` (and any future system-injected
  // wakeups) so a backgrounded subagent's completion can wake a channel
  // session that has no pending user inbounds. Drained at the top of
  // every `drain()` iteration alongside the regular promptQueue batch;
  // the drain loop's run condition checks BOTH queues so a system
  // reminder alone is enough to trigger a turn.
  pendingSystemReminders: PendingSystemReminder[]
  // Identity-only cache; every durable transition resolves ownership in its lane.
  backgroundCoverage: string[]
  inboundCoverage: string[]
  turnAccountIdentity?: string
  backgroundTurnId: string
  backgroundStopVersion: number
  // True only for the reminder-only iteration that consumed a willingness
  // nudge. `willingnessNudges` persists across the logical turn, so it remains
  // nonzero after a substantive result and would misclassify NO_REPLY from a
  // later unrelated reminder as another dropped promise.
  willingnessReminderIteration: boolean
  consecutiveSends: Map<string, number>
  // Per-(chat:thread) text of the last reserved bot send. Set
  // SYNCHRONOUSLY inside router.send before the outbound callback awaits,
  // so two concurrent `router.send` calls for the same target cannot both
  // pass the duplicate guard. Cleared on every new prompt batch (same
  // lifecycle as `consecutiveSends`). The scope is "last 1 send within
  // this turn" so legitimate multi-part replies (different bodies) and
  // across-turn callbacks ("yes, I'm here" twice) are not blocked. Empty
  // strings are normalized to undefined before storage so attachments-only
  // sends never poison the tracker. The fuzzy-match upgrade is intentionally
  // deferred — exact-match has zero false-positive risk by construction.
  lastSentText: Map<string, string>
  // Session leaf-entry id captured at the moment the most recent successful
  // channel send landed this turn. `validateChannelTurn` compares it to the
  // turn-end leaf: a DIFFERENT assistant `stop` leaf means the model replied,
  // kept working, then ended with FRESH final prose it forgot to deliver
  // (the `more_work_this_turn: true` progress-reply bug) — recover it. A leaf that still
  // matches is narration the model emitted BEFORE/with the reply that already
  // landed, so it stays suppressed. Reset to null on every new prompt batch.
  lastSendLeafId: string | null
  // Per-(chat:thread) ring of send timestamps (epoch ms) within the rolling
  // SEND_RATE_WINDOW_MS window. Append-on-send, prune-on-read. Lifecycle is
  // wall-clock (NOT cleared on new prompt batches) because rate is a
  // property of the channel over time, not the agent's turn structure — a
  // burst that straddles two adjacent turns is still a burst from the chat
  // platform's POV. Telemetry-only today; the rate is logged when count
  // crosses SEND_RATE_LOG_THRESHOLD so production data can inform a
  // future hard cap without picking a threshold out of thin air.
  sendTimestamps: Map<string, number[]>
  successfulChannelSends: number
  // Monotonic per-LiveSession turn counter incremented just before each
  // `live.session.prompt(...)` call in `drain()`. Used as a turn identity
  // so `skip_response` can record "I skipped turn N" without leaking
  // across turns. `validateChannelTurn` only honors `skippedTurn` when it
  // equals `turnSeq`; a stale value from a crashed/aborted prior turn is
  // ignored (defensive: an unmatched skippedTurn would otherwise silently
  // drop the next user-facing reply). NOT cleared on drain finally — the
  // counter is purely monotonic; the matching comparison is what protects
  // against stale state.
  turnSeq: number
  // Clock time the current LOGICAL turn opened — stamped only on a real user
  // batch, so the reminder-only iterations a retry queues stay inside the same
  // logical turn. Unlike `turnSeq` (which increments per drain iteration) this
  // gives background-child checks a boundary they can compare a child's
  // `startedAt` against, to tell "this turn spawned it" from "it was already
  // running when unrelated work arrived".
  logicalTurnStartedAt: number
  // `logicalTurnStartedAt` of the turn that deferred the open `inboundCoverage`
  // to a background child, kept while fresh batches carry that coverage forward.
  // Each carrying batch advances `logicalTurnStartedAt`, so without this a later
  // batch would stop seeing the original child and declare the coverage lost.
  coverageDeferredSince: number | null
  // Snapshot of `successfulChannelSends` taken at turn start (same
  // moment `turnSeq` increments). Lets `markTurnSkipped` detect "a
  // channel send already landed in this turn" and reject the skip,
  // making the rejection symmetric with the send-after-skip lock in
  // `send()`: commit to silence or commit to replying, not both,
  // regardless of which order the model tried them in. Updated only at
  // turn start; reads against the live counter elsewhere are intentional.
  successfulSendsAtTurnStart: number
  // Per-send-target count of tool-source sends with a reservation currently
  // in flight (slot reserved, outbound callback not yet settled). Lets the
  // policy-denial guard tell a legitimate parallel send-burst (denials that
  // race a still-in-flight winner) from a sequential retry loop (denials with
  // nothing in flight). Incremented at reservation, decremented in the
  // callback-loop `finally` so an adapter throw can't strand a target.
  inFlightToolSends: Map<string, number>
  // Per-send-target count of policy-denied tool sends this turn that did NOT
  // race an in-flight reservation. Drives the throw at
  // `MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN` that breaks the alternating-tool
  // livelock the byte-identical loop-guard misses. Reset at turn start and
  // cleared per-target on a successful delivery to that target.
  policyDeniedToolSendsThisTurn: Map<string, number>
  // Count of automatic empty-turn re-prompts already spent on the CURRENT
  // logical turn, bounded by `MAX_EMPTY_TURN_RETRIES`. A "logical turn" spans
  // the original user batch plus any router-injected retry nudges, so this is
  // reset only when a real user/reminder batch starts a fresh turn — NOT on the
  // reminder-only iterations the retry itself queues. `validateChannelTurn`
  // increments it before injecting EMPTY_TURN_RETRY_NUDGE and reads it to decide
  // retry-vs-fallback. See the candidate===null branch.
  emptyTurnRetries: number
  // Count of tool-call-leak self-correction re-prompts spent this logical turn,
  // bounded by MAX_TOOL_LEAK_RETRIES. Separate from emptyTurnRetries so the two
  // failure modes can't drain each other's budget. Reset with the rest on a
  // fresh user batch.
  toolLeakRetries: number
  // Latches once a bare-empty `stop` has been classified as empty-stop-after-tool-work
  // this logical turn. The recovery nudge tells the model NOT to re-run its tools, so
  // a compliant retry is expected to land another bare-empty `stop` with NO new tool
  // call — `attemptMadeToolCall` would then be false and the turn would silently bail
  // with budget unspent. Once armed, the cause persists for the turn so later bare-empty
  // stops keep spending the shared retry budget toward the visible fallback. Reset
  // alongside `emptyTurnRetries` on a real user batch only (anti-reloop discipline).
  emptyStopAfterToolWorkArmed: boolean
  // Count of continuation nudges spent on the CURRENT logical turn, bounded by
  // MAX_WILLINGNESS_NUDGES. Reset alongside `emptyTurnRetries` only when a real
  // user batch starts (batch.length > 0), NOT on the reminder-only iteration the
  // nudge itself queues — same anti-reloop discipline as the empty-turn budget.
  willingnessNudges: number
  // Stashed by `installChannelReplyTerminalHook` after a successful
  // `channel_reply` that omitted `more_work_this_turn: true`. Read once
  // by `validateChannelTurn` to decide the continuation nudge. `turnSeq`-stamped
  // (like `skippedTurn`/`skipLockedSendTurn`) so a stale record from an earlier
  // turn can never trigger a nudge on a later one. `null` when no such reply
  // ended this turn.
  lastTerminalReplyCompletion: { turnSeq: number; text?: string; tokens: number } | null
  // Armed after a successful terminal reply. pi-agent-core invokes streamFunction
  // again only after emitting every matching toolResult into its event queue;
  // the wrapper consumes this marker at that awaited provider boundary and
  // returns a local aborted response instead of calling the provider. Event
  // queue ordering then persists every toolResult before the synthetic aborted
  // assistant. Cleared on consumption, stop, or a fresh user turn.
  pendingTerminalReplyStop: { turnSeq: number; tokens: number } | null
  // Stamped by `installChannelReplyTerminalHook` when a successful `channel_reply`
  // set `more_work_this_turn: true` — the machine-readable "I'll keep working this turn"
  // promise. `validateChannelTurn` reads it to recover a turn that made that promise,
  // did more work, then ended on a fresh empty `stop` (dropped its conclusion) —
  // independent of what natural-language phrase the ack used, so a persona speaking
  // any language/register is covered where the willingness phrase table would miss.
  // `turnSeq`-stamped so a stale promise can't fire on a later turn. `sendCount` is
  // `successfulChannelSends` AT the ack (which already counts the ack itself); the
  // recovery fires only while it still equals the live count — a later substantive
  // send (e.g. a `channel_send` final answer) bumps the count and invalidates the
  // promise, so an empty stop after the real answer is NOT re-nudged.
  continueReplyTurn: { turnSeq: number; sendCount: number } | null
  // Stamped by router abort sites and read by `validateChannelTurn` for
  // reason-specific stranded-toolUse recovery logs. `turnSeq`-stamped so stale
  // abort provenance from an earlier turn can never leak into a later retry.
  abortReasonThisTurn: { turnSeq: number; reason: string } | null
  // Set synchronously when a user invokes /stop so user intent supersedes a
  // terminal-reply stamp even while abort delivery or outcome persistence is
  // still in flight. Cleared only when a fresh real-user batch starts.
  userStoppedTurnSeq: number | null
  // One-shot output-token budget for the NEXT `session.prompt()` only.
  // `installChannelOutputCap` reads and clears it per stream call, so it
  // overrides the default backstop for exactly one re-prompt. Set by the
  // empty-turn length-retry branch to CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS
  // and reset to undefined at each fresh user turn so the raised budget cannot
  // leak past the turn that needed it.
  nextPromptMaxTokens: number | undefined
  // Stamped by `markTurnSkipped` (called from the `skip_response` tool)
  // with the current `turnSeq`. Read at the top of `validateChannelTurn`:
  // if it matches the just-completed turn, recovery is skipped entirely
  // (no NO_REPLY check, no Kimi leak check, no assistant-text recovery).
  // The model has explicitly opted out of this turn and we honor that —
  // UNLESS the model also tried a tool-source send this turn (see
  // `skipLockedSendTurn`), in which case the skip was contested and we let
  // recovery run so the contested reply isn't silently dropped. `null` when
  // no skip has been recorded.
  skippedTurn: { turnSeq: number; reason: string } | null
  // Stamped by `send()` with the current `turnSeq` when a tool-source send is
  // DENIED by the skip lock (the model called `skip_response` first, then
  // changed its mind and tried `channel_reply`). The send still stays denied —
  // "commit to silence" is binding for the live send path — but a contested
  // skip must NOT also suppress the post-turn recovery net: the model produced
  // user-facing reply text that the skip short-circuit would otherwise drop on
  // the floor with no retry (the inbound is already drained). When this matches
  // the just-completed turn, `validateChannelTurn` falls through to the normal
  // `recoverableAssistantText` path, which posts the reply via `source:'system'`
  // (subject to the existing NO_REPLY / leak guards). `null` when no skip-locked
  // send was attempted. Compared by `turnSeq` so a stale value can't leak across
  // turns.
  skipLockedSendTurn: number | null
  // Stamped with the current `turnSeq` by `clearSticky` (called from the
  // `channel_disengage` tool). Read in `send()`'s post-delivery grant block: a
  // successful outbound normally re-grants sticky credit to the turn's authors,
  // which would silently re-arm the engagement the model just dropped if it
  // acks ("ok, backing off") via `channel_reply` in the same turn. When this
  // matches the live `turnSeq`, the grant is suppressed so disengage stays
  // binding for the rest of the turn — the same "commit to it within the turn"
  // shape as the skip lock. `null` when no disengage has been recorded.
  // Compared by `turnSeq` so a stale value can't leak across turns.
  disengagedTurn: number | null
  // Stamped with the current `turnSeq` when validateChannelTurn posts the
  // empty-turn fallback (retry exhaustion). Read by the cross-turn signal commit
  // so a fallback turn — which produced no usable assistant reply — does not seed
  // question escalation. Compared by `turnSeq` so a stale value can't leak across
  // turns.
  emptyTurnFallbackTurn: number | null
  // Set when a WILLINGNESS-ACK exhaustion path (empty_stop_after_continue_reply /
  // empty_stop_after_send_ack) would post EMPTY_TURN_FALLBACK_TEXT, but the model
  // just made a machine-readable promise to keep working (`more_work_this_turn: true` /
  // willingness phrase) and did post-ack tool work. Rather than posting the scary
  // "I got stuck" notice synchronously at validateChannelTurn — BEFORE the drain
  // loop runs maybeContinueTodosChannel, which can re-prompt the same logical turn
  // and land the real answer seconds later (the observed production false alarm) —
  // the cause is STAGED here and resolved after that continuation gets its chance:
  // discarded if a genuine reply lands or a continuation is queued, posted exactly
  // once if the turn genuinely stranded. Only the two willingness branches stage;
  // every other fallback path posts immediately as before (they carry no
  // continue-promise). Persists across reminder-only iterations (reset only on a
  // fresh user batch, beside the willingness/retry budgets) so a stage in one
  // iteration survives to the resolution after the next. `sendCountAtStage` is
  // `successfulChannelSends` at stage time — the resolver treats ONLY a send PAST
  // this baseline as a genuine recovery reply, because the willingness-ack that
  // triggered staging already bumped the turn-start count (the empty stop follows
  // a progress ack by definition), so a turn-start baseline would always read as
  // "already replied" and wrongly discard the fallback.
  stagedFallbackCause: { cause: string; sendCountAtStage: number } | null
  // Stamped with `turnSeq` when a formal GitHub review (APPROVE / REQUEST_CHANGES /
  // COMMENT) lands during this LOGICAL turn, via noteGithubReviewOutput off the
  // review-output observer. On a github PR channel the agent's real deliverable is
  // the review — posted through the GitHub API by the bash tool, NOT through
  // channel_reply/channel_send — so it never bumps `successfulChannelSends`. An
  // empty completion afterward would otherwise look like a dead turn and fire the
  // "I got stuck" empty-turn fallback (a real verdict, then a contradictory fallback
  // seconds later). validateChannelTurn reads this to treat such an empty stop as a
  // legitimate silent completion. Reset ONLY on a real user batch (with the retry
  // budgets) so it survives reminder-only retry iterations — the review lands in an
  // EARLIER iteration than the fallback; resetting per-iteration (beside
  // resetReviewTurn) would recreate the bug.
  githubReviewOutputTurn: number | null
  // True once this LOGICAL turn executed any tool. Read only by
  // `maybePostDeferredProviderError`: the provider-error notice exists so a
  // dead turn doesn't leave the human with silence, and a turn that ran tools
  // was not silent — it may already have published a review, a review-thread
  // reply, or any other out-of-band write that never bumps
  // `successfulChannelSends`. Approximating "produced durable output" with
  // "executed a tool" deliberately over-suppresses: an operator log records
  // every suppressed notice, whereas a public "connection dropped" comment
  // stranded above the agent's own successful review cannot be taken back. A
  // boolean rather than a `turnSeq` stamp so it survives the reminder-only
  // retry iterations that end the turn. Reset ONLY on a real user batch,
  // beside `githubReviewOutputTurn`.
  toolExecutionThisLogicalTurn: boolean
  // Successful, non-communication, non-control tool output observed during
  // this logical turn. Unlike toolExecutionThisLogicalTurn, channel_reply and
  // todo/control calls cannot satisfy a later durable completion claim.
  qualifyingWorkThisLogicalTurn: boolean
  // True while a successful `channel_reply({ more_work_this_turn: true })`
  // promise remains unfulfilled in this LOGICAL turn. Unlike the per-iteration
  // `continueReplyTurn` stamp used by retry authorization and empty-stop
  // recovery, this survives reminder-only iterations so a provider failure
  // cannot mistake earlier tool activity for completed user-visible work after
  // the promise stamp is cleared before the next prompt. A successful terminal
  // `channel_reply` clears it authoritatively; a substantive tool-source send
  // also fulfills it, while a continuation-willingness/status send preserves
  // it. A real user batch resets it beside `toolExecutionThisLogicalTurn`.
  promisedWorkOutstandingThisLogicalTurn: boolean
  // Captured by drain() at batch dequeue; read+cleared by send() on the
  // first tool-source send of the turn. The anchor decision (delay
  // threshold + intervening-observed check) is evaluated at SEND time
  // against this snapshot — not at drain time — because the relevant
  // signal is how long the user waited from inbound to seeing the reply
  // land, which only the send-side clock knows. Cleared after first
  // consumption so multi-part replies anchor only on chunk 1. A new
  // batch overwrites unconditionally.
  pendingQuoteCandidate: QuoteAnchorCandidate | null
  // Loop-guard state. See PEER_BOT_TURNS_WINDOW_MS / MAX_* constants
  // above. Updated in route() on every engaged peer-bot inbound, reset on
  // any human inbound. The two axes (window ring buffer + since-human
  // counter) are independent — either tripping sets `loopGuardActive`
  // until the next human posts. The active flag is read by
  // composeTurnPrompt() and prepended to the user-turn text.
  recentEngagedPeerBotTurns: { authorId: string; ts: number }[]
  consecutiveEngagedPeerBotTurns: number
  loopGuardActive: boolean
  // Set in route() from the same membership+participants the engagement
  // decision used, so the prompt nudge and sticky suppression agree on
  // "is this a multi-human group". Read by composeTurnPrompt().
  multiHumanGroup: boolean
  // True when this live session was born from a cold-start (no persisted
  // session existed — first contact or a stale-rollover after long idle), as
  // opposed to rehydrating an existing session. Combined with `turnSeq === 0`
  // it pinpoints the very first prompt of a freshly woken session.
  createdFromColdStart: boolean
  // Set in route() when the FIRST turn of a cold-start session engages via the
  // solo-human "answer everything" fallback (not an explicit mention/reply/DM,
  // not a multi-human group). Read by validateChannelTurn: a BARE-EMPTY stop on
  // such a turn is a model whiff on a direct one-on-one question, not deliberate
  // silence, so it earns an empty-turn retry instead of a silent no_reply.
  // Recomputed on every engage, so it self-clears once turnSeq leaves the first
  // turn; explicit NO_REPLY / skip_response and any turn that already sent stay
  // on the historical silent path.
  coldStartSoloFallbackTurnActive: boolean
  membershipFetch: Promise<MembershipCount | null> | null
  // Provider soft-error (`stopReason: 'error'`) captured during the current
  // turn, deferred to turn-end. Upstream surfaces transient errors (e.g.
  // `server_is_overloaded`) MID-turn and the turn often recovers, replying
  // seconds later — posting the "⚠️ provider failed" notice on the spot strands
  // a false failure above the eventual real reply. So the listener only RECORDS
  // here (stamped with the firing turnSeq; raw text logged for operators); the
  // turn-end finally posts `safeMessage` ONLY if no reply landed, else discards.
  // First error per turn wins. Keyed by `turnSeq` so a stale record from a
  // crashed prior turn can't leak into the next.
  pendingProviderError: { turnSeq: number; safeMessage: string } | null
  destroyed: boolean
  // Set by tearDownAllLive when a reload/roles/auth swap wants to recreate this
  // session but a turn is mid-flight. Aborting now would strand the in-flight
  // reply (the reload's own turn goes silent). Instead the session stays live
  // and finishes its current reply with pre-reload state; the drain loop's
  // finally tears it down once the turn drains, so the next inbound rehydrates
  // with fresh role/auth/prompt state. Idle sessions are torn down immediately.
  pendingTeardown: boolean
  unsubProviderErrors: (() => void) | null
  unsubTypingActivity: (() => void) | null
  unsubTodoOutcome: (() => void) | null
  // Serializes outcome persistence. The tail always fulfills so one disk
  // failure cannot poison every later turn; its value separately reports
  // whether the latest write succeeded before continuation reads state.
  todoOutcomeWrite: Promise<boolean>
}

// `event` is null for command invocations that originated outside the inbound
// pipeline (e.g. Discord native slash commands fired from listener.on
// ('interaction_create')). Handlers that need a real inbound — for some
// future hypothetical command like `/quote` — must guard on event !== null
// instead of assuming it. `live` is null for session-less commands
// (requiresLiveSession:false, e.g. /help); session-control handlers run only
// after the dispatch layer has resolved a live session, so they may assert it.
type ChannelCommandContext = {
  live: LiveSession | null
  event: InboundMessage | null
  // The user who actually invoked the command, supplied by BOTH dispatch
  // paths (text: event.authorId; native slash: options.invokerId, where
  // event is null). /restart stamps the resume handoff's triggeringAuthorId
  // from this so a restart resumes under the INVOKER's author-scoped role,
  // not whichever speaker happened to own the live turn.
  invokerId: string | null
}

export type ExecuteCommandResult =
  | { kind: 'handled'; name: string; reply?: string }
  | { kind: 'unknown-command'; name: string }
  | { kind: 'no-live-session' }
  | { kind: 'permission-denied' }
  | { kind: 'ambiguous'; matchCount: number }

// Identifies who invoked an adapter-driven command. Required so the router
// can run the same channel.respond permission gate the text-prefix command
// path runs (isChannelRespondDenied in route()). Without it, a guest user
// in a public Slack channel could /stop an owner-created session that
// happened to be live, bypassing role gating entirely.
export type ExecuteCommandOptions = {
  invokerId: string
  parentChat?: string
}

export type SendSource = 'tool' | 'system'

export type SendOptions = TransportSendOptions & {
  source?: SendSource
  // Apply tool-send accounting to the originating conversation while delivering
  // elsewhere. The outbound target remains unchanged; only per-turn cap/dedup,
  // output bookkeeping, and continuation state use this key.
  accountingTarget?: ChannelKey
  // Classifies what the human saw, independently of which router path sent it.
  // Tool calls omit this: substantive text is the default, while the shared
  // multilingual willingness detector recognizes status updates. System paths
  // set it explicitly because recovery prose fulfills promised work whereas
  // provider/fallback/control notices are meta output and must not.
  outputKind?: 'substantive' | 'status' | 'meta'
}

export const DUPLICATE_SEND_ERROR =
  'Duplicate not sent. Do not call channel_send/channel_reply again this turn. ' +
  'End with NO_REPLY unless you have genuinely new, non-redundant information.'

export const TURN_CAP_ERROR =
  `Send-cap reached for this turn (${MAX_CHANNEL_SENDS_PER_TURN} messages already sent to this conversation). ` +
  'End your turn now. The user can prompt you again for more output.'

export const SKIP_RESPONSE_LOCK_ERROR =
  'You called `skip_response` earlier in this turn, which committed to staying silent. ' +
  'Channel sends are blocked for the rest of this turn. End your turn now; if you have ' +
  'something to say, send it on the next turn.'

export type ChannelRouter = {
  route: (event: InboundMessage) => Promise<RouteReceipt>
  send: (msg: OutboundMessage, opts?: SendOptions) => Promise<SendResult>
  acceptBackgroundResponse: (args: {
    parentSessionId: string
    parentSessionFile?: string
    key: ChannelKey
    taskId: string
    subagentName: string
    startedAt: number
    accountIdentity: string
    triggeringAuthorId?: string
    parentChat?: string
  }) => Promise<BackgroundObligationRef>
  suppressUnstartedBackgroundResponse: (ref: BackgroundObligationRef, reason: string) => Promise<void>
  attachBackgroundResultCoverage: (args: { parentSessionId: string; taskId: string }) => Promise<void>
  captureBackgroundResultCoverage?: (parentSessionId: string) => Promise<BackgroundObligationRef[]>
  captureInboundResultCoverage?: (parentSessionId: string) => Promise<InboundRef[]>
  captureTurnAccountIdentity?: (parentSessionId: string) => Promise<string | undefined>
  getConsecutiveSendCount: (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }) => number
  hasQualifyingWorkThisLogicalTurn?: (target: ChannelKey) => boolean
  getSendRate: (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }) => { count: number; windowMs: number }
  registerOutbound: (adapter: ChannelKey['adapter'], cb: OutboundCallback) => void
  unregisterOutbound: (adapter: ChannelKey['adapter'], cb: OutboundCallback) => void
  registerRecoveryAdapter: (adapter: ChannelKey['adapter'], callbacks: RecoveryAdapterCallbacks) => void
  unregisterRecoveryAdapter: (adapter: ChannelKey['adapter'], callbacks: RecoveryAdapterCallbacks) => void
  getRecoveryAccountIdentity: (adapter: ChannelKey['adapter'], workspace?: string) => Promise<string | undefined>
  validateRecovery: (record: RecoveryRecord) => Promise<RecoveryFailure | undefined>
  reconcileRecovery: (record: RecoveryRecord) => Promise<RecoveryReconcileResult>
  setRecoveryStopHandler: (handler: (target: ChannelKey, parentSessionId: string) => Promise<void>) => void
  // Reaction support is opt-in per adapter: an adapter that never calls
  // registerReaction makes `react` resolve to `code: 'unsupported'`, and
  // auto-react-on-engage becomes a silent no-op for it. Kept separate from
  // the outbound path on purpose — reactions are best-effort side effects, not
  // messages, so they must not flow through send()'s flood/cap/dup/sticky guards.
  registerReaction: (adapter: ChannelKey['adapter'], cb: ReactionCallback) => void
  unregisterReaction: (adapter: ChannelKey['adapter'], cb: ReactionCallback) => void
  react: (req: ReactionRequest) => Promise<ReactionResult>
  // Buffer a model-requested reaction for the current turn instead of firing it
  // immediately. It reaches the adapter only if the agent actually replies this
  // turn (drain's finally); a silent/skipped turn discards it. Keeps the bot from
  // leaving reactions on messages it looked at but never answered.
  queueReactionAfterReply: (req: ReactionRequest) => Promise<ReactionResult>
  registerRemoveReaction: (adapter: ChannelKey['adapter'], cb: RemoveReactionCallback) => void
  unregisterRemoveReaction: (adapter: ChannelKey['adapter'], cb: RemoveReactionCallback) => void
  removeReaction: (req: RemoveReactionRequest) => Promise<ReactionResult>
  registerPrepareOwnReaction: (adapter: ChannelKey['adapter'], cb: PrepareOwnReactionCallback) => void
  unregisterPrepareOwnReaction: (adapter: ChannelKey['adapter'], cb: PrepareOwnReactionCallback) => void
  registerRemoveOwnReaction: (adapter: ChannelKey['adapter'], cb: RemoveOwnReactionCallback) => void
  unregisterRemoveOwnReaction: (adapter: ChannelKey['adapter'], cb: RemoveOwnReactionCallback) => void
  removeOwnReaction: (req: RemoveOwnReactionRequest) => Promise<RemoveOwnReactionResult>
  recoverWaitingReactions: (adapter?: ChannelKey['adapter']) => Promise<void>
  registerTyping: (adapter: ChannelKey['adapter'], cb: TypingCallback) => void
  unregisterTyping: (adapter: ChannelKey['adapter'], cb: TypingCallback) => void
  // Deliberately separate from registerTyping: github registers a no-op typing
  // callback (no typing API) yet must stay typing-less, so "has a callback" is
  // the wrong signal. autoReactOnEngage reads this to post :eyes: only as a
  // fallback when no visible typing exists. Unset defaults to false.
  setTypingCapability: (adapter: ChannelKey['adapter'], supported: boolean) => void
  // Override the typing heartbeat interval for one adapter. Adapters whose
  // platform expires the indicator faster than the default TYPING_HEARTBEAT_MS
  // register a shorter interval here so the router paces their refresh; the
  // adapter callback stays stateless. Unset adapters use TYPING_HEARTBEAT_MS.
  setTypingHeartbeatInterval: (adapter: ChannelKey['adapter'], intervalMs: number) => void
  // Set by the manager for every adapter present in typeclaw.json#channels,
  // independent of whether the adapter's start() succeeded (a failed login never
  // registers callbacks). Combined with the adapter's static read-capability set
  // (ADAPTER_READ_CAPABILITIES), fetchHistory/getMessage/listChannels tell three
  // cases apart for a missing callback: not configured → *-not-supported;
  // configured but the capability isn't one this adapter implements →
  // *-not-supported; configured AND the adapter should implement it but no
  // callback is live (e.g. auth failure at startup) → *-adapter-unavailable. So
  // the agent only sees the actionable error when re-auth would actually help.
  // Unset defaults to not-configured.
  setAdapterConfigured: (adapter: ChannelKey['adapter'], configured: boolean) => void
  registerChannelNameResolver: (adapter: ChannelKey['adapter'], resolver: ChannelNameResolver) => void
  unregisterChannelNameResolver: (adapter: ChannelKey['adapter'], resolver: ChannelNameResolver) => void
  // Self-identity is a per-adapter singleton (one bot account per adapter),
  // so unlike the multi-resolver registries above this is last-write-wins:
  // register overwrites, unregister clears only if the current resolver is
  // the one being removed (guards against a late stop() of a replaced adapter
  // wiping a fresh registration).
  registerSelfIdentity: (adapter: ChannelKey['adapter'], resolver: ChannelSelfIdentityResolver) => void
  unregisterSelfIdentity: (adapter: ChannelKey['adapter'], resolver: ChannelSelfIdentityResolver) => void
  registerMembership: (adapter: ChannelKey['adapter'], resolver: MembershipResolver) => void
  unregisterMembership: (adapter: ChannelKey['adapter'], resolver: MembershipResolver) => void
  registerHistory: (adapter: ChannelKey['adapter'], cb: HistoryCallback) => void
  unregisterHistory: (adapter: ChannelKey['adapter'], cb: HistoryCallback) => void
  fetchHistory: (adapter: ChannelKey['adapter'], args: FetchHistoryArgs) => Promise<FetchHistoryResult>
  // Single-message-get and channel-list are opt-in per adapter and last-write-
  // wins (one bot account per adapter). When unregistered, `getMessage` /
  // `listChannels` answer `code: 'not-supported'`, matching `fetchHistory`'s
  // 'history-not-supported' fallback.
  registerMessageGet: (adapter: ChannelKey['adapter'], cb: MessageGetCallback) => void
  unregisterMessageGet: (adapter: ChannelKey['adapter'], cb: MessageGetCallback) => void
  getMessage: (adapter: ChannelKey['adapter'], args: GetMessageArgs) => Promise<GetMessageResult>
  registerList: (adapter: ChannelKey['adapter'], cb: ListCallback) => void
  unregisterList: (adapter: ChannelKey['adapter'], cb: ListCallback) => void
  listChannels: (adapter: ChannelKey['adapter'], args: ListChannelsArgs) => Promise<ListChannelsResult>
  // Message editing is opt-in per adapter, Set-based like reactions/outbound so
  // future multi-account setups can register more than one. A missing callback
  // resolves to `code: 'not-supported'`, or `code: 'adapter-unavailable'` when
  // the static write-capability table (ADAPTER_WRITE_CAPABILITIES) says this
  // adapter edits but no live callback exists (failed start). Kept off the
  // outbound path: an edit mutates an existing post, so it must not flow through
  // send()'s flood/cap/dup/sticky guards.
  registerEditMessage: (adapter: ChannelKey['adapter'], cb: EditMessageCallback) => void
  unregisterEditMessage: (adapter: ChannelKey['adapter'], cb: EditMessageCallback) => void
  editMessage: (req: EditMessageRequest) => Promise<EditMessageResult>
  registerFetchAttachment: (adapter: ChannelKey['adapter'], cb: FetchAttachmentCallback) => void
  unregisterFetchAttachment: (adapter: ChannelKey['adapter'], cb: FetchAttachmentCallback) => void
  fetchAttachment: (adapter: ChannelKey['adapter'], args: FetchAttachmentArgs) => Promise<FetchAttachmentResult>
  // Review-thread resolution is opt-in per adapter and last-write-wins (one
  // bot account per adapter, like self-identity). An adapter that never calls
  // registerReviewThreadResolver makes `resolveReviewThread` answer
  // `unsupported`. Kept off the outbound path: resolving is a side-effect close-
  // out, not a message, so it bypasses send()'s flood/cap/dup/sticky guards.
  registerReviewThreadResolver: (adapter: ChannelKey['adapter'], resolver: ReviewThreadResolver) => void
  unregisterReviewThreadResolver: (adapter: ChannelKey['adapter'], resolver: ReviewThreadResolver) => void
  resolveReviewThread: (req: ReviewThreadResolveRequest) => Promise<ReviewThreadResolveResult>
  // Re-review stranding guard support: answers whether the bot still holds a
  // blocking CHANGES_REQUESTED on a PR. Opt-in per adapter like the thread
  // resolver; `getReviewState` answers `unsupported` when none is registered.
  registerReviewStateResolver: (adapter: ChannelKey['adapter'], resolver: ReviewStateResolver) => void
  unregisterReviewStateResolver: (adapter: ChannelKey['adapter'], resolver: ReviewStateResolver) => void
  getReviewState: (req: ReviewStateRequest) => Promise<ReviewStateResult>
  registerReviewSubmitter: (adapter: ChannelKey['adapter'], submitter: ReviewSubmitter) => void
  unregisterReviewSubmitter: (adapter: ChannelKey['adapter'], submitter: ReviewSubmitter) => void
  submitReview: (req: SubmitReviewRequest) => Promise<SubmitReviewResult>
  lookupInboundAttachment: (args: ChannelKey & { id: number }) => InboundAttachment | null
  listInboundAttachmentIds: (args: ChannelKey) => readonly number[]
  // Stash refs from a channel_history fetch so prior-turn attachments stay
  // resolvable by their placeholder id. Called by the channel_history tool
  // after a successful fetch; no-op when the session is not live.
  registerHistoryAttachments: (key: ChannelKey, messages: readonly ChannelHistoryMessage[]) => void
  // Execute a command by name against an existing live session, bypassing
  // the inbound classifier, engagement gate, debounce, and prompt queue.
  // Used by adapters that receive commands through a native surface
  // (Discord application-command interactions) rather than text. Gates
  // the invoker on channel.respond — same permission gate the text-prefix
  // command path runs — so a guest user cannot abort an owner's session
  // by clicking the slash-command picker. Adapters MUST forward the
  // invoker's platform-specific user id; without it the gate cannot
  // identify the actor and resolves to 'guest' which denies. Returns:
  //   - handled: command ran
  //   - permission-denied: invoker lacks channel.respond
  //   - no-live-session: channel has no active session
  //   - ambiguous: multiple thread-keyed sessions in same chat (Slack);
  //     caller should refuse to act rather than abort an arbitrary one
  //   - unknown-command: name is not registered
  executeCommand: (key: ChannelKey, name: string, options: ExecuteCommandOptions) => Promise<ExecuteCommandResult>
  // Lowered self-aliases (configured + implicit dir-name). Adapters use
  // this to anchor outbound threading on alias-only inbounds — see
  // slack-bot-classify.ts. Read live so a reload of `alias` propagates
  // to adapters without a restart.
  getSelfAliases: () => readonly string[]
  // Inject a `<system-reminder>` block addressed to a live channel session
  // identified by `parentSessionId`. The reminder is rendered into the
  // next turn's user-message body and triggers a drain even if the
  // promptQueue is empty. Returns `delivered` when a matching live
  // session was found and the reminder was queued, `no-live-session`
  // otherwise. Used by the subagent-completion bridge in
  // src/run/index.ts; safe for tests to call directly via a fake router.
  injectSubagentCompletionReminder: (args: {
    parentSessionId: string
    subagent: string
    taskId: string
    ok: boolean
    durationMs: number
    error?: string
    channelKey?: { adapter: string; workspace: string; chat: string; thread: string | null }
  }) => Promise<{ kind: 'delivered'; keyId: string } | { kind: 'no-live-session' }>
  // Fan a LANDED formal review verdict out to the OTHER live sessions reviewing
  // the same PR so they stand down from posting a redundant verdict. Targets every
  // live github session whose chat is `pr:<prNumber>` in `workspace`, EXCLUDING the
  // publisher (`sessionId`). Routes by (workspace, prNumber) across all threads —
  // the duplicate-review fan-out is exactly the per-thread sibling sessions. The
  // injected reminder is advisory (verdict-only stand-down); the hard idempotency
  // guards remain the correctness boundary. Returns how many siblings were nudged.
  injectPrVerdictActivity: (args: {
    workspace: string
    prNumber: number
    verdict: ReviewRoundOutcome
    sessionId: string
  }) => { kind: 'delivered'; count: number }
  abortGithubPrTurn?: (
    workspace: string,
    prNumber: number,
    reason: string,
  ) => Promise<
    | { kind: 'aborted'; matchedSessions: number; matchedReviewers: number; abortFailures: number }
    | { kind: 'no-live-session' }
  >
  completeGithubReviewRound?: (args: {
    workspace: string
    prNumber: number
    verdict: ReviewRoundOutcome
    sessionId: string
    commitSha?: string
  }) => Promise<{ kind: 'completed' | 'no-round' }>
  finishGithubReviewThreadCloseout?: (args: {
    sessionId: string
    workspace: string
    prNumber: number
    thread: string | null
    decision: 'resolved' | 'left-open'
  }) => void
  noteGithubReviewOutput: (args: {
    sessionId: string
    workspace: string
    prNumber: number
    state: ReviewOutputState
    inboundCoverage?: InboundRef[]
    backgroundCoverage?: BackgroundObligationRef[]
  }) => Promise<{ kind: 'stamped' | 'no-live-session' }>
  hasOutstandingGithubReviewThreadCloseout?: (sessionId: string) => boolean
  // Record that the agent invoked `skip_response` during the current turn
  // for the channel session identified by `parentSessionId`. The reason is
  // logged at INFO level inside `validateChannelTurn` (single log line per
  // skip, so operators see exactly one record per silent turn). Stamps the
  // current `turnSeq` on the live session so a stale record from an earlier
  // turn cannot drop a future legitimate reply.
  //
  // Returns:
  //   - 'recorded'      — silence-first: no send had landed this turn, so the
  //                       skip was stamped and later tool-source sends are
  //                       locked out via the send-after-skip guard in `send()`
  //   - 'recorded-after-send' — reply-first: a tool-source channel send already
  //                       landed this turn and the agent is now going quiet for
  //                       the rest of it (the normal ack-then-wait pattern). The
  //                       delivered reply stands; this skip posts nothing and is
  //                       a terminal no-op. NOT stamped as a skipped turn (a
  //                       reply already landed), and logged inline by the impl.
  //   - 'no-live-session' — no matching channel session (e.g. tool fired
  //                         outside a channel origin); the tool should
  //                         still log the reason but cannot suppress.
  markTurnSkipped: (args: {
    parentSessionId: string
    reason: string
  }) => Promise<
    { kind: 'recorded'; keyId: string } | { kind: 'recorded-after-send'; keyId: string } | { kind: 'no-live-session' }
  >
  // Force-clear every sticky credit for one channel key. Stickiness normally
  // expires on TTL or is consumed on the next inbound, but in a busy group each
  // reply re-grants a fresh credit, so the bot can stay force-engaged turn after
  // turn even after being told to stop. This is the escape hatch the
  // `channel_disengage` tool calls to drop back to strict mention/reply/dm
  // engagement without waiting out the window. In-memory only,
  // so a later reply re-grants. `cleared` counts the author credits dropped.
  clearSticky: (key: ChannelKey) => { keyId: string; cleared: number }
  // Two-phase boot restart-resume. Call `reserveRestartHandoff(handoff)` BEFORE
  // `channelManager.start()` to install a per-key gate so an inbound that races
  // the adapters coming online coalesces onto the resume instead of competing
  // with it; then `await reservation.resume()` AFTER start so the reopen + wake
  // reply have registered adapters. Returns null for non-channel handoffs or an
  // unconfigured adapter. `resume()` is safe on a stale/missing mapping — it
  // logs and skips, leaving the todo to resume on the next real inbound.
  reserveRestartHandoff: (handoff: RestartHandoff) => RestartReservation | null
  // Reserve + resume in one call (reserve, then immediately resume). For
  // callers already past adapter startup; prefer the two-phase form at boot.
  resumeRestartHandoff: (handoff: RestartHandoff) => Promise<void>
  stop: () => Promise<void>
  tearDownAllLive: () => Promise<void>
  // Graceful-restart shutdown: mark + abort every live channel session so each
  // scope's incomplete todos auto-continue on the next boot. See the impl.
  markRestartAbortForAllLive: () => Promise<void>
  liveCount: () => number
  __testing?: {
    getRecoveryAccountingSnapshot: (key: ChannelKey) => Record<string, unknown> | undefined
    flushDebounce: (key: ChannelKey) => Promise<void>
    fireTypingHeartbeat: (key: ChannelKey, phase?: 'tick' | 'stop') => Promise<void>
    fireTypingInterval: (key: ChannelKey) => Promise<void>
    fireTypingTick: (key: ChannelKey, epoch: number) => Promise<void>
    typingEpoch: (key: ChannelKey) => number | undefined
    isTypingActive: (key: ChannelKey) => boolean
    stopTyping: (key: ChannelKey) => Promise<void>
    typingHeartbeatIntervalFor: (adapter: ChannelKey['adapter']) => number
    githubReviewRoundFor: (key: ChannelKey) => GithubReviewFollowupRound | null | undefined
    pendingReminderCount: (key: ChannelKey) => number | undefined
    creationTokenCount: () => number
    runIdleGc: () => Promise<void>
    // Returns the seeded author state on the live session matching
    // `key`, or undefined when no live session exists. Tests use this
    // to pin the symmetric-seeding invariant between `lastTurnAuthorId`
    // (string) and `lastTurnAuthorIds` (Set) at session creation —
    // observable directly here rather than via a downstream sticky-
    // credit grant test that would need to coordinate with multiple
    // subsystems.
    getLiveAuthorState: (key: ChannelKey) =>
      | {
          currentTurnAuthorId: string | null
          currentTurnAuthorIds: readonly string[]
          lastTurnAuthorId: string | null
          lastTurnAuthorIds: readonly string[]
        }
      | undefined
    // Pushes a reminder onto the live session's `pendingSystemReminders`, the same
    // seam `runIdleContinuation`'s `deliver` callback uses when the todo/idle
    // continuation fires. Lets a test reproduce the production self-recovery race
    // (a continuation re-prompt queued after a willingness-ack strand) at the
    // channels layer, without coupling to todo-file persistence formats.
    injectContinuationReminder: (key: ChannelKey, text: string) => void
    // Returns a shallow copy of `live.originRef.current` for the live
    // session matching `key`, or undefined when no live session exists.
    // Exists so tests can assert on the per-turn origin that tool.before
    // consumers would see — the origin is normally only observable
    // indirectly via in-flight tool calls, which the fake session doesn't
    // execute. The shallow copy detaches the top-level fields from
    // `originRef` so a later turn replacing `originRef.current` doesn't
    // change a captured assertion. Nested fields (`participants`,
    // `membership`) are still shared by reference; in practice
    // `updateParticipants` returns a fresh array rather than mutating in
    // place, so observed snapshots are stable for the assertions tests
    // make today. NOT a public router method.
    getLiveOriginSnapshot: (key: ChannelKey) => SessionOrigin | undefined
  }
}

// Returns the additional aliases the agent answers to (beyond the
// implicit dir-name). Read from the live config every inbound — `alias`
// is classified `applied` in FIELD_EFFECTS, so a `reload` should change
// engagement behavior immediately. Defaults to an empty list when not
// provided, which means alias-based engagement is effectively off (the
// dir-name is still implicit and added by the router below).
export type AliasesProvider = () => readonly string[]

export type CreateChannelRouterOptions = {
  agentDir: string
  bootEpoch?: string
  backgroundObligations?: BackgroundObligationStore
  inboundJournal?: InboundJournal
  recoveryOutbox?: RecoveryOutbox
  configForAdapter: ConfigForAdapter
  configuredAliases?: AliasesProvider
  createSessionForChannel?: CreateSessionForChannel
  sessionDir?: string
  logger?: RouterLogger
  // Test seam: clock for sticky/debounce/participants. Defaults to Date.now.
  now?: () => number
  // Test seams for synchronizing strict post-tool retry backoff without global
  // random/timer mutation. Production defaults remain Math.random and no hook.
  retryRandom?: () => number
  onRetryBackoffStart?: () => void
  // Test seam: measure a transcript file's byte size for the soft-TTL grace
  // decision. Defaults to a stat()-based reader returning 0 for a missing or
  // unreadable file (grace then fails closed to roll-over-at-soft-TTL).
  measureTranscriptBytes?: (path: string) => number
  // Test seam: the idle/todo continuation driver, invoked from
  // maybeContinueTodosChannel AFTER validateChannelTurn. Defaults to the real
  // runIdleContinuation. Injecting it lets a test deliver the continuation at the
  // exact production phase (post-validation) so the drain-loop ordering —
  // resolveStagedFallback runs AFTER this delivery — is actually asserted, rather
  // than pre-seeding pendingSystemReminders from onPrompt (which would pass even if
  // the resolver moved ahead of the continuation).
  runIdleContinuation?: typeof runIdleContinuation
  // Test seam for holding an outcome write open and asserting drain ordering.
  // Production always uses the real persistence function.
  recordTurnOutcome?: typeof recordTurnOutcome
  // Test seam: override the ensureLive watchdog ceiling so the timeout path
  // is exercisable in <100ms instead of the 30s production default.
  ensureLiveTimeoutMs?: number
  // Test seam for expiring a failed reload handoff without waiting for the
  // production retention window.
  handoffRetryRetentionMs?: number
  // Test seam for exercising the per-key retry-buffer capacity without
  // manufacturing a production-sized batch.
  handoffRetryItemLimit?: number
  // Test seam for the retained payload-size guard.
  handoffRetryByteLimit?: number
  // Test seam: per-callback ceiling for channel name resolvers; mirrors the
  // ensureLive seam so timeout paths can be exercised quickly in tests.
  resolveChannelNamesTimeoutMs?: number
  // Test seam: per-callback ceiling for history fetches.
  fetchHistoryTimeoutMs?: number
  // Test seam: bound the session.idle hook chain so the timeout path is
  // exercisable in tens of milliseconds instead of the 30s default.
  sessionIdleTimeoutMs?: number
  // Wake-up gate: every inbound is gated by `permissions.has(partialOrigin,
  // 'channel.respond')` BEFORE ensureLive. Required by the production
  // wiring (manager.ts forwards `pluginsLoaded.permissions`); defaulted
  // to a grant-all service inside the factory so existing direct test
  // instantiations don't need to inject one. The default is intentionally
  // permissive — the manager-to-router seam is the place where production
  // injection is enforced; direct-router tests opt into gate semantics by
  // passing their own service.
  permissions?: PermissionService
  // Optional role-claim handler. When set, the router intercepts DM
  // inbounds whose text contains a claim code BEFORE the channel.respond
  // gate, hands the inbound to the handler, and short-circuits the normal
  // route path (no session creation, no permission check, no engagement
  // pipeline). The handler returns the reply text the router should send
  // back over the same chat, or null to fall through to normal routing
  // when no pending claim window matches.
  claimHandler?: ClaimHandler
  // Optional in-process Stream. When set, every inbound the router sees
  // is published as a tagged broadcast (`kind: 'channel-inbound'`) so the
  // `/inspect` WS endpoint can surface it live and `stream.scan()` can
  // backfill it on subscribe. Decoupled from the routing decision: even
  // permission-denied and role-claim inbounds publish, so the operator
  // can diagnose silent drops from `typeclaw inspect` alone. Omitted in
  // tests that don't care about inspect surfacing.
  stream?: Stream
  // Operate-the-agent command handlers. When set, the router registers the
  // matching channel command (/reload, /restart) gated on session.admin
  // (owner+trusted). Omitted means the command is not registered at all — it
  // won't appear in /help and a text-prefix or native-slash invocation is
  // treated as unknown. Production wiring (src/run/index.ts via the channel
  // manager) supplies both; tests opt in per-case. `onReload` returns a short
  // human-readable summary posted back to the channel; `onRestart` returns a
  // confirmation string (the container exits shortly after, so the reply is
  // best-effort).
  onReload?: () => Promise<string>
  // `ctx` is present only when the /restart command resolved a live session for
  // the invoking channel (wantsLiveSession). When present, the handler should
  // write a channel-origin resume handoff so the originating conversation
  // resumes on the next boot; when absent (cold channel / native slash with no
  // session) it should just bounce the container with no handoff.
  onRestart?: (ctx?: RestartCommandContext) => Promise<string>
  // Test seam: override the sessions.json writer. Defaults to the disk-backed
  // saveChannelSessions (which swallows its own I/O errors). Tests inject a
  // throwing impl to exercise the persist-failure unwind in ensureLive.
  saveChannelSessions?: (agentDir: string, sessions: readonly ChannelSessionRecord[]) => Promise<void>
  // Returns the start time (epoch ms) of the NEWEST still-running background
  // subagent spawned from `sessionId`, or null when none is running. Lets idle
  // GC and stale-rollover pin a session whose child is still working (the next
  // inbound would otherwise spawn a duplicate child, and a completion arriving
  // after teardown is dropped), bounded only by SESSION_CHILD_STUCK_BACKSTOP_MS
  // measured from that start. Newest — not oldest — so a long-running child that
  // crossed the stuck backstop cannot unpin the session while a more recently
  // spawned child is still inside its window. Production wiring forwards the
  // LiveSubagentRegistry; omitted (tests, no-subagent setups) means no pin.
  newestRunningChildSubagentStartedAt?: (sessionId: string) => number | null
  cancelRunningSubagentsByWorkKey?: (
    workKey: string,
    reason: string,
  ) => Promise<{ matched: number; cancelled: number; failures: number }>
}

export type RestartCommandContext = {
  originatingSessionId: string
  originatingSessionFile?: string
  handoffOrigin: { kind: 'channel'; key: ChannelKey }
  triggeringAuthorId?: string
}

export type ClaimHandlerInput = {
  adapter: ChannelKey['adapter']
  workspace: string
  chat: string
  isDm: boolean
  authorId: string
  text: string
}

export type ClaimHandlerOutcome =
  | { kind: 'consumed'; reply: string }
  | { kind: 'fail'; reply: string }
  | { kind: 'fallthrough' }

// A boot-time restart-resume reservation for one channel key. `resume()` runs
// the real reopen after adapters are ready; `sawInbound` records whether a real
// inbound coalesced onto it in the meantime (in which case the synthetic wake
// is skipped — the inbound already triggers the turn).
export type RestartReservation = {
  keyId: string
  sawInbound: boolean
  resume: () => Promise<void>
  release: () => void
}

export type ClaimHandler = (input: ClaimHandlerInput) => Promise<ClaimHandlerOutcome>

const GRANT_ALL_PERMISSIONS: PermissionService = {
  has: () => true,
  resolveRole: () => 'owner',
  compareRoleSeverity: () => 1,
  permissionsForRole: () => [CORE_PERMISSIONS.channelRespond],
  describe: () => ({ role: 'owner', permissions: [CORE_PERMISSIONS.channelRespond] }),
  replaceRoles: () => {},
}

export function createChannelRouter(options: CreateChannelRouterOptions): ChannelRouter {
  const logger = options.logger ?? consoleLogger
  const now = options.now ?? Date.now
  const backgroundObligations = options.backgroundObligations ?? new BackgroundObligationStore(options.agentDir)
  const inboundJournal = options.inboundJournal ?? new InboundJournal(options.agentDir, { backgroundObligations })
  const ready = inboundJournal.initialize()
  const recoveryOutbox =
    options.recoveryOutbox ?? new RecoveryOutbox(options.agentDir, { epoch: backgroundObligations.epoch })
  void ready.catch((error) => logger.error(`[channels] inbound journal initialization failed: ${describeError(error)}`))
  const measureTranscriptBytes = options.measureTranscriptBytes ?? defaultMeasureTranscriptBytes
  const ensureLiveTimeoutMs = options.ensureLiveTimeoutMs ?? ENSURE_LIVE_TIMEOUT_MS
  const handoffRetryRetentionMs = options.handoffRetryRetentionMs ?? RELOAD_HANDOFF_RETENTION_MS
  const handoffRetryItemLimit = options.handoffRetryItemLimit ?? MAX_PENDING_RELOAD_HANDOFF_ITEMS_PER_KEY
  const handoffRetryByteLimit = options.handoffRetryByteLimit ?? MAX_PENDING_RELOAD_HANDOFF_BYTES_PER_KEY
  const resolveChannelNamesTimeoutMs = options.resolveChannelNamesTimeoutMs ?? RESOLVE_CHANNEL_NAMES_TIMEOUT_MS
  const fetchHistoryTimeoutMs = options.fetchHistoryTimeoutMs ?? FETCH_HISTORY_TIMEOUT_MS
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS
  const permissions = options.permissions ?? GRANT_ALL_PERMISSIONS
  const claimHandler = options.claimHandler
  const stream = options.stream
  const onReload = options.onReload
  const onRestart = options.onRestart
  const newestRunningChildSubagentStartedAt = options.newestRunningChildSubagentStartedAt ?? (() => null)
  const liveSessions = new Map<string, LiveSession>()
  const unsubscribeJournalFailure = inboundJournal.subscribeFailure((error) => {
    // Abort the SDK's active loop synchronously, not session.abort() (which waits
    // for that loop). A failed admission can occur inside another turn's fetch.
    for (const live of liveSessions.values()) {
      if (live.destroyed || !live.promptInFlight) continue
      live.abortReasonThisTurn = { turnSeq: live.turnSeq, reason: 'continuity-unavailable' }
      try {
        live.session.agent.abort()
      } catch (abortError) {
        logger.error(`[channels] continuity cancellation failed: ${describeError(abortError)}`)
      }
    }
    logger.error(`[channels] cancelling in-flight turns after continuity failure: ${describeError(error)}`)
  })
  const creating = new Map<string, Promise<LiveSession>>()
  let nextCreationToken = 0
  const activeCreationAttempts = new Map<string, number>()
  // Unlike `creating`, this marker survives the watchdog cleanup. A timed-out
  // attempt can keep running after a retry claims the key, so only the latest
  // monotonic token may persist, install, or adopt queued handoff work.
  const latestCreationTokens = new Map<string, number>()
  // A deferred reload splices post-reload work off the stale session before it
  // recreates the successor. If that recreation times out, returning from the
  // handoff used to discard the only copy and produce the production symptom
  // "the agent stopped responding." Keep one ordered batch per channel key so
  // the next successful ensureLive adopts it before any newer inbound. Entries
  // expire and the key count is capped; crossing either bound reports the loss
  // to both logs and the channel instead of silently trimming user work.
  const pendingReloadHandoffs = new Map<string, PendingReloadHandoff>()
  // Restart-resume reservations, keyed by channelKeyId. Installed by
  // reserveRestartHandoff BEFORE channel adapters start receiving, so an
  // inbound that races the boot resume coalesces onto the reservation (via the
  // `creating` entry it seeds) instead of stale-rolling the mapping or
  // creating a competing session. `sawInbound` is flipped by route() when an
  // inbound waited on it, which suppresses the synthetic wake (the real inbound
  // is the wake). Cleared when the reservation resolves.
  const restartReservations = new Map<string, RestartReservation>()
  // Bumped by tearDownAllLive() and stop() before they tear sessions down. An
  // in-flight ensureLive() captures the value at creation start and re-checks
  // it right before installing into liveSessions; if it changed, a teardown
  // raced ahead of this creation (e.g. a roles.match reload), so the session
  // was built with stale role context and must self-dispose instead of
  // installing — otherwise it would reintroduce the very staleness the
  // teardown was meant to clear.
  let liveGeneration = 0
  const outboundCallbacks = new Map<ChannelKey['adapter'], Set<OutboundCallback>>()
  const recoveryAdapters = new Map<ChannelKey['adapter'], RecoveryAdapterCallbacks>()
  let recoveryStopHandler: ((target: ChannelKey, parentSessionId: string) => Promise<void>) | undefined
  const reactionCallbacks = new Map<ChannelKey['adapter'], Set<ReactionCallback>>()
  const removeReactionCallbacks = new Map<ChannelKey['adapter'], Set<RemoveReactionCallback>>()
  const prepareOwnReactionCallbacks = new Map<ChannelKey['adapter'], Set<PrepareOwnReactionCallback>>()
  const removeOwnReactionCallbacks = new Map<ChannelKey['adapter'], Set<RemoveOwnReactionCallback>>()
  const typingCallbacks = new Map<ChannelKey['adapter'], Set<TypingCallback>>()
  const typingCapableAdapters = new Set<ChannelKey['adapter']>()
  const typingHeartbeatIntervals = new Map<ChannelKey['adapter'], number>()
  const configuredAdapters = new Set<ChannelKey['adapter']>()
  const channelNameResolvers = new Map<ChannelKey['adapter'], Set<ChannelNameResolver>>()
  const membershipResolvers = new Map<ChannelKey['adapter'], Set<MembershipResolver>>()
  const selfIdentityResolvers = new Map<ChannelKey['adapter'], ChannelSelfIdentityResolver>()
  const membershipCaches = new Map<ChannelKey['adapter'], MembershipCache>()
  const historyCallbacks = new Map<ChannelKey['adapter'], Set<HistoryCallback>>()
  const messageGetCallbacks = new Map<ChannelKey['adapter'], MessageGetCallback>()
  const listCallbacks = new Map<ChannelKey['adapter'], ListCallback>()
  const editMessageCallbacks = new Map<ChannelKey['adapter'], Set<EditMessageCallback>>()
  const fetchAttachmentCallbacks = new Map<ChannelKey['adapter'], Set<FetchAttachmentCallback>>()
  const reviewThreadResolvers = new Map<ChannelKey['adapter'], ReviewThreadResolver>()
  const reviewStateResolvers = new Map<ChannelKey['adapter'], ReviewStateResolver>()
  const reviewSubmitters = new Map<ChannelKey['adapter'], ReviewSubmitter>()
  const stickyLedger = new StickyLedger()
  // The /help handler reads the live registry to enumerate commands, so it
  // forward-references `commands`. Safe at runtime — the handler only runs on
  // invocation, long after the assignment below completes.
  const channelCommands: Command<ChannelCommandContext>[] = [
    {
      name: 'help',
      description: 'List available commands.',
      permission: 'none',
      requiresLiveSession: false,
      handler: () => ({ reply: formatChannelCommandHelp(commands.list()) }),
    },
    {
      name: 'stop',
      description: 'Stop the current agent turn in this channel.',
      permission: 'session.control',
      requiresLiveSession: true,
      handler: async ({ live }) => {
        // requiresLiveSession:true guarantees the dispatch layer resolved a
        // session before running this handler, so `live` is non-null here.
        await stopCurrentChannelTurn(live!, 'user_stop')
        return { reply: STOP_COMMAND_REPLY }
      },
    },
  ]
  // /reload and /restart are registered only when the operate-the-agent
  // callbacks are wired (production via the channel manager). Without them the
  // capability doesn't exist for this router, so the commands stay absent from
  // /help and resolve as unknown — never a silent no-op.
  if (onReload !== undefined) {
    channelCommands.push({
      name: 'reload',
      description: 'Reload typeclaw config and subsystems from disk.',
      permission: 'session.admin',
      requiresLiveSession: false,
      handler: async () => ({ reply: await onReload() }),
    })
  }
  if (onRestart !== undefined) {
    channelCommands.push({
      name: 'restart',
      description: 'Restart the typeclaw container.',
      permission: 'session.admin',
      requiresLiveSession: false,
      // Resolve the live session when one exists so the restart can write a
      // resume handoff for this conversation; still bounces from a cold channel.
      wantsLiveSession: true,
      handler: async ({ live, invokerId }) => ({
        reply: await onRestart(live !== null ? buildRestartCommandContext(live, invokerId) : undefined),
      }),
    })
  }
  const commands = createCommandRegistry<ChannelCommandContext>(channelCommands)

  // Implicit dir-name alias: agent folder basename matches Docker
  // container name (per AGENTS.md), the typical Discord/Slack bot
  // username, and the natural way the operator refers to the agent.
  // Lowered once at construction since basename(agentDir) doesn't change
  // over the router's lifetime; configured aliases are lowered per-call
  // because they're read from live config.
  const dirAlias = basename(options.agentDir).toLocaleLowerCase()
  const computeSelfAliases = (): readonly string[] => {
    const configured = options.configuredAliases?.() ?? []
    const set = new Set<string>([dirAlias])
    for (const a of configured) {
      const lower = a.toLocaleLowerCase()
      if (lower !== '') set.add(lower)
    }
    return Array.from(set)
  }

  let mappings: ChannelSessionRecord[] | null = null
  let loadOnce: Promise<void> | null = null
  let persistChain: Promise<void> = Promise.resolve()
  // Sealed by teardown so no late fire-and-forget caller appends to persistChain
  // after the flush captured it. `await persistChain` only drains what's enqueued
  // when it evaluates; a write appended afterward would still race a caller that
  // deletes the agent dir right after stop() resolves.
  let closing = false

  const ensureLoaded = async (): Promise<void> => {
    if (mappings !== null) return
    if (loadOnce === null) {
      loadOnce = loadChannelSessions(options.agentDir, logger).then((records) => {
        mappings = records
      })
    }
    await loadOnce
  }

  const saveSessions = options.saveChannelSessions
    ? options.saveChannelSessions
    : (agentDir: string, sessions: readonly ChannelSessionRecord[]): Promise<void> =>
        saveChannelSessions(agentDir, sessions, logger)

  const persist = async (): Promise<void> => {
    if (mappings === null || closing) return
    // Caller awaits `next` un-caught to observe write errors; the chain holds the
    // caught version so one rejection can't poison it or escape as unhandled.
    const next = persistChain.then(async () => {
      if (mappings === null) return
      await saveSessions(options.agentDir, mappings)
    })
    persistChain = next.catch(() => {})
    await next
  }

  const persistGithubReviewRound = (live: LiveSession, round: GithubReviewFollowupRound | null): void => {
    if (mappings === null) return
    const idx = mappings.findIndex(
      (record) =>
        record.adapter === live.key.adapter &&
        record.workspace === live.key.workspace &&
        record.chat === live.key.chat &&
        (record.thread ?? null) === (live.key.thread ?? null),
    )
    if (idx < 0) return
    const record = mappings[idx]!
    if (round === null) {
      const { githubReviewRound: _removed, ...rest } = record
      void _removed
      mappings[idx] = rest
    } else {
      const state = githubReviewRoundPersistence(round, now)
      if (state === null) {
        const { githubReviewRound: _expired, ...rest } = record
        void _expired
        mappings[idx] = rest
      } else {
        mappings[idx] = { ...record, githubReviewRound: { ...round, ...state } }
      }
    }
    void persist()
  }

  const persistGithubReviewThreadCloseout = (live: LiveSession, closeout: GithubReviewThreadCloseout | null): void => {
    if (mappings === null) return
    const idx = mappings.findIndex(
      (record) =>
        record.adapter === live.key.adapter &&
        record.workspace === live.key.workspace &&
        record.chat === live.key.chat &&
        (record.thread ?? null) === (live.key.thread ?? null),
    )
    if (idx < 0) return
    const record = mappings[idx]!
    if (closeout === null) {
      const { githubReviewThreadCloseout: _removed, ...rest } = record
      void _removed
      mappings[idx] = rest
    } else {
      mappings[idx] = { ...record, githubReviewThreadCloseout: { ...closeout, deferred: true } }
    }
    void persist()
  }

  const clearGithubReviewThreadCloseout = (live: LiveSession): void => {
    live.githubReviewThreadCloseout = null
    persistGithubReviewThreadCloseout(live, null)
  }

  const createForChannel: CreateSessionForChannel =
    options.createSessionForChannel ??
    (async ({ key, existingSessionId, existingSessionFile, origin, originRef }) => {
      const sessionDir = options.sessionDir ?? `${options.agentDir}/sessions`
      const sessionManager =
        existingSessionId !== undefined
          ? tryOpenSessionManager(options.agentDir, sessionDir, existingSessionId, existingSessionFile, logger)
          : SessionManager.create(options.agentDir, sessionDir)
      const session = await createSession({
        sessionManager,
        origin,
        originRef,
        permissions,
      })
      const sessionId = sessionManager.getSessionId()
      void key
      return {
        session,
        sessionId,
        dispose: async () => {
          session.dispose()
        },
        getTranscriptPath: () => sessionManager.getSessionFile(),
      }
    })

  const resolveChannelNames = async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    const resolvers = channelNameResolvers.get(key.adapter)
    if (!resolvers || resolvers.size === 0) return {}
    const snapshot = Array.from(resolvers)
    const merged: ResolvedChannelNames = {}
    for (const resolver of snapshot) {
      try {
        const result = await raceWithTimeout(
          resolver(key),
          resolveChannelNamesTimeoutMs,
          `[channels] ${channelKeyId(key)}: name resolver`,
        )
        if (result.chatName !== undefined && merged.chatName === undefined) merged.chatName = result.chatName
        if (result.workspaceName !== undefined && merged.workspaceName === undefined) {
          merged.workspaceName = result.workspaceName
        }
      } catch (err) {
        logger.warn(`[channels] name resolver threw for ${channelKeyId(key)}: ${describeError(err)}`)
      }
    }
    return merged
  }

  // Membership is a ROOM property, not a thread property: every human in the
  // parent channel can see and join a thread, so a thread has the same
  // effective human count as its parent channel. The engagement key carries the
  // thread suffix (`channelKeyId`) to give each thread its own live session and
  // sticky ledger, but scoping membership by that same key would give a fresh
  // thread a cold, thread-local count (≤1) and misfire the solo-human fallback.
  // Resolve/cache/invalidate membership under the PARENT-channel key so a thread
  // reuses the channel's warm count. Two platform shapes:
  //   - Slack: the thread ts rides `key.thread`, so stripping it to null reaches
  //     the parent channel (`key.chat` is already the parent).
  //   - Discord: the thread is its OWN channel (`key.chat` = thread id,
  //     `key.thread` = null), so we must repoint `chat` to `room.parentChat`.
  // DMs keep their own key — a DM's `@dm` workspace short-circuits before this.
  const membershipScopeKey = (key: ChannelKey, room?: InboundMessage['room']): ChannelKey => {
    if (key.workspace === '@dm') return key
    if (room?.parentChat !== undefined) return { ...key, chat: room.parentChat, thread: null }
    return key.thread === null ? key : { ...key, thread: null }
  }

  const readMembership = (key: ChannelKey, room?: InboundMessage['room']): MembershipCount | null => {
    if (key.workspace === '@dm') return dmMembership(now())
    const scoped = membershipScopeKey(key, room)
    return membershipCaches.get(scoped.adapter)?.get(scoped) ?? null
  }

  const warmMembership = (key: ChannelKey, room?: InboundMessage['room']): Promise<MembershipCount | null> | null => {
    if (key.workspace === '@dm') return Promise.resolve(dmMembership(now()))
    const scoped = membershipScopeKey(key, room)
    const cache = membershipCaches.get(scoped.adapter)
    if (cache === undefined) return null
    return cache.warmUp(scoped)
  }

  const resolveThroughRegisteredMembership = async (key: ChannelKey): Promise<MembershipResolverResult> => {
    const resolvers = membershipResolvers.get(key.adapter)
    if (!resolvers || resolvers.size === 0) return { kind: 'transient' }
    const snapshot = Array.from(resolvers)
    let lastFailure: MembershipResolverResult = { kind: 'transient' }
    for (const resolver of snapshot) {
      const result = await resolver(key)
      if ('humans' in result) return result
      lastFailure = result
    }
    return lastFailure
  }

  const membershipForPrompt = async (
    key: ChannelKey,
    fetchPromise: Promise<MembershipCount | null> | null,
  ): Promise<MembershipCount | null> => {
    if (key.workspace === '@dm') return dmMembership(now())
    const cached = readMembership(key)
    if (cached !== null) return cached
    if (fetchPromise === null) return null
    return await withMembershipTimeout(fetchPromise, key, logger)
  }

  const membershipForEngagement = async (live: LiveSession): Promise<MembershipCount | null> => {
    if (live.key.workspace === '@dm') return dmMembership(now())
    const scoped = membershipScopeKey(live.key, live.room)
    const cache = membershipCaches.get(scoped.adapter)
    if (cache === undefined) return null

    const cached = cache.read(scoped)
    if (cached.kind === 'hit') return cached.membership
    if (cached.kind === 'stale') {
      void cache.warmUp(scoped).catch((err) => {
        logger.warn(`[channels] membership refresh failed for ${live.keyId}: ${describeError(err)}`)
      })
      return cached.membership
    }

    const fetchPromise = live.membershipFetch ?? warmMembership(live.key, live.room)
    live.membershipFetch = fetchPromise
    if (fetchPromise === null) return null
    const membership = await withMembershipTimeout(fetchPromise, scoped, logger)
    if (live.membershipFetch === fetchPromise) live.membershipFetch = null
    return membership
  }

  // True while a background child spawned from this session is still running AND
  // the newest such child has not outlived the stuck backstop. Using the newest
  // child keeps the session pinned as long as ANY running child is still inside
  // its window — an older child past the backstop must not unpin the session out
  // from under a freshly spawned one. Tearing the session down mid-child lets the
  // next inbound spawn a duplicate child AND drops the child's completion when it
  // lands after teardown, so GC/rollover defer to this. Crossing the backstop is
  // an anomaly (a wedged, timeout-less child), logged at warn. `label` only
  // annotates the override log.
  const isPinnedByRunningChild = (sessionId: string, keyId: string, label: string): boolean => {
    const childStartedAt = newestRunningChildSubagentStartedAt(sessionId)
    if (childStartedAt === null) return false
    const pinnedForMs = now() - childStartedAt
    if (pinnedForMs <= SESSION_CHILD_STUCK_BACKSTOP_MS) return true
    logger.warn(
      `[channels] ${keyId}: ${label} despite running child (newest pinned ${pinnedForMs}ms, past stuck-child backstop; suspected stuck running child)`,
    )
    return false
  }

  // Same question as the GC/rollover pin, asked for a different decision: while a
  // background child is still working (and inside the stuck backstop), an empty
  // completion from the parent is the subagent contract being honored, not the
  // provider degeneration the turn-recovery ladder exists to repair.
  //
  // Turn-scoped, unlike the GC pin, which is deliberately session-scoped. Only
  // the logical turn that spawned the child is waiting on it; a later inbound is
  // unrelated work whose own recovery, todo continuation and staged fallback must
  // still run. Session scope would let one long-running child silence every
  // subsequent turn, and a wedged child would strand them with nothing to revisit
  // them after the backstop expires.
  const isAwaitingBackgroundChild = (
    live: LiveSession,
    label: string,
    startedAt = live.logicalTurnStartedAt,
  ): boolean => {
    const childStartedAt = newestRunningChildSubagentStartedAt(live.sessionId)
    if (childStartedAt === null || childStartedAt < startedAt) return false
    return isPinnedByRunningChild(live.sessionId, live.keyId, label)
  }

  const shouldRolloverLive = (live: LiveSession, idleMs: number): boolean => {
    // A session mid-prompt looks idle by lastInboundAt (only bumped on engaged
    // inbounds) while session.prompt() is still in flight; rolling it over aborts
    // that work. The runIdleGc path skips draining sessions for the same reason.
    if (live.draining) return false
    if (isPinnedByRunningChild(live.sessionId, live.keyId, 'stale-rollover')) return false
    if (idleMs <= SESSION_FRESHNESS_TTL_MS) return false
    if (idleMs > SESSION_GRACE_HARD_TTL_MS) {
      logger.info(`[channels] ${live.keyId}: stale-rollover (live: ${idleMs}ms idle, past grace cap)`)
      return true
    }
    const transcriptPath = live.getTranscriptPath?.()
    const transcriptBytes = transcriptPath !== undefined ? measureTranscriptBytes(transcriptPath) : 0
    const transcriptDeltaBytes = Math.max(0, transcriptBytes - live.baseContextBytes)
    if (isGraceWorthReusing(live.baseContextBytes, transcriptDeltaBytes)) {
      logger.info(
        `[channels] ${live.keyId}: grace-reuse (live: ${idleMs}ms idle, base=${live.baseContextBytes}B delta=${transcriptDeltaBytes}B)`,
      )
      return false
    }
    logger.info(
      `[channels] ${live.keyId}: stale-rollover (live: ${idleMs}ms idle, base=${live.baseContextBytes}B delta=${transcriptDeltaBytes}B)`,
    )
    return true
  }

  const pendingReloadHandoffItemCount = (pending: PendingReloadHandoff): number =>
    pending.inbounds.length +
    pending.observed.length +
    pending.reminders.length +
    (pending.coverage === null ? 0 : pending.coverage.inboundIds.length + pending.coverage.backgroundIds.length)

  const estimateReloadHandoffBytes = (
    inbounds: QueuedInbound[],
    observed: ObservedInbound[],
    reminders: PendingSystemReminder[],
    coverage: PendingReloadCoverage | null,
  ): number => {
    try {
      const serializableInbounds = inbounds.map(({ engageReaction: _engageReaction, ...inbound }) => inbound)
      return Buffer.byteLength(
        JSON.stringify({ inbounds: serializableInbounds, observed, reminders, coverage }),
        'utf8',
      )
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }

  // Every durable identity a handoff owns, for the transfer that ends it
  // without a successor (capacity, expiry, router stop).
  const pendingReloadHandoffInputIds = (pending: PendingReloadHandoff): string[] => [
    ...(pending.coverage?.inboundIds ?? []),
    ...pending.inbounds.flatMap((input) => (input.inputId ? [input.inputId] : [])),
    ...pending.reminders.flatMap((r) => r.inboundRetry?.inputIds ?? []),
  ]

  const pendingReloadHandoffBackgroundIds = (pending: PendingReloadHandoff): string[] => [
    ...(pending.coverage?.backgroundIds ?? []),
    ...pending.reminders.flatMap((r) => [
      ...(r.backgroundObligationId ? [r.backgroundObligationId] : []),
      ...(r.backgroundRetry?.obligationIds ?? []),
    ]),
  ]

  const pendingReloadHandoffTotalBytes = (): number => {
    let total = 0
    for (const pending of pendingReloadHandoffs.values()) total += pending.estimatedBytes
    return total
  }

  const transferLostCoverageInLane = async (
    target: ChannelKey,
    inputIds: readonly string[],
    backgroundIds: readonly string[],
    ownerSessionId?: string,
  ): Promise<void> => {
    await ready
    inboundJournal.assertAvailable()
    // Frozen notices retain the admission's principal, including its original author,
    // grouped by the same partition boot recovery uses for old-epoch rows.
    const groups = new Map<string, { inboundRefs: InboundRef[]; backgroundRefs: BackgroundObligationRef[] }>()
    for (const ref of inboundJournal.resolve([...new Set(inputIds)])) {
      const row = inboundJournal.get(ref.inputId)
      if (!row || row.phase === 'closed' || row.transfer) continue
      const identity = recoveryNoticePartitionKey({
        target,
        accountIdentity: row.accountIdentity,
        principal: row.principal,
        parentSessionId: row.claim?.ownerSessionId ?? ownerSessionId ?? row.sourceParentSessionId,
      })
      let group = groups.get(identity)
      if (!group) {
        group = { inboundRefs: [], backgroundRefs: [] }
        groups.set(identity, group)
      }
      group.inboundRefs.push(ref)
    }
    const backgroundOnly: BackgroundObligationRef[] = []
    for (const id of new Set(backgroundIds)) {
      const row = await backgroundObligations.get(id)
      if (!row || row.phase === 'closed' || row.transfer || channelKeyId(row.target) !== channelKeyId(target)) continue
      const ref = { obligationId: id, generation: row.generation }
      const group = groups.get(
        recoveryNoticePartitionKey({
          target,
          accountIdentity: row.accountIdentity,
          principal: row.principal,
          parentSessionId: row.claim?.ownerSessionId ?? ownerSessionId ?? row.parentSessionId,
        }),
      )
      if (group) group.backgroundRefs.push(ref)
      else backgroundOnly.push(ref)
    }
    for (const group of groups.values()) {
      const record = await inboundJournal.prepareNotice(group.inboundRefs, target, group.backgroundRefs, ownerSessionId)
      await inboundJournal.importPrepared(recoveryOutbox, record)
    }
    for (const ref of backgroundOnly) {
      const prepared = await backgroundObligations.prepareNotice(ref.obligationId, ref.generation)
      if (!prepared?.transfer) continue
      const imported = await recoveryOutbox.import(prepared.transfer)
      await backgroundObligations.ownNotice(prepared.obligationId, prepared.generation, imported.deliveryId)
    }
  }

  const transferMismatchedAccountCoverageInLane = async (live: LiveSession): Promise<string | undefined> => {
    const currentAccount = currentAccountIdentityFor(live.key)
    if (currentAccount === undefined) return undefined
    const inputIds = new Set([
      ...live.inboundCoverage,
      ...live.promptQueue.map((input) => input.inputId),
      ...live.pendingSystemReminders.flatMap((reminder) => reminder.inboundRetry?.inputIds ?? []),
    ])
    const mismatchedInputs = new Set<string>()
    for (const id of inputIds) {
      const row = inboundJournal.get(id)
      if (row && row.accountIdentity !== currentAccount) mismatchedInputs.add(id)
    }
    const backgroundIds = new Set([
      ...live.backgroundCoverage,
      ...live.pendingSystemReminders.flatMap((reminder) => [
        ...(reminder.backgroundObligationId ? [reminder.backgroundObligationId] : []),
        ...(reminder.backgroundRetry?.obligationIds ?? []),
      ]),
    ])
    const mismatchedBackground = new Set<string>()
    for (const id of backgroundIds) {
      const row = await backgroundObligations.get(id)
      if (row && row.accountIdentity !== currentAccount) mismatchedBackground.add(id)
    }
    if (mismatchedInputs.size === 0 && mismatchedBackground.size === 0) return currentAccount
    await transferLostCoverageInLane(live.key, [...mismatchedInputs], [...mismatchedBackground], live.sessionId)
    // Publish only compatible cache entries after the original-account transfer commits.
    const affectedRetries = new Set(
      live.pendingSystemReminders.filter(
        (reminder) =>
          reminder.inboundRetry?.inputIds.some((id) => mismatchedInputs.has(id)) ||
          reminder.backgroundRetry?.obligationIds.some((id) => mismatchedBackground.has(id)),
      ),
    )
    live.promptQueue = live.promptQueue.filter((input) => !mismatchedInputs.has(input.inputId))
    live.inboundCoverage = live.inboundCoverage.filter((id) => !mismatchedInputs.has(id))
    retireBackgroundCache(live, mismatchedBackground)
    live.pendingSystemReminders = live.pendingSystemReminders.filter((reminder) => {
      if (reminder.inboundRetry)
        reminder.inboundRetry.inputIds = reminder.inboundRetry.inputIds.filter((id) => !mismatchedInputs.has(id))
      return (
        !affectedRetries.has(reminder) ||
        (reminder.inboundRetry?.inputIds.length ?? 0) > 0 ||
        (reminder.backgroundRetry?.obligationIds.length ?? 0) > 0
      )
    })
    return currentAccount
  }

  // Shared by the idle (immediate) and mid-drain (deferred tail) reload paths.
  // Queued work and the identities of coverage still deferred to background work
  // (a running child of the deferring turn, or its completion wake already queued)
  // move together into one bounded handoff, so a reload never turns that wait
  // into an interruption notice. Debt the session was not waiting on is an
  // interruption exactly as before. Coverage bound to a replaced account is
  // transferred under that original account first, so a fresh-account successor
  // never inherits it. Whatever the bounds refuse is transferred as lost under
  // its original principal.
  const retainLiveWorkInLane = async (live: LiveSession): Promise<boolean> => {
    await ready
    inboundJournal.assertAvailable()
    await transferMismatchedAccountCoverageInLane(live)
    const hasCoverage = live.inboundCoverage.length > 0 || live.backgroundCoverage.length > 0
    const deferredToBackground =
      hasCoverage &&
      (live.pendingSystemReminders.some((reminder) => reminder.backgroundObligationId !== undefined) ||
        isAwaitingBackgroundChild(live, 'reload-handoff', live.coverageDeferredSince ?? live.logicalTurnStartedAt))
    if (hasCoverage && !deferredToBackground) {
      await transferLostCoverageInLane(live.key, live.inboundCoverage, live.backgroundCoverage, live.sessionId)
      live.inboundCoverage = []
      live.backgroundCoverage = []
    }
    const inbounds = live.promptQueue.slice()
    const observed = live.contextBuffer.slice()
    const reminders = live.pendingSystemReminders.slice()
    const coverage: PendingReloadCoverage | null = deferredToBackground
      ? {
          inboundIds: [...live.inboundCoverage],
          backgroundIds: [...live.backgroundCoverage],
          turnId: live.backgroundTurnId,
          ownerSessionId: live.sessionId,
          logicalTurnStartedAt: live.logicalTurnStartedAt,
          coverageDeferredSince: live.coverageDeferredSince,
          ...(live.turnAccountIdentity !== undefined ? { turnAccountIdentity: live.turnAccountIdentity } : {}),
          lastTurnAuthorId: live.lastTurnAuthorId,
          lastTurnAuthorIds: [...live.lastTurnAuthorIds],
        }
      : null
    const incoming: PendingReloadHandoff = {
      key: live.key,
      sessionId: live.sessionId,
      inbounds,
      observed,
      reminders,
      coverage,
      retainedAt: now(),
      estimatedBytes: estimateReloadHandoffBytes(inbounds, observed, reminders, coverage),
    }
    const hasWork = pendingReloadHandoffItemCount(incoming) > 0
    const retained = hasWork && retainReloadHandoff(incoming)
    if (hasWork && !retained) {
      await transferLostCoverageInLane(
        live.key,
        pendingReloadHandoffInputIds(incoming),
        pendingReloadHandoffBackgroundIds(incoming),
        live.sessionId,
      )
    }
    live.promptQueue.length = 0
    live.contextBuffer.length = 0
    live.pendingSystemReminders.length = 0
    live.inboundCoverage = []
    live.backgroundCoverage = []
    return retained
  }

  // Resolves false when the transfer failed: the rows stay owed and the caller
  // keeps the handoff so the transfer can be retried.
  const reportDiscardedReloadHandoff = async (pending: PendingReloadHandoff, reason: string): Promise<boolean> => {
    logger.error(
      `[channels] ${channelKeyId(pending.key)}: reload handoff unavailable (${pendingReloadHandoffItemCount(pending)} items): ${reason}`,
    )
    let transferred = true
    try {
      await backgroundObligations.withTargetLane(pending.key, () =>
        transferLostCoverageInLane(
          pending.key,
          pendingReloadHandoffInputIds(pending),
          pendingReloadHandoffBackgroundIds(pending),
        ),
      )
    } catch (error) {
      // The durable rows remain owed; failed transfer must never become an ad-hoc send.
      transferred = false
      logger.error(`[channels] reload interruption transfer failed: ${describeError(error)}`)
    }
    void dropPendingReloadHandoffEngageReactions(pending)
    return transferred
  }

  const discardExpiredReloadHandoff = async (
    keyId: string,
    pending: PendingReloadHandoff,
    ageMs: number,
  ): Promise<void> => {
    if (pendingReloadHandoffs.get(keyId) === pending) pendingReloadHandoffs.delete(keyId)
    const transferred = await reportDiscardedReloadHandoff(pending, `retention limit exceeded after ${ageMs}ms`)
    if (!transferred && !pendingReloadHandoffs.has(keyId)) pendingReloadHandoffs.set(keyId, pending)
  }

  const expirePendingReloadHandoffs = async (): Promise<void> => {
    const expired: Array<{ keyId: string; pending: PendingReloadHandoff; ageMs: number }> = []
    for (const [keyId, pending] of pendingReloadHandoffs) {
      const ageMs = now() - pending.retainedAt
      if (ageMs < handoffRetryRetentionMs) continue
      expired.push({ keyId, pending, ageMs })
    }
    await Promise.all(expired.map(({ keyId, pending, ageMs }) => discardExpiredReloadHandoff(keyId, pending, ageMs)))
  }

  const retainReloadHandoff = (incoming: PendingReloadHandoff): boolean => {
    void expirePendingReloadHandoffs()
    const keyId = channelKeyId(incoming.key)
    const existing = pendingReloadHandoffs.get(keyId)
    if (existing !== undefined) {
      // A successor resumes exactly one turn lineage; a second coverage snapshot
      // for the same conversation cannot share its cache.
      if (existing.coverage !== null && incoming.coverage !== null) {
        void reportDiscardedReloadHandoff(incoming, 'reload coverage already pending for this conversation')
        return false
      }
      if (pendingReloadHandoffItemCount(existing) + pendingReloadHandoffItemCount(incoming) > handoffRetryItemLimit) {
        void reportDiscardedReloadHandoff(incoming, `per-key item limit ${handoffRetryItemLimit} would be exceeded`)
        return false
      }
      if (existing.estimatedBytes + incoming.estimatedBytes > handoffRetryByteLimit) {
        void reportDiscardedReloadHandoff(incoming, `per-key byte limit ${handoffRetryByteLimit} would be exceeded`)
        return false
      }
      if (pendingReloadHandoffTotalBytes() + incoming.estimatedBytes > MAX_PENDING_RELOAD_HANDOFF_BYTES_TOTAL) {
        void reportDiscardedReloadHandoff(
          incoming,
          `global byte limit ${MAX_PENDING_RELOAD_HANDOFF_BYTES_TOTAL} would be exceeded`,
        )
        return false
      }
      existing.inbounds.push(...incoming.inbounds)
      existing.observed.push(...incoming.observed)
      existing.reminders.push(...incoming.reminders)
      if (incoming.coverage !== null) existing.coverage = incoming.coverage
      existing.estimatedBytes += incoming.estimatedBytes
      return true
    }
    if (pendingReloadHandoffItemCount(incoming) > handoffRetryItemLimit) {
      void reportDiscardedReloadHandoff(incoming, `per-key item limit ${handoffRetryItemLimit} exceeded`)
      return false
    }
    if (incoming.estimatedBytes > handoffRetryByteLimit) {
      void reportDiscardedReloadHandoff(incoming, `per-key byte limit ${handoffRetryByteLimit} exceeded`)
      return false
    }
    if (pendingReloadHandoffTotalBytes() + incoming.estimatedBytes > MAX_PENDING_RELOAD_HANDOFF_BYTES_TOTAL) {
      void reportDiscardedReloadHandoff(
        incoming,
        `global byte limit ${MAX_PENDING_RELOAD_HANDOFF_BYTES_TOTAL} exceeded`,
      )
      return false
    }
    if (pendingReloadHandoffs.size >= MAX_PENDING_RELOAD_HANDOFF_KEYS) {
      void reportDiscardedReloadHandoff(incoming, `key limit ${MAX_PENDING_RELOAD_HANDOFF_KEYS} reached`)
      return false
    }
    pendingReloadHandoffs.set(keyId, incoming)
    return true
  }

  const adoptPendingReloadHandoff = (live: LiveSession): void => {
    const pending = pendingReloadHandoffs.get(live.keyId)
    if (pending === undefined) return
    const ageMs = now() - pending.retainedAt
    if (ageMs >= handoffRetryRetentionMs) {
      void discardExpiredReloadHandoff(live.keyId, pending, ageMs)
      return
    }
    // Coverage identities join only a session with no turn lineage of its own; a
    // busy session leaves them pending (still bounded by expiry) rather than
    // mixing two lineages in one cache.
    const coverage = pending.coverage
    const adoptCoverage =
      coverage !== null &&
      !live.draining &&
      !live.pendingTeardown &&
      live.inboundCoverage.length === 0 &&
      live.backgroundCoverage.length === 0
    // Delete before enqueueing: once ownership moves to the live queues, a
    // second ensureLive must not replay the same batch and double-deliver it.
    if (coverage !== null && !adoptCoverage) {
      pendingReloadHandoffs.set(live.keyId, {
        ...pending,
        inbounds: [],
        observed: [],
        reminders: [],
        estimatedBytes: estimateReloadHandoffBytes([], [], [], coverage),
      })
    } else {
      pendingReloadHandoffs.delete(live.keyId)
    }
    live.promptQueue.push(...pending.inbounds)
    live.contextBuffer.push(...pending.observed)
    live.pendingSystemReminders.push(...pending.reminders)
    if (adoptCoverage) {
      // Identity caches only. The journal claims stay with the source turn until
      // this session's in-lane consume revalidates and moves them, which happens
      // before any prompt; restoring the source turn keeps that move and any
      // retry lineage valid. A coverage-only handoff never prompts by itself: the
      // child's completion (or the next real input) is what wakes this session.
      live.inboundCoverage = [...coverage.inboundIds]
      live.backgroundCoverage = [...coverage.backgroundIds]
      live.backgroundTurnId = coverage.turnId
      live.logicalTurnStartedAt = coverage.logicalTurnStartedAt
      live.coverageDeferredSince = coverage.coverageDeferredSince
      if (coverage.turnAccountIdentity !== undefined) live.turnAccountIdentity = coverage.turnAccountIdentity
      if (live.lastTurnAuthorId === null && coverage.lastTurnAuthorId !== null) {
        live.lastTurnAuthorId = coverage.lastTurnAuthorId
        live.lastTurnAuthorIds = new Set(coverage.lastTurnAuthorIds)
      }
    }
    if ((pending.inbounds.length > 0 || pending.reminders.length > 0) && !live.draining) void drain(live)
  }

  const ensureLive = async (
    key: ChannelKey,
    triggeringMessageId?: string,
    triggeringAuthorId?: string,
    // Restart-resume only: force rehydration of this exact (sessionId,
    // sessionFile) and bypass stale-rollover, so the originating session's
    // `typeclaw.restart-self` entry is reopened rather than rolled into a fresh
    // session (a restart easily outlasts SESSION_FRESHNESS_TTL_MS). The mapping
    // is persisted only through the normal success path below — no pre-mutation
    // — so a reopen failure leaves the durable mapping untouched.
    resumeTarget?: { sessionId: string; sessionFile: string },
    // Inbound room shape, passed so the COLD-START membership warm below is
    // parent-scoped from the first fetch (Discord threads resolve `chat` to the
    // thread id, so an unscoped warm would prime the cache against the thread).
    room?: InboundMessage['room'],
    // route captures this before journal/account precreation awaits, so a reload
    // during initialization cannot make a pre-reload inbound look newly arrived.
    generation = liveGeneration,
  ): Promise<LiveSession> => {
    const keyId = channelKeyId(key)
    if (generation !== liveGeneration) throw new StaleLiveSessionError(keyId)
    const existing = liveSessions.get(keyId)
    if (existing && !existing.destroyed) {
      // A resume that finds the key already live is a no-op for reopening: the
      // session is up, so just hand it back and let the caller enqueue the wake.
      if (resumeTarget !== undefined) {
        adoptPendingReloadHandoff(existing)
        return existing
      }
      // Rollover decision (soft TTL → cost-aware grace → hard cap) lives in
      // shouldRolloverLive, which also skips draining sessions so a mid-prompt
      // turn is never aborted by a follow-up's idle check (PR #359 incident).
      const idleMs = now() - existing.lastInboundAt
      if (shouldRolloverLive(existing, idleMs)) {
        await tearDownLive(existing)
        liveSessions.delete(keyId)
        if (mappings) {
          const idx = mappings.findIndex(
            (s) =>
              s.adapter === key.adapter &&
              s.workspace === key.workspace &&
              s.chat === key.chat &&
              (s.thread ?? null) === (key.thread ?? null),
          )
          if (idx >= 0) {
            const prev = mappings[idx]!
            mappings[idx] = {
              adapter: prev.adapter,
              workspace: prev.workspace,
              chat: prev.chat,
              thread: prev.thread,
              participants: prev.participants,
              lastInboundAt: 0,
              ...(prev.githubReviewThreadCloseout !== undefined && prev.githubReviewRound !== undefined
                ? { githubReviewRound: prev.githubReviewRound }
                : {}),
              ...(prev.githubReviewThreadCloseout !== undefined
                ? { githubReviewThreadCloseout: prev.githubReviewThreadCloseout }
                : {}),
            }
            await persist()
          }
        }
      } else {
        adoptPendingReloadHandoff(existing)
        return existing
      }
    }

    const inFlight = creating.get(keyId)
    if (inFlight) return inFlight

    const creationToken = ++nextCreationToken
    latestCreationTokens.set(keyId, creationToken)
    activeCreationAttempts.set(keyId, (activeCreationAttempts.get(keyId) ?? 0) + 1)
    const isLatestCreation = (): boolean => latestCreationTokens.get(keyId) === creationToken

    let promise!: Promise<LiveSession>
    promise = (async () => {
      await ensureLoaded()
      const record = mappings ? findRecord(mappings, key) : undefined
      let resolvedRecord = record
      if (
        resumeTarget === undefined &&
        record?.sessionId !== undefined &&
        existing === undefined &&
        now() - (record.lastInboundAt ?? 0) > SESSION_FRESHNESS_TTL_MS &&
        // The live session is already gone here, but a background child it spawned
        // may still be running under its (old) sessionId. Wiping the mapping would
        // start a fresh session that re-spawns the same child. Keep the mapping so
        // the reopen continues the same sessionId until the child finishes (or the
        // pin cap elapses).
        !isPinnedByRunningChild(record.sessionId, keyId, 'stale-rollover (persisted)')
      ) {
        const idleMs = now() - (record.lastInboundAt ?? 0)
        logger.info(`[channels] ${keyId}: stale-rollover (persisted: ${idleMs}ms idle)`)
        resolvedRecord = {
          adapter: record.adapter,
          workspace: record.workspace,
          chat: record.chat,
          thread: record.thread,
          participants: record.participants,
          lastInboundAt: 0,
          ...(record.githubReviewRound !== undefined ? { githubReviewRound: record.githubReviewRound } : {}),
          ...(record.githubReviewThreadCloseout !== undefined
            ? { githubReviewThreadCloseout: record.githubReviewThreadCloseout }
            : {}),
        }
        if (mappings) {
          const idx = mappings.findIndex(
            (s) =>
              s.adapter === key.adapter &&
              s.workspace === key.workspace &&
              s.chat === key.chat &&
              (s.thread ?? null) === (key.thread ?? null),
          )
          if (idx >= 0) {
            mappings[idx] = resolvedRecord
            await persist()
          }
        }
      }
      if (resumeTarget !== undefined) {
        // Reopen the exact originating session in-memory only; the success
        // path below persists it. Carry the prior record's participants when
        // present so the reopened session keeps its roster.
        resolvedRecord = {
          adapter: key.adapter,
          workspace: key.workspace,
          chat: key.chat,
          thread: key.thread,
          sessionId: resumeTarget.sessionId,
          sessionFile: resumeTarget.sessionFile,
          participants: (record?.participants ?? []) as ChannelParticipant[],
          lastInboundAt: now(),
          ...(record?.githubReviewRound !== undefined ? { githubReviewRound: record.githubReviewRound } : {}),
          ...(record?.githubReviewThreadCloseout !== undefined
            ? { githubReviewThreadCloseout: record.githubReviewThreadCloseout }
            : {}),
        }
      }
      const restoredDeferredCloseout = resolvedRecord?.githubReviewThreadCloseout ?? null
      let restoredRound: GithubReviewFollowupRound | null = null
      let restoredRoundStatus: 'pending' | 'completed' | null = null
      if (resolvedRecord?.githubReviewRound !== undefined) {
        if (
          await validateGithubReviewRound(
            resolvedRecord.githubReviewRound,
            resolvedRecord.githubReviewRound.createdAt,
            now,
          )
        ) {
          restoredRoundStatus = resolvedRecord.githubReviewRound.status
          restoredRound = restoreGithubReviewRound(
            resolvedRecord.githubReviewRound,
            restoredRoundStatus,
            resolvedRecord.githubReviewRound.attemptedCarriers,
            resolvedRecord.githubReviewRound.dismissalAttempted === true,
            resolvedRecord.githubReviewRound.requestChangesAttempted === true,
            resolvedRecord.githubReviewRound.createdAt,
            now,
          )
        } else {
          logger.info(
            `[channels] ${keyId}: dropped stale or expired persisted github review round pr=${resolvedRecord.githubReviewRound.workspace}#${resolvedRecord.githubReviewRound.prNumber}`,
          )
        }
      }

      const phase = resolvedRecord?.sessionId === undefined ? 'cold-start' : 'rehydrate'
      logger.info(`[channels] ${keyId}: ensureLive begin (${phase})`)
      const participants = (resolvedRecord?.participants ?? []) as ChannelParticipant[]
      const membershipFetch = warmMembership(key, room)
      // Independent platform lookups — overlap so the chain pays max(), not sum().
      const [resolvedNames, membership] = await Promise.all([
        resolveChannelNames(key),
        membershipForPrompt(key, membershipFetch),
      ])
      logger.info(`[channels] ${keyId}: ensureLive resolved-names-and-membership`)
      // The session-creation origin is what the resource loader sees when it
      // renders the role/permissions block into the system prompt. It must
      // include the triggering author so author-scoped roles
      // (`slack:T/C author:U_ME`) resolve to the same role here that the
      // channel.respond gate just admitted on. Per-turn updates after this
      // point are handled by `originRef.current = buildLiveOrigin(live)`
      // before each prompt() call.
      const self = resolveSelfIdentity(key)
      const origin: SessionOrigin = {
        kind: 'channel',
        adapter: key.adapter,
        workspace: key.workspace,
        ...(resolvedNames.workspaceName !== undefined ? { workspaceName: resolvedNames.workspaceName } : {}),
        chat: key.chat,
        ...(resolvedNames.chatName !== undefined ? { chatName: resolvedNames.chatName } : {}),
        thread: key.thread,
        ...(restoredRound !== null ? { githubReviewRound: restoredRound } : {}),
        ...(room?.parentChat !== undefined ? { parentChat: room.parentChat } : {}),
        ...(room?.parentChatName !== undefined ? { parentChatName: room.parentChatName } : {}),
        ...(triggeringAuthorId !== undefined ? { lastInboundAuthorId: triggeringAuthorId } : {}),
        participants,
        ...(membership !== null ? { membership } : {}),
        ...(self !== undefined ? { self } : {}),
      }

      const isColdStart = resolvedRecord?.sessionId === undefined

      // The router writes into this holder before every prompt() so the
      // tool wrappers' getOrigin() sees the current-turn origin.
      const originRef: { current: SessionOrigin | undefined } = { current: origin }

      const created = await createForChannel({
        key,
        ...(resolvedRecord?.sessionId ? { existingSessionId: resolvedRecord.sessionId } : {}),
        ...(resolvedRecord?.sessionFile ? { existingSessionFile: resolvedRecord.sessionFile } : {}),
        participants,
        origin,
        originRef,
      })
      logger.info(`[channels] ${keyId}: ensureLive session-created sessionId=${created.sessionId}`)

      // A watchdog timeout only releases callers; it cannot cancel the factory.
      // Check the durable per-key token before this late attempt can overwrite
      // the retry's mapping. The `creating` entry is intentionally insufficient:
      // both attempts may have removed their transient entries by now.
      if (!isLatestCreation()) {
        await created.dispose()
        throw new Error(`[channels] ${keyId}: superseded live session creation discarded`)
      }

      const transcriptPath = created.getTranscriptPath?.()
      const persistedRecord: ChannelSessionRecord = {
        adapter: key.adapter,
        workspace: key.workspace,
        chat: key.chat,
        thread: key.thread,
        sessionId: created.sessionId,
        ...(transcriptPath ? { sessionFile: basename(transcriptPath) } : {}),
        lastInboundAt: now(),
        participants,
        ...(restoredRound !== null && restoredRoundStatus !== null
          ? (() => {
              const state = githubReviewRoundPersistence(restoredRound, now)
              return state === null ? {} : { githubReviewRound: { ...restoredRound, ...state } }
            })()
          : {}),
        ...(restoredDeferredCloseout !== null ? { githubReviewThreadCloseout: restoredDeferredCloseout } : {}),
      }
      if (mappings) {
        const idx = mappings.findIndex(
          (s) =>
            s.adapter === key.adapter &&
            s.workspace === key.workspace &&
            s.chat === key.chat &&
            (s.thread ?? null) === (key.thread ?? null),
        )
        if (idx >= 0) mappings[idx] = persistedRecord
        else mappings.push(persistedRecord)
      } else {
        mappings = [persistedRecord]
      }
      // Kick off the mapping write now but don't block on it — the disk write is
      // independent of the synchronous `live` build below and the cold-start
      // network prefetch, so we overlap it. Every exit path below MUST settle
      // `persistPromise` (the immediate .catch is only an unhandled-rejection
      // guard; write errors are still surfaced by awaiting it later).
      const persistPromise = persist()
      void persistPromise.catch(() => {})

      const live: LiveSession = {
        key,
        keyId,
        room,
        session: created.session,
        activeModelRef: resolveFallbackChain(getConfig().models, undefined)[0]!,
        turnThinkingDefault: created.session.thinkingLevel,
        lastQuestionSignal: null,
        pendingUserTurnSignal: null,
        sessionId: created.sessionId,
        dispose: created.dispose,
        hooks: created.hooks,
        getTranscriptPath: created.getTranscriptPath,
        participants,
        resolvedNames,
        originRef,
        githubReviewRound: restoredRound,
        githubReviewThreadCloseout:
          restoredDeferredCloseout === null
            ? null
            : {
                ...restoredDeferredCloseout,
                startedAt: now(),
                correctionAttempts: 0,
                deferred: true,
              },
        githubReviewThreadCloseoutDecisionTurn: null,
        pendingGithubReviewRoundCloseout: null,
        promptQueue: [],
        pendingSystemReminders: [],
        backgroundCoverage: [],
        inboundCoverage: [],
        backgroundStopVersion: 0,
        backgroundTurnId: randomUUID(),
        willingnessReminderIteration: false,
        contextBuffer: [],
        currentTurnAttachments: [],
        historyTimedAttachments: [],
        historyAttachments: [],
        draining: false,
        activeDrains: new Set(),
        debounceTimer: null,
        typingTimer: null,
        typingStartedAt: 0,
        typingTimedOut: false,
        typingStopPromise: null,
        typingEpoch: 0,
        promptInFlight: false,
        lastInboundAt: now(),
        baseContextBytes: 0,
        firstUnprocessedAt: 0,
        currentTurnAuthorId: null,
        currentTurnAuthorIds: new Set(),
        currentTurnReactionRef: null,
        currentTurnExplicitlyAddressed: false,
        currentTurnTypingThread: null,
        dirtyTypingThreads: new Set(),
        currentTurnEngageReactions: [],
        pendingTurnReactions: [],
        silentAckTurn: null,
        activeContinuationReactions: [],
        // `lastTurnAuthorId` (string, used for `lastInboundAuthorId` in
        // origin) and `lastTurnAuthorIds` (Set, used by
        // `grantStickyForReplyTargets` as the fallback when
        // `currentTurnAuthorIds` is empty) are seeded TOGETHER from
        // `triggeringAuthorId`. Seeding only the string would leave the
        // Set empty for the cold-start reminder-only path, which is
        // observable when the agent replies during that turn — `send()`
        // would compute an empty `targetIds` and silently drop the
        // sticky-credit grant for the seeded author. The two fields must
        // stay in sync, so they are written in the same statement.
        lastTurnAuthorIds: triggeringAuthorId !== undefined ? new Set([triggeringAuthorId]) : new Set(),
        lastTurnAuthorId: triggeringAuthorId ?? null,
        consecutiveAborts: 0,
        consecutiveSends: new Map(),
        lastSentText: new Map(),
        lastSendLeafId: null,
        sendTimestamps: new Map(),
        successfulChannelSends: 0,
        turnSeq: 0,
        logicalTurnStartedAt: now(),
        coverageDeferredSince: null,
        successfulSendsAtTurnStart: 0,
        inFlightToolSends: new Map(),
        policyDeniedToolSendsThisTurn: new Map(),
        emptyTurnRetries: 0,
        toolLeakRetries: 0,
        emptyStopAfterToolWorkArmed: false,
        willingnessNudges: 0,
        lastTerminalReplyCompletion: null,
        pendingTerminalReplyStop: null,
        continueReplyTurn: null,
        abortReasonThisTurn: null,
        userStoppedTurnSeq: null,
        nextPromptMaxTokens: undefined,
        skippedTurn: null,
        skipLockedSendTurn: null,
        disengagedTurn: null,
        emptyTurnFallbackTurn: null,
        stagedFallbackCause: null,
        githubReviewOutputTurn: null,
        toolExecutionThisLogicalTurn: false,
        qualifyingWorkThisLogicalTurn: false,
        promisedWorkOutstandingThisLogicalTurn: false,
        pendingQuoteCandidate: null,
        recentEngagedPeerBotTurns: [],
        consecutiveEngagedPeerBotTurns: 0,
        loopGuardActive: false,
        multiHumanGroup: false,
        createdFromColdStart: isColdStart,
        coldStartSoloFallbackTurnActive: false,
        membershipFetch,
        pendingProviderError: null,
        destroyed: false,
        pendingTeardown: false,
        unsubProviderErrors: null,
        unsubTypingActivity: null,
        unsubTodoOutcome: null,
        todoOutcomeWrite: Promise.resolve(true),
      }
      // Raw text is logged on EVERY attempt for operators; the user-facing
      // notice is deferred. The upstream SDK retries internally, and each retry
      // emits its own `message_end` with `stopReason: 'error'` — but the turn
      // frequently recovers and replies anyway. Recording the first error per
      // turn (keyed by `turnSeq`) lets drain()'s turn-end decide: post the
      // notice only if no reply landed, suppress it if the turn recovered. This
      // both dedupes the retry storm AND prevents a stranded false-failure
      // notice above a successful reply. See `pendingProviderError`.
      live.unsubProviderErrors = subscribeProviderErrors(created.session, (err) => {
        logger.error(`[channels] ${live.keyId}: LLM call failed: ${err.message}`)
        if (live.pendingProviderError?.turnSeq === live.turnSeq) return
        live.pendingProviderError = { turnSeq: live.turnSeq, safeMessage: err.safeMessage }
      })
      live.unsubTodoOutcome = created.session.subscribe((event: unknown) => {
        const usage = extractTurnUsage(event)
        if (usage === null) return
        const stampedAbort = live.abortReasonThisTurn
        const termination: 'terminal-after-channel-reply' | undefined =
          usage.stopReason === 'aborted' &&
          live.userStoppedTurnSeq !== live.turnSeq &&
          stampedAbort?.turnSeq === live.turnSeq &&
          stampedAbort.reason === 'terminal_after_channel_reply'
            ? 'terminal-after-channel-reply'
            : undefined
        // Keep the same-turn stamp through validateChannelTurn. Clearing it on
        // the aborted assistant event made the later stranded-toolUse retry log
        // `abort_reason=unknown`, even though this subscriber had just consumed
        // the exact internal reason. A fresh user batch clears the stamp, and
        // every reader also requires a matching turnSeq, so retaining it cannot
        // attribute a later turn to this abort.
        // AgentSession processes message events through one serial queue. By
        // the time this synthetic aborted message_end reaches the subscriber,
        // every preceding toolResult event has completed extension handling
        // and SessionManager persistence. Preserve the original assistant
        // usage rather than recording this local stream's zero-token envelope.
        const terminalCompletion = live.lastTerminalReplyCompletion
        if (termination !== undefined && terminalCompletion?.turnSeq === live.turnSeq) {
          enqueueTodoOutcomeWrite(live, {
            agentDir: options.agentDir,
            origin: buildLiveOrigin(live),
            turnId: live.sessionId,
            stopReason: usage.stopReason,
            termination,
            tokens: terminalCompletion.tokens,
          })
          return
        }
        const outcomeArgs = {
          agentDir: options.agentDir,
          origin: buildLiveOrigin(live),
          turnId: live.sessionId,
          stopReason: usage.stopReason,
          ...(termination !== undefined ? { termination } : {}),
          ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
        }
        enqueueTodoOutcomeWrite(live, outcomeArgs)
      })
      live.unsubTypingActivity = subscribeTypingActivity(created.session, live)
      installChannelReplyTerminalHook(live)
      installChannelOutputCap(live)

      // A teardown (roles reload / shutdown) ran while this session was being
      // built, so it carries stale role context. Dispose it instead of
      // installing — installing here is the exact window the race exploits.
      if (generation !== liveGeneration) {
        logger.info(
          `[channels] ${keyId}: discarding session created across a teardown (gen ${generation} → ${liveGeneration})`,
        )
        await tearDownLive(live)
        // Settle the in-flight mapping write before bailing — preserves the
        // pre-overlap contract that a persist failure fails ensureLive.
        await persistPromise
        throw new StaleLiveSessionError(keyId)
      }
      if (isColdStart) {
        // Install before the slow prefetch so a concurrent teardown/shutdown can
        // see and dispose this session during the network fetch.
        if (!isLatestCreation()) {
          await tearDownLive(live)
          throw new Error(`[channels] ${keyId}: superseded live session creation discarded`)
        }
        liveSessions.set(keyId, live)
        const adapterConfig = options.configForAdapter(key.adapter)
        // Overlap the disk mapping-write with the network history prefetch —
        // they are independent. allSettled lets a persist failure take priority
        // (and unwind the install) even if prefetch also rejects.
        const prefetchPromise = adapterConfig
          ? prefetchChannelContext(live, adapterConfig, triggeringMessageId)
          : Promise.resolve()
        const [persistResult, prefetchResult] = await Promise.allSettled([persistPromise, prefetchPromise])
        if (persistResult.status === 'rejected') {
          await unwindInstalledLive(keyId, live)
          throw persistResult.reason
        }
        if (prefetchResult.status === 'rejected') {
          await unwindInstalledLive(keyId, live)
          throw prefetchResult.reason
        }
        if (adapterConfig) logger.info(`[channels] ${keyId}: ensureLive prefetched-context`)
      } else {
        // Rehydrate has no prefetch to overlap, so settle the mapping write
        // before installing — a failed persist must fail ensureLive without
        // leaving a warm session behind for later inbounds to reuse.
        await persistPromise
        if (!isLatestCreation()) {
          await tearDownLive(live)
          throw new Error(`[channels] ${keyId}: superseded live session creation discarded`)
        }
        liveSessions.set(keyId, live)
      }

      // Snapshot the rendered base context size now, after prefetch and before
      // any user turn, so the soft-TTL grace decision can later compare it
      // against transcript growth. Only meaningful on cold-start (a rehydrated
      // session's file already holds prior conversation, not a clean base).
      const transcriptPathForBase = live.getTranscriptPath?.()
      if (isColdStart && transcriptPathForBase !== undefined) {
        live.baseContextBytes = measureTranscriptBytes(transcriptPathForBase)
      }

      if (!isLatestCreation()) {
        await unwindInstalledLive(keyId, live)
        throw new Error(`[channels] ${keyId}: superseded live session creation discarded`)
      }
      adoptPendingReloadHandoff(live)
      logger.info(`[channels] ${keyId}: ensureLive done (${phase})`)
      return live
    })().finally(() => {
      const remaining = (activeCreationAttempts.get(keyId) ?? 1) - 1
      if (remaining > 0) activeCreationAttempts.set(keyId, remaining)
      else {
        activeCreationAttempts.delete(keyId)
        latestCreationTokens.delete(keyId)
      }
    })

    creating.set(keyId, promise)
    try {
      return await raceWithTimeout(promise, ensureLiveTimeoutMs, `[channels] ${keyId} ensureLive`)
    } catch (err) {
      // A timed-out creation may still settle, but the durable creation token
      // discards it if a later creation has claimed ownership of this key.
      logger.error(`[channels] ${keyId}: ensureLive failed: ${describeError(err)}`)
      throw err
    } finally {
      if (creating.get(keyId) === promise) creating.delete(keyId)
    }
  }

  const prefetchChannelContext = async (
    live: LiveSession,
    adapterConfig: ChannelAdapterConfig,
    triggeringMessageId: string | undefined,
  ): Promise<void> => {
    const prefetch = adapterConfig.history.prefetch
    const isThread = live.key.thread !== null
    const head = isThread ? prefetch.thread.head : 0
    const tail = isThread ? prefetch.thread.tail : prefetch.channel.tail
    if (head === 0 && tail === 0) return

    // One fetch per cold start. We always pass the live thread when present so
    // we get the thread-scoped history; channel cold starts pass `thread: null`
    // so we get the channel scrollback. The router's contract is oldest-first,
    // which lets us slice [head] + [tail] without re-sorting. We over-request
    // by one (head + tail + 1) so we can detect "exactly head + tail" without
    // emitting a misleading elision marker for a zero-length gap.
    const requested = head + tail + 1
    const result = await fetchHistory(live.key.adapter, {
      chat: live.key.chat,
      thread: live.key.thread,
      ...(live.githubReviewRound !== null ? { githubReviewRound: live.githubReviewRound } : {}),
      limit: requested,
      prefetch: true,
    })

    if (!result.ok) {
      // An adapter that declined a best-effort read to avoid hammering a
      // rate-limited resource is expected optional-context loss, not a failure —
      // log it at info so it does not masquerade as an auth/network warning.
      if (result.skipReason === 'rate-limited') {
        logger.info(`[channels] ${live.keyId}: prefetch skipped (rate limited: ${result.error})`)
      } else {
        logger.warn(`[channels] ${live.keyId}: prefetch skipped (history fetch failed: ${result.error})`)
      }
      return
    }

    // Drop the engaging message itself if it appears in the history result.
    // Without this, the model would see the same message twice — once in
    // "Recent context" and once in "Current message". Adapters typically
    // return the latest channel/thread messages, so this overlap is the
    // common case, not the edge case.
    const filteredMessages =
      triggeringMessageId !== undefined
        ? result.messages.filter((m) => m.externalMessageId !== triggeringMessageId)
        : result.messages
    if (filteredMessages.length === 0) return

    const seeded = sliceHeadTail(filteredMessages, head, tail)
    const observed: ObservedInbound[] = []
    for (const item of seeded) {
      if (item.kind === 'message') {
        observed.push({
          text: item.message.text,
          ...(item.message.referenceContext !== undefined ? { referenceContext: item.message.referenceContext } : {}),
          authorId: item.message.authorId,
          authorName: item.message.authorName,
          authorIsBot: item.message.isBot,
          receivedAt: now(),
          ts: item.message.ts,
          source: 'prefetch',
          ...(item.message.attachments !== undefined ? { attachments: item.message.attachments } : {}),
        })
      } else {
        observed.push({
          text: `[… ${item.elidedCount} earlier messages elided; call channel_history for full thread …]`,
          authorId: '__typeclaw_system__',
          authorName: 'TypeClaw',
          authorIsBot: true,
          receivedAt: now(),
          ts: 0,
          source: 'prefetch',
        })
      }
    }

    if (observed.length === 0) return

    // Cold-start prefetch is one-shot and may exceed CONTEXT_BUFFER_SIZE — the
    // 20-message cap exists to bound *runtime* observation drift, not the
    // initial seed. Subsequent observe() calls will trim back to the cap as
    // normal. We push into contextBuffer (not promptQueue) because these are
    // background context for the model, not turns it must respond to.
    live.contextBuffer.push(...observed)
    logger.info(`[channels] ${live.keyId}: prefetched ${observed.length} context messages`)
  }

  const persistParticipants = async (live: LiveSession): Promise<void> => {
    if (mappings === null) return
    const idx = mappings.findIndex(
      (s) =>
        s.adapter === live.key.adapter &&
        s.workspace === live.key.workspace &&
        s.chat === live.key.chat &&
        (s.thread ?? null) === (live.key.thread ?? null),
    )
    if (idx < 0) return
    const next = mappings.slice()
    next[idx] = { ...next[idx]!, participants: live.participants }
    mappings = next
    await persist()
  }

  const fireTyping = async (
    live: LiveSession,
    phase: 'tick' | 'stop',
    epoch?: number,
    typingThreadOverride?: string,
  ): Promise<void> => {
    // Drop a stale 'tick' that a since-cancelled interval still dispatched:
    // once the heartbeat stopped (or a new one started) the captured epoch no
    // longer matches, and forwarding it would re-set the indicator after the
    // stop clear. 'stop' is never epoch-gated — it must always clear. Marking
    // dirty happens after this gate so a dropped tick is never recorded.
    if (phase === 'tick' && epoch !== undefined && epoch !== live.typingEpoch) return
    const callbacks = typingCallbacks.get(live.key.adapter)
    if (!callbacks || callbacks.size === 0) return
    // A 'stop' clears an explicit anchor (fireTypingStop's per-dirty-thread
    // clear); a 'tick' always targets the live turn anchor.
    const typingThread = typingThreadOverride ?? live.currentTurnTypingThread
    if (phase === 'tick' && typingThread !== null) live.dirtyTypingThreads.add(typingThread)
    // Snapshot before iterating: a callback could unregister mid-call.
    const snapshot = Array.from(callbacks)
    const target = {
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      ...(typingThread !== null ? { typingThread } : {}),
      phase,
    }
    await Promise.all(
      snapshot.map((cb) =>
        cb(target).catch((err) => {
          logger.warn(`[channels] typing callback threw for ${live.keyId}: ${describeError(err)}`)
        }),
      ),
    )
    if (phase === 'stop' && typingThread !== null) live.dirtyTypingThreads.delete(typingThread)
  }

  // A 'stop' must clear EVERY flat-DM typingThread a tick set a status on this
  // session — not just the current anchor — or a migrated-away anchor strands
  // its "is typing..." (see `dirtyTypingThreads`). Clears run concurrently; each
  // dirty thread is dispatched once and removed by fireTyping's stop path.
  const fireTypingStop = async (live: LiveSession): Promise<void> => {
    const dirty = new Set(live.dirtyTypingThreads)
    if (live.currentTurnTypingThread !== null) dirty.add(live.currentTurnTypingThread)
    if (dirty.size === 0) {
      await fireTyping(live, 'stop')
      return
    }
    await Promise.all(Array.from(dirty, (typingThread) => fireTyping(live, 'stop', undefined, typingThread)))
  }

  const bumpTypingActivity = (live: LiveSession): void => {
    if (live.typingTimer === null) return
    live.typingStartedAt = now()
  }

  // Re-arm a heartbeat that the silence cap already stopped. PR #930 made
  // streamed deltas refresh the clock, but only via `bumpTypingActivity`,
  // which no-ops once `typingTimer` is null. So a turn that goes silent for
  // >MAX_TYPING_HEARTBEAT_MS (a long single tool call, a slow provider, an
  // extended-thinking phase that emits no deltas) trips the cap, and the
  // delta/tool signals that arrive afterwards can no longer revive it —
  // `startTypingHeartbeat` short-circuits on `typingTimedOut`, which only
  // resets at the next drain() iteration (i.e. never, within one long turn).
  // Reviving here lets demonstrable progress after a timeout bring the
  // indicator back. The revival is gated on streamed activity ONLY, never on
  // a new inbound (a later inbound during the same in-flight turn must stay
  // silenced — see the matching router test).
  //
  // On Slack this is the visible bug: its `'stop'` phase sends a permanent
  // empty-string `setStatus` clear that does not auto-expire, so a tripped
  // indicator stays gone. Discord/Telegram mask the same defect because their
  // native indicators auto-expire and self-heal on the next tick.
  const reviveTypingActivity = (live: LiveSession): void => {
    if (live.destroyed) return
    if (!live.typingTimedOut) {
      bumpTypingActivity(live)
      return
    }
    // A `'stop'` clear may still be in flight. Starting a new heartbeat now
    // would short-circuit on the non-null `typingStopPromise` (losing the
    // revival), and firing a fresh `'tick'` before Slack's empty-string clear
    // lands would let the clear wipe the just-revived status. Defer until the
    // stop settles so the new `'tick'` is ordered strictly after the clear.
    const stopPromise = live.typingStopPromise
    if (stopPromise) {
      void stopPromise.catch(() => undefined).then(() => restartTypingAfterTimeout(live))
      return
    }
    restartTypingAfterTimeout(live)
  }

  const restartTypingAfterTimeout = (live: LiveSession): void => {
    // Re-checked after the awaited stop:
    //  - `destroyed`: the session may have been torn down.
    //  - `!typingTimedOut`: an earlier queued revival already cleared the flag
    //    and re-armed (so this one is a no-op — no double interval/tick).
    //  - `!promptInFlight`: the prompt finished while the cap-trip 'stop' was
    //    still in flight. A revival queued by a late delta would otherwise
    //    re-arm a heartbeat after generation ended — a timer nothing stops
    //    (drain()'s turn-end stop already ran with `typingTimer === null`).
    //    `draining` is too coarse: it stays true through the turn-end hook tail
    //    (turn-end/idle/todos) after `prompt()` returns, so a revival running
    //    in that window would still leak. Gate on active generation instead.
    if (live.destroyed || !live.promptInFlight || !live.typingTimedOut) return
    live.typingTimedOut = false
    startTypingHeartbeat(live)
  }

  const subscribeTypingActivity = (session: AgentSession, live: LiveSession): (() => void) => {
    return session.subscribe((event) => {
      if (event.type === 'tool_execution_end') {
        reviveTypingActivity(live)
        return
      }
      if (event.type !== 'message_update') return
      const streamed = event.assistantMessageEvent.type
      if (streamed === 'text_delta' || streamed === 'thinking_delta') {
        reviveTypingActivity(live)
      }
    })
  }

  // After a successful `channel_reply`, the model has delivered its user-facing
  // response and the turn is semantically done. pi-agent-core otherwise makes
  // one more LLM call after the tool result (the "post-tool follow-up") so real
  // multi-step chains can continue. On a terminal reply there is nothing left
  // to say, and Fireworks' kimi-k2p6-turbo can degenerate that empty follow-up
  // into a 32000-token repetition loop (see CHANNEL_MAX_OUTPUT_TOKENS).
  // Suppress the provider only at its next stream boundary. agent-core reaches
  // that boundary after emitting every toolResult for the batch, and
  // AgentSession preserves the event order even when extensions delay
  // persistence. In the 2026-08-28 Discord incident, aborting from afterToolCall
  // left validation looking at the preceding result as
  // `stranded_toolUse_after_send` and opened a recovery turn after an
  // already-complete reply.
  //
  // Scope is deliberately narrow: only `channel_reply` (the current-chat user-
  // facing response), only on success, and only for channel sessions. Read-only
  // tools and `channel_send` must keep the follow-up so genuine multi-step turns
  // continue. A prior non-typeclaw `afterToolCall` (none today) is composed.
  //
  // `channel_reply({ more_work_this_turn: true })` is the explicit opt-out: a
  // mid-turn status reply ("working on it…") that the model follows with more
  // work this turn. The tool surfaces that intent as
  // `details.more_work_this_turn === true`, and we keep the follow-up so the turn
  // proceeds. The kimi 32k loop only recurs when the model genuinely has nothing
  // left to say after a reply, which `more_work_this_turn` asserts is not the
  // case; Layer 2's maxTokens cap still bounds any misuse.
  // IDs are cache hints, never generation authority. Call only inside the lane.
  const resolveBackgroundCoverage = async (
    live: LiveSession,
    ids: readonly string[],
    ownedOnly = false,
  ): Promise<BackgroundObligationRef[]> => {
    const refs: BackgroundObligationRef[] = []
    for (const id of new Set(ids)) {
      const row = await backgroundObligations.get(id)
      if (
        !row ||
        row.transfer ||
        channelKeyId(row.target) !== live.keyId ||
        (row.phase !== 'result-ready' && row.phase !== 'turn-owned')
      )
        continue
      if (ownedOnly && (row.claim?.turnId !== live.backgroundTurnId || row.claim.ownerSessionId !== live.sessionId))
        continue
      refs.push({ obligationId: id, generation: row.generation })
    }
    if (refs.length > 0) backgroundObligations.assertAvailable()
    return refs
  }

  const retireBackgroundCache = (live: LiveSession, covered: Set<string>): void => {
    live.backgroundCoverage = live.backgroundCoverage.filter((id) => !covered.has(id))
    live.pendingSystemReminders = live.pendingSystemReminders.filter(
      (reminder) => !reminder.backgroundObligationId || !covered.has(reminder.backgroundObligationId),
    )
    for (const reminder of live.pendingSystemReminders) {
      if (reminder.backgroundRetry) {
        reminder.backgroundRetry.obligationIds = reminder.backgroundRetry.obligationIds.filter((id) => !covered.has(id))
      }
    }
  }

  const settleBackgroundCoverageInLane = async (
    live: LiveSession,
    kind: 'delivered' | 'intentionally-suppressed',
    reason: string,
    ids: readonly string[],
    capturedInbound?: readonly InboundRef[],
    capturedBackground?: readonly BackgroundObligationRef[],
  ): Promise<void> => {
    const currentBackground = await resolveBackgroundCoverage(live, ids)
    const refs = capturedBackground
      ? currentBackground.filter((ref) =>
          capturedBackground.some(
            (captured) => captured.obligationId === ref.obligationId && captured.generation === ref.generation,
          ),
        )
      : currentBackground
    const currentInbound = await inboundJournal.resolve(
      capturedInbound ? capturedInbound.map((ref) => ref.inputId) : live.inboundCoverage,
    )
    const inboundRefs = capturedInbound
      ? currentInbound.filter((ref) =>
          capturedInbound.some(
            (captured) => captured.inputId === ref.inputId && captured.generation === ref.generation,
          ),
        )
      : currentInbound
    if (inboundRefs.length > 0) {
      await inboundJournal.settle(inboundRefs, { kind, decisionId: randomUUID(), reason }, refs, live.key)
    } else if (refs.length > 0) {
      inboundJournal.assertAvailable()
      await backgroundObligations.settle(refs, { kind, decisionId: randomUUID(), reason })
    }
    const retiredInbound = new Set(inboundRefs.map((ref) => ref.inputId))
    live.inboundCoverage = live.inboundCoverage.filter((id) => !retiredInbound.has(id))
    retireBackgroundCache(live, new Set(refs.map((ref) => ref.obligationId)))
  }

  const settleBackgroundCoverage = async (
    live: LiveSession,
    kind: 'delivered' | 'intentionally-suppressed',
    reason: string,
    refs?: BackgroundObligationRef[],
    inboundRefs?: readonly InboundRef[],
  ): Promise<void> => {
    await backgroundObligations.withTargetLane(live.key, async () => {
      await settleBackgroundCoverageInLane(
        live,
        kind,
        reason,
        refs ? refs.map((ref) => ref.obligationId) : live.backgroundCoverage,
        inboundRefs,
        refs,
      )
    })
  }

  // A landed response must never be replayed because its local outcome failed.
  const recordLandedBackgroundResponse = async (
    live: LiveSession,
    reason: string,
    refs: BackgroundObligationRef[],
    inboundRefs?: readonly InboundRef[],
  ): Promise<void> => {
    try {
      await settleBackgroundCoverage(live, 'delivered', reason, refs, inboundRefs)
    } catch (error) {
      logger.error(`[channels] background response outcome failed: ${describeError(error)}`)
    }
  }

  const installChannelReplyTerminalHook = (live: LiveSession): void => {
    const { agent } = live.session
    const prior = agent.afterToolCall
    agent.afterToolCall = async (context, signal) => {
      const result = prior ? await prior(context, signal) : undefined
      const details = context.result.details as
        | {
            ok?: unknown
            more_work_this_turn?: unknown
            backgroundCoverage?: BackgroundObligationRef[]
            inboundCoverage?: InboundRef[]
          }
        | undefined
      if (
        isQualifyingWorkResult({
          toolName: context.toolCall.name,
          isError: context.isError,
          details: context.result.details,
        })
      ) {
        live.qualifyingWorkThisLogicalTurn = true
      }
      const succeeded = context.toolCall.name === 'channel_reply' && !context.isError && details?.ok === true
      const keepTurnAlive = details?.more_work_this_turn === true
      if (succeeded) {
        // This hook is authoritative for channel_reply semantics: the send path
        // cannot distinguish channel_reply from channel_send, but here the
        // explicit more_work_this_turn flag tells us whether the delivered reply
        // renewed the promise or terminally fulfilled it.
        const text = (context.toolCall.arguments as { text?: unknown } | undefined)?.text
        if (!keepTurnAlive && !(typeof text === 'string' && detectContinuationWillingness(text))) {
          await recordLandedBackgroundResponse(
            live,
            'terminal-channel-reply',
            details?.backgroundCoverage ?? [],
            details?.inboundCoverage ?? [],
          )
        }
        live.promisedWorkOutstandingThisLogicalTurn = keepTurnAlive
        if (keepTurnAlive) {
          live.continueReplyTurn = { turnSeq: live.turnSeq, sendCount: live.successfulChannelSends }
        }
      }
      // A landed channel_send settles only the debt its tool captured from this
      // session before the send, and the tool returns a capture only for an exact
      // origin destination. A send elsewhere, a no-op success, or a progress/status
      // message never borrows the origin's debt. Unlike channel_reply this stays
      // non-terminal: the follow-up provider call still runs, so the model can keep
      // working after delivering its answer.
      if (context.toolCall.name === 'channel_send' && !context.isError && details?.ok === true) {
        const backgroundCoverage = Array.isArray(details.backgroundCoverage) ? details.backgroundCoverage : []
        const inboundCoverage = Array.isArray(details.inboundCoverage) ? details.inboundCoverage : []
        const text = (context.toolCall.arguments as { text?: unknown } | undefined)?.text
        if (
          (backgroundCoverage.length > 0 || inboundCoverage.length > 0) &&
          !(typeof text === 'string' && detectContinuationWillingness(text))
        ) {
          await recordLandedBackgroundResponse(live, 'origin-channel-send', backgroundCoverage, inboundCoverage)
        }
      }
      if (succeeded && !keepTurnAlive && live.userStoppedTurnSeq !== live.turnSeq) {
        logger.info(
          `[channels] ${live.keyId} terminal_after_channel_reply site=terminal_after_channel_reply session=${live.sessionId} reason=terminal_after_channel_reply`,
        )
        const replyText = (context.toolCall.arguments as { text?: unknown } | undefined)?.text
        live.lastTerminalReplyCompletion = {
          turnSeq: live.turnSeq,
          ...(typeof replyText === 'string' ? { text: replyText } : {}),
          tokens: context.assistantMessage.usage.totalTokens,
        }
        live.pendingTerminalReplyStop = {
          turnSeq: live.turnSeq,
          tokens: context.assistantMessage.usage.totalTokens,
        }
      }
      return result
    }
  }

  // Override pi-ai's model max-tokens default for channel sessions by threading an
  // explicit `maxTokens` into every stream call. pi-ai 0.87.1 clamps the requested
  // value to remaining context (`buildBaseOptions`, simple-options.js:10-18), rather
  // than applying the removed 32k cap. See CHANNEL_MAX_OUTPUT_TOKENS for why.
  // Composes the existing streamFunction (pi's default `Models.streamSimple` unless a
  // proxy was installed). Compaction and branch-summary calls are excluded: pi 0.87.1
  // invokes `agent.streamFunction` for compaction (pi-coding-agent
  // dist/core/agent-session.js:1844) while `isCompacting` remains true
  // (agent-session.js:927-932). They must retain pi's own stream options and cannot
  // consume a channel turn's pending terminal stop or one-shot retry budget.
  // Precedence for channel assistant calls: an explicit per-call `maxTokens` always
  // wins; otherwise a one-shot `live.nextPromptMaxTokens` (set by the empty-turn
  // length-retry) is consumed and cleared so the raised budget applies to exactly one
  // stream call; otherwise the default backstop.
  const installChannelOutputCap = (live: LiveSession): void => {
    const { agent } = live.session
    const inner = agent.streamFunction
    agent.streamFunction = async (model, context, streamOptions) => {
      if (live.session.isCompacting) return await inner(model, context, streamOptions)
      const pendingTerminalStop = live.pendingTerminalReplyStop
      if (pendingTerminalStop?.turnSeq === live.turnSeq && live.userStoppedTurnSeq !== pendingTerminalStop.turnSeq) {
        live.pendingTerminalReplyStop = null
        live.abortReasonThisTurn = {
          turnSeq: pendingTerminalStop.turnSeq,
          reason: 'terminal_after_channel_reply',
        }
        // This boundary runs only after agent-core has emitted all toolResults
        // for the batch. Return a local aborted assistant event instead of
        // entering the provider. Its later message_end is queued behind those
        // result events; that persistence-ordered subscriber records the
        // trusted outcome and original token usage.
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'aborted',
          errorMessage: 'terminal channel reply completed',
          timestamp: Date.now(),
        }
        const stream = createAssistantMessageEventStream()
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'error', reason: 'aborted', error: message })
        return stream
      }
      let maxTokens = streamOptions?.maxTokens
      if (maxTokens === undefined && live.nextPromptMaxTokens !== undefined) {
        maxTokens = live.nextPromptMaxTokens
        live.nextPromptMaxTokens = undefined
      }
      return await inner(model, context, { ...streamOptions, maxTokens: maxTokens ?? CHANNEL_MAX_OUTPUT_TOKENS })
    }
  }

  const startTypingHeartbeat = (live: LiveSession): void => {
    if (live.typingTimedOut || live.typingStopPromise) return
    if (live.destroyed) return
    if (live.typingTimer) {
      bumpTypingActivity(live)
      return
    }
    const epoch = ++live.typingEpoch
    live.typingStartedAt = now()
    // Fire immediately so the indicator appears on the very first inbound,
    // not 8 seconds later.
    void fireTyping(live, 'tick', epoch)
    live.typingTimer = setInterval(() => {
      // A due callback can run one last time after stopTypingHeartbeat's
      // clearInterval; the epoch mismatch makes fireTyping drop the tick so it
      // can't re-set the indicator after the stop clear.
      if (epoch !== live.typingEpoch) return
      if (live.destroyed) {
        void stopTypingHeartbeat(live)
        return
      }
      if (now() - live.typingStartedAt >= MAX_TYPING_HEARTBEAT_MS) {
        logger.warn(
          `[channels] ${live.keyId}: typing indicator paused after ${MAX_TYPING_HEARTBEAT_MS}ms with no activity; prompt still in flight`,
        )
        live.typingTimedOut = true
        void stopTypingHeartbeat(live)
        return
      }
      void fireTyping(live, 'tick', epoch)
    }, typingHeartbeatIntervalFor(live.key.adapter))
  }

  const stopTypingHeartbeat = async (live: LiveSession): Promise<void> => {
    // Bump first, before any early return: a stop must invalidate the current
    // generation so a due-but-not-yet-run interval tick is dropped by
    // fireTyping's epoch guard even if the timer was already cleared.
    live.typingEpoch++
    if (!live.typingTimer) {
      await live.typingStopPromise
      return
    }
    clearInterval(live.typingTimer)
    live.typingTimer = null
    live.typingStartedAt = 0
    // Fire 'stop' phase even when destroyed: adapters need the chance to
    // clear platform-side state (e.g. Slack's 2-min server timeout) on
    // teardown. The FIFO inside the slack adapter ensures this clear lands
    // AFTER any in-flight 'tick' from the heartbeat that just stopped.
    const stopped = fireTypingStop(live).finally(() => {
      if (live.typingStopPromise === stopped) live.typingStopPromise = null
    })
    live.typingStopPromise = stopped
    await stopped
  }

  const fireSessionIdle = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    const work = live.hooks.runSessionIdle({
      sessionId: live.sessionId,
      parentTranscriptPath: live.getTranscriptPath?.(),
      idleMs: 0,
      origin: buildLiveOrigin(live),
    })
    try {
      await raceWithTimeout(work, sessionIdleTimeoutMs, `[channels] ${live.keyId} session.idle`)
    } catch (err) {
      logger.warn(`[channels] session.idle hook threw for ${live.keyId}: ${describeError(err)}`)
    }
  }

  const recordTodoTurnStart = async (live: LiveSession, isRealUserTurn: boolean): Promise<void> => {
    try {
      await recordTurnStart({ agentDir: options.agentDir, origin: buildLiveOrigin(live), isRealUserTurn })
    } catch (err) {
      logger.warn(`[channels] ${live.keyId}: todo turn-start failed: ${describeError(err)}`)
    }
  }

  // After the drain queue empties, push at most one continuation reminder into
  // pendingSystemReminders. The enclosing drain `while` re-checks that array,
  // so the reminder is picked up as a batch-empty (injected, non-user) turn in
  // the same drain pass. The episode guard bounds how many times this can
  // re-fire; a reminder-only turn records isRealUserTurn=false so it never
  // resets the budget.
  const maybeContinueTodosChannel = async (live: LiveSession): Promise<void> => {
    if (live.destroyed) return
    if (live.promptQueue.length > 0 || live.pendingSystemReminders.length > 0) return
    // Joined to the outcome-write chain so a concurrent /stop's durable abort is
    // ORDERED AFTER this decision's own state write instead of racing it. The
    // decision itself awaits disk, so the stop marker is re-read at delivery
    // time too: a user who stops mid-decision must not receive the reminder.
    const decision = live.todoOutcomeWrite.then(async () => {
      try {
        await (options.runIdleContinuation ?? runIdleContinuation)({
          agentDir: options.agentDir,
          origin: buildLiveOrigin(live),
          deliver: (text) => {
            if (live.destroyed || live.userStoppedTurnSeq === live.turnSeq) {
              logger.info(`[channels] ${live.keyId}: dropping todo continuation reminder after user stop`)
              return
            }
            // Self-continuation of the SAME work episode, not external injection:
            // `qualifyingWorkThisLogicalTurn` must survive it so a follow-up reply
            // can still cite the durable work this turn already did.
            live.pendingSystemReminders.push(retryReminder(text))
          },
        })
      } catch (err) {
        logger.warn(`[channels] ${live.keyId}: todo continuation failed: ${describeError(err)}`)
      }
      return true
    })
    live.todoOutcomeWrite = decision
    await decision
  }

  const postEmptyTurnFallback = async (live: LiveSession, cause: string): Promise<void> => {
    logger.warn(`[channels] ${live.keyId} empty_turn_fallback cause=${cause}`)
    live.emptyTurnFallbackTurn = live.turnSeq
    try {
      const inboundCoverage = await captureInboundResultCoverage(live.sessionId)
      const result = await send(
        {
          adapter: live.key.adapter,
          workspace: live.key.workspace,
          chat: live.key.chat,
          thread: live.key.thread,
          text: EMPTY_TURN_FALLBACK_TEXT,
        },
        { source: 'system', outputKind: 'meta' },
      )
      if (!result.ok) {
        logger.warn(`[channels] ${live.keyId}: empty-turn fallback send failed: ${result.error}`)
      } else {
        await recordLandedBackgroundResponse(live, 'empty-turn-fallback', [], inboundCoverage)
      }
    } finally {
      void dropContinuationReactions(live)
    }
  }

  const postGithubReviewThreadCloseoutFallback = async (live: LiveSession): Promise<void> => {
    const obligation = live.githubReviewThreadCloseout
    if (obligation === null) return
    // Consume before sending so adapter failure cannot turn this one-shot
    // fallback into a reminder/fallback loop.
    clearGithubReviewThreadCloseout(live)
    logger.warn(
      `[channels] ${live.keyId} github_thread_closeout_fallback pr=${obligation.prNumber} root=${obligation.rootCommentId}`,
    )
    const result = await send(
      {
        adapter: 'github',
        workspace: obligation.workspace,
        chat: `pr:${obligation.prNumber}`,
        thread: obligation.rootCommentId,
        text: GITHUB_REVIEW_THREAD_CLOSEOUT_FALLBACK_TEXT,
      },
      { source: 'system', outputKind: 'meta' },
    )
    if (!result.ok) {
      logger.warn(`[channels] ${live.keyId}: github review-thread closeout fallback send failed: ${result.error}`)
    }
  }

  const deferredPendingReviewRound = (live: LiveSession): GithubReviewFollowupRound | null => {
    const round = live.githubReviewRound
    if (round === null) return null
    if (round.carrierThread === live.key.thread) return null
    return isGithubReviewRoundPending(round, now) ? round : null
  }

  const isReviewStateUnknownDeferralActive = (closeout: GithubReviewThreadCloseout): boolean =>
    closeout.deferUntil?.kind === 'review-state-unknown' && closeout.deferUntil.expiresAt > now()

  const enforceGithubReviewThreadCloseout = async (live: LiveSession): Promise<void> => {
    const closeout = live.githubReviewThreadCloseout
    if (closeout === null || isAwaitingBackgroundChild(live, 'github-thread-closeout', closeout.startedAt)) {
      return
    }
    if (isReviewStateUnknownDeferralActive(closeout)) {
      if (!closeout.deferred) {
        closeout.deferred = true
        persistGithubReviewThreadCloseout(live, closeout)
      }
      logger.info(
        `[channels] ${live.keyId} github_thread_closeout_deferred pr=${closeout.prNumber} root=${closeout.rootCommentId} reason=review_state_unknown expires_at=${closeout.deferUntil?.expiresAt}`,
      )
      return
    }
    const deferredRound = deferredPendingReviewRound(live)
    if (deferredRound !== null) {
      if (!closeout.deferred) {
        closeout.deferred = true
        persistGithubReviewThreadCloseout(live, closeout)
      }
      // Preserve the anti-strand obligation while the elected carrier acts, but
      // do not convert a legitimate wait into participant-facing process noise.
      logger.info(
        `[channels] ${live.keyId} github_thread_closeout_deferred pr=${closeout.prNumber} root=${closeout.rootCommentId} round=${deferredRound.roundId}`,
      )
      return
    }
    // A queued re-prompt (typically the completion of a reviewer this turn
    // spawned) is the model's next chance to close the thread with real
    // content. Posting the canned fallback now strands the verdict that turn is
    // about to deliver, so re-evaluate at the end of that turn instead.
    if (live.pendingSystemReminders.length > 0 || live.promptQueue.length > 0) {
      logger.info(
        `[channels] ${live.keyId} github_thread_closeout_deferred pr=${closeout.prNumber} root=${closeout.rootCommentId} reason=reprompt_queued`,
      )
      return
    }
    if (live.skippedTurn?.turnSeq === live.turnSeq) live.skippedTurn = null
    if (closeout.correctionAttempts === 0) {
      closeout.correctionAttempts++
      logger.warn(
        `[channels] ${live.keyId} github_thread_closeout_retry attempt=1/1 pr=${closeout.prNumber} root=${closeout.rootCommentId}`,
      )
      live.pendingSystemReminders.push(
        retryReminder(
          `<system-reminder>\nThis session still owes a close-out on GitHub PR #${closeout.prNumber}, ` +
            `review thread root comment ${closeout.rootCommentId}. Your previous turn sent no reply to that thread. ` +
            `Call channel_reply now with an explicit resolve_review_thread choice: true if the concern is addressed, ` +
            `or false to leave it open with the specific technical reason. Send exactly ONE participant-facing ` +
            `close-out message with no narration about internal review rounds, carriers, sessions, verdict registration, ` +
            `or sticky review state. Do not treat a PR-level verdict stand-down as satisfying this thread-level obligation.\n</system-reminder>`,
        ),
      )
      return
    }
    await postGithubReviewThreadCloseoutFallback(live)
  }

  // Resolve a fallback STAGED by a willingness-ack exhaustion path, run AFTER
  // maybeContinueTodosChannel so the idle/todo continuation has already had its
  // chance to queue a re-prompt (the mechanism that self-recovers the promised
  // work). Three outcomes, in precedence order:
  //   1. A genuine reply landed this logical turn (successfulChannelSends moved
  //      past the turn-start baseline; the staged path never posts, so any bump
  //      is real prose) → the model self-recovered, discard the stage silently.
  //   2. A re-prompt is queued (pendingSystemReminders from the continuation, or a
  //      fresh user inbound in promptQueue) → recovery is still in flight or a new
  //      turn supersedes; carry the stage forward to the next resolution (or let
  //      the fresh turn's reset clear it) — do NOT post yet.
  //   3. Neither → the turn genuinely stranded with nothing following it; post the
  //      visible fallback exactly once. This preserves the never-strand-on-silence
  //      invariant for the true-stuck case while killing the production false alarm
  //      where the continuation landed the real answer seconds after the stage.
  const resolveStagedFallback = async (live: LiveSession): Promise<void> => {
    const staged = live.stagedFallbackCause
    if (staged === null) return
    if (live.successfulChannelSends > staged.sendCountAtStage) {
      logger.info(`[channels] ${live.keyId} empty_turn_fallback_discarded cause=${staged.cause} reason=reply_landed`)
      live.stagedFallbackCause = null
      // Recovery genuinely answered the user, so the logical turn ends as a usable
      // reply — commit the question signal the try-block deferred while staged.
      if (live.pendingUserTurnSignal !== null) {
        live.lastQuestionSignal = live.pendingUserTurnSignal.signal
        live.pendingUserTurnSignal = null
      }
      return
    }
    if (live.promptQueue.length > 0 || live.pendingSystemReminders.length > 0) {
      // A re-prompt is still queued: keep both the stage and the pending signal for
      // the next resolution — the turn hasn't finished.
      logger.info(
        `[channels] ${live.keyId} empty_turn_fallback_deferred cause=${staged.cause} reason=continuation_queued`,
      )
      return
    }
    live.stagedFallbackCause = null
    // The fallback IS the turn's terminal (non-usable) output — clear both signals
    // so an older question can't leak the xhigh escalation across this failed turn.
    live.pendingUserTurnSignal = null
    live.lastQuestionSignal = null
    await postEmptyTurnFallback(live, staged.cause)
  }

  const fireSessionTurnStart = async (live: LiveSession, userPrompt: string): Promise<{ results: string }> => {
    const retrievalContext = { results: '' }
    if (!live.hooks) return retrievalContext
    try {
      await live.hooks.runSessionTurnStart({
        sessionId: live.sessionId,
        agentDir: options.agentDir,
        userPrompt,
        origin: buildLiveOrigin(live),
        retrievalContext,
      })
    } catch (err) {
      logger.warn(`[channels] session.turn.start hook threw for ${live.keyId}: ${describeError(err)}`)
    }
    return retrievalContext
  }

  const fireSessionTurnEnd = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    try {
      await live.hooks.runSessionTurnEnd({
        sessionId: live.sessionId,
        agentDir: options.agentDir,
        origin: buildLiveOrigin(live),
      })
    } catch (err) {
      logger.warn(`[channels] session.turn.end hook threw for ${live.keyId}: ${describeError(err)}`)
    }
  }

  const buildRestartCommandContext = (live: LiveSession, invokerId: string | null): RestartCommandContext => {
    // Prefer the command invoker: a restart resumes under the author who ran
    // /restart, not whichever speaker last owned the live turn. Fall back to
    // live turn state only when the dispatch path supplied no invoker.
    const triggeringAuthorId = invokerId ?? live.currentTurnAuthorId ?? live.lastTurnAuthorId ?? undefined
    return {
      originatingSessionId: live.sessionId,
      ...(live.getTranscriptPath?.() !== undefined ? { originatingSessionFile: live.getTranscriptPath!()! } : {}),
      handoffOrigin: { kind: 'channel', key: live.key },
      ...(triggeringAuthorId !== undefined ? { triggeringAuthorId } : {}),
    }
  }

  const buildLiveOrigin = (live: LiveSession): SessionOrigin => {
    const membership = readMembership(live.key, live.room)
    const self = resolveSelfIdentity(live.key)
    return {
      kind: 'channel',
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      ...(live.resolvedNames.workspaceName !== undefined ? { workspaceName: live.resolvedNames.workspaceName } : {}),
      chat: live.key.chat,
      ...(live.resolvedNames.chatName !== undefined ? { chatName: live.resolvedNames.chatName } : {}),
      thread: live.key.thread,
      ...(live.githubReviewRound !== null ? { githubReviewRound: live.githubReviewRound } : {}),
      ...(live.room?.parentChat !== undefined ? { parentChat: live.room.parentChat } : {}),
      ...(live.room?.parentChatName !== undefined ? { parentChatName: live.room.parentChatName } : {}),
      ...(live.currentTurnAuthorId !== null ? { lastInboundAuthorId: live.currentTurnAuthorId } : {}),
      ...(live.currentTurnReactionRef !== null ? { reactionRef: live.currentTurnReactionRef } : {}),
      participants: live.participants,
      ...(membership !== null ? { membership } : {}),
      ...(self !== undefined ? { self } : {}),
    }
  }

  const failoverGithubReviewRound = async (live: LiveSession): Promise<void> => {
    const round = live.githubReviewRound
    if (round === null || isGithubReviewRoundComplete(round, now)) return
    if (hasGithubReviewRoundDismissalAttempt(round, now)) {
      const key = githubReviewRoundKey(round)
      for (const sibling of liveSessions.values()) {
        if (sibling.githubReviewRound !== null && githubReviewRoundKey(sibling.githubReviewRound) === key) {
          persistGithubReviewRound(sibling, sibling.githubReviewRound)
        }
      }
      return
    }
    const carrierIsLive = Array.from(liveSessions.values()).some(
      (candidate) =>
        !candidate.destroyed &&
        candidate.githubReviewRound !== null &&
        githubReviewRoundKey(candidate.githubReviewRound) === githubReviewRoundKey(round) &&
        candidate.key.thread === round.carrierThread,
    )
    if (round.carrierThread !== live.key.thread && carrierIsLive) return

    const candidates = Array.from(liveSessions.values()).filter(
      (candidate) =>
        !candidate.destroyed &&
        candidate.githubReviewRound !== null &&
        githubReviewRoundKey(candidate.githubReviewRound) === githubReviewRoundKey(round) &&
        candidate.key.thread !== round.carrierThread,
    )
    const waiter = candidates
      .filter((candidate) => canPromoteGithubReviewRoundTo(round, candidate.key.thread, now))
      .sort((a, b) => a.keyId.localeCompare(b.keyId))[0]
    if (waiter === undefined) {
      const state = githubReviewRoundPersistence(round, now)
      if (candidates.length === 0) {
        logger.warn(
          `[channels] github review round failover found no live waiter pr=${round.workspace}#${round.prNumber} head=${round.headSha} carrier=${round.carrierThread ?? 'root'}; retry the review after the round expires`,
        )
      } else {
        logger.warn(
          `[channels] github review round exhausted all candidate carriers pr=${round.workspace}#${round.prNumber} head=${round.headSha} carrier=${round.carrierThread ?? 'root'} attempted=${(state?.attemptedCarriers ?? []).map((thread) => thread ?? 'root').join(',')}; retry the review after the round expires`,
        )
      }
      return
    }

    const promoted = promoteGithubReviewRound(round, waiter.key.thread, now)
    if (promoted === null) return
    for (const sibling of liveSessions.values()) {
      if (
        sibling.githubReviewRound !== null &&
        githubReviewRoundKey(sibling.githubReviewRound) === githubReviewRoundKey(round)
      ) {
        sibling.githubReviewRound = promoted
        persistGithubReviewRound(sibling, promoted)
        // Tools read the round off originRef, which is otherwise rebuilt only
        // at turn start. A sibling promoted mid-turn would keep seeing the old
        // carrier and have its own reviewer spawn / verdict denied.
        const origin = sibling.originRef.current
        if (origin?.kind === 'channel') sibling.originRef.current = { ...origin, githubReviewRound: promoted }
      }
    }
    waiter.pendingSystemReminders.push(
      githubReviewRoundWakeupReminder(
        `<system-reminder>\nThe designated sibling ended without a verified formal review verdict. ` +
          `You are now the carrier for PR #${round.prNumber} at ${round.headSha.slice(0, 7)}. ` +
          `Submit exactly one formal verdict for this follow-up round before closing out your thread.\n</system-reminder>`,
        promoted,
      ),
    )
    logger.info(`[channels] ${waiter.keyId}: github review round carrier promoted`)
    if (!waiter.draining) void drain(waiter)
  }

  const enqueueTodoOutcomeWrite = (
    live: LiveSession,
    args: Parameters<typeof recordTurnOutcome>[0],
  ): Promise<boolean> => {
    const write = live.todoOutcomeWrite.then(async () => {
      try {
        await (options.recordTurnOutcome ?? recordTurnOutcome)(args)
        return true
      } catch (err) {
        logger.error(`[channels] ${live.keyId}: todo outcome capture failed: ${describeError(err)}`)
        return false
      }
    })
    live.todoOutcomeWrite = write
    return write
  }

  const awaitLatestTodoOutcomeWrite = async (live: LiveSession): Promise<boolean> => {
    while (true) {
      const write = live.todoOutcomeWrite
      const succeeded = await write
      if (write === live.todoOutcomeWrite) return succeeded
    }
  }

  const fireSessionEnd = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    try {
      await live.hooks.runSessionEnd({ sessionId: live.sessionId })
    } catch (err) {
      logger.warn(`[channels] session.end hook threw for ${live.keyId}: ${describeError(err)}`)
    }
  }

  // User-stop withdrawal for one conversation, independent of any live session:
  // its open, untransferred inbound rows and result-ready/turn-owned background
  // rows settle as intentionally suppressed. Rotation can leave the old actor's
  // active turn beside a new actor's queued input, and a journal decision must
  // keep one account scope, so each account settles separately. `withdrawn`
  // records every group as its decision commits, so a caller can retire exactly
  // those cache entries even when a later group fails. Call only in the lane.
  const withdrawStoppedWorkInLane = async (
    target: ChannelKey,
    inputIds: readonly string[],
    backgroundIds: readonly string[],
    withdrawn: { inbound: Set<string>; background: Set<string> } = { inbound: new Set(), background: new Set() },
  ): Promise<void> => {
    const partitions = new Map<string, { inbound: InboundRef[]; background: BackgroundObligationRef[] }>()
    const partition = (accountIdentity: string) => {
      let group = partitions.get(accountIdentity)
      if (!group) {
        group = { inbound: [], background: [] }
        partitions.set(accountIdentity, group)
      }
      return group
    }
    for (const ref of inboundJournal.resolve([...new Set(inputIds)])) {
      const row = inboundJournal.get(ref.inputId)!
      if (row.phase !== 'closed' && !row.transfer) partition(row.accountIdentity).inbound.push(ref)
    }
    for (const id of new Set(backgroundIds)) {
      const row = await backgroundObligations.get(id)
      if (
        !row ||
        row.transfer ||
        channelKeyId(row.target) !== channelKeyId(target) ||
        (row.phase !== 'result-ready' && row.phase !== 'turn-owned')
      )
        continue
      backgroundObligations.assertAvailable()
      partition(row.accountIdentity).background.push({ obligationId: id, generation: row.generation })
    }
    for (const group of partitions.values()) {
      const outcome = { kind: 'intentionally-suppressed' as const, decisionId: randomUUID(), reason: 'user-stop' }
      if (group.inbound.length > 0) {
        await inboundJournal.settle(group.inbound, outcome, group.background, target)
      } else {
        inboundJournal.assertAvailable()
        await backgroundObligations.settle(group.background, outcome)
      }
      for (const ref of group.inbound) withdrawn.inbound.add(ref.inputId)
      for (const ref of group.background) withdrawn.background.add(ref.obligationId)
    }
  }

  // A reload handoff holds stoppable work only when it carries owed or queued
  // work: queued inputs, reminders or deferred coverage. Observed context alone
  // is the idle bystander hasStoppableWork excludes, so /stop never answers for
  // it, never withdraws it and never posts "stopped" on its behalf.
  const isStoppableReloadHandoff = (pending: PendingReloadHandoff | undefined): pending is PendingReloadHandoff =>
    pending !== undefined && (pending.inbounds.length > 0 || pending.reminders.length > 0 || pending.coverage !== null)

  // After a committed stop withdrawal the handoff keeps only its observed
  // context, which a live stop also leaves in place for the next turn.
  const retireStoppedReloadHandoff = (keyId: string, pending: PendingReloadHandoff): void => {
    if (pendingReloadHandoffs.get(keyId) !== pending) return
    void dropPendingReloadHandoffEngageReactions(pending)
    if (pending.observed.length === 0) {
      pendingReloadHandoffs.delete(keyId)
      return
    }
    pendingReloadHandoffs.set(keyId, {
      ...pending,
      inbounds: [],
      reminders: [],
      coverage: null,
      estimatedBytes: estimateReloadHandoffBytes([], pending.observed, [], null),
    })
  }

  const stopCurrentChannelTurn = async (live: LiveSession, reason: string): Promise<boolean> => {
    await backgroundObligations.withTargetLane(live.key, async () => {
      try {
        if (reason === 'user_stop') {
          // A reload handoff not yet adopted by this session is the same
          // conversation's owed work; the stop withdraws it too.
          const handoff = pendingReloadHandoffs.get(live.keyId)
          const pending = isStoppableReloadHandoff(handoff) ? handoff : undefined
          // Select after predecessors commit; queued entries contain IDs only.
          live.inboundCoverage = [
            ...new Set([
              ...live.inboundCoverage,
              ...live.promptQueue.flatMap((input) => (input.inputId ? [input.inputId] : [])),
              ...live.pendingSystemReminders.flatMap((r) => r.inboundRetry?.inputIds ?? []),
            ]),
          ]
          const withdrawn = { inbound: new Set<string>(), background: new Set<string>() }
          try {
            await withdrawStoppedWorkInLane(
              live.key,
              [...live.inboundCoverage, ...(pending ? pendingReloadHandoffInputIds(pending) : [])],
              [
                ...live.backgroundCoverage,
                ...live.pendingSystemReminders.flatMap((r) =>
                  r.backgroundObligationId ? [r.backgroundObligationId] : [],
                ),
                ...live.pendingSystemReminders.flatMap((r) => r.backgroundRetry?.obligationIds ?? []),
                ...(pending ? pendingReloadHandoffBackgroundIds(pending) : []),
              ],
              withdrawn,
            )
          } finally {
            live.inboundCoverage = live.inboundCoverage.filter((id) => !withdrawn.inbound.has(id))
            retireBackgroundCache(live, withdrawn.background)
          }
          // Retired only once withdrawn: a failed withdrawal keeps it owed.
          if (pending) retireStoppedReloadHandoff(live.keyId, pending)
        }
      } catch (error) {
        // A failed withdrawal remains owed for conservative boot recovery.
        // Bookkeeping must never prevent the user's parent abort.
        logger.error(`[channels] background stop withdrawal failed: ${describeError(error)}`)
      } finally {
        live.backgroundStopVersion++
        live.userStoppedTurnSeq = live.turnSeq
        live.lastTerminalReplyCompletion = null
        live.pendingTerminalReplyStop = null
        live.abortReasonThisTurn = { turnSeq: live.turnSeq, reason }
        clearTimeout(live.debounceTimer ?? undefined)
        live.debounceTimer = null
        live.firstUnprocessedAt = 0
        live.promptQueue.length = 0
        live.pendingSystemReminders.length = 0
        live.continueReplyTurn = null
      }
    })
    if (reason === 'user_stop') {
      try {
        await recoveryStopHandler?.(live.key, live.sessionId)
      } catch (error) {
        logger.error(`[channels] recovery stop withdrawal failed: ${describeError(error)}`)
      }
    }
    void dropContinuationReactions(live)
    enqueueTodoOutcomeWrite(live, {
      agentDir: options.agentDir,
      origin: buildLiveOrigin(live),
      turnId: live.sessionId,
      stopReason: 'aborted',
    })
    void stopTypingHeartbeat(live).catch((error) =>
      logger.warn(`[channels] stop typing failed: ${describeError(error)}`),
    )
    let aborted = true
    try {
      await live.session.abort()
      if (reason === 'user_stop') {
        logger.info(
          `[channels] ${live.keyId}: command /stop aborted current turn site=user_stop session=${live.sessionId} reason=user_stop`,
        )
      } else {
        logger.info(
          `[channels] ${live.keyId}: github PR turn aborted site=github_pr_abort session=${live.sessionId} reason=${JSON.stringify(reason)}`,
        )
      }
    } catch (err) {
      aborted = false
      if (reason === 'user_stop') {
        logger.warn(`[channels] ${live.keyId}: command /stop abort failed: ${describeError(err)}`)
      } else {
        logger.warn(
          `[channels] ${live.keyId}: github PR turn abort failed reason=${JSON.stringify(reason)}: ${describeError(err)}`,
        )
      }
    }
    await awaitLatestTodoOutcomeWrite(live)
    return aborted
  }

  // /stop for a conversation with no live session whose owed work is still a
  // reload handoff (its successor recreate failed or has not installed yet).
  // Withdraws that work by key without recreating a session, so a later
  // successor cannot adopt and answer a stopped request. The handoff is retired
  // only once the withdrawal commits; a failed withdrawal is logged and leaves
  // it owed, the live stop's bookkeeping contract. A successor that installs
  // meanwhile has adopted the handoff's queues, so it is stopped in turn.
  // Resolves false when there was nothing to stop, including a handoff that
  // holds only observed context.
  const stopPendingReloadHandoff = async (keyId: string): Promise<boolean> => {
    const pending = pendingReloadHandoffs.get(keyId)
    if (!isStoppableReloadHandoff(pending)) return false
    const sourceSessionId = await backgroundObligations.withTargetLane(pending.key, async () => {
      const current = pendingReloadHandoffs.get(keyId)
      if (!isStoppableReloadHandoff(current)) return undefined
      try {
        await ready
        inboundJournal.assertAvailable()
        await withdrawStoppedWorkInLane(
          current.key,
          pendingReloadHandoffInputIds(current),
          pendingReloadHandoffBackgroundIds(current),
        )
        retireStoppedReloadHandoff(keyId, current)
      } catch (error) {
        logger.error(`[channels] ${keyId}: reload handoff stop withdrawal failed: ${describeError(error)}`)
      }
      return current.sessionId
    })
    const successor = liveSessions.get(keyId)
    if (successor !== undefined && !successor.destroyed) {
      await stopCurrentChannelTurn(successor, 'user_stop')
      return true
    }
    if (sourceSessionId === undefined) return false
    try {
      await recoveryStopHandler?.(pending.key, sourceSessionId)
    } catch (error) {
      logger.error(`[channels] recovery stop withdrawal failed: ${describeError(error)}`)
    }
    logger.info(`[channels] ${keyId}: command /stop withdrew a pending reload handoff site=user_stop reason=user_stop`)
    return true
  }

  // The exact-key / thread-null-fallback policy of resolveLiveSessionForCommand,
  // applied to reload handoffs no live session has adopted.
  const resolvePendingReloadHandoffForCommand = (
    key: ChannelKey,
  ): { kind: 'found'; keyId: string } | { kind: 'ambiguous'; count: number } | { kind: 'none' } => {
    const exact = channelKeyId(key)
    if (isStoppableReloadHandoff(pendingReloadHandoffs.get(exact))) return { kind: 'found', keyId: exact }
    if (key.thread !== null) return { kind: 'none' }
    const matches = Array.from(pendingReloadHandoffs).filter(
      ([, pending]) =>
        isStoppableReloadHandoff(pending) &&
        pending.key.adapter === key.adapter &&
        pending.key.workspace === key.workspace &&
        pending.key.chat === key.chat,
    )
    if (matches.length > 1) return { kind: 'ambiguous', count: matches.length }
    return matches[0] !== undefined ? { kind: 'found', keyId: matches[0][0] } : { kind: 'none' }
  }

  // ensureLive() installs a session BEFORE the engage/observe decision, so a
  // bystander agent that only OBSERVED a thread still holds an exact-thread
  // session with nothing running. Without this gate that agent aborts its idle
  // session and posts "stopped" in a multi-agent channel. Mirrors exactly what
  // stopCurrentChannelTurn cancels: in-flight drain, queued prompts, reminders.
  const hasStoppableWork = (live: LiveSession): boolean =>
    live.draining || live.promptQueue.length > 0 || live.pendingSystemReminders.length > 0

  const abortGithubPrTurn = async (
    workspace: string,
    prNumber: number,
    reason: string,
  ): Promise<
    | { kind: 'aborted'; matchedSessions: number; matchedReviewers: number; abortFailures: number }
    | { kind: 'no-live-session' }
  > => {
    const chat = `pr:${prNumber}`
    const matchesPr = (live: LiveSession): boolean =>
      !live.destroyed && live.key.adapter === 'github' && live.key.workspace === workspace && live.key.chat === chat
    const allPrSessions = Array.from(liveSessions.values()).filter(matchesPr)
    const stoppableSessions = allPrSessions.filter(hasStoppableWork)

    abortGithubReviewStateForPr(workspace, prNumber)
    for (const live of allPrSessions) {
      live.githubReviewRound = null
      live.pendingGithubReviewRoundCloseout = null
    }

    const subagentAbort = (
      options.cancelRunningSubagentsByWorkKey?.(githubReviewerWorkKey(workspace, prNumber), reason) ??
      Promise.resolve({ matched: 0, cancelled: 0, failures: 0 })
    ).catch((err) => {
      logger.warn(
        `[channels] github reviewer abort failed pr=${workspace}#${prNumber} reason=${JSON.stringify(reason)}: ${describeError(err)}`,
      )
      return { matched: 0, cancelled: 0, failures: 1 }
    })
    const sessionAborts = Promise.all(stoppableSessions.map((live) => stopCurrentChannelTurn(live, reason)))
    const persistedRoundClear = (async (): Promise<void> => {
      await ensureLoaded()
      if (mappings === null) return
      let changed = false
      for (const [index, record] of mappings.entries()) {
        if (record.adapter !== 'github' || record.workspace !== workspace || record.chat !== chat) continue
        if (record.githubReviewRound === undefined) continue
        const { githubReviewRound: _removed, ...rest } = record
        void _removed
        mappings[index] = rest
        changed = true
      }
      if (changed) await persist()
    })().catch((err) => {
      logger.warn(`[channels] github review round clear failed pr=${workspace}#${prNumber}: ${describeError(err)}`)
    })

    const [sessionResults, subagentResult] = await Promise.all([sessionAborts, subagentAbort, persistedRoundClear])
    const abortFailures = sessionResults.filter((succeeded) => !succeeded).length + subagentResult.failures
    logger.info(
      `[channels] github PR abort pr=${workspace}#${prNumber} sessions=${stoppableSessions.length} ` +
        `reviewers=${subagentResult.matched} failures=${abortFailures} reason=${JSON.stringify(reason)}`,
    )
    return stoppableSessions.length === 0 && subagentResult.matched === 0
      ? { kind: 'no-live-session' }
      : {
          kind: 'aborted',
          matchedSessions: stoppableSessions.length,
          matchedReviewers: subagentResult.matched,
          abortFailures,
        }
  }

  const hasPendingContinueReply = (live: LiveSession): boolean => {
    const progressReply = live.continueReplyTurn
    return (
      progressReply !== null &&
      progressReply.turnSeq === live.turnSeq &&
      progressReply.sendCount === live.successfulChannelSends
    )
  }

  const maybePostDeferredProviderError = async (
    live: LiveSession,
    completedReplyThisTurn: boolean,
    retryQueued: boolean,
  ): Promise<void> => {
    const pending = live.pendingProviderError
    if (pending === null || pending.turnSeq !== live.turnSeq) {
      live.pendingProviderError = null
      return
    }
    // The turn recovered and replied — the provider blip was transient, so a
    // failure notice would be a false alarm stranded above the real reply.
    if (completedReplyThisTurn) {
      live.pendingProviderError = null
      return
    }
    // The turn ran tools and promised nothing further, so it was not silent —
    // the very condition that makes recovery unsafe (`canAdvance` refuses to
    // fail over once `startedToolExecution` is set) also means a side effect
    // may already be public. Surfacing the notice here strands a "connection
    // dropped" warning above the agent's own successful work. A logical turn
    // holding an outstanding continue-reply promise is the opposite case: it
    // explicitly told the user more was coming, so dying silently WOULD leave
    // them waiting and the notice must still fire. Operators still get the
    // failure from the `LLM call failed` line plus this suppression record.
    if (live.toolExecutionThisLogicalTurn && !live.promisedWorkOutstandingThisLogicalTurn) {
      live.pendingProviderError = null
      logger.warn(
        `[channels] ${live.keyId}: provider_error_notice_suppressed reason=tool_activity_this_turn notice="${pending.safeMessage}"`,
      )
      return
    }
    // An empty-turn retry was queued (validateChannelTurn pushed
    // EMPTY_TURN_RETRY_NUDGE): the same logical turn re-prompts in the next
    // drain iteration and may yet recover. Carry the pending error forward,
    // re-stamping to that iteration's turnSeq (drain does `turnSeq++` once per
    // iteration, so it will be exactly `turnSeq + 1`). Posting now would strand
    // a false-failure notice above the retry's eventual reply — the same defect
    // one logical turn later.
    if (retryQueued) {
      live.pendingProviderError = { turnSeq: live.turnSeq + 1, safeMessage: pending.safeMessage }
      return
    }
    live.pendingProviderError = null
    // Genuinely empty turn with no retry left: surface the REDACTED
    // `safeMessage` (never raw provider text, which can carry response bodies /
    // URLs / tokens) via a 'system' send — the one-shot bypass path that lands
    // regardless of per-turn send caps — so the human doesn't just see silence.
    const result = await send(
      {
        adapter: live.key.adapter,
        workspace: live.key.workspace,
        chat: live.key.chat,
        thread: live.key.thread,
        text: `⚠️ ${pending.safeMessage}`,
      },
      { source: 'system', outputKind: 'meta' },
    ).catch((sendErr) => {
      logger.warn(`[channels] ${live.keyId}: provider-error notice send threw: ${describeError(sendErr)}`)
      return null
    })
    if (result !== null && !result.ok) {
      logger.warn(`[channels] ${live.keyId}: provider-error notice send failed: ${result.error}`)
    }
  }

  // Open a new logical turn for externally-injected work that arrived without a
  // user message. Deliberately a SUBSET of the fresh-batch reset above: only
  // state whose meaning is scoped to "the episode that just ended" is cleared.
  //
  // `promisedWorkOutstandingThisLogicalTurn` is the notable survivor. A
  // completion wakeup usually exists BECAUSE the agent promised a later result,
  // and that promise is exactly what makes a silent death user-visible harm —
  // clearing it here would re-open the hole this fix closes. It is cleared
  // authoritatively by a terminal send instead.
  //
  // Author identity is restored by the caller's existing reminder branch and
  // must not be reset: role resolution for the wakeup's own channel_reply
  // depends on it. `stagedFallbackCause` and the question signals also survive —
  // a wakeup can be the recovery opportunity a staged fallback was waiting for.
  //
  // `logicalTurnStartedAt` deliberately does NOT advance here. It exists solely
  // as the boundary `isAwaitingBackgroundChild` compares a child's `startedAt`
  // against, and advancing it would hide an older SIBLING child that is still
  // running: one child's completion wake would stop counting as "awaiting", and
  // the recovery ladder, todo continuation and staged fallback would all re-fire
  // while that sibling still works — exactly the duplicate-comment failure
  // f1f36462 fixed. The wake for A must stay silent while B runs; B's own
  // completion is what ends the wait.
  const beginWakeupTurn = (live: LiveSession): void => {
    live.pendingProviderError = null
    live.consecutiveSends.clear()
    live.lastSentText.clear()
    live.lastSendLeafId = null
    // Safe to refill precisely because retry nudges are `kind: 'retry'` and
    // never reach here: the ladder this wakeup turn may itself queue cannot
    // refill its own budget, so there is no unbounded loop.
    live.emptyTurnRetries = 0
    live.toolLeakRetries = 0
    live.emptyStopAfterToolWorkArmed = false
    live.willingnessNudges = 0
    live.abortReasonThisTurn = null
    live.userStoppedTurnSeq = null
    live.nextPromptMaxTokens = undefined
    live.githubReviewOutputTurn = null
    live.toolExecutionThisLogicalTurn = false
    live.qualifyingWorkThisLogicalTurn = false
  }

  const runDrain = async (live: LiveSession): Promise<void> => {
    live.draining = true
    try {
      // `!live.pendingTeardown`: once a reload marks this draining session for
      // teardown, finish ONLY the in-flight prompt (its batch was already
      // spliced out of promptQueue at the top of the current iteration) and
      // stop — do NOT splice a fresh batch of post-reload inbounds onto the
      // stale, about-to-be-recreated session. Those queued inbounds are handed
      // to the fresh successor in the teardown block below.
      while (
        (live.promptQueue.length > 0 || live.pendingSystemReminders.length > 0) &&
        !live.destroyed &&
        !live.pendingTeardown
      ) {
        live.typingTimedOut = false
        // Each turn starts with no held reactions; the model re-requests them
        // via channel_react during this turn, and the finally flushes or drops.
        live.pendingTurnReactions = []
        // Heartbeat must run during generation as well as during debounce.
        // Because new inbounds during a turn just push into promptQueue
        // without re-entering route(), the route() call site alone wouldn't
        // keep the indicator alive across multiple drain iterations.
        startTypingHeartbeat(live)
        // Result claims commit before content leaves the queues or enters a prompt.
        const consume = async () => {
          if (live.destroyed || live.pendingTeardown) return undefined
          if (live.promptQueue.length === 0 && live.pendingSystemReminders.length === 0) return undefined
          await ready
          await transferMismatchedAccountCoverageInLane(live)
          if (live.promptQueue.length === 0 && live.pendingSystemReminders.length === 0) return undefined
          const batchCount = live.promptQueue.length
          const observedCount = live.contextBuffer.length
          const reminderCount = live.pendingSystemReminders.length
          const queued = live.pendingSystemReminders.slice(0, reminderCount)
          const eligible = new Set<PendingSystemReminder>()
          const refs: BackgroundObligationRef[] = []
          const readyRows: BackgroundObligation[] = []
          for (const reminder of queued) {
            if (!reminder.backgroundObligationId) {
              eligible.add(reminder)
              continue
            }
            const row = await backgroundObligations.get(reminder.backgroundObligationId)
            // Fetch/settlement may have overtaken this wake. Durable ownership
            // wins: retire the obsolete entry instead of poisoning later input.
            if (
              !row ||
              row.phase !== 'result-ready' ||
              row.claim ||
              row.transfer ||
              channelKeyId(row.target) !== live.keyId
            )
              continue
            eligible.add(reminder)
            refs.push({ obligationId: row.obligationId, generation: row.generation })
            readyRows.push(row)
          }
          const fresh = batchCount > 0 || queued.some((r) => eligible.has(r) && r.kind === 'wakeup')
          const carried = fresh ? undefined : queued.find((r) => r.backgroundRetry)?.backgroundRetry
          const turnId = fresh ? randomUUID() : (carried?.turnId ?? live.backgroundTurnId)
          await ready
          inboundJournal.assertAvailable()
          const inboundRetry = fresh ? undefined : queued.find((r) => r.inboundRetry)?.inboundRetry
          const inputIds = live.promptQueue
            .slice(0, batchCount)
            .flatMap((input) => (input.inputId ? [input.inputId] : []))
          const inboundRefs = await inboundJournal.resolve(inputIds)
          if (live.inboundCoverage.length === 0) live.coverageDeferredSince = null
          if (fresh && live.inboundCoverage.length > 0) {
            // Coverage left open by a turn deferred to background work is owed, not
            // lost: carry it forward like a wakeup instead of posting a restart
            // notice. Cached IDs are hints (a reload successor adopts them), so only
            // rows the deferring turn still owns in the journal are carried or moved.
            const deferred = live.inboundCoverage.flatMap((id) => {
              const row = inboundJournal.get(id)
              return row?.phase === 'turn-owned' &&
                !row.transfer &&
                row.claim?.turnId === live.backgroundTurnId &&
                row.claim.epoch === inboundJournal.epoch
                ? [row]
                : []
            })
            live.inboundCoverage = deferred.map((row) => row.inputId)
            const deferredSince = live.coverageDeferredSince ?? live.logicalTurnStartedAt
            // A child of the deferring turn that already finished no longer shows as
            // running, yet its durable result-ready wake in this same batch still
            // carries the debt into the coalesced turn. Only an exact match counts:
            // spawned by the deferring owner, during the deferred interval, under the
            // deferred inputs' account. Generic wake text or an unrelated child never does.
            const owners = new Set(
              deferred.flatMap((row) => (row.claim?.ownerSessionId ? [row.claim.ownerSessionId] : [])),
            )
            const accounts = new Set(deferred.map((row) => row.accountIdentity))
            const completionCarrier = readyRows.some(
              (row) =>
                owners.has(row.parentSessionId) &&
                accounts.size === 1 &&
                accounts.has(row.accountIdentity) &&
                row.acceptedAt >= deferredSince,
            )
            if (deferred.length === 0) {
              live.coverageDeferredSince = null
            } else if (
              batchCount > 0 &&
              !completionCarrier &&
              !isAwaitingBackgroundChild(live, 'fresh-inbound-coverage', deferredSince)
            ) {
              await transferLostCoverageInLane(live.key, live.inboundCoverage, live.backgroundCoverage, live.sessionId)
              live.coverageDeferredSince = null
            } else {
              if (batchCount > 0) live.coverageDeferredSince = deferredSince
              const previous = await inboundJournal.resolve(live.inboundCoverage)
              const movedInputs = await inboundJournal.move(previous, {
                fromTurnId: live.backgroundTurnId,
                turnId,
                ownerSessionId: live.sessionId,
                target: live.key,
              })
              inboundRefs.push(...movedInputs.inboundRefs)
            }
          }
          const owner = { turnId, ownerSessionId: live.sessionId, target: live.key }
          const claimedCoverage =
            inboundRefs.length > 0
              ? await inboundJournal.claim(inboundRefs, owner, refs)
              : {
                  inboundRefs: [],
                  backgroundRefs: refs.length > 0 ? await backgroundObligations.claim(refs, owner) : [],
                }
          const claimed = claimedCoverage.backgroundRefs
          let carriedInboundIds = fresh ? [] : live.inboundCoverage
          const retryRefs = inboundRetry ? await inboundJournal.resolve(inboundRetry.inputIds) : []
          const moved: BackgroundObligationRef[] = []
          if (carried) {
            for (const id of new Set(carried.obligationIds)) {
              const row = await backgroundObligations.get(id)
              if (
                !row ||
                row.transfer ||
                row.phase !== 'turn-owned' ||
                row.claim?.turnId !== carried.turnId ||
                channelKeyId(row.target) !== live.keyId
              )
                continue
              moved.push({ obligationId: id, generation: row.generation })
            }
          }
          if (retryRefs.length > 0) {
            const movedCoverage = await inboundJournal.move(
              retryRefs,
              { ...owner, fromTurnId: inboundRetry!.turnId },
              moved,
            )
            carriedInboundIds = movedCoverage.inboundRefs.map((ref) => ref.inputId)
            moved.splice(0, moved.length, ...movedCoverage.backgroundRefs)
          } else if (moved.length > 0) {
            const movedRefs = await backgroundObligations.move(moved, { ...owner, fromTurnId: carried!.turnId })
            moved.splice(0, moved.length, ...movedRefs)
          }
          live.inboundCoverage = [...carriedInboundIds, ...claimedCoverage.inboundRefs.map((ref) => ref.inputId)]
          live.backgroundTurnId = turnId
          if (fresh) live.backgroundCoverage = []
          else
            live.backgroundCoverage = (await resolveBackgroundCoverage(live, live.backgroundCoverage, true)).map(
              (ref) => ref.obligationId,
            )
          live.backgroundCoverage.push(...claimed.map((ref) => ref.obligationId))
          if (carried) {
            live.backgroundCoverage = [...moved, ...claimed].map((ref) => ref.obligationId)
            live.emptyTurnRetries = carried.emptyTurnRetries
            live.toolLeakRetries = carried.toolLeakRetries
            live.willingnessNudges = carried.willingnessNudges
            live.nextPromptMaxTokens = carried.nextPromptMaxTokens
          }
          const ownedInput = live.inboundCoverage[0] ? inboundJournal.get(live.inboundCoverage[0]) : undefined
          const ownedBackground = live.backgroundCoverage[0]
            ? await backgroundObligations.get(live.backgroundCoverage[0])
            : undefined
          live.turnAccountIdentity =
            ownedInput?.accountIdentity ??
            ownedBackground?.accountIdentity ??
            (fresh ? undefined : live.turnAccountIdentity)
          return {
            batch: live.promptQueue.splice(0, batchCount),
            observed: live.contextBuffer.splice(0, observedCount),
            reminders: live.pendingSystemReminders
              .splice(0, reminderCount)
              .filter((reminder) => eligible.has(reminder)),
            stopVersion: live.backgroundStopVersion,
          }
        }
        const drained = await backgroundObligations.withTargetLane(live.key, consume)
        if (drained === undefined) break
        const { batch, observed, reminders, stopVersion } = drained
        if (live.backgroundStopVersion !== stopVersion || (batch.length === 0 && reminders.length === 0)) continue
        live.currentTurnAttachments = collectTurnAttachments(observed, batch)
        // A reminder-only iteration carrying externally-injected work opens a
        // NEW logical turn. Without this, the completed-subagent wakeup that
        // follows a turn which spawned it inherits that turn's
        // `toolExecutionThisLogicalTurn`, and a provider failure on the wakeup
        // is misread as "the turn already ran tools, so it wasn't silent" —
        // suppressing the notice for a prompt that ran no tool and produced
        // nothing. Observed in production as a review verdict lost with zero
        // user-visible signal. Retry nudges deliberately do NOT trip this: they
        // ARE the same logical turn retrying.
        const wakeupTurn = batch.length === 0 && reminders.some((r) => r.kind === 'wakeup')
        // Gated on `!wakeupTurn` because a willingness nudge can coalesce into the
        // same iteration as a wakeup. The wakeup wins the boundary and clears the
        // nudge budget, so the willingness bookkeeping now describes a superseded
        // turn — and a legitimate NO_REPLY from the wake (a PR stand-down, say)
        // would otherwise post a bogus `no_reply_after_willingness_nudge`
        // fallback. Same defect the branch that reads this flag already guards
        // against for later unrelated reminders.
        live.willingnessReminderIteration =
          !wakeupTurn &&
          batch.length === 0 &&
          reminders.some((r) => r.text === WILLINGNESS_NUDGE || r.text === SEND_WILLINGNESS_NUDGE)

        if (batch.length > 0) {
          // A fresh user batch starts a NEW logical turn. Drop any provider
          // error carried forward from a prior turn's empty-turn retry: the
          // drain loop splices promptQueue AND pendingSystemReminders together,
          // so a user message arriving while a retry nudge is pending coalesces
          // into this iteration. Without this clear, the carried error (stamped
          // `turnSeq + 1`) would match this fresh turn and post the prior turn's
          // notice misattributed to an unrelated new message. Carry-forward stays
          // intact for genuinely reminder-only iterations (batch.length === 0),
          // which skip this branch.
          live.pendingProviderError = null
          live.currentTurnAuthorId = batch[batch.length - 1]!.authorId
          live.currentTurnAuthorIds = new Set(batch.map((m) => m.authorId))
          live.currentTurnReactionRef = batch[batch.length - 1]!.reactionRef ?? null
          const trigger = batch[batch.length - 1]!
          if (trigger.githubReviewRound !== undefined) {
            live.githubReviewRound = registerGithubReviewRound(trigger.githubReviewRound, now(), now)
          }
          live.currentTurnExplicitlyAddressed =
            trigger.isDm || trigger.isBotMention || trigger.replyToBotMessageId !== null
          live.currentTurnTypingThread = batch[batch.length - 1]!.typingThread ?? null
          live.currentTurnEngageReactions = batch.flatMap((m) =>
            m.engageReaction !== undefined ? [m.engageReaction] : [],
          )
          live.consecutiveSends.clear()
          live.lastSentText.clear()
          live.lastSendLeafId = null
          live.pendingQuoteCandidate = captureQuoteCandidate(live.key.adapter, batch, observed)
          // A real user batch starts a fresh logical turn → restore the full
          // empty-turn retry budget and drop any raised output-token budget left
          // over from a prior turn's length-retry. Reset here (batch.length > 0)
          // and NOT in the per-prompt block below, so the reminder-only
          // iterations the retry itself queues do not refill the budget and loop
          // forever (and the raised cap stays scoped to the turn that set it).
          live.emptyTurnRetries = 0
          live.toolLeakRetries = 0
          live.emptyStopAfterToolWorkArmed = false
          live.willingnessNudges = 0
          live.logicalTurnStartedAt = now()
          const stampedCloseout = batch.findLast((item) => item.githubReviewThreadCloseout !== undefined)
          const deferredCloseout =
            stampedCloseout?.githubReviewThreadCloseout === undefined &&
            live.githubReviewThreadCloseout !== null &&
            live.githubReviewThreadCloseout.deferred
              ? live.githubReviewThreadCloseout
              : null
          live.githubReviewThreadCloseout =
            stampedCloseout?.githubReviewThreadCloseout !== undefined
              ? {
                  ...stampedCloseout.githubReviewThreadCloseout,
                  startedAt: live.logicalTurnStartedAt,
                  correctionAttempts: 0,
                  deferred: false,
                }
              : deferredCloseout === null
                ? null
                : {
                    ...deferredCloseout,
                    startedAt: live.logicalTurnStartedAt,
                    correctionAttempts: 0,
                  }
          if (stampedCloseout?.githubReviewThreadCloseout !== undefined) {
            persistGithubReviewThreadCloseout(live, null)
          }
          live.githubReviewThreadCloseoutDecisionTurn = null
          // A fresh batch supersedes a still-pending staged fallback. That staged
          // turn produced no usable reply, so it must not leave the PRIOR turn's
          // committed lastQuestionSignal behind — otherwise the new question would
          // inherit an xhigh escalation across the superseded (failed) turn. Clear
          // the stale signal only when a stage was actually pending; a normal prior
          // turn's legitimately-committed signal is left intact.
          if (live.stagedFallbackCause !== null) {
            live.lastQuestionSignal = null
            live.stagedFallbackCause = null
          }
          live.abortReasonThisTurn = null
          live.pendingTerminalReplyStop = null
          live.userStoppedTurnSeq = null
          live.nextPromptMaxTokens = undefined
          // Cleared with the retry budgets (NOT beside resetReviewTurn below) so a
          // review landed earlier in this logical turn keeps suppressing the
          // empty-turn fallback across the reminder-only retry iterations.
          live.githubReviewOutputTurn = null
          live.toolExecutionThisLogicalTurn = false
          live.qualifyingWorkThisLogicalTurn = false
          live.promisedWorkOutstandingThisLogicalTurn = false
        } else if (live.lastTurnAuthorId !== null) {
          live.currentTurnEngageReactions = []
          // Reminder-only turn (batch.length === 0, reminders.length > 0):
          // restore the author identity from the prior turn so author-
          // scoped role resolution still works on this turn. The drain
          // finally-block clears `currentTurnAuthorId` between turns, so a
          // reminder arriving while the session is idle would otherwise
          // strip `lastInboundAuthorId` from the tool.before origin and
          // demote roles like `slack:T0/C0 author:U_OWNER` to whichever
          // non-author rule matches — silently breaking the channel_reply
          // that the reminder is asking the agent to send. `lastTurnAuthorId`
          // tracks the LAST speaker of the prior batch (matching normal-
          // turn `batch[batch.length - 1]!.authorId` semantics) so a multi-
          // author prior turn like alice→bob restores `bob`, not alice.
          live.currentTurnAuthorId = live.lastTurnAuthorId
          live.currentTurnAuthorIds = new Set(live.lastTurnAuthorIds)
        } else {
          live.currentTurnEngageReactions = []
        }
        // After the author-identity restore above, which a wakeup turn still needs.
        if (wakeupTurn) beginWakeupTurn(live)

        // Update the live origin holder so this turn's tool.before events
        // carry the current actor's id, and resolve the live role from it for
        // the per-turn <your-role> anchor below. Done BEFORE composeTurnPrompt
        // so the anchor reflects the speaker of THIS turn, not the session-
        // creation snapshot the system prompt still renders. Permission gating
        // off `lastInboundAuthorId` happens in the tool layer and sees the same
        // live value.
        live.originRef.current = buildLiveOrigin(live)
        const liveRole = permissions.describe(live.originRef.current).role

        const text = composeTurnPrompt(observed, batch, {
          adapter: live.key.adapter,
          loopGuardActive: live.loopGuardActive,
          groupChatNudge: live.multiHumanGroup,
          systemReminders: reminders.map((r) => r.text),
          role: liveRole,
        })

        const repairedToolCalls = repairDanglingToolUseBranch(live.session, now())
        if (repairedToolCalls.length > 0) {
          logger.warn(
            `[channels] ${live.keyId} branch_repair=missing_tool_result session=${live.sessionId} ` +
              `count=${repairedToolCalls.length} tools=${repairedToolCalls.join(',')}`,
          )
        }

        // Bracketing logs around the LLM call so a hung prompt() is
        // diagnosable from logs alone (we see prompting without prompted).
        // text length is a proxy for "did we send something at all".
        logger.info(`[channels] ${live.keyId} prompting batch=${batch.length} text_len=${text.length}`)
        const promptStart = now()
        const successfulSendsBeforePrompt = live.successfulChannelSends
        const emptyTurnRetriesBeforePrompt = live.emptyTurnRetries
        const toolLeakRetriesBeforePrompt = live.toolLeakRetries
        const willingnessNudgesBeforePrompt = live.willingnessNudges
        const engageAddPromises = live.currentTurnEngageReactions
        live.turnSeq++
        live.successfulSendsAtTurnStart = successfulSendsBeforePrompt
        live.skipLockedSendTurn = null
        live.disengagedTurn = null
        live.emptyTurnFallbackTurn = null
        live.continueReplyTurn = null
        live.policyDeniedToolSendsThisTurn.clear()
        resetReviewTurn(live.sessionId)
        const isRealUserTurn = batch.length > 0
        await awaitLatestTodoOutcomeWrite(live)
        await recordTodoTurnStart(live, isRealUserTurn)
        const retrievalQuery = composeRetrievalQuery(batch)
        // A fresh real-user batch opens a new logical turn. Capture its question
        // shape as PENDING (committed only once the turn completes below). The
        // drain is serial and retries are reminder-only, so a prior pending must
        // already be resolved; a leftover here means a logical turn never
        // completed — fail closed by discarding it rather than misattributing.
        if (isRealUserTurn) {
          live.pendingUserTurnSignal = { signal: getQuestionSignal(retrievalQuery) }
        }
        const retrievalContext = await fireSessionTurnStart(live, retrievalQuery)
        if (live.backgroundStopVersion !== stopVersion) continue
        const accountMayPrompt = await backgroundObligations.withTargetLane(live.key, async () => {
          const currentAccount = await transferMismatchedAccountCoverageInLane(live)
          return (
            currentAccount === undefined ||
            live.turnAccountIdentity === undefined ||
            currentAccount === live.turnAccountIdentity
          )
        })
        if (!accountMayPrompt || live.backgroundStopVersion !== stopVersion) continue
        const promptText = retrievalContext.results.length > 0 ? `${text}\n\n${retrievalContext.results}` : text
        applyTurnThinkingLevel(live.session, retrievalQuery, live.turnThinkingDefault, live.lastQuestionSignal)
        live.promptInFlight = true
        try {
          const result = await promptPersistentTurnWithFallback({
            refs: resolveFallbackChain(getConfig().models, undefined),
            currentModelRef: live.activeModelRef,
            session: live.session,
            text: promptText,
            shouldFailover: (err) => isFailoverWorthy(err.message),
            authorizeRetryAfterCompletedToolResult: () => hasPendingContinueReply(live),
            ...(options.retryRandom !== undefined ? { retryRandom: options.retryRandom } : {}),
            ...(options.onRetryBackoffStart !== undefined ? { onRetryBackoffStart: options.onRetryBackoffStart } : {}),
            setModelForRef: async (ref) => {
              await live.session.setModel(applyModelRuntimeOverrides(resolveModel(ref), ref))
              live.activeModelRef = ref
            },
            beforeAttempt: () => {
              inboundJournal.assertAvailable()
              if (live.backgroundStopVersion !== stopVersion) throw new Error('Channel turn stopped before dispatch')
              const currentAccount = currentAccountIdentityFor(live.key)
              if (
                currentAccount !== undefined &&
                live.turnAccountIdentity !== undefined &&
                currentAccount !== live.turnAccountIdentity
              ) {
                void backgroundObligations
                  .withTargetLane(live.key, () => transferMismatchedAccountCoverageInLane(live))
                  .catch((error) => logger.error(`[channels] account-change transfer failed: ${describeError(error)}`))
                throw new Error('Channel turn account identity changed before dispatch')
              }
              applyTurnThinkingLevel(live.session, retrievalQuery, live.turnThinkingDefault, live.lastQuestionSignal)
            },
            onAttemptFailed: (attempt) => {
              logger.warn(
                `[channels] ${live.keyId}: ${attempt.outcome} failure on ${attempt.ref}: ${attempt.errorMessage ?? 'unknown'}; falling back`,
              )
            },
            onToolExecutionStarted: () => {
              live.toolExecutionThisLogicalTurn = true
            },
          })
          if (result.success) live.activeModelRef = result.refUsed
          await validateChannelTurn(live, successfulSendsBeforePrompt)
          live.consecutiveAborts = 0
          // Resolve the pending logical-turn signal on a binary rule: ONLY a
          // usable assistant reply (real model prose the user saw) seeds the next
          // turn's escalation. Every other terminal outcome CLEARS lastQuestionSignal
          // so an older question can't leak across the failed/silent turn:
          //   - retry queued (`length`/`aborted`, budget left, OR a tool-call
          //     leak nudged a self-correction retry): turn still in flight →
          //     leave both for the reminder-only iteration that ends it.
          //   - usable reply → commit the pending signal.
          //   - provider error / empty-turn fallback / NO_REPLY / skip (no usable
          //     reply) → clear BOTH (pending and lastQuestionSignal).
          // A fallback sends via source:'system', which also bumps
          // successfulChannelSends, so it must be excluded explicitly. Both retry
          // budgets keep the logical turn open, so both must count here — a
          // tool-leak retry that later replies must commit the signal AT the
          // successful retry, not clear it after the first suppressed attempt.
          const retryQueuedThisTurn =
            live.emptyTurnRetries > emptyTurnRetriesBeforePrompt ||
            live.toolLeakRetries > toolLeakRetriesBeforePrompt ||
            live.willingnessNudges > willingnessNudgesBeforePrompt
          const providerErrorThisTurn = assistantLeafStopReason(live.session) === 'error'
          const fallbackPostedThisTurn = live.emptyTurnFallbackTurn === live.turnSeq
          const sentReplyThisTurn = live.successfulChannelSends > successfulSendsBeforePrompt
          const usableReplyThisTurn = sentReplyThisTurn && !fallbackPostedThisTurn && !providerErrorThisTurn
          // A staged (not-yet-posted) willingness fallback keeps the logical turn
          // OPEN, exactly like a queued retry: the progress ack that triggered
          // staging would otherwise read as `usableReplyThisTurn` and commit the
          // question signal, so a fallback turn would leak the `xhigh` escalation it
          // is meant to suppress. Leave the pending signal untouched here;
          // resolveStagedFallback finalizes it (commit on genuine recovery, clear on
          // fallback-post) once the continuation has run.
          if (live.pendingUserTurnSignal !== null && !retryQueuedThisTurn && live.stagedFallbackCause === null) {
            live.lastQuestionSignal = usableReplyThisTurn ? live.pendingUserTurnSignal.signal : null
            live.pendingUserTurnSignal = null
          }
          logger.info(`[channels] ${live.keyId} prompted elapsed_ms=${now() - promptStart}`)
        } catch (err) {
          logger.error(`[channels] ${live.keyId}: prompt threw: ${describeError(err)}`)
          // Fallback is exhausted by now (promptPersistentTurnWithFallback only
          // throws after rotating every eligible ref), so a recognizable provider
          // failure is terminal for this turn. Stage a redacted notice for the
          // `finally` poster — but never clobber a soft error already captured for
          // this turnSeq by subscribeProviderErrors (first-detected wins).
          const hardProviderError = detectHardProviderError(err)
          if (hardProviderError !== null && live.pendingProviderError?.turnSeq !== live.turnSeq) {
            live.pendingProviderError = { turnSeq: live.turnSeq, safeMessage: hardProviderError.safeMessage }
          }
          live.consecutiveSends.clear()
          live.lastSentText.clear()
          live.lastSendLeafId = null
          // A thrown prompt is a non-usable terminal outcome: drop pending AND
          // clear the prior signal so an older question can't leak across it.
          live.pendingUserTurnSignal = null
          live.lastQuestionSignal = null
        } finally {
          live.promptInFlight = false
          const sentReplyThisTurn = live.successfulChannelSends > successfulSendsBeforePrompt
          // The eager :eyes: ack is a "looking at this" signal, not a "replied"
          // one, so it comes off at turn end no matter the outcome — a reply, but
          // also silence, skip_response, an empty turn, or a provider error
          // (observe-after-engage). Leaving it only on the reply path stranded the
          // ack permanently on messages the agent looked at but never answered.
          // Tuple lanes order removal before protected acknowledgment addition,
          // without making transport cleanup a barrier for the next response.
          void dropEngageReactions(live, engageAddPromises)
          reactOnSilentAck(live)
          // Held channel_react reactions apply only when the agent posted a
          // genuine reply this turn — NOT an empty-turn fallback or provider-
          // error notice, both of which send via source:'system' and bump
          // successfulChannelSends. Otherwise a silent/skipped/errored turn
          // would still stamp a reaction on a message it never really answered.
          // Computed BEFORE maybePostDeferredProviderError so its error send
          // cannot flip the decision.
          const usableReplyThisTurn =
            sentReplyThisTurn &&
            live.emptyTurnFallbackTurn !== live.turnSeq &&
            assistantLeafStopReason(live.session) !== 'error'
          if (usableReplyThisTurn) {
            flushPendingReactions(live)
            void dropSilentAckReactions(live)
          } else live.pendingTurnReactions = []
          // Either retry budget keeps the turn in flight, so a deferred provider
          // error must wait for the reminder-only iteration that actually ends it.
          const retryQueuedThisTurn =
            live.emptyTurnRetries > emptyTurnRetriesBeforePrompt ||
            live.toolLeakRetries > toolLeakRetriesBeforePrompt ||
            live.willingnessNudges > willingnessNudgesBeforePrompt
          await maybePostDeferredProviderError(
            live,
            sentReplyThisTurn && !live.promisedWorkOutstandingThisLogicalTurn,
            retryQueuedThisTurn,
          )
          // Provider notices own the first terminal output opportunity. A notice
          // that lands on the owed thread clears the obligation through send();
          // a suppressed or failed notice leaves it intact for this bounded net.
          await enforceGithubReviewThreadCloseout(live)
          await fireSessionTurnEnd(live)
        }
        await fireSessionIdle(live)
        const outcomeWriteSucceeded = await awaitLatestTodoOutcomeWrite(live)
        if (!outcomeWriteSucceeded) {
          logger.warn(`[channels] ${live.keyId}: skipping todo continuation after failed outcome write`)
        } else if (live.userStoppedTurnSeq === live.turnSeq) {
          logger.info(`[channels] ${live.keyId}: skipping todo continuation after user stop`)
        } else if (isAwaitingBackgroundChild(live, 'todo-continuation')) {
          // The outstanding todo is usually the very work the running child was
          // spawned to do, so continuing here re-wakes a session that is
          // deliberately waiting and asks the model to report progress it does
          // not have yet. The child's completion reminder is the correct wake.
          logger.info(`[channels] ${live.keyId}: skipping todo continuation while background child runs`)
        } else {
          await maybeContinueTodosChannel(live)
        }
        if (!isAwaitingBackgroundChild(live, 'staged-fallback')) {
          await resolveStagedFallback(live)
        }
        // A carrier waiting on its own reviewer child has not ended without a
        // verdict: the child's completion reminder is the turn that posts it.
        // Failing over now hands the round to a sibling, which then denies the
        // carrier's verdict and runs a duplicate review. Session-scoped, not
        // turn-scoped: a later silent inbound on the carrier thread must not
        // release the round while that reviewer is still running.
        const logicalTurnStillOpen =
          live.pendingSystemReminders.length > 0 ||
          live.stagedFallbackCause !== null ||
          live.promisedWorkOutstandingThisLogicalTurn ||
          isPinnedByRunningChild(live.sessionId, live.keyId, 'github-review-failover')
        if (!logicalTurnStillOpen) await failoverGithubReviewRound(live)
        live.lastTurnAuthorIds = new Set(live.currentTurnAuthorIds)
        if (live.currentTurnAuthorId !== null) {
          live.lastTurnAuthorId = live.currentTurnAuthorId
        }
      }
    } finally {
      live.draining = false
      live.currentTurnAuthorId = null
      live.currentTurnAuthorIds = new Set()
      live.currentTurnReactionRef = null
      live.currentTurnExplicitlyAddressed = false
      live.currentTurnEngageReactions = []
      // Drop any still-held reactions if the loop exited without running the
      // per-turn finally (e.g. session destroyed mid-drain): never leave a
      // reaction attached to a turn that never completed a reply.
      live.pendingTurnReactions = []
      live.currentTurnAttachments = []
      // Reset AFTER stopTypingHeartbeat: its final 'stop' tick reads the anchor
      // to clear a flat-DM status; clearing it first would strand the indicator.
      await stopTypingHeartbeat(live)
      live.currentTurnTypingThread = null
    }
    // A reload deferred this session's teardown so its in-flight reply could
    // land; now that the turn drained (and the loop stopped BEFORE draining any
    // post-reload inbound), complete the recreate so the fresh session picks up
    // the swapped role/auth/prompt state. Guarded on !destroyed so a concurrent
    // stop()/idle-gc that already tore it down wins the race without a double
    // teardown.
    if (live.pendingTeardown && !live.destroyed) {
      live.pendingTeardown = false
      // Snapshot the post-reload inbounds that arrived during the held prompt
      // BEFORE tearDownLive (its clearQueuedEngageReactions must not drop the
      // engage acks we are handing to the successor). Clear the source arrays so
      // the dying session owns nothing we are moving forward.
      const retained = await backgroundObligations.withTargetLane(live.key, async () => {
        const retry =
          live.promptQueue.length === 0 ? live.pendingSystemReminders.find((r) => r.kind === 'retry') : undefined
        if (retry) {
          // A queued retry already carries this turn's lineage and retry budgets
          // forward; the coverage rides on it rather than as a separate snapshot.
          const refs = await resolveBackgroundCoverage(live, live.backgroundCoverage, true)
          if (refs.length > 0 || live.inboundCoverage.length > 0) {
            retry.backgroundRetry = {
              turnId: live.backgroundTurnId,
              obligationIds: refs.map((ref) => ref.obligationId),
              emptyTurnRetries: live.emptyTurnRetries,
              toolLeakRetries: live.toolLeakRetries,
              willingnessNudges: live.willingnessNudges,
              nextPromptMaxTokens: live.nextPromptMaxTokens,
            }
          }
          if (live.inboundCoverage.length > 0) {
            retry.inboundRetry = { inputIds: [...live.inboundCoverage], turnId: live.backgroundTurnId }
          }
          live.inboundCoverage = []
          live.backgroundCoverage = []
        }
        const kept = await retainLiveWorkInLane(live)
        // Unpublish inside the lane: an admission queued behind this lane must
        // reach the successor (which adopts the handoff), not the dying session.
        if (liveSessions.get(live.keyId) === live) liveSessions.delete(live.keyId)
        return kept
      })
      await tearDownLive(live)
      if (retained) await handOffToSuccessor(live.key)
    }
  }

  // No-op while a drain already owns the session: that loop re-checks both
  // queues every iteration, so work landing behind it is picked up without a
  // second concurrent drain. Registers the running invocation on `activeDrains`
  // so `settleDrains` can await a turn started fire-and-forget.
  const drain = (live: LiveSession): Promise<void> => {
    if (live.draining || live.destroyed) return Promise.resolve()
    const running = runDrain(live)
    // Attaching this handler marks `running` handled, so a drain-tail throw can
    // no longer reach the runtime's unhandled-rejection reporter — every
    // production call site is `void drain(live)` and catches nothing. Log it
    // here so the failure stays visible rather than disappearing into the
    // tracking. The settlement copy must still RESOLVE: `settleDrains` waits on
    // unrelated turns too, and one failed drain must not reject a waiter that
    // has nothing to do with it. Callers keep `running`, so an awaiting caller
    // still sees the original rejection.
    const settled = running.then(
      () => undefined,
      (err: unknown) => {
        logger.error(`[channels] ${live.keyId}: drain failed: ${describeError(err)}`)
      },
    )
    live.activeDrains.add(settled)
    void settled.then(() => live.activeDrains.delete(settled))
    return running
  }

  // Resolves once no drain is running. Loops because a drain's post-`draining`
  // tail can start a rival, and because work queued during one turn opens the
  // next; a snapshot `Promise.all` would return with that successor in flight.
  const settleDrains = async (live: LiveSession): Promise<void> => {
    while (live.activeDrains.size > 0) {
      await Promise.all(live.activeDrains)
    }
  }

  // Rebuild a live session for a channel key after a reload tore its predecessor
  // down mid-drain, and replay the post-reload work that predecessor never got
  // to process. The carried inbounds already have their engagement decided (they
  // were enqueued while draining), so they are transplanted straight onto the
  // fresh session's queues rather than re-routed through route() — re-routing
  // would re-run the claim/command/permission gates and re-derive engagement
  // from a lossy QueuedInbound projection. The batch is retained BEFORE the
  // recreate attempt so a timeout leaves it available to the next successful
  // ensureLive rather than dropping the user's messages at the handoff seam.
  const handOffToSuccessor = async (key: ChannelKey): Promise<void> => {
    const keyId = channelKeyId(key)
    try {
      // A creation begun before this reload cannot install anymore, but ensureLive
      // would hand back its pending rejection. Let it settle first (bounded) so
      // the recreate runs under the current generation and adopts the handoff.
      const inFlight = creating.get(keyId)
      if (inFlight !== undefined) {
        await raceWithTimeout(inFlight, ensureLiveTimeoutMs, `[channels] ${keyId} superseded creation`).catch(
          () => undefined,
        )
      }
      await ensureLive(key)
    } catch (err) {
      logger.warn(
        `[channels] ${keyId}: successor recreate after reload failed; queued work retained for the next successful session: ${describeError(err)}`,
      )
    }
  }

  const scheduleDebouncedDrain = (live: LiveSession): void => {
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    const t = now()
    const sinceLast = t - live.lastInboundAt
    const baseWait = sinceLast < HOT_THRESHOLD_MS ? HOT_DEBOUNCE_MS : INITIAL_DEBOUNCE_MS
    if (live.firstUnprocessedAt === 0) live.firstUnprocessedAt = t
    const elapsedSinceFirst = t - live.firstUnprocessedAt
    const wait = Math.max(0, Math.min(baseWait, MAX_DEBOUNCE_MS - elapsedSinceFirst))
    live.lastInboundAt = t
    if (mappings) {
      const idx = mappings.findIndex(
        (s) =>
          s.adapter === live.key.adapter &&
          s.workspace === live.key.workspace &&
          s.chat === live.key.chat &&
          (s.thread ?? null) === (live.key.thread ?? null),
      )
      if (idx >= 0) {
        mappings[idx] = { ...mappings[idx]!, lastInboundAt: t }
        void persist()
      }
    }
    live.debounceTimer = setTimeout(() => {
      live.debounceTimer = null
      live.firstUnprocessedAt = 0
      void drain(live)
    }, wait)
  }

  const publishInbound = (
    event: InboundMessage,
    decision: 'engage' | 'observe' | 'denied' | 'claim',
    // Undefined before a session exists (denied/claim intercepts). Carried so a
    // session-scoped `typeclaw inspect` only sees its own session's inbounds —
    // the broadcast otherwise fans out to every inspect client.
    sessionId?: string,
  ): void => {
    if (stream === undefined) return
    try {
      stream.publish({
        target: { kind: 'broadcast' },
        payload: {
          kind: 'channel-inbound',
          ...(sessionId !== undefined ? { sessionId } : {}),
          adapter: event.adapter,
          workspace: event.workspace,
          chat: event.chat,
          thread: event.thread,
          authorId: event.authorId,
          authorName: event.authorName,
          authorIsBot: event.authorIsBot,
          isDm: event.isDm,
          isBotMention: event.isBotMention,
          text: event.text,
          externalMessageId: event.externalMessageId,
          ts: event.ts,
          decision,
        },
      })
    } catch (err) {
      logger.warn(`[channels] inbound stream publish failed: ${describeError(err)}`)
    }
  }

  // Executes a parsed channel command and posts its reply (if any) back to the
  // originating channel. Shared by the pre-gate public-command fast path and the
  // post-gate command block so the execute→reply shape can't drift between them.
  // Gating (channel.respond / session.control) and live-session resolution stay
  // at the call sites — this helper only runs the handler and delivers the reply.
  const runChannelCommand = async (event: InboundMessage, live: LiveSession | null): Promise<CommandResult> => {
    const result = await commands.execute(event.text, { live, event, invokerId: event.authorId })
    if (result.kind === 'handled' && result.reply !== undefined) await postCommandReply(event, result.reply)
    return result
  }

  const postCommandReply = async (event: InboundMessage, reply: string): Promise<void> => {
    await send(
      {
        adapter: event.adapter,
        workspace: event.workspace,
        chat: event.chat,
        thread: event.thread,
        text: reply,
      },
      {
        source: 'system',
        outputKind: 'meta',
        expectedAccountIdentity: event.accountIdentity ?? currentAccountIdentityFor(event),
      },
    )
  }

  const route = async (event: InboundMessage): Promise<RouteReceipt> => {
    const adapterConfig = options.configForAdapter(event.adapter)
    if (!adapterConfig) return { kind: 'denied' }

    const key: ChannelKey = {
      adapter: event.adapter,
      workspace: event.workspace,
      chat: event.chat,
      thread: event.thread,
    }

    // Role-claim intercept runs BEFORE the channel.respond gate so the
    // operator can bootstrap permissions on a fresh agent that has no
    // role match rules yet. Cheap pre-check: any inbound whose text
    // contains a `claim-` prefix is a candidate, and only when a handler
    // is registered. Everything else falls straight through to the gate.
    // Claims are accepted from any chat (DM, group, thread) because the
    // resulting match rule is platform-wide + author-scoped — see
    // src/role-claim/match-rule.ts.
    if (claimHandler !== undefined && extractClaimCode(event.text) !== null) {
      const outcome = await claimHandler({
        adapter: event.adapter,
        workspace: event.workspace,
        chat: event.chat,
        isDm: event.isDm,
        authorId: event.authorId,
        text: event.text,
      })
      if (outcome.kind !== 'fallthrough') {
        publishInbound(event, 'claim')
        logger.info(
          `[channels] ${channelKeyId(key)}: claim ${outcome.kind} author=${event.authorId} id=${event.externalMessageId}`,
        )
        await send(
          {
            adapter: event.adapter,
            workspace: event.workspace,
            chat: event.chat,
            thread: event.thread,
            text: outcome.reply,
          },
          {
            source: 'system',
            outputKind: 'meta',
            expectedAccountIdentity: event.accountIdentity ?? currentAccountIdentityFor(event),
          },
        )
        return { kind: 'control' }
      }
    }

    // Parse once, here, so the public-command fast path (below) and the
    // post-gate command block share one parse and lookup.
    const parsedCommand = commands.parse(event.text)
    const commandInfo = parsedCommand === null ? undefined : commands.get(parsedCommand.name)

    // Public-command fast path: a known command that is both ungated
    // (permission:'none') AND informational (requiresLiveSession:false) runs
    // BEFORE the channel.respond gate, mirroring the native-slash path where
    // such commands skip permissions entirely. Both conditions are required so
    // a future "public but live-session-aware" command can't silently bypass
    // the gate. It only reveals already-public command names — it never creates
    // a session or prompts the agent — so it is not a channel.respond bypass in
    // any meaningful sense. Unknown commands, /stop, //escaped text, and plain
    // messages all fall through to the gate unchanged.
    if (parsedCommand !== null && commandInfo?.permission === 'none' && !commandInfo.requiresLiveSession) {
      await runChannelCommand(event, null)
      return { kind: 'control' }
    }

    if (isChannelRespondDenied(event)) {
      publishInbound(event, 'denied')
      logger.info(
        `[channels] ${channelKeyId(key)}: denied by permissions (channel.respond) author=${event.authorId} id=${event.externalMessageId}`,
      )
      return { kind: 'denied' }
    }

    if (parsedCommand !== null) {
      // Commands are control traffic, not engaged inbounds; if the session is stale,
      // the next engaged inbound will perform the rollover before prompting.
      const keyId = channelKeyId(key)
      if (commandInfo === undefined) {
        logger.info(`[channels] ${keyId}: ignoring unknown command /${parsedCommand.name}`)
        return { kind: 'control' }
      }
      const requiredPermission = commandPermissionString(commandInfo.permission)
      if (requiredPermission !== null && !permissions.has(inboundAuthorOrigin(event), requiredPermission)) {
        logger.info(
          `[channels] ${keyId}: denied command /${parsedCommand.name} by permissions (${requiredPermission}) author=${event.authorId}`,
        )
        return { kind: 'denied' }
      }
      // Session-less commands (e.g. /help) are informational and run without a
      // live session; their handler reply is posted straight back to the channel.
      // `wantsLiveSession` commands (/restart) resolve an existing session when
      // present but do not abort when absent.
      let existingLive: LiveSession | null = null
      if (commandInfo.requiresLiveSession) {
        existingLive = liveSessions.get(keyId) ?? null
        if (existingLive === null || existingLive.destroyed) {
          // Work a reload retained for a successor that never installed still
          // belongs to this conversation; /stop withdraws it by key.
          if (commandInfo.name === 'stop' && (await stopPendingReloadHandoff(keyId))) {
            await postCommandReply(event, STOP_COMMAND_REPLY)
            return { kind: 'control' }
          }
          logger.info(`[channels] ${keyId}: ignoring command /${parsedCommand.name} with no live session`)
          return { kind: 'control' }
        }
      } else if (commandInfo.wantsLiveSession) {
        const candidate = liveSessions.get(keyId) ?? null
        existingLive = candidate !== null && !candidate.destroyed ? candidate : null
      }
      const commandResult = await runChannelCommand(event, existingLive)
      if (commandResult.kind !== 'not-command') return { kind: 'control' }
    }
    const generation = liveGeneration
    await ready.catch(() => undefined)
    const accountIdentity = event.accountIdentity ?? (await getRecoveryAccountIdentity(event.adapter, event.workspace))
    // The early duplicate lookup and the in-lane admit share this identity and
    // its principal, so a duplicate is checked against the same author
    // provenance admission would record: a different author is a conflict,
    // never a fresh slot or a silent duplicate.
    const identity = {
      accountIdentity: accountIdentity ?? '',
      target: key,
      principal: {
        kind: 'channel' as const,
        adapter: event.adapter,
        workspace: event.workspace,
        chat: event.chat,
        ...(event.room?.parentChat !== undefined ? { parentChat: event.room.parentChat } : {}),
        lastInboundAuthorId: event.authorId,
      },
      messageId: event.externalMessageId || undefined,
      eventKind: event.eventKind ?? 'message',
      revision: event.revision ?? '',
      receiptId: event.receiptId,
    }
    const existingAdmission =
      accountIdentity && inboundJournal.health().available
        ? await backgroundObligations.withTargetLane(key, async () => inboundJournal.lookupAdmission(identity))
        : undefined
    if (existingAdmission)
      return { kind: 'duplicate', inputId: existingAdmission.inputId, outcome: existingAdmission.outcome?.kind }

    // If a boot restart-resume reservation is pending for this key, mark that a
    // real inbound arrived: ensureLive below will coalesce onto the reservation
    // (via its `creating` seed), and the reservation's resume() will skip the
    // synthetic wake since this inbound already triggers the turn.
    const reservation = restartReservations.get(channelKeyId(key))
    if (reservation !== undefined) reservation.sawInbound = true

    let live = await ensureLive(key, event.externalMessageId, event.authorId, undefined, event.room, generation)
    live.room = event.room

    const isNewAuthor = !live.participants.some((p) => p.authorId === event.authorId)
    live.participants = updateParticipants(
      live.participants,
      event.authorId,
      event.authorName,
      now(),
      event.authorIsBot,
    )
    void persistParticipants(live)

    // A previously-unseen author just spoke. The cached membership count
    // (from /members or history-derived) was computed without them, so
    // invalidate and warm in the background. We don't await — the warmup
    // runs alongside this turn's `membershipForEngagement` call so the
    // *next* turn sees fresh data, but the current turn still gets a
    // fast answer (cache miss → cold fetch with timeout, or stale-ok).
    if (isNewAuthor && live.key.workspace !== '@dm') {
      const scoped = membershipScopeKey(live.key, live.room)
      const cache = membershipCaches.get(scoped.adapter)
      if (cache !== undefined) {
        cache.invalidate(scoped)
        void cache.warmUp(scoped).catch((err) => {
          logger.warn(`[channels] membership warmup after new author failed for ${live.keyId}: ${describeError(err)}`)
        })
      }
    }

    const membership = await membershipForEngagement(live)

    const effectiveHumans = countEffectiveHumans(live.participants, membership, now())
    live.multiHumanGroup = isMultiHumanGroup(event.isDm, effectiveHumans)

    const decision: EngagementDecision = decideEngagement({
      message: event,
      config: adapterConfig.engagement,
      key: live.keyId,
      ledger: stickyLedger,
      now: now(),
      participants: live.participants,
      membership,
      selfAliases: computeSelfAliases(),
      botInThread: hasBotParticipated(live),
    })

    if (decision === 'observe') {
      publishInbound(event, 'observe', live.sessionId)
      // Log every observe so an unanswered mention is diagnosable from logs
      // alone instead of "routed but no prompting" silence. The bracketed
      // shape mirrors `prompting batch=` so log scraping can pair them.
      logger.info(`[channels] ${live.keyId} observed id=${event.externalMessageId}`)
      observe(live, event)
      return { kind: 'observed' }
    }

    await ready
    if (!accountIdentity) {
      logger.warn(
        `[channels] ${live.keyId}: authenticated account is not ready; admitting as unbound so the message is not dropped`,
      )
      identity.accountIdentity = `unbound:${event.adapter}:${event.workspace}`
    }
    return backgroundObligations.withTargetLane(key, async (): Promise<RouteReceipt> => {
      if (live.destroyed || liveSessions.get(live.keyId) !== live) {
        live = await ensureLive(key, event.externalMessageId, event.authorId, undefined, event.room)
        live.room = event.room
      }
      if (isChannelRespondDenied(event)) return { kind: 'denied' }
      const admission = await inboundJournal.admit({ ...identity, ownerSessionId: live.sessionId })
      if (admission.kind === 'duplicate')
        return { kind: 'duplicate', inputId: admission.inputId, outcome: admission.outcome?.kind }
      publishInbound(event, 'engage', live.sessionId)

      // Arm cold-start bare-empty recovery only for the exact incident shape: the
      // FIRST prompt (`turnSeq === 0`) of a freshly cold-started session that
      // engaged via the solo-human answer-everything fallback — a lone human, no
      // explicit mention/reply/DM, not a multi-human group. Recomputed on every
      // engage so it self-clears once the first turn advances `turnSeq`; explicit
      // address (mention/reply/DM) keeps the historical silent-on-empty path.
      live.coldStartSoloFallbackTurnActive =
        live.createdFromColdStart &&
        live.turnSeq === 0 &&
        effectiveHumans <= 1 &&
        !event.authorIsBot &&
        !event.isDm &&
        !event.isBotMention &&
        event.replyToBotMessageId === null &&
        !live.multiHumanGroup

      const engageReaction = autoReactOnEngage(event)

      updateLoopGuard(live, event)

      enqueue(live, event, engageReaction, admission.inputId)

      // Start showing "typing..." the moment we know we're going to engage,
      // so users see the indicator during the debounce window — not just
      // during LLM generation. drain() will keep it alive across iterations
      // and the finally-block will stop it when the queue empties.
      startTypingHeartbeat(live)

      if (live.draining) {
        // In-flight turn; let coalesce-on-drain pick it up. Same-author abort
        // is a v0.2 enhancement once we have safe abort semantics through
        // pi-coding-agent for in-flight tool calls.
        return admission
      }
      scheduleDebouncedDrain(live)
      return admission
    })
  }

  const inboundAuthorOrigin = (event: InboundMessage): SessionOrigin => ({
    kind: 'channel',
    adapter: event.adapter,
    workspace: event.workspace,
    chat: event.chat,
    thread: event.thread,
    ...(event.room?.parentChat !== undefined ? { parentChat: event.room.parentChat } : {}),
    lastInboundAuthorId: event.authorId,
  })

  const isChannelRespondDenied = (event: InboundMessage): boolean =>
    !permissions.has(inboundAuthorOrigin(event), CORE_PERMISSIONS.channelRespond)

  // Gated separately from channelRespond so a respond-capable guest (an
  // operator can grant guest channelRespond for masked stranger turns)
  // cannot /stop another speaker's in-flight turn. session.control is
  // member-and-up by default.
  // Maps a command's declared permission tier to the concrete permission
  // string gated on both the text-prefix path (route) and the native-slash
  // path (executeCommand). 'none' is never gated. session.admin (owner+trusted,
  // not member) covers /reload and /restart, which mutate global agent state
  // and drop every in-flight session. Centralized so a new tier can't be
  // honored on one path and silently skipped on the other.
  const commandPermissionString = (permission: CommandPermission): string | null => {
    switch (permission) {
      case 'none':
        return null
      case 'session.control':
        return CORE_PERMISSIONS.sessionControl
      case 'session.admin':
        return CORE_PERMISSIONS.sessionAdmin
    }
  }

  const updateLoopGuard = (live: LiveSession, event: InboundMessage): void => {
    if (!event.authorIsBot) {
      live.recentEngagedPeerBotTurns.length = 0
      live.consecutiveEngagedPeerBotTurns = 0
      live.loopGuardActive = false
      return
    }
    const t = now()
    live.consecutiveEngagedPeerBotTurns++
    live.recentEngagedPeerBotTurns.push({ authorId: event.authorId, ts: t })
    const cutoff = t - PEER_BOT_TURNS_WINDOW_MS
    while (live.recentEngagedPeerBotTurns.length > 0 && live.recentEngagedPeerBotTurns[0]!.ts < cutoff) {
      live.recentEngagedPeerBotTurns.shift()
    }
    if (
      live.consecutiveEngagedPeerBotTurns >= MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN ||
      live.recentEngagedPeerBotTurns.length >= MAX_PEER_BOT_TURNS_IN_WINDOW
    ) {
      live.loopGuardActive = true
    }
  }

  const hasBotParticipated = (live: LiveSession): boolean => {
    if (live.successfulChannelSends > 0) return true
    // Only OUR own prefetched history counts as participation — matching any
    // bot here let a PEER bot's buffered message flip botInThread=true,
    // neutralizing the replyToOtherMessageId suppressor and engaging us in a
    // thread aimed at another bot. Self id is unavailable during the startup
    // identity race; then this falls back to successfulChannelSends, which is
    // safe (conservative: we just don't claim participation we can't prove).
    const selfId = resolveSelfIdentity(live.key)?.id
    if (selfId === undefined) return false
    for (const item of live.contextBuffer) {
      if (item.authorId === selfId) return true
    }
    return false
  }

  const observe = (live: LiveSession, event: InboundMessage): void => {
    live.contextBuffer.push({
      text: event.text,
      ...(event.referenceContext !== undefined ? { referenceContext: event.referenceContext } : {}),
      ...(event.attachments !== undefined && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
      authorId: event.authorId,
      authorName: event.authorName,
      authorIsBot: event.authorIsBot,
      receivedAt: now(),
      ts: event.ts,
      source: 'observed',
    })
    if (live.contextBuffer.length > CONTEXT_BUFFER_SIZE) {
      live.contextBuffer.splice(0, live.contextBuffer.length - CONTEXT_BUFFER_SIZE)
    }
  }

  const enqueue = (
    live: LiveSession,
    event: InboundMessage,
    engageReaction: WaitingReactionHandle | null,
    inputId: string,
  ): void => {
    clearQueuedEngageReactions(live)
    live.promptQueue.push({
      inputId,
      text: event.text,
      ...(event.referenceContext !== undefined ? { referenceContext: event.referenceContext } : {}),
      ...(event.attachments !== undefined && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
      authorId: event.authorId,
      authorName: event.authorName,
      authorIsBot: event.authorIsBot,
      externalMessageId: event.externalMessageId,
      ...(event.reactionRef !== undefined ? { reactionRef: event.reactionRef } : {}),
      ...(engageReaction !== null ? { engageReaction } : {}),
      isBotMention: event.isBotMention,
      ...(event.isBotMentionOnly !== undefined ? { isBotMentionOnly: event.isBotMentionOnly } : {}),
      replyToBotMessageId: event.replyToBotMessageId,
      isDm: event.isDm,
      ...(event.typingThread !== undefined ? { typingThread: event.typingThread } : {}),
      ...(event.githubReviewRound !== undefined ? { githubReviewRound: event.githubReviewRound } : {}),
      ...(event.githubReviewThreadCloseout !== undefined
        ? { githubReviewThreadCloseout: event.githubReviewThreadCloseout }
        : {}),
      receivedAt: now(),
      ts: event.ts,
    })
    if (event.githubReviewRound !== undefined) {
      live.githubReviewRound = registerGithubReviewRound(event.githubReviewRound, now(), now)
      persistGithubReviewRound(live, live.githubReviewRound)
    }
    // Make the typing anchor live BEFORE startTypingHeartbeat fires (route()
    // starts the heartbeat right after enqueue, ahead of drain). drain() later
    // refreshes it to the last inbound of a coalesced batch.
    if (event.typingThread !== undefined) live.currentTurnTypingThread = event.typingThread
  }

  const registerOutbound = (adapter: ChannelKey['adapter'], cb: OutboundCallback): void => {
    let set = outboundCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      outboundCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const registerReaction = (adapter: ChannelKey['adapter'], cb: ReactionCallback): void => {
    let set = reactionCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      reactionCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterReaction = (adapter: ChannelKey['adapter'], cb: ReactionCallback): void => {
    reactionCallbacks.get(adapter)?.delete(cb)
  }

  const registerRemoveReaction = (adapter: ChannelKey['adapter'], cb: RemoveReactionCallback): void => {
    let set = removeReactionCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      removeReactionCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterRemoveReaction = (adapter: ChannelKey['adapter'], cb: RemoveReactionCallback): void => {
    removeReactionCallbacks.get(adapter)?.delete(cb)
  }

  const react = async (req: ReactionRequest): Promise<ReactionResult> => {
    if (req.reactionRef.adapter !== req.adapter) {
      return { ok: false, error: 'reaction ref adapter mismatch', code: 'unsupported' }
    }
    const callbacks = reactionCallbacks.get(req.adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `adapter "${req.adapter}" does not support reactions`, code: 'unsupported' }
    }
    let lastError: ReactionResult | undefined
    for (const cb of Array.from(callbacks)) {
      // A ReactionCallback that throws must not reject this promise: react() is
      // called both fire-and-forget (autoReactOnEngage) and awaited by the
      // channel_react tool, and neither should have to wrap it in try/catch. A
      // throw is converted to a transient failure result so every caller gets a
      // uniform { ok: false } instead of an exception.
      const result = await cb(req).catch(
        (err): ReactionResult => ({ ok: false, error: describeError(err), code: 'transient' }),
      )
      if (result.ok) return result
      lastError = result
    }
    return lastError ?? { ok: false, error: 'no reaction callback handled request', code: 'unsupported' }
  }

  // Hold a model reaction until the turn proves it engaged (i.e. actually
  // replied). Buffered on the live session for this target; drain's finally
  // flushes it via react() on a real reply or drops it on silence. No live
  // session (or a stale ref that is not this turn's trigger) → nothing to pair
  // the reaction with, so it is refused rather than fired blind.
  const queueReactionAfterReply = async (req: ReactionRequest): Promise<ReactionResult> => {
    if (req.reactionRef.adapter !== req.adapter) {
      return { ok: false, error: 'reaction ref adapter mismatch', code: 'unsupported' }
    }
    const live = liveSessions.get(
      channelKeyId({ adapter: req.adapter, workspace: req.workspace, chat: req.chat, thread: req.thread ?? null }),
    )
    if (!live || live.destroyed) {
      return { ok: false, error: 'no live turn to attach this reaction to', code: 'unsupported' }
    }
    live.pendingTurnReactions.push(req)
    return { ok: true }
  }

  const flushPendingReactions = (live: LiveSession): void => {
    const pending = live.pendingTurnReactions
    live.pendingTurnReactions = []
    for (const req of pending) {
      void react(req)
        .then((result) => {
          if (!result.ok && result.code !== 'unsupported') {
            logger.info(`[channels] react-after-reply failed adapter=${req.adapter} chat=${req.chat}: ${result.error}`)
          }
        })
        .catch((err) => {
          logger.info(
            `[channels] react-after-reply threw adapter=${req.adapter} chat=${req.chat}: ${describeError(err)}`,
          )
        })
    }
  }

  const removeReaction = async (req: RemoveReactionRequest): Promise<ReactionResult> => {
    if (req.reactionRef.adapter !== req.adapter) {
      return { ok: false, error: 'reaction ref adapter mismatch', code: 'unsupported' }
    }
    const callbacks = removeReactionCallbacks.get(req.adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `adapter "${req.adapter}" does not support reaction removal`, code: 'unsupported' }
    }
    let lastError: ReactionResult | undefined
    for (const cb of Array.from(callbacks)) {
      const result = await cb(req).catch(
        (err): ReactionResult => ({ ok: false, error: describeError(err), code: 'transient' }),
      )
      if (result.ok) return result
      lastError = result
    }
    return lastError ?? { ok: false, error: 'no reaction removal callback handled request', code: 'unsupported' }
  }

  // Canonical preparation captures the adapter instance that authenticated it.
  // Reload may replace registration while identity lookup is still in flight.
  const preparedReactionAdds = new WeakMap<OwnReactionTarget, ReactionCallback>()
  const prepareOwnReaction = async (req: ReactionRequest): Promise<OwnReactionTarget | null> => {
    const adds = Array.from(reactionCallbacks.get(req.adapter) ?? [])
    // The manager has one live adapter per type. Do not guess account ownership
    // if an external caller installs ambiguous waiting-add capabilities.
    if (adds.length !== 1) return null
    const add = adds[0]!
    for (const cb of Array.from(prepareOwnReactionCallbacks.get(req.adapter) ?? [])) {
      const target = await cb(req).catch(() => null)
      if (target) {
        preparedReactionAdds.set(target, add)
        return target
      }
    }
    return null
  }
  const addPreparedWaitingReaction = async (
    req: ReactionRequest,
    prepared: OwnReactionTarget,
  ): Promise<ReactionResult> => {
    const add = preparedReactionAdds.get(prepared)
    if (!add) return { ok: false, code: 'unsupported', error: 'authenticated waiting-add capability unavailable' }
    return add(req).catch((err): ReactionResult => ({ ok: false, code: 'transient', error: describeError(err) }))
  }
  const removeOwnReaction = async (req: RemoveOwnReactionRequest): Promise<RemoveOwnReactionResult> => {
    for (const cb of removeOwnReactionCallbacks.get(req.adapter) ?? []) {
      const result = await cb(req).catch(
        (): RemoveOwnReactionResult => ({ ok: false, code: 'transient', error: 'own reaction cleanup failed' }),
      )
      if (result.ok || result.code !== 'unsupported') return result
    }
    return { ok: false, code: 'unsupported', error: 'own reaction cleanup unsupported' }
  }
  const waitingReactions = createWaitingReactionCoordinator({
    agentDir: options.agentDir,
    epoch: options.bootEpoch,
    add: addPreparedWaitingReaction,
    prepare: prepareOwnReaction,
    remove: removeOwnReaction,
  })
  const recoverWaitingReactions = (adapter?: ChannelKey['adapter']): Promise<void> => waitingReactions.recover(adapter)
  const registerPrepareOwnReaction = (adapter: ChannelKey['adapter'], cb: PrepareOwnReactionCallback): void => {
    const callbacks = prepareOwnReactionCallbacks.get(adapter) ?? new Set<PrepareOwnReactionCallback>()
    callbacks.add(cb)
    prepareOwnReactionCallbacks.set(adapter, callbacks)
  }
  const unregisterPrepareOwnReaction = (adapter: ChannelKey['adapter'], cb: PrepareOwnReactionCallback): void => {
    prepareOwnReactionCallbacks.get(adapter)?.delete(cb)
  }
  const registerRemoveOwnReaction = (adapter: ChannelKey['adapter'], cb: RemoveOwnReactionCallback): void => {
    const callbacks = removeOwnReactionCallbacks.get(adapter) ?? new Set<RemoveOwnReactionCallback>()
    callbacks.add(cb)
    removeOwnReactionCallbacks.set(adapter, callbacks)
    void recoverWaitingReactions(adapter).catch((err) =>
      logger.warn(`[channels] waiting reaction recovery failed: ${describeError(err)}`),
    )
  }
  const unregisterRemoveOwnReaction = (adapter: ChannelKey['adapter'], cb: RemoveOwnReactionCallback): void => {
    removeOwnReactionCallbacks.get(adapter)?.delete(cb)
  }

  // Best-effort acknowledgment: drop an :eyes: on the triggering inbound the
  // moment we decide to engage — but ONLY when the channel has no visible
  // "typing…" indicator. Where typing renders (slack/discord/telegram) the
  // heartbeat already signals "the bot is working", so the reaction would be
  // redundant noise; the :eyes: is the fallback ack for typing-less channels
  // (github, kakaotalk), replacing the old "On it" comment on GitHub.
  // Fire-and-forget so a reaction failure (missing permission, the adapter not
  // supporting reactions, a transient API error) can NEVER block engagement,
  // enqueueing, or the agent's actual reply. No reactionRef = nothing reactable
  // (synthetic inbounds, reaction-less adapters) = silent skip.
  const autoReactOnEngage = (event: InboundMessage): WaitingReactionHandle | null => {
    if (event.reactionRef === undefined || typingCapableAdapters.has(event.adapter)) return null
    return waitingReactions.acquire({
      adapter: event.adapter,
      workspace: event.workspace,
      chat: event.chat,
      thread: event.thread,
      reactionRef: event.reactionRef,
      emoji: ENGAGE_REACTION_EMOJI,
    })
  }

  // Awaitable for scoped effect callers, never a response/notice barrier.
  // A protected successor may retain presence without a remote toggle.
  const dropEngageReactions = (live: LiveSession, owners: WaitingReactionHandle[]): Promise<void> =>
    Promise.all(owners.map((owner) => dropOneEngageReaction(live.key, owner))).then(() => undefined)

  // Only the LAST engaging inbound of a coalesced batch should carry the eager
  // :eyes:. Called from enqueue() before the new inbound is pushed to roll the
  // ack off earlier queued-but-not-yet-drained inbounds. `delete` (not
  // overwrite) is load-bearing: a newer engaging inbound that has no reactionRef
  // must still strip the previous :eyes: rather than leave it stranded.
  const clearQueuedEngageReactions = (live: LiveSession): void => {
    const owners = live.promptQueue.flatMap((m) => (m.engageReaction !== undefined ? [m.engageReaction] : []))
    if (owners.length === 0) return
    for (const item of live.promptQueue) delete item.engageReaction
    void dropEngageReactions(live, owners)
  }

  const dropPendingReloadHandoffEngageReactions = (pending: PendingReloadHandoff): Promise<void> => {
    const owners = pending.inbounds.flatMap((item) => (item.engageReaction !== undefined ? [item.engageReaction] : []))
    for (const item of pending.inbounds) delete item.engageReaction
    return Promise.all(owners.map((owner) => dropOneEngageReaction(pending.key, owner))).then(() => undefined)
  }

  const dropOneEngageReaction = (_key: ChannelKey, owner: WaitingReactionHandle): Promise<void> =>
    waitingReactions.release(owner)

  const unregisterOutbound = (adapter: ChannelKey['adapter'], cb: OutboundCallback): void => {
    outboundCallbacks.get(adapter)?.delete(cb)
  }

  const registerTyping = (adapter: ChannelKey['adapter'], cb: TypingCallback): void => {
    let set = typingCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      typingCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterTyping = (adapter: ChannelKey['adapter'], cb: TypingCallback): void => {
    typingCallbacks.get(adapter)?.delete(cb)
  }

  const setTypingCapability = (adapter: ChannelKey['adapter'], supported: boolean): void => {
    if (supported) typingCapableAdapters.add(adapter)
    else typingCapableAdapters.delete(adapter)
  }

  const setTypingHeartbeatInterval = (adapter: ChannelKey['adapter'], intervalMs: number): void => {
    typingHeartbeatIntervals.set(adapter, intervalMs)
  }

  const typingHeartbeatIntervalFor = (adapter: ChannelKey['adapter']): number =>
    typingHeartbeatIntervals.get(adapter) ?? TYPING_HEARTBEAT_MS

  const setAdapterConfigured = (adapter: ChannelKey['adapter'], configured: boolean): void => {
    if (configured) configuredAdapters.add(adapter)
    else configuredAdapters.delete(adapter)
  }

  const registerChannelNameResolver = (adapter: ChannelKey['adapter'], resolver: ChannelNameResolver): void => {
    let set = channelNameResolvers.get(adapter)
    if (!set) {
      set = new Set()
      channelNameResolvers.set(adapter, set)
    }
    set.add(resolver)
  }

  const unregisterChannelNameResolver = (adapter: ChannelKey['adapter'], resolver: ChannelNameResolver): void => {
    channelNameResolvers.get(adapter)?.delete(resolver)
  }

  const registerSelfIdentity = (adapter: ChannelKey['adapter'], resolver: ChannelSelfIdentityResolver): void => {
    selfIdentityResolvers.set(adapter, resolver)
  }

  const unregisterSelfIdentity = (adapter: ChannelKey['adapter'], resolver: ChannelSelfIdentityResolver): void => {
    if (selfIdentityResolvers.get(adapter) === resolver) {
      selfIdentityResolvers.delete(adapter)
    }
  }

  const resolveSelfIdentity = (key: ChannelKey): ChannelSelfIdentity | undefined => {
    const resolver = selfIdentityResolvers.get(key.adapter)
    if (resolver === undefined) return undefined
    return resolver(key.workspace) ?? undefined
  }

  const registerMembership = (adapter: ChannelKey['adapter'], resolver: MembershipResolver): void => {
    let set = membershipResolvers.get(adapter)
    if (!set) {
      set = new Set()
      membershipResolvers.set(adapter, set)
    }
    set.add(resolver)
    if (!membershipCaches.has(adapter)) {
      membershipCaches.set(
        adapter,
        createMembershipCache({ resolver: resolveThroughRegisteredMembership, now, logger }),
      )
    }
  }

  const unregisterMembership = (adapter: ChannelKey['adapter'], resolver: MembershipResolver): void => {
    membershipResolvers.get(adapter)?.delete(resolver)
    if ((membershipResolvers.get(adapter)?.size ?? 0) === 0) {
      membershipCaches.delete(adapter)
    }
  }

  const registerHistory = (adapter: ChannelKey['adapter'], cb: HistoryCallback): void => {
    let set = historyCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      historyCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterHistory = (adapter: ChannelKey['adapter'], cb: HistoryCallback): void => {
    historyCallbacks.get(adapter)?.delete(cb)
  }

  const isReadCapabilityUnavailable = (adapter: ChannelKey['adapter'], capability: ReadCapability): boolean =>
    configuredAdapters.has(adapter) && ADAPTER_READ_CAPABILITIES[adapter].includes(capability)

  const missingCallbackError = (adapter: ChannelKey['adapter'], capability: ReadCapability): string =>
    isReadCapabilityUnavailable(adapter, capability)
      ? `${capability}-adapter-unavailable: the "${adapter}" adapter is configured but not currently running (it likely failed to start, e.g. an expired token or auth error — check the container logs and re-authenticate)`
      : `${capability}-not-supported`

  // A live callback that throws or times out is a FAILURE of a capability the
  // adapter has, not the absence of one. Collapsing it into `*-not-supported`
  // would tell the model the feature does not exist, and it will relay that to
  // a human as fact. The underlying error stays in the logs rather than the
  // model-facing string, matching `missingCallbackError`.
  const callbackFailureError = (adapter: ChannelKey['adapter'], capability: ReadCapability): string =>
    `${capability}-adapter-error: the "${adapter}" adapter supports ${capability} but the call failed or timed out. This is a live adapter failure, NOT an unsupported capability — check the container logs for the underlying error, then retry.`

  const isWriteCapabilityUnavailable = (adapter: ChannelKey['adapter'], capability: WriteCapability): boolean =>
    configuredAdapters.has(adapter) && ADAPTER_WRITE_CAPABILITIES[adapter].includes(capability)

  const fetchHistory = async (adapter: ChannelKey['adapter'], args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const callbacks = historyCallbacks.get(adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: missingCallbackError(adapter, 'history') }
    }
    // Snapshot before iterating, mirroring `send`: a callback that mutates
    // the set (e.g. unregisters mid-call) must not skip siblings.
    const snapshot = Array.from(callbacks)
    let lastError: FetchHistoryResult & { ok: false } = { ok: false, error: 'history-not-supported' }
    for (const cb of snapshot) {
      try {
        const result = await raceWithTimeout(cb(args), fetchHistoryTimeoutMs, `[channels] ${adapter} history fetch`)
        if (result.ok) return result
        lastError = result
      } catch (err) {
        logger.warn(`[channels] history fetch threw for ${adapter}: ${describeError(err)}`)
        lastError = { ok: false, error: callbackFailureError(adapter, 'history') }
      }
    }
    return lastError
  }

  const registerMessageGet = (adapter: ChannelKey['adapter'], cb: MessageGetCallback): void => {
    messageGetCallbacks.set(adapter, cb)
  }

  const unregisterMessageGet = (adapter: ChannelKey['adapter'], cb: MessageGetCallback): void => {
    if (messageGetCallbacks.get(adapter) === cb) messageGetCallbacks.delete(adapter)
  }

  const getMessage = async (adapter: ChannelKey['adapter'], args: GetMessageArgs): Promise<GetMessageResult> => {
    const cb = messageGetCallbacks.get(adapter)
    if (cb === undefined)
      return isReadCapabilityUnavailable(adapter, 'message-get')
        ? { ok: false, error: missingCallbackError(adapter, 'message-get'), code: 'adapter-unavailable' }
        : { ok: false, error: 'message-get-not-supported', code: 'not-supported' }
    try {
      return await raceWithTimeout(cb(args), fetchHistoryTimeoutMs, `[channels] ${adapter} message get`)
    } catch (err) {
      logger.warn(`[channels] message get threw for ${adapter}: ${describeError(err)}`)
      return { ok: false, error: callbackFailureError(adapter, 'message-get'), code: 'adapter-error' }
    }
  }

  const registerList = (adapter: ChannelKey['adapter'], cb: ListCallback): void => {
    listCallbacks.set(adapter, cb)
  }

  const unregisterList = (adapter: ChannelKey['adapter'], cb: ListCallback): void => {
    if (listCallbacks.get(adapter) === cb) listCallbacks.delete(adapter)
  }

  const listChannels = async (adapter: ChannelKey['adapter'], args: ListChannelsArgs): Promise<ListChannelsResult> => {
    const cb = listCallbacks.get(adapter)
    if (cb === undefined)
      return isReadCapabilityUnavailable(adapter, 'list')
        ? { ok: false, error: missingCallbackError(adapter, 'list'), code: 'adapter-unavailable' }
        : { ok: false, error: 'list-not-supported', code: 'not-supported' }
    try {
      return await raceWithTimeout(cb(args), fetchHistoryTimeoutMs, `[channels] ${adapter} list channels`)
    } catch (err) {
      logger.warn(`[channels] list channels threw for ${adapter}: ${describeError(err)}`)
      return { ok: false, error: callbackFailureError(adapter, 'list'), code: 'adapter-error' }
    }
  }

  const registerEditMessage = (adapter: ChannelKey['adapter'], cb: EditMessageCallback): void => {
    let set = editMessageCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      editMessageCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterEditMessage = (adapter: ChannelKey['adapter'], cb: EditMessageCallback): void => {
    editMessageCallbacks.get(adapter)?.delete(cb)
  }

  const editMessage = async (req: EditMessageRequest): Promise<EditMessageResult> => {
    // Strip leaked `<think>` blocks before the edit reaches any adapter, exactly
    // as the send path does via normalizeSendText — an edit is another way text
    // reaches the chat, so it must not become a hole that writes raw reasoning a
    // send would have suppressed. A replacement that is ONLY a think block leaves
    // nothing visible, so refuse rather than blank the message.
    const normalized = normalizeSendText(req.text)
    if (normalized === undefined) {
      return { ok: false, error: 'message-edit-empty-after-normalization', code: 'not-found' }
    }
    const normalizedReq = normalized === req.text ? req : { ...req, text: normalized }
    const callbacks = editMessageCallbacks.get(req.adapter)
    if (!callbacks || callbacks.size === 0) {
      return isWriteCapabilityUnavailable(req.adapter, 'message-edit')
        ? {
            ok: false,
            error: `message-edit-adapter-unavailable: the "${req.adapter}" adapter is configured but not currently running (it likely failed to start, e.g. an expired token or auth error — check the container logs and re-authenticate)`,
            code: 'adapter-unavailable',
          }
        : { ok: false, error: 'message-edit-not-supported', code: 'not-supported' }
    }
    const snapshot = Array.from(callbacks)
    let lastError: EditMessageResult & { ok: false } = { ok: false, error: 'message-edit-not-supported' }
    for (const cb of snapshot) {
      try {
        const result = await raceWithTimeout(
          cb(normalizedReq),
          fetchHistoryTimeoutMs,
          `[channels] ${req.adapter} edit message`,
        )
        if (result.ok) return result
        lastError = result
      } catch (err) {
        logger.warn(`[channels] edit message threw for ${req.adapter}: ${describeError(err)}`)
        lastError = { ok: false, error: `edit message failed: ${describeError(err)}` }
      }
    }
    return lastError
  }

  const registerFetchAttachment = (adapter: ChannelKey['adapter'], cb: FetchAttachmentCallback): void => {
    let set = fetchAttachmentCallbacks.get(adapter)
    if (!set) {
      set = new Set()
      fetchAttachmentCallbacks.set(adapter, set)
    }
    set.add(cb)
  }

  const unregisterFetchAttachment = (adapter: ChannelKey['adapter'], cb: FetchAttachmentCallback): void => {
    fetchAttachmentCallbacks.get(adapter)?.delete(cb)
  }

  const fetchAttachment = async (
    adapter: ChannelKey['adapter'],
    args: FetchAttachmentArgs,
  ): Promise<FetchAttachmentResult> => {
    const callbacks = fetchAttachmentCallbacks.get(adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `no fetchAttachment callback registered for "${adapter}"` }
    }
    const snapshot = Array.from(callbacks)
    // Initialized only so TypeScript can prove the variable is assigned
    // before return. The loop body always overwrites it on the failure
    // path (we just returned on the success path), so this string is
    // unreachable at runtime — kept as a clearly-tagged sentinel rather
    // than a non-null assertion so a future loop refactor that breaks
    // this invariant surfaces a recognizable error string.
    let lastError: FetchAttachmentResult & { ok: false } = {
      ok: false,
      error: `fetchAttachment for "${adapter}" returned no result (router bug)`,
    }
    for (const cb of snapshot) {
      const result = await cb(args)
      if (result.ok) return result
      lastError = result
    }
    return lastError
  }

  const registerReviewThreadResolver = (adapter: ChannelKey['adapter'], resolver: ReviewThreadResolver): void => {
    reviewThreadResolvers.set(adapter, resolver)
  }

  const unregisterReviewThreadResolver = (adapter: ChannelKey['adapter'], resolver: ReviewThreadResolver): void => {
    if (reviewThreadResolvers.get(adapter) === resolver) {
      reviewThreadResolvers.delete(adapter)
    }
  }

  const resolveReviewThread = async (req: ReviewThreadResolveRequest): Promise<ReviewThreadResolveResult> => {
    const resolver = reviewThreadResolvers.get(req.adapter)
    if (resolver === undefined) {
      return {
        ok: false,
        error: `adapter "${req.adapter}" does not support review-thread resolution`,
        code: 'unsupported',
      }
    }
    return await resolver(req).catch(
      (err): ReviewThreadResolveResult => ({ ok: false, error: describeError(err), code: 'transient' }),
    )
  }

  const registerReviewStateResolver = (adapter: ChannelKey['adapter'], resolver: ReviewStateResolver): void => {
    reviewStateResolvers.set(adapter, resolver)
  }

  const unregisterReviewStateResolver = (adapter: ChannelKey['adapter'], resolver: ReviewStateResolver): void => {
    if (reviewStateResolvers.get(adapter) === resolver) {
      reviewStateResolvers.delete(adapter)
    }
  }

  const getReviewState = async (req: ReviewStateRequest): Promise<ReviewStateResult> => {
    const resolver = reviewStateResolvers.get(req.adapter)
    if (resolver === undefined) {
      return { ok: false, error: `adapter "${req.adapter}" does not support review-state lookup`, code: 'unsupported' }
    }
    return await resolver(req).catch(
      (err): ReviewStateResult => ({ ok: false, error: describeError(err), code: 'transient' }),
    )
  }

  const registerReviewSubmitter = (adapter: ChannelKey['adapter'], submitter: ReviewSubmitter): void => {
    reviewSubmitters.set(adapter, submitter)
  }

  const unregisterReviewSubmitter = (adapter: ChannelKey['adapter'], submitter: ReviewSubmitter): void => {
    if (reviewSubmitters.get(adapter) === submitter) reviewSubmitters.delete(adapter)
  }

  const submitReview = async (req: SubmitReviewRequest): Promise<SubmitReviewResult> => {
    const submitter = reviewSubmitters.get(req.adapter)
    if (submitter === undefined) {
      return { ok: false, error: `adapter "${req.adapter}" does not support review submission`, code: 'unsupported' }
    }
    const sourceLive = req.sourceSessionId
      ? [...liveSessions.values()].find(
          (live) =>
            !live.destroyed &&
            live.sessionId === req.sourceSessionId &&
            live.key.adapter === req.adapter &&
            live.key.workspace === req.workspace &&
            live.key.chat === req.chat,
        )
      : liveSessions.get(channelKeyId({ ...req, thread: null }))
    const expectedAccountIdentity =
      req.expectedAccountIdentity ?? activeTurnAccountIdentity(sourceLive) ?? currentAccountIdentityFor(req)
    if (
      sourceLive &&
      (sourceLive.promptInFlight || sourceLive.inboundCoverage.length > 0 || sourceLive.backgroundCoverage.length > 0)
    ) {
      try {
        await ready
        inboundJournal.assertAvailable()
      } catch (error) {
        return { ok: false, error: `continuity persistence unavailable: ${describeError(error)}`, code: 'transient' }
      }
    }
    const currentAccount = currentAccountIdentityFor(req)
    if (
      expectedAccountIdentity !== undefined &&
      currentAccount !== undefined &&
      expectedAccountIdentity !== currentAccount
    ) {
      if (sourceLive) {
        try {
          await backgroundObligations.withTargetLane(sourceLive.key, () =>
            transferMismatchedAccountCoverageInLane(sourceLive),
          )
        } catch (error) {
          logger.error(`[channels] review account-change transfer failed: ${describeError(error)}`)
        }
      }
      return { ok: false, error: 'original channel account identity changed', code: 'permission-denied' }
    }
    return await submitter({ ...req, expectedAccountIdentity }).catch(
      (err): SubmitReviewResult => ({ ok: false, error: describeError(err), code: 'transient' }),
    )
  }

  const lookupInboundAttachment = (args: ChannelKey & { id: number }): InboundAttachment | null => {
    const live = liveSessions.get(channelKeyId(args))
    if (live === undefined) return null
    // Walk newest → oldest so that when an id collides across messages
    // (e.g. two photos in the same session each labelled `#1`) the agent's
    // `attachment_id: 1` always resolves to the CURRENT inbound's
    // attachment. currentTurnAttachments holds the in-flight turn — the
    // only place the about-to-be-viewed attachment lives once drain() has
    // spliced promptQueue empty — and is therefore the freshest; promptQueue
    // then holds any inbound that arrived mid-turn. Within each list,
    // append-order maps to wall-clock order, so iterating in reverse gives
    // recency.
    const found = findAttachmentById(live.currentTurnAttachments, args.id)
    if (found !== null) return found
    const haystacks: ReadonlyArray<ReadonlyArray<{ attachments?: readonly InboundAttachment[] }>> = [
      live.promptQueue,
      live.contextBuffer,
    ]
    for (const haystack of haystacks) {
      for (let i = haystack.length - 1; i >= 0; i--) {
        const item = haystack[i]
        const hit = item?.attachments?.find((attachment) => attachment.id === args.id)
        if (hit !== undefined) return hit
      }
    }
    return findAttachmentById(live.historyAttachments, args.id)
  }

  const listInboundAttachmentIds = (args: ChannelKey): readonly number[] => {
    const live = liveSessions.get(channelKeyId(args))
    if (live === undefined) return []
    const ids = new Set<number>()
    for (const attachment of live.currentTurnAttachments) ids.add(attachment.id)
    for (const item of [...live.promptQueue, ...live.contextBuffer]) {
      for (const attachment of item.attachments ?? []) ids.add(attachment.id)
    }
    for (const attachment of live.historyAttachments) ids.add(attachment.id)
    return Array.from(ids).sort((a, b) => a - b)
  }

  const registerHistoryAttachments = (key: ChannelKey, messages: readonly ChannelHistoryMessage[]): void => {
    const live = liveSessions.get(channelKeyId(key))
    if (live === undefined) return
    const incoming: TimedAttachment[] = messages.flatMap((message) =>
      (message.attachments ?? []).map((attachment) => ({ ts: message.ts, attachment })),
    )
    if (incoming.length === 0) return
    // Order by message freshness, NOT append order: channel_history pages
    // OLDER messages via nextCursor, so a later call can deliver an OLDER ref.
    // findAttachmentById searches end-first, so the list MUST end with the
    // freshest ref or an older paged `#1` would shadow a newer one. Dedupe by
    // id keeping the freshest ts (a re-fetch of the same message is a no-op,
    // not a duplicate), sort ascending by ts, then keep the freshest LIMIT so
    // eviction drops the OLDEST refs, never newer ones.
    const byId = new Map<number, TimedAttachment>()
    for (const entry of [...live.historyTimedAttachments, ...incoming]) {
      const existing = byId.get(entry.attachment.id)
      if (existing === undefined || entry.ts >= existing.ts) byId.set(entry.attachment.id, entry)
    }
    const sorted = Array.from(byId.values()).sort((a, b) => a.ts - b.ts)
    const kept =
      sorted.length > HISTORY_ATTACHMENT_LIMIT ? sorted.slice(sorted.length - HISTORY_ATTACHMENT_LIMIT) : sorted
    live.historyTimedAttachments = kept
    live.historyAttachments = kept.map((entry) => entry.attachment)
  }

  const send = async (msg: OutboundMessage, opts?: SendOptions): Promise<SendResult> => {
    const source: SendSource = opts?.source ?? 'tool'
    const callbacks = outboundCallbacks.get(msg.adapter)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `no adapter registered for "${msg.adapter}"`, code: 'no-adapter' }
    }

    // Strip leaked `<think>` reasoning off the message itself, up front, so the
    // stripped text flows through EVERY downstream consumer: the flood check,
    // the duplicate guard, the quote-anchor prepend, and the adapter callback.
    // A body that was nothing but a think block collapses to undefined and is
    // delivered as a text-less send (attachments, if any, still go through).
    if (msg.text !== undefined) {
      msg = { ...msg, text: normalizeSendText(msg.text) }
    }

    const authoredText = msg.text
    if (authoredText !== undefined) {
      const flood = checkOutboundFlood(authoredText)
      if (!flood.ok) return { ok: false, error: OUTBOUND_FLOOD_ERROR, code: 'outbound-flood' }
    }
    // Recovery is a transport-only operation. Do not even look up the live
    // session: doing so would let a delayed notice alter a newer logical turn.
    if (opts?.accounting === 'recovery') {
      for (const callback of Array.from(callbacks)) {
        const result = await callback({ ...msg, sendOptions: opts })
        if (result.ok) return result
        return result
      }
      return { ok: false, error: 'no recovery transport available', code: 'no-adapter' }
    }

    const accountingTarget = opts?.accountingTarget ?? {
      adapter: msg.adapter,
      workspace: msg.workspace,
      chat: msg.chat,
      thread: msg.thread ?? null,
    }
    const deliveryMatchesAccounting =
      accountingTarget.adapter === msg.adapter &&
      accountingTarget.workspace === msg.workspace &&
      accountingTarget.chat === msg.chat &&
      accountingTarget.thread === (msg.thread ?? null)
    const keyId = channelKeyId(accountingTarget)
    const live = liveSessions.get(keyId)
    const originalTurnAccount = activeTurnAccountIdentity(live)
    const sameAdapterAccountScope =
      accountingTarget.adapter === msg.adapter && accountingTarget.workspace === msg.workspace
    const expectedAccountIdentity =
      opts?.expectedAccountIdentity ?? (sameAdapterAccountScope ? originalTurnAccount : currentAccountIdentityFor(msg))
    const dependentLiveSend =
      live &&
      (source === 'tool' || opts?.outputKind === 'substantive' || opts?.accounting === 'live-turn') &&
      (live.promptInFlight || live.inboundCoverage.length > 0 || live.backgroundCoverage.length > 0)
    if (dependentLiveSend) {
      try {
        await ready
        inboundJournal.assertAvailable()
      } catch (error) {
        return { ok: false, error: `continuity persistence unavailable: ${describeError(error)}` }
      }
    }
    // Credit sticky where the reply was PUBLISHED, not where it was accounted.
    // The two diverge when a caller answers from one sub-surface but publishes
    // to another in the same room — `postDuplicateRequestChangesComment` sends
    // with `thread: null` while passing the review-thread session as
    // `accountingTarget`. An inbound is keyed from its OWN tuple, so the human's
    // follow-up consumes the root key and finds nothing: the reply was observed
    // and silently dropped.
    //
    // Delivery-only, not both. A dual grant cannot be undone atomically —
    // `clearSticky` clears one key, so `channel_disengage` on the originating
    // thread would strand the root credit. It also buys nothing here: GitHub
    // review-comment inbounds set `suppressSticky`, so they never reach the
    // sticky gate and engage via `replyToBotMessageId` instead.
    //
    // Same adapter/workspace/chat only. `targets` are authors of the ACCOUNTING
    // turn and author ids are namespaced per adapter, so redirecting a genuine
    // cross-channel send would credit ids that cannot appear in that room.
    const stickyGrantKeyId =
      !deliveryMatchesAccounting &&
      accountingTarget.adapter === msg.adapter &&
      accountingTarget.workspace === msg.workspace &&
      accountingTarget.chat === msg.chat
        ? channelKeyId({
            adapter: msg.adapter,
            workspace: msg.workspace,
            chat: msg.chat,
            thread: msg.thread ?? null,
          })
        : keyId
    const sendKey = consecutiveSendKey(accountingTarget.chat, accountingTarget.thread)
    // Tool-source sends consume the captured quote candidate exactly
    // once per turn — the intervening-observed check runs HERE against
    // the live buffer so the relevant signal is actual channel chatter
    // between inbound and reply landing, not drain-vs-send timing
    // artifacts. System sources (recovery, role-
    // claim) skip so they can't accidentally swallow the candidate
    // before the model's own first reply lands. Even when the decision
    // returns null (nothing intervened), the candidate is cleared — a
    // multi-part reply must not retroactively anchor chunk 2.
    if (live && deliveryMatchesAccounting && source === 'tool' && live.pendingQuoteCandidate !== null) {
      const quoteCandidate = refreshQuoteCandidate(live.pendingQuoteCandidate, live.contextBuffer)
      const anchor = decideQuoteAnchor(quoteCandidate, now(), options.configForAdapter(msg.adapter))
      if (anchor !== null) {
        msg =
          resolveReplyRenderMode(msg) === 'native'
            ? { ...msg, replyTo: { externalMessageId: anchor.externalMessageId, source: anchor.source } }
            : { ...msg, text: prependQuoteAnchor(msg.text ?? '', anchor.source) }
      }
      live.pendingQuoteCandidate = null
    }
    const text = normalizeSendText(msg.text)
    const continuationWillingness = text !== undefined && detectContinuationWillingness(text)
    const outputKind = opts?.outputKind ?? (continuationWillingness ? 'status' : 'substantive')

    // Central enforcement. Tool-initiated sends are subject to two policies:
    // a per-turn count cap (kills runaway loops regardless of content) and
    // an exact-duplicate guard (kills the byte-identical-spam sub-mode).
    // Both checks AND the state mutations they consult happen synchronously
    // before any `await`, so two concurrent `router.send` calls for the same
    // target (the parallel-tool-execution race) cannot both pass: the
    // second observer sees the first one's increment / lastSentText write.
    // System sources (validateChannelTurn recovery, role-claim reply) bypass
    // — those are one-shot paths the policy doesn't apply to.
    let priorLastSentText: string | undefined
    let reserved = false
    if (live && source === 'tool') {
      // Every same-turn policy denial (skip-locked / turn-cap / duplicate)
      // returns a soft error and does NOT increment `consecutiveSends`, so a
      // model that ignores the denial and retries never trips the send cap. To
      // bound that loop we route all three through one tally that ABORTS the run
      // past the ceiling. The discriminator that keeps legitimate parallel
      // send-bursts soft: a denial only counts when NO reservation for the same
      // target is in flight. In a `Promise.all` burst the synchronous denials
      // all race the one in-flight winner, so they don't count; a sequential
      // retry loop has nothing in flight, so it does. See
      // `MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN`.
      //
      // Why abort, not throw: pi-agent-core's tool executor catches a throw
      // from a tool's execute() and converts it into an `isError` tool result —
      // the turn would continue and the model could retry. The only thing that
      // actually ends an in-flight turn is aborting the run's AbortSignal:
      // `agent.abort()` flips it synchronously, then the NEXT assistant stream
      // (after this tool returns) sees the aborted signal and ends the turn with
      // stopReason 'aborted'. We must NOT call `session.abort()` here — it
      // `await`s `waitForIdle()`, which would deadlock waiting for the very run
      // this tool call belongs to. `agent.abort()` is the signal-only,
      // non-blocking variant. We still return the soft denial for this call.
      const denyPolicyToolSend = (error: string, code: SendErrorCode): SendResult => {
        if ((live.inFlightToolSends.get(sendKey) ?? 0) > 0) {
          return { ok: false, error, code }
        }
        const count = (live.policyDeniedToolSendsThisTurn.get(sendKey) ?? 0) + 1
        live.policyDeniedToolSendsThisTurn.set(sendKey, count)
        if (count >= MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN) {
          logger.warn(
            `[channels] ${live.keyId}: aborting turn — ${count} policy-denied channel sends (last: ${code}) site=policy_denied_send_cap session=${live.sessionId} reason=policy_denied:${code}`,
          )
          live.abortReasonThisTurn = { turnSeq: live.turnSeq, reason: `policy_denied:${code}` }
          if (live.session.agent.signal?.aborted !== true) live.session.agent.abort()
        }
        return { ok: false, error, code }
      }
      // Tool-source send after `skip_response` for the same turn is a contract
      // violation: the model already committed to silence. Reject before any
      // state mutation so the model gets a clear error and the channel stays
      // silent. System-source sends (recovery, role-claim) are not affected.
      // Record the contested skip so `validateChannelTurn` doesn't ALSO drop the
      // reply text on the floor — the live send stays denied, but the post-turn
      // recovery net must still surface what the model wanted to say.
      if (live.skippedTurn !== null && live.skippedTurn.turnSeq === live.turnSeq) {
        live.skipLockedSendTurn = live.turnSeq
        return denyPolicyToolSend(SKIP_RESPONSE_LOCK_ERROR, 'skip-locked')
      }
      const currentCount = live.consecutiveSends.get(sendKey) ?? 0
      if (currentCount >= MAX_CHANNEL_SENDS_PER_TURN) {
        return denyPolicyToolSend(TURN_CAP_ERROR, 'turn-cap')
      }
      if (text !== undefined && live.lastSentText.get(sendKey) === text) {
        return denyPolicyToolSend(DUPLICATE_SEND_ERROR, 'duplicate')
      }
      // Reserve the slot before awaiting. If the callback rejects we roll
      // back below; if it succeeds we keep the increment. The slot reserve
      // is what makes parallel tool calls safe. We also snapshot the prior
      // lastSentText so a transient delivery failure can be retried with
      // the same text — the dup-guard exists to stop runaway loops, not to
      // strand the model on a flaky adapter.
      priorLastSentText = live.lastSentText.get(sendKey)
      live.consecutiveSends.set(sendKey, currentCount + 1)
      if (text !== undefined) live.lastSentText.set(sendKey, text)
      live.inFlightToolSends.set(sendKey, (live.inFlightToolSends.get(sendKey) ?? 0) + 1)
      reserved = true
    }

    // The adapter needs the typing anchor to clear a flat-DM status (msg.thread
    // is null there, so a thread-keyed clear would no-op). Kept off msg.thread
    // to leave reply threading untouched.
    if (live?.currentTurnTypingThread != null && deliveryMatchesAccounting && msg.typingThread === undefined) {
      msg = { ...msg, typingThread: live.currentTurnTypingThread }
    }

    // Snapshot the callbacks before iterating so a callback that mutates the
    // set (e.g. unregisters mid-send) does not cause the iterator to skip
    // siblings or trip into surprising behavior.
    const snapshot = Array.from(callbacks)
    let lastError: string | undefined
    let delivered = false
    let messageId: string | undefined
    let messageIds: readonly string[] | undefined
    let reactionRef: ReactionRef | undefined
    try {
      for (const cb of snapshot) {
        if (dependentLiveSend && !inboundJournal.health().available) {
          lastError = 'continuity persistence unavailable'
          break
        }
        if (dependentLiveSend && live && originalTurnAccount !== undefined) {
          const currentSourceAccount = currentAccountIdentityFor(live.key)
          if (currentSourceAccount !== undefined && currentSourceAccount !== originalTurnAccount) {
            await backgroundObligations.withTargetLane(live.key, () => transferMismatchedAccountCoverageInLane(live))
            lastError = 'original channel account identity changed'
            break
          }
        }
        if (expectedAccountIdentity !== undefined) {
          const currentAccount = currentAccountIdentityFor(msg)
          if (currentAccount !== undefined && currentAccount !== expectedAccountIdentity) {
            if (live && sameAdapterAccountScope)
              await backgroundObligations.withTargetLane(live.key, () => transferMismatchedAccountCoverageInLane(live))
            lastError = 'original channel account identity changed'
            break
          }
        }
        const result = await cb(
          expectedAccountIdentity === undefined
            ? msg
            : {
                ...msg,
                sendOptions: { ...opts, accounting: 'live-turn', expectedAccountIdentity },
              },
        )
        if (result.ok) {
          delivered = true
          messageId = result.messageId
          messageIds = result.messageIds
          reactionRef = result.reactionRef
          break
        }
        lastError = result.error
      }
    } finally {
      // Clear the in-flight reservation even if a callback threw, so a flaky
      // adapter can never strand a target as permanently "in flight" and
      // disable the policy-denial guard for it.
      if (live && reserved) {
        const inFlight = (live.inFlightToolSends.get(sendKey) ?? 1) - 1
        if (inFlight <= 0) live.inFlightToolSends.delete(sendKey)
        else live.inFlightToolSends.set(sendKey, inFlight)
      }
    }

    if (!delivered) {
      // Roll back the slot reservation so a failed send doesn't burn cap
      // budget or poison the dup-guard. Restoring lastSentText to its
      // prior value (which may be undefined) lets a legitimate retry of
      // the same text succeed — the dup-guard is for loops, not flake.
      if (live && reserved) {
        const after = (live.consecutiveSends.get(sendKey) ?? 1) - 1
        if (after <= 0) live.consecutiveSends.delete(sendKey)
        else live.consecutiveSends.set(sendKey, after)
        if (priorLastSentText === undefined) live.lastSentText.delete(sendKey)
        else live.lastSentText.set(sendKey, priorLastSentText)
      }
      return { ok: false, error: lastError ?? 'no callback accepted the outbound', code: 'callback-rejected' }
    }

    if (live && continuationWillingness && reactionRef !== undefined) {
      reactOnContinuationWillingness(live, reactionRef)
    } else if (live && !continuationWillingness && outputKind === 'substantive') {
      void dropContinuationReactions(live)
    }

    if (live) {
      live.successfulChannelSends++
      // Promise fulfillment follows OUTPUT KIND, never source:
      //   (a) ordinary substantive tool output clears;
      //   (b) multilingual continuation-willingness/status output preserves;
      //   (c) recovery prose explicitly marked substantive clears even though
      //       it uses the system bypass;
      //   (d) provider-error, empty-turn-fallback, and control notices are
      //       explicitly meta and preserve, so a warning can never self-clear.
      // The channel_reply afterToolCall hook above remains authoritative for its
      // machine-readable more_work_this_turn flag.
      if (outputKind === 'substantive') live.promisedWorkOutstandingThisLogicalTurn = false
      live.lastSendLeafId = live.session.sessionManager.getLeafEntry()?.id ?? null
      live.policyDeniedToolSendsThisTurn.delete(sendKey)
      // Don't stop the heartbeat here: the agent may still be mid-turn and
      // about to send another reply. drain()'s finally block owns turn-end
      // stop. But Slack's adapter outbound callback explicitly clears
      // platform-side typing after every successful postMessage (to defeat
      // the heartbeat-vs-postMessage race fixed in PR #52), so a fresh
      // 'tick' must land in the FIFO right after that clear — otherwise
      // the indicator stays cleared until the next 8s interval, leaving a
      // visible idle gap between mid-turn sends on Slack. The await on
      // cb(msg) above already drained the outbound callback's clearAfterSend
      // through the per-(chat,thread) FIFO, so this tick is guaranteed to
      // land after it. Discord and Telegram treat the extra tick as a
      // no-op refresh of their already-armed (auto-expiring) indicators.
      if (live.typingTimer) void fireTyping(live, 'tick')
      // Disengage is binding for the rest of the turn: if the model dropped
      // sticky via `channel_disengage` this turn, a same-turn ack reply must NOT
      // silently re-grant the credit it just cleared. Skipped only for the live
      // turn (matched by `turnSeq`); the next turn re-grants normally.
      const disengagedThisTurn = live.disengagedTurn !== null && live.disengagedTurn === live.turnSeq
      const adapterConfig = options.configForAdapter(msg.adapter)
      if (adapterConfig && !disengagedThisTurn) {
        const targets = new Set(live.currentTurnAuthorIds.size > 0 ? live.currentTurnAuthorIds : live.lastTurnAuthorIds)
        // A user the agent addresses by @-mention is a reply target too: their
        // next message answers us without re-mentioning the bot. Granting them
        // sticky closes the gap where the agent asks "<@U123> can you confirm?"
        // and that user's plain reply was observed until they re-pinged.
        // Self-mentions (e.g. a quoted inbound) are excluded — we credit the
        // OTHERS we addressed, not ourselves.
        if (text !== undefined) {
          const selfId = resolveSelfIdentity(live.key)?.id
          for (const id of extractMentionedUserIds(msg.adapter, text)) {
            if (id !== selfId) targets.add(id)
          }
        }
        if (targets.size > 0) {
          grantStickyForReplyTargets(
            stickyLedger,
            stickyGrantKeyId,
            Array.from(targets),
            adapterConfig.engagement,
            now(),
          )
        }
      }
      const turnCount = live.consecutiveSends.get(sendKey) ?? 0
      const rateCount = recordSendTimestamp(live, sendKey, now())
      const level = rateCount >= SEND_RATE_WARN_THRESHOLD ? 'warn' : 'info'
      const warn = rateCount >= SEND_RATE_WARN_THRESHOLD ? ' send_rate_warning' : ''
      const textLen = text !== undefined ? text.length : 0
      const fields = `source=${source} turn=${turnCount} rate=${rateCount}/${SEND_RATE_WINDOW_MS}ms text_len=${textLen}`
      logger[level](`[channels] ${live.keyId} send ${fields}${warn}`)
    }

    return {
      ok: true,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(messageIds !== undefined ? { messageIds } : {}),
      ...(reactionRef !== undefined ? { reactionRef } : {}),
    }
  }

  // The turn ended via terminal channel_reply completion. If that reply promised to keep
  // working but omitted `more_work_this_turn: true`, queue ONE reminder-only re-prompt so
  // the model gets a second chance to actually do it. The tool batch already
  // terminated (safe default preserved); this only adds an optional nudge. Bounded by
  // MAX_WILLINGNESS_NUDGES and gated on `promptQueue` being empty so a real
  // inbound that coalesced into this turn is never answered with a stale nudge.
  const maybeNudgeContinuationWillingness = (live: LiveSession): void => {
    const record = live.lastTerminalReplyCompletion
    live.lastTerminalReplyCompletion = null
    if (record === null || record.turnSeq !== live.turnSeq) return
    if (live.githubReviewThreadCloseout !== null || live.githubReviewThreadCloseoutDecisionTurn === live.turnSeq) {
      return
    }
    if (live.willingnessNudges >= MAX_WILLINGNESS_NUDGES) return
    if (live.promptQueue.length > 0) return
    if (record.text === undefined) return
    if (!detectContinuationWillingness(record.text)) return
    // A status promise can refer to a child from an earlier logical turn. Gate
    // only willingness recovery session-wide; ordinary empty-turn recovery stays
    // turn-scoped so unrelated later requests still get their own answer.
    if (isPinnedByRunningChild(live.sessionId, live.keyId, 'willingness_nudge')) {
      logger.info(`[channels] ${live.keyId} willingness_nudge_suppressed cause=awaiting_background_child`)
      return
    }
    live.willingnessNudges++
    logger.info(
      `[channels] ${live.keyId} willingness_nudge attempt=${live.willingnessNudges}/${MAX_WILLINGNESS_NUDGES}`,
    )
    live.pendingSystemReminders.push(retryReminder(WILLINGNESS_NUDGE))
  }

  const armRetainedOutputAckIfEligible = (
    live: LiveSession,
    successfulSendsBeforePrompt: number,
    explicitlySkipped: boolean,
  ): boolean => {
    // A formal GitHub review is user-facing output delivered outside the channel.
    // Preserve its acknowledgement even when the model closes the turn through
    // skip_response after publishing the review.
    if (
      live.githubReviewOutputTurn === live.turnSeq &&
      live.successfulChannelSends === successfulSendsBeforePrompt &&
      live.currentTurnAuthorId !== null
    ) {
      logger.info(`[channels] ${live.keyId} empty_turn_suppressed cause=github_review_output_this_turn`)
      armSilentTurnAck(live, 'github_review_output')
      return true
    }

    // An active child means delivery is deferred rather than dropped. Normally a
    // completed prose leaf still goes through reply recovery, but skip_response is
    // authoritative: its prose is intentionally discarded, while the progress
    // acknowledgement must remain until the child reports back.
    const awaitLeaf = recoverableAssistantText(live.session)
    const awaitLeafIsUnfinishedToolUse = awaitLeaf?.source === 'mid-turn' || awaitLeaf?.source === 'pre-tool'
    if (
      live.currentTurnAuthorId !== null &&
      (explicitlySkipped ||
        awaitLeaf === null ||
        awaitLeafIsUnfinishedToolUse ||
        endsWithNoReplySignal(awaitLeaf.text)) &&
      isAwaitingBackgroundChild(live, 'empty_turn_recovery')
    ) {
      logger.info(`[channels] ${live.keyId} empty_turn_suppressed cause=awaiting_background_child`)
      armSilentTurnAck(live, 'awaiting_background_child')
      return true
    }
    return false
  }

  const validateChannelTurn = async (live: LiveSession, successfulSendsBeforePrompt: number): Promise<void> => {
    // `skip_response` short-circuit. Honoring it bypasses recovery entirely.
    // Stale-flag protection: only honor when stamped on the just-completed
    // turn. A flag set by a previous turn that crashed before validation
    // would otherwise drop the next legitimate user-facing reply.
    //
    // Contested-skip carve-out: if the model ALSO attempted a tool-source send
    // this turn (denied `skip-locked` in `send()`, stamped on `skipLockedSendTurn`),
    // the skip is no longer a clean opt-out — the model produced reply text it
    // wanted delivered. The live send stays denied, but we must NOT also suppress
    // recovery, or the reply is silently dropped with nothing to retry it (the
    // inbound is already drained). Fall through to the normal recovery path, which
    // posts it via `source:'system'` under the existing NO_REPLY / leak guards.
    const skipContested = live.skipLockedSendTurn === live.turnSeq
    if (live.skippedTurn !== null && live.skippedTurn.turnSeq === live.turnSeq && !skipContested) {
      const { reason } = live.skippedTurn
      live.skippedTurn = null
      armRetainedOutputAckIfEligible(live, successfulSendsBeforePrompt, true)
      logger.info(`[channels] ${live.keyId} skipped_by_tool reason=${JSON.stringify(reason)}`)
      void dropContinuationReactions(live)
      return
    }
    if (live.skippedTurn !== null && live.skippedTurn.turnSeq === live.turnSeq) {
      // Clear the now-contested skip so it can't leak into a later turn's check.
      live.skippedTurn = null
      logger.info(`[channels] ${live.keyId} skip_contested_by_send recovering reply`)
    }
    const stageEmptyTurnFallback = (cause: string): void => {
      logger.warn(`[channels] ${live.keyId} empty_turn_fallback_staged cause=${cause}`)
      live.stagedFallbackCause = { cause, sendCountAtStage: live.successfulChannelSends }
    }

    const awaitLeaf = recoverableAssistantText(live.session)
    if (armRetainedOutputAckIfEligible(live, successfulSendsBeforePrompt, false)) return

    // Suppress a leaked tool call (never post the plumbing) and, while budget
    // remains, push a self-correction reminder so the same logical turn
    // re-prompts and the model can redo it with a real tool call. On exhaustion
    // we stay silent — a persistently-leaking model must not livelock, and
    // silence is safer than posting a fallback the user didn't ask for.
    const suppressToolLeakAndNudge = (live: LiveSession, leakedText: string): void => {
      if (live.toolLeakRetries < MAX_TOOL_LEAK_RETRIES) {
        live.toolLeakRetries++
        logger.warn(
          `[channels] ${live.keyId}: suppressed plain_text_tool_call_leak (nudge ` +
            `attempt=${live.toolLeakRetries}/${MAX_TOOL_LEAK_RETRIES}) text_len=${leakedText.length}`,
        )
        live.pendingSystemReminders.push(retryReminder(TOOL_CALL_LEAK_NUDGE))
        return
      }
      logger.warn(
        `[channels] ${live.keyId}: suppressed plain_text_tool_call_leak (retries exhausted, silent) ` +
          `text_len=${leakedText.length}`,
      )
    }

    const retryStrandedToolUse = async (cause: string, exhaustedCause: string): Promise<void> => {
      if (live.emptyTurnRetries < MAX_EMPTY_TURN_RETRIES) {
        live.emptyTurnRetries++
        const routerAbortReason =
          live.abortReasonThisTurn !== null && live.abortReasonThisTurn.turnSeq === live.turnSeq
            ? live.abortReasonThisTurn.reason
            : undefined
        const agentAbortReason =
          live.session.agent.signal?.aborted === true ? live.session.getAbortReason?.() : undefined
        const abortReason = routerAbortReason ?? agentAbortReason ?? 'unknown'
        logger.warn(
          `[channels] ${live.keyId} empty_turn_retry attempt=${live.emptyTurnRetries}/${MAX_EMPTY_TURN_RETRIES} ` +
            `cause=${cause} abort_reason=${abortReason}`,
        )
        live.pendingSystemReminders.push(retryReminder(STRANDED_TOOLUSE_CONTINUATION_NUDGE))
        return
      }
      await postEmptyTurnFallback(live, exhaustedCause)
    }

    // A real asker who received nothing cannot distinguish unfinished tool-use
    // narration from a completed answer. Posting that scratchpad can falsely
    // claim completion in the wrong language or before the tool result is
    // interpreted; treating it as deliberate silence strands the asker instead.
    // Keep both textless and text-bearing unfinished shapes on the established
    // bounded continuation ladder, while explicit NO_REPLY, queued fresh input,
    // observation-only turns, and every earlier delivery-deferred guard retain
    // their narrower silence contracts.
    const unfinishedToolUse = awaitLeaf
    const unfinishedToolUseWithoutReply =
      unfinishedToolUse !== null &&
      (unfinishedToolUse.source === 'mid-turn' || unfinishedToolUse.source === 'pre-tool') &&
      (unfinishedToolUse.text.trim() === '' || !endsWithNoReplySignal(unfinishedToolUse.text))
    if (
      unfinishedToolUseWithoutReply &&
      live.successfulChannelSends === successfulSendsBeforePrompt &&
      live.currentTurnAuthorId !== null &&
      live.promptQueue.length === 0
    ) {
      await retryStrandedToolUse('stranded_toolUse_without_send', 'stranded_toolUse_without_send_retries_exhausted')
      return
    }

    // A send landed this turn, but the model may have posted a `more_work_this_turn: true`
    // progress reply, kept working, then ENDED with its final answer as plain
    // prose — never calling a channel tool again. The terminal-reply abort fires
    // only for a `channel_reply` WITHOUT `more_work_this_turn: true`, so that `stopReason:
    // 'stop'` text leaf is left undelivered and unguarded (the false-receipt
    // guard is github-only). The discriminator is leaf IDENTITY: only when the
    // turn-end `stop` leaf is a DIFFERENT entry than the one in place at the last
    // send did the model produce fresh post-reply prose. A leaf unchanged since
    // the send is narration the model emitted with/before the reply that already
    // landed — suppress it, as before.
    if (live.successfulChannelSends > successfulSendsBeforePrompt) {
      const terminalReplyCompletedThisTurn = live.lastTerminalReplyCompletion?.turnSeq === live.turnSeq
      maybeNudgeContinuationWillingness(live)

      // A `channel_reply({ more_work_this_turn: true })` progress ack landed this turn (the
      // machine-readable "I'll keep working" promise — `continueReplyTurn` is stamped
      // by installChannelReplyTerminalHook), the model did more work, then ended on a
      // FRESH empty `stop` — dropping its conclusion. This is the SAME degeneration as
      // the phrase-gated `channel_send` branch below, but keyed on the `more_work_this_turn: true`
      // FLAG instead of a natural-language willingness phrase. The flag is the robust
      // signal: it fires regardless of the ack's language or register, closing the gap
      // where a persona speaking a phrasing outside the willingness table (e.g. casual
      // Korean "확인해볼게") stranded the user in silence. The `attemptMadeToolCall`
      // half ties the first trigger to real post-ack work; `willingnessNudges > 0`
      // lets a retry that re-emitted `more_work_this_turn: true` and re-stranded spend the shared
      // budget toward the visible fallback instead of bailing silent. Same
      // MAX_WILLINGNESS_NUDGES bound, same empty-`promptQueue` gate (a coalesced live
      // inbound supersedes this turn's silence), and same nudge/fallback path as the
      // send-ack branch. Placed FIRST so the flag catch wins when both signals are
      // present; the phrase branch remains the only recovery for `channel_send`, which
      // stamps no flag. The `sendCount === successfulChannelSends` check requires the
      // continue-reply to STILL be the latest successful send: if a later substantive
      // send (e.g. a `channel_send` final answer) landed after the ack, the user was
      // already answered and a trailing empty stop must NOT be re-nudged.
      if (
        live.promptQueue.length === 0 &&
        live.currentTurnAuthorId !== null &&
        live.githubReviewThreadCloseout === null &&
        live.githubReviewThreadCloseoutDecisionTurn !== live.turnSeq &&
        live.continueReplyTurn?.turnSeq === live.turnSeq &&
        live.continueReplyTurn.sendCount === live.successfulChannelSends &&
        isFreshEmptyStopAfterSend(live) &&
        (attemptMadeToolCall(live.session) || live.willingnessNudges > 0)
      ) {
        if (live.willingnessNudges < MAX_WILLINGNESS_NUDGES) {
          live.willingnessNudges++
          logger.warn(
            `[channels] ${live.keyId} send_willingness_nudge attempt=${live.willingnessNudges}/${MAX_WILLINGNESS_NUDGES} ` +
              `cause=empty_stop_after_continue_reply`,
          )
          live.pendingSystemReminders.push(retryReminder(SEND_WILLINGNESS_NUDGE))
        } else {
          stageEmptyTurnFallback('empty_stop_after_continue_reply_nudges_exhausted')
        }
        return
      }

      // A `channel_send` ack that promised to keep working, fresh post-ack work,
      // then an EMPTY `stop` leaf: the model computed the answer in its reasoning
      // / tool results but never sent it (the Kimi/Fireworks empty-completion
      // flake). `maybeNudgeContinuationWillingness` above can't catch this — it
      // reads `lastTerminalReplyCompletion`, which only a `channel_reply` sets;
      // `channel_send` keeps the turn alive and stamps nothing. And the
      // stranded-toolUse retry below requires `source !== 'leaf'`, but an empty
      // `stop` leaf recovers as `source: 'leaf'`, so this shape would otherwise
      // fall straight through to the `endsWithNoReplySignal('')` → `no_reply`
      // classification. Discriminator (all on existing state, zero false positives
      // measured across the session corpus): a send landed AND the just-sent text
      // trips the precision-tuned willingness detector AND the turn-end leaf is a
      // FRESH empty `stop` (different entry than the ack's leaf — so the model did
      // post-ack work, not an ack-then-await-user stop). Bounded by
      // MAX_WILLINGNESS_NUDGES (shared with the reply path); on exhaustion post the
      // fallback rather than going silent, mirroring the stranded-toolUse path.
      // Gated on an empty `promptQueue` (like maybeNudgeContinuationWillingness): a
      // real inbound that coalesced into the just-finished prompt will be answered
      // by the next drain pass, and drain() splices pending reminders into that
      // batch — so injecting a stale recovery nudge would prepend it to a live user
      // message. Skip the nudge AND the fallback in that case and let the trailing
      // recovery below run; the queued inbound supersedes this turn's silence.
      if (
        live.promptQueue.length === 0 &&
        live.currentTurnAuthorId !== null &&
        live.githubReviewThreadCloseout === null &&
        live.githubReviewThreadCloseoutDecisionTurn !== live.turnSeq &&
        isEmptyStopAfterWillingnessAck(live)
      ) {
        if (live.willingnessNudges < MAX_WILLINGNESS_NUDGES) {
          live.willingnessNudges++
          logger.warn(
            `[channels] ${live.keyId} send_willingness_nudge attempt=${live.willingnessNudges}/${MAX_WILLINGNESS_NUDGES} ` +
              `cause=empty_stop_after_send_ack`,
          )
          live.pendingSystemReminders.push(retryReminder(SEND_WILLINGNESS_NUDGE))
        } else {
          stageEmptyTurnFallback('empty_stop_after_send_ack_nudges_exhausted')
        }
        return
      }

      // A terminal channel_reply now ends the SDK tool batch with
      // ToolResult.terminate after its matching result is persisted. The leaf
      // therefore has the same toolResult-under-toolUse shape as genuinely
      // stranded post-status work, but this turn already delivered its final
      // answer and explicitly terminated. The 2026-08-28 Discord incident
      // crossed this distinction: validation re-prompted the completed turn as
      // `stranded_toolUse_after_send`, then subsequent inbounds accumulated on
      // the failed recovery branch. Keep willingness nudges queued above, but do
      // not send terminal completion through stranded-work recovery.
      if (terminalReplyCompletedThisTurn) return

      const trailing = recoverableAssistantText(live.session)
      if (trailing === null || trailing.source !== 'leaf') {
        // A `more_work_this_turn: true` status reply landed, then the turn stranded on an
        // unanswered `toolUse` (the post-tool follow-up never produced an
        // assistant message — aborted loop / cancelled stream). The promised
        // work never finished, so the user is left with a bare "checking now…"
        // and nothing after it. Re-prompt the same logical turn with the
        // continuation nudge so the model SUMMARIZES the tool results it already
        // gathered (still in this branch) and replies, instead of re-running the
        // investigation under EMPTY_TURN_RETRY_NUDGE's "answer directly" framing
        // and stranding again. On retry-exhaustion post the fallback rather than
        // returning silently — a retry turn that re-sends a status and re-strands
        // on the same no-prose shape must not deadair the user. Any postable
        // pre-tool/mid-turn prose is suppressed here as before (it was narration
        // that accompanied the already-landed reply); only the no-prose strand
        // gets a retry-or-fallback.
        if (leafIsStrandedToolUse(live.session) && live.currentTurnAuthorId !== null) {
          await retryStrandedToolUse('stranded_toolUse_after_send', 'stranded_toolUse_retries_exhausted')
        }
        return
      }
      if (live.session.sessionManager.getLeafEntry()?.id === live.lastSendLeafId) return
    }

    if (unfinishedToolUseWithoutReply) {
      logger.info(`[channels] ${live.keyId} empty_turn_suppressed cause=unfinished_toolUse_continuation_ineligible`)
      return
    }

    let candidate = recoverableAssistantText(live.session)
    // A `length` leaf is recovered ONLY when stripping leaked `<think>…</think>`
    // spans actually removed something AND leaves a postable reply. The removal
    // is the positive signal that this was leaked-reasoning-plus-real-prose (the
    // production shape: interleaved think-text ending in a complete answer) — a
    // truncated `length` leaf with no think evidence is genuinely ambiguous and
    // stays on the raised-budget empty-turn retry below, exactly as before.
    if (candidate?.source === 'length-leaf') {
      const stripped = stripThinkBlocks(candidate.text)
      const removedThink = stripped !== candidate.text
      candidate =
        removedThink &&
        stripped !== '' &&
        !endsWithNoReplySignal(stripped) &&
        !isUpstreamEmptyResponseSentinel(stripped)
          ? { ...candidate, text: stripped }
          : null
    }
    if (candidate === null) {
      // No recoverable assistant prose: the turn ended with no usable reply.
      // Three distinct shapes, handled differently:
      //
      //   1a. SKIP-LOCKED thrash — the model called `skip_response` (committed to
      //       silence) then tried to send; every attempt was denied skip-locked
      //       (skipLockedSendTurn === turnSeq). Honor the silence decision: stay
      //       silent, no fallback. Handled first, below.
      //
      //   1b. The model THRASHED the send path WITHOUT a skip commitment — denials
      //       tracked on policyDeniedToolSendsThisTurn (duplicate/cap). In practice
      //       these only accumulate after a real send landed, so the early return
      //       above usually fires first; if one ever reaches here, re-prompting
      //       would just re-thrash, so skip retry and post the fallback once.
      //
      //   2. The PURE reasoning-loop — no send was ever attempted; the model
      //      burned its budget thinking and produced nothing (the canonical
      //      kimi `stopReason: 'length'` / `aborted` degeneration). Re-prompt up
      //      to MAX_EMPTY_TURN_RETRIES with a neutral nudge; on exhaustion, fall
      //      back. The nudge is injected as a reminder-only turn so drain()'s
      //      while-loop re-runs session.prompt() against the same branch.
      //
      // The legitimate empty-state case (a TUI-only check before any user
      // prompt, no inbound this turn) is excluded: no batch means no real turn
      // to retry or apologize for — keep the historical silent bail there.
      const leafStopReason = assistantLeafStopReason(live.session)

      // A `stopReason: 'error'` leaf is an upstream provider failure (401, billing,
      // malformed response, etc.), NOT a reasoning-loop or budget exhaustion. It is
      // already captured by subscribeProviderErrors into `pendingProviderError`
      // (fired synchronously on `message_end` before `prompt()` resolves), and
      // `maybePostDeferredProviderError` in drain()'s finally posts the REDACTED
      // `safeMessage`. Retrying with EMPTY_TURN_RETRY_NUDGE would waste the budget
      // nudging the model about output length when the real fault is the provider;
      // posting EMPTY_TURN_FALLBACK_TEXT would mask the actual failure behind a
      // misleading "I got stuck" notice. Return early so the provider-error path
      // owns this turn's surface.
      if (leafStopReason === 'error') {
        logger.warn(`[channels] ${live.keyId} provider_error_turn deferring to provider-error notice`)
        return
      }

      const skipLockedThisTurn = live.skipLockedSendTurn === live.turnSeq
      const attemptedSendThisTurn = skipLockedThisTurn || live.policyDeniedToolSendsThisTurn.size > 0

      // Skip-locked thrash honors the skip with SILENCE, not the fallback. The
      // model called `skip_response` (committed to silence) then tried to send;
      // the send was denied skip-locked and a retry loop aborts the run, leaving
      // an `aborted` leaf whose reply text was a denied tool ARG — never
      // recoverable prose. EMPTY_TURN_FALLBACK_TEXT would be a false alarm here:
      // it reads as a system failure when the real state is the model's own
      // silence decision contradicted by a late reply. The pure turn-cap/duplicate
      // thrash below (no `skip_response`) never committed to silence, so it still
      // gets the fallback. Distinct log line keeps production signal.
      if (skipLockedThisTurn) {
        logger.warn(
          `[channels] ${live.keyId} skip_locked_send_thrash_suppressed ` +
            `denied_targets=${live.policyDeniedToolSendsThisTurn.size}`,
        )
        return
      }

      // Only a TRUNCATED assistant leaf — `length` (budget exhaustion) or
      // `aborted` (terminal-reply abort) — from a real conversational turn is a
      // degeneration worth retrying. `error` was already diverted above to the
      // provider-error path. A cold/empty turn (no inbound author, or no
      // assistant message at all) keeps the historical silent bail —
      // re-prompting it would manufacture replies to nothing.
      if (live.currentTurnAuthorId === null || leafStopReason === undefined) {
        logger.info(`[channels] ${live.keyId}: no recoverable assistant text in branch`)
        return
      }
      if (!attemptedSendThisTurn && live.emptyTurnRetries < MAX_EMPTY_TURN_RETRIES) {
        live.emptyTurnRetries++
        // Raise the re-prompt's budget ONLY for a `length` truncation: that is
        // the budget-exhaustion case (reasoning ate the whole pool before any
        // prose), so the retry needs room to finish thinking AND reply. `aborted`
        // is the terminal-reply abort, not budget exhaustion, so it retries under
        // the default backstop. Consumed one-shot by installChannelOutputCap on
        // the next prompt().
        if (leafStopReason === 'length') {
          live.nextPromptMaxTokens = CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS
        }
        logger.warn(
          `[channels] ${live.keyId} empty_turn_retry attempt=${live.emptyTurnRetries}/${MAX_EMPTY_TURN_RETRIES} ` +
            `max_tokens=${live.nextPromptMaxTokens ?? CHANNEL_MAX_OUTPUT_TOKENS}`,
        )
        live.pendingSystemReminders.push(retryReminder(EMPTY_TURN_RETRY_NUDGE))
        return
      }
      await postEmptyTurnFallback(live, attemptedSendThisTurn ? 'send_thrash' : 'retries_exhausted')
      return
    }

    const { text: candidateText, source } = candidate
    let assistantText = candidateText

    if (endsWithNoReplySignal(assistantText)) {
      // A BARE-EMPTY stop (no visible text, not an explicit NO_REPLY token) on
      // the armed cold-start solo-human fallback turn is the production "dropped
      // the owner's first question" shape — a model whiff on a direct one-on-one
      // question, not a deliberate decline. Give it the bounded empty-turn retry
      // with a dedicated nudge; on exhaustion post the visible fallback so the
      // human is never stranded on silence. Gated hard so deliberate silence
      // still stays silent: explicit NO_REPLY (non-empty trim), any turn that
      // already sent (successfulChannelSends moved), a queued fresh inbound (the
      // next drain answers it), and every turn outside the armed cold-start solo
      // path all fall through to the historical no_reply below.
      if (
        assistantText.trim() === '' &&
        source === 'leaf' &&
        live.coldStartSoloFallbackTurnActive &&
        live.currentTurnAuthorId !== null &&
        live.successfulChannelSends === successfulSendsBeforePrompt &&
        live.promptQueue.length === 0
      ) {
        if (live.emptyTurnRetries < MAX_EMPTY_TURN_RETRIES) {
          live.emptyTurnRetries++
          logger.warn(
            `[channels] ${live.keyId} empty_turn_retry attempt=${live.emptyTurnRetries}/${MAX_EMPTY_TURN_RETRIES} ` +
              `cause=cold_start_solo_bare_empty`,
          )
          live.pendingSystemReminders.push(retryReminder(COLD_START_REPLY_NUDGE))
          return
        }
        await postEmptyTurnFallback(live, 'cold_start_solo_bare_empty_retries_exhausted')
        return
      }
      // Deliberately AFTER the cold-start guard (that path has its own nudge). A
      // bare-empty stop that followed real tool work — but landed no send — is the
      // no-send sibling of the willingness-ack / stranded-toolUse degenerations
      // above: the model gathered results then emitted an empty completion instead
      // of the answer. Retry telling it to summarize what it already has; on
      // exhaustion post the visible fallback rather than stranding the asker on
      // silence. The cause LATCHES for the logical turn (`emptyStopAfterToolWorkArmed`):
      // the nudge tells the model not to re-run tools, so a compliant retry lands
      // another bare-empty stop with NO new tool call — requiring fresh tool work on
      // every attempt would silently drop exactly that shape with budget unspent.
      // Once armed, subsequent bare-empty stops keep spending the shared retry budget
      // toward the fallback. An explicit non-empty NO_REPLY still escapes to silence
      // (its `trim()` is non-empty, so the first condition fails and it falls through
      // to no_reply below); a bare-empty stop with no tool work AND never-armed stays
      // silent too.
      if (
        assistantText.trim() === '' &&
        source === 'leaf' &&
        (live.emptyStopAfterToolWorkArmed || attemptMadeToolCall(live.session)) &&
        live.currentTurnAuthorId !== null &&
        live.successfulChannelSends === successfulSendsBeforePrompt &&
        live.promptQueue.length === 0
      ) {
        live.emptyStopAfterToolWorkArmed = true
        if (live.emptyTurnRetries < MAX_EMPTY_TURN_RETRIES) {
          live.emptyTurnRetries++
          logger.warn(
            `[channels] ${live.keyId} empty_turn_retry attempt=${live.emptyTurnRetries}/${MAX_EMPTY_TURN_RETRIES} ` +
              `cause=empty_stop_after_tool_work`,
          )
          live.pendingSystemReminders.push(retryReminder(EMPTY_STOP_AFTER_TOOL_WORK_NUDGE))
          return
        }
        await postEmptyTurnFallback(live, 'empty_stop_after_tool_work_retries_exhausted')
        return
      }
      // Explicit NO_REPLY normally records a deliberate choice to stay silent.
      // Only the reminder iteration that consumed a willingness nudge is different:
      // the turn-persistent nudge budget remains nonzero after a substantive result,
      // so using it here would post a bogus fallback on a later unrelated reminder.
      if (
        isNoReplySignal(assistantText) &&
        live.willingnessReminderIteration &&
        live.successfulChannelSends === successfulSendsBeforePrompt &&
        live.promptQueue.length === 0
      ) {
        // Recheck at fallback time too: a reminder can already be queued when
        // the running child becomes visible to the router.
        if (isPinnedByRunningChild(live.sessionId, live.keyId, 'no_reply_after_willingness_nudge')) {
          logger.info(`[channels] ${live.keyId} empty_turn_suppressed cause=awaiting_background_child`)
          armSilentTurnAck(live, 'awaiting_background_child')
          return
        }
        await postEmptyTurnFallback(live, 'no_reply_after_willingness_nudge')
        return
      }
      const leakedReasoning = !isNoReplySignal(assistantText)
      if (
        assistantText.trim() !== '' &&
        live.backgroundCoverage.length === 0 &&
        live.inboundCoverage.length > 0 &&
        !live.willingnessReminderIteration
      ) {
        await settleBackgroundCoverage(live, 'intentionally-suppressed', 'explicit-no-reply')
      }
      logger.info(`[channels] ${live.keyId} no_reply${leakedReasoning ? ' (with_leaked_reasoning)' : ''}`)
      void dropContinuationReactions(live)
      return
    }

    // Prose-then-trailing-call leak: the model wrote a real reply and then
    // serialized a tool decision as a trailing block (the Discord skip_response
    // incident). Strip the plumbing and keep the prose BEFORE the whole-message
    // classification below, so a message that was ONLY the call still reaches the
    // existing name-dependent suppress/recover path, while a message with real
    // prose keeps that prose. Prefix-first: no arg-recovery, no nudge, no ack.
    const trailingLeak = stripTrailingLeakedToolCall(assistantText)
    if (trailingLeak !== null && trailingLeak.text !== '') {
      logger.warn(
        `[channels] ${live.keyId}: stripped trailing_tool_call_leak tool=${trailingLeak.toolName} ` +
          `text_len=${trailingLeak.text.length}`,
      )
      assistantText = trailingLeak.text
    }

    if (isUpstreamEmptyResponseSentinel(assistantText)) {
      logger.warn(
        `[channels] ${live.keyId}: suppressed upstream_empty_response_sentinel text_len=${assistantText.length}`,
      )
      return
    }

    if (isLikelyKimiChannelToolLeak(assistantText)) {
      logger.warn(`[channels] ${live.keyId}: suppressed kimi_tool_call_leak text_len=${assistantText.length}`)
      return
    }

    // Plain-text tool-call leak: the model serialized a tool call as ordinary
    // message text instead of producing a real tool call. Default is SUPPRESS —
    // that raw plumbing must never reach the channel. The two exceptions are
    // `channel_reply` / `channel_send`, whose leaked form carries a salvageable
    // user message: extract the `text` arg and recover the actual reply.
    // `suppress-silent` (skip_response) drops without a nudge because the model
    // already got the silence it asked for; `suppress-warn` (every other leaked
    // call) drops AND re-prompts the model to redo the turn with a real tool
    // call, bounded by MAX_TOOL_LEAK_RETRIES so it can't livelock.
    const plainTextToolCallKind = getPlainTextChannelToolCallKind(assistantText)
    if (plainTextToolCallKind === 'suppress-silent') {
      logger.warn(
        `[channels] ${live.keyId}: suppressed plain_text_tool_call_leak (silent) text_len=${assistantText.length}`,
      )
      return
    }
    if (plainTextToolCallKind === 'suppress-warn') {
      suppressToolLeakAndNudge(live, assistantText)
      return
    }
    if (plainTextToolCallKind !== null) {
      const extracted = extractPlainTextChannelToolCallText(assistantText)
      // A reply/send leak with no recoverable `text` (missing arg, empty value,
      // or fully-truncated) still owes the user a real message — treat it as a
      // warn-worthy leak, not a silent drop, so the model retries properly.
      if (extracted === null) {
        suppressToolLeakAndNudge(live, assistantText)
        return
      }
      // The extracted value is still untrusted model output: if it is itself a
      // no-reply signal, an empty-response sentinel, or another (nested) leaked
      // tool call, suppress it through the same guards rather than re-leaking.
      if (
        endsWithNoReplySignal(extracted) ||
        isUpstreamEmptyResponseSentinel(extracted) ||
        isLikelyKimiChannelToolLeak(extracted) ||
        isLikelyPlainTextChannelToolCall(extracted)
      ) {
        logger.warn(
          `[channels] ${live.keyId}: suppressed plain_text_channel_tool_call (unsafe extracted text) text_len=${extracted.length}`,
        )
        return
      }
      logger.warn(
        `[channels] ${live.keyId}: recovered plain_text_channel_tool_call kind=${plainTextToolCallKind} text_len=${extracted.length}`,
      )
      assistantText = extracted
    }

    // `source` distinguishes the completed recovery shapes for log triage:
    //   - 'leaf': the assistant message IS the leaf with stopReason 'stop'
    //     (existing behavior; model ended its turn with text but forgot to
    //     call channel_reply).
    //   - 'length-leaf': the assistant message hit the output cap, leaked
    //     reasoning was stripped, and a complete-looking answer survived.
    // Unfinished 'mid-turn' / 'pre-tool' prose never reaches this egress: the
    // terminal gate above either continues an eligible turn or preserves the
    // silence contract that made continuation ineligible.
    // Egress-level GitHub review guards. The false-receipt and re-review
    // stranding guards live inside the channel_reply / channel_send tool
    // handlers, but recovery surfaces trailing assistant prose through a
    // `source:'system'` send that never touches those handlers. A model that
    // ends its turn with a close-out ack ("that addresses the concern") instead
    // of calling a channel tool would otherwise post a verdict-shaped comment
    // while still holding its own CHANGES_REQUESTED — stranding the PR (PR #672).
    // Re-run the guards here and SUPPRESS on block: recovery cannot land the
    // missing formal review on the model's behalf, and posting the unguarded ack
    // is worse than dropping it — the next inbound re-prompts the model, which
    // can then land the verdict properly.
    const recoveryBlock = await evaluateRecoveryReviewGuards(live, assistantText)
    if (recoveryBlock !== null) {
      logger.warn(
        `[channels] ${live.keyId}: suppressed recovery (github review guard) reason=${JSON.stringify(recoveryBlock)} text_len=${assistantText.length}`,
      )
      return
    }

    // Duplicate guard on the FINAL outbound body. Must run here, after the
    // plain-text-tool-call extraction may have rewritten `assistantText` — a
    // dedupe on the raw leaf would miss a fresh `channel_reply({"text":"X"})`
    // leak leaf whose extracted body equals a reply already sent this turn. The
    // recovery send is `source:'system'`, which bypasses send()'s own dup guard,
    // so reject the byte-identical re-post here. No-op on the zero-send path:
    // `lastSentText` is cleared at batch start and only filled by this turn's
    // sends, so it never matches when nothing was sent.
    const sendKey = consecutiveSendKey(live.key.chat, live.key.thread)
    if (live.lastSentText.get(sendKey) === normalizeSendText(assistantText)) {
      logger.info(`[channels] ${live.keyId}: suppressed recovery (duplicate of reply already sent this turn)`)
      return
    }

    logger.warn(
      `[channels] ${live.keyId}: recovering assistant_text_without_channel_tool source=${source} text_len=${assistantText.length}`,
    )
    const capturedCoverage = await captureBackgroundResultCoverage(live.sessionId)
    const capturedInbound = await captureInboundResultCoverage(live.sessionId)
    const result = await send(
      {
        adapter: live.key.adapter,
        workspace: live.key.workspace,
        chat: live.key.chat,
        thread: live.key.thread,
        text: assistantText,
      },
      { source: 'system', outputKind: 'substantive' },
    )
    if (!result.ok) {
      logger.warn(`[channels] ${live.keyId}: recovery send failed: ${result.error}`)
    } else if (!detectContinuationWillingness(assistantText)) {
      await recordLandedBackgroundResponse(live, 'recovered-terminal-response', capturedCoverage, capturedInbound)
    }
  }

  // Returns a block reason when the recovered text would be denied by a github
  // review guard, or null when it is safe to surface. Non-github channels and
  // non-PR chats short-circuit inside each guard (adapter / `pr:\d+` checks), so
  // this is a no-op for everything except GitHub PR sessions.
  const evaluateRecoveryReviewGuards = async (live: LiveSession, text: string): Promise<string | null> => {
    const falseReceipt = checkFalseReceipt({
      sessionId: live.sessionId,
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      text,
      moreWorkThisTurn: false,
      resolveReviewThread: false,
    })
    if (falseReceipt.kind === 'block') return falseReceipt.reason

    const rereview = await evaluateRereviewGuard({
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      text,
      wantsResolve: false,
      moreWorkThisTurn: false,
      getReviewState: (req) => getReviewState(req),
    })
    if (rereview.block) return rereview.reason

    return null
  }

  const getConsecutiveSendCount = (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }): number => {
    const keyId = channelKeyId({
      adapter: target.adapter,
      workspace: target.workspace,
      chat: target.chat,
      thread: target.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    if (!live) return 0
    return live.consecutiveSends.get(consecutiveSendKey(target.chat, target.thread)) ?? 0
  }

  const hasQualifyingWorkThisLogicalTurn = (target: ChannelKey): boolean => {
    return liveSessions.get(channelKeyId(target))?.qualifyingWorkThisLogicalTurn === true
  }

  const getSendRate = (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }): { count: number; windowMs: number } => {
    const keyId = channelKeyId({
      adapter: target.adapter,
      workspace: target.workspace,
      chat: target.chat,
      thread: target.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    if (!live) return { count: 0, windowMs: SEND_RATE_WINDOW_MS }
    const sendKey = consecutiveSendKey(target.chat, target.thread)
    const buf = live.sendTimestamps.get(sendKey)
    if (!buf || buf.length === 0) return { count: 0, windowMs: SEND_RATE_WINDOW_MS }
    const cutoff = now() - SEND_RATE_WINDOW_MS
    let i = 0
    while (i < buf.length && buf[i]! <= cutoff) i++
    if (i > 0) buf.splice(0, i)
    return { count: buf.length, windowMs: SEND_RATE_WINDOW_MS }
  }

  const tearDownLive = async (live: LiveSession): Promise<void> => {
    live.destroyed = true
    // Release queued and in-flight temporary owners even if teardown occurs
    // before the turn-end cleanup. Protected acknowledgments remain intact.
    clearQueuedEngageReactions(live)
    void dropEngageReactions(live, live.currentTurnEngageReactions)
    live.currentTurnEngageReactions = []
    void dropContinuationReactions(live)
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    live.debounceTimer = null
    live.unsubProviderErrors?.()
    live.unsubProviderErrors = null
    live.unsubTypingActivity?.()
    live.unsubTypingActivity = null
    live.unsubTodoOutcome?.()
    live.unsubTodoOutcome = null
    await stopTypingHeartbeat(live)
    // Captured before the abort call: `draining` flips false in drain()'s own
    // finally once the turn it was guarding ends, so reading it here is the
    // only reliable signal that this teardown cut off a turn actually in
    // flight rather than an already-idle session.
    const abortedInFlightTurn = live.draining
    try {
      await live.session.abort()
      if (abortedInFlightTurn) {
        logger.warn(`[channels] ${live.keyId} abort site=teardown session=${live.sessionId} reason=teardown`)
      }
    } catch (err) {
      logger.warn(`[channels] abort failed for ${live.keyId}: ${describeError(err)}`)
    }
    await fireSessionEnd(live)
    try {
      await live.dispose()
    } catch (err) {
      logger.warn(`[channels] dispose failed for ${live.keyId}: ${describeError(err)}`)
    }
  }

  // Roll back an install when a post-install step (persist/prefetch) fails, so a
  // rejected ensureLive never leaves a warm session behind for later inbounds.
  const unwindInstalledLive = async (keyId: string, live: LiveSession): Promise<void> => {
    if (liveSessions.get(keyId) === live) liveSessions.delete(keyId)
    if (!live.destroyed) await tearDownLive(live)
  }

  const runIdleGc = async (): Promise<void> => {
    await expirePendingReloadHandoffs()
    for (const live of liveSessions.values()) {
      const closeout = live.githubReviewThreadCloseout
      const round = live.githubReviewRound
      if (live.destroyed || closeout === null) continue
      const unknownStateExpired =
        closeout.deferUntil?.kind === 'review-state-unknown' && closeout.deferUntil.expiresAt <= now()
      if (round === null && !unknownStateExpired) continue
      if (round?.carrierThread === live.key.thread) continue
      if (live.draining || live.promptQueue.length > 0 || live.pendingSystemReminders.length > 0) continue
      if (deferredPendingReviewRound(live) !== null) continue
      if (isAwaitingBackgroundChild(live, 'github-thread-closeout-release', closeout.startedAt)) continue
      const reason =
        round === null
          ? 'review_state_unknown_expired'
          : isGithubReviewRoundComplete(round, now)
            ? 'round_completed'
            : 'round_expired'
      logger.info(
        `[channels] ${live.keyId} github_thread_closeout_released pr=${closeout.prNumber} root=${closeout.rootCommentId}${round === null ? '' : ` round=${round.roundId}`} reason=${reason}`,
      )
      await enforceGithubReviewThreadCloseout(live)
      if (!live.draining && live.pendingSystemReminders.length > 0) void drain(live)
    }
    const t = now()
    const victims: LiveSession[] = []
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.draining) continue
      if (live.promptQueue.length > 0) continue
      // pendingSystemReminders is checked alongside promptQueue because both
      // represent pending work that drain() will process. Reminder injection
      // wakes an idle session immediately, but deliberately leaves a pending
      // inbound debounce in charge so both queues coalesce into one turn.
      if (live.pendingSystemReminders.length > 0) continue
      if (t - live.lastInboundAt <= SESSION_IDLE_MS) continue
      if (isPinnedByRunningChild(live.sessionId, live.keyId, 'idle_gc evicting')) continue
      victims.push(live)
    }
    for (const live of victims) {
      liveSessions.delete(live.keyId)
      logger.info(`[channels] ${live.keyId} idle_gc evicting after ${t - live.lastInboundAt}ms idle`)
      await tearDownLive(live)
    }
  }

  let gcTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void runIdleGc()
  }, SESSION_GC_INTERVAL_MS)
  // Don't keep the Bun process alive just for the GC tick; the host
  // server's WebSocket listener owns process lifetime.
  gcTimer.unref?.()

  const stop = async (): Promise<void> => {
    closing = true
    if (!options.inboundJournal) inboundJournal.cancelInitialization()
    unsubscribeJournalFailure()
    if (gcTimer) clearInterval(gcTimer)
    gcTimer = null
    liveGeneration++
    const pendingHandoffs = Array.from(pendingReloadHandoffs.values())
    pendingReloadHandoffs.clear()
    for (const pending of pendingHandoffs) {
      await reportDiscardedReloadHandoff(pending, 'router stopped before replay could complete')
    }
    const all = Array.from(liveSessions.values())
    liveSessions.clear()
    for (const live of all) {
      await tearDownLive(live)
    }
    try {
      await persistChain
    } finally {
      if (!options.inboundJournal) {
        await inboundJournal.close()
      }
    }
  }

  // Drops every in-memory session but KEEPS the on-disk records, so the next
  // inbound per channel rehydrates the same transcript through a fresh
  // createSession() — which re-renders the frozen system-prompt role block.
  // This is how a `roles.<name>.match` reload reaches live channel sessions.
  // Unlike stop() it leaves the GC timer running; unlike stale-rollover it
  // keeps the sessionId, so history survives.
  //
  // Bumping liveGeneration BEFORE the snapshot is what makes this race-free:
  // a session mid-creation (in `creating` but not yet in `liveSessions`) won't
  // appear in the snapshot below, but it captured the old generation and will
  // self-dispose at its install guard instead of resurrecting stale role state.
  const tearDownAllLive = async (): Promise<void> => {
    liveGeneration++
    const all = Array.from(liveSessions.values())
    // A session mid-turn is deferred, not aborted: tearing it down here calls
    // session.abort(), which kills the in-flight reply — including the very turn
    // that triggered this reload, leaving the user in silence. Such a session
    // stays in liveSessions (so a concurrent inbound coalesces into the running
    // turn instead of spawning a duplicate) and is torn down by the drain
    // finally once its turn drains. Idle sessions tear down immediately below.
    const deferred: LiveSession[] = []
    const immediate: LiveSession[] = []
    for (const live of all) {
      if (live.draining && !live.destroyed) {
        live.pendingTeardown = true
        deferred.push(live)
      } else immediate.push(live)
    }
    liveSessions.clear()
    for (const live of deferred) liveSessions.set(live.keyId, live)
    // Seal only around the flush — unlike stop() the router keeps serving after a
    // roles reload, so re-enable persist() once pending writes have drained.
    closing = true
    const successors = new Map<string, ChannelKey>()
    for (const live of immediate) {
      const retained = await backgroundObligations.withTargetLane(live.key, () => retainLiveWorkInLane(live))
      if (retained) successors.set(live.keyId, live.key)
      await tearDownLive(live)
    }
    // A handoff from an earlier reload whose successor never installed (this
    // reload superseded its creation, or it failed) is recreated now as well.
    for (const [keyId, pending] of pendingReloadHandoffs) {
      if (!liveSessions.has(keyId)) successors.set(keyId, pending.key)
    }
    await persistChain
    closing = false
    await Promise.all(Array.from(successors.values(), handOffToSuccessor))
  }

  // Graceful-restart shutdown: mark every live channel session's todo scope so
  // the turn the restart is about to abort does not arm the durable user-abort
  // block, then abort the in-flight turns. On the next boot each scope's resume
  // continues its incomplete todos instead of waiting for a human. Best-effort
  // and bounded by the caller's shutdown deadline.
  const markRestartAbortForAllLive = async (): Promise<void> => {
    for (const live of Array.from(liveSessions.values())) {
      const origin = buildLiveOrigin(live)
      await markRestartAbortPendingForOrigin(options.agentDir, origin).catch((err) =>
        logger.error(`[channels] graceful-restart mark abort failed: ${describeError(err)}`),
      )
      await live.session
        .abort()
        .then(() => {
          logger.warn(
            `[channels] ${live.keyId} abort site=graceful_restart session=${live.sessionId} reason=graceful_restart`,
          )
        })
        .catch((err) => logger.error(`[channels] graceful-restart abort failed: ${describeError(err)}`))
    }
  }

  // Boot-time resume for a restart that originated from a channel session, in
  // two phases to close the race with adapters that begin receiving inbounds.
  //
  // PHASE 1 — reserveRestartHandoff(handoff): called BEFORE the adapters start.
  // It seeds a per-key entry in `creating` so any inbound that arrives during
  // boot coalesces onto the (not-yet-run) resume instead of stale-rolling the
  // mapping or creating a competing session. It does NOT touch resolvers or
  // outbound callbacks (not registered yet) — it only installs the gate.
  //
  // PHASE 2 — reservation.resume(): called AFTER channelManager.start(), when
  // adapters (and thus resolvers + the outbound callback the wake reply needs)
  // are ready. It removes its own `creating` seed, reopens the exact session
  // via ensureLive(resumeTarget) (bypassing stale-rollover, persisting only on
  // success), and — only if no real inbound coalesced in the meantime — arms
  // the restart-kick suppressor and enqueues the synthetic wake. If an inbound
  // did arrive, that inbound is the wake, so the synthetic one is skipped to
  // avoid a duplicate/spurious "I'm back" turn.
  //
  // The `typeclaw.restart-self` entry is already in the reopened JSONL (the
  // dying container appended it on the restart broadcast), so reopening the
  // file is what produces the greeting; adapter readiness only matters for
  // delivering the eventual reply.
  const reserveRestartHandoff = (handoff: RestartHandoff): RestartReservation | null => {
    if (handoff.origin.kind !== 'channel') return null
    const key: ChannelKey = {
      adapter: handoff.origin.key.adapter,
      workspace: handoff.origin.key.workspace,
      chat: handoff.origin.key.chat,
      thread: handoff.origin.key.thread,
    }
    const keyId = channelKeyId(key)

    if (options.configForAdapter(key.adapter) === undefined) {
      logger.warn(`[channels] ${keyId}: restart-resume skipped — adapter not configured`)
      return null
    }
    if (restartReservations.has(keyId)) throw new Error(`restart reservation already exists for ${keyId}`)

    let resolveGate!: (live: LiveSession) => void
    let rejectGate!: (err: unknown) => void
    const gate = new Promise<LiveSession>((res, rej) => {
      resolveGate = res
      rejectGate = rej
    })
    // Seed `creating` so a racing inbound's ensureLive awaits this gate rather
    // than starting its own create. Suppress an unhandled-rejection warning on
    // the skip/failure paths that never get an inbound waiter.
    creating.set(keyId, gate)
    gate.catch(() => undefined)

    const reservation: RestartReservation = {
      keyId,
      sawInbound: false,
      release: () => {
        if (creating.get(keyId) === gate) creating.delete(keyId)
        if (restartReservations.get(keyId) === reservation) restartReservations.delete(keyId)
        rejectGate(new StaleLiveSessionError(keyId))
      },
      resume: async () => {
        // Drop our own seed BEFORE calling ensureLive, or ensureLive would
        // await the gate we are about to resolve and deadlock.
        if (creating.get(keyId) === gate) creating.delete(keyId)
        restartReservations.delete(keyId)

        try {
          await ensureLoaded()
        } catch (error) {
          reservation.release()
          throw error
        }
        const record = mappings ? findRecord(mappings, key) : undefined
        if (record?.sessionId !== handoff.originatingSessionId) {
          logger.warn(
            `[channels] ${keyId}: restart-resume skipped — persisted session ` +
              `${record?.sessionId ?? '<none>'} no longer matches handoff ${handoff.originatingSessionId}`,
          )
          rejectGate(new StaleLiveSessionError(keyId))
          return
        }

        let live: LiveSession
        try {
          live = await ensureLive(key, undefined, handoff.triggeringAuthorId, {
            sessionId: handoff.originatingSessionId,
            sessionFile: handoff.originatingSessionFile,
          })
        } catch (err) {
          logger.warn(`[channels] ${keyId}: restart-resume ensureLive failed: ${describeError(err)}`)
          rejectGate(err)
          return
        }
        resolveGate(live)

        if (live.sessionId !== handoff.originatingSessionId) {
          logger.warn(
            `[channels] ${keyId}: restart-resume reopened a different session ` +
              `(${live.sessionId} != ${handoff.originatingSessionId}); skipping wake`,
          )
          return
        }

        // A real inbound coalesced onto the reservation during boot: it is the
        // wake. Adding the synthetic "I'm back" turn on top would duplicate
        // work / stack a spurious turn, so skip it and let the inbound drain.
        if (reservation.sawInbound) {
          logger.info(`[channels] ${keyId}: restart-resume coalesced with a real inbound; skipping synthetic wake`)
          return
        }

        await armRestartKickForOrigin(options.agentDir, buildLiveOrigin(live)).catch((err) =>
          logger.error(`[channels] ${keyId}: restart-resume arm restart-kick failed: ${describeError(err)}`),
        )
        // A restart-aborted turn arms the durable user-abort block; this resume
        // IS the restart, so clear it or the resumed session never auto-resumes
        // its incomplete todos. Gated to this restart-handoff path.
        await clearAbortSuppressionForOrigin(options.agentDir, buildLiveOrigin(live)).catch((err) =>
          logger.error(`[channels] ${keyId}: restart-resume clear abort suppression failed: ${describeError(err)}`),
        )

        live.pendingSystemReminders.push(wakeupReminder(RESTART_RESUME_WAKE_REMINDER))
        logger.info(`[channels] ${keyId}: restart-resume waking session ${live.sessionId}`)
        void drain(live)
      },
    }
    restartReservations.set(keyId, reservation)
    return reservation
  }

  // Reserve + resume in one call, for callers (and tests) that run after the
  // adapters are already started and so don't need the pre-start gate. Still
  // benefits from the reservation's sawInbound suppression for inbounds that
  // race between reserve and resume.
  const resumeRestartHandoff = async (handoff: RestartHandoff): Promise<void> => {
    const reservation = reserveRestartHandoff(handoff)
    if (reservation === null) return
    await reservation.resume()
  }

  const executeCommand = async (
    key: ChannelKey,
    name: string,
    options: ExecuteCommandOptions,
  ): Promise<ExecuteCommandResult> => {
    const lowered = name.toLowerCase()
    const commandInfo = commands.get(lowered)
    if (commandInfo === undefined) {
      return { kind: 'unknown-command', name: lowered }
    }
    // Gates on the command's declared tier (session.control for /stop,
    // session.admin for /reload and /restart) — never channel.respond — so a
    // respond-capable guest cannot abort another speaker's turn or bounce the
    // container. Runs BEFORE the live-session lookup so an unauthorized invoker
    // gets 'permission-denied' regardless of session state, rather than leaking
    // session presence via the 'no-live-session' vs 'permission-denied'
    // distinction. Session-less informational commands (e.g. /help) declare
    // permission:'none' and skip both the gate and the lookup so they work in
    // channels with no live turn.
    const requiredPermission = commandPermissionString(commandInfo.permission)
    if (requiredPermission !== null) {
      const partial: SessionOrigin = {
        kind: 'channel',
        adapter: key.adapter,
        workspace: key.workspace,
        chat: key.chat,
        thread: key.thread,
        ...(options.parentChat !== undefined ? { parentChat: options.parentChat } : {}),
        lastInboundAuthorId: options.invokerId,
      }
      if (!permissions.has(partial, requiredPermission)) {
        return { kind: 'permission-denied' }
      }
    }
    let live: LiveSession | null = null
    if (commandInfo.requiresLiveSession) {
      const resolved = resolveLiveSessionForCommand(liveSessions, key)
      if (resolved.kind === 'none') {
        if (lowered !== 'stop') return { kind: 'no-live-session' }
        // A reload handoff whose successor never installed is this
        // conversation's owed work; /stop withdraws it without a session.
        const pending = resolvePendingReloadHandoffForCommand(key)
        if (pending.kind === 'ambiguous') return { kind: 'ambiguous', matchCount: pending.count }
        if (pending.kind === 'found' && (await stopPendingReloadHandoff(pending.keyId))) {
          return { kind: 'handled', name: commandInfo.name, reply: STOP_COMMAND_REPLY }
        }
        return { kind: 'no-live-session' }
      }
      if (resolved.kind === 'ambiguous') {
        return { kind: 'ambiguous', matchCount: resolved.count }
      }
      // Slack broadcasts slash commands to every installed app, so an idle
      // fallback/observe-only session must stay silent instead of claiming it
      // stopped work. Discord interactions are delivered only to the selected
      // application, and its exact channel key is authoritative even between
      // prompts. In the 2026-08-28 incident, one exact Discord session consumed
      // 14 messages into a no-assistant-output branch; each prompt ended in
      // ~53ms, so /stop landed while `draining`, queues, and reminders were all
      // empty and incorrectly reported no-live-session. Always pass that exact
      // session to stopCurrentChannelTurn so the user's escape hatch remains.
      const exactDiscordSession = key.adapter === 'discord-bot' && resolved.session.keyId === channelKeyId(key)
      if (
        lowered === 'stop' &&
        !exactDiscordSession &&
        !hasStoppableWork(resolved.session) &&
        !isStoppableReloadHandoff(pendingReloadHandoffs.get(resolved.session.keyId))
      ) {
        return { kind: 'no-live-session' }
      }
      live = resolved.session
    } else if (commandInfo.wantsLiveSession) {
      // Best-effort: resolve a session if exactly one matches, but never fail
      // the command when absent or ambiguous — /restart still bounces.
      const resolved = resolveLiveSessionForCommand(liveSessions, key)
      live = resolved.kind === 'found' ? resolved.session : null
    }
    const result = await commands.execute(`/${lowered}`, { live, event: null, invokerId: options.invokerId })
    if (result.kind === 'handled') {
      return result.reply !== undefined
        ? { kind: 'handled', name: result.name, reply: result.reply }
        : { kind: 'handled', name: result.name }
    }
    // commands.execute can only return not-command (impossible — we pass a
    // leading slash), unknown-command (impossible — we just checked get()),
    // or handled. Any other outcome is a bug.
    return { kind: 'unknown-command', name: lowered }
  }

  const acceptBackgroundResponse: ChannelRouter['acceptBackgroundResponse'] = async (args) =>
    backgroundObligations.withTargetLane(args.key, async () => {
      await ready
      inboundJournal.assertAvailable()
      const row = await backgroundObligations.accept(args)
      return { obligationId: row.obligationId, generation: row.generation }
    })

  const suppressUnstartedBackgroundResponse: ChannelRouter['suppressUnstartedBackgroundResponse'] = async (
    ref,
    reason,
  ) => {
    const row = await backgroundObligations.get(ref.obligationId)
    if (!row) throw new Error('Missing background launch obligation')
    await backgroundObligations.withTargetLane(row.target, async () => {
      await ready
      inboundJournal.assertAvailable()
      const current = await backgroundObligations.get(ref.obligationId)
      if (!current || current.phase === 'closed') return
      if (current.phase !== 'accepted') throw new Error('Background launch already progressed')
      await backgroundObligations.settle([{ obligationId: current.obligationId, generation: current.generation }], {
        kind: 'intentionally-suppressed',
        decisionId: randomUUID(),
        reason,
      })
    })
  }

  const attachBackgroundResultCoverage: ChannelRouter['attachBackgroundResultCoverage'] = async (args) => {
    const live = [...liveSessions.values()].find(
      (candidate) => !candidate.destroyed && candidate.sessionId === args.parentSessionId,
    )
    if (!live) return
    await backgroundObligations.withTargetLane(live.key, async () => {
      await ready
      inboundJournal.assertAvailable()
      if (live.destroyed) return
      const source =
        (await backgroundObligations.lookup(args.parentSessionId, args.taskId)) ??
        (await backgroundObligations.list()).find(
          (row) => row.taskId === args.taskId && channelKeyId(row.target) === live.keyId,
        )
      if (!source || channelKeyId(source.target) !== live.keyId) return
      const row = await backgroundObligations.resultReady(source.obligationId)
      if (!row || row.phase === 'closed' || row.transfer) {
        retireBackgroundCache(live, new Set([source.obligationId]))
        return
      }
      const refs = [{ obligationId: row.obligationId, generation: row.generation }]
      const owner = { turnId: live.backgroundTurnId, ownerSessionId: live.sessionId, target: live.key }
      if (
        row.claim &&
        (row.claim.turnId !== live.backgroundTurnId ||
          row.claim.ownerSessionId !== live.sessionId ||
          row.claim.epoch !== backgroundObligations.epoch)
      ) {
        if (live.inboundCoverage.length > 0) {
          await inboundJournal.move([], { ...owner, fromTurnId: row.claim.turnId }, refs)
        } else {
          await backgroundObligations.move(refs, { ...owner, fromTurnId: row.claim.turnId })
        }
      } else if (!row.claim) {
        if (live.inboundCoverage.length > 0) {
          await inboundJournal.claim([], owner, refs)
        } else {
          await backgroundObligations.claim(refs, owner)
        }
      }
      // Fetch consumed this result into the active prompt. Its queued wake must
      // not advertise an old owner or start a second prompt for the same result.
      retireBackgroundCache(live, new Set([row.obligationId]))
      live.backgroundCoverage.push(row.obligationId)
    })
  }

  const captureTurnAccountIdentity: NonNullable<ChannelRouter['captureTurnAccountIdentity']> = async (
    parentSessionId,
  ) => {
    const live = [...liveSessions.values()].find(
      (candidate) => !candidate.destroyed && candidate.sessionId === parentSessionId,
    )
    if (!live) return undefined
    return backgroundObligations.withTargetLane(live.key, async () => {
      await ready
      inboundJournal.assertAvailable()
      return activeTurnAccountIdentity(live) ?? currentAccountIdentityFor(live.key)
    })
  }

  const captureInboundResultCoverage: NonNullable<ChannelRouter['captureInboundResultCoverage']> = async (
    parentSessionId,
  ) => {
    const live = [...liveSessions.values()].find(
      (candidate) => !candidate.destroyed && candidate.sessionId === parentSessionId,
    )
    if (!live) return []
    return backgroundObligations.withTargetLane(live.key, async () => {
      await ready
      if (live.destroyed) return []
      return inboundJournal.resolve(live.inboundCoverage).filter((ref) => {
        const row = inboundJournal.get(ref.inputId)
        return (
          row?.phase === 'turn-owned' &&
          row.claim?.turnId === live.backgroundTurnId &&
          row.claim.ownerSessionId === live.sessionId &&
          row.claim.epoch === inboundJournal.epoch
        )
      })
    })
  }

  const captureBackgroundResultCoverage: NonNullable<ChannelRouter['captureBackgroundResultCoverage']> = async (
    parentSessionId,
  ) => {
    const live = [...liveSessions.values()].find(
      (candidate) => !candidate.destroyed && candidate.sessionId === parentSessionId,
    )
    if (!live) return []
    return backgroundObligations.withTargetLane(live.key, async () => {
      if (live.destroyed) return []
      const refs = await resolveBackgroundCoverage(live, live.backgroundCoverage, true)
      live.backgroundCoverage = refs.map((ref) => ref.obligationId)
      return refs
    })
  }

  const deliverCompletionReminder = (
    live: LiveSession,
    args: {
      parentSessionId: string
      subagent: string
      taskId: string
      ok: boolean
      durationMs: number
      error?: string
      hasRecoverableOutput?: boolean
      backgroundObligationId?: string
    },
  ): { kind: 'delivered'; keyId: string } => {
    const adapter = live.keyId.split(':', 1)[0] ?? ''
    const text = renderSubagentCompletionReminder({
      subagent: args.subagent,
      taskId: args.taskId,
      ok: args.ok,
      durationMs: args.durationMs,
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.hasRecoverableOutput === true ? { hasRecoverableOutput: true } : {}),
      channel: true,
      adapter,
    })
    if (
      args.backgroundObligationId &&
      (live.backgroundCoverage.includes(args.backgroundObligationId) ||
        live.pendingSystemReminders.some((r) => r.backgroundObligationId === args.backgroundObligationId))
    )
      return { kind: 'delivered', keyId: live.keyId }
    live.pendingSystemReminders.push({
      ...wakeupReminder(text),
      ...(args.backgroundObligationId ? { backgroundObligationId: args.backgroundObligationId } : {}),
    })
    // The reminder tells the agent to fetch this result now; clear the
    // subagent_output window so an earlier premature-polling streak can't
    // hard-block that legitimate fetch.
    forgetSharedLoopGuardTool(live.sessionId, SUBAGENT_OUTPUT_TOOL_NAME)
    logger.info(`[channels] ${live.keyId}: subagent-completion reminder queued task=${args.taskId} ok=${args.ok}`)
    // Wake an idle session immediately, but leave an already-scheduled inbound
    // debounce in charge. Starting a fire-and-forget drain here would splice
    // both queues before the debounce owner can await that drain, making the
    // caller observe an in-progress turn and defeating deterministic coalescing.
    // An in-flight drain picks up the reminder on its next iteration.
    if (!live.draining && live.debounceTimer === null) {
      void drain(live)
    }
    return { kind: 'delivered', keyId: live.keyId }
  }

  const injectSubagentCompletionReminder = async (args: {
    parentSessionId: string
    subagent: string
    taskId: string
    ok: boolean
    durationMs: number
    error?: string
    hasRecoverableOutput?: boolean
    channelKey?: { adapter: string; workspace: string; chat: string; thread: string | null }
  }): Promise<{ kind: 'delivered'; keyId: string } | { kind: 'no-live-session' }> => {
    // Completion admission is independent of the presence or health of a parent.
    const existing = await backgroundObligations.lookup(args.parentSessionId, args.taskId)
    const row = existing
      ? await backgroundObligations.withTargetLane(existing.target, async () => {
          await ready
          inboundJournal.assertAvailable()
          return backgroundObligations.resultReady(existing.obligationId)
        })
      : undefined
    if (existing && !row) return { kind: 'no-live-session' }
    const queueCompletion = (
      live: LiveSession,
    ): Promise<{ kind: 'delivered'; keyId: string } | { kind: 'no-live-session' }> =>
      backgroundObligations.withTargetLane(live.key, async () => {
        await ready
        inboundJournal.assertAvailable()
        const current = row ? await backgroundObligations.get(row.obligationId) : undefined
        if (row && (!current || current.phase === 'closed' || current.transfer)) return { kind: 'no-live-session' }
        return deliverCompletionReminder(live, {
          ...args,
          ...(current ? { backgroundObligationId: current.obligationId } : {}),
        })
      })
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.sessionId !== args.parentSessionId) continue
      if (row && channelKeyId(row.target) !== live.keyId) continue
      return queueCompletion(live)
    }
    // The exact parent session is gone. If the subagent was spawned from a
    // channel session, the conversation may have rolled over
    // (SESSION_FRESHNESS_TTL_MS) or been idle-evicted onto a fresh sessionId
    // for the same channel key while the subagent ran. Fall back to the live
    // successor for that key so a finished review/result still surfaces
    // instead of being silently dropped.
    if (args.channelKey !== undefined) {
      const targetKeyId = channelKeyId(args.channelKey)
      const successor = liveSessions.get(targetKeyId)
      if (successor !== undefined && !successor.destroyed) {
        logger.info(
          `[channels] ${targetKeyId}: subagent-completion reminder rerouted to live successor (parent ${args.parentSessionId} gone) task=${args.taskId}`,
        )
        if (row && channelKeyId(row.target) !== successor.keyId) return { kind: 'no-live-session' }
        return queueCompletion(successor)
      }
    }
    // A reload retained this parent's deferred coverage and its successor has not
    // installed yet (or failed to). Queue the wake on that explicit handoff so the
    // successor adopts both together; no session is created here, and a result
    // without such a handoff stays owed for durable recovery as before.
    if (row) {
      const keyId = channelKeyId(row.target)
      const queued = await backgroundObligations.withTargetLane(row.target, async () => {
        await ready
        inboundJournal.assertAvailable()
        const current = await backgroundObligations.get(row.obligationId)
        const pending = pendingReloadHandoffs.get(keyId)
        if (
          !current ||
          current.phase === 'closed' ||
          current.transfer ||
          liveSessions.has(keyId) ||
          !pending ||
          pending.coverage?.ownerSessionId !== args.parentSessionId
        )
          return false
        if (pending.reminders.some((reminder) => reminder.backgroundObligationId === current.obligationId)) return true
        const reminders: PendingSystemReminder[] = [
          ...pending.reminders,
          {
            ...wakeupReminder(
              renderSubagentCompletionReminder({
                subagent: args.subagent,
                taskId: args.taskId,
                ok: args.ok,
                durationMs: args.durationMs,
                ...(args.error !== undefined ? { error: args.error } : {}),
                ...(args.hasRecoverableOutput === true ? { hasRecoverableOutput: true } : {}),
                channel: true,
                adapter: row.target.adapter,
              }),
            ),
            backgroundObligationId: current.obligationId,
          },
        ]
        // The same bounds as retention, checked on the candidate before anything
        // changes: a refused wake leaves the handoff exactly as it was and the
        // result owed for durable recovery.
        const estimatedBytes = estimateReloadHandoffBytes(
          pending.inbounds,
          pending.observed,
          reminders,
          pending.coverage,
        )
        const exceeded =
          pendingReloadHandoffItemCount({ ...pending, reminders }) > handoffRetryItemLimit
            ? `per-key item limit ${handoffRetryItemLimit}`
            : estimatedBytes > handoffRetryByteLimit
              ? `per-key byte limit ${handoffRetryByteLimit}`
              : pendingReloadHandoffTotalBytes() - pending.estimatedBytes + estimatedBytes >
                  MAX_PENDING_RELOAD_HANDOFF_BYTES_TOTAL
                ? `global byte limit ${MAX_PENDING_RELOAD_HANDOFF_BYTES_TOTAL}`
                : undefined
        if (exceeded !== undefined) {
          logger.error(
            `[channels] ${keyId}: subagent-completion reminder not held for reload successor (${exceeded} would be exceeded); result stays owed task=${args.taskId}`,
          )
          return false
        }
        pending.reminders = reminders
        pending.estimatedBytes = estimatedBytes
        forgetSharedLoopGuardTool(args.parentSessionId, SUBAGENT_OUTPUT_TOOL_NAME)
        logger.info(`[channels] ${keyId}: subagent-completion reminder held for reload successor task=${args.taskId}`)
        return true
      })
      if (queued) return { kind: 'delivered', keyId }
    }
    return { kind: 'no-live-session' }
  }

  const injectPrVerdictActivity = (args: {
    workspace: string
    prNumber: number
    verdict: ReviewRoundOutcome
    sessionId: string
  }): { kind: 'delivered'; count: number } => {
    const chat = `pr:${args.prNumber}`
    let count = 0
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.key.adapter !== 'github') continue
      if (live.key.workspace !== args.workspace || live.key.chat !== chat) continue
      // Self-exclude: the session that just landed the verdict must not be told to
      // stand down from its own legitimate review.
      if (live.sessionId === args.sessionId) continue
      const text = renderPrVerdictStandDownReminder({ prNumber: args.prNumber, verdict: args.verdict })
      live.pendingSystemReminders.push(wakeupReminder(text))
      logger.info(`[channels] ${live.keyId}: pr-verdict stand-down queued pr=${chat} verdict=${args.verdict}`)
      if (!live.draining) void drain(live)
      count++
    }
    return { kind: 'delivered', count }
  }

  const completeRoundForVerifiedVerdict = async (args: {
    workspace: string
    prNumber: number
    verdict: ReviewRoundOutcome
    sessionId: string
    commitSha?: string
  }): Promise<{ kind: 'completed' | 'no-round' }> => {
    const chat = `pr:${args.prNumber}`
    const publisher = Array.from(liveSessions.values()).find(
      (live) =>
        !live.destroyed &&
        live.sessionId === args.sessionId &&
        live.key.adapter === 'github' &&
        live.key.workspace === args.workspace &&
        live.key.chat === chat &&
        live.githubReviewRound !== null,
    )
    const persistedPublisher = mappings?.find(
      (record) =>
        record.sessionId === args.sessionId &&
        record.adapter === 'github' &&
        record.workspace === args.workspace &&
        record.chat === chat &&
        record.githubReviewRound !== undefined,
    )
    const round = publisher?.githubReviewRound ?? persistedPublisher?.githubReviewRound
    if (round === null || round === undefined) {
      const resetRound = resetGithubReviewRoundCompletionForPr(args.workspace, args.prNumber, now)
      if (resetRound !== null) persistMatchingGithubReviewRound(resetRound)
      logger.warn(
        `[channels] github review round completion rejected pr=${args.workspace}#${args.prNumber} verdict=${args.verdict}: no publisher session with round state session=${args.sessionId}`,
      )
      return { kind: 'no-round' }
    }

    // Checked before re-registration, which would evict the newer round that
    // replaced this one between the verdict landing and this observation.
    if (isGithubReviewRoundSuperseded(round, now)) {
      logger.warn(
        `[channels] github review round completion rejected pr=${args.workspace}#${args.prNumber} verdict=${args.verdict}: round superseded`,
      )
      return { kind: 'no-round' }
    }
    const activeRound = registerGithubReviewRound(round, now(), now)
    if (activeRound === null) {
      logger.warn(
        `[channels] github review round completion rejected pr=${args.workspace}#${args.prNumber} verdict=${args.verdict}: round expired`,
      )
      return { kind: 'no-round' }
    }
    const publisherThread = publisher?.key.thread ?? persistedPublisher?.thread ?? null
    if (activeRound.carrierThread !== publisherThread) {
      resetGithubReviewRoundCompletion(activeRound, now)
      persistMatchingGithubReviewRound(activeRound)
      logger.warn(
        `[channels] github review round completion rejected pr=${args.workspace}#${args.prNumber} verdict=${args.verdict}: publisher thread=${publisherThread ?? 'root'} is not carrier=${activeRound.carrierThread ?? 'root'}`,
      )
      return { kind: 'no-round' }
    }
    if (!(await validateGithubReviewRound(activeRound, undefined, now, args.commitSha ?? null))) {
      resetGithubReviewRoundCompletion(activeRound, now)
      persistMatchingGithubReviewRound(activeRound)
      logger.warn(
        `[channels] github review round completion rejected pr=${args.workspace}#${args.prNumber} verdict=${args.verdict}: head mismatch or unavailable expected=${activeRound.headSha}`,
      )
      return { kind: 'no-round' }
    }
    completeGithubReviewRound(activeRound, now)
    const key = githubReviewRoundKey(round)
    for (const live of liveSessions.values()) {
      if (live.githubReviewRound === null || githubReviewRoundKey(live.githubReviewRound) !== key) continue
      live.pendingSystemReminders = live.pendingSystemReminders.filter(
        (reminder) => reminder.githubReviewRoundKey !== key,
      )
      live.githubReviewRound = activeRound
    }
    persistMatchingGithubReviewRound(activeRound)
    replayPendingRoundCloseouts(activeRound)
    logger.info(`[channels] github review round completed pr=${chat} verdict=${args.verdict}`)
    return { kind: 'completed' }
  }

  // Round state must reach every session carrying the round, not only the ones
  // currently live. An idle-GC'd or not-yet-reopened sibling keeps its persisted
  // `pending` record, and reopening it restores that stale status over the
  // completed one, re-arming failover and permitting a second blocking review.
  const persistMatchingGithubReviewRound = (round: GithubReviewFollowupRound): void => {
    if (mappings === null) return
    const key = githubReviewRoundKey(round)
    const state = githubReviewRoundPersistence(round, now)
    let changed = false
    for (const [idx, record] of mappings.entries()) {
      if (record.githubReviewRound === undefined) continue
      if (githubReviewRoundKey(record.githubReviewRound) !== key) continue
      if (state === null) {
        const { githubReviewRound: _expired, ...rest } = record
        void _expired
        mappings[idx] = rest
      } else {
        mappings[idx] = { ...record, githubReviewRound: { ...round, ...state } }
      }
      changed = true
    }
    if (changed) void persist()
  }

  // A close-out can land while completion is still awaiting head validation, so
  // `finishGithubReviewThreadCloseout` sees a pending round and returns without
  // clearing. Nothing else retries it, which would strand round metadata on the
  // session and reject its later verdicts — so the close-out is recorded and
  // replayed here once the round actually completes.
  const replayPendingRoundCloseouts = (round: GithubReviewFollowupRound): void => {
    const key = githubReviewRoundKey(round)
    for (const live of liveSessions.values()) {
      if (live.pendingGithubReviewRoundCloseout !== key) continue
      live.pendingGithubReviewRoundCloseout = null
      finishGithubReviewThreadCloseout({
        sessionId: live.sessionId,
        workspace: live.key.workspace,
        prNumber: Number(live.key.chat.slice('pr:'.length)),
        thread: live.key.thread ?? null,
        decision: 'resolved',
      })
    }
  }

  const finishGithubReviewThreadCloseout = (args: {
    sessionId: string
    workspace: string
    prNumber: number
    thread: string | null
    decision: 'resolved' | 'left-open'
  }): void => {
    const chat = `pr:${args.prNumber}`
    const live = Array.from(liveSessions.values()).find(
      (candidate) =>
        !candidate.destroyed &&
        candidate.sessionId === args.sessionId &&
        candidate.key.adapter === 'github' &&
        candidate.key.workspace === args.workspace &&
        candidate.key.chat === chat &&
        candidate.key.thread === args.thread,
    )
    if (live !== undefined) {
      live.githubReviewThreadCloseoutDecisionTurn = live.turnSeq
      clearGithubReviewThreadCloseout(live)
      logger.info(
        `[channels] ${live.keyId} github_thread_closeout_decided decision=${args.decision} turn=${live.turnSeq}`,
      )
    }
    if (live?.githubReviewRound === null || live?.githubReviewRound === undefined) return
    const round = live.githubReviewRound
    if (!isGithubReviewRoundComplete(round, now)) {
      live.pendingGithubReviewRoundCloseout = githubReviewRoundKey(round)
      return
    }
    live.pendingGithubReviewRoundCloseout = null
    live.githubReviewRound = null
    persistGithubReviewRound(live, null)
    const stillReferenced =
      Array.from(liveSessions.values()).some(
        (candidate) =>
          candidate.githubReviewRound !== null &&
          githubReviewRoundKey(candidate.githubReviewRound) === githubReviewRoundKey(round),
      ) ||
      (mappings?.some(
        (record) =>
          record.githubReviewRound !== undefined &&
          githubReviewRoundKey(record.githubReviewRound) === githubReviewRoundKey(round),
      ) ??
        false)
    if (!stillReferenced) forgetGithubReviewRound(round)
  }

  // Stamp the review-output flag on the session that just landed a formal GitHub
  // review this turn. Matched by sessionId (the recorder records the exact
  // event.sessionId), and confirmed to be the right github PR live session so a
  // stray/mismatched signal can't suppress an unrelated turn's fallback. See
  // `githubReviewOutputTurn`.
  const noteGithubReviewOutput = async (args: {
    sessionId: string
    workspace: string
    prNumber: number
    state: ReviewOutputState
    inboundCoverage?: InboundRef[]
    backgroundCoverage?: BackgroundObligationRef[]
  }): Promise<{ kind: 'stamped' | 'no-live-session' }> => {
    const chat = `pr:${args.prNumber}`
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.sessionId !== args.sessionId) continue
      if (live.key.adapter !== 'github') continue
      if (live.key.workspace !== args.workspace || live.key.chat !== chat) continue
      // Only pre-publication coverage can be credited. An output-only recognizer
      // still stamps ordinary review accounting, but cannot borrow current debt.
      await recordLandedBackgroundResponse(
        live,
        'formal-review',
        args.backgroundCoverage ?? [],
        args.inboundCoverage ?? [],
      )
      live.githubReviewOutputTurn = live.turnSeq
      logger.info(`[channels] ${live.keyId}: github_review_output state=${args.state} turn=${live.turnSeq}`)
      return { kind: 'stamped' }
    }
    return { kind: 'no-live-session' }
  }

  const markTurnSkipped = async (args: {
    parentSessionId: string
    reason: string
  }): Promise<
    { kind: 'recorded'; keyId: string } | { kind: 'recorded-after-send'; keyId: string } | { kind: 'no-live-session' }
  > => {
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.sessionId !== args.parentSessionId) continue
      await settleBackgroundCoverage(live, 'intentionally-suppressed', 'explicit-skip')
      if (live.successfulChannelSends > live.successfulSendsAtTurnStart) {
        // Reply-first skip ("acked, now going quiet"): accept as a terminal
        // no-op, never stamp `skippedTurn`. The delivered reply stands and must
        // not be suppressed, so stamping (which `validateChannelTurn` reads to
        // drop the turn) would be wrong; the send-after-skip lock only needs to
        // arm on the silence-first path. Rejecting this instead deadlocks the
        // agentic loop: denied a clean silent exit the model re-sends, gets
        // re-denied, and repeats until the per-turn send cap trips. Logged here
        // since `validateChannelTurn` won't see a `skippedTurn` for it.
        logger.info(`[channels] ${live.keyId} skip_after_send reason=${JSON.stringify(args.reason)}`)
        return { kind: 'recorded-after-send', keyId: live.keyId }
      }
      live.skippedTurn = { turnSeq: live.turnSeq, reason: args.reason }
      return { kind: 'recorded', keyId: live.keyId }
    }
    return { kind: 'no-live-session' }
  }

  const hasOutstandingGithubReviewThreadCloseout = (sessionId: string): boolean => {
    for (const live of liveSessions.values()) {
      if (live.destroyed || live.sessionId !== sessionId) continue
      return live.githubReviewThreadCloseout !== null
    }
    return false
  }

  const clearSticky = (key: ChannelKey): { keyId: string; cleared: number } => {
    const keyId = channelKeyId(key)
    const cleared = stickyLedger.clear(keyId)
    // Arm the same-turn re-grant guard so a subsequent ack reply this turn does
    // not re-grant the credit just cleared (see `disengagedTurn`). No-op when
    // the key has no live session — the ledger clear above still stands.
    const live = liveSessions.get(keyId)
    if (live && !live.destroyed) {
      live.disengagedTurn = live.turnSeq
      reactOnDisengage(live)
    }
    logger.info(`[channels] ${keyId} sticky cleared count=${cleared}`)
    return { keyId, cleared }
  }

  const reactOnDisengage = (live: LiveSession): void => {
    if (live.currentTurnReactionRef === null) return
    void react({
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      reactionRef: live.currentTurnReactionRef,
      emoji: disengageReactionEmojiFor(live.key.adapter),
    })
      .then((result) => {
        if (!result.ok && result.code !== 'unsupported') {
          logger.info(
            `[channels] disengage-react failed adapter=${live.key.adapter} chat=${live.key.chat}: ${result.error}`,
          )
        }
      })
      .catch((err) => {
        logger.info(
          `[channels] disengage-react threw adapter=${live.key.adapter} chat=${live.key.chat}: ${describeError(err)}`,
        )
      })
  }

  const armSilentTurnAck = (live: LiveSession, reason: SilentAckReason): void => {
    // A GitHub review is user-facing output, so it always earns the 👀; deferred
    // background work earns one only when the triggering message addressed the
    // bot. Ambient chatter stays unmarked.
    const eligible =
      reason === 'github_review_output' ? live.key.adapter === 'github' : live.currentTurnExplicitlyAddressed
    if (!eligible) return
    live.silentAckTurn = { turnSeq: live.turnSeq, reason }
  }

  const reactOnSilentAck = (live: LiveSession): void => {
    if (live.silentAckTurn?.turnSeq !== live.turnSeq) return
    const { reason } = live.silentAckTurn
    live.silentAckTurn = null
    const reactionRef = live.currentTurnReactionRef
    if (reactionRef === null) return
    waitingReactions.acquire(
      {
        adapter: live.key.adapter,
        workspace: live.key.workspace,
        chat: live.key.chat,
        thread: live.key.thread,
        reactionRef,
        emoji: ENGAGE_REACTION_EMOJI,
      },
      true,
      { conversation: live.key, kind: reason },
    )
  }

  // The genuine-reply decision retires conversation-scoped acknowledgments,
  // including owners persisted by an earlier runtime. Cleanup cannot use this.
  const dropSilentAckReactions = (live: LiveSession): Promise<void> => waitingReactions.retireAcknowledgments(live.key)

  const reactOnContinuationWillingness = (live: LiveSession, reactionRef: ReactionRef): void => {
    live.activeContinuationReactions.push(
      waitingReactions.acquire({
        adapter: live.key.adapter,
        workspace: live.key.workspace,
        chat: live.key.chat,
        thread: live.key.thread,
        reactionRef,
        emoji: CONTINUATION_REACTION_EMOJI,
      }),
    )
  }

  const dropContinuationReactions = (live: LiveSession): Promise<void> => {
    const owners = live.activeContinuationReactions
    live.activeContinuationReactions = []
    return Promise.all(owners.map((owner) => waitingReactions.release(owner))).then(() => undefined)
  }
  const registerRecoveryAdapter = (adapter: ChannelKey['adapter'], callbacks: RecoveryAdapterCallbacks): void => {
    recoveryAdapters.set(adapter, callbacks)
  }
  const unregisterRecoveryAdapter = (adapter: ChannelKey['adapter'], callbacks: RecoveryAdapterCallbacks): void => {
    if (recoveryAdapters.get(adapter) === callbacks) recoveryAdapters.delete(adapter)
  }
  const activeTurnAccountIdentity = (live: LiveSession | undefined): string | undefined =>
    live && (live.promptInFlight || live.inboundCoverage.length > 0 || live.backgroundCoverage.length > 0)
      ? live.turnAccountIdentity
      : undefined

  const currentAccountIdentityFor = (key: Pick<ChannelKey, 'adapter' | 'workspace'>): string | undefined => {
    const callbacks = recoveryAdapters.get(key.adapter)
    if (callbacks) return callbacks.cachedAccountIdentity?.(key.workspace)
    return fallbackChannelAccountIdentity(
      key.adapter,
      key.workspace,
      selfIdentityResolvers.get(key.adapter)?.(key.workspace)?.id,
    )
  }

  const getRecoveryAccountIdentity = async (
    adapter: ChannelKey['adapter'],
    workspace = '',
  ): Promise<string | undefined> => {
    return currentAccountIdentityFor({ adapter, workspace })
  }
  const validateRecovery = async (record: RecoveryRecord): Promise<RecoveryFailure | undefined> => {
    const config = options.configForAdapter(record.target.adapter)
    if (!config || !config.enabled) {
      return { kind: 'configuration', safeReason: 'original adapter is not configured' }
    }
    if (
      record.principal.kind !== 'channel' ||
      !permissions.has({ ...record.principal, thread: record.target.thread }, CORE_PERMISSIONS.channelRespond)
    ) {
      return { kind: 'permission', safeReason: 'original principal cannot respond or send' }
    }
    const callbacks = recoveryAdapters.get(record.target.adapter)
    const identity = await (callbacks
      ? callbacks.accountIdentity(record.target.workspace)
      : getRecoveryAccountIdentity(record.target.adapter, record.target.workspace))
    if (identity === undefined) return { kind: 'unavailable', safeReason: 'adapter account is not ready' }
    if (record.accountIdentity === 'unbound-legacy' && record.boundAccountIdentity === undefined) return undefined
    if (identity !== (record.boundAccountIdentity ?? record.accountIdentity))
      return { kind: 'identity', safeReason: 'original account identity changed' }
    return undefined
  }
  const reconcileRecovery = async (record: RecoveryRecord): Promise<RecoveryReconcileResult> =>
    recoveryAdapters.get(record.target.adapter)?.reconcile(record) ?? { status: 'unreconcilable' }
  const setRecoveryStopHandler = (handler: (target: ChannelKey, parentSessionId: string) => Promise<void>): void => {
    recoveryStopHandler = handler
  }

  return {
    route,
    send,
    acceptBackgroundResponse,
    suppressUnstartedBackgroundResponse,
    attachBackgroundResultCoverage,
    captureBackgroundResultCoverage,
    captureInboundResultCoverage,
    captureTurnAccountIdentity,
    registerRecoveryAdapter,
    unregisterRecoveryAdapter,
    getRecoveryAccountIdentity,
    validateRecovery,
    reconcileRecovery,
    setRecoveryStopHandler,
    getConsecutiveSendCount,
    hasQualifyingWorkThisLogicalTurn,
    getSendRate,
    registerOutbound,
    unregisterOutbound,
    registerReaction,
    unregisterReaction,
    react,
    queueReactionAfterReply,
    registerRemoveReaction,
    unregisterRemoveReaction,
    removeReaction,
    registerPrepareOwnReaction,
    unregisterPrepareOwnReaction,
    registerRemoveOwnReaction,
    unregisterRemoveOwnReaction,
    removeOwnReaction,
    recoverWaitingReactions,
    registerTyping,
    unregisterTyping,
    setTypingCapability,
    setTypingHeartbeatInterval,
    setAdapterConfigured,
    registerChannelNameResolver,
    unregisterChannelNameResolver,
    registerSelfIdentity,
    unregisterSelfIdentity,
    registerMembership,
    unregisterMembership,
    registerHistory,
    unregisterHistory,
    fetchHistory,
    registerMessageGet,
    unregisterMessageGet,
    getMessage,
    registerList,
    unregisterList,
    listChannels,
    registerEditMessage,
    unregisterEditMessage,
    editMessage,
    registerFetchAttachment,
    unregisterFetchAttachment,
    fetchAttachment,
    registerReviewThreadResolver,
    unregisterReviewThreadResolver,
    resolveReviewThread,
    registerReviewStateResolver,
    unregisterReviewStateResolver,
    getReviewState,
    registerReviewSubmitter,
    unregisterReviewSubmitter,
    submitReview,
    lookupInboundAttachment,
    listInboundAttachmentIds,
    registerHistoryAttachments,
    executeCommand,
    getSelfAliases: computeSelfAliases,
    injectSubagentCompletionReminder,
    injectPrVerdictActivity,
    abortGithubPrTurn,
    completeGithubReviewRound: completeRoundForVerifiedVerdict,
    finishGithubReviewThreadCloseout,
    noteGithubReviewOutput,
    hasOutstandingGithubReviewThreadCloseout,
    markTurnSkipped,
    clearSticky,
    reserveRestartHandoff,
    resumeRestartHandoff,
    stop,
    tearDownAllLive,
    markRestartAbortForAllLive,
    liveCount: () => liveSessions.size,
    __testing: {
      githubReviewRoundFor: (key: ChannelKey) => liveSessions.get(channelKeyId(key))?.githubReviewRound,
      pendingReminderCount: (key: ChannelKey) => liveSessions.get(channelKeyId(key))?.pendingSystemReminders.length,
      creationTokenCount: () => latestCreationTokens.size,
      flushDebounce: async (key: ChannelKey) => {
        const keyId = channelKeyId(key)
        let live = liveSessions.get(keyId)
        if (!live) return
        if (live.debounceTimer) {
          clearTimeout(live.debounceTimer)
          live.debounceTimer = null
        }
        live.firstUnprocessedAt = 0
        // Settle a drain that is ALREADY in flight before starting our own, then
        // again after. `drain()` no-ops while one owns the session, so a
        // fire-and-forget `void drain(live)` raised elsewhere — the restart-resume
        // lost-work notice, a promoted review carrier, a subagent-completion wake —
        // would still be mid-turn when this returned, and the caller would assert
        // on a prompt that has not landed. Same defect shape as the `persist()`
        // race below: this seam has to mean "settled", not "started".
        //
        // Re-resolved by key each round because settling is not a property of one
        // object: a deferred reload teardown drops this session mid-drain and
        // `handOffToSuccessor` replays the carried work onto a REPLACEMENT live
        // session with its own `activeDrains`. Watching only the session captured
        // at entry would return with the successor's prompt still in flight.
        for (;;) {
          await settleDrains(live)
          await drain(live)
          await settleDrains(live)
          const current = liveSessions.get(keyId)
          if (current === undefined || current === live) break
          live = current
        }
        // Settle the fire-and-forget `void persist()` from scheduleDebouncedDrain
        // (the lastInboundAt write). Draining alone doesn't await that promise, so
        // a test reading sessions.json right after would race the disk write — the
        // flake that forced wall-clock polling on slow (Windows CI) filesystems.
        await persistChain
      },
      fireTypingHeartbeat: async (key: ChannelKey, phase: 'tick' | 'stop' = 'tick') => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        await fireTyping(live, phase)
      },
      fireTypingInterval: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live || !live.typingTimer) return
        if (live.destroyed) {
          await stopTypingHeartbeat(live)
          return
        }
        if (now() - live.typingStartedAt >= MAX_TYPING_HEARTBEAT_MS) {
          logger.warn(
            `[channels] ${live.keyId}: typing indicator paused after ${MAX_TYPING_HEARTBEAT_MS}ms with no activity; prompt still in flight`,
          )
          live.typingTimedOut = true
          await stopTypingHeartbeat(live)
          return
        }
        await fireTyping(live, 'tick')
      },
      fireTypingTick: async (key: ChannelKey, epoch: number) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        await fireTyping(live, 'tick', epoch)
      },
      typingEpoch: (key: ChannelKey) => liveSessions.get(channelKeyId(key))?.typingEpoch,
      isTypingActive: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        return live?.typingTimer !== null && live?.typingTimer !== undefined
      },
      stopTyping: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        await stopTypingHeartbeat(live)
      },
      typingHeartbeatIntervalFor,
      runIdleGc,
      getRecoveryAccountingSnapshot: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return undefined
        return {
          successfulChannelSends: live.successfulChannelSends,
          promisedWorkOutstandingThisLogicalTurn: live.promisedWorkOutstandingThisLogicalTurn,
          lastSendLeafId: live.lastSendLeafId,
          skippedTurn: live.skippedTurn,
          consecutiveSends: [...live.consecutiveSends],
          lastSentText: [...live.lastSentText],
          policyDeniedToolSendsThisTurn: [...live.policyDeniedToolSendsThisTurn],
          continuationReactions: [...live.activeContinuationReactions],
          typingEpoch: live.typingEpoch,
          continueReplyTurn: live.continueReplyTurn,
        }
      },
      getLiveOriginSnapshot: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        const origin = live?.originRef.current
        if (origin === undefined) return undefined
        return { ...origin }
      },
      getLiveAuthorState: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (live === undefined) return undefined
        return {
          currentTurnAuthorId: live.currentTurnAuthorId,
          currentTurnAuthorIds: Array.from(live.currentTurnAuthorIds),
          lastTurnAuthorId: live.lastTurnAuthorId,
          lastTurnAuthorIds: Array.from(live.lastTurnAuthorIds),
        }
      },
      injectContinuationReminder: (key: ChannelKey, text: string): void => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        live.pendingSystemReminders.push(retryReminder(text))
      },
    },
  }
}

function collectTurnAttachments(
  observed: readonly ObservedInbound[],
  batch: readonly QueuedInbound[],
): readonly InboundAttachment[] {
  const out: InboundAttachment[] = []
  for (const item of observed) out.push(...(item.attachments ?? []))
  for (const item of batch) out.push(...(item.attachments ?? []))
  return out
}

function findAttachmentById(attachments: readonly InboundAttachment[], id: number): InboundAttachment | null {
  for (let i = attachments.length - 1; i >= 0; i--) {
    const attachment = attachments[i]
    if (attachment?.id === id) return attachment
  }
  return null
}

// Strips the platform's user/group-mention markup so a bare ping can be told
// from a mention that also carries real text. Slack and Discord both encode
// mentions as `<@id>` / `<@id|name>` (users) and `<!subteam^ID>` / `<!channel>`
// (groups); GitHub and the plain-name adapters have no wrapping syntax to strip,
// so their text is returned as-is and a mention there is never classified thin.
// Content-blind and script-agnostic: it removes only fixed markup, never words,
// so it works identically for Korean, CJK, Arabic, or any other input.
function stripMentionMarkup(text: string, adapter: AdapterId): string {
  switch (adapter) {
    case 'slack':
    case 'slack-bot':
    case 'discord':
    case 'discord-bot':
      return text.replace(/<[@!][^>]*>/g, ' ')
    default:
      return text
  }
}

// A "wake request" is a mention whose only payload IS the mention: once the
// markup is stripped the remainder is empty. That shape means "wake up and look
// at what was just said", not a self-contained question, so the caller nudges
// the model toward the recent conversation instead of asking "what do you need?".
function isThinMention(trigger: QueuedInbound, adapter: AdapterId): boolean {
  if (!trigger.isBotMention) return false
  if (trigger.attachments !== undefined && trigger.attachments.length > 0) return false
  // Adapters whose visible text cannot reveal a bare ping (Telegram text_mention
  // renders as a display name) carry the authoritative signal; trust it. Others
  // fall back to stripping the platform's mention markup from the text.
  if (trigger.isBotMentionOnly !== undefined) return trigger.isBotMentionOnly
  return stripMentionMarkup(trigger.text, adapter).trim() === ''
}

// True when the engaged trigger is a bare ping AND a real (non-prefetch) message
// was observed within the lookback window. Author-agnostic on purpose: in a group
// one person can drop a message and a DIFFERENT teammate can ping the bot to loop
// it in, so the recent message need not come from the pinger. The age must be
// non-negative: a message that arrives DURING the mention's debounce window is
// appended to contextBuffer after the ping, so `receivedAt - o.receivedAt` goes
// negative — that message came AFTER the ping and is not what the user was
// pointing back at, so it must not satisfy the "recent PRECEDING message" test.
function isWakeRequest(observed: readonly ObservedInbound[], trigger: QueuedInbound, adapter: AdapterId): boolean {
  if (!isThinMention(trigger, adapter)) return false
  return observed.some((o) => {
    if (o.source !== 'observed') return false
    const age = trigger.receivedAt - o.receivedAt
    return age >= 0 && age <= WAKE_REQUEST_LOOKBACK_MS
  })
}

export function composeTurnPrompt(
  observed: readonly ObservedInbound[],
  batch: readonly QueuedInbound[],
  state: {
    adapter?: AdapterId
    loopGuardActive: boolean
    groupChatNudge?: boolean
    systemReminders?: readonly string[]
    now?: Date
    role?: string
  } = {
    loopGuardActive: false,
  },
): string {
  const adapter = state.adapter ?? 'discord-bot'
  const parts: string[] = []
  parts.push(renderTurnTimeAnchor(state.now), '')
  const roleAnchor = state.role !== undefined ? renderTurnRoleAnchor(state.role) : undefined
  if (roleAnchor !== undefined) parts.push(roleAnchor, '')
  // System reminders (subagent-completion wakeups today) lead the turn body
  // because they are typically what triggered the drain — when the prompt
  // queue is empty and the only thing in this iteration is a reminder, the
  // model needs to see the reminder before any optional context. The
  // reminder block is self-fenced by its <system-reminder> tags, so no
  // extra framing is needed and the model already learns this shape from
  // the TUI path; channel sessions see the same tags.
  if (state.systemReminders && state.systemReminders.length > 0) {
    for (const reminder of state.systemReminders) {
      parts.push(reminder)
    }
    parts.push('')
  }
  // Loop-guard notice lives in the user-turn text (recomposed every drain)
  // rather than in the system prompt so it does not invalidate the
  // prompt-prefix cache. The cached prefix covers system + tools + earlier
  // turns; the current user-turn suffix is non-cacheable by design, so
  // adding a section here is cache-neutral.
  //
  // SYSTEM MESSAGE convention: any runtime-injected block in the user
  // turn that is NOT from a chat participant MUST use the
  // `**[SYSTEM MESSAGE — not from a human]**` framing fenced by
  // horizontal rules (`---`) — the loop-guard block below is the
  // canonical example. This is structurally distinct from the H2
  // sections used for actual conversation content (`## Recent context`,
  // `## Current message`). Without the fencing, models — especially
  // persona-rich ones like Kimi — read the heading as a human-authored
  // instruction and reply to it (e.g. "Understood, I'll stop here"). The
  // bracketed marker plus the explicit "Do not acknowledge or reply to
  // this notice" line is the trust boundary that prevents this. New
  // runtime notices (rate-limit, schema-mismatch, abort signals, etc.)
  // MUST follow this convention.
  //
  // ONE narrow exception exists: subagent-completion reminders use
  // `<system-reminder>...</system-reminder>` tags (prepended above) for
  // parity with the TUI path's identical tagging (see
  // `renderSubagentCompletionReminder` in
  // `src/agent/subagent-completion-reminder.ts`) so the model sees the
  // same shape across origins. The exception is scoped to that single
  // case: do NOT extend it to new notice types. Anything that is not
  // a true subagent-style completion ping uses framing 1.
  if (state.loopGuardActive) {
    parts.push(
      '---',
      '**[SYSTEM MESSAGE — not from a human]**',
      '',
      'Automated signal from the channel router, not a message from anyone in the chat.',
      '**Do not acknowledge or reply to this notice.**',
      '',
      `Peer bots have engaged you ${MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN}+ times in a row with no human input (or ${MAX_PEER_BOT_TURNS_IN_WINDOW}+ times in`,
      `the last ${PEER_BOT_TURNS_WINDOW_MS / 1000}s). If the current message clearly needs a reply, send one and ignore`,
      'this notice; if continuing would add noise, reply `NO_REPLY` to stay silent this',
      'turn. Clears automatically once a human posts again.',
      '',
      '---',
      '',
    )
  }
  // Group-chat nudge: same SYSTEM MESSAGE convention as the loop guard. We
  // engaged this turn — possibly via sticky credit, which now wakes us on
  // every follow-up in a group too (the engagement gate is content-blind by
  // design). In a multi-human room the default "answer everything" posture is
  // wrong, so this nudge is the ONLY thing that makes the bot selective: it
  // tells the model to answer genuine follow-ups and stay silent on chatter.
  // The gate gets us into the turn; the model decides whether to speak.
  // Cache-neutral (user-turn suffix), and skipped when the loop guard already
  // fired to avoid stacking two silence notices in one turn.
  if (state.groupChatNudge === true && !state.loopGuardActive) {
    parts.push(
      '---',
      '**[SYSTEM MESSAGE — not from a human]**',
      '',
      'Automated signal from the channel router, not a message from anyone in the chat.',
      '**Do not acknowledge or reply to this notice.**',
      '',
      'You are in a group chat and are woken on every message from anyone you recently',
      'talked with, so most turns you should stay quiet. The target shifts every message:',
      'before replying, identify who THIS latest message is aimed at. Reply ONLY if it is',
      'addressed to you (by name, @-mention, or reply), or clearly continues your own last',
      'exchange and wants an answer. If it is aimed at someone else — another person or',
      'another bot — or is chatter not actually waiting on you, reply `NO_REPLY` (or call',
      '`skip_response`) to stay silent and keep watching. When unsure, prefer silence.',
      '',
      '---',
      '',
    )
  }
  // Wake-request nudge: same SYSTEM MESSAGE convention as the loop guard and
  // group nudge. The trigger is a bare ping (mention with no text of its own),
  // which the model would otherwise answer with "what do you need?" while the
  // real request sits under "Recent context (not addressed to you)". This
  // re-licenses the model to act on that recent conversation. Placed
  // immediately BEFORE the Recent context block, and the nudge text points at
  // that section BY NAME (the "Recent context" section below) rather than by
  // position, so the reference is unambiguous regardless of render order.
  // Cache-neutral (user-turn suffix), and skipped when the loop guard already
  // fired to avoid stacking two notices in one turn.
  if (batch.length === 1 && !state.loopGuardActive && isWakeRequest(observed, batch[0]!, adapter)) {
    parts.push(
      '---',
      '**[SYSTEM MESSAGE — not from a human]**',
      '',
      'Automated signal from the channel router, not a message from anyone in the chat.',
      '**Do not acknowledge or reply to this notice.**',
      '',
      'You were @-mentioned with little or no text — a "wake up and look" ping, not a',
      'question in itself. It almost always means "respond to what was just said". Look',
      'at the "Recent context" section below (it shows who sent each message): if a recent',
      'message wants a response and is relevant to you — whether the pinger sent it or is',
      'looping you in — treat THAT as the real request and answer it directly rather than',
      'asking "what do you need?". If several are relevant, address the substantive one(s).',
      'If nothing there actually needs you, a brief "what\'s up?" is fine.',
      '',
      '---',
      '',
    )
  }
  if (observed.length > 0) {
    parts.push('## Recent context (not addressed to you, for awareness only)')
    for (const o of observed) {
      parts.push(formatInboundPromptLines(o, adapter, OBSERVED_MESSAGE_MAX_CHARS))
    }
    parts.push('')
  }
  // Emit the `## Current message(s)` header whenever the batch is non-empty.
  // It is batch-gated (a reminder-only wakeup with an empty promptQueue must
  // not print a header with zero lines under it — persona-rich models read
  // the dangling header as a message they're failing to see and hallucinate a
  // reply). It must NOT also be gated on observed context: a turn carrying
  // only the current message then rendered the batch line bare, or flush under
  // the `## Recent context (not addressed to you …)` header — mislabeling the
  // one line the model is supposed to answer as context it should ignore.
  if (batch.length > 0) {
    // The `## Current message` header is a WITHIN-turn label, but it also gets
    // persisted into the transcript — so after many turns the model sees a
    // chain of turns each headed "addressed to you" and a weak model collapses
    // that into "only the latest turn exists", denying it can see what the user
    // said earlier (those turns are in its own message history). This note
    // re-anchors the header as turn-local. Conditional "if earlier turns
    // appear" wording so it is not a false premise on turn 1 (a fresh session
    // has no history). No leading `>` — that is this repo's quote-anchor syntax
    // and would read as quoted content. Worded to NOT contain the literal
    // `## Current message` heading — a pinned test asserts its absence on
    // reminder-only drains, so it must stay batch-gated and substring-free.
    parts.push(
      'Note: if earlier turns appear above, they are real conversation history you can use.',
      "The heading below marks this turn's new message, not the only message that may exist.",
      '',
    )
    parts.push(batch.length === 1 ? '## Current message (addressed to you)' : '## Current messages (addressed to you)')
    for (const b of batch) {
      parts.push(formatInboundPromptLines(b, adapter))
    }
  }
  return parts.join('\n')
}

// The per-turn memory hook must query on ONLY what the human typed this turn,
// not the composeTurnPrompt envelope (time anchor, system reminders, and the
// "## Recent context" block). That envelope dwarfs the actual message, so
// embedding it lets recent-context drift dominate both retrieval lanes and the
// injected memory tracks the scrollback topic instead of the current question.
// Strip all framing — headings, author attribution, quote anchors — down to raw
// text, one batch entry per line. A reminder-only drain yields '', which
// hybridSearch no-ops: correct, since there is no new user message to match.
function composeRetrievalQuery(batch: readonly QueuedInbound[]): string {
  return batch
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join('\n')
}

function formatAuthorLine(
  ts: number,
  adapter: AdapterId,
  authorId: string,
  authorName: string,
  authorIsBot: boolean,
  text: string,
  maxChars?: number,
): string {
  const tag = authorIsBot ? ' [bot]' : ''
  const stamp = ts > 0 ? `[${new Date(ts).toISOString()}] ` : ''
  // Defuse the whole composed line, not just the body: a display name is
  // attacker-chosen too, so a forged marker can arrive through either half.
  return defuseRuntimeMarkers(
    `${stamp}${formatAuthorAttribution(adapter, authorId, authorName)}${tag}: ${capObservedText(text, maxChars)}`,
  )
}

// Cap by whole code points so truncation never splits a surrogate pair (emoji,
// astral-plane chars) into a dangling half. `text.length` (UTF-16 code units) is
// a cheap upper bound on the code-point count, so a string already within the
// cap skips the array build.
function capObservedText(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || text.length <= maxChars) return text
  const points = Array.from(text)
  if (points.length <= maxChars) return text
  return `${points.slice(0, maxChars).join('')} […truncated]`
}

function formatInboundPromptLines(
  inbound: {
    ts: number
    authorId: string
    authorName: string
    authorIsBot: boolean
    text: string
    referenceContext?: InboundReferenceContext
  },
  adapter: AdapterId,
  maxTextChars?: number,
): string {
  const lines = inbound.referenceContext?.sources.map(renderQuoteAnchor) ?? []
  lines.push(
    formatAuthorLine(
      inbound.ts,
      adapter,
      inbound.authorId,
      inbound.authorName,
      inbound.authorIsBot,
      inbound.text,
      maxTextChars,
    ),
  )
  return lines.join('\n')
}

export type { QuoteAnchorSource } from './types'

export function formatAuthorAttribution(adapter: AdapterId, authorId: string, authorName: string): string {
  const displayName = authorName.trim()
  const hasDisplayName = displayName !== ''
  const id = authorId.trim()
  if (id === '') return hasDisplayName ? displayName : authorId

  switch (adapter) {
    case 'slack':
    case 'slack-bot':
    case 'discord':
    case 'discord-bot': {
      const mention = `<@${id}>`
      return hasDisplayName ? `${displayName} ${mention}` : mention
    }
    case 'github': {
      const login = /^\d+$/.test(id) && hasDisplayName ? displayName : id
      const handle = login.startsWith('@') ? login : `@${login}`
      if (!hasDisplayName) return handle
      const normalizedDisplayName = displayName.startsWith('@') ? displayName : `@${displayName}`
      return normalizedDisplayName === handle ? handle : `${displayName} (${handle})`
    }
    case 'telegram-bot':
    case 'webex':
    case 'webex-bot':
    case 'teams':
    case 'instagram':
    case 'line':
    case 'kakaotalk':
      return hasDisplayName ? `${displayName} <${id}>` : id
  }
}

// Picks the right author syntax for the platform so prompts and rendered
// quote anchors use the same form the user would type in that channel.
// Slack/Discord need id mentions (`<@U…>`), GitHub needs handle mentions
// (`@login`) because inbound author ids are numeric, and adapters without
// stable id-only mention syntax fall back to plain display names.
//
// Notification semantics: Slack and Discord both render `<@…>` as a
// styled mention link inside blockquotes; whether the mentioned user is
// PINGED is a separate platform-level UX (Slack pings on first appearance
// in the message regardless of position, Discord respects the
// `allowed_mentions` field which defaults to "ping everyone parsed").
// This matches PR #374's intent — the user IS being notified that the
// agent replied to them, which is the whole point of a quote anchor.
function formatAuthorReference(adapter: AdapterId, authorId: string, authorName: string): string {
  const displayName = authorName.trim() !== '' ? authorName.trim() : authorId
  switch (adapter) {
    case 'slack':
    case 'slack-bot':
    case 'discord':
    case 'discord-bot':
      return `<@${authorId}>`
    case 'github':
      return displayName.startsWith('@') ? displayName : `@${displayName}`
    case 'telegram-bot':
    case 'webex':
    case 'webex-bot':
    case 'teams':
    case 'instagram':
    case 'line':
    case 'kakaotalk':
      return displayName
  }
}

// Renders the single-line `> @mention: excerpt` blockquote prepended to
// outbound replies when the router decides the reply needs an anchor.
// Collapses newlines to spaces so a multi-line user message renders on
// one quoted line (markdown blockquote semantics: a blank line ends the
// quote, and `> foo\nbar` would split the quote and the reply); strips
// existing leading `>` so a quote-of-a-quote stays single-level. Empty
// inbound text (mention-only inbounds like `<@bot>`) falls back to a
// generic marker so the user still sees "the bot saw your ping".
export function renderQuoteAnchor(source: QuoteAnchorSource): string {
  const collapsed = source.text
    .replace(/\s+/g, ' ')
    .replace(/^>+\s*/, '')
    .trim()
  const excerpt =
    collapsed === ''
      ? '(no text)'
      : collapsed.length > QUOTED_REPLY_EXCERPT_MAX_CHARS
        ? `${collapsed.slice(0, QUOTED_REPLY_EXCERPT_MAX_CHARS - 1)}…`
        : collapsed
  const mention = formatAuthorReference(source.adapter, source.authorId, source.authorName)
  return defuseRuntimeMarkers(`> ${mention}: ${excerpt}`)
}

// Separates the anchor from the reply with a blank line (`\n\n`), not a
// single `\n`. In standard GFM and Slack's `markdown` block, a single
// `\n` inside a paragraph is a soft break rendered as whitespace, which
// keeps the `>` blockquote styling running visually through the next
// line — i.e. the agent's reply text gets swallowed into the quote. The
// blank line forces a paragraph boundary that unambiguously ends the
// blockquote on every renderer (CommonMark, GFM, Slack mrkdwn, Discord
// markdown).
export function prependQuoteAnchor(replyText: string, source: QuoteAnchorSource): string {
  const anchor = renderQuoteAnchor(source)
  if (replyText === '') return anchor
  return `${anchor}\n\n${replyText}`
}

type QuoteAnchorBatchEntry = {
  text: string
  authorId: string
  authorName: string
  authorIsBot: boolean
  receivedAt: number
  externalMessageId: string
}

type QuoteAnchorObservedEntry = {
  receivedAt: number
  source: 'prefetch' | 'observed'
}

export type QuoteAnchorCandidate = {
  source: QuoteAnchorSource
  // Native id of the primary inbound, so a native-reply adapter can point at
  // the exact message; the blockquote fallback ignores it.
  externalMessageId: string
  primaryReceivedAt: number
  hadInterveningObserved: boolean
}

export type QuoteAnchorTarget = {
  source: QuoteAnchorSource
  externalMessageId: string
}

// Strips both current `[<Adapter> attachment #N: ...]` and legacy
// `[<Adapter> message with ...]` placeholders that adapter
// classifiers synthesize for non-text inbounds (KakaoTalk stickers,
// Slack/Discord/Telegram attachments). The quote anchor is a UX
// affordance pointing the human at *their words* — quoting a sticker as
// `> Alice: [KakaoTalk attachment #1: sticker name=...]`
// is noise, and for mixed inbounds like `<caption> [KakaoTalk message with
// photo 1254x1254 ...]` the human only wrote the caption, so the placeholder
// is the wrong thing to surface. The callsite (captureQuoteCandidate)
// treats an empty residue as "no quote anchor"; mixed inbounds keep the
// human-written portion. renderQuoteAnchor later collapses whitespace
// so residual double-spaces from mid-string strips are harmless.
const CHANNEL_MEDIA_PLACEHOLDER_RE =
  /\[(?:KakaoTalk|Slack|Discord|Telegram) (?:message with|attachment #\d+:) [^\]]*\]/g

export function stripChannelMediaPlaceholders(text: string): string {
  return text
    .replace(CHANNEL_MEDIA_PLACEHOLDER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

// Snapshot the primary inbound + observed-buffer state at drain time so
// the send-side decision has the data it needs without holding a
// reference to the batch arrays. Returns null when there's nothing
// anchorable (empty batch, primary is a bot, or primary is a non-text
// inbound with no residual human-written text after stripping the
// adapter's media placeholder).
//
// `hadInterveningObserved` counts ONLY live observations (`source ===
// 'observed'`), not prefetched scrollback. Prefetch stamps `receivedAt =
// now()` inside ensureLive — wall-clock-later than the primary inbound
// that triggered ensureLive — so without this gate, every cold-start
// first turn would see "intervening observed" entries and fire the
// quote anchor even when the reply lands within milliseconds. The
// signal we actually want is "did real new chatter arrive between the
// user's inbound and the agent's reply", which only live observations
// represent.
export function captureQuoteCandidate(
  adapter: AdapterId,
  batch: readonly QuoteAnchorBatchEntry[],
  observed: readonly QuoteAnchorObservedEntry[],
): QuoteAnchorCandidate | null {
  if (batch.length === 0) return null
  const primary = batch[batch.length - 1]!
  if (primary.authorIsBot) return null
  const cleaned = stripChannelMediaPlaceholders(primary.text)
  if (cleaned === '') return null
  return {
    source: { adapter, authorId: primary.authorId, authorName: primary.authorName, text: cleaned },
    externalMessageId: primary.externalMessageId,
    primaryReceivedAt: primary.receivedAt,
    hadInterveningObserved: hasInterveningObserved(primary.receivedAt, observed),
  }
}

function refreshQuoteCandidate(
  candidate: QuoteAnchorCandidate,
  observed: readonly QuoteAnchorObservedEntry[],
): QuoteAnchorCandidate {
  if (candidate.hadInterveningObserved) return candidate
  if (!hasInterveningObserved(candidate.primaryReceivedAt, observed)) return candidate
  return { ...candidate, hadInterveningObserved: true }
}

function hasInterveningObserved(primaryReceivedAt: number, observed: readonly QuoteAnchorObservedEntry[]): boolean {
  return observed.some((o) => o.source === 'observed' && o.receivedAt >= primaryReceivedAt)
}

// Send-time decision: given a captured candidate and the current clock,
// returns the source to anchor against or null. Skips when:
//   - quotedReply is disabled in config
//   - no observed messages came between primary inbound and now
// A null candidate (no batch yet, or batch was bot-only) always skips.
export function decideQuoteAnchor(
  candidate: QuoteAnchorCandidate | null,
  _nowMs: number,
  adapterConfig: ChannelAdapterConfig | undefined,
): QuoteAnchorTarget | null {
  if (candidate === null) return null
  const config = adapterConfig?.quotedReply
  if (config !== undefined && config.enabled === false) return null
  if (!candidate.hadInterveningObserved) return null
  return { source: candidate.source, externalMessageId: candidate.externalMessageId }
}

export type ReplyRenderMode = 'native' | 'quote'

// Per-adapter, per-shape decision: can this exact outbound carry a native
// platform reply, or must it degrade to the blockquote fallback? Conditional
// because native support is not uniform within an adapter — Telegram's
// `sendMessage` accepts `reply_to_message_id` but `sendDocument` does not, so
// an attachment-only Telegram reply must quote; the same text-only restriction
// holds for KakaoTalk. Slack's primitive is `thread`, not a per-message
// reply, so it stays quote; GitHub's PR-review reply already rides on `thread`.
//
// KakaoTalk is `native` here even though its reply payload can fail to resolve
// at send time — the adapter degrades to the blockquote fallback itself using
// `replyTo.source`, so the router still routes it down the native branch.
const NATIVE_REPLY_TEXT_ADAPTERS = new Set<AdapterId>(['telegram-bot', 'kakaotalk'])

// Webex's `parentId` rides on both `sendMessage` and `uploadFile`, so a reply is
// native for every shape — including attachment-only, which the text-gated set
// above cannot express. Both Discord adapters join this set because each carries
// `message_reference` on BOTH the text send (`sendMessage`) and the attachment
// send (`payload_json` on the first file upload), so an attachment-only Discord
// reply is a native reply-arrow, not a bare blockquote. Special-cased before the
// text gate so the router sets `replyTo` (not a blockquote) even when the reply
// carries no text.
const NATIVE_REPLY_EVERY_SHAPE_ADAPTERS = new Set<AdapterId>(['webex', 'webex-bot', 'discord-bot', 'discord'])

export function resolveReplyRenderMode(msg: OutboundMessage): ReplyRenderMode {
  if (NATIVE_REPLY_EVERY_SHAPE_ADAPTERS.has(msg.adapter)) return 'native'
  const hasText = normalizeSendText(msg.text) !== undefined
  if (hasText && NATIVE_REPLY_TEXT_ADAPTERS.has(msg.adapter)) return 'native'
  return 'quote'
}

type Sliced = { kind: 'message'; message: ChannelHistoryMessage } | { kind: 'elision'; elidedCount: number }

export function sliceHeadTail(messages: readonly ChannelHistoryMessage[], head: number, tail: number): Sliced[] {
  if (head < 0 || tail < 0) throw new Error(`sliceHeadTail: head and tail must be non-negative (got ${head}, ${tail})`)
  if (head === 0 && tail === 0) return []
  if (messages.length <= head + tail) {
    return messages.map((m) => ({ kind: 'message', message: m }))
  }
  const headSlice: Sliced[] = head > 0 ? messages.slice(0, head).map((m) => ({ kind: 'message', message: m })) : []
  const tailSlice: Sliced[] = tail > 0 ? messages.slice(-tail).map((m) => ({ kind: 'message', message: m })) : []
  const elidedCount = messages.length - head - tail
  return [...headSlice, { kind: 'elision', elidedCount }, ...tailSlice]
}

function tryOpenSessionManager(
  agentDir: string,
  sessionDir: string,
  existingSessionId: string,
  existingSessionFile: string | undefined,
  logger: RouterLogger,
): SessionManager {
  if (existingSessionFile === undefined) {
    logger.warn(
      `[channels] session ${existingSessionId} has no sessionFile (v2 mapping not yet migrated); creating new`,
    )
    return SessionManager.create(agentDir, sessionDir)
  }
  try {
    const path = `${sessionDir}/${existingSessionFile}`
    return SessionManager.open(path)
  } catch (err) {
    logger.warn(
      `[channels] could not rehydrate session ${existingSessionId} from ${existingSessionFile}: ${describeError(err)}; creating new`,
    )
    return SessionManager.create(agentDir, sessionDir)
  }
}

function consecutiveSendKey(chat: string, thread: string | null | undefined): string {
  return `${chat}:${thread ?? ''}`
}

export type ResolveLiveSessionResult =
  | { kind: 'found'; session: LiveSession }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

// Lookup policy for adapter-driven commands. Exact-key match always wins.
// On miss, fall back to (adapter, workspace, chat) without thread — but
// only when EXACTLY ONE non-destroyed candidate exists. Ambiguous matches
// return 'ambiguous' so the caller can refuse to act rather than abort an
// arbitrary session.
//
// Why the fallback: Slack slash commands carry channel_id but no thread_ts
// (`thread: null`), so a slash invocation from a thread-keyed live session
// would otherwise report no-live-session. Discord doesn't hit this — Discord
// treats threads as channels, so the exact-key path already resolves.
//
// Why the fallback is thread-null-ONLY: a `!stop` typed INSIDE a Slack thread
// carries the real `thread_ts`, so it pinpoints one exact thread. Falling back
// to "any session in this channel" for a thread-specific key would let the
// command hit an UNRELATED session in a different thread (or a channel-level
// observe-only session) — the multi-agent bug where a bystander bot that only
// observed the thread aborts its own idle session and posts "stopped". A
// non-null thread that misses the exact lookup therefore returns 'none', never
// the cross-thread fallback.
//
// Why ambiguity-rejection: "first match wins" map-iteration semantics would
// abort an arbitrary thread when multiple thread-keyed sessions coexist in
// one channel (plausible on Slack: bot mentioned in multiple threads). The
// user's slash command picker doesn't know about threads; we don't know
// which they meant; refusing is safer than guessing.
export function resolveLiveSessionForCommand(
  liveSessions: ReadonlyMap<string, LiveSession>,
  key: ChannelKey,
): ResolveLiveSessionResult {
  const exact = liveSessions.get(channelKeyId(key))
  if (exact && !exact.destroyed) return { kind: 'found', session: exact }

  if (key.thread !== null) return { kind: 'none' }

  const matches: LiveSession[] = []
  for (const candidate of liveSessions.values()) {
    if (candidate.destroyed) continue
    if (
      candidate.key.adapter === key.adapter &&
      candidate.key.workspace === key.workspace &&
      candidate.key.chat === key.chat
    ) {
      matches.push(candidate)
      if (matches.length > 1) {
        return { kind: 'ambiguous', count: matches.length }
      }
    }
  }
  if (matches.length === 1) return { kind: 'found', session: matches[0]! }
  return { kind: 'none' }
}

// Strips leaked `<think>…</think>` reasoning from outbound message text. Some
// models (DeepSeek-R1 / Qwen-QwQ family) emit chain-of-thought inline as a
// literal `<think>` span in `delta.content` rather than a dedicated `thinking`
// content block, so it lands verbatim in the assistant body and — without this
// — gets posted to the channel (production: a reasoning paragraph leaked into a
// Slack thread). The whole block is removed, not just the tags.
//
// THINK_BLOCK_RE matches closed blocks (case-insensitive, attribute-tolerant,
// multi-line). DANGLING_THINK_RE catches an UNCLOSED trailing `<think>` (model
// ran out of budget mid-reasoning) by dropping open-tag-to-end. The final pass
// collapses excision-left blank-line runs and trims.
const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi
const DANGLING_THINK_RE = /<think\b[^>]*>[\s\S]*$/i

export function stripThinkBlocks(text: string): string {
  const withoutBlocks = text.replace(THINK_BLOCK_RE, '').replace(DANGLING_THINK_RE, '')
  return withoutBlocks.replace(/\n{3,}/g, '\n\n').trim()
}

function normalizeSendText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  // Strip before the empty-collapse so a turn that was ONLY a think block
  // resolves to `undefined` (suppressed) instead of posting an empty shell.
  const stripped = stripThinkBlocks(text)
  if (stripped === '') return undefined
  return stripped
}

function recordSendTimestamp(live: LiveSession, sendKey: string, ts: number): number {
  const buf = live.sendTimestamps.get(sendKey)
  const cutoff = ts - SEND_RATE_WINDOW_MS
  if (!buf) {
    live.sendTimestamps.set(sendKey, [ts])
    return 1
  }
  let i = 0
  while (i < buf.length && buf[i]! <= cutoff) i++
  if (i > 0) buf.splice(0, i)
  buf.push(ts)
  return buf.length
}

function dmMembership(fetchedAt: number): MembershipCount {
  return { humans: 1, bots: 1, fetchedAt, truncated: false }
}

async function withMembershipTimeout(
  promise: Promise<MembershipCount | null>,
  key: ChannelKey,
  logger: RouterLogger,
): Promise<MembershipCount | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        `[channels] ${channelKeyId(key)}: membership cold fetch timed out after ${MEMBERSHIP_COLD_FETCH_TIMEOUT_MS}ms`,
      )
      resolve(null)
    }, MEMBERSHIP_COLD_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// Throwing variant of the membership timeout pattern: races the work against
// a deadline and rejects with a descriptive error on miss. Used wherever a
// hung registered callback (Discord/Slack/Telegram REST) would otherwise
// leave an awaiting caller stuck forever and there is no graceful-
// degradation value the caller could substitute (contrast withMembershipTimeout,
// which returns null because engagement can run on a stale membership reading).
// The helper owns timer lifetime so callers cannot leak timers on a fast
// resolution.
async function raceWithTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// Walks the session branch backward from the leaf to find a recoverable
// assistant message — i.e., text the user should see but didn't, because the
// model failed to call `channel_reply`/`channel_send` before its turn ended.
//
// Four recovery shapes:
//
//   - source: 'leaf'
//     The leaf entry IS an assistant message with `stopReason === 'stop'`.
//     The model finished its turn with visible text but never called a channel
//     tool. Pre-existing behavior; this is what the historical
//     `latestAssistantText` covered.
//
//   - source: 'length-leaf'
//     The leaf IS an assistant message with `stopReason === 'length'` — the
//     model hit the output cap, typically after interleaving reasoning past the
//     budget, but its text blocks usually hold a complete answer. Returned raw;
//     validateChannelTurn strips leaked `<think>` spans and posts the remainder
//     only if a real reply survives, else diverts to the raised-budget retry.
//     Observed against claude on a channel turn that fell silent (2026-06-12).
//
//   - source: 'mid-turn'
//     The leaf IS an assistant message with `stopReason === 'toolUse'`. Its
//     visible text, if any, is unfinished narration rather than a trustworthy
//     answer because the planned tool work never reached a follow-up assistant
//     message. The caller uses this source to enter bounded continuation rather
//     than publishing the narration.
//
//   - source: 'pre-tool'
//     The leaf is a `toolResult` and the immediately-prior assistant message
//     has `stopReason === 'toolUse'` (it called the tool that produced this
//     toolResult). The upstream pi-agent-core loop SHOULD have made a
//     follow-up LLM call after the tool returned, but that call either never
//     happened or produced no persisted message. The caller treats the
//     assistant's commentary as unfinished and enters bounded continuation.
//
// Returns null when no recovery is appropriate:
//   - No leaf, no messages in branch, branch is malformed
//   - Leaf is an assistant with `stopReason` of 'error' / 'aborted' and is NOT
//     preceded by a toolResult pattern — we don't recover an upstream provider
//     failure ('error') or a terminal-reply abort ('aborted'); neither is a
//     deliberate reply. ('length' IS recovered now — see 'length-leaf' above.)
//   - Leaf is a user/system message (model hasn't responded yet)
//
// `visibleAssistantText` returning '' (empty string) is a valid recovery
// target — the caller's downstream guards (`endsWithNoReplySignal('')` returns
// true) handle the no-content case explicitly via the `no_reply` log.
function recoverableAssistantText(
  session: AgentSession,
): { text: string; source: 'leaf' | 'mid-turn' | 'pre-tool' | 'length-leaf' } | null {
  const leaf = session.sessionManager.getLeafEntry()
  if (!leaf) return null

  if (leaf.type === 'message' && leaf.message.role === 'assistant') {
    if (leaf.message.stopReason === 'stop') {
      return { text: visibleAssistantText(leaf.message), source: 'leaf' }
    }
    // Preserve the unfinished shape for the caller's continuation ladder; its
    // prose is not a final answer and must not be published directly.
    if (leaf.message.stopReason === 'toolUse') {
      return { text: visibleAssistantText(leaf.message), source: 'mid-turn' }
    }
    // A `length` leaf hit the output cap but routinely carries a complete (or
    // near-complete) answer in its text blocks — the model just kept reasoning
    // past the budget. Surfacing it as 'length-leaf' lets validateChannelTurn
    // strip leaked think-spans and post the answer if any survives, while still
    // diverting a think-only `length` turn to the raised-budget retry. A leaf
    // that also carries a toolCall block was truncated mid-tool-planning, not on
    // a final answer, so it is NOT the recoverable shape. `error` (provider
    // failure) and `aborted` (terminal-reply abort) stay unrecoverable too.
    if (leaf.message.stopReason === 'length' && !hasToolCall(leaf.message)) {
      return { text: visibleAssistantText(leaf.message), source: 'length-leaf' }
    }
    return null
  }

  // Pre-tool recovery: the leaf must be a toolResult message, and walking
  // back through parentId chain must land on an assistant message before any
  // user message (otherwise we'd be recovering text from a turn the user
  // already saw a reply to). Bounded walk with a depth guard so a malformed
  // session can't infinite-loop.
  if (!(leaf.type === 'message' && leaf.message.role === 'toolResult')) return null

  let cursor: { parentId: string | null } | undefined = leaf
  for (let depth = 0; depth < 32 && cursor?.parentId; depth++) {
    const parent = session.sessionManager.getEntry(cursor.parentId)
    if (!parent) return null
    if (parent.type === 'message') {
      if (parent.message.role === 'assistant') {
        return parent.message.stopReason === 'toolUse'
          ? { text: visibleAssistantText(parent.message), source: 'pre-tool' }
          : null
      }
      if (parent.message.role === 'user') return null
    }
    cursor = parent
  }
  return null
}

// The non-terminal stop reason when the leaf is an assistant message that did
// NOT cleanly finish — `length` (hit the token cap, the canonical kimi
// reasoning-loop), `error` (an upstream provider failure), or `aborted` (the
// terminal-reply abort) — else undefined. `undefined` is the signature of a
// benign empty/cold turn (leaf undefined / a non-assistant entry). The
// validateChannelTurn recovery path branches on the specific reason: `error`
// diverts to the provider-error notice, `length` gets a raised retry budget,
// `aborted` retries under the default backstop.
function assistantLeafStopReason(session: AgentSession): 'length' | 'error' | 'aborted' | undefined {
  const leaf = session.sessionManager.getLeafEntry()
  if (!leaf || leaf.type !== 'message' || leaf.message.role !== 'assistant') return undefined
  const stop = leaf.message.stopReason
  if (stop === 'length' || stop === 'error' || stop === 'aborted') return stop
  return undefined
}

// True when the branch ends on an UNANSWERED `toolUse` that left NO postable
// prose — the model called a tool and the upstream pi-agent-core post-tool
// follow-up never produced an assistant message (the loop was aborted, or the
// follow-up stream cancelled). Two leaf shapes carry this signature: the leaf
// IS a `toolUse` assistant, or the leaf is a `toolResult` whose nearest
// assistant ancestor (reached before any user message) is `toolUse`. The
// no-prose requirement is the discriminator from a model that narrated a reply
// alongside its tool call and DID land a real send this turn (that trailing
// `toolUse` is delivered narration, not a stranded promise — leave it alone).
// Keys on the model having INTENDED to keep working with nothing yet said; used
// to re-prompt a turn that strands mid-work after a `more_work_this_turn: true` status
// reply instead of ending in silence.
function leafIsStrandedToolUse(session: AgentSession): boolean {
  const leaf = session.sessionManager.getLeafEntry()
  if (!leaf || leaf.type !== 'message') return false
  if (leaf.message.role === 'assistant') {
    return leaf.message.stopReason === 'toolUse' && visibleAssistantText(leaf.message).trim() === ''
  }
  if (leaf.message.role !== 'toolResult') return false
  let cursor: { parentId: string | null } | undefined = leaf
  for (let depth = 0; depth < 32 && cursor?.parentId; depth++) {
    const parent = session.sessionManager.getEntry(cursor.parentId)
    if (!parent) return false
    if (parent.type === 'message') {
      if (parent.message.role === 'assistant') {
        return parent.message.stopReason === 'toolUse' && visibleAssistantText(parent.message).trim() === ''
      }
      if (parent.message.role === 'user') return false
    }
    cursor = parent
  }
  return false
}

// Permanently close a trailing tool batch whose assistant toolUse has one or
// more missing results. PR #1386 could recognize this shape and re-prompt, but
// the 2026-08-28 Discord fingerprint showed the poisoned branch rejecting each
// retry in ~53ms before provider generation: 15 user entries accumulated with
// no assistant entry until idle rollover. Append-only error results preserve
// the full conversation and any completed sibling results while making both
// the live Agent state and persisted SessionManager branch valid again.
function repairDanglingToolUseBranch(session: AgentSession, timestamp: number): string[] {
  const branch = session.sessionManager.getBranch?.()
  if (!branch) return []
  const messages = branch.filter(
    (entry): entry is Extract<SessionEntry, { type: 'message' }> => entry.type === 'message',
  )
  if (messages.length === 0) return []

  const completed = new Set<string>()
  let index = messages.length - 1
  while (index >= 0) {
    const message = messages[index]!.message
    if (message.role !== 'toolResult') break
    completed.add(message.toolCallId)
    index--
  }

  const assistantEntry = messages[index]
  if (!assistantEntry || assistantEntry.message.role !== 'assistant') return []
  if (assistantEntry.message.stopReason !== 'toolUse') return []
  const missing = assistantEntry.message.content.filter(
    (block): block is Extract<(typeof assistantEntry.message.content)[number], { type: 'toolCall' }> =>
      block.type === 'toolCall' && !completed.has(block.id),
  )
  if (missing.length === 0) return []

  const repairedMessages: ToolResultMessage[] = missing.map((toolCall) => ({
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: 'text',
        text: 'Tool execution was interrupted before its result was recorded. Continue from the preserved conversation without assuming the tool succeeded.',
      },
    ],
    isError: true,
    timestamp,
  }))
  for (const message of repairedMessages) session.sessionManager.appendMessage(message)
  // SessionManager is canonical in pi 0.87: assigning agent.state.messages no longer
  // changes provider history. Refresh after appending so the next prompt sees the
  // persisted interruption results (pi-coding-agent 0.87.0 CHANGELOG:39-45).
  session.refreshContext()
  return missing.map((toolCall) => toolCall.name)
}

// The turn-end leaf is a FRESH empty `stop` — an assistant message with no visible
// text and no tool call, distinct from the leaf in place at the last successful
// send. "Fresh" (`!== lastSendLeafId`) is what separates a post-send degeneration
// (the model did more work, then dropped its conclusion) from a legitimate
// ack-then-stop where the model meant to wait for the user (leaf unchanged since
// the send). The two willingness paths below layer their own promise-signal on top
// of this shape: `channel_reply({ more_work_this_turn: true })` via `continueReplyTurn`, and
// `channel_send` acks via the willingness phrase table.
function isFreshEmptyStopAfterSend(live: LiveSession): boolean {
  const leaf = live.session.sessionManager.getLeafEntry()
  if (!leaf || leaf.type !== 'message' || leaf.message.role !== 'assistant') return false
  if (leaf.message.stopReason !== 'stop') return false
  if (hasToolCall(leaf.message) || visibleAssistantText(leaf.message).trim() !== '') return false
  return leaf.id !== live.lastSendLeafId
}

// The `channel_send` analogue of the `more_work_this_turn: true` recovery: the most recent
// send to this target was a continuation-willingness ack (by phrase), then the
// model produced a fresh empty stop. `channel_send` keeps the turn alive without a
// `more_work_this_turn: true` flag and stamps no semantic marker, so the phrase table is the
// only "I promised to keep working" signal available for that shape.
function isEmptyStopAfterWillingnessAck(live: LiveSession): boolean {
  if (!isFreshEmptyStopAfterSend(live)) return false
  const ackText = live.lastSentText.get(consecutiveSendKey(live.key.chat, live.key.thread))
  return ackText !== undefined && detectContinuationWillingness(ackText)
}

function visibleAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function hasToolCall(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === 'toolCall')
}

// True when any assistant message in the CURRENT prompt-attempt carries a
// toolCall block. "This attempt" is bounded by walking the parentId chain back
// to the first user message — which INCLUDES an injected retry nudge, since
// that lands as a user-side entry — so each retry is scored on its own tool
// work, not the original turn's. validateChannelTurn uses this to tell a
// bare-empty `stop` that followed real tool work (Fireworks/gpt empty-completion
// degeneration → retry) apart from a bare-empty `stop` that produced nothing
// from nothing (deliberate silence → honor it). The `source === 'leaf'` +
// `stopReason: 'stop'` invariant at the call site guarantees any tool called
// this attempt already returned a toolResult; otherwise the leaf would be
// `toolUse`, not `stop`. Depth-bounded like the other branch walks so a
// malformed session can't loop.
function attemptMadeToolCall(session: AgentSession): boolean {
  let cursor: SessionEntry | undefined = session.sessionManager.getLeafEntry()
  for (let depth = 0; depth < 32 && cursor; depth++) {
    if (cursor.type === 'message') {
      if (cursor.message.role === 'user') return false
      if (cursor.message.role === 'assistant' && hasToolCall(cursor.message)) return true
    }
    cursor = cursor.parentId ? session.sessionManager.getEntry(cursor.parentId) : undefined
  }
  return false
}

// Peels a single symmetric markdown-emphasis wrapper off a token: bold/italic
// asterisks (`*`, `**`, `***`), underscores (`_`, `__`), or inline-code
// backticks. Only strips when the SAME run brackets both ends, so `**NO_REPLY**`
// → `NO_REPLY` while an asymmetric `*NO_REPLY` or a non-wrapping `NO_REPLY_MODE`
// is returned unchanged. Not recursive — one layer is enough for the observed
// `**...**` / `` `...` `` "loud" drift; anything more nested is not a real form.
function stripEmphasisWrapper(token: string): string {
  const match = /^([*_`]{1,3})([^*_`].*?[^*_`]|[^*_`])\1$/.exec(token)
  return match ? match[2]! : token
}

// Lenient on purpose: distilled / smaller models routinely drift off the
// documented `NO_REPLY` form. We additionally accept `(NO_REPLY)` (Claude-style
// hedging), markdown-emphasized "loud" forms (`**NO_REPLY**`, `` `NO_REPLY` ``,
// `*NO_REPLY*`), and empty visible text (e.g. Kimi-distilled models that emit
// only a thinking block and end the turn) — without the empty case we'd recover
// an empty string into the chat. The prompt contract still teaches the strict
// literal; this just widens what we accept. Shared with channel_send /
// channel_reply so all three call sites stay in lockstep.
export function isNoReplySignal(text: string): boolean {
  const trimmed = stripEmphasisWrapper(text.trim())
  if (trimmed === '') return true
  if (trimmed === 'NO_REPLY') return true
  if (trimmed === '(NO_REPLY)') return true
  return false
}

// Looser sibling of isNoReplySignal, used ONLY by validateChannelTurn's
// recovery path. Catches leaked-reasoning turns where the model produced
// prose and then ended with the silent-turn token, e.g.
//   "The user is laughing. ... I'll end with NO_REPLY.NO_REPLY"
// Today those fall through to recovery and the entire reasoning paragraph
// gets posted to the channel — the worst-possible outcome, since the leaked
// prose is itself an admission that the model intended to stay silent.
//
// NOT shared with channel_send / channel_reply misuse guards: those need
// strict literal match so a legitimate message like "set NO_REPLY=true in
// the env" isn't rejected as a misuse of the silent-turn signal. Recovery
// is a different question — by the time we get here the model already
// failed to call the tool, and "ends in NO_REPLY" is strong evidence of
// intent to stay silent, not of intent to send those bytes.
//
// Matches (returns true):
//   "NO_REPLY"                        (strict)
//   "(NO_REPLY)"                      (strict, parenthesized)
//   "... I'll end with NO_REPLY"      (trailing token after whitespace)
//   "... end with NO_REPLY."          (+ sentence punctuation)
//   "... end with NO_REPLY.NO_REPLY"  (model-doubled terminator, glued)
//   "... and stop. (NO_REPLY)"        (parenthesized at end)
//   "... nothing to add. **NO_REPLY**"(markdown-emphasized "loud" form)
//   "... nothing here. `NO_REPLY`"    (inline-code "loud" form)
// Does not match (returns false):
//   "NO_REPLY means do nothing"       (token at start, prose after)
//   "the env var is NO_REPLY_MODE"    (substring, not whole token)
//   "the flag is FOO_NO_REPLY"        (identifier — `_` is not a token boundary)
//   "the **NO_REPLY** token is how..."(emphasized but mid-sentence, prose after)
//   "no reply needed"                 (case-sensitive on purpose)
export function endsWithNoReplySignal(text: string): boolean {
  if (isNoReplySignal(text)) return true
  const trimmed = text.trim()
  if (trimmed === '') return false
  // Isolate the final token, then defer to isNoReplySignal (which strips a
  // symmetric emphasis wrapper). Boundaries are whitespace / sentence
  // punctuation / opening bracket only — `.NO_REPLY` splits off the preceding
  // sentence (covering the model-doubled `...NO_REPLY.NO_REPLY` shape), while
  // `_` is deliberately NOT a boundary so an identifier like `FOO_NO_REPLY`
  // stays one token and reads as prose, not a signal.
  const tail = trimmed.replace(/[.!?)\]\s]+$/, '')
  const lastToken = tail.split(/[\s.!?([]/).pop() ?? ''
  // An empty final token means the text ended on an opening bracket (e.g. a
  // leaked `skip_response()` call), not a signal — don't hand it to
  // isNoReplySignal, whose empty-string case reads as deliberate silence.
  if (lastToken === '') return false
  return isNoReplySignal(lastToken)
}

// Detects the upstream "empty response" debug sentinel: when the LLM ends a
// turn with only a `thinking` block, some provider SDK paths (observed
// against claude-opus-4-5 via pi-ai) fabricate a single text block whose
// body is a Python-repr dump of the raw API response — including the
// model's thinking content and Anthropic's tamper-proof signature. The
// recovery path in validateChannelTurn would otherwise post that sentinel
// straight to the channel (production: signature leaked into a public
// Slack channel on 2026-05-21).
//
// Kept separate from isNoReplySignal on purpose: that helper is the agent's
// deliberate silent-turn protocol, this is upstream damage control. They
// log under distinct subjects (`upstream_empty_response_sentinel` vs
// `no_reply`) so an operator can tell a healthy quiet turn from a stream of
// upstream empties that warrant investigation.
//
// Strict detection: leading `(Empty response:` AND a dict-encoded
// `'stop_reason'` key. Catches the observed shape
// `(Empty response: {'content': [...], 'stop_reason': 'end_turn', ...})`
// while allowing legit prose like "Empty response from the cache layer".
export function isUpstreamEmptyResponseSentinel(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('(Empty response:')) return false
  return trimmed.includes("'stop_reason'")
}

// Detects any Kimi-family tool-call delimiter token. Kimi-family deployments
// emit tool calls inline in their native chat template using these tokens:
//
//   <|tool_calls_section_begin|>
//     <|tool_call_begin|>functions.<name>:<idx><|tool_call_argument_begin|>{...}<|tool_call_end|>
//   <|tool_calls_section_end|>
//
// (Source: https://github.com/MoonshotAI/Kimi-K2/blob/1b4022b/docs/tool_call_guidance.md;
// the documented set is exactly five tokens — the section begin/end markers,
// the per-call begin/end markers, and the argument-begin separator. There is
// no `<|tool_call_argument_end|>`: arguments terminate at `<|tool_call_end|>`.)
//
// Production inference servers are expected to parse this format server-side
// and translate it into OpenAI-shaped `choice.delta.tool_calls`. When the
// translation breaks (observed against Fireworks' `kimi-k2p6-turbo` router on
// 2026-05-24; vLLM had a similar class of leak fixed in
// https://github.com/vllm-project/vllm/pull/38579), the raw tokens flow
// through `choice.delta.content` instead. pi-ai's `openai-completions`
// provider is vendor-neutral and has no Kimi-specific parser, so they land
// verbatim in the assistant message's text content with `stopReason: 'stop'`.
//
// Used as a defense-in-depth check at the `channel_send` / `channel_reply`
// tool boundary so a model that somehow passes raw delimiter text as the
// message body is denied. NOT used directly by the recovery path in
// `validateChannelTurn` — see `isLikelyKimiChannelToolLeak` below.
const KIMI_TOOL_DELIMITER_RE = /<\|tool_calls_section_(?:begin|end)\|>|<\|tool_call_(?:begin|end|argument_begin)\|>/

export function containsKimiToolDelimiter(text: string): boolean {
  return KIMI_TOOL_DELIMITER_RE.test(text)
}

// Narrower predicate used by `validateChannelTurn` to decide whether to
// suppress recovery of assistant text. Requires BOTH:
//   (1) at least one Kimi tool-call delimiter token, AND
//   (2) a recognizable channel-tool-call identifier (`channel_reply:N` or
//       `channel_send:N`, with or without the `functions.` prefix).
//
// The two-signal rule narrows the false-positive surface to "the model was
// trying to call a channel tool and the upstream parser failed". Bare-text
// discussion of the Kimi protocol — e.g. the agent answering "explain Kimi's
// tool-call format" with documentation-style prose containing `<|tool_call_begin|>`
// — does NOT trigger suppression and reaches the user normally. The leak shape
// observed in production (`channel_reply:0<|tool_call_argument_begin|>{...}<|tool_calls_section_end|>`)
// satisfies both conditions trivially.
//
// The tool-name regex deliberately stays loose on the index suffix
// (`channel_reply:0` / `channel_reply:1` / `channel_send:0` / ...): every
// observed leak uses the canonical `functions.<name>:<idx>` shape, but partial
// parsers may strip the `functions.` prefix before the leak surfaces.
const KIMI_CHANNEL_TOOL_ID_RE = /(?:functions\.)?channel_(?:reply|send):\d+/

export function isLikelyKimiChannelToolLeak(text: string): boolean {
  if (!containsKimiToolDelimiter(text)) return false
  return KIMI_CHANNEL_TOOL_ID_RE.test(text)
}

// Detects the *plain-text* shape of a leaked tool invocation — the model
// serialized a tool call as ordinary prose instead of producing a real tool
// call. Observed against Kimi-family deployments on KakaoTalk: the entire
// assistant message body is literally
//
//   channel_reply({"text":"<the user-facing greeting the bot meant to send>"})
//
// with no Kimi delimiter tokens (`<|tool_call_begin|>` etc.), so
// `isLikelyKimiChannelToolLeak` cannot catch it. Without a guard the
// recovery path in `validateChannelTurn` posts this raw function-call
// serialization straight to the channel, which is exactly what
// users see in the reported screenshots.
//
// `skip_response` belongs here too, and is the more insidious case: the model
// means to *decline* the turn but serializes the decision as prose —
//
//   skip_response({ reason: "Empty messages, no content to respond to" })
//
// Because the recovery path treats this as ordinary assistant text, the bot
// posts its own "I'm staying silent" plumbing to the channel, the exact
// opposite of the intended no-op. It is never a legitimate user-facing reply.
//
// Detection is a SINGLE whole-message boundary for every tool, then a per-name
// disposition. reply/send RECOVER (their leaked form holds a salvageable user
// message the extractor re-posts); everything else SUPPRESSES.
//
// SUPPRESS is the default and is detected by SHAPE, not a curated name list — a
// `toolname(...)` that is the model's ENTIRE turn output is always a protocol
// malfunction (the model narrated a call instead of emitting it), and that raw
// plumbing must never reach the channel. No allowlist to keep in sync as tools
// are added.
//
// The false-positive boundary is "the WHOLE trimmed message is a single call
// expression" — NOT "starts with a call". A developer-facing reply like
// `read({ ... }) lets you load a file` has text after the closing paren, so it
// is prose and reaches the user. Only a message that is *nothing but* the call
// (`skip_response({ ... })`, `channel_react({ emoji: "eyes" })`, bare
// `channel_disengage()`) is a leak. This is what lets the rule cover every tool
// — including future ones and generic tools like `bash(...)` — without risking
// legitimate replies, because a real reply is never *only* a bare tool call.
//
// `isWholeMessageToolCall` (below) is the bracket-aware parser; it returns the
// called tool's name so the caller can apply the one intrinsic distinction that
// survives: `skip_response` suppresses SILENTLY (the model wanted silence, and
// suppression already delivered it — warning would be noise), while every other
// suppressed leak pushes a self-correction reminder so the model retries with a
// real tool call or a real reply.
const SKIP_RESPONSE_TOOL_NAME = 'skip_response'

export type PlainTextChannelToolCallKind = 'reply' | 'send' | 'suppress-silent' | 'suppress-warn'

export function getPlainTextChannelToolCallKind(text: string): PlainTextChannelToolCallKind | null {
  // Everything routes through the SAME whole-message boundary, including
  // reply/send recovery — a prefix match there would false-positive prose like
  // `channel_reply({"text":"hi"}) is the serialized form`, recovering `hi` and
  // dropping the explanation. `isWholeMessageToolCall` returns the tool name
  // only when the entire trimmed message is the call (or a truncated one), so a
  // reply/send leak still recovers while a mention-with-trailing-prose falls
  // through to the user. The JSON-object serialization shape (see
  // `parseWholeMessageJsonToolCall`) feeds the SAME name->kind mapping below.
  const toolName = isWholeMessageToolCall(text) ?? parseWholeMessageJsonToolCall(text)?.toolName ?? null
  if (toolName === null) return null
  if (toolName === 'channel_reply') return 'reply'
  if (toolName === 'channel_send') return 'send'
  // `skip_response` already got what it wanted once suppressed (silence), so
  // warning would be noise. Every other leaked call dropped a real action or
  // reply, so nudge the model to redo it properly.
  return toolName === SKIP_RESPONSE_TOOL_NAME ? 'suppress-silent' : 'suppress-warn'
}

export function isLikelyPlainTextChannelToolCall(text: string): boolean {
  return getPlainTextChannelToolCallKind(text) !== null
}

// Bracket-aware parser: returns the called tool's name when the ENTIRE trimmed
// text is a single call expression `identifier(...)` — empty args `()` or a
// single object-literal `({ ... })` — with nothing but optional whitespace and
// a trailing `;` after the closing paren. Returns null for anything else, which
// is what keeps prose safe: `read({...}) loads a file` has trailing text, and
// `bash` alone (no parens) is a bare word, so neither is a call. A naive
// `^ident\(.*\)$` regex can't tell the closing paren of the arg object from a
// paren inside a quoted string, so this walks the string honoring quotes and
// brace/bracket/paren depth.
export function isWholeMessageToolCall(text: string): string | null {
  const trimmed = text.trim()
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed)
  if (nameMatch === null) return null
  const name = nameMatch[1]!

  let i = nameMatch[0].length - 1
  let depth = 0
  for (; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(trimmed, i, ch)
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++
      continue
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) break
      continue
    }
  }

  // Unbalanced (truncated mid-serialization) — still a leaked call, not prose.
  if (depth !== 0) return name

  const rest = trimmed.slice(i + 1).trim()
  if (rest === '' || rest === ';') return name
  return null
}

export type JsonToolCallLeak = { toolName: string; params: Record<string, unknown> }

const JSON_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Detects the JSON-RPC-object serialization of a leaked tool call — the sibling
// of `isWholeMessageToolCall`'s call-expression shape. Observed against
// `solar-open2` (Upstage) on channel deployments: the entire assistant message
// body is the object `{"method":"<tool>","params":{...}}`, optionally wrapped in
// a single ```json (or bare ```) fence, so the call-expression parser (which
// requires `identifier(`) never fires and the plumbing ships verbatim.
//
// The boundary is deliberately STRICT because a legitimate reply that IS this
// exact object is byte-for-byte indistinguishable from a leak — the tightest
// practical rule keeps that false positive to the narrowest possible shape:
//   1. the fenced-or-bare object is the ENTIRE trimmed message (nothing before
//      or after the single optional fence), parsed by strict `JSON.parse` so
//      truncated/malformed serializations are NOT treated as leaks;
//   2. the parsed value is a plain object whose own top-level keys are EXACTLY
//      `method` and `params` — a canonical JSON-RPC frame (`jsonrpc`/`id`) or a
//      user-requested JSON document carries extra keys and falls through;
//   3. `method` is a non-empty identifier-shaped string (the tool grammar), and
//      `params` is a non-null, non-array object.
// A match returns the tool name so the caller reuses the existing name->kind
// disposition (reply/send recover, skip_response silent, else warn).
export function parseWholeMessageJsonToolCall(text: string): JsonToolCallLeak | null {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const body = stripSingleWholeMessageJsonFence(normalized)
  if (body === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const keys = Object.keys(parsed)
  if (keys.length !== 2 || !keys.includes('method') || !keys.includes('params')) return null

  const record = parsed as Record<string, unknown>
  const method = record.method
  if (typeof method !== 'string' || !JSON_TOOL_NAME_RE.test(method)) return null

  const params = record.params
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null

  return { toolName: method, params: params as Record<string, unknown> }
}

// Unwraps a single whole-message ```` ``` ```` or ```` ```json ```` fence around
// a JSON object, returning the inner body, or the input unchanged when there is
// no fence. Returns null when a fence opens but the message is not JUST that one
// fenced block (leading/trailing prose, unterminated fence) so a fenced example
// embedded in prose is never mistaken for the whole-message shape. The opener is
// held to EXACTLY three backticks with an optional lowercase `json` info string —
// tilde fences, longer runs, and other language tags stay out of the boundary so
// the false-positive surface matches only the reported production shape.
function stripSingleWholeMessageJsonFence(trimmed: string): string | null {
  if (!trimmed.startsWith('```')) return trimmed

  const open = /^```(json)?\n/.exec(trimmed)
  if (open === null) return null
  const close = /\n```$/.exec(trimmed)
  if (close === null || close.index < open[0].length) return null
  return trimmed.slice(open[0].length, close.index)
}

export type TrailingToolCallLeak = { text: string; toolName: string; leakedCall: string }

// Catches the sibling leak that `isWholeMessageToolCall` cannot: the model wrote
// a REAL reply, then serialized a tool decision as a trailing block instead of
// emitting a real tool call. The production incident (Discord) was Korean prose,
// a blank line, then `skip_response({ reason: "..." })` — the whole-message
// parser saw prose before the call, returned null, and the plumbing shipped
// verbatim, confirming to probing users that it's a bot and exposing an internal
// tool name.
//
// The whole-message contract of `isWholeMessageToolCall` is deliberately NOT
// broadened: it stays "the entire message is a call" so a name-dependent
// disposition (reply/send recover, skip silent, else nudge) still applies to a
// message that is nothing but a call. This is the STRICTLY narrower sibling —
// "prose, THEN a trailing standalone call block" — with a prefix-first
// disposition: the prose is a legitimate reply the user must see, so we post it
// and drop only the trailing plumbing, regardless of which tool leaked. No
// arg-recovery, no nudge, no silent-turn ack — the prose already satisfied the
// turn.
//
// The false-positive surface is contained by three STRUCTURAL (language-agnostic,
// per the repo's multi-language rule) signals, none of which interpret prose:
//   1. a BLANK line must separate prefix from the trailing block — an adjacent
//      final line (`Explanation:\nskip_response()`) is left untouched, since a
//      model teaching a tool inline never blank-line-separates the example;
//   2. the trailing block must independently satisfy `isWholeMessageToolCall`
//      (bracket-aware, quote-honoring) — a bare `channel_react whenever…` word or
//      `read({...}) loads a file` mid-sentence is not a whole call;
//   3. the block must NOT begin inside a Markdown fenced code block — a fenced
//      ``` example ending in a call is legitimate teaching output.
// The prefix must stay non-empty after trimming, else this is the whole-message
// case and belongs to the existing parser.
//
// Multiple contiguous trailing call blocks are stripped iteratively (each must
// independently pass the predicate); the loop stops at the first non-call block.
export function stripTrailingLeakedToolCall(text: string): TrailingToolCallLeak | null {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  let body = normalized
  let outerToolName: string | null = null
  let outerLeakedCall = ''

  for (;;) {
    // Locate the final blank-line-separated block: <prefix>\n[ \t]*\n<candidate>,
    // where <candidate> is the trailing run with no interior blank line.
    const match = /\n[ \t]*\n([^\n]*(?:\n(?![ \t]*\n)[^\n]*)*)[ \t\n]*$/.exec(body)
    if (match === null) break
    const rawCandidate = match[1]!
    const candidate = rawCandidate.trim()
    if (candidate === '') break
    const prefix = body.slice(0, match.index)
    if (prefix.trim() === '') break

    // Classify BEFORE the fence check: a whole-message tool call can never itself
    // be a fence marker, which is what lets the fence scanner treat the
    // candidate's first line purely as a container-continuation signal.
    const toolName = isWholeMessageToolCall(candidate)
    if (toolName === null) break

    // The candidate's own first line decides whether it still continues an open
    // list/blockquote container: an unquoted or dedented candidate has LEFT the
    // container, so a container-owned fence no longer protects it.
    const candidateFirstLine = rawCandidate.split('\n', 1)[0]!
    if (startsInsideFencedCodeBlock(prefix, candidateFirstLine)) break

    if (outerToolName === null) {
      outerToolName = toolName
      outerLeakedCall = candidate
    }
    body = prefix
  }

  if (outerToolName === null) return null
  return { text: body.trimEnd(), toolName: outerToolName, leakedCall: outerLeakedCall }
}

// A fence carries the container requirements it was opened under. Both are
// independent: a `> - ``` ` opener requires BOTH a blockquote (`requiresQuote`)
// and the list content column, so leaving EITHER container abandons the fence.
// This captures at most one blockquote requirement + one post-blockquote list
// column — a bounded stack, not an arbitrary container parser.
type FenceOwner = { requiresQuote: boolean; listContentColumn: number | null }
type OpenFence = { char: '`' | '~'; len: number; owner: FenceOwner }

// Best-effort fenced-code detection for the trailing-tool-call safety guard.
// Returns true when the candidate (whose first raw line is `candidateFirstLine`)
// sits inside a still-open Markdown fence — meaning the trailing call is fenced
// example content and must NOT be stripped.
//
// Top-level and blockquote-prefixed fences use normal opener/closer bookkeeping;
// list-marker-prefixed fences are recognized as OPENERS only. An open
// blockquote-owned fence is abandoned by an unquoted non-blank line, and an open
// list-owned fence by a non-blank line indented before the marker's recorded
// content column (see `abandonIfLeftContainer`). The candidate's OWN first line is
// run through the same abandon check last: an unquoted/dedented candidate has left
// its container, so a container-owned fence no longer protects it and the call is
// stripped. Blank lines never abandon; top-level fences are never abandoned, so a
// column-zero candidate under an ordinary open top-level fence stays protected.
//
// This deliberately approximates container continuity: a fence tracks at most one
// blockquote requirement plus one post-blockquote list content column (so a
// `> - ``` ` fence requires BOTH), while paragraph lazy continuation, exact
// CommonMark list padding, DEEPER nested stacks (list-in-list, quote-in-list-in-
// quote), and container re-entry are out of scope. The safety bias is toward "in a
// fence" (a missed close leaves a legitimate example unstripped, safer than
// stripping it), bounded by the container-exit rules so a real leak that has left
// its container is still caught.
function startsInsideFencedCodeBlock(prefix: string, candidateFirstLine: string): boolean {
  let open: OpenFence | null = null
  // The list item currently in effect (measured post-blockquote-strip), so a
  // fence that opens on a list item's CONTINUATION line — `- item`\n`  ``` `,
  // not the `- ``` ` marker line — inherits the item's content column and is
  // abandoned when a later line dedents out of it. Tracks its own quote
  // requirement so an unquoted line can't inherit a list started inside `> …`.
  let activeListItem: { contentColumn: number; requiresQuote: boolean } | null = null

  for (const rawLine of prefix.split('\n')) {
    open = abandonIfLeftContainer(open, rawLine)
    const { line, quoted } = stripBlockquoteMarkers(rawLine)

    // Maintain the active list item only outside a fence (fenced content must not
    // create list state): a marker line replaces it; a non-blank line that leaves
    // its quote context or dedents before its content column expires it; blank
    // lines preserve it.
    if (open === null) {
      const listItem = /^( {0,3})((?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(line)
      if (listItem !== null) {
        activeListItem = { contentColumn: columnWidth(listItem[1]! + listItem[2]!), requiresQuote: quoted }
      } else if (
        line.trim() !== '' &&
        activeListItem !== null &&
        (activeListItem.requiresQuote !== quoted || leadingIndentColumns(line) < activeListItem.contentColumn)
      ) {
        activeListItem = null
      }
    }

    const plainFence = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(line)
    if (plainFence !== null) {
      const indent = plainFence[1]!
      const run = plainFence[2]!
      const char = run[0] as '`' | '~'
      const rest = plainFence[3]!
      if (open === null) {
        if (char === '`' && rest.includes('`')) continue
        // A plain opener indented into the active list item inherits its content
        // column (continuation-line fence); a genuinely top-level opener keeps null.
        const listContentColumn =
          activeListItem !== null &&
          activeListItem.requiresQuote === quoted &&
          columnWidth(indent) >= activeListItem.contentColumn
            ? activeListItem.contentColumn
            : null
        open = { char, len: run.length, owner: { requiresQuote: quoted, listContentColumn } }
      } else if (char === open.char && run.length >= open.len && rest.trim() === '') {
        open = null
      }
      continue
    }

    // A list-marker-prefixed fence only ever OPENS; inside an open fence it is
    // fenced content, not a closer. It records BOTH requirements it was opened
    // under: the blockquote (`> - ``` `) and the list content column — the full
    // width of the marker prefix (`- `, `1. `, nested chains, post-quote-strip),
    // tabs expanded — so a later line that leaves EITHER has left the item.
    if (open !== null) continue
    const listFence = /^((?: {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)+) {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line)
    if (listFence === null) continue
    const markerPrefix = listFence[1]!
    const run = listFence[2]!
    const char = run[0] as '`' | '~'
    const rest = listFence[3]!
    if (char === '`' && rest.includes('`')) continue
    open = { char, len: run.length, owner: { requiresQuote: quoted, listContentColumn: columnWidth(markerPrefix) } }
  }
  // The candidate's own first line is the final container-continuation signal: an
  // unquoted (blockquote) or dedented (list) candidate has left the container, so
  // a container-owned fence no longer protects it. The candidate is never itself a
  // fence marker (it already passed isWholeMessageToolCall), so only the abandon
  // check applies here — no fence open/close bookkeeping.
  return abandonIfLeftContainer(open, candidateFirstLine) !== null
}

// Returns the fence with its owning container(s) still intact, or null when the
// given raw line has LEFT any required container: a fence that requires a
// blockquote is abandoned by an unquoted non-blank line, and a fence with a list
// content column is abandoned by a non-blank line indented before it. The two
// requirements are independent (OR), so a `> - ``` ` fence is abandoned by leaving
// EITHER the blockquote or the list. A fence with no requirements (top-level) and
// blank lines never abandon.
function abandonIfLeftContainer(open: OpenFence | null, rawLine: string): OpenFence | null {
  if (open === null) return null
  const { line, quoted } = stripBlockquoteMarkers(rawLine)
  if (line.trim() === '') return open
  if (open.owner.requiresQuote && !quoted) return null
  if (open.owner.listContentColumn !== null && leadingIndentColumns(line) < open.owner.listContentColumn) return null
  return open
}

// Removes one or more leading blockquote markers so a `> ```` fence participates
// in bookkeeping as if unquoted, and reports whether the line was quoted so the
// caller can detect the blockquote-exit that abandons a blockquote-owned fence.
function stripBlockquoteMarkers(line: string): { line: string; quoted: boolean } {
  const match = /^(?: {0,3}>[ \t]?)+(.*)$/.exec(line)
  return match === null ? { line, quoted: false } : { line: match[1]!, quoted: true }
}

// Leading-indent width in columns (whitespace only, stopping at the first
// non-space), expanding tabs to the next 4-column stop. Used to compare a later
// line's indentation against a list item's content column.
function leadingIndentColumns(line: string): number {
  let column = 0
  for (const char of line) {
    if (char === ' ') column += 1
    else if (char === '\t') column += 4 - (column % 4)
    else break
  }
  return column
}

// Full display width of a string in columns, expanding tabs to the next 4-column
// stop. Used to measure a list marker prefix so the content column lands after it.
function columnWidth(s: string): number {
  let column = 0
  for (const char of s) column += char === '\t' ? 4 - (column % 4) : 1
  return column
}

// Tolerant single-purpose scanner that pulls the `text` argument out of a
// plain-text-serialized `channel_reply(...)` / `channel_send(...)` leak. A
// single regex covering every shape (double/single/unquoted keys, escaped
// quotes, mid-serialization truncation) is fragile, so this walks the string
// once and extracts only the first string-valued `text` property. `channel_send`
// also carries `adapter`/`chat`/`thread`, which are intentionally ignored —
// recovery always routes back through the current channel, never a
// model-supplied destination. Returns null when no recoverable, non-empty
// `text` value is present so the caller can fall back to suppression.
export function extractPlainTextChannelToolCallText(text: string): string | null {
  const jsonCall = parseWholeMessageJsonToolCall(text)
  if (jsonCall !== null) {
    if (jsonCall.toolName !== 'channel_reply' && jsonCall.toolName !== 'channel_send') return null
    if (!Object.hasOwn(jsonCall.params, 'text')) return null
    const value = jsonCall.params.text
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  }

  const trimmed = text.trim()
  if (!/^(?:channel_reply|channel_send)\s*\(/.test(trimmed)) return null

  // Walk the serialization once, honoring a `text` key only at the top level of
  // the argument object (braceDepth 1, outside any array). Two failure classes
  // motivate the bookkeeping: a `text:` inside an earlier quoted value, e.g.
  // `channel_send({ reason: "see text: here", text: "real" })`, and a `text:`
  // inside a *nested* object, e.g. `channel_reply({ meta: { text: "x" }, text:
  // "real" })`. Skipping string literals defeats the first; tracking
  // brace/bracket depth and matching keys only at top level defeats the second.
  // Either way the scanner lands on the real reply instead of leaking the wrong
  // value or dropping the message.
  let braceDepth = 0
  let bracketDepth = 0
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!

    if (ch === '"' || ch === "'") {
      i = skipStringLiteral(trimmed, i, ch)
      continue
    }

    if (ch === '{') {
      braceDepth++
      if (braceDepth === 1 && bracketDepth === 0) {
        const value = readTextKeyValueAt(trimmed, i + 1)
        if (value !== undefined) return value
      }
      continue
    }
    if (ch === '}') {
      if (braceDepth > 0) braceDepth--
      continue
    }
    if (ch === '[') {
      bracketDepth++
      continue
    }
    if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--
      continue
    }

    if (ch === ',' && braceDepth === 1 && bracketDepth === 0) {
      const value = readTextKeyValueAt(trimmed, i + 1)
      if (value !== undefined) return value
    }
  }

  return null
}

// Returns the recovered value (string or null) when a `text` key starts at
// `from`, or undefined when no `text` key is present there so the scanner keeps
// walking. The null/undefined split lets a malformed `text` value short-circuit
// to suppression while a non-`text` delimiter is simply skipped.
function readTextKeyValueAt(s: string, from: number): string | null | undefined {
  const afterKey = matchTextKey(s, from)
  if (afterKey === null) return undefined

  const quote = s[afterKey]
  if (quote !== '"' && quote !== "'") return null
  return readStringValue(s, afterKey + 1, quote)
}

// Returns the closing-quote index, or the last index when the literal is
// truncated, so the caller's `i++` resumes past the consumed string.
function skipStringLiteral(s: string, openIdx: number, quote: string): number {
  let escaped = false
  for (let i = openIdx + 1; i < s.length; i++) {
    const ch = s[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === quote) return i
  }
  return s.length
}

function matchTextKey(s: string, from: number): number | null {
  const m = /^\s*(?:"text"|'text'|text)\s*:\s*/.exec(s.slice(from))
  return m === null ? null : from + m[0].length
}

function readStringValue(s: string, from: number, quote: string): string | null {
  let value = ''
  let escaped = false
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!
    if (escaped) {
      value += ESCAPE_REPLACEMENTS[ch] ?? ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === quote) break
    value += ch
  }
  return value.trim().length > 0 ? value : null
}

const ESCAPE_REPLACEMENTS: Record<string, string> = { n: '\n', r: '\r', t: '\t' }

// Used by tests / external diagnostics.
export type { ChannelSessionRecord }
export { channelsSessionsPath }
