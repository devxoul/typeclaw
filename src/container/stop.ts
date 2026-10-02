import { DEFAULT_LOG_RETENTION_DAYS, loadConfigSync } from '@/config'
import { isDaemonReachable, send as sendToDaemon } from '@/hostd/client'

import { type AgentOperationLease, type WithAgentOperationLock, withAgentOperationLock } from './agent-operation-lock'
import { inspectContainerExit } from './exit-reason'
import { archiveContainerLogs, dockerLogsUnavailableWarning, type DockerLogArchiver } from './log-archive'
import {
  classifyRmStderr,
  CONTAINER_REMOVAL_TIMEOUT_MS,
  containerNameFromCwd,
  defaultDockerExec,
  type DockerExec,
  isGenuineMissingContainer,
  parseContainerInspectOutput,
  sanitizeDockerStderr,
  waitForRemoval,
} from './shared'
import { describeUnremovableContainer } from './verify-running'

export type StopPlan = {
  containerName: string
}

export type StopResult = { ok: true; containerName: string; running: boolean } | { ok: false; reason: string }

export type StopOptions = {
  cwd: string
  exec?: DockerExec
  archiveLogs?: DockerLogArchiver
  operationLock?: WithAgentOperationLock
  operationLease?: AgentOperationLease
  onWarning?: (warning: string) => void
}

export async function stop(options: StopOptions): Promise<StopResult> {
  const operationLock = options.operationLock ?? withAgentOperationLock
  try {
    const locked = await operationLock(
      { agentDir: options.cwd, operation: 'stop', lease: options.operationLease },
      async () => await runStop(options),
    )
    return locked.ok ? locked.value : { ok: false, reason: locked.reason }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function runStop({
  cwd,
  exec = defaultDockerExec,
  archiveLogs = archiveContainerLogs,
  onWarning,
}: StopOptions): Promise<StopResult> {
  const { containerName } = planStop(cwd)

  if (await isDaemonReachable()) {
    await sendToDaemon({ kind: 'deregister', containerName })
  }

  try {
    const retentionDays = resolveLogRetentionDays(cwd)
    const inspect = await exec(['inspect', '--format', '{{.Id}}|{{.State.Running}}', containerName], { cwd })
    if (inspect.exitCode !== 0) {
      // `docker inspect` exits non-zero both when the container does not
      // exist AND when it exists but is in a transient state docker cannot
      // inspect (Removal In Progress, Dead, daemon hiccup). Discriminate by
      if (isGenuineMissingContainer(inspect.stderr)) {
        return { ok: true, containerName, running: false }
      }
      return {
        ok: false,
        reason: `docker inspect failed (${sanitizeDockerStderr(inspect.stderr) || 'no stderr'}); preserving container ${containerName} because its ID and logs could not be safely identified for archival.`,
      }
    }
    const parsed = parseContainerInspectOutput(inspect.stdout)
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `docker inspect returned malformed container identity/state (${parsed.reason}); preserving container ${containerName} and its logs.`,
      }
    }
    const { containerId, running } = parsed
    const staleExit = running ? null : await inspectContainerExit(exec, containerId)

    // Only call `docker stop` when the container is actually running. A stopped
    // corpse from a prior crash is left around by design (no `--rm`), and
    // `docker stop` on an exited container would still succeed but emit a
    // noisy warning to stderr — skip it.
    if (running) {
      const stopResult = await exec(['stop', containerId], { cwd })
      if (stopResult.exitCode !== 0) {
        return { ok: false, reason: `docker stop failed: ${sanitizeDockerStderr(stopResult.stderr) || 'no stderr'}` }
      }
    }

    const archive = await archiveLogs({ agentDir: cwd, containerId, retentionDays })
    if (!archive.ok) {
      if (archive.kind === 'failed') {
        return {
          ok: false,
          reason: `Could not archive logs for container ${containerId}: ${archive.reason}. Preserving the Docker container as the source of truth.`,
        }
      }
      onWarning?.(dockerLogsUnavailableWarning(containerId))
    }
    if (staleExit?.kind === 'stopped' && staleExit.reason !== null) onWarning?.(staleExit.reason)

    // Containers run without `--rm`, so `docker stop` only stops them. Remove
    // the inspected ID without force after archival. If that same ID resumed,
    // Docker refuses the removal and we preserve it rather than killing a live
    // container whose post-archive output is no longer represented by the
    // snapshot. See classifyRmStderr for the benign-failure contract; when
    // 'in-progress', wait for the drain so stop()'s ok-return actually means
    // "name is free" (which compose restart and subsequent start depend on).
    //
    // Same waitForRemoval call on the exit-0 path for the same reason as the
    // start.ts preflight: OrbStack and Docker Desktop under load acknowledge
    // `rm` before the daemon has finished draining the removal, so an
    // immediate `docker run --name <same>` (from `typeclaw compose restart`,
    // which fires stop→start sequentially per agent) races the drain and
    // fails with "Conflict. The container name … is already in use by
    // container <ID>". stop()'s contract is that the name is free on return,
    // and the only way to honor that against Docker's async removal is to
    // poll inspect until the container actually disappears. Removal stays keyed
    // by the inspected ID so a same-name replacement cannot be deleted.
    const rmResult = await exec(['rm', containerId], { cwd })
    if (rmResult.exitCode !== 0) {
      if (isRunningContainerRemovalError(rmResult.stderr)) {
        return {
          ok: false,
          reason: `Docker refused to remove running container ${containerId} after archival; preserving it because it resumed during stop.`,
        }
      }
      const kind = classifyRmStderr(rmResult.stderr)
      if (kind === null) {
        const reason = `docker rm failed: ${sanitizeDockerStderr(rmResult.stderr) || 'no stderr'}`
        const diagnosis = await describeUnremovableContainer(exec, containerId)
        return { ok: false, reason: diagnosis === null ? reason : `${reason} ${diagnosis}` }
      }
      if (kind === 'in-progress' && !(await waitForRemoval(exec, containerName))) {
        const reason = `Container ${containerName} is still being removed by docker after ${CONTAINER_REMOVAL_TIMEOUT_MS / 1000}s.`
        const diagnosis = await describeUnremovableContainer(exec, containerId)
        return { ok: false, reason: diagnosis === null ? reason : `${reason} ${diagnosis}` }
      }
    } else if (!(await waitForRemoval(exec, containerName))) {
      const reason = `Container ${containerName} is still being removed by docker after ${CONTAINER_REMOVAL_TIMEOUT_MS / 1000}s.`
      const diagnosis = await describeUnremovableContainer(exec, containerId)
      return { ok: false, reason: diagnosis === null ? reason : `${reason} ${diagnosis}` }
    }

    return { ok: true, containerName, running }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planStop(cwd: string): StopPlan {
  return { containerName: containerNameFromCwd(cwd) }
}

function resolveLogRetentionDays(cwd: string): number {
  try {
    return loadConfigSync(cwd).logs.retentionDays
  } catch {
    // Stop must remain a recovery path when unrelated config is broken. The
    // schema default is the conservative host policy until config is repaired.
    return DEFAULT_LOG_RETENTION_DAYS
  }
}

function isRunningContainerRemovalError(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return lower.includes('cannot remove a running container') || lower.includes('container is running')
}
