import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetForwardRequestForTesting as resetDashboardForwardRequest } from '@/bundled-plugins/agent-browser'
import { createChannelRouter, type ChannelManager, type ChannelManagerOptions } from '@/channels'
import { __resetConfigForTesting, reloadConfig } from '@/config/config'
import type { CronFile, CronJob, LoadCronResult, Scheduler } from '@/cron'
import { exportGithubCliStoreForAgent, SecretsBackend } from '@/secrets'
import type { SessionFactory } from '@/sessions'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'
import type { TuiOptions } from '@/tui'
import type { TunnelManager, TunnelManagerOptions } from '@/tunnels'

import {
  type LoadCronFn,
  type SchedulerFactory,
  startAgent as startAgentRuntime,
  type StartAgentOptions,
  type TuiFactory,
} from './index'

const noCron: LoadCronFn = async () => ({ ok: true, file: null }) as LoadCronResult

let githubCliHomeDir: string

function startAgent(options: StartAgentOptions) {
  return startAgentRuntime({
    ...options,
    exportGithubCliStore:
      options.exportGithubCliStore ??
      ((exportOptions) => exportGithubCliStoreForAgent({ ...exportOptions, homeDir: githubCliHomeDir })),
  })
}

function stubScheduler(): Scheduler {
  return {
    start: () => {},
    stop: () => {},
    replaceJobs: () => ({ added: [], removed: [], updated: [], unchanged: [] }),
    currentJobs: () => [],
  }
}

let running: Awaited<ReturnType<typeof startAgent>> | null = null
let savedBrokerToken: string | undefined

beforeEach(async () => {
  githubCliHomeDir = await mkdtemp(join(tmpdir(), 'typeclaw-run-home-'))
  // startAgent boots the agent-browser plugin. Keep the broker token absent so
  // these run-loop tests do not publish a reserved dashboard forward request
  // into an unrelated in-process bus subscriber.
  savedBrokerToken = process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
  delete process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
})

afterEach(async () => {
  resetDashboardForwardRequest()
  if (savedBrokerToken === undefined) delete process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
  else process.env['TYPECLAW_HOSTD_BROKER_TOKEN'] = savedBrokerToken
  if (running) {
    running.tuiPromise?.catch(() => {})
    await running.stop()
    running = null
  }
  await rmTempDir(githubCliHomeDir)
})

