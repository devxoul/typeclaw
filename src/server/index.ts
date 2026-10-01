import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { Server as BunServer, ServerWebSocket } from 'bun'

import {
  createSessionWithDispose as defaultCreateSessionWithDispose,
  renderTurnTimeAnchor,
  type AgentSession,
  type CreateSessionOptions,
  type CreateSessionResult,
} from '@/agent'
import { applyTurnThinkingLevel, getQuestionSignal, type QuestionSignal } from '@/agent/attention-escalation'
import { runPluginDoctorChecks, runPluginDoctorFix } from '@/agent/doctor'
import type { LiveSessionRegistry } from '@/agent/live-sessions'
import type { LiveSubagentRegistry } from '@/agent/live-subagents'
import { resolveFallbackChain } from '@/agent/model-fallback'
import { applyModelRuntimeOverrides } from '@/agent/model-overrides'
import { forgetSharedLoopGuardTool } from '@/agent/plugin-tools'
import { detectProviderError, isFailoverWorthy } from '@/agent/provider-error'
import { requestContainerRestart } from '@/agent/restart'
import { consumeRestartHandoff, type RestartHandoff } from '@/agent/restart-handoff'
import { promptWithSameRefRetryOnly } from '@/agent/retry-same-ref'
import { sessionMetaPayload } from '@/agent/session-meta'
import type { SessionOrigin } from '@/agent/session-origin'
import { parseSubagentCompletedPayload, renderSubagentCompletionReminder } from '@/agent/subagent-completion-reminder'
import type { CreateSessionForSubagent, SubagentCoalescer } from '@/agent/subagents'
import { TODO_CONTINUATION_SOURCE } from '@/agent/todo/continuation'
import {
  armRestartKickForOrigin,
  clearAbortSuppressionForOrigin,
  extractTurnUsage,
  recordTurnOutcome,
  recordTurnStart,
  runIdleContinuation,
} from '@/agent/todo/continuation-wiring'
import { SUBAGENT_OUTPUT_TOOL_NAME } from '@/agent/tools/subagent-output'
import { promptPersistentTurnWithFallback } from '@/agent/turn-runner'
import type { ChannelRouter } from '@/channels/router'
import { getConfig, resolveModel } from '@/config'
import { aggregateCronList, type CronJob, type CronListEntry, loadCron } from '@/cron'
import type { McpManager } from '@/mcp'
import type { PermissionService } from '@/permissions'
import type { HookBus } from '@/plugin'
import type { BrokerWsData, ContainerBroker } from '@/portbroker'
import type { ReloadAllResult, ReloadCause, ReloadContext, ReloadRegistry } from '@/reload'
import type { ClaimController, ClaimResultEvent } from '@/role-claim'
import type { PluginRuntime, PluginRuntimeState } from '@/run/plugin-runtime'
import type { CommandOutbound, CommandRunner } from '@/server/command-runner'
import type { SessionFactory } from '@/sessions'
import type {
  ClientMessage,
  CronListEntryPayload,
  CronListSourcePayload,
  InspectClientMessage,
  InspectFramePayload,
  InspectServerMessage,
  PromptDelivery,
  QueueStateItem,
  ReloadResultPayload,
  ServerMessage,
  TunnelLogsClientMessage,
  TunnelLogsServerMessage,
  TunnelSnapshot,
} from '@/shared'
import type { Stream, StreamMessage, StreamMessageId, Unsubscribe } from '@/stream'
import type { TunnelManager } from '@/tunnels'

export type ReloadAllFn = (context?: ReloadContext) => Promise<ReloadAllResult>
export type CreateSessionFn = (options?: CreateSessionOptions) => Promise<AgentSession | CreateSessionResult>

export type ServerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type ServerOptions = {
  port: number
  reloadAll?: ReloadAllFn
  reloadRegistry?: ReloadRegistry
  createSession?: CreateSessionFn
  sessionFactory?: SessionFactory
  stream?: Stream
  channelRouter?: ChannelRouter
  mcpManager?: McpManager
  agentDir?: string
  pluginRuntime?: PluginRuntime
  permissions?: PermissionService
  // Durable cron fire-progress lookup so `cron list` marks count-exhausted jobs
  // as retired instead of showing a stale future fire time. Omit in tests/dev.
  getFiredCount?: (job: CronJob) => number
  containerName?: string
  runtimeVersion?: string
  tuiToken?: string
  // Optional in-process portbroker handler. When provided, requests to the
  // /portbroker WS path are routed to it instead of being treated as TUI
  // sessions. Omit to keep TUI-only behavior (used by tests + non-container
  // dev runs).
  containerBroker?: ContainerBroker
  tunnelManager?: TunnelManager
  // Optional logger for server-side events. Defaults to `consoleLogger`
  // which writes to stdout/stderr so `typeclaw logs` surfaces every event.
  // Tests inject a fake logger to assert on captured output.
  logger?: ServerLogger
  // Optional role-claim controller. When set, the server accepts
  // `claim_start` / `claim_cancel` from TUI-class WS clients (the host
  // CLI's `typeclaw role claim` command in particular), and pushes
  // `claim_started` / `claim_completed` / `claim_error` back over the
  // same connection. Omitted in tests that don't exercise the flow.
  claimController?: ClaimController
  // Optional command runner factory. The server invokes this once at start
  // with an `outbound` callback wired to send `command_stdout` / `command_stderr`
  // / `command_exit` / `command_error` frames back to the originating WS for
  // a given callId. The server owns the callId→ws map; the runner is
  // transport-agnostic. Omitted in tests that don't exercise plugin commands;
  // without it the four `exec_command`-family messages are answered with
  // `command_error` so the host CLI sees a clean failure.
  commandRunnerFactory?: (outbound: CommandOutbound) => CommandRunner
  // Subagent orchestration plumbing for TUI sessions. Both fields must be
  // present together for the spawn_subagent / subagent_output / subagent_cancel
  // tools to surface; `createSession` gates registration on all three of
  // (liveSubagentRegistry, subagentRegistry, createSessionForSubagent), and
  // we derive subagentRegistry per WS connection from the same `pluginRuntime`
  // snapshot that already feeds `plugins.registry` — so a reload landing
  // mid-connection keeps using the snapshot the session opened with, matching
  // the existing per-session lifecycle invariant.
  //
  // `createSessionForSubagent` is passed eagerly (not late-bound) because the
  // TUI server is constructed AFTER the channel manager in `startAgent`,
  // breaking the construction cycle that forces the channel session factory's
  // `getCreateSessionForSubagent` late-binding.
  //
  // Channel and cron sessions get the same plumbing through
  // `buildChannelSessionFactory` / `createSessionForCron` (see src/run/). The
  // three top-level callers must stay aligned; otherwise the agent's tool
  // surface diverges across origin kinds — exactly the gap PR #281 flagged
  // as out-of-scope follow-up.
  liveSubagentRegistry?: LiveSubagentRegistry
  subagentCoalescer?: SubagentCoalescer
  createSessionForSubagent?: CreateSessionForSubagent
  // Id-keyed registry of live AgentSessions, used by `/inspect` (and any
  // future read-only session-event consumer) to subscribe to session
  // events without owning the session lifecycle. Populated by every
  // session-creation site that wants its sessions inspectable; an absent
  // registry is fine — `/inspect` will report "session not live, replay
  // from JSONL only" when it can't resolve the id.
  liveSessionRegistry?: LiveSessionRegistry
  // Test seam for holding an outcome write open and asserting drain ordering.
  // Production always uses the real persistence function.
  recordTurnOutcome?: typeof recordTurnOutcome
  // Test seam: the idle/todo continuation driver invoked by the drain loop.
  // Production always uses the real runIdleContinuation.
  runIdleContinuation?: typeof runIdleContinuation
}

const consoleLogger: ServerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type Server = ReturnType<typeof createServer>

type TuiWsData = { kind: 'tui'; sessionId: string }
// Command-class connections skip TUI session bootstrap. Used by the host
// CLI's container-command-client. Authenticated with the same TUI token
// because both surfaces are owner-equivalent (a process that holds the
// TUI token can already do anything the TUI can).
type CommandWsData = { kind: 'command' }
type TunnelLogsWsData = { kind: 'tunnel-logs'; unsubscribe: Unsubscribe | null }
type InspectWsData = {
  kind: 'inspect'
  unsubAgent: (() => void) | null
  unsubBroadcast: Unsubscribe | null
  unsubCron: Unsubscribe | null
}
type WsData = TuiWsData | CommandWsData | TunnelLogsWsData | BrokerWsData | InspectWsData
type Ws = ServerWebSocket<TuiWsData>
type CommandWs = ServerWebSocket<CommandWsData>
type TunnelLogsWs = ServerWebSocket<TunnelLogsWsData>
type InspectWs = ServerWebSocket<InspectWsData>
type AnyOwnerWs = Ws | CommandWs

