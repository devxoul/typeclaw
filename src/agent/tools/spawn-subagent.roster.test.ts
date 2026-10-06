import { describe, expect, test } from 'bun:test'

import { createExplorerSubagent } from '@/bundled-plugins/explorer/explorer'
import { createOperatorSubagent } from '@/bundled-plugins/operator/operator'
import { createPlannerSubagent } from '@/bundled-plugins/planner/planner'
import { createResearcherSubagent } from '@/bundled-plugins/researcher/researcher'
import { createReviewerSubagent } from '@/bundled-plugins/reviewer/reviewer'
import { createScoutSubagent } from '@/bundled-plugins/scout/scout'
import type { Subagent as PluginSubagent } from '@/plugin'

import { composeSystemPrompt } from '../index'
import { renderInteractiveSessionContext } from '../session-origin'
import type { Subagent, SubagentRegistry } from '../subagents'
import { renderPublicSubagentRoster, spawnSubagentDescription } from './spawn-subagent'

// Mirror the production plugin→internal shim (`pluginSubagentShim` in
// src/run/index.ts): strip the plugin-only fields so the bundled factories'
// plugin-shaped output becomes an internal `Subagent`. The renderer only reads
// `SubagentShared` fields (`visibility`, `rosterDescription`), which ride this
// rest-spread verbatim — exactly the runtime path under test.
function toInternal<P>(sub: PluginSubagent<P>): Subagent<P> {
  const { tools: _tools, customTools: _customTools, ...shared } = sub
  return shared
}

// The real bundled public subagents, assembled the way the runtime registers
// them. This is the drift fixture: if a new public subagent is added to the
// bundled set, adding it here makes the "every public subagent is in the roster"
// test cover it; forgetting its `rosterDescription` makes the renderer throw.
const BUNDLED_PUBLIC: SubagentRegistry = {
  explorer: toInternal(createExplorerSubagent()),
  scout: toInternal(createScoutSubagent()),
  researcher: toInternal(createResearcherSubagent()),
  reviewer: toInternal(createReviewerSubagent()),
  operator: toInternal(createOperatorSubagent()),
  planner: toInternal(createPlannerSubagent()),
}

const PUBLIC_NAMES = Object.keys(BUNDLED_PUBLIC)

describe('renderPublicSubagentRoster', () => {
  test('lists every public bundled subagent with its description', () => {
    // when
    const roster = renderPublicSubagentRoster(BUNDLED_PUBLIC)

    // then
    for (const name of PUBLIC_NAMES) {
      expect(roster).toContain(`\`${name}\``)
      const description = BUNDLED_PUBLIC[name]?.rosterDescription
      expect(description).toBeDefined()
      expect(roster).toContain(description as string)
    }
  })

  test('would have caught the researcher/planner drift: both appear in the rendered roster', () => {
    // given — the exact subagents that were silently missing from the
    // hand-maintained prompt before this guard existed
    const roster = renderPublicSubagentRoster(BUNDLED_PUBLIC)

    // then
    expect(roster).toContain('`researcher`')
    expect(roster).toContain('`planner`')
  })

  test('omits internal subagents from the roster', () => {
    // given
    const internal: Subagent<unknown> = {
      systemPrompt: 'internal worker',
      visibility: 'internal',
      rosterDescription: 'should never be shown',
    }
    const registry: SubagentRegistry = { ...BUNDLED_PUBLIC, 'memory-logger': internal }

    // when
    const roster = renderPublicSubagentRoster(registry)

    // then
    expect(roster).not.toContain('`memory-logger`')
    expect(roster).not.toContain('should never be shown')
  })

  test('throws when a public subagent has no rosterDescription (fail-loud contract)', () => {
    // given
    const registry: SubagentRegistry = {
      offender: { systemPrompt: 'x', visibility: 'public' },
    }

    // when / then
    expect(() => renderPublicSubagentRoster(registry)).toThrow(/offender.*rosterDescription/)
  })

  test('throws when a public subagent has a blank rosterDescription', () => {
    // given
    const registry: SubagentRegistry = {
      offender: { systemPrompt: 'x', visibility: 'public', rosterDescription: '   ' },
    }

    // when / then
    expect(() => renderPublicSubagentRoster(registry)).toThrow(/offender.*rosterDescription/)
  })
})

describe('composeSystemPrompt with the registry-rendered roster', () => {
  test('the interactive context names every public subagent', () => {
    // given
    const roster = renderPublicSubagentRoster(BUNDLED_PUBLIC)

    // when
    const prompt = composeSystemPrompt({
      mode: 'full',
      self: 'IDENTITY',
      subagentRoster: roster,
      gitNudge: '',
    })

    // then
    expect(prompt).toContain(renderInteractiveSessionContext(roster))
    for (const name of PUBLIC_NAMES) {
      expect(prompt).toContain(`\`${name}\``)
    }
  })

  test('slim mode renders no roster', () => {
    // given
    const roster = renderPublicSubagentRoster(BUNDLED_PUBLIC)

    // when
    const prompt = composeSystemPrompt({
      mode: 'slim',
      self: 'IDENTITY',
      subagentRoster: roster,
      gitNudge: '',
    })

    // then
    expect(prompt).not.toContain(roster)
  })
})

describe('spawnSubagentDescription', () => {
  // The tool description must NOT frame `scout` as a way to handle research — that
  // wording is the exact downgrade path the explicit-research rule closes. The
  // earlier (reverted) version said "the `scout` subagent for a quick web lookup"
  // as an explicit-research alternative; this pins it gone. Matches scout used FOR
  // research, deliberately excluding the auto-generated alphabetical roster list
  // ("researcher, reviewer, scout") where the substrings only collide by accident.
  test('does not frame scout as a research handler (no downgrade path on the tool surface)', () => {
    const description = spawnSubagentDescription(BUNDLED_PUBLIC)
    const withoutRoster = description.replace(/Available subagents:[^.]*\./i, '')

    expect(withoutRoster).not.toMatch(/scout\b[^.]*\bresearch/i)
    expect(withoutRoster).not.toMatch(/research[^.]*\bscout\b/i)
  })
})
