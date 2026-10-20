/** F07 real renderer store/RpcClient against real engine, HTTP endpoint and fault proxy. */
import {afterEach,describe,expect,it} from 'vitest';
import {bootEngine,faultProxy,gatedLlm,rendererOn,waitFor,wireClient,type GatedStep} from './state-sync-fixture';
import {readDb} from './run-ledger-fixture';
const cleanup:(()=>void|Promise<void>)[]=[];
const savedEnv={...process.env},savedGlobals=new Map(['window','WebSocket','sessionStorage'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
afterEach(async()=>{
 for(const f of cleanup.splice(0).reverse())await f();
 for(const k of Object.keys(process.env))if(!(k in savedEnv))delete process.env[k];for(const [k,v] of Object.entries(savedEnv))process.env[k]=v;
 for(const [k,d] of savedGlobals)if(d)Object.defineProperty(globalThis,k,d);else delete (globalThis as any)[k];
});
async function setup(scripts:Record<string,GatedStep[]>){
 const llm=await gatedLlm(scripts);cleanup.push(()=>llm.close());const engine=await bootEngine({llm});cleanup.push(()=>engine.close());
 const c=wireClient(engine.port,engine.token);await c.ready;cleanup.push(()=>c.terminate());
 const sid=(await c.call('chat.sessions.create',{})).result.id as string;return {llm,engine,c,sid};
}
const entries=(dir:string,sid:string)=>readDb<any>(dir,'SELECT * FROM session_inputs WHERE session_id=? ORDER BY seq',sid);
describe('F07 renderer integration',()=>{
 it('I1 reload while steer and queue pending reconstructs input facts without new request; original run consumes steer then FIFO starts queue',async()=>{
  const {engine,llm,sid}=await setup({S1:[{chunks:['first','second']},{text:'steered'}],S2:[{text:'queued'}]});
  const a=await rendererOn({info:engine.info});cleanup.push(()=>a.close());await a.chat.open(sid);await a.chat.send('[[S1]] original');
  llm.gate('S1').release();await waitFor('visible first chunk',()=>a.chat.streamingText==='first');const runId=a.chat.runOf[sid].runId;
  expect(a.chat.inputsOn).toBe(true);expect(await a.chat.sendInput('steer','additional')).toBe(true);expect(await a.chat.sendInput('queue','[[S2]] queue')).toBe(true);
  expect(a.chat.streamingText).toBe('first');expect(a.chat.running).toBe(true);expect(a.chat.inputsBySession[sid].map(i=>i.state)).toEqual(['pending','pending']);
  await a.close();const b=await rendererOn({info:engine.info,storage:a.storage});cleanup.push(()=>b.close());await b.chat.open(sid);
  expect(b.chat.inputsBySession[sid].map(i=>i.state)).toEqual(['pending','pending']);expect(b.chat.runOf[sid].runId).toBe(runId);expect(llm.hitsOf('S1')).toHaveLength(1);
  llm.gate('S1').open();await waitFor('all inputs delivered',()=>entries(engine.dataDir,sid).every(r=>r.state==='delivered')&&entries(engine.dataDir,sid).length===2,15000);
  await waitFor('renderer completed queue',()=>!b.chat.running&&b.chat.inputsBySession[sid].every(i=>i.state==='delivered'),15000);
  expect(llm.hitsOf('S1')).toHaveLength(2);expect(llm.hitsOf('S2')).toHaveLength(1);expect(b.unhandled()).toBe(0);
  const runs=readDb<any>(engine.dataDir,'SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation',sid);expect(runs.map(r=>r.generation)).toEqual([1,2]);
 },40000);
 it('I2 accepted input reply lost: automatic reconnect queries same ID without replay and keeps original run',async()=>{
  const {engine,llm,sid}=await setup({S1:[{chunks:['first','second']},{text:'steered'}]});
  const proxy=await faultProxy(engine.port);cleanup.push(()=>proxy.close());const r=await rendererOn({info:()=>({...engine.info(),port:proxy.port})});cleanup.push(()=>r.close());
  await r.chat.open(sid);await r.chat.send('[[S1]] original');llm.gate('S1').release();await waitFor('first chunk',()=>r.chat.streamingText==='first');
  await r.quiet();proxy.forwardThenCut('chat.input.send');expect(await r.chat.sendInput('steer','survive lost reply')).toBe(true);
  await waitFor('reconciled input after reconnect',()=>r.chat.inDoubtInputs.length===0&&r.chat.inputsBySession[sid]?.some(i=>i.text==='survive lost reply'),15000);
  expect(proxy.countUp('chat.input.send')).toBe(1);expect(entries(engine.dataDir,sid)).toHaveLength(1);expect(llm.hitsOf('S1')).toHaveLength(1);
  llm.gate('S1').open();await waitFor('delivered',()=>entries(engine.dataDir,sid)[0]?.state==='delivered');expect(r.unhandled()).toBe(0);
 },40000);
 it('I3 unsent input after disconnect remains draft; explicit unchanged retry uses original identity and sends once',async()=>{
  const {engine,llm,sid}=await setup({S1:[{chunks:['first','second']},{text:'steered'}]});
  const proxy=await faultProxy(engine.port);cleanup.push(()=>proxy.close());const r=await rendererOn({info:()=>({...engine.info(),port:proxy.port})});cleanup.push(()=>r.close());
  await r.chat.open(sid);await r.chat.send('[[S1]] original');llm.gate('S1').release();await waitFor('first chunk',()=>r.chat.streamingText==='first');await r.quiet();
  proxy.cutBefore('chat.input.send');expect(await r.chat.sendInput('steer','retain original draft')).toBe(true);
  await waitFor('not-accepted draft',()=>!!r.chat.failedInputDrafts[sid]?.length,15000);const draft=r.chat.failedInputDrafts[sid][0];
  expect(proxy.countUp('chat.input.send')).toBe(0);expect(entries(engine.dataDir,sid)).toHaveLength(0);
  r.chat.inputRetryBySession[sid]=draft;expect(await r.chat.sendInput('steer',draft.text,draft.attachments)).toBe(true);
  expect(entries(engine.dataDir,sid)[0].input_id).toBe(draft.messageId);expect(proxy.countUp('chat.input.send')).toBe(1);
  llm.gate('S1').open();await waitFor('delivered once',()=>entries(engine.dataDir,sid)[0]?.state==='delivered');expect(entries(engine.dataDir,sid)).toHaveLength(1);expect(r.unhandled()).toBe(0);
 },40000);
});
