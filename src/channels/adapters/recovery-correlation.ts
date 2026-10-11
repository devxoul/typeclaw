import { createHash } from 'node:crypto'

import { z } from 'zod'

import type { RecoveryFailure } from '../continuity-types'
import type { RecoveryAdapterCallbacks, OutboundMessage, SendResult } from '../types'
import { RecoveryTransportError } from '../types'

export const recoveryMarker = (id: string): string => `<!-- typeclaw-recovery:${id} -->`
export const recoveryNonce = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 24)

const rowSchema = z.object({
  id: z.string().optional(),
  ts: z.string().optional(),
  user: z.string().optional(),
  thread_ts: z.string().optional(),
  author: z.object({ id: z.string() }).optional(),
  nonce: z.union([z.string(), z.number()]).nullish(),
  // Other apps' message metadata in the same history page must not fail the whole parse.
  metadata: z
    .object({ event_type: z.string().optional(), event_payload: z.record(z.string(), z.unknown()).optional() })
    .optional(),
})
const responseSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  // Discord errors carry a string; Slack chat.postMessage returns the posted message object.
  message: z.unknown().optional(),
  has_more: z.boolean().optional(),
  errors: z.array(z.unknown()).optional(),
  team_id: z.string().optional(),
  user_id: z.string().optional(),
  id: z.string().optional(),
  ts: z.string().optional(),
  messages: z.array(rowSchema).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
})

export function recoveryHttpFailure(response: Response, platformError?: string): RecoveryFailure {
  const retry = response.headers.get('Retry-After')
  const seconds = retry === null ? NaN : Number(retry)
  const retryAfter = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : retry === null
      ? undefined
      : Math.max(0, Date.parse(retry) - Date.now())
  const rateLimited = response.status === 429 || platformError === 'ratelimited'
  const permission =
    response.status === 401 ||
    response.status === 403 ||
    ['invalid_auth', 'not_authed', 'missing_scope', 'token_revoked', 'not_in_channel'].includes(platformError ?? '')
  const target = response.status === 404 || platformError === 'channel_not_found'
  return {
    kind: rateLimited ? 'rate-limit' : permission ? 'permission' : target ? 'target' : 'transient',
    safeReason: rateLimited
      ? 'Platform rate limit'
      : permission
        ? 'Platform authorization unavailable'
        : target
          ? 'Destination unavailable'
          : 'Platform request failed',
    ...(Number.isFinite(retryAfter) ? { retryAfter } : {}),
  }
}

