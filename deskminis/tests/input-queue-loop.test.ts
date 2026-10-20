/** F07: controlled waits and actual provider requests/history/tool side effects. */
import {afterAll, describe, expect, it} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runAgentLoop, type RunOptions} from '../src/minisd/agent/loop';
import {InputQueueStore} from '../src/minisd/store/input-queue';
import {ContextPolicy} from '../src/minisd/agent/context-policy';
import {ProviderError, type AgentProvider, type StreamRequest} from '../src/minisd/providers/types';
import type {AgentStreamEvent} from '../src/shared/types';
import type {PermissionGateway} from '../src/minisd/tools/types';
import {ledgerEnv, type LedgerEnv} from './run-recovery-fixture';
import {Gate, Trace, ManualGateway, allowAll, collect, fxWrite, gatedTool, settle, toolTurn, untilWaiting, waitFor, withDeadline} from './scheduler-fixture';
import {ascii, mkCatalog, mkCtx, openai, openaiOk, relay, runLoop, scriptedSummarizer, strictEndpoint} from './overflow-recovery-fixture';

const envs: LedgerEnv[]=[];
afterAll(()=>{for(const e of envs)e.db.close();});
const answer:AgentStreamEvent[]=[{kind:'textDelta',text:'done'},{kind:'done',stopReason:'endTurn'}];
type Script=(n:number,req:StreamRequest,signal?:AbortSignal)=>AsyncIterable<AgentStreamEvent>;
class Capture implements AgentProvider {
  readonly name='f07-fixture';readonly modelId='fake';readonly requests:StreamRequest[]=[];
  constructor(private readonly script:Script){}
  async *streamAgentMessage(req:StreamRequest,signal?:AbortSignal){
    const n=this.requests.push(req);if(n>20)throw Error('unbounded F07 requests');
    yield* this.script(n,req,signal);
  }
}
function fixture(label:string){
  const e=ledgerEnv(`f07-${label}`);envs.push(e);const sid=e.newSession();
  e.store.appendMessage({id:e.store.newId(),sessionId:sid,role:'user',parts:[{type:'text',value:'initial'}],createdAt:e.store.nowEpoch(),streamInterruptCount:0});
  const inbox=new InputQueueStore(e.db,{isSessionDeleted:s=>e.store.isDeleted(s)});
  const hook=(sessionId=sid,runId='R'):NonNullable<RunOptions['inputQueue']>=>({
    admit:append=>inbox.admitSteers(sessionId,runId,i=>append(i.text)),
    hasPending:()=>inbox.pendingSteers(sessionId,runId),delivered:ids=>{inbox.delivered(sessionId,ids);},
  });
  const send=(id='s1',sessionId=sid,runId='R')=>inbox.send({sessionId,messageId:id,mode:'steer',runId,text:`steer:${id}`});
  const start=(p:AgentProvider,o:{sid?:string;gw?:PermissionGateway;signal?:AbortSignal;extra?:Partial<RunOptions>}={})=>{
    const sessionId=o.sid??sid;
    return collect(runAgentLoop(e.store,{sessionId,provider:p,tools:e.tools,systemPrompt:'sys',scheduler:e.scheduler,retryDelaysMs:[0],
      toolContext:{sessionId,paths:e.paths,permissions:o.gw??allowAll,signal:o.signal},signal:o.signal,inputQueue:hook(sessionId),...o.extra}));
  };
  return {e,sid,inbox,hook,send,start};
}
function text(req:StreamRequest):string{return req.messages.flatMap(m=>m.parts.filter(p=>p.type==='text').map(p=>p.value)).join('\n');}
function historyText(e:LedgerEnv,sid:string):string[]{return e.store.listMessages(sid).flatMap(m=>m.parts.filter(p=>p.type==='text').map(p=>String(p.value)));}

