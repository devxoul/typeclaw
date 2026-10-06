import { createHash } from 'node:crypto'

import { z } from 'zod'

import type { MatchableOrigin } from '../permissions/resolve'
import { ADAPTER_IDS } from './schema'
import type { ChannelKey } from './types'

export type RecoveryCoverage = {
  store: 'inventory' | 'background' | 'inbound'
  id: string
  generation: number
  parentSessionId?: string
}
export type RecoveryLease = { epoch: string; generation: number; attemptId: string; acquiredAt: number }
export type RecoveryReceipt = { confirmedAt: number; messageId?: string; messageIds?: string[] }
export type RecoveryFailure = {
  kind: 'transient' | 'rate-limit' | 'unavailable' | 'permission' | 'identity' | 'target' | 'configuration'
  safeReason: string
  /** Milliseconds until another attempt is permitted. */
  retryAfter?: number
}
export type RecoveryRecord = {
  schemaVersion: 1
  deliveryId: string
  purpose: 'interruption-notice'
  target: ChannelKey
  accountIdentity: string
  accountIdentityConflict?: string[]
  boundAccountIdentity?: string
  principal: MatchableOrigin
  sourceParentSessionId?: string
  covers: RecoveryCoverage[]
  transferId: string
  recoveryGeneration: string
  templateVersion: 1
  locale: 'en'
  text: string
  createdAt: number
  generation: number
  state: 'pending' | 'leased' | 'delivered' | 'blocked' | 'suppressed'
  lease?: RecoveryLease
  attempts: number
  nextAttemptAt?: number
  receipt?: RecoveryReceipt
  failure?: RecoveryFailure
  suppression?: { reason: string; decisionId: string }
}

export const RECOVERY_NOTICE_TEXT =
  "⚠️ I restarted before I could confirm a reply to your earlier request. I didn't rerun it automatically — please ask again if you still need it."
const nonempty = z.string().min(1)
const timestamp = z.number().finite().nonnegative()
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const target = z
  .object({ adapter: z.enum(ADAPTER_IDS), workspace: z.string(), chat: nonempty, thread: z.string().nullable() })
  .strict()