// A turn whose assistant leaf aborted or errored never produced a usable turn,
// so its question shape must not seed the next turn's cross-turn escalation.
function tuiTurnLeafFailed(session: AgentSession): boolean {
  const leaf = session.sessionManager?.getLeafEntry()
  if (!leaf || leaf.type !== 'message' || leaf.message.role !== 'assistant') return false
  return leaf.message.stopReason === 'aborted' || leaf.message.stopReason === 'error'
}

type QueuedPrompt = {
  streamMessageId: StreamMessageId
  text: string
  delivery: PromptDelivery
  ts: number
  source?: string
}

type SessionState = {
  session: AgentSession
  activeModelRef: ReturnType<typeof resolveFallbackChain>[number]
  // The session's creation-time thinking level, captured once. An escalated turn
  // moves `session.thinkingLevel` to `high`, so neither turn-driving path (drain
  // loop, no-stream fallback) can use the live getter as the reset target — both
  // read this captured default instead.
  turnThinkingDefault: AgentSession['thinkingLevel']
  // Prior real user turn's question shape, for cross-turn "Jeff Bezos" escalation.
  // Null until the first user turn; carried turn-to-turn within this session only.
  lastQuestionSignal: QuestionSignal | null
  sessionFileId: string
  origin: SessionOrigin
  sessionManager: { getSessionFile: () => string | undefined } | undefined
  drainQueue: QueuedPrompt[]
  draining: boolean
  unsubBroadcast: Unsubscribe | null
  unsubPrompts: Unsubscribe | null
  unsubClaim: Unsubscribe | null
  activeClaimCode: string | null
  // Captured at session open so close-time hooks fire against the same
  // generation that ran session.start. A plugin reload mid-connection does
  // not re-target this session's lifecycle hooks.
  runtimeSnapshot: PluginRuntimeState | null
  unsubTurnOutcome: Unsubscribe | null
  // Serializes outcome persistence and the idle continuation decision. The
  // tail always fulfills so one disk failure cannot poison every later turn;
  // its value separately reports whether the latest write succeeded before
  // continuation reads state.
  todoOutcomeWrite: Promise<boolean>
  todoContinuation: { recordTurnOutcome: typeof recordTurnOutcome; runIdleContinuation: typeof runIdleContinuation }
  // Latest turn's usage, captured from `message_end` by forwardSessionEvents and
  // read at the `done` send site (which lives outside that subscriber). Reset at
  // each turn start so a turn with no usage event sends a plain `done`.
  lastUsage: { input: number; output: number; totalTokens: number; cost: number } | null
  dispose: () => Promise<void>
}

