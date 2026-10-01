import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, opendir, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS } from '@/config'

import { defaultDockerExec, resolveDockerBinary, sanitizeDockerStderr, type DockerExecResult } from './shared'

export type DockerLogArchiveResult =
  | { ok: true; status: 'archived'; path: string }
  | { ok: false; kind: 'unavailable'; reason: string }
  | { ok: false; kind: 'failed'; reason: string }

export type DockerLogArchiver = (input: {
  agentDir: string
  containerId: string
  retentionDays?: number
}) => Promise<DockerLogArchiveResult>

export type StreamCaptureInput = {
  args: string[]
  binary: string
  cwd: string
  finalSettlementMs?: number
  killFallbackMs?: number
  maxBytes: number
  output: FileHandle
  spawn?: (input: { args: string[]; binary: string; cwd: string }) => StreamingProcess
  timeoutMs: number
  writeChunk?: (output: FileHandle, chunk: Uint8Array, offset: number) => Promise<number>
  writeSettlementMs?: number
}

export type StreamingProcess = {
  exited: Promise<number>
  kill(signal: NodeJS.Signals): void
  stderr: ReadableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
  unref(): void
}

export type StreamCaptureResult = {
  exitCode: number
  overflowed: boolean
  stderrExcerpt: string
  terminationBoundExceeded?: boolean
  timedOut: boolean
}

export type DockerLogArchiveRuntime = {
  capture?: (input: StreamCaptureInput) => Promise<StreamCaptureResult>
  inspectLogConfig?: (args: string[], options: { cwd: string; signal: AbortSignal }) => Promise<DockerExecResult>
  nonce?: () => string
  now?: () => Date
  resolveDockerBinary?: () => string | null
}

export const DOCKER_LOG_ARCHIVE_TIMEOUT_MS = 60_000
export const MAX_DOCKER_LOG_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_DOCKER_LOG_ARCHIVE_SNAPSHOTS = 512
export const MAX_DOCKER_LOG_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024

const MAX_ARCHIVE_DIRECTORY_ENTRIES = 2048
const STDERR_EXCERPT_BYTES = 8 * 1024
const KILL_FALLBACK_MS = 1_000
const FINAL_SETTLEMENT_MS = 1_000
const CLEANUP_SETTLEMENT_MS = 1_000
const WRITE_SETTLEMENT_MS = 60_000
const STALE_PARTIAL_GRACE_MS = 5 * 60 * 1_000
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000
const MAX_FILENAME_ATTEMPTS = 16
// Fixed daemon protocol text from moby's daemon/logs.go, not human-language input.
const DOCKER_LOGS_TERMINAL_UNAVAILABLE = 'can not get logs from container which is dead or marked for removal'
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/
const NONCE_PATTERN = /^[a-f0-9]{32}$/
const ARCHIVE_FILENAME_PATTERN = /^[a-f0-9]{64}-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9]{32}\.log$/
const PARTIAL_FILENAME_PATTERN = /^\.[a-f0-9]{64}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{32}\.partial$/
const DOCKER_LOG_INSPECT_TIMEOUT_MS = 10_000

