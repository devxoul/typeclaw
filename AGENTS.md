# Agent Guidelines

> **Audience.** This file is for the AI assistant (or human contributor) working on the typeclaw source tree — the **dev stage** in `## Stages` below. It is **NOT** the runtime prompt for typeclaw agents; that prompt is composed in `src/agent/index.ts` via `composeSystemPrompt` and can be dumped with `bun run debug:prompt`. When sections below describe runtime behavior, they describe what the code in `src/` does — not instructions to the runtime agent.

## Default scope

If the user asks something, it's always about the typeclaw project itself until they specify another scope. Don't drift into upstream/downstream projects (agent-messenger, plugins consumed via npm, etc.) just because the conversation mentions them.

Write only inside this repo and pre-approved temp dirs (`/tmp/`, `$TMPDIR`). Never touch the user's global skills, configs, or agent identities (`~/.claude/`, `~/.agents/`, `~/.config/opencode/`), typeclaw runtime state (`~/.typeclaw/`), credentials (`~/.ssh/`, `~/.aws/`, etc.), shell/OS config, or sibling repos. If you think you need to, stop and ask.

## Pre-commit checks

Before every commit, all three must pass:

```sh
bun run typecheck
bun run lint
bun run format
```

No exceptions. No `--no-verify`. No partial fixes.

## Security serves the product, not the other way around

TypeClaw is a **productivity product**. It is not a security-guard product. Nobody adopts an agent because its sandbox is elegant — they adopt it because it does their work, and they drop it the first time it refuses to. So a security control that breaks a legitimate workflow is a **defect, in the same sense a crash is a defect**. "But it's hardening" is not a defense. A `feat(sandbox):` prefix is not a justification.

**Design outward from the workflow that has to keep working.** Establish what an authorized agent must still be able to do, then constrain the actual threat with the narrowest control that stops it. Security does not get to go first and hand the UX whatever is left over. That ordering is about sequence of design, not about importance — you still ship the guard, you just don't get to bill its collateral damage to the user.

**This is a demand for precision, not for permissiveness.** It is not license to expose a secret, skip an authorization check, or drop a sandbox boundary because a guard is inconvenient. Those two failure modes are not symmetric and this section does not pretend they are. When the only options genuinely are "leak protected data" or "block the work", block the work — but block it _loudly_, name the cause, and escalate the design instead of quietly picking either failure.

**This section does not repeal load-bearing invariants.** A documented `MUST`, a `fail closed`, a secret boundary, a permission boundary, or anything this file marks "do not harden this back" cannot be removed by citing productivity alone. Replacing one requires naming the threat it covered, showing why its _scope_ was wrong, preserving the guarantee through a narrower control, and adding regression tests for both directions — threat still blocked, authorized workflow restored.

### The scars

Every one of these was an over-broad guard, not a guard that was too strict at its real threat. They are the reason this section exists.

- **`69401ed4` → `79bd56bf`/`7a6f5266`/`e581896f` (2026-07-14 → 07-16).** The canonical-secret Git guard "failed closed on any unreachable or dangling object, disabling all model-driven Git/bash." Unreachable objects are normal debris from every amend/rebase/reset — and from the agent's own self-backup and dreaming rewrites — so "real agent repos accumulate dozens of them and got fully blocked without any actual secret exposure."
- **`035da123` → `7b12232e` (2026-07-14 → 07-21).** A root `.env` reachable in Git history hard-blocked the entire bash surface, even though every declared `.env` var is already inherited into model bash — so "blocking the entire bash surface over it is pure disruption with no confidentiality gain." Worse, it was unrecoverable by design: "the guard's prescribed remediation (`git reflog expire`/`gc`) itself runs through the blocked bash, so the agent could not self-recover." A real agent reviewing an unrelated repo was bricked by its own committed `SENTRY_DSN`.
- **`d770026d` → `9c95b981` (2026-07-14 → 07-21).** Blocking all authenticated network Git in model bash left bind-mounted reference clones to go stale "with no in-band way to refresh." The superseded attempt "tried to harden the in-bash path against hostile repo config and became an unwinnable key/flag arms race." Git is a config-driven process launcher; enumerating its dangerous keys is not a winnable game, and pretending otherwise cost a core workflow for a week.
- **`d477c8b6` → `a8407cc5` (2026-07-28 → 08-03).** A refusal built on an untrue assumption about credential resolution "generalized a single uncredentialed agent into a universal law and refused every one of them, breaking the workflows built on the eighteen `agent-*` skills this package ships." It also pointed the model at a replacement that does not exist. Verify the real dev/host/container/bwrap credential flow before you enforce against it.

Two live examples of the _diagnosability_ half of the same failure: issue **#1377**, where "`gh auth status` succeeds while `git push` fails, and nothing in git's error names the cause"; and the `guest`-role inbound drop (`src/skills/typeclaw-permissions/SKILL.md`), still "the most common cause of 'the agent stopped responding'" because the denial is invisible in-session.

