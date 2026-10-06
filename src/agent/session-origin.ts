import { toRef } from '@/channels/adapters/webex-id-ref'
import { MEMBERSHIP_FRESHNESS_MS, type MembershipCount } from '@/channels/membership'
import type { AdapterId } from '@/channels/schema'
import type { ChannelSelfIdentity, GithubReviewFollowupRound, ReactionRef } from '@/channels/types'

export type ChannelParticipant = {
  authorId: string
  authorName: string
  firstMessageAt: number
  lastMessageAt: number
  messageCount: number
  // Optional with default false so persisted records from prior versions
  // load cleanly. The solo-human engagement fallback in `decideEngagement`
  // counts only `!isBot` participants, so a missing flag must read as
  // human (current behavior) — never as bot (would silently disable the
  // fallback for legacy channels).
  isBot?: boolean
}

export type ChannelOriginContext = {
  lastInboundAuthorId?: string
  participants?: readonly ChannelParticipant[]
}

export type SessionOrigin =
  | { kind: 'tui'; sessionId: string }
  | {
      kind: 'cron'
      jobId: string
      jobKind: 'prompt' | 'exec' | 'subagent' | 'handler'
      scheduledByRole?: string
      scheduledByOrigin?: SessionOrigin | { kind: 'config-file' }
    }
  | {
      kind: 'channel'
      adapter: AdapterId
      workspace: string
      workspaceName?: string
      chat: string
      chatName?: string
      thread: string | null
      githubReviewRound?: GithubReviewFollowupRound
      parentChat?: string
      parentChatName?: string
      lastInboundAuthorId?: string
      reactionRef?: ReactionRef
      participants?: readonly ChannelParticipant[]
      membership?: MembershipCount
      self?: ChannelSelfIdentity
    }
  | {
      kind: 'subagent'
      subagent: string
      parentSessionId: string
      spawnedByRole?: string
      spawnedByOrigin?: SessionOrigin
    }
  // Runtime-owned infrastructure operating over TypeClaw's own state (memory
  // logging/retrieval, backup), NOT user-delegated work. It resolves to `owner`
  // because it acts on the operator's behalf over operator-owned files, with no
  // single user session to inherit authority from — inheriting the triggering
  // turn's role (e.g. a guest channel turn) would wrongly classify TypeClaw
  // infrastructure as the guest actor and block its legitimate sessions//memory/
  // access. `triggeredBy` keeps honest provenance — "a guest turn triggered the
  // memory-logger" — without the synthetic-TUI lie. This kind is only ever
  // constructed by runtime/bundled code; inbound channel/cron content can never
  // produce it (those origins come from the runtime, not from message text), so
  // it is not a role-laundering vector.
  | {
      kind: 'system'
      component: string
      reason?: string
      triggeredBy?: SessionOrigin
    }

// Hard ceiling on the subagent delegation chain. Bounds chain LENGTH, not
// fan-out breadth: the deepest reachable chain is main (depth 0) →
// operator/reviewer (depth 1) → nested worker (depth 2). `spawn_subagent`
// refuses to spawn from a session already at this depth.
export const MAX_SUBAGENT_DEPTH = 2

// Counts subagent links from the root by walking the `spawnedByOrigin`
// ancestry. A non-subagent (or undefined) origin is depth 0; each nested
// subagent origin adds one. Fails CLOSED on ambiguous ancestry: if a subagent
// origin has no `spawnedByOrigin` (the serialized path in
// parseSpawnedByOriginJson drops it), the true depth is unknowable, so we
// return MAX_SUBAGENT_DEPTH rather than assume it sits at the root — a
// truncated grandchild must not read as a child and earn an extra spawn. A
// cyclic chain is bounded by the same cap.
export function subagentDepth(origin: SessionOrigin | undefined): number {
  let depth = 0
  let current: SessionOrigin | undefined = origin
  while (current !== undefined && current.kind === 'subagent') {
    depth += 1
    if (current.spawnedByOrigin === undefined) {
      return MAX_SUBAGENT_DEPTH
    }
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return depth
    }
    current = current.spawnedByOrigin
  }
  return depth
}

export const PARTICIPANTS_TOP_K = 10
export const PARTICIPANTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Each adapter renders mentions differently and the model has to copy the
// exact shape to actually notify a peer. Until this table existed, the
// channel origin block hardcoded Discord syntax (`<@USER_ID>`) for every
// non-Slack adapter, which silently misled KakaoTalk and Telegram sessions
// into emitting addressing tokens that the platform doesn't recognise. The
// participants block kept rendering `<@authorId> (name)` lines for the
// same reason — see `renderParticipants`.
//
// `mentionMode` semantics:
//   - 'angle-id'     — Slack/Discord: `<@USER_ID>` where USER_ID is the
//                      raw `authorId` we already surface in participants.
//   - 'at-username'  — Telegram: `@username` plain text. The numeric
//                      `authorId` is NOT what gets mentioned; usernames are
//                      a separate field that not every user has.
//   - 'alias'        — KakaoTalk: type the bot's alias as plain text. The
//                      adapter's classifier (`kakaotalk-classify.ts`) does
//                      a substring match against configured aliases; there
//                      is no in-band syntax to copy.
type PlatformInfo = {
  displayName: string
  mentionMode: 'angle-id' | 'at-username' | 'alias'
  // This platform has no rich-text rendering, so markdown markers appear
  // literally to users.
  plainTextOnly: boolean
  // Whether this adapter registers a ReactionCallback, i.e. whether
  // `channel_react` actually does anything here. Gates the proactive-reaction
  // prompt guidance so we never tell a KakaoTalk/Telegram agent to react when
  // the call would no-op. Keep in sync with the adapters that call
  // `router.registerReaction` (github, slack-bot, discord-bot today).
  supportsReactions: boolean
  // Whether this adapter's OutboundCallback accepts file attachments. Gates the
  // "ship a researcher report as a PDF by default" prompt guidance: a report is
  // only worth converting to a downloadable file on channels that can actually
  // receive one. GitHub's outbound callback hard-rejects attachments
  // (`github-bot-does-not-support-attachments` in adapters/github/outbound.ts),
  // so a PDF nudge there would train the model toward a call that always fails;
  // the other four upload files (Slack `uploadFile`, Discord `uploadFile`,
  // Telegram `sendDocument`, KakaoTalk `sendAttachment`). Keep in sync with the
  // adapters' outbound callbacks.
  supportsAttachments: boolean
}

