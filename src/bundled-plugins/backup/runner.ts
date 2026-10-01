import { lstatSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hooklessGitArgs } from '@/git/hookless'
import { type AgentGit, resolveAgentGit } from '@/git/resolve-agent-git'

export const COMMIT_TIMEOUT_MS = 30_000
export const NETWORK_TIMEOUT_MS = 60_000
export const MAINTENANCE_TIMEOUT_MS = 120_000

// The two maintenance tasks are gated INDEPENDENTLY because a backup commit with
// auto-gc disabled (Fix 1) produces LOOSE OBJECTS, not packs:
//   - loose-objects fires on the loose-object count (`count:` in count-objects),
//     which is what actually grows every idle backup cycle. Gating this on pack
//     count would let loose objects accumulate forever while packs stayed ~0.
//   - incremental-repack fires on the pack count (`packs:`), consolidating the
//     packs that loose-objects itself produces once they build up.
// Each task consolidates its own input, so the counts reset and both self-throttle
// — no wall-clock timer needed.
const MAINTENANCE_LOOSE_THRESHOLD = 300
const MAINTENANCE_PACK_THRESHOLD = 12

// Memory caps for the maintenance repack, matching the machine-local config Fix 1
// writes so the bound holds even on a repo that predates it. Passed as `-c` so
// they apply to this invocation regardless of the persisted config.
const BOUNDED_PACK_FLAGS = [
  '-c',
  'pack.threads=1',
  '-c',
  'pack.windowMemory=64m',
  '-c',
  'pack.deltaCacheSize=1',
] as const

const RUNTIME_OWNED_PREFIXES = ['memory/'] as const
const FORCE_ADD_PREFIXES = ['sessions/', 'todo/'] as const

const NONINTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GCM_INTERACTIVE: 'never',
} as const

