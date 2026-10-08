import type { MatchableOrigin } from '../permissions/resolve'
import {
  LIVE_TURN_ENDED_NOTICE_TEXT,
  parseRecoveryRecord,
  RECOVERY_NOTICE_TEXT,
  recoveryDeliveryId,
} from './continuity-types'
import type { RecoveryNoticeCause, RecoveryRecord } from './continuity-types'
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

/**
 * Freezes a transfer at preparation. `restart` (the default) is the RFC en/v1 boot-recovery
 * notice, byte- and ID-identical to every record written before causes existed. Same-process
 * abandonment passes `live-turn-ended`, which never asserts a restart.
 */
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
  > & { createdAt?: number; sourceParentSessionId?: string; cause?: RecoveryNoticeCause },
): RecoveryRecord {
  const source = {
    target: input.target,
    accountIdentity: input.accountIdentity,
    ...(input.accountIdentityConflict !== undefined ? { accountIdentityConflict: input.accountIdentityConflict } : {}),
    principal: input.principal,
    covers: input.covers,
    recoveryGeneration: input.recoveryGeneration,
    transferId: input.transferId,
    ...(input.sourceParentSessionId !== undefined ? { sourceParentSessionId: input.sourceParentSessionId } : {}),
  }
  const template =
    input.cause === 'live-turn-ended'
      ? {
          schemaVersion: 2 as const,
          purpose: 'interruption-notice' as const,
          cause: 'live-turn-ended' as const,
          templateVersion: 1 as const,
          locale: 'en' as const,
          text: LIVE_TURN_ENDED_NOTICE_TEXT,
        }
      : {
          schemaVersion: 1 as const,
          purpose: 'interruption-notice' as const,
          templateVersion: 1 as const,
          locale: 'en' as const,
          text: RECOVERY_NOTICE_TEXT,
        }
  const record = {
    ...source,
    ...template,
    createdAt: input.createdAt ?? Date.now(),
    generation: 1,
    state: 'pending' as const,
    attempts: 0,
  }
  return parseRecoveryRecord({ ...record, deliveryId: recoveryDeliveryId(record) })
}
