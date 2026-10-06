---
name: typeclaw-plugins
description: TypeClaw plugin authoring and operation guide. Use when writing, editing, configuring, debugging, or installing a TypeClaw plugin — including any work with definePlugin, defineTool, defineSubagent, plugin hooks (session.start/end/idle/prompt, tool.before/after), plugin cron jobs, plugin commands (host/container/either CLI subcommands callable as `typeclaw <name>`), plugin skills, the typeclaw/plugin import path, or per-plugin config blocks in typeclaw.json. Also use when you need to bridge a cron `exec` job to LLM-driven work — the canonical pattern is a `surface: 'container'` plugin command whose `run` calls `ctx.prompt(...)`, invoked as `typeclaw <command>` from cron's `command` array. Triggers on mentions of 'TypeClaw plugin', 'definePlugin', 'plugin hook', 'plugin cron', 'plugin command', 'PluginCommand', 'ContainerCommand', 'HostCommand', 'EitherCommand', 'ctx.prompt', 'ctx.subagent', 'ctx.exec', 'plugins[]', 'typeclaw-plugin-', 'plugin permission', 'definePlugin permissions', 'missing permission', 'permission-gated tool', or any file under src/plugin/ or plugins/.
---

# TypeClaw Plugins

A plugin is a TypeScript module with **one default export** — a call to `definePlugin({ ... })`. The factory returns a contributions object that the runtime translates into tools, subagents, cron jobs, skills, and event hooks. Plugins import only from `typeclaw/plugin` and `zod`.

This skill covers BOTH authoring new plugins AND operating existing ones (config layout, debugging failures, lifecycle).

---

## 1. The Architectural Boundary (read first)

Three layers, sharply separated:

```
Plugin API (typeclaw/plugin)  ← plugins live here. NO @earendil-works/* imports.
        ↓
TypeClaw runtime (src/plugin, src/agent, src/run, src/server, src/cron)
        ↓
Engine (@earendil-works/pi-coding-agent)  ← never visible to plugins
```

**MUST NOT** import anything from `@earendil-works/*` in plugin code. The single bridge file is `src/agent/plugin-tools.ts` (runtime layer, not plugin layer). The boundary is enforced by convention — no lint rule today, but `grep` confirms no `src/plugin/**` file imports `@earendil-works/*`.

**Allowed plugin imports**: `typeclaw/plugin`, `zod`, Node built-ins, your own modules.

---

## 2. Minimum Viable Plugin

```ts
// my-plugin.ts
import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  plugin: async (ctx) => ({
    hooks: {
      'session.prompt': (event) => {
        event.prompt += `\n\n[plugin: ${ctx.name}]`
      },
    },
  }),
})
```

That's it. No manifest. No `name`. No `version`. The plugin's name is **derived** at load time (see §4).

---

## 3. Plugin with Config (typed `ctx.config`)

`definePlugin` infers `TConfig` from the literal `configSchema`. **You never write the generic.**

```ts
import { z } from 'zod'
import { definePlugin, defineTool } from 'typeclaw/plugin'

export default definePlugin({
  configSchema: z.object({
    schedule: z.string().default('0 9 * * 1'),
    journalDir: z.string().default('journal'),
  }),
  plugin: async (ctx) => {
    // ctx.config is typed: { schedule: string; journalDir: string }
    return {
      cronJobs: {
        'weekly-digest': {
          schedule: ctx.config.schedule,
          kind: 'prompt',
          prompt: 'Compile this past week into a digest.',
        },
      },
      tools: {
        lookup: defineTool({
          description: 'Look up a journal entry by date.',
          parameters: z.object({ date: z.string() }),
          async execute(args, toolCtx) {
            return { content: [{ type: 'text', text: `looked up ${args.date}` }] }
          },
        }),
      },
    }
  },
})
```

Without `configSchema`, `ctx.config` is `never` and any reference is a type error.

---

## 4. Loading & Naming (typeclaw.json)

```json
{
  "$schema": "./node_modules/typeclaw/typeclaw.schema.json",
  "model": "fireworks/...",
  "plugins": ["typeclaw-plugin-standup-log", "@acme/typeclaw-plugin-foo", "./plugins/local-thing"],
  "standup-log": { "schedule": "0 17 * * 5" },
  "foo": { "...": "..." },
  "local-thing": { "...": "..." }
}
```

### Plugin name derivation (you do NOT declare it)

| Source      | Rule                                                      | Example → Name                                |
| ----------- | --------------------------------------------------------- | --------------------------------------------- |
| NPM package | strip leading scope, then strip `typeclaw-plugin-` prefix | `@acme/typeclaw-plugin-foo` → `foo`           |
| NPM package | strip `typeclaw-plugin-` prefix                           | `typeclaw-plugin-standup-log` → `standup-log` |
| NPM package | no prefix → use as-is                                     | `my-cool-pkg` → `my-cool-pkg`                 |
| Local path  | basename, strip extension                                 | `./plugins/local-thing.ts` → `local-thing`    |

The **derived name is the key** for the per-plugin config block at the top level of `typeclaw.json`. Two plugins with the same derived name are a boot error.

Use the entry format that matches the plugin's source:

- **Published npm plugin** → put the npm package specifier in `plugins[]`, e.g. `"typeclaw-gws-multi-account"` or `"typeclaw-plugin-standup-log@1.2.3"`. Do **not** invent a `./packages/...` path for a published package.
- **Local plugin you are authoring in this agent folder** → put its relative path in `plugins[]`, e.g. `"./packages/my-plugin"`. The path must exist and point at local plugin code.

If the user says to add/install an existing plugin by package name, preserve that package name. Only use `./packages/<name>` when you are creating or wiring a local workspace package that exists in this repo.

### Local path safety

Local plugin paths **must resolve inside `agentDir`**. Absolute paths (`/etc/...`) and parent-traversing paths (`../../foo`) are rejected with:

```
plugin path escapes agent directory: <entry> (resolved to <abs-path>)
```

This is why `./plugins/x.ts` works and `/Users/me/x.ts` does not.

### Recommended location for new local plugins: `packages/<plugin-name>/`

This section is about plugins you are **authoring locally**. For a published npm plugin, keep the npm package specifier in `plugins[]`; do not create or guess a local path.

The agent folder is a **bun monorepo**, and `packages/` is its workspace root. **Custom local plugins go there.** A `./packages/standup-log/` plugin is a real workspace package — bun installs its dependencies, the workspace symlink machinery makes it importable, and it lands in git like any other reusable code. Concretely:

```
packages/
  standup-log/
    package.json
    index.ts            # exports default definePlugin({ ... })
    index.test.ts
```

