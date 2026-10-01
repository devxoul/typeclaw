import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolResultMessage } from '@earendil-works/pi-ai'
import { defineTool as definePiTool, SessionManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { PLANNER_SYSTEM_PROMPT } from '@/bundled-plugins/planner/planner'
import { SCOUT_SYSTEM_PROMPT } from '@/bundled-plugins/scout/scout'
import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig } from '@/channels/schema'
import { configSchema, type Models, resolveProfile, type ResolvedProfile } from '@/config'
import { __resetConfigForTesting, reloadConfig } from '@/config/config'
import type { ModelRef } from '@/config/providers'
import { createHookBus, type PluginRegistry } from '@/plugin'
import { emptyRegistry } from '@/plugin/registry'
import { createStream } from '@/stream'

import { invalidateProviderAuthCache } from './auth'
import {
  buildChannelTools,
  buildSubagentOrchestrationTools,
  attachLoopGuardTurnTracking,
  composeSystemPrompt,
  createOverrideResourceLoader,
  createResourceLoader,
  createSessionWithDispose,
  deriveSystemPromptMode,
  formatRestartNotice,
  formatRestartNoticeOriginating,
  getBundledSkillsDir,
  resolveSessionThinkingLevel,
  subscribeRestartNotice,
  wrapSystemTools,
} from './index'
import { LiveSubagentRegistry } from './live-subagents'
import { PROACTIVE_NEXT_STEP_NUDGE } from './proactive-next-step-nudge'
import { detectProviderError, wrapTransformContextWithLocalFailureMarker } from './provider-error'
import type { SessionOrigin } from './session-origin'
import type { CreateSessionForSubagent, SubagentRegistry } from './subagents'
import { DEFAULT_SYSTEM_PROMPT, SLIM_SYSTEM_PROMPT } from './system-prompt'

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
}

async function initGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['init', '-q', '-b', 'main'])
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-agent-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('attachLoopGuardTurnTracking', () => {
  test('advances only on awaited agent turn_start events and unsubscribes cleanly', () => {
    let listener: ((event: unknown) => void) | undefined
    let unsubscribed = false
    let turns = 0
    const unsubscribe = attachLoopGuardTurnTracking(
      {
        subscribe: (next) => {
          listener = next
          return () => {
            unsubscribed = true
          }
        },
      },
      () => {
        turns += 1
      },
    )

    listener?.({ type: 'message_start' })
    listener?.({ type: 'turn_start' })
    listener?.({ type: 'turn_start' })
    expect(turns).toBe(2)

    unsubscribe()
    expect(unsubscribed).toBe(true)
  })
})

