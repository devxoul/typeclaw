#!/usr/bin/env bun

// Debug dump of the TypeClaw-composed system-prompt preamble for each standard
// session origin, with placeholder inputs. Every origin — including the
// default subagent — goes through the real `composeSystemPrompt`, so the
// sections and their order are exactly what `createResourceLoader` produces.
//
// This is the preamble only. pi appends project context (AGENTS.md), the skill
// catalog, and the cwd when it assembles the final system message; capture a
// real session's `session.systemPrompt` for that. Sessions created with an
// explicit `systemPromptOverride` do not use this composer and are not dumped.

import { parseArgs } from 'node:util'

import { composeSystemPrompt, deriveSystemPromptMode, renderTurnTimeAnchor } from '@/agent'
import { renderInteractiveSessionContext, type SessionOrigin, type SessionRoleContext } from '@/agent/session-origin'
import { buildSystemPolicy, DEFAULT_SUBAGENT_ROSTER, renderRuntimeBlock } from '@/agent/system-prompt'
import { renderRetrievedMemorySection, type RetrievedMemoryItem } from '@/bundled-plugins/memory/load-memory'
import { composeTurnPrompt } from '@/channels/router'

type OriginKind = 'tui' | 'cron' | 'channel' | 'subagent'
const ALL_KINDS: readonly OriginKind[] = ['tui', 'cron', 'channel', 'subagent'] as const

const PLACEHOLDER_RUNTIME_VERSION = '1.2.3-debug'

// Fixed wall-clock for the per-turn `<current-time>` anchor. The dumper
// needs a deterministic timestamp so successive runs produce byte-identical
// output (and so the snapshot tests in dump-system-prompt.test.ts don't
// drift). Production callers always pass the live `new Date()` — see
// `renderTurnTimeAnchor` in src/agent/system-prompt.ts.
const PLACEHOLDER_NOW = new Date('2026-05-22T15:11:00+09:00')

const PLACEHOLDER_SELF = [
  '# Identity',
  '',
  'If SOUL.md has content below, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.',
  '',
  '## IDENTITY.md',
  '',
  "<PLACEHOLDER: contents of agent's IDENTITY.md — role, function, operating context>",
  '',
  '## SOUL.md',
  '',
  "<PLACEHOLDER: contents of agent's SOUL.md — personality, tone, voice>",
].join('\n')

const PLACEHOLDER_GIT_NUDGE = [
  '## Uncommitted changes at session start',
  '',
  'git reports 2 uncommitted files in your agent folder right now:',
  '',
  '- workspace/<PLACEHOLDER: dirty file 1>',
  '- <PLACEHOLDER: dirty file 2>',
  '',
  "These are real, current modifications — not advice. Before declaring this session's task done, commit any of these you're responsible for, with `git add <paths>` and `git commit -m \"…\"` per the version-control rules above. If a listed path is from earlier work you didn't touch, leave it alone.",
].join('\n')

const PLACEHOLDER_TURN_TEXT: Record<OriginKind, string> = {
  tui: '<PLACEHOLDER: interactive user request from the TUI>',
  cron: '<PLACEHOLDER: scheduled cron job prompt>',
  channel: '<PLACEHOLDER: current channel message addressed to the agent>',
  subagent: '<PLACEHOLDER: delegated subagent task>',
}

const PLACEHOLDER_MEMORY_ITEMS: RetrievedMemoryItem[] = [
  {
    source: 'topic',
    key: 'placeholder-working-preference',
    heading: '<PLACEHOLDER: durable user preference relevant to the current request>',
    excerpt:
      '<PLACEHOLDER: full memory excerpt with the durable preference, supporting context, and fragment citations>',
  },
  {
    source: 'stream',
    key: 'stream:<PLACEHOLDER-fragment-id>',
    heading: '<PLACEHOLDER: recent undreamed observation relevant to this turn>',
    excerpt: '<PLACEHOLDER: recent observation body awaiting dreaming consolidation>',
    who: '<PLACEHOLDER: speaker name>',
    when: '2026-05-21T08:30:00.000Z',
    where: {
      adapter: 'slack-bot',
      workspace: 'T<PLACEHOLDER-WS>',
      workspaceName: '<PLACEHOLDER: workspace display name>',
      chat: 'C<PLACEHOLDER-CH>',
      chatName: '<PLACEHOLDER: channel display name>',
      thread: null,
    },
  },
]

type Fixture = {
  origin: SessionOrigin
  roleContext: SessionRoleContext
}

