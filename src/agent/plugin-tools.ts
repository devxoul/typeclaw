import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import {
  createBashToolDefinition as piCreateBashToolDefinition,
  createEditToolDefinition as piCreateEditToolDefinition,
  createFindToolDefinition as piCreateFindToolDefinition,
  createGrepToolDefinition as piCreateGrepToolDefinition,
  createLsToolDefinition as piCreateLsToolDefinition,
  createReadToolDefinition as piCreateReadToolDefinition,
  createWriteToolDefinition as piCreateWriteToolDefinition,
  defineTool as piDefineTool,
} from '@earendil-works/pi-coding-agent'
import type { BashSpawnContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Static, TSchema } from 'typebox'
import { Type } from 'typebox'
import { z } from 'zod'

import { ACKNOWLEDGE_GUARDS } from '@/bundled-plugins/guard/keys'
import { config, getSandboxWritablePathSpecs } from '@/config/config'
import { readEnvFile } from '@/init/env-file'
import {
  classifyToolOutcome,
  deriveMechanicallyVerifiedIncidentFingerprints,
  IncidentLedger,
  operationalRemediations,
  renderIncidentHint,
  renderUntrackedIncidentHint,
  repairAndRetryOnce,
} from '@/operations'
import type { RemediationRegistry } from '@/operations'
import type { PermissionService } from '@/permissions/permissions'
import type {
  BuiltinToolRef,
  ContentPart,
  HookBus,
  PluginLogger,
  Tool,
  ToolBeforeEvent,
  ToolContext,
  ToolFileOperands,
  ToolResult,
} from '@/plugin'
import { PI_BUILTIN_TOOL_NAMES, type PiBuiltinToolName } from '@/plugin/core-tool-names'
import {
  buildSandboxedCommand,
  canWriteAgentRootInSandbox,
  canMountRealProc,
  cleanupPrivilegedSandboxRuntime,
  commandNeedsRealProc,
  DEFAULT_SANDBOX_ENV,
  DEPENDENCY_BIN_SANDBOX_DIR,
  dependencyBinUnavailableHint,
  ensureBwrapAvailable,
  ensureHiddenMaskTargets,
  ensureSessionTmpDir,
  getProcBindSafetyVerdict,
  isGitControlPath,
  mapVirtualTmpPath,
  reconcileDependencyBinWrappers,
  resolveHiddenPaths,
  resolvePrivilegedSandboxRuntime,
  resolveProcBindSafetyWithRetry,
  resolveProcSelfExe,
  resolveProtectedZones,
  resolveSandboxSymlinks,
  resolveWritableZones,
  SandboxPolicyError,
  SandboxDegradedProcError,
  SandboxProcProbeUnverifiedError,
  type SandboxMount,
  type DependencyBinReconciliation,
  subtractMasked,
  verifyHiddenMaskTargets,
  verifyPrivilegedSandboxRuntime,
} from '@/sandbox'
import { resolveExposableEnvNames } from '@/sandbox/env-exposure'

import type { InternalGuard } from './guard-types'
import { createLoopGuard, type LoopGuard, type LoopGuardDecision } from './loop-guard'
import { enforceSubagentBashPolicy, type SubagentBashPolicy } from './reviewer-bash-policy'
import type { SessionOrigin } from './session-origin'
import { remediateToolErrorMessage } from './tool-error-remediation'
import { enforceAndPinToolFiles, writeToolOutputNoFollow } from './tool-file-safety'
import { SUBAGENT_OUTPUT_TOOL_NAME, type SubagentOutputToolDetails } from './tools/subagent-output'
import { webFetchTool } from './tools/webfetch'
import { webSearchTool } from './tools/websearch'

// Process-wide loop guard. State is keyed by sessionId so concurrent sessions
// don't interfere; the guard's own LRU bound keeps it from growing without
// limit. Wrappers consult it before invoking the underlying tool so the
// detector covers every tool category — plugin tools, TypeClaw system tools,
// and pi-coding-agent builtins — through one chokepoint.
let sharedLoopGuard: LoopGuard = createLoopGuard()

// Internal, non-model-facing contract: a tool.before hook may set this key on
// a bash call's args to inject env vars into the spawned process WITHOUT
// putting them in the command string (where they would leak through logs and
// later hooks). The wrapper extracts and deletes it before the bash tool runs,
// then threads it to the spawn. Sandboxed secret values stay in bwrap's parent
// environment and are inherited by name rather than rendered into argv. Used
// by github-cli-auth to inject a per-repo GH_TOKEN. The key
// is stripped from client-supplied args before tool.before so only trusted
// hooks can set it.
export const TYPECLAW_INTERNAL_BASH_ENV = '__typeclawBashEnv'
export const TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV = '__typeclawBashWithholdEnv'
export const TYPECLAW_INTERNAL_BASH_PREPARE = '__typeclawBashPrepare'

type BashEnvOverlay = Record<string, string>
type BashEnvWithhold = string[]
export type DeferredBashPreparationResult = {
  command: string
  env?: Record<string, string>
  mount: Extract<SandboxMount, { type: 'ro-bind' }>
  cleanup: () => Promise<void>
}
export type DeferredBashPreparation = () => Promise<DeferredBashPreparationResult>
const SECRET_BASH_ENV_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN'])

// Transport classifier for the TRUSTED hook-injected overlay only (e.g.
// github-cli-auth's per-repo GH_TOKEN). Token/secret-shaped names use `inherit`
// so their value never renders into the bwrap argv; plain names (GH_REPO) go
// via `set`. This is NOT a .env exposure filter — the overlay is populated by
// trusted runtime hooks, not operator .env.
const OVERLAY_SECRET_NAME_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTH)$/i
function isOverlaySecretName(name: string): boolean {
  return SECRET_BASH_ENV_NAMES.has(name) || OVERLAY_SECRET_NAME_PATTERN.test(name)
}

type BashSpawnEnvContext = {
  overlay?: BashEnvOverlay
  withhold?: BashEnvWithhold
  // Exact env for the outer bwrap process on a sandboxed call. When present, the
  // spawn hook uses it verbatim rather than the live inherited env, so a secret
  // that appears in process.env between policy build and spawn stays out of the
  // sandbox (closes the inherit TOCTOU).
  sandboxSpawnEnv?: Record<string, string>
}

const bashEnvStore = new AsyncLocalStorage<BashSpawnEnvContext | undefined>()

function readBashEnvOverlay(args: Record<string, unknown>): BashEnvOverlay | undefined {
  const raw = args[TYPECLAW_INTERNAL_BASH_ENV]
  if (raw === null || typeof raw !== 'object') return undefined
  const overlay: BashEnvOverlay = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') overlay[key] = value
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined
}

function readBashEnvWithhold(args: Record<string, unknown>): BashEnvWithhold | undefined {
  const raw = args[TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV]
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === 'string')) return undefined
  const names = [...new Set(raw)]
  return names.length > 0 ? names : undefined
}

function readBashPreparation(args: Record<string, unknown>): DeferredBashPreparation | undefined {
  const raw = args[TYPECLAW_INTERNAL_BASH_PREPARE]
  return typeof raw === 'function' ? (raw as DeferredBashPreparation) : undefined
}

function bashSpawnHookWithOverlay(context: BashSpawnContext): BashSpawnContext {
  const store = bashEnvStore.getStore()
  if (store?.sandboxSpawnEnv !== undefined) return { ...context, env: { ...store.sandboxSpawnEnv } }
  return { ...context, env: sanitizeBashSpawnEnvironment(context.env, store?.overlay, store?.withhold) }
}

export function sanitizeBashSpawnEnvironment(
  inherited: NodeJS.ProcessEnv | undefined,
  overlay: BashEnvOverlay | undefined,
  withhold: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env = { ...inherited }
  for (const name of SECRET_BASH_ENV_NAMES) delete env[name]
  for (const name of withhold) delete env[name]
  // A trusted overlay deliberately replaces ambient state for this command, so
  // it wins when the same name is also withheld.
  if (overlay !== undefined) Object.assign(env, overlay)
  return env
}

