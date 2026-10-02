import { existsSync } from 'node:fs'
import { chmod, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket as NetSocket } from 'node:net'
import { join } from 'node:path'

import type { PortForward } from '@/config'
import { defaultDockerExec, type DockerExec, type HostDaemonRegisterPayload } from '@/container'
import { inspectContainerExit } from '@/container/exit-reason'
import type { PortForwardEvent } from '@/portbroker'
import {
  discordChannelBlockSchema,
  instagramChannelBlockSchema,
  kakaoChannelBlockSchema,
  lineChannelBlockSchema,
  mcpCredentialSchema,
  slackChannelBlockSchema,
  teamsChannelBlockSchema,
  webexChannelBlockSchema,
} from '@/secrets/schema'
import { SecretsBackend } from '@/secrets/storage'
import { isWindows } from '@/shared'

import { isDaemonReachable } from './client'
import type { CurrentHostDaemonHolder } from './current-host-daemon'
import type { KakaoRenewalCallbacks, KakaoRenewalLogEvent } from './kakao-renewal-manager'
import { ensureDirs, registrationFilePath, registrationsDir, socketPath } from './paths'
import type {
  HttpInfoResult,
  ListResult,
  Request,
  Response as RpcResponse,
  RestartResult,
  SecretsPatchResult,
  ShutdownResult,
  StatusResult,
  VersionResult,
} from './protocol'
import { buildSupervisor, type SupervisorLogEvent, type SupervisorRestart } from './supervisor'
import type { TailscaleServeEvent } from './tailscale'
import type { TeamsRenewalCallbacks, TeamsRenewalLogEvent } from './teams-renewal-manager'
import { UNVERSIONED_SENTINEL } from './version'
import type { WebexRenewalCallbacks, WebexRenewalLogEvent } from './webex-renewal-manager'

export type DaemonOptions = {
  exec?: DockerExec
  onLog?: (event: DaemonLogEvent | SupervisorLogEvent) => void
  gcIntervalMs?: number
  gcMissesToDeregister?: number
  // Per-step bound on teardown calls (portbroker/renewal stop) run inside the
  // per-container serial chain. Defaults to CLEANUP_STEP_TIMEOUT_MS; tests
  // override it to a few ms to assert the chain never wedges on a hung step.
  cleanupStepTimeoutMs?: number
  socket?: string
  // When provided, the daemon honors `restart` RPCs by invoking this with the
  // (containerName, cwd) it captured at register time. Omit to disable the
  // capability in tests.
  restart?: SupervisorRestart
  restartPreflight?: RestartPreflight
  // Source-tree fingerprint captured at daemon boot. Reported via the
  // `version` RPC so the CLI can detect when its on-disk source has drifted
  // from what the running daemon loaded, and trigger a respawn over the
  // `shutdown` RPC. Omit to advertise as unversioned (drift detection
  // disabled — both peers compare equal on the sentinel).
  version?: string
  // Invoked after the daemon finishes its self-initiated stop in response to
  // a `shutdown` RPC. Production wiring exits the process here so the host
  // can spawn a fresh daemon; tests omit it to keep the process alive.
  onShutdown?: () => void
  httpHost?: string
  httpPort?: number
  // Port-broker capability. When provided, register-RPC's portForward/wsHostPort
  // fields trigger broker spawn alongside supervisor registration. Tests omit
  // it to keep the broker out of unrelated suites.
  portbroker?: PortbrokerCallbacks
  // KakaoTalk credential renewal capability. When provided, the daemon
  // starts a per-container daily renewal tick on register and stops it on
  // deregister. Omit to disable in tests / when the agent has no kakaotalk
  // channel configured.
  kakaoRenewal?: KakaoRenewalCallbacks
  // Webex credential renewal capability. Same lifecycle as kakaoRenewal but
  // ticks hourly because Webex password tokens live ~27h (see
  // webex-renewal-manager.ts). Omit when the agent has no webex channel.
  webexRenewal?: WebexRenewalCallbacks
  // Teams credential renewal capability. Same lifecycle as webexRenewal but
  // ticks every 5 minutes because Teams skype tokens live only 60-90 min (see
  // teams-renewal-manager.ts). Omit when the agent has no teams channel.
  teamsRenewal?: TeamsRenewalCallbacks
  // Populated once the daemon is booted so direct callers of the restart
  // (the renewal callbacks in cli/hostd.ts) get the in-process registration
  // path instead of the socket self-RPC. Omit in tests that don't exercise it.
  currentHostDaemonHolder?: CurrentHostDaemonHolder
}

export type RestartPreflight = (input: {
  containerName: string
  cwd: string
  build?: boolean
}) => Promise<RpcResponse | null>