describe('wrapSystemTools', () => {
  test('hookless composition denies canonical secret operands before a custom system tool executes', async () => {
    await writeFile(join(agentDir, '.env'), 'EXAMPLE_TOKEN=placeholder')
    let executed = false
    const lookAt = definePiTool({
      name: 'look_at',
      label: 'look_at',
      description: '',
      parameters: Type.Any(),
      async execute() {
        executed = true
        return { content: [], details: undefined }
      },
    })
    const tools = wrapSystemTools([lookAt], {
      hooks: createHookBus(),
      sessionId: 'hookless',
      agentDir,
      getOrigin: () => undefined,
      getAbort: () => undefined,
      getLoopGuardTurn: () => undefined,
    })

    await expect(
      tools[0]!.execute('call', { images: [{ path: '.env' }] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/not available to LLM tools/)
    expect(executed).toBeFalse()
  })
})

describe('createResourceLoader', () => {
  test('starts the system prompt with the typeclaw default instead of pi default', async () => {
    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })

  test('slim mode does not render or validate the public-subagent roster', async () => {
    // given — a public subagent with a blank rosterDescription, which would
    // make renderPublicSubagentRoster throw if it were called
    const badRegistry: SubagentRegistry = {
      offender: { systemPrompt: 'x', visibility: 'public', rosterDescription: '' },
    }

    // when / then — a slim session never shows the roster, so it must not throw
    const loader = await createResourceLoader({
      agentDir,
      mode: 'slim',
      subagentRegistry: badRegistry,
    })
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(SLIM_SYSTEM_PROMPT)).toBe(true)
  })

  test('full mode surfaces a bad public rosterDescription as a thrown error', async () => {
    // given
    const badRegistry: SubagentRegistry = {
      offender: { systemPrompt: 'x', visibility: 'public', rosterDescription: '' },
    }

    // when / then
    await expect(createResourceLoader({ agentDir, mode: 'full', subagentRegistry: badRegistry })).rejects.toThrow(
      /offender.*rosterDescription/,
    )
  })

  test('does not append SYSTEM.md files discovered by pi defaults', async () => {
    // Pi's DefaultResourceLoader auto-appends ~/.pi/agent/APPEND_SYSTEM.md and
    // .pi/APPEND_SYSTEM.md. Typeclaw owns the whole system prompt, so nothing
    // from pi's discovery should leak in.

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    expect(loader.getAppendSystemPrompt()).toEqual([])
  })

  test('injects IDENTITY.md and SOUL.md contents into the system prompt', async () => {
    // given
    await writeFile(join(agentDir, 'IDENTITY.md'), 'I am Tester.')
    await writeFile(join(agentDir, 'SOUL.md'), 'Pedantic and kind.')

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('I am Tester.')
    expect(prompt).toContain('Pedantic and kind.')
  })

  test('signals missing identity files so the model can see they should exist', async () => {
    // when (no files written)
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('[MISSING]')
    expect(prompt).toContain('IDENTITY.md')
    expect(prompt).toContain('SOUL.md')
  })

  test('does not inject MEMORY.md into the system prompt', async () => {
    await writeFile(join(agentDir, 'MEMORY.md'), 'Neo prefers terse replies.')

    const loader = await createResourceLoader({ agentDir })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('Neo prefers terse replies.')
  })

  test('does not append MEMORY.md after gitNudge', async () => {
    // given: a git repo with a dirty tracked file so gitNudge renders, and a
    // populated MEMORY.md that must stay out of the system prompt.
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'tracked.md'), 'initial')
    await runGit(agentDir, ['add', '.'])
    await runGit(agentDir, ['commit', '-q', '-m', 'init'])
    await writeFile(join(agentDir, 'tracked.md'), 'dirty edit')
    await writeFile(join(agentDir, 'MEMORY.md'), 'memory-content-marker')

    const loader = await createResourceLoader({ agentDir })

    const prompt = loader.getSystemPrompt() ?? ''
    const nudgeIdx = prompt.indexOf('tracked.md')
    expect(nudgeIdx).toBeGreaterThan(-1)
    expect(prompt).not.toContain('memory-content-marker')
  })

  test('omits the runtime block when runtimeVersion is not provided', async () => {
    // given: no runtimeVersion option

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Runtime')
    expect(prompt).not.toContain('TypeClaw runtime version')
  })

  test('renders the runtime block under "## Runtime" when runtimeVersion is provided', async () => {
    // when
    const loader = await createResourceLoader({ agentDir, runtimeVersion: '9.9.9' })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('## Runtime')
    expect(prompt).toContain('TypeClaw runtime version: 9.9.9.')
  })

  test('runtime block sits BEFORE the origin block so version stays in the cache prefix relative to per-session origin churn', async () => {
    // given: an origin (which renders the origin block via withOrigin) AND a
    // runtimeVersion. The cache-suffix invariant requires the runtime block to
    // precede the origin block — version changes are rarer than origin changes,
    // and the cache hits up to the first byte that differs.
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'sess-runtime-order' }

    // when
    const loader = await createResourceLoader({ agentDir, origin, runtimeVersion: '9.9.9' })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    const runtimeIdx = prompt.indexOf('TypeClaw runtime version: 9.9.9.')
    const originIdx = prompt.indexOf('## Session origin')
    expect(runtimeIdx).toBeGreaterThan(-1)
    expect(originIdx).toBeGreaterThan(-1)
    expect(runtimeIdx).toBeLessThan(originIdx)
  })

  test('full cache-suffix ordering: role block < gitNudge', async () => {
    // given: dirty git repo (gitNudge renders) and a channel origin with a
    // permission service that produces a role block.
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'tracked.md'), 'initial')
    await runGit(agentDir, ['add', '.'])
    await runGit(agentDir, ['commit', '-q', '-m', 'init'])
    await writeFile(join(agentDir, 'tracked.md'), 'dirty edit')
    const { createPermissionService } = await import('@/permissions')
    const permissions = createPermissionService({
      roles: {
        member: {
          match: [{ kind: 'channel', platform: 'slack', workspace: 'T0', chat: 'C0' }],
          permissions: ['channel.respond'],
        },
      },
    })
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
    }

    const loader = await createResourceLoader({ agentDir, origin, permissions })

    const prompt = loader.getSystemPrompt() ?? ''
    const roleIdx = prompt.indexOf('## Your role in this session')
    const nudgeIdx = prompt.indexOf('tracked.md')
    expect(roleIdx).toBeGreaterThan(-1)
    expect(nudgeIdx).toBeGreaterThan(-1)
    expect(roleIdx).toBeLessThan(nudgeIdx)
  })

  test('system prompt does NOT contain a wall-clock anchor: the per-turn `<current-time>` block lives in the user message instead', async () => {
    const loader = await createResourceLoader({ agentDir })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Now')
    expect(prompt).not.toContain('Session started at')
    expect(prompt).not.toContain('<current-time>')
  })

  test('system prompt never contains long-term memory file contents', async () => {
    await writeFile(join(agentDir, 'MEMORY.md'), 'memory-content-marker')

    const loader = await createResourceLoader({ agentDir })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('memory-content-marker')
  })

  test('composeSystemPrompt does not accept or emit a `now` field (removed when the anchor moved to per-turn injection)', () => {
    const prompt = composeSystemPrompt({
      self: '# Identity\n\nfoo',
      gitNudge: '',
    })
    expect(prompt).not.toContain('## Now')
    expect(prompt).not.toContain('Session started at')
  })

  test('composeSystemPrompt includes GPT proactive next-step nudge when supplied', () => {
    const prompt = composeSystemPrompt({
      self: '# Identity\n\nfoo',
      gitNudge: '',
      proactiveNextStepNudge: PROACTIVE_NEXT_STEP_NUDGE,
    })

    expect(prompt).toContain('## Proactive and requested next-step guidance')
    expect(prompt).toContain('do not ask for permission or confirmation')
    expect(prompt).toContain('Do the next step when it makes sense')
    expect(prompt).toContain('When the user explicitly asks for suggestions')
  })

  test('composeSystemPrompt omits proactive next-step nudge by default for non-GPT callers', () => {
    const prompt = composeSystemPrompt({
      self: '# Identity\n\nfoo',
      gitNudge: '',
    })

    expect(prompt).not.toContain('## Proactive and requested next-step guidance')
    expect(prompt).not.toContain('do not ask for permission or confirmation')
  })

  test('composeSystemPrompt places GPT proactive next-step nudge after git nudge', () => {
    const prompt = composeSystemPrompt({
      self: '# Identity\n\nfoo',
      gitNudge: '## Git nudge\n\ncommit things',
      proactiveNextStepNudge: PROACTIVE_NEXT_STEP_NUDGE,
    })

    expect(prompt.indexOf('## Git nudge')).toBeLessThan(prompt.indexOf('## Proactive and requested next-step guidance'))
  })

  test('composeSystemPrompt places MCP catalog after origin and before git nudge', () => {
    const catalog = '## MCP servers\n\n- files (2 tools): Filesystem tools'
    const prompt = composeSystemPrompt({
      self: '# Identity\n\nfoo',
      origin: { kind: 'tui', sessionId: 'ses_test' },
      mcpCatalog: catalog,
      gitNudge: '## Git nudge\n\ncommit things',
    })

    const originIndex = prompt.indexOf('## Session origin')
    const catalogIndex = prompt.indexOf(catalog)
    const gitNudgeIndex = prompt.indexOf('## Git nudge')

    expect(originIndex).toBeGreaterThan(-1)
    expect(catalogIndex).toBeGreaterThan(originIndex)
    expect(gitNudgeIndex).toBeGreaterThan(catalogIndex)
  })

  test('long-term memory file contents are not visible to plugin session.prompt hooks', async () => {
    await writeFile(join(agentDir, 'MEMORY.md'), 'attacker-controlled-marker')
    const { createHookBus } = await import('@/plugin')
    const { emptyRegistry } = await import('@/plugin/registry')
    const hooks = createHookBus()
    let promptSeenByHook = ''
    hooks.registerAll(
      'test-observer',
      agentDir,
      { info: () => {}, warn: () => {}, error: () => {} },
      {
        'session.prompt': (event) => {
          promptSeenByHook = event.prompt
        },
      },
    )
    const plugins = {
      registry: emptyRegistry(),
      hooks,
      sessionId: 'ses_test',
      agentDir,
    }

    const loader = await createResourceLoader({ agentDir, plugins })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('attacker-controlled-marker')
    expect(promptSeenByHook).not.toContain('attacker-controlled-marker')
  })

  test('exposes the typeclaw-cron bundled skill to the agent', async () => {
    const loader = await createResourceLoader({ agentDir })

    const { skills } = loader.getSkills()
    const cronSkill = skills.find((s) => s.name === 'typeclaw-cron')
    expect(cronSkill).toBeDefined()
    expect(cronSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes the typeclaw-config bundled skill to the agent', async () => {
    const loader = await createResourceLoader({ agentDir })

    const { skills } = loader.getSkills()
    const configSkill = skills.find((s) => s.name === 'typeclaw-config')
    expect(configSkill).toBeDefined()
    expect(configSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes the agent-browser bundled plugin skill to the agent', async () => {
    const hooks = createHookBus()
    const registry: PluginRegistry = {
      ...emptyRegistry(),
      skillsDirs: [
        {
          pluginName: 'agent-browser',
          path: join(import.meta.dir, '..', 'bundled-plugins', 'agent-browser', 'skills'),
        },
      ],
    }

    const loader = await createResourceLoader({
      agentDir,
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
    })

    const { skills } = loader.getSkills()
    const browserSkill = skills.find((s) => s.name === 'agent-browser')
    expect(browserSkill).toBeDefined()
    expect(browserSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes user-installed skills under <agentDir>/.agents/skills/ to the agent', async () => {
    // given
    await mkdir(join(agentDir, '.agents', 'skills', 'user-tool'), { recursive: true })
    await writeFile(
      join(agentDir, '.agents', 'skills', 'user-tool', 'SKILL.md'),
      '---\nname: user-tool\ndescription: A user-installed skill\n---\n\nbody',
    )

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const { skills } = loader.getSkills()
    const userSkill = skills.find((s) => s.name === 'user-tool')
    expect(userSkill).toBeDefined()
    expect(userSkill?.description).toBe('A user-installed skill')
  })

  test('does not throw when <agentDir>/.agents/skills/ does not exist', async () => {
    // when / then
    const loader = await createResourceLoader({ agentDir })
    expect(loader.getSkills().skills).toBeDefined()
  })

  test('exposes muscle-memory skills under <agentDir>/memory/skills/ to the agent', async () => {
    // given
    await mkdir(join(agentDir, 'memory', 'skills', 'release-checklist'), { recursive: true })
    await writeFile(
      join(agentDir, 'memory', 'skills', 'release-checklist', 'SKILL.md'),
      '---\nname: release-checklist\ndescription: Use when shipping a release.\nsource: muscle-memory\n---\n\nbody',
    )

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const { skills } = loader.getSkills()
    const memorySkill = skills.find((s) => s.name === 'release-checklist')
    expect(memorySkill).toBeDefined()
    expect(memorySkill?.description).toBe('Use when shipping a release.')
  })

  test('does not throw when <agentDir>/memory/skills/ does not exist', async () => {
    // when / then
    const loader = await createResourceLoader({ agentDir })
    expect(loader.getSkills().skills).toBeDefined()
  })

  test('appends a dirty-files nudge to the system prompt when the agent folder has uncommitted changes', async () => {
    // given
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'IDENTITY.md'), 'tracked file')
    await runGit(agentDir, ['add', 'IDENTITY.md'])
    await runGit(agentDir, ['commit', '-m', 'init'])
    await writeFile(join(agentDir, 'IDENTITY.md'), 'modified content')

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('## Uncommitted changes at session start')
    expect(prompt).toContain('IDENTITY.md')
  })

  test('omits the dirty-files nudge entirely when the worktree is clean', async () => {
    // given
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'IDENTITY.md'), 'committed')
    await runGit(agentDir, ['add', 'IDENTITY.md'])
    await runGit(agentDir, ['commit', '-m', 'init'])

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Uncommitted changes at session start')
  })

  test('omits the dirty-files nudge when the agent folder is not a git repo', async () => {
    // when (no .git in agentDir)
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Uncommitted changes at session start')
  })

  test('places the nudge after the plugin session.prompt mutation so plugin-injected text remains in the cacheable prefix', async () => {
    // given
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'IDENTITY.md'), 'baseline')
    await runGit(agentDir, ['add', 'IDENTITY.md'])
    await runGit(agentDir, ['commit', '-m', 'init'])
    await writeFile(join(agentDir, 'IDENTITY.md'), 'dirty edit')

    const hooks = createHookBus()
    hooks.registerAll('plugin-test', agentDir, silentLogger(), {
      'session.prompt': async (event) => {
        event.prompt = `${event.prompt}\n\nPLUGIN-INJECTED-MARKER`
      },
    })
    const registry: PluginRegistry = emptyRegistry()

    // when
    const loader = await createResourceLoader({
      agentDir,
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
    })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    const pluginIdx = prompt.indexOf('PLUGIN-INJECTED-MARKER')
    const nudgeIdx = prompt.indexOf('## Uncommitted changes at session start')
    expect(pluginIdx).toBeGreaterThan(-1)
    expect(nudgeIdx).toBeGreaterThan(-1)
    expect(nudgeIdx).toBeGreaterThan(pluginIdx)
  })

  test('passes session origin to plugin session.prompt hooks', async () => {
    // given
    let capturedOrigin: SessionOrigin | undefined
    const hooks = createHookBus()
    hooks.registerAll('plugin-test', agentDir, silentLogger(), {
      'session.prompt': async (event) => {
        capturedOrigin = event.origin
      },
    })
    const registry: PluginRegistry = emptyRegistry()
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
      participants: [],
    }

    // when
    await createResourceLoader({
      agentDir,
      origin,
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
    })

    // then
    expect(capturedOrigin).toEqual(origin)
  })

  test('renders the multi-speaker role policy (not the opener’s concrete role) for a channel session', async () => {
    // given: a permission service with an author-scoped member rule
    const { createPermissionService } = await import('@/permissions')
    const permissions = createPermissionService({
      roles: {
        member: {
          match: [{ kind: 'channel', platform: 'slack', workspace: 'T0', chat: 'C0', author: 'U_ME' }],
          permissions: ['channel.respond'],
        },
      },
    })
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
      lastInboundAuthorId: 'U_ME',
    }

    // when
    const loader = await createResourceLoader({ agentDir, origin, permissions })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('## Your role in this session')
    expect(prompt).toContain('multiple speakers')
    expect(prompt).not.toContain('Role: `member`')
  })

  test('omits the role block when permissions is not provided (preserves prior behavior)', async () => {
    // given: a channel origin but no permission service
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
    }

    // when
    const loader = await createResourceLoader({ agentDir, origin })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Your role in this session')
  })

  test('places the role block before the gitNudge so dirty-files stays in the cache suffix', async () => {
    // given: a git repo with a dirty tracked file so gitNudge will render,
    // plus a permission service that will produce a role block
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'tracked.md'), 'initial')
    await runGit(agentDir, ['add', '.'])
    await runGit(agentDir, ['commit', '-q', '-m', 'init'])
    await writeFile(join(agentDir, 'tracked.md'), 'dirty edit')

    const { createPermissionService } = await import('@/permissions')
    const permissions = createPermissionService({
      roles: {
        member: {
          match: [{ kind: 'channel', platform: 'slack', workspace: 'T0', chat: 'C0' }],
          permissions: ['channel.respond'],
        },
      },
    })
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
    }

    // when
    const loader = await createResourceLoader({ agentDir, origin, permissions })

    // then: role block appears, gitNudge appears, and gitNudge is AFTER the role block
    const prompt = loader.getSystemPrompt() ?? ''
    const roleIdx = prompt.indexOf('## Your role in this session')
    const nudgeIdx = prompt.indexOf('tracked.md')
    expect(roleIdx).toBeGreaterThan(-1)
    expect(nudgeIdx).toBeGreaterThan(-1)
    expect(roleIdx).toBeLessThan(nudgeIdx)
  })

  test('TUI session resolving to owner does not render the role block (token-saving common case)', async () => {
    // given: no user roles declared, so TUI resolves to built-in owner
    const { createPermissionService } = await import('@/permissions')
    const permissions = createPermissionService({})
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'ses_t' }

    // when
    const loader = await createResourceLoader({ agentDir, origin, permissions })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Your role in this session')
  })

  test('TUI cannot be demoted by a user-declared role: owner always wins under severity-then-declaration ordering', async () => {
    // given: a hostile-looking config that tries to remap TUI to guest by
    // declaring `match: ['tui']` on a non-owner role. Under the old pure-
    // declaration-order semantics, the user role was walked first and
    // demoted TUI; under severity-then-declaration, owner is walked first
    // and the built-in owner.match always includes `{ kind: 'tui' }`.
    const { createPermissionService } = await import('@/permissions')
    const permissions = createPermissionService({
      roles: {
        guest: { match: [{ kind: 'tui' }], permissions: [] },
      },
    })
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'ses_t' }

    // when
    const loader = await createResourceLoader({ agentDir, origin, permissions })

    // then: TUI still resolves to owner, so the role block is omitted as in
    // the common case. The hostile config is inert.
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Your role in this session')
    expect(permissions.resolveRole(origin)).toBe('owner')
  })

  test('cron origin defaults to slim mode: uses SLIM_SYSTEM_PROMPT and drops git nudge', async () => {
    // given: a dirty git repo so gitNudge WOULD render in full mode
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'tracked.md'), 'initial')
    await runGit(agentDir, ['add', '.'])
    await runGit(agentDir, ['commit', '-q', '-m', 'init'])
    await writeFile(join(agentDir, 'tracked.md'), 'dirty edit')
    const origin: SessionOrigin = { kind: 'cron', jobId: 'job-1', jobKind: 'prompt' }

    // when
    const loader = await createResourceLoader({ agentDir, origin })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(SLIM_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).not.toContain(DEFAULT_SYSTEM_PROMPT)
    expect(prompt).not.toContain('## Uncommitted changes at session start')
    expect(prompt).not.toContain('tracked.md')
  })

  test('subagent origin defaults to slim mode', async () => {
    const origin: SessionOrigin = { kind: 'subagent', subagent: 'tester', parentSessionId: 'ses_p' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(SLIM_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).not.toContain(DEFAULT_SYSTEM_PROMPT)
  })

  test('tui origin stays in full mode', async () => {
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'ses_t' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })

  test('channel origin stays in full mode (humans read the chat)', async () => {
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
    }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })

  test('explicit mode override beats the origin-derived default', async () => {
    // given: a cron origin (which would default to slim)
    const origin: SessionOrigin = { kind: 'cron', jobId: 'job-1', jobKind: 'prompt' }

    // when: forced to full
    const loader = await createResourceLoader({ agentDir, origin, mode: 'full' })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })

  test('slim mode does not inject MEMORY.md into the system prompt', async () => {
    await writeFile(join(agentDir, 'MEMORY.md'), 'standup-summary-marker')
    const origin: SessionOrigin = { kind: 'cron', jobId: 'job-1', jobKind: 'prompt' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('standup-summary-marker')
  })

  test('slim cron prompt carries the load-bearing guidance review surfaced (errors, narration, workspace, memory shards, runtime-managed paths)', async () => {
    const origin: SessionOrigin = { kind: 'cron', jobId: 'job-1', jobKind: 'prompt' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('Never echo secrets from `secrets.json` or `.env`')
    expect(prompt).toContain('never fabricate results')
    expect(prompt).toContain('Do not narrate routine')
    expect(prompt).toContain('workspace/')
    expect(prompt).toContain('Do not edit `memory/topics/` directly')
    expect(prompt).toContain('Never stage or commit')
  })

  test('slim prompt does NOT contain the subagent-breaking "plain prose is invisible" claim', async () => {
    const origin: SessionOrigin = { kind: 'subagent', subagent: 'tester', parentSessionId: 'ses_p' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('Plain prose with no tool call is invisible')
    expect(prompt).not.toContain('plain-text output is invisible')
  })

  test('trimmed full prompt still carries every load-bearing phrase (workspace, memory shards, secrets, git hygiene, persona, error honesty)', async () => {
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'ses_t' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('`workspace/`')
    expect(prompt).toContain('never edit memory shards directly')
    expect(prompt).toContain('`.env`')
    expect(prompt).toContain('`secrets.json`')
    expect(prompt).toContain('Never echo, log, or commit')
    expect(prompt).toContain('One logical change = one commit')
    expect(prompt).toContain('SOUL.md specifies a voice')
    expect(prompt).toContain('never fabricate results')
    expect(prompt).toContain('re-read whenever process is unclear')
    expect(prompt).toContain('You are not pi, not Claude, not ChatGPT')
    // Mode B channel guidance: subagent completion reminder in a channel
    // session is not a user message; the model needs explicit instruction
    // to surface via channel_reply/channel_send rather than emit plain text
    // that goes nowhere. Guards against the "spawn → silent" regression.
    expect(prompt).toContain('completion `<system-reminder>`')
    expect(prompt).toContain('Surface the result via `channel_reply`')
  })

  test('full prompt steers long-running/interactive shell work to tmux so a blocking foreground command cannot freeze the turn', async () => {
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'ses_t' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('## Long-running and interactive shell work')
    expect(prompt).toContain('tmux new-session -d')
    expect(prompt).toContain('tmux send-keys')
    expect(prompt).toContain('tmux capture-pane')
    expect(prompt).toContain('tmux kill-session')
  })

  test('slim prompt does NOT carry the tmux shell-work section (full-mode-only budget guard)', async () => {
    const origin: SessionOrigin = { kind: 'cron', jobId: 'job-1', jobKind: 'prompt' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Long-running and interactive shell work')
    expect(prompt).not.toContain('tmux new-session -d')
  })

  test('full prompt carries the Mode C troubleshooting hand-off so a stuck fix-it loop gets delegated to operator instead of burning the main session', async () => {
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'ses_t' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('**Mode C — Troubleshooting.**')
    expect(prompt).toContain('typeclaw-troubleshooting')
    expect(prompt).toContain('hand the loop to `operator`')
  })

  test('slim prompt does NOT carry the Mode C troubleshooting hand-off (full-mode-only budget guard)', async () => {
    const origin: SessionOrigin = { kind: 'cron', jobId: 'job-1', jobKind: 'prompt' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('**Mode C — Troubleshooting.**')
    expect(prompt).not.toContain('typeclaw-troubleshooting')
  })

  test('full prompt carries the post-hatching file-routing matrix so a tone preference cannot land in AGENTS.md and a process rule cannot land in SOUL.md', async () => {
    // Without these assertions, a future trim of system-prompt.ts could
    // quietly drop the routing matrix and the prompt would still
    // type-check, render, and pass every other test — but the agent
    // would lose the steady-state guidance for which file owns what.
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'ses_t' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('role, function, scope of work')
    expect(prompt).toContain('voice, tone, register')
    expect(prompt).toContain('facts about the user')
    expect(prompt).toContain('working conventions, repeatable procedures')
    expect(prompt).toContain('how you sound')
    expect(prompt).toContain('how you work')
    expect(prompt).toContain('Edit discipline')
    expect(prompt).toContain('SOUL.md should stay short')
    expect(prompt).toContain("a single off-day request isn't a durable change")
  })

  test('slim prompt does NOT carry the post-hatching routing matrix (cron/subagent budget guard against copy-paste regression)', async () => {
    const origin: SessionOrigin = { kind: 'cron', jobId: 'job-1', jobKind: 'prompt' }

    const loader = await createResourceLoader({ agentDir, origin })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('role, function, scope of work')
    expect(prompt).not.toContain('how you sound')
    expect(prompt).not.toContain('Edit discipline')
  })
})

describe('deriveSystemPromptMode', () => {
  test('returns full for tui', () => {
    expect(deriveSystemPromptMode({ kind: 'tui', sessionId: 's' })).toBe('full')
  })
  test('returns full for channel', () => {
    expect(
      deriveSystemPromptMode({
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: null,
      }),
    ).toBe('full')
  })
  test('returns slim for cron', () => {
    expect(deriveSystemPromptMode({ kind: 'cron', jobId: 'j', jobKind: 'prompt' })).toBe('slim')
  })
  test('returns slim for subagent', () => {
    expect(deriveSystemPromptMode({ kind: 'subagent', subagent: 's', parentSessionId: 'p' })).toBe('slim')
  })
  test('returns full when origin is undefined (back-compat default)', () => {
    expect(deriveSystemPromptMode(undefined)).toBe('full')
  })

  test('covers every declared origin kind without falling through', () => {
    const allKinds: SessionOrigin[] = [
      { kind: 'tui', sessionId: 's' },
      {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: null,
      },
      { kind: 'cron', jobId: 'j', jobKind: 'prompt' },
      { kind: 'subagent', subagent: 's', parentSessionId: 'p' },
    ]
    for (const origin of allKinds) {
      const mode = deriveSystemPromptMode(origin)
      expect(['full', 'slim']).toContain(mode)
    }
  })
})

describe('composeSystemPrompt slim mode', () => {
  test('uses SLIM_SYSTEM_PROMPT as the base when mode is slim', () => {
    const prompt = composeSystemPrompt({
      mode: 'slim',
      self: '# Identity\n\nfoo',
      gitNudge: '',
    })
    expect(prompt.startsWith(SLIM_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).not.toContain(DEFAULT_SYSTEM_PROMPT)
  })

  test('uses DEFAULT_SYSTEM_PROMPT when mode is unset (back-compat)', () => {
    const prompt = composeSystemPrompt({
      self: '# Identity\n\nfoo',
      gitNudge: '',
    })
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })
})

describe('composeSystemPrompt branding', () => {
  test('branding off drops the runtime block and every TypeClaw clue (full mode)', () => {
    const prompt = composeSystemPrompt({
      branding: false,
      self: '# Identity\n\nfoo',
      runtimeVersion: '9.9.9',
      gitNudge: '',
    })
    expect(prompt).not.toContain('TypeClaw')
    expect(prompt).not.toContain('## Runtime\n')
    expect(prompt).not.toContain('9.9.9')
    expect(prompt.startsWith('You are a general-purpose AI agent.')).toBe(true)
  })

  test('branding off appends the runtime-disclosure rule (full mode)', () => {
    const prompt = composeSystemPrompt({
      branding: false,
      self: '# Identity\n\nfoo',
      runtimeVersion: '9.9.9',
      gitNudge: '',
    })
    expect(prompt).toContain('## Runtime disclosure')
    expect(prompt).toContain('Never reveal, name, or hint at the runtime')
  })

  test('branding off drops the runtime block and every TypeClaw clue (slim mode)', () => {
    const prompt = composeSystemPrompt({
      mode: 'slim',
      branding: false,
      self: '# Identity\n\nfoo',
      runtimeVersion: '9.9.9',
      gitNudge: '',
    })
    expect(prompt).not.toContain('TypeClaw')
    expect(prompt).not.toContain('## Runtime\n')
    expect(prompt).toContain('## Runtime disclosure')
    expect(prompt.startsWith('You are an AI agent.')).toBe(true)
  })

  test('branding on (default) keeps the runtime block and omits the disclosure rule', () => {
    const prompt = composeSystemPrompt({
      self: '# Identity\n\nfoo',
      runtimeVersion: '9.9.9',
      gitNudge: '',
    })
    expect(prompt).toContain('## Runtime')
    expect(prompt).toContain('TypeClaw runtime version: 9.9.9.')
    expect(prompt).not.toContain('## Runtime disclosure')
  })
})

describe('createOverrideResourceLoader', () => {
  test('starts with the override string verbatim', async () => {
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith('SUBAGENT PROMPT')).toBe(true)
  })

  test('does not append a wall-clock anchor: the per-turn `<current-time>` block lives in the user message instead', async () => {
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Now')
    expect(prompt).not.toContain('Session started at')
    expect(prompt).not.toContain('<current-time>')
  })

  test('does not include the typeclaw default system prompt', async () => {
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain(DEFAULT_SYSTEM_PROMPT)
  })

  test('does not append SYSTEM.md files discovered by pi defaults', async () => {
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    expect(loader.getAppendSystemPrompt()).toEqual([])
  })

  test('branding on (default) appends the runtime block naming TypeClaw and the version', async () => {
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT', undefined, undefined, '9.9.9')

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('## Runtime')
    expect(prompt).toContain('TypeClaw runtime version: 9.9.9.')
  })
})

describe('branding opt-out through config (getConfig().branding)', () => {
  afterEach(() => {
    __resetConfigForTesting()
  })

  test('createOverrideResourceLoader drops the runtime block and every TypeClaw clue when branding is off', async () => {
    // given a reloaded config with branding disabled
    await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ branding: false }))
    reloadConfig(agentDir)

    // when the subagent override path renders with a runtime version
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT', undefined, undefined, '9.9.9')

    // then the runtime version block is gone but the non-disclosure rule is added
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith('SUBAGENT PROMPT')).toBe(true)
    expect(prompt).not.toContain('## Runtime\n')
    expect(prompt).not.toContain('TypeClaw')
    expect(prompt).not.toContain('9.9.9')
    expect(prompt).toContain('## Runtime disclosure')
  })

  test('createResourceLoader strips every TypeClaw clue and the runtime block when branding is off', async () => {
    // given a reloaded config with branding disabled
    await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ branding: false }))
    reloadConfig(agentDir)

    // when the full-mode prompt is composed with a runtime version
    const loader = await createResourceLoader({ agentDir, runtimeVersion: '9.9.9' })

    // then the opening is generic, no TypeClaw clue remains, and the rule is added
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith('You are a general-purpose AI agent.')).toBe(true)
    expect(prompt).not.toContain('## Runtime\n')
    expect(prompt).not.toContain('TypeClaw')
    expect(prompt).not.toContain('9.9.9')
    expect(prompt).toContain('## Runtime disclosure')
  })

  test('a real bundled subagent prompt loses its "running inside TypeClaw" identity prose when branding is off', async () => {
    // given a reloaded config with branding disabled
    await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ branding: false }))
    reloadConfig(agentDir)

    // when a real bundled subagent prompt (scout) goes through the override path
    const loader = await createOverrideResourceLoader(SCOUT_SYSTEM_PROMPT)

    // then its hardcoded identity prose is stripped but functional prose survives
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('TypeClaw')
    expect(prompt).toContain('You are a web-research specialist.')
    expect(prompt).toContain('gather facts from the public internet')
    expect(prompt).toContain('## Runtime disclosure')
  })

  test('the planner\'s "TypeClaw ships a reviewer" identity prose is rephrased when branding is off', async () => {
    // given a reloaded config with branding disabled
    await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ branding: false }))
    reloadConfig(agentDir)

    // when the planner prompt (which names TypeClaw twice) goes through the override path
    const loader = await createOverrideResourceLoader(PLANNER_SYSTEM_PROMPT)

    // then both identity mentions are gone, the reviewer-recommendation stays intact
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('TypeClaw')
    expect(prompt).toContain('The runtime ships a `reviewer` subagent')
  })
})

