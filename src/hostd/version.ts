import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

// Identifies the typeclaw source the daemon was loaded from. Computed by
// hashing the bytes of every .ts file under `src/` (excluding tests).
//
// Why: the host daemon (`typeclaw _hostd`) is the only long-lived host-stage
// process. Bun reads source files once at process start; subsequent edits on
// disk do not propagate. A short-lived CLI invocation (`typeclaw start`) sees
// the new code immediately, but if it reuses an existing daemon, the daemon
// keeps serving old in-memory daemon logic indefinitely. The
// observable effect is that bug fixes "don't apply" until the user manually
// kills `_hostd` — which is invisible footgun territory.
//
// This module produces a deterministic fingerprint of the source the running
// daemon represents, so the CLI can detect drift over the control socket and
// transparently respawn. Two implementation guarantees matter:
//
// 1. Determinism. The same source tree must always produce the same hash
//    across processes/machines. We sort entries by path and hash bytes only,
//    not metadata (mtime/size/inode), so a clean checkout of HEAD always
//    matches.
// 2. Right scope. Hash only files the daemon actually loads. Test files and
//    non-typescript assets are out — changes to them must not trigger a
//    daemon respawn. The current scheme covers all of `src/**/*.ts` because
//    the daemon's behavior depends on transitive imports (e.g. the supervisor
//    callback in `src/cli/hostd.ts` reaches into `src/container/` and
//    `src/config/`). Over-respawning on `src/agent/` changes is acceptable
//    cost: a daemon spawn is < 100ms.
//
// The Bun runtime version is folded in too. The daemon keeps running on the
// binary it was spawned with, so after `bun upgrade` it would otherwise stay on
// the old runtime until killed by hand — and an old runtime crashing is exactly
// what took hostd down in the field.

export type SourceVersion = string

export type ComputeOptions = {
  // Absolute path to the project's `src/` directory. The hash covers every
  // *.ts file rooted here, recursively.
  srcRoot: string
  // Test seam. Tests inject an in-memory file map to keep the unit tests
  // hermetic; production reads the real filesystem.
  fs?: VersionFs
  // Test seam: defaults to the Bun running this process.
  runtimeVersion?: string
}

export type VersionFs = {
  readdir: (path: string) => Promise<Array<{ name: string; isDirectory: boolean }>>
  readFile: (path: string) => Promise<Buffer>
}

const realFs: VersionFs = {
  readdir: async (path) => {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  },
  readFile: (path) => readFile(path),
}

export async function computeSourceVersion(opts: ComputeOptions): Promise<SourceVersion> {
  const fs = opts.fs ?? realFs
  const root = resolve(opts.srcRoot)
  const files = await collectSourceFiles(root, root, fs)
  files.sort()

  const hash = createHash('sha256')
  hash.update(`bun:${opts.runtimeVersion ?? process.versions.bun ?? 'unknown'}\u0000`)
  for (const rel of files) {
    const abs = join(root, rel)
    const bytes = await fs.readFile(abs)
    // Path separator is normalized so a hash computed on macOS matches one
    // computed on Linux for the same checkout. Tree fingerprints should not
    // depend on the host OS's path conventions.
    const normalizedRel = rel.split(sep).join('/')
    hash.update(`${normalizedRel}\u0000`)
    hash.update(bytes)
    hash.update('\u0000')
  }
  return hash.digest('hex').slice(0, 32)
}

async function collectSourceFiles(root: string, dir: string, fs: VersionFs): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir)
  for (const entry of entries) {
    if (entry.isDirectory) {
      const sub = await collectSourceFiles(root, join(dir, entry.name), fs)
      out.push(...sub)
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    const absPath = join(dir, entry.name)
    const relPath = absPath.slice(root.length + 1)
    out.push(relPath)
  }
  return out
}

// Resolves the project's `src/` directory from a CLI entry path
// (typically `process.argv[1]`, which points at `src/cli/index.ts` in dev
// stage or a bundled JS entry in published builds). Returns `null` if no
// `src/` ancestor is found, in which case versioning falls back to a
// constant — disabling drift detection rather than crashing.
export function resolveSrcRoot(cliEntry: string): string | null {
  let current = resolve(cliEntry)
  while (true) {
    const parent = dirname(current)
    if (parent === current) return null
    if (parent.endsWith(`${sep}src`) || parent === 'src') return parent
    current = parent
  }
}

// Sentinel used when the source root cannot be resolved (e.g. published
// bundle that lives outside a `src/` tree). Both daemon and CLI compute the
// same fallback, so they will appear in-sync and skip the respawn path. This
// preserves correctness for non-dev installs at the cost of disabling drift
// detection there.
export const UNVERSIONED_SENTINEL: SourceVersion = 'unversioned'

// The Bun that CI and the container base image (`BUN_BASE_IMAGE`) run. Bump it
// together with the `bun-version:` pins in .github/workflows/*.yml.
export const TESTED_BUN_VERSION = '1.4.0'

// The host daemon runs on the host's Bun, not the container's pinned one, so an
// operator can silently stay on a runtime CI never tested (Bun 1.3.14's
// segfault-then-wedge is what took a host daemon down for days).
export function hostBunVersionWarning(hostBunVersion: string | undefined): string | null {
  if (!hostBunVersion || Bun.semver.order(hostBunVersion, TESTED_BUN_VERSION) >= 0) return null
  return `host Bun ${hostBunVersion} is older than Bun ${TESTED_BUN_VERSION}, which typeclaw is tested on; older runtimes have known crash bugs that take the host daemon down. Run \`bun upgrade\`.`
}
