import { constants, createWriteStream, lstatSync, type Stats } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readdir, realpath, rm, stat, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  checkPrivateSurfaceReadGuard,
  createPrivateSurfaceReadIdentityVerifier,
  type PrivateSurfaceIdentityVerifier,
} from '@/bundled-plugins/security/policies/private-surface-read'
import type { ToolFileOperands, ToolLogger, ToolProvenance, ToolResult } from '@/plugin'
import { CANONICAL_AGENT_SECRET_FILES } from '@/sandbox/canonical-secrets'
import type { HiddenPaths } from '@/sandbox/hidden-paths'

import { TOOLS_WITHOUT_LOCAL_FILE_OPERANDS } from './tools-without-local-file-operands'

export { TOOLS_WITHOUT_LOCAL_FILE_OPERANDS }

type Rewrite = { original: string; pinned: string }
type FileTarget = { get(): string; original: string; set(value: string): void; uri: boolean }
type OutputTarget = { target: FileTarget; mode: 'reserved' | 'exclusive-create' }
type VerifiedInput = {
  target: FileTarget
  original: string
  resolved: string
  dev: number
  ino: number
  size: number
  kind: 'file' | 'directory'
}

export const TOOL_INPUT_MAX_BYTES = {
  // read supports offset/limit browsing, so permit large source files while
  // bounding the immutable whole-object snapshot.
  read: 64 * 1024 * 1024,
  // Keep local images on the same budget as look_at's bounded URL fetch.
  look_at: 20 * 1024 * 1024,
  // Preserve common channel upload sizes without allowing unbounded copies.
  channel_upload: 100 * 1024 * 1024,
} as const

export const TOOL_INPUT_MAX_COUNT = {
  read: 1,
  look_at: 16,
  channel_upload: 32,
} as const

export const PINNED_SNAPSHOT_GLOBAL_MAX_BYTES = TOOL_INPUT_MAX_BYTES.channel_upload
export const PINNED_SNAPSHOT_GLOBAL_MAX_COUNT = TOOL_INPUT_MAX_COUNT.channel_upload
export const PINNED_SNAPSHOT_MAX_WAITERS = 32
const TOOL_OUTPUT_MAX_COUNT = 32
const TREE_SNAPSHOT_MAX_ENTRIES = 4096
const AGENT_ROOT_SNAPSHOT_EXCLUDED_DIRS = new Set(['.git', '.gitstore', 'node_modules'])

export const TOOL_INPUT_TEMP_PREFIX = 'typeclaw-tool-input-'

export type PinnedToolFiles = {
  restoreResult(result: ToolResult): ToolResult
  cleanup(): Promise<void>
}

type PinnedOutputTarget = PinnedToolFiles & {
  rollback(): Promise<void>
}

// Test-only seam: pauses between budget acquisition and source open/stream so a
// test can grow a file post-authorization deterministically, without racing the
// scheduler. Production never passes hooks.
export type EnforceAndPinToolFilesHooks = {
  afterBudgetAcquire?(): void | Promise<void>
  pinnedSnapshotBudgetForTests?: ReturnType<typeof createPinnedSnapshotBudgetForTests>
}

