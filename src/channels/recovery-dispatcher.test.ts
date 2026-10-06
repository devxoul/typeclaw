import { test, expect } from 'bun:test'
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'

import { createBotRecoveryCallbacks } from './adapters/recovery-correlation'
import { RECOVERY_NOTICE_TEXT, recoveryDeliveryId, type RecoveryRecord } from './continuity-types'
import { RecoveryDispatcher } from './recovery-dispatcher'
import { RecoveryOutbox } from './recovery-outbox'
import { createChannelRouter, type ChannelRouter } from './router'
import { defaultHistoryConfig } from './schema'

function record(chat: string, accountIdentity = 'actor'): RecoveryRecord {
  const value: RecoveryRecord = {
    schemaVersion: 1,
    deliveryId: '',
    purpose: 'interruption-notice',
    target: { adapter: 'discord-bot', workspace: 'g', chat, thread: null },
    accountIdentity,
    principal: { kind: 'channel', adapter: 'discord-bot', workspace: 'g', chat, lastInboundAuthorId: 'user' },
    covers: [{ store: 'inventory', id: chat, generation: 1, parentSessionId: 'parent' }],
    transferId: chat,
    recoveryGeneration: 'inventory',
    templateVersion: 1,
    locale: 'en',
    text: RECOVERY_NOTICE_TEXT,
    createdAt: 0,
    generation: 1,
    state: 'pending',
    attempts: 0,
  }
  value.deliveryId = recoveryDeliveryId(value)
  return value
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error('recovery did not reach expected durable state')
}

