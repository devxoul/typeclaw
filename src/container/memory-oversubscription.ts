import { COMPOSE_PROJECT } from './compose-project'
import { HOST_HEADROOM_BYTES, readDockerTotalMemory } from './memory-limit'
import type { DockerExec } from './shared'

// `bytes: null` means the container runs with NO memory limit. That is a
// distinct, worse state than a large limit, not a missing reading: a pre-upgrade
// agent still running unbounded is exactly the thing that can exhaust the host,
// so it must stay on the roster rather than being dropped from the sum.
export type AgentMemoryClaim = {
  containerName: string
  bytes: number | null
}

export type OversubscriptionWarning = {
  claims: AgentMemoryClaim[]
  claimedBytes: number
  // null when the daemon total could not be read. An unbounded agent is still
  // worth reporting without it, so this is not a reason to stay silent.
  totalMemoryBytes: number | null
  unbounded: AgentMemoryClaim[]
}

// Warn, never block.
//
// The sum of every agent's cap is what the machine is on the hook for if they
// all peak together, so a total above the machine's memory means the caps do
// not actually bound the host — they only bound each agent individually, and
// the host can still be driven into the swap-backed reclaim livelock the caps
// exist to prevent.
//
// This deliberately does not stop the start. A fleet that has run fine at a
// nominal oversubscription for months would otherwise be bricked by an upgrade,
// and refusing to start an agent is a far worse failure than running one on a
// crowded host. The operator gets the arithmetic and decides.
export function decideMemoryOversubscription(options: {
  running: AgentMemoryClaim[]
  // Omitted for a fleet-wide check run after every agent is already up.
  incoming?: AgentMemoryClaim
  totalMemoryBytes: number | undefined
}): OversubscriptionWarning | null {
  const { running, incoming, totalMemoryBytes } = options

  // A restart re-runs start for a container that is already listed, so drop any
  // running claim under the incoming name before summing. Counting it twice
  // would fire the warning on a plain `typeclaw restart` of a single agent.
  const claims =
    incoming === undefined
      ? running
      : [...running.filter((claim) => claim.containerName !== incoming.containerName), incoming]
  const unbounded = claims.filter((claim) => claim.bytes === null)
  const claimedBytes = claims.reduce((sum, claim) => sum + (claim.bytes ?? 0), 0)

  const total =
    totalMemoryBytes !== undefined && Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
      ? totalMemoryBytes
      : null

  // Unbounded detection deliberately precedes the unknown-total guard.
  // Identifying an agent running with no ceiling needs no capacity arithmetic,
  // so an unreadable daemon total must not suppress it — and since the total is
  // now genuinely unknown rather than silently backfilled from the workstation,
  // that case is reachable in normal operation.
  if (unbounded.length === 0 && (total === null || claimedBytes <= total)) return null

  return { claims, claimedBytes, totalMemoryBytes: total, unbounded }
}

export function formatOversubscriptionWarning(warning: OversubscriptionWarning): string[] {
  const gib = (bytes: number): string => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GiB`
  const roster = warning.claims
    .map((claim) => `  ${claim.containerName} ${claim.bytes === null ? 'unlimited' : gib(claim.bytes)}`)
    .sort((a, b) => a.localeCompare(b))

  const capacity = warning.totalMemoryBytes === null ? null : gib(warning.totalMemoryBytes)
  const names = warning.unbounded.map((claim) => claim.containerName).join(', ')
  const headline =
    warning.unbounded.length > 0
      ? `${names} ${warning.unbounded.length === 1 ? 'is' : 'are'} running with no memory limit` +
        (capacity === null ? ', and Docker capacity could not be read.' : `, against ${capacity} of Docker memory.`)
      : `Agent memory limits total ${gib(warning.claimedBytes)} against ${capacity ?? 'an unknown amount'} of Docker memory.`

  const remedy =
    warning.unbounded.length > 0
      ? ['An unbounded agent can exhaust the host on its own. Restart it to apply', 'the current limit.']
      : oversubscriptionRemedy(warning.claimedBytes)

  return [headline, ...roster, ...remedy]
}

function oversubscriptionRemedy(claimedBytes: number): string[] {
  const targetGib = Math.ceil((claimedBytes + HOST_HEADROOM_BYTES) / (1024 * 1024 * 1024))
  return [
    'If they peak together the host can still exhaust. Either:',
    '  • Stop an agent: run `typeclaw stop` in its folder.',
    `  • Give Docker at least ${targetGib}GiB of memory, then restart the runtime:`,
    '      Docker Desktop: Settings → Resources → Memory limit → Apply & restart',
    `      OrbStack:       orb config set memory_mib ${targetGib * 1024}`,
    `      Colima:         colima stop && colima start --memory ${targetGib}`,
    '      Linux Engine:   Docker uses host RAM directly; stop an agent instead.',
  ]
}

// Fleet-wide variant for `typeclaw compose`: agents start concurrently, so a
// per-agent check sees whichever siblings happened to be up and repeats the same
// advice once per agent. Checking once after the whole fleet settled reports the
// real total exactly once.
export async function readFleetMemoryOversubscription(exec: DockerExec): Promise<OversubscriptionWarning | null> {
  const [running, totalMemoryBytes] = await Promise.all([
    readRunningAgentMemoryClaims(exec),
    readDockerTotalMemory(exec),
  ])
  return decideMemoryOversubscription({ running, totalMemoryBytes })
}

// Reads the memory cap Docker actually applied to every running agent. Docker
// reports 0 for a container created with no limit, which is UNLIMITED, not
// missing — an agent started before this field existed is precisely the case
// worth reporting, so it is preserved as a null claim rather than dropped.
export async function readRunningAgentMemoryClaims(exec: DockerExec): Promise<AgentMemoryClaim[]> {
  const listed = await exec([
    'ps',
    '--filter',
    `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--format',
    '{{.Names}}',
  ])
  if (listed.exitCode !== 0) return []
  const names = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (names.length === 0) return []

  const inspected = await exec(['inspect', '--format', '{{.Name}} {{.HostConfig.Memory}}', ...names])
  if (inspected.exitCode !== 0) return []
  return parseAgentMemoryClaims(inspected.stdout)
}

export function parseAgentMemoryClaims(output: string): AgentMemoryClaim[] {
  const claims: AgentMemoryClaim[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const separator = trimmed.lastIndexOf(' ')
    if (separator < 0) continue
    const raw = Number(trimmed.slice(separator + 1))
    if (!Number.isFinite(raw) || raw < 0) continue
    // `docker inspect` renders a container name with a leading slash.
    const containerName = trimmed.slice(0, separator).replace(/^\//, '')
    if (containerName.length === 0) continue
    claims.push({ containerName, bytes: raw === 0 ? null : raw })
  }
  return claims
}
