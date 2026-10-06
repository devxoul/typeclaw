import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GitCommandDecision, GitPushProvenance } from './git-command'
import {
  authorizeGrantedPush,
  buildGrantedPushCommand,
  recordGrantedPush,
  resolveGrantedPush,
  takeGrantedPush,
} from './granted-push'

const grant = { repos: ['Acme/Widgets', 'acme/other'] }

function push(overrides: Partial<Extract<GitPushProvenance, { kind: 'configured-remote' }>> = {}): GitCommandDecision {
  return {
    kind: 'inject',
    repoSlug: 'acme/widgets',
    access: 'write',
    pushProvenance: {
      kind: 'configured-remote',
      remote: 'origin',
      pushUrls: ['https://github.com/acme/widgets.git'],
      repoSlugs: ['acme/widgets'],
      worktreeTopLevel: '/agent/workspace/widgets',
      sourceCwd: '/agent/workspace/widgets',
      refspecs: ['chore/bump-deps'],
      setUpstream: false,
      complete: true,
      ...overrides,
    },
  }
}

describe('authorizeGrantedPush', () => {
  test('allows a single plain branch and rewrites it to an explicit, unforced branch refspec', () => {
    expect(authorizeGrantedPush(push(), grant)).toEqual({
      kind: 'allow',
      push: {
        repoSlug: 'acme/widgets',
        pushUrls: ['https://github.com/acme/widgets.git'],
        command:
          "git -C '/agent/workspace/widgets' push --no-follow-tags --recurse-submodules=no 'origin' 'refs/heads/chore/bump-deps:refs/heads/chore/bump-deps'",
      },
    })
    expect(authorizeGrantedPush(push({ setUpstream: true }), grant)).toMatchObject({
      kind: 'allow',
      push: { command: expect.stringContaining(' --set-upstream ') },
    })
  })

  test('resolves HEAD to the checked-out branch and denies a detached HEAD', async () => {
    const onBranch = await resolveGrantedPush(push({ refspecs: ['HEAD'] }), grant, {
      resolveCurrentBranch: async () => 'feature/x',
    })
    expect(onBranch).toMatchObject({
      kind: 'allow',
      push: { command: expect.stringContaining("'refs/heads/feature/x:refs/heads/feature/x'") },
    })

    const detached = await resolveGrantedPush(push({ refspecs: ['HEAD'] }), grant, {
      resolveCurrentBranch: async () => null,
    })
    expect(detached).toMatchObject({ kind: 'deny' })
  })

  test('denies a repo that is not configured for the GitHub channel', () => {
    expect(authorizeGrantedPush(push({ repoSlugs: ['acme/elsewhere'] }), grant)).toMatchObject({ kind: 'deny' })
    expect(authorizeGrantedPush(push(), { repos: [] })).toMatchObject({ kind: 'deny' })
  })

  test('denies refspecs that delete, force, retarget, or push more than one ref', () => {
    for (const refspecs of [
      [],
      ['a', 'b'],
      ['HEAD:main'],
      [':feature'],
      ['+feature'],
      ['refs/tags/v1'],
      ['feature@{1}'],
      ['../escape'],
      ['-n'],
    ]) {
      expect(authorizeGrantedPush(push({ refspecs }), grant)).toMatchObject({ kind: 'deny' })
    }
  })

  test('denies explicit URLs, incomplete provenance, multi-destination remotes, and reads', () => {
    const explicitUrl: GitCommandDecision = {
      kind: 'inject',
      repoSlug: 'acme/widgets',
      access: 'write',
      pushProvenance: { kind: 'explicit-url', complete: true },
    }
    expect(authorizeGrantedPush(explicitUrl, grant)).toMatchObject({ kind: 'deny' })
    expect(authorizeGrantedPush(push({ complete: false }), grant)).toMatchObject({ kind: 'deny' })
    expect(
      authorizeGrantedPush(
        push({
          repoSlugs: ['acme/widgets', 'acme/other'],
          pushUrls: ['https://github.com/acme/widgets.git', 'https://github.com/acme/other.git'],
        }),
        grant,
      ),
    ).toMatchObject({ kind: 'deny' })
    expect(authorizeGrantedPush({ kind: 'inject', repoSlug: 'acme/widgets', access: 'read' }, grant)).toMatchObject({
      kind: 'deny',
    })
    expect(authorizeGrantedPush({ kind: 'pass-through' }, grant)).toMatchObject({ kind: 'deny' })
  })
})

describe('granted push handoff', () => {
  test('is consumed exactly once per tool call', () => {
    const granted = { repoSlug: 'acme/widgets', pushUrls: ['https://github.com/acme/widgets.git'], command: 'git push' }
    recordGrantedPush('call-1', granted)

    expect(takeGrantedPush('call-1')).toEqual(granted)
    expect(takeGrantedPush('call-1')).toBeUndefined()
    expect(takeGrantedPush('call-2')).toBeUndefined()
  })
})

// Runs the exact command a grant-funded push executes against a local bare
// remote whose repo config tries to widen it, then inspects the remote's refs.
describe.skipIf(process.platform === 'win32')('buildGrantedPushCommand against real git', () => {
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout
  }

  function hostileCheckout(): { root: string; work: string; bare: string } {
    const root = mkdtempSync(join(tmpdir(), 'tc-granted-push-'))
    const bare = join(root, 'remote.git')
    const work = join(root, 'work')
    git(root, 'init', '-q', '--bare', bare)
    git(root, 'init', '-q', '-b', 'main', work)
    git(work, 'remote', 'add', 'origin', bare)
    for (const [key, value] of [
      ['user.name', 'Test'],
      ['user.email', 'test@example.com'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['remote.origin.push', '+refs/heads/topic:refs/heads/main'],
      ['push.default', 'upstream'],
      ['push.followTags', 'true'],
    ] as const) {
      git(work, 'config', key, value)
    }
    git(work, 'commit', '-q', '--allow-empty', '-m', 'base')
    git(work, 'checkout', '-q', '-b', 'topic')
    git(work, 'commit', '-q', '--allow-empty', '-m', 'work')
    git(work, 'tag', '-a', 'v1', '-m', 'annotated, reachable from topic')
    return { root, work, bare }
  }

  function run(command: string): number {
    return spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).status ?? -1
  }

  test('publishes only refs/heads/<branch>, ignoring configured force-retarget mappings and follow-tags', () => {
    const { root, work, bare } = hostileCheckout()
    try {
      expect(run(buildGrantedPushCommand({ cwd: work, remote: 'origin', branch: 'topic', setUpstream: true }))).toBe(0)
      expect(git(bare, 'for-each-ref', '--format=%(refname)').trim().split('\n')).toEqual(['refs/heads/topic'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a tag-only name fails instead of publishing the tag', () => {
    const { root, work, bare } = hostileCheckout()
    try {
      expect(run(buildGrantedPushCommand({ cwd: work, remote: 'origin', branch: 'v1', setUpstream: false }))).not.toBe(
        0,
      )
      expect(git(bare, 'for-each-ref', '--format=%(refname)').trim()).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