// Swallows the Bun-thrown error when a command's async cleanup emits a
// final frame after its ws has begun closing. Returns false on failure so
// callers can debounce subsequent sends for the same callId.
export function safeWsSend(ws: { send: (data: string) => void }, msg: ServerMessage): boolean {
  try {
    ws.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

const TIMESTAMPED_SERVER_MESSAGES: ReadonlySet<ServerMessage['type']> = new Set([
  'text_delta',
  'tool_start',
  'tool_end',
  'done',
  'error',
  'prompt_started',
])

function send(ws: Ws, msg: ServerMessage): boolean {
  const stamped = TIMESTAMPED_SERVER_MESSAGES.has(msg.type) ? { ...msg, ts: Date.now() } : msg
  return safeWsSend(ws, stamped)
}

function sendTunnelLog(ws: TunnelLogsWs, msg: TunnelLogsServerMessage): boolean {
  try {
    ws.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

function sendInspect(ws: InspectWs, msg: InspectServerMessage): boolean {
  try {
    ws.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0)
  return btoa(s)
}

export function createServer({
  port,
  reloadAll,
  reloadRegistry,
  createSession = defaultCreateSessionWithDispose,
  sessionFactory,
  stream,
  channelRouter,
  mcpManager,
  agentDir,
  pluginRuntime,
  permissions,
  getFiredCount,
  containerName,
  runtimeVersion,
  tuiToken,
  containerBroker,
  tunnelManager,
  logger = consoleLogger,
  claimController,
  commandRunnerFactory,
  liveSubagentRegistry,
  subagentCoalescer,
  createSessionForSubagent,
  liveSessionRegistry,
  recordTurnOutcome: todoOutcomeWriter = recordTurnOutcome,
  runIdleContinuation: todoIdleContinuation = runIdleContinuation,
}: ServerOptions) {
  const sessionStates = new WeakMap<Ws, SessionState>()
  const callIdToWs = new Map<string, AnyOwnerWs>()

  // The first TUI WS open per container lifetime checks for
  // `.typeclaw/restart-pending.json`; subsequent opens see null. The
  // in-flight promise serializes concurrent first-opens — two TUIs
  // reconnecting at the same instant share the single consume() call rather
  // than each racing to reopen the originator's JSONL. Once the promise
  // resolves, the handoff is consumed exactly once: subsequent opens see
  // `handoffPending === false` and return null without checking the file.
  let handoffInFlight: Promise<RestartHandoff | null> | null = null
  let handoffPending = true
  async function takeRestartHandoff(): Promise<RestartHandoff | null> {
    if (!handoffPending) return null
    if (handoffInFlight !== null) return handoffInFlight
    if (agentDir === undefined) {
      handoffPending = false
      return null
    }
    handoffInFlight = consumeRestartHandoff(agentDir, { accept: (h) => h.origin.kind === 'tui' }).catch(() => null)
    const result = await handoffInFlight
    handoffPending = false
    handoffInFlight = null
    return result
  }

  function resumeFromHandoff(handoff: RestartHandoff, factory: SessionFactory | undefined): SessionManager | null {
    if (factory === undefined) return null
    const sessionPath = `${factory.sessionDir()}/${handoff.originatingSessionFile}`
    try {
      return SessionManager.open(sessionPath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`restart-handoff: failed to reopen ${sessionPath}: ${message}`)
      return null
    }
  }

  const commandRunner: CommandRunner | undefined = commandRunnerFactory
    ? commandRunnerFactory({
        stdout(callId, chunk) {
          const ws = callIdToWs.get(callId)
          if (ws) safeWsSend(ws, { type: 'command_stdout', callId, chunk: encodeBase64(chunk) })
        },
        stderr(callId, chunk) {
          const ws = callIdToWs.get(callId)
          if (ws) safeWsSend(ws, { type: 'command_stderr', callId, chunk: encodeBase64(chunk) })
        },
        exit(callId, code) {
          const ws = callIdToWs.get(callId)
          callIdToWs.delete(callId)
          if (ws) safeWsSend(ws, { type: 'command_exit', callId, code })
        },
        error(callId, message) {
          const ws = callIdToWs.get(callId)
          if (ws) safeWsSend(ws, { type: 'command_error', callId, message })
        },
      })
    : undefined

  // Shared command-frame dispatcher: both TUI-class and command-class
  // connections route through here. Non-command ClientMessage types are
  // silently dropped so command-class connections (which only ever speak
  // exec_command/command_stdin/command_stdin_end/command_abort) can reuse
  // the same handler as the TUI without spreading switch logic.
  function handleCommandFrame(ws: AnyOwnerWs, msg: ClientMessage): void {
    if (msg.type === 'exec_command') {
      if (!commandRunner) {
        safeWsSend(ws, {
          type: 'command_error',
          callId: msg.callId,
          message: 'plugin commands are not enabled on this agent',
        })
        safeWsSend(ws, { type: 'command_exit', callId: msg.callId, code: 1 })
        return
      }
      // Guard at the WS layer BEFORE registering the callId→ws mapping:
      // if another connection (or this one) is already running a command
      // with this callId, refuse the replay. Without this check, a stale
      // or malicious client could overwrite the mapping and steal the
      // original command's output frames.
      if (callIdToWs.has(msg.callId)) {
        safeWsSend(ws, {
          type: 'command_error',
          callId: msg.callId,
          message: `callId "${msg.callId}" is already in flight`,
        })
        safeWsSend(ws, { type: 'command_exit', callId: msg.callId, code: 1 })
        return
      }
      // Parse the optional parent-origin JSON: invalid JSON falls back to
      // the synthetic owner origin rather than rejecting the command, so a
      // malformed env var on the caller's side doesn't break the whole
      // dispatch. The runner uses the parsed value as spawnedByOrigin
      // verbatim — the trust boundary is the WS auth token, not JSON shape.
      let parentOrigin: SessionOrigin | undefined
      if (msg.parentOriginJson !== undefined) {
        try {
          parentOrigin = JSON.parse(msg.parentOriginJson) as SessionOrigin
        } catch {
          parentOrigin = undefined
        }
      }
      callIdToWs.set(msg.callId, ws)
      commandRunner.start(
        {
          callId: msg.callId,
          name: msg.name,
          args: msg.args,
          ...(msg.isolated !== undefined ? { isolated: msg.isolated } : {}),
          ...(parentOrigin !== undefined ? { parentOrigin } : {}),
        },
        ws,
      )
      return
    }
    if (msg.type === 'command_stdin') {
      if (!commandRunner) return
      commandRunner.feedStdin(msg.callId, msg.chunk)
      return
    }
    if (msg.type === 'command_stdin_end') {
      if (!commandRunner) return
      commandRunner.endStdin(msg.callId)
      return
    }
    if (msg.type === 'command_abort') {
      if (!commandRunner) return
      commandRunner.abort(msg.callId, msg.reason)
      return
    }
  }

  function start(): BunServer<WsData> {
    const bunServer = Bun.serve<WsData>({
      port,
      fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === '/portbroker') {
          if (!containerBroker) return new Response('portbroker disabled', { status: 404 })
          const data: BrokerWsData = { kind: 'portbroker', authed: false }
          if (server.upgrade(req, { data })) return
          return new Response('upgrade failed', { status: 400 })
        }
        if (url.pathname === '/tunnel-logs') {
          if (isWebSocketUpgrade(req) && tuiToken !== undefined && url.searchParams.get('token') !== tuiToken) {
            return new Response('unauthorized', { status: 401 })
          }
          const data: TunnelLogsWsData = { kind: 'tunnel-logs', unsubscribe: null }
          if (server.upgrade(req, { data })) return
          return new Response('upgrade failed', { status: 400 })
        }
        if (url.pathname === '/inspect') {
          if (isWebSocketUpgrade(req) && tuiToken !== undefined && url.searchParams.get('token') !== tuiToken) {
            return new Response('unauthorized', { status: 401 })
          }
          const data: InspectWsData = { kind: 'inspect', unsubAgent: null, unsubBroadcast: null, unsubCron: null }
          if (server.upgrade(req, { data })) return
          return new Response('upgrade failed', { status: 400 })
        }
        // `/commands` is the dedicated host-CLI proxy path. It skips TUI
        // session creation (which costs an AgentSession spawn per command
        // invocation) but uses the same tuiToken because both surfaces
        // are owner-equivalent.
        // `/commands` is the dedicated host-CLI proxy path. It skips TUI
        // session creation (which costs an AgentSession spawn per command
        // invocation) but uses the same tuiToken because both surfaces
        // are owner-equivalent.
        if (url.pathname === '/commands') {
          if (isWebSocketUpgrade(req) && tuiToken !== undefined && url.searchParams.get('token') !== tuiToken) {
            return new Response('unauthorized', { status: 401 })
          }
          const data: CommandWsData = { kind: 'command' }
          if (server.upgrade(req, { data })) return
          return new Response('upgrade failed', { status: 400 })
        }
        if (isWebSocketUpgrade(req) && tuiToken !== undefined && url.searchParams.get('token') !== tuiToken) {
          return new Response('unauthorized', { status: 401 })
        }
        const sessionId = crypto.randomUUID()
        const data: TuiWsData = { kind: 'tui', sessionId }
        if (server.upgrade(req, { data })) return
        return new Response('typeclaw agent', { status: 200 })
      },
      websocket: {
        async open(rawWs) {
          if (rawWs.data.kind === 'portbroker') {
            containerBroker?.open(rawWs as ServerWebSocket<BrokerWsData>)
            return
          }
          if (rawWs.data.kind === 'command') {
            // Command-class connections are pure transport for plugin-command
            // dispatch. No AgentSession is created, no plugin lifecycle hooks
            // fire, no `connected` frame is sent. The host CLI proxy sends
            // exec_command immediately on open and tears the socket down
            // when command_exit arrives.
            return
          }
          if (rawWs.data.kind === 'tunnel-logs') return
          if (rawWs.data.kind === 'inspect') return
          const ws = rawWs as Ws
          try {
            const handoff = await takeRestartHandoff()
            const resumed = handoff !== null ? resumeFromHandoff(handoff, sessionFactory) : null
            const sessionManager = resumed ?? sessionFactory?.createPersisted()
            const sessionFileId = sessionManager?.getSessionId() ?? ws.data.sessionId
            // Snapshot the runtime once so the entire session lifecycle for this
            // ws connection sees one consistent generation of registry+hooks. A
            // reload landing mid-connection swaps the live pointer; this session
            // keeps using the snapshot it was created with until close.
            const runtimeSnapshot = pluginRuntime?.get()
            const pluginsWiring =
              runtimeSnapshot !== undefined && agentDir !== undefined
                ? {
                    registry: runtimeSnapshot.registry,
                    hooks: runtimeSnapshot.hooks,
                    sessionId: sessionFileId,
                    agentDir,
                  }
                : undefined
            const origin: SessionOrigin = { kind: 'tui', sessionId: sessionFileId }
            // Derive subagentRegistry from the same runtimeSnapshot that
            // populates `plugins.registry`. createSession gates the orchestration
            // tools on (liveRegistry, subagentRegistry, createSessionForSubagent,
            // agentDir) being all-present; threading the registry alongside the
            // two server-owned fields gives the gate a complete tuple for TUI
            // sessions whenever the host plumbed in plugin runtime + subagent
            // wiring (production), while keeping every existing test that omits
            // either side at exactly its current tool surface.
            const subagentRegistry = runtimeSnapshot?.subagents
            const result = await createSession({
              reloadRegistry,
              sessionManager,
              origin,
              ...(stream ? { stream } : {}),
              ...(channelRouter ? { channelRouter } : {}),
              ...(mcpManager ? { mcpManager } : {}),
              ...(pluginsWiring ? { plugins: pluginsWiring } : {}),
              ...(permissions !== undefined ? { permissions } : {}),
              ...(containerName !== undefined ? { containerName } : {}),
              ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
              ...(liveSubagentRegistry !== undefined ? { liveSubagentRegistry } : {}),
              ...(subagentCoalescer !== undefined ? { subagentCoalescer } : {}),
              ...(subagentRegistry !== undefined ? { subagentRegistry } : {}),
              ...(createSessionForSubagent !== undefined ? { createSessionForSubagent } : {}),
            })
            const session = 'session' in result ? result.session : result
            const dispose = 'session' in result && result.dispose ? result.dispose : async () => {}

            const state: SessionState = {
              session,
              activeModelRef: resolveFallbackChain(getConfig().models, undefined)[0]!,
              turnThinkingDefault: session.thinkingLevel,
              lastQuestionSignal: null,
              sessionFileId,
              origin,
              sessionManager,
              drainQueue: [],
              draining: false,
              unsubBroadcast: null,
              unsubPrompts: null,
              unsubClaim: null,
              activeClaimCode: null,
              runtimeSnapshot: runtimeSnapshot ?? null,
              unsubTurnOutcome: null,
              todoOutcomeWrite: Promise.resolve(true),
              todoContinuation: { recordTurnOutcome: todoOutcomeWriter, runIdleContinuation: todoIdleContinuation },
              lastUsage: null,
              dispose,
            }
            sessionStates.set(ws, state)

            if (runtimeSnapshot !== undefined && agentDir !== undefined) {
              await runtimeSnapshot.hooks.runSessionStart({ sessionId: sessionFileId, agentDir })
            }

            if (agentDir !== undefined) {
              state.unsubTurnOutcome = subscribeTurnOutcome(state, agentDir, logger)
            }

            liveSessionRegistry?.register({
              sessionId: sessionFileId,
              session,
              origin: sessionMetaPayload(origin).origin,
              registeredAtMs: Date.now(),
            })
            forwardSessionEvents(ws, state, logger, sessionFileId)

            if (stream) {
              state.unsubPrompts = stream.subscribe({ target: { kind: 'session', sessionId: sessionFileId } }, (msg) =>
                enqueuePrompt(ws, state, msg, agentDir, logger, stream),
              )

              state.unsubBroadcast = stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
                routeSubagentCompletionReminder(state, msg, stream)
                const payload: ServerMessage = {
                  type: 'notification',
                  payload: msg.payload,
                  ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
                  ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
                }
                send(ws, payload)
              })
            }

            send(ws, {
              type: 'connected',
              sessionId: sessionFileId,
              ...(runtimeVersion !== undefined ? { serverVersion: runtimeVersion } : {}),
            })
            console.log(`session ${sessionFileId}: open`)

            // Fire the post-restart kick. The originator's JSONL already
            // contains the `typeclaw.restart-self` custom message entry that
            // the dying container appended (see subscribeRestartNotice in
            // src/agent/index.ts). pi's buildSessionContext() hydrates that
            // entry as a `role: "user"` LLM message on the next prompt, so
            // a single-space kick is enough to trigger a turn — the entry's
            // own text instructs the model to "briefly confirm the restart
            // completed". Publish AFTER the session-target subscription is
            // wired (state.unsubPrompts above) so the kick is enqueued, not
            // dropped on the floor.
            if (resumed !== null && stream) {
              // Arm the one-shot restart-kick suppressor BEFORE publishing the
              // kick: the kick owns the first post-restart turn ("I'm back"),
              // so the first idle after it must not also fire a todo
              // continuation. The flag is consumed by that first idle. Best-
              // effort: a failure here only risks one redundant nudge, which
              // the episode budget still bounds.
              if (agentDir !== undefined) {
                await armRestartKickForOrigin(agentDir, origin).catch((err) =>
                  logger.error(`[server] ${sessionFileId}: arm restart-kick suppression failed: ${describeErr(err)}`),
                )
                // The restart may have aborted an in-flight turn, arming the
                // durable user-abort block. This resume IS the restart, so
                // clear it — otherwise the resumed session never auto-continues
                // its incomplete todos. Gated to this restart-handoff path.
                await clearAbortSuppressionForOrigin(agentDir, origin).catch((err) =>
                  logger.error(`[server] ${sessionFileId}: clear abort suppression failed: ${describeErr(err)}`),
                )
              }
              stream.publish({
                target: { kind: 'session', sessionId: sessionFileId },
                payload: { kind: 'prompt', text: ' ', delivery: 'queue' },
                meta: { source: 'restart-handoff' },
              })
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`session ${ws.data.sessionId}: open failed: ${message}`)
            send(ws, { type: 'error', message })
            ws.close()
          }
        },
        async message(rawWs, raw) {
          if (rawWs.data.kind === 'portbroker') {
            await containerBroker?.message(rawWs as ServerWebSocket<BrokerWsData>, raw as string | Buffer)
            return
          }
          // Command-class connections accept ONLY the four exec_command-
          // family frames. Anything else (prompt, reload, claim_*, etc.) is
          // silently dropped because there's no AgentSession or claim
          // controller attached to this kind of connection. Routing through
          // safeWsSend + the callIdToWs map keeps the outbound path
          // transport-agnostic.
          if (rawWs.data.kind === 'command') {
            const cws = rawWs as CommandWs
            const msg = JSON.parse(String(raw)) as ClientMessage
            handleCommandFrame(cws, msg)
            return
          }
          if (rawWs.data.kind === 'tunnel-logs') {
            handleTunnelLogsMessage(rawWs as TunnelLogsWs, raw, tunnelManager)
            return
          }
          if (rawWs.data.kind === 'inspect') {
            handleInspectMessage(rawWs as InspectWs, raw, liveSessionRegistry, stream)
            return
          }
          const ws = rawWs as Ws
          const msg = JSON.parse(String(raw)) as ClientMessage
          const state = sessionStates.get(ws)

          if (msg.type === 'claim_start') {
            if (!state) return
            if (!claimController) {
              send(ws, {
                type: 'claim_error',
                payload: { code: msg.code, reason: 'role-claim is not enabled on this agent' },
              })
              return
            }
            if (state.unsubClaim) {
              state.unsubClaim()
              state.unsubClaim = null
            }
            const result = claimController.startClaim({
              code: msg.code,
              role: msg.role,
              ttlMs: msg.ttlMs,
              ...(msg.channel !== undefined ? { channel: msg.channel } : {}),
            })
            if (!result.ok) {
              send(ws, { type: 'claim_error', payload: { code: msg.code, reason: result.reason } })
              return
            }
            state.activeClaimCode = msg.code
            state.unsubClaim = claimController.onResult((event: ClaimResultEvent) => {
              if (event.kind === 'completed' && event.code === msg.code) {
                send(ws, {
                  type: 'claim_completed',
                  payload: {
                    code: event.code,
                    role: event.role,
                    matchRule: event.matchRule,
                    adapter: event.adapter,
                    authorId: event.authorId,
                  },
                })
              } else if (event.kind === 'error' && event.code === msg.code) {
                send(ws, { type: 'claim_error', payload: { code: event.code, reason: event.reason } })
              } else if (event.kind === 'cancelled' && event.code === msg.code) {
                send(ws, { type: 'claim_error', payload: { code: event.code, reason: 'cancelled' } })
              }
            })
            send(ws, {
              type: 'claim_started',
              payload: {
                code: msg.code,
                role: msg.role,
                ...(msg.channel !== undefined ? { channel: msg.channel } : {}),
                expiresAt: result.expiresAt,
              },
            })
            return
          }

          if (msg.type === 'claim_cancel') {
            if (!state || !claimController) return
            if (state.activeClaimCode !== null) {
              claimController.cancelClaim(state.activeClaimCode)
              state.activeClaimCode = null
            }
            if (state.unsubClaim) {
              state.unsubClaim()
              state.unsubClaim = null
            }
            return
          }

          if (msg.type === 'reload') {
            await handleReload(ws, reloadAll, reloadRegistry, msg.scope, msg.cause)
            return
          }

          if (msg.type === 'restart') {
            await handleRestart(ws, state, containerName, agentDir, stream)
            return
          }

          if (msg.type === 'doctor') {
            await handleDoctor(ws, msg.requestId, pluginRuntime, agentDir)
            return
          }

          if (msg.type === 'doctor_fix') {
            await handleDoctorFix(ws, msg.requestId, msg.checkId, pluginRuntime, agentDir)
            return
          }

          if (msg.type === 'cron_list') {
            await handleCronList(ws, msg.requestId, pluginRuntime, agentDir, getFiredCount)
            return
          }

          if (msg.type === 'tunnel_list_request') {
            handleTunnelList(ws, msg.requestId, tunnelManager)
            return
          }

          if (msg.type === 'tunnel_status_request') {
            handleTunnelStatus(ws, msg.requestId, msg.name, tunnelManager)
            return
          }

          if (msg.type === 'abort') {
            if (!state) return
            await state.session.abort()
            return
          }

          if (msg.type === 'queue_cancel') {
            if (!state) return
            const before = state.drainQueue.length
            state.drainQueue = state.drainQueue.filter((q) => q.streamMessageId !== msg.messageId)
            if (state.drainQueue.length !== before) pushQueueState(ws, state)
            return
          }

          if (msg.type === 'prompt') {
            if (!state) return
            if (stream) {
              stream.publish({
                target: { kind: 'session', sessionId: state.sessionFileId },
                payload: { kind: 'prompt', text: msg.text, delivery: msg.delivery ?? 'queue' },
                meta: { source: 'tui' },
              })
              return
            }
            send(ws, { type: 'prompt_started', messageId: `local-${crypto.randomUUID()}`, text: msg.text })
            const fallbackHooks = state.runtimeSnapshot?.hooks
            const retrievalContext: { results: string } = { results: '' }
            if (fallbackHooks !== undefined && agentDir !== undefined) {
              await fallbackHooks.runSessionTurnStart({
                sessionId: state.sessionFileId,
                agentDir,
                userPrompt: msg.text,
                origin: state.origin,
                retrievalContext,
              })
            }
            state.lastUsage = null
            try {
              const turnText =
                retrievalContext.results.length > 0
                  ? `${renderTurnTimeAnchor()}\n\n${msg.text}\n\n${retrievalContext.results}`
                  : `${renderTurnTimeAnchor()}\n\n${msg.text}`
              applyTurnThinkingLevel(state.session, msg.text, state.turnThinkingDefault, state.lastQuestionSignal)
              await promptWithSameRefRetryOnly(state.session, turnText)
              // A usable turn seeds the next turn's escalation; a failed leaf must
              // CLEAR the prior signal (not just skip), else an older question
              // leaks across the failed turn and wrongly escalates the next one.
              state.lastQuestionSignal = tuiTurnLeafFailed(state.session) ? null : getQuestionSignal(msg.text)
              send(ws, doneMessage(state))
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              logger.error(`[server] ${state.sessionFileId}: prompt failed: ${message}`)
              send(ws, { type: 'error', message })
            }
            if (fallbackHooks !== undefined && agentDir !== undefined) {
              await fallbackHooks.runSessionTurnEnd({
                sessionId: state.sessionFileId,
                agentDir,
                origin: state.origin,
              })
            }
            if (fallbackHooks !== undefined) {
              await fallbackHooks.runSessionIdle({
                sessionId: state.sessionFileId,
                parentTranscriptPath: state.sessionManager?.getSessionFile(),
                idleMs: 0,
              })
            }
            return
          }

          handleCommandFrame(ws, msg)
        },
        async close(rawWs) {
          if (rawWs.data.kind === 'portbroker') {
            containerBroker?.close(rawWs as ServerWebSocket<BrokerWsData>)
            return
          }
          if (rawWs.data.kind === 'command') {
            // Command-class connections have no AgentSession, no claim
            // state, and no broadcast subscriptions to tear down. Just
            // abort in-flight commands tied to this ws and purge the
            // callId→ws mapping so late frames don't try to route here.
            const cws = rawWs as CommandWs
            commandRunner?.abortForOwner(cws)
            for (const [callId, owner] of callIdToWs) {
              if (owner === cws) callIdToWs.delete(callId)
            }
            return
          }
          if (rawWs.data.kind === 'tunnel-logs') {
            rawWs.data.unsubscribe?.()
            rawWs.data.unsubscribe = null
            return
          }
          if (rawWs.data.kind === 'inspect') {
            const d = rawWs.data
            d.unsubAgent?.()
            d.unsubBroadcast?.()
            d.unsubCron?.()
            d.unsubAgent = null
            d.unsubBroadcast = null
            d.unsubCron = null
            return
          }
          const ws = rawWs as Ws
          const state = sessionStates.get(ws)
          state?.unsubBroadcast?.()
          state?.unsubPrompts?.()
          state?.unsubClaim?.()
          if (state?.activeClaimCode !== null && state?.activeClaimCode !== undefined && claimController) {
            claimController.cancelClaim(state.activeClaimCode)
          }
          commandRunner?.abortForOwner(ws)
          for (const [callId, owner] of callIdToWs) {
            if (owner === ws) callIdToWs.delete(callId)
          }
          try {
            if (state && state.runtimeSnapshot !== null) {
              await state.runtimeSnapshot.hooks.runSessionEnd({ sessionId: state.sessionFileId, origin: state.origin })
            }
          } finally {
            if (state) {
              state.unsubTurnOutcome?.()
              state.session.dispose()
              await state.dispose()
              liveSessionRegistry?.unregister(state.sessionFileId)
            }
            sessionStates.delete(ws)
            console.log(`session ${state?.sessionFileId ?? ws.data.sessionId}: close`)
          }
        },
      },
    })

    console.log(`typeclaw agent listening on ws://localhost:${bunServer.port}`)
    return bunServer
  }

  return { start }
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

function forwardSessionEvents(ws: Ws, state: SessionState, logger: ServerLogger, sessionFileId: string): void {
  const toolStartedAt = new Map<string, number>()

  state.session.subscribe((event) => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          send(ws, { type: 'text_delta', delta: event.assistantMessageEvent.delta })
        }
        break
      case 'message_end':
        // pi-coding-agent encodes upstream LLM failures (billing, rate limit,
        // network, malformed response, etc.) in the assistant message itself
        // rather than throwing — `stopReason: 'error'` with a populated
        // `errorMessage`. Without this branch the user sees an empty turn
        // because no text deltas were ever emitted, which looks like a freeze.
        // The server's existing try/catch around `session.prompt()` only
        // catches throws, so it never sees these.
        state.lastUsage = readDoneUsage(event.message)
        forwardAssistantError(ws, event.message, logger, sessionFileId)
        break
      case 'tool_execution_start':
        toolStartedAt.set(event.toolCallId, Date.now())
        send(ws, {
          type: 'tool_start',
          toolCallId: event.toolCallId,
          name: event.toolName,
          args: event.args,
        })
        break
      case 'tool_execution_end': {
        const startedAt = toolStartedAt.get(event.toolCallId)
        toolStartedAt.delete(event.toolCallId)
        const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt
        send(ws, {
          type: 'tool_end',
          toolCallId: event.toolCallId,
          name: event.toolName,
          error: event.isError,
          result: event.result,
          durationMs,
        })
        break
      }
    }
  })
}

