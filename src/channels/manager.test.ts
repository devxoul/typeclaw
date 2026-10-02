import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import { createFileSecretsProvider } from '@/secrets/secrets-provider'

import {
  type ChannelManager,
  type ChannelManagerOptions,
  createChannelManager as createChannelManagerImpl,
} from './manager'
import { defaultHistoryConfig, type ChannelAdapterConfig, type ChannelsConfig } from './schema'
import type { ChannelKey, InboundMessage } from './types'

type FakeAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
  startCalls: number
  stopCalls: number
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeFakeAdapter(): FakeAdapter & { connected: boolean } {
  const adapter = {
    connected: true,
    startCalls: 0,
    stopCalls: 0,
    async start() {
      adapter.startCalls++
      adapter.connected = true
    },
    async stop() {
      adapter.stopCalls++
    },
    isConnected() {
      return adapter.connected
    },
  }
  return adapter
}

function makeStartFailingAdapter(message = '401: Unauthorized'): FakeAdapter & { connected: boolean } {
  const adapter = makeFakeAdapter()
  adapter.start = async () => {
    adapter.startCalls++
    throw new Error(message)
  }
  return adapter
}

function makeRecordingAdapter(
  events: string[],
  name: string,
  gates: { start?: Promise<void>; stop?: Promise<void> } = {},
): FakeAdapter {
  const adapter = {
    startCalls: 0,
    stopCalls: 0,
    async start() {
      adapter.startCalls++
      events.push(`${name}:start:begin`)
      await gates.start
      events.push(`${name}:start:end`)
    },
    async stop() {
      adapter.stopCalls++
      events.push(`${name}:stop:begin`)
      await gates.stop
      events.push(`${name}:stop:end`)
    },
    isConnected() {
      return true
    },
  }
  return adapter
}

let agentDir: string
let cfg: ChannelsConfig

const managers: ChannelManager[] = []

function createChannelManager(options: ChannelManagerOptions): ChannelManager {
  const manager = createChannelManagerImpl(options)
  managers.push(manager)
  return manager
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-channels-mgr-'))
  cfg = {}
})

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop()
  await rm(agentDir, { recursive: true, force: true })
})

const enabledAdapterCfg = () => ({
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'] as Array<'mention' | 'reply' | 'dm'>,
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
})

const enabledGithubCfg = () => ({
  ...enabledAdapterCfg(),
  webhookPort: 0,
  eventAllowlist: ['issue_comment.created'],
  repos: [],
  review: { on: 'review_requested' as const, approve: true },
})

const writeGithubSecrets = async (dir: string): Promise<void> => {
  await writeFile(
    join(dir, 'secrets.json'),
    JSON.stringify({
      version: 2,
      providers: {},
      channels: {
        github: {
          auth: { type: 'pat', token: { value: 'ghp_test' } },
          webhookSecret: { value: 'wh-secret' },
        },
      },
    }),
  )
}