const PLATFORM_INFO: Record<AdapterId, PlatformInfo> = {
  slack: {
    displayName: 'Slack',
    mentionMode: 'angle-id',
    plainTextOnly: false,
    supportsReactions: true,
    supportsAttachments: true,
  },
  'slack-bot': {
    displayName: 'Slack',
    mentionMode: 'angle-id',
    plainTextOnly: false,
    supportsReactions: true,
    supportsAttachments: true,
  },
  discord: {
    displayName: 'Discord',
    mentionMode: 'angle-id',
    plainTextOnly: false,
    supportsReactions: true,
    supportsAttachments: true,
  },
  'discord-bot': {
    displayName: 'Discord',
    mentionMode: 'angle-id',
    plainTextOnly: false,
    supportsReactions: true,
    supportsAttachments: true,
  },
  github: {
    displayName: 'GitHub',
    mentionMode: 'at-username',
    plainTextOnly: false,
    supportsReactions: true,
    supportsAttachments: false,
  },
  instagram: {
    displayName: 'Instagram',
    mentionMode: 'alias',
    plainTextOnly: true,
    supportsReactions: false,
    supportsAttachments: false,
  },
  'telegram-bot': {
    displayName: 'Telegram',
    mentionMode: 'at-username',
    plainTextOnly: false,
    supportsReactions: false,
    supportsAttachments: true,
  },
  webex: {
    displayName: 'Webex',
    mentionMode: 'angle-id',
    plainTextOnly: false,
    supportsReactions: false,
    supportsAttachments: true,
  },
  'webex-bot': {
    displayName: 'Webex',
    mentionMode: 'angle-id',
    plainTextOnly: false,
    supportsReactions: false,
    supportsAttachments: false,
  },
  teams: {
    displayName: 'Teams',
    mentionMode: 'alias',
    plainTextOnly: false,
    supportsReactions: false,
    supportsAttachments: false,
  },
  line: {
    displayName: 'LINE',
    mentionMode: 'alias',
    plainTextOnly: true,
    supportsReactions: false,
    supportsAttachments: false,
  },
  kakaotalk: {
    displayName: 'KakaoTalk',
    mentionMode: 'alias',
    plainTextOnly: true,
    supportsReactions: false,
    supportsAttachments: true,
  },
}

function getPlatformInfo(adapter: AdapterId): PlatformInfo {
  return PLATFORM_INFO[adapter]
}

// Compact description of the role the runtime resolved for this session at
// creation time. Rendered as a single block under the origin text for
// non-TUI sessions so the agent knows what it can and cannot do without
// having to call into the PermissionService itself. TUI is omitted because
// TUI is always `owner` by construction — annotating it would add noise to
// every interactive session for zero new information.
//
// Channel origins do NOT render this concrete role. A channel session is
// keyed by chat/thread, so the opener's role is wrong for every later
// speaker and printing their permission list leaks it into shared context.
// Channel origins render renderChannelRolePolicy() instead, and the
// authoritative per-turn role rides in the non-cacheable `<your-role>`
// turn anchor (renderTurnRoleAnchor in system-prompt.ts).
export type SessionRoleContext = {
  role: string
  permissions: readonly string[]
}

export function renderSessionOrigin(
  origin: SessionOrigin,
  now: number = Date.now(),
  roleContext?: SessionRoleContext,
): string {
  switch (origin.kind) {
    case 'tui':
      return withRoleContext(renderTuiOrigin(), roleContext, origin.kind)
    case 'cron':
      return withRoleContext(renderCronOrigin(origin), roleContext, origin.kind)
    case 'channel':
      return withRoleContext(renderChannelOrigin(origin, now), roleContext, origin.kind)
    case 'subagent':
      return withRoleContext(renderSubagentOrigin(origin), roleContext, origin.kind)
    case 'system':
      return withRoleContext(renderSystemOrigin(origin), roleContext, origin.kind)
  }
}