// pi-coding-agent 0.87 contract (load-bearing for hook coverage):
//   - `createAgentSession({ tools: string[] })` is a name allowlist: only the
//     listed builtin and custom tool names are active (sdk.d.ts:35-47).
//   - `noTools: "builtin"` disables Pi's default read/bash/edit/write tools but
//     leaves custom tools eligible for that allowlist (sdk.d.ts:27-47).
//
// Consequence: every builtin enters as a `ToolDefinition`, TypeClaw wraps each
// one with its hook + guard + sandbox pipeline, and the call site routes them
// through `customTools` while narrowing via `tools:` names. A named custom
// definition replaces the built-in implementation in the active registry.
type TypeclawToolName = 'web_search' | 'web_fetch'

// pi builtins resolve relative paths (and, for trusted/owner bash, the spawn
// cwd) against the cwd baked in at factory time, so the definitions are built
// per session from the session's agentDir rather than the module-load
// process.cwd() — otherwise a session whose agentDir differs from the import-
// time cwd would read/write in the wrong tree. bash keeps the spawnHook that
// threads the internal env overlay to the (non-sandboxed) spawn.
function createPiBuiltinToolDefinition(name: PiBuiltinToolName, cwd: string): ToolDefinition<any, any, any> {
  switch (name) {
    case 'read':
      return piCreateReadToolDefinition(cwd)
    case 'bash':
      return piCreateBashToolDefinition(cwd, {
        // Pi 0.87 assumes a non-empty ExtensionContext when session metadata is
        // enabled (tools/bash.js:122-143). TypeClaw owns the bash environment
        // boundary, so disable Pi metadata rather than bypassing the spawn hook.
        exposeSessionEnvironment: false,
        spawnHook: bashSpawnHookWithOverlay,
      })
    case 'edit':
      return piCreateEditToolDefinition(cwd)
    case 'write':
      return piCreateWriteToolDefinition(cwd, {
        operations: {
          mkdir: async (dir) => {
            await mkdir(dir, { recursive: true })
          },
          writeFile: writeToolOutputNoFollow,
        },
      })
    case 'grep':
      return piCreateGrepToolDefinition(cwd)
    case 'find':
      return piCreateFindToolDefinition(cwd)
    case 'ls':
      return piCreateLsToolDefinition(cwd)
  }
}

const TYPECLAW_TOOL_DEFINITION_MAP: Record<TypeclawToolName, ToolDefinition<any, any, any>> = {
  web_search: webSearchTool,
  web_fetch: webFetchTool,
}

function isPiBuiltinToolName(name: string): name is PiBuiltinToolName {
  return (PI_BUILTIN_TOOL_NAMES as readonly string[]).includes(name)
}

export function isPiCodingBuiltinName(name: string): boolean {
  return isPiBuiltinToolName(name)
}

function isTypeclawToolName(name: string): name is TypeclawToolName {
  return name in TYPECLAW_TOOL_DEFINITION_MAP
}

export function resolveBuiltinToolRefs(refs: BuiltinToolRef[], cwd: string): ToolDefinition<any, any, any>[] {
  return refs.map((ref) => {
    const name = ref.__builtinTool
    if (isPiBuiltinToolName(name)) return createPiBuiltinToolDefinition(name, cwd)
    if (isTypeclawToolName(name)) return TYPECLAW_TOOL_DEFINITION_MAP[name]
    throw new Error(`unknown built-in tool ref: ${name}`)
  })
}

export type WrapToolOptions = {
  pluginName: string
  toolName: string
  agentDir: string
  sessionId: string
  logger: PluginLogger
  hooks: HookBus
  guards?: readonly InternalGuard[]
  // Called at tool-execute time (not at wrap time) so channel sessions whose
  // origin mutates per turn surface the current-turn `lastInboundAuthorId`
  // to `tool.before`. Sessions with a fixed origin can pass `() => origin`.
  getOrigin?: () => SessionOrigin | undefined
  permissions?: PermissionService
  // Resolves the current turn's abort handle. Resolved lazily (not at wrap
  // time) because tools are wrapped BEFORE `createAgentSession` returns the
  // session whose `agent.abort` this points at. See `fireLoopAbort`.
  getAbort?: () => ((reason?: string) => void) | undefined
  getLoopGuardTurn?: () => number | undefined
}

export type BashSandboxBoundary = {
  ensureAvailable: () => Promise<void>
  buildCommand: typeof buildSandboxedCommand
  resolveProcStrategy?: () => Promise<ProcStrategyResolution>
  resolveRuntime?: typeof resolvePrivilegedSandboxRuntime
  verifyRuntime?: typeof verifyPrivilegedSandboxRuntime
  cleanupRuntime?: typeof cleanupPrivilegedSandboxRuntime
}

const DEFAULT_BASH_SANDBOX_BOUNDARY: BashSandboxBoundary = {
  ensureAvailable: ensureBwrapAvailable,
  buildCommand: buildSandboxedCommand,
}

export type WrapSystemToolOptions = {
  agentDir: string
  sessionId: string
  hooks: HookBus
  guards?: readonly InternalGuard[]
  getOrigin?: () => SessionOrigin | undefined
  getAbort?: () => ((reason?: string) => void) | undefined
  getLoopGuardTurn?: () => number | undefined
  // When present, the bash builtin is rewritten through the per-tool bwrap
  // sandbox. Private-directory masks remain role-derived; canonical agent
  // secret-file masks apply to every role. Only sessions wired without a
  // permission service fail closed before execution. Production session setup
  // always supplies either the live service or the deny-all service.
  permissions?: PermissionService
  // Per-subagent bash capability policy, enforced as a hard pre-check BEFORE
  // the role-derived sandbox. Lets a read-only subagent keep its bash read-only
  // no matter who spawned it. See
  // `src/agent/reviewer-bash-policy.ts`.
  bashPolicy?: SubagentBashPolicy
  bashSandboxBoundary?: BashSandboxBoundary
  realProcDependencyCheck?: typeof commandNeedsRealProc
  remediations?: RemediationRegistry
  // A dispatcher system tool (mcp_call) forwards a nested payload to a target
  // chosen at call time, so its operand declarations are not knowable from the
  // static tool definition the way a plugin tool's are. This seam resolves them
  // per call, BEFORE the hooks run. The result feeds the security hooks ONLY —
  // it is never handed to `enforceAndPinToolFiles`, so it can never make this
  // boundary pin a file. It must not perform I/O against an unconnected target;
  // returning undefined keeps the existing fail-closed scan.
  resolvePreflightFileOperands?: (tool: string, args: Record<string, unknown>) => ToolFileOperands | undefined
  incidentLedger?: IncidentLedger
}

// Zod 4 emits a top-level `"$schema": "https://json-schema.org/draft/2020-12/schema"`
// pointer on every converted schema. It was first stripped because pi-ai's former
// Ajv (draft 7) validator rejected that URI before execute ran, which left the
// memory-logger and dreaming subagents without `find_entry` and made them read
// whole transcripts on every channel turn. pi 0.87 validates with TypeBox
// instead, but these parameter schemas are still forwarded verbatim to provider
// APIs, and pi strips JSON-Schema meta declarations itself only for Google
// (`sanitizeForOpenApi` in pi-ai dist/api/google-shared.js). Stripping the
// pointer keeps every provider's tool payload identical to earlier releases; it
// removes no constraint, since the schema body is untouched.
export function zodToToolParameters(schema: z.ZodType<unknown>): TSchema {
  const json = z.toJSONSchema(schema, { io: 'input', reused: 'inline' }) as Record<string, unknown>
  delete json.$schema
  return json as unknown as TSchema
}

