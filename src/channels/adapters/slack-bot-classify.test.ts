import { describe, expect, test } from 'bun:test'

import { decideEngagement, StickyLedger } from '@/channels/engagement'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import { isDmChannelOrigin } from '@/permissions'

import { classifyInbound, type SlackInboundMessageEvent } from './slack-bot-classify'

const TEAM_ID = 'T0ACME'
const BOT_USER_ID = 'UBOT'

const baseConfig: ChannelAdapterConfig = {
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
}

function buildEvent(overrides: Partial<SlackInboundMessageEvent> = {}): SlackInboundMessageEvent {
  return {
    type: 'message',
    channel: 'C0CHANNEL',
    channel_type: 'channel',
    user: 'UALICE',
    text: 'hello',
    ts: '1700000000.000100',
    ...overrides,
  }
}

const EDIT_TS = '1700000060.000200'

type EditOverrides = {
  message?: Record<string, unknown>
  previous?: Record<string, unknown>
  envelope?: Record<string, unknown>
}

// Socket Mode `message_changed` envelope as Slack delivers it: the nested
// message keeps its original ts and gains `edited`, the previous body sits in
// `previous_message`, and the envelope has its own ts.
function editEnvelope(previousText: string, text: string, over: EditOverrides = {}): SlackInboundMessageEvent {
  const original = buildEvent({ client_msg_id: 'gesture-1' })
  return {
    type: 'message',
    subtype: 'message_changed',
    channel: original.channel,
    channel_type: original.channel_type,
    hidden: true,
    ts: '1700000060.000300',
    event_ts: '1700000060.000300',
    message: { ...original, text, edited: { user: 'UALICE', ts: EDIT_TS }, ...over.message },
    previous_message: { ...original, text: previousText, ...over.previous },
    ...over.envelope,
  }
}

// Shape of a captured edited app_mention (slack-go issue #961): `ts` and
// `event_ts` both carry the original message ts; only `edited.ts` marks the edit.
function editedAppMention(text: string, over: Partial<SlackInboundMessageEvent> = {}): SlackInboundMessageEvent {
  return buildEvent({
    ts: '1628259917.003000',
    event_ts: '1628259917.003000',
    text,
    edited: { user: 'UALICE', ts: '1628260114.000000' },
    ...over,
  })
}