export async function enforceAndPinToolFiles(
  options: {
    tool: string
    args: Record<string, unknown>
    agentDir: string
    tempRoot?: string
    genericInputs?: boolean
    fileOperands?: ToolFileOperands
    hidden?: HiddenPaths
    logger?: Pick<ToolLogger, 'warn'>
    signal?: AbortSignal
    toolProvenance?: ToolProvenance
  },
  hooks: EnforceAndPinToolFilesHooks = {},
): Promise<PinnedToolFiles> {
  if (options.signal?.aborted === true) throw abortError(options.signal)
  const maxCount = maxInputCount(options.tool)
  const targets = fileTargets(
    options.tool,
    options.args,
    maxCount,
    options.genericInputs === true,
    options.fileOperands,
    options.agentDir,
    options.logger,
    options.toolProvenance,
  )
  enforceCanonicalSecretDenial(options)
  const outputs = outputTargets(options.tool, options.args, TOOL_OUTPUT_MAX_COUNT, options.fileOperands)
  if (targets.length === 0) return outputs.length === 0 ? noPinnedFiles() : await pinOutputTargets(options, outputs)

  let dir: string | undefined
  const rewrites: Rewrite[] = []
  const omittedLinks: { root: string; count: number; names: string[] }[] = []
  const verified: VerifiedInput[] = []
  const maxBytes = maxInputBytes(options.tool)
  const identityOptions = {
    tool: options.tool,
    agentDir: options.agentDir,
    hidden: options.hidden ?? { dirs: [], files: [] },
  }
  const initialIdentityVerifier = createPrivateSurfaceReadIdentityVerifier(identityOptions)
  let lease: BudgetLease | undefined
  try {
    let declaredBytes = 0
    for (const target of targets) {
      const original = target.get()
      const absolute = path.resolve(options.agentDir, original)
      const resolved = await realpath(absolute).catch((error) => {
        if (isNotFoundError(error)) throw new Error(`tool input did not exist while being authorized: ${original}`)
        throw error
      })
      enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
      const inspected = await stat(resolved)
      const kind = inspected.isFile()
        ? 'file'
        : inspected.isDirectory() && isTreeInputTool(options.tool)
          ? 'directory'
          : undefined
      if (kind === undefined) throw new Error(`tool input is not a supported regular file or directory: ${original}`)
      if (kind === 'file') {
        assertRegularInputFile(inspected, original)
        enforceInputIdentityDenial(initialIdentityVerifier, inspected)
      }
      if (kind === 'file' && inspected.size > maxBytes) throw inputTooLarge(original, inspected.size, maxBytes)
      declaredBytes += kind === 'file' ? inspected.size : 0
      if (declaredBytes > maxBytes) throw aggregateInputTooLarge(declaredBytes, maxBytes)
      verified.push({ target, original, resolved, dev: inspected.dev, ino: inspected.ino, size: inspected.size, kind })
    }

    lease = await (hooks.pinnedSnapshotBudgetForTests ?? pinnedSnapshotBudget).acquire(
      declaredBytes,
      verified.length,
      options.signal,
    )
    await hooks.afterBudgetAcquire?.()
    const openedIdentityVerifier = createPrivateSurfaceReadIdentityVerifier(identityOptions)

    dir = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), TOOL_INPUT_TEMP_PREFIX))
    let copiedBytes = 0
    for (let i = 0; i < verified.length; i++) {
      const input = verified[i] as VerifiedInput
      const pinned = path.join(dir, String(i))
      if (input.kind === 'file') {
        const source = await openInput(input.resolved, input.original)
        try {
          const opened = await source.stat()
          assertRegularInputFile(opened, input.original)
          if (opened.dev !== input.dev || opened.ino !== input.ino) {
            throw new Error(`tool input changed while waiting for snapshot capacity: ${input.original}`)
          }
          enforceInputIdentityDenial(openedIdentityVerifier, opened)
          copiedBytes += await streamSnapshot(
            source,
            pinned,
            input.original,
            maxBytes,
            copiedBytes,
            lease,
            verified.length,
            options.signal,
          )
          await chmod(pinned, 0o400)
        } finally {
          await source.close()
        }
      } else {
        const snapshot = await snapshotDirectoryTree({
          source: input,
          destination: pinned,
          agentDir: options.agentDir,
          tool: options.tool,
          maxBytes,
          previouslyCopied: copiedBytes,
          lease,
          operandCount: verified.length,
          hidden: options.hidden,
          signal: options.signal,
        })
        copiedBytes += snapshot.copied
        if (snapshot.omittedLinks.count > 0) {
          omittedLinks.push({ root: input.original, ...snapshot.omittedLinks })
        }
      }
      const executionValue = input.target.uri ? pathToFileURL(pinned).href : pinned
      input.target.set(executionValue)
      rewrites.push({ original: input.target.original, pinned: executionValue })
    }
    if (!lease.resize(copiedBytes, verified.length)) throw processBudgetGrowthExceeded(copiedBytes)
  } catch (error) {
    try {
      if (dir !== undefined) await removePinnedSnapshot(dir)
    } finally {
      lease?.release()
    }
    throw error
  }

  if (dir === undefined) return noPinnedFiles()

  let cleaned = false

  const inputPinned: PinnedToolFiles = {
    restoreResult(result) {
      let restored = result
      for (const rewrite of rewrites) restored = replaceResultPath(restored, rewrite)
      return appendSnapshotOmissions(restored, omittedLinks)
    },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      try {
        await removePinnedSnapshot(dir)
      } finally {
        lease?.release()
      }
    },
  }
  if (outputs.length === 0) return inputPinned

  try {
    const outputPinned = await pinOutputTargets(options, outputs)
    return composePinnedFiles([inputPinned, outputPinned])
  } catch (error) {
    await cleanupPinnedFilesReverse([inputPinned], true)
    throw error
  }
}

async function removePinnedSnapshot(root: string): Promise<void> {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    await chmod(directory, 0o700)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name))
    }
  }
  await rm(root, { recursive: true, force: true })
}

// Canonical credential denial is the one check no operand declaration can waive:
// `fileOperands` is destructured away rather than spread through, so a tool (or a
// remote MCP server) declaring `nonFile` on an operand cannot make `secrets.json`,
// `.env`, or `~/.ssh` pass here. Role-derived private directories stay declarable
// and are enforced separately by the private-surface-read guard.
export function enforceCanonicalSecretDenial(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  toolProvenance?: ToolProvenance
}): void {
  const { tool, args, agentDir, toolProvenance } = options
  const blocked = checkPrivateSurfaceReadGuard({
    tool,
    args,
    agentDir,
    hidden: { dirs: [], files: [] },
    ...(toolProvenance !== undefined ? { toolProvenance } : {}),
  })
  if (blocked !== undefined) throw new Error(`blocked: ${blocked.reason}`)
}

function fileTargets(
  tool: string,
  args: Record<string, unknown>,
  maxCount: number,
  genericInputs: boolean,
  fileOperands: ToolFileOperands | undefined,
  agentDir: string,
  logger: Pick<ToolLogger, 'warn'> | undefined,
  toolProvenance: ToolProvenance | undefined,
): FileTarget[] {
  if (isOutputTool(tool)) return []
  if (toolProvenance === 'first-party' && TOOLS_WITHOUT_LOCAL_FILE_OPERANDS.has(tool)) return []
  if (tool === 'read' && typeof args.path === 'string') return [propertyTarget(args, 'path')]
  if (isTreeInputTool(tool)) {
    if (typeof args.path !== 'string') args.path = '.'
    return [propertyTarget(args, 'path')]
  }
  const targets: FileTarget[] = []
  const addPath = (value: unknown): void => {
    if (!isRecord(value) || typeof value.path !== 'string') return
    targets.push(propertyTarget(value, 'path'))
    if (targets.length > maxCount) throw inputCountTooLarge(targets.length, maxCount)
  }
  if (tool === 'look_at') {
    if (Array.isArray(args.images)) for (const image of args.images) addPath(image)
    return targets
  }
  // The only file operand for these tools is `attachments[].path`; `text` is free-form
  // prose (dates like "7/16", URLs, fractions) that must never reach the generic scan,
  // which rejects any value carrying a `/` or `\`. Return early even without attachments
  // so a text-only message is never misread as a path. Attachment pinning is unchanged.
  if (tool === 'channel_send' || tool === 'channel_reply') {
    if (Array.isArray(args.attachments)) for (const attachment of args.attachments) addPath(attachment)
    return targets
  }
  if (tool === 'channel_fetch_attachment') return targets
  // post_github_review has no local file operands: `comments[].path` are remote
  // GitHub diff anchors and the `body` fields are markdown. Scanning them as
  // generic operands either pins a real-repo anchor into a /tmp file:// path that
  // leaks into the posted review, or throws "ambiguous local file operand".
  if (tool === 'post_github_review') return targets
  if (genericInputs) collectGenericFileTargets(tool, args, targets, maxCount, fileOperands, agentDir, logger)
  return targets
}