const writeSlackSecrets = async (dir: string): Promise<void> => {
  await writeFile(
    join(dir, 'secrets.json'),
    JSON.stringify({
      version: 2,
      providers: {},
      channels: {
        slack: {
          currentAccount: 'T0123456789',
          accounts: {
            T0123456789: {
              account_id: 'T0123456789',
              token: 'xoxc-test',
              cookie: 'xoxd-test',
              workspace_id: 'T0123456789',
              workspace_name: 'Acme',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      },
    }),
  )
}

const writeInstagramSecrets = async (dir: string): Promise<void> => {
  await writeFile(
    join(dir, 'secrets.json'),
    JSON.stringify({
      version: 2,
      providers: {},
      channels: {
        instagram: {
          currentAccount: 'ig-account',
          accounts: {
            'ig-account': {
              account_id: 'ig-account',
              username: 'test-user',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      },
    }),
  )
}

function recordingLogger(): {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  messages: string[]
} {
  const messages: string[] = []
  return {
    info: (msg) => messages.push(`info:${msg}`),
    warn: (msg) => messages.push(`warn:${msg}`),
    error: (msg) => messages.push(`error:${msg}`),
    messages,
  }
}

function fakeRecoveryClock(
  options: {
    startMs?: number
    checkIntervalMs?: number
    disconnectedGraceMs?: number
    retryBaseMs?: number
    random?: () => number
  } = {},
): {
  connectionRecovery: {
    checkIntervalMs: number
    disconnectedGraceMs: number
    retryBaseMs: number
    now: () => number
    random: () => number
    setInterval: (fn: () => void) => string
    clearInterval: () => void
  }
  advanceBy: (ms: number) => boolean
  fire: () => boolean
  isArmed: () => boolean
  intervalRegistrations: () => number
  now: () => number
} {
  let nowMs = options.startMs ?? 0
  let tick: (() => void) | null = null
  let registrations = 0
  const fire = (): boolean => {
    if (tick === null) return false
    tick()
    return true
  }
  return {
    connectionRecovery: {
      checkIntervalMs: options.checkIntervalMs ?? 30_000,
      disconnectedGraceMs: options.disconnectedGraceMs ?? 90_000,
      retryBaseMs: options.retryBaseMs ?? options.checkIntervalMs ?? 30_000,
      now: () => nowMs,
      random: options.random ?? (() => 0.5),
      setInterval: (fn) => {
        tick = fn
        registrations++
        return `timer-${registrations}`
      },
      clearInterval: () => {
        tick = null
      },
    },
    advanceBy: (ms) => {
      nowMs += ms
      return fire()
    },
    fire,
    isArmed: () => tick !== null,
    intervalRegistrations: () => registrations,
    now: () => nowMs,
  }
}

const flushManagerWork = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('channel manager — connection recovery', () => {
  test('restarts a live adapter that remains disconnected past the grace period', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    let now = 1_000
    let tick: (() => void) | null = null
    const logger = recordingLogger()
    const firstAdapter = makeFakeAdapter()
    const secondAdapter = makeFakeAdapter()
    const adapters = [firstAdapter, secondAdapter]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      logger,
      createDiscordAdapter: () => adapters.shift()!,
      connectionRecovery: {
        checkIntervalMs: 10,
        disconnectedGraceMs: 100,
        now: () => now,
        setInterval: (fn) => {
          tick = fn
          return 'timer'
        },
        clearInterval: () => {},
      },
    })

    await mgr.start()
    expect(firstAdapter.startCalls).toBe(1)
    expect(secondAdapter.startCalls).toBe(0)
    expect(tick).not.toBeNull()
    const runTick = () => {
      if (tick === null) throw new Error('recovery timer was not registered')
      tick()
    }

    firstAdapter.connected = false
    runTick()
    await Promise.resolve()
    expect(firstAdapter.stopCalls).toBe(0)
    expect(secondAdapter.startCalls).toBe(0)
    expect(logger.messages).toContain('warn:[channels] adapter "discord-bot" is disconnected; waiting for SDK recovery')

    now += 101
    runTick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(firstAdapter.stopCalls).toBe(1)
    expect(secondAdapter.startCalls).toBe(1)
    expect(logger.messages).toContain(
      'warn:[channels] adapter "discord-bot" disconnected for 101ms; restarting adapter',
    )

    await mgr.stop()
  })

  test('backs off repeated restarts when replacements remain disconnected', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock({ checkIntervalMs: 10, disconnectedGraceMs: 100, retryBaseMs: 200 })
    const adapters = [makeFakeAdapter(), makeFakeAdapter(), makeFakeAdapter(), makeFakeAdapter()]
    for (const adapter of adapters) {
      adapter.start = async () => {
        adapter.startCalls++
        adapter.connected = false
      }
    }
    let constructions = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => adapters[constructions++]!,
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    clock.advanceBy(101)
    await flushManagerWork()
    expect(constructions).toBe(2)

    clock.advanceBy(194)
    await flushManagerWork()
    expect(constructions).toBe(2)
    clock.advanceBy(1)
    await flushManagerWork()
    expect(constructions).toBe(3)

    clock.advanceBy(394)
    await flushManagerWork()
    expect(constructions).toBe(3)
    clock.advanceBy(1)
    await flushManagerWork()
    expect(constructions).toBe(4)

    await mgr.stop()
  })

  test('does not queue duplicate recovery restarts while the first restart is pending', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    let now = 1_000
    let tick: (() => void) | null = null
    const stopGate = deferred()
    const firstAdapter = makeFakeAdapter()
    firstAdapter.stop = async () => {
      firstAdapter.stopCalls++
      await stopGate.promise
    }
    const secondAdapter = makeFakeAdapter()
    const thirdAdapter = makeFakeAdapter()
    const adapters = [firstAdapter, secondAdapter, thirdAdapter]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => adapters.shift()!,
      connectionRecovery: {
        checkIntervalMs: 10,
        disconnectedGraceMs: 100,
        now: () => now,
        setInterval: (fn) => {
          tick = fn
          return 'timer'
        },
        clearInterval: () => {},
      },
    })

    await mgr.start()
    const runTick = () => {
      if (tick === null) throw new Error('recovery timer was not registered')
      tick()
    }

    firstAdapter.connected = false
    runTick()
    now += 101
    runTick()
    await Promise.resolve()

    expect(firstAdapter.stopCalls).toBe(1)
    expect(secondAdapter.startCalls).toBe(0)

    now += 101
    runTick()
    await Promise.resolve()

    expect(firstAdapter.stopCalls).toBe(1)
    expect(secondAdapter.startCalls).toBe(0)
    expect(thirdAdapter.startCalls).toBe(0)

    stopGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(secondAdapter.startCalls).toBe(1)
    expect(thirdAdapter.startCalls).toBe(0)

    await mgr.stop()
  })

  test('retries a failed disconnect replacement until the adapter is live again', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock({ startMs: 1_000, checkIntervalMs: 10, disconnectedGraceMs: 100 })
    const firstAdapter = makeFakeAdapter()
    const failedReplacement = makeStartFailingAdapter()
    const recoveredAdapter = makeFakeAdapter()
    const adapters = [firstAdapter, failedReplacement, recoveredAdapter]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => adapters.shift()!,
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    firstAdapter.connected = false
    clock.fire()
    clock.advanceBy(101)
    await flushManagerWork()

    expect(firstAdapter.stopCalls).toBe(1)
    expect(failedReplacement.startCalls).toBe(1)
    expect(failedReplacement.stopCalls).toBe(1)
    expect(recoveredAdapter.startCalls).toBe(0)

    clock.advanceBy(9)
    await flushManagerWork()
    expect(recoveredAdapter.startCalls).toBe(0)

    clock.advanceBy(1)
    await flushManagerWork()
    expect(recoveredAdapter.startCalls).toBe(1)

    await mgr.stop()
    expect(recoveredAdapter.stopCalls).toBe(1)
  })

  test('heals a boot-time start failure only when its retry deadline is due', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock()
    const failedAdapter = makeStartFailingAdapter()
    const recoveredAdapter = makeFakeAdapter()
    const adapters = [failedAdapter, recoveredAdapter]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => adapters.shift()!,
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    expect(failedAdapter.startCalls).toBe(1)

    clock.advanceBy(29_999)
    await flushManagerWork()
    expect(recoveredAdapter.startCalls).toBe(0)

    clock.advanceBy(1)
    await flushManagerWork()
    expect(recoveredAdapter.startCalls).toBe(1)

    await mgr.stop()
  })

  test('uses exponential retry deadlines capped at fifteen minutes and never fires early', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock()
    const attemptTimes: number[] = []
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => {
        const adapter = makeStartFailingAdapter()
        adapter.start = async () => {
          adapter.startCalls++
          attemptTimes.push(clock.now())
          throw new Error('still unavailable')
        }
        return adapter
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    const nominals = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]
    let expectedAttempts = 1
    for (const nominal of nominals) {
      const floor = nominal * 0.8
      clock.advanceBy(floor - 1)
      await flushManagerWork()
      expect(attemptTimes).toHaveLength(expectedAttempts)

      clock.advanceBy(nominal * 1.2 - (floor - 1))
      await flushManagerWork()
      expectedAttempts++
      expect(attemptTimes).toHaveLength(expectedAttempts)
    }

    // every observed gap sits inside its own ±20% window, and the last two
    // share the 15-minute cap rather than continuing to double
    const gaps = attemptTimes.slice(1).map((at, i) => at - attemptTimes[i]!)
    expect(gaps).toHaveLength(nominals.length)
    for (const [i, nominal] of nominals.entries()) {
      expect(gaps[i]!).toBeGreaterThanOrEqual(nominal * 0.8)
      expect(gaps[i]!).toBeLessThanOrEqual(nominal * 1.2)
    }
    expect(nominals.at(-1)).toBe(900_000)
    await mgr.stop()
  })

  test('claims a due retry before enqueue so repeated ticks cannot construct duplicates', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock()
    const startGate = deferred()
    const failedAdapter = makeStartFailingAdapter()
    const retryAdapter = makeRecordingAdapter([], 'retry', { start: startGate.promise })
    let constructions = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => {
        constructions++
        return constructions === 1 ? failedAdapter : retryAdapter
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    clock.advanceBy(30_000)
    await Promise.resolve()
    expect(retryAdapter.startCalls).toBe(1)

    for (let i = 0; i < 5; i++) clock.fire()
    await flushManagerWork()
    expect(constructions).toBe(2)
    expect(retryAdapter.startCalls).toBe(1)

    startGate.resolve()
    await flushManagerWork()
    await mgr.stop()
  })

  test('clears failed supervision after recovery succeeds', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock()
    const failedAdapter = makeStartFailingAdapter()
    const recoveredAdapter = makeFakeAdapter()
    let constructions = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => {
        constructions++
        return constructions === 1 ? failedAdapter : recoveredAdapter
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    clock.advanceBy(30_000)
    await flushManagerWork()
    expect(recoveredAdapter.startCalls).toBe(1)

    for (let i = 0; i < 20; i++) {
      clock.advanceBy(900_000)
      await flushManagerWork()
    }
    expect(constructions).toBe(2)
    expect(recoveredAdapter.startCalls).toBe(1)

    await mgr.stop()
  })

  test('retries missing credentials and starts once the credential block appears', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const env: NodeJS.ProcessEnv = {}
    const clock = fakeRecoveryClock()
    const adapter = makeFakeAdapter()
    let constructions = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createDiscordAdapter: () => {
        constructions++
        return adapter
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    expect(constructions).toBe(0)
    env.DISCORD_BOT_TOKEN = 'token-added-later'

    clock.advanceBy(30_000)
    await flushManagerWork()
    expect(constructions).toBe(1)
    expect(adapter.startCalls).toBe(1)

    await mgr.stop()
  })

  test('reload keeps a credential-stripped live adapter supervised so restoring the token revives it', async () => {
    // given: a live adapter whose token is then removed from env
    cfg['discord-bot'] = enabledAdapterCfg()
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'token' }
    const clock = fakeRecoveryClock()
    const first = makeFakeAdapter()
    const revived = makeFakeAdapter()
    const adapters = [first, revived]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createDiscordAdapter: () => adapters.shift()!,
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    expect(first.startCalls).toBe(1)

    // when: the credential disappears and the operator reloads
    delete env.DISCORD_BOT_TOKEN
    const result = await mgr.reload()
    expect(result.stopped).toContain('discord-bot')
    expect(first.stopCalls).toBe(1)

    // then: it stays under supervision rather than dropping out entirely
    env.DISCORD_BOT_TOKEN = 'token-restored'
    clock.advanceBy(30_000)
    await flushManagerWork()
    expect(revived.startCalls).toBe(1)

    await mgr.stop()
  })

  test('reload reconciles credentials on an adapter a retry brought live, not just a boot start', async () => {
    // given: boot fails, so the adapter only becomes live via the retry path
    cfg['discord-bot'] = enabledAdapterCfg()
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'token-old' }
    const clock = fakeRecoveryClock()
    const revived = makeFakeAdapter()
    const adapters = [makeStartFailingAdapter(), revived]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createDiscordAdapter: () => adapters.shift()!,
      connectionRecovery: clock.connectionRecovery,
    })
    await mgr.start()
    clock.advanceBy(30_000)
    await flushManagerWork()
    expect(revived.startCalls).toBe(1)

    // when: the token rotates under an adapter that never went through boot start
    env.DISCORD_BOT_TOKEN = 'token-rotated'
    const reloaded = await mgr.reload()

    // then: rotation is reported rather than silently skipped
    expect(reloaded.restartRequired).toEqual(['discord-bot (token rotation)'])
    expect(reloaded.started).toEqual([])

    await mgr.stop()
  })

  test('retry deadlines stay within the jitter window at both extremes on production-cadence ticks', async () => {
    // given: a 5s supervision tick against a 30s retry base, at both jitter ends
    const base = 30_000
    const windowMin = base * 0.8
    const windowMax = base * 1.2
    for (const random of [0, 0.5, 0.999] as const) {
      cfg['discord-bot'] = enabledAdapterCfg()
      const clock = fakeRecoveryClock({ checkIntervalMs: 5_000, retryBaseMs: 30_000, random: () => random })
      let constructions = 0
      const mgr = createChannelManager({
        agentDir,
        channelsConfigRef: () => cfg,
        env: { DISCORD_BOT_TOKEN: 'token' },
        createDiscordAdapter: () => {
          constructions++
          return makeStartFailingAdapter()
        },
        connectionRecovery: clock.connectionRecovery,
      })
      await mgr.start()
      expect(constructions).toBe(1)

      // when: ticking at the production 5s cadence until the retry fires
      let elapsed = 0
      while (constructions < 2 && elapsed < 120_000) {
        clock.advanceBy(5_000)
        await flushManagerWork()
        elapsed += 5_000
      }
      // then: the OBSERVED retry time honours the advertised window, tick
      // quantization included — not merely the unobservable computed deadline
      expect(constructions).toBe(2)
      expect(elapsed).toBeGreaterThanOrEqual(windowMin)
      expect(elapsed).toBeLessThanOrEqual(windowMax)

      await mgr.stop()
    }
  })

  test('does not retry disabled or permanently unconstructable adapters', async () => {
    cfg['discord-bot'] = { ...enabledAdapterCfg(), enabled: false }
    cfg.slack = enabledAdapterCfg()
    await writeSlackSecrets(agentDir)
    const clock = fakeRecoveryClock()
    const logger = recordingLogger()
    let discordConstructions = 0
    let slackConstructions = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      logger,
      createDiscordAdapter: () => {
        discordConstructions++
        return makeFakeAdapter()
      },
      createSlackUserAdapter: () => {
        slackConstructions++
        return makeFakeAdapter()
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    for (let i = 0; i < 20; i++) {
      clock.advanceBy(900_000)
      await flushManagerWork()
    }

    expect(discordConstructions).toBe(0)
    expect(slackConstructions).toBe(0)
    expect(logger.messages.filter((message) => message.includes('could not be constructed'))).toHaveLength(1)
    await mgr.stop()
  })

  test('throttles capped retry logs to one heartbeat every six hours', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock()
    const logger = recordingLogger()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      logger,
      createDiscordAdapter: () => makeStartFailingAdapter(),
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000]) {
      clock.advanceBy(delay)
      await flushManagerWork()
    }
    for (let i = 0; i < 48; i++) {
      clock.advanceBy(900_000)
      await flushManagerWork()
    }

    const retryLogs = logger.messages.filter((message) => message.includes('retrying in'))
    expect(retryLogs).toHaveLength(8)
    expect(retryLogs.filter((message) => message.startsWith('error:'))).toHaveLength(1)
    expect(retryLogs.filter((message) => message.startsWith('warn:'))).toHaveLength(7)
    expect(
      retryLogs.filter((message) => message.includes('attempt 30') || message.includes('attempt 54')),
    ).toHaveLength(2)
    await mgr.stop()
  })

  test('stop is a hard barrier against an in-flight retry resurrection', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock()
    const startGate = deferred()
    const failedAdapter = makeStartFailingAdapter()
    const retryAdapter = makeRecordingAdapter([], 'retry', { start: startGate.promise })
    let constructions = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => {
        constructions++
        return constructions === 1 ? failedAdapter : retryAdapter
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    clock.advanceBy(30_000)
    await Promise.resolve()
    expect(retryAdapter.startCalls).toBe(1)

    const stopCall = mgr.stop()
    expect(clock.isArmed()).toBe(false)
    startGate.resolve()
    await stopCall

    expect(retryAdapter.stopCalls).toBe(1)
    expect(clock.fire()).toBe(false)
    expect(constructions).toBe(2)
  })

  test('reload serializes behind a queued retry without leaking a second current adapter', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'old-token' }
    const clock = fakeRecoveryClock()
    const failedAdapter = makeStartFailingAdapter()
    const recoveredAdapter = makeFakeAdapter()
    const leakedAdapter = makeFakeAdapter()
    const adapters = [failedAdapter, recoveredAdapter, leakedAdapter]
    const constructedWithTokens: string[] = []
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createDiscordAdapter: (adapterOptions) => {
        constructedWithTokens.push(adapterOptions.token)
        return adapters.shift()!
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    clock.advanceBy(30_000)
    env.DISCORD_BOT_TOKEN = 'new-token'
    cfg['discord-bot'] = enabledAdapterCfg()
    await mgr.reload()

    expect(constructedWithTokens).toEqual(['old-token', 'new-token'])
    expect(recoveredAdapter.startCalls).toBe(1)
    expect(leakedAdapter.startCalls).toBe(0)

    await mgr.stop()
    expect(recoveredAdapter.stopCalls).toBe(1)
    expect(leakedAdapter.stopCalls).toBe(0)
  })

  test('restartAdapter revives a failed adapter immediately but skips missing or disabled config', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock()
    const failedAdapter = makeStartFailingAdapter()
    const recoveredAdapter = makeFakeAdapter()
    let constructions = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => {
        constructions++
        return constructions === 1 ? failedAdapter : recoveredAdapter
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    await mgr.restartAdapter('discord-bot')
    expect(recoveredAdapter.startCalls).toBe(1)
    expect(constructions).toBe(2)

    delete cfg['discord-bot']
    await mgr.restartAdapter('discord-bot')
    cfg['discord-bot'] = { ...enabledAdapterCfg(), enabled: false }
    await mgr.restartAdapter('discord-bot')
    clock.advanceBy(30_000)
    await flushManagerWork()
    expect(constructions).toBe(2)

    await mgr.stop()
  })

  test('does not start a replacement when recovery cannot stop the disconnected adapter', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const clock = fakeRecoveryClock({ startMs: 1_000, checkIntervalMs: 10, disconnectedGraceMs: 100 })
    const firstAdapter = makeFakeAdapter()
    firstAdapter.stop = async () => {
      firstAdapter.stopCalls++
      throw new Error('SDK stop failed')
    }
    const replacement = makeFakeAdapter()
    let constructions = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => {
        constructions++
        return constructions === 1 ? firstAdapter : replacement
      },
      connectionRecovery: clock.connectionRecovery,
    })

    await mgr.start()
    firstAdapter.connected = false
    clock.fire()
    clock.advanceBy(101)
    await flushManagerWork()

    expect(firstAdapter.stopCalls).toBe(1)
    expect(replacement.startCalls).toBe(0)
    expect(constructions).toBe(1)

    clock.fire()
    await flushManagerWork()
    expect(firstAdapter.stopCalls).toBe(2)
    expect(replacement.startCalls).toBe(0)

    await mgr.stop()
  })

  test('best-effort stops a partially initialized adapter after start throws', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const failedAdapter = makeStartFailingAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => failedAdapter,
    })

    await mgr.start()

    expect(failedAdapter.startCalls).toBe(1)
    expect(failedAdapter.stopCalls).toBe(1)
    await mgr.stop()
  })
})

