import { describe, expect, test } from 'bun:test'

import { createPermissionService, rolesConfigSchema } from '@/permissions'

import { LiveSubagentRegistry, type LiveSubagent } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import { INCOMPLETE_REVIEW_VERDICT } from '../subagents'
import { createSubagentOutputTool } from './subagent-output'

const ctx = {} as Parameters<ReturnType<typeof createSubagentOutputTool>['execute']>[4]

const guestOrigin: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C_GEN',
  thread: null,
}

// guest is granted subagent.output explicitly so the only thing that can deny
// a granted guest is the provenance cap, not a missing permission. member and
// owner match rules cover specific authors so role-scoped behavior can be
// exercised through the real permission service.
function capPermissions() {
  const roles = rolesConfigSchema.parse({
    owner: { match: ['slack:T0123 author:U_OWNER'] },
    guest: { match: [], permissions: ['subagent.output', 'subagent.cancel'] },
    member: { match: ['slack:T0123 author:U_MEMBER'], permissions: ['subagent.output', 'subagent.cancel'] },
  })
  return createPermissionService({ roles })
}

const memberOrigin: SessionOrigin = { ...guestOrigin, lastInboundAuthorId: 'U_MEMBER' }
const ownerOrigin: SessionOrigin = { ...guestOrigin, lastInboundAuthorId: 'U_OWNER' }

function makeLive(overrides: Partial<LiveSubagent> = {}): LiveSubagent {
  return {
    taskId: 'bg_o1',
    sessionId: 'ses_s1',
    subagentName: 'explorer',
    parentSessionId: 'ses_parent',
    startedAt: 1_000,
    status: 'running',
    abort: async () => {},
    ...overrides,
  }
}

test('running polling never captures coverage; final output waits for durable coverage and fails closed', async () => {
  const liveRegistry = new LiveSubagentRegistry()
  liveRegistry.register(makeLive())
  const coverage = Promise.withResolvers<void>()
  const capturing = Promise.withResolvers<void>()
  let captures = 0
  const tool = createSubagentOutputTool({
    liveRegistry,
    getOrigin: () => guestOrigin,
    callerSessionId: 'ses_parent',
    router: {
      attachBackgroundResultCoverage: async () => {
        captures++
        capturing.resolve()
        await coverage.promise
      },
    },
  })
  const running = await tool.execute('poll', { task_id: 'bg_o1' }, undefined, undefined, ctx)
  expect(running.details).toMatchObject({ status: 'running' })
  expect(captures).toBe(0)
  liveRegistry.recordCompletionIfRunning('bg_o1', { ok: true, finalMessage: 'result', durationMs: 100 })
  let returned = false
  const final = tool.execute('fetch', { task_id: 'bg_o1' }, undefined, undefined, ctx).then((value) => {
    returned = true
    return value
  })
  await capturing.promise
  expect(returned).toBe(false)
  coverage.resolve()
  expect((await final).details).toMatchObject({ status: 'completed', finalMessage: 'result' })
  const failed = createSubagentOutputTool({
    liveRegistry,
    getOrigin: () => guestOrigin,
    callerSessionId: 'ses_parent',
    router: {
      attachBackgroundResultCoverage: async () => {
        throw new Error('storage failed')
      },
    },
  })
  await expect(failed.execute('failed', { task_id: 'bg_o1' }, undefined, undefined, ctx)).rejects.toThrow(
    'storage failed',
  )
})

describe('createSubagentOutputTool — unknown task_id', () => {
  test('returns ok=false with helpful error', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_missing' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('Unknown task_id')
  })
})

describe('createSubagentOutputTool — running status', () => {
  test('returns status=running with status_summary and recent events', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive({ startedAt: 1_000 }))
    liveRegistry.recordEvent('bg_o1', { kind: 'tool', name: 'grep', ok: true, ts: 1_500 })
    liveRegistry.recordEvent('bg_o1', { kind: 'tool', name: 'read', ok: true, ts: 2_000 })

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 3_000,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)

    const details = result.details as {
      ok: boolean
      status?: string
      eventsCount?: number
      statusSummary?: string
    }
    expect(details.ok).toBe(true)
    expect(details.status).toBe('running')
    expect(details.eventsCount).toBe(3)
    expect(details.statusSummary).toMatch(/Running for 2s/)
    expect(details.statusSummary).toContain('Last: tool read')
    const firstContent = result.content[0]
    const text = firstContent?.type === 'text' ? firstContent.text : ''
    expect(text).toBe(details.statusSummary ?? '')
  })

  test('eventsRecent is bounded to 10 events', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    for (let i = 0; i < 25; i++) {
      liveRegistry.recordEvent('bg_o1', { kind: 'tool', name: `t${i}`, ok: true, ts: 1_500 + i })
    }
    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 3_000,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; eventsRecent?: { kind: string; name?: string }[] }
    expect(details.eventsRecent?.length).toBe(10)
  })
})

