// `code` classifies a block so the caller can react structurally instead of
// string-matching the reason: only `missing-repo` is eligible for a trusted
// repo-fallback (origin/cwd) that turns the block into a mint; `composition`,
// `multi-owner`, `api-repo-conflict`, and `non-literal-repo` must stay blocks.
export type GhBlockCode =
  | 'missing-repo'
  | 'non-literal-repo'
  | 'composition'
  | 'multi-owner'
  | 'api-repo-conflict'
  | 'repo-selector-conflict'
  | 'credential-display'
  | 'credential-exposure'
  | 'pathname-expansion'

export type GhCommandDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; code: GhBlockCode; reason: string }
  // `rewrittenCommand`, when present, MUST replace the executed command: `gh api`
  // rejects `-R/--repo` ("unknown shorthand flag"), so for a graphql endpoint the
  // flag is consumed as our repo hint and stripped before exec. Other inject paths
  // (REST, non-`api` subcommands) leave the command unchanged and omit it.
  | { kind: 'inject'; repoSlug: string; rewrittenCommand?: string }

// Reached whenever no EFFECTIVE DESTINATION repo can be determined — which is not
// the same as "argv has no slug": `gh label clone owner/repo` names a literal SOURCE
// slug and still lands here because the destination is what a token would be scoped
// to. The message must not assert a multi-owner App (MULTI_OWNER_REASON below covers
// that, and a single-owner App hitting this text reports a cause that is simply false).
const MISSING_REPO_REASON =
  'TypeClaw could not determine the effective destination repository for this `gh` command, ' +
  'so it cannot mint a scoped installation token. Re-run as a single bare command that names a ' +
  'LITERAL `owner/repo` slug TypeClaw can read from argv — not a shell variable.'

const NON_LITERAL_REPO_REASON =
  'The `-R/--repo` value is not a literal `owner/repo` slug TypeClaw can verify. ' +
  'Shell variables like `-R "$repo"` are not readable by the static GitHub App token ' +
  'guard (it never expands the shell). Re-run as a single bare command with a literal ' +
  'repo: `gh <cmd> -R owner/repo`, or `gh api /repos/owner/repo/...`; only a trailing ' +
  'stdin-only reader pipeline such as `| jq ...` may follow.'

const MULTI_OWNER_REASON =
  'This command targets repos under more than one owner; a single GH_TOKEN cannot ' +
  'authenticate all of them. Split it into separate commands, one owner each.'

const API_REPO_CONFLICT_REASON =
  'This `gh api` call names a repo in its endpoint path that differs from its ' +
  '`-R/--repo` flag. `gh api` ignores `-R` for a literal `/repos/{owner}/{repo}` ' +
  'endpoint — the path is where the request actually goes — so the flag cannot be ' +
  'used to mint a token for one repo while hitting another. Drop the mismatched ' +
  '`-R`, or target the repo named in the path.'

const REPO_SELECTOR_CONFLICT_REASON =
  'This gh command names a repository in a positional selector or GitHub PR/issue URL that differs from its ' +
  'authorized `-R/--repo` or runtime repo hint. The positional selector is where gh actually sends the request, ' +
  'so TypeClaw will not mint a token for a different repository. Use matching repository selectors.'

const CREDENTIAL_DISPLAY_REASON =
  'GitHub authentication management and token-display commands are unavailable to model-driven bash. ' +
  'In particular, `gh auth token` and `gh auth status --show-token` would print the command-scoped credential. ' +
  'Use host-side authentication setup or a redacted diagnostic instead.'

const PATHNAME_EXPANSION_REASON =
  'An unquoted `*`, `?`, or `[` in a gh command is a shell pathname pattern: the shell could expand it into ' +
  'different arguments than the ones TypeClaw authorized, so no credential is minted for it. ' +
  "Quote the argument that contains it, e.g. `gh api '/repos/owner/repo/contents/path?ref=<sha>'`."

const CREDENTIAL_EXPOSURE_REASON =
  'This gh command is not in TypeClaw’s credential-safe allowlist. Model-driven gh receives a command-scoped credential only for operations whose argv cannot read arbitrary files, render process environment values, upload arbitrary files, select another host, or start extensions. Use a supported direct gh operation, a first-class TypeClaw tool, or run this command host-side.'

// A gh segment can legitimately touch more than one repo (a `gh api` compare
// endpoint references both the base repo and a cross-fork head). The classifier
// returns EVERY effective target so analyzeGhCommand can allowlist-check and
// same-owner-check all of them — a single-slug return is what let a literal
// `gh api /repos/x/y` path slip past an `-R`-derived check.
type GhSegmentDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; code: GhBlockCode; reason: string }
  // `stripRepoFlag` marks a graphql inject whose `-R/--repo` is a TypeClaw-only
  // hint that `gh api` would reject, so it must be removed from the command.
  | { kind: 'inject'; repoSlugs: readonly string[]; stripRepoFlag?: boolean }

const COMPOSITION_REASON =
  'Allowed shape: a single bare `gh <cmd> -R owner/repo` (or `gh api /repos/owner/repo/...`) ' +
  'with a LITERAL repo slug, optionally followed by a trailing stdin-only reader pipeline ' +
  'such as `| jq ...`. ' +
  'A repo-targeting `gh` command receives a minted GitHub App token in its process ' +
  'environment, so it must run as a single bare `gh` command — no `;`, `&&`, `||`, `&`, ' +
  'newlines, redirections, command/process substitution, subshells, heredocs, or unquoted ' +
  '`$` expansion (any sibling process or expansion would inherit the token and could ' +
  'exfiltrate it). One exception is allowed: a trailing reader pipeline `gh … | <reader>` ' +
  'where every downstream stage is a stdin-only reader (`jq`, `grep`, `cat`, `wc`, `sort`, `uniq`) ' +
  'with no file operand — e.g. `gh api repos/o/r | jq .`. jq/JSON metacharacters are also ' +
  "fine INSIDE single quotes, e.g. `gh api repos/o/r --jq '.[] | {id}'`. File-backed " +
  '`--input`, `--body-file`, templates, aliases, extensions, and auth/config commands remain unavailable.'

// Shell-active metacharacters that, OUTSIDE single quotes, either spawn another
// process sharing the shell env (where the minted GH_TOKEN lives) or expand
// shell state into an argument. `|;&` = pipeline/sequence/background; newline/CR
// = command separators; `()` `{}` = subshell/group; `<>` = redirection
// (incl. bash /dev/tcp networking and heredocs); backtick + `$` = command/
// parameter/arithmetic substitution (covers `$(`, `${`, `$((`, and a bare
// `$GH_TOKEN`). Single quotes make all of these literal, so jq pipes and JSON
// braces are allowed when single-quoted. Double quotes do NOT neutralize `$`
// or backticks, so they are treated as active.
const SHELL_ACTIVE_METACHARS = new Set(['|', ';', '&', '\n', '\r', '(', ')', '{', '}', '<', '>', '`', '$'])

// Returns true iff `command` is a single simple `gh ...` command: the first
// non-whitespace word is `gh`, and no shell-active metachar appears outside
// single quotes. This is the gate for token injection — see COMPOSITION_REASON.
function isSingleBareGhCommand(command: string): boolean {
  const trimmed = command.trimStart()
  if (!/^gh(\s|$)/.test(trimmed)) return false

  let quote: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === undefined) continue
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      // Inside double quotes `$` and backtick still expand; only `"` closes.
      if (ch === '"') quote = null
      else if (ch === '$' || ch === '`') return false
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (SHELL_ACTIVE_METACHARS.has(ch)) return false
  }
  return quote === null
}

function containsUnquotedPathnameExpansion(command: string): boolean {
  let quote: '"' | "'" | null = null
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '*' || ch === '?' || ch === '[') return true
  }
  return false
}

// GENUINELY repo-less subcommands (account/global, no -R/--repo): they need no
// token injection and pass through. The set is intentionally minimal —
// anything not listed (label, ruleset, secret, variable, cache, run, workflow,
// release, browse, pr, issue, repo, ...) is repo-scoped and falls through to
// the block-unless-explicit-repo rule, so an App-auth `gh label list` cannot
// silently run with the wrong installation token. Classification verified
// against gh source (commands using cmdutil.EnableRepoOverride are repo-scoped).
// `gh api` is handled separately (path-based repo extraction).
const REPO_LESS_SUBCOMMANDS = new Set([
  'auth',
  'config',
  'extension',
  'alias',
  'completion',
  'gpg-key',
  'ssh-key',
  'status',
  'org',
  'gist',
  'codespace',
  'search',
  'preview',
  'accessibility',
  'attestation',
])