```json
// typeclaw.json
{
  "plugins": ["./packages/standup-log"],
  "standup-log": { "schedule": "0 17 * * 5" }
}
```

The derived plugin name is `standup-log` (basename of the path), so the per-plugin config block uses that key. Read the `typeclaw-monorepo` skill for the full package layout, dependency wiring (`workspace:*`), root-script conventions, and how to share code between multiple workspace packages.

Putting plugins anywhere else (a top-level `./plugins/` folder, a script under `workspace/`, an absolute path) works — but loses the workspace's dependency hoisting, gets you no `bun install` integration, and (for `workspace/`) silently disappears on the next clone because `workspace/` is gitignored.

### Boot-time effects

- `plugins` is a **`restart-required`** field. Editing the array (add/remove/reorder) needs `typeclaw restart` to take effect — `reload` won't pick it up.
- A factory throw, a `configSchema` rejection, a duplicate plugin name, or a duplicate tool/subagent/skill/cron name → **boot fails**. All registrations from the offending plugin are atomically rolled back.

---

## 5. The Contributions Object

```ts
type PluginExports = {
  tools?: Record<string, Tool>
  subagents?: Record<string, Subagent>
  cronJobs?: Record<string, PluginCronJob>
  skills?: Record<string, PluginSkill> // string-form
  skillsDirs?: string[] // file-form (absolute paths)
  hooks?: Hooks
}
```

Every key is optional. The runtime reads each and wires it in.

### 5.1 `tools` — global names

```ts
import { z } from 'zod'
import { defineTool } from 'typeclaw/plugin'

tools: {
  standup_query: defineTool({
    description: 'Read past journal entries.',
    parameters: z.object({ date: z.string().optional() }),
    async execute(args, toolCtx) {
      // toolCtx: { signal, sessionId, agentDir, logger }
      return { content: [{ type: 'text', text: '...' }] }
    },
  }),
}
```

- Tool names are **global**. Two plugins cannot register the same name.
- `parameters` is a **Zod schema**. The runtime converts to JSON Schema via `z.toJSONSchema(schema, { io: 'input', reused: 'inline' })`.
- Args are **validated once** before `tool.before` hooks see them — no double-parse. Hooks receive `event.args` as a **mutable bag** (`Record<string, unknown>`); mutations propagate to later hooks and to `execute`.
- `ToolContext` is **stripped down** to `{ signal, sessionId, agentDir, logger }`. It does NOT expose the engine's `ExtensionContext`. If your tool wants `read`/`bash`/etc., it cannot call them — declare a subagent with `tools: [readTool, ...]` instead.
- `ToolResult.content` uses TypeClaw's `ContentPart` union: `{ type: 'text'; text }` or `{ type: 'image'; mimeType; data }`.
- Tools have **no `permissions` field**. To gate one per role, declare the string on the plugin and block from a `tool.before` hook — and grant it in `typeclaw.json`, or the tool is dead for every caller. See "`permissions: [...]` — declaring and gating" in §5.7.

#### Declare every filesystem operand

Tools that accept local paths must declare them with `fileOperands`. Entries are dotted argument paths; array indexes are omitted, so `attachments.path` covers every `args.attachments[].path`.

```ts
defineTool({
  description: 'Transform a local file.',
  parameters: z.object({
    source: z.string(),
    destination: z.string(),
    newArtifact: z.string(),
    removeAfterward: z.string().optional(),
    remoteObjectId: z.string(),
  }),
  fileOperands: {
    input: ['source'],
    output: ['destination'],
    create: ['newArtifact'],
    destructive: ['removeAfterward'],
    nonFile: ['remoteObjectId'],
  },
  async execute(args, toolCtx) {
    // ...
  },
})
```

- `input` — a local file or directory the tool reads. TypeClaw authorizes it and executes the tool against a bounded immutable snapshot.
- `output` — a local destination the tool creates or replaces. TypeClaw authorizes and descriptor-anchors it before dispatch, atomically reserving a missing target as a single-link regular file. Write the rewritten path passed to `execute`; the tool does not need to anchor it again.
- `create` — a local destination that must not exist. TypeClaw verifies absence and descriptor-anchors the parent; create the rewritten path with `O_CREAT | O_EXCL`. Cleanup verifies the new file is a single-link regular file under that anchored parent.
- `destructive` — a local path the tool deletes, moves, or otherwise mutates destructively. It is not treated as an input; the destructive primitive remains responsible for authorization and anchoring.
- `nonFile` — a remote identifier or control token that is never dereferenced locally. Use this narrowly, even when the value looks path-like or collides with an existing agent entry; never place a possible local input here.

The categories may be combined in one tool. TypeClaw snapshots declared inputs and anchors declared output/create destinations before dispatch, restores destination and input paths in inverse order in the result, and releases those resources in reverse order. If either setup phase fails, resources acquired by the earlier phase are cleaned before the error propagates.

The boundary is fail-closed: declare **every** argument path that can carry a local filesystem operand. Undeclared filesystem-capable strings can be rejected before `execute`, including explicit paths, file-shaped keys, canonical credential names, and values that resolve to existing entries. Existing-local detection runs before semantic exemptions. A `file:` URI explicitly opts an otherwise undeclared value into input authorization and snapshotting, but it is not a substitute for a stable `fileOperands.input` contract.

### 5.2 `subagents` — declarative

```ts
import { z } from 'zod'
import { readTool, defineSubagent } from 'typeclaw/plugin'

subagents: {
  'journal-writer': defineSubagent({
    systemPrompt: 'You are a journal writer.',
    tools: [readTool],                    // built-in refs (re-exported)
    customTools: [appendTool],            // plugin-defined tools, scoped to this subagent
    payloadSchema: z.object({
      parentSessionId: z.string(),
      agentDir: z.string(),
    }),
    async handler(ctx, runSession) {
      // ctx: { userPrompt, agentDir, payload }
      await runSession({ userPrompt: buildPrompt(ctx.payload) })
    },
  }),
}
```

| Field           | Required | Notes                                                                        |
| --------------- | -------- | ---------------------------------------------------------------------------- |
| `systemPrompt`  | yes      | Replaces the main agent's system prompt entirely for the subagent's session. |
| `tools`         | no       | `BuiltinToolRef[]` — re-exported refs only.                                  |
| `customTools`   | no       | `Tool[]` — visible only to this subagent, NOT to the main agent.             |
| `payloadSchema` | no       | Validated on every invocation.                                               |
| `handler`       | no       | If absent, the runtime calls `runSession()` with the original user prompt.   |

