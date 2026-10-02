import type { RecoveryRecord } from './continuity-types'
import type { RecoveryOutbox } from './recovery-outbox'
import type { ChannelRouter } from './router'
import { channelKeyId, RecoveryTransportError, type ChannelKey } from './types'

/** Transport-only recovery; each destination progresses independently. */
export class RecoveryDispatcher {
  private readonly lanes = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | undefined
  private stopped = false

  constructor(
    private readonly outbox: RecoveryOutbox,
    private readonly router: ChannelRouter,
    private readonly options: {
      now?: () => number
      consistencyDelayMs?: number
      onError?: (error: unknown) => void
    } = {},
  ) {
    router.setRecoveryStopHandler((target, parent) => this.suppressParent(target, parent))
  }

  async wake(): Promise<void> {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = undefined
    const now = this.options.now?.() ?? Date.now()
    let next = now + 30_000
    for (const record of await this.outbox.list()) {
      if (record.state === 'delivered' || record.state === 'suppressed') continue
      const due = record.nextAttemptAt ?? 0
      if (due > now) {
        next = Math.min(next, due)
        continue
      }
      const key = channelKeyId(record.target)
      if (this.lanes.has(key)) continue
      const lane = this.dispatchTarget(key)
        .catch((error) => this.options.onError?.(error))
        .finally(() => {
          this.lanes.delete(key)
          this.schedule(30_000)
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
    if (record.lease?.epoch === this.outbox.epoch) {
      return (await this.outbox.repairLease(record.deliveryId, record.lease)) ? record.lease : undefined
    }
    return this.outbox.lease(record.deliveryId, record.generation)
  }

  private async dispatchTarget(key: string): Promise<void> {
    // One pass per wake avoids a blocked destination starving another record.
    for (const snapshot of await this.outbox.list()) {
      if (channelKeyId(snapshot.target) !== key || this.stopped) continue
      let record = await this.outbox.get(snapshot.deliveryId)
      const now = this.options.now?.() ?? Date.now()
      if (!record || record.state === 'delivered' || record.state === 'suppressed' || (record.nextAttemptAt ?? 0) > now)
        continue
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
        const result = await this.router.send(
          { ...record.target, text: record.text },
          {
            source: 'system',
            outputKind: 'meta',
            accounting: 'recovery',
            deliveryId: record.deliveryId,
            coveredIds: record.covers.map((coverage) => coverage.id),
            expectedAccountIdentity: record.boundAccountIdentity ?? record.accountIdentity,
          },
        )
        if (result.ok) {
          await this.outbox.delivered(record.deliveryId, lease, {
            confirmedAt: this.options.now?.() ?? Date.now(),
            ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
            ...(result.messageIds === undefined ? {} : { messageIds: [...result.messageIds] }),
          })
        } else {
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
    const decisionId = crypto.randomUUID()
    for (const record of await this.outbox.list()) {
      if (channelKeyId(record.target) !== channelKeyId(target)) continue
      if (
        record.sourceParentSessionId === parentSessionId ||
        (record.covers.length > 0 && record.covers.every((coverage) => coverage.parentSessionId === parentSessionId))
      ) {
        await this.outbox.suppress(record.deliveryId, 'user_stop', decisionId)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    await Promise.all(this.lanes.values())
    await this.outbox.flush()
  }
}
