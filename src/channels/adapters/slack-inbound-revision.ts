// Slack message_changed envelopes put the replyable message inside `message`.
// Keep its original message ts and the platform edit ts, not the envelope ts.
export function normalizeSlackInbound<T extends { subtype?: string; channel: string; ts: string }>(event: T): T {
  if (
    event.subtype !== 'message_changed' ||
    !('message' in event) ||
    typeof event.message !== 'object' ||
    event.message === null
  )
    return event
  const message = event.message
  if (!('ts' in message) || typeof message.ts !== 'string') return event
  const subtype = 'subtype' in message && typeof message.subtype === 'string' ? message.subtype : undefined
  return { ...event, ...message, channel: event.channel, ts: message.ts, subtype }
}

export function slackInboundRevision(event: object): string {
  if (!('edited' in event) || typeof event.edited !== 'object' || event.edited === null) return 'original'
  return 'ts' in event.edited && typeof event.edited.ts === 'string' ? event.edited.ts : 'original'
}
