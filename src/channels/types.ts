import type { AdapterId } from './schema'

export type ChannelKey = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

// Inbound (non-text) media that the user attached to a channel message.
// The classifier produces these alongside `InboundMessage.text`; the router
// stores them and lets channel tools look them up by `id` so the agent can
// fetch / view a specific attachment without ever seeing the underlying
// platform-side `ref` (URL, file id, CDN key) in its prompt context.
//
// Design contract:
// - `id` is a 1-based index that is stable WITHIN A SINGLE inbound message
//   and assigned by the adapter classifier. It is NOT globally unique —
//   different inbounds re-use small ids (1, 2, ...). The router's lookup
//   scopes the search to one (adapter,workspace,chat,thread) session and
//   returns the MOST RECENT match across that session's promptQueue +
//   contextBuffer, so within a single turn the agent always resolves
//   `attachment_id: 1` to the attachment on the current inbound — earlier
//   uses of id 1 from buffered context cannot intercept the lookup.
// - `ref` is the opaque platform handle that the adapter's
//   FetchAttachmentCallback knows how to download (Slack file id, Discord
//   CDN URL, KakaoCDN URL, Telegram file_id). It is INTENTIONALLY not
//   rendered into the user-visible prompt text — keeping it out of the
//   LLM's context prevents the dialect-confusion bug where the agent
//   pastes a malformed ref (e.g. a KakaoCDN bare key) into a tool.
// - The kind labels (photo/video/...) are coarse on purpose: they exist
//   for the prompt placeholder ("an image arrived") and for tool routing,
//   not for platform-specific behavior.
export type InboundAttachment = {
  id: number
  kind: 'photo' | 'video' | 'audio' | 'file' | 'sticker' | 'multiphoto' | 'embed'
  ref: string
  // Optional metadata that the adapter classifier may surface for the
  // placeholder rendering. Every field MUST be safe to print into a prompt
  // (no credentials, no long opaque tokens). If a piece of metadata would
  // leak fetchable state, leave it off and rely on `ref` instead.
  mimetype?: string
  filename?: string
  width?: number
  height?: number
  sizeBytes?: number
}

export type GithubReviewFollowupRound = {
  kind: 'push' | 'reply'
  roundId: string
  workspace: string
  prNumber: number
  headSha: string
  carrierThread: string | null
}

export type GithubReviewThreadCloseout = {
  workspace: string
  prNumber: number
  rootCommentId: string
  deferUntil?: { kind: 'review-state-unknown'; expiresAt: number }
}

