import type { GithubTokenBridge } from '@/channels/github-token-bridge'
import type { ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig, GithubAdapterConfig } from '@/channels/schema'
import type { ChannelSelfIdentityResolver, InboundMessage, RouteReceipt } from '@/channels/types'
import { resolveSecret } from '@/secrets/resolve'
import type { GithubSecretsBlock } from '@/secrets/schema'

import { describeError } from '../../describe-error'
import { canonicalGithubRepo } from '../../github-repo'
import { withOutboundAccount } from '../outbound-account'
import { buildAuthStrategy, type GithubAuthContext } from './auth'
import { createGithubChannelNameResolver } from './channel-resolver'
import { createDeliveryDedup } from './dedup'
import { findPermissionGaps } from './event-permissions'
import { createGithubFetchAttachmentCallback } from './fetch-attachment'
import { createGithubHistoryCallback } from './history'
import { createGithubWebhookHandler, processVerifiedGithubDelivery, type GithubWebhookHandlerOptions } from './inbound'
import { applyManagedPath, buildManagedPath, resolveAgentId } from './managed-path'
import { createGithubMembershipResolver } from './membership'
import { createGithubOutboundCallback } from './outbound'
import {
  buildAppPermissionPreflightGuidance,
  buildPermissionGuidance,
  parseListHooksPermissionStatus,
} from './permission-guidance'
import { createGithubReactionCallback, createGithubRemoveReactionCallback } from './reactions'
import { createGithubOwnReactionCallbacks } from './reactions'
import { loadReconcileCooldownStore, type ReconcileCooldownStore } from './reconcile-cooldown-store'
import { reconcileOpenPrs } from './reconcile-open-prs'
import { createRecoveredGuidLog, recoverFailedGithubDeliveries } from './recover-failed-deliveries'
import { createGithubRecoveryCallbacks } from './recovery'
import { createGithubReviewStateResolver } from './review-state'
import { createGithubReviewSubmitter } from './review-submitter'
import { createGithubReviewThreadResolver } from './review-thread-resolver'
import { createTeamMembershipChecker } from './team-membership'
import { deregisterGithubWebhooks, registerGithubWebhooks, type WebhookRegistrationResult } from './webhook-register'

export type GithubAdapterLogger = {
  info: (m: string) => void
  warn: (m: string) => void
  error: (m: string) => void
}

export type GithubAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig & GithubAdapterConfig
  secrets: GithubSecretsBlock
  agentDir: string
  logger?: GithubAdapterLogger
  fetchImpl?: typeof fetch
  httpListenImpl?: (port: number, handler: (req: Request) => Promise<Response>) => { stop: () => Promise<void> }
  tunnelUrl?: () => string | null
  // Whether a channel-bound tunnel exists in typeclaw.json#tunnels[] for the
  // github channel. Used to distinguish "no tunnel configured (operator opted
  // out)" from "tunnel configured but not producing a URL (something is
  // wrong)" so the skip-registration log can be precise and actionable.
  // Optional so tests that don't exercise the tunnel-status path can omit it.
  tunnelConfiguredForChannel?: () => boolean
  // Sleep between learning the public webhook URL and telling GitHub about
  // it. cloudflared prints the trycloudflare.com URL as soon as the control
  // connection comes up, but the Cloudflare edge needs a beat to start
  // routing traffic for that hostname. If we register with GitHub the
  // instant we know the URL, GitHub's automatic `ping` delivery races the
  // edge and lands "failed to connect to host". 2s is enough on every
  // network we've tested; tests pass 0 to skip.
  webhookRegistrationDelayMs?: number
  // Test-only: replaces the wall-clock sleep used for the registration
  // delay above. Production leaves it undefined and we use `setTimeout`.
  sleep?: (ms: number) => Promise<void>
  // How often to proactively refresh a PAT and update GH_TOKEN
  // when the adapter is running but has not made an outbound API call
  // recently. Zero disables the background refresh entirely.
  // Default: 30 minutes.
  tokenRefreshIntervalMs?: number
  // Test-only: replaces `setInterval` so tests can control when the
  // background refresh fires without waiting on real wall-clock time.
  setInterval?: (handler: () => void, ms: number) => { clear: () => void }
  // How often to sweep each managed hook's GitHub delivery log for events whose
  // inbound delivery failed (and that GitHub never redelivered), re-injecting
  // them through the live event path. Zero disables the sweep. Default: 5 min.
  deliveryRecoveryIntervalMs?: number
  // How often to re-run the open-PR reconcile pass after the initial start()
  // pass, so a genuinely-missed PR recovers without another restart. Per-PR
  // replay is bounded by the durable cooldown store. Zero disables the periodic
  // re-run (the start() pass still fires). Default: 30 min.
  reconcileIntervalMs?: number
  // Write-side of the GithubTokenBridge. On App-auth start the adapter
  // registers a per-repo minter here so runtime consumers can resolve a token
  // for validated `gh` commands and backup; it unregisters on stop. PAT auth
  // does not register (the seeded GH_TOKEN already covers every repo a
  // classic PAT can reach, and a fine-grained PAT cannot be re-minted per repo).
  githubTokenBridge?: GithubTokenBridge
}

