import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { defineTool as definePiTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { z } from 'zod'

import guardPlugin from '@/bundled-plugins/guard'
import { createDreamingSubagent } from '@/bundled-plugins/memory/dreaming'
import { createWriteReportTool } from '@/bundled-plugins/researcher/write-report'
import { checkPrivateSurfaceReadGuard } from '@/bundled-plugins/security/policies/private-surface-read'
import { buildOperationalIncidentChecks } from '@/doctor/operational-incidents'
import { hooklessGitArgs } from '@/git/hookless'
import { DeclaredSkillBinUnresolvedError, IncidentLedger, readIncidentLedger, RemediationRegistry } from '@/operations'
import { createPermissionService } from '@/permissions/permissions'
import { createHookBus, defineTool, type PluginRegistry, type ToolResult } from '@/plugin'
import { emptyRegistry } from '@/plugin/registry'
import {
  buildSandboxedCommand,
  canWriteAgentRootInSandbox,
  resolveProtectedZones,
  resolveHiddenPaths,
  SandboxDegradedProcError,
  SESSION_TMP_ROOT,
  resolvePrivilegedSandboxRuntime,
} from '@/sandbox'
import type { SandboxPolicy } from '@/sandbox'
import { resolveExposableEnvNames } from '@/sandbox/env-exposure'

import type { InternalGuard } from './guard-types'
import { buildInternalGuards } from './guards'
import { URL_FETCH_MAX_BYTES } from './multimodal/looker'
import {
  __resetSharedLoopGuardForTests,
  buildBashFilesystemPolicy,
  buildBuiltinPiToolOverrides,
  buildSandboxEnvPolicy,
  defaultBuiltinPiToolDefinitions,
  forgetSharedLoopGuardTool,
  sanitizeBashSpawnEnvironment,
  TYPECLAW_INTERNAL_BASH_ENV,
  TYPECLAW_INTERNAL_BASH_PREPARE,
  TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV,
  wrapBuiltinToolDefinition,
  wrapPluginTool,
  wrapSystemTool,
  zodToToolParameters,
} from './plugin-tools'
import type { SessionOrigin } from './session-origin'
import {
  createPinnedSnapshotBudgetForTests,
  enforceAndPinToolFiles,
  type PinnedToolFiles,
  TOOL_INPUT_MAX_BYTES,
  TOOL_INPUT_MAX_COUNT,
  writeToolOutputNoFollow,
} from './tool-file-safety'

beforeEach(() => {
  __resetSharedLoopGuardForTests()
})

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }
const lacksInodeAnchoring = process.platform !== 'linux'

function textOfFirstContent(result: { content: { type: string; text?: string }[] }): string | undefined {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : undefined
}

async function registerGuardPlugin(
  hooks: ReturnType<typeof createHookBus>,
  agentDir: string,
): Promise<readonly InternalGuard[]> {
  const exports = await guardPlugin.plugin({
    name: 'guard',
    version: undefined,
    agentDir,
    config: undefined,
    logger: noopLogger,
    permissions: createPermissionService(),
    github: {
      resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'test' }),
      hasAppTokenResolver: () => false,
    },
    spawnSubagent: async () => {},
  })
  hooks.registerAll('guard', agentDir, noopLogger, exports.hooks ?? {})
  return buildInternalGuards(agentDir).filter((guard) => guard.owner === 'guard')
}

function bundledAcknowledgementGuards(agentDir: string): readonly InternalGuard[] {
  return buildInternalGuards(agentDir)
}

describe('zodToToolParameters', () => {
  test('produces a JSON-schema-shaped object from a Zod schema', () => {
    const schema = z.object({ name: z.string(), age: z.number().optional() })
    const json = zodToToolParameters(schema) as { type?: string; properties?: Record<string, unknown> }
    expect(json.type).toBe('object')
    expect(json.properties).toBeDefined()
    expect(json.properties).toHaveProperty('name')
    expect(json.properties).toHaveProperty('age')
  })

  test('strips the $schema URI so Ajv (used by pi-ai) can compile the result', async () => {
    const schema = z.object({ path: z.string(), entryId: z.string().min(1) })
    const json = zodToToolParameters(schema) as Record<string, unknown>
    expect(json.$schema).toBeUndefined()

    const AjvModule = await import('ajv')
    const Ajv = (AjvModule as unknown as { default?: typeof AjvModule.default }).default ?? AjvModule
    const ajv = new (Ajv as new (...args: unknown[]) => { compile: (s: unknown) => unknown })({
      allErrors: true,
      strict: false,
      coerceTypes: true,
    })
    expect(() => ajv.compile(json)).not.toThrow()
  })

  test('preserves field-level constraints (format, pattern, minLength) after stripping $schema', () => {
    const schema = z.object({
      email: z.string().email(),
      id: z.string().uuid(),
      slug: z.string().min(1),
      pattern: z.string().regex(/^[a-z]+$/),
    })
    const json = zodToToolParameters(schema) as unknown as {
      properties: {
        email: { format?: string }
        id: { format?: string }
        slug: { minLength?: number }
        pattern: { pattern?: string }
      }
    }
    expect(json.properties.email.format).toBe('email')
    expect(json.properties.id.format).toBe('uuid')
    expect(json.properties.slug.minLength).toBe(1)
    expect(json.properties.pattern.pattern).toBe('^[a-z]+$')
  })
})

