import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LegacyBackgroundHandoffReader } from './background-handoff'
import { createLegacyRecoveryNotice } from './background-handoff'
import { BackgroundObligationStore } from './background-obligations'
import { RecoveryOutbox } from './recovery-outbox'
import { channelKeyId } from './types'

for (const location of ['pending', 'claimed'])
  test(`legacy ${location} honors delivered transfer receipt without a second notice`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legacy-obligation-'))
    try {
      const key = { adapter: 'discord-bot' as const, workspace: 'w', chat: 'c', thread: 't' }
      const id = createHash('sha256')
        .update(JSON.stringify([channelKeyId(key), 'parent']))
        .digest('hex')
      const directory = join(dir, 'channels/background-handoffs', ...(location === 'claimed' ? ['claimed'] : []))
      await mkdir(directory, { recursive: true })
      const record = {
        schemaVersion: 1 as const,
        generationId: randomUUID(),
        processEpoch: 'dead',
        parentSessionId: 'parent',
        key,
        tasks: [{ taskId: 'task', subagentName: 'worker', startedAt: 1, accountIdentity: 'actor' }],
      }
      const transfer = createLegacyRecoveryNotice(record)
      const outbox = new RecoveryOutbox(dir, { epoch: 'boot' })
      await outbox.import(transfer)
      const lease = await outbox.lease(transfer.deliveryId, 1)
      expect(lease).toBeDefined()
      await outbox.delivered(transfer.deliveryId, lease!, { confirmedAt: 2, messageId: 'landed' })
      await writeFile(
        join(directory, location === 'claimed' ? `${id}.${randomUUID()}.json` : `${id}.json`),
        JSON.stringify({ ...record, recoveryTransfer: { phase: 'notice-owned', record: transfer } }),
      )
      const obligations = new BackgroundObligationStore(dir, { epoch: 'boot' })
      await obligations.migrateLegacy(new LegacyBackgroundHandoffReader(dir, { processEpoch: 'boot' }), outbox)
      const rows = await obligations.list()
      expect(rows.map((row) => [row.taskId, row.phase, row.outcome?.deliveryId, row.legacyCoverage?.id])).toEqual([
        ['task', 'closed', transfer.deliveryId, transfer.covers[0]!.id],
      ])
      await obligations.importOldEpoch(outbox)
      expect((await outbox.list()).map((row) => [row.deliveryId, row.state, row.receipt?.messageId])).toEqual([
        [transfer.deliveryId, 'delivered', 'landed'],
      ])
      expect(await readdir(join(dir, 'channels/background-handoffs/claimed'))).toEqual([])
      obligations.setFrozen(new Error('journal unavailable'))
      expect(await obligations.validateNotice(transfer)).toBe('resolved')
      await obligations.acknowledgeNotice((await outbox.get(transfer.deliveryId))!)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
