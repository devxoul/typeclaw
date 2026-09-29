import { defineCommand } from 'citty'

import { loadConfigSync, validateConfig, type Config, type ValidateConfigResult } from '@/config'
import {
  resolveController,
  resolveHostPort,
  resolveTuiToken,
  type RestartOptions,
  type RestartResult,
} from '@/container'
import {
  applyCredentialRotation,
  type CredentialRotationApplyResult,
  type RenewableAdapter,
} from '@/hostd/credential-rotation-apply'
import { createCurrentHostDaemonHolder } from '@/hostd/current-host-daemon'
import { startDaemon, type DaemonLogEvent, type RestartPreflight } from '@/hostd/daemon'
import { createKakaoRenewalManager } from '@/hostd/kakao-renewal-manager'
import { createPortbrokerManager } from '@/hostd/portbroker-manager'
import type { SupervisorLogEvent, SupervisorRestart } from '@/hostd/supervisor'
import { createTeamsRenewalManager } from '@/hostd/teams-renewal-manager'
import { computeSourceVersion, resolveSrcRoot, UNVERSIONED_SENTINEL } from '@/hostd/version'
import { createWebexRenewalManager } from '@/hostd/webex-renewal-manager'
import { validateRestartDeps, type RestartDepsPreflightResult } from '@/init/restart-deps-preflight'
import { requestReloadWithFallback } from '@/reload'

