import type { OutboundCallback } from '@/channels/types'

// A captured callback may outlive adapter reload. Validate the account attached
// to this sender, not whichever replacement now occupies the router registry.
export function withOutboundAccount(
  send: OutboundCallback,
  accountIdentity: (workspace: string) => string | undefined,
): OutboundCallback {
  return (message) => {
    const expected = message.sendOptions?.expectedAccountIdentity
    if (expected !== undefined && accountIdentity(message.workspace) !== expected) {
      return Promise.resolve({
        ok: false as const,
        error: 'Adapter account identity changed',
        recoveryFailure: { kind: 'identity' as const, safeReason: 'adapter account identity changed' },
      })
    }
    return send(message)
  }
}