// Record each completed turn's stopReason for the todo-continuation guard.
// Writes are serialized per session on `state.todoOutcomeWrite`, so an older
// outcome can never land after a newer one. Pi emits every assistant
// `message_end` before `prompt()` resolves, so by idle the turn's writes are
// all enqueued; the idle path awaits the latest tail before deciding. An
// unrecognized stopReason classifies as 'unknown', which the idle path treats
// as not-safe-to-continue (fail closed).
function subscribeTurnOutcome(state: SessionState, agentDir: string, logger: ServerLogger): Unsubscribe {
  return state.session.subscribe((event) => {
    const usage = extractTurnUsage(event)
    if (usage === null) return
    void enqueueTodoOutcomeWrite(
      state,
      {
        agentDir,
        origin: state.origin,
        turnId: state.sessionFileId,
        stopReason: usage.stopReason,
        ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
      },
      logger,
    )
  })
}

function enqueueTodoOutcomeWrite(
  state: SessionState,
  args: Parameters<typeof recordTurnOutcome>[0],
  logger: ServerLogger,
): Promise<boolean> {
  const write = state.todoOutcomeWrite.then(async () => {
    try {
      await state.todoContinuation.recordTurnOutcome(args)
      return true
    } catch (err) {
      logger.error(`[server] ${state.sessionFileId}: todo outcome capture failed: ${describeErr(err)}`)
      return false
    }
  })
  state.todoOutcomeWrite = write
  return write
}