export type GithubAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

const consoleLogger: GithubAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

const DEFAULT_WEBHOOK_REGISTRATION_DELAY_MS = 2_000
const DEFAULT_TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_DELIVERY_RECOVERY_INTERVAL_MS = 5 * 60 * 1000
// GitHub retains the delivery log for 3 days; sweep a little under that so a
// failed delivery is always still listable on the next interval.
const DELIVERY_RECOVERY_LOOKBACK_MS = 70 * 60 * 60 * 1000
// Bounds an LLM-session storm if a bad tunnel window drops a large burst.
const MAX_RECOVERED_PER_SWEEP = 50
// The reconcile pass reruns on this cadence so a genuinely-missed `opened`
// recovers without waiting for another restart. Per-PR replay is bounded by the
// durable cooldown store, so a tick is cheap when nothing new needs review.
const DEFAULT_RECONCILE_INTERVAL_MS = 30 * 60 * 1000

export function createGithubAdapter(options: GithubAdapterOptions): GithubAdapter {
  const logger = options.logger ?? consoleLogger
  const fetchImpl = options.fetchImpl ?? fetch
  const webhookRegistrationDelayMs = options.webhookRegistrationDelayMs ?? DEFAULT_WEBHOOK_REGISTRATION_DELAY_MS
  const sleep = options.sleep ?? defaultSleep
  const auth = buildAuthStrategy({ auth: options.secrets.auth, fetchImpl })
  const webhookSecret = resolveSecret(options.secrets.webhookSecret, undefined, process.env)
  if (webhookSecret === undefined || webhookSecret.trim() === '') throw new Error('GitHub webhookSecret is missing')

  let server: { stop: () => Promise<void> } | null = null
  let selfId: string | null = null
  let selfLogin: string | null = null
  let started = false
  let managedHooks: ReadonlyArray<{ repo: string; hookId: number }> = []
  let tokenRefreshTimer: { clear: () => void } | null = null
  let deliveryRecoveryTimer: { clear: () => void } | null = null
  let reconcileTimer: { clear: () => void } | null = null
  let reconcileCooldownStore: ReconcileCooldownStore | null = null
  let lifecycleGeneration = 0
  let unregisterTokenBridge: (() => void) | null = null
  const workspaceByChat = new Map<string, string>()
  const setIntervalFn =
    options.setInterval ??
    ((handler: () => void, ms: number) => {
      const timer = setInterval(handler, ms)
      return { clear: () => clearInterval(timer) }
    })

  const rememberWorkspace = (workspace: string, chat: string): void => {
    workspaceByChat.set(chat, workspace)
  }

  // Repo/owner-aware token resolver. A single GitHub App can span multiple
  // installations (one per owner); each consumer passes its repo/owner so the
  // right installation token is minted. Unlike the old single-token path, this
  // does NOT mutate process.env.GH_TOKEN. App credentials stay behind this
  // repo-scoped resolver instead of entering the ambient process environment.
  const authToken = (context?: GithubAuthContext) => auth.token(context)
  const recoveryCallbacks = createGithubRecoveryCallbacks(auth, fetchImpl, () =>
    selfId !== null ? `github:${selfId}` : undefined,
  )
  const outbound = withOutboundAccount(
    createGithubOutboundCallback({
      token: authToken,
      authType: options.secrets.auth.type,
      logger,
      fetchImpl,
      accountIdentity: recoveryCallbacks.accountIdentity,
    }),
    () => recoveryCallbacks.cachedAccountIdentity?.(),
  )
  const ownReaction = createGithubOwnReactionCallbacks({
    token: authToken,
    getSelf: () => auth.getSelf(),
    authType: options.secrets.auth.type,
    fetchImpl,
  })
  const reaction = createGithubReactionCallback({
    token: authToken,
    authType: options.secrets.auth.type,
    fetchImpl,
  })
  const removeReaction = createGithubRemoveReactionCallback({
    token: authToken,
    authType: options.secrets.auth.type,
    fetchImpl,
  })
  const history = createGithubHistoryCallback({
    token: authToken,
    fetchImpl,
    workspaceForChat: (chat) => workspaceByChat.get(chat) ?? null,
  })
  const membership = createGithubMembershipResolver({ token: authToken, fetchImpl })
  const reviewThreadResolver = createGithubReviewThreadResolver({
    token: authToken,
    selfLogin: () => selfLogin,
    fetchImpl,
  })
  const reviewStateResolver = createGithubReviewStateResolver({
    token: authToken,
    selfLogin: () => selfLogin,
    approve: () => options.configRef().review.approve,
    fetchImpl,
  })
  const reviewSubmitter = createGithubReviewSubmitter({
    token: authToken,
    allowApprove: () => options.configRef().review.approve,
    accountIdentity: recoveryCallbacks.accountIdentity,
    fetchImpl,
  })
  const channelNameResolver = createGithubChannelNameResolver({ token: authToken, fetchImpl })
  // GitHub addresses by `@login`, not the numeric id, so `username` carries
  // the login the model should type; the id is kept for completeness.
  const selfIdentityResolver: ChannelSelfIdentityResolver = () =>
    selfLogin !== null ? { id: selfId ?? selfLogin, username: selfLogin } : null
  const fetchAttachment = createGithubFetchAttachmentCallback()
  // No-op typing callback: GitHub has no typing indicator API.
  const typing = async (): Promise<void> => {}
  const dedup = createDeliveryDedup()
  const isBotInTeam = createTeamMembershipChecker({ token: authToken, fetchImpl })
  // Shared inbound entry. Both the live webhook handler and the startup
  // reconciliation pass route through this so a replayed PR takes the exact
  // same path a real delivery would.
  const routeInbound = async (message: InboundMessage): Promise<RouteReceipt> => {
    rememberWorkspace(message.workspace, message.chat)
    // The webhook handler schedules this outside its acknowledgment path.
    return options.router.route({
      ...message,
      accountIdentity: message.accountIdentity ?? (selfId === null ? undefined : `github:${selfId}`),
      eventKind: message.eventKind ?? 'review-followup',
      revision: message.revision ?? 'original',
    })
  }
  const handlerOptions: GithubWebhookHandlerOptions = {
    webhookSecret,
    dedup,
    allowlist: () => options.configRef().eventAllowlist,
    selfId: () => selfId,
    selfLogin: () => selfLogin,
    authType: () => options.secrets.auth.type,
    allowApprove: () => options.configRef().review.approve,
    reviewOn: () => options.configRef().review.on,
    isBotInTeam,
    authToken,
    fetchImpl,
    logger,
    route: routeInbound,
    abortGithubPrTurn: options.router.abortGithubPrTurn,
    clearReconcileCooldown: async (workspace, prId) => {
      if (reconcileCooldownStore === null) return 'not-initialized'
      await reconcileCooldownStore.clear(workspace, prId)
      return 'cleared'
    },
  }
  const handler = createGithubWebhookHandler(handlerOptions)

  return {
    async start(): Promise<void> {
      if (started) return
      const self = await auth.getSelf()
      selfId = String(self.id)
      selfLogin = self.login
      // Register all callbacks before binding the HTTP listener so the router
      // is fully wired before any webhook can arrive.
      options.router.registerOutbound('github', outbound)
      options.router.registerRecoveryAdapter('github', recoveryCallbacks)
      options.router.registerReaction('github', reaction)
      options.router.registerRemoveReaction('github', removeReaction)
      options.router.registerPrepareOwnReaction('github', ownReaction.prepare)
      options.router.registerRemoveOwnReaction('github', ownReaction.remove)
      options.router.registerTyping('github', typing)
      options.router.registerHistory('github', history)
      options.router.registerMembership('github', membership)
      options.router.registerChannelNameResolver('github', channelNameResolver)
      options.router.registerSelfIdentity('github', selfIdentityResolver)
      options.router.registerReviewThreadResolver('github', reviewThreadResolver)
      options.router.registerReviewStateResolver('github', reviewStateResolver)
      options.router.registerReviewSubmitter('github', reviewSubmitter)
      options.router.registerFetchAttachment('github', fetchAttachment)
      try {
        server = (options.httpListenImpl ?? listenWithBun)(options.configRef().webhookPort, handler)
      } catch (err) {
        // Listener failed — roll back all registrations so stop() is a no-op
        // and the manager can report the failure cleanly.
        options.router.unregisterOutbound('github', outbound)
        options.router.unregisterRecoveryAdapter('github', recoveryCallbacks)
        options.router.unregisterReaction('github', reaction)
        options.router.unregisterRemoveReaction('github', removeReaction)
        options.router.unregisterPrepareOwnReaction('github', ownReaction.prepare)
        options.router.unregisterRemoveOwnReaction('github', ownReaction.remove)
        options.router.unregisterTyping('github', typing)
        options.router.unregisterHistory('github', history)
        options.router.unregisterMembership('github', membership)
        options.router.unregisterChannelNameResolver('github', channelNameResolver)
        options.router.unregisterSelfIdentity('github', selfIdentityResolver)
        options.router.unregisterReviewThreadResolver('github', reviewThreadResolver)
        options.router.unregisterReviewStateResolver('github', reviewStateResolver)
        options.router.unregisterReviewSubmitter('github', reviewSubmitter)
        options.router.unregisterFetchAttachment('github', fetchAttachment)
        await auth.dispose()
        if (options.secrets.auth.type === 'pat') delete process.env.GH_TOKEN
        selfId = null
        selfLogin = null
        throw err
      }
      started = true
      // PAT mode retains its process-wide token behavior. App credentials never
      // enter process.env; App consumers mint through the repo-scoped bridge.
      if (options.secrets.auth.type === 'pat') {
        const seedGhToken = async (): Promise<void> => {
          process.env.GH_TOKEN = await auth.token()
        }
        await seedGhToken()
        const tokenRefreshIntervalMs = options.tokenRefreshIntervalMs ?? DEFAULT_TOKEN_REFRESH_INTERVAL_MS
        if (tokenRefreshIntervalMs > 0) {
          const refresh = () => {
            seedGhToken().catch((err) => {
              logger.error(`[github] periodic token refresh failed: ${describeError(err)}`)
            })
          }
          tokenRefreshTimer = setIntervalFn(refresh, tokenRefreshIntervalMs)
        }
      }
      if (options.secrets.auth.type === 'app' && options.githubTokenBridge !== undefined) {
        // Gate ad-hoc `gh` minting on the configured repos[]. The slug arrives
        // from an attacker-controllable -R/--repo flag (untrusted PR/issue
        // content can prompt-inject it); without this an injected `-R any/repo`
        // would mint an installation-wide token for any repo the App is installed
        // on — a cross-tenant leak under a multi-owner App. Enforced here, not in
        // the parser, because this adapter is the authority that owns repos[].
        unregisterTokenBridge = options.githubTokenBridge.registerResolver(
          async (repoSlug) => {
            const capturedSelfId = selfId
            if (capturedSelfId === null) throw new Error('GitHub authenticated account is unavailable')
            const allowed = new Set((options.configRef().repos ?? []).map(canonicalGithubRepo))
            if (!allowed.has(canonicalGithubRepo(repoSlug))) {
              throw new Error(
                `repo \`${repoSlug}\` is not in this agent's configured \`channels.github.repos[]\`; ` +
                  'refusing to mint a GitHub App token for it. Target a configured repo, ' +
                  'or add it to `repos[]` if the agent is meant to operate there.',
              )
            }
            const token = await auth.token({ repoSlug })
            return { token, accountIdentity: `github:${capturedSelfId}` }
          },
          () => selfLogin,
        )
      }
      logger.info(`[github] webhook listening on port ${options.configRef().webhookPort} as @${self.login}`)
      // Best-effort: App-only preflight that compares the installation's granted
      // permissions against the configured eventAllowlist and warns about gaps.
      // Catches the most common misconfiguration (App installed with the default
      // metadata-only permission set) before any event fires a 403.
      await runAppPermissionPreflight(logger, auth, options.configRef().eventAllowlist, options.configRef().repos ?? [])
      // Repository webhook registration is best-effort: failures are logged
      // per-repo, the adapter stays up. A misconfigured PAT or App that
      // can't manage hooks must not prevent the adapter from accepting
      // events for repos whose hooks are already registered.
      const cfg = options.configRef()
      const repos = cfg.repos ?? []
      const tunnelUrl = options.tunnelUrl?.() ?? null
      if (cfg.webhookUrl !== undefined && tunnelUrl !== null) {
        logger.warn('[github] webhookUrl configured; ignoring tunnel URL for webhook registration')
      }
      const rawUrl = cfg.webhookUrl ?? tunnelUrl
      const managedPath = buildManagedPath(
        resolveAgentId({ containerName: process.env.TYPECLAW_CONTAINER_NAME, agentDir: options.agentDir }),
      )
      const effectiveUrl = rawUrl === null ? null : applyManagedPath(rawUrl, managedPath)
      if (effectiveUrl === null) {
        logSkippedRegistration(logger, {
          tunnelConfigured: options.tunnelConfiguredForChannel?.() ?? false,
          reposCount: repos.length,
        })
      } else if (repos.length > 0) {
        const legacyProviderHostSuffix = detectLegacyProviderHostSuffix(effectiveUrl)
        logger.info(
          `[github] registering webhook for ${repos.length} repo(s) [${repos.join(', ')}] -> ${effectiveUrl} (events: ${cfg.eventAllowlist.join(', ')})`,
        )
        if (webhookRegistrationDelayMs > 0) {
          logger.info(
            `[github] waiting ${webhookRegistrationDelayMs}ms before registering webhook so the Cloudflare edge can warm up`,
          )
          await sleep(webhookRegistrationDelayMs)
        }
        const registration = await registerGithubWebhooks({
          token: (repoSlug: string) => auth.token({ repoSlug }),
          webhookUrl: effectiveUrl,
          webhookSecret,
          repos,
          events: cfg.eventAllowlist,
          managedPath,
          ...(legacyProviderHostSuffix !== undefined ? { legacyProviderHostSuffix } : {}),
          fetchImpl,
        })
        managedHooks = registration.repos.flatMap((r) =>
          r.action === 'created' || r.action === 'updated' ? [{ repo: r.repo, hookId: r.hookId }] : [],
        )
        logRegistrationOutcome(logger, registration, options.secrets.auth.type)
      }
      // Catch up on PRs whose opened/ready_for_review/review_requested delivery
      // was missed (tunnel-URL churn, dropped delivery, downtime). Best-effort
      // so a failure here never blocks the adapter from coming up; the helper
      // swallows per-repo errors internally. `off` short-circuits inside. A
      // durable per-PR cooldown store bounds replay to at most once per window,
      // so the many restarts a churning tunnel causes don't re-review the same
      // PRs; the periodic tick below retries genuinely-missed PRs after the
      // cooldown without needing a restart.
      const loadedReconcileCooldownStore =
        repos.length > 0 ? await loadReconcileCooldownStore(options.agentDir, logger) : null
      reconcileCooldownStore = loadedReconcileCooldownStore
      // Resolve review.on per call, not from the captured startup cfg: review.on
      // is live-reloadable, so a periodic tick must honor a change to `off`
      // (reconcileOpenPrs short-circuits on `off`) instead of scanning forever.
      const reconcileGeneration = lifecycleGeneration
      const runReconcile = (store: ReconcileCooldownStore): Promise<unknown> =>
        reconcileOpenPrs({
          repos,
          reviewOn: options.configRef().review.on,
          selfLogin,
          authType: options.secrets.auth.type,
          token: authToken,
          route: routeInbound,
          logger,
          isBotInTeam,
          fetchImpl,
          cooldownStore: store,
          isCancelled: () => reconcileGeneration !== lifecycleGeneration,
        }).catch((err: unknown) => {
          logger.warn(`[github] reconcile pass failed: ${describeError(err)}`)
        })
      if (loadedReconcileCooldownStore !== null) {
        // Detached on purpose: the pass awaits each replay's router receipt, and
        // routing can depend on boot progress that itself waits for this start()
        // to resolve. Awaiting it here stalled boot before tunnels started, so
        // webhooks never registered and no PR was reviewed.
        void runReconcile(loadedReconcileCooldownStore)
        const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
        if (reconcileIntervalMs > 0) {
          reconcileTimer = setIntervalFn(() => void runReconcile(loadedReconcileCooldownStore), reconcileIntervalMs)
        }
      }
      // Periodically recover inbound deliveries that failed at the tunnel and
      // were never redelivered (the cloudflare-quick 502 loss). Registered only
      // when we manage hooks to query, and driven by the same injectable timer
      // as the token refresh. The first sweep fires after one interval — NOT
      // inside start() — so start() stays free of surprise API traffic; the
      // reconcile pass above already covers the review-needed case immediately.
      const deliveryRecoveryIntervalMs = options.deliveryRecoveryIntervalMs ?? DEFAULT_DELIVERY_RECOVERY_INTERVAL_MS
      if (managedHooks.length > 0 && deliveryRecoveryIntervalMs > 0) {
        // Created once and captured by `sweep`, so recovery idempotency persists
        // across ticks even when the shared live dedup evicts the guid.
        const recoveredLog = createRecoveredGuidLog(DELIVERY_RECOVERY_LOOKBACK_MS)
        const sweep = () => {
          recoverFailedGithubDeliveries({
            hooks: managedHooks,
            token: (repoSlug: string) => auth.token({ repoSlug }),
            process: (input) => processVerifiedGithubDelivery(handlerOptions, input),
            alreadySeen: (guid: string) => dedup.has(guid),
            recoveredLog,
            lookbackMs: DELIVERY_RECOVERY_LOOKBACK_MS,
            maxPerSweep: MAX_RECOVERED_PER_SWEEP,
            logger,
            fetchImpl,
          }).catch((err: unknown) => {
            logger.warn(`[github] delivery recovery sweep failed: ${describeError(err)}`)
          })
        }
        deliveryRecoveryTimer = setIntervalFn(sweep, deliveryRecoveryIntervalMs)
      }
    },
    async stop(): Promise<void> {
      if (!started) return
      started = false
      lifecycleGeneration += 1
      // Stop the recovery sweep first: its async work outlives the synchronous
      // unregister calls below, and a tick landing mid-teardown would query a
      // hook we're about to deregister and could route during shutdown.
      if (deliveryRecoveryTimer !== null) {
        deliveryRecoveryTimer.clear()
        deliveryRecoveryTimer = null
      }
      if (reconcileTimer !== null) {
        reconcileTimer.clear()
        reconcileTimer = null
      }
      options.router.unregisterOutbound('github', outbound)
      options.router.unregisterReaction('github', reaction)
      options.router.unregisterRemoveReaction('github', removeReaction)
      options.router.unregisterPrepareOwnReaction('github', ownReaction.prepare)
      options.router.unregisterRemoveOwnReaction('github', ownReaction.remove)
      options.router.unregisterTyping('github', typing)
      options.router.unregisterHistory('github', history)
      options.router.unregisterRecoveryAdapter('github', recoveryCallbacks)
      options.router.unregisterMembership('github', membership)
      options.router.unregisterChannelNameResolver('github', channelNameResolver)
      options.router.unregisterSelfIdentity('github', selfIdentityResolver)
      options.router.unregisterReviewThreadResolver('github', reviewThreadResolver)
      options.router.unregisterReviewStateResolver('github', reviewStateResolver)
      options.router.unregisterReviewSubmitter('github', reviewSubmitter)
      options.router.unregisterFetchAttachment('github', fetchAttachment)
      await server?.stop()
      // Detach hooks AFTER closing the listener so any in-flight deliveries
      // from GitHub no longer hit a live receiver while we're tearing down.
      // The token call uses the still-live `auth` strategy; dispose() runs
      // last to clear the cached App-installation token.
      if (managedHooks.length > 0) {
        const deregistration = await deregisterGithubWebhooks({
          token: (repoSlug: string) => auth.token({ repoSlug }),
          hooks: managedHooks,
          fetchImpl,
        })
        logDeregistrationOutcome(logger, deregistration)
        managedHooks = []
      }
      if (tokenRefreshTimer !== null) {
        tokenRefreshTimer.clear()
        tokenRefreshTimer = null
      }
      if (unregisterTokenBridge !== null) {
        unregisterTokenBridge()
        unregisterTokenBridge = null
      }
      await auth.dispose()
      if (options.secrets.auth.type === 'pat') delete process.env.GH_TOKEN
      server = null
      selfId = null
      selfLogin = null
      reconcileCooldownStore = null
    },
    isConnected(): boolean {
      return started && selfLogin !== null
    },
  }
}