export type InboundMessage = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  githubReviewRound?: GithubReviewFollowupRound
  // Adapter-authoritative obligation created only for a non-self reply whose
  // review-thread ROOT comment was authored by this agent. Kept separate from
  // replyToBotMessageId, which describes only the immediate parent.
  githubReviewThreadCloseout?: GithubReviewThreadCloseout
  // Structural "this message lives in a thread room" signal, kept SEPARATE
  // from `thread`. `thread` is a reply-routing field whose meaning differs per
  // platform: Slack puts the thread ts here (so `thread !== null` ⇒ thread
  // room), but Discord models a thread as its own channel — the thread's id is
  // in `chat` and `thread` stays null. The engagement gate and membership
  // scoping need "is this a thread room?" independent of routing, so adapters
  // set this explicitly. `parentChat` carries the parent channel id when the
  // adapter knows it, so membership can be scoped to the room (channel), not
  // the thread. Absent ⇒ not a thread room (or the adapter cannot tell).
  room?: { kind: 'thread'; parentChat?: string; parentChatName?: string }
  text: string
  // Prompt-only context for replied-to / quoted / linked messages. Kept out
  // of `text` so the engagement gate sees only the human-authored body.
  referenceContext?: InboundReferenceContext
  // Non-text attachments the user sent on this inbound. Empty / omitted
  // when the message is text-only. The router carries these through to
  // the live session's promptQueue/contextBuffer so channel tools can
  // resolve `attachment_id` → ref without the agent ever seeing the ref.
  attachments?: readonly InboundAttachment[]
  externalMessageId: string
  authorId: string
  authorName: string
  // Set true when the inbound is from another bot (NOT this typeclaw
  // instance's own bot identity — the adapter still drops self-authored
  // messages with `reason: 'self_author'`). The router treats peer bots
  // identically to humans for engagement, but uses this flag to drive a
  // bounded loop guard so two or more bots cannot ping-pong forever.
  authorIsBot: boolean
  isBotMention: boolean
  // Adapter-authoritative "this inbound is a bare ping — the mention IS the whole
  // message" signal. Set only by adapters whose visible `text` cannot reveal it:
  // Telegram renders a `text_mention` as the target's display NAME (not `<@id>`),
  // so the router's markup-stripping cannot tell a bare ping from real text. When
  // present the wake-request detector trusts it; when absent (Slack/Discord) the
  // router falls back to stripping the platform's mention markup from `text`.
  isBotMentionOnly?: boolean
  // When true, engagement treats this inbound as explicit-only: it skips
  // content-blind sticky credit AND plain-text alias matching, leaving only
  // structural DM / @mention / reply triggers. Used for GitHub PR review-thread
  // traffic so the bot observes review comments unless explicitly addressed.
  // Adapters that omit this keep the normal sticky + alias behavior.
  suppressSticky?: boolean
  replyToBotMessageId: string | null
  // True when the message contains at least one user mention AND none of
  // those mentions resolve to the bot. Used by the engagement layer to
  // suppress the solo-human fallback: if the human is explicitly tagging
  // someone else, the message almost certainly is not addressed to us.
  // False when the message has no mentions at all (the fallback still
  // applies in that case) or when one of the mentions IS the bot (which
  // is already handled by `isBotMention`). Adapters that cannot reliably
  // enumerate mentions MUST default this to false rather than true.
  mentionsOthers: boolean
  // Set to the parent message id when the inbound is a reply AND the
  // parent was authored by someone other than the bot (or by an unknown
  // author the adapter could not attribute). Mirrors `replyToBotMessageId`
  // but for the inverse case. Used by the engagement layer to suppress
  // the solo-human fallback on Discord-style replies that are clearly
  // directed at another user. Null when the message is not a reply, or
  // when the parent is the bot's own message (already covered by
  // `replyToBotMessageId`). Adapters that cannot determine the parent's
  // author MUST leave this null rather than guessing.
  replyToOtherMessageId: string | null
  isDm: boolean
  // Original platform-side timestamp in milliseconds since epoch. Sourced
  // from Slack's `event.ts` or Discord's `event.timestamp` (via the
  // adapter classifier), NOT the local time the router observed it. Zero
  // means "unknown" — the formatter renders such lines without a
  // timestamp prefix instead of stamping them with the wrong clock.
  ts: number
  // Platform-native anchor for showing a typing/status indicator, kept
  // SEPARATE from `thread` on purpose: `thread` drives reply threading,
  // this drives ONLY the typing surface. Slack's `assistant.threads.
  // setStatus` (the bot's only typing signal) requires a real message ts
  // even in a flat DM, where `thread` is null because replies stay top-
  // level. The classifier sets this to the inbound message ts for DMs so
  // the status can render without forcing the reply into a thread. Omitted
  // for non-DM inbounds, where the typing path falls back to `thread`.
  typingThread?: string
  // Opaque, adapter-owned handle for the entity an emoji reaction would
  // attach to. The classifier stamps it because only there is the platform-
  // side target type still known (GitHub: issue body vs issue-comment vs
  // pr-review-comment — all collapse to the same `chat`/`externalMessageId`
  // pair downstream). Mirrors the `InboundAttachment.ref` opaque-handle
  // pattern: ONLY the originating adapter's ReactionCallback knows how to
  // parse `value`; the router and tools treat it as a pass-through token and
  // never inspect it. Omitted when the inbound has no reactable target (e.g.
  // synthetic review-request inbounds, or adapters without reaction support).
  reactionRef?: ReactionRef
}

