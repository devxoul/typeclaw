import type { GitignoreConfig } from '@/config/config'

export const GITIGNORE_FILE = '.gitignore'

// Match scope for the untrack reconciler (src/git/reconcile-ignored.ts): when a
// tracked file later matches one of these, start() removes it from the index.
export const TRULY_IGNORED_PATTERNS = [
  '.gitstore/',
  '.env',
  '.env.local',
  'secrets.json',
  'auth.json',
  '.typeclaw/',
  'node_modules/',
  'packages/*/node_modules/',
  'workspace/',
  'public/',
  'mounts/',
  'Dockerfile',
  '.DS_Store',
] as const

// Gitignored but force-committed by TypeClaw (auto-backup, dreaming, channels).
// The reconciler MUST fail-closed and never untrack these, even if a custom
// git.ignore.append pattern (e.g. `**`) matches them — doing so would drop
// runtime-owned state out of git.
export const SYSTEM_MANAGED_ROOTS = ['sessions/', 'memory/', 'channels/', 'todo/', 'cron/'] as const

export function buildGitignore(config: GitignoreConfig = { append: [] }): string {
  const customEntries = renderCustomGitignoreEntries(config.append)

  return `${customEntries}# Truly ignored: secrets, runtime junk, the agent's free-write zone, the
# relocated monorepo-member git DB, and regenerated-on-every-start system files.
# Never enter git history.
#
# Dockerfile is rewritten from the typeclaw CLI template on every \`typeclaw
# start\` (see src/init/dockerfile.ts), so tracking it would only produce
# noisy "Update Dockerfile" commits whenever the template changes. Treat it
# like node_modules/ — reproducible from source, not part of agent state.
#
# auth.json is the pre-rename name for secrets.json; kept here permanently
# as a safety net so an agent folder cloned from a pre-rename machine never
# stages credentials by accident.
#
# .typeclaw/ is the agent's local-scratch dir. It holds the in-progress init
# checkpoint (.typeclaw/init-progress.json, non-secret wizard selections for
# resume). Upgraded agents may also retain legacy .typeclaw/home/ credentials;
# the runtime no longer uses or migrates them, but they must remain ignored.
# Local-only; never commit.
${TRULY_IGNORED_PATTERNS.join('\n')}

# Local linked worktrees: ignored at the agent root, but not in the
# truly-ignored reconciler. Existing tracked .worktrees/ project files must
# remain tracked when start() refreshes this template.
/.worktrees/

# System-managed: gitignored by default so the agent never stages them by hand,
# but TypeClaw force-commits them on its own schedule (sessions/ + todo/ via
# auto-backup, memory/ via the dreaming subagent). Treat them as runtime-owned,
# not agent-owned.
${SYSTEM_MANAGED_ROOTS.join('\n')}
`
}

function renderCustomGitignoreEntries(entries: string[]): string {
  if (entries.length === 0) return ''
  return `# Custom entries from typeclaw.json#git.ignore.append.
${entries.join('\n')}

`
}
