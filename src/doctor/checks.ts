import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import { loadConfigSync, validateConfig } from '@/config'
import {
  checkDockerAvailable,
  containerNameFromCwd,
  defaultDockerExec,
  imageTagFromCwd,
  inspectContainer,
  refreshDockerfile,
  refreshGitignore,
  resolveHostPort,
  type DockerAvailability,
  type DockerExec,
} from '@/container'
import { homeRoot, isDaemonReachable, send } from '@/hostd'
import { hostBunVersionWarning } from '@/hostd/version'
import { resolveBaseImageVersion } from '@/init/cli-version'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'
import { detectMissingDeps } from '@/init/ensure-deps'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'
import { detectWsl, isWindows, isWindowsDriveMount, type WslInfo } from '@/shared'

import { apparmorSandbox } from './apparmor'
import { boundedExec } from './bounded-exec'
import { buildChannelChecks } from './channel-checks'
import { agentFileOwnership, type FileOwnershipDeps } from './file-ownership'
import { buildOperationalIncidentChecks } from './operational-incidents'
import type { DoctorCheck } from './types'

export function buildStaticChecks(opts: { dockerExec?: DockerExec } & FileOwnershipDeps = {}): DoctorCheck[] {
  const dockerExec = opts.dockerExec ?? defaultDockerExec

  return [
    dockerDaemon(boundedExec(dockerExec)),
    bunRuntime(),
    agentFolderInitialized(),
    agentFolderDockerfileTemplate(),
    agentFolderGitignoreTemplate(),
    agentFolderNodeModules(),
    agentFolderGitRepo(),
    agentFileOwnership(opts),
    configValid(),
    apparmorSandbox(),
    hostdHomeWritable(),
    wslDriveMount(),
    windowsSecretPerms(),
    hostdReachable(),
    hostdRegistration(),
    windowsBindMount(),
    containerState(boundedExec(dockerExec)),
    containerHostPort(dockerExec),
    ...buildOperationalIncidentChecks(),
    ...buildChannelChecks(),
  ]
}

function dockerDaemon(exec: DockerExec): DoctorCheck {
  return {
    name: 'docker.daemon-reachable',
    category: 'docker',
    description: 'Docker daemon is reachable',
    async run() {
      const result = await checkDockerAvailable(exec)
      if (result.ok) return { status: 'ok', message: 'docker info responded' }
      return {
        status: 'error',
        message: dockerDaemonMessage(result.reason),
        details: [result.detail],
        fix: { description: dockerDaemonFix(result.reason) },
      }
    },
  }
}

type DockerUnavailableReason = Extract<DockerAvailability, { ok: false }>['reason']

function dockerDaemonMessage(reason: DockerUnavailableReason): string {
  switch (reason) {
    case 'binary-missing':
      return 'docker binary missing on $PATH'
    case 'unresponsive':
      return 'docker daemon accepted the request but never responded'
    case 'daemon-down':
      return 'docker daemon not reachable'
  }
}

function dockerDaemonFix(reason: DockerUnavailableReason): string {
  switch (reason) {
    case 'binary-missing':
      return 'Install Docker (Docker Desktop, OrbStack, or docker-ce), or if it is already installed, add its bin directory to PATH — a non-interactive or SSH shell often misses it.'
    case 'unresponsive':
      return 'Restart the Docker runtime (`orb stop` then reopen OrbStack, restart Docker Desktop, or `systemctl restart docker`). A daemon that answers nothing is usually host or VM memory exhaustion, so check memory pressure or it will recur.'
    case 'daemon-down':
      return 'Start the Docker runtime (Docker Desktop, OrbStack, or `systemctl start docker`). If it is already running, check `docker context ls`, `DOCKER_CONTEXT`, and `DOCKER_HOST`.'
  }
}

