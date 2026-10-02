import type { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import type { SubagentShared } from '@/agent/subagents'
import type { ResolveGithubTokenForRepo } from '@/channels/github-token-bridge'
import type { PermissionService } from '@/permissions'

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

export type ToolResult = {
  content: ContentPart[]
  details?: unknown
}

export type ToolLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type ToolContext = {
  signal: AbortSignal | undefined
  sessionId: string
  agentDir: string
  logger: ToolLogger
}

export type ToolFileOperands = {
  input?: readonly string[]
  output?: readonly string[]
  create?: readonly string[]
  destructive?: readonly string[]
  // Operand paths whose string values are control tokens or remote identifiers,
  // never a local file — the file-operand scanner skips them (like a first-party
  // prose operand) instead of rejecting a value that collides with an existing
  // agent-root entry. Scoped per operand path and survives
  // the runtime `__plugin_*` tool-name prefix that a static in-scanner table
  // cannot. Declare a real file input under `input` (it gets pinned), not here.
  nonFile?: readonly string[]
}

export type Tool<P = unknown> = {
  description: string
  parameters: z.ZodType<P>
  fileOperands?: ToolFileOperands
  execute: (args: P, ctx: ToolContext) => Promise<ToolResult>
}

export type BuiltinToolRef = { readonly __builtinTool: string }

export type SubagentContext<P = unknown> = {
  userPrompt: string
  agentDir: string
  payload: P
}

export type RunSession = (override?: {
  userPrompt?: string
  // Called after a completed run with the terminal assistant text, or null
  // after an empty terminal response or provider failure. No block projection.
  onFinalMessage?: (message: string | null) => void
}) => Promise<void>

// The plugin-author-facing subagent declaration. Differs from
// `@/agent/subagents`'s `Subagent` only in the shape of `tools`/`customTools`:
// plugins reference builtin tools via tagged `BuiltinToolRef` strings (the
// stable plugin API) and contribute their own `Tool<any>[]`; the runtime
// resolves those refs to pi-coding-agent's wrapped tool shapes before the
// session sees them. Every other field is inherited from `SubagentShared`
// so a new shared field surfaces on both types in one edit. See
// `SubagentShared`'s doc-comment for the regression history.
//
export type Subagent<P = unknown> = SubagentShared<P> & {
  tools?: BuiltinToolRef[]
  customTools?: Tool<any>[]
}

// Cron job map keys are local; the runtime prefixes with `__plugin_<plugin-name>_`
// to form the global cron id, guaranteeing no collision with cron.json user
// jobs (no underscore prefix) or across plugins.
export type PluginPromptCronJob = {
  schedule: string
  kind: 'prompt'
  prompt: string
  enabled?: boolean
  timezone?: string
  subagent?: string
  payload?: unknown
}

export type PluginExecCronJob = {
  schedule: string
  kind: 'exec'
  command: string[]
  enabled?: boolean
  timezone?: string
}

// In-process handler. Invoked directly by the cron consumer; no shell-out, no
// WS round-trip, no Bun.spawn. Use this when the cron job needs imperative
// control flow (probe → maybe prompt → write file) and lives in the same
// plugin as the logic — there is no need to dress the work up as a CLI
// command just to schedule it from yourself.
//
// `handler` is a TypeScript function reference, so this kind CANNOT appear in
// cron.json (only plugin-contributed cron registrations can carry it). The
// schema gate (`parseCronFile` in src/cron/schema.ts) keeps user files limited
// to `prompt` and `exec`.
export type PluginHandlerCronJob = {
  schedule: string
  kind: 'handler'
  handler: (ctx: CronHandlerContext) => Promise<void>
  enabled?: boolean
  timezone?: string
}

export type PluginCronJob = PluginPromptCronJob | PluginExecCronJob | PluginHandlerCronJob

// Surface passed into a plugin cron handler. Mirrors the LLM-call capabilities
// of `ContainerCommandContext` (`prompt`, `subagent`, `exec`) without the
// CLI-shaped fields (stdin/stdout/stderr, args, exit code) because cron has
// no caller to pipe to.
//
// `signal` is reserved for future cancellation and is currently never aborted
// by the runtime — the consumer matches the existing prompt/exec cron jobs
// which also let in-flight work finish on container shutdown. The signal IS
// already threaded into `ctx.prompt` and `ctx.exec`, so the moment the
// runtime starts aborting it (e.g. via a future graceful-shutdown path),
// propagation works without handler-author changes. Handler authors who
// want to respect future cancellation should still check `ctx.signal.aborted`
// in long-running loops; nothing fires it today.
//
// `origin` is a cron-shaped SessionOrigin so any session the handler spawns
// via `ctx.prompt` carries the cron job's provenance — same role-inheritance
// semantics as a `kind: 'exec'` job that shells out to `typeclaw <cmd>`.
export type CronHandlerContext = {
  readonly jobId: string
  // The plugin that registered this cron job (e.g. 'inbox-watch'). Matches
  // `ContainerCommandContext.name`. Useful for log lines that should be
  // attributable to the plugin, not just the cron id.
  readonly name: string
  readonly agentDir: string
  readonly logger: PluginLogger
  readonly signal: AbortSignal
  readonly permissions: PermissionService
  readonly origin: SessionOrigin
  readonly prompt: (text: string) => Promise<string>
  readonly subagent: (name: string, payload?: unknown) => Promise<void>
  readonly exec: (cmd: TemplateStringsArray, ...values: unknown[]) => Promise<CommandExecResult>
}

export type PluginSkill = {
  description: string
  content: string
  frontmatter?: Record<string, unknown>
}

export type SessionStartEvent = {
  sessionId: string
  agentDir: string
}

export type SessionEndEvent = {
  sessionId: string
  origin?: SessionOrigin
}

export type SessionIdleEvent = {
  sessionId: string
  parentTranscriptPath: string | undefined
  idleMs: number
  origin?: SessionOrigin
}

// Brackets every `session.prompt(...)` invocation. Distinct from
// `session.start`/`session.end` (which bracket session lifetime) so that
// long-lived TUI or channel sessions, which can sit idle between turns,
// don't wedge a turn-counter forever. `origin` carries the session's origin
// so observers can exclude their own induced turns when counting (e.g. the
// backup plugin excludes `subagent: 'backup'` to avoid self-gating).
//
// `userPrompt` is the EXACT text being passed to `session.prompt(text)` —
// the user's message for TUI/channel turns, the cron job's prompt for cron
// turns, or the rendered initial prompt for subagent turns. Distinct from
// `SessionPromptEvent.prompt` (the assembling system prompt for cache-safe
// suffix mutation at session creation time). Channel adapters that prefix
// inbound text with attribution headers (`[Alice in #general]:`) pass the
// prefixed string here, matching what `session.prompt(text)` receives;
// observers that need the unattributed text would need a separate hook.
export type SessionTurnStartEvent = {
  sessionId: string
  agentDir: string
  userPrompt: string
  origin?: SessionOrigin
  // Mutable ref: plugin writes retrieval results here; server/router reads after hook returns.
  // Populated when a turn driver supplies a retrieval context bag.
  retrievalContext?: { results: string }
}

export type SessionTurnEndEvent = {
  sessionId: string
  agentDir: string
  origin?: SessionOrigin
}

// Provider prompt caching requires byte-identical prefixes. Mutations near the
// end of `event.prompt` preserve cache hits across sessions; mutations near
// the start invalidate the cache on every LLM call.
export type SessionPromptEvent = {
  prompt: string
  sessionId: string
  agentDir: string
  origin?: SessionOrigin
}

// Fired for plugin-defined tools and TypeClaw-exposed system tools, including
// built-in pi tools (read/bash/edit/write/grep/find/ls) when plugins are wired.
//
// Set exclusively by TypeClaw's tool wrappers before a tool.before hook runs.
// Tool names and arguments are model/plugin controlled, so guards must not use
// either as evidence that a call is first-party.
export type ToolProvenance = 'first-party' | 'plugin'

export type ToolBeforeEvent = {
  tool: string
  sessionId: string
  callId: string
  args: Record<string, unknown>
  origin?: SessionOrigin
  // Internal wrapper-authenticated provenance. Omitted only by direct callers;
  // guards must treat an omitted value as untrusted.
  toolProvenance?: ToolProvenance
  // The tool author's operand declarations (never model-controlled — set on the
  // static Tool definition at registration). Carried so a guard that runs before
  // the file-operand scanner (private-surface-read) can honor the same
  // `nonFile` exemptions and not block a declared remote identifier that happens
  // to collide with a hidden dir name. Present only for plugin tools.
  fileOperands?: ToolFileOperands
}

export type ToolBeforeResult = void | undefined | { block: true; reason: string }

export type ToolAfterEvent = {
  tool: string
  sessionId: string
  callId: string
  result: ToolResult
}

export type HookContext = {
  agentDir: string
  pluginName: string
  logger: PluginLogger
}

export type Hooks = {
  'session.start'?: (event: SessionStartEvent, ctx: HookContext) => Promise<void> | void
  'session.end'?: (event: SessionEndEvent, ctx: HookContext) => Promise<void> | void
  'session.idle'?: (event: SessionIdleEvent, ctx: HookContext) => Promise<void> | void
  'session.prompt'?: (event: SessionPromptEvent, ctx: HookContext) => Promise<void> | void
  'session.turn.start'?: (event: SessionTurnStartEvent, ctx: HookContext) => Promise<void> | void
  'session.turn.end'?: (event: SessionTurnEndEvent, ctx: HookContext) => Promise<void> | void
  'tool.before'?: (event: ToolBeforeEvent, ctx: HookContext) => Promise<ToolBeforeResult> | ToolBeforeResult
  'tool.after'?: (event: ToolAfterEvent, ctx: HookContext) => Promise<void> | void
}

export type HookName = keyof Hooks

export type PluginLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type SpawnSubagentOptions = {
  // Identifies the spawning session so the subagent's session origin carries
  // parent provenance. Hook handlers that own this context (e.g. session.idle,
  // session.turn.end) should pass at minimum `parentSessionId` and
  // `spawnedByOrigin: event.origin`. The runtime resolves `spawnedByRole`
  // from the origin via the PermissionService, so the spawning session's
  // role is inherited rather than forged from outside.
  //
  // TRUST MODEL: `spawnedByOrigin` accepts any SessionOrigin, including
  // `{ kind: 'system' }`, which resolves to owner. That is intentional and
  // not an escalation path: a plugin is a full-trust, in-process module with
  // no sandbox (see AGENTS.md / docs/internals/skills) — it can already do
  // anything the runtime can, so minting a system origin grants it nothing it
  // lacks. The anti-forgery guarantee this API preserves is narrower and
  // unaffected: inbound channel/cron CONTENT can never reach owner, because
  // those origins are constructed by the runtime from the transport, never
  // from message text, and a content-driven turn cannot produce a `system`
  // origin. Bundled infra (memory, backup) uses `system` to act on the
  // operator's own state; third-party plugins should pass `event.origin`.
  parentSessionId?: string
  spawnedByOrigin?: SessionOrigin
}

export type PluginContext<TConfig = never> = {
  readonly name: string
  readonly version: string | undefined
  readonly agentDir: string
  readonly config: TConfig
  readonly logger: PluginLogger
  readonly permissions: PermissionService
  readonly github: PluginGithubServices
  spawnSubagent: (name: string, payload?: unknown, options?: SpawnSubagentOptions) => Promise<void>
}

export type PluginGithubServices = {
  resolveTokenForRepo: ResolveGithubTokenForRepo
  hasAppTokenResolver: () => boolean
  getAppSelfLogin?: () => string | null
}

export type PluginExports = {
  tools?: Record<string, Tool<any>>
  subagents?: Record<string, Subagent<any>>
  cronJobs?: Record<string, PluginCronJob>
  skills?: Record<string, PluginSkill>
  skillsDirs?: string[]
  hooks?: Hooks
  doctorChecks?: Record<string, PluginDoctorCheck>
  // Released once when the agent stops, for plugin-lifetime resources a GC can't
  // reclaim deterministically (open DB handles, timers). Disposers are isolated:
  // one throwing never blocks the others.
  onDispose?: () => void | Promise<void>
}

// `typeclaw doctor` plugin extension surface. Each check is read-only by
// default; declaring `fix.apply` opts the check into `typeclaw doctor --fix`,
// where the host serializes plugin fixes, validates their `changedPaths`
// against the agent folder, and commits the union of all fixes in a single
// commit.
export type PluginDoctorCheck = {
  description: string
  category?: string
  run: (ctx: PluginDoctorContext) => Promise<PluginCheckResult>
}

export type PluginDoctorContext = {
  readonly pluginName: string
  readonly agentDir: string
  readonly config: unknown
  readonly logger: PluginLogger
}

export type PluginCheckStatus = 'ok' | 'warning' | 'error'

export type PluginCheckResult = {
  status: PluginCheckStatus
  message: string
  details?: string[]
  fix?: PluginFixSuggestion
}

export type PluginFixSuggestion = {
  description: string
  // When omitted, the fix is advisory-only. `typeclaw doctor --fix` only
  // attempts to remediate checks whose suggestion includes an `apply`.
  apply?: (ctx: PluginDoctorContext) => Promise<PluginFixResult>
}

export type PluginFixResult = {
  // One-line description that appears in the commit body as a bullet.
  summary: string
  // POSIX paths relative to agentDir; the host validates each one stays
  // inside agentDir before `git add`ing. Absolute paths and `..` segments
  // are rejected to keep plugin fixes from staging files outside the agent
  // folder. Empty array is valid (e.g. a fix that only logs).
  changedPaths: string[]
}

export type DefinedPlugin<TConfig = never> = {
  readonly configSchema?: z.ZodType<TConfig>
  readonly permissions?: readonly string[]
  // Permission strings the owner wildcard sentinel MUST NOT auto-expand
  // to. Used by the bundled security plugin to keep audience-leak
  // (high-tier) bypasses off the owner role unless an operator grants
  // them explicitly in roles.owner.permissions[]. Generic by design so
  // any future plugin can carve specific permissions out of the wildcard.
  readonly ownerWildcardExclusions?: readonly string[]
  // Declared by-value (not built inside the factory) so the host-stage CLI
  // can dispatch commands without booting plugin runtime state.
  readonly commands?: Record<string, PluginCommand>
  readonly plugin: (ctx: PluginContext<TConfig>) => Promise<PluginExports>
}

// `surface` controls where a plugin command may run: `'container'` requires
// the agent runtime (prompt/subagent/exec); `'host'` runs on the user's
// machine with no agent runtime; `'either'` accepts the intersection ctx
// and runs on whichever stage the user invoked it from.
export type PluginCommand = ContainerCommand | HostCommand | EitherCommand

export type ContainerCommand<A = unknown> = {
  readonly surface: 'container'
  readonly description: string
  // v1 constraint: `z.object({...})` with primitive (string/number/boolean/
  // literal/enum) leaves so `--help` can render `--<name>=<type>`.
  readonly args?: z.ZodObject<z.ZodRawShape>
  readonly permissions?: readonly string[]
  // When true, runtime spawns a fresh Bun subprocess instead of dispatching
  // in-process. Costs ~150ms cold-start; trade for isolation from the agent.
  readonly isolated?: boolean
  readonly run: (ctx: ContainerCommandContext, args: A) => Promise<number>
}

export type HostCommand<A = unknown> = {
  readonly surface: 'host'
  readonly description: string
  readonly args?: z.ZodObject<z.ZodRawShape>
  readonly run: (ctx: HostCommandContext, args: A) => Promise<number>
}

export type EitherCommand<A = unknown> = {
  readonly surface: 'either'
  readonly description: string
  readonly args?: z.ZodObject<z.ZodRawShape>
  readonly run: (ctx: EitherCommandContext, args: A) => Promise<number>
}

export type CommandStreams = {
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: WritableStream<Uint8Array>
  readonly stderr: WritableStream<Uint8Array>
}

export type CommandExecResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type ContainerCommandContext = CommandStreams & {
  // The plugin name (e.g. `'my-utilities'`), NOT the command name. Matches
  // `PluginContext.name`. Use the command's own static name if you need it.
  readonly name: string
  readonly version: string | undefined
  readonly agentDir: string
  readonly logger: PluginLogger
  readonly permissions: PermissionService
  // Caller's origin (cron job, TUI op, parent session). Drives permission
  // resolution inside the command. Dispatcher refuses to run without one.
  readonly origin: SessionOrigin
  readonly signal: AbortSignal
  readonly prompt: (text: string) => Promise<string>
  readonly subagent: (name: string, payload?: unknown) => Promise<void>
  readonly exec: (cmd: TemplateStringsArray, ...values: unknown[]) => Promise<CommandExecResult>
}

export type HostCommandContext = CommandStreams & {
  // The plugin name, NOT the command name. See `ContainerCommandContext.name`.
  readonly name: string
  readonly version: string | undefined
  // Host path of the agent folder (e.g. the absolute path to the agent
  // folder), NOT `/agent`.
  readonly agentDir: string
  readonly logger: PluginLogger
  readonly signal: AbortSignal
}

export type EitherCommandContext = CommandStreams & {
  // The plugin name, NOT the command name. See `ContainerCommandContext.name`.
  readonly name: string
  readonly version: string | undefined
  // Resolves to `/agent` in container, host path on host — same author code.
  readonly agentDir: string
  readonly logger: PluginLogger
  readonly signal: AbortSignal
}