// A single GH_TOKEN is injected into the whole bash command's env, so every
// `gh` in a compound command shares it. That is correct only when all
// repo-targeting `gh` invocations resolve to the same owner (one App
// installation). We therefore inspect EVERY `gh` invocation, not just the
// first: a repo-targeting `gh` with no resolvable repo blocks (missing-repo),
// and invocations spanning more than one owner block (multi-owner).
// `fallbackRepo`, when supplied, is a TRUSTED literal `owner/repo` the CALLER
// resolved from a non-command source (GitHub session origin or the cwd git
// remote) and already allowlist-checked. It fills in for a repo-less non-`api`
// segment that would otherwise block `missing-repo`, so a bare `gh label list`
// can mint. It deliberately flows through the SAME multi-owner + single-bare
// composition gates below, so a compound command still blocks even with a
// fallback (the token would leak to siblings). It NEVER overrides an explicit
// `-R`/path repo, and is NOT applied to `non-literal-repo` (a `$var` the user
// wrote) or `gh api` (path is authoritative).
export function analyzeGhCommand(command: string, fallbackRepo?: string): GhCommandDecision {
  if (containsReviewGraphqlMutation(command)) {
    return { kind: 'block', code: 'credential-exposure', reason: CREDENTIAL_EXPOSURE_REASON }
  }
  const tokens = tokenize(command)
  const ghStarts = findGhInvocations(tokens)
  if (ghStarts.length === 0) return { kind: 'pass-through' }
  if (containsUnquotedPathnameExpansion(command)) {
    return { kind: 'block', code: 'pathname-expansion', reason: PATHNAME_EXPANSION_REASON }
  }

  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    if (isCredentialDisplayOrManagement(tokens.slice(start + 1, end))) {
      return { kind: 'block', code: 'credential-display', reason: CREDENTIAL_DISPLAY_REASON }
    }
  }

  const repoSlugs: string[] = []
  let stripRepoFlag = false
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    const args = tokens.slice(start + 1, end)
    const segment = classifyGhSegment(args, fallbackRepo)
    if (segment.kind === 'block') return segment
    if (segment.kind === 'inject') {
      repoSlugs.push(...segment.repoSlugs)
      if (segment.stripRepoFlag === true) stripRepoFlag = true
    }
  }

  if (repoSlugs.length === 0) return { kind: 'pass-through' }
  const owners = new Set(repoSlugs.map((slug) => slug.split('/')[0]))
  if (owners.size > 1) return { kind: 'block', code: 'multi-owner', reason: MULTI_OWNER_REASON }

  const repoSlug = repoSlugs[0] as string

  // We would inject a token. The token lands in the shell env, so any sibling/
  // upstream/downstream process or shell expansion would inherit it. The single-
  // bare-`gh` shape is the safe baseline; a trailing reader pipeline (`gh | jq`)
  // is the one exception we allow, under strict conditions (see analyzeReaderPipeline).
  if (isSingleBareGhCommand(command)) {
    if (!isCredentialSafeGhCommand(command)) {
      return { kind: 'block', code: 'credential-exposure', reason: CREDENTIAL_EXPOSURE_REASON }
    }
    if (stripRepoFlag) return { kind: 'inject', repoSlug, rewrittenCommand: stripRepoFlagFromCommand(command) }
    return { kind: 'inject', repoSlug }
  }

  const piped = analyzeReaderPipeline(command, stripRepoFlag)
  if (piped !== null) {
    if (!isCredentialSafeGhCommand(command)) {
      return { kind: 'block', code: 'credential-exposure', reason: CREDENTIAL_EXPOSURE_REASON }
    }
    return { kind: 'inject', repoSlug, rewrittenCommand: piped }
  }

  return { kind: 'block', code: 'composition', reason: COMPOSITION_REASON }
}

function isCredentialDisplayOrManagement(args: readonly string[]): boolean {
  if (args[0] !== 'auth') return false
  const subcommand = args[1]
  if (subcommand === 'token') return true
  if (subcommand === 'status') {
    return args.some(isAuthStatusTokenDisplayFlag)
  }
  return subcommand !== undefined && new Set(['login', 'logout', 'refresh', 'switch', 'setup-git']).has(subcommand)
}

function isAuthStatusTokenDisplayFlag(arg: string): boolean {
  if (arg === '--show-token' || arg.startsWith('--show-token=')) return true
  if (!arg.startsWith('-') || arg.startsWith('--')) return false
  return arg.slice(1).split('=', 1)[0]?.includes('t') === true
}

export function canInjectPatIntoPassThroughGh(command: string): boolean {
  if (containsReviewGraphqlMutation(command)) return false
  if (hasUnsafeGhStageBackslash(command)) return false
  if (!isSingleBareGhCommand(command)) return false
  const tokens = tokenize(command)
  const starts = findGhInvocations(tokens)
  if (starts.length !== 1 || starts[0] !== 0) return false
  const args = tokens.slice(1)
  if (isCredentialDisplayOrManagement(args)) return false
  const subcommand = args[0]
  if (subcommand === 'alias' || subcommand === 'extension' || subcommand === 'config') return false
  if (subcommand === 'auth') return args[1] === 'status'
  return isCredentialSafeGhArgs(args)
}

function containsReviewGraphqlMutation(command: string): boolean {
  const tokens = tokenize(command)
  const ghStarts = findGhInvocations(tokens)
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    const args = tokens.slice(start + 1, end)
    if (!isGraphqlEndpoint(args)) continue
    if (extractGraphqlQueries(args).some((query) => REVIEW_GRAPHQL_MUTATION.test(query))) return true
  }
  return false
}

const REVIEW_GRAPHQL_MUTATION =
  /\b(?:addPullRequestReview|submitPullRequestReview|addPullRequestReviewComment|addPullRequestReviewThread|addPullRequestReviewThreadReply)\b/

const GRAPHQL_FIELD_FLAGS = new Set(['-f', '--raw-field', '-F', '--field'])

function extractGraphqlQueries(args: readonly string[]): string[] {
  const queries: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (GRAPHQL_FIELD_FLAGS.has(arg)) {
      const field = args[i + 1]
      if (field !== undefined) {
        addGraphqlQuery(queries, field)
        i += 1
      }
      continue
    }
    for (const prefix of ['--raw-field=', '--field=', '-f', '-F']) {
      if (arg.startsWith(prefix)) {
        const field = arg.slice(prefix.length)
        addGraphqlQuery(queries, field.startsWith('=') ? field.slice(1) : field)
        break
      }
    }
  }
  return queries
}

function addGraphqlQuery(queries: string[], field: string): void {
  if (field.startsWith('query=')) queries.push(field.slice('query='.length))
}

const SAFE_GH_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  api: new Set(['']),
  pr: new Set([
    'view',
    'list',
    'status',
    'checks',
    'diff',
    'review',
    'comment',
    'close',
    'reopen',
    'ready',
    'merge',
    'edit',
    'create',
  ]),
  issue: new Set(['view', 'list', 'status', 'comment', 'close', 'reopen', 'create']),
  label: new Set(['list', 'create', 'edit', 'delete', 'clone']),
  release: new Set(['view', 'list']),
  gist: new Set(['list']),
  repo: new Set(['view', 'list']),
  run: new Set(['view', 'list', 'watch', 'cancel', 'rerun', 'delete']),
  workflow: new Set(['view', 'list', 'run', 'enable', 'disable']),
  ruleset: new Set(['view', 'list', 'check']),
  cache: new Set(['list', 'delete']),
  variable: new Set(['list', 'get', 'set', 'delete']),
  secret: new Set(['list', 'delete']),
}

const CREDENTIAL_UNSAFE_FLAGS = new Set([
  '--input',
  '--template',
  '-t',
  '--hostname',
  '--body-file',
  '--web',
  '--delete-branch',
])