function listenWithBun(port: number, handler: (req: Request) => Promise<Response>): { stop: () => Promise<void> } {
  const server = Bun.serve({ port, fetch: handler })
  return { stop: async () => server.stop() }
}

function logSkippedRegistration(
  logger: GithubAdapterLogger,
  context: { tunnelConfigured: boolean; reposCount: number },
): void {
  if (context.reposCount === 0) {
    logger.info('[github] no repos[] configured; webhook registration skipped')
    return
  }
  if (context.tunnelConfigured) {
    logger.warn(
      '[github] webhook registration SKIPPED: a tunnel is configured for this channel but produced no URL yet. ' +
        "Check `typeclaw tunnel status` for the tunnel's health (cloudflared binary missing, " +
        'auth failure, network issue). Webhook delivery will not work until the tunnel produces a public URL.',
    )
    return
  }
  logger.warn(
    '[github] webhook registration SKIPPED: no `channels.github.webhookUrl` set and no `tunnels[]` entry ' +
      'binds a public URL to this channel. Add an entry to `tunnels[]` (e.g. `provider: "cloudflare-quick"`) ' +
      'or set `channels.github.webhookUrl` to a public URL to enable webhook delivery.',
  )
}

// Known tunnel-provider host suffixes whose hostnames rotate per container.
// A pre-marker hook on one of these is unambiguously a typeclaw orphan from
// this agent's prior runs (cloudflare-quick is per-container, the host
// changes every restart, so a stale unmarked *.trycloudflare.com hook
// pointing at a now-dead host cannot belong to any live service).
// Extending: add the host suffix here AND verify that hooks on the new
// provider always look unmarked (no operator-supplied path) before the
// marker was introduced.
const LEGACY_TUNNEL_PROVIDER_HOSTS: readonly string[] = ['.trycloudflare.com']