async function archiveByteLimit(
  agentDir: string,
  containerId: string,
  inspect: NonNullable<DockerLogArchiveRuntime['inspectLogConfig']>,
): Promise<number> {
  try {
    const result = await inspect(['inspect', '--format', '{{json .HostConfig.LogConfig}}', containerId], {
      cwd: agentDir,
      signal: AbortSignal.timeout(DOCKER_LOG_INSPECT_TIMEOUT_MS),
    })
    if (result.exitCode !== 0) return MAX_DOCKER_LOG_ARCHIVE_BYTES
    const config: unknown = JSON.parse(result.stdout)
    if (typeof config !== 'object' || config === null || !('Type' in config) || config.Type !== 'json-file')
      return MAX_DOCKER_LOG_ARCHIVE_BYTES
    if (!('Config' in config) || typeof config.Config !== 'object' || config.Config === null)
      return MAX_DOCKER_LOG_ARCHIVE_BYTES
    const opts = config.Config
    if (!('max-size' in opts) || typeof opts['max-size'] !== 'string') return MAX_DOCKER_LOG_ARCHIVE_BYTES
    const maxFiles = 'max-file' in opts ? opts['max-file'] : '1'
    // Docker parses max-file with strconv.Atoi, so "05" is 5; only positive counts are bounded.
    if (typeof maxFiles !== 'string' || !/^\+?\d+$/.test(maxFiles) || Number(maxFiles) < 1)
      return MAX_DOCKER_LOG_ARCHIVE_BYTES
    // Docker json-file uses go-units FromHumanSize: decimal powers even for "MiB".
    const sizeMatch = /^(\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?: ?(b|[kmgtp](?:i?b)?))?$/i.exec(opts['max-size'])
    if (!sizeMatch) return MAX_DOCKER_LOG_ARCHIVE_BYTES
    const prefix = sizeMatch[2]?.toLowerCase()[0]
    const multiplier = prefix && prefix !== 'b' ? 1000 ** ('kmgtp'.indexOf(prefix) + 1) : 1
    const size = Math.trunc(Number(sizeMatch[1]) * multiplier)
    const capacity = size * Number(maxFiles)
    if (size <= 0 || !Number.isSafeInteger(capacity)) return MAX_DOCKER_LOG_ARCHIVE_BYTES
    return Math.min(MAX_DOCKER_LOG_ARCHIVE_TOTAL_BYTES, Math.max(MAX_DOCKER_LOG_ARCHIVE_BYTES, capacity))
  } catch {
    return MAX_DOCKER_LOG_ARCHIVE_BYTES
  }
}

export async function archiveContainerLogs(
  { agentDir, containerId, retentionDays = DEFAULT_LOG_RETENTION_DAYS }: Parameters<DockerLogArchiver>[0],
  runtime: DockerLogArchiveRuntime = {},
): Promise<DockerLogArchiveResult> {
  if (!CONTAINER_ID_PATTERN.test(containerId)) {
    return { ok: false, kind: 'failed', reason: `Invalid full Docker container ID: ${containerId}` }
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_LOG_RETENTION_DAYS) {
    return { ok: false, kind: 'failed', reason: `Invalid Docker log archive retention period: ${retentionDays}` }
  }

  const logsDir = join(agentDir, '.typeclaw', 'logs')
  let temporaryPath: string | null = null
  let output: FileHandle | null = null

  try {
    await ensurePrivateDirectory(join(agentDir, '.typeclaw'))
    await ensurePrivateDirectory(logsDir)
    const now = runtime.now?.() ?? new Date()
    const ageCutoff = now.getTime() - retentionDays * MILLISECONDS_PER_DAY
    await pruneByAgeAndRemoveStalePartials(logsDir, ageCutoff, now.getTime())

    const allocation = await allocateArchive(logsDir, containerId, archiveTimestampText(now), runtime)
    temporaryPath = allocation.temporaryPath
    output = allocation.output

    const resolver = runtime.resolveDockerBinary ?? resolveDockerBinary
    const binary = resolver()
    if (binary === null) throw new Error('Docker binary could not be resolved for log archival')

    const capture = runtime.capture ?? streamProcessOutput
    const maxBytes = await archiveByteLimit(agentDir, containerId, runtime.inspectLogConfig ?? defaultDockerExec)
    const captured = await capture({
      args: ['logs', '--timestamps', containerId],
      binary,
      cwd: agentDir,
      maxBytes,
      output,
      timeoutMs: DOCKER_LOG_ARCHIVE_TIMEOUT_MS,
    })
    if (captured.terminationBoundExceeded) throw new Error('docker logs did not settle after SIGKILL')
    if (captured.timedOut) throw new Error(`docker logs timed out after ${DOCKER_LOG_ARCHIVE_TIMEOUT_MS}ms`)
    if (captured.overflowed) {
      throw new Error(
        `docker logs exceeded the ${maxBytes}-byte archive limit. Container ${containerId} was preserved; export both log streams with docker logs --timestamps ${containerId} > private-log-file 2>&1 (choose a private destination); confirm the export succeeded before removing it with docker rm ${containerId} and retrying.`,
      )
    }
    if (captured.exitCode !== 0) {
      const detail = sanitizeDockerStderr(captured.stderrExcerpt)
      const message = `docker logs exited with code ${captured.exitCode}${detail ? `: ${detail}` : ''}`
      if (isDockerLogsPermanentlyUnavailable(captured.stderrExcerpt)) throw new LogArchiveError('unavailable', message)
      throw new Error(message)
    }

    await output.chmod(0o600)
    const incomingSize = (await output.stat()).size
    if (incomingSize > MAX_DOCKER_LOG_ARCHIVE_TOTAL_BYTES) {
      throw new Error('Docker log archive exceeds total archive capacity')
    }
    await output.close()
    output = null

    await rename(temporaryPath, allocation.finalPath)
    temporaryPath = null
    await chmod(allocation.finalPath, 0o600)
    await pruneToCapacity(logsDir, allocation.finalPath)
    return { ok: true, status: 'archived', path: allocation.finalPath }
  } catch (error) {
    const cleanupErrors = await cleanupTemp(output, temporaryPath)
    const suffix = cleanupErrors.length === 0 ? '' : ` (${cleanupErrors.join('; ')})`
    return {
      ok: false,
      kind: error instanceof LogArchiveError ? error.kind : 'failed',
      reason: `${errorMessage(error)}${suffix}`,
    }
  }
}

