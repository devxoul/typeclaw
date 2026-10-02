import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { z } from 'zod'

import { getConfig, resolveModel } from '@/config'
import type { PermissionService } from '@/permissions'
import type { HookBus } from '@/plugin'
import type { Stream, Unsubscribe } from '@/stream'

import { applyTurnThinkingLevel } from './attention-escalation'
import { type AgentSession, createSession, type PluginSessionWiring } from './index'
import { resolveFallbackChain } from './model-fallback'
import { applyModelRuntimeOverrides } from './model-overrides'
import { detectHardProviderError, isFailoverWorthy, subscribeProviderErrors } from './provider-error'
import { promptWithSameRefRetryOnly, type RetryPolicy } from './retry-same-ref'
import type { SubagentBashPolicy } from './reviewer-bash-policy'
import type { SessionOrigin } from './session-origin'
import {
  beginSubagentDrainWatch,
  runSubagentDrain,
  type SubagentBackgroundDrain,
  type SubagentDrainWatch,
} from './subagent-drain'
import { renderTurnTimeAnchor } from './system-prompt'
import type { ToolResultBudget } from './tool-result-budget'
import { promptPersistentTurnWithFallback } from './turn-runner'

type AgentSessionTools = NonNullable<Parameters<typeof createSession>[0]>['tools']

export type SubagentContext<P = unknown> = {
  userPrompt: string
  agentDir: string
  payload: P
}

// onFinalMessage receives the terminal assistant message's text after the
// completed run (or null for an empty terminal message/provider failure).
// Unlike orchestration output, it never projects <review>/<report> blocks.
export type RunSession = (override?: {
  userPrompt?: string
  onFinalMessage?: (message: string | null) => void
}) => Promise<void>

// Fields shared verbatim between the plugin-author-facing `Subagent` in
// `@/plugin/types` and the runtime-internal `Subagent` below. Every consumer
// that reads from `SubagentRegistry` (the spawn_subagent tool, payload
// validation, default session construction) only touches these fields, so
// keeping them in a single declaration makes the plugin→internal shim a
// rest-spread instead of a hand-maintained property list. Adding a new field
// here surfaces it on both types in one edit, which is the regression class
// the previous shim shape suffered: `visibility` and `requiresSpecificPermission`
// existed on the plugin type but were silently dropped by the shim, so every
// plugin-contributed public subagent appeared internal at the registry layer.
//
// The two fields that intentionally diverge — `tools` and `customTools` —
// live on each concrete `Subagent` type below. The plugin side uses
// `BuiltinToolRef[]` + `Tool<any>[]` (the public plugin API, decoupled from
// pi-coding-agent's internal tool shape); the internal side uses the resolved
// `AgentSessionTools` + `ToolDefinition[]` that pi-coding-agent actually
// consumes. The boundary is real and load-bearing — collapsing it would
// expose pi-coding-agent's internal API as part of the plugin contract.
export type SubagentShared<P = unknown> = {
  systemPrompt: string
  // Model profile this subagent prefers. Resolved against `config.models` at
  // session construction. Unknown profile names fall back to `default` with
  // a warning. See `Subagent` in `@/plugin/types` for the full contract.
  profile?: string
  payloadSchema?: z.ZodType<P>
  handler?: (ctx: SubagentContext<P>, runSession: RunSession) => Promise<void>
  toolResultBudget?: ToolResultBudget
  visibility?: 'public' | 'internal'
  // One-line purpose blurb for the main agent's "## Subagent orchestration"
  // roster, rendered from the registry by `renderPublicSubagentRoster` instead
  // of hand-maintained in the prompt (the drift that once left `researcher` and
  // `planner` unlisted). Required for `visibility: 'public'`; ignored otherwise.
  // On `SubagentShared` so the plugin→internal shim carries it via rest-spread
  // (see `pluginSubagentShim`), like `visibility`.
  rosterDescription?: string
  requiresSpecificPermission?: boolean
  // Opt-in: when true, this subagent's session is wired with the orchestration
  // tools (spawn_subagent/subagent_output/subagent_cancel) so it can delegate
  // to its own subagents, bounded by MAX_SUBAGENT_DEPTH and caller-owned
  // registry scoping. Default (unset/false) keeps the subagent a leaf — the
  // historical contract for explorer/scout/memory-logger/etc.
  canSpawnSubagents?: boolean
  // Opt-in: allow this subagent to spawn background children AND drain their
  // completions back into its own session (requires canSpawnSubagents). Default
  // (unset/false) keeps background spawns denied from this subagent — it must
  // use synchronous spawns. Only meaningful when the runtime wires the drain
  // capability (createSessionForSubagent provides stream+sessionId+liveRegistry).
  canBackgroundSpawnSubagents?: boolean
  // Wall-clock ceiling on a single spawn, enforced at the orchestration
  // layer (both `dispatchSpawnSubagent` and the stream-driven
  // `SubagentConsumer`). When exceeded, the orchestrator's `await` settles
  // with a timeout error and releases the coalescing key for `inFlightKey`,
  // so the next spawn of the same (name, inFlightKey) can proceed instead
  // of being skip-coalesced. The underlying `invokeSubagent` call may keep
  // running — pi-coding-agent's `session.prompt` does not accept an
  // AbortSignal today, so a half-open LLM stream stays alive until the OS
  // reaps it. The trade-off is honest: cancellation is upstream's job;
  // releasing the coalescing key is ours, and that is what unblocks the
  // user-visible "every subsequent turn skipped while the first spawn
  // hangs" symptom. Omit for no ceiling (legacy behavior; the spawn waits
  // as long as the provider takes).
  timeoutMs?: number
  // Per-subagent bash capability restriction, enforced at the bash-wrap site
  // INDEPENDENT of the caller's role (unlike the role-derived bwrap sandbox,
  // which returns early for trusted/owner). A read-only subagent declares this
  // to fence its `bash` to read-only commands even when spawned by a privileged
  // caller. See `src/agent/reviewer-bash-policy.ts`. Omit for no restriction
  // (the historical contract — prompt-only enforcement).
  bashPolicy?: SubagentBashPolicy
  // Stable logical-job key shared by every dispatch path. Subagents that omit
  // it keep each spawn independent; declarations use it only when duplicate
  // execution is safe to suppress for a validated payload identity.
  inFlightKey?: (payload: P) => string
}

