import { readFileSync } from 'node:fs'

export type OomEventCounts = { oom: number; oomKill: number }
export type OomEventsReader = () => OomEventCounts | null

// Docker's private cgroup namespace exposes its own v2 root here. Cgroup v1,
// dev hosts and unreadable/malformed files provide no reliable pair: fail open.
export function readOomEvents(path = '/sys/fs/cgroup/memory.events'): OomEventCounts | null {
  try {
    const events = readFileSync(path, 'utf8')
    const oom = /^oom (\d+)$/m.exec(events)
    const oomKill = /^oom_kill (\d+)$/m.exec(events)
    if (oom === null || oomKill === null) return null
    const counts = { oom: Number(oom[1]), oomKill: Number(oomKill[1]) }
    return Number.isSafeInteger(counts.oom) && Number.isSafeInteger(counts.oomKill) ? counts : null
  } catch {
    return null
  }
}

export function readMemoryLimitMiB(path = '/sys/fs/cgroup/memory.max'): number | null {
  try {
    const bytes = readFileSync(path, 'utf8').trim()
    if (!/^\d+$/.test(bytes)) return null
    const value = Number(bytes)
    return Number.isSafeInteger(value) ? Math.round(value / 1048576) : null
  } catch {
    return null
  }
}

const claimedCounts = new Map<number, string>()
const reportedCounts = new Set<number>()

// memory.events is CONTAINER-wide: a concurrent unrelated OOM may increase
// either counter during this command. A limit event plus kill is evidence of
// container pressure, not proof that the observed child was the victim.
export function toolOomNote(
  before: OomEventCounts | null,
  exitCode: number,
  tool: string,
  options: { read?: OomEventsReader; limitMiB?: () => number | null; log?: (line: string) => void } = {},
): string | null {
  if (exitCode !== 137 || before === null) return null
  const after = (options.read ?? readOomEvents)()
  if (after === null || after.oomKill <= before.oomKill) return null
  // Only a single new event can be claimed unambiguously. A sampler may
  // already have logged it before this command's stdout finished draining.
  if (after.oomKill === before.oomKill + 1) claimedCounts.set(after.oomKill, tool)
  const limit = (options.limitMiB ?? readMemoryLimitMiB)()
  const reachedLimit = after.oom > before.oom
  const detail = reachedLimit
    ? `the container reached its memory limit${limit === null ? '' : ` (${limit} MiB)`}`
    : `without a container memory-limit event${limit === null ? '' : ` (configured limit ${limit} MiB)`}`
  if (!reportedCounts.has(after.oomKill)) {
    options.log?.(`[tool] ${tool} subprocess SIGKILL; OOM kill observed while command ran; ${detail}`)
  }
  return `An OOM kill was observed while this command ran (exit 137); ${detail}. Reduce parallelism or memory use before retrying.`
}

export function unclaimedOomEvents(
  previous: OomEventCounts,
  current: OomEventCounts,
): { from: number; to: number; claimed: string[]; reachedLimit: boolean } | null {
  if (current.oomKill <= previous.oomKill) return null
  const claimed: string[] = []
  let unclaimed = false
  for (let count = previous.oomKill + 1; count <= current.oomKill; count++) {
    const tool = claimedCounts.get(count)
    if (tool === undefined) {
      unclaimed = true
      reportedCounts.add(count)
    } else {
      claimed.push(tool)
    }
    claimedCounts.delete(count)
  }
  // Retain a bounded window for a late tool completion after the sampler's
  // tick. Its model note still arrives, but the operator need not see two lines.
  for (const count of reportedCounts) {
    if (count < current.oomKill - 64) reportedCounts.delete(count)
  }
  return unclaimed
    ? { from: previous.oomKill, to: current.oomKill, claimed, reachedLimit: current.oom > previous.oom }
    : null
}
