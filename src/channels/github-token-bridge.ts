import { describeError } from './describe-error'
// Decoupled from ChannelRouter on purpose: minting a token for an arbitrary
// bash `gh` command is adjacent to channels but is not routing, and a global
// singleton would leak resolver state across tests. One instance is created in
// run/index.ts and threaded to both the plugin loader and the channel manager.

export type GithubTokenCredential = { token: string; accountIdentity?: string }
export type GithubTokenResolveResult =
  | ({ kind: 'token' } & GithubTokenCredential)
  | { kind: 'unavailable'; reason: string }

export type ResolveGithubTokenForRepo = (repoSlug: string) => Promise<GithubTokenResolveResult>

export type GithubTokenBridge = {
  resolveTokenForRepo: ResolveGithubTokenForRepo
  // True when a per-repo App-token minter is registered (only the GitHub App
  // adapter registers one). This is the non-secret "App auth with per-repo
  // minting is available" signal. App credentials are never seeded into the
  // process-wide GH_TOKEN, so brokered gh paths cannot rely on its prefix.
  hasAppTokenResolver: () => boolean
  getAppSelfLogin: () => string | null
  registerResolver: (
    resolver: (repoSlug: string) => Promise<GithubTokenCredential>,
    selfLogin?: () => string | null,
  ) => () => void
}

const NO_RESOLVER_REASON =
  'GitHub App token unavailable; the GitHub channel adapter is not running or failed to start. ' +
  'Check `typeclaw logs` and `secrets.json#channels.github`.'

export function createGithubTokenBridge(): GithubTokenBridge {
  let current: ((repoSlug: string) => Promise<GithubTokenCredential>) | null = null
  let currentSelfLogin: (() => string | null) | null = null

  return {
    resolveTokenForRepo: async (repoSlug) => {
      const resolver = current
      if (resolver === null) return { kind: 'unavailable', reason: NO_RESOLVER_REASON }
      try {
        const credential = await resolver(repoSlug)
        return { kind: 'token', ...credential }
      } catch (err) {
        return { kind: 'unavailable', reason: describeError(err) }
      }
    },
    hasAppTokenResolver: () => current !== null,
    getAppSelfLogin: () => currentSelfLogin?.() ?? null,
    registerResolver: (resolver, selfLogin) => {
      current = resolver
      currentSelfLogin = selfLogin ?? null
      return () => {
        // Only clear if still the active resolver: a stop() racing a newer
        // start() must not wipe the newer registration.
        if (current === resolver) {
          current = null
          currentSelfLogin = null
        }
      }
    },
  }
}
