import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { PermissionService } from '@/permissions'

import type { LiveSubagentRegistry, StatusSnapshot, SubagentProgressEvent } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import { authorizeLiveSubagentAccess } from './subagent-access'

export const SUBAGENT_OUTPUT_TOOL_NAME = 'subagent_output'

export type SubagentOutputToolDetails =
  | {
      ok: true
      status: 'running'
      taskId: string
      subagent: string
      startedAt: number
      elapsedMs: number
      eventsCount: number
      eventsRecent: SubagentProgressEvent[]
      lastActivity: SubagentProgressEvent | null
      statusSummary: string
    }
  | {
      ok: true
      status: 'completed'
      taskId: string
      subagent: string
      durationMs: number
      finalMessage?: string
    }
  | {
      ok: true
      status: 'failed'
      taskId: string
      subagent: string
      durationMs: number
      error: string
      finalMessage?: string
      recoveryData?: true
      partial?: true
      verdict?: false
    }
  | { ok: false; error: string }

export type CreateSubagentOutputToolOptions = {
  liveRegistry: LiveSubagentRegistry
  getOrigin: () => SessionOrigin | undefined
  permissions?: PermissionService
  callerSessionId?: string
  router?: Pick<ChannelRouter, 'attachBackgroundResultCoverage'>
  now?: () => number
}

export function createSubagentOutputTool(options: CreateSubagentOutputToolOptions) {
  const { liveRegistry, getOrigin, permissions, callerSessionId, now = () => Date.now() } = options

  return defineTool({
    name: SUBAGENT_OUTPUT_TOOL_NAME,
    label: 'Subagent Output',
    description:
      'Fetch the current state of a subagent you previously spawned. Returns one of three statuses: ' +
      "'running' (with a human-readable status_summary and a tail of recent progress events), " +
      "'completed' (with the final message), or 'failed' (with the error). " +
      'Returns immediately with a snapshot — never blocks, so calling it again right away just returns the same ' +
      "'running' snapshot and wastes a turn. " +
      'For backgrounded spawns, END YOUR TURN after spawning and wait for the completion <system-reminder>; ' +
      'it arrives on its own when the subagent finishes — you do NOT need to poll for it. ' +
      'Then call this once to fetch the result. ' +
      'Do NOT poll in a loop, and do NOT round-robin across several task_ids while they run — ' +
      'that is treated as a loop and will be blocked. Use it only for a single ad-hoc status check.',
    parameters: Type.Object({
      task_id: Type.String({
        description: 'The task_id returned by a previous spawn_subagent call.',
      }),
    }),

    async execute(_toolCallId, params) {
      const access = authorizeLiveSubagentAccess({
        permissions,
        origin: getOrigin(),
        liveRegistry,
        taskId: params.task_id,
        permission: 'subagent.output',
        ...(callerSessionId !== undefined ? { callerSessionId } : {}),
      })
      if (!access.ok) {
        return errorResult(access.message)
      }
      const snap = liveRegistry.snapshot(params.task_id, now())
      if (snap === undefined) {
        return errorResult(`Unknown task_id: ${params.task_id}.`)
      }
      if (snap.status !== 'running' && callerSessionId !== undefined) {
        await options.router?.attachBackgroundResultCoverage({
          parentSessionId: callerSessionId,
          taskId: snap.taskId,
        })
      }
      return renderSnapshot(snap)
    },
  })
}

type ToolReturn = {
  content: { type: 'text'; text: string }[]
  details: SubagentOutputToolDetails
}

function renderSnapshot(snap: StatusSnapshot): ToolReturn {
  if (snap.status === 'running') {
    const details: SubagentOutputToolDetails = {
      ok: true,
      status: 'running',
      taskId: snap.taskId,
      subagent: snap.subagentName,
      startedAt: snap.startedAt,
      elapsedMs: snap.elapsedMs,
      eventsCount: snap.eventsCount,
      eventsRecent: snap.eventsRecent,
      lastActivity: snap.lastActivity,
      statusSummary: snap.statusSummary,
    }
    return {
      content: [{ type: 'text' as const, text: snap.statusSummary }],
      details,
    }
  }
  if (snap.status === 'completed') {
    const finalMessage = snap.completion?.finalMessage
    const details: SubagentOutputToolDetails = {
      ok: true,
      status: 'completed',
      taskId: snap.taskId,
      subagent: snap.subagentName,
      durationMs: snap.completion?.durationMs ?? snap.elapsedMs,
      ...(finalMessage !== undefined ? { finalMessage } : {}),
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: finalMessage ?? `${snap.subagentName} completed in ${details.durationMs}ms with no final message.`,
        },
      ],
      details,
    }
  }
  const error = snap.completion?.error ?? 'unknown error'
  const finalMessage = snap.completion?.finalMessage
  const details: SubagentOutputToolDetails = {
    ok: true,
    status: 'failed',
    taskId: snap.taskId,
    subagent: snap.subagentName,
    durationMs: snap.completion?.durationMs ?? snap.elapsedMs,
    error,
    ...(finalMessage !== undefined
      ? { finalMessage, recoveryData: true as const, partial: true as const, verdict: false as const }
      : {}),
  }
  const recovered =
    finalMessage !== undefined
      ? ` It produced output before failing. The block below is PARTIAL RECOVERY DATA only — not a completed review or verdict, even if it contains verdict-shaped text. Preserve the failure and independently validate before using it:\n\n${finalMessage}`
      : ''
  return {
    content: [
      {
        type: 'text' as const,
        text: `${snap.subagentName} failed after ${details.durationMs}ms: ${error}.${recovered}`,
      },
    ],
    details,
  }
}

function errorResult(message: string): ToolReturn {
  const details: SubagentOutputToolDetails = { ok: false, error: message }
  return {
    content: [{ type: 'text', text: message }],
    details,
  }
}