export type Subagent<P = unknown> = SubagentShared<P> & {
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
}

export type SubagentRegistry = Readonly<Record<string, Subagent<any>>>

// Validate payload against the subagent's schema. Strict: when no schema is
// declared, a non-undefined payload is rejected to prevent silent drops of
// caller intent.
export function validateSubagentPayload(name: string, subagent: Subagent<any>, payload: unknown): unknown {
  if (subagent.payloadSchema) {
    const result = subagent.payloadSchema.safeParse(payload)
    if (!result.success) {
      throw new Error(`subagent ${name}: invalid payload: ${result.error.message}`)
    }
    return result.data
  }
  if (payload !== undefined) {
    throw new Error(`subagent ${name}: does not accept a payload (received ${describePayload(payload)})`)
  }
  return payload
}

function describePayload(payload: unknown): string {
  if (payload === null) return 'null'
  if (Array.isArray(payload)) return 'array'
  return typeof payload
}

// Per-spawn override wins over the subagent's declared profile; absent override
// keeps the declared profile. Both may be undefined (no profile → createSession
// resolves `default`).
export function resolveSubagentProfile(
  subagent: SubagentShared<any>,
  options: CreateSessionForSubagentOptions | undefined,
): string | undefined {
  return options?.profileOverride ?? subagent.profile
}

