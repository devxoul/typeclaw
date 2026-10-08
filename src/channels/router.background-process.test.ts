import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundObligationStore } from './background-obligations'
import { LIVE_TURN_ENDED_NOTICE_TEXT, RECOVERY_NOTICE_TEXT } from './continuity-types'
import { RecoveryOutbox } from './recovery-outbox'

const cwd = join(import.meta.dir, '../..')
// Real AgentSession/provider boundary, spawn runner, completion bridge, router,
// dispatcher and durable files; only the provider HTTP and channel transport
// are controlled. Each boot runs in its own process.
const source = `
import { appendFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createSessionWithDispose } from './src/agent/index.ts';
import { reloadConfig } from './src/config/config.ts';
import { LiveSubagentRegistry } from './src/agent/live-subagents.ts';
import { createSpawnSubagentTool } from './src/agent/tools/spawn-subagent.ts';
import { createStream } from './src/stream/index.ts';
import { createSubagentCompletionBridge } from './src/channels/subagent-completion-bridge.ts';
import { LegacyBackgroundHandoffReader } from './src/channels/background-handoff.ts';
import { BackgroundObligationStore } from './src/channels/background-obligations.ts';
import { InboundJournal } from './src/channels/inbound-journal.ts';
import { bootBackgroundObligations } from './src/run/background-handoff-boot.ts';
import { RecoveryOutbox } from './src/channels/recovery-outbox.ts';
import { RecoveryDispatcher } from './src/channels/recovery-dispatcher.ts';
import { createChannelRouter } from './src/channels/router.ts';
import { defaultHistoryConfig } from './src/channels/schema.ts';
import { noopPermissionService } from './src/permissions/index.ts';
const [dir, mode] = process.argv.slice(-2);
process.chdir(dir);
reloadConfig(dir);
process.env.ANTHROPIC_API_KEY = 'crash-proof-key';
const forever = Bun.stdin.text();
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  await appendFile(dir+'/provider-calls',requests+'\\n');
  if(requests>=3&&(mode==='provider-failure'||mode==='provider-notice'))return new Response(JSON.stringify({error:{type:'authentication_error',message:'controlled provider outage'}}),{status:401,headers:{'content-type':'application/json'}});
  if(requests===3)await stopAt();
  const text = requests===1 ? 'NO_REPLY' : 'Result: 42.';
  return new Response([
    'event: message_start',
    'data: '+JSON.stringify({type:'message_start',message:{id:'msg_'+requests,type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}),'',
    'event: content_block_start','data: '+JSON.stringify({type:'content_block_start',index:0,content_block:{type:'text',text:''}}),'',
    'event: content_block_delta','data: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text}}),'',
    'event: content_block_stop','data: {"type":"content_block_stop","index":0}','',
    'event: message_delta','data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}','',
    'event: message_stop','data: {"type":"message_stop"}',''
  ].join('\\n'),{headers:{'content-type':'text/event-stream'}});
};
const initial = !['receipt-death','repair','second-repair'].includes(mode);
const key=mode.includes('review')?{adapter:'github',workspace:'acme/repo',chat:'pr:672',thread:null}:{adapter:'discord-bot',workspace:'guild',chat:'room',thread:null};
const stopAt=async()=>{console.log(JSON.stringify({boundary:mode}));await forever;throw Error('crash boundary resumed without termination');};
// Durable notice ownership: written only after the notice's outbox import, so both have landed.
const noticeOwned=Promise.withResolvers();
const store=new BackgroundObligationStore(dir,{epoch:mode,onDurability:async(phase,row)=>{
  if(phase==='directory-synced'&&(row.phase==='notice-owned'||row.phase==='closed'))noticeOwned.resolve();
  if(phase==='directory-synced'&&((mode==='ready'&&row.phase==='result-ready')||(mode==='claim'&&row.phase==='turn-owned')||(mode.startsWith('settled-')&&row.phase==='closed')))await stopAt();
  if(phase==='temp-synced'&&mode.startsWith('ambiguous-')&&row.phase==='closed')await stopAt();
}});
const journal=new InboundJournal(dir,{backgroundObligations:store});
const stream=createStream();
const live=new LiveSubagentRegistry();
let parent;
const router=createChannelRouter({
  agentDir:dir,backgroundObligations:store,inboundJournal:journal,
  configForAdapter:()=>({enabled:true,engagement:{trigger:['dm'],stickiness:'off'},history:defaultHistoryConfig()}),
  permissions:{...noopPermissionService,has:()=>true},
  logger:{info(){},warn(){},error(m){appendFileSync(dir+'/router-errors',JSON.stringify(m)+'\\n')}},
  createSessionForChannel:async({origin,originRef})=>{
    if(!initial)throw new Error('recovery reopened model session');
    const result=await createSessionWithDispose({sessionManager:SessionManager.create(dir,dir+'/sessions'),systemPromptOverride:'Reply briefly.',tools:[],origin,originRef});
    parent=result.session;
    return {session:parent,sessionId:parent.sessionId,dispose:result.dispose};
  }
});
for(const adapter of ['discord-bot','github']){
router.registerRecoveryAdapter(adapter,{
  accountIdentity:async()=> 'proof-account',cachedAccountIdentity:()=> 'proof-account',
  reconcile:async()=>({status:'unreconcilable'})
});
router.registerOutbound(adapter,async(message)=>{
  await appendFile(dir+'/posts',JSON.stringify({text:message.text,source:message.source})+'\\n');
  return {ok:true,messageId:'notice'};
});
}
if(initial){
  createSubagentCompletionBridge({stream,router});
  await router.route({...key,text:'Compute 42',externalMessageId:'request',authorId:'alice',authorName:'alice',authorIsBot:false,isBotMention:false,isDm:true,mentionsOthers:false,replyToBotMessageId:null,replyToOtherMessageId:null,ts:1000});
  await router.__testing.flushDebounce(key);
  if(mode==='absent-parent'){
    await router.tearDownAllLive();
    const inject=router.injectSubagentCompletionReminder.bind(router);
    router.injectSubagentCompletionReminder=async(args)=>{
      const result=await inject(args);
      if(result.kind!=='no-live-session')throw new Error('absent parent unexpectedly reopened');
      await stopAt();
      return result;
    };
  }
  if(mode==='before-claim'){
    const original=store.claim.bind(store);
    store.claim=async(refs,owner)=>{if(refs.length)await stopAt();return original(refs,owner)};
    const claim=journal.claim.bind(journal);
    journal.claim=async(refs,owner,backgroundRefs,...rest)=>{if(backgroundRefs?.length)await stopAt();return claim(refs,owner,backgroundRefs,...rest)};
  }
  const originalPrompt=parent.prompt.bind(parent);
  parent.prompt=async(text)=>{
    if(mode==='splice')await stopAt();
    if(mode==='provider-failure'){
      await originalPrompt(text);
      if(parent.agent.state.messages.at(-1)?.stopReason!=='error')throw new Error('provider failure was not observed');
      await stopAt();
    }
    if(mode.startsWith('settled-')||mode.startsWith('ambiguous-')){
      const ending=mode.split('-')[1];
      if(ending==='reply'){
        const backgroundCoverage=await router.captureBackgroundResultCoverage(parent.sessionId);
        const inboundCoverage=await router.captureInboundResultCoverage(parent.sessionId);
        await router.send({...key,text:'Result: 42.'});
        await parent.agent.afterToolCall({assistantMessage:{usage:{totalTokens:1}},toolCall:{name:'channel_reply',arguments:{text:'Result: 42.'}},args:{text:'Result: 42.'},result:{details:{ok:true,backgroundCoverage,inboundCoverage}},isError:false,context:{messages:[]}});
      }
      if(ending==='review'){
        const backgroundCoverage=await router.captureBackgroundResultCoverage(parent.sessionId);
        const inboundCoverage=await router.captureInboundResultCoverage(parent.sessionId);
        await appendFile(dir+'/reviews','APPROVE\\n');
        await router.noteGithubReviewOutput({sessionId:parent.sessionId,workspace:key.workspace,prNumber:672,state:'APPROVE',backgroundCoverage,inboundCoverage});
      }
      if(ending==='skip')await router.markTurnSkipped({parentSessionId:parent.sessionId,reason:'intentional quiet'});
      if(ending==='stop')await router.route({...key,text:'/stop',externalMessageId:'stop',authorId:'alice',authorName:'alice',authorIsBot:false,isBotMention:false,isDm:true,mentionsOthers:false,replyToBotMessageId:null,replyToOtherMessageId:null,ts:1001});
      throw new Error('settlement boundary was not reached');
    }
    return originalPrompt(text);
  };
  const tool=createSpawnSubagentTool({
    registry:{explorer:{visibility:'public',systemPrompt:'Compute the answer.'}},liveRegistry:live,stream,
    agentDir:dir,parentSessionId:parent.sessionId,generateTaskId:()=> 'task',router,
    getAccountIdentity:async()=> 'proof-account',
    getOrigin:()=>({kind:'channel',...key,lastInboundAuthorId:'alice'}),
    createSessionForSubagent:async()=>{
      const result=await createSessionWithDispose({sessionManager:SessionManager.create(dir,dir+'/sessions'),systemPromptOverride:'Compute the answer.',tools:[]});
      return {sessionId:result.session.sessionId,prompt:(text)=>result.session.prompt(text),subscribe:(cb)=>result.session.subscribe(cb),abort:()=>result.session.abort(),dispose:result.dispose};
    }
  });
  await tool.execute('spawn',{subagent_type:'explorer',prompt:'Compute the answer.'},undefined,undefined,{});
  if(mode==='provider-notice'){
    // The live router finishes the failed completion turn on its own; snapshot once
    // the notice durably owns the child row, not merely once it is prepared.
    await noticeOwned.promise;
    await appendFile(dir+'/decided',JSON.stringify({rows:await store.list(),outbox:await new RecoveryOutbox(dir,{epoch:mode}).list()}));
    await stopAt();
  }
  await forever;
}else{
  const outbox=new RecoveryOutbox(dir,{epoch:mode});
  await bootBackgroundObligations({inboundJournal:journal,obligations:store,outbox,inventory:new LegacyBackgroundHandoffReader(dir,{processEpoch:mode})});
  if(mode==='receipt-death'){
    const delivered=outbox.delivered.bind(outbox);
    outbox.delivered=async(...args)=>{const result=await delivered(...args);if(result)await stopAt();return result};
  }
  const acknowledged=Promise.withResolvers();
  const acknowledge=store.acknowledgeNotice.bind(store);
  store.acknowledgeNotice=async(record)=>{await acknowledge(record);acknowledged.resolve()};
  const dispatcher=new RecoveryDispatcher(outbox,router,{backgroundObligations:store,inboundJournal:journal,onError:acknowledged.reject});
  await dispatcher.wake();
  if((await store.list()).some(row=>row.phase!=='closed'))await acknowledged.promise;
  await dispatcher.stop();
  if((await store.list()).some(row=>row.phase!=='closed'))throw new Error('unsettled recovery');
  console.log('recovered');
  process.exit(0);
}
`