// `gh pr edit` field flags whose values are inline argv strings. Every one is a
// label/login/name/free-text operand — none names a file, a host, or a template,
// so they satisfy the same credential-safety criterion as `gh pr comment --body`.
// `-F`/`--body-file` (file read) and `-t` (template) are excluded here and denied
// by CREDENTIAL_UNSAFE_FLAGS and the api-field scoping above.
const PR_EDIT_FIELD_FLAGS = new Set([
  '--add-label',
  '--remove-label',
  '--add-assignee',
  '--remove-assignee',
  '--add-reviewer',
  '--remove-reviewer',
  '--add-project',
  '--remove-project',
  '--remove-milestone',
])

const PR_EDIT_IDENTIFIER_FLAGS = new Set([...PR_EDIT_FIELD_FLAGS, '--milestone', '--base'])
const PR_EDIT_TEXT_FLAGS = new Set(['--title', '--body', '-b'])

const CREDENTIAL_SAFE_FLAGS = new Set([
  '-R',
  '--repo',
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '-i',
  '--include',
  '--paginate',
  '--slurp',
  '--cache',
  '--silent',
  '--verbose',
  '--version',
  '--help',
  '--json',
  '--jq',
  '-q',
  '--comments',
  '--checks',
  '--files',
  '--commits',
  '--body',
  '-b',
  '--title',
  '--approve',
  '--request-changes',
  '--comment',
  '--merge',
  '--squash',
  '--rebase',
  '--admin',
  '--auto',
  '--match-head-commit',
  '--subject',
  '--limit',
  '-L',
  '--state',
  '--author',
  '--assignee',
  '--label',
  '--milestone',
  '--search',
  '--base',
  '--head',
  '--draft',
  '--name',
  '--color',
  '--description',
  '--force',
  '--confirm',
  '--branch',
  '--event',
  ...PR_EDIT_FIELD_FLAGS,
])

function isCredentialSafeGhCommand(command: string): boolean {
  const stages = splitTopLevelPipeStages(command)
  if (stages === null || stages.length === 0) return false
  const ghStage = (stages[0] as string).trim()
  if (!isSingleBareGhCommand(ghStage) || hasUnsafeGhStageBackslash(ghStage)) return false
  const tokens = tokenize(ghStage)
  return tokens[0] === 'gh' && isCredentialSafeGhArgs(tokens.slice(1))
}

// Flag NAMES are scoped by Cobra command, so a name-only allowlist is not a
// flag allowlist. `-F` is `--field` for `gh api`/`gh workflow run`, but Cobra
// binds it to `--body-file` on every pr/issue command in SAFE_GH_OPERATIONS:
// `gh pr comment 1 -R o/r -F /proc/self/environ` reads the minted token out of
// gh's own environ and posts it to a public comment thread. The long `--body-file`
// was denied while its short alias walked straight through the same allowlist.
// `-f` keeps its `gh label create/clone` `--force` meaning — the same command
// scoping `ghFlagTakesValue` already applies when finding positionals.
const API_FIELD_FLAGS = new Set(['-f', '--raw-field', '-F', '--field'])

function acceptsApiFieldFlag(command: string, flag: string): boolean {
  if (command === 'api' || command === 'workflow') return true
  return flag === '-f' && command === 'label'
}

function isCredentialSafeGhArgs(args: readonly string[]): boolean {
  const parsed = parseGhArgs(args)
  if (parsed === null) return false
  const { command, operation } = parsed
  if (command === 'api') {
    const endpoint = findApiEndpoint(args)
    if (endpoint === null || endpoint.includes('://')) return false
  }
  if (!SAFE_GH_OPERATIONS[command]?.has(operation)) return false
  if ((command === 'issue' || command === 'pr') && operation === 'create' && !isSafeCreateArgs(command, args)) {
    return false
  }
  if (command === 'pr' && operation === 'edit' && !isSafePrEditArgs(args)) {
    return false
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (CREDENTIAL_UNSAFE_FLAGS.has(flag)) return false
    if (flag.endsWith('-file') || flag.endsWith('-file-name')) return false
    if (arg.startsWith('-') && !CREDENTIAL_SAFE_FLAGS.has(flag)) return false
    if (API_FIELD_FLAGS.has(flag) && !acceptsApiFieldFlag(command, flag)) return false
    if ((command === 'api' || command === 'workflow') && API_FIELD_FLAGS.has(flag)) {
      const value = flagValue(args, i)
      if (value === null || fieldDereferencesFile(value)) return false
    }
    if (flag === '--jq' || flag === '-q') {
      const filter = flagValue(args, i)
      if (filter === null || !isSafeGhJqFilter(filter)) return false
    }
  }
  return true
}

function isSafeCreateArgs(command: 'issue' | 'pr', args: readonly string[]): boolean {
  if (extractRepoFlag(args) === null) return false
  const title = findFlagValue(args, ['--title'])
  const body = findFlagValue(args, ['--body', '-b'])
  if (title === null || title.trim() === '' || body === null || body.trim() === '') return false
  if (title.startsWith('@') || body.startsWith('@')) return false

  const forbidden = new Set([
    '--body-file',
    '--template',
    '--editor',
    '--web',
    '--recover',
    '--fill',
    '--fill-first',
    '--fill-verbose',
  ])
  if (args.some((arg) => forbidden.has(arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg))) return false
  if (command === 'pr' && !hasExplicitPrRefs(args)) return false
  return true
}

// Without `--head`, `gh pr create` interrogates the checkout and offers to push
// or fork, running git with the minted token in its environment. An explicit
// head (plus `--repo`, required above) keeps gh to read-only remote/config
// lookups that tolerate running outside any checkout. gh's flag parser keeps
// the LAST value of a repeated flag, so a later `--head=` or `-H ''` would
// silently empty the head this check saw first: repeats are refused outright.
const PR_CREATE_REF_FLAGS: readonly (readonly string[])[] = [
  ['--head', '-H'],
  ['--base', '-B'],
  ['--repo', '-R'],
  ['--title', '-t'],
  ['--body', '-b'],
]

function hasExplicitPrRefs(args: readonly string[]): boolean {
  for (const names of PR_CREATE_REF_FLAGS) {
    const occurrences = args.filter((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)))
    if (occurrences.length > 1) return false
  }
  const head = findFlagValue(args, ['--head', '-H'])
  const base = findFlagValue(args, ['--base', '-B'])
  if (head === null || head.trim() === '' || base === null || base.trim() === '') return false
  return !head.startsWith('@') && !base.startsWith('@')
}

// `gh pr edit` with no field flag drops into an interactive survey and spawns
// $EDITOR for the body — a child process that inherits the minted token, the
// same shape `gh pr merge --delete-branch` is denied for. Requiring at least one
// recognized inline field flag keeps the invocation non-interactive. Identifier
// operands additionally reject `@` values, mirroring isSafeCreateArgs; `--title`
// and `--body` are free text where a leading `@mention` is legitimate and gh
// performs no file dereference.
function isSafePrEditArgs(args: readonly string[]): boolean {
  let hasField = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('-')) continue
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    const isIdentifierField = PR_EDIT_IDENTIFIER_FLAGS.has(flag)
    if (!isIdentifierField && !PR_EDIT_TEXT_FLAGS.has(flag)) continue
    hasField = true
    if (flag === '--remove-milestone') continue
    const value = flagValue(args, i)
    if (value === null || value.trim() === '') return false
    if (isIdentifierField && value.startsWith('@')) return false
  }
  return hasField
}

function findFlagValue(args: readonly string[], names: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    for (const name of names) {
      if (arg === name) return args[i + 1] ?? null
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    }
  }
  return null
}

function flagValue(args: readonly string[], index: number): string | null {
  const arg = args[index] as string
  const separator = arg.indexOf('=')
  return separator >= 0 ? arg.slice(separator + 1) : (args[index + 1] ?? null)
}

function fieldDereferencesFile(value: string): boolean {
  const separator = value.indexOf('=')
  return separator < 1 || value.slice(separator + 1).startsWith('@')
}

function isSafeGhJqFilter(filter: string): boolean {
  return !/(^|[^A-Za-z0-9_])env([^A-Za-z0-9_]|$)|\$ENV\b|input_filename|modulemeta/.test(filter)
}

// stdin-only readers whose only sink is stdout (back to the agent, who already
// has gh's output) — they cannot open their own network/file/process sink, so a
// `gh <repo> | <reader>` pipeline cannot exfiltrate the minted token to a third
// party. EXCLUDED on purpose: awk (system()/getline|cmd/inet), sed (GNU `e`
// shell-exec), tee/xargs (write/spawn), less (`!cmd`), and head/tail (their
// file-operand forms are too easy to abuse and not worth the parser risk yet).
// grep is admitted through a dedicated grammar that requires a pattern and
// proves there is no file operand or pattern-file/recursive option.
const READER_ALLOWLIST = new Set(['jq', 'grep', 'cat', 'wc', 'sort', 'uniq'])

