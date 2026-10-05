import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatLocalDateTime, resolveLocalTimezoneName } from '@/shared'

import {
  buildDefaultSystemPrompt,
  buildSlimSystemPrompt,
  DEFAULT_SUBAGENT_ROSTER,
  DEFAULT_SYSTEM_PROMPT,
  renderRuntimeNondisclosureRule,
  renderTurnRoleAnchor,
  renderTurnTimeAnchor,
  SLIM_SYSTEM_PROMPT,
  stripRuntimeIdentityProse,
} from './system-prompt'

describe('subagent orchestration — explicit research routing', () => {
  // Guards the regression where an explicit "do a research" directive was answered
  // inline (web_search / training memory) instead of delegated. The invariant the
  // reviewer demanded: explicit research is MANDATORY-`researcher`, not satisfiable
  // by a scout/explorer-only route or an inline answer. Soften any of these and the
  // downgrade path reopens.
  test('explicit research mandates `researcher` and forbids the inline-answer downgrade', () => {
    const ruleStart = DEFAULT_SYSTEM_PROMPT.indexOf('When the user *explicitly* says')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = DEFAULT_SYSTEM_PROMPT.slice(ruleStart, ruleStart + 320)
    expect(rule).toContain('MUST spawn `researcher`')
    expect(rule).toContain('training memory')
    expect(rule).toContain('does not satisfy the request')
  })

  test('scout/explorer fan-out is explicitly marked as not replacing `researcher`', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('does not replace `researcher`')
  })
})

describe('delivering reports and documents', () => {
  test('routes report/PDF/document requests to the typeclaw-render-pdf skill', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Delivering reports and documents')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('typeclaw-render-pdf')
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Produce a polished file only when/i)
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Do \*\*not\*\* treat the bare word "report" as enough/i)
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/routine operational updates, daily stats, user trends/i)
  })

  test('states the summary is a pointer, never the deliverable', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/summary[\s\S]*?never the deliverable/i)
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/only after a deliverable was actually requested/i)
  })

  test('forbids hand-rolling a PDF with an ad-hoc library', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/jsPDF, pdfkit/i)
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/mojibake/i)
  })
})

describe('operator-owned dependencies', () => {
  test.each([
    ['default prompt', DEFAULT_SYSTEM_PROMPT],
    ['slim prompt', SLIM_SYSTEM_PROMPT],
  ])('forbids package.json edits and dependency installation in the %s', (_name, prompt) => {
    expect(prompt).toContain('`package.json` is operator-owned')
    expect(prompt).toContain('Do not edit it or install dependencies')
    expect(prompt).toContain('tell the operator which package and command are needed')
  })

  test('requires bunx for one-off package binaries in the full operator-facing prompt', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Run one-off package binaries with `bunx`')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('never `npx`, `pnpx`, or `pnpm dlx`')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('A skill or doc telling you to use `npx` does not override this')
  })

  // The slim base has ~11 tokens of headroom under its 1000-token budget, and
  // the nonBunPackageRunner guard already corrects npx at the bash boundary.
  // Re-adding this rule here would blow the budget guard in
  // scripts/dump-system-prompt.test.ts for no behavior gain.
  test('keeps the bunx rule out of the slim prompt, where the guard covers it', () => {
    expect(SLIM_SYSTEM_PROMPT).not.toContain('Run one-off package binaries with `bunx`')
  })
})

