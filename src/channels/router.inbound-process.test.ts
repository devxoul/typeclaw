import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Subprocess } from 'bun'

import { BackgroundObligationStore } from './background-obligations'
import { RecoveryOutbox } from './recovery-outbox'

const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
const source = `
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { SessionManager } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
import { Type } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))};
import { createSessionWithDispose } from ${moduleUrl('../agent/index.ts')};
import { createChannelReplyTool } from ${moduleUrl('../agent/tools/channel-reply.ts')};
import { reloadConfig } from ${moduleUrl('../config/config.ts')};
import { InboundJournal } from ${moduleUrl('./inbound-journal.ts')};
import { LegacyBackgroundHandoffReader } from ${moduleUrl('./background-handoff.ts')};
import { BackgroundObligationStore } from ${moduleUrl('./background-obligations.ts')};
import { bootBackgroundObligations } from ${moduleUrl('../run/background-handoff-boot.ts')};
import { createRecoveryNotice } from ${moduleUrl('./recovery-notice.ts')};
import { RecoveryOutbox } from ${moduleUrl('./recovery-outbox.ts')};
import { RecoveryDispatcher } from ${moduleUrl('./recovery-dispatcher.ts')};
import { createChannelRouter } from ${moduleUrl('./router.ts')};
import { defaultHistoryConfig } from ${moduleUrl('./schema.ts')};
import { noopPermissionService } from ${moduleUrl('../permissions/index.ts')};
const [dir,mode]=process.argv.slice(-2);
process.chdir(dir); reloadConfig(dir); process.env.ANTHROPIC_API_KEY='inbound-proof';
const stdin=Bun.stdin.text();
const boundary=async()=>{console.log(JSON.stringify({boundary:mode}));await stdin;throw Error('boundary resumed');};
const key={adapter:'discord-bot',workspace:'guild',chat:'room',thread:null};
let currentAccount=mode==='rotation'||mode==='rotate-restored'||mode==='rotate-second'?'actorA':mode==='rotate-blocked'?'actorB':'proof-account';
const event=(id,text=id)=>({...key,accountIdentity:currentAccount,text,externalMessageId:id,eventKind:'message',revision:'0',authorId:'alice',authorName:'alice',authorIsBot:false,isBotMention:false,isDm:true,mentionsOthers:false,replyToBotMessageId:null,replyToOtherMessageId:null,ts:id==='A'?1000:1001});
const initial=!['transfer-before-import','transfer-after-import','receipt','repair','second-repair','frozen','rotate-blocked','rotate-restored','rotate-second'].includes(mode);
const background=new BackgroundObligationStore(dir,{epoch:mode});
const journal=new InboundJournal(dir,{epoch:mode,backgroundObligations:background,onDurability:async(phase,record)=>{if(record?.type==='outcome-decided'&&record.backgroundChanges.length&&((['mixed-stop-decision','mixed-stop-corruption'].includes(mode)&&phase==='append-synced')||(mode==='mixed-stop-applied'&&phase==='mixed-json-applied')))await boundary()}});
let lateReply, lateCallback, oldCoverage, oldOwner;
const transportStarted=Promise.withResolvers(), releaseTransport=Promise.withResolvers();
if(initial){
 const admit=journal.admit.bind(journal);journal.admit=async(...args)=>{const r=await admit(...args);await appendFile(dir+'/admissions',JSON.stringify(r)+'\\n');if(mode==='admission')await boundary();return r};
 const claim=journal.claim.bind(journal);journal.claim=async(...args)=>{if(mode==='before-claim')await boundary();const r=await claim(...args);await appendFile(dir+'/claims',JSON.stringify(r)+'\\n');if(mode==='claim')await boundary();return r};
 const settle=journal.settle.bind(journal);journal.settle=async(...args)=>{const r=await settle(...args);if(['silence','skip','stop','rotation'].includes(mode))await boundary();return r};
 const move=journal.move.bind(journal);journal.move=async(...args)=>{
  const r=await move(...args);
  if(['reload-move','stale-reply'].includes(mode))await appendFile(dir+'/moved',JSON.stringify({oldCoverage,oldOwner,rows:journal.list()}));
  return r;
 };
}
let session;let calls=0;
const router=createChannelRouter({agentDir:dir,backgroundObligations:background,inboundJournal:journal,
 configForAdapter:()=>({enabled:true,engagement:{trigger:['dm'],stickiness:'off'},history:defaultHistoryConfig()}),
 permissions:{...noopPermissionService,has:()=>true},logger:{info(m){appendFileSync(dir+'/logs',String(m)+'\\n')},warn(m){appendFileSync(dir+'/logs',String(m)+'\\n')},error(m){appendFileSync(dir+'/errors',JSON.stringify(m)+'\\n')}},
 createSessionForChannel:async({origin,originRef})=>{
  if(!initial)throw Error('recovery attempted work replay');
  const manager=SessionManager.create(dir,dir+'/sessions');
  const effect={name:'effect',label:'effect',description:'Record a side effect',parameters:Type.Object({}),execute:async()=>{
   await appendFile(dir+'/effects','effect\\n');
   return {content:[{type:'text',text:'effect recorded'}],details:{}};
  }};
  const result=await createSessionWithDispose({sessionManager:manager,systemPromptOverride:'Use tools to answer.',tools:['effect','channel_reply'],customTools:[effect,createChannelReplyTool({router,origin:key,sessionId:manager.getSessionId()})],origin,originRef});
  session=result.session;
  const prompt=session.prompt.bind(session);session.prompt=async(...args)=>{
   if(mode==='splice')await boundary();
   if(['reload-move','stale-reply'].includes(mode)&&oldOwner&&session.sessionId!==oldOwner.ownerSessionId){
    const before=journal.list();
    if(mode==='stale-reply'){
     releaseTransport.resolve();const result=await lateReply;
     if(JSON.stringify(result.details.inboundCoverage)!==JSON.stringify(oldCoverage))throw Error('late reply lost captured generation');
     await lateCallback({assistantMessage:{usage:{totalTokens:1}},toolCall:{name:'channel_reply',arguments:{text:'Late answer.',more_work_this_turn:false}},args:{text:'Late answer.',more_work_this_turn:false},result,isError:false,context:{messages:[]}});
    }
    const after=journal.list();if(JSON.stringify(before)!==JSON.stringify(after))throw Error('stale reply settled newer ownership');
    await appendFile(dir+'/ownership',JSON.stringify({oldCoverage,oldOwner,before,after,sessionId:session.sessionId}));await boundary();
   }
   const r=await prompt(...args);
   if(['reload-move','stale-reply'].includes(mode)&&calls===1){
    if(mode==='stale-reply'){lateCallback=session.agent.afterToolCall;lateReply=createChannelReplyTool({router,origin:key,sessionId:session.sessionId}).execute('late',{text:'Late answer.',more_work_this_turn:false});await transportStarted.promise;}
    await router.tearDownAllLive();
   }
   return r;
  };
  return {session,sessionId:session.sessionId,dispose:result.dispose};
 }});
router.registerRecoveryAdapter(key.adapter,{accountIdentity:async()=> currentAccount,cachedAccountIdentity:()=> currentAccount,reconcile:async()=>({status:'unreconcilable'})});
router.registerOutbound(key.adapter,async(message)=>{const accounting=message.sendOptions?.accounting??'live-turn';await appendFile(dir+'/posts',JSON.stringify({text:message.text,accounting})+'\\n');if(mode==='stale-reply'&&accounting!=='recovery'){transportStarted.resolve();await releaseTransport.promise;}if(mode==='output'&&accounting!=='recovery')await boundary();return {ok:true,messageId:'post'}});
try{await journal.initialize()}catch(error){if(mode!=='frozen')throw error;await appendFile(dir+'/recovery-errors',String(error)+'\\n')}
const sse=(block,stop)=>new Response([
 'event: message_start','data: '+JSON.stringify({type:'message_start',message:{id:'msg_'+calls,type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}),'',
 'event: content_block_start','data: '+JSON.stringify({type:'content_block_start',index:0,content_block:block.type==='text'?{type:'text',text:''}:{type:'tool_use',id:'tool_'+calls,name:block.name,input:{}}}),'',
 'event: content_block_delta','data: '+JSON.stringify({type:'content_block_delta',index:0,delta:block.type==='text'?{type:'text_delta',text:block.text}:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}}),'',
 'event: content_block_stop','data: {"type":"content_block_stop","index":0}','',
 'event: message_delta','data: '+JSON.stringify({type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}}),'',
 'event: message_stop','data: {"type":"message_stop"}',''].join('\\n'),{headers:{'content-type':'text/event-stream'}});
globalThis.fetch=async(input,options)=>{
 calls++;await appendFile(dir+'/provider-calls','call\\n');
 if(mode==='rotation')await appendFile(dir+'/provider-request',typeof options?.body==='string'?options.body:input instanceof Request?await input.clone().text():'');
 if(['reload-move','stale-reply'].includes(mode)&&calls===1){
  oldCoverage=await router.captureInboundResultCoverage(session.sessionId);oldOwner=journal.get(oldCoverage[0].inputId).claim;
  return sse({type:'text',text:'channel_reply({"reason":"missing text"})'},'end_turn');
 }
 if(mode==='tool'&&calls===2)await boundary();
 if(['prompt','queued','tool','output','stop'].includes(mode)&&calls===1){const b=await router.route(event('B'));await appendFile(dir+'/B-receipt',JSON.stringify(b));}
 if(mode==='mixed-stop-corruption'){
  const outbox=new RecoveryOutbox(dir,{epoch:mode});const principal=journal.list()[0].principal;
  const target={...key,chat:'other-target'};
  const child=await background.accept({parentSessionId:'other-parent',taskId:'other-child',target,accountIdentity:'proof-account',principal});
  const admitted=await journal.admit({target,accountIdentity:'proof-account',principal,messageId:'other-input',eventKind:'message',revision:'0',ownerSessionId:'other-parent'});
  const transfer=await journal.prepareNotice(journal.resolve([admitted.inputId]),target,[{obligationId:child.obligationId,generation:child.generation}]);await journal.importPrepared(outbox,transfer);
  const independent=await background.accept({parentSessionId:'background-parent',taskId:'background-only',target:{...key,chat:'background-target'},accountIdentity:'proof-account',principal});
  const prepared=await background.prepareNotice(independent.obligationId,independent.generation);await outbox.import(prepared.transfer);await background.ownNotice(prepared.obligationId,prepared.generation,prepared.transfer.deliveryId);
  await outbox.import(createRecoveryNotice({target:{...key,chat:'inventory-target'},accountIdentity:'proof-account',principal,covers:[{store:'inventory',id:'a'.repeat(64),generation:1}],transferId:'b'.repeat(64),recoveryGeneration:'legacy-generation'}));
 }
 if(mode.startsWith('mixed-stop-')){await router.acceptBackgroundResponse({parentSessionId:session.sessionId,key,taskId:'child',subagentName:'proof',startedAt:1002,accountIdentity:'proof-account',triggeringAuthorId:'alice'});await router.attachBackgroundResultCoverage({parentSessionId:session.sessionId,taskId:'child'});await router.route(event('stop','/stop'));throw Error('mixed stop boundary missing')}
 if(['prompt','queued'].includes(mode))await boundary();
 if(mode==='stop'){await router.route(event('stop','/stop'));throw Error('stop boundary missing')}
 if(mode==='skip'){await router.markTurnSkipped({parentSessionId:session.sessionId,reason:'intentional silence'});throw Error('skip boundary missing')}
 if(mode==='tool')return sse({type:'tool_use',name:'effect',input:{}},'tool_use');
 if(mode==='output')return sse({type:'tool_use',name:'channel_reply',input:{text:'Answer A.',more_work_this_turn:false}},'tool_use');
 return sse({type:'text',text:'NO_REPLY'},'end_turn');
};
if(initial){
 const receipt=await router.route(event('A',mode==='rotation'?'ONLY_A':undefined));await appendFile(dir+'/A-receipt',JSON.stringify(receipt));
 if(mode==='rotation'){
  await router.acceptBackgroundResponse({parentSessionId:session.sessionId,key,taskId:'actorA-child',subagentName:'proof',startedAt:1002,accountIdentity:currentAccount,triggeringAuthorId:'alice'});
  currentAccount='actorB';
  const b=await router.route({...event('B','ONLY_B'),authorId:'bob',authorName:'Bob'});await appendFile(dir+'/B-receipt',JSON.stringify(b));
  await router.injectSubagentCompletionReminder({parentSessionId:session.sessionId,subagent:'proof',taskId:'actorA-child',ok:true,durationMs:1});
 }
 await router.__testing.flushDebounce(key);await stdin;throw Error('initial boundary missing');
}
else{
 const outbox=new RecoveryOutbox(dir,{epoch:mode});
 const importing=outbox.import.bind(outbox);outbox.import=async(...args)=>{if(mode==='transfer-before-import')await boundary();const r=await importing(...args);if(mode==='transfer-after-import')await boundary();return r};
 try{await bootBackgroundObligations({inboundJournal:journal,obligations:background,outbox,inventory:new LegacyBackgroundHandoffReader(dir,{processEpoch:mode})})}catch(error){if(mode!=='frozen')throw error;await appendFile(dir+'/recovery-errors',String(error)+'\\n')}
 if(mode==='frozen'){
  const receipt=Promise.withResolvers();const delivered=outbox.delivered.bind(outbox);outbox.delivered=async(...args)=>{const r=await delivered(...args);if(r)receipt.resolve();return r};
  const dispatcher=new RecoveryDispatcher(outbox,router,{backgroundObligations:background,inboundJournal:journal,onError:async(error)=>{await appendFile(dir+'/recovery-errors',String(error)+'\\n')}});
  await dispatcher.wake();await receipt.promise;await dispatcher.stop();await journal.close();console.log('recovered');process.exit(0);
 }
 if(mode==='rotate-blocked'){
  const blocked=Promise.withResolvers();const fail=outbox.fail.bind(outbox);outbox.fail=async(...args)=>{const r=await fail(...args);blocked.resolve();return r};
  const dispatcher=new RecoveryDispatcher(outbox,router,{backgroundObligations:background,inboundJournal:journal,onError:blocked.reject});
  await dispatcher.wake();await blocked.promise;await dispatcher.stop();await journal.close();console.log('recovered');process.exit(0);
 }
 if(mode==='receipt'){const delivered=outbox.delivered.bind(outbox);outbox.delivered=async(...args)=>{const r=await delivered(...args);if(r)await boundary();return r};}
 const acknowledged=Promise.withResolvers();
 const acknowledge=journal.acknowledgeNotice.bind(journal);journal.acknowledgeNotice=async(...args)=>{await acknowledge(...args);if(journal.list().every(row=>row.phase==='closed'))acknowledged.resolve()};
 const dispatcher=new RecoveryDispatcher(outbox,router,{backgroundObligations:background,inboundJournal:journal,onError:acknowledged.reject});
 await dispatcher.wake();
 if((await journal.list()).some(row=>row.phase!=='closed'))await acknowledged.promise;
 await dispatcher.stop();await journal.flush();await journal.close();console.log('recovered');process.exit(0);
}
`

