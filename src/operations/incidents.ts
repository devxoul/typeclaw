import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import lockfile from 'proper-lockfile'

import { deriveOperationalIncidentFactsForSuccess } from './classify-tool-outcome'
import type { OperationalIncidentFact, OperationalIncidentSuccessInput } from './classify-tool-outcome'

export type IncidentStatus = 'unresolved' | 'resolved'

export type OperationalIncident = {
  fingerprint: string
  kind: OperationalIncidentFact['kind']
  bin?: string
  count: number
  firstSeenAt: string
  lastSeenAt: string
  lastSessionId: string
  status: IncidentStatus
  recurrent: boolean
}

export type IncidentLedgerFile = { version: 1; incidents: OperationalIncident[] }

type LedgerInspection = { kind: 'missing' } | { kind: 'unknown' } | { kind: 'present'; version: string; size: number }

export type IncidentLedgerIo = {
  inspect: (path: string) => Promise<LedgerInspection>
  read: (agentDir: string) => Promise<IncidentLedgerFile>
  serialize: (path: string, operation: () => Promise<void>) => Promise<void>
}

type OpenIncidentSnapshot = { version?: string; fingerprints: Set<string> }

const LOCK_RETRIES = { retries: 600, factor: 1, minTimeout: 10, maxTimeout: 10, randomize: false } as const
const openIncidentSnapshots = new Map<string, OpenIncidentSnapshot>()

export function incidentsPath(agentDir: string): string {
  return join(agentDir, '.typeclaw', 'incidents.json')
}

export function fingerprintIncident(fact: OperationalIncidentFact): string {
  switch (fact.kind) {
    case 'sandbox-proc-unavailable':
      return 'sandbox:proc-unavailable'
    case 'bash-command-not-found':
      return `bash:command-not-found:${normalizeBin(fact.bin)}`
    case 'declared-skill-bin-unresolved':
      return `skill-bin:declared-but-unresolved:${normalizeBin(fact.bin)}`
    case 'builtin-search-bin-unavailable':
      return `builtin-search:bin-unavailable:${fact.bin}`
  }
}

export function deriveMechanicallyVerifiedIncidentFingerprints(input: OperationalIncidentSuccessInput): Set<string> {
  return new Set(deriveOperationalIncidentFactsForSuccess(input).map(fingerprintIncident))
}

export async function readIncidentLedger(agentDir: string): Promise<IncidentLedgerFile> {
  try {
    const parsed = JSON.parse(await readFile(incidentsPath(agentDir), 'utf8')) as unknown
    return parseLedger(parsed)
  } catch {
    return { version: 1, incidents: [] }
  }
}

const DEFAULT_INCIDENT_LEDGER_IO: IncidentLedgerIo = {
  inspect: inspectLedger,
  read: readIncidentLedger,
  serialize,
}

export class IncidentLedger {
  constructor(
    private readonly agentDir: string,
    private readonly io: IncidentLedgerIo = DEFAULT_INCIDENT_LEDGER_IO,
  ) {}

  async record(fact: OperationalIncidentFact, sessionId: string, now = new Date()): Promise<OperationalIncident> {
    const path = incidentsPath(this.agentDir)
    let recorded: OperationalIncident | undefined
    await this.io.serialize(path, async () => {
      const ledger = await this.io.read(this.agentDir)
      const fingerprint = fingerprintIncident(fact)
      const timestamp = now.toISOString()
      const existing = ledger.incidents.find((incident) => incident.fingerprint === fingerprint)
      if (existing === undefined) {
        recorded = {
          fingerprint,
          kind: fact.kind,
          ...(fact.kind === 'sandbox-proc-unavailable' ? {} : { bin: normalizeBin(fact.bin) }),
          count: 1,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastSessionId: sessionId,
          status: 'unresolved',
          recurrent: false,
        }
        ledger.incidents.push(recorded)
      } else {
        existing.count += 1
        existing.lastSeenAt = timestamp
        existing.status = 'unresolved'
        existing.recurrent ||= existing.lastSessionId !== sessionId
        existing.lastSessionId = sessionId
        recorded = existing
      }
      ledger.incidents.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
      await persistLedger(path, ledger)
      rememberOpenIncidents(path, ledger, await this.io.inspect(path))
    })
    if (recorded === undefined) throw new Error('incident ledger record was not created')
    return { ...recorded }
  }

  async resolve(fingerprint: string): Promise<boolean> {
    return (await this.resolveCandidates(new Set([fingerprint]))).found > 0
  }