// Opaque reaction target handle. `adapter` lets the router refuse a ref to
// the wrong adapter's callback; `value` is an adapter-private encoding (for
// GitHub, a JSON blob distinguishing issue / issue-comment / pr-review-comment
// / discussion plus the numeric id). Never rendered into prompt context.
export type ReactionRef = {
  adapter: AdapterId
  value: string
}

// A request to add an emoji reaction to a previously-seen inbound. Distinct
// from OutboundMessage on purpose: reactions are best-effort side effects, not
// messages, so they bypass `send()`'s flood guard, per-turn send cap, exact-
// duplicate guard, sticky-credit grants, and typing heartbeat — all of which
// are message semantics that would misbehave on a reaction.
export type ReactionRequest = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
  reactionRef: ReactionRef
  // Bare emoji name, no surrounding colons (e.g. 'eyes', '+1'). Each adapter
  // maps this to its platform's reaction vocabulary and rejects unsupported
  // names via `code: 'unsupported'`.
  emoji: string
}

export type RemoveReactionRequest = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
  // Per-reaction-instance ref returned by ReactionResult.reactionRef from the
  // add request, not the inbound message target ref used by ReactionRequest.
  reactionRef: ReactionRef
}

export type ReactionErrorCode = 'permission-denied' | 'not-found' | 'unsupported' | 'rate-limited' | 'transient'

export type ReactionResult =
  // Optional success ref identifies THIS created reaction instance for later
  // removal, not the original message target. Adapters that cannot remove omit it.
  { ok: true; reactionRef?: ReactionRef } | { ok: false; error: string; code?: ReactionErrorCode }

export type ReactionCallback = (req: ReactionRequest) => Promise<ReactionResult>

export type RemoveReactionCallback = (req: RemoveReactionRequest) => Promise<ReactionResult>

// File on disk that the agent wants to attach to an outbound message. The
// agent runs inside a container with /agent bind-mounted from the host;
// `path` should be an absolute path the container can `readFile`. The
// optional `filename` overrides the basename of `path` when uploading
// (useful when the on-disk name carries a tempdir suffix the user
// shouldn't see in the chat). Adapters that cannot upload files MUST
// fail loudly via `SendResult.ok = false` rather than silently dropping
// the attachment.
export type OutboundAttachment = {
  path: string
  filename?: string
}

export type OutboundMessage = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
  // Optional when `attachments` is non-empty (file-only post is allowed).
  // Adapters that always need text (e.g. some webhook backends in the
  // future) must validate this themselves.
  text?: string
  // false suppresses URL previews where the adapter supports them; otherwise ignored.
  link_previews?: boolean
  // Each attachment is uploaded once. Order is preserved. For Slack, the
  // first attachment carries `text` as the file's `initial_comment` so
  // both arrive in a single API call; subsequent attachments are uploaded
  // bare. For Discord, attachments are uploaded first (no text) and then
  // `text` is posted as a separate message — Discord's upstream
  // `uploadFile` does not accept a content body or a thread id, see the
  // adapter for the workaround details.
  attachments?: OutboundAttachment[]
  // Typing-only anchor (see InboundMessage.typingThread), stamped by the
  // router from the live session so the adapter can CLEAR the status after a
  // flat DM send — where `thread` is null and would otherwise no-op the clear.
  typingThread?: string
  // Set by the router (native render mode + anchor fired) so an adapter can
  // reply to the inbound it answers. Telegram/Discord consume `externalMessageId`;
  // `quote`-mode adapters never see this (the router prepends the blockquote into
  // `text` instead). `source` lets an adapter whose native primitive can fail at
  // send time (KakaoTalk: payload built from a source message that may have
  // scrolled out of history) degrade to the same blockquote fallback.
  replyTo?: OutboundReplyTo
}