export type PortbrokerCallbacks = {
  start: (input: PortbrokerStartInput) => Promise<void>
  stop: (containerName: string, reason: 'deregistered' | 'broker-stopped' | 'fatal-auth') => Promise<void>
  // Returns ports the broker is currently exposing on the host for this
  // container. Empty array when the container is unregistered, when the broker
  // is disabled (`portForward.allow: []`), or when nothing inside the
  // container has bound a forwardable port yet. Read-only — used by the
  // `status` RPC to surface live forward state.
  forwardedPorts: (containerName: string) => number[]
}

export type PortbrokerStartInput = {
  containerName: string
  cwd: string
  policy: PortForward
  wsHostPort: number
  brokerToken: string
  onEvent: (event: PortForwardEvent) => void
  onTailscaleServeEvent: (event: TailscaleServeEvent) => void
  onFatalAuthFailure?: (info: { brokerToken: string; reason: string }) => void
}

export type DaemonLogEvent =
  | { kind: 'daemon-listening'; socket: string }
  | { kind: 'daemon-http-listening'; host: string; port: number }
  | { kind: 'daemon-http-port-fallback'; preferred: number; actual: number }
  | { kind: 'daemon-stopping' }
  | { kind: 'register'; containerName: string }
  | { kind: 'deregister'; containerName: string; reason: 'requested' | 'gone' }
  | { kind: 'registration-skipped'; containerName: string; reason: string }
  | { kind: 'container-exited'; containerName: string; reason: string }
  | { kind: 'shutdown-requested' }
  | { kind: 'port-forward-event'; event: PortForwardEvent }
  | { kind: 'tailscale-serve-event'; event: TailscaleServeEvent }
  | KakaoRenewalLogEvent
  | WebexRenewalLogEvent
  | TeamsRenewalLogEvent

export type Daemon = {
  registered: () => string[]
  stop: () => Promise<void>
}

const DEFAULT_GC_INTERVAL_MS = 30_000
const DEFAULT_GC_MISSES_TO_DEREGISTER = 3
const MAX_REQUEST_BUFFER_BYTES = 64 * 1024
const MAX_HTTP_REQUEST_BYTES = 64 * 1024

// Upper bound on any single teardown step (portbroker/renewal stop) run inside
// the per-container runSerially chain. A teardown dependency must never own a
// container's serial queue forever — that wedges every later register/deregister
// for that container (the renewal-restart wedge). Larger than tailscale's 30s
// per-call budget so a slow-but-progressing serve-off isn't cut off, yet finite
// so a genuine hang releases the queue instead of poisoning it.
const CLEANUP_STEP_TIMEOUT_MS = 60_000

// Preferred port for the HTTP control surface. Adjacent to CONTAINER_PORT
// (8973) for mnemonics. Stability matters: containers cache the URL in
// TYPECLAW_HOSTD_URL at `docker run` time, so a respawn that picks a fresh
// random port would leave running containers with stale URLs and no way to
// reach hostd. We try 8974 first and only fall back to an ephemeral port if
// it's already in use by some other local service.
const STABLE_HTTP_PORT = 8974

function json(response: RpcResponse, status = 200): globalThis.Response {
  return new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bearerToken(value: string | null): string | null {
  if (!value) return null
  const prefix = 'Bearer '
  if (!value.startsWith(prefix)) return null
  return value.slice(prefix.length)
}

type RestoredPayload = {
  containerName: string
  cwd: string
  restartToken?: string
  wsHostPort?: number
  portForward?: PortForward
  brokerToken?: string
}

function isValidRestoredPayload(value: unknown, expectedName: string): value is RestoredPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.containerName !== expectedName) return false
  if (typeof v.cwd !== 'string') return false
  if (v.restartToken !== undefined && typeof v.restartToken !== 'string') return false
  if (v.wsHostPort !== undefined && (typeof v.wsHostPort !== 'number' || !Number.isFinite(v.wsHostPort))) return false
  if (v.brokerToken !== undefined && typeof v.brokerToken !== 'string') return false
  return true
}