describe('channel manager — restartAdapter serialization', () => {
  test('restartAdapter stops a live github adapter before starting it again', async () => {
    cfg.github = enabledGithubCfg()
    await writeGithubSecrets(agentDir)
    const events: string[] = []
    const stopGate = deferred()
    const adapters = [
      makeRecordingAdapter(events, 'github#1', { stop: stopGate.promise }),
      makeRecordingAdapter(events, 'github#2'),
    ]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      createGithubAdapter: () => adapters.shift()!,
    })

    await mgr.start()
    const restart = mgr.restartAdapter('github')
    await Promise.resolve()
    expect(events).toEqual(['github#1:start:begin', 'github#1:start:end', 'github#1:stop:begin'])

    stopGate.resolve()
    await restart

    expect(events).toEqual([
      'github#1:start:begin',
      'github#1:start:end',
      'github#1:stop:begin',
      'github#1:stop:end',
      'github#2:start:begin',
      'github#2:start:end',
    ])
    await mgr.stop()
  })

  test('serializes concurrent restartAdapter calls for the same adapter', async () => {
    cfg.github = enabledGithubCfg()
    await writeGithubSecrets(agentDir)
    const events: string[] = []
    const firstStopGate = deferred()
    const secondStopGate = deferred()
    const adapters = [
      makeRecordingAdapter(events, 'github#1', { stop: firstStopGate.promise }),
      makeRecordingAdapter(events, 'github#2', { stop: secondStopGate.promise }),
      makeRecordingAdapter(events, 'github#3'),
    ]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      createGithubAdapter: () => adapters.shift()!,
    })

    await mgr.start()
    const first = mgr.restartAdapter('github')
    const second = mgr.restartAdapter('github')
    await Promise.resolve()
    expect(events).toEqual(['github#1:start:begin', 'github#1:start:end', 'github#1:stop:begin'])

    firstStopGate.resolve()
    await first
    await Promise.resolve()
    expect(events).toEqual([
      'github#1:start:begin',
      'github#1:start:end',
      'github#1:stop:begin',
      'github#1:stop:end',
      'github#2:start:begin',
      'github#2:start:end',
      'github#2:stop:begin',
    ])

    secondStopGate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual([
      'github#1:start:begin',
      'github#1:start:end',
      'github#1:stop:begin',
      'github#1:stop:end',
      'github#2:start:begin',
      'github#2:start:end',
      'github#2:stop:begin',
      'github#2:stop:end',
      'github#3:start:begin',
      'github#3:start:end',
    ])
    await mgr.stop()
  })

  test('restartAdapter is a no-op when the adapter config is missing', async () => {
    const logger = recordingLogger()
    const mgr = createChannelManager({ agentDir, channelsConfigRef: () => cfg, logger })

    await mgr.restartAdapter('github')

    expect(logger.messages).toContain("info:[channels] restartAdapter('github'): adapter config missing, skipping")
    await mgr.stop()
  })

  test('restartAdapter serialization is per adapter, not global', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    cfg['telegram-bot'] = enabledAdapterCfg()
    const events: string[] = []
    const slackStopGate = deferred()
    const slackAdapters = [
      makeRecordingAdapter(events, 'slack#1', { stop: slackStopGate.promise }),
      makeRecordingAdapter(events, 'slack#2'),
    ]
    const telegramAdapters = [makeRecordingAdapter(events, 'telegram#1'), makeRecordingAdapter(events, 'telegram#2')]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b', TELEGRAM_BOT_TOKEN: 'tg-a' },
      createSlackAdapter: () => slackAdapters.shift()!,
      createTelegramAdapter: () => telegramAdapters.shift()!,
    })

    await mgr.start()
    const slackRestart = mgr.restartAdapter('slack-bot')
    await Promise.resolve()
    const telegramRestart = mgr.restartAdapter('telegram-bot')
    await telegramRestart

    expect(events).toContain('telegram#2:start:end')
    expect(events).not.toContain('slack#2:start:begin')

    slackStopGate.resolve()
    await slackRestart
    await mgr.stop()
  })

  test('starts adapters concurrently rather than serially', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    cfg['telegram-bot'] = enabledAdapterCfg()
    const events: string[] = []
    const slackStartGate = deferred()
    const telegramStartGate = deferred()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b', TELEGRAM_BOT_TOKEN: 'tg-a' },
      createSlackAdapter: () => makeRecordingAdapter(events, 'slack', { start: slackStartGate.promise }),
      createTelegramAdapter: () => makeRecordingAdapter(events, 'telegram', { start: telegramStartGate.promise }),
    })

    const startCall = mgr.start()
    await Promise.resolve()

    // Both adapters have begun starting while neither has finished — impossible
    // under serial start, where slack would block telegram until its gate opens.
    expect(events).toEqual(['slack:start:begin', 'telegram:start:begin'])

    slackStartGate.resolve()
    telegramStartGate.resolve()
    await startCall

    expect(events).toContain('slack:start:end')
    expect(events).toContain('telegram:start:end')
    await mgr.stop()
  })

  test('start() preserves construction fail-fast and does not arm supervision', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    let timerArmCalls = 0
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: () => {
        throw new Error('hostd env missing')
      },
      connectionRecovery: {
        setInterval: () => {
          timerArmCalls++
          return 'timer'
        },
      },
    })

    await expect(mgr.start()).rejects.toThrow('hostd env missing')
    expect(timerArmCalls).toBe(0)
    await mgr.stop()
  })

  test('start() failure waits for in-flight siblings so none orphan past stop()', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    cfg['telegram-bot'] = enabledAdapterCfg()
    const events: string[] = []
    const slackStartGate = deferred()
    const slack = makeRecordingAdapter(events, 'slack', { start: slackStartGate.promise })
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b', TELEGRAM_BOT_TOKEN: 'tg-a' },
      createSlackAdapter: () => slack,
      createTelegramAdapter: () => {
        throw new Error('hostd env missing')
      },
    })

    const startCall = mgr.start()
    // Let the telegram factory throw while slack's start() is still gated open.
    await Promise.resolve()
    expect(events).toEqual(['slack:start:begin'])

    // Releasing slack lets it register in `live`; start() must not reject until
    // that settles, otherwise the late registration would orphan slack.
    slackStartGate.resolve()
    await expect(startCall).rejects.toThrow('hostd env missing')
    expect(slack.startCalls).toBe(1)

    await mgr.stop()
    expect(events).toContain('slack:stop:begin')
  })

  test('passes tunnelUrlForChannel through to the github adapter', async () => {
    cfg.github = enabledGithubCfg()
    await writeGithubSecrets(agentDir)
    let captured: { tunnelUrl?: () => string | null } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      tunnelUrlForChannel: (name) => (name === 'github' ? 'https://x.trycloudflare.com' : null),
      createGithubAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    await mgr.start()

    expect(captured?.tunnelUrl?.()).toBe('https://x.trycloudflare.com')
    await mgr.stop()
  })

  test('passes tunnelConfiguredForChannel through to the github adapter', async () => {
    cfg.github = enabledGithubCfg()
    await writeGithubSecrets(agentDir)
    let captured: { tunnelConfiguredForChannel?: () => boolean } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      tunnelConfiguredForChannel: (name) => name === 'github',
      createGithubAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    await mgr.start()

    expect(captured?.tunnelConfiguredForChannel?.()).toBe(true)
    await mgr.stop()
  })

  test("accepts GitHub App auth in secrets.json (regression: runtime guard previously rejected type: 'app')", async () => {
    cfg.github = enabledGithubCfg()
    await writeFile(
      join(agentDir, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: {},
        channels: {
          github: {
            auth: {
              type: 'app',
              appId: 12345,
              privateKey: { value: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----' },
            },
            webhookSecret: { value: 'wh-secret' },
          },
        },
      }),
    )
    let constructed = false
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      createGithubAdapter: () => {
        constructed = true
        return makeFakeAdapter()
      },
    })

    await mgr.start()

    expect(constructed).toBe(true)
    await mgr.stop()
  })
})