// Resolves once the tail observed is still the latest, i.e. no write was
// chained while awaiting. Returns whether that latest write succeeded.
async function awaitLatestTodoOutcomeWrite(state: SessionState): Promise<boolean> {
  while (true) {
    const write = state.todoOutcomeWrite
    const succeeded = await write
    if (write === state.todoOutcomeWrite) return succeeded
  }
}

function forwardAssistantError(ws: Ws, message: unknown, logger: ServerLogger, sessionFileId: string): void {
  const detected = detectProviderError(message)
  if (detected === null) return
  logger.error(`[server] ${sessionFileId}: LLM call failed: ${detected.message}`)
  send(ws, { type: 'error', message: detected.message })
}

function routeSubagentCompletionReminder(state: SessionState, msg: StreamMessage, stream: Stream): void {
  const parsed = parseSubagentCompletedPayload(msg.payload)
  if (parsed === null) return
  if (parsed.parentSessionId !== state.sessionFileId) return

  // The reminder asks the agent to fetch this result now; clear the
  // subagent_output window first so an earlier premature-polling streak can't
  // hard-block that fetch. Reset before publish so the wakeup can't race stale
  // guard state.
  forgetSharedLoopGuardTool(state.sessionFileId, SUBAGENT_OUTPUT_TOOL_NAME)

  const idle = state.drainQueue.length === 0 && !state.draining
  const delivery = idle ? 'interrupt' : 'queue'
  const text = renderSubagentCompletionReminder(parsed)
  stream.publish({
    target: { kind: 'session', sessionId: state.sessionFileId },
    payload: { kind: 'prompt', text, delivery },
    meta: { source: 'subagent-completion' },
  })
}