**Built-in tool refs** re-exported from `typeclaw/plugin`:

```ts
import { readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool } from 'typeclaw/plugin'
```

Subagent names are global; the runtime uses the name **verbatim** (not prefixed). Pick discriminating names (`journal-writer`, not `worker`).

`runSession({ userPrompt? })` resolves when the spawned session completes one prompt. The session is created and disposed inside the call.

### 5.3 `cronJobs` — prefixed global ids

```ts
cronJobs: {
  'weekly-digest': {
    schedule: '0 9 * * 1',
    kind: 'prompt',
    prompt: 'Compile this past week into a digest.',
    subagent: 'journal-writer',           // optional; routes through subagent registry
    payload: { /* validated by journal-writer's payloadSchema at boot */ },
  },
  'log-rotate': {
    schedule: '0 0 * * *',
    kind: 'exec',
    command: ['bun', 'run', 'scripts/rotate.ts'],
  },
  // The canonical shape for scheduled imperative LLM work: a handler
  // function the cron consumer invokes directly. No shell-out, no WS
  // round-trip, no Bun.spawn — the handler runs in-process with the same
  // ctx.prompt / ctx.exec surface a container command sees.
  'inbox-watch': {
    schedule: '*/15 * * * *',
    kind: 'handler',
    handler: async (ctx) => {
      const { stdout } = await ctx.exec`gmail unread --count`
      if (Number(stdout.trim()) === 0) return
      await ctx.prompt(`Triage ${stdout.trim()} new emails…`)
    },
  },
}
```

- The map key is a **suffix**. The runtime constructs the global cron id as `__plugin_<plugin-name>_<key>` (e.g., `__plugin_standup-log_weekly-digest`).
- `cron.json` user job ids cannot start with underscore, so collision is impossible by construction.
- A `prompt` job's `subagent` and `payload` are **validated against the registry at boot** — bad references fail loudly on disk, not 6 hours later when the job fires.
- Three kinds: `prompt`, `exec`, `handler`. **`handler` is plugin-only** — it cannot appear in `cron.json` because the handler is a TypeScript function reference (not JSON-serializable). User-authored cron files are validated by `parseCronFile` which rejects anything outside `prompt | exec`.

#### `kind: 'handler'` — direct function dispatch

When the cron job needs imperative control flow (probe → maybe prompt → write file) and the logic lives in the same plugin as the schedule, declare it as a `handler`. The consumer invokes the function directly with a `CronHandlerContext`:

```ts
type CronHandlerContext = {
  readonly jobId: string // __plugin_<name>_<key>
  readonly name: string // plugin name that registered the job
  readonly agentDir: string // /agent in container
  readonly logger: PluginLogger
  readonly signal: AbortSignal // reserved for future cancellation; currently inert
  readonly permissions: PermissionService // live service — has() gating, see "permissions: [...] — declaring and gating" in §5.7 below
  readonly origin: SessionOrigin // { kind: 'cron', jobKind: 'handler', ... }
  readonly prompt: (text: string) => Promise<string> // full agent session, shared policy without interactive context
  readonly subagent: (name, payload?) => Promise<void>
  readonly exec: (cmd, ...vals) => Promise<CommandExecResult> // tagged template
}
```

The `prompt` / `subagent` / `exec` surface is identical to `ContainerCommandContext` (§5.7) and reuses the same underlying implementation — abort semantics, process-group kill, and the slim session context are all shared. Differences from `ContainerCommandContext`: no `stdin` / `stdout` / `stderr` (cron has no caller piping bytes), no `args` (handlers are scheduled, not invoked with flags), no return value (throw to signal failure, the consumer logs).

#### When to use which `kind`

| `kind`          | Use for                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'prompt'`      | One-shot natural-language prompts. Stable instruction, no shell pre-work, no conditional logic.                                                     |
| `'exec'`        | Pure shell work — `git commit`, log rotation, calling a script. Can also point at a plugin's `surface: 'host'` command via `['typeclaw', '<cmd>']`. |
| **`'handler'`** | **The default for plugin-internal scheduled imperative work.** Probe + maybe prompt, multi-step orchestration, anything mixing shell and LLM calls. |

A plugin that exposes a `surface: 'container'` command (§5.7) often does NOT need a corresponding cron handler — if the command's whole `run` body is the scheduled work, just factor the body into a shared private function and have BOTH the command and the cron handler call it. The command stays callable from the TUI / manual shell; the cron handler stays callable from the scheduler without shelling out.

The pre-handler workaround (cron `kind: 'exec'` with `command: ['typeclaw', '<plugin-cmd>']` shelling out to its own container) is still valid but no longer the default — reach for it only when the user owns the cadence (`cron.json` scheduling someone else's command) or when the scheduled work is genuinely a host-side command. See `typeclaw-cron` for the full decision tree.

### 5.4 `skills` — string-form (per-session tmpdir)

```ts
skills: {
  'standup-log': {
    description: 'How to use the standup log.',
    content: '# Standup log\n\n...',
    frontmatter: { 'allowed-tools': ['standup_query'] },
  },
}
```

- Materializes to a per-session tmpdir as `<sanitized-name>/SKILL.md` at session start. Disposed on websocket close.
- The map key becomes the skill's `name`. Names are **global** across plugins.
- Sanitization: lowercase, non-`[a-z0-9_-]` chars become `-`. Duplicate sanitized names throw at registration.

### 5.5 `skillsDirs` — file-form (paths)

```ts
import { join } from 'node:path'

