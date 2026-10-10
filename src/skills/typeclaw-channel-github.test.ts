import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const skill = readFileSync(join(import.meta.dir, 'typeclaw-channel-github', 'SKILL.md'), 'utf8')

describe('typeclaw-channel-github PR review instructions', () => {
  test('minimal intake captures identity then delegates immediately without parent diff analysis', () => {
    const lower = skill.toLowerCase()
    expect(lower).toContain('minimal intake')
    expect(lower).toContain('repo, pr number, current head sha, exact base oid')
    expect(skill).toContain('--json author,headRefOid,baseRefOid')
    expect(skill).toContain('base_sha: "<40-char baseRefOid>"')
    expect(lower).toContain('delegate immediately')
    expect(lower).toContain('do not run `gh pr diff`')
  })

  test('waits event-driven and does not poll before completion', () => {
    const lower = skill.toLowerCase()
    expect(lower).toContain('completion `<system-reminder>`')
    expect(lower).toContain('do not poll `subagent_output`')
    expect(lower).toContain('only after that reminder')
  })

  test('parent verification is proportional and limited to reviewer-cited anchors', () => {
    const lower = skill.toLowerCase()
    expect(lower).toContain('validate only the cited anchors')
    expect(lower).toContain('do not re-review the diff')
    expect(lower).toContain('proportional')
  })

  test('keeps non-carriers silent while waiting and forbids public process narration', () => {
    const lower = skill.toLowerCase()
    expect(lower).toContain('no process narration')
    expect(lower).toContain('stay silent')
    expect(lower).toContain('skip_response')
    expect(lower).toContain('one participant-facing message')
  })

  test('re-review query is gh-compatible and prints nothing when no decisive review exists', () => {
    const query = skill
      .split('\n')
      .find((line) => line.trim().startsWith('gh api --paginate --slurp /repos/owner/repo/pulls/<N>/reviews'))
    expect(query).toBeDefined()
    // gh rejects --slurp combined with --jq; the filter must run in a piped jq.
    expect(query).not.toContain('--jq')
    expect(query).toContain('| jq -r')
    // The flat-comment fallback is gated on "(a) is empty", so a missing state must not print `null`.
    expect(query).toContain('| last | .state // empty')
  })
})
