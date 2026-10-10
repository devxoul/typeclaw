import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  computeSourceVersion,
  hostBunVersionWarning,
  resolveSrcRoot,
  TESTED_BUN_VERSION,
  UNVERSIONED_SENTINEL,
  type VersionFs,
} from './version'

function fakeFs(files: Record<string, string>): VersionFs {
  const dirs = new Map<string, Set<string>>()
  for (const path of Object.keys(files)) {
    let dir = dirname(path)
    const fileSet = dirs.get(dir) ?? new Set<string>()
    fileSet.add(basename(path))
    dirs.set(dir, fileSet)

    while (true) {
      const parent = dirname(dir)
      if (parent === dir) break
      const parentSet = dirs.get(parent) ?? new Set<string>()
      parentSet.add(basename(dir))
      dirs.set(parent, parentSet)
      if (!dirs.has(dir)) dirs.set(dir, new Set<string>())
      dir = parent
    }
  }
  return {
    readdir: async (path) => {
      const children = dirs.get(path)
      if (!children) throw new Error(`ENOENT: ${path}`)
      return Array.from(children).map((name) => {
        const childPath = join(path, name)
        return { name, isDirectory: dirs.has(childPath) }
      })
    },
    readFile: async (path) => {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return Buffer.from(content, 'utf8')
    },
  }
}

const fakeSrcRoot = join(tmpdir(), 'typeclaw-version-src')

function srcPath(...parts: string[]): string {
  return join(fakeSrcRoot, ...parts)
}

describe('computeSourceVersion', () => {
  test('produces a stable hash for identical input', async () => {
    const fs = fakeFs({
      [srcPath('a.ts')]: 'export const a = 1',
      [srcPath('b.ts')]: 'export const b = 2',
    })
    const v1 = await computeSourceVersion({ srcRoot: fakeSrcRoot, fs })
    const v2 = await computeSourceVersion({ srcRoot: fakeSrcRoot, fs })
    expect(v1).toBe(v2)
    expect(v1.length).toBe(32)
  })

  test('changes when any source byte changes', async () => {
    const original = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({ [srcPath('a.ts')]: 'export const a = 1' }),
    })
    const modified = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({ [srcPath('a.ts')]: 'export const a = 2' }),
    })
    expect(original).not.toBe(modified)
  })

  test('changes when the Bun runtime changes, so `bun upgrade` respawns the daemon', async () => {
    const files = { [srcPath('a.ts')]: 'export const a = 1' }
    const old = await computeSourceVersion({ srcRoot: fakeSrcRoot, fs: fakeFs(files), runtimeVersion: '1.3.14' })
    const upgraded = await computeSourceVersion({ srcRoot: fakeSrcRoot, fs: fakeFs(files), runtimeVersion: '1.4.3' })
    expect(old).not.toBe(upgraded)
  })

  test('ignores test files', async () => {
    const withoutTests = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({ [srcPath('a.ts')]: 'export const a = 1' }),
    })
    const withTests = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({
        [srcPath('a.ts')]: 'export const a = 1',
        [srcPath('a.test.ts')]: 'test stuff',
      }),
    })
    expect(withoutTests).toBe(withTests)
  })

  test('ignores non-typescript files', async () => {
    const baseline = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({ [srcPath('a.ts')]: 'export const a = 1' }),
    })
    const withReadme = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({
        [srcPath('a.ts')]: 'export const a = 1',
        [srcPath('README.md')]: '# stuff',
      }),
    })
    expect(baseline).toBe(withReadme)
  })

  test('walks nested directories deterministically', async () => {
    const v1 = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({
        [srcPath('a.ts')]: '1',
        [srcPath('sub', 'b.ts')]: '2',
        [srcPath('sub', 'deeper', 'c.ts')]: '3',
      }),
    })
    const v2 = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({
        [srcPath('sub', 'deeper', 'c.ts')]: '3',
        [srcPath('sub', 'b.ts')]: '2',
        [srcPath('a.ts')]: '1',
      }),
    })
    expect(v1).toBe(v2)
  })

  test('moving content between files changes the hash (path is hashed)', async () => {
    const v1 = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({
        [srcPath('a.ts')]: 'foo',
        [srcPath('b.ts')]: 'bar',
      }),
    })
    const v2 = await computeSourceVersion({
      srcRoot: fakeSrcRoot,
      fs: fakeFs({
        [srcPath('a.ts')]: 'bar',
        [srcPath('b.ts')]: 'foo',
      }),
    })
    expect(v1).not.toBe(v2)
  })

  test('reads real filesystem when no fs is injected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-version-'))
    try {
      await mkdir(join(dir, 'sub'), { recursive: true })
      await writeFile(join(dir, 'a.ts'), 'export const a = 1')
      await writeFile(join(dir, 'sub', 'b.ts'), 'export const b = 2')
      await writeFile(join(dir, 'a.test.ts'), 'test')
      const hash = await computeSourceVersion({ srcRoot: dir })
      expect(hash.length).toBe(32)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveSrcRoot', () => {
  test('returns the src dir for a CLI entry inside src/', () => {
    const root = join(tmpdir(), 'typeclaw', 'src')
    expect(resolveSrcRoot(join(root, 'cli', 'index.ts'))).toBe(root)
    expect(resolveSrcRoot(join(root, 'hostd', 'spawn.ts'))).toBe(root)
  })

  test('returns null when no src/ ancestor exists', () => {
    expect(resolveSrcRoot(join(tmpdir(), 'bin', 'typeclaw'))).toBeNull()
    expect(resolveSrcRoot(join(tmpdir(), 'typeclaw', 'dist', 'index.js'))).toBeNull()
  })
})

describe('UNVERSIONED_SENTINEL', () => {
  test('is a stable string both peers can compare', () => {
    expect(UNVERSIONED_SENTINEL).toBe('unversioned')
  })
})

describe('hostBunVersionWarning', () => {
  test('warns on a host Bun older than the tested version', () => {
    expect(hostBunVersionWarning('1.3.14')).toContain('bun upgrade')
  })

  test('is silent on the tested version or newer', () => {
    expect(hostBunVersionWarning(TESTED_BUN_VERSION)).toBeNull()
    expect(hostBunVersionWarning('1.4.3')).toBeNull()
    expect(hostBunVersionWarning('2.0.0')).toBeNull()
  })

  test('is silent when the runtime is not Bun', () => {
    expect(hostBunVersionWarning(undefined)).toBeNull()
  })
})