describe('channel manager — instagram adapter lifecycle', () => {
  test('passes agentDir to the instagram adapter continuity store', async () => {
    cfg.instagram = enabledAdapterCfg()
    await writeInstagramSecrets(agentDir)
    const fake = makeFakeAdapter()
    let capturedAgentDir: string | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createInstagramAdapter: (options) => {
        capturedAgentDir = options.agentDir
        return fake
      },
    })

    await mgr.start()

    expect(capturedAgentDir).toBe(agentDir)
    expect(fake.startCalls).toBe(1)
    await mgr.stop()
  })
})

describe('channel manager — slack adapter lifecycle', () => {
  test('starts slack user adapter from secrets using the createSlackUserAdapter seam', async () => {
    cfg.slack = enabledAdapterCfg()
    await writeSlackSecrets(agentDir)
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = {
      TYPECLAW_HOSTD_URL: 'http://hostd.test',
      TYPECLAW_HOSTD_TOKEN: 'restart-token',
      TYPECLAW_CONTAINER_NAME: 'agent',
    }
    let constructed = false
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createSlackUserAdapter: () => {
        constructed = true
        return fake
      },
    })

    await mgr.start()

    expect(constructed).toBe(true)
    expect(fake.startCalls).toBe(1)
    await mgr.stop()
  })

  test('skips slack user adapter (does not throw) when hostd env vars are missing', async () => {
    // given: secrets present but no TYPECLAW_HOSTD_* (lost first-boot daemon race)
    cfg.slack = enabledAdapterCfg()
    await writeSlackSecrets(agentDir)
    const fake = makeFakeAdapter()
    const logger = recordingLogger()
    let constructed = false
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      logger,
      createSlackUserAdapter: () => {
        constructed = true
        return fake
      },
    })

    // when: start runs with the hostd-backed adapter unsatisfiable
    // then: the whole manager must not crash — the adapter is skipped, not thrown
    await mgr.start()

    expect(constructed).toBe(false)
    expect(fake.startCalls).toBe(0)
    expect(logger.messages.some((m) => m.includes('could not be constructed'))).toBe(true)
    await mgr.stop()
  })

  test('starts slack adapter when both SLACK_BOT_TOKEN and SLACK_APP_TOKEN are set', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await mgr.stop()
  })

  test('does not start slack adapter when SLACK_APP_TOKEN is missing', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })
})

