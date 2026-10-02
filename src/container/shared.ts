import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join as joinPath, resolve, win32 } from 'node:path'

import { isWindows } from '@/shared'

export type DockerExecResult = { exitCode: number; stdout: string; stderr: string }

export type DockerExecOptions = {
  cwd?: string
  inheritStdio?: boolean
  signal?: AbortSignal
  // Extra environment for the docker child, merged over process.env. Used to
  // thread DOCKER_CONFIG when retrying a build under a sanitized config that
  // strips a broken credential helper (see runImageBuild).
  env?: Record<string, string | undefined>
  // Only meaningful with inheritStdio: mirror the child's stderr to the parent
  // terminal AND capture it into the returned `stderr`. Lets a streamed build
  // stay visible to the user while start() still inspects stderr to detect the
  // missing-credential-helper failure and decide whether to retry.
  captureStderr?: boolean
  // Piped commands normally retain complete output. Long-running callers can
  // still drain without retaining stdout and keep only stderr's diagnostic tail.
  captureStdout?: boolean
  maxCapturedStderrBytes?: number
}

export type DockerExec = (args: string[], options?: DockerExecOptions) => Promise<DockerExecResult>

export type ParsedContainerInspect = { ok: true; containerId: string; running: boolean } | { ok: false; reason: string }

export function parseContainerInspectOutput(output: string): ParsedContainerInspect {
  const match = /^([0-9a-f]{64})\|(true|false)$/.exec(output.trim())
  if (match === null) {
    return { ok: false, reason: 'expected <64 lowercase hex container ID>|<true|false>' }
  }
  return { ok: true, containerId: match[1]!, running: match[2] === 'true' }
}

export const defaultDockerExec: DockerExec = async (args, options) => {
  const bun = getBun()
  if (!bun) return { exitCode: -1, stdout: '', stderr: 'bun runtime not available' }
  // Resolve `docker` to an absolute path before spawning. Bun.spawn() resolves
  // a bare command name through Bun.which() internally, but Windows PATH/PATHEXT
  // resolution has a string of historical bugs (oven-sh/bun#16070, #11182,
  // #29636) that make `cmd: ['docker', …]` throw ENOENT even when Docker
  // Desktop is installed and docker.exe is on %PATH% — surfacing as the
  // misleading "Docker is not installed." on a machine that has Docker.
  // dockerCmd() goes through Bun.which(), which reliably honors PATHEXT and
  // returns the full docker.exe path; it returns null only when docker is
  // genuinely absent from PATH, which maps to the binary-missing sentinel.
  const cmd = dockerCmd(args)
  if (cmd === null) return { exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR }
  // Two overloads (pipe vs inherit) so each spawn call site has the literal
  // stdout/stderr type attached — that's what lets `new Response(proc.stdout)`
  // typecheck on the piped path. `signal` is forwarded to Bun.spawn so callers
  // can bound long-running docker subcommands (e.g. `docker logs` on a stuck
  // daemon). The ENOENT catch stays as a safety net for the race where the
  // binary disappears between resolution and spawn.
  const env = options?.env ? { ...process.env, ...options.env } : undefined
  if (options?.inheritStdio) {
    try {
      if (options.captureStderr) return await spawnInheritTeeStderr(bun, cmd, options.cwd, options.signal, env)
      const proc = bun.spawn({
        cmd,
        cwd: options.cwd,
        stdout: 'inherit',
        stderr: 'inherit',
        signal: options.signal,
        env,
      })
      return { exitCode: await proc.exited, stdout: '', stderr: '' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR }
      }
      throw error
    }
  }
  try {
    const proc = bun.spawn({
      cmd,
      cwd: options?.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: options?.signal,
      env,
    })
    const stdoutPromise = readCapturedStream(proc.stdout, options?.captureStdout === false ? 0 : undefined)
    const stderrPromise = readCapturedStream(proc.stderr, options?.maxCapturedStderrBytes)
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise])
    return { exitCode, stdout, stderr }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR }
    }
    throw error
  }
}

