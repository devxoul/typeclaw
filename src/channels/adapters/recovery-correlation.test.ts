import { expect, test } from 'bun:test'

import type { RecoveryRecord } from '../continuity-types'
import { createGithubOutboundCallback } from './github/outbound'
import { createGithubRecoveryCallbacks } from './github/recovery'
import { createBotRecoveryCallbacks, recoveryMarker, recoveryNonce, sendBotRecovery } from './recovery-correlation'

function record(adapter: 'slack-bot' | 'discord-bot' | 'github', accountIdentity: string): RecoveryRecord {
  return {
    schemaVersion: 1,
    deliveryId: 'abc',
    purpose: 'interruption-notice',
    target: { adapter, workspace: 'o/r', chat: adapter === 'github' ? 'pr:2' : 'C', thread: null },
    accountIdentity,
    principal: { kind: 'channel', adapter, workspace: 'o/r', chat: 'C', lastInboundAuthorId: 'human' },
    covers: [],
    transferId: 'transfer',
    recoveryGeneration: '1',
    templateVersion: 1,
    locale: 'en',
    text: 'interrupted',
    createdAt: 1,
    generation: 1,
    state: 'pending',
    attempts: 0,
  }
}

function transport(handler: (url: string, init?: RequestInit) => unknown): typeof fetch {
  return (async (input, init) =>
    new Response(JSON.stringify(handler(String(input), init)), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
}

test('Slack reconciles own metadata on later page, never another actor or thread', async () => {
  const rec = record('slack-bot', 'slack-bot:T:U')
  rec.target.workspace = 'T'
  let page = 0
  const api = transport((url, init) => {
    if (url.endsWith('auth.test')) return { ok: true, team_id: 'T', user_id: 'U' }
    const payload = JSON.parse(String(init?.body))
    page++
    if (!payload.cursor)
      return {
        ok: true,
        messages: [
          {
            ts: '1',
            user: 'other',
            metadata: { event_type: 'typeclaw_recovery', event_payload: { delivery_id: 'abc' } },
          },
        ],
        response_metadata: { next_cursor: 'next' },
      }
    return {
      ok: true,
      messages: [
        { ts: '2', user: 'U', metadata: { event_type: 'typeclaw_recovery', event_payload: { delivery_id: 'abc' } } },
      ],
    }
  })
  expect(await createBotRecoveryCallbacks('slack-bot', 'token', api).reconcile(rec)).toEqual({
    status: 'found',
    messageId: '2',
    messageIds: ['2'],
  })
  expect(page).toBe(2)
})

test('Discord authenticated HTTP send enforces stable nonce and blocks rotated actor before POST', async () => {
  let posts = 0
  const api = transport((url, init) => {
    if (url.endsWith('/users/@me')) return { id: 'U' }
    posts++
    const payload = JSON.parse(String(init?.body))
    expect(payload.enforce_nonce).toBe(true)
    expect(payload.nonce).toBe(recoveryNonce('abc'))
    return { id: 'sent' }
  })
  const msg = {
    adapter: 'discord-bot' as const,
    workspace: 'G',
    chat: 'C',
    text: 'notice',
    sendOptions: {
      accounting: 'recovery' as const,
      deliveryId: 'abc',
      coveredIds: [],
      expectedAccountIdentity: 'discord-bot:U',
    },
  }
  expect((await sendBotRecovery('discord-bot', 'token', msg, api)).ok).toBe(true)
  msg.sendOptions.expectedAccountIdentity = 'discord-bot:other'
  expect((await sendBotRecovery('discord-bot', 'token', msg, api)).ok).toBe(false)
  expect(posts).toBe(1)
})

test('Discord scans all own history pages and propagates unreadable history', async () => {
  const rec = record('discord-bot', 'discord-bot:U')
  const api = transport((url) => {
    if (url.endsWith('/users/@me')) return { id: 'U' }
    if (!url.includes('before='))
      return Array.from({ length: 100 }, (_, i) => ({
        id: String(200 - i),
        author: { id: 'other' },
        nonce: recoveryNonce('abc'),
      }))
    return [{ id: 'match', author: { id: 'U' }, nonce: recoveryNonce('abc') }]
  })
  expect(await createBotRecoveryCallbacks('discord-bot', 'token', api).reconcile(rec)).toEqual({
    status: 'found',
    messageId: 'match',
    messageIds: ['match'],
  })
  const broken = transport((url) => (url.endsWith('/users/@me') ? { id: 'U' } : { message: 'denied' }))
  expect(createBotRecoveryCallbacks('discord-bot', 'token', broken).reconcile(rec)).rejects.toThrow()
})

test('Github review reply reconciliation requires exact own numeric actor and parent across pages', async () => {
  const rec = record('github', 'github:7')
  rec.target.thread = '9'
  const api = transport((url) =>
    url.endsWith('page=1')
      ? Array.from({ length: 100 }, (_, i) => ({
          id: i,
          body: recoveryMarker('abc'),
          user: { id: 8 },
          in_reply_to_id: 9,
        }))
      : [
          { id: 101, body: recoveryMarker('abc'), user: { id: 7 }, in_reply_to_id: 10 },
          { id: 102, body: recoveryMarker('abc'), user: { id: 7 }, in_reply_to_id: 9 },
        ],
  )
  const auth = {
    token: async () => 'token',
    authHeaders: async () => ({}),
    getSelf: async () => ({ id: 7, login: 'bot' }),
    dispose: async () => {},
  }
  expect(await createGithubRecoveryCallbacks(auth, api).reconcile(rec)).toEqual({ status: 'found', messageId: '102' })
})

test('Recovery rate limit retains Retry-After even with non-JSON error body', async () => {
  const api = (async (input) =>
    String(input).endsWith('/users/@me')
      ? Response.json({ id: 'U' })
      : new Response('rate limited', { status: 429, headers: { 'Retry-After': '3' } })) as typeof fetch
  const result = await sendBotRecovery(
    'discord-bot',
    'token',
    {
      adapter: 'discord-bot',
      workspace: 'G',
      chat: 'C',
      text: 'notice',
      sendOptions: {
        accounting: 'recovery',
        deliveryId: 'abc',
        coveredIds: [],
        expectedAccountIdentity: 'discord-bot:U',
      },
    },
    api,
  )
  expect(result.ok).toBe(false)
  if (!result.ok)
    expect(result.recoveryFailure).toEqual({ kind: 'rate-limit', safeReason: 'Platform rate limit', retryAfter: 3000 })
})

test('Github discussion reconciliation traverses GraphQL cursors and rejects another author', async () => {
  const rec = record('github', 'github:7')
  rec.target.chat = 'discussion:2'
  const api = transport((_url, init) => {
    const { variables } = JSON.parse(String(init?.body))
    return {
      data: {
        repository: {
          discussion: {
            comments: variables.cursor
              ? {
                  nodes: [{ databaseId: 2, body: recoveryMarker('abc'), author: { login: 'bot' } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                }
              : {
                  nodes: [{ databaseId: 1, body: recoveryMarker('abc'), author: { login: 'other' } }],
                  pageInfo: { hasNextPage: true, endCursor: 'next' },
                },
          },
        },
      },
    }
  })
  const auth = {
    token: async () => 'token',
    authHeaders: async () => ({}),
    getSelf: async () => ({ id: 7, login: 'bot' }),
    dispose: async () => {},
  }
  expect(await createGithubRecoveryCallbacks(auth, api).reconcile(rec)).toEqual({ status: 'found', messageId: '2' })
})

test('Slack recovery refuses another workspace before posting', async () => {
  let posts = 0
  const api = transport((url) => {
    if (url.endsWith('auth.test')) return { ok: true, user_id: 'U', team_id: 'new-team' }
    posts++
    return { ok: true, ts: 'sent' }
  })
  const result = await sendBotRecovery(
    'slack-bot',
    'token',
    {
      adapter: 'slack-bot',
      workspace: 'old-team',
      chat: 'C',
      text: 'notice',
      sendOptions: {
        accounting: 'recovery',
        deliveryId: 'abc',
        coveredIds: [],
        expectedAccountIdentity: 'slack-bot:new-team:U',
      },
    },
    api,
  )
  expect(result.ok).toBe(false)
  expect(posts).toBe(0)
})

test('Slack DM HTTP recovery preserves authenticated team/user and delivers metadata', async () => {
  const requests: string[] = []
  let posted: Record<string, unknown> | undefined
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === '/api/auth.test') return Response.json({ ok: true, team_id: 'T1', user_id: 'U_BOT' })
      posted = (await request.json()) as Record<string, unknown>
      return Response.json({ ok: true, ts: '123.456' })
    },
  })
  const http = ((input, init) => fetch(new URL(new URL(String(input)).pathname, server.url), init)) as typeof fetch
  try {
    const callbacks = createBotRecoveryCallbacks('slack-bot', 'token', http)
    expect(await callbacks.accountIdentity('@dm')).toBe('slack-bot:T1:U_BOT')
    const result = await sendBotRecovery(
      'slack-bot',
      'token',
      {
        adapter: 'slack-bot',
        workspace: '@dm',
        chat: 'D1',
        text: 'notice',
        sendOptions: {
          accounting: 'recovery',
          deliveryId: 'abc',
          coveredIds: [],
          expectedAccountIdentity: 'slack-bot:T1:U_BOT',
        },
      },
      http,
    )
    expect(result).toMatchObject({ ok: true, messageId: '123.456', messageIds: ['123.456'] })
    expect(posted).toMatchObject({
      channel: 'D1',
      metadata: { event_type: 'typeclaw_recovery', event_payload: { delivery_id: 'abc' } },
    })
    expect(requests).toEqual(['/api/auth.test', '/api/auth.test', '/api/chat.postMessage'])
  } finally {
    server.stop(true)
  }
})

test('GitHub recovery blocks unsupported original issue and discussion threads without POST', async () => {
  let posts = 0
  const outbound = createGithubOutboundCallback({
    token: async () => 'token',
    authType: 'pat',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    accountIdentity: async () => 'github:7',
    fetchImpl: transport(() => {
      posts++
      return { id: 1 }
    }),
  })
  for (const chat of ['issue:2', 'discussion:2']) {
    const result = await outbound({
      adapter: 'github',
      workspace: 'o/r',
      chat,
      thread: '9',
      text: 'notice',
      sendOptions: { accounting: 'recovery', deliveryId: 'abc', coveredIds: [], expectedAccountIdentity: 'github:7' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.recoveryFailure?.kind).toBe('target')
  }
  expect(posts).toBe(0)
})