describe('channel manager — reload detects missing tokens and stops adapter', () => {
  test('stops slack adapter when SLACK_BOT_TOKEN is removed from env on reload', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    delete env.SLACK_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('slack-bot')
    expect(result.restartRequired).not.toContain('slack-bot (token rotation)')
    expect(fake.stopCalls).toBe(1)
  })

  test('stops slack adapter when SLACK_APP_TOKEN is removed from env on reload', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()

    delete env.SLACK_APP_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('slack-bot')
    expect(fake.stopCalls).toBe(1)
  })

  test('reports token rotation (not stop) when token value changes but is still present', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()

    env.SLACK_BOT_TOKEN = 'xoxb-rotated'

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('slack-bot')
    expect(result.restartRequired).toContain('slack-bot (token rotation)')
    expect(fake.stopCalls).toBe(0)
  })

  test('forwards aliasesRef to the router so configured aliases trigger engagement', async () => {
    // given: a manager wired with `aliasesRef` returning ["모모", "momo"], a
    //   slack-bot config with strict-mention trigger and stickiness off
    //   (so the ONLY remaining engagement paths are alias-substring match
    //   at engagement.ts:102 or the solo-human fallback at :174), and a
    //   participant cache primed with two distinct humans so the
    //   solo-human fallback is disabled and the alias path is the only
    //   engagement gate that can fire
    const slackCfg: ChannelAdapterConfig = {
      enabled: true,
      engagement: { trigger: ['mention'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }
    cfg['slack-bot'] = slackCfg
    const prompts: string[] = []
    const fakeSession = {
      prompt: async (text: string) => {
        prompts.push(text)
      },
      abort: async () => {},
      agent: { streamFunction: () => undefined, abort: () => {} },
      sessionManager: { getLeafEntry: () => undefined },
      subscribe: () => () => {},
    } as unknown as AgentSession
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      aliasesRef: () => ['모모', 'momo'],
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: () => makeFakeAdapter(),
      createSessionForChannel: async () => ({
        session: fakeSession,
        sessionId: 'ses_test_alias',
        dispose: async () => {},
      }),
    })

    const key: ChannelKey = { adapter: 'slack-bot', workspace: 'TXXX', chat: 'C111', thread: '1.0' }
    const baseInbound = (over: Partial<InboundMessage>): InboundMessage => ({
      ...key,
      text: '',
      externalMessageId: 'm0',
      authorId: 'U?',
      authorName: '?',
      authorIsBot: false,
      isBotMention: false,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: Date.parse('2026-05-01T00:00:00.000Z'),
      ...over,
    })

    // when: a first @-mention inbound from human A primes the channel (so
    //   the session exists), then a non-alias inbound from human B brings
    //   the participant count to two (defeating the solo-human fallback),
    //   and finally a NON-mention inbound from A whose text contains only
    //   the configured alias "모모" arrives — every structural trigger
    //   (mention, reply, dm, sticky) is off, leaving alias-match as the
    //   sole gate
    await mgr.router.route(
      baseInbound({ externalMessageId: 'm1', text: 'hello bot', authorId: 'U_A', authorName: 'A', isBotMention: true }),
    )
    await mgr.router.__testing!.flushDebounce(key)
    await mgr.router.route(
      baseInbound({ externalMessageId: 'm2', text: 'side comment', authorId: 'U_B', authorName: 'B' }),
    )
    await mgr.router.__testing!.flushDebounce(key)
    const promptsBeforeAlias = prompts.length
    await mgr.router.route(baseInbound({ externalMessageId: 'm3', text: '모모야', authorId: 'U_A', authorName: 'A' }))
    await mgr.router.__testing!.flushDebounce(key)

    // then: the alias-only inbound produces exactly one new prompt; if the
    //   manager dropped `aliasesRef` on the floor (the bug this fix
    //   addresses), `selfAliases` would fall back to `[basename(agentDir)]`
    //   only, "모모야" would not match any alias, and with the solo-human
    //   fallback disabled by U_B's prior inbound the message would be
    //   silently observed — promptsAfterAlias would equal promptsBeforeAlias
    const promptsAfterAlias = prompts.length
    expect(promptsAfterAlias - promptsBeforeAlias).toBe(1)
    expect(prompts[prompts.length - 1]).toContain('모모야')

    await mgr.stop()
  })

  test('forwards selfAliasesRef to the webex adapter so alias-only inbounds engage like mentions', async () => {
    cfg['webex-bot'] = enabledAdapterCfg()
    let captured: { selfAliasesRef?: () => readonly string[] } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      aliasesRef: () => ['타이피', 'typeey'],
      env: { WEBEX_BOT_TOKEN: 'webex-token' },
      createWebexBotAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    await mgr.start()

    expect(captured?.selfAliasesRef).toBeDefined()
    const aliases = captured!.selfAliasesRef!()
    expect(aliases).toContain('타이피')
    expect(aliases).toContain('typeey')

    await mgr.stop()
  })

  test('forwards selfAliasesRef to the slack adapter so the classifier can anchor threads on alias-only inbounds', async () => {
    // given: a manager wired with `aliasesRef` returning ["모모", "momo"]
    //   AND a `createSlackAdapter` test seam that captures the options the
    //   manager passes. The point of this test is the wiring itself: if a
    //   future refactor drops `selfAliasesRef` from manager.ts, every
    //   adapter-side and router-side test still passes (the seams keep
    //   their own fake aliases), but the production thread-anchoring path
    //   silently regresses. This test fails the moment that wiring
    //   disappears, so it's the only mutation guard between manager.ts
    //   and slack-bot-classify.ts.
    cfg['slack-bot'] = enabledAdapterCfg()
    let captured: { selfAliasesRef?: () => readonly string[] } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      aliasesRef: () => ['모모', 'momo'],
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    // when: the adapter is constructed at start
    await mgr.start()

    // then: the captured options carry a live selfAliasesRef whose result
    //   includes both the configured aliases AND the implicit dir-name
    //   alias the router seeds at construction (basename(agentDir))
    expect(captured?.selfAliasesRef).toBeDefined()
    const aliases = captured!.selfAliasesRef!()
    expect(aliases).toContain('모모')
    expect(aliases).toContain('momo')

    await mgr.stop()
  })

  test('stops discord adapter when DISCORD_BOT_TOKEN disappears (parity with slack)', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'd-tok' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createDiscordAdapter: () => fake,
    })

    await mgr.start()
    delete env.DISCORD_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('discord-bot')
    expect(fake.stopCalls).toBe(1)
  })
})

