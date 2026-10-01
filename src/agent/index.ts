import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool as definePiTool,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { ReactionRef } from '@/channels/types'
import {
  getConfig,
  resolveModel,
  resolveProfile,
  type Models,
  type ResolvedProfile,
  type ThinkingLevel,
} from '@/config'
import { defaultThinkingLevelForRef, isOpenAiFamilyRef, providerForModelRef, type ModelRef } from '@/config/providers'
import { renderMcpCatalog } from '@/mcp/catalog'
import type { McpManager } from '@/mcp/manager'
import { createMcpDispatcherTools, MCP_DISPATCHER_TOOL_NAMES, resolveMcpCallPreflightFileOperands } from '@/mcp/tools'
import { noopPermissionService, type PermissionService, type RolesConfig } from '@/permissions'
import type {
  BuiltinToolRef,
  HookBus,
  MaterializedSkills,
  PluginRegistry,
  RegisteredTool as PluginRegisteredTool,
  Tool as PluginTool,
} from '@/plugin'
import { createHookBus, materializeSkills } from '@/plugin'
import { CORE_SYSTEM_TOOL_NAMES } from '@/plugin/core-tool-names'
import type { ReloadRegistry } from '@/reload'
import { enterSubagentTmpScope, resolveHiddenPaths } from '@/sandbox'
import type { Stream } from '@/stream'

import { getAuthFor } from './auth'
import { createCompactionSettingsManager } from './compaction'
import { renderGitNudge } from './git-nudge'
import type { InternalGuard } from './guard-types'
import { buildInternalGuards } from './guards'
import type { LiveSubagentRegistry } from './live-subagents'
import { sanitizeMessagesForLlmReplay } from './llm-replay-sanitizer'
import { applyModelRuntimeOverrides } from './model-overrides'
import { createChannelLookAtTool, createLookAtTool } from './multimodal'
import {
  buildBuiltinPiToolOverrides,
  isPiCodingBuiltinName,
  resolveBuiltinToolRefs,
  wrapPluginTool,
  wrapSystemTool,
  zodToToolParameters,
} from './plugin-tools'
import { PROACTIVE_NEXT_STEP_NUDGE } from './proactive-next-step-nudge'
import { wrapTransformContextWithLocalFailureMarker } from './provider-error'
import { createReloadTool } from './reload-tool'
import type { RestartHandoffOrigin } from './restart-handoff'
import type { SubagentBashPolicy } from './reviewer-bash-policy'
import { loadSelf } from './self'
import { SESSION_META_CUSTOM_TYPE, sessionMetaPayload } from './session-meta'
import { renderSessionOrigin, type SessionOrigin, type SessionRoleContext } from './session-origin'
import type { CreateSessionForSubagent, SubagentCoalescer, SubagentRegistry } from './subagents'
import {
  buildDefaultSystemPrompt,
  buildSlimSystemPrompt,
  DEFAULT_SUBAGENT_ROSTER,
  renderRuntimeBlock,
  renderRuntimeNondisclosureRule,
  stripRuntimeIdentityProse,
} from './system-prompt'
import { attachToolNotFoundNudge } from './tool-not-found-nudge'
import { createBudgetState, type ToolResultBudget, wrapToolDefinitionWithBudget } from './tool-result-budget'
import { createChannelDisengageTool } from './tools/channel-disengage'
import { createChannelEditTool } from './tools/channel-edit'
import { createChannelFetchAttachmentTool, resolveInboxBaseDir } from './tools/channel-fetch-attachment'
import { createChannelHistoryTool } from './tools/channel-history'
import { createChannelReactTool } from './tools/channel-react'
import { createChannelReadTool } from './tools/channel-read'
import { createChannelReplyTool } from './tools/channel-reply'
import { createChannelSendTool } from './tools/channel-send'
import { createGrantRoleTool } from './tools/grant-role'
import { createPostGithubReviewTool } from './tools/post-github-review'
import { createRestartTool } from './tools/restart'
import { createSkipResponseTool } from './tools/skip-response'
import { createSpawnSubagentTool, renderPublicSubagentRoster } from './tools/spawn-subagent'
import { createStreamSnapshotTool } from './tools/stream-snapshot'
import { createSubagentCancelTool } from './tools/subagent-cancel'
import { createSubagentOutputTool } from './tools/subagent-output'
import { createTodoTools } from './tools/todo'
import { webFetchTool } from './tools/webfetch'
import { webSearchTool } from './tools/websearch'

export type { SessionOrigin } from './session-origin'

export type { AgentSession }

export { renderTurnRoleAnchor, renderTurnTimeAnchor } from './system-prompt'

type AgentSessionTools = NonNullable<Parameters<typeof createAgentSession>[0]>['tools']

// Pi AI 0.73.1 capped an unset output budget at 32K
// (pi-ai dist/providers/simple-options.js:4). Pi 0.87.1 instead defaults to
// the full model maximum before context clamping (dist/api/simple-options.js:17),
// so preserve the former safe default at the session boundary. Explicit budgets
// remain untouched for compaction and channel-specific output caps.
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000

export type PluginSessionWiring = {
  registry: PluginRegistry
  hooks: HookBus
  sessionId: string
  agentDir: string
}

export type PluginSubagentSelection = {
  pluginName: string
  toolRefs?: BuiltinToolRef[]
  customTools?: PluginTool<any>[]
  toolNamePrefix: string
}

// Mutable holder for the live session origin. Pass this when the origin
// must be updated turn-by-turn after session creation (channel sessions
// whose `lastInboundAuthorId` changes with each inbound message). Tool
// wrappers read `.current` at execute time, not at wrap time, so the
// `tool.before` event carries the per-turn actor identity rather than the
// stale session-creation snapshot. Sessions that never mutate origin
// (TUI, cron, subagent) can omit it and pass `origin` instead.
export type SessionOriginRef = { current: SessionOrigin | undefined }

