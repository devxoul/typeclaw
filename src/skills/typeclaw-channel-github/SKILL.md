---
name: typeclaw-channel-github
description: Use this skill ALWAYS for PR review requests in any phrasing, including "requested your review on PR #N", "requested a review from team @… on PR #N", "@bot review this", "can you take a look at #123", "이 PR 리뷰해줘", and "리뷰 반영"; delegate reviews of other people's PRs to the `reviewer` subagent and post line-anchored findings with `post_github_review`. ALWAYS settle PR authorship first (triage #0): on a PR you opened, act as the CONTRIBUTOR/author, never review your own PR, use host-stage operator help only for checkout and PR creation, and perform eligible configured-remote pushes yourself through the broker. Also use this skill to resolve threads you authored with `resolve_review_thread`, create issues with model-driven `gh issue create`, or prepare host-stage PR creation/checkout and brokered push actions.
---

GitHub renders normal Markdown in issues, PRs, discussions, and review comments. Use headings, lists, tables, fenced code blocks, links, and inline code when they improve clarity.

- Do not send attachments on GitHub chats; the adapter rejects them.
- There is no typing indicator.
- For PR review threads, keep `thread` set to reply in-place. Omit `thread` for a top-level PR/issue comment.
- When a review comment **you authored** has been addressed, resolve its thread by replying with `channel_reply({ …, resolve_review_thread: true })` — see "Resolving review threads you authored" below. The base principle is **whoever opened the thread closes it**: you resolve only the threads you started, never a human's (the runtime enforces this).

## Mid-turn status replies need `more_work_this_turn: true`

A successful `channel_reply` ends your turn by default — the runtime stops the model right after the reply lands. That is correct for a final answer, but it will **silently truncate** a turn that still has work to do. If you post a status line like "Reviewing now, I'll be back with findings" and then expect to keep working (fetch the diff, spawn the reviewer, post the review) in the **same** turn, you must call `channel_reply({ text: "…", more_work_this_turn: true })`. Without `more_work_this_turn: true`, the turn ends at that status reply and the review never runs. Reserve `more_work_this_turn: true` for genuine multi-step turns; the final reply that wraps up the turn sets `more_work_this_turn: false`. The field is required — every `channel_reply` must set it explicitly, so never omit it.

## Inbound triage — do this first, every time

Before you pick an action, classify the inbound. Skipping this step is how a PR ends up with a "looks good" comment but no approval: the model pattern-matches on the prose ("they fixed it → resolve the thread") and never asks whether it owes the PR a formal review. Answer these in order; the **first** that matches decides your path. Do not skip ahead.

0. **Whose PR is this — mine or someone else's?** On any `pr:N` inbound, **before** you ask anything about reviewing, settle authorship. Fetch the author and compare it to your own login (`<your-login>`, your GitHub App login — typically `name[bot]`):

   ```sh
   gh pr view <N> --repo owner/repo --json author --jq '.author.login'
   ```

- **The PR author is you (`<your-login>`).** You are the **contributor/author** on this PR, not its reviewer. Feedback on it — a review, a "리뷰 반영 부탁드려요" / "address the review" / "please apply the feedback" / "fixed?" comment, a `CHANGES_REQUESTED` someone else left — is yours to **address as the author**: read it, ask the operator for the required host-stage checkout, change and commit the code, push the configured remote yourself through an eligible broker credential, and reply. Go to the **contributor flow** ("When the PR is yours"). **You never review your own PR**, and you never spawn the `reviewer` subagent on it — GitHub does not even let an author formally review their own PR, so an attempt produces a self-addressed "review" comment, which is the exact persona-confusion bug to avoid. Gates 1–2 below (review obligations / review requests) describe the _reviewer_ persona and **do not apply when the PR is yours** — skip straight to the contributor flow.
  - **The PR author is someone else.** You may be its reviewer. Continue to gate 1.

  This gate is first because everything after it assumes the reviewer persona. "Address the review" sounds identical whether you wrote the PR or someone else did; only the author check disambiguates, and getting it wrong is what makes the agent review its own work.