describe('buildChannelTools', () => {
  function makeRouter() {
    return createChannelRouter({
      agentDir: '/tmp/test-channel-tools',
      configForAdapter: () => ({
        allow: ['*'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      }),
    })
  }

  const channelOrigin: SessionOrigin = {
    kind: 'channel',
    adapter: 'slack-bot',
    workspace: 'T0',
    chat: 'C0',
    thread: '1700000000.000100',
  }
  const githubOrigin: SessionOrigin = {
    kind: 'channel',
    adapter: 'github',
    workspace: 'acme/widgets',
    chat: 'pr:7',
    thread: null,
  }

  const tuiOrigin: SessionOrigin = { kind: 'tui', sessionId: 'ses-tui-1' }
  const cronOrigin: SessionOrigin = { kind: 'cron', jobId: 'j1', jobKind: 'prompt' }

  test('exposes the channel-origin tool set including channel_disengage when origin is channel', () => {
    // given
    const router = makeRouter()

    // when
    const tools = buildChannelTools(router, channelOrigin)

    // then
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'channel_disengage',
      'channel_edit',
      'channel_fetch_attachment',
      'channel_history',
      'channel_react',
      'channel_read',
      'channel_reply',
      'channel_send',
      'look_at_channel_attachment',
    ])
  })

  test('exposes channel_send and channel_read (no reply or history) when origin is non-channel', () => {
    // given
    const router = makeRouter()

    // when
    const tools = buildChannelTools(router, tuiOrigin)

    // then
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['channel_edit', 'channel_read', 'channel_send'])
  })

  test('exposes post_github_review only for GitHub channel origins', () => {
    expect(buildChannelTools(makeRouter(), githubOrigin, 'github-session').map((tool) => tool.name)).toContain(
      'post_github_review',
    )
    expect(buildChannelTools(makeRouter(), channelOrigin).map((tool) => tool.name)).not.toContain('post_github_review')
  })

  test('state-mutating review tools read promoted round identity from the live origin', async () => {
    const router = makeRouter()
    const threadOrigin: SessionOrigin = { ...githubOrigin, thread: '202' }
    let liveOrigin: SessionOrigin = threadOrigin
    const tools = buildChannelTools(router, threadOrigin, 'github-session', () => liveOrigin)
    const review = tools.find((tool) => tool.name === 'post_github_review')
    if (review === undefined) throw new Error('post_github_review missing')
    liveOrigin = {
      ...threadOrigin,
      githubReviewRound: {
        kind: 'push',
        roundId: 'test-round',
        workspace: 'acme/widgets',
        prNumber: 7,
        headSha: 'sha-round',
        carrierThread: '101',
      },
    }
    const context = {} as Parameters<typeof review.execute>[4]

    const result = await review.execute(
      'round-live-origin',
      {
        event: 'REQUEST_CHANGES',
        body: 'The blocking concern remains.',
      },
      undefined,
      undefined,
      context,
    )

    expect((result.content[0] as { text: string }).text).toContain('assigned the formal verdict to another sibling')
    await router.stop()
  })

  test('exposes channel_send and channel_read when origin is cron (not channel-routed)', () => {
    // given
    const router = makeRouter()

    // when
    const tools = buildChannelTools(router, cronOrigin)

    // then
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['channel_edit', 'channel_read', 'channel_send'])
  })

  test('exposes no channel tools when channelRouter is undefined', () => {
    // when
    const tools = buildChannelTools(undefined, channelOrigin)
    // then
    expect(tools).toHaveLength(0)
  })

  test('exposes no channel tools when origin is undefined and channelRouter is undefined', () => {
    // when
    const tools = buildChannelTools(undefined, undefined)
    // then
    expect(tools).toHaveLength(0)
  })

  test('exposes channel_send and channel_read when channelRouter is set but origin is undefined', () => {
    // when
    const tools = buildChannelTools(makeRouter(), undefined)
    // then
    expect(tools.map((t) => t.name).sort()).toEqual(['channel_edit', 'channel_read', 'channel_send'])
  })
})