// STRICT per-command flag allowlists. We allow ONLY flags known to be pure
// stdin-shaping (no file/program operand). This is allow-known-good, not
// deny-known-bad: coreutils exposes file reads AND code execution as FLAGS, not
// just operands — `wc --files0-from=F` and `sort --files0-from=F` open a file
// with no positional, and `sort --compress-program=PROG` execs a helper. Any
// such flag would let a downstream "reader" open `/proc/<pid>/environ` and
// recover the sibling token. So an unrecognized flag REJECTS the whole stage.
// jq is excluded here (its filter is a positional, handled separately).
const READER_BOOLEAN_FLAGS: Record<string, ReadonlySet<string>> = {
  cat: new Set(['-n', '--number', '-b', '--number-nonblank', '-s', '--squeeze-blank', '-A', '--show-all', '-E', '-T']),
  wc: new Set(['-l', '--lines', '-c', '--bytes', '-m', '--chars', '-w', '--words', '-L', '--max-line-length']),
  sort: new Set(['-r', '--reverse', '-n', '--numeric-sort', '-u', '--unique', '-f', '--ignore-case', '-b', '-g', '-h']),
  uniq: new Set(['-c', '--count', '-d', '--repeated', '-u', '--unique', '-i', '--ignore-case']),
}

// jq is validated allow-known-good, exactly like the coreutils readers: only
// known stdin-shaping flags pass; anything else rejects the stage. Exact-token
// deny-listing was unsound — `-f/proc/self/environ`, `-L/proc`, and clustered
// `-rf/proc/...` short forms slipped past a `Set.has(token)` check and reopened
// the file-read path. jq accepts NO `--flag=value` form (value flags take the
// value as a SEPARATE token), so long flags are matched as whole tokens.

// Safe boolean LONG flags: output/parse shaping only, no value, no file/module.
const JQ_SAFE_BOOLEAN_LONG = new Set([
  '--raw-output',
  '--raw-output0',
  '--compact-output',
  '--slurp',
  '--null-input',
  '--exit-status',
  '--ascii-output',
  '--sort-keys',
  '--raw-input',
  '--join-output',
  '--color-output',
  '--monochrome-output',
  '--binary',
  '--tab',
  '--unbuffered',
  '--stream',
  '--stream-errors',
  '--seq',
])

// Safe LONG flags that consume a fixed number of FOLLOWING tokens, none a file:
// --arg/--argjson take 2 (name, value), --indent takes 1 (a number).
const JQ_SAFE_VALUE_LONG: Record<string, number> = {
  '--arg': 2,
  '--argjson': 2,
  '--indent': 1,
}

// Safe boolean SHORT flags (single chars). A clustered short token like `-rc`
// is allowed iff EVERY char is in this set. `f` (filter-from-file) and `L`
// (module path) are the fatal ones — and any unknown char also rejects.
const JQ_SAFE_BOOLEAN_SHORT = new Set(['r', 'c', 's', 'n', 'e', 'a', 'S', 'R', 'j', 'C', 'M', 'b'])

const GREP_SAFE_BOOLEAN_LONG = new Set([
  '--basic-regexp',
  '--extended-regexp',
  '--fixed-strings',
  '--ignore-case',
  '--invert-match',
  '--line-number',
  '--count',
  '--only-matching',
  '--quiet',
  '--silent',
  '--word-regexp',
  '--line-regexp',
])
const GREP_SAFE_BOOLEAN_SHORT = new Set(['E', 'F', 'G', 'i', 'v', 'n', 'c', 'o', 'q', 'w', 'x'])

// A reader stage is safe only if it is an allowlisted command using ONLY its
// known stdin-shaping flags, with no file operand. Backslashes are rejected
// outright: our tokenizer does not model shell backslash escaping, so a
// `jq \--from-file=…` would be seen as a harmless positional here but reach bash
// as the forbidden flag — an allowlist-bypass. Rejecting `\` closes that gap.
function isStdinOnlyReaderStage(stage: string): boolean {
  if (containsShellActiveMetachar(stage)) return false
  const tokens = splitStageTokens(stage)
  const cmd = tokens[0]
  if (cmd === undefined || !READER_ALLOWLIST.has(cmd)) return false

  if (cmd === 'jq') return !hasUnsafeJqStageBackslash(stage) && isStdinOnlyJqStage(tokens)
  if (stage.includes('\\')) return false
  if (cmd === 'grep') return isStdinOnlyGrepStage(tokens)

  const allowedFlags = READER_BOOLEAN_FLAGS[cmd]
  if (allowedFlags === undefined) return false
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string
    if (!tok.startsWith('-')) return false
    if (!allowedFlags.has(tok)) return false
  }
  return true
}

// grep reads stdin only when its argv contains one positional pattern OR one or
// more -e/--regexp patterns, followed by no positional file operands. Keep the
// option surface intentionally small: unknown options fail closed, especially
// -f/--file, recursive traversal, and include/exclude selectors.
function isStdinOnlyGrepStage(tokens: readonly string[]): boolean {
  let patternCount = 0
  let usesRegexpFlag = false
  let sawPositionalPattern = false
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string
    if (tok === '--') return false
    if (sawPositionalPattern && tok.startsWith('-')) return false
    if (tok === '-e' || tok === '--regexp') {
      if (sawPositionalPattern) return false
      const pattern = tokens[i + 1]
      if (pattern === undefined) return false
      patternCount += 1
      usesRegexpFlag = true
      i += 1
      continue
    }
    if (tok.startsWith('--regexp=')) {
      if (sawPositionalPattern) return false
      patternCount += 1
      usesRegexpFlag = true
      continue
    }
    if (tok.startsWith('--')) {
      if (!GREP_SAFE_BOOLEAN_LONG.has(tok)) return false
      continue
    }
    if (tok.startsWith('-') && tok.length > 1) {
      const shortOptions = tok.slice(1)
      for (let shortIndex = 0; shortIndex < shortOptions.length; shortIndex++) {
        const ch = shortOptions[shortIndex] as string
        if (ch === 'e') {
          if (sawPositionalPattern) return false
          patternCount += 1
          usesRegexpFlag = true
          // grep treats `e` as a value-taking terminal option: the rest of the
          // cluster is its pattern (`-neerror`), or the next token is (`-ne x`).
          // No later cluster character can therefore become another option.
          if (shortIndex + 1 < shortOptions.length) break
          const pattern = tokens[i + 1]
          if (pattern === undefined) return false
          i += 1
          break
        }
        if (!GREP_SAFE_BOOLEAN_SHORT.has(ch)) return false
      }
      continue
    }
    if (usesRegexpFlag || patternCount > 0) return false
    patternCount = 1
    sawPositionalPattern = true
  }
  return patternCount > 0
}

// jq must run pure-stdin: only known stdin-shaping flags, and EXACTLY one
// positional (the filter). A second positional is an input FILE jq would open
// (`jq . /proc/self/environ` reads that file), so it is rejected. The filter is
// additionally screened for `import`/`include`, which load modules from jq's
// default search path even without `-L` — another file-read vector.
function isStdinOnlyJqStage(tokens: readonly string[]): boolean {
  let sawFilter = false
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string
    if (tok === '--') return false
    if (tok.startsWith('--')) {
      if (JQ_SAFE_BOOLEAN_LONG.has(tok)) continue
      const consume = JQ_SAFE_VALUE_LONG[tok]
      if (consume === undefined) return false
      i += consume
      continue
    }
    if (tok.startsWith('-') && tok.length > 1) {
      for (const ch of tok.slice(1)) {
        if (!JQ_SAFE_BOOLEAN_SHORT.has(ch)) return false
      }
      continue
    }
    if (sawFilter) return false
    sawFilter = true
    if (jqFilterLoadsModules(tok)) return false
  }
  return true
}

// jq `import`/`include` directives pull a module file from the search path, a
// file-read vector that `-L` rejection alone does not cover (the default path
// still applies). Match them as leading directives in the untrusted filter.
function jqFilterLoadsModules(filter: string): boolean {
  return /(^|[;\s])(import|include)\s/.test(filter)
}

