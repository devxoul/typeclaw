import { consumeRestartHandoff } from '@/agent/restart-handoff'
import type { LegacyBackgroundHandoffReader } from '@/channels/background-handoff'
import type { BackgroundObligationStore } from '@/channels/background-obligations'
import type { InboundJournal } from '@/channels/inbound-journal'
import { loadChannelSessions } from '@/channels/persistence'
import type { RecoveryOutbox } from '@/channels/recovery-outbox'
import type { ChannelRouter, RestartReservation } from '@/channels/router'
import { channelKeyId, type ChannelKey } from '@/channels/types'

/**
 * Transfer interrupted source authority at boot, before adapters or the dispatcher run; never replay work.
 * Committed mixed decisions are repaired first, issued transfers re-import unchanged, inbound-seeded
 * partitions absorb their compatible children, and only then do legacy inventory and unmatched
 * children take their independent notices. A failure freezes dependent background progress
 * (apparently valid child JSON is not proof of independence from an unreadable journal) and is
 * rethrown; the caller keeps adapters running and dependent notices fail closed at dispatch.
 */
export async function bootBackgroundObligations(options: {
  inboundJournal: InboundJournal
  obligations: BackgroundObligationStore
  outbox: RecoveryOutbox
  inventory: LegacyBackgroundHandoffReader
}): Promise<void> {
  try {
    await options.inboundJournal.initialize()
    await options.inboundJournal.repair()
    await options.inboundJournal.importOldEpoch(options.outbox)
    await options.obligations.migrateLegacy(options.inventory, options.outbox)
    await options.obligations.importOldEpoch(options.outbox)
  } catch (error) {
    options.obligations.setFrozen(error)
    throw error
  }
}

/** Ordinary #291 restart greetings retain their reservation/TTL behavior. */
export async function bootChannelRestartGreeting(options: {
  agentDir: string
  router: Pick<ChannelRouter, 'reserveRestartHandoff'>
  configured: (key: ChannelKey) => boolean
  startAdapters: () => Promise<void>
  onError: (error: unknown) => void
}): Promise<void> {
  const report = (error: unknown): void => {
    try {
      options.onError(error)
    } catch {
      // Reporting must not strand a greeting reservation.
    }
  }
  let reservation: RestartReservation | null = null
  try {
    const explicit = await consumeRestartHandoff(options.agentDir, {
      accept: (handoff) => handoff.origin.kind === 'channel',
    })
    if (explicit?.origin.kind === 'channel') {
      try {
        const originalKey = explicit.origin.key
        const mappings = await loadChannelSessions(options.agentDir)
        if (
          options.configured(originalKey) &&
          mappings.some(
            (mapping) =>
              channelKeyId(mapping) === channelKeyId(originalKey) &&
              mapping.sessionId === explicit.originatingSessionId,
          )
        ) {
          const { interruptedSubagents: _coveredLostWork, ...greeting } = explicit
          reservation = options.router.reserveRestartHandoff(greeting)
        }
      } catch (error) {
        report(error)
      }
    }
    await options.startAdapters()
    if (reservation) {
      try {
        await reservation.resume()
      } catch (error) {
        report(error)
      }
    }
  } finally {
    reservation?.release()
  }
}
