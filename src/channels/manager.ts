import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { PermissionService } from '@/permissions'
import type { GithubSecretsBlock } from '@/secrets'
import { SecretsDiscordCredentialStore } from '@/secrets/discord-store'
import { SecretsInstagramCredentialStore } from '@/secrets/instagram-store'
import { SecretsKakaoCredentialStore } from '@/secrets/kakao-store'
import { SecretsLineCredentialStore } from '@/secrets/line-store'
import type { RuntimeSecretsProvider } from '@/secrets/secrets-provider'
import { SecretsSlackCredentialStore } from '@/secrets/slack-store'
import { SecretsBackend } from '@/secrets/storage'
import { SecretsTeamsCredentialStore } from '@/secrets/teams-store'
import { SecretsWebexCredentialStore } from '@/secrets/webex-store'
import type { Stream } from '@/stream'

import { createDiscordAdapter, type DiscordAdapter } from './adapters/discord'
import { createDiscordBotAdapter, type DiscordBotAdapter } from './adapters/discord-bot'
import { createGithubAdapter, type GithubAdapter } from './adapters/github'
import { createInstagramAdapter, type InstagramAdapter } from './adapters/instagram'
import { createKakaotalkAdapter, type KakaotalkAdapter } from './adapters/kakaotalk'
import { createLineAdapter, type LineAdapter } from './adapters/line'
import { createSlackAdapter, type SlackAdapter } from './adapters/slack'
import { createSlackBotAdapter, type SlackBotAdapter } from './adapters/slack-bot'
import { createTeamsAdapter, type TeamsAdapter } from './adapters/teams'
import { createTelegramBotAdapter, type TelegramBotAdapter } from './adapters/telegram-bot'
import { createWebexAdapter, type WebexAdapter } from './adapters/webex'
import { createWebexBotAdapter, type WebexBotAdapter } from './adapters/webex-bot'
import { describeError } from './describe-error'
import type { GithubTokenBridge } from './github-token-bridge'
import {
  createChannelRouter,
  type ChannelRouter,
  type ClaimHandler,
  type CreateSessionForChannel,
  type RestartCommandContext,
} from './router'
import {
  ADAPTER_IDS,
  type AdapterId,
  type ChannelAdapterConfig,
  type ChannelsConfig,
  type GithubAdapterConfig,
} from './schema'

export type ChannelManagerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: ChannelManagerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type ChannelManagerOptions = {
  agentDir: string
  channelsConfigRef: () => ChannelsConfig
  // Plain-text names the agent answers to in channel engagement (the
  // `alias` field in `typeclaw.json`), forwarded to the router as
  // `configuredAliases`. Read live on every inbound so an `applied`-class
  // reload of `alias` takes effect without a container restart. Omitted
  // means alias-based engagement is off — `basename(agentDir)` is still
  // implicit. This MUST be wired up in production (`src/run/index.ts`)
  // or the configured aliases are silently orphaned: parsed by the
  // schema, never read by anyone. See `manager.test.ts` for the
  // end-to-end engagement assertion that guards this wiring.
  aliasesRef?: () => readonly string[]
  logger?: ChannelManagerLogger
  env?: NodeJS.ProcessEnv
  // The container-stage secrets provider for personal-account adapters
  // (line/kakaotalk/slack/discord/webex/instagram write-back + read). Resolved
  // ONCE at the composition root (createRuntimeCapabilities in src/run/index.ts)
  // and threaded in here — the manager never resolves it from env itself. Null
  // (or omitted) skips those adapters; see the note above the
  // createContainer*CredentialStore factories.
  secretsProvider?: RuntimeSecretsProvider | null
  // Production wiring passes a factory that builds sessions with the full
  // runtime plumbing (channelRouter, stream, plugins, reloadRegistry). When
  // omitted, the router falls back to a hollow factory that creates sessions
  // without a channelRouter — the agent then has no `channel_send` tool and
  // cannot reply, which is fine for tests but a bug in production. See
  // src/run/index.ts where this is wired.
  createSessionForChannel?: CreateSessionForChannel
  // Test seams: let fake adapters replace the real adapter wiring per id.
  createDiscordAdapter?: typeof createDiscordBotAdapter
  createDiscordUserAdapter?: typeof createDiscordAdapter
  createGithubAdapter?: typeof createGithubAdapter
  createInstagramAdapter?: typeof createInstagramAdapter
  createKakaotalkAdapter?: typeof createKakaotalkAdapter
  createLineAdapter?: typeof createLineAdapter
  createSlackAdapter?: typeof createSlackBotAdapter
  createSlackUserAdapter?: typeof createSlackAdapter
  createTeamsAdapter?: typeof createTeamsAdapter
  createTelegramAdapter?: typeof createTelegramBotAdapter
  createWebexAdapter?: typeof createWebexAdapter
  createWebexBotAdapter?: typeof createWebexBotAdapter
  // Wake-up gate: forwarded to the router, which calls
  // `permissions.has(origin, 'channel.respond')` BEFORE creating a
  // session for any inbound. Optional here to keep direct manager-level
  // tests easy to spin up; production wiring in src/run/index.ts always
  // passes `pluginsLoaded.permissions`. Omitting it falls through to the
  // router's grant-all default — see CreateChannelRouterOptions.
  permissions?: PermissionService
  // Forwarded to the router; intercepts DM inbounds carrying a role-claim
  // code. Production wiring sets this from the role-claim subsystem (see
  // src/run/index.ts). Tests typically omit it.
  claimHandler?: ClaimHandler
  tunnelUrlForChannel?: (channelName: string) => string | null
  // Whether the user declared a `tunnels[]` entry bound to this channel.
  // Lets channel-bound adapters distinguish "operator opted out of public
  // webhook delivery" from "operator opted in but the tunnel never produced
  // a URL" so error logs can be precise. Same shape as
  // `tunnelUrlForChannel` for consistency. Optional for tests.
  tunnelConfiguredForChannel?: (channelName: string) => boolean
  // Forwarded to the router as `stream`. When set, every inbound the
  // router sees is published as a tagged broadcast for inspect surfacing.
  // Production wiring (`src/run/index.ts`) always passes the agent's
  // Stream; tests typically omit it.
  stream?: Stream
  // Write-side of the GithubTokenBridge. The github adapter publishes its
  // per-repo App token minter here on start (App auth only) so plugin hooks
  // can resolve a token for ad-hoc `gh` commands. Tests omit it.
  githubTokenBridge?: GithubTokenBridge
  // Forwarded to the router as the /reload and /restart command handlers.
  // Production wiring (src/run/index.ts) supplies the reload-registry and
  // container-restart bindings; tests omit them so the commands stay
  // unregistered. See CreateChannelRouterOptions.onReload/onRestart.
  onReload?: () => Promise<string>
  onRestart?: (ctx?: RestartCommandContext) => Promise<string>
  // Forwarded to the router so idle GC and stale-rollover can pin a channel
  // session whose background subagent is still running (the next inbound would
  // otherwise spawn a duplicate child). Production wiring (src/run/index.ts)
  // supplies it from the LiveSubagentRegistry; tests omit it.
  newestRunningChildSubagentStartedAt?: (sessionId: string) => number | null
  // Forwarded to the router so the graceful-restart handoff can name the
  // background subagents a session was still awaiting. Same wiring shape as
  // newestRunningChildSubagentStartedAt; tests omit it.
  listRunningBackgroundSubagentNames?: (sessionId: string) => string[]
  // Forwarded to the router so an adapter-triggered work invalidation can stop
  // independent background sessions that a parent AgentSession abort cannot reach.
  cancelRunningSubagentsByWorkKey?: (
    workKey: string,
    reason: string,
  ) => Promise<{ matched: number; cancelled: number; failures: number }>
  // Persistent messenger SDKs usually reconnect themselves, but a host sleep/offline
  // cycle can leave a socket half-dead forever. The manager watches live adapters
  // and restarts one that stays disconnected past this grace period. Test seams are
  // optional so production uses normal timers/time.
  connectionRecovery?: {
    checkIntervalMs?: number
    disconnectedGraceMs?: number
    // Base delay for the failed-adapter retry backoff (`retryBaseMs * 2^(n-1)`,
    // capped at 15 minutes, jittered). Deliberately independent of
    // `checkIntervalMs`: a retry deadline is only observed on a tick, so a tick
    // as coarse as the base would round a jittered 30-36s deadline up to the
    // 60s tick and silently double every early delay.
    retryBaseMs?: number
    now?: () => number
    random?: () => number
    setInterval?: (fn: () => void, ms: number) => unknown
    clearInterval?: (handle: unknown) => void
  }
}