// Splits a single bare `gh ... | reader | reader` pipeline into its stages on
// TOP-LEVEL `|` only (quote-aware, so a `|` inside a single-quoted jq filter is
// not a stage boundary), rewriting each downstream reader to run under
// `/usr/bin/env -u GH_TOKEN`. Returns the rewritten command, or null if the
// shape is not a leading-`gh` + allowlisted-stdin-readers pipeline. Absolute
// `/usr/bin/env` (not bare `env`) so the strip can't be defeated by a PATH-
// shadowed `env`; a missing binary exits 127, failing closed.
function analyzeReaderPipeline(command: string, stripRepoFlag: boolean): string | null {
  const stages = splitTopLevelPipeStages(command)
  if (stages === null || stages.length < 2) return null

  const ghStage = (stages[0] as string).trim()
  if (!isSingleBareGhCommand(ghStage)) return null

  for (let i = 1; i < stages.length; i++) {
    if (!isStdinOnlyReaderStage((stages[i] as string).trim())) return null
  }

  const rewrittenGh = stripRepoFlag ? stripRepoFlagFromCommand(ghStage) : ghStage
  const rewrittenReaders = stages.slice(1).map(rewriteReaderStage)
  return [rewrittenGh, ...rewrittenReaders].join(' | ')
}

function rewriteReaderStage(stage: string): string {
  const trimmed = stage.trim()
  if (splitStageTokens(trimmed)[0] === 'grep') {
    return `/usr/bin/env -u GH_TOKEN -u GITHUB_TOKEN -u GREP_OPTIONS /usr/bin/grep${trimmed.slice('grep'.length)}`
  }
  return `/usr/bin/env -u GH_TOKEN -u GITHUB_TOKEN ${trimmed}`
}

// Quote-aware split on top-level `|`. Returns null if any OTHER shell-active
// metachar appears outside single quotes (`;` `&` `<` `>` backtick `$` `(` `)`
// `{` `}` newline) or if a `||`/`|&` is seen — those are not simple pipelines.
function splitTopLevelPipeStages(command: string): string[] | null {
  const stages: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
      current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '$' || ch === '`') return null
      if (ch === '"') quote = null
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '|') {
      const next = command[i + 1]
      if (next === '|' || next === '&') return null
      stages.push(current)
      current = ''
      continue
    }
    if (SHELL_ACTIVE_METACHARS.has(ch) && ch !== '|') return null
    current += ch
  }
  if (quote !== null) return null
  stages.push(current)
  return stages
}

function containsShellActiveMetachar(stage: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === '$' || ch === '`') return true
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (SHELL_ACTIVE_METACHARS.has(ch)) return true
  }
  return false
}

// Whitespace-splits a single stage into argv-ish tokens, stripping surrounding
// quotes so a quoted filter like `'.[] | {id}'` becomes one token. Quote-aware
// so whitespace inside quotes does not split.
function splitStageTokens(stage: string): string[] {
  const tokens: string[] = []
  let current = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      has = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (has) {
        tokens.push(current)
        current = ''
        has = false
      }
      continue
    }
    current += ch
    has = true
  }
  if (has) tokens.push(current)
  return tokens
}

// Backslashes are shell-active outside single quotes, and the argv-ish tokenizers
// below deliberately do not interpret shell escapes. The one safe use we support
// is jq syntax such as `split("\\n")` when the complete filter operand is
// single-quoted: the shell passes that backslash literally to jq, so it cannot
// disguise a forbidden gh/jq flag or file operand.
function hasUnsafeGhStageBackslash(stage: string): boolean {
  if (!stage.includes('\\')) return false
  const rawTokens = splitRawStageTokens(stage)
  if (rawTokens === null) return true

  for (let i = 0; i < rawTokens.length; i++) {
    const raw = rawTokens[i] as string
    if (!raw.includes('\\')) continue
    const previous = rawTokens[i - 1]
    if ((previous === '--jq' || previous === '-q') && isFullySingleQuoted(raw)) continue
    const attachedFilter = raw.startsWith('--jq=')
      ? raw.slice('--jq='.length)
      : raw.startsWith('-q=')
        ? raw.slice(3)
        : null
    if (attachedFilter !== null && isFullySingleQuoted(attachedFilter)) continue
    return true
  }
  return false
}

function hasUnsafeJqStageBackslash(stage: string): boolean {
  if (!stage.includes('\\')) return false
  const rawTokens = splitRawStageTokens(stage)
  if (rawTokens === null || rawTokens[0] !== 'jq') return true

  let filterIndex: number | null = null
  for (let i = 1; i < rawTokens.length; i++) {
    const token = stripPairedQuotes(rawTokens[i] as string)
    if (token === '--') return true
    if (token.startsWith('--')) {
      const consume = JQ_SAFE_VALUE_LONG[token]
      if (consume !== undefined) i += consume
      continue
    }
    if (token.startsWith('-') && token.length > 1) continue
    filterIndex = i
    break
  }

  for (let i = 1; i < rawTokens.length; i++) {
    const raw = rawTokens[i] as string
    if (!raw.includes('\\')) continue
    if (i === filterIndex && isFullySingleQuoted(raw)) continue
    return true
  }
  return false
}

function splitRawStageTokens(stage: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of stage) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote !== null) return null
  if (current !== '') tokens.push(current)
  return tokens
}

function isFullySingleQuoted(raw: string): boolean {
  return raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'") && !raw.slice(1, -1).includes("'")
}

function stripPairedQuotes(raw: string): string {
  if (raw.length < 2) return raw
  const first = raw[0]
  return first === raw[raw.length - 1] && (first === '"' || first === "'") ? raw.slice(1, -1) : raw
}

