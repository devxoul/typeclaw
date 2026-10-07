---
name: typeclaw-troubleshooting
description: Use this skill when you are stuck in a fix-it loop — you've made roughly three attempts at the same failure and you're still cycling shell commands (kill the process, re-run, `sleep`, `capture-pane`, inspect, retry) without converging. Triggers include a hung or runaway process that won't die, a `C-c` that didn't stop the program, `<defunct>`/zombie processes piling up in `ps`, an interactive program that blocks `bash` waiting for input, a script that "ran" but produced no output and no file, repeated "not found"/timeout/same-error-again loops, and any moment you catch yourself thinking "let me wait a bit more and check again" for the third time. Also read it before you start a minutes-long or input-waiting program in your own session (dev server, REPL, watcher, `docker compose up`, interactive installer) — foreground `bash` blocks until exit, and this skill has the detached tmux start/observe/drive/stop pattern. Read it before you spawn `operator` to take over the debugging — it covers the operator hand-off prompt, the tmux session pattern, killing stuck/zombie processes properly, and the edge-triggered capture-pane polling loop that the inline retry-and-sleep approach gets wrong.
---

# typeclaw-troubleshooting

When a problem fights back, the failure mode is not "I can't fix it" — it's "I'm burning my own context and freezing the conversation while I fix it." A debugging loop is inherently noisy: every retry dumps stale shell output, zombie-process listings, and pane captures into your context, and each blocking `bash` call (especially `sleep N` followed by a capture) leaves the user staring at a frozen-looking conversation. The fix is to move the loop out of your session and into `operator`, which has bash-with-side-effects and runs in its own context window.

This skill is the runbook for that hand-off. Read it once you've hit the trigger (~3 attempts on the same failure without convergence), **before** you spawn `operator`. It also owns the plain long-running-command pattern below, which applies before any loop starts.

## Long-running and interactive commands

Foreground `bash` blocks until the command exits. Run minutes-long or input-waiting programs (dev servers, REPLs, watchers, `docker compose up`, installers) detached in `tmux`:

```sh
tmux new-session -d -s <name> "<cmd>"      # start
tmux capture-pane -t <name> -p             # observe
tmux send-keys -t <name> "<input>" Enter   # drive
tmux kill-session -t <name>                # stop
```

Use tmux only for work that belongs in your session. In an interactive session that can spawn subagents, delegate self-contained long work (builds, tests, installs, batches) to `operator` instead, so the conversation stays responsive. If the command starts failing in a loop, the rest of this skill applies.

## The trigger, concretely

You are in a troubleshooting loop when all of these are true:

- You've attempted the **same underlying fix** ~3 times and it still fails.
- Your recent turns are dominated by `bash` calls whose only purpose is to probe/retry: `kill`, `sleep`, `tmux capture-pane`, `ps aux | grep`, re-running the same script, "let me wait and check again".
- Each attempt produces more disposable output than signal.

If you're still making real progress (each attempt narrows the problem), keep going — this is for the _non-converging_ case. One or two quick probes stay inline; a third lap means delegate.

## Why inline retry-and-sleep is the wrong tool

Two failure patterns show up over and over when an agent debugs inline, and both are why this belongs in operator:

1. **`sleep N; capture-pane` blocks you for N seconds at a time.** You can't reply, the typing indicator can't heartbeat, and you still don't know if the work finished — you just guessed at a duration. Operator absorbs all of that latency in its own session.
2. **A `C-c` sent to a tmux pane does not always kill the program.** If the foreground process is in a tight loop (e.g. a `while True:` with `pyboy.tick()`), the interrupt may be queued behind work and never processed, so the _next_ command you type lands in the shell while the old process is still running — and you end up reading output from the wrong process. The reliable kill is by PID, not by keystroke (see below).

## The hand-off: spawn operator in background

Spawn `operator` (background by default) so your session stays free, then keep talking to the user. Give operator everything it needs — it does **not** see this conversation, and it does **not** see this skill. Operator runs on a fixed tool set (`read`, `grep`, `find`, `ls`, `bash`, `write`, `edit`) with no skill loading, so any mechanic below that you want it to follow has to be spelled out in the `[REQUEST]` block — don't assume it knows the tmux/PID/polling patterns:

```
[CONTEXT]: <what you were doing, the file/process/command involved, the environment>
[SYMPTOM]: <the exact failure — error text, "process won't die", "script ran but wrote no file", paste the relevant output>
[ALREADY TRIED]: <each attempt and what happened, so operator doesn't repeat your dead ends>
[SUCCESS CONDITION]: <something operator can verify with bash alone — "screenshot_now.png exists and is larger than 1KB", "the dev server answers 200 on :3000", "pgrep -f repro.py returns nothing">
[CONSTRAINTS]: <don't touch X, the relevant tmux session is named Y, the workdir is Z>
[REQUEST]: Drive the diagnose → fix → verify loop. Use a tmux session for any hung or interactive process so it can't block you (start detached, kill stuck processes by PID not C-c, poll on the success condition not a fixed sleep). Return root cause, what you changed, and whether the success condition is met.
```

State the success condition as something operator can check with `bash` — file exists and is non-trivially sized, a port answers, a process is gone. Operator has **no vision tools** (`look_at` is yours, not its), so "the screenshot looks right" is **not** a condition operator can verify. If the fix ultimately needs a visual check, have operator confirm the file is written and reasonably sized, then **you** call `look_at` on it after operator reports back — that final eyeball stays in your session.

Then stay responsive. When the completion `<system-reminder>` lands, weave operator's report into your next reply (in a channel session, surface it via `channel_reply`/`channel_send` — plain text is invisible there).

If the spawn is denied (no `subagent.spawn` grant at all), you can't delegate — fall back to doing the loop yourself, but apply the mechanics below to do it cleanly.

## Mechanics operator should use (and you, if you can't delegate)

### Run hung/interactive processes in a dedicated tmux session

```sh
tmux new-session -d -s fix-<short-id> -c /agent/workspace
tmux send-keys -t fix-<short-id> "python3 repro.py" Enter
```

A detached session means a process that hangs or waits for input never blocks the driver. Name it for the task (`fix-<id>`) so it's easy to find and tear down.

### Observe without blocking — edge-triggered, not `sleep`-and-guess

Don't `sleep N; capture-pane` and hope. Capture the pane, react to what's actually there, and key the next step off a real signal (a file appearing, a process exiting, a prompt string showing up):

```sh
tmux capture-pane -t fix-<id> -p -S -          # -p print, -S - full scrollback
ls -la /agent/workspace/expected-output.png    # the real done-signal
pgrep -af repro.py                             # is it still running?
```

Loop on the **success condition** (output file exists, port answers, process gone), not on a fixed sleep. If you must wait, poll in short intervals and re-check the signal each time rather than sleeping for one long guess.

### Kill stuck processes by PID, not by keystroke

`tmux send-keys ... C-c` is unreliable against a tight loop. Find the real PID and signal it:

```sh
pgrep -af repro.py                 # find the actual PID(s)
kill <pid>                         # SIGTERM first
sleep 1; pgrep -af repro.py        # still there?
kill -9 <pid>                      # SIGKILL if it ignored SIGTERM
```

### Reap zombies and confirm the field is clear

`<defunct>` entries in `ps` are zombies — already dead, waiting for their parent to reap them. They are not your hung process; chasing them wastes turns. Filter them out and confirm the _live_ process is gone before re-running:

```sh
ps aux | grep -i repro | grep -v grep | grep -v defunct
```

If the only matches are `<defunct>`, the process is already dead — re-running is safe. If a live PID remains, the previous `C-c` didn't work; kill it by PID (above) before the next attempt.

### Tear down when done

```sh
tmux kill-session -t fix-<id> 2>/dev/null || true
```

Don't leave orphaned sessions running between attempts — a stale session is how you end up sending input to the wrong process.

## What operator returns, and what you do with it

Operator's final report should give you: **root cause**, **what it changed**, and **whether the success condition is met**. Surface that to the user in your own words — don't paste the raw debugging transcript; the whole point was to keep that noise out of the conversation. If operator couldn't resolve it, relay the outcome plus the partial progress (what's now known, what's still failing) so the user can decide the next move.

Bound the loop so it can't spin as badly as the inline version would have. Tell operator in the `[REQUEST]` that if a handful of diagnose-fix-verify rounds (≈5) haven't met the success condition, it should stop and report what it found rather than keep retrying — a non-converging operator loop wastes the same tokens you delegated to avoid, it just wastes them out of sight. When that bounded-failure report comes back, bring the user in: relay the partial progress and ask how to proceed instead of immediately re-spawning operator on the same dead end.