export type CreateSessionOptions = {
  reloadRegistry?: ReloadRegistry
  sessionManager?: SessionManager
  stream?: Stream
  channelRouter?: ChannelRouter
  mcpManager?: McpManager
  // Bypass the file-based resource loader (IDENTITY.md, SOUL.md, MEMORY.md,
  // memory/, bundled skills) and use this string verbatim as the system prompt.
  systemPromptOverride?: string
  // Identifies the kind of session and (for channels) its addressing fields.
  // Rendered into the system prompt so the agent knows who's listening, where
  // its output goes, and what to pass to channel_send.
  origin?: SessionOrigin
  // Live origin holder. When provided, the tool wrappers read this at execute
  // time so `tool.before` events see the current-turn origin. Caller is
  // responsible for keeping `.current` up to date. If both `origin` and
  // `originRef` are passed, the ref wins for tool stamping; the static
  // `origin` still drives the initial system-prompt rendering and channel
  // tool addressing (those are only valid at session-creation time).
  originRef?: SessionOriginRef
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
  plugins?: PluginSessionWiring
  // When set, only the named plugin subagent's own tools are exposed; the
  // wider plugin registry's tools are NOT injected. Used by plugin subagent
  // session creation so subagents see exactly what they declared.
  pluginSubagent?: PluginSubagentSelection
  // Per-subagent bash capability restriction. Threaded to the bash-tool wrapper
  // and enforced before the role-derived sandbox, so a read-only subagent's
  // bash stays read-only regardless of the spawning role. See
  // `src/agent/reviewer-bash-policy.ts`.
  bashPolicy?: SubagentBashPolicy
  // Enables the `restart` tool. Set when the agent is running inside a
  // typeclaw-managed container. Read from TYPECLAW_CONTAINER_NAME at the call site.
  containerName?: string
  // The typeclaw runtime version (`package.json#version` of the executing
  // CLI) to surface in the system prompt under `## Runtime`. Threaded from
  // `startAgent` via `CLI_VERSION` so every session — TUI, channel, cron,
  // plugin subagent — sees the same value. Omitted in stand-alone test
  // callers, in which case the runtime block is skipped (no token cost, no
  // misleading "unknown" value).
  runtimeVersion?: string
  // The permission service the runtime resolved at boot. When provided, the
  // resolved role and permission list for `options.origin` are rendered into
  // the system prompt under `## Your role in this session`. The block is
  // emitted for channel/cron/subagent sessions, and for TUI sessions only
  // when the resolved role is not the built-in `owner` (because TUI
  // resolving to `owner` is the common case and we save tokens on every
  // interactive session). Omitting `permissions` falls back to the previous
  // behavior (no role annotation), which is what tests and stand-alone
  // callers want.
  //
  // The role rendered here is a session-creation snapshot. Channel sessions
  // re-resolve per-turn through `originRef` for tool gating, but the system
  // prompt is not regenerated; see `typeclaw-permissions` skill for how the
  // agent should interpret the snapshot on later turns.
  permissions?: PermissionService
  // Re-reads roles from disk for the grant_role tool's hot-reload after a match
  // grant. Production threads a reload-then-read (reloadConfig + getConfig);
  // must not be an in-memory snapshot or the grant reapplies stale roles.
  // Omitted when no grant_role tool is wired (the tool requires permissions).
  reloadRoles?: () => RolesConfig | undefined
  // Model profile name. Resolved against `config.models` to pick the concrete
  // model ref this session binds to. Unknown profile names fall back to
  // `default` with a one-time console warning. Omitted → `default`. Threaded
  // through from the caller (subagent declarations, future per-spawn tool
  // overrides) so different sessions on the same agent can run different
  // models without per-session config edits.
  profile?: string
  // Override the resolved ref directly, bypassing `profile` resolution. Used
  // by the model-fallback helper (`promptWithFallback`) to recreate a session
  // pinned to the next ref in the chain after the previous one failed. When
  // set, `profile` is still recorded for the fallback-warning bookkeeping;
  // the profile→refs resolution is skipped.
  refOverride?: ModelRef
  // Defensive ceiling on cumulative bytes of tool-result text per session,
  // applied to the named tools only. See `src/agent/tool-result-budget.ts`
  // for the rationale. Intended for subagents that read large files
  // (memory-logger, dreaming); leaving this undefined disables the budget
  // entirely, which is the right default for TUI / channel / plugin-tool
  // sessions where the human (or hooks) bound tool-result size.
  toolResultBudget?: ToolResultBudget
  // Optional override for the message returned to the agent once
  // `toolResultBudget` is exhausted. Subagents whose recovery path differs
  // from the default ("advance the watermark from a recent id you have
  // already seen") provide their own here. See `ToolResultBudget` for the
  // shared shape.
  toolResultBudgetMessage?: ToolResultBudget['exhaustedMessage']
  // Orchestration wiring. When all three of `liveSubagentRegistry`,
  // `subagentRegistry`, and `createSessionForSubagent` are present (AND
  // `pluginSubagent` is unset), the session exposes the spawn_subagent,
  // subagent_output, and subagent_cancel tools. Subagent-origin sessions
  // get an empty tool set via the `pluginSubagent` branch; the gate here
  // (omitting these for subagent sessions) is what prevents recursive
  // spawning.
  liveSubagentRegistry?: LiveSubagentRegistry
  subagentCoalescer?: SubagentCoalescer
  subagentRegistry?: SubagentRegistry
  createSessionForSubagent?: CreateSessionForSubagent
  allowBackgroundFromSubagent?: boolean
}

export type CreateSessionResult = {
  session: AgentSession & { getAbortReason?: () => string | undefined }
  dispose: () => Promise<void>
  getAbortReason?: () => string | undefined
}

// A session's reasoning effort layers like the model does: the resolved
// profile's own `thinkingLevel` → the `default` profile's `thinkingLevel` (the
// de-facto global default) → the per-provider/SDK default for the active ref.
// When the requested profile was unknown, `resolved` is already the `default`
// profile, so those terms coincide and the expression still does the right thing.
//
// Built-in per-profile defaults (e.g. `fast: 'low'`, `deep: 'high'`) are
// materialized onto the entry at config-parse time (see PROFILE_THINKING_LEVEL_DEFAULTS
// in config.ts), so they arrive here as `resolved.thinkingLevel` — the first term.
// That is why `deep`'s `high` still beats a lowered global default, and why there
// is no profile special-casing in this function.
export function resolveSessionThinkingLevel(
  models: Models,
  resolved: Pick<ResolvedProfile, 'thinkingLevel' | 'profile'>,
  activeRef: ModelRef,
): ThinkingLevel | undefined {
  return resolved.thinkingLevel ?? models.default.thinkingLevel ?? defaultThinkingLevelForRef(activeRef)
}

export async function createSession(options: CreateSessionOptions = {}): Promise<AgentSession> {
  const { session } = await createSessionWithDispose(options)
  return session
}

export function attachLoopGuardTurnTracking(
  agent: { subscribe: (listener: (event: unknown) => void) => () => void },
  onTurnStart: () => void,
): () => void {
  return agent.subscribe((event: unknown) => {
    if ((event as { type?: string }).type === 'turn_start') onTurnStart()
  })
}