async function restorePersistedRegistrations(
  apply: (payload: RestoredPayload) => Promise<void>,
  log: (event: DaemonLogEvent | SupervisorLogEvent) => void,
  probe: (name: string) => Promise<'alive' | 'gone' | 'unknown'>,
  removeFile: (name: string) => Promise<void>,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(registrationsDir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const expectedName = entry.slice(0, -'.json'.length)
    const filePath = join(registrationsDir(), entry)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'))
    } catch (error) {
      log({ kind: 'registration-skipped', containerName: expectedName, reason: stringifyError(error) })
      continue
    }
    if (!isValidRestoredPayload(parsed, expectedName)) {
      log({ kind: 'registration-skipped', containerName: expectedName, reason: 'schema mismatch' })
      continue
    }
    // Probe before reviving. A registration file for a container that no
    // longer exists is a leftover from a daemon that died ungracefully
    // (crash, `kill -9`, OS reboot) before deregister could clean up.
    // Reviving its broker would create a stale T_old broker that races a
    // subsequent `register` call's T_new broker — see portbroker-manager.ts
    // start() for the swap-race description. `unknown` (docker probe call
    // failed) errs toward restore: the existing GC tick will tear down the
    // registration if the container is genuinely gone, and we'd rather pay
    // one swap-race attempt than tear down a live registration on a flaky
    // `docker ps`.
    const status = await probe(expectedName)
    if (status === 'gone') {
      await removeFile(expectedName)
      log({ kind: 'registration-skipped', containerName: expectedName, reason: 'container not running' })
      continue
    }
    await apply(parsed)
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Races a teardown step against a wall clock so a hung dependency can't hold the
// per-container serial chain open forever. Resolves (never rejects) on timeout
// so the surrounding runSerially op always settles and releases the queue.
async function withCleanupTimeout(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([work.catch(() => {}), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorCode(error: Error): unknown {
  const direct = error as Error & { code?: unknown; cause?: unknown }
  if (direct.code !== undefined) return direct.code
  if (direct.cause instanceof Error) return errorCode(direct.cause)
  return undefined
}

async function listenOnSocket(server: Server, path: string, onWindows: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError)
      const code = errorCode(error)
      if (code === 'EADDRINUSE' || (onWindows && error.message.includes('Failed to listen at'))) {
        reject(new Error(`another typeclaw host daemon is already listening at ${path}`))
        return
      }
      reject(error)
    }
    server.once('error', onError)
    server.listen(path, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function closeSocketServer(server: Server, sockets: Set<NetSocket>): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve())
    } catch {
      resolve()
    }
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {}
    }
  })
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  await ensureDirs()
  const path = opts.socket ?? socketPath()
  const onWindows = isWindows()

  if (!onWindows && existsSync(path)) {
    if (await isDaemonReachable(500, { socket: path })) {
      throw new Error(`another typeclaw host daemon is already listening at ${path}`)
    }
    try {
      await unlink(path)
    } catch {}
  }

  const log = opts.onLog ?? (() => {})
  const exec = opts.exec ?? defaultDockerExec
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS
  const gcMissesToDeregister = opts.gcMissesToDeregister ?? DEFAULT_GC_MISSES_TO_DEREGISTER
  const cleanupStepTimeoutMs = opts.cleanupStepTimeoutMs ?? CLEANUP_STEP_TIMEOUT_MS
  const version = opts.version ?? UNVERSIONED_SENTINEL
  const cwds = new Map<string, string>()
  const restartTokens = new Map<string, string>()
  const brokerTokens = new Map<string, string>()
  const registrationGenerations = new Map<string, number>()
  let nextRegistrationGeneration = 0
  const perContainerSerial = new Map<string, Promise<unknown>>()
  const gcMisses = new Map<string, number>()
  const reportedExits = new Map<string, string>()
  let stopped = false
  let httpPort = 0
  // Boot-time restore runs concurrently with the listeners (see the kickoff
  // below). Declared here so the IPC dispatcher and HTTP handler — both defined
  // before restore starts — can gate on it; until it's assigned, no registry
  // RPC has been accepted yet, so resolving immediately is safe.
  let restoreComplete: Promise<void> | null = null
  const awaitRestored = (): Promise<void> => restoreComplete ?? Promise.resolve()

  const supervisor = opts.restart
    ? buildSupervisor({
        restart: opts.restart,
        onLog: (event) => log(event),
        isStopped: () => stopped,
      })
    : null

  // Per-container serialization: register/deregister chains through the same
  // promise per containerName, so a deregister arriving mid-register cannot
  // observe a partial state.
  const runSerially = <T>(name: string, op: () => Promise<T>): Promise<T> => {
    const prev = perContainerSerial.get(name) ?? Promise.resolve()
    const next = prev.then(op, op)
    perContainerSerial.set(
      name,
      next.catch(() => {}),
    )
    return next
  }

  type RegisterPayload = {
    containerName: string
    cwd: string
    restartToken?: string
    wsHostPort?: number
    portForward?: PortForward
    brokerToken?: string
  }

  // Atomic write: temp + rename within registrationsDir() so a crash mid-write
  // never leaves a half-written file that boot-time restore would misparse.
  const persistRegistration = async (payload: RegisterPayload): Promise<void> => {
    const final = registrationFilePath(payload.containerName)
    const tmp = `${final}.${process.pid}.tmp`
    const record = {
      containerName: payload.containerName,
      cwd: payload.cwd,
      restartToken: payload.restartToken,
      wsHostPort: payload.wsHostPort,
      portForward: payload.portForward,
      brokerToken: payload.brokerToken,
    }
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 })
    await rename(tmp, final)
  }

  const removeRegistrationFile = async (containerName: string): Promise<void> => {
    try {
      await unlink(registrationFilePath(containerName))
    } catch {}
  }

  // A broker reports fatal auth when its token no longer matches the running
  // container (typically a stale T_old broker revived on hostd boot racing a
  // container that now expects T_new). The token guard is load-bearing: a fresh
  // register may have overwritten brokerTokens with T_new before this late
  // callback fires, in which case we must NOT delete the live registration.
  const handleFatalAuthFailure = (containerName: string, failedToken: string, reason: string): Promise<void> =>
    runSerially(containerName, async () => {
      if (brokerTokens.get(containerName) !== failedToken) return
      brokerTokens.delete(containerName)
      cwds.delete(containerName)
      restartTokens.delete(containerName)
      registrationGenerations.delete(containerName)
      gcMisses.delete(containerName)
      if (opts.portbroker)
        await withCleanupTimeout(opts.portbroker.stop(containerName, 'fatal-auth'), cleanupStepTimeoutMs)
      if (opts.kakaoRenewal) await withCleanupTimeout(opts.kakaoRenewal.stop(containerName), cleanupStepTimeoutMs)
      if (opts.webexRenewal) await withCleanupTimeout(opts.webexRenewal.stop(containerName), cleanupStepTimeoutMs)
      if (opts.teamsRenewal) await withCleanupTimeout(opts.teamsRenewal.stop(containerName), cleanupStepTimeoutMs)
      await removeRegistrationFile(containerName)
      log({ kind: 'registration-skipped', containerName, reason: `fatal broker auth: ${reason}` })
    })

  const applyRegistration = async (payload: RegisterPayload): Promise<void> => {
    const alreadyRegistered = cwds.has(payload.containerName)
    registrationGenerations.set(payload.containerName, ++nextRegistrationGeneration)
    gcMisses.delete(payload.containerName)
    cwds.set(payload.containerName, payload.cwd)
    if (payload.restartToken) restartTokens.set(payload.containerName, payload.restartToken)
    else restartTokens.delete(payload.containerName)
    if (!alreadyRegistered) {
      log({ kind: 'register', containerName: payload.containerName })
    }
    if (
      opts.portbroker &&
      payload.wsHostPort !== undefined &&
      payload.portForward !== undefined &&
      payload.brokerToken !== undefined
    ) {
      brokerTokens.set(payload.containerName, payload.brokerToken)
      await opts.portbroker.start({
        containerName: payload.containerName,
        cwd: payload.cwd,
        policy: payload.portForward,
        wsHostPort: payload.wsHostPort,
        brokerToken: payload.brokerToken,
        onEvent: (event) => log({ kind: 'port-forward-event', event }),
        onTailscaleServeEvent: (event) => log({ kind: 'tailscale-serve-event', event }),
        onFatalAuthFailure: ({ brokerToken, reason }) => {
          void handleFatalAuthFailure(payload.containerName, brokerToken, reason)
        },
      })
    }
    if (opts.kakaoRenewal) {
      opts.kakaoRenewal.start({ containerName: payload.containerName, cwd: payload.cwd })
    }
    if (opts.webexRenewal) {
      opts.webexRenewal.start({ containerName: payload.containerName, cwd: payload.cwd })
    }
    if (opts.teamsRenewal) {
      opts.teamsRenewal.start({ containerName: payload.containerName, cwd: payload.cwd })
    }
  }

  const registerContainer = async (req: RegisterPayload): Promise<RpcResponse> => {
    if (stopped) return { ok: false, reason: 'daemon stopping' }
    return runSerially(req.containerName, async () => {
      if (stopped) return { ok: false, reason: 'daemon stopping' }
      try {
        await persistRegistration(req)
      } catch (error) {
        return {
          ok: false,
          reason: `failed to persist registration: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      await applyRegistration(req)
      return { ok: true }
    })
  }

  const handleRegister = async (req: RegisterPayload): Promise<RpcResponse> => registerContainer(req)

  const handleDeregister = async (req: { containerName: string }): Promise<RpcResponse> =>
    runSerially(req.containerName, async () => {
      const hadCwd = cwds.delete(req.containerName)
      restartTokens.delete(req.containerName)
      brokerTokens.delete(req.containerName)
      registrationGenerations.delete(req.containerName)
      gcMisses.delete(req.containerName)
      if (opts.portbroker)
        await withCleanupTimeout(opts.portbroker.stop(req.containerName, 'deregistered'), cleanupStepTimeoutMs)
      if (opts.kakaoRenewal) await withCleanupTimeout(opts.kakaoRenewal.stop(req.containerName), cleanupStepTimeoutMs)
      if (opts.webexRenewal) await withCleanupTimeout(opts.webexRenewal.stop(req.containerName), cleanupStepTimeoutMs)
      if (opts.teamsRenewal) await withCleanupTimeout(opts.teamsRenewal.stop(req.containerName), cleanupStepTimeoutMs)
      await removeRegistrationFile(req.containerName)
      if (hadCwd) log({ kind: 'deregister', containerName: req.containerName, reason: 'requested' })
      return { ok: true }
    })

  const handleList = (): RpcResponse => {
    const result: ListResult = {
      registrations: Array.from(cwds.entries()).map(([containerName, cwd]) => ({ containerName, cwd })),
    }
    return { ok: true, result }
  }

  const handleStatus = (req: { containerName: string }): RpcResponse => {
    const cwd = cwds.get(req.containerName)
    if (!cwd) return { ok: false, reason: `not registered: ${req.containerName}` }
    const result: StatusResult = {
      containerName: req.containerName,
      cwd,
      forwardedPorts: opts.portbroker?.forwardedPorts(req.containerName) ?? [],
    }
    return { ok: true, result }
  }

  // Lets the supervisor's restart update child registration lifecycle
  // in-process instead of over the socket. Both callbacks await restore for
  // the same no-mutation-before-restore invariant as the socket dispatcher.
  const registerCurrentChild = async (
    payload: HostDaemonRegisterPayload,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    await awaitRestored()
    const reply = await registerContainer(payload)
    return reply.ok ? { ok: true } : { ok: false, reason: reply.reason }
  }

  const deregisterCurrentChild = async (containerName: string): Promise<void> => {
    await awaitRestored()
    await handleDeregister({ containerName })
  }

  // Auth: only restart containers that registered with this daemon. The
  // socket is 0o600 + UID-bound, but inside a container any process that
  // reaches the mounted socket could otherwise restart any peer container on
  // the host. Scoping by registered name limits the blast radius to the set
  // of containers this user already started.
  const handleRestart = async (req: { containerName: string; build?: boolean }): Promise<RpcResponse> => {
    if (!supervisor) return { ok: false, reason: 'restart capability not enabled on this daemon' }
    if (req.build !== undefined && typeof req.build !== 'boolean') {
      return { ok: false, reason: 'restart.build must be a boolean if provided' }
    }
    const cwd = cwds.get(req.containerName)
    if (!cwd) return { ok: false, reason: `not registered: ${req.containerName}` }
    const preflight = opts.restartPreflight
      ? await opts.restartPreflight({ containerName: req.containerName, cwd, build: req.build })
      : null
    if (preflight) return preflight
    const ack = await supervisor.scheduleRestart({
      containerName: req.containerName,
      cwd,
      build: req.build,
      currentHostDaemon: { httpPort, register: registerCurrentChild, deregister: deregisterCurrentChild },
    })
    if (!ack.ok) return ack
    const result: RestartResult = { containerName: req.containerName, scheduled: true }
    return { ok: true, result }
  }

  const handleSecretsPatch = async (req: {
    containerName: string
    patch:
      | {
          channels:
            | { kakaotalk: unknown }
            | { discord: unknown }
            | { instagram: unknown }
            | { line: unknown }
            | { webex: unknown }
            | { teams: unknown }
            | { slack: unknown }
          mcp?: never
        }
      | { mcp: { server: unknown; credential: unknown }; channels?: never }
  }): Promise<RpcResponse> =>
    runSerially(req.containerName, async () => {
      const cwd = cwds.get(req.containerName)
      if (!cwd) return { ok: false, reason: `not registered: ${req.containerName}` }
      if (req.patch.mcp !== undefined) {
        const server = req.patch.mcp.server
        if (typeof server !== 'string' || server.length === 0) return { ok: false, reason: 'mcp.server is required' }
        const parsed = mcpCredentialSchema.safeParse(req.patch.mcp.credential)
        if (!parsed.success) {
          return { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join('; ') }
        }
        const backend = new SecretsBackend(join(cwd, 'secrets.json'))
        await backend.updateMcpAsync(async (mcp) => ({
          result: undefined,
          next: { ...mcp, [server]: parsed.data },
        }))
        const result: SecretsPatchResult = { containerName: req.containerName, patched: true }
        return { ok: true, result }
      }
      const channelsPatch = req.patch?.channels
      // Exactly one personal-account channel block per patch. KakaoTalk, LINE,
      // and Webex write their structured account block through this RPC; the
      // key present in the patch selects which block to validate and merge.
      const patch =
        'line' in channelsPatch
          ? { key: 'line' as const, parsed: lineChannelBlockSchema.safeParse(channelsPatch.line) }
          : 'instagram' in channelsPatch
            ? { key: 'instagram' as const, parsed: instagramChannelBlockSchema.safeParse(channelsPatch.instagram) }
            : 'discord' in channelsPatch
              ? { key: 'discord' as const, parsed: discordChannelBlockSchema.safeParse(channelsPatch.discord) }
              : 'webex' in channelsPatch
                ? { key: 'webex' as const, parsed: webexChannelBlockSchema.safeParse(channelsPatch.webex) }
                : 'teams' in channelsPatch
                  ? { key: 'teams' as const, parsed: teamsChannelBlockSchema.safeParse(channelsPatch.teams) }
                  : 'slack' in channelsPatch
                    ? { key: 'slack' as const, parsed: slackChannelBlockSchema.safeParse(channelsPatch.slack) }
                    : { key: 'kakaotalk' as const, parsed: kakaoChannelBlockSchema.safeParse(channelsPatch.kakaotalk) }
      if (!patch.parsed.success) {
        return { ok: false, reason: patch.parsed.error.issues.map((issue) => issue.message).join('; ') }
      }
      const data = patch.parsed.data
      const backend = new SecretsBackend(join(cwd, 'secrets.json'))
      await backend.updateChannelsAsync(async (channels) => ({
        result: undefined,
        next: { ...channels, [patch.key]: data },
      }))
      const result: SecretsPatchResult = { containerName: req.containerName, patched: true }
      return { ok: true, result }
    })

  const handleHttpInfo = (): RpcResponse => {
    const result: HttpInfoResult = { port: httpPort }
    return { ok: true, result }
  }

  const handleVersion = (): RpcResponse => {
    const result: VersionResult = { version }
    return { ok: true, result }
  }

  // Honors a `shutdown` RPC by ACKing first, then tearing the daemon down on
  // the next tick so the reply has time to drain over the socket. The CLI's
  // respawn flow polls the socket file's disappearance to know when it can
  // safely spawn a fresh daemon, which is why teardown must complete (and
  // unlink the socket) before exit. Why an RPC instead of the pidfile-based
  // SIGTERM the AGENTS.md "PID-reuse safety" rule warns about: the socket
  // round-trip itself proves we are talking to the daemon we just registered
  // with, so a stale pidfile cannot redirect the kill to an unrelated process.
  const handleShutdown = (): RpcResponse => {
    if (stopped) return { ok: true, result: { scheduled: true } satisfies ShutdownResult }
    log({ kind: 'shutdown-requested' })
    setTimeout(() => {
      void daemonHandle.stop().then(() => {
        if (opts.onShutdown) opts.onShutdown()
      })
    }, 0)
    return { ok: true, result: { scheduled: true } satisfies ShutdownResult }
  }

  const dispatch = async (req: Request): Promise<RpcResponse> => {
    switch (req.kind) {
      case 'register':
        await awaitRestored()
        return handleRegister(req)
      case 'deregister':
        await awaitRestored()
        return handleDeregister(req)
      case 'list':
        return handleList()
      case 'status':
        await awaitRestored()
        return handleStatus(req)
      case 'restart':
        await awaitRestored()
        return handleRestart(req)
      case 'secrets-patch':
        await awaitRestored()
        return handleSecretsPatch(req)
      case 'http-info':
        return handleHttpInfo()
      case 'version':
        return handleVersion()
      case 'shutdown':
        return handleShutdown()
    }
  }

  const respond = (socket: NetSocket, response: RpcResponse): void => {
    try {
      socket.write(`${JSON.stringify(response)}\n`)
    } catch {}
    try {
      socket.end()
    } catch {}
  }

  const handleData = (socket: NetSocket, chunk: Buffer, state: { buf: string }): void => {
    state.buf += chunk.toString('utf8')
    if (state.buf.length > MAX_REQUEST_BUFFER_BYTES) {
      respond(socket, { ok: false, reason: 'request exceeds buffer limit' })
      return
    }
    let newline = state.buf.indexOf('\n')
    while (newline >= 0) {
      const line = state.buf.slice(0, newline)
      state.buf = state.buf.slice(newline + 1)
      let req: Request
      try {
        req = JSON.parse(line) as Request
      } catch {
        respond(socket, { ok: false, reason: 'invalid request json' })
        return
      }
      void dispatch(req).then(
        (response) => respond(socket, response),
        (error) => respond(socket, { ok: false, reason: error instanceof Error ? error.message : String(error) }),
      )
      newline = state.buf.indexOf('\n')
    }
  }

  const httpFetch = async (req: globalThis.Request): Promise<globalThis.Response> => {
    const url = new URL(req.url)
    if (req.method !== 'POST' || url.pathname !== '/rpc') {
      return json({ ok: false, reason: 'not found' }, 404)
    }
    const token = bearerToken(req.headers.get('authorization'))
    if (!token) return json({ ok: false, reason: 'missing bearer token' }, 401)
    const contentLength = Number(req.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_REQUEST_BYTES) {
      return json({ ok: false, reason: 'request exceeds buffer limit' }, 413)
    }
    let rpc: Request
    try {
      const body = await req.text()
      if (body.length > MAX_HTTP_REQUEST_BYTES) return json({ ok: false, reason: 'request exceeds buffer limit' }, 413)
      rpc = JSON.parse(body) as Request
    } catch {
      return json({ ok: false, reason: 'invalid request json' }, 400)
    }
    if (rpc.kind !== 'restart' && rpc.kind !== 'secrets-patch') {
      return json({ ok: false, reason: 'http transport only supports restart and secrets-patch' }, 403)
    }
    // restartTokens is populated by boot-time restore; authorizing before it
    // completes would reject a valid token as "invalid restart token".
    await awaitRestored()
    if (restartTokens.get(rpc.containerName) !== token) {
      return json({ ok: false, reason: 'invalid restart token' }, 403)
    }
    return json(rpc.kind === 'restart' ? await handleRestart(rpc) : await handleSecretsPatch(rpc))
  }

  // A stopped container is still present in `docker ps -a` and may be
  // restarted by Docker; retain its registration and tokens. Inspect only
  // for diagnostics, never to decide whether to GC a present container.
  const probeContainerAlive = async (name: string): Promise<'alive' | 'gone' | 'unknown'> => {
    try {
      const result = await exec(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])
      if (result.exitCode !== 0) return 'unknown'
      const names = result.stdout.trim().split('\n')
      if (!names.includes(name)) return 'gone'
      const state = await inspectContainerExit(exec, name)
      // Report each stop once. The container ID survives restarts, so key the
      // report by ID and FinishedAt: repeated probes of one stop share a key,
      // while a restart that crashes again between two probes gets a new one.
      if (state?.kind === 'stopped' && state.reason !== null) {
        const exitKey = `${state.containerId}@${state.finishedAt}`
        if (reportedExits.get(name) !== exitKey) {
          reportedExits.set(name, exitKey)
          log({ kind: 'container-exited', containerName: name, reason: state.reason })
        }
      }
      return 'alive'
    } catch {
      return 'unknown'
    }
  }

  // Boot-time restore replays every persisted registration into the in-memory
  // maps and revives portbroker. It runs N docker-ps probes, so on a cold
  // daemon it can take seconds — longer than the CLI's spawn-readiness window.
  // We therefore start it WITHOUT blocking the listeners: the sockets accept
  // connections immediately (so `isDaemonReachable` succeeds fast and the CLI
  // injects the hostd env vars), but every handler that reads or mutates the
  // restored registry awaits `awaitRestored` first. That preserves the original
  // invariant — no RPC observes a half-restored registry — without coupling
  // readiness to docker latency. Kicked off BEFORE the HTTP/IPC listeners so no
  // request can slip past the gate in an unrestored window. A bad file (parse
  // error, schema mismatch) is logged-and-skipped; one corrupt registration
  // must not gate recovery.
  restoreComplete = restorePersistedRegistrations(applyRegistration, log, probeContainerAlive, removeRegistrationFile)
  // Swallow the rejection on a detached handle so a restore failure never
  // becomes an unhandledRejection before the first gated handler awaits it.
  // Handlers await `restoreComplete` directly so they still fail closed.
  restoreComplete.catch(() => {})

  const httpHostname = opts.httpHost ?? '0.0.0.0'
  // Try the stable port first so containers' cached TYPECLAW_HOSTD_URL stays
  // valid across hostd respawns. EADDRINUSE means another local service holds
  // it — fall back to ephemeral so the daemon still comes up. The fallback
  // doesn't break NEW container starts (the URL is captured fresh from
  // httpServer.port), but it does break the URL of containers that started
  // when 8974 was free and are still running. That trade-off favors keeping
  // hostd alive over preserving every URL — fail-hard would brick the whole
  // dev workflow whenever a port collision is hit.
  const tryServe = (port: number): ReturnType<typeof Bun.serve> | { error: 'EADDRINUSE' } => {
    try {
      return Bun.serve({ hostname: httpHostname, port, fetch: httpFetch })
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === 'EADDRINUSE') {
        return { error: 'EADDRINUSE' }
      }
      throw error
    }
  }
  const preferredPort = opts.httpPort ?? STABLE_HTTP_PORT
  const stableAttempt = tryServe(preferredPort)
  const httpServer =
    'error' in stableAttempt ? Bun.serve({ hostname: httpHostname, port: 0, fetch: httpFetch }) : stableAttempt
  if ('error' in stableAttempt) {
    log({ kind: 'daemon-http-port-fallback', preferred: preferredPort, actual: httpServer.port ?? 0 })
  }
  httpPort = httpServer.port ?? 0
  log({ kind: 'daemon-http-listening', host: httpHostname, port: httpPort })
  opts.currentHostDaemonHolder?.set({
    httpPort,
    register: registerCurrentChild,
    deregister: deregisterCurrentChild,
  })

  const sockets = new Set<NetSocket>()
  const listener = createServer((socket) => {
    const state = { buf: '' }
    sockets.add(socket)
    socket.on('data', (chunk: Buffer) => handleData(socket, chunk, state))
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  try {
    await listenOnSocket(listener, path, onWindows)
  } catch (error) {
    httpServer.stop(true)
    throw error
  }
  // Restrict POSIX sockets to the owning user; ~/.typeclaw/run is also 0700.
  if (!onWindows) await chmod(path, 0o600).catch(() => {})
  log({ kind: 'daemon-listening', socket: path })

  const runGc = async (): Promise<void> => {
    for (const name of Array.from(cwds.keys())) {
      const generation = registrationGenerations.get(name)
      if (generation === undefined) continue
      const status = await probeContainerAlive(name)
      void runSerially(name, async () => {
        // A probe is only authoritative for the registration it observed before
        // awaiting Docker. Re-registration installs a new generation before any
        // later async registration work, so stale probes cannot spend its miss
        // budget or remove it.
        if (registrationGenerations.get(name) !== generation) return
        if (status === 'alive') {
          gcMisses.delete(name)
          return
        }
        if (status === 'unknown') return
        const misses = (gcMisses.get(name) ?? 0) + 1
        if (misses < gcMissesToDeregister) {
          gcMisses.set(name, misses)
          return
        }
        gcMisses.delete(name)
        const hadCwd = cwds.delete(name)
        restartTokens.delete(name)
        brokerTokens.delete(name)
        registrationGenerations.delete(name)
        if (opts.portbroker) await withCleanupTimeout(opts.portbroker.stop(name, 'deregistered'), cleanupStepTimeoutMs)
        if (opts.kakaoRenewal) await withCleanupTimeout(opts.kakaoRenewal.stop(name), cleanupStepTimeoutMs)
        if (opts.webexRenewal) await withCleanupTimeout(opts.webexRenewal.stop(name), cleanupStepTimeoutMs)
        if (opts.teamsRenewal) await withCleanupTimeout(opts.teamsRenewal.stop(name), cleanupStepTimeoutMs)
        await removeRegistrationFile(name)
        if (hadCwd) log({ kind: 'deregister', containerName: name, reason: 'gone' })
      })
    }
  }

  const gcTimer = setInterval(() => {
    if (stopped || cwds.size === 0) return
    void runGc()
  }, gcIntervalMs)

  const daemonHandle: Daemon = {
    registered: () => Array.from(cwds.keys()),
    stop: async () => {
      if (stopped) return
      stopped = true
      log({ kind: 'daemon-stopping' })
      clearInterval(gcTimer)
      await closeSocketServer(listener, sockets)
      httpServer.stop(true)
      // A stop racing an in-flight boot restore could let a portbroker start
      // after the teardown loop below already ran, leaking it. Let restore
      // settle (it never rejects past the detached catch) before tearing down.
      await (restoreComplete ?? Promise.resolve()).catch(() => {})
      // Bound shutdown teardown too: a wedged broker/renewal stop must not
      // block daemon.stop() forever, which would also stall the version-drift
      // respawn flow that waits for this to return before unlinking the socket.
      if (opts.portbroker) {
        const names = Array.from(cwds.keys())
        await withCleanupTimeout(
          Promise.allSettled(names.map((n) => opts.portbroker!.stop(n, 'broker-stopped'))),
          cleanupStepTimeoutMs,
        )
      }
      if (opts.kakaoRenewal) {
        const names = Array.from(cwds.keys())
        await withCleanupTimeout(Promise.allSettled(names.map((n) => opts.kakaoRenewal!.stop(n))), cleanupStepTimeoutMs)
      }
      if (opts.webexRenewal) {
        const names = Array.from(cwds.keys())
        await withCleanupTimeout(Promise.allSettled(names.map((n) => opts.webexRenewal!.stop(n))), cleanupStepTimeoutMs)
      }
      if (opts.teamsRenewal) {
        const names = Array.from(cwds.keys())
        await withCleanupTimeout(Promise.allSettled(names.map((n) => opts.teamsRenewal!.stop(n))), cleanupStepTimeoutMs)
      }
      cwds.clear()
      restartTokens.clear()
      if (!onWindows) {
        try {
          if (existsSync(path)) await unlink(path)
        } catch {}
      }
    },
  }
  return daemonHandle
}
