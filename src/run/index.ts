import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createSession, createSessionWithDispose } from '@/agent'
import { createProviderAuthReloadable } from '@/agent/auth-reloadable'
import { LiveSessionRegistry } from '@/agent/live-sessions'
import { LiveSubagentRegistry, newestRunningBackgroundChildStartedAt } from '@/agent/live-subagents'
import { requestContainerRestart } from '@/agent/restart'
import { sessionMetaPayload } from '@/agent/session-meta'
import type { SessionOrigin } from '@/agent/session-origin'
import {
  awaitWithSubagentTimeout,
  createSubagentConsumer,
  defaultCreateSessionForSubagent,
  invokeSubagent,
  isSubagentTimeoutError,
  resolveSubagentProfile,
  SubagentCoalescer,
  type Subagent as InternalSubagent,
  type SubagentConsumer,
  type SubagentRegistry,
  type SubagentShared,
} from '@/agent/subagents'
import { clearTodosForOrigin, markRestartAbortPendingForOrigin } from '@/agent/todo/continuation-wiring'
import { embed, warmEmbedder } from '@/bundled-plugins/memory/vector/embedder'
import { buildStartupVectorIndex } from '@/bundled-plugins/memory/vector/startup'
import { resolveCapOptionsFromConfig } from '@/bundled-plugins/tool-result-cap'
import { createRuntimeCapabilities, type RuntimeCapabilities } from '@/capabilities'
import {
  createChannelManager,
  createChannelsReloadable,
  createGithubTokenBridge,
  createPrVerdictActivityBridge,
  createSubagentCompletionBridge,
  setReviewCoverageCapture,
  setReviewObserver,
  setReviewOutputObserver,
  type ChannelManager,
  type PrVerdictActivityBridge,
  type SubagentCompletionBridge,
} from '@/channels'
import { LegacyBackgroundHandoffReader } from '@/channels/background-handoff'
import { BackgroundObligationStore } from '@/channels/background-obligations'
import { InboundJournal } from '@/channels/inbound-journal'
import { RecoveryDispatcher } from '@/channels/recovery-dispatcher'
import { RecoveryOutbox } from '@/channels/recovery-outbox'
import { createTunnelBridge, type TunnelBridge } from '@/channels/tunnel-bridge'
import { createConfigReloadable, getConfig, loadConfigBundleSync, reloadConfig, withDefaultPlugins } from '@/config'
import {
  type CountStore,
  type CronConsumer,
  type CronJob,
  type CronFile,
  createCountStore,
  createCronConsumer,
  createCronReloadable,
  createScheduler,
  type LoadCronResult,
  loadCron as loadCronDefault,
  type ParseCronMode,
  type Scheduler,
} from '@/cron'
import { logDependencyBinProblems, registerDependencyBinDoctorCheck, validateDependencyBins } from '@/dependencies'
import { CLI_VERSION } from '@/init/cli-version'
import { createMcpManager, resolveContainerMcpOAuthStore, TypeClawMcpOAuthProvider } from '@/mcp'
import { runStartupMigrations } from '@/migrations'
import { loadPlugins, type LoadPluginsResult, pluginCronJobs, type PluginRegistry, summarizeLoaded } from '@/plugin'
import { createPluginLogger } from '@/plugin/context'
import type { CronHandlerContext } from '@/plugin/types'
import { createContainerBroker, publishForwardResult, subscribeForwardRequest } from '@/portbroker'
import { formatChannelReloadSummary, ReloadRegistry, type ReloadAllResult, type ReloadContext } from '@/reload'
import { createClaimController } from '@/role-claim'
import {
  exportClaudeCredentialsFileForAgent,
  exportCodexAuthFileForAgent,
  exportGithubCliStoreForAgent,
  hydrateChannelEnvFromSecrets,
  refreshProviderOAuthForAgent,
} from '@/secrets'
import { createServer, type Server } from '@/server'
import {
  createCommandRunner,
  type CommandRunner,
  type CommandSpawnSubagent,
  runExecForCommand,
  runPromptForCommand,
} from '@/server/command-runner'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import { createStream, type Stream } from '@/stream'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'
import { createTunnelManager, type TunnelManager, type TunnelManagerOptions } from '@/tunnels'

import { bootChannelRestartGreeting, bootBackgroundObligations } from './background-handoff-boot'
import { BUNDLED_PLUGINS } from './bundled-plugins'
import { buildChannelSessionFactory } from './channel-session-factory'
import { installFatalGuard } from './fatal-guard'
import { installLlmFetchObserver } from './llm-fetch-observer'
import { createPluginRuntime, type PluginRuntime, type PluginSubagentEntry } from './plugin-runtime'
import { logResourceReport } from './resource-report'
import { startResourceSampler } from './resource-sample'
import { acquireSubagentCoalesceLease } from './subagent-coalescing'

type BunServer = ReturnType<Server['start']>

export type TuiFactory = (options: TuiOptions) => { run: () => Promise<unknown> }

export type LoadCronFn = (
  agentDir: string,
  options?: { subagents?: SubagentRegistry; mode?: ParseCronMode },
) => Promise<LoadCronResult>
export type SchedulerFactory = (options: {
  cwd: string
  file: CronFile
  onFire: (job: CronJob) => void
  onCountStore?: (store: CountStore) => void
}) => Scheduler | Promise<Scheduler>
export type ChannelManagerFactory = typeof createChannelManager
export type TunnelManagerFactory = (options: TunnelManagerOptions) => TunnelManager

export type StartAgentOptions = {
  port: number
  attachTui: boolean
  initialPrompt?: string
  cwd?: string
  createTui?: TuiFactory
  loadCron?: LoadCronFn
  createSchedulerFor?: SchedulerFactory
  sessionFactory?: SessionFactory
  stream?: Stream
  createChannelManager?: ChannelManagerFactory
  createTunnelManager?: TunnelManagerFactory
  // The container-stage capability bag. Defaults to createRuntimeCapabilities()
  // over the real env + <cwd>/secrets.json. Injectable so tests can supply a
  // fake secrets provider without touching process.env.
  caps?: RuntimeCapabilities
  // Boot credential exporters are injectable so ordering tests can prove they
  // observe secrets only after the awaited provider-OAuth refresh settles.
  exportCodexAuthFile?: typeof exportCodexAuthFileForAgent
  exportClaudeCredentialsFile?: typeof exportClaudeCredentialsFileForAgent
  exportGithubCliStore?: typeof exportGithubCliStoreForAgent
  // Boot-time proactive provider-OAuth refresh. Injectable so a test can supply
  // a refresh that holds the real secrets lock on a gate, proving the boot
  // barrier settles this before any session-producing consumer starts.
  refreshProviderOAuth?: (options: { agentDir: string; log: (message: string) => void }) => Promise<unknown>
  // Injectable so a test can prove the sampler's disposer is wired into BOTH
  // teardown paths without waiting out a real sampling interval.
  startResourceSampler?: () => () => void
}

export type StartAgentResult = {
  server: BunServer
  tuiPromise: Promise<unknown> | null
  scheduler: Scheduler | null
  cronConsumer: CronConsumer | null
  subagentConsumer: SubagentConsumer
  reloadRegistry: ReloadRegistry
  stream: Stream
  pluginRuntime: PluginRuntime
  loadedPlugins: LoadPluginsResult['loadedPlugins']
  channelManager: ChannelManager
  stop: () => void | Promise<void>
}

