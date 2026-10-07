import type { MatchableOrigin } from '../permissions/resolve'
import { parseRecoveryRecord, RECOVERY_NOTICE_TEXT, recoveryDeliveryId } from './continuity-types'
import type { RecoveryRecord } from './continuity-types'
import { channelKeyId } from './types'
import type { ChannelKey } from './types'

const canonicalPrincipal = (principal: MatchableOrigin) =>
  Object.entries(principal)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))

/** Frozen principals compare by content; persisted key order is a serialization detail. */
export function sameRecoveryPrincipal(left: MatchableOrigin, right: MatchableOrigin): boolean {
  return JSON.stringify(canonicalPrincipal(left)) === JSON.stringify(canonicalPrincipal(right))
}

/**
 * One interruption notice may cover only sources sharing destination, authenticated account,
 * frozen principal and captured effective parent (the `/stop` authority). Chat, text, turn
 * timing, the current mapping and the current adapter account are never grouping evidence.
 */
export function recoveryNoticePartitionKey(input: {
  target: ChannelKey
  accountIdentity: string
  principal: MatchableOrigin
  parentSessionId?: string
}): string {
  return JSON.stringify([
    channelKeyId(input.target),
    input.accountIdentity,
    canonicalPrincipal(input.principal),
    input.parentSessionId ?? null,
  ])
}

export function createRecoveryNotice(
  input: Pick<
    RecoveryRecord,
    | 'target'
    | 'accountIdentity'
    | 'accountIdentityConflict'
    | 'principal'
    | 'covers'
    | 'recoveryGeneration'
    | 'transferId'
  > & { createdAt?: number; sourceParentSessionId?: string },
): RecoveryRecord {
  const record = {
    target: input.target,
    accountIdentity: input.accountIdentity,
    ...(input.accountIdentityConflict !== undefined ? { accountIdentityConflict: input.accountIdentityConflict } : {}),
    principal: input.principal,
    covers: input.covers,
    recoveryGeneration: input.recoveryGeneration,
    transferId: input.transferId,
    ...(input.sourceParentSessionId !== undefined ? { sourceParentSessionId: input.sourceParentSessionId } : {}),
    schemaVersion: 1 as const,
    purpose: 'interruption-notice' as const,
    templateVersion: 1 as const,
    locale: 'en' as const,
    text: RECOVERY_NOTICE_TEXT,
    createdAt: input.createdAt ?? Date.now(),
    generation: 1,
    state: 'pending' as const,
    attempts: 0,
  }
  return parseRecoveryRecord({ ...record, deliveryId: recoveryDeliveryId(record) })
}