export async function createSessionWithDispose(options: CreateSessionOptions = {}): Promise<CreateSessionResult> {
  const resolved = resolveProfile(getConfig().models, options.profile)
  // Unknown profiles silently fall back to `default`. The fallback is by design
  // (see `resolveProfile`) and surfacing a warning here just creates noise on
  // every memory-logger / dreaming subagent spawn for advanced users who know
  // exactly what they're doing.
  // `refOverride` lets the model-fallback helper pin a specific entry from
  // the chain when it recreates a session after the previous ref failed.
  const activeRef: ModelRef = options.refOverride ?? resolved.ref
  // Provider auth owns both credentials and model resolution in Pi 0.87.
  // Passing its ModelRuntime keeps every session request and compaction on the
  // same configured provider runtime (sdk.d.ts:15-16; CHANGELOG 0.80.0).
  const { modelRuntime } = await getAuthFor(providerForModelRef(activeRef))
  const sessionManager = options.sessionManager ?? SessionManager.inMemory()

  const materializedSkills =
    options.plugins && options.plugins.registry.skills.length > 0
      ? await materializeSkills(
          options.plugins.registry.skills.map((s) => ({
            pluginName: s.pluginName,
            localName: s.localName,
            skill: s.skill,
          })),
        )
      : null

  const resourceLoader =
    options.systemPromptOverride !== undefined
      ? await createOverrideResourceLoader(
          options.systemPromptOverride,
          options.origin,
          options.permissions,
          options.runtimeVersion,
        )
      : await createResourceLoader({
          ...(options.plugins ? { plugins: options.plugins, materializedSkills } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.permissions ? { permissions: options.permissions } : {}),
          ...(options.runtimeVersion !== undefined ? { runtimeVersion: options.runtimeVersion } : {}),
          ...(options.mcpManager !== undefined ? { mcpManager: options.mcpManager } : {}),
          ...(options.subagentRegistry !== undefined ? { subagentRegistry: options.subagentRegistry } : {}),
          ...(isOpenAiFamilyRef(activeRef) ? { proactiveNextStepNudge: true } : {}),
        })

  const getOrigin: () => SessionOrigin | undefined =
    options.originRef !== undefined ? () => options.originRef!.current : () => options.origin

  // Holds the session's signal-only abort once `createAgentSession` resolves.
  // Tools are wrapped BEFORE the session exists, so the loop guard reaches the
  // abort through this lazily-resolved getter. See `fireLoopAbort` in
  // plugin-tools.ts for why aborting (not throwing) is what stops the loop.
  const abortHolder: { abort?: (reason?: string) => void; reason?: string } = {}
  const getAbort: () => ((reason?: string) => void) | undefined = () => abortHolder.abort
  let loopGuardTurnId = 0
  const getLoopGuardTurn = () => loopGuardTurnId
  const guards = buildInternalGuards(options.plugins?.agentDir ?? process.cwd())

  // Subagent built-in tool refs resolve to `ToolDefinition`s (see
  // plugin-tools.ts). Their NAMES narrow the session via `tools:`; their wrapped
  // implementations arrive through `customTools` (either `builtinPiToolOverrides`
  // for pi coding builtins, or `customSystemTools` for typeclaw web tools).
  const resolvedSubagentBuiltins = options.pluginSubagent?.toolRefs
    ? resolveBuiltinToolRefs(options.pluginSubagent.toolRefs, options.plugins?.agentDir ?? process.cwd())
    : []
  const subagentBuiltinNames = resolvedSubagentBuiltins.map((t) => t.name)
  const subagentTypeclawToolDefinitions = resolvedSubagentBuiltins.filter((t) => !isPiCodingBuiltinName(t.name))
  const pluginCustomTools = options.pluginSubagent
    ? wrapSubagentCustomTools(
        options.pluginSubagent,
        options.plugins,
        getOrigin,
        getAbort,
        getLoopGuardTurn,
        options.permissions,
      )
    : wrapRegistryTools(options.plugins, getOrigin, getAbort, getLoopGuardTurn, options.permissions)

  // Per-run budget state for the tool-result byte ceiling. Allocated once per
  // session creation and threaded into every wrapped tool so they share the
  // same counter. Only used when the session declares a budget; the wrappers
  // pass non-listed tools through unchanged, so the counter stays at zero for
  // sessions without a budget configured.
  const sessionBudget: ToolResultBudget | undefined = options.toolResultBudget
    ? options.toolResultBudgetMessage !== undefined
      ? { ...options.toolResultBudget, exhaustedMessage: options.toolResultBudgetMessage }
      : options.toolResultBudget
    : undefined
  const sessionBudgetState = sessionBudget ? createBudgetState() : undefined

  // The session's tool-name allowlist is authoritative: with an explicit list,
  // pi activates only listed builtins and custom tools (sdk.d.ts:35-47).
  // A subagent narrows to its declared refs; a non-subagent caller passes its
  // own explicit list (e.g. look-at's `[]`); everyone else leaves it undefined
  // so pi's default builtins apply. Implementations arrive via `customTools`;
  // budget-wrapping happens there, not here.
  const tools: AgentSessionTools = options.tools ?? (options.pluginSubagent ? subagentBuiltinNames : undefined)

  // Hoisted above tool construction so the restart tool can be wired with the
  // session's stable identity (sessionManager.getSessionId()). Subscribers use
  // that ID to distinguish the originating session from siblings on the
  // container-restarting broadcast.
  // Stamp a one-shot custom entry naming the session's origin kind so
  // `typeclaw usage` can bucket tokens by tui/cron/channel/subagent. Pi's
  // `appendCustomEntry` is the blessed extension point: the entry persists
  // into the session JSONL alongside messages, does NOT participate in LLM
  // context, and pi handles file-creation timing — the entry lands after the
  // session header on first flush, so `SessionManager.open()` keeps reading
  // a canonical session file. Skipped for reopened sessions (a prior stamp
  // is already in `getEntries()`) so usage attribution stays stable across
  // restarts. Also skipped when origin is unknown (inMemory subagents) or
  // when the manager is not persisted.
  if (options.origin !== undefined && sessionManager.getSessionFile() !== undefined) {
    const alreadyStamped = sessionManager
      .getEntries()
      .some((e) => e.type === 'custom' && e.customType === SESSION_META_CUSTOM_TYPE)
    if (!alreadyStamped) {
      sessionManager.appendCustomEntry(SESSION_META_CUSTOM_TYPE, sessionMetaPayload(options.origin))
    }
  }

  // Plugin subagents (operator/reviewer) see ONLY their declared builtins plus
  // the orchestration tools — never the full main-session tool surface. The
  // orchestration tools self-omit unless `liveSubagentRegistry`/
  // `subagentRegistry`/`createSessionForSubagent` are wired (see
  // buildSubagentOrchestrationTools); `spawn_subagent` enforces MAX_SUBAGENT_DEPTH
  // at execute time so a depth-capped subagent's spawn fails closed even though
  // the tool is present.
  const customSystemTools =
    options.customTools !== undefined
      ? options.customTools
      : options.pluginSubagent
        ? [
            ...subagentTypeclawToolDefinitions,
            ...buildSubagentOrchestrationTools({
              liveRegistry: options.liveSubagentRegistry,
              registry: options.subagentRegistry,
              createSessionForSubagent: options.createSessionForSubagent,
              agentDir: options.plugins?.agentDir,
              parentSessionId: sessionManager.getSessionId(),
              getOrigin,
              permissions: options.permissions,
              stream: options.stream,
              allowBackgroundFromSubagent: options.allowBackgroundFromSubagent,
              coalescer: options.subagentCoalescer,
              channelRouter: options.channelRouter,
            }),
          ]
        : [
            ...buildCoreSystemTools(options.permissions),
            ...(options.mcpManager
              ? buildMcpDispatcherToolDefinitions(options.mcpManager, {
                  permissions: options.permissions,
                  getOrigin,
                  agentDir: options.plugins?.agentDir ?? process.cwd(),
                })
              : []),
            ...(options.reloadRegistry ? [createReloadTool({ registry: options.reloadRegistry })] : []),
            ...(options.stream ? [createStreamSnapshotTool({ stream: options.stream })] : []),
            ...buildChannelTools(
              options.channelRouter,
              options.origin,
              sessionManager.getSessionId(),
              getOrigin,
              options.permissions,
              options.plugins?.agentDir,
            ),
            ...(options.containerName
              ? [
                  createRestartTool({
                    containerName: options.containerName,
                    originatingSessionId: sessionManager.getSessionId(),
                    ...(options.stream ? { stream: options.stream } : {}),
                    ...buildRestartHandoffWiring(options, sessionManager),
                    triggeringAuthorIdProvider: () => currentChannelAuthor(getOrigin),
                  }),
                ]
              : []),
            ...buildSubagentOrchestrationTools({
              liveRegistry: options.liveSubagentRegistry,
              registry: options.subagentRegistry,
              createSessionForSubagent: options.createSessionForSubagent,
              agentDir: options.plugins?.agentDir,
              parentSessionId: sessionManager.getSessionId(),
              getOrigin,
              permissions: options.permissions,
              stream: options.stream,
              coalescer: options.subagentCoalescer,
              channelRouter: options.channelRouter,
            }),
            ...buildRoleGrantTools({
              agentDir: options.plugins?.agentDir,
              getOrigin,
              permissions: options.permissions,
              reloadRoles: options.reloadRoles,
            }),
            ...buildTodoTools(options.plugins?.agentDir, getOrigin),
          ]
  // TypeClaw owns every pi builtin (read/bash/edit/write/grep/find/ls): each is
  // wrapped with the hook + guard + sandbox + bash-policy pipeline and shipped
  // via `customTools`, and the call site sets `noTools: "builtin"` so pi's own
  // unwrapped copies are never the active implementation. Built unconditionally
  // — the sandbox and bash policy are security behavior independent of whether
  // any plugin registered a tool hook, so gating on hooks would leave an
  // unwrapped bash path. `wrapBuiltinToolDefinition` no-ops the optional
  // stages (plugin hooks, permissions, bashPolicy) when they are absent.
  const builtinPiToolOverrides = buildBuiltinPiToolOverrides({
    agentDir: options.plugins?.agentDir ?? process.cwd(),
    sessionId: options.plugins?.sessionId ?? sessionManager.getSessionId(),
    hooks: options.plugins?.hooks ?? createHookBus(),
    guards,
    getOrigin,
    getAbort,
    getLoopGuardTurn,
    permissions: options.permissions ?? noopPermissionService,
    ...(options.bashPolicy !== undefined ? { bashPolicy: options.bashPolicy } : {}),
  })
  const wrappedCustomSystemTools = wrapSystemTools(customSystemTools, {
    agentDir: options.plugins?.agentDir ?? process.cwd(),
    sessionId: options.plugins?.sessionId ?? sessionManager.getSessionId(),
    hooks: options.plugins?.hooks ?? createHookBus(),
    guards,
    getOrigin,
    getAbort,
    getLoopGuardTurn,
    ...(options.mcpManager === undefined ? {} : { mcpManager: options.mcpManager }),
  })
  const customToolsPreBudget = [...wrappedCustomSystemTools, ...pluginCustomTools, ...builtinPiToolOverrides]
  const customTools =
    sessionBudget && sessionBudgetState
      ? customToolsPreBudget.map((t) => wrapToolDefinitionWithBudget(t, sessionBudget, sessionBudgetState))
      : customToolsPreBudget

  // The exact set of tool names the session exposes to the model, and the single
  // source of truth passed to `createAgentSession({ tools })`. Because we set
  // `noTools: "builtin"`, pi's default active set is empty — this list IS the
  // active set. `builtinPiToolOverrides` names supply read/bash/edit/write/grep/
  // find/ls; `wrappedCustomSystemTools` + `pluginCustomTools` add the typeclaw/
  // plugin surface. A subagent's `tools` (subagentBuiltinNames) narrows the
  // builtin slice to exactly its declared refs. Also feeds the tool-not-found
  // nudge vocabulary so the two never drift.
  const builtinActiveNames = tools ?? builtinPiToolOverrides.map((t) => t.name)
  const intendedActiveToolNames = [
    ...new Set([...builtinActiveNames, ...[...wrappedCustomSystemTools, ...pluginCustomTools].map((t) => t.name)]),
  ]

  const model = applyModelRuntimeOverrides(resolveModel(activeRef), activeRef)
  // Read live so a reloaded `models` lands on the next session without a
  // container restart.
  const thinkingLevel = resolveSessionThinkingLevel(getConfig().models, resolved, activeRef)
  const { session } = await createAgentSession({
    model,
    modelRuntime,
    sessionManager,
    settingsManager: createCompactionSettingsManager(model),
    resourceLoader,
    noTools: 'builtin',
    tools: intendedActiveToolNames,
    customTools,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  })

  // Wrapping also means `agent.streamFunction !== streamSimple`, which puts pi's
  // summarization auth on its lenient branch (agent-session.js:214-232): a
  // failed compaction auth surfaces from the request rather than as pi's
  // "Authentication failed … /login" message. Channel sessions already wrap
  // this function, so every origin now behaves the same way.
  const innerStreamFunction = session.agent.streamFunction
  session.agent.streamFunction = async (requestModel, context, streamOptions) => {
    const maxTokens =
      streamOptions?.maxTokens ??
      (requestModel.maxTokens > 0 ? Math.min(requestModel.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS) : undefined)
    return await innerStreamFunction(requestModel, context, { ...streamOptions, maxTokens })
  }

  // typeclaw owns retry/fallback in its turn drivers, so the SDK's own
  // same-model auto-retry must be OFF. Leaving it on races typeclaw's
  // soft-error capture: the SDK can silently recover a `stopReason:'error'` turn
  // while typeclaw has already latched the failure, reporting a recovered turn as
  // failed (and burning an unnecessary failover). Disabling it makes a soft error
  // a deterministic, typeclaw-owned signal. Compaction/context-overflow recovery
  // is independent (gated on compaction settings), so this does not disable those;
  // marked local failures are kept out of overflow recovery at the marker below.
  session.setAutoRetryEnabled(false)
  const getAbortReason = () => abortHolder.reason
  const sessionWithAbortReason = Object.assign(session, { getAbortReason })
  const unsubLoopGuardTurn = attachLoopGuardTurnTracking(session.agent, () => {
    loopGuardTurnId += 1
  })

  // Layer the replay sanitizer over pi's convertToLlm so a transcript with an
  // orphaned toolResult (e.g. a torn-down restart turn) can't wedge the session
  // with an Anthropic 400 on every replay. Runs on every provider call path
  // that goes through the agent. Honors pi's contract that convertToLlm must
  // not throw: on any failure it falls back to the unsanitized output.
  const innerConvertToLlm = session.agent.convertToLlm
  session.agent.convertToLlm = async (messages) => {
    const converted = await innerConvertToLlm(messages)
    try {
      return sanitizeMessagesForLlmReplay(converted).messages
    } catch {
      return converted
    }
  }

  // pi turns a throw from context preparation into the same `stopReason:'error'`
  // message a provider failure produces, with only the error text kept, so the
  // origin has to be stamped where it is thrown. Installed last so it is the
  // outermost layer over pi's extension `context` pass (which clones the
  // messages) and its forced-prompt projection. getApiKey and streamFunction
  // stay unwrapped: their failures can be genuine provider/auth failures.
  // Overflow recovery stays enabled; a local failure whose text would read as a
  // provider overflow is stamped with fixed text and its raw text is logged here.
  session.agent.transformContext = wrapTransformContextWithLocalFailureMarker(session.agent.transformContext, {
    getProvider: () => session.agent.state.model?.provider,
    logWithheld: (line) =>
      console.error(`[agent] ${options.plugins?.sessionId ?? sessionManager.getSessionId()}: ${line}`),
  })

  abortHolder.abort = (reason?: string) => {
    if (reason !== undefined) abortHolder.reason = reason
    if (session.agent.signal?.aborted !== true) session.agent.abort()
  }

  const unsubRestart = subscribeRestartNotice(options.stream, sessionManager)

  const unsubToolNudge = attachToolNotFoundNudge(session, intendedActiveToolNames)

  // Registered only once creation can no longer fail, so a rejected creation
  // leaves no scope entry behind; tools resolve the scope lazily at call time.
  const releaseSubagentTmp =
    options.origin?.kind === 'subagent' && options.origin.parentSessionId !== '<unknown>'
      ? enterSubagentTmpScope(
          options.plugins?.sessionId ?? sessionManager.getSessionId(),
          options.origin.parentSessionId,
        )
      : undefined
  const dispose = async () => {
    releaseSubagentTmp?.()
    unsubLoopGuardTurn()
    unsubRestart?.()
    unsubToolNudge()
    if (materializedSkills) await materializedSkills.dispose()
  }
  return { session: sessionWithAbortReason, dispose, getAbortReason }
}