export async function readCapturedStream(stream: ReadableStream<Uint8Array>, maxBytes?: number): Promise<string> {
  if (maxBytes === undefined) return await new Response(stream).text()
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer')

  const reader = stream.getReader()
  let tail = Buffer.alloc(0)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (maxBytes === 0) continue
      const chunk = Buffer.from(value)
      tail =
        chunk.length >= maxBytes
          ? chunk.subarray(chunk.length - maxBytes)
          : Buffer.concat([tail, chunk]).subarray(-maxBytes)
    }
  } finally {
    reader.releaseLock()
  }
  return tail.toString('utf8')
}

// Streams a docker child's stdout straight to the parent terminal while teeing
// stderr to BOTH the terminal and a buffer. A plain `stderr: 'inherit'` would
// keep the build output live but leave start() blind to the failure reason;
// piping stderr alone would swallow the user-visible progress. The build path
// needs both: the user watches the build, and start() inspects the captured
// stderr to detect a missing credential helper and retry under a sanitized
// DOCKER_CONFIG.
export async function spawnInheritTeeStderr(
  bun: NonNullable<ReturnType<typeof getBun>>,
  cmd: string[],
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<DockerExecResult> {
  const proc = bun.spawn({ cmd, cwd, stdout: 'inherit', stderr: 'pipe', signal, env })
  const chunks: Uint8Array[] = []
  const reader = proc.stderr.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      process.stderr.write(value)
      chunks.push(value)
    }
  } catch (err) {
    // A read/write throw skips the normal drain: cancel (not just releaseLock,
    // which leaves the pipe live per the Streams contract), kill the child, and
    // await its exit so neither the stderr pipe nor the docker subprocess is
    // orphaned. releaseLock is handled in `finally` for both paths.
    await reader.cancel().catch(() => {})
    proc.kill()
    await proc.exited.catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }
  const exitCode = await proc.exited
  return { exitCode, stdout: '', stderr: Buffer.concat(chunks).toString('utf8') }
}

// Sentinel stderr from defaultDockerExec when docker can't be resolved/spawned.
// checkDockerAvailable matches on this exact string to distinguish
// "binary missing" from "daemon down".
export const DOCKER_NOT_FOUND_STDERR = 'docker: command not found in $PATH'

