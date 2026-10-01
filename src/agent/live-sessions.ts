import type { AgentSession } from './index'
import type { MinimalSessionOrigin } from './session-meta'

export type LiveAgentSession = {
  sessionId: string
  session: Pick<AgentSession, 'subscribe'>
  // Surfaced by the inspect picker for sessions not yet on disk: pi-coding-agent
  // defers the first .jsonl write until the first user message, so without
  // these a session that has not been prompted yet is invisible. Optional so subscribe-only test
  // harnesses can still register `{ sessionId, session }`; live-listing skips
  // entries lacking an origin.
  origin?: MinimalSessionOrigin
  registeredAtMs?: number
}

export class LiveSessionRegistry {
  private readonly entries = new Map<string, LiveAgentSession>()

  register(live: LiveAgentSession): void {
    this.entries.set(live.sessionId, live)
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  get(sessionId: string): LiveAgentSession | undefined {
    return this.entries.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  listLive(): LiveAgentSession[] {
    return [...this.entries.values()].filter((e) => e.origin !== undefined)
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