function profileFromPayload(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === 'object') {
    const value = (payload as { profile?: unknown }).profile
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

export type CreateSessionForSubagentResult = {
  session: AgentSession
  dispose?: () => Promise<void>
  hooks?: HookBus
  sessionId?: string
  agentDir?: string
  origin?: SessionOrigin
  getTranscriptPath?: () => string | undefined
  backgroundDrain?: SubagentBackgroundDrain
}
export type CreateSessionForSubagentOptions = {
  name?: string
  parentSessionId?: string
  spawnedByRole?: string
  spawnedByOrigin?: SessionOrigin
  // Plugin hook wiring for the subagent's tools. When present, the subagent's
  // builtin bash/read/edit/write run through the plugin `tool.before`/`tool.after`
  // hooks (security guards AND github-cli-auth GitHub-token injection) exactly
  // like the main and plugin-subagent sessions. Without it, the builtin tools run
  // raw (the prior behavior) — so standalone/test callers stay unaffected. The
  // production runtime always supplies it (src/run/index.ts) so a generic
  // task-spawned subagent's `git push`/`gh` gets a minted token instead of
  // failing with "could not read Username".
  plugins?: PluginSessionWiring
  // The role/permission service that drives builtin-bash sandboxing. It MUST be
  // forwarded alongside `plugins`: buildBuiltinPiToolOverrides only applies
  // applyBashSandbox / applyTmpPathRedirect when `permissions` is present, so
  // wiring hooks without permissions would inject the GitHub token yet leave the
  // sandbox OFF — strictly weaker than the plugin-subagent branch this matches.
  permissions?: PermissionService
  // Per-spawn model-profile override, resolved by `invokeSubagent` from the
  // validated payload's `profile` field. Wins over the subagent's declared
  // `profile`, letting a single spawn run a worker on a different model tier
  // (e.g. operator on `deep`) without a second subagent. Unknown profile names
  // fall back to `default` via resolveProfile, the same as a declared profile.
  profileOverride?: string
}
export type CreateSessionForSubagent = (
  subagent: Subagent<any>,
  options?: CreateSessionForSubagentOptions,
) => Promise<AgentSession | CreateSessionForSubagentResult>

export const defaultCreateSessionForSubagent: CreateSessionForSubagent = (subagent, options) =>
  createSession({
    systemPromptOverride: subagent.systemPrompt,
    origin: {
      kind: 'subagent',
      subagent: options?.name ?? '<unknown>',
      parentSessionId: options?.parentSessionId ?? '<unknown>',
      ...(options?.spawnedByRole !== undefined ? { spawnedByRole: options.spawnedByRole } : {}),
      ...(options?.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
    },
    ...(subagent.tools ? { tools: subagent.tools } : {}),
    customTools: subagent.customTools ?? [],
    ...(options?.plugins !== undefined ? { plugins: options.plugins } : {}),
    ...(options?.permissions !== undefined ? { permissions: options.permissions } : {}),
    ...(resolveSubagentProfile(subagent, options) !== undefined
      ? { profile: resolveSubagentProfile(subagent, options) }
      : {}),
    ...(subagent.toolResultBudget !== undefined ? { toolResultBudget: subagent.toolResultBudget } : {}),
    ...(subagent.bashPolicy !== undefined ? { bashPolicy: subagent.bashPolicy } : {}),
  })

type NormalizedSubagentSession = {
  session: AgentSession
  dispose: () => Promise<void>
  hooks: HookBus | undefined
  sessionId: string | undefined
  agentDir: string | undefined
  origin: SessionOrigin | undefined
  getTranscriptPath: (() => string | undefined) | undefined
  backgroundDrain: SubagentBackgroundDrain | undefined
}

function normalizeSubagentSession(result: AgentSession | CreateSessionForSubagentResult): NormalizedSubagentSession {
  if ('session' in result) {
    return {
      session: result.session,
      dispose: result.dispose ?? (async () => {}),
      hooks: result.hooks,
      sessionId: result.sessionId,
      agentDir: result.agentDir,
      origin: result.origin,
      getTranscriptPath: result.getTranscriptPath,
      backgroundDrain: result.backgroundDrain,
    }
  }
  return {
    session: result,
    dispose: async () => {},
    hooks: undefined,
    sessionId: undefined,
    agentDir: undefined,
    origin: undefined,
    getTranscriptPath: undefined,
    backgroundDrain: undefined,
  }
}

export type InvokeSubagentOptions = {
  registry: SubagentRegistry
  createSessionForSubagent?: CreateSessionForSubagent
  agentDir: string
  userPrompt: string
  payload?: unknown
  parentSessionId?: string
  spawnedByRole?: string
  spawnedByOrigin?: SessionOrigin
  onProviderError?: (errorMessage: string) => void
  // Fires synchronously after the AgentSession is created and before
  // session.prompt() is invoked, with both the live session reference and
  // its allocated sessionId. The only consumer in production is the spawn
  // tool's LiveSubagentRegistry path, which uses it to attach a progress
  // subscriber and register the abort handle while invokeSubagent retains
  // its `Promise<void>` external contract.
  onSessionCreated?: (event: {
    session: AgentSession
    sessionId: string | undefined
    abort: () => Promise<void>
  }) => void
  // Sink for the subagent's captured final message (a reviewer `<review>` block,
  // a researcher `<report>` block, or the last free-form assistant text).
  // `runSession` owns the capture so the required-block guard can re-prompt
  // before the result settles; `startSubagent` passes this to receive the output.
  onFinalMessageCaptured?: (msg: string) => void
}

export async function invokeSubagent(name: string, options: InvokeSubagentOptions): Promise<void> {
  const subagent = options.registry[name]
  if (!subagent) throw new Error(`unknown subagent: ${name}`)

  const validatedPayload = validateSubagentPayload(name, subagent, options.payload)
  const createSessionForSubagent = options.createSessionForSubagent ?? defaultCreateSessionForSubagent
  const profileOverride = profileFromPayload(validatedPayload)
  const sessionOptions: CreateSessionForSubagentOptions = {
    name,
    ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.spawnedByRole !== undefined ? { spawnedByRole: options.spawnedByRole } : {}),
    ...(options.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
    ...(profileOverride !== undefined ? { profileOverride } : {}),
  }

  const runSession: RunSession = async (override) => {
    const { session, dispose, hooks, sessionId, agentDir, origin, getTranscriptPath, backgroundDrain } =
      normalizeSubagentSession(await createSessionForSubagent(subagent, sessionOptions))
    let aborted = false
    let activeModelRef = resolveFallbackChain(getConfig().models, resolveSubagentProfile(subagent, sessionOptions))[0]!
    // Latency tolerance is decided ONCE here, from the REQUESTED profile — not the
    // one resolveProfile() landed on. A `deep` subagent whose operator never
    // configured `models.deep` still runs on a background path nobody is watching
    // live, so it stays patient; a spawn explicitly overridden onto `fast` is an
    // explicit request for responsiveness and loses it.
    const retryPolicy: RetryPolicy =
      resolveSubagentProfile(subagent, sessionOptions) === 'deep' ? 'patient' : 'responsive'
    // MUST be updated after every turn — initial, drain, and nudge — so a later
    // success clears an earlier failure and the guard below reads the true state.
    let latestTurnFailure: Error | undefined
    const requiredBlockTag = REQUIRED_FINAL_BLOCK[name]
    // A provider failure reaches us as EITHER a soft leaf error or a hard throw
    // (the turn runner rethrows a hard outcome once the chain is spent, and
    // promptWithSameRefRetryOnly rethrows an exhausted hard error). Recording only
    // the soft shape would let a thrown outage escape as a subagent crash and skip
    // the required-block fallback entirely.
    //
    // Absorbing the throw is only safe where that fallback exists to turn it into
    // an honest synthetic result. A subagent with no required block has no such
    // surface, so swallowing there would report a clean ok:true for a turn that
    // never ran. Those keep failing, as does anything unrecognized — loop-guard
    // aborts, spawn timeouts, real bugs.
    const recordHardProviderFailure = (err: unknown): void => {
      if (requiredBlockTag === undefined) throw err
      const detected = detectHardProviderError(err)
      if (detected === null) throw err
      latestTurnFailure = new Error(detected.message)
    }
    let drainWatch: SubagentDrainWatch | undefined
    const capture = attachFinalMessageCapture(session, requiredBlockTag, options.onFinalMessageCaptured ?? (() => {}))
    if (options.onSessionCreated !== undefined) {
      options.onSessionCreated({
        session,
        sessionId,
        abort: async () => {
          aborted = true
          await session.abort()
        },
      })
    }
    const unsubProviderErrors =
      options.onProviderError !== undefined
        ? subscribeProviderErrors(session, (err) => options.onProviderError!(err.message))
        : null
    const turnEvent =
      hooks && sessionId !== undefined && agentDir !== undefined
        ? { sessionId, agentDir, ...(origin !== undefined ? { origin } : {}) }
        : undefined
    const userPromptForTurn = override?.userPrompt ?? options.userPrompt
    // Per-turn memory injection for vector agents: subagents have no
    // system-prompt `# Memory` section (their prompt is a systemPromptOverride),
    // so the turn-start hook renders memory into `retrievalContext.results`,
    // appended to the user turn below. Empty for non-vector agents.
    const retrievalContext = { results: '' }
    try {
      if (hooks && turnEvent !== undefined) {
        await hooks.runSessionTurnStart({ ...turnEvent, userPrompt: userPromptForTurn, retrievalContext })
      }
      if (backgroundDrain !== undefined) {
        drainWatch = beginSubagentDrainWatch(backgroundDrain)
      }
      try {
        const turnText =
          retrievalContext.results.length > 0
            ? `${renderTurnTimeAnchor()}\n\n${userPromptForTurn}\n\n${retrievalContext.results}`
            : `${renderTurnTimeAnchor()}\n\n${userPromptForTurn}`
        applyTurnThinkingLevel(session, userPromptForTurn, session.thinkingLevel, undefined, {
          allowEscalation: false,
        })
        const result = await promptPersistentTurnWithFallback({
          refs: resolveFallbackChain(getConfig().models, resolveSubagentProfile(subagent, sessionOptions)),
          currentModelRef: activeModelRef,
          profile: resolveSubagentProfile(subagent, sessionOptions),
          retryPolicy,
          session,
          text: turnText,
          skipProviderErrorSubscription: true,
          detectSoftErrorFromLeaf: true,
          shouldFailover: (err) => isFailoverWorthy(err.message),
          setModelForRef: async (ref) => {
            await session.setModel(applyModelRuntimeOverrides(resolveModel(ref), ref))
            activeModelRef = ref
          },
          beforeAttempt: () => {
            applyTurnThinkingLevel(session, userPromptForTurn, session.thinkingLevel, undefined, {
              allowEscalation: false,
            })
          },
          onAttemptFailed: (attempt) => {
            console.warn(
              `[subagent] ${name} ${attempt.outcome} failure on ${attempt.ref}: ${attempt.errorMessage ?? 'unknown'}; falling back`,
            )
          },
        })
        if (result.success) activeModelRef = result.refUsed
        latestTurnFailure = result.success ? undefined : result.lastError
        throwIfLoopGuardAborted(session)
      } catch (err) {
        recordHardProviderFailure(err)
      } finally {
        if (hooks && turnEvent !== undefined) {
          await hooks.runSessionTurnEnd(turnEvent)
        }
      }
      if (drainWatch !== undefined && backgroundDrain !== undefined) {
        await runSubagentDrain(drainWatch, {
          drain: backgroundDrain,
          prompt: async (text) => {
            try {
              const drained = await promptWithSameRefRetryOnly(
                session,
                `${renderTurnTimeAnchor()}\n\n${text}`,
                undefined,
                { retryPolicy },
              )
              latestTurnFailure = drained.success ? undefined : drained.lastError
            } catch (err) {
              recordHardProviderFailure(err)
            }
            throwIfLoopGuardAborted(session)
          },
          cancelled: () => aborted,
          maxChildWaitMs: DRAIN_MAX_CHILD_WAIT_MS,
        })
      }
      throwIfLoopGuardAborted(session)
      // Required-block guard (mirrors the channel empty-response guard): a subagent
      // that owes a result block but ended without one gets a bounded re-prompt to
      // emit it as text, then an honest fallback — never a silent stale-preamble
      // result or a loud failure. Runs strictly after the drain settles so it is a
      // final contract-repair pass, not another research phase; it deliberately
      // does NOT re-run the drain.
      if (requiredBlockTag !== undefined) {
        // `latestTurnFailure` set means the last turn died on an upstream provider
        // error rather than finishing without the block. Nudging is then pointless
        // — the nudge is itself a model call, so it hits the same failing provider
        // and returns in ms, burning the whole budget in seconds against an outage
        // that outlives it. Skip straight to a fallback that names the real cause.
        for (
          let attempt = 1;
          !aborted &&
          !capture.hasRequiredBlock() &&
          latestTurnFailure === undefined &&
          attempt <= MAX_REQUIRED_BLOCK_RETRIES;
          attempt++
        ) {
          console.warn(
            `[subagent] ${name} required_block_retry attempt=${attempt}/${MAX_REQUIRED_BLOCK_RETRIES} tag=${requiredBlockTag}`,
          )
          try {
            const nudge = await promptWithSameRefRetryOnly(
              session,
              `${renderTurnTimeAnchor()}\n\n${renderRequiredBlockRetryNudge(requiredBlockTag)}`,
              undefined,
              { retryPolicy },
            )
            if (!nudge.success) latestTurnFailure = nudge.lastError
          } catch (err) {
            recordHardProviderFailure(err)
          }
          throwIfLoopGuardAborted(session)
        }
        if (!aborted && !capture.hasRequiredBlock()) {
          const reason: MissingBlockReason = latestTurnFailure !== undefined ? 'provider-failure' : 'missing-block'
          console.warn(`[subagent] ${name} required_block_fallback tag=${requiredBlockTag} reason=${reason}`)
          capture.setSyntheticFinalMessage(renderMissingRequiredBlockFallback(name, requiredBlockTag, reason))
        }
      }
      if (hooks && sessionId !== undefined) {
        await hooks.runSessionIdle({
          sessionId,
          parentTranscriptPath: getTranscriptPath?.(),
          idleMs: 0,
          ...(origin !== undefined ? { origin } : {}),
        })
      }
      override?.onFinalMessage?.(latestTurnFailure === undefined ? capture.getTerminalAssistantText() : null)
    } finally {
      unsubProviderErrors?.()
      if (hooks && sessionId !== undefined) {
        await hooks.runSessionEnd({ sessionId, ...(origin !== undefined ? { origin } : {}) })
      }
      drainWatch?.stop()
      session.dispose()
      await dispose()
    }
  }

  if (subagent.handler) {
    const ctx = {
      userPrompt: options.userPrompt,
      agentDir: options.agentDir,
      payload: validatedPayload,
    }
    await subagent.handler(ctx, runSession)
  } else {
    await runSession()
  }
}

export class SubagentTimeoutError extends Error {
  override readonly name = 'SubagentTimeoutError'
  constructor(
    readonly subagentName: string,
    readonly coalesceKey: string,
    readonly timeoutMs: number,
  ) {
    super(`subagent ${subagentName} (key=${coalesceKey}) spawn timed out after ${timeoutMs}ms`)
  }
}

class SubagentLoopGuardAbortError extends Error {
  override readonly name = 'SubagentLoopGuardAbortError'

  constructor(readonly reason: string) {
    super(`subagent aborted by loop guard (${reason})`)
  }
}

function throwIfLoopGuardAborted(session: AgentSession): void {
  const reason = (session as AgentSession & { getAbortReason?: () => string | undefined }).getAbortReason?.()
  if (reason?.startsWith('loop_guard:') === true) throw new SubagentLoopGuardAbortError(reason)
}

export function isSubagentTimeoutError(err: unknown): err is SubagentTimeoutError {
  return err instanceof SubagentTimeoutError
}

export async function awaitWithSubagentTimeout(
  work: Promise<void>,
  subagentName: string,
  coalesceKey: string,
  timeoutMs: number | undefined,
): Promise<void> {
  if (timeoutMs === undefined) {
    await work
    return
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubagentTimeoutError(subagentName, coalesceKey, timeoutMs)), timeoutMs)
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export type SubagentHandle = {
  taskId: string
  sessionId: string | undefined
  abort: () => Promise<void>
}

export type StartSubagentResult = {
  handle: Promise<SubagentHandle>
  completion: Promise<{ ok: true; finalMessage?: string } | { ok: false; error: string; finalMessage?: string }>
}

export type StartSubagentOptions = InvokeSubagentOptions & {
  taskId: string
  onSession?: (event: { session: AgentSession; sessionId: string | undefined; abort: () => Promise<void> }) => void
}

// Non-blocking alternative to invokeSubagent. Returns immediately with two
// promises:
// - `handle` resolves with { taskId, sessionId, abort } once the AgentSession
//   has been created (typically the first microtask). The taskId is what the
//   caller chose; sessionId is allocated by the session factory.
// - `completion` resolves when the subagent's prompt finishes, ok=true with
//   an optional final message, or ok=false with an error message.
// The two promises share a single underlying invokeSubagent invocation;
// `completion` settles after dispose, so the session reference exposed via
// `handle.abort` becomes a no-op once `completion` resolves.
//
// `timeoutMs` enforcement: the `spawn_subagent` tool drives its background
// `subagent.completed` broadcast off this `completion` promise, so an
// unbounded `invokeSubagent` (a wedged `session.prompt` that never settles)
// would leave `completion` pending forever and the parent never woken. When
// the subagent declares `timeoutMs`, we race the work against a ceiling and
// settle `completion` with `ok: false` on expiry — which fires the FAILED
// broadcast so the parent learns the spawn died instead of hanging silently.
// This mirrors `awaitWithSubagentTimeout` on the SubagentConsumer path; here
// the timeout resolves (rather than rejects) because `completion` already maps
// failures to `{ ok: false }`. Cancellation is best-effort: pi's
// `session.prompt` takes no AbortSignal, so we call the session `abort` handle
// (which the handle resolution captured) to tear down what we can; the LLM
// stream may keep running until the OS reaps it.
export function startSubagent(name: string, options: StartSubagentOptions): StartSubagentResult {
  let resolveHandle: (h: SubagentHandle) => void
  let rejectHandle: (err: Error) => void
  const handle = new Promise<SubagentHandle>((resolve, reject) => {
    resolveHandle = resolve
    rejectHandle = reject
  })
  let handleSettled = false
  let finalMessage: string | undefined
  let abortSession: (() => Promise<void>) | undefined

  const work = invokeSubagent(name, {
    ...options,
    onFinalMessageCaptured: (msg) => {
      finalMessage = msg
      options.onFinalMessageCaptured?.(msg)
    },
    onSessionCreated: (event) => {
      handleSettled = true
      abortSession = event.abort
      resolveHandle({ taskId: options.taskId, sessionId: event.sessionId, abort: event.abort })
      if (options.onSession !== undefined) {
        options.onSession(event)
      }
    },
  })
    .then(() => ({ ok: true as const, ...(finalMessage !== undefined ? { finalMessage } : {}) }))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      if (!handleSettled) {
        rejectHandle(err instanceof Error ? err : new Error(error))
      }
      return { ok: false as const, error, ...(finalMessage !== undefined ? { finalMessage } : {}) }
    })

  const timeoutMs = options.registry[name]?.timeoutMs
  const completion =
    timeoutMs === undefined ? work : raceSubagentCompletion(work, name, options.taskId, timeoutMs, () => finalMessage)

  void completion.then(() => {
    if (timeoutMs !== undefined) void abortSession?.()
  })

  return { handle, completion }
}