async function json(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<z.infer<typeof responseSchema>> {
  const response = await fetchImpl(url, init)
  if (!response.ok) throw new RecoveryTransportError(recoveryHttpFailure(response))
  const body = responseSchema.parse(await response.json())
  if (!response.ok || body.ok === false || body.errors?.length)
    throw new RecoveryTransportError(recoveryHttpFailure(response, body.error))
  return body
}

export function createBotRecoveryCallbacks(
  platform: 'slack-bot' | 'discord-bot',
  token: string,
  fetchImpl: typeof fetch = fetch,
  cachedAccountIdentity: (workspace?: string) => string | undefined = () => undefined,
): RecoveryAdapterCallbacks {
  const slack = platform === 'slack-bot'
  const headers = { Authorization: slack ? `Bearer ${token}` : `Bot ${token}`, 'Content-Type': 'application/json' }
  const accountIdentity = async (workspace?: string) => {
    const actor = await json(
      fetchImpl,
      slack ? 'https://slack.com/api/auth.test' : 'https://discord.com/api/v10/users/@me',
      { method: slack ? 'POST' : 'GET', headers },
    )
    if (slack ? !actor.team_id || !actor.user_id : !actor.id) throw new Error('recovery-account-identity-unavailable')
    if (slack && workspace !== undefined && workspace !== '@dm' && actor.team_id !== workspace) return undefined
    return slack ? `slack-bot:${actor.team_id}:${actor.user_id}` : `discord-bot:${actor.id}`
  }
  return {
    accountIdentity,
    cachedAccountIdentity,
    async reconcile(record) {
      const identity = await accountIdentity(record.target.workspace)
      if (!identity || identity !== (record.boundAccountIdentity ?? record.accountIdentity))
        throw new Error('recovery-account-identity-changed')
      const actorId = identity.split(':').at(-1)
      const target = record.target
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        let rows: z.infer<typeof rowSchema>[]
        let next: string | undefined
        if (slack) {
          // Form-encoded like createSlackHistoryCallback: the JSON body for conversations.replies came back
          // `invalid_arguments` in production, so reconcile never saw the notice it had already posted.
          const form = new URLSearchParams({ channel: target.chat, limit: '100', include_all_metadata: 'true' })
          if (target.thread) form.set('ts', target.thread)
          if (cursor) form.set('cursor', cursor)
          const data = await json(
            fetchImpl,
            `https://slack.com/api/conversations.${target.thread ? 'replies' : 'history'}`,
            {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
              body: form.toString(),
            },
          )
          if (!data.messages) throw new Error('recovery-history-missing-messages')
          rows = data.messages
          next = data.response_metadata?.next_cursor || undefined
          if (data.has_more && !next) throw new Error('recovery-history-missing-cursor')
          const found = rows.find(
            (row) =>
              row.user === actorId &&
              row.metadata?.event_type === 'typeclaw_recovery' &&
              row.metadata?.event_payload?.delivery_id === record.deliveryId &&
              (target.thread ? row.thread_ts === target.thread : !row.thread_ts || row.thread_ts === row.ts),
          )
          if (found?.ts) return { status: 'found', messageId: found.ts, messageIds: [found.ts] }
        } else {
          const channel = target.thread ?? target.chat
          const response = await fetchImpl(
            `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
            { headers },
          )
          if (!response.ok) throw new Error(`Recovery history ${response.status}`)
          rows = z.array(rowSchema).parse(await response.json())
          if (rows.some((row) => !row.id)) throw new Error('recovery-history-missing-message-id')
          const found = rows.find(
            (row) => row.author?.id === actorId && String(row.nonce) === recoveryNonce(record.deliveryId),
          )
          if (found?.id) return { status: 'found', messageId: found.id, messageIds: [found.id] }
          next = rows.length === 100 ? rows.at(-1)?.id : undefined
        }
        if (next && seen.has(next)) throw new Error('recovery-history-cursor-loop')
        if (next) seen.add(next)
        cursor = next
      } while (cursor)
      return { status: 'unknown' }
    },
  }
}

export async function sendBotRecovery(
  platform: 'slack-bot' | 'discord-bot',
  token: string,
  msg: OutboundMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const options = msg.sendOptions
  if (options?.accounting !== 'recovery') throw new Error('missing-recovery-options')
  try {
    const callbacks = createBotRecoveryCallbacks(platform, token, fetchImpl)
    if ((await callbacks.accountIdentity(msg.workspace)) !== options.expectedAccountIdentity)
      return {
        ok: false,
        error: 'recovery-account-identity-changed',
        recoveryFailure: { kind: 'identity', safeReason: 'Authenticated account changed' },
      }
    const slack = platform === 'slack-bot'
    const data = await json(
      fetchImpl,
      slack
        ? 'https://slack.com/api/chat.postMessage'
        : `https://discord.com/api/v10/channels/${encodeURIComponent(msg.thread ?? msg.chat)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: slack ? `Bearer ${token}` : `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          slack
            ? {
                channel: msg.chat,
                thread_ts: msg.thread ?? undefined,
                text: msg.text,
                unfurl_links: false,
                unfurl_media: false,
                metadata: { event_type: 'typeclaw_recovery', event_payload: { delivery_id: options.deliveryId } },
              }
            : {
                content: msg.text,
                nonce: recoveryNonce(options.deliveryId),
                enforce_nonce: true,
                allowed_mentions: { parse: [] },
              },
        ),
      },
    )
    const id = slack ? data.ts : data.id
    return { ok: true, messageId: id, messageIds: id ? [id] : undefined }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'recovery-transport-failed',
      recoveryFailure:
        error instanceof RecoveryTransportError
          ? error.failure
          : { kind: 'transient', safeReason: 'Recovery transport failed' },
    }
  }
}