const spawnWorker = (dir: string, mode: string) =>
  Bun.spawn([process.execPath, '--eval', source, dir, mode], {
    cwd: join(import.meta.dir, '../..'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

async function killAtBoundary(child: Subprocess<'pipe', 'pipe', 'pipe'>, boundary: string) {
  const reader = child.stdout.getReader()
  let output = ''
  try {
    while (!output.includes('\n')) {
      const next = await reader.read()
      if (next.done) throw new Error(`Worker exited before ${boundary}: ${await new Response(child.stderr).text()}`)
      output += new TextDecoder().decode(next.value)
    }
    expect(JSON.parse(output.trim())).toEqual({ boundary })
    child.kill('SIGKILL')
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toBe('')
    if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
  } finally {
    reader.releaseLock()
    child.kill('SIGKILL')
    await child.exited
  }
}

async function reboot(dir: string, mode: string) {
  const child = spawnWorker(dir, mode)
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stderr).text()).toBe('')
  expect(output).toBe('recovered\n')
}

const optionalRead = (dir: string, name: string) => readFile(join(dir, name), 'utf8').catch(() => '')

for (const mode of [
  'admission',
  'before-claim',
  'claim',
  'splice',
  'prompt',
  'queued',
  'tool',
  'output',
  'silence',
  'skip',
  'stop',
  'mixed-stop-decision',
  'mixed-stop-applied',
  'reload-move',
  'stale-reply',
]) {
  test(`durable inbound ${mode} survives SIGKILL and two boots without replay`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-inbound-process-'))
    await writeFile(
      join(dir, 'typeclaw.json'),
      JSON.stringify({ models: { default: { model: 'anthropic/claude-sonnet-4-6' } } }),
    )
    try {
      await killAtBoundary(spawnWorker(dir, mode), mode)
      const admissions = (await optionalRead(dir, 'admissions'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const acceptedIds = admissions.map((row) => row.inputId).sort()
      const queued = ['prompt', 'queued', 'tool', 'output', 'stop'].includes(mode)
      expect(admissions).toHaveLength(queued ? 2 : 1)
      expect(new Set(acceptedIds).size).toBe(acceptedIds.length)
      if (queued) expect(JSON.parse(await optionalRead(dir, 'B-receipt'))).toMatchObject({ kind: 'accepted' })
      if (mode === 'admission') expect(await optionalRead(dir, 'A-receipt')).toBe('')
      if (['claim', 'splice', 'prompt', 'queued', 'tool', 'output'].includes(mode)) {
        const claims = (await optionalRead(dir, 'claims'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(claims).toMatchObject([{ inboundRefs: [{ inputId: admissions[0]!.inputId }] }])
        expect(claims.flatMap((claim) => claim.inboundRefs.map((ref: { inputId: string }) => ref.inputId))).toEqual([
          admissions[0]!.inputId,
        ])
      }
      if (['reload-move', 'stale-reply'].includes(mode)) {
        const ownership = JSON.parse(await optionalRead(dir, 'ownership'))
        const moved = JSON.parse(await optionalRead(dir, 'moved'))
        expect(ownership.after).toEqual(ownership.before)
        expect(ownership.after).toMatchObject([
          { inputId: acceptedIds[0], phase: 'turn-owned', claim: { ownerSessionId: ownership.sessionId } },
        ])
        expect(ownership.sessionId).not.toBe(ownership.oldOwner.ownerSessionId)
        expect(moved.rows[0].generation).toBe(ownership.oldCoverage[0].generation + 1)
        expect(ownership.after[0].generation).toBe(moved.rows[0].generation)
        expect(ownership.after[0].outcome).toBeUndefined()
      }
      const calls = await optionalRead(dir, 'provider-calls')
      const effects = await optionalRead(dir, 'effects')
      if (mode === 'tool') {
        expect(effects).toBe('effect\n')
        const transcripts = (await readdir(join(dir, 'sessions'), { recursive: true })).filter((path) =>
          path.endsWith('.jsonl'),
        )
        const entries = (
          await Promise.all(transcripts.map((path) => readFile(join(dir, 'sessions', path), 'utf8')))
        ).flatMap((text) =>
          text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        )
        expect(
          entries
            .filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult')
            .map((entry) => ({ name: entry.message.toolName, content: entry.message.content })),
        ).toEqual([{ name: 'effect', content: [{ type: 'text', text: 'effect recorded' }] }])
      } else expect(effects).toBe('')
      if (['admission', 'before-claim', 'claim', 'splice'].includes(mode)) {
        const sessions = await readdir(join(dir, 'sessions'), { recursive: true }).catch(() => [])
        expect(sessions.filter((path) => path.endsWith('.jsonl'))).toEqual([])
      }
      if (['prompt', 'queued'].includes(mode)) {
        const transcripts = (await readdir(join(dir, 'sessions'), { recursive: true })).filter((path) =>
          path.endsWith('.jsonl'),
        )
        const entries = (
          await Promise.all(transcripts.map((path) => readFile(join(dir, 'sessions', path), 'utf8')))
        ).flatMap((text) =>
          text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        )
        expect(entries.filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')).toEqual([])
      }
      const terminal = ['silence', 'skip', 'stop'].includes(mode) || mode.startsWith('mixed-stop-')
      if (!terminal) {
        for (const boundary of ['transfer-before-import', 'transfer-after-import', 'receipt']) {
          await killAtBoundary(spawnWorker(dir, boundary), boundary)
        }
      }
      await reboot(dir, 'repair')
      await reboot(dir, 'second-repair')
      expect(await optionalRead(dir, 'provider-calls')).toBe(calls)
      expect(await optionalRead(dir, 'effects')).toBe(effects)
      if (mode.startsWith('mixed-stop-')) {
        const children = await new BackgroundObligationStore(dir).list()
        expect(children).toMatchObject([
          { taskId: 'child', phase: 'closed', outcome: { kind: 'intentionally-suppressed' } },
        ])
        expect(
          children[0]!.applications.filter((receipt) => receipt.transitionId === children[0]!.outcome!.decisionId),
        ).toHaveLength(1)
      }
      const records = await new RecoveryOutbox(dir).list()
      if (terminal) expect(records).toEqual([])
      else {
        // Inputs from one author, account and captured parent recover under a single notice.
        expect(records).toHaveLength(1)
        for (const record of records)
          expect(record).toMatchObject({
            state: 'delivered',
            attempts: 1,
            target: { adapter: 'discord-bot', chat: 'room' },
          })
        expect(records.flatMap((record) => record.covers.map((ref) => ref.id)).sort()).toEqual(acceptedIds)
        expect(records.every((record) => record.covers.every((ref) => ref.store === 'inbound'))).toBe(true)
      }
      const posts = (await optionalRead(dir, 'posts'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const notices = posts.filter((post) => post.accounting === 'recovery')
      expect(notices).toEqual(records.map((record) => ({ accounting: 'recovery', text: record.text })))
      if (mode === 'output')
        expect(posts.filter((post) => post.accounting !== 'recovery')).toEqual([
          { text: 'Answer A.', accounting: 'live-turn' },
        ])
      if (mode === 'stale-reply')
        expect(posts.filter((post) => post.accounting !== 'recovery')).toEqual([
          { text: 'Late answer.', accounting: 'live-turn' },
        ])
      expect(await optionalRead(dir, 'errors')).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
}

test('mixed stop committed before JSON remains authoritative through corruption; independent inventory alone dispatches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-inbound-corruption-'))
  await writeFile(
    join(dir, 'typeclaw.json'),
    JSON.stringify({ models: { default: { model: 'anthropic/claude-sonnet-4-6' } } }),
  )
  try {
    await killAtBoundary(spawnWorker(dir, 'mixed-stop-corruption'), 'mixed-stop-corruption')
    const path = join(dir, 'channels/inbound-continuity.jsonl')
    const valid = await readFile(path, 'utf8')
    const childrenBefore = await new BackgroundObligationStore(dir).list()
    expect(childrenBefore.find((row) => row.taskId === 'child')).toMatchObject({ phase: 'turn-owned' })
    const backgroundBytes = await Promise.all(
      childrenBefore.map((row) =>
        readFile(join(dir, 'channels/background-obligations', `${row.obligationId}.json`), 'utf8'),
      ),
    )
    const corrupted = `${valid}{"schemaVersion":1,"type":"invalid-complete-record"}\n`
    await writeFile(path, corrupted)
    await reboot(dir, 'frozen')
    expect(await readFile(path, 'utf8')).toBe(corrupted)
    expect(
      await Promise.all(
        childrenBefore.map((row) =>
          readFile(join(dir, 'channels/background-obligations', `${row.obligationId}.json`), 'utf8'),
        ),
      ),
    ).toEqual(backgroundBytes)
    const records = await new RecoveryOutbox(dir).list()
    expect(records).toHaveLength(3)
    expect(records.filter((record) => record.covers.every((ref) => ref.store === 'inventory'))).toMatchObject([
      { state: 'delivered', attempts: 1 },
    ])
    expect(
      records
        .filter((record) => record.covers.some((ref) => ref.store !== 'inventory'))
        .map((record) => ({ state: record.state, attempts: record.attempts })),
    ).toEqual([
      { state: 'pending', attempts: 0 },
      { state: 'pending', attempts: 0 },
    ])
    const posts = (await optionalRead(dir, 'posts'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(posts).toEqual([{ accounting: 'recovery', text: records[0]!.text }])
    expect(await optionalRead(dir, 'recovery-errors')).toContain('journal')
    const calls = await optionalRead(dir, 'provider-calls')
    await writeFile(path, valid)
    await reboot(dir, 'repair')
    await reboot(dir, 'second-repair')
    const childrenAfter = await new BackgroundObligationStore(dir).list()
    const stopped = childrenAfter.find((row) => row.taskId === 'child')!
    expect(stopped).toMatchObject({ phase: 'closed', outcome: { kind: 'intentionally-suppressed' } })
    expect(stopped.applications.filter((receipt) => receipt.transitionId === stopped.outcome!.decisionId)).toHaveLength(
      1,
    )
    expect(await optionalRead(dir, 'provider-calls')).toBe(calls)
    expect(await optionalRead(dir, 'effects')).toBe('')
    expect(
      (await new RecoveryOutbox(dir).list()).map((record) => ({ state: record.state, attempts: record.attempts })),
    ).toEqual([
      { state: 'delivered', attempts: 1 },
      { state: 'delivered', attempts: 1 },
      { state: 'delivered', attempts: 1 },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 120_000)

test('account rotation transfers queued old-account input and child while compatible input runs; original account alone recovers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-inbound-account-'))
  await writeFile(
    join(dir, 'typeclaw.json'),
    JSON.stringify({ models: { default: { model: 'anthropic/claude-sonnet-4-6' } } }),
  )
  try {
    await killAtBoundary(spawnWorker(dir, 'rotation'), 'rotation')
    const admissions = (await optionalRead(dir, 'admissions'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(admissions).toHaveLength(2)
    const request = JSON.parse(await optionalRead(dir, 'provider-request'))
    const prompt = request.messages.filter((message: { role: string }) => message.role === 'user').at(-1)
    expect(JSON.stringify(prompt)).toContain('ONLY_B')
    expect(JSON.stringify(prompt)).not.toContain('ONLY_A')
    expect(await optionalRead(dir, 'provider-calls')).toBe('call\n')
    const notices = await new RecoveryOutbox(dir).list()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ accountIdentity: 'actorA', state: 'pending' })
    expect(notices[0]!.covers.map((ref) => ref.store).sort()).toEqual(['background', 'inbound'])
    expect(notices[0]!.covers.filter((ref) => ref.store === 'inbound').map((ref) => ref.id)).toEqual([
      admissions[0].inputId,
    ])
    await reboot(dir, 'rotate-blocked')
    expect(await optionalRead(dir, 'posts')).toBe('')
    expect((await new RecoveryOutbox(dir).list())[0]).toMatchObject({
      accountIdentity: 'actorA',
      state: 'blocked',
      attempts: 1,
    })
    await reboot(dir, 'rotate-restored')
    await reboot(dir, 'rotate-second')
    const records = await new RecoveryOutbox(dir).list()
    expect(records).toMatchObject([{ accountIdentity: 'actorA', state: 'delivered', attempts: 2 }])
    expect(await new BackgroundObligationStore(dir).list()).toMatchObject([
      { taskId: 'actorA-child', phase: 'closed', outcome: { kind: 'delivered' } },
    ])
    expect(await optionalRead(dir, 'provider-calls')).toBe('call\n')
    expect(await optionalRead(dir, 'effects')).toBe('')
    expect(
      (await optionalRead(dir, 'posts'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ accounting: 'recovery', text: records[0]!.text }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 120_000)
