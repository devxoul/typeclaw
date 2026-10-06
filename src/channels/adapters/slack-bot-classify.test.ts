import { describe, expect, test } from 'bun:test'

import { decideEngagement, StickyLedger } from '@/channels/engagement'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import { isDmChannelOrigin } from '@/permissions'

import { classifyInbound, type SlackInboundMessageEvent } from './slack-bot-classify'
import { createSlackDedupe } from './slack-bot-dedupe'
import { normalizeSlackInbound } from './slack-inbound-revision'

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

test('a mention added by editing an observed message remains a distinct engageable revision', () => {
  const original = buildEvent({ text: '안녕하세요', client_msg_id: 'gesture-1' })
  const context = { teamId: TEAM_ID, botUserId: BOT_USER_ID }
  const before = classifyInbound(original, baseConfig, context)
  expect(before.kind).toBe('route')
  if (before.kind !== 'route') throw new Error('Expected original message')
  expect(before.payload.isBotMention).toBe(false)
  const dedupe = createSlackDedupe()
  dedupe.mark(original, before.payload.isBotMention)
  const edited = normalizeSlackInbound({
    ...original,
    user: undefined,
    subtype: 'message_changed',
    ts: '1700000001.000100',
    message: { ...original, text: '<@UBOT> 확인해줘', edited: { ts: '1700000001.000099' } },
  })
  const after = classifyInbound(edited, baseConfig, context)
  if (after.kind !== 'route') throw new Error('Expected edited message')
  expect(after.payload.isBotMention).toBe(true)
  expect(dedupe.check(edited, after.payload.isBotMention)).toBeNull()
  expect(after.payload.externalMessageId).toBe(before.payload.externalMessageId)
  expect(after.payload.revision).toBe('1700000001.000099')
  expect(after.payload.accountIdentity).toBe(`slack-bot:${TEAM_ID}:${BOT_USER_ID}`)
  dedupe.mark(edited, after.payload.isBotMention)
  expect(dedupe.check(edited, after.payload.isBotMention)).not.toBeNull()
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