// Removes an unquoted `-R`/`--repo` flag (and its repo-slug value) from a single
// bare command, preserving everything else byte-for-byte. Quote-aware so a `-R`
// inside a quoted `-f query='...'` value is never touched; a repo slug is
// owner/name (no whitespace), so the value is always a single unquoted token.
// Used only for graphql, where `gh api` rejects the flag we consumed as a hint.
function stripRepoFlagFromCommand(command: string): string {
  let out = ''
  let i = 0
  while (i < command.length) {
    const ch = command[i] as string
    if (ch === '"' || ch === "'") {
      const endQuote = findClosingQuote(command, i)
      out += command.slice(i, endQuote + 1)
      i = endQuote + 1
      continue
    }
    const removed = matchRepoFlagAt(command, i)
    if (removed !== null) {
      out = out.replace(/[ \t]+$/, '')
      i = removed
      while (command[i] === ' ' || command[i] === '\t') i += 1
      if (out !== '' && i < command.length) out += ' '
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// Index of the quote that closes the one at `open`. Double quotes honor `\"` as
// a literal (bash processes backslash escapes inside "..."), so a `-R o/r` buried
// in a `-f body="{\"x\":\"-R o/r\"}"` value is not mistaken for an unquoted flag.
// Single quotes take everything literally — no escapes — so the next `'` closes.
// Unterminated quote returns the last index (strip nothing past it).
function findClosingQuote(command: string, open: number): number {
  const quote = command[open]
  for (let i = open + 1; i < command.length; i++) {
    const ch = command[i]
    if (quote === '"' && ch === '\\') {
      i += 1
      continue
    }
    if (ch === quote) return i
  }
  return command.length - 1
}

// If `command` has an unquoted `-R`/`--repo` repo-flag token starting at `start`
// (at a word boundary), returns the index just past the flag and its value;
// otherwise null. Handles `-R o/r`, `--repo o/r`, `-R=o/r`, `--repo=o/r`.
function matchRepoFlagAt(command: string, start: number): number | null {
  const before = start === 0 ? '' : (command[start - 1] as string)
  if (before !== '' && before !== ' ' && before !== '\t') return null

  for (const flag of ['--repo', '-R']) {
    if (!command.startsWith(flag, start)) continue
    let i = start + flag.length
    const sep = command[i]
    // Both value forms validate the slug before stripping: the flag is only a
    // repo flag if its value parses as owner/repo. Without this, the `=` form
    // could strip a non-slug value the detection path would have rejected,
    // diverging detection from rewrite.
    if (sep === '=') {
      const valueStart = i + 1
      let j = valueStart
      while (j < command.length && command[j] !== ' ' && command[j] !== '\t') j += 1
      if (!isRepoSlug(command.slice(valueStart, j))) return null
      return j
    }
    if (sep === ' ' || sep === '\t') {
      let j = i
      while (command[j] === ' ' || command[j] === '\t') j += 1
      const valueStart = j
      while (j < command.length && command[j] !== ' ' && command[j] !== '\t') j += 1
      if (!isRepoSlug(command.slice(valueStart, j))) return null
      return j
    }
  }
  return null
}

function classifyGhSegment(args: readonly string[], fallbackRepo?: string): GhSegmentDecision {
  const parsed = parseGhArgs(args)
  if (parsed === null) return { kind: 'pass-through' }
  const { command: subcommand } = parsed

  // `gh api` is resolved BEFORE the generic -R extraction: for a literal
  // `/repos/{owner}/{repo}` endpoint the request goes to the PATH repo and `gh`
  // ignores -R, so trusting -R here would mint a token for one repo while the
  // call hits another (the allowlist-bypass this guards against).
  if (subcommand === 'api') return classifyGhApiSegment(args)

  if (repoFlagHasNonLiteralValue(args))
    return { kind: 'block', code: 'non-literal-repo', reason: NON_LITERAL_REPO_REASON }

  const explicitRepos = extractAllRepoFlags(args)
  const explicit = explicitRepos[0] ?? null
  if (explicit !== null && explicitRepos.some((repo) => !sameRepo(repo, explicit))) {
    return { kind: 'block', code: 'repo-selector-conflict', reason: REPO_SELECTOR_CONFLICT_REASON }
  }
  const positionalTargets = extractReposFromPositionalSelectors(parsed)
  if (positionalTargets.invalid) {
    return { kind: 'block', code: 'repo-selector-conflict', reason: REPO_SELECTOR_CONFLICT_REASON }
  }
  const positionalRepos = positionalTargets.repos
  if (explicit !== null) {
    if (positionalRepos.some((repo) => !sameRepo(repo, explicit))) {
      return { kind: 'block', code: 'repo-selector-conflict', reason: REPO_SELECTOR_CONFLICT_REASON }
    }
    return { kind: 'inject', repoSlugs: [explicit] }
  }

  // A `-R`/`--repo` IS present but its value isn't a literal slug (e.g. `-R "$repo"`):
  // tell the user that, not the misleading "add -R" message — they already did.
  // A trusted fallback never papers over a value the user explicitly mistyped.
  if (REPO_LESS_SUBCOMMANDS.has(subcommand)) return { kind: 'pass-through' }

  // Repo-less repo-scoped subcommand. A caller-supplied trusted fallback repo
  // (origin/cwd, already allowlisted) fills it so the command can mint; absent
  // one, block missing-repo. The fallback still passes through the composition
  // gate in analyzeGhCommand, so a compound command blocks regardless.
  const isLabelClone = subcommand === 'label' && parsed.operation === 'clone'
  if (positionalRepos.length > 0) {
    if (fallbackRepo !== undefined && isRepoSlug(fallbackRepo)) {
      if (positionalRepos.some((repo) => !sameRepo(repo, fallbackRepo))) {
        return { kind: 'block', code: 'repo-selector-conflict', reason: REPO_SELECTOR_CONFLICT_REASON }
      }
      return { kind: 'inject', repoSlugs: [fallbackRepo] }
    }
    if (isLabelClone) return { kind: 'block', code: 'missing-repo', reason: MISSING_REPO_REASON }
    return { kind: 'inject', repoSlugs: positionalRepos }
  }

  if (fallbackRepo !== undefined && isRepoSlug(fallbackRepo)) return { kind: 'inject', repoSlugs: [fallbackRepo] }

  return { kind: 'block', code: 'missing-repo', reason: MISSING_REPO_REASON }
}

const GH_FLAGS_WITH_VALUES = new Set([
  '-R',
  '--repo',
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--input',
  '--hostname',
  '--body-file',
  '--cache',
  '--json',
  '--body',
  '-b',
  '--title',
  '--match-head-commit',
  '--subject',
  '--limit',
  '-L',
  '--state',
  '--author',
  '--assignee',
  '--label',
  '--milestone',
  '--search',
  '--base',
  '--head',
  '--name',
  '--color',
  '--description',
  '--branch',
  '--event',
  '--add-label',
  '--remove-label',
  '--add-assignee',
  '--remove-assignee',
  '--add-reviewer',
  '--remove-reviewer',
  '--add-project',
  '--remove-project',
])

const PR_REPO_SELECTOR_OPERATIONS = new Set([
  'view',
  'list',
  'status',
  'checks',
  'diff',
  'review',
  'comment',
  'close',
  'reopen',
  'ready',
  'merge',
  'checkout',
  'edit',
])
const ISSUE_REPO_SELECTOR_OPERATIONS = new Set(['view', 'list', 'status', 'comment', 'close', 'reopen'])

type ParsedGhArgs = {
  command: string
  operation: string
  operands: string[]
}

function parseGhArgs(args: readonly string[]): ParsedGhArgs | null {
  const positionals = positionalArgs(args)
  const command = positionals[0]
  if (command === undefined) return null
  if (command === 'api') return { command, operation: '', operands: positionals.slice(1) }
  const operation = positionals[1]
  if (operation === undefined) return { command, operation: '', operands: [] }
  return { command, operation, operands: positionals.slice(2) }
}

// Audit of SAFE_GH_OPERATIONS positional repository authority:
// - repo view: first operand is a repository slug/URL.
// - the PR/issue sets below: a URL operand overrides -R's effective repo.
// - label clone: first operand is a second (source) repository and must agree
//   with the authorized destination repo; cross-repo clone is intentionally
//   unavailable under a command-scoped credential.
// Every other allowlisted operation accepts only repo-local names/IDs/refs or
// no positional operand; none names a secondary repository.
function extractReposFromPositionalSelectors(parsed: ParsedGhArgs): { repos: string[]; invalid: boolean } {
  const { command, operation, operands } = parsed
  if (command === 'repo' && operation === 'view') {
    const selector = operands[0]
    if (selector === undefined) return { repos: [], invalid: false }
    const repo = repoFromSelector(selector)
    return repo === null ? { repos: [], invalid: true } : { repos: [repo], invalid: false }
  }

  if (command === 'pr' && PR_REPO_SELECTOR_OPERATIONS.has(operation)) {
    return reposFromIssueLikeSelectors(operands, 'pr')
  }
  if (command === 'issue' && ISSUE_REPO_SELECTOR_OPERATIONS.has(operation)) {
    return reposFromIssueLikeSelectors(operands, 'issue')
  }
  if (command === 'label' && operation === 'clone') {
    const source = operands[0]
    if (source === undefined) return { repos: [], invalid: false }
    const repo = repoFromSelector(source)
    return repo === null ? { repos: [], invalid: true } : { repos: [repo], invalid: false }
  }
  return { repos: [], invalid: false }
}

function reposFromIssueLikeSelectors(
  selectors: readonly string[],
  kind: 'pr' | 'issue',
): { repos: string[]; invalid: boolean } {
  const repos: string[] = []
  for (const selector of selectors) {
    const repo = repoFromGithubUrl(selector, kind)
    if (repo !== null) repos.push(repo)
    else if (looksLikeUrl(selector)) return { repos: [], invalid: true }
  }
  return { repos, invalid: false }
}

function repoFromSelector(value: string): string | null {
  if (isRepoSlug(value)) return value
  const hostQualified = value.split('/')
  if (hostQualified.length === 3 && hostQualified[0]?.toLocaleLowerCase() === 'github.com') {
    const slug = `${hostQualified[1]}/${hostQualified[2]}`
    return isRepoSlug(slug) ? slug : null
  }
  return repoFromGithubUrl(value)
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value)
}

function positionalArgs(args: readonly string[]): string[] {
  const result: string[] = []
  let command: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('-')) {
      result.push(arg)
      if (command === undefined) command = arg
      continue
    }
    const equals = arg.indexOf('=')
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (equals === -1 && ghFlagTakesValue(flag, command)) i += 1
  }
  return result
}

// Short flags are scoped by Cobra command, not globally. In the credential-safe
// surface, `-f` is value-taking for `gh api` and `gh workflow run`, but boolean
// `--force` for `gh label create/clone`. Treating it globally as value-taking
// hides label clone's following source repository from authorization. The other
// short value flags in GH_FLAGS_WITH_VALUES have no boolean overload in the
// allowlisted operations audited above.
function ghFlagTakesValue(flag: string, command: string | undefined): boolean {
  if (flag === '-f' && command === 'label') return false
  return GH_FLAGS_WITH_VALUES.has(flag)
}

