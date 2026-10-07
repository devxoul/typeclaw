import { describe, expect, test } from 'bun:test'

import { formatLocalDateTime, resolveLocalTimezoneName } from '@/shared'

import { composeSystemPrompt, deriveSystemPromptMode } from './index'
import { renderInteractiveSessionContext, type SessionOrigin } from './session-origin'
import {
  buildSystemPolicy,
  DEFAULT_SUBAGENT_ROSTER,
  renderRuntimeNondisclosureRule,
  renderTurnRoleAnchor,
  renderTurnTimeAnchor,
  stripRuntimeIdentityProse,
} from './system-prompt'

describe('renderTurnTimeAnchor', () => {
  test('wraps the ISO timestamp, IANA zone, and weekday in a single <current-time> tag', () => {
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    expect(anchor.startsWith('<current-time>')).toBe(true)
    expect(anchor.endsWith('</current-time>')).toBe(true)
    expect(anchor).toContain(formatLocalDateTime(now))
    expect(anchor).toContain(`(${resolveLocalTimezoneName()},`)
  })

  test('emits the English weekday name (global users get one canonical language, not a localized pair)', () => {
    // Asserting membership in the canonical 7-entry list rather than a
    // specific weekday: the local zone may differ on CI from the
    // zone-agnostic constructor input, so the resolved weekday is not
    // pinnable. The contract is "an English weekday is present", not
    // "this specific day".
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    expect(englishDays.some((d) => anchor.includes(d))).toBe(true)
    const koreanDays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']
    expect(koreanDays.some((d) => anchor.includes(d))).toBe(false)
  })

  test('produces a single-line block with no internal newlines (so prepending `${anchor}\\n\\n${user}` is the only newline boundary)', () => {
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    expect(anchor).not.toContain('\n')
  })

  test('defaults to new Date() when no argument is passed (production callers use this path)', () => {
    const before = Date.now()
    const anchor = renderTurnTimeAnchor()
    const after = Date.now()

    expect(anchor).toContain('<current-time>')
    expect(anchor).toContain('</current-time>')
    const match = anchor.match(/<current-time>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
    expect(match).not.toBeNull()
    const ts = new Date(match![1]!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before - 1000)
    expect(ts).toBeLessThanOrEqual(after + 1000)
  })

  test('the weekday matches what `Date.getDay()` would resolve in the runtime zone (the anchor must agree with `date` for the current local day)', () => {
    const now = new Date()
    const anchor = renderTurnTimeAnchor(now)

    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const expectedEn = englishDays[now.getDay()]!
    expect(anchor).toContain(expectedEn)
  })
})

describe('renderTurnRoleAnchor', () => {
  test('wraps a non-owner role in a current-speaker <your-role> tag', () => {
    expect(renderTurnRoleAnchor('member')).toContain('<your-role authority="current-speaker">member</your-role>')
    expect(renderTurnRoleAnchor('trusted')).toContain('<your-role authority="current-speaker">trusted</your-role>')
  })

  test('omits the tag for owner (the unconstrained default — absent means no special handling)', () => {
    expect(renderTurnRoleAnchor('owner')).toBeUndefined()
  })

  test('produces a single-line block with no internal newlines', () => {
    expect(renderTurnRoleAnchor('guest')).not.toContain('\n')
  })

  test('passes through a custom role name verbatim', () => {
    expect(renderTurnRoleAnchor('contributor')).toContain(
      '<your-role authority="current-speaker">contributor</your-role>',
    )
  })
})

describe('buildSystemPolicy branding', () => {
  test('branding off removes every "TypeClaw" clue', () => {
    expect(buildSystemPolicy(true)).toContain('TypeClaw')
    expect(buildSystemPolicy(false)).not.toContain('TypeClaw')
  })

  // Input-variation property, not semantic coverage: catches a rule dropped
  // only when branding is off. A rule removed from both outputs passes here;
  // the instruction-preservation guards below cover the obligations they name.
  test('branding off keeps every branding-on policy line that does not name TypeClaw', () => {
    const brandedOffLines = new Set(buildSystemPolicy(false).split('\n'))
    const nonBrandLines = buildSystemPolicy(true)
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('TypeClaw'))

    expect(nonBrandLines.filter((line) => !brandedOffLines.has(line))).toEqual([])
  })
})

// Instruction-preservation guards. Each obligation binds a stable operand (a
// path, a runner, a role) to a small set of recognized English relations —
// prohibition and its scope, mandatory modality, precedence, exceptions — and
// is checked against the RETURNED text of `buildSystemPolicy`,
// `renderInteractiveSessionContext`, and `composeSystemPrompt`. Expectations
// live here, never derived from those builders, so an obligation deleted or
// weakened in both brandings fails even though the parity and composition
// tests still pass.
//
// Bounds: the matcher recognizes a few authored forms, not arbitrary
// paraphrase; it proves the instruction is still stated, not semantic
// equivalence and not that a model obeys it. A legitimate rewording outside
// these forms needs a reviewed matcher update, not a looser pattern. Prose is
// case-folded, but inline code spans are matched byte-for-byte: `.ENV` or
// `--Base` names a different target than `.env` or `--base`. The policy is
// English written TO the model, so AGENTS.md's multi-language rule for
// matching user text does not apply.

type Span = { start: number; end: number }
type Scope = Span & { text: string; conditional: boolean }
type Unit = { scope: string; text: string }
type Item = { verb: string; object: string }
type Obligation = readonly [name: string, holds: (prompt: string) => boolean]

const PROHIBITION = /\b(?:never|neither|do not|must not|must never|may not)\b/
// A ban followed by one of these ("never commit X unless asked", "… when the
// user agrees", "… without review") is conditional, not a ban.
const EXCEPTION_WORDS = 'unless|except|only|if|when|whenever|while|until|before|after|without|other than'
const EXCEPTION = new RegExp(String.raw`^\s(?:${EXCEPTION_WORDS})\b`)
const CONDITIONAL = new RegExp(String.raw`\b(?:${EXCEPTION_WORDS})\b`)
const CONDITION = /\b(?:if|when|whenever|unless|only)\b/
const CONTRAST = /,\s*not\s+|\binstead of\s+|\brather than\s+/
const MANUAL = /\b(?:manually|by hand|yourself)\b/
const LEADING_VERB = /^(?:(?:manually|ever|directly|yourself)\s+)*([a-z]+)\b\s*([\s\S]*)$/
const VERBS: Record<string, true> = {
  add: true,
  change: true,
  commit: true,
  edit: true,
  fabricate: true,
  fake: true,
  hide: true,
  ignore: true,
  install: true,
  invent: true,
  modify: true,
  push: true,
  run: true,
  silence: true,
  stage: true,
  substitute: true,
  suppress: true,
  swallow: true,
  use: true,
  write: true,
}

