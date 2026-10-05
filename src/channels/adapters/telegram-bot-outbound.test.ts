import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { TelegramBotClient, TelegramMessage } from 'agent-messenger/telegrambot'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { OutboundMessage } from '@/channels/types'

import { createOutboundCallback, createTypingCallback, type TelegramBotAdapterLogger } from './telegram-bot'

function silentLogger(): TelegramBotAdapterLogger & { warns: string[]; errors: string[]; infos: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  return {
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    warns,
    errors,
    infos,
  }
}

function fakeFetch(responder: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(responder(typeof url === 'string' ? url : url.toString(), init))) as typeof fetch
}

const baseConfig: ChannelAdapterConfig = {
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
}

function fakeMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: -100123, type: 'supergroup', title: 'Eng' },
    ...overrides,
  }
}

type SendMessageCall = { chatId: string | number; text: string; options: unknown }
type SendDocumentCall = { chatId: string | number; filePath: string; content?: string }

function fakeClient(): {
  client: Pick<TelegramBotClient, 'sendMessage' | 'sendDocument'>
  sendMessageCalls: SendMessageCall[]
  sendDocumentCalls: SendDocumentCall[]
  setSendMessageBehavior: (fn: () => Promise<TelegramMessage>) => void
  setSendDocumentBehavior: (fn: () => Promise<TelegramMessage>) => void
} {
  const sendMessageCalls: SendMessageCall[] = []
  const sendDocumentCalls: SendDocumentCall[] = []
  let sendMessageImpl: () => Promise<TelegramMessage> = async () => fakeMessage({ message_id: 100 })
  let sendDocumentImpl: () => Promise<TelegramMessage> = async () => fakeMessage({ message_id: 200 })
  const client = {
    sendMessage: async (chatId: string | number, text: string, options?: unknown) => {
      sendMessageCalls.push({ chatId, text, options })
      return sendMessageImpl()
    },
    sendDocument: async (chatId: string | number, filePath: string) => {
      // Read at call time: a staged copy is deleted as soon as the send returns.
      const content = await readFile(filePath, 'utf8').catch(() => undefined)
      sendDocumentCalls.push({ chatId, filePath, ...(content !== undefined ? { content } : {}) })
      return sendDocumentImpl()
    },
  } as unknown as Pick<TelegramBotClient, 'sendMessage' | 'sendDocument'>
  return {
    client,
    sendMessageCalls,
    sendDocumentCalls,
    setSendMessageBehavior: (fn) => {
      sendMessageImpl = fn
    },
    setSendDocumentBehavior: (fn) => {
      sendDocumentImpl = fn
    },
  }
}

function buildOutbound(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    adapter: 'telegram-bot',
    workspace: 'telegram',
    chat: '-100123',
    text: 'hello world',
    ...over,
  }
}

