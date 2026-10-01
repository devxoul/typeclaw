import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type BackupRunnerDeps,
  type GitSpawn,
  type GitSpawnResult,
  parsePorcelain,
  makeDefaultGitSpawn,
  runBackup,
  runMaintenance,
  withIndexLockRetry,
} from './runner'

const okResult = (stdout = ''): GitSpawnResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
const failResult = (stderr = 'boom', exit = 1): GitSpawnResult => ({
  exitCode: exit,
  stdout: '',
  stderr,
  timedOut: false,
})

type Call = { args: readonly string[]; cwd: string; env?: Record<string, string> }

function makeSpawn(handler: (args: readonly string[]) => GitSpawnResult): { spawn: GitSpawn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: GitSpawn = async (args, { cwd, env }) => {
    calls.push({ args, cwd, env })
    return handler(args)
  }
  return { spawn, calls }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'autobackup-runner-'))
  await mkdir(join(dir, '.git'))
  return dir
}

async function makeGitstoreRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'autobackup-runner-gitstore-'))
  await mkdir(join(dir, '.gitstore'))
  return dir
}

const baseDeps = (spawn: GitSpawn, message = 'chore: test'): BackupRunnerDeps => ({
  gitSpawn: spawn,
  pickCommitMessage: async () => message,
})