export type DockerBinaryProbes = {
  which?: (command: string) => string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

// Resolves the `docker` binary to an absolute path. First via Bun.which(),
// which — unlike a bare `cmd: ['docker']` handed to Bun.spawn() — reliably
// honors Windows PATHEXT and returns e.g. C:\…\docker.exe. On POSIX the
// resolved path equals what the bare name would have found.
//
// When Bun.which() finds nothing on Windows we fall back to Docker Desktop's
// known install locations: its installer registers docker.exe on the SYSTEM
// PATH, so a shell/process started before the install (or with a customized
// PATH) inherits a stale PATH where Bun.which can't see docker even though the
// binary exists and the engine is running — the real-world "Docker is not
// installed" report on a machine with a working Docker. Probing these paths
// fixes detection without a reinstall or PATH edit. The MS-Store packaged
// build is deliberately NOT probed: its binary lives in ACL-locked
// WindowsApps and can't be executed by a child process anyway.
//
// Returns null when docker is genuinely absent, which callers translate into
// the binary-missing sentinel. Probes are injectable so tests stay
// deterministic without depending on a real docker install or host platform.
export function resolveDockerBinary(probes: DockerBinaryProbes = {}): string | null {
  const which = probes.which ?? ((command: string) => getBun()?.which(command) ?? null)
  const fromPath = which('docker')
  if (fromPath !== null) return fromPath

  const platform = probes.platform ?? process.platform
  if (!isWindows(platform)) return null

  const exists = probes.exists ?? existsSync
  for (const candidate of windowsDockerCandidates(probes.env ?? process.env)) {
    if (exists(candidate)) return candidate
  }
  return null
}

// Real, child-process-executable docker.exe locations across the common
// Windows install methods, most-canonical first. All are confirmed real
// binaries or executable shims (not ACL-locked WindowsApps Store stubs).
// Probe order prefers Docker Desktop, then package-manager Docker, then the
// standalone CLI, then the Rancher Desktop alternative runtime. An
// arbitrary `--installation-dir` install can't be enumerated and is left to
// Bun.which/PATH.
function windowsDockerCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = []
  // win32.join (not the host-default join) so the probe builds backslash paths
  // regardless of the host the resolver runs/tests on.
  const add = (root: string | undefined, ...segments: string[]): void => {
    if (root) candidates.push(win32.join(root, ...segments))
  }
  // ProgramW6432 covers a 32-bit Bun seeing the WOW64-redirected ProgramFiles.
  const programFiles = env.ProgramW6432 ?? env.ProgramFiles ?? 'C:\\Program Files'
  const programData = env.ProgramData ?? 'C:\\ProgramData'

  // Docker Desktop: all-users, per-user, and the installer symlink dir.
  add(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')
  add(env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')
  add(programData, 'DockerDesktop', 'version-bin', 'docker.exe')
  // Docker Desktop pre-3.3.1 layout (resources\docker.exe, no \bin).
  add(programFiles, 'Docker', 'Docker', 'resources', 'docker.exe')
  // Chocolatey and Scoop shims (executable redirectors, on PATH after install).
  add(programData, 'chocolatey', 'bin', 'docker.exe')
  add(env.USERPROFILE, 'scoop', 'shims', 'docker.exe')
  // Standalone Docker CLI binary (Windows Server / manual `Expand-Archive`).
  add(programFiles, 'Docker', 'docker.exe')
  // Rancher Desktop's bundled Moby docker CLI (note the doubled `resources`).
  add(programFiles, 'Rancher Desktop', 'resources', 'resources', 'win32', 'bin', 'docker.exe')
  return candidates
}

// Builds the argv for a docker invocation with the binary resolved to an
// absolute path (see resolveDockerBinary). Returns null when docker is absent
// from PATH. The resolver is injectable so callers and tests stay deterministic
// without depending on a real docker install.
export function dockerCmd(args: string[], resolveBinary: () => string | null = resolveDockerBinary): string[] | null {
  const binary = resolveBinary()
  return binary === null ? null : [binary, ...args]
}

// Collapse a multi-line `docker` CLI stderr into a single readable clause
// suitable for inline `reason:` strings. The motivating case is `compose
// restart`, which prints one row per agent — raw stderr from a failed
// `docker run` is 3-5 lines (leading `docker: ` prefix, daemon error body,
// blank line, "Run 'docker run --help' for more information" tail) and
// turns each failing row into an ASCII wall. Strip the boilerplate, drop
// the help-pointer tail (it's noise in a programmatic context — users who
// hit it can run `docker run --help` themselves), and join any remaining
// detail lines with "; " so the result fits on the same row as the
// `✖ [name] failed:` prefix that wraps it.
export function sanitizeDockerStderr(stderr: string): string {
  const withoutHelpTail = stderr.replace(/\n*\s*Run '[^']+--help' for more information\s*\n?/g, '')
  const lines = withoutHelpTail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^docker:\s*/, '').replace(/^Error response from daemon:\s*/, ''))
    .filter((line) => line.length > 0)
  return lines.join('; ')
}

export type DockerAvailability =
  | { ok: true }
  | { ok: false; reason: 'binary-missing' | 'daemon-down' | 'unresponsive'; detail: string }

// A healthy `docker info` answers in well under a second; a refused connection
// fails immediately. The only thing this budget can cut short is a daemon that
// accepted the request and never answered — which is exactly the case we want
// to report rather than wait out. Deliberately generous so a cold Docker
// Desktop / OrbStack still lands inside it.
export const DOCKER_AVAILABILITY_TIMEOUT_MS = 5_000

