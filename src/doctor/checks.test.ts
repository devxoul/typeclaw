import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfigSync } from '@/config'
import type { DockerExec } from '@/container'
import { resolveBaseImageVersion } from '@/init/cli-version'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'

import {
  buildStaticChecks,
  bunRuntime,
  detectWindowsBindMountIssues,
  windowsBindMount,
  windowsSecretPerms,
  wslDriveMount,
  type WindowsBindMountDeps,
  type WindowsSecretPermsDeps,
  type WslDriveMountDeps,
} from './checks'
import { runDoctor } from './index'
import { fetchPluginDoctorChecks } from './plugin-bridge'
import type { CheckContext } from './types'

const agentCtx: CheckContext = { cwd: '/mnt/c/work/agent', hasAgentFolder: true }
const linuxCtx: CheckContext = { cwd: '/home/dev/agent', hasAgentFolder: true }

function deps(overrides: Partial<WslDriveMountDeps> = {}): WslDriveMountDeps {
  return {
    detect: () => ({ isWsl: true, version: 2 }),
    isWindowsDriveMount: (p) => p.startsWith('/mnt/'),
    typeclawHome: () => '/home/dev/.typeclaw',
    ...overrides,
  }
}

const ctx: CheckContext = { cwd: tmpdir(), hasAgentFolder: false }

describe('bunRuntime', () => {
  test('warns with an upgrade fix when the host Bun is older than the tested version', async () => {
    const result = await bunRuntime('1.3.14').run(ctx)
    expect(result.status).toBe('warning')
    expect(result.message).toContain('1.3.14')
    expect(result.fix?.description).toContain('bun upgrade')
  })

  test('passes on a current host Bun', async () => {
    const result = await bunRuntime('1.4.3').run(ctx)
    expect(result).toEqual({ status: 'ok', message: 'Bun 1.4.3' })
  })
})

describe('wslDriveMount', () => {
  test('passes when not running under WSL', async () => {
    const check = wslDriveMount(deps({ detect: () => ({ isWsl: false, version: null }) }))
    const result = await check.run(agentCtx)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running under WSL')
  })

  test('passes when agent folder and home are on the Linux filesystem', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('ok')
  })

  test('warns when the agent folder is on a Windows-drive mount', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run(agentCtx)
    expect(result.status).toBe('warning')
    expect(result.details).toContain('agent folder: /mnt/c/work/agent')
    expect(result.fix?.description).toContain('Linux filesystem')
  })

  test('warns when ~/.typeclaw is on a Windows-drive mount even if agent folder is fine', async () => {
    const winHome = '/mnt/c/work/.typeclaw'
    const check = wslDriveMount(deps({ typeclawHome: () => winHome }))
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('warning')
    expect(result.details).toContain(`hostd home: ${winHome}`)
  })

  test('does not inspect the agent folder when there is none', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run({ cwd: '/mnt/c/work/agent', hasAgentFolder: false })
    expect(result.status).toBe('ok')
  })
})

describe('windowsSecretPerms', () => {
  function winDeps(overrides: Partial<WindowsSecretPermsDeps> = {}): WindowsSecretPermsDeps {
    return {
      isWindows: () => true,
      typeclawHome: () => 'C:\\Users\\dev\\.typeclaw',
      ...overrides,
    }
  }

  test('passes when not on native Windows', async () => {
    const check = windowsSecretPerms({ isWindows: () => false })
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running on native Windows')
  })

  test('warns on native Windows that file modes are not enforced', async () => {
    const check = windowsSecretPerms(winDeps())
    const result = await check.run({ cwd: 'C:\\work\\agent', hasAgentFolder: true })
    expect(result.status).toBe('warning')
    expect(result.details).toContain('agent folder: C:\\work\\agent')
    expect(result.details?.some((d) => d.includes('NTFS'))).toBe(true)
  })

  test('reports the hostd home even without an agent folder', async () => {
    const check = windowsSecretPerms(winDeps())
    const result = await check.run({ cwd: 'C:\\work\\agent', hasAgentFolder: false })
    expect(result.status).toBe('warning')
    expect(result.details).toContain('hostd home: C:\\Users\\dev\\.typeclaw')
  })

  test('is registered in the static check set', () => {
    expect(buildStaticChecks().some((c) => c.name === 'hostd.windows-secret-perms')).toBe(true)
  })
})