skillsDirs: [join(import.meta.dir, 'skills')]
```

Each path is added to the resource loader's skill paths verbatim. Discovery walks for `SKILL.md` files. **No collision check** on directory paths (intentional — multiple plugins can contribute different skills from the same dir).

### 5.6 `hooks`

```ts
hooks: {
  'session.start':      async (event, ctx) => { /* { sessionId, agentDir } */ },
  'session.end':        async (event, ctx) => { /* { sessionId } */ },
  'session.idle':       async (event, ctx) => { /* { sessionId, parentTranscriptPath, idleMs } */ },
  'session.prompt':     async (event, ctx) => {
    event.prompt += `\n\n${await readToday(ctx.agentDir)}`  // mutate by reassign — see CRITICAL note below
  },
  'session.turn.start': async (event, ctx) => { /* { sessionId, agentDir, userPrompt } — user's actual message */ },
  'session.turn.end':   async (event, ctx) => { /* { sessionId, agentDir } */ },
  'tool.before': async (event, ctx) => {
    // event.args is a MUTABLE BAG — mutate to rewrite, or:
    if (event.args.danger === true) return { block: true, reason: 'unsafe' }
  },
  'tool.after': async (event, ctx) => {
    // observe or transform event.result
  },
}
```

| Hook                 | Direction           | Payload                                       | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.start`      | observe             | `{ sessionId, agentDir }`                     | Awaited before TUI gets `connected`.                                                                                                                                                                                                                                                                                                                                        |
| `session.end`        | observe             | `{ sessionId }`                               | Awaited before close handler resolves.                                                                                                                                                                                                                                                                                                                                      |
| `session.idle`       | observe             | `{ sessionId, parentTranscriptPath, idleMs }` | Fires **after every prompt completion** (success or error). The agent is "idle" the moment it stops responding. Plugins owning idle-debounced work (e.g. memory-logger spawn) install their own `setTimeout` and reset it on each event. `idleMs` is reserved (currently `0`).                                                                                              |
| `session.prompt`     | intervene           | `{ prompt, sessionId, agentDir }`             | Reassign `event.prompt` to mutate the **system prompt** as it's being assembled at session creation. `event.prompt` is the shared TypeClaw policy + IDENTITY + SOUL (the same policy for every standard origin; `systemPromptOverride` subagents don't fire it) — it is NOT the user's message. Runs once per session start, in plugin-load order. See CRITICAL note below. |
| `session.turn.start` | observe             | `{ sessionId, agentDir, userPrompt }`         | Fires **before every `session.prompt(text)` call** with `userPrompt` set to the literal text the session is about to receive. This is the right hook for "react to what the user just asked" (e.g. memory retrieval keyed on the user's question).                                                                                                                          |
| `session.turn.end`   | observe             | `{ sessionId, agentDir }`                     | Fires after every `session.prompt(text)` returns (success or error). Pair with `session.turn.start` for per-turn bookkeeping.                                                                                                                                                                                                                                               |
| `tool.before`        | intervene           | `{ tool, sessionId, callId, args }`           | Fires for plugin-defined tools and TypeClaw-exposed system tools, including built-in pi tools when plugins are wired. Mutate `event.args`, or return `{ block: true, reason }`. First block short-circuits.                                                                                                                                                                 |
| `tool.after`         | observe / transform | `{ tool, sessionId, callId, result }`         | Fires after plugin-defined tools and TypeClaw-exposed system tools. Observe `event.result`; tool result mutation is best-effort and tool-specific.                                                                                                                                                                                                                          |

**Multiple plugins** for the same hook run **in plugin-load order**. For `session.prompt`, the next plugin sees the previous plugin's mutated string.

#### CRITICAL: `session.prompt`'s `event.prompt` is the SYSTEM prompt, not the user message

The `prompt` field on `SessionPromptEvent` is the system prompt as it's being composed by `createResourceLoader` (shared policy + `IDENTITY.md` + `SOUL.md`), NOT the user's most recent message. Reading it as if it were the user's prompt — and feeding it to a retrieval system, classifier, or LLM — will keyword-mine TypeClaw's framing prose (`TypeClaw`, `subagent`, `AGENTS.md`) on every session.

If you want the **user's actual prompt** (their message text), subscribe to `session.turn.start` and read `event.userPrompt`. The bundled memory plugin's per-turn retrieval uses this hook so it embeds the user's text instead of the assembling system prompt; see `src/bundled-plugins/memory/index.ts`'s `session.turn.start` handler.

#### CRITICAL: `session.prompt` and provider prompt caching

Provider prompt caching makes the **prefix** of the system prompt 5–10× cheaper on subsequent calls. Cache hits require **byte-identical prefixes**.

- **Append** to `event.prompt` → cache-safe. Always prefer this.
- **Prepend** or **replace** → invalidates the cache for every LLM call until the prompt changes again.

If your content varies per session, **append**. If it's stable across sessions, prepending is fine but understand the cost.

### 5.7 `commands` — typeclaw CLI subcommands

A plugin can register top-level CLI commands invocable as `typeclaw <name>` from any shell sitting in the agent folder. **Unlike every other contribution in §5, `commands` is declared by-value on `definePlugin(...)`, NOT inside the factory return.** This is so the host-stage CLI can dispatch commands without booting the plugin runtime (no `bun install`, no factory, no engine spin-up just to print `--help`).

```ts
import { z } from 'zod'
import { definePlugin } from 'typeclaw/plugin'

export default definePlugin({
  commands: {
    'standup-now': {
      surface: 'container',
      description: 'Generate a standup write-up for today from sessions/.',
      args: z.object({
        date: z.string().optional().describe('YYYY-MM-DD; defaults to today'),
      }),
      async run(ctx, args) {
        const text = await ctx.prompt(
          `Read sessions/ for ${args.date ?? 'today'} and write a 3-bullet standup to standup/${args.date ?? 'today'}.md.`,
        )
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(text + '\n'))
        writer.releaseLock()
        return 0
      },
    },
  },
  plugin: async (ctx) => ({
    /* tools, hooks, cron, ... */
  }),
})
```

Once installed, the user (or a cron `exec` job) runs `typeclaw standup-now --date=2026-05-18`. `typeclaw --help` lists all discovered plugin commands automatically — no separate registration.

#### The three surfaces

| `surface`     | Runs where                                                          | `ctx` has                                                                 | Use when                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'container'` | Inside the running agent container, proxied over WS by the host CLI | `prompt`, `subagent`, `exec`, `permissions`, `origin`, `signal` + streams | The command needs the agent runtime — LLM calls (`ctx.prompt`), subagent invocation, permission checks. Reusable from TUI, manual shell, `compose`, and (as a narrower fallback when reusability is required) cron `exec`. For plugin-internal scheduled `exec → LLM` work, prefer `kind: 'handler'` (§5.3) — see "Cron usage" below. |
| `'host'`      | On the user's machine, no container required                        | `streams`, `signal`, `logger`, `agentDir` (host path)                     | The command only touches host-side state (files, host binaries, prompts the user). Container does NOT need to be running.                                                                                                                                                                                                             |
| `'either'`    | Whichever stage invoked it — same author code runs in both          | The intersection (`streams`, `signal`, `logger`, `agentDir`)              | The command's logic is stage-agnostic. `agentDir` resolves to `/agent` in the container and the host path on the host, automatically.                                                                                                                                                                                                 |

The `surface: 'container'` command requires the container to be running. The host CLI opens a WebSocket to `/commands` on the agent's port, sends `exec_command`, and streams stdout/stderr back. Ctrl-C on the host propagates as `AbortSignal` to `ctx.signal` inside the container.

#### `ContainerCommandContext` — what you get inside `run`

```ts
type ContainerCommandContext = {
  readonly name: string // plugin name (e.g. 'standup-log'), NOT command name
  readonly version: string | undefined
  readonly agentDir: string // /agent inside the container
  readonly logger: PluginLogger
  readonly permissions: PermissionService // live service — has() gating, see "permissions: [...] — declaring and gating" below
  readonly origin: SessionOrigin // caller's origin — cron job, TUI op, etc.
  readonly signal: AbortSignal // aborts on ws close or host Ctrl-C
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: WritableStream<Uint8Array>
  readonly stderr: WritableStream<Uint8Array>
  readonly prompt: (text: string) => Promise<string> // full LLM session, full toolset, returns last assistant text
  readonly subagent: (name: string, payload?: unknown) => Promise<void>
  readonly exec: (cmd: TemplateStringsArray, ...values: unknown[]) => Promise<CommandExecResult>
}
```

Key facts about each capability:

- **`ctx.prompt(text)`** opens a brand-new `AgentSession` with the full agent toolset (read/bash/edit/write/grep/find/ls + plugin tools), sends `text` as if a user typed it, and returns the last assistant message. The session is created and disposed inside the call. It runs with a subagent-shaped origin, so it gets the same shared system policy as a TUI session but skips the interactive orchestration context, subagent roster, git nudge, and MCP catalog.
- **`ctx.subagent(name, payload)`** invokes a registered subagent (yours or another plugin's). Returns when the subagent's `runSession` resolves.
- **`ctx.exec` is a tagged template** — `await ctx.exec\`git log --oneline -10\``runs the command in the agent folder with`ctx.signal` threaded through. Aborts kill the entire process group (SIGTERM → 5s grace → SIGKILL) so daemonized grandchildren don't outlive the abort.
- **`ctx.origin`** carries the caller's `SessionOrigin`. For host-invoked (TUI op) calls it's `{ kind: 'tui', ... }`; for cron-invoked calls it's the cron job's origin including `scheduledByRole`. **No silent role elevation** — a cron job running as `scheduledByRole: 'member'` invokes the command with that same role, and permission checks inside the command resolve accordingly.

#### Cron usage: prefer `kind: 'handler'` over shelling out to your own command

Plugin cron jobs support `kind: 'handler'` (§5.3) which invokes a TypeScript function directly with a `CronHandlerContext`. The handler ctx exposes the SAME `ctx.prompt` / `ctx.subagent` / `ctx.exec` surface a container command sees — same slim-mode session, same process-group abort semantics — but without the shell-out, the WS round-trip, or the args-parse round-trip.

**If the cron job and the command both live in the same plugin, prefer a handler.** Factor any shared logic into a private function and have BOTH the command's `run` body and the cron handler call it. The command stays callable from the TUI / manual `typeclaw` invocations; the cron handler stays callable from the scheduler with zero shell-out cost.

The shell-out pattern below (cron `exec` → `typeclaw <plugin-cmd>`) is still supported and stays valid in three narrow cases, all rooted in **the same logic needing a callable surface beyond cron**:

1. **The logic is also a reusable CLI command.** The user wants to run it manually as `typeclaw <cmd> --flag=...` from the TUI / shell / `compose`, or another caller needs the same args contract. Write the logic once inside a `surface: 'container'` command's `run`; reuse it from cron by pointing an `exec` job at the same command. "Scheduled work that needs LLM judgement" alone is NOT this case — without an external caller, prefer `kind: 'handler'` and avoid the shell-out overhead.
2. **The user owns the cadence.** `cron.json` schedules someone else's plugin command at a custom cadence the plugin author didn't anticipate. The user doesn't fork the plugin to change the schedule.
3. **The scheduled work needs a `surface: 'host'` command.** Host commands run outside the container with no agent runtime, so `ctx.prompt` is unavailable; the shell-out via `typeclaw <host-cmd>` is the only path.

#### The cron-exec → typeclaw shell-out (narrower use case)

For plugin-internal scheduled `exec → LLM` work, `kind: 'handler'` (§5.3) is the best practice — see "Cron usage" above. The pattern below — write a `surface: 'container'` plugin command whose `run` calls `ctx.prompt(...)`, then point a `cron.json` `exec` job at it — is the fallback when **reusability is the actual requirement**: the same logic must also be invocable as a CLI command from TUI / manual shell / `compose`, or the user owns the cadence for a command they didn't write, or the work needs `surface: 'host'` (where `ctx.prompt` doesn't exist).

