import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, type CallToolResult, type ListToolsRequest } from '@modelcontextprotocol/sdk/types.js'

import type { McpServer } from '@/config/config'
import { withToolOomPriorityArgv } from '@/container/tool-oom-priority'
import type { ToolFileOperands } from '@/plugin'
import { resolveSecret } from '@/secrets/resolve'

export type McpToolInfo = {
  name: string
  description: string
  inputSchema: unknown
  // Declared by MCP servers via the tool's `_meta['x-file-operands']`; consumed
  // by the mcp_call dispatcher so the file-operand scanner honors tool-authored
  // nonFile operand paths instead of rejecting free-text args that look path-shaped.
  fileOperands?: ToolFileOperands
}

// The wire key an MCP server sets on a tool's `_meta` to declare its operands.
// `_meta` is an arbitrary record in the MCP spec and survives the server → wire
// → client round-trip through the official SDK unchanged.
export const MCP_FILE_OPERANDS_META_KEY = 'x-file-operands'

// The SDK defaults each request to 60s; typeclaw boot should fail fast enough
// that one dead MCP server does not make the agent feel hung at startup.
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000

export type McpConnection = {
  name: string
  listTools(): Promise<McpToolInfo[]>
  // Cache-only view of the last successful listTools(). Returns undefined until
  // the catalog has been fetched once, and never performs I/O — the pre-execution
  // file-operand preflight reads target metadata through this so resolving it can
  // never spawn a stdio server or open an HTTP session before the security hooks run.
  peekTools(): McpToolInfo[] | undefined
  refresh(): Promise<McpToolInfo[]>
  callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

const FILE_OPERAND_CATEGORIES = ['input', 'output', 'create', 'destructive', 'nonFile'] as const

// Wire metadata is server-controlled, so it is parsed rather than cast: a
// declaration like `{ nonFile: 'query' }` would otherwise reach the scanner as a
// string and have `.includes()` grant a substring-wide exemption. Any malformed
// recognized category discards the WHOLE declaration (fail closed) instead of
// honoring the well-formed remainder, so a partially-corrupt payload can never
// silently widen the scanned surface.
export function parseDeclaredFileOperands(meta: Record<string, unknown> | undefined): ToolFileOperands | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const declared = meta[MCP_FILE_OPERANDS_META_KEY]
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return undefined

  const parsed: Record<string, readonly string[]> = {}
  const claimed = new Set<string>()
  for (const category of FILE_OPERAND_CATEGORIES) {
    const value = (declared as Record<string, unknown>)[category]
    if (value === undefined) continue
    if (!Array.isArray(value)) return undefined
    if (!value.every((entry) => typeof entry === 'string' && entry.trim() !== '')) return undefined
    // One operand path cannot be two things at once, and the combinations are
    // not merely redundant but contradictory: `nonFile` claims a value is never
    // dereferenced locally while `input` claims it is a real file to snapshot.
    // Resolving such a conflict by precedence would make the effective policy
    // depend on category order, so reject the declaration instead.
    for (const operandPath of value as string[]) {
      if (claimed.has(operandPath)) return undefined
      claimed.add(operandPath)
    }
    parsed[category] = [...(value as string[])]
  }
  return Object.keys(parsed).length === 0 ? undefined : (parsed as ToolFileOperands)
}

export type McpSdkClient = {
  listTools(
    params?: ListToolsRequest['params'],
    options?: RequestOptions,
  ): Promise<{
    tools: { name: string; description?: string; inputSchema: unknown; _meta?: Record<string, unknown> }[]
    nextCursor?: string
  }>
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: typeof CallToolResultSchema,
    options?: RequestOptions,
  ): Promise<CallToolResult>
  close(): Promise<void>
}

type McpConnectClient = McpSdkClient & {
  connect(transport: Transport, options?: RequestOptions): Promise<void>
}

export async function connectMcpServer(
  server: McpServer,
  opts: {
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
    connectTimeoutMs?: number
    client?: McpConnectClient
    transport?: Transport
    authProvider?: OAuthClientProvider
  },
): Promise<McpConnection> {
  const requestTimeout = server.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS
  const connectTimeout = opts.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS
  const client = opts.client ?? new Client({ name: 'typeclaw', version: '0.17.0' }, { capabilities: {} })
  const transport = opts.transport ?? createTransport(server, opts.env, opts.authProvider)

  try {
    await withConnectDeadline(connectTimeout, opts.signal, (signal) =>
      client.connect(transport, { signal, timeout: requestTimeout }),
    )
  } catch (cause) {
    try {
      await client.close()
    } catch (closeCause) {
      attachCloseCause(cause, closeCause)
    }
    throw cause
  }

  return createMcpConnection(
    server.name,
    {
      listTools: (params, options) => client.listTools(params, options),
      async callTool(params, _resultSchema, options) {
        const result = await client.callTool(params, CallToolResultSchema, options)
        return CallToolResultSchema.parse(result)
      },
      close: () => client.close(),
    },
    { timeoutMs: requestTimeout },
  )
}