// Exact tool + operand-path pairs for first-party PROSE operands (message
// bodies, prompts, queries, regex/CSS/jq strings) that are never a local file.
// This table is for tools that ALSO have a real file operand and so cannot be
// whole-tool exempt via TOOLS_WITHOUT_LOCAL_FILE_OPERANDS: web_fetch pins its
// `url` (non-file URLs are exempt while file: URIs still snapshot) and treats
// `query`/`selector`/`pattern` as prose. Pure control-token tools (reload, grant_role, stream_snapshot,
// channel_edit, …) live in that set instead, so they are absent here.
//
// Scoped by full operand path, NOT key name — this is the fail-closed invariant:
// an undeclared plugin/MCP reader that reuses `content`/`prompt`/`query` must
// still hit the scan and cannot inherit an exemption from a common key name.
// Plugin/MCP tools declare their own via `fileOperands.nonFile` (survives the
// runtime `__plugin_*` name prefix, which a static table here would not).
const NON_FILE_OPERANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  skip_response: new Set(['reason']),
  web_search: new Set(['query']),
  web_fetch: new Set(['url', 'query', 'selector', 'pattern']),
  todo_write: new Set(['todos.content']),
}

function isKnownNonFileOperand(tool: string, operandPath: string): boolean {
  return NON_FILE_OPERANDS[tool]?.has(operandPath) === true
}

// Detection trims first: a leading-whitespace `  file://…` is still a file
// reference to any consumer that trims before parsing, so it must be pinned or
// denied, never passed through untouched. The original untrimmed string is
// preserved on the target for result restoration; the trimmed URI is what gets
// normalized and snapshotted.
function isFileUri(value: string): boolean {
  return value.trim().toLocaleLowerCase().startsWith('file:')
}

function propertyTarget(object: Record<string, unknown>, key: string): FileTarget {
  const raw = object[key] as string
  return {
    get: () => normalizeFileReference(object[key] as string),
    original: raw,
    set: (value) => {
      object[key] = value
    },
    uri: isFileUri(raw),
  }
}

function arrayTarget(array: unknown[], index: number): FileTarget {
  const raw = array[index] as string
  return {
    get: () => normalizeFileReference(array[index] as string),
    original: raw,
    set: (value) => {
      array[index] = value
    },
    uri: isFileUri(raw),
  }
}

function outputTargets(
  tool: string,
  args: Record<string, unknown>,
  maxCount: number,
  operands: ToolFileOperands | undefined,
): OutputTarget[] {
  if (isOutputTool(tool)) {
    return typeof args.path === 'string' ? [{ target: propertyTarget(args, 'path'), mode: 'reserved' }] : []
  }
  const outputPaths = new Set(operands?.output ?? [])
  const createPaths = new Set(operands?.create ?? [])
  for (const operandPath of outputPaths) {
    if (createPaths.has(operandPath)) {
      throw new Error(`file operand ${JSON.stringify(operandPath)} cannot be both output and create`)
    }
  }
  const targets: OutputTarget[] = []
  collectDeclaredOutputTargets(args, targets, maxCount, outputPaths, 'reserved')
  collectDeclaredOutputTargets(args, targets, maxCount, createPaths, 'exclusive-create')
  return targets
}

function collectDeclaredOutputTargets(
  value: unknown,
  out: OutputTarget[],
  maxCount: number,
  declared: ReadonlySet<string>,
  mode: OutputTarget['mode'],
  parentPath = '',
): void {
  if (Array.isArray(value)) {
    const declaredOutput = declared.has(parentPath)
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string') {
        if (declaredOutput) {
          out.push({ target: arrayTarget(value, index), mode })
          if (out.length > maxCount) throw outputCountTooLarge(out.length, maxCount)
        }
        continue
      }
      collectDeclaredOutputTargets(item, out, maxCount, declared, mode, parentPath)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [childKey, item] of Object.entries(value)) {
    const operandPath = parentPath === '' ? childKey : `${parentPath}.${childKey}`
    if (typeof item === 'string' && declared.has(operandPath)) {
      out.push({ target: propertyTarget(value, childKey), mode })
      if (out.length > maxCount) throw outputCountTooLarge(out.length, maxCount)
      continue
    }
    collectDeclaredOutputTargets(item, out, maxCount, declared, mode, operandPath)
  }
}