describe('runBackup', () => {
  test('default runner commits without executing a planted hook', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-hookless-'))
    try {
      const git = async (args: string[]): Promise<void> => {
        const proc = Bun.spawn({
          cmd: ['git', ...args],
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(await proc.exited).toBe(0)
      }
      await git(['init', '-q', '-b', 'main'])
      await writeFile(join(cwd, 'notes.md'), 'initial\n')
      await git(['add', 'notes.md'])
      await git(['commit', '-qm', 'initial'])
      const marker = join(cwd, 'hook-ran')
      const hook = join(cwd, '.git', 'hooks', 'pre-commit')
      await writeFile(hook, `#!/bin/sh\nprintf '%s' "$TYPECLAW_HOOK_SECRET" > "${marker}"\n`)
      await chmod(hook, 0o755)
      await writeFile(join(cwd, 'notes.md'), 'changed\n')

      const previous = process.env.TYPECLAW_HOOK_SECRET
      process.env.TYPECLAW_HOOK_SECRET = 'must-not-leak'
      try {
        const result = await runBackup(
          { cwd, pushToOrigin: false },
          { gitSpawn: makeDefaultGitSpawn(), pickCommitMessage: async () => 'backup without hooks' },
        )
        expect(result).toEqual({ ok: true, kind: 'committed' })
      } finally {
        if (previous === undefined) delete process.env.TYPECLAW_HOOK_SECRET
        else process.env.TYPECLAW_HOOK_SECRET = previous
      }
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('commits only backup paths while preserving a foreign staged change', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-foreign-index-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'backup.txt'), 'initial\n')
      await git('add', 'backup.txt')
      await git('commit', '-qm', 'initial')
      await writeFile(join(cwd, 'backup.txt'), 'backup\n')
      expect(
        await runBackup(
          { cwd, pushToOrigin: false },
          {
            gitSpawn,
            pickCommitMessage: async () => {
              await writeFile(join(cwd, 'foreign.txt'), 'foreign\n')
              await git('add', 'foreign.txt')
              return 'chore: backup'
            },
          },
        ),
      ).toEqual({ ok: true, kind: 'committed' })
      expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe('backup.txt\n')
      expect(await git('diff', '--cached', '--name-only')).toBe('foreign.txt\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('returns clean when a foreign commit absorbs the same paths during message selection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-foreign-commit-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'backup.txt'), 'initial\n')
      await git('add', 'backup.txt')
      await git('commit', '-qm', 'initial')
      await writeFile(join(cwd, 'backup.txt'), 'backup\n')
      expect(
        await runBackup(
          { cwd, pushToOrigin: false },
          {
            gitSpawn,
            pickCommitMessage: async () => {
              await writeFile(join(cwd, 'foreign.txt'), 'foreign\n')
              await git('add', 'foreign.txt')
              await git('add', 'backup.txt')
              await git('commit', '-qm', 'foreign change')
              return 'chore: backup'
            },
          },
        ),
      ).toEqual({ ok: true, kind: 'clean' })
      expect(await git('log', '-1', '--format=%s')).toBe('foreign change\n')
      expect(await git('show', 'HEAD:backup.txt')).toBe('backup\n')
      expect(await git('show', 'HEAD:foreign.txt')).toBe('foreign\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('preserves intervening commits and commits deleted and force-added snapshot paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-snapshot-paths-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'removed.txt'), 'remove\n')
      await git('add', 'removed.txt')
      await git('commit', '-qm', 'initial')
      await rm(join(cwd, 'removed.txt'))
      await mkdir(join(cwd, 'sessions'))
      await mkdir(join(cwd, 'todo'))
      await writeFile(join(cwd, 'sessions', 'early.jsonl'), 'early\n')
      await writeFile(join(cwd, 'todo', 'state.json'), 'state\n')
      expect(
        await runBackup(
          { cwd, pushToOrigin: false },
          {
            gitSpawn,
            pickCommitMessage: async () => {
              await writeFile(join(cwd, 'foreign.txt'), 'foreign\n')
              await git('add', 'foreign.txt')
              await git('commit', '-qm', 'foreign change')
              await writeFile(join(cwd, 'sessions', 'late.jsonl'), 'late\n')
              return 'chore: backup'
            },
          },
        ),
      ).toEqual({ ok: true, kind: 'committed' })
      expect((await git('show', '--format=', '--name-only', 'HEAD')).trim().split('\n').sort()).toEqual([
        'removed.txt',
        'sessions/early.jsonl',
        'sessions/late.jsonl',
        'todo/state.json',
      ])
      expect(await git('show', 'HEAD:foreign.txt')).toBe('foreign\n')
      expect(await git('status', '--porcelain')).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('commits surviving changes when an untracked force path vanishes during message selection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-vanished-force-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'other.txt'), 'initial\n')
      await git('add', 'other.txt')
      await git('commit', '-qm', 'initial')
      await writeFile(join(cwd, 'other.txt'), 'changed\n')
      await mkdir(join(cwd, 'sessions'))
      await writeFile(join(cwd, 'sessions', 'transient.jsonl'), 'temporary\n')
      expect(
        await runBackup(
          { cwd, pushToOrigin: false },
          {
            gitSpawn,
            pickCommitMessage: async () => {
              await rm(join(cwd, 'sessions', 'transient.jsonl'))
              return 'chore: backup'
            },
          },
        ),
      ).toEqual({ ok: true, kind: 'committed' })
      expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe('other.txt\n')
      expect(await git('show', 'HEAD:other.txt')).toBe('changed\n')
      expect(await git('status', '--porcelain')).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('commits an initial snapshot on an unborn branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-unborn-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'first.txt'), 'first\n')
      expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(gitSpawn))).toEqual({
        ok: true,
        kind: 'committed',
      })
      expect(await git('show', 'HEAD:first.txt')).toBe('first\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('commits remaining paths when another writer commits a selected deletion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-deletion-race-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'deleted.txt'), 'original\n')
      await writeFile(join(cwd, 'other.txt'), 'original\n')
      await git('add', 'deleted.txt', 'other.txt')
      await git('commit', '-qm', 'initial')
      await rm(join(cwd, 'deleted.txt'))
      await writeFile(join(cwd, 'other.txt'), 'changed\n')
      expect(
        await runBackup(
          { cwd, pushToOrigin: false },
          {
            gitSpawn,
            pickCommitMessage: async () => {
              await git('add', '--', 'deleted.txt')
              await git('commit', '-qm', 'foreign deletion')
              return 'chore: backup'
            },
          },
        ),
      ).toEqual({ ok: true, kind: 'committed' })
      expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe('other.txt\n')
      expect(await git('show', 'HEAD:other.txt')).toBe('changed\n')
      expect(await git('status', '--porcelain')).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('returns clean when a foreign commit consumes the only deletion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-only-deletion-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'deleted.txt'), 'original\n')
      await git('add', 'deleted.txt')
      await git('commit', '-qm', 'initial')
      await rm(join(cwd, 'deleted.txt'))
      expect(
        await runBackup(
          { cwd, pushToOrigin: false },
          {
            gitSpawn,
            pickCommitMessage: async () => {
              await git('add', '--', 'deleted.txt')
              await git('commit', '-qm', 'foreign deletion')
              return 'chore: backup'
            },
          },
        ),
      ).toEqual({ ok: true, kind: 'clean' })
      expect(await git('log', '-1', '--format=%s')).toBe('foreign deletion\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('commits an ignored path already staged by another writer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-index-ignored-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, '.gitignore'), '*.txt\nsessions/\n')
      await git('add', '.gitignore')
      await git('commit', '-qm', 'initial')
      await writeFile(join(cwd, 'new.txt'), 'selected\n')
      await mkdir(join(cwd, 'sessions'))
      await writeFile(join(cwd, 'sessions', 'selected.jsonl'), 'session\n')
      await git('add', '-f', '--', 'new.txt', 'sessions/selected.jsonl')
      expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(gitSpawn))).toEqual({
        ok: true,
        kind: 'committed',
      })
      expect((await git('show', '--format=', '--name-only', 'HEAD')).trim().split('\n')).toEqual([
        'new.txt',
        'sessions/selected.jsonl',
      ])
      expect(await git('status', '--porcelain')).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('clears a removed index-only addition while committing another change', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-index-only-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'other.txt'), 'original\n')
      await git('add', 'other.txt')
      await git('commit', '-qm', 'initial')
      await writeFile(join(cwd, 'gone.txt'), 'temporary\n')
      await git('add', 'gone.txt')
      await rm(join(cwd, 'gone.txt'))
      await writeFile(join(cwd, 'other.txt'), 'changed\n')
      expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(gitSpawn))).toEqual({
        ok: true,
        kind: 'committed',
      })
      expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe('other.txt\n')
      expect(await git('status', '--porcelain')).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('leaves a vanished memory addition and its staged blob untouched', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-owned-index-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'initial'), 'initial\n')
      await git('add', 'initial')
      await git('commit', '-qm', 'initial')
      await mkdir(join(cwd, 'memory'))
      await writeFile(join(cwd, 'memory', 'gone'), 'keep staged\n')
      await git('add', 'memory/gone')
      await rm(join(cwd, 'memory', 'gone'))
      const staged = await git('ls-files', '--stage', '--', 'memory/gone')
      expect(staged).toContain('memory/gone')
      expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(gitSpawn))).toEqual({
        ok: true,
        kind: 'clean',
      })
      expect(await git('ls-files', '--stage', '--', 'memory/gone')).toBe(staged)
      expect(await git('show', ':memory/gone')).toBe('keep staged\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('clears a removed intent-to-add while committing another change', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-intent-only-'))
    const gitSpawn = makeDefaultGitSpawn()
    const git = async (...args: string[]) => {
      const result = await gitSpawn(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    try {
      await git('init', '-q', '-b', 'main')
      await git('config', 'user.name', 'Test')
      await git('config', 'user.email', 'test@example.com')
      await writeFile(join(cwd, 'other.txt'), 'original\n')
      await git('add', 'other.txt')
      await git('commit', '-qm', 'initial')
      await writeFile(join(cwd, 'gone.txt'), 'temporary\n')
      await git('add', '-N', 'gone.txt')
      await rm(join(cwd, 'gone.txt'))
      await writeFile(join(cwd, 'other.txt'), 'changed\n')
      expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(gitSpawn))).toEqual({
        ok: true,
        kind: 'committed',
      })
      expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe('other.txt\n')
      expect(await git('status', '--porcelain')).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('returns no-repo when .git is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-norepo-'))
    const { spawn, calls } = makeSpawn(() => okResult())
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'no-repo' })
    expect(calls.length).toBe(0)
  })

  test('returns clean when status is empty', async () => {
    const cwd = await makeRepo()
    const { spawn } = makeSpawn(() => okResult(''))
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'clean' })
  })

  test('threads gitstore args into representative git calls', async () => {
    const cwd = await makeGitstoreRepo()
    const prefix = ['--git-dir', join(cwd, '.gitstore'), '--work-tree', cwd]
    const { spawn, calls } = makeSpawn((args) => {
      const command = args[prefix.length]
      if (command === 'status') return okResult(' M notes.md\n')
      if (command === 'diff' && args[prefix.length + 2] === '--quiet') return failResult('', 1)
      if (command === 'commit') return okResult()
      if (command === 'rev-parse') return failResult('no upstream', 128)
      if (command === 'remote') return failResult('No such remote', 2)
      return okResult()
    })

    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn, '백업: 메모 저장'))

    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((c) => c.args.includes('status'))?.args.slice(0, prefix.length)).toEqual(prefix)
    expect(calls.find((c) => c.args.includes('commit'))?.args.slice(0, prefix.length)).toEqual(prefix)
  })

  test('skips committing memory/-prefixed paths but stages other dirty paths', async () => {
    const cwd = await makeRepo()
    const status = ' M src/foo.ts\n M memory/2026-04-27.md\n'
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(status)
      if (args[0] === 'add') return okResult()
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--stat') return okResult('foo.ts | 1 +')
      if (args[0] === 'commit') return okResult()
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })
    const deps = baseDeps(spawn, 'chore: bump foo')
    const result = await runBackup({ cwd, pushToOrigin: true }, deps)

    expect(result).toEqual({ ok: true, kind: 'committed' })
    const addCall = calls.find((c) => c.args[0] === 'add')
    expect(addCall?.args).toEqual(['add', '-f', '--', 'src/foo.ts'])
    expect(calls.some((c) => c.args.includes('memory/2026-04-27.md'))).toBe(false)
  })

  test('no upstream but origin exists and HEAD is a branch: pushes with -u and sets tracking', async () => {
    // given: a fresh repo with origin configured but no `branch.<name>.{remote,merge}`
    // tracking — the default state for an agent folder nobody ran `git push -u` on.
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return failResult('not a tracking branch', 128)
      if (args[0] === 'remote' && args[1] === 'get-url') return okResult('https://example.com/repo.git\n')
      if (args[0] === 'symbolic-ref') return okResult('main\n')
      if (args[0] === 'push') return okResult()
      return okResult()
    })
    // when
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    // then: pushed with -u to origin HEAD:main, establishing tracking in one shot
    expect(result).toEqual({ ok: true, kind: 'pushed-set-upstream' })
    const push = calls.find((c) => c.args[0] === 'push')
    expect(push?.args).toEqual(['push', '-u', 'origin', 'HEAD:main'])
  })

  test('no upstream and no origin remote: commits only (legitimate offline state)', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return failResult('not a tracking branch', 128)
      if (args[0] === 'remote' && args[1] === 'get-url') return failResult('No such remote', 2)
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((c) => c.args[0] === 'push')).toBeUndefined()
  })

  test('no upstream, origin exists, but detached HEAD: commits only (no branch to track)', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return failResult('not a tracking branch', 128)
      if (args[0] === 'remote' && args[1] === 'get-url') return okResult('https://example.com/repo.git\n')
      if (args[0] === 'symbolic-ref') return failResult('ref HEAD is not a symbolic ref', 128)
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((c) => c.args[0] === 'push')).toBeUndefined()
  })

  test('set-upstream push routes non-fast-forward through fetch/rebase/re-push', async () => {
    const cwd = await makeRepo()
    let pushCount = 0
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      if (args[0] === 'remote' && args[1] === 'get-url') return okResult('https://example.com/repo.git\n')
      if (args[0] === 'symbolic-ref') return okResult('main\n')
      if (args[0] === 'push') {
        pushCount += 1
        return pushCount === 1 ? failResult('! [rejected] (non-fast-forward)\nUpdates were rejected', 1) : okResult()
      }
      if (args[0] === 'fetch') return okResult()
      if (args[0] === 'rebase' && args[1] === 'origin/main') return okResult()
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'rebased-and-pushed' })
    expect(calls.filter((c) => c.args[0] === 'push').length).toBe(2)
    // both attempts use the same set-upstream args so tracking is still set on retry
    for (const p of calls.filter((c) => c.args[0] === 'push')) {
      expect(p.args).toEqual(['push', '-u', 'origin', 'HEAD:main'])
    }
    // no tracking ref exists yet, so the recovery fetch must name origin explicitly
    expect(calls.find((c) => c.args[0] === 'fetch')?.args).toEqual(['fetch', 'origin'])
    expect(calls.find((c) => c.args[0] === 'rebase' && c.args[1] === 'origin/main')).toBeDefined()
  })

  test('pushes when upstream is configured', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') return okResult()
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'pushed' })
    expect(calls.find((c) => c.args[0] === 'push')).toBeDefined()
  })

  test('pushEnv reaches push/fetch only — never local commands that can run repo hooks', async () => {
    // given: a minted-token env and a non-fast-forward push so fetch+rebase run too
    const cwd = await makeRepo()
    const pushEnv = { GIT_ASKPASS: '/x/askpass', TYPECLAW_GIT_TOKEN: 'ghs_secret' }
    let pushCount = 0
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') {
        pushCount += 1
        return pushCount === 1 ? failResult('! [rejected] (non-fast-forward)\nUpdates were rejected', 1) : okResult()
      }
      if (args[0] === 'fetch') return okResult()
      if (args[0] === 'rebase' && args[1] === 'origin/main') return okResult()
      return okResult()
    })
    // when
    await runBackup({ cwd, pushToOrigin: true }, { ...baseDeps(spawn), pushEnv })

    // then: every push/fetch carries the token; the local commit/add/status/rebase
    // (which can execute repo-controlled git hooks) must NOT see it.
    const networkCmds = new Set(['push', 'fetch'])
    for (const c of calls) {
      if (networkCmds.has(c.args[0] as string)) {
        expect(c.env).toEqual(pushEnv)
      } else {
        expect(c.env?.TYPECLAW_GIT_TOKEN).toBeUndefined()
      }
    }
    // sanity: the hook-executing commands actually ran in this scenario
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(true)
    expect(calls.some((c) => c.args[0] === 'rebase' && c.args[1] === 'origin/main')).toBe(true)
  })

  test('on non-fast-forward push, fetches, rebases, and re-pushes', async () => {
    const cwd = await makeRepo()
    let pushCount = 0
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') {
        pushCount += 1
        return pushCount === 1
          ? failResult('! [rejected] main -> main (non-fast-forward)\nUpdates were rejected', 1)
          : okResult()
      }
      if (args[0] === 'fetch') return okResult()
      if (args[0] === 'rebase' && args[1] === 'origin/main') return okResult()
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'rebased-and-pushed' })
    expect(calls.filter((c) => c.args[0] === 'push').length).toBe(2)
    expect(calls.find((c) => c.args[0] === 'rebase' && c.args[1] === 'origin/main')).toBeDefined()
  })

  test('on rebase conflict, aborts and calls diagnoseFailure', async () => {
    const cwd = await makeRepo()
    const diagnoseCalls: { stage: string; exit: number }[] = []
    let pushCount = 0
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') {
        pushCount += 1
        return failResult('! [rejected] main -> main (non-fast-forward)', 1)
      }
      if (args[0] === 'fetch') return okResult()
      if (args[0] === 'rebase' && args[1] === '--abort') return okResult()
      if (args[0] === 'rebase') return failResult('CONFLICT (content): foo', 1)
      return okResult()
    })
    const deps: BackupRunnerDeps = {
      ...baseDeps(spawn),
      diagnoseFailure: async (input) => {
        diagnoseCalls.push({ stage: input.stage, exit: input.exitCode })
      },
    }
    const result = await runBackup({ cwd, pushToOrigin: true }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('rebase-failed')
    expect(diagnoseCalls).toEqual([{ stage: 'rebase', exit: 1 }])
    expect(calls.find((c) => c.args[0] === 'rebase' && c.args[1] === '--abort')).toBeDefined()
    expect(pushCount).toBe(1)
  })

  test('diagnose-failure is advisory; its throw must not mask the original failure', async () => {
    const cwd = await makeRepo()
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') return failResult('Authentication failed', 128)
      return okResult()
    })
    const deps: BackupRunnerDeps = {
      ...baseDeps(spawn),
      diagnoseFailure: async () => {
        throw new Error('diagnose blew up')
      },
    }
    const result = await runBackup({ cwd, pushToOrigin: true }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('push-failed')
      expect(result.reason).toContain('Authentication failed')
    }
  })

  test('does not push when pushToOrigin is false, even with upstream configured', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: false }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((c) => c.args[0] === 'push')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'rev-parse')).toBeUndefined()
  })

  test('returns clean when staged diff is empty after add (e.g. only memory/ paths dirty)', async () => {
    const cwd = await makeRepo()
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M memory/foo.md\n')
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'clean' })
  })

  test('sanitizes commit message: long subject is truncated, fallback on empty', async () => {
    const cwd = await makeRepo()
    let captured = ''
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'commit') {
        captured = args[args.indexOf('-m') + 1] ?? ''
        return okResult()
      }
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })
    const long = 'x'.repeat(500)
    await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn, long))
    expect(captured.length).toBeLessThanOrEqual(200)
  })

  test('falls back to "Backup" subject when picker returns empty', async () => {
    const cwd = await makeRepo()
    let captured = ''
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'commit') {
        captured = args[args.indexOf('-m') + 1] ?? ''
        return okResult()
      }
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })
    await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn, '   '))
    expect(captured).toBe('Backup')
  })
  test('skips an ordinary untracked path that vanished before staging', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult('?? gone.txt\0')
      return okResult()
    })

    const result = await runBackup({ cwd, pushToOrigin: false }, baseDeps(spawn))

    expect(result).toEqual({ ok: true, kind: 'clean' })
    expect(calls.some((call) => call.args[0] === 'add')).toBe(false)
  })

  test('keeps a dangling untracked symlink stageable while dropping a path that vanishes after the status snapshot', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-dangling-symlink-'))
    const realGit = makeDefaultGitSpawn()
    const runGit = async (args: string[]): Promise<GitSpawnResult> => {
      const result = await realGit(args, { cwd, timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      return result
    }

    try {
      await runGit(['init', '-q', '-b', 'main'])
      await runGit(['config', 'user.name', 'Test'])
      await runGit(['config', 'user.email', 'test@example.com'])
      await writeFile(join(cwd, 'initial.txt'), 'initial\n')
      await runGit(['add', 'initial.txt'])
      await runGit(['commit', '-qm', 'initial'])
      await symlink('missing-target', join(cwd, 'dangling-link'))
      await writeFile(join(cwd, 'transient.txt'), 'temporary\n')

      let removeBeforeFirstAdd = true
      const result = await runBackup(
        { cwd, pushToOrigin: false },
        {
          gitSpawn: async (args, opts) => {
            if (removeBeforeFirstAdd && args[0] === 'add' && args[1] === '-f' && args.includes('transient.txt')) {
              removeBeforeFirstAdd = false
              await rm(join(cwd, 'transient.txt'))
              await writeFile(join(cwd, 'later.txt'), 'later\n')
            }
            return realGit(args, opts)
          },
          pickCommitMessage: async () => 'chore: preserve dangling symlink',
        },
      )

      expect(result).toEqual({ ok: true, kind: 'committed' })
      const tree = await runGit(['ls-tree', '-r', 'HEAD'])
      expect(tree.stdout).toContain('120000 blob')
      expect(tree.stdout).toContain('\tdangling-link\n')
      expect(tree.stdout).not.toContain('transient.txt')
      expect(tree.stdout).not.toContain('later.txt')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('stages both tracked rename endpoints from the original snapshot', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult('R  renamed.txt\0original.txt\0')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'diff' && args[2] === '--stat') return okResult()
      if (args[0] === 'commit') return okResult()
      return okResult()
    })

    expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(spawn))).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((call) => call.args[0] === 'add')?.args).toEqual([
      'add',
      '-f',
      '--',
      'renamed.txt',
      'original.txt',
    ])
  })

  test('stages a tracked deletion even when its path is absent', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' D removed.txt\0')
      if (args[0] === 'ls-tree') return okResult('removed.txt\0')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'diff' && args[2] === '--stat') return okResult()
      if (args[0] === 'commit') return okResult()
      return okResult()
    })

    expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(spawn))).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((call) => call.args[0] === 'add')?.args).toEqual(['add', '-f', '--', 'removed.txt'])
  })

  test('stages a tracked force-path deletion through the ordinary snapshot', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' D sessions/removed.jsonl\0')
      if (args[0] === 'ls-tree') return okResult('sessions/removed.jsonl\0')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'diff' && args[2] === '--stat') return okResult()
      if (args[0] === 'commit') return okResult()
      return okResult()
    })

    expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(spawn))).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((call) => call.args[0] === 'add')?.args).toEqual(['add', '-f', '--', 'sessions/removed.jsonl'])
  })

  test('reports a failed explicit add without masking its cause', async () => {
    const cwd = await makeRepo()
    await writeFile(join(cwd, 'still-here.txt'), 'present')
    let statuses = 0
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') {
        statuses += 1
        return okResult('?? still-here.txt\0')
      }
      if (args[0] === 'add') return failResult('permission denied')
      return okResult()
    })

    const result = await runBackup({ cwd, pushToOrigin: false }, baseDeps(spawn))

    expect(result).toEqual({ ok: false, kind: 'commit-failed', reason: 'git add failed: permission denied' })
    expect(statuses).toBe(2)
  })

  test('surfaces the retry failure after one reconciliation attempt', async () => {
    const cwd = await makeRepo()
    await writeFile(join(cwd, 'vanishing.txt'), 'present')
    let statuses = 0
    let adds = 0
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') {
        statuses += 1
        return okResult(statuses === 1 ? '?? vanishing.txt\0 M tracked.txt\0' : ' M tracked.txt\0')
      }
      if (args[0] === 'add') {
        adds += 1
        if (adds === 1) {
          rmSync(join(cwd, 'vanishing.txt'))
          return failResult('first failure')
        }
        return failResult('retry failure')
      }
      return okResult()
    })

    expect(await runBackup({ cwd, pushToOrigin: false }, baseDeps(spawn))).toEqual({
      ok: false,
      kind: 'commit-failed',
      reason: 'git add failed: retry failure',
    })
  })
})

