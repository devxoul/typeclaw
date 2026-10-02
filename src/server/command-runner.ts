import { delimiter, join } from 'node:path'

import {
  createSessionWithDispose,
  renderTurnTimeAnchor,
  type CreateSessionOptions,
  type CreateSessionResult,
  type SessionOrigin,
} from '@/agent'
import { applyTurnThinkingLevel } from '@/agent/attention-escalation'
import { promptWithSameRefRetryOnly } from '@/agent/retry-same-ref'
import type { ChannelRouter } from '@/channels/router'
import { readOomEvents, toolOomNote } from '@/container/oom-events'
import { withToolOomPriorityArgv } from '@/container/tool-oom-priority'
import type { McpManager } from '@/mcp'
import type { PermissionService } from '@/permissions'
import type {
  CommandExecResult,
  ContainerCommand,
  ContainerCommandContext,
  EitherCommand,
  EitherCommandContext,
  PluginLogger,
  RegisteredCommand,
  SpawnSubagentOptions,
} from '@/plugin'
import type { PluginRuntime } from '@/run/plugin-runtime'
import type { SessionFactory } from '@/sessions'

export type CommandSpawnSubagent = (name: string, payload?: unknown, options?: SpawnSubagentOptions) => Promise<void>

export type CommandOutbound = {
  stdout: (callId: string, chunk: Uint8Array) => void
  stderr: (callId: string, chunk: Uint8Array) => void
  exit: (callId: string, code: number) => void
  error: (callId: string, message: string) => void
}

export type CommandRunnerOptions = {
  pluginRuntime: PluginRuntime
  permissions: PermissionService
  spawnSubagent: CommandSpawnSubagent
  agentDir: string
  runtimeVersion: string | undefined
  containerName: string | undefined
  outbound: CommandOutbound
  // Hands a persisted SessionManager to every prompt session spawned from a
  // plugin command's `ctx.prompt`. Required so the session writes its JSONL
  // (and therefore its `message.usage`) under sessions/, which is what
  // `typeclaw usage` and the `bundled-plugins/backup` plugin scan. Without
  // this every plugin-command LLM call would fall through to
  // `SessionManager.inMemory()` and never persist usage — see
  // `runPromptForCommand` below.
  sessionFactory: SessionFactory
  // Channel router threaded into every `ctx.prompt` session so the model can
  // call `channel_send`. Without this, `buildChannelTools` (src/agent/index.ts)
  // receives `undefined` and emits no channel tools — a plugin command or cron
  // handler told to post to a channel then has no tool to do it and falls back
  // to flailing bash loops. The cron `prompt` path already passes
  // `channelManager.router` via `createSessionForCron`; this is the matching
  // wire for the handler/command path.
  channelRouter: ChannelRouter | undefined
  mcpManager?: McpManager
}

type CommandHandle = {
  callId: string
  abortController: AbortController
  stdinQueue: StdinQueue
  ownerKey: WsOwnerKey
  done: Promise<void>
}

export type WsOwnerKey = object | null

export type CommandRunner = {
  start: (
    msg: {
      callId: string
      name: string
      args: unknown
      isolated?: boolean
      parentOrigin?: SessionOrigin
    },
    ownerKey: WsOwnerKey,
  ) => void
  feedStdin: (callId: string, chunkBase64: string) => void
  endStdin: (callId: string) => void
  abort: (callId: string, reason: string) => void
  abortForOwner: (ownerKey: WsOwnerKey) => void
  inFlightCount: () => number
}