// Optional context for interactive sessions (TUI, channel, and origin-less
// sessions), appended by `composeSystemPrompt` in full mode only. It holds how
// to stay responsive and delegate — never permission, honesty, or filesystem
// rules, which live once in the shared policy every standard session gets.
// Deliberately separate from `renderSessionOrigin`: override loaders render
// origins too and must not inherit this context. The `spawn_subagent`
// parameter descriptions point at this heading and the
// [CONTEXT]/[GOAL]/[REQUEST] structure.
export function renderInteractiveSessionContext(subagentRoster: string): string {
  return [
    '## Subagent orchestration',
    '',
    'Keep the conversation responsive. Answer quick, single-shot requests inline. Delegate heavy, side-effectful, long-running, or multi-step work — installs, builds, `docker`, long test runs, refactors, a bug that resisted a quick fix — to a subagent (usually `operator`) instead of grinding through it here; use `tmux` only for long work that belongs in this session.',
    '',
    `Delegate with \`spawn_subagent\`, \`subagent_output\`, and \`subagent_cancel\`; each subagent has its own context and tools, and the tool description has the mechanics. Briefly: ${subagentRoster}.`,
    '',
    '- Spawns run in the background by default: a `<system-reminder>` arrives when the subagent completes — do not poll `subagent_output`. Pass `run_in_foreground: true` for a quick result you need this turn; deep-profile subagents always run in the background from here. In channel sessions a completion reminder is not a user message: surface the result via `channel_reply`/`channel_send`.',
    '- Broad search: spawn 2-5 `explorer`/`scout` workers in parallel, end your response, then collect each completion once. Use `scout` for narrow lookups and `researcher` for decomposed, multi-source, cross-validated synthesis. When the user *explicitly* asks to research or investigate, you MUST spawn `researcher`: answering from training memory or one inline `web_search` does not satisfy the request, and `scout`/`explorer` fan-out does not replace `researcher`.',
    '- Delegate-and-converse: for side-effectful or noisy work over ~30s, spawn one background subagent and stay responsive — `operator` for side effects, `scout` for a quick lookup, `researcher` for deep investigation, `planner` for risk-aware sequencing. Pass `profile: "deep"` only when the work needs stronger reasoning than the default tier.',
    '- Troubleshooting: after ~3 non-converging attempts at the same failure, stop and hand the loop to `operator` (background; `profile: "deep"` when genuinely hard) with the symptom, attempts, and success condition. Read `typeclaw-troubleshooting` before spawning.',
    "- Status: when asked about a running subagent, call `subagent_output({ task_id })` and report its `status_summary` — don't guess.",
    "- Don't fire more than 5 subagents per turn, spawn for known answers or single-file lookups, poll output in a loop, or ask research subagents to decide: they report; you decide. Most subagents are leaves; only `operator` and `reviewer` may delegate one level deeper.",
    '',
    'Spawn prompt structure (mandatory — the subagent does not see this conversation):',
    '',
    '```',
    "[CONTEXT]: What I'm working on, which files/modules are involved, what approach.",
    '[GOAL]: The specific decision or output I need to unlock.',
    '[REQUEST]: Concrete instructions — what to find/do/produce, what format, what to SKIP.',
    '```',
  ].join('\n')
}

function withRoleContext(block: string, ctx: SessionRoleContext | undefined, kind: SessionOrigin['kind']): string {
  if (ctx === undefined) return block
  const roleBlock = kind === 'channel' ? renderChannelRolePolicy() : renderRoleContext(ctx)
  return `${block}\n\n${roleBlock}`
}

function renderRoleContext(ctx: SessionRoleContext): string {
  const permList = ctx.permissions.length === 0 ? 'none' : ctx.permissions.map((p) => `\`${p}\``).join(', ')
  return [
    '## Your role in this session',
    '',
    `Role: \`${ctx.role}\`. Permissions: ${permList}.`,
    '',
    'This is the role the runtime resolved at session creation. Tool calls',
    'and channel admission are gated by these permissions; a `blocked:` or',
    '"denied by permissions" message means the current actor lacks the',
    'permission the guard was looking for. See the `typeclaw-permissions`',
    'skill for what each role can do and how to grant access.',
  ].join('\n')
}

// Channel sessions are keyed by chat/thread, not by author: one session can see
// many speakers with different roles. Rendering the opener's concrete role here
// would (1) be wrong for every later speaker and (2) leak the opener's full
// permission list into shared context. So channel origins get a cache-stable
// policy instead of a resolved identity; the authoritative per-turn role rides
// in the non-cacheable `<your-role>` turn anchor.
function renderChannelRolePolicy(): string {
  return [
    '## Your role in this session',
    '',
    'Channel sessions may include multiple speakers; never carry one speaker’s',
    'role onto later messages. The current speaker’s authoritative role is the',
    '`<your-role>` turn tag; absent tag = unconstrained default.',
    '',
    'Tool calls/channel admission are gated by that speaker’s permissions;',
    '`blocked:` or "denied by permissions" means they lack the needed grant.',
    'See `typeclaw-permissions` for role details.',
  ].join('\n')
}

function renderTuiOrigin(): string {
  return [
    '## Session origin',
    '',
    'You are running in the TUI session that the operator is currently',
    'attached to. Verbose explanations are welcome. The operator can see',
    'your tool calls and outputs in real time.',
  ].join('\n')
}

