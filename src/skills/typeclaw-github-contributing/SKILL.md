---
name: typeclaw-github-contributing
description: Use this skill BEFORE you open a new issue or pull request on GitHub with `gh issue create` / `gh pr create` (or before composing the `--body`/`--title` for one, or editing an issue/PR body after the fact). Triggers include any `gh issue create`, `gh pr create`, `gh api … /issues`, `gh api … /pulls`, any time you are about to file a bug report, feature request, or PR against a repo — yours or someone else's — and any phrasing like "open an issue", "file a bug", "raise a PR", "submit a pull request". Read it first, because every repo has its own contribution rules — an issue/PR template, a CONTRIBUTING.md, a title convention — and a maintainer's first impression of your contribution is whether you bothered to follow them. Ignoring a template that the repo author wrote on purpose reads as careless; following it reads as someone who belongs. This is platform etiquette, independent of how the work reached you (it applies whether the request came through the github channel or you decided to file on your own).
---

# typeclaw-github-contributing

When you open an issue or a PR on GitHub, you are writing into **someone else's repository** — even when it's nominally "yours," it usually has collaborators, a history, and conventions that predate this turn. The repo's maintainers encoded what they want from a contribution in a few well-known files. Honoring them is not bureaucracy; it's the difference between a contribution that gets triaged and merged and one that gets a "please use the template" and sits.

This skill is the **etiquette of contributing to a GitHub repo**. It is not about replying to inbound GitHub events or running PR reviews — that's `typeclaw-channel-github`. It is not about committing to your own agent folder — that's `typeclaw-git`. It is specifically about _what you put on GitHub the moment you open a new issue or PR._

## The rule

**Before you open an issue or PR, find the repo's contribution conventions and follow them. If a template exists, fill it — don't bypass it. If a CONTRIBUTING file exists, read it and honor it. Match the title style the repo already uses.**

The principle underneath all five rules below: **the repo already told you how it wants contributions; your job is to look before you write, not to impose your defaults.**

## Do this first — read the repo before you write

A contribution composed from your defaults and one composed from the repo's conventions look completely different to a maintainer. The five-second check that separates them:

**Templates do not live in one fixed spot — GitHub resolves them from several.** Probing only `.github/PULL_REQUEST_TEMPLATE.md` is the trap: a repo that keeps its template at the root, under `docs/`, or in a `PULL_REQUEST_TEMPLATE/` directory will look template-less to that one check, and you'll bypass a convention the maintainer actually set. GitHub looks in **three base locations** — the repo root, `docs/`, and `.github/` — and the filename is **case-insensitive** (`PULL_REQUEST_TEMPLATE.md`, `pull_request_template.md`). It also supports a **`PULL_REQUEST_TEMPLATE/` _directory_** of multiple named templates (same three base locations). Issue templates follow the same pattern: a single `.github/ISSUE_TEMPLATE.md`, or — far more common now — an `ISSUE_TEMPLATE/` directory of forms (`*.md` / `*.yml`).

The cheapest reliable check is to list each base directory once and scan the names, rather than guessing exact filenames:

```sh
# Run each as its own bare invocation. Inspect the returned names case-insensitively
# for PULL_REQUEST_TEMPLATE(.md), PULL_REQUEST_TEMPLATE/, ISSUE_TEMPLATE(.md),
# and ISSUE_TEMPLATE/. A missing directory may return 404; continue with the next.
gh api repos/OWNER/REPO/contents/ --jq '.[].name'
gh api repos/OWNER/REPO/contents/docs --jq '.[].name'
gh api repos/OWNER/REPO/contents/.github --jq '.[].name'
gh api repos/OWNER/REPO/contents/PULL_REQUEST_TEMPLATE --jq '.[].name'
gh api repos/OWNER/REPO/contents/docs/PULL_REQUEST_TEMPLATE --jq '.[].name'
gh api repos/OWNER/REPO/contents/.github/PULL_REQUEST_TEMPLATE --jq '.[].name'
gh api repos/OWNER/REPO/contents/ISSUE_TEMPLATE --jq '.[].name'
gh api repos/OWNER/REPO/contents/docs/ISSUE_TEMPLATE --jq '.[].name'
gh api repos/OWNER/REPO/contents/.github/ISSUE_TEMPLATE --jq '.[].name'

# Contribution guide (root or .github/)
gh api repos/OWNER/REPO/contents/CONTRIBUTING.md
gh api repos/OWNER/REPO/contents/.github/CONTRIBUTING.md

# What do existing titles look like?
gh pr list --repo OWNER/REPO --state all --limit 20 --json title --jq '.[].title'
gh issue list --repo OWNER/REPO --state all --limit 20 --json title --jq '.[].title'

# Is this a duplicate?
gh issue list --repo OWNER/REPO --search "<keywords from what you're about to file>" --state all
```