type SubagentCompletion = { ok: true; finalMessage?: string } | { ok: false; error: string; finalMessage?: string }

// `getFinalMessage` is read INSIDE the timeout callback, not at race-construction
// time, so the timed-out result carries whatever the subagent had captured by the
// moment the timer fired (e.g. a researcher's `<report>` block emitted just before
// the kill). JS is single-threaded, so this read is torn-free; it preserves only
// what an assistant `message_end` already committed — a result still mid-stream
// when the timer fires cannot be recovered. The outcome stays `ok: false`: a
// timeout is a lifecycle failure, and `finalMessage` here is recovery data for
// the parent to inspect/re-persist, not proof the subagent honored its contract.
function raceSubagentCompletion(
  work: Promise<SubagentCompletion>,
  name: string,
  taskId: string,
  timeoutMs: number,
  getFinalMessage: () => string | undefined,
): Promise<SubagentCompletion> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<SubagentCompletion>((resolve) => {
    timer = setTimeout(() => {
      const finalMessage = getFinalMessage()
      resolve({
        ok: false,
        error: new SubagentTimeoutError(name, taskId, timeoutMs).message,
        ...(finalMessage !== undefined ? { finalMessage } : {}),
      })
    }, timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

// The tags a subagent can use to wrap its structured result: the reviewer's
// `<review>`, the researcher's `<report>`. Fixed literals — never user input —
// so the per-tag patterns below are injection-safe.
type FinalBlockTag = 'review' | 'report'

// A complete <TAG>...</TAG> block. The block IS the result: same-message
// preamble/trailing chatter or a later summary turn must not become the captured
// final message. `[\s\S]` spans newlines (the block is multi-line); non-greedy
// stops at the first close so an incidental `<TAG>` literal in the wrapped text
// cannot swallow real content. Global so a message with several blocks yields the
// last (the revision).
const FINAL_BLOCK_RE: Readonly<Record<FinalBlockTag, RegExp>> = {
  review: /<review>[\s\S]*?<\/review>/g,
  report: /<report>[\s\S]*?<\/report>/g,
}

function lastTaggedBlock(text: string, tag: FinalBlockTag): string | null {
  const matches = text.match(FINAL_BLOCK_RE[tag])
  return matches === null ? null : (matches[matches.length - 1] ?? null)
}

// Subagents whose result IS a REQUIRED tagged block — the parent must receive
// that block or a structured "could not complete" fallback, never a stale
// earlier turn and never a silent empty completion. Keyed by registry name.
//
// Both entries share one failure mode on the `deep`/openai-codex profile: a run
// that ends on tool-call-only turns emits no closing block, so `finalMessage`
// stays undefined and `spawn_subagent`/`subagent_output` synthesize "completed …
// with no final message" as an `ok: true` success. For the researcher that
// surfaced the earlier `<analysis>` preamble as findings (guarded by ae5014e5);
// for the reviewer the GitHub flow has no `<review>` to post and silently
// `skip_response`s — the stranded-review bug. This gate gives both a bounded
// re-prompt then an honest low-confidence fallback instead of the silent drop.
// Backstop ceiling for the background drain: a running child that never settles
// is abandoned after this so the parent can synthesize partial results instead
// of hanging forever. Deliberately larger than the per-child `timeoutMs`
// (scout = 5 min) so that a child's own timeout is the primary release and this
// only catches children that declare none.
const DRAIN_MAX_CHILD_WAIT_MS = 600_000

const REQUIRED_FINAL_BLOCK: Readonly<Record<string, FinalBlockTag>> = { researcher: 'report', reviewer: 'review' }

// Bounded re-prompt budget for the required-block guard, mirroring the channel
// empty-response guard's MAX_EMPTY_TURN_RETRIES. A subagent that owes a result
// block but ended without one is nudged at most this many times before the
// honest fallback is installed.
const MAX_REQUIRED_BLOCK_RETRIES = 2

// The recovery nudge. It MUST forbid tools: the known failure mode is a provider
// retry loop on a block-producing tool call, so re-driving the tool path would
// just re-trigger the loop. Asking for the block as plain text is the repair.
// The tail is tag-specific: each block has different mandatory child fields.
function renderRequiredBlockRetryNudge(tag: FinalBlockTag): string {
  const tail =
    tag === 'report'
      ? 'in particular do NOT call write_report. Do NOT continue researching or spawn more subagents.\n\nIf the report file was not successfully written, still emit the block: set <report_file>none</report_file>, <confidence>low</confidence> (explain the report artifact was not completed), and note in <open_questions> that the run should be retried.'
      : `Do NOT re-run gh, diff reads, or spawn more subagents.\n\nEmit the block from the analysis you have already done: include your <summary>, whatever <finding> items you can support with evidence, and a <verdict> (approve | request-changes | comment). Only use a real verdict if you actually reached one. If you could NOT analyze enough to decide, do NOT invent a verdict — set <verdict>${INCOMPLETE_REVIEW_VERDICT}</verdict> exactly (this signals an incomplete review; the parent will not treat it as approve/request-changes/comment, even on a re-review).`
  return `---
**[SYSTEM MESSAGE — not from a human]**

Your previous turn ended without the required <${tag}> block. This is an automated runtime recovery signal, not a human message.

Emit the final <${tag}>...</${tag}> block NOW as plain assistant text. Do NOT call any tools — ${tail}

Output exactly one <${tag}> block and nothing else.`
}

// Unambiguous marker on a synthesized incomplete-review fallback. The parent's
// GitHub re-review flow overrides a `comment` verdict into a decisive APPROVE /
// REQUEST_CHANGES when prior blockers look resolved — which would let a review
// that NEVER RAN post a formal verdict. So the fallback carries no real verdict:
// it uses this sentinel in place of approve|request-changes|comment, and the
// GitHub skill keys off it to post only an honest failure comment and leave
// review state untouched. Kept in sync with the exemption in
// src/skills/typeclaw-channel-github/SKILL.md.
export const INCOMPLETE_REVIEW_VERDICT = 'incomplete-review-not-a-verdict'

// Why the block is missing. 'missing-block' is the model's own doing — it ended
// its turn without emitting the block. 'provider-failure' is an upstream outage:
// the turn never ran to completion at all. Both produce the SAME sentinel verdict
// (the downstream contract is identical — no analysis landed), but the prose must
// name the real cause, or an operator reading a capacity outage is told the
// subagent misbehaved and re-runs it straight into the same wall.
type MissingBlockReason = 'missing-block' | 'provider-failure'

// The terminal graceful fallback when the nudges are exhausted. It fabricates NO
// findings — only a structured "could not complete" notice — so the parent gets
// a usable result instead of stale `<analysis>` or a hard error.
function renderMissingRequiredBlockFallback(name: string, tag: FinalBlockTag, reason: MissingBlockReason): string {
  const providerFailed = reason === 'provider-failure'
  const cause = providerFailed
    ? `the upstream model provider kept failing (capacity/outage), so the turn never completed`
    : `it ended without emitting the required <${tag}> block`
  if (tag === 'report') {
    return `<report>
<summary>
The ${name} subagent could not complete a research report in this run: ${cause}${providerFailed ? '' : ' (a known cause is the report tool not completing)'}. Do not treat any earlier analysis text as findings — rerun the researcher or gather the sources directly if the answer is still needed.
</summary>
<report_file>
none
</report_file>
<confidence>
low — no complete research report artifact was produced.
</confidence>
<open_questions>
The original research request remains unresolved; rerun the ${name} subagent or gather the sources directly.
</open_questions>
</report>`
  }
  if (tag === 'review') {
    const headline = providerFailed ? 'UPSTREAM PROVIDER FAILURE — NOT A VERDICT' : 'INCOMPLETE REVIEW — NOT A VERDICT'
    const remedy = providerFailed
      ? 'This is an infrastructure failure, not a judgement on the code. Re-request the review once the provider recovers; do not report it as a review that found nothing.'
      : 'Re-request the review; if it still cannot complete, post an honest "review could not be completed" note and leave existing review state unchanged.'
    return `<review>
<summary>
${headline}. The ${name} subagent could not complete a review in this run: ${cause}. No findings were produced and no verdict was reached — do not treat any earlier text as a verdict, and do NOT map this to APPROVE/REQUEST_CHANGES/COMMENT (including on a re-review). ${remedy}
</summary>
<findings>
</findings>
<verdict>${INCOMPLETE_REVIEW_VERDICT}</verdict>
</review>`
  }
  return `<${tag}>\nThe ${name} subagent could not produce the required <${tag}> block (${cause}) and could not recover; rerun it or inspect the transcript.\n</${tag}>`
}

type SubagentCapture = {
  // True once a required-block subagent (researcher) has emitted its `<report>`
  // block; always false for subagents without a required block.
  hasRequiredBlock: () => boolean
  // Raw terminal assistant text, independent of the orchestrator's block projection.
  getTerminalAssistantText: () => string | null
  // Install a captured final message directly — used by the required-block guard
  // to set an honest fallback when the block was never emitted, so the parent
  // gets a structured result rather than stale preamble.
  setSyntheticFinalMessage: (msg: string) => void
}

function attachFinalMessageCapture(
  session: AgentSession,
  requiredBlockTag: FinalBlockTag | undefined,
  onFinalMessage: (msg: string) => void,
): SubagentCapture {
  let terminalAssistantText: string | null = null
  let lastAssistant: string | null = null
  let lastReview: string | null = null
  let lastRequired: string | null = null
  try {
    subscribeToAwaitedAgentEvents(session, (event: unknown) => {
      const ev = event as { type?: string; message?: { role?: string; content?: unknown } }
      if (ev?.type !== 'message_end') return
      // Real assistant messages carry role 'assistant'; older test doubles omit
      // it. user/toolResult echoes must never overwrite the assistant's answer.
      const role = ev.message?.role
      if (role !== undefined && role !== 'assistant') return
      const text = extractFinalMessageText(ev.message?.content)
      terminalAssistantText = text
      if (text === null) return
      lastAssistant = text

      // Required-block contract (researcher): the result IS the block. A turn
      // with text but no block — the `<analysis>` preamble, a process narrative —
      // must NOT become the captured result, so `hasRequiredBlock` stays false and
      // the guard in runSession re-prompts rather than returning stale preamble.
      if (requiredBlockTag !== undefined) {
        const block = lastTaggedBlock(text, requiredBlockTag)
        if (block !== null) {
          lastRequired = block
          onFinalMessage(lastRequired)
        }
        return
      }

      // Preferred-block contract (reviewer) / free-form: a `<review>` block wins
      // when present; otherwise the last free-form assistant text is the result.
      const review = lastTaggedBlock(text, 'review')
      if (review !== null) lastReview = review
      onFinalMessage(lastReview ?? lastAssistant)
    })
  } catch {
    // session.subscribe is a stable upstream API; defensive try is for test
    // doubles that don't implement it.
  }
  return {
    getTerminalAssistantText: () => terminalAssistantText,
    hasRequiredBlock: () => lastRequired !== null,
    setSyntheticFinalMessage: (msg) => {
      lastRequired = msg
      onFinalMessage(msg)
    },
  }
}

function subscribeToAwaitedAgentEvents(session: AgentSession, listener: (event: unknown) => void): () => void {
  const agent = (
    session as AgentSession & {
      agent?: { subscribe?: (listener: (event: unknown) => void) => () => void }
    }
  ).agent
  return agent?.subscribe?.(listener) ?? session.subscribe(listener)
}

function extractFinalMessageText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed ? trimmed : null
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    const joined = parts.join('').trim()
    return joined ? joined : null
  }
  return null
}

export type SubagentConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type SubagentInFlightKey = (subagent: string, payload: unknown, parentSessionId?: string) => string

export type CreateSubagentConsumerOptions = {
  stream: Stream
  // Resolved per incoming stream message so plugin reload can swap the merged
  // registry without rebuilding the consumer.
  getRegistry: () => SubagentRegistry
  agentDir: string
  createSessionForSubagent?: CreateSessionForSubagent
  // Coalescing key. Default uses the subagent name alone, so the same subagent
  // cannot run concurrently. Override to allow per-payload concurrency (e.g.
  // memory-logger keyed by parentSessionId so different sessions run in parallel
  // while the same session deduplicates).
  inFlightKey?: SubagentInFlightKey
  coalescer?: SubagentCoalescer
  logger?: SubagentConsumerLogger
}

export type SubagentConsumer = {
  start: () => void
  stop: () => void
  inFlightCount: () => number
}

export class SubagentCoalescer {
  private readonly inFlight = new Set<string>()

  tryAcquire(key: string): boolean {
    if (this.inFlight.has(key)) return false
    this.inFlight.add(key)
    return true
  }

  release(key: string): void {
    this.inFlight.delete(key)
  }

  count(): number {
    return this.inFlight.size
  }
}

export function subagentCoalesceKey<P>(options: {
  subagentName: string
  payload: P
  fallbackKey: string
  inFlightKey?: (payload: P) => string
  parentSessionId?: string
}): string {
  let payloadKey = options.fallbackKey
  if (options.inFlightKey !== undefined) {
    try {
      payloadKey = options.inFlightKey(options.payload)
    } catch {
      payloadKey = options.fallbackKey
    }
  }
  const key = `${options.subagentName}:${payloadKey}`
  return options.parentSessionId === undefined ? key : `${options.parentSessionId}:${key}`
}

const consoleLogger: SubagentConsumerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

function parseSpawnedByOriginJson(
  raw: string | undefined,
  logger: SubagentConsumerLogger,
  subagentName: string,
): SessionOrigin | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`[subagent] ${subagentName}: ignoring malformed spawnedByOriginJson on stream target: ${message}`)
    return undefined
  }
  // Shape-validate the decoded value so a malformed sender (or a future
  // bug in cron consumer's encode side) cannot poison the subagent's
  // origin with arbitrary shapes. The check is narrow: object with a
  // `kind` field whose value is one of the SessionOrigin discriminator
  // strings. Permission resolution treats unknown shapes as guest, so
  // failing closed here matches the rest of the system.
  if (!isSessionOriginShape(parsed)) {
    logger.warn(`[subagent] ${subagentName}: ignoring spawnedByOriginJson with unrecognized SessionOrigin shape`)
    return undefined
  }
  return parsed
}