function renderCronOrigin(origin: { jobId: string; jobKind: 'prompt' | 'exec' | 'subagent' | 'handler' }): string {
  return [
    '## Session origin',
    '',
    'You are running an unattended cron job.',
    '',
    `- Job ID:   \`${origin.jobId}\``,
    `- Job kind: ${origin.jobKind}`,
    '',
    'No human is watching this turn. Produce side effects (e.g. via',
    '`channel_send`) where appropriate. Do not ask clarifying questions —',
    "the prompt has everything you should need. If you can't proceed, log",
    'your blockers and exit.',
  ].join('\n')
}

function renderSystemOrigin(origin: { component: string; reason?: string; triggeredBy?: SessionOrigin }): string {
  const lines = [
    '## Session origin',
    '',
    `You are the \`${origin.component}\` system process — TypeClaw-owned`,
    "infrastructure operating over the agent folder on the operator's behalf,",
    'not a user-delegated task. Do exactly the job described and exit.',
  ]
  if (origin.reason !== undefined) lines.push('', `Reason: ${origin.reason}`)
  if (origin.triggeredBy !== undefined) lines.push('', `Triggered by: ${describeTrigger(origin.triggeredBy)}`)
  return lines.join('\n')
}

function describeTrigger(origin: SessionOrigin): string {
  switch (origin.kind) {
    case 'tui':
      return 'a TUI session'
    case 'cron':
      return `cron job \`${origin.jobId}\``
    case 'channel':
      return `a ${getPlatformInfo(origin.adapter).displayName} channel turn`
    case 'subagent':
      return `the \`${origin.subagent}\` subagent`
    case 'system':
      return `the \`${origin.component}\` system process`
  }
}

function renderSubagentOrigin(origin: { subagent: string; parentSessionId: string }): string {
  return [
    '## Session origin',
    '',
    `You are a \`${origin.subagent}\` subagent spawned by parent session`,
    `\`${origin.parentSessionId}\`. Stay narrowly within the task you were given.`,
    'Return cleanly when done; do not sprawl into unrelated work.',
  ].join('\n')
}