function enqueuePrompt(
  ws: Ws,
  state: SessionState,
  msg: StreamMessage,
  agentDir: string | undefined,
  logger: ServerLogger,
  stream: Stream | undefined,
): void {
  const payload = msg.payload as { kind?: string; text?: string; delivery?: PromptDelivery }
  if (payload?.kind !== 'prompt' || typeof payload.text !== 'string') return
  const delivery: PromptDelivery = payload.delivery ?? 'queue'
  if (delivery === 'interrupt') {
    void state.session.abort().catch((err) => {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }
  const source = (msg.meta as { source?: unknown } | undefined)?.source
  state.drainQueue.push({
    streamMessageId: msg.id,
    text: payload.text,
    delivery,
    ts: msg.ts,
    ...(typeof source === 'string' ? { source } : {}),
  })
  pushQueueState(ws, state)
  void drain(ws, state, agentDir, logger, stream)
}

// `session.idle` semantically means "the agent finished a prompt and is now
// awaiting next input". Plugins (notably the bundled memory plugin) own any
// debouncing on top of this signal. Core fires the hook synchronously after
// every `prompt()` completion (success or error), passing the current
// transcript path so plugins can spawn subagents that read it.
function makeIdleHookCaller(state: SessionState): () => Promise<void> {
  const hooks: HookBus | undefined = state.runtimeSnapshot?.hooks
  if (hooks === undefined) return async () => {}
  return async () => {
    await hooks.runSessionIdle({
      sessionId: state.sessionFileId,
      parentTranscriptPath: state.sessionManager?.getSessionFile(),
      idleMs: 0,
      origin: state.origin,
    })
  }
}

function makeTurnHookCallers(
  state: SessionState,
  agentDir: string | undefined,
): { fireTurnStart: (userPrompt: string) => Promise<{ results: string }>; fireTurnEnd: () => Promise<void> } {
  const hooks: HookBus | undefined = state.runtimeSnapshot?.hooks
  if (hooks === undefined || agentDir === undefined) {
    return { fireTurnStart: async () => ({ results: '' }), fireTurnEnd: async () => {} }
  }
  const turnEndEvent = { sessionId: state.sessionFileId, agentDir, origin: state.origin }
  return {
    fireTurnStart: async (userPrompt) => {
      const retrievalContext = { results: '' }
      await hooks.runSessionTurnStart({
        sessionId: state.sessionFileId,
        agentDir,
        userPrompt,
        origin: state.origin,
        retrievalContext,
      })
      return retrievalContext
    },
    fireTurnEnd: () => hooks.runSessionTurnEnd(turnEndEvent),
  }
}

async function drain(
  ws: Ws,
  state: SessionState,
  agentDir: string | undefined,
  logger: ServerLogger,
  stream: Stream | undefined,
): Promise<void> {
  if (state.draining) return
  state.draining = true
  const fireIdle = makeIdleHookCaller(state)
  const { fireTurnStart, fireTurnEnd } = makeTurnHookCallers(state, agentDir)
  try {
    while (state.drainQueue.length > 0) {
      const item = state.drainQueue.shift()
      if (!item) break
      pushQueueState(ws, state)
      send(ws, { type: 'prompt_started', messageId: item.streamMessageId, text: item.text })

      if (agentDir !== undefined) {
        // recordTurnStart is a read-modify-write of the same state file; let
        // pending outcome writes land first so neither overwrites the other.
        await awaitLatestTodoOutcomeWrite(state)
        await recordTurnStart({
          agentDir,
          origin: state.origin,
          isRealUserTurn: item.source !== TODO_CONTINUATION_SOURCE,
        }).catch((err) => logger.error(`[server] ${state.sessionFileId}: todo turn-start failed: ${describeErr(err)}`))
      }

      const retrievalContext = await fireTurnStart(item.text)
      state.lastUsage = null
      try {
        const turnText =
          retrievalContext.results.length > 0
            ? `${renderTurnTimeAnchor()}\n\n${item.text}\n\n${retrievalContext.results}`
            : `${renderTurnTimeAnchor()}\n\n${item.text}`
        applyTurnThinkingLevel(state.session, item.text, state.turnThinkingDefault, state.lastQuestionSignal)
        const result = await promptPersistentTurnWithFallback({
          refs: resolveFallbackChain(getConfig().models, undefined),
          currentModelRef: state.activeModelRef,
          session: state.session,
          text: turnText,
          shouldFailover: (err) => isFailoverWorthy(err.message),
          setModelForRef: async (ref) => {
            await state.session.setModel(applyModelRuntimeOverrides(resolveModel(ref), ref))
            state.activeModelRef = ref
          },
          beforeAttempt: () => {
            applyTurnThinkingLevel(state.session, item.text, state.turnThinkingDefault, state.lastQuestionSignal)
          },
          onAttemptFailed: (attempt) => {
            logger.warn(
              `[server] ${state.sessionFileId}: ${attempt.outcome} failure on ${attempt.ref}: ${attempt.errorMessage ?? 'unknown'}; falling back`,
            )
          },
        })
        if (result.success) state.activeModelRef = result.refUsed
        // Only real user turns move the signal: a usable turn seeds it, a failed
        // leaf CLEARS it (else an older question leaks across the failed turn).
        // Todo-continuation turns are not user turns, so they leave it untouched.
        if (item.source !== TODO_CONTINUATION_SOURCE) {
          state.lastQuestionSignal = tuiTurnLeafFailed(state.session) ? null : getQuestionSignal(item.text)
        }
        send(ws, doneMessage(state))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`[server] ${state.sessionFileId}: prompt failed: ${message}`)
        send(ws, { type: 'error', message })
      }
      await fireTurnEnd()
      await fireIdle()

      // Idle-continuation runs INSIDE the loop and enqueues directly onto
      // drainQueue (not via stream.publish). Publishing would re-enter drain()
      // through the session subscriber while `state.draining` is still true, so
      // the nested call would no-op and the continuation would stall until some
      // unrelated event woke the loop again. Enqueuing here lets the same `while`
      // consume it on the next iteration. Only fires when the queue is otherwise
      // empty so a real user turn is never preempted by a continuation; the
      // queue is re-checked after awaiting this turn's outcome writes because a
      // user prompt can arrive meanwhile. A failed latest outcome write fails
      // closed: the stored outcome may be a stale earlier turn's.
      if (state.drainQueue.length === 0) {
        if (!(await awaitLatestTodoOutcomeWrite(state))) {
          logger.warn(`[server] ${state.sessionFileId}: skipping todo continuation after failed outcome write`)
        } else if (state.drainQueue.length === 0) {
          await maybeContinueTodos(state, agentDir, logger)
        }
      }
    }
  } finally {
    state.draining = false
  }
}

// If incomplete todos remain and all guards pass, push a single continuation
// prompt directly onto this session's drainQueue, tagged TODO_CONTINUATION_SOURCE
// so the next drain iteration treats it as an injected (non-user) turn that does
// not reset the episode budget. The enclosing drain loop consumes it; this never
// calls drain() itself. The decision joins the outcome-write chain so a
// concurrent abort's outcome write is ordered after the decision's own state
// write instead of racing it.
async function maybeContinueTodos(
  state: SessionState,
  agentDir: string | undefined,
  logger: ServerLogger,
): Promise<void> {
  if (agentDir === undefined) return
  const decision = state.todoOutcomeWrite.then(async () => {
    try {
      await state.todoContinuation.runIdleContinuation({
        agentDir,
        origin: state.origin,
        deliver: (text) => {
          state.drainQueue.push({
            streamMessageId: `todo-continuation-${crypto.randomUUID()}` as StreamMessageId,
            text,
            delivery: 'queue',
            ts: Date.now(),
            source: TODO_CONTINUATION_SOURCE,
          })
        },
      })
    } catch (err) {
      logger.error(`[server] ${state.sessionFileId}: todo continuation failed: ${describeErr(err)}`)
    }
    return true
  })
  state.todoOutcomeWrite = decision
  await decision
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function pushQueueState(ws: Ws, state: SessionState): void {
  const pending: QueueStateItem[] = state.drainQueue.map((q) => ({
    id: q.streamMessageId,
    text: q.text,
    ts: q.ts,
  }))
  send(ws, { type: 'queue_state', pending })
}

async function handleDoctor(
  ws: Ws,
  requestId: string,
  pluginRuntime: PluginRuntime | undefined,
  agentDir: string | undefined,
): Promise<void> {
  if (pluginRuntime === undefined || agentDir === undefined) {
    send(ws, { type: 'doctor_result', requestId, checks: [] })
    return
  }
  const snapshot = pluginRuntime.get()
  if (snapshot === undefined) {
    send(ws, { type: 'doctor_result', requestId, checks: [] })
    return
  }
  try {
    const checks = await runPluginDoctorChecks({ registry: snapshot.registry, agentDir })
    send(ws, { type: 'doctor_result', requestId, checks })
  } catch (err) {
    send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

async function handleDoctorFix(
  ws: Ws,
  requestId: string,
  checkId: string,
  pluginRuntime: PluginRuntime | undefined,
  agentDir: string | undefined,
): Promise<void> {
  if (pluginRuntime === undefined || agentDir === undefined) {
    send(ws, {
      type: 'doctor_fix_result',
      requestId,
      result: { ok: false, checkId, error: 'plugin runtime not configured' },
    })
    return
  }
  const snapshot = pluginRuntime.get()
  if (snapshot === undefined) {
    send(ws, {
      type: 'doctor_fix_result',
      requestId,
      result: { ok: false, checkId, error: 'plugin runtime not configured' },
    })
    return
  }
  const outcome = await runPluginDoctorFix({ registry: snapshot.registry, agentDir, checkId })
  const result =
    outcome.ok === true
      ? { ok: true as const, checkId, summary: outcome.summary, changedPaths: outcome.changedPaths }
      : { ok: false as const, checkId, error: outcome.error }
  send(ws, { type: 'doctor_fix_result', requestId, result })
}

async function handleCronList(
  ws: Ws,
  requestId: string,
  pluginRuntime: PluginRuntime | undefined,
  agentDir: string | undefined,
  getFiredCount?: (job: CronJob) => number,
): Promise<void> {
  if (agentDir === undefined) {
    send(ws, { type: 'cron_list_result', requestId, result: { ok: false, reason: 'agentDir not configured' } })
    return
  }
  try {
    // Snapshot the runtime once so subagent validation and the plugin
    // cron-job list see the same generation, the way TUI sessions do.
    // Without one snapshot, a reload landing mid-request can show user
    // jobs validated against an old subagent registry alongside plugin
    // jobs from a newer registry.
    const snapshot = pluginRuntime?.get()
    const loadResult = await loadCron(agentDir, {
      ...(snapshot !== undefined ? { subagents: snapshot.subagents } : {}),
    })
    if (!loadResult.ok) {
      send(ws, { type: 'cron_list_result', requestId, result: { ok: false, reason: loadResult.reason } })
      return
    }
    const userJobs = loadResult.file?.jobs ?? []
    const pluginJobs = snapshot?.registry.cronJobs ?? []
    const nowMs = Date.now()
    const entries = aggregateCronList({
      userJobs,
      pluginJobs,
      now: nowMs,
      ...(getFiredCount !== undefined ? { firedCount: getFiredCount } : {}),
    })
    send(ws, {
      type: 'cron_list_result',
      requestId,
      result: { ok: true, jobs: entries.map(toPayload), nowMs },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    send(ws, { type: 'cron_list_result', requestId, result: { ok: false, reason } })
  }
}

function handleTunnelList(ws: Ws, requestId: string, tunnelManager: TunnelManager | undefined): void {
  if (tunnelManager === undefined) {
    send(ws, { type: 'tunnel_list_response', requestId, ok: false, error: 'tunnel manager not configured' })
    return
  }
  send(ws, { type: 'tunnel_list_response', requestId, ok: true, tunnels: toTunnelSnapshots(tunnelManager.snapshot()) })
}

function handleTunnelStatus(ws: Ws, requestId: string, name: string, tunnelManager: TunnelManager | undefined): void {
  if (tunnelManager === undefined) {
    send(ws, { type: 'tunnel_status_response', requestId, ok: false, error: 'tunnel manager not configured' })
    return
  }
  const tunnel = toTunnelSnapshots(tunnelManager.snapshot()).find((entry) => entry.name === name)
  if (tunnel === undefined) {
    send(ws, { type: 'tunnel_status_response', requestId, ok: false, error: `unknown tunnel: ${name}` })
    return
  }
  send(ws, { type: 'tunnel_status_response', requestId, ok: true, tunnel })
}

function handleInspectMessage(
  ws: InspectWs,
  raw: string | Buffer,
  liveSessionRegistry: LiveSessionRegistry | undefined,
  stream: Stream | undefined,
): void {
  let msg: InspectClientMessage
  try {
    msg = JSON.parse(String(raw)) as InspectClientMessage
  } catch {
    sendInspect(ws, { type: 'error', message: 'invalid JSON' })
    ws.close()
    return
  }
  if (msg.type === 'ping') {
    sendInspect(ws, { type: 'pong', id: msg.id })
    return
  }
  if (msg.type === 'list_live') {
    const sessions = (liveSessionRegistry?.listLive() ?? []).map((e) => ({
      sessionId: e.sessionId,
      origin: e.origin!,
      registeredAtMs: e.registeredAtMs ?? 0,
    }))
    sendInspect(ws, { type: 'live_sessions', sessions })
    return
  }
  if (msg.type !== 'subscribe' || typeof msg.sessionId !== 'string' || msg.sessionId === '') {
    sendInspect(ws, { type: 'error', message: 'invalid inspect subscription' })
    ws.close()
    return
  }

  ws.data.unsubAgent?.()
  ws.data.unsubBroadcast?.()
  ws.data.unsubCron?.()

  if (stream !== undefined && typeof msg.sinceMs === 'number') {
    for (const event of stream.scan({ sinceTs: msg.sinceMs, target: { kind: 'broadcast' } })) {
      const payload = broadcastEventToFrame(event)
      if (!isFrameForWatchedSession(payload, msg.sessionId)) continue
      sendInspect(ws, { type: 'frame', ts: event.ts, payload })
    }
    for (const event of stream.scan({ sinceTs: msg.sinceMs, target: { kind: 'cron' } })) {
      sendInspect(ws, {
        type: 'frame',
        ts: event.ts,
        payload: { kind: 'cron-fire', jobId: extractJobId(event.target), payload: event.payload },
      })
    }
  }

  const live = liveSessionRegistry?.get(msg.sessionId)
  if (live !== undefined) {
    const sessionId = msg.sessionId
    const startedAtByCallId = new Map<string, number>()
    ws.data.unsubAgent = live.session.subscribe((event: unknown) => {
      forwardAgentEventToInspect(ws, event, sessionId, startedAtByCallId)
    })
  }

  if (stream !== undefined) {
    ws.data.unsubBroadcast = stream.subscribe({ target: { kind: 'broadcast' } }, (event) => {
      const payload = broadcastEventToFrame(event)
      if (!isFrameForWatchedSession(payload, msg.sessionId)) return
      sendInspect(ws, { type: 'frame', ts: event.ts, payload })
    })
    ws.data.unsubCron = stream.subscribe({ target: { kind: 'cron' } }, (event) => {
      sendInspect(ws, {
        type: 'frame',
        ts: event.ts,
        payload: { kind: 'cron-fire', jobId: extractJobId(event.target), payload: event.payload },
      })
    })
  }

  sendInspect(ws, { type: 'subscribed', sessionId: msg.sessionId, sessionLive: live !== undefined, supportsPing: true })
}

function extractJobId(target: StreamMessage['target']): string {
  return target.kind === 'cron' ? target.jobId : ''
}

function broadcastEventToFrame(event: StreamMessage): InspectFramePayload {
  const inbound = readChannelInboundBroadcast(event.payload)
  if (inbound !== null) return inbound
  return {
    kind: 'broadcast',
    payload: event.payload,
    ...(event.meta !== undefined ? { meta: event.meta } : {}),
  }
}

// Channel inbounds are published as global broadcasts, so every inspect client
// receives every session's inbounds. Drop the ones that don't belong to the
// session being watched. Non-inbound broadcasts (subagent completions, cron,
// tunnels) stay global — they carry no session identity here.
function isFrameForWatchedSession(payload: InspectFramePayload, watchedSessionId: string): boolean {
  if (payload.kind !== 'channel_inbound') return true
  return payload.sessionId === watchedSessionId
}

function readChannelInboundBroadcast(payload: unknown): InspectFramePayload | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (p.kind !== 'channel-inbound') return null
  if (typeof p.adapter !== 'string') return null
  if (typeof p.workspace !== 'string') return null
  if (typeof p.chat !== 'string') return null
  if (!(p.thread === null || typeof p.thread === 'string')) return null
  if (typeof p.authorId !== 'string') return null
  if (typeof p.authorName !== 'string') return null
  if (typeof p.authorIsBot !== 'boolean') return null
  if (typeof p.isDm !== 'boolean') return null
  if (typeof p.isBotMention !== 'boolean') return null
  if (typeof p.text !== 'string') return null
  if (typeof p.externalMessageId !== 'string') return null
  if (typeof p.ts !== 'number') return null
  const decision = p.decision
  if (decision !== 'engage' && decision !== 'observe' && decision !== 'denied' && decision !== 'claim') return null
  return {
    kind: 'channel_inbound',
    ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
    adapter: p.adapter,
    workspace: p.workspace,
    chat: p.chat,
    thread: p.thread,
    authorId: p.authorId,
    authorName: p.authorName,
    authorIsBot: p.authorIsBot,
    isDm: p.isDm,
    isBotMention: p.isBotMention,
    text: p.text,
    externalMessageId: p.externalMessageId,
    ts: p.ts,
    decision,
  }
}

function forwardAgentEventToInspect(
  ws: InspectWs,
  event: unknown,
  sessionId: string,
  startedAtByCallId: Map<string, number>,
): void {
  if (typeof event !== 'object' || event === null) return
  const e = event as { type?: unknown }
  const now = Date.now()
  if (e.type === 'message_update') {
    const ev = event as { assistantMessageEvent?: { type?: unknown; delta?: unknown; content?: unknown } }
    const ame = ev.assistantMessageEvent
    if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
      sendInspect(ws, { type: 'frame', ts: now, payload: { kind: 'text_delta', sessionId, delta: ame.delta } })
      return
    }
    if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
      sendInspect(ws, { type: 'frame', ts: now, payload: { kind: 'thinking_delta', sessionId, delta: ame.delta } })
      return
    }
    if (ame?.type === 'thinking_end') {
      const text = typeof ame.content === 'string' ? ame.content : ''
      sendInspect(ws, { type: 'frame', ts: now, payload: { kind: 'thinking_end', sessionId, text } })
      return
    }
    return
  }
  if (e.type === 'tool_execution_start') {
    const ev = event as { toolCallId?: unknown; toolName?: unknown; args?: unknown }
    if (typeof ev.toolCallId !== 'string' || typeof ev.toolName !== 'string') return
    startedAtByCallId.set(ev.toolCallId, now)
    sendInspect(ws, {
      type: 'frame',
      ts: now,
      payload: { kind: 'tool_start', sessionId, toolCallId: ev.toolCallId, name: ev.toolName, args: ev.args },
    })
    return
  }
  if (e.type === 'tool_execution_end') {
    const ev = event as { toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown }
    if (typeof ev.toolCallId !== 'string' || typeof ev.toolName !== 'string') return
    const startedAt = startedAtByCallId.get(ev.toolCallId)
    startedAtByCallId.delete(ev.toolCallId)
    const durationMs = startedAt === undefined ? 0 : now - startedAt
    sendInspect(ws, {
      type: 'frame',
      ts: now,
      payload: {
        kind: 'tool_end',
        sessionId,
        toolCallId: ev.toolCallId,
        name: ev.toolName,
        result: ev.result,
        isError: ev.isError === true,
        durationMs,
      },
    })
    return
  }
  if (e.type === 'message_end') {
    const ev = event as { message?: unknown }
    const payload = buildMessageEndPayload(sessionId, ev.message)
    if (payload !== null) sendInspect(ws, { type: 'frame', ts: now, payload })
    return
  }
}

function buildMessageEndPayload(sessionId: string, message: unknown): InspectFramePayload | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>
  if (typeof m.role !== 'string') return null
  const usage = readMessageUsage(m.usage)
  const payload: InspectFramePayload = {
    kind: 'message_end',
    sessionId,
    role: m.role,
    content: m.content,
    ...(typeof m.provider === 'string' ? { provider: m.provider } : {}),
    ...(typeof m.model === 'string' ? { model: m.model } : {}),
    ...(typeof m.stopReason === 'string' ? { stopReason: m.stopReason } : {}),
    ...(typeof m.errorMessage === 'string' ? { errorMessage: m.errorMessage } : {}),
    ...(usage !== null ? { usage } : {}),
  }
  return payload
}

function doneMessage(state: SessionState): ServerMessage {
  return state.lastUsage === null ? { type: 'done' } : { type: 'done', usage: state.lastUsage }
}

function readDoneUsage(message: unknown): { input: number; output: number; totalTokens: number; cost: number } | null {
  if (typeof message !== 'object' || message === null) return null
  const usage = readMessageUsage((message as Record<string, unknown>).usage)
  if (usage === null) return null
  return { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: usage.cost }
}

function readMessageUsage(
  value: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const u = value as Record<string, unknown>
  const cost = u.cost as Record<string, unknown> | undefined
  const numberOr = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input: numberOr(u.input),
    output: numberOr(u.output),
    cacheRead: numberOr(u.cacheRead),
    cacheWrite: numberOr(u.cacheWrite),
    totalTokens: numberOr(u.totalTokens),
    cost: numberOr(cost?.total),
  }
}

function handleTunnelLogsMessage(
  ws: TunnelLogsWs,
  raw: string | Buffer,
  tunnelManager: TunnelManager | undefined,
): void {
  let msg: TunnelLogsClientMessage
  try {
    msg = JSON.parse(String(raw)) as TunnelLogsClientMessage
  } catch {
    sendTunnelLog(ws, { type: 'error', message: 'invalid JSON' })
    sendTunnelLog(ws, { type: 'end' })
    ws.close()
    return
  }
  if (msg.type !== 'subscribe' || typeof msg.name !== 'string' || typeof msg.follow !== 'boolean') {
    sendTunnelLog(ws, { type: 'error', message: 'invalid tunnel log subscription' })
    sendTunnelLog(ws, { type: 'end' })
    ws.close()
    return
  }
  if (tunnelManager === undefined || !tunnelManager.snapshot().some((entry) => entry.name === msg.name)) {
    sendTunnelLog(ws, { type: 'error', message: `unknown tunnel: ${msg.name}` })
    sendTunnelLog(ws, { type: 'end' })
    ws.close()
    return
  }

  sendTunnelLog(ws, { type: 'snapshot', lines: tunnelManager.tail(msg.name) })
  if (!msg.follow) {
    sendTunnelLog(ws, { type: 'end' })
    ws.close()
    return
  }
  ws.data.unsubscribe?.()
  ws.data.unsubscribe = tunnelManager.subscribeToLogs(msg.name, (line) => {
    sendTunnelLog(ws, { type: 'line', line })
  })
}

function toTunnelSnapshots(states: ReturnType<TunnelManager['snapshot']>): TunnelSnapshot[] {
  return states.map((state) => ({
    name: state.name,
    provider: state.provider,
    for: state.for,
    url: state.url,
    status: state.status,
    lastUrlAt: state.lastUrlAt,
    detail: state.detail,
  }))
}

function toPayload(entry: CronListEntry): CronListEntryPayload {
  const source: CronListSourcePayload =
    entry.source.kind === 'plugin'
      ? { kind: 'plugin', pluginName: entry.source.pluginName, localId: entry.source.localId }
      : { kind: 'user' }
  return {
    id: entry.id,
    source,
    kind: entry.kind,
    enabled: entry.enabled,
    nextFireMs: entry.nextFireMs,
    ...(entry.schedule !== undefined ? { schedule: entry.schedule } : {}),
    ...(entry.at !== undefined ? { at: entry.at } : {}),
    ...(entry.until !== undefined ? { until: entry.until } : {}),
    ...(entry.count !== undefined ? { count: entry.count } : {}),
    ...(entry.timezone !== undefined ? { timezone: entry.timezone } : {}),
    ...(entry.scheduledByRole !== undefined ? { scheduledByRole: entry.scheduledByRole } : {}),
    ...(entry.scheduleError !== undefined ? { scheduleError: entry.scheduleError } : {}),
    ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
    ...(entry.subagent !== undefined ? { subagent: entry.subagent } : {}),
    ...(entry.command !== undefined ? { command: entry.command } : {}),
  }
}

async function handleReload(
  ws: Ws,
  reloadAll: ReloadAllFn | undefined,
  reloadRegistry: ReloadRegistry | undefined,
  scope: string | undefined,
  cause: ReloadCause | undefined,
): Promise<void> {
  const context = cause === undefined ? undefined : { cause }
  if (scope !== undefined && scope.length > 0) {
    if (!reloadRegistry) {
      send(ws, {
        type: 'reload_result',
        results: [{ scope, ok: false, reason: 'no reload registry configured' }],
      })
      return
    }
    try {
      const result = await reloadRegistry.reloadOne(scope, context)
      send(ws, { type: 'reload_result', results: [result] })
    } catch (err) {
      send(ws, {
        type: 'reload_result',
        results: [{ scope, ok: false, reason: err instanceof Error ? err.message : String(err) }],
      })
    }
    return
  }

  if (!reloadAll) {
    const empty: ReloadResultPayload[] = []
    send(ws, { type: 'reload_result', results: empty })
    return
  }
  try {
    const { results } = await reloadAll(context)
    send(ws, { type: 'reload_result', results })
  } catch (err) {
    send(ws, {
      type: 'reload_result',
      results: [{ scope: 'reload', ok: false, reason: err instanceof Error ? err.message : String(err) }],
    })
  }
}

async function handleRestart(
  ws: Ws,
  state: SessionState | undefined,
  containerName: string | undefined,
  agentDir: string | undefined,
  stream: Stream | undefined,
): Promise<void> {
  if (containerName === undefined) {
    send(ws, {
      type: 'restart_result',
      status: 'failed',
      error: 'restart unavailable: no container name configured',
    })
    return
  }

  // Pass stream so requestContainerRestart fans out the container-restarting
  // notice — the originating session's subscribeRestartNotice appends the
  // typeclaw.restart-self entry to its JSONL before the handoff is written, so
  // the rebooted container resumes with the "I'm back" instruction (same path
  // the agent restart tool uses).
  const originatingSessionFile = state?.sessionManager?.getSessionFile()
  const result = await requestContainerRestart({
    containerName,
    ...(agentDir !== undefined ? { agentDir } : {}),
    ...(state?.sessionFileId !== undefined ? { originatingSessionId: state.sessionFileId } : {}),
    ...(originatingSessionFile !== undefined ? { originatingSessionFile } : {}),
    ...(stream !== undefined ? { stream } : {}),
  })
  if (!result.ok) {
    send(ws, { type: 'restart_result', status: 'failed', error: result.reason })
    return
  }

  // hostd's supervisor ACKs first, then runs stop+start in the background;
  // this process should not self-exit or it could race the daemon-owned stop.
  send(ws, {
    type: 'restart_result',
    status: 'accepted',
    message: 'restart scheduled; reconnecting when the new container is up',
  })
}
