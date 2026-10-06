import type { GitCommandDecision, GitResolvers } from './git-command'

// Destination grant for `git push` by actors that lack the `gitExfil` bypass:
// the repos the operator configured for the GitHub channel
// (`channels.github.repos`) under App auth. The security plugin asks
// this module whether a push it would otherwise block targets a granted repo;
// github-cli-auth then re-resolves the same command to fund it and must land on
// the exact destination the grant authorized, or the push is refused.
//
// The grant authorizes publishing branch CONTENT to that repo. It is not a
// confidentiality control: git objects are not scanned for secrets.

export type GithubPushGrant = { repos: readonly string[] }
// `command` is what actually runs: the model's spelling is discarded so repo
// config (remote.<name>.push mappings with `+`, push.default=upstream,
// push.followTags, submodule recursion) and abbreviated tag names cannot widen a
// one-branch grant. A source that is not refs/heads/<branch> fails to resolve.
export type GrantedPush = { repoSlug: string; pushUrls: readonly string[]; command: string }
export type GrantedPushDecision = { kind: 'allow'; push: GrantedPush } | { kind: 'deny'; reason: string }

// One local branch name (or HEAD) pushed to the same-named remote branch.
// Excludes `src:dst` retargeting, `:dst` deletion, `+` force, reflog `@{`,
// `..` traversal, leading `-`, and tag/full refs.
const PLAIN_BRANCH = /^(?!-)(?!refs\/)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]+$/

export async function resolveGrantedPush(
  decision: GitCommandDecision,
  grant: GithubPushGrant,
  resolvers: Pick<GitResolvers, 'resolveCurrentBranch'>,
): Promise<GrantedPushDecision> {
  const provenance = decision.kind === 'inject' ? decision.pushProvenance : undefined
  const needsHead = provenance?.kind === 'configured-remote' && provenance.refspecs[0] === 'HEAD'
  let currentBranch: string | null = null
  if (needsHead) {
    try {
      currentBranch = await resolvers.resolveCurrentBranch(provenance.sourceCwd)
    } catch {
      currentBranch = null
    }
  }
  return authorizeGrantedPush(decision, grant, currentBranch)
}

export function authorizeGrantedPush(
  decision: GitCommandDecision,
  grant: GithubPushGrant,
  currentBranch: string | null = null,
): GrantedPushDecision {
  if (decision.kind !== 'inject' || decision.access !== 'write') {
    return deny('the push could not be resolved to a single GitHub repository')
  }
  const provenance = decision.pushProvenance
  if (provenance?.kind !== 'configured-remote' || !provenance.complete) {
    return deny('only a push through a configured remote of a resolvable checkout can use the grant')
  }
  const [repoSlug, ...extra] = provenance.repoSlugs.map(canonical)
  if (repoSlug === undefined || extra.length > 0) {
    return deny('the remote must point at exactly one GitHub repository')
  }
  if (!grant.repos.map(canonical).includes(repoSlug)) {
    return deny(`\`${repoSlug}\` is not listed in channels.github.repos`)
  }
  const [refspec, ...moreRefspecs] = provenance.refspecs
  if (refspec === undefined || moreRefspecs.length > 0 || !PLAIN_BRANCH.test(refspec)) {
    return deny('the grant covers pushing exactly one branch by name (e.g. `git -C <checkout> push <remote> <branch>`)')
  }
  const branch = refspec === 'HEAD' ? currentBranch : refspec
  if (branch === null || branch === 'HEAD' || !PLAIN_BRANCH.test(branch)) {
    return deny('`HEAD` must be a checked-out branch; name the branch explicitly')
  }
  const command = buildGrantedPushCommand({
    cwd: provenance.sourceCwd,
    remote: provenance.remote,
    branch,
    setUpstream: provenance.setUpstream,
  })
  return { kind: 'allow', push: { repoSlug, pushUrls: provenance.pushUrls, command } }
}

export function buildGrantedPushCommand(options: {
  cwd: string
  remote: string
  branch: string
  setUpstream: boolean
}): string {
  const ref = `refs/heads/${options.branch}`
  return [
    'git',
    '-C',
    quote(options.cwd),
    'push',
    '--no-follow-tags',
    '--recurse-submodules=no',
    ...(options.setUpstream ? ['--set-upstream'] : []),
    quote(options.remote),
    quote(`${ref}:${ref}`),
  ].join(' ')
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const grantedPushes = new Map<string, GrantedPush>()

export function recordGrantedPush(callId: string, push: GrantedPush): void {
  grantedPushes.set(callId, push)
}

export function takeGrantedPush(callId: string): GrantedPush | undefined {
  const push = grantedPushes.get(callId)
  grantedPushes.delete(callId)
  return push
}

export function matchesGrantedPush(decision: GitCommandDecision, granted: GrantedPush): boolean {
  if (decision.kind !== 'inject' || decision.access !== 'write') return false
  const provenance = decision.pushProvenance
  if (provenance?.kind !== 'configured-remote') return false
  const slugs = provenance.repoSlugs.map(canonical)
  return (
    slugs.length === 1 &&
    slugs[0] === granted.repoSlug &&
    provenance.pushUrls.length === granted.pushUrls.length &&
    provenance.pushUrls.every((url, index) => url === granted.pushUrls[index])
  )
}

function canonical(slug: string): string {
  return slug.toLocaleLowerCase().replace(/\.git$/i, '')
}

function deny(reason: string): GrantedPushDecision {
  return { kind: 'deny', reason }
}
