import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LIVE_TURN_ENDED_NOTICE_TEXT, RECOVERY_NOTICE_TEXT } from '@/channels/continuity-types'
import { RecoveryOutbox } from '@/channels/recovery-outbox'

// Production composition proof: every boot is a separate process running the
// real `startAgent` (buildChannelSessionFactory, router, inbound journal,
// background store, recovery outbox, dispatcher and maintenance wiring). Only
// the provider HTTP boundary and the discord-bot transport are controlled: the
// injected channel manager is the real `createChannelManager` fed the exact
// services `startAgent` supplied, with a fake adapter that registers outbound
// and recovery callbacks the way the real adapter does. HOME/TYPECLAW_HOME and
// the agent directory are temporary; every key is a dummy and non-provider
// network access is refused.
const root = join(import.meta.dir, '../..')
const MARK = '@@continuity '
const worker = `
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { createChannelManager } from './src/channels/manager.ts';
import { reloadConfig } from './src/config/config.ts';
import { exportGithubCliStoreForAgent } from './src/secrets/index.ts';
import { startAgent } from './src/run/index.ts';
const [dir, mode, scenario] = process.argv.slice(-3);
const MARK = ${JSON.stringify(MARK)};
const forever = Bun.stdin.text();
const stopAt = async (name) => { console.log(MARK + JSON.stringify({ boundary: name })); await forever; throw Error('boundary resumed') };
const record = (file, value) => appendFileSync(dir + '/' + file, JSON.stringify(value) + '\\n');
const lines = (file) => { try { return readFileSync(dir + '/' + file, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] } };
const until = async (label, check, ms = 45_000) => { const end = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > end) throw Error('timed out waiting for ' + label); await Bun.sleep(25) } };
process.chdir(dir);
reloadConfig(dir);
const live = mode === 'live';
const korean = scenario.endsWith('-ko');
const ask = korean ? '빌드 상태 확인해 줄 수 있어?' : 'Can you check the build status?';
const progress = korean ? '확인해볼게요.' : 'Let me check that.';
const welcome = "You're welcome.";
const sse = (block, stop) => new Response([
 'event: message_start','data: '+JSON.stringify({type:'message_start',message:{id:'msg_'+Date.now(),type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}),'',
 'event: content_block_start','data: '+JSON.stringify({type:'content_block_start',index:0,content_block:block.type==='text'?{type:'text',text:''}:{type:'tool_use',id:'tool_'+Date.now(),name:block.name,input:{}}}),'',
 'event: content_block_delta','data: '+JSON.stringify({type:'content_block_delta',index:0,delta:block.type==='text'?{type:'text_delta',text:block.text}:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}}),'',
 'event: content_block_stop','data: {"type":"content_block_stop","index":0}','',
 'event: message_delta','data: '+JSON.stringify({type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}}),'',
 'event: message_stop','data: {"type":"message_stop"}',''].join('\\n'),{headers:{'content-type':'text/event-stream'}});
const reply = (text, more) => sse({ type: 'tool_use', name: 'channel_reply', input: { text, more_work_this_turn: more } }, 'tool_use');
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/v1/messages')) { record('foreign-fetch', { mode, url }); throw new TypeError('network disabled in continuity proof') }
  const raw = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
  const body = JSON.parse(raw || '{}');
  // Plugin/background model calls are not channel turns; they never answer a user.
  if (!(body.tools ?? []).some((tool) => tool.name === 'channel_reply')) { record('aux-provider-calls', { mode }); return sse({ type: 'text', text: 'NO_REPLY' }, 'end_turn') }
  const conversation = JSON.stringify(body.messages ?? []);
  record('provider-calls', { mode, thanks: conversation.includes('Thanks!') });
  if (!live || scenario === 'maintenance') return sse({ type: 'text', text: 'NO_REPLY' }, 'end_turn');
  if (conversation.includes('Thanks!')) return conversation.includes(welcome) ? sse({ type: 'text', text: 'NO_REPLY' }, 'end_turn') : reply(welcome, false);
  if (!conversation.includes(progress)) return reply(progress, true);
  if (scenario.startsWith('provider-error')) return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'controlled provider outage' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  return sse({ type: 'text', text: 'NO_REPLY' }, 'end_turn');
};
const key = { adapter: 'discord-bot', workspace: 'guild', chat: 'room', thread: null };
const event = (id, text, ts) => ({ ...key, accountIdentity: 'proof-account', text, externalMessageId: id, eventKind: 'message', revision: '0', authorId: 'alice', authorName: 'alice', authorIsBot: false, isBotMention: false, isDm: true, mentionsOthers: false, replyToBotMessageId: null, replyToOtherMessageId: null, ts });
let router, services, sent = 0;
const outbound = async (message) => {
  const options = message.sendOptions ?? {};
  const post = { mode, text: message.text ?? '', accounting: options.accounting ?? 'live-turn', deliveryId: options.deliveryId ?? null, coveredIds: options.coveredIds ?? [] };
  record('posts', post);
  // Remote success before the local receipt: the ambiguity the RFC permits.
  if (live && post.accounting === 'recovery' && scenario.startsWith('receipt-')) await stopAt('notice-posted');
  return { ok: true, messageId: 'proof-' + ++sent };
};
const recovery = {
  accountIdentity: async () => 'proof-account',
  cachedAccountIdentity: () => 'proof-account',
  // The controlled platform history: found only when the notice really posted.
  reconcile: async (notice) => scenario === 'receipt-found' && lines('posts').some((post) => post.deliveryId === notice.deliveryId) ? { status: 'found', messageId: 'reconciled' } : { status: 'unreconcilable' },
};
const running = await startAgent({
  port: 0,
  attachTui: false,
  cwd: dir,
  loadCron: async () => ({ ok: true, file: null }),
  exportGithubCliStore: (options) => exportGithubCliStoreForAgent({ ...options, homeDir: process.env.HOME }),
  createChannelManager: (options) => {
    services = options;
    return createChannelManager({
      ...options,
      createDiscordAdapter: (adapterOptions) => {
        router = adapterOptions.router;
        return {
          start: async () => { router.registerOutbound('discord-bot', outbound); router.registerRecoveryAdapter('discord-bot', recovery) },
          stop: async () => { router.unregisterOutbound('discord-bot', outbound); router.unregisterRecoveryAdapter('discord-bot', recovery) },
          isConnected: () => true,
        };
      },
    });
  },
});
const journal = services.inboundJournal, outbox = services.recoveryOutbox;
const snapshot = async () => ({ rows: journal.list(), outbox: await outbox.list() });
const inode = () => { const stats = statSync(journal.path); return { ino: stats.ino, size: stats.size, firstLine: readFileSync(journal.path, 'utf8').split('\\n')[0] } };
if (scenario === 'maintenance') {
  const replay = async (id, ts) => { const receipt = await router.route(event(id, 'replayed ' + id, ts)); await router.__testing.flushDebounce(key); return receipt };
  if (live) {
    // One real routed turn supplies the router-derived admission shape.
    const admissions = [];
    const admit = journal.admit.bind(journal);
    journal.admit = async (input) => { admissions.push(input); return admit(input) };
    const seed = await router.route(event('seed-0', 'seed', 1000));
    await router.__testing.flushDebounce(key);
    await until('seed turn closed', () => journal.get(seed.inputId)?.phase === 'closed');
    // Grow the running journal with closed history until the production
    // maintenance trigger (growth since the last snapshot) compacts it.
    let rows = 0, largest = 0;
    while (!inode().firstLine.includes('"snapshot"')) {
      if (++rows > 5000) throw Error('journal growth never triggered production compaction');
      largest = Math.max(largest, statSync(journal.path).size);
      const admitted = await journal.admit({ ...admissions[0], messageId: 'seed-' + rows });
      await journal.claim(journal.resolve([admitted.inputId]), { turnId: 'seed-turn-' + rows, target: admissions[0].target });
      await journal.settle(journal.resolve([admitted.inputId]), { kind: rows % 2 ? 'delivered' : 'intentionally-suppressed', decisionId: 'seed-outcome-' + rows });
    }
    const compacted = inode();
    // Admitted but never answered when the process dies: owed across restart.
    const open = await journal.admit({ ...admissions[0], messageId: 'open-1' });
    record('maintenance', { mode, rows, largest, compacted, openInput: open.inputId, closedSample: journal.get(seed.inputId) });
    await stopAt('live');
  }
  const { openInput } = lines('maintenance')[0];
  // Polling durable state across a real process boundary: dispatcher lanes run on the platform clock.
  await until('restart recovery acknowledged', () => journal.get(openInput)?.phase === 'closed');
  const before = inode();
  const receipts = [await replay('seed-0', 3000), await replay('seed-1', 3001), await replay('seed-2', 3002), await replay('open-1', 3003)];
  record('maintenance', { mode, before, after: inode(), receipts });
  await running.stop();
  console.log(MARK + 'recovered');
  process.exit(0);
}
if (live) {
  const accepted = await router.route(event('A', ask, 1000));
  record('receipts', { id: 'A', receipt: accepted });
  await router.__testing.flushDebounce(key);
  // The receipt scenarios die inside the notice POST (see outbound).
  if (scenario.startsWith('receipt-')) await forever;
  // A's own logical turn reaches its terminal decision, including delivery of
  // any live-turn notice by the running dispatcher, before C exists.
  await until('A terminal decision', () => journal.get(accepted.inputId)?.phase === 'closed');
  record('after-a', await snapshot());
  const thanks = await router.route(event('C', 'Thanks!', 2000));
  record('receipts', { id: 'C', receipt: thanks });
  await router.__testing.flushDebounce(key);
  await until('C terminal decision', () => journal.get(thanks.inputId)?.phase === 'closed');
  record('live-end', await snapshot());
  await stopAt('live');
}
// Polling durable state across a real process boundary: the dispatcher's
// consistency delay and lane scheduling run on the platform clock.
await until('recovery settled', async () => (await outbox.list()).every((notice) => notice.state === 'delivered') && journal.list().every((row) => row.phase === 'closed'));
record('boot', { mode, ...(await snapshot()) });
await running.stop();
console.log(MARK + 'recovered');
process.exit(0);
`

