import {afterAll, describe, expect, it} from 'vitest';
import type Database from 'better-sqlite3';
import {openDb} from '../src/minisd/store/db';
import {InputQueueStore} from '../src/minisd/store/input-queue';
import {ledgerEnv, type LedgerEnv} from './run-recovery-fixture';

const databases:Database.Database[]=[];
afterAll(()=>databases.forEach(db=>{try{db.close();}catch{}}));
function env(label:string) {
  const e=ledgerEnv('f07-'+label);databases.push(e.db);const sid=e.newSession();
  const hidden=new Set<string>();let clock=100;
  const inbox=new InputQueueStore(e.db,{isSessionDeleted:s=>hidden.has(s)||e.store.isDeleted(s),now:()=>++clock});
  const send=(id:string,text=id,mode:'queue'|'steer'='queue',extra:Record<string,unknown>={})=>inbox.send({sessionId:sid,messageId:id,mode,text,...(mode==='steer'?{runId:'R'}:{}),...extra});
  const append=(i:{text:string})=>e.store.appendMessage({id:e.store.newId(),sessionId:sid,role:'user',parts:[{type:'text',value:i.text}],createdAt:++clock,streamInterruptCount:0});
  return {...e,sid,hidden,inbox,send,append};
}
describe('F07 durable inbox',()=>{
  it('S1 same ID is durable identity including model preferences; cancellation does not resurrect',()=>{
    const e=env('identity');const a=e.send('a','same','queue',{thinkingLevel:'low'});
    expect(e.send('a','same','queue',{thinkingLevel:'low'})).toEqual({input:a.input,duplicate:true});
    expect(()=>e.send('a','different','queue',{thinkingLevel:'low'})).toThrow(/另一条/);
    expect(()=>e.send('a','same','queue',{thinkingLevel:'high'})).toThrow(/另一条/);
    e.inbox.cancel(e.sid,'a');expect(e.send('a','same','queue',{thinkingLevel:'low'}).input.state).toBe('cancelled');
    expect(e.db.prepare('SELECT COUNT(*) n FROM session_inputs').get()).toEqual({n:1});
    expect(e.store.listMessages(e.sid)).toEqual([]);
  });
  it('S2 cancellation wins before claim; starting is not silently cancelled as pending',()=>{
    const e=env('claim');e.send('a');e.send('b');e.inbox.cancel(e.sid,'a');
    const claim=e.inbox.claimQueue(e.sid)!;expect(claim.input.messageId).toBe('b');
    expect(e.inbox.claimQueue(e.sid)).toBeUndefined();
    expect(()=>e.inbox.cancel(e.sid,'b')).toThrow(/停止/);
    e.inbox.bind(claim,'R');expect(e.inbox.get(e.sid,'b')).toMatchObject({state:'starting',runId:'R'});
  });
  it('S3 held head blocks FIFO; old claim cannot modify explicitly resumed row',()=>{
    const e=env('held');e.send('a');e.send('b');const old=e.inbox.claimQueue(e.sid)!;
    e.inbox.failClaim(old,'start failed');expect(e.inbox.claimQueue(e.sid)).toBeUndefined();
    e.inbox.resume(e.sid,'a');const next=e.inbox.claimQueue(e.sid)!;
    expect(next.input.messageId).toBe('a');expect(next.token).not.toBe(old.token);
    expect(()=>e.inbox.assertClaim(old)).toThrow(/失效/);expect(()=>e.inbox.bind(old,'old-run')).toThrow(/失效/);
    e.inbox.failClaim(old,'late failure');expect(e.inbox.get(e.sid,'a')).toMatchObject({state:'starting'});
    expect(e.inbox.get(e.sid,'a')!.reason).toBeUndefined();
  });
  it('S4 steer history/admission rollback together when update fails; retry leaves one history row',()=>{
    const e=env('atomic-steer');e.send('a','first','steer');e.send('b','second','steer');
    e.db.exec("CREATE TRIGGER f07_fail BEFORE UPDATE OF state ON session_inputs WHEN NEW.input_id='b' AND NEW.state='admitted' BEGIN SELECT RAISE(ABORT,'injected admission failure'); END");
    expect(()=>e.inbox.admitSteers(e.sid,'R',e.append)).toThrow(/injected/);
    expect(e.store.listMessages(e.sid)).toEqual([]);expect(e.inbox.list(e.sid).map(r=>r.state)).toEqual(['pending','pending']);
    e.db.exec('DROP TRIGGER f07_fail');
    expect(e.inbox.admitSteers(e.sid,'R',e.append).map(r=>r.messageId)).toEqual(['a','b']);
    expect(e.inbox.admitSteers(e.sid,'R',e.append)).toEqual([]);
    expect(e.store.listMessages(e.sid).map(r=>r.parts[0].value)).toEqual(['first','second']);
  });
  it('S5 queue admission joins RunHandle.started transaction; lost claim rolls back user and running state',()=>{
    const e=env('atomic-queue');e.send('a');const claim=e.inbox.claimQueue(e.sid)!;
    const run=e.ledger.beginRun({sessionId:e.sid,origin:{kind:'user'}});e.inbox.bind(claim,run.ref.runId);
    e.inbox.holdSession(e.sid,'deleted or stopped');
    expect(()=>run.started(()=>{const m=e.append(claim.input);e.inbox.admittedQueue(claim,run.ref.runId,m.id);return m;})).toThrow(/失效/);
    expect(e.store.listMessages(e.sid)).toEqual([]);
    expect(e.ledger.snapshot({sessionId:e.sid}).runs[0].state).toBe('starting');
    run.end({state:'cancelled',reason:'test'});
  });
  it('S6 restart holds pending and starting; already admitted is retained without appending it again',()=>{
    const e=env('restart');e.send('a');const c=e.inbox.claimQueue(e.sid)!;e.inbox.bind(c,'R');
    e.send('steer','admitted','steer');e.inbox.admitSteers(e.sid,'R',e.append);e.send('b');
    const db=openDb(e.snapshot());databases.push(db);
    const next=new InputQueueStore(db,{isSessionDeleted:()=>false});expect(next.recover()).toBe(2);
    expect(next.list(e.sid).map(r=>[r.messageId,r.state])).toEqual([['a','held'],['steer','admitted'],['b','held']]);
    expect(next.claimQueue(e.sid)).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) n FROM messages WHERE session_id=?').get(e.sid) as {n:number}).n).toBe(1);
  });
  it('S7 unconfirmed media blocks steer; total admission is bounded to three original user turns',()=>{
    const e=env('bounded');e.send('image','image','queue',{attachments:['attachments/one.png']});
    const c=e.inbox.claimQueue(e.sid)!;e.inbox.bind(c,'R');
    const image=e.append(c.input);e.inbox.admittedQueue(c,'R',image.id);
    for(let i=1;i<=4;i++)e.send('s'+i,'s'+i,'steer');
    expect(e.inbox.admitSteers(e.sid,'R',e.append)).toEqual([]);
    e.inbox.delivered(e.sid,new Set([image.id]));
    expect(e.inbox.admitSteers(e.sid,'R',e.append).map(r=>r.messageId)).toEqual(['s1','s2']);
    expect(e.inbox.admitSteers(e.sid,'R',e.append).map(r=>r.messageId)).toEqual(['s3']);
    expect(e.inbox.admitSteers(e.sid,'R',e.append)).toEqual([]);
    expect(e.inbox.get(e.sid,'s4')!.state).toBe('pending');
  });
  it('S8 hidden copy rejects late writes/receipts; restoration retains held facts',()=>{
    const e=env('hidden');e.send('a');e.inbox.holdSession(e.sid,'会话已删除');e.hidden.add(e.sid);
    expect(e.inbox.list()).toEqual([]);expect(e.inbox.get(e.sid,'a')).toBeUndefined();
    expect(()=>e.send('late')).toThrow(/会话已删除/);expect(()=>e.inbox.resume(e.sid,'a')).toThrow(/会话已删除/);
    expect(e.inbox.delivered(e.sid,new Set(['anything']))).toBe(0);
    e.hidden.delete(e.sid);expect(e.inbox.get(e.sid,'a')!.state).toBe('held');
  });
  it('S9 stopping or failure holds unconsumed queue; success holds stale steer but preserves queue order',()=>{
    const e=env('finish');e.send('s','steer','steer');e.send('a');e.send('b');
    e.inbox.finish(e.sid,'R',true,'run ended');expect(e.inbox.list(e.sid).map(r=>r.state)).toEqual(['held','pending','pending']);
    expect(e.inbox.claimQueue(e.sid)).toBeUndefined();e.inbox.cancel(e.sid,'s');
    const c=e.inbox.claimQueue(e.sid)!;e.inbox.bind(c,'Q');e.inbox.finish(e.sid,'Q',false,'cancelled');
    expect(e.inbox.list(e.sid).map(r=>r.state)).toEqual(['cancelled','held','held']);
  });
  it('S10 bounded outstanding queue returns drafts by rejecting overflow; no silent truncation',()=>{
    const e=env('limit');for(let i=0;i<20;i++)e.send('i'+i);
    expect(()=>e.send('overflow')).toThrow(/20/);expect(e.inbox.list(e.sid)).toHaveLength(20);
    e.inbox.cancel(e.sid,'i0');expect(e.send('replacement').duplicate).toBe(false);
    expect(()=>e.send('huge','x'.repeat(128*1024+1))).toThrow(/128/);
  });
  it('S11 receipt only changes history IDs explicitly proven; close makes late observers no-op',()=>{
    const e=env('receipt');e.send('a','a','steer');e.send('b','b','steer');const rows=e.inbox.admitSteers(e.sid,'R',e.append);
    expect(e.inbox.delivered(e.sid,new Set(['a']))).toBe(0);
    expect(e.inbox.delivered(e.sid,new Set([rows[0].historyMessageId!]))).toBe(1);
    expect(e.inbox.get(e.sid,'b')!.state).toBe('admitted');e.inbox.close();e.db.close();
    expect(e.inbox.delivered(e.sid,new Set([rows[1].historyMessageId!]))).toBe(0);expect(e.inbox.list()).toEqual([]);
  });
  it('S12 update timestamps remain strict through same-tick transitions and restart with a backwards clock',()=>{
    const e=env('clock');const inbox=new InputQueueStore(e.db,{isSessionDeleted:s=>e.store.isDeleted(s),now:()=>1});
    const a=inbox.send({sessionId:e.sid,messageId:'clock',mode:'queue',text:'clock'}).input;
    const b=inbox.cancel(e.sid,'clock');expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
    const restart=new InputQueueStore(e.db,{isSessionDeleted:s=>e.store.isDeleted(s),now:()=>0});
    const c=restart.send({sessionId:e.sid,messageId:'later',mode:'queue',text:'later'}).input;expect(c.updatedAt).toBeGreaterThan(b.updatedAt);
  });
  it('S13 unconfirmed history receipt remains visible after more than a hundred terminal queue rows',()=>{
    const e=env('unconfirmed-list');e.send('old','unconfirmed','steer');e.inbox.admitSteers(e.sid,'R',e.append);
    for(let n=0;n<120;n++){e.send('cancel-'+n);e.inbox.cancel(e.sid,'cancel-'+n);}
    const visible=e.inbox.list(e.sid);expect(visible).toHaveLength(101);expect(visible[0]).toMatchObject({messageId:'old',state:'admitted',text:'unconfirmed'});
    expect(e.inbox.get(e.sid,'cancel-0')?.state).toBe('cancelled');expect(e.send('cancel-0').duplicate).toBe(true);
  });

});
