import { describe, expect, test } from 'bun:test'

import { formatLocalDateTime, resolveLocalTimezoneName } from '@/shared'

import {
  buildSystemPolicy,
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
  // only when branding is off. A rule removed from both outputs, or one the
  // model ignores, passes.
  test('branding off keeps every branding-on policy line that does not name TypeClaw', () => {
    const brandedOffLines = new Set(buildSystemPolicy(false).split('\n'))
    const nonBrandLines = buildSystemPolicy(true)
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('TypeClaw'))

    expect(nonBrandLines.filter((line) => !brandedOffLines.has(line))).toEqual([])
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