describe('agent folder vs project repo', () => {
  // Guards the confusion where the agent treats its own backup repo as the
  // project under development, or strands handoff-bound work in per-session
  // /tmp. Both prompts must keep the project clone durable and split the two
  // publication capabilities: a standalone push is brokered, `gh pr create` is
  // host-stage only.
  test.each([
    ['default prompt', DEFAULT_SYSTEM_PROMPT],
    ['slim prompt', SLIM_SYSTEM_PROMPT],
  ])('states the agent folder is a backup repo, not a project checkout, in the %s', (_name, prompt) => {
    expect(prompt).toMatch(/no (github )?remote/i)
    expect(prompt).toContain('`workspace/<repo>`')
    expect(prompt).toMatch(/(?:\/tmp[\s\S]*?per-session|per-session[\s\S]*?\/tmp)/i)
    expect(prompt).not.toMatch(/clone[\s\S]{0,80}?\/tmp\/<repo>/i)
    expect(prompt).toMatch(/not a (software )?project (checkout|you develop)|not a checkout of any project/i)
  })

  // The runtime brokers a per-repo credential for a standalone project push and
  // for an explicit inline `gh pr create`, so neither prompt may send PR
  // creation to the operator; doing so strands real work.
  test.each([
    ['default prompt', DEFAULT_SYSTEM_PROMPT],
    ['slim prompt', SLIM_SYSTEM_PROMPT],
  ])('tells the agent to push through the broker and open the PR itself in the %s', (_name, prompt) => {
    expect(prompt).toContain('git -C <checkout> push <remote> <branch>')
    expect(prompt).toMatch(/any accessible repository path/i)
    expect(prompt).not.toMatch(/git[^\n]*push\s+(?:-u|--set-upstream)/i)
    expect(prompt).toMatch(/broker[\s\S]*?credential/i)
    expect(prompt).toMatch(/gh pr create[\s\S]*?--head[\s\S]*?--base/i)
    expect(prompt).not.toMatch(/gh pr create[^\n]*host-stage only/i)
    expect(prompt).toMatch(/refus/i)
    expect(prompt).not.toMatch(/cannot push or create a PR/i)
  })

  test('the default prompt explicitly tells the agent where project work and PRs happen', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('it is your own private backup repo')
    expect(start).toBeGreaterThan(-1)
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, DEFAULT_SYSTEM_PROMPT.indexOf('\n\n', start + 400))
    expect(section).toMatch(/not\*{0,2} a checkout of any project/i)
    expect(section).toMatch(/anything a human must act on later cannot live there alone/i)
    expect(section).toMatch(/broker or your permissions refuse/i)
    expect(section).toMatch(/ask the user where it lives/i)
  })

  // The prompts and the two GitHub skills are mirrored guidance; the skills are
  // what the agent actually loads for PR work, so a fix applied only to the
  // prompts leaves the operative instruction contradicting itself.
  test.each([
    ['channel-github skill', 'typeclaw-channel-github'],
    ['github-contributing skill', 'typeclaw-github-contributing'],
  ])('mirrors the brokered push and in-session PR creation guidance in the %s', (_name, slug) => {
    const skill = readFileSync(join(import.meta.dir, '..', 'skills', slug, 'SKILL.md'), 'utf8')
    expect(skill).toMatch(/push <remote> <branch>/)
    expect(skill).toMatch(/any accessible repository path/i)
    expect(skill).toMatch(/GitHub App[\s\S]*PAT[\s\S]*trusted GitHub CLI store/i)
    expect(skill).toMatch(/gh auth login --hostname github\.com/)
    expect(skill).not.toMatch(/push -u origin <branch>/)
    expect(skill).toMatch(/broker[\s\S]*?credential/i)
    expect(skill).toMatch(/gh pr create --repo[^\n]*--head[^\n]*--base/i)
    expect(skill).not.toMatch(/gh pr create[^\n]*host-stage only/i)
    expect(skill).toMatch(/channels\.github\.repos/)
    expect(skill).toMatch(/refuse/i)
    expect(skill).not.toMatch(/cannot (push or create|create or push) a PR/i)
    expect(skill).not.toMatch(/cannot run `gh pr checkout` or authenticated `git push`/i)
  })
})