User-authored `cron.json` itself supports only `prompt` and `exec` — that's by design. `kind: 'handler'` is plugin-only because the handler is a function reference, not JSON-serializable.

```json
// cron.json
{
  "jobs": [
    {
      "id": "daily-standup",
      "schedule": "30 9 * * 1-5",
      "timezone": "Asia/Seoul",
      "kind": "exec",
      "command": ["typeclaw", "standup-now"]
    }
  ]
}
```

```ts
// packages/standup-log/index.ts
export default definePlugin({
  commands: {
    'standup-now': {
      surface: 'container',
      description: 'Generate today’s standup.',
      async run(ctx) {
        await ctx.prompt(
          `Read sessions/$(date +%F)*.jsonl and append a 3-bullet standup to memory/standups/$(date +%F).md.`,
        )
        return 0
      },
    },
  },
  plugin: async () => ({}),
})
```

This `cron.json → typeclaw <cmd>` shape is the right choice in the three narrow cases listed above. For plugin-internal scheduled work where the cadence belongs to the plugin author and nothing outside cron needs to invoke the logic, write a `kind: 'handler'` job (§5.3) instead — same `ctx.prompt` / `ctx.exec` shape, none of the shell-out overhead.

Why a CLI command is worth defining (and exposing via cron `exec`) when one of the three cases applies:

- The command is reusable from the TUI, from `compose` orchestration, or from a manual `typeclaw standup-now` invocation by the user.
- Args (`--date`, `--dry-run`, etc.) are declared once via `args: z.object({...})` and parsed/validated by the runtime — both at the host CLI and as defense-in-depth in the container.
- A user who wants a different cadence than the plugin's default can drop a `cron.json` entry pointing at the command without forking the plugin.

If none of those benefits actually apply to your case, the CLI command shape is overhead — write a handler.

For the cron-side decision rules (when to pick `handler` vs `prompt` vs `exec → typeclaw <cmd>`, and how to gate `ctx.prompt` behind a cheap `ctx.exec` probe) read `typeclaw-cron`.

#### `args` — Zod object schema with primitive leaves