describe('wrapPluginTool', () => {
  test('composes declaration through namespaced schema and execution without exposing acknowledgements to checks', async () => {
    const checkArgs: Record<string, unknown>[] = []
    const executionArgs: Record<string, unknown>[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ value: z.string() }),
      async execute(args) {
        executionArgs.push(args)
        return { content: [{ type: 'text', text: args.value }] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('guard', '/agent', noopLogger, {})
    const guards: InternalGuard[] = [
      {
        owner: 'guard',
        key: 'nonWorkspaceWrite',
        tools: new Set(['write']),
        check: (event) => {
          checkArgs.push(structuredClone(event.args))
          return { kind: 'acknowledgement-required', reason: 'confirm write' }
        },
      },
    ]
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'fixture',
      toolName: 'write',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
      guards,
    })

    const parameters = wrapped.parameters as {
      properties?: Record<string, { properties?: Record<string, unknown>; additionalProperties?: boolean }>
    }
    const guardSchema = parameters.properties?.acknowledgeGuards?.properties?.guard as {
      properties?: Record<string, unknown>
    }
    expect(Object.keys(guardSchema.properties ?? {})).toEqual(['nonWorkspaceWrite'])
    expect(parameters.properties?.acknowledgeGuards?.additionalProperties).toBe(false)

    const result = await wrapped.execute(
      'c',
      { value: 'ok', acknowledgeGuards: { guard: { nonWorkspaceWrite: true } } },
      undefined,
      undefined,
      {} as never,
    )

    expect(textOfFirstContent(result)).toBe('ok')
    expect(checkArgs).toEqual([{ value: 'ok' }])
    expect(executionArgs).toEqual([{ value: 'ok' }])
  })

  test('rejects undeclared acknowledgement keys before plugin hooks or execution', async () => {
    let hookRan = false
    let executed = false
    const hooks = createHookBus()
    hooks.registerAll('guard', '/agent', noopLogger, {
      'tool.before': () => {
        hookRan = true
      },
    })
    const guards: InternalGuard[] = [
      {
        owner: 'guard',
        key: 'nonWorkspaceWrite',
        tools: new Set(['write']),
        check: () => undefined,
      },
    ]
    const wrapped = wrapPluginTool(
      defineTool({
        description: '',
        parameters: z.object({ value: z.string() }),
        async execute() {
          executed = true
          return { content: [] }
        },
      }),
      {
        pluginName: 'fixture',
        toolName: 'write',
        agentDir: '/agent',
        sessionId: 's',
        logger: noopLogger,
        hooks,
        guards,
      },
    )

    const result = await wrapped.execute(
      'c',
      { value: 'no', acknowledgeGuards: { guard: { otherAck: true } } },
      undefined,
      undefined,
      {} as never,
    )

    expect(result).toMatchObject({ isError: true })
    expect(textOfFirstContent(result)).toContain('otherAck')
    expect(hookRan).toBe(false)
    expect(executed).toBe(false)
  })

  test('blocks a declared filename operand that targets a canonical secret', async () => {
    const calls: string[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ filename: z.string() }),
      fileOperands: { input: ['filename'] },
      async execute(args) {
        calls.push(args.filename)
        return { content: [] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('security', '/agent', noopLogger, {
      'tool.before': (event) =>
        checkPrivateSurfaceReadGuard({
          tool: event.tool,
          args: event.args,
          agentDir: '/agent',
          hidden: { dirs: [], files: [] },
        }),
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'reader',
      toolName: 'plugin_reader',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    const result = await wrapped.execute('c', { filename: '/agent/.env' }, undefined, undefined, {} as never)

    expect(calls).toEqual([])
    expect(result).toMatchObject({ isError: true })
  })

  test('blocks a colliding plugin channel_send text operand that names a canonical secret', async () => {
    const calls: string[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ text: z.string() }),
      async execute(args) {
        calls.push(args.text)
        return { content: [] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('security', '/agent', noopLogger, {
      'tool.before': (event) =>
        checkPrivateSurfaceReadGuard({
          tool: event.tool,
          args: event.args,
          agentDir: '/agent',
          hidden: { dirs: [], files: [] },
          toolProvenance: event.toolProvenance,
        }),
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'collision',
      toolName: 'channel_send',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    const result = await wrapped.execute('c', { text: 'secrets.json' }, undefined, undefined, {} as never)

    expect(calls).toEqual([])
    expect(result).toMatchObject({ isError: true })
  })

  test('a nonFile-declared identifier colliding with a hidden dir passes the private-surface guard, undeclared still blocks', async () => {
    // Reproduces the guard-ordering the runtime uses: private-surface-read runs
    // in tool.before, BEFORE the file-operand scanner, and must honor the tool's
    // trusted `fileOperands.nonFile` (threaded through the event) or a declared
    // identifier equal to a hidden dir name is wrongly blocked.
    const seen: Array<Record<string, unknown>> = []
    const makeTool = () =>
      defineTool({
        description: '',
        parameters: z.object({ tenant: z.string(), region: z.string() }),
        fileOperands: { nonFile: ['tenant'] },
        async execute(args) {
          seen.push(args)
          return { content: [{ type: 'text', text: 'ok' }] }
        },
      })
    const hooks = createHookBus()
    hooks.registerAll('security', '/agent', noopLogger, {
      'tool.before': (event) =>
        checkPrivateSurfaceReadGuard({
          tool: event.tool,
          args: event.args,
          agentDir: '/agent',
          hidden: { dirs: ['/agent/memory'], files: [] },
          ...(event.fileOperands !== undefined ? { fileOperands: event.fileOperands } : {}),
        }),
    })
    const wrap = () =>
      wrapPluginTool(makeTool(), {
        pluginName: 'multi',
        toolName: 'tenant_status',
        agentDir: '/agent',
        sessionId: 's',
        logger: noopLogger,
        hooks,
      })

    // Declared nonFile operand equal to a hidden dir → allowed through the guard.
    const ok = await wrap().execute('c', { tenant: 'memory', region: 'us' }, undefined, undefined, {} as never)
    expect(textOfFirstContent(ok)).toBe('ok')
    expect(seen).toEqual([{ tenant: 'memory', region: 'us' }])

    // Undeclared operand equal to a hidden dir → still blocked (fail-closed).
    seen.length = 0
    const blocked = await wrap().execute('c', { tenant: 'ok', region: 'memory' }, undefined, undefined, {} as never)
    expect(blocked).toMatchObject({ isError: true })
    expect(seen).toEqual([])
  })

  test('passes parsed args to plugin execute and exposes ToolContext', async () => {
    const seen: { args: unknown; ctx: { sessionId: string; agentDir: string } }[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args, ctx) {
        seen.push({ args, ctx: { sessionId: ctx.sessionId, agentDir: ctx.agentDir } })
        return { content: [{ type: 'text', text: `q=${args.q}` }] }
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'sess-1',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    const result = (await wrapped.execute('call-1', { q: 'hello' }, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
    }
    expect(result.content[0]?.text).toBe('q=hello')
    expect(seen[0]?.args).toEqual({ q: 'hello' })
    expect(seen[0]?.ctx.sessionId).toBe('sess-1')
    expect(seen[0]?.ctx.agentDir).toBe('/agent')
  })

  test('tool.before mutations to args propagate to the plugin tool execute', async () => {
    const seen: unknown[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        seen.push(args)
        return { content: [{ type: 'text', text: '' }] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.q = 'mutated'
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    await wrapped.execute('c', { q: 'original' }, undefined, undefined, {} as never)
    expect(seen[0]).toEqual({ q: 'mutated' })
  })

  test('tool.before { block: true } refuses execution and never invokes plugin tool', async () => {
    const calls: number[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        calls.push(1)
        return { content: [] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no thanks' }),
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    const result = (await wrapped.execute('c', {}, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
      isError?: boolean
    }
    expect(calls).toEqual([])
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no thanks')
  })

  test('tool.after observes the plugin tool result', async () => {
    const observed: unknown[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'done' }] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.after': (event) => {
        observed.push(event.result.content[0])
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    await wrapped.execute('c', {}, undefined, undefined, {} as never)
    expect(observed[0]).toEqual({ type: 'text', text: 'done' })
  })

  test('returns error result when args fail Zod validation', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        return { content: [] }
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    const result = (await wrapped.execute('c', { q: 42 }, undefined, undefined, {} as never)) as {
      isError?: boolean
    }
    expect(result.isError).toBe(true)
  })

  test('returns error result when plugin tool throws', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        throw new Error('kaboom')
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    const result = (await wrapped.execute('c', {}, undefined, undefined, {} as never)) as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('kaboom')
  })

  test('forwards the AbortSignal from the engine through to the plugin tool', async () => {
    const captured: { signal: AbortSignal | undefined } = { signal: undefined }
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute(_args, ctx) {
        captured.signal = ctx.signal
        return { content: [] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    const controller = new AbortController()
    await wrapped.execute('c', {}, controller.signal, undefined, {} as never)
    expect(captured.signal).toBe(controller.signal)
  })

  test('hookless plugin tools cannot open canonical credentials', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-hookless-plugin-'))
    await writeFile(path.join(agentDir, 'secrets.json'), '{"secret":true}')
    let called = false
    const tool = defineTool({
      description: '',
      parameters: z.object({ path: z.string() }),
      async execute() {
        called = true
        return { content: [] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'reader',
      toolName: 'arbitrary_reader',
      agentDir,
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      await expect(wrapped.execute('c', { path: 'secrets.json' }, undefined, undefined, {} as never)).rejects.toThrow(
        /ambiguous.*fileOperands\.input.*file:/i,
      )
      expect(called).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('undeclared clear remote and control strings are not inferred as local files', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-semantic-operands-'))
    const seen: Array<Record<string, string>> = []
    const tool = defineTool({
      description: '',
      parameters: z.record(z.string(), z.string()),
      async execute(args) {
        seen.push(args)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'repository',
      toolName: 'repository_status',
      agentDir,
      sessionId: 'semantic-path',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    const args = {
      repository: 'acme/widgets',
      url: 'https://example.com/v1/items',
      date: '7/16',
      fraction: '2/3',
      path: '/v1/repos',
      packageName: '@scope/widgets',
      packageCoordinate: 'com.example:widgets:1.2.3',
    }
    try {
      const result = await wrapped.execute('c', args, undefined, undefined, {} as never)
      expect(textOfFirstContent(result)).toBe('ok')
      expect(seen).toEqual([args])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('semantic spelling does not exempt an undeclared operand that resolves to an existing local file', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-existing-semantic-operands-'))
    const cases: Array<readonly [string, string]> = [
      ['repository', 'acme/widgets'],
      ['date', '7/16'],
      ['fraction', '2/3'],
      ['packageName', '@scope/widgets'],
    ]
    // Windows cannot materialize local entries whose resolved components
    // contain the `:` in URLs or Maven coordinates. The representable semantic
    // forms still exercise existing-entry precedence there; POSIX covers both.
    if (process.platform !== 'win32') {
      cases.push(['url', 'https://example.com/v1/items'])
      cases.push(['packageCoordinate', 'com.example:widgets:1.2.3'])
    }
    for (const [, value] of cases) {
      const local = path.resolve(agentDir, value)
      await mkdir(path.dirname(local), { recursive: true })
      await writeFile(local, 'local')
    }
    const tool = defineTool({
      description: '',
      parameters: z.record(z.string(), z.string()),
      async execute() {
        return { content: [] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'reader',
      toolName: 'semantic_reader',
      agentDir,
      sessionId: 'existing-semantic',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      for (const [key, value] of cases) {
        await expect(wrapped.execute('c', { [key]: value }, undefined, undefined, {} as never)).rejects.toThrow(
          /ambiguous local file operand/i,
        )
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('plugin wrapper propagates diagnostics for undeclared existing local operands', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-plugin-operand-warning-'))
    await writeFile(path.join(agentDir, 'input.txt'), 'data')
    const warnings: string[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ value: z.string() }),
      async execute() {
        return { content: [] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'reader',
      toolName: 'undeclared_reader',
      agentDir,
      sessionId: 'warning',
      logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
      hooks: createHookBus(),
    })
    try {
      await expect(wrapped.execute('c', { value: 'input.txt' }, undefined, undefined, {} as never)).rejects.toThrow(
        /ambiguous local file operand/i,
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/fileOperands\.input|existing local/i)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('rejects a nonexistent output path before a plugin can race it to a secret symlink', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-undeclared-output-race-'))
    const destination = path.join(agentDir, 'result.txt')
    let called = false
    const tool = defineTool({
      description: '',
      parameters: z.object({ outputPath: z.string() }),
      async execute() {
        called = true
        await symlink(path.join(agentDir, 'secrets.json'), destination)
        return { content: [] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'writer',
      toolName: 'undeclared_writer',
      agentDir,
      sessionId: 'undeclared-output-race',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      await expect(
        wrapped.execute('c', { outputPath: 'result.txt' }, undefined, undefined, {} as never),
      ).rejects.toThrow(/ambiguous local file operand/i)
      expect(called).toBeFalse()
      expect(await Bun.file(destination).exists()).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('plugin-declared whole-array scalar inputs execute against immutable snapshots', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-declared-array-input-'))
    const safe = path.join(agentDir, 'safe.txt')
    const replacement = path.join(agentDir, 'replacement.txt')
    await writeFile(safe, 'safe')
    await writeFile(replacement, 'replacement')
    const tool = defineTool({
      description: '',
      parameters: z.object({ files: z.array(z.string()) }),
      fileOperands: { input: ['files'] },
      async execute(args) {
        await rm(safe)
        await symlink(replacement, safe)
        return { content: [{ type: 'text', text: await readFile(args.files[0] as string, 'utf8') }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'reader',
      toolName: 'declared_array_reader',
      agentDir,
      sessionId: 'declared-array-input',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      const result = await wrapped.execute('c', { files: ['safe.txt'] }, undefined, undefined, {} as never)
      expect(textOfFirstContent(result)).toBe('safe')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.each(['absolute-agent', 'relative', 'parent-relative', 'bare'])(
    'undeclared existing %s path-like plugin operands are rejected instead of dispatched with a TOCTOU window',
    async (kind) => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-undeclared-plugin-input-'))
      const safe = path.join(agentDir, 'safe.txt')
      await writeFile(safe, 'safe')
      let called = false
      const tool = defineTool({
        description: '',
        parameters: z.object({ inputPath: z.string() }),
        async execute() {
          called = true
          return { content: [] }
        },
      })
      const wrapped = wrapPluginTool(tool, {
        pluginName: 'reader',
        toolName: 'undeclared_reader',
        agentDir,
        sessionId: `undeclared-${kind}`,
        logger: noopLogger,
        hooks: createHookBus(),
      })
      try {
        const inputPath =
          kind === 'absolute-agent'
            ? path.join(agentDir, 'missing.txt')
            : kind === 'relative'
              ? './missing.txt'
              : kind === 'parent-relative'
                ? '../missing.txt'
                : 'safe.txt'
        await expect(wrapped.execute('c', { inputPath }, undefined, undefined, {} as never)).rejects.toThrow(
          /ambiguous.*fileOperands\.input.*file:/i,
        )
        expect(called).toBeFalse()
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('plugin-declared local input operands execute against an immutable snapshot', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-declared-plugin-input-'))
    const safe = path.join(agentDir, 'safe.txt')
    const replacement = path.join(agentDir, 'replacement.txt')
    await writeFile(safe, 'safe')
    await writeFile(replacement, 'replacement')
    const tool = defineTool({
      description: '',
      parameters: z.object({ path: z.string() }),
      fileOperands: { input: ['path'] },
      async execute(args) {
        await rm(safe)
        await symlink(replacement, safe)
        return { content: [{ type: 'text', text: await readFile(args.path, 'utf8') }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'reader',
      toolName: 'declared_reader',
      agentDir,
      sessionId: 'declared-input',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      const result = await wrapped.execute('c', { path: 'safe.txt' }, undefined, undefined, {} as never)
      expect(textOfFirstContent(result)).toBe('safe')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(lacksInodeAnchoring)('repeatedly pinning a file operand does not leak file descriptors', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-pin-fd-leak-'))
    await writeFile(path.join(agentDir, 'input.txt'), 'x'.repeat(4096))
    const fdCount = () => readdirSync('/proc/self/fd').length

    // Warm one cycle so lazy one-time descriptors are allocated before baseline.
    await (
      await enforceAndPinToolFiles({
        tool: 'reader',
        args: { path: 'input.txt' },
        agentDir,
        fileOperands: { input: ['path'] },
      })
    ).cleanup()

    const baseline = fdCount()
    for (let i = 0; i < 50; i++) {
      const pinned = await enforceAndPinToolFiles({
        tool: 'reader',
        args: { path: 'input.txt' },
        agentDir,
        fileOperands: { input: ['path'] },
      })
      await pinned.cleanup()
    }

    expect(fdCount()).toBeLessThanOrEqual(baseline)
    await rm(agentDir, { recursive: true, force: true })
  })

  test('researcher write_report preserves its absent O_EXCL output through the production plugin wrapper', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-wrapped-write-report-'))
    await mkdir(path.join(agentDir, 'workspace'))
    const destination = path.join(agentDir, 'workspace', 'research-wrapper.md')
    const wrapped = wrapPluginTool(createWriteReportTool(), {
      pluginName: 'researcher',
      toolName: 'researcher_1',
      agentDir,
      sessionId: `write-report-${Date.now()}`,
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      const execution = wrapped.execute(
        'c',
        { path: destination, content: '# Wrapped report' },
        undefined,
        undefined,
        {} as never,
      )
      if (lacksInodeAnchoring) {
        await expect(execution).rejects.toThrow(/requires Linux inode anchoring/i)
        return
      }
      const result = await execution
      expect(textOfFirstContent(result)).toContain('Wrote research report')
      expect(await readFile(destination, 'utf8')).toBe('# Wrapped report')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('researcher write_report still rejects an existing output through the production plugin wrapper', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-wrapped-existing-report-'))
    await mkdir(path.join(agentDir, 'workspace'))
    const destination = path.join(agentDir, 'workspace', 'research-existing.md')
    await writeFile(destination, 'original')
    const wrapped = wrapPluginTool(createWriteReportTool(), {
      pluginName: 'researcher',
      toolName: 'researcher_1',
      agentDir,
      sessionId: `existing-report-${Date.now()}`,
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      const execution = wrapped.execute(
        'c',
        { path: destination, content: 'replacement' },
        undefined,
        undefined,
        {} as never,
      )
      await expect(execution).rejects.toThrow(
        lacksInodeAnchoring ? /requires Linux inode anchoring/i : /must not already exist/i,
      )
      expect(await readFile(destination, 'utf8')).toBe('original')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('memory delete_topic_shard keeps its destructive semantic path unchanged through the production wrapper', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-wrapped-delete-topic-'))
    const topics = path.join(agentDir, 'memory', 'topics')
    await mkdir(topics, { recursive: true })
    await writeFile(path.join(topics, 'obsolete.md'), 'old')
    const subagent = createDreamingSubagent()
    const deleteTool = subagent.customTools?.[0]
    if (deleteTool === undefined) throw new Error('dreaming delete tool was not registered')
    const wrapped = wrapPluginTool(deleteTool, {
      pluginName: 'memory',
      toolName: 'dreaming_0',
      agentDir,
      sessionId: 'delete-topic',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      const rejected = await wrapped.execute(
        'absolute',
        { path: path.join(topics, 'obsolete.md') },
        undefined,
        undefined,
        {} as never,
      )
      expect(textOfFirstContent(rejected)).toContain('invalid_path')
      expect(await Bun.file(path.join(topics, 'obsolete.md')).exists()).toBeTrue()

      const deleted = await wrapped.execute(
        'relative',
        { path: 'memory/topics/obsolete.md' },
        undefined,
        undefined,
        {} as never,
      )
      expect(textOfFirstContent(deleted)).toContain('"ok":true')
      expect(await Bun.file(path.join(topics, 'obsolete.md')).exists()).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('plugin write tool rejects canonical secret target through enforceAndPinToolFiles without invoking plugin', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-plugin-write-secret-'))
    let called = false
    const tool = defineTool({
      description: '',
      parameters: z.object({ path: z.string(), content: z.string() }),
      async execute() {
        called = true
        return { content: [] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'writer',
      toolName: 'write',
      agentDir,
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    try {
      await expect(
        wrapped.execute('c', { path: 'public/report.md', content: 'secrets.json' }, undefined, undefined, {} as never),
      ).rejects.toThrow(/blocked.*privateSurfaceRead/)
      expect(called).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})

describe('wrapSystemTool', () => {
  test('local look_at snapshots share the remote-image byte ceiling', () => {
    expect(TOOL_INPUT_MAX_BYTES.look_at).toBe(URL_FETCH_MAX_BYTES)
  })

  test('session-level system-tool wrapping stays active with an empty hook bus', async () => {
    const { wrapSystemTools } = await import('./index')
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-empty-hooks-system-'))
    await writeFile(path.join(agentDir, '.env'), 'SECRET=never')
    let called = false
    const tool = definePiTool({
      name: 'look_at',
      label: 'look_at',
      description: '',
      parameters: Type.Any(),
      async execute() {
        called = true
        return { content: [], details: undefined }
      },
    })
    const [wrapped] = wrapSystemTools([tool], {
      agentDir,
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => undefined,
      getAbort: () => undefined,
    })
    try {
      if (wrapped === undefined) throw new Error('missing wrapped tool')
      await expect(
        wrapped.execute('c', { images: [{ path: '.env' }] } as never, undefined, undefined, {} as never),
      ).rejects.toThrow(/not available to LLM tools/)
      expect(called).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('tool.before mutations propagate to TypeClaw system tool execution and tool.after can rewrite the result', async () => {
    const seen: unknown[] = []
    const observed: unknown[] = []
    const tool = definePiTool({
      name: 'reload',
      label: 'reload',
      description: '',
      parameters: Type.Object({ q: Type.String() }),
      async execute(_callId, params) {
        seen.push(params)
        return { content: [{ type: 'text', text: `q=${params.q}` }], details: { q: params.q } }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.q = 'mutated'
      },
      'tool.after': (event) => {
        observed.push(event.result.details)
        event.result.content = [{ type: 'text', text: 'rewritten' }]
        event.result.details = { rewritten: true }
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const result = await wrapped.execute('c', { q: 'original' }, undefined, undefined, {} as never)
    expect(textOfFirstContent(result)).toBe('rewritten')
    expect(result.details).toEqual({ rewritten: true })
    expect(seen[0]).toEqual({ q: 'mutated' })
    expect(observed[0]).toEqual({ q: 'mutated' })
  })

  test('tool.before { block: true } rejects TypeClaw system tool execution through the engine error path', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'restart',
      label: 'restart',
      description: '',
      parameters: Type.Object({}),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no restart' }),
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(wrapped.execute('c', {}, undefined, undefined, {} as never)).rejects.toThrow('blocked: no restart')
    expect(calls).toEqual([])
  })

  test.skipIf(lacksInodeAnchoring)(
    'write system tool exposes and strips guard acknowledgements before execution',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-system-write-ack-'))
      const seen: unknown[] = []
      const tool = definePiTool({
        name: 'write',
        label: 'write',
        description: '',
        parameters: Type.Object(
          {
            path: Type.String(),
            content: Type.String(),
          },
          { additionalProperties: false },
        ),
        async execute(_callId, params) {
          seen.push({ ...params, path: 'notes.md' })
          await writeFile(params.path, params.content)
          return { content: [{ type: 'text', text: 'wrote' }], details: params }
        },
      })
      const hooks = createHookBus()
      hooks.registerAll('p1', agentDir, noopLogger, {
        'tool.before': (event) => {
          expect(event.args).not.toHaveProperty('acknowledgeGuards')
        },
      })
      const guards = await registerGuardPlugin(hooks, agentDir)

      const wrapped = wrapSystemTool(tool, {
        agentDir,
        sessionId: 's',
        hooks,
        guards,
      })

      const parameters = wrapped.parameters as { properties?: Record<string, unknown> }
      expect(parameters.properties).toHaveProperty('acknowledgeGuards')
      try {
        const result = await wrapped.execute(
          'c',
          { path: 'notes.md', content: '{}', acknowledgeGuards: { guard: { nonWorkspaceWrite: true } } },
          undefined,
          undefined,
          {} as never,
        )

        expect(seen[0]).toEqual({ path: 'notes.md', content: '{}' })
        expect(result.details).toEqual({ path: 'notes.md', content: '{}' })
        expect(await readFile(path.join(agentDir, 'notes.md'), 'utf8')).toBe('{}')
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('write system tool runs the registered guard after an earlier hook mutation', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.path = 'notes.md'
      },
    })
    const guards = await registerGuardPlugin(hooks, '/agent')

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks, guards })

    await expect(
      wrapped.execute('c', { path: 'workspace/file.txt', content: 'x' }, undefined, undefined, {} as never),
    ).rejects.toThrow('Guard `nonWorkspaceWrite` blocked write outside the workspace')
    expect(calls).toEqual([])
  })

  test('a throwing guard blocks later hooks and the underlying system tool', async () => {
    const calls: string[] = []
    const errors: string[] = []
    const tool = definePiTool({
      name: 'look_at',
      label: 'look_at',
      description: '',
      parameters: Type.Object({}),
      async execute() {
        calls.push('tool')
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll(
      'guard',
      '/agent',
      { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
      {},
    )
    hooks.registerAll('later', '/agent', noopLogger, {
      'tool.before': () => {
        calls.push('later-hook')
      },
    })
    const guards: InternalGuard[] = [
      {
        owner: 'guard',
        key: 'brokenCheck',
        tools: new Set(['look_at']),
        check: () => {
          throw new Error('unexpected failure')
        },
      },
    ]
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks, guards })

    await expect(wrapped.execute('c', {}, undefined, undefined, {} as never)).rejects.toThrow(
      'blocked: guard brokenCheck failed closed after its check threw',
    )
    expect(calls).toEqual([])
    expect(errors).toEqual(['guard brokenCheck threw: unexpected failure'])
  })

  test('write system tool runs the registered skill guard after an earlier hook mutation', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-plugin-tools-'))
    await mkdir(path.join(agentDir, 'memory', 'skills'), { recursive: true })
    const calls: number[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': (event) => {
        event.args.path = 'memory/skills/release-checklist/SKILL.md'
        event.args.content = 'not a skill file'
      },
    })
    const guards = await registerGuardPlugin(hooks, agentDir)

    const wrapped = wrapSystemTool(tool, { agentDir, sessionId: 's', hooks, guards })

    await expect(
      wrapped.execute('c', { path: 'workspace/file.txt', content: 'x' }, undefined, undefined, {} as never),
    ).rejects.toThrow('Guard `skillAuthoring` blocked write')
    expect(calls).toEqual([])
  })

  test('write system tool runs the registered managed-config guard after an earlier hook mutation', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.path = 'typeclaw.json'
        event.args.content = '{ not valid json'
      },
    })
    const guards = await registerGuardPlugin(hooks, '/agent')

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks, guards })

    await expect(
      wrapped.execute('c', { path: 'workspace/file.txt', content: 'x' }, undefined, undefined, {} as never),
    ).rejects.toThrow('Guard `managedConfig` blocked write')
    expect(calls).toEqual([])
  })

  test('hookless system tools deny canonical secrets for read, look_at, and channel uploads', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-hookless-secret-'))
    await writeFile(path.join(agentDir, '.env'), 'SECRET=never')
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'read', args: { path: '.env' } },
      { name: 'look_at', args: { images: [{ path: '.env' }] } },
      { name: 'channel_send', args: { attachments: [{ path: '.env' }] } },
    ]
    try {
      for (const testCase of cases) {
        let called = false
        const tool = definePiTool({
          name: testCase.name,
          label: testCase.name,
          description: '',
          parameters: Type.Any(),
          async execute() {
            called = true
            return { content: [], details: undefined }
          },
        })
        const wrapped = wrapSystemTool(tool, { agentDir, sessionId: 's', hooks: createHookBus() })
        await expect(wrapped.execute('c', testCase.args, undefined, undefined, {} as never)).rejects.toThrow(
          /not available to LLM tools/,
        )
        expect(called).toBeFalse()
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('hookless system MCP calls reject nested file URLs before dispatch', async () => {
    let called = false
    const tool = definePiTool({
      name: 'mcp_call',
      label: 'mcp_call',
      description: '',
      parameters: Type.Any(),
      async execute() {
        called = true
        return { content: [], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'mcp', hooks: createHookBus() })
    await expect(
      wrapped.execute(
        'c',
        { server: 'files', tool: 'read', args: { nested: { url: 'file:///agent/secrets.json' } } },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/not available to LLM tools/)
    expect(called).toBeFalse()
  })

  test('ambiguous system tools execute explicit file URLs against an immutable pinned copy', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-pinned-url-'))
    const safe = path.join(agentDir, 'safe.txt')
    const replacement = path.join(agentDir, 'replacement.txt')
    await writeFile(safe, 'safe')
    await writeFile(replacement, 'replacement')
    let startedResolve: () => void = () => {}
    const started = new Promise<void>((resolve) => (startedResolve = resolve))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const tool = definePiTool({
      name: 'custom_system_reader',
      label: 'custom_system_reader',
      description: '',
      parameters: Type.Any(),
      async execute(_id, params) {
        startedResolve()
        await gate
        const url = (params.args as { url: string }).url
        return { content: [{ type: 'text' as const, text: await Bun.file(new URL(url)).text() }], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, { agentDir, sessionId: 'mcp-pinned', hooks: createHookBus() })
    try {
      const resultPromise = wrapped.execute(
        'c',
        { server: 'files', tool: 'read', args: { url: pathToFileURL(safe).href } },
        undefined,
        undefined,
        {} as never,
      )
      await started
      await rm(safe)
      await symlink(replacement, safe)
      release()
      expect(textOfFirstContent(await resultPromise)).toBe('safe')
    } finally {
      release()
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('channel attachments reject process-backed files before opening them', async () => {
    await expect(
      enforceAndPinToolFiles({
        tool: 'channel_send',
        args: { attachments: [{ path: '/proc/self/environ' }] },
        agentDir: '/agent',
      }),
    ).rejects.toThrow(/virtual|process-backed|not available/i)
  })

  test('post_github_review args are not scanned as local file operands', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-review-operands-'))
    await mkdir(path.join(agentDir, 'src'), { recursive: true })
    await writeFile(path.join(agentDir, 'src', 'router.ts'), 'export const x = 1\n')

    const args: Record<string, unknown> = {
      event: 'REQUEST_CHANGES',
      body: 'router.ts introduces a risky path.',
      comments: [{ path: 'src/router.ts', line: 10, body: 'Anchored at a real repo file.' }],
    }

    const pinned = await enforceAndPinToolFiles({ tool: 'post_github_review', args, agentDir, genericInputs: true })
    await pinned.cleanup()

    expect(args.body).toBe('router.ts introduces a risky path.')
    expect((args.comments as Array<{ path: string }>)[0]?.path).toBe('src/router.ts')
    await rm(agentDir, { recursive: true, force: true })
  })

  test.each(['channel_send', 'channel_reply'] as const)(
    '%s text-only message with slashes is never treated as a file operand',
    async (tool) => {
      const slashyMessages = [
        '☀️ 사당동 날씨 (7/16 목) 27°C 맑음 | 강수확률 30%',
        'S&P 500 up 2/3 of a point today',
        'See https://example.com/report for details',
        'ratio 16/9 and path-like word src/index.ts in prose',
      ]
      for (const text of slashyMessages) {
        const pinned = await enforceAndPinToolFiles({
          tool,
          args: { adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHAN', text },
          agentDir: '/agent',
          genericInputs: true,
        })
        const result: ToolResult = { content: [{ type: 'text', text }], details: { echoed: text } }
        expect(pinned.restoreResult(result)).toEqual(result)
        await pinned.cleanup()
      }
    },
  )

  test('channel_send text-only send with a slash reaches the tool unchanged through the wrapper', async () => {
    const text = '뉴스 요약 (7/16): S&P +2/3, https://example.com/a'
    let received: string | undefined
    const tool = definePiTool({
      name: 'channel_send',
      label: 'channel_send',
      description: '',
      parameters: Type.Any(),
      async execute(_id, params) {
        received = (params as { text: string }).text
        return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'slash-text', hooks: createHookBus() })
    const result = await wrapped.execute(
      'c',
      { adapter: 'slack-bot', workspace: 'T0ACME', chat: 'C0CHAN', text },
      undefined,
      undefined,
      {} as never,
    )
    expect(received).toBe(text)
    expect(textOfFirstContent(result)).toBe('ok')
  })

  test('channel_send with slash-bearing text still pins the attachment path', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-channel-text-attach-'))
    const file = path.join(agentDir, 'report.txt')
    await writeFile(file, 'report body')
    try {
      let seenAttachmentPath: string | undefined
      const tool = definePiTool({
        name: 'channel_send',
        label: 'channel_send',
        description: '',
        parameters: Type.Any(),
        async execute(_id, params) {
          seenAttachmentPath = (params as { attachments: Array<{ path: string }> }).attachments[0]?.path
          const body = await readFile(seenAttachmentPath as string, 'utf8')
          return { content: [{ type: 'text' as const, text: body }], details: undefined }
        },
      })
      const wrapped = wrapSystemTool(tool, { agentDir, sessionId: 'text-attach', hooks: createHookBus() })
      const result = await wrapped.execute(
        'c',
        {
          adapter: 'slack-bot',
          workspace: 'T0ACME',
          chat: 'C0CHAN',
          text: 'here (7/16)',
          attachments: [{ path: file }],
        },
        undefined,
        undefined,
        {} as never,
      )
      expect(seenAttachmentPath).not.toBe(file)
      expect(textOfFirstContent(result)).toBe('report body')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('first-party prose operands with path-shaped values are never pinned or rejected', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-prose-'))
    await mkdir(path.join(agentDir, 'src'), { recursive: true })
    await writeFile(path.join(agentDir, 'src', 'router.ts'), 'x')

    const cases: Array<[string, Record<string, unknown>]> = [
      ['spawn_subagent', { subagent_type: 'explore', prompt: 'Look at src/router.ts and summarize.' }],
      ['spawn_subagent', { subagent_type: 'explore', description: 'check src/app.ts' }],
      ['skip_response', { reason: 'nothing to do, see notes.md' }],
      ['web_search', { query: 'how to configure vite.config.ts' }],
      ['web_fetch', { url: 'https://example.com/a', query: '.data[0].path', selector: 'div.a/b', pattern: 'a/b\\d' }],
      ['todo_write', { todos: [{ content: 'edit src/router.ts', status: 'pending', priority: 'high' }] }],
      ['channel_edit', { workspace: 'W', chat: 'C', message_id: '1', text: 'fixed in src/router.ts (7/16)' }],
    ]
    for (const [tool, args] of cases) {
      const before = JSON.stringify(args)
      const pinned = await enforceAndPinToolFiles({
        tool,
        args,
        agentDir,
        genericInputs: true,
        toolProvenance: 'first-party',
      })
      await pinned.cleanup()
      expect(JSON.stringify(args)).toBe(before)
    }
    await rm(agentDir, { recursive: true, force: true })
  })

  test('prose exemption is tool-scoped: an undeclared reader with a common key still fails closed', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-toolscoped-'))
    await writeFile(path.join(agentDir, 'data.json'), 'SENSITIVE')
    // `content`, `body`, `prompt`, `name` are opaque prose ONLY for their declared
    // first-party tools. An undeclared plugin/MCP reader must not inherit that.
    for (const key of ['content', 'body', 'prompt', 'name']) {
      await expect(
        enforceAndPinToolFiles({
          tool: 'plugin_reader',
          args: { [key]: `${agentDir}/data.json` },
          agentDir,
          genericInputs: true,
        }),
      ).rejects.toThrow(/ambiguous local file operand/)
    }
    await rm(agentDir, { recursive: true, force: true })
  })

  test('a whitespace- or case-varied file: URI is pinned, never passed through', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-ws-uri-'))
    await writeFile(path.join(agentDir, 'data.json'), 'SENSITIVE')
    const href = pathToFileURL(path.join(agentDir, 'data.json')).href
    const variants = [`  ${href}`, `\t${href}`, `\n${href}`, href.replace(/^file:/, 'FILE:')]
    for (const value of variants) {
      const args: Record<string, unknown> = { url: value }
      const pinned = await enforceAndPinToolFiles({ tool: 'web_fetch', args, agentDir, genericInputs: true })
      await pinned.cleanup()
      expect(String(args.url)).toContain('typeclaw-tool-input')
    }
    await rm(agentDir, { recursive: true, force: true })
  })

  test('a url field still pins an explicit file: URI (symlink-swap defense preserved)', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-url-pin-'))
    await writeFile(path.join(agentDir, 'src.txt'), 'real')
    const args: Record<string, unknown> = { url: pathToFileURL(path.join(agentDir, 'src.txt')).href }
    const pinned = await enforceAndPinToolFiles({ tool: 'custom_reader', args, agentDir, genericInputs: true })
    await pinned.cleanup()
    expect(String(args.url)).toContain('typeclaw-tool-input')
    await rm(agentDir, { recursive: true, force: true })
  })

  test('undeclared path-shaped operand on an unknown key still fails closed', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-failclosed-'))
    await writeFile(path.join(agentDir, 'data.bin'), 'd')
    await expect(
      enforceAndPinToolFiles({ tool: 'some_plugin_tool', args: { value: 'data.bin' }, agentDir, genericInputs: true }),
    ).rejects.toThrow(/ambiguous local file operand/)
    await rm(agentDir, { recursive: true, force: true })
  })

  test('reload scope collides with a real agent-dir directory but is not scanned as a file operand', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-reload-scope-'))
    await mkdir(path.join(agentDir, 'cron'), { recursive: true })
    await mkdir(path.join(agentDir, 'channels'), { recursive: true })

    for (const scope of ['cron', 'channels', 'config', 'plugins', 'skills']) {
      const args: Record<string, unknown> = { scope }
      const pinned = await enforceAndPinToolFiles({
        tool: 'reload',
        args,
        agentDir,
        genericInputs: true,
        toolProvenance: 'first-party',
      })
      await pinned.cleanup()
      expect(args.scope).toBe(scope)
    }
    await rm(agentDir, { recursive: true, force: true })
  })

  test('stream_snapshot target_kind "cron" is not scanned as a file operand despite a cron/ directory', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-stream-kind-'))
    await mkdir(path.join(agentDir, 'cron'), { recursive: true })

    const args: Record<string, unknown> = { target_kind: 'cron' }
    const pinned = await enforceAndPinToolFiles({
      tool: 'stream_snapshot',
      args,
      agentDir,
      genericInputs: true,
      toolProvenance: 'first-party',
    })
    await pinned.cleanup()
    expect(args.target_kind).toBe('cron')
    await rm(agentDir, { recursive: true, force: true })
  })

  test('grant_role permission "channel.respond" is not scanned as a dotted filename-like operand', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-grant-perm-'))

    const args: Record<string, unknown> = { role: 'guest', permission: 'channel.respond' }
    const pinned = await enforceAndPinToolFiles({
      tool: 'grant_role',
      args,
      agentDir,
      genericInputs: true,
      toolProvenance: 'first-party',
    })
    await pinned.cleanup()
    expect(args.permission).toBe('channel.respond')
    await rm(agentDir, { recursive: true, force: true })
  })

  test('non-file exemption is tool-scoped: an unknown tool reusing scope/target_kind still fails closed', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-nonfile-scoped-'))
    await mkdir(path.join(agentDir, 'cron'), { recursive: true })

    for (const [tool, key] of [
      ['plugin_reloader', 'scope'],
      ['plugin_streamer', 'target_kind'],
    ] as const) {
      await expect(
        enforceAndPinToolFiles({ tool, args: { [key]: 'cron' }, agentDir, genericInputs: true }),
      ).rejects.toThrow(/ambiguous local file operand/)
    }
    await rm(agentDir, { recursive: true, force: true })
  })

  test('the fs-existence probe still rejects an extensionless file or directory under a non-file key', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-probe-preserved-'))
    await writeFile(path.join(agentDir, 'credentials'), 'SECRET')
    await mkdir(path.join(agentDir, 'memory'), { recursive: true })

    for (const value of ['credentials', 'memory']) {
      await expect(
        enforceAndPinToolFiles({ tool: 'some_plugin_tool', args: { source: value }, agentDir, genericInputs: true }),
      ).rejects.toThrow(/ambiguous local file operand/)
    }
    await rm(agentDir, { recursive: true, force: true })
  })

  test('identifier-only system tools accept remote ids that trip dotted-value, cursor, and fs-probe rules', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-whole-tool-'))
    for (const dir of ['memory', 'channels', 'sessions', 'workspace']) {
      await mkdir(path.join(agentDir, dir), { recursive: true })
    }

    // Slack message/thread ids are always epoch.micros (dotted filename-like values); cursors carry
    // "/"; workspace/target_id/subagent_type/task_id can equal an agent-root dir.
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'channel_read',
        { mode: 'message', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', message_id: '1699999999.000100' },
      ],
      [
        'channel_read',
        { mode: 'history', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: '1699999999.000100' },
      ],
      [
        'channel_read',
        { mode: 'history', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', cursor: 'dGVhbTpU/bmV4dA==' },
      ],
      ['channel_read', { mode: 'list', adapter: 'slack-bot', workspace: 'memory' }],
      ['channel_history', { cursor: '1699999999.000100', scope: 'channel' }],
      [
        'channel_edit',
        { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', message_id: '1699999999.000100', text: 'x' },
      ],
      ['channel_react', { emoji: 'party.parrot' }],
      ['stream_snapshot', { target_kind: 'session', target_id: 'memory' }],
      ['grant_role', { role: 'guest', permission: 'channel.respond' }],
      ['spawn_subagent', { subagent_type: 'memory', prompt: 'hi' }],
      ['subagent_output', { task_id: 'sessions' }],
      ['subagent_cancel', { task_id: 'sessions' }],
      ['look_at_channel_attachment', { attachment_id: 1, prompt: 'describe /agent/workspace' }],
      ['channel_fetch_attachment', { attachment_id: 1, filename: 'memory/foo' }],
      [
        'post_github_review',
        {
          event: 'COMMENT',
          body: 'Review body',
          comments: [{ path: 'memory/foo', line: 1, body: 'Remote repository path' }],
        },
      ],
    ]
    for (const [tool, args] of cases) {
      const before = JSON.stringify(args)
      const pinned = await enforceAndPinToolFiles({
        tool,
        args,
        agentDir,
        genericInputs: true,
        toolProvenance: 'first-party',
      })
      await pinned.cleanup()
      expect(JSON.stringify(args)).toBe(before)
    }
    await rm(agentDir, { recursive: true, force: true })
  })

  test('whole-tool exemptions stay scoped and unknown tools remain fail-closed', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-wholetool-scoped-'))
    await mkdir(path.join(agentDir, 'memory'), { recursive: true })
    for (const args of [{ message_id: '1699999999.000100' }, { cursor: 'a/b/c' }, { workspace: 'memory' }]) {
      await expect(
        enforceAndPinToolFiles({ tool: 'plugin_channel_like', args, agentDir, genericInputs: true }),
      ).rejects.toThrow(/ambiguous local file operand/)
    }
    await rm(agentDir, { recursive: true, force: true })
  })

  test('reviewer_checkout keeps its nonFile declaration while strict repoSlug grammar also avoids false positives', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-reposlug-'))
    const declared = { nonFile: ['repoSlug', 'headSha'] } as const

    // The tool declares repoSlug/headSha as non-file; the "/" in owner/repo is
    // then not misread as a path separator. (The tool's own REPO_SLUG regex
    // rejects traversal downstream — the scanner no longer second-guesses it.)
    const ok: Record<string, unknown> = { repoSlug: 'typeclaw/typeclaw', headSha: 'a'.repeat(40) }
    const pinned = await enforceAndPinToolFiles({
      tool: 'reviewer_checkout',
      args: ok,
      agentDir,
      genericInputs: true,
      fileOperands: declared,
    })
    await pinned.cleanup()
    expect(ok.repoSlug).toBe('typeclaw/typeclaw')

    const semanticArgs: Record<string, unknown> = { repoSlug: 'typeclaw/typeclaw' }
    const semanticPinned = await enforceAndPinToolFiles({
      tool: 'unknown_plugin',
      args: semanticArgs,
      agentDir,
      genericInputs: true,
    })
    await semanticPinned.cleanup()
    await expect(
      enforceAndPinToolFiles({
        tool: 'unknown_plugin',
        args: { repoSlug: '../etc/passwd' },
        agentDir,
        genericInputs: true,
      }),
    ).rejects.toThrow(/ambiguous local file operand/)
    await rm(agentDir, { recursive: true, force: true })
  })

  test('a plugin fileOperands.nonFile declaration exempts its operands but stays tool+path scoped', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-nonfile-decl-'))
    await mkdir(path.join(agentDir, 'sessions'), { recursive: true })

    // Runtime prefixes subagent custom-tool names, so a static in-scanner table
    // keyed by "memory_append" would miss it; the declaration travels with the tool.
    const operands = { nonFile: ['topic', 'body'] } as const
    const ok: Record<string, unknown> = { topic: 'sessions', body: 'see a/b/c for detail' }
    const pinned = await enforceAndPinToolFiles({
      tool: '__plugin_memory_memory-logger_3',
      args: ok,
      agentDir,
      genericInputs: true,
      fileOperands: operands,
    })
    await pinned.cleanup()
    expect(ok).toEqual({ topic: 'sessions', body: 'see a/b/c for detail' })

    // An UNDECLARED operand on the same tool must still fail closed.
    await expect(
      enforceAndPinToolFiles({
        tool: '__plugin_memory_memory-logger_3',
        args: { topic: 'ok', attachment: 'sessions' },
        agentDir,
        genericInputs: true,
        fileOperands: operands,
      }),
    ).rejects.toThrow(/ambiguous local file operand/)
    await rm(agentDir, { recursive: true, force: true })
  })

  test('a declared real-file input is pinned to an immutable snapshot, not rejected', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-input-pin-'))
    await mkdir(path.join(agentDir, 'sessions'), { recursive: true })
    await writeFile(path.join(agentDir, 'sessions', 'ses_x.jsonl'), '{"id":"e1"}\n')

    const args: Record<string, unknown> = { path: 'sessions/ses_x.jsonl', entryId: 'e1' }
    const pinned = await enforceAndPinToolFiles({
      tool: '__plugin_memory_find_0',
      args,
      agentDir,
      genericInputs: true,
      fileOperands: { input: ['path'] },
    })
    expect(String(args.path)).toContain('typeclaw-tool-input')
    await pinned.cleanup()
    await rm(agentDir, { recursive: true, force: true })
  })

  test('parallel read, look_at, and channel upload calls consume pinned bytes across symlink swaps', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-pinned-read-'))
    const safe = path.join(agentDir, 'safe.txt')
    const secret = path.join(agentDir, '.env')
    const aliases = Array.from({ length: 8 }, (_, i) => path.join(agentDir, `alias-${i}.txt`))
    await writeFile(safe, 'safe bytes')
    await writeFile(secret, 'secret bytes')
    await Promise.all(aliases.map((alias) => symlink(safe, alias)))

    const releases: Array<() => void> = []
    const started: Promise<void>[] = []
    const names = [
      'read',
      'look_at',
      'channel_send',
      'channel_reply',
      'read',
      'look_at',
      'channel_send',
      'channel_reply',
    ]

    try {
      const calls = aliases.map((alias, i) => {
        const name = names[i] as string
        const tool = definePiTool({
          name,
          label: name,
          description: '',
          parameters: Type.Any(),
          async execute(_callId, params) {
            let markStarted: () => void = () => {}
            started.push(new Promise<void>((resolve) => (markStarted = resolve)))
            let release: () => void = () => {}
            const gate = new Promise<void>((resolve) => (release = resolve))
            releases.push(release)
            markStarted()
            await gate
            const inputPath =
              typeof params.path === 'string'
                ? params.path
                : name === 'look_at'
                  ? (params.images as Array<{ path: string }>)[0]?.path
                  : (params.attachments as Array<{ path: string }>)[0]?.path
            if (inputPath === undefined) throw new Error('missing pinned input')
            return { content: [{ type: 'text' as const, text: await readFile(inputPath, 'utf8') }], details: undefined }
          },
        })
        const wrapped = wrapSystemTool(tool, { agentDir, sessionId: `s-${i}`, hooks: createHookBus() })
        const args =
          name === 'read'
            ? { path: alias }
            : name === 'look_at'
              ? { images: [{ path: alias }] }
              : { attachments: [{ path: alias }] }
        return wrapped.execute(String(i), args, undefined, undefined, {} as never)
      })
      while (started.length < calls.length) await Bun.sleep(1)
      await Promise.all(started)
      await Promise.all(aliases.map((alias) => rm(alias)))
      await Promise.all(aliases.map((alias) => symlink(secret, alias)))
      for (const release of releases) release()
      const results = await Promise.all(calls)
      expect(results.map((result) => textOfFirstContent(result))).toEqual(
        Array.from({ length: calls.length }, () => 'safe bytes'),
      )
    } finally {
      for (const release of releases) release()
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('absent input operands cannot appear as secret symlinks before execution', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-absent-input-'))
    const secret = path.join(agentDir, '.env')
    await writeFile(secret, 'secret bytes')
    const aliases = Array.from({ length: 24 }, (_, i) => path.join(agentDir, `late-${i}.txt`))
    let called = 0
    const tool = definePiTool({
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        called++
        return { content: [], details: undefined }
      },
    })

    try {
      const calls = aliases.map((alias, i) => {
        const wrapped = wrapSystemTool(tool, { agentDir, sessionId: `late-${i}`, hooks: createHookBus() })
        return wrapped.execute(String(i), { path: alias }, undefined, undefined, {} as never).then(
          () => false,
          () => true,
        )
      })
      await Promise.all(aliases.map((alias) => symlink(secret, alias).catch(() => {})))
      expect(await Promise.all(calls)).toEqual(Array.from({ length: aliases.length }, () => true))
      expect(called).toBe(0)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(lacksInodeAnchoring)(
    'a nonexistent write destination remains valid because it is output, not input',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-output-destination-'))
      await mkdir(path.join(agentDir, 'workspace'))
      const destination = path.join(agentDir, 'workspace', 'new-output.txt')
      const tool = definePiTool({
        name: 'write',
        label: 'write',
        description: '',
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        async execute(_callId, params) {
          expect(await Bun.file(destination).exists()).toBeTrue()
          expect(params.path).toMatch(/^\/proc\/self\/fd\/\d+$/)
          expect((await stat(destination)).mode & 0o777).toBe(0o666 & ~process.umask())
          await writeFile(params.path, params.content)
          return { content: [{ type: 'text' as const, text: 'wrote' }], details: undefined }
        },
      })
      const wrapped = wrapSystemTool(tool, { agentDir, sessionId: 'output', hooks: createHookBus() })
      try {
        await wrapped.execute('c', { path: destination, content: 'ok' }, undefined, undefined, {} as never)
        expect(await readFile(destination, 'utf8')).toBe('ok')
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('missing-parent writes fail closed before creating or authorizing an unanchored path', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-missing-parent-output-'))
    const destination = path.join(agentDir, 'workspace', 'missing', 'output.txt')
    try {
      await expect(
        enforceAndPinToolFiles({ tool: 'write', args: { path: destination, content: 'x' }, agentDir }),
      ).rejects.toThrow(/parent|anchor|Linux/i)
      expect(await Bun.file(destination).exists()).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('an already-aborted write stops before path authorization or filesystem mutation', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-aborted-output-auth-'))
    const destination = path.join(agentDir, '.env')
    const controller = new AbortController()
    controller.abort('cancel before authorization')
    try {
      await expect(
        enforceAndPinToolFiles({
          tool: 'write',
          args: { path: destination, content: 'never' },
          agentDir,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/abort|cancel/i)
      expect(await Bun.file(destination).exists()).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('rejects oversized read, look_at, and channel-upload inputs before tool execution', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-oversized-input-'))
    const cases = [
      { name: 'read', limit: TOOL_INPUT_MAX_BYTES.read, args: (file: string) => ({ path: file }) },
      { name: 'look_at', limit: TOOL_INPUT_MAX_BYTES.look_at, args: (file: string) => ({ images: [{ path: file }] }) },
      {
        name: 'channel_send',
        limit: TOOL_INPUT_MAX_BYTES.channel_upload,
        args: (file: string) => ({ attachments: [{ path: file }] }),
      },
    ]
    let called = 0
    try {
      for (const [index, testCase] of cases.entries()) {
        const file = path.join(agentDir, `oversized-${index}.bin`)
        await writeFile(file, '')
        await truncate(file, testCase.limit + 1)
        const tool = definePiTool({
          name: testCase.name,
          label: testCase.name,
          description: '',
          parameters: Type.Any(),
          async execute() {
            called++
            return { content: [], details: undefined }
          },
        })
        const wrapped = wrapSystemTool(tool, {
          agentDir,
          sessionId: `oversized-${index}`,
          hooks: createHookBus(),
        })
        await expect(
          wrapped.execute(String(index), testCase.args(file), undefined, undefined, {} as never),
        ).rejects.toThrow(new RegExp(`> ${testCase.limit} byte limit`))
      }
      expect(called).toBe(0)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('rejects repeated near-limit look_at and channel attachments over the aggregate byte ceiling', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-aggregate-input-'))
    const snapshotRoot = path.join(agentDir, 'snapshots')
    await mkdir(snapshotRoot)
    const cases = [
      {
        tool: 'look_at',
        limit: TOOL_INPUT_MAX_BYTES.look_at,
        args: (files: string[]) => ({ images: files.map((file) => ({ path: file })) }),
      },
      {
        tool: 'channel_send',
        limit: TOOL_INPUT_MAX_BYTES.channel_upload,
        args: (files: string[]) => ({ attachments: files.map((file) => ({ path: file })) }),
      },
    ]
    try {
      for (const [index, testCase] of cases.entries()) {
        const files = [
          path.join(agentDir, `near-limit-${index}-a.bin`),
          path.join(agentDir, `near-limit-${index}-b.bin`),
        ]
        await Promise.all(
          files.map(async (file) => {
            await writeFile(file, '')
            await truncate(file, Math.floor(testCase.limit * 0.75))
          }),
        )

        await expect(
          enforceAndPinToolFiles({
            tool: testCase.tool,
            args: testCase.args(files),
            agentDir,
            tempRoot: snapshotRoot,
          }),
        ).rejects.toThrow(/aggregate.*byte limit/i)
        expect(await readdir(snapshotRoot)).toEqual([])
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('rejects unbounded local-input arrays at the per-invocation count ceiling before snapshotting', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-input-count-'))
    const snapshotRoot = path.join(agentDir, 'snapshots')
    await mkdir(snapshotRoot)
    const file = path.join(agentDir, 'small.bin')
    await writeFile(file, 'x')
    try {
      await expect(
        enforceAndPinToolFiles({
          tool: 'look_at',
          args: { images: Array.from({ length: TOOL_INPUT_MAX_COUNT.look_at + 1 }, () => ({ path: file })) },
          agentDir,
          tempRoot: snapshotRoot,
        }),
      ).rejects.toThrow(new RegExp(`count.*> ${TOOL_INPUT_MAX_COUNT.look_at}`, 'i'))
      expect(await readdir(snapshotRoot)).toEqual([])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('cleans a partial snapshot when a later attachment exceeds its byte limit', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-snapshot-cleanup-'))
    const snapshotRoot = path.join(agentDir, 'snapshots')
    await mkdir(snapshotRoot)
    const small = path.join(agentDir, 'small.txt')
    const oversized = path.join(agentDir, 'oversized.bin')
    await writeFile(small, 'small')
    await writeFile(oversized, '')
    await truncate(oversized, TOOL_INPUT_MAX_BYTES.channel_upload + 1)
    try {
      await expect(
        enforceAndPinToolFiles({
          tool: 'channel_reply',
          args: { attachments: [{ path: small }, { path: oversized }] },
          agentDir,
          tempRoot: snapshotRoot,
        }),
      ).rejects.toThrow(/tool input is too large/)
      expect(await readdir(snapshotRoot)).toEqual([])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('removes a successful immutable snapshot when tool execution cleanup runs', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-snapshot-success-'))
    const snapshotRoot = path.join(agentDir, 'snapshots')
    await mkdir(snapshotRoot)
    const input = path.join(agentDir, 'input.txt')
    await writeFile(input, 'bounded input')
    const args: Record<string, unknown> = { path: input }
    try {
      const pinned = await enforceAndPinToolFiles({ tool: 'read', args, agentDir, tempRoot: snapshotRoot })
      expect(await readdir(snapshotRoot)).toHaveLength(1)
      expect(await readFile(args.path as string, 'utf8')).toBe('bounded input')
      await pinned.cleanup()
      expect(await readdir(snapshotRoot)).toEqual([])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'linux')(
    'snapshots an ordinary multi-link regular input after hidden-alias checks pass',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-safe-hardlink-input-'))
      const source = path.join(agentDir, 'source.txt')
      const alias = path.join(agentDir, 'alias.txt')
      await writeFile(source, 'public data')
      await link(source, alias)
      const args: Record<string, unknown> = { path: alias }
      try {
        const pinned = await enforceAndPinToolFiles({ tool: 'read', args, agentDir })
        expect(await readFile(args.path as string, 'utf8')).toBe('public data')
        await pinned.cleanup()
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.each(['canonical', 'role-hidden'])('rejects a multi-link input aliasing a %s file', async (kind) => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-hidden-hardlink-input-'))
    const hiddenDir = path.join(agentDir, 'memory')
    const publicDir = path.join(agentDir, 'public')
    await mkdir(hiddenDir)
    await mkdir(publicDir)
    const hiddenFile = kind === 'canonical' ? path.join(agentDir, '.env') : path.join(hiddenDir, 'notes.txt')
    const alias = path.join(publicDir, 'alias.txt')
    await writeFile(hiddenFile, 'private data')
    await link(hiddenFile, alias)
    try {
      await expect(
        enforceAndPinToolFiles({
          tool: 'read',
          args: { path: alias },
          agentDir,
          hidden: kind === 'role-hidden' ? { dirs: [hiddenDir], files: [] } : { dirs: [], files: [] },
        }),
      ).rejects.toThrow(/not available|hidden|hardlink/i)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('direct snapshots reject a file hardlinked to .env after initial authorization but before open', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-direct-hardlink-race-'))
    const input = path.join(agentDir, 'input.txt')
    const env = path.join(agentDir, '.env')
    await writeFile(input, 'safe before hardlink')
    let acquiredResolve!: () => void
    const acquired = new Promise<void>((resolve) => {
      acquiredResolve = resolve
    })
    let openResolve!: () => void
    const allowOpen = new Promise<void>((resolve) => {
      openResolve = resolve
    })
    try {
      let dispatched = false
      const waiting = enforceAndPinToolFiles(
        { tool: 'read', args: { path: input }, agentDir },
        {
          async afterBudgetAcquire() {
            acquiredResolve()
            await allowOpen
          },
        },
      ).then(
        async (pinned) => {
          dispatched = true
          await pinned.cleanup()
          return undefined
        },
        (error: unknown) => error,
      )
      await acquired
      await link(input, env)
      openResolve()

      const failure = await waiting
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(
        /(?:not available to LLM tools|hard links.*copy.*unique regular file)/i,
      )
      expect(dispatched).toBeFalse()
    } finally {
      openResolve()
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'linux')(
    'recursive directory snapshots reject a nested file hardlinked to .env',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-tree-hardlink-'))
      const tree = path.join(agentDir, 'safe-tree', 'nested')
      const env = path.join(agentDir, '.env')
      await mkdir(tree, { recursive: true })
      await writeFile(env, 'secret')
      await link(env, path.join(tree, 'alias.txt'))
      try {
        await expect(
          enforceAndPinToolFiles({ tool: 'grep', args: { path: path.join(agentDir, 'safe-tree') }, agentDir }),
        ).rejects.toThrow(/hardlink|hard links|aliases cannot be bounded/i)
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('holds the process-wide pinned-count reservation through cleanup', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-global-snapshot-budget-'))
    const files = Array.from({ length: 3 }, (_, i) => path.join(agentDir, `${i}.png`))
    await Promise.all(files.map(async (file) => await writeFile(file, 'x')))
    let waitingResolve!: () => void
    const waitingForCapacity = new Promise<void>((resolve) => {
      waitingResolve = resolve
    })
    const budget = createPinnedSnapshotBudgetForTests({
      maxBytes: 3,
      maxCount: 2,
      maxWaiters: 1,
      onWait: waitingResolve,
    })
    const make = (slice: string[]) =>
      enforceAndPinToolFiles(
        {
          tool: 'look_at',
          args: { images: slice.map((file) => ({ path: file })) },
          agentDir,
        },
        { pinnedSnapshotBudgetForTests: budget },
      )
    let first: Awaited<ReturnType<typeof make>> | undefined
    let second: Awaited<ReturnType<typeof make>> | undefined
    let third: Awaited<ReturnType<typeof make>> | undefined
    let waiting: ReturnType<typeof make> | undefined
    try {
      first = await make([files[0] as string])
      second = await make([files[1] as string])
      let settled = false
      waiting = make([files[2] as string]).then((value) => {
        settled = true
        return value
      })
      await waitingForCapacity
      expect(settled).toBeFalse()
      await first.cleanup()
      first = undefined
      third = await waiting
      waiting = undefined
      expect(settled).toBeTrue()
    } finally {
      await first?.cleanup()
      const pending = await waiting
      await pending?.cleanup()
      await second?.cleanup()
      await third?.cleanup()
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('aborting a queued snapshot waiter removes it without consuming capacity', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-aborted-snapshot-waiter-'))
    const files = Array.from({ length: 2 }, (_, i) => path.join(agentDir, `${i}.bin`))
    await Promise.all(files.map(async (file) => await writeFile(file, 'x')))
    let waitingResolve!: () => void
    const waitingForCapacity = new Promise<void>((resolve) => {
      waitingResolve = resolve
    })
    const budget = createPinnedSnapshotBudgetForTests({
      maxBytes: 2,
      maxCount: 1,
      maxWaiters: 1,
      onWait: waitingResolve,
    })
    let holder: Awaited<ReturnType<typeof enforceAndPinToolFiles>> | undefined
    try {
      holder = await enforceAndPinToolFiles(
        { tool: 'channel_send', args: { attachments: [{ path: files[0] as string }] }, agentDir },
        { pinnedSnapshotBudgetForTests: budget },
      )
      const controller = new AbortController()
      const waiting = enforceAndPinToolFiles(
        { tool: 'read', args: { path: files[1] as string }, agentDir, signal: controller.signal },
        { pinnedSnapshotBudgetForTests: budget },
      )
      await waitingForCapacity
      controller.abort('cancelled test waiter')
      await expect(waiting).rejects.toThrow(/abort|cancel/i)
      await holder.cleanup()
      holder = undefined
      const next = await enforceAndPinToolFiles(
        { tool: 'read', args: { path: files[1] as string }, agentDir },
        { pinnedSnapshotBudgetForTests: budget },
      )
      await next.cleanup()
    } finally {
      await holder?.cleanup()
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('rejects excess queued snapshot waiters with a deterministic bound', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-bounded-snapshot-waiters-'))
    const files = Array.from({ length: 2 }, (_, i) => path.join(agentDir, `${i}.bin`))
    await Promise.all(files.map(async (file) => await writeFile(file, 'x')))
    const budget = createPinnedSnapshotBudgetForTests({ maxBytes: 2, maxCount: 1, maxWaiters: 2 })
    const controllers: AbortController[] = []
    type WaiterOutcome = { error: unknown } | { pinned: Awaited<ReturnType<typeof enforceAndPinToolFiles>> }
    let waiters: Array<Promise<WaiterOutcome>> = []
    let holder: Awaited<ReturnType<typeof enforceAndPinToolFiles>> | undefined
    try {
      holder = await enforceAndPinToolFiles(
        { tool: 'channel_send', args: { attachments: [{ path: files[0] as string }] }, agentDir },
        { pinnedSnapshotBudgetForTests: budget },
      )
      waiters = Array.from({ length: 3 }, () => {
        const controller = new AbortController()
        controllers.push(controller)
        return enforceAndPinToolFiles(
          { tool: 'read', args: { path: files[1] as string }, agentDir, signal: controller.signal },
          { pinnedSnapshotBudgetForTests: budget },
        ).then<WaiterOutcome, WaiterOutcome>(
          (pinned) => ({ pinned }),
          (error: unknown) => ({ error }),
        )
      })
      const overflow = await Promise.race(waiters)
      if (!('error' in overflow)) throw new Error('a queued snapshot waiter acquired capacity unexpectedly')
      expect(overflow.error).toBeInstanceOf(Error)
      expect((overflow.error as Error).message).toMatch(/waiter|queue/i)
    } finally {
      for (const controller of controllers) controller.abort()
      await holder?.cleanup()
      holder = undefined
      const outcomes = await Promise.all(waiters)
      await Promise.all(outcomes.flatMap((outcome) => ('pinned' in outcome ? [outcome.pinned.cleanup()] : [])))
      await rm(agentDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('charges streamed file growth against the process-wide byte budget', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-growing-snapshot-budget-'))
    const holderFile = path.join(agentDir, 'holder.bin')
    const growingFile = path.join(agentDir, 'growing.bin')
    await Promise.all([writeFile(holderFile, ''), writeFile(growingFile, '')])
    await Promise.all([truncate(holderFile, 40 * 1024 * 1024), truncate(growingFile, 60 * 1024 * 1024)])

    let acquiredResolve!: () => void
    const acquired = new Promise<void>((resolve) => {
      acquiredResolve = resolve
    })
    let streamResolve!: () => void
    const allowStreaming = new Promise<void>((resolve) => {
      streamResolve = resolve
    })

    type GrowingOutcome =
      | { ok: true; pinned: Awaited<ReturnType<typeof enforceAndPinToolFiles>> }
      | { ok: false; error: unknown }
    let holder: Awaited<ReturnType<typeof enforceAndPinToolFiles>> | undefined
    let unexpected: Awaited<ReturnType<typeof enforceAndPinToolFiles>> | undefined
    try {
      // 40MiB holder stays leased for the whole test, so any stream past the
      // growing file's declared 60MiB pushes the global total over 100MiB.
      holder = await enforceAndPinToolFiles({
        tool: 'channel_send',
        args: { attachments: [{ path: holderFile }] },
        agentDir,
      })
      const outcome = enforceAndPinToolFiles(
        { tool: 'read', args: { path: growingFile }, agentDir },
        {
          async afterBudgetAcquire() {
            acquiredResolve()
            await allowStreaming
          },
        },
      ).then<GrowingOutcome, GrowingOutcome>(
        (pinned) => {
          unexpected = pinned
          return { ok: true, pinned }
        },
        (error: unknown) => ({ ok: false, error }),
      )

      await acquired
      await truncate(growingFile, 61 * 1024 * 1024)
      streamResolve()
      const result = await outcome
      expect(result.ok).toBeFalse()
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error)
        expect((result.error as Error).message).toMatch(/process-wide pinned byte budget|snapshot growth/i)
      }
    } finally {
      streamResolve()
      await holder?.cleanup()
      await unexpected?.cleanup()
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'linux')(
    'grep executes against an immutable directory snapshot across a symlink swap',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-grep-snapshot-'))
      const safeDir = path.join(agentDir, 'safe')
      const secretDir = path.join(agentDir, 'secret')
      const alias = path.join(agentDir, 'search')
      await mkdir(safeDir)
      await mkdir(secretDir)
      await writeFile(path.join(safeDir, 'result.txt'), 'safe')
      await writeFile(path.join(secretDir, 'result.txt'), 'secret')
      await symlink(safeDir, alias)
      let startedResolve: () => void = () => {}
      const started = new Promise<void>((resolve) => (startedResolve = resolve))
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      const tool = definePiTool({
        name: 'grep',
        label: 'grep',
        description: '',
        parameters: Type.Any(),
        async execute(_id, params) {
          expect((await stat(params.path as string)).mode & 0o777).toBe(0o500)
          expect((await stat(path.join(params.path as string, 'result.txt'))).mode & 0o777).toBe(0o400)
          startedResolve()
          await gate
          return {
            content: [
              { type: 'text' as const, text: await readFile(path.join(params.path as string, 'result.txt'), 'utf8') },
            ],
            details: undefined,
          }
        },
      })
      const wrapped = wrapBuiltinToolDefinition(tool, {
        agentDir,
        sessionId: 'grep-snapshot',
        hooks: createHookBus(),
      })
      try {
        const resultPromise = wrapped.execute('c', { path: alias }, undefined, undefined, {} as never)
        await started
        await rm(alias)
        await symlink(secretDir, alias)
        release()
        expect(textOfFirstContent(await resultPromise)).toBe('safe')
      } finally {
        release()
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'grep, find, and ls omitted and explicit roots preserve visible discovery while excluding role-hidden descendants',
    async () => {
      const guestTree: SessionOrigin = {
        kind: 'subagent',
        subagent: 'tree-test',
        parentSessionId: 'parent',
        spawnedByRole: 'guest',
      }
      for (const rootMode of ['omitted', 'explicit'] as const) {
        for (const name of ['grep', 'find', 'ls']) {
          const agentDir = await mkdtemp(path.join(tmpdir(), `typeclaw-${name}-${rootMode}-hidden-`))
          await writeFile(path.join(agentDir, 'visible.txt'), 'needle')
          await writeFile(path.join(agentDir, '.env'), 'SECRET=never')
          await writeFile(path.join(agentDir, 'secrets.json'), '{"secret":true}')
          for (const hiddenDir of ['sessions', 'memory', 'workspace']) {
            await mkdir(path.join(agentDir, hiddenDir))
            await writeFile(path.join(agentDir, hiddenDir, 'hidden.txt'), 'needle')
          }
          const tool = definePiTool({
            name,
            label: name,
            description: '',
            parameters: Type.Any(),
            async execute(_id, params) {
              const entries = await readdir(params.path as string)
              return {
                content: [{ type: 'text' as const, text: entries.sort().join('\n') }],
                details: { path: params.path },
              }
            },
          })
          const wrapped = wrapBuiltinToolDefinition(tool, {
            agentDir,
            sessionId: `${name}-${rootMode}-hidden`,
            hooks: createHookBus(),
            getOrigin: () => guestTree,
            permissions: createPermissionService(),
          })
          try {
            const result = await wrapped.execute(
              'c',
              rootMode === 'omitted' ? {} : { path: '.' },
              undefined,
              undefined,
              {} as never,
            )
            expect(textOfFirstContent(result)).toBe('visible.txt')
            expect(result.details).toEqual({ path: '.' })
          } finally {
            await rm(agentDir, { recursive: true, force: true })
          }
        }
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'grep, find, and ls agent-root snapshots skip repository and dependency internals before traversal',
    async () => {
      for (const rootMode of ['omitted', 'explicit'] as const) {
        for (const name of ['grep', 'find', 'ls']) {
          const agentDir = await mkdtemp(path.join(tmpdir(), `typeclaw-${name}-${rootMode}-root-internals-`))
          const outside = path.join(tmpdir(), `typeclaw-${name}-${rootMode}-outside-${Date.now()}.txt`)
          await mkdir(path.join(agentDir, 'visible', 'nested'), { recursive: true })
          await writeFile(path.join(agentDir, 'visible', 'nested', 'result.txt'), 'visible')
          await writeFile(outside, 'outside')
          for (const internal of ['.git', '.gitstore', 'node_modules']) {
            const internalDir = path.join(agentDir, internal, 'deep')
            await mkdir(internalDir, { recursive: true })
            await symlink(outside, path.join(internalDir, 'must-not-open'))
            const oversized = path.join(internalDir, 'must-not-copy.bin')
            await writeFile(oversized, '')
            await truncate(oversized, 65 * 1024 * 1024)
          }
          const tool = definePiTool({
            name,
            label: name,
            description: '',
            parameters: Type.Any(),
            async execute(_id, params) {
              const entries = await readdir(params.path as string)
              const nested = await readFile(path.join(params.path as string, 'visible', 'nested', 'result.txt'), 'utf8')
              return {
                content: [{ type: 'text' as const, text: `${entries.sort().join('\n')}\n${nested}` }],
                details: { path: params.path },
              }
            },
          })
          const wrapped = wrapBuiltinToolDefinition(tool, {
            agentDir,
            sessionId: `${name}-${rootMode}-root-internals`,
            hooks: createHookBus(),
          })
          try {
            const result = await wrapped.execute(
              'c',
              rootMode === 'omitted' ? {} : { path: '.' },
              undefined,
              undefined,
              {} as never,
            )
            expect(textOfFirstContent(result)).toBe('visible\nvisible')
            expect(result.details).toEqual({ path: '.' })
          } finally {
            await rm(agentDir, { recursive: true, force: true })
            await rm(outside, { force: true })
          }
        }
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'builtin search reports omitted workspace links while finding regular source files',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-workspace-links-'))
      const app = path.join(agentDir, 'packages', 'app')
      const shared = path.join(agentDir, 'packages', 'shared')
      await mkdir(path.join(app, 'node_modules'), { recursive: true })
      await mkdir(path.join(app, 'browser-profile'))
      await mkdir(path.join(app, 'venv', 'bin'), { recursive: true })
      await mkdir(shared)
      await writeFile(path.join(app, 'index.ts'), 'visible needle')
      await writeFile(path.join(shared, 'index.ts'), 'shared needle')
      await writeFile(path.join(agentDir, '.env'), 'private needle')
      await mkdir(path.join(agentDir, 'memory'))
      await writeFile(path.join(agentDir, 'memory', 'notes.txt'), 'role private needle')
      await symlink(shared, path.join(app, 'node_modules', 'shared'))
      await symlink(shared, path.join(app, 'dir-link'))
      await symlink(path.join(app, 'missing'), path.join(app, 'dangling'))
      await symlink('/tmp/browser-socket', path.join(app, 'browser-profile', 'SingletonSocket'))
      await symlink('/usr/bin/python3', path.join(app, 'venv', 'bin', 'python'))
      await symlink(path.join(agentDir, '.env'), path.join(app, 'private-link'))
      await symlink(path.join(agentDir, 'memory', 'notes.txt'), path.join(app, 'role-private-link'))
      try {
        const guest: SessionOrigin = {
          kind: 'subagent',
          subagent: 'workspace-search',
          parentSessionId: 'parent',
          spawnedByRole: 'guest',
        }
        const tools = buildBuiltinPiToolOverrides({
          agentDir,
          sessionId: 'workspace-links',
          hooks: createHookBus(),
          getOrigin: () => guest,
          permissions: createPermissionService(),
        })
        for (const name of ['grep', 'find', 'ls']) {
          const tool = tools.find((candidate) => candidate.name === name)
          if (tool === undefined) throw new Error(`missing ${name} builtin`)
          const args =
            name === 'grep'
              ? { path: 'packages', pattern: 'visible needle' }
              : name === 'find'
                ? { path: 'packages', pattern: '**/index.ts' }
                : { path: 'packages' }
          const result = await tool.execute('c', args as never, undefined, undefined, {} as never)
          const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
          expect(text).toContain(name === 'grep' ? 'visible needle' : name === 'find' ? 'app/index.ts' : 'app')
          expect(text).toContain('omitted')
          expect(text).toContain('node_modules/shared')
          expect(text).toContain('venv/bin/python')
          expect(text).toContain('SingletonSocket')
          expect(text).not.toContain('private-link')
          expect(text).not.toContain('private needle')
          expect(text).not.toContain('role-private-link')
          expect(text).not.toContain('role private needle')
        }
        const read = tools.find((candidate) => candidate.name === 'read')
        if (read === undefined) throw new Error('missing read builtin')
        await expect(read.execute('c', { path: '.env' } as never, undefined, undefined, {} as never)).rejects.toThrow()
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'a large set of omitted links reports the total without unbounded names',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-link-report-bound-'))
      const tree = path.join(agentDir, 'packages')
      await mkdir(tree)
      await writeFile(path.join(tree, 'match.ts'), 'needle')
      for (let i = 0; i < 15; i++) await symlink('match.ts', path.join(tree, `link-${String(i).padStart(2, '0')}`))
      try {
        const ls = buildBuiltinPiToolOverrides({
          agentDir,
          sessionId: 'link-report-bound',
          hooks: createHookBus(),
        }).find((tool) => tool.name === 'ls')
        if (ls === undefined) throw new Error('missing ls builtin')
        const result = await ls.execute('c', { path: 'packages' } as never, undefined, undefined, {} as never)
        const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
        expect(text).toContain('match.ts')
        expect(text).toContain('omitted 15 symbolic links')
        expect(text).toContain('and 3 more')
        expect(text.match(/"link-\d{2}"/g)).toHaveLength(12)
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'explicit dependency roots retain nested packages and ordinary .git files',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-explicit-dependency-'))
      const pkg = path.join(agentDir, 'node_modules', 'pkg')
      await mkdir(path.join(pkg, 'node_modules', 'dep'), { recursive: true })
      await writeFile(path.join(pkg, 'node_modules', 'dep', 'index.js'), 'nested package')
      await writeFile(path.join(pkg, '.git'), 'gitdir: ../../metadata')
      try {
        const tools = buildBuiltinPiToolOverrides({
          agentDir,
          sessionId: 'explicit-dependency',
          hooks: createHookBus(),
        })
        for (const name of ['find', 'ls']) {
          const tool = tools.find((candidate) => candidate.name === name)
          if (tool === undefined) throw new Error(`missing ${name} builtin`)
          const args =
            name === 'find'
              ? { path: 'node_modules/pkg', pattern: 'node_modules/**/*.js' }
              : { path: 'node_modules/pkg' }
          const result = await tool.execute('c', args as never, undefined, undefined, {} as never)
          const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
          expect(text).toContain(name === 'find' ? 'node_modules/dep/index.js' : 'node_modules')
          if (name === 'ls') expect(text).toContain('.git')
        }
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'a workspace search never follows a nested link into a private file',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-workspace-private-link-'))
      const app = path.join(agentDir, 'packages', 'app')
      await mkdir(app, { recursive: true })
      await writeFile(path.join(agentDir, '.env'), 'private credential')
      await writeFile(path.join(app, 'index.ts'), 'needle')
      await symlink(path.join(agentDir, '.env'), path.join(app, 'credential'))
      const args: Record<string, unknown> = { path: path.join(agentDir, 'packages') }
      let pinned: PinnedToolFiles | undefined
      try {
        pinned = await enforceAndPinToolFiles({ tool: 'grep', args, agentDir })
        expect(await readdir(path.join(args.path as string, 'app'))).toEqual(['index.ts'])
        expect(await readFile(path.join(args.path as string, 'app', 'index.ts'), 'utf8')).toBe('needle')
      } finally {
        await pinned?.cleanup()
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'an explicitly targeted package subdirectory remains readable through a normal tree snapshot',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-explicit-package-tree-'))
      const packageDir = path.join(agentDir, 'node_modules', 'safe-package', 'nested')
      await mkdir(packageDir, { recursive: true })
      await writeFile(path.join(packageDir, 'index.js'), 'safe-package')
      const tool = definePiTool({
        name: 'ls',
        label: 'ls',
        description: '',
        parameters: Type.Any(),
        async execute(_id, params) {
          return {
            content: [
              {
                type: 'text' as const,
                text: await readFile(path.join(params.path as string, 'nested', 'index.js'), 'utf8'),
              },
            ],
            details: undefined,
          }
        },
      })
      const wrapped = wrapBuiltinToolDefinition(tool, {
        agentDir,
        sessionId: 'explicit-package-tree',
        hooks: createHookBus(),
      })
      try {
        const result = await wrapped.execute(
          'c',
          { path: 'node_modules/safe-package' },
          undefined,
          undefined,
          {} as never,
        )
        expect(textOfFirstContent(result)).toBe('safe-package')
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('grep, find, and ls normalize omitted roots before production security hooks run', async () => {
    for (const name of ['grep', 'find', 'ls']) {
      const seenPaths: unknown[] = []
      const hooks = createHookBus()
      hooks.registerAll('security', '/agent', noopLogger, {
        'tool.before': (event) => {
          seenPaths.push(event.args.path)
          return { block: true, reason: 'default root inspected' }
        },
      })
      const tool = definePiTool({
        name,
        label: name,
        description: '',
        parameters: Type.Any(),
        async execute() {
          return { content: [], details: undefined }
        },
      })
      const wrapped = wrapBuiltinToolDefinition(tool, {
        agentDir: '/agent',
        sessionId: `${name}-default-hook`,
        hooks,
      })
      await expect(wrapped.execute('c', {}, undefined, undefined, {} as never)).rejects.toThrow(
        'blocked: default root inspected',
      )
      expect(seenPaths).toEqual(['.'])
    }
  })

  test.skipIf(process.platform !== 'linux')(
    'grep, find, and ls omitted roots execute against immutable snapshots across symlink swaps',
    async () => {
      for (const name of ['grep', 'find', 'ls']) {
        const agentDir = await mkdtemp(path.join(tmpdir(), `typeclaw-${name}-omitted-swap-`))
        const visible = path.join(agentDir, 'result.txt')
        const secret = path.join(tmpdir(), `typeclaw-${name}-secret-${Date.now()}.txt`)
        await writeFile(visible, 'safe')
        await writeFile(secret, 'secret')
        let startedResolve: () => void = () => {}
        const started = new Promise<void>((resolve) => (startedResolve = resolve))
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => (release = resolve))
        const tool = definePiTool({
          name,
          label: name,
          description: '',
          parameters: Type.Any(),
          async execute(_id, params) {
            startedResolve()
            await gate
            return {
              content: [
                { type: 'text' as const, text: await readFile(path.join(params.path as string, 'result.txt'), 'utf8') },
              ],
              details: { path: params.path },
            }
          },
        })
        const wrapped = wrapBuiltinToolDefinition(tool, {
          agentDir,
          sessionId: `${name}-omitted-swap`,
          hooks: createHookBus(),
        })
        try {
          const resultPromise = wrapped.execute('c', {}, undefined, undefined, {} as never)
          await started
          await rm(visible)
          await symlink(secret, visible)
          release()
          const result = await resultPromise
          expect(textOfFirstContent(result)).toBe('safe')
          expect(result.details).toEqual({ path: '.' })
        } finally {
          release()
          await rm(agentDir, { recursive: true, force: true })
          await rm(secret, { force: true })
        }
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'anchors a write to its opened inode across a secret symlink swap',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-output-swap-'))
      const destination = path.join(agentDir, 'workspace', 'output.txt')
      const secret = path.join(agentDir, '.env')
      await mkdir(path.dirname(destination))
      await writeFile(destination, 'old')
      await writeFile(secret, 'SECRET=untouched')
      const args: Record<string, unknown> = { path: destination, content: 'safe output' }
      const pinned = await enforceAndPinToolFiles({ tool: 'write', args, agentDir })
      try {
        await rm(destination)
        await symlink(secret, destination)
        await writeFile(args.path as string, 'safe output')
        expect(await readFile(secret, 'utf8')).toBe('SECRET=untouched')
        expect(await readFile(args.path as string, 'utf8')).toBe('safe output')
        await expect(pinned.cleanup()).rejects.toThrow(/changed|symbolic|ELOOP/i)
      } finally {
        await pinned.cleanup()
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'plugin tools snapshot declared inputs and anchor declared outputs in the same call',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-plugin-mixed-files-'))
      const workspace = path.join(agentDir, 'workspace')
      const source = path.join(agentDir, 'source.txt')
      const secret = path.join(agentDir, '.env')
      const destination = path.join(workspace, 'result.txt')
      await mkdir(workspace)
      await writeFile(source, 'safe input')
      await writeFile(secret, 'SECRET=never')
      const tool = defineTool({
        description: '',
        parameters: z.object({ source: z.string(), destination: z.string() }),
        fileOperands: { input: ['source'], output: ['destination'] },
        async execute(args) {
          await rm(source)
          await symlink(secret, source)
          const content = await readFile(args.source, 'utf8')
          await writeFile(args.destination, content)
          return { content: [{ type: 'text' as const, text: `${args.source}\n${args.destination}` }] }
        },
      })
      const wrapped = wrapPluginTool(tool, {
        pluginName: 'mixed-files',
        toolName: 'transform',
        agentDir,
        sessionId: 'plugin-mixed-files',
        logger: noopLogger,
        hooks: createHookBus(),
      })

      try {
        const result = await wrapped.execute('call', { source, destination }, undefined, undefined, {} as never)
        expect(await readFile(destination, 'utf8')).toBe('safe input')
        expect(await readFile(secret, 'utf8')).toBe('SECRET=never')
        expect(textOfFirstContent(result)).toBe(`${source}\n${destination}`)
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'mixed operand setup removes the input snapshot and earlier output anchors when a later output fails',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mixed-file-failure-'))
      const snapshotRoot = path.join(agentDir, 'snapshots')
      const workspace = path.join(agentDir, 'workspace')
      const source = path.join(agentDir, 'source.txt')
      const destination = path.join(workspace, 'result.txt')
      const missingDestination = path.join(agentDir, 'missing', 'result.txt')
      await mkdir(snapshotRoot)
      await mkdir(workspace)
      await writeFile(source, 'safe input')

      try {
        await expect(
          enforceAndPinToolFiles({
            tool: '__plugin_mixed_transform',
            args: { source, destination, missingDestination },
            agentDir,
            tempRoot: snapshotRoot,
            genericInputs: true,
            fileOperands: {
              input: ['source'],
              output: ['destination', 'missingDestination'],
            },
          }),
        ).rejects.toThrow(/parent directory does not exist/i)
        expect(await readdir(snapshotRoot)).toEqual([])
        expect(await Bun.file(destination).exists()).toBeFalse()
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'a reserved missing output cannot be redirected through a replacement symlink',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-new-output-race-'))
      const workspace = path.join(agentDir, 'workspace')
      const destination = path.join(workspace, 'output.txt')
      const secret = path.join(agentDir, '.env')
      await mkdir(workspace)
      await writeFile(secret, 'SECRET=untouched')
      const args: Record<string, unknown> = { path: destination, content: 'safe output' }
      const pinned = await enforceAndPinToolFiles({ tool: 'write', args, agentDir })
      const executionPath = args.path as string
      try {
        expect(await Bun.file(destination).exists()).toBeTrue()
        expect(executionPath).toMatch(/^\/proc\/self\/fd\/\d+$/)
        await rm(destination)
        await symlink(secret, destination)
        await writeToolOutputNoFollow(executionPath, 'safe output')
        expect(await readFile(executionPath, 'utf8')).toBe('safe output')
        expect(await readFile(secret, 'utf8')).toBe('SECRET=untouched')
        await expect(pinned.cleanup()).rejects.toThrow(/single-link|changed|symbolic|ELOOP/i)
        expect(await Bun.file(executionPath).exists()).toBeFalse()
      } finally {
        await pinned.cleanup()
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )
})

describe('wrapBuiltinToolDefinition (hook + guard pipeline)', () => {
  test('hookless builtin read cannot open a canonical credential', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-hookless-builtin-'))
    await writeFile(path.join(agentDir, '.env'), 'SECRET=never')
    let called = false
    const tool = {
      name: 'grep',
      label: 'grep',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        called = true
        return { content: [], details: undefined }
      },
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 's',
      hooks: createHookBus(),
    })
    try {
      await expect(wrapped.execute('c', { path: '.env' }, undefined, undefined, {} as never)).rejects.toThrow(
        /not available to LLM tools/,
      )
      expect(called).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('tool.before and tool.after fire for built-in pi tool definitions and can rewrite the result', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-hooked-grep-'))
    const original = path.join(agentDir, 'original')
    const mutated = path.join(agentDir, 'mutated')
    await writeFile(original, 'original')
    await writeFile(mutated, 'mutated')
    const seen: unknown[] = []
    const observed: unknown[] = []
    const tool = {
      name: 'grep',
      label: 'grep',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute(_callId: string, params: { path: string }) {
        seen.push(params)
        return { content: [{ type: 'text' as const, text: params.path }], details: { path: params.path } }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': (event) => {
        event.args.path = mutated
      },
      'tool.after': (event) => {
        observed.push(event.result.details)
        event.result.content = [{ type: 'text', text: 'rewritten read' }]
        event.result.details = { rewritten: true }
      },
    })

    const wrapped = wrapBuiltinToolDefinition(tool, { agentDir, sessionId: 's', hooks })

    try {
      const result = await wrapped.execute('c', { path: original }, undefined, undefined, {} as never)
      expect(textOfFirstContent(result)).toBe('rewritten read')
      expect(result.details as Record<string, unknown>).toEqual({ rewritten: true })
      expect((seen[0] as { path: string }).path).not.toBe(mutated)
      expect(observed[0]).toEqual({ path: mutated })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('first-party builtin write accepts long prose through both canonical guard passes', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-builtin-write-prose-'))
    const workspace = path.join(agentDir, 'workspace')
    const target = path.join(workspace, 'report.md')
    const content = 'x'.repeat(300)
    const provenances: unknown[] = []
    const tool = {
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_callId: string, params: { path: string; content: string }) {
        await writeFile(params.path, params.content)
        return { content: [{ type: 'text' as const, text: 'written' }], details: undefined }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('security', agentDir, noopLogger, {
      'tool.before': (event) => {
        provenances.push(event.toolProvenance)
        return checkPrivateSurfaceReadGuard({
          tool: event.tool,
          args: event.args,
          agentDir,
          hidden: { dirs: [], files: [] },
          toolProvenance: event.toolProvenance,
        })
      },
    })
    const wrapped = wrapBuiltinToolDefinition(tool, { agentDir, sessionId: 's', hooks })

    try {
      await mkdir(workspace)
      if (lacksInodeAnchoring) {
        await expect(
          wrapped.execute('c', { path: target, content }, undefined, undefined, {} as never),
        ).rejects.toThrow(/inode anchoring/)
        expect(provenances).toEqual(['first-party'])
        return
      }
      await wrapped.execute('c', { path: target, content }, undefined, undefined, {} as never)
      expect(provenances).toEqual(['first-party'])
      expect(await readFile(target, 'utf8')).toBe(content)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('tool.before { block: true } rejects built-in pi-style agent tool execution through the engine error path', async () => {
    const calls: number[] = []
    const tool = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_callId: string, _params: { command: string }) {
        calls.push(1)
        return { content: [], details: undefined }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no bash' }),
    })

    const wrapped = wrapBuiltinToolDefinition(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(wrapped.execute('c', { command: 'pwd' }, undefined, undefined, {} as never)).rejects.toThrow(
      'blocked: no bash',
    )
    expect(calls).toEqual([])
  })

  // pi's bash tool REJECTS on non-zero exit. Without a finally-style after-run,
  // a tool.after hook that releases a reservation (the github approve guard)
  // never fires, stranding the PR as "already approved" on retry (PR #672).
  test('tool.after fires with an error result when a built-in file tool throws, then rethrows', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-throwing-grep-'))
    const input = path.join(agentDir, 'input.txt')
    await writeFile(input, 'input')
    const afterResults: unknown[] = []
    const tool = {
      name: 'grep',
      label: 'grep',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute(_callId: string, _params: { path: string }) {
        throw new Error('no such file or directory')
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.after': (event) => {
        afterResults.push(event.result)
      },
    })

    const wrapped = wrapBuiltinToolDefinition(tool, { agentDir, sessionId: 's', hooks })

    try {
      await expect(wrapped.execute('c', { path: input } as never, undefined, undefined, {} as never)).rejects.toThrow(
        'no such file or directory',
      )
      expect(afterResults).toHaveLength(1)
      const errorText = ((afterResults[0] as ToolResult).content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      expect(errorText).toContain('no such file or directory')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('missing-path builtin file tool: rethrown error and tool.after both carry the recovery hint', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-missing-path-'))
    const missing = path.join(agentDir, 'does-not-exist.txt')
    const afterResults: unknown[] = []
    let executed = false
    const tool = {
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        executed = true
        return { content: [{ type: 'text' as const, text: 'unreachable' }], details: {} }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.after': (event) => {
        afterResults.push(event.result)
      },
    })

    const wrapped = wrapBuiltinToolDefinition(tool, { agentDir, sessionId: 's', hooks })

    try {
      // enforceAndPinToolFiles throws the authorization error BEFORE execute
      const thrown = await wrapped
        .execute('c', { path: missing } as never, undefined, undefined, {} as never)
        .then(() => undefined)
        .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))

      expect(executed).toBe(false)
      expect(thrown?.message).toContain('tool input did not exist while being authorized')
      expect(thrown?.message).toContain('the path does not exist')

      expect(afterResults).toHaveLength(1)
      const afterText = ((afterResults[0] as ToolResult).content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      expect(afterText).toContain('tool input did not exist while being authorized')
      expect(afterText).toContain('the path does not exist')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(lacksInodeAnchoring)(
    'edit built-in agent tool exposes and strips guard acknowledgements before execution',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-builtin-edit-ack-'))
      const notes = path.join(agentDir, 'notes.md')
      await writeFile(notes, 'x')
      const seen: unknown[] = []
      const tool = {
        name: 'edit',
        label: 'edit',
        description: '',
        parameters: Type.Object(
          {
            path: Type.String(),
            edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
          },
          { additionalProperties: false },
        ),
        async execute(
          _callId: string,
          params: {
            path: string
            edits: { oldText: string; newText: string }[]
            acknowledgeGuards?: { guard?: { nonWorkspaceWrite?: boolean } }
          },
        ) {
          seen.push({ ...params, path: 'notes.md' })
          const content = await readFile(params.path, 'utf8')
          await writeFile(params.path, content.replace('x', 'y'))
          return { content: [{ type: 'text' as const, text: 'edited' }], details: params }
        },
      }
      const hooks = createHookBus()
      hooks.registerAll('p1', agentDir, noopLogger, {
        'tool.before': (event) => {
          expect(event.args).not.toHaveProperty('acknowledgeGuards')
        },
      })
      const guards = await registerGuardPlugin(hooks, agentDir)

      const wrapped = wrapBuiltinToolDefinition(tool, {
        agentDir,
        sessionId: 's',
        hooks,
        guards,
      })

      const parameters = wrapped.parameters as { properties?: Record<string, unknown> }
      expect(parameters.properties).toHaveProperty('acknowledgeGuards')
      const params = {
        path: 'notes.md',
        edits: [{ oldText: 'x', newText: 'y' }],
        acknowledgeGuards: { guard: { nonWorkspaceWrite: true } },
      } as unknown as Parameters<typeof wrapped.execute>[1]
      try {
        const result = await wrapped.execute('c', params, undefined, undefined, {} as never)

        expect(seen[0]).toEqual({ path: 'notes.md', edits: [{ oldText: 'x', newText: 'y' }] })
        expect(result.details).toEqual({ path: 'notes.md', edits: [{ oldText: 'x', newText: 'y' }] })
        expect(await readFile(notes, 'utf8')).toBe('y')
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )
})

describe('getOrigin (live origin holder)', () => {
  test('wrapPluginTool: tool.before sees the current value of getOrigin() at execute time, not at wrap time', async () => {
    // Regression for: channel sessions need per-turn lastInboundAuthorId on
    // tool.before so permission gating can resolve author: rules against the
    // current actor, not the cold-start origin captured at session creation.
    const seenOrigins: (unknown | undefined)[] = []
    const hooks = createHookBus()
    hooks.registerAll('p', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenOrigins.push(event.origin)
        return undefined
      },
    })
    const ref: { current: unknown } = { current: { kind: 'tui', sessionId: 's-A' } }
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p',
      toolName: 't',
      agentDir: '/agent',
      sessionId: 'sess',
      logger: noopLogger,
      hooks,
      getOrigin: () => ref.current as never,
    })

    await wrapped.execute('c1', {}, undefined, undefined, {} as never)
    ref.current = { kind: 'tui', sessionId: 's-B' }
    await wrapped.execute('c2', {}, undefined, undefined, {} as never)

    expect(seenOrigins).toEqual([
      { kind: 'tui', sessionId: 's-A' },
      { kind: 'tui', sessionId: 's-B' },
    ])
  })

  test('wrapSystemTool: same dynamic-origin contract', async () => {
    const seenOrigins: (unknown | undefined)[] = []
    const hooks = createHookBus()
    hooks.registerAll('p', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenOrigins.push(event.origin)
        return undefined
      },
    })
    const ref: { current: unknown } = { current: { kind: 'cron', jobId: 'j1', jobKind: 'prompt' } }
    const tool = definePiTool({
      name: 'sys',
      label: 'sys',
      description: '',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, {
      agentDir: '/agent',
      sessionId: 'sess',
      hooks,
      getOrigin: () => ref.current as never,
    })

    await wrapped.execute('c1', {}, undefined, undefined, {} as never)
    ref.current = { kind: 'cron', jobId: 'j2', jobKind: 'prompt' }
    await wrapped.execute('c2', {}, undefined, undefined, {} as never)

    expect((seenOrigins[0] as { jobId: string }).jobId).toBe('j1')
    expect((seenOrigins[1] as { jobId: string }).jobId).toBe('j2')
  })
})

describe('resolveBuiltinToolRefs', () => {
  test('resolves every ref to a ToolDefinition, preserving order', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const resolved = resolveBuiltinToolRefs(
      [
        { __builtinTool: 'read' },
        { __builtinTool: 'bash' },
        { __builtinTool: 'edit' },
        { __builtinTool: 'write' },
        { __builtinTool: 'grep' },
        { __builtinTool: 'find' },
        { __builtinTool: 'ls' },
        { __builtinTool: 'web_search' },
        { __builtinTool: 'web_fetch' },
      ],
      process.cwd(),
    )
    expect(resolved.map((t) => t.name)).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'web_search',
      'web_fetch',
    ])
  })

  test('pi coding builtins resolve to ToolDefinitions carrying the builtin name', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    for (const name of ['read', 'edit', 'write', 'grep', 'find', 'ls'] as const) {
      const r = resolveBuiltinToolRefs([{ __builtinTool: name }], process.cwd())
      expect(r.length).toBe(1)
      expect(r[0]?.name).toBe(name)
    }
  })

  test('bash resolves to the spawnHook-wired ToolDefinition, not pi bare createBashToolDefinition', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const pi = await import('@earendil-works/pi-coding-agent')
    const r = resolveBuiltinToolRefs([{ __builtinTool: 'bash' }], process.cwd())
    expect(r.length).toBe(1)
    expect(r[0]?.name).toBe('bash')
    // It is our own instance carrying the env-overlay spawnHook, not a fresh
    // pi definition — reference inequality is the observable proof.
    expect(r[0]).not.toBe(pi.createBashToolDefinition(process.cwd()) as never)
  })

  test('typeclaw web tools resolve to the original ToolDefinition imports by reference equality', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const { webSearchTool } = await import('./tools/websearch')
    const { webFetchTool } = await import('./tools/webfetch')
    expect(resolveBuiltinToolRefs([{ __builtinTool: 'web_search' }], process.cwd())[0]).toBe(webSearchTool)
    expect(resolveBuiltinToolRefs([{ __builtinTool: 'web_fetch' }], process.cwd())[0]).toBe(webFetchTool)
  })

  test('mixed refs resolve in order: web-only (scout-shape)', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const r = resolveBuiltinToolRefs([{ __builtinTool: 'web_search' }, { __builtinTool: 'web_fetch' }], process.cwd())
    expect(r.map((t) => t.name)).toEqual(['web_search', 'web_fetch'])
  })

  test('mixed refs resolve in order: coding-only (explorer-shape)', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const r = resolveBuiltinToolRefs(
      [
        { __builtinTool: 'read' },
        { __builtinTool: 'grep' },
        { __builtinTool: 'find' },
        { __builtinTool: 'ls' },
        { __builtinTool: 'bash' },
      ],
      process.cwd(),
    )
    expect(r.map((t) => t.name)).toEqual(['read', 'grep', 'find', 'ls', 'bash'])
  })

  test('throws on unknown built-in names', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    expect(() => resolveBuiltinToolRefs([{ __builtinTool: 'nope' }], process.cwd())).toThrow(
      /unknown built-in tool ref/,
    )
  })
})

describe('wrapBuiltinToolDefinition (pi customTools override path)', () => {
  test.skipIf(lacksInodeAnchoring)(
    'the returned ToolDefinition runs tool.before/runFinalWriteGuards before delegating to the underlying pi AgentTool',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-custom-edit-pipeline-'))
      const workspace = path.join(agentDir, 'workspace')
      const notes = path.join(workspace, 'notes.md')
      await mkdir(workspace)
      await writeFile(notes, 'a')
      let executedUnderlying = 0
      const beforeArgs: unknown[] = []
      const tool = {
        name: 'edit',
        label: 'edit',
        description: '',
        parameters: Type.Object({
          path: Type.String(),
          edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
        }),
        async execute(_id: string, params: { path: string }) {
          executedUnderlying++
          expect(await readFile(params.path, 'utf8')).toBe('a')
          return { content: [{ type: 'text' as const, text: 'underlying ran' }], details: undefined }
        },
      }
      const hooks = createHookBus()
      hooks.registerAll('p1', agentDir, noopLogger, {
        'tool.before': (event) => {
          beforeArgs.push({ ...event.args })
        },
      })

      const wrapped = wrapBuiltinToolDefinition(tool, { agentDir, sessionId: 's', hooks })

      try {
        expect(wrapped.name).toBe('edit')
        const result = await wrapped.execute(
          'c',
          { path: 'workspace/notes.md', edits: [{ oldText: 'a', newText: 'b' }] },
          undefined,
          undefined,
          {} as never,
        )
        expect(textOfFirstContent(result)).toBe('underlying ran')
        expect(executedUnderlying).toBe(1)
        expect(beforeArgs).toEqual([{ path: 'workspace/notes.md', edits: [{ oldText: 'a', newText: 'b' }] }])
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('regression: managedConfig guard blocks an edit that would produce invalid typeclaw.json, on the customTool override path', async () => {
    // PR #283's failure mode: pi 0.67.3 ignores `tools:` for implementation
    // overrides, so the channel-session `edit` tool that landed in a host
    // agent folder ran pi's internal builtin and bypassed
    // both `tool.before` and `runFinalWriteGuards`. The fix routes wrapped
    // builtin pi tools through `customTools`, which IS the override path
    // pi honors. This test pins the post-fix behavior end-to-end: a tool
    // call that mutates typeclaw.json to an invalid shape MUST be blocked
    // by `runFinalWriteGuards` (which calls `checkManagedConfigGuard`),
    // before the underlying pi `edit` is invoked.
    const dir = await mkdtemp(path.join(tmpdir(), 'typeclaw-managed-config-'))
    const configPath = path.join(dir, 'typeclaw.json')
    const validConfig = {
      models: { default: 'anthropic/claude-haiku-4-5' },
    }
    await Bun.write(configPath, `${JSON.stringify(validConfig, null, 2)}\n`)

    let executedUnderlying = 0
    const tool = {
      name: 'edit',
      label: 'edit',
      description: '',
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
      }),
      async execute(_id: string, _params: unknown) {
        executedUnderlying++
        return { content: [{ type: 'text' as const, text: 'should not run' }], details: undefined }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', dir, noopLogger, {})
    const guards = await registerGuardPlugin(hooks, dir)

    const wrapped = wrapBuiltinToolDefinition(tool, { agentDir: dir, sessionId: 's', hooks, guards })

    await expect(
      wrapped.execute(
        'c',
        {
          path: configPath,
          edits: [{ oldText: 'anthropic/claude-haiku-4-5', newText: 'kimi' }],
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/Guard `managedConfig` blocked edit/)
    expect(executedUnderlying).toBe(0)
  })

  test('defaultBuiltinPiToolDefinitions returns the seven pi coding-tool definitions that need hook coverage', async () => {
    const tools = defaultBuiltinPiToolDefinitions(process.cwd())
    expect(tools.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
  })

  test('builtin file tools resolve relative paths against the cwd they were built with, not process.cwd()', async () => {
    // Regression: pi builtins bake in the cwd at factory time. Building them from
    // the session's agentDir (not the module-load process.cwd()) is what keeps a
    // read/write/edit of a relative path landing in the session's own tree.
    const dir = await mkdtemp(path.join(tmpdir(), 'typeclaw-cwd-bind-'))
    try {
      await Bun.write(path.join(dir, 'marker.txt'), 'in-agent-dir')
      const [read] = defaultBuiltinPiToolDefinitions(dir)
      const result = await read!.execute('c', { path: 'marker.txt' } as never, undefined, undefined, {} as never)
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      expect(text).toContain('in-agent-dir')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'linux')(
    'actual model bash spawn inherits tool OOM priority through its shell and grandchild',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'typeclaw-oom-bash-'))
      try {
        const bash = defaultBuiltinPiToolDefinitions(dir).find((tool) => tool.name === 'bash')!
        const result = await bash.execute(
          'oom-priority',
          { command: 'cat /proc/self/oom_score_adj; sh -c "cat /proc/self/oom_score_adj"' },
          undefined,
          undefined,
          {} as never,
        )
        expect(textOfFirstContent(result)?.trim().split('\n')).toEqual(['600', '600'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  test('buildBuiltinPiToolOverrides produces same-named ToolDefinitions ready for customTools', async () => {
    const hooks = createHookBus()
    const overrides = buildBuiltinPiToolOverrides({ agentDir: '/agent', sessionId: 's', hooks })
    expect(overrides.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
  })

  test('publishes the exact plugin-nested acknowledgement schema owned by each tool', async () => {
    const guards = bundledAcknowledgementGuards('/agent')
    const overrides = buildBuiltinPiToolOverrides({
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      guards,
    })
    const schemas = Object.fromEntries(
      overrides.map((tool) => {
        const params = tool.parameters as { properties?: Record<string, unknown> }
        const envelope = params.properties?.acknowledgeGuards as
          | { properties?: Record<string, unknown>; additionalProperties?: boolean }
          | undefined
        return [
          tool.name,
          envelope === undefined
            ? undefined
            : {
                plugins: Object.fromEntries(
                  Object.entries(envelope.properties ?? {}).map(([plugin, value]) => [
                    plugin,
                    Object.keys((value as { properties?: Record<string, unknown> }).properties ?? {}),
                  ]),
                ),
                additionalProperties: envelope.additionalProperties,
              },
        ]
      }),
    )
    expect(schemas).toEqual({
      read: { plugins: { guard: ['imageReadRedirect'] }, additionalProperties: false },
      bash: {
        plugins: { 'bun-hygiene': ['globalInstall', 'nonBunPackageManager', 'nonBunPackageRunner'] },
        additionalProperties: false,
      },
      edit: { plugins: { guard: ['nonWorkspaceWrite'] }, additionalProperties: false },
      write: { plugins: { guard: ['nonWorkspaceWrite'] }, additionalProperties: false },
      grep: undefined,
      find: undefined,
      ls: undefined,
    })
  })
})

describe('wrapBuiltinToolDefinition bash sandbox (role-derived path hiding)', () => {
  function fakeBash(record: { command?: string }) {
    return {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_id: string, params: { command: string }) {
        record.command = params.command
        return { content: [{ type: 'text' as const, text: 'ran' }], details: undefined }
      },
    }
  }

  async function runFixtureGit(agentDir: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawn(['git', ...hooklessGitArgs(['-C', agentDir, ...args])], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = await new Response(proc.stderr).text()
    if ((await proc.exited) !== 0) throw new Error(`git fixture failed: ${stderr}`)
  }

  const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }
  const member: SessionOrigin = { kind: 'subagent', subagent: 'x', parentSessionId: 'p', spawnedByRole: 'member' }
  const guest: SessionOrigin = { kind: 'subagent', subagent: 'x', parentSessionId: 'p', spawnedByRole: 'guest' }

  test('annotates only nonzero exits with the local sandbox policy', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-policy-provenance-'))
    const plantedSecret = 'planted-secret-value'
    const permissions = createPermissionService()
    await writeFile(path.join(agentDir, '.env'), `NODE_OPTIONS=${plantedSecret}\nVISIBLE_NAME=visible-value\n`)
    const boundary = {
      ensureAvailable: async () => {},
      resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
      resolveRuntime: async () => ({ env: {}, mounts: [] }),
      buildCommand(command: string, options: SandboxPolicy | undefined) {
        return { ...buildSandboxedCommand(command, options), commandString: command }
      },
    }
    const makeTool = (exitCode: number) => ({
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        return {
          content: [{ type: 'text' as const, text: exitCode === 0 ? 'unchanged success' : 'ordinary failure' }],
          details: { exitCode },
        }
      },
    })

    try {
      const failing = wrapBuiltinToolDefinition(makeTool(9), {
        agentDir,
        sessionId: 'policy-provenance-failure',
        hooks: createHookBus(),
        getOrigin: () => guest,
        permissions,
        bashSandboxBoundary: boundary,
      })
      const failure = await failing.execute('failure', { command: 'false' }, undefined, undefined, {} as never)
      const hidden = resolveHiddenPaths(permissions, guest, agentDir)
      const maskedPaths = [...hidden.dirs, ...hidden.files].map(
        (target) => `agent/${path.relative(agentDir, target).split(path.sep).join('/')}`,
      )
      const expectedNote =
        `[TypeClaw sandbox policy (LOCAL): masked credential/private paths: ${maskedPaths.join(', ')}; ` +
        'withheld env names: NODE_OPTIONS. This may be unrelated to this failure; it is NOT evidence about ' +
        'authentication of any account, workspace, or upstream service and must not be reported as such.]'
      expect(failure.content).toEqual([
        { type: 'text', text: 'ordinary failure' },
        { type: 'text', text: expectedNote },
      ])
      expect(JSON.stringify(failure)).not.toContain(plantedSecret)

      const succeeding = wrapBuiltinToolDefinition(makeTool(0), {
        agentDir,
        sessionId: 'policy-provenance-success',
        hooks: createHookBus(),
        getOrigin: () => guest,
        permissions,
        bashSandboxBoundary: boundary,
      })
      expect(await succeeding.execute('success', { command: 'true' }, undefined, undefined, {} as never)).toEqual({
        content: [{ type: 'text', text: 'unchanged success' }],
        details: { exitCode: 0 },
      })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('annotates a sandboxed builtin execution error', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-policy-error-provenance-'))
    const plantedSecret = 'planted-secret-value'
    const permissions = createPermissionService()
    await writeFile(path.join(agentDir, '.env'), `NODE_OPTIONS=${plantedSecret}\n`)
    const builtin = defaultBuiltinPiToolDefinitions(agentDir).find((tool) => tool.name === 'bash')
    if (builtin === undefined) throw new Error('bash tool definition not found')
    const wrapped = wrapBuiltinToolDefinition(builtin, {
      agentDir,
      sessionId: 'policy-error-provenance',
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        buildCommand(command, options) {
          return { ...buildSandboxedCommand(command, options), commandString: command }
        },
      },
    })

    try {
      const hidden = resolveHiddenPaths(permissions, guest, agentDir)
      const maskedPaths = [...hidden.dirs, ...hidden.files].map(
        (target) => `agent/${path.relative(agentDir, target).split(path.sep).join('/')}`,
      )
      const expectedNote =
        `[TypeClaw sandbox policy (LOCAL): masked credential/private paths: ${maskedPaths.join(', ')}; ` +
        'withheld env names: NODE_OPTIONS. This may be unrelated to this failure; it is NOT evidence about ' +
        'authentication of any account, workspace, or upstream service and must not be reported as such.]'
      const thrown = await wrapped
        .execute('failure', { command: 'exit 9' }, undefined, undefined, {} as never)
        .catch((error: unknown) => error)

      if (!(thrown instanceof Error)) throw new Error('expected command failure')
      expect(thrown.message).toEndWith(`\n\n${expectedNote}`)
      expect(thrown.message).not.toContain(plantedSecret)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('the annotation is independent of command identity', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-policy-command-agnostic-'))
    const tool = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        return { content: [{ type: 'text' as const, text: 'failed' }], details: { exitCode: 1 } }
      },
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'policy-command-agnostic',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        buildCommand(command, options) {
          return { ...buildSandboxedCommand(command, options), commandString: command }
        },
      },
    })

    try {
      const firstCommand = 'false'
      const secondCommand = '(exit 7)'
      const first = await wrapped.execute('first', { command: firstCommand }, undefined, undefined, {} as never)
      const second = await wrapped.execute('second', { command: secondCommand }, undefined, undefined, {} as never)
      const firstAnnotation = first.content[1]
      const secondAnnotation = second.content[1]

      expect(firstAnnotation).toEqual(secondAnnotation)
      expect(JSON.stringify(firstAnnotation)).not.toContain(firstCommand)
      expect(JSON.stringify(firstAnnotation)).not.toContain(secondCommand)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('owner bash keeps the agent root writable while canonical secrets stay read-only masked and env stays cleared', () => {
    const permissions = createPermissionService()
    const policy = buildBashFilesystemPolicy({
      agentDir: '/agent',
      canWriteAgentRoot: canWriteAgentRootInSandbox(permissions, tui),
      masks: { dirs: [], files: ['/agent/.env', '/agent/secrets.json'] },
      writable: { dirs: ['/agent/workspace'], files: [] },
      protected: { dirs: ['/agent/.git/hooks'], files: ['/agent/.git/config'] },
    })
    const { argv } = buildSandboxedCommand('printf ok > /agent/ordinary.txt', {
      mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      ...policy,
    })
    const rendered = argv.join(' ')

    expect(rendered).toContain('--ro-bind /agent /agent')
    expect(rendered).toContain('--bind /agent /agent')
    expect(rendered.indexOf('--bind /agent /agent')).toBeLessThan(rendered.indexOf('--ro-bind-data 3 /agent/.env'))
    expect(rendered).toContain('--ro-bind-data 3 /agent/.env')
    expect(rendered).toContain('--ro-bind-data 4 /agent/secrets.json')
    expect(rendered).toContain('--ro-bind /agent/.git/hooks /agent/.git/hooks')
    expect(rendered).toContain('--ro-bind /agent/.git/config /agent/.git/config')
    expect(rendered.indexOf('--bind /agent /agent')).toBeLessThan(rendered.indexOf('--ro-bind /agent/.git/hooks'))
    expect(argv).toContain('--clearenv')
  })

  test('role filesystem policies preserve ordinary trusted root writes without widening confined roles', () => {
    const confinedPolicy = buildBashFilesystemPolicy({
      agentDir: '/agent',
      canWriteAgentRoot: false,
      masks: { dirs: [], files: ['/agent/.env'] },
      writable: { dirs: ['/agent/workspace'], files: ['/agent/package.json'] },
      protected: {
        dirs: ['/agent/.git/hooks', '/agent/workspace/hooks'],
        files: ['/agent/.git/config', '/agent/workspace/git.inc'],
      },
    })
    const confined = buildSandboxedCommand('printf safe > workspace/output.txt', {
      mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      ...confinedPolicy,
    }).argv.join(' ')

    expect(confined).not.toContain('--bind /agent /agent')
    expect(confined).not.toContain('--bind /agent/node_modules /agent/node_modules')
    expect(confined).toContain('--bind /agent/workspace /agent/workspace')

    const ownerPolicy = buildBashFilesystemPolicy({
      agentDir: '/agent',
      canWriteAgentRoot: true,
      masks: { dirs: [], files: ['/agent/.env'] },
      writable: { dirs: [], files: [] },
      protected: { dirs: ['/agent/.git/hooks'], files: ['/agent/.git/config'] },
    })
    const owner = buildSandboxedCommand('printf safe > ordinary.txt', {
      mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      ...ownerPolicy,
    }).argv.join(' ')

    expect(owner).toContain('--bind /agent /agent')
    expect(owner.indexOf('--bind /agent /agent')).toBeLessThan(owner.indexOf('--ro-bind-data 3 /agent/.env'))
  })

  test('the entire root dependency tree renders read-only for trusted and confined role policies', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-protected-dependencies-'))
    await mkdir(path.join(agentDir, 'node_modules'))
    try {
      const protectedZones = await resolveProtectedZones(agentDir)
      const trustedPolicy = buildBashFilesystemPolicy({
        agentDir,
        canWriteAgentRoot: true,
        masks: { dirs: [], files: [] },
        writable: { dirs: [], files: [] },
        protected: protectedZones,
      })
      const confinedPolicy = buildBashFilesystemPolicy({
        agentDir,
        canWriteAgentRoot: false,
        masks: { dirs: [], files: [] },
        writable: { dirs: [path.join(agentDir, 'workspace')], files: [] },
        protected: protectedZones,
      })
      const trusted = buildSandboxedCommand('printf safe > ordinary.txt', trustedPolicy).argv.join(' ')
      const confined = buildSandboxedCommand('printf safe > workspace/output.txt', confinedPolicy).argv.join(' ')
      const protectedNodeModules = `--ro-bind ${path.join(agentDir, 'node_modules')} ${path.join(agentDir, 'node_modules')}`

      expect(trusted).toContain(`--bind ${agentDir} ${agentDir}`)
      expect(trusted).toContain(protectedNodeModules)
      expect(trusted.indexOf(`--bind ${agentDir} ${agentDir}`)).toBeLessThan(trusted.indexOf(protectedNodeModules))
      expect(confined).not.toContain(`--bind ${agentDir} ${agentDir}`)
      expect(confined).toContain(protectedNodeModules)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.each(['write', 'edit'] as const)(
    '%s cannot modify Git hook configuration even with guard acknowledgements',
    async (toolName) => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'tc-git-control-'))
      const calls: unknown[] = []
      const tool = definePiTool({
        name: toolName,
        label: toolName,
        description: '',
        parameters: Type.Object({ path: Type.String() }),
        async execute(_id, params) {
          calls.push(params)
          return { content: [{ type: 'text' as const, text: 'mutated' }], details: undefined }
        },
      })
      const hooks = createHookBus()
      const guards = await registerGuardPlugin(hooks, agentDir)
      const wrapped = wrapBuiltinToolDefinition(tool, {
        agentDir,
        sessionId: `git-control-${toolName}`,
        hooks,
        guards,
      })

      try {
        await expect(
          wrapped.execute(
            'c',
            {
              path: path.join(agentDir, '.git', 'config'),
              acknowledgeGuards: { guard: { nonWorkspaceWrite: true } },
            },
            undefined,
            undefined,
            {} as never,
          ),
        ).rejects.toThrow(/Git control path/)
        expect(calls).toEqual([])
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('owner bash requires canonical secret masks and fails closed without bwrap', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    await expect(
      wrapped.execute('c', { command: 'cat /agent/secrets.json' }, undefined, undefined, {} as never),
    ).rejects.toThrow()
    expect(record.command).toBeUndefined()
  })

  test('owner bash aborts before execution when a canonical target is symlinked', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'tc-unsafe-mask-symlink-'))
    const record: { command?: string } = {}
    try {
      const outside = path.join(agentDir, 'outside')
      await writeFile(outside, 'secret')
      await symlink(outside, path.join(agentDir, '.env'))
      await writeFile(path.join(agentDir, 'secrets.json'), '{}')
      const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
        agentDir,
        sessionId: 's',
        hooks: createHookBus(),
        getOrigin: () => tui,
        permissions: createPermissionService(),
      })
      await expect(
        wrapped.execute('c', { command: 'echo should-not-run' }, undefined, undefined, {} as never),
      ).rejects.toThrow(/mask target/i)
      expect(record.command).toBeUndefined()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('owner bash aborts before execution when a canonical target has a hardlink alias', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'tc-unsafe-mask-hardlink-'))
    const record: { command?: string } = {}
    try {
      const env = path.join(agentDir, '.env')
      await writeFile(env, 'secret')
      await link(env, path.join(agentDir, 'env-alias'))
      await writeFile(path.join(agentDir, 'secrets.json'), '{}')
      const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
        agentDir,
        sessionId: 's',
        hooks: createHookBus(),
        getOrigin: () => tui,
        permissions: createPermissionService(),
      })
      await expect(
        wrapped.execute('c', { command: 'echo should-not-run' }, undefined, undefined, {} as never),
      ).rejects.toThrow(/mask target/i)
      expect(record.command).toBeUndefined()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('guest needs masks; with bwrap unavailable the call fails closed and the underlying bash never runs', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions: createPermissionService(),
    })
    await expect(
      wrapped.execute('c', { command: 'cat /agent/.env' }, undefined, undefined, {} as never),
    ).rejects.toThrow()
    expect(record.command).toBeUndefined()
  })

  test('prepares, verifies, executes, and cleans the generated privileged runtime at the tool boundary', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-privileged-boundary-'))
    const homeDir = path.join(agentDir, 'home')
    let generatedSource: string | undefined
    try {
      await runFixtureGit(agentDir, 'init')
      await mkdir(homeDir)
      await writeFile(path.join(homeDir, '.gitconfig'), '[user]\nname = Alice\nemail = user@example.com\n')
      const record: { command?: string } = {}
      const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
        agentDir,
        sessionId: 'privileged-boundary',
        hooks: createHookBus(),
        getOrigin: () => tui,
        permissions: createPermissionService(),
        bashSandboxBoundary: {
          ensureAvailable: async () => {},
          resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
          resolveRuntime: (options) => resolvePrivilegedSandboxRuntime({ ...options, homeDir }),
          buildCommand(command, options) {
            if (options === undefined) throw new Error('sandbox options were not provided')
            for (const mount of options.mounts ?? []) {
              if (mount.type === 'ro-bind' && mount.dest === '/tmp/.gitconfig') generatedSource = mount.source
            }
            expect(options.env?.set).toMatchObject({
              GIT_CONFIG_GLOBAL: '/tmp/.gitconfig',
              GIT_CONFIG_NOSYSTEM: '1',
            })
            return buildSandboxedCommand(command, options)
          },
        },
      })

      await wrapped.execute('c', { command: 'git status' }, undefined, undefined, {} as never)

      expect(record.command).toContain('--bind')
      if (generatedSource === undefined) throw new Error('generated profile did not reach sandbox command')
      expect(await Bun.file(generatedSource).exists()).toBe(false)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('inherits runtime Git identity through the production bash sandbox path while withholding Git config', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-git-identity-boundary-'))
    const previous = new Map<string, string | undefined>()
    const identity = {
      GIT_AUTHOR_NAME: 'Runtime Agent',
      GIT_AUTHOR_EMAIL: 'runtime@example.com',
      GIT_COMMITTER_NAME: 'Runtime Agent',
      GIT_COMMITTER_EMAIL: 'runtime@example.com',
    }
    for (const [name, value] of Object.entries({ ...identity, GIT_CONFIG_COUNT: '1' })) {
      previous.set(name, process.env[name])
      process.env[name] = value
    }
    await writeFile(path.join(agentDir, '.env'), 'GIT_CONFIG_GLOBAL=/evil\n')
    let inherited: string[] | undefined
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir,
      sessionId: 'git-identity-boundary',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        buildCommand(command, options) {
          inherited = options?.env?.inherit
          return { ...buildSandboxedCommand(command, options), commandString: command }
        },
      },
    })

    try {
      await wrapped.execute('c', { command: 'git status' }, undefined, undefined, {} as never)
      expect(inherited).toEqual(Object.keys(identity))
      expect(inherited).not.toContain('GIT_CONFIG_GLOBAL')
      expect(inherited).not.toContain('GIT_CONFIG_COUNT')
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('prepends the per-session dependency bin directory to PATH at the bash sandbox boundary', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-dependency-path-'))
    const workspaceRoot = path.join(agentDir, 'packages', 'workspace-cli')
    const workspaceLink = path.join(agentDir, 'node_modules', 'workspace-cli')
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(path.dirname(workspaceLink), { recursive: true })
    await writeFile(
      path.join(agentDir, 'package.json'),
      JSON.stringify({ name: 'test-agent', dependencies: { 'workspace-cli': 'workspace:*' } }),
    )
    await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-cli' }))
    await symlink(workspaceRoot, workspaceLink, process.platform === 'win32' ? 'junction' : 'dir')
    let pathValue: string | undefined
    let mounts: SandboxPolicy['mounts']
    let protectedFiles: string[] | undefined
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir,
      sessionId: 'dependency-path',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        buildCommand(command, options) {
          const built = buildSandboxedCommand(command, options)
          pathValue = built.spawnEnv.PATH
          mounts = options?.mounts
          protectedFiles = options?.protected?.files
          return { ...built, commandString: command }
        },
      },
    })

    await wrapped.execute('c', { command: 'true' }, undefined, undefined, {} as never)

    expect(pathValue).toBe('/tmp/typeclaw-dependency-bin:/usr/local/bin:/usr/bin:/bin')
    expect(mounts?.slice(1, 3).map((mount) => [mount.type, mount.dest])).toEqual([
      ['bind', '/tmp'],
      ['ro-bind', '/tmp/typeclaw-dependency-bin'],
    ])
    expect(protectedFiles).toEqual(expect.arrayContaining([await realpath(path.join(agentDir, 'package.json'))]))
    await rm(agentDir, { recursive: true, force: true })
  })

  test('adds a structured operator-install hint when a direct dependency bin exits 127', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-dependency-hint-'))
    await writeFile(
      path.join(agentDir, 'package.json'),
      JSON.stringify({ name: 'test-agent', dependencies: { opensoma: '^1.0.0' } }),
    )
    const packageRoot = path.join(agentDir, 'node_modules', 'opensoma')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'opensoma', bin: { opensoma: 'missing.js' } }),
    )
    const bash = fakeBash({})
    bash.execute = async () => ({
      content: [{ type: 'text' as const, text: 'bash: opensoma: command not found' }],
      details: undefined,
    })
    const wrapped = wrapBuiltinToolDefinition(bash, {
      agentDir,
      sessionId: 'dependency-hint',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        buildCommand(command, options) {
          return { ...buildSandboxedCommand(command, options), commandString: command }
        },
      },
    })

    const result = await wrapped.execute('c', { command: 'opensoma session list' }, undefined, undefined, {} as never)

    expect(result.content).toContainEqual({
      type: 'text',
      text: '[typeclaw:capability-unavailable capability=dependency-bin dependency=opensoma bin=opensoma action=operator-install]',
    })
    await rm(agentDir, { recursive: true, force: true })
  })

  test('confined authenticated Git cannot load global or system config', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-git-config-isolation-'))
    let sandboxEnv: Record<string, string> | undefined
    try {
      await runFixtureGit(agentDir, 'init')
      const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
        agentDir,
        sessionId: 'git-config-isolation',
        hooks: createHookBus(),
        getOrigin: () => member,
        permissions: createPermissionService(),
        bashSandboxBoundary: {
          ensureAvailable: async () => {},
          resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
          buildCommand(command, options) {
            if (options === undefined) throw new Error('sandbox options were not provided')
            sandboxEnv = options.env?.set
            return buildSandboxedCommand(command, options)
          },
        },
      })

      await wrapped.execute('c', { command: 'git push origin HEAD' }, undefined, undefined, {} as never)

      expect(sandboxEnv).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('cleanup failure invokes tool.after once after cleanup and propagates the cleanup error', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-cleanup-boundary-'))
    const order: string[] = []
    const afterResults: ToolResult[] = []
    const hooks = createHookBus()
    hooks.registerAll('observer', agentDir, noopLogger, {
      'tool.after': (event) => {
        order.push('after')
        afterResults.push(event.result)
      },
    })
    const tool = fakeBash({})
    tool.execute = async () => {
      order.push('execute')
      return { content: [{ type: 'text' as const, text: 'ran' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'cleanup-boundary',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        cleanupRuntime: async () => {
          order.push('cleanup')
          throw new Error('cleanup failed')
        },
      },
    })

    await expect(wrapped.execute('c', { command: 'git status' }, undefined, undefined, {} as never)).rejects.toThrow(
      'cleanup failed',
    )
    expect(order).toEqual(['execute', 'cleanup', 'after'])
    expect(afterResults).toHaveLength(1)
    expect(afterResults[0]?.details).toEqual({ error: 'cleanup failed' })
    await rm(agentDir, { recursive: true, force: true })
  })

  test.skipIf(lacksInodeAnchoring)(
    'pinned output verification failure reaches tool.after exactly once before propagation',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-output-after-'))
      const destination = path.join(agentDir, 'workspace', 'output.txt')
      const protectedFile = path.join(agentDir, 'protected.txt')
      const afterResults: ToolResult[] = []
      await mkdir(path.dirname(destination))
      await writeFile(destination, 'before')
      await writeFile(protectedFile, 'protected')
      const hooks = createHookBus()
      hooks.registerAll('observer', agentDir, noopLogger, {
        'tool.after': (event) => {
          afterResults.push(event.result)
        },
      })
      const tool = definePiTool({
        name: 'write',
        label: 'write',
        description: '',
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        async execute(_callId, params) {
          await writeFile(params.path, params.content)
          await rm(destination)
          await symlink(protectedFile, destination)
          return { content: [{ type: 'text' as const, text: 'wrote' }], details: undefined }
        },
      })
      const wrapped = wrapBuiltinToolDefinition(tool, { agentDir, sessionId: 'output-after', hooks })

      try {
        await expect(
          wrapped.execute('call', { path: destination, content: 'safe' }, undefined, undefined, {} as never),
        ).rejects.toThrow(/changed|symbolic|ELOOP/i)
        expect(afterResults).toHaveLength(1)
        expect(afterResults[0]?.details).toEqual({ error: expect.any(String) })
        expect(await readFile(protectedFile, 'utf8')).toBe('protected')
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(lacksInodeAnchoring)(
    'plugin output verification failure reaches tool.after exactly once before propagation',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-plugin-output-after-'))
      const destination = path.join(agentDir, 'workspace', 'output.txt')
      const protectedFile = path.join(agentDir, 'protected.txt')
      const afterResults: ToolResult[] = []
      await mkdir(path.dirname(destination))
      await writeFile(destination, 'before')
      await writeFile(protectedFile, 'protected')
      const hooks = createHookBus()
      hooks.registerAll('observer', agentDir, noopLogger, {
        'tool.after': (event) => {
          afterResults.push(event.result)
        },
      })
      const tool = defineTool({
        description: '',
        parameters: z.object({ destination: z.string() }),
        fileOperands: { output: ['destination'] },
        async execute(args) {
          await writeFile(args.destination, 'safe')
          await rm(destination)
          await symlink(protectedFile, destination)
          return { content: [{ type: 'text' as const, text: 'wrote' }] }
        },
      })
      const wrapped = wrapPluginTool(tool, {
        pluginName: 'writer',
        toolName: 'plugin_writer',
        agentDir,
        sessionId: 'plugin-output-after',
        logger: noopLogger,
        hooks,
      })

      try {
        await expect(wrapped.execute('call', { destination }, undefined, undefined, {} as never)).rejects.toThrow(
          /changed|symbolic|ELOOP/i,
        )
        expect(afterResults).toHaveLength(1)
        expect(afterResults[0]?.details).toEqual({
          error: true,
          message: expect.stringMatching(/changed|symbolic|ELOOP/i),
        })
        expect(await readFile(protectedFile, 'utf8')).toBe('protected')
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('execution error wins over cleanup error and reaches tool.after exactly once after cleanup', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-error-precedence-'))
    const order: string[] = []
    const afterResults: ToolResult[] = []
    const hooks = createHookBus()
    hooks.registerAll('observer', agentDir, noopLogger, {
      'tool.after': (event) => {
        order.push('after')
        afterResults.push(event.result)
      },
    })
    const tool = fakeBash({})
    tool.execute = async () => {
      order.push('execute')
      throw new Error('execution failed')
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'error-precedence',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        cleanupRuntime: async () => {
          order.push('cleanup')
          throw new Error('cleanup failed')
        },
      },
    })

    await expect(wrapped.execute('c', { command: 'git status' }, undefined, undefined, {} as never)).rejects.toThrow(
      'execution failed',
    )
    expect(order).toEqual(['execute', 'cleanup', 'after'])
    expect(afterResults).toHaveLength(1)
    expect(afterResults[0]?.details).toEqual({
      error: expect.stringContaining('[TypeClaw sandbox policy (LOCAL)'),
    })
    await rm(agentDir, { recursive: true, force: true })
  })

  test('classified failures keep the transcript marker when incident persistence is unavailable', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-persistence-'))
    const afterResults: ToolResult[] = []
    const hooks = createHookBus()
    hooks.registerAll('observer', agentDir, noopLogger, {
      'tool.after': (event) => {
        afterResults.push(event.result)
      },
    })
    const tool = fakeBash({})
    tool.execute = async () => {
      await rm(path.join(agentDir, '.typeclaw'), { recursive: true, force: true })
      await writeFile(path.join(agentDir, '.typeclaw'), 'not-a-directory')
      throw new Error('/bin/bash: opensoma: command not found\n\n\nCommand exited with code 127')
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'incident-persistence',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await expect(wrapped.execute('c', { command: 'opensoma' }, undefined, undefined, {} as never)).rejects.toThrow(
        /TYPECLAW_OPERATIONAL_INCIDENT.*"recurrenceTracking":"unavailable"/,
      )
      expect(afterResults).toHaveLength(1)
      expect(afterResults[0]?.details).toEqual({
        error: expect.stringMatching(/TYPECLAW_OPERATIONAL_INCIDENT.*"recurrenceTracking":"unavailable"/),
      })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('registered operational remediation repairs and retries a classified builtin failure once', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-remediation-'))
    const registry = new RemediationRegistry()
    class TrackingIncidentLedger extends IncidentLedger {
      automaticResolveCalls = 0

      override async resolve(fingerprint: string): Promise<boolean> {
        this.automaticResolveCalls += 1
        return super.resolve(fingerprint)
      }
    }
    const incidentLedger = new TrackingIncidentLedger(agentDir)
    const repairedBins: string[] = []
    registry.register('bash-command-not-found', async (fact) => {
      if (fact.kind === 'bash-command-not-found') repairedBins.push(fact.bin)
      return { repaired: true }
    })
    let attempts = 0
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('/bin/bash: opensoma: command not found\n\n\nCommand exited with code 127')
      }
      return { content: [{ type: 'text' as const, text: 'ran after repair' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'incident-remediation',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: registry,
      incidentLedger,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      const result = await wrapped.execute('c', { command: 'opensoma --version' }, undefined, undefined, {} as never)
      expect(textOfFirstContent(result)).toBe('ran after repair')
      expect(attempts).toBe(2)
      expect(repairedBins).toEqual(['opensoma'])
      expect(incidentLedger.automaticResolveCalls).toBe(1)
      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'bash:command-not-found:opensoma', count: 1, status: 'resolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  // Pi 0.99 bash reports a nonzero exit by RETURNING `isError: true` instead of
  // throwing. The wrapper must route that result through the same error path a
  // thrown failure takes.
  type ScriptedBashStep = { text: string; isError?: true }
  function scriptedBash(results: ReadonlyArray<ScriptedBashStep>) {
    let attempts = 0
    const tool = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        const next = results[Math.min(attempts, results.length - 1)]!
        attempts += 1
        return {
          content: [{ type: 'text' as const, text: next.text }],
          details: undefined,
          ...(next.isError === true ? { isError: true } : {}),
        }
      },
    }
    return { tool, attempts: () => attempts }
  }

  test('a returned isError bash result rejects with the sandbox note and reaches tool.after as an error; a plain result stays a success', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-returned-is-error-'))
    const afterResults: ToolResult[] = []
    const hooks = createHookBus()
    hooks.registerAll('observer', agentDir, noopLogger, {
      'tool.after': (event) => {
        afterResults.push(event.result)
      },
    })
    const wrapScripted = (results: ReadonlyArray<ScriptedBashStep>, sessionId: string) => {
      const bash = scriptedBash(results)
      const wrapped = wrapBuiltinToolDefinition(bash.tool, {
        agentDir,
        sessionId,
        hooks,
        getOrigin: () => tui,
        permissions: createPermissionService(),
        bashSandboxBoundary: {
          ensureAvailable: async () => {},
          resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
          buildCommand: buildSandboxedCommand,
        },
      })
      return { wrapped, attempts: bash.attempts }
    }
    const failing = wrapScripted(
      [{ text: 'fatal: not a git repository\n\nCommand exited with code 128', isError: true }],
      'returned-is-error-failure',
    )
    const succeeding = wrapScripted([{ text: 'clean working tree' }], 'returned-is-error-success')

    try {
      const rejection = failing.wrapped.execute('failure', { command: 'git status' }, undefined, undefined, {} as never)
      await expect(rejection).rejects.toThrow('Command exited with code 128')
      await expect(rejection).rejects.toThrow('[TypeClaw sandbox policy (LOCAL)')
      expect(failing.attempts()).toBe(1)
      expect(afterResults).toHaveLength(1)
      expect(afterResults[0]?.details).toEqual({
        error: expect.stringMatching(/fatal: not a git repository[\s\S]*\[TypeClaw sandbox policy \(LOCAL\)/),
      })

      const result = await succeeding.wrapped.execute(
        'success',
        { command: 'git status' },
        undefined,
        undefined,
        {} as never,
      )
      expect(result.content).toEqual([{ type: 'text', text: 'clean working tree' }])
      expect(succeeding.attempts()).toBe(1)
      expect(afterResults).toHaveLength(2)
      expect(afterResults[1]?.content).toEqual([{ type: 'text', text: 'clean working tree' }])
      expect(afterResults[1]?.details).toBeUndefined()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a returned isError command-not-found result is repaired, retried once, and resolves its incident', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-returned-is-error-remediation-'))
    const registry = new RemediationRegistry()
    const repairedBins: string[] = []
    registry.register('bash-command-not-found', async (fact) => {
      if (fact.kind === 'bash-command-not-found') repairedBins.push(fact.bin)
      return { repaired: true }
    })
    const afterResults: ToolResult[] = []
    const hooks = createHookBus()
    hooks.registerAll('observer', agentDir, noopLogger, {
      'tool.after': (event) => {
        afterResults.push(event.result)
      },
    })
    const bash = scriptedBash([
      { text: '/bin/bash: opensoma: command not found\n\nCommand exited with code 127', isError: true },
      { text: 'ran after repair' },
    ])
    const wrapped = wrapBuiltinToolDefinition(bash.tool, {
      agentDir,
      sessionId: 'returned-is-error-remediation',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: registry,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      const result = await wrapped.execute('c', { command: 'opensoma --version' }, undefined, undefined, {} as never)
      expect(textOfFirstContent(result)).toBe('ran after repair')
      expect(bash.attempts()).toBe(2)
      expect(repairedBins).toEqual(['opensoma'])
      expect(afterResults).toHaveLength(1)
      expect(afterResults[0]?.content).toEqual([{ type: 'text', text: 'ran after repair' }])
      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'bash:command-not-found:opensoma', count: 1, status: 'resolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.each([
    { name: 'no registered remediation', repair: false, expectedAttempts: 1 },
    { name: 'a remediation whose retry still returns isError', repair: true, expectedAttempts: 2 },
  ])(
    'a returned isError command-not-found result with $name rejects with the incident marker',
    async ({ repair, expectedAttempts }) => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-returned-is-error-unrepaired-'))
      const registry = new RemediationRegistry()
      if (repair) registry.register('bash-command-not-found', async () => ({ repaired: true }))
      const afterResults: ToolResult[] = []
      const hooks = createHookBus()
      hooks.registerAll('observer', agentDir, noopLogger, {
        'tool.after': (event) => {
          afterResults.push(event.result)
        },
      })
      const bash = scriptedBash([
        { text: '/bin/bash: opensoma: command not found\n\nCommand exited with code 127', isError: true },
      ])
      const wrapped = wrapBuiltinToolDefinition(bash.tool, {
        agentDir,
        sessionId: 'returned-is-error-unrepaired',
        hooks,
        getOrigin: () => tui,
        permissions: createPermissionService(),
        remediations: registry,
        bashSandboxBoundary: {
          ensureAvailable: async () => {},
          resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
          buildCommand: buildSandboxedCommand,
        },
      })

      try {
        await expect(
          wrapped.execute('c', { command: 'opensoma --version' }, undefined, undefined, {} as never),
        ).rejects.toThrow(/command not found[\s\S]*TYPECLAW_OPERATIONAL_INCIDENT/)
        expect(bash.attempts()).toBe(expectedAttempts)
        expect(afterResults).toHaveLength(1)
        expect(afterResults[0]?.details).toEqual({
          error: expect.stringMatching(/command not found[\s\S]*TYPECLAW_OPERATIONAL_INCIDENT/),
        })
        expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
          { fingerprint: 'bash:command-not-found:opensoma', count: 1, status: 'unresolved' },
        ])
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test.each([
    { name: 'masked aggregate success', command: 'opensoma || true' },
    { name: 'success for a different executable', command: 'another-cli' },
  ])('a remediation retry with $name does not resolve the recorded bin incident', async ({ command }) => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-unverified-remediation-'))
    const registry = new RemediationRegistry()
    registry.register('bash-command-not-found', async () => ({ repaired: true }))
    let attempts = 0
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('/bin/bash: opensoma: command not found\n\n\nCommand exited with code 127')
      }
      return { content: [{ type: 'text' as const, text: 'aggregate retry succeeded' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'incident-unverified-remediation',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: registry,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await wrapped.execute('retry', { command }, undefined, undefined, {} as never)

      expect(attempts).toBe(2)
      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'bash:command-not-found:opensoma', status: 'unresolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a masked successful sandbox remediation retry does not resolve the sandbox incident', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-unverified-sandbox-remediation-'))
    const registry = new RemediationRegistry()
    registry.register('sandbox-proc-unavailable', async () => ({ repaired: true }))
    let attempts = 0
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      if (attempts === 1) throw new SandboxDegradedProcError()
      return { content: [{ type: 'text' as const, text: 'masked sandbox retry succeeded' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'incident-unverified-sandbox-remediation',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: registry,
      realProcDependencyCheck: () => true,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await wrapped.execute('retry', { command: 'package-cli || true' }, undefined, undefined, {} as never)

      expect(attempts).toBe(2)
      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'sandbox:proc-unavailable', status: 'unresolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a later successful invocation resolves an unhandled incident after manual repair', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-manual-repair-'))
    const registry = new RemediationRegistry()
    let attempts = 0
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('/bin/bash: opensoma: command not found\n\n\nCommand exited with code 127')
      }
      return { content: [{ type: 'text' as const, text: 'ran after manual repair' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'incident-manual-repair',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: registry,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await expect(
        wrapped.execute('failure', { command: 'opensoma' }, undefined, undefined, {} as never),
      ).rejects.toThrow('TYPECLAW_OPERATIONAL_INCIDENT')
      expect((await buildOperationalIncidentChecks()[0]!.run({ cwd: agentDir, hasAgentFolder: true })).status).toBe(
        'warning',
      )

      const result = await wrapped.execute(
        'success',
        { command: 'opensoma --version' },
        undefined,
        undefined,
        {} as never,
      )

      expect(textOfFirstContent(result)).toBe('ran after manual repair')
      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'bash:command-not-found:opensoma', status: 'resolved' },
      ])
      expect(await buildOperationalIncidentChecks()[0]!.run({ cwd: agentDir, hasAgentFolder: true })).toEqual({
        status: 'ok',
        message: 'no unresolved operational incidents',
      })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.each([
    { name: 'an OR-list that swallows failure', command: 'opensoma --version || true' },
    { name: 'a short-circuited AND-list', command: 'a && opensoma' },
    { name: 'a pipeline whose last segment succeeds', command: 'opensoma | tee out' },
    { name: 'a conditional that negates failure', command: 'if ! opensoma; then echo skip; fi' },
  ])('aggregate success from $name does not resolve the executable incident', async ({ command }) => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-ambiguous-success-'))
    const incidentLedger = new IncidentLedger(agentDir)
    await incidentLedger.record({ kind: 'bash-command-not-found', bin: 'opensoma' }, 'failure')
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir,
      sessionId: 'incident-ambiguous-success',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      incidentLedger,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await wrapped.execute('success', { command }, undefined, undefined, {} as never)

      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'bash:command-not-found:opensoma', status: 'unresolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a later successful real-proc sandbox execution resolves a sandbox incident', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-sandbox-repair-'))
    let attempts = 0
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      if (attempts === 1) throw new SandboxDegradedProcError()
      return { content: [{ type: 'text' as const, text: 'sandbox package runner succeeded' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'incident-sandbox-repair',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: new RemediationRegistry(),
      realProcDependencyCheck: () => true,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await expect(
        wrapped.execute('failure', { command: 'package-cli' }, undefined, undefined, {} as never),
      ).rejects.toThrow('TYPECLAW_OPERATIONAL_INCIDENT')
      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'sandbox:proc-unavailable', status: 'unresolved' },
      ])

      await wrapped.execute('success', { command: 'package-cli' }, undefined, undefined, {} as never)

      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'sandbox:proc-unavailable', status: 'resolved' },
      ])
      expect(await buildOperationalIncidentChecks()[0]!.run({ cwd: agentDir, hasAgentFolder: true })).toEqual({
        status: 'ok',
        message: 'no unresolved operational incidents',
      })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('aggregate success from a chained sandbox command does not resolve a sandbox incident', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-ambiguous-sandbox-success-'))
    const incidentLedger = new IncidentLedger(agentDir)
    await incidentLedger.record({ kind: 'sandbox-proc-unavailable' }, 'failure')
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir,
      sessionId: 'incident-ambiguous-sandbox-success',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      incidentLedger,
      realProcDependencyCheck: () => true,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await wrapped.execute('success', { command: 'package-cli || true' }, undefined, undefined, {} as never)

      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'sandbox:proc-unavailable', status: 'unresolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a later successful bin invocation resolves a declared skill-bin incident', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-skill-bin-repair-'))
    let attempts = 0
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      if (attempts === 1) throw new DeclaredSkillBinUnresolvedError('opensoma')
      return { content: [{ type: 'text' as const, text: 'declared bin succeeded' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'incident-skill-bin-repair',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: new RemediationRegistry(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await expect(
        wrapped.execute('failure', { command: 'opensoma' }, undefined, undefined, {} as never),
      ).rejects.toThrow('TYPECLAW_OPERATIONAL_INCIDENT')
      await wrapped.execute('success', { command: 'opensoma' }, undefined, undefined, {} as never)

      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'skill-bin:declared-but-unresolved:opensoma', status: 'resolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('one successful bin invocation resolves command-not-found and skill-bin incidents together', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-dual-bin-repair-'))
    const incidentLedger = new IncidentLedger(agentDir)
    await incidentLedger.record({ kind: 'bash-command-not-found', bin: 'opensoma' }, 'command-failure')
    await incidentLedger.record({ kind: 'declared-skill-bin-unresolved', bin: 'opensoma' }, 'skill-bin-failure')
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir,
      sessionId: 'incident-dual-bin-repair',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      incidentLedger,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await wrapped.execute('success', { command: 'opensoma' }, undefined, undefined, {} as never)

      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'bash:command-not-found:opensoma', status: 'resolved' },
        { fingerprint: 'skill-bin:declared-but-unresolved:opensoma', status: 'resolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a successful unrelated command does not resolve another executable incident', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-unrelated-success-'))
    const registry = new RemediationRegistry()
    let attempts = 0
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('/bin/bash: opensoma: command not found\n\n\nCommand exited with code 127')
      }
      return { content: [{ type: 'text' as const, text: 'unrelated command succeeded' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'incident-unrelated-success',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: registry,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      await expect(
        wrapped.execute('failure', { command: 'opensoma' }, undefined, undefined, {} as never),
      ).rejects.toThrow('TYPECLAW_OPERATIONAL_INCIDENT')
      await wrapped.execute('success', { command: 'another-cli' }, undefined, undefined, {} as never)

      expect((await readIncidentLedger(agentDir)).incidents).toMatchObject([
        { fingerprint: 'bash:command-not-found:opensoma', status: 'unresolved' },
      ])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a successful invocation with no open incidents performs no ledger read or lock', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-incident-empty-fast-path-'))
    let inspections = 0
    let reads = 0
    let locks = 0
    const incidentLedger = new IncidentLedger(agentDir, {
      inspect: async () => {
        inspections += 1
        return { kind: 'missing' }
      },
      read: async () => {
        reads += 1
        throw new Error('empty-ledger gate read unexpectedly')
      },
      serialize: async () => {
        locks += 1
        throw new Error('empty-ledger gate locked unexpectedly')
      },
    })
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir,
      sessionId: 'incident-empty-fast-path',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
      incidentLedger,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand: buildSandboxedCommand,
      },
    })

    try {
      const result = await wrapped.execute('success', { command: 'echo healthy' }, undefined, undefined, {} as never)

      expect(textOfFirstContent(result)).toBe('ran')
      expect({ inspections, reads, locks }).toEqual({ inspections: 1, reads: 0, locks: 0 })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('without a permission service bash fails closed and never reaches the underlying tool', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => guest,
    })
    await expect(wrapped.execute('c', { command: 'echo hi' }, undefined, undefined, {} as never)).rejects.toThrow(
      /permission service/i,
    )
    expect(record.command).toBeUndefined()
  })

  test('a hook-set env overlay is stripped from args and never reaches an unwired command', async () => {
    const record: { command?: string } = {}
    const hooks = createHookBus()
    hooks.registerAll('env-setter', '/agent', noopLogger, {
      'tool.before': (event) => {
        ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_ENV] = { GH_TOKEN: 'ghs_minted' }
      },
    })
    const args: Record<string, unknown> = { command: 'gh pr view -R acme/widgets' }
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks,
      getOrigin: () => tui,
    })
    await expect(wrapped.execute('c', args as never, undefined, undefined, {} as never)).rejects.toThrow(
      /permission service/i,
    )
    expect(record.command).toBeUndefined()
    expect(args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
  })

  test('a secret env overlay reaches the sandbox child without entering generated bwrap text', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-secret-env-boundary-'))
    const ghToken = 'boundary-gh-token-value'
    const gitToken = 'boundary-git-token-value'
    let generated: ReturnType<typeof buildSandboxedCommand> | undefined
    try {
      const hooks = createHookBus()
      hooks.registerAll('env-setter', agentDir, noopLogger, {
        'tool.before': (event) => {
          ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_ENV] = {
            GH_TOKEN: ghToken,
            TYPECLAW_GIT_TOKEN: gitToken,
            GH_REPO: 'acme/widgets',
          }
        },
      })
      const bash = defaultBuiltinPiToolDefinitions(agentDir).find((tool) => tool.name === 'bash')
      if (bash === undefined) throw new Error('bash tool definition not found')
      const wrapped = wrapBuiltinToolDefinition(bash, {
        agentDir,
        sessionId: 'secret-env-boundary',
        hooks,
        getOrigin: () => tui,
        permissions: createPermissionService(),
        bashSandboxBoundary: {
          ensureAvailable: async () => {},
          resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
          resolveRuntime: async () => ({ env: {}, mounts: [] }),
          buildCommand(command, options) {
            if (options === undefined) throw new Error('sandbox options were not provided')
            expect(options.env?.inherit).toEqual(['GH_TOKEN', 'TYPECLAW_GIT_TOKEN'])
            expect(options.env?.set).toMatchObject({ GH_REPO: 'acme/widgets' })
            expect(options.env?.set?.GH_TOKEN).toBeUndefined()
            expect(options.env?.set?.TYPECLAW_GIT_TOKEN).toBeUndefined()
            generated = buildSandboxedCommand(command, options)
            return { ...generated, commandString: command }
          },
        },
      })

      const result = await wrapped.execute(
        'c',
        { command: `printf '%s\n%s' "$GH_TOKEN" "$TYPECLAW_GIT_TOKEN"` },
        undefined,
        undefined,
        {} as never,
      )

      expect(textOfFirstContent(result)).toContain(ghToken)
      expect(textOfFirstContent(result)).toContain(gitToken)
      expect(generated).toBeDefined()
      expect(generated?.argv.join('\n')).not.toContain(ghToken)
      expect(generated?.argv.join('\n')).not.toContain(gitToken)
      expect(generated?.commandString).not.toContain(ghToken)
      expect(generated?.commandString).not.toContain(gitToken)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a client-supplied env overlay is stripped before hooks run (only trusted hooks may set it)', async () => {
    const record: { command?: string } = {}
    let seenInHook: unknown = 'unset'
    const hooks = createHookBus()
    hooks.registerAll('observer', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenInHook = (event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_ENV]
      },
    })
    const args: Record<string, unknown> = {
      command: 'echo hi',
      [TYPECLAW_INTERNAL_BASH_ENV]: { GH_TOKEN: 'attacker' },
    }
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks,
      getOrigin: () => tui,
    })
    await expect(wrapped.execute('c', args as never, undefined, undefined, {} as never)).rejects.toThrow(
      /permission service/i,
    )
    expect(seenInHook).toBeUndefined()
  })

  test('a client-supplied env withhold list is stripped before hooks run', async () => {
    const record: { command?: string } = {}
    let seenInHook: unknown = 'unset'
    const hooks = createHookBus()
    hooks.registerAll('observer', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenInHook = (event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV]
      },
    })
    const args: Record<string, unknown> = {
      command: 'echo hi',
      [TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV]: ['SERVICE_TOKEN'],
    }
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks,
      getOrigin: () => tui,
    })

    await expect(wrapped.execute('c', args as never, undefined, undefined, {} as never)).rejects.toThrow(
      /permission service/i,
    )
    expect(seenInHook).toBeUndefined()
    expect(args[TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV]).toBeUndefined()
  })

  test('a client-supplied deferred bash preparation is stripped before hooks run', async () => {
    let seenInHook: unknown = 'unset'
    const hooks = createHookBus()
    hooks.registerAll('observer', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenInHook = (event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_PREPARE]
      },
    })
    const args: Record<string, unknown> = {
      command: 'echo hi',
      [TYPECLAW_INTERNAL_BASH_PREPARE]: async () => {
        throw new Error('client preparation ran')
      },
    }
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir: '/agent',
      sessionId: 's',
      hooks,
      getOrigin: () => tui,
    })

    await expect(wrapped.execute('c', args as never, undefined, undefined, {} as never)).rejects.toThrow(
      /permission service/i,
    )
    expect(seenInHook).toBeUndefined()
    expect(args[TYPECLAW_INTERNAL_BASH_PREPARE]).toBeUndefined()
  })

  test('subagent policy rejection happens before deferred preparation', async () => {
    let prepared = 0
    const hooks = createHookBus()
    hooks.registerAll('preparer', '/agent', noopLogger, {
      'tool.before': (event) => {
        ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_PREPARE] = async () => {
          prepared += 1
          throw new Error('preparation should not run')
        }
      },
    })
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir: '/agent',
      sessionId: 's',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashPolicy: { kind: 'readonly-reviewer' },
    })

    await expect(
      wrapped.execute('c', { command: 'git push origin HEAD' }, undefined, undefined, {} as never),
    ).rejects.toThrow()
    expect(prepared).toBe(0)
  })

  test.each([false, true])(
    'deferred preparation adds a last-wins read-only mount and cleans it after execution (failure=%s)',
    async (failExecution) => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-deferred-bash-'))
      const source = await mkdtemp(path.join(tmpdir(), 'typeclaw-deferred-source-'))
      let capturedPolicy: SandboxPolicy | undefined
      const hooks = createHookBus()
      hooks.registerAll('preparer', agentDir, noopLogger, {
        'tool.before': (event) => {
          ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_PREPARE] = async () => ({
            command: 'git --git-dir /tmp/isolated push https://github.com/acme/widgets.git HEAD:HEAD',
            env: { GIT_DIR: '/tmp/isolated' },
            mount: { type: 'ro-bind', source, dest: '/tmp/isolated' },
            cleanup: async () => await rm(source, { recursive: true, force: true }),
          })
        },
      })
      const bash = {
        ...fakeBash({}),
        async execute() {
          if (failExecution) throw new Error('synthetic execution failure')
          return { content: [{ type: 'text' as const, text: 'ran' }], details: undefined }
        },
      }
      const wrapped = wrapBuiltinToolDefinition(bash, {
        agentDir,
        sessionId: `deferred-${failExecution}`,
        hooks,
        getOrigin: () => tui,
        permissions: createPermissionService(),
        bashSandboxBoundary: {
          ensureAvailable: async () => {},
          resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
          buildCommand(command, options) {
            if (options === undefined) throw new Error('sandbox options missing')
            capturedPolicy = options
            return { ...buildSandboxedCommand(command, options), commandString: command }
          },
        },
      })

      try {
        if (failExecution) {
          await expect(
            wrapped.execute('c', { command: 'git push origin HEAD' }, undefined, undefined, {} as never),
          ).rejects.toThrow(/synthetic execution failure/)
        } else {
          await wrapped.execute('c', { command: 'git push origin HEAD' }, undefined, undefined, {} as never)
        }
        const mounts = capturedPolicy?.mounts ?? []
        const writableTmp = mounts.findIndex((mount) => mount.type === 'bind' && mount.dest === '/tmp')
        const isolated = mounts.findIndex(
          (mount) => mount.type === 'ro-bind' && mount.source === source && mount.dest === '/tmp/isolated',
        )
        expect(writableTmp).toBeGreaterThanOrEqual(0)
        expect(isolated).toBeGreaterThan(writableTmp)
        expect(
          await stat(source).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      } finally {
        await rm(agentDir, { recursive: true, force: true })
        await rm(source, { recursive: true, force: true })
      }
    },
  )

  test('sandbox build failure cleans deferred preparation exactly once', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-deferred-build-'))
    const source = await mkdtemp(path.join(tmpdir(), 'typeclaw-deferred-build-source-'))
    let cleanups = 0
    const hooks = createHookBus()
    hooks.registerAll('preparer', agentDir, noopLogger, {
      'tool.before': (event) => {
        ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_PREPARE] = async () => ({
          command: 'echo prepared',
          mount: { type: 'ro-bind', source, dest: '/tmp/isolated' },
          cleanup: async () => {
            cleanups += 1
            await rm(source, { recursive: true, force: true })
          },
        })
      },
    })
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir,
      sessionId: 'deferred-build-error',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand() {
          throw new Error('synthetic sandbox build failure')
        },
      },
    })

    try {
      await expect(
        wrapped.execute('c', { command: 'echo original' }, undefined, undefined, {} as never),
      ).rejects.toThrow(/synthetic sandbox build failure/)
      expect(cleanups).toBe(1)
      expect(
        await stat(source).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test('remediation retry gets a fresh preparation and cleans each attempt once', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-deferred-retry-'))
    const registry = new RemediationRegistry()
    registry.register('bash-command-not-found', async () => ({ repaired: true }))
    const sources: string[] = []
    const cleanupCounts: number[] = []
    const hooks = createHookBus()
    hooks.registerAll('preparer', agentDir, noopLogger, {
      'tool.before': (event) => {
        ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_PREPARE] = async () => {
          const source = await mkdtemp(path.join(tmpdir(), 'typeclaw-deferred-retry-source-'))
          const index = sources.push(source) - 1
          cleanupCounts[index] = 0
          return {
            command: 'opensoma --version',
            mount: { type: 'ro-bind' as const, source, dest: `/tmp/isolated-${index}` },
            cleanup: async () => {
              cleanupCounts[index] = (cleanupCounts[index] ?? 0) + 1
              await rm(source, { recursive: true, force: true })
            },
          }
        }
      },
    })
    let attempts = 0
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('/bin/bash: opensoma: command not found\n\nCommand exited with code 127')
      return { content: [{ type: 'text' as const, text: 'retried' }], details: undefined }
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'deferred-retry',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: registry,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand(command, options) {
          if (options === undefined) throw new Error('sandbox options missing')
          return { ...buildSandboxedCommand(command, options), commandString: command }
        },
      },
    })

    try {
      expect(
        textOfFirstContent(
          await wrapped.execute('c', { command: 'opensoma --version' }, undefined, undefined, {} as never),
        ),
      ).toBe('retried')
      expect(attempts).toBe(2)
      expect(sources).toHaveLength(2)
      expect(new Set(sources).size).toBe(2)
      expect(cleanupCounts).toEqual([1, 1])
      for (const source of sources) {
        expect(
          await stat(source).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true })
      for (const source of sources) await rm(source, { recursive: true, force: true })
    }
  })

  test('a cleanup failure prevents remediation retry and surfaces the cleanup error', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-deferred-cleanup-failure-'))
    const registry = new RemediationRegistry()
    registry.register('bash-command-not-found', async () => ({ repaired: true }))
    let attempts = 0
    let cleanups = 0
    const hooks = createHookBus()
    hooks.registerAll('preparer', agentDir, noopLogger, {
      'tool.before': (event) => {
        ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_PREPARE] = async () => ({
          command: 'opensoma --version',
          mount: { type: 'ro-bind' as const, source: agentDir, dest: '/tmp/isolated' },
          cleanup: async () => {
            cleanups += 1
            throw new Error('synthetic deferred cleanup failure')
          },
        })
      },
    })
    const tool = fakeBash({})
    tool.execute = async () => {
      attempts += 1
      throw new Error('/bin/bash: opensoma: command not found\n\nCommand exited with code 127')
    }
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir,
      sessionId: 'deferred-cleanup-failure',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      remediations: registry,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
        buildCommand(command, options) {
          if (options === undefined) throw new Error('sandbox options missing')
          return { ...buildSandboxedCommand(command, options), commandString: command }
        },
      },
    })

    try {
      await expect(
        wrapped.execute('c', { command: 'opensoma --version' }, undefined, undefined, {} as never),
      ).rejects.toThrow(/synthetic deferred cleanup failure/)
      expect(attempts).toBe(1)
      expect(cleanups).toBe(1)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('loop guard blocks before creating a fifth deferred preparation', async () => {
    let preparations = 0
    const hooks = createHookBus()
    hooks.registerAll('preparer', '/agent', noopLogger, {
      'tool.before': (event) => {
        ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_PREPARE] = async () => {
          preparations += 1
          throw new Error('preparation should not run')
        }
      },
    })
    const wrapped = wrapBuiltinToolDefinition(fakeBash({}), {
      agentDir: '/agent',
      sessionId: 'deferred-loop',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
      bashPolicy: { kind: 'readonly-reviewer' },
    })

    for (let i = 0; i < 4; i++) {
      await expect(
        wrapped.execute(`c${i}`, { command: 'git push origin HEAD' }, undefined, undefined, {} as never),
      ).rejects.toThrow()
    }
    await expect(
      wrapped.execute('c5', { command: 'git push origin HEAD' }, undefined, undefined, {} as never),
    ).rejects.toThrow(/loop-guard/)
    expect(preparations).toBe(0)
  })

  test('final write guard blocks before deferred preparation for a non-bash tool', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-deferred-final-'))
    const configPath = path.join(agentDir, 'typeclaw.json')
    await writeFile(configPath, '{"models":{"default":"anthropic/claude-haiku-4-5"}}\n')
    let preparations = 0
    const hooks = createHookBus()
    hooks.registerAll('preparer', agentDir, noopLogger, {
      'tool.before': (event) => {
        ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_PREPARE] = async () => {
          preparations += 1
          throw new Error('preparation should not run')
        }
      },
    })
    const guards = await registerGuardPlugin(hooks, agentDir)
    const editTool = {
      name: 'edit',
      label: 'edit',
      description: '',
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
      }),
      async execute() {
        throw new Error('underlying edit should not run')
      },
    }
    const wrapped = wrapBuiltinToolDefinition(editTool, {
      agentDir,
      sessionId: 'deferred-final',
      hooks,
      guards,
    })

    try {
      await expect(
        wrapped.execute(
          'c',
          { path: configPath, edits: [{ oldText: 'anthropic/claude-haiku-4-5', newText: 'invalid' }] },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/blocked/i)
      expect(preparations).toBe(0)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a hook-set env withhold removes an ambient name from sandbox inherit and spawn env', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-withhold-env-boundary-'))
    const name = 'TYPECLAW_COMMAND_TOKEN'
    process.env[name] = 'ambient-token'
    try {
      await writeFile(path.join(agentDir, '.env'), `${name}=operator-token\n`)
      const hooks = createHookBus()
      hooks.registerAll('env-withholder', agentDir, noopLogger, {
        'tool.before': (event) => {
          ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV] = [name]
        },
      })
      const bash = defaultBuiltinPiToolDefinitions(agentDir).find((tool) => tool.name === 'bash')
      if (bash === undefined) throw new Error('bash tool definition not found')
      const wrapped = wrapBuiltinToolDefinition(bash, {
        agentDir,
        sessionId: 'withhold-env-boundary',
        hooks,
        getOrigin: () => tui,
        permissions: createPermissionService(),
        bashSandboxBoundary: {
          ensureAvailable: async () => {},
          resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
          buildCommand(command, options) {
            if (options === undefined) throw new Error('sandbox options were not provided')
            expect(options.env?.inherit ?? []).not.toContain(name)
            expect(options.env?.set?.[name]).toBeUndefined()
            expect(options.env?.withhold).toContain(name)
            return { ...buildSandboxedCommand(command, options), commandString: command }
          },
        },
      })

      const result = await wrapped.execute(
        'c',
        { command: `printf '%s' "\${${name}:-missing}"` },
        undefined,
        undefined,
        {} as never,
      )

      expect(textOfFirstContent(result)).toBe('missing')
    } finally {
      delete process.env[name]
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('a hook overlay wins when it also withholds the ambient name', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-withhold-overlay-boundary-'))
    const name = 'TYPECLAW_COMMAND_TOKEN'
    process.env[name] = 'ambient-token'
    try {
      await writeFile(path.join(agentDir, '.env'), `${name}=operator-token\n`)
      const hooks = createHookBus()
      hooks.registerAll('env-replacer', agentDir, noopLogger, {
        'tool.before': (event) => {
          const args = event.args as Record<string, unknown>
          args[TYPECLAW_INTERNAL_BASH_WITHHOLD_ENV] = [name]
          args[TYPECLAW_INTERNAL_BASH_ENV] = { [name]: 'injected-token' }
        },
      })
      const bash = defaultBuiltinPiToolDefinitions(agentDir).find((tool) => tool.name === 'bash')
      if (bash === undefined) throw new Error('bash tool definition not found')
      const wrapped = wrapBuiltinToolDefinition(bash, {
        agentDir,
        sessionId: 'withhold-overlay-boundary',
        hooks,
        getOrigin: () => tui,
        permissions: createPermissionService(),
        bashSandboxBoundary: {
          ensureAvailable: async () => {},
          resolveProcStrategy: async () => ({ strategy: 'proc-bind' as const }),
          buildCommand(command, options) {
            if (options === undefined) throw new Error('sandbox options were not provided')
            expect(options.env?.inherit).toContain(name)
            expect(options.env?.withhold ?? []).not.toContain(name)
            return { ...buildSandboxedCommand(command, options), commandString: command }
          },
        },
      })

      const result = await wrapped.execute(
        'c',
        { command: `printf '%s' "$${name}"` },
        undefined,
        undefined,
        {} as never,
      )

      expect(textOfFirstContent(result)).toBe('injected-token')
    } finally {
      delete process.env[name]
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})

describe('buildSandboxEnvPolicy exposable .env names', () => {
  test('adds exposable names to inherit so values stay out of argv', () => {
    const policy = buildSandboxEnvPolicy(undefined, undefined, ['SERVICE_CONFIG_DIR', 'DATABASE_URL'])
    expect(policy.inherit).toEqual(['SERVICE_CONFIG_DIR', 'DATABASE_URL'])
    expect(policy.set).toBeUndefined()
  })

  test('does not inherit a name already provided by the privileged runtime set', () => {
    const policy = buildSandboxEnvPolicy(undefined, { SERVICE_CONFIG_DIR: '/runtime' }, ['SERVICE_CONFIG_DIR'])
    expect(policy.inherit ?? []).not.toContain('SERVICE_CONFIG_DIR')
    expect(policy.set?.SERVICE_CONFIG_DIR).toBe('/runtime')
  })

  test('deduplicates a name that is both a secret-pattern overlay and an exposable name', () => {
    const policy = buildSandboxEnvPolicy({ FOO_TOKEN: 'x' }, undefined, ['FOO_TOKEN'])
    expect(policy.inherit).toEqual(['FOO_TOKEN'])
  })

  test('withhold wins over privileged runtime set and exposable inheritance', () => {
    const policy = buildSandboxEnvPolicy(
      undefined,
      { SERVICE_TOKEN: 'runtime-token' },
      ['SERVICE_TOKEN'],
      ['SERVICE_TOKEN'],
    )

    expect(policy.inherit ?? []).not.toContain('SERVICE_TOKEN')
    expect(policy.set?.SERVICE_TOKEN).toBeUndefined()
    expect(policy.withhold).toEqual(['SERVICE_TOKEN'])
  })

  test('overlay wins over a withhold request for the same name', () => {
    const policy = buildSandboxEnvPolicy(
      { SERVICE_TOKEN: 'injected-token' },
      { SERVICE_TOKEN: 'runtime-token' },
      ['SERVICE_TOKEN'],
      ['SERVICE_TOKEN'],
    )

    expect(policy.inherit).toEqual(['SERVICE_TOKEN'])
    expect(policy.set?.SERVICE_TOKEN).toBeUndefined()
    expect(policy.withhold).toBeUndefined()
  })

  test('fallback spawn env removes withheld ambient values before applying the overlay', () => {
    const env = sanitizeBashSpawnEnvironment(
      { AMBIENT_TOKEN: 'ambient', REPLACED_TOKEN: 'ambient' },
      { REPLACED_TOKEN: 'injected' },
      ['AMBIENT_TOKEN', 'REPLACED_TOKEN'],
    )

    expect(env.AMBIENT_TOKEN).toBeUndefined()
    expect(env.REPLACED_TOKEN).toBe('injected')
  })

  test('inherits runtime-injected Git identity by name so values stay out of argv', () => {
    const names = resolveExposableEnvNames(new Map(), {
      GIT_AUTHOR_NAME: 'Agent Smith',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent Smith',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
    })

    const policy = buildSandboxEnvPolicy(undefined, undefined, names)

    expect(policy.inherit).toEqual(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'])
  })
})

describe('buildSandboxEnvPolicy DISPLAY passthrough (agent-browser --headed)', () => {
  const originalDisplay = process.env['DISPLAY']

  afterEach(() => {
    if (originalDisplay === undefined) delete process.env['DISPLAY']
    else process.env['DISPLAY'] = originalDisplay
  })

  test('passes the runtime DISPLAY into set so sandboxed Chrome finds the X server', () => {
    process.env['DISPLAY'] = ':99'
    const policy = buildSandboxEnvPolicy(undefined, undefined, [])
    expect(policy.set?.DISPLAY).toBe(':99')
  })

  test('omits DISPLAY when the runtime has none (docker.file.xvfb=false)', () => {
    delete process.env['DISPLAY']
    const policy = buildSandboxEnvPolicy(undefined, undefined, [])
    expect(policy.set?.DISPLAY).toBeUndefined()
  })

  test('omits DISPLAY when set to an empty string', () => {
    process.env['DISPLAY'] = ''
    const policy = buildSandboxEnvPolicy(undefined, undefined, [])
    expect(policy.set?.DISPLAY).toBeUndefined()
  })

  test('does not overwrite a DISPLAY already provided by the privileged runtime set', () => {
    process.env['DISPLAY'] = ':99'
    const policy = buildSandboxEnvPolicy(undefined, { DISPLAY: ':1' }, [])
    expect(policy.set?.DISPLAY).toBe(':1')
  })
})

describe('wrapBuiltinToolDefinition subagent bash policy (capability fence, role-independent)', () => {
  function fakeBash(record: { command?: string }) {
    return {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_id: string, params: { command: string }) {
        record.command = params.command
        return { content: [{ type: 'text' as const, text: 'ran' }], details: undefined }
      },
    }
  }

  const ownerTui: SessionOrigin = { kind: 'tui', sessionId: 's' }

  test('readonly-reviewer policy blocks a mutating command and the underlying bash never runs — even for a trusted owner origin', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => ownerTui,
      permissions: createPermissionService(),
      bashPolicy: { kind: 'readonly-reviewer' },
    })
    await expect(
      wrapped.execute('c', { command: 'git push origin HEAD' }, undefined, undefined, {} as never),
    ).rejects.toThrow()
    expect(record.command).toBeUndefined()
  })

  test('readonly-reviewer policy cannot bypass missing sandbox permission wiring', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => ownerTui,
      bashPolicy: { kind: 'readonly-reviewer' },
    })
    await expect(wrapped.execute('c', { command: 'git status' }, undefined, undefined, {} as never)).rejects.toThrow(
      /permission service/i,
    )
    expect(record.command).toBeUndefined()
  })

  test('no bashPolicy still cannot bypass missing sandbox permission wiring', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => ownerTui,
    })
    await expect(
      wrapped.execute('c', { command: 'git push origin HEAD' }, undefined, undefined, {} as never),
    ).rejects.toThrow(/permission service/i)
    expect(record.command).toBeUndefined()
  })
})

describe('wrapBuiltinToolDefinition /tmp path redirect (per-session scratch)', () => {
  function fakeWrite(record: { path?: string; resolvedTarget?: string }) {
    return {
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id: string, params: { path: string; content: string }) {
        record.path = params.path
        record.resolvedTarget = await realpath(params.path)
        await writeFile(params.path, params.content)
        return { content: [{ type: 'text' as const, text: 'wrote' }], details: { path: params.path } }
      },
    }
  }

  function fakeRead(record: { path?: string }) {
    return {
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id: string, params: { path: string }) {
        record.path = params.path
        return { content: [{ type: 'text' as const, text: 'read' }], details: { path: params.path } }
      },
    }
  }

  const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }
  const guest: SessionOrigin = { kind: 'subagent', subagent: 'x', parentSessionId: 'p', spawnedByRole: 'guest' }

  // Backing dirs live on the REAL process-shared container /tmp (SESSION_TMP_ROOT).
  // The oversubscription flake guard runs two `bun test` processes at once; a fixed
  // sessionId makes both race the same dir, so one's `rm -rf` unlinks it while the
  // other still holds an anchored parent fd. pid separates the suites; randomUUID
  // also guards PID reuse and crashed-run artifacts.
  const uniqueSessionId = (label: string): string => `plugin-tools-${label}-${process.pid}-${randomUUID()}`

  test.skipIf(lacksInodeAnchoring)(
    'a sandboxed role (guest) has its /tmp write redirected to the session backing dir',
    async () => {
      const sessionId = uniqueSessionId('guest-write')
      const sessionDir = `${SESSION_TMP_ROOT}/${sessionId}`
      const record: { path?: string; resolvedTarget?: string } = {}
      const wrapped = wrapBuiltinToolDefinition(fakeWrite(record), {
        agentDir: '/agent',
        sessionId,
        hooks: createHookBus(),
        getOrigin: () => guest,
        permissions: createPermissionService(),
      })
      try {
        const result = await wrapped.execute(
          'c',
          { path: '/tmp/review.json', content: '{}' } as never,
          undefined,
          undefined,
          {} as never,
        )
        expect(record.path).toMatch(/^\/proc\/self\/fd\/\d+$/)
        expect(record.resolvedTarget).toBe(`${sessionDir}/review.json`)
        expect(result.details).toEqual({ path: '/tmp/review.json' })
        expect(await readFile(`${sessionDir}/review.json`, 'utf8')).toBe('{}')
      } finally {
        await rm(sessionDir, { recursive: true, force: true })
      }
    },
  )

  test('a sandboxed role (guest) reading /tmp resolves to the same session backing dir bash wrote', async () => {
    const sessionId = uniqueSessionId('guest-read')
    const sessionDir = `${SESSION_TMP_ROOT}/${sessionId}`
    await mkdir(sessionDir, { recursive: true })
    await writeFile(`${sessionDir}/review.json`, '{}')
    const record: { path?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeRead(record), {
      agentDir: '/agent',
      sessionId,
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions: createPermissionService(),
    })
    try {
      const result = await wrapped.execute(
        'c',
        { path: '/tmp/review.json' } as never,
        undefined,
        undefined,
        {} as never,
      )
      expect(result.details).toEqual({ path: '/tmp/review.json' })
      expect(record.path).not.toBe('/tmp/review.json')
    } finally {
      await rm(sessionDir, { recursive: true, force: true })
    }
  })

  test.skipIf(lacksInodeAnchoring)(
    'an owner write uses the session /tmp backing because owner bash is also sandboxed',
    async () => {
      const sessionId = uniqueSessionId('owner-write')
      const sessionDir = `${SESSION_TMP_ROOT}/${sessionId}`
      const record: { path?: string; resolvedTarget?: string } = {}
      const wrapped = wrapBuiltinToolDefinition(fakeWrite(record), {
        agentDir: '/agent',
        sessionId,
        hooks: createHookBus(),
        getOrigin: () => tui,
        permissions: createPermissionService(),
      })
      try {
        const result = await wrapped.execute(
          'c',
          { path: '/tmp/review.json', content: '{}' } as never,
          undefined,
          undefined,
          {} as never,
        )
        expect(record.path).toMatch(/^\/proc\/self\/fd\/\d+$/)
        expect(record.resolvedTarget).toBe(`${sessionDir}/review.json`)
        expect(result.details).toEqual({ path: '/tmp/review.json' })
        expect(await readFile(`${sessionDir}/review.json`, 'utf8')).toBe('{}')
      } finally {
        await rm(sessionDir, { recursive: true, force: true })
      }
    },
  )

  test('an owner read uses the session /tmp backing because owner bash is also sandboxed', async () => {
    const sessionId = uniqueSessionId('owner-read')
    const sessionDir = `${SESSION_TMP_ROOT}/${sessionId}`
    await mkdir(sessionDir, { recursive: true })
    await writeFile(`${sessionDir}/review.json`, '{}')
    const record: { path?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeRead(record), {
      agentDir: '/agent',
      sessionId,
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    try {
      const result = await wrapped.execute(
        'c',
        { path: '/tmp/review.json' } as never,
        undefined,
        undefined,
        {} as never,
      )
      expect(result.details).toEqual({ path: '/tmp/review.json' })
      expect(record.path).not.toBe('/tmp/review.json')
    } finally {
      await rm(sessionDir, { recursive: true, force: true })
    }
  })

  test.skipIf(lacksInodeAnchoring)('a non-/tmp write is left untouched even for a sandboxed role', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-non-tmp-write-'))
    const workspace = path.join(agentDir, 'workspace')
    await mkdir(workspace)
    const record: { path?: string; resolvedTarget?: string } = {}
    const wrapped = wrapBuiltinToolDefinition(fakeWrite(record), {
      agentDir,
      sessionId: 'sid42',
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions: createPermissionService(),
    })
    try {
      const result = await wrapped.execute(
        'c',
        { path: 'workspace/out.json', content: '{}' } as never,
        undefined,
        undefined,
        {} as never,
      )
      expect(record.path).toMatch(/^\/proc\/self\/fd\/\d+$/)
      expect(record.resolvedTarget).toBe(path.join(workspace, 'out.json'))
      expect(result.details).toEqual({ path: 'workspace/out.json' })
      expect(await readFile(path.join(workspace, 'out.json'), 'utf8')).toBe('{}')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  // Mirrors pi's real write tool, which echoes the path back ("Successfully
  // wrote N bytes to <path>"). The leaked backing path does not exist inside
  // the bwrap bash sandbox, so a model that pastes it into `gh api --input`
  // hits "no such file or directory" (the PR #672 strand this guards).
  function fakeWriteEchoingPath() {
    return {
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id: string, params: { path: string; content: string }) {
        return {
          content: [{ type: 'text' as const, text: `Successfully wrote 2 bytes to ${params.path}` }],
          details: { path: params.path },
        }
      },
    }
  }

  test.skipIf(lacksInodeAnchoring)(
    'a sandboxed role sees its original /tmp path in the receipt, not the backing dir',
    async () => {
      const sessionId = uniqueSessionId('guest-receipt')
      const sessionDir = `${SESSION_TMP_ROOT}/${sessionId}`
      const wrapped = wrapBuiltinToolDefinition(fakeWriteEchoingPath(), {
        agentDir: '/agent',
        sessionId,
        hooks: createHookBus(),
        getOrigin: () => guest,
        permissions: createPermissionService(),
      })
      try {
        const result = await wrapped.execute(
          'c',
          { path: '/tmp/review.json', content: '{}' } as never,
          undefined,
          undefined,
          {} as never,
        )
        const text = (result.content as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
        expect(text).toContain('/tmp/review.json')
        expect(text).not.toContain(sessionDir)
      } finally {
        await rm(sessionDir, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(lacksInodeAnchoring)('an owner still sees the virtual /tmp path in the receipt', async () => {
    const sessionId = uniqueSessionId('owner-receipt')
    const sessionDir = `${SESSION_TMP_ROOT}/${sessionId}`
    const wrapped = wrapBuiltinToolDefinition(fakeWriteEchoingPath(), {
      agentDir: '/agent',
      sessionId,
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    try {
      const result = await wrapped.execute(
        'c',
        { path: '/tmp/review.json', content: '{}' } as never,
        undefined,
        undefined,
        {} as never,
      )
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      expect(text).toContain('/tmp/review.json')
    } finally {
      await rm(sessionDir, { recursive: true, force: true })
    }
  })
})

describe('setupSession integration: builtin pi tools route through customTools when hooks are present', () => {
  // End-to-end seam test for the bug PR #283 thought it had closed: PR #283's
  // managedConfig guard only fires when the active `edit` tool is the wrapped
  // one — but pi 0.67.3 ignores `tools:` for implementation, so without
  // routing wrapped builtins through `customTools`, the active `edit` is
  // pi's internal builtin and the guard never sees the call. This test
  // builds a real AgentSession via `createSession` and asserts that the
  // active `edit` came from `sdk` (customTools override) rather than
  // `builtin`. If the override wiring in `setupSession` is removed, this
  // test fails immediately.
  let agentDir: string
  let prevCwd: string
  let prevFireworks: string | undefined

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-wiring-'))
    prevCwd = process.cwd()
    prevFireworks = process.env.FIREWORKS_API_KEY
    process.env.FIREWORKS_API_KEY = 'fw_test'
    process.chdir(agentDir)
    await Bun.write(
      path.join(agentDir, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } }),
    )
    const { reloadConfig } = await import('@/config/config')
    reloadConfig(agentDir)
  })

  afterEach(async () => {
    if (prevFireworks === undefined) delete process.env.FIREWORKS_API_KEY
    else process.env.FIREWORKS_API_KEY = prevFireworks
    const { __resetConfigForTesting } = await import('@/config/config')
    const { invalidateProviderAuthCache } = await import('./auth')
    __resetConfigForTesting()
    invalidateProviderAuthCache()
    process.chdir(prevCwd)
    await rm(agentDir, { recursive: true, force: true })
  })

  test('with tool.before hooks present, the active `edit` is the customTools override (sourceInfo.source === "sdk"), not pi\'s builtin', async () => {
    const { createSession } = await import('./index')
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': () => undefined,
    })
    const registry: PluginRegistry = emptyRegistry()

    const session = await createSession({
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
    })

    const allTools = session.getAllTools()
    const editInfo = allTools.find((t) => t.name === 'edit')
    expect(editInfo).toBeDefined()
    expect(editInfo?.sourceInfo.source).toBe('sdk')

    session.dispose()
  })

  test('subagent sessions share their top-level subagent /tmp, not the spawning session /tmp, until disposed', async () => {
    const { createSessionWithDispose } = await import('./index')
    const { sessionTmpDir } = await import('@/sandbox')
    const hooks = createHookBus()
    const registry: PluginRegistry = emptyRegistry()

    const reviewer = await createSessionWithDispose({
      origin: { kind: 'subagent', subagent: 'reviewer', parentSessionId: 'tmp-scope-channel' },
      plugins: { registry, hooks, sessionId: 'tmp-scope-reviewer', agentDir },
    })
    const explorer = await createSessionWithDispose({
      origin: { kind: 'subagent', subagent: 'explorer', parentSessionId: 'tmp-scope-reviewer' },
      plugins: { registry, hooks, sessionId: 'tmp-scope-explorer', agentDir },
    })

    expect(sessionTmpDir('tmp-scope-explorer')).toBe(sessionTmpDir('tmp-scope-reviewer'))
    expect(sessionTmpDir('tmp-scope-reviewer')).not.toBe(sessionTmpDir('tmp-scope-channel'))
    for (const created of [explorer, reviewer]) {
      created.session.dispose()
      await created.dispose()
    }
    expect(sessionTmpDir('tmp-scope-explorer')).not.toBe(sessionTmpDir('tmp-scope-reviewer'))
  })

  test('even without tool hooks, the active `edit` is the typeclaw customTools override (sandbox/guards are hook-independent)', async () => {
    // Pi's documented SDK behavior is that custom definitions replace the
    // enabled builtin with the same name. `noTools: "builtin"` prevents raw
    // default tools; the wrapped definitions remain active through `tools:`.
    const { createSession } = await import('./index')

    const session = await createSession({})

    const allTools = session.getAllTools()
    const editInfo = allTools.find((t) => t.name === 'edit')
    expect(editInfo).toBeDefined()
    expect(editInfo?.sourceInfo.source).toBe('sdk')

    session.dispose()
  })

  test('security: subagent declaring [edit] only must NOT also activate read/bash/write/grep/find/ls, even though all 7 wrapped builtins ride in customTools', async () => {
    // Security boundary: all 7 wrapped builtins are always in `customTools`, so a
    // subagent could over-broaden if the active set were "registry ∪ customTools".
    // The explicit `tools:` allowlist controls both builtin and custom names
    // (sdk.d.ts:35-47), and is set to exactly the declared subagent refs.
    // A read-only memory-logger subagent declaring `[edit]` must therefore
    // expose ONLY `edit` — a silent widening to bash/write would be a
    // privilege-escalation regression (QA finding, PR #290).
    const { createSession } = await import('./index')
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': () => undefined,
    })
    const registry: PluginRegistry = emptyRegistry()

    const session = await createSession({
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
      pluginSubagent: { pluginName: 'p1', toolRefs: [{ __builtinTool: 'edit' }], toolNamePrefix: 's' },
    })

    expect(session.getActiveToolNames().sort()).toEqual(['edit'])

    session.dispose()
  })

  test('subagent declaring [read, grep] gets exactly those two active, with the wrapped (sdk) implementations', async () => {
    const { createSession } = await import('./index')
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': () => undefined,
    })
    const registry: PluginRegistry = emptyRegistry()

    const session = await createSession({
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
      pluginSubagent: {
        pluginName: 'p1',
        toolRefs: [{ __builtinTool: 'read' }, { __builtinTool: 'grep' }],
        toolNamePrefix: 's',
      },
    })

    expect(session.getActiveToolNames().sort()).toEqual(['grep', 'read'])
    const all = session.getAllTools()
    const readInfo = all.find((t) => t.name === 'read')
    const grepInfo = all.find((t) => t.name === 'grep')
    expect(readInfo?.sourceInfo.source).toBe('sdk')
    expect(grepInfo?.sourceInfo.source).toBe('sdk')

    session.dispose()
  })

  test('TUI session (no options.tools) activates all seven typeclaw-owned pi builtins (read/bash/edit/write/grep/find/ls)', async () => {
    // A non-subagent session leaves `options.tools` unset, so the active set is
    // the full builtin override list (all 7) union the typeclaw customSystemTools.
    // grep/find/ls are TypeClaw-owned tools we deliberately expose — unlike a
    // subagent, a TUI session is not narrowed. With `noTools: "builtin"` and an
    // explicit `tools:` allowlist, this list is the exact active set (no reliance
    // on pi's default-plus-all-custom activation).
    const { createSession } = await import('./index')
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': () => undefined,
    })
    const registry: PluginRegistry = emptyRegistry()

    const session = await createSession({
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
    })

    const active = new Set(session.getActiveToolNames())
    expect(active.has('read')).toBe(true)
    expect(active.has('bash')).toBe(true)
    expect(active.has('edit')).toBe(true)
    expect(active.has('write')).toBe(true)
    expect(active.has('grep')).toBe(true)
    expect(active.has('find')).toBe(true)
    expect(active.has('ls')).toBe(true)

    session.dispose()
  })
})

describe('loop guard integration', () => {
  test('appends a soft-warning suffix to a plugin tool result on the third identical call', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        return { content: [{ type: 'text', text: `q=${args.q}` }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-plugin-1',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    const r1 = (await wrapped.execute('c1', { q: 'a' }, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
    }
    expect(r1.content.length).toBe(1)

    await wrapped.execute('c2', { q: 'a' }, undefined, undefined, {} as never)
    const r3 = (await wrapped.execute('c3', { q: 'a' }, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
    }
    expect(r3.content.length).toBe(2)
    expect(r3.content[1]?.text).toContain('loop-guard')
    expect(r3.content[1]?.text).toContain('search')
  })

  test('refuses the fifth identical plugin tool call with an error result and never invokes the tool', async () => {
    const calls: number[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        calls.push(1)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-plugin-2',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
    }
    expect(calls.length).toBe(4)
    const blocked = (await wrapped.execute('c5', { q: 'a' }, undefined, undefined, {} as never)) as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(calls.length).toBe(4)
    expect(blocked.isError).toBe(true)
    expect(blocked.content[0]?.text).toContain('loop-guard')
  })

  test('forgetSharedLoopGuardTool clears the shared streak for the named tool so the next call passes', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        return { content: [{ type: 'text', text: `q=${args.q}` }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-forget-1',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
    }
    forgetSharedLoopGuardTool('loop-forget-1', 'search')
    const after = (await wrapped.execute('c5', { q: 'a' }, undefined, undefined, {} as never)) as {
      isError?: boolean
    }
    expect(after.isError).toBeUndefined()
  })

  test('resets the streak when the args change between plugin tool calls', async () => {
    const calls: string[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        calls.push(args.q)
        return { content: [{ type: 'text', text: args.q }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-plugin-3',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    await wrapped.execute('c1', { q: 'a' }, undefined, undefined, {} as never)
    await wrapped.execute('c2', { q: 'a' }, undefined, undefined, {} as never)
    await wrapped.execute('c3', { q: 'b' }, undefined, undefined, {} as never)
    await wrapped.execute('c4', { q: 'b' }, undefined, undefined, {} as never)
    const r5 = (await wrapped.execute('c5', { q: 'b' }, undefined, undefined, {} as never)) as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(r5.isError).not.toBe(true)
    expect(r5.content[1]?.text).toContain('loop-guard')
    expect(calls).toEqual(['a', 'a', 'b', 'b', 'b'])
  })

  test('throws on the fifth identical system tool call so the engine surfaces the loop error', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'web_fetch',
      label: 'web_fetch',
      description: '',
      parameters: Type.Object({ url: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [{ type: 'text', text: 'ok' }], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'loop-sys-1', hooks: createHookBus() })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { url: 'https://example.com' }, undefined, undefined, {} as never)
    }
    expect(calls.length).toBe(4)
    await expect(
      wrapped.execute('c5', { url: 'https://example.com' }, undefined, undefined, {} as never),
    ).rejects.toThrow(/loop-guard/)
    expect(calls.length).toBe(4)
  })

  test('keeps loop streaks isolated between sessions', async () => {
    const calls: { session: string }[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })

    const make = (sessionId: string) => {
      return wrapPluginTool(tool, {
        pluginName: 'p1',
        toolName: 'search',
        agentDir: '/agent',
        sessionId,
        logger: noopLogger,
        hooks: createHookBus(),
      })
    }

    const wA = make('loop-iso-A')
    const wB = make('loop-iso-B')

    for (let i = 0; i < 4; i++) {
      await wA.execute(`a${i}`, {}, undefined, undefined, {} as never)
      calls.push({ session: 'A' })
    }
    const aBlocked = (await wA.execute('a5', {}, undefined, undefined, {} as never)) as { isError?: boolean }
    expect(aBlocked.isError).toBe(true)

    const bFirst = (await wB.execute('b1', {}, undefined, undefined, {} as never)) as { isError?: boolean }
    expect(bFirst.isError).not.toBe(true)
  })

  test('aborts the turn when a plugin tool is blocked so the model cannot keep retrying', async () => {
    let aborts = 0
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-abort-plugin',
      logger: noopLogger,
      hooks: createHookBus(),
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
    }
    expect(aborts).toBe(0)
    await wrapped.execute('c5', { q: 'a' }, undefined, undefined, {} as never)
    expect(aborts).toBe(1)
  })

  test('aborts the turn when a system tool is blocked, alongside the thrown loop error', async () => {
    let aborts = 0
    const tool = definePiTool({
      name: 'web_fetch',
      label: 'web_fetch',
      description: '',
      parameters: Type.Object({ url: Type.String() }),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, {
      agentDir: '/agent',
      sessionId: 'loop-abort-sys',
      hooks: createHookBus(),
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { url: 'https://example.com' }, undefined, undefined, {} as never)
    }
    expect(aborts).toBe(0)
    await expect(
      wrapped.execute('c5', { url: 'https://example.com' }, undefined, undefined, {} as never),
    ).rejects.toThrow(/loop-guard/)
    expect(aborts).toBe(1)
  })

  test('logs a diagnostic warning identifying the session and reason when the loop guard fires an abort', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tool = defineTool({
        description: '',
        parameters: z.object({ q: z.string() }),
        async execute() {
          return { content: [{ type: 'text', text: 'ok' }] }
        },
      })
      const wrapped = wrapPluginTool(tool, {
        pluginName: 'p1',
        toolName: 'search',
        agentDir: '/agent',
        sessionId: 'loop-abort-diagnostic-session',
        logger: noopLogger,
        hooks: createHookBus(),
        getAbort: () => () => {},
      })

      for (let i = 0; i < 4; i++) {
        await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
      }
      expect(warnSpy).not.toHaveBeenCalled()

      await wrapped.execute('c5', { q: 'a' }, undefined, undefined, {} as never)

      const abortLog = warnSpy.mock.calls.map((call) => String(call[0])).find((m) => m.includes('site=loop_guard'))
      expect(abortLog).toBeDefined()
      expect(abortLog).toContain('session=loop-abort-diagnostic-session')
      expect(abortLog).toContain('reason=loop_guard:block')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('does not log an abort warning when no abort function is wired', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tool = defineTool({
        description: '',
        parameters: z.object({ q: z.string() }),
        async execute() {
          return { content: [{ type: 'text', text: 'ok' }] }
        },
      })
      const wrapped = wrapPluginTool(tool, {
        pluginName: 'p1',
        toolName: 'search',
        agentDir: '/agent',
        sessionId: 'loop-abort-no-getabort',
        logger: noopLogger,
        hooks: createHookBus(),
      })

      for (let i = 0; i < 4; i++) {
        await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
      }
      await wrapped.execute('c5', { q: 'a' }, undefined, undefined, {} as never)

      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('site=loop_guard'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('does not abort while calls are still under the block threshold', async () => {
    let aborts = 0
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-abort-warn-only',
      logger: noopLogger,
      hooks: createHookBus(),
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
    }
    expect(aborts).toBe(0)
  })

  test('does not abort a same-turn fan-out of paged reads against one file', async () => {
    let calls = 0
    let aborts = 0
    const tool = definePiTool({
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute() {
        calls += 1
        return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined }
      },
    })
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir: '/agent',
      sessionId: 'read-fan-out',
      hooks: createHookBus(),
      getLoopGuardTurn: () => 1,
      getAbort: () => () => {
        aborts += 1
      },
    })

    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((offset, index) =>
        wrapped.execute(
          `c${index}`,
          { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset, limit: 100 },
          undefined,
          undefined,
          {} as never,
        ),
      ),
    )

    expect(calls).toBe(6)
    expect(aborts).toBe(0)
  })

  test('advances offset-only reads from observed truncation output', async () => {
    let turnId = 0
    let aborts = 0
    const tool = definePiTool({
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }),
      async execute() {
        return {
          content: [{ type: 'text' as const, text: 'page' }],
          details: { truncation: { outputLines: 100 } },
        }
      },
    })
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir: '/agent',
      sessionId: 'read-offset-only',
      hooks: createHookBus(),
      getLoopGuardTurn: () => turnId,
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let offset = 1; offset <= 701; offset += 100) {
      turnId += 1
      await wrapped.execute(
        `c${turnId}`,
        { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset },
        undefined,
        undefined,
        {} as never,
      )
    }
    expect(aborts).toBe(0)
  })

  test('advances a short final read page only by the lines actually returned', async () => {
    let turnId = 0
    let aborts = 0
    const tool = definePiTool({
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String(), offset: Type.Number(), limit: Type.Number() }),
      async execute(_callId, params) {
        const lineCount = params.offset === 101 ? 50 : params.limit
        const lines = Array.from({ length: lineCount }, (_, i) => `line ${i}`).join('\n')
        return {
          content: [
            {
              type: 'text' as const,
              text: params.offset === 1 ? `${lines}\n\n[50 more lines in file. Use offset=101 to continue.]` : lines,
            },
          ],
          details: undefined,
        }
      },
    })
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir: '/agent',
      sessionId: 'read-short-page',
      hooks: createHookBus(),
      getLoopGuardTurn: () => turnId,
      getAbort: () => () => {
        aborts += 1
      },
    })
    const read = async (offset: number) => {
      turnId += 1
      return wrapped.execute(
        `c${turnId}`,
        { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset, limit: 100 },
        undefined,
        undefined,
        {} as never,
      )
    }

    await read(1)
    await read(101)
    for (const offset of [201, 202, 203, 204]) await read(offset)
    await expect(read(205)).rejects.toThrow(/loop-guard/)
    expect(aborts).toBe(1)
  })

  test('does not advance reads whose truncation observed zero file lines', async () => {
    let turnId = 0
    let aborts = 0
    const tool = definePiTool({
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String(), offset: Type.Number(), limit: Type.Number() }),
      async execute() {
        return {
          content: [{ type: 'text' as const, text: 'line exceeds byte limit; use bash' }],
          details: { truncation: { outputLines: 0 } },
        }
      },
    })
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir: '/agent',
      sessionId: 'read-zero-lines',
      hooks: createHookBus(),
      getLoopGuardTurn: () => turnId,
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let offset = 1; offset <= 5; offset++) {
      turnId += 1
      await wrapped.execute(
        `c${turnId}`,
        { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset, limit: 1 },
        undefined,
        undefined,
        {} as never,
      )
    }
    turnId += 1
    await expect(
      wrapped.execute(
        'c6',
        { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset: 6, limit: 1 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/loop-guard/)
    expect(aborts).toBe(1)
  })

  test('does not infer paginated progress from image read results', async () => {
    let turnId = 0
    let aborts = 0
    const tool = definePiTool({
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String(), offset: Type.Number(), limit: Type.Number() }),
      async execute() {
        return {
          content: [
            { type: 'text' as const, text: 'Read image file [image/png]' },
            { type: 'image' as const, data: 'AA==', mimeType: 'image/png' },
          ],
          details: undefined,
        }
      },
    })
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir: '/agent',
      sessionId: 'read-image',
      hooks: createHookBus(),
      getLoopGuardTurn: () => turnId,
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let offset = 1; offset <= 5; offset++) {
      turnId += 1
      await wrapped.execute(
        `c${turnId}`,
        { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset, limit: 1 },
        undefined,
        undefined,
        {} as never,
      )
    }
    turnId += 1
    await expect(
      wrapped.execute(
        'c6',
        { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset: 6, limit: 1 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/loop-guard/)
    expect(aborts).toBe(1)
  })

  test('does not infer textual progress from an omitted image fallback', async () => {
    let turnId = 0
    let aborts = 0
    const tool = definePiTool({
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String(), offset: Type.Number(), limit: Type.Number() }),
      async execute() {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]',
            },
          ],
          details: undefined,
        }
      },
    })
    const wrapped = wrapBuiltinToolDefinition(tool, {
      agentDir: '/agent',
      sessionId: 'read-image-fallback',
      hooks: createHookBus(),
      getLoopGuardTurn: () => turnId,
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let offset = 1; offset <= 5; offset++) {
      turnId += 1
      await wrapped.execute(
        `c${turnId}`,
        { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset, limit: 1 },
        undefined,
        undefined,
        {} as never,
      )
    }
    turnId += 1
    await expect(
      wrapped.execute(
        'c6',
        { path: path.join(process.cwd(), 'src/agent/plugin-tools.ts'), offset: 6, limit: 1 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/loop-guard/)
    expect(aborts).toBe(1)
  })

  // A subagent_output poll that returns status:'running' is a still-pending
  // wait, not a loop. The wrapper retracts it from the guard so round-robin
  // fan-out polling never false-blocks (the production incident).
  function makeSubagentOutputTool(statusFor: (taskId: string, callIdx: number) => 'running' | 'completed') {
    let callIdx = 0
    const calls: string[] = []
    const tool = definePiTool({
      name: 'subagent_output',
      label: 'subagent_output',
      description: '',
      parameters: Type.Object({ task_id: Type.String() }),
      async execute(_id, params: { task_id: string }) {
        const status = statusFor(params.task_id, callIdx++)
        calls.push(params.task_id)
        return {
          content: [{ type: 'text' as const, text: status }],
          details: { ok: true, status, taskId: params.task_id, subagent: 'scout', durationMs: 1 },
        }
      },
    })
    return { tool, calls }
  }

  test('never blocks subagent_output polls that keep returning running', async () => {
    const { tool, calls } = makeSubagentOutputTool(() => 'running')
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'poll-running', hooks: createHookBus() })

    // Replay the incident shape: 6 task_ids polled round-robin for many waves.
    const tasks = ['bg_1', 'bg_2', 'bg_3', 'bg_4', 'bg_5', 'bg_6']
    for (let wave = 0; wave < 12; wave++) {
      for (const task_id of tasks) {
        const r = (await wrapped.execute(`c${wave}`, { task_id }, undefined, undefined, {} as never)) as {
          isError?: boolean
        }
        expect(r.isError).not.toBe(true)
      }
    }
    expect(calls.length).toBe(72)
  })

  test('still blocks a subagent_output poll that repeats a terminal result', async () => {
    // Every poll of bg_done returns 'completed' (terminal). The 5th poll is the
    // block boundary: it executes once (deferred) to reveal 'completed', is
    // marked terminal-known, then throws. From the 6th on the signature is known
    // terminal, so the block is enforced PRE-execute and the tool stops running.
    const { tool, calls } = makeSubagentOutputTool(() => 'completed')
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'poll-terminal', hooks: createHookBus() })

    // Four polls execute and each marks the signature terminal-known.
    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { task_id: 'bg_done' }, undefined, undefined, {} as never)
    }
    expect(calls.length).toBe(4)
    // The 5th poll hits the hard-block threshold; because the signature is
    // already terminal-known the block is NOT deferred — it fires pre-execute,
    // so the tool does not run and never will for further identical polls.
    for (let i = 5; i < 10; i++) {
      await expect(wrapped.execute(`c${i}`, { task_id: 'bg_done' }, undefined, undefined, {} as never)).rejects.toThrow(
        /loop-guard/,
      )
    }
    expect(calls.length).toBe(4)
  })

  test('repeated back-to-back polls of one still-running task never block', async () => {
    // A tight loop on ONE task_id (consecutive detector territory). Every poll
    // returns 'running', so every one is retracted — the streak never sticks and
    // the boundary poll past the hard-block threshold still executes.
    const { tool, calls } = makeSubagentOutputTool(() => 'running')
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'poll-consecutive', hooks: createHookBus() })

    for (let i = 0; i < 10; i++) {
      const r = (await wrapped.execute(`c${i}`, { task_id: 'bg_b' }, undefined, undefined, {} as never)) as {
        isError?: boolean
      }
      expect(r.isError).not.toBe(true)
    }
    expect(calls.length).toBe(10)
  })
})