// Where a prohibition stops governing: a contrast, exception, or new clause.
// ", and <verb>" starts a new positive instruction ("never X, and report Y"),
// while ", and <operand>" still lists objects ("never commit A, B, and C").
const SCOPE_BREAK = new RegExp(
  String.raw`\s(?:but|instead|rather than|so|because|then|${EXCEPTION_WORDS})\b|\s—\s|,\s+and\s+(?=(?:${Object.keys(VERBS).join('|')})\b)`,
)
const DIRECTIVE_LEAD = /(?:^|[,—]\s*|\b(?:and|then|instead|but|so|always|must|shall|have to|need to|required to)\s+)$/
const PERMISSIVE_LEAD = /\b(?:may|might|can|could|should|optionally)\s+(?:\w+\s+)?$/
const DOC_SOURCE = String.raw`\b(?:skills?|docs?|documentation|readmes?)\b`
const RUNNERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['npx', /(?<![\w-])npx\b/],
  ['pnpx', /(?<![\w-])pnpx\b/],
  ['pnpm dlx', /\bpnpm dlx\b/],
]

function spans(text: string, pattern: RegExp): Span[] {
  const re = new RegExp(pattern.source, 'g')
  const out: Span[] = []
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    out.push({ start: match.index, end: re.lastIndex })
    if (re.lastIndex === match.index) re.lastIndex += 1
  }
  return out
}