const spawnWorker = (dir: string, mode: string) =>
  Bun.spawn([process.execPath, '--eval', source, dir, mode], {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

async function killAtBoundary(child: ReturnType<typeof spawnWorker>, boundary: string): Promise<void> {
  const reader = child.stdout.getReader()
  try {
    let output = ''
    while (!output.includes('\n')) {
      const next = await reader.read()
      if (next.done) throw new Error(await new Response(child.stderr).text())
      output += new TextDecoder().decode(next.value)
    }
    expect(JSON.parse(output.trim())).toEqual({ boundary })
    child.kill('SIGKILL')
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toBe('')
    // Windows TerminateProcess has no POSIX signal metadata.
    if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
  } finally {
    child.kill('SIGKILL')
    await child.exited
    reader.releaseLock()
  }
}

for (const boundary of [
  'ready',
  'before-claim',
  'claim',
  'splice',
  'prompt',
  'absent-parent',
  'provider-failure',
  'ambiguous-reply',
  'ambiguous-review',
  'settled-reply',
  'settled-review',
  'settled-skip',
  'settled-stop',
]) {
  test(`completed child survives SIGKILL at ${boundary} without work or output replay across two recovery boots`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-router-process-'))
    await writeFile(
      join(dir, 'typeclaw.json'),
      JSON.stringify({ models: { default: { model: 'anthropic/claude-sonnet-4-6' } } }),
    )
    const child = spawnWorker(dir, boundary)
    try {
      await killAtBoundary(child, boundary)
      const closed = boundary.startsWith('settled-')
      const phase = closed
        ? 'closed'
        : ['ready', 'before-claim', 'absent-parent'].includes(boundary)
          ? 'result-ready'
          : 'turn-owned'
      expect(await new BackgroundObligationStore(dir, { epoch: 'inspection' }).list()).toMatchObject([
        { taskId: 'task', phase },
      ])
      const providerCalls = await readFile(join(dir, 'provider-calls'), 'utf8')
      expect(providerCalls).toBe(['prompt', 'provider-failure'].includes(boundary) ? '1\n2\n3\n' : '1\n2\n')
      let deliveryId: string | undefined
      if (!closed) {
        const dyingBoot = spawnWorker(dir, 'receipt-death')
        await killAtBoundary(dyingBoot, 'receipt-death')
        const receipts = await new RecoveryOutbox(dir, { epoch: 'inspection' }).list()
        expect(receipts).toMatchObject([{ state: 'delivered', attempts: 1 }])
        deliveryId = receipts[0]!.deliveryId
      }
      for (const mode of ['repair', 'second-repair']) {
        const boot = spawnWorker(dir, mode)
        const bootOutput = await new Response(boot.stdout).text()
        expect(await boot.exited).toBe(0)
        expect(await new Response(boot.stderr).text()).toBe('')
        expect(bootOutput).toContain('recovered')
      }
      const rows = await new BackgroundObligationStore(dir, { epoch: 'inspection' }).list()
      expect(rows).toMatchObject([{ phase: 'closed' }])
      if (!closed) expect(rows[0]!.outcome?.deliveryId).toBe(deliveryId)
      const posts = await readFile(join(dir, 'posts'), 'utf8').catch(() => '')
      const expectedPosts = Number(boundary.endsWith('-reply')) + Number(!closed)
      expect(posts.trim().split('\n').filter(Boolean)).toHaveLength(expectedPosts)
      if (boundary.endsWith('-review')) expect(await readFile(join(dir, 'reviews'), 'utf8')).toBe('APPROVE\n')
      expect(await readFile(join(dir, 'provider-calls'), 'utf8')).toBe(providerCalls)
      const errors = (await readFile(join(dir, 'router-errors'), 'utf8').catch(() => '')).trim()
      if (boundary === 'provider-failure') {
        const messages = errors.split('\n').map((line) => JSON.parse(line) as string)
        expect(messages).toHaveLength(1)
        expect(messages[0]).toContain('LLM call failed: 401')
        expect(messages[0]).toContain('controlled provider outage')
      } else {
        expect(errors).toBe('')
      }
      const outbox = new RecoveryOutbox(dir, { epoch: 'inspection' })
      // Acknowledged notices retire from the live outbox.
      expect(await outbox.list()).toEqual([])
      const retired = await outbox.listRetired()
      if (closed) expect(retired).toEqual([])
      else {
        if (deliveryId === undefined) throw new Error(`${boundary} recorded no delivery receipt before repair`)
        expect(retired.map((record) => [record.deliveryId, record.dispatch.state, record.dispatch.attempts])).toEqual([
          [deliveryId, 'delivered', 1],
        ])
        // Genuine process death keeps the frozen restart template.
        expect(JSON.parse(posts.trim().split('\n').at(-1)!).text).toBe(RECOVERY_NOTICE_TEXT)
      }
    } finally {
      child.kill('SIGKILL')
      await child.exited
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
}

test('provider-error notice after a consumed child result never erases the child debt; it ends as one live notice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-router-process-'))
  await writeFile(
    join(dir, 'typeclaw.json'),
    JSON.stringify({ models: { default: { model: 'anthropic/claude-sonnet-4-6' } } }),
  )
  const child = spawnWorker(dir, 'provider-notice')
  try {
    await killAtBoundary(child, 'provider-notice')
    const decided = JSON.parse(await readFile(join(dir, 'decided'), 'utf8')) as {
      rows: Array<{ taskId: string; phase: string; transfer?: { deliveryId: string; text: string } }>
      outbox: Array<{ deliveryId: string; text: string; covers: Array<{ store: string; id: string }> }>
    }
    // The provider failure did not close the consumed result; it was handed
    // to a durable non-restart notice in the same process.
    expect(decided.rows).toMatchObject([{ taskId: 'task', phase: 'notice-owned' }])
    expect(decided.outbox).toHaveLength(1)
    expect(decided.outbox[0]!.text).toBe(LIVE_TURN_ENDED_NOTICE_TEXT)
    expect(decided.outbox[0]!.deliveryId).toBe(decided.rows[0]!.transfer!.deliveryId)
    const providerCalls = await readFile(join(dir, 'provider-calls'), 'utf8')
    for (const mode of ['repair', 'second-repair']) {
      const boot = spawnWorker(dir, mode)
      const bootOutput = await new Response(boot.stdout).text()
      expect(await boot.exited).toBe(0)
      expect(await new Response(boot.stderr).text()).toBe('')
      expect(bootOutput).toContain('recovered')
    }
    expect(await readFile(join(dir, 'provider-calls'), 'utf8')).toBe(providerCalls)
    const rows = await new BackgroundObligationStore(dir, { epoch: 'inspection' }).list()
    expect(rows).toMatchObject([{ phase: 'closed', outcome: { deliveryId: decided.outbox[0]!.deliveryId } }])
    const posts = (await readFile(join(dir, 'posts'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).text)
    expect(posts.filter((text) => text === LIVE_TURN_ENDED_NOTICE_TEXT)).toHaveLength(1)
    expect(posts).not.toContain(RECOVERY_NOTICE_TEXT)
    expect(posts).not.toContain('Result: 42.')
  } finally {
    child.kill('SIGKILL')
    await child.exited
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