describe('startAgent', () => {
  // Isolate cwd per test: startAgent defaults cwd to process.cwd(), and the
  // cron/session/todo paths derive agentDir from it. Without this, a fired
  // cron job writes todo/cron/*.json into the repo source tree (dev stage).
  let testCwd: string
  beforeEach(async () => {
    testCwd = await mkdtemp(join(tmpdir(), 'typeclaw-run-cwd-'))
  })
  afterEach(async () => {
    await rmTempDir(testCwd)
  })

  test('starts a ws server on an ephemeral port in headless mode', async () => {
    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron })

    expect(running.server.port).toBeGreaterThan(0)
    expect(running.tuiPromise).toBeNull()

    const res = await fetch(`http://localhost:${running.server.port}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('typeclaw agent')
  })

  test('keeps the host GitHub CLI store untouched when the agent has no stored credential', async () => {
    const hostHomeDir = await mkdtemp(join(tmpdir(), 'typeclaw-run-host-home-'))
    const hostTarget = join(hostHomeDir, '.config', 'gh', 'hosts.yml')
    const runtimeTarget = join(githubCliHomeDir, '.config', 'gh', 'hosts.yml')
    const sentinel = 'host credential sentinel\n'
    const savedHome = process.env.HOME

    await mkdir(join(hostHomeDir, '.config', 'gh'), { recursive: true })
    await mkdir(join(githubCliHomeDir, '.config', 'gh'), { recursive: true })
    await Bun.write(hostTarget, sentinel)
    await Bun.write(runtimeTarget, 'stale runtime credential\n')
    process.env.HOME = hostHomeDir
    try {
      running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron })

      expect(await Bun.file(hostTarget).text()).toBe(sentinel)
      expect(existsSync(runtimeTarget)).toBe(false)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      await rmTempDir(hostHomeDir)
    }
  })

  test('awaits provider-OAuth refresh before any session consumer starts, so a lock-holding refresh cannot block a boot credential read', async () => {
    // given a refresh that acquires the REAL CredentialStore lock and blocks on
    // a gate, and a channel manager whose start() does a real synchronous
    // secrets read on the same file
    const order: string[] = []
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let lockAcquired: () => void = () => {}
    const lockAcquiredSignal = new Promise<void>((resolve) => {
      lockAcquired = resolve
    })

    const refreshProviderOAuth = async ({ agentDir }: { agentDir: string }): Promise<unknown> => {
      const backend = new SecretsBackend(join(agentDir, 'secrets.json'))
      await backend.modify('openai', async (current) => {
        order.push('refresh:lock-acquired')
        lockAcquired()
        await gate
        order.push('refresh:lock-released')
        return current
      })
      return { result: undefined }
    }

    const createChannelManagerFor = (opts: ChannelManagerOptions): ChannelManager => ({
      router: createChannelRouter({
        agentDir: testCwd,
        configForAdapter: () => undefined,
        backgroundObligations: opts.backgroundObligations,
        inboundJournal: opts.inboundJournal,
        recoveryOutbox: opts.recoveryOutbox,
      }),
      start: async () => {
        // A real sync read on the same lock — throws ELOCKED if the refresh
        // still owns the lock, which is exactly the boot race under test.
        new SecretsBackend(join(testCwd, 'secrets.json')).tryReadProvidersSync()
        order.push('channel:start')
        order.push('auth:sync-read')
      },
      stop: async () => {},
      reload: async () => ({ started: [], stopped: [], restarted: [], restartRequired: [] }),
      restartAdapter: async () => {},
    })

    // when startAgent boots WITHOUT being awaited yet
    const booting = startAgent({
      port: 0,
      attachTui: false,
      cwd: testCwd,
      loadCron: noCron,
      createChannelManager: createChannelManagerFor,
      refreshProviderOAuth,
      exportCodexAuthFile: () => {
        order.push('export:codex')
        return { action: 'skipped', reason: 'codex-cli-disabled' }
      },
      exportClaudeCredentialsFile: () => {
        order.push('export:claude')
        return { action: 'skipped', reason: 'claude-code-disabled' }
      },
      exportGithubCliStore: () => {
        order.push('export:github-cli')
        return { action: 'skipped', reason: 'no-github-cli-credential' }
      },
    })

    await lockAcquiredSignal

    // then the refresh owns the lock and NO consumer has started
    expect(order).toEqual(['refresh:lock-acquired'])
    expect(order).not.toContain('channel:start')

    // when the gate releases, boot completes with the lock free
    releaseGate()
    running = await booting

    // then ordering is exact: refresh settles fully before the channel start
    // (and its synchronous auth read, which did not ELOCKED)
    expect(order).toEqual([
      'refresh:lock-acquired',
      'refresh:lock-released',
      'export:codex',
      'export:claude',
      'export:github-cli',
      'channel:start',
      'auth:sync-read',
    ])
  })

  test('installs a process crash guard so an escaped channel rejection does not crash', async () => {
    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron })
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThanOrEqual(1)

    // The webex KMS shape from the incident: emitting it as a real process
    // event must be contained by the installed guard, not re-thrown.
    const kmsError = Object.assign(new Error('KMS request timed out'), { code: 'KMS_ERROR' })
    expect(() => process.emit('unhandledRejection', kmsError, Promise.resolve())).not.toThrow()

    await running.stop()
    running = null
  })

  test('disposes the process crash guard when boot fails after install', async () => {
    const before = process.listenerCount('unhandledRejection')
    // A channel manager whose start() rejects forces a boot failure AFTER the
    // guard is installed but BEFORE startAgent returns, so the caller never gets
    // a stop() to call — the guard must self-dispose on the throw, not leak.
    const failingChannelManager = (opts: ChannelManagerOptions): ChannelManager => ({
      router: createChannelRouter({
        agentDir: testCwd,
        configForAdapter: () => undefined,
        backgroundObligations: opts.backgroundObligations,
        inboundJournal: opts.inboundJournal,
        recoveryOutbox: opts.recoveryOutbox,
      }),
      start: async () => {
        void opts
        throw new Error('boot failure: channel manager start rejected')
      },
      stop: async () => {},
      reload: async () => ({ started: [], stopped: [], restarted: [], restartRequired: [] }),
      restartAdapter: async () => {},
    })

    await expect(
      startAgent({
        port: 0,
        attachTui: false,
        cwd: testCwd,
        loadCron: noCron,
        createChannelManager: failingChannelManager,
      }),
    ).rejects.toThrow('boot failure: channel manager start rejected')

    expect(process.listenerCount('unhandledRejection')).toBe(before)
    // running stays null: startAgent threw, there is nothing to tear down.
  })

  test('the resource sampler is torn down on a normal stop', async () => {
    // given a sampler whose disposer we can observe
    let stopped = 0
    running = await startAgent({
      port: 0,
      attachTui: false,
      cwd: testCwd,
      loadCron: noCron,
      startResourceSampler: () => () => {
        stopped += 1
      },
    })
    expect(stopped).toBe(0)

    // when the agent stops normally
    await running.stop()
    running = null

    // then the interval is cleared rather than left scanning /proc forever
    expect(stopped).toBe(1)
  })

  test('the resource sampler is torn down when boot fails after it starts', async () => {
    let stopped = 0
    const failingChannelManager = (opts: ChannelManagerOptions): ChannelManager => ({
      router: createChannelRouter({
        agentDir: testCwd,
        configForAdapter: () => undefined,
        backgroundObligations: opts.backgroundObligations,
        inboundJournal: opts.inboundJournal,
        recoveryOutbox: opts.recoveryOutbox,
      }),
      start: async () => {
        throw new Error('boot failure: sampler cleanup')
      },
      stop: async () => {},
      reload: async () => ({ started: [], stopped: [], restarted: [], restartRequired: [] }),
      restartAdapter: async () => {},
    })

    // when boot throws after the sampler is already running, the caller never
    // receives stop(), so boot-failure cleanup is the only chance to clear it
    await expect(
      startAgent({
        port: 0,
        attachTui: false,
        cwd: testCwd,
        loadCron: noCron,
        createChannelManager: failingChannelManager,
        startResourceSampler: () => () => {
          stopped += 1
        },
      }),
    ).rejects.toThrow('boot failure: sampler cleanup')

    expect(stopped).toBe(1)
  })

  test('a second agent boot failure leaves a running agent fetch observer intact', async () => {
    // given a running agent A whose boot installed the codex fetch observer
    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron })
    const observedFetch = globalThis.fetch
    expect(typeof observedFetch).toBe('function')

    // when a second agent B starts in the same process and fails after the
    // process globals are captured
    const failingChannelManager = (opts: ChannelManagerOptions): ChannelManager => ({
      router: createChannelRouter({
        agentDir: testCwd,
        configForAdapter: () => undefined,
        backgroundObligations: opts.backgroundObligations,
        inboundJournal: opts.inboundJournal,
        recoveryOutbox: opts.recoveryOutbox,
      }),
      start: async () => {
        throw new Error('boot failure: second agent')
      },
      stop: async () => {},
      reload: async () => ({ started: [], stopped: [], restarted: [], restartRequired: [] }),
      restartAdapter: async () => {},
    })
    await expect(
      startAgent({
        port: 0,
        attachTui: false,
        cwd: testCwd,
        loadCron: noCron,
        createChannelManager: failingChannelManager,
      }),
    ).rejects.toThrow('boot failure: second agent')

    // then B's boot-failure cleanup must NOT have torn down A's observer
    expect(globalThis.fetch).toBe(observedFetch)

    await running.stop()
    running = null
  })

  test('attaches a local tui pointing at the server it just started', async () => {
    const calls: TuiOptions[] = []
    const fakeTui: TuiFactory = (opts) => {
      calls.push(opts)
      return { run: () => new Promise<void>(() => {}) }
    }

    running = await startAgent({
      port: 0,
      attachTui: true,
      initialPrompt: 'hello',
      cwd: testCwd,
      createTui: fakeTui,
      loadCron: noCron,
    })

    expect(running.tuiPromise).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`ws://localhost:${running.server.port}`)
    expect(calls[0]?.initialPrompt).toBe('hello')
  })

  test('passes the container-provided TUI token to an attached local tui', async () => {
    const original = process.env.TYPECLAW_TUI_TOKEN
    process.env.TYPECLAW_TUI_TOKEN = 'local-tui-token'
    try {
      const calls: TuiOptions[] = []
      const fakeTui: TuiFactory = (opts) => {
        calls.push(opts)
        return { run: () => new Promise<void>(() => {}) }
      }

      running = await startAgent({ port: 0, attachTui: true, cwd: testCwd, createTui: fakeTui, loadCron: noCron })

      expect(calls).toHaveLength(1)
      const url = new URL(calls[0]!.url)
      expect(url.hostname).toBe('localhost')
      expect(url.port).toBe(String(running.server.port))
      expect(url.searchParams.get('token')).toBe('local-tui-token')
    } finally {
      if (original === undefined) {
        delete process.env.TYPECLAW_TUI_TOKEN
      } else {
        process.env.TYPECLAW_TUI_TOKEN = original
      }
    }
  })

  test('does not instantiate a tui when attachTui is false', async () => {
    const calls: TuiOptions[] = []
    const fakeTui: TuiFactory = (opts) => {
      calls.push(opts)
      return { run: () => Promise.resolve() }
    }

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, createTui: fakeTui, loadCron: noCron })

    expect(calls).toHaveLength(0)
    expect(running.tuiPromise).toBeNull()
  })

  test('stop() shuts the ws server down so the port stops accepting connections', async () => {
    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron })
    const port = running.server.port
    const before = await fetch(`http://localhost:${port}`)
    expect(before.status).toBe(200)

    running.stop()

    await expect(fetch(`http://localhost:${port}`)).rejects.toThrow()
  })

  test('starts scheduler when cron.json is absent because the bundled memory plugin contributes a default dreaming cron job', async () => {
    const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
    const createSchedulerFor: SchedulerFactory = (opts) => {
      factoryCalls.push(opts)
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(1)
    expect(running.scheduler).not.toBeNull()
  })

  test('creates scheduler when cron.json exists but has no jobs (so reload can later swap in jobs)', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [] } }) as LoadCronResult
    const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
    const createSchedulerFor: SchedulerFactory = (opts) => {
      factoryCalls.push(opts)
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(1)
    expect(running.scheduler).not.toBeNull()
  })

  test('starts scheduler when cron.json has jobs', async () => {
    const file: CronFile = {
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: true }],
    }
    const loadCron: LoadCronFn = async () => ({ ok: true, file }) as LoadCronResult
    let started = false
    let stopped = false
    const fakeScheduler: Scheduler = {
      start: () => {
        started = true
      },
      stop: () => {
        stopped = true
      },
      replaceJobs: () => ({ added: [], removed: [], updated: [], unchanged: [] }),
      currentJobs: () => [],
    }
    const createSchedulerFor: SchedulerFactory = () => fakeScheduler

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron, createSchedulerFor })

    expect(running.scheduler).toBe(fakeScheduler)
    expect(started).toBe(true)

    running.stop()
    expect(stopped).toBe(true)
  })

  test('registers cron in the reload registry when scheduler is created', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [] } }) as LoadCronResult
    const createSchedulerFor: SchedulerFactory = () => stubScheduler()

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron, createSchedulerFor })

    expect(running.reloadRegistry.has('cron')).toBe(true)
  })

  test('registers cron in the reload registry even when cron.json is absent because the bundled memory plugin contributes a default dreaming cron job', async () => {
    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron })

    expect(running.reloadRegistry.has('cron')).toBe(true)
  })

  test('registers the providers reload scope before channels so secrets.json key rotation takes effect on reload', async () => {
    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron })

    expect(running.reloadRegistry.has('providers')).toBe(true)
    const scopes = running.reloadRegistry.list().map((r) => r.scope)
    expect(scopes.indexOf('providers')).toBeLessThan(scopes.indexOf('channels'))
  })

  test('survives a file-level cron.json failure by still scheduling plugin jobs (dreaming stays alive)', async () => {
    // startAgent loads the real bundled plugins, so the memory plugin's
    // dreaming cron makes hasInternalJobs true: a broken cron.json must not
    // take that down. The factory receives an empty user file plus the merged
    // internal jobs.
    const loadCron: LoadCronFn = async () => ({ ok: false, reason: 'bad json' }) as LoadCronResult
    const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
    const createSchedulerFor: SchedulerFactory = (opts) => {
      factoryCalls.push(opts)
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.file.jobs).toEqual([])
    expect(running.scheduler).not.toBeNull()
    expect(running.server.port).toBeGreaterThan(0)
  })

  test('passes onFire to the scheduler factory; firing publishes a kind:cron message to the stream', async () => {
    // given
    const file: CronFile = {
      jobs: [{ id: 'job-x', schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: true }],
    }
    const loadCron: LoadCronFn = async () => ({ ok: true, file }) as LoadCronResult
    let captured: ((job: CronJob) => void) | null = null
    const createSchedulerFor: SchedulerFactory = ({ onFire }) => {
      captured = onFire
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron, createSchedulerFor })

    const cronMessages: unknown[] = []
    running.stream.subscribe({ target: { kind: 'cron' } }, (msg) => {
      cronMessages.push(msg.payload)
    })

    // when
    expect(captured).not.toBeNull()
    captured!(file.jobs[0]!)

    // then
    expect(cronMessages).toHaveLength(1)
    expect(cronMessages[0]).toEqual(file.jobs[0]!)
  })

  test('cronConsumer is started when scheduler is created and stopped on stop()', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [] } }) as LoadCronResult
    const createSchedulerFor: SchedulerFactory = () => stubScheduler()

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron, createSchedulerFor })

    expect(running.cronConsumer).not.toBeNull()
  })

  test('a fire emitted while the scheduler is being armed is not lost (consumer subscribes first)', async () => {
    let resolveFired!: () => void
    const fired = new Promise<void>((resolve) => {
      resolveFired = resolve
    })
    // Observe delivery in-process via a `handler` job. Do NOT revert to an
    // `exec` job + sentinel file + filesystem poll: that observation was a
    // Windows CI flake (a cold `bun -e` runtime under parallel load missed the
    // poll budget) even though the subscription-order behavior is correct.
    const job: CronJob = {
      id: 'boot-fire',
      schedule: '* * * * *',
      kind: 'handler',
      enabled: true,
      scheduledByRole: 'owner',
      handler: async () => {
        resolveFired()
      },
    }
    // `jobs` is typed for parsed (prompt/exec) jobs; a handler job is a valid
    // CronJob the consumer dispatches, so widen the array element for the fake.
    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [job] as CronJob[] } }) as LoadCronResult
    // Fire synchronously at arm time. If the consumer hadn't subscribed yet, the
    // stream (no replay) would drop this fire and the handler would never run.
    const createSchedulerFor: SchedulerFactory = ({ onFire }) => {
      onFire(job)
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron, createSchedulerFor })

    await Promise.race([
      fired,
      Bun.sleep(5000).then(() => {
        throw new Error(
          'cron handler not invoked within 5s — the arm-time fire was lost (consumer subscribed too late)',
        )
      }),
    ])
  })

  test('cronConsumer is started when bundled memory plugin contributes a default dreaming cron job (no cron.json)', async () => {
    running = await startAgent({ port: 0, attachTui: false, cwd: testCwd, loadCron: noCron })

    expect(running.cronConsumer).not.toBeNull()
  })

  test('subscribes tunnel bridge before tunnel manager start', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-bridge-run-'))
    try {
      await Bun.write(
        join(agentDir, 'typeclaw.json'),
        JSON.stringify({
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          tunnels: [
            {
              name: 'github-webhook',
              provider: 'external',
              for: { kind: 'channel', name: 'github' },
              externalUrl: 'https://agent.example.com',
            },
          ],
        }),
      )
      reloadConfig(agentDir)
      const restarts: string[] = []
      const createChannelManagerFor = (opts: ChannelManagerOptions): ChannelManager => ({
        router: createChannelRouter({
          agentDir,
          configForAdapter: () => undefined,
          backgroundObligations: opts.backgroundObligations,
          inboundJournal: opts.inboundJournal,
          recoveryOutbox: opts.recoveryOutbox,
        }),
        start: async () => {},
        stop: async () => {},
        reload: async () => ({ started: [], stopped: [], restarted: [], restartRequired: [] }),
        restartAdapter: async (name) => void restarts.push(name),
      })
      const createTunnelManagerFor = (opts: TunnelManagerOptions): TunnelManager => ({
        start: async () => {
          opts.stream.publish({
            target: { kind: 'broadcast' },
            payload: {
              kind: 'tunnel-url-changed',
              tunnelName: 'github-webhook',
              url: 'https://x.trycloudflare.com',
              for: { kind: 'channel', name: 'github' },
              rotatedAt: '2026-05-18T00:00:00.000Z',
            },
          })
        },
        stop: async () => {},
        snapshot: () => [],
        urlFor: () => null,
        tail: () => [],
        subscribeToLogs: () => () => {},
      })

      running = await startAgent({
        port: 0,
        attachTui: false,
        cwd: agentDir,
        loadCron: noCron,
        createChannelManager: createChannelManagerFor,
        createTunnelManager: createTunnelManagerFor,
      })

      expect(restarts).toEqual(['github'])
    } finally {
      await running?.stop()
      running = null
      __resetConfigForTesting()
      await rmTempDir(agentDir)
    }
  })

  test('wires tunnel URL and github upstream port resolvers', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-url-run-'))
    try {
      await Bun.write(
        join(agentDir, 'typeclaw.json'),
        JSON.stringify({
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          channels: { github: { webhookPort: 9123, repos: [] } },
          tunnels: [
            {
              name: 'custom-github-tunnel',
              provider: 'external',
              for: { kind: 'channel', name: 'github' },
              externalUrl: 'https://agent.example.com',
            },
          ],
        }),
      )
      reloadConfig(agentDir)
      let channelOptions!: ChannelManagerOptions
      let tunnelOptions!: TunnelManagerOptions
      const createChannelManagerFor = (opts: ChannelManagerOptions): ChannelManager => {
        channelOptions = opts
        return {
          router: createChannelRouter({
            agentDir,
            configForAdapter: () => undefined,
            backgroundObligations: opts.backgroundObligations,
            inboundJournal: opts.inboundJournal,
            recoveryOutbox: opts.recoveryOutbox,
          }),
          start: async () => {},
          stop: async () => {},
          reload: async () => ({ started: [], stopped: [], restarted: [], restartRequired: [] }),
          restartAdapter: async () => {},
        }
      }
      const createTunnelManagerFor = (opts: TunnelManagerOptions): TunnelManager => {
        tunnelOptions = opts
        return {
          start: async () => {},
          stop: async () => {},
          snapshot: () => [],
          urlFor: (name) => (name === 'custom-github-tunnel' ? 'https://x.trycloudflare.com' : null),
          tail: () => [],
          subscribeToLogs: () => () => {},
        }
      }

      running = await startAgent({
        port: 0,
        attachTui: false,
        cwd: agentDir,
        loadCron: noCron,
        createChannelManager: createChannelManagerFor,
        createTunnelManager: createTunnelManagerFor,
      })

      expect(tunnelOptions.resolveChannelUpstreamPort?.('github')).toBe(9123)
      expect(tunnelOptions.resolveChannelUpstreamPort?.('slack')).toBeNull()
      expect(channelOptions.tunnelUrlForChannel?.('github')).toBe('https://x.trycloudflare.com')
    } finally {
      await running?.stop()
      running = null
      __resetConfigForTesting()
      await rmTempDir(agentDir)
    }
  })
})