describe('slack-bot classifyInbound — edits', () => {
  const context = { teamId: TEAM_ID, botUserId: BOT_USER_ID }
  const appMention = { ...context, source: 'app_mention' as const }

  test('a freshly added English or Korean self mention routes as the original message', () => {
    for (const [before, after] of [
      ['please check the deploy', '<@UBOT> please check the deploy'],
      ['배포 확인해 주세요', '<@UBOT> 배포 확인해 주세요'],
    ] as const) {
      const verdict = classifyInbound(editEnvelope(before, after), baseConfig, context)

      expect(verdict.kind).toBe('route')
      if (verdict.kind !== 'route') throw new Error('expected route')
      expect(verdict.payload).toMatchObject({
        text: after,
        externalMessageId: '1700000000.000100',
        revision: 'original',
        accountIdentity: `slack-bot:${TEAM_ID}:${BOT_USER_ID}`,
        authorId: 'UALICE',
        isBotMention: true,
        thread: '1700000000.000100',
      })
    }
  })

  test('a freshly added group mention routes like an original group mention', () => {
    const verdict = classifyInbound(editEnvelope('배포 확인', '<!here> 배포 확인'), baseConfig, context)

    expect(verdict.kind === 'route' && verdict.payload.isBotMention).toBe(true)
  })

  test('edits that do not newly address the bot are not new inbounds', () => {
    const cases: Array<[string, SlackInboundMessageEvent]> = [
      ['DM typo fix', editEnvelope('helo', 'hello', { envelope: { channel_type: 'im', channel: 'D0DM' } })],
      ['Korean DM typo fix', editEnvelope('안녕하세여', '안녕하세요', { envelope: { channel_type: 'im' } })],
      ['typo fix keeping the mention', editEnvelope('<@UBOT> chek this', '<@UBOT> check this')],
      ['self mention after a group mention', editEnvelope('<!here> 질문', '<!here> <@UBOT> 질문')],
      ['mention removed', editEnvelope('<@UBOT> 확인해줘', '확인해줘')],
      ['mention of someone else added', editEnvelope('question', '<@UOTHER> question')],
      ['metadata-only edit', editEnvelope('<@UBOT> see link', '<@UBOT> see link')],
    ]
    for (const [label, event] of cases) {
      expect([label, classifyInbound(event, baseConfig, context)]).toEqual([
        label,
        { kind: 'drop', reason: 'edit_without_new_mention' },
      ])
    }
  })

  test('edits without provable previous body or a valid edit marker drop', () => {
    const cases: Array<[string, SlackInboundMessageEvent, typeof context & { source?: 'app_mention' }]> = [
      [
        'missing previous_message',
        editEnvelope('q', '<@UBOT> q', { envelope: { previous_message: undefined } }),
        context,
      ],
      ['previous body without text', editEnvelope('q', '<@UBOT> q', { previous: { text: undefined } }), context],
      [
        'previous body of another message',
        editEnvelope('q', '<@UBOT> q', { previous: { ts: '1700000000.000999' } }),
        context,
      ],
      ['unfurl update without edited', editEnvelope('q', '<@UBOT> q', { message: { edited: undefined } }), context],
      ['empty edit revision', editEnvelope('q', '<@UBOT> q', { message: { edited: { user: 'U', ts: '' } } }), context],
      ['non-ts edit revision', editEnvelope('q', '<@UBOT> q', { message: { edited: { ts: 'yesterday' } } }), context],
      [
        'edit revision equal to message ts',
        editEnvelope('q', '<@UBOT> q', { message: { edited: { user: 'UALICE', ts: '1700000000.000100' } } }),
        context,
      ],
      ['missing nested message', editEnvelope('q', '<@UBOT> q', { envelope: { message: undefined } }), context],
      ['flattened edited message copy', editedAppMention('<@UBOT> 확인'), context],
      [
        'app_mention with a malformed edited marker',
        editedAppMention('<@UBOT> 확인', { edited: { user: 'UALICE', ts: '1628259917.003000' } }),
        appMention,
      ],
    ]
    for (const [label, event, ctx] of cases) {
      expect([label, classifyInbound(event, baseConfig, ctx)]).toEqual([
        label,
        { kind: 'drop', reason: 'unverified_edit' },
      ])
    }
  })

  test('an edited app_mention addressing the bot may engage once without the previous body', () => {
    for (const text of ['<@UBOT> please review', '<@UBOT> 리뷰 부탁해요']) {
      const verdict = classifyInbound(editedAppMention(text), baseConfig, appMention)

      expect(verdict.kind).toBe('route')
      if (verdict.kind !== 'route') throw new Error('expected route')
      expect(verdict.payload).toMatchObject({
        externalMessageId: '1628259917.003000',
        revision: 'original',
        authorId: 'UALICE',
        isBotMention: true,
      })
    }
  })

  test('an app_mention without an edited marker stays on the original path', () => {
    const verdict = classifyInbound(
      buildEvent({ text: '<@UBOT> 안녕', ts: '1628259917.003000' }),
      baseConfig,
      appMention,
    )

    expect(verdict.kind === 'route' && verdict.payload.revision).toBe('original')
  })

  test('edit-derived slash commands and claim codes drop as control; originals still route to the router', () => {
    const controls = ['/help <@UBOT>', '/stop <@UBOT>', '<@UBOT> claim-AB12-CD34']
    for (const text of controls) {
      const raw = editEnvelope(text.replace('<@UBOT>', '').trim(), text)
      expect([text, classifyInbound(raw, baseConfig, context)]).toEqual([
        text,
        { kind: 'drop', reason: 'edited_control' },
      ])
      expect([text, classifyInbound(editedAppMention(text), baseConfig, appMention)]).toEqual([
        text,
        { kind: 'drop', reason: 'edited_control' },
      ])
      expect(classifyInbound(buildEvent({ text }), baseConfig, context).kind).toBe('route')
    }
    for (const text of ['//help <@UBOT>', '<@UBOT> !deploy now']) {
      expect([text, classifyInbound(editedAppMention(text), baseConfig, appMention).kind]).toEqual([text, 'route'])
    }
  })

  test('self-authored or pre-connect edits keep the existing floors', () => {
    const selfEdit = editEnvelope('note', '<@UBOT> note', { message: { user: BOT_USER_ID } })

    expect(classifyInbound(selfEdit, baseConfig, context)).toEqual({ kind: 'drop', reason: 'self_author' })
    expect(classifyInbound(editEnvelope('q', '<@UBOT> q'), baseConfig, { ...context, botUserId: null })).toEqual({
      kind: 'drop',
      reason: 'pre_connect',
    })
    expect(classifyInbound(editedAppMention('<@UBOT> q'), baseConfig, { ...appMention, botUserId: null })).toEqual({
      kind: 'drop',
      reason: 'pre_connect',
    })
  })
})

