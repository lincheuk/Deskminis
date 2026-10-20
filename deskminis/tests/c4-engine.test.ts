import {afterEach,describe,expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {bootEngine,gatedLlm,waitFor,wireClient,runEventsOf,type GatedStep} from './state-sync-fixture';
import {readDb} from './run-ledger-fixture';
import {startCapturedEngine,startAccessProbeEngine,accessMatrix} from './engine-assembly';
const cleanup:(()=>void|Promise<void>)[]=[];
const saved={...process.env};afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);});
async function setup(scripts:Record<string,GatedStep[]>){const llm=await gatedLlm(scripts);cleanup.push(()=>llm.close());const engine=await bootEngine({llm});cleanup.push(()=>engine.close());const c=wireClient(engine.port,engine.token);await c.ready;cleanup.push(()=>c.terminate());
 const good=async(method:string,p:object={})=>{const r=await c.call(method,p);expect(r.error,method+JSON.stringify(r.error)).toBeUndefined();return r.result;};const sid=(await good('chat.sessions.create')).id as string;
 const send=(id:string,text=id)=>good('chat.input.send',{sessionId:sid,messageId:id,mode:'queue',text});const op=(method:string,id:string,extra:object={})=>good('chat.input.'+method,{sessionId:sid,messageId:id,...extra});
 const rows=()=>readDb<any>(engine.dataDir,'SELECT * FROM session_inputs WHERE session_id=? ORDER BY seq',sid);
 const texts=()=>readDb<any>(engine.dataDir,"SELECT * FROM messages WHERE session_id=? AND role='user' ORDER BY created_at,id",sid).flatMap(r=>JSON.parse(r.parts_json)).filter(p=>p.type==='text').map(p=>p.value);
 return {llm,engine,c,good,sid,send,op,rows,texts};}