export function wrapPluginTool(tool: Tool<any>, opts: WrapToolOptions): ToolDefinition {
  const parameters = withGuardAcknowledgements(opts.toolName, zodToToolParameters(tool.parameters), opts.guards ?? [])

  return piDefineTool({
    name: opts.toolName,
    label: opts.toolName,
    description: tool.description,
    parameters,
    async execute(toolCallId, params, signal) {
      const envelope = extractGuardAcknowledgements(params, opts.toolName, opts.guards ?? [])
      if (!envelope.ok) return errorResult(`invalid arguments: ${envelope.error}`)

      const validated = tool.parameters.safeParse(envelope.pluginArgs)
      if (!validated.success) {
        return errorResult(`invalid arguments: ${validated.error.message}`)
      }

      const mutableArgs = validated.data as Record<string, unknown>
      const liveOrigin = opts.getOrigin?.()
      const before: ToolBeforeEvent = {
        tool: opts.toolName,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
        toolProvenance: 'plugin',

        ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
        ...(tool.fileOperands !== undefined ? { fileOperands: tool.fileOperands } : {}),
      }
      const blockResult = await opts.hooks.runToolBefore(before, opts.guards, envelope.acknowledgements)
      if (blockResult !== undefined) {
        return errorResult(`blocked: ${blockResult.reason}`)
      }

      const loopGate = gateLoopGuard(
        opts.sessionId,
        opts.toolName,
        before.args,
        opts.getLoopGuardTurn?.(),
        opts.agentDir,
      )
      if (loopGate.blockNow) {
        fireLoopAbort(opts.getAbort, 'loop_guard:block', opts.sessionId)
        return errorResult(loopGate.message)
      }

      const toolCtx: ToolContext = {
        signal,
        sessionId: opts.sessionId,
        agentDir: opts.agentDir,
        logger: opts.logger,
      }

      let result: ToolResult | undefined
      let executionError: unknown
      let cleanupError: unknown
      const pinnedFiles = await enforceAndPinToolFiles({
        tool: opts.toolName,
        args: before.args,
        agentDir: opts.agentDir,
        toolProvenance: 'plugin',
        genericInputs: true,
        fileOperands: tool.fileOperands,
        logger: opts.logger,
        signal,
      })
      try {
        result = await tool.execute(before.args, toolCtx)
      } catch (err) {
        executionError = err
      } finally {
        try {
          await pinnedFiles.cleanup()
        } catch (error) {
          cleanupError = error
        }
      }
      const finalError = executionError ?? cleanupError
      if (finalError !== undefined) {
        const failure = errorResult(finalError instanceof Error ? finalError.message : String(finalError))
        await runToolAfterSafely(opts, opts.toolName, toolCallId, failure)
        if (cleanupError !== undefined) throw finalError
        return failure
      }
      if (result === undefined) throw new Error('plugin tool execution returned no result')
      result = pinnedFiles.restoreResult(result)

      const resolved = loopGate.resolve(result)
      if ('deferredBlock' in resolved) {
        fireLoopAbort(opts.getAbort, 'loop_guard:deferred_block', opts.sessionId)
        return errorResult(resolved.deferredBlock)
      }
      result = resolved.result

      await opts.hooks.runToolAfter({
        tool: opts.toolName,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result,
      })

      return {
        content: result.content as ContentPart[],
        details: result.details,
      }
    },
  })
}

export function wrapSystemTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  opts: WrapSystemToolOptions,
): ToolDefinition<TParams, TDetails, TState> {
  return piDefineTool({
    ...tool,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters, opts.guards ?? []),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const envelope = extractGuardAcknowledgements(params, tool.name, opts.guards ?? [])
      if (!envelope.ok) throw new Error(`invalid arguments: ${envelope.error}`)
      const mutableArgs = envelope.pluginArgs as Record<string, unknown>
      normalizeDefaultTreeRoot(tool.name, mutableArgs)
      const liveOrigin = opts.getOrigin?.()
      const preflightFileOperands = opts.resolvePreflightFileOperands?.(tool.name, mutableArgs)
      const blockResult = await opts.hooks.runToolBefore(
        {
          tool: tool.name,
          sessionId: opts.sessionId,
          callId: toolCallId,
          args: mutableArgs,
          toolProvenance: 'first-party',
          ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
          ...(preflightFileOperands !== undefined ? { fileOperands: preflightFileOperands } : {}),
        },
        opts.guards,
        envelope.acknowledgements,
      )
      if (blockResult !== undefined) {
        throw new Error(`blocked: ${blockResult.reason}`)
      }
      const gitControlResult = await checkGitControlWriteGuard({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (gitControlResult !== undefined) throw new Error(`blocked: ${gitControlResult.reason}`)
      const loopGate = gateLoopGuard(opts.sessionId, tool.name, mutableArgs, opts.getLoopGuardTurn?.(), opts.agentDir)
      if (loopGate.blockNow) {
        fireLoopAbort(opts.getAbort, 'loop_guard:block', opts.sessionId)
        throw new Error(loopGate.message)
      }
      // `preflightFileOperands` is deliberately NOT forwarded: this boundary's
      // canonical credential denial must stay unconditional, so a target-declared
      // nonFile operand can never exempt `secrets.json`/`.env`/`~/.ssh` from it.
      const pinnedFiles = await enforceAndPinToolFiles({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
        toolProvenance: 'first-party',
        genericInputs: tool.name !== 'mcp_call',
        ...(opts.permissions !== undefined
          ? { hidden: resolveHiddenPaths(opts.permissions, liveOrigin, opts.agentDir) }
          : {}),
        signal,
      })
      let result: Awaited<ReturnType<typeof tool.execute>> | undefined
      let executionError: unknown
      let cleanupError: unknown
      try {
        result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate, ctx)
      } catch (error) {
        executionError = error
      } finally {
        try {
          await pinnedFiles.cleanup()
        } catch (error) {
          cleanupError = error
        }
      }
      const finalError = executionError ?? cleanupError
      if (finalError !== undefined) {
        await runToolAfterSafely(opts, tool.name, toolCallId, toErrorResult(finalError))
        throw finalError
      }
      if (result === undefined) throw new Error('system tool execution returned no result')
      const restoredResult = pinnedFiles.restoreResult({
        content: result.content as ContentPart[],
        details: result.details,
      })
      const resolved = loopGate.resolve(restoredResult)
      if ('deferredBlock' in resolved) {
        fireLoopAbort(opts.getAbort, 'loop_guard:deferred_block', opts.sessionId)
        throw new Error(resolved.deferredBlock)
      }
      const hookResult = resolved.result
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      return {
        content: hookResult.content as ContentPart[],
        details: hookResult.details as TDetails,
      }
    },
  })
}