function renderChannelOrigin(
  origin: {
    adapter: AdapterId
    workspace: string
    workspaceName?: string
    chat: string
    chatName?: string
    thread: string | null
    githubReviewRound?: GithubReviewFollowupRound
    reactionRef?: ReactionRef
    participants?: readonly ChannelParticipant[]
    membership?: MembershipCount
    self?: ChannelSelfIdentity
  },
  now: number,
): string {
  // The OBLIGATION-not-permission framing here exists because Kimi K2.5 Turbo
  // (and likely other models) will otherwise treat short / casual messages as
  // "ambient observation" and emit no tool call. Plain-text output from the
  // agent in a channel session is dead text — there is no human attached to
  // a stdout to read it. The only way to talk to the user is the tool. Making
  // that obligation crisp and pre-filling the addressing fields removed a
  // class of "model finishes silently, no reply ever lands" failures that we
  // could only see in the logs as `prompted` followed by no `outbound`.
  //
  // The original wording told the model to call channel_send and copy
  // adapter/workspace/chat/thread verbatim. Models still routinely dropped
  // `thread`, so the same conversation got bisected into a fresh top-level
  // thread on Slack. channel_reply now exists for that reason: it takes
  // only `text` and pulls addressing from this origin. We point the model at
  // it as the default, and keep channel_send as the escape hatch for posting
  // elsewhere (different chat, breaking out of the thread on purpose, etc.).
  const platformInfo = getPlatformInfo(origin.adapter)
  const lines: string[] = [
    '## Session origin',
    '',
    `You are responding inside a ${platformInfo.displayName} channel session. No human watches`,
    'a console here; communicate by tool call. Plain-text output is invisible.',
  ]

  // GitHub has no separate "chat" surface — channel_reply IS a public comment
  // on this PR/issue. Without saying so, models default to the Slack-style
  // two-surface split and post operator-facing meta-commentary ("Posted review
  // result for PR #511") straight into the PR thread, where it reads absurdly.
  if (origin.adapter === 'github') {
    lines.push(
      '',
      '**`channel_reply` posts a public comment directly on this PR/issue.**',
      'Write for that public audience: the answer/review summary itself, never',
      'operator status like "Posted review result for PR #N: …".',
      '',
      '**Do not post an "On it" acknowledgment comment.** The runtime already',
      'adds an :eyes: reaction on engage. For explicit ack use `channel_react`;',
      'reserve `channel_reply` for the substantive answer.',
      '',
      '**A formal review verdict already IS the comment — never post it twice.**',
      'A PR review (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`) renders as a PR',
      'comment. Put the verdict/praise/findings in that body, then do NOT echo',
      'it via `channel_reply`/`gh pr comment`; that is a visible duplicate.',
      'One verdict, one surface. After submitting the review, use',
      '`skip_response({ reason: "verdict posted as review" })`.',
      '',
      '**Never post your own coordination state.** Write only what a PR',
      'participant needs. Do not narrate carriers, review rounds, sessions,',
      'a verdict not yet being registered, or sticky review state.',
      '',
      'GitHub renders real Markdown; use it freely.',
      'The GitHub adapter cannot send file attachments.',
      'GitHub has no typing indicator.',
    )

    if (/^pr:\d+$/.test(origin.chat) && origin.githubReviewRound !== undefined) {
      const isCarrier = origin.thread === origin.githubReviewRound.carrierThread
      lines.push(
        '',
        isCarrier
          ? '**This session is the review-round carrier.** Perform one whole-PR re-review and post the verdict.'
          : '**This session is not the review-round carrier.** Do not spawn a reviewer, review, or publish findings. While waiting, the correct action is silence via `skip_response`; posting a "waiting for the verdict" or "I\'ll tidy this up later" status comment is a defect. When the verdict lands, close out only this thread in one message.',
      )
    }

    // Models reliably address review-comment feedback and then end the turn
    // WITHOUT resolving the thread — leaving a wall of "open" threads on the PR.
    // The `resolve_review_thread` flag lives only in the tool description, which
    // the model reads at call time and routinely skips. The resolve cannot run
    // in a later turn (a successful reply ends the turn), so a bare ack strands
    // the thread permanently. Gate on `thread`: a top-level PR/issue comment has
    // no thread to resolve, and the flag is a no-op there.
    if (origin.thread !== null) {
      lines.push(
        '',
        '**This is an inline review thread. When your reply acknowledges the',
        'concern is fixed/addressed, set `resolve_review_thread: true` on that',
        '`channel_reply` — in the SAME call.** A bare acknowledgement leaves the',
        'thread open forever: the resolve only runs as part of this reply, never',
        'in a later turn. It is safe to set by default — the runtime resolves',
        "only threads you authored and refuses on a human reviewer's thread.",
        'Leave it unset only when you mean to keep the thread open (partial fix,',
        'disagreement, mid-discussion).',
      )
    }
  }

  // Discord renders no GFM tables — a raw `| a | b |` block shows as literal
  // pipes. The discord-bot adapter rewrites BARE pipe tables into aligned
  // inline-code rows for readability, but it skips any table inside a ``` /
  // ~~~ fence (a fenced table is literal text by CommonMark). Models that have
  // "learned" Discord mangles tables defensively wrap them in a fence, which is
  // exactly what disables the auto-conversion — so the table renders ragged
  // anyway. Tell the model to emit tables bare and let the adapter format them.
  if (origin.adapter === 'discord-bot') {
    lines.push(
      '',
      '**Emit Markdown tables as bare `| a | b |` blocks — never inside a code',
      'fence.** Discord lacks table rendering; this session auto-reformats raw',
      'pipe tables into aligned columns, but fenced ```/~~~ tables stay literal.',
      'Use fences only for code/output meant to be verbatim.',
    )
  }

  if (platformInfo.plainTextOnly) {
    lines.push(
      '',
      'This platform renders messages as PLAIN TEXT with no rich-text formatting.',
      'Write plain text from the start.',
      'Do not use markdown bold/italics, `##` headings, `|` tables, fenced code',
      'blocks, inline-code backticks, or `[label](url)` links; they appear literally.',
      'Send bare URLs; the client auto-links them.',
      'No threads and no quoted replies; every message is top-level.',
      'Keep replies short and conversational for mobile reading: lead with a',
      'one-sentence summary, then at most a few short lines.',
      'If asked for something the platform cannot do, say so plainly.',
      platformInfo.supportsAttachments
        ? 'Attachments can be passed via `attachments[]` on `channel_send`/`channel_reply`.'
        : 'Outbound attachments and stickers are unsupported; send text or a link instead.',
      ...(platformInfo.supportsAttachments ? ['Outbound stickers/emoticons are not supported.'] : []),
    )
  }

  const conversationLine = renderConversationLine(origin)
  if (conversationLine !== null) lines.push('', conversationLine)

  // Gate on `reactionRef`, not just the static `supportsReactions` platform
  // fact: a turn only has a message to react to when the triggering inbound
  // carried one. Reminder-only turns (restart-resume, subagent-completion,
  // idle/todo continuation) wake the session with no inbound, so
  // `buildLiveOrigin` omits `reactionRef`. Prompting "react like a teammate"
  // there made the model call `channel_react`, which then denied with "this
  // conversation has no message to react to".
  if (platformInfo.supportsReactions && origin.reactionRef !== undefined) {
    lines.push(
      '',
      '**React like a teammate would.** `channel_react({ emoji })` adds only a',
      'reaction: `+1` approve, `rocket` shipping/exciting, `tada` celebrate,',
      '`heart` appreciate, `laugh` funny, `eyes` looking. Use it when it adds',
      'real signal, not every turn. The reaction is applied ONLY if you also',
      'reply to this message this turn; if you stay silent or `skip_response`,',
      'it is dropped — so never react to a message you are only observing and',
      'not answering. It does NOT satisfy the reply obligation; substantive',
      'answers still go through `channel_reply`.',
    )
  }

  lines.push(
    '',
    '**For every user message in this session, you MUST call `channel_reply`',
    '(or `channel_send`) at least once before ending your turn**, unless told',
    'to stay silent or there is nothing genuinely new. If silent, use:',
    '',
    '- **`skip_response({ reason })`** — preferred. Logs a short reason to',
    '  host logs (`typeclaw logs -f`) and sends nothing. Use for recorded',
    '  silence (duplicate/no new info/user asked for silence, etc.).',
    '  The contract is bidirectional: after calling `skip_response`, any',
    '  `channel_reply`/`channel_send` in the same turn will be rejected.',
    '  AND calling `skip_response` after a reply has already landed in this turn',
    '  will also be rejected. Commit to silence or commit to replying, not both.',
    '  Do not include secrets or long reasoning; keep it under one sentence.',
    '- **`NO_REPLY` text sentinel** — fallback. End with exactly `NO_REPLY`',
    '  and no channel tool call when `skip_response` is unavailable or not',
    '  worth logging. Any other visible text without a channel tool is blocked.',
    '',
    'Those silence only the CURRENT turn. To stop being pulled back into FUTURE turns:',
    '',
    '- **`channel_disengage()`** — drop "mid-conversation" stickiness for this',
    '  conversation. Call when someone asks you to be quiet / stop replying,',
    '  or when you are in a redundant loop. Afterward you re-engage',
    '  only when explicitly addressed again (mention, reply, or DM). It sends',
    '  no message and affects no other channel. ORDER MATTERS: to ack before',
    '  quieting, send that `channel_reply` FIRST, THEN call `channel_disengage`.',
    '  Pair with `skip_response` if staying silent this turn too.',
    '',
    '  **An explicit quiet command is a direct order to call this tool.**',
    '  Examples: "disengage", "be quiet", "stop replying", "stop", "back off",',
    '  "stay out of this", "shush", "조용" / "조용히 해" / "그만" / "빠져" /',
    '  "тихо" / "tais-toi" / "cállate" / "ruhig" / "黙って" / "安静". For any',
    '  clear stop request in any language, you MUST call `channel_disengage`.',
    '  An ack alone is not enough/does not disengage; it re-grants stickiness.',
    '  If acking, ack FIRST with `channel_reply`, THEN call `channel_disengage`;',
    '  otherwise call `channel_disengage` alone (optionally with `skip_response`).',
    '',
    '**Every user-facing sentence goes through `channel_reply`.** Narrating in',
    'plain text — "bumping to 16x now", "let me check that" — does NOT reach the',
    'user; it is invisible. If the user should see it, use `channel_reply`.',
    'This includes acks.',
    '',
    '**One substantive reply per inbound.** If the answer needs more than one',
    ...(origin.adapter === 'github'
      ? [
          'tool call, keep working and post the answer with a single final',
          '`channel_reply({ text, more_work_this_turn: false })`.',
          'Do not post an "On it" ack comment first — the runtime',
          'already added an :eyes: reaction; use `channel_react` for explicit ack.',
        ]
      : [
          'tool call, send a one-line ack first via `channel_reply({ text: "On it.",',
          'more_work_this_turn: true })`, keep working, then send the answer with a',
          'final `channel_reply({ text, more_work_this_turn: false })`.',
          'The ack is not your reply; the answer is. Once the answer lands, end your turn.',
          '`more_work_this_turn: true` is mandatory on the ack or the turn ends there',
          'and drops the fetch/subagent/actual answer.',
        ]),
    '',
    '**Backgrounded work does not end the obligation.** If you spawn a',
    'subagent in the background to answer the current inbound,',
    'you promised a reply you have not delivered. Do not skip: the system will',
    'not surface the result. When the subagent-completion `<system-reminder>` arrives,',
    'call `subagent_output` and send the result via `channel_reply`.',
    '`skip_response` (or `NO_REPLY`) is only legal on the post-result turn if',
    'there is nothing user-facing to share; prefer `skip_response` so the',
    'operator can see why it was dropped.',
    '',
    'Do not send a second reply just to rephrase, restate, or "confirm" what you already said.',
    '',
    'To reply here, call `channel_reply({ text, more_work_this_turn })`. Addressing (including the',
    `thread${origin.thread !== null ? '' : ' — none here, this is a channel-root session'}) is filled in; you don't need`,
    'to copy these fields:',
    '',
    '```json',
    '{',
    `  "adapter": ${JSON.stringify(origin.adapter)},`,
    `  "workspace": ${JSON.stringify(origin.workspace)},`,
    `  "chat": ${JSON.stringify(origin.chat)},`,
    origin.thread !== null ? `  "thread": ${JSON.stringify(origin.thread)}` : '  "thread": null',
    '}',
    '```',
    '',
    'To post somewhere else (different chat, leaving the thread, DM, etc.), use',
    '`channel_send` with explicit addressing. `allow` rules still apply (`{ ok: false }`).',
    '',
    ...renderResearchReportDeliveryGuidance(platformInfo),
    ...renderMentionGuidance(platformInfo, origin.participants ?? [], now, origin.self),
  )

  const participantsBlock = renderParticipants(origin.participants ?? [], platformInfo, now)
  const membershipLine = renderMembershipSummary(origin, now)
  if (membershipLine !== null) lines.push('', membershipLine)
  if (participantsBlock) lines.push('', participantsBlock)

  lines.push('', 'Be concise; chat clients punish multi-paragraph replies.')
  return lines.join('\n')
}

