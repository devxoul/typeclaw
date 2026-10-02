import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// Stable TypeScript 7.0 ships no programmatic API (returns in 7.1); this meta-test
// walks its own source AST, so it pulls the classic compiler API from the TS6 compat
// package while `tsc` typechecking stays on typescript@7.
import * as ts from '@typescript/typescript6'

import { DEFAULT_GITHUB_EVENT_ALLOWLIST } from '@/channels/schema'
import { startDaemon, type Daemon } from '@/hostd/daemon'
import { buildDockerfile, BUN_BASE_IMAGE } from '@/init/dockerfile'
import { buildGitignore } from '@/init/gitignore'
import { isWindows } from '@/shared'

import type { WithAgentOperationLock } from './agent-operation-lock'
import { acquireManagedBuildCache } from './build-cache'
import type { DockerExec } from './shared'
import {
  commitSystemFile,
  isPathInsideOrEqual,
  planStart,
  refreshDockerfile,
  refreshGitignore,
  shouldMirrorDevSource,
  shouldMountWindowsDevSource,
  start,
  type HostDaemonRegisterPayload,
} from './start'
import { stop } from './stop'

type ParsedBindMount = { src: string; dst: string; readonly: boolean }

// Parses `--mount type=bind,src=...,dst=...[,readonly]` argv pairs out of a
// runArgs list so assertions can check bind mounts without hard-coding the
// CSV field order or the `-v` legacy form.
function bindMounts(runArgs: readonly string[]): ParsedBindMount[] {
  const out: ParsedBindMount[] = []
  for (let i = 0; i < runArgs.length - 1; i++) {
    if (runArgs[i] !== '--mount') continue
    const fields = (runArgs[i + 1] ?? '').split(',')
    if (!fields.includes('type=bind')) continue
    const src = fields.find((f) => f.startsWith('src='))?.slice(4) ?? ''
    const dst = fields.find((f) => f.startsWith('dst='))?.slice(4) ?? ''
    out.push({ src, dst, readonly: fields.includes('readonly') })
  }
  return out
}

function hasBindMount(runArgs: readonly string[], expected: ParsedBindMount): boolean {
  return bindMounts(runArgs).some(
    (m) => m.src === expected.src && m.dst === expected.dst && m.readonly === expected.readonly,
  )
}

let root: string

// Pin the host locale to non-CJK so refreshDockerfile()/start() (which call
// hostLocaleIsCjk() for cjkFonts: 'auto') produce output that matches the
// bare buildDockerfile() these tests compare against, regardless of the test
// machine's actual locale (a CJK CI runner would otherwise diverge).
const SAVED_LOCALE_ENV: Record<string, string | undefined> = {}
const LOCALE_ENV_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const

beforeEach(async () => {
  for (const key of LOCALE_ENV_VARS) {
    SAVED_LOCALE_ENV[key] = process.env[key]
    delete process.env[key]
  }
  process.env.LANG = 'C'
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-start-'))
})

afterEach(async () => {
  for (const key of LOCALE_ENV_VARS) {
    if (SAVED_LOCALE_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED_LOCALE_ENV[key]
  }
  await rm(root, { recursive: true, force: true })
})

// Mirror the post-init agent-folder shape: package.json declares the
// `packages/*` bun workspace and `packages/.gitkeep` exists so refreshPackageJson
// is a no-op. Tests that want to exercise the migration path should call
// `writePackageJsonPreMigration` instead.
async function writePackageJson(dir: string, deps: Record<string, string>): Promise<void> {
  const dependencies = {
    'typeclaw-gws-multi-account': '^0.3.4',
    ...deps,
  }
  const pkg = {
    name: basename(dir),
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
    dependencies,
    typeclaw: { managedPlugins: { 'typeclaw-gws-multi-account': '^0.3.4' } },
  }
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  await mkdir(join(dir, 'packages'), { recursive: true })
  await writeFile(join(dir, 'packages', '.gitkeep'), '')
}

async function writePackageJsonPreMigration(dir: string, deps: Record<string, string>): Promise<void> {
  const pkg = {
    name: basename(dir),
    private: true,
    type: 'module',
    dependencies: {
      'typeclaw-gws-multi-account': '^0.3.4',
      ...deps,
    },
    typeclaw: { managedPlugins: { 'typeclaw-gws-multi-account': '^0.3.4' } },
  }
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

async function writeDockerfile(dir: string): Promise<void> {
  await writeFile(join(dir, 'Dockerfile'), 'FROM oven/bun:1-slim\n')
}

type DockerfileBlock = {
  append?: string[]
  ffmpeg?: boolean | string
  gh?: boolean | string
  python?: boolean
  tmux?: boolean | string
}

type GitignoreBlock = { append?: string[] }

type ScaffoldedConfig = {
  mounts?: Array<{ name: string; path: string; readOnly?: boolean; description?: string }>
  docker?: { file?: DockerfileBlock }
  git?: { ignore?: GitignoreBlock }
  network?: { blockInternal?: boolean; autoAllowResolvers?: boolean; allow?: string[] }
  sandbox?: {
    apparmorProfile?: string
    realProc?: boolean
    writablePaths?: string[]
    symlinks?: Array<{ from: string; to: string }>
  }
  logs?: { retentionDays?: number }
  memory?: Record<string, unknown>
}

async function writeTypeclawConfig(dir: string, overrides: ScaffoldedConfig = {}): Promise<void> {
  const config = {
    $schema: './node_modules/typeclaw/typeclaw.schema.json',
    models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
    mounts: overrides.mounts ?? [],
    ...(overrides.docker ? { docker: overrides.docker } : {}),
    ...(overrides.git ? { git: overrides.git } : {}),
    ...(overrides.network ? { network: overrides.network } : {}),
    ...(overrides.sandbox ? { sandbox: overrides.sandbox } : {}),
    ...(overrides.logs ? { logs: overrides.logs } : {}),
    ...(overrides.memory ? { memory: overrides.memory } : {}),
  }
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
}

// Returns the preferred port unchanged. Lets `start` tests verify their own
// behavior without going through the real kernel via `findFreePort`.
const deterministicAllocator = async (preferred: number): Promise<number> => (preferred > 0 ? preferred : 8973)

// Bypasses the real `ensureDepsInstalled` for tests that don't care about
// dep installation. The default `ensureDeps` in `start()` would spawn
// `bun install` against the tmpdir, which is irrelevant to most of these
// tests and would slow each one by ~hundreds of ms.
const noEnsureDeps = async (): Promise<{ ok: true; installed: false }> => ({ ok: true, installed: false })
const noEnsureModels = async (): Promise<void> => {}
const noArchiveLogs = async () => ({ ok: true as const, status: 'archived' as const, path: '/archive.log' })
const noGithubCliProvision = () => ({ ok: true as const })

// The real autoUpgrade detector sees the test runner itself as a LOCAL typeclaw
// checkout and would relink each agent's package.json — disruptive to tests that
// aren't about auto-reconcile. Inject this no-op so they stay deterministic
// regardless of how the suite was launched; reconcile tests inject their own.
const noAutoUpgrade = async () => ({ kind: 'up-to-date', installedVersion: '0.1.0' }) as const

// Bypasses the post-`docker run` verification window so happy-path tests don't
// pay the production 1.5s wait. Verification has its own dedicated test file
// (verify-running.test.ts); start.test.ts only proves start() routes a
// failing verifier into the documented failure response.
const bypassVerify = {
  verifyRunning: async () => ({ ok: true as const }),
  ensureModels: noEnsureModels,
  archiveLogs: noArchiveLogs,
  provisionGithubCliStore: noGithubCliProvision,
  acquireBuildCache: null,
}

function labelValue(runArgs: string[], key: string): string | undefined {
  for (let i = 0; i < runArgs.length - 1; i++) {
    if (runArgs[i] === '--label' && runArgs[i + 1]?.startsWith(`${key}=`)) {
      return runArgs[i + 1]!.slice(key.length + 1)
    }
  }
  return undefined
}

// Anti-flake guard. start()'s default `ensureModels` (src/hostd/models.ts) takes
// a 30s stale file-lock and downloads a ~279MB model; CI's "flake guard" lane
// runs two `bun test --parallel` suites on one runner, so two processes contend
// on that shared lock and the loser is killed at exactly 30000ms. It only
// reproduces under that oversubscription, so a forgotten stub fails randomly on
// an unrelated PR. Every start() call here MUST neutralize the model seam with a
// `...bypassVerify` spread (carries noEnsureModels) or an explicit `ensureModels`
// property. Matched over the parsed AST, not by substring, so a
// `bypassVerify.verifyRunning` access or those names inside a comment cannot pass.
describe('start() model-provisioning anti-flake guard', () => {
  test('every start() call in this file stubs the model seam', async () => {
    const file = join(import.meta.dir, 'start.test.ts')
    const tree = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)

    const stubsModelSeam = (options: ts.ObjectLiteralExpression): boolean =>
      options.properties.some((prop) => {
        if (ts.isSpreadAssignment(prop)) {
          return ts.isIdentifier(prop.expression) && prop.expression.text === 'bypassVerify'
        }
        const { name } = prop
        return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'ensureModels'
      })

    const offendingLines: number[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'start') {
        const [options] = node.arguments
        const safe = options !== undefined && ts.isObjectLiteralExpression(options) && stubsModelSeam(options)
        if (!safe) offendingLines.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)

    expect(offendingLines).toEqual([])
  })
})

describe('planStart', () => {
  test('resolves repository-local Git identity through the production host-to-container path', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'GIT_AUTHOR_NAME=stale\n')
    await gitInit(root)
    await runGit(root, ['config', '--local', 'user.name', 'Resolved Agent'])
    await runGit(root, ['config', '--local', 'user.email', 'resolved@example.com'])

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const envFileIndex = plan.runArgs.indexOf('--env-file')
    for (const value of [
      'GIT_AUTHOR_NAME=Resolved Agent',
      'GIT_AUTHOR_EMAIL=resolved@example.com',
      'GIT_COMMITTER_NAME=Resolved Agent',
      'GIT_COMMITTER_EMAIL=resolved@example.com',
    ]) {
      expect(plan.runArgs.indexOf(value)).toBeGreaterThan(envFileIndex)
    }
  })

  test('injects repository-local Git identity after the operator env file', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'GIT_AUTHOR_NAME=stale\n')

    const plan = await planStart({
      cwd: root,
      hostPort: 8973,
      imageExists: true,
      gitIdentity: { name: 'Agent Smith', email: 'agent@example.com' },
    })

    const envFileIndex = plan.runArgs.indexOf('--env-file')
    const expected = [
      'GIT_AUTHOR_NAME=Agent Smith',
      'GIT_AUTHOR_EMAIL=agent@example.com',
      'GIT_COMMITTER_NAME=Agent Smith',
      'GIT_COMMITTER_EMAIL=agent@example.com',
    ]
    for (const value of expected) {
      const index = plan.runArgs.indexOf(value)
      expect(plan.runArgs[index - 1]).toBe('-e')
      expect(index).toBeGreaterThan(envFileIndex)
      expect(index).toBeLessThan(plan.runArgs.indexOf(plan.imageTag))
    }
  })

  test('omits Git identity variables when the agent repository has no complete identity', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true, gitIdentity: null })

    expect(plan.runArgs.filter((arg) => /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=/.test(arg))).toEqual([])
  })

  test('publishes the TUI websocket port on host loopback by default', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'FIREWORKS_API_KEY=fw_test\n')

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs[0]).toBe('run')
    expect(plan.runArgs).toContain('-d')
    expect(plan.runArgs).not.toContain('--rm')
    expect(plan.runArgs).toContain('--name')
    expect(plan.runArgs).toContain(plan.containerName)
    expect(plan.runArgs).toContain('--shm-size=2g')
    expect(plan.runArgs).toContain('-p')
    expect(plan.runArgs).toContain('127.0.0.1:8973:8973')
    expect(plan.runArgs).toContain('--env-file')
    expect(plan.runArgs).toContain(join(root, '.env'))
    expect(hasBindMount(plan.runArgs, { src: root, dst: '/agent', readonly: false })).toBe(true)
    expect(plan.runArgs.at(-1)).toBe(plan.imageTag)
  })

  test('overrides stale image defaults with the canonical agent-messenger config dir after --env-file', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'FIREWORKS_API_KEY=fw_test\n')

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const envFileIndex = plan.runArgs.indexOf('--env-file')
    const configIndex = plan.runArgs.indexOf('AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.config/agent-messenger')

    expect(configIndex).toBeGreaterThan(envFileIndex)
    expect(plan.runArgs[configIndex - 1]).toBe('-e')
  })

  test('preserves an operator AGENT_MESSENGER_CONFIG_DIR override from .env', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'AGENT_MESSENGER_CONFIG_DIR=/operator/config\n')

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--env-file')
    expect(plan.runArgs.some((arg) => arg.startsWith('AGENT_MESSENGER_CONFIG_DIR='))).toBe(false)
  })

  test('sets --shm-size=2g unconditionally so the bundled Chrome survives heavy pages (Docker default /dev/shm is 64MB and crashes Chrome)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--shm-size=2g')
  })

  test('caps container memory with swap disabled so exhaustion kills one agent instead of livelocking the host', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const memory = plan.runArgs.find((arg) => arg.startsWith('--memory='))
    const memorySwap = plan.runArgs.find((arg) => arg.startsWith('--memory-swap='))
    expect(memory).toBeDefined()
    // Equal values are what disables swap. Swap is what turns an OOM into an
    // unrecoverable reclaim livelock, so the pair must never drift apart.
    expect(memorySwap).toBe(`--memory-swap=${memory?.slice('--memory='.length)}`)
    expect(plan.memoryLimitBytes).toBeGreaterThan(0)
  })

  test('passes the host UID and GID to the container on POSIX so runtime writes keep host ownership', async () => {
    // given
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    // when
    const plan = await planStart({
      cwd: root,
      hostPort: 8973,
      imageExists: true,
      platform: 'linux',
      hostIdentity: { uid: 1001, gid: 1002 },
    })

    // then
    expect(plan.runArgs).toContain('TYPECLAW_HOST_UID=1001')
    expect(plan.runArgs).toContain('TYPECLAW_HOST_GID=1002')
  })

  test('omits host UID and GID on native Windows where POSIX ownership does not apply', async () => {
    // given
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    // when
    const plan = await planStart({
      cwd: root,
      hostPort: 8973,
      imageExists: true,
      platform: 'win32',
      hostIdentity: { uid: 1001, gid: 1002 },
    })

    // then
    expect(plan.runArgs.some((arg) => arg.startsWith('TYPECLAW_HOST_UID='))).toBe(false)
    expect(plan.runArgs.some((arg) => arg.startsWith('TYPECLAW_HOST_GID='))).toBe(false)
  })

  test('sets --security-opt seccomp=unconfined unconditionally so bwrap can create user namespaces for per-tool sandboxing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const idx = plan.runArgs.indexOf('--security-opt')
    expect(idx).toBeGreaterThan(-1)
    expect(plan.runArgs[idx + 1]).toBe('seccomp=unconfined')
    expect(idx).toBeLessThan(plan.runArgs.indexOf(plan.imageTag))
  })

  test('sets --security-opt apparmor=unconfined by default before the image tag', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const idx = plan.runArgs.indexOf('apparmor=unconfined')

    expect(idx).toBeGreaterThan(-1)
    expect(plan.runArgs[idx - 1]).toBe('--security-opt')
    expect(idx).toBeLessThan(plan.runArgs.indexOf(plan.imageTag))
    expect(plan.runArgs).not.toContain('--privileged')
    expect(plan.runArgs).not.toContain('--cap-add=SYS_ADMIN')
  })

  test('honors sandbox.apparmorProfile verbatim before the image tag', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { sandbox: { apparmorProfile: 'typeclaw-bwrap' } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const idx = plan.runArgs.indexOf('apparmor=typeclaw-bwrap')

    expect(idx).toBeGreaterThan(-1)
    expect(plan.runArgs[idx - 1]).toBe('--security-opt')
    expect(idx).toBeLessThan(plan.runArgs.indexOf(plan.imageTag))
  })

  test('sets --init unconditionally so tini reaps orphaned bwrap sandboxes instead of leaking their user namespaces', async () => {
    // given
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    // when
    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    // then
    const idx = plan.runArgs.indexOf('--init')
    expect(idx).toBeGreaterThan(-1)
    expect(idx).toBeLessThan(plan.runArgs.indexOf(plan.imageTag))
  })

  test('can publish the TUI websocket port on all host interfaces', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true, publishHost: '0.0.0.0' })

    expect(plan.runArgs).toContain('0.0.0.0:8973:8973')
  })

  test('injects a TUI websocket token when one is supplied', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true, tuiToken: 'token-123' })

    expect(plan.runArgs).toContain('dev.typeclaw.tui-token=token-123')
    expect(plan.runArgs).toContain('TYPECLAW_TUI_TOKEN=token-123')
  })

  test('adds hostd HTTP control env when restart transport is available', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({
      cwd: root,
      hostPort: 8973,
      imageExists: true,
      hostdControl: { url: 'http://host.docker.internal:49123', token: 'secret', brokerToken: 'broker-secret' },
    })

    expect(plan.runArgs).toContain('-e')
    expect(plan.runArgs).toContain(`TYPECLAW_CONTAINER_NAME=${basename(root)}`)
    expect(plan.runArgs).toContain('TYPECLAW_HOSTD_URL=http://host.docker.internal:49123')
    expect(plan.runArgs).toContain('TYPECLAW_HOSTD_TOKEN=secret')
    expect(plan.runArgs).toContain('--add-host')
    expect(plan.runArgs).toContain('host.docker.internal:host-gateway')
    expect(plan.runArgs.some((arg) => arg.includes('/run/typeclaw-host'))).toBe(false)
  })

  test('groups all agents under a single "typeclaw" compose project', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.project')).toBe('typeclaw')
  })

  test('uses the folder basename as the compose service name', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.service')).toBe(basename(root))
  })

  test('sets compose labels required for docker compose ls and Docker Desktop grouping', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.project.working_dir')).toBe(root)
    expect(labelValue(plan.runArgs, 'com.docker.compose.oneoff')).toBe('False')
    expect(labelValue(plan.runArgs, 'com.docker.compose.config-hash')).toBe('manual')
    expect(labelValue(plan.runArgs, 'com.docker.compose.container-number')).toBe('1')
  })

  test('omits --env-file when .env is missing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).not.toContain('--env-file')
  })

  test('propagates host TZ via -e so cron schedules fire at the wall-clock the user expects', async () => {
    const original = process.env.TZ
    process.env.TZ = 'Asia/Seoul'
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const tzIdx = plan.runArgs.findIndex((a, i) => a === '-e' && plan.runArgs[i + 1] === 'TZ=Asia/Seoul')
      expect(tzIdx).toBeGreaterThanOrEqual(0)
    } finally {
      if (original === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = original
      }
    }
  })

  test('falls back to Intl-detected timezone when TZ env var is unset (typical macOS host)', async () => {
    const original = process.env.TZ
    delete process.env.TZ
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const eIdx = plan.runArgs.findIndex((a, i) => a === '-e' && plan.runArgs[i + 1]?.startsWith('TZ='))
      expect(eIdx).toBeGreaterThanOrEqual(0)
      const detected = plan.runArgs[eIdx + 1]?.slice('TZ='.length)
      expect(detected).toBeTruthy()
    } finally {
      if (original !== undefined) process.env.TZ = original
    }
  })

  test.skipIf(isWindows())(
    'adds a mirror mount for the typeclaw source when dependency is a file: spec outside cwd',
    async () => {
      const typeclawRepo = await mkdtemp(join(tmpdir(), 'typeclaw-repo-'))
      try {
        await writeDockerfile(root)
        await writePackageJson(root, { typeclaw: `file:${typeclawRepo}` })

        const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

        expect(hasBindMount(plan.runArgs, { src: typeclawRepo, dst: typeclawRepo, readonly: true })).toBe(true)
      } finally {
        await rm(typeclawRepo, { recursive: true, force: true })
      }
    },
  )

  test('skips mirror mount when typeclaw file: spec points inside the agent folder', async () => {
    await writeDockerfile(root)
    await mkdir(join(root, 'vendor', 'typeclaw'), { recursive: true })
    await writePackageJson(root, { typeclaw: 'file:./vendor/typeclaw' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const mirrorMounts = bindMounts(plan.runArgs).filter((m) => m.readonly && m.dst !== '/opt/models')
    expect(mirrorMounts).toHaveLength(0)
  })

  test('skips mirror mount when typeclaw dependency is a version range', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(bindMounts(plan.runArgs).filter((m) => m.readonly && m.dst !== '/opt/models')).toHaveLength(0)
  })

  test('every emitted bind mount targets an absolute Linux container path (never a host dst)', async () => {
    const typeclawRepo = await mkdtemp(join(tmpdir(), 'typeclaw-repo-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: `file:${typeclawRepo}` })
      await writeTypeclawConfig(root, {
        mounts: [{ name: 'projects', path: projectDir }],
      })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      for (const m of bindMounts(plan.runArgs)) {
        expect(m.dst.startsWith('/')).toBe(true)
        expect(m.dst).not.toMatch(/^[A-Za-z]:[\\/]/)
        expect(m.dst).not.toContain('\\')
      }
    } finally {
      await rm(typeclawRepo, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('reports needsBuild based on imageExists input', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const missing = await planStart({ cwd: root, hostPort: 8973, imageExists: false })
    const present = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(missing.needsBuild).toBe(true)
    expect(present.needsBuild).toBe(false)
  })

  test('forceBuild forces a rebuild even when the image already exists', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const forced = await planStart({ cwd: root, hostPort: 8973, imageExists: true, forceBuild: true })
    const notForced = await planStart({ cwd: root, hostPort: 8973, imageExists: true, forceBuild: false })

    expect(forced.needsBuild).toBe(true)
    expect(notForced.needsBuild).toBe(false)
  })

  test('container name and image tag derive from the folder basename', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.containerName).toBe(basename(root))
    expect(plan.imageTag).toBe(`typeclaw-${basename(root)}`)
  })
})