function collectGenericFileTargets(
  tool: string,
  value: unknown,
  out: FileTarget[],
  maxCount: number,
  operands: ToolFileOperands | undefined,
  agentDir: string,
  logger: Pick<ToolLogger, 'warn'> | undefined,
  parentPath = '',
): void {
  if (Array.isArray(value)) {
    const declaredInput = operands?.input?.includes(parentPath) === true
    const nonInput =
      operands?.output?.includes(parentPath) === true ||
      operands?.create?.includes(parentPath) === true ||
      operands?.destructive?.includes(parentPath) === true
    const key = parentPath.split('.').at(-1) ?? parentPath
    // Precedence: declared input pins; declared output/destructive is not an
    // input; a known non-file operand is opaque (skipped, even a file: URI);
    // otherwise an explicit file: URI pins and an undeclared path-shaped value
    // fails closed. Both the static first-party table and a plugin's declared
    // `fileOperands.nonFile` are tool+operand-path scoped, so an unknown tool
    // never inherits an exemption from a common key name.
    const declaredNonFile = !declaredInput && operands?.nonFile?.includes(parentPath) === true
    const knownNonFile = !declaredInput && isKnownNonFileOperand(tool, parentPath)
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string') {
        if (declaredNonFile || (knownNonFile && !isFileUri(item))) continue
        if (!nonInput && (isFileUri(item) || declaredInput)) {
          out.push(arrayTarget(value, index))
          if (out.length > maxCount) throw inputCountTooLarge(out.length, maxCount)
        } else if (!nonInput && isAmbiguousUndeclaredLocalOperand(item, agentDir, key)) {
          warnForUndeclaredExistingLocalOperand(logger, tool, parentPath, item, agentDir)
          throw new Error(
            `ambiguous local file operand at key ${JSON.stringify(parentPath)}; the tool author must declare fileOperands.input or the caller must use a file: URI`,
          )
        }
        continue
      }
      collectGenericFileTargets(tool, item, out, maxCount, operands, agentDir, logger, parentPath)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [childKey, item] of Object.entries(value)) {
    const operandPath = parentPath === '' ? childKey : `${parentPath}.${childKey}`
    if (typeof item === 'string') {
      const declaredInput = operands?.input?.includes(operandPath) === true
      const nonInput =
        operands?.output?.includes(operandPath) === true ||
        operands?.create?.includes(operandPath) === true ||
        operands?.destructive?.includes(operandPath) === true
      // Declared input wins; a known non-file operand (web_search.query,
      // web_fetch.selector, a plugin's declared `fileOperands.nonFile`, …) is
      // opaque and skipped even when its value is a file: URI; everything else
      // falls to the file:/heuristic scan below. Scoped by exact tool+operand-
      // path so an undeclared plugin reader using `content`/`prompt` still
      // fails closed.
      const declaredNonFile = !declaredInput && operands?.nonFile?.includes(operandPath) === true
      const knownNonFile = !declaredInput && isKnownNonFileOperand(tool, operandPath)
      if (declaredNonFile || (knownNonFile && !isFileUri(item))) continue
      if (!nonInput && (isFileUri(item) || declaredInput)) {
        out.push(propertyTarget(value, childKey))
        if (out.length > maxCount) throw inputCountTooLarge(out.length, maxCount)
        continue
      }
      if (!nonInput && isAmbiguousUndeclaredLocalOperand(item, agentDir, childKey)) {
        warnForUndeclaredExistingLocalOperand(logger, tool, operandPath, item, agentDir)
        throw new Error(
          `ambiguous local file operand at key ${JSON.stringify(operandPath)}; the tool author must declare fileOperands.input or the caller must use a file: URI`,
        )
      }
    }
    collectGenericFileTargets(tool, item, out, maxCount, operands, agentDir, logger, operandPath)
  }
}

function noPinnedFiles(): PinnedToolFiles {
  return { restoreResult: (result) => result, cleanup: async () => {} }
}

function composePinnedFiles(pinned: readonly PinnedToolFiles[]): PinnedToolFiles {
  return {
    restoreResult(result) {
      return pinned.reduceRight((restored, entry) => entry.restoreResult(restored), result)
    },
    async cleanup() {
      await cleanupPinnedFilesReverse(pinned)
    },
  }
}

async function cleanupPinnedFilesReverse(pinned: readonly PinnedToolFiles[], suppressErrors = false): Promise<void> {
  let firstError: unknown
  for (let index = pinned.length - 1; index >= 0; index -= 1) {
    try {
      await pinned[index]?.cleanup()
    } catch (error) {
      firstError ??= error
    }
  }
  if (!suppressErrors && firstError !== undefined) throw firstError
}

async function openInput(absolute: string, original: string): Promise<FileHandle> {
  try {
    return await open(absolute, constants.O_RDONLY)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`tool input did not exist while being authorized: ${original}`)
    }
    throw error
  }
}

async function pinOutputTargets(
  options: {
    tool: string
    args: Record<string, unknown>
    agentDir: string
    signal?: AbortSignal
  },
  targets: OutputTarget[],
): Promise<PinnedToolFiles> {
  const pinned: PinnedOutputTarget[] = []
  try {
    for (const target of targets) pinned.push(await pinOutputTarget(options, target))
  } catch (error) {
    for (let index = pinned.length - 1; index >= 0; index -= 1) {
      await pinned[index]?.rollback().catch(() => {})
    }
    throw error
  }
  return composePinnedFiles(pinned)
}