describe('understanding the request — intent-recognition steer', () => {
  // Fixes TASK RECOGNITION, upstream of the "choose a reasonable default"
  // ambiguity rule (which only fires AFTER the task is recognized) and the
  // "finish the job" rule (which only helps ONCE the job is known). The failure
  // mode: the agent executes the literal SURFACE form of a message instead of
  // the practical task behind it — answering "yes I can" to a polite imperative,
  // or a bare status answer when the user obviously wants the fix next.
  test('the default prompt tells the agent to infer the practical task behind the wording, not the literal speech act', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Understanding the request')
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Understanding the request')
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, start + 1000)
    expect(section).toMatch(
      /practical task|what the user (actually )?(needs|wants)|real(?: underlying)? (need|intent)/i,
    )
    expect(section).toMatch(/literal|surface|wording/i)
  })

  // The polite-imperative trap, stated language-agnostically: "can you X?" /
  // "could you X" / "X would be nice" are requests to DO X, not yes/no
  // questions — and this holds across languages (this is a multilingual chat
  // agent). Soften this and the "yes I can" regression reopens.
  test('the default prompt calls out the polite-imperative trap language-agnostically', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Understanding the request')
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, start + 1200)
    expect(section).toMatch(/can you|could you|would be (nice|good|great)|capability|polite/i)
    // Language-agnostic framing — must not be scoped to English phrasing only.
    expect(section).toMatch(/any language|across languages|regardless of (the )?language|whatever the language/i)
  })

  // Anti-over-clarification guardrail: intent inference must REDUCE questions,
  // not add them. A chat agent that interrogates "what did you really mean?" on
  // every turn is a UX regression. The carve-out: act on the safe conventional
  // reading; ask only when interpretations materially diverge. This is the
  // CANONICAL home for the clarifying-question rule — `## How to behave` no
  // longer duplicates it (the dedupe guard below pins that).
  test('the default prompt frames intent inference as reducing questions, not adding a clarification ritual', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Understanding the request')
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, start + 1200)
    expect(section).toMatch(
      /fewer\b[\s*]*(clarifying )?questions|not.*more questions|reduce.*question|don't (over-?ask|interrogate)|without.*(asking|clarif)/i,
    )
    expect(section).toMatch(/reasonable|conventional|safe|likely/i)
    expect(section).toMatch(/materially change scope|scope, permissions, cost/i)
  })

  // The action-bias steer ("start in the same turn, don't answer with only a
  // plan") was merged INTO this section from the former standalone
  // `## Execution bias` header. Guards both that the steer survived the merge
  // and that it stays salient as the section's opening line (not buried).
  test('the action-bias steer is folded into the section and is no longer a separate `## Execution bias` header', () => {
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain('## Execution bias')
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Understanding the request')
    const opening = DEFAULT_SYSTEM_PROMPT.slice(start, start + 220)
    expect(opening).toMatch(/start work in the same turn|same turn/i)
    expect(opening).toMatch(/only a plan|not narration/i)
  })

  // Dedupe guard: the clarifying-question / reasonable-default rule lives ONLY
  // in `## Understanding the request` now. `## How to behave` must not carry a
  // second copy (the redundancy this consolidation removed).
  test('the clarifying-question rule is not duplicated in `## How to behave`', () => {
    const behaveStart = DEFAULT_SYSTEM_PROMPT.indexOf('## How to behave')
    expect(behaveStart).toBeGreaterThan(-1)
    const behave = DEFAULT_SYSTEM_PROMPT.slice(behaveStart, behaveStart + 700)
    expect(behave).not.toMatch(/clarifying question/i)
    expect(behave).not.toMatch(/choose a reasonable default/i)
  })

  // Scope guard: the helpful next step lives WITHIN the apparent request — the
  // steer must not license inventing a larger project off a small ask.
  test('the default prompt bounds the inferred next step to the apparent request (no scope inflation)', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Understanding the request')
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, start + 1400)
    expect(section).toMatch(
      /don't (invent|expand|inflate)|not a (larger|bigger) project|within (the )?(apparent|requested) (scope|request)|stay within scope/i,
    )
  })

  // Delegation-on-recognition steer (PR #993): recognizing the task includes
  // recognizing WHO should do it. Heavy/side-effectful execution work belongs
  // to a subagent (`operator`) so the main conversation stays fast on the
  // lighter default model, rather than the orchestrator grinding through it
  // inline. The section names operator and points at the delegation mechanics
  // rather than restating Mode B/C.
  test('the default prompt encourages routing heavy execution work to a subagent once the task is recognized', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Understanding the request')
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, start + 1600)
    expect(section).toMatch(/delegat|hand (it )?off|spawn|subagent/i)
    expect(section).toContain('operator')
    expect(section).toMatch(
      /responsive|stay (fast|light)|conversation (fast|responsive|light)|keep.*(fast|responsive)/i,
    )
  })

  // Cache-suffix contract: like the other steering blocks, this lives in the
  // least-volatile base prefix, ahead of the per-agent identity block, so it
  // never invalidates cached bytes when IDENTITY.md / SOUL.md change. It leads
  // the execution-discipline run: recognize the task BEFORE finishing it.
  test('the understanding-the-request steer sits in the base prefix, ahead of finishing-the-job and the identity block', () => {
    const intentIdx = DEFAULT_SYSTEM_PROMPT.indexOf('## Understanding the request')
    expect(intentIdx).toBeGreaterThan(-1)
    expect(intentIdx).toBeLessThan(DEFAULT_SYSTEM_PROMPT.indexOf('## Finishing the job'))
    expect(intentIdx).toBeLessThan(DEFAULT_SYSTEM_PROMPT.indexOf('You are not pi, not Claude, not ChatGPT.'))
  })
})