function repoFromGithubUrl(value: string, kind?: 'pr' | 'issue'): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLocaleLowerCase() !== 'github.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  const owner = segments[0]
  const repo = segments[1]?.replace(/\.git$/i, '')
  if (owner === undefined || repo === undefined || !isRepoSlug(`${owner}/${repo}`)) return null
  if (kind === 'pr' && (segments[2] !== 'pull' || !/^\d+$/.test(segments[3] ?? ''))) return null
  if (kind === 'issue' && (segments[2] !== 'issues' || !/^\d+$/.test(segments[3] ?? ''))) return null
  return `${owner}/${repo}`
}

function sameRepo(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase()
}

// Repo authority for `gh api`: the literal endpoint path wins. A `-R/--repo`
// that names a DIFFERENT repo than the path is a mint-for-X-but-hit-Y attempt
// and blocks. A placeholder endpoint (`repos/{owner}/{repo}`) has no literal
// target, so -R fills it and is authoritative. A non-repo endpoint without a
// `-R` (`graphql`, `/user`) passes through — the flag is what makes it
// repo-scoped, so absent one there is nothing to mint for.
function classifyGhApiSegment(args: readonly string[]): GhSegmentDecision {
  const pathRepos = extractReposFromApiPath(args)
  const flagRepo = extractRepoFlag(args)

  // A non-literal `-R/--repo` (e.g. `-R '$repo'`) blocks BEFORE any inject path,
  // including the literal `/repos/owner/repo` path branch below. Without this, a
  // single-quoted `gh api /repos/acme/widgets/... -R '$repo'` slips the composition
  // gate (single quotes neutralize `$`) AND is dropped by extractAllRepoFlags
  // (which keeps literal slugs only), so the path branch would mint for the PATH
  // repo while the unverifiable flag named something else — the exact mint-for-X-
  // hit-Y the conflict guard exists to stop. We never inject when an unreadable
  // repo flag is present.
  if (repoFlagHasNonLiteralValue(args)) {
    return { kind: 'block', code: 'non-literal-repo', reason: NON_LITERAL_REPO_REASON }
  }

  if (pathRepos.length > 0) {
    // Check EVERY repo flag, not just the first: the strip removes all of them,
    // so a single non-redundant flag anywhere is a mint-for-X-hit-Y attempt and
    // must block even when an earlier flag matches the path and would otherwise
    // mask it.
    const flagRepos = extractAllRepoFlags(args)
    if (flagRepos.some((slug) => !pathRepos.some((pathRepo) => sameRepo(slug, pathRepo)))) {
      return { kind: 'block', code: 'api-repo-conflict', reason: API_REPO_CONFLICT_REASON }
    }
    // Every `-R` here is redundant: it matches the repo already named in the
    // literal path, which is authoritative. `gh api` rejects `-R` outright, so
    // strip the flag rather than let `gh` fail with "unknown shorthand flag".
    // Distinct from graphql (no path, -R IS the hint) — here the path mints the
    // token and the flag is pure noise we remove for syntax.
    if (flagRepos.length > 0) return { kind: 'inject', repoSlugs: pathRepos, stripRepoFlag: true }
    return { kind: 'inject', repoSlugs: pathRepos }
  }

  if (flagRepo !== null && apiEndpointHasOwnerRepoPlaceholder(args)) {
    return { kind: 'inject', repoSlugs: [flagRepo] }
  }

  // graphql encodes its repo in the query body / opaque node IDs, never an
  // inspectable path, so `-R` is taken as the mint hint. Safe because there is
  // no literal path to conflict with (cf. the API_REPO_CONFLICT_REASON guard
  // above): the minted token's server-side repository restriction, not the
  // flag, bounds reach.
  // `gh api` rejects `-R`, so the flag must be stripped from the command.
  if (flagRepo !== null && isGraphqlEndpoint(args)) {
    return { kind: 'inject', repoSlugs: [flagRepo], stripRepoFlag: true }
  }

  // No literal path repo and no usable literal `-R`: if a `-R`/`--repo` was given
  // with a non-literal value (e.g. `gh api graphql -R "$repo"`), say so rather
  // than silently passing through to an unauthenticated `gh api`.
  if (flagRepo === null && repoFlagHasNonLiteralValue(args)) {
    return { kind: 'block', code: 'non-literal-repo', reason: NON_LITERAL_REPO_REASON }
  }

  return { kind: 'pass-through' }
}

function isGraphqlEndpoint(args: readonly string[]): boolean {
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return false
  const base = new URL('https://api.github.invalid/')
  try {
    const parsed = new URL(endpoint, base)
    return parsed.origin === base.origin && parsed.pathname === '/graphql'
  } catch {
    return false
  }
}

export type GhAuthEnv = {
  GH_TOKEN?: string | undefined
  GITHUB_TOKEN?: string | undefined
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

// The effective token `gh` would use for EACH `gh api` invocation that targets the
// authenticated-user endpoint (`/user`, `user`, or a `/user/...` descendant). The
// caller classifies each: an App installation token is not a user identity, so
// GitHub rejects `/user` for it (token-CLASS mismatch, not an auth failure) — but a
// PAT IS a user identity and works, so the guard must respect a command-local
// `GH_TOKEN=…`/`GITHUB_TOKEN=…` override on that invocation, not just process env.
// Precedence mirrors gh: local GH_TOKEN > process GH_TOKEN > local GITHUB_TOKEN >
// process GITHUB_TOKEN. Narrow endpoint scope: `/users/{username}`, `/meta`,
// `/rate_limit` are not user-identity endpoints and never match.
export function effectiveGhTokensForAuthenticatedUserEndpoint(
  command: string,
  env: GhAuthEnv,
): Array<string | undefined> {
  const tokens = tokenize(command)
  const ghStarts = findGhInvocations(tokens)
  const result: Array<string | undefined> = []
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    if (!isAuthenticatedUserEndpointArgs(tokens.slice(start + 1, end))) continue
    result.push(effectiveGhTokenForInvocation(tokens, start, env))
  }
  return result
}

export function effectiveGhTokensForCommand(command: string, env: GhAuthEnv): Array<string | undefined> {
  const tokens = tokenize(command)
  return findGhInvocations(tokens).map((start) => effectiveGhTokenForInvocation(tokens, start, env))
}

export function usesGhApiAuthenticatedUserEndpoint(command: string): boolean {
  return effectiveGhTokensForAuthenticatedUserEndpoint(command, {}).length > 0
}

export function usesGhApiGraphqlEndpoint(command: string): boolean {
  const tokens = tokenize(command)
  const ghStarts = findGhInvocations(tokens)
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    if (isGraphqlEndpoint(tokens.slice(start + 1, end))) return true
  }
  return false
}

function isAuthenticatedUserEndpointArgs(args: readonly string[]): boolean {
  if (args[0] !== 'api') return false
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return false
  const normalized = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
  return normalized === 'user' || normalized.startsWith('user/')
}

// Walks the contiguous `VAR=val` assignments immediately before `gh` (the same
// shape findGhInvocations skips) and applies gh's token precedence over env.
function effectiveGhTokenForInvocation(tokens: readonly string[], ghStart: number, env: GhAuthEnv): string | undefined {
  const local: GhAuthEnv = {}
  for (let i = ghStart - 1; i >= 0 && ENV_ASSIGNMENT_RE.test(tokens[i] as string); i--) {
    const token = tokens[i] as string
    const name = token.slice(0, token.indexOf('='))
    const value = token.slice(token.indexOf('=') + 1)
    // Iterating right-to-left, so only record the first (leftmost wins on dup).
    if (name === 'GH_TOKEN' && local.GH_TOKEN === undefined) local.GH_TOKEN = value
    if (name === 'GITHUB_TOKEN' && local.GITHUB_TOKEN === undefined) local.GITHUB_TOKEN = value
  }
  const ghToken = local.GH_TOKEN ?? env.GH_TOKEN
  if (ghToken !== undefined && ghToken !== '') return ghToken
  return local.GITHUB_TOKEN ?? env.GITHUB_TOKEN
}

function findGhInvocations(tokens: readonly string[]): number[] {
  const starts: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'gh') continue
    // Skip leading `FOO=bar` env assignments; a `gh` is an invocation only at
    // the start of a simple command (command position).
    if (i === 0 || isCommandBoundaryBefore(tokens, i)) starts.push(i)
  }
  return starts
}