describe('telegram-bot createOutboundCallback', () => {
  test("sends as MarkdownV2 with every reserved char escaped (so Telegram's parser never rejects)", async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ text: 'a < b & c > d (with) raw . ! _ * special chars' }))

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls).toHaveLength(1)
    expect(fake.sendMessageCalls[0]?.text).toBe('a < b & c \\> d \\(with\\) raw \\. \\! \\_ \\* special chars')
    // Mutation guard: if a refactor flips back to plain text or to
    // HTML mode, this fails. MarkdownV2 is the chosen default because
    // it lets the agent's `**bold**` / `*italic*` / `` `code` `` actually
    // render — see the formatter at `./telegram-bot-format.ts`.
    expect(fake.sendMessageCalls[0]?.options).toEqual({ parse_mode: 'MarkdownV2' })
  })

  test('disables Telegram web-page previews for a link-heavy post', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })
    await cb(buildOutbound({ text: 'https://example.org', link_previews: false }))
    expect(fake.sendMessageCalls[0]?.options).toEqual({
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    })
  })

  test('surfaces the posted message_id (stringified) so the agent can thread follow-ups', async () => {
    const fake = fakeClient()
    fake.setSendMessageBehavior(async () => fakeMessage({ message_id: 4242 }))
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ text: 'hi' }))

    expect(result).toEqual({ ok: true, messageId: '4242', messageIds: ['4242'] })
  })

  test('renders agent Markdown (**bold**, *italic*, `code`) into MarkdownV2 entities', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(
      buildOutbound({
        text: 'Ha! See, **yours** works perfectly. *Bold*, *italic*, `code`—all rendered nice.',
      }),
    )

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls[0]?.text).toBe(
      'Ha\\! See, *yours* works perfectly\\. _Bold_, _italic_, `code`—all rendered nice\\.',
    )
    expect(fake.sendMessageCalls[0]?.options).toEqual({ parse_mode: 'MarkdownV2' })
  })

  test('forwards a numeric thread id as message_thread_id when the session is in a forum topic', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ thread: '42' }))

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls[0]?.options).toEqual({ message_thread_id: 42, parse_mode: 'MarkdownV2' })
  })

  test('drops invalid thread ids silently rather than passing NaN', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ thread: 'not-a-number' }))

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls[0]?.options).toEqual({ parse_mode: 'MarkdownV2' })
  })

  test('forwards replyTo as reply_to_message_id so the bot uses Telegram native reply', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ replyTo: { externalMessageId: '57' } }))

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls[0]?.options).toEqual({ reply_to_message_id: 57, parse_mode: 'MarkdownV2' })
  })

  test('drops a non-numeric replyTo id rather than passing NaN', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ replyTo: { externalMessageId: 'not-a-number' } }))

    expect(result.ok).toBe(true)
    expect(fake.sendMessageCalls[0]?.options).toEqual({ parse_mode: 'MarkdownV2' })
  })

  test('uploads each attachment via sendDocument BEFORE posting text', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(
      buildOutbound({
        text: 'see file',
        attachments: [{ path: '/agent/workspace/spec.pdf' }],
      }),
    )

    expect(result.ok).toBe(true)
    expect(fake.sendDocumentCalls).toEqual([{ chatId: '-100123', filePath: '/agent/workspace/spec.pdf' }])
    expect(fake.sendMessageCalls).toHaveLength(1)
    expect(fake.sendMessageCalls[0]?.text).toBe('see file')
  })

  test('uploads from a copy named after the filename override, then removes the copy', async () => {
    // given a scratch-named file the agent wants shown as "보고서.pdf"
    const fake = fakeClient()
    const dir = await mkdtemp(join(tmpdir(), 'telegram-outbound-'))
    const path = join(dir, 'tmp-3f9a2.pdf')
    await writeFile(path, 'report body')
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    // when
    const result = await cb(buildOutbound({ text: '', attachments: [{ path, filename: '보고서.pdf' }] }))

    // then Telegram sees the override as the basename, with the original bytes
    expect(result.ok).toBe(true)
    const call = fake.sendDocumentCalls[0]
    expect(call?.filePath === undefined ? '' : basename(call.filePath)).toBe('보고서.pdf')
    expect(call?.content).toBe('report body')
    expect(await readFile(call?.filePath ?? '').catch(() => null)).toBeNull()
    expect(await readFile(path, 'utf8')).toBe('report body')
  })

  test('uploads the original path when the filename override matches its basename', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    await cb(buildOutbound({ text: '', attachments: [{ path: '/agent/workspace/spec.pdf', filename: 'spec.pdf' }] }))

    expect(fake.sendDocumentCalls.map((c) => c.filePath)).toEqual(['/agent/workspace/spec.pdf'])
  })

  test('warns when an attachment is sent in a forum topic (sendDocument cannot route to topic)', async () => {
    const fake = fakeClient()
    const logger = silentLogger()
    const cb = createOutboundCallback({
      client: fake.client,
      logger,
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(
      buildOutbound({
        thread: '42',
        attachments: [{ path: '/agent/workspace/file.txt' }],
      }),
    )

    expect(result.ok).toBe(true)
    expect(logger.warns.some((m) => m.includes('landed in chat root, not topic 42'))).toBe(true)
  })

  test('does NOT warn about topic routing for attachments when the session is not in a topic', async () => {
    const fake = fakeClient()
    const logger = silentLogger()
    const cb = createOutboundCallback({
      client: fake.client,
      logger,
      formatChannelTag: async () => 'chat=-100123',
    })

    await cb(buildOutbound({ attachments: [{ path: '/x' }] }))

    expect(logger.warns.filter((m) => m.includes('landed in chat root'))).toHaveLength(0)
  })

  test('aborts before posting text when an upload fails (file is the load-bearing piece)', async () => {
    const fake = fakeClient()
    fake.setSendDocumentBehavior(async () => {
      throw new Error('upload failed: 413 too large')
    })
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(
      buildOutbound({
        text: 'context',
        attachments: [{ path: '/x' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('sendDocument failed')
    expect(fake.sendMessageCalls).toHaveLength(0)
  })

  test('removes the staged copy and keeps the source when a renamed upload fails', async () => {
    // given a renamed attachment whose upload Telegram rejects
    const fake = fakeClient()
    fake.setSendDocumentBehavior(async () => {
      throw new Error('upload failed: 413 too large')
    })
    const dir = await mkdtemp(join(tmpdir(), 'telegram-outbound-'))
    const path = join(dir, 'tmp-3f9a2.pdf')
    await writeFile(path, 'report body')
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    // when
    const result = await cb(buildOutbound({ text: 'context', attachments: [{ path, filename: '보고서.pdf' }] }))

    // then the error surfaces, no text posts, the staged dir is gone, the source is intact
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('sendDocument failed')
    expect(fake.sendMessageCalls).toHaveLength(0)
    const stagedPath = fake.sendDocumentCalls[0]?.filePath ?? ''
    expect(basename(stagedPath)).toBe('보고서.pdf')
    expect(await stat(dirname(stagedPath)).catch(() => null)).toBeNull()
    expect(await readFile(path, 'utf8')).toBe('report body')
  })

  test('refuses outbound with neither text nor attachments', async () => {
    const fake = fakeClient()
    const cb = createOutboundCallback({
      client: fake.client,
      logger: silentLogger(),
      formatChannelTag: async () => 'chat=-100123',
    })

    const result = await cb(buildOutbound({ text: '' }))

    expect(result.ok).toBe(false)
    expect(fake.sendMessageCalls).toHaveLength(0)
  })
})

describe('telegram-bot createTypingCallback', () => {
  test('POSTs sendChatAction with the chat_id and action=typing', async () => {
    const seen: Array<{ url: string; body: string }> = []
    const cb = createTypingCallback({
      token: 'TGTOKEN',
      logger: silentLogger(),
      fetchImpl: fakeFetch((url, init) => {
        seen.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: null, phase: 'tick' })

    expect(seen[0]?.url).toBe('https://api.telegram.org/botTGTOKEN/sendChatAction')
    const body = JSON.parse(seen[0]!.body) as { chat_id: string; action: string; message_thread_id?: number }
    expect(body.chat_id).toBe('-100123')
    expect(body.action).toBe('typing')
    expect(body.message_thread_id).toBeUndefined()
  })

  test('forwards a valid numeric thread id as message_thread_id', async () => {
    const seen: Array<{ body: string }> = []
    const cb = createTypingCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch((_url, init) => {
        seen.push({ body: typeof init?.body === 'string' ? init.body : '' })
        return new Response('{}', { status: 200 })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: '7', phase: 'tick' })

    const body = JSON.parse(seen[0]!.body) as { message_thread_id?: number }
    expect(body.message_thread_id).toBe(7)
  })

  test('omits message_thread_id when the thread string is non-numeric (no NaN payload)', async () => {
    const seen: Array<{ body: string }> = []
    const cb = createTypingCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch((_url, init) => {
        seen.push({ body: typeof init?.body === 'string' ? init.body : '' })
        return new Response('{}', { status: 200 })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: 'oops', phase: 'tick' })

    const body = JSON.parse(seen[0]!.body) as { message_thread_id?: number; chat_id: string }
    expect(body.message_thread_id).toBeUndefined()
    expect(body.chat_id).toBe('-100123')
  })

  test('no-ops on phase=stop (Telegram has no explicit clear; auto-expires after ~5s)', async () => {
    let fetchCalled = false
    const cb = createTypingCallback({
      token: 'T',
      logger: silentLogger(),
      fetchImpl: fakeFetch(() => {
        fetchCalled = true
        return new Response('{}', { status: 200 })
      }),
    })

    await cb({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', thread: null, phase: 'stop' })

    expect(fetchCalled).toBe(false)
  })
})