export const hostdCommand = defineCommand({
  meta: {
    name: '_hostd',
    description: 'internal: host-side typeclaw daemon (do not invoke directly)',
    hidden: true,
  },
  async run() {
    const cliEntry = process.argv[1] ?? ''
    const srcRoot = resolveSrcRoot(cliEntry)
    const version = srcRoot === null ? UNVERSIONED_SENTINEL : await computeSourceVersion({ srcRoot })

    const portbroker = createPortbrokerManager({
      onLog: (msg) => writeLogLine(msg),
    })

    const hostdRestart = buildHostdRestart(cliEntry, defaultRestartDeps, version)
    // Renewal restarts call hostdRestart directly (not via the restart RPC), so
    // they must thread currentHostDaemon themselves to get the in-process
    // registration path. The daemon populates this holder once booted.
    const currentHostDaemonHolder = createCurrentHostDaemonHolder()
    // The renewal cron writes a fresh credential to secrets.json, but the
    // running adapter captured the old one in a client closure at start(). It
    // has to be told to pick the new one up; bouncing that single adapter is
    // enough, and leaves the rest of the agent's work untouched.
    const applyRenewedCredential = async (
      adapter: RenewableAdapter,
      { containerName, cwd }: { containerName: string; cwd: string },
    ): Promise<void> => {
      const result = await applyCredentialRotation(
        { containerName, cwd, adapter },
        {
          resolveHostPort,
          resolveTuiToken,
          requestReloadWithFallback,
          restartContainer: async (input) => {
            const currentHostDaemon = await currentHostDaemonHolder.ready()
            return await hostdRestart({ ...input, currentHostDaemon })
          },
        },
      )
      writeLogLine(formatCredentialApply(adapter, containerName, result))
      if (result.kind === 'failed') throw new Error(result.restartError)
    }

    const kakaoRenewal = createKakaoRenewalManager({
      onLog: (event) => writeLogLine(formatLog(event)),
      onRenewalOk: async (input) => await applyRenewedCredential('kakaotalk', input),
      shouldRenew: ({ cwd }) => kakaoChannelConfigured(cwd),
    })
    const webexRenewal = createWebexRenewalManager({
      onLog: (event) => writeLogLine(formatLog(event)),
      onRenewalOk: async (input) => await applyRenewedCredential('webex', input),
      shouldRenew: ({ cwd }) => webexChannelConfigured(cwd),
    })
    const teamsRenewal = createTeamsRenewalManager({
      onLog: (event) => writeLogLine(formatLog(event)),
      onRenewalOk: async (input) => await applyRenewedCredential('teams', input),
      shouldRenew: ({ cwd }) => teamsChannelConfigured(cwd),
    })

    const daemon = await startDaemon({
      onLog: (e) => writeLogLine(formatLog(e)),
      version,
      onShutdown: () => process.exit(0),
      portbroker,
      kakaoRenewal,
      webexRenewal,
      teamsRenewal,
      currentHostDaemonHolder,
      restartPreflight: buildHostdRestartPreflight(cliEntry, version, defaultPreflightDeps),
      restart: hostdRestart,
    })

    const shutdown = (): void => {
      void daemon
        .stop()
        .then(() => portbroker.drain())
        .then(() => kakaoRenewal.drain())
        .then(() => webexRenewal.drain())
        .then(() => teamsRenewal.drain())
        .then(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    await new Promise<void>(() => {})
  },
})

export type HostdRestartDeps = {
  validateConfig: (cwd: string) => ValidateConfigResult
  loadConfigSync: (cwd: string) => Config
  restart: (opts: RestartOptions) => Promise<RestartResult>
}

const controller = resolveController()
const defaultRestartDeps: HostdRestartDeps = {
  validateConfig,
  loadConfigSync,
  restart: (opts) => controller.restart(opts),
}

export function buildHostdRestart(
  cliEntry: string,
  deps: HostdRestartDeps = defaultRestartDeps,
  daemonVersion?: string,
): SupervisorRestart {
  return async ({ containerName, cwd, build = false, currentHostDaemon, operationLease }) => {
    const drift = await detectSourceDrift(cliEntry, daemonVersion)
    if (drift) return { ok: false, reason: drift }

    const validated = deps.validateConfig(cwd)
    if (!validated.ok) {
      return { ok: false, reason: `invalid config for ${containerName}: ${validated.reason}` }
    }
    const cfg = deps.loadConfigSync(cwd)
    const restartResult = await deps.restart({
      cwd,
      preferredHostPort: cfg.port,
      forceBuild: build,
      cliEntry,
      reuseCurrentHostDaemon: true,
      operationLease,
      ...(currentHostDaemon ? { currentHostDaemon } : {}),
    })
    if (!restartResult.ok) return restartResult
    return { ok: true }
  }
}

export type HostdPreflightDeps = {
  loadConfigSync: (cwd: string) => Config
  validateRestartDeps: (opts: { cwd: string; plugins: readonly string[] }) => Promise<RestartDepsPreflightResult>
}

const defaultPreflightDeps: HostdPreflightDeps = {
  loadConfigSync,
  validateRestartDeps,
}

export function buildHostdRestartPreflight(
  cliEntry: string,
  daemonVersion: string,
  deps: HostdPreflightDeps = defaultPreflightDeps,
): RestartPreflight {
  return async ({ containerName, cwd }) => {
    const drift = await detectSourceDrift(cliEntry, daemonVersion)
    if (drift) return { ok: false, reason: drift }

    // Read plugins through loadConfigSync, not validateConfig: a config that
    // fails schema validation is caught later in buildHostdRestart (before
    // stop). On read/parse failure we let the restart proceed — start() is the
    // fail-closed gate, and a preflight that can't read config must not strand a
    // healthy agent.
    let plugins: readonly string[]
    try {
      plugins = deps.loadConfigSync(cwd).plugins
    } catch {
      return null
    }

    const depsCheck = await deps.validateRestartDeps({ cwd, plugins })
    if (!depsCheck.ok) {
      return { ok: false, reason: `restart refused for ${containerName}: ${depsCheck.reason}` }
    }
    return null
  }
}

async function detectSourceDrift(cliEntry: string, daemonVersion: string | undefined): Promise<string | null> {
  if (!daemonVersion || daemonVersion === UNVERSIONED_SENTINEL) return null
  const srcRoot = resolveSrcRoot(cliEntry)
  if (srcRoot === null) return null
  const currentVersion = await computeSourceVersion({ srcRoot })
  if (currentVersion === daemonVersion) return null
  return 'host daemon source has drifted from the current typeclaw source; run `typeclaw restart --build` from the host-stage agent folder so the daemon respawns before rebuilding the Docker image'
}

function writeLogLine(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`)
}

function formatCredentialApply(
  adapter: RenewableAdapter,
  containerName: string,
  result: CredentialRotationApplyResult,
): string {
  const prefix = `[hostd] ${adapter} renewal`
  if (result.kind === 'reloaded') {
    return `${prefix} applied to ${containerName} via ${result.transport} reload (no container restart)`
  }
  if (result.kind === 'restarted') {
    return `${prefix} fell back to a container restart for ${containerName}: ${result.reloadError}`
  }
  return `${prefix} could not be applied to ${containerName}: ${result.reloadError}; restart also failed: ${result.restartError}`
}

function formatLog(event: DaemonLogEvent | SupervisorLogEvent): string {
  switch (event.kind) {
    case 'daemon-listening':
      return `[hostd] listening on ${event.socket}`
    case 'daemon-http-listening':
      return `[hostd] HTTP control listening on ${event.host}:${event.port}`
    case 'daemon-http-port-fallback':
      return `[hostd] HTTP preferred port ${event.preferred} busy; fell back to ${event.actual} (containers started on ${event.preferred} will see stale TYPECLAW_HOSTD_URL until restarted)`
    case 'daemon-stopping':
      return `[hostd] stopping`
    case 'shutdown-requested':
      return `[hostd] shutdown requested (version drift); exiting so the next CLI call respawns`
    case 'register':
      return `[hostd] registered ${event.containerName}`
    case 'deregister':
      return `[hostd] deregistered ${event.containerName} (${event.reason})`
    case 'registration-skipped':
      return `[hostd] skipped persisted registration ${event.containerName}: ${event.reason}`
    case 'container-exited':
      return `[hostd] ${event.containerName}: ${event.reason}`
    case 'restart-scheduled':
      return `[hostd] restart scheduled for ${event.containerName}${event.build ? ' (with rebuild)' : ''}`
    case 'restart-completed':
      return `[hostd] restart completed for ${event.containerName}`
    case 'restart-failed':
      return `[hostd] restart failed for ${event.containerName}: ${event.reason}`
    case 'port-forward-event':
      return formatPortForwardEvent(event.event)
    case 'tailscale-serve-event':
      return formatTailscaleServeEvent(event.event)
    case 'kakao-renewal-tick-start':
      return `[hostd] kakao renewal tick started for ${event.containerName}`
    case 'kakao-renewal-tick-skipped':
      return `[hostd] kakao renewal skipped for ${event.containerName}: ${event.reason}${event.ageMs !== undefined ? ` (age=${Math.round(event.ageMs / 1000 / 60 / 60)}h)` : ''}`
    case 'kakao-renewal-tick-ok':
      return `[hostd] kakao renewal OK for ${event.containerName} account=${event.accountId}${event.method ? ` method=${event.method}` : ''} (was last updated ${event.previousUpdatedAt})`
    case 'kakao-renewal-tick-reauth-required':
      return `[hostd] kakao renewal REAUTH REQUIRED for ${event.containerName} account=${event.accountId} reason=${event.reason} — ${event.message}`
    case 'kakao-renewal-tick-transient-failure':
      return `[hostd] kakao renewal transient failure for ${event.containerName} account=${event.accountId}: ${event.reason}`
    case 'kakao-renewal-tick-error':
      return `[hostd] kakao renewal ERROR for ${event.containerName}: ${event.error}`
    case 'kakao-renewal-restart-scheduled':
      return `[hostd] kakao renewal scheduled container restart for ${event.containerName} account=${event.accountId}`
    case 'kakao-renewal-restart-failed':
      return `[hostd] kakao renewal container restart FAILED for ${event.containerName} account=${event.accountId}: ${event.reason}`
    case 'webex-renewal-tick-start':
      return `[hostd] webex renewal tick started for ${event.containerName}`
    case 'webex-renewal-tick-skipped':
      return `[hostd] webex renewal skipped for ${event.containerName}: ${event.reason}${event.expiresInMs !== undefined ? ` (expires in ${Math.round(event.expiresInMs / 1000 / 60 / 60)}h)` : ''}`
    case 'webex-renewal-tick-ok':
      return `[hostd] webex renewal OK for ${event.containerName} account=${event.accountId} (new token expires ${new Date(event.nextExpiresAt).toISOString()})`
    case 'webex-renewal-tick-reauth-required':
      return `[hostd] webex renewal REAUTH REQUIRED for ${event.containerName} account=${event.accountId} reason=${event.reason} — ${event.message}`
    case 'webex-renewal-tick-transient-failure':
      return `[hostd] webex renewal transient failure for ${event.containerName} account=${event.accountId}: ${event.reason}`
    case 'webex-renewal-tick-error':
      return `[hostd] webex renewal ERROR for ${event.containerName}: ${event.error}`
    case 'webex-renewal-restart-scheduled':
      return `[hostd] webex renewal scheduled container restart for ${event.containerName} account=${event.accountId}`
    case 'webex-renewal-restart-failed':
      return `[hostd] webex renewal container restart FAILED for ${event.containerName} account=${event.accountId}: ${event.reason}`
    case 'teams-renewal-tick-start':
      return `[hostd] teams renewal tick started for ${event.containerName}`
    case 'teams-renewal-tick-skipped':
      return `[hostd] teams renewal skipped for ${event.containerName}: ${event.reason}${event.expiresInMs !== undefined ? ` (expires in ${Math.round(event.expiresInMs / 1000 / 60)}m)` : ''}`
    case 'teams-renewal-tick-ok':
      return `[hostd] teams renewal OK for ${event.containerName} account=${event.accountId} (new token expires ${new Date(event.nextExpiresAt).toISOString()})`
    case 'teams-renewal-tick-reauth-required':
      return `[hostd] teams renewal REAUTH REQUIRED for ${event.containerName} account=${event.accountId} reason=${event.reason} — ${event.message}`
    case 'teams-renewal-tick-transient-failure':
      return `[hostd] teams renewal transient failure for ${event.containerName} account=${event.accountId}: ${event.reason}`
    case 'teams-renewal-tick-error':
      return `[hostd] teams renewal ERROR for ${event.containerName}: ${event.error}`
    case 'teams-renewal-restart-scheduled':
      return `[hostd] teams renewal scheduled container restart for ${event.containerName} account=${event.accountId}`
    case 'teams-renewal-restart-failed':
      return `[hostd] teams renewal container restart FAILED for ${event.containerName} account=${event.accountId}: ${event.reason}`
  }
}

// Reads the agent's typeclaw.json to decide whether the kakao renewal cron
// should run for this container. Without this, every typeclaw agent on the
// host gets a daily `no_account` skip event from the renewal manager — log
// spam for non-kakao agents. Returns false on read/parse errors so the
// renewal cron stays silent for agents we can't classify; the kakao adapter
// itself would surface the real config issue on its next start.
function kakaoChannelConfigured(cwd: string): boolean {
  try {
    const cfg = loadConfigSync(cwd)
    return cfg.channels?.kakaotalk !== undefined
  } catch {
    return false
  }
}

function webexChannelConfigured(cwd: string): boolean {
  try {
    const cfg = loadConfigSync(cwd)
    return cfg.channels?.webex !== undefined
  } catch {
    return false
  }
}

function teamsChannelConfigured(cwd: string): boolean {
  try {
    const cfg = loadConfigSync(cwd)
    return cfg.channels?.teams !== undefined
  } catch {
    return false
  }
}

function formatPortForwardEvent(event: import('@/portbroker').PortForwardEvent): string {
  switch (event.kind) {
    case 'port-forward-opened':
      return `[hostd] port-forward opened ${event.containerName}:${event.port} (${event.bindAddr}) → localhost:${event.port}`
    case 'port-forward-closed':
      return `[hostd] port-forward closed ${event.containerName}:${event.port} (${event.reason})`
    case 'port-forward-failed':
      return `[hostd] port-forward FAILED ${event.containerName}:${event.port} — ${event.reason}`
  }
}

function formatTailscaleServeEvent(event: import('@/hostd/tailscale').TailscaleServeEvent): string {
  switch (event.kind) {
    case 'tailscale-serve-opened':
      return `[hostd] tailscale serve opened ${event.containerName}:${event.port}`
    case 'tailscale-serve-closed':
      return `[hostd] tailscale serve closed ${event.containerName}:${event.port}`
    case 'tailscale-serve-skipped':
      return `[hostd] tailscale serve skipped ${event.containerName}:${event.port} — ${event.reason}`
    case 'tailscale-serve-failed':
      return `[hostd] tailscale serve FAILED ${event.containerName}:${event.port} (${event.command}) — ${event.reason}`
  }
}
