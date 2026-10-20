/** F07 actual index.ts + SQLite + HTTP provider + authenticated WebSocket. */
import {afterEach, describe, expect, it} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readDb} from './run-ledger-fixture';
import {bootEngine, faultProxy, gatedLlm, hangingMcp, runEventsOf, skillFile, skillWriteInput, waitFor, wireClient,
  type BootOpts, type WireClient, type GatedStep} from './state-sync-fixture';

const cleanups:(()=>void|Promise<void>)[]=[];
const envBefore={...process.env};
afterEach(async()=>{
  for(const f of cleanups.splice(0).reverse())await f();
  for(const k of Object.keys(process.env))if(!(k in envBefore))delete process.env[k];
  for(const [k,v] of Object.entries(envBefore))process.env[k]=v;
});
async function wire(port:number,token:string){const c=wireClient(port,token);await c.ready;cleanups.push(()=>c.terminate());return c;}
async function boot(scripts:Record<string,GatedStep[]>={},opts:BootOpts={}){
  const llm=await gatedLlm(scripts);cleanups.push(()=>llm.close());const engine=await bootEngine({llm,...opts});cleanups.push(()=>engine.close());
  const c=await wire(engine.port,engine.token);return {engine,llm,c};
}
async function good(c:WireClient,method:string,p?:unknown){const r=await c.call(method,p);expect(r.error,method).toBeUndefined();return r.result;}
const session=async(c:WireClient)=>(await good(c,'chat.sessions.create',{})).id as string;
const ended=(c:WireClient,sid:string,n=1)=>runEventsOf(c,sid).filter(e=>e.kind==='turnEnd'||e.kind==='error').length>=n;
const runs=(dir:string,sid:string)=>readDb<any>(dir,'SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation',sid);
const rows=(dir:string,sid:string)=>readDb<any>(dir,'SELECT * FROM session_inputs WHERE session_id=? ORDER BY seq',sid);
const messages=(dir:string,sid:string)=>readDb<any>(dir,'SELECT * FROM messages WHERE session_id=? ORDER BY created_at, id',sid).map(r=>({...r,parts:JSON.parse(r.parts_json)}));
const userText=(dir:string,sid:string)=>messages(dir,sid).filter(m=>m.role==='user').flatMap(m=>m.parts).filter(p=>p.type==='text').map(p=>p.value);

