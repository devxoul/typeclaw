import { GITHUB_API_BASE, githubJsonHeaders } from '@/channels/adapters/github/auth-pat'
import type { GithubTokenCredential } from '@/channels/github-token-bridge'

export type ReviewAccountFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export async function verifyReviewTokenAccount(options: {
  token: string | undefined
  expectedAccountIdentity: string
  minted?: GithubTokenCredential
  fetchImpl?: ReviewAccountFetch
}): Promise<boolean> {
  if (!options.token) return false
  if (options.minted?.token === options.token && options.minted.accountIdentity !== undefined) {
    return options.minted.accountIdentity === options.expectedAccountIdentity
  }
  if (options.token.startsWith('ghs_')) return false
  const response = await (options.fetchImpl ?? fetch)(`${GITHUB_API_BASE}/user`, {
    headers: githubJsonHeaders(options.token),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) return false
  const user = (await response.json()) as { id?: unknown }
  return Number.isSafeInteger(user.id) && Number(user.id) > 0 && `github:${user.id}` === options.expectedAccountIdentity
}