### Rules for adding or widening a guard

- **Name both sides before you write it.** The exact threat, and the authorized workflow that must keep working. If you can't state the workflow, you don't understand the blast radius yet.
- **Scope the denial to the offending operand** — the specific command, path, credential, principal, repo, or request. Never block a broader tool surface because narrower enforcement is more work.
- **Ship the authorized path in the same change.** Don't remove a working capability and leave "we'll broker it later" for a follow-up. `#1377` is what that IOU looks like from the user's side. _Emergency containment is the one exception:_ when a boundary is actively being crossed and no safe authorized path exists yet, a fail-closed stopgap may land on its own — but only if it is scoped to the violating operation, visible to the operator, marked temporary at the code site, and filed with a tracked restoration issue. Miss any of those four and it isn't containment, it's the IOU again with better branding.
- **A guard that can disable a whole tool, adapter, or the bash surface must prove every operation on that surface necessarily crosses the boundary.** Otherwise move the guard down to the operand. Whole-surface denial is the single most repeated mistake in the list above.
- **Never fail silently to the operator.** Say what was blocked, which policy blocked it, and how to recover. This means the operator and the diagnostic surface — not that an unauthorized channel user gets told why, which would just build an authorization oracle.
- **Leave a recovery path that isn't behind the gate.** A guard whose own prescribed remediation runs through the surface it blocks is unrecoverable — that is `7b12232e`. Recovery may be agent-accessible **only where existing runtime authorization already permits that remediation on its own**; otherwise it is an operator path outside the denied surface. It is a recovery path, never a bypass: prompt intent, a stated reason, and model-authored acknowledgements cannot open a boundary, and a guard must not grow an agent-controlled switch that turns it off (`src/bundled-plugins/security/` — "model-authored acknowledgements cannot bypass this guard").
- **Test both directions.** The threat must fail, and representative legitimate operations must still pass. A guard test that only asserts the block is half a test.
- **Verify the actual credential/runtime flow first.** Across dev, host, container, and bwrap. Don't generalize from one adapter, one auth mode, or one deployment state — `d477c8b6` did exactly that.

## Debugging the system prompt

`bun run debug:prompt` dumps the TypeClaw-composed system prompt for each session-origin kind (`tui`, `cron`, `channel`, `subagent` — a default subagent through the standard composer, not a `systemPromptOverride` subagent) with placeholder values, plus a per-section char/byte breakdown and a chars/4 token estimate (not a tokenizer count). It shows the preamble `composeSystemPrompt` builds; pi appends project context (`AGENTS.md` and friends), the skill catalog, and cwd afterwards when it assembles the session.

```sh
bun run debug:prompt                       # all 4 origins
bun run debug:prompt --origin cron         # just one
bun run debug:prompt --origin channel --no-git-nudge
```

`composeSystemPrompt` (`src/agent/index.ts`) is the right entry point if you're adding a new section. Cache-suffix order, least volatile first: shared policy (`buildSystemPolicy`) → identity (`IDENTITY.md` + `SOUL.md`, then plugin `session.prompt` appends) → runtime block → interactive context (full mode only; stable per agent, so it sits before the per-session origin) → session origin → role → MCP catalog → git nudge → proactive-model nudge. The composition tests pin that order; reorder one without the other and CI fails. Wall clock, live channel role, and retrieved memory are per-turn user-prompt context, never system-prompt suffixes — don't add a `## Now` or memory block back.

Memory is injected per turn into the user prompt; the system prompt never contains long-term memory; vector memory is always on. The memory plugin's `session.turn.start` hook renders de-duplicated direct shards (under budget) or top-K hybrid-search results (over budget) into `event.retrievalContext.results`, which the four turn-drivers (server TUI, channel router, cron consumer, subagent runner) append to the user text.