export type OutboundReplyTo = {
  externalMessageId: string
  source?: QuoteAnchorSource
}

// `adapter` selects the per-platform author-mention syntax in the blockquote
// fallback. Lives here (not router.ts) so adapters can reconstruct a native
// reply payload from the same shape the router renders quotes from.
export type QuoteAnchorSource = {
  adapter: AdapterId
  authorId: string
  authorName: string
  text: string
}

export type InboundReferenceContext = {
  kind: 'reply' | 'quote' | 'link'
  sources: readonly QuoteAnchorSource[]
}

export type SendErrorCode =
  | 'duplicate'
  | 'turn-cap'
  | 'outbound-flood'
  | 'no-adapter'
  | 'callback-rejected'
  | 'skip-locked'

// `messageId` is an adapter-reported id of a posted message (e.g. Slack `ts`,
// Discord snowflake, Telegram `message_id`, Webex/GitHub comment id). The
// optional `messageIds` lists reported posted-message ids in send order,
// including when a send is split; some adapters do not report attachment ids.
// `messageId` is adapter-selected, not necessarily the first post (KakaoTalk
// reports the text id after attachments). Neither field is universally a
// `thread` coordinate: Discord uses a thread channel id, Telegram a topic id,
// GitHub review replies a root comment id, and Slack replies keep the original
// thread root rather than their own new `ts`. Reuse existing conversation
// coordinates for follow-ups; a newly posted id can start a thread only when
// that adapter accepts a message id as `thread` (e.g. a top-level Slack post).
// Adapters with no reported ids omit the fields; missing ids are not an error.
// `reactionRef` is the outbound message's adapter-owned TARGET ref — the entity
// a later ReactionRequest reacts to. It is explicitly NOT the per-reaction
// removal-instance ref returned by `ReactionResult.reactionRef` after an add.
export type SendResult =
  | { ok: true; messageId?: string; messageIds?: readonly string[]; reactionRef?: ReactionRef }
  | { ok: false; error: string; code?: SendErrorCode }

export type OutboundCallback = (msg: OutboundMessage) => Promise<SendResult>

// A request to edit (replace the text of) a message the bot already posted.
// `messageId` is the platform-native id the send handed back as
// `SendResult.messageId` (Slack `ts`, Discord snowflake, Telegram `message_id`,
// Webex message id) — the same id shape an inbound carries as
// `externalMessageId`. `thread` is context only: none of the supported SDK edit
// calls require it (Slack/Discord/Telegram/Webex address the message by
// channel+id or room+id), so adapters may ignore it. Editing is opt-in per
// adapter — only adapters whose SDK exposes an edit primitive register a
// callback; the rest resolve to `code: 'not-supported'`.
export type EditMessageRequest = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
  messageId: string
  text: string
}

// `not-found` is an expected miss (message deleted, wrong id, or too old to
// edit) the tool surfaces as a soft error. `not-supported` means the adapter
// does not implement editing at all. `adapter-unavailable` means the adapter IS
// configured and DOES implement editing, but currently has no live callback
// (e.g. it failed to start), mirroring `getMessage`'s three-way distinction so
// the agent only sees the actionable re-auth hint when re-auth would help.
// `permission-denied` is a hard refusal from the platform (e.g. editing a
// message the bot does not own).
export type EditMessageResult =
  | { ok: true }
  | {
      ok: false
      error: string
      code?: 'not-found' | 'not-supported' | 'adapter-unavailable' | 'permission-denied'
    }

export type EditMessageCallback = (req: EditMessageRequest) => Promise<EditMessageResult>