describe('buildSubagentOrchestrationTools', () => {
  const stubCreateSession = (async () => ({}) as unknown) as CreateSessionForSubagent
  const stubRegistry: SubagentRegistry = {}
  const getOrigin = () => ({ kind: 'tui' as const, sessionId: 'ses_parent' })

  test('exposes the three orchestration tools when all four dependencies are present', () => {
    const tools = buildSubagentOrchestrationTools({
      liveRegistry: new LiveSubagentRegistry(),
      registry: stubRegistry,
      createSessionForSubagent: stubCreateSession,
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin,
      permissions: undefined,
      stream: undefined,
    })
    expect(tools.map((t) => t.name).sort()).toEqual(['spawn_subagent', 'subagent_cancel', 'subagent_output'])
  })

  test('returns [] when liveRegistry is missing (subagent-session context — primary recursive-spawn defense)', () => {
    const tools = buildSubagentOrchestrationTools({
      liveRegistry: undefined,
      registry: stubRegistry,
      createSessionForSubagent: stubCreateSession,
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin,
      permissions: undefined,
      stream: undefined,
    })
    expect(tools).toEqual([])
  })

  test('returns [] when registry is missing', () => {
    const tools = buildSubagentOrchestrationTools({
      liveRegistry: new LiveSubagentRegistry(),
      registry: undefined,
      createSessionForSubagent: stubCreateSession,
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin,
      permissions: undefined,
      stream: undefined,
    })
    expect(tools).toEqual([])
  })

  test('returns [] when createSessionForSubagent is missing', () => {
    const tools = buildSubagentOrchestrationTools({
      liveRegistry: new LiveSubagentRegistry(),
      registry: stubRegistry,
      createSessionForSubagent: undefined,
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin,
      permissions: undefined,
      stream: undefined,
    })
    expect(tools).toEqual([])
  })

  test('returns [] when agentDir is missing', () => {
    const tools = buildSubagentOrchestrationTools({
      liveRegistry: new LiveSubagentRegistry(),
      registry: stubRegistry,
      createSessionForSubagent: stubCreateSession,
      agentDir: undefined,
      parentSessionId: 'ses_parent',
      getOrigin,
      permissions: undefined,
      stream: undefined,
    })
    expect(tools).toEqual([])
  })
})

