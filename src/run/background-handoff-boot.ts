import { consumeRestartHandoff } from '@/agent/restart-handoff'
import type { LegacyBackgroundHandoffReader } from '@/channels/background-handoff'
import type { BackgroundObligationStore } from '@/channels/background-obligations'
import { loadChannelSessions } from '@/channels/persistence'
import type { RecoveryOutbox } from '@/channels/recovery-outbox'
import type { ChannelRouter, RestartReservation } from '@/channels/router'
import { channelKeyId, type ChannelKey } from '@/channels/types'

/** Migrate source authority before adapters can dispatch; never replay child work. */
export async function bootBackgroundObligations(options: {
  obligations: BackgroundObligationStore
  outbox: RecoveryOutbox
  inventory: LegacyBackgroundHandoffReader
}): Promise<void> {
  await options.obligations.migrateLegacy(options.inventory, options.outbox)
  await options.obligations.importOldEpoch(options.outbox)
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