describe('windowsBindMount', () => {
  function winDeps(overrides: Partial<WindowsBindMountDeps> = {}): WindowsBindMountDeps {
    return { isWindows: () => true, ...overrides }
  }

  test('passes when not on native Windows', async () => {
    const check = windowsBindMount({ isWindows: () => false })
    const result = await check.run({ cwd: '\\\\nas\\share\\agent', hasAgentFolder: true })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running on native Windows')
  })

  test('passes for a clean local path', async () => {
    const check = windowsBindMount(winDeps())
    const result = await check.run({ cwd: 'C:\\agents\\my-agent', hasAgentFolder: true })
    expect(result.status).toBe('ok')
  })

  test('warns on a UNC/network path', async () => {
    const check = windowsBindMount(winDeps())
    const result = await check.run({ cwd: '\\\\nas\\share\\agent', hasAgentFolder: true })
    expect(result.status).toBe('warning')
    expect(result.details?.some((d) => d.includes('UNC'))).toBe(true)
  })

  test('warns on a OneDrive path', async () => {
    const check = windowsBindMount(winDeps())
    const result = await check.run({ cwd: 'C:\\Users\\dev\\OneDrive\\agent', hasAgentFolder: true })
    expect(result.status).toBe('warning')
    expect(result.details?.some((d) => d.toLowerCase().includes('onedrive'))).toBe(true)
  })

  test('is registered in the static check set', () => {
    expect(buildStaticChecks().some((c) => c.name === 'container.windows-bind-mount')).toBe(true)
  })
})

describe('detectWindowsBindMountIssues', () => {
  test('flags UNC paths', () => {
    expect(detectWindowsBindMountIssues('\\\\nas\\share\\agent')).toHaveLength(1)
  })

  test('flags OneDrive business folders', () => {
    expect(detectWindowsBindMountIssues('C:\\Users\\dev\\OneDrive - Acme\\agent')).toHaveLength(1)
  })

  test('flags paths over the MAX_PATH limit', () => {
    expect(detectWindowsBindMountIssues(`C:\\${'a'.repeat(300)}`)).toHaveLength(1)
  })

  test('passes clean local paths', () => {
    expect(detectWindowsBindMountIssues('C:\\agents\\my-agent')).toEqual([])
  })
})

describe('managed-template checks tolerate CRLF line endings', () => {
  function findCheck(name: string) {
    const check = buildStaticChecks().find((c) => c.name === name)
    if (!check) throw new Error(`missing check ${name}`)
    return check
  }

  function makeAgentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'typeclaw-crlf-test-'))
    writeFileSync(join(dir, 'typeclaw.json'), JSON.stringify({}), 'utf8')
    return dir
  }

  const ctx = (cwd: string): CheckContext => ({ cwd, hasAgentFolder: true })

  test('.gitignore with CRLF is not reported as divergent', async () => {
    const cwd = makeAgentDir()
    const lf = buildGitignore({ append: [] })
    writeFileSync(join(cwd, GITIGNORE_FILE), lf.replace(/\n/g, '\r\n'), 'utf8')

    const result = await findCheck('agent-folder.gitignore-managed').run(ctx(cwd))
    expect(result.status).toBe('ok')
  })

  test('Dockerfile with CRLF is not reported as divergent', async () => {
    const cwd = makeAgentDir()
    const lf = buildDockerfile(loadConfigSync(cwd).docker.file, {
      baseImageVersion: resolveBaseImageVersion(cwd),
    })
    writeFileSync(join(cwd, DOCKERFILE), lf.replace(/\n/g, '\r\n'), 'utf8')

    const result = await findCheck('agent-folder.dockerfile-managed').run(ctx(cwd))
    expect(result.status).toBe('ok')
  })
})

describe('agent file ownership checks', () => {
  function findCheck(checks: ReturnType<typeof buildStaticChecks>, name: string) {
    const check = checks.find((candidate) => candidate.name === name)
    if (!check) throw new Error(`missing check ${name}`)
    return check
  }

  test('reports agent-managed paths owned by another POSIX user', async () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), 'typeclaw-owner-test-'))
    writeFileSync(join(cwd, 'typeclaw.json'), JSON.stringify({}), 'utf8')
    const foreignUid = typeof process.getuid === 'function' ? process.getuid() + 1 : 1
    const check = findCheck(
      buildStaticChecks({ platform: 'linux', currentUid: () => foreignUid }),
      'agent-folder.file-ownership',
    )

    // when
    const result = await check.run({ cwd, hasAgentFolder: true })

    // then
    expect(result.status).toBe('error')
    expect(result.message).toContain('typeclaw.json')
    expect(result.details?.join('\n')).toContain('sudo chown -R "$(id -u):$(id -g)"')
  })

  test('skips POSIX ownership checks on native Windows', async () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), 'typeclaw-owner-test-'))
    writeFileSync(join(cwd, 'typeclaw.json'), JSON.stringify({}), 'utf8')
    const check = findCheck(
      buildStaticChecks({ platform: 'win32', currentUid: () => 1 }),
      'agent-folder.file-ownership',
    )

    // when
    const result = await check.run({ cwd, hasAgentFolder: true })

    // then
    expect(result.status).toBe('ok')
  })
})