function buildFixture(kind: OriginKind): Fixture {
  switch (kind) {
    case 'tui':
      return {
        origin: { kind: 'tui', sessionId: 'ses_<PLACEHOLDER-tui>' },
        roleContext: {
          role: 'owner',
          permissions: ['channel.respond', 'cron.schedule', 'cron.modify', 'security.bypass.<PLACEHOLDER:wildcard>'],
        },
      }
    case 'cron':
      return {
        origin: {
          kind: 'cron',
          jobId: '<PLACEHOLDER-job-id>',
          jobKind: 'prompt',
          scheduledByRole: 'owner',
          scheduledByOrigin: { kind: 'config-file' },
        },
        roleContext: {
          role: 'owner',
          permissions: ['channel.respond', 'cron.schedule', 'cron.modify'],
        },
      }
    case 'channel':
      return {
        origin: {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T<PLACEHOLDER-WS>',
          workspaceName: '<PLACEHOLDER: workspace display name>',
          chat: 'C<PLACEHOLDER-CH>',
          chatName: '<PLACEHOLDER: channel display name>',
          thread: null,
          lastInboundAuthorId: 'U<PLACEHOLDER-AUTHOR>',
          participants: [
            {
              authorId: 'U<PLACEHOLDER-AUTHOR>',
              authorName: '<PLACEHOLDER: human name>',
              firstMessageAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
              lastMessageAt: Date.now() - 5 * 60 * 1000,
              messageCount: 12,
              isBot: false,
            },
            {
              authorId: 'U<PLACEHOLDER-PEER-BOT>',
              authorName: '<PLACEHOLDER: peer bot name>',
              firstMessageAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
              lastMessageAt: Date.now() - 30 * 60 * 1000,
              messageCount: 5,
              isBot: true,
            },
          ],
          membership: {
            humans: 8,
            bots: 2,
            truncated: false,
            fetchedAt: Date.now() - 60 * 1000,
          },
        },
        roleContext: {
          role: 'member',
          permissions: ['channel.respond'],
        },
      }
    case 'subagent':
      return {
        origin: {
          kind: 'subagent',
          subagent: '<PLACEHOLDER-subagent-name>',
          parentSessionId: 'ses_<PLACEHOLDER-parent>',
          spawnedByRole: 'owner',
        },
        roleContext: {
          role: 'owner',
          permissions: ['channel.respond', 'cron.schedule', 'cron.modify'],
        },
      }
  }
}

export type SectionBreakdown = {
  name: string
  bytes: number
  chars: number
  tokens: number
}

export type DumpResult = {
  prompt: string
  sections: SectionBreakdown[]
  totalBytes: number
  totalChars: number
  totalTokens: number
}

// Rough size estimate: ~4 chars per token. A model-agnostic rule of thumb for
// English prose/markdown, NOT a tokenizer count — use a real tokenizer for any
// measurement you report.
const TOKENS_PER_CHAR = 0.25

export function estimateTokens(text: string): number {
  return Math.round(text.length * TOKENS_PER_CHAR)
}

// UTF-8 byte length, not String.length. The system prompt contains em-dashes,
// curly quotes, and other multi-byte codepoints (em-dash is 3 bytes; some
// emoji used in skills are 4 bytes), so chars and bytes differ on this
// content. Bytes are what gets transmitted on the wire; chars are what the
// tokenizer heuristic operates on. Using TextEncoder (Bun's native impl) is
// O(n) once and avoids the Buffer.byteLength edge cases.
const encoder = new TextEncoder()
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

const mkSection = (name: string, body: string): SectionBreakdown => ({
  name,
  bytes: byteLength(body),
  chars: body.length,
  tokens: estimateTokens(body),
})

// Each section row runs from its marker to the next one, so it includes the
// `\n\n` separator that follows it and the rows sum exactly to the totals.
export function dumpSystemPromptWithBreakdown(
  kind: OriginKind,
  options: { gitNudge: boolean } = { gitNudge: true },
): DumpResult {
  const fixture = buildFixture(kind)
  const mode = deriveSystemPromptMode(fixture.origin)
  const gitNudge = options.gitNudge && mode === 'full' ? PLACEHOLDER_GIT_NUDGE : ''
  const prompt = composeSystemPrompt({
    mode,
    self: PLACEHOLDER_SELF,
    runtimeVersion: PLACEHOLDER_RUNTIME_VERSION,
    origin: fixture.origin,
    roleContext: fixture.roleContext,
    gitNudge,
  })
  const markers: Array<readonly [string, string]> = [
    ['Shared policy', buildSystemPolicy()],
    ['Identity (IDENTITY.md + SOUL.md)', PLACEHOLDER_SELF],
    ['Runtime block', renderRuntimeBlock(PLACEHOLDER_RUNTIME_VERSION)],
  ]
  if (mode === 'full') markers.push(['Interactive context', renderInteractiveSessionContext(DEFAULT_SUBAGENT_ROSTER)])
  markers.push(['Session origin', '## Session origin\n'], ['Role context', '## Your role in this session\n'])
  if (gitNudge !== '') markers.push(['Git nudge', gitNudge])
  return buildDumpResultFromMarkers(prompt, markers)
}