export function createCommandRunner(opts: CommandRunnerOptions): CommandRunner {
  const inFlight = new Map<string, CommandHandle>()

  function lookup(name: string): RegisteredCommand | undefined {
    const snapshot = opts.pluginRuntime.get()
    return snapshot.registry.commands.find((c) => c.commandName === name)
  }

  function start(
    msg: { callId: string; name: string; args: unknown; isolated?: boolean; parentOrigin?: SessionOrigin },
    ownerKey: WsOwnerKey,
  ): void {
    const { callId, name, args } = msg
    if (inFlight.has(callId)) {
      opts.outbound.error(callId, `callId "${callId}" is already in flight`)
      return
    }

    const registered = lookup(name)
    if (registered === undefined) {
      opts.outbound.error(callId, `command "${name}" is not registered`)
      opts.outbound.exit(callId, 1)
      return
    }

    const command = registered.command
    if (command.surface === 'host') {
      opts.outbound.error(callId, `command "${name}" is host-only; cannot run inside the container`)
      opts.outbound.exit(callId, 1)
      return
    }

    const argsParse = parseArgs(command, args)
    if (!argsParse.ok) {
      opts.outbound.error(callId, argsParse.message)
      opts.outbound.exit(callId, 2)
      return
    }

    const abortController = new AbortController()
    const stdinQueue = createStdinQueue(abortController.signal)

    // Subagent-shaped (NOT TUI) so the prompt session this command may spawn
    // via ctx.prompt resolves to the `slim` system prompt mode, saving ~2000
    // tokens per LLM call.
    //
    // spawnedByOrigin carries the caller's provenance. By default we stamp a
    // synthetic TUI origin (host CLI operator → owner role). When the caller
    // forwarded a parentOrigin (e.g. a cron exec job reading
    // TYPECLAW_PARENT_ORIGIN_JSON), we use that verbatim so permission
    // resolution chases through to the cron's scheduledByRole instead of
    // silently elevating to owner.
    const syntheticTuiOrigin: SessionOrigin = { kind: 'tui', sessionId: `command:${name}:${callId}` }
    const spawnedByOrigin: SessionOrigin = msg.parentOrigin ?? syntheticTuiOrigin
    const origin: SessionOrigin = {
      kind: 'subagent',
      subagent: `plugin-command:${name}`,
      parentSessionId: syntheticTuiOrigin.sessionId,
      spawnedByOrigin,
    }

    const stdoutSink = makeWritable((chunk) => opts.outbound.stdout(callId, chunk))
    const stderrSink = makeWritable((chunk) => opts.outbound.stderr(callId, chunk))

    const logger: PluginLogger = {
      info: (m) => writeLine(stderrSink, `[command:${registered.pluginName}] info: ${m}`),
      warn: (m) => writeLine(stderrSink, `[command:${registered.pluginName}] warn: ${m}`),
      error: (m) => writeLine(stderrSink, `[command:${registered.pluginName}] error: ${m}`),
    }

    // Emit the isolated-fallback warning through the per-command stderr
    // stream so the invoking CLI sees it. The plugin's boot-time logger
    // (registered.logger) writes to container logs which the caller never
    // reads.
    if (msg.isolated === true) {
      logger.warn(
        `command "${name}" requested isolated=true; this build does not yet implement subprocess isolation, falling back to in-process`,
      )
    }

    const sharedCtx = {
      name: registered.pluginName,
      version: registered.command.surface === 'container' ? undefined : undefined,
      agentDir: opts.agentDir,
      logger,
      signal: abortController.signal,
      stdin: stdinQueue.readable,
      stdout: stdoutSink,
      stderr: stderrSink,
    }

    const ctxPromise = (async (): Promise<number> => {
      if (command.surface === 'container') {
        const ctx: ContainerCommandContext = {
          ...sharedCtx,
          permissions: opts.permissions,
          origin,
          prompt: (text) =>
            runPromptForCommand({
              text,
              origin,
              runtime: opts.pluginRuntime,
              agentDir: opts.agentDir,
              runtimeVersion: opts.runtimeVersion,
              containerName: opts.containerName,
              permissions: opts.permissions,
              signal: abortController.signal,
              sessionFactory: opts.sessionFactory,
              channelRouter: opts.channelRouter,
              ...(opts.mcpManager !== undefined ? { mcpManager: opts.mcpManager } : {}),
            }),
          subagent: (subName, payload) =>
            opts.spawnSubagent(subName, payload, {
              spawnedByOrigin: origin,
              parentSessionId: syntheticTuiOrigin.sessionId,
            }),
          exec: (strings, ...values) =>
            runExecForCommand(strings, values, { cwd: opts.agentDir, signal: abortController.signal }),
        }
        return (command as ContainerCommand<unknown>).run(ctx, argsParse.value)
      }
      const ctx: EitherCommandContext = sharedCtx
      return (command as EitherCommand<unknown>).run(ctx, argsParse.value)
    })()

    // Logger lines are queued, not written inline, so they can still be in
    // flight when `run` returns. `command_exit` is terminal for the call —
    // `src/server/index.ts` drops the callId's websocket route as it sends it —
    // so any frame emitted after exit is discarded. Drain the sink first on
    // BOTH paths, or the last lines a command logs never reach the caller.
    const done = ctxPromise
      .then(async (code) => {
        await drainWrites(stderrSink)
        if (typeof code !== 'number' || !Number.isFinite(code)) {
          opts.outbound.error(callId, `command "${name}" returned a non-numeric exit code`)
          opts.outbound.exit(callId, 1)
          return
        }
        opts.outbound.exit(callId, code)
      })
      .catch(async (err: unknown) => {
        await drainWrites(stderrSink)
        const detail = err instanceof Error ? err.message : String(err)
        opts.outbound.error(callId, detail)
        opts.outbound.exit(callId, 1)
      })
      .finally(() => {
        inFlight.delete(callId)
      })

    inFlight.set(callId, { callId, abortController, stdinQueue, ownerKey, done })
  }

  function feedStdin(callId: string, chunkBase64: string): void {
    const handle = inFlight.get(callId)
    if (handle === undefined) return
    try {
      const bytes = Uint8Array.from(atob(chunkBase64), (c) => c.charCodeAt(0))
      handle.stdinQueue.push(bytes)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      opts.outbound.error(callId, `command_stdin decode failed: ${detail}`)
    }
  }

  function endStdin(callId: string): void {
    const handle = inFlight.get(callId)
    if (handle === undefined) return
    handle.stdinQueue.close()
  }

  function abort(callId: string, reason: string): void {
    const handle = inFlight.get(callId)
    if (handle === undefined) return
    handle.abortController.abort(reason)
    handle.stdinQueue.close()
  }

  function abortForOwner(ownerKey: WsOwnerKey): void {
    for (const handle of inFlight.values()) {
      if (handle.ownerKey === ownerKey) {
        handle.abortController.abort('ws closed')
        handle.stdinQueue.close()
      }
    }
  }

  function inFlightCount(): number {
    return inFlight.size
  }

  return { start, feedStdin, endStdin, abort, abortForOwner, inFlightCount }
}