1. **(Someone else's PR.) Do I have an unresolved blocking obligation on it?** On any `pr:N` inbound, before anything else, check whether you owe this PR a verdict you have not yet landed. Check **both** signals below — checking only formal review state misses the very failure this gate exists to catch, because a prior block may never have become formal state:
   - **Formal review state.** Run the step-1 re-review query in the PR review flow (`gh api --paginate --slurp /repos/owner/repo/pulls/<N>/reviews | jq -r '…'` filtered to `{CHANGES_REQUESTED, APPROVED}`). If your latest **blocking decision** is `CHANGES_REQUESTED`, you have a live sticky block.
   - **Flat-comment blockers you authored.** A prior "request changes" may have been posted as a plain PR/issue comment instead of a formal review — in which case **no `CHANGES_REQUESTED` row exists** and the query above returns empty even though you blocked the PR in prose. So also scan your own recent comments (`gh api /repos/owner/repo/issues/<N>/comments --jq '[.[] | select(.user.login == "<your-login>")]'`) for one that requested changes / raised blockers and has not since been superseded by a formal review or a clear retraction. For routing, a blocking comment you wrote is as binding as a formal `CHANGES_REQUESTED`. **A courtesy acknowledgement is not a retraction.** A reply you posted like "nice, that closes the hole" / "thanks, looks good" / "✅" does **not** supersede or retract a blocker you raised — it is a chat ack, not a verdict, and it carries no review state. The blocker stays binding until you land a **formal** `APPROVE`/`REQUEST_CHANGES` (or dismiss your prior review). So when an earlier "✅ thanks" of yours is the only thing between your blocker and the author's address-comment, the blocker is **still live** and this inbound is a re-review — do not let your own ack downgrade it.

   If **either** signal shows an unresolved blocker you raised, this inbound is a **re-review** — go to the **PR review flow** regardless of how it is phrased. An author commenting "fixed both issues" / "addressed your feedback" / "pushed a fix" is a re-review trigger, **not** a thread-resolve trigger. A re-review is closed by re-deciding the verdict and landing a **formal** review via `POST /pulls/<N>/reviews`: `APPROVE` clears a sticky `CHANGES_REQUESTED`; a comment or a flat reply clears neither a formal block nor a flat-comment blocker — it just strands the verdict again, which is the original bug.

2. **(Someone else's PR.) Am I being asked to review (first-time)?** Explicit `review_requested` inbound, or a human asking in plain language ("review this", "take a look at #N"). → **PR review flow** (see "When you are being asked to review").

3. **Is this a reply inside an inline review thread I authored** (`pr:N` with `thread` set, on a thread whose root comment is mine)? → verify the fix at head SHA and **resolve the thread** (see "Resolving review threads you authored"). `resolve_review_thread` only works when `thread` is set on the origin; if there is **no** `thread`, this branch does not apply — do not attempt it, fall through to the table below.

4. **None of the above** → use the routing table below.

> The decisive questions are **#0 then #1**. First settle authorship (#0): if the PR is yours you are the contributor and gates 1–2 do not apply — address the feedback, never review your own work. Only on someone else's PR does #1 govern: a blocking verdict you owe a PR is never discharged by a `channel_reply` or an `issue_comment` — neither carries review state, and neither clears a sticky `CHANGES_REQUESTED`. This applies to an **unresolved blocking obligation** (a live `CHANGES_REQUESTED`, or an unretracted blocker you raised in a flat comment), not to a stale `APPROVED` or a past non-blocking comment — those impose no closeout duty. When you do owe a block, the close-out is always a formal review via `POST /pulls/<N>/reviews`.

## What to do, by inbound type

Every GitHub inbound lands on a `chat` keyed by its subject: `issue:N`, `pr:N`, or `discussion:N`. **Run the triage above first.** Only if no triage branch matched do you pick an action from this table. The default action for anything addressed to you is a normal `channel_reply` in that thread; the **PR review flow** is the exception that requires delegation.

| Inbound                                                       | Looks like                                                                                           | What to do                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New issue** (`issue:N`)                                     | A freshly opened issue body.                                                                         | Triage or answer it. `channel_reply` on `issue:N`. Model-driven `gh issue create` may open a follow-up issue; prepare any follow-up PR for host-stage operator creation. |
| **Issue comment** (`issue:N`)                                 | A comment on an issue.                                                                               | Reply in the issue thread with `channel_reply`.                                                                                                                          |
| **PR conversation comment** (`pr:N`, no `thread`)             | A comment on a PR's main conversation (GitHub models PR comments as issue comments).                 | Reply on the PR with `channel_reply`. **If the text asks you to review → go to the PR review flow.**                                                                     |
| **PR review-thread reply** (`pr:N`, `thread` set)             | A reply on an existing inline review comment thread.                                                 | Stay in the thread: `channel_reply` with `thread` kept as-is. **If it addresses a comment you authored → verify and resolve the thread (below).**                        |
| **A submitted review** (`pr:N`)                               | Someone submitted a formal review (approve / changes / comment) on a PR.                             | **If the PR is yours (triage #0) → contributor flow:** address the feedback, then reply. Otherwise react if a response is warranted. `channel_reply` on `pr:N`.          |
| **Feedback on your own PR** (`pr:N`, author = `<your-login>`) | A review, a `CHANGES_REQUESTED`, or an "address the review / fixed?" comment on a PR **you** opened. | **Contributor flow** ("When the PR is yours"). Address the feedback as the author — never review or formally approve your own PR.                                        |
| **New discussion / discussion comment** (`discussion:N`)      | A discussion thread or a comment in one.                                                             | Reply with `channel_reply` on `discussion:N`.                                                                                                                            |
| **Review requested** (`pr:N`)                                 | See "When you are being asked to review" below.                                                      | **PR review flow.**                                                                                                                                                      |

### When the PR is yours — addressing review feedback (contributor)

Triage #0 sends you here whenever the `pr:N` was opened by **you** (`<your-login>`). On your own PR you wear the **author/contributor** hat, which is the mirror image of the reviewer flow below:

- **You do not review it.** Do **not** spawn the `reviewer` subagent, do **not** run `gh pr diff` to form a verdict, and do **not** call `POST /pulls/<N>/reviews` — GitHub forbids an author from formally reviewing their own PR, so the attempt degrades into a self-addressed "## Review … Concern 1/2" comment on your own work. That self-review is the precise bug this branch exists to prevent. The reviewer persona (spawn → `<review>` → formal verdict) is for **other people's** PRs only.
- **You address the feedback.** Read what the reviewer (human or bot) actually said. For each point: either change the code to fix it, or reply explaining why no change is needed. This is ordinary contributor work, not a review.

The flow:

1. **Read the feedback at the current head.** Pull the review comments and any `CHANGES_REQUESTED` summary so you know exactly what is being asked.

   ```sh
   gh pr view <N> --repo owner/repo --json reviews,comments,headRefOid --jq '{reviews: [.reviews[] | {author: .author.login, state, body}], head: .headRefOid}'
   gh api /repos/owner/repo/pulls/<N>/comments --jq '[.[] | {path, line, user: .user.login, body}]'
   ```

2. **Get the branch checked out, then push it yourself.** `gh pr checkout` is host-stage only — it may execute local hooks while carrying reusable credentials — so ask the operator to run it from the host-stage repository directory:

   ```sh
   gh pr checkout <N> --repo owner/repo
   ```

   After the operator confirms the checkout, make the minimal fixes and commit them locally with `typeclaw-git` hygiene. Pushing is **not** host-stage only when an eligible broker credential exists. Credential precedence is GitHub App, then an authorized PAT declared in `.env`, then the trusted GitHub CLI store. A configured GitHub remote can use the store fallback from any accessible repository path. The store accepts one configured destination and does not accept explicit-URL or `--set-upstream` pushes.

   ```sh
   git -C <checkout> push origin <branch>
   ```

Fix ordinary Git errors (missing upstream, stale ref, needs a rebase) yourself and retry. If the broker or your permissions refuse it — no eligible credential for the repo, or your role lacks the `gitExfil` bypass — surface that exact denial instead of claiming every push is host-stage.

Do **not** open a _new_ PR to fix your existing one; the push goes to the same branch so the open PR updates in place.

If a point is a genuine disagreement (the reviewer is mistaken, or the behavior is intentional), don't silently change it — reply in the thread with your reasoning instead.

3. **Reply to the feedback as the author.** After pushing, acknowledge each addressed thread with a normal `channel_reply` (keep `thread` set to stay in the inline thread; omit it for the PR conversation). Say what you changed ("Fixed — switched to the wiki-link form in `abc1234`") or why you didn't ("Left as-is — this path can't be null because …"). Keep it short.
   - **Do not resolve the threads.** On your own PR the open inline threads were authored by your **reviewer**, not by you — and the base principle is _whoever opened the thread closes it_. Resolving is the reviewer's call once they're satisfied; the runtime enforces this (it only lets you resolve threads whose root comment **you** authored). Push the fix, reply, and leave the thread for the reviewer to close.
   - **Do not post a verdict.** "LGTM", "Approved", "Request changes" are reviewer words. As the author you reply in plain prose; you never emit a review verdict on your own PR.

4. **If CI is failing on your PR**, that's also contributor work: read the failing check, fix the cause on the checked-out branch, commit locally, then push it yourself the same way. You can't always read another system's CI logs — if you can't, say so and ask for the error rather than guessing.

That's the whole contributor loop: read feedback → operator checks out at the host stage → fix and commit locally → push the branch yourself → reply. No subagent, no formal review, no thread resolution.

### When you are being asked to review

You are being asked to review a PR in **either** of these cases — treat them identically:

- **(A) An explicit review-request inbound.** The message text says **"requested your review on PR #N"** or **"requested a review from team @… on PR #N"**. (You do not need to know how it was triggered — the adapter synthesizes this same text whether a human requested you as a reviewer directly or requested a decoy user account that impersonates you as a GitHub App. From your side it reads the same. See [GitHub decoy reviewer](/docs/internals/github-decoy-reviewer).)
- **(B) A human asks you to review in plain language** in a PR/issue body or any comment — "@bot review this PR", "can you take a look at #123", "review the changes when you get a chance". There is no synthetic request text here; you recognize the intent from the message.

Both → run the **PR review flow**. Do not review inline yourself and do not just reply with prose impressions: delegate to the `reviewer` subagent so the analysis runs on the `deep` model, then post its findings as an inline review.

A `review_request_removed` inbound ("removed your review request on PR #N") is the inverse: the requester un-assigned you. Cancel any in-flight reviewer subagent (`subagent_cancel`) and do not post a partial review.

## PR review flow

The `reviewer` subagent is the analyst; you are the integration layer between its output and GitHub's review API. It loads the `code-review` skill on demand and returns line-anchored findings inside a `<review>` block. Your job is mechanics: spawn, wait, translate, post.

**The reviewer's `<review>` block is the only source of the verdict and the findings.** You do not review the PR yourself. Between spawning the reviewer and reading its result you do **no analysis of this PR** — do not run `gh pr diff`, do not read the changed files to form an opinion, do not draft a verdict. The reviewer runs on the `deep` model precisely so this judgment is not yours to make on the parent model. If you analyze the diff and post your own assessment while the reviewer is still running, you will post one verdict now and the reviewer's (often different) verdict when it completes — **two contradictory reviews on the same PR**, the exact failure this flow exists to prevent. Wait for the reviewer; post what it returns; nothing before that.

**Reply-triggered re-review carrier rule.** Obey the session-origin carrier status before delegating. If you are not the carrier, do not spawn a reviewer or publish findings anywhere; stay silent with `skip_response` while waiting, then close out only your own thread once the carrier's verdict lands. A "waiting for the verdict" status comment is process narration, not useful review feedback.

**HARD RULE — a review with actionable findings is a formal review, never a flat comment.** If the reviewer returns **one or more** actionable findings (`blocker`/`concern`/`nit`), the ONLY acceptable way to deliver them is a formal review via `POST /pulls/<N>/reviews` (step 4) — `REQUEST_CHANGES`, `COMMENT`, or `APPROVE` per the verdict, with the line-anchored findings in `comments[]`. You may **never** flatten those findings into a `channel_reply` or a top-level issue comment, **even when** the `gh api` call fails. A 422 means an anchor is wrong (almost always a `line` not in the diff): re-anchor it or move that one finding into the top-level review `body`, then resubmit the formal review — do **not** abandon the formal review and post prose instead. A flat "## Review … two blockers" comment is a bug, not a fallback: it strands the findings without line anchors and is the exact failure this rule exists to prevent. The flat/issue-comment path is reserved for the **zero-actionable-findings** branch only (see below). **Narrow exception:** when `post_github_review` finds that this bot's identical `CHANGES_REQUESTED` verdict is already effective, the tool itself converts the redundant submission into one substantive root PR comment while the existing formal block remains authoritative. This is a successful tool-managed fallback, not permission to replace a failed or invalid formal review manually. **That conversion fires at most once per pull request per head.** If another session already landed it — a sibling thread session of the same PR is the usual case — your call is denied outright instead, and the denial says the prior verdict is still live. That denial is final: the findings for this head have already been published by the sibling, so **stand down and close out only your own thread**. Do not re-post them as a `channel_reply`, a top-level comment, or a reply in your thread; the HARD RULE above applies with full force to this case. If you genuinely cannot land a formal review after fixing anchors, say so plainly and post nothing that claims a review happened — silence beats a false receipt.

1. **Minimal intake, then delegate immediately.** Capture only the repo, PR number, current head SHA, exact base OID, authorship, and the prior blocking context needed to identify a re-review. Do not inspect the diff or changed files. Batch the independent metadata/history reads where the tool interface permits.

   ```sh
   gh pr view <N> --repo owner/repo --json author,headRefOid,baseRefOid
   ```

   Then check for an **unresolved blocking obligation of yours** — this is what makes the current request a _re-review_ (the author pushed fixes after you previously blocked the PR). As in triage #1, a block can live in **two** places, and you must check both:

   ```sh
   # (a) formal review state
   gh api --paginate --slurp /repos/owner/repo/pulls/<N>/reviews | jq -r 'add | [.[] | select(.user.login == "<your-login>" and (.state == "CHANGES_REQUESTED" or .state == "APPROVED"))] | last | .state // empty'
   # (b) flat-comment blocker you authored (when (a) is empty)
   gh api --paginate /repos/owner/repo/issues/<N>/comments --jq '[.[] | select(.user.login == "<your-login>")]'
   ```

   If (a) prints `CHANGES_REQUESTED`, **or** (a) is empty but (b) surfaces a comment of yours that requested changes / raised blockers and has not since been superseded by a formal review or a clear retraction, treat the current request as a **re-review** and carry that fact — including which form the prior block took — into the spawn in step 2. Only when **neither** signal shows an unresolved block do you handle the request normally. (`<your-login>` is your GitHub App login, typically `name[bot]`.)

   Two things make the formal-review query load-bearing — both are bugs if you simplify it:
   - **Filter to _decision_ states, not the latest review row.** GitHub's sticky block is cleared only by a later `APPROVED` (or a dismissal) from the same reviewer — a later `COMMENTED` review does **not** clear it. So a history of `CHANGES_REQUESTED` → `COMMENTED` is _still blocked_, even though the latest row is `COMMENTED`. Selecting `last` over the raw review list would misread that as "not a re-review". Filtering to `{CHANGES_REQUESTED, APPROVED}` first, then taking `last`, asks the right question: "what is my latest _blocking decision_, ignoring non-deciding comments?" (Dismissed reviews surface as `state: "DISMISSED"`, so they're correctly excluded from the decision set too.)
   - **`--paginate --slurp` is mandatory.** GitHub returns reviews 30 per page; a bot on a long-lived PR can have its blocking `CHANGES_REQUESTED` past the first page. Without paginating, that review is invisible and a genuine re-review silently falls back to the plain-comment path. `--slurp` collects every page into one array of arrays; the `add` concatenates them before filtering. `gh` rejects `--slurp` combined with `--jq`, so the filter runs in a piped `jq` instead.

2. **Spawn the `reviewer` subagent with the PR target immediately after minimal intake.** The reviewer runs on the deep profile, so it always runs in the background — you stay responsive while it works. Pass the repo, PR number, captured head SHA, captured base OID, any re-review context, and any requester focus. Also pass the exact typed identity from step 1 as `review_identity: { repo: "owner/repo", pull_request: N, head_sha: "<40-char headRefOid>", base_sha: "<40-char baseRefOid>", review_kind: "review" }`; use `review_kind: "re-review"` when step 1 found an unresolved blocking obligation. This is runtime coalescing metadata, not prose: identical repo/PR/head/base/kind jobs within this parent session share one in-flight analysis, while a new head, different base, different kind, or different parent session stays independent. Never guess or parse these fields from the request text — source both `headRefOid` and `baseRefOid` from the values returned by `gh pr view`. Do not use a base branch name as identity. Do not run `gh pr diff`, read changed files, or otherwise pre-analyze first. The reviewer acquires its own context, loads the `code-review` skill, and returns a `<review>` block whose code findings carry `location="path:line"`.

   **If step 1 found an unresolved blocking obligation — a formal `CHANGES_REQUESTED` _or_ an unretracted flat-comment blocker — say so in the spawn payload** — e.g. _"This is a re-review: you previously blocked this PR (the prior blockers were …; the block was a formal `CHANGES_REQUESTED` / a flat PR comment). Verify they are resolved and return `approve` or `request-changes` — a re-review must re-decide the blocking state, not return `comment`."_ The reviewer's `code-review` skill enforces the same rule, but telling it the prior blockers (and which form they took) is what lets it apply that rule; a fresh reviewer session has no memory of your earlier block. The flat-comment case especially must be passed through — the reviewer cannot recover it from review state, so omitting it would silently drop the re-review context the moment the flow starts.

   Do **not** post an "on it" acknowledgement comment before spawning the reviewer — the runtime already adds an :eyes: reaction to the PR the moment it engages, so a "looking into this" comment is redundant noise. Just spawn the reviewer (it runs in the background); the formal review is your reply. If you want to acknowledge explicitly, use `channel_react({ emoji: "eyes" })`, which reacts without posting a comment.

   After spawning, **end your turn** — the background reviewer wakes you with a completion `<system-reminder>` (step 3). "Stay responsive" means you remain free to handle _other_ chats meanwhile; it does **not** license you to keep working _this_ PR. Do not poll `subagent_output` at all before completion, and do not fill the wait by reviewing the diff yourself. Only after that reminder may you fetch the result.

3. **On the completion `<system-reminder>`, first check you have not already posted — then** call `subagent_output({ task_id })` to read the reviewer's final assistant message.

   **One verdict per PR per request — guard this before you read or post anything.** The completion reminder is not a license to post; it is a wake-up. The very first thing you do on this turn is ask: have I **already posted a review or verdict on this PR during this engagement**? If yes, stop here — do not fetch the reviewer output, do not translate, do not post. Call `skip_response({ reason: "review already posted for this PR" })` and end the turn. Posting the reminder's result on top of a verdict you already shipped is how a PR ends up with two reviews — and if the two disagree (because the earlier one was your own premature take), it contradicts you in public. Only when no review has gone out yet do you proceed to read and post below — which is the normal path, since you waited for the reviewer instead of reviewing it yourself.

   With that confirmed, read the reviewer's final assistant message. The structured payload looks like:

   ```xml
   <review>
   <summary>...</summary>
   <findings>
     <finding severity="blocker|concern|nit|praise" location="path:line">
       <issue>...</issue>
       <evidence>...</evidence>
       <suggestion>...</suggestion>
     </finding>
   </findings>
   <verdict>approve | request-changes | comment</verdict>
   </review>
   ```

   **If the reviewer could not complete — do not go silent, and do not fabricate a verdict.** Two shapes signal an incomplete review: a `subagent_output` result of _"reviewer completed in Nms with no final message"_ (no `<review>` block at all), or a `<review>` whose `<verdict>` is the runtime sentinel **`incomplete-review-not-a-verdict`** — the honest fallback the runtime installs when the reviewer exhausted its retries without reaching a verdict (its `<summary>` opens with `INCOMPLETE REVIEW — NOT A VERDICT`). Both mean the analysis did not land; a real verdict was never reached. Handle them identically:
   - **This is NOT a real verdict — never map it to `APPROVE`/`REQUEST_CHANGES`/`COMMENT`.** In particular, the re-review override below (which upgrades a `comment` result to a decisive `approve`/`request-changes`) does **not** apply here: an incomplete review must never clear or re-assert a block, because no review actually happened. Leave existing review state untouched.
   - **Re-spawn the reviewer once** (step 2) with the same target — a fresh `deep` context usually completes; if it now returns a real `<review>` block, post it normally.
   - **If the re-spawn is still incomplete**, post a brief, honest `channel_reply` on the PR — e.g. _"리뷰를 자동 완료하지 못했어요 (reviewer returned no verdict). 다시 시도하거나 직접 확인이 필요합니다."_ — and remove your in-review label. An honest "couldn't complete the review" comment is the correct fallback; silence after you engaged, or a fabricated formal verdict, is not.

4. **Validate anchors proportionally, then translate into a `post_github_review` call.** Validate only the cited anchors needed for posting: confirm each actionable `path:line` belongs to the captured head/diff and that the cited text supports the finding. Batch independent anchor checks. Do not re-review the diff, inspect unrelated files, or second-guess the verdict; parent verification is proportional to the findings returned. Each `<finding>` with `severity` of `blocker`, `concern`, or `nit` and a valid `location="path:line"` becomes one entry in `comments[]`. Compose the inline `body` from the reviewer's `<issue>` + `<evidence>` + `<suggestion>` verbatim (modulo markdown). Findings whose `location` is `general` go into the top-level review `body`. **Skip `praise` findings when building `comments[]`**.

   **The verdict and the inline comments are independent. The verdict sets only the `event` field; it never decides whether you post `comments[]`.** Whenever there is at least one actionable finding (`blocker`/`concern`/`nit`) with a `location="path:line"`, you MUST submit a formal review via `POST /pulls/<N>/reviews` carrying those findings in `comments[]` — including when the verdict is `approve`. An `approve` with three nits is still a formal `APPROVE` review with three inline comments, **not** a plain approval and **not** a flattened summary. Collapsing inline findings into a single `channel_reply` or issue comment loses the line anchors the reviewer worked to produce.

   Map the reviewer's `<verdict>` to the GitHub `event`, and trust it — do not upgrade `comment` → `APPROVE` to seem agreeable, or downgrade `request-changes` → `COMMENT` to soften the tone:

   | Reviewer verdict  | GitHub `event`    |
   | ----------------- | ----------------- |
   | `approve`         | `APPROVE`         |
   | `request-changes` | `REQUEST_CHANGES` |
   | `comment`         | `COMMENT`         |

   **Operator approval policy.** If the inbound carries a note that PR approval is disabled (`channels.github.review.approve: false` — the adapter appends "Operator policy: PR approval is disabled for this agent" to the message), you must **not** submit an `APPROVE`. Map an `approve` verdict to `COMMENT` instead: post the same `<summary>` and all inline `comments[]` as a `COMMENT` review, just without the formal approval. `request-changes` and `comment` verdicts are unaffected (they never approve). Absent that note, approval is enabled and the table above applies unchanged.

   **Re-review.** On a reply-triggered re-review round, obey the session-origin carrier status. If you are **not** the carrier, do not spawn a reviewer or publish findings anywhere; stay silent with `skip_response` while waiting, then close out only your own thread in one participant-facing message once the carrier's verdict lands. Never narrate the carrier, round, session, verdict registration, or sticky state into the PR. If step 1 established this is a re-review (an unresolved blocking obligation of yours — a formal `CHANGES_REQUESTED` **or** an unretracted flat-comment blocker), the result MUST clear or re-assert that block. The only top-level-comment exception is the tool-managed duplicate fallback described above: the existing identical `CHANGES_REQUESTED` already re-asserts the formal block, so the new summary/findings may be added as one root comment without posting another blocking review — once per head. If a sibling session already landed that comment, your attempt is denied and the block stands re-asserted by both the formal review and the sibling's comment; discharge your obligation by closing out your own thread, not by publishing again. The clearing mechanics depend on which form the prior block took:
   - **Prior block was a formal `CHANGES_REQUESTED`.** It is sticky: **only** a fresh `APPROVE` from you, or a dismissal of your prior review, clears it. A plain issue comment does **not** clear it, and — critically — **neither does a `COMMENT` review.**
   - **Prior block was a flat comment** (no formal `CHANGES_REQUESTED` exists). There is no sticky GitHub state to clear, but the obligation is still yours to discharge as a **formal** review so the verdict finally lands as review state: submit `APPROVE` (resolved, approval enabled) or `REQUEST_CHANGES` (not resolved). Do not discharge a flat-comment block with another flat comment — that re-strands the verdict, the original bug.

   So even if the reviewer returns zero actionable findings, do **not** take the `comment` → top-level-comment branch below for a re-review. The reviewer's skill is instructed not to return `comment` on a re-review; if it does anyway despite a reachable diff, prefer `approve` when the prior blockers are visibly resolved in the diff, otherwise `request-changes` — and say which in your reasoning. **This override applies only to a real reviewer verdict — never to the incomplete-review fallback** (`<verdict>incomplete-review-not-a-verdict</verdict>`, or no `<review>` block at all): that is not a verdict and must never be upgraded to `approve`/`request-changes`, which would let a review that never ran clear or re-assert a block (see step 3's incomplete-review branch). Resolve the re-review by verdict:
   - **`request-changes`** — submit a fresh `REQUEST_CHANGES` review (re-asserts the block with the new findings). Straightforward.
   - **`approve`, approval enabled** — submit `APPROVE`. This clears the block.
   - **`approve`, approval disabled (`channels.github.review.approve: false`)** — you cannot `APPROVE`. How you close out depends on the prior block's form. **If the prior block was a flat comment** (no formal `CHANGES_REQUESTED`), there is no sticky state to clear: submit a `COMMENT` review carrying the `<summary>` so the verdict lands as review state, and you are done — nothing to dismiss. **If the prior block was a formal `CHANGES_REQUESTED`**, a `COMMENT` review will **not** clear the sticky block, so the PR would stay blocked by your stale review; clear it explicitly by **dismissing your own prior `CHANGES_REQUESTED` review**. Grab that review's `id` by re-running the step-1 formal-review query with the trailing filter changed from `| .state` to `| {state, id}` (same `select`), take the entry whose `state` is `CHANGES_REQUESTED`, then:

     ```sh
     gh api -X PUT /repos/owner/repo/pulls/<N>/reviews/<review_id>/dismissals -f message="Blockers resolved; dismissing my prior changes request per operator approval-disabled policy." -f event=DISMISS
     ```

     This transitions your review to `DISMISSED` and unblocks the PR without an approval. It needs the bot's installation to have **write** access (or to be on the branch's "who can dismiss reviews" list); if the dismissal returns 403, the block cannot be cleared under this policy — post the `<summary>` as a `COMMENT` review and say plainly in the body that the prior changes-request stands until a human dismisses it, rather than implying the PR is unblocked.

   Then submit the review with the first-class tool:

   ```json
   post_github_review({
     "event": "COMMENT",
     "body": "<reviewer's <summary> goes here>",
     "comments": [
       {
         "path": "src/foo.ts",
         "line": 42,
         "side": "RIGHT",
         "body": "<issue + evidence + suggestion from the reviewer's finding>"
       },
       { "path": "src/bar.ts", "line": 10, "side": "RIGHT", "body": "..." }
     ]
   })
   ```

   Anchor mechanics: `line` is a line number **in the file**, not a position in the diff. `side: RIGHT` is the new revision (default for additions); `side: LEFT` is the old revision (use for comments on removed lines). For multi-line comments, also set `start_line` and `start_side` (same semantics). Set `head_sha` to the full SHA the review covered (the `review_identity.head_sha` you gave the reviewer): the tool then refuses to post if the PR moved past that commit, and a follow-up round whose head moved requires it. If it is refused, re-review the current head before submitting. The tool resolves the head SHA, validates anchors against the complete PR diff, moves out-of-diff findings into the top-level body, enforces approval policy, and verifies the exact returned review id/state. Its successful receipt is proof that the output landed. A receipt with `details.fallback === "comment"` means the prior `CHANGES_REQUESTED` remains live and the new review content landed as one root PR comment; treat that as complete and do not add a `channel_reply`. On failure, fix the payload or policy issue and retry; never post a flat comment claiming the review succeeded.