describe('C4 real engine RPC',()=>{
 it('C4E1 held edit resumes at original position and launches new body through request_json',async()=>{
  const e=await setup({S1:[{chunks:['current']}],S2:[{text:'new body answer'}],S3:[{text:'last'}]});
  await e.good('chat.prompt',{sessionId:e.sid,text:'[[S1]] current',promptId:'c4-live-run'});await waitFor('current hit',()=>e.llm.hitsOf('S1').length===1);await e.send('a','old body');await e.send('b','[[S3]] last');
  const h=(await e.op('hold','a')).input;expect(h).toMatchObject({state:'held',reason:'正在编辑'});const before=e.rows();const stale=await e.c.call('chat.input.edit',{sessionId:e.sid,messageId:'a',text:'stale',updatedAt:h.updatedAt-1,resume:true});expect(stale.error?.message).toContain('别处改过');expect(e.rows()).toEqual(before);
  const edited=(await e.op('edit','a',{text:'[[S2]] new body',updatedAt:h.updatedAt,resume:true})).input;expect(edited.updatedAt).toBeGreaterThan(h.updatedAt);expect(edited.state).toBe('pending');
  e.llm.gate('S1').open();await waitFor('three turns ended',()=>runEventsOf(e.c,e.sid).filter(v=>v.kind==='turnEnd').length===3,20000);
  expect(e.texts()).toEqual(['[[S1]] current','[[S2]] new body','[[S3]] last']);expect(e.rows().map(r=>r.state)).toEqual(['delivered','delivered']);expect(e.c.notifications.some(n=>n.method==='chat.inputs.changed'&&n.params.inputs.some((i:any)=>i.text==='[[S2]] new body'))).toBe(true);
 },40000);
 it('C4E2 moving past held head kicks idle queue and persisted order survives engine restart',async()=>{
  const e=await setup({S1:[{chunks:['current']}],S2:[{text:'moved head'}]});const run=await e.good('chat.prompt',{sessionId:e.sid,text:'[[S1]] current',promptId:'c4-live-run'});await waitFor('current hit',()=>e.llm.hitsOf('S1').length===1);
  await e.send('a','held');await e.op('hold','a');await e.send('b','[[S2]] moved');await e.send('c','held last');await e.op('hold','c');await e.op('move','c',{beforeMessageId:'b'});
  const list=await e.good('chat.input.list',{sessionId:e.sid});expect(list.inputs.map((i:any)=>i.messageId)).toEqual(['a','c','b']);
  e.llm.gate('S1').open();await waitFor('original ends',()=>runEventsOf(e.c,e.sid).some(v=>v.kind==='turnEnd'));expect(e.llm.hitsOf('S2')).toHaveLength(0);
  await e.op('move','b',{beforeMessageId:'a'});await waitFor('moved row delivered',()=>e.rows().find(r=>r.input_id==='b')?.state==='delivered');expect(e.texts()).toEqual(['[[S1]] current','[[S2]] moved']);
  e.c.terminate();await e.engine.restart();const c=wireClient(e.engine.port,e.engine.token);await c.ready;cleanup.push(()=>c.terminate());const r=await c.call('chat.input.list',{sessionId:e.sid});expect(r.result.inputs.map((i:any)=>i.messageId)).toEqual(['b','a','c']);expect(r.result.inputs.filter((i:any)=>i.state==='held').map((i:any)=>i.messageId)).toEqual(['a','c']);
 },40000);
 it('C4E3 steer checks live run before mutation and enters same run next boundary; stale pending becomes held',async()=>{
  const e=await setup({S1:[{chunks:['first']},{text:'steered answer'}]});const run=await e.good('chat.prompt',{sessionId:e.sid,text:'[[S1]] current',promptId:'c4-live-run'});await waitFor('current hit',()=>e.llm.hitsOf('S1').length===1);await e.send('remain','held queue');await e.op('hold','remain');await e.send('q','converted supplement');
  const before=e.rows();const bad=await e.c.call('chat.input.steer',{sessionId:e.sid,messageId:'q',runId:'wrong'});expect(bad.error?.message).toBe('运行已结束或已更换，没有改成补充指示');expect(e.rows()).toEqual(before);
  await e.op('steer','q',{runId:run.runId});e.llm.gate('S1').open();await waitFor('run ended',()=>runEventsOf(e.c,e.sid).some(v=>v.kind==='turnEnd'));expect(e.llm.hitsOf('S1')).toHaveLength(2);expect(e.texts()).toEqual(['[[S1]] current','converted supplement']);expect(JSON.stringify(e.llm.hitsOf('S1')[1].messages)).toContain('converted supplement');
  expect(readDb<any>(e.engine.dataDir,'SELECT * FROM agent_runs WHERE session_id=?',e.sid)).toHaveLength(1);
  // A new queue after completion is held first; no live run may convert it.
  const old=e.rows();expect((await e.c.call('chat.input.steer',{sessionId:e.sid,messageId:'remain',runId:run.runId})).error?.message).toContain('已结束');expect(e.rows()).toEqual(old);
 },40000);
 it('C4E4 four new RPCs use actual business access matrix',async()=>{
  const business=await startCapturedEngine();cleanup.push(()=>business.close());const fp=await business.pair();await business.handle.close();const probe=await startAccessProbeEngine({dataDir:business.root});cleanup.push(()=>probe.close());
  const names=['chat.input.hold','chat.input.edit','chat.input.move','chat.input.steer'];const methods=Object.fromEntries(names.map(n=>[n,probe.methods[n]]));const completed:string[]=[],matrix=await accessMatrix(methods,fp,completed);expect(completed).toEqual([]);
  for(const name of names)expect(matrix[name]).toEqual({local:{allowed:true},remote:{allowed:true},pairing:{allowed:false,error:name+' 在 pairing 模式下不可用（配对期仅可调 remote.pair.complete）'}});
  if(process.env.C4_ACCESS_CAPTURE)writeFileSync(process.env.C4_ACCESS_CAPTURE,JSON.stringify(matrix,null,2)+'\n',{flag:'wx'});
 },60000);
});