export function dockerLogsUnavailableWarning(containerId: string): string {
  return `Docker reported logs unavailable for container ${containerId} because it is dead or already being removed; no new snapshot was captured. Continuing cleanup so the agent can restart. Existing snapshots in .typeclaw/logs/ are preserved.`
}

class LogArchiveError extends Error {
  constructor(
    readonly kind: 'unavailable',
    message: string,
  ) {
    super(message)
  }
}

function isDockerLogsPermanentlyUnavailable(stderr: string): boolean {
  return stderr.toLowerCase().includes(DOCKER_LOGS_TERMINAL_UNAVAILABLE)
}

export async function streamProcessOutput(input: StreamCaptureInput): Promise<StreamCaptureResult> {
  const { args, binary, cwd, maxBytes, output, timeoutMs } = input
  const killFallbackMs = input.killFallbackMs ?? KILL_FALLBACK_MS
  const finalSettlementMs = input.finalSettlementMs ?? FINAL_SETTLEMENT_MS
  const writeChunk = input.writeChunk ?? writeFileChunk
  const writeSettlementMs = input.writeSettlementMs ?? WRITE_SETTLEMENT_MS
  const proc = input.spawn?.({ args, binary, cwd }) ?? spawnStreamingProcess(input)
  const abortPumps = new AbortController()
  const stderrChunks: Uint8Array[] = []
  let stderrBytes = 0
  let acceptedBytes = 0
  let overflowed = false
  let timedOut = false
  let terminating = false
  let processSettled = false
  let terminationBoundExceeded = false
  let pumpError: unknown
  let writeError: unknown
  let writeQueue = Promise.resolve()
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined
  let finalTimer: ReturnType<typeof setTimeout> | undefined
  let forceSettle: ((exitCode: number) => void) | undefined
  const forcedExit = new Promise<number>((resolve) => {
    forceSettle = resolve
  })

  const terminate = (): void => {
    if (terminating || processSettled) return
    terminating = true
    proc.kill('SIGTERM')
    sigkillTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      finalTimer = setTimeout(() => {
        terminationBoundExceeded = true
        abortPumps.abort()
        proc.unref()
        forceSettle?.(-1)
      }, finalSettlementMs)
    }, killFallbackMs)
  }

  const enqueue = (chunk: Uint8Array, stderr: boolean): void => {
    if (stderr && stderrBytes < STDERR_EXCERPT_BYTES) {
      const excerpt = chunk.subarray(0, STDERR_EXCERPT_BYTES - stderrBytes)
      stderrChunks.push(excerpt)
      stderrBytes += excerpt.byteLength
    }
    if (terminating) return
    if (acceptedBytes + chunk.byteLength > maxBytes) {
      overflowed = true
      terminate()
      return
    }
    acceptedBytes += chunk.byteLength
    writeQueue = writeQueue
      .then(async () => {
        await writeAll(output, chunk, writeChunk)
      })
      .catch((error: unknown) => {
        writeError = error
        terminate()
      })
  }

  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)
  const stdoutPump = pump(proc.stdout, (chunk) => enqueue(chunk, false), abortPumps.signal).catch((error: unknown) => {
    pumpError = error
    terminate()
  })
  const stderrPump = pump(proc.stderr, (chunk) => enqueue(chunk, true), abortPumps.signal).catch((error: unknown) => {
    pumpError = error
    terminate()
  })
  const completion = Promise.all([proc.exited, stdoutPump, stderrPump]).then(([exitCode]) => {
    processSettled = true
    return exitCode
  })

  const exitCode = await Promise.race([completion, forcedExit])
  clearTimeout(timeout)
  if (sigkillTimer !== undefined) clearTimeout(sigkillTimer)
  if (finalTimer !== undefined) clearTimeout(finalTimer)
  if (terminationBoundExceeded) await Promise.allSettled([stdoutPump, stderrPump])
  await withDeadline(writeQueue, writeSettlementMs, 'Docker log archive write')
  if (writeError !== undefined) throw writeError
  if (pumpError !== undefined) throw pumpError
  return {
    exitCode,
    overflowed,
    stderrExcerpt: Buffer.concat(stderrChunks).toString('utf8'),
    terminationBoundExceeded,
    timedOut,
  }
}