// bash treats `then`/`else`/`do` as reserved words ONLY in command position, and each
// opens a fresh command position after it. Recognizing them is what makes
// `if ...; then gh ...; fi` reach the composition gate — without it findGhInvocations
// sees no invocation at all and the whole command silently passes through
// unauthenticated, which is neither the documented policy nor a usable failure.
// The recursion is what keeps `echo then gh` from registering: there, `then` is a
// plain argument (not preceded by a boundary), so it opens nothing.
const RESERVED_COMMAND_OPENERS = new Set(['then', 'else', 'do'])

function isCommandBoundaryBefore(tokens: readonly string[], index: number): boolean {
  let cursor = index - 1
  while (cursor >= 0) {
    const prev = tokens[cursor]
    if (prev === undefined) return false
    if (prev === '&&' || prev === '||' || prev === '|' || prev === ';' || prev === '\n') return true
    if (RESERVED_COMMAND_OPENERS.has(prev)) return isCommandBoundaryBefore(tokens, cursor)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prev)) {
      cursor -= 1
      continue
    }
    return false
  }
  return true
}

function extractRepoFlag(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '-R' || arg === '--repo') {
      const value = args[i + 1]
      if (value !== undefined && isRepoSlug(value)) return value
    }
    if (arg.startsWith('--repo=')) {
      const value = arg.slice('--repo='.length)
      if (isRepoSlug(value)) return value
    }
    if (arg.startsWith('-R=')) {
      const value = arg.slice('-R='.length)
      if (isRepoSlug(value)) return value
    }
  }
  return null
}

// True when a `-R`/`--repo` flag is present but its value is not a literal slug
// `extractRepoFlag` would accept (missing, a shell variable, a placeholder, or a
// malformed slug). Lets the classifier emit NON_LITERAL_REPO_REASON instead of
// the misleading "add -R" message when the user DID pass `-R` but with `$repo`.
function repoFlagHasNonLiteralValue(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '-R' || arg === '--repo') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) return true
      if (!isRepoSlug(value)) return true
    } else if (arg.startsWith('--repo=')) {
      if (!isRepoSlug(arg.slice('--repo='.length))) return true
    } else if (arg.startsWith('-R=')) {
      if (!isRepoSlug(arg.slice('-R='.length))) return true
    }
  }
  return false
}

// Every valid `-R`/`--repo` slug in `args`, not just the first. The strip removes
// ALL unquoted repo flags, so the conflict check must see ALL of them: a command
// like `... -R path/repo -R victim/private` is a mint-for-X-hit-Y attempt where
// the redundant first flag would otherwise mask the malicious second one.
function extractAllRepoFlags(args: readonly string[]): string[] {
  const slugs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '-R' || arg === '--repo') {
      const value = args[i + 1]
      if (value !== undefined && isRepoSlug(value)) slugs.push(value)
    } else if (arg.startsWith('--repo=')) {
      const value = arg.slice('--repo='.length)
      if (isRepoSlug(value)) slugs.push(value)
    } else if (arg.startsWith('-R=')) {
      const value = arg.slice('-R='.length)
      if (isRepoSlug(value)) slugs.push(value)
    }
  }
  return slugs
}

// `gh api` flags that consume the FOLLOWING token as their value. The endpoint
// is the first positional arg that is neither a flag nor a flag's value; only
// THAT arg is parsed for owner/repo. Scanning every arg (as before) would let a
// `-f q=/repos/a/b` field value or `--jq` expression masquerade as the target.
const GH_API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--input',
  '--cache',
  '-i',
  '--include',
  '--hostname',
])

// `-R`/`--repo` are not real `gh api` flags, but TypeClaw accepts them as a repo
// hint that can appear BEFORE the endpoint (`gh api -R o/r graphql`). They consume
// the following token, so findApiEndpoint must skip both — otherwise the slug is
// misread as the endpoint and the graphql path never runs.
const REPO_HINT_VALUE_FLAGS = new Set(['-R', '--repo'])

// The `gh api` endpoint is the first positional arg after `api` (skipping flags
// and the tokens that bare value-flags consume). Returns null if there is none.
function findApiEndpoint(args: readonly string[]): string | null {
  const apiIndex = args.indexOf('api')
  if (apiIndex === -1) return null
  for (let i = apiIndex + 1; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && (GH_API_VALUE_FLAGS.has(arg) || REPO_HINT_VALUE_FLAGS.has(arg))) i += 1
      continue
    }
    return arg
  }
  return null
}

// Every LITERAL repo the endpoint path targets. Normally one (`/repos/{o}/{r}/…`),
// but a compare endpoint `/repos/{o}/{r}/compare/{base}...{owner}:{branch}` also
// reaches the cross-fork head repo `{owner}/{r}`, so both are returned and must
// be allowlisted. `{owner}/{repo}` placeholder segments are NOT literal targets
// (see apiEndpointHasOwnerRepoPlaceholder) and yield nothing here.
function extractReposFromApiPath(args: readonly string[]): string[] {
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return []
  const normalized = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
  const segments = normalized.split('/')
  if (segments[0] !== 'repos') return []
  const owner = segments[1]
  const name = segments[2]
  if (owner === undefined || name === undefined) return []
  // A `{owner}`/`{repo}` placeholder is not a literal target; -R fills it.
  if (isPlaceholderSegment(owner) || isPlaceholderSegment(name)) return []
  const baseSlug = `${owner}/${name}`
  if (!isRepoSlug(baseSlug)) return []

  const repos = [baseSlug]
  // compare/{base}...{headOwner}:{headBranch} reaches headOwner's fork.
  const compareIndex = segments.indexOf('compare', 3)
  if (compareIndex !== -1) {
    const spec = segments.slice(compareIndex + 1).join('/')
    const head = spec.split('...')[1]
    const headOwner = head?.includes(':') ? head.split(':')[0] : undefined
    if (headOwner !== undefined && headOwner !== '' && headOwner !== owner) {
      const headSlug = `${headOwner}/${name}`
      if (isRepoSlug(headSlug)) repos.push(headSlug)
    }
  }
  return repos
}

// True when the endpoint uses gh's `{owner}`/`{repo}` template placeholders,
// which `-R/--repo` fills at runtime — so for these, -R is the authoritative
// target rather than a conflicting literal.
function apiEndpointHasOwnerRepoPlaceholder(args: readonly string[]): boolean {
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return false
  return endpoint.includes('{owner}') || endpoint.includes('{repo}')
}

// Security invariant: `extractRepoFlag` mints a token from this value, so only a
// CONCRETE static `owner/name` may pass. A value carrying `$`/`${}` expansion or
// `{owner}`/`{repo}` placeholders is rejected here so a `-R '$owner/$repo'`
// (single-quoted, so it slips the composition gate) can never be injected and
// mint for an unverifiable target; it surfaces as NON_LITERAL_REPO_REASON instead.
function isRepoSlug(value: string): boolean {
  if (value.includes('$') || value.includes('{') || value.includes('}')) return false
  const [owner, name, ...rest] = value.split('/')
  return owner !== undefined && owner !== '' && name !== undefined && name !== '' && rest.length === 0
}

function isPlaceholderSegment(segment: string): boolean {
  return segment.includes('{') || segment.includes('}')
}

// Splits on whitespace AND shell control operators (newline ; | & && ||) so a
// boundary like `true; gh ...` (no surrounding spaces) or a `gh` on its own line
// yields a standalone separator token. A newline ends a simple command in bash,
// so it must be a boundary too — otherwise a `gh` on a later line (e.g. after a
// heredoc) is not seen at command position and escapes classification. Quote-
// aware: operators inside quotes are literal. This is a command-position
// detector, not a full shell parser — it does not interpret redirections,
// subshells, heredoc bodies, or backgrounding semantics beyond boundary marking.
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasContent = false

  const flush = (): void => {
    if (hasContent) {
      tokens.push(current)
      current = ''
      hasContent = false
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === undefined) continue
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasContent = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    if (ch === '\n') {
      flush()
      tokens.push('\n')
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      flush()
      const next = command[i + 1]
      if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) {
        tokens.push(ch + ch)
        i += 1
      } else {
        tokens.push(ch)
      }
      continue
    }
    current += ch
    hasContent = true
  }
  flush()
  return tokens
}