describe('createSubagentOutputTool — completed status', () => {
  test('returns final message when completion has one', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    liveRegistry.recordCompletion('bg_o1', {
      ok: true,
      finalMessage: 'Found 3 matches in src/api.',
      durationMs: 2_500,
    })

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 4_000,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean; status?: string; finalMessage?: string; durationMs?: number }
    expect(details.ok).toBe(true)
    expect(details.status).toBe('completed')
    expect(details.finalMessage).toBe('Found 3 matches in src/api.')
    expect(details.durationMs).toBe(2_500)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toBe('Found 3 matches in src/api.')
  })

  test('synthesizes content text when completion has no final message', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    liveRegistry.recordCompletion('bg_o1', { ok: true, durationMs: 1_000 })

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 2_000,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/explorer completed in/)
  })
})

describe('createSubagentOutputTool — failed status', () => {
  test('returns error envelope without setting ok=false (the QUERY succeeded; the SUBAGENT failed)', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    liveRegistry.recordCompletion('bg_o1', { ok: false, error: 'provider rate limit', durationMs: 500 })

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 1_500,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean; status?: string; error?: string }
    expect(details.ok).toBe(true)
    expect(details.status).toBe('failed')
    expect(details.error).toBe('provider rate limit')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('failed after')
    expect(text).toContain('provider rate limit')
  })

  test('labels recovered output as partial recovery data and explicitly not a completed verdict', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive({ subagentName: 'reviewer' }))
    liveRegistry.recordCompletion('bg_o1', {
      ok: false,
      error: 'parent drain timeout',
      durationMs: 600_000,
      finalMessage: '<review>\n<verdict>approve</verdict>\n</review>',
    })
    const tool = createSubagentOutputTool({ liveRegistry, getOrigin: () => undefined })

    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const details = result.details as {
      status?: string
      recoveryData?: boolean
      partial?: boolean
      verdict?: boolean
      finalMessage?: string
    }
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''

    expect(details.status).toBe('failed')
    expect(details.recoveryData).toBe(true)
    expect(details.partial).toBe(true)
    expect(details.verdict).toBe(false)
    expect(details.finalMessage).toContain('<verdict>approve</verdict>')
    expect(text).toContain('PARTIAL RECOVERY DATA')
    expect(text).toContain('not a completed review or verdict')
  })

  test('provider-failure sentinel remains recovery data and cannot become a real verdict', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive({ subagentName: 'reviewer' }))
    liveRegistry.recordCompletion('bg_o1', {
      ok: false,
      error: 'parent drain timeout',
      durationMs: 600_000,
      finalMessage: `<review><verdict>${INCOMPLETE_REVIEW_VERDICT}</verdict></review>`,
    })
    const tool = createSubagentOutputTool({ liveRegistry, getOrigin: () => undefined })

    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const details = result.details as { status?: string; recoveryData?: boolean; verdict?: boolean }

    expect(details.status).toBe('failed')
    expect(details.recoveryData).toBe(true)
    expect(details.verdict).toBe(false)
    expect(INCOMPLETE_REVIEW_VERDICT).not.toBe('approve')
    expect(INCOMPLETE_REVIEW_VERDICT).not.toBe('request-changes')
    expect(INCOMPLETE_REVIEW_VERDICT).not.toBe('comment')
  })
})

describe('createSubagentOutputTool — never blocks', () => {
  test('returns immediately even when the subagent is still running', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 2_000,
    })

    const start = Date.now()
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(50)
    const details = result.details as { ok: boolean; status?: string }
    expect(details.ok).toBe(true)
    expect(details.status).toBe('running')
  })
})

describe('createSubagentOutputTool — permissions', () => {
  test('denied when origin lacks subagent.output', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => ({ kind: 'channel', adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null }),
      permissions: {
        has: () => false,
        resolveRole: () => 'guest',
        compareRoleSeverity: () => undefined,
        permissionsForRole: () => undefined,
        describe: () => ({ role: 'guest', permissions: [] }),
        replaceRoles: () => {},
      },
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('denied')
  })
})