// `docker info --format {{.ServerVersion}}` is the probe of choice because it
// requires both the client AND a reachable daemon. `docker --version` would
// miss the "Docker Desktop installed but not running" case, which is the
// common failure mode on macOS.
//
// The probe is time-bounded because an unresponsive daemon otherwise hangs it
// forever: a host VM in an OOM livelock accepts the connection and never
// replies, and `docker info` has no client-side deadline of its own. Every
// Docker-dependent CLI command gates on this function, so an unbounded probe
// means `status`, `start`, `stop`, `logs`, `tui` and `doctor` all wedge with no
// output at all — the tool you reach for when the host is sick is the one that
// hangs. Mirrors captureCrashLogs in ./verify-running: AbortSignal.timeout
// plus an explicit `signal.aborted` check to tell a timeout from a failure.
export async function checkDockerAvailable(
  exec: DockerExec = defaultDockerExec,
  timeoutMs: number = DOCKER_AVAILABILITY_TIMEOUT_MS,
): Promise<DockerAvailability> {
  const signal = AbortSignal.timeout(timeoutMs)
  const result = await exec(['info', '--format', '{{.ServerVersion}}'], { signal })
  if (result.exitCode === 0) return { ok: true }
  if (signal.aborted) {
    return { ok: false, reason: 'unresponsive', detail: `docker info did not respond within ${timeoutMs}ms` }
  }
  if (result.stderr === DOCKER_NOT_FOUND_STDERR) {
    return { ok: false, reason: 'binary-missing', detail: result.stderr }
  }
  return {
    ok: false,
    reason: 'daemon-down',
    detail: result.stderr.trim() || `docker info exited with code ${result.exitCode}`,
  }
}

// `docker buildx version` exits 0 only when the buildx CLI plugin is installed.
// `start` uses this to pick the build path: buildx present -> `docker buildx
// build` with the BuildKit Dockerfile (`--mount=type=cache` + the `# syntax=`
// pragma, fast cached rebuilds); absent -> a BuildKit-stripped Dockerfile built
// with the legacy `docker build`. Either way the agent image builds.
export async function buildxAvailable(exec: DockerExec = defaultDockerExec): Promise<boolean> {
  return (await exec(['buildx', 'version'])).exitCode === 0
}

// Detects the specific failure where Docker's configured credential helper
// binary (`docker-credential-<name>`, from `credsStore`/`credHelpers` in
// ~/.docker/config.json) is not on PATH, so docker aborts EVERY registry
// interaction — including anonymous pulls of the PUBLIC images typeclaw builds
// from. The canonical Windows case is a broken Docker Desktop install:
//   error getting credentials - err: exec: "docker-credential-desktop":
//   executable file not found in %PATH%
//
// Kept deliberately narrow (helper token + "credentials" + a not-found phrase)
// so a genuine private-registry auth failure is NOT mistaken for this and
// silently retried anonymously. Docker/BuildKit emit these as English Go/CLI
// runtime strings (not localized user text), so English matching is correct;
// the not-found phrasings cover Linux (`executable file not found`), Windows
// (`not recognized` / `cannot find the file`), and generic (`no such file`).
export function isMissingDockerCredentialHelper(stderr: string): boolean {
  const text = stderr.toLowerCase()
  const namesHelper = /docker-credential-[\w.-]+/i.test(stderr)
  const aboutCredentials = text.includes('getting credentials') || text.includes('credential')
  const notFound =
    text.includes('executable file not found') ||
    text.includes('no such file') ||
    text.includes('cannot find the file') ||
    text.includes('not recognized') ||
    text.includes('not found in %path%') ||
    text.includes('not found in $path')
  return namesHelper && aboutCredentials && notFound
}

type DockerConfigJson = Record<string, unknown> & { credsStore?: unknown; credHelpers?: unknown }

// Resolves the effective Docker config dir the same way the docker CLI does:
// $DOCKER_CONFIG wins, else ~/.docker.
export function dockerConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.DOCKER_CONFIG ?? joinPath(home, '.docker')
}