describe('getBundledSkillsDir', () => {
  test.each([['typeclaw-cron'], ['typeclaw-config'], ['typeclaw-channels']])(
    'points at a directory containing %s/SKILL.md',
    (skill) => {
      const dir = getBundledSkillsDir()
      expect(existsSync(join(dir, skill, 'SKILL.md'))).toBe(true)
    },
  )

  test.each([['typeclaw-cron'], ['typeclaw-config'], ['typeclaw-channels']])(
    '%s SKILL.md has YAML frontmatter with name and description',
    async (skill) => {
      const path = join(getBundledSkillsDir(), skill, 'SKILL.md')
      const raw = await readFile(path, 'utf8')

      expect(raw.startsWith('---\n')).toBe(true)
      const frontmatterEnd = raw.indexOf('\n---\n', 4)
      expect(frontmatterEnd).toBeGreaterThan(0)
      const frontmatter = raw.slice(4, frontmatterEnd)
      expect(frontmatter).toMatch(new RegExp(`^name:\\s*${skill}\\s*$`, 'm'))
      expect(frontmatter).toMatch(/^description:\s*\S/m)
    },
  )
})

describe('formatRestartNotice (sibling sessions: do not acknowledge unless asked)', () => {
  test('uses the SYSTEM MESSAGE framing convention required for runtime-injected text', () => {
    // when
    const text = formatRestartNotice('2026-05-03T17:39:00.000Z')

    // then
    expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toMatch(/\n---\n$/)
    expect(text).toContain('Do not acknowledge or reply to this notice unless a human directly')
  })

  test('embeds the restart timestamp in the body and the guidance', () => {
    // when
    const text = formatRestartNotice('2026-05-03T17:39:00.000Z')

    // then
    const matches = text.match(/2026-05-03T17:39:00\.000Z/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

describe('formatRestartNoticeOriginating (originating session: proactively confirm)', () => {
  test('uses the SYSTEM MESSAGE framing convention so persona-rich models do not reply to the framing', () => {
    // when
    const text = formatRestartNoticeOriginating('2026-05-03T17:39:00.000Z')

    // then
    expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toMatch(/\n---\n$/)
  })

  test('instructs the model to proactively confirm restart completion in the very next reply', () => {
    // when
    const text = formatRestartNoticeOriginating('2026-05-03T17:39:00.000Z')

    // then
    expect(text).toContain('**Your very next reply must briefly confirm the restart completed**')
    expect(text).toContain("user's explicit\nrequest via the `restart` tool")
  })

  test('explicitly tells the model not to keep mentioning the restart after the first confirmation', () => {
    // when
    const text = formatRestartNoticeOriginating('2026-05-03T17:39:00.000Z')

    // then
    expect(text).toContain('do\nnot mention the restart again unless the user explicitly asks about it')
  })

  test('does NOT include the sibling-only "Do not acknowledge or reply" directive (would contradict proactive confirmation)', () => {
    // when
    const text = formatRestartNoticeOriginating('2026-05-03T17:39:00.000Z')

    // then
    expect(text).not.toContain('Do not acknowledge or reply to this notice')
  })

  test('embeds the restart timestamp in the body', () => {
    // when
    const text = formatRestartNoticeOriginating('2026-05-03T17:39:00.000Z')

    // then
    expect(text).toContain('2026-05-03T17:39:00.000Z')
  })
})

describe('subscribeRestartNotice', () => {
  test('appends a typeclaw.restart-self entry to the originating session (sessionId matches payload)', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    const sessionId = sessionManager.getSessionId()
    subscribeRestartNotice(stream, sessionManager)

    // when
    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'container-restarting',
        restartedAt: '2026-05-03T17:39:00.000Z',
        originatingSessionId: sessionId,
      },
    })

    // then
    const entries = sessionManager.getEntries()
    const restartEntries = entries.filter(
      (e): e is typeof e & { type: 'custom_message' } => e.type === 'custom_message',
    )
    expect(restartEntries).toHaveLength(1)
    const entry = restartEntries[0]!
    expect(entry.customType).toBe('typeclaw.restart-self')
    expect(entry.display).toBe(false)
    const content = typeof entry.content === 'string' ? entry.content : ''
    expect(content).toContain('2026-05-03T17:39:00.000Z')
    expect(content).toContain('**Your very next reply must briefly confirm the restart completed**')
  })

  test('appends a typeclaw.restart entry to a sibling session (sessionId differs from payload)', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    subscribeRestartNotice(stream, sessionManager)

    // when
    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'container-restarting',
        restartedAt: '2026-05-03T17:39:00.000Z',
        originatingSessionId: 'ses-some-other-session',
      },
    })

    // then
    const entries = sessionManager.getEntries()
    const restartEntries = entries.filter(
      (e): e is typeof e & { type: 'custom_message' } => e.type === 'custom_message',
    )
    expect(restartEntries).toHaveLength(1)
    const entry = restartEntries[0]!
    expect(entry.customType).toBe('typeclaw.restart')
    expect(entry.display).toBe(false)
    const content = typeof entry.content === 'string' ? entry.content : ''
    expect(content).toContain('2026-05-03T17:39:00.000Z')
    expect(content).toContain('Do not acknowledge or reply to this notice unless a human directly')
  })

  test('ignores broadcasts whose payload kind is not container-restarting', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    const sessionId = sessionManager.getSessionId()
    subscribeRestartNotice(stream, sessionManager)

    // when
    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'something-else',
        restartedAt: '2026-05-03T17:39:00.000Z',
        originatingSessionId: sessionId,
      },
    })
    stream.publish({ target: { kind: 'broadcast' }, payload: { foo: 'bar' } })
    stream.publish({ target: { kind: 'broadcast' }, payload: null })

    // then
    expect(sessionManager.getEntries()).toHaveLength(0)
  })

  test('ignores container-restarting broadcasts with non-string restartedAt', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    const sessionId = sessionManager.getSessionId()
    subscribeRestartNotice(stream, sessionManager)

    // when
    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'container-restarting',
        restartedAt: 12345,
        originatingSessionId: sessionId,
      },
    })

    // then
    expect(sessionManager.getEntries()).toHaveLength(0)
  })

  test('ignores container-restarting broadcasts missing originatingSessionId (legacy / malformed payloads)', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    subscribeRestartNotice(stream, sessionManager)

    // when
    stream.publish({
      target: { kind: 'broadcast' },
      payload: { kind: 'container-restarting', restartedAt: '2026-05-03T17:39:00.000Z' },
    })

    // then
    expect(sessionManager.getEntries()).toHaveLength(0)
  })

  test('returns null and is a no-op when stream is undefined', () => {
    // given
    const sessionManager = SessionManager.inMemory()

    // when
    const unsub = subscribeRestartNotice(undefined, sessionManager)

    // then
    expect(unsub).toBeNull()
    expect(sessionManager.getEntries()).toHaveLength(0)
  })

  test('stops appending entries after the returned unsubscribe is called', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    const sessionId = sessionManager.getSessionId()
    const unsub = subscribeRestartNotice(stream, sessionManager)
    expect(unsub).not.toBeNull()
    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'container-restarting',
        restartedAt: '2026-05-03T17:39:00.000Z',
        originatingSessionId: sessionId,
      },
    })
    expect(sessionManager.getEntries()).toHaveLength(1)

    // when
    unsub?.()
    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'container-restarting',
        restartedAt: '2026-05-03T18:00:00.000Z',
        originatingSessionId: sessionId,
      },
    })

    // then
    expect(sessionManager.getEntries()).toHaveLength(1)
  })

  test('dispatches origin-vs-siblings correctly for one originator and two siblings sharing one stream (composition mutation check)', () => {
    // given three sessions sharing one stream — the originator that called the
    // restart tool, and two siblings that did not. This is the canonical
    // mutation-check: regression to "everyone gets the same notice" fails it,
    // regression to "dispatch is inverted" fails it, regression where the
    // broadcast doesn't carry the originator ID fails it.
    const stream = createStream()
    const originator = SessionManager.inMemory()
    const siblingA = SessionManager.inMemory()
    const siblingB = SessionManager.inMemory()
    subscribeRestartNotice(stream, originator)
    subscribeRestartNotice(stream, siblingA)
    subscribeRestartNotice(stream, siblingB)

    // when the originator's restart tool publishes once
    stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'container-restarting',
        restartedAt: '2026-05-03T17:39:00.000Z',
        originatingSessionId: originator.getSessionId(),
      },
    })

    // then originator gets restart-self, siblings get restart
    const originatorEntries = originator.getEntries().filter((e) => e.type === 'custom_message')
    const siblingAEntries = siblingA.getEntries().filter((e) => e.type === 'custom_message')
    const siblingBEntries = siblingB.getEntries().filter((e) => e.type === 'custom_message')

    expect(originatorEntries).toHaveLength(1)
    expect(siblingAEntries).toHaveLength(1)
    expect(siblingBEntries).toHaveLength(1)

    expect((originatorEntries[0] as { customType: string }).customType).toBe('typeclaw.restart-self')
    expect((siblingAEntries[0] as { customType: string }).customType).toBe('typeclaw.restart')
    expect((siblingBEntries[0] as { customType: string }).customType).toBe('typeclaw.restart')

    const originatorContent =
      typeof (originatorEntries[0] as { content: unknown }).content === 'string'
        ? ((originatorEntries[0] as { content: string }).content as string)
        : ''
    const siblingAContent =
      typeof (siblingAEntries[0] as { content: unknown }).content === 'string'
        ? ((siblingAEntries[0] as { content: string }).content as string)
        : ''
    expect(originatorContent).toContain('**Your very next reply must briefly confirm the restart completed**')
    expect(siblingAContent).toContain('Do not acknowledge or reply to this notice unless a human directly')
  })
})