describe('channel manager — telegram adapter lifecycle', () => {
  test('starts telegram adapter and forwards TELEGRAM_BOT_TOKEN to it', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    let captured: { token?: string; configRef?: () => unknown } | undefined
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok-abc' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: (opts) => {
        captured = opts
        return fake
      },
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)
    // Mutation guard: a refactor that swapped TELEGRAM_BOT_TOKEN for the
    // wrong env var (or hardcoded a string) would still pass any test
    // that didn't capture the actual token passed to the adapter.
    expect(captured?.token).toBe('tg-tok-abc')
    expect(typeof captured?.configRef).toBe('function')

    await mgr.stop()
    expect(fake.stopCalls).toBe(1)
  })

  test('does not start telegram adapter when TELEGRAM_BOT_TOKEN is missing', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = {}
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })

  test('stops telegram adapter when TELEGRAM_BOT_TOKEN is removed from env on reload', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()
    delete env.TELEGRAM_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('telegram-bot')
    expect(fake.stopCalls).toBe(1)
  })

  test('reports token rotation (not stop) when TELEGRAM_BOT_TOKEN value changes but is still present', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok-1' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()

    env.TELEGRAM_BOT_TOKEN = 'tg-tok-2'

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('telegram-bot')
    expect(result.restartRequired).toContain('telegram-bot (token rotation)')
    expect(fake.stopCalls).toBe(0)
  })
})