export type ChannelManager = {
  router: ChannelRouter
  start: () => Promise<void>
  stop: () => Promise<void>
  restartAdapter: (name: AdapterId) => Promise<void>
  reload: (options?: ChannelReloadOptions) => Promise<ChannelReloadDiff>
}

type AnyAdapter =
  | DiscordAdapter
  | DiscordBotAdapter
  | GithubAdapter
  | InstagramAdapter
  | LineAdapter
  | KakaotalkAdapter
  | SlackAdapter
  | SlackBotAdapter
  | TeamsAdapter
  | TelegramBotAdapter
  | WebexAdapter
  | WebexBotAdapter

// Credential signature is the comparison key for credential-rotation
// detection on reload. Discord and Telegram each use a single bot token;
// Slack needs both a bot token and an app-level token (Socket Mode);
// KakaoTalk authenticates via a structured multi-account block in
// secrets.json#channels.kakaotalk, so its signature is that block's content
// hash. The "credential" naming (vs "token") generalizes across the
// env-var-based adapters and KakaoTalk's account credential pathway.
type AdapterEntry = {
  adapter: AnyAdapter
  credentialSignature: string
  disconnectedSinceMs: number | null
  nextRecoveryRestartAtMs: number | null
  recoveryRestartAttempts: number
  recoveryRestartQueued: boolean
}

type FailedAdapter = {
  kind: 'start-failed' | 'missing-credentials'
  attempts: number
  failedSinceMs: number
  nextAttemptAtMs: number
  retryQueued: boolean
  nextLogAtMs: number
}

export type AdapterRestartOutcome = 'restarted' | 'recovery-pending' | 'stop-failed' | 'skipped'

// `already-current` is not a restart outcome: the live adapter is already on the
// new credential, so there was nothing to apply. It still has to be reported,
// because a named adapter that reports nothing reads as "not applied" and sends
// the caller to its fallback.
export type CredentialApplyOutcome = AdapterRestartOutcome | 'already-current'

export type ChannelReloadOptions = { applyCredentialRotation?: AdapterId }

export type ChannelReloadDiff = {
  started: string[]
  stopped: string[]
  restarted: string[]
  restartRequired: string[]
  credentialApply?: { adapter: AdapterId; outcome: CredentialApplyOutcome }
}

type ReloadAdapterOutcome = 'started' | 'stopped' | 'rotated' | 'already-current' | AdapterRestartOutcome | null

type StartAdapterResult =
  | { status: 'started' }
  | { status: 'disabled' }
  | { status: 'blocked' }
  | { status: 'aborted' }
  | {
      status: 'failed'
      kind: FailedAdapter['kind']
      detail: string
      inputSignature: string
    }

