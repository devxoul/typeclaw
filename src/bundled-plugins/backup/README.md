# typeclaw-plugin-backup

The bundled backup plugin. Watches the agent folder for uncommitted work and commits + pushes it during quiet moments, with the LLM picking commit messages and diagnosing push/rebase failures. Replaces the previously documented-but-unimplemented "sessions/ via auto-backup" promise.

This plugin is **auto-loaded** by every TypeClaw agent. There is no `plugins[]` entry to add and no opt-out short of `backup.enabled: false`. To configure it, add a `backup` block to `typeclaw.json`.

## Config

```json
{
  "backup": {
    "enabled": true,
    "idleMs": 30000,
    "pushToOrigin": true,
    "maintenance": true
  }
}
```

| Field                     | Default | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup.enabled`          | `true`  | Master switch. When `false`, all hooks no-op and the runner subagent is never spawned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `backup.idleMs`           | `30000` | Debounce window after the agent goes idle (no in-flight prompt turns) before the backup runner fires. Resets on every new prompt. Minimum `1000`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `backup.pushToOrigin`     | `true`  | When `true`, after committing, the runner attempts `git push`. On non-fast-forward, it `git fetch && git rebase` then re-pushes. On rebase conflict, it aborts the rebase and asks the diagnose subagent to write a human-readable report. Set `false` to commit-only (useful for offline workflows or repos without a remote).                                                                                                                                                                                                                                                                                                                                                                                            |
| `backup.maintenance`      | `true`  | When `true`, after a backup that made a local commit, the runner runs a **bounded, best-effort** `git maintenance run` (under the same git lock) with `loose-objects` and/or `incremental-repack` selected independently by loose-object and pack counts. Reclaims what the backup keeps adding — without which loose objects (and later packs) grow until the (now-disabled) auto-gc would fire a memory-heavy full repack. `incremental-repack` (multi-pack-index) leaves the large established pack alone, and both tasks run with `pack.threads=1`/`pack.windowMemory=64m`/`pack.deltaCacheSize=1` so RSS stays bounded. A maintenance failure is logged, never folded into the backup result. Set `false` to disable. |
| `backup.commitTimeoutMs`  | `30000` | Per-command wall clock for local git operations (status/add/commit/diff). Mostly an escape hatch — defaults are generous.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `backup.networkTimeoutMs` | `60000` | Per-command wall clock for network git operations (push/fetch/rebase). Bounds the failure mode where a stuck remote would otherwise hang the runner indefinitely. `GIT_TERMINAL_PROMPT=0` is also set so auth failures fail fast instead of prompting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

All fields are **restart-required** — the plugin reads them once at boot.

## How it triggers

The backup plugin uses **`session.idle` with debounce** as its trigger, not a fixed cron schedule. This means backups fire only after meaningful agent activity has settled — sporadic agents that never go idle (e.g. long polling loops in tools) will not be backed up by this plugin alone.

The fire path is gated by an **active-turn counter**: the plugin tracks `session.turn.start` / `session.turn.end` events from every prompt source (TUI, channel router, cron consumer, subagent invocations) and only fires when the count is zero. The plugin's own three subagents (`backup`, `backup-message`, `backup-diagnose`) are excluded from the count via `origin.kind === 'subagent' && origin.subagent` matching, so the backup never self-gates.

If a new prompt arrives while the runner is in flight, the runner finishes its current commit-and-push cycle; the plugin then re-evaluates the gate. There is no preemption mid-commit — the unit of atomicity is one full backup pass.

## What it commits

The runner builds an explicit snapshot from NUL-delimited porcelain status:

- **Tracked changes**, including deletions and both rename/copy endpoints, remain selected even when an endpoint is no longer present on disk. A selected index entry absent from both HEAD and the worktree (including a removed intent-to-add) is cleared from the index instead of committed; excluded `memory/` paths are never touched.
- **Ordinary untracked paths** are staged only while still present. If one disappears between snapshot and `git add`, the runner re-reads status and retries that same snapshot once without the vanished path; paths discovered during that re-read are never added.
- **`memory/`** remains excluded. Present **`sessions/` and `todo/`** paths reported by porcelain remain force-added; tracked deletions under those prefixes stay in the ordinary snapshot. The post-message pass selects only porcelain-visible late `sessions/` paths.

The runner stages the selected paths in a temporary private Git index for its diffstat, without exposing backup entries in the shared index while `backup-message` selects a message. Git then commits **only** selected paths against its current HEAD; unrelated staged files and intervening commits stay intact. A post-message status drops deletion paths already committed by another writer, and an already-clean selection returns clean rather than a false failure. Discovery of force-added paths is unchanged: gitignored untracked files omitted by porcelain status are not discovered here, while explicitly staged ignored files remain eligible. The `backup-message` subagent sees a truncated status and private-index diffstat and writes a single conventional-ish commit message to a tmp file; on any failure it falls back to `chore: backup`.

## What it pushes

When `pushToOrigin: true`, the runner picks a push plan after committing:

- **Branch has an upstream** (`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` succeeds): run `git push`.
- **No upstream, but `origin` exists and `HEAD` is a real branch**: run `git push -u origin HEAD:<branch>`, which pushes _and_ establishes tracking in one shot. This is the common case for a fresh agent folder nobody ran `git push -u` on by hand — previously the runner committed forever and never pushed here. Every later cycle then takes the plain-upstream path.
- **No `origin`, or detached `HEAD`**: commit only (a legitimate offline / no-remote state). No push is attempted and no diagnostics are written.

On non-fast-forward rejection (either push shape), the runner runs `git fetch` then `git rebase <remote-branch>` then re-pushes with the same args. Only `origin` is ever acted on for the set-upstream case — the runner never guesses a destination the operator didn't configure.

**Credentials.** The runner spawns `git` directly (not via the `bash` tool), so the `github-cli-auth` plugin's `tool.before` credential injection does **not** fire for it. For **GitHub App auth** the backup plugin mints a per-repo installation token for `origin`'s github.com slug and injects it into the runner's git env via the same `GIT_ASKPASS` helper the bash path uses (token in `TYPECLAW_GIT_TOKEN`, never in argv/config; ssh remotes rewritten to https via `insteadOf`). Classic/fine-grained PATs, SSH-key, and credential-helper setups are left untouched — the runner uses its inherited process env. Non-github origins are never minted for.

If any network step fails (rebase conflict, auth failure, network timeout), the runner aborts cleanly and spawns the `backup-diagnose` subagent. That subagent has `bash`, `read`, and `write` tools and writes a short human-readable report to `<agentDir>/sessions/backup-diagnostics.log`. The diagnose subagent is explicitly forbidden from force-pushing or resolving merge conflicts itself.

## What it maintains

Because the backup force-commits `sessions/` every idle window, each cycle lands new objects as small packs. The agent repo disables git's auto-gc (machine-local config written by `typeclaw start`) so a full repack can never fire opportunistically mid-turn — on a GB-scale agent pack that repack was measured at ~1.8GB RSS and OOM-killed the container. Reclamation therefore moves here, to the **idle backup path**:

- After a backup that made a **local commit** — including one whose later push failed, since the commit still grew local history and a remote outage must not suppress reclamation — and only when `backup.maintenance` is on, the runner probes `git count-objects -v`. The two reclamation tasks are gated **independently**, because with auto-gc off a commit produces _loose objects_, not packs:
  - `loose-objects` runs when the **loose-object count** (`count:`) exceeds its threshold — the counter that actually grows every idle cycle.
  - `incremental-repack` runs when the **pack count** (`packs:`) exceeds its threshold — consolidating the packs that `loose-objects` itself produces.
    Gating both on pack count alone would let loose objects accumulate forever while packs stayed ~0.
- **Bounded by construction.** `incremental-repack` uses the multi-pack-index to consolidate only _small_ packs, leaving the large established pack untouched — so both memory and time stay bounded, unlike a monolithic `git gc`. Both tasks are pinned with `-c pack.threads=1 -c pack.windowMemory=64m -c pack.deltaCacheSize=1` so RSS holds even on a repo predating the start-time config.
- **Same lock, best-effort.** Maintenance runs inside the same `withGitLock` as the commit/push, so a concurrent backup can't race the pack rewrite. Its outcome is logged; a failure is **never** folded into the backup result. Each task consolidates its own input, so the counts reset and both self-throttle — no wall-clock timer.

## What it contributes

| Kind     | Name                          | Notes                                                                                                                                                       |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagent | `backup`                      | Runner orchestrator. No LLM call — `handler` directly invokes the deterministic `runBackup`. Coalesced per `agentDir`.                                      |
| Subagent | `backup-message`              | Picks commit message from the diff. Has only the `write` tool. Coalesced per `agentDir`.                                                                    |
| Subagent | `backup-diagnose`             | Diagnoses push/rebase failures. Has `bash`, `read`, `write`. Coalesced per `agentDir`.                                                                      |
| Hook     | `session.turn.start` / `.end` | Maintains the active-turn counter. Excludes self-induced turns (the three subagents above) so the backup never gates against itself.                        |
| Hook     | `session.idle`                | Debouncer (idleMs). Resets the timer on every event. On fire, checks the active-turn counter and spawns `backup` if zero.                                   |
| Hook     | `session.end`                 | Removes the session from the active-turn set on session close. Defensive: if a session ends mid-turn (network drop), `session.turn.end` may not have fired. |

## Files on disk

- **`<agentDir>/.typeclaw/backup-message.tmp`** — ephemeral. Written by `backup-message` subagent, read and then deleted by the runner. The directory is created on demand. Not gitignored because it always cleans itself up before commit.
- **`<agentDir>/sessions/backup-diagnostics.log`** — append-only log written by `backup-diagnose` when push/rebase fails. Lives under `sessions/` so it gets force-added by the next successful backup. Read this file when investigating why the backup plugin stopped working.

## Why this design

This feature came up as: "periodically check for dirty files and commit; LLM picks the message and handles failures." A pre-implementation Oracle review pushed back hard on two assumptions:

1. **Don't make the core flow LLM-driven.** A subagent with `bash` orchestrating push/rebase/conflict recovery can hang on auth prompts, freestyle-mishandle conflicts, or burn an LLM call on every backup even when nothing went wrong. Instead, the deterministic runner owns the flow and only delegates two narrow tasks to LLMs: commit message synthesis (one short call, naturally bounded) and failure diagnosis (only fires on actual failures).

2. **`session.start` / `session.end` is the wrong gate.** Long-lived TUI and channel sessions stay open for hours; counting open sessions would mean the backup never fires. The new `session.turn.start` / `session.turn.end` hooks bracket each `session.prompt(...)` call across all four call sites (TUI server, cron consumer, subagent runner, channel router), so the counter reflects "active work in progress" rather than "any session connected".

`session.idle` (with debounce) was chosen over cron because it ties backup frequency to actual activity. There is no fixed `*/15 * * * *` schedule to misconfigure or re-explain. The tradeoff is the sporadic-agent case noted above.

## Tests

- `runner.test.ts` — deterministic runner unit tests (status parsing, force-add of `sessions/`, push-with-upstream, push-and-set-upstream when origin exists but tracking is absent, commit-only on no-origin / detached-HEAD, rebase-on-non-fast-forward for both push shapes, diagnose-on-rebase-conflict, advisory-throw isolation, sanitize-commit-message; and `runMaintenance` — independent loose/pack gates, loose-only vs repack-only vs both, bounded `-c` flags, `.gitstore` layout, no-op on non-repo, failure surfaced without throwing, skip-on-probe-failure, plus a **real-Git lifecycle** test proving auto-gc-disabled commits trip the loose gate and a real `git maintenance run` packs them into a valid repo).
- `git-auth.test.ts` — credential-env resolution (App-auth mints for the origin slug; PAT/SSH/non-github/unavailable-token all fall back to inherited env).
- `index.test.ts` — plugin composition tests (subagent/hook surface, config schema defaults and validation, debounce, active-turn gating, self-induced-turn exclusion, coalescing) and `backupCommitted` per-result-kind classification (post-commit push/rebase failures still gate maintenance; `clean`/`no-repo`/`commit-failed`/`aborted` do not).