```ts
args: z.object({
  date: z.string().optional().describe('YYYY-MM-DD; defaults to today'),
  dryRun: z.boolean().default(false),
  count: z.number().int().min(1).max(100).default(10),
})
```

- The top level **MUST** be `z.object({...})`. Leaves should be primitives (`string`, `number`, `boolean`, `literal`, `enum`) so `--help` can render `--<name>=<type>`.
- Args are validated locally by the host CLI **before** any WS round-trip, so bad args fail fast with a clean error and exit code 2. The container re-validates as defense-in-depth.
- `.describe(...)` populates `--help` output. Use it.
- Omit `args` entirely if the command takes no flags.

#### `permissions: [...]` — declaring and gating

**Declaring a permission grants it to nobody.** `definePlugin({ permissions: [...] })` only registers the string into the known-permission universe — used for the boot-time typo warning and, for `security.bypass.*` strings only, owner-wildcard expansion. Every other permission string starts out held by no role: not owner, not trusted, not member, not guest. A plugin that gates a command or tool on a permission and never adds that string to any `roles.<role>.permissions[]` in `typeclaw.json` has shipped a permanently blocked surface — declaring is half the work, granting is the other half. Never ship one without the other.

**`definePlugin({ permissions })` is the only declaration that does anything.** `ContainerCommand.permissions` exists in the type but no production path reads it — it is not rendered in `--help` (`renderCommandHelp` prints description, plugin, surface, options), not collected into the known-permission universe (`collectDeclaredPermissions` reads only the plugin-level list), and never checked for you. Declare at the plugin level. Setting it on a command instead is worse than useless: the string stays outside the known universe, so granting it in a role also trips the `unknown permission` typo warning at boot.

**Gating a command** — declare the string on the plugin, then check it inside `run`:

```ts
const WRITE_PERMISSION = 'standup.write.entry'

export default definePlugin({
  permissions: [WRITE_PERMISSION],
  commands: {
    standup: {
      surface: 'container',
      description: 'Append a standup entry.',
      async run(ctx, args) {
        if (!ctx.permissions.has(ctx.origin, WRITE_PERMISSION)) {
          const writer = ctx.stderr.getWriter()
          await writer.write(new TextEncoder().encode(`missing permission: ${WRITE_PERMISSION}\n`))
          writer.releaseLock()
          return 1
        }
        // ...
        return 0
      },
    },
  },
  plugin: async () => ({}),
})
```

```jsonc
// typeclaw.json — the grant this declaration needs, or the command always fails
{
  "roles": {
    "trusted": {
      "permissions": ["standup.write.entry" /* ...trusted's full default list too, see below */],
    },
  },
}
```

`PermissionService` exposes `has(origin, permission)` — a boolean. **There is no `assert`.** Nothing authorizes on your behalf: `has` resolves the caller's origin to a role and returns false unless that role's permission list contains the exact string, and it is on you to fail the call. Same `<plugin>.<verb>.<noun>` shape as the rest of the permission system; see `typeclaw-permissions`.

**Permission ids cannot contain hyphens.** `roles[].permissions[]` validates against `^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$` — dot-separated segments, each starting lowercase, alphanumeric after (camelCase is fine, `-` is not). Nothing validates the `definePlugin({ permissions })` side, so a hyphenated id like `standup-log.write.entry` declares happily and then **cannot be granted at all**: the config edit fails schema validation. A hyphenated plugin name needs a hyphen-free permission namespace — plugin `standup-log` uses `standup.write.entry`.

**Gating a tool** — tools have no `permissions` field of their own; gate them from a `tool.before` hook with `pluginContext.permissions.has(event.origin, ...)`:

```ts
const PUBLISH_PERMISSION = 'standup.publish.remote'

export default definePlugin({
  permissions: [PUBLISH_PERMISSION],
  plugin: async (pluginContext) => ({
    tools: {
      standup_publish: defineTool({
        /* ... */
      }),
    },
    hooks: {
      'tool.before': (event) => {
        if (event.tool !== 'standup_publish') return
        if (pluginContext.permissions.has(event.origin, PUBLISH_PERMISSION)) return
        return { block: true, reason: `missing permission: ${PUBLISH_PERMISSION}` }
      },
    },
  }),
})
```

```jsonc
// typeclaw.json — same recipe: declaring PUBLISH_PERMISSION above grants nothing on its own
{
  "roles": {
    "trusted": {
      "permissions": ["standup.publish.remote" /* ...trusted's full default list too, see below */],
    },
  },
}
```

Omit that second half and the failure is silent and total: the plugin compiles, boots, and registers the tool, but every call — including from `owner` — is blocked forever, because nothing ever granted the string. The tool looks wired and is dead.

**Built-in roles: an explicit `permissions[]` REPLACES the default, it does not add to it.** Add your string to `roles.owner.permissions[]` and you must re-list `owner`'s entire default permission set alongside it, including the `security.bypass.*` strings the wildcard sentinel would otherwise expand for you (the sentinel is an internal runtime value — you cannot write it, and the schema rejects it). Don't copy the default lists from memory; read `typeclaw-permissions` for the current per-role defaults.

**Restart required.** `roles.<role>.permissions[]` is a `restart-required` field — `typeclaw reload` will not pick up a new grant. `roles.<role>.match[]` is live-reloadable; permissions are not. Run `typeclaw restart`.

**The boot-time signal for a forgotten grant**: `[permissions] plugin "<name>" declares "<id>" but no role grants it — every surface gated on it will be denied. Add it to roles.<role>.permissions[] in typeclaw.json and restart.` If you see this at boot, or a tool/command you just wired is blocked for every caller including yourself, this is why.

**When NOT to declare a permission.** If your plugin is the only caller of the surface it gates — no operator will ever want to withhold or grant this capability per role — the check is just an `if (false)` with extra steps. Declare a permission only when you actually want an operator able to grant or withhold it per role.

#### `isolated: true` (container surface only)

```ts
{
  surface: 'container',
  isolated: true,  // currently degrades to in-process with a warning on stderr
  async run(ctx, args) { /* ... */ },
}
```

Reserved for a future subprocess sandbox. Today the runtime accepts the flag and emits a warning on the per-command stderr (visible to the invoking CLI) but executes in-process anyway. Set it now if you genuinely want the isolation when it lands; otherwise omit.

#### Discovery and naming

- Command names are **global across all plugins**. Two plugins registering `standup-now` is a discovery error — the second one is dropped and logged on `--help`.
- Command names are NOT auto-prefixed with the plugin name. Pick discriminating names (`standup-now`, not `run`).
- `typeclaw --help` (in any agent folder) lists every discovered plugin command with description, surface, and which plugin owns it.
- `typeclaw <name> --help` renders args, surface, plugin name + version. Free.