export function bunRuntime(bunVersion: string | undefined = process.versions.bun): DoctorCheck {
  return {
    name: 'runtime.bun-available',
    category: 'runtime',
    description: 'Bun runtime is available',
    async run() {
      const bun = (globalThis as { Bun?: unknown }).Bun
      if (bun === undefined) {
        return {
          status: 'error',
          message: 'Bun runtime is not available',
          fix: { description: 'Install Bun (https://bun.sh) and ensure the typeclaw CLI runs under it.' },
        }
      }
      const outdated = hostBunVersionWarning(bunVersion)
      if (outdated) {
        return {
          status: 'warning',
          message: outdated,
          fix: {
            description:
              'Run `bun upgrade`. The host daemon respawns on the new runtime at the next `typeclaw start` or `restart`.',
          },
        }
      }
      return { status: 'ok', message: `Bun ${bunVersion ?? 'present'}` }
    },
  }
}

function agentFolderInitialized(): DoctorCheck {
  return {
    name: 'agent-folder.is-initialized',
    category: 'agent-folder',
    description: 'agent folder contains typeclaw.json',
    async run(ctx) {
      if (ctx.hasAgentFolder) return { status: 'ok', message: 'typeclaw.json present' }
      return {
        status: 'info',
        message: 'no typeclaw.json found in or above current directory',
        details: ['Host-stage checks unrelated to the agent folder still ran.'],
        fix: { description: 'Run `typeclaw init` in the directory you want to use as an agent folder.' },
      }
    },
  }
}

function agentFolderDockerfileTemplate(): DoctorCheck {
  return {
    name: 'agent-folder.dockerfile-managed',
    category: 'agent-folder',
    description: 'Dockerfile matches the typeclaw template',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const dockerfilePath = join(ctx.cwd, DOCKERFILE)
      const expected = buildExpectedDockerfile(ctx.cwd)
      if (expected === null) {
        return { status: 'info', message: 'config invalid; cannot compute expected Dockerfile' }
      }
      const actual = await safeRead(dockerfilePath)
      if (actual === expected) return { status: 'ok', message: 'Dockerfile matches template' }
      return {
        status: 'warning',
        message: actual === null ? 'Dockerfile missing' : 'Dockerfile diverges from template',
        details: ['The Dockerfile is regenerated on every `typeclaw start`, so a divergent file will be overwritten.'],
        fix: {
          description: 'Regenerate the Dockerfile from the typeclaw template.',
          autoFix: async () => {
            await refreshDockerfile(ctx.cwd)
            return { summary: 'refreshed Dockerfile from template', changedPaths: [DOCKERFILE] }
          },
        },
      }
    },
  }
}

function agentFolderGitignoreTemplate(): DoctorCheck {
  return {
    name: 'agent-folder.gitignore-managed',
    category: 'agent-folder',
    description: '.gitignore matches the typeclaw template',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const gitignorePath = join(ctx.cwd, GITIGNORE_FILE)
      const expected = buildExpectedGitignore(ctx.cwd)
      if (expected === null) {
        return { status: 'info', message: 'config invalid; cannot compute expected .gitignore' }
      }
      const actual = await safeRead(gitignorePath)
      if (actual === expected) return { status: 'ok', message: '.gitignore matches template' }
      return {
        status: 'warning',
        message: actual === null ? '.gitignore missing' : '.gitignore diverges from template',
        fix: {
          description: 'Regenerate .gitignore from the typeclaw template.',
          autoFix: async () => {
            await refreshGitignore(ctx.cwd)
            return { summary: 'refreshed .gitignore from template', changedPaths: [GITIGNORE_FILE] }
          },
        },
      }
    },
  }
}

function agentFolderNodeModules(): DoctorCheck {
  return {
    name: 'agent-folder.node-modules-complete',
    category: 'agent-folder',
    description: 'node_modules satisfies package.json dependencies',
    applies: (ctx) => ctx.hasAgentFolder && existsSync(join(ctx.cwd, 'package.json')),
    async run(ctx) {
      const missing = await detectMissingDeps(ctx.cwd)
      if (missing.length === 0) return { status: 'ok', message: 'node_modules complete' }
      return {
        status: 'error',
        message: `${missing.length} package(s) missing from node_modules`,
        details: missing.map((m) => `missing: ${m}`),
        fix: { description: 'Run `bun install` inside the agent folder.' },
      }
    },
  }
}