export type TypingTarget = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread?: string | null
  // Typing-only anchor (see InboundMessage.typingThread). An adapter whose
  // typing surface needs a message ts even when `thread` is null (Slack DMs)
  // reads this first and falls back to `thread`. Never used for reply routing.
  typingThread?: string
  // 'tick' is the heartbeat fired during debouncing/generation; adapters
  // should set the indicator visible. 'stop' is fired exactly once when the
  // router decides the turn is over (drain finally, /stop command, or
  // teardown); adapters should explicitly clear the indicator if their
  // platform doesn't auto-expire it. Without 'stop', a 'tick' that lands
  // after the agent's final reply but before the drain returns will leave
  // the indicator on for Slack's full 2-minute server timeout.
  phase: 'tick' | 'stop'
}

export type TypingCallback = (target: TypingTarget) => Promise<void>

export type ResolvedChannelNames = {
  chatName?: string
  workspaceName?: string
}

export type ChannelNameResolver = (key: ChannelKey) => Promise<ResolvedChannelNames>

// The bot's OWN identity on a platform, surfaced into the channel system
// prompt so the model recognizes mentions of itself. The engagement gate
// already knows this id (it sets `isBotMention`), but the model only knows
// its NAME (from identity files) — not its platform user id. Without this,
// a message addressed to `<@U0ABFG8TYN7>` (the bot's own Slack id) reads to
// the model as "addressed to someone else" and it skips a turn it was
// correctly engaged for.
//
// - `id` is the raw platform user id (Slack `U…`, Discord snowflake,
//   Telegram numeric id as string, GitHub numeric id as string). For
//   angle-id platforms this is what appears inside `<@…>`.
// - `username` is the human-typed handle used for at-mentions on platforms
//   where the id is NOT what gets typed (Telegram `@username`, GitHub
//   `@login`). Omitted when the platform mentions by id, or when the
//   account simply has no username.
export type ChannelSelfIdentity = {
  id: string
  username?: string
}

// Resolves the bot's own identity for a given workspace. `workspace` is
// passed because identity is conceptually per-workspace (Slack team); most
// adapters serve a single identity and ignore the argument. Returns null
// when identity is not yet resolved (startup race) or unknown — callers
// MUST treat null as "omit the self-mention prompt line", never as an error.
export type ChannelSelfIdentityResolver = (workspace: string) => ChannelSelfIdentity | null

// History entries are intentionally distinct from InboundMessage:
// `InboundMessage` carries router-classification fields (`isBotMention`,
// `isDm`) that are turn-delivery concerns, not history concerns. History
// entries instead need `isBot` so the agent can tell its own past replies
// from user messages, and a sortable `ts` for chronological rendering.
export type ChannelHistoryMessage = {
  externalMessageId: string
  authorId: string
  authorName: string
  text: string
  referenceContext?: InboundReferenceContext
  attachments?: readonly InboundAttachment[]
  ts: number
  isBot: boolean
  replyToBotMessageId: string | null
}

export type FetchHistoryArgs = {
  chat: string
  thread: string | null
  limit: number
  cursor?: string
  // Set by best-effort callers (cold-start prefetch, membership fallback) to opt
  // into adapter-side rate-limit backpressure. Explicit reads (channel_history)
  // leave it unset so they always attempt the fetch under the router's timeout.
  prefetch?: boolean
}

export type FetchHistoryResult =
  | { ok: true; messages: ChannelHistoryMessage[]; nextCursor?: string }
  // `skipReason: 'rate-limited'` marks an expected, optional-context skip (the
  // adapter declined a best-effort read to avoid hammering a rate-limited
  // resource) so callers can log it at info instead of warn.
  | { ok: false; error: string; skipReason?: 'rate-limited' }

// Registered per-adapter on the ChannelRouter alongside outbound/typing
// callbacks. Adapters that cannot fetch history (e.g. webhook-only future
// adapters) simply do not register one; the router answers
// 'history-not-supported' for those, or 'history-adapter-unavailable' when the
// adapter is configured but failed to start (see setAdapterConfigured).
export type HistoryCallback = (args: FetchHistoryArgs) => Promise<FetchHistoryResult>