describe('F07 production inbox',()=>{
  it('E1 two clients resend same steer: one persisted input/user row, one run, first safe request has it once',async()=>{
    const {engine,llm,c}=await boot({S1:[{chunks:['first']},{text:'steered answer'}]});const sid=await session(c),other=await wire(engine.port,engine.token);
    const run=await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] original',promptId:'initial'});
    await waitFor('first HTTP request',()=>llm.hitsOf('S1').length===1);
    expect((await c.call('chat.input.send',{sessionId:sid,messageId:'fresh-stale',runId:'stale-run',mode:'steer',text:'must reject'})).error?.message).toContain('已更换');
    const p={sessionId:sid,messageId:'steer-1',runId:run.runId,mode:'steer',text:'additional instruction'};
    const reply=await Promise.all([good(c,'chat.input.send',p),good(other,'chat.input.send',p)]);
    expect(reply.map(x=>x.duplicate).sort()).toEqual([false,true]);expect(rows(engine.dataDir,sid)).toHaveLength(1);
    expect(userText(engine.dataDir,sid)).toEqual(['[[S1]] original']);
    const snap=await good(other,'state.attach',{sessionId:sid});expect(snap.snapshot.inputs).toMatchObject([{messageId:'steer-1',state:'pending'}]);
    llm.gate('S1').open();await waitFor('same run ends',()=>ended(c,sid));
    expect(llm.hitsOf('S1')).toHaveLength(2);expect(JSON.stringify(llm.hitsOf('S1')[0].messages)).not.toContain('additional instruction');
    expect(JSON.stringify(llm.hitsOf('S1')[1].messages).match(/additional instruction/g)).toHaveLength(1);
    expect(userText(engine.dataDir,sid)).toEqual(['[[S1]] original','additional instruction']);expect(runs(engine.dataDir,sid).map(r=>r.generation)).toEqual([1]);
    expect(rows(engine.dataDir,sid)).toMatchObject([{state:'delivered',run_id:run.runId}]);
    expect((await good(c,'chat.input.send',p)).duplicate).toBe(true);
    expect((await c.call('chat.input.send',{...p,text:'different'})).error?.message).toContain('另一条');
  },40000);

  it('E2 queue FIFO, cancel pending row and stale Stop cannot abort the automatically started next run',async()=>{
    const {engine,llm,c}=await boot({S1:[{chunks:['original done']}],S2:[{chunks:['queued two']}],S3:[{text:'queued three'}]});const sid=await session(c);
    const original=await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] start',promptId:'original'});
    for(const [messageId,text] of [['q1','cancel me'],['q2','[[S2]] second'],['q3','[[S3]] third']])await good(c,'chat.input.send',{sessionId:sid,messageId,text,mode:'queue'});
    await good(c,'chat.input.cancel',{sessionId:sid,messageId:'q1'});expect(llm.hitsOf('S2')).toEqual([]);
    expect((await c.call('chat.prompt',{sessionId:sid,text:'jump queue'})).error?.message).toContain('待发送');
    llm.gate('S1').open();await waitFor('queued second request',()=>llm.hitsOf('S2').length===1);
    expect(llm.hitsOf('S3')).toEqual([]);expect(userText(engine.dataDir,sid)).toEqual(['[[S1]] start','[[S2]] second']);
    const state=await good(c,'chat.runs.snapshot',{sessionId:sid}),active=state.runs.find((r:any)=>r.state==='running');expect(active.generation).toBe(2);
    expect((await c.call('chat.cancel',{sessionId:sid,runId:original.runId})).error?.message).toContain('已更换');
    expect((await c.call('chat.input.cancel',{sessionId:sid,messageId:'q2'})).error?.message).toContain('停止');
    llm.gate('S2').open();await waitFor('all three ended',()=>ended(c,sid,3));
    expect(userText(engine.dataDir,sid)).toEqual(['[[S1]] start','[[S2]] second','[[S3]] third']);expect(runs(engine.dataDir,sid).map(r=>[r.generation,r.state])).toEqual([[1,'completed'],[2,'completed'],[3,'completed']]);
    expect(rows(engine.dataDir,sid).map(r=>[r.input_id,r.state])).toEqual([['q1','cancelled'],['q2','delivered'],['q3','delivered']]);
  },40000);

  it('E3 stopping holds queued input and old steer; explicit resume turns that steer into a fresh queue run',async()=>{
    const {engine,llm,c}=await boot({S1:[{hang:true}],S2:[{text:'resumed steer'}],S3:[{text:'resumed queue'}]});const sid=await session(c);
    const run=await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] hang',promptId:'hang'});
    await waitFor('hung request',()=>llm.hitsOf('S1').length===1);
    const old={sessionId:sid,messageId:'steer-old',mode:'steer',runId:run.runId,text:'[[S2]] resume as queue'};
    await good(c,'chat.input.send',old);await good(c,'chat.input.send',{sessionId:sid,messageId:'q',mode:'queue',text:'[[S3]] last'});
    await good(c,'chat.cancel',{sessionId:sid,runId:run.runId});await waitFor('cancel ends',()=>ended(c,sid));
    expect(rows(engine.dataDir,sid).map(r=>r.state)).toEqual(['held','held']);expect(llm.hitsOf('S2')).toEqual([]);expect(llm.hitsOf('S3')).toEqual([]);
    expect((await good(c,'chat.input.send',old)).input.state).toBe('held');
    await good(c,'chat.input.resume',{sessionId:sid,messageId:'steer-old'});await waitFor('resumed steer ends',()=>ended(c,sid,2));
    expect(llm.hitsOf('S2')).toHaveLength(1);expect(llm.hitsOf('S3')).toHaveLength(0);
    expect(rows(engine.dataDir,sid)[0]).toMatchObject({mode:'queue',state:'delivered'});expect(rows(engine.dataDir,sid)[0].run_id).not.toBe(run.runId);
    await good(c,'chat.input.resume',{sessionId:sid,messageId:'q'});await waitFor('explicit queue ends',()=>ended(c,sid,3));
    expect(runs(engine.dataDir,sid).map(r=>r.state)).toEqual(['cancelled','completed','completed']);
  },40000);

  it('E4 invalid queue model holds head; empty-history assistant and legacy prompt cannot jump it',async()=>{
    const {engine,llm,c}=await boot({S1:[{text:'valid'}]});const sid=await session(c);
    await good(c,'chat.input.send',{sessionId:sid,messageId:'bad',mode:'queue',text:'invalid provider',providerId:'missing-provider'});
    await waitFor('failed queue held',()=>rows(engine.dataDir,sid)[0]?.state==='held');
    await good(c,'chat.input.send',{sessionId:sid,messageId:'valid',mode:'queue',text:'[[S1]] valid'});
    expect((await c.call('chat.sessions.applyAssistant',{sessionId:sid,assistantId:''})).error?.message).toContain('待发送');
    expect((await c.call('chat.prompt',{sessionId:sid,text:'jump'})).error?.message).toContain('待发送');
    expect(messages(engine.dataDir,sid)).toEqual([]);expect(runs(engine.dataDir,sid)).toEqual([]);expect(llm.hitsOf('S1')).toEqual([]);
    await good(c,'chat.input.cancel',{sessionId:sid,messageId:'bad'});await waitFor('valid queue starts and finishes',()=>ended(c,sid));
    expect(userText(engine.dataDir,sid)).toEqual(['[[S1]] valid']);
  },40000);

  it('E5 engine restart does not resend held input, duplicates and outcomes preserve original identity',async()=>{
    const {engine,llm,c}=await boot({S1:[{chunks:['old answer']}],S2:[{text:'new answer'}]});const sid=await session(c);
    await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] starting'});await waitFor('old request',()=>llm.hitsOf('S1').length===1);
    const p={sessionId:sid,messageId:'durable',mode:'queue',text:'[[S2]] durable queue'};await good(c,'chat.input.send',p);
    c.terminate();await engine.restart();const fresh=await wire(engine.port,engine.token);
    const at=await good(fresh,'state.attach',{sessionId:sid});expect(at.snapshot.inputs).toMatchObject([{messageId:'durable',state:'held'}]);expect(llm.hitsOf('S2')).toHaveLength(0);
    expect((await good(fresh,'chat.input.send',p)).duplicate).toBe(true);
    const out=await good(fresh,'state.outcomes',{refs:[{kind:'input',sessionId:sid,messageId:'durable'},{kind:'input',sessionId:sid,messageId:'absent'}]});
    expect(out.outcomes).toMatchObject([{status:'accepted',input:{state:'held'}},{status:'not-accepted'}]);
    await good(fresh,'chat.input.resume',{sessionId:sid,messageId:'durable'});await waitFor('resume after restart',()=>ended(fresh,sid));expect(llm.hitsOf('S2')).toHaveLength(1);
    expect(rows(engine.dataDir,sid)).toHaveLength(1);
  },40000);

  it('E6 physical deletion erases input rows and retained input frames; late input queries disclose no content',async()=>{
    const {engine,llm,c}=await boot({S1:[{chunks:['hold']}]});const sid=await session(c);
    const before=await good(c,'state.attach',{}),cursor={epoch:before.epoch,instanceId:before.instanceId,lastSeq:before.lastSeq};
    await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] original'});await waitFor('request',()=>llm.hitsOf('S1').length===1);
    await good(c,'chat.input.send',{sessionId:sid,messageId:'secret',mode:'queue',text:'F07-unique-secret-body'});
    await good(c,'chat.sessions.delete',{sessionId:sid,confirm:true});expect(rows(engine.dataDir,sid)).toEqual([]);expect(messages(engine.dataDir,sid)).toEqual([]);
    const replay=await good(c,'state.attach',{sessionId:sid,resume:cursor});expect(JSON.stringify(replay)).not.toContain('F07-unique-secret-body');expect(replay.inputs??replay.snapshot?.inputs).toEqual([]);
    const out=await good(c,'state.outcomes',{refs:[{kind:'input',sessionId:sid,messageId:'secret'}]});expect(out.outcomes).toMatchObject([{status:'not-accepted',error:'会话已删除'}]);
    expect((await c.call('chat.input.send',{sessionId:sid,messageId:'late',mode:'queue',text:'late'})).error?.message).toContain('会话已删除');
    expect((await c.call('chat.input.resume',{sessionId:sid,messageId:'secret'})).error?.message).toContain('会话已删除');
  },40000);

  it('E7 Stop with two approval tools preserves no-effects proof, never starts the second, and queues remain held',async()=>{
    const {engine,c}=await boot({S1:[{tools:[{name:'file_write',input:skillWriteInput('first.txt','first')},{name:'file_write',input:skillWriteInput('first.txt','second')}]},{text:'done'}]});const sid=await session(c);
    const run=await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] two writes',promptId:'two-writes'});
    await waitFor('first held card',()=>c.notifications.some(n=>n.method==='permission.request'&&n.params.req.sessionId===sid));
    await good(c,'chat.input.send',{sessionId:sid,messageId:'after',mode:'queue',text:'queued after stop'});
    await good(c,'chat.input.send',{sessionId:sid,messageId:'steer',mode:'steer',runId:run.runId,text:'do not imply permission'});
    expect(c.notifications.filter(n=>n.method==='permission.request')).toHaveLength(1);
    await good(c,'chat.cancel',{sessionId:sid,runId:run.runId});await waitFor('stopped summary',()=>c.notifications.some(n=>n.method==='chat.inputs.stopped'));
    const summary=c.notifications.find(n=>n.method==='chat.inputs.stopped')!.params;
    const exec=readDb<any>(engine.dataDir,'SELECT * FROM tool_executions WHERE run_id=? ORDER BY call_index',run.runId);
    expect(exec).toHaveLength(2);expect(exec[1].started).toBe(0);expect(summary.started+summary.notStarted).toBe(2);expect(summary.unknown).toBe(0);
    expect(existsSync(skillFile(engine.dataDir,'first.txt'))).toBe(false);expect(existsSync(skillFile(engine.dataDir,'second.txt'))).toBe(false);
    expect(rows(engine.dataDir,sid).map(r=>r.state)).toEqual(['held','held']);
    const card=c.notifications.find(n=>n.method==='permission.request')!.params.requestId;await good(c,'permission.respond',{requestId:card,decision:'allow-once'});
    expect(existsSync(skillFile(engine.dataDir,'first.txt'))).toBe(false);
  },40000);

  it('E8 send reply lost after acceptance: outcomes reconcile it, original ID resend makes no second history/run',async()=>{
    const {engine,llm,c}=await boot({S1:[{chunks:['hold']}]});const sid=await session(c),run=await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] original'});
    // Legacy prompt has no runId return; use its real ledger snapshot.
    const snap=await good(c,'chat.runs.snapshot',{sessionId:sid}),runId=snap.runs.find((r:any)=>r.state==='running').runId;
    const proxy=await faultProxy(engine.port);cleanups.push(()=>proxy.close());const lostClient=await wire(proxy.port,engine.token);
    proxy.forwardThenCut('chat.input.send');const p={sessionId:sid,messageId:'lost-reply',mode:'steer',runId,text:'accepted before disconnect'};
    const lost=await lostClient.call('chat.input.send',p);expect(lost.error).toBeDefined();
    const fresh=await wire(engine.port,engine.token),out=await good(fresh,'state.outcomes',{refs:[{kind:'input',sessionId:sid,messageId:p.messageId}]});
    expect(out.outcomes).toMatchObject([{status:'accepted',input:{state:'pending'}}]);expect((await good(fresh,'chat.input.send',p)).duplicate).toBe(true);
    llm.gate('S1').open();await waitFor('complete',()=>ended(c,sid));expect(runs(engine.dataDir,sid)).toHaveLength(1);
    expect(userText(engine.dataDir,sid).filter(t=>t==='accepted before disconnect')).toHaveLength(1);expect(proxy.countUp('chat.input.send')).toBe(1);
  },40000);
  it('E9 Stop preserves an allowed real effect, cancels the active approval and never starts the third tool',async()=>{
    const {engine,c}=await boot({S1:[{tools:[{name:'file_write',input:skillWriteInput('real-effect.txt','committed')},{name:'file_write',input:skillWriteInput('real-effect.txt','must-not-write')},{name:'file_write',input:skillWriteInput('real-effect.txt','must-not-start')}]},{text:'done'}]});
    const sid=await session(c),run=await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] real effects',promptId:'real-effects'});
    await waitFor('first card',()=>c.notifications.filter(n=>n.method==='permission.request').length===1);
    const first=c.notifications.find(n=>n.method==='permission.request')!.params.requestId;await good(c,'permission.respond',{requestId:first,decision:'allow-once'});
    await waitFor('second card after first effect',()=>c.notifications.filter(n=>n.method==='permission.request').length===2);
    expect(readFileSync(skillFile(engine.dataDir,'real-effect.txt'),'utf8')).toBe('committed');
    await good(c,'chat.cancel',{sessionId:sid,runId:run.runId});await waitFor('stop facts',()=>c.notifications.some(n=>n.method==='chat.inputs.stopped'));
    const fact=c.notifications.find(n=>n.method==='chat.inputs.stopped')!.params;
    expect(fact).toMatchObject({started:2,notStarted:1,unknown:0,possibleSideEffects:true});
    expect(readFileSync(skillFile(engine.dataDir,'real-effect.txt'),'utf8')).toBe('committed');
    const exec=readDb<any>(engine.dataDir,'SELECT * FROM tool_executions WHERE run_id=? ORDER BY call_index',run.runId);
    expect(exec[0]).toMatchObject({started:1,state:'completed'});expect(exec[1]).toMatchObject({started:1,state:'cancelled'});expect(exec[2].started).toBe(0);
  },40000);
  it('E10 queue starting behind MCP is claimed once; duplicate does not launch and Stop holds it without a user row',async()=>{
    const mcp=await hangingMcp(20);cleanups.push(()=>mcp.close());const {engine,llm,c}=await boot({S1:[{text:'must-not-run'}]},{seed:mcp.seed});
    const sid=await session(c),p={sessionId:sid,messageId:'starting-queue',mode:'queue',text:'[[S1]] waiting MCP'};
    await good(c,'chat.input.send',p);await waitFor('starting queue bound',()=>rows(engine.dataDir,sid)[0]?.run_id!=null);
    const started=rows(engine.dataDir,sid)[0];expect(started.state).toBe('starting');expect(messages(engine.dataDir,sid)).toEqual([]);
    expect((await good(c,'chat.input.send',p)).duplicate).toBe(true);expect(runs(engine.dataDir,sid)).toHaveLength(1);
    expect((await c.call('chat.input.cancel',{sessionId:sid,messageId:p.messageId})).error?.message).toContain('停止');
    await good(c,'chat.cancel',{sessionId:sid,runId:started.run_id});mcp.release();
    await waitFor('starting cancellation persisted',()=>runs(engine.dataDir,sid)[0]?.state==='cancelled');
    expect(rows(engine.dataDir,sid)[0].state).toBe('held');expect(messages(engine.dataDir,sid)).toEqual([]);expect(llm.hitsOf('S1')).toEqual([]);
  },40000);

  it('E11 final provider failure holds later queue instead of starting it after a completed real file effect',async()=>{
    const {engine,llm,c}=await boot({S1:[{tools:[{name:'file_write',input:skillWriteInput('before-failure.txt','kept')}]},{status:400}],S2:[{text:'must-not-start'}]});
    const sid=await session(c);await good(c,'chat.prompt',{sessionId:sid,text:'[[S1]] then fail',promptId:'provider-failure'});
    await waitFor('held card',()=>c.notifications.some(n=>n.method==='permission.request'));
    await good(c,'chat.input.send',{sessionId:sid,messageId:'after-failure',mode:'queue',text:'[[S2]] later'});
    await good(c,'permission.respond',{requestId:c.notifications.find(n=>n.method==='permission.request')!.params.requestId,decision:'allow-once'});
    await waitFor('provider failed',()=>ended(c,sid));expect(runs(engine.dataDir,sid).map(r=>r.state)).toEqual(['failed']);
    expect(readFileSync(skillFile(engine.dataDir,'before-failure.txt'),'utf8')).toBe('kept');expect(rows(engine.dataDir,sid)[0].state).toBe('held');expect(llm.hitsOf('S2')).toEqual([]);
  },40000);

});