// Decides whether the restart tool should write the cross-restart handoff
// file (`<agentDir>/.typeclaw/restart-pending.json`) and supplies the agentDir
// + session file path + origin metadata it needs to do so. Returns an empty
// object — meaning "no handoff" — for cron/subagent/system origins (no
// attended session the next boot could resume) and for in-memory sessions
// (no file to reopen).
//
// TUI and channel origins both resume: a TUI restart reattaches to the
// reconnecting client (websocket open handler), a channel restart reopens the
// originating chat session on the channel router's boot path. The `origin`
// discriminator in the handoff is what routes the next boot to the correct
// subsystem.
export function buildRestartHandoffWiring(
  options: { origin?: SessionOrigin; plugins?: { agentDir: string } },
  sessionManager: SessionManager,
): { agentDir?: string; originatingSessionFile?: string; handoffOrigin?: RestartHandoffOrigin } {
  const origin = options.origin
  if (origin === undefined) return {}
  const handoffOrigin = restartHandoffOriginFor(origin)
  if (handoffOrigin === null) return {}
  const agentDir = options.plugins?.agentDir
  const sessionFile = sessionManager.getSessionFile()
  if (agentDir === undefined || sessionFile === undefined) return {}
  return { agentDir, originatingSessionFile: sessionFile, handoffOrigin }
}