// Fetch a single message by its platform id from an arbitrary chat. Backs the
// `channel_read` tool's `mode: "message"`. `thread` narrows the lookup on
// platforms where a message id is only addressable within a thread (Slack
// thread replies); pass null for channel-root lookups. Reuses
// `ChannelHistoryMessage` as the result shape — a single message is just a
// one-element history with the same author/ts/isBot fields.
export type GetMessageArgs = {
  chat: string
  thread: string | null
  messageId: string
}

export type GetMessageResult =
  | { ok: true; message: ChannelHistoryMessage }
  // `code: 'not-found'` is an expected miss (deleted/wrong id) the tool surfaces
  // as a soft error; `code: 'not-supported'` means the adapter is not configured
  // at all; `code: 'adapter-unavailable'` means it IS configured but currently
  // has no live callback (e.g. failed to start), mirroring `fetchHistory`'s
  // 'message-get-adapter-unavailable' string contract; `code: 'adapter-error'`
  // means a live callback threw or timed out. That last one must never collapse
  // into 'not-supported' — a thrown 401 reported as "unsupported" teaches the
  // model the capability does not exist, and it will say so to a human.
  | { ok: false; error: string; code?: 'not-found' | 'not-supported' | 'adapter-unavailable' | 'adapter-error' }

export type MessageGetCallback = (args: GetMessageArgs) => Promise<GetMessageResult>

// One channel/chat the bot account can see, returned by `ListCallback`. `chat`
// is the id the agent passes back to `channel_read`/`channel_send`; `name` is a
// human label for the agent to recognize. `isMember` is best-effort — omitted
// when the adapter can't cheaply determine membership.
export type ChannelListEntry = {
  chat: string
  name: string
  kind: 'channel' | 'dm' | 'group' | 'thread'
  isMember?: boolean
}

export type ListChannelsArgs = {
  workspace: string
  limit: number
  cursor?: string
}

export type ListChannelsResult =
  | { ok: true; entries: ChannelListEntry[]; nextCursor?: string }
  | { ok: false; error: string; code?: 'not-supported' | 'adapter-unavailable' | 'adapter-error' }

// Backs the `channel_read` tool's `mode: "list"`. Opt-in per adapter like
// history; the router answers 'list-not-supported' when none is registered.
export type ListCallback = (args: ListChannelsArgs) => Promise<ListChannelsResult>

export type FetchAttachmentArgs = {
  ref: string
  filename?: string
  maxBytes?: number
}

export type FetchAttachmentResult =
  | { ok: true; buffer: Buffer; filename: string; mimetype?: string; size: number }
  | { ok: false; error: string }

export type FetchAttachmentCallback = (args: FetchAttachmentArgs) => Promise<FetchAttachmentResult>

// A request to resolve (close out) a review-comment thread the bot itself
// opened, after the author addressed it. Adapter-specific: only the github
// adapter registers a resolver today. The router carries the request through
// to that resolver, which is responsible for the platform-side authorship
// check — `resolveReviewThread` MUST only close a thread whose root comment
// the bot authored, never a human reviewer's thread. The address fields below
// are the same ones a `channel_reply` origin carries: `workspace` is the repo
// slug `owner/name`, `chat` is `pr:<N>`, and `rootCommentId` is the numeric id
// of the thread's root comment (the `thread` value the inbound carried).
export type ReviewThreadResolveRequest = {
  adapter: AdapterId
  workspace: string
  chat: string
  rootCommentId: string
}

// `alreadyResolved` is a success-shaped no-op: the thread was closed before we
// got here (a duplicate turn, a manual resolve), so the desired end state holds,
// but the caller MUST NOT post a second close-out receipt. `not-author` is a
// hard refusal: the root comment is not the bot's, so resolving would erase a
// human's open question — the caller must NOT proceed as if it closed the loop.
//
// `no-match` is the ONLY non-blocking failure: the PR's threads listed cleanly
// but none is rooted at this comment (already deleted, or the wrong target),
// so there is genuinely nothing to close and an acknowledgement may still post.
// Every other code is a hard failure — `not-found` here means an HTTP 404 from
// the API (a real problem, e.g. wrong repo/PR), NOT "no such thread"; a caller
// must treat it as blocking so it never claims a thread is settled on a failed
// or misdirected lookup.
export type ReviewThreadResolveResult =
  | { ok: true; alreadyResolved?: boolean }
  | {
      ok: false
      error: string
      code?: 'not-author' | 'no-match' | 'not-found' | 'unsupported' | 'permission-denied' | 'transient'
    }

