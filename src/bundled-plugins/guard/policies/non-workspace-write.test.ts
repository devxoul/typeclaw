import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { isWindows } from '@/shared'

import { checkNonWorkspaceWriteGuard } from './non-workspace-write'

describe('non-workspace-write guard policy', () => {
  test('allows unacknowledged writes to public/ (the guest-visible zone)', async () => {
    const agentDir = await makeAgentDir()

    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: 'public/report.md', content: 'shared' },
      agentDir,
      origin: { kind: 'tui', sessionId: 's1' },
    })

    expect(result).toBeUndefined()
  })

  // Container scratch is the Linux /tmp namespace; Windows host path semantics are tracked in #899.
  test.skipIf(isWindows())('allows unacknowledged writes under /tmp (virtual per-session scratch)', async () => {
    const agentDir = await makeAgentDir()

    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: '/tmp/review.json', content: '{}' },
      agentDir,
      origin: { kind: 'tui', sessionId: 's1' },
    })

    expect(result).toBeUndefined()
  })

  test('does not treat a relative workspace path that symlink-escapes into /tmp as scratch', async () => {
    // The escape target sits under /tmp (a sibling of the tmpdir agent dir), but
    // the model's RAW path is `workspace/...` — lexical intent is a workspace
    // write, not /tmp scratch, so the escape rule must win and block it.
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-tmp-escape-'))
    const agentDir = path.join(root, 'agent')
    const workspaceDir = path.join(agentDir, 'workspace')
    const outsideDir = path.join(root, 'outside')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(outsideDir)
    await symlink(outsideDir, path.join(workspaceDir, 'escape'))

    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: 'workspace/escape/file.txt', content: 'x' },
      agentDir,
      origin: { kind: 'tui', sessionId: 's1' },
    })

    expect(result?.kind).toBe('acknowledgement-required')
  })

  test('still blocks a /tmp-rooted agent dir from writing its own memory/ via the /tmp allowance', async () => {
    // makeAgentDir lives under the OS tmpdir, which is /tmp on Linux — so its
    // own memory/ path resolves under /tmp. The /tmp scratch allowance must not
    // wave that through; it is the agent surface, governed by the normal rules.
    const agentDir = await makeAgentDir()

    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: 'memory/notes/s1.md', content: 'x' },
      agentDir,
      origin: { kind: 'tui', sessionId: 's1' },
    })

    expect(result).toEqual({
      kind: 'acknowledgement-required',
      reason: expect.stringContaining('nonWorkspaceWrite'),
    })
  })

  test('blocks main-agent writes to memory files outside explicit memory allowlists', async () => {
    const agentDir = await makeAgentDir()

    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: 'memory/notes/s1.md', content: 'summary' },
      agentDir,
      origin: { kind: 'tui', sessionId: 's1' },
    })

    expect(result).toEqual({
      kind: 'acknowledgement-required',
      reason: expect.stringContaining('nonWorkspaceWrite'),
    })
  })
  test('still blocks an ordinary session writing the backup message path', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: path.join(agentDir, '.typeclaw', 'backup-message.tmp'), content: 'chore: backup' },
      agentDir,
      origin: { kind: 'tui', sessionId: 's1' },
    })
    expect(result).toEqual({
      kind: 'acknowledgement-required',
      reason: expect.stringContaining('nonWorkspaceWrite'),
    })
  })
  test('still blocks an ordinary session writing the backup diagnosis path', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: path.join(agentDir, 'sessions', 'backup-diagnostics.log'), content: 'diagnosis' },
      agentDir,
      origin: { kind: 'tui', sessionId: 's1' },
    })
    expect(result).toEqual({
      kind: 'acknowledgement-required',
      reason: expect.stringContaining('nonWorkspaceWrite'),
    })
  })
})

async function makeAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-non-workspace-write-'))
  await mkdir(path.join(agentDir, 'workspace'), { recursive: true })
  return agentDir
}
