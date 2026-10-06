# Contributing to TypeClaw

Thanks for considering a contribution. This file covers the mechanics of working on TypeClaw itself — setting up a local dev loop, running checks, and shipping a PR. For the architectural why-and-how (stages, hostd, message stream, plugin contracts, testing philosophy), read [AGENTS.md](./AGENTS.md). It's written for the same audience as this file.

## Requirements

- **Bun** ≥ 1.1 (CI pins 1.4.0; 1.3.x and 1.4.x both work locally)
- **Docker** or **OrbStack** — TypeClaw runs every agent in a container, so you need a working Docker daemon to exercise `typeclaw start`, `tui`, `logs`, `reload`, etc.
- **Git** ≥ 2.40 — worktrees are how most maintainers juggle branches here. Put them under the gitignored `.worktrees/` at the repo root (`git worktree add .worktrees/<name> -b <branch>`), and run `bun install` inside each one — a fresh worktree has no `node_modules`.

Nothing else. No global toolchain, no Node, no Python.

## Getting the code

```sh
git clone https://github.com/typeclaw/typeclaw
cd typeclaw
bun install
bun run test
```

`bun install` runs `postinstall`, which regenerates the four JSON schemas at the repo root (`typeclaw.schema.json`, `cron.schema.json`, `secrets.schema.json`, `auth.schema.json`) from the Zod sources. If you change a schema, re-run `bun install` (or `bun run generate:schema`) before committing — the generated files are tracked.

## Local dev loop (recommended)

The fastest way to iterate on TypeClaw is to point a real agent folder at your local checkout instead of the published npm package. `bun link` makes this a one-liner.

**1. Register the local checkout as a global `typeclaw` binary:**

```sh
cd ~/workspace/typeclaw
bun link
```

This puts a `typeclaw` shim on your `PATH` that resolves to `src/cli/index.ts` in this repo. No build step, no rebuild on every edit — every invocation reads the source you just wrote.

**2. Use it to scaffold a real agent:**

```sh
mkdir -p ~/agents/typeey && cd ~/agents/typeey
typeclaw init
```

The `typeclaw` you just ran is the one from your repo. When `init` runs from a linked checkout, it auto-detects the repo root (by walking up from the running script and finding the `package.json` whose `name` is `typeclaw`) and writes `"typeclaw": "file:../../workspace/typeclaw"` (or whatever relative path applies) into the new agent's `package.json`. The agent's `node_modules/typeclaw` then resolves straight into your checkout — no copy, no rebuild.

**3. Start the agent and iterate:**

```sh
typeclaw start    # builds the dev image (oven/bun:1.4.0-slim base) and runs the container
typeclaw tui      # attach a TUI to the running agent
```

Edit code in `~/workspace/typeclaw`, then in the agent folder:

- **Host-side changes** (CLI commands, hostd, init flow): re-run the host command. The shim picks up the new source immediately.
- **Container-side changes** (`src/agent/`, `src/server/`, bundled plugins, tools): `typeclaw restart` to bounce the container. The agent folder is bind-mounted at `/agent`, and `node_modules/typeclaw` inside it resolves to your checkout via the `file:` spec, so source-only edits land without a rebuild.
- **`Dockerfile` or `package.json` changes** that affect the image: `typeclaw start --build`. The CLI detects `file:`-linked typeclaw deps and threads `bun install --force` so the lockfile rewrites cleanly.

Why this flow instead of `bun add -g typeclaw`? On a dev machine, the published package is always one release behind your working tree, and global reinstalls clobber whatever you're editing. Linking once and forgetting is the only stable setup.