// Registered per-adapter on the ChannelRouter, last-write-wins like the
// self-identity resolver (one bot account per adapter). Adapters that do not
// support review threads never register one; the router answers `unsupported`.
export type ReviewThreadResolver = (req: ReviewThreadResolveRequest) => Promise<ReviewThreadResolveResult>

// A query for "does the bot still owe this PR a verdict?" — i.e. is the bot's
// latest formal review on the PR a sticky CHANGES_REQUESTED that no later
// APPROVE/dismissal has cleared. Used by the re-review stranding guard to stop
// the bot from resolving a thread / posting a close-out ack while it still
// holds a blocking review (the PR #644 failure: thread resolved + chat ack, but
// reviewDecision stuck at CHANGES_REQUESTED because neither carries review
// state). `workspace` is the repo slug `owner/name`; `chat` is `pr:<N>`.
export type ReviewStateRequest = {
  adapter: AdapterId
  workspace: string
  chat: string
}

// `selfBlocking` is the answer the guard acts on for re-reviews: true means the
// bot's latest effective formal review is its own CHANGES_REQUESTED (COMMENTED
// reviews are ignored — they never clear the sticky block, GitHub's own rule).
// `reviewDecision` is GitHub's aggregate PR review status when GraphQL can
// provide it; REVIEW_REQUIRED means an approval-shaped flat comment would still
// leave the PR awaiting a formal review. `approve` mirrors
// `channels.github.review.approve` so the guard's denial text can tell the model
// whether to land a fresh APPROVE or to DISMISS its prior review.
//
// On `ok: false` the caller MUST fail closed: an unverifiable review state is
// treated like a live block, so the bot never claims close-out when the runtime
// could not confirm the platform-side verdict.
export type ReviewStateResult =
  | {
      ok: true
      selfBlocking: boolean
      selfBlockingReviewId: number | null
      approve: boolean
      reviewDecision?: GithubReviewDecision
    }
  | { ok: false; error: string; code?: 'unsupported' | 'not-found' | 'permission-denied' | 'transient' }

export type GithubReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'

// Registered per-adapter on the ChannelRouter, last-write-wins like the
// review-thread resolver. Adapters that never register one make `getReviewState`
// answer `unsupported`.
export type ReviewStateResolver = (req: ReviewStateRequest) => Promise<ReviewStateResult>

export type ReviewFinding = {
  path: string
  line: number
  side?: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
  body: string
}

export type SubmitReviewRequest = {
  adapter: AdapterId
  workspace: string
  chat: string
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body: string
  comments: ReviewFinding[]
  // The commit the review describes. When set, the submitter refuses to post
  // unless the PR head is still exactly this commit.
  expectedHeadSha?: string
}

export type SubmitReviewResult =
  | {
      ok: true
      reviewId: number
      state: string
      commitSha?: string
      downgraded?: boolean
      reanchored?: ReviewFinding[]
    }
  | { ok: false; error: string; code: SubmitReviewErrorCode; submitted?: boolean }

export type SubmitReviewErrorCode = 'unsupported' | 'permission-denied' | 'bad-anchor' | 'not-found' | 'transient'

export type ReviewSubmitter = (req: SubmitReviewRequest) => Promise<SubmitReviewResult>

export function channelKeyId(key: { adapter: string; workspace: string; chat: string; thread: string | null }): string {
  return `${key.adapter}:${key.workspace}:${key.chat}:${key.thread ?? ''}`
}