  async resolveObservedSuccess(fingerprints: Iterable<string>): Promise<number> {
    const candidates = new Set(fingerprints)
    if (candidates.size === 0) return 0
    const path = incidentsPath(this.agentDir)
    const cached = openIncidentSnapshots.get(path)
    if (cached !== undefined && intersects(cached.fingerprints, candidates)) {
      return (await this.resolveCandidates(candidates)).resolved
    }

    const inspection = await this.io.inspect(path)
    if (inspection.kind === 'unknown') return 0
    if (inspection.kind === 'missing' || inspection.size === 0) {
      openIncidentSnapshots.set(path, {
        ...(inspection.kind === 'present' ? { version: inspection.version } : {}),
        fingerprints: new Set(),
      })
      return 0
    }
    if (cached?.version === inspection.version) return 0

    const ledger = await this.io.read(this.agentDir)
    rememberOpenIncidents(path, ledger, inspection)
    if (!intersects(openIncidentSnapshots.get(path)?.fingerprints ?? new Set(), candidates)) return 0
    return (await this.resolveCandidates(candidates)).resolved
  }

  private async resolveCandidates(candidates: Set<string>): Promise<{ found: number; resolved: number }> {
    const path = incidentsPath(this.agentDir)
    let found = 0
    let resolved = 0
    await this.io.serialize(path, async () => {
      const ledger = await this.io.read(this.agentDir)
      for (const incident of ledger.incidents) {
        if (!candidates.has(incident.fingerprint)) continue
        found += 1
        if (incident.status === 'resolved') continue
        incident.status = 'resolved'
        resolved += 1
      }
      if (resolved > 0) await persistLedger(path, ledger)
      rememberOpenIncidents(path, ledger, await this.io.inspect(path))
    })
    return { found, resolved }
  }
}

export function renderIncidentHint(incident: OperationalIncident): string {
  return `TYPECLAW_OPERATIONAL_INCIDENT ${JSON.stringify({
    fingerprint: incident.fingerprint,
    occurrence: incident.count,
    recurrent: incident.recurrent,
    status: incident.status,
    automaticRepair: 'unavailable',
    provenance: 'typeclaw-environment',
    action: incident.recurrent
      ? 'escalate-recurrent-environment-issue-to-operator'
      : 'report-environment-issue-to-operator',
    doNot: 'delegate-the-original-task-to-the-user',
  })}`
}

export function renderUntrackedIncidentHint(fact: OperationalIncidentFact): string {
  return `TYPECLAW_OPERATIONAL_INCIDENT ${JSON.stringify({
    fingerprint: fingerprintIncident(fact),
    recurrenceTracking: 'unavailable',
    status: 'unresolved',
    automaticRepair: 'unavailable',
    provenance: 'typeclaw-environment',
    action: 'report-environment-issue-to-operator',
    doNot: 'delegate-the-original-task-to-the-user',
  })}`
}

function normalizeBin(bin: string): string {
  return bin.toLocaleLowerCase('en-US')
}

function parseLedger(value: unknown): IncidentLedgerFile {
  if (typeof value !== 'object' || value === null) return { version: 1, incidents: [] }
  const incidents = (value as { incidents?: unknown }).incidents
  if (!Array.isArray(incidents)) return { version: 1, incidents: [] }
  return { version: 1, incidents: incidents.filter(isIncident) }
}

function isIncident(value: unknown): value is OperationalIncident {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<OperationalIncident>
  return (
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.kind === 'string' &&
    typeof candidate.count === 'number' &&
    Number.isInteger(candidate.count) &&
    candidate.count > 0 &&
    typeof candidate.firstSeenAt === 'string' &&
    typeof candidate.lastSeenAt === 'string' &&
    typeof candidate.lastSessionId === 'string' &&
    (candidate.status === 'unresolved' || candidate.status === 'resolved') &&
    typeof candidate.recurrent === 'boolean'
  )
}

function rememberOpenIncidents(path: string, ledger: IncidentLedgerFile, inspection: LedgerInspection): void {
  openIncidentSnapshots.set(path, {
    ...(inspection.kind === 'present' ? { version: inspection.version } : {}),
    fingerprints: new Set(
      ledger.incidents.filter((incident) => incident.status === 'unresolved').map((incident) => incident.fingerprint),
    ),
  })
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

async function inspectLedger(path: string): Promise<LedgerInspection> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { kind: 'missing' }
    return {
      kind: 'present',
      version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
      size: info.size,
    }
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'unknown' }
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

async function persistLedger(path: string, ledger: IncidentLedgerFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

async function serialize(path: string, operation: () => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 10_000,
    update: 2_000,
    retries: LOCK_RETRIES,
  })
  try {
    await operation()
  } finally {
    await release().catch(() => undefined)
  }
}
