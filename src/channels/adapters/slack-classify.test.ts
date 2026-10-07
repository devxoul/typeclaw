import { describe, expect, test } from 'bun:test'

import type { SlackFile } from 'agent-messenger/slack'

import { channelsSchema } from '@/channels/schema'
import { isDmChannelOrigin } from '@/permissions'

import { classifyInbound, type SlackInboundMessageEvent } from './slack-classify'

const config = channelsSchema.parse({ slack: {} }).slack!
const context = { teamId: 'T0123456789', selfUserId: 'USELF', selfAliases: ['typeclaw'] }

function event(overrides: Partial<SlackInboundMessageEvent> = {}): SlackInboundMessageEvent {
  return {
    type: 'message',
    channel: 'C0123456789',
    user: 'UUSER',
    text: 'hello',
    ts: '1770000000.000100',
    ...overrides,
  }
}

function file(overrides: Partial<SlackFile> = {}): SlackFile {
  return {
    id: 'F0001',
    name: 'image.png',
    title: 'image.png',
    mimetype: 'image/png',
    size: 1024,
    url_private: 'https://files.slack.com/files-pri/T1-F0001/image.png',
    created: 1,
    user: 'UUSER',
    ...overrides,
  }
}

describe('classifyInbound (slack user)', () => {
  test('drops unrouteable RTM messages', () => {
    expect(classifyInbound(event({ user: 'USELF' }), config, context)).toEqual({ kind: 'drop', reason: 'self_author' })
    expect(classifyInbound(event({ user: undefined }), config, context)).toEqual({ kind: 'drop', reason: 'no_user' })
    expect(classifyInbound(event({ subtype: 'channel_join' }), config, context)).toEqual({
      kind: 'drop',
      reason: 'slack_system_message',
    })
    expect(classifyInbound(event({ text: '' }), config, context)).toEqual({ kind: 'drop', reason: 'empty_text' })
    expect(classifyInbound(event(), config, { ...context, selfUserId: null })).toEqual({
      kind: 'drop',
      reason: 'pre_connect',
    })
  })

  test('routes DMs with @dm workspace and no thread', () => {
    const verdict = classifyInbound(event({ channel: 'D0123456789' }), config, context)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.workspace).toBe('@dm')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.thread).toBeNull()
  })

  test('routes captionless subtype-less RTM file messages with addressable attachment descriptors', () => {
    const verdict = classifyInbound(event({ text: '', files: [file()] }), config, context)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.text).toBe('[Slack attachment #1: file image/png name=image.png]')
    expect(verdict.payload.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'F0001', filename: 'image.png', mimetype: 'image/png' },
    ])
  })

  test('appends every attachment descriptor after text in upload order', () => {
    const verdict = classifyInbound(
      event({
        text: 'two files',
        files: [file(), file({ id: 'F0002', name: 'notes.txt', mimetype: 'text/plain' })],
      }),
      config,
      context,
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.text).toBe(
      'two files\n[Slack attachment #1: file image/png name=image.png]\n[Slack attachment #2: file text/plain name=notes.txt]',
    )
    expect(verdict.payload.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'F0001', filename: 'image.png', mimetype: 'image/png' },
      { id: 2, kind: 'file', ref: 'F0002', filename: 'notes.txt', mimetype: 'text/plain' },
    ])
  })

  test('fails closed to the team workspace for a G-prefixed conversation without metadata', () => {
    const verdict = classifyInbound(event({ channel: 'G0123456789' }), config, context)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.workspace).toBe('T0123456789')
    expect(verdict.payload.chat).toBe('G0123456789')
    expect(verdict.payload.isDm).toBe(false)
  })

  test('keeps MPIMs and private channels in the real team workspace without granting DM semantics', () => {
    const mpim = classifyInbound(event({ channel: 'G0MPIM' }), config, { ...context, conversationType: 'mpim' })
    const privateChannel = classifyInbound(event({ channel: 'G0PRIVATE' }), config, {
      ...context,
      conversationType: 'channel',
    })

    expect(mpim.kind === 'route' && mpim.payload.workspace).toBe('T0123456789')
    expect(mpim.kind === 'route' && mpim.payload.isDm).toBe(false)
    expect(mpim.kind === 'route' && isDmChannelOrigin(mpim.payload)).toBe(false)
    expect(privateChannel.kind === 'route' && privateChannel.payload.workspace).toBe('T0123456789')
  })

  test('detects self mentions, group mentions, and other mentions', () => {
    const selfMention = classifyInbound(event({ text: 'hello <@USELF>' }), config, context)
    const groupMention = classifyInbound(event({ text: '<!channel> deploy?' }), config, context)
    const otherMention = classifyInbound(event({ text: 'ask <@UOTHER>' }), config, context)

    expect(selfMention.kind === 'route' && selfMention.payload.isBotMention).toBe(true)
    expect(groupMention.kind === 'route' && groupMention.payload.isBotMention).toBe(true)
    expect(otherMention.kind === 'route' && otherMention.payload.mentionsOthers).toBe(true)
  })

  test('anchors English and Korean alias-addressed channel messages', () => {
    const english = classifyInbound(event({ text: 'typeclaw please check this' }), config, context)
    const korean = classifyInbound(event({ text: 'typeclaw 확인해 주세요' }), config, context)

    expect(english.kind === 'route' && english.payload.thread).toBe('1770000000.000100')
    expect(korean.kind === 'route' && korean.payload.thread).toBe('1770000000.000100')
  })
})

