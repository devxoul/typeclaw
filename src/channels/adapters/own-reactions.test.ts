import { describe, expect, it } from 'bun:test'

import type { ReactionRequest } from '@/channels/types'

import { createDiscordOwnReactionCallbacks as discordBot } from './discord-bot-reactions'
import { createDiscordOwnReactionCallbacks as discord } from './discord-reactions'
import { createGithubOwnReactionCallbacks, encodeGithubReactionRef } from './github/reactions'
import { createSlackOwnReactionCallbacks as slackBot } from './slack-bot-reactions'
import { createSlackOwnReactionCallbacks as slack } from './slack-reactions'

for (const [adapter, factory, target, canonical] of [
  ['slack', slack, { channel: 'C1', ts: '1.1' }, '+1'],
  ['slack-bot', slackBot, { channel: 'C1', ts: '1.1' }, '+1'],
  ['discord', discord, { channel: 'C1', message: 'M1' }, '👍'],
  ['discord-bot', discordBot, { channel: 'C1', message: 'M1' }, '👍'],
] as const) {
  describe(`${adapter} own reactions`, () => {
    const req: ReactionRequest = {
      adapter,
      workspace: 'W',
      chat: 'C1',
      reactionRef: { adapter, value: JSON.stringify(target) },
      emoji: ':+1:',
    }
    it('canonicalizes durable tuple, removes without an instance ref, and blocks account rotation', async () => {
      let identity = 'actor-1'
      const calls: string[][] = []
      const cb = factory({
        identity: () => identity,
        client: {
          removeReaction: async (...args: string[]) => {
            calls.push(args)
          },
        },
      })
      const prepared = await cb.prepare(req)
      expect(prepared).toEqual({ accountIdentity: 'actor-1', target: req.reactionRef, emoji: canonical })
      const remove = {
        adapter,
        workspace: 'W',
        chat: 'C1',
        target: prepared!.target,
        emoji: prepared!.emoji,
        expectedAccountIdentity: prepared!.accountIdentity,
      }
      expect(await cb.remove(remove)).toEqual({ ok: true })
      identity = 'actor-2'
      expect(await cb.remove(remove)).toMatchObject({ ok: false, code: 'identity' })
      expect(calls).toEqual([['C1', 'ts' in target ? target.ts : target.message, canonical]])
      identity = ''
      expect(await cb.prepare(req)).toBeNull()
    })
    for (const [rawCode, expected] of adapter.startsWith('slack')
      ? [
          ['missing_scope', 'permission'],
          ['ratelimited', 'rate-limit'],
          ['slack_webapi_rate_limited_error', 'rate-limit'],
          ['no_reaction', 'success'],
        ]
      : [
          ['50013', 'permission'],
          ['http_429', 'rate-limit'],
          ['10008', 'success'],
        ]) {
      it(`classifies ${rawCode}`, async () => {
        const cb = factory({
          identity: () => 'actor',
          client: {
            removeReaction: async () => {
              throw Object.assign(new Error('API failed'), { code: rawCode, retryAfter: 2 })
            },
          },
        })
        const result = await cb.remove({
          adapter,
          workspace: 'W',
          chat: 'C1',
          target: req.reactionRef,
          emoji: canonical,
          expectedAccountIdentity: 'actor',
        })
        expect(result).toMatchObject(expected === 'success' ? { ok: true } : { ok: false, code: expected })
        if (expected === 'rate-limit') expect(result).toMatchObject({ retryAfter: 2000 })
      })
    }
  })
}

describe('GitHub own reactions over HTTP', () => {
  const target = encodeGithubReactionRef({ kind: 'issue-comment', owner: 'acme', repo: 'project', commentId: 12 })
  const req = {
    adapter: 'github' as const,
    workspace: 'acme/project',
    chat: '1',
    target,
    emoji: '+1',
    expectedAccountIdentity: '42',
  }
  async function scenario(handler: (request: Request) => Response, actor = 42) {
    const server = Bun.serve({ port: 0, fetch: handler })
    const cb = createGithubOwnReactionCallbacks({
      token: async () => 'test-token',
      getSelf: async () => ({ id: actor }),
      authType: 'app',
      fetchImpl: ((input, init) => {
        const url = new URL(String(input))
        url.host = `127.0.0.1:${server.port}`
        url.protocol = 'http:'
        return fetch(url, init)
      }) as typeof fetch,
    })
    return { cb, stop: () => server.stop(true) }
  }
  it('enumerates all pages and removes exact emoji numeric actor only', async () => {
    const events: string[] = []
    const { cb, stop } = await scenario((request) => {
      const url = new URL(request.url)
      events.push(`${request.method} ${url.pathname}${url.search}`)
      if (request.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.searchParams.get('page') === '2') return Response.json([{ id: 4, content: '+1', user: { id: 42 } }])
      return Response.json(
        [
          { id: 1, content: '+1', user: { id: 42 } },
          { id: 2, content: '+1', user: { id: 99, login: 'same-name' } },
          { id: 3, content: 'eyes', user: { id: 42 } },
        ],
        {
          headers: {
            link: '<https://api.github.com/repos/acme/project/issues/comments/12/reactions?per_page=100&page=2>; rel="next"',
          },
        },
      )
    })
    try {
      expect(await cb.prepare({ ...req, reactionRef: target, emoji: ':thumbsup:' })).toEqual({
        accountIdentity: '42',
        target,
        emoji: '+1',
      })
      expect(await cb.remove(req)).toEqual({ ok: true })
      expect(events).toEqual([
        'GET /repos/acme/project/issues/comments/12/reactions?per_page=100',
        'GET /repos/acme/project/issues/comments/12/reactions?per_page=100&page=2',
        'DELETE /repos/acme/project/issues/comments/12/reactions/1',
        'DELETE /repos/acme/project/issues/comments/12/reactions/4',
      ])
    } finally {
      stop()
    }
  })
  it('pagination failure causes no deletion even when first page contains our reaction', async () => {
    let deleted = false
    const { cb, stop } = await scenario((request) => {
      const url = new URL(request.url)
      if (request.method === 'DELETE') deleted = true
      if (url.searchParams.has('page')) return new Response('temporarily unavailable', { status: 503 })
      return Response.json([{ id: 1, content: '+1', user: { id: 42 } }], {
        headers: {
          link: '<https://api.github.com/repos/acme/project/issues/comments/12/reactions?page=2>; rel="next"',
        },
      })
    })
    try {
      expect(await cb.remove(req)).toMatchObject({ ok: false, code: 'transient' })
      expect(deleted).toBe(false)
    } finally {
      stop()
    }
  })
  it('identity rotation blocks every API call', async () => {
    let called = false
    const { cb, stop } = await scenario(() => {
      called = true
      return Response.json([])
    }, 99)
    try {
      expect(await cb.remove(req)).toMatchObject({ ok: false, code: 'identity' })
      expect(called).toBe(false)
    } finally {
      stop()
    }
  })
  for (const [status, headers, code] of [
    [403, {}, 'permission'],
    [404, {}, 'permission'],
    [429, { 'retry-after': '2' }, 'rate-limit'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limit'],
  ] as const) {
    it(`classifies HTTP ${status} ${code}`, async () => {
      const { cb, stop } = await scenario(() => new Response('API failed', { status, headers }))
      try {
        expect(await cb.remove(req)).toMatchObject({ ok: false, code, ...(status === 429 ? { retryAfter: 2000 } : {}) })
      } finally {
        stop()
      }
    })
  }
})