function detectLegacyProviderHostSuffix(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  for (const suffix of LEGACY_TUNNEL_PROVIDER_HOSTS) {
    if (parsed.host.endsWith(suffix)) return suffix
  }
  return undefined
}

function logRegistrationOutcome(
  logger: GithubAdapterLogger,
  result: WebhookRegistrationResult,
  authType: 'pat' | 'app',
): void {
  const permissionFailures: Array<{ repo: string; status: number }> = []
  for (const r of result.repos) {
    if (r.action === 'created') logger.info(`[github] registered webhook ${r.hookId} on ${r.repo}`)
    else if (r.action === 'updated') {
      const tail = r.stalePruned > 0 ? ` (pruned ${r.stalePruned} stale)` : ''
      logger.info(`[github] updated webhook ${r.hookId} on ${r.repo}${tail}`)
    } else {
      logger.warn(`[github] webhook register failed for ${r.repo}: ${r.error}`)
      const status = parseListHooksPermissionStatus(r.error)
      if (status !== null) permissionFailures.push({ repo: r.repo, status })
    }
  }
  // One guidance block per start() (not per repo) so a 10-repo permission
  // failure doesn't paste the same paragraph 10 times. The names below MUST
  // match the current github.com UI labels — see comment in
  // buildPermissionGuidance.
  if (permissionFailures.length > 0) {
    logger.warn(buildPermissionGuidance(authType, permissionFailures))
  }
}