// Produces the JSON for a sanitized Docker config that drops ONLY the broken
// credential-helper hooks while preserving everything operationally relevant —
// inline `auths` (base64 creds for private mirrors), `proxies`, `currentContext`,
// `HttpHeaders`, plugin/feature flags. An empty `{}` would lose the user's
// context and proxy setup; copy-and-strip is the safe middle ground. The
// `contexts/` and `buildx/` subdirs are NOT copied here (they're referenced by
// path from the sanitized dir via the caller, which symlinks them) — this
// function only owns config.json's contents. Returns null when there is nothing
// to strip, signalling the caller to skip the retry entirely.
export function sanitizeDockerConfigJson(raw: string | null): string | null {
  let parsed: DockerConfigJson = {}
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw) as DockerConfigJson
    } catch {
      parsed = {}
    }
  }
  if (parsed.credsStore === undefined && parsed.credHelpers === undefined) return null
  const { credsStore: _credsStore, credHelpers: _credHelpers, ...rest } = parsed
  return JSON.stringify(rest, null, 2)
}

export type BindMountSpec = { src: string; dst: string; readonly?: boolean }

// Emits `--mount type=bind,...` argv for a host->container bind mount, used in
// place of the legacy `-v src:dst[:ro]` form. The `-v` short form splits on
// `:`, which collides with a Windows drive letter (`C:\agent` parses as host
// `C` + path `\agent`); `--mount`'s `key=value` CSV has no such ambiguity and
// fails loud on an unknown/missing key instead of silently creating a phantom
// host dir. Src is resolved to an absolute path because `--mount` (unlike `-v`)
// rejects relative sources. A literal comma in a path would break the CSV;
// it's rejected here rather than silently mis-parsed (paths with commas are
// pathological and were never supported by the `-v` form either).
export function dockerBindMount({ src, dst, readonly }: BindMountSpec): [string, string] {
  const absSrc = resolve(src)
  if (absSrc.includes(',') || dst.includes(',')) {
    throw new Error(`bind mount path contains a comma, which docker --mount cannot express: ${absSrc} -> ${dst}`)
  }
  const fields = [`type=bind`, `src=${absSrc}`, `dst=${dst}`]
  if (readonly) fields.push('readonly')
  return ['--mount', fields.join(',')]
}

export function containerNameFromCwd(cwd: string): string {
  return sanitizeContainerName(basename(resolve(cwd)))
}

// `docker rm` failures we treat as recoverable. The kind matters for the
// caller's next step:
//   - 'gone'        — "No such container". The container is already removed
//                     (peer `typeclaw stop`, manual `docker rm`, or async
//                     post-stop cleanup that finished first). The name is
//                     free to reuse immediately.
//   - 'in-progress' — "removal of container … is already in progress". Docker
//                     accepted a prior remove and is still draining it. The
//                     container is STILL PRESENT in `docker inspect` until
//                     the drain completes, so a `docker run --name <same>`
//                     fired right now would collide. Callers that follow
//                     `rm` with `run` MUST wait for the container to
//                     actually disappear — see waitForRemoval.
//   - null          — non-benign failure; surface as an error.
export type BenignRmKind = 'gone' | 'in-progress' | null

export function classifyRmStderr(stderr: string): BenignRmKind {
  const lower = stderr.toLowerCase()
  if (lower.includes('no such container')) return 'gone'
  if (lower.includes('removal of container')) return 'in-progress'
  return null
}

export function isGenuineMissingContainer(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return normalized.includes('no such container') || normalized.includes('no such object')
}

// Detects Docker's name-conflict response from `docker run --name <X>`:
//   docker: Error response from daemon: Conflict. The container name
//   "/<X>" is already in use by container "<id>". You have to remove
//   (or rename) that container to be able to reuse that name.
//
// The dominant cause of this error in `typeclaw compose restart` is NOT a
// transient name-reservation drain (PR #121's hypothesis) but a concrete
// corpse left behind by an earlier `docker run` in the same start() call
// that failed AFTER Docker created the container record. The canonical
// path: compose restart fires N agents in parallel via Promise.all; they
// race for the preferred host port; the loser's `docker run -p <busy>:...`
// fails with "port is already allocated", and depending on the daemon
// version Docker may have already created the container record before the
// port bind failed. start()'s port-TOCTOU retry then re-runs `docker run`
// with a fresh ephemeral port but the SAME --name, and hits this conflict
// against the corpse from the previous attempt. The corpse is stable —
// sleep-only retries cannot make it go away.
//
// The fix is destructive: when this error fires for a non-running same-name
// container, remove it before retrying. cleanupRunCorpse uses non-force rm so
// Docker still refuses if that same ID starts after the inspect probe.
//
// Matches case-insensitively on the canonical phrasing across Docker
// Engine, Docker Desktop, and OrbStack. The (or rename) clause is the
// most stable substring across vendor message variants.
export function isContainerNameConflict(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return lower.includes('container name') && lower.includes('is already in use')
}