describe('doctor terminates against an unresponsive Docker daemon', () => {
  // The incident this guards: a Docker VM in an OOM livelock accepts every
  // connection and answers none. `doctor` is the command an operator reaches
  // for at exactly that moment, so no check may block on it indefinitely.
  // The daemon answers the availability probe and wedges immediately after, so
  // gating on that probe is necessary but NOT sufficient — every later call has
  // to carry its own deadline or the check blocks forever.
  const wedgedCalls: string[] = []
  const wedgesAfterInfo: DockerExec = (args, options) => {
    wedgedCalls.push(args[0] ?? '')
    if (args[0] === 'info') return Promise.resolve({ exitCode: 0, stdout: '29.4.0\n', stderr: '' })
    return new Promise((resolve, reject) => {
      const signal = options?.signal
      if (signal === undefined) {
        // An unbounded call would hang forever in production. Fail fast and
        // loudly here instead of stalling the suite.
        setTimeout(() => reject(new Error(`unbounded docker call: ${args.join(' ')}`)), 2_000).unref?.()
        return
      }
      if (signal.aborted) {
        resolve({ exitCode: -1, stdout: '', stderr: '' })
        return
      }
      signal.addEventListener('abort', () => resolve({ exitCode: -1, stdout: '', stderr: '' }), { once: true })
    })
  }

  test('every docker-touching check settles instead of blocking forever', async () => {
    // given a daemon that accepts and never answers
    const checks = buildStaticChecks({ dockerExec: wedgesAfterInfo }).filter(
      (check) => check.category === 'docker' || check.category === 'container',
    )
    expect(checks.length).toBeGreaterThan(0)

    // when every docker-touching check runs against it
    const ctx = { cwd: process.cwd(), hasAgentFolder: true }
    const results = await Promise.all(checks.map(async (check) => await check.run(ctx)))

    // then all of them return a verdict rather than hanging
    expect(results).toHaveLength(checks.length)
    for (const result of results) {
      expect(typeof result.status).toBe('string')
    }
  }, 30_000)

  test('runDoctor itself terminates, sequencing static checks then plugin discovery', async () => {
    // given the wedged daemon driven through runDoctor's REAL wiring — the
    // earlier tests exercise each half in isolation, which is what let the
    // unbounded discovery path survive a round of review
    wedgedCalls.length = 0
    const agentDir = mkdtempSync(join(tmpdir(), 'typeclaw-doctor-wedged-'))
    writeFileSync(join(agentDir, 'typeclaw.json'), JSON.stringify({ models: { default: 'x/y' } }))
    const result = await runDoctor({ cwd: agentDir, dockerExec: wedgesAfterInfo })

    // then the whole command produces a report instead of hanging, the seam
    // actually reached Docker (otherwise this proves nothing), and nothing in
    // the report tripped the unbounded-call wire
    expect(result.initial).toBeDefined()
    expect(wedgedCalls.length).toBeGreaterThan(0)
    expect(JSON.stringify(result.initial)).not.toContain('unbounded docker call')
  }, 60_000)

  test('plugin discovery is bounded too, so the full doctor run terminates', async () => {
    // given the same wedged daemon. Plugin discovery runs AFTER the static
    // checks, so it is the last place the command can still hang — and it
    // resolves the host port and TUI token through Docker to find the bridge.
    const result = await fetchPluginDoctorChecks({ cwd: process.cwd(), exec: wedgesAfterInfo, timeoutMs: 1_000 })

    // then it reports unreachable instead of blocking forever. `unreachable`
    // alone is too weak an assertion — dial() reports that for ANY failure,
    // including the fixture's own unbounded-call tripwire — so the reason must
    // show the call was actually deadlined rather than left to hang.
    expect(result.kind).toBe('unreachable')
    const reason = result.kind === 'unreachable' ? result.reason : ''
    expect(reason).not.toContain('unbounded docker call')
  }, 30_000)
})
