import type { ChannelHistoryMessage } from '@/channels/types'

// Render history as one line per message, chronological order. `BOT` marker
// distinguishes the agent's own past replies from user messages so the model
// does not treat them as user input. Author name is shown alongside the id so
// the agent can refer to people by name. Shared by channel_history (origin-
// bound) and channel_read (arbitrary-chat) so both render identically.
export function renderHistoryMessages(messages: readonly ChannelHistoryMessage[]): string {
  if (messages.length === 0) return '(no messages)'
  const lines: string[] = []
  for (const m of messages) {
    lines.push(renderHistoryMessage(m))
  }
  return lines.join('\n')
}

export function renderHistoryMessage(m: ChannelHistoryMessage): string {
  const iso = m.ts > 0 ? new Date(m.ts).toISOString() : 'unknown-time'
  const who = m.isBot ? `BOT (${m.authorName})` : `${m.authorName} (<@${m.authorId}>)`
  const messageId = m.externalMessageId ? ` [message_id=${m.externalMessageId}]` : ''
  return `[${iso}]${messageId} ${who}: ${m.text}`
}