#### What's NOT supported

- **No host-stage CLI commands that mutate the live container without going through `restart` / `reload`.** A host command can `Bun.spawn('typeclaw', ['reload'])` if it needs to push a config change, but there's no privileged backdoor.
- **No tool-style `content: ContentPart[]` return.** Commands write to `ctx.stdout` and return an exit code. They are CLI processes, not LLM tool calls.
- **No streaming token output from `ctx.prompt`** yet — the full LLM response arrives as one stdout burst. Chunked streaming is on the roadmap.
- **No nested command dispatch.** A command cannot invoke `typeclaw <other-cmd>` and expect to share state; spawn a subprocess or share a subagent instead.

---

## 6. PluginContext

```ts
type PluginContext<TConfig = never> = {
  readonly name: string // derived
  readonly version: string | undefined // package.json (npm only)
  readonly agentDir: string // absolute, agent folder root
  readonly config: TConfig // inferred from configSchema
  readonly logger: PluginLogger // prefixed: [plugin:<name>]
  readonly permissions: PermissionService // live service — has() gating, see "permissions: [...] — declaring and gating" in §5.7 above
  spawnSubagent: (name: string, payload?: unknown) => Promise<void>
}
```

### `spawnSubagent` boot gate

`spawnSubagent` is **gated until boot completes**. Calling it from inside the `plugin` factory throws:

```
plugin <name>: spawnSubagent("<x>") called before boot completed; subagent registry is not yet wired
```

Safe call sites: event handlers, tool `execute`, subagent handlers (subagents can spawn other subagents).

### What's NOT on `ctx`

No `ctx.stream`, no `ctx.server`, no `ctx.reloadRegistry`, no `ctx.registerX(...)`. **Everything contributed is in the returned object. Everything read is on `ctx`.** That's the entire surface.

---

## 7. Failure Modes (verbatim error messages)

When something goes wrong, you'll see one of these. Memorize the patterns.

| Trigger                                      | Error                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Local path escapes agentDir                  | `plugin path escapes agent directory: <entry> (resolved to <abs>)`                                     |
| Local path doesn't exist                     | `plugin path does not exist: <entry> (resolved to <abs>)`                                              |
| Two plugins resolve to same name             | `plugin name conflict: <name> (entry <entry>) already loaded`                                          |
| Config doesn't match schema                  | `plugin <name>: config invalid: <zod issues>`                                                          |
| Config block exists but plugin has no schema | `plugin <name>: config block "<name>" present in typeclaw.json but plugin declares no configSchema`    |
| Factory threw                                | `plugin <name>: factory threw: <error message>`                                                        |
| Tool name collision                          | `plugin <name>: tool "<tool>" already registered by plugin <other>`                                    |
| Subagent name collision                      | `plugin <name>: subagent "<sub>" already registered by plugin <other>`                                 |
| Skill name collision                         | `plugin <name>: skill "<skill>" already registered by plugin <other>`                                  |
| Cron id collision                            | `plugin <name>: cron job "<id>" globalId "<global>" conflicts with plugin <other>`                     |
| Empty identifier                             | `plugin <name>: empty <kind>` (kind: tool name / subagent name / cron job id / skill name)             |
| Skill name dup after sanitization            | `plugin <name>: duplicate skill name after sanitization: <localName>`                                  |
| `spawnSubagent` called too early             | `plugin <name>: spawnSubagent("<x>") called before boot completed; subagent registry is not yet wired` |

**Atomic rollback**: on any of these (during load), every contribution from the offending plugin — tools, subagents, cron jobs, skills, skillsDirs, **and hooks** — is discarded before the error bubbles up. There is no partial state.

---

## 8. Common Pitfalls

### ❌ Importing the engine

```ts
// WRONG — boundary violation
import { something } from '@earendil-works/pi-coding-agent'
```

**Plugins use `typeclaw/plugin` only.** The runtime translates to engine types behind the scenes.

### ❌ Calling `spawnSubagent` from the factory

```ts
// WRONG — throws "called before boot completed"
plugin: async (ctx) => {
  await ctx.spawnSubagent('worker', {}) // TOO EARLY
  return {
    /* ... */
  }
}
```

```ts
// CORRECT — call it from a hook or tool
plugin: async (ctx) => ({
  hooks: {
    'session.idle': async () => {
      await ctx.spawnSubagent('worker', {
        /* ... */
      }) // OK after boot
    },
  },
})
```

### ❌ Prepending in `session.prompt`

```ts
// WRONG — invalidates provider prompt cache on every call
'session.prompt': (event) => {
  event.prompt = `[CONTEXT]\n${dynamicData}\n${event.prompt}`
}
```

```ts
// CORRECT — append (cache-safe)
'session.prompt': (event) => {
  event.prompt += `\n\n[CONTEXT]\n${dynamicData}`
}
```

### ❌ Assuming `tool.before/after` only cover plugin tools

`tool.before` / `tool.after` also intercept TypeClaw-exposed system tools, including `read`, `bash`, `edit`, `write`, etc. when plugins are wired into the session. Scope your hook by `event.tool` before mutating args or blocking.

### ❌ Forgetting plugin name derivation

```json
// WRONG — config block uses package name verbatim
{
  "plugins": ["typeclaw-plugin-standup-log"],
  "typeclaw-plugin-standup-log": { ... }   // ignored! plugin sees empty config
}
```

```json
// CORRECT — config block uses DERIVED name
{
  "plugins": ["typeclaw-plugin-standup-log"],
  "standup-log": { ... }
}
```

### ❌ Editing `plugins[]` and expecting `reload` to apply it

`plugins` is `restart-required`. Run `typeclaw restart` after changing the array. The reload diff will tell you, but watch for it.

### ❌ Two plugins declaring the same global tool/subagent/skill name

Boot fails. Pick discriminating names. The runtime does NOT auto-prefix tool/subagent/skill names with the plugin name (only cron ids are prefixed with `__plugin_<name>_`).

### ❌ Calling built-in tools from inside a plugin tool's `execute`

Plugin `ToolContext` is `{ signal, sessionId, agentDir, logger }`. There is no `ctx.read()`, no `ctx.bash()`. Plugin tools are leaf operations. If your tool needs to chain built-ins, declare a subagent with `tools: [readTool, ...]` and let the LLM orchestrate.

---

## 9. Operational Reference

### Where things live

