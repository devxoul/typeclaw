import { createHash } from 'node:crypto'

import { consumeRestartHandoff } from '@/agent/restart-handoff'
import { resolveBackgroundRecoveryIdentity } from '@/channels/background-handoff'
import type { BackgroundHandoffInventory, ClaimedBackgroundInventory } from '@/channels/background-handoff'
import type { RecoveryRecord } from '@/channels/continuity-types'
import { loadChannelSessions } from '@/channels/persistence'
import { createRecoveryNotice } from '@/channels/recovery-notice'
import type { RecoveryOutbox } from '@/channels/recovery-outbox'
import type { ChannelRouter, RestartReservation } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import { channelKeyId, type ChannelKey } from '@/channels/types'

export type BackgroundRecoveryImportOptions = {
  inventory: BackgroundHandoffInventory
  outbox: RecoveryOutbox
  prepare: (claim: ClaimedBackgroundInventory) => Promise<RecoveryRecord>
  onError: (error: unknown) => void
}
export async function prepareBackgroundRecoveryNotice(claim: ClaimedBackgroundInventory): Promise<RecoveryRecord> {
  const source = claim.record
  const identity = JSON.stringify([channelKeyId(source.key), source.parentSessionId, source.generationId])
  const transferId = createHash('sha256').update(`inventory-transfer:${identity}`).digest('hex')
  return createRecoveryNotice({
    target: source.key,
    ...resolveBackgroundRecoveryIdentity(source),
    principal: {
      kind: 'channel',
      adapter: source.key.adapter as AdapterId,
      workspace: source.key.workspace,
      chat: source.key.chat,
      ...(source.parentChat !== undefined ? { parentChat: source.parentChat } : {}),
      ...(source.triggeringAuthorId ? { lastInboundAuthorId: source.triggeringAuthorId } : {}),
    },
    covers: source.tasks.map((task) => ({
      store: 'inventory' as const,
      id: createHash('sha256').update(`inventory:${identity}:${task.taskId}`).digest('hex'),
      generation: 1,
    })),
    recoveryGeneration: `${source.generationId}:${source.parentSessionId}`,
    transferId,
    sourceParentSessionId: source.parentSessionId,
  })
}

export async function importBackgroundRecoveryNotices(options: BackgroundRecoveryImportOptions): Promise<void> {
  for (const claim of await options.inventory.claim()) {
    try {
      // Persist the immutable transfer before import. Reboots use these bytes,
      // not a newly resolved account, boot epoch, or current session mapping.
      const record =
        claim.record.recoveryTransfer?.record ??
        (await options.inventory.prepareRecovery(claim, await options.prepare(claim)))
      await options.outbox.import(record)
      await options.inventory.ownRecovery(claim, record)
      // Import's durable receipt precedes source retirement. Outbox terminal
      // receipts remain retained after the legacy source has been removed.
      await options.inventory.retire(claim)
    } catch (error) {
      try {
        options.onError(error)
      } catch {
        /* Keep the source recoverable. */
      }
    }
  }
}

// Ordinary #291 restart greetings retain their reservation/TTL behavior. Lost
// background work is runtime-owned and never enters a model directive.
export async function bootBackgroundHandoffs(options: {
  agentDir: string
  inventory: BackgroundHandoffInventory
  router: Pick<ChannelRouter, 'reserveRestartHandoff'>
  configured: (key: ChannelKey) => boolean
  startAdapters: () => Promise<void>
  onError: (error: unknown) => void
  recovery: Pick<BackgroundRecoveryImportOptions, 'outbox' | 'prepare'>
}): Promise<void> {
  const report = (error: unknown): void => {
    try {
      options.onError(error)
    } catch {
      /* Reporting must not strand gates. */
    }
  }
  await importBackgroundRecoveryNotices({ ...options.recovery, inventory: options.inventory, onError: report })
  let reservation: RestartReservation | null = null
  try {
    const explicit = await consumeRestartHandoff(options.agentDir, { accept: (h) => h.origin.kind === 'channel' })
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