async function pinOutputTarget(
  options: {
    tool: string
    args: Record<string, unknown>
    agentDir: string
    signal?: AbortSignal
  },
  output: OutputTarget,
): Promise<PinnedOutputTarget> {
  const { target } = output
  if (options.signal?.aborted === true) throw abortError(options.signal)
  const original = target.get()
  const absolute = path.resolve(options.agentDir, original)
  enforceCanonicalSecretDenial({ tool: options.tool, args: { path: absolute }, agentDir: options.agentDir })
  if (process.platform !== 'linux') {
    throw new Error('write/edit output authorization requires Linux inode anchoring; refusing an unanchored path')
  }
  const parent = path.dirname(absolute)
  const basename = path.basename(absolute)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | noFollow).catch((error) => {
    if (isNotFoundError(error))
      throw new Error(`write/edit parent directory does not exist for anchored output: ${parent}`)
    throw error
  })
  let targetHandle: FileHandle | undefined
  let targetIdentity: { dev: number; ino: number } | undefined
  let created = false
  let anchored: string | undefined
  try {
    const fdRoot = '/proc/self/fd'
    const resolvedParent = await realpath(`${fdRoot}/${directory.fd}`)
    enforceCanonicalSecretDenial({
      tool: options.tool,
      args: { path: path.join(resolvedParent, basename) },
      agentDir: options.agentDir,
    })
    const anchoredOutput = `${fdRoot}/${directory.fd}/${basename}`
    anchored = anchoredOutput
    if (output.mode === 'exclusive-create') {
      const existing = await open(anchoredOutput, constants.O_RDONLY | noFollow).catch((error) => {
        if (isNotFoundError(error)) return undefined
        throw error
      })
      if (existing !== undefined) {
        await existing.close()
        throw new Error(`write/edit output must not already exist: ${original}`)
      }
      target.set(anchoredOutput)
      let cleaned = false
      const finalize = async (verifyCreated: boolean): Promise<void> => {
        if (cleaned) return
        cleaned = true
        let verifyError: unknown
        if (verifyCreated) {
          try {
            await verifyExclusiveCreatedOutput({
              anchored: anchoredOutput,
              original,
              noFollow,
              tool: options.tool,
              agentDir: options.agentDir,
            })
          } catch (error) {
            verifyError = error
          }
        }
        const closeError = await directory.close().catch((error) => error)
        if (verifyError !== undefined) throw verifyError
        if (closeError !== undefined) throw closeError
      }
      return {
        restoreResult(result) {
          return replaceResultPath(result, { original, pinned: anchoredOutput })
        },
        async cleanup() {
          await finalize(true)
        },
        async rollback() {
          await finalize(false)
        },
      }
    }
    targetHandle = await open(anchoredOutput, constants.O_RDWR | noFollow).catch((error) => {
      if (isNotFoundError(error)) return undefined
      throw error
    })
    if (targetHandle === undefined) {
      targetHandle = await open(
        anchoredOutput,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o666,
      ).catch((error) => {
        if (error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ELOOP')) {
          throw new Error(`write/edit output destination changed while being authorized: ${original}`)
        }
        throw error
      })
      created = true
    }
    const inspected = await targetHandle.stat()
    if (!inspected.isFile() || inspected.nlink !== 1) {
      throw new Error(`write/edit output is not a single-link regular file: ${original}`)
    }
    const authorizedIdentity = { dev: inspected.dev, ino: inspected.ino }
    targetIdentity = authorizedIdentity
    const resolved = await realpath(`${fdRoot}/${targetHandle.fd}`)
    enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
    const executionPath = `${fdRoot}/${targetHandle.fd}`
    target.set(executionPath)
    let cleaned = false
    const finalize = async (removeCreated: boolean): Promise<void> => {
      if (cleaned) return
      cleaned = true
      let verifyError: unknown
      try {
        await verifyOutputEntry({
          anchored: anchoredOutput,
          original,
          identity: authorizedIdentity,
          noFollow,
          remove: removeCreated && created,
          tool: options.tool,
          agentDir: options.agentDir,
        })
      } catch (error) {
        verifyError = error
      }
      const outcomes = await Promise.allSettled([targetHandle?.close(), directory.close()])
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (verifyError !== undefined) throw verifyError
      if (failed?.status === 'rejected') throw failed.reason
    }
    return {
      restoreResult(result) {
        return replaceResultPath(result, { original, pinned: executionPath })
      },
      async cleanup() {
        await finalize(false)
      },
      async rollback() {
        await finalize(true)
      },
    }
  } catch (error) {
    if (created && anchored !== undefined && targetIdentity !== undefined) {
      await verifyOutputEntry({
        anchored,
        original,
        identity: targetIdentity,
        noFollow,
        remove: true,
        tool: options.tool,
        agentDir: options.agentDir,
      }).catch(() => {})
    }
    await Promise.allSettled([targetHandle?.close(), directory.close()])
    throw error
  }
}

async function verifyExclusiveCreatedOutput(options: {
  anchored: string
  original: string
  noFollow: number
  tool: string
  agentDir: string
}): Promise<void> {
  const verified = await open(options.anchored, constants.O_RDONLY | options.noFollow)
  try {
    const inspected = await verified.stat()
    if (!inspected.isFile() || inspected.nlink !== 1) {
      throw new Error(`write/edit output is not a single-link regular file: ${options.original}`)
    }
    const resolved = await realpath(`/proc/self/fd/${verified.fd}`)
    enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
  } finally {
    await verified.close()
  }
}

async function verifyOutputEntry(options: {
  anchored: string
  original: string
  identity: { dev: number; ino: number }
  noFollow: number
  remove: boolean
  tool: string
  agentDir: string
}): Promise<void> {
  const verified = await open(options.anchored, constants.O_RDONLY | options.noFollow)
  try {
    const inspected = await verified.stat()
    if (!inspected.isFile() || inspected.nlink !== 1) {
      throw new Error(`write/edit output is not a single-link regular file: ${options.original}`)
    }
    if (inspected.dev !== options.identity.dev || inspected.ino !== options.identity.ino) {
      throw new Error(`write/edit output destination changed during execution: ${options.original}`)
    }
    const resolved = await realpath(`/proc/self/fd/${verified.fd}`)
    enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
    if (options.remove) await unlink(options.anchored)
  } finally {
    await verified.close()
  }
}

export async function writeFileAnchored(options: {
  targetPath: string
  data: Uint8Array
  agentDir: string
  tool: string
}): Promise<void> {
  const absolute = path.resolve(options.targetPath)
  enforceCanonicalSecretDenial({ tool: options.tool, args: { path: absolute }, agentDir: options.agentDir })
  if (process.platform !== 'linux') {
    throw new Error('safe attachment writes require Linux inode anchoring; refusing an unanchored destination')
  }
  const parent = await createAndOpenAnchoredDirectory(path.dirname(absolute))
  let output: FileHandle | undefined
  let operationError: unknown
  let cleanupError: unknown
  try {
    const anchored = `/proc/self/fd/${parent.fd}/${path.basename(absolute)}`
    output = await open(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const opened = await output.stat()
    if (!opened.isFile() || opened.nlink !== 1)
      throw new Error('attachment destination is not a single-link regular file')
    const resolved = await realpath(`/proc/self/fd/${output.fd}`)
    enforceCanonicalSecretDenial({ tool: options.tool, args: { path: resolved }, agentDir: options.agentDir })
    await output.truncate(0)
    await output.writeFile(options.data)
  } catch (error) {
    operationError = error
  } finally {
    const outcomes = await Promise.allSettled([output?.close(), parent.close()])
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failed?.status === 'rejected') cleanupError = failed.reason
  }
  if (operationError !== undefined) throw operationError
  if (cleanupError !== undefined) throw cleanupError
}

export async function writeToolOutputNoFollow(targetPath: string, content: string): Promise<void> {
  const trustedDescriptorPath = /^\/proc\/self\/fd\/\d+$/.test(targetPath)
  const flags = trustedDescriptorPath
    ? constants.O_WRONLY | constants.O_TRUNC
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  const output = await open(targetPath, flags, 0o666)
  try {
    await output.writeFile(content, 'utf8')
  } finally {
    await output.close()
  }
}