// Must list EVERY SessionOrigin discriminator. `system` is included so a
// streamed memory/backup spawn (whose spawnedByOrigin is serialized to JSON
// and re-parsed here) keeps its owner-resolving origin instead of being
// dropped and silently demoted to guest — the exact regression the system
// origin exists to prevent. Keep in sync with the SessionOrigin union.
const SESSION_ORIGIN_KINDS = new Set(['tui', 'cron', 'channel', 'subagent', 'system'])
function isSessionOriginShape(value: unknown): value is SessionOrigin {
  if (value === null || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && SESSION_ORIGIN_KINDS.has(kind)
}

export function createSubagentConsumer({
  stream,
  getRegistry,
  agentDir,
  createSessionForSubagent,
  inFlightKey = (name) => name,
  coalescer = new SubagentCoalescer(),
  logger = consoleLogger,
}: CreateSubagentConsumerOptions): SubagentConsumer {
  let unsubscribe: Unsubscribe | null = null
  const localInFlight = new Set<string>()

  return {
    start() {
      if (unsubscribe !== null) return
      unsubscribe = stream.subscribe({ target: { kind: 'new-session' } }, async (msg) => {
        const target = msg.target as {
          kind: 'new-session'
          subagent: string
          parentSessionId?: string
          spawnedByRole?: string
          spawnedByOriginJson?: string
        }
        const name = target.subagent
        const registry = getRegistry()
        if (registry[name] === undefined) {
          logger.warn(`[subagent] no registered subagent "${name}", ignoring ${msg.id}`)
          return
        }
        const key = inFlightKey(name, msg.payload, target.parentSessionId)
        if (!coalescer.tryAcquire(key)) {
          logger.warn(`[subagent] ${key}: previous run still in progress, skipping`)
          return
        }
        localInFlight.add(key)
        try {
          const spawnedByOrigin = parseSpawnedByOriginJson(target.spawnedByOriginJson, logger, name)
          await awaitWithSubagentTimeout(
            invokeSubagent(name, {
              registry,
              ...(createSessionForSubagent !== undefined ? { createSessionForSubagent } : {}),
              agentDir,
              userPrompt: '',
              payload: msg.payload,
              onProviderError: (message) => logger.error(`[subagent] ${key}: LLM call failed: ${message}`),
              ...(target.parentSessionId !== undefined ? { parentSessionId: target.parentSessionId } : {}),
              ...(target.spawnedByRole !== undefined ? { spawnedByRole: target.spawnedByRole } : {}),
              ...(spawnedByOrigin !== undefined ? { spawnedByOrigin } : {}),
            }),
            name,
            key,
            registry[name]?.timeoutMs,
          )
        } catch (err) {
          if (isSubagentTimeoutError(err)) {
            logger.warn(`[subagent] ${key} timed out after ${err.timeoutMs}ms; releasing coalesce key`)
          } else {
            const message = err instanceof Error ? err.message : String(err)
            logger.error(`[subagent] ${key} failed: ${message}`)
          }
        } finally {
          localInFlight.delete(key)
          coalescer.release(key)
        }
      })
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
    inFlightCount() {
      return localInFlight.size
    },
  }
}
