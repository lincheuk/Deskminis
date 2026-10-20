import {afterAll,describe,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {MIGRATIONS,runMigrations} from '../src/minisd/store/db';
import {InputQueueStore} from '../src/minisd/store/input-queue';
import {ledgerEnv} from './run-recovery-fixture';
const dbs:Database.Database[]=[];
afterAll(()=>dbs.forEach(db=>{try{db.close();}catch{}}));
function env(){const e=ledgerEnv('c4-store');dbs.push(e.db);const sid=e.newSession(),q=new InputQueueStore(e.db,{isSessionDeleted:()=>false,now:()=>100});
 const send=(id:string,extra:object={})=>q.send({sessionId:sid,messageId:id,mode:'queue',text:id,...extra}).input;
 const raw=(id:string)=>e.db.prepare('SELECT * FROM session_inputs WHERE input_id=?').get(id) as any;
 return {...e,sid,q,send,raw};}
describe('C4 durable queue operations',()=>{
 it('C4S1 hold is idempotent, rejects starting and steer without modifying them',()=>{
  const e=env();e.send('a');e.send('b');e.send('s',{mode:'steer',runId:'R'});
  const held=e.q.hold(e.sid,'b');expect(held).toMatchObject({state:'held',reason:'正在编辑'});expect(e.q.hold(e.sid,'b')).toEqual(held);
  const claim=e.q.claimQueue(e.sid)!;expect(claim.input.messageId).toBe('a');const a=e.raw('a'),s=e.raw('s');
  expect(()=>e.q.hold(e.sid,'a')).toThrow('这条已开始发送，不能再改');expect(e.raw('a')).toEqual(a);
  expect(()=>e.q.hold(e.sid,'s')).toThrow(/排队/);expect(e.raw('s')).toEqual(s);
 });
 it('C4S2 editing updates request, digest and timestamp, preserving attachment and model preferences',()=>{
  const e=env();e.send('a',{attachments:['attachments/a.png'],providerId:'P',modelGroupId:'G',thinkingLevel:'max',maxOutputTokens:42});const held=e.q.hold(e.sid,'a'),old=e.raw('a');
  const edited=e.q.edit(e.sid,'a','new body',held.updatedAt,false);expect(edited.state).toBe('held');expect(edited.updatedAt).toBeGreaterThan(held.updatedAt);
  expect(e.raw('a').digest).not.toBe(old.digest);expect(e.raw('a').text).toBe('new body');expect(JSON.parse(e.raw('a').request_json)).toMatchObject({text:'new body',attachments:['attachments/a.png'],providerId:'P',modelGroupId:'G',thinkingLevel:'max',maxOutputTokens:42});
  e.q.resume(e.sid,'a');const c=e.q.claimQueue(e.sid)!;expect(c.request).toMatchObject({text:'new body',attachments:['attachments/a.png'],providerId:'P',modelGroupId:'G',thinkingLevel:'max',maxOutputTokens:42});
  e.q.failClaim(c,'paused again');e.q.resume(e.sid,'a');expect(e.q.claimQueue(e.sid)!.request.text).toBe('new body');
 });
 it('C4S3 stale version and invalid text leave all columns unchanged; empty attachment message is allowed',()=>{
  const e=env();e.send('a');const h=e.q.hold(e.sid,'a'),before=e.raw('a');
  expect(()=>e.q.edit(e.sid,'a','stale',h.updatedAt-1,true)).toThrow('这条已在别处改过，请重新打开编辑');
  for(const text of ['','  ','x'.repeat(128*1024+1)])expect(()=>e.q.edit(e.sid,'a',text,h.updatedAt,true)).toThrow();
  expect(()=>e.q.edit(e.sid,'a','good',h.updatedAt,1 as any)).toThrow(/布尔/);expect(e.raw('a')).toEqual(before);
  const changed=e.q.edit(e.sid,'a','new',h.updatedAt,true);expect(changed).toMatchObject({state:'pending',text:'new'});expect(changed.reason).toBeUndefined();
  expect(()=>e.q.edit(e.sid,'a','again',changed.updatedAt,false)).toThrow(/暂停/);
  e.send('pic',{attachments:['a.png']});const p=e.q.hold(e.sid,'pic');expect(e.q.edit(e.sid,'pic','',p.updatedAt,false).text).toBe('');
 });
 it('C4S4 moving uses persisted movable slots, never seq or starting slot; claim follows position',()=>{
  const e=env();for(const id of ['start','a','b','c'])e.send(id);const start=e.q.claimQueue(e.sid)!,fixed=e.raw('start'),identities=e.q.list(e.sid).map(i=>[i.messageId,i.seq]);
  expect(()=>e.q.move(e.sid,'b','start')).toThrow(/不能移到/);expect(()=>e.q.move(e.sid,'start','a')).toThrow(/只能移动/);
  expect(()=>e.q.move(e.sid,'c','a')).not.toThrow();expect(e.q.list(e.sid).map(i=>i.messageId)).toEqual(['start','c','a','b']);expect(e.raw('start')).toEqual(fixed);
  expect(e.q.list(e.sid).map(i=>[i.messageId,i.seq]).sort()).toEqual(identities.sort());expect(e.q.claimQueue(e.sid)).toBeUndefined();
  e.q.failClaim(start,'done');e.q.cancel(e.sid,'start');expect(e.q.claimQueue(e.sid)!.input.messageId).toBe('c');
 });
 it('C4S5 reorder skips steer and consumed rows and is unchanged after reopening/recovery',()=>{
  const e=env();e.send('a');e.send('s',{mode:'steer',runId:'R'});e.send('b');e.send('c');e.q.cancel(e.sid,'c');
  const steer=e.raw('s'),cancelled=e.raw('c');e.q.move(e.sid,'a',null);expect(e.q.list(e.sid).map(i=>i.messageId)).toEqual(['b','s','a','c']);
  expect(e.raw('s')).toEqual(steer);expect(e.raw('c')).toEqual(cancelled);
  for(const id of ['s','c']){expect(()=>e.q.move(e.sid,id,null)).toThrow();expect(()=>e.q.move(e.sid,'a',id)).toThrow();}
  const reopened=new InputQueueStore(e.db,{isSessionDeleted:()=>false});reopened.recover();expect(reopened.list(e.sid).map(i=>i.messageId)).toEqual(['b','s','a','c']);expect(reopened.claimQueue(e.sid)).toBeUndefined();
  const same=reopened.get(e.sid,'a');expect(reopened.move(e.sid,'a','a')).toEqual(same);
 });
 it('C4S9 consecutive moves reuse effective slots, never original seq ranks',()=>{
  const e=env();for(const id of ['a','b','c'])e.send(id);
  expect(()=>e.q.move(e.sid,'c','a')).not.toThrow();expect(e.q.list(e.sid).map(i=>i.messageId)).toEqual(['c','a','b']);
  expect(()=>e.q.move(e.sid,'a',null)).not.toThrow();expect(e.q.list(e.sid).map(i=>i.messageId)).toEqual(['c','b','a']);
  expect(e.q.claimQueue(e.sid)!.request.text).toBe('c');
 });
 it('C4S6 steer preserves request identity, rejects pictures and consumed rows, finishes held then resumes queue',()=>{
  const e=env();e.send('a');e.send('pic',{attachments:['a.png']});e.send('cancelled');e.q.cancel(e.sid,'cancelled');const before=e.raw('a'),picture=e.raw('pic');
  expect(()=>e.q.steer(e.sid,'pic','R')).toThrow(/附件/);expect(e.raw('pic')).toEqual(picture);expect(()=>e.q.steer(e.sid,'cancelled','R')).toThrow();
  const changed=e.q.steer(e.sid,'a','R');expect(changed).toMatchObject({mode:'steer',state:'pending',runId:'R'});expect(e.raw('a').request_json).toBe(before.request_json);expect(e.raw('a').digest).toBe(before.digest);
  expect(()=>e.q.steer(e.sid,'a','R')).toThrow();e.q.finish(e.sid,'R',true,'ended');expect(e.q.get(e.sid,'a')!.state).toBe('held');e.q.resume(e.sid,'a');expect(e.q.claimQueue(e.sid)!.request.text).toBe('a');
 });
 it('C4S7 transaction rollback covers every moved slot and edited column',()=>{
  const e=env();e.send('a');e.send('b');const h=e.q.hold(e.sid,'a'),before=e.q.list(e.sid);
  e.db.exec("CREATE TRIGGER c4_fail BEFORE UPDATE ON session_inputs WHEN NEW.input_id='a' BEGIN SELECT RAISE(ABORT,'injected'); END");
  expect(()=>e.q.move(e.sid,'b','a')).toThrow('injected');expect(e.q.list(e.sid)).toEqual(before);expect(()=>e.q.edit(e.sid,'a','new',h.updatedAt,true)).toThrow('injected');expect(e.q.list(e.sid)).toEqual(before);
 });
 it('C4S8 version 17 queue migration preserves rows and legacy inserts stay after reordered rows',()=>{
  const db=new Database(':memory:');dbs.push(db);runMigrations(db,MIGRATIONS.slice(0,18));
  db.prepare("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('s','s',1,1)").run();
  const insert=db.prepare("INSERT INTO session_inputs(session_id,input_id,mode,text,attachments_json,request_json,digest,state,created_at,updated_at) VALUES('s',?,'queue',?,'[]',?,'digest','pending',1,1)");
  const put=(id:string)=>insert.run(id,id,JSON.stringify({sessionId:'s',messageId:id,mode:'queue',text:id}));put('a');put('b');
  runMigrations(db);expect(db.pragma('user_version',{simple:true})).toBe(19);const q=new InputQueueStore(db,{isSessionDeleted:()=>false});expect(q.list('s').map(i=>i.messageId)).toEqual(['a','b']);q.move('s','b','a');put('legacy');expect(q.list('s').map(i=>i.messageId)).toEqual(['b','a','legacy']);expect(q.claimQueue('s')!.input.messageId).toBe('b');
 });
});
