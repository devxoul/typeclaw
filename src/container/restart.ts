import { type AgentOperationLease, type WithAgentOperationLock, withAgentOperationLock } from './agent-operation-lock'
import { type CurrentHostDaemon, start, type StartResult } from './start'
import { stop, type StopResult } from './stop'

export type RestartOptions = {
  cwd: string
  preferredHostPort: number
  forceBuild?: boolean
  streamOutput?: boolean
  onWarning?: (warning: string) => void
  skipMemoryOversubscriptionCheck?: boolean
  cliEntry?: string
  reuseCurrentHostDaemon?: boolean
  currentHostDaemon?: CurrentHostDaemon
  onStopped?: (result: Extract<StopResult, { ok: true }>) => void
  operationLock?: WithAgentOperationLock
  operationLease?: AgentOperationLease
}

export type RestartResult =
  | { ok: true; stop: Extract<StopResult, { ok: true }>; start: Extract<StartResult, { ok: true }> }
  | { ok: false; reason: string }

export async function restart(options: RestartOptions): Promise<RestartResult> {
  const operationLock = options.operationLock ?? withAgentOperationLock
  try {
    const locked = await operationLock(
      { agentDir: options.cwd, operation: 'restart', lease: options.operationLease },
      async (lease) => await restartWithLease(options, lease, operationLock),
    )
    return locked.ok ? locked.value : { ok: false, reason: locked.reason }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function restartWithLease(
  options: RestartOptions,
  lease: AgentOperationLease,
  operationLock: WithAgentOperationLock,
): Promise<RestartResult> {
  const stopped = await stop({
    cwd: options.cwd,
    onWarning: options.onWarning,
    operationLock,
    operationLease: lease,
  })
  if (!stopped.ok) return { ok: false, reason: `stop failed: ${stopped.reason}` }
  options.onStopped?.(stopped)

  const started = await start({
    cwd: options.cwd,
    preferredHostPort: options.preferredHostPort,
    forceBuild: options.forceBuild,
    streamOutput: options.streamOutput,
    onWarning: options.onWarning,
    skipMemoryOversubscriptionCheck: options.skipMemoryOversubscriptionCheck,
    cliEntry: options.cliEntry,
    reuseCurrentHostDaemon: options.reuseCurrentHostDaemon,
    currentHostDaemon: options.currentHostDaemon,
    operationLock,
    operationLease: lease,
  })
  if (!started.ok) return { ok: false, reason: `start failed: ${started.reason}` }
  return { ok: true, stop: stopped, start: started }
}