const principal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tui'), sessionId: nonempty.optional() }).strict(),
  z.object({ kind: z.literal('cron'), jobId: nonempty.optional() }).strict(),
  z.object({ kind: z.literal('subagent'), subagent: nonempty.optional() }).strict(),
  z
    .object({
      kind: z.literal('channel'),
      adapter: z.enum(ADAPTER_IDS),
      workspace: z.string(),
      chat: nonempty,
      parentChat: nonempty.optional(),
      lastInboundAuthorId: nonempty.optional(),
    })
    .strict(),
])
const schema = z
  .object({
    schemaVersion: z.literal(1),
    deliveryId: z.string().regex(/^[a-f0-9]{64}$/),
    purpose: z.literal('interruption-notice'),
    target,
    accountIdentity: nonempty,
    accountIdentityConflict: z.array(nonempty).min(2).optional(),
    boundAccountIdentity: nonempty.optional(),
    principal,
    sourceParentSessionId: nonempty.optional(),
    covers: z
      .array(
        z
          .object({
            store: z.enum(['inventory', 'background', 'inbound']),
            id: nonempty,
            generation,
            parentSessionId: nonempty.optional(),
          })
          .strict(),
      )
      .min(1),
    transferId: nonempty,
    recoveryGeneration: nonempty,
    templateVersion: z.literal(1),
    locale: z.literal('en'),
    text: z.literal(RECOVERY_NOTICE_TEXT),
    createdAt: timestamp,
    generation,
    state: z.enum(['pending', 'leased', 'delivered', 'blocked', 'suppressed']),
    lease: z.object({ epoch: nonempty, generation, attemptId: nonempty, acquiredAt: timestamp }).strict().optional(),
    attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    nextAttemptAt: timestamp.optional(),
    receipt: z
      .object({
        confirmedAt: timestamp,
        messageId: nonempty.optional(),
        messageIds: z.array(nonempty).min(1).optional(),
      })
      .strict()
      .optional(),
    failure: z
      .object({
        kind: z.enum(['transient', 'rate-limit', 'unavailable', 'permission', 'identity', 'target', 'configuration']),
        safeReason: nonempty.max(512),
        retryAfter: timestamp.optional(),
      })
      .strict()
      .optional(),
    suppression: z
      .object({ reason: nonempty.max(512), decisionId: nonempty })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const invalid = (message: string) => context.addIssue({ code: 'custom', message })
    if (new Set(record.covers.map((cover) => `${cover.store}:${cover.id}`)).size !== record.covers.length)
      invalid('Duplicate coverage')
    if (record.deliveryId !== recoveryDeliveryId(record)) invalid('Delivery identity mismatch')
    if (
      record.boundAccountIdentity !== undefined &&
      (record.accountIdentity !== 'unbound-legacy' || record.boundAccountIdentity === 'unbound-legacy')
    )
      invalid('Invalid legacy account binding')
    if (
      record.accountIdentityConflict !== undefined &&
      (record.accountIdentity !== 'unbound-legacy' ||
        record.accountIdentityConflict.some(
          (identity, index, identities) =>
            identity === 'unbound-legacy' || (index > 0 && identities[index - 1]! >= identity),
        ))
    )
      invalid('Invalid account identity conflict')
    if (record.state === 'leased' && (!record.lease || record.lease.generation !== record.generation))
      invalid('Invalid lease ownership')
    if (record.lease && (record.lease.generation > record.generation || record.attempts === 0))
      invalid('Invalid lease generation')
    if (record.attempts >= record.generation) invalid('Attempts exceed ownership generation')
    if (record.state === 'delivered' && (!record.lease || record.lease.generation !== record.generation))
      invalid('Invalid delivered ownership')
    if ((record.state === 'leased' || record.state === 'delivered') && record.failure)
      invalid('Failure on active or delivered record')
    if (record.failure && record.attempts === 0) invalid('Failure before dispatch attempt')
    if (
      record.state === 'blocked' &&
      record.failure &&
      !['permission', 'identity', 'target', 'configuration'].includes(record.failure.kind)
    )
      invalid('Transient failure cannot block')
    if (record.receipt && !record.lease) invalid('Receipt without dispatch ownership')
    if (record.state === 'delivered' && !record.receipt) invalid('Missing delivery receipt')
    if (record.receipt && record.state !== 'delivered' && record.state !== 'suppressed')
      invalid('Receipt on unresolved record')
    if (record.state === 'blocked' && !record.failure) invalid('Missing blocked failure')
    if ((record.state === 'pending' || record.state === 'blocked') && record.lease) invalid('Lease on unclaimed record')
    if ((record.state === 'suppressed') !== !!record.suppression) invalid('Invalid suppression state')
    if (record.nextAttemptAt !== undefined && record.state !== 'pending' && record.state !== 'blocked')
      invalid('Retry on terminal or leased record')
  })

type DeliveryIdentity = Pick<RecoveryRecord, 'purpose' | 'target' | 'accountIdentity' | 'covers' | 'recoveryGeneration'>
export function recoveryDeliveryId(record: DeliveryIdentity): string {
  const covers = record.covers
    .map((cover) => [cover.store, cover.id, cover.generation, cover.parentSessionId ?? null])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha256')
    .update(
      JSON.stringify([
        'typeclaw:recovery:v1',
        record.purpose,
        [record.target.adapter, record.target.workspace, record.target.chat, record.target.thread],
        record.accountIdentity,
        covers,
        record.recoveryGeneration,
      ]),
    )
    .digest('hex')
}
export function validateRecoveryRecord(value: unknown): value is RecoveryRecord {
  return schema.safeParse(value).success
}
export function parseRecoveryRecord(value: unknown): RecoveryRecord {
  return schema.parse(value) as RecoveryRecord
}

/** Stable comparison of the frozen transfer payload, excluding dispatch state. */
export function recoveryPayload(record: RecoveryRecord): string {
  return JSON.stringify([
    record.deliveryId,
    record.purpose,
    record.target.adapter,
    record.target.workspace,
    record.target.chat,
    record.target.thread,
    record.accountIdentity,
    record.accountIdentityConflict ?? null,
    canonical(record.principal),
    record.sourceParentSessionId ?? null,
    record.covers.map(canonical).sort(),
    record.transferId,
    record.recoveryGeneration,
    record.templateVersion,
    record.locale,
    record.text,
    record.createdAt,
  ])
}
function canonical(value: object): string {
  return JSON.stringify(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}