// Owns boot-failure cleanup for everything installed before `startAgentRuntime`
// returns a `StartAgentResult`. `installLlmFetchObserver`/`installFatalGuard`
// attach process-wide listeners, and `loadPlugins` opens plugin-lifetime
// resources (the memory plugin's sqlite handle); if any boot step throws before
// the result exists, the caller never receives `stop()`, so each of those would
// strand. The runtime registers each cleanup via `registerBootCleanup` as boot
// progresses; on a throw we run them all (newest first, best-effort) and
// rethrow, on success ownership transfers to the returned `stop()`. `return
// await` is load-bearing — without it an async boot rejection would escape this
// try. Cleanups are idempotent, so the success path's `stop()` never double-fires.
export async function startAgent(options: StartAgentOptions): Promise<StartAgentResult> {
  const bootCleanups: Array<() => void | Promise<void>> = []
  try {
    return await startAgentRuntime(options, (cleanup) => {
      bootCleanups.push(cleanup)
    })
  } catch (err) {
    for (const cleanup of bootCleanups.reverse()) {
      try {
        await cleanup()
      } catch (cleanupErr) {
        console.warn(
          `[run] boot-failure cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
        )
      }
    }
    throw err
  }
}

async function startAgentRuntime(
  {
    port,
    attachTui,
    initialPrompt,
    cwd = process.cwd(),
    createTui = createTuiDefault,
    loadCron = loadCronDefault,
    createSchedulerFor,
    sessionFactory = createSessionFactory({ agentDir: cwd }),
    stream = createStream(),
    createChannelManager: createChannelManagerFor = createChannelManager,
    createTunnelManager: createTunnelManagerFor = createTunnelManager,
    caps = createRuntimeCapabilities(process.env, join(cwd, 'secrets.json')),
    exportCodexAuthFile = exportCodexAuthFileForAgent,
    exportClaudeCredentialsFile = exportClaudeCredentialsFileForAgent,
    exportGithubCliStore = exportGithubCliStoreForAgent,
    refreshProviderOAuth = refreshProviderOAuthForAgent,
    startResourceSampler: startResourceSamplerFor = startResourceSampler,
  }: StartAgentOptions,
  registerBootCleanup: (cleanup: () => void | Promise<void>) => void,
): Promise<StartAgentResult> {
  const reloadRegistry = new ReloadRegistry()

  const reloadAllNonDestructive = async (context?: ReloadContext): Promise<ReloadAllResult> => {
    const results = []
    for (const item of reloadRegistry.list()) {
      if (item.scope === 'providers') continue
      results.push(await reloadRegistry.reloadOne(item.scope, context))
    }
    return { results }
  }

  // Wrap globalThis.fetch BEFORE any plugin/session/manager construction so
  // every LLM provider stream from anywhere in the container is guarded. Logs
  // one `[llm-fetch]` line per matched request with phase timings and applies
  // TTFB/idle/overall deadlines that abort a stalled stream — turning a silent
  // infinite hang (e.g. a rate-limited proxy holding the SSE connection open
  // with zero bytes) into a retryable error the fallback path can surface.
  // Covers Codex, Anthropic (`/v1/messages`), and OpenAI-compatible endpoints
  // regardless of host, since base URLs are user-configured. Opt out with
  // TYPECLAW_LLM_FETCH_OBSERVER=off.
  const uninstallLlmFetchObserver = installLlmFetchObserver()

  // The host CLI sets TYPECLAW_CONTAINER_NAME when it `docker run`s us. When
  // running outside a typeclaw container (tests, ad-hoc `bun run typeclaw run`
  // outside docker), the env var is absent and the `restart` tool is omitted —
  // which is what we want, since there is no host daemon to honor it anyway.
  const containerName = process.env.TYPECLAW_CONTAINER_NAME
  const containerNameOpt = containerName !== undefined ? { containerName } : {}
  const runtimeVersionOpt = { runtimeVersion: CLI_VERSION }
  const tuiToken = process.env.TYPECLAW_TUI_TOKEN
  const tuiTokenOpt = tuiToken !== undefined && tuiToken !== '' ? { tuiToken } : {}

  // Install the crash guard FIRST, before any plugin/channel/session
  // construction, so an `unhandledRejection` escaping a channel SDK during boot
  // or steady-state cannot terminate the container. Restart goes through the
  // host daemon only when there is a container to bounce; outside Docker the
  // guard logs and continues degraded (requestContainerRestart returns ok=false
  // when the hostd control endpoint is absent, never throws).
  const fatalGuard = installFatalGuard({
    ...(containerName !== undefined
      ? {
          requestRestart: async (reason: string) => {
            console.warn(`[fatal-guard] requesting container restart: ${reason}`)
            const result = await requestContainerRestart({ containerName })
            return result.ok ? { ok: true } : { ok: false, reason: result.reason }
          },
        }
      : {}),
    onDegrade: (scope, reason) => console.warn(`[fatal-guard] ${scope} degraded: ${reason}`),
  })

  // Both process-global disposers are surrendered to the wrapper as one unit the
  // instant they exist, so a throw anywhere below detaches them; `stop()` calls
  // the same disposer on the success path.
  let processGlobalsDisposed = false
  const disposeProcessGlobals = (): void => {
    if (processGlobalsDisposed) return
    processGlobalsDisposed = true
    uninstallLlmFetchObserver()
    fatalGuard.dispose()
    // onSigterm is defined later in this scope but only ever invoked after init;
    // removing it here keeps a restarted startAgent() from stacking listeners.
    if (sigtermHandler !== null) process.removeListener('SIGTERM', sigtermHandler)
  }
  let sigtermHandler: (() => void) | null = null
  registerBootCleanup(disposeProcessGlobals)

  const { config: cwdConfig, pluginConfigs: pluginConfigsByName } = loadConfigBundleSync(cwd)
  const githubTokenBridge = createGithubTokenBridge()
  const mcpOAuthStore = resolveContainerMcpOAuthStore(process.env, join(cwd, 'secrets.json'))
  const mcpManager =
    cwdConfig.mcpServers.length > 0
      ? createMcpManager(cwdConfig.mcpServers, {
          env: process.env,
          authProvider: (server) =>
            server.url === undefined
              ? undefined
              : new TypeClawMcpOAuthProvider(server.name, mcpOAuthStore, {
                  mode: 'container',
                  redirectUrl: 'http://localhost:1456/callback',
                  clientName: 'typeclaw',
                }),
        })
      : null
  const mcpManagerOpt = mcpManager !== null ? { mcpManager } : {}

  // Warm up MCP connections in the BACKGROUND so boot doesn't block on each
  // server's subprocess spawn + listTools() (worst case the 15s connect
  // timeout). Tool calls lazily ensureConnected() and the catalog render awaits
  // whenInitialConnectSettled(), so correctness never depends on this finishing
  // first. closeAll() below cleans these up if boot aborts.
  if (mcpManager !== null) {
    void mcpManager.connectAll().then((results) => {
      for (const result of results) {
        if (!result.ok) console.warn(`[mcp] ${result.name} failed to connect: ${result.error.message}`)
      }
    })
  }

  // loadPlugins and the vector startup unit have no mutual data dependency, so
  // run them concurrently. loadPlugins stays UNCAUGHT so a bundled-plugin or
  // plugin-security failure still aborts boot; when it does, close the background
  // MCP warm-up so its servers can't leak — startAgent returns no stop() handler
  // on this path, so this is the only cleanup chance. closeAll() also closes any
  // connection the warm-up establishes after shutdown begins.
  const pluginsLoadedPromise = loadPlugins({
    entries: withDefaultPlugins(cwdConfig.plugins),
    agentDir: cwd,
    configsByName: pluginConfigsByName,
    bundled: BUNDLED_PLUGINS,
    resolveGithubTokenForRepo: githubTokenBridge.resolveTokenForRepo,
    hasGithubAppTokenResolver: githubTokenBridge.hasAppTokenResolver,
    getGithubAppSelfLogin: githubTokenBridge.getAppSelfLogin,
    ...(cwdConfig.roles !== undefined ? { roles: cwdConfig.roles } : {}),
  })
  // Emit the container's fixed resource limits BEFORE vector startup. The
  // startup index build is itself an OOM path; if it kills the process, this
  // line must already be in the log so the ceiling is still recorded.
  logResourceReport(cwd)
  // The boot line names the ceiling; this names the climb toward it. Without a
  // series there is no way to tell a leak from a spike after the fact, which is
  // exactly the question an OOM post-mortem opens with.
  //
  // Registered for boot-failure cleanup the instant it exists, and torn down by
  // stop() on the normal path. `unref()` only keeps it from holding the process
  // open; without an explicit clear, repeated start/stop cycles accumulate
  // intervals that scan /proc and log after their runtime is gone.
  const stopResourceSampler = startResourceSamplerFor()
  registerBootCleanup(() => stopResourceSampler())
  const vectorStartupPromise = runVectorStartup(cwd)
  let pluginsLoaded: LoadPluginsResult
  try {
    const [loaded] = await Promise.all([pluginsLoadedPromise, vectorStartupPromise])
    pluginsLoaded = loaded
  } catch (err) {
    if (mcpManager !== null) await mcpManager.closeAll()
    throw err
  }
  // Plugins are loaded (sqlite handles open); from here any boot failure must
  // release them — the caller gets no stop() on the failure path.
  registerBootCleanup(() => pluginsLoaded.disposePlugins())

  reloadRegistry.register(
    createConfigReloadable({
      cwd,
      permissions: pluginsLoaded.permissions,
      onRolesChanged: () => channelManager.router.tearDownAllLive(),
      skipMountValidation: containerName !== undefined,
    }),
  )
  const pluginRegistry = pluginsLoaded.registry
  const pluginHooks = pluginsLoaded.hooks
  const dependencyBinLogger = createPluginLogger('typeclaw')
  const bootDependencyBins = await validateDependencyBins(cwd)
  logDependencyBinProblems(bootDependencyBins, dependencyBinLogger)
  registerDependencyBinDoctorCheck(pluginRegistry, cwd, dependencyBinLogger)

  const { registry: subagents, pluginSubagentByShim, pluginSubagentByName } = mergeSubagents(pluginRegistry)

  const hasAnyPluginContent =
    pluginRegistry.tools.length > 0 ||
    pluginRegistry.subagents.length > 0 ||
    pluginRegistry.cronJobs.length > 0 ||
    pluginRegistry.skills.length > 0 ||
    pluginRegistry.skillsDirs.length > 0 ||
    pluginRegistry.commands.length > 0 ||
    pluginsLoaded.loadedPlugins.length > 0

  const pluginRuntime = createPluginRuntime({
    registry: pluginRegistry,
    hooks: pluginHooks,
    subagents,
    pluginSubagentByShim,
    hasAnyPluginContent,
    loadedPlugins: pluginsLoaded.loadedPlugins,
    materializedSkills: null,
  })

  // Graduate any pre-0.20.0 on-disk shapes (v1 secrets.json, legacy auth.json)
  // to the current v2 envelope before anything reads secrets — otherwise the
  // v2-only parser rejects the file and hydrate below sees no channels. Runs
  // exactly once per folder; a folder already at v2 is a no-op.
  runStartupMigrations(cwd)

  // Channel adapters read `process.env[TOKEN_ENV]` (see channels/manager.ts).
  // Hydrate fills any unset env var from secrets.json#channels via env-wins:
  // values already in process.env (from `docker --env-file .env`) are kept
  // as-is; missing ones get the resolved Secret value injected. The pre-v2
  // auto-promotion from .env to secrets.json has been removed — env values
  // stay in env, the file stays user-owned. See src/secrets/hydrate.ts.
  hydrateChannelEnvFromSecrets({ agentDir: cwd })

  // Proactively refresh any stored provider-OAuth token now. The SDK's own
  // refresh is lazy (fires on the first LLM call), so a container that restarts
  // with an already-expired access token otherwise discovers the staleness —
  // and any refresh failure — mid-turn, surfacing a generic provider-error
  // notice into a live thread. Doing it here moves that to a boot-time operator
  // log. Channel-adapter OAuth already has host-side renewal crons; this is the
  // provider-OAuth equivalent.
  //
  // MUST be awaited, and MUST run before the credential-file exporters below
  // and the first session-producing consumer (subagentConsumer.start /
  // cronConsumer.start / channelManager.start / the websocket server). The
  // refresh holds SecretsBackend's file lock across its network request
  // (`CredentialStore.modify`), while the synchronous readers the exporters and
  // channel hydration use give up after ~200ms and throw ELOCKED.
  // Fire-and-forget here would let a slow refresh still own the lock when an
  // exporter or consumer reads secrets — worse than the lazy path. Awaiting
  // behind this barrier guarantees no synchronous reader races the refresh.
  // Never throws (the wrapper swallows and logs), so a probe failure can't block
  // boot; a refresh that hangs on a wedged network hangs the first turn anyway.
  await refreshProviderOAuth({
    agentDir: cwd,
    log: (message) => console.warn(message),
  })

  // When the user has `docker.file.codexCli: true` AND a typeclaw-managed
  // openai-codex OAuth credential in secrets.json, write ~/.codex/auth.json
  // so the Codex CLI in the container can run without a second login. This runs
  // after the awaited boot refresh so the fresh ephemeral HOME receives the
  // refreshed token, never the stale pre-refresh value. The exporter is
  // failure-tolerant by design: any error (gate miss, fs error, corrupt file)
  // returns a non-fatal result and the agent boot continues. See
  // src/secrets/export-codex-auth-file.ts for the newer-wins compare that
  // prevents clobbering Codex CLI's in-place token refreshes.
  exportCodexAuthFile({
    agentDir: cwd,
    codexCliEnabled: cwdConfig.docker.file.codexCli,
    log: (message) => console.warn(message),
  })

  // Same shape as the codex exporter above, gated on `docker.file.claudeCode`
  // and `secrets.json#providers.anthropic`. It likewise runs after the boot
  // refresh, then writes ~/.claude/.credentials.json so the Claude Code CLI in
  // the container can run without the user pasting a CLAUDE_CODE_OAUTH_TOKEN.
  // See src/secrets/export-claude-credentials-file.ts for the newer-wins compare
  // that prevents clobbering Claude Code's in-place token refreshes, and the
  // read-merge-write that preserves any mcpOAuth state in the file.
  exportClaudeCredentialsFile({
    agentDir: cwd,
    claudeCodeEnabled: cwdConfig.docker.file.claudeCode,
    log: (message) => console.warn(message),
  })

  const githubCliExport = exportGithubCliStore({
    agentDir: cwd,
    log: (message) => console.warn(message),
  })
  if (githubCliExport.action === 'failed') {
    console.warn(
      '[run] trusted GitHub CLI store unavailable; store-backed GitHub pushes will not authenticate. ' +
        'On the host, run `gh auth login --hostname github.com`, then run a real `typeclaw restart`.',
    )
  }

  const claimController = createClaimController({
    cwd,
    permissions: pluginsLoaded.permissions,
    rolesProvider: () => getConfig().roles,
  })

  const tunnelManager: TunnelManager = createTunnelManagerFor({
    tunnels: getConfig().tunnels,
    stream,
    resolveChannelUpstreamPort: (name) => {
      if (name === 'github') return getConfig().channels.github?.webhookPort ?? null
      return null
    },
  })

  const legacyBackgroundHandoffs = new LegacyBackgroundHandoffReader(cwd, {
    onError: (error) => console.warn(`[run] legacy background upgrade failed: ${error}`),
  })
  const backgroundObligations = new BackgroundObligationStore(cwd, {
    epoch: legacyBackgroundHandoffs.processEpoch,
    onError: (error) => console.warn(`[run] background continuity failed: ${error}`),
  })
  const liveSubagentRegistry = new LiveSubagentRegistry()
  const subagentCoalescer = new SubagentCoalescer()
  const liveSessionRegistry = new LiveSessionRegistry()

  const recoveryOutbox = new RecoveryOutbox(cwd, {
    epoch: backgroundObligations.epoch,
    onError: (error) => console.warn(`[run] recovery outbox failed: ${error}`),
  })
  const inboundJournal = new InboundJournal(cwd, {
    backgroundObligations,
    onError: (error) => console.warn(`[run] inbound continuity recovery blocked: ${error}`),
  })
  registerBootCleanup(() => inboundJournal.close())
  let recoveryDispatcher: RecoveryDispatcher | undefined
  const channelManager = createChannelManagerFor({
    agentDir: cwd,
    backgroundObligations,
    inboundJournal,
    recoveryOutbox,
    secretsProvider: caps.secrets,
    channelsConfigRef: () => getConfig().channels,
    aliasesRef: () => getConfig().alias,
    onRecoveryReady: () => {
      void recoveryDispatcher?.wake().catch((error) => console.warn(`[run] recovery wake failed: ${error}`))
    },
    tunnelUrlForChannel: (name) => resolveTunnelUrlForChannel(name, tunnelManager),
    tunnelConfiguredForChannel: (name) => isTunnelConfiguredForChannel(name),
    createSessionForChannel: buildChannelSessionFactory({
      cwd,
      sessionFactory,
      stream,
      reloadRegistry,
      pluginRuntime,
      getChannelRouter: () => channelManager.router,
      rehydrateCapOptions: resolveCapOptionsFromConfig(pluginConfigsByName['tool-result-cap']),
      permissions: pluginsLoaded.permissions,
      reloadRoles: () => reloadRolesFromDisk(cwd),
      liveSubagentRegistry,
      subagentCoalescer,
      liveSessionRegistry,
      subagentRegistry: pluginRuntime.get().subagents,
      getCreateSessionForSubagent: () => createSessionForSubagent,
      ...containerNameOpt,
      ...runtimeVersionOpt,
      ...mcpManagerOpt,
    }),
    permissions: pluginsLoaded.permissions,
    claimHandler: claimController.claimHandler,
    githubTokenBridge,
    stream,
    newestRunningChildSubagentStartedAt: (sessionId) =>
      newestRunningBackgroundChildStartedAt(liveSubagentRegistry.list({ parentSessionId: sessionId })),
    cancelRunningSubagentsByWorkKey: (workKey, reason) => liveSubagentRegistry.cancelRunningByWorkKey(workKey, reason),
    onReload: async () => {
      const { results } = await reloadAllNonDestructive()
      return formatChannelReloadSummary(results)
    },
    // Always registered so /restart's presence in /help, the Slack manifest,
    // and the Discord declarations is environment-independent. When there is no
    // container to bounce (TYPECLAW_CONTAINER_NAME unset — tests, ad-hoc
    // `typeclaw run` outside Docker), the handler reports that instead of the
    // command resolving as unknown, which would make the advertised contract
    // depend on the runtime environment.
    onRestart: async (ctx): Promise<string> => {
      if (containerName === undefined) {
        return 'Restart is unavailable: this agent is not running inside a typeclaw container.'
      }
      // When the /restart command resolved a live channel session, ctx carries
      // its identity: pass stream + session id/file + channel handoffOrigin so
      // the dying container appends the `typeclaw.restart-self` entry (via the
      // broadcast) and writes a channel-origin handoff. On the next boot the
      // channel resume path reopens that exact conversation. With no live
      // session (cold channel / native slash), ctx is undefined and the
      // container just bounces — the next inbound resumes pending todos.
      const result = await requestContainerRestart({
        containerName,
        ...(ctx !== undefined
          ? {
              stream,
              agentDir: cwd,
              originatingSessionId: ctx.originatingSessionId,
              ...(ctx.originatingSessionFile !== undefined
                ? { originatingSessionFile: ctx.originatingSessionFile }
                : {}),
              handoffOrigin: ctx.handoffOrigin,
              ...(ctx.triggeringAuthorId !== undefined ? { triggeringAuthorId: ctx.triggeringAuthorId } : {}),
            }
          : {}),
      })
      return result.ok ? 'Restart scheduled; the container will bounce shortly.' : `Restart denied: ${result.reason}`
    },
  })

  const createSessionForSubagent: import('@/agent/subagents').CreateSessionForSubagent = async (
    subagent,
    subagentOptions,
  ) => {
    const snap = pluginRuntime.get()
    const entry = snap.pluginSubagentByShim.get(subagent)
    if (entry) {
      const sessionManager = SessionManager.create(cwd, sessionFactory.sessionDir())
      const sessionId = sessionManager.getSessionId()
      const origin: SessionOrigin = {
        kind: 'subagent' as const,
        subagent: subagentOptions?.name ?? entry.subagentName,
        parentSessionId: subagentOptions?.parentSessionId ?? '<unknown>',
        ...(subagentOptions?.spawnedByRole !== undefined ? { spawnedByRole: subagentOptions.spawnedByRole } : {}),
        ...(subagentOptions?.spawnedByOrigin !== undefined ? { spawnedByOrigin: subagentOptions.spawnedByOrigin } : {}),
      }
      const allowBackgroundFromSubagent =
        entry.pluginSubagent.canBackgroundSpawnSubagents === true && entry.pluginSubagent.canSpawnSubagents === true
      const created = await createSessionWithDispose({
        systemPromptOverride: entry.pluginSubagent.systemPrompt,
        sessionManager,
        channelRouter: channelManager.router,
        origin,
        permissions: pluginsLoaded.permissions,
        plugins: {
          registry: snap.registry,
          hooks: snap.hooks,
          sessionId,
          agentDir: cwd,
        },
        pluginSubagent: {
          pluginName: entry.pluginName,
          ...(entry.pluginSubagent.tools ? { toolRefs: entry.pluginSubagent.tools } : {}),
          ...(entry.pluginSubagent.customTools ? { customTools: entry.pluginSubagent.customTools } : {}),
          toolNamePrefix: `__plugin_${entry.pluginName}_${entry.subagentName}`,
        },
        // Orchestration wiring is opt-in per subagent (canSpawnSubagents) so
        // only operator/reviewer can delegate; explorer/scout/etc. stay leaves.
        // The same liveSubagentRegistry instance is shared, but
        // subagent_output/subagent_cancel scope by the caller's session (see
        // authorizeLiveSubagentAccess) and spawn_subagent caps the chain at
        // MAX_SUBAGENT_DEPTH. createSessionForSubagent self-references so a
        // nested spawn re-enters this same factory.
        ...(entry.pluginSubagent.canSpawnSubagents === true
          ? {
              liveSubagentRegistry,
              subagentCoalescer,
              subagentRegistry: snap.subagents,
              createSessionForSubagent,
              allowBackgroundFromSubagent,
            }
          : {}),
        ...(resolveSubagentProfile(entry.pluginSubagent, subagentOptions) !== undefined
          ? { profile: resolveSubagentProfile(entry.pluginSubagent, subagentOptions) }
          : {}),
        ...(entry.pluginSubagent.toolResultBudget !== undefined
          ? { toolResultBudget: entry.pluginSubagent.toolResultBudget }
          : {}),
        ...(entry.pluginSubagent.bashPolicy !== undefined ? { bashPolicy: entry.pluginSubagent.bashPolicy } : {}),
        ...runtimeVersionOpt,
      })
      liveSessionRegistry.register({
        sessionId,
        session: created.session,
        origin: sessionMetaPayload(origin).origin,
        registeredAtMs: Date.now(),
      })
      const originalDispose = created.dispose
      return {
        ...created,
        dispose: async () => {
          liveSessionRegistry.unregister(sessionId)
          await originalDispose()
        },
        hooks: snap.hooks,
        sessionId,
        agentDir: cwd,
        origin,
        getTranscriptPath: () => sessionManager.getSessionFile(),
        ...(allowBackgroundFromSubagent
          ? { backgroundDrain: { stream, sessionId, liveRegistry: liveSubagentRegistry } }
          : {}),
      }
    }
    // Non-plugin (built-in) subagents — general/explore/scout/memory-logger/
    // dreaming and anything spawned through the generic task path. They used to
    // run with NO plugin tool.before/tool.after coverage, so their bash skipped
    // the security guards AND the github-cli-auth GitHub-token injection — a
    // generic subagent's `git push` got no minted token and died with "could
    // not read Username" even when a GitHub App was configured. Thread the same
    // hook bus the plugin-subagent branch uses, against a freshly allocated
    // subagent session id (never the parent's, so hooks/audit/permission
    // attribution stay per-session).
    const sessionManager = SessionManager.create(cwd, sessionFactory.sessionDir())
    return defaultCreateSessionForSubagent(subagent, {
      ...subagentOptions,
      plugins: {
        registry: snap.registry,
        hooks: snap.hooks,
        sessionId: sessionManager.getSessionId(),
        agentDir: cwd,
      },
      // Pass permissions alongside plugins (same as the plugin-subagent branch
      // at line 384): without it the builtin-bash sandbox (applyBashSandbox /
      // applyTmpPathRedirect) stays off and the subagent would get the injected
      // token but no role-derived sandboxing.
      permissions: pluginsLoaded.permissions,
    })
  }

  const subagentConsumer = createSubagentConsumer({
    stream,
    getRegistry: () => pluginRuntime.get().subagents,
    agentDir: cwd,
    createSessionForSubagent,
    coalescer: subagentCoalescer,
    inFlightKey: (name, payload, parentSessionId) => {
      const fn = pluginRuntime.get().subagents[name]?.inFlightKey
      if (fn !== undefined) {
        try {
          const key = `${name}:${fn(payload)}`
          return parentSessionId === undefined ? key : `${parentSessionId}:${key}`
        } catch {
          return parentSessionId === undefined ? name : `${parentSessionId}:${name}`
        }
      }
      return parentSessionId === undefined ? name : `${parentSessionId}:${name}`
    },
  })
  registerBootCleanup(() => subagentConsumer.stop())
  subagentConsumer.start()

  // Populated by startScheduler's factory (onCountStore). The consumer
  // subscribes before this is set, but only touches the holder at fire time
  // (reading the count via `get` and recording it via `increment`) — and the
  // scheduler (the sole cron publisher) is armed only AFTER the holder is
  // populated, so no count-limited fire can observe an undefined holder. If
  // another cron publisher is ever added, create the store before this point.
  let cronCountStore: CountStore | undefined
  const cronConsumer = createCronConsumer({
    stream,
    cwd,
    countStore: {
      get: (id, job) => cronCountStore?.get(id, job) ?? 0,
      // Holder is always set before any fire (see above); the `false` fallback
      // fails safe — skip dispatch rather than run an uncounted count-job — for
      // the unreachable case where a fire somehow predates the holder.
      increment: (id, job, at) => cronCountStore?.increment(id, job, at) ?? Promise.resolve(false),
    },
    invokeHandler: async (job) => {
      const snap = pluginRuntime.get()
      const registered = snap.registry.cronJobs.find((j) => j.globalId === job.id)
      const pluginName = registered?.pluginName ?? '<unknown>'
      const logger = createPluginLogger(pluginName)
      const abortController = new AbortController()
      const origin: SessionOrigin = {
        kind: 'cron',
        jobId: job.id,
        jobKind: 'handler',
        ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
        scheduledByOrigin: (job.scheduledByOrigin as SessionOrigin | undefined) ?? { kind: 'config-file' },
      }
      const ctx: CronHandlerContext = {
        jobId: job.id,
        name: pluginName,
        agentDir: cwd,
        logger,
        signal: abortController.signal,
        permissions: pluginsLoaded.permissions,
        origin,
        prompt: (text: string) =>
          runPromptForCommand({
            text,
            origin,
            runtime: pluginRuntime,
            agentDir: cwd,
            permissions: pluginsLoaded.permissions,
            signal: abortController.signal,
            runtimeVersion: runtimeVersionOpt.runtimeVersion,
            containerName: containerNameOpt.containerName,
            sessionFactory,
            channelRouter: channelManager.router,
            ...mcpManagerOpt,
          }),
        subagent: (subName: string, payload?: unknown) =>
          dispatchSpawnSubagent(subName, payload, {
            spawnedByOrigin: origin,
          }),
        exec: (strings: TemplateStringsArray, ...values: unknown[]) =>
          runExecForCommand(strings, values, { cwd, signal: abortController.signal }),
      }
      await job.handler(ctx)
    },
    createSessionForCron: async (job, refOverride) => {
      const snap = pluginRuntime.get()
      const sessionManager = SessionManager.create(cwd, sessionFactory.sessionDir())
      const sessionId = sessionManager.getSessionId()
      const cronOrigin: SessionOrigin = {
        kind: 'cron',
        jobId: job.id,
        jobKind: 'prompt',
        ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
        // Honor the persisted audit snapshot when present (TUI-authored
        // crons, or jobs scheduled by a future `cron_schedule` tool).
        // Hand-authored entries fall back to the config-file synthetic
        // marker so the audit trail records "user edited cron.json".
        scheduledByOrigin: (job.scheduledByOrigin as SessionOrigin | undefined) ?? { kind: 'config-file' },
      }
      // Cron todos are per-fire ephemeral by default: each scheduled run starts
      // with a clean list so an incomplete item from a prior fire cannot
      // resurrect indefinitely on every tick. (A future opt-in could carry them
      // forward; until then, clearing is the safe default.)
      await clearTodosForOrigin(cwd, cronOrigin).catch((err) =>
        console.error(`[cron] ${job.id}: clear todos failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      const session = await createSession({
        reloadRegistry,
        sessionManager,
        stream,
        channelRouter: channelManager.router,
        origin: cronOrigin,
        permissions: pluginsLoaded.permissions,
        ...(refOverride !== undefined ? { refOverride } : {}),
        ...(snap.hasAnyPluginContent
          ? {
              plugins: {
                registry: snap.registry,
                hooks: snap.hooks,
                sessionId,
                agentDir: cwd,
              },
            }
          : {}),
        liveSubagentRegistry,
        subagentCoalescer,
        subagentRegistry: pluginRuntime.get().subagents,
        createSessionForSubagent,
        ...containerNameOpt,
        ...runtimeVersionOpt,
        ...mcpManagerOpt,
      })
      liveSessionRegistry.register({
        sessionId,
        session,
        origin: sessionMetaPayload(cronOrigin).origin,
        registeredAtMs: Date.now(),
      })
      return {
        prompt: (text) => session.prompt(text),
        dispose: () => {
          liveSessionRegistry.unregister(sessionId)
          session.dispose()
        },
        sessionId,
        agentDir: cwd,
        origin: cronOrigin,
        session,
        ...(snap.hasAnyPluginContent ? { hooks: snap.hooks } : {}),
        getTranscriptPath: () => sessionManager.getSessionFile(),
      }
    },
  })

  const internalJobs = () => pluginCronJobs(pluginRuntime.get().registry)
  const factory = createSchedulerFor ?? makeDefaultSchedulerFactory(internalJobs)
  // Subscribe the consumer BEFORE the scheduler arms any timers. The stream
  // delivers only to live subscribers (no replay), so a fire published before
  // the subscription exists would be lost. Subscribing to an empty stream is
  // harmless when there are no jobs.
  registerBootCleanup(() => cronConsumer.stop())
  cronConsumer.start()
  const scheduler = await startScheduler({
    cwd,
    loadCron,
    createSchedulerFor: factory,
    registerBootCleanup,
    stream,
    hasInternalJobs: internalJobs().length > 0,
    getSubagents: () => pluginRuntime.get().subagents,
    onCountStore: (store) => {
      cronCountStore = store
    },
  })

  if (scheduler) {
    reloadRegistry.register(
      createCronReloadable({ cwd, scheduler, internalJobs, getSubagents: () => pluginRuntime.get().subagents }),
    )
  }

  const tunnelBridge: TunnelBridge = createTunnelBridge({ stream, channelManager })
  registerBootCleanup(() => tunnelBridge.stop())

  // Bridge `subagent.completed` broadcasts into the channel router so a
  // backgrounded subagent finishing wakes up its parent channel session
  // with a `<system-reminder>` — symmetric to the TUI bridge in
  // src/server/index.ts. Must be created BEFORE channelManager.start()
  // so an initial broadcast can never race past the subscription gap.
  const subagentCompletionBridge: SubagentCompletionBridge = createSubagentCompletionBridge({
    stream,
    router: channelManager.router,
  })
  registerBootCleanup(() => subagentCompletionBridge.stop())

  // Fan a landed formal review verdict out to the sibling sessions reviewing the
  // same PR so they stand down from a redundant verdict (the per-thread fan-out
  // duplicate-review fix). The github-cli-auth plugin records the verdict in the
  // turn-ledger but has no stream access, so the ledger's review observer is the
  // seam: it publishes onto the broadcast bus here, and the bridge routes it.
  const prVerdictActivityBridge: PrVerdictActivityBridge = createPrVerdictActivityBridge({
    stream,
    router: channelManager.router,
  })
  registerBootCleanup(() => prVerdictActivityBridge.stop())
  setReviewObserver((review) => {
    void (async () => {
      await channelManager.router.completeGithubReviewRound?.(review)
      stream.publish({
        target: { kind: 'broadcast' },
        payload: { kind: 'pr.verdict-activity', ...review },
      })
    })()
  })
  registerBootCleanup(() => setReviewObserver(null))

  // A landed review of ANY state (incl. COMMENT) marks the recording session so its
  // empty-turn fallback is suppressed: the review IS the turn's output, but it goes
  // through the GitHub API, not the channel send path. In-process router call — no
  // stream fan-out, since this is the recording session's own bookkeeping.
  setReviewCoverageCapture(async (sessionId) => ({
    expectedAccountIdentity: await channelManager.router.captureTurnAccountIdentity?.(sessionId),
    inboundCoverage: (await channelManager.router.captureInboundResultCoverage?.(sessionId)) ?? [],
    backgroundCoverage: (await channelManager.router.captureBackgroundResultCoverage?.(sessionId)) ?? [],
  }))
  registerBootCleanup(() => setReviewCoverageCapture(null))
  setReviewOutputObserver((output) => channelManager.router.noteGithubReviewOutput(output).then(() => {}))
  registerBootCleanup(() => setReviewOutputObserver(null))

  // Registered before channels so its cache clear lands before any channel
  // session teardown observes it. secrets.json provider credentials are not
  // part of the typeclaw.json config diff, so a rotated key takes effect on
  // `typeclaw reload` only via this dedicated scope. Live sessions captured
  // their ModelRuntime at creation, so teardown recreates them with fresh auth.
  reloadRegistry.register(
    createProviderAuthReloadable({
      onProviderAuthChanged: () => channelManager.router.tearDownAllLive(),
    }),
  )

  reloadRegistry.register(createChannelsReloadable({ manager: channelManager }))

  registerBootCleanup(() => channelManager.stop())
  recoveryDispatcher = new RecoveryDispatcher(recoveryOutbox, channelManager.router, {
    onError: (error) => console.warn(`[run] recovery dispatch failed: ${error}`),
    backgroundObligations,
    inboundJournal,
  })
  registerBootCleanup(() => recoveryDispatcher?.stop())
  try {
    // Mixed source decisions are repaired before any child or notice can progress.
    await inboundJournal.initialize()
    await inboundJournal.repair()
    await inboundJournal.importOldEpoch(recoveryOutbox)
    await bootBackgroundObligations({
      obligations: backgroundObligations,
      outbox: recoveryOutbox,
      inventory: legacyBackgroundHandoffs,
    })
  } catch (error) {
    // Keep the operator/adapter surface and verified inventory-only notices alive.
    // Journal failure freezes dependent work; valid-looking child JSON is not proof of independence.
    backgroundObligations.setFrozen(error)
    console.warn(`[run] continuity blocked pending operator repair: ${error}`)
  }
  await bootChannelRestartGreeting({
    agentDir: cwd,
    router: channelManager.router,
    configured: (key) => getConfig().channels[key.adapter] !== undefined,
    startAdapters: () => channelManager.start(),
    onError: (error) => console.warn(`[run] channel restart-resume failed: ${error}`),
  })
  await recoveryDispatcher.wake()

  // Captured separately from setSpawnSubagent so both the plugin context and
  // the plugin-command runner can dispatch through the same path. The setter
  // returns void, so without this local binding we couldn't reuse the fn.
  //
  // In-flight coalescing for direct ctx.spawnSubagent calls mirrors the
  // SubagentConsumer's stream-path gate (subagents.ts:441). Two queued
  // `new-session` messages for the same (name, inFlightKey) drop the second
  // on the consumer side; without the same gate here, two consecutive direct
  // plugin spawns with the same in-flight key could race. Awaiting the spawn in
  // the hook used to mask this; detached hook paths expose the race and make the
  // gate mandatory.
  //
  // Same key shape as the consumer: `${name}:${inFlightKey(payload)}` when the
  // subagent declares one, else just `${name}`. Collisions resolve cleanly
  // (logged + return) instead of rejecting, because callers from
  // session.prompt are detached and a colliding spawn is a noop, not an error.
  const dispatchSpawnSubagent: CommandSpawnSubagent = async (name, payload, options) => {
    const registry = pluginRuntime.get().subagents
    const lease = acquireSubagentCoalesceLease({
      coalescer: subagentCoalescer,
      subagentName: name,
      subagent: registry[name],
      payload,
      ...(options?.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    })
    if (lease === null) {
      console.warn(`[subagent] ${name}: previous direct spawn still in progress, skipping`)
      return
    }
    try {
      // Resolve the spawning session's role from its origin so the subagent
      // inherits it. Callers (hooks like session.idle) pass the parent origin
      // verbatim; we look up the role rather than letting the caller forge it,
      // closing the laundering vector the design doc calls out for cron.
      const spawnedByRole =
        options?.spawnedByOrigin !== undefined
          ? pluginsLoaded.permissions.resolveRole(options.spawnedByOrigin)
          : undefined
      try {
        await awaitWithSubagentTimeout(
          invokeSubagent(name, {
            registry,
            createSessionForSubagent,
            agentDir: cwd,
            userPrompt: '',
            payload,
            onProviderError: (message) => console.error(`[subagent] ${name}: LLM call failed: ${message}`),
            ...(options?.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
            ...(spawnedByRole !== undefined ? { spawnedByRole } : {}),
            ...(options?.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
          }),
          name,
          lease.key,
          registry[name]?.timeoutMs,
        )
      } catch (err) {
        if (isSubagentTimeoutError(err)) {
          console.warn(`[subagent] ${lease.key} timed out after ${err.timeoutMs}ms; releasing coalesce key`)
          return
        }
        throw err
      }
    } finally {
      lease.release()
    }
  }
  pluginsLoaded.setSpawnSubagent(dispatchSpawnSubagent)
  pluginsLoaded.markBooted()

  if (pluginsLoaded.loadedPlugins.length > 0) {
    console.log(`[plugin] loaded ${summarizeLoaded(pluginsLoaded.loadedPlugins, pluginRegistry)}`)
  }

  for (const f of pluginsLoaded.failedPlugins) {
    console.warn(`[plugin] DEGRADED: "${f.entry}" disabled (${f.phase}): ${f.error}`)
  }

  // Container-side portbroker is instantiated only when the host plumbed a
  // broker token in via env var. Outside the container (tests, ad-hoc dev
  // runs), the env var is absent and the broker stays off — same fence as
  // TYPECLAW_CONTAINER_NAME guards the restart tool.
  const brokerTokenEnv = process.env.TYPECLAW_HOSTD_BROKER_TOKEN
  const containerBroker =
    brokerTokenEnv !== undefined && brokerTokenEnv.length > 0
      ? createContainerBroker({
          expectedToken: brokerTokenEnv,
          onLog: (event) => {
            if (event.kind === 'subscribed') return
            stream.publish({
              target: { kind: 'broadcast' },
              payload: { kind: 'portbroker-log', event },
            })
          },
          // Re-publish to in-process buses so plugin code can talk to the
          // broker without holding a ContainerBroker reference.
          onForwardResult: (event) => publishForwardResult(event),
          onForwardRequestSubscribe: (cb) => subscribeForwardRequest(cb),
        })
      : undefined
  const containerBrokerOpt = containerBroker ? { containerBroker } : {}

  const commandRunnerFactory = (outbound: import('@/server/command-runner').CommandOutbound): CommandRunner =>
    createCommandRunner({
      pluginRuntime,
      permissions: pluginsLoaded.permissions,
      spawnSubagent: dispatchSpawnSubagent,
      agentDir: cwd,
      runtimeVersion: CLI_VERSION,
      containerName,
      outbound,
      sessionFactory,
      channelRouter: channelManager.router,
      ...mcpManagerOpt,
    })

  const serverFactory = createServer({
    port,
    reloadAll: reloadAllNonDestructive,
    reloadRegistry,
    sessionFactory,
    stream,
    channelRouter: channelManager.router,
    ...mcpManagerOpt,
    agentDir: cwd,
    pluginRuntime,
    permissions: pluginsLoaded.permissions,
    getFiredCount: (job) => cronCountStore?.get(job.id, job) ?? 0,
    claimController,
    commandRunnerFactory,
    tunnelManager,
    liveSubagentRegistry,
    subagentCoalescer,
    createSessionForSubagent,
    liveSessionRegistry,
    ...containerNameOpt,
    ...runtimeVersionOpt,
    ...tuiTokenOpt,
    ...containerBrokerOpt,
  })
  let server: BunServer | null = null
  registerBootCleanup(() => server?.stop(true))
  server = serverFactory.start()

  // Tunnel manager starts AFTER the WS server is up so a slow/hanging
  // provider (PR 2's cloudflared first-URL wait) cannot block TUI, reload,
  // or channel adapter availability. External providers resolve URLs
  // synchronously; future managed providers will resolve asynchronously
  // and broadcast URL events when ready.
  registerBootCleanup(() => tunnelManager.stop())
  await tunnelManager.start()

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    // The final disposers run in `finally` so an earlier async teardown
    // rejection cannot strand process-global listeners or plugin-owned handles
    // into the next `startAgent`.
    try {
      stopResourceSampler()
      scheduler?.stop()
      cronConsumer.stop()
      subagentConsumer.stop()
      server.stop(true)
      void disposeMaterializedSkills(pluginRuntime)
      tunnelBridge.stop()
      subagentCompletionBridge.stop()
      prVerdictActivityBridge.stop()
      setReviewObserver(null)
      setReviewCoverageCapture(null)
      setReviewOutputObserver(null)
      await tunnelManager.stop()
      await recoveryDispatcher?.stop()
      await channelManager.stop()
      await mcpManager?.closeAll()
    } finally {
      await inboundJournal.close().catch((error) => console.warn(`[run] inbound continuity close failed: ${error}`))
      await backgroundObligations
        .flush()
        .catch((error) => console.warn(`[run] background continuity flush failed: ${error}`))
      await pluginsLoaded.disposePlugins()
      disposeProcessGlobals()
    }
  }

  // Graceful shutdown on host-initiated restart (`typeclaw restart` → docker
  // stop → SIGTERM, ~10s before SIGKILL). Mark every live session's todo scope
  // so the turn this restart aborts does not arm the durable user-abort block —
  // each scope's incomplete todos then auto-continue after the new container
  // boots. Then run best-effort teardown. A hard deadline force-exits well
  // inside Docker's grace window so a hung turn can't get the process SIGKILL'd
  // mid-flush. Only meaningful inside a container; outside Docker SIGTERM is an
  // ordinary stop with nothing to resume.
  const SHUTDOWN_DEADLINE_MS = 8_000
  let shuttingDown = false
  const onSigterm = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    const forceExit = setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS)
    forceExit.unref()
    void (async () => {
      if (containerName !== undefined) {
        await markRestartAbortPendingForOrigin(cwd, { kind: 'tui', sessionId: 'tui' }).catch(() => undefined)
        await channelManager.router.markRestartAbortForAllLive().catch(() => undefined)
      }
      await stop().catch(() => undefined)
      clearTimeout(forceExit)
      process.exit(0)
    })()
  }
  sigtermHandler = onSigterm
  process.on('SIGTERM', onSigterm)

  if (!attachTui) {
    return {
      server,
      tuiPromise: null,
      scheduler,
      cronConsumer: scheduler ? cronConsumer : null,
      subagentConsumer,
      reloadRegistry,
      stream,
      pluginRuntime,
      loadedPlugins: pluginsLoaded.loadedPlugins,
      channelManager,
      stop,
    }
  }

  const serverPort = server.port
  if (serverPort === undefined) throw new Error('server did not report a listening port')
  const url = buildLocalTuiUrl(serverPort, tuiTokenOpt.tuiToken ?? null)
  const tui = createTui({ url, initialPrompt })
  const tuiPromise = tui.run()
  return {
    server,
    tuiPromise,
    scheduler,
    cronConsumer: scheduler ? cronConsumer : null,
    subagentConsumer,
    reloadRegistry,
    stream,
    pluginRuntime,
    loadedPlugins: pluginsLoaded.loadedPlugins,
    channelManager,
    stop,
  }
}

async function runVectorStartup(cwd: string): Promise<void> {
  await buildStartupVectorIndex(cwd, embed).catch((err) => {
    console.warn(`[vector] startup index build failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Warm the embedder after the index pass (even when the index needed no
  // rebuild above, which skips embed() entirely) so the first channel turn's
  // query embed doesn't pay the one-time ONNX init on its critical path.
  // Non-fatal: a failure here degrades to the per-turn lazy load.
  await warmEmbedder().catch((err) => {
    console.warn(`[vector] embedder warm-up failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

function buildLocalTuiUrl(port: number, token: string | null): string {
  if (token === null) return `ws://localhost:${port}`
  const url = new URL(`ws://localhost:${port}`)
  url.searchParams.set('token', token)
  return url.toString()
}

function resolveTunnelUrlForChannel(channelName: string, tunnelManager: TunnelManager): string | null {
  const tunnel = getConfig().tunnels.find((entry) => entry.for.kind === 'channel' && entry.for.name === channelName)
  return tunnel ? tunnelManager.urlFor(tunnel.name) : null
}

function isTunnelConfiguredForChannel(channelName: string): boolean {
  return getConfig().tunnels.some((entry) => entry.for.kind === 'channel' && entry.for.name === channelName)
}

async function disposeMaterializedSkills(pluginRuntime: PluginRuntime): Promise<void> {
  const pending = pluginRuntime.drainPendingDisposal()
  const current = pluginRuntime.get().materializedSkills
  const all = current ? [...pending, current] : pending
  await Promise.allSettled(all.map((m) => m.dispose()))
}

// grant_role's hot-reload hook: reload the live config FROM DISK (grantRole
// wrote typeclaw.json directly, bypassing the in-memory snapshot) and return
// the fresh roles for permissions.replaceRoles. Mirrors the config reloadable's
// reload-then-read order. Falls back to the current snapshot if the just-written
// file fails to parse — the on-disk write still stands and the next reload picks
// it up; replaceRoles with stale roles is no worse than not reloading.
function reloadRolesFromDisk(cwd: string): ReturnType<typeof getConfig>['roles'] {
  try {
    reloadConfig(cwd)
  } catch {
    // keep the current pointer; see above
  }
  return getConfig().roles
}

// Exported for the resilience regression test in `index.test.ts` (survives a
// file-level cron.json failure by still scheduling plugin jobs). Not re-exported
// from the package entry point, so this stays module-internal in practice.
export async function startScheduler({
  cwd,
  loadCron,
  createSchedulerFor,
  registerBootCleanup,
  stream,
  hasInternalJobs,
  getSubagents,
  onCountStore,
}: {
  cwd: string
  loadCron: LoadCronFn
  createSchedulerFor: SchedulerFactory
  registerBootCleanup: (cleanup: () => void | Promise<void>) => void
  stream: Stream
  hasInternalJobs: boolean
  getSubagents?: () => SubagentRegistry
  onCountStore?: (store: CountStore) => void
}): Promise<Scheduler | null> {
  let result: LoadCronResult
  const subagents = getSubagents?.()
  try {
    result = await loadCron(cwd, { mode: 'boot', ...(subagents !== undefined ? { subagents } : {}) })
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  // A file-level cron.json failure (malformed JSON or top-level schema
  // violation) must not take the whole scheduler down: plugin-registered jobs
  // (e.g. memory dreaming) live outside cron.json and have to keep running.
  // Boot with an empty user file so the factory still merges internal jobs;
  // give up only when there is nothing to schedule at all.
  if (!result.ok) {
    console.error(`[cron] failed to load cron.json: ${result.reason}`)
    if (!hasInternalJobs) return null
  } else {
    for (const warning of result.warnings ?? []) {
      console.error(`[cron] skipped invalid job at boot: ${warning.reason}`)
    }
  }

  const file: CronFile = result.ok ? (result.file ?? { jobs: [] }) : { jobs: [] }
  if (result.ok && !result.file && !hasInternalJobs) return null

  const onFire = (job: CronJob) => {
    stream.publish({ target: { kind: 'cron', jobId: job.id }, payload: job })
  }
  const scheduler = await createSchedulerFor({ cwd, file, onFire, onCountStore })
  registerBootCleanup(() => scheduler.stop())
  scheduler.start()
  return scheduler
}

function makeDefaultSchedulerFactory(internalJobs: () => CronJob[]): SchedulerFactory {
  return async ({ cwd, file, onFire, onCountStore }) => {
    const jobs = [...file.jobs, ...internalJobs()]
    const countStore = await createCountStore(cwd, jobs)
    // Share the one store instance with the consumer's authoritative count gate.
    onCountStore?.(countStore)
    return createScheduler({ jobs, onFire, countStore })
  }
}

// Exported for the regression test in `merge-subagents.test.ts`. The shim
// layer between the plugin-author-facing `Subagent` (`@/plugin/types`) and
// the runtime-internal `Subagent` (`@/agent/subagents`) is the load-bearing
// translation point for visibility, payload-schema, and permission gating —
// fields that flow through the `SubagentRegistry` without going through the
// `pluginSubagentByShim` recovery path. Previous regressions silently
// dropped fields here, hiding every public bundled subagent (scout,
// explorer, operator) from the `spawn_subagent` tool surface.
export function mergeSubagents(pluginRegistry: PluginRegistry): {
  registry: SubagentRegistry
  pluginSubagentByShim: WeakMap<InternalSubagent<any>, PluginSubagentEntry>
  pluginSubagentByName: Map<string, PluginSubagentEntry>
} {
  const merged: Record<string, InternalSubagent<any>> = {}
  const pluginSubagentByShim = new WeakMap<InternalSubagent<any>, PluginSubagentEntry>()
  const pluginSubagentByName = new Map<string, PluginSubagentEntry>()
  for (const reg of pluginRegistry.subagents) {
    if (merged[reg.subagentName] !== undefined) {
      throw new Error(
        `plugin ${reg.pluginName}: subagent name "${reg.subagentName}" already registered (across plugins)`,
      )
    }
    const shim = pluginSubagentShim(reg.subagent)
    merged[reg.subagentName] = shim
    const entry: PluginSubagentEntry = {
      pluginName: reg.pluginName,
      subagentName: reg.subagentName,
      pluginSubagent: reg.subagent,
    }
    pluginSubagentByShim.set(shim, entry)
    pluginSubagentByName.set(reg.subagentName, entry)
  }
  return { registry: merged, pluginSubagentByShim, pluginSubagentByName }
}

// Compile-time proof that every plugin-only key on `@/plugin`'s `Subagent`
// (i.e. every key NOT inherited from `SubagentShared`) has been classified
// for the shim. When a future maintainer introduces a new field on plugin-side
// `Subagent` that isn't on `SubagentShared`, the `satisfies` clause on
// `PLUGIN_ONLY_KEYS_DROPPED_BY_SHIM` below fails at compile time until the
// new key is listed there — and the destructuring in `pluginSubagentShim`
// is updated to discard it. Without this guard, the shim's rest-spread
// would silently leak future plugin-only fields into the internal registry —
// the opposite-direction drift from the bug this PR fixes for shared fields.
type PluginOnlySubagentKeys = Exclude<keyof import('@/plugin').Subagent<any>, keyof SubagentShared<any>>
const PLUGIN_ONLY_KEYS_DROPPED_BY_SHIM = {
  tools: true,
  customTools: true,
} satisfies Record<PluginOnlySubagentKeys, true>
// Reference the table so it's not dead code. The value is a runtime no-op;
// the load-bearing work is the `satisfies` clause above which forces
// exhaustive classification of plugin-only keys at compile time.
void PLUGIN_ONLY_KEYS_DROPPED_BY_SHIM

function pluginSubagentShim(subagent: import('@/plugin').Subagent<any>): InternalSubagent<any> {
  // The two diverging fields (`tools` is `BuiltinToolRef[]` plugin-side vs
  // `AgentSessionTools` internal-side; `customTools` similarly differs) are
  // resolved later in `createSessionForSubagent` via the
  // `pluginSubagentByShim` lookup, which recovers the original plugin
  // reference. Every other plugin-side field lives on `SubagentShared` and is structurally
  // assignable to the internal `Subagent`, so a rest-spread carries them
  // verbatim — including `visibility` and `requiresSpecificPermission`,
  // whose silent drop in the previous shim made every plugin-contributed
  // public subagent (scout, explorer, operator) invisible to the
  // `spawn_subagent` tool. The list of keys removed here is enforced
  // exhaustive at compile time by `PLUGIN_ONLY_KEYS_DROPPED_BY_SHIM` above.
  const { tools: _tools, customTools: _customTools, ...shared } = subagent
  return shared
}
