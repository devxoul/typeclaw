import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS } from '@/config'

import {
  archiveContainerLogs,
  DOCKER_LOG_ARCHIVE_TIMEOUT_MS,
  MAX_DOCKER_LOG_ARCHIVE_BYTES,
  MAX_DOCKER_LOG_ARCHIVE_SNAPSHOTS,
  type DockerLogArchiveRuntime,
  type StreamCaptureInput,
  type StreamingProcess,
  streamProcessOutput,
} from './log-archive'

const CONTAINER_ID = 'a'.repeat(64)
const NOW = new Date('2026-01-15T12:30:45.678Z')
const FIRST_NONCE = '1'.repeat(32)
const SECOND_NONCE = '2'.repeat(32)
const LOG_TEXT = '2026-01-15T12:30:45.000000000Z hello\n'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-log-archive-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

function archiveFilename(date: Date, nonce: string = FIRST_NONCE, containerId: string = CONTAINER_ID): string {
  return `${containerId}-${date.toISOString().replace(/[:.]/g, '-')}-${nonce}.log`
}

function runtime(
  capture: DockerLogArchiveRuntime['capture'] = successfulCapture(),
  nonces: string[] = [FIRST_NONCE],
): DockerLogArchiveRuntime {
  const remaining = [...nonces]
  return {
    capture,
    inspectLogConfig: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    nonce: () => remaining.shift() ?? FIRST_NONCE,
    now: () => new Date(NOW),
    resolveDockerBinary: () => '/usr/bin/docker',
  }
}

function successfulCapture(output: string = LOG_TEXT, stderr: string = ''): DockerLogArchiveRuntime['capture'] {
  return async ({ output: file }) => {
    await file.write(`${output}${stderr}`)
    return { exitCode: 0, overflowed: false, stderrExcerpt: stderr, timedOut: false }
  }
}

