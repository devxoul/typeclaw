import type { SlackInboundMessageEvent } from './slack-bot-classify'

export const SLACK_DEDUPE_CAPACITY = 256

export type SlackDedupeMatch = 'client_msg_id' | 'channel_ts'

type DedupeEvent = Pick<SlackInboundMessageEvent, 'channel' | 'ts' | 'client_msg_id' | 'text'>
type DeliveryState = { text: string | undefined; mentioned: boolean }
type Delivery = DeliveryState & {
  committed?: DeliveryState
  pending: Set<DeliveryState>
  mergedInto?: Delivery
}

export type SlackDedupeReservation = { commit: () => void; rollback: () => void }

export type SlackDedupe = {
  // A suppressed delivery still associates its retry identities synchronously.
  check: (event: DedupeEvent, isBotMention?: boolean) => SlackDedupeMatch | null
  mark: (event: DedupeEvent, isBotMention?: boolean) => void
  // Reserve before asynchronous enrichment; roll back if durable admission fails.
  reserve: (event: DedupeEvent, isBotMention?: boolean) => SlackDedupeReservation
}

// Keep both retry identities: client_msg_id survives Slack resends with a fresh
// ts, while channel:ts also covers app_mention envelopes without client_msg_id.
// An identity may promote from observation to mention only on changed raw text.
// Once mentioned, further edits cannot re-engage it while either ring retains it.
export function createSlackDedupe(capacity: number = SLACK_DEDUPE_CAPACITY): SlackDedupe {
  const tsRing = new Map<string, Delivery>()
  const clientMsgIdRing = new Map<string, Delivery>()

  const canonical = (delivery: Delivery): Delivery => {
    while (delivery.mergedInto !== undefined) delivery = delivery.mergedInto
    return delivery
  }
  const combine = (previous: DeliveryState | undefined, next: DeliveryState): DeliveryState =>
    previous === undefined || (next.mentioned && !previous.mentioned) ? { ...next } : previous
  const refresh = (delivery: Delivery): void => {
    let state = delivery.committed
    for (const pending of delivery.pending) state = combine(state, pending)
    if (state !== undefined) {
      delivery.text = state.text
      delivery.mentioned = state.mentioned
    }
  }

  const remember = (ring: Map<string, Delivery>, key: string, delivery: Delivery): void => {
    if (!ring.has(key) && ring.size >= capacity) {
      const oldest = ring.keys().next().value
      if (oldest !== undefined) ring.delete(oldest)
    }
    ring.set(key, delivery)
  }
  const isDuplicate = (previous: Delivery | undefined, event: DedupeEvent, mentioned: boolean): boolean =>
    previous !== undefined &&
    !(
      mentioned &&
      !previous.mentioned &&
      previous.text !== undefined &&
      event.text !== undefined &&
      previous.text !== event.text
    )

  const associate = (event: DedupeEvent): Delivery => {
    const key = `${event.channel}:${event.ts}`
    const cmid = event.client_msg_id
    const byTs = tsRing.get(key)
    const byClient = cmid ? clientMsgIdRing.get(cmid) : undefined
    const delivery: Delivery = byClient ??
      byTs ?? { text: event.text, mentioned: false, pending: new Set<DeliveryState>() }
    if (byTs !== undefined && byTs !== delivery) {
      if (byTs.committed !== undefined) delivery.committed = combine(delivery.committed, byTs.committed)
      for (const pending of byTs.pending) delivery.pending.add(pending)
      byTs.mergedInto = delivery
      refresh(delivery)
      // Earlier resends can leave several timestamp aliases. Reconcile all of
      // them, not only the two keys on this envelope. Scans are bounded by the
      // ring capacities and needed only when two distinct records converge.
      for (const [alias, previous] of tsRing) {
        if (previous === byTs) tsRing.set(alias, delivery)
      }
      for (const [alias, previous] of clientMsgIdRing) {
        if (previous === byTs) clientMsgIdRing.set(alias, delivery)
      }
    }
    remember(tsRing, key, delivery)
    if (cmid) remember(clientMsgIdRing, cmid, delivery)
    return delivery
  }

  return {
    check: (event, mentioned = false) => {
      const cmid = event.client_msg_id
      const match =
        cmid && isDuplicate(clientMsgIdRing.get(cmid), event, mentioned)
          ? 'client_msg_id'
          : isDuplicate(tsRing.get(`${event.channel}:${event.ts}`), event, mentioned)
            ? 'channel_ts'
            : null
      if (match !== null) associate(event)
      return match
    },
    mark: (event, mentioned = false) => {
      const delivery = associate(event)
      delivery.committed = combine(delivery.committed, { text: event.text, mentioned })
      refresh(delivery)
    },
    reserve: (event, mentioned = false) => {
      const original = associate(event)
      const pending = { text: event.text, mentioned }
      original.pending.add(pending)
      refresh(original)
      let settled = false
      const finish = (commit: boolean): void => {
        if (settled) return
        settled = true
        const delivery = canonical(original)
        delivery.pending.delete(pending)
        if (commit) delivery.committed = combine(delivery.committed, pending)
        refresh(delivery)
        if (delivery.committed !== undefined || delivery.pending.size > 0) return
        // Suppressed retries can have acquired additional aliases while pending.
        for (const [key, value] of tsRing) {
          if (value === delivery) tsRing.delete(key)
        }
        for (const [key, value] of clientMsgIdRing) {
          if (value === delivery) clientMsgIdRing.delete(key)
        }
      }
      return { commit: () => finish(true), rollback: () => finish(false) }
    },
  }
}