async function createAndOpenAnchoredDirectory(absolute: string): Promise<FileHandle> {
  if (!path.isAbsolute(absolute)) throw new Error(`anchored directory must be absolute: ${absolute}`)
  const components = absolute.split(path.sep).filter(Boolean)
  let current = await open(path.parse(absolute).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const component of components) {
      const anchored = `/proc/self/fd/${current.fd}/${component}`
      let next: FileHandle
      try {
        next = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      } catch (error) {
        if (!isNotFoundError(error)) throw error
        await mkdir(anchored, { mode: 0o700 })
        next = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      }
      await current.close()
      current = next
    }
    return current
  } catch (error) {
    await current.close()
    throw error
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function streamSnapshot(
  source: FileHandle,
  destination: string,
  original: string,
  maxBytes: number,
  previouslyCopied: number,
  lease: BudgetLease,
  operandCount: number,
  signal?: AbortSignal,
): Promise<number> {
  let copied = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.byteLength
      if (copied > maxBytes) {
        callback(inputTooLarge(original, copied, maxBytes))
        return
      }
      if (previouslyCopied + copied > maxBytes) {
        callback(aggregateInputTooLarge(previouslyCopied + copied, maxBytes))
        return
      }
      if (!lease.resize(previouslyCopied + copied, operandCount)) {
        callback(processBudgetGrowthExceeded(previouslyCopied + copied))
        return
      }
      callback(null, chunk)
    },
  })
  // `autoClose: false` leaves the FileHandle to the caller, but the ReadStream
  // opens its OWN fd that `source.close()` never releases and GC never reclaims
  // — one leaked fd per snapshotted file, reaching EMFILE on a long-running
  // agent. Destroy the stream explicitly to free that fd deterministically.
  const readStream = source.createReadStream({ autoClose: false, start: 0 })
  try {
    await pipeline(
      readStream,
      limiter,
      createWriteStream(destination, {
        flags: 'wx',
        mode: 0o400,
      }),
      { signal },
    )
  } finally {
    readStream.destroy()
  }
  return copied
}

async function snapshotDirectoryTree(options: {
  source: VerifiedInput
  destination: string
  agentDir: string
  tool: string
  maxBytes: number
  previouslyCopied: number
  lease: BudgetLease
  operandCount: number
  hidden?: HiddenPaths
  signal?: AbortSignal
}): Promise<{ copied: number; omittedLinks: { count: number; names: string[] } }> {
  if (process.platform !== 'linux') {
    throw new Error('directory tool inputs require Linux inode anchoring; refusing an unanchored traversal')
  }
  const root = await open(options.source.resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await root.stat()
    if (opened.dev !== options.source.dev || opened.ino !== options.source.ino) {
      throw new Error(`tool input changed while waiting for snapshot capacity: ${options.source.original}`)
    }
    await mkdir(options.destination, { mode: 0o700 })
    const state = { copied: 0, entries: 0, omittedLinks: { count: 0, names: [] as string[] } }
    const identityVerifier = createPrivateSurfaceReadIdentityVerifier({
      tool: options.tool,
      agentDir: options.agentDir,
      hidden: options.hidden ?? { dirs: [], files: [] },
    })
    const openedRoot = await realpath(`/proc/self/fd/${root.fd}`)
    const realAgentDir = await realpath(options.agentDir)
    await snapshotOpenedDirectory(
      root,
      options.destination,
      options,
      state,
      identityVerifier,
      openedRoot === realAgentDir,
    )
    await chmod(options.destination, 0o500)
    return { copied: state.copied, omittedLinks: state.omittedLinks }
  } finally {
    await root.close()
  }
}

async function snapshotOpenedDirectory(
  directory: FileHandle,
  destination: string,
  options: Parameters<typeof snapshotDirectoryTree>[0],
  state: { copied: number; entries: number; omittedLinks: { count: number; names: string[] } },
  identityVerifier: PrivateSurfaceIdentityVerifier,
  isAgentRoot: boolean,
): Promise<void> {
  const sourceRoot = `/proc/self/fd/${directory.fd}`
  const sourcePath = await realpath(sourceRoot)
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (options.signal?.aborted === true) throw abortError(options.signal)
    if (isAgentRoot && AGENT_ROOT_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue
    state.entries += 1
    if (state.entries > TREE_SNAPSHOT_MAX_ENTRIES) {
      throw new Error(`directory snapshot exceeds entry limit (${state.entries} > ${TREE_SNAPSHOT_MAX_ENTRIES})`)
    }
    const anchored = `${sourceRoot}/${entry.name}`
    const target = path.join(destination, entry.name)
    const candidate = path.join(sourcePath, entry.name)
    if (entry.isSymbolicLink()) {
      if (isDeniedSnapshotPath(candidate, options)) continue
      state.omittedLinks.count += 1
      if (state.omittedLinks.names.length < 12) {
        state.omittedLinks.names.push(path.relative(options.source.resolved, candidate))
      }
      continue
    }
    if (entry.isDirectory()) {
      if (isDeniedSnapshotPath(candidate, options)) continue
      const child = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const resolved = await realpath(`/proc/self/fd/${child.fd}`)
        if (isDeniedSnapshotPath(resolved, options)) continue
        await mkdir(target, { mode: 0o700 })
        await snapshotOpenedDirectory(child, target, options, state, identityVerifier, false)
        await chmod(target, 0o500)
      } finally {
        await child.close()
      }
      continue
    }
    if (!entry.isFile()) {
      if (isDeniedSnapshotPath(candidate, options)) continue
      throw new Error(`directory snapshot refuses non-regular entry: ${entry.name}`)
    }
    const source = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await source.stat()
      assertRegularInputFile(opened, candidate)
      enforceInputIdentityDenial(identityVerifier, opened)
      const resolved = await realpath(`/proc/self/fd/${source.fd}`)
      if (isDeniedSnapshotPath(resolved, options)) continue
      state.copied += await streamSnapshot(
        source,
        target,
        resolved,
        options.maxBytes,
        options.previouslyCopied + state.copied,
        options.lease,
        options.operandCount,
        options.signal,
      )
      await chmod(target, 0o400)
    } finally {
      await source.close()
    }
  }
}

