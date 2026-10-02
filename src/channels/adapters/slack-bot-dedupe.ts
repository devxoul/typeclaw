import type { SlackInboundMessageEvent } from './slack-bot-classify'

export const SLACK_DEDUPE_CAPACITY = 256

export type SlackDedupeMatch = 'client_msg_id' | 'channel_ts'

type DedupeEvent = Pick<SlackInboundMessageEvent, 'channel' | 'ts' | 'client_msg_id' | 'text'>
type Delivery = { text: string | undefined; mentioned: boolean }

export type SlackDedupe = {
  // A suppressed delivery still associates its retry identities synchronously.
  check: (event: DedupeEvent, isBotMention?: boolean) => SlackDedupeMatch | null
  mark: (event: DedupeEvent, isBotMention?: boolean) => void
}

// Keep both retry identities: client_msg_id survives Slack resends with a fresh
// ts, while channel:ts also covers app_mention envelopes without client_msg_id.
// An identity may promote from observation to mention only on changed raw text.
// Once mentioned, further edits cannot re-engage it while either ring retains it.
export function createSlackDedupe(capacity: number = SLACK_DEDUPE_CAPACITY): SlackDedupe {
  const tsRing = new Map<string, Delivery>()
  const clientMsgIdRing = new Map<string, Delivery>()

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
    const delivery = byClient ?? byTs ?? { text: event.text, mentioned: false }
    if (byTs !== undefined && byTs !== delivery) {
      if (byTs.mentioned && !delivery.mentioned) delivery.text = byTs.text
      delivery.mentioned ||= byTs.mentioned
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
      delivery.mentioned ||= mentioned
      if (mentioned) delivery.text = event.text
    },
  }
}