function within(index: number, ranges: readonly Span[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

// One paragraph or one list item. Prose drops Markdown emphasis, is
// lowercased, and has negative contractions expanded; inline code spans keep
// their exact bytes minus the backticks. A list item's scope is the "…:" line
// that introduces its list, so "never stage X" under an agent-folder lead-in
// is an agent-folder rule.
function units(prompt: string): Unit[] {
  const normalized = prompt
    .split(/(`[^`\n]+`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part.slice(1, -1)
        : part
            .replace(/[`*]/g, '')
            .replace(/[\u2018\u2019]/g, "'")
            .toLowerCase()
            .replace(/\bcan't\b/g, 'cannot')
            .replace(/\bwon't\b/g, 'will not')
            .replace(/\b(do|does|did|must|should|may|is|are)n't\b/g, '$1 not')
            .replace(/[ \t]+/g, ' '),
    )
    .join('')
  const out: Unit[] = []
  let leadIn = ''
  for (const block of normalized.split(/\n\s*\n/)) {
    let intro = ''
    const items: string[] = []
    for (const line of block.split('\n').map((raw) => raw.trim())) {
      if (line === '') continue
      if (/^[-•] /.test(line)) items.push(line.slice(2))
      else if (items.length > 0) items.push(`${items.pop()} ${line}`)
      else intro = intro === '' ? line : `${intro} ${line}`
    }
    if (intro !== '') out.push({ scope: '', text: intro })
    const scope = intro !== '' ? intro : leadIn
    for (const item of items) out.push({ scope, text: item })
    leadIn = items.length === 0 && intro.endsWith(':') ? intro : ''
  }
  return out
}

function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|;\s*|:\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
}

function anyClause(prompt: string, accept: (clause: string, unit: Unit) => boolean): boolean {
  return units(prompt).some((unit) => clauses(unit.text).some((clause) => accept(clause, unit)))
}

function mentions(text: string, operand: string): boolean {
  const escaped = operand.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(String.raw`(?<![\w./-])${escaped}(?![\w<-]|\.\w)`).test(text)
}

// What a prohibition marker governs: up to the next marker, contrast, or
// exception. An exception ("unless asked") or a condition ahead of the marker
// ("if asked, never …") makes it conditional.
function prohibitionScopes(clause: string): Scope[] {
  const markers = spans(clause, PROHIBITION)
  return markers.map((marker, index) => {
    const limit = markers[index + 1]?.start ?? clause.length
    const rest = clause.slice(marker.end, limit)
    const stop = rest.search(SCOPE_BREAK)
    const end = stop === -1 ? limit : marker.end + stop
    const exception = stop !== -1 && EXCEPTION.test(rest.slice(stop))
    return {
      start: marker.end,
      end,
      text: clause.slice(marker.end, end),
      conditional: exception || CONDITION.test(clause.slice(0, marker.start)),
    }
  })
}

function exclusionScopes(clause: string): Scope[] {
  const contrasts = spans(clause, CONTRAST).map(({ end }): Scope => {
    const stop = clause.slice(end).search(SCOPE_BREAK)
    const scopeEnd = stop === -1 ? clause.length : end + stop
    return { start: end, end: scopeEnd, text: clause.slice(end, scopeEnd), conditional: false }
  })
  return [...prohibitionScopes(clause), ...contrasts]
}

// Coordinated verb phrases under one prohibition. A bare verb shares the next
// phrase's object, so "stage or commit X" forbids both for X, while
// "stage X or commit Y" forbids staging X only. A non-verb piece that carries
// its own predicate ("…, and Y is fine to commit") ends the list.
function negatedItems(scope: string): Item[] {
  const out: Item[] = []
  for (const piece of scope.split(/\s*,\s*(?:or|and|nor)\s+|\s*,\s*|\s+(?:or|and|nor)\s+/)) {
    const match = LEADING_VERB.exec(piece.trim())
    const verb = match?.[1]
    const last = out.at(-1)
    if (verb !== undefined && VERBS[verb] === true) out.push({ verb, object: match?.[2] ?? '' })
    else if (/\b(?:is|are|stays?|remains?|may|can)\b/.test(piece)) break
    else if (last !== undefined) last.object = `${last.object} ${piece}`
  }
  for (let index = out.length - 2; index >= 0; index -= 1) {
    const item = out[index]
    const next = out[index + 1]
    if (item !== undefined && next !== undefined && item.object.trim() === '') item.object = next.object
  }
  return out
}

function forbids(clause: string, accept: (item: Item, scope: Scope) => boolean): boolean {
  return prohibitionScopes(clause).some(
    (scope) => !scope.conditional && negatedItems(scope.text).some((item) => accept(item, scope)),
  )
}

// A positive instruction: imperative or mandatory ("must", "always"), outside
// every prohibition scope. "You may …", "you should …", or a negated lead
// ("you are not required to …", "there is no need to …") is not one, and
// neither is one offered with an alternative or an exception ("… or answer
// inline", "… unless …").
function directs(clause: string, action: RegExp): Span | undefined {
  const prohibited = prohibitionScopes(clause)
  return spans(clause, action).find(({ start, end }) => {
    const before = clause.slice(0, start)
    return (
      !within(start, prohibited) &&
      DIRECTIVE_LEAD.test(before) &&
      !PERMISSIVE_LEAD.test(before) &&
      !/\b(?:not|no|never|nor)\s+(?:\w+\s+){0,2}$/.test(before) &&
      !/^\s*,?\s*(?:or|unless|except)\b/.test(clause.slice(end))
    )
  })
}

// A list item's own text or its unconditional lead-in, or a paragraph's own
// clause, must name the agent folder, and not as the place the rule does NOT
// apply ("outside your agent folder"). A nearby mention in the same
// paragraph ("… or push your agent folder as the project. In a project
// checkout, never …") does not scope a different clause.
function forbidsInAgentFolder(prompt: string, verb: string, operand: string, manualOnly: boolean): boolean {
  return anyClause(prompt, (clause, unit) => {
    if (CONDITIONAL.test(unit.scope)) return false
    const scope = unit.scope === '' ? clause : `${unit.scope} ${unit.text}`
    const inAgentFolder = spans(scope, /\bagent[- ]folder\b/).some(
      ({ start }) =>
        !/\b(?:outside|not|other than|except|besides|instead of)\b[^,.;:]*$/.test(
          scope.slice(Math.max(0, start - 40), start),
        ),
    )
    return (
      inAgentFolder &&
      forbids(
        clause,
        (item, prohibition) =>
          MANUAL.test(prohibition.text) === manualOnly && item.verb === verb && mentions(item.object, operand),
      )
    )
  })
}

// The agent-folder root write ban. `forbids` treats every excepted ban as
// conditional, so this reads the ban's own tail instead of loosening that: the
// only exceptions are being asked and a task-named path, in either order, with
// nothing after them. Only "you" may precede the ban (no condition, other
// actor, or weaker modal), and its object is that root itself, not new files,
// another root, or only manual or direct writes.
const ROOT_ASKED = String.raw`(?:you are\s+|you're\s+)?(?:explicitly\s+)?(?:asked|requested)(?:\s+to)?`
const ROOT_NAMED = String.raw`(?:the|your)\s+task\s+(?:names|specifies|gives)\s+(?:that|the|this)\s+path`
const ROOT_EXCEPTION = new RegExp(
  String.raw`^\sunless\s+(?:${ROOT_ASKED}\s+or\s+(?:unless\s+)?${ROOT_NAMED}|${ROOT_NAMED}\s+or\s+(?:unless\s+)?${ROOT_ASKED})\s*[.!]?$`,
)
const AGENT_ROOT =
  /^(?:(?:files|anything)\s+)?(?:at|to|in|into)\s+(?:the|your)\s+(?:agent[- ]folder\s+root|root\s+of\s+(?:the|your)\s+agent[- ]folder)\s*[.!]?$/
// The root and progress rules split only at sentences and semicolons, so an
// inline label ("when asked: …") stays on its rule and fails the anchored lead.
const RULE_CLAUSE = /(?<=[.!?])\s+|;\s*/
// Another clause of the rule's own item that points back at the rule and makes
// it optional or narrower ("this is optional", "this applies only to new
// files") undoes it.
const RULE_BACKREF = /\b(?:this|that|it|these|the (?:rule|ban|update|exceptions?))\b/
const RULE_RELAXED = /\b(?:optional|advisory|only|outside|not (?:required|mandatory|binding)|(?:does|do) not apply)\b/

function statesRootWriteBan(clause: string): boolean {
  const markers = spans(clause, PROHIBITION)
  return prohibitionScopes(clause).some((scope, index) => {
    const marker = markers[index]
    const tail = clause.slice(scope.end, markers[index + 1]?.start ?? clause.length)
    return (
      marker !== undefined &&
      /^(?:you\s+)?$/.test(clause.slice(0, marker.start)) &&
      !/\b(?:manually|directly|by hand|yourself)\b/.test(scope.text) &&
      ROOT_EXCEPTION.test(tail) &&
      negatedItems(scope.text).some((item) => item.verb === 'write' && AGENT_ROOT.test(item.object))
    )
  })
}

function rootWriteBanUnits(prompt: string): Unit[] {
  return units(prompt).filter((unit) => {
    const ruleClauses = unit.text.split(RULE_CLAUSE)
    return (
      !CONDITIONAL.test(unit.scope) &&
      ruleClauses.some(statesRootWriteBan) &&
      !ruleClauses.some(
        (clause) => !statesRootWriteBan(clause) && RULE_BACKREF.test(clause) && RULE_RELAXED.test(clause),
      )
    )
  })
}

// An affirmative grant, anywhere in the prompt, to write at the agent-folder
// root or to edit `.gitignore` or existing, other, or root-level files without
// a request. An edit or exemption word counts unless a prohibition, contrast,
// or negation governs it. A negated requirement or limit ("no permission
// needed", "need not ask") grants what follows it, and a new subject and modal
// (", and you may …") ends the prohibition before it.
const ROOT_TARGETS =
  /\b(?:existing|other|all|any)\s+(?:root[- ]level\s+|root\s+)?files?\b|\broot(?:[- ]level)?\s+files?\b|\bfiles?\s+(?:at|in)\s+(?:the|your)\s+(?:agent[- ]folder\s+)?root\b|\bagent[- ]folder\s+root\b|\broot\s+of\s+(?:the|your)\s+agent[- ]folder\b/
const EDIT_GRANT =
  /(?<![\w-])(?:edit\w*|writ\w*|modif\w*|updat\w*|overwrit\w*|rewrit\w*|chang\w*|touch\w*|exempt\w*|except(?:ed|ions?)|allowed|permitted|fine|free|ok|okay)\b/
const REQUEST_GATE =
  /\s(?:only\s+)?(?:when|if)\s+(?:you are\s+|you're\s+)?(?:explicitly\s+)?(?:asked|requested)(?:\s+to)?\s*[.!]?$/
const NEGATED = /\b(?:not|no|never|nor|cannot)\s+(?:\w+\s+){0,2}$/
const WAIVED =
  /\b(?:need not|(?:do|does) not need|no (?:need|permission|requirements?|limits?)|not (?:required|limited|restricted))\b/
const NEW_PREDICATE =
  /,\s*(?:(?:and|or|but|nor)\s+)?(?:you|it|they|this|that)\s+(?:may|can|might|could|should|is|are)\b/

// "… only when asked" closing a clause, with nothing before it coordinated,
// negated, or conditional, restates the ban's own exception.
function requestGated(clause: string): boolean {
  const gate = REQUEST_GATE.exec(clause)
  const before = clause.slice(0, gate?.index ?? 0)
  return gate !== null && !/[,;]|\b(?:and|or|but|nor|not|no|never)\b/.test(before) && !CONDITIONAL.test(before)
}

function affirms(clause: string, term: RegExp): boolean {
  const waived = clause.search(WAIVED)
  const excluded = exclusionScopes(clause).map((scope) => {
    const predicate = scope.text.search(NEW_PREDICATE)
    return predicate === -1 ? scope : { start: scope.start, end: scope.start + predicate }
  })
  return spans(clause, term).some(
    ({ start }) =>
      (waived !== -1 && start > waived) || (!within(start, excluded) && !NEGATED.test(clause.slice(0, start))),
  )
}

function grantsUnaskedRootFileEdit(prompt: string): boolean {
  return anyClause(
    prompt,
    (clause) =>
      (mentions(clause, '.gitignore') || ROOT_TARGETS.test(clause)) &&
      !requestGated(clause) &&
      affirms(clause, EDIT_GRANT),
  )
}

// The ban's two specific exceptions, each its own clause in the ban's item and
// given to the agent ("as specific exceptions, …", "you must …"): edit
// `IDENTITY.md` when responsibilities, role, or scope change, and edit
// `SOUL.md` rarely, for durable voice or persona changes. A dropped or negated
// condition, another actor, or any other unrequested directed edit in that
// item (a third file, a second object) breaks them. Code spans keep the file
// names case-exact.
const IDENTITY_EXCEPTION = String.raw`\s+IDENTITY\.md\s+when\s+(?:your\s+)?(?:responsibilities|role|scope)\s+changes?\s*[.!]?$`
const SOUL_EXCEPTION = String.raw`\s+SOUL\.md\s+rarely\s+for\s+durable\s+(?:voice|persona)(?:\s+or\s+(?:voice|persona))?\s+changes\s*[.!]?$`
const IDENTITY_EDITS = [IDENTITY_EXCEPTION, SOUL_EXCEPTION].map(
  (condition) => new RegExp(String.raw`\b(?:edit|update)(?=${condition})`),
)
const OTHER_ROOT_EDIT = new RegExp(
  String.raw`\b(?:edit|update|write|modify|change|overwrite|rewrite|create)\b(?!${IDENTITY_EXCEPTION}|${SOUL_EXCEPTION})`,
)
const EXCEPTION_LEAD =
  /^(?:as\s+(?:an?\s+)?(?:specific\s+)?exceptions?\s*,\s*)?(?:(?:you\s+)?(?:must|always|shall)\s+)?$/

function exceptsIdentityEdits(prompt: string): boolean {
  return rootWriteBanUnits(prompt).some((unit) => {
    const ruleClauses = unit.text.split(RULE_CLAUSE)
    return (
      IDENTITY_EDITS.every((edit) =>
        ruleClauses.some((clause) =>
          spans(clause, edit).some(({ start }) => EXCEPTION_LEAD.test(clause.slice(0, start))),
        ),
      ) && !ruleClauses.some((clause) => !requestGated(clause) && directs(clause, OTHER_ROOT_EDIT) !== undefined)
    )
  })
}

function inPackageJsonRule(prompt: string, accept: (clause: string) => boolean): boolean {
  return anyClause(prompt, (clause, unit) => mentions(unit.text, 'package.json') && accept(clause))
}

function requiresBunxIn(clause: string): boolean {
  const verb = directs(clause, /\b(?:run|use|invoke|execute)\b/)
  if (verb === undefined) return false
  const excluded = exclusionScopes(clause)
  return spans(clause, /\bbunx\b/).some(({ start }) => start > verb.start && !within(start, excluded))
}

function inBunxRule(prompt: string, accept: (clause: string) => boolean): boolean {
  return anyClause(prompt, (clause, unit) => /\bbunx\b/.test(unit.text) && accept(clause))
}

function excludesRunner(prompt: string, runner: RegExp): boolean {
  return inBunxRule(prompt, (clause) => {
    const excluded = exclusionScopes(clause).filter((scope) => !scope.conditional)
    return spans(clause, runner).some(({ start }) => within(start, excluded))
  })
}

// "A skill/doc … does not override this rule", "this rule takes precedence
// over any skill/doc", or "even if a skill/doc says otherwise, use bunx".
// Checked per conjunct, and that conjunct must name a skill: in "a skill …
// overrides this rule, but a doc does not override it", no skill is outranked.
// Only "ever"/"simply" may sit between the negation and "override"; "does not
// always override" is not a denial.
function bunxRuleOutranksSkillsAndDocs(prompt: string): boolean {
  const negation = '(?:not|never|no|cannot|neither|nor)'
  const denied = new RegExp(
    String.raw`${DOC_SOURCE}.*?\b(?:does not|do not|cannot|will not|never|must not|may not)\s+(?:ever\s+|simply\s+)?(?:override|supersede|outrank|take precedence over|win over)\b`,
  )
  const asserted = new RegExp(
    String.raw`\b(?:this rule|the bunx rule|bunx)\b(?:(?!\b${negation}\b).)*?\b(?:overrides|supersedes|outranks|takes precedence over|wins over)\b(?:(?!\b${negation}\b).)*?${DOC_SOURCE}`,
  )
  return inBunxRule(
    prompt,
    (clause) =>
      !/\b(?:unless|except)\b/.test(clause) &&
      clause
        .split(/,\s+(?:and|but)\s+/)
        .some(
          (conjunct) =>
            /\bskills?\b/.test(conjunct) &&
            (denied.test(conjunct) ||
              asserted.test(conjunct) ||
              (/\b(?:even if|even when|even though|regardless of)\b/.test(conjunct) && requiresBunxIn(conjunct))),
        ),
  )
}

function mandatesResearcher(prompt: string): boolean {
  return anyClause(prompt, (clause) => {
    const trigger = /\b(?:when|if|whenever)\b([^,]*)/.exec(clause)?.[1]
    if (trigger === undefined || /\b(?:not|never|without)\b/.test(trigger)) return false
    const triggered = [/\buser\b/, /\bexplicit(?:ly)?\b/, /\bresearch\b/, /\binvestigat/].every((term) =>
      term.test(trigger),
    )
    const action =
      /\b(?:spawn|delegate to|use|call|run|hand (?:it|this|the request) to|route (?:it|this|the request) to)\s+(?:a\s+|the\s+)?researcher\b/
    return triggered && directs(clause, action) !== undefined
  })
}

// The operand's own conjunct must deny it substitutes: in "A does not satisfy
// X, and B can replace Y", B is not denied. Only "ever"/"simply" may sit
// between the negation and the verb; "does not always satisfy" is not a denial.
function deniedAsSubstitute(prompt: string, operand: RegExp, displaced?: RegExp): boolean {
  const denial =
    /\b(?:does not|do not|cannot|will not|never|is not|are not)\s+(?:ever\s+|simply\s+)?(?:satisfy|replace|substitute for|count as|suffice|enough)\b/
  return anyClause(prompt, (clause) =>
    spans(clause, operand).some(({ start }) => {
      const rest = clause.slice(start)
      const conjunctEnd = rest.search(/,\s+(?:and|but)\s+/)
      const conjunct = conjunctEnd === -1 ? rest : rest.slice(0, conjunctEnd)
      const match = denial.exec(conjunct)
      return match !== null && (displaced === undefined || displaced.test(conjunct.slice(match.index)))
    }),
  )
}

// One mandatory short progress update for multi-step work, whole in one
// clause: the multi-step trigger, the agent as actor (imperative or "you
// must"), give or provide, exactly one short or brief progress update, and its
// contrast with narration, with nothing after it. Another clause in that item
// that allows narration or more updates (also as a waived limit or a joined
// ", and you may …"), or that points back and makes the rule optional, undoes
// it, and a todo or no-narration rule cannot supply a missing part.
const MULTI_STEP = /^(?:for|in|during)\s+(?:all\s+|any\s+)?multi-step\s+(?:work|tasks?|requests?)\s*,\s*/
const PROGRESS_LEAD = /^(?:you\s+)?(?:must\s+|always\s+|shall\s+|need to\s+|have to\s+)?$/
const ONE_SHORT_UPDATE = /^\s+(?:exactly one|only one|a single|one)\s+(?:short|brief)\s+progress update\b/
const NOT_NARRATION = /^(?:,\s*not|,?\s*(?:rather than|instead of))\s+(?:a\s+)?narration\s*[.!]?$/
const MORE_UPDATES = /\bnarrat\w*|\bupdates?\b|\bprogress\b/

function statesOneShortUpdate(clause: string): boolean {
  const verb = directs(clause, /\b(?:give|provide)\b/)
  if (verb === undefined || !MULTI_STEP.test(clause)) return false
  const update = clause.slice(verb.end)
  return (
    PROGRESS_LEAD.test(clause.slice(0, verb.start).replace(MULTI_STEP, '')) &&
    ONE_SHORT_UPDATE.test(update) &&
    NOT_NARRATION.test(update.replace(ONE_SHORT_UPDATE, ''))
  )
}

function requiresOneShortProgressUpdate(prompt: string): boolean {
  return units(prompt).some((unit) => {
    const ruleClauses = unit.text.split(RULE_CLAUSE)
    return (
      !CONDITIONAL.test(unit.scope) &&
      ruleClauses.some(statesOneShortUpdate) &&
      !ruleClauses.some(
        (clause) =>
          !statesOneShortUpdate(clause) &&
          (affirms(clause, MORE_UPDATES) || (RULE_BACKREF.test(clause) && RULE_RELAXED.test(clause))),
      )
    )
  })
}

const PR_FIELDS = ['--repo', '--head', '--base', '--title', '--body']

const SHARED_OBLIGATIONS: readonly Obligation[] = [
  ...['secrets.json', '.env', 'workspace/'].flatMap((operand) =>
    ['stage', 'commit'].map(
      (verb): Obligation => [
        `agent folder: never ${verb} ${operand}`,
        (prompt) => forbidsInAgentFolder(prompt, verb, operand, false),
      ],
    ),
  ),
  ...['sessions/', 'memory/'].flatMap((operand) =>
    ['stage', 'commit'].map(
      (verb): Obligation => [
        `agent folder: never manually ${verb} runtime-owned ${operand}`,
        (prompt) => forbidsInAgentFolder(prompt, verb, operand, true),
      ],
    ),
  ),
  [
    'agent folder: never write at its root unless asked or the task names the path',
    (prompt) => rootWriteBanUnits(prompt).length > 0,
  ],
  ['agent folder root: IDENTITY.md and SOUL.md edits are its specific exceptions', exceptsIdentityEdits],
  [
    'agent folder root: no unasked edit of .gitignore or other existing files',
    (prompt) => !grantsUnaskedRootFileEdit(prompt),
  ],
  [
    'package.json is operator-owned',
    (prompt) =>
      inPackageJsonRule(
        prompt,
        (clause) =>
          mentions(clause, 'package.json') &&
          spans(
            clause,
            /\b(?:operator[- ]owned|owned by the operator|belongs to the operator|the operator owns)\b/,
          ).some(({ start }) => !/\b(?:not|never|no longer)\s+(?:\w+\s+)?$/.test(clause.slice(0, start))),
      ),
  ],
  [
    'package.json must not be edited',
    (prompt) =>
      inPackageJsonRule(prompt, (clause) =>
        forbids(
          clause,
          (item) =>
            ['edit', 'modify', 'change', 'write'].includes(item.verb) &&
            (mentions(item.object, 'package.json') || /^\s*(?:it|this file|the file)\b/.test(item.object)),
        ),
      ),
  ],
  [
    'dependencies must not be installed',
    (prompt) =>
      inPackageJsonRule(prompt, (clause) =>
        forbids(
          clause,
          (item) => ['install', 'add'].includes(item.verb) && /\b(?:dependenc(?:y|ies)|packages?)\b/.test(item.object),
        ),
      ),
  ],
  [
    'package needs are escalated to the operator',
    (prompt) =>
      inPackageJsonRule(
        prompt,
        (clause) =>
          !CONDITIONAL.test(clause) &&
          directs(clause, /\b(?:tell|ask|notify|inform|escalate to|report to)\s+(?:the\s+)?operator\b/) !== undefined,
      ),
  ],
  ['one-off package binaries run with bunx', (prompt) => inBunxRule(prompt, requiresBunxIn)],
  ...RUNNERS.map(([name, runner]): Obligation => [`${name} is excluded`, (prompt) => excludesRunner(prompt, runner)]),
  ['a conflicting skill or doc does not override the bunx rule', bunxRuleOutranksSkillsAndDocs],
  [
    'fabricated output is forbidden',
    (prompt) =>
      anyClause(prompt, (clause) =>
        forbids(clause, (item) => {
          const phrase = `${item.verb} ${item.object}`
          return (
            /\b(?:fabricat\w*|made-up|invent\w*|fake\w*)\b/.test(phrase) && /\b(?:output|results?|data)\b/.test(phrase)
          )
        }),
      ),
  ],
  [
    'suppressing errors is forbidden',
    (prompt) =>
      anyClause(prompt, (clause) =>
        forbids(
          clause,
          (item) =>
            ['suppress', 'hide', 'swallow', 'silence', 'ignore'].includes(item.verb) &&
            /\b(?:errors?|failures?|exceptions?|warnings?)\b/.test(item.object),
        ),
      ),
  ],
  [
    'failures are reported',
    (prompt) =>
      anyClause(
        prompt,
        (clause) =>
          !CONDITIONAL.test(clause) &&
          directs(clause, /\b(?:report|surface|disclose)\s+(?:\w+\s+){0,3}?(?:failures?|errors?)\b/) !== undefined,
      ),
  ],
  [
    // The agent itself, not the operator or another actor, opens the PR.
    'the agent opens project PRs itself with explicit inline gh pr create fields',
    (prompt) =>
      anyClause(prompt, (clause) => {
        const at = clause.indexOf('gh pr create')
        const opens = directs(clause, /\b(?:open|create|file)\s+(?:the|a)\s+(?:pr|pull request)\b/)
        return (
          at !== -1 &&
          opens !== undefined &&
          !/\b(?:operator|user|maintainer|human|someone)\b/.test(clause.slice(0, opens.start)) &&
          PR_FIELDS.every((field) => new RegExp(String.raw`\s${field}\s`).test(clause.slice(at)))
        )
      }),
  ],
  [
    'file, template, editor and fill PR inputs are refused',
    (prompt) =>
      anyClause(
        prompt,
        (clause, unit) =>
          unit.text.includes('gh pr create') &&
          [/\bfile\b/, /\btemplate\b/, /\beditor\b/, /\bfill\b/].every((input) => input.test(clause)) &&
          /\b(?:are|is)\s+(?:refused|rejected|blocked|denied)\b/.test(clause),
      ),
  ],
  ['multi-step work gets exactly one short progress update, not narration', requiresOneShortProgressUpdate],
]

const INTERACTIVE_OBLIGATIONS: readonly Obligation[] = [
  ['an explicit research or investigation request must spawn researcher', mandatesResearcher],
  ['training memory does not satisfy it', (prompt) => deniedAsSubstitute(prompt, /\btraining memory\b/)],
  ['one inline web_search does not satisfy it', (prompt) => deniedAsSubstitute(prompt, /\bweb_search\b/)],
  ['scout fan-out does not replace researcher', (prompt) => deniedAsSubstitute(prompt, /\bscout\b/, /\bresearcher\b/)],
  [
    'explorer fan-out does not replace researcher',
    (prompt) => deniedAsSubstitute(prompt, /\bexplorer\b/, /\bresearcher\b/),
  ],
]

const BRANDINGS = [
  ['branding on', true],
  ['branding off', false],
] as const

// Interactivity is stated here rather than read from `deriveSystemPromptMode`,
// so a mode change that moves the researcher mandate fails too.
const ORIGINS: ReadonlyArray<readonly [string, SessionOrigin | undefined, boolean]> = [
  ['tui', { kind: 'tui', sessionId: 'ses_t' }, true],
  ['channel', { kind: 'channel', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null }, true],
  ['no origin', undefined, true],
  ['cron', { kind: 'cron', jobId: 'job-1', jobKind: 'prompt' }, false],
  ['default subagent', { kind: 'subagent', subagent: 'tester', parentSessionId: 'ses_p' }, false],
  ['system', { kind: 'system', component: 'tester' }, false],
]

function unmet(prompt: string, obligations: readonly Obligation[]): string[] {
  return obligations.filter(([, holds]) => !holds(prompt)).map(([name]) => name)
}

describe('policy instruction-preservation guards', () => {
  test.each(BRANDINGS)('the shared policy with %s states every shared obligation', (_name, branding) => {
    expect(unmet(buildSystemPolicy(branding), SHARED_OBLIGATIONS)).toEqual([])
  })

  test('the interactive context states the mandatory researcher route', () => {
    expect(unmet(renderInteractiveSessionContext(DEFAULT_SUBAGENT_ROSTER), INTERACTIVE_OBLIGATIONS)).toEqual([])
  })

  describe.each(BRANDINGS)('composed prompts with %s', (_name, branding) => {
    test.each(ORIGINS)(
      'the %s prompt keeps the shared obligations, with the researcher mandate only when interactive',
      (_kind, origin, interactive) => {
        const prompt = composeSystemPrompt({
          mode: deriveSystemPromptMode(origin),
          branding,
          self: 'SELF',
          origin,
          gitNudge: '',
        })
        expect(unmet(prompt, [...SHARED_OBLIGATIONS, ...(interactive ? INTERACTIVE_OBLIGATIONS : [])])).toEqual([])
        expect(mandatesResearcher(prompt)).toBe(interactive)
      },
    )
  })

  // The matcher itself: relation forms it accepts, and token co-occurrence it
  // must reject. Synthetic text, not policy copies.
  test.each([
    [
      'accepts a stage ban and a commit ban stated separately',
      'Agent folder rules:\n\n- Do not stage `.env`, and never commit `.env`.',
      (text: string) =>
        forbidsInAgentFolder(text, 'stage', '.env', false) && forbidsInAgentFolder(text, 'commit', '.env', false),
      true,
    ],
    [
      'rejects the operand and verbs without a prohibition',
      'Agent folder rules:\n\n- Stage and commit `.env`; never push it.',
      (text: string) => forbidsInAgentFolder(text, 'stage', '.env', false),
      false,
    ],
    [
      'rejects a prohibition outside the agent folder',
      'Project checkout rules:\n\n- Never stage or commit `.env`.',
      (text: string) => forbidsInAgentFolder(text, 'commit', '.env', false),
      false,
    ],
    [
      'rejects a prohibition with an exception',
      'Agent folder rules:\n\n- Never stage or commit `.env` unless asked.',
      (text: string) => forbidsInAgentFolder(text, 'commit', '.env', false),
      false,
    ],
    [
      'binds each verb only to its own object',
      'Agent folder rules:\n\n- Never stage `.env` or commit `workspace/`.',
      (text: string) =>
        forbidsInAgentFolder(text, 'commit', '.env', false) || forbidsInAgentFolder(text, 'stage', 'workspace/', false),
      false,
    ],
    [
      'rejects permissive researcher modality',
      'When the user explicitly asks to research or investigate, you may spawn `researcher`.',
      mandatesResearcher,
      false,
    ],
    [
      'rejects an alternative to the mandated researcher',
      'When the user explicitly asks to research or investigate, you must spawn `researcher` or answer inline.',
      mandatesResearcher,
      false,
    ],
    [
      'accepts an imperative researcher paraphrase',
      'If the user explicitly requests research or an investigation, always delegate to `researcher`.',
      mandatesResearcher,
      true,
    ],
    [
      'rejects a runner that is listed but not excluded',
      'Run one-off binaries with `bunx` or `npx`.',
      (text: string) => excludesRunner(text, /(?<![\w-])npx\b/),
      false,
    ],
    [
      'rejects reversed precedence',
      'Run binaries with `bunx`. A skill telling you to use `npx` overrides this rule.',
      bunxRuleOutranksSkillsAndDocs,
      false,
    ],
    [
      'accepts contrastive exclusion and asserted precedence',
      'Use `bunx`, not `npx`. This rule takes precedence over any skill or doc.',
      (text: string) =>
        inBunxRule(text, requiresBunxIn) &&
        excludesRunner(text, /(?<![\w-])npx\b/) &&
        bunxRuleOutranksSkillsAndDocs(text),
      true,
    ],
    [
      'treats a case-changed code-span path or runner as a different target',
      'Agent folder rules:\n\n- Never stage or commit `.ENV` or `Secrets.json`.\n\nRun one-off binaries with `bunx`, never `NPX`.',
      (text: string) =>
        forbidsInAgentFolder(text, 'stage', '.env', false) ||
        forbidsInAgentFolder(text, 'commit', 'secrets.json', false) ||
        excludesRunner(text, /(?<![\w-])npx\b/),
      false,
    ],
    [
      'rejects a negated obligation lead',
      'When the user explicitly asks to research or investigate, you are not required to spawn `researcher`.',
      mandatesResearcher,
      false,
    ],
    [
      'rejects precedence that outranks a doc but not the skill',
      'Run binaries with `bunx`. A skill telling you to use `npx` overrides this rule, but a doc does not override it.',
      bunxRuleOutranksSkillsAndDocs,
      false,
    ],
    [
      'does not scope a project rule by a nearby agent-folder mention',
      'Never push your agent folder as the project. In a project checkout, never stage or commit `.env`.',
      (text: string) => forbidsInAgentFolder(text, 'commit', '.env', false),
      false,
    ],
    [
      'ends an object list at a new predicate',
      'Agent folder rules:\n\n- Never stage or commit `.env`, and `workspace/` is fine to commit.',
      (text: string) =>
        forbidsInAgentFolder(text, 'commit', '.env', false) &&
        !forbidsInAgentFolder(text, 'commit', 'workspace/', false),
      true,
    ],
    [
      'accepts a root write ban with reordered request and task-path exceptions beside both identity edits',
      'Never write to the root of the agent folder unless the task specifies that path or you are asked. As specific exceptions, update `IDENTITY.md` when your role changes; update `SOUL.md` rarely for durable persona changes.',
      (text: string) =>
        rootWriteBanUnits(text).length > 0 && exceptsIdentityEdits(text) && !grantsUnaskedRootFileEdit(text),
      true,
    ],
    [
      'rejects a create-only, new-file, project-root, advisory, or other-actor root ban',
      '- Never create files at the agent-folder root unless asked or the task names the path.\n- Never write new files at the agent-folder root unless asked or the task names the path.\n- Never write at the project root unless asked or the task names the path.\n- You should not write at the agent-folder root unless asked or the task names the path.\n- The operator must never write at the agent-folder root unless asked or the task names the path.',
      (text: string) => rootWriteBanUnits(text).length > 0,
      false,
    ],
    [
      'rejects a root ban with a dropped, broadened, or extra exception',
      '- Never write at the agent-folder root unless asked.\n- Never write at the agent-folder root unless asked or any task names a path.\n- Never write at the agent-folder root unless asked, the task names the path, or the file exists.\n- Never write at the agent-folder root.',
      (text: string) => rootWriteBanUnits(text).length > 0,
      false,
    ],
    [
      'requires both identity edits beside the root ban',
      'Never write at the agent-folder root unless asked or the task names the path. As an exception, edit `IDENTITY.md` when your role changes.',
      exceptsIdentityEdits,
      false,
    ],
    [
      'flags an unasked .gitignore edit allowed beside an intact root ban',
      'Never write at the agent-folder root unless asked or the task names the path. You may edit the existing `.gitignore` there at any time.',
      (text: string) => rootWriteBanUnits(text).length > 0 && grantsUnaskedRootFileEdit(text),
      true,
    ],
    [
      'flags an identity exception stretched to other root files',
      'Never write at the agent-folder root unless asked or the task names the path. As exceptions, edit `IDENTITY.md` and any other root file when needed.',
      grantsUnaskedRootFileEdit,
      true,
    ],
    [
      'accepts a .gitignore edit gated on a request',
      'Never write at the agent-folder root unless asked or the task names the path. Edit `.gitignore` only when asked.',
      (text: string) => rootWriteBanUnits(text).length > 0 && !grantsUnaskedRootFileEdit(text),
      true,
    ],
    [
      'flags a grant to write at the agent-folder root itself',
      'Never write at the agent-folder root unless asked or the task names the path. Writing at the root of the agent folder is fine for quick notes.',
      grantsUnaskedRootFileEdit,
      true,
    ],
    [
      'flags a negated or misbound request gate, a waived requirement, and a joined allowance as root grants',
      '- Edit `.gitignore` freely, not only when asked.\n- Edit `.gitignore` at any time, and other root files when asked.\n- You do not need permission to edit `.gitignore`.\n- You need not ask before changing other root files.\n- Never delete `.gitignore`, and you may edit it whenever needed.',
      (text: string) => text.split('\n').every(grantsUnaskedRootFileEdit),
      true,
    ],
    [
      'rejects a root ban narrowed by an inline condition, a narrowing follow-up, or manual writes',
      '- Only in shared sessions: never write at the agent-folder root unless asked or the task names the path.\n- Never write at the agent-folder root unless asked or the task names the path. This applies only to new files.\n- Never write at the agent-folder root unless asked or the task names the path. Existing root files are outside this rule.\n- Never manually write at the agent-folder root unless asked or the task names the path.\n- Never directly write at the agent-folder root unless asked or the task names the path.',
      (text: string) => rootWriteBanUnits(text).length > 0,
      false,
    ],
    [
      'rejects a third file or another actor among the identity exceptions',
      '- Never write at the agent-folder root unless asked or the task names the path. As specific exceptions, edit `IDENTITY.md` when your role changes; edit `USER.md` for new user facts; edit `SOUL.md` rarely for durable voice changes.\n- Never write at the agent-folder root unless asked or the task names the path. As specific exceptions, the operator must edit `IDENTITY.md` when your role changes; the operator must edit `SOUL.md` rarely for durable voice changes.',
      exceptsIdentityEdits,
      false,
    ],
    [
      'rejects identity exceptions with a dropped or negated condition',
      '- Never write at the agent-folder root unless asked or the task names the path. As specific exceptions, edit `IDENTITY.md`; edit `SOUL.md` rarely for durable voice changes.\n- Never write at the agent-folder root unless asked or the task names the path. As specific exceptions, edit `IDENTITY.md` when your role does not change; edit `SOUL.md` rarely for durable voice changes.\n- Never write at the agent-folder root unless asked or the task names the path. As specific exceptions, edit `IDENTITY.md` when your role changes; edit `SOUL.md` for durable voice changes.\n- Never write at the agent-folder root unless asked or the task names the path. As specific exceptions, edit `IDENTITY.md` when your role changes; edit `SOUL.md` rarely for voice changes.',
      exceptsIdentityEdits,
      false,
    ],
    [
      'keeps both identity exceptions beside a request-gated .gitignore edit',
      'Never write at the agent-folder root unless asked or the task names the path. As specific exceptions, edit `IDENTITY.md` when your role changes; edit `SOUL.md` rarely for durable voice changes. Edit `.gitignore` only when asked.',
      (text: string) => exceptsIdentityEdits(text) && !grantsUnaskedRootFileEdit(text),
      true,
    ],
    [
      'accepts a mandatory single brief progress update for multi-step tasks',
      '**For multi-step tasks**, you must provide a *single* brief progress update rather than narration.',
      requiresOneShortProgressUpdate,
      true,
    ],
    [
      'rejects an optional, conditional, or delegated progress update',
      '- For multi-step work, you may give one short progress update, not narration.\n- For multi-step work, give one short progress update, not narration, when asked.\n- For multi-step work, the operator must give one short progress update, not narration.',
      requiresOneShortProgressUpdate,
      false,
    ],
    [
      'rejects a progress update count other than exactly one',
      '- For multi-step work, give a short progress update, not narration.\n- For multi-step work, give at least one short progress update, not narration.\n- For multi-step work, give one short progress update per step, not narration.',
      requiresOneShortProgressUpdate,
      false,
    ],
    [
      'rejects a progress update that is not short or not contrasted with narration',
      '- For multi-step work, give one detailed progress update, not narration.\n- For multi-step work, give one short progress update.\n- For multi-step work, give one short progress update, not narration, or narrate each step.',
      requiresOneShortProgressUpdate,
      false,
    ],
    [
      'rejects narration or more updates allowed beside an intact progress rule',
      '- For multi-step work, give one short progress update, not narration. You may also narrate each step.\n- For multi-step work, give one short progress update, not narration. You may give more updates whenever you like.',
      requiresOneShortProgressUpdate,
      false,
    ],
    [
      'does not let a todo or no-narration rule stand in for the progress update',
      'For multi-step work, call `todo_write` when you start. Do not narrate routine tool calls or give one short progress update.',
      requiresOneShortProgressUpdate,
      false,
    ],
    [
      'rejects a progress rule undone by a waived limit, a joined allowance, an inline condition, or an optional follow-up',
      '- For multi-step work, give one short progress update, not narration. You do not need to limit updates to one.\n- For multi-step work, give one short progress update, not narration. There is no limit on narration.\n- For multi-step work, give one short progress update, not narration. Do not narrate routine calls, and you may narrate the rest.\n- When asked: for multi-step work, give one short progress update, not narration.\n- For multi-step work, give one short progress update, not narration. This is optional.',
      requiresOneShortProgressUpdate,
      false,
    ],
  ])('the matcher %s', (_name, text, holds, expected) => {
    expect(holds(text)).toBe(expected)
  })
})

describe('renderRuntimeNondisclosureRule', () => {
  test('does not itself leak "TypeClaw"', () => {
    const rule = renderRuntimeNondisclosureRule()
    expect(rule).not.toContain('TypeClaw')
    expect(rule.toLowerCase()).not.toContain('typeclaw')
  })
})

describe('stripRuntimeIdentityProse', () => {
  test('drops the "running inside TypeClaw" identity phrase', () => {
    expect(stripRuntimeIdentityProse('You are a scout running inside TypeClaw. Do work.')).toBe(
      'You are a scout. Do work.',
    )
  })

  test('rephrases the planner\'s "TypeClaw ships a" reviewer recommendation', () => {
    expect(stripRuntimeIdentityProse('TypeClaw ships a `reviewer` subagent')).toBe(
      'The runtime ships a `reviewer` subagent',
    )
  })

  test('leaves functional lowercase tokens untouched', () => {
    const withTokens = 'Cannot reach typeclaw.json; run `typeclaw logs -f`; use `typeclaw-render-pdf`.'
    expect(stripRuntimeIdentityProse(withTokens)).toBe(withTokens)
  })
})