export function createChannelManager(options: ChannelManagerOptions): ChannelManager {
  const logger = options.logger ?? consoleLogger
  const env = options.env ?? process.env
  const router = createChannelRouter({
    agentDir: options.agentDir,
    configForAdapter: (adapter) => options.channelsConfigRef()[adapter],
    logger,
    ...(options.aliasesRef ? { configuredAliases: options.aliasesRef } : {}),
    ...(options.createSessionForChannel ? { createSessionForChannel: options.createSessionForChannel } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.claimHandler ? { claimHandler: options.claimHandler } : {}),
    ...(options.stream ? { stream: options.stream } : {}),
    ...(options.onReload ? { onReload: options.onReload } : {}),
    ...(options.onRestart ? { onRestart: options.onRestart } : {}),
    ...(options.newestRunningChildSubagentStartedAt
      ? { newestRunningChildSubagentStartedAt: options.newestRunningChildSubagentStartedAt }
      : {}),
    ...(options.listRunningBackgroundSubagentNames
      ? { listRunningBackgroundSubagentNames: options.listRunningBackgroundSubagentNames }
      : {}),
    ...(options.cancelRunningSubagentsByWorkKey
      ? { cancelRunningSubagentsByWorkKey: options.cancelRunningSubagentsByWorkKey }
      : {}),
  })
  const createDiscordBot = options.createDiscordAdapter ?? createDiscordBotAdapter
  const createDiscordUser = options.createDiscordUserAdapter ?? createDiscordAdapter
  const createGithub = options.createGithubAdapter ?? createGithubAdapter
  const createInstagram = options.createInstagramAdapter ?? createInstagramAdapter
  const createKakaotalk = options.createKakaotalkAdapter ?? createKakaotalkAdapter
  const createLine = options.createLineAdapter ?? createLineAdapter
  const createSlackBot = options.createSlackAdapter ?? createSlackBotAdapter
  const createSlackUser = options.createSlackUserAdapter ?? createSlackAdapter
  const createTeams = options.createTeamsAdapter ?? createTeamsAdapter
  const createTelegramAdapter = options.createTelegramAdapter ?? createTelegramBotAdapter
  const createWebex = options.createWebexAdapter ?? createWebexAdapter
  const createWebexBot = options.createWebexBotAdapter ?? createWebexBotAdapter

  const live = new Map<AdapterId, AdapterEntry>()
  const failed = new Map<AdapterId, FailedAdapter>()
  const failedInputSignatures = new WeakMap<FailedAdapter, string>()
  const perAdapterSerial = new Map<AdapterId, Promise<unknown>>()
  const recovery = options.connectionRecovery ?? {}
  const recoveryCheckIntervalMs = recovery.checkIntervalMs ?? 5_000
  const recoveryDisconnectedGraceMs = recovery.disconnectedGraceMs ?? 90_000
  const recoveryNow = recovery.now ?? (() => Date.now())
  const recoveryRandom = recovery.random ?? Math.random
  const recoverySetInterval = recovery.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const recoveryClearInterval =
    recovery.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  let recoveryTimer: unknown = null
  let running = false
  let lifecycleEpoch = 0

  const runSerially = <T>(name: AdapterId, op: () => Promise<T>): Promise<T> => {
    const prev = perAdapterSerial.get(name) ?? Promise.resolve()
    const next = prev.then(op, op)
    perAdapterSerial.set(
      name,
      next.catch(() => {}),
    )
    return next
  }

  const buildCredentialSignature = (name: AdapterId): { signature: string; missing: string[] } => {
    if (name === 'line') return buildLineSignature(options.agentDir)
    if (name === 'instagram') return buildInstagramSignature(options.agentDir)
    if (name === 'kakaotalk') return buildKakaotalkSignature(options.agentDir)
    if (name === 'webex') return buildWebexSignature(options.agentDir)
    if (name === 'teams') return buildTeamsSignature(options.agentDir)
    if (name === 'slack') return buildSlackSignature(options.agentDir)
    if (name === 'discord') return buildDiscordSignature(options.agentDir)
    if (name === 'github') return buildGithubSignature(options.agentDir)
    const requiredEnvs = TOKEN_ENV[name]
    const parts: string[] = []
    const missing: string[] = []
    for (const key of requiredEnvs) {
      const value = env[key]
      if (value === undefined || value.trim() === '') missing.push(key)
      else parts.push(`${key}=${value}`)
    }
    return { signature: parts.join('|'), missing }
  }

  const buildAdapter = (name: AdapterId, cfg: ChannelAdapterConfig): AnyAdapter | null => {
    if (name === 'discord-bot') {
      const token = env.DISCORD_BOT_TOKEN
      if (token === undefined || token.trim() === '') return null
      return createDiscordBot({
        agentDir: options.agentDir,
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        logger,
      })
    }
    if (name === 'slack-bot') {
      const token = env.SLACK_BOT_TOKEN
      const appToken = env.SLACK_APP_TOKEN
      if (token === undefined || token.trim() === '') return null
      if (appToken === undefined || appToken.trim() === '') return null
      return createSlackBot({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        appToken,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
      })
    }
    if (name === 'line') {
      const credentialsStore = createContainerLineCredentialStore(options.agentDir, options.secretsProvider ?? null)
      if (credentialsStore === null) return null
      return createLine({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore,
      })
    }
    if (name === 'instagram') {
      const credentialsStore = createContainerInstagramCredentialStore(
        options.agentDir,
        options.secretsProvider ?? null,
      )
      if (credentialsStore === null) return null
      return createInstagram({
        agentDir: options.agentDir,
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore,
      })
    }
    if (name === 'kakaotalk') {
      const credentialsStore = createContainerKakaoCredentialStore(options.agentDir, options.secretsProvider ?? null)
      if (credentialsStore === null) return null
      return createKakaotalk({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore,
      })
    }
    if (name === 'slack') {
      const credentialsStore = createContainerSlackCredentialStore(options.agentDir, options.secretsProvider ?? null)
      if (credentialsStore === null) return null
      return createSlackUser({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore,
      })
    }
    if (name === 'discord') {
      const credentialsStore = createContainerDiscordCredentialStore(options.agentDir, options.secretsProvider ?? null)
      if (credentialsStore === null) return null
      return createDiscordUser({
        agentDir: options.agentDir,
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore,
      })
    }
    if (name === 'webex') {
      const credentialsStore = createContainerWebexCredentialStore(options.agentDir, options.secretsProvider ?? null)
      if (credentialsStore === null) return null
      return createWebex({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore,
      })
    }
    if (name === 'teams') {
      const credentialsStore = createContainerTeamsCredentialStore(options.agentDir, options.secretsProvider ?? null)
      if (credentialsStore === null) return null
      return createTeams({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore,
      })
    }
    if (name === 'github') {
      const secrets = readGithubSecrets(options.agentDir)
      if (secrets === null) return null
      return createGithub({
        router,
        configRef: () => (options.channelsConfigRef()[name] ?? cfg) as ChannelAdapterConfig & GithubAdapterConfig,
        secrets,
        agentDir: options.agentDir,
        logger,
        tunnelUrl: () => options.tunnelUrlForChannel?.('github') ?? null,
        tunnelConfiguredForChannel: () => options.tunnelConfiguredForChannel?.('github') ?? false,
        ...(options.githubTokenBridge !== undefined ? { githubTokenBridge: options.githubTokenBridge } : {}),
      })
    }
    if (name === 'telegram-bot') {
      const token = env.TELEGRAM_BOT_TOKEN
      if (token === undefined || token.trim() === '') return null
      return createTelegramAdapter({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        logger,
      })
    }
    if (name === 'webex-bot') {
      const token = env.WEBEX_BOT_TOKEN
      if (token === undefined || token.trim() === '') return null
      return createWebexBot({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
      })
    }
    return null
  }

  const buildFailedInputSignature = (
    name: AdapterId,
    cfg: ChannelAdapterConfig,
    credentials = buildCredentialSignature(name),
  ): string => JSON.stringify([cfg, credentials.signature, credentials.missing])

  const cleanupPartialStart = async (adapter: AnyAdapter): Promise<void> => {
    try {
      await adapter.stop()
    } catch {}
  }

  const startAdapterOnce = async (
    name: AdapterId,
    cfg: ChannelAdapterConfig,
    canCommit: () => boolean,
  ): Promise<StartAdapterResult | { status: 'credential-changed' }> => {
    if (!canCommit()) return { status: 'aborted' }
    if (cfg.enabled === false) {
      logger.info(`[channels] adapter "${name}" is disabled; skipping`)
      return { status: 'disabled' }
    }
    const credentials = buildCredentialSignature(name)
    const { signature, missing } = credentials
    if (missing.length > 0) {
      return {
        status: 'failed',
        kind: 'missing-credentials',
        detail: `missing credentials: ${missing.join(', ')}`,
        inputSignature: buildFailedInputSignature(name, cfg, credentials),
      }
    }
    const adapter = buildAdapter(name, cfg)
    if (adapter === null) {
      logger.error(`[channels] adapter "${name}" could not be constructed; skipping`)
      return { status: 'blocked' }
    }
    try {
      await adapter.start()
      if (!canCommit()) {
        await cleanupPartialStart(adapter)
        return { status: 'aborted' }
      }
      if (buildCredentialSignature(name).signature !== signature) {
        await cleanupPartialStart(adapter)
        return { status: 'credential-changed' }
      }
      live.set(name, {
        adapter,
        credentialSignature: signature,
        disconnectedSinceMs: adapter.isConnected() ? null : recoveryNow(),
        nextRecoveryRestartAtMs: null,
        recoveryRestartAttempts: 0,
        recoveryRestartQueued: false,
      })
      return { status: 'started' }
    } catch (err) {
      await cleanupPartialStart(adapter)
      if (!canCommit()) return { status: 'aborted' }
      return {
        status: 'failed',
        kind: 'start-failed',
        detail: `failed to start: ${describeError(err)}`,
        inputSignature: buildFailedInputSignature(name, cfg, credentials),
      }
    }
  }

  // The adapter reads the credential file itself inside start(), so a write
  // landing mid-start would leave `live` holding a signature that describes a
  // different token than the one now in memory: the entry looks current while
  // running a superseded credential, and the next reload sees no rotation to
  // apply. Retry once, which covers a renewal write racing a start; a second
  // change means a persistent concurrent writer, and spinning on it is worse
  // than handing the adapter to supervision's backoff.
  const startAdapter = async (
    name: AdapterId,
    cfg: ChannelAdapterConfig,
    canCommit: () => boolean,
  ): Promise<StartAdapterResult> => {
    for (let attempt = 0; ; attempt += 1) {
      const result = await startAdapterOnce(name, cfg, canCommit)
      if (result.status !== 'credential-changed') return result
      if (attempt >= 1) {
        return {
          status: 'failed',
          kind: 'start-failed',
          detail: 'credentials changed twice during start',
          inputSignature: buildFailedInputSignature(name, cfg, buildCredentialSignature(name)),
        }
      }
    }
  }

  const retryCapMs = 15 * 60 * 1_000
  const retryHeartbeatMs = 6 * 60 * 60 * 1_000
  const retryBaseMs = Math.max(1, recovery.retryBaseMs ?? 30_000)

  const nominalRetryDelayMs = (attempts: number): number =>
    Math.min(retryCapMs, retryBaseMs * 2 ** Math.min(30, attempts - 1))

  const retryDelayMs = (attempts: number): number => {
    const nominal = nominalRetryDelayMs(attempts)
    const spread = nominal * 0.4
    // A deadline is only ever observed on a supervision tick, which rounds it
    // UP by as much as one interval. Narrow the jitter spread by that interval
    // so the OBSERVED retry still lands inside the advertised ±20% window
    // instead of up to a tick beyond it. When the tick is coarser than the
    // window there is no room to compensate, so fall back to plain jitter and
    // let quantization dominate rather than collapsing every delay to the floor.
    const usableSpread = recoveryCheckIntervalMs < spread ? spread - recoveryCheckIntervalMs : spread
    return Math.min(retryCapMs, Math.floor(nominal * 0.8 + recoveryRandom() * usableSpread))
  }

  const recordFailure = (
    name: AdapterId,
    cfg: ChannelAdapterConfig,
    failure: Extract<StartAdapterResult, { status: 'failed' }>,
    previous?: FailedAdapter,
  ): FailedAdapter => {
    const now = recoveryNow()
    const continuing = previous !== undefined && failed.get(name) === previous
    const attempts = continuing ? previous.attempts + 1 : 1
    const delayMs = retryDelayMs(attempts)
    const nominalDelayMs = nominalRetryDelayMs(attempts)
    const previousNominalDelayMs = attempts > 1 ? nominalRetryDelayMs(attempts - 1) : 0
    const entry: FailedAdapter = continuing
      ? previous
      : {
          kind: failure.kind,
          attempts,
          failedSinceMs: now,
          nextAttemptAtMs: now + delayMs,
          retryQueued: false,
          nextLogAtMs: Number.POSITIVE_INFINITY,
        }

    entry.kind = failure.kind
    entry.attempts = attempts
    entry.nextAttemptAtMs = now + delayMs
    entry.retryQueued = false

    const reachedCap = nominalDelayMs === retryCapMs
    const justReachedCap = reachedCap && previousNominalDelayMs < retryCapMs
    if (justReachedCap) entry.nextLogAtMs = now + retryHeartbeatMs

    if (attempts === 1) {
      if (reachedCap) entry.nextLogAtMs = now + retryHeartbeatMs
      logger.error(`[channels] adapter "${name}" ${failure.detail} (attempt ${attempts}); retrying in ${delayMs}ms`)
    } else if (nominalDelayMs > previousNominalDelayMs) {
      logger.warn(
        `[channels] adapter "${name}" still unavailable after ${Math.round(now - entry.failedSinceMs)}ms (attempt ${attempts}; ${failure.detail}); retrying in ${delayMs}ms`,
      )
    } else if (reachedCap && now >= entry.nextLogAtMs) {
      logger.warn(
        `[channels] adapter "${name}" still unavailable after ${Math.round(now - entry.failedSinceMs)}ms (attempt ${attempts}; ${failure.detail}); retrying in ${delayMs}ms`,
      )
      entry.nextLogAtMs = now + retryHeartbeatMs
    }

    failed.set(name, entry)
    failedInputSignatures.set(entry, failure.inputSignature)
    return entry
  }

  const applyStartResult = (
    name: AdapterId,
    cfg: ChannelAdapterConfig,
    result: StartAdapterResult,
    previousFailure?: FailedAdapter,
  ): boolean => {
    if (result.status === 'started') {
      const recoveryState = failed.get(name) ?? previousFailure
      failed.delete(name)
      if (recoveryState === undefined) {
        logger.info(`[channels] adapter "${name}" started`)
      } else {
        logger.info(
          `[channels] adapter "${name}" recovered after ${Math.round(recoveryNow() - recoveryState.failedSinceMs)}ms (${recoveryState.attempts} failed attempts)`,
        )
      }
      return true
    }
    if (result.status === 'failed') {
      recordFailure(name, cfg, result, previousFailure)
    } else if (previousFailure !== undefined && failed.get(name) === previousFailure) {
      failed.delete(name)
    }
    return false
  }

  const recordMissingCredentialFailure = (
    name: AdapterId,
    cfg: ChannelAdapterConfig,
    credentials: { signature: string; missing: string[] },
  ): void => {
    recordFailure(
      name,
      cfg,
      {
        status: 'failed',
        kind: 'missing-credentials',
        detail: `missing credentials: ${credentials.missing.join(', ')}`,
        inputSignature: buildFailedInputSignature(name, cfg, credentials),
      },
      failed.get(name),
    )
  }

  const recordUnexpectedStartFailure = (
    name: AdapterId,
    cfg: ChannelAdapterConfig,
    err: unknown,
    previous?: FailedAdapter,
  ): void => {
    recordFailure(
      name,
      cfg,
      {
        status: 'failed',
        kind: 'start-failed',
        detail: `failed to start: ${describeError(err)}`,
        inputSignature: buildFailedInputSignature(name, cfg),
      },
      previous,
    )
  }

  const stopAdapter = async (name: AdapterId): Promise<boolean> => {
    const entry = live.get(name)
    if (!entry) return true
    try {
      await entry.adapter.stop()
      if (live.get(name) === entry) live.delete(name)
      logger.info(`[channels] adapter "${name}" stopped`)
      return true
    } catch (err) {
      logger.error(`[channels] adapter "${name}" failed to stop: ${describeError(err)}`)
      return false
    }
  }

  // Callers must already hold this adapter's `runSerially` barrier. Re-entering
  // it here would queue behind the caller's own still-open turn and deadlock,
  // which is exactly what happens if `reload` calls the public `restartAdapter`
  // from inside its per-adapter block.
  const restartAdapterLocked = async (name: AdapterId): Promise<AdapterRestartOutcome> => {
    const currentCfg = options.channelsConfigRef()[name]
    if (currentCfg === undefined || currentCfg.enabled === false) return 'skipped'
    const previousFailure = failed.get(name)
    failed.delete(name)
    if (!(await stopAdapter(name))) return 'stop-failed'
    const queuedEpoch = lifecycleEpoch
    const result = await startAdapter(name, currentCfg, () => running && queuedEpoch === lifecycleEpoch)
    return applyStartResult(name, currentCfg, result, previousFailure) ? 'restarted' : 'recovery-pending'
  }

  const superviseAdapters = (): void => {
    if (!running) return
    const now = recoveryNow()
    for (const [name, entry] of live) {
      if (entry.adapter.isConnected()) {
        void router
          .recoverWaitingReactions(name)
          .catch((err) =>
            logger.warn(`[channels] waiting reaction cleanup failed adapter="${name}": ${describeError(err)}`),
          )
        entry.disconnectedSinceMs = null
        entry.nextRecoveryRestartAtMs = null
        entry.recoveryRestartAttempts = 0
        entry.recoveryRestartQueued = false
        continue
      }
      if (entry.disconnectedSinceMs === null) {
        entry.disconnectedSinceMs = now
        logger.warn(`[channels] adapter "${name}" is disconnected; waiting for SDK recovery`)
        continue
      }
      const disconnectedForMs = now - entry.disconnectedSinceMs
      const nextRestartAtMs = Math.max(
        entry.disconnectedSinceMs + recoveryDisconnectedGraceMs,
        entry.nextRecoveryRestartAtMs ?? Number.NEGATIVE_INFINITY,
      )
      if (now < nextRestartAtMs || entry.recoveryRestartQueued) continue
      entry.recoveryRestartQueued = true
      logger.warn(
        `[channels] adapter "${name}" disconnected for ${Math.round(disconnectedForMs)}ms; restarting adapter`,
      )
      const queuedEpoch = lifecycleEpoch
      void runSerially(name, async () => {
        try {
          const current = live.get(name)
          if (!running || queuedEpoch !== lifecycleEpoch || current !== entry) return
          const currentCfg = options.channelsConfigRef()[name]
          if (currentCfg === undefined || currentCfg.enabled === false) {
            logger.info(`[channels] recovery restart for "${name}" skipped; adapter no longer enabled`)
            return
          }
          const stopped = await stopAdapter(name)
          if (!stopped || !running || queuedEpoch !== lifecycleEpoch) return
          const latestCfg = options.channelsConfigRef()[name]
          if (latestCfg === undefined || latestCfg.enabled === false) return
          try {
            const result = await startAdapter(name, latestCfg, () => {
              const cfg = options.channelsConfigRef()[name]
              return running && queuedEpoch === lifecycleEpoch && cfg !== undefined && cfg.enabled !== false
            })
            applyStartResult(name, latestCfg, result)
            const replacement = live.get(name)
            if (replacement !== undefined && !replacement.adapter.isConnected()) {
              const attempts = entry.recoveryRestartAttempts + 1
              replacement.recoveryRestartAttempts = attempts
              replacement.nextRecoveryRestartAtMs = recoveryNow() + retryDelayMs(attempts)
            }
          } catch (err) {
            const cfg = options.channelsConfigRef()[name]
            if (running && queuedEpoch === lifecycleEpoch && cfg !== undefined && cfg.enabled !== false) {
              recordUnexpectedStartFailure(name, cfg, err)
            }
          }
        } finally {
          if (live.get(name) === entry) entry.recoveryRestartQueued = false
        }
      }).catch((err) => {
        logger.error(`[channels] adapter "${name}" recovery supervision failed: ${describeError(err)}`)
      })
    }

    for (const [name, entry] of failed) {
      if (entry.nextAttemptAtMs > now || entry.retryQueued) continue
      entry.retryQueued = true
      const queuedEpoch = lifecycleEpoch
      void runSerially(name, async () => {
        try {
          if (!running || queuedEpoch !== lifecycleEpoch || failed.get(name) !== entry) return
          const currentCfg = options.channelsConfigRef()[name]
          if (currentCfg === undefined || currentCfg.enabled === false) {
            if (failed.get(name) === entry) failed.delete(name)
            return
          }
          try {
            const result = await startAdapter(name, currentCfg, () => {
              const cfg = options.channelsConfigRef()[name]
              return (
                running &&
                queuedEpoch === lifecycleEpoch &&
                failed.get(name) === entry &&
                cfg !== undefined &&
                cfg.enabled !== false
              )
            })
            applyStartResult(name, currentCfg, result, entry)
          } catch (err) {
            const cfg = options.channelsConfigRef()[name]
            if (
              running &&
              queuedEpoch === lifecycleEpoch &&
              failed.get(name) === entry &&
              cfg !== undefined &&
              cfg.enabled !== false
            ) {
              recordUnexpectedStartFailure(name, cfg, err, entry)
            }
          }
        } finally {
          if (failed.get(name) === entry) entry.retryQueued = false
        }
      }).catch((err) => {
        logger.error(`[channels] adapter "${name}" retry supervision failed: ${describeError(err)}`)
      })
    }
  }

  const startRecoveryTimer = (): void => {
    if (recoveryTimer !== null) return
    recoveryTimer = recoverySetInterval(superviseAdapters, recoveryCheckIntervalMs)
  }

  const stopRecoveryTimer = (): void => {
    if (recoveryTimer === null) return
    recoveryClearInterval(recoveryTimer)
    recoveryTimer = null
  }

  return {
    router,

    async start(): Promise<void> {
      const cfg = options.channelsConfigRef()
      running = true
      const startedEpoch = lifecycleEpoch
      // Safe to fan out: `live` and every router registry are keyed by adapter
      // name, so concurrent starts never collide. Serial start would otherwise pay
      // the sum of each adapter's connect latency instead of just the slowest.
      const starts = ADAPTER_IDS.flatMap((name) => {
        const adapterCfg = cfg[name]
        if (adapterCfg === undefined) return []
        // Mark configured up front, regardless of start outcome: a failed start
        // (e.g. expired token) never registers a history callback, and the router
        // uses this flag to answer "configured but unavailable" instead of the
        // misleading "not supported".
        router.setAdapterConfigured(name, adapterCfg.enabled !== false)
        return [
          runSerially(name, async () => {
            const result = await startAdapter(name, adapterCfg, () => running && startedEpoch === lifecycleEpoch)
            return applyStartResult(name, adapterCfg, result)
          }),
        ]
      })
      // Await every launched start to settle BEFORE surfacing a failure.
      // `startAdapter` converts expected per-adapter failures to `false`, so a
      // rejection is an unexpected throw (e.g. `buildAdapter`) that must still
      // fail-fast. But bailing on the first rejection (plain `Promise.all`) would
      // leave sibling starts in flight, letting a late `live.set` orphan an adapter
      // that the caller's subsequent `stop()` never sees. Settle all, then rethrow.
      const results = await Promise.allSettled(starts)
      const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      // An unexpected throw leaves the manager half-built, so arming supervision
      // would retry against a state the caller is about to tear down.
      if (failure !== undefined) throw failure.reason
      startRecoveryTimer()
    },

    async stop(): Promise<void> {
      // Everything that gates a queued start must flip BEFORE the first await,
      // or a retry already sitting in `perAdapterSerial` re-registers an adapter
      // after teardown and leaks it past the caller's stop().
      running = false
      lifecycleEpoch += 1
      stopRecoveryTimer()
      failed.clear()
      // Drain every id, not just the live ones: an in-flight retry for a
      // currently-dead adapter has to be awaited too, and its `canCommit` will
      // have aborted it by the time this barrier runs.
      await Promise.all(ADAPTER_IDS.map((name) => runSerially(name, () => stopAdapter(name))))
      await router.stop()
    },

    async restartAdapter(name: AdapterId): Promise<void> {
      await runSerially(name, async () => {
        const currentCfg = options.channelsConfigRef()[name]
        if (currentCfg === undefined) {
          logger.info(`[channels] restartAdapter('${name}'): adapter config missing, skipping`)
          return
        }
        if (currentCfg.enabled === false) {
          logger.info(`[channels] restartAdapter('${name}'): adapter is disabled, skipping`)
          return
        }
        // Deliberately not gated on `live.has(name)`: the whole point is to let
        // an operator revive an adapter that failed to start and is therefore
        // absent from `live`.
        await restartAdapterLocked(name)
      })
    },

    async reload(reloadOptions: ChannelReloadOptions = {}): Promise<ChannelReloadDiff> {
      const cfg = options.channelsConfigRef()
      const started: string[] = []
      const stopped: string[] = []
      const restarted: string[] = []
      const restartRequired: string[] = []
      let credentialApply: ChannelReloadDiff['credentialApply']

      for (const name of ADAPTER_IDS) {
        const desired = cfg[name]
        if (desired === undefined || desired.enabled === false) {
          router.setAdapterConfigured(name, false)
          failed.delete(name)
          if (live.has(name)) {
            await runSerially(name, () => stopAdapter(name))
            stopped.push(name)
          }
          continue
        }
        router.setAdapterConfigured(name, true)
        // The whole decision runs inside the barrier. Choosing a branch from
        // `live.has(name)` out here races a queued retry: it can go live (or
        // die) before the barrier admits us, and the branch we picked would
        // then either start a second instance or skip credential
        // reconciliation on an adapter that is now live with a stale token.
        const outcome = await runSerially(name, async (): Promise<ReloadAdapterOutcome> => {
          const latest = options.channelsConfigRef()[name]
          if (latest === undefined || latest.enabled === false) return null
          const credentials = buildCredentialSignature(name)
          const { signature, missing } = credentials
          const current = live.get(name)

          if (missing.length > 0) {
            // Required credentials disappeared (env vars removed from .env, or
            // KakaoTalk credentials removed from secrets.json). Continuing to use the
            // in-memory credentials would silently honor a credential the
            // operator explicitly removed, so stop the adapter instead of
            // waiting for a manual restart.
            if (current === undefined) {
              recordMissingCredentialFailure(name, latest, credentials)
              return null
            }
            logger.warn(
              `[channels] adapter "${name}" missing credentials after reload (${missing.join(', ')}); stopping`,
            )
            if (!(await stopAdapter(name))) return null
            // Without this the adapter leaves `live` and never enters `failed`,
            // so supervision loses it entirely and restoring the credential
            // could not revive it without another manual reload.
            recordMissingCredentialFailure(name, latest, credentials)
            return 'stopped'
          }

          const named = reloadOptions.applyCredentialRotation === name

          if (current !== undefined) {
            if (signature === current.credentialSignature) return named ? 'already-current' : null
            // Bouncing a live adapter drops the channel turns it is currently
            // serving, so a plain operator reload only reports the rotation.
            // Only a caller that names this exact adapter — hostd, right after
            // it rewrote that credential on disk — gets the destructive path.
            if (!named) return 'rotated'
            return await restartAdapterLocked(name)
          }

          // A reload is the operator's signal that inputs changed, so a
          // pending backoff timer is stale — retry now rather than making
          // them wait out up to fifteen minutes.
          const previousFailure = failed.get(name)
          if (previousFailure !== undefined) {
            const changed =
              failedInputSignatures.get(previousFailure) !== buildFailedInputSignature(name, latest, credentials)
            if (changed) failed.delete(name)
            // A queued retry will read the new credential when it fires, so the
            // rotation is on its way even though nothing happened right here.
            else if (previousFailure.retryQueued) return named ? 'recovery-pending' : null
          }
          const queuedEpoch = lifecycleEpoch
          const result = await startAdapter(name, latest, () => running && queuedEpoch === lifecycleEpoch)
          if (applyStartResult(name, latest, result, previousFailure)) return 'started'
          return named ? 'recovery-pending' : null
        })

        if (outcome === 'started') {
          started.push(name)
          // Starting a down adapter applies the rotation just as much as
          // bouncing a live one; reporting nothing here would read as a failure
          // and send the caller to a container restart it does not need.
          if (reloadOptions.applyCredentialRotation === name) {
            credentialApply = { adapter: name, outcome: 'restarted' }
          }
        } else if (outcome === 'stopped') stopped.push(name)
        else if (outcome === 'rotated') restartRequired.push(`${name} (${rotationReason(name)})`)
        else if (outcome !== null) {
          credentialApply = { adapter: name, outcome }
          if (outcome === 'restarted') restarted.push(name)
          // A stop that failed leaves the OLD credential live, so the rotation
          // has not been applied and still owes a restart. `recovery-pending`
          // does not: the adapter is already down and supervision is retrying
          // it with the new credential on backoff.
          else if (outcome === 'stop-failed') restartRequired.push(`${name} (${rotationReason(name)})`)
        }
      }

      return { started, stopped, restarted, restartRequired, ...(credentialApply ? { credentialApply } : {}) }
    },
  }
}