describe('startAgent bundled memory plugin (dreaming cron)', () => {
  test('registers a scheduler with the default dreaming schedule when memory.dreaming is unconfigured AND cron.json is absent', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-no-dream-'))
    try {
      await Bun.write(
        join(agentDir, 'typeclaw.json'),
        JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } }),
      )
      const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
      const createSchedulerFor: SchedulerFactory = (opts) => {
        factoryCalls.push(opts)
        return stubScheduler()
      }

      running = await startAgent({
        port: 0,
        attachTui: false,
        cwd: agentDir,
        loadCron: noCron,
        createSchedulerFor,
      })

      expect(factoryCalls).toHaveLength(1)
      expect(running.scheduler).not.toBeNull()
    } finally {
      await rmTempDir(agentDir)
    }
  })

  test('starts a scheduler when memory.dreaming is configured even if cron.json is absent', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dream-on-'))
    try {
      await Bun.write(
        join(agentDir, 'typeclaw.json'),
        JSON.stringify({
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          memory: { idleMs: 30000, dreaming: { schedule: '0 4 * * *' } },
        }),
      )
      const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
      const createSchedulerFor: SchedulerFactory = (opts) => {
        factoryCalls.push(opts)
        return stubScheduler()
      }

      running = await startAgent({
        port: 0,
        attachTui: false,
        cwd: agentDir,
        loadCron: noCron,
        createSchedulerFor,
      })

      expect(factoryCalls).toHaveLength(1)
      expect(running.scheduler).not.toBeNull()
    } finally {
      await rmTempDir(agentDir)
    }
  })

  test('cron reload merges the bundled memory plugin dreaming job with user jobs from cron.json', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dream-reload-'))
    try {
      await Bun.write(
        join(agentDir, 'cron.json'),
        JSON.stringify({
          jobs: [{ id: 'user-job', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
        }),
      )
      await Bun.write(
        join(agentDir, 'typeclaw.json'),
        JSON.stringify({
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          memory: { idleMs: 30000, dreaming: { schedule: '0 4 * * *' } },
        }),
      )
      const replacements: CronJob[][] = []
      let liveJobs: CronJob[] = []
      const fakeScheduler: Scheduler = {
        start: () => {},
        stop: () => {},
        replaceJobs: (jobs) => {
          replacements.push([...jobs])
          liveJobs = [...jobs]
          return { added: [], removed: [], updated: [], unchanged: [] }
        },
        currentJobs: () => liveJobs,
      }
      const createSchedulerFor: SchedulerFactory = () => fakeScheduler

      running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, createSchedulerFor })
      await running.reloadRegistry.reloadAll()

      expect(replacements).toHaveLength(1)
      const ids = replacements[0]?.map((j) => j.id) ?? []
      expect(ids).toContain('__plugin_memory_dreaming')
      expect(ids).toContain('user-job')
    } finally {
      await rmTempDir(agentDir)
    }
  })

  test('firing the bundled dreaming cron job emits a prompt cron event that targets the dreaming subagent', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dream-fire-'))
    try {
      await Bun.write(
        join(agentDir, 'typeclaw.json'),
        JSON.stringify({
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          memory: { idleMs: 30000, dreaming: { schedule: '0 4 * * *' } },
        }),
      )
      let captured: ((job: CronJob) => void) | null = null
      const createSchedulerFor: SchedulerFactory = ({ onFire }) => {
        captured = onFire
        return stubScheduler()
      }

      running = await startAgent({
        port: 0,
        attachTui: false,
        cwd: agentDir,
        loadCron: noCron,
        createSchedulerFor,
      })

      const cronMessages: CronJob[] = []
      running.stream.subscribe({ target: { kind: 'cron' } }, (msg) => {
        cronMessages.push(msg.payload as CronJob)
      })

      const dreamJob: CronJob = {
        id: '__plugin_memory_dreaming',
        schedule: '0 4 * * *',
        enabled: true,
        kind: 'prompt',
        prompt: '(internal)',
        subagent: 'dreaming',
        payload: { agentDir },
      }
      expect(captured).not.toBeNull()
      captured!(dreamJob)
      await new Promise((r) => setImmediate(r))

      const dreamingMsg = cronMessages.find((j) => j.kind === 'prompt' && j.subagent === 'dreaming')
      expect(dreamingMsg).toBeDefined()
      if (dreamingMsg && dreamingMsg.kind === 'prompt') {
        expect(dreamingMsg.payload).toEqual({ agentDir })
      }
    } finally {
      await rmTempDir(agentDir)
    }
  })
})