describe('streamProcessOutput', () => {
  test('drains large stdout and stderr concurrently into the file without whole-output buffering', async () => {
    const path = join(agentDir, 'large.log')
    const output = await open(path, 'wx', 0o600)
    const chunkBytes = 64 * 1024
    const chunkCount = 32
    const script = `const x='x'.repeat(${chunkBytes});const y='y'.repeat(${chunkBytes});for(let i=0;i<${chunkCount};i++)process.stdout.write(x);for(let i=0;i<${chunkCount};i++)process.stderr.write(y)`

    const result = await streamProcessOutput({
      args: ['-e', script],
      binary: process.execPath,
      cwd: agentDir,
      maxBytes: 8 * 1024 * 1024,
      output,
      timeoutMs: 10_000,
    })
    await output.close()

    expect(result).toMatchObject({ exitCode: 0, overflowed: false, timedOut: false })
    const contents = await readFile(path)
    expect(contents.filter((byte) => byte === 'x'.charCodeAt(0))).toHaveLength(chunkBytes * chunkCount)
    expect(contents.filter((byte) => byte === 'y'.charCodeAt(0))).toHaveLength(chunkBytes * chunkCount)
  })

  test('terminates capture when streamed output exceeds the injected byte limit', async () => {
    const path = join(agentDir, 'overflow.log')
    const output = await open(path, 'wx', 0o600)
    const result = await streamProcessOutput({
      args: ['-e', `process.stdout.write('x'.repeat(1024 * 1024));setTimeout(()=>{},10000)`],
      binary: process.execPath,
      cwd: agentDir,
      maxBytes: 1024,
      output,
      timeoutMs: 10_000,
    })
    await output.close()

    expect(result.overflowed).toBe(true)
    expect((await stat(path)).size).toBeLessThanOrEqual(1024)
  })

  test('retries short writes until every offered byte is persisted', async () => {
    const path = join(agentDir, 'short-write.log')
    const output = await open(path, 'wx', 0o600)
    let writes = 0
    const result = await streamProcessOutput({
      args: ['-e', `process.stdout.write('complete')`],
      binary: process.execPath,
      cwd: agentDir,
      maxBytes: 1024,
      output,
      timeoutMs: 10_000,
      writeChunk: async (file, chunk, offset) => {
        writes += 1
        const length = Math.min(2, chunk.byteLength - offset)
        return (await file.write(chunk, offset, length)).bytesWritten
      },
    })
    await output.close()

    expect(result.exitCode).toBe(0)
    expect(writes).toBeGreaterThan(1)
    expect(await readFile(path, 'utf8')).toBe('complete')
  })

  test.each([
    { message: 'Docker log archive write made no progress', write: async () => 0 },
    {
      message: 'injected write failure',
      write: async () => {
        throw new Error('injected write failure')
      },
    },
  ])('terminates and settles capture after write failure: $message', async ({ message, write }) => {
    const output = await open(join(agentDir, 'write-failure.log'), 'wx', 0o600)
    await expect(
      streamProcessOutput({
        args: ['-e', `process.stdout.write('failure')`],
        binary: process.execPath,
        cwd: agentDir,
        maxBytes: 1024,
        output,
        timeoutMs: 10_000,
        writeChunk: write,
      }),
    ).rejects.toThrow(message)
    await output.close()
  })

  test('bounds a write promise that never settles', async () => {
    const output = await open(join(agentDir, 'stalled-write.log'), 'wx', 0o600)

    await expect(
      streamProcessOutput({
        args: ['-e', `process.stdout.write('stalled')`],
        binary: process.execPath,
        cwd: agentDir,
        maxBytes: 1024,
        output,
        timeoutMs: 10_000,
        writeChunk: async () => await new Promise<number>(() => {}),
        writeSettlementMs: 5,
      }),
    ).rejects.toThrow('Docker log archive write timed out after 5ms')

    await output.close()
  })

  test.each([
    { bound: false, label: 'settles after SIGKILL' },
    { bound: true, label: 'force-settles after the final bound' },
  ])('$label', async ({ bound }) => {
    const output = await open(join(agentDir, 'termination.log'), 'wx', 0o600)
    const signals: NodeJS.Signals[] = []
    let unrefed = false
    let settle: ((code: number) => void) | undefined
    const streams = bound ? [hangingStream(), hangingStream()] : [closedStream(), closedStream()]
    const proc: StreamingProcess = {
      exited: new Promise((resolve) => {
        settle = resolve
      }),
      kill: (signal) => {
        signals.push(signal)
        if (!bound && signal === 'SIGKILL') settle?.(137)
      },
      stderr: streams[0]!,
      stdout: streams[1]!,
      unref: () => {
        unrefed = true
      },
    }
    const result = await streamProcessOutput({
      args: [],
      binary: process.execPath,
      cwd: agentDir,
      finalSettlementMs: 5,
      killFallbackMs: 5,
      maxBytes: 1024,
      output,
      spawn: () => proc,
      timeoutMs: 5,
    })
    await output.close()

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(unrefed).toBe(bound)
    expect(result).toMatchObject({ terminationBoundExceeded: bound, timedOut: true })
  })
})

