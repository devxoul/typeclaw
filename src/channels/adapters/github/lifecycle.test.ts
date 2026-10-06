import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelRouter, type ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig, GithubAdapterConfig } from '@/channels/schema'
import type { GithubSecretsBlock } from '@/secrets/schema'

import { createGithubAdapter } from './index'

const APP_PRIVATE_KEY_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()

function appSecrets(): GithubSecretsBlock {
  return {
    auth: {
      type: 'app',
      appId: 12345,
      privateKey: { value: APP_PRIVATE_KEY_PEM },
    },
    webhookSecret: { value: 'wh-secret' },
  }
}

type Call = { url: string; method: string; body?: string }

function fakeFetchRecording(handler: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
    return handler({ url, method })
  }
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, calls }
}

function silentLogger(): { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

function recordingLogger(): {
  info: (m: string) => void
  warn: (m: string) => void
  error: (m: string) => void
  messages: string[]
} {
  const messages: string[] = []
  return {
    info: (m) => messages.push(`info:${m}`),
    warn: (m) => messages.push(`warn:${m}`),
    error: (m) => messages.push(`error:${m}`),
    messages,
  }
}

function signedWebhookRequest(payload: Record<string, unknown>, event: string, delivery: string): Request {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', 'wh-secret').update(body).digest('hex')}`
  return new Request('https://example.com/github', {
    method: 'POST',
    headers: {
      'x-hub-signature-256': signature,
      'x-github-event': event,
      'x-github-delivery': delivery,
    },
    body,
  })
}

function patSecrets(): GithubSecretsBlock {
  return {
    auth: { type: 'pat', token: { value: 'ghp_test' } },
    webhookSecret: { value: 'wh-secret' },
  }
}

const ADAPTER_DEFAULTS = {
  enabled: true,
  engagement: { trigger: ['mention', 'reply', 'dm'] as const, stickiness: { perReply: { window: 60_000 } } },
  history: { prefetch: { thread: { head: 3, tail: 10 }, channel: { tail: 10 } } },
} as const

function githubConfig(
  repos: readonly string[],
  webhookUrl: string | null = 'https://agent.example.com/gh',
): ChannelAdapterConfig & GithubAdapterConfig {
  const config: ChannelAdapterConfig & GithubAdapterConfig = {
    ...ADAPTER_DEFAULTS,
    engagement: { ...ADAPTER_DEFAULTS.engagement, trigger: [...ADAPTER_DEFAULTS.engagement.trigger] },
    webhookPort: 0,
    eventAllowlist: ['issue_comment.created', 'pull_request.opened'],
    repos: [...repos],
    review: { on: 'review_requested', approve: true },
  }
  if (webhookUrl !== null) config.webhookUrl = webhookUrl
  return config
}

let agentDir: string
const routers: ChannelRouter[] = []

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-github-lifecycle-'))
  await mkdir(join(agentDir, 'coder'))
})

afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.stop()))
  await rm(agentDir, { recursive: true, force: true })
})

function freshRouter(): ChannelRouter {
  const routerDir = join(agentDir, `router-${routers.length}`)
  mkdirSync(routerDir)
  const router = createChannelRouter({
    agentDir: routerDir,
    configForAdapter: () => ({
      ...ADAPTER_DEFAULTS,
      engagement: { ...ADAPTER_DEFAULTS.engagement, trigger: [...ADAPTER_DEFAULTS.engagement.trigger] },
    }),
  })
  routers.push(router)
  return router
}

