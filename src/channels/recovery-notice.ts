import { parseRecoveryRecord, RECOVERY_NOTICE_TEXT, recoveryDeliveryId } from './continuity-types'
import type { RecoveryRecord } from './continuity-types'

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