describe('F07 loop safe boundaries',()=>{
  it('L1 streaming: two steers wait, append once after complete reply, get first-result receipts and one turnEnd',async()=>{
    const f=fixture('stream'),g=new Gate(),firstNext=new Gate();
    const p=new Capture(async function*(n){if(n===1){yield {kind:'textDelta',text:'first'};await g.opened;yield {kind:'done',stopReason:'endTurn'};}
      else{await firstNext.opened;yield* answer;}});
    const done=f.start(p);await waitFor('first request',()=>p.requests.length===1);await settle();f.send('one');f.send('two');await settle();
    expect(p.requests).toHaveLength(1);expect(historyText(f.e,f.sid)).toEqual(['initial']);
    expect(f.inbox.list(f.sid).map(i=>i.state)).toEqual(['pending','pending']);
    g.open();await waitFor('second request',()=>p.requests.length===2);
    expect(f.inbox.list(f.sid).map(i=>i.state)).toEqual(['admitted','admitted']);
    expect(text(p.requests[1])).toContain('steer:one\nsteer:two');expect(text(p.requests[0])).not.toContain('steer:');
    firstNext.open();const events=await withDeadline(done,5000,'stream done');
    expect(f.inbox.list(f.sid).map(i=>i.state)).toEqual(['delivered','delivered']);
    expect(historyText(f.e,f.sid)).toEqual(['initial','first','steer:one','steer:two','done']);
    expect(events.filter(e=>e.kind==='turnEnd')).toEqual([{kind:'turnEnd',stopReason:'endTurn'}]);
  });

  it('L2 tools: an entire serial batch settles before steer; both real effects occur once in order',async()=>{
    const f=fixture('batch'),g=new Gate(),trace=new Trace(),counter=join(f.e.root,'effects.txt');
    f.e.tools.register(fxWrite({trace,gateOf:i=>i.tag==='A'?g:undefined}));
    const p=new Capture(async function*(n){yield* n===1?toolTurn([
      {id:'A',name:'fx_write',input:{tag:'A',path:counter,content:'A'}},
      {id:'B',name:'fx_write',input:{tag:'B',path:counter,content:'B'}},
    ]):answer;});
    const done=f.start(p);await trace.until('A:enter');f.send();await settle();
    expect(trace.has('B:enter')).toBe(false);expect(existsSync(counter)).toBe(false);expect(p.requests).toHaveLength(1);
    expect(f.inbox.get(f.sid,'s1')?.state).toBe('pending');g.open();await withDeadline(done,5000,'batch done');
    expect(readFileSync(counter,'utf8')).toBe('B');expect(trace.lines.filter(x=>x.endsWith(':effect'))).toEqual(['A:effect','B:effect']);
    expect(p.requests).toHaveLength(2);expect(text(p.requests[1])).toContain('steer:s1');
    const history=f.e.store.listMessages(f.sid),steer=history.findIndex(m=>m.parts.some(p=>p.type==='text'&&p.value==='steer:s1'));
    expect(history[steer-1].parts.map(p=>p.type)).toEqual(['toolResult','toolResult']);
  });

  it('L3 resource lock: second session admits nothing until its real locked write has settled',async()=>{
    const f=fixture('locks'),g=new Gate(),trace=new Trace(),path=join(f.e.root,'shared.txt'),b=f.e.newSession();
    f.e.store.appendMessage({id:f.e.store.newId(),sessionId:b,role:'user',parts:[{type:'text',value:'B initial'}],createdAt:f.e.store.nowEpoch(),streamInterruptCount:0});
    f.e.tools.register(fxWrite({trace,gateOf:i=>i.tag==='A'?g:undefined}));
    const provider=(tag:string)=>new Capture(async function*(n){yield* n===1?toolTurn([{id:tag,name:'fx_write',input:{tag,path,content:tag}}]):answer;});
    const pa=provider('A'),pb=provider('B'),da=f.start(pa);await trace.until('A:enter');const db=f.start(pb,{sid:b});
    await untilWaiting(f.e.scheduler.locks,'B');f.send('locked',b);await settle();
    expect(trace.has('B:enter')).toBe(false);expect(pb.requests).toHaveLength(1);expect(f.inbox.get(b,'locked')?.state).toBe('pending');
    g.open();await withDeadline(Promise.all([da,db]),5000,'locked sessions');
    expect(trace.at('A:effect')).toBeLessThan(trace.at('B:effect'));expect(readFileSync(path,'utf8')).toBe('B');
    expect(text(pb.requests[1])).toContain('steer:locked');expect(f.inbox.get(b,'locked')?.state).toBe('delivered');
  });

  it('L4 permission: steer cannot answer a held card or let the later tool overtake it',async()=>{
    const f=fixture('approval'),gw=new ManualGateway(),trace=new Trace();
    f.e.tools.register(gatedTool({name:'approve',trace,ask:(i,c)=>({kind:'shell',detail:String(i.tag),sessionId:c.sessionId,toolTitle:'approve'})}));
    const p=new Capture(async function*(n){yield* n===1?toolTurn([
      {id:'A',name:'approve',input:{tag:'A'}},{id:'B',name:'approve',input:{tag:'B'}},
    ]):answer;});
    const done=f.start(p,{gw});await gw.untilRequests(1);f.send();await settle();
    expect(gw.held).toHaveLength(1);expect(gw.requests).toHaveLength(1);expect(trace.has('A:effect')).toBe(false);expect(trace.has('B:enter')).toBe(false);
    expect(p.requests).toHaveLength(1);expect(f.inbox.get(f.sid,'s1')?.state).toBe('pending');
    gw.allow();await gw.untilRequests(2);expect(f.inbox.get(f.sid,'s1')?.state).toBe('pending');gw.allow();await withDeadline(done,5000,'approval done');
    expect(trace.lines.filter(x=>x.endsWith(':effect'))).toEqual(['A:effect','B:effect']);expect(text(p.requests[1])).toContain('steer:s1');
  });

  it('L5 cancel during held approval: no effect, later tool never starts and steer remains outside history',async()=>{
    const f=fixture('cancel'),gw=new ManualGateway(),trace=new Trace(),controller=new AbortController();
    f.e.tools.register(gatedTool({name:'approve',trace,ask:(i,c)=>({kind:'shell',detail:String(i.tag),sessionId:c.sessionId,toolTitle:'approve'})}));
    const p=new Capture(async function*(){yield* toolTurn([{id:'A',name:'approve',input:{tag:'A'}},{id:'B',name:'approve',input:{tag:'B'}}]);});
    const done=f.start(p,{gw,signal:controller.signal});await gw.untilRequests(1);f.send();controller.abort();gw.deny();
    const events=await withDeadline(done,5000,'cancel done');expect(events.at(-1)).toEqual({kind:'error',message:'已取消'});
    expect(trace.lines.filter(x=>x.endsWith(':effect'))).toEqual([]);expect(trace.has('B:enter')).toBe(false);expect(p.requests).toHaveLength(1);
    expect(historyText(f.e,f.sid)).not.toContain('steer:s1');expect(f.inbox.get(f.sid,'s1')?.state).toBe('pending');
  });

  it('L6 retry reuses the rejected request without steer; admission happens after successful response',async()=>{
    const f=fixture('retry');
    const p=new Capture(async function*(n){if(n===1){f.send();throw new ProviderError('injected 503',{status:503});}yield* answer;});
    const events=await f.start(p);expect(p.requests).toHaveLength(3);expect(p.requests[1]).toBe(p.requests[0]);
    expect(text(p.requests[1])).not.toContain('steer:');expect(text(p.requests[2])).toContain('steer:s1');
    expect(events.filter(e=>e.kind==='retry')).toHaveLength(1);expect(historyText(f.e,f.sid).filter(x=>x==='steer:s1')).toHaveLength(1);
  });

  it('L7 admission and receipt faults do not retry an already accepted model request',async()=>{
    const f=fixture('observer');let delivered=0;
    const p=new Capture(async function*(){yield* answer;});
    f.send();const hook=f.hook();await f.start(p,{extra:{inputQueue:{...hook,delivered:()=>{delivered++;throw Error('injected observer failure');}}}});
    expect(p.requests).toHaveLength(1);expect(delivered).toBe(1);expect(f.inbox.get(f.sid,'s1')?.state).toBe('admitted');
    const second=fixture('admit-fault'),never=new Capture(async function*(){yield* answer;});
    await expect(second.start(never,{extra:{inputQueue:{...second.hook(),admit:()=>{throw Error('injected admission failure');}}}})).rejects.toThrow('injected admission failure');
    expect(never.requests).toHaveLength(0);
  });

  it('L8 actual F03 endpoint rejection: same-slot recovery does not append pending steer until a successful main reply',async()=>{
    const f=fixture('overflow'),ctx=mkCtx(f.e.root,{db:f.e.db,sessionId:f.sid,tools:[]}),catalog=await mkCatalog(f.e.root);
    for(let n=0;n<7;n++){ctx.say(`question ${n} ${ascii(6000)}`);ctx.reply(`answer ${n} ${ascii(6500)}`);}ctx.say('last question');
    const cfg=relay(64000);let sent=false;
    const ep=strictEndpoint({limit:20000,counts:'input',style:'plain',forceReject:info=>{
      if(!sent){sent=true;f.send('recover');return 20000;}return undefined;
    },main:(_b,info)=>openaiOk('accepted',info.usage),summary:scriptedSummarizer('faithful')});
    const result=await runLoop(ctx,catalog,{primary:{provider:openai(cfg,ep.fetchImpl),input:cfg},extra:{inputQueue:f.hook()}});
    expect(result.events.at(-1)).toEqual({kind:'turnEnd',stopReason:'endTurn'});
    expect(ep.mains().length).toBeGreaterThanOrEqual(3);expect(ep.mains()[0].status).toBe(400);
    const firstAccepted=ep.mains().findIndex(h=>h.status===200);expect(firstAccepted).toBeGreaterThan(0);
    for(const h of ep.mains().slice(0,firstAccepted+1))expect(JSON.stringify(h.body)).not.toContain('steer:recover');
    expect(JSON.stringify(ep.mains().at(-1)!.body)).toContain('steer:recover');expect(f.inbox.get(f.sid,'recover')?.state).toBe('delivered');
  });
  it('L9 maxTokens continuation admits steer after the truncated reply and gives one final turnEnd',async()=>{
    const f=fixture('continuation');const p=new Capture(async function*(n){
      if(n===1){f.send('continue');yield {kind:'textDelta',text:'partial'};yield {kind:'done',stopReason:'maxTokens'};}else yield* answer;
    });
    const events=await f.start(p);expect(p.requests).toHaveLength(2);expect(text(p.requests[0])).not.toContain('steer:continue');
    expect(text(p.requests[1])).toContain('steer:continue');expect(historyText(f.e,f.sid)).toEqual(['initial','partial','steer:continue','done']);
    expect(events.filter(e=>e.kind==='turnEnd')).toEqual([{kind:'turnEnd',stopReason:'endTurn'}]);expect(f.inbox.get(f.sid,'continue')?.state).toBe('delivered');
  });
  it('L10 overflow fallback sends the old request first; pending steer waits for the accepted fallback reply',async()=>{
    const f=fixture('overflow-fallback');const primary=new Capture(async function*(){f.send('fallback');throw new ProviderError('context too long',{code:'contextOverflow',status:400});});
    const backup=new Capture(async function*(){yield* answer;});Object.defineProperty(backup,'modelId',{value:'larger'});
    const events=await f.start(primary,{extra:{fallbackChain:[{provider:backup,label:'larger'}],contextPolicy:new ContextPolicy({getModelContextWindow:id=>id==='larger'?128000:32000})}});
    expect(primary.requests).toHaveLength(1);expect(backup.requests).toHaveLength(2);expect(text(backup.requests[0])).not.toContain('steer:fallback');
    expect(text(backup.requests[1])).toContain('steer:fallback');expect(events.at(-1)).toEqual({kind:'turnEnd',stopReason:'endTurn'});
    expect(f.inbox.get(f.sid,'fallback')?.state).toBe('delivered');
  });

});