describe('startAgent config reload wiring', () => {
  test('config reload succeeds against missing host mount paths when running inside a container', async () => {
    // given: an agent dir whose typeclaw.json declares a mount pointing at a
    // path that does not exist on the local filesystem (simulates a host path
    // that is not visible from inside the container's namespace).
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-reload-'))
    const originalContainerName = process.env.TYPECLAW_CONTAINER_NAME
    process.env.TYPECLAW_CONTAINER_NAME = 'typeclaw-test'
    try {
      await Bun.write(
        join(agentDir, 'typeclaw.json'),
        JSON.stringify({
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          mounts: [{ name: 'data', path: join(agentDir, 'this-path-never-exists') }],
        }),
      )

      // when: startAgent wires the config reloadable and a reload runs
      running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })
      const { results } = await running.reloadRegistry.reloadAll()

      // then: the config reload succeeds (mount validation is skipped because
      // TYPECLAW_CONTAINER_NAME is set) — guards against regressions in the
      // src/run/index.ts wiring of skipMountValidation.
      const configResult = results.find((r) => r.scope === 'config')
      expect(configResult).toBeDefined()
      expect(configResult?.ok).toBe(true)
    } finally {
      if (originalContainerName === undefined) delete process.env.TYPECLAW_CONTAINER_NAME
      else process.env.TYPECLAW_CONTAINER_NAME = originalContainerName
      await rmTempDir(agentDir)
    }
  })

  test('config reload fails on missing host mount paths when TYPECLAW_CONTAINER_NAME is unset (host-stage default)', async () => {
    // given: same shape, but no container marker — simulates running outside
    // the typeclaw container (e.g. ad-hoc `bun run typeclaw run` on the host).
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-reload-host-'))
    const originalContainerName = process.env.TYPECLAW_CONTAINER_NAME
    delete process.env.TYPECLAW_CONTAINER_NAME
    try {
      await Bun.write(
        join(agentDir, 'typeclaw.json'),
        JSON.stringify({
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          mounts: [{ name: 'data', path: join(agentDir, 'this-path-never-exists') }],
        }),
      )

      // when
      running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })
      const { results } = await running.reloadRegistry.reloadAll()

      // then: the host-stage default keeps the full mount accessibility gate.
      const configResult = results.find((r) => r.scope === 'config')
      expect(configResult).toBeDefined()
      expect(configResult?.ok).toBe(false)
      if (configResult && !configResult.ok) {
        expect(configResult.reason).toContain('mount "data"')
      }
    } finally {
      if (originalContainerName !== undefined) process.env.TYPECLAW_CONTAINER_NAME = originalContainerName
      await rmTempDir(agentDir)
    }
  })
})

describe('startAgent session persistence wiring', () => {
  let agentDir: string

  afterEach(async () => {
    if (agentDir) await rmTempDir(agentDir)
  })

  test('creates <cwd>/sessions/ on disk when no sessionFactory is injected', async () => {
    // given
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-run-'))

    // when
    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    // then
    expect(existsSync(join(agentDir, 'sessions'))).toBe(true)
  })

  test('uses an injected sessionFactory instead of constructing the default one', async () => {
    // given
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-run-'))
    const stubDir = join(agentDir, 'custom-sessions')
    let dirCalls = 0
    let createCalls = 0
    const stubFactory: SessionFactory = {
      sessionDir: () => {
        dirCalls++
        return stubDir
      },
      createPersisted: () => {
        createCalls++
        throw new Error('createPersisted should not be called without an active ws connection')
      },
    }

    // when
    running = await startAgent({
      port: 0,
      attachTui: false,
      cwd: agentDir,
      loadCron: noCron,
      sessionFactory: stubFactory,
    })

    // then
    expect(existsSync(join(agentDir, 'sessions'))).toBe(false)
    expect(dirCalls + createCalls).toBe(0)
  })
})