describe('finishing the job — completion + anti-fabrication steer', () => {
  // Ported from hermes-agent's TASK_COMPLETION_GUIDANCE: deliverable is a
  // working artifact backed by real tool output, and the agent must never
  // substitute fabricated output for a result it could not actually produce.
  test('the default prompt tells the agent the deliverable is a real artifact, not a description of one', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Finishing the job')
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/working artifact backed by real tool output/i)
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/do not stop after writing a stub/i)
  })

  test('the default prompt forbids fabricating output when the real path is blocked', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Finishing the job')
    expect(start).toBeGreaterThan(-1)
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, start + 900)
    expect(section).toMatch(/never substitute .*fabricated output|never fabricate/i)
    expect(section).toMatch(/report(ing)? .*blocker|say so directly/i)
  })

  test.each([
    ['default prompt', DEFAULT_SYSTEM_PROMPT],
    ['slim prompt', SLIM_SYSTEM_PROMPT],
  ])(
    'the %s keeps the anti-fabrication invariant (cron/subagent are where fabrication is most dangerous)',
    (_name, prompt) => {
      expect(prompt).toMatch(/never fabricate|fabricated output/i)
    },
  )

  // Regression: an agent reported "fixed it, build and lint passed" for a
  // restart-required plugin change that never loaded into the running
  // container, then invented a cause for the resulting tool failure. A green
  // build proves the artifact is well-formed, never that it took effect.
  test('the default prompt separates a green build from a change that actually took effect', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Finishing the job')
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, DEFAULT_SYSTEM_PROMPT.indexOf('## Parallel'))
    expect(section).toMatch(/not done because it compiled/i)
    expect(section).toMatch(/restart-required/i)
    expect(section).toMatch(/verify the reported symptom is gone in the running system/i)
    expect(section).toMatch(/name what is still unverified/i)
  })

  test('the default prompt forbids claiming actions the agent did not or cannot perform', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Finishing the job')
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, DEFAULT_SYSTEM_PROMPT.indexOf('## Parallel'))
    expect(section).toMatch(/never say you performed an action you did not perform/i)
    expect(section).toMatch(/cannot perform from where you run/i)
  })

  test('the default prompt makes an unverified cause a fabrication, not an explanation', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Finishing the job')
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, DEFAULT_SYSTEM_PROMPT.indexOf('## Parallel'))
    expect(section).toMatch(/separate what a tool returned from why you think it happened/i)
    expect(section).toMatch(/label any account of the cause as the inference it is/i)
  })

  // The incident spanned BOTH modes: a full-mode channel session made the
  // false claim, and slim-mode cron runs repeated an invented cause every 30
  // minutes. Adding the rule to only one mode silently regresses the other.
  test.each([
    ['default prompt', DEFAULT_SYSTEM_PROMPT],
    ['slim prompt', SLIM_SYSTEM_PROMPT],
  ])('the %s requires verifying the fix landed in the live system before reporting it', (_n, p) => {
    expect(p).toMatch(/restart-required/i)
    expect(p).toMatch(/unverified/i)
    expect(p).toMatch(/never (say you performed|claim) an action you did not perform/i)
    expect(p).toMatch(/verify the (reported )?symptom is gone in the (running|live) system/i)
    expect(p).toMatch(/label (any account of the cause as the inference it is|a suspected cause as inference)/i)
  })

  // Cache-suffix contract: steering blocks must live in the least-volatile
  // base prefix, AHEAD of the per-agent identity block, so they never
  // invalidate cached bytes when IDENTITY.md / SOUL.md change.
  test('the finishing-the-job steer sits inside the base prompt (no per-agent placeholders)', () => {
    expect(DEFAULT_SYSTEM_PROMPT.indexOf('## Finishing the job')).toBeLessThan(
      DEFAULT_SYSTEM_PROMPT.indexOf('You are not pi, not Claude, not ChatGPT.'),
    )
  })
})