describe('slack-bot classifyInbound — drop paths', () => {
  test('drops self-authored messages (event.user === botUserId) with reason=self_author', () => {
    const event = buildEvent({ user: BOT_USER_ID })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops events with no user (e.g. system events) with reason=no_user', () => {
    const event = buildEvent({ user: undefined })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'no_user' })
  })

  test('drops Slack system subtypes with a user because they are not replyable messages', () => {
    const event = buildEvent({ subtype: 'channel_topic', text: 'set the channel topic:\nProject updates' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'slack_system_message' })
  })

  test('drops messages with neither text nor files with reason=empty_text', () => {
    const event = buildEvent({ text: '' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_text' })
  })

  test('routes share-only messages so reference enrichment can surface the quoted attachment text', () => {
    const event = buildEvent({
      text: '',
      attachments: [
        {
          is_share: true,
          author_id: 'UALICE',
          author_name: 'Alice',
          channel_name: 'general',
          ts: '1700000000.000050',
          text: 'shared context',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('')
  })

  test('routes file-only uploads (empty text) with attachment summary so the agent sees the upload', () => {
    const event = buildEvent({
      subtype: 'file_share',
      text: '',
      files: [
        {
          id: 'F1',
          name: 'diagram.png',
          title: 'diagram',
          mimetype: 'image/png',
          size: 1234,
          url_private: 'https://files.slack.com/f/F1/diagram.png',
          created: 1700000000,
          user: 'UALICE',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Slack attachment #1: file image/png name=diagram.png]')
    expect(verdict.payload.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'F1', filename: 'diagram.png', mimetype: 'image/png' },
    ])
  })

  test('appends attachment summary to user text so the agent sees BOTH text and the file when the user typed something alongside the upload', () => {
    const event = buildEvent({
      subtype: 'file_share',
      text: 'look at this',
      files: [
        {
          id: 'F1',
          name: 'diagram.png',
          title: 'diagram',
          mimetype: 'image/png',
          size: 1234,
          url_private: 'https://files.slack.com/f/F1/diagram.png',
          created: 1700000000,
          user: 'UALICE',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('look at this\n[Slack attachment #1: file image/png name=diagram.png]')
    expect(verdict.payload.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'F1', filename: 'diagram.png', mimetype: 'image/png' },
    ])
  })

  test('multiple file uploads each surface as a separate attachment ref so the agent can fetch any of them', () => {
    const event = buildEvent({
      text: '',
      files: [
        {
          id: 'F1',
          name: 'one.png',
          title: 'one',
          mimetype: 'image/png',
          size: 1,
          url_private: 'https://files.slack.com/f/F1/one.png',
          created: 1700000000,
          user: 'UALICE',
        },
        {
          id: 'F2',
          name: 'two.txt',
          title: 'two',
          mimetype: 'text/plain',
          size: 2,
          url_private: 'https://files.slack.com/f/F2/two.txt',
          created: 1700000001,
          user: 'UALICE',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe(
      '[Slack attachment #1: file image/png name=one.png]\n[Slack attachment #2: file text/plain name=two.txt]',
    )
    expect(verdict.payload.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'F1', filename: 'one.png', mimetype: 'image/png' },
      { id: 2, kind: 'file', ref: 'F2', filename: 'two.txt', mimetype: 'text/plain' },
    ])
  })

  test('appended attachment summary does not register `<@…>` ids inside file URLs as bot mentions', () => {
    const event = buildEvent({
      text: 'check this',
      files: [
        {
          id: 'F1',
          name: 'note.txt',
          title: 'note',
          mimetype: 'text/plain',
          size: 1,
          url_private: `https://files.slack.com/<@${BOT_USER_ID}>/F1/note.txt`,
          created: 1700000000,
          user: 'UALICE',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('drops messages before bot identity is known with reason=pre_connect', () => {
    const event = buildEvent({ text: 'no explicit mention' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: null })

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })
})

describe('slack-bot classifyInbound — peer-bot routing', () => {
  test('routes a peer bot with bot_id set and authorIsBot=true', () => {
    const event = buildEvent({ user: 'UPEERBOT', bot_id: 'B999', text: 'hello from peer' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(true)
    expect(verdict.payload.authorId).toBe('UPEERBOT')
  })

  test('routes a peer bot with subtype=bot_message and a user, with authorIsBot=true', () => {
    const event = buildEvent({ user: 'UPEERBOT', subtype: 'bot_message', text: 'announcement' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(true)
  })

  test('routes a human message with authorIsBot=false', () => {
    const event = buildEvent({ user: 'UALICE', text: 'hello team' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(false)
  })

  test('still drops self even when bot_id is also set (self check comes first)', () => {
    const event = buildEvent({ user: BOT_USER_ID, bot_id: 'B-self' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('routes a bot_message subtype with NO user as no_user (still drops, but for the right reason)', () => {
    const event = buildEvent({ user: undefined, subtype: 'bot_message', bot_id: 'B999' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'no_user' })
  })
})

describe('slack-bot classifyInbound — route path', () => {
  test('routes a top-level team channel mention into a thread rooted at that message', () => {
    const event = buildEvent({ text: `hi <@${BOT_USER_ID}>` })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe(event.ts)
    expect(verdict.payload.room).toEqual({ kind: 'thread' })
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.isDm).toBe(false)
  })

  test('non-mention team messages route with isBotMention=false', () => {
    const event = buildEvent({ text: 'good morning team' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.thread).toBeNull()
  })

  test('a flat channel message carries no room signal', () => {
    const event = buildEvent({ text: 'good morning team' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.room).toBeUndefined()
  })

  test('a thread reply is stamped with a thread room signal', () => {
    const event = buildEvent({ text: 'a reply in the thread', thread_ts: '1700000000.000100' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.room).toEqual({ kind: 'thread' })
  })

  test('routes /me messages that mention the bot because they are user-authored messages', () => {
    const event = buildEvent({ subtype: 'me_message', text: `waves at <@${BOT_USER_ID}>` })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.text).toBe(`waves at <@${BOT_USER_ID}>`)
  })

  test('top-level alias-only addressing anchors thread on the inbound ts so the bot can reply in-thread', () => {
    // given: a top-level message with no @mention and no thread_ts, but
    // containing one of the bot's plain-text aliases. Slack treats this
    // as an isolated channel post; without anchoring `thread` here, the
    // bot's reply would post as another top-level message, fragmenting
    // the conversation. Anchoring on `event.ts` lets the outbound
    // callback set `thread_ts` and turn the bot's reply into the first
    // thread reply under the user's message — same conversational
    // affordance as a Slack-native @mention.
    const event = buildEvent({ text: '모모야 안녕' })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['모모', 'momo'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.thread).toBe('1700000000.000100')
  })

  test('alias matching is case-insensitive and substring-based, mirroring the engagement layer', () => {
    const event = buildEvent({ text: 'MoMo please look at this' })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['momo'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
  })

  test('an existing thread_ts always wins over alias anchoring (sanity check on the `??` short-circuit)', () => {
    // This is intentionally not a strong mutation guard for the alias
    // branch — the `event.thread_ts ?? ...` short-circuit at the head of
    // the thread expression means an inbound that already has a
    // thread_ts is preserved regardless of what the right-hand-side
    // does. Kept as a guard against someone "simplifying" by inverting
    // the precedence (e.g. anchoring on event.ts whenever an alias
    // matches, even mid-thread, which would silently re-root replies).
    const event = buildEvent({
      text: '모모 in this thread',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
      parent_user_id: 'UCAROL',
    })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['모모'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
  })

  test('alias-only addressing in a DM does NOT anchor a thread (DMs are flat)', () => {
    const event = buildEvent({ channel_type: 'im', channel: 'D0DM', text: '모모야' })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['모모'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBeNull()
  })

  test('a flat DM anchors typingThread on the inbound ts so the status can render', () => {
    const event = buildEvent({ channel_type: 'im', channel: 'D0DM', text: 'private hi' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBeNull()
    expect(verdict.payload.typingThread).toBe('1700000000.000100')
  })

  test('a non-DM message carries no typingThread (the channel typing path uses thread)', () => {
    const event = buildEvent({ text: 'just chatting' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.typingThread).toBeUndefined()
  })

  test('a DM already in a thread does not override typingThread (thread drives status)', () => {
    const event = buildEvent({
      channel_type: 'im',
      channel: 'D0DM',
      text: 'in a thread',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.typingThread).toBeUndefined()
  })

  test('non-mention team message with no alias match leaves thread null (existing behavior)', () => {
    const event = buildEvent({ text: 'just chatting' })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['모모'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBeNull()
  })

  test('DMs (channel_type=im) route with workspace=@dm and isDm=true', () => {
    const event = buildEvent({ channel_type: 'im', channel: 'D0DMID', text: 'private hi' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({ workspace: '@dm', chat: 'D0DMID', isDm: true })
  })

  test('MPIM group DMs retain team, grant, and multi-human engagement semantics', () => {
    const event = buildEvent({ channel_type: 'mpim', channel: 'G0MPIM', text: '여러분 안녕하세요' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({ workspace: TEAM_ID, chat: 'G0MPIM', isDm: false })
    expect(isDmChannelOrigin(verdict.payload)).toBe(false)
    expect(
      decideEngagement({
        message: verdict.payload,
        config: { trigger: ['dm'], stickiness: 'off' },
        key: `slack-bot:${TEAM_ID}:G0MPIM:`,
        ledger: new StickyLedger(),
        now: 0,
        participants: [],
        membership: { humans: 3, bots: 1, fetchedAt: 0, truncated: false },
        selfAliases: [],
        botInThread: false,
      }),
    ).toBe('observe')
  })

  test('thread reply to the bot surfaces thread_ts as both thread and replyToBotMessageId', () => {
    const event = buildEvent({
      text: 'thanks',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
      parent_user_id: BOT_USER_ID,
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.replyToBotMessageId).toBe('1700000000.000100')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('thread reply between humans (parent is a human) sets replyToOtherMessageId, not replyToBotMessageId', () => {
    const event = buildEvent({
      user: 'UALICE',
      text: 'i agree',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
      parent_user_id: 'UCAROL',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBe('1700000000.000100')
  })

  test('thread reply with no parent_user_id leaves both reply fields null (refuses to guess)', () => {
    const event = buildEvent({
      text: 'reply with unknown parent',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('parent message of a thread (ts === thread_ts) does not register as a reply', () => {
    const event = buildEvent({
      text: 'starting a thread',
      ts: '1700000000.000100',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('drops thread replies before bot identity is known (cannot classify parent target safely)', () => {
    const event = buildEvent({
      text: 'reply',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: null })

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })
})

describe('slack-bot classifyInbound — targets-others detection', () => {
  test('marks mentionsOthers=true when text mentions a non-bot user only', () => {
    const event = buildEvent({ text: 'hey <@UBOB> can you check this?' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(true)
  })

  test('marks mentionsOthers=false when the bot is among the mentioned users', () => {
    const event = buildEvent({ text: `<@UBOB> <@${BOT_USER_ID}> please weigh in` })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('marks mentionsOthers=false when the message has no mentions at all', () => {
    const event = buildEvent({ text: 'just some chatter' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('parses the labelled mention form `<@U…|name>` correctly', () => {
    const event = buildEvent({ text: 'cc <@UBOB|bob>' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(true)
  })

  test('drops mentioned messages during the pre-connected race window (botUserId unknown)', () => {
    const event = buildEvent({ text: 'hey <@UBOB>' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: null })

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('Slack does not surface the parent author on inbounds, so replyToOtherMessageId is always null', () => {
    const event = buildEvent({
      text: 'thanks',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })
})

describe('slack-bot classifyInbound — group mentions', () => {
  test.each([
    ['<!here>', '<!here> deploy is starting'],
    ['<!channel>', 'heads up <!channel> — meeting moved'],
    ['<!everyone>', '<!everyone> the building is on fire'],
    ['<!here|here>', '<!here|here> labelled form'],
  ])('treats Slack group mention %s as a bot mention', (_label, text) => {
    const event = buildEvent({ text })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('group mention in a team channel roots a thread at the message ts (same as direct mention)', () => {
    const event = buildEvent({ text: '<!channel> ping' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
  })

  test('does NOT treat <!subteam^ID> as a group mention (would require subteam membership context)', () => {
    const event = buildEvent({ text: '<!subteam^S0ENG|engineering> please review' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('group mention overrides mentionsOthers — bot is included in the broadcast', () => {
    const event = buildEvent({ text: '<!here> <@UBOB> can you take this?' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('non-group "<!" markup (e.g. <!date^…>) does not flip isBotMention', () => {
    const event = buildEvent({ text: 'meeting at <!date^1700000000^{date_short}|Nov 14>' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })
})
