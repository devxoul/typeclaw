import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'

import { BackgroundObligationStore } from './background-obligations'
import { RecoveryDispatcher } from './recovery-dispatcher'
import { createRecoveryNotice } from './recovery-notice'
import { RecoveryOutbox } from './recovery-outbox'
import { createChannelRouter } from './router'
import { defaultHistoryConfig } from './schema'

const target = { adapter: 'slack-bot' as const, workspace: 'team', chat: 'room', thread: null }

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'background-dispatch-'))
  let failAck = false
  const closed = Promise.withResolvers<void>()
  const error = Promise.withResolvers<unknown>()
  const delivered = Promise.withResolvers<void>()
  const sending = Promise.withResolvers<void>()
  const transport = Promise.withResolvers<void>()
  let holdSend = false
  const sent: string[] = []
  const source = new BackgroundObligationStore(dir, {
    epoch: 'boot',
    onDurability: (phase, row) => {
      if (row.phase !== 'closed') return
      if (failAck && phase === 'temp-synced') throw new Error('source receipt write unavailable')
      if (phase === 'directory-synced') closed.resolve()
    },
  })
  const old = new BackgroundObligationStore(dir, { epoch: 'old' })
  const accepted = await old.accept({
    key: target,
    accountIdentity: 'actor',
    parentSessionId: 'parent',
    taskId: 'task',
  })
  const outbox = new RecoveryOutbox(dir, {
    epoch: 'boot',
    onDurability: (phase, row) => {
      if (phase === 'directory-synced' && row.state === 'delivered') delivered.resolve()
    },
  })
  await source.importOldEpoch(outbox)
  const notice = (await outbox.list())[0]!
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
  router.registerRecoveryAdapter('slack-bot', {
    accountIdentity: async () => 'actor',
    cachedAccountIdentity: () => 'actor',
    reconcile: async () => ({ status: 'unreconcilable' }),
  })
  router.registerOutbound('slack-bot', async (message) => {
    sent.push(message.sendOptions?.accounting === 'recovery' ? message.sendOptions.deliveryId : 'unknown')
    sending.resolve()
    if (holdSend) await transport.promise
    return { ok: true, messageId: 'remote-notice' }
  })
  const dispatcher = new RecoveryDispatcher(outbox, router, { backgroundObligations: source, onError: error.resolve })
  return {
    dir,
    source,
    outbox,
    notice,
    accepted,
    router,
    dispatcher,
    closed,
    delivered,
    error,
    sending,
    transport,
    sent,
    failAck: () => {
      failAck = true
    },
    holdSend: () => {
      holdSend = true
    },
    cleanup: async () => {
      transport.resolve()
      await dispatcher.stop()
      await router.stop()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('confirmed real-router transport closes exactly its background source', async () => {
  const f = await fixture()
  try {
    await f.dispatcher.wake()
    await f.closed.promise
    await f.dispatcher.stop()
    expect(f.sent).toEqual([f.notice.deliveryId])
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'delivered', deliveryId: f.notice.deliveryId },
    })
    expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({
      state: 'delivered',
      receipt: { messageId: 'remote-notice' },
    })
  } finally {
    await f.cleanup()
  }
})

test('landed receipt repairs failed source acknowledgment on reboot without another send', async () => {
  const f = await fixture()
  try {
    f.failAck()
    await f.dispatcher.wake()
    await f.error.promise
    await f.dispatcher.stop()
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({ phase: 'notice-owned' })
    const repaired = new BackgroundObligationStore(f.dir, { epoch: 'reboot' })
    const reboot = new RecoveryDispatcher(new RecoveryOutbox(f.dir, { epoch: 'reboot' }), f.router, {
      backgroundObligations: repaired,
    })
    try {
      await reboot.wake()
      await reboot.stop()
      expect(await repaired.get(f.accepted.obligationId)).toMatchObject({
        phase: 'closed',
        outcome: { kind: 'delivered' },
      })
      expect(f.sent).toEqual([f.notice.deliveryId])
    } finally {
      await reboot.stop()
    }
  } finally {
    await f.cleanup()
  }
})

test('forged background coverage cannot use a valid source transfer to send', async () => {
  const f = await fixture()
  try {
    await f.outbox.suppress(f.notice.deliveryId, 'test-replacement', 'replacement')
    const forged = createRecoveryNotice({
      ...f.notice,
      covers: [{ ...f.notice.covers[0]!, generation: f.notice.covers[0]!.generation + 1 }],
    })
    await f.outbox.import(forged)
    await f.dispatcher.wake()
    await f.error.promise
    await f.dispatcher.stop()
    expect(f.sent).toEqual([])
    expect(await f.outbox.get(forged.deliveryId)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'intentionally-suppressed', decisionId: 'replacement' },
    })
  } finally {
    await f.cleanup()
  }
})