describe('createSubagentOutputTool — provenance cap', () => {
  const OPAQUE = 'subagent.output denied: unknown task_id or insufficient role'

  function makeTool(registry: LiveSubagentRegistry, origin: SessionOrigin) {
    return createSubagentOutputTool({ liveRegistry: registry, getOrigin: () => origin, permissions: capPermissions() })
  }

  async function errorFor(origin: SessionOrigin, registry: LiveSubagentRegistry, taskId: string): Promise<string> {
    const result = await makeTool(registry, origin).execute('c', { task_id: taskId }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    return details.error ?? ''
  }

  test('member can read a member-spawned subagent', async () => {
    const registry = new LiveSubagentRegistry()
    registry.register(makeLive({ spawnedByRole: 'member' }))
    const result = await makeTool(registry, memberOrigin).execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    expect((result.details as { ok: boolean }).ok).toBe(true)
  })

  test('member can read a guest-spawned subagent (same-or-lower spawner allowed)', async () => {
    const registry = new LiveSubagentRegistry()
    registry.register(makeLive({ spawnedByRole: 'guest' }))
    const result = await makeTool(registry, memberOrigin).execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    expect((result.details as { ok: boolean }).ok).toBe(true)
  })

  test('a low-role caller cannot distinguish absent, capped, or missing-provenance tasks', async () => {
    const capped = new LiveSubagentRegistry()
    capped.register(makeLive({ spawnedByRole: 'member' }))
    const noProvenance = new LiveSubagentRegistry()
    noProvenance.register(makeLive())
    const empty = new LiveSubagentRegistry()

    const absentMsg = await errorFor(guestOrigin, empty, 'bg_o1')
    const cappedMsg = await errorFor(guestOrigin, capped, 'bg_o1')
    const noProvenanceMsg = await errorFor(guestOrigin, noProvenance, 'bg_o1')

    expect(absentMsg).toBe(OPAQUE)
    expect(cappedMsg).toBe(OPAQUE)
    expect(noProvenanceMsg).toBe(OPAQUE)
  })

  test('owner gets a truthful Unknown task_id for an absent task', async () => {
    const registry = new LiveSubagentRegistry()
    const msg = await errorFor(ownerOrigin, registry, 'bg_missing')
    expect(msg).toContain('Unknown task_id')
  })

  test('owner bypasses the cap and missing-provenance fail-closed', async () => {
    const higher = new LiveSubagentRegistry()
    higher.register(makeLive({ spawnedByRole: 'member' }))
    const noProvenance = new LiveSubagentRegistry()
    noProvenance.register(makeLive())

    const r1 = await makeTool(higher, ownerOrigin).execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const r2 = await makeTool(noProvenance, ownerOrigin).execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    expect((r1.details as { ok: boolean }).ok).toBe(true)
    expect((r2.details as { ok: boolean }).ok).toBe(true)
  })

  test('a caller lacking the base permission gets the same denial whether the task exists or not', async () => {
    const denyBase = createPermissionService({
      roles: rolesConfigSchema.parse({ guest: { match: [], permissions: [] } }),
    })
    const present = new LiveSubagentRegistry()
    present.register(makeLive({ spawnedByRole: 'member' }))
    const absent = new LiveSubagentRegistry()
    const tool = (registry: LiveSubagentRegistry) =>
      createSubagentOutputTool({ liveRegistry: registry, getOrigin: () => guestOrigin, permissions: denyBase })

    const presentRes = await tool(present).execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const absentRes = await tool(absent).execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const presentErr = (presentRes.details as { error?: string }).error
    const absentErr = (absentRes.details as { error?: string }).error
    expect(presentErr).toBe('subagent.output denied: insufficient permissions')
    expect(absentErr).toBe(presentErr)
  })

  test('no permission service preserves truthful unknown and open access', async () => {
    const registry = new LiveSubagentRegistry()
    registry.register(makeLive({ spawnedByRole: 'owner' }))
    const empty = new LiveSubagentRegistry()
    const allow = createSubagentOutputTool({ liveRegistry: registry, getOrigin: () => guestOrigin })
    const miss = createSubagentOutputTool({ liveRegistry: empty, getOrigin: () => guestOrigin })

    const allowRes = await allow.execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const missRes = await miss.execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    expect((allowRes.details as { ok: boolean }).ok).toBe(true)
    expect((missRes.details as { error?: string }).error).toContain('Unknown task_id')
  })
})

describe('createSubagentOutputTool — subagent caller ownership scope', () => {
  const subagentCaller: SessionOrigin = {
    kind: 'subagent',
    subagent: 'operator',
    parentSessionId: 'ses_root',
    spawnedByOrigin: { kind: 'tui', sessionId: 'ses_root' },
  }

  test('a subagent caller can read a child it spawned (live.parentSessionId === callerSessionId)', async () => {
    const registry = new LiveSubagentRegistry()
    registry.register(makeLive({ parentSessionId: 'ses_operator', spawnedByRole: 'owner' }))
    const tool = createSubagentOutputTool({
      liveRegistry: registry,
      getOrigin: () => subagentCaller,
      permissions: capPermissions(),
      callerSessionId: 'ses_operator',
    })

    const res = await tool.execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    expect((res.details as { ok: boolean }).ok).toBe(true)
  })

  test('a subagent caller cannot read a sibling/parent-branch run it did not spawn', async () => {
    const registry = new LiveSubagentRegistry()
    registry.register(makeLive({ parentSessionId: 'ses_other_branch', spawnedByRole: 'owner' }))
    const tool = createSubagentOutputTool({
      liveRegistry: registry,
      getOrigin: () => subagentCaller,
      permissions: capPermissions(),
      callerSessionId: 'ses_operator',
    })

    const res = await tool.execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const details = res.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('not owned by caller')
  })

  test('a main-session owner caller keeps global visibility (no ownership scope)', async () => {
    const registry = new LiveSubagentRegistry()
    registry.register(makeLive({ parentSessionId: 'ses_other_branch', spawnedByRole: 'member' }))
    const tool = createSubagentOutputTool({
      liveRegistry: registry,
      getOrigin: () => ownerOrigin,
      permissions: capPermissions(),
      callerSessionId: 'ses_main',
    })

    const res = await tool.execute('c', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    expect((res.details as { ok: boolean }).ok).toBe(true)
  })
})