describe('parsePorcelain', () => {
  test('classifies tracked and untracked NUL-delimited records', () => {
    expect(parsePorcelain(' M src/foo.ts\0?? bar.ts\0')).toEqual([
      { status: ' M', kind: 'tracked', paths: ['src/foo.ts'] },
      { status: '??', kind: 'untracked', paths: ['bar.ts'] },
    ])
  })

  test('preserves literal rename endpoints without pathname quoting', () => {
    expect(parsePorcelain('R  new name\nfile\0old name\nfile\0')).toEqual([
      { status: 'R ', kind: 'tracked', paths: ['new name\nfile', 'old name\nfile'] },
    ])
  })

  test('skips empty and short records', () => {
    expect(parsePorcelain('\0  \0XY\0')).toEqual([])
  })
})

describe('withIndexLockRetry', () => {
  test('retries index.lock failures and returns the successful result', async () => {
    const calls: Array<readonly string[]> = []
    const spawn: GitSpawn = async (args) => {
      calls.push(args)
      if (calls.length <= 2) return failResult("fatal: Unable to create '.git/index.lock': File exists")
      return okResult('done')
    }

    const result = await withIndexLockRetry(spawn)(['add', '--', 'foo'], { cwd: '/repo', timeoutMs: 1 })

    expect(result).toEqual(okResult('done'))
    expect(calls).toHaveLength(3)
  })
})

