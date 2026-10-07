---
name: typeclaw-cron
description: Use this skill whenever the user asks you to schedule recurring work OR a one-off future task/reminder, run something on a cron, do something every day/hour/week, do something once at a future time, set up a periodic task, list or inspect scheduled jobs, or read or edit your cron schedule — AND whenever the user wants you to STOP, disable, pause, or remove a recurring/scheduled job, or complains that you "keep" posting, sending, or doing the same thing on a schedule (a repeating message you send every N minutes is almost always a cron job). Triggers include "every morning", "every Monday", "schedule a", "remind me every", "set up a cron", "run X periodically", "remind me in 3 days", "remind me tomorrow", "remind me at 9am", "remind me next Monday", "in N hours/days do X", "do X once at hh:mm", "stop after N times", "until <date>", "list cron jobs", "list scheduled jobs", "show me the cron", "what cron jobs do you have", "what's on my cron", "when does X run", as well as STOP/DISABLE triggers in any language like "turn it off", "turn that off", "stop that message", "stop sending that", "stop posting that", "stop doing that", "disable it", "disable that job", "pause that", "remove that job", "delete that cron", "why do you keep posting/sending this", "make it stop", and their non-English equivalents (e.g. Korean 꺼/꺼줘/멈춰/그만/중지/왜 자꾸, Spanish para/detén/desactiva/deja de enviar, Japanese 止めて/停止/オフにして/何度も, Chinese 停止/关闭/别再发/取消定时), or any mention of `cron.json`. Read it before touching `cron.json` — the file has a strict schema, restart semantics, and a best-effort execution model that you must not misrepresent to the user.
---

# typeclaw-cron

You have a cron file at `./cron.json` in your agent folder. It defines periodic jobs that the typeclaw runtime fires on schedule. This skill exists so you do not corrupt the file, do not promise behavior the runtime cannot deliver, and do not surprise the user.

## What cron actually does

The typeclaw runtime starts a scheduler when the container boots. The scheduler reads `cron.json` **once** at startup. While the container runs, it fires each enabled job at its next scheduled time. There is no daemon outside the container — if the container is down, nothing runs.

This is a **best-effort scheduler**. Concretely:

- **Missed ticks are not replayed.** If the container was down at 23:30 and starts at 23:45, the 23:30 fire is lost forever.
- **Overlapping fires are skipped, not queued.** If a job is still running when its next tick arrives, the new tick is dropped (logged) and the next attempt is the tick after that.
- **There are no retries, no timeouts, no failure hooks.** A job that throws is logged and forgotten until its next scheduled fire.

Tell the user this if they ask about reliability. Do not invent guarantees the runtime does not give them.

## The two job kinds

`cron.json` has one top-level key: `jobs`. Each job has a `kind` discriminator, plus shared fields and kind-specific fields.

### Shared fields (all jobs)