A `grep` that matches **nothing across all three base dirs** is your evidence there is genuinely no template — a single 404 on `.github/PULL_REQUEST_TEMPLATE.md` is not. You don't need every command every time, but you do need to _look in all the supported places_ before concluding "no template" and composing from your own defaults. The cost is a few API calls; the cost of skipping it is bypassing a convention the repo set on purpose — the exact failure this skill exists to prevent.

## The five rules

### 1. Fill the issue/PR template if one exists

If the discovery scan above surfaced a template in **any** of the supported locations (root, `docs/`, or `.github/` — single file or directory), the maintainers want every issue/PR to follow that shape. Fetch its content, read its sections, and produce a `--body` that fills each one with real content.

- For PRs, the template often has a checklist ("- [ ] tests added", "- [ ] docs updated"). Fill the prose sections; for checkboxes, check only what is genuinely true and leave the rest unchecked — don't tick a box you can't back up.
- A **`PULL_REQUEST_TEMPLATE/` directory** holds more than one PR template; pick the one that matches your change and fill it. (GitHub can also select one via a `?template=` URL param, but when you're filing through `gh` you choose by reading the directory and using the right file as your body.)
- An **`ISSUE_TEMPLATE/` directory** likewise holds multiple issue forms (bug report, feature request, etc.) — pick the one that matches what you're filing. A bug filed against the feature-request template is noise. Forms may be YAML (`.yml` issue forms) rather than markdown; translate their fields into a sensible body, or use the matching markdown template if one is offered.
- A repo with genuinely no template (the scan matched nothing in all three base dirs) gives you latitude — but a clear, scannable body (what / why / how, repro steps for bugs) is still the courteous default.

### 2. Don't bypass the template to file faster

This is rule 1's hard edge and the failure this skill most exists to prevent. When a template has required sections or a checklist, **fill or honor them — do not delete them to save effort.** Stripping the template, leaving placeholder text (`<!-- describe your change -->`) un-replaced, or dumping a one-liner where the template asked for repro steps all read as "I didn't bother." If a section genuinely doesn't apply, say so explicitly ("N/A — no user-facing change") rather than silently removing it; the maintainer can tell the difference between _considered and skipped_ and _ignored_.

### 3. Follow CONTRIBUTING.md

If the repo has a `CONTRIBUTING.md` (root or `.github/`), read it before you open anything. It encodes rules the templates can't — branch naming, whether PRs go against `main` or `develop`, whether a linked issue is required first, commit sign-off (DCO), the expected PR description format, "open an issue before a large PR," and so on. These are the maintainers' actual process; violating them is the most common reason a well-intentioned PR gets bounced. Honor what it says even when it differs from your habits.

### 4. Match the repo's title conventions

A repo's existing issue/PR titles tell you the house style. Pull the last ~20 (commands above) and infer the pattern, then match it:

- **Conventional-commit prefixes** (`feat:`, `fix:`, `docs(scope):`) — if the PR list is full of them, your PR title uses one too.
- **Ticket/issue references** (`[PROJ-123]`, `(#456)`) — if titles routinely carry them and you have a ref, include it.
- **Sentence case vs. lowercase, imperative mood** — small things, but matching them signals you read the log.

If there's no discernible pattern, a clear imperative summary (`Fix race in port allocation`) is the safe default. The point is never to invent your own scheme on top of an established one.

### 5. Search for duplicates before opening

Before filing an issue, search existing issues (open _and_ closed — a closed one may carry the resolution or the maintainer's "won't fix" rationale). If a matching thread exists:

- **Open and relevant** → add your context as a comment on that thread instead of opening a duplicate. Duplicates fragment the discussion and annoy triagers.
- **Closed as resolved** → check whether the fix is in the version you're on before re-filing; if it's a regression, reference the old issue in your new one.

The same applies to PRs: a quick `gh pr list --search` avoids opening a PR for something already in flight.

## Workflow

1. **Identify the target repo** (`OWNER/REPO`) and whether you're filing an issue or a PR.
2. **Read the room** — run the checks in "Do this first": templates, CONTRIBUTING, existing titles, duplicate search.
3. **Compose to the conventions** — fill the template, honor CONTRIBUTING, match the title style. Keep the body inline and single-quoted. `--body-file`, `--template`, editor/fill/recovery modes, shell substitution, and command composition are intentionally unavailable to model-driven `gh`.
4. **Open an issue** with the supported model-driven `gh` form:
   ```sh
   gh issue create --repo OWNER/REPO --title '<conventional title>' --body '<filled body>'
   ```
   For a **pull request**, push the head branch yourself first when an eligible broker credential exists. Credential precedence is GitHub App, then an authorized PAT declared in `.env`, then the trusted GitHub CLI store. The store can fund a configured GitHub remote from any accessible repository path, including `workspace`, mounts, nested repositories, and `/tmp`. It accepts one configured destination and does not accept explicit-URL or `--set-upstream` pushes. Name the remote and branch explicitly:
   ```sh
   git -C <checkout> push <remote> <branch>
   ```
   Then open the PR yourself, with every field explicit and inline:
   ```sh
   gh pr create --repo OWNER/REPO --title '<conventional title>' --body '<filled body>' --head <branch> --base <branch>
   ```
   All five flags are required (`--draft` is optional). `--fill`, `--body-file`, `--template`, `--editor`, `--web` and `--attach` are refused because they read local files or open an editor/browser while the credential is live; omitting `--head` would make gh interrogate the checkout and offer to push. Fix ordinary Git errors yourself and retry. Without the `gitExfil` bypass, a plain one-branch push still works to repos listed in `channels.github.repos` under GitHub App auth; if `gitExfil` refuses it anyway, your role can't publish to that repository — surface the denial and only hand the operator a push command when the broker or your permissions refuse it. If the trusted store is unavailable, ask the operator to run `gh auth login --hostname github.com` on the host; the next real `typeclaw start` or `typeclaw restart` refreshes it automatically, while a start against an already-running container does not. When handing off, name a host-accessible checkout; never direct the operator to a per-session `/tmp` path.
5. **Verify it landed** as intended (`gh issue view` / `gh pr view`) — confirm the template rendered and nothing got truncated.

## Things you must not do

- **Do not open an issue/PR without checking for a template.** A repo that ships a template wants it used; skipping the check is how you end up filing against conventions you never looked at.
- **Do not strip, gut, or placeholder-leave a template** to file faster. Fill it, or explicitly mark sections N/A. An empty template body is worse than a thoughtful free-form one.
- **Do not ignore CONTRIBUTING.md** because its rules differ from your defaults. Its rules win in its repo.
- **Do not invent a title scheme** when the repo already has one. Match what's there.
- **Do not file a duplicate** without searching first. Comment on the existing thread instead.
- **Do not tick checklist boxes you can't back up.** A checked "tests added" with no tests is a false claim the reviewer will catch.

## What this skill does not cover

- **Replying to inbound GitHub events, and running PR reviews** — `typeclaw-channel-github`. That skill owns triage of github-channel inbounds, formal reviews via the reviews API, and resolving review threads. This skill owns only the act of _opening_ a new issue/PR.
- **Committing to your own agent folder** — `typeclaw-git`. Local commit hygiene and decision-context messages live there; this skill is about GitHub artifacts, not your local history.
- **The `gh` CLI's full surface** — auth, sub-commands, flags. TypeClaw brokers a command-scoped token only after statically validating the repo and command shape; it is not a broadly exposed `GH_TOKEN`. See `typeclaw-channel-github` for the single-bare-invocation constraint (no pipes, `;`, `&&`, heredocs, redirections, or substitution).