// Result of probing whether a previous `docker run --name <X>` left a corpse
// blocking the next run:
//   - 'gone'     — no container with that name. Safe to `docker run --name`.
//   - 'removed'  — corpse existed and was removed (and waitForRemoval
//                  confirmed it disappeared). Safe to `docker run --name`.
//   - 'running'  — a container with that name is currently RUNNING. We did
//                  NOT remove it. Caller must NOT proceed with `docker run
//                  --name <same>`: that would either fail again or imply a
//                  concurrent legitimate start that we should not kill.
//   - 'stuck'    — corpse existed but did not disappear within waitForRemoval
//                  budget. Caller should surface a clear error rather than
//                  loop forever.
export type BeforeContainerRemove = (containerId: string) => Promise<{ ok: true } | { ok: false; reason: string }>

export type CorpseCleanupOutcome = 'gone' | 'removed' | 'running' | 'stuck' | { archiveFailed: string }

// Inspects the named container; if a non-running corpse is holding the name,
// runs the caller's required archival hook, removes it without force, and waits for the
// removal to drain. An archival failure leaves the corpse untouched.
// Explicitly refuses to touch a RUNNING container so that a concurrent
// legitimate start of the same name (or a foreign-but-named container the
// user wants kept alive) is never killed by this cleanup path. Errors from
// the rm itself are folded into 'stuck' so the caller can surface a single
// "still here" reason rather than chase docker stderr variants.
//
// The rm is keyed on the container ID we read from the same inspect call,
// NOT on the name. This closes the TOCTOU window where another process
// could create a live container with the same name between our inspect
// (saw a non-running corpse with ID A) and our rm: removing by name would
// kill the new live container with ID B, but removing by ID A targets the
// specific corpse we measured. If ID A is already gone by the time rm
// fires (e.g. a concurrent cleanup beat us), the rm returns "No such
// container" which classifyRmStderr folds into 'gone'. waitForRemoval
// is still keyed on name because that's what the caller's next
// `docker run --name <name>` will actually collide on.
export async function cleanupRunCorpse(
  exec: DockerExec,
  name: string,
  beforeRemove: BeforeContainerRemove,
): Promise<CorpseCleanupOutcome> {
  const probe = await exec(['inspect', '--format', '{{.Id}}|{{.State.Running}}', name])
  if (probe.exitCode !== 0) return 'gone'
  const parsed = parseContainerInspectOutput(probe.stdout)
  if (!parsed.ok) return 'stuck'
  if (parsed.running) return 'running'
  const prepared = await beforeRemove(parsed.containerId)
  if (!prepared.ok) return { archiveFailed: prepared.reason }
  const rm = await exec(['rm', parsed.containerId])
  if (rm.exitCode !== 0) {
    const kind = classifyRmStderr(rm.stderr)
    if (kind === 'gone') return 'gone'
    if (kind === null) return 'stuck'
  }
  return (await waitForRemoval(exec, name)) ? 'removed' : 'stuck'
}

// Polls `docker inspect` until the named container is gone or the deadline
// elapses. Required after a `docker rm` that returned "removal of container
// … is already in progress": Docker has committed to removal but has not
// finished, so the name is briefly still taken. Without this wait, the
// caller's subsequent `docker run --name <same>` races the daemon's
// removal-drain and intermittently fails with a name conflict (the
// user-visible symptom under `typeclaw compose restart` and any restart of
// a container that hostd's GC tick raced ahead on). Returns true if the
// container disappeared before the deadline, false on timeout.
//
// NOTE: `inspect` reporting "gone" is necessary but NOT sufficient for
// `docker run --name <same>` to succeed — Docker's name-reservation table
// drains independently. waitForRemoval is the fast path; the retry on
// `docker run` (see isContainerNameConflict) is the safety net.
//
// The budget is generous because a draining removal is normal, not stuck:
// OrbStack has been observed taking ~40s to destroy agents with large
// writable layers. Timing out early makes `compose restart` report a healthy
// drain as stuck and tell the operator to restart Docker for nothing.
export const CONTAINER_REMOVAL_TIMEOUT_MS = 120_000

