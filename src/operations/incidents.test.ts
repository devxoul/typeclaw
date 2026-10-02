import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'

import { fingerprintIncident, IncidentLedger, incidentsPath, renderIncidentHint } from './incidents'

describe('operational incident ledger', () => {
  test('fingerprints structured facts only and normalizes bin casing', () => {
    expect(fingerprintIncident({ kind: 'bash-command-not-found', bin: 'OpenSoma' })).toBe(
      'bash:command-not-found:opensoma',
    )
    expect(fingerprintIncident({ kind: 'sandbox-proc-unavailable' })).toBe('sandbox:proc-unavailable')
    expect(fingerprintIncident({ kind: 'declared-skill-bin-unresolved', bin: 'OpenSoma' })).toBe(
      'skill-bin:declared-but-unresolved:opensoma',
    )
    expect(fingerprintIncident({ kind: 'builtin-search-bin-unavailable', bin: 'rg' })).toBe(
      'builtin-search:bin-unavailable:rg',
    )
    expect(fingerprintIncident({ kind: 'builtin-search-bin-unavailable', bin: 'fd' })).toBe(
      'builtin-search:bin-unavailable:fd',
    )
  })

  test('marks recurrence only after the fingerprint appears in a different session', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-incidents-'))
    const ledger = new IncidentLedger(agentDir)
    const fact = { kind: 'bash-command-not-found' as const, bin: 'opensoma' }

    const first = await ledger.record(fact, 'session-a', new Date('2026-08-01T00:00:00.000Z'))
    const sameSessionRetry = await ledger.record(fact, 'session-a', new Date('2026-08-01T00:01:00.000Z'))
    const secondSession = await ledger.record(fact, 'session-b', new Date('2026-08-02T00:00:00.000Z'))

    expect(first).toMatchObject({ count: 1, recurrent: false, status: 'unresolved' })
    expect(sameSessionRetry).toMatchObject({ count: 2, recurrent: false, lastSessionId: 'session-a' })
    expect(secondSession).toMatchObject({
      fingerprint: 'bash:command-not-found:opensoma',
      count: 3,
      recurrent: true,
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-02T00:00:00.000Z',
      lastSessionId: 'session-b',
    })
    const persisted = await readFile(incidentsPath(agentDir), 'utf8')
    expect(persisted).not.toContain('/tmp/private')
    expect(persisted).not.toContain('--password')
    expect(JSON.parse(persisted)).toEqual({ version: 1, incidents: [secondSession] })
    expect(renderIncidentHint(secondSession)).toBe(
      'TYPECLAW_OPERATIONAL_INCIDENT {"fingerprint":"bash:command-not-found:opensoma","occurrence":3,"recurrent":true,"status":"unresolved","automaticRepair":"unavailable","provenance":"typeclaw-environment","action":"escalate-recurrent-environment-issue-to-operator","doNot":"delegate-the-original-task-to-the-user"}',
    )
  })

  test('serializes read-modify-write updates against a lock held by another process', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-incidents-contention-'))
    const ledger = new IncidentLedger(agentDir)
    const fact = { kind: 'bash-command-not-found' as const, bin: 'opensoma' }
    await ledger.record(fact, 'parent-session')

    const path = incidentsPath(agentDir)
    const startedPath = join(agentDir, 'worker-started')
    const donePath = join(agentDir, 'worker-done')
    const release = await lockfile.lock(path, { realpath: false })
    const source = [
      `import { IncidentLedger } from ${JSON.stringify(new URL('./incidents.ts', import.meta.url).href)}`,
      `await Bun.write(process.env.STARTED_PATH, 'started')`,
      `await new IncidentLedger(process.env.AGENT_DIR).record({ kind: 'bash-command-not-found', bin: 'opensoma' }, 'worker-session')`,
      `await Bun.write(process.env.DONE_PATH, 'done')`,
    ].join(';')
    const child = Bun.spawn([process.execPath, '-e', source], {
      env: {
        ...process.env,
        AGENT_DIR: agentDir,
        STARTED_PATH: startedPath,
        DONE_PATH: donePath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      expect(await waitForFile(startedPath, 2_000)).toBe(true)
      expect(await waitForFile(donePath, 300)).toBe(false)
    } finally {
      await release()
    }

    const stderr = await new Response(child.stderr).text()
    expect(await child.exited).toBe(0)
    expect(stderr).toBe('')
    expect(await waitForFile(donePath, 2_000)).toBe(true)
    expect((await ledger.record(fact, 'parent-session')).count).toBe(3)
  })

  test('atomically resolves a recorded fingerprint', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-incidents-resolve-'))
    const ledger = new IncidentLedger(agentDir)
    const incident = await ledger.record(
      { kind: 'sandbox-proc-unavailable' },
      'repair-session',
      new Date('2026-08-03T00:00:00.000Z'),
    )

    expect(await ledger.resolve(incident.fingerprint)).toBe(true)
    expect(JSON.parse(await readFile(incidentsPath(agentDir), 'utf8'))).toMatchObject({
      incidents: [{ fingerprint: 'sandbox:proc-unavailable', status: 'resolved' }],
    })
  })
})

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return true
    await Bun.sleep(10)
  }
  return Bun.file(path).exists()
}
