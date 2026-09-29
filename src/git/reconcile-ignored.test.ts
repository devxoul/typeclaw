import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildGitignore } from '@/init/gitignore'

import { commitGitignoreWithUntracks, untrackTrulyIgnoredFiles } from './reconcile-ignored'

async function runGit(cwd: string, args: string[]): Promise<string> {
  const gitArgs = existsSync(join(cwd, '.gitstore')) ? ['--git-dir', join(cwd, '.gitstore'), '--work-tree', cwd] : []
  const proc = Bun.spawn({ cmd: ['git', ...gitArgs, ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  return (await new Response(proc.stdout).text()).trim()
}

async function relocateGitStore(cwd: string): Promise<void> {
  await rename(join(cwd, '.git'), join(cwd, '.gitstore'))
}

async function gitInit(cwd: string): Promise<void> {
  for (const cmd of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }
}

async function isTracked(cwd: string, path: string): Promise<boolean> {
  return (await runGit(cwd, ['ls-files', '--', path])).length > 0
}

async function makeRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'reconcile-ignored-'))
}

describe('untrackTrulyIgnoredFiles', () => {
  test('untracks a file that became ignored, keeping it on disk', async () => {
    const dir = await makeRepo()
    try {
      // given: public/review.json committed before `public/` was an ignore rule
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, '.gitignore'), buildGitignore())

      // when
      const { untracked } = await untrackTrulyIgnoredFiles(dir)

      // then: removed from the index but still present on disk
      expect(untracked).toContain('public/review.json')
      expect(await isTracked(dir, 'public/review.json')).toBe(false)
      expect(await Bun.file(join(dir, 'public', 'review.json')).exists()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('preserves system-managed dirs even though they are gitignored', async () => {
    const dir = await makeRepo()
    try {
      // given: every system-managed dir is tracked, and the template ignores them
      await gitInit(dir)
      for (const root of ['sessions', 'memory', 'channels', 'todo']) {
        await mkdir(join(dir, root))
        await writeFile(join(dir, root, 'state.json'), '{}\n')
      }
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, '.gitignore'), buildGitignore())

      // when
      const { untracked } = await untrackTrulyIgnoredFiles(dir)

      // then: nothing system-managed is untracked
      expect(untracked).toEqual([])
      for (const root of ['sessions', 'memory', 'channels', 'todo']) {
        expect(await isTracked(dir, `${root}/state.json`)).toBe(true)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('is idempotent — a second run untracks nothing', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, '.gitignore'), buildGitignore())

      await untrackTrulyIgnoredFiles(dir)
      await runGit(dir, ['commit', '-am', 'untrack'])

      const { untracked } = await untrackTrulyIgnoredFiles(dir)
      expect(untracked).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does nothing when there are no newly-ignored tracked files', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await writeFile(join(dir, 'AGENTS.md'), '# agent\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, '.gitignore'), buildGitignore())

      const { untracked } = await untrackTrulyIgnoredFiles(dir)
      expect(untracked).toEqual([])
      expect(await isTracked(dir, 'AGENTS.md')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips silently when the folder is not a git repo', async () => {
    const dir = await makeRepo()
    try {
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')

      const { untracked } = await untrackTrulyIgnoredFiles(dir)
      expect(untracked).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('ignores root linked worktrees without untracking existing project files', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, '.worktrees'))
      await writeFile(join(dir, '.worktrees', 'tracked.txt'), 'retained\n')
      await runGit(dir, ['add', '.worktrees/tracked.txt'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, '.gitignore'), buildGitignore())
      await runGit(dir, ['worktree', 'add', '-b', 'dev', '.worktrees/dev'])

      expect(await runGit(dir, ['check-ignore', '-v', '--no-index', '.worktrees/dev/tracked.txt'])).toContain(
        '/.worktrees/',
      )
      expect((await untrackTrulyIgnoredFiles(dir)).untracked).not.toContain('.worktrees/tracked.txt')
      expect(await isTracked(dir, '.worktrees/tracked.txt')).toBe(true)
      await mkdir(join(dir, 'packages', '.worktrees'), { recursive: true })
      await writeFile(join(dir, 'packages', '.worktrees', 'ordinary.txt'), 'included\n')
      expect(await runGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toContain(
        '?? packages/.worktrees/ordinary.txt',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('untracks custom append matches', async () => {
    const dir = await makeRepo()
    try {
      // given: a tracked scratch/ dir and a custom append rule ignoring it
      await gitInit(dir)
      await mkdir(join(dir, 'scratch'))
      await writeFile(join(dir, 'scratch', 'note.txt'), 'wip\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])

      const { untracked } = await untrackTrulyIgnoredFiles(dir, ['scratch/'])

      expect(untracked).toContain('scratch/note.txt')
      expect(await isTracked(dir, 'scratch/note.txt')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('untracks files through a relocated gitstore', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await relocateGitStore(dir)
      await writeFile(join(dir, '.gitignore'), buildGitignore())

      const { untracked } = await untrackTrulyIgnoredFiles(dir)

      expect(untracked).toContain('public/review.json')
      expect(await isTracked(dir, 'public/review.json')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fails closed: a broad custom pattern never untracks system-managed dirs', async () => {
    const dir = await makeRepo()
    try {
      // given: a `*` custom pattern that would match everything, plus tracked sessions/
      await gitInit(dir)
      await mkdir(join(dir, 'sessions'))
      await writeFile(join(dir, 'sessions', 'history.jsonl'), 'log\n')
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])

      const { untracked } = await untrackTrulyIgnoredFiles(dir, ['*'])

      // then: sessions/ survives, public/ still gets untracked
      expect(untracked).not.toContain('sessions/history.jsonl')
      expect(await isTracked(dir, 'sessions/history.jsonl')).toBe(true)
      expect(untracked).toContain('public/review.json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('commitGitignoreWithUntracks', () => {
  test('commits .gitignore and the untracked removals in one commit', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await writeFile(join(dir, '.gitignore'), 'old\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])

      await writeFile(join(dir, '.gitignore'), buildGitignore())
      const { untracked } = await untrackTrulyIgnoredFiles(dir)

      const committed = await commitGitignoreWithUntracks(dir, '.gitignore', untracked, 'Untrack newly-ignored files')

      expect(committed).toBe(true)
      expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('Untrack newly-ignored files')
      // and: the working tree is clean — both the .gitignore edit and the removal landed
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('')
      expect(await isTracked(dir, 'public/review.json')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('leaves unrelated staged work untouched', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await writeFile(join(dir, '.gitignore'), 'old\n')
      await writeFile(join(dir, 'user.txt'), 'v1\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])

      // given: user has unrelated staged work
      await writeFile(join(dir, 'user.txt'), 'v2\n')
      await runGit(dir, ['add', 'user.txt'])

      await writeFile(join(dir, '.gitignore'), buildGitignore())
      const { untracked } = await untrackTrulyIgnoredFiles(dir)
      await commitGitignoreWithUntracks(dir, '.gitignore', untracked, 'Untrack newly-ignored files')

      // then: the user's staged change is NOT in the commit, still staged
      expect(await runGit(dir, ['diff', '--cached', '--name-only'])).toBe('user.txt')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const forceAtomicFailure = { commitAtomic: async () => false }

  test('falls back to a real-index commit when the plumbing path cannot run', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await writeFile(join(dir, '.gitignore'), 'old\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])

      await writeFile(join(dir, '.gitignore'), buildGitignore())
      const { untracked } = await untrackTrulyIgnoredFiles(dir)

      // when: the atomic plumbing path is forced to fail
      const committed = await commitGitignoreWithUntracks(
        dir,
        '.gitignore',
        untracked,
        'Untrack newly-ignored files',
        forceAtomicFailure,
      )

      // then: the fallback committed, repo is clean, removal landed
      expect(committed).toBe(true)
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('')
      expect(await isTracked(dir, 'public/review.json')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fallback refuses when the staged set is not exactly our changes', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await writeFile(join(dir, '.gitignore'), 'old\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])

      await writeFile(join(dir, '.gitignore'), buildGitignore())
      const { untracked } = await untrackTrulyIgnoredFiles(dir)
      // given: extra unrelated staged work, and the atomic path forced to fail
      await writeFile(join(dir, 'user.txt'), 'wip\n')
      await runGit(dir, ['add', 'user.txt'])

      const committed = await commitGitignoreWithUntracks(
        dir,
        '.gitignore',
        untracked,
        'Untrack newly-ignored files',
        forceAtomicFailure,
      )

      // then: fallback bails rather than sweeping unrelated work into a commit
      expect(committed).toBe(false)
      expect(await runGit(dir, ['diff', '--cached', '--name-only'])).toContain('user.txt')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('atomic commit preserves system-managed work staged by the backup/dreaming machinery', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await mkdir(join(dir, 'memory'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await writeFile(join(dir, 'memory', 'MEMORY.md'), 'v1\n')
      await writeFile(join(dir, '.gitignore'), 'old\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])

      await writeFile(join(dir, '.gitignore'), buildGitignore())
      const { untracked } = await untrackTrulyIgnoredFiles(dir)
      // given: the system has staged a memory/ change (not yet committed)
      await writeFile(join(dir, 'memory', 'MEMORY.md'), 'v2\n')
      await runGit(dir, ['add', 'memory/MEMORY.md'])

      const committed = await commitGitignoreWithUntracks(dir, '.gitignore', untracked, 'Untrack newly-ignored files')

      // then: the hygiene commit landed without memory/, which stays staged for
      // the next system commit — never dropped, never swept in
      expect(committed).toBe(true)
      expect(await runGit(dir, ['show', '--stat', '--format=', 'HEAD'])).not.toContain('memory/MEMORY.md')
      expect(await runGit(dir, ['diff', '--cached', '--name-only'])).toContain('memory/MEMORY.md')
      expect(await runGit(dir, ['show', 'HEAD:memory/MEMORY.md'])).toBe('v1')
      expect(await isTracked(dir, 'public/review.json')).toBe(false)
      expect(await isTracked(dir, 'memory/MEMORY.md')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fallback never drops staged system-managed work', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await mkdir(join(dir, 'sessions'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await writeFile(join(dir, 'sessions', 'history.jsonl'), 'a\n')
      await writeFile(join(dir, '.gitignore'), 'old\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])

      await writeFile(join(dir, '.gitignore'), buildGitignore())
      const { untracked } = await untrackTrulyIgnoredFiles(dir)
      // given: sessions/ staged, and the atomic path forced to fail
      await writeFile(join(dir, 'sessions', 'history.jsonl'), 'a\nb\n')
      await runGit(dir, ['add', 'sessions/history.jsonl'])

      const committed = await commitGitignoreWithUntracks(
        dir,
        '.gitignore',
        untracked,
        'Untrack newly-ignored files',
        forceAtomicFailure,
      )

      // then: fallback refuses, leaving sessions/ staged and tracked — not dropped
      expect(committed).toBe(false)
      expect(await runGit(dir, ['diff', '--cached', '--name-only'])).toContain('sessions/history.jsonl')
      expect(await isTracked(dir, 'sessions/history.jsonl')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('commits .gitignore and untracks through a relocated gitstore', async () => {
    const dir = await makeRepo()
    try {
      await gitInit(dir)
      await mkdir(join(dir, 'public'))
      await writeFile(join(dir, 'public', 'review.json'), '{}\n')
      await writeFile(join(dir, '.gitignore'), 'old\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await relocateGitStore(dir)

      await writeFile(join(dir, '.gitignore'), buildGitignore())
      const { untracked } = await untrackTrulyIgnoredFiles(dir)
      const committed = await commitGitignoreWithUntracks(dir, '.gitignore', untracked, 'Untrack newly-ignored files')

      expect(committed).toBe(true)
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('')
      expect(await isTracked(dir, 'public/review.json')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