function agentFolderGitRepo(): DoctorCheck {
  return {
    name: 'agent-folder.git-repo',
    category: 'agent-folder',
    description: 'agent folder is a git repo',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      if (existsSync(join(ctx.cwd, '.git'))) return { status: 'ok', message: '.git present' }
      return {
        status: 'warning',
        message: 'agent folder is not a git repo',
        details: ['typeclaw doctor --fix cannot commit changes without a git repo.'],
        fix: { description: 'Run `git init` in the agent folder.' },
      }
    },
  }
}

function configValid(): DoctorCheck {
  return {
    name: 'config.valid',
    category: 'config',
    description: 'typeclaw.json is valid and mounts are accessible',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const result = validateConfig(ctx.cwd)
      if (result.ok) {
        if (result.warnings && result.warnings.length > 0) {
          return {
            status: 'warning',
            message: `typeclaw.json valid; ${result.warnings.length} docker.file.append warning(s):\n${result.warnings.join('\n')}`,
            fix: {
              description:
                'Review the docker.file.append entries above; unsafe lines are stripped from the Dockerfile on start.',
            },
          }
        }
        return { status: 'ok', message: 'typeclaw.json valid; mounts accessible' }
      }
      return {
        status: 'error',
        message: result.reason,
        fix: { description: 'Edit typeclaw.json to resolve the validation error above.' },
      }
    },
  }
}

function hostdHomeWritable(): DoctorCheck {
  return {
    name: 'hostd.home-writable',
    category: 'hostd',
    description: 'hostd home (~/.typeclaw/) is writable',
    async run() {
      const home = process.env.TYPECLAW_HOME ?? join(homedir(), '.typeclaw')
      try {
        mkdirSync(home, { recursive: true })
        return { status: 'ok', message: `${home} writable` }
      } catch (err) {
        return {
          status: 'error',
          message: `cannot create ${home}: ${err instanceof Error ? err.message : String(err)}`,
          fix: { description: 'Ensure your home directory is writable, or set TYPECLAW_HOME to an alternate path.' },
        }
      }
    },
  }
}

export type WslDriveMountDeps = {
  detect: () => WslInfo
  isWindowsDriveMount: (path: string) => boolean
  typeclawHome: () => string
}

// Under WSL, files on a Windows-drive mount (/mnt/c/...) don't enforce Unix
// permissions, so the 0600 chmod that protects secrets.json and the encryption
// keys is silently ignored — they become readable by every local user. Warn
// when either the agent folder or ~/.typeclaw lives on such a mount.
export function wslDriveMount(deps: Partial<WslDriveMountDeps> = {}): DoctorCheck {
  const detect = deps.detect ?? detectWsl
  const onWindowsDrive = deps.isWindowsDriveMount ?? isWindowsDriveMount
  const typeclawHome = deps.typeclawHome ?? homeRoot

  return {
    name: 'hostd.wsl-drive-mount',
    category: 'hostd',
    description: 'agent state is not on a Windows-drive mount under WSL',
    async run(ctx) {
      if (!detect().isWsl) return { status: 'ok', message: 'not running under WSL' }

      const offenders: string[] = []
      if (ctx.hasAgentFolder && onWindowsDrive(ctx.cwd)) offenders.push(`agent folder: ${ctx.cwd}`)
      const home = typeclawHome()
      if (onWindowsDrive(home)) offenders.push(`hostd home: ${home}`)

      if (offenders.length === 0) {
        return { status: 'ok', message: 'agent state is on the Linux filesystem' }
      }

      return {
        status: 'warning',
        message: 'agent state is on a Windows-drive mount; file permissions are not enforced',
        details: [
          ...offenders,
          'chmod is a no-op on /mnt/<drive> (DrvFs/9p), so secrets.json and encryption keys become world-readable.',
        ],
        fix: {
          description:
            'Move the agent folder to the WSL Linux filesystem (e.g. ~/my-agent) and, if needed, set TYPECLAW_HOME to a Linux path.',
        },
      }
    },
  }
}