describe('archiveContainerLogs', () => {
  test('streams timestamped logs to a private temp and atomically publishes in the agent folder', async () => {
    const logsDir = join(agentDir, '.typeclaw', 'logs')
    let entriesDuringCapture: string[] = []
    const capture = async (input: StreamCaptureInput) => {
      expect(input.binary).toBe('/usr/bin/docker')
      expect(input.args).toEqual(['logs', '--timestamps', CONTAINER_ID])
      expect(input.cwd).toBe(agentDir)
      expect(input.maxBytes).toBe(MAX_DOCKER_LOG_ARCHIVE_BYTES)
      expect(input.timeoutMs).toBe(DOCKER_LOG_ARCHIVE_TIMEOUT_MS)
      entriesDuringCapture = await readdir(logsDir)
      await input.output.write(`${LOG_TEXT}stderr log\n`)
      return { exitCode: 0, overflowed: false, stderrExcerpt: 'stderr log\n', timedOut: false }
    }

    const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime(capture))

    const expectedPath = join(logsDir, archiveFilename(NOW))
    expect(result).toEqual({ ok: true, status: 'archived', path: expectedPath })
    expect(entriesDuringCapture).toHaveLength(1)
    expect(entriesDuringCapture[0]).toEndWith('.partial')
    expect(await readFile(expectedPath, 'utf8')).toBe(`${LOG_TEXT}stderr log\n`)
    if (process.platform !== 'win32') {
      expect((await lstat(join(agentDir, '.typeclaw'))).mode & 0o777).toBe(0o700)
      expect((await lstat(logsDir)).mode & 0o777).toBe(0o700)
      expect((await lstat(expectedPath)).mode & 0o777).toBe(0o600)
    }
  })

  test('archives logs above 64 MiB when the container uses bounded Docker log rotation', async () => {
    const archiveRuntime = runtime(async (input) => {
      expect(input.maxBytes).toBe(100_000_000)
      return await streamProcessOutput({
        ...input,
        binary: process.execPath,
        args: ['-e', "const chunk = 'x'.repeat(1024 * 1024); for (let i = 0; i < 68; i++) process.stdout.write(chunk)"],
      })
    })
    archiveRuntime.inspectLogConfig = async (args, options) => {
      expect(args).toEqual(['inspect', '--format', '{{json .HostConfig.LogConfig}}', CONTAINER_ID])
      expect(options.cwd).toBe(agentDir)
      return {
        exitCode: 0,
        stdout: '{"Type":"json-file","Config":{"max-size":"20m","max-file":"5"}}',
        stderr: '',
      }
    }

    const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, archiveRuntime)
    expect(result.ok).toBe(true)
    if (result.ok) expect((await stat(result.path)).size).toBe(68 * 1024 * 1024)
  })

  test.each([
    { label: 'unbounded driver', config: '{"Type":"json-file","Config":{}}', limit: MAX_DOCKER_LOG_ARCHIVE_BYTES },
    {
      label: 'oversized rotation',
      config: '{"Type":"json-file","Config":{"max-size":"200m","max-file":"5"}}',
      limit: 512 * 1024 * 1024,
    },
    {
      label: 'compressed local driver',
      config: '{"Type":"local","Config":{"max-size":"20m","max-file":"5"}}',
      limit: MAX_DOCKER_LOG_ARCHIVE_BYTES,
    },
  ])('keeps the container on $label archive overflow and explains manual recovery', async ({ config, limit }) => {
    const archiveRuntime = runtime(async ({ maxBytes, output }) => {
      expect(maxBytes).toBe(limit)
      await output.write('partial')
      return { exitCode: -1, overflowed: true, stderrExcerpt: '', timedOut: false }
    })
    archiveRuntime.inspectLogConfig = async () => ({ exitCode: 0, stdout: config, stderr: '' })

    const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, archiveRuntime)
    expect(result).toMatchObject({ ok: false, kind: 'failed' })
    if (!result.ok) {
      expect(result.reason).toContain(`docker logs exceeded the ${limit}-byte archive limit`)
      expect(result.reason).toContain(`docker logs --timestamps ${CONTAINER_ID}`)
      expect(result.reason).toContain(`docker logs --timestamps ${CONTAINER_ID} > private-log-file 2>&1`)
      expect(result.reason).toContain('confirm the export succeeded before')
      expect(result.reason).toContain(`docker rm ${CONTAINER_ID}`)
    }
    expect(await readdir(join(agentDir, '.typeclaw', 'logs'))).toEqual([])
  })

  test.each(['abc', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}.log`, '../escape'])(
    'rejects invalid container ID %s without touching the agent folder',
    async (containerId) => {
      expect((await archiveContainerLogs({ agentDir, containerId }, runtime())).ok).toBe(false)
      expect(await readdir(agentDir)).toEqual([])
    },
  )

  test.each([0, -1, 1.5, Number.NaN, MAX_LOG_RETENTION_DAYS + 1])(
    'rejects invalid retention %s without touching the agent folder',
    async (retentionDays) => {
      const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID, retentionDays }, runtime())
      expect(result.ok).toBe(false)
      expect(await readdir(agentDir)).toEqual([])
    },
  )

  test('returns failed with bounded useful stderr and removes temp output on docker failure', async () => {
    const capture: DockerLogArchiveRuntime['capture'] = async ({ output }) => {
      await output.write('incomplete\n')
      return {
        exitCode: 17,
        overflowed: false,
        stderrExcerpt:
          "docker: Error response from daemon: permission denied\ndetail\nRun 'docker logs --help' for more information\n",
        timedOut: false,
      }
    }

    const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime(capture))

    expect(result).toEqual({
      ok: false,
      kind: 'failed',
      reason: 'docker logs exited with code 17: permission denied; detail',
    })
    expect(await readdir(join(agentDir, '.typeclaw', 'logs'))).toEqual([])
  })

  test.each([
    'can not get logs from container which is dead or marked for removal',
    'ERROR: CAN NOT GET LOGS FROM CONTAINER WHICH IS DEAD OR MARKED FOR REMOVAL; retry is futile',
  ])('classifies terminal Docker log unavailability and cleans temp output: %s', async (stderrExcerpt) => {
    const capture: DockerLogArchiveRuntime['capture'] = async ({ output }) => {
      await output.write('partial')
      return { exitCode: 1, overflowed: false, stderrExcerpt, timedOut: false }
    }

    const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime(capture))

    expect(result).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(await readdir(join(agentDir, '.typeclaw', 'logs'))).toEqual([])
  })

  test.each(['permission denied', 'arbitrary daemon failure'])(
    'keeps unrelated docker logs stderr fatal: %s',
    async (stderrExcerpt) => {
      const capture: DockerLogArchiveRuntime['capture'] = async () => ({
        exitCode: 1,
        overflowed: false,
        stderrExcerpt,
        timedOut: false,
      })

      expect(await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime(capture))).toMatchObject({
        ok: false,
        kind: 'failed',
      })
    },
  )

  test.each([
    {
      bound: false,
      expected: `docker logs timed out after ${DOCKER_LOG_ARCHIVE_TIMEOUT_MS}ms`,
      overflowed: false,
      timedOut: true,
    },
    {
      bound: false,
      expected: `docker logs exceeded the ${MAX_DOCKER_LOG_ARCHIVE_BYTES}-byte archive limit`,
      overflowed: true,
      timedOut: false,
    },
    { bound: true, expected: 'docker logs did not settle after SIGKILL', overflowed: false, timedOut: true },
  ])(
    'cleans temp output after bounded capture failure: $expected',
    async ({ bound, expected, overflowed, timedOut }) => {
      const capture: DockerLogArchiveRuntime['capture'] = async ({ output }) => {
        await output.write('partial')
        return { exitCode: -1, overflowed, stderrExcerpt: '', terminationBoundExceeded: bound, timedOut }
      }
      const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime(capture))

      expect(result).toMatchObject({ ok: false, kind: 'failed' })
      if (!result.ok) expect(result.reason).toContain(expected)
      expect(await readdir(join(agentDir, '.typeclaw', 'logs'))).toEqual([])
    },
  )

  test('cleans the unpublished temp when atomic publication fails', async () => {
    const logsDir = join(agentDir, '.typeclaw', 'logs')
    const finalPath = join(logsDir, archiveFilename(NOW))
    const capture: DockerLogArchiveRuntime['capture'] = async ({ output }) => {
      await output.write(LOG_TEXT)
      await mkdir(finalPath)
      return { exitCode: 0, overflowed: false, stderrExcerpt: '', timedOut: false }
    }

    expect((await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime(capture))).ok).toBe(false)
    expect((await readdir(logsDir)).filter((name) => name.endsWith('.partial'))).toEqual([])
    expect((await lstat(finalPath)).isDirectory()).toBe(true)
  })

  test('preserves prior archives when an enlarged capture cannot be published', async () => {
    const logsDir = join(agentDir, '.typeclaw', 'logs')
    await mkdir(logsDir, { recursive: true })
    const priorPath = join(logsDir, archiveFilename(new Date(NOW.getTime() - 1_000), SECOND_NONCE, 'b'.repeat(64)))
    await writeFile(priorPath, 'prior archive')
    await truncate(priorPath, 200 * 1024 * 1024)
    const archiveRuntime = runtime(async ({ output }) => {
      await output.truncate(400 * 1024 * 1024)
      await mkdir(join(logsDir, archiveFilename(NOW)))
      return { exitCode: 0, overflowed: false, stderrExcerpt: '', timedOut: false }
    })
    archiveRuntime.inspectLogConfig = async () => ({
      exitCode: 0,
      stdout: '{"Type":"json-file","Config":{"max-size":"100m","max-file":"5"}}',
      stderr: '',
    })

    const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, archiveRuntime)
    expect(result.ok).toBe(false)
    expect((await stat(priorPath)).size).toBe(200 * 1024 * 1024)
    expect(await readdir(logsDir)).not.toContain(`.${archiveFilename(NOW).replace(/\.log$/, '.partial')}`)
  })

  test.each([
    { label: 'decimal suffix', size: '20m', files: '5', expected: 100_000_000 },
    { label: 'leading-zero file count', size: '20m', files: '05', expected: 100_000_000 },
    { label: 'fractional size', size: '20.0m', files: '5', expected: 100_000_000 },
    { label: 'MiB spelling', size: '20MiB', files: '5', expected: 100_000_000 },
    { label: 'binary-looking mixed case', size: '100MiB', files: undefined, expected: 100_000_000 },
    { label: 'fractional bytes', size: '99.5 MB', files: undefined, expected: 99_500_000 },
  ])('uses Docker go-units and implicit max-file=1 for $label', async ({ size, files, expected }) => {
    const archiveRuntime = runtime(async (input) => {
      expect(input.maxBytes).toBe(expected)
      if (files) return { exitCode: 0, overflowed: false, stderrExcerpt: '', timedOut: false }
      return await streamProcessOutput({
        ...input,
        binary: process.execPath,
        args: ['-e', "const chunk = 'x'.repeat(1024 * 1024); for (let i = 0; i < 68; i++) process.stdout.write(chunk)"],
      })
    })
    archiveRuntime.inspectLogConfig = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        Type: 'json-file',
        Config: { 'max-size': size, ...(files ? { 'max-file': files } : {}) },
      }),
      stderr: '',
    })
    const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, archiveRuntime)
    expect(result.ok).toBe(true)
    if (result.ok && !files) expect((await stat(result.path)).size).toBe(68 * 1024 * 1024)
  })

  test.each([
    { size: '0', files: '5' },
    { size: '-20m', files: '5' },
    { size: '20m', files: '1.5' },
    { size: '20m', files: '0' },
    { size: 20, files: '5' },
    { size: '9007199254740993m', files: '5' },
  ])('does not raise the limit for invalid Docker rotation options: %j', async ({ size, files }) => {
    const archiveRuntime = runtime(async ({ maxBytes }) => {
      expect(maxBytes).toBe(MAX_DOCKER_LOG_ARCHIVE_BYTES)
      return { exitCode: 0, overflowed: false, stderrExcerpt: '', timedOut: false }
    })
    archiveRuntime.inspectLogConfig = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ Type: 'json-file', Config: { 'max-size': size, 'max-file': files } }),
      stderr: '',
    })
    expect((await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, archiveRuntime)).ok).toBe(true)
  })

  test.each([
    { label: 'configured', retentionDays: 2 },
    { label: 'default', retentionDays: undefined },
  ])('prunes only recognized archives strictly older than the $label age cutoff', async ({ retentionDays }) => {
    const days = retentionDays ?? DEFAULT_LOG_RETENTION_DAYS
    const logsDir = join(agentDir, '.typeclaw', 'logs')
    const cutoff = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000)
    const oldName = archiveFilename(new Date(cutoff.getTime() - 1), '3'.repeat(32), 'b'.repeat(64))
    const boundaryName = archiveFilename(cutoff, '4'.repeat(32), 'b'.repeat(64))
    const unrelated = ['notes.log', `${oldName}.bak`, '.partial', 'keep.txt']
    await mkdir(logsDir, { recursive: true })
    await Promise.all([oldName, boundaryName, ...unrelated].map((name) => writeFile(join(logsDir, name), name)))

    const result = await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID, retentionDays }, runtime())

    expect(result.ok).toBe(true)
    expect(await readdir(logsDir)).toEqual(expect.arrayContaining([boundaryName, ...unrelated]))
    expect(await readdir(logsDir)).not.toContain(oldName)
  })

  test('removes only clearly stale recognized partials', async () => {
    const logsDir = join(agentDir, '.typeclaw', 'logs')
    const oldPartial = `.${CONTAINER_ID}-2025-01-01T00-00-00-000Z-${'3'.repeat(32)}.partial`
    const freshPartial = `.${CONTAINER_ID}-2026-01-15T12-30-45-000Z-${'4'.repeat(32)}.partial`
    await mkdir(logsDir, { recursive: true })
    await writeFile(join(logsDir, oldPartial), 'old')
    await writeFile(join(logsDir, freshPartial), 'active')
    await utimes(join(logsDir, oldPartial), new Date('2026-01-15T12:00:00Z'), new Date('2026-01-15T12:00:00Z'))
    await utimes(join(logsDir, freshPartial), NOW, NOW)

    expect((await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime())).ok).toBe(true)
    expect(await readdir(logsDir)).not.toContain(oldPartial)
    expect(await readdir(logsDir)).toContain(freshPartial)
  })

  test('prunes oldest recognized snapshots to the 512-snapshot capacity', async () => {
    const logsDir = join(agentDir, '.typeclaw', 'logs')
    await mkdir(logsDir, { recursive: true })
    const names = Array.from({ length: MAX_DOCKER_LOG_ARCHIVE_SNAPSHOTS }, (_, index) =>
      archiveFilename(new Date(NOW.getTime() - 60_000 + index), index.toString(16).padStart(32, '0')),
    )
    await Promise.all(names.map((name) => writeFile(join(logsDir, name), 'x')))

    expect((await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime())).ok).toBe(true)
    const snapshots = (await readdir(logsDir)).filter((name) => name.endsWith('.log'))
    expect(snapshots).toHaveLength(MAX_DOCKER_LOG_ARCHIVE_SNAPSHOTS)
    expect(snapshots).not.toContain(names[0])
  })

  test('prunes oldest snapshots until total capacity includes the incoming archive', async () => {
    const logsDir = join(agentDir, '.typeclaw', 'logs')
    const older = archiveFilename(new Date(NOW.getTime() - 2_000), '3'.repeat(32))
    const newer = archiveFilename(new Date(NOW.getTime() - 1_000), '4'.repeat(32))
    await mkdir(logsDir, { recursive: true })
    await writeFile(join(logsDir, older), '')
    await writeFile(join(logsDir, newer), '')
    await truncate(join(logsDir, older), 300 * 1024 * 1024)
    await truncate(join(logsDir, newer), 300 * 1024 * 1024)

    expect((await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime())).ok).toBe(true)
    expect(await readdir(logsDir)).not.toContain(older)
    expect(await readdir(logsDir)).toContain(newer)
  })

  test('allows concurrent calls to publish distinct snapshots without a global lock', async () => {
    let releaseCapture: (() => void) | undefined
    let captures = 0
    const barrier = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    const capture: DockerLogArchiveRuntime['capture'] = async ({ output }) => {
      captures += 1
      if (captures === 2) releaseCapture?.()
      await barrier
      await output.write('snapshot\n')
      return { exitCode: 0, overflowed: false, stderrExcerpt: '', timedOut: false }
    }
    const archiveRuntime = runtime(capture, [FIRST_NONCE, SECOND_NONCE])

    const results = await Promise.all([
      archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, archiveRuntime),
      archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, archiveRuntime),
    ])

    expect(results.every((result) => result.ok)).toBe(true)
    const archives = (await readdir(join(agentDir, '.typeclaw', 'logs'))).filter((name) => name.endsWith('.log'))
    expect(archives.sort()).toEqual([archiveFilename(NOW, FIRST_NONCE), archiveFilename(NOW, SECOND_NONCE)].sort())
  })

  test('rejects a symlinked archive directory without writing through it', async () => {
    const target = join(agentDir, 'target')
    const typeclawDir = join(agentDir, '.typeclaw')
    await mkdir(target)
    await mkdir(typeclawDir)
    await symlink(target, join(typeclawDir, 'logs'))

    expect((await archiveContainerLogs({ agentDir, containerId: CONTAINER_ID }, runtime())).ok).toBe(false)
    expect(await readdir(target)).toEqual([])
  })
})

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() })
}

function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream()
}