describe('parallel tool calls steer', () => {
  // Ported from hermes-agent's PARALLEL_TOOL_CALL_GUIDANCE (universal, all
  // models). typeclaw's runtime base prompt never told the model to batch
  // independent reads/searches; only the orchestration section mentioned
  // parallel subagent fan-out. This makes the batching steer explicit for the
  // model's own direct tool calls.
  test('the default prompt tells the agent to batch independent tool calls into one turn', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Parallel tool calls')
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/independent (reads|tool calls|calls)/i)
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/single (response|turn)|same (response|turn)/i)
  })

  test('the parallel steer carves out the dependency exception (serialize only when a later call depends on an earlier result)', () => {
    const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Parallel tool calls')
    expect(start).toBeGreaterThan(-1)
    const section = DEFAULT_SYSTEM_PROMPT.slice(start, start + 700)
    expect(section).toMatch(/depend|serialize/i)
  })

  test('the parallel steer sits inside the cacheable base prefix, ahead of the identity block', () => {
    expect(DEFAULT_SYSTEM_PROMPT.indexOf('## Parallel tool calls')).toBeLessThan(
      DEFAULT_SYSTEM_PROMPT.indexOf('You are not pi, not Claude, not ChatGPT.'),
    )
  })
})

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
  test('wraps a non-owner role in an authoritative <your-role> tag with override instruction', () => {
    expect(renderTurnRoleAnchor('guest')).toBe(
      '<your-role authority="current-speaker">guest</your-role> (authoritative for this message; overrides any role implied by the system prompt)',
    )
    expect(renderTurnRoleAnchor('member')).toContain('<your-role authority="current-speaker">member</your-role>')
    expect(renderTurnRoleAnchor('trusted')).toContain('<your-role authority="current-speaker">trusted</your-role>')
  })

  test('marks the per-turn role as authoritative so it overrides the cached system-prompt role block', () => {
    const anchor = renderTurnRoleAnchor('guest')!
    expect(anchor).toContain('authoritative')
    expect(anchor).toContain('overrides')
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

describe('branding opt-out', () => {
  test('branding on (default) is byte-identical to the exported constants', () => {
    expect(buildDefaultSystemPrompt(DEFAULT_SUBAGENT_ROSTER)).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(buildDefaultSystemPrompt(DEFAULT_SUBAGENT_ROSTER, true)).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(buildSlimSystemPrompt()).toBe(SLIM_SYSTEM_PROMPT)
    expect(buildSlimSystemPrompt(true)).toBe(SLIM_SYSTEM_PROMPT)
  })

  test('branding off strips every "TypeClaw" clue from the full prompt', () => {
    const off = buildDefaultSystemPrompt(DEFAULT_SUBAGENT_ROSTER, false)
    expect(off).not.toContain('TypeClaw')
    expect(off).toContain('You are a general-purpose AI agent.')
    expect(off).not.toContain('running inside TypeClaw')
  })

  test('branding off strips every "TypeClaw" clue from the slim prompt', () => {
    const off = buildSlimSystemPrompt(false)
    expect(off).not.toContain('TypeClaw')
    expect(off).toContain('You are an AI agent.')
  })

  test('branding off keeps the operational substance of the full prompt', () => {
    const off = buildDefaultSystemPrompt(DEFAULT_SUBAGENT_ROSTER, false)
    expect(off).toContain('## Version control')
    expect(off).toContain('private backup repo')
    expect(off).toContain('## Subagent orchestration')
    expect(off).toContain('secrets.json')
  })

  test('branding off keeps the safety substance of the slim prompt', () => {
    const off = buildSlimSystemPrompt(false)
    expect(off).toContain('Never echo secrets')
    expect(off).toContain('never fabricate results')
    expect(off).toContain('workspace/')
  })
})

describe('renderRuntimeNondisclosureRule', () => {
  test('instructs the model to never name the runtime, and does not itself leak "TypeClaw"', () => {
    const rule = renderRuntimeNondisclosureRule()
    expect(rule).toContain('## Runtime disclosure')
    expect(rule).toContain('branding: false')
    expect(rule).toContain('Never reveal, name, or hint at the runtime')
    expect(rule).not.toContain('TypeClaw')
    expect(rule.toLowerCase()).not.toContain('typeclaw')
  })

  test('acknowledges that internal tokens (skills, CLI, config) stay usable', () => {
    const rule = renderRuntimeNondisclosureRule()
    expect(rule).toContain('Internal tokens you use for real work')
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