export function dumpSystemPrompt(kind: OriginKind, options: { gitNudge: boolean } = { gitNudge: true }): string {
  return dumpSystemPromptWithBreakdown(kind, options).prompt
}

export function dumpTurnPromptWithBreakdown(kind: OriginKind): DumpResult {
  const fixture = buildFixture(kind)
  const memory = renderRetrievedMemorySection(PLACEHOLDER_MEMORY_ITEMS, { origin: fixture.origin })
  if (kind !== 'channel') {
    const timeAnchor = `${renderTurnTimeAnchor(PLACEHOLDER_NOW)}\n\n`
    const userText = `${PLACEHOLDER_TURN_TEXT[kind]}\n\n`
    const prompt = `${timeAnchor}${userText}${memory}`
    return buildDumpResult(prompt, [
      ['Time anchor', timeAnchor],
      ['User text', userText],
      ['Memory block', memory],
    ])
  }

  const observed = [
    {
      text: '<PLACEHOLDER: earlier human message observed while the agent was not engaged>',
      authorId: 'U<PLACEHOLDER-OBSERVER-1>',
      authorName: '<PLACEHOLDER: first participant name>',
      authorIsBot: false,
      receivedAt: PLACEHOLDER_NOW.getTime() - 90_000,
      ts: PLACEHOLDER_NOW.getTime() - 90_000,
      source: 'observed' as const,
    },
    {
      text: '<PLACEHOLDER: peer-bot follow-up retained as recent channel context>',
      authorId: 'U<PLACEHOLDER-PEER-BOT>',
      authorName: '<PLACEHOLDER: peer bot name>',
      authorIsBot: true,
      receivedAt: PLACEHOLDER_NOW.getTime() - 45_000,
      ts: PLACEHOLDER_NOW.getTime() - 45_000,
      source: 'observed' as const,
    },
  ]
  const batch = [
    {
      inputId: 'system-prompt-preview',
      text: PLACEHOLDER_TURN_TEXT.channel,
      authorId: 'U<PLACEHOLDER-AUTHOR>',
      authorName: '<PLACEHOLDER: current speaker name>',
      authorIsBot: false,
      externalMessageId: '<PLACEHOLDER-message-id>',
      isBotMention: true,
      replyToBotMessageId: '<PLACEHOLDER-prior-bot-message-id>',
      isDm: false,
      receivedAt: PLACEHOLDER_NOW.getTime(),
      ts: PLACEHOLDER_NOW.getTime(),
    },
  ]
  const channelTurn = composeTurnPrompt(observed, batch, {
    adapter: 'slack-bot',
    loopGuardActive: false,
    groupChatNudge: true,
    now: PLACEHOLDER_NOW,
    role: fixture.roleContext.role,
  })
  const prompt = `${channelTurn}\n\n${memory}`
  return buildDumpResultFromMarkers(prompt, [
    ['Time anchor', '<current-time>'],
    ['Role anchor', '<your-role authority="current-speaker">'],
    // Anchored on the fence, not the notice's prose: the fence is the invariant
    // every runtime notice carries, so rewording a notice can't break the dump.
    ['Group-chat nudge', '---\n**[SYSTEM MESSAGE — not from a human]**'],
    ['Recent context', '## Recent context (not addressed to you, for awareness only)'],
    ['Current message', 'Note: if earlier turns appear above, they are real conversation history you can use.'],
    ['Memory block (channel headings only)', '# Memory'],
  ])
}

export function dumpTurnPrompt(kind: OriginKind): string {
  return dumpTurnPromptWithBreakdown(kind).prompt
}

function buildDumpResult(prompt: string, parts: ReadonlyArray<readonly [string, string]>): DumpResult {
  if (parts.map(([, body]) => body).join('') !== prompt) {
    throw new Error('prompt breakdown does not cover the rendered prompt exactly')
  }
  return {
    prompt,
    sections: parts.map(([name, body]) => mkSection(name, body)),
    totalBytes: byteLength(prompt),
    totalChars: prompt.length,
    totalTokens: estimateTokens(prompt),
  }
}