// Token-based adapters only. Personal-account credentials live in
// secrets.json#channels.<adapter>, not in env, so they go through
// structured-block signatures instead.
const TOKEN_ENV: Record<
  Exclude<AdapterId, 'kakaotalk' | 'line' | 'instagram' | 'github' | 'webex' | 'teams' | 'slack' | 'discord'>,
  readonly string[]
> = {
  'discord-bot': ['DISCORD_BOT_TOKEN'],
  'slack-bot': ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  'telegram-bot': ['TELEGRAM_BOT_TOKEN'],
  'webex-bot': ['WEBEX_BOT_TOKEN'],
}

// Personal-account adapters (line/kakaotalk/slack/discord/webex) need a
// container-stage secrets provider. It's resolved ONCE at the composition root
// (createRuntimeCapabilities in src/run/index.ts) and threaded in via
// `secretsProvider`; a null value (hostd triple absent — e.g. a lost first-boot
// spawn race, or a managed profile with no write-back wired) lets buildAdapter
// skip the adapter instead of crashing the whole channel manager.
function createContainerDiscordCredentialStore(
  agentDir: string,
  secretsProvider: RuntimeSecretsProvider | null,
): SecretsDiscordCredentialStore | null {
  if (secretsProvider === null) return null
  return new SecretsDiscordCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostProvider: secretsProvider,
  })
}

function buildDiscordSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.discord
    if (!isDiscordCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.discord'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.discord@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.discord (${describeError(err)})`] }
  }
}

function createContainerSlackCredentialStore(
  agentDir: string,
  secretsProvider: RuntimeSecretsProvider | null,
): SecretsSlackCredentialStore | null {
  if (secretsProvider === null) return null
  return new SecretsSlackCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostProvider: secretsProvider,
  })
}

function buildSlackSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.slack
    if (!isSlackCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.slack'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.slack@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.slack (${describeError(err)})`] }
  }
}

function createContainerWebexCredentialStore(
  agentDir: string,
  secretsProvider: RuntimeSecretsProvider | null,
): SecretsWebexCredentialStore | null {
  if (secretsProvider === null) return null
  return new SecretsWebexCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostProvider: secretsProvider,
  })
}

function buildWebexSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.webex
    if (!isWebexCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.webex'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.webex@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.webex (${describeError(err)})`] }
  }
}

function createContainerTeamsCredentialStore(
  agentDir: string,
  secretsProvider: RuntimeSecretsProvider | null,
): SecretsTeamsCredentialStore | null {
  if (secretsProvider === null) return null
  return new SecretsTeamsCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostProvider: secretsProvider,
  })
}

// Personal-account adapters authenticate as a user, so their whole credential
// block rotates; token-based bot adapters only swap an env token.
function rotationReason(name: AdapterId): string {
  return name === 'kakaotalk' ||
    name === 'line' ||
    name === 'instagram' ||
    name === 'webex' ||
    name === 'teams' ||
    name === 'slack' ||
    name === 'discord'
    ? 'credential rotation'
    : 'token rotation'
}

function buildTeamsSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.teams
    if (!isTeamsCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.teams'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.teams@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.teams (${describeError(err)})`] }
  }
}

function createContainerKakaoCredentialStore(
  agentDir: string,
  secretsProvider: RuntimeSecretsProvider | null,
): SecretsKakaoCredentialStore | null {
  if (secretsProvider === null) return null
  return new SecretsKakaoCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostProvider: secretsProvider,
  })
}

function buildKakaotalkSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.kakaotalk
    if (!isKakaoCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.kakaotalk'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.kakaotalk@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.kakaotalk (${describeError(err)})`] }
  }
}

function createContainerLineCredentialStore(
  agentDir: string,
  secretsProvider: RuntimeSecretsProvider | null,
): SecretsLineCredentialStore | null {
  if (secretsProvider === null) return null
  return new SecretsLineCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostProvider: secretsProvider,
  })
}

function buildLineSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.line
    if (!isLineCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.line'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.line@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.line (${describeError(err)})`] }
  }
}

function createContainerInstagramCredentialStore(
  agentDir: string,
  secretsProvider: RuntimeSecretsProvider | null,
): SecretsInstagramCredentialStore | null {
  if (secretsProvider === null) return null
  return new SecretsInstagramCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostProvider: secretsProvider,
  })
}

function buildInstagramSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.instagram
    if (!isInstagramCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.instagram'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.instagram@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.instagram (${describeError(err)})`] }
  }
}

function buildGithubSignature(agentDir: string): { signature: string; missing: string[] } {
  const block = readGithubSecrets(agentDir)
  if (block === null) return { signature: '', missing: ['secrets.json#channels.github'] }
  const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
  return { signature: `secrets.json#channels.github@sha256:${digest}`, missing: [] }
}

function readGithubSecrets(agentDir: string): GithubSecretsBlock | null {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.github
    return isGithubSecretsBlock(block) ? block : null
  } catch {
    return null
  }
}

function isGithubSecretsBlock(value: unknown): value is GithubSecretsBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const auth = record.auth
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) return false
  const authType = (auth as Record<string, unknown>).type
  return authType === 'pat' || authType === 'app'
}

function isKakaoCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isLineCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isInstagramCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isSlackCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isDiscordCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isWebexCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isTeamsCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}