describe('shouldMirrorDevSource', () => {
  test('mirrors an out-of-cwd dev source on POSIX hosts', () => {
    expect(shouldMirrorDevSource('/srv/src/typeclaw', '/srv/agents/coder', 'linux')).toBe(true)
    expect(shouldMirrorDevSource('/srv/src/typeclaw', '/srv/agents/coder', 'darwin')).toBe(true)
  })

  test('does NOT mirror on native Windows (a C:\\ host path is not a valid Linux container dst)', () => {
    expect(shouldMirrorDevSource('C:\\src\\typeclaw', 'C:\\agents\\coder', 'win32')).toBe(false)
  })

  test('does NOT mirror when there is no dev source', () => {
    expect(shouldMirrorDevSource(null, '/srv/agents/coder', 'linux')).toBe(false)
  })

  test('does NOT mirror when the dev source lives inside the agent folder', () => {
    expect(shouldMirrorDevSource('/srv/agents/coder/vendor/typeclaw', '/srv/agents/coder', 'linux')).toBe(false)
  })
})

describe('shouldMountWindowsDevSource', () => {
  test('mounts an out-of-cwd checkout (e.g. a bun-linked link: source) over the in-container node_modules path on Windows', () => {
    expect(shouldMountWindowsDevSource('/src/typeclaw', '/agents/coder', 'win32')).toBe(true)
  })

  test('does NOT mount on POSIX (the same-path mirror branch handles those)', () => {
    expect(shouldMountWindowsDevSource('/srv/src/typeclaw', '/srv/agents/coder', 'linux')).toBe(false)
    expect(shouldMountWindowsDevSource('/srv/src/typeclaw', '/srv/agents/coder', 'darwin')).toBe(false)
  })

  test('does NOT mount when there is no dev source', () => {
    expect(shouldMountWindowsDevSource(null, '/agents/coder', 'win32')).toBe(false)
  })

  test('does NOT mount when the dev source lives inside the agent folder (already exposed via /agent)', () => {
    expect(shouldMountWindowsDevSource('/agents/coder/vendor/typeclaw', '/agents/coder', 'win32')).toBe(false)
  })
})

describe('isPathInsideOrEqual', () => {
  test('treats the parent itself and descendants as inside', () => {
    expect(isPathInsideOrEqual('/srv/agent', '/srv/agent')).toBe(true)
    expect(isPathInsideOrEqual('/srv/agent/vendor/typeclaw', '/srv/agent')).toBe(true)
  })

  test('treats siblings and prefix-collision neighbors as outside', () => {
    expect(isPathInsideOrEqual('/srv/src/typeclaw', '/srv/agent')).toBe(false)
    expect(isPathInsideOrEqual('/srv/agentX', '/srv/agent')).toBe(false)
  })
})

describe('planStart mounts', () => {
  test('emits no mount flags when typeclaw.json is missing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(bindMounts(plan.runArgs).filter((m) => m.dst.startsWith('/agent/mounts/'))).toHaveLength(0)
  })

  test('mounts a Windows dev-mode checkout over /agent/node_modules/typeclaw', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'typeclaw-dev-src-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: `file:${checkout}` })
      await writeTypeclawConfig(root)

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true, platform: 'win32' })

      expect(hasBindMount(plan.runArgs, { src: checkout, dst: '/agent/node_modules/typeclaw', readonly: true })).toBe(
        true,
      )
    } finally {
      await rm(checkout, { recursive: true, force: true })
    }
  })

  test('does NOT add the node_modules/typeclaw mount on POSIX (same-path mirror handles dev source)', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'typeclaw-dev-src-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: `file:${checkout}` })
      await writeTypeclawConfig(root)

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true, platform: 'linux' })

      expect(bindMounts(plan.runArgs).some((m) => m.dst === '/agent/node_modules/typeclaw')).toBe(false)
    } finally {
      await rm(checkout, { recursive: true, force: true })
    }
  })

  test('resolves a Windows link:typeclaw dev source via the bun global link', async () => {
    const globalDir = await mkdtemp(join(tmpdir(), 'typeclaw-bun-global-'))
    const checkout = await mkdtemp(join(tmpdir(), 'typeclaw-dev-src-'))
    const savedGlobalDir = process.env.BUN_INSTALL_GLOBAL_DIR
    try {
      // given: `bun link` registered the checkout at <global>/node_modules/typeclaw
      await mkdir(join(globalDir, 'node_modules'), { recursive: true })
      await symlink(checkout, join(globalDir, 'node_modules', 'typeclaw'))
      process.env.BUN_INSTALL_GLOBAL_DIR = globalDir
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: 'link:typeclaw' })
      await writeTypeclawConfig(root)

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true, platform: 'win32' })

      expect(
        hasBindMount(plan.runArgs, {
          src: realpathSync(checkout),
          dst: '/agent/node_modules/typeclaw',
          readonly: true,
        }),
      ).toBe(true)
    } finally {
      if (savedGlobalDir === undefined) delete process.env.BUN_INSTALL_GLOBAL_DIR
      else process.env.BUN_INSTALL_GLOBAL_DIR = savedGlobalDir
      await rm(globalDir, { recursive: true, force: true })
      await rm(checkout, { recursive: true, force: true })
    }
  })

  test('emits no mount flags when mounts array is empty', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [] })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(bindMounts(plan.runArgs).filter((m) => m.dst.startsWith('/agent/mounts/'))).toHaveLength(0)
  })

  test('emits a bind mount for each mount, mapping to /agent/mounts/<name>', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'projects', path: projectDir }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs).toContain('--mount')
      expect(hasBindMount(plan.runArgs, { src: projectDir, dst: '/agent/mounts/projects', readonly: false })).toBe(true)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('marks the mount readonly when readOnly is true', async () => {
    const notesDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'notes', path: notesDir, readOnly: true }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(hasBindMount(plan.runArgs, { src: notesDir, dst: '/agent/mounts/notes', readonly: true })).toBe(true)
    } finally {
      await rm(notesDir, { recursive: true, force: true })
    }
  })

  test('expands ~ to the home directory', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [{ name: 'home-thing', path: '~/some-dir' }] })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(
      hasBindMount(plan.runArgs, {
        src: join(homedir(), 'some-dir'),
        dst: '/agent/mounts/home-thing',
        readonly: false,
      }),
    ).toBe(true)
  })

  test('emits mounts in declared order', async () => {
    const a = await mkdtemp(join(tmpdir(), 'typeclaw-mount-a-'))
    const b = await mkdtemp(join(tmpdir(), 'typeclaw-mount-b-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, {
        mounts: [
          { name: 'first', path: a },
          { name: 'second', path: b },
        ],
      })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const userMounts = bindMounts(plan.runArgs).filter((m) => m.dst.startsWith('/agent/mounts/'))
      expect(userMounts).toEqual([
        { src: a, dst: '/agent/mounts/first', readonly: false },
        { src: b, dst: '/agent/mounts/second', readonly: false },
      ])
    } finally {
      await rm(a, { recursive: true, force: true })
      await rm(b, { recursive: true, force: true })
    }
  })

  test('mount flags appear before imageTag (last positional arg)', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'projects', path: projectDir }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs.at(-1)).toBe(plan.imageTag)
      const specIdx = plan.runArgs.findIndex((a) => a.includes('dst=/agent/mounts/projects'))
      expect(specIdx).toBeGreaterThan(-1)
      expect(specIdx).toBeLessThan(plan.runArgs.length - 1)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('throws when typeclaw.json is malformed JSON', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'typeclaw.json'), '{ not valid json')

    await expect(planStart({ cwd: root, hostPort: 8973, imageExists: true })).rejects.toThrow()
  })

  test('treats a typeclaw.json without a mounts field as no mounts', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(
      join(root, 'typeclaw.json'),
      `${JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } })}\n`,
    )

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(bindMounts(plan.runArgs).filter((m) => m.dst.startsWith('/agent/mounts/'))).toHaveLength(0)
  })

  test('throws when a mount name violates the pattern', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [{ name: 'BadName', path: '/x' }] })

    await expect(planStart({ cwd: root, hostPort: 8973, imageExists: true })).rejects.toThrow()
  })
})

describe('planStart model mount', () => {
  const modelsMount: ParsedBindMount = {
    src: join(homedir(), '.typeclaw', 'models'),
    dst: '/opt/models',
    readonly: true,
  }

  test('adds shared readonly model cache mount at /opt/models', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--mount')
    expect(hasBindMount(plan.runArgs, modelsMount)).toBe(true)
  })

  test('sets TYPECLAW_MODEL_CACHE env var to /opt/models', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('-e')
    expect(plan.runArgs).toContain('TYPECLAW_MODEL_CACHE=/opt/models')
  })

  test('model mount appears before imageTag (last positional arg)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.at(-1)).toBe(plan.imageTag)
    const specIdx = plan.runArgs.findIndex((a) => a.includes('dst=/opt/models'))
    expect(specIdx).toBeGreaterThan(-1)
    expect(specIdx).toBeLessThan(plan.runArgs.length - 1)
  })

  test('mounts model cache when memory config is absent', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(hasBindMount(plan.runArgs, modelsMount)).toBe(true)
    expect(plan.runArgs).toContain('TYPECLAW_MODEL_CACHE=/opt/models')
  })

  test('mounts model cache when typeclaw.json is missing entirely', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(hasBindMount(plan.runArgs, modelsMount)).toBe(true)
    expect(plan.runArgs).toContain('TYPECLAW_MODEL_CACHE=/opt/models')
  })
})

describe('planStart network egress filter', () => {
  test('grants NET_ADMIN and sets TYPECLAW_NETWORK_BLOCK_INTERNAL=1 when typeclaw.json is missing (new default = on)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--cap-add=NET_ADMIN')
    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_BLOCK_INTERNAL=1')
  })

  test('emits no NET_ADMIN cap and no env var when network.blockInternal is explicitly false (opt-out path for LAN access)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: false } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).not.toContain('--cap-add=NET_ADMIN')
    expect(plan.runArgs.filter((a) => a.includes('TYPECLAW_NETWORK_BLOCK_INTERNAL'))).toHaveLength(0)
  })

  test('grants NET_ADMIN and sets TYPECLAW_NETWORK_BLOCK_INTERNAL=1 when blockInternal is true', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--cap-add=NET_ADMIN')
    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_BLOCK_INTERNAL=1')
  })

  test('the env var lands as a docker `-e` flag (not `--env-file` or `--env`)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const envIdx = plan.runArgs.indexOf('TYPECLAW_NETWORK_BLOCK_INTERNAL=1')

    expect(envIdx).toBeGreaterThan(0)
    expect(plan.runArgs[envIdx - 1]).toBe('-e')
  })

  test('cap-add appears before the image tag so docker picks it up at run time, not at exec time', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const capIdx = plan.runArgs.indexOf('--cap-add=NET_ADMIN')
    const imageIdx = plan.runArgs.indexOf(plan.imageTag)

    expect(capIdx).toBeGreaterThan(-1)
    expect(imageIdx).toBeGreaterThan(-1)
    expect(capIdx).toBeLessThan(imageIdx)
  })

  test('sets TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1 by default (auto-carve resolv.conf nameservers, fixes EC2 VPC DNS)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1')
  })

  test('sets TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=0 when autoAllowResolvers is explicitly false (closed filter)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true, autoAllowResolvers: false } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=0')
    expect(plan.runArgs).not.toContain('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1')
  })

  test('omits TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS entirely when blockInternal is false (off-path skips all resolver logic)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: false } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.includes('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS'))).toHaveLength(0)
  })

  test('joins network.allow entries into a single comma-separated TYPECLAW_NETWORK_ALLOW env (matches shim IFS=, loop)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, {
      network: { blockInternal: true, allow: ['10.210.0.0/16', '10.211.1.42'] },
    })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_ALLOW=10.210.0.0/16,10.211.1.42')
  })

  test('omits TYPECLAW_NETWORK_ALLOW when network.allow is empty (no env clutter for the common case)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true, allow: [] } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.startsWith('TYPECLAW_NETWORK_ALLOW='))).toHaveLength(0)
  })

  test('omits TYPECLAW_NETWORK_ALLOW even when entries are set if blockInternal is false (off-path consistency)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: false, allow: ['10.0.0.0/8'] } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.startsWith('TYPECLAW_NETWORK_ALLOW='))).toHaveLength(0)
  })

  test('rejects invalid CIDRs in network.allow at config parse time (fail-fast on typos)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true, allow: ['not-a-cidr'] } })

    await expect(planStart({ cwd: root, hostPort: 8973, imageExists: true })).rejects.toThrow()
  })
})

describe('planStart sandbox.realProc cap grant', () => {
  test('does NOT grant SYS_ADMIN by default (proc-bind is the default; bunx/bun-add work without the broad cap)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).not.toContain('--cap-add=SYS_ADMIN')
  })

  test('does NOT grant SYS_ADMIN when sandbox.realProc is explicitly false', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { sandbox: { realProc: false } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).not.toContain('--cap-add=SYS_ADMIN')
  })

  test('grants SYS_ADMIN when sandbox.realProc is true (needed to mount proc for the new pid ns)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { sandbox: { realProc: true } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--cap-add=SYS_ADMIN')
  })

  test('the SYS_ADMIN cap appears before the image tag so docker applies it at run time', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { sandbox: { realProc: true } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const capIdx = plan.runArgs.indexOf('--cap-add=SYS_ADMIN')
    const imageIdx = plan.runArgs.indexOf(plan.imageTag)

    expect(capIdx).toBeGreaterThan(-1)
    expect(imageIdx).toBeGreaterThan(-1)
    expect(capIdx).toBeLessThan(imageIdx)
  })
})

describe('planStart sandbox.symlinks env', () => {
  test('omits TYPECLAW_SANDBOX_SYMLINKS when no symlinks are configured', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.startsWith('TYPECLAW_SANDBOX_SYMLINKS='))).toHaveLength(0)
  })

  test('emits base64-encoded JSON of the symlinks for the entrypoint shim', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const symlinks = [{ from: '~/.metabase-cli', to: 'workspace/.metabase-cli' }]
    await writeTypeclawConfig(root, { sandbox: { symlinks } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const envArg = plan.runArgs.find((a) => a.startsWith('TYPECLAW_SANDBOX_SYMLINKS='))
    expect(envArg).toBeDefined()
    const encoded = envArg!.slice('TYPECLAW_SANDBOX_SYMLINKS='.length)
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual(symlinks)
  })
})