test('a hung destination does not block another and in-flight stop retains receipt without retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-dispatch-'))
  const outbox = new RecoveryOutbox(dir, { epoch: 'boot' })
  const a = record('a'),
    b = record('b')
  await outbox.import(a)
  await outbox.import(b)
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const sent: string[] = []
  const router = {
    setRecoveryStopHandler() {},
    validateRecovery: async () => undefined,
    reconcileRecovery: async () => ({ status: 'unreconcilable' }),
    send: async (message: { chat: string }) => {
      sent.push(message.chat)
      if (message.chat === 'a') await gate
      return { ok: true, messageId: message.chat }
    },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(outbox, router)
  try {
    await dispatcher.wake()
    await until(async () => (await outbox.get(b.deliveryId))?.state === 'delivered')
    expect(sent).toContain('a')
    await dispatcher.suppressParent(a.target, 'parent')
    finish()
    await dispatcher.stop()
    const stopped = await new RecoveryOutbox(dir, { epoch: 'next' }).get(a.deliveryId)
    expect(stopped?.state).toBe('suppressed')
    expect(stopped?.receipt?.messageId).toBe('a')
    expect(sent.filter((chat) => chat === 'a')).toEqual(['a'])
  } finally {
    finish()
    await dispatcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy binding survives reboot and rotated identity blocks original destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-bind-'))
  const outbox = new RecoveryOutbox(dir, { epoch: 'first' })
  const notice = record('legacy', 'unbound-legacy')
  await outbox.import(notice)
  let actor = 'first-actor'
  let sends = 0
  const router = {
    setRecoveryStopHandler() {},
    getRecoveryAccountIdentity: async () => actor,
    validateRecovery: async (value: RecoveryRecord) =>
      value.boundAccountIdentity !== undefined && value.boundAccountIdentity !== actor
        ? { kind: 'identity', safeReason: 'changed' }
        : undefined,
    reconcileRecovery: async () => ({ status: 'unreconcilable' }),
    send: async () => {
      sends++
      return { ok: false, error: 'unavailable' }
    },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(outbox, router)
  try {
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'pending' && sends === 1)
    await dispatcher.stop()
    actor = 'second-actor'
    const restarted = new RecoveryOutbox(dir, { epoch: 'next', now: () => Date.now() + 100_000 })
    const next = new RecoveryDispatcher(restarted, router, { now: () => Date.now() + 100_000 })
    await next.wake()
    await until(async () => (await restarted.get(notice.deliveryId))?.state === 'blocked')
    await next.stop()
    expect((await restarted.get(notice.deliveryId))?.boundAccountIdentity).toBe('first-actor')
    expect(sends).toBe(1)
  } finally {
    await dispatcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('old ambiguous lease reconciles its own post and persists receipt without reposting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-reconcile-'))
  const source = new RecoveryOutbox(dir, { epoch: 'dead', now: () => 1 })
  const notice = record('ambiguous')
  await source.import(notice)
  await source.lease(notice.deliveryId, 1)
  const recovered = new RecoveryOutbox(dir, { epoch: 'new', now: () => 10_000 })
  let sends = 0
  const router = {
    setRecoveryStopHandler() {},
    validateRecovery: async () => undefined,
    reconcileRecovery: async () => ({ status: 'found', messageId: 'remote-confirmed' }),
    send: async () => {
      sends++
      return { ok: true }
    },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(recovered, router, { now: () => 10_000 })
  try {
    await dispatcher.wake()
    await until(async () => (await recovered.get(notice.deliveryId))?.state === 'delivered')
    await dispatcher.stop()
    expect((await new RecoveryOutbox(dir).get(notice.deliveryId))?.receipt?.messageId).toBe('remote-confirmed')
    expect(sends).toBe(0)
  } finally {
    await dispatcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('independent process death after remote success reconciles across two reboots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-process-'))
  const notice = record('remote')
  await new RecoveryOutbox(dir).import(notice)
  const child = `
    import {readFile,writeFile} from 'node:fs/promises';
    import {RecoveryOutbox} from './src/channels/recovery-outbox';
    import {RecoveryDispatcher} from './src/channels/recovery-dispatcher';
    const dir=process.env.RECOVERY_DIR, id=process.env.RECOVERY_ID, mode=process.env.RECOVERY_MODE;
    const outbox=new RecoveryOutbox(dir,{epoch:crypto.randomUUID(),now:()=>100000});
    const router={setRecoveryStopHandler(){},validateRecovery:async()=>undefined,
      reconcileRecovery:async()=>{try {await readFile(dir+'/remote');return {status:'found',messageId:'own-remote'}} catch{return {status:'unreconcilable'}}},
      send:async()=>{await writeFile(dir+'/remote','own-remote');if(mode==='crash')process.exit(77);throw new Error('known own post must not be duplicated')}
    };
    const dispatch=new RecoveryDispatcher(outbox,router,{now:()=>100000,consistencyDelayMs:0});
    await dispatch.wake();
    while((await outbox.get(id)).state!=='delivered') await new Promise(setImmediate);
    await dispatch.stop();
  `
  const run = async (mode: string) => {
    const process = Bun.spawn([Bun.which('bun')!, '-e', child], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...Bun.env, RECOVERY_DIR: dir, RECOVERY_ID: notice.deliveryId, RECOVERY_MODE: mode },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return process.exited
  }
  try {
    expect(await run('crash')).toBe(77)
    expect((await new RecoveryOutbox(dir).get(notice.deliveryId))?.state).toBe('leased')
    expect(await run('recover')).toBe(0)
    expect(await run('recover-again')).toBe(0)
    const durable = await new RecoveryOutbox(dir).get(notice.deliveryId)
    expect(durable?.deliveryId).toBe(notice.deliveryId)
    expect(durable?.receipt?.messageId).toBe('own-remote')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Retry-After prevents an early retry and authorization restoration permits delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-retry-'))
  let time = 1000
  const outbox = new RecoveryOutbox(dir, { epoch: 'retry', now: () => time })
  const notice = record('retry')
  await outbox.import(notice)
  let attempts = 0
  let allowed = true
  const router = {
    setRecoveryStopHandler() {},
    validateRecovery: async () => (allowed ? undefined : { kind: 'permission', safeReason: 'withdrawn' }),
    reconcileRecovery: async () => ({ status: 'unreconcilable' }),
    send: async () =>
      ++attempts === 1
        ? {
            ok: false,
            error: '429',
            recoveryFailure: { kind: 'rate-limit', safeReason: 'rate limited', retryAfter: 20_000 },
          }
        : { ok: true, messageId: 'restored' },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(outbox, router, { now: () => time })
  try {
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'pending' && attempts === 1)
    time = 10_000
    await dispatcher.wake()
    expect(attempts).toBe(1)
    time = 30_000
    allowed = false
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'blocked')
    allowed = true
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'delivered')
    expect(attempts).toBe(2)
    expect((await outbox.get(notice.deliveryId))?.receipt?.messageId).toBe('restored')
  } finally {
    await dispatcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('lease death retries and unreconcilable remote success permits one duplicate, not a third post', async () => {
  for (const landed of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-death-'))
    const notice = record('unsupported')
    await new RecoveryOutbox(dir).import(notice)
    const child = `
      import {appendFile} from 'node:fs/promises';
      import {RecoveryOutbox} from './src/channels/recovery-outbox';
      const outbox=new RecoveryOutbox(process.env.DIR,{epoch:'dead',now:()=>1});
      await outbox.lease(process.env.ID,1);
      if(process.env.LANDED==='yes') await appendFile(process.env.DIR+'/posts','post\\n');
      process.exit(77);
    `
    const process = Bun.spawn([Bun.which('bun')!, '-e', child], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...Bun.env, DIR: dir, ID: notice.deliveryId, LANDED: landed ? 'yes' : 'no' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await process.exited).toBe(77)
    const router = {
      setRecoveryStopHandler() {},
      validateRecovery: async () => undefined,
      reconcileRecovery: async () => ({ status: 'unreconcilable' }),
      send: async () => {
        await appendFile(join(dir, 'posts'), 'post\n')
        return { ok: true }
      },
    } as unknown as ChannelRouter
    const outbox = new RecoveryOutbox(dir, { epoch: 'new', now: () => 10_000 })
    const dispatch = new RecoveryDispatcher(outbox, router, { now: () => 10_000 })
    try {
      await dispatch.wake()
      await until(async () => (await outbox.get(notice.deliveryId))?.state === 'delivered')
      await dispatch.stop()
      const reboot = new RecoveryDispatcher(new RecoveryOutbox(dir, { epoch: 'again' }), router)
      await reboot.wake()
      await reboot.stop()
      expect(await readFile(join(dir, 'posts'), 'utf8')).toBe(landed ? 'post\npost\n' : 'post\n')
    } finally {
      await dispatch.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('missing adapter leaves legacy owed and restoration binds only the original target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-ready-'))
  let time = 1
  let identity: string | undefined
  let configured = false
  const outbox = new RecoveryOutbox(dir, { epoch: 'ready', now: () => time })
  const notice = record('original', 'unbound-legacy')
  await outbox.import(notice)
  const targets: string[] = []
  const router = {
    setRecoveryStopHandler() {},
    getRecoveryAccountIdentity: async () => identity,
    validateRecovery: async () =>
      configured ? undefined : { kind: 'configuration', safeReason: 'original adapter is not configured' },
    reconcileRecovery: async () => ({ status: 'unreconcilable' }),
    send: async (message: { chat: string }) => {
      targets.push(message.chat)
      return { ok: true }
    },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(outbox, router, { now: () => time })
  try {
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'blocked')
    expect(targets).toEqual([])
    identity = 'restored-actor'
    configured = true
    time = 100_000
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'delivered')
    expect(targets).toEqual(['original'])
    expect((await outbox.get(notice.deliveryId))?.boundAccountIdentity).toBe('restored-actor')
  } finally {
    await dispatcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('receipt sync failure reconciles pending ambiguity before any second send', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-receipt-fault-'))
  let time = 1
  let fault = true
  const outbox = new RecoveryOutbox(dir, {
    epoch: 'receipt',
    now: () => time,
    onDurability: (phase, value) => {
      if (fault && value.state === 'delivered' && phase === 'temp-synced') {
        fault = false
        throw new Error('injected file sync boundary death')
      }
    },
  })
  const notice = record('receipt')
  await outbox.import(notice)
  let sends = 0
  const router = {
    setRecoveryStopHandler() {},
    validateRecovery: async () => undefined,
    reconcileRecovery: async () => ({ status: 'found', messageId: 'remote' }),
    send: async () => {
      sends++
      return { ok: true, messageId: 'remote' }
    },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(outbox, router, { now: () => time })
  try {
    await dispatcher.wake()
    await until(async () => !fault && (await outbox.get(notice.deliveryId))?.state === 'pending')
    time = 10_000
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'delivered')
    expect(sends).toBe(1)
    expect((await outbox.get(notice.deliveryId))?.receipt?.messageId).toBe('remote')
  } finally {
    await dispatcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('new-account mismatch blocks, restoration retries timeout after bounded consistency delay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-timeout-'))
  let time = 1
  let actor = 'wrong'
  let sends = 0
  const outbox = new RecoveryOutbox(dir, { epoch: 'timeout', now: () => time })
  const notice = record('fixed', 'accepted-actor')
  await outbox.import(notice)
  const router = {
    setRecoveryStopHandler() {},
    validateRecovery: async (value: RecoveryRecord) =>
      value.accountIdentity === actor ? undefined : { kind: 'identity', safeReason: 'account changed' },
    reconcileRecovery: async () => {
      throw new Error('history unavailable is not proof of absence')
    },
    send: async () => {
      if (++sends === 1) throw new Error('timeout')
      return { ok: true }
    },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(outbox, router, { now: () => time })
  try {
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'blocked')
    expect(sends).toBe(0)
    actor = 'accepted-actor'
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'pending')
    expect((await outbox.get(notice.deliveryId))?.nextAttemptAt).toBeGreaterThanOrEqual(5001)
    time = 100_000
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'delivered')
    expect(sends).toBe(2)
    expect((await outbox.get(notice.deliveryId))?.boundAccountIdentity).toBeUndefined()
  } finally {
    await dispatcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('real identity HTTP failures persist authorization, Retry-After and transient backoff', async () => {
  for (const status of [429, 401, 503]) {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-preflight-'))
    let time = 1000
    let requests = 0
    let sends = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++
        return new Response('{}', { status, ...(status === 429 ? { headers: { 'Retry-After': '120' } } : {}) })
      },
    })
    const outbox = new RecoveryOutbox(dir, { epoch: 'preflight', now: () => time })
    const notice = record(`http-${status}`, 'slack-bot:T1:actor')
    notice.target = { adapter: 'slack-bot', workspace: 'T1', chat: `http-${status}`, thread: null }
    notice.principal = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T1',
      chat: `http-${status}`,
      lastInboundAuthorId: 'user',
    }
    notice.deliveryId = recoveryDeliveryId(notice)
    await outbox.import(notice)
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => ({
        enabled: true,
        engagement: { trigger: ['dm'], stickiness: 'off' },
        history: defaultHistoryConfig(),
      }),
      permissions: { ...noopPermissionService, has: () => true },
      logger: { info() {}, warn() {}, error() {} },
    })
    router.registerRecoveryAdapter(
      'slack-bot',
      createBotRecoveryCallbacks(
        'slack-bot',
        'token',
        Object.assign((_url: RequestInfo | URL, init?: RequestInit) => fetch(server.url, init), {
          preconnect: fetch.preconnect,
        }),
      ),
    )
    router.registerOutbound('slack-bot', async () => {
      sends++
      return { ok: true }
    })
    const dispatcher = new RecoveryDispatcher(outbox, router, { now: () => time })
    try {
      // Admission reads cached identity only, never the platform endpoint.
      expect(await router.getRecoveryAccountIdentity('slack-bot', 'T1')).toBeUndefined()
      expect(requests).toBe(0)
      await dispatcher.wake()
      await until(async () => (await outbox.get(notice.deliveryId))?.failure !== undefined)
      const failed = (await outbox.get(notice.deliveryId))!
      expect(failed.attempts).toBe(1)
      expect(failed.state).toBe(status === 401 ? 'blocked' : 'pending')
      expect(failed.failure?.kind).toBe(status === 429 ? 'rate-limit' : status === 401 ? 'permission' : 'transient')
      expect(sends).toBe(0)
      if (status !== 401) {
        if (status === 429) expect(failed.nextAttemptAt).toBe(121_000)
        else expect(failed.nextAttemptAt).toBeGreaterThanOrEqual(1800)
        time = status === 429 ? 31_000 : failed.nextAttemptAt! - 1
        await dispatcher.wake()
        expect(requests).toBe(1)
        expect((await outbox.get(notice.deliveryId))?.attempts).toBe(1)
        time = failed.nextAttemptAt!
        await dispatcher.wake()
        await until(
          async () =>
            (await outbox.get(notice.deliveryId))?.attempts === 2 &&
            (await outbox.get(notice.deliveryId))?.state === 'pending',
        )
        expect(requests).toBe(2)
      }
    } finally {
      await dispatcher.stop()
      server.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('same-epoch failed lease publication is repaired before remote send', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-lease-repair-'))
  let time = 1000
  let fault = true
  const events: string[] = []
  const errors: unknown[] = []
  const outbox = new RecoveryOutbox(dir, {
    epoch: 'same-boot',
    now: () => time,
    onDurability: (phase, value) => {
      events.push(`${value.state}:${phase}`)
      if (fault && value.state === 'leased' && phase === 'replaced') {
        fault = false
        throw new Error('directory sync unavailable')
      }
    },
  })
  const notice = record('lease-repair')
  await outbox.import(notice)
  let sends = 0
  const router = {
    setRecoveryStopHandler() {},
    validateRecovery: async () => undefined,
    reconcileRecovery: async () => ({ status: 'unreconcilable' }),
    send: async () => {
      events.push('REMOTE_SEND')
      sends++
      return { ok: true, messageId: 'repaired' }
    },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(outbox, router, { now: () => time, onError: (error) => errors.push(error) })
  try {
    await dispatcher.wake()
    await until(async () => errors.length === 1)
    expect(sends).toBe(0)
    expect((await outbox.get(notice.deliveryId))?.state).toBe('leased')
    time = 31_000
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'delivered')
    expect(sends).toBe(1)
    expect(events.indexOf('leased:directory-synced')).toBeGreaterThan(events.indexOf('leased:replaced'))
    expect(events.indexOf('REMOTE_SEND')).toBeGreaterThan(events.indexOf('leased:directory-synced'))
    expect((await outbox.get(notice.deliveryId))?.attempts).toBe(1)
    expect((await outbox.get(notice.deliveryId))?.receipt?.messageId).toBe('repaired')
  } finally {
    await dispatcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