export type GitSpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type GitSpawn = (
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<GitSpawnResult>

export type BackupRunnerDeps = {
  gitSpawn: GitSpawn
  pickCommitMessage: (input: { status: string; diffstat: string }) => Promise<string>
  diagnoseFailure?: (input: BackupFailureInput) => Promise<void>
  // Credential env (GIT_ASKPASS/TYPECLAW_GIT_TOKEN/insteadOf) applied ONLY to
  // network git invocations (push/fetch). It is deliberately NOT given to local
  // commands — `git commit` can run repo-controlled hooks, which must never see
  // the minted token.
  pushEnv?: Record<string, string>
  now?: () => number
}

export type BackupRunnerOptions = {
  cwd: string
  pushToOrigin: boolean
}

export type BackupFailureInput = {
  cwd: string
  stage: 'push' | 'rebase'
  exitCode: number
  stderr: string
  stdout: string
}

export type BackupResult =
  | { ok: true; kind: 'no-repo' | 'clean' | 'committed' | 'pushed' | 'pushed-set-upstream' | 'rebased-and-pushed' }
  | { ok: false; kind: 'commit-failed' | 'push-failed' | 'rebase-failed' | 'aborted'; reason: string }

type ActivePushPlan =
  | { kind: 'upstream'; upstreamRef: string }
  | { kind: 'set-upstream'; remote: string; branch: string }

type PushPlan = ActivePushPlan | { kind: 'skip' }

export async function runBackup(options: BackupRunnerOptions, deps: BackupRunnerDeps): Promise<BackupResult> {
  const { cwd, pushToOrigin } = options

  const repo = resolveAgentGit(cwd)
  if (!repo) return { ok: true, kind: 'no-repo' }

  const status = await deps.gitSpawn([...repo.gitArgs, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (status.exitCode !== 0) return { ok: false, kind: 'aborted', reason: `git status failed: ${shortErr(status)}` }
  const entries = parsePorcelain(status.stdout)
  // Only index-known, absent worktree paths that were NEVER in HEAD are
  // stale additions (including removed intent-to-add entries). A tracked
  // deletion still in HEAD is backup work; memory/ belongs to another writer.
  const missing = uniquePaths(
    entries
      .filter((entry) => entry.kind === 'tracked' && (entry.status[0] === 'A' || entry.status[1] === 'D'))
      .flatMap((entry) => entry.paths)
      .filter((path) => !isAgentOwned(path) && !hasDirectoryEntry(join(cwd, path))),
  )
  const head =
    missing.length > 0
      ? await deps.gitSpawn([...repo.gitArgs, 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...missing], {
          cwd,
          timeoutMs: COMMIT_TIMEOUT_MS,
        })
      : { exitCode: 0, stdout: '', stderr: '', timedOut: false }
  if (head.exitCode !== 0) {
    const exists = await deps.gitSpawn([...repo.gitArgs, 'rev-parse', '--verify', 'HEAD'], {
      cwd,
      timeoutMs: COMMIT_TIMEOUT_MS,
    })
    if (exists.exitCode === 0)
      return { ok: false, kind: 'commit-failed', reason: `git ls-tree failed: ${shortErr(head)}` }
  }
  const headPaths = new Set(head.stdout.split('\0'))
  const missingAdds = missing.filter((path) => !headPaths.has(path))
  if (missingAdds.length > 0) {
    const removed = await deps.gitSpawn([...repo.gitArgs, 'add', '-u', '--', ...missingAdds], {
      cwd,
      timeoutMs: COMMIT_TIMEOUT_MS,
    })
    if (removed.exitCode !== 0)
      return { ok: false, kind: 'commit-failed', reason: `git add -u failed: ${shortErr(removed)}` }
  }
  const removedPaths = new Set(missingAdds)
  const snapshot = selectStagingSnapshot(
    entries.filter((entry) => !entry.paths.every((path) => removedPaths.has(path))),
    cwd,
  )
  if (snapshot.paths.length === 0 && snapshot.forcePaths.length === 0) return { ok: true, kind: 'clean' }

  // Keep the staged snapshot out of the shared index while the message subagent
  // runs. Other writers may commit the entire shared index during that window.
  const indexDir = await mkdtemp(join(tmpdir(), 'typeclaw-backup-index-'))
  const indexEnv = { GIT_INDEX_FILE: join(indexDir, 'index') }
  const privateGit = (args: string[]) =>
    deps.gitSpawn([...repo.gitArgs, ...args], { cwd, timeoutMs: COMMIT_TIMEOUT_MS, env: indexEnv })
  const readHead = async (): Promise<GitSpawnResult> => {
    const result = await privateGit(['read-tree', 'HEAD'])
    if (result.exitCode === 0) return result
    const head = await privateGit(['rev-parse', '--verify', 'HEAD'])
    return head.exitCode === 0 ? result : privateGit(['read-tree', '--empty'])
  }
  const stageSnapshot = async (paths: string[], forcePaths: string[]): Promise<GitSpawnResult | undefined> => {
    if (paths.length > 0) {
      const add = await privateGit(['add', '-f', '--', ...paths])
      if (add.exitCode !== 0) {
        const retry = await retryAfterVanishedUntracked(cwd, deps, repo, snapshot, indexEnv, true)
        if (!retry || retry.exitCode !== 0) return retry ?? add
      }
    }
    if (forcePaths.length > 0) {
      const add = await privateGit(['add', '-f', '--', ...forcePaths])
      if (add.exitCode !== 0) return add
    }
    return undefined
  }
  try {
    const init = await readHead()
    if (init.exitCode !== 0)
      return { ok: false, kind: 'commit-failed', reason: `git read-tree failed: ${shortErr(init)}` }
    const staged = await stageSnapshot(snapshot.paths, snapshot.forcePaths)
    if (staged) return { ok: false, kind: 'commit-failed', reason: `git add failed: ${shortErr(staged)}` }

    const stagedCheck = await privateGit(['diff', '--cached', '--quiet'])
    if (stagedCheck.exitCode === 0) return { ok: true, kind: 'clean' }
    if (stagedCheck.exitCode !== 1)
      return { ok: false, kind: 'commit-failed', reason: `git diff failed: ${shortErr(stagedCheck)}` }

    const diffstat = await privateGit(['diff', '--cached', '--stat'])
    const message = await deps.pickCommitMessage({
      status: status.stdout.replaceAll('\0', '\n').slice(0, 4096),
      diffstat: diffstat.stdout.slice(0, 4096),
    })

    // The message subagent may create a sessions/ path after the first snapshot.
    // Re-read only for those paths; other new work must wait for the next pass.
    const reStatus = await deps.gitSpawn([...repo.gitArgs, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd,
      timeoutMs: COMMIT_TIMEOUT_MS,
    })
    const lateEntries = reStatus.exitCode === 0 ? parsePorcelain(reStatus.stdout) : []
    const lateForce = selectForcePaths(lateEntries, cwd, ['sessions/'])
    const selected = uniquePaths([...snapshot.paths, ...snapshot.forcePaths, ...lateForce]).filter(
      (path) => !snapshot.untrackedPaths.has(path) || hasDirectoryEntry(join(cwd, path)),
    )
    const selectedSet = new Set(selected)
    // Porcelain still reports tracked deletions not yet committed by another
    // writer; absent paths no longer reported after the message window were
    // already committed and cannot be passed to git commit --only.
    const reported = new Set((reStatus.exitCode === 0 ? lateEntries : entries).flatMap((entry) => entry.paths))
    const paths = selected.filter((path) => hasDirectoryEntry(join(cwd, path)) || reported.has(path))
    if (paths.length === 0) return { ok: true, kind: 'clean' }

    // --only constructs Git's own temporary index from the current HEAD and
    // refreshes the real index for just these paths. Only previously untracked
    // paths need intent-to-add entries in the real index for pathspec matching.
    const candidates = uniquePaths(
      [...entries, ...lateEntries]
        .filter((entry) => entry.kind === 'untracked')
        .flatMap((entry) => entry.paths)
        .filter((path) => selectedSet.has(path) && hasDirectoryEntry(join(cwd, path))),
    )
    if (candidates.length > 0) {
      const intent = await deps.gitSpawn([...repo.gitArgs, 'add', '-N', '-f', '--', ...candidates], {
        cwd,
        timeoutMs: COMMIT_TIMEOUT_MS,
      })
      if (intent.exitCode !== 0)
        return { ok: false, kind: 'commit-failed', reason: `git add -N failed: ${shortErr(intent)}` }
    }
    const commit = await deps.gitSpawn(
      [...repo.gitArgs, 'commit', '--only', '-m', sanitizeCommitMessage(message), '--', ...paths],
      {
        cwd,
        timeoutMs: COMMIT_TIMEOUT_MS,
      },
    )
    if (commit.exitCode !== 0) {
      // A concurrent whole-index commit may have consumed the selected paths.
      const pending = await deps.gitSpawn([...repo.gitArgs, 'status', '--porcelain=v1', '-z', '--', ...paths], {
        cwd,
        timeoutMs: COMMIT_TIMEOUT_MS,
      })
      if (pending.exitCode === 0 && pending.stdout === '') return { ok: true, kind: 'clean' }
      return { ok: false, kind: 'commit-failed', reason: `git commit failed: ${shortErr(commit)}` }
    }
  } finally {
    await rm(indexDir, { recursive: true, force: true })
  }

  if (!pushToOrigin) return { ok: true, kind: 'committed' }

  const plan = await resolvePushPlan(cwd, deps, repo)
  if (plan.kind === 'skip') return { ok: true, kind: 'committed' }

  return pushWithRecovery(cwd, deps, repo, plan)
}

export type MaintenanceResult =
  | { ok: true; kind: 'no-repo' | 'skipped' | 'ran'; tasks?: readonly string[] }
  | { ok: false; kind: 'failed'; reason: string }

// Bounded, best-effort git maintenance run on the idle backup path. With auto-gc
// disabled (Fix 1), nothing reclaims what the backup keeps adding, so this runs
// the two reclamation tasks — each gated on ITS OWN growing counter (see the
// threshold comment above): `loose-objects` when loose objects pile up (the
// steady-state effect of every commit), `incremental-repack` when packs pile up.
// incremental-repack uses the multi-pack-index, touching only SMALL packs and
// leaving the big established pack alone, so memory and time stay bounded unlike a
// full `git gc`. Both tasks run under BOUNDED_PACK_FLAGS. NEVER throws: a
// maintenance failure must not turn a good commit into a reported backup failure.
// The caller runs this after a commit, holding the same git lock the commit did.
export type MaintenanceThresholds = { loose?: number; packs?: number }

export async function runMaintenance(
  cwd: string,
  deps: BackupRunnerDeps,
  thresholds: MaintenanceThresholds = {},
): Promise<MaintenanceResult> {
  const repo = resolveAgentGit(cwd)
  if (!repo) return { ok: true, kind: 'no-repo' }

  const looseThreshold = thresholds.loose ?? MAINTENANCE_LOOSE_THRESHOLD
  const packThreshold = thresholds.packs ?? MAINTENANCE_PACK_THRESHOLD
  const counts = await countObjects(cwd, deps, repo)
  const tasks: string[] = []
  if (counts.loose > looseThreshold) tasks.push('loose-objects')
  if (counts.packs > packThreshold) tasks.push('incremental-repack')
  if (tasks.length === 0) return { ok: true, kind: 'skipped' }

  const run = await deps.gitSpawn(
    [...repo.gitArgs, ...BOUNDED_PACK_FLAGS, 'maintenance', 'run', ...tasks.map((task) => `--task=${task}`)],
    { cwd, timeoutMs: MAINTENANCE_TIMEOUT_MS },
  )
  if (run.exitCode !== 0) return { ok: false, kind: 'failed', reason: shortErr(run) }
  return { ok: true, kind: 'ran', tasks }
}

// Reads the loose-object (`count:`) and pack (`packs:`) counts from
// `git count-objects -v`. Returns zeroes on any failure so a probe error just
// skips maintenance rather than aborting it.
async function countObjects(
  cwd: string,
  deps: BackupRunnerDeps,
  repo: AgentGit,
): Promise<{ loose: number; packs: number }> {
  const result = await deps.gitSpawn([...repo.gitArgs, 'count-objects', '-v'], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
  if (result.exitCode !== 0) return { loose: 0, packs: 0 }
  return { loose: readCount(result.stdout, 'count'), packs: readCount(result.stdout, 'packs') }
}

function readCount(stdout: string, field: 'count' | 'packs'): number {
  const match = new RegExp(String.raw`^${field}:\s*(\d+)`, 'm').exec(stdout)
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : 0
}

// `@{upstream}` resolution failing was previously treated as "no push" — but a
// fresh agent repo that nobody ran `git push -u` on has a configured `origin`
// and no tracking ref, so the runner committed forever and never pushed. The
// correct gate when `pushToOrigin` is on is "origin exists and HEAD is a real
// branch": then we push AND set the upstream in one shot, and every later run
// takes the plain-upstream path. No remote / detached HEAD stays commit-only
// (a legitimate offline state), so it returns `skip` rather than diagnosing.
async function resolvePushPlan(cwd: string, deps: BackupRunnerDeps, repo: AgentGit): Promise<PushPlan> {
  const upstream = await deps.gitSpawn(
    [...repo.gitArgs, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    {
      cwd,
      timeoutMs: COMMIT_TIMEOUT_MS,
    },
  )
  if (upstream.exitCode === 0 && upstream.stdout.trim().length > 0) {
    return { kind: 'upstream', upstreamRef: upstream.stdout.trim() }
  }

  // Only `origin` is acted on: picking "the first remote" when origin is absent
  // would guess a destination the operator never configured. `get-url` (not
  // `get-url --push`) is enough here — we only need to know origin EXISTS and
  // is named `origin`; the push targets `origin` by name regardless of pushurl.
  const origin = await deps.gitSpawn([...repo.gitArgs, 'remote', 'get-url', 'origin'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (origin.exitCode !== 0 || origin.stdout.trim().length === 0) return { kind: 'skip' }

  // `symbolic-ref --short HEAD` fails on a detached HEAD (no branch to set an
  // upstream for); `rev-parse --abbrev-ref HEAD` would have returned the literal
  // "HEAD" and we'd have tried to push a branch named HEAD. Skip cleanly.
  const branch = await deps.gitSpawn([...repo.gitArgs, 'symbolic-ref', '--short', 'HEAD'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (branch.exitCode !== 0 || branch.stdout.trim().length === 0) return { kind: 'skip' }

  return { kind: 'set-upstream', remote: 'origin', branch: branch.stdout.trim() }
}

// Both entry points (plain push and first-time set-upstream push) share the
// non-fast-forward recovery: fetch, rebase onto the intended remote branch,
// re-push. Keeping one helper stops the set-upstream path from silently becoming
// a weaker duplicate that skips recovery.
async function pushWithRecovery(
  cwd: string,
  deps: BackupRunnerDeps,
  repo: AgentGit,
  plan: ActivePushPlan,
): Promise<BackupResult> {
  const pushArgs = [...repo.gitArgs, ...pushArgsFor(plan)]
  const rebaseRef = plan.kind === 'upstream' ? plan.upstreamRef : `${plan.remote}/${plan.branch}`
  // In the set-upstream case there is no tracking ref yet, so a bare `git fetch`
  // has no configured remote to default to — fetch the same remote we rebase
  // onto. The upstream case keeps bare `fetch` (its tracking config resolves it).
  const fetchArgs = [...repo.gitArgs, ...(plan.kind === 'upstream' ? ['fetch'] : ['fetch', plan.remote])]
  const pushedKind: BackupResult = { ok: true, kind: plan.kind === 'upstream' ? 'pushed' : 'pushed-set-upstream' }
  // Credentials ride ONLY on the network calls (push/fetch). The rebase is
  // local (it replays onto an already-fetched remote-tracking ref), so it runs
  // token-free like every other local command.
  const net = { cwd, timeoutMs: NETWORK_TIMEOUT_MS, env: deps.pushEnv }

  const push = await deps.gitSpawn(pushArgs, net)
  if (push.exitCode === 0) return pushedKind

  if (!isNonFastForward(push)) {
    await maybeDiagnose(deps, { cwd, stage: 'push', exitCode: push.exitCode, stderr: push.stderr, stdout: push.stdout })
    return { ok: false, kind: 'push-failed', reason: shortErr(push) }
  }

  const fetch = await deps.gitSpawn(fetchArgs, net)
  if (fetch.exitCode !== 0) {
    await maybeDiagnose(deps, {
      cwd,
      stage: 'push',
      exitCode: fetch.exitCode,
      stderr: fetch.stderr,
      stdout: fetch.stdout,
    })
    return { ok: false, kind: 'push-failed', reason: `git fetch failed: ${shortErr(fetch)}` }
  }

  const rebase = await deps.gitSpawn([...repo.gitArgs, 'rebase', rebaseRef], { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  if (rebase.exitCode !== 0) {
    await deps.gitSpawn([...repo.gitArgs, 'rebase', '--abort'], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
    await maybeDiagnose(deps, {
      cwd,
      stage: 'rebase',
      exitCode: rebase.exitCode,
      stderr: rebase.stderr,
      stdout: rebase.stdout,
    })
    return { ok: false, kind: 'rebase-failed', reason: `git rebase failed: ${shortErr(rebase)}` }
  }

  const push2 = await deps.gitSpawn(pushArgs, net)
  if (push2.exitCode !== 0) {
    await maybeDiagnose(deps, {
      cwd,
      stage: 'push',
      exitCode: push2.exitCode,
      stderr: push2.stderr,
      stdout: push2.stdout,
    })
    return { ok: false, kind: 'push-failed', reason: `git push (post-rebase) failed: ${shortErr(push2)}` }
  }
  return { ok: true, kind: 'rebased-and-pushed' }
}

function pushArgsFor(plan: ActivePushPlan): string[] {
  if (plan.kind === 'upstream') return ['push']
  // `HEAD:<branch>` is explicit about pushing the current commit to the named
  // remote branch, avoiding any reliance on local refspec defaults.
  return ['push', '-u', plan.remote, `HEAD:${plan.branch}`]
}

async function maybeDiagnose(deps: BackupRunnerDeps, input: BackupFailureInput): Promise<void> {
  if (!deps.diagnoseFailure) return
  try {
    await deps.diagnoseFailure(input)
  } catch {
    // Diagnosis is advisory; never let it mask the original failure.
  }
}

function shortErr(r: GitSpawnResult): string {
  if (r.timedOut) return `timed out (exit ${r.exitCode})`
  const text = r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

function isNonFastForward(r: GitSpawnResult): boolean {
  const blob = `${r.stderr}\n${r.stdout}`.toLowerCase()
  return blob.includes('non-fast-forward') || blob.includes('updates were rejected')
}

export type PorcelainEntry = {
  status: string
  kind: 'tracked' | 'untracked'
  paths: readonly string[]
}

// `-z` makes paths literal rather than C-quoted. Rename/copy records carry the
// destination followed by the source, and both are needed when staging a
// snapshot that contains an endpoint which has since disappeared.
export function parsePorcelain(stdout: string): PorcelainEntry[] {
  const separator = stdout.includes('\0') ? '\0' : '\n'
  const records = stdout.split(separator)
  const entries: PorcelainEntry[] = []

  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index] ?? ''
    if (raw.length < 4) continue
    const status = raw.slice(0, 2)
    const path = raw.slice(3)
    const renamedOrCopied = status.includes('R') || status.includes('C')
    const source = renamedOrCopied && separator === '\0' ? records[++index] : undefined
    const fallbackSource = renamedOrCopied && separator === '\n' ? path.split(' -> ')[0] : undefined
    const destination = fallbackSource ? path.slice(fallbackSource.length + 4) : path
    entries.push({
      status,
      kind: status === '??' ? 'untracked' : 'tracked',
      paths: source ? [path, source] : fallbackSource ? [destination, fallbackSource] : [path],
    })
  }
  return entries
}

type StagingSnapshot = {
  paths: string[]
  untrackedPaths: Set<string>
  forcePaths: string[]
}

function selectStagingSnapshot(entries: readonly PorcelainEntry[], cwd: string): StagingSnapshot {
  const paths: string[] = []
  const untrackedPaths = new Set<string>()
  for (const entry of entries) {
    for (const path of entry.paths) {
      if (isAgentOwned(path)) continue
      const forceAdded = FORCE_ADD_PREFIXES.some((prefix) => path.startsWith(prefix))
      if (entry.kind === 'untracked') {
        if (forceAdded || !hasDirectoryEntry(join(cwd, path))) continue
        untrackedPaths.add(path)
      }
      paths.push(path)
    }
  }
  return { paths: uniquePaths(paths), untrackedPaths, forcePaths: selectForcePaths(entries, cwd) }
}

async function retryAfterVanishedUntracked(
  cwd: string,
  deps: BackupRunnerDeps,
  repo: AgentGit,
  snapshot: StagingSnapshot,
  env?: Record<string, string>,
  force = false,
): Promise<GitSpawnResult | undefined> {
  const reread = await deps.gitSpawn([...repo.gitArgs, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (reread.exitCode !== 0) return undefined

  const reported = new Set(
    parsePorcelain(reread.stdout)
      .filter((entry) => entry.kind === 'untracked')
      .flatMap((entry) => entry.paths),
  )
  const vanished = new Set(
    [...snapshot.untrackedPaths].filter((path) => !hasDirectoryEntry(join(cwd, path)) && !reported.has(path)),
  )
  if (vanished.size === 0) return undefined

  const retryPaths = snapshot.paths.filter((path) => !vanished.has(path))
  if (retryPaths.length === 0) return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
  return deps.gitSpawn([...repo.gitArgs, 'add', ...(force ? ['-f'] : []), '--', ...retryPaths], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
    env,
  })
}

function selectForcePaths(
  entries: readonly PorcelainEntry[],
  cwd: string,
  prefixes: readonly string[] = FORCE_ADD_PREFIXES,
): string[] {
  return uniquePaths(
    entries.flatMap((entry) =>
      entry.paths.filter(
        (path) => prefixes.some((prefix) => path.startsWith(prefix)) && hasDirectoryEntry(join(cwd, path)),
      ),
    ),
  )
}

function hasDirectoryEntry(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

function isAgentOwned(path: string): boolean {
  return RUNTIME_OWNED_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function sanitizeCommitMessage(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'Backup'
  const subject = trimmed.split('\n')[0]?.slice(0, 200) ?? 'Backup'
  const rest = trimmed.split('\n').slice(1).join('\n').trim()
  return rest.length > 0 ? `${subject}\n\n${rest}` : subject
}

export function makeDefaultGitSpawn(bunOverride?: { spawn: typeof Bun.spawn }): GitSpawn {
  return withIndexLockRetry(async (args, { cwd, timeoutMs, env }) => {
    const bun = bunOverride ?? (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
    if (!bun) {
      return { exitCode: 127, stdout: '', stderr: 'Bun runtime not available', timedOut: false }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // Per-call `env` (credentials for push/fetch) is applied LAST so its
      // GIT_TERMINAL_PROMPT wins; NONINTERACTIVE_ENV's pager/GCM settings still
      // apply to every call. Local commands pass no `env` and stay token-free.
      const proc = bun.spawn({
        cmd: ['git', ...hooklessGitArgs(args)],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...NONINTERACTIVE_ENV, ...env },
        signal: controller.signal,
      })
      const exitedDrain = proc.exited
      const stdoutDrain = new Response(proc.stdout).text()
      const stderrDrain = new Response(proc.stderr).text()
      let exitCode: number
      let stdout: string
      let stderr: string
      try {
        ;[exitCode, stdout, stderr] = await Promise.all([exitedDrain, stdoutDrain, stderrDrain])
      } catch (drainErr) {
        // A pipe-read rejection must not escape while the git child is still
        // running (the outer `finally` would clear the abort timer and leave a
        // stuck child unbounded). Abort to kill it, then wait for exit and both
        // drains to settle before surfacing the error.
        controller.abort()
        await Promise.allSettled([exitedDrain, stdoutDrain, stderrDrain])
        throw drainErr
      }
      const timedOut = controller.signal.aborted
      return { exitCode, stdout, stderr, timedOut }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        exitCode: 1,
        stdout: '',
        stderr: message,
        timedOut: controller.signal.aborted,
      }
    } finally {
      clearTimeout(timer)
    }
  })
}

export function withIndexLockRetry(spawn: GitSpawn): GitSpawn {
  return async (args, opts) => {
    let result = await spawn(args, opts)
    for (const delayMs of [50, 150, 350]) {
      if (result.exitCode === 0 || !isIndexLockContention(result.stderr)) return result
      await sleep(delayMs)
      result = await spawn(args, opts)
    }
    return result
  }
}

function isIndexLockContention(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return lower.includes('index.lock') || (lower.includes('unable to create') && lower.includes('index.lock'))
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