describe('refreshDockerfile', () => {
  test('overwrites a stale Dockerfile with the current template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      const stale = 'FROM oven/bun:1-slim\n# stale, no git install\n'
      await writeFile(join(dir, 'Dockerfile'), stale)

      await refreshDockerfile(dir)

      const updated = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(updated).toBe(buildDockerfile())
      expect(updated).not.toBe(stale)
      expect(updated).toMatch(/apt-get[\s\S]+install[\s\S]+\bgit\b/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes the Dockerfile when none exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      await refreshDockerfile(dir)

      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toBe(buildDockerfile())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes custom append lines from typeclaw.json before the entrypoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      await writeTypeclawConfig(dir, { docker: { file: { append: ['RUN echo custom', 'ENV CUSTOM_FLAG=1'] } } })

      await refreshDockerfile(dir)

      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      const runIdx = written.indexOf('RUN echo custom')
      const envIdx = written.indexOf('ENV CUSTOM_FLAG=1')
      const entrypointIdx = written.indexOf('ENTRYPOINT ["/usr/local/bin/typeclaw-entrypoint"]')
      expect(runIdx).toBeGreaterThan(-1)
      expect(runIdx).toBeLessThan(envIdx)
      expect(envIdx).toBeLessThan(entrypointIdx)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes ffmpeg from typeclaw.json into the apt package list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      await writeTypeclawConfig(dir, { docker: { file: { ffmpeg: true } } })

      await refreshDockerfile(dir)

      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toMatch(/apt-get install -y --no-install-recommends[\s\S]+\bffmpeg\b/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("FROMs the GHCR base image at the agent's installed typeclaw version", async () => {
    // given: an agent with bun install completed — node_modules/typeclaw/package.json declares 0.1.0
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-installed-'))
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: { typeclaw: '^0.1.0' } }))
      await mkdir(join(dir, 'node_modules', 'typeclaw'), { recursive: true })
      await writeFile(
        join(dir, 'node_modules', 'typeclaw', 'package.json'),
        JSON.stringify({ name: 'typeclaw', version: '0.1.0' }),
      )

      // when: refreshDockerfile runs
      await refreshDockerfile(dir)

      // then: the on-disk Dockerfile pins the INSTALLED version, not the spec
      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toContain('FROM ghcr.io/typeclaw/typeclaw-base:0.1.0')
      expect(written).not.toContain(`FROM ${BUN_BASE_IMAGE}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('falls back to the dep spec when node_modules has not been populated yet (fresh init)', async () => {
    // given: a fresh init — package.json declares typeclaw but bun install has not run
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-fresh-'))
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: { typeclaw: '^0.1.1' } }))

      // when: refreshDockerfile runs
      await refreshDockerfile(dir)

      // then: spec parser extracts 0.1.1 from "^0.1.1" and pins it
      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toContain('FROM ghcr.io/typeclaw/typeclaw-base:0.1.1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('falls back to inline form when the typeclaw dep is a file: spec (dev mode)', async () => {
    // given: a dev contributor's agent with typeclaw symlinked from a local checkout
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-dev-'))
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { typeclaw: 'file:../typeclaw' } }),
      )

      // when: refreshDockerfile runs
      await refreshDockerfile(dir)

      // then: no GHCR pin (dev version doesn't exist on GHCR yet) — inline heavy stack on oven/bun
      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).not.toContain('ghcr.io/typeclaw/typeclaw-base')
      expect(written).toContain(`FROM ${BUN_BASE_IMAGE}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('inlines (no GHCR pin) for a link: dev install even when node_modules has a release-shaped version', async () => {
    // given: a native-Windows link: dev agent where ensureDeps already populated
    // node_modules/typeclaw with a release-shaped but unpublished version — the
    // case that would otherwise be rewritten to FROM ...:99.99.99 on start
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-winlink-'))
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { typeclaw: 'link:typeclaw' } }),
      )
      await mkdir(join(dir, 'node_modules', 'typeclaw'), { recursive: true })
      await writeFile(
        join(dir, 'node_modules', 'typeclaw', 'package.json'),
        JSON.stringify({ name: 'typeclaw', version: '99.99.99' }),
      )

      // when: refreshDockerfile runs (the path start() takes after ensureDeps)
      await refreshDockerfile(dir)

      // then: the local-spec gate inlines the heavy stack instead of pinning a nonexistent GHCR tag
      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).not.toContain('ghcr.io/typeclaw/typeclaw-base')
      expect(written).toContain(`FROM ${BUN_BASE_IMAGE}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns changed=true when overwriting a stale Dockerfile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-changed-'))
    try {
      await writeFile(join(dir, 'Dockerfile'), 'FROM stale\n')

      const result = await refreshDockerfile(dir)

      expect(result.changed).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns changed=true when no Dockerfile exists yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-fresh-changed-'))
    try {
      const result = await refreshDockerfile(dir)

      expect(result.changed).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns changed=false when the on-disk Dockerfile already matches the template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-noop-'))
    try {
      // given: a Dockerfile already rendered from the current template
      await refreshDockerfile(dir)
      const firstMtime = (await readFile(join(dir, 'Dockerfile'), 'utf8')).length

      // when: refreshDockerfile runs a second time against the identical content
      const result = await refreshDockerfile(dir)

      // then: no change reported, and the file is not rewritten (still parses the same)
      expect(result.changed).toBe(false)
      expect((await readFile(join(dir, 'Dockerfile'), 'utf8')).length).toBe(firstMtime)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns warnings for unsafe docker.file.append lines and strips them from the written Dockerfile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-strip-'))
    try {
      const dangerous = 'RUN python3 -c "import base64; exec(base64.b64decode(\'AA==\').decode())"'
      await writeTypeclawConfig(dir, { docker: { file: { append: ['ENV SAFE=1', dangerous] } } })

      const result = await refreshDockerfile(dir)

      expect(result.changed).toBe(true)
      expect(result.warnings.join('\n')).toContain('docker.file.append[1] stripped')
      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toContain('ENV SAFE=1')
      expect(written).not.toContain('exec(base64.b64decode')
      expect(written).toContain('typeclaw stripped 1 unsafe docker.file.append line(s)')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('refreshGitignore', () => {
  test('overwrites a stale .gitignore with the current template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      const stale = '# stale\nold-only-entry\n'
      await writeFile(join(dir, '.gitignore'), stale)

      await refreshGitignore(dir)

      const updated = await readFile(join(dir, '.gitignore'), 'utf8')
      expect(updated).toBe(buildGitignore())
      expect(updated).not.toBe(stale)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes the .gitignore when none exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      await refreshGitignore(dir)

      const written = await readFile(join(dir, '.gitignore'), 'utf8')
      expect(written).toBe(buildGitignore())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes custom append entries from typeclaw.json before the managed template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      await writeTypeclawConfig(dir, { git: { ignore: { append: ['scratch/', '*.local.log'] } } })

      await refreshGitignore(dir)

      const written = await readFile(join(dir, '.gitignore'), 'utf8')
      const customCommentIdx = written.indexOf('# Custom entries from typeclaw.json#git.ignore.append.')
      const scratchIdx = written.indexOf('scratch/')
      const logIdx = written.indexOf('*.local.log')
      const trulyIgnoredIdx = written.indexOf('# Truly ignored:')
      expect(customCommentIdx).toBeGreaterThan(-1)
      expect(customCommentIdx).toBeLessThan(scratchIdx)
      expect(scratchIdx).toBeLessThan(logIdx)
      expect(logIdx).toBeLessThan(trulyIgnoredIdx)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('keeps TypeClaw-owned entries ignored when custom entries try to negate them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      await gitInit(dir)
      await writeTypeclawConfig(dir, { git: { ignore: { append: ['!sessions/', '!sessions/**', 'scratch/'] } } })

      await refreshGitignore(dir)

      expect(await isGitIgnored(dir, '.env')).toBe(true)
      expect(await isGitIgnored(dir, 'Dockerfile')).toBe(true)
      expect(await isGitIgnored(dir, 'sessions/history.jsonl')).toBe(true)
      expect(await isGitIgnored(dir, 'memory/MEMORY.md')).toBe(true)
      expect(await isGitIgnored(dir, 'channels/slack.json')).toBe(true)
      expect(await isGitIgnored(dir, 'scratch/tmp.txt')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

async function isGitIgnored(cwd: string, path: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ['git', 'check-ignore', '--quiet', path],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (await proc.exited) === 0
}

async function gitInit(cwd: string): Promise<void> {
  // Runtime-owned commits use Git's ambient identity (host config or injected
  // container author/committer variables), but CI may have neither. Set a local
  // fixture identity without polluting global config.
  for (const cmd of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }
}

describe('commitSystemFile', () => {
  test('commits the file when it is dirty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-'))
    try {
      // given: a git repo with a tracked file
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM original\n')
      await runGit(dir, ['add', 'Dockerfile'])
      await runGit(dir, ['commit', '-m', 'initial'])
      // and: the file is now modified (dirty)
      await writeFile(join(dir, 'Dockerfile'), 'FROM updated\n')

      // when
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD points at the new commit with the new content
      const subject = await runGit(dir, ['log', '-1', '--format=%s'])
      expect(subject).toBe('Update Dockerfile')
      const tree = await runGit(dir, ['show', 'HEAD:Dockerfile'])
      expect(tree).toBe('FROM updated')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips silently when the file is clean (no changes since last commit)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-clean-'))
    try {
      // given: a committed file with no pending changes
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM clean\n')
      await runGit(dir, ['add', 'Dockerfile'])
      await runGit(dir, ['commit', '-m', 'initial'])
      const headBefore = await runGit(dir, ['rev-parse', 'HEAD'])

      // when
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD has not moved
      const headAfter = await runGit(dir, ['rev-parse', 'HEAD'])
      expect(headAfter).toBe(headBefore)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips silently when the directory is not a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-nogit-'))
    try {
      // given: NO git init, but a Dockerfile exists
      await writeFile(join(dir, 'Dockerfile'), 'FROM whatever\n')

      // when: commit is invoked
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: no .git directory was created and no error was thrown
      expect(existsSync(join(dir, '.git'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('only commits the named file, leaving other dirty files unstaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-scope-'))
    try {
      // given: two dirty tracked files
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM original\n')
      await writeFile(join(dir, 'AGENTS.md'), 'original\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, 'Dockerfile'), 'FROM new\n')
      await writeFile(join(dir, 'AGENTS.md'), 'user wip\n')

      // when: commit only the Dockerfile
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD's commit changed only Dockerfile, and AGENTS.md is still dirty
      const filesInLastCommit = await runGit(dir, ['show', '--name-only', '--format=', 'HEAD'])
      expect(filesInLastCommit).toBe('Dockerfile')
      const agentsContent = await readFile(join(dir, 'AGENTS.md'), 'utf8')
      expect(agentsContent).toBe('user wip\n')
      const agentsInHead = await runGit(dir, ['show', 'HEAD:AGENTS.md'])
      expect(agentsInHead).toBe('original')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

type RecordedCall = {
  args: string[]
  dockerfileSnapshot: string | null
  env?: Record<string, string | undefined>
  inheritStdio?: boolean
  captureStderr?: boolean
  captureStdout?: boolean
  maxCapturedStderrBytes?: number
  // Snapshot, taken at call time, of whether the build's DOCKER_CONFIG dir has a
  // `contexts/` subdir. Lets a test assert the sanitized config deep-copied the
  // docker context state BEFORE runImageBuild's finally removes the temp dir.
  dockerConfigHasContexts?: boolean
}

// Matches the image build regardless of frontend: `docker build ...` (legacy)
// or `docker buildx build ...` (BuildKit). Tests assert on the build call
// without caring which verb start() chose.
function isBuildCall(args: string[]): boolean {
  return args[0] === 'build' || (args[0] === 'buildx' && args[1] === 'build')
}

function protectionTagFrom(calls: RecordedCall[]): string {
  const tag = calls.find((call) => call.args[0] === 'image' && call.args[1] === 'tag')?.args[3]
  if (!tag) throw new Error('expected a temporary image protection tag')
  return tag
}

type ContainerScenario =
  | { exists: false }
  | {
      exists: true
      running: boolean
      rmFails?: boolean
      rmStderr?: string
      rmFindsRunning?: boolean
      status?: 'running' | 'exited' | 'dead' | 'removing'
      // Models Docker's async removal-drain after a `docker rm` that
      // returned with "removal in progress" stderr: the container keeps
      // showing up in `inspect` until N post-rm inspect probes have run,
      // then transitions to "no such container". Default 0 — inspect
      // reports "gone" the very next call. See stop.test.ts for the
      // full rationale.
      drainAfterInspectCalls?: number
    }

function fakeDockerExec(scenario: {
  imageExists: boolean
  imageIdBeforeBuild?: string
  imageRmFails?: boolean
  imageTags?: string[]
  container: ContainerScenario
  dockerPlatformName?: string
  buildxAvailable?: boolean
  buildxBuildFails?: boolean
  managedBuildxBuildFails?: boolean
  defaultBuildxBuildFails?: boolean
  buildFails?: boolean
  buildStderr?: string
  daemonId?: string
  daemonMemTotalBytes?: number
  managedBuilderCreateFails?: boolean
  managedBuilderRmFails?: boolean
  buildThrows?: boolean
  cacheExportMissing?: boolean
  // Simulate a broken credential helper: build calls fail with the helper-not-
  // found stderr UNTIL the call is made with DOCKER_CONFIG set in its env (the
  // sanitized-config retry), at which point the build succeeds.
  credHelperMissingUntilSanitized?: boolean
  containerInspectOutputs?: string[]
}): {
  exec: DockerExec
  calls: RecordedCall[]
  hasImageTag: (tag: string) => boolean
} {
  const calls: RecordedCall[] = []
  const imageTags = new Set(scenario.imageTags)
  let containerState = scenario.container
  let rmReturned = false
  let inspectsAfterRm = 0
  let runningRacePending = scenario.container.exists && scenario.container.rmFindsRunning === true
  let managedBuilderExists = false
  const exec: DockerExec = async (args, options) => {
    let dockerfileSnapshot: string | null = null
    if (options?.cwd) {
      try {
        dockerfileSnapshot = await readFile(join(options.cwd, 'Dockerfile'), 'utf8')
      } catch {
        dockerfileSnapshot = null
      }
    }
    const dockerConfig = options?.env?.DOCKER_CONFIG
    const dockerConfigHasContexts = dockerConfig === undefined ? undefined : existsSync(join(dockerConfig, 'contexts'))
    calls.push({
      args,
      dockerfileSnapshot,
      env: options?.env,
      inheritStdio: options?.inheritStdio,
      captureStderr: options?.captureStderr,
      captureStdout: options?.captureStdout,
      maxCapturedStderrBytes: options?.maxCapturedStderrBytes,
      dockerConfigHasContexts,
    })

    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!scenario.imageExists) return { exitCode: 1, stdout: '', stderr: '' }
      const imageId = scenario.imageIdBeforeBuild ?? 'sha256:old-image'
      return { exitCode: 0, stdout: `${imageId}\n`, stderr: '' }
    }
    if (args[0] === 'image' && args[1] === 'tag') {
      imageTags.add(args[3] ?? '')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'image' && args[1] === 'rm') {
      const target = args.at(-1) ?? ''
      if (scenario.imageRmFails) {
        return { exitCode: 1, stdout: '', stderr: 'image is being used by a container' }
      }
      if (target.startsWith('sha256:')) imageTags.clear()
      else imageTags.delete(target)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'version') {
      return { exitCode: 0, stdout: `${scenario.dockerPlatformName ?? 'Docker Engine'}\n`, stderr: '' }
    }
    if (args[0] === 'buildx' && args[1] === 'version') {
      // Default to available: the agent Dockerfile is BuildKit-only, so a
      // realistic host has buildx. Tests opt into the missing case explicitly.
      return scenario.buildxAvailable === false
        ? { exitCode: 1, stdout: '', stderr: 'unknown command "buildx"' }
        : { exitCode: 0, stdout: 'buildx v0.0.0\n', stderr: '' }
    }
    if (args[0] === 'info' && args[2] === '{{.MemTotal}}') {
      return scenario.daemonMemTotalBytes === undefined
        ? { exitCode: 1, stdout: '', stderr: 'daemon memory unavailable' }
        : { exitCode: 0, stdout: `${scenario.daemonMemTotalBytes}\n`, stderr: '' }
    }
    if (args[0] === 'info') {
      return scenario.daemonId === undefined
        ? { exitCode: 1, stdout: '', stderr: 'daemon identity unavailable' }
        : { exitCode: 0, stdout: `${scenario.daemonId}\n`, stderr: '' }
    }
    if (args[0] === 'buildx' && args[1] === 'inspect') {
      return managedBuilderExists
        ? { exitCode: 0, stdout: 'managed builder\n', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'no builder found' }
    }
    if (args[0] === 'buildx' && args[1] === 'create') {
      if (scenario.managedBuilderCreateFails) return { exitCode: 1, stdout: '', stderr: 'create failed' }
      managedBuilderExists = true
      return { exitCode: 0, stdout: `${args.at(-1)}\n`, stderr: '' }
    }
    if (args[0] === 'buildx' && args[1] === 'rm') {
      if (scenario.managedBuilderRmFails) return { exitCode: 1, stdout: '', stderr: 'builder removal failed' }
      managedBuilderExists = false
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'inspect') {
      if (rmReturned && containerState.exists) {
        inspectsAfterRm += 1
        const drainAfter = containerState.drainAfterInspectCalls ?? 0
        if (inspectsAfterRm > drainAfter) {
          containerState = { exists: false }
        }
      }
      if (!containerState.exists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      // The idempotent path probes `inspect --format {{.Id}}` after seeing
      // the container is up; mirror that here so the fake stays sufficient.
      const format = args[args.indexOf('--format') + 1] ?? ''
      if (format === '{{.State.Status}}') {
        return { exitCode: 0, stdout: `${containerState.status ?? 'exited'}\n`, stderr: '' }
      }
      if (format === '{{.Id}}|{{.State.Running}}') {
        return {
          exitCode: 0,
          stdout: scenario.containerInspectOutputs?.shift() ?? `${'a'.repeat(64)}|${containerState.running}\n`,
          stderr: '',
        }
      }
      if (format.includes('.Id')) {
        return { exitCode: 0, stdout: 'fake-running-id-123456\n', stderr: '' }
      }
      if (format.includes('.Config.Labels')) {
        return { exitCode: 0, stdout: 'fake-tui-token\n', stderr: '' }
      }
      return { exitCode: 0, stdout: `${containerState.running}\n`, stderr: '' }
    }
    if (args[0] === 'port') {
      if (!containerState.exists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      return { exitCode: 0, stdout: '0.0.0.0:8973\n', stderr: '' }
    }
    if (args[0] === 'rm') {
      if (!containerState.exists) {
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      }
      if (runningRacePending && args[1] !== '-f') {
        runningRacePending = false
        containerState = { ...containerState, running: true }
        return { exitCode: 1, stdout: '', stderr: 'cannot remove a running container' }
      }
      if (containerState.rmFails) {
        const stderr = containerState.rmStderr ?? 'rm failed'
        // "No such container" rm-failures mean the container is in fact gone
        // — Docker just learned of it a step before we did. Reflect that in
        // the fake's state so a subsequent `docker run` sees a free name.
        // "Removal in progress" leaves the container present (drain pending).
        if (stderr.toLowerCase().includes('no such container')) {
          containerState = { exists: false }
        } else if (stderr.toLowerCase().includes('removal of container')) {
          rmReturned = true
        }
        return { exitCode: 1, stdout: '', stderr }
      }
      rmReturned = true
      // Exit 0 from `docker rm` does NOT mean the name is free under
      // OrbStack load — the daemon acknowledges the rm before draining. The
      // inspect block above already advances containerState to "gone" after
      // drainAfterInspectCalls post-rm probes, so leaving the state alone
      // here lets exit-0 tests exercise the same drain window the
      // "in-progress" tests do. drainAfterInspectCalls === 0 (the default
      // for existing tests) still flips state on the very next inspect, so
      // the pre-existing happy-path tests continue to see immediate "gone".
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (isBuildCall(args)) {
      if (scenario.buildThrows) throw new Error('build process failed')
      if (scenario.buildFails) {
        return { exitCode: 1, stdout: '', stderr: scenario.buildStderr ?? 'build exploded' }
      }
      // Simulate "buildx plugin present but the build fails" (e.g. no usable
      // builder). The legacy `docker build` retry still succeeds.
      if (scenario.buildxBuildFails && args[0] === 'buildx') {
        return { exitCode: 1, stdout: '', stderr: 'ERROR: no builder instance found' }
      }
      if (scenario.managedBuildxBuildFails && args[0] === 'buildx' && args.includes('--builder')) {
        return { exitCode: 1, stdout: '', stderr: 'ERROR: managed builder failed' }
      }
      if (scenario.defaultBuildxBuildFails && args[0] === 'buildx' && !args.includes('--builder')) {
        return { exitCode: 1, stdout: '', stderr: 'ERROR: default builder failed' }
      }
      if (scenario.credHelperMissingUntilSanitized && options?.env?.DOCKER_CONFIG === undefined) {
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            'ERROR: failed to solve: error getting credentials - err: exec: ' +
            '"docker-credential-desktop": executable file not found in %PATH%',
        }
      }
      const cacheTo = args[args.indexOf('--cache-to') + 1]
      const cacheDestination = cacheTo?.match(/^type=local,dest=(.+),mode=min$/)?.[1]
      if (args[0] === 'buildx' && cacheDestination !== undefined && !scenario.cacheExportMissing) {
        await mkdir(cacheDestination, { mode: 0o700 })
        await writeFile(join(cacheDestination, 'index.json'), '{}')
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'run') {
      if (containerState.exists) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc".`,
        }
      }
      containerState = { exists: true, running: true }
      return { exitCode: 0, stdout: 'fake-container-id-abcdef\n', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls, hasImageTag: (tag) => imageTags.has(tag) }
}

describe('start (composition)', () => {
  test('holds the operation lock from inspection through migration, launch, and verification', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const legacy = join(root, 'workspace', '.agent-messenger')
    const canonical = join(root, 'workspace', '.config', 'agent-messenger')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'key'), 'material')
    const docker = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const events: string[] = []
    let recordedInspect = false
    const exec: DockerExec = async (args, options) => {
      if (args[0] === 'inspect' && !recordedInspect) {
        recordedInspect = true
        events.push('inspect')
      }
      if (args[0] === 'run') {
        if (!existsSync(legacy) && existsSync(join(canonical, 'key'))) events.push('migration')
        events.push('docker-run')
      }
      return await docker.exec(args, options)
    }
    const operationLock: WithAgentOperationLock = async (input, run) => {
      events.push('lock-enter')
      const value = await run({ containerName: basename(input.agentDir), agentDir: input.agentDir })
      events.push('lock-exit')
      return { ok: true, value }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      operationLock,
      allocatePort: deterministicAllocator,
      assertConfigWritable: () => {
        events.push('config-writable')
      },
      provisionGithubCliStore: ({ agentDir }) => {
        expect(agentDir).toBe(root)
        events.push('github-cli')
        return { ok: true }
      },
      ensureDeps: async () => {
        events.push('ensure-deps')
        return { ok: true, installed: false }
      },
      ensureModels: noEnsureModels,
      autoUpgrade: noAutoUpgrade,
      verifyRunning: async () => {
        events.push('verify')
        return { ok: true }
      },
    })

    expect(result.ok).toBe(true)
    expect(events).toEqual([
      'lock-enter',
      'inspect',
      'config-writable',
      'github-cli',
      'ensure-deps',
      'migration',
      'docker-run',
      'verify',
      'lock-exit',
    ])
  })

  test('contention prevents Docker and agent-messenger migration side effects', async () => {
    const legacy = join(root, 'workspace', '.agent-messenger')
    const canonical = join(root, 'workspace', '.config', 'agent-messenger')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'key'), 'material')
    const calls: string[][] = []
    const operationLock: WithAgentOperationLock = async () => ({ ok: false, reason: 'contended' })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      operationLock,
      exec: async (args) => {
        calls.push(args)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      ensureModels: noEnsureModels,
    })

    expect(result).toEqual({ ok: false, reason: 'contended' })
    expect(calls).toEqual([])
    expect(await readFile(join(legacy, 'key'), 'utf8')).toBe('material')
    expect(existsSync(canonical)).toBe(false)
  })

  test('re-probes immediately before migration and refuses a container that became running', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const legacy = join(root, 'workspace', '.agent-messenger')
    const canonical = join(root, 'workspace', '.config', 'agent-messenger')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'key'), 'material')
    let inspections = 0
    const calls: string[][] = []
    const exec: DockerExec = async (args) => {
      calls.push(args)
      if (args[0] === 'inspect') {
        inspections += 1
        if (inspections === 1) return { exitCode: 1, stdout: '', stderr: 'No such container' }
        return { exitCode: 0, stdout: `${'a'.repeat(64)}|true\n`, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({ cwd: root, preferredHostPort: 8973, exec, ensureModels: noEnsureModels })

    expect(result).toEqual({
      ok: false,
      reason: `Container ${basename(root)} became running during start preflight; refusing to migrate agent-messenger credentials or launch a replacement.`,
    })
    expect(await readFile(join(legacy, 'key'), 'utf8')).toBe('material')
    expect(existsSync(canonical)).toBe(false)
    expect(calls.some((args) => args[0] === 'run')).toBe(false)
  })

  test('fails closed before migration or launch when Docker container state is indeterminate', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const legacy = join(root, 'workspace', '.agent-messenger')
    const current = join(root, 'workspace', '.config', 'agent-messenger')
    await mkdir(join(legacy, 'line-storage'), { recursive: true })
    await writeFile(join(legacy, 'line-storage', 'e2ee.key'), Buffer.from([0, 1, 2, 255]))
    const before = await readFile(join(legacy, 'line-storage', 'e2ee.key'))
    const calls: string[][] = []
    let checkedConfigWritable = false
    const exec: DockerExec = async (args) => {
      calls.push(args)
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'permission denied while trying to connect to the Docker daemon socket',
      }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      assertConfigWritable: () => {
        checkedConfigWritable = true
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Docker state could not be determined')
    expect(result.reason).toContain(basename(root))
    expect(result.reason).toContain('refusing to migrate or launch')
    expect(await readFile(join(legacy, 'line-storage', 'e2ee.key'))).toEqual(before)
    expect(existsSync(current)).toBe(false)
    expect(checkedConfigWritable).toBe(false)
    expect(calls.some((args) => isBuildCall(args))).toBe(false)
    expect(calls.some((args) => args[0] === 'run')).toBe(false)
  })

  test('treats a genuine missing-container inspect response as missing and starts normally', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const docker = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec: docker.exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(docker.calls.some((call) => call.args[0] === 'run')).toBe(true)
  })

  test('migrates legacy agent-messenger data before docker run and injects the canonical container path', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const legacy = join(root, 'workspace', '.agent-messenger')
    const current = join(root, 'workspace', '.config', 'agent-messenger')
    await mkdir(join(legacy, 'line-storage'), { recursive: true })
    await writeFile(join(legacy, 'line-storage', 'e2ee.key'), 'key-material')
    const docker = fakeDockerExec({ imageExists: true, container: { exists: false } })
    let migratedBeforeRun = false
    const exec: DockerExec = async (args, options) => {
      if (args[0] === 'run') {
        migratedBeforeRun =
          !existsSync(legacy) && (await readFile(join(current, 'line-storage', 'e2ee.key'), 'utf8')) === 'key-material'
      }
      return docker.exec(args, options)
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(migratedBeforeRun).toBe(true)
    const runCall = docker.calls.find((call) => call.args[0] === 'run')
    expect(runCall?.args).toContain('AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.config/agent-messenger')
  })

  test('aborts before docker build or run when agent-messenger migration finds populated paths', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const legacy = join(root, 'workspace', '.agent-messenger')
    const current = join(root, 'workspace', '.config', 'agent-messenger')
    await mkdir(legacy, { recursive: true })
    await mkdir(current, { recursive: true })
    await writeFile(join(legacy, 'legacy.json'), 'legacy')
    await writeFile(join(current, 'current.json'), 'current')
    const { exec, calls } = fakeDockerExec({ imageExists: false, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Merge them manually')
    expect(calls.some((call) => isBuildCall(call.args))).toBe(false)
    expect(calls.some((call) => call.args[0] === 'run')).toBe(false)
  })

  test('preserves populated legacy data when .env deliberately pins the legacy container path', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger\n')
    const legacy = join(root, 'workspace', '.agent-messenger')
    const current = join(root, 'workspace', '.config', 'agent-messenger')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'session.json'), 'operator-pinned-session')
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(legacy, 'session.json'), 'utf8')).toBe('operator-pinned-session')
    expect(existsSync(current)).toBe(false)
    const runCall = calls.find((call) => call.args[0] === 'run')
    expect(runCall?.args).toContain('--env-file')
    expect(runCall?.args).toContain(join(root, '.env'))
    expect(runCall?.args).not.toContain('AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.config/agent-messenger')
  })

  test('fails before refreshing managed files when typeclaw.json is not writable by the host user', async () => {
    // given
    await writeFile(join(root, 'typeclaw.json'), '{}\n')
    await writeFile(join(root, '.gitignore'), '# stale\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      assertConfigWritable: () => {
        throw new Error('typeclaw.json is not writable by the current host user')
      },
      ...bypassVerify,
    })

    // then
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('typeclaw.json is not writable by the current host user'),
    })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('# stale\n')
    expect(calls.some((call) => call.args[0] === 'run')).toBe(false)
  })

  test('warns and continues without replacing persisted GitHub CLI credentials when refresh fails', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const persisted = '{"version":2,"githubCli":{"hosts":"existing-good-store"}}\n'
    await writeFile(join(root, 'secrets.json'), persisted)
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: noAutoUpgrade,
        ...bypassVerify,
        provisionGithubCliStore: () => ({ ok: false, reason: 'sensitive-command-output' }),
      })

      expect(result.ok).toBe(true)
      expect(calls.some((call) => call.args[0] === 'run')).toBe(true)
      expect(await readFile(join(root, 'secrets.json'), 'utf8')).toBe(persisted)
      const warning = stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
      expect(warning).toContain('warning')
      expect(warning).toContain('gh auth login --hostname github.com')
      expect(warning).toContain('Keeping the previously persisted credential store')
      expect(warning).not.toContain('sensitive-command-output')
    } finally {
      stderr.mockRestore()
    }
  })

  test('stays silent when a GitHub CLI refresh fails for an agent that never had a persisted store', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'secrets.json'), '{"version":2,"channels":{}}\n')
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
    const warnings: string[] = []

    try {
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        streamOutput: false,
        onWarning: (warning) => warnings.push(warning),
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: noAutoUpgrade,
        ...bypassVerify,
        provisionGithubCliStore: () => ({ ok: false, reason: 'sensitive-command-output' }),
      })

      expect(result.ok).toBe(true)
      expect(warnings).toEqual([])
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  test('warns when a GitHub CLI refresh fails and secrets.json cannot be read at all', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'secrets.json'), 'not json\n')
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const warnings: string[] = []

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      provisionGithubCliStore: () => ({ ok: false, reason: 'sensitive-command-output' }),
    })

    expect(result.ok).toBe(true)
    expect(warnings).toEqual([expect.stringContaining('Could not refresh GitHub CLI credentials')])
  })

  test('returns warnings instead of writing them while a parent renderer owns the terminal', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'secrets.json'), '{"version":2,"githubCli":{"hosts":"existing-good-store"}}\n')
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
    const warnings: string[] = []

    try {
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        streamOutput: false,
        onWarning: (warning) => warnings.push(warning),
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: noAutoUpgrade,
        ...bypassVerify,
        provisionGithubCliStore: () => ({ ok: false, reason: 'sensitive-command-output' }),
      })

      expect(result.ok).toBe(true)
      expect(warnings).toEqual([expect.stringContaining('Could not refresh GitHub CLI credentials')])
      expect(warnings.join('')).not.toContain('sensitive-command-output')
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  test('passes the canonical agent root and configured writable mount roots to GitHub CLI refresh', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const writableMount = join(root, 'host-mounts', 'writable')
    const readOnlyMount = join(root, 'host-mounts', 'readonly')
    await mkdir(writableMount, { recursive: true })
    await mkdir(readOnlyMount, { recursive: true })
    await writeTypeclawConfig(root, {
      mounts: [
        { name: 'writable', path: writableMount },
        { name: 'readonly', path: readOnlyMount, readOnly: true },
      ],
    })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    let deniedRoots: readonly string[] | undefined

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      provisionGithubCliStore: (options) => {
        deniedRoots = options.deniedRoots
        return { ok: true }
      },
    })

    expect(result.ok).toBe(true)
    expect(deniedRoots).toEqual([realpathSync(root), writableMount])
    expect(deniedRoots).not.toContain(readOnlyMount)
  })

  test('provisions embedding models on every fresh start', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    let ensureModelCalls = 0

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      ensureModels: async () => {
        ensureModelCalls += 1
      },
    })

    expect(result.ok).toBe(true)
    expect(ensureModelCalls).toBe(1)
  })

  test('reports an actionable error when embedding model provisioning fails', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      ensureModels: async () => {
        throw new Error('offline')
      },
    })

    expect(result).toEqual({
      ok: false,
      reason: 'embedding model unavailable; ensure network access on first start or a populated model cache: offline',
    })
  })

  test('publishes on all host interfaces for Docker Desktop', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: false },
      dockerPlatformName: 'Docker Desktop 4.42.0',
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const runCall = calls.find((call) => call.args[0] === 'run')
    expect(runCall?.args).toContain('0.0.0.0:8973:8973')
  })

  test('refreshes Dockerfile from the template on every start, even without --build', async () => {
    // given: a stale Dockerfile and an existing image (no rebuild needed)
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: up runs WITHOUT --build
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: the Dockerfile on disk was refreshed even though docker build never ran
    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(onDisk).toBe(buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    expect(onDisk).not.toContain('FROM stale')
  })

  test('refreshes .gitignore from the template on every start', async () => {
    // given: a stale .gitignore and an existing image
    await writeFile(join(root, '.gitignore'), '# stale\nold-entry\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(root, '.gitignore'), 'utf8')
    expect(onDisk).toBe(buildGitignore())
    expect(onDisk).not.toContain('old-entry')
  })

  test('start refreshes .gitignore with custom append entries from typeclaw.json', async () => {
    await writeFile(join(root, '.gitignore'), '# stale\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { git: { ignore: { append: ['scratch/', '*.local.log'] } } })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(root, '.gitignore'), 'utf8')
    expect(onDisk).toContain('scratch/')
    expect(onDisk).toContain('*.local.log')
    expect(onDisk.indexOf('*.local.log')).toBeLessThan(onDisk.indexOf('# Truly ignored:'))
  })

  test('forceBuild=true also refreshes the Dockerfile so docker build sees the fresh template', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => isBuildCall(c.args))
    expect(buildCall).toBeDefined()
    expect(buildCall!.dockerfileSnapshot).toBe(buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    expect(buildCall!.dockerfileSnapshot).not.toContain('FROM stale')
  })

  test('reclaims a replaced image by releasing its temporary protection tag', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      imageIdBeforeBuild: 'sha256:replaced-image',
      container: { exists: false },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const protectCall = calls.find((call) => call.args[0] === 'image' && call.args[1] === 'tag')
    const protectionTag = protectionTagFrom(calls)
    expect(protectCall?.args[2]).toBe('sha256:replaced-image')
    expect(protectionTag).toStartWith(`typeclaw-${basename(root)}:rebuild-`)
    expect(calls.map((call) => call.args)).toContainEqual(['image', 'rm', '--no-prune', protectionTag])
    expect(calls.map((call) => call.args)).not.toContainEqual(['image', 'rm', '--no-prune', 'sha256:replaced-image'])
  })

  test('preserves another agent tag that points at the replaced image', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const otherAgentTag = 'typeclaw-other-agent:latest'
    const { exec, hasImageTag } = fakeDockerExec({
      imageExists: true,
      imageIdBeforeBuild: 'sha256:shared-image',
      imageTags: [otherAgentTag],
      container: { exists: false },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(hasImageTag(otherAgentTag)).toBe(true)
  })

  test('keeps the current image when a rebuild resolves to the same image ID', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      imageIdBeforeBuild: 'sha256:cached-image',
      container: { exists: false },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const protectionTag = protectionTagFrom(calls)
    expect(calls.map((call) => call.args)).toContainEqual(['image', 'rm', '--no-prune', protectionTag])
    expect(calls.map((call) => call.args)).not.toContainEqual(['image', 'rm', '--no-prune', 'sha256:cached-image'])
  })

  test('preserves the prior image when its replacement build fails', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      imageIdBeforeBuild: 'sha256:prior-image',
      buildFails: true,
      container: { exists: false },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      streamOutput: false,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    const protectionTag = protectionTagFrom(calls)
    expect(calls.map((call) => call.args)).toContainEqual(['image', 'rm', '--no-prune', protectionTag])
    expect(calls.map((call) => call.args)).not.toContainEqual(['image', 'rm', '--no-prune', 'sha256:prior-image'])
  })

  test('warns without blocking startup when Docker retains a replaced image', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const warnings: string[] = []
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      imageIdBeforeBuild: 'sha256:in-use-image',
      imageRmFails: true,
      container: { exists: false },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const protectionTag = protectionTagFrom(calls)
    expect(calls.map((call) => call.args)).toContainEqual(['image', 'rm', '--no-prune', protectionTag])
    expect(warnings).toEqual([
      expect.stringMatching(
        /^Could not remove temporary Docker image protection tag typeclaw-.+:rebuild-[0-9a-f]+: image is being used by a container$/,
      ),
    ])
  })

  test('prints a cleanup warning without calling the parent warning hook while streaming output', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const warnings: string[] = []
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { exec } = fakeDockerExec({
      imageExists: true,
      imageIdBeforeBuild: 'sha256:in-use-image',
      imageRmFails: true,
      container: { exists: false },
    })

    try {
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        forceBuild: true,
        onWarning: (warning) => warnings.push(warning),
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: noAutoUpgrade,
        ...bypassVerify,
      })

      expect(result.ok).toBe(true)
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
        'typeclaw: Could not remove temporary Docker image protection tag',
      )
      expect(warnings).toEqual([])
    } finally {
      stderr.mockRestore()
    }
  })

  test('builds via `docker buildx build` (BuildKit frontend) so the Dockerfile cache mounts are honored', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: false, container: { exists: false }, buildxAvailable: true })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => isBuildCall(c.args))
    expect(buildCall?.args.slice(0, 2)).toEqual(['buildx', 'build'])
    // --load puts the image in the local store so the later `docker run` finds
    // it; non-default buildx drivers export to cache only without it.
    expect(buildCall?.args).toContain('--load')
    expect(buildCall?.dockerfileSnapshot).toContain('# syntax=docker/dockerfile:1.7')
    expect(buildCall?.dockerfileSnapshot).toContain('--mount=type=cache')
    expect(buildCall?.inheritStdio).toBe(true)
    expect(buildCall?.captureStderr).toBe(true)
  })

  test('uses exact managed cache flags and removes the owned builder after promotion', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon',
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      buildCacheStateDir: join(root, 'build-cache'),
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireManagedBuildCache,
    })

    expect(result.ok).toBe(true)
    const managedCalls = calls.filter(({ args }) => args[0] === 'buildx' && (args[1] === 'rm' || args[1] === 'build'))
    expect(managedCalls.map(({ args }) => args[1])).toEqual(['build', 'rm'])
    const build = managedCalls[0]!.args
    const builderName = build[build.indexOf('--builder') + 1]
    if (builderName === undefined) throw new Error('expected managed builder name')
    expect(builderName).toMatch(/^typeclaw-[a-f0-9]{24}$/)
    expect(managedCalls[1]!.args).toEqual(['buildx', 'rm', builderName])
    expect(build).toContain('--load')
    expect(build).not.toContain('--cache-from')
    const cacheToIndex = build.indexOf('--cache-to')
    // Parse the destination instead of regexing the whole CSV value: the path
    // separator is platform-dependent, so a `/generations/` literal fails on Windows.
    const cacheTo = /^type=local,dest=(.+),mode=min$/.exec(build[cacheToIndex + 1] ?? '')
    if (cacheTo === null) throw new Error('expected a local managed cache export destination')
    const dest = cacheTo[1]!
    expect(basename(dest)).toMatch(/^[a-f0-9]{32}$/)
    expect(basename(dirname(dest))).toBe('generations')
    expect(managedCalls[0]!.env?.BUILDX_CONFIG).toStartWith(join(root, 'build-cache'))
    expect(managedCalls[1]!.env?.BUILDX_CONFIG).toBe(managedCalls[0]!.env?.BUILDX_CONFIG)
    expect(calls.some(({ args }) => args[0] === 'builder' || args[0] === 'system')).toBe(false)
    expect(calls.some(({ args }) => args[0] === 'image' && args[1] === 'rm')).toBe(false)
    expect(calls.some(({ args }) => args[0] === 'volume' || (args[0] === 'rm' && args.includes('-f')))).toBe(false)
  })

  test('surfaces retired-cache cleanup warnings without blocking the managed build', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const stateDir = join(root, 'build-cache')
    const scopeHash = createHash('sha256').update(basename(root)).digest('hex')
    await mkdir(join(stateDir, scopeHash, 'unsafe-entry'), { recursive: true })
    const warnings: string[] = []
    const { exec } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-warning',
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      buildCacheStateDir: stateDir,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireManagedBuildCache,
    })

    expect(result.ok).toBe(true)
    expect(warnings.join(' ')).toContain('unsafe managed build cache entry preserved')
  })

  test('failed thrown managed build does not promote staging and still removes its builder once', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-failure',
      buildThrows: true,
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      buildCacheStateDir: join(root, 'build-cache'),
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireManagedBuildCache,
    })

    expect(result.ok).toBe(false)
    expect(calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toHaveLength(1)
    const build = calls.find(({ args }) => args[0] === 'buildx' && args[1] === 'build')
    const cacheTo = build?.args[build.args.indexOf('--cache-to') + 1]
    const staging = cacheTo?.match(/^type=local,dest=(.+),mode=min$/)?.[1]
    expect(staging).toBeDefined()
    expect(existsSync(staging!)).toBe(false)
  })

  test('builder removal failure warns but does not block the managed build', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const warnings: string[] = []
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-removal-failure',
      managedBuilderRmFails: true,
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      buildCacheStateDir: join(root, 'build-cache'),
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireManagedBuildCache,
    })

    expect(result.ok).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings.every((warning) => warning.includes('managed builder removal failed'))).toBe(true)
    expect(calls.find(({ args }) => args[0] === 'buildx' && args[1] === 'build')?.args).toContain('--builder')
  })

  test('managed builder setup failure preserves default buildx then legacy fallback', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const warnings: string[] = []
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-setup-failure',
      managedBuilderCreateFails: true,
      buildxBuildFails: true,
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      buildCacheStateDir: join(root, 'build-cache'),
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireManagedBuildCache,
    })

    expect(result.ok).toBe(true)
    const builds = calls.filter(({ args }) => isBuildCall(args))
    expect(builds.map(({ args }) => args.slice(0, 2))).toEqual([
      ['buildx', 'build'],
      ['build', '-t'],
    ])
    expect(builds[0]!.args).not.toContain('--builder')
    expect(builds[0]!.args).not.toContain('--cache-from')
    expect(builds[0]!.args).not.toContain('--cache-to')
    expect(builds[0]!.env?.BUILDX_CONFIG).toBeUndefined()
    expect(calls.some(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toBe(false)
    expect(warnings.some((warning) => warning.includes('managed build cache unavailable'))).toBe(true)
  })

  test('managed acquire release failure falls back to default buildx without rejecting start', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const warnings: string[] = []
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-release-failure',
    })
    const acquireWithReleaseFailure: typeof acquireManagedBuildCache = async (options) =>
      await acquireManagedBuildCache({
        ...options,
        randomBuilderName: () => 'typeclaw-aaaaaaaaaaaaaaaaaaaaaaaa',
        randomGenerationId: () => 'invalid',
        faultInjection: {
          releaseLock: async (release) => {
            await release()
            throw new Error('injected release failure')
          },
        },
      })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      buildCacheStateDir: join(root, 'build-cache'),
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireWithReleaseFailure,
    })

    expect(result.ok).toBe(true)
    const build = calls.find(({ args }) => isBuildCall(args))
    expect(build?.args).not.toContain('--builder')
    expect(build?.env?.BUILDX_CONFIG).toBeUndefined()
    expect(warnings.join(' ')).toContain('injected release failure')
  })

  test('captures build output when streaming is disabled by a live parent renderer', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      buildxBuildFails: true,
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const buildCalls = calls.filter((call) => isBuildCall(call.args))
    expect(buildCalls).toHaveLength(2)
    for (const buildCall of buildCalls) {
      expect(buildCall.inheritStdio).toBeUndefined()
      expect(buildCall.captureStderr).toBeUndefined()
      expect(buildCall.captureStdout).toBe(false)
      expect(buildCall.maxCapturedStderrBytes).toBe(32 * 1024)
    }
  })

  test('returns a safe recovery command when a live parent renderer suppresses build output', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      buildFails: true,
      buildStderr: 'docker: Error response from daemon: unavailable\n',
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result).toEqual({
      ok: false,
      reason:
        'docker build failed (exit code 1). Run `typeclaw start --build` from this agent directory to view the full build output.',
    })
  })

  test('does not expose captured build output in the compose failure reason', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      buildFails: true,
      buildStderr: '\x1b[31msensitive-build-output\x1b[0m\r',
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).not.toContain('sensitive-build-output')
    expect(result.reason).toContain('typeclaw start --build')
  })

  test('without buildx, falls back to legacy `docker build` against a BuildKit-stripped Dockerfile so start still succeeds', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: false, container: { exists: false }, buildxAvailable: false })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      buildCacheStateDir: join(root, 'build-cache'),
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireManagedBuildCache,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => isBuildCall(c.args))
    expect(buildCall?.args[0]).toBe('build')
    expect(buildCall?.args).not.toContain('buildx')
    expect(buildCall?.args).not.toContain('--cache-from')
    expect(buildCall?.args).not.toContain('--cache-to')
    expect(buildCall?.env?.BUILDX_CONFIG).toBeUndefined()
    // The Dockerfile on disk must be BuildKit-free, or the legacy build chokes.
    expect(buildCall?.dockerfileSnapshot).not.toContain('# syntax=')
    expect(buildCall?.dockerfileSnapshot).not.toContain('--mount=type=cache')
    // Narrowed to the daemon-identity probe the managed build cache uses.
    // start() also runs `docker info --format {{.MemTotal}}` to size the
    // container memory limit, which is unrelated to the build path.
    expect(calls.some((c) => c.args[0] === 'info' && c.args[2] === '{{.ID}}')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'buildx' && c.args[1] === 'rm')).toBe(false)
  })

  test('when a buildx BUILD fails, transparently falls back to legacy `docker build` and start still succeeds', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-build-fallback',
      buildxBuildFails: true,
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      buildCacheStateDir: join(root, 'build-cache'),
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireManagedBuildCache,
    })

    expect(result.ok).toBe(true)
    const buildCalls = calls.filter((c) => isBuildCall(c.args))
    // First attempt is buildx; after it fails we retry with the legacy builder.
    expect(buildCalls[0]?.args.slice(0, 2)).toEqual(['buildx', 'build'])
    const legacy = buildCalls.find((c) => c.args[0] === 'build')
    expect(legacy).toBeDefined()
    expect(legacy?.env?.BUILDX_CONFIG).toBeUndefined()
    expect(legacy?.args).not.toContain('--cache-from')
    expect(legacy?.args).not.toContain('--cache-to')
    expect(
      calls
        .filter(({ args }) => args[0] === 'build' || (args[0] === 'buildx' && ['rm', 'build'].includes(args[1]!)))
        .map(({ args }) => args.slice(0, 2).join(' ')),
    ).toEqual(['buildx build', 'buildx rm', 'buildx build', 'build -t'])
    // The retry rewrote the Dockerfile to its BuildKit-stripped form.
    expect(legacy?.dockerfileSnapshot).not.toContain('# syntax=')
    expect(legacy?.dockerfileSnapshot).not.toContain('--mount=type=cache')
    const managed = buildCalls[0]!
    const cacheTo = managed.args[managed.args.indexOf('--cache-to') + 1]
    const staging = cacheTo?.match(/^type=local,dest=(.+),mode=min$/)?.[1]
    expect(staging).toBeDefined()
    expect(existsSync(staging!)).toBe(false)
    expect(existsSync(join(staging!, '..', '..', 'active.json'))).toBe(false)
    expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
  })

  test('managed buildx failure cleans up then retries default buildx without managed state', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-default-retry',
      managedBuildxBuildFails: true,
    })
    const warnings: string[] = []

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      buildCacheStateDir: join(root, 'build-cache'),
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      acquireBuildCache: acquireManagedBuildCache,
    })

    expect(result.ok).toBe(true)
    const relevant = calls.filter(
      ({ args }) => args[0] === 'build' || (args[0] === 'buildx' && ['rm', 'build'].includes(args[1]!)),
    )
    expect(relevant.map(({ args }) => args.slice(0, 2).join(' '))).toEqual([
      'buildx build',
      'buildx rm',
      'buildx build',
    ])
    const managed = relevant[0]!
    const current = relevant[2]!
    expect(managed.args).toContain('--builder')
    expect(current.args).not.toContain('--builder')
    expect(current.args).not.toContain('--cache-from')
    expect(current.args).not.toContain('--cache-to')
    expect(current.env?.BUILDX_CONFIG).toBeUndefined()
    expect(current.dockerfileSnapshot).toContain('# syntax=docker/dockerfile:1.7')
    expect(warnings).toContain("managed buildx build failed; retrying with Docker's current builder")
    expect(warnings.join(' ')).not.toContain('managed builder failed')
  })

  test('when a build fails on a missing credential helper, retries the same build under a sanitized DOCKER_CONFIG and succeeds', async () => {
    // given a host whose ~/.docker config has a broken cred helper AND a docker
    // context dir (the desktop-linux context+builder state that a relocated
    // DOCKER_CONFIG must not lose, or buildx fails with "no builder ... found")
    const dockerCfg = await mkdtemp(join(tmpdir(), 'typeclaw-test-dockercfg-'))
    await writeFile(
      join(dockerCfg, 'config.json'),
      JSON.stringify({ credsStore: 'desktop', currentContext: 'desktop-linux' }),
    )
    await mkdir(join(dockerCfg, 'contexts', 'meta', 'desktop-linux'), { recursive: true })
    await writeFile(join(dockerCfg, 'contexts', 'meta', 'desktop-linux', 'meta.json'), '{"Name":"desktop-linux"}')
    const prevDockerConfig = process.env.DOCKER_CONFIG
    process.env.DOCKER_CONFIG = dockerCfg
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-credential-retry',
      credHelperMissingUntilSanitized: true,
    })

    try {
      // when start builds the image
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        buildCacheStateDir: join(root, 'build-cache'),
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        ...bypassVerify,
        acquireBuildCache: acquireManagedBuildCache,
      })

      // then it recovers transparently and the container comes up
      expect(result.ok).toBe(true)
      const buildCalls = calls.filter((c) => isBuildCall(c.args))
      // first build runs without the override and fails on the cred helper
      expect(buildCalls[0]?.env?.DOCKER_CONFIG).toBeUndefined()
      expect(buildCalls[0]?.args).toContain('--builder')
      expect(buildCalls[0]?.env?.BUILDX_CONFIG).toBeDefined()
      // the retry runs the SAME buildx frontend, now pointed at a sanitized dir
      // (the dir's contents are removed by runImageBuild's cleanup; the sanitize
      // transform itself is asserted in sanitizeDockerConfigJson's unit tests)
      const retry = buildCalls.find((c) => c.env?.DOCKER_CONFIG !== undefined)
      expect(retry).toBeDefined()
      expect(retry?.args.slice(0, 2)).toEqual(['buildx', 'build'])
      const firstBuilderIndex = buildCalls[0]!.args.indexOf('--builder')
      const retryBuilderIndex = retry!.args.indexOf('--builder')
      expect(buildCalls[0]!.args[firstBuilderIndex + 1]).toBe(retry!.args[retryBuilderIndex + 1])
      expect(buildCalls[0]!.args).toEqual(retry!.args)
      expect(buildCalls[0]!.env?.BUILDX_CONFIG).toBe(retry!.env?.BUILDX_CONFIG)
      // the retry must NOT point at the user's real config dir
      expect(retry?.env?.DOCKER_CONFIG).not.toBe(dockerCfg)
      // regression guard: the sanitized dir is a DEEP COPY that preserved the
      // docker context state, so buildx can still resolve the desktop-linux
      // builder (the symlink approach silently dropped this on Windows)
      expect(retry?.dockerConfigHasContexts).toBe(true)
      expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
    } finally {
      if (prevDockerConfig === undefined) delete process.env.DOCKER_CONFIG
      else process.env.DOCKER_CONFIG = prevDockerConfig
      await rm(dockerCfg, { recursive: true, force: true })
    }
  })

  test('default buildx retry applies credential-helper recovery after managed buildx fails', async () => {
    const dockerCfg = await mkdtemp(join(tmpdir(), 'typeclaw-test-dockercfg-'))
    await writeFile(join(dockerCfg, 'config.json'), JSON.stringify({ credsStore: 'desktop' }))
    const previousDockerConfig = process.env.DOCKER_CONFIG
    process.env.DOCKER_CONFIG = dockerCfg
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: false,
      container: { exists: false },
      buildxAvailable: true,
      daemonId: 'managed-daemon-default-credential-retry',
      managedBuildxBuildFails: true,
      credHelperMissingUntilSanitized: true,
    })

    try {
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        buildCacheStateDir: join(root, 'build-cache'),
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: noAutoUpgrade,
        ...bypassVerify,
        acquireBuildCache: acquireManagedBuildCache,
      })

      expect(result.ok).toBe(true)
      const builds = calls.filter(({ args }) => isBuildCall(args))
      expect(builds).toHaveLength(3)
      expect(builds[0]!.args).toContain('--builder')
      expect(builds[1]!.args).not.toContain('--builder')
      expect(builds[1]!.env?.DOCKER_CONFIG).toBeUndefined()
      expect(builds[2]!.args).toEqual(builds[1]!.args)
      expect(builds[2]!.env?.DOCKER_CONFIG).toBeDefined()
      expect(builds.some(({ args }) => args[0] === 'build')).toBe(false)
    } finally {
      if (previousDockerConfig === undefined) delete process.env.DOCKER_CONFIG
      else process.env.DOCKER_CONFIG = previousDockerConfig
      await rm(dockerCfg, { recursive: true, force: true })
    }
  })

  test('start refreshes Dockerfile with custom append lines from typeclaw.json', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { docker: { file: { append: ['RUN echo from-config'] } } })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => isBuildCall(c.args))
    if (!buildCall?.dockerfileSnapshot) throw new Error('expected docker build to capture Dockerfile snapshot')
    expect(buildCall.dockerfileSnapshot).toContain('RUN echo from-config')
    expect(buildCall.dockerfileSnapshot.indexOf('RUN echo from-config')).toBeLessThan(
      buildCall.dockerfileSnapshot.indexOf('ENTRYPOINT ["/usr/local/bin/typeclaw-entrypoint"]'),
    )
  })

  test('forceBuild=true rebuild sees Dockerfile with ffmpeg from typeclaw.json', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { docker: { file: { ffmpeg: true } } })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => isBuildCall(c.args))
    if (!buildCall?.dockerfileSnapshot) throw new Error('expected docker build to capture Dockerfile snapshot')
    expect(buildCall.dockerfileSnapshot).toMatch(/apt-get install -y --no-install-recommends[\s\S]+\bffmpeg\b/)
  })

  test('commits the refreshed .gitignore when the agent folder is a git repo', async () => {
    // given: an agent folder that is a git repo with a stale committed .gitignore
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), '# stale\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs (refresh will rewrite .gitignore, commit should land it)
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: HEAD advanced and the new commit exists with the expected subject
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update .gitignore')
  })

  test('does not auto-commit Dockerfile changes (Dockerfile is gitignored, regenerated on every start)', async () => {
    // given: an agent folder following the realistic post-init shape — Dockerfile
    // is on disk but gitignored, so it was never tracked.
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs (Dockerfile is rewritten on disk, .gitignore is unchanged)
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: HEAD did not move (no Dockerfile commit, no .gitignore commit)
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
    // and: the Dockerfile on disk is the fresh template
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toBe(
      buildDockerfile(undefined, { baseImageVersion: '0.1.0' }),
    )
  })

  test('does not commit when the refresh produces no change (clean working tree)', async () => {
    // given: an agent folder where .gitignore is already at the latest template
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: no new commits were created
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
  })

  test('migrates a pre-monorepo agent folder by injecting workspaces and committing the change', async () => {
    // given: an agent folder from before bun-workspaces support — package.json has no
    // `workspaces` field, packages/.gitkeep does not exist
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJsonPreMigration(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs (refreshPackageJson should inject workspaces and create .gitkeep)
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: a new commit landed with the migration
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Enable bun workspaces (packages/*)')
    // and: the agent folder is now in the post-migration shape
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.workspaces).toEqual(['packages/*'])
    expect(existsSync(join(root, 'packages', '.gitkeep'))).toBe(true)
    // and: the migration commit tracks both files
    const filesInCommit = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(filesInCommit).toEqual(['package.json', 'packages/.gitkeep'])
  })

  test('migration is idempotent: a second start on the migrated folder does not create another commit', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJsonPreMigration(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // first start: migrates
    const first = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })
    expect(first.ok).toBe(true)
    const headAfterFirst = await runGit(root, ['rev-parse', 'HEAD'])

    // second start: no-op
    const second = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })
    expect(second.ok).toBe(true)
    const headAfterSecond = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfterSecond).toBe(headAfterFirst)
  })

  // Mutation-check anchor (AGENTS.md §3): commenting out the
  // `await migrateAndCommitConfig(cwd)` call in start() MUST cause this test
  // to fail. typeclaw.json is in git's "tracked" category (unlike Dockerfile),
  // so a silent disk rewrite without a commit produces invisible drift the
  // moment any other tool touches the repo. The fix in this PR adds the
  // commit alongside the existing .gitignore / package.json commits.
  test('start auto-commits the typeclaw.json seeded GitHub event allowlist migration', async () => {
    // given: an agent folder with the seeded channels.github.eventAllowlist
    // already committed. Current config migration strips it so the channel
    // re-tracks the shipped default.
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(
      join(root, 'typeclaw.json'),
      `${JSON.stringify(
        {
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
        },
        null,
        2,
      )}\n`,
    )
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'typeclaw.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs against the migratable folder
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: the migration landed in git as a dedicated commit (the
    // mutation-killer assertion — without the wiring this list does not
    // contain the migration subject) AND the committed tree matches the
    // on-disk file, so the agent repo is not silently dirty.
    expect(result.ok).toBe(true)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('typeclaw.json: drop seeded channels.github.eventAllowlist')
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const onDisk = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8'))
    expect(onDisk.channels.github).toEqual({ repos: ['acme/widgets'] })
    const tracked = JSON.parse(await runGit(root, ['show', 'HEAD:typeclaw.json']))
    expect(tracked).toEqual(onDisk)
  })

  test('start does not commit typeclaw.json when it is already in canonical shape', async () => {
    // given: typeclaw.json is already canonical
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(
      join(root, 'typeclaw.json'),
      `${JSON.stringify(
        {
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          roles: { member: { match: ['slack:T0123'] } },
        },
        null,
        2,
      )}\n`,
    )
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'typeclaw.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: HEAD did not move
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
  })

  test('auto-commits bun.lock drift on start (e.g. after a typeclaw CLI upgrade rewrote it)', async () => {
    // given: a migrated agent folder where the user already ran `bun install`
    // and bun.lock is now dirty (typical after upgrading the typeclaw CLI)
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1,"workspaces":{}}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    // and: bun.lock now drifts (simulating a post-upgrade rewrite)
    await writeFile(
      join(root, 'bun.lock'),
      '{"lockfileVersion":1,"workspaces":{"":{"dependencies":{"typeclaw":"^0.2.0"}}}}\n',
    )
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update dependencies')
    const filesInCommit = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(filesInCommit).toEqual(['bun.lock'])
  })

  test('calls ensureDeps with the agent folder before docker run', async () => {
    // given: a fresh agent folder
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs with a recording ensureDeps
    const ensureCalls: string[] = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (dir) => {
        ensureCalls.push(dir)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then: ensureDeps received the agent folder, AND it ran before docker run
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([root])
    const runIndex = calls.findIndex((c) => c.args[0] === 'run')
    expect(runIndex).toBeGreaterThanOrEqual(0)
  })

  test('aborts start (no docker run) when ensureDeps reports failure', async () => {
    // given: ensureDeps reports drift it could not resolve (e.g. bun install failed)
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async () => ({ ok: false, reason: 'lockfile permission denied' }),
      ensureModels: noEnsureModels,
      provisionGithubCliStore: noGithubCliProvision,
      autoUpgrade: noAutoUpgrade,
    })

    // then: start returned failure carrying the upstream reason
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('lockfile permission denied')
    // and: no docker run ever happened (bind-mounted node_modules would be broken)
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })

  test('forceBuild + file: typeclaw dep -> ensureDeps called with force=true', async () => {
    // given: agent declares typeclaw via file: (the dev-mode case PR #243
    // dogfooding wedged on)
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'file:../../workspace/typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: --build is passed
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then: ensureDeps was forced to bust bun's file-dep cache
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: true }])
  })

  test('forceBuild + link: typeclaw dep -> ensureDeps called with force=true', async () => {
    // given: agent declares typeclaw via link: (the other dev-mode shape)
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'link:../../workspace/typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: true }])
  })

  test('managed plugin version bump in typeclaw.json -> ensureDeps forced even without --build', async () => {
    // given: package.json already has the plugin installed at an older pinned
    // version, and typeclaw.json bumps it. The drift detector would NOT catch
    // this (the dependency name is still present), so reconcile must force.
    await writeDockerfile(root)
    const pkg = {
      name: basename(root),
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      dependencies: { typeclaw: '^0.3.4', 'typeclaw-plugin-foo': '1.0.0' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.0.0' } },
    }
    await writeFile(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    await mkdir(join(root, 'packages'), { recursive: true })
    await writeFile(join(root, 'packages', '.gitkeep'), '')
    const config = {
      models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
      plugins: ['typeclaw-plugin-foo@2.0.0'],
    }
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs WITHOUT --build
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: true }
      },
      ...bypassVerify,
    })

    // then: reconcile rewrote package.json, so ensureDeps was forced
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: true }])
    const written = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(written.dependencies['typeclaw-plugin-foo']).toBe('2.0.0')
  })

  test('default GWS plugin is reconciled into existing agents without a plugins config entry', async () => {
    await writeDockerfile(root)
    const pkg = {
      name: basename(root),
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      dependencies: { typeclaw: '^0.3.4' },
    }
    await writeFile(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    await mkdir(join(root, 'packages'), { recursive: true })
    await writeFile(join(root, 'packages', '.gitkeep'), '')
    await writeTypeclawConfig(root)
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: true }
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: true }])
    const written = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      typeclaw?: { managedPlugins?: Record<string, string> }
    }
    expect(written.dependencies['typeclaw-gws-multi-account']).toBe('^0.3.4')
    expect(written.typeclaw?.managedPlugins?.['typeclaw-gws-multi-account']).toBe('^0.3.4')
  })

  test('explicit GWS plugin config overrides the bundled default version', async () => {
    await writeDockerfile(root)
    const pkg = {
      name: basename(root),
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      dependencies: { typeclaw: '^0.3.4' },
    }
    await writeFile(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    await mkdir(join(root, 'packages'), { recursive: true })
    await writeFile(join(root, 'packages', '.gitkeep'), '')
    const config = {
      models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
      plugins: ['typeclaw-gws-multi-account@0.3.5'],
    }
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: true }
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: true }])
    const written = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      typeclaw?: { managedPlugins?: Record<string, string> }
    }
    expect(written.dependencies['typeclaw-gws-multi-account']).toBe('0.3.5')
    expect(written.typeclaw?.managedPlugins?.['typeclaw-gws-multi-account']).toBe('0.3.5')
  })

  test('managed plugin removal from typeclaw.json -> ensureDeps forced even without --build', async () => {
    // given: a managed plugin is installed but no longer listed in typeclaw.json
    await writeDockerfile(root)
    const pkg = {
      name: basename(root),
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      dependencies: { typeclaw: '^0.3.4', 'typeclaw-plugin-foo': '1.0.0' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.0.0' } },
    }
    await writeFile(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    await mkdir(join(root, 'packages'), { recursive: true })
    await writeFile(join(root, 'packages', '.gitkeep'), '')
    const config = {
      models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
      plugins: [],
    }
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: true }
      },
      ...bypassVerify,
    })

    // then: the prune rewrote package.json, so ensureDeps was forced
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: true }])
    const written = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(written.dependencies['typeclaw-plugin-foo']).toBeUndefined()
  })

  test('forceBuild + registry typeclaw dep -> ensureDeps called with force=false', async () => {
    // given: agent is on a published registry version (the normal user case);
    // the force-reinstall would be expensive AND meaningless because bun's
    // registry-spec install path is already cache-correct
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.3.4' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: --build is passed
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: no force — registry users skip the expensive path
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: false }])
  })

  test('file: typeclaw dep WITHOUT forceBuild -> ensureDeps called with force=false', async () => {
    // given: a dev-mode agent BUT --build was not passed (a routine
    // `typeclaw start` after stop). Force-reinstall would impose a ~30s
    // tax on every restart for no benefit; only --build implies "rebuild
    // everything, bust the cache".
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'file:../../workspace/typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: false,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: false }])
  })

  test('forceBuild + missing package.json -> ensureDeps called with force=false (no crash)', async () => {
    // given: a malformed agent folder with no package.json (defensive case).
    // The gate must degrade to "no force" rather than crash — the underlying
    // ensureDeps will still surface the missing-deps failure downstream.
    await writeDockerfile(root)
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then: no crash, no force
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: false }])
  })

  test('auto-commits package.json and bun.lock atomically when both drift', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    // and: both files drift (e.g., user manually bumped typeclaw and re-ran bun install)
    await writePackageJson(root, { typeclaw: '^0.2.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1,"deps":"new"}\n')
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update dependencies')
    // and: a single atomic commit covers both files (not two separate commits)
    const filesInCommit = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(filesInCommit).toEqual(['bun.lock', 'package.json'])
  })

  test('does not commit dependency files when they are clean', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
  })

  test('skips dependency auto-commit silently when the agent folder is not a git repo', async () => {
    // given: a non-git agent folder with drifted bun.lock
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1,"deps":"new"}\n')
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  test('separates the workspaces migration commit from the dependency drift commit when both apply', async () => {
    // given: a pre-migration agent folder (no `workspaces` field) with a bun.lock that
    // also drifted independently
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJsonPreMigration(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    // and: bun.lock drifts (user upgraded typeclaw, re-ran bun install)
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1,"deps":"new"}\n')
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // then: two distinct commits exist with the right messages and file scopes
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects[0]).toBe('Update dependencies')
    expect(subjects[1]).toBe('Enable bun workspaces (packages/*)')
    const headFiles = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(headFiles).toEqual(['bun.lock'])
    const prevFiles = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD~1'])).split('\n').sort()
    expect(prevFiles).toEqual(['package.json', 'packages/.gitkeep'])
  })

  test('can register through the current hostd without drift respawn during daemon-owned restart', async () => {
    const previousHome = process.env.TYPECLAW_HOME
    const home = await mkdtemp(join(tmpdir(), 'typeclaw-current-hostd-'))
    let daemon: Daemon | null = null
    try {
      process.env.TYPECLAW_HOME = home
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root)
      daemon = await startDaemon({ version: 'old-hostd-version', gcIntervalMs: 1_000_000 })
      const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        cliEntry: '/nonexistent/newer-cli.ts',
        reuseCurrentHostDaemon: true,
        ensureDeps: noEnsureDeps,
        ...bypassVerify,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.hostd.state).toBe('registered')
      expect(daemon.registered()).toContain(basename(root))
    } finally {
      if (daemon) await daemon.stop().catch(() => {})
      if (previousHome === undefined) delete process.env.TYPECLAW_HOME
      else process.env.TYPECLAW_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test.each(['build', 'models'] as const)(
    'refreshes hostd only after build and model provisioning when %s finishes first',
    async (firstToFinish) => {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root)
      const docker = fakeDockerExec({ imageExists: false, container: { exists: false } })
      const buildGate = Promise.withResolvers<void>()
      const buildStarted = Promise.withResolvers<void>()
      const modelsGate = Promise.withResolvers<void>()
      const buildFinished = Promise.withResolvers<void>()
      const modelsStarted = Promise.withResolvers<void>()
      const initialRegistration = Promise.withResolvers<void>()
      const modelsFinished = Promise.withResolvers<void>()
      const events: string[] = []
      const registrations: HostDaemonRegisterPayload[] = []
      const exec: DockerExec = async (args, options) => {
        if (isBuildCall(args)) {
          events.push('build-started')
          buildStarted.resolve()
          await buildGate.promise
          events.push('build-finished')
          buildFinished.resolve()
        }
        if (args[0] === 'run') events.push('docker-run')
        return await docker.exec(args, options)
      }

      const startPromise = start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        cliEntry: '/placeholder/cli.ts',
        reuseCurrentHostDaemon: true,
        currentHostDaemon: {
          httpPort: 49999,
          register: async (payload) => {
            registrations.push(payload)
            events.push(registrations.length === 1 ? 'registration-before-work' : 'registration-at-launch')
            if (registrations.length === 1) initialRegistration.resolve()
            return { ok: true }
          },
          deregister: async () => {},
        },
        ensureDeps: noEnsureDeps,
        ensureModels: async () => {
          events.push('models-started')
          modelsStarted.resolve()
          await modelsGate.promise
          events.push('models-ready')
          modelsFinished.resolve()
        },
        verifyRunning: async () => ({ ok: true }),
        archiveLogs: noArchiveLogs,
        provisionGithubCliStore: noGithubCliProvision,
        autoUpgrade: noAutoUpgrade,
      })

      await Promise.all([buildStarted.promise, modelsStarted.promise, initialRegistration.promise])
      expect(registrations).toHaveLength(1)
      const firstGate = firstToFinish === 'build' ? buildGate : modelsGate
      const firstFinished = firstToFinish === 'build' ? buildFinished : modelsFinished
      const secondGate = firstToFinish === 'build' ? modelsGate : buildGate
      firstGate.resolve()
      await firstFinished.promise
      for (let pending = 0; pending < 5; pending += 1) await Promise.resolve()
      expect(registrations).toHaveLength(1)

      secondGate.resolve()
      const result = await startPromise
      expect(result.ok).toBe(true)
      const launchRefresh = events.indexOf('registration-at-launch')
      expect(launchRefresh).toBeGreaterThan(events.indexOf('build-finished'))
      expect(launchRefresh).toBeGreaterThan(events.indexOf('models-ready'))
      expect(events.slice(launchRefresh)).toEqual(['registration-at-launch', 'docker-run'])
      expect(registrations).toHaveLength(2)
    },
  )

  test('keeps the daemon-clamped memory limit across the hostd-refresh replan', async () => {
    // given a 4 GiB Docker VM, which cannot afford the 6 GiB default and so
    // clamps to 2 GiB after the 2 GiB host headroom
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: false },
      daemonMemTotalBytes: 4 * 1024 * 1024 * 1024,
    })

    // when start replans at the run boundary to refresh hostd tokens
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      cliEntry: '/placeholder/cli.ts',
      reuseCurrentHostDaemon: true,
      currentHostDaemon: {
        httpPort: 49999,
        register: async () => ({ ok: true }),
        deregister: async () => {},
      },
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then the container actually launches with the clamp, not the
    // unconditional default the replan would otherwise resolve
    expect(result.ok).toBe(true)
    const runCall = calls.filter((c) => c.args[0] === 'run').at(-1)
    const expected = 2 * 1024 * 1024 * 1024
    expect(runCall?.args).toContain(`--memory=${expected}`)
    expect(runCall?.args).toContain(`--memory-swap=${expected}`)
  })

  test('keeps the daemon-clamped memory limit across the port-conflict retry replan', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)
    const base = fakeDockerExec({
      imageExists: true,
      container: { exists: false },
      daemonMemTotalBytes: 4 * 1024 * 1024 * 1024,
    })
    const calls = base.calls
    let runs = 0
    // given the first docker run losing a TOCTOU race for the host port
    const exec: DockerExec = async (args, options) => {
      if (args[0] === 'run') {
        runs += 1
        if (runs === 1) {
          // Record the attempt without letting the fake create a container:
          // a live corpse would make cleanup refuse the retry outright.
          calls.push({ args, dockerfileSnapshot: null, env: options?.env })
          return {
            exitCode: 125,
            stdout: '',
            stderr:
              'docker: Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:8973 failed: port is already allocated.',
          }
        }
      }
      return await base.exec(args, options)
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then the retry launches with the clamp too
    expect(result.ok).toBe(true)
    expect(runs).toBeGreaterThan(1)
    const runCall = calls.filter((c) => c.args[0] === 'run').at(-1)
    const expected = 2 * 1024 * 1024 * 1024
    expect(runCall?.args).toContain(`--memory=${expected}`)
    expect(runCall?.args).toContain(`--memory-swap=${expected}`)
  })

  test('uses only replacement hostd tokens in the final docker run', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const registered: HostDaemonRegisterPayload[] = []

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      cliEntry: '/placeholder/cli.ts',
      reuseCurrentHostDaemon: true,
      currentHostDaemon: {
        httpPort: 49999,
        register: async (payload) => {
          registered.push(payload)
          return { ok: true }
        },
        deregister: async () => {},
      },
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(registered).toHaveLength(2)
    const [staleRegistration, launchRegistration] = registered
    expect(launchRegistration).toBeDefined()
    expect(result.plan.runArgs).toContain(`TYPECLAW_HOSTD_TOKEN=${launchRegistration!.restartToken}`)
    expect(result.plan.runArgs).toContain(`TYPECLAW_HOSTD_BROKER_TOKEN=${launchRegistration!.brokerToken}`)
    expect(result.plan.runArgs).not.toContain(`TYPECLAW_HOSTD_TOKEN=${staleRegistration!.restartToken}`)
    expect(result.plan.runArgs).not.toContain(`TYPECLAW_HOSTD_BROKER_TOKEN=${staleRegistration!.brokerToken}`)
  })

  test('aborts before docker run and rolls back the initial registration when launch refresh setup fails', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)
    const docker = fakeDockerExec({ imageExists: false, container: { exists: false } })
    const exec: DockerExec = async (args, options) => {
      // Corrupt config only after the initial plan reaches its build step, so
      // this targets launch-boundary replanning rather than initial setup.
      if (isBuildCall(args)) await writeFile(join(root, 'typeclaw.json'), '{ not-json')
      return await docker.exec(args, options)
    }
    const deregistrations: string[] = []
    let registrations = 0

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      cliEntry: '/placeholder/cli.ts',
      reuseCurrentHostDaemon: true,
      currentHostDaemon: {
        httpPort: 49999,
        register: async () => {
          registrations += 1
          return { ok: true }
        },
        deregister: async (containerName) => {
          deregistrations.push(containerName)
        },
      },
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ensureModels: noEnsureModels,
      verifyRunning: async () => ({ ok: true }),
      archiveLogs: noArchiveLogs,
      provisionGithubCliStore: noGithubCliProvision,
    })

    expect(result.ok).toBe(false)
    expect(registrations).toBe(1)
    expect(deregistrations).toEqual([basename(root)])
    expect(docker.calls.some((call) => call.args[0] === 'run')).toBe(false)
  })

  test('launches without hostd control when the launch refresh is unavailable', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    let registrations = 0
    const deregistrations: string[] = []

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      cliEntry: '/placeholder/cli.ts',
      reuseCurrentHostDaemon: true,
      currentHostDaemon: {
        httpPort: 49999,
        register: async () => {
          registrations += 1
          return registrations === 1 ? { ok: true } : { ok: false, reason: 'registration-unavailable' }
        },
        deregister: async (containerName) => {
          deregistrations.push(containerName)
        },
      },
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hostd).toEqual({ state: 'unavailable', reason: 'registration-unavailable' })
    expect(calls.find((call) => call.args[0] === 'run')).toBeDefined()
    expect(result.plan.runArgs.some((arg) => arg.includes('TYPECLAW_HOSTD_'))).toBe(false)
    expect(deregistrations).toEqual([basename(root)])
  })

  test('launches without hostd control when the in-process registrar throws at the launch boundary', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    let registrations = 0
    const deregistrations: string[] = []

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      cliEntry: '/placeholder/cli.ts',
      reuseCurrentHostDaemon: true,
      currentHostDaemon: {
        httpPort: 49999,
        register: async () => {
          registrations += 1
          if (registrations === 1) return { ok: true }
          throw new Error('registration-unavailable')
        },
        deregister: async (containerName) => {
          deregistrations.push(containerName)
        },
      },
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hostd).toEqual({ state: 'unavailable', reason: 'registration-unavailable' })
    expect(calls.find((call) => call.args[0] === 'run')).toBeDefined()
    expect(result.plan.runArgs.some((arg) => arg.includes('TYPECLAW_HOSTD_'))).toBe(false)
    expect(deregistrations).toEqual([basename(root)])
  })

  test('forceBuild=false skips build entirely when image already exists', async () => {
    // given: a Dockerfile already matching the current template, so refreshDockerfile is a no-op
    await writeFile(join(root, 'Dockerfile'), buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(calls.find((c) => isBuildCall(c.args))).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
  })

  test('auto-rebuilds when the Dockerfile template differs from disk, even without --build', async () => {
    // given: a stale Dockerfile and an image that already exists from a prior build
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# old template\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs WITHOUT forceBuild
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: the build ran against the refreshed Dockerfile, and built=true was reported
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.built).toBe(true)
    const buildCall = calls.find((c) => isBuildCall(c.args))
    expect(buildCall).toBeDefined()
    expect(buildCall!.dockerfileSnapshot).toBe(buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    expect(buildCall!.dockerfileSnapshot).not.toContain('FROM stale')
  })

  test('skips build when the on-disk Dockerfile already matches the template and the image exists', async () => {
    // given: a Dockerfile already at the rendered-template value and an existing image
    await writeFile(join(root, 'Dockerfile'), buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: no rebuild — the change-driven auto-rebuild path stays inert when nothing drifted
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.built).toBe(false)
    expect(calls.find((c) => isBuildCall(c.args))).toBeUndefined()
  })

  test('is idempotent when a container with the same name is already running', async () => {
    // given: an already-running container, an existing image, and a stale
    // Dockerfile on disk so we can prove the no-op path skips the refresh
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const legacyConfigDir = join(root, 'workspace', '.agent-messenger')
    await mkdir(legacyConfigDir, { recursive: true })
    await writeFile(join(legacyConfigDir, 'session.json'), 'live-container-session')
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: true },
    })
    let githubCliProvisionCalls = 0

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      provisionGithubCliStore: () => {
        githubCliProvisionCalls += 1
        return { ok: true }
      },
    })

    // then: success with alreadyRunning=true, no docker side effects, no template churn
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alreadyRunning).toBe(true)
    expect(result.built).toBe(false)
    expect(result.hostPort).toBe(8973)
    expect(result.containerId).toBe('fake-running-id-123456')
    expect(githubCliProvisionCalls).toBe(0)
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'rm')).toBeUndefined()
    expect(calls.find((c) => isBuildCall(c.args))).toBeUndefined()
    const onDisk = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(onDisk).toBe('FROM stale\n')
    expect(await readFile(join(legacyConfigDir, 'session.json'), 'utf8')).toBe('live-container-session')
    expect(existsSync(join(root, 'workspace', '.config', 'agent-messenger'))).toBe(false)
  })

  test('bounds gc/repack memory even when the container is already running', async () => {
    // given: a real initialized repo, an already-running container, and a stale
    // Dockerfile so we can prove the git keys land while template/docker ops no-op
    await gitInit(root)
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: true },
    })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: the memory bounds are written to the running agent's repo
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alreadyRunning).toBe(true)
    expect(await runGit(root, ['config', '--local', 'gc.auto'])).toBe('0')
    expect(await runGit(root, ['config', '--local', 'pack.windowMemory'])).toBe('64m')
    expect(await runGit(root, ['config', '--local', 'core.bigFileThreshold'])).toBe('10m')
    // and: docker/template operations stayed no-ops on the already-running path
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
    expect(calls.find((c) => isBuildCall(c.args))).toBeUndefined()
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toBe('FROM stale\n')
  })

  test('reports an error when an already-running container has no published host port', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect' && args.includes('{{.Id}}|{{.State.Running}}')) {
        return { exitCode: 0, stdout: `${'a'.repeat(64)}|true\n`, stderr: '' }
      }
      if (args[0] === 'inspect' && args.includes('{{.Id}}')) {
        return { exitCode: 0, stdout: 'id\n', stderr: '' }
      }
      if (args[0] === 'port') {
        return { exitCode: 1, stdout: '', stderr: 'Error: No port mapping' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/published host port could not be resolved/)
  })

  test('removes a stale stopped container with the same name and proceeds to docker run', async () => {
    // given: a crash or failed archival/removal left a stopped container holding the name
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { logs: { retentionDays: 30 } })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false },
    })

    // when
    const orderedArchive = async ({ containerId, retentionDays }: { containerId: string; retentionDays?: number }) => {
      calls.push({ args: ['archive', containerId, String(retentionDays)], dockerfileSnapshot: null })
      return { ok: true as const, status: 'archived' as const, path: '/archive.log' }
    }
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs: orderedArchive,
    })

    // then: rm was issued before run, and run proceeded
    expect(result.ok).toBe(true)
    const archiveIdx = calls.findIndex((c) => c.args[0] === 'archive')
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const runIdx = calls.findIndex((c) => c.args[0] === 'run')
    expect(archiveIdx).toBeGreaterThanOrEqual(0)
    expect(calls[archiveIdx]?.args).toEqual(['archive', 'a'.repeat(64), '30'])
    expect(rmIdx).toBeGreaterThan(archiveIdx)
    expect(runIdx).toBeGreaterThan(rmIdx)
    expect(calls[rmIdx]?.args.at(-1)).toBe('a'.repeat(64))
    expect(calls[rmIdx]?.args).toEqual(['rm', 'a'.repeat(64)])
  })

  test('start reports a stale OOM-killed runtime only after archiving its logs', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const fake = fakeDockerExec({ imageExists: true, container: { exists: true, running: false } })
    const order: string[] = []
    const exec: DockerExec = async (args, options) => {
      if (args[0] === 'inspect' && args.some((arg) => arg.includes('{{.State.OOMKilled}}'))) {
        return {
          exitCode: 0,
          stdout: `${'a'.repeat(64)}|false|true|137|6442450944|2026-09-29T04:58:43Z\n`,
          stderr: '',
        }
      }
      if (args[0] === 'rm') order.push('rm')
      return fake.exec(args, options)
    }
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs: async () => {
        order.push('archive')
        return { ok: true, status: 'archived', path: '/archive.log' }
      },
      onWarning: (warning) => {
        expect(warning).toContain(
          'agent runtime was SIGKILLed (137) and the container recorded an OOM kill during this run (likely container memory limit 6144 MiB)',
        )
        order.push('warning')
      },
    })
    expect(result.ok).toBe(true)
    expect(order).toEqual(['archive', 'warning', 'rm'])
  })

  test('warns, removes a stale container with unavailable logs, and launches its replacement', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const fake = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false },
    })
    const { calls } = fake
    const exec: DockerExec = async (args, options) => {
      if (args[0] === 'inspect' && args.some((arg) => arg.includes('{{.State.OOMKilled}}'))) {
        return {
          exitCode: 0,
          stdout: `${'a'.repeat(64)}|false|true|137|6442450944|2026-09-29T04:58:43Z\n`,
          stderr: '',
        }
      }
      return fake.exec(args, options)
    }
    const warnings: string[] = []

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs: async () => ({ ok: false, kind: 'unavailable', reason: 'terminal Docker state' }),
    })

    expect(result.ok).toBe(true)
    expect(calls).toContainEqual(expect.objectContaining({ args: ['rm', 'a'.repeat(64)] }))
    expect(calls.some((call) => call.args[0] === 'run')).toBe(true)
    expect(warnings).toEqual([
      expect.stringContaining('no new snapshot was captured'),
      expect.stringContaining(
        'agent runtime was SIGKILLed (137) and the container recorded an OOM kill during this run (likely container memory limit 6144 MiB)',
      ),
    ])
  })

  test('routes the unavailable-logs warning to onWarning on the streaming CLI default', async () => {
    // given: the exact shape `typeclaw start`/`restart` use — streamOutput left
    // at its true default AND a collector supplied, so the CLI can print the
    // warning after its spinner settles instead of under a live one.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: true, running: false } })
    const warnings: string[] = []
    const stderrWrites: string[] = []
    const write = spyOn(process.stderr, 'write')
    write.mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk))
      return true
    })

    try {
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        onWarning: (warning) => warnings.push(warning),
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: noAutoUpgrade,
        ...bypassVerify,
        archiveLogs: async () => ({ ok: false, kind: 'unavailable', reason: 'terminal Docker state' }),
      })

      expect(result.ok).toBe(true)
      expect(warnings).toEqual([expect.stringContaining('no new snapshot was captured')])
      expect(stderrWrites.some((text) => text.includes('no new snapshot was captured'))).toBe(false)
    } finally {
      write.mockRestore()
    }
  })

  test('writes the unavailable-logs warning to stderr when no collector is supplied', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: true, running: false } })
    const stderrWrites: string[] = []
    const write = spyOn(process.stderr, 'write')
    write.mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk))
      return true
    })

    try {
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: noAutoUpgrade,
        ...bypassVerify,
        archiveLogs: async () => ({ ok: false, kind: 'unavailable', reason: 'terminal Docker state' }),
      })

      expect(result.ok).toBe(true)
      expect(stderrWrites.some((text) => text.includes('no new snapshot was captured'))).toBe(true)
    } finally {
      write.mockRestore()
    }
  })

  test('preserves a stale stopped container when its logs cannot be archived', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs: async () => ({ ok: false, kind: 'failed', reason: 'disk full' }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/archive.*disk full.*preserving/i)
    expect(calls.find((call) => call.args[0] === 'rm')).toBeUndefined()
    expect(calls.find((call) => call.args[0] === 'run')).toBeUndefined()
  })

  test('preserves a stale container that becomes running on the immediate re-probe', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const id = 'a'.repeat(64)
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false },
      containerInspectOutputs: [`${id}|false\n`, `${id}|true\n`],
    })
    let archived = false

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs: async () => {
        archived = true
        return { ok: true, status: 'archived', path: '/archive.log' }
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/became running.*refusing to migrate/i)
    expect(archived).toBe(false)
    expect(calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'run')).toBe(false)
  })

  test('uses non-force rm so Docker preserves a stale container that starts after archival', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false, rmFindsRunning: true },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    const rmCall = calls.find((call) => call.args[0] === 'rm')
    expect(rmCall?.args).toEqual(['rm', 'a'.repeat(64)])
    expect(calls.find((call) => call.args[0] === 'run')).toBeUndefined()
  })

  test('captures fresh logs on later stop after stale cleanup archived but non-force rm refused', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const fake = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false, rmFindsRunning: true },
    })
    const events: string[] = []
    const exec: DockerExec = async (args, options) => {
      events.push(args[0] ?? '')
      return await fake.exec(args, options)
    }
    let captures = 0
    const archiveLogs = async () => {
      captures += 1
      events.push('archive')
      return { ok: true as const, status: 'archived' as const, path: `/archive-${captures}.log` }
    }

    const startResult = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs,
    })
    expect(startResult.ok).toBe(false)

    const stopResult = await stop({ cwd: root, exec, archiveLogs })

    expect(stopResult.ok).toBe(true)
    expect(captures).toBe(2)
    const stopIndex = events.lastIndexOf('stop')
    const finalArchiveIndex = events.lastIndexOf('archive')
    const finalRemoveIndex = events.lastIndexOf('rm')
    expect(finalArchiveIndex).toBeGreaterThan(stopIndex)
    expect(finalRemoveIndex).toBeGreaterThan(finalArchiveIndex)
  })

  test.each([`short|false\n`, `${'a'.repeat(64)}|unknown\n`, `${'A'.repeat(64)}|false\n`])(
    'preserves without archive/removal when initial inspect output is malformed: %s',
    async (inspectOutput) => {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      const { exec, calls } = fakeDockerExec({
        imageExists: true,
        container: { exists: true, running: false },
        containerInspectOutputs: [inspectOutput],
      })
      let archived = false

      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: noAutoUpgrade,
        ...bypassVerify,
        archiveLogs: async () => {
          archived = true
          return { ok: true, status: 'archived', path: '/archive.log' }
        },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/malformed.*preserving/i)
      expect(archived).toBe(false)
      expect(calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'run')).toBe(false)
    },
  )

  test('preserves without archive/removal when the immediate stale re-probe is malformed', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const id = 'a'.repeat(64)
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false },
      containerInspectOutputs: [`${id}|false\n`, 'malformed\n'],
    })
    let archived = false

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs: async () => {
        archived = true
        return { ok: true, status: 'archived', path: '/archive.log' }
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/malformed.*preserving/i)
    expect(archived).toBe(false)
    expect(calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'run')).toBe(false)
  })

  test('tolerates "no such container" from docker rm (auto-removal finished between inspect and rm)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false, rmFails: true, rmStderr: 'Error: No such container: x' },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
  })

  test('waits for Docker to finish the in-progress removal before docker run, avoiding a name conflict', async () => {
    // given: a stopped corpse held by an in-progress async removal. The
    // preflight rm reports "removal of container x is already in progress",
    // and inspect keeps reporting the container as still present for two
    // more probes before the drain completes.
    //
    // This test ALSO depends on the fake's docker-run path returning the
    // real name-conflict error string when the container is still present
    // — so if start() forgot to wait, docker run would fail with exactly
    // the user-visible bug ("Conflict. The container name is already in
    // use") and the test would catch it.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: {
        exists: true,
        running: false,
        rmFails: true,
        rmStderr: 'Error response from daemon: removal of container x is already in progress',
        drainAfterInspectCalls: 2,
      },
    })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: start succeeded, docker run ran AGAINST A GONE CONTAINER, and
    // we made at least one inspect call after rm to verify removal
    expect(result.ok).toBe(true)
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const runIdx = calls.findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThanOrEqual(0)
    expect(runIdx).toBeGreaterThan(rmIdx)
    const inspectsBetween = calls.slice(rmIdx + 1, runIdx).filter((c) => c.args[0] === 'inspect')
    expect(inspectsBetween.length).toBeGreaterThanOrEqual(1)
  })

  test('waits for Docker to finish removal when rm returns exit 0 but container is still draining (OrbStack under load)', async () => {
    // given: a stopped corpse. The preflight `docker rm` returns exit 0
    // — i.e. Docker acknowledged the request — but the daemon has not yet
    // finished draining. `inspect` still sees the container for two more
    // probes after rm. This is the canonical failure mode behind the
    // user-visible `typeclaw compose restart` bug: stop()'s rm returns 0,
    // start()'s preflight sees the corpse, start()'s rm returns 0, but
    // docker run --name fires before the drain completes and hits
    // "Conflict. The container name is already in use by container <ID>".
    //
    // The fake's docker-run path returns the real name-conflict error
    // when the container is still present, so without the waitForRemoval
    // on the exit-0 path, this test fails with exactly the user-visible
    // error message.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: {
        exists: true,
        running: false,
        drainAfterInspectCalls: 2,
      },
    })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: start succeeded (docker run did not race the drain), and we
    // made at least one inspect call between rm and run to verify removal
    expect(result.ok).toBe(true)
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const runIdx = calls.findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThanOrEqual(0)
    expect(runIdx).toBeGreaterThan(rmIdx)
    const inspectsBetween = calls.slice(rmIdx + 1, runIdx).filter((c) => c.args[0] === 'inspect')
    expect(inspectsBetween.length).toBeGreaterThanOrEqual(1)
  })

  test('reports a clear error when docker rm fails for a non-recoverable reason', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false, rmFails: true, rmStderr: 'permission denied', status: 'dead' },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/could not be safely inspected or removed/)
      expect(result.reason).toMatch(/marked this container dead.*busy mount or restart Docker/)
    }
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
    expect(calls.some((call) => call.args.includes('-f') || call.args.includes('--force'))).toBe(false)
  })

  test('retries docker run after removing the non-running corpse that holds the name', async () => {
    // given: the preflight `docker inspect` says the name is free, so
    // start() proceeds to `docker run`. The first run fails with the
    // user-visible name-conflict error referencing a concrete corpse ID —
    // exactly the failure mode behind the reported `typeclaw compose
    // restart` bug. Once the retry path removes the corpse, the
    // next `docker run --name <same>` succeeds.
    //
    // Mutation check: revert the cleanupRunCorpse call inside
    // execRunWithConflictRetry to a passive setTimeout and this test fails
    // — the fake's `docker run` keeps returning conflict until something
    // flips containerExists to false, and only the rm path does that.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    let rmAttempts = 0
    // Models the moby#51758 / moby#8294 bug: docker create succeeds and
    // reserves the name, but `docker run -p <busy>:...` later fails with
    // port-allocated and leaves the corpse in `docker ps -a`. In this test
    // start()'s preflight inspect runs BEFORE the corpse is created, so it
    // sees "no such container" and skips the preflight rm — exactly the
    // race the production fix must handle inside execRunWithConflictRetry.
    let corpseExists = false
    let rmTarget: string | undefined
    const corpseId = 'e8d39ae0eb16428c58b143b3a8ac60267ae87ce4fc0f2859022183b512287209'
    const conflictStderr = `docker: Error response from daemon: Conflict. The container name "/anderson" is already in use by container "${corpseId}". You have to remove (or rename) that container to be able to reuse that name.`
    const calls: { args: string[] }[] = []
    const exec: DockerExec = async (args) => {
      calls.push({ args })
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        if (!corpseExists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
        // cleanupRunCorpse asks for `{{.Id}}|{{.State.Running}}`; removal-drain
        // probes only ask for State.Running. Emit the exact format each strict
        // production parser expects.
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: `${corpseId}|false\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: 'false\n', stderr: '' }
      }
      if (args[0] === 'rm') {
        rmAttempts++
        rmTarget = args[args.length - 1]
        corpseExists = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) {
          // Simulate Docker creating the named container before failing
          // the actual run; surface the conflict against that corpse.
          corpseExists = true
          return { exitCode: 125, stdout: '', stderr: conflictStderr }
        }
        if (corpseExists) return { exitCode: 125, stdout: '', stderr: conflictStderr }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(runAttempts).toBe(2)
    expect(rmAttempts).toBe(1)
    // The rm MUST target the corpse ID parsed from the inspect probe,
    // NOT the container name. Targeting by name is the TOCTOU race where
    // a same-name peer container spun up between probe and rm gets killed.
    expect(rmTarget).toBe(corpseId)
    const firstRunIdx = calls.findIndex((c) => c.args[0] === 'run')
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const lastRunIdx = calls.length - 1 - [...calls].reverse().findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThan(firstRunIdx)
    expect(rmIdx).toBeLessThan(lastRunIdx)
    expect(calls[rmIdx]?.args).toEqual(['rm', corpseId])
  })

  test('does not remove or retry a failed-run corpse when archival fails', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const corpseId = 'c'.repeat(64)
    let inspectCalls = 0
    let runCalls = 0
    let rmCalls = 0
    const conflictStderr =
      `docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "${corpseId}". ` +
      'You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        inspectCalls++
        if (inspectCalls <= 2) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
        return { exitCode: 0, stdout: `${corpseId}|false\n`, stderr: '' }
      }
      if (args[0] === 'run') {
        runCalls++
        return { exitCode: 125, stdout: '', stderr: conflictStderr }
      }
      if (args[0] === 'rm') rmCalls++
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs: async () => ({ ok: false, kind: 'failed', reason: 'read-only filesystem' }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/logs could not be archived.*read-only filesystem.*preserving/i)
    expect(rmCalls).toBe(0)
    expect(runCalls).toBe(1)
  })

  test('retries a docker run conflict when the failed-run corpse has permanently unavailable logs', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const corpseId = 'c'.repeat(64)
    let inspectCalls = 0
    let runCalls = 0
    let corpseExists = false
    const warnings: string[] = []
    const conflictStderr =
      `docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "${corpseId}". ` +
      'You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        inspectCalls++
        if (inspectCalls <= 2 || !corpseExists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: `${corpseId}|false\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: 'false\n', stderr: '' }
      }
      if (args[0] === 'rm') {
        corpseExists = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runCalls++
        if (runCalls === 1) {
          corpseExists = true
          return { exitCode: 125, stdout: '', stderr: conflictStderr }
        }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      streamOutput: false,
      onWarning: (warning) => warnings.push(warning),
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
      archiveLogs: async () => ({ ok: false, kind: 'unavailable', reason: 'terminal Docker state' }),
    })

    expect(result.ok).toBe(true)
    expect(runCalls).toBe(2)
    expect(warnings).toEqual([expect.stringContaining('no new snapshot was captured')])
  })

  test('does NOT remove a RUNNING same-name container when docker run reports conflict', async () => {
    // given: a docker run hits a name conflict but the named container is
    // currently RUNNING. The destructive retry path MUST refuse to kill a
    // live container — that would either murder a concurrent legitimate
    // start of the same name OR a foreign container the user wants alive.
    // start() must surface the conflict error untouched.
    //
    // Mutation check: drop the running-check from cleanupRunCorpse and
    // this test fails — rmAttempts becomes 1 and the live container is
    // killed.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    let rmAttempts = 0
    let probeAttempts = 0
    const liveId = 'd'.repeat(64)
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        probeAttempts++
        // Both start preflight probes report gone so we proceed to docker run.
        if (probeAttempts <= 2) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
        // Subsequent inspect (the retry-path corpse probe) reports running=true.
        // cleanupRunCorpse uses `{{.Id}}|{{.State.Running}}`; non-cleanupRunCorpse
        // callers use just State.Running. Emit both formats so either parser works.
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: `${liveId}|true\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: 'true\n', stderr: '' }
      }
      if (args[0] === 'rm') {
        rmAttempts++
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: conflictStderr }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Conflict.*container name.*is already in use/)
    expect(rmAttempts).toBe(0)
    expect(runAttempts).toBe(1)
  })

  test('cleans up the failed-run corpse before retrying with a new port (TOCTOU + port-bind-after-create)', async () => {
    // given: the first `docker run -p 8973:...` fails because another
    // process claimed 8973 between our probe and the run, AND Docker
    // already created the named container record before the port bind
    // failed. The port-TOCTOU retry must remove the corpse before
    // re-running `docker run --name <same>` with the new port, or the
    // retry hits the user-visible Conflict error against its own corpse
    // — exactly the bug `typeclaw compose restart` was hitting.
    //
    // Mutation check: remove the cleanupRunCorpse call in the port-retry
    // branch and this test fails — the second `docker run` returns
    // conflict against the corpse left by the first run.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    let rmAttempts = 0
    let corpseExists = false
    const corpseId = 'e'.repeat(64)
    const calls: { args: string[] }[] = []
    const portStderr = 'docker: Bind for :::8973 failed: port is already allocated'
    const conflictStderr = `docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "${corpseId}". You have to remove (or rename) that container to be able to reuse that name.`
    const exec: DockerExec = async (args) => {
      calls.push({ args })
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        if (!corpseExists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: `${corpseId}|false\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: 'false\n', stderr: '' }
      }
      if (args[0] === 'rm') {
        rmAttempts++
        corpseExists = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) {
          // Docker created the container before failing the port bind.
          corpseExists = true
          return { exitCode: 125, stdout: '', stderr: portStderr }
        }
        if (corpseExists) return { exitCode: 125, stdout: '', stderr: conflictStderr }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const ports = [8973, 49160]
    const allocatePort = async (): Promise<number> => ports.shift() ?? 0

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(runAttempts).toBe(2)
    expect(rmAttempts).toBe(1)
    // The cleanup rm must happen BETWEEN the two docker run calls so the
    // second run sees a free name.
    const firstRunIdx = calls.findIndex((c) => c.args[0] === 'run')
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const lastRunIdx = calls.length - 1 - [...calls].reverse().findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThan(firstRunIdx)
    expect(rmIdx).toBeLessThan(lastRunIdx)
    expect(calls[rmIdx]?.args).toEqual(['rm', corpseId])
    // The retry used the new port.
    const runCalls = calls.filter((c) => c.args[0] === 'run')
    expect(runCalls[0]!.args).toContain('127.0.0.1:8973:8973')
    expect(runCalls[1]!.args).toContain('127.0.0.1:49160:8973')
  })

  test('waits for "removal in progress" to drain during conflict-retry cleanup', async () => {
    // given: docker run reports name conflict; the retry path calls
    // `docker rm` which itself returns "removal of container … is
    // already in progress". The cleanup must call waitForRemoval to
    // confirm the container actually disappears before retrying
    // `docker run`, or the retry races the drain and fails again.
    //
    // Mutation check: revert cleanupRunCorpse to skip waitForRemoval on
    // the "in-progress" rm-stderr path and this test fails — the second
    // docker run fires while inspect still reports the corpse, returning
    // conflict.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let inspectsBeforeRm = 0
    let inspectAfterRm = 0
    let rmReturned = false
    let runAttempts = 0
    const corpseId = 'f'.repeat(64)
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        if (!rmReturned) {
          inspectsBeforeRm++
          // First two inspects are start's preflight probes (name is free);
          // third is cleanupRunCorpse's pre-rm probe AFTER the failed docker run
          // has populated the corpse — it must see the corpse to issue rm.
          if (inspectsBeforeRm <= 2) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
          if (args.includes('{{.Id}}|{{.State.Running}}')) {
            return { exitCode: 0, stdout: `${corpseId}|false\n`, stderr: '' }
          }
          return { exitCode: 0, stdout: 'false\n', stderr: '' }
        }
        inspectAfterRm++
        // Container keeps showing up for 2 post-rm probes, then drains.
        if (inspectAfterRm <= 2) return { exitCode: 0, stdout: 'false\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        rmReturned = true
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Error response from daemon: removal of container x is already in progress',
        }
      }
      if (args[0] === 'run') {
        runAttempts++
        // Until cleanup actually waits for the drain, every retry hits
        // conflict — that's the regression this test guards against.
        if (!rmReturned || inspectAfterRm <= 2) return { exitCode: 125, stdout: '', stderr: conflictStderr }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // Cleanup probed inspect post-rm at least once (waitForRemoval).
    expect(inspectAfterRm).toBeGreaterThanOrEqual(1)
    // docker run must have been retried at least once after the failed
    // initial attempt — otherwise the test never exercised the drain path.
    expect(runAttempts).toBeGreaterThanOrEqual(2)
  })

  test('backs off between conflict retries when cleanup reports gone but the name still conflicts', async () => {
    // given: Docker's name-reservation table is draining independently of
    // `docker inspect`. cleanupRunCorpse's probe returns 'gone' (inspect
    // says the corpse is removed), but the very next `docker run --name`
    // still hits a Conflict because the reservation hasn't released. The
    // production fix's bounded backoff (100/200/400/800/1200ms, cumulative
    // ~2.7s) covers exactly this residual race — without it, rapid-fire
    // retries all happen inside the same drain window and exhaust uselessly.
    //
    // Mutation check: delete the `await setTimeout(backoffMs)` from
    // execRunWithConflictRetry and this test fails — runAttempts hits 4+
    // immediately and result.ok is false because the drain never
    // completes between attempts.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    // Start the drain clock at the FIRST docker-run attempt, not before
    // start(). start()'s setup (config reads, planStart) can itself exceed
    // drainMs on slow filesystems (Windows CI), which would let the very
    // first run land after the window and skip the retry path entirely.
    let drainStart: number | null = null
    const drainMs = 1300
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      // inspect always reports 'gone' — modeling the daemon's split-state:
      // the container record disappears from inspect/ps but the name
      // reservation lingers a bit longer.
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      if (args[0] === 'run') {
        runAttempts++
        drainStart ??= Date.now()
        // Returns conflict until enough wall time has elapsed for the
        // name reservation to drain.
        if (Date.now() - drainStart < drainMs) {
          return { exitCode: 125, stdout: '', stderr: conflictStderr }
        }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // The backoff between retries gives the daemon time to drain. With
    // the bug (no sleep), all four attempts would fire within ms.
    expect(runAttempts).toBeGreaterThanOrEqual(2)
  })

  test('removes the corpse by ID, not by name, to avoid killing a same-name peer (TOCTOU)', async () => {
    // given: cleanupRunCorpse's inspect probe sees a non-running corpse
    // with ID "corpse-A". Between probe and rm, a concurrent peer starts
    // a NEW live container with the same name (ID "live-B"). If our rm
    // targets the name, we'd kill live-B. If our rm targets the probed
    // ID "corpse-A", we remove only the corpse we measured.
    //
    // This test asserts the rm command is invoked with the corpse ID, not
    // the container name. Mutation check: switch rm back to `rm <name>`
    // and this assertion fails directly.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const corpseId = '9'.repeat(64)
    const containerName = basename(root)
    let rmTarget: string | undefined
    let runAttempts = 0
    const conflictStderr = `docker: Error response from daemon: Conflict. The container name "/${containerName}" is already in use by container "${corpseId}". You have to remove (or rename) that container to be able to reuse that name.`
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: `${corpseId}|false\n`, stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        rmTarget = args[args.length - 1]
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) return { exitCode: 125, stdout: '', stderr: conflictStderr }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(rmTarget).toBe(corpseId)
    expect(rmTarget).not.toBe(containerName)
  })

  test('surfaces the docker run name-conflict error when cleanup cannot free the name', async () => {
    // given: Docker keeps returning the name-conflict error AND the
    // cleanup `docker rm` cannot complete — a wedged daemon or a
    // protected container that no amount of cleanup-then-retry will fix.
    // start() must eventually give up and surface the original error so
    // the user can inspect the container or restart Docker instead of
    // bypassing archive-before-remove safety or looping forever.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: conflictStderr }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Conflict.*container name.*is already in use/)
    expect(runAttempts).toBeGreaterThanOrEqual(2)
  })

  test('does NOT retry when docker run fails for a non-conflict reason (e.g. image pull error)', async () => {
    // given: a non-conflict docker run failure. The conflict retry loop
    // must not shadow the existing fast-fail behavior — the user sees the
    // error immediately, exactly once.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: 'docker: Error response from daemon: image not found' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    expect(runAttempts).toBe(1)
    if (!result.ok) expect(result.reason).toMatch(/image not found/)
  })
})

describe('start (port allocation)', () => {
  test('publishes the allocated host port mapped to the fixed container port (8973)', async () => {
    // given: the kernel says the preferred 8973 is taken, so the allocator
    // returns an ephemeral port instead
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const allocatePort = async () => 51234

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: docker run gets `-p 127.0.0.1:<hostPort>:8973`, NOT `-p 8973:8973`
    expect(result.ok).toBe(true)
    const runCall = calls.find((c) => c.args[0] === 'run')
    expect(runCall).toBeDefined()
    expect(runCall!.args).toContain('127.0.0.1:51234:8973')
    expect(runCall!.args).not.toContain('51234:51234')
    if (result.ok) expect(result.hostPort).toBe(51234)
  })

  test('still maps host 8973 to container 8973 when the preferred host port is free', async () => {
    // given: 8973 is free, allocator returns the preferred port unchanged
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    const runCall = calls.find((c) => c.args[0] === 'run')
    expect(runCall!.args).toContain('127.0.0.1:8973:8973')
    if (result.ok) expect(result.hostPort).toBe(8973)
  })

  test('retries with a fresh ephemeral port when docker reports a bind conflict (TOCTOU)', async () => {
    // given: a docker that fails the first run with the canonical
    // "port is already allocated" error, and succeeds on the second
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const calls: { args: string[] }[] = []
    const exec: DockerExec = async (args) => {
      calls.push({ args })
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'docker: Bind for :::8973 failed: port is already allocated',
          }
        }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const ports = [8973, 49160]
    const allocatePort = async (): Promise<number> => ports.shift() ?? 0

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    // then: the second run got a different host port and succeeded
    expect(result.ok).toBe(true)
    expect(runAttempts).toBe(2)
    const runCalls = calls.filter((c) => c.args[0] === 'run')
    expect(runCalls).toHaveLength(2)
    expect(runCalls[0]!.args).toContain('127.0.0.1:8973:8973')
    expect(runCalls[1]!.args).toContain('127.0.0.1:49160:8973')
    if (result.ok) expect(result.hostPort).toBe(49160)
  })

  test('cleans the prior registration when the port-retry registration is unavailable', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root)
    const calls: { args: string[] }[] = []
    let runAttempts = 0
    const exec: DockerExec = async (args) => {
      calls.push({ args })
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') {
        runAttempts += 1
        if (runAttempts === 1) {
          return { exitCode: 1, stdout: '', stderr: 'docker: Bind for :::8973 failed: port is already allocated' }
        }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const ports = [8973, 49160]
    const allocatePort = async (): Promise<number> => ports.shift() ?? 0
    const deregistrations: string[] = []
    let registrations = 0

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort,
      cliEntry: '/placeholder/cli.ts',
      reuseCurrentHostDaemon: true,
      currentHostDaemon: {
        httpPort: 49999,
        register: async () => {
          registrations += 1
          return registrations < 3 ? { ok: true } : { ok: false, reason: 'registration-unavailable' }
        },
        deregister: async (containerName) => {
          deregistrations.push(containerName)
        },
      },
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(registrations).toBe(3)
    expect(deregistrations).toEqual([basename(root)])
    expect(result.hostd).toEqual({ state: 'unavailable', reason: 'registration-unavailable' })
    expect(result.hostPort).toBe(49160)
    expect(result.plan.runArgs.some((arg) => arg.includes('TYPECLAW_HOSTD_'))).toBe(false)
    expect(runAttempts).toBe(2)
    const runCalls = calls.filter((call) => call.args[0] === 'run')
    expect(runCalls).toHaveLength(2)
    expect(runCalls[0]!.args).toContain('127.0.0.1:8973:8973')
    expect(runCalls[1]!.args).toContain('127.0.0.1:49160:8973')
    expect(runCalls[1]!.args.some((arg) => arg.includes('TYPECLAW_HOSTD_'))).toBe(false)
  })

  test('does NOT retry when docker fails for a non-port reason (e.g. permission denied)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: 'permission denied' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    expect(runAttempts).toBe(1)
    if (!result.ok) expect(result.reason).toMatch(/permission denied/)
  })
})

// start.test.ts owns COMPOSITION: that start() invokes the verifier exactly
// when docker run succeeds, routes a failing verifier into ok:false, and runs
// cleanup. The behavior of the default verifier (transient statuses, daemon
// errors, log capture, timeouts) lives in verify-running.test.ts.
describe('start (post-run verification composition)', () => {
  test('routes a failing verifier into ok:false with the verifier-supplied reason and runs hostd cleanup', async () => {
    const previousHome = process.env.TYPECLAW_HOME
    const home = await mkdtemp(join(tmpdir(), 'typeclaw-crash-hostd-'))
    let daemon: Daemon | null = null
    try {
      process.env.TYPECLAW_HOME = home
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root)
      daemon = await startDaemon({ version: 'v', gcIntervalMs: 1_000_000 })
      const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        cliEntry: '/nonexistent/cli.ts',
        reuseCurrentHostDaemon: true,
        ensureDeps: noEnsureDeps,
        ensureModels: noEnsureModels,
        provisionGithubCliStore: noGithubCliProvision,
        autoUpgrade: noAutoUpgrade,
        verifyRunning: async () => ({
          ok: false,
          mode: 'exited',
          status: 'exited',
          logs: { ok: true, text: 'Cannot find package "missing"' },
        }),
      })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.reason).toMatch(/stopped running immediately after start/)
      expect(result.reason).toContain('Cannot find package "missing"')
      expect(daemon.registered()).not.toContain(basename(root))
    } finally {
      if (daemon) await daemon.stop().catch(() => {})
      if (previousHome === undefined) delete process.env.TYPECLAW_HOME
      else process.env.TYPECLAW_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test('verifier runs AFTER docker run succeeds and BEFORE start returns success', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    let verifierInvokedAfterRun = false
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ensureModels: noEnsureModels,
      provisionGithubCliStore: noGithubCliProvision,
      autoUpgrade: noAutoUpgrade,
      verifyRunning: async () => {
        const runIdx = calls.findIndex((c) => c.args[0] === 'run')
        verifierInvokedAfterRun = runIdx >= 0
        return { ok: true }
      },
    })

    expect(result.ok).toBe(true)
    expect(verifierInvokedAfterRun).toBe(true)
  })

  test('does not invoke the verifier when docker run fails (no container to verify)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') return { exitCode: 125, stdout: '', stderr: 'docker run failed for unrelated reason' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    let verifierCalled = false

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ensureModels: noEnsureModels,
      provisionGithubCliStore: noGithubCliProvision,
      autoUpgrade: noAutoUpgrade,
      verifyRunning: async () => {
        verifierCalled = true
        return { ok: true }
      },
    })

    expect(result.ok).toBe(false)
    expect(verifierCalled).toBe(false)
  })
})

describe('planStart port mapping', () => {
  test('always uses CONTAINER_PORT (8973) on the container side regardless of host port', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 49160, imageExists: true })

    expect(plan.runArgs).toContain('-p')
    expect(plan.runArgs).toContain('127.0.0.1:49160:8973')
    expect(plan.hostPort).toBe(49160)
  })
})

describe('start autoUpgrade integration', () => {
  test('forces bun update typeclaw when autoUpgrade reports spec-rewritten', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.2.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const updateCalls: Array<{ cwd: string; pkg: string }> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' }),
      forceBunUpdate: async (cwd, pkg) => {
        updateCalls.push({ cwd, pkg })
        return { ok: true }
      },
      readInstalledVersion: () => '0.2.0',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // and: bun update was called with the agent folder AND the typeclaw package name
    expect(updateCalls).toEqual([{ cwd: root, pkg: 'typeclaw' }])
    if (!result.ok) throw new Error('expected success')
    expect(result.autoUpgrade).toEqual({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' })
  })

  test('forces bun update typeclaw when autoUpgrade reports reinstall-needed', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const updateCalls: Array<{ cwd: string; pkg: string }> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async (cwd, pkg) => {
        updateCalls.push({ cwd, pkg })
        return { ok: true }
      },
      readInstalledVersion: () => '0.1.2',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(updateCalls).toEqual([{ cwd: root, pkg: 'typeclaw' }])
  })

  test('does NOT call forceBunUpdate for no-op outcomes (up-to-date, dev mode, exact pin, already running, etc.)', async () => {
    for (const upgrade of [
      { kind: 'up-to-date', installedVersion: '0.1.2' } as const,
      { kind: 'skipped-dev-mode' } as const,
      { kind: 'skipped-no-dep' } as const,
      { kind: 'skipped-already-running' } as const,
      { kind: 'skipped-non-release-spec', declared: 'file:../typeclaw' } as const,
      { kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' } as const,
    ]) {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

      const updateCalls: Array<{ cwd: string; pkg: string }> = []
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: async () => upgrade,
        forceBunUpdate: async (cwd, pkg) => {
          updateCalls.push({ cwd, pkg })
          return { ok: true }
        },
        ...bypassVerify,
      })

      expect(result.ok).toBe(true)
      expect(updateCalls).toEqual([])
    }
  })

  test('aborts start (no docker run) when forceBunUpdate reports failure', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async () => ({ ok: false, reason: 'registry timeout' }),
      ensureModels: noEnsureModels,
      provisionGithubCliStore: noGithubCliProvision,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('registry timeout')
    expect(result.reason).toContain('auto-upgrade')
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })

  test('aborts start when bun update succeeds but installed version is still stale (verification gate)', async () => {
    // Oracle's BLOCKING #5: bun update can exit 0 but resolve to an older version
    // than expected. Without verification, refreshDockerfile would pin a stale base
    // image. This test guards the verification step.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async () => ({ ok: true }),
      readInstalledVersion: () => '0.1.0',
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('verification failed')
    expect(result.reason).toContain('0.1.0')
    expect(result.reason).toContain('0.1.2')
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })

  test('verification passes when installed reaches OR EXCEEDS the upgrade target', async () => {
    // The registry may resolve a caret range to a higher patch than we asked for
    // (e.g. expected 0.1.2 but got 0.1.5 because the lockfile no longer pinned it).
    // Treat "ahead" as success — we only fail when installed is BEHIND target.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async () => ({ ok: true }),
      readInstalledVersion: () => '0.1.5',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
  })

  test('autoUpgrade runs BEFORE ensureDeps (load-bearing order)', async () => {
    // The whole feature breaks if ensureDeps runs first: ensureDeps short-circuits
    // on "every declared dep exists" and skips the install that auto-upgrade depends
    // on. Test by recording call order in a shared array.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const order: string[] = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      autoUpgrade: async () => {
        order.push('autoUpgrade')
        return { kind: 'skipped-no-dep' }
      },
      ensureDeps: async () => {
        order.push('ensureDeps')
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(order).toEqual(['autoUpgrade', 'ensureDeps'])
  })

  test('alreadyRunning short-circuit surfaces autoUpgrade: skipped-already-running', async () => {
    // When the container is already up, start() returns without checking auto-upgrade.
    // The outcome must reflect that honestly, not pretend we checked and found no dep.
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: true, running: true } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: noAutoUpgrade,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.alreadyRunning).toBe(true)
    expect(result.autoUpgrade).toEqual({ kind: 'skipped-already-running' })
  })

  test('commits package.json + bun.lock under "Upgrade typeclaw to X.Y.Z" when autoUpgrade rewrote spec', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' }),
      forceBunUpdate: async (dir) => {
        await writePackageJson(dir, { typeclaw: '^0.2.0' })
        await writeFile(join(dir, 'bun.lock'), '{"lockfileVersion":1,"deps":"upgraded"}\n')
        return { ok: true }
      },
      readInstalledVersion: () => '0.2.0',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Upgrade typeclaw to ^0.2.0')
    expect(subjects).not.toContain('Update dependencies')
    const filesInCommit = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(filesInCommit).toEqual(['bun.lock', 'package.json'])
  })

  test('commits under "Upgrade typeclaw to X.Y.Z" for reinstall-needed (not just spec-rewritten)', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async (dir) => {
        await writeFile(join(dir, 'bun.lock'), '{"lockfileVersion":1,"deps":"upgraded"}\n')
        return { ok: true }
      },
      readInstalledVersion: () => '0.1.2',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Upgrade typeclaw to 0.1.2')
  })

  test('uses "Update dependencies" when autoUpgrade is a no-op (no upgrade attribution)', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (dir) => {
        await writeFile(join(dir, 'bun.lock'), '{"lockfileVersion":1,"deps":"new"}\n')
        return { ok: true, installed: true }
      },
      autoUpgrade: async () => ({ kind: 'up-to-date', installedVersion: '0.1.2' }),
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update dependencies')
    expect(subjects.filter((s) => s.startsWith('Upgrade typeclaw'))).toEqual([])
  })

  test('relinked-to-local (file:) forces ensureDeps and never calls forceBunUpdate', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const updateCalls: Array<{ cwd: string; pkg: string }> = []
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      autoUpgrade: async () => ({ kind: 'relinked-to-local', from: '^0.1.0', to: 'file:../typeclaw' }),
      forceBunUpdate: async (cwd, pkg) => {
        updateCalls.push({ cwd, pkg })
        return { ok: true }
      },
      ensureDeps: async (_dir, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: true }
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(updateCalls).toEqual([])
    expect(ensureCalls).toEqual([{ force: true }])
  })

  test('win32 link:typeclaw agent runs bun link BEFORE the forced install, no forceBunUpdate', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'link:typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const order: string[] = []
    const updateCalls: string[] = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      platform: 'win32',
      exec,
      allocatePort: deterministicAllocator,
      autoUpgrade: async () => ({ kind: 'relinked-to-local', from: '^0.1.0', to: 'link:typeclaw' }),
      runBunLink: async () => {
        order.push('bun-link')
      },
      forceBunUpdate: async () => {
        updateCalls.push('update')
        return { ok: true }
      },
      ensureDeps: async (_dir, opts) => {
        order.push(`ensureDeps:force=${opts?.force === true}`)
        return { ok: true, installed: true }
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(updateCalls).toEqual([])
    expect(order).toEqual(['bun-link', 'ensureDeps:force=true'])
  })

  test('win32 self-heals an interrupted relink: link: spec already on disk still runs bun link before install', async () => {
    // A prior start wrote `link:typeclaw` but its bun link failed, so reconcile
    // now sees a local spec and returns skipped-dev-mode (no transition). The
    // guard must STILL register the link before install, keyed on the on-disk
    // spec rather than the outcome.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'link:typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const order: string[] = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      platform: 'win32',
      exec,
      allocatePort: deterministicAllocator,
      autoUpgrade: async () => ({ kind: 'skipped-dev-mode' }),
      runBunLink: async () => {
        order.push('bun-link')
      },
      ensureDeps: async (_dir, opts) => {
        order.push(`ensureDeps:force=${opts?.force === true}`)
        return { ok: true, installed: true }
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // The point: bun link runs before ensureDeps, AND ensureDeps is forced so a
    // stale node_modules/typeclaw can't make the relink skip the install.
    expect(order).toEqual(['bun-link', 'ensureDeps:force=true'])
  })

  test('win32 interrupted relink with a stale node_modules/typeclaw forces ensureDeps on the retry', async () => {
    // First start: reconcile rewrites ^0.1.0 → link:typeclaw, then bun link
    // throws (interrupted). Second start: spec is already link: so reconcile is
    // skipped-dev-mode, but bun link must re-run AND ensureDeps must be forced
    // to overwrite the stale npm node_modules/typeclaw with the linked checkout.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'link:typeclaw' })
    await mkdir(join(root, 'node_modules', 'typeclaw'), { recursive: true })
    await writeFile(
      join(root, 'node_modules', 'typeclaw', 'package.json'),
      JSON.stringify({ name: 'typeclaw', version: '0.1.0' }),
    )
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const order: string[] = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      platform: 'win32',
      exec,
      allocatePort: deterministicAllocator,
      autoUpgrade: async () => ({ kind: 'skipped-dev-mode' }),
      runBunLink: async () => {
        order.push('bun-link')
      },
      ensureDeps: async (_dir, opts) => {
        order.push(`ensureDeps:force=${opts?.force === true}`)
        return { ok: true, installed: true }
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(order).toEqual(['bun-link', 'ensureDeps:force=true'])
  })

  test('link:typeclaw agent does NOT run bun link off-Windows', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'link:typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    let linkCalled = false
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      platform: 'linux',
      exec,
      allocatePort: deterministicAllocator,
      autoUpgrade: async () => ({ kind: 'skipped-dev-mode' }),
      runBunLink: async () => {
        linkCalled = true
      },
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(linkCalled).toBe(false)
  })
})