describe('channel manager — kakaotalk credential preflight', () => {
  const kakaoEnv: NodeJS.ProcessEnv = {
    TYPECLAW_HOSTD_URL: 'http://host.docker.internal:8974',
    TYPECLAW_HOSTD_TOKEN: 'restart-token',
    TYPECLAW_CONTAINER_NAME: 'typeclaw-test',
  }

  const writeKakaoSecrets = async (dir: string, accountId = 'a1'): Promise<string> => {
    const path = join(dir, 'secrets.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        providers: {},
        channels: {
          kakaotalk: {
            currentAccount: accountId,
            accounts: {
              [accountId]: {
                account_id: accountId,
                oauth_token: `oauth-${accountId}`,
                user_id: accountId,
                device_uuid: `device-${accountId}`,
                device_type: 'tablet',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
              },
            },
          },
        },
      }),
    )
    return path
  }

  test('starts kakaotalk adapter when credentials exist in secrets.json', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await mgr.stop()
  })

  test('does not start kakaotalk adapter when secrets.json lacks kakaotalk credentials', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })

  test('missing kakaotalk credentials preflight does not create secrets.json', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const secretsPath = join(agentDir, 'secrets.json')
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()

    expect(fake.startCalls).toBe(0)
    expect(existsSync(secretsPath)).toBe(false)

    await mgr.stop()
  })

  test('reload stops kakaotalk adapter when credentials are removed from secrets.json', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const path = await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await writeFile(path, JSON.stringify({ version: 2, providers: {}, channels: {} }))

    const result = await mgr.reload()
    expect(result.stopped).toContain('kakaotalk')
    expect(fake.stopCalls).toBe(1)
  })

  test('reload reports credential rotation (not stop) when secrets kakaotalk block changes', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    await writeKakaoSecrets(agentDir, 'a2')

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('kakaotalk')
    expect(result.restartRequired).toContain('kakaotalk (credential rotation)')

    await mgr.stop()
  })

  test('reload does not report rotation when secrets kakaotalk block is unchanged', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    await writeKakaoSecrets(agentDir)

    const result = await mgr.reload()
    expect(result.restartRequired).not.toContain('kakaotalk (credential rotation)')

    await mgr.stop()
  })

  test('reload applies the rotation when the caller names that adapter', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    await writeKakaoSecrets(agentDir, 'a2')

    const result = await mgr.reload({ applyCredentialRotation: 'kakaotalk' })

    expect(fake.stopCalls).toBe(1)
    expect(fake.startCalls).toBe(2)
    expect(result.restarted).toContain('kakaotalk')
    expect(result.restartRequired).not.toContain('kakaotalk (credential rotation)')
    expect(result.credentialApply).toEqual({ adapter: 'kakaotalk', outcome: 'restarted' })

    await mgr.stop()
  })

  test('reload leaves a rotated adapter running when a different adapter is named', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    await writeKakaoSecrets(agentDir, 'a2')

    const result = await mgr.reload({ applyCredentialRotation: 'teams' })

    expect(fake.stopCalls).toBe(0)
    expect(result.restarted).not.toContain('kakaotalk')
    expect(result.restartRequired).toContain('kakaotalk (credential rotation)')
    expect(result.credentialApply).toBeUndefined()

    await mgr.stop()
  })

  test('reload does not bounce a named adapter whose credential did not change', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()

    const result = await mgr.reload({ applyCredentialRotation: 'kakaotalk' })

    expect(fake.stopCalls).toBe(0)
    expect(result.restarted).toEqual([])
    // Reported rather than silent: a named adapter that reports nothing reads as
    // "could not apply" and sends the caller to a container restart.
    expect(result.credentialApply).toEqual({ adapter: 'kakaotalk', outcome: 'already-current' })

    await mgr.stop()
  })

  test('applies the rotation by starting a named adapter that was already down', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    let failStart = true
    fake.start = async () => {
      if (failStart) throw new Error('token rejected')
      fake.startCalls++
      fake.connected = true
    }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()

    failStart = false
    await writeKakaoSecrets(agentDir, 'renewed')
    const result = await mgr.reload({ applyCredentialRotation: 'kakaotalk' })

    expect(result.started).toContain('kakaotalk')
    expect(result.credentialApply).toEqual({ adapter: 'kakaotalk', outcome: 'restarted' })

    await mgr.stop()
  })

  test('reports recovery-pending when a named down adapter still cannot start', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    fake.start = async () => {
      throw new Error('token rejected')
    }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()

    await writeKakaoSecrets(agentDir, 'renewed')
    const result = await mgr.reload({ applyCredentialRotation: 'kakaotalk' })

    expect(result.started).not.toContain('kakaotalk')
    expect(result.credentialApply).toEqual({ adapter: 'kakaotalk', outcome: 'recovery-pending' })

    await mgr.stop()
  })

  test('an unnamed reload still reports nothing for a down adapter it revived', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    let failStart = true
    fake.start = async () => {
      if (failStart) throw new Error('token rejected')
      fake.startCalls++
      fake.connected = true
    }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()

    failStart = false
    await writeKakaoSecrets(agentDir, 'renewed')
    const result = await mgr.reload()

    expect(result.started).toContain('kakaotalk')
    expect(result.credentialApply).toBeUndefined()

    await mgr.stop()
  })

  test('does not record a credential signature the started adapter never loaded', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    let rewroteDuringStart = false
    fake.start = async () => {
      fake.startCalls++
      fake.connected = true
      if (!rewroteDuringStart) {
        rewroteDuringStart = true
        await writeKakaoSecrets(agentDir, 'landed-mid-start')
      }
    }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()

    // The write landed after the pre-start signature was taken, so committing it
    // would leave the entry describing a credential the adapter is not holding —
    // and the next reload would then see nothing to apply.
    const result = await mgr.reload()
    expect(result.restartRequired).not.toContain('kakaotalk (credential rotation)')
    expect(fake.startCalls).toBe(2)

    await mgr.stop()
  })

  test('reload reports the rotation as still owed when the adapter cannot be stopped', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    fake.stop = async () => {
      throw new Error('stop refused')
    }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    await writeKakaoSecrets(agentDir, 'a2')

    const result = await mgr.reload({ applyCredentialRotation: 'kakaotalk' })

    expect(result.credentialApply).toEqual({ adapter: 'kakaotalk', outcome: 'stop-failed' })
    expect(result.restarted).not.toContain('kakaotalk')
    expect(result.restartRequired).toContain('kakaotalk (credential rotation)')
  })
})

describe('channel manager — router adapter-configured wiring', () => {
  test('a configured adapter whose start() fails still reports history as configured-but-unavailable', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const failing = makeFakeAdapter()
    failing.start = async () => {
      throw new Error('401: Unauthorized')
    }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => failing,
    })

    await mgr.start()

    const result = await mgr.router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('history-adapter-unavailable')

    await mgr.stop()
  })

  test('an adapter absent from config reports history as plain not-supported', async () => {
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
    })

    await mgr.start()

    const result = await mgr.router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })
    expect(result).toEqual({ ok: false, error: 'history-not-supported' })

    await mgr.stop()
  })

  test('reload dropping an adapter from config reverts it to not-supported', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => fake,
    })

    await mgr.start()
    delete cfg['discord-bot']
    await mgr.reload()

    const result = await mgr.router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })
    expect(result).toEqual({ ok: false, error: 'history-not-supported' })

    await mgr.stop()
  })
})
