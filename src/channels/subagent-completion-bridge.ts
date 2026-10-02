import { parseSubagentCompletedPayload } from '@/agent/subagent-completion-reminder'
import type { Stream } from '@/stream'

import type { ChannelRouter } from './router'

export type SubagentCompletionBridgeLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

export type SubagentCompletionBridgeOptions = {
  stream: Stream
  router: Pick<ChannelRouter, 'injectSubagentCompletionReminder'>
  logger?: SubagentCompletionBridgeLogger
}

export type SubagentCompletionBridge = {
  stop: () => void
}

const consoleLogger: SubagentCompletionBridgeLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
}

// Bridges `subagent.completed` broadcasts on the in-process Stream into a
// channel router call so the channel session that spawned the subagent
// gets woken up with a `<system-reminder>` when the subagent finishes.
//
// Two-bridges-for-two-surfaces design (matches the TUI side at
// src/server/index.ts `routeSubagentCompletionReminder`):
//
//   - TUI sessions: the WS server subscribes to broadcasts on the same
//     stream and re-publishes the reminder as `target: { kind: 'session' }`
//     so the per-session drain loop in the server picks it up. Lookup is
//     by sessionId (which is `state.sessionFileId`).
//
//   - Channel sessions: this bridge subscribes and calls
//     `router.injectSubagentCompletionReminder` because the channel router
//     owns its own per-key drain loop and doesn't use the stream's
//     session-keyed target.
//
// `parentSessionId` matching is the same on both sides: when a channel
// session spawns a subagent via `spawn_subagent`, the tool captures
// `sessionManager.getSessionId()` and publishes it as the broadcast's
// `parentSessionId`. That id is exactly what the router stores on each
// `LiveSession`, so the lookup is O(N) over live sessions with N small
// (one per active conversation).
//
// On `no-live-session`, live routing stops but the durable response remains owed.
// For a channel session, the broadcast carries the channel-key coordinate
// `{ adapter, workspace, chat, thread }`, and the router first tries to
// reroute to the live successor session for that key — covering the two
// common drop paths where the exact sessionId is gone but the
// conversation lives on:
//
//   - The parent session was GC'd by the idle-eviction tick
//     (SESSION_IDLE_MS) while the subagent was running.
//   - The parent session rolled over (SESSION_FRESHNESS_TTL_MS) when a
//     new inbound arrived during a long-running subagent.
//
// A reminder still reaching this branch means there is no live session
// for the key at all (the whole conversation went idle), or the parent
// was a TUI session (handled by the TUI bridge in src/server/index.ts).
// Logged at warn so absent-parent completion routing remains diagnosable.
export function createSubagentCompletionBridge(options: SubagentCompletionBridgeOptions): SubagentCompletionBridge {
  const logger = options.logger ?? consoleLogger
  const unsubscribe = options.stream.subscribe({ target: { kind: 'broadcast' } }, async (msg) => {
    const parsed = parseSubagentCompletedPayload(msg.payload)
    if (parsed === null) return
    try {
      const result = await options.router.injectSubagentCompletionReminder(parsed)
      if (result.kind === 'no-live-session') {
        const keyInfo =
          parsed.channelKey !== undefined
            ? ` channelKey=${parsed.channelKey.adapter}:${parsed.channelKey.workspace}:${parsed.channelKey.chat}:${parsed.channelKey.thread ?? ''}`
            : ''
        logger.warn(
          `[channels] subagent-completion reminder not routed: no live session for parentSessionId=${parsed.parentSessionId} task=${parsed.taskId}${keyInfo}`,
        )
      }
    } catch {
      logger.warn(`[channels] subagent-completion admission failed: task=${parsed.taskId}; response remains owed`)
    }
  })
  return { stop: unsubscribe }
}