describe('runMaintenance', () => {
  const countObjects = (loose: number, packs: number): string =>
    `count: ${loose}\nsize: 0\nin-pack: 0\npacks: ${packs}\nsize-pack: 0\nprune-packable: 0\ngarbage: 0\n`

  const maintenanceSpawn = (
    counts: { loose: number; packs: number },
    runResult: GitSpawnResult = okResult(),
  ): { spawn: GitSpawn; calls: Call[] } =>
    makeSpawn((args) => {
      if (args.includes('count-objects')) return okResult(countObjects(counts.loose, counts.packs))
      if (args.includes('maintenance')) return runResult
      return okResult()
    })

  const maintCall = (calls: Call[]): Call => {
    const maint = calls.find((c) => c.args.includes('maintenance'))
    if (!maint) throw new Error('expected a maintenance call')
    return maint
  }

  test('skips when both loose objects and packs are within thresholds', async () => {
    const cwd = await makeRepo()
    try {
      const { spawn, calls } = maintenanceSpawn({ loose: 300, packs: 12 })

      const result = await runMaintenance(cwd, baseDeps(spawn))

      expect(result).toEqual({ ok: true, kind: 'skipped' })
      expect(calls.some((c) => c.args.includes('maintenance'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('runs ONLY loose-objects when loose objects grow but packs do not', async () => {
    // the reviewer's case: gc.auto=0 means commits pile up loose objects while
    // packs stay ~0, so the loose gate must fire independently of pack count
    const cwd = await makeRepo()
    try {
      const { spawn, calls } = maintenanceSpawn({ loose: 5000, packs: 1 })

      const result = await runMaintenance(cwd, baseDeps(spawn))

      expect(result).toEqual({ ok: true, kind: 'ran', tasks: ['loose-objects'] })
      const maint = maintCall(calls)
      expect(maint.args).toContain('--task=loose-objects')
      expect(maint.args).not.toContain('--task=incremental-repack')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('runs ONLY incremental-repack when packs grow but loose objects do not', async () => {
    const cwd = await makeRepo()
    try {
      const { spawn, calls } = maintenanceSpawn({ loose: 0, packs: 40 })

      const result = await runMaintenance(cwd, baseDeps(spawn))

      expect(result).toEqual({ ok: true, kind: 'ran', tasks: ['incremental-repack'] })
      expect(maintCall(calls).args).not.toContain('--task=loose-objects')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('runs both tasks under bounded flags when both counters are over threshold', async () => {
    const cwd = await makeRepo()
    try {
      const { spawn, calls } = maintenanceSpawn({ loose: 5000, packs: 40 })

      const result = await runMaintenance(cwd, baseDeps(spawn))

      expect(result).toEqual({ ok: true, kind: 'ran', tasks: ['loose-objects', 'incremental-repack'] })
      const maint = maintCall(calls)
      // memory bounds are pinned on the invocation, not left to git defaults
      expect(maint.args).toContain('pack.threads=1')
      expect(maint.args).toContain('pack.windowMemory=64m')
      expect(maint.args).toContain('pack.deltaCacheSize=1')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('supports the relocated .gitstore layout', async () => {
    const cwd = await makeGitstoreRepo()
    try {
      const { spawn, calls } = maintenanceSpawn({ loose: 0, packs: 40 })

      const result = await runMaintenance(cwd, baseDeps(spawn))

      expect(result.ok).toBe(true)
      expect(maintCall(calls).args.slice(0, 2)).toEqual(['--git-dir', join(cwd, '.gitstore')])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('no-ops on a folder that is not a git repo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-nonrepo-'))
    try {
      const { spawn, calls } = maintenanceSpawn({ loose: 5000, packs: 40 })

      const result = await runMaintenance(cwd, baseDeps(spawn))

      expect(result).toEqual({ ok: true, kind: 'no-repo' })
      expect(calls).toHaveLength(0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('surfaces a maintenance failure without throwing', async () => {
    const cwd = await makeRepo()
    try {
      const { spawn } = maintenanceSpawn({ loose: 0, packs: 40 }, failResult('repack exploded'))

      const result = await runMaintenance(cwd, baseDeps(spawn))

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.kind).toBe('failed')
      expect(result.reason).toContain('repack exploded')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('skips maintenance when the count probe fails', async () => {
    const cwd = await makeRepo()
    try {
      const { spawn, calls } = makeSpawn((args) => {
        if (args.includes('count-objects')) return failResult('probe failed')
        return okResult()
      })

      const result = await runMaintenance(cwd, baseDeps(spawn))

      expect(result).toEqual({ ok: true, kind: 'skipped' })
      expect(calls.some((c) => c.args.includes('maintenance'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  // Real-Git lifecycle: prove that with auto-gc disabled, backup-style commits
  // actually satisfy the loose-object gate and that a real `git maintenance run`
  // packs them into a pack and leaves a valid repo. The fake-spawn tests above
  // verify the gating logic; this verifies the gate reflects real git behavior.
  test('real git: backup commits trip the loose gate and maintenance packs them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-maint-real-'))
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    }
    const git = async (args: string[]): Promise<string> => {
      const proc = Bun.spawn({ cmd: ['git', ...args], cwd, env, stdout: 'pipe', stderr: 'pipe' })
      const out = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      return out
    }
    const readCount = async (field: 'count' | 'in-pack'): Promise<number> =>
      Number.parseInt(
        new RegExp(String.raw`^${field}:\s*(\d+)`, 'm').exec(await git(['count-objects', '-v']))?.[1] ?? '0',
        10,
      )
    try {
      // auto-gc off, exactly as `typeclaw start` configures the agent repo, so
      // commits accumulate LOOSE objects instead of being auto-packed
      await git(['-c', 'init.defaultBranch=main', 'init', '-q'])
      for (let i = 0; i < 40; i += 1) {
        await writeFile(join(cwd, `f${i}.txt`), `content ${i}\n`)
        await git(['-c', 'gc.auto=0', 'add', '-A'])
        await git(['-c', 'gc.auto=0', 'commit', '-qm', `commit ${i}`])
      }
      const looseBefore = await readCount('count')
      const inPackBefore = await readCount('in-pack')
      expect(looseBefore).toBeGreaterThan(0)

      // gate the real run on a threshold below the loose count we just produced
      const deps = baseDeps(makeDefaultGitSpawn())
      const looseGated = await runMaintenance(cwd, deps, { loose: looseBefore - 1 })
      expect(looseGated).toEqual({ ok: true, kind: 'ran', tasks: ['loose-objects'] })

      // the loose objects were packed (in-pack grew) and the repo stays valid
      expect(await readCount('in-pack')).toBeGreaterThan(inPackBefore)
      await git(['fsck', '--no-progress'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('makeDefaultGitSpawn', () => {
  test('aborts and reaps the git child when a pipe drain rejects', async () => {
    let aborted = false
    const stubbedSpawn = ((opts: { signal?: AbortSignal }) => {
      // `exited` only settles when the abort signal fires, so the test proves
      // the drain-failure path aborts the child and waits for it rather than
      // letting the outer timer clear while a stuck git process lives on.
      const exited = new Promise<number>((resolve) => {
        opts.signal?.addEventListener('abort', () => {
          aborted = true
          resolve(137)
        })
      })
      return {
        exited,
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('stdout drain failed'))
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
      }
    }) as unknown as typeof Bun.spawn

    const spawn = makeDefaultGitSpawn({ spawn: stubbedSpawn })
    const result = await spawn(['status'], { cwd: '/tmp', timeoutMs: 10_000 })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('stdout drain failed')
    expect(aborted).toBe(true)
  })
})