type ArgsParseResult = { ok: true; value: unknown } | { ok: false; message: string }

function parseArgs(command: { args?: { safeParse?: (input: unknown) => unknown } }, args: unknown): ArgsParseResult {
  if (command.args === undefined) return { ok: true, value: undefined }
  const safe = (
    command.args as {
      safeParse: (input: unknown) => {
        success: boolean
        data?: unknown
        error?: { issues: { path: (string | number)[]; message: string }[] }
      }
    }
  ).safeParse(args)
  if (safe.success === true) return { ok: true, value: safe.data }
  const issues = safe.error?.issues ?? []
  const message =
    issues.length === 0
      ? 'args validation failed'
      : issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`).join('; ')
  return { ok: false, message }
}

type StdinQueue = {
  readable: ReadableStream<Uint8Array>
  push: (chunk: Uint8Array) => void
  close: () => void
}

function createStdinQueue(signal: AbortSignal): StdinQueue {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  const buffered: Uint8Array[] = []

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const chunk of buffered) c.enqueue(chunk)
      buffered.length = 0
      if (closed) c.close()
      signal.addEventListener('abort', () => {
        if (!closed) {
          closed = true
          try {
            c.close()
          } catch {
            // already closed
          }
        }
      })
    },
  })

  function push(chunk: Uint8Array): void {
    if (closed) return
    if (controller === null) {
      buffered.push(chunk)
      return
    }
    controller.enqueue(chunk)
  }

  function close(): void {
    if (closed) return
    closed = true
    if (controller === null) return
    try {
      controller.close()
    } catch {
      // already closed
    }
  }

  return { readable, push, close }
}

function makeWritable(onChunk: (chunk: Uint8Array) => void): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      onChunk(chunk)
    },
  })
}

// One sink backs every logger line for a command, and `getWriter()` throws
// while another writer holds the lock. Releasing in a `.then()` returns the
// lock a microtask too late: the next `logger.*` call runs synchronously from
// `ctx.run` and finds the stream still locked, so the line is lost and the
// throw escapes into the command. Chain each line onto the previous write so
// only one writer exists at a time, and release in `finally` so a rejected
// write can't strand the lock permanently.
//
// Keyed per stream rather than held for the run because the same sink is also
// handed to plugins as `ctx.stderr`; the lock has to be dropped between lines
// or a plugin writing to it directly would be locked out.
//
// Scope of the `.catch()` on the stored tail: it keeps ONE failed write from
// rejecting the promise every later line chains onto, and it keeps the lock
// released. It does NOT restore delivery — per the Streams standard a sink
// that throws leaves the stream errored, and every subsequent `write()`
// rejects with that same error. Recovering delivery would mean replacing the
// sink, which is out of scope here.
const writeTails = new WeakMap<WritableStream<Uint8Array>, Promise<void>>()

function writeLine(stream: WritableStream<Uint8Array>, line: string): void {
  const bytes = new TextEncoder().encode(`${line}\n`)
  const tail = (writeTails.get(stream) ?? Promise.resolve()).then(async () => {
    const writer = stream.getWriter()
    try {
      await writer.write(bytes)
    } finally {
      writer.releaseLock()
    }
  })
  writeTails.set(
    stream,
    tail.catch(() => {}),
  )
}

// Settles once every line queued on `stream` so far has been handed to the
// sink. The stored tail already absorbs rejections, so this never throws.
function drainWrites(stream: WritableStream<Uint8Array>): Promise<void> {
  return writeTails.get(stream) ?? Promise.resolve()
}

export type CreateSessionForCommand = (options: CreateSessionOptions) => Promise<CreateSessionResult>

export async function runPromptForCommand(args: {
  text: string
  origin: SessionOrigin
  runtime: PluginRuntime
  agentDir: string
  runtimeVersion: string | undefined
  containerName: string | undefined
  permissions: PermissionService
  signal: AbortSignal
  // Persisted-session source. Each call gets a fresh SessionManager so the
  // resulting JSONL is its own file under sessions/ — the same shape the
  // cron `prompt` path uses in src/run/index.ts. Passing in-memory here
  // regresses `typeclaw usage` (see CommandRunnerOptions.sessionFactory).
  sessionFactory: SessionFactory
  // See CommandRunnerOptions.channelRouter. Threaded to createSessionWithDispose
  // so the spawned session exposes `channel_send`.
  channelRouter?: ChannelRouter
  mcpManager?: McpManager
  // Test seam for the agent-session boundary. Production passes the real
  // `createSessionWithDispose`; tests inject a fake to verify wiring
  // (specifically: the sessionManager handed off must be persisted, not
  // in-memory) without booting the full session stack.
  _createSession?: CreateSessionForCommand
}): Promise<string> {
  // Mirrors src/agent/multimodal/look-at.ts: spawn a session, prompt, capture
  // the final assistant text, dispose. Unlike look-at we want the FULL agent
  // toolset (no `tools: []` / `customTools: []` overrides) so the model can
  // call channel_send, web_search, etc. The system prompt is composed from
  // the agent folder's IDENTITY/SOUL/MEMORY files via the default resource
  // loader (no `systemPromptOverride`).
  const snapshot = args.runtime.get()
  const sessionId = resolveSessionIdForOrigin(args.origin)
  const create = args._createSession ?? createSessionWithDispose
  const { session, dispose } = await create({
    origin: args.origin,
    permissions: args.permissions,
    sessionManager: args.sessionFactory.createPersisted(),
    plugins: {
      registry: snapshot.registry,
      hooks: snapshot.hooks,
      sessionId,
      agentDir: args.agentDir,
    },
    ...(args.channelRouter !== undefined ? { channelRouter: args.channelRouter } : {}),
    ...(args.mcpManager !== undefined ? { mcpManager: args.mcpManager } : {}),
    ...(args.runtimeVersion !== undefined ? { runtimeVersion: args.runtimeVersion } : {}),
    ...(args.containerName !== undefined ? { containerName: args.containerName } : {}),
  })
  const detachAbort = bindSignalToSession(args.signal, session)
  // Mirror the other turn drivers (TUI/channel/cron/subagent): fire
  // session.turn.start with a retrievalContext so vector memory is injected
  // per-turn into command and handler prompts too.
  const turnEvent = { sessionId, agentDir: args.agentDir, origin: args.origin }
  const retrievalContext = { results: '' }
  try {
    await snapshot.hooks.runSessionTurnStart({ ...turnEvent, userPrompt: args.text, retrievalContext })
    const turnText =
      retrievalContext.results.length > 0
        ? `${renderTurnTimeAnchor()}\n\n${args.text}\n\n${retrievalContext.results}`
        : `${renderTurnTimeAnchor()}\n\n${args.text}`
    applyTurnThinkingLevel(session, args.text, session.thinkingLevel)
    try {
      await promptWithSameRefRetryOnly(session, turnText)
    } finally {
      await snapshot.hooks.runSessionTurnEnd(turnEvent)
    }
    return session.getLastAssistantText() ?? ''
  } finally {
    detachAbort()
    session.dispose()
    await dispose()
  }
}

// Propagate abort into the live session: without this, abort flips the
// signal but session.prompt() keeps waiting on the provider until the LLM
// call completes naturally — which for a long generation means the whole
// command, its dispose() chain, and command_exit hang for minutes.
// Returns a detach function the caller must invoke (in finally) so the
// listener doesn't leak after a clean prompt completion.
export function bindSignalToSession(signal: AbortSignal, session: { abort: () => Promise<void> }): () => void {
  const onAbort = (): void => {
    void session.abort()
  }
  if (signal.aborted) {
    onAbort()
    return () => {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

function resolveSessionIdForOrigin(origin: SessionOrigin): string {
  if (origin.kind === 'tui') return origin.sessionId
  if (origin.kind === 'subagent') return origin.parentSessionId
  return crypto.randomUUID()
}

// Grace period before escalating SIGTERM to SIGKILL on aborted ctx.exec.
// Long enough for an interactive child to flush stdout and exit cleanly;
// short enough that a wedged shell wrapper doesn't keep command_exit
// hanging visibly past user expectations.
const EXEC_ABORT_GRACE_MS = 5_000

// Prepend the agent folder's node_modules/.bin to PATH so a documented
// bare-command call like `ctx.exec`agent-webex auth status`` resolves.
// Without it the call exits 127: the container PATH excludes
// node_modules/.bin, so locally-installed package bins (the agent-* CLI
// surface) don't resolve while globals (git, bunx) do. Prepend matches
// npm/bun run-script semantics (local bins shadow globals); ctx.exec is a
// trusted plugin-author surface, so shadowing is acceptable. Per-spawn env
// (never mutate process.env); skip the trailing delimiter on empty PATH so
// no empty segment implies a current-directory lookup.
function buildExecEnv(cwd: string): Record<string, string | undefined> {
  const localBin = join(cwd, 'node_modules', '.bin')
  const currentPath = process.env.PATH
  return {
    ...process.env,
    PATH: currentPath ? `${localBin}${delimiter}${currentPath}` : localBin,
  }
}

export async function runExecForCommand(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  opts: { cwd: string; signal: AbortSignal },
): Promise<CommandExecResult> {
  // Construct the shell command by interpolating template values verbatim.
  // The command author is trusted (their plugin runs in-process anyway), so
  // we do not add shell-quoting; if they need it, they format the string
  // themselves.
  let cmd = strings[0] ?? ''
  for (let i = 0; i < values.length; i++) {
    cmd += String(values[i])
    cmd += strings[i + 1] ?? ''
  }

  // Spawn detached so the child is the leader of its own process group.
  // We kill via -pid (the process group) on abort, which targets sh AND
  // every grandchild it spawned. Without detached:true, Bun's signal hook
  // sends SIGTERM only to sh; orphaned grandchildren (e.g. a long-running
  // server started by sh -c "node server.js") would keep stdout pipes open
  // for minutes, masking the abort. See src/agent/tools/ddg.ts for the
  // same pattern applied to curl-impersonate wrappers.
  const oomBefore = readOomEvents()
  const proc = Bun.spawn({
    cmd: withToolOomPriorityArgv(['sh', '-c', cmd]),
    cwd: opts.cwd,
    env: buildExecEnv(opts.cwd),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })

  let escalationTimer: ReturnType<typeof setTimeout> | null = null
  const onAbort = (): void => {
    killProcessGroup(proc.pid, 'SIGTERM')
    escalationTimer = setTimeout(() => {
      killProcessGroup(proc.pid, 'SIGKILL')
    }, EXEC_ABORT_GRACE_MS)
  }
  if (opts.signal.aborted) {
    onAbort()
  } else {
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as unknown as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as unknown as ReadableStream<Uint8Array>).text(),
    ])
    const note = toolOomNote(oomBefore, exitCode, 'plugin exec', { log: (line) => console.warn(line) })
    return { stdout: stdoutText, stderr: note === null ? stderrText : `${stderrText}${note}\n`, exitCode }
  } finally {
    opts.signal.removeEventListener('abort', onAbort)
    if (escalationTimer !== null) clearTimeout(escalationTimer)
  }
}

// Kills the leader-pgid'd process and every member of its group. Falls
// back to the single-pid kill if the pgid kill fails (e.g. the process
// already exited and the negative pid is invalid). Errors during cleanup
// are swallowed; the only consumer is the abort path where the process is
// almost certainly gone by the time we observe the error.
function killProcessGroup(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      process.kill(pid, sig)
    } catch {
      // Already exited; nothing to clean up.
    }
  }
}