test('journal freeze blocks background but does not strand independent inventory-only notice on same target', async () => {
  const f = await fixture()
  try {
    const independent = createRecoveryNotice({
      ...f.notice,
      covers: [{ store: 'inventory', id: 'legacy', generation: 1 }],
      transferId: 'legacy',
      recoveryGeneration: 'legacy',
    })
    await f.outbox.import(independent)
    f.source.setFrozen(new Error('journal repair required'))
    await f.dispatcher.wake()
    await f.delivered.promise
    await f.dispatcher.stop()
    expect(f.sent).toEqual([independent.deliveryId])
    expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(await f.outbox.get(independent.deliveryId)).toMatchObject({ state: 'delivered' })
  } finally {
    await f.cleanup()
  }
})

test('stop source suppression precedes outbox suppression and prevents dispatch', async () => {
  const f = await fixture()
  try {
    const boundary = new BackgroundObligationStore(f.dir, {
      epoch: 'boot',
      onDurability: async (phase, row) => {
        if (phase === 'directory-synced' && row.phase === 'closed') {
          expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({ state: 'pending' })
        }
      },
    })
    const dispatcher = new RecoveryDispatcher(f.outbox, f.router, { backgroundObligations: boundary })
    try {
      await dispatcher.suppressParent(target, 'parent')
      await dispatcher.wake()
      await dispatcher.stop()
      expect(await boundary.get(f.accepted.obligationId)).toMatchObject({
        phase: 'closed',
        outcome: { kind: 'intentionally-suppressed', reason: 'user-stop' },
      })
      expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({ state: 'suppressed' })
      expect(f.sent).toEqual([])
    } finally {
      await dispatcher.stop()
    }
  } finally {
    await f.cleanup()
  }
})

test('stop during in-flight real-router send retains remote receipt and never retries', async () => {
  const f = await fixture()
  try {
    f.holdSend()
    await f.dispatcher.wake()
    await f.sending.promise
    await f.dispatcher.suppressParent(target, 'parent')
    f.transport.resolve()
    await f.dispatcher.stop()
    expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({
      state: 'suppressed',
      receipt: { messageId: 'remote-notice' },
    })
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'intentionally-suppressed' },
    })
    const reboot = new RecoveryDispatcher(new RecoveryOutbox(f.dir, { epoch: 'reboot' }), f.router, {
      backgroundObligations: new BackgroundObligationStore(f.dir, { epoch: 'reboot' }),
    })
    try {
      await reboot.wake()
      await reboot.stop()
    } finally {
      await reboot.stop()
    }
    expect(f.sent).toEqual([f.notice.deliveryId])
  } finally {
    await f.cleanup()
  }
})

test('inbound-covered notice cannot dispatch without its journal authority', async () => {
  const f = await fixture()
  try {
    await f.outbox.suppress(f.notice.deliveryId, 'test-replacement', 'replacement')
    const inbound = createRecoveryNotice({
      ...f.notice,
      covers: [{ store: 'inbound', id: 'request', generation: 1 }],
      transferId: 'inbound-transfer',
      recoveryGeneration: 'inbound-generation',
    })
    await f.outbox.import(inbound)
    await f.dispatcher.wake()
    await f.error.promise
    await f.dispatcher.stop()
    expect(f.sent).toEqual([])
    expect(await f.outbox.get(inbound.deliveryId)).toMatchObject({ state: 'pending', attempts: 0 })
  } finally {
    await f.cleanup()
  }
})

test('journal failure during transport preflight prevents leasing while independent inventory progresses', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const validate = f.router.validateRecovery.bind(f.router)
  f.router.validateRecovery = async (record) => {
    if (record.deliveryId === f.notice.deliveryId) {
      entered.resolve()
      await release.promise
    }
    return validate(record)
  }
  try {
    const independent = createRecoveryNotice({
      ...f.notice,
      covers: [{ store: 'inventory', id: 'independent-preflight', generation: 1 }],
      transferId: 'independent-preflight',
      recoveryGeneration: 'independent-preflight',
    })
    await f.outbox.import(independent)
    await f.dispatcher.wake()
    await entered.promise
    f.source.setFrozen(new Error('journal became unreadable during metadata lookup'))
    release.resolve()
    await f.delivered.promise
    await f.dispatcher.stop()
    expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(f.sent).toEqual([independent.deliveryId])
  } finally {
    release.resolve()
    await f.cleanup()
  }
})