- **Plugin module source**: `src/plugin/` (types, define, loader, manager, registry, hooks, skills, context)
- **Engine bridge**: `src/agent/plugin-tools.ts` (the ONLY file that imports both plugin and engine types)
- **Plugin wiring at boot**: `src/run/index.ts` (`startAgent` calls `loadPlugins`, merges into registries)
- **Hook fire sites**:
  - `session.prompt`: `src/agent/index.ts` `createResourceLoader` (during system-prompt assembly; `event.prompt` is shared policy + IDENTITY + SOUL, NOT the user message)
  - `session.turn.start` / `session.turn.end`: bracket every `session.prompt(text)` call across all four prompt-driver sites — `src/server/index.ts` (TUI drain + fallback), `src/channels/router.ts` (`fireSessionTurnStart`), `src/cron/consumer.ts` (per-attempt), `src/agent/subagents.ts` (subagent runner). `userPrompt` carries the literal text being passed to `session.prompt(text)`.
  - `session.idle`: `src/server/index.ts` `drain()` — fires immediately after every `session.prompt()` resolves (success or error)
  - `session.start`/`session.end`: `src/server/index.ts` ws open/close
  - `tool.before`/`tool.after`: `src/agent/plugin-tools.ts` `wrapPluginTool`, `wrapSystemTool`, and `wrapBuiltinToolDefinition`. The last one is the load-bearing path for pi's builtin coding tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`): as of pi-coding-agent 0.73, every builtin is a `ToolDefinition` (via pi's `create*ToolDefinition` factories) that TypeClaw wraps and ships through `customTools`, while `createAgentSession({ noTools: 'builtin', tools })` disables pi's unwrapped copies and narrows the active set to an explicit name allowlist. See the top-of-file contract block in `plugin-tools.ts` for the full reasoning.
- **Schema additions**: `src/config/config.ts` (`plugins` array, `.catchall(z.unknown())` for per-plugin blocks, `extractPluginConfigs`)

### Audit log on boot

After successful load, the runtime emits to stdout:

```
[plugin] loaded N plugin(s): standup-log v0.1.0, foo (local)
```

Local plugins have no version. Use this to confirm what's actually loaded.

### Debugging a missing config

If `ctx.config.foo` is unexpectedly missing or default:

1. Verify the **derived plugin name** matches the top-level config block key in `typeclaw.json`.
2. Verify `configSchema` is on `definePlugin({ ... })`, not on the inner `plugin` function.
3. Check audit log for `plugin <name>: config invalid: ...` — defaults don't apply if the block fails validation.

### Debugging a not-firing hook

1. `session.start` / `session.end` are tied to **websocket** open/close. They don't fire during cron-only invocations.
2. `tool.before` / `tool.after` fire for plugin-defined and TypeClaw-exposed system tools only when plugins are wired into the session. Confirm the session loaded your plugin and check `event.tool` matches the expected tool name.
3. Hooks that throw are logged (`reportHookError`) and do NOT abort the loop. Check the plugin logger output.

### Restart vs reload

| Change                             | Effect                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| Edit a hook handler body           | Container restart (new code)                              |
| Edit a tool's `execute` body       | Container restart                                         |
| Add/remove an entry in `plugins[]` | Container restart (`restart-required`)                    |
| Change a per-plugin config value   | Container restart (factory only runs at boot)             |
| Edit `cron.json` (non-plugin)      | Reload picks it up (existing `cron.json` reload pipeline) |

When in doubt: `typeclaw restart`.

---

## 10. Anti-Goals (intentionally NOT supported)

If you find yourself wanting any of these, the design has gone wrong somewhere — file an issue rather than working around it:

- **Plugin sandboxing**. Plugins run with full Bun privileges. The container is the sandbox.
- **Hot plugin reload**. `typeclaw restart` to pick up plugin code or config changes.
- **Stream subscriptions**. Plugins observe through the typed `hooks` surface; they cannot subscribe to the in-process pub/sub directly.
- **Server-side TUI push notifications** from plugin code. Tool calls reach the TUI via existing `tool_start`/`tool_end` events.
- **Dockerfile fragments** contributed by plugins. The Dockerfile is core-managed.
- **New cron job kinds for user-authored `cron.json`** beyond `prompt` and `exec`. (Subagent invocation is a `prompt` variant, not a separate kind. Plugin cron jobs additionally support `kind: 'handler'` — see §5.3 — but that's plugin-only because the handler is a TypeScript function reference, not JSON-serializable.)
- **Reload-registry scopes** for plugin-owned state.
- **`extendConfig`** for arbitrary top-level fields outside the plugin's own config block.
- **Per-LLM-call hooks** (`llm.params` / `llm.headers`). Wait until a real plugin needs them.

---

## 11. Quick Reference Card

```ts
import { z } from 'zod'
import {
  definePlugin, // wrap module
  defineTool, // (optional, identity helper for type inference)
  defineSubagent, // (optional, identity helper)
  // built-in tool refs:
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  findTool,
  lsTool,
  // types:
  type PluginContext,
  type PluginExports,
  type Tool,
  type Subagent,
  type ToolContext,
  type ToolResult,
  type ContentPart,
  type Hooks,
  type SessionPromptEvent,
  type ToolBeforeEvent,
} from 'typeclaw/plugin'
```

**Plugin shape**:

```ts
export default definePlugin({
  configSchema: z.object({
    /* ... */
  }), // optional
  commands: {
    /* name: { surface, run, args?, ... } */
  }, // optional, declared BY-VALUE (not inside factory)
  permissions: ['myplugin.write.x'], // optional; declares only — grant it in roles.<role>.permissions[] in typeclaw.json or nobody has it
  plugin: async (ctx) => ({
    // required
    tools,
    subagents,
    cronJobs,
    skills,
    skillsDirs,
    hooks,
    doctorChecks, // all optional
  }),
})
```

**Cron global id**: `__plugin_<plugin-name>_<key>`

**Plugin name = derived**: scope-stripped, `typeclaw-plugin-` prefix stripped (npm), or basename minus extension (local).

**Command name = global**: NOT prefixed with plugin name. Two plugins registering the same command name is a discovery error (second is dropped, logged on `--help`).

**`exec → LLM` from cron** (best practice): plugin `cronJobs` entry with `kind: 'handler'` — a TypeScript function the cron consumer invokes directly with `ctx.prompt` / `ctx.subagent` / `ctx.exec`. No shell-out, no WS round-trip. Fall back to `surface: 'container'` command + cron `exec` pointing at `["typeclaw", "<cmd>"]` ONLY when the same logic must also be invocable as a reusable CLI command, the user owns the cadence for someone else's command, or the work needs `surface: 'host'`.

**Boundary**: `src/plugin/**` MUST NOT import `@earendil-works/*`.