function assertRegularInputFile(stats: Stats, original: string): void {
  if (!stats.isFile()) throw new Error(`tool input changed to a non-regular file before snapshot: ${original}`)
}

function maxInputBytes(tool: string): number {
  if (tool === 'look_at') return TOOL_INPUT_MAX_BYTES.look_at
  if (tool === 'channel_send' || tool === 'channel_reply') return TOOL_INPUT_MAX_BYTES.channel_upload
  return TOOL_INPUT_MAX_BYTES.read
}

function maxInputCount(tool: string): number {
  if (tool === 'look_at') return TOOL_INPUT_MAX_COUNT.look_at
  if (tool === 'channel_send' || tool === 'channel_reply') return TOOL_INPUT_MAX_COUNT.channel_upload
  return TOOL_INPUT_MAX_COUNT.read
}

function isOutputTool(tool: string): boolean {
  return tool === 'write' || tool === 'edit'
}

function isTreeInputTool(tool: string): boolean {
  return tool === 'grep' || tool === 'find' || tool === 'ls'
}

function isAmbiguousUndeclaredLocalOperand(value: string, agentDir: string, key: string): boolean {
  // Filesystem reality wins over semantic spelling: an existing entry named
  // like a repository slug, date, URL, or package coordinate is still a local
  // operand and must be declared so it is authorized and pinned.
  const resolved = path.resolve(agentDir, value)
  try {
    lstatSync(resolved)
    return true
  } catch (error) {
    if (!isNotFoundError(error)) return true
  }

  const basename = path.posix.basename(value.replaceAll('\\', '/'))
  if (CANONICAL_AGENT_SECRET_FILES.includes(basename as (typeof CANONICAL_AGENT_SECRET_FILES)[number])) return true

  if (isFileShapedKey(key)) return !(normalizedKey(key) === 'path' && isSafeApiRoute(value))
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)[^\\/]/.test(value)) return true
  if (value.startsWith('./') || value.startsWith('../')) return true
  if (isSemanticGenericString(key, value)) return false
  if (/[\\/]/.test(value)) return true
  if (/^[^./\\\s][^/\\\s]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return true
  return false
}

function isFileShapedKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return (
    normalized === 'path' ||
    normalized === 'file' ||
    normalized === 'filepath' ||
    normalized === 'filename' ||
    normalized.endsWith('path') ||
    normalized.endsWith('filepath') ||
    normalized.endsWith('filename')
  )
}

function normalizedKey(key: string): string {
  return key.replaceAll(/[-_]/g, '').toLocaleLowerCase()
}

function isSemanticGenericString(key: string, value: string): boolean {
  if (isExplicitNonFileUrl(value)) return true
  const normalized = normalizedKey(key)
  if (
    (normalized === 'repository' || normalized === 'repositoryslug' || normalized === 'reposlug') &&
    isSafeRepositorySlug(value)
  ) {
    return true
  }
  if ((normalized === 'date' || normalized === 'fraction') && isSafeNumericDateOrFraction(value)) return true
  return isPackageCoordinateKey(normalized) && isSafePackageCoordinate(value)
}

function isExplicitNonFileUrl(value: string): boolean {
  const trimmed = value.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return false
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || trimmed.toLocaleLowerCase().startsWith('file:')) return false
  try {
    return new URL(trimmed).protocol !== 'file:'
  } catch {
    return false
  }
}

function isSafeApiRoute(value: string): boolean {
  if (!/^\/v\d+\//.test(value) || value.includes('\\') || value.includes('//')) return false
  for (const segment of value.split('/').slice(1)) {
    if (segment.length === 0) return false
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return false
  }
  return true
}

function isSafeRepositorySlug(value: string): boolean {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)$/.exec(
    value,
  )
  return match !== null && match[1] !== '.' && match[1] !== '..' && match[2] !== '.' && match[2] !== '..'
}

function isSafeNumericDateOrFraction(value: string): boolean {
  return /^\d{1,4}([/-])\d{1,2}(?:\1\d{1,4})?$/.test(value)
}

function isPackageCoordinateKey(normalized: string): boolean {
  return (
    normalized === 'package' ||
    normalized === 'packagename' ||
    normalized === 'packagespec' ||
    normalized === 'packagecoordinate'
  )
}

function isSafePackageCoordinate(value: string): boolean {
  if (/^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:@[^\s/]+)?$/.test(value)) return true
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*@[^\s/@]+$/.test(value)) return true
  if (/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.+-]+){0,3}$/.test(value)) return true
  if (/^(?:[A-Za-z_][A-Za-z0-9_-]*\.)+[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) return true
  const segments = value.split('/')
  return segments.length > 1 && segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
}

function warnForUndeclaredExistingLocalOperand(
  logger: Pick<ToolLogger, 'warn'> | undefined,
  tool: string,
  operandPath: string,
  value: string,
  agentDir: string,
): void {
  if (logger === undefined) return
  try {
    lstatSync(path.resolve(agentDir, value))
  } catch {
    return
  }
  try {
    logger.warn(
      `[tool-file-safety] ${tool} received an undeclared existing local operand at ${JSON.stringify(operandPath)}; declare fileOperands.input to authorize immutable snapshotting`,
    )
  } catch {
    // Diagnostics must never change authorization behavior.
  }
}

function enforceInputIdentityDenial(
  verifier: PrivateSurfaceIdentityVerifier,
  identity: Pick<Stats, 'dev' | 'ino' | 'nlink'>,
): void {
  const blocked = verifier.check(identity)
  if (blocked !== undefined) throw new Error(`blocked: ${blocked.reason}`)
}

