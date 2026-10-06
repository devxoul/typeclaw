import { consumeRestartHandoff, type RestartHandoff } from '@/agent/restart-handoff'
import type { BackgroundHandoffInventory, ClaimedBackgroundInventory } from '@/channels/background-handoff'
import { loadChannelSessions } from '@/channels/persistence'
import type { ChannelRouter, RestartReservation } from '@/channels/router'
import { channelKeyId, type ChannelKey } from '@/channels/types'

// Claims are at-most-once directive attempts, not a delivery outbox. Trigger
// targets are not removable reaction instances; without adapter-owned lookup,
// deliberately leave eyes alone rather than call removeReaction with a target.
export async function bootBackgroundHandoffs(options: {
  agentDir: string
  inventory: BackgroundHandoffInventory
  router: Pick<ChannelRouter, 'reserveRestartHandoff'>
  configured: (key: ChannelKey) => boolean
  startAdapters: () => Promise<void>
  onError: (error: unknown) => void
}): Promise<void> {
  const report = (error: unknown): void => {
    try {
      options.onError(error)
    } catch {
      /* Reporting must not strand gates. */
    }
  }
  const reservations: { reservation: RestartReservation; claims: ClaimedBackgroundInventory[] }[] = []
  const retired = new Set<ClaimedBackgroundInventory>()
  const retire = async (claims: ClaimedBackgroundInventory[]): Promise<void> => {
    for (const claim of claims) {
      if (retired.has(claim)) continue
      retired.add(claim)
      try {
        await options.inventory.retire(claim)
      } catch (error) {
        report(error)
      }
    }
  }
  let claims: ClaimedBackgroundInventory[] = []
  let explicit: RestartHandoff | null = null
  try {
    explicit = await consumeRestartHandoff(options.agentDir, { accept: (h) => h.origin.kind === 'channel' })
  } catch (error) {
    report(error)
  }
  try {
    claims = await options.inventory.claim()
  } catch (error) {
    report(error)
  }
  try {
    const mappings = await loadChannelSessions(options.agentDir)
    const groups = new Map<string, { handoff: RestartHandoff; claims: ClaimedBackgroundInventory[] }>()
    const accepts = (key: ChannelKey, parent: string): boolean =>
      options.configured(key) &&
      mappings.some((mapping) => channelKeyId(mapping) === channelKeyId(key) && mapping.sessionId === parent)
    if (explicit?.origin.kind === 'channel') {
      try {
        if (accepts(explicit.origin.key, explicit.originatingSessionId)) {
          groups.set(channelKeyId(explicit.origin.key), { handoff: explicit, claims: [] })
        }
      } catch (error) {
        report(error)
      }
    }
    for (const claim of claims) {
      try {
        const record = claim.record
        if (!accepts(record.key, record.parentSessionId)) {
          await retire([claim])
          continue
        }
        const keyId = channelKeyId(record.key)
        let group = groups.get(keyId)
        if (group === undefined) {
          group = {
            handoff: {
              schemaVersion: 2,
              restartedAt: new Date().toISOString(),
              originatingSessionId: record.parentSessionId,
              originatingSessionFile: record.parentSessionFile,
              origin: { kind: 'channel', key: record.key },
              ...(record.triggeringAuthorId !== undefined ? { triggeringAuthorId: record.triggeringAuthorId } : {}),
            },
            claims: [],
          }
          groups.set(keyId, group)
        }
        group.claims.push(claim)
        group.handoff = {
          ...group.handoff,
          interruptedSubagents: [
            ...new Set([
              ...(group.handoff.interruptedSubagents ?? []),
              ...record.tasks.map((task) => task.subagentName),
            ]),
          ],
        }
      } catch (error) {
        report(error)
        await retire([claim])
      }
    }
    for (const group of groups.values()) {
      try {
        const reservation = options.router.reserveRestartHandoff(group.handoff)
        if (reservation === null) await retire(group.claims)
        else reservations.push({ reservation, claims: group.claims })
      } catch (error) {
        report(error)
        await retire(group.claims)
      }
    }
    await options.startAdapters()
    for (const entry of reservations) {
      await retire(entry.claims)
      try {
        await entry.reservation.resume()
      } catch (error) {
        report(error)
      } finally {
        entry.reservation.release()
      }
    }
  } finally {
    // Includes adapter startup failure and unexpected preparation failures.
    await retire(claims)
    for (const entry of reservations) entry.reservation.release()
  }
}