function renderMembershipSummary(
  origin: { adapter: AdapterId; workspace: string; membership?: MembershipCount },
  now: number,
): string | null {
  const membership = origin.membership
  if (membership === undefined) return null

  const total = membership.humans + membership.bots
  // Exact Discord counts are channel-scoped (filtered by who can VIEW_CHANNEL),
  // so the count is the channel's room, not the guild. The truncated branch is
  // history-derived recent speakers, which is not a channel-membership claim,
  // so the caveat would mislead there.
  const isExact = !membership.truncated && now - membership.fetchedAt < MEMBERSHIP_FRESHNESS_MS
  const caveat =
    isExact && origin.adapter === 'discord-bot' && origin.workspace !== '@dm'
      ? ' (This counts only members who can view this channel, not the whole guild.)'
      : ''
  if (isExact) {
    return `This channel has ${total} members: ${membership.humans} humans, ${membership.bots} bots.${caveat} The 10 most recent speakers are listed below.`
  }
  return `This channel has approximately ${total} members (about ${membership.humans} humans, ${membership.bots} bots; bot count approximate because the full member list exceeds the 50-member cap). The 10 most recent speakers are listed below.`
}

// The `researcher` subagent always hands back a markdown report file
// (`research-<slug>.md`) and is itself read-only — it cannot produce the PDF.
// Whoever delivers that report to a channel is the one who decides the format,
// and on a channel that accepts file uploads the right default for a multi-page
// research report is a downloadable PDF, not a wall of raw markdown dumped into
// chat. This block makes that the default ONLY where it is actionable: gated on
// `supportsAttachments` so GitHub (whose outbound callback rejects attachments)
// never gets a nudge toward a `channel_send` call that would fail.
function renderResearchReportDeliveryGuidance(platformInfo: PlatformInfo): string[] {
  if (!platformInfo.supportsAttachments) return []
  return [
    `**Ship explicit deliverables as PDFs.** ${platformInfo.displayName} accepts file`,
    'attachments. When the user clearly asks for a PDF/file/export/attachment, a standalone',
    'document/brief, or when a `researcher` subagent returns `research-<slug>.md` in',
    '`<report>`, render the markdown with `typeclaw-render-pdf` and deliver via',
    '`channel_send({ ..., attachments: [{ path, filename }] })` plus a 1–2 line',
    'summary. Do not treat the bare word "report" as enough: routine daily stats,',
    'user trends, status reports, and other operational updates should stay inline',
    'unless the user asks for a downloadable/exported artifact. A `researcher`',
    '`<summary>` is a teaser, NOT the deliverable. Never use an ad-hoc library',
    '(jsPDF, pdfkit, raw-text dump); it breaks markdown/CJK.',
    "For Korean/Japanese/Chinese, follow the skill's CJK guidance and never ship",
    'tofu boxes. Do not paste the full markdown into chat; do not attach the raw `.md`',
    'unless explicitly asked; inline text is right for routine updates.',
    '',
  ]
}