const EDIT_TS = '1770000060.000200'

// RTM `message_changed` envelope as Slack delivers it: the nested message keeps
// its original ts and gains `edited`; `previous_message` holds the prior body.
function edit(
  previousText: string,
  text: string,
  over: {
    message?: Record<string, unknown>
    previous?: Record<string, unknown>
  } & Partial<SlackInboundMessageEvent> = {},
): SlackInboundMessageEvent {
  const { message, previous, ...envelope } = over
  const original = event()
  return {
    type: 'message',
    subtype: 'message_changed',
    channel: original.channel,
    hidden: true,
    ts: '1770000060.000300',
    message: { ...original, text, edited: { user: original.user, ts: EDIT_TS }, ...message },
    previous_message: { ...original, text: previousText, ...previous },
    ...envelope,
  }
}

describe('classifyInbound (slack user) edits', () => {
  test('a freshly added English or Korean self mention routes as the original message', () => {
    for (const [before, after] of [
      ['can you check', '<@USELF> can you check'],
      ['확인 부탁드려요', '<@USELF> 확인 부탁드려요'],
      ['배포 공지', '<!channel> 배포 공지'],
    ] as const) {
      const verdict = classifyInbound(edit(before, after), config, context)

      expect(verdict.kind).toBe('route')
      if (verdict.kind !== 'route') return
      expect(verdict.payload).toMatchObject({
        text: after,
        externalMessageId: '1770000000.000100',
        revision: 'original',
        accountIdentity: 'slack:T0123456789:USELF',
        authorId: 'UUSER',
        isBotMention: true,
      })
    }
  })

  test('edits that do not newly address this account are not new inbounds', () => {
    const cases: Array<[string, SlackInboundMessageEvent]> = [
      ['DM typo fix', edit('helo', 'hello', { channel: 'D0123456789' })],
      ['Korean DM typo fix', edit('고마워여', '고마워요', { channel: 'D0123456789' })],
      ['typo fix keeping the mention', edit('<@USELF> chek', '<@USELF> check')],
      ['mention removed', edit('<@USELF> 확인', '확인')],
      ['alias added without a mention', edit('확인해 주세요', 'typeclaw 확인해 주세요')],
      ['metadata-only edit', edit('<@USELF> link', '<@USELF> link')],
    ]
    for (const [label, input] of cases) {
      expect([label, classifyInbound(input, config, context)]).toEqual([
        label,
        { kind: 'drop', reason: 'edit_without_new_mention' },
      ])
    }
  })

  test('edits without provable previous body or a valid edit revision drop', () => {
    const cases: Array<[string, SlackInboundMessageEvent]> = [
      ['missing previous_message', edit('q', '<@USELF> q', { previous_message: undefined })],
      ['previous body without text', edit('q', '<@USELF> q', { previous: { text: undefined } })],
      ['unfurl update without edited', edit('q', '<@USELF> q', { message: { edited: undefined } })],
      ['malformed edit revision', edit('q', '<@USELF> q', { message: { edited: { ts: 42 } } })],
      ['flattened edited copy', event({ text: '<@USELF> 확인', edited: { user: 'UUSER', ts: EDIT_TS } })],
    ]
    for (const [label, input] of cases) {
      expect([label, classifyInbound(input, config, context)]).toEqual([
        label,
        { kind: 'drop', reason: 'unverified_edit' },
      ])
    }
  })

  test('self-authored edits keep the self floor', () => {
    expect(classifyInbound(edit('memo', '<@USELF> memo', { message: { user: 'USELF' } }), config, context)).toEqual({
      kind: 'drop',
      reason: 'self_author',
    })
  })

  test('edit-derived slash commands and claim codes drop as control; originals still reach the router', () => {
    for (const text of ['/help <@USELF>', '/reload <@USELF>', '<@USELF> claim-AB12-CD34']) {
      expect([text, classifyInbound(edit(text.replace('<@USELF>', '').trim(), text), config, context)]).toEqual([
        text,
        { kind: 'drop', reason: 'edited_control' },
      ])
      expect(classifyInbound(event({ text }), config, context).kind).toBe('route')
    }
    expect(classifyInbound(edit('//help', '//help <@USELF>'), config, context).kind).toBe('route')
  })
})