function isDeniedSnapshotPath(
  candidate: string,
  options: { agentDir: string; tool: string; hidden?: HiddenPaths },
): boolean {
  return (
    checkPrivateSurfaceReadGuard({
      tool: options.tool,
      args: { path: candidate },
      agentDir: options.agentDir,
      hidden: options.hidden ?? { dirs: [], files: [] },
    }) !== undefined
  )
}

function normalizeFileReference(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.toLocaleLowerCase().startsWith('file:')) return value
  try {
    return fileURLToPath(trimmed)
  } catch {
    throw new Error(`invalid file URI: ${value}`)
  }
}

function inputTooLarge(original: string, size: number, maxBytes: number): Error {
  return new Error(`tool input is too large: ${original} (${size} bytes > ${maxBytes} byte limit)`)
}

function aggregateInputTooLarge(size: number, maxBytes: number): Error {
  return new Error(`tool inputs exceed the aggregate byte limit (${size} bytes > ${maxBytes} byte limit)`)
}

function processBudgetGrowthExceeded(size: number): Error {
  return new Error(`tool snapshot growth exceeds the process-wide pinned byte budget (${size} bytes requested)`)
}

function inputCountTooLarge(count: number, maxCount: number): Error {
  return new Error(`tool input count exceeds the per-invocation limit (${count} > ${maxCount})`)
}

function outputCountTooLarge(count: number, maxCount: number): Error {
  return new Error(`tool output count exceeds the per-invocation limit (${count} > ${maxCount})`)
}

function appendSnapshotOmissions(
  result: ToolResult,
  omissions: readonly { root: string; count: number; names: string[] }[],
): ToolResult {
  if (omissions.length === 0) return result
  const notes = omissions.map(({ root, count, names }) => {
    const remainder = count - names.length
    return `Directory snapshot omitted ${count} symbolic link${count === 1 ? '' : 's'} under ${JSON.stringify(root)} (not followed): ${names.map((name) => JSON.stringify(name)).join(', ')}${remainder > 0 ? `, and ${remainder} more` : ''}.`
  })
  return { ...result, content: [...result.content, { type: 'text', text: notes.join('\n') }] }
}

function replaceResultPath(result: ToolResult, rewrite: Rewrite): ToolResult {
  const content = result.content.map((part) =>
    part.type === 'text' ? { ...part, text: part.text.split(rewrite.pinned).join(rewrite.original) } : part,
  )
  const details = replaceDeep(result.details, rewrite)
  return { content, details }
}

function replaceDeep(value: unknown, rewrite: Rewrite): unknown {
  if (typeof value === 'string') return value.split(rewrite.pinned).join(rewrite.original)
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, rewrite))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDeep(item, rewrite)]))
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

type BudgetRequest = {
  bytes: number
  count: number
  signal?: AbortSignal
  resolve(lease: BudgetLease): void
  reject(error: Error): void
  onAbort?: () => void
}

type BudgetLease = {
  resize(bytes: number, count: number): boolean
  release(): void
}

class PinnedSnapshotBudget {
  private bytes = 0
  private count = 0
  private readonly queue: BudgetRequest[] = []

  constructor(
    private readonly limits: { maxBytes: number; maxCount: number; maxWaiters: number },
    private readonly onWait?: () => void,
  ) {}

  async acquire(bytes: number, count: number, signal?: AbortSignal): Promise<BudgetLease> {
    if (bytes > this.limits.maxBytes || count > this.limits.maxCount) {
      throw new Error('tool inputs exceed the process-wide pinned snapshot budget')
    }
    if (signal?.aborted === true) throw abortError(signal)
    if (this.queue.length >= this.limits.maxWaiters) {
      throw new Error(`pinned snapshot waiter queue is full (${this.limits.maxWaiters} waiters)`)
    }
    return await new Promise<BudgetLease>((resolve, reject) => {
      const request: BudgetRequest = { bytes, count, signal, resolve, reject }
      const waits =
        this.queue.length > 0 ||
        this.bytes + request.bytes > this.limits.maxBytes ||
        this.count + request.count > this.limits.maxCount
      if (waits) this.onWait?.()
      if (signal !== undefined) {
        request.onAbort = () => {
          const index = this.queue.indexOf(request)
          if (index === -1) return
          this.queue.splice(index, 1)
          reject(abortError(signal))
          this.drain()
        }
        signal.addEventListener('abort', request.onAbort, { once: true })
      }
      this.queue.push(request)
      this.drain()
    })
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0] as BudgetRequest
      if (this.bytes + next.bytes > this.limits.maxBytes || this.count + next.count > this.limits.maxCount) {
        return
      }
      this.queue.shift()
      if (next.onAbort !== undefined) next.signal?.removeEventListener('abort', next.onAbort)
      this.bytes += next.bytes
      this.count += next.count
      let released = false
      let leasedBytes = next.bytes
      let leasedCount = next.count
      next.resolve({
        resize: (bytes, count) => {
          if (released) return false
          const byteDelta = bytes - leasedBytes
          const countDelta = count - leasedCount
          if (this.bytes + byteDelta > this.limits.maxBytes || this.count + countDelta > this.limits.maxCount) {
            return false
          }
          this.bytes += byteDelta
          this.count += countDelta
          leasedBytes = bytes
          leasedCount = count
          this.drain()
          return true
        },
        release: () => {
          if (released) return
          released = true
          this.bytes -= leasedBytes
          this.count -= leasedCount
          this.drain()
        },
      })
    }
  }
}

export function createPinnedSnapshotBudgetForTests(options: {
  maxBytes: number
  maxCount: number
  maxWaiters: number
  onWait?: () => void
}) {
  const { onWait, ...limits } = options
  return new PinnedSnapshotBudget(limits, onWait)
}

const pinnedSnapshotBudget = new PinnedSnapshotBudget({
  maxBytes: PINNED_SNAPSHOT_GLOBAL_MAX_BYTES,
  maxCount: PINNED_SNAPSHOT_GLOBAL_MAX_COUNT,
  maxWaiters: PINNED_SNAPSHOT_MAX_WAITERS,
})

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  return new Error(`pinned snapshot wait aborted${reason === undefined ? '' : `: ${String(reason)}`}`)
}
