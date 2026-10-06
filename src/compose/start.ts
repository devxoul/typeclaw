import { validateConfig } from '@/config'
import {
  type Controller,
  defaultDockerExec,
  formatOversubscriptionWarning,
  readFleetMemoryOversubscription,
  resolveController,
  type StartResult,
} from '@/container'

import { discoverAgents, type AgentEntry } from './discover'

export type AgentResult<T> =
  | { name: string; ok: true; data: T; warnings?: string[] }
  | { name: string; ok: false; reason: string; warnings?: string[] }

export type StartSuccess = Extract<StartResult, { ok: true }>

export type ComposeStartEvent =
  | { kind: 'agent-start'; name: string }
  | { kind: 'agent-done'; name: string; result: AgentResult<StartSuccess> }

export type ComposeStartOptions = {
  rootCwd: string
  preferredHostPort: number
  forceBuild?: boolean
  cliEntry?: string
  onProgress?: (event: ComposeStartEvent) => void
}

export type ComposeStartDeps = {
  start?: Controller['start']
  checkMemory?: () => Promise<string[] | null>
}

export type ComposeStartResult = {
  agents: AgentEntry[]
  results: AgentResult<StartSuccess>[]
  // Fleet-wide, reported once — see readFleetMemoryOversubscription.
  memoryWarning: string[] | null
}

export async function composeStart(
  { rootCwd, preferredHostPort, forceBuild = false, cliEntry, onProgress }: ComposeStartOptions,
  { start = (options) => resolveController().start(options), checkMemory = checkFleetMemory }: ComposeStartDeps = {},
): Promise<ComposeStartResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<StartSuccess>> => {
      onProgress?.({ kind: 'agent-start', name: agent.name })
      const result = await runOne(agent.name, agent.cwd, preferredHostPort, forceBuild, cliEntry, start)
      onProgress?.({ kind: 'agent-done', name: agent.name, result })
      return result
    }),
  )
  const memoryWarning = results.some((r) => r.ok) ? await checkMemory() : null
  return { agents, results, memoryWarning }
}

export async function checkFleetMemory(): Promise<string[] | null> {
  const warning = await readFleetMemoryOversubscription(defaultDockerExec)
  return warning === null ? null : formatOversubscriptionWarning(warning)
}

async function runOne(
  name: string,
  cwd: string,
  preferredHostPort: number,
  forceBuild: boolean,
  cliEntry: string | undefined,
  start: Controller['start'],
): Promise<AgentResult<StartSuccess>> {
  const validated = validateConfig(cwd)
  if (!validated.ok) return { name, ok: false, reason: validated.reason }
  const warnings = [...(validated.warnings ?? [])]
  try {
    const data = await start({
      cwd,
      preferredHostPort,
      forceBuild,
      cliEntry,
      streamOutput: false,
      skipMemoryOversubscriptionCheck: true,
      onWarning: (warning) => warnings.push(warning),
    })
    if (!data.ok) return { name, ok: false, reason: data.reason, warnings }
    return { name, ok: true, data, warnings }
  } catch (error) {
    return { name, ok: false, reason: error instanceof Error ? error.message : String(error), warnings }
  }
}
