import { describe, expect, test } from 'bun:test'

import { buildSystemPolicy } from '@/agent/system-prompt'

import {
  byteLength,
  dumpSystemPrompt,
  dumpSystemPromptWithBreakdown,
  dumpTurnPrompt,
  dumpTurnPromptWithBreakdown,
  estimateTokens,
} from './dump-system-prompt'

const ALL_KINDS: Array<'tui' | 'cron' | 'channel' | 'subagent'> = ['tui', 'cron', 'channel', 'subagent']

describe('dumpSystemPrompt', () => {
  test.each(ALL_KINDS)(
    '%s origin renders identity, runtime, origin, and role — wall clock lives in the per-turn anchor, not here',
    (kind) => {
      const out = dumpSystemPrompt(kind)

      expect(out).toContain('# Identity')
      expect(out).toContain('## Runtime')
      expect(out).toContain('TypeClaw runtime version: 1.2.3-debug.')
      expect(out).toContain('## Session origin')
      expect(out).toContain('## Your role in this session')
      expect(out).not.toContain('# Memory')
      expect(out).not.toContain('## Now')
      expect(out).not.toContain('Session started at')
      expect(out).not.toContain('<current-time>')
    },
  )

  // The default subagent goes through the same standard composer as every
  // other origin; explicit `systemPromptOverride` sessions are not dumped.
  test.each(ALL_KINDS)('%s origin starts with the one shared policy row', (kind) => {
    const result = dumpSystemPromptWithBreakdown(kind)
    const policyRow = `${buildSystemPolicy()}\n\n`

    expect(result.prompt.startsWith(policyRow)).toBe(true)
    expect(result.prompt.split(buildSystemPolicy())).toHaveLength(2)
    expect(result.sections[0]).toEqual({
      name: 'Shared policy',
      bytes: byteLength(policyRow),
      chars: policyRow.length,
      tokens: estimateTokens(policyRow),
    })
  })

  test('cron origin renders the cron job metadata', () => {
    const out = dumpSystemPrompt('cron')

    expect(out).toContain('- Job ID:')
    expect(out).toContain('- Job kind: prompt')
  })

  test('tui origin role block is rendered (placeholder role context is non-suppressing)', () => {
    const out = dumpSystemPrompt('tui')

    expect(out).toContain('## Session origin')
    expect(out).toContain('## Your role in this session')
  })

  test('subagent origin names the subagent and parent session', () => {
    const out = dumpSystemPrompt('subagent')

    expect(out).toContain('subagent spawned by parent session')
    expect(out).toContain('<PLACEHOLDER-subagent-name>')
    expect(out).toContain('ses_<PLACEHOLDER-parent>')
  })

  test('--no-git-nudge equivalent omits the uncommitted changes block on a full-mode origin', () => {
    const out = dumpSystemPrompt('tui', { gitNudge: false })

    expect(out).not.toContain('## Uncommitted changes at session start')
    expect(out).not.toContain('# Memory')
  })

  test('byteLength returns UTF-8 byte count, not String.length', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('—')).toBe(3)
    expect(byteLength("don't")).toBeGreaterThanOrEqual(5)
  })

  test('byteLength differs from String.length on multi-byte content', () => {
    const text = 'em — dash and curly — quote'
    expect(byteLength(text)).toBeGreaterThan(text.length)
  })

  test.each(ALL_KINDS)('%s breakdown rows include their separators and sum exactly to the rendered totals', (kind) => {
    const result = dumpSystemPromptWithBreakdown(kind)

    expect(result.totalBytes).toBe(byteLength(result.prompt))
    expect(result.totalChars).toBe(result.prompt.length)
    expect(result.totalTokens).toBe(estimateTokens(result.prompt))
    expect(result.sections.reduce((sum, section) => sum + section.chars, 0)).toBe(result.prompt.length)
    expect(result.sections.reduce((sum, section) => sum + section.bytes, 0)).toBe(byteLength(result.prompt))
  })

  test.each(['tui', 'channel'] as const)(
    '%s breakdown lists the interactive session context and git nudge in cache order',
    (kind) => {
      expect(dumpSystemPromptWithBreakdown(kind).sections.map((s) => s.name)).toEqual([
        'Shared policy',
        'Identity (IDENTITY.md + SOUL.md)',
        'Runtime block',
        'Interactive context',
        'Session origin',
        'Role context',
        'Git nudge',
      ])
    },
  )

  test.each(['cron', 'subagent'] as const)(
    '%s breakdown has the same policy but no interactive context or git nudge',
    (kind) => {
      expect(dumpSystemPromptWithBreakdown(kind).sections.map((s) => s.name)).toEqual([
        'Shared policy',
        'Identity (IDENTITY.md + SOUL.md)',
        'Runtime block',
        'Session origin',
        'Role context',
      ])
    },
  )

  test('--no-git-nudge breakdown omits the Git nudge row on a full-mode origin', () => {
    const names = dumpSystemPromptWithBreakdown('tui', { gitNudge: false }).sections.map((s) => s.name)
    expect(names).not.toContain('Git nudge')
  })

  test('no origin kind embeds long-term memory in the system prompt', () => {
    for (const kind of ALL_KINDS) {
      const out = dumpSystemPrompt(kind)
      expect(out).not.toContain('## MEMORY.md')
      expect(out).not.toContain('memory/<PLACEHOLDER:YYYY-MM-DD>.jsonl')
    }
  })

  test('no origin kind embeds a wall-clock anchor in the system prompt (per-turn injection invariant)', () => {
    for (const kind of ALL_KINDS) {
      const out = dumpSystemPrompt(kind)
      expect(out).not.toContain('## Now')
      expect(out).not.toContain('Session started at')
      expect(out).not.toContain('<current-time>')
    }
  })

  test('channel turn renders live channel framing and headings-only memory', () => {
    const out = dumpTurnPrompt('channel')

    expect(out).toContain('<current-time>')
    expect(out).toContain('<your-role authority="current-speaker">member</your-role>')
    expect(out).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(out).toContain('## Recent context (not addressed to you, for awareness only)')
    expect(out).toContain('## Current message (addressed to you)')
    expect(out).toContain('memory_search({ topic:')
    expect(out).not.toContain('<PLACEHOLDER: full memory excerpt')
  })

  test('tui turn renders the non-channel memory body after the user text', () => {
    const out = dumpTurnPrompt('tui')

    expect(out).toContain('<PLACEHOLDER: interactive user request from the TUI>')
    expect(out).toContain('<PLACEHOLDER: full memory excerpt')
    expect(out.indexOf('<current-time>')).toBeLessThan(
      out.indexOf('<PLACEHOLDER: interactive user request from the TUI>'),
    )
    expect(out.indexOf('<PLACEHOLDER: interactive user request from the TUI>')).toBeLessThan(out.indexOf('# Memory'))
  })

  test.each(ALL_KINDS)('%s turn breakdown totals and section attribution cover the composed turn exactly', (kind) => {
    const result = dumpTurnPromptWithBreakdown(kind)

    expect(result.totalBytes).toBe(byteLength(result.prompt))
    expect(result.totalChars).toBe(result.prompt.length)
    expect(result.totalTokens).toBe(estimateTokens(result.prompt))
    expect(result.sections.reduce((sum, section) => sum + section.chars, 0)).toBe(result.prompt.length)
    expect(result.sections.reduce((sum, section) => sum + section.bytes, 0)).toBe(byteLength(result.prompt))
  })

  test('channel turn breakdown identifies each live envelope section in order', () => {
    expect(dumpTurnPromptWithBreakdown('channel').sections.map((section) => section.name)).toEqual([
      'Time anchor',
      'Role anchor',
      'Group-chat nudge',
      'Recent context',
      'Current message',
      'Memory block (channel headings only)',
    ])
  })

  test('turn measurement leaves the default system-prompt composition unchanged', () => {
    const before = dumpSystemPrompt('channel')

    dumpTurnPromptWithBreakdown('channel')

    expect(dumpSystemPrompt('channel')).toBe(before)
    expect(before).not.toContain('## Recent context (not addressed to you, for awareness only)')
  })
})
