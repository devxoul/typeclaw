import { validateConfig } from '@/config'
import { type Controller, resolveController } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'
import { checkFleetMemory, type AgentResult, type StartSuccess } from './start'
import type { StopSuccess } from './stop'

export type RestartData = { stop: StopSuccess; start: StartSuccess }

export type ComposeRestartEvent =
  | { kind: 'agent-start'; name: string }
  | { kind: 'agent-stopped'; name: string }
  | { kind: 'agent-done'; name: string; result: AgentResult<RestartData> }

export type ComposeRestartOptions = {
  rootCwd: string
  preferredHostPort: number
  forceBuild?: boolean
  cliEntry?: string
  onProgress?: (event: ComposeRestartEvent) => void
}

export type ComposeRestartDeps = {
  restart?: Controller['restart']
  checkMemory?: () => Promise<string[] | null>
}

export type ComposeRestartResult = {
  agents: AgentEntry[]
  results: AgentResult<RestartData>[]
  memoryWarning: string[] | null
}

export async function composeRestart(
  { rootCwd, preferredHostPort, forceBuild = false, cliEntry, onProgress }: ComposeRestartOptions,
  {
    restart = (options) => resolveController().restart(options),
    checkMemory = checkFleetMemory,
  }: ComposeRestartDeps = {},
): Promise<ComposeRestartResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<RestartData>> => {
      onProgress?.({ kind: 'agent-start', name: agent.name })
      const result = await runOne(
        agent.name,
        agent.cwd,
        preferredHostPort,
        forceBuild,
        cliEntry,
        () => onProgress?.({ kind: 'agent-stopped', name: agent.name }),
        restart,
      )
      onProgress?.({ kind: 'agent-done', name: agent.name, result })
      return result
    }),
  )
  const memoryWarning = results.some((r) => r.ok) ? await checkMemory() : null
  return { agents, results, memoryWarning }
}

async function runOne(
  name: string,
  cwd: string,
  preferredHostPort: number,
  forceBuild: boolean,
  cliEntry: string | undefined,
  onStopped: () => void,
  restart: Controller['restart'],
): Promise<AgentResult<RestartData>> {
  const validated = validateConfig(cwd)
  if (!validated.ok) return { name, ok: false, reason: validated.reason }
  const warnings = [...(validated.warnings ?? [])]
  try {
    const restarted = await restart({
      cwd,
      preferredHostPort,
      forceBuild,
      cliEntry,
      onStopped,
      streamOutput: false,
      skipMemoryOversubscriptionCheck: true,
      onWarning: (warning) => warnings.push(warning),
    })
    if (!restarted.ok) return { name, ok: false, reason: restarted.reason, warnings }
    return {
      name,
      ok: true,
      data: { stop: restarted.stop, start: restarted.start },
      warnings,
    }
  } catch (error) {
    return { name, ok: false, reason: error instanceof Error ? error.message : String(error), warnings }
  }
}