export async function waitForRemoval(
  exec: DockerExec,
  name: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? CONTAINER_REMOVAL_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await exec(['inspect', '--format', '{{.State.Running}}', name])
    if (result.exitCode !== 0) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  const final = await exec(['inspect', '--format', '{{.State.Running}}', name])
  return final.exitCode !== 0
}

export function imageTagFromCwd(cwd: string): string {
  return `typeclaw-${containerNameFromCwd(cwd)}`
}

// Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*.
//
// Non-ASCII names (Korean/CJK/Cyrillic/accented Latin — the common Windows case
// where the profile folder is a localized display name, e.g. C:\Users\사용자\봇)
// have every out-of-charset character collapsed to a dash, so distinct folders
// reduce to the SAME string: '봇' and '집' both → 'tc--'. The container name keys
// hostd registration and the secrets key path, so that collision is silent
// host-side state clobbering, not cosmetics. For any name carrying a non-ASCII
// char we append a deterministic hash of the original (cf. makeUntitledSlug in
// the memory plugin) to keep distinct folders distinct; surviving ASCII stays a
// readable prefix. ASCII-only names take the original branch — never renamed.
function sanitizeContainerName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (/[^\u0000-\u007f]/.test(name)) {
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
    const remnant = cleaned.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    if (remnant === '') return `tc-${hash}`
    const base = /^[a-zA-Z0-9]/.test(remnant) ? remnant : `tc-${remnant}`
    return `${base}-${hash}`
  }
  if (cleaned === '' || !/^[a-zA-Z0-9]/.test(cleaned)) {
    return `tc-${cleaned || 'agent'}`
  }
  return cleaned
}

export async function imageExists(tag: string): Promise<boolean> {
  const bun = getBun()
  if (!bun) return false
  const cmd = dockerCmd(['image', 'inspect', tag])
  if (cmd === null) return false
  const proc = bun.spawn({
    cmd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (await proc.exited) === 0
}

export async function containerExists(name: string): Promise<boolean> {
  return (await inspectContainer(name)).exists
}

export type ContainerState = { exists: false } | { exists: true; running: boolean }

// `docker inspect` is the canonical way to ask Docker about a single container
// by name. It returns exit 0 with `true`/`false` when the container exists (in
// any state: running, exited, dead, or being removed) and exit 1 otherwise.
// We deliberately do NOT use `docker ps` / `docker ps -a` here because the
// State.Running boolean — not mere presence in `ps -a` — is what callers need
// to distinguish a live agent from a corpse left over after a crash (which,
// since we run without `--rm`, sticks around in `ps -a` until the next start).
// Goes through DockerExec rather than spawning directly so callers can bound it
// and tests can inject it. Both matter for the diagnostic paths: an unresponsive
// daemon accepts `docker inspect` and never answers, which would hang `doctor` —
// the one command whose whole job is to report on a sick host.
export async function inspectContainer(
  name: string,
  options: { signal?: AbortSignal; exec?: DockerExec } = {},
): Promise<ContainerState> {
  const exec = options.exec ?? defaultDockerExec
  const result = await exec(
    ['inspect', '--format', '{{.State.Running}}', name],
    options.signal === undefined ? undefined : { signal: options.signal },
  )
  if (result.exitCode !== 0) return { exists: false }
  return { exists: true, running: result.stdout.trim() === 'true' }
}

export function getBun(): { spawn: typeof Bun.spawn; which: typeof Bun.which } | undefined {
  return (globalThis as { Bun?: { spawn: typeof Bun.spawn; which: typeof Bun.which } }).Bun
}