// Reads the LIVE turn author at restart time, not the session-creation
// snapshot. A channel session is long-lived and multi-principal: the
// self-restart tool fires on whatever turn triggered it, so the handoff must
// carry that turn's author (originRef.current), not whoever first opened the
// session. Returns undefined for non-channel/no-author origins.
export function currentChannelAuthor(getOrigin: () => SessionOrigin | undefined): string | undefined {
  const origin = getOrigin()
  return origin?.kind === 'channel' ? origin.lastInboundAuthorId : undefined
}

function restartHandoffOriginFor(origin: SessionOrigin): RestartHandoffOrigin | null {
  if (origin.kind === 'tui') return { kind: 'tui' }
  if (origin.kind === 'channel') {
    return {
      kind: 'channel',
      key: { adapter: origin.adapter, workspace: origin.workspace, chat: origin.chat, thread: origin.thread },
    }
  }
  return null
}

// Subscribes the given session to the in-process broadcast that the `restart`
// tool fires on a successful hostd ACK. The subscriber dispatches by identity:
// the session whose tool execution fired the restart (originator) gets a
// `typeclaw.restart-self` notice instructing the model to proactively confirm
// restart completion in its very next reply. All other sessions (siblings) get
// the `typeclaw.restart` notice instructing them not to mention the restart
// unless directly asked. Two distinct customTypes let downstream consumers
// distinguish the cases unambiguously. display:false keeps either entry out of
// any TUI rendering that might inspect the JSONL later. Exported so unit tests
// can verify the wiring without going through createAgentSession (which needs
// auth and model registry); the composition test at the bottom of this
// module's test file covers originator + siblings end to end.
export function subscribeRestartNotice(
  stream: Stream | undefined,
  sessionManager: SessionManager,
): (() => void) | null {
  if (!stream) return null
  const unsub = stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const payload = msg.payload as { kind?: unknown; restartedAt?: unknown; originatingSessionId?: unknown } | null
    if (!payload || payload.kind !== 'container-restarting') return
    if (typeof payload.restartedAt !== 'string') return
    if (typeof payload.originatingSessionId !== 'string') return
    if (payload.originatingSessionId === sessionManager.getSessionId()) {
      sessionManager.appendCustomMessageEntry(
        'typeclaw.restart-self',
        formatRestartNoticeOriginating(payload.restartedAt),
        false,
      )
    } else {
      sessionManager.appendCustomMessageEntry('typeclaw.restart', formatRestartNotice(payload.restartedAt), false)
    }
  })
  return unsub
}

// Convention documented in src/channels/router.ts:996-1013: runtime-injected
// content in the user turn must use the `**[SYSTEM MESSAGE — not from a human]**`
// framing fenced by `---`, plus an explicit "do not acknowledge or reply"
// line. Without it, persona-rich models read the heading as a human-authored
// instruction and reply to it on the next unrelated message.
export function formatRestartNotice(restartedAt: string): string {
  return [
    '---',
    '**[SYSTEM MESSAGE — not from a human]**',
    '',
    `The TypeClaw container was restarted at ${restartedAt}. The previous session`,
    'state was preserved on disk and you have been resumed inside a new container',
    'process. **Do not acknowledge or reply to this notice unless a human directly',
    'asks whether the restart happened.**',
    '',
    'Guidance:',
    '- If a human asks whether you actually restarted, you may confirm: yes, you',
    `  did restart at ${restartedAt}.`,
    '- Otherwise, continue the conversation normally.',
    '',
    '---',
    '',
  ].join('\n')
}

// Variant for the session that called the `restart` tool. The user explicitly
// asked this conversation to restart; staying silent after the reboot is the
// reported bug (e.g. "wait, you don't even know you restarted?"). This notice instructs the
// model to acknowledge restart completion in its very next reply — once — then
// stop mentioning it. Same SYSTEM MESSAGE framing as the sibling notice so
// persona-rich models don't reply to the framing itself.
export function formatRestartNoticeOriginating(restartedAt: string): string {
  return [
    '---',
    '**[SYSTEM MESSAGE — not from a human]**',
    '',
    `The TypeClaw container was restarted at ${restartedAt} at the user's explicit`,
    'request via the `restart` tool. The restart completed successfully and you',
    'have been resumed inside a new container process with your previous',
    'conversation memory intact.',
    '',
    '**Your very next reply must briefly confirm the restart completed** (e.g.',
    '"restart finished, I\'m back" — or in whatever voice fits your persona),',
    "even if the user's next message is about something unrelated. After that",
    "single confirmation, address whatever the user's next message says, and do",
    'not mention the restart again unless the user explicitly asks about it.',
    '',
    '---',
    '',
  ].join('\n')
}

// Builds the channel tool subset: channel_send and channel_read (both always
// when a router is available — they take explicit addressing, not origin-bound),
// plus the origin-bound channel tools when the session origin is a channel —
// channel_reply, channel_history, channel_react, channel_fetch_attachment,
// look_at_channel_attachment, channel_disengage, and (when sessionId is known)
// skip_response. Those rely on origin-bound addressing or per-session turn
// state. Extracted from
// createSessionWithDispose so composition can be unit-tested without
// going through createAgentSession / auth.
//
// `sessionId` is required for `skip_response` (the tool addresses the
// LiveSession by id when stamping the skip flag) and optional otherwise.
// Callers that don't have it (e.g. early composition tests) get the
// pre-skip-response tool set, which is forward-compatible — the prompt
// guidance still mentions the NO_REPLY fallback for those cases.
export function buildChannelTools(
  channelRouter: ChannelRouter | undefined,
  origin: SessionOrigin | undefined,
  sessionId?: string,
  getOrigin?: () => SessionOrigin | undefined,
  permissions?: PermissionService,
  agentDir?: string,
): ToolDefinition[] {
  if (!channelRouter) return []
  const tools: ToolDefinition[] = []
  if (origin?.kind === 'channel') {
    // adapter/workspace/chat/thread are session-key fields and never vary across
    // a session's turns, so they stay snapshotted. The review round does: it is
    // stamped per follow-up inbound, so reading it off the creation-time snapshot
    // would hand every turn a stale (usually absent) round and silently disable
    // carrier scoping in production while origin-injecting unit tests still pass.
    const channelOrigin = {
      adapter: origin.adapter,
      workspace: origin.workspace,
      chat: origin.chat,
      thread: origin.thread,
      get githubReviewRound() {
        const current = getOrigin?.()
        return current?.kind === 'channel' ? current.githubReviewRound : origin.githubReviewRound
      },
    }
    tools.push(
      createChannelReplyTool({
        router: channelRouter,
        origin: channelOrigin,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }),
    )
    if (origin.adapter === 'github' && sessionId !== undefined)
      tools.push(createPostGithubReviewTool({ router: channelRouter, origin: channelOrigin, sessionId }))
    tools.push(createChannelHistoryTool({ router: channelRouter, origin: channelOrigin }))
    tools.push(createChannelReadTool({ router: channelRouter }))
    tools.push(
      createChannelSendTool({
        router: channelRouter,
        origin: channelOrigin,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }),
    )
    tools.push(createChannelEditTool({ router: channelRouter }))
    // Read the live turn origin, falling back to the static snapshot when no
    // getter is wired (composition tests). `reactionRef` is per-turn, so the
    // getter is what makes reactions work outside tests.
    const resolveReactionRef = (): ReactionRef | undefined => {
      const live = getOrigin?.() ?? origin
      return live.kind === 'channel' ? live.reactionRef : undefined
    }
    tools.push(
      createChannelReactTool({
        router: channelRouter,
        origin: channelOrigin,
        getReactionRef: resolveReactionRef,
      }),
    )
    tools.push(
      createChannelFetchAttachmentTool({
        router: channelRouter,
        origin: channelOrigin,
        ...(agentDir !== undefined ? { agentDir } : {}),
        ...(permissions !== undefined && agentDir !== undefined
          ? { resolveBaseDir: () => resolveInboxBaseDir(permissions, getOrigin?.() ?? origin, agentDir) }
          : {}),
      }),
    )
    tools.push(createChannelLookAtTool(channelRouter, channelOrigin, permissions))
    tools.push(createChannelDisengageTool({ router: channelRouter, origin: channelOrigin }))
    if (sessionId !== undefined) {
      tools.push(createSkipResponseTool({ router: channelRouter, sessionId }))
    }
  } else {
    tools.push(createChannelSendTool({ router: channelRouter }))
    tools.push(createChannelReadTool({ router: channelRouter }))
    tools.push(createChannelEditTool({ router: channelRouter }))
  }
  return tools
}