export function createMcpConnection(
  name: string,
  client: McpSdkClient,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): McpConnection {
  let cachedTools: McpToolInfo[] | undefined
  const timeout = opts.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS

  async function fetchTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout,
        signal: opts.signal,
      })
      tools.push(
        ...result.tools.map((tool) => {
          const fileOperands = parseDeclaredFileOperands(tool._meta)
          return {
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            ...(fileOperands === undefined ? {} : { fileOperands }),
          }
        }),
      )
      cursor = result.nextCursor
    } while (cursor !== undefined)

    cachedTools = tools
    return cachedTools
  }

  return {
    name,
    async listTools(): Promise<McpToolInfo[]> {
      if (cachedTools !== undefined) return cachedTools
      return fetchTools()
    },
    peekTools(): McpToolInfo[] | undefined {
      return cachedTools
    },
    // fetchTools never reads the cache, so the previous catalog is kept until a
    // replacement is in hand: a failed or in-flight refresh must not blank out the
    // metadata that peekTools() serves to the pre-execution operand preflight.
    refresh(): Promise<McpToolInfo[]> {
      return fetchTools()
    },
    callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
      return client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
        timeout,
        signal: opts.signal,
      })
    },
    close(): Promise<void> {
      return client.close()
    },
  }
}

export function createTransport(
  server: McpServer,
  env: NodeJS.ProcessEnv,
  authProvider?: OAuthClientProvider,
): Transport {
  if (server.command) {
    const [command = server.command, ...args] = withToolOomPriorityArgv([server.command, ...server.args])
    return new StdioClientTransport({ command, args, env: resolveServerEnv(server, env) })
  }
  const url = new URL(requiredUrl(server))
  return authProvider === undefined
    ? new StreamableHTTPClientTransport(url)
    : new StreamableHTTPClientTransport(url, { authProvider })
}

async function withConnectDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('MCP connect timeout')), timeoutMs)
  const merged = mergeSignals(parentSignal, deadline.signal)
  const operation = fn(merged.signal)
  let removeAbortListener = (): void => {}
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(merged.signal.reason)
    removeAbortListener = (): void => merged.signal.removeEventListener('abort', onAbort)
    if (merged.signal.aborted) onAbort()
    else merged.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, abort])
  } finally {
    clearTimeout(timer)
    removeAbortListener()
    if (merged.signal.aborted) void operation.catch(() => undefined)
    merged.dispose()
  }
}

function mergeSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (activeSignals.length === 0) return { signal: new AbortController().signal, dispose() {} }
  if (activeSignals.length === 1) return { signal: activeSignals[0]!, dispose() {} }

  const controller = new AbortController()
  const listeners: (() => void)[] = []
  for (const signal of activeSignals) {
    const abort = (): void => controller.abort(signal.reason)
    if (signal.aborted) {
      abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', abort))
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const remove of listeners) remove()
    },
  }
}

function attachCloseCause(cause: unknown, closeCause: unknown): void {
  if (!(cause instanceof Error)) return
  const error = cause as Error & { cause?: unknown }
  error.cause = { original: error.cause, close: closeCause }
}

// A stdio MCP server is a child process the agent spawns, so it must NOT
// inherit the full parent environment: that env holds unrelated credentials
// (OPENAI_API_KEY, GH_TOKEN, channel tokens) and inheriting them leaks every
// secret to every server. We start from a minimal allowlist needed to spawn and
// run a process (PATH/HOME to launch npx/bunx, locale + temp for correctness),
// then overlay only the secrets the server explicitly declares. This mirrors
// the bwrap sandbox's `--clearenv` + DEFAULT_SANDBOX_ENV leak guard.
const BASE_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'] as const

export function resolveServerEnv(server: Pick<McpServer, 'env'>, env: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv: Record<string, string> = {}
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = env[key]
    if (value !== undefined) childEnv[key] = value
  }

  for (const [key, secret] of Object.entries(server.env)) {
    const explicitKeyValue = env[key]
    const resolved =
      explicitKeyValue !== undefined && explicitKeyValue !== '' ? explicitKeyValue : resolveSecret(secret, key, env)
    if (resolved !== undefined) childEnv[key] = resolved
  }

  return childEnv
}

function requiredUrl(server: McpServer): string {
  if (server.url !== undefined) return server.url
  throw new Error(`MCP server "${server.name}" is missing url`)
}