// Wraps a pi builtin `ToolDefinition` (read/bash/edit/write/grep/find/ls) with
// TypeClaw's full pipeline — hooks, loop guard, write/read guards, per-subagent
// bash policy, bwrap sandbox, /tmp redirect, and the internal bash env overlay —
// then ships it through `customTools`. `noTools: "builtin"` at the call site
// disables pi's own unwrapped copies, so this wrapped definition is the ONLY
// registered implementation of each builtin name.
export function wrapBuiltinToolDefinition<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  opts: WrapSystemToolOptions,
): ToolDefinition<TParams, TDetails, TState> {
  return piDefineTool({
    ...tool,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters, opts.guards ?? []),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const envelope = extractGuardAcknowledgements(params, tool.name, opts.guards ?? [])
      if (!envelope.ok) throw new Error(`invalid arguments: ${envelope.error}`)
      const mutableArgs = envelope.pluginArgs as Record<string, unknown>
      const originalBashCommand =
        tool.name === 'bash' && typeof mutableArgs.command === 'string' ? mutableArgs.command : undefined
      normalizeDefaultTreeRoot(tool.name, mutableArgs)
      const liveOrigin = opts.getOrigin?.()
      // Defense-in-depth: strip pre-existing internal env-control keys before
      // hooks run so only trusted tool.before hooks can set them.
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_ENV]
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV]
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_PREPARE]
      const blockResult = await opts.hooks.runToolBefore(
        {
          tool: tool.name,
          sessionId: opts.sessionId,
          callId: toolCallId,
          args: mutableArgs,
          toolProvenance: 'first-party',
          ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
        },
        opts.guards,
        envelope.acknowledgements,
      )
      if (blockResult !== undefined) {
        throw new Error(`blocked: ${blockResult.reason}`)
      }
      const gitControlResult = await checkGitControlWriteGuard({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (gitControlResult !== undefined) throw new Error(`blocked: ${gitControlResult.reason}`)
      // Extract and delete before the loop guard serializes args and before
      // the bash tool destructures them, so the overlay never reaches logs,
      // loop-detection state, or pi's execute.
      const bashEnvOverlay = readBashEnvOverlay(mutableArgs)
      const bashEnvWithhold = readBashEnvWithhold(mutableArgs)
      const bashPreparation = readBashPreparation(mutableArgs)
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_ENV]
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV]
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_PREPARE]
      const loopGate = gateLoopGuard(opts.sessionId, tool.name, mutableArgs, opts.getLoopGuardTurn?.(), opts.agentDir)
      if (loopGate.blockNow) {
        fireLoopAbort(opts.getAbort, 'loop_guard:block', opts.sessionId)
        throw new Error(loopGate.message)
      }
      // Per-subagent capability fence: runs BEFORE the role-derived sandbox so
      // a read-only subagent's bash stays read-only even for a trusted/owner
      // caller whose sandbox otherwise preserves full agent-root writes. Throws
      // SubagentBashPolicyError on a disallowed command, surfaced to the model as
      // a tool error.
      if (tool.name === 'bash' && opts.bashPolicy !== undefined) {
        const command = mutableArgs.command
        if (typeof command === 'string') enforceSubagentBashPolicy(opts.bashPolicy, command)
      }

      let preparedSandboxRuntime: PreparedBashSandbox | undefined
      let pinnedFiles: Awaited<ReturnType<typeof enforceAndPinToolFiles>> | undefined
      let tmpRedirect: TmpRedirect | undefined
      let rawResult: ToolResult | undefined
      let executionError: unknown
      let cleanupError: unknown
      let sandboxedRealProcSucceeded = false
      const sandboxBoundary = opts.bashSandboxBoundary ?? DEFAULT_BASH_SANDBOX_BOUNDARY
      const incidentLedger = opts.incidentLedger ?? new IncidentLedger(opts.agentDir)
      const originalArgs = { ...mutableArgs }
      const executeAttempt = async (): Promise<void> => {
        preparedSandboxRuntime = undefined
        pinnedFiles = undefined
        tmpRedirect = undefined
        rawResult = undefined
        executionError = undefined
        cleanupError = undefined
        sandboxedRealProcSucceeded = false
        const attemptArgs = { ...originalArgs }
        try {
          if (tool.name === 'bash') {
            if (opts.permissions === undefined) {
              throw new SandboxPolicyError(
                'model-driven bash has no permission service; refusing unsandboxed execution',
              )
            }
            preparedSandboxRuntime = await applyBashSandbox(
              attemptArgs,
              opts.permissions,
              liveOrigin,
              opts.agentDir,
              opts.sessionId,
              bashEnvOverlay,
              bashEnvWithhold,
              bashPreparation,
              sandboxBoundary,
            )
          }

          tmpRedirect =
            TMP_REDIRECT_TOOLS.has(tool.name) && opts.permissions !== undefined
              ? await applyTmpPathRedirect(attemptArgs, opts.permissions, liveOrigin, opts.agentDir, opts.sessionId)
              : undefined
          pinnedFiles = await enforceAndPinToolFiles({
            tool: tool.name,
            args: attemptArgs,
            agentDir: opts.agentDir,
            toolProvenance: 'first-party',
            ...(opts.permissions !== undefined
              ? {
                  hidden:
                    preparedSandboxRuntime?.withheld.paths ??
                    resolveHiddenPaths(opts.permissions, liveOrigin, opts.agentDir),
                }
              : {}),
            signal,
          })
          await preparedSandboxRuntime?.verify()
          const spawnEnvContext: BashSpawnEnvContext | undefined =
            bashEnvOverlay !== undefined ||
            bashEnvWithhold !== undefined ||
            preparedSandboxRuntime?.spawnEnv !== undefined
              ? {
                  ...(bashEnvOverlay !== undefined ? { overlay: bashEnvOverlay } : {}),
                  ...(bashEnvWithhold !== undefined ? { withhold: bashEnvWithhold } : {}),
                  ...(preparedSandboxRuntime?.spawnEnv !== undefined
                    ? { sandboxSpawnEnv: preparedSandboxRuntime.spawnEnv }
                    : {}),
                }
              : undefined
          const executed = await bashEnvStore.run(spawnEnvContext, () =>
            tool.execute(toolCallId, attemptArgs as Static<TParams>, signal, onUpdate, ctx),
          )
          // Pi 0.99 bash returns a nonzero exit as an `isError` result whose text
          // is the message 0.87 threw (tools/bash.js). This wrapper returns only
          // content/details, so rethrow to keep the failure on the error path
          // (remediation, incident repair, sandbox note, model-facing isError).
          if (executed.isError === true) {
            throw new Error(executed.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'))
          }
          rawResult = executed
          const originalCommand = originalArgs.command
          sandboxedRealProcSucceeded =
            preparedSandboxRuntime !== undefined &&
            typeof originalCommand === 'string' &&
            (opts.realProcDependencyCheck ?? commandNeedsRealProc)(originalCommand)
        } catch (error) {
          executionError = error
        } finally {
          const cleanup = [pinnedFiles?.cleanup(), preparedSandboxRuntime?.cleanup()].filter(
            (task): task is Promise<void> => task !== undefined,
          )
          const outcomes = await Promise.allSettled(cleanup)
          const failed = outcomes.find((outcome) => outcome.status === 'rejected')
          if (failed?.status === 'rejected') cleanupError = failed.reason
        }
      }

      await executeAttempt()
      // Decorate genuine, user-correctable builtin file-tool failures with a
      // recovery hint so weaker models retry correctly. Only executionError (not
      // cleanupError) and only non-aborted Error instances; remediation is a
      // no-op for every message/tool outside the allowlist, so abort, sandbox,
      // and policy errors pass through untouched. Mutating the message in place
      // preserves the error's subclass and stack for the rethrow.
      if (cleanupError === undefined && executionError instanceof Error && signal?.aborted !== true) {
        executionError.message = remediateToolErrorMessage(tool.name, executionError.message)
        const incidentFact = classifyToolOutcome({ tool: tool.name, error: executionError })
        if (incidentFact !== null) {
          const initialError = executionError
          let recordedFingerprint: string | undefined
          let incidentHint = renderUntrackedIncidentHint(incidentFact)
          try {
            const incident = await incidentLedger.record(incidentFact, opts.sessionId)
            recordedFingerprint = incident.fingerprint
            incidentHint = renderIncidentHint(incident)
          } catch {
            // Incident persistence must never hide the originating tool failure.
          }
          const remediation = await repairAndRetryOnce(
            opts.remediations ?? operationalRemediations,
            incidentFact,
            initialError,
            async () => {
              await executeAttempt()
              const retryError = executionError ?? cleanupError
              if (retryError !== undefined) throw retryError
            },
          )
          if (remediation.outcome === 'retried') {
            const retrySuccessFingerprints = deriveMechanicallyVerifiedIncidentFingerprints({
              tool: tool.name,
              args: originalArgs,
              sandboxedRealProcSucceeded,
            })
            if (recordedFingerprint !== undefined && retrySuccessFingerprints.has(recordedFingerprint)) {
              await incidentLedger.resolve(recordedFingerprint).catch(() => false)
            }
          } else {
            const failedError = remediation.outcome === 'retry-failed' ? remediation.error : initialError
            const finalIncidentError = failedError instanceof Error ? failedError : new Error(String(failedError))
            finalIncidentError.message = remediateToolErrorMessage(tool.name, finalIncidentError.message)
            finalIncidentError.message = `${finalIncidentError.message}\n\n${incidentHint}`
            executionError = finalIncidentError
            cleanupError = undefined
          }
        }
      }
      let finalError =
        executionError !== undefined && cleanupError !== undefined
          ? new Error(
              `${executionError instanceof Error ? executionError.message : String(executionError)}\n\n` +
                `Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            )
          : (executionError ?? cleanupError)
      if (finalError !== undefined) {
        // The builtin reports command failures as execution errors rather than
        // result details. Once the sandbox was prepared, annotate every such
        // error without parsing its arbitrary or localized text. Cleanup-only
        // failures are not command failures and remain unchanged.
        if (executionError !== undefined && preparedSandboxRuntime !== undefined) {
          finalError = appendErrorText(
            finalError,
            renderSandboxPolicyNote(preparedSandboxRuntime.withheld, opts.agentDir),
          )
        }
        await runToolAfterSafely(opts, tool.name, toolCallId, toErrorResult(finalError))
        throw finalError
      }
      if (pinnedFiles === undefined) throw new Error('tool file boundary was not initialized')
      if (rawResult === undefined) throw new Error('tool execution returned no result')
      const pinnedResult = pinnedFiles.restoreResult(rawResult)
      let result = tmpRedirect !== undefined ? restoreTmpPathInResult(pinnedResult, tmpRedirect) : pinnedResult
      if (
        originalBashCommand !== undefined &&
        preparedSandboxRuntime?.dependencyBins !== undefined &&
        bashResultIsCommandNotFound(result)
      ) {
        const hint = dependencyBinUnavailableHint(originalBashCommand, preparedSandboxRuntime.dependencyBins)
        if (hint !== undefined) result = appendTextResult(result, hint)
      }
      if (preparedSandboxRuntime !== undefined && bashResultHasNonzeroExit(result)) {
        result = appendTextResult(result, renderSandboxPolicyNote(preparedSandboxRuntime.withheld, opts.agentDir))
      }
      const resolved = loopGate.resolve({ content: result.content as ContentPart[], details: result.details })
      if ('deferredBlock' in resolved) {
        fireLoopAbort(opts.getAbort, 'loop_guard:deferred_block', opts.sessionId)
        throw new Error(resolved.deferredBlock)
      }
      const hookResult = resolved.result
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      const successFingerprints = deriveMechanicallyVerifiedIncidentFingerprints({
        tool: tool.name,
        args: originalArgs,
        sandboxedRealProcSucceeded,
      })
      await incidentLedger.resolveObservedSuccess(successFingerprints).catch(() => 0)
      return {
        content: hookResult.content as ContentPart[],
        details: hookResult.details as TDetails,
      }
    },
  })
}

function toErrorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: message }], details: { error: message } }
}

// The original tool error must always propagate, so a failure inside the
// after-hook itself is swallowed rather than masking the real cause.
async function runToolAfterSafely(
  opts: WrapSystemToolOptions,
  tool: string,
  callId: string,
  result: ToolResult,
): Promise<void> {
  try {
    await opts.hooks.runToolAfter({ tool, sessionId: opts.sessionId, callId, result })
  } catch {
    // intentionally ignored: never mask the originating tool error
  }
}

export function defaultBuiltinPiToolDefinitions(cwd: string): ToolDefinition<any, any, any>[] {
  return PI_BUILTIN_TOOL_NAMES.map((name) => createPiBuiltinToolDefinition(name, cwd))
}

export function buildBuiltinPiToolOverrides(opts: WrapSystemToolOptions): ToolDefinition<any, any>[] {
  return defaultBuiltinPiToolDefinitions(opts.agentDir).map((tool) => wrapBuiltinToolDefinition(tool, opts))
}

type BashFilesystemPolicyOptions = {
  agentDir: string
  canWriteAgentRoot: boolean
  masks: { dirs: string[]; files: string[] }
  writable: { dirs: string[]; files: string[] }
  protected: { dirs: string[]; files: string[] }
}

type PreparedBashSandbox = {
  verify: () => Promise<void>
  cleanup: () => Promise<void>
  spawnEnv?: Record<string, string>
  dependencyBins?: DependencyBinReconciliation
  withheld: {
    paths: { dirs: string[]; files: string[] }
    envNames: string[]
  }
}

export function buildBashFilesystemPolicy(options: BashFilesystemPolicyOptions) {
  const { agentDir, canWriteAgentRoot, masks, writable, protected: protectedZones } = options
  if (canWriteAgentRoot) {
    return { writableRoot: { dir: agentDir }, masks, protected: protectedZones }
  }
  return { masks, writable, protected: protectedZones }
}

// Rewrites mutableArgs.command in place so the bash builtin runs inside bwrap
// with role-derived private-directory masks and unconditional canonical-secret
// file masks. When masks are needed but bwrap is unavailable
// we throw rather than run unsandboxed — fail closed, never leak the masked
// surface. Runs after the tool.before guards have inspected the raw command.
async function applyBashSandbox(
  mutableArgs: Record<string, unknown>,
  permissions: PermissionService,
  origin: SessionOrigin | undefined,
  agentDir: string,
  sessionId: string,
  envOverlay: BashEnvOverlay | undefined,
  envWithhold: BashEnvWithhold | undefined,
  deferredPreparation: DeferredBashPreparation | undefined,
  boundary: BashSandboxBoundary,
): Promise<PreparedBashSandbox> {
  const originalCommand = mutableArgs.command
  if (typeof originalCommand !== 'string') {
    return {
      verify: async () => {},
      cleanup: async () => {},
      withheld: { paths: { dirs: [], files: [] }, envNames: [] },
    }
  }

  let preparation: DeferredBashPreparationResult | undefined
  let privilegedRuntime: Awaited<ReturnType<typeof resolvePrivilegedSandboxRuntime>> | undefined
  const cleanup = async (): Promise<void> => {
    const tasks: Promise<void>[] = []
    if (privilegedRuntime !== undefined) {
      tasks.push((boundary.cleanupRuntime ?? cleanupPrivilegedSandboxRuntime)(privilegedRuntime))
    }
    if (preparation !== undefined) tasks.push(preparation.cleanup())
    const outcomes = await Promise.allSettled(tasks)
    const failure = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  try {
    preparation = await deferredPreparation?.()
    const command = preparation?.command ?? originalCommand
    const preparedEnvOverlay = preparation?.env === undefined ? envOverlay : { ...envOverlay, ...preparation.env }
    const { dirs, files } = resolveHiddenPaths(permissions, origin, agentDir)
    const envNames = resolveExposableBashEnvNames(agentDir)
    const sandboxEnvOverlay = buildRoleScopedConfigEnv(agentDir, dirs, preparedEnvOverlay)
    const effectiveEnvWithhold = (envWithhold ?? []).filter((name) => !Object.hasOwn(sandboxEnvOverlay ?? {}, name))
    const maskTargets = await ensureHiddenMaskTargets({ dirs, files })
    await boundary.ensureAvailable()
    const sessionTmp = await ensureSessionTmpDir(sessionId)
    const dependencyBins = await reconcileDependencyBinWrappers({ agentDir, sessionTmp })
    const writable = subtractMasked(await resolveWritableZones(agentDir, getSandboxWritablePathSpecs(config)), {
      dirs,
      files,
    })
    const writableRoot = canWriteAgentRootInSandbox(permissions, origin)
    const baseProtectedZones =
      writableRoot || writable.dirs.includes(join(agentDir, '.git'))
        ? subtractMasked(await resolveProtectedZones(agentDir), { dirs, files })
        : { dirs: [], files: [] }
    const protectedZones = {
      dirs: baseProtectedZones.dirs,
      files: [...new Set([...baseProtectedZones.files, ...dependencyBins.protectedFiles])],
    }
    const writableDirSet = new Set(writable.dirs)
    const sandboxHome = DEFAULT_SANDBOX_ENV.HOME ?? '/tmp'
    const symlinks = resolveSandboxSymlinks(agentDir, config.sandbox.symlinks, sandboxHome).filter((op) =>
      writableDirSet.has(op.target),
    )
    const { strategy: proc, degradeReason } = await (boundary.resolveProcStrategy ?? resolveProcStrategy)()
    if (proc === 'tmpfs' && commandNeedsRealProc(command)) {
      throw degradeReason === 'unverified' ? new SandboxProcProbeUnverifiedError() : new SandboxDegradedProcError()
    }
    privilegedRuntime = await (boundary.resolveRuntime ?? resolvePrivilegedSandboxRuntime)({
      agentDir,
      command,
      env: sandboxEnvOverlay,
    })
    await verifyHiddenMaskTargets(maskTargets)
    const { commandString, spawnEnv } = boundary.buildCommand(command, {
      mounts: [
        { type: 'ro-bind', source: agentDir, dest: agentDir },
        { type: 'bind', source: sessionTmp, dest: '/tmp' },
        // `/tmp` is writable, but PATH entries must remain runtime-owned for
        // the lifetime of this command. Last-op-wins makes this narrow re-bind
        // read-only without adding any broader filesystem exposure.
        { type: 'ro-bind', source: dependencyBins.wrapperDir, dest: DEPENDENCY_BIN_SANDBOX_DIR },
        ...(privilegedRuntime?.mounts ?? []),
        ...(preparation === undefined ? [] : [preparation.mount]),
      ],
      ...(writableRoot
        ? { writableRoot: { dir: agentDir }, masks: maskTargets, protected: protectedZones }
        : { masks: maskTargets, writable, protected: protectedZones }),
      symlinks,
      network: 'inherit',
      cwd: agentDir,
      proc,
      procSelfExe: resolveProcSelfExe(),
      ...spreadSandboxEnv(
        buildSandboxEnvPolicy(sandboxEnvOverlay, privilegedRuntime?.env, envNames.exposable, envWithhold),
      ),
    })
    mutableArgs.command = commandString
    // The overlay carries command-scoped secret VALUES (e.g. a per-repo GH_TOKEN)
    // that live in neither process.env nor argv; resolveSpawnEnv snapshots
    // inherited names from process.env only, so merge the overlay values in here
    // to complete the exact bwrap-parent env.
    const mergedSpawnEnv =
      spawnEnv !== undefined && sandboxEnvOverlay !== undefined ? { ...spawnEnv, ...sandboxEnvOverlay } : spawnEnv
    const runtimeForResult = privilegedRuntime
    return {
      verify: async () => (boundary.verifyRuntime ?? verifyPrivilegedSandboxRuntime)(runtimeForResult),
      cleanup,
      spawnEnv: mergedSpawnEnv,
      dependencyBins,
      withheld: { paths: maskTargets, envNames: [...new Set([...envNames.withheld, ...effectiveEnvWithhold])] },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

function bashResultIsCommandNotFound(result: ToolResult): boolean {
  if (isRecord(result.details) && result.details.exitCode === 127) return true
  return (result.content as ContentPart[]).some(
    (part) => part.type === 'text' && /command not found(?:\s|$)/i.test(part.text),
  )
}

function bashResultHasNonzeroExit(result: ToolResult): boolean {
  // A numeric nonzero exit is the command's tool-agnostic failure signal. Do
  // not infer failure from arbitrary or localized output text.
  return isRecord(result.details) && typeof result.details.exitCode === 'number' && result.details.exitCode !== 0
}

function renderSandboxPolicyNote(withheld: PreparedBashSandbox['withheld'], agentDir: string): string {
  const maskedPaths = [...withheld.paths.dirs, ...withheld.paths.files].map(
    (target) => `agent/${relative(agentDir, target).split(sep).join('/')}`,
  )
  return (
    `[TypeClaw sandbox policy (LOCAL): masked credential/private paths: ${maskedPaths.join(', ') || 'none'}; ` +
    `withheld env names: ${withheld.envNames.join(', ') || 'none'}. This may be unrelated to this failure; ` +
    'it is NOT evidence about authentication of any account, workspace, or upstream service and must not be ' +
    'reported as such.]'
  )
}

function appendErrorText(error: unknown, text: string): Error {
  if (error instanceof Error) {
    error.message = `${error.message}\n\n${text}`
    return error
  }
  return new Error(`${String(error)}\n\n${text}`)
}

function appendTextResult(result: ToolResult, text: string): ToolResult {
  return { ...result, content: [...(result.content as ContentPart[]), { type: 'text', text }] }
}

export function buildSandboxEnvPolicy(
  overlay: BashEnvOverlay | undefined,
  runtimeEnv: Record<string, string> | undefined,
  exposableEnvNames: readonly string[] = [],
  withhold: readonly string[] = [],
): { inherit?: string[]; set?: Record<string, string>; withhold?: string[] } {
  const requestedWithhold = new Set(withhold)
  const overlayNames = new Set(Object.keys(overlay ?? {}))
  // The overlay is a deliberate command-scoped replacement, while withholding
  // only removes ambient values; an overlay therefore wins for the same name.
  const effectiveWithhold = [...requestedWithhold].filter((name) => !overlayNames.has(name))
  const effectiveWithholdSet = new Set(effectiveWithhold)
  const set = Object.fromEntries(Object.entries(runtimeEnv ?? {}).filter(([key]) => !requestedWithhold.has(key)))
  const inherit: string[] = []
  const inheritSeen = new Set<string>()
  const pushInherit = (key: string): void => {
    if (effectiveWithholdSet.has(key) || Object.hasOwn(set, key) || inheritSeen.has(key)) return
    inheritSeen.add(key)
    inherit.push(key)
  }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (Object.hasOwn(set, key)) continue
    if (isOverlaySecretName(key)) pushInherit(key)
    else set[key] = value
  }
  // Operator-declared .env vars pass through by NAME (inherit), keeping values
  // out of the rendered bwrap argv. Sandbox-integrity names were already dropped
  // in resolveExposableEnvNames — these are the survivors.
  for (const key of exposableEnvNames) pushInherit(key)
  // Pass the entrypoint-exported Xvfb display (start_xvfb: `export DISPLAY=:99`)
  // through --clearenv, else sandboxed `agent-browser --headed` dies with
  // "Missing X server or $DISPLAY". Passing the runtime's OWN value (not a fixed
  // ":99") keeps `docker.file.xvfb=false` advertising no display. Rendered via
  // `set` (a display number is neither a credential nor shell-injectable), and no
  // /tmp/.X11-unix bind is needed: Chrome reaches Xvfb over the netns-scoped
  // abstract X11 socket while bash keeps network:'inherit'.
  const display = process.env['DISPLAY']
  if (
    display !== undefined &&
    display !== '' &&
    !effectiveWithholdSet.has('DISPLAY') &&
    !Object.hasOwn(set, 'DISPLAY') &&
    !inheritSeen.has('DISPLAY')
  ) {
    set['DISPLAY'] = display
  }
  return {
    ...(inherit.length > 0 ? { inherit } : {}),
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(effectiveWithhold.length > 0 ? { withhold: effectiveWithhold } : {}),
  }
}

function spreadSandboxEnv(policy: ReturnType<typeof buildSandboxEnvPolicy>): {
  env?: ReturnType<typeof buildSandboxEnvPolicy>
} {
  return Object.keys(policy).length > 0 ? { env: policy } : {}
}

function resolveExposableBashEnvNames(agentDir: string): { exposable: string[]; withheld: string[] } {
  const declaredEnv = readEnvFile(agentDir)
  const exposable = resolveExposableEnvNames(declaredEnv, process.env)
  const exposableSet = new Set(exposable)
  const withheld = [...declaredEnv]
    .filter(([name, value]) => value.length > 0 && !exposableSet.has(name))
    .map(([name]) => name)
  return { exposable, withheld }
}

function buildRoleScopedConfigEnv(
  agentDir: string,
  hiddenDirs: string[],
  envOverlay: BashEnvOverlay | undefined,
): BashEnvOverlay | undefined {
  // Low-trust roles have workspace/ masked. Do not let container-global config
  // env vars point CLIs back at that private surface: apps that honor XDG should
  // still run, but their config must land in the sandbox's per-session /tmp.
  // Trusted/owner have only the unconditional credential-dir masks, not the
  // workspace root mask, so their command broker decides whether to set GWS.
  const workspaceHidden = hiddenDirs.includes(join(agentDir, 'workspace'))
  if (!workspaceHidden) return envOverlay

  return {
    ...envOverlay,
    XDG_CONFIG_HOME: '/tmp/.config',
    GWS_CONFIG_HOME: '/tmp/.config/gws',
  }
}

// Picks the /proc strategy for a sandboxed bash call. The branch order is:
// 'real-proc' ONLY when the operator explicitly opted in (sandbox.realProc) AND
// the kernel permits the mount (canMountRealProc) — it adds PID isolation but
// needs CAP_SYS_ADMIN (unshare --mount-proc), so it is a deliberate, narrow
// opt-in; else 'proc-bind' (--ro-bind /proc, NO CAP_SYS_ADMIN) when its userns
// leak-block is verified safe; else 'tmpfs'. Because sandbox.realProc DEFAULTS
// FALSE, the first branch is normally skipped and proc-bind is the de-facto
// default — which is the point: the common path needs no broad outer capability.
// 'tmpfs' is the last-resort degraded mode where external packages can't run;
// reached only when proc-bind is DEFINITIVELY unavailable (a real cross-userns
// environ leak → fail closed) or its safety stays unverifiable after retries.
//
// Read from the boot-time `config` snapshot, NOT live getConfig(): sandbox is
// restart-required, and the strategy MUST track the boot-time CAP_SYS_ADMIN
// grant. A `typeclaw reload` flipping realProc would otherwise emit `unshare
// --mount-proc` in a container booted WITHOUT the cap (or vice versa). Both
// probes are cached process-globally, so this resolves to one spawn per
// container lifetime regardless of how many bash calls hit it.
// A tmpfs degrade carries WHY it happened so the caller can pick a permanent vs
// retryable error. 'definitive': the probe returned a real cross-userns leak
// ('unsafe') — the ONLY verdict proven permanent, so it fails closed for good.
// 'unverified': the safety probe never reached a definitive verdict within its
// retry budget. That covers BOTH a transient load spike AND a durable
// incapability (no usable namespaces, a bwrap that starts but cannot set up its
// sandbox): the probe cannot prove a NEGATIVE capability — only a leak is
// definitive — so a genuinely incapable host also lands here and simply keeps
// re-degrading on each call. Since 'inconclusive' is never cached, that costs a
// re-probe but is correct: the only false case is "capable but briefly
// saturated", which recovers; an incapable host stays degraded either way.
// Absent when the strategy is not tmpfs.
type ProcStrategyResolution =
  | { strategy: 'real-proc' | 'proc-bind'; degradeReason?: undefined }
  | { strategy: 'tmpfs'; degradeReason: 'definitive' | 'unverified' }

async function resolveProcStrategy(): Promise<ProcStrategyResolution> {
  if (config.sandbox.realProc && (await canMountRealProc())) return { strategy: 'real-proc' }
  // Retry an 'inconclusive' proc-bind probe (transient under load) before
  // degrading — a single such hiccup must not break external-package runs on a
  // capable host. 'unsafe' still fails closed with no retry.
  const verdict = await resolveProcBindSafetyWithRetry(
    () => getProcBindSafetyVerdict(),
    (ms) => Bun.sleep(ms),
  )
  if (verdict === 'safe') return { strategy: 'proc-bind' }
  // Degraded last resort: no working /proc strategy. External package runners
  // (bunx/bun run <pkg-bin>) will fail with Bun's opaque "NotDir" because
  // /proc/self/{fd,maps} are absent. Only a proven 'unsafe' (a real cross-userns
  // leak) is DEFINITIVE — warn once (a real operator-facing limit). An
  // 'inconclusive' is reported as retryable upstream and NOT warned (it would cry
  // wolf every boot storm); a durably-incapable host re-degrades quietly here,
  // since the probe cannot distinguish it from transient load.
  if (verdict === 'unsafe') {
    warnTmpfsProcFallbackOnce()
    return { strategy: 'tmpfs', degradeReason: 'definitive' }
  }
  return { strategy: 'tmpfs', degradeReason: 'unverified' }
}

let tmpfsProcFallbackWarned = false
function warnTmpfsProcFallbackOnce(): void {
  if (tmpfsProcFallbackWarned) return
  tmpfsProcFallbackWarned = true
  console.warn(
    '[sandbox] degraded /proc mode: neither real-proc nor proc-bind is available on this host, ' +
      'so sandboxed external package runners (bunx / bun run <pkg-bin>) will fail. ' +
      'This needs a runtime with working user namespaces.',
  )
}

// The builtin file tools that take a single filesystem `path` arg. They run in
// the main process rather than bwrap, so each must apply the same
// /tmp -> session-dir mapping that
// applyBashSandbox binds for bash — otherwise a `read` of /tmp/foo hits the
// real container /tmp while sandboxed bash wrote the session backing dir.
const TMP_REDIRECT_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])

// Model-driven bash reads /tmp through bwrap's per-session bind
// (applyBashSandbox), but the path-based file tools run in the main process
// against the real container /tmp.
// Without this redirect a guest/member that touches /tmp/foo through bash (bound
// to the session dir) and through a file tool (real /tmp) would see two
// different files. Rewriting the file tool's on-disk path to the same session
// backing dir makes every layer resolve /tmp/foo to one file. Bare harnesses
// without the production permission wiring are left untouched.
type TmpRedirect = { original: string; backing: string }

async function applyTmpPathRedirect(
  mutableArgs: Record<string, unknown>,
  permissions: PermissionService,
  origin: SessionOrigin | undefined,
  agentDir: string,
  sessionId: string,
): Promise<TmpRedirect | undefined> {
  const rawPath = mutableArgs.path
  if (typeof rawPath !== 'string') return undefined

  const { dirs, files } = resolveHiddenPaths(permissions, origin, agentDir)
  if (dirs.length === 0 && files.length === 0) return undefined

  const backing = mapVirtualTmpPath(agentDir, sessionId, rawPath)
  if (backing === undefined || backing === rawPath) return undefined

  await ensureSessionTmpDir(sessionId)
  mutableArgs.path = backing
  return { original: rawPath, backing }
}

// The redirect swaps the model-facing /tmp path for its session backing dir
// before execution; the file tool then echoes that backing path in its receipt
// text and details. Reverse it on the way out so the model only ever sees the
// path it asked for — a leaked backing path is unreachable inside the bwrap
// bash sandbox, so reusing it in `gh api --input` fails (the PR #672 strand).
function restoreTmpPathInResult(result: ToolResult, redirect: TmpRedirect): ToolResult {
  const content = (result.content as ContentPart[]).map((part) =>
    part.type === 'text' ? { ...part, text: part.text.split(redirect.backing).join(redirect.original) } : part,
  )
  const details =
    isRecord(result.details) && result.details.path === redirect.backing
      ? { ...result.details, path: redirect.original }
      : result.details
  return { content, details }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeDefaultTreeRoot(toolName: string, args: Record<string, unknown>): void {
  if ((toolName === 'grep' || toolName === 'find' || toolName === 'ls') && typeof args.path !== 'string') {
    args.path = '.'
  }
}

function appendLoopWarning(result: ToolResult, message: string): ToolResult {
  const content: ContentPart[] = [...(result.content as ContentPart[]), { type: 'text', text: message }]
  return { content, details: result.details }
}

// `subagent_output` is a read-only poll whose loop/no-loop classification only
// becomes knowable AFTER execution: a result of `status: 'running'` is a
// still-pending wait (legitimate), while a repeated terminal result is a real
// loop. The loop guard's `check` is result-blind and pre-execution, so for this
// one tool we DEFER enforcing a block until the status is known — otherwise the
// exact poll that would reveal 'running' gets blocked before it can run (the
// boundary-call hazard for round-robin fan-out polling). Every other tool
// enforces its block immediately, as before.
// A block is deferred only for a `subagent_output` poll the guard still marks
// `deferable` — i.e. whose signature has not yet proven terminal. Once a poll of
// that signature returns completed/failed, `deferable` is false and the block is
// enforced pre-execute, so a finished task is not re-polled forever.
function shouldDeferLoopBlock(toolName: string, decision: LoopGuardDecision): boolean {
  return toolName === SUBAGENT_OUTPUT_TOOL_NAME && decision.kind === 'block' && decision.deferable
}

function subagentPollStatus(toolName: string, result: ToolResult): 'running' | 'terminal' | undefined {
  if (toolName !== SUBAGENT_OUTPUT_TOOL_NAME) return undefined
  const details = result.details as SubagentOutputToolDetails | undefined
  if (details?.ok !== true) return undefined
  return details.status === 'running' ? 'running' : 'terminal'
}

function observedReadResult(
  toolName: string,
  result: ToolResult,
): { nonEmpty: boolean; outputLines?: number; textual: boolean } | undefined {
  if (toolName !== 'read') return undefined
  const details = result.details as { truncation?: { outputLines?: unknown } } | undefined
  const outputLines = details?.truncation?.outputLines
  const hasImage = result.content.some((part) => part.type === 'image')
  const hasText = result.content.some(
    (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0,
  )
  const imageFallback =
    !hasImage &&
    result.content.some(
      (part) => part.type === 'text' && typeof part.text === 'string' && /^Read image file \[[^\]]+\]/.test(part.text),
    )
  const observedOutputLines =
    typeof outputLines === 'number' && Number.isFinite(outputLines)
      ? outputLines
      : !hasImage && !imageFallback
        ? countReadOutputLines(result.content)
        : undefined
  return {
    nonEmpty: hasImage || hasText,
    textual: !hasImage && !imageFallback,
    ...(observedOutputLines !== undefined ? { outputLines: observedOutputLines } : {}),
  }
}

function countReadOutputLines(content: ContentPart[]): number | undefined {
  const textParts = content.filter(
    (part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text' && typeof part.text === 'string',
  )
  if (textParts.length !== 1) return undefined
  const fileText = textParts[0]!.text.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, '')
  return fileText.length === 0 ? 0 : fileText.split('\n').length
}

type LoopGuardGate = {
  // True when the guard wants to block AND the block is enforced now (every tool
  // except a deferable `subagent_output` poll). The caller aborts + errors.
  blockNow: boolean
  message: string
  // Resolves the guard against the tool's result. Returns the result to surface
  // (possibly warn-annotated), or `{ deferredBlock: message }` when a deferred
  // `subagent_output` block must now be enforced because the poll did not return
  // a still-running status.
  resolve: (result: ToolResult) => { result: ToolResult } | { deferredBlock: string }
}

// Single chokepoint for the loop-guard pre-check + post-execute resolution so
// all four tool wrappers share identical deferred-block / pending-retract
// semantics. `check` runs here (recording the observation); the returned
// `resolve` is called after execute with the tool's result, feeding the poll's
// running/terminal status back to the guard so future blocks stop deferring.
function gateLoopGuard(
  sessionId: string,
  toolName: string,
  args: unknown,
  turnId?: number,
  cwd?: string,
): LoopGuardGate {
  const decision = sharedLoopGuard.check(sessionId, toolName, args, { turnId, cwd })
  const defer = shouldDeferLoopBlock(toolName, decision)
  return {
    blockNow: decision.kind === 'block' && !defer,
    message: decision.kind === 'ok' ? '' : decision.message,
    resolve(result) {
      const readResult = observedReadResult(toolName, result)
      if (readResult !== undefined) sharedLoopGuard.noteReadResult(decision.receipt, readResult)
      const pollStatus = subagentPollStatus(toolName, result)
      if (pollStatus !== undefined) {
        sharedLoopGuard.noteResult(decision.receipt, pollStatus)
      }
      if (pollStatus === 'running') {
        sharedLoopGuard.retract(decision.receipt)
        return { result }
      }
      if (defer && decision.kind === 'block') {
        return { deferredBlock: decision.message }
      }
      if (decision.kind === 'warn') {
        return { result: appendLoopWarning(result, decision.message) }
      }
      return { result }
    },
  }
}

// Clears one tool's loop-guard residue for a session on the process-wide shared
// guard. The completion-reminder bridges (channel router + TUI server) call this
// for `subagent_output` when a backgrounded subagent finishes, so the next fetch
// the reminder asks for isn't blocked by the window the agent's premature polling
// poisoned. Exposed as a narrow function rather than the guard itself so callers
// can't reach `check`/`forget` and widen the blast radius.
export function forgetSharedLoopGuardTool(sessionId: string, tool: string): void {
  sharedLoopGuard.forgetTool(sessionId, tool)
}

// Test-only seam: swaps the shared loop guard for a fresh instance so tests
// that reuse sessionIds across cases don't see cross-test streak counts.
// Production code never calls this; the guard's LRU bound handles
// long-running processes.
export function __resetSharedLoopGuardForTests(): void {
  sharedLoopGuard = createLoopGuard()
}

// A loop-guard `block` verdict returned/thrown from a tool's execute() is
// caught by pi-agent-core and surfaced to the model as an `isError` result,
// which the model simply retries — the loop never ends. Aborting the run's
// AbortSignal is the only thing that actually stops the in-flight turn (the
// next assistant stream sees the aborted signal and ends with stopReason
// 'aborted'). We use the signal-only `agent.abort`, never `session.abort`,
// which would deadlock awaiting the very run this tool call belongs to. See
// the matching pattern in src/channels/router.ts (policy-denied send cap).
//
// A signal-only abort leaves no trace in the transcript itself (the turn just
// ends with stopReason 'aborted' and no follow-up call), so this is the only
// place an operator can learn WHY from `typeclaw logs` — log before invoking
// the abort, not after, so a getAbort() that turns out to be undefined never
// reports an abort that didn't actually happen.
function fireLoopAbort(
  getAbort: (() => ((reason?: string) => void) | undefined) | undefined,
  reason: string,
  sessionId: string,
): void {
  const abort = getAbort?.()
  if (abort === undefined) return
  console.warn(`[agent] abort site=loop_guard session=${sessionId} reason=${reason}`)
  abort(reason)
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { error: true, message },
    isError: true,
  }
}

async function checkGitControlWriteGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<{ block: true; reason: string } | undefined> {
  if (options.tool !== 'write' && options.tool !== 'edit') return undefined
  const candidate = options.args.path
  if (typeof candidate !== 'string') return undefined
  if (!(await isGitControlPath(options.agentDir, candidate))) return undefined
  return {
    block: true,
    reason: `Git control path is runtime-protected and cannot be modified with ${options.tool}: ${candidate}`,
  }
}

function withGuardAcknowledgements<TParams extends TSchema>(
  toolName: string,
  parameters: TParams,
  guards: readonly InternalGuard[],
): TParams {
  const matching = guards.filter((guard) => guard.tools.has(toolName))
  if (matching.length === 0) return parameters

  const schema = parameters as Record<string, unknown>
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return parameters
  if (ACKNOWLEDGE_GUARDS in properties) {
    throw new Error(`tool "${toolName}" declares reserved parameter "${ACKNOWLEDGE_GUARDS}"`)
  }

  const acknowledgementProperties: Record<string, TSchema> = {}
  for (const guard of matching) {
    const plugin = acknowledgementProperties[guard.owner] as { properties?: Record<string, TSchema> } | undefined
    acknowledgementProperties[guard.owner] = Type.Optional(
      Type.Object(
        { ...plugin?.properties, [guard.key]: Type.Optional(Type.Boolean()) },
        { additionalProperties: false },
      ),
    )
  }

  return {
    ...schema,
    properties: {
      ...(properties as Record<string, unknown>),
      [ACKNOWLEDGE_GUARDS]: Type.Optional(Type.Object(acknowledgementProperties, { additionalProperties: false })),
    },
  } as unknown as TParams
}

function extractGuardAcknowledgements(
  params: unknown,
  toolName: string,
  guards: readonly InternalGuard[],
):
  | {
      ok: true
      pluginArgs: unknown
      acknowledgements?: Record<string, Record<string, boolean>>
    }
  | { ok: false; error: string } {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: true, pluginArgs: params }
  }

  const pluginArgs = params as Record<string, unknown>
  if (!Object.hasOwn(pluginArgs, ACKNOWLEDGE_GUARDS)) return { ok: true, pluginArgs }

  const rawAcknowledgements = pluginArgs[ACKNOWLEDGE_GUARDS]
  delete pluginArgs[ACKNOWLEDGE_GUARDS]
  if (rawAcknowledgements === null || typeof rawAcknowledgements !== 'object' || Array.isArray(rawAcknowledgements)) {
    return { ok: false, error: `${ACKNOWLEDGE_GUARDS} must be an object` }
  }

  const acknowledgements: Record<string, Record<string, boolean>> = {}
  for (const [pluginName, rawPluginAcknowledgements] of Object.entries(
    rawAcknowledgements as Record<string, unknown>,
  )) {
    if (
      rawPluginAcknowledgements === null ||
      typeof rawPluginAcknowledgements !== 'object' ||
      Array.isArray(rawPluginAcknowledgements)
    ) {
      return { ok: false, error: `${ACKNOWLEDGE_GUARDS}.${pluginName} must be an object` }
    }
    const pluginAcknowledgements: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(rawPluginAcknowledgements as Record<string, unknown>)) {
      const allowed = guards.some(
        (guard) => guard.owner === pluginName && guard.key === key && guard.tools.has(toolName),
      )
      if (!allowed) {
        return {
          ok: false,
          error: `${ACKNOWLEDGE_GUARDS}.${pluginName}.${key} is not allowed for tool "${toolName}"`,
        }
      }
      if (typeof value !== 'boolean') {
        return { ok: false, error: `${ACKNOWLEDGE_GUARDS}.${pluginName}.${key} must be a boolean` }
      }
      pluginAcknowledgements[key] = value
    }
    acknowledgements[pluginName] = pluginAcknowledgements
  }

  return { ok: true, pluginArgs, acknowledgements }
}