async function writeAll(
  output: FileHandle,
  chunk: Uint8Array,
  writeChunk: NonNullable<StreamCaptureInput['writeChunk']>,
): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const bytesWritten = await writeChunk(output, chunk, offset)
    if (bytesWritten < 1) throw new Error('Docker log archive write made no progress')
    offset += bytesWritten
  }
}

async function writeFileChunk(output: FileHandle, chunk: Uint8Array, offset: number): Promise<number> {
  return (await output.write(chunk, offset, chunk.byteLength - offset)).bytesWritten
}

function spawnStreamingProcess({ args, binary, cwd }: StreamCaptureInput): StreamingProcess {
  return Bun.spawn({ cmd: [binary, ...args], cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader()
  const cancel = (): void => {
    void reader.cancel()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      onChunk(value)
    }
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(`Docker log archive path is not a real directory: ${path}`)
  await chmod(path, 0o700)
}

async function pruneByAgeAndRemoveStalePartials(logsDir: string, ageCutoff: number, now: number): Promise<void> {
  const stalePartialCutoff = now - DOCKER_LOG_ARCHIVE_TIMEOUT_MS - STALE_PARTIAL_GRACE_MS
  for (const entry of await collectDirectoryEntries(logsDir)) {
    if (!entry.isFile()) continue
    const path = join(logsDir, entry.name)
    const timestamp = archiveTimestamp(entry.name)
    if (timestamp !== null && timestamp < ageCutoff) {
      await removeRaceSafe(path)
    } else if (PARTIAL_FILENAME_PATTERN.test(entry.name)) {
      const stats = await lstatIfPresent(path)
      if (stats !== null && stats.mtimeMs < stalePartialCutoff) await removeRaceSafe(path)
    }
  }
}

async function pruneToCapacity(logsDir: string, publishedPath: string): Promise<void> {
  const snapshots: Array<{ name: string; path: string; size: number; timestamp: number }> = []
  for (const entry of await collectDirectoryEntries(logsDir)) {
    if (!entry.isFile()) continue
    const timestamp = archiveTimestamp(entry.name)
    if (timestamp === null) continue
    const path = join(logsDir, entry.name)
    const stats = await lstatIfPresent(path)
    if (stats !== null) snapshots.push({ name: entry.name, path, size: stats.size, timestamp })
  }
  snapshots.sort((left, right) => left.timestamp - right.timestamp || left.name.localeCompare(right.name))
  let totalBytes = snapshots.reduce((total, snapshot) => total + snapshot.size, 0)
  let count = snapshots.length
  for (const snapshot of snapshots) {
    if (count <= MAX_DOCKER_LOG_ARCHIVE_SNAPSHOTS && totalBytes <= MAX_DOCKER_LOG_ARCHIVE_TOTAL_BYTES) break
    if (snapshot.path === publishedPath) continue
    await removeRaceSafe(snapshot.path)
    count -= 1
    totalBytes -= snapshot.size
  }
}

async function collectDirectoryEntries(logsDir: string) {
  const entries = []
  const directory = await opendir(logsDir)
  for await (const entry of directory) {
    entries.push(entry)
    if (entries.length > MAX_ARCHIVE_DIRECTORY_ENTRIES)
      throw new Error(`Docker log archive directory exceeds ${MAX_ARCHIVE_DIRECTORY_ENTRIES} entries`)
  }
  return entries
}

async function allocateArchive(
  logsDir: string,
  containerId: string,
  timestamp: string,
  runtime: DockerLogArchiveRuntime,
): Promise<{ finalPath: string; output: FileHandle; temporaryPath: string }> {
  for (let attempt = 0; attempt < MAX_FILENAME_ATTEMPTS; attempt++) {
    const nonce = runtime.nonce?.() ?? randomBytes(16).toString('hex')
    if (!NONCE_PATTERN.test(nonce)) throw new Error(`Invalid Docker log archive nonce: ${nonce}`)
    const finalPath = join(logsDir, `${containerId}-${timestamp}-${nonce}.log`)
    const temporaryPath = join(logsDir, `.${containerId}-${timestamp}-${nonce}.partial`)
    let output: FileHandle
    try {
      output = await open(temporaryPath, 'wx', 0o600)
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue
      throw error
    }
    try {
      await lstat(finalPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { finalPath, output, temporaryPath }
      const cleanupErrors = await cleanupTemp(output, temporaryPath)
      throw new Error([errorMessage(error), ...cleanupErrors].join('; '))
    }
    const cleanupErrors = await cleanupTemp(output, temporaryPath)
    if (cleanupErrors.length > 0)
      throw new Error(['Archive filename collision cleanup failed', ...cleanupErrors].join('; '))
  }
  throw new Error('Could not allocate a unique Docker log archive filename')
}

async function cleanupTemp(output: FileHandle | null, path: string | null): Promise<string[]> {
  const errors: string[] = []
  if (output !== null) {
    try {
      await withDeadline(output.close(), CLEANUP_SETTLEMENT_MS, 'Docker log archive temp close')
    } catch (error) {
      errors.push(`temp close failed: ${errorMessage(error)}`)
    }
  }
  if (path !== null) {
    try {
      await withDeadline(rm(path, { force: true }), CLEANUP_SETTLEMENT_MS, 'Docker log archive temp cleanup')
    } catch (error) {
      errors.push(`temp cleanup failed: ${errorMessage(error)}`)
    }
  }
  return errors
}

async function removeRaceSafe(path: string): Promise<void> {
  try {
    await rm(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function archiveTimestamp(filename: string): number | null {
  const match = ARCHIVE_FILENAME_PATTERN.exec(filename)
  if (match === null) return null
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
  const timestamp = Date.parse(iso)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === iso ? timestamp : null
}

function archiveTimestampText(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