describe('createGithubAdapter lifecycle', () => {
  test('wires draft control to the router and skips an unavailable cooldown store', async () => {
    const router = freshRouter()
    const abortSeen = Promise.withResolvers<void>()
    const cooldownSkipSeen = Promise.withResolvers<void>()
    const aborts: Array<{ workspace: string; prNumber: number; reason: string }> = []
    router.abortGithubPrTurn = async (workspace, prNumber, reason) => {
      aborts.push({ workspace, prNumber, reason })
      abortSeen.resolve()
      return { kind: 'no-live-session' }
    }
    const messages: string[] = []
    const logger = {
      info: (message: string) => {
        messages.push(message)
        if (message.includes('cooldown clear skipped') && message.includes('store not initialized')) {
          cooldownSkipSeen.resolve()
        }
      },
      warn: (message: string) => messages.push(message),
      error: (message: string) => messages.push(message),
    }
    let webhookHandler: ((request: Request) => Promise<Response>) | undefined
    const config = githubConfig([], null)
    config.eventAllowlist = ['pull_request.converted_to_draft']
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })
    const adapter = createGithubAdapter({
      router,
      configRef: () => config,
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: (_port, handler) => {
        webhookHandler = handler
        return { stop: async () => {} }
      },
      tokenRefreshIntervalMs: 0,
      reconcileIntervalMs: 0,
    })

    await adapter.start()
    if (webhookHandler === undefined) throw new Error('webhook handler was not registered')
    const response = await webhookHandler(
      signedWebhookRequest(
        {
          action: 'converted_to_draft',
          repository: { name: 'widgets', owner: { login: 'acme' } },
          pull_request: { number: 7, id: 700, draft: true },
          sender: { login: 'alice', id: 10, type: 'User' },
        },
        'pull_request',
        'draft-control',
      ),
    )
    await Promise.all([abortSeen.promise, cooldownSkipSeen.promise])

    expect(response.status).toBe(200)
    expect(aborts).toEqual([{ workspace: 'acme/widgets', prNumber: 7, reason: 'pull request converted to draft' }])
    expect(messages.some((message) => message.includes('no-live-session'))).toBe(true)
    await adapter.stop()
  })

  test('start() registers a webhook for every configured repo', async () => {
    const created: Array<{ repo: string; hookId: number }> = []
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') {
        return Response.json({ login: 'bot', id: 1 })
      }
      const match = url.match(/\/repos\/([^/]+)\/([^/]+)\/hooks\b/)
      if (match) {
        if (method === 'GET') return Response.json([])
        if (method === 'POST') {
          const repo = `${match[1]}/${match[2]}`
          const hookId = 100 + created.length
          created.push({ repo, hookId })
          return Response.json({ id: hookId }, { status: 201 })
        }
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets', 'acme/gadgets']),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(created).toEqual([
      { repo: 'acme/widgets', hookId: 100 },
      { repo: 'acme/gadgets', hookId: 101 },
    ])
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/hooks'))).toBe(true)
  })

  test('start() logs the webhook settings (effective URL, owner/repo repos, events) before registering', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      const match = url.match(/\/repos\/([^/]+)\/([^/]+)\/hooks\b/)
      if (match) {
        if (method === 'GET') return Response.json([])
        if (method === 'POST') return Response.json({ id: 200 }, { status: 201 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets', 'acme/gadgets'], null),
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => 'https://x.trycloudflare.com',
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    const settingsLog = logger.messages.find((m) => m.includes('registering webhook'))
    expect(settingsLog).toBeDefined()
    expect(settingsLog).toContain('info:')
    expect(settingsLog).toContain('https://x.trycloudflare.com/typeclaw/v1/github/')
    expect(settingsLog).toContain('acme/widgets')
    expect(settingsLog).toContain('acme/gadgets')
    expect(settingsLog).toContain('issue_comment.created')
    expect(settingsLog).toContain('pull_request.opened')
  })

  test('start() registers with configured webhookUrl when no tunnel URL callback is provided', async () => {
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json([])
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST')
        return Response.json({ id: 42 }, { status: 201 })
      if (method === 'DELETE') return new Response('', { status: 204 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    const registration = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/hooks'))
    expect(registration?.body).toContain('https://agent.example.com/gh')
  })

  test('start() registers with tunnel URL when webhookUrl is omitted', async () => {
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json([])
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST')
        return Response.json({ id: 42 }, { status: 201 })
      if (method === 'DELETE') return new Response('', { status: 204 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => 'https://x.trycloudflare.com',
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    const registration = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/hooks'))
    expect(registration?.body).toContain('https://x.trycloudflare.com')
  })

  test('start() prefers configured webhookUrl over tunnel URL', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json([])
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST')
        return Response.json({ id: 42 }, { status: 201 })
      if (method === 'DELETE') return new Response('', { status: 204 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], 'https://configured.example.com/gh'),
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => 'https://x.trycloudflare.com',
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    const registration = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/hooks'))
    expect(registration?.body).toContain('https://configured.example.com/gh')
    expect(registration?.body).not.toContain('https://x.trycloudflare.com')
    expect(logger.messages).toContain(
      'warn:[github] webhookUrl configured; ignoring tunnel URL for webhook registration',
    )
  })

  test('start() skips webhook registration (no tunnel configured) with an actionable WARN, not a quiet INFO', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelConfiguredForChannel: () => false,
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(calls.some((c) => c.url.includes('/hooks'))).toBe(false)
    const skipMsg = logger.messages.find((m) => m.includes('webhook registration SKIPPED'))
    expect(skipMsg).toBeDefined()
    expect(skipMsg).toContain('warn:')
    expect(skipMsg).toContain('no `channels.github.webhookUrl` set and no `tunnels[]` entry')
    expect(skipMsg).toContain('cloudflare-quick')
  })

  test('start() skips webhook registration (tunnel configured but URL not ready) names the tunnel as the failure surface', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => null,
      tunnelConfiguredForChannel: () => true,
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(calls.some((c) => c.url.includes('/hooks'))).toBe(false)
    const skipMsg = logger.messages.find((m) => m.includes('webhook registration SKIPPED'))
    expect(skipMsg).toBeDefined()
    expect(skipMsg).toContain('warn:')
    expect(skipMsg).toContain('tunnel is configured for this channel but produced no URL yet')
    expect(skipMsg).toContain('typeclaw tunnel status')
  })

  test('start() emits a quiet INFO (not WARN) when no repos are configured — there is nothing to register', async () => {
    const logger = recordingLogger()
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([], null),
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelConfiguredForChannel: () => true,
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(logger.messages).toContain('info:[github] no repos[] configured; webhook registration skipped')
    expect(logger.messages.some((m) => m.includes('warn:[github] webhook registration SKIPPED'))).toBe(false)
  })

  test('stop() deletes every hook registered by start() (detach on close)', async () => {
    const deleted: number[] = []
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json([])
      if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST') {
        return Response.json({ id: 42 }, { status: 201 })
      }
      const del = url.match(/\/repos\/acme\/widgets\/hooks\/(\d+)$/)
      if (del && method === 'DELETE') {
        deleted.push(Number(del[1]))
        return new Response('', { status: 204 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(deleted).toEqual([42])
  })

  test('repos[] empty: start/stop are no-ops on the GitHub hooks API', async () => {
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([]),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(calls.some((c) => c.url.includes('/hooks'))).toBe(false)
  })

  test('webhook register failure does not block adapter start (best-effort)', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks')) return new Response('forbidden', { status: 403 })
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    await adapter.stop()
  })

  test('list-hooks 404 emits a permission-setup guide referencing the failing repos and the github.com UI labels', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') || url.includes('/repos/acme/gadgets/hooks')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      }
      return new Response('unexpected', { status: 500 })
    })
    const logger = recordingLogger()

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets', 'acme/gadgets']),
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    const guidanceLines = logger.messages.filter((m) => m.includes('webhook setup needs more access for'))
    expect(guidanceLines.length).toBe(1)
    const guide = guidanceLines[0]!
    expect(guide).toContain('acme/widgets (404)')
    expect(guide).toContain('acme/gadgets (404)')
    expect(guide).toContain('"Resource owner"')
    expect(guide).toContain('"Repository permissions"')
    expect(guide).toContain('"Webhooks"')
    expect(guide).toContain('"Read and write"')
  })

  test('list-hooks 500 (transient server error) does NOT emit permission guidance (would be misleading)', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks')) return new Response('boom', { status: 500 })
      return new Response('unexpected', { status: 500 })
    })
    const logger = recordingLogger()

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(logger.messages.some((m) => m.includes('webhook setup needs more access for'))).toBe(false)
    expect(logger.messages.some((m) => m.includes('webhook register failed'))).toBe(true)
  })

  test('rotating tunnel URL across two adapter lifecycles: second start adopts and updates the prior hook instead of orphaning it', async () => {
    type Hook = { id: number; config: { url: string } }
    let nextHookId = 1000
    const repoHooks: Hook[] = []

    const fetchImpl: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
        if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json(repoHooks)
        if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST') {
          const parsed = JSON.parse(String(init?.body)) as { config: { url: string } }
          const hook: Hook = { id: nextHookId++, config: { url: parsed.config.url } }
          repoHooks.push(hook)
          return Response.json({ id: hook.id }, { status: 201 })
        }
        const idMatch = url.match(/\/repos\/acme\/widgets\/hooks\/(\d+)$/)
        if (idMatch && method === 'PATCH') {
          const parsed = JSON.parse(String(init?.body)) as { config: { url: string } }
          const target = repoHooks.find((h) => h.id === Number(idMatch[1]))
          if (target !== undefined) target.config.url = parsed.config.url
          return Response.json({ id: Number(idMatch[1]) })
        }
        if (idMatch && method === 'DELETE') {
          const id = Number(idMatch[1])
          const idx = repoHooks.findIndex((h) => h.id === id)
          if (idx >= 0) repoHooks.splice(idx, 1)
          return new Response('', { status: 204 })
        }
        return new Response('unexpected', { status: 500 })
      },
      { preconnect: () => {} },
    ) as typeof fetch

    let currentTunnelUrl = 'https://first.trycloudflare.com'
    const router1 = freshRouter()
    const adapter1 = createGithubAdapter({
      router: router1,
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir: join(agentDir, 'coder'),
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => currentTunnelUrl,
      webhookRegistrationDelayMs: 0,
    })
    await adapter1.start()
    expect(repoHooks.length).toBe(1)
    const firstHookId = repoHooks[0]!.id
    expect(repoHooks[0]?.config.url).toBe('https://first.trycloudflare.com/typeclaw/v1/github/coder')

    currentTunnelUrl = 'https://second.trycloudflare.com'

    const router2 = freshRouter()
    const adapter2 = createGithubAdapter({
      router: router2,
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir: join(agentDir, 'coder'),
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => currentTunnelUrl,
      webhookRegistrationDelayMs: 0,
    })
    await adapter2.start()

    expect(repoHooks.length).toBe(1)
    expect(repoHooks[0]?.id).toBe(firstHookId)
    expect(repoHooks[0]?.config.url).toBe('https://second.trycloudflare.com/typeclaw/v1/github/coder')

    await adapter2.stop()
    expect(repoHooks.length).toBe(0)
    await adapter1.stop()
  })

  test('legacy unmarked *.trycloudflare.com orphans (the reported bug) are cleaned up on the next adapter start', async () => {
    type Hook = { id: number; config: { url: string } }
    let nextHookId = 1000
    const repoHooks: Hook[] = [
      { id: 1, config: { url: 'https://examining-may-clerk-blue.trycloudflare.com' } },
      { id: 2, config: { url: 'https://effect-comprehensive-co.trycloudflare.com' } },
      { id: 3, config: { url: 'https://inclusion-convergence-co.trycloudflare.com' } },
    ]

    const fetchImpl: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
        if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') return Response.json(repoHooks)
        if (url.endsWith('/repos/acme/widgets/hooks') && method === 'POST') {
          const parsed = JSON.parse(String(init?.body)) as { config: { url: string } }
          const hook: Hook = { id: nextHookId++, config: { url: parsed.config.url } }
          repoHooks.push(hook)
          return Response.json({ id: hook.id }, { status: 201 })
        }
        const idMatch = url.match(/\/repos\/acme\/widgets\/hooks\/(\d+)$/)
        if (idMatch && method === 'PATCH') {
          const parsed = JSON.parse(String(init?.body)) as { config: { url: string } }
          const target = repoHooks.find((h) => h.id === Number(idMatch[1]))
          if (target !== undefined) target.config.url = parsed.config.url
          return Response.json({ id: Number(idMatch[1]) })
        }
        if (idMatch && method === 'DELETE') {
          const id = Number(idMatch[1])
          const idx = repoHooks.findIndex((h) => h.id === id)
          if (idx >= 0) repoHooks.splice(idx, 1)
          return new Response('', { status: 204 })
        }
        return new Response('unexpected', { status: 500 })
      },
      { preconnect: () => {} },
    ) as typeof fetch

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets'], null),
      secrets: patSecrets(),
      agentDir: join(agentDir, 'coder'),
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      tunnelUrl: () => 'https://fresh.trycloudflare.com',
      webhookRegistrationDelayMs: 0,
    })
    await adapter.start()

    expect(repoHooks.length).toBe(1)
    expect(repoHooks[0]?.config.url).toBe('https://fresh.trycloudflare.com/typeclaw/v1/github/coder')

    await adapter.stop()
    expect(repoHooks.length).toBe(0)
  })

  test('stop() does not attempt detach when no hooks were registered (e.g. registration failed)', async () => {
    const deleted: string[] = []
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') {
        return new Response('forbidden', { status: 403 })
      }
      if (method === 'DELETE') {
        deleted.push(url)
        return new Response('', { status: 204 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(deleted).toEqual([])
  })

  test('App auth: preflight warns when installation permissions do not cover the configured eventAllowlist', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url === 'https://api.github.com/app' && method === 'GET') {
        return Response.json({ slug: 'typeey-app' })
      }
      if (url === 'https://api.github.com/users/typeey-app%5Bbot%5D' && method === 'GET') {
        return Response.json({ id: 42, login: 'typeey-app[bot]' })
      }
      if (url === 'https://api.github.com/app/installations' && method === 'GET') {
        return Response.json([{ id: 99 }])
      }
      if (url === 'https://api.github.com/app/installations/99' && method === 'GET') {
        return Response.json({
          permissions: { metadata: 'read', repository_hooks: 'write' },
          events: [],
        })
      }
      if (url === 'https://api.github.com/app/installations/99/access_tokens' && method === 'POST') {
        return Response.json({ token: 'ghs_inst', expires_at: '2099-01-01T00:00:00Z' })
      }
      return new Response('unexpected', { status: 500 })
    })

    const logger = recordingLogger()
    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([], null),
      secrets: appSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    const preflightWarning = logger.messages.find((m) =>
      m.startsWith('warn:[github] GitHub App installation is missing permissions'),
    )
    expect(preflightWarning).toBeDefined()
    expect(preflightWarning).toContain('Issues: granted=none, need=Read and write')
    expect(preflightWarning).toContain('Pull requests: granted=none, need=Read and write')
    expect(preflightWarning).toContain('covers: issue_comment.created')
    expect(preflightWarning).toContain('Resource not accessible by integration')
  })

  test('App auth: preflight stays silent when every required permission is granted', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url === 'https://api.github.com/app' && method === 'GET') {
        return Response.json({ slug: 'typeey-app' })
      }
      if (url === 'https://api.github.com/users/typeey-app%5Bbot%5D' && method === 'GET') {
        return Response.json({ id: 42, login: 'typeey-app[bot]' })
      }
      if (url === 'https://api.github.com/app/installations' && method === 'GET') {
        return Response.json([{ id: 99 }])
      }
      if (url === 'https://api.github.com/app/installations/99' && method === 'GET') {
        return Response.json({
          permissions: { issues: 'write', pull_requests: 'write', metadata: 'read' },
          events: ['issues', 'issue_comment', 'pull_request'],
        })
      }
      if (url === 'https://api.github.com/app/installations/99/access_tokens' && method === 'POST') {
        return Response.json({ token: 'ghs_inst', expires_at: '2099-01-01T00:00:00Z' })
      }
      return new Response('unexpected', { status: 500 })
    })

    const logger = recordingLogger()
    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([], null),
      secrets: appSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(logger.messages.some((m) => m.includes('GitHub App installation is missing'))).toBe(false)
  })

  test('PAT auth: preflight is skipped (no installation grant to inspect)', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    const logger = recordingLogger()
    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([], null),
      secrets: patSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    await adapter.stop()

    expect(logger.messages.some((m) => m.includes('GitHub App installation is missing'))).toBe(false)
    expect(logger.messages.some((m) => m.includes('preflight skipped'))).toBe(false)
  })

  test('App auth: preflight failure is logged as a skip, not propagated as an adapter-start error', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url === 'https://api.github.com/app' && method === 'GET') {
        return Response.json({ slug: 'typeey-app' })
      }
      if (url === 'https://api.github.com/users/typeey-app%5Bbot%5D' && method === 'GET') {
        return Response.json({ id: 42, login: 'typeey-app[bot]' })
      }
      if (url === 'https://api.github.com/app/installations' && method === 'GET') {
        return Response.json([{ id: 99 }])
      }
      if (url === 'https://api.github.com/app/installations/99' && method === 'GET') {
        return new Response('boom', { status: 500 })
      }
      if (url === 'https://api.github.com/app/installations/99/access_tokens' && method === 'POST') {
        return Response.json({ token: 'ghs_inst', expires_at: '2099-01-01T00:00:00Z' })
      }
      return new Response('unexpected', { status: 500 })
    })

    const logger = recordingLogger()
    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([], null),
      secrets: appSecrets(),
      agentDir,
      logger,
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await expect(adapter.start()).resolves.toBeUndefined()
    await adapter.stop()

    expect(logger.messages.find((m) => m.startsWith('warn:[github] permission preflight skipped'))).toBeDefined()
  })

  test('start() sleeps webhookRegistrationDelayMs before calling the GitHub hooks API', async () => {
    const events: string[] = []
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks')) {
        if (method === 'GET') {
          events.push('hooks-list')
          return Response.json([])
        }
        if (method === 'POST') {
          events.push('hooks-create')
          return Response.json({ id: 42 }, { status: 201 })
        }
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 1234,
      sleep: async (ms) => {
        events.push(`sleep(${ms})`)
      },
    })

    await adapter.start()
    await adapter.stop()

    expect(events).toEqual(['sleep(1234)', 'hooks-list', 'hooks-create'])
  })

  test('start() skips the sleep when webhookRegistrationDelayMs is 0', async () => {
    const events: string[] = []
    let sleepCalls = 0
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/repos/acme/widgets/hooks') && method === 'GET') {
        events.push('hooks-list')
        return Response.json([])
      }
      if (url.includes('/repos/acme/widgets/hooks') && method === 'POST') {
        events.push('hooks-create')
        return Response.json({ id: 42 }, { status: 201 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
      sleep: async () => {
        sleepCalls += 1
      },
    })

    await adapter.start()
    await adapter.stop()

    expect(sleepCalls).toBe(0)
    expect(events).toEqual(['hooks-list', 'hooks-create'])
  })

  test('delivery-recovery sweep is registered once hooks exist, queries the delivery log, and is cleared on stop', async () => {
    // Resolve deterministically when the sweep hits the deliveries endpoint,
    // instead of racing a fixed sleep against the token-mint + list round-trips.
    let resolveDeliveriesQueried!: () => void
    const deliveriesQueried = new Promise<void>((resolve) => {
      resolveDeliveriesQueried = resolve
    })
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url === 'https://api.github.com/app' && method === 'GET') return Response.json({ slug: 'typeey-app' })
      if (url === 'https://api.github.com/users/typeey-app%5Bbot%5D' && method === 'GET') {
        return Response.json({ id: 42, login: 'typeey-app[bot]' })
      }
      if (url === 'https://api.github.com/repos/acme/widgets/installation' && method === 'GET') {
        return Response.json({ id: 99 })
      }
      if (url === 'https://api.github.com/app/installations/99/access_tokens' && method === 'POST') {
        return Response.json({ token: 'ghs_fresh', expires_at: '2099-01-01T00:00:00Z' })
      }
      if (url.includes('/repos/acme/widgets/hooks/7/deliveries')) {
        resolveDeliveriesQueried()
        return Response.json([])
      }
      if (url.includes('/repos/acme/widgets/hooks')) {
        if (method === 'GET') return Response.json([])
        if (method === 'POST') return Response.json({ id: 7 }, { status: 201 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const handlers: Array<() => void> = []
    let clears = 0
    const fakeInterval = (handler: () => void) => {
      handlers.push(handler)
      return { clear: () => (clears += 1) }
    }

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets']),
      secrets: appSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
      tokenRefreshIntervalMs: 0,
      reconcileIntervalMs: 0,
      setInterval: fakeInterval,
    })

    await adapter.start()
    // tokenRefreshIntervalMs: 0 and reconcileIntervalMs: 0 disable those timers,
    // so the only timer is the recovery sweep — proving it registers
    // independently of the token refresh and reconcile ticks.
    expect(handlers.length).toBe(1)

    handlers[0]!()
    await deliveriesQueried // resolves only when the sweep queries the delivery log

    await adapter.stop()
    expect(clears).toBe(1)
  })

  test('tokenRefreshIntervalMs: 0 disables the background refresh', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
      return new Response('unexpected', { status: 500 })
    })

    let setIntervalCalls = 0
    const fakeInterval = (handler: () => void, _ms: number) => {
      setIntervalCalls += 1
      return { clear: () => {} }
    }

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([], null),
      secrets: patSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
      tokenRefreshIntervalMs: 0,
      setInterval: fakeInterval,
    })

    await adapter.start()
    expect(setIntervalCalls).toBe(0)
    await adapter.stop()
  })

  test('App auth: single-owner multi-repo does not seed GH_TOKEN', async () => {
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url === 'https://api.github.com/app' && method === 'GET') return Response.json({ slug: 'typeey-app' })
      if (url === 'https://api.github.com/users/typeey-app%5Bbot%5D' && method === 'GET') {
        return Response.json({ id: 42, login: 'typeey-app[bot]' })
      }
      if (url.endsWith('/installation') && method === 'GET') return Response.json({ id: 99 })
      if (url === 'https://api.github.com/app/installations/99' && method === 'GET') {
        return Response.json({ permissions: { metadata: 'read' }, events: [] })
      }
      if (url === 'https://api.github.com/app/installations/99/access_tokens' && method === 'POST') {
        return Response.json({ token: 'ghs_owner', expires_at: '2099-01-01T00:00:00Z' })
      }
      if (url.includes('/hooks')) {
        if (method === 'GET') return Response.json([])
        if (method === 'POST') return Response.json({ id: 7 }, { status: 201 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets', 'acme/gadgets']),
      secrets: appSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    expect(process.env.GH_TOKEN).toBeUndefined()
    // Runtime-owned API calls resolve installations by repository and never use
    // the org-only endpoint, which would fail for personal repositories.
    expect(calls.some((c) => c.url === 'https://api.github.com/repos/acme/gadgets/installation')).toBe(true)
    expect(calls.some((c) => c.url.startsWith('https://api.github.com/orgs/'))).toBe(false)
    await adapter.stop()
    expect(process.env.GH_TOKEN).toBeUndefined()
  })

  test('App auth: user-owned repository does not seed GH_TOKEN', async () => {
    const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
      if (url === 'https://api.github.com/app' && method === 'GET') return Response.json({ slug: 'typeey-app' })
      if (url === 'https://api.github.com/users/typeey-app%5Bbot%5D' && method === 'GET') {
        return Response.json({ id: 42, login: 'typeey-app[bot]' })
      }
      // A personal account only resolves through repos/{owner}/{repo}/installation.
      // orgs/{owner}/installation would 404 here — the regression this guards.
      if (url === 'https://api.github.com/repos/octocat/hello/installation' && method === 'GET') {
        return Response.json({ id: 77 })
      }
      if (url === 'https://api.github.com/orgs/octocat/installation' && method === 'GET') {
        return new Response('Not Found', { status: 404 })
      }
      if (url === 'https://api.github.com/app/installations/77' && method === 'GET') {
        return Response.json({ permissions: { metadata: 'read' }, events: [] })
      }
      if (url === 'https://api.github.com/app/installations/77/access_tokens' && method === 'POST') {
        return Response.json({ token: 'ghs_user', expires_at: '2099-01-01T00:00:00Z' })
      }
      if (url.includes('/hooks')) {
        if (method === 'GET') return Response.json([])
        if (method === 'POST') return Response.json({ id: 7 }, { status: 201 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['octocat/hello']),
      secrets: appSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(calls.some((c) => c.url === 'https://api.github.com/orgs/octocat/installation')).toBe(false)
    await adapter.stop()
    expect(process.env.GH_TOKEN).toBeUndefined()
  })

  test('App auth: repositories spanning multiple owners do not seed GH_TOKEN', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url === 'https://api.github.com/app' && method === 'GET') return Response.json({ slug: 'typeey-app' })
      if (url === 'https://api.github.com/users/typeey-app%5Bbot%5D' && method === 'GET') {
        return Response.json({ id: 42, login: 'typeey-app[bot]' })
      }
      if (url.endsWith('/installation') && method === 'GET') return Response.json({ id: 99 })
      if (url === 'https://api.github.com/app/installations/99' && method === 'GET') {
        return Response.json({ permissions: { metadata: 'read' }, events: [] })
      }
      if (url === 'https://api.github.com/app/installations/99/access_tokens' && method === 'POST') {
        return Response.json({ token: 'ghs_inst', expires_at: '2099-01-01T00:00:00Z' })
      }
      if (url.includes('/hooks')) {
        if (method === 'GET') return Response.json([])
        if (method === 'POST') return Response.json({ id: 7 }, { status: 201 })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig(['acme/widgets', 'globex/gizmos']),
      secrets: appSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    expect(process.env.GH_TOKEN).toBeUndefined()
    await adapter.stop()
  })

  test('App auth: no repositories configured does not seed GH_TOKEN', async () => {
    const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
      if (url === 'https://api.github.com/app' && method === 'GET') return Response.json({ slug: 'typeey-app' })
      if (url === 'https://api.github.com/users/typeey-app%5Bbot%5D' && method === 'GET') {
        return Response.json({ id: 42, login: 'typeey-app[bot]' })
      }
      if (url === 'https://api.github.com/app/installations' && method === 'GET') return Response.json([{ id: 99 }])
      if (url === 'https://api.github.com/app/installations/99' && method === 'GET') {
        return Response.json({ permissions: { metadata: 'read' }, events: [] })
      }
      if (url === 'https://api.github.com/app/installations/99/access_tokens' && method === 'POST') {
        return Response.json({ token: 'ghs_sole', expires_at: '2099-01-01T00:00:00Z' })
      }
      return new Response('unexpected', { status: 500 })
    })

    const adapter = createGithubAdapter({
      router: freshRouter(),
      configRef: () => githubConfig([], null),
      secrets: appSecrets(),
      agentDir,
      logger: silentLogger(),
      fetchImpl,
      httpListenImpl: () => ({ stop: async () => {} }),
      webhookRegistrationDelayMs: 0,
    })

    await adapter.start()
    expect(process.env.GH_TOKEN).toBeUndefined()
    await adapter.stop()
  })

  describe('App-auth token bridge repo allowlist', () => {
    function mintingFetch(): { fetch: typeof fetch; calls: Call[] } {
      return fakeFetchRecording(({ url, method }) => {
        if (url.endsWith('/app') && method === 'GET') return Response.json({ slug: 'mybot' })
        if (url.includes('/users/') && method === 'GET') return Response.json({ id: 1, login: 'mybot[bot]' })
        const install = url.match(/\/repos\/([^/]+)\/([^/]+)\/installation$/)
        if (install && method === 'GET') return Response.json({ id: 777 })
        if (url.endsWith('/app/installations/777/access_tokens') && method === 'POST') {
          return Response.json({ token: 'ghs_minted', expires_at: '2099-01-01T00:00:00Z' }, { status: 201 })
        }
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      })
    }

    test('preserves an operator GH_TOKEN through App start and stop while repo-scoped minting remains available', async () => {
      const { createGithubTokenBridge } = await import('@/channels/github-token-bridge')
      const bridge = createGithubTokenBridge()
      const { fetch: fetchImpl } = mintingFetch()
      const originalToken = process.env.GH_TOKEN
      process.env.GH_TOKEN = 'ghp_operator'
      const adapter = createGithubAdapter({
        router: freshRouter(),
        configRef: () => githubConfig(['acme/widgets']),
        secrets: appSecrets(),
        agentDir,
        logger: silentLogger(),
        fetchImpl,
        httpListenImpl: () => ({ stop: async () => {} }),
        webhookRegistrationDelayMs: 0,
        githubTokenBridge: bridge,
      })

      try {
        await adapter.start()
        expect(process.env.GH_TOKEN).toBe('ghp_operator')
        await expect(bridge.resolveTokenForRepo('acme/widgets')).resolves.toEqual({
          kind: 'token',
          token: 'ghs_minted',
          accountIdentity: 'github:1',
        })
        await adapter.stop()
        expect(process.env.GH_TOKEN).toBe('ghp_operator')
      } finally {
        await adapter.stop()
        if (originalToken === undefined) delete process.env.GH_TOKEN
        else process.env.GH_TOKEN = originalToken
      }
    })

    test('mints for a repo in repos[]', async () => {
      const { createGithubTokenBridge } = await import('@/channels/github-token-bridge')
      const bridge = createGithubTokenBridge()
      const { fetch: fetchImpl } = mintingFetch()
      const adapter = createGithubAdapter({
        router: freshRouter(),
        configRef: () => githubConfig(['acme/widgets']),
        secrets: appSecrets(),
        agentDir,
        logger: silentLogger(),
        fetchImpl,
        httpListenImpl: () => ({ stop: async () => {} }),
        webhookRegistrationDelayMs: 0,
        githubTokenBridge: bridge,
      })

      await adapter.start()
      const result = await bridge.resolveTokenForRepo('acme/widgets')
      await adapter.stop()

      expect(result).toEqual({ kind: 'token', token: 'ghs_minted', accountIdentity: 'github:1' })
    })

    test('refuses to mint for a repo not in repos[] (blocks cross-repo token minting)', async () => {
      const { createGithubTokenBridge } = await import('@/channels/github-token-bridge')
      const bridge = createGithubTokenBridge()
      const { fetch: fetchImpl, calls } = mintingFetch()
      const adapter = createGithubAdapter({
        router: freshRouter(),
        configRef: () => githubConfig(['acme/widgets']),
        secrets: appSecrets(),
        agentDir,
        logger: silentLogger(),
        fetchImpl,
        httpListenImpl: () => ({ stop: async () => {} }),
        webhookRegistrationDelayMs: 0,
        githubTokenBridge: bridge,
      })

      await adapter.start()
      const result = await bridge.resolveTokenForRepo('victim/private')
      await adapter.stop()

      expect(result.kind).toBe('unavailable')
      if (result.kind === 'unavailable') expect(result.reason).toContain('not in this agent')
      // The disallowed repo is never even looked up — the allowlist rejects it
      // before any GitHub API call. (The configured repo IS minted during
      // start()'s seed/preflight, so we assert on the victim repo specifically.)
      expect(calls.some((c) => c.url.includes('/repos/victim/private/'))).toBe(false)
    })
  })

  describe('start() open-PR reconciliation', () => {
    function reviewConfig(on: 'opened' | 'review_requested' | 'off') {
      return (): ChannelAdapterConfig & GithubAdapterConfig => {
        const config = githubConfig(['acme/widgets'])
        config.review = { on, approve: true }
        return config
      }
    }

    test("reviewOn 'opened' scans open PRs and checks reviews for an un-reviewed one", async () => {
      const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
        if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
        const hooks = url.match(/\/repos\/[^/]+\/[^/]+\/hooks\b/)
        if (hooks) {
          if (method === 'GET') return Response.json([])
          if (method === 'POST') return Response.json({ id: 1 }, { status: 201 })
        }
        if (url.match(/\/pulls\/7\/reviews/)) return Response.json([])
        if (url.includes('/pulls?'))
          return Response.json([
            {
              number: 7,
              id: 700,
              title: 'Add thing',
              draft: false,
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'alice', id: 10, type: 'User' },
              head: { ref: 'feature' },
              base: { ref: 'main' },
              requested_reviewers: [],
            },
          ])
        return new Response('unexpected', { status: 500 })
      })

      const adapter = createGithubAdapter({
        router: freshRouter(),
        configRef: reviewConfig('opened'),
        secrets: patSecrets(),
        agentDir,
        logger: silentLogger(),
        fetchImpl,
        httpListenImpl: () => ({ stop: async () => {} }),
        webhookRegistrationDelayMs: 0,
      })

      await adapter.start()
      await adapter.stop()

      expect(calls.some((c) => c.url.includes('/repos/acme/widgets/pulls?state=open'))).toBe(true)
      expect(calls.some((c) => c.url.includes('/repos/acme/widgets/pulls/7/reviews'))).toBe(true)
    })

    test("reviewOn 'off' does not scan open PRs", async () => {
      const { fetch: fetchImpl, calls } = fakeFetchRecording(({ url, method }) => {
        if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
        const hooks = url.match(/\/repos\/[^/]+\/[^/]+\/hooks\b/)
        if (hooks) {
          if (method === 'GET') return Response.json([])
          if (method === 'POST') return Response.json({ id: 1 }, { status: 201 })
        }
        return new Response('unexpected', { status: 500 })
      })

      const adapter = createGithubAdapter({
        router: freshRouter(),
        configRef: reviewConfig('off'),
        secrets: patSecrets(),
        agentDir,
        logger: silentLogger(),
        fetchImpl,
        httpListenImpl: () => ({ stop: async () => {} }),
        webhookRegistrationDelayMs: 0,
      })

      await adapter.start()
      await adapter.stop()

      expect(calls.some((c) => c.url.includes('/pulls'))).toBe(false)
    })

    function unreviewedPrFetch(): { fetch: typeof fetch; routedPrs: () => number } {
      let routed = 0
      const { fetch: fetchImpl } = fakeFetchRecording(({ url, method }) => {
        if (url.endsWith('/user') && method === 'GET') return Response.json({ login: 'bot', id: 1 })
        const hooks = url.match(/\/repos\/[^/]+\/[^/]+\/hooks\b/)
        if (hooks) {
          if (method === 'GET') return Response.json([])
          if (method === 'POST') return Response.json({ id: 1 }, { status: 201 })
        }
        if (url.match(/\/pulls\/7\/reviews/)) return Response.json([])
        if (url.includes('/pulls?')) {
          routed += 1
          return Response.json([
            {
              number: 7,
              id: 700,
              title: 'Add thing',
              draft: false,
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'alice', id: 10, type: 'User' },
              head: { ref: 'feature' },
              base: { ref: 'main' },
              requested_reviewers: [],
            },
          ])
        }
        return new Response('unexpected', { status: 500 })
      })
      return { fetch: fetchImpl, routedPrs: () => routed }
    }

    test('a restart within the cooldown does NOT replay the same unreviewed PR twice', async () => {
      const agentDir = await mkdtemp(join(tmpdir(), 'gh-reconcile-lifecycle-'))
      try {
        const routes: string[] = []
        const router = freshRouter()
        const originalRoute = router.route.bind(router)
        router.route = (m) => {
          routes.push(m.chat)
          return originalRoute(m)
        }

        const build = () => {
          const { fetch: fetchImpl } = unreviewedPrFetch()
          return createGithubAdapter({
            router,
            configRef: reviewConfig('opened'),
            secrets: patSecrets(),
            agentDir,
            logger: silentLogger(),
            fetchImpl,
            httpListenImpl: () => ({ stop: async () => {} }),
            webhookRegistrationDelayMs: 0,
            tokenRefreshIntervalMs: 0,
            reconcileIntervalMs: 0,
          })
        }

        const first = build()
        await first.start()
        await first.stop()

        const second = build()
        await second.start()
        await second.stop()

        expect(routes.filter((c) => c === 'pr:7')).toHaveLength(1)
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    })

    test('the periodic reconcile tick fires the pass again after start()', async () => {
      const agentDir = await mkdtemp(join(tmpdir(), 'gh-reconcile-lifecycle-'))
      try {
        const { fetch: fetchImpl, routedPrs } = unreviewedPrFetch()
        const handlers: Array<() => void> = []
        const fakeInterval = (handler: () => void) => {
          handlers.push(handler)
          return { clear: () => {} }
        }

        const adapter = createGithubAdapter({
          router: freshRouter(),
          configRef: reviewConfig('opened'),
          secrets: patSecrets(),
          agentDir,
          logger: silentLogger(),
          fetchImpl,
          httpListenImpl: () => ({ stop: async () => {} }),
          webhookRegistrationDelayMs: 0,
          tokenRefreshIntervalMs: 0,
          deliveryRecoveryIntervalMs: 0,
          setInterval: fakeInterval,
        })

        await adapter.start()
        const afterStart = routedPrs()
        expect(afterStart).toBe(1)
        expect(handlers).toHaveLength(1)

        handlers[0]!()
        await Promise.resolve()
        await Promise.resolve()

        expect(routedPrs()).toBe(2)
        await adapter.stop()
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    })

    test('a live review.on change to off stops the periodic reconcile tick from scanning', async () => {
      const agentDir = await mkdtemp(join(tmpdir(), 'gh-reconcile-lifecycle-'))
      try {
        const { fetch: fetchImpl, routedPrs } = unreviewedPrFetch()
        let reviewOn: 'opened' | 'off' = 'opened'
        const configRef = (): ChannelAdapterConfig & GithubAdapterConfig => {
          const config = githubConfig(['acme/widgets'])
          config.review = { on: reviewOn, approve: true }
          return config
        }
        const handlers: Array<() => void> = []
        const fakeInterval = (handler: () => void) => {
          handlers.push(handler)
          return { clear: () => {} }
        }

        const adapter = createGithubAdapter({
          router: freshRouter(),
          configRef,
          secrets: patSecrets(),
          agentDir,
          logger: silentLogger(),
          fetchImpl,
          httpListenImpl: () => ({ stop: async () => {} }),
          webhookRegistrationDelayMs: 0,
          tokenRefreshIntervalMs: 0,
          deliveryRecoveryIntervalMs: 0,
          setInterval: fakeInterval,
        })

        await adapter.start()
        expect(routedPrs()).toBe(1)

        reviewOn = 'off'
        handlers[0]!()
        await Promise.resolve()
        await Promise.resolve()

        expect(routedPrs()).toBe(1)
        await adapter.stop()
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    })
  })
})
