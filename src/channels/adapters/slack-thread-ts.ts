// Slack timestamps are opaque message IDs, not decimal numbers. Preserve all six fractional digits.
export function invalidSlackThreadTs(thread: unknown): string | null {
  if (thread === null || thread === undefined) return null
  if (typeof thread === 'string' && /^\d+\.\d{6}$/.test(thread)) return null
  return 'Invalid Slack thread timestamp: use the parent message ts as a string with exactly six digits after the decimal (e.g. 1700000000.000100). No message was sent.'
}