5. **The decoy reviewer is dropped for you — no action needed.** Under **GitHub App** auth, the adapter automatically removes the decoy reviewer from the PR's requested-reviewers list the moment your formal review lands (it reacts to your own `pull_request_review.submitted` webhook). Why this matters: GitHub auto-adds **you** (the App account) to the PR's reviewers when your review posts, but the **decoy** account would otherwise stay pinned as a perpetual "review requested", as if the review never happened. You do **not** need to issue a `DELETE /requested_reviewers` yourself — and you should not, since it would race the adapter's own cleanup. The removal is self-loop-safe: the adapter's `DELETE` is authenticated as the App, so the `review_request_removed` webhook carries your bot actor (`slug[bot]`) as `sender`, which the classifier drops (see "Self-loop safety" below). This is a no-op under **PAT** auth (no decoy) and for **plain-language**/**team** requests (no decoy user was placed). See [GitHub decoy reviewer](/docs/internals/github-decoy-reviewer).

6. **End the turn with `skip_response`, not a trace reply.** The formal review or tool-managed duplicate fallback from step 4 already landed _in this PR_ — it carries the summary, verdict context, and findings. A `channel_reply` here does **not** go to a separate operator channel; on GitHub it posts another public comment on the same PR. A one-line "Posted review on PR #N: …" narrated into the PR thread is meta-commentary addressed to a phantom operator, and it reads absurdly next to the output it claims to point at. So once `post_github_review` confirms success, call `skip_response({ reason: "review posted via post_github_review" })` to close the turn silently. Only fall back to `channel_reply` when there was **no** review output to post — the zero-actionable-findings branch below uses `channel_reply` as the substantive reply.

### Zero actionable findings

A finding is "actionable" if its severity is `blocker`, `concern`, or `nit`. The inline-review post in step 4 applies whenever the actionable count is **at least one**. When the reviewer returns **exactly zero** actionable findings (only `praise`, or none), there is nothing to anchor inline — handle by verdict:

- `approve` → call `post_github_review({ event: "APPROVE", body: "<summary>" })`. **Post the `<summary>` verbatim — do not pad it back into a play-by-play.** The tool enforces approval policy and verifies the formal review. Never replace it with an "Approved"/"LGTM" `channel_reply`, which leaves GitHub awaiting a formal review.
- `comment` → post the summary as the substantive top-level PR reply with `channel_reply`. **Exception — re-reviews:** if an unresolved blocking obligation exists, a top-level comment discharges neither form of block. Use `post_github_review` to land a fresh formal verdict instead.
- `request-changes` → call `post_github_review({ event: "REQUEST_CHANGES", body: "<summary>" })`. This combination is rare; faithfully encode the reviewer's verdict.

The bundled `agent-browser` is **not** for PR reviews — `gh api` is faster and more reliable. Only use the browser when the API genuinely can't reach what you need.

## Resolving review threads you authored

A review you posted leaves inline comment threads open on the PR. When one of **your** threads is addressed — the author pushed a fix, or replied that they handled it — close it out by **resolving the thread**. Leaving it open after the concern is settled reads as if you never noticed; a resolved thread is the signal that the loop is closed.

**No process narration.** A PR participant needs the technical outcome, not your coordination machinery. While another carrier is working, stay silent with `skip_response`; do not post that you are waiting or will clean up later. Once actionable, use one participant-facing message: acknowledge and resolve if addressed, or state the specific technical reason it remains open.

**The base principle: whoever opened the thread closes it.** Resolve only threads whose root comment **you** authored. Never resolve a human reviewer's thread on your behalf — that erases their open question. The thread you can resolve is the one you started; the inbound that brings you here is a **review-thread reply on `pr:N` with `thread` set**, replying inside a thread you opened.

> **Thread cleanup is not the same as discharging a PR-level block.** Resolving an inline thread closes that one thread; it carries **no** review state and does **not** clear a PR-level blocking obligation (a sticky `CHANGES_REQUESTED`, or a flat blocker you authored on the PR conversation). Those are two separate duties. If triage #1 found a live PR-level block, that inbound is a **re-review** and the PR review flow wins over this section — you owe a formal `APPROVE`/`REQUEST_CHANGES`, and resolving threads (or a chat ✅) must **not** be your final response. Reach this section only for a thread-scoped reply on a PR where you owe no PR-level verdict (triage #1 came back clean). When in doubt, re-run triage #1 first.

### When a thread counts as addressed

Do not resolve on a bare "done" claim. A reply that says "fixed" is a prompt to check, not proof. Before resolving, **verify the fix at the PR's current head SHA**:

1. Re-read the PR head: `gh pr view <N> --repo owner/repo --json headRefOid` gives you the SHA the author's latest push landed on.
2. Read the lines your comment anchored to, at that SHA: `gh api /repos/owner/repo/contents/<path>?ref=<headRefOid>` (or `gh pr diff <N>` to see what the new push changed). Confirm the change actually addresses the concern your comment raised — not a different line, not a partial fix.
3. Only when the code at head genuinely resolves the finding do you resolve the thread. If the fix is partial or misses the point, **reply in the thread** explaining what's still open and leave it unresolved.

If the author merely **replied** without pushing (e.g. "this is intentional because …") and their reasoning settles it, that is also "addressed". If their reasoning does **not** settle it, keep the thread open and answer instead.

> **The verify and the resolve are one action, not two.** Once you've verified the fix, your acknowledgement reply **is** the close-out — carry `resolve_review_thread: true` on it. The common failure is posting a bare "Verified at \<sha\> — thanks, that addresses it" with the flag omitted: that reads as closed but leaves the thread **open**, because a successful reply ends your turn and the resolve can't happen in a later one. The flag is technically optional (nothing rejects a reply without it), but on an acknowledgement it is the only thing that actually closes the thread — so treat it as part of the acknowledgement, not an afterthought.

### How to resolve — `channel_reply({ resolve_review_thread: true })`

Once you have verified the fix, **acknowledge and resolve in one call**: pass `resolve_review_thread: true` to your `channel_reply`. The runtime resolves the thread you're replying in **before** it posts your acknowledgement, then posts the reply:

```
channel_reply({ text: "Verified — the fix addresses the concern. Thanks!", more_work_this_turn: false, resolve_review_thread: true })
```

This is the correct path and it removes a footgun. A bare `channel_reply` ends your turn the moment it lands, so a resolve attempted _after_ the acknowledgement would never run — the thread would stay open even though you "handled" it. The flag resolves first, so a normal final reply still closes the thread. You do **not** need `more_work_this_turn: true` for this: resolution happens inside the same call, before the turn ends.

Two guarantees make the flag safe to use as your default:

- **Author check is enforced in code.** The runtime only resolves a thread whose root comment **you** authored; a request to resolve a human reviewer's thread is refused, and the reply is **not** posted. You cannot accidentally close someone else's open question.
- **A failed resolve blocks the reply.** If the resolve fails (permission denied, wrong author, the fix doesn't verify on the API side), `channel_reply` is denied and posts nothing — so you never end up with a cheerful "looks resolved" comment sitting next to a still-open thread. Read the denial, fix the cause, and retry.

The flag is valid only on a github session replying inside a thread (`thread` set on the origin). It is ignored — and denied — elsewhere. If the thread is already resolved or already gone, the reply still posts (nothing left to close).

### Fallback — the raw `resolveReviewThread` GraphQL mutation

Prefer the flag above. Reach for the raw mutation only when you need to resolve a thread you are **not** currently replying in, or to debug. There is no REST endpoint for this. Resolution is a GraphQL mutation that takes the thread's **node id** (`PRRT_…`), not the comment's numeric id. Two steps: find the thread id, then resolve it.

1. **Find the node id of the thread you authored.** Query the PR's review threads and pick the one whose root comment is yours and matches the `thread` you're replying in:

   ```sh
   gh api graphql -R OWNER/REPO -f query='query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{databaseId author{login}}}}}}}}' -F owner=OWNER -F name=REPO -F number=N
   ```

   Match on the root comment: its `comments.nodes[0].databaseId` equals the root comment id (the `thread` value the inbound carried), and `author.login` is you. Skip threads already `isResolved: true`.

   **Paginate until you find the match — `first:100` is one page, not all threads.** A busy PR can carry more than 100 review threads, and yours may sit past the first page; stopping at page one would silently miss it and leave your thread open. Omit `-F after=…` on the first call, then while `pageInfo.hasNextPage` is true and you have not yet matched the `databaseId`, re-run the same query with `-F after=<endCursor>` from the previous page. Stop the moment the target thread is found (no need to walk the rest) or when `hasNextPage` is false (the thread is genuinely absent — don't fabricate a node id).

2. **Resolve it** with the node id from step 1:

   ```sh
   gh api graphql -R OWNER/REPO -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}' -F threadId=PRRT_xxx
   ```

   The returned `isResolved: true` is your proof it landed. As with every repo-targeting `gh` call, this is a **single bare `gh` invocation** — no pipes, `;`, `&&`, heredocs, or command substitution (the `github-cli-auth` plugin injects the App token into the command's environment; a pipeline would leak it). `-F` passes the id as a typed variable, so there is no shell-metacharacter hazard for the simple id/number values here.

### Self-loop safety — resolving never wakes you

Resolving your own thread is safe from the self-response loop. The `pull_request_review_thread.resolved` webhook that GitHub emits carries **you** as its `sender`, and the inbound classifier maps `pull_request_review_thread` events to their `sender` (not the PR opener) for the self-author drop — so the bot resolving a thread is recognized as self-authored and dropped, exactly like the decoy-reviewer cleanup in the PR review flow. You will not be re-woken by your own resolution. See "Self-loop safety" below.

## Opening new issues and PRs

TypeClaw brokers a command-scoped credential only to a supported, statically repo-targeted `gh` invocation. Do not inspect or assume a process-wide `GH_TOKEN`. Model-driven bash can open an issue with the narrow form below:

```sh
# Open a new issue
gh issue create --repo owner/repo --title 'Bug: ...' --body '...'

```

For a pull request from any accessible project checkout, push the head branch yourself when an eligible broker credential exists. Credential precedence is GitHub App, then an authorized PAT declared in `.env`, then the trusted GitHub CLI store. The store can fund a configured GitHub remote from `workspace`, mounts, nested repositories, or `/tmp`; it requires one configured destination and does not accept explicit-URL or `--set-upstream` pushes. Name the checkout, remote, and branch explicitly:

```sh
git -C <checkout> push <remote> <branch>
```

If the trusted store is unavailable, ask the operator to run `gh auth login --hostname github.com` on the host. The next real `typeclaw start` or `typeclaw restart` refreshes the stored account automatically; a start that finds the container already running does not.

Then open the PR yourself with every field explicit and inline: `gh pr create --repo owner/repo --title 'Fix: ...' --body '...' --head my-branch --base main` (add `--draft` if wanted). `--repo`, `--head`, `--base`, `--title` and `--body` are all required; `--fill`, `--body-file`, `--template`, `--editor`, `--web` and `--attach` are refused because they read local files or open an editor/browser while the credential is live. Without `--head`, gh would interrogate the checkout and offer to push, so always name the already-pushed branch.

Without the `gitExfil` bypass, you can still push to a repo listed in `channels.github.repos` when the github channel uses GitHub App auth, but only one plainly named branch through a configured remote — never `src:dst`, deletion, force, or tags. If `gitExfil` still refuses the push, your role can't publish to that repository. Surface the exact denial instead of retrying another way. Fix ordinary Git push errors yourself and retry. If you must hand off to the operator, name the host-accessible `workspace/<repo>` checkout; never direct the operator to a per-session `/tmp` path.

For the supported issue form under App auth, TypeClaw mints a short-lived token for the explicit `--repo owner/repo` target and withholds it from sibling commands and shell expansions.

Before you compose the issue/PR body, read `typeclaw-github-contributing` — it covers the target repo's contribution etiquette (fill the issue/PR template if one exists, honor `CONTRIBUTING.md`, match the repo's title conventions, search for duplicates first). Opening an issue or PR that ignores the repo's template reads as careless; following it reads as someone who belongs. That skill applies whenever you open a new issue/PR, whether or not the work arrived through this channel.

## Self-loop safety

The adapter will **not** wake you when you assign yourself as a reviewer (e.g., via `gh pr edit --add-reviewer`). It will only wake you when someone else requests your review.

The same guard covers **removing** a reviewer: when the adapter drops the decoy after your review lands (step 6 of the PR review flow), the `DELETE` is authenticated as the App, so the `review_request_removed` webhook GitHub emits carries your bot actor (`slug[bot]`) as its `sender`, which the classifier drops. So the cleanup never echoes back as a fresh wake. Both directions — add and remove — are matched on `sender.login` (against either the bot actor or its decoy), so any reviewer-list mutation made under your identity stays silent.
