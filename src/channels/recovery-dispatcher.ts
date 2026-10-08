import type { BackgroundObligationStore } from './background-obligations'
import type { RecoveryRecord } from './continuity-types'
import type { InboundJournal } from './inbound-journal'
import type { RecoveryOutbox } from './recovery-outbox'
import type { ChannelRouter } from './router'
import { channelKeyId, RecoveryTransportError, type ChannelKey } from './types'

/** Transport-only recovery; each destination progresses independently. */
export class RecoveryDispatcher {
  private readonly lanes = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  /** Set by the first (boot) wake; imports never dispatch before adapters are ready. */
  private woken = false
  private readonly unsubscribe: () => void
  /** Destinations whose due work was skipped while an earlier pass still held their lane. */
  private readonly deferred = new Set<string>()

  constructor(
    private readonly outbox: RecoveryOutbox,
    private readonly router: ChannelRouter,
    private readonly options: {
      now?: () => number
      consistencyDelayMs?: number
      onError?: (error: unknown) => void
      backgroundObligations?: BackgroundObligationStore
      inboundJournal?: InboundJournal
    } = {},
  ) {
    router.setRecoveryStopHandler((target, parent) => this.suppressParent(target, parent))
    // A transfer made durable after boot (a live turn that ended unanswered) dispatches now
    // instead of at the next poll; multiple imports in one tick coalesce into one wake.
    this.unsubscribe = outbox.subscribe(() => {
      if (!this.woken || this.stopped) return
      clearTimeout(this.timer)
      this.timer = undefined
      this.schedule(0)
    })
  }

  private async validateCoverageInLane(record: RecoveryRecord): Promise<'open' | 'resolved'> {
    if (record.covers.some((cover) => cover.store === 'inbound')) {
      if (!this.options.inboundJournal) throw new Error('Inbound recovery requires journal authority')
      return this.options.inboundJournal.validateNotice(record)
    }
    if (record.covers.some((cover) => cover.store === 'background')) {
      this.options.inboundJournal?.assertAvailable()
      if (!this.options.backgroundObligations) throw new Error('Background recovery requires source authority')
      this.options.backgroundObligations.assertAvailable()
    }
    return this.options.backgroundObligations?.validateNotice(record) ?? 'open'
  }

  private async acknowledge(record: RecoveryRecord): Promise<void> {
    if (record.covers.some((cover) => cover.store === 'inbound')) {
      const journal = this.options.inboundJournal
      if (!journal) throw new Error('Inbound recovery requires journal authority')
      if (this.options.backgroundObligations)
        await this.options.backgroundObligations.withTargetLane(record.target, () => journal.acknowledgeNotice(record))
      else await journal.acknowledgeNotice(record)
      return
    }
    const source = this.options.backgroundObligations
    if (!source) return
    if (record.covers.some((cover) => cover.store === 'background')) {
      await source.withTargetLane(record.target, () => source.acknowledgeNotice(record))
    } else {
      // Legacy upgrade receipts have immutable inventory-only provenance.
      await source.acknowledgeNotice(record)
    }
  }

  /**
   * Source acknowledgment, then retirement of the terminal outbox record. Retirement requires the
   * source to validate the delivery as resolved in its lane, so no open or re-importable coverage
   * can still point at it; the outbox keeps an immutable fence for any later identical import.
   */
  private async finish(record: RecoveryRecord, retire: boolean): Promise<void> {
    await this.acknowledge(record)
    if (!retire) return
    const source = this.options.backgroundObligations
    const coverage =
      source && record.covers.some((cover) => cover.store !== 'inventory')
        ? await source.withTargetLane(record.target, () => this.validateCoverageInLane(record))
        : await this.validateCoverageInLane(record)
    if (coverage === 'resolved') await this.outbox.retire(record.deliveryId, record.generation)
  }