The other half of the memory loop is **consolidation**: the `dreaming` subagent (`src/bundled-plugins/memory/dreaming.ts`, cron `memory.dreaming.schedule`, default `*/30 * * * *`) reads undreamed daily-stream fragments and rebalances them into `memory/topics/<slug>.md` shards. Three load-bearing invariants make a bad LLM run non-destructive: the **citation-superset check** (every previously-cited fragment id must still be cited after the run, in `fragments:` or `superseded:`, else the whole run reverts via `restoreShardSnapshot`), **runtime-owned frontmatter** (`cites`/`days`/`lastReinforced` are recomputed from citations every run — the subagent never sets them), and **fragment-GC gating** (`compactDailyStreams` drops dreamed-and-uncited fragments only when shards were actually rewritten this run, never on stale citations). Dreamed-ids advance even on a citation-superset revert — the conscious anti-loop tradeoff. See [/docs/internals/memory](https://typeclaw.dev/docs/internals/memory).

Every standard origin (`tui`, `channel`, `cron`, `subagent`, `system`, and undefined) starts with the same `buildSystemPolicy(branding)` text; origin, role, and roster never change it. `deriveSystemPromptMode` (exhaustive `switch` on `origin.kind`) only selects optional context: `full` (`tui`, `channel`, undefined) adds the interactive orchestration context, roster validation, git nudge, and MCP catalog; `slim` (`cron`, `subagent`, `system`) skips them. Registered subagents with their own `systemPrompt` go through `createOverrideResourceLoader` instead, which skips the shared policy and `IDENTITY.md`/`SOUL.md` but still gets pi's project-context discovery.

## Release

Use the **Release** GitHub Actions workflow (`workflow_dispatch`, see `.github/workflows/release.yml`). It validates the version, runs checks, bumps `package.json`, builds and pushes multi-arch base to `ghcr.io/typeclaw/typeclaw-base:X.Y.Z`, verifies cross-platform pullability, publishes to npm with provenance, then tags + releases. Tags have no `v` prefix.

The workflow is the only supported release path. The GHCR-first-then-npm ordering is load-bearing for the version-pin invariant: a user who `npm install`s before the base image lands cannot `typeclaw start`.

**Version decision.** Specified version → use as-is. Otherwise **default to patch** and only escalate to minor when one of the explicit minor triggers below is clearly met. When in doubt, it's a patch.

**Judge the change, not the commit message.** The bump is decided by what the commits since the last release _actually do_ to the public surface — read the diffs, not the Conventional Commits prefix. A `feat(...)` subject is NOT evidence of a minor bump, and a `fix(...)` subject is NOT proof of a patch; both are author conventions that say nothing about whether the public surface changed. Do not count `feat` commits. For each non-trivial commit, ask: "Does this diff add or break one of the minor triggers below?" If none do, it's a patch no matter how many `feat`s there are. Inspect with `git log <last-tag>..HEAD` plus `git show <sha>` on anything that might touch CLI args, plugin contracts, or config schema — internal helpers, behavior tweaks, i18n, and guards that don't expand the surface stay patches even when titled `feat`.

- **patch** (the default) — bug fixes, refactors, docs, deps, internal-only changes, performance work, test changes, and any user-facing improvement that doesn't add a new public surface or break an existing one. Most releases are patches.
- **minor** — reserve for a genuinely new _public_ surface or a breaking change. Specifically, at least one of: (a) a new CLI subcommand or flag, (b) a new plugin contract surface (tool/skill/subagent/channel/command hook or config field plugins can rely on), (c) a backwards-incompatible change to any of the above. A "new feature" alone is NOT enough — if it doesn't expand or break the public surface in one of those ways, it's a patch.
- Never bump major unless asked. Never ask the user which to bump.

`package.json` is the single source of truth for the version.

**Re-running after partial failure.** Every step is idempotent at the same version (GHCR overwrites, `npm publish` is gated by `npm view`, `git tag -f`, `gh release` is gated by `gh release view`). Re-run the workflow at the same version and it cleans up whatever didn't finish.

**Announce the release.** After the workflow completes successfully (`gh release view <version>` returns the tag), post a release note to the **TypeClaw Discord `#releases` channel** via the `agent-discord` skill (`bunx agent-messenger discord`; server `TypeClaw`, channel `releases`). Do this only once the GitHub release actually exists — never pre-announce a release still in flight. Pull the highlights from the generated GitHub release body (`gh release view <version> --json body`), lead with the headline user-facing change, keep it energetic, and include the install line (`bun add -g typeclaw@<version>`) and the changelog URL. If the announcement fails, the release itself still stands — re-post the note; don't re-run the release workflow.

## Vocabulary

"channel" — or `channel_*` tool/code references — means **`src/channels/`**, this repo's channels subsystem (router, manager, persistence, Slack/Discord adapters). NOT Channel Talk, NOT abstract Slack channels, NOT the agent-messenger `agent-channeltalk*` skills. Only branch out when the user explicitly names a different platform.

## Adding a channel adapter

A new adapter is **not done when the adapter file compiles and the runtime routes it.** An adapter is a public surface with many enumeration sites, and the easy-to-miss ones are the CLI/init/docs touch-points — a half-wired adapter runs but is invisible to `channel add`, `channel list`, `doctor`, `inspect`, and every reader of the docs. When you add (or audit) an adapter, walk this checklist and name each site explicitly; skipping one is the single most common channel bug. The Teams adapter's initial landing is the worked cautionary example: the runtime was fully wired but `buildDetail`, `inspect/label.ts`, `doctor/channel-checks.ts`, the `channel add`/`reauth` flows, the init wizard, and **all docs** were missing.

**Runtime + type system (the adapter won't route without these):**

- `src/channels/schema.ts` — add the id to `ADAPTER_IDS`, a slot to `channelsSchema`, and an entry to `ADAPTER_READ_CAPABILITIES` (there's a guard test in `schema.test.ts` mapping id → adapter file).
- `src/channels/manager.ts` — `buildAdapter` branch + credential-store wiring + credential-signature hashing for reload detection.
- `src/channels/adapters/<name>.ts` (+ `-classify`, `-key`, etc.) — the adapter itself and its router-callback registrations. Register **every** capability the platform supports (outbound, history, message-get, list, membership, reactions, typing, fetch-attachment, channel-name resolver) — a missing registration is a silent capability gap, not a compile error.
- `src/secrets/schema.ts` + `src/secrets/<name>-store.ts` — credential record + block schema and its store (host + container modes).
- `src/config/channels-mutation.ts` — `CHANNEL_KINDS`.
- `src/permissions/match-rule.ts`, `src/permissions/resolve.ts`, `src/role-claim/match-rule.ts`, `src/agent/session-origin.ts` — platform mapping for permissions, roles, provenance, prompt rendering.
- `src/hostd/daemon.ts` + `src/hostd/protocol.ts` — if the adapter needs host-side credential write-back (token refresh).

**CLI + init surface (the adapter is invisible without these):**

- `src/cli/channel.ts` — `CHANNEL_LABELS`; then depending on auth model: `ADDABLE_CHANNEL_KINDS` + `collectCredentials` (for `channel add`), `SETTABLE_ADAPTERS` (token rotation via `channel set`), `REAUTHABLE_ADAPTERS` + `runReauth` (account-login replay), and any family picker (Slack/Discord/Webex-style bot-vs-user modes).
- `src/init/<name>-auth.ts` — the interactive bootstrap (device-code / QR / password), mirroring `slack-auth.ts` / `webex-auth.ts` / `discord-auth.ts`.
- `src/init/index.ts` — `runAddChannel` (`AddChannelOptions` union, `AddChannelStepEvent`, the auth-first ordering, `channelSecretsFromOptions`), plus the init-wizard path: `with<Name>` scaffold flag, `pickChannel`/`runChannelFlow`/`channelDisplayName`, and `configuredChannels`.
- `src/config/channels-mutation.ts` `buildDetail` — the `channel list` DETAIL column (account count / repo count). Multi-account adapters share the `currentAccount`/`accounts` branch.
- `src/inspect/label.ts` `ADAPTER_DISPLAY` — the human-readable name in `inspect`.
- `src/doctor/channel-checks.ts` — a `buildChannelChecks()` entry verifying credentials resolve host-side (and update the `channel-checks.test.ts` names assertion).
- `src/channels/router.ts` `NATIVE_REPLY_EVERY_SHAPE_ADAPTERS` — only if the platform's reply model needs it.

**Agent-messenger credential filenames are intentionally not enumerated in model-tool code.** The sandbox masks the entire active `workspace/.config/agent-messenger/` directory from every model-driven tool. The legacy `workspace/.agent-messenger/` path remains permanently masked for security compatibility but is not active configuration. `resolvePrivilegedSandboxRuntime` never mounts an agent-messenger credential profile into a child CLI. When an upstream adapter changes its credential filename, do not add a per-platform broker entry; keep the whole-directory invariant instead. The canonical list shared by bash and non-bash guards lives in `src/sandbox/canonical-secrets.ts`.

**Docs (ships in the same PR as the code that motivates it):**

- `docs/content/docs/reference/<name>.mdx` — reference page (model it on the closest existing adapter: bot-token → `slack-bot.mdx`; user-account → `webex.mdx`).
- `docs/content/docs/reference/meta.json` — sidebar nav entry.
- `docs/content/docs/reference/channel-adapters.mdx` — the master adapter table row, the `channels.<adapter>` shape example, the per-adapter quirks row, and the `set`/`reauth` CLI-verb split.
- `docs/content/docs/guides/add-a-channel.mdx` — the CLI line under "Other platforms", an `<Accordion>` for the sign-in specifics, and the reauth list.
- `README.md` — the "Supported channels" bullet.

Multi-language rules (below) apply to any inbound classification / alias matching the adapter adds.

### Never implement (or depend on) desktop/browser credential extraction

TypeClaw always runs in the **container stage** — a headless Docker container with no desktop messaging app, no logged-in browser profile, and no host keychain. So **any auth path that reads credentials off a local app or browser on disk is dead on arrival here.** Never add such a path to typeclaw, and never wire an adapter to a code path that requires one at runtime.

The upstream `agent-messenger` SDK's `auth extract` flow is the canonical example of what NOT to lean on: it scrapes a session token out of the Teams/Slack/Discord desktop app's SQLite cookie DB (or a Chromium profile) via paths like `~/Library/Containers/com.microsoft.teams2/...`, `~/.config/Microsoft/...`, `%LOCALAPPDATA%\Packages\MSTeams...`. None of those exist in the container. (Not every adapter uses cookie extraction — KakaoTalk, for one, registers a sub-device via `auth login` rather than scraping a cookie — but any auth model that reads host-local app/browser state is equally dead in the container.) TypeClaw is a **consumer** of already-extracted credentials (copied into `secrets.json` by the operator on the host), never an extractor. There is no `typeclaw auth extract` command and there must never be one — if you see that string in a log, it came from `agent-messenger`, not this repo.

The Teams realtime listener is the worked example of both the trap and the way out. `TeamsListener` (from `agent-messenger/teams`) calls `client.getIdToken()` on start **and on every reconnect**. The SDK's own implementation runs `TeamsTokenExtractor.extractIdToken()` — a desktop/browser cookie scrape — which in the container always returns `null`, and the SDK then throws `Could not obtain Teams id_token for real-time auth ... re-run "auth extract"` at start and in a reconnect log-loop. typeclaw does **not** inherit that path: `ContainerTeamsClient` (`src/channels/adapters/teams-id-token.ts`) overrides `getIdToken()` to **mint** the bearer from the `aad_refresh_token` the operator already handed us in `secrets.json#channels.teams`, so the listener runs for real in the container and `src/channels/adapters/teams.ts` starts it. The general rule stands: when you add or audit any adapter, ask _does this path try to read a credential the host operator didn't hand us in `secrets.json`?_ If yes, it can't run in the container — either derive it from a credential we do hold, as the Teams id-token minter does, or degrade gracefully. Don't wire the scrape.

## Multi-language

TypeClaw is a **multi-language project**: the agent lives in users' chats and reads messages in Korean, Japanese, Chinese, Arabic, Russian, every Latin-script language, and more — not just English. Any code that does **natural-language pattern matching over user/agent text** MUST work across languages, not just hardcoded English words or ASCII-only regex. This applies whenever you add or audit keyword detection, mention/alias matching, intent or engagement heuristics, suppressors, trigger-word lists, or verdict/sentiment classifiers.

Rules when writing or auditing NLP-style matching:

- **Never ship an English-only keyword list for user-facing heuristics.** If you match "I'll check", you must also cover "확인해볼게요", "voy a revisar", "je vais vérifier", etc. The existing model is `src/channels/continuation-willingness.ts` — a 15-language phrase table (EN/KO/ES/FR/IT/PT/DE/RU/ZH/JA/AR/HI/TR/VI/ID) matched case-insensitively. Extend that table; don't fork a new English-only one.
- **`\b` word boundaries in JS regex are ASCII-only.** A `\b` will not fire after accented Latin (`é`), and the concept doesn't apply to CJK/Arabic/Hindi where there are no spaces between words. `src/channels/github-review-claim.ts` is the worked example: it documents the `\b` trap, drops boundaries for non-Latin scripts, and uses Unicode-escape patterns per language. Follow that pattern instead of assuming Latin tokenization.
- **Normalize before matching.** Lowercase with `toLocaleLowerCase()` and match with `includes()` for substring heuristics (see `matchesAnyAlias()` / `textTargetsAnyPeerBot()` in `src/channels/engagement.ts`), which is script-agnostic — rather than reaching for ASCII-biased regex.
- **Protocol tokens are the one exception.** Fixed control signals that the agent emits to itself stay English by design — e.g. `NO_REPLY` detection in `src/channels/router.ts` (`isNoReplySignal` / `endsWithNoReplySignal`), and platform-constrained identifiers like GitHub `@login` matching (ASCII by GitHub's own rules) in `src/channels/adapters/github/inbound.ts`. These are not natural language; don't "multilingualize" them. The line is: matching _what a human typed_ → multi-language; matching _a token the system defined_ → English literal is fine.
- **Tests must cover non-English input.** A pattern-matching change isn't done until at least one non-Latin-script case (Korean or CJK is the cheapest) is asserted alongside the English case.

## Stages

TypeClaw runs code in three stages with different filesystems, process owners, and invocation paths. Confusing them is the most common bug source. Name the stage explicitly when discussing any command, path, or mount.

### dev stage — this repo

Running `bun run test` / `bun run typecheck` on the typeclaw source tree. CLI executes directly from `src/cli/index.ts`. No agent folder, no container.

### host stage — the user's machine

The user's cwd after `typeclaw init`. Holds `typeclaw.json`, `.env`, `package.json`, markdown files, `workspace/` (free-write zone), `sessions/` + `memory/` (gitignored but force-committed by typeclaw). Host commands are **launchers**:

- `typeclaw start` — `docker run` the configured container.
- `typeclaw stop` — `docker stop`, archive and prune logs, then non-force `docker rm`; archive failure preserves the container unless Docker reports that it can no longer serve the logs. Removal remains non-force, and a container stuck in `removing` is reported with the Docker/OrbStack restart remedy.
- `typeclaw restart` — `stop` then `start`.
- `typeclaw logs [-f]` — container logs with local-time prefix reformatting.
- `typeclaw tui` — attach a TUI over websocket.
- `typeclaw compose` — orchestrate multiple agents.
- `typeclaw _hostd` — hidden singleton daemon. See [Host daemon (hostd)](https://typeclaw.dev/docs/internals/hostd).

Persistent host state lives in `~/.typeclaw/` (override with `TYPECLAW_HOME` for tests). `src/hostd/paths.ts` is the only writer.

### container stage — inside Docker

The agent folder is bind-mounted at `/agent`. The container's entrypoint is:

- `typeclaw run` — starts the websocket server (`src/server/`), creates an `AgentSession` (`src/agent/`), speaks to TUI/channels.

`OPENAI_API_KEY` and friends arrive via `--env-file .env`. The `typeclaw` binary resolves through `node_modules/typeclaw` (in dev, a symlink into this repo).

### Rules of thumb

- **CLI command names encode stage.** `init`/`start`/`stop`/`restart`/`logs`/`tui`/`compose` are host-only. `run` is container-only. Anything that reads `process.cwd()` implicitly assumes host stage unless called from `run`.
- **Annotate stages on paths.** `./typeclaw.json` = host stage; `/agent/typeclaw.json` = container stage.
- **TypeClaw owns Dockerfile + .gitignore and rewrites both on every `start`.** Not just on `init`. `refreshDockerfile` returns `{ changed }`; on change, `start()` ORs into `needsBuild`, so the next start rebuilds without `--build`. To ship a Dockerfile template change, edit `src/init/dockerfile.ts` and run `typeclaw start`. Do not tell users to re-run `init`.
- **`.gitignore` has two categories.** _Truly-ignored_ (`.env`, `node_modules/`, `workspace/`, `mounts/`, `Dockerfile`, `.DS_Store`) — never in git. _System-managed_ (`sessions/`, `memory/`) — gitignored so the agent doesn't stage by hand, but force-committed by typeclaw on its own schedule. Keep that split in `gitignore.ts` section comments.
- **`.env` is normally the operator's expose-to-model-bash surface, with explicit runtime-control exceptions.** Every ordinary non-empty var an operator declares there is re-introduced into bwrap via `inherit`, including `GH_TOKEN`/`GITHUB_TOKEN`. `resolveExposableEnvNames` (`src/sandbox/env-exposure.ts`) withholds sandbox/process controls, host-injected tokens, and the operator-authored boot-only `TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_HOSTS` / `TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_CIDRS` policy. Those two live values stay hidden, and raw `.env` remains masked. The live-file bwrap mask and non-bash denial still cover `.env`, so knowing configured strings does not grant runtime policy authority. Do NOT add `GH_TOKEN`/`GITHUB_TOKEN` to the withhold set — the `github-cli-auth` broker's narrower per-repo overlay is layered on top, not a substitute. Other credentials that must stay hidden belong in `secrets.json`.
- **Per-agent Dockerfile pins `typeclaw-base:X.Y.Z` to the installed typeclaw version.** `refreshDockerfile` reads `<agent>/node_modules/typeclaw/package.json#version`. Removing or republishing a `typeclaw-base:X.Y.Z` tag after release breaks every installed copy on rebuild. GHCR has no immutability flag — don't.
- **Dev mode (`file:`/`link:` typeclaw deps) falls back to inlining the heavy stack on the pinned `oven/bun` slim base (`BUN_BASE_IMAGE` in `src/init/dockerfile.ts`)** because the matching GHCR tag doesn't exist yet. New heavy-stack layers must land in BOTH `buildBaseDockerfile` (next release's base) AND the inline branch of `buildDockerfile` (dev/tests). `typeclaw start --build` detects locally-linked deps and threads `force: true` so `bun install --force` runs.
- **`refreshDockerfile` runs AFTER `ensureDeps` in `start()`.** Order is load-bearing: the version pin reads `node_modules/typeclaw/package.json#version`, which `bun install` populates.
- **`typeclaw.json` has two access patterns.** Host-stage CLI uses the `config` snapshot. Container-stage runtime code (anything reachable from `typeclaw run`) MUST go through `getConfig()` so reloads take effect. Boot-only fields are `restart-required`; the `FIELD_EFFECTS` table in `src/config/config.ts` is the fence, and a guard test in `src/config/reloadable.test.ts` fails if a new schema field lacks a classification.
- **`validateConfig` is the single host-side gate.** Every host path that consumes `typeclaw.json` goes through it before doing anything destructive. It also walks `config.mounts` and runs `validateMount` (existence, readability, writability). New host-side callers route through `validateConfig`, not `loadConfigSync`.
- **`typeclaw.json#port` is preferred, not guaranteed.** `start` allocates a free port via `net.createServer().listen(...)` and falls back to ephemeral. The container's internal port is fixed (`CONTAINER_PORT`, `src/container/port.ts`). Mapping is asymmetric: `-p ${hostPort}:${CONTAINER_PORT}`. Docker is the runtime authority — `typeclaw tui`/`reload` use `docker port <container> 8973/tcp`. `typeclaw run` MUST default `--port` to `CONTAINER_PORT`, never to `config.port`.
- **Containers run WITHOUT `--rm`.** Load-bearing for debuggability: a crashed container's logs must survive past exit. `typeclaw stop` does `docker stop`, archives logs, prunes strict archive snapshots older than `logs.retentionDays` (default 14), then removes the container; `start` applies the same archive-before-remove policy to freshly re-probed stale corpses. Failed capture or pruning preserves the container, except when Docker reports that it can no longer serve the logs; cleanup then continues while removal stays non-force. A container stuck in `removing` is reported with the remedy to restart Docker or OrbStack, after which the restored `dead` container can be removed on the next lifecycle command. Do not "modernize" this back.
- **Containers run with `--security-opt seccomp=unconfined` and `--security-opt apparmor=<sandbox.apparmorProfile>`.** Both are required so baseline `bwrap` can create user/pid/mount namespaces: Docker's seccomp default blocks userns, and moby's docker-default AppArmor profile explicitly denies mount. `apparmor=unconfined` is a profile selection, not a capability grant, and stock Ubuntu 23.10+ additionally denies unconfined uid-map writes while `kernel.apparmor_restrict_unprivileged_userns=1`; operators there must install the shipped `scripts/apparmor/typeclaw-bwrap` host profile, select it in config, and restart. `CAP_SYS_ADMIN` is not an alternative because the entrypoint runs as a non-root UID with an empty capability set. The outer container remains a single-tenant trust boundary; the inner bwrap sandbox is load-bearing for subagent isolation. See [/docs/internals/sandbox](https://typeclaw.dev/docs/internals/sandbox). Do not "harden" either option back without replacing the inner sandbox path with an equivalent boundary.
- **The per-tool sandbox `/proc` strategy is `proc-bind` by default, so containers get NO `--cap-add=SYS_ADMIN`.** Load-bearing for the core subagent workflow: sandboxed external-package CLIs (`bunx agent-*`, `bun add <pkg>`, `bun run <pkg-bin>`) need a real `/proc/self/{fd,maps}`, which the `--tmpfs /proc` profile can't provide — every such call aborts with Bun's opaque `NotDir`. `proc-bind` (`bwrap --unshare-all … --ro-bind /proc /proc`) binds the container's already-real procfs with NO `unshare --mount-proc` and NO `CAP_SYS_ADMIN`, so it works on OrbStack (which rejects the proc mount even with the cap — the reason the prior `real-proc`-default fix never actually fired there). The agent runtime's `/proc/<agent>/environ` (`OPENAI_API_KEY`) is NOT leaked: `--unshare-all` puts the sandbox in a CHILD user namespace, so the kernel's `PTRACE_MODE_READ_FSCREDS` check blocks the cross-userns `environ` read (and `kill`/`ptrace` fail `EPERM`). The leftover residual is non-secret PID metadata (other pids' `cmdline`/`status` visible), accepted on the single-tenant boundary. The no-leak property is PROBED at runtime (`canBindProcSafely`, `src/sandbox/availability.ts`) — a sentinel sibling with a planted secret must be unreadable from the sandbox — and fails CLOSED to `--tmpfs /proc` if not. `sandbox.realProc: true` is an opt-in that adds full PID isolation via the `real-proc` strategy (`unshare --pid --fork --mount --mount-proc -- bwrap …`), at the cost of the `CAP_SYS_ADMIN` grant; the resolver still falls back to `proc-bind` where the mount is a no-op (OrbStack). The strategy is read from the BOOT-TIME `config` snapshot in `applyBashSandbox` (`src/agent/plugin-tools.ts`), NOT live `getConfig()`, so it stays coherent with the boot-time capability decision — `sandbox` is `restart-required` for exactly this reason.

## Testing Philosophy

### 1. Test behavior, not implementation

Tests must survive refactors and fail only when **observable behavior** changes. After writing a test, ask: "If I comment out the production line this test guards, does it fail?" If not, the test verifies nothing.

### 2. Test at the right layer

- **CLI / UI layer** — prompts, spinners, `process.exit`, argv. Keep thin, rarely test.
- **Domain / pipeline layer** — composition, transformations, orchestration. **Primary test surface.**
- **Primitive layer** — file writes, shell calls, pure functions. Unit-test for edge cases.

If you're mocking `@clack/prompts` or stubbing `process.cwd` to test domain logic, the domain logic is in the wrong place. Extract a pure function and test it directly. Example: `src/init/index.ts` owns the `runInit` pipeline; `src/cli/init.ts` is a thin shell.

### 3. Pipeline tests must verify composition

Unit tests on sub-steps are necessary but not sufficient. You also need orchestrator tests asserting on order of execution, data flow between steps, and failure propagation. If a step can be added/removed/reordered without breaking a test, composition is untested. Make orchestrators emit observable events (callbacks, returned structures, async-iterator yields) and assert on the sequence.

### 4. One function, one concern

A function that prompts AND runs logic AND handles `process.exit` has three reasons to change. Split them: pure logic is testable, I/O is small enough to review, new steps get caught by pipeline tests.

### 5. Test doubles sparingly

Every mock is a theory about a collaborator. Theories rot. Prefer:

1. Real implementations with controlled inputs (tmp dirs, real `bun install`, real `git`).
2. Hand-rolled fakes when the real thing is unavailable or too slow.
3. Mocking libraries only as a last resort, at module boundaries.

### 6. When to skip

Simple data classes, type-only files, auto-generated code, trivial constants. A test that restates a literal is noise.

### 7. TDD is the default, not a ceremony

Write the failing test first for non-trivial behavior, edge cases, or unclear APIs. Skip TDD when setup outweighs the logic. This is a tool, not a religion.

## File Layout

Domain logic lives in `src/<domain>/`. Examples: `src/init/`, `src/config/`, `src/server/`, `src/agent/`.

- `src/cli/` is **UI only** — citty, clack, spinners, `process.exit`. Delegate to `src/<domain>/`.
- Tests live next to code as `<file>.test.ts`.
- Domain entry points are `src/<domain>/index.ts`. Split files only when one gets complex.

## Architecture

The architecture reference lives in the published docs under [Internals](https://typeclaw.dev/docs/internals). It's terse, file-path-heavy, and aimed at the same audience as this file — someone about to edit `src/`.

| Subsystem                                                                                                                                           | Where                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Skills loading sources, naming, lazy semantics                                                                                                      | [/docs/internals/skills](https://typeclaw.dev/docs/internals/skills)                       |
| `src/bundled-plugins/memory/` observe/dream/apply loop, strength model, citation-superset                                                           | [/docs/internals/memory](https://typeclaw.dev/docs/internals/memory)                       |
| `.env` / `secrets.json`, the `Secret` shape, bridge idempotency, KakaoTalk encryption-at-rest, sandbox env exposure (`src/sandbox/env-exposure.ts`) | [/docs/internals/secrets](https://typeclaw.dev/docs/internals/secrets)                     |
| Roles, match-rule DSL, cron/subagent provenance, security guard tiers                                                                               | [/docs/internals/permissions](https://typeclaw.dev/docs/internals/permissions)             |
| `src/hostd/`, three trust channels, control protocol, portbroker                                                                                    | [/docs/internals/hostd](https://typeclaw.dev/docs/internals/hostd)                         |
| `src/tunnels/`, providers, channel-adapter integration                                                                                              | [/docs/internals/tunnels](https://typeclaw.dev/docs/internals/tunnels)                     |
| `src/stream/` targets, subagent dispatch, cron split, TUI wire-protocol                                                                             | [/docs/internals/message-stream](https://typeclaw.dev/docs/internals/message-stream)       |
| `src/channels/` engage/observe decision, context buffer, suppressors, peer-bot loop guard                                                           | [/docs/internals/engagement](https://typeclaw.dev/docs/internals/engagement)               |
| `src/agent/todo/` tools, durable scope resolution, fail-closed auto-continuation budgets                                                            | [/docs/internals/todo-continuation](https://typeclaw.dev/docs/internals/todo-continuation) |
| `web_search` tool, `curl-impersonate` pin, DDG failure modes                                                                                        | [/docs/internals/web-search](https://typeclaw.dev/docs/internals/web-search)               |
| Xvfb, NET_ADMIN drop, persistent-`$HOME` overlay, agent-browser headed-mode wrapper                                                                 | [/docs/internals/xvfb](https://typeclaw.dev/docs/internals/xvfb)                           |
| `bwrap` per-tool sandbox, seccomp/AppArmor rationale and host profile, OrbStack `/proc` workaround                                                  | [/docs/internals/sandbox](https://typeclaw.dev/docs/internals/sandbox)                     |

The source for these pages is `docs/content/docs/internals/*.mdx` in this repo. Edit there when subsystem behavior changes — the published site rebuilds from the same files.