| Field      | Required     | Notes                                                                                                                                           |
| ---------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | yes          | Unique. Letters, digits, hyphens, underscores. Used in logs and to coalesce.                                                                    |
| `schedule` | one of these | Standard 5-field cron expression (`min hr dom mon dow`) or 6-field with seconds. Recurring. See "Schedule syntax" below.                        |
| `at`       | one of these | One-shot ISO instant — fires **once** then retires. Mutually exclusive with `schedule`; set exactly one. See "One-shot reminders (`at`)" below. |
| `until`    | no           | Recurring only. Absolute ISO instant; last allowed fire (inclusive). The job retires after this.                                                |
| `count`    | no           | Recurring only. Stop after N accepted fires. Coexists with `until` — whichever boundary is reached first wins.                                  |
| `enabled`  | no           | Defaults to `true`. Set to `false` to keep a job in the file but skip it.                                                                       |
| `timezone` | no           | IANA name like `Asia/Seoul`. Recurring (`schedule`) only — NOT valid with `at`. Defaults to UTC (the container's timezone).                     |

**`schedule` XOR `at`:** every job has exactly one of `schedule` (recurring) or `at` (one-shot). Setting both, or neither, is rejected. `at` jobs may not set `until`, `timezone`, or `count` > 1 (the instant already pins the single fire).

### `kind: "prompt"` — fire a prompt into a fresh session

```json
{
  "id": "daily-summary",
  "schedule": "30 23 * * *",
  "kind": "prompt",
  "prompt": "Read today's session jsonl files in sessions/ and summarize the day into memory/."
}
```

When this fires, the runtime opens a **brand new** `AgentSession` (yours, with your IDENTITY/SOUL/AGENTS files loaded), sends it the `prompt` text as if the user typed it, and disposes the session when done.

What this means for how you write prompts:

- **Treat the prompt as a self-contained instruction to your future self.** It runs in a session with no memory of past prompt-job runs unless you persist across runs (e.g. by writing to `MEMORY.md` or `memory/`).
- **The session has all your tools.** You can `read`, `write`, `bash`, edit files, commit to git — anything you can do in a normal turn.
- **There is no human on the other end.** No one will answer clarifying questions. Make the prompt complete and unambiguous.
- **Be specific about side effects.** "Summarize today" is vague. "Read every `sessions/*.jsonl` modified today and append a summary to `memory/$(date +%F)-summary.md`" is actionable.

### `kind: "exec"` — run a shell command, no LLM

```json
{
  "id": "hourly-backup",
  "schedule": "0 * * * *",
  "kind": "exec",
  "command": ["git", "commit", "-am", "hourly snapshot"]
}
```

The runtime spawns the command directly with `Bun.spawn` from the agent folder (`/agent` inside the container). No agent session is created. No LLM call happens. The command's exit code and stderr are captured to container logs.

Use `exec` only for jobs that are pure mechanics — no judgement required. Examples that fit: git snapshots, log rotation, calling a script that already exists. Examples that **don't** fit: anything where "what do I commit" or "what should I write" depends on context. Use `prompt` for those — **or**, when the work needs imperative control flow that mixes shell calls and LLM calls (probe → maybe prompt → write file) and both the cadence and the logic belong to the same plugin, write a `kind: 'handler'` plugin cron job (see below). That's the best practice for the `exec → LLM` pattern; a cron `exec` pointing at `typeclaw <plugin-cmd>` is a narrower fallback for reusable / host-surface cases.

`command` is an array. Index 0 is the executable, the rest are argv. Do **not** put a single shell pipeline in `command[0]` — that won't be parsed by a shell. If you need shell features (`|`, `>`, `&&`), wrap explicitly: `["sh", "-c", "your | pipeline | here"]`.

## One-shot reminders and future tasks (`at`)

When the user wants something to happen **once at a future time** — "remind me in 3 days to cancel the subscription", "ping me tomorrow at 9", "in 2 hours, check if the build finished" — use `at` instead of `schedule`. The job fires exactly once at that instant, then retires (the scheduler stops arming it; it never fires again).

```json
{
  "id": "cancel-sub",
  "at": "2026-06-11T09:00:00+09:00",
  "kind": "prompt",
  "prompt": "Remind the user to cancel the subscription they mentioned on 2026-06-08. If they already handled it, say so and move on.",
  "scheduledByRole": "owner"
}
```

`at` works with any `kind` (`prompt` for "remind me / do this judgement task", `exec` for a one-off mechanical command). The same best-effort rules apply: if the container is down at the `at` instant, the fire is **lost, not replayed**. Say so if the user is relying on it for something important.

### The `at` value MUST carry an explicit zone or offset

`at` is parsed as an **absolute instant**, so it requires a trailing `Z` or a numeric offset. A bare local-time string is rejected (it would silently resolve to UTC and surprise the user).

- ✅ `2026-06-11T09:00:00+09:00` (Seoul morning) or `2026-06-11T00:00:00Z`
- ❌ `2026-06-11T09:00:00` (no zone — rejected by `parseCronFile`)

**The `at` instant must be in the future.** Writing an enabled `at` in the past is **rejected at write time** (the `reload`/guard validation returns `"at" is in the past`), because a past reminder would be retired immediately and never fire — a silent no-op the user would mistake for a scheduled reminder. If you get this error, recompute the instant (you probably botched the timezone offset) and write again. (An already-_fired_ one-shot left on disk is the one exception — it stays valid so it can't brick reload — but you never author one of those by hand.)

**Resolving "9am" / "tomorrow" / "in 3 days" to an instant:**

1. Get the user's timezone. Check `USER.md` for a recorded zone; if it's not there and the wall-clock matters, ask once.
2. Compute the absolute instant in that zone. "Remind me in 3 days" → take now, add 3×24h (or the next 09:00 in their zone if they said a time), and emit it with the zone's offset, e.g. `+09:00`.
3. Use `bash` (`date`) if you need to compute the offset precisely rather than guessing — e.g. `date -u -d '+3 days' +%Y-%m-%dT%H:%M:%SZ`. Don't hand-roll DST math.

Do not invent `until`, `timezone`, or `count` > 1 on an `at` job — they're rejected. The single instant is the whole schedule.

### Clean up after a one-shot fires (self-prune)

A fired `at` job does **not** delete itself from `cron.json` — it stays on disk as an inert, already-retired entry (the runtime never writes back to `cron.json`; that's by design). On its own this is harmless: the scheduler sees the past instant and retires it without firing, so it will not run again and will not break reload.

But to keep `cron.json` clean, **a one-shot `prompt` job should remove its own entry as the last step of its fire.** Because the fire runs in a full agent session with all your tools, end the reminder prompt with a self-cleanup instruction. Write your `prompt` so your future self does this:

> "... After delivering the reminder, remove the cron job with id `cancel-sub` from `cron.json` and call the `reload` tool so the dead one-shot doesn't linger."

Removing a job passes the `cronPromotion` guard freely — deletions are privilege reductions and are never blocked. If the cleanup is ever skipped (model error, crash mid-session), the worst case is a harmless leftover entry you can prune on any later edit — never a broken schedule. This self-prune only applies to `prompt` jobs; an `at` `exec` job has no LLM to clean up after itself, so its entry just lingers until a human or a later prompt removes it.

## `exec → LLM`: write a plugin cron handler (best practice)

If a scheduled job needs imperative control flow that mixes shell calls and LLM calls (probe → maybe prompt → write file), the best practice is a **plugin cron handler**: a TypeScript function the plugin registers under its own `cronJobs` with `kind: 'handler'`. The cron consumer invokes it directly — no shell-out, no WS round-trip, no `Bun.spawn`. Prefer this whenever the cadence and the logic both belong to the same plugin (which is almost always — see "When to reach for the exec bridge instead" below for the two narrow exceptions).

`cron.json` itself supports only `prompt` and `exec` — `kind: 'handler'` is plugin-only because the handler is a TypeScript function reference (not JSON-serializable). User-authored cron files that try to declare `kind: 'handler'` are rejected by `parseCronFile`.

```ts
// packages/dev-audits/index.ts
import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  plugin: async () => ({
    cronJobs: {
      daily: {
        schedule: '0 22 * * *',
        timezone: 'Asia/Seoul',
        kind: 'handler',
        handler: async (ctx) => {
          const { stdout } = await ctx.exec`git log --since='24h' --pretty=format:'%h %s'`
          if (stdout.trim().length === 0) return
          await ctx.prompt(
            `These commits landed in the last 24h:\n${stdout}\nAppend a critique of weak commit messages to memory/audits/$(date +%F)-commits.md. Be specific — quote bad messages and suggest rewrites.`,
          )
        },
      },
    },
  }),
})
```

`typeclaw.json`:

```json
{
  "plugins": ["./packages/dev-audits"]
}
```

That's the whole installation. No `cron.json` edit, no CLI command shim. `typeclaw restart` and the job is live.

### The `CronHandlerContext` surface

The handler receives a `ctx` with the LLM-call surface of a container plugin command, minus the CLI-shaped fields:

| Field             | Type                                                          | Notes                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.jobId`       | `string`                                                      | The global cron id (`__plugin_<plugin-name>_<key>`). Useful for log lines.                                                                                                                                                                                                                     |
| `ctx.name`        | `string`                                                      | The plugin name that registered this cron job. Mirrors `ContainerCommandContext.name`.                                                                                                                                                                                                         |
| `ctx.agentDir`    | `string`                                                      | `/agent` in the container.                                                                                                                                                                                                                                                                     |
| `ctx.logger`      | `PluginLogger`                                                | Plugin-prefixed `info` / `warn` / `error` going to container stdout.                                                                                                                                                                                                                           |
| `ctx.signal`      | `AbortSignal`                                                 | Reserved for future cancellation; currently never aborted by the runtime (matches existing prompt/exec cron behavior — in-flight work runs to completion on container shutdown). Already threaded into `ctx.prompt` and `ctx.exec`, so future aborts propagate without handler-author changes. |
| `ctx.permissions` | `PermissionService`                                           | Same service the rest of the runtime uses. Most handlers don't need it; the LLM session resolves permissions through `ctx.origin` automatically.                                                                                                                                               |
| `ctx.origin`      | `SessionOrigin` (cron-shaped)                                 | `{ kind: 'cron', jobId, jobKind: 'handler', scheduledByRole, scheduledByOrigin }`. Plugin-contributed jobs default to `scheduledByRole: 'owner'`.                                                                                                                                              |
| `ctx.prompt`      | `(text: string) => Promise<string>`                           | Opens a brand-new agent session with the full toolset, sends `text`, returns the final assistant message. Gets the same shared system policy as every session, without the interactive orchestration context, roster, git nudge, or MCP catalog a TUI session adds.                            |
| `ctx.subagent`    | `(name: string, payload?) => Promise<void>`                   | Invokes a registered subagent. Same dispatch path as `PluginContext.spawnSubagent`.                                                                                                                                                                                                            |
| `ctx.exec`        | `` ctx.exec`shell pipeline` `` → `Promise<CommandExecResult>` | Tagged template; runs in the agent folder with `ctx.signal` threaded through. Abort kills the entire process group (SIGTERM → 5s grace → SIGKILL).                                                                                                                                             |

What's NOT on the handler ctx (and why):

- **`stdin` / `stdout` / `stderr`** — cron has no caller piping bytes in or reading bytes out. Use `ctx.logger` or write files for output.
- **`args`** — handlers are scheduled, not invoked with flags. Configurable values come through the plugin's `configSchema`.
- **Return value** — the function returns `Promise<void>`. Throw to signal failure; the cron consumer catches and logs. (Note: do NOT write `return 0` — handler return is `void`, not a numeric exit code like a container command's `run`.)

### Trust model

Plugin-contributed cron handlers run with `scheduledByRole: 'owner'` because installed plugins already execute arbitrary in-process TypeScript at boot, on every hook, and inside every tool — granting cron handlers a tighter role wouldn't be a security boundary anyway, since the plugin code already has full process privileges. The role is real (every tool call inside `ctx.prompt` resolves against it) and a future API could tighten it for specific contexts, but today plugin authors are trusted runtime contributions, not user input. See `typeclaw-permissions` for the broader model.

### When to reach for the exec bridge instead

The `kind: 'handler'` path is the right answer for plugin-internal scheduled imperative work. The exec bridge — a `kind: 'exec'` cron job invoking `["typeclaw", "<plugin-command>", ...]` — is the right answer ONLY when **reusability is a real requirement**, not just because the work is scheduled. The bridge buys you a callable CLI surface; the handler does not. Use the bridge when one of these holds:

1. **The same logic must also be invocable as a CLI command.** The user wants to run `typeclaw audit-commits --since=7d` manually from the TUI or a shell, or another plugin / `compose` orchestration wants to call it, or the work needs flags that are part of a public command interface. Write the logic once inside a `surface: 'container'` plugin command's `run`, then point cron at it. Same imperative control flow lives in the command body; cron just provides a different trigger.

2. **The user owns the cadence.** Someone else's plugin ships `audit-commits` (as a container command, see `typeclaw-plugins` §5.7) but no cron registration, or its default cadence doesn't match what the user wants. The user adds a `cron.json` exec job pointing at the command — no need to fork the plugin to change the schedule.

3. **The scheduled job needs to invoke a `surface: 'host'` command.** Host commands run outside the container with no agent runtime — neither `ctx.prompt` nor `ctx.subagent` is available there. A cron `exec` job invoking `typeclaw <host-cmd>` is the only way to schedule host-side work from inside the container's cron.

If none of those apply — the plugin owns both the cadence and the logic, and nothing else needs to call the logic — write a `kind: 'handler'` job. "It's scheduled work that needs LLM judgement" alone is NOT a reason to reach for the bridge; the bridge costs a shell-out, a WS round-trip, and an args-parse round-trip that the handler avoids entirely.

In both cases the `command` array is `['typeclaw', '<cmd>', ...]` and the runtime injects `TYPECLAW_PARENT_ORIGIN_JSON` so the spawned subprocess inherits the cron job's role through the same mechanism that protects plugin-contributed handlers from silent elevation.

```json
// cron.json — user wants someone else's plugin command on a custom schedule
{
  "jobs": [
    {
      "id": "weekly-commit-audit",
      "schedule": "0 22 * * 0",
      "timezone": "Asia/Seoul",
      "kind": "exec",
      "command": ["typeclaw", "audit-commits", "--since=7d"],
      "scheduledByRole": "owner"
    }
  ]
}
```

A plugin can ship a `kind: 'handler'` default in `cronJobs` AND the user can add a different cadence in `cron.json` for the same command. They are independent cron jobs at the scheduler layer.

### Decision rules — which arm picks what

```
"I have scheduled work" → start here

  Is the work pure mechanics (git commit, log rotation, calling a known script)?
    └─ Yes → kind: 'exec' in cron.json. No plugin needed.

  Does it need LLM judgement?
    │
    ├─ One-shot natural-language prompt, no probes, no shell pre-work?
    │   └─ kind: 'prompt' in cron.json.
    │
    ├─ Imperative control flow (probe → maybe prompt → write file)?
    │   │
    │   ├─ Default: cadence + logic both belong to the same plugin,
    │   │  nothing outside cron needs to call this logic?
    │   │   └─ kind: 'handler' in the plugin's cronJobs.  ← BEST PRACTICE
    │   │
    │   ├─ The same logic ALSO needs to be a callable CLI command
    │   │  (TUI / manual shell / compose), or the user owns the
    │   │  cadence for someone else's command?
    │   │   └─ kind: 'exec' in cron.json, command: ['typeclaw', '<cmd>']
    │   │     (write the command as surface: 'container')
    │   │
    │   └─ The work needs a `surface: 'host'` plugin command?
    │       └─ kind: 'exec' in cron.json, command: ['typeclaw', '<host-cmd>']
```

### What this pattern is NOT

- It is **not** a way to bypass permissions. Plugin `kind: 'handler'` jobs run under the plugin-default role (`'owner'`). Plugin `kind: 'exec'` and `cron.json` `kind: 'exec'` stamp `scheduledByRole` into the spawned subprocess via `TYPECLAW_PARENT_ORIGIN_JSON`; the plugin command's `ctx.origin` carries that role into every tool call inside `ctx.prompt`'s session. A cron scheduled as `scheduledByRole: 'member'` runs as a member — no silent elevation. See `typeclaw-permissions`.
- It is **not** a wrapper for shell pipelines you already have working. If `bash some-script.sh` does the job, just use that as the `command` array directly. Reach for handlers (or the exec bridge) only when LLM judgement is genuinely required inside the periodic work.

Read `typeclaw-plugins` §5.3 for the `cronJobs` registration shape, §5.7 for the full `commands` surface (host/container/either, `args` schema, `ctx.prompt` / `ctx.subagent` / `ctx.exec`, permission gating). Read `typeclaw-monorepo` for where the plugin package lives in `packages/`.

### Conditional LLM calls: gate `ctx.prompt` behind a cheap check

Most polling-style cron jobs are skewed: they fire often (every 5 minutes, every hour) and **most ticks find no work**. A plain `kind: "prompt"` job spends a full LLM round-trip every tick just to discover there's nothing to do. That gets expensive fast — a 5-minute "check for new emails" prompt is ~290 LLM calls a day, even on days where nothing arrived.

`kind: 'handler'` fixes this naturally because `ctx.exec` runs **before** `ctx.prompt`. Do the cheap check first; only spend tokens when there's actual work:

```ts
// packages/inbox-watch/index.ts
import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  plugin: async () => ({
    cronJobs: {
      watch: {
        schedule: '*/15 * * * *',
        kind: 'handler',
        handler: async (ctx) => {
          // Cheap shell check: 0 LLM cost, ~100ms.
          const { stdout, exitCode } = await ctx.exec`gmail unread --since=15m --count`
          if (exitCode !== 0) {
            // Don't drag the LLM into shell failures — log and bail.
            ctx.logger.error(`gmail probe failed (exit ${exitCode})`)
            return
          }
          const count = Number.parseInt(stdout.trim(), 10)
          if (!Number.isFinite(count) || count === 0) {
            // Nothing to do. Return silently so cron logs stay quiet.
            return
          }
          // Expensive LLM path: only reached when there's actual work.
          await ctx.prompt(
            `There are ${count} unread emails since 15m ago. Use the gmail skill to read them, summarize anything that needs a human reply, and append to memory/inbox/$(date +%F).md.`,
          )
        },
      },
    },
  }),
})
```

The shape that matters:

1. **Probe with `ctx.exec` (or an `await` on a Node API) first.** Anything that returns a yes/no signal cheaply: a CLI tool exit code, a count, a file mtime, an HTTP HEAD, a `git log -1 --since=...` output.
2. **Return early when the probe says "no work".** A bare `return` exits the handler cleanly, cron logs nothing scary, and zero LLM tokens were spent. Critically: do NOT call `ctx.prompt` to "decide whether to act" — that defeats the entire optimization.
3. **Reach for `ctx.prompt` only on the work path.** Pass the probe's output into the prompt so the agent doesn't have to re-discover what triggered the run (e.g. `${count} unread emails`, the list of changed files, the new commit hash). This also shortens the LLM's first turn — it gets to act, not investigate.

Concrete signals you can probe cheaply (in rough order of common use):

| Question                            | Cheap probe                                                           |
| ----------------------------------- | --------------------------------------------------------------------- |
| Are there new emails?               | `gmail unread --since=15m --count` (or your skill's CLI)              |
| Did anyone commit since last check? | `git log --since=15m --pretty=oneline` (empty = no)                   |
| Did a file change?                  | `find <path> -newer .inbox-watch.stamp -type f`                       |
| Is there a new PR/issue?            | `gh pr list --search 'created:>15m' --json number` (empty array = no) |
| Did a service go down?              | `curl -fsS https://... > /dev/null` (non-zero = down)                 |
| Is there a new line in a log?       | `wc -l <log>` vs a stamp file                                         |
| Did `last-run.txt` rot to stale?    | `find last-run.txt -mmin +60` (empty = fresh)                         |

For "since last run" semantics, write a stamp file at the end of every successful run: `await ctx.exec\`touch .inbox-watch.stamp\``. The next tick's probe compares against it via `-newer`or`mtime`. Stamp files belong in `workspace/`or under`memory/state/` — never at the agent root.

When NOT to gate:

- **The work is small enough that the LLM probe is the action.** A daily "summarize today" job that always has something to summarize doesn't need a gate; the prompt does the work.
- **The probe is as expensive as the prompt.** If your "is there work?" check requires reading 200 files anyway, just let the LLM do it once with the full toolset.
- **You genuinely want the LLM to decide intent on every tick.** Rare, but valid — e.g. a "morning standup" job that always produces output regardless of how busy yesterday was.

Pitfalls to avoid:

- **Don't promise the user "the agent checks every 5 minutes" if you've written `*/5 * * * *` without a gate.** That's 12 LLM calls an hour for empty inboxes. Either gate it, or slow the schedule to match what the work actually warrants.
- **Don't gate inside `ctx.prompt` itself** ("if there are new emails, do X; else do nothing"). The LLM still ran. The gate has to be in shell code outside `ctx.prompt`.
- **Don't leak probe failures into the LLM session.** If `ctx.exec` exits non-zero, decide explicitly: log via `ctx.logger.error` and bail (`return`), `throw` to surface the failure in cron logs, or recover with a fallback path. Don't fall through into `ctx.prompt` with no input — the agent will improvise, and the improvisation is usually worse than a clean `cron failed: ...` log line.

## Schedule syntax

Standard cron, parsed by [`cron-parser`](https://github.com/harrisiirak/cron-parser). 5-field is the common form.

```
*    *    *    *    *
┬    ┬    ┬    ┬    ┬
│    │    │    │    └─ day of week (0-7, SUN-SAT, 0 and 7 both = Sunday)
│    │    │    └────── month (1-12, JAN-DEC)
│    │    └─────────── day of month (1-31)
│    └───────────────── hour (0-23)
└─────────────────────── minute (0-59)
```

Common patterns:

| Schedule       | Meaning                            |
| -------------- | ---------------------------------- |
| `*/15 * * * *` | every 15 minutes                   |
| `0 * * * *`    | every hour, on the hour            |
| `30 9 * * 1-5` | 09:30 every weekday                |
| `0 0 * * 0`    | Sunday midnight                    |
| `0 0 1 * *`    | first day of every month, midnight |

Predefined aliases also work: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`.

If you set `timezone`, the schedule is interpreted in that zone. **Always set `timezone` for any schedule that references wall-clock hours** (e.g. "every morning at 7"); otherwise it runs in UTC and will surprise the user.

## Editing `cron.json` safely

`cron.json` is a single canonical file at the agent folder root. It is committed to git (not gitignored). Treat it like a config file you own.

### Workflow

1. **Read the whole file first** with the `read` tool. Don't assume what's in it.
2. **Modify in memory.** Add, remove, or change jobs in the parsed JSON.
3. **Write the whole file back** with the `write` tool. Always pretty-printed (2-space indent), trailing newline, sorted-stable order. The `cronPromotion` security guard is **caller-role-aware** and no longer accepts `acknowledgeGuards` — the ack flag is ignored for this guard. Instead, the guard checks whether the change schedules deferred work above your current resolved role:
   - **Passes automatically (no ack needed or possible):** adding a new job whose `scheduledByRole` is at or below your role; editing the body (`kind`, `prompt`, `command`, `subagent`, `payload`) of a job whose `scheduledByRole` is at or below your role; changing `scheduledByRole` to a value at or below your role; re-enabling a job whose `scheduledByRole` is at or below your role; removing a job; disabling a job (`enabled: true → false`); cadence-only changes (`schedule`/`timezone`).
   - **Blocked:** adding a job with `scheduledByRole` above your role; changing `scheduledByRole` to a value above your role; editing the body of a job whose `scheduledByRole` is already above your role; re-enabling a job whose `scheduledByRole` is above your role. These are the deferred-laundering attacks the guard exists to catch.

   The role tower is `owner > trusted > member > guest`. A `member` session can freely add or edit jobs stamped `scheduledByRole: "member"` or `"guest"`, but cannot touch jobs stamped `"owner"` or `"trusted"`. When blocked, the resolution is NOT an ack — make the change from a session that already resolves to a sufficiently high role (the TUI is always `owner`; a role granted `security.bypass.medium` also bypasses), or claim the role out-of-band via `typeclaw role claim` from the host CLI. **Never attempt to schedule a job that fires as a role higher than the requesting channel speaker** — that is exactly the deferred-privilege-escalation attack the guard blocks.

4. **Apply with the `reload` tool.** Call the `reload` tool — it re-reads `cron.json` and updates the live scheduler. The tool returns `[cron] ok: ...` with an added/removed/updated/unchanged summary on success, or `[cron] failed: ...` with the exact validation error on failure. **If reload fails, the live schedule is left unchanged** — fix `cron.json` based on the error message and call `reload` again.
5. **Commit the change** _after_ a successful reload. See the `typeclaw-git` skill for the commit-message rule (decision context required). `cron.json` is not gitignored, so an uncommitted edit will pollute your next commit.

### Stopping a job the user is complaining about

If a user tells you to **stop / turn off / disable** something you keep doing — most often a message you post to a channel on a repeating cadence ("turn that off", "stop sending this", "왜 자꾸 보내", "make it stop") — that repeating side effect is almost always one of your own cron jobs firing a `prompt`. The channel message that annoys them carries **no marker** tying it back to a job, so you have to find it yourself. Do this:

1. **Read `cron.json`** (or run `typeclaw cron list` for the live view incl. plugin jobs). Find the job whose `prompt`/`command` produces the thing the user is complaining about — match on the content of the repeated message, the cadence they mention ("every 30 minutes"), or the channel it lands in.
2. **Disable or remove it.** Set `"enabled": false` to keep the entry but stop it firing (reversible), or delete the job entry entirely if they want it gone. Both pass the `cronPromotion` guard automatically — disabling and removing are privilege reductions, never the deferred-grant the guard blocks. Do **not** edit the job's `prompt`/`command` body just to neutralize it; that is a body change that may be blocked if the job fires above your current role, and it's the wrong tool anyway.
3. **Call `reload`.** Until you do, the live scheduler keeps firing the old job no matter what you wrote to disk — saying "I turned it off" without a successful `reload` is the single most common way to fail this. Confirm the reload summary shows the job under `removed`/`updated` before you tell the user it's stopped.
4. **Commit** after the reload succeeds.

If you genuinely can't find a matching job (and it isn't a plugin handler job, which you cannot disable via `cron.json` — those are owned by the plugin), say so plainly instead of promising a fix you can't deliver.

### Required fields checklist (catch this before writing)

For every job you add:

- `id` is unique within the file
- `id` matches `[a-zA-Z0-9_-]+` (no spaces, no slashes, no dots)
- Exactly one of `schedule` or `at` is set (never both, never neither)
- If recurring: `schedule` parses as cron
- If one-shot: `at` is a future ISO instant **with an explicit `Z` or numeric offset**, and `until`/`timezone`/`count` > 1 are absent
- `kind` is exactly `"prompt"` or `"exec"`
- If `prompt`: `prompt` is non-empty
- If `exec`: `command` is a non-empty array of non-empty strings
- If a wall-clock `schedule` was requested: `timezone` is set

### Applying changes — the `reload` tool

The scheduler does **not** auto-reload `cron.json` when you edit it. You must call the `reload` tool to apply changes. There is no file watcher by design — reload is explicit so you always know when the live schedule changed.

**Safety contract**: reload validates `cron.json` first. If validation fails (bad JSON, invalid cron expression, duplicate id, etc.), the live schedule is left running with the previous configuration and `reload` returns the failure reason. Reload cannot break the running agent.

**The user can also reload from the host** with `typeclaw reload`. You don't need to ask them to — call the tool yourself when you finish an edit. But be aware they have the same primitive available.

If you finished an edit and the user only sees an in-flight job from the previous schedule, that job will complete naturally — reload never interrupts a running fire. Tell the user this if they wonder why their old job is still wrapping up.

## Things you must not do

- **Do not edit `cron.json` from inside an `exec` job's `command`.** Exec jobs run without an LLM and have no way to call the `reload` tool, so the file mutation will not take effect until something else triggers a reload. If you genuinely need scheduled cron-management, write a `prompt` job whose prompt is "edit cron.json to ..." and let the prompt-fire's session call `reload` itself.
- **Do not put secrets in `prompt` or `command`.** `cron.json` is committed to git. Reference env vars or files instead (`["sh", "-c", "curl -H \"Authorization: Bearer $TOKEN\" ..."]`).
- **Do not promise sub-second precision or guaranteed execution.** This is best-effort — see "What cron actually does" above.
- **Do not invent fields the schema doesn't support** (no `retry`, `timeout`, `onFailure`, `concurrency`, etc.). They will be silently ignored at best, or rejected at worst.

## When the user says "every X" or "do X once"

0. **Recurring or one-shot?** This is the first fork.
   - **Recurring** ("every morning", "every Monday", "hourly") → use `schedule`. Continue with step 1 below.
   - **One-shot / future task** ("remind me in 3 days", "tomorrow at 9", "in 2 hours", "do X once at hh:mm") → use `at` with an absolute instant (explicit zone/offset). See "One-shot reminders and future tasks (`at`)" above for resolving the instant and self-prune. Then pick the kind (almost always `prompt` for a reminder) and skip straight to step 4. Don't set `schedule`, `timezone`, `until`, or `count` on it.

For a **recurring** job:

1. **Pick the kind.**
   - **Pure mechanics, no judgement** (git snapshots, log rotation, calling an existing script) → `kind: 'exec'` in `cron.json`. Done.
   - **One natural-language instruction, no shell pre-work, no conditional logic** → `kind: 'prompt'` in `cron.json`. Done.
   - **Imperative control flow mixing shell calls and LLM calls** (probe → maybe prompt → write file, "if there are new emails then triage", etc.) → **write a `kind: 'handler'` plugin cron job** (see "`exec → LLM`: write a plugin cron handler" above). This is the default for scheduled `exec → LLM` work.
   - **Reuse a CLI command on a custom cadence** — the same logic must ALSO be invocable from the TUI / manual shell / `compose` orchestration, or the schedule is owned by the user (`cron.json`) rather than the plugin author, or the work must run as a `surface: 'host'` command → `kind: 'exec'` in `cron.json` with `command: ["typeclaw", "<plugin-command>", ...]`. Reach for this ONLY when reusability is the actual requirement, not just because the work is scheduled. See "When to reach for the exec bridge instead" above.
2. **Translate the cadence to cron.** "Every morning at 7" → `0 7 * * *`. "Every weekday at 9:30" → `30 9 * * 1-5`. "Every five minutes" → `*/5 * * * *`. If you are not sure, ask once. Don't guess on tricky cases like "every other Friday". If the user wants the recurrence to stop ("until end of quarter", "only 5 times"), add `until` (absolute ISO instant) and/or `count` (N fires).
3. **Timezone.** If the user mentioned a wall-clock time, set `timezone` to their zone. If unknown, ask once or default to the timezone in `USER.md` if it's recorded there.
4. **Pick a stable `id`.** Use kebab-case that describes the job, not the schedule. `daily-summary` not `0-23-30`.
5. **Write it. Call `reload`. If reload succeeded, commit it.** If reload failed, fix `cron.json` based on the error and retry — do not commit a broken file. Adding a new job whose `scheduledByRole` is at or below your current role passes the `cronPromotion` guard automatically — no ack is needed or accepted. If the job's `scheduledByRole` is above your current role, the guard blocks the write; make the change from a higher-role session (TUI is always `owner`) or via `typeclaw role claim` from the host CLI. See step 3 of "Editing `cron.json` safely" for the full caller-role-aware model.

## Listing what is currently scheduled

When the user asks _"what cron jobs do you have?"_, _"list cron jobs"_, _"show me the cron schedule"_, _"when does X next run"_, the answer is **`typeclaw cron list`**, not `read cron.json`.

```sh
bash$ typeclaw cron list
```

The command runs on the host stage and asks the running container for its merged registry: every job authored in `cron.json` PLUS every job contributed by plugins (e.g. the bundled memory plugin's `dreaming` cron, which is invisible from `cron.json` alone). Output includes id, source (`user` vs `plugin:<name>.<localId>`), schedule, next-fire timestamp + relative duration, scheduled-by role, and kind-specific tail. Use `--json` if you want to pipe into anything.

Why not just `read cron.json`?

- It misses every plugin-contributed job. The user almost always wants the merged view.
- It does not show next-fire times. The user is usually asking about _when_, not _what_.
- It does not validate the file — a `cron list` will surface invalid schedules and unknown subagent references the live scheduler would reject.

Read `cron.json` directly only when you are **editing** it. For any read-only "what is scheduled" question, use `typeclaw cron list`.

`typeclaw cron list` requires the container to be running. If `cron list` reports the agent is unreachable, suggest `typeclaw start` or fall back to reading `cron.json` directly (with a note that plugin jobs are missing from the view).

## Reading cron history

There is no "list past fires" tool. To see what cron has done:

- **Container logs:** `docker logs <container>` shows `[cron] firing prompt <id>` and `[cron] <id> failed: ...` lines, plus stdout/stderr from `exec` jobs. The user runs this on the host stage.
- **Session jsonl:** every `prompt` fire creates a session under `sessions/`. The session metadata includes timestamps. You can `read` and `grep` these.
- **Git log:** if a job commits its work (e.g. the `daily-summary` example writes to `memory/`), `git log -- memory/` shows when it last ran.

If the user asks "did the daily summary run?", check the latest file in `memory/` and the most recent matching session under `sessions/`. Don't claim it ran if you can't see evidence.