export type WindowsSecretPermsDeps = {
  isWindows: () => boolean
  typeclawHome: () => string
}

// On native Windows the 0600/0700 modes typeclaw sets on secrets.json and the
// encryption keys are no-ops — NTFS uses ACLs, not Unix modes — so their
// confidentiality rests on the inherited %USERPROFILE% ACLs rather than the
// hardening typeclaw enforces on POSIX. Surface that as a warning.
export function windowsSecretPerms(deps: Partial<WindowsSecretPermsDeps> = {}): DoctorCheck {
  const onWindows = deps.isWindows ?? isWindows
  const typeclawHome = deps.typeclawHome ?? homeRoot

  return {
    name: 'hostd.windows-secret-perms',
    category: 'hostd',
    description: 'secrets rely on enforced file permissions (native Windows)',
    async run(ctx) {
      if (!onWindows()) return { status: 'ok', message: 'not running on native Windows' }

      const details = [`hostd home: ${typeclawHome()}`]
      if (ctx.hasAgentFolder) details.push(`agent folder: ${ctx.cwd}`)
      details.push(
        'NTFS ignores the 0600/0700 chmod typeclaw applies to secrets.json and encryption keys; their confidentiality relies on the inherited %USERPROFILE% ACLs instead.',
      )

      return {
        status: 'warning',
        message: 'native Windows does not enforce the file modes that protect agent secrets',
        details,
        fix: {
          description:
            'Keep the agent folder and ~/.typeclaw under your user profile, where default ACLs restrict access to your account; avoid a shared or everyone-readable location.',
        },
      }
    },
  }
}

export type WindowsBindMountDeps = {
  isWindows: () => boolean
}

// Docker Desktop bind-mounts the agent folder into its Linux VM, and a few host
// locations don't survive that translation: UNC/network paths (\\server\share)
// aren't shareable, OneDrive-virtualized folders fail on placeholder files, and
// paths near the legacy MAX_PATH (260) limit break mid-build. Flag them so
// `typeclaw start` fails loudly here instead of cryptically at mount time.
export function windowsBindMount(deps: Partial<WindowsBindMountDeps> = {}): DoctorCheck {
  const onWindows = deps.isWindows ?? isWindows

  return {
    name: 'container.windows-bind-mount',
    category: 'container',
    description: 'agent folder is bind-mountable by Docker Desktop (native Windows)',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      if (!onWindows()) return { status: 'ok', message: 'not running on native Windows' }

      const issues = detectWindowsBindMountIssues(ctx.cwd)
      if (issues.length === 0) return { status: 'ok', message: 'agent folder path is bind-mountable' }

      return {
        status: 'warning',
        message: 'agent folder may not bind-mount cleanly under Docker Desktop',
        details: issues,
        fix: {
          description:
            'Use a local, short, non-OneDrive path under your user profile (e.g. C:\\agents\\my-agent), then re-run typeclaw start.',
        },
      }
    },
  }
}

export function detectWindowsBindMountIssues(path: string): string[] {
  const issues: string[] = []
  if (path.startsWith('\\\\')) {
    issues.push(`UNC/network path is not shareable with Docker Desktop: ${path}`)
  }
  if (path.split(/[\\/]/).some((seg) => /^onedrive(?: -.*)?$/i.test(seg))) {
    issues.push(`path is under OneDrive, where virtualized files can break bind mounts: ${path}`)
  }
  if (path.length > 260) {
    issues.push(`path length ${path.length} exceeds the legacy Windows MAX_PATH (260) limit`)
  }
  return issues
}