describe('resolveSessionThinkingLevel', () => {
  const REF = 'openai/gpt-5.4-nano' as ModelRef
  const parseModels = (models: Record<string, unknown>): Models => configSchema.parse({ models }).models
  const resolvedWith = (
    thinkingLevel?: ResolvedProfile['thinkingLevel'],
    profile = 'fast',
  ): Pick<ResolvedProfile, 'thinkingLevel' | 'profile'> => ({
    profile,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  })

  // Drive resolution through `resolveProfile` so the built-in per-profile
  // defaults materialized at config-parse time are exercised end-to-end, the
  // way a real session is created.
  const resolveLevel = (models: Models, profile: string) =>
    resolveSessionThinkingLevel(models, resolveProfile(models, profile), REF)

  test('the profile`s own level wins over the default profile`s', () => {
    const models = parseModels({ default: { model: REF, thinkingLevel: 'medium' } })
    expect(resolveSessionThinkingLevel(models, resolvedWith('off'), REF)).toBe('off')
  })

  test('a user-defined profile without its own level inherits the default profile`s', () => {
    const models = parseModels({ default: { model: REF, thinkingLevel: 'high' }, 'cheap-batch': REF })
    expect(resolveLevel(models, 'cheap-batch')).toBe('high')
  })

  test('falls through to the SDK default when neither the profile nor default declares one', () => {
    const models = parseModels({ default: REF })
    expect(resolveLevel(models, 'default')).toBeUndefined()
  })

  test('an unknown profile that fell back to default uses the default profile`s level', () => {
    const models = parseModels({ default: { model: REF, thinkingLevel: 'xhigh' } })
    expect(resolveLevel(models, 'does-not-exist')).toBe('xhigh')
  })

  test('the fast profile defaults to low without its own level', () => {
    const models = parseModels({ default: REF, fast: REF })
    expect(resolveLevel(models, 'fast')).toBe('low')
  })

  test('the deep profile defaults to high without its own level', () => {
    const models = parseModels({ default: REF, deep: REF })
    expect(resolveLevel(models, 'deep')).toBe('high')
  })

  test('the deep default beats a lower global default', () => {
    const models = parseModels({ default: { model: REF, thinkingLevel: 'low' }, deep: REF })
    expect(resolveLevel(models, 'deep')).toBe('high')
  })

  test('an explicit deep thinkingLevel overrides the built-in high default', () => {
    const models = parseModels({ default: REF, deep: { model: REF, thinkingLevel: 'xhigh' } })
    expect(resolveLevel(models, 'deep')).toBe('xhigh')
  })

  test('an explicit fast thinkingLevel overrides the built-in low default', () => {
    const models = parseModels({ default: REF, fast: { model: REF, thinkingLevel: 'off' } })
    expect(resolveLevel(models, 'fast')).toBe('off')
  })

  test('built-in defaults are scoped to fast/deep — other profiles fall through', () => {
    const models = parseModels({ default: REF, vision: REF, 'cheap-batch': REF })
    expect(resolveLevel(models, 'vision')).toBeUndefined()
    expect(resolveLevel(models, 'cheap-batch')).toBeUndefined()
  })
})