> **Tip.** Keep one "throwaway" agent folder (`~/agents/typeey` is a fine name — it's the mascot) just for poking the CLI. Don't reuse your production agent folder for dev — `typeclaw start --build` rewrites the `Dockerfile` and `.gitignore` every run, which is fine for a scratch folder and annoying for one with uncommitted work.

To revert to the published version later:

```sh
cd ~/workspace/typeclaw
bun unlink                # unregisters the global shim
bun add -g typeclaw       # reinstalls from npm
```

## Pre-commit checks

All three must pass before every commit. No exceptions, no `--no-verify`:

```sh
bun run typecheck
bun run lint
bun run format
```

CI runs the same three commands plus `bun test --parallel`. Run the tests locally too — they're fast (`--parallel` shards across CPUs) and most of them don't need Docker:

```sh
bun run test
```

A handful of tests in `src/init/` shell out to a real `bun install` and take 4-5s each; that's normal. CI uses `--timeout 30000` for the same reason — keep yours at the default unless you see false negatives.

## Repo layout (the bits you'll touch)

```
src/
├── cli/               # UI-only: citty, clack, spinners, process.exit
├── init/              # `typeclaw init` pipeline
├── container/         # host-side Docker orchestration (start, stop, logs)
├── hostd/             # host singleton daemon (port broker, tunnels, control protocol)
├── server/            # container-side websocket server
├── agent/             # AgentSession, system prompt composition, tools
├── channels/          # router + manager + per-platform adapters
├── plugin/            # plugin contract and registry
├── bundled-plugins/   # memory, backup, scout, agent-browser, security, ...
├── secrets/           # .env <-> secrets.json bridge
├── permissions/       # role + match-rule DSL
└── stream/            # message stream targets (TUI, channels, subagents)

scripts/
├── generate-schema.ts        # postinstall hook
├── dump-system-prompt.ts     # `bun run debug:prompt`
└── require-parallel.ts       # lint that forbids serial subagent dispatch

docs/                         # typeclaw.dev (Next.js + Fumadocs); ships in-tree
```

Tests live next to code as `<file>.test.ts`. Domain logic lives in `src/<domain>/`; `src/cli/` is a thin shell that delegates to it.

## Stages (read this before debugging)

TypeClaw code runs in three stages with different filesystems, process owners, and invocation paths. Confusing them is the most common source of "this works on my machine but not in the container":

- **dev stage** — running `bun run test` on this repo. No agent folder, no container.
- **host stage** — the user's cwd after `typeclaw init`. Holds `typeclaw.json`, `.env`. Host commands (`start`, `stop`, `tui`, `logs`, `compose`) are launchers.
- **container stage** — inside Docker, with the agent folder bind-mounted at `/agent`. The container's entrypoint is `typeclaw run`.

Annotate stages on paths in code and PR descriptions: `./typeclaw.json` = host stage, `/agent/typeclaw.json` = container stage. AGENTS.md has the full rules-of-thumb table.

## Debugging the system prompt

```sh
bun run debug:prompt                     # dumps all 4 session origins
bun run debug:prompt --origin cron       # just one
bun run debug:prompt --origin channel --no-git-nudge
```

The renderer is `composeSystemPrompt` in `src/agent/index.ts`. Every standard origin starts with the same shared policy (`buildSystemPolicy`); the cache-suffix ordering (least-volatile first: shared policy → identity → runtime → interactive context (full mode) → origin → role → MCP → git → proactive-model nudge) is pinned by the composition tests; reorder one without the other and CI fails. Time, live role, and memory are per-turn user-prompt context, not system-prompt sections. The dump is TypeClaw's preamble only — pi appends project context (`AGENTS.md`), the skill catalog, and cwd when it builds the session — and its token column is a chars/4 estimate, not a tokenizer count.

## Commit and PR conventions

- **Subject style**: `<area>: <imperative summary>` in lowercase, no trailing period. Examples from recent history:
  - `channels: stop replying to KakaoTalk notification feed (type=71)`
  - `server: persist sessions from plugin command/cron-handler ctx.prompt`
  - `readme: show off typeey at the top of the repo readme`
- **One concern per commit.** Refactors get their own commit, separate from the bugfix or feature that motivated them.
- **PRs go against `main`.** The repo uses a single long-lived branch; release tags are cut from it by the **Release** workflow.
- **Docs ship in the same PR** as the code that motivates them. The published site at [typeclaw.dev](https://typeclaw.dev) rebuilds from `docs/content/docs/`.
- **No `--no-verify`, no skipped CI.** If a check is in your way, fix the check.

## Scrubbing local info before pushing

This repo's `AGENTS.md` has a long section on scrubbing local environment leaks from diffs, commit messages, and PR bodies. The short version:

- No absolute paths from your machine (`/Users/you/...`, `/home/you/...`)
- No real hostnames, usernames, or LAN IPs
- No secrets, even expired ones
- No personal config snippets or terminal prompts in PR bodies

Tests count as committed code — use `mkdtemp(join(tmpdir(), '...'))` for filesystem fixtures and placeholders (`alice@example.com`, `test-host`, `/path/to/file`) for the rest. Never hardcode real names, paths, or IDs.

## Releases

Releases go through the **Release** GitHub Actions workflow (`workflow_dispatch`). Maintainers run it; contributors don't need to think about it. The flow is documented in [AGENTS.md → Release](./AGENTS.md#release), including the load-bearing GHCR-first-then-npm ordering and the patch-vs-minor decision rule.

## Where to ask

- **Bug reports and feature requests** → [GitHub Issues](https://github.com/typeclaw/typeclaw/issues)
- **Architecture questions** → read [AGENTS.md](./AGENTS.md) and the [Internals docs](https://typeclaw.dev/docs/internals) first; open an issue with the `question` label if it's still unclear
- **Security issues** → don't open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/typeclaw/typeclaw/security/advisories/new) instead.

Happy hacking.