function renderMentionGuidance(
  platformInfo: PlatformInfo,
  participants: readonly ChannelParticipant[],
  now: number,
  self?: ChannelSelfIdentity,
): string[] {
  const cutoff = now - PARTICIPANTS_MAX_AGE_MS
  const fresh = [...participants]
    .filter((p) => p.lastMessageAt >= cutoff)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
  const peerBot = fresh.find((p) => p.isBot === true)
  const anyPeer = peerBot ?? fresh[0]
  const exampleId = anyPeer?.authorId ?? '123456789'
  const exampleName = anyPeer?.authorName ?? 'PeerBot'

  switch (platformInfo.mentionMode) {
    case 'angle-id':
      return [
        `To mention someone in your reply, use ${platformInfo.displayName} syntax \`<@USER_ID>\`.`,
        `For example, to address ${exampleName} in this conversation, write \`<@${exampleId}> hello\` —`,
        `**not** "${exampleName} hello". Plain-text names do not notify on ${platformInfo.displayName},`,
        'and peer bots will not treat the message as addressed to them.',
        ...renderSelfMention(platformInfo, self),
      ]
    case 'at-username':
      return [
        `To mention someone in your reply, use ${platformInfo.displayName} syntax \`@username\` in plain text.`,
        `${platformInfo.displayName} usernames are a SEPARATE field from \`authorId\`; \`<@id>\` tokens`,
        'in participants are inbound-only typeclaw markers, so do not echo them back as outbound mentions.',
        'If no `@username` is known, use display name; reply context carries it.',
        ...renderSelfMention(platformInfo, self),
      ]
    case 'alias':
      return [
        `${platformInfo.displayName} has no in-band mention syntax. To address someone, just type their display name as plain text;`,
        "the participants block shows display names. Users get the bot's attention with configured aliases,",
        'not copied tokens. Any `<@id>` marker is inbound-only typeclaw convention;',
        `do not echo them back as outbound mentions or ${platformInfo.displayName} renders them literally.`,
      ]
  }
}

// The model knows its NAME from identity files but not its platform user
// id, so a message addressed to its own id reads as "addressed to someone
// else" and it wrongly skips the turn (issue: skipped_by_tool "Message
// addressed to @U…, not to <name>"). This line closes that gap by stating
// the bot's own addressing token explicitly. Empty for the alias platform
// (KakaoTalk has no in-band mention token to recognize) and when identity
// has not resolved yet — both fall through to "omit the line".
function renderSelfMention(platformInfo: PlatformInfo, self: ChannelSelfIdentity | undefined): string[] {
  if (self === undefined) return []
  switch (platformInfo.mentionMode) {
    case 'angle-id': {
      const forms =
        platformInfo.displayName === 'Discord' ? `\`<@${self.id}>\` (also \`<@!${self.id}>\`)` : `\`<@${self.id}>\``
      return [
        '',
        `**You are ${forms} on this ${platformInfo.displayName} workspace.** When a message`,
        'contains your id, it is addressed to YOU — do not skip it as "addressed to another user".',
      ]
    }
    case 'at-username': {
      if (self.username === undefined || self.username === '') return []
      return [
        '',
        `**You are \`@${self.username}\` on ${platformInfo.displayName}.** A message mentioning`,
        `\`@${self.username}\` is addressed to YOU — treat it as self-mention.`,
      ]
    }
    case 'alias':
      return []
  }
}