describe('default stream output budget', () => {
  test('caps an ordinary high-output model request at 32K', async () => {
    const previousCwd = process.cwd()
    const previousFetch = globalThis.fetch
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    let requestMaxTokens: number | undefined
    process.chdir(agentDir)
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({ models: { default: { model: 'anthropic/claude-sonnet-4-6' } } }),
    )
    reloadConfig(agentDir)
    invalidateProviderAuthCache()
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestMaxTokens = (JSON.parse(String(init?.body)) as { max_tokens?: number }).max_tokens
      return new Response(
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
          '',
          'event: content_block_stop',
          'data: {"type":"content_block_stop","index":0}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch

    try {
      const { session, dispose } = await createSessionWithDispose({
        sessionManager: SessionManager.inMemory(agentDir),
        systemPromptOverride: 'test output cap',
        tools: [],
      })
      try {
        await session.prompt('reply briefly')
        expect(requestMaxTokens).toBe(32_000)
      } finally {
        await dispose()
      }
    } finally {
      globalThis.fetch = previousFetch
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      invalidateProviderAuthCache()
      __resetConfigForTesting()
      process.chdir(previousCwd)
    }
  })
})

describe('local context-preparation failures', () => {
  test('a session whose context cannot be prepared ends the turn with the local notice and never calls the provider', async () => {
    const previousCwd = process.cwd()
    const previousFetch = globalThis.fetch
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    let fetchCalls = 0
    process.chdir(agentDir)
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'anthropic/claude-sonnet-4-6' } }),
    )
    reloadConfig(agentDir)
    invalidateProviderAuthCache()
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response('{"error":{"message":"must not be reached"}}', { status: 500 })
    }) as unknown as typeof fetch
    // given: a tool result whose details hold a live function, which pi's
    // extension `context` pass cannot structuredClone
    const sessionManager = SessionManager.inMemory(agentDir)
    sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'run it' }], timestamp: 1 })
    // The type only admits JSON details; live sessions still end up holding
    // non-JSON values here, which is what this test reproduces.
    sessionManager.appendMessage({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'placeholder_tool',
      content: [{ type: 'text', text: 'ok' }],
      details: { job: { handler: async () => {} } },
      isError: false,
      timestamp: 2,
    } as unknown as ToolResultMessage)
    // The notice for a marked local failure, derived rather than pinned.
    const markedLocal: unknown = await wrapTransformContextWithLocalFailureMarker(async () => {
      throw new Error('placeholder')
    })([]).catch((err: unknown) => err)
    const localNotice = detectProviderError({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: (markedLocal as Error).message,
    })?.safeMessage

    try {
      const { session, dispose } = await createSessionWithDispose({
        sessionManager,
        systemPromptOverride: 'test local failure',
        tools: [],
      })
      const ended: unknown[] = []
      session.subscribe((event) => {
        if (event.type === 'message_end' && event.message.role === 'assistant') ended.push(event.message)
      })
      try {
        // when
        await session.prompt('next')

        // then
        expect(fetchCalls).toBe(0)
        expect(ended).toHaveLength(1)
        expect(ended[0]).toMatchObject({ stopReason: 'error' })
        expect(detectProviderError(ended[0])?.safeMessage).toBe(localNotice!)
      } finally {
        await dispose()
      }
    } finally {
      globalThis.fetch = previousFetch
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
      invalidateProviderAuthCache()
      __resetConfigForTesting()
      process.chdir(previousCwd)
    }
  })
})
