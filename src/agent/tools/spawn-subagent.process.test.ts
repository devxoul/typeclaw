import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundObligationStore } from '@/channels/background-obligations'
import { RecoveryOutbox } from '@/channels/recovery-outbox'

const cwd = join(import.meta.dir, '../../..')
const source = `
import { BackgroundObligationStore } from './src/channels/background-obligations.ts';
import { LiveSubagentRegistry } from './src/agent/live-subagents.ts';
import { createSpawnSubagentTool } from './src/agent/tools/spawn-subagent.ts';
const [dir, stage] = process.argv.slice(-2);
const forever = Bun.stdin.text().then(()=>{throw Error('crash boundary resumed without termination');});
const store = new BackgroundObligationStore(dir, {epoch:'child'});
const ready = () => console.log(JSON.stringify({boundary:stage}));
const live = new LiveSubagentRegistry();
const done = Promise.withResolvers();
const cas = live.recordCompletionIfRunning.bind(live);
live.recordCompletionIfRunning = (id, result) => {
  const won = cas(id,result);
  if(stage === 'cas' && won) ready();
  return won;
};
const tool = createSpawnSubagentTool({
 registry:{explorer:{visibility:'public',systemPrompt:'Explore.'}}, liveRegistry:live,
 agentDir:dir,parentSessionId:'parent',generateTaskId:()=> 'task',
 getOrigin:()=>({kind:'channel',adapter:'slack',workspace:'team',chat:'room',thread:'thread'}),
 router:{acceptBackgroundResponse:async(args)=>{
   const ref=await store.accept(args);
   if(stage === 'admission'){ready();await forever;}
   return ref;
 },suppressUnstartedBackgroundResponse:async()=>{throw new Error('unexpected suppression');}},
 createSessionForSubagent:async()=>{
   if(stage === 'start'){ready();await forever;}
   return {sessionId:'child-session',prompt:()=>done.promise,subscribe:()=>()=>{},abort:async()=>{},dispose:()=>{}};
 }
});
await tool.execute('call',{subagent_type:'explorer',prompt:'inspect'},undefined,undefined,{});
if(stage === 'registered')ready();
if(stage === 'cas')done.resolve();
await forever;
`

for (const stage of ['admission', 'start', 'registered', 'cas']) {
  test(`SIGKILL at ${stage} retains the response through notice ownership and receipt acknowledgment`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-spawn-crash-'))
    const child = Bun.spawn([process.execPath, '--eval', source, dir, stage], {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const reader = child.stdout.getReader()
    try {
      const first = await reader.read()
      if (first.done) throw new Error(await new Response(child.stderr).text())
      expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({ boundary: stage })
      child.kill('SIGKILL')
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toBe('')
      if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
      const store = new BackgroundObligationStore(dir, { epoch: 'reboot' })
      const rows = await store.list()
      expect(rows).toMatchObject([{ phase: 'accepted', taskId: 'task' }])
      const outbox = new RecoveryOutbox(dir, { epoch: 'reboot' })
      await store.importOldEpoch(outbox)
      const notices = await outbox.list()
      expect(notices).toMatchObject([
        { state: 'pending', covers: [{ store: 'background', id: rows[0]!.obligationId }] },
      ])
      const notice = notices[0]!
      const lease = await outbox.lease(notice.deliveryId, notice.generation)
      expect(lease).toBeDefined()
      expect(await outbox.delivered(notice.deliveryId, lease!, { confirmedAt: 100, messageId: 'notice' })).toBe(true)
      // Reboot after the outbox receipt but before source acknowledgment.
      const second = new BackgroundObligationStore(dir, { epoch: 'second-reboot' })
      await second.importOldEpoch(new RecoveryOutbox(dir, { epoch: 'second-reboot' }))
      expect(await second.list()).toMatchObject([
        { phase: 'closed', outcome: { kind: 'delivered', deliveryId: notice.deliveryId } },
      ])
      expect(await outbox.list()).toMatchObject([{ deliveryId: notice.deliveryId, state: 'delivered', attempts: 1 }])
    } finally {
      child.kill('SIGKILL')
      await child.exited
      reader.releaseLock()
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)
}