export function buildMcpDispatcherToolDefinitions(
  manager: McpManager,
  opts: {
    permissions: PermissionService | undefined
    getOrigin: () => SessionOrigin | undefined
    agentDir: string
  },
): ToolDefinition[] {
  const permissions = opts.permissions ?? noopPermissionService
  const tools = createMcpDispatcherTools(manager, {
    resolveHidden: () => resolveHiddenPaths(permissions, opts.getOrigin(), opts.agentDir),
  })
  return [
    defineMcpDispatcherTool(MCP_DISPATCHER_TOOL_NAMES[0], tools[0], opts.agentDir),
    defineMcpDispatcherTool(MCP_DISPATCHER_TOOL_NAMES[1], tools[1], opts.agentDir),
    defineMcpDispatcherTool(MCP_DISPATCHER_TOOL_NAMES[2], tools[2], opts.agentDir),
  ]
}

function defineMcpDispatcherTool<P>(name: string, tool: PluginTool<P>, agentDir: string): ToolDefinition {
  return definePiTool({
    name,
    label: name,
    description: tool.description,
    parameters: zodToToolParameters(tool.parameters),
    async execute(_toolCallId, params, signal) {
      const validated = tool.parameters.safeParse(params)
      if (!validated.success) {
        return {
          content: [{ type: 'text' as const, text: `invalid arguments: ${validated.error.message}` }],
          details: null,
        }
      }
      const result = await tool.execute(validated.data, {
        signal,
        sessionId: 'mcp-dispatcher',
        agentDir,
        logger: { info() {}, warn() {}, error() {} },
      })
      return { content: result.content, details: result.details ?? null }
    },
  })
}