const WEBEX_ADAPTERS = new Set<AdapterId>(['webex', 'webex-bot'])

function readableChannelId(adapter: AdapterId, id: string): string {
  return WEBEX_ADAPTERS.has(adapter) ? toRef(id) : id
}

function renderConversationLine(origin: {
  adapter: AdapterId
  workspace: string
  workspaceName?: string
  chat: string
  chatName?: string
}): string | null {
  const hasChat = origin.chatName !== undefined && origin.chatName !== ''
  const hasWorkspace = origin.workspaceName !== undefined && origin.workspaceName !== ''
  if (!hasChat && !hasWorkspace) return null

  const chatPrefix = origin.adapter === 'slack-bot' ? '#' : ''
  // The parenthetical/backtick id is a human-and-model disambiguator, NOT the
  // send target — tools source the canonical room id from the JSON origin block,
  // which stays raw. So decode webex base64 blobs to their readable ref here.
  const chatId = readableChannelId(origin.adapter, origin.chat)
  const workspaceId = readableChannelId(origin.adapter, origin.workspace)
  const chatLabel = hasChat ? `**${chatPrefix}${origin.chatName!}** (${chatId})` : `\`${chatId}\``
  const workspaceLabel = hasWorkspace ? `**${origin.workspaceName!}** (${workspaceId})` : `\`${workspaceId}\``

  return `Conversation: ${chatLabel} in ${workspaceLabel}.`
}

function renderParticipants(
  participants: readonly ChannelParticipant[],
  platformInfo: PlatformInfo,
  now: number,
): string {
  const cutoff = now - PARTICIPANTS_MAX_AGE_MS
  const fresh = participants.filter((p) => p.lastMessageAt >= cutoff)
  if (fresh.length === 0) return ''

  const top = [...fresh].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, PARTICIPANTS_TOP_K)

  const lines = ['## Recent participants (last 7 days, top 10 by recency)', '']
  for (const p of top) {
    const ago = formatAgo(now - p.lastMessageAt)
    const addressing = renderParticipantAddressing(p, platformInfo)
    lines.push(`- ${addressing} — last message: ${ago}, total: ${p.messageCount}`)
  }
  lines.push(
    '',
    'This list is **bounded**: only the 10 most recent authors from the last',
    '7 days. It is **not** the full guild member list or an audit log.',
    '',
    ...renderParticipantsTrailing(platformInfo),
  )
  return lines.join('\n')
}

// Per-line addressing token shown for each participant. The shape must match
// what the model will need to emit when addressing that participant, so the
// model can copy-paste the leading token verbatim. The previous unconditional
// `<@id> (name)` format trained the model toward angle-id syntax on every
// platform — correct for Discord/Slack, wrong for KakaoTalk (no in-band
// mention syntax) and Telegram (uses `@username`, where `authorId` is a
// numeric id and NOT the username). See issue #188.
//
// Symptom in the wild before PR #183 + this fix: Kiki addressing Momo as
// "Momo님" (plain text) on Discord, which never trips Momo's `isBotMention`
// check, so Momo observes silently and the conversation stalls. The
// angle-id branch here is exactly the fix for that case; the at-username
// and alias branches keep the platform contract honest for KakaoTalk and
// Telegram instead of self-contradicting the per-adapter mention guidance
// produced by `renderMentionGuidance`.
function renderParticipantAddressing(p: ChannelParticipant, platformInfo: PlatformInfo): string {
  switch (platformInfo.mentionMode) {
    case 'angle-id':
      return `<@${p.authorId}> (${p.authorName})`
    case 'at-username':
    case 'alias':
      return `${p.authorName} (${p.authorId})`
  }
}

// Closing prose for the participants block. Mirrors the per-platform branch
// in `renderParticipantAddressing` so the trailing "address them" guidance
// matches the format the bullet points just demonstrated. The previous
// unconditional `<@authorId>` prose was the second voice in the
// self-contradiction noted in issue #188 — it told KakaoTalk/Telegram
// sessions to address peers with a syntax `renderMentionGuidance` had
// just told them not to use.
function renderParticipantsTrailing(platformInfo: PlatformInfo): string[] {
  switch (platformInfo.mentionMode) {
    case 'angle-id':
      return [
        "If a current sender isn't listed, you can still address them —",
        '`<@authorId>` works for any author you have seen once. The list is',
        'recent-context convenience, not an exhaustive directory.',
      ]
    case 'at-username':
      return [
        "If a current sender isn't listed, address by `@username` when known.",
        `${platformInfo.displayName} usernames are a SEPARATE field from numeric \`authorId\`, and`,
        'not every user has one. The list is recent context, not a directory.',
      ]
    case 'alias':
      return [
        "If a current sender isn't listed, address by display name as plain text.",
        `${platformInfo.displayName} has no in-band mention syntax; \`authorId\` is reference only`,
        'and must not be echoed back. The list is recent context, not a directory.',
      ]
  }
}

function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} seconds ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const days = Math.round(hr / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