function hostdReachable(): DoctorCheck {
  return {
    name: 'hostd.reachable',
    category: 'hostd',
    description: 'host daemon is reachable over the Unix socket',
    async run() {
      const reachable = await isDaemonReachable()
      if (reachable) return { status: 'ok', message: 'daemon socket replied to list RPC' }
      return {
        status: 'info',
        message: 'host daemon is not running',
        details: [
          'This is normal when no agent has been started yet. `typeclaw start` will spawn the daemon on demand.',
        ],
      }
    },
  }
}

function hostdRegistration(): DoctorCheck {
  return {
    name: 'hostd.registration',
    category: 'hostd',
    description: 'agent container is registered with hostd',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      if (!(await isDaemonReachable())) {
        return { status: 'skipped', message: 'hostd unreachable (covered by hostd.reachable)' }
      }
      const containerName = containerNameFromCwd(ctx.cwd)
      const reply = await send({ kind: 'status', containerName })
      if (reply.ok) return { status: 'ok', message: 'registered with hostd' }
      return {
        status: 'info',
        message: 'agent is not registered with hostd',
        details: [reply.reason],
      }
    },
  }
}

function containerState(exec: DockerExec): DoctorCheck {
  return {
    name: 'container.state',
    category: 'container',
    description: 'agent container Docker state',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const available = await checkDockerAvailable(exec)
      if (!available.ok) {
        return { status: 'skipped', message: 'docker unavailable (covered by docker.daemon-reachable)' }
      }
      const name = containerNameFromCwd(ctx.cwd)
      const state = await inspectContainer(name, { exec })
      if (!state.exists) {
        return {
          status: 'info',
          message: `container ${name} does not exist`,
          details: [`expected image tag: ${imageTagFromCwd(ctx.cwd)}`],
        }
      }
      if (state.running) return { status: 'ok', message: `container ${name} is running` }
      return {
        status: 'warning',
        message: `container ${name} is stopped`,
        fix: { description: 'Run `typeclaw start` to bring the container back up.' },
      }
    },
  }
}

function containerHostPort(exec: DockerExec): DoctorCheck {
  return {
    name: 'container.host-port-resolves',
    category: 'container',
    description: 'running container exposes its host port',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const bounded = boundedExec(exec)
      const available = await checkDockerAvailable(bounded)
      if (!available.ok) {
        return { status: 'skipped', message: 'docker unavailable (covered by docker.daemon-reachable)' }
      }
      const name = containerNameFromCwd(ctx.cwd)
      const state = await inspectContainer(name, { exec: bounded })
      if (!state.exists || !state.running) {
        return { status: 'skipped', message: 'container not running' }
      }
      try {
        const port = await resolveHostPort({ cwd: ctx.cwd, exec: bounded })
        return { status: 'ok', message: `host port ${port} -> container` }
      } catch (err) {
        return {
          status: 'warning',
          message: `cannot resolve host port: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }
}

function buildExpectedDockerfile(cwd: string): string | null {
  try {
    const cfg = loadConfigStrictForTemplate(cwd)
    if (cfg === null) return null
    return buildDockerfile(cfg.dockerfile, { baseImageVersion: resolveBaseImageVersion(cwd) })
  } catch {
    return null
  }
}

function buildExpectedGitignore(cwd: string): string | null {
  try {
    const cfg = loadConfigStrictForTemplate(cwd)
    if (cfg === null) return null
    return buildGitignore(cfg.gitignore)
  } catch {
    return null
  }
}

function loadConfigStrictForTemplate(
  cwd: string,
): { dockerfile: Parameters<typeof buildDockerfile>[0]; gitignore: Parameters<typeof buildGitignore>[0] } | null {
  const result = validateConfig(cwd)
  if (!result.ok) return null
  const cfg = loadConfigSync(cwd)
  return { dockerfile: cfg.docker.file, gitignore: cfg.git.ignore }
}

// Normalizes CRLF to LF: the managed templates are emitted with `\n`, but a
// checkout under Git for Windows (core.autocrlf=true) rewrites them to `\r\n`,
// which would make the byte-exact template comparison report a false divergence.
async function safeRead(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

export function relativeToCwd(cwd: string, path: string): string {
  return relative(cwd, path) || '.'
}