export function buildSubagentOrchestrationTools(opts: {
  liveRegistry: LiveSubagentRegistry | undefined
  registry: SubagentRegistry | undefined
  createSessionForSubagent: CreateSessionForSubagent | undefined
  agentDir: string | undefined
  parentSessionId: string
  getOrigin: () => SessionOrigin | undefined
  permissions: PermissionService | undefined
  stream: Stream | undefined
  allowBackgroundFromSubagent?: boolean
  coalescer?: SubagentCoalescer
  channelRouter?: ChannelRouter
}): ToolDefinition[] {
  if (
    opts.liveRegistry === undefined ||
    opts.registry === undefined ||
    opts.createSessionForSubagent === undefined ||
    opts.agentDir === undefined
  ) {
    return []
  }
  return [
    createSpawnSubagentTool({
      registry: opts.registry,
      liveRegistry: opts.liveRegistry,
      createSessionForSubagent: opts.createSessionForSubagent,
      agentDir: opts.agentDir,
      parentSessionId: opts.parentSessionId,
      getOrigin: opts.getOrigin,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
      ...(opts.stream ? { stream: opts.stream } : {}),
      ...(opts.allowBackgroundFromSubagent !== undefined
        ? { allowBackgroundFromSubagent: opts.allowBackgroundFromSubagent }
        : {}),
      ...(opts.coalescer !== undefined ? { coalescer: opts.coalescer } : {}),
    }),
    createSubagentOutputTool({
      liveRegistry: opts.liveRegistry,
      getOrigin: opts.getOrigin,
      callerSessionId: opts.parentSessionId,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
    createSubagentCancelTool({
      liveRegistry: opts.liveRegistry,
      getOrigin: opts.getOrigin,
      callerSessionId: opts.parentSessionId,
      ...(opts.channelRouter !== undefined
        ? {
            hasOutstandingReviewThreadCloseout: (sessionId: string) =>
              opts.channelRouter?.hasOutstandingGithubReviewThreadCloseout?.(sessionId) ?? false,
          }
        : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
  ]
}

export function buildRoleGrantTools(opts: {
  agentDir: string | undefined
  getOrigin: () => SessionOrigin | undefined
  permissions: PermissionService | undefined
  reloadRoles: (() => RolesConfig | undefined) | undefined
}): ToolDefinition[] {
  if (opts.agentDir === undefined || opts.permissions === undefined || opts.reloadRoles === undefined) {
    return []
  }
  return [
    createGrantRoleTool({
      agentDir: opts.agentDir,
      getOrigin: opts.getOrigin,
      permissions: opts.permissions,
      reloadRoles: opts.reloadRoles,
    }),
  ]
}

export function buildTodoTools(
  agentDir: string | undefined,
  getOrigin: () => SessionOrigin | undefined,
): ToolDefinition[] {
  if (agentDir === undefined) return []
  return createTodoTools({ agentDir, getOrigin })
}

function buildCoreSystemTools(permissions: PermissionService | undefined): ToolDefinition[] {
  const definitions = [webSearchTool, webFetchTool, createLookAtTool(permissions)]
  const byName = new Map(definitions.map((tool) => [tool.name, tool]))
  if (byName.size !== definitions.length || byName.size !== CORE_SYSTEM_TOOL_NAMES.length) {
    throw new Error('core system tool catalog does not match its registered definitions')
  }
  return CORE_SYSTEM_TOOL_NAMES.map((name) => {
    const tool = byName.get(name)
    if (tool === undefined) throw new Error(`core system tool "${name}" has no registered definition`)
    return tool
  })
}

function wrapRegistryTools(
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
  getAbort: () => ((reason?: string) => void) | undefined,
  getLoopGuardTurn: () => number | undefined,
  permissions: PermissionService | undefined,
): ToolDefinition[] {
  if (!plugins) return []
  return plugins.registry.tools.map((t: PluginRegisteredTool) =>
    wrapPluginTool(t.tool, {
      pluginName: t.pluginName,
      toolName: t.toolName,
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      logger: t.logger,
      hooks: plugins.hooks,
      guards: buildInternalGuards(plugins.agentDir),
      getOrigin,
      getAbort,
      getLoopGuardTurn,
      ...(permissions !== undefined ? { permissions } : {}),
    }),
  )
}

export function wrapSystemTools(
  tools: ToolDefinition[],
  options: {
    agentDir: string
    sessionId: string
    hooks: HookBus
    guards?: readonly InternalGuard[]
    getOrigin: () => SessionOrigin | undefined
    getAbort: () => ((reason?: string) => void) | undefined
    getLoopGuardTurn?: () => number | undefined
    mcpManager?: McpManager
  },
): ToolDefinition[] {
  const mcpManager = options.mcpManager
  const resolvePreflightFileOperands =
    mcpManager === undefined
      ? undefined
      : (tool: string, args: Record<string, unknown>) =>
          tool === MCP_DISPATCHER_TOOL_NAMES[2] ? resolveMcpCallPreflightFileOperands(mcpManager, args) : undefined
  return tools.map((tool) =>
    wrapSystemTool(tool, {
      agentDir: options.agentDir,
      sessionId: options.sessionId,
      hooks: options.hooks,
      guards: options.guards,
      getOrigin: options.getOrigin,
      getAbort: options.getAbort,
      getLoopGuardTurn: options.getLoopGuardTurn,
      ...(resolvePreflightFileOperands === undefined ? {} : { resolvePreflightFileOperands }),
    }),
  )
}

export function wrapSubagentCustomTools(
  selection: PluginSubagentSelection,
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
  getAbort: () => ((reason?: string) => void) | undefined,
  getLoopGuardTurn: () => number | undefined,
  permissions: PermissionService | undefined,
): ToolDefinition[] {
  if (!selection.customTools || !plugins) return []
  const logger = makePluginLogger(selection.pluginName)
  return selection.customTools.map((tool, i) =>
    wrapPluginTool(tool, {
      pluginName: selection.pluginName,
      toolName: `${selection.toolNamePrefix}_${i}`,
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      logger,
      hooks: plugins.hooks,
      guards: buildInternalGuards(plugins.agentDir),
      getOrigin,
      getAbort,
      getLoopGuardTurn,
      ...(permissions !== undefined ? { permissions } : {}),
    }),
  )
}

function makePluginLogger(pluginName: string) {
  const prefix = `[plugin:${pluginName}]`
  return {
    info: (m: string) => console.log(`${prefix} ${m}`),
    warn: (m: string) => console.warn(`${prefix} ${m}`),
    error: (m: string) => console.error(`${prefix} ${m}`),
  }
}

export async function createOverrideResourceLoader(
  systemPrompt: string,
  origin?: SessionOrigin,
  permissions?: PermissionService,
  runtimeVersion?: string,
): Promise<DefaultResourceLoader> {
  const branding = getConfig().branding
  const withRuntime = branding
    ? runtimeVersion !== undefined
      ? `${systemPrompt}\n\n${renderRuntimeBlock(runtimeVersion)}`
      : systemPrompt
    : `${stripRuntimeIdentityProse(systemPrompt)}\n\n${renderRuntimeNondisclosureRule()}`
  const finalPrompt = withOrigin(withRuntime, origin, permissions)
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    systemPromptOverride: () => finalPrompt,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  return loader
}

export type CreateResourceLoaderOptions = {
  agentDir?: string
  plugins?: PluginSessionWiring
  materializedSkills?: MaterializedSkills | null
  origin?: SessionOrigin
  mcpManager?: McpManager
  permissions?: PermissionService
  runtimeVersion?: string
  // Public subagents whose names + `rosterDescription`s render the full-mode
  // "## Subagent orchestration" roster. When omitted (no-registry callers, the
  // debug dumper), the prompt falls back to `DEFAULT_SUBAGENT_ROSTER`. Threaded
  // from `createSessionWithDispose`, where the merged registry is already in
  // scope.
  subagentRegistry?: SubagentRegistry
  // Explicit override for the prompt mode. When omitted, the mode is derived
  // from `origin.kind`: cron + subagent → slim, tui + channel → full. Pass
  // 'full' to force the heavy prompt even on an unattended origin (rarely
  // useful; mostly an escape hatch for ad-hoc debugging).
  mode?: SystemPromptMode
  proactiveNextStepNudge?: boolean
}

// Origins where the operator-facing DEFAULT_SYSTEM_PROMPT, git-nudge, and the
// agent-folder commit guidance carry their weight: there is a human reading
// the output, the agent is expected to maintain its folder over time, and
// conversational register matters. For everything else (cron fires, default
// subagents), the slim prompt is the right default — the origin block already
// names the unattended context and tells the agent what's expected of it.
//
// Exhaustive switch (not a boolean expression) so a future origin kind forces
// the author to make an explicit full-or-slim decision at compile time. The
// previous form silently defaulted new origins to slim, which would have
// stripped the operator-facing prompt from a new interactive surface by
// accident.
export function deriveSystemPromptMode(origin: SessionOrigin | undefined): SystemPromptMode {
  if (origin === undefined) return 'full'
  switch (origin.kind) {
    case 'tui':
    case 'channel':
      return 'full'
    case 'cron':
    case 'subagent':
    case 'system':
      return 'slim'
    default: {
      const _exhaustive: never = origin
      void _exhaustive
      return 'full'
    }
  }
}

// Pure inputs for `composeSystemPrompt`. Each field maps 1:1 to a rendered
// section of the prompt; callers that don't want a section pass `undefined`
// (or `''` for `gitNudge`). Extracted so the debug dumper in
// `scripts/dump-system-prompt.ts` can reuse the exact same composition
// pipeline `createResourceLoader` uses, with no risk of drift if the
// section order changes.
//
// `mode` selects the base prompt:
//   - 'full' (default) — DEFAULT_SYSTEM_PROMPT (~2155 tok of operator-facing
//     guidance: agent folder layout, version-control rules, register matching,
//     workspace boundary). Right choice for TUI and channel sessions where a
//     human is reading the output and the agent maintains its folder.
//   - 'slim' — SLIM_SYSTEM_PROMPT (~80 tok). Right choice for cron jobs and
//     default subagents — unattended sessions where most of the operator
//     guidance is irrelevant and the origin block already covers per-kind
//     specifics (no human, side effects via tools, narrow scope).
export type SystemPromptMode = 'full' | 'slim'

export type SystemPromptComposition = {
  mode?: SystemPromptMode
  // Whether the prompt discloses that the agent runs on TypeClaw. When false,
  // the base prompt's opening is phrased generically and the `## Runtime`
  // version block is dropped. Defaults to true. Mirrors `config.branding`.
  branding?: boolean
  self: string
  // Pre-rendered full-mode orchestration roster (from `renderPublicSubagentRoster`).
  // Kept as a ready string so this composer stays pure and registry-free; the
  // registry-aware caller renders it. Ignored in slim mode (no roster section).
  // Falls back to `DEFAULT_SUBAGENT_ROSTER` when omitted.
  subagentRoster?: string
  runtimeVersion?: string
  origin?: SessionOrigin
  roleContext?: SessionRoleContext
  mcpCatalog?: string
  gitNudge: string
  proactiveNextStepNudge?: string
}

// Section-order contract for the system prompt. Kept as a pure string→string
// transform so it can be exercised without disk, plugin runtime, or auth.
//
// Cache-suffix ordering: least-volatile sections first, most-volatile last.
// This minimises the number of cached prompt bytes invalidated when a
// section changes (the provider's prompt cache hits up to the first byte
// that differs).
//
// 0. runtime block — most stable: only changes on typeclaw releases (rare).
// 1. origin block — stable across all sessions of the same kind.
// 2. gitNudge — rare changes; agent folders force-commit sessions/ and
//    memory/ after every turn, so the dirty-files list is empty most of
//    the time.
// 3. proactive next-step nudge — deterministic per model family.
//
// The wall-clock anchor that used to live here as `## Now` moved out
// entirely. It is now injected into the user turn at each `session.prompt`
// site via `renderTurnTimeAnchor` (src/agent/system-prompt.ts) so the
// stamp reflects the moment of THIS turn, not session creation. Per-turn
// injection costs zero cached bytes — the user turn is the non-cacheable
// suffix anyway — and removes the staleness failure mode where a session
// opened Friday answered "today is Friday" on Thursday.
export function composeSystemPrompt(parts: SystemPromptComposition): string {
  const branding = parts.branding ?? true
  const base =
    parts.mode === 'slim'
      ? buildSlimSystemPrompt(branding)
      : buildDefaultSystemPrompt(parts.subagentRoster ?? DEFAULT_SUBAGENT_ROSTER, branding)
  let prompt = `${base}\n\n${parts.self}`
  if (branding && parts.runtimeVersion !== undefined) {
    prompt = `${prompt}\n\n${renderRuntimeBlock(parts.runtimeVersion)}`
  }
  if (!branding) {
    prompt = `${prompt}\n\n${renderRuntimeNondisclosureRule()}`
  }
  if (parts.origin !== undefined) {
    prompt = `${prompt}\n\n${renderSessionOrigin(parts.origin, Date.now(), parts.roleContext)}`
  }
  if (parts.mcpCatalog !== undefined && parts.mcpCatalog !== '') {
    prompt = `${prompt}\n\n${parts.mcpCatalog}`
  }
  if (parts.gitNudge !== '') {
    prompt = `${prompt}\n\n${parts.gitNudge}`
  }
  if (parts.proactiveNextStepNudge !== undefined && parts.proactiveNextStepNudge !== '') {
    prompt = `${prompt}\n\n${parts.proactiveNextStepNudge}`
  }
  return prompt
}

export async function createResourceLoader(options: CreateResourceLoaderOptions = {}): Promise<DefaultResourceLoader> {
  const agentDir = options.agentDir ?? process.cwd()
  const mode: SystemPromptMode = options.mode ?? deriveSystemPromptMode(options.origin)
  // Slim mode (cron/subagent) has no orchestration section, so it never reads
  // the roster. Skip rendering it there — `renderPublicSubagentRoster` throws on
  // a public subagent with a missing/blank `rosterDescription`, and a slim
  // session must not fail on a roster it will never show.
  const subagentRoster =
    mode === 'slim'
      ? undefined
      : options.subagentRegistry !== undefined
        ? renderPublicSubagentRoster(options.subagentRegistry)
        : DEFAULT_SUBAGENT_ROSTER
  const branding = getConfig().branding
  const basePrompt =
    mode === 'slim'
      ? buildSlimSystemPrompt(branding)
      : buildDefaultSystemPrompt(subagentRoster ?? DEFAULT_SUBAGENT_ROSTER, branding)

  // Kick off the independent I/O paths concurrently. Sequential awaits
  // here used to be the dominant cold-start cost amplifier: loadSelf is 2
  // file reads and renderGitNudge spawns a subprocess. They do not depend on
  // each other, so we run them in parallel.
  // The plugin hook (runSessionPrompt) only needs `self`, so it can overlap
  // with the gitNudge subprocess while `self` is in flight too.
  //
  // Plugin-hook contract: `runSessionPrompt` runs AFTER gitNudge I/O has been
  // kicked off. A hook that mutates git-tracked files during its body races
  // that in-flight read -- mutations may or may not be reflected in the
  // resulting prompt. The bundled hooks only mutate the prompt string itself;
  // third-party plugins that need to mutate disk before the suffix section sees
  // it must do so before/outside the session-prompt hook.
  //
  // We wrap gitNudge in a `settled` shell so any rejection cannot surface as
  // an unhandled rejection during the
  // window where we're awaiting selfPromise + runSessionPrompt. Production
  // callers don't reject (renderGitNudge swallows internally) but the wrapper
  // keeps the gather shape robust if that contract changes.
  const selfPromise = loadSelf(agentDir)
  const gitNudgeSettled = mode === 'slim' ? Promise.resolve(ok('')) : settle(renderGitNudge(agentDir))
  // MCP connection is warmed up in the background at boot; gate the catalog
  // render on that warm-up settling (bounded) so a session created in the
  // warm-up window still lists connected servers. Kicked off here to overlap
  // with the self/git I/O above instead of serializing before compose.
  const mcpReadySettled =
    mode === 'full' && options.mcpManager !== undefined
      ? options.mcpManager.whenInitialConnectSettled()
      : Promise.resolve()

  let self = await selfPromise

  if (options.plugins) {
    // The plugin hook receives the partially-assembled prompt (base + identity)
    // so plugins can rewrite either section before the cache-suffix blocks are
    // appended. The base reflects the resolved mode, so a slim cron session's
    // plugin hook sees the slim base — plugins that read the base text get
    // the same shape the agent will see.
    const preHook = `${basePrompt}\n\n${self}`
    const event = { prompt: preHook, sessionId: options.plugins.sessionId, agentDir, origin: options.origin }
    await options.plugins.hooks.runSessionPrompt(event)
    // Recover `self` by stripping the leading base so the rest of the
    // composition stays section-shaped. If a plugin rewrote the base prompt as
    // well, the recovered `self` carries the full mutated remainder.
    self = event.prompt.startsWith(`${basePrompt}\n\n`) ? event.prompt.slice(basePrompt.length + 2) : event.prompt
  }

  const roleContext = options.origin !== undefined ? resolveRoleContext(options.origin, options.permissions) : undefined
  // Slim mode skips git-nudge entirely: cron + subagent sessions are not the
  // right actor to drive interactive commit decisions, and the operator-facing
  // commit guidance the nudge points back to is itself excluded from the slim
  // base prompt.
  const gitNudgeResult = await gitNudgeSettled
  const gitNudge = unwrapSettled(gitNudgeResult)

  let mcpCatalog: string | undefined
  if (mode === 'full' && options.mcpManager !== undefined) {
    await mcpReadySettled
    mcpCatalog = renderMcpCatalog(options.mcpManager.listServers())
  }

  const systemPrompt = composeSystemPrompt({
    mode,
    branding,
    self,
    subagentRoster,
    ...(options.runtimeVersion !== undefined ? { runtimeVersion: options.runtimeVersion } : {}),
    ...(options.origin !== undefined ? { origin: options.origin } : {}),
    ...(roleContext !== undefined ? { roleContext } : {}),
    ...(mcpCatalog !== undefined ? { mcpCatalog } : {}),
    gitNudge,
    ...(options.proactiveNextStepNudge === true ? { proactiveNextStepNudge: PROACTIVE_NEXT_STEP_NUDGE } : {}),
  })

  const additionalSkillPaths = [getBundledSkillsDir()]
  // pi-coding-agent's DefaultResourceLoader auto-discovers <agentDir>/skills/
  // but not <agentDir>/.agents/skills/. We do not scaffold <agentDir>/skills/
  // and the system prompt no longer advertises it — the only skill directories
  // a TypeClaw agent owns are .agents/skills/ (user-installed) and
  // memory/skills/ (dreaming-owned). Both are wired in explicitly below;
  // anything the upstream loader auto-discovers under <agentDir>/skills/ is
  // outside our supported surface.
  const userInstalledSkillsDir = join(agentDir, '.agents', 'skills')
  if (existsSync(userInstalledSkillsDir)) {
    additionalSkillPaths.push(userInstalledSkillsDir)
  }
  // Muscle-memory skills written by the dreaming subagent. Same auto-discover
  // story as `.agents/skills/` — the loader doesn't walk arbitrary subtrees of
  // the agent dir, so we wire this in explicitly. Existence-gated so a session
  // that has never dreamed doesn't pay for an empty path.
  const muscleMemorySkillsDir = join(agentDir, 'memory', 'skills')
  if (existsSync(muscleMemorySkillsDir)) {
    additionalSkillPaths.push(muscleMemorySkillsDir)
  }
  if (options.plugins) {
    for (const dir of options.plugins.registry.skillsDirs) {
      additionalSkillPaths.push(dir.path)
    }
  }
  if (options.materializedSkills) {
    additionalSkillPaths.push(options.materializedSkills.dir)
  }

  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalSkillPaths,
  })
  await loader.reload()
  return loader
}

function withOrigin(
  systemPrompt: string,
  origin: SessionOrigin | undefined,
  permissions: PermissionService | undefined,
): string {
  if (!origin) return systemPrompt
  const roleContext = resolveRoleContext(origin, permissions)
  return `${systemPrompt}\n\n${renderSessionOrigin(origin, Date.now(), roleContext)}`
}

function resolveRoleContext(
  origin: SessionOrigin,
  permissions: PermissionService | undefined,
): SessionRoleContext | undefined {
  if (permissions === undefined) return undefined
  const described = permissions.describe(origin)
  // TUI resolves to `owner` because the built-in `owner.match = [tui]` is
  // walked first under severity-then-declaration ordering AND is always
  // appended (not replaced) by user-declared `roles.owner.match[]`. We skip
  // the role block in that case to save tokens on every interactive
  // session. The guard remains here as defense-in-depth in case a future
  // change ever makes TUI resolve to something other than owner.
  if (origin.kind === 'tui' && described.role === 'owner') return undefined
  return described
}

export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

function ok<T>(value: T): Settled<T> {
  return { ok: true, value }
}

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  )
}

function unwrapSettled<T>(result: Settled<T>): T {
  if (result.ok) return result.value
  throw result.error
}