async function runAppPermissionPreflight(
  logger: GithubAdapterLogger,
  auth: ReturnType<typeof buildAuthStrategy>,
  eventAllowlist: readonly string[],
  repos: readonly string[],
): Promise<void> {
  if (auth.getInstallationGrants === undefined) return
  const getGrants = (context: GithubAuthContext | undefined) => auth.getInstallationGrants?.(context)
  // One grants check per distinct owner: installations are owner-scoped, so
  // repos sharing an owner share an installation. The first repo per owner is
  // the resolution key. With no repos, fall back to a single context-free check.
  const reposByOwner = new Map<string, string>()
  for (const repo of repos) {
    const owner = repo.split('/')[0]
    if (owner !== undefined && owner !== '' && !reposByOwner.has(owner)) reposByOwner.set(owner, repo)
  }
  const contexts: Array<{ label: string; context: { repoSlug: string } | undefined }> =
    reposByOwner.size === 0
      ? [{ label: 'app', context: undefined }]
      : [...reposByOwner.values()].map((repo) => ({ label: repo, context: { repoSlug: repo } }))
  for (const { label, context } of contexts) {
    let grants
    try {
      grants = await getGrants(context)
    } catch (err) {
      logger.warn(`[github] permission preflight skipped for ${label}: ${describeError(err)}`)
      continue
    }
    if (grants === undefined) continue
    const gaps = findPermissionGaps(eventAllowlist, grants.permissions)
    if (gaps.length > 0) logger.warn(buildAppPermissionPreflightGuidance(gaps))
  }
}

function logDeregistrationOutcome(
  logger: GithubAdapterLogger,
  result: Awaited<ReturnType<typeof deregisterGithubWebhooks>>,
): void {
  for (const h of result.hooks) {
    if (h.action === 'deleted') logger.info(`[github] detached webhook ${h.hookId} from ${h.repo}`)
    else if (h.action === 'missing') logger.info(`[github] webhook ${h.hookId} on ${h.repo} already gone`)
    else logger.warn(`[github] webhook detach failed for ${h.repo}#${h.hookId}: ${h.error ?? 'unknown error'}`)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