type Post = { mode: string; text: string; accounting: string; deliveryId: string | null; coveredIds: string[] }

async function newAgent(): Promise<{ dir: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-continuity-agent-'))
  const home = await mkdtemp(join(tmpdir(), 'typeclaw-continuity-home-'))
  await writeFile(
    join(dir, 'typeclaw.json'),
    JSON.stringify({
      models: { default: { model: 'anthropic/claude-sonnet-4-6' } },
      channels: {
        'discord-bot': {
          engagement: { trigger: ['dm'], stickiness: 'off' },
          history: { prefetch: { thread: { head: 0, tail: 0 }, channel: { tail: 0 } } },
        },
      },
      roles: { member: { match: ['discord:*'] } },
    }),
  )
  return { dir, home }
}

const spawnAgent = (agent: { dir: string; home: string }, mode: string, scenario: string) =>
  Bun.spawn([process.execPath, '--eval', worker, agent.dir, mode, scenario], {
    cwd: root,
    // Built from scratch so no operator credential reaches the child.
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: tmpdir(),
      HOME: agent.home,
      TYPECLAW_HOME: join(agent.home, '.typeclaw'),
      ANTHROPIC_API_KEY: 'continuity-proof-dummy',
      FIREWORKS_API_KEY: 'continuity-proof-dummy',
      DISCORD_BOT_TOKEN: 'continuity-proof-dummy',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

async function killAt(agent: { dir: string; home: string }, scenario: string, boundary: string): Promise<void> {
  const child = spawnAgent(agent, 'live', scenario)
  const reader = child.stdout.getReader()
  try {
    let output = ''
    for (;;) {
      const marked = output.split('\n').find((line) => line.startsWith(MARK))
      if (marked) {
        expect(JSON.parse(marked.slice(MARK.length))).toEqual({ boundary })
        break
      }
      const next = await reader.read()
      if (next.done) throw new Error(`agent exited before ${boundary}: ${await new Response(child.stderr).text()}`)
      output += new TextDecoder().decode(next.value)
    }
    child.kill('SIGKILL')
    expect(await child.exited).not.toBe(0)
    if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
  } finally {
    reader.releaseLock()
    child.kill('SIGKILL')
    await child.exited
  }
}

async function reboot(agent: { dir: string; home: string }, mode: string, scenario: string): Promise<void> {
  const child = spawnAgent(agent, mode, scenario)
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${mode} boot failed (${code}): ${errors}`)
  expect(output.split('\n').filter((line) => line.startsWith(MARK))).toEqual([`${MARK}recovered`])
}

const jsonl = async <T>(dir: string, name: string): Promise<T[]> =>
  (await readFile(join(dir, name), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)

// Every id these assertions compare is written by the worker before it is killed
// or exits; a missing one is a broken fixture precondition, never a match.
function recorded<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`continuity worker recorded no ${what}`)
  return value
}

async function cleanup(agent: { dir: string; home: string }): Promise<void> {
  await rm(agent.dir, { recursive: true, force: true })
  await rm(agent.home, { recursive: true, force: true })
}

const PROGRESS = { en: 'Let me check that.', ko: '확인해볼게요.' } as const

for (const language of ['en', 'ko'] as const) {
  test(`startAgent: progress then NO_REPLY (${language}) ends the live turn with one non-restart notice, survives SIGKILL and two boots`, async () => {
    const agent = await newAgent()
    const scenario = `live-ended-${language}`
    try {
      await killAt(agent, scenario, 'live')
      const receipts = await jsonl<{ id: string; receipt: { kind: string; inputId: string } }>(agent.dir, 'receipts')
      expect(receipts.map((entry) => [entry.id, entry.receipt.kind])).toEqual([
        ['A', 'accepted'],
        ['C', 'accepted'],
      ])
      const [a, c] = receipts.map((entry) => entry.receipt.inputId)
      const liveCalls = await jsonl<{ mode: string }>(agent.dir, 'provider-calls')
      const livePosts = await jsonl<Post>(agent.dir, 'posts')
      // The abandoned request was handed to the running dispatcher and posted
      // before the unrelated "Thanks!" turn answered.
      expect(livePosts.map((post) => [post.accounting, post.text])).toEqual([
        ['live-turn', PROGRESS[language]],
        ['recovery', LIVE_TURN_ENDED_NOTICE_TEXT],
        ['live-turn', "You're welcome."],
      ])
      expect(livePosts[1]!.coveredIds).toEqual([recorded(a, 'receipt A inputId')])

      await reboot(agent, 'repair', scenario)
      await reboot(agent, 'second-repair', scenario)

      // Recovery boots never reopen a model turn or repost anything.
      expect(await jsonl(agent.dir, 'provider-calls')).toEqual(liveCalls)
      expect(liveCalls.every((call) => call.mode === 'live')).toBe(true)
      const posts = await jsonl<Post>(agent.dir, 'posts')
      expect(posts).toEqual(livePosts)
      expect(posts.some((post) => post.text === RECOVERY_NOTICE_TEXT)).toBe(false)
      expect(posts.flatMap((post) => post.coveredIds)).not.toContain(c)
      const outbox = new RecoveryOutbox(agent.dir)
      expect(await outbox.list()).toEqual([])
      expect(
        (await outbox.listRetired()).map((retired) => ({
          deliveryId: retired.deliveryId,
          state: retired.dispatch.state,
          attempts: retired.dispatch.attempts,
        })),
      ).toEqual([
        { deliveryId: recorded(livePosts[1]!.deliveryId, 'live notice deliveryId'), state: 'delivered', attempts: 1 },
      ])
    } finally {
      await cleanup(agent)
    }
  }, 180_000)

  test(`startAgent: progress then provider failure (${language}) settles only the failed request on a confirmed notice and never posts a restart notice`, async () => {
    const agent = await newAgent()
    const scenario = `provider-error-${language}`
    try {
      await killAt(agent, scenario, 'live')
      const receipts = await jsonl<{ id: string; receipt: { inputId: string } }>(agent.dir, 'receipts')
      const [a] = receipts.map((entry) => entry.receipt.inputId)
      const [afterA] = await jsonl<{
        rows: Array<{ inputId: string; phase: string; noticeDeliveryId?: string }>
        outbox: unknown[]
      }>(agent.dir, 'after-a')
      expect(afterA!.outbox).toEqual([])
      const failed = afterA!.rows.find((row) => row.inputId === a)
      expect(failed?.phase).toBe('closed')
      expect(failed?.noticeDeliveryId).toBeUndefined()
      const liveCalls = await jsonl(agent.dir, 'provider-calls')

      await reboot(agent, 'repair', scenario)
      await reboot(agent, 'second-repair', scenario)

      expect(await jsonl(agent.dir, 'provider-calls')).toEqual(liveCalls)
      const posts = await jsonl<Post>(agent.dir, 'posts')
      expect(posts.every((post) => post.mode === 'live' && post.accounting === 'live-turn')).toBe(true)
      expect(posts.map((post) => post.text)).toEqual([
        PROGRESS[language],
        expect.stringMatching(/^⚠️ /),
        "You're welcome.",
      ])
      expect(posts.some((post) => post.text === RECOVERY_NOTICE_TEXT)).toBe(false)
      const outbox = new RecoveryOutbox(agent.dir)
      expect(await outbox.list()).toEqual([])
      expect(await outbox.listRetired()).toEqual([])
    } finally {
      await cleanup(agent)
    }
  }, 180_000)
}

for (const reconcile of ['found', 'unreconcilable'] as const) {
  test(`startAgent: live notice remote success before receipt (${reconcile}) is repaired by reboots without work replay`, async () => {
    const agent = await newAgent()
    const scenario = `receipt-${reconcile}`
    try {
      await killAt(agent, scenario, 'notice-posted')
      const liveCalls = await jsonl(agent.dir, 'provider-calls')
      const [a] = (await jsonl<{ receipt: { inputId: string } }>(agent.dir, 'receipts')).map(
        (entry) => entry.receipt.inputId,
      )
      const [pending] = await new RecoveryOutbox(agent.dir).list()
      expect(pending).toMatchObject({ state: 'leased', attempts: 1, text: LIVE_TURN_ENDED_NOTICE_TEXT })
      expect(pending!.covers.map((ref) => ref.id)).toEqual([recorded(a, 'receipt A inputId')])

      await reboot(agent, 'repair', scenario)
      await reboot(agent, 'second-repair', scenario)

      expect(await jsonl(agent.dir, 'provider-calls')).toEqual(liveCalls)
      const posts = await jsonl<Post>(agent.dir, 'posts')
      const notices = posts.filter((post) => post.accounting === 'recovery')
      // Reconciled history proves the first post; otherwise the RFC accepts one
      // at-least-once duplicate. Neither path re-runs work, and the second
      // reboot never posts again.
      expect(notices.map((post) => [post.mode, post.deliveryId, post.text])).toEqual(
        (reconcile === 'found' ? ['live'] : ['live', 'repair']).map((mode) => [
          mode,
          pending!.deliveryId,
          LIVE_TURN_ENDED_NOTICE_TEXT,
        ]),
      )
      expect(posts.filter((post) => post.accounting !== 'recovery').map((post) => post.text)).toEqual([PROGRESS.en])
      const outbox = new RecoveryOutbox(agent.dir)
      expect(await outbox.list()).toEqual([])
      expect((await outbox.listRetired()).map((retired) => [retired.deliveryId, retired.dispatch.state])).toEqual([
        [pending!.deliveryId, 'delivered'],
      ])
    } finally {
      await cleanup(agent)
    }
  }, 180_000)
}

type Inode = { ino: number; size: number; firstLine: string }
type MaintenanceEntry = {
  mode: string
  rows?: number
  largest?: number
  compacted?: Inode
  openInput?: string
  closedSample?: Record<string, unknown>
  before?: Inode
  after?: Inode
  receipts?: Array<{ kind: string; inputId?: string }>
}

// Fields that make a closed row a full admission payload; compacted history must not keep them.
const FULL_ROW_FIELDS = [
  'identity',
  'principal',
  'claim',
  'target',
  'accountIdentity',
  'epoch',
  'sourceParentSessionId',
  'transfer',
]

test('startAgent: production maintenance compacts journal growth, keeps dedupe and owed work through SIGKILL and repeated boots', async () => {
  const agent = await newAgent()
  const scenario = 'maintenance'
  try {
    await killAt(agent, scenario, 'live')
    const [seeded] = await jsonl<MaintenanceEntry>(agent.dir, 'maintenance')
    const liveCalls = await jsonl(agent.dir, 'provider-calls')
    expect(liveCalls).toHaveLength(1)
    // Compaction ran inside the running agent, triggered by journal growth.
    const snapshot = JSON.parse(seeded!.compacted!.firstLine) as {
      type: string
      schemaVersion: number
      closed: Array<Record<string, unknown>>
      decisions: unknown[]
    }
    expect(snapshot).toMatchObject({ type: 'snapshot', schemaVersion: 2, decisions: [] })
    expect(snapshot.closed.length).toBeGreaterThanOrEqual(seeded!.rows! - 1)
    for (const closed of snapshot.closed) for (const field of FULL_ROW_FIELDS) expect(closed).not.toHaveProperty(field)
    for (const field of FULL_ROW_FIELDS) expect(seeded!.closedSample).not.toHaveProperty(field)

    await reboot(agent, 'maintenance-1', scenario)
    await reboot(agent, 'maintenance-2', scenario)
    await reboot(agent, 'maintenance-3', scenario)

    const boots = (await jsonl<MaintenanceEntry>(agent.dir, 'maintenance')).slice(1)
    expect(boots.map((entry) => entry.mode)).toEqual(['maintenance-1', 'maintenance-2', 'maintenance-3'])
    for (const boot of boots) {
      // Growth after the snapshot stays far below the trigger: no rewrite.
      expect(boot.before!.ino).toBe(seeded!.compacted!.ino)
      expect(boot.before!.firstLine).toBe(seeded!.compacted!.firstLine)
      // Closed history keeps dedupe authority; the recovered request keeps its identity.
      expect(boot.receipts!.map((receipt) => receipt.kind)).toEqual([
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
      ])
      expect(boot.receipts![3]!.inputId).toBe(seeded!.openInput)
      // A duplicate appends nothing.
      expect(boot.after!.size).toBe(boot.before!.size)
    }
    // A genuine old-epoch request recovers with the frozen restart notice, once.
    const notices = (await jsonl<Post>(agent.dir, 'posts')).filter((post) => post.accounting === 'recovery')
    expect(notices.map((post) => [post.mode, post.text, post.coveredIds])).toEqual([
      ['maintenance-1', RECOVERY_NOTICE_TEXT, [recorded(seeded!.openInput, 'open inputId')]],
    ])
    const outbox = new RecoveryOutbox(agent.dir)
    expect(await outbox.list()).toEqual([])
    expect((await outbox.listRetired()).map((retired) => retired.deliveryId)).toEqual([
      recorded(notices[0]!.deliveryId, 'restart notice deliveryId'),
    ])
    // Replays never reached the provider.
    expect(await jsonl(agent.dir, 'provider-calls')).toEqual(liveCalls)
  } finally {
    await cleanup(agent)
  }
}, 300_000)