// Locates each marker after the previous one, so a marker string that also
// occurs earlier (inside policy prose, say) cannot be mistaken for its section.
function buildDumpResultFromMarkers(prompt: string, markers: ReadonlyArray<readonly [string, string]>): DumpResult {
  const starts: Array<{ name: string; start: number }> = []
  for (const [name, marker] of markers) {
    const previous = starts.at(-1)
    const start = prompt.indexOf(marker, previous === undefined ? 0 : previous.start + 1)
    if (start < 0) throw new Error(`prompt section marker not found in rendered order: ${name}`)
    starts.push({ name, start })
  }
  if (starts[0]?.start !== 0) throw new Error('the first prompt section marker does not start the prompt')
  return buildDumpResult(
    prompt,
    starts.map((part, index) => [part.name, prompt.slice(part.start, starts[index + 1]?.start)] as const),
  )
}

function header(kind: OriginKind, result: DumpResult, label: 'SYSTEM PROMPT' | 'USER TURN'): string {
  const bar = '═'.repeat(78)
  const summary = `${result.totalChars} chars / ${result.totalBytes} bytes / ~${result.totalTokens} tok (chars/4 estimate, not a tokenizer count)`
  return `\n${bar}\n  ${label} — origin: ${kind} — ${summary}\n${bar}\n`
}

function renderBreakdownTable(result: DumpResult): string {
  const nameW = Math.max(...result.sections.map((s) => s.name.length), 'Section'.length)
  const tokW = Math.max(...result.sections.map((s) => `~${s.tokens}`.length), 'Tokens'.length)
  const charW = Math.max(...result.sections.map((s) => String(s.chars).length), 'Chars'.length)
  const byteW = Math.max(...result.sections.map((s) => String(s.bytes).length), 'Bytes'.length)

  const pad = (s: string, w: number, right = false) => (right ? s.padStart(w) : s.padEnd(w))
  const row = (n: string, t: string, c: string, b: string) =>
    `  ${pad(n, nameW)}  ${pad(t, tokW, true)}  ${pad(c, charW, true)}  ${pad(b, byteW, true)}`
  const sep = `  ${'─'.repeat(nameW)}  ${'─'.repeat(tokW)}  ${'─'.repeat(charW)}  ${'─'.repeat(byteW)}`

  const lines = [
    row('Section', '~Tok', 'Chars', 'Bytes'),
    sep,
    ...result.sections.map((s) => row(s.name, `~${s.tokens}`, String(s.chars), String(s.bytes))),
    sep,
    row('TOTAL', `~${result.totalTokens}`, String(result.totalChars), String(result.totalBytes)),
  ]
  return lines.join('\n')
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      origin: { type: 'string', short: 'o', default: 'all' },
      'no-git-nudge': { type: 'boolean', default: false },
      turn: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(
      [
        'Usage: bun run debug:prompt [--turn] [--origin <kind>] [--no-git-nudge]',
        '',
        'Dump the TypeClaw-composed system-prompt preamble, or the per-turn user',
        'message with --turn, for one or all session-origin kinds, using',
        'placeholder values for every dynamic field. pi appends project context,',
        'the skill catalog, and the cwd to the preamble at session creation.',
        'Each dump is prefixed with a per-section breakdown of character count,',
        'UTF-8 byte length, and a rough chars/4 token estimate (not a tokenizer',
        'count); rows include their trailing separator and sum to the totals.',
        '',
        'Options:',
        '  -o, --origin <kind>   tui | cron | channel | subagent | all (default: all)',
        '      --turn            dump the non-cacheable user-turn message instead',
        '      --no-git-nudge    omit the "Uncommitted changes at session start" block',
        '  -h, --help            show this help',
        '',
      ].join('\n'),
    )
    return
  }

  const requested = values.origin ?? 'all'
  const kinds: readonly OriginKind[] =
    requested === 'all'
      ? ALL_KINDS
      : ALL_KINDS.includes(requested as OriginKind)
        ? [requested as OriginKind]
        : (() => {
            process.stderr.write(
              `error: unknown origin "${requested}". Expected one of: ${ALL_KINDS.join(', ')}, all\n`,
            )
            process.exit(2)
          })()

  for (const kind of kinds) {
    const result = values.turn
      ? dumpTurnPromptWithBreakdown(kind)
      : dumpSystemPromptWithBreakdown(kind, { gitNudge: !values['no-git-nudge'] })
    process.stdout.write(header(kind, result, values.turn ? 'USER TURN' : 'SYSTEM PROMPT'))
    process.stdout.write(renderBreakdownTable(result))
    process.stdout.write('\n\n')
    process.stdout.write(result.prompt)
    process.stdout.write('\n')
  }
}

if (import.meta.main) {
  main()
}