  async wake(): Promise<void> {
    if (this.stopped) return
    this.woken = true
    clearTimeout(this.timer)
    this.timer = undefined
    const now = this.options.now?.() ?? Date.now()
    let next = now + 30_000
    const started = new Set<string>()
    for (const record of await this.outbox.list()) {
      const key = channelKeyId(record.target)
      if (record.state === 'delivered' || record.state === 'suppressed') {
        // A lane from an earlier pass may still hold this record's in-flight send (a /stop raced
        // it), so it is retired on a later pass. A lane started by this pass skips terminal records.
        await this.finish(record, !this.lanes.has(key) || started.has(key)).catch((error) =>
          this.options.onError?.(error),
        )
        continue
      }
      const due = record.nextAttemptAt ?? 0
      if (due > now) {
        next = Math.min(next, due)
        continue
      }
      if (this.lanes.has(key)) {
        // That lane listed the outbox before this record was due or existed; run again after it.
        if (!started.has(key)) this.deferred.add(key)
        continue
      }
      started.add(key)
      const lane = this.dispatchTarget(key)
        .catch((error) => this.options.onError?.(error))
        .finally(() => {
          this.lanes.delete(key)
          if (this.deferred.delete(key)) {
            clearTimeout(this.timer)
            this.timer = undefined
            this.schedule(0)
          } else this.schedule(30_000)
        })
      this.lanes.set(key, lane)
    }
    this.schedule(Math.max(10, next - now))
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.wake().catch((error) => this.options.onError?.(error))
    }, delay)
    this.timer.unref?.()
  }
  private async acquire(record: RecoveryRecord) {
    const claim = async () => {
      if ((await this.validateCoverageInLane(record)) === 'resolved') return undefined
      if (record.lease?.epoch === this.outbox.epoch) {
        return (await this.outbox.repairLease(record.deliveryId, record.lease)) ? record.lease : undefined
      }
      return this.outbox.lease(record.deliveryId, record.generation)
    }
    try {
      const source = this.options.backgroundObligations
      return source && record.covers.some((cover) => cover.store !== 'inventory')
        ? await source.withTargetLane(record.target, claim)
        : await claim()
    } catch (error) {
      this.options.onError?.(error)
      return undefined
    }
  }

  private async dispatchTarget(key: string): Promise<void> {
    // One pass per wake avoids a blocked destination starving another record.
    for (const snapshot of await this.outbox.list()) {
      if (channelKeyId(snapshot.target) !== key || this.stopped) continue
      let record = await this.outbox.get(snapshot.deliveryId)
      const now = this.options.now?.() ?? Date.now()
      if (!record || record.state === 'delivered' || record.state === 'suppressed' || (record.nextAttemptAt ?? 0) > now)
        continue
      try {
        const source = this.options.backgroundObligations
        const coverage =
          source && record.covers.some((cover) => cover.store !== 'inventory')
            ? await source.withTargetLane(record.target, () => this.validateCoverageInLane(record!))
            : await this.validateCoverageInLane(record)
        if (coverage === 'resolved') {
          await this.outbox.suppress(record.deliveryId, 'coverage-resolved', crypto.randomUUID())
          continue
        }
      } catch (error) {
        this.options.onError?.(error)
        continue
      }
      const failure = await this.router.validateRecovery(record).catch((error: unknown) =>
        error instanceof RecoveryTransportError
          ? error.failure
          : {
              kind: 'transient' as const,
              safeReason: 'recovery transport unavailable',
              retryAfter: this.options.consistencyDelayMs ?? 5_000,
            },
      )
      if (failure) {
        const lease = await this.acquire(record)
        if (lease) await this.outbox.fail(record.deliveryId, lease, failure)
        continue
      }
      if (record.attempts > 0) {
        const remaining =
          record.state === 'leased'
            ? (record.lease?.acquiredAt ?? 0) + (this.options.consistencyDelayMs ?? 5_000) - now
            : 0
        if (remaining > 0) {
          this.schedule(remaining)
          continue
        }
        // An unavailable history API cannot prove absence. After the bounded
        // consistency delay we accept an at-least-once duplicate rather than
        // turning a read outage into permanent loss of the notice.
        const found = await this.router.reconcileRecovery(record).catch(() => ({ status: 'unknown' as const }))
        if (found.status === 'found') {
          const reclaimed = await this.acquire(record)
          if (!reclaimed) continue
          await this.outbox.delivered(record.deliveryId, reclaimed, {
            confirmedAt: now,
            ...(found.messageId === undefined ? {} : { messageId: found.messageId }),
            ...(found.messageIds === undefined ? {} : { messageIds: [...found.messageIds] }),
          })
          const delivered = await this.outbox.get(record.deliveryId)
          if (delivered) await this.finish(delivered, true).catch((error) => this.options.onError?.(error))
          continue
        }
      }
      record = await this.outbox.get(record.deliveryId)
      if (!record || record.state === 'suppressed' || record.state === 'delivered') continue
      const lease = await this.acquire(record)
      if (!lease) continue
      try {
        if (record.accountIdentity === 'unbound-legacy' && record.boundAccountIdentity === undefined) {
          const identity = await this.router.getRecoveryAccountIdentity(record.target.adapter, record.target.workspace)
          if (identity === undefined) {
            await this.outbox.fail(record.deliveryId, lease, {
              kind: 'unavailable',
              safeReason: 'adapter account is not ready',
            })
            continue
          }
          if (!(await this.outbox.bindAccount(record.deliveryId, lease, identity))) continue
          const bound = await this.outbox.get(record.deliveryId)
          if (!bound) continue
          record = bound
        }
        // Recheck after durable lease and immediately before the remote call.
        const invalid = await this.router.validateRecovery(record)
        if (invalid) {
          await this.outbox.fail(record.deliveryId, lease, invalid)
          continue
        }
        if ((await this.outbox.get(record.deliveryId))?.state === 'suppressed') continue
        const sendNotice = async () => {
          if ((await this.validateCoverageInLane(record!)) === 'resolved') {
            await this.outbox.suppress(record!.deliveryId, 'coverage-resolved', crypto.randomUUID())
            return undefined
          }
          if ((await this.outbox.get(record!.deliveryId))?.state === 'suppressed') return undefined
          // Begin the call under the source lane, but do not hold it during
          // transport I/O. /stop can withdraw an already-in-flight notice.
          return {
            pending: this.router.send(
              { ...record!.target, text: record!.text },
              {
                source: 'system',
                outputKind: 'meta',
                accounting: 'recovery',
                deliveryId: record!.deliveryId,
                coveredIds: record!.covers.map((coverage) => coverage.id),
                expectedAccountIdentity: record!.boundAccountIdentity ?? record!.accountIdentity,
              },
            ),
          }
        }
        const dispatched =
          this.options.backgroundObligations && record.covers.some((cover) => cover.store !== 'inventory')
            ? await this.options.backgroundObligations.withTargetLane(record.target, sendNotice)
            : await sendNotice()
        if (!dispatched) continue
        const result = await dispatched.pending
        if (result.ok) {
          await this.outbox.delivered(record.deliveryId, lease, {
            confirmedAt: this.options.now?.() ?? Date.now(),
            ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
            ...(result.messageIds === undefined ? {} : { messageIds: [...result.messageIds] }),
          })
          const delivered = await this.outbox.get(record.deliveryId)
          if (delivered) await this.finish(delivered, true).catch((error) => this.options.onError?.(error))
        } else {
          if (record.covers.some((cover) => cover.store !== 'inventory')) {
            this.options.inboundJournal?.assertAvailable()
            this.options.backgroundObligations?.assertAvailable()
          }
          await this.outbox.fail(
            record.deliveryId,
            lease,
            result.recoveryFailure ?? {
              kind: 'transient',
              safeReason: 'adapter did not confirm recovery delivery',
              retryAfter: this.options.consistencyDelayMs ?? 5_000,
            },
          )
        }
      } catch (error) {
        if (record.covers.some((cover) => cover.store !== 'inventory')) {
          try {
            this.options.inboundJournal?.assertAvailable()
            this.options.backgroundObligations?.assertAvailable()
          } catch (frozen) {
            // Leave the lease untouched: an unreadable source cannot authorize
            // even retry-state progress. Verified repair can reclaim it later.
            this.options.onError?.(frozen)
            continue
          }
        }
        await this.outbox.fail(
          record.deliveryId,
          lease,
          error instanceof RecoveryTransportError
            ? error.failure
            : {
                kind: 'transient',
                safeReason: 'recovery transport unavailable',
                retryAfter: this.options.consistencyDelayMs ?? 5_000,
              },
        )
      }
    }
  }

  async suppressParent(target: ChannelKey, parentSessionId: string): Promise<void> {
    const parentDecisionId = crypto.randomUUID()
    for (const record of await this.outbox.list()) {
      if (channelKeyId(record.target) !== channelKeyId(target)) continue
      if (
        record.sourceParentSessionId === parentSessionId ||
        (record.covers.length > 0 && record.covers.every((coverage) => coverage.parentSessionId === parentSessionId))
      ) {
        const decisionId = `${parentDecisionId}:${record.deliveryId}`
        const source = this.options.backgroundObligations
        const suppress = async () => {
          if (record.covers.some((cover) => cover.store === 'inbound')) {
            if (!this.options.inboundJournal) throw new Error('Inbound recovery requires journal authority')
            await this.options.inboundJournal.suppressNoticeCoverage(record, { decisionId, reason: 'user-stop' })
          } else if (source) {
            if (record.covers.some((cover) => cover.store === 'background'))
              this.options.inboundJournal?.assertAvailable()
            await source.suppressNoticeCoverage(record, { decisionId, reason: 'user-stop' })
          }
        }
        if (source && record.covers.some((cover) => cover.store !== 'inventory'))
          await source.withTargetLane(target, suppress)
        else await suppress()
        await this.outbox.suppress(record.deliveryId, 'user_stop', decisionId)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe()
    clearTimeout(this.timer)
    this.timer = undefined
    await Promise.all(this.lanes.values())
    await this.outbox.flush()
  }
}
