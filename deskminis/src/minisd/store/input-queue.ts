import type Database from 'better-sqlite3';
import {createHash, randomUUID} from 'node:crypto';
import {INPUT_ID_RE, INPUT_TEXT_MAX, INPUTS_OPEN_MAX, type InputSend, type InputResult, type InputView, type InputState} from '../../shared/inputs';

interface Row {
  position: number | null; seq: number; session_id: string; input_id: string; mode: string; text: string;
  attachments_json: string; request_json: string; digest: string; state: string;
  run_id: string | null; history_message_id: string | null; claim: string | null;
  reason: string | null; created_at: number; updated_at: number; delivered_at: number | null;
}
export interface QueueClaim {seq: number; token: string; request: InputSend; input: InputView}
const UNCONSUMED = "('pending','starting','held')";
function view(r: Row): InputView {
  return {seq:r.seq, position:r.position??r.seq, sessionId:r.session_id, messageId:r.input_id, mode:r.mode as InputView['mode'],
    text:r.text, attachments:JSON.parse(r.attachments_json), state:r.state as InputState,
    ...(r.run_id!==null?{runId:r.run_id}:{}), ...(r.history_message_id!==null?{historyMessageId:r.history_message_id}:{}),
    ...(r.reason!==null?{reason:r.reason}:{}), createdAt:r.created_at, updatedAt:r.updated_at,
    ...(r.delivered_at!==null?{deliveredAt:r.delivered_at}:{})};
}
/** Public input normalization has no I/O; the RPC additionally checks attachment files. */
export function normalizeInput(p: InputSend): InputSend {
  if (!p || typeof p.sessionId!=='string' || typeof p.messageId!=='string' || !INPUT_ID_RE.test(p.messageId)) throw Error('非法输入 messageId');
  if (p.mode!=='steer' && p.mode!=='queue') throw Error('非法输入 mode');
  if (typeof p.text!=='string' || p.text.length>INPUT_TEXT_MAX) throw Error('输入正文不能超过128Ki字符');
  if (p.attachments!==undefined && (!Array.isArray(p.attachments)||p.attachments.some(a=>typeof a!=='string'))) throw Error('非法附件列表');
  const attachments=[...(p.attachments??[])];
  if (!p.text.trim() && !attachments.length) throw Error('消息内容不能为空');
  if (p.mode==='steer' && attachments.length) throw Error('带附件的消息只能排队');
  if (p.mode==='steer' && (typeof p.runId!=='string'||!INPUT_ID_RE.test(p.runId))) throw Error('补充指示需要当前runId');
  if (p.mode==='queue' && p.runId!==undefined) throw Error('排队消息不绑定已有run');
  for (const k of ['providerId','modelGroupId'] as const) if (p[k]!==undefined && (typeof p[k]!=='string'||!p[k])) throw Error('非法模型选择');
  if (p.thinkingLevel!==undefined && !['off','low','medium','high','xhigh','max'].includes(p.thinkingLevel)) throw Error('非法推理档位');
  if (p.maxOutputTokens!==undefined && (!Number.isSafeInteger(p.maxOutputTokens)||p.maxOutputTokens<=0)) throw Error('maxOutputTokens 必须是正整数');
  return {sessionId:p.sessionId, messageId:p.messageId, mode:p.mode, text:p.text, attachments,
    ...(p.mode==='steer'?{runId:p.runId}:{}), ...(p.providerId!==undefined?{providerId:p.providerId}:{}),
    ...(p.modelGroupId!==undefined?{modelGroupId:p.modelGroupId}:{}), ...(p.thinkingLevel!==undefined?{thinkingLevel:p.thinkingLevel}:{}),
    ...(p.maxOutputTokens!==undefined?{maxOutputTokens:p.maxOutputTokens}:{})};
}

/** Single SQLite connection; every claim/admission is synchronous. No timers, tools or provider calls. */
export class InputQueueStore {
  private closed=false;
  private readonly now:()=>number;
  constructor(private readonly db:Database.Database, private readonly o:{isSessionDeleted:(s:string)=>boolean; now?:()=>number}) {
    const clock=o.now??(()=>Date.now()/1000);
    let last=(db.prepare('SELECT COALESCE(MAX(updated_at),0) n FROM session_inputs').get() as {n:number}).n;
    // Receipt/broadcast ordering must remain strict even within one clock tick or after a clock adjustment.
    this.now=()=>last=Math.max(clock(),last+0.000001);
  }
  private writable(s:string):void {if(this.closed)throw Error('输入队列已关闭');if(this.o.isSessionDeleted(s))throw Error('会话已删除');}
  private row(s:string,id:string):Row|undefined {return this.db.prepare('SELECT * FROM session_inputs WHERE session_id=? AND input_id=?').get(s,id) as Row|undefined;}
  private bySeq(seq:number):Row {const r=this.db.prepare('SELECT * FROM session_inputs WHERE seq=?').get(seq) as Row|undefined;if(!r)throw Error('输入已不存在');return r;}
  get(s:string,id:string):InputView|undefined {if(this.closed||this.o.isSessionDeleted(s))return undefined;const r=this.row(s,id);return r&&view(r);}
  list(s?:string):InputView[] {
    if(this.closed)return [];
    const args=s===undefined?[]:[s];
    const where=s===undefined?'':'WHERE session_id=?';
    const rows=this.db.prepare(`SELECT * FROM session_inputs ${where} ORDER BY COALESCE(position,seq),seq`).all(...args) as Row[];
    const terminal=new Map<string,Row[]>();
    for(const r of rows)if(!['pending','starting','held','admitted'].includes(r.state)){
      const group=terminal.get(r.session_id)??[];group.push(r);terminal.set(r.session_id,group);
    }
    const keep=new Set([...terminal.values()].flatMap(group=>group.slice(-100).map(r=>r.seq)));
    return rows.filter(r=>(['pending','starting','held','admitted'].includes(r.state)||keep.has(r.seq))&&!this.o.isSessionDeleted(r.session_id)).map(view);
  }
  hasUnconsumed(s:string):boolean {if(this.closed||this.o.isSessionDeleted(s))return false;return !!this.db.prepare(`SELECT 1 FROM session_inputs WHERE session_id=? AND state IN ${UNCONSUMED} LIMIT 1`).get(s);}
  send(raw:InputSend):InputResult {
    const p=normalizeInput(raw);this.writable(p.sessionId);
    const request=JSON.stringify(p),digest=createHash('sha256').update(request).digest('hex');
    return this.db.transaction(()=>{
      const old=this.row(p.sessionId,p.messageId);
      if(old){if(old.digest!==digest)throw Error('messageId 已用于另一条输入，这一条没有发送');return {input:view(old),duplicate:true};}
      const count=this.db.prepare(`SELECT COUNT(*) n FROM session_inputs WHERE session_id=? AND state IN ${UNCONSUMED}`).get(p.sessionId) as {n:number};
      if(count.n>=INPUTS_OPEN_MAX)throw Error('待发送输入不能超过20条');
      const now=this.now();
      this.db.prepare(`INSERT INTO session_inputs(session_id,input_id,mode,text,attachments_json,request_json,digest,state,run_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).run(p.sessionId,p.messageId,p.mode,p.text,JSON.stringify(p.attachments),request,digest,p.runId??null,now,now);
      return {input:view(this.row(p.sessionId,p.messageId)!),duplicate:false};
    })();
  }
  claimQueue(s:string):QueueClaim|undefined {
    this.writable(s);
    return this.db.transaction(()=>{
      const first=this.db.prepare(`SELECT * FROM session_inputs WHERE session_id=? AND state IN ${UNCONSUMED} ORDER BY COALESCE(position,seq),seq LIMIT 1`).get(s) as Row|undefined;
      if(!first||first.state!=='pending'||first.mode!=='queue')return undefined;
      const token=randomUUID();
      const changed=this.db.prepare("UPDATE session_inputs SET state='starting',claim=?,updated_at=? WHERE seq=? AND state='pending'").run(token,this.now(),first.seq);
      if(changed.changes!==1)return undefined;
      const r=this.bySeq(first.seq);
      const request=JSON.parse(r.request_json) as InputSend;
      // Resumed old steer preserves its identity digest, but launches as a fresh queued run.
      delete request.runId;request.mode='queue';
      return {seq:r.seq,token,request,input:view(r)};
    })();
  }
  assertClaim(c:QueueClaim):void {
    this.writable(c.input.sessionId);const r=this.bySeq(c.seq);
    if(r.state!=='starting'||r.claim!==c.token)throw Error('输入起跑已失效');
  }
  bind(c:QueueClaim,runId:string):void {
    this.assertClaim(c);
    if(this.db.prepare("UPDATE session_inputs SET run_id=?,updated_at=? WHERE seq=? AND claim=? AND state='starting'").run(runId,this.now(),c.seq,c.token).changes!==1)throw Error('输入起跑已失效');
  }
  /** Called inside RunHandle.started's existing transaction, after append. */
  admittedQueue(c:QueueClaim,runId:string,historyId:string):void {
    this.writable(c.input.sessionId);
    if(this.db.prepare("UPDATE session_inputs SET state='admitted',history_message_id=?,claim=NULL,updated_at=? WHERE seq=? AND claim=? AND state='starting' AND run_id=?").run(historyId,this.now(),c.seq,c.token,runId).changes!==1)throw Error('输入起跑已失效');
  }
  failClaim(c:QueueClaim,reason:string):void {
    if(this.closed||this.o.isSessionDeleted(c.input.sessionId))return;
    this.db.prepare("UPDATE session_inputs SET state='held',claim=NULL,reason=?,updated_at=? WHERE seq=? AND claim=? AND state='starting'").run(reason,this.now(),c.seq,c.token);
  }
  /** Atomic append + admission; batch limits preserve F03's three verbatim user turns. */
  admitSteers(s:string,runId:string,append:(input:InputView)=>{id:string}):InputView[] {
    this.writable(s);
    return this.db.transaction(()=>{
      const unconfirmed=this.db.prepare("SELECT * FROM session_inputs WHERE session_id=? AND run_id=? AND state='admitted'").all(s,runId) as Row[];
      if(unconfirmed.some(r=>JSON.parse(r.attachments_json).length))return [];
      const max=Math.min(2,3-unconfirmed.length);if(max<=0)return [];
      const rows=this.db.prepare("SELECT * FROM session_inputs WHERE session_id=? AND mode='steer' AND run_id=? AND state='pending' ORDER BY seq LIMIT ?").all(s,runId,max) as Row[];
      return rows.map(r=>{
        const m=append(view(r));
        if(this.db.prepare("UPDATE session_inputs SET state='admitted',history_message_id=?,updated_at=? WHERE seq=? AND state='pending' AND run_id=?").run(m.id,this.now(),r.seq,runId).changes!==1)throw Error('输入投递已失效');
        return view(this.bySeq(r.seq));
      });
    })();
  }
  pendingSteers(s:string,runId:string):boolean {if(this.closed||this.o.isSessionDeleted(s))return false;return !!this.db.prepare("SELECT 1 FROM session_inputs WHERE session_id=? AND mode='steer' AND run_id=? AND state='pending' LIMIT 1").get(s,runId);}
  unconfirmed(s:string):InputView[] {if(this.closed||this.o.isSessionDeleted(s))return [];return (this.db.prepare("SELECT * FROM session_inputs WHERE session_id=? AND state='admitted' ORDER BY seq").all(s) as Row[]).map(view);}
  delivered(s:string,historyIds:ReadonlySet<string>):number {
    if(this.closed||this.o.isSessionDeleted(s))return 0;
    return this.db.transaction(()=>{
      let n=0;const now=this.now();
      for(const r of this.unconfirmed(s))if(r.historyMessageId&&historyIds.has(r.historyMessageId))n+=this.db.prepare("UPDATE session_inputs SET state='delivered',delivered_at=?,updated_at=? WHERE seq=? AND state='admitted'").run(now,now,r.seq).changes;
      return n;
    })();
  }
  cancel(s:string,id:string):InputView {
    this.writable(s);const r=this.row(s,id);if(!r)throw Error('输入不存在');
    if(r.state==='cancelled')return view(r);
    if(!['pending','held'].includes(r.state))throw Error('输入已开始投递，请停止对应run');
    this.db.prepare("UPDATE session_inputs SET state='cancelled',reason='用户取消',claim=NULL,updated_at=? WHERE seq=? AND state IN ('pending','held')").run(this.now(),r.seq);
    return view(this.bySeq(r.seq));
  }
  resume(s:string,id:string):InputView {
    this.writable(s);const r=this.row(s,id);if(!r)throw Error('输入不存在');
    if(r.state==='pending'&&r.mode==='queue')return view(r);
    if(r.state!=='held')throw Error('只有暂停的输入可以继续');
    this.db.prepare("UPDATE session_inputs SET state='pending',mode='queue',run_id=NULL,reason=NULL,claim=NULL,updated_at=? WHERE seq=? AND state='held'").run(this.now(),r.seq);
    return view(this.bySeq(r.seq));
  }
  hold(s:string,id:string):InputView {
    this.writable(s);
    return this.db.transaction(()=>{
      const r=this.row(s,id);if(!r)throw Error('输入不存在');
      if(r.mode!=='queue')throw Error('只能编辑排队消息');
      if(r.state==='held')return view(r);
      if(r.state!=='pending')throw Error('这条已开始发送，不能再改');
      if(this.db.prepare("UPDATE session_inputs SET state='held',reason='正在编辑',updated_at=? WHERE seq=? AND mode='queue' AND state='pending'").run(this.now(),r.seq).changes!==1)throw Error('这条已开始发送，不能再改');
      return view(this.bySeq(r.seq));
    })();
  }
  edit(s:string,id:string,text:string,updatedAt:number,resume:boolean):InputView {
    this.writable(s);
    return this.db.transaction(()=>{
      const r=this.row(s,id);if(!r)throw Error('输入不存在');
      if(r.mode!=='queue'||r.state!=='held')throw Error('只能编辑暂停的排队消息');
      if(r.updated_at!==updatedAt)throw Error('这条已在别处改过，请重新打开编辑');
      if(typeof resume!=='boolean')throw Error('resume 必须是布尔值');
      const request=JSON.parse(r.request_json) as InputSend;
      // A resumed steer still has its original request identity; normalize its current queue mode.
      delete request.runId;
      const p=normalizeInput({...request,mode:'queue',text});
      const json=JSON.stringify(p),digest=createHash('sha256').update(json).digest('hex');
      if(this.db.prepare("UPDATE session_inputs SET text=?,request_json=?,digest=?,state=?,reason=?,updated_at=? WHERE seq=? AND mode='queue' AND state='held' AND updated_at=?").run(p.text,json,digest,resume?'pending':'held',resume?null:r.reason,this.now(),r.seq,updatedAt).changes!==1)throw Error('这条已在别处改过，请重新打开编辑');
      return view(this.bySeq(r.seq));
    })();
  }
  move(s:string,id:string,beforeMessageId:string|null):InputView {
    this.writable(s);
    return this.db.transaction(()=>{
      const r=this.row(s,id);if(!r)throw Error('输入不存在');
      if(r.mode!=='queue'||!['pending','held'].includes(r.state))throw Error('只能移动等待中的排队消息');
      if(beforeMessageId!==null&&typeof beforeMessageId!=='string')throw Error('非法插入位置');
      const rows=this.db.prepare("SELECT * FROM session_inputs WHERE session_id=? AND mode='queue' AND state IN ('pending','held') ORDER BY COALESCE(position,seq),seq").all(s) as Row[];
      if(beforeMessageId!==null&&!rows.some(i=>i.input_id===beforeMessageId))throw Error('只能放到等待中的排队消息之间，不能移到正在发送的消息前面');
      if(beforeMessageId===id)return view(r);
      // Reuse movable slots only. starting, steer and consumed rows retain both identity and position.
      const slots=rows.map(i=>i.position??i.seq),ordered=rows.filter(i=>i.input_id!==id);
      ordered.splice(beforeMessageId===null?ordered.length:ordered.findIndex(i=>i.input_id===beforeMessageId),0,r);
      const update=this.db.prepare("UPDATE session_inputs SET position=?,updated_at=? WHERE seq=? AND mode='queue' AND state IN ('pending','held')");
      ordered.forEach((i,n)=>{if(update.run(slots[n],this.now(),i.seq).changes!==1)throw Error('输入已开始投递');});
      return view(this.bySeq(r.seq));
    })();
  }
  steer(s:string,id:string,runId:string):InputView {
    this.writable(s);
    return this.db.transaction(()=>{
      const r=this.row(s,id);if(!r)throw Error('输入不存在');
      if(r.mode!=='queue'||!['pending','held'].includes(r.state))throw Error('只能发送等待中的排队消息');
      if(JSON.parse(r.attachments_json).length)throw Error('带附件的消息只能排队');
      if(this.db.prepare("UPDATE session_inputs SET mode='steer',run_id=?,state='pending',reason=NULL,updated_at=? WHERE seq=? AND mode='queue' AND state IN ('pending','held')").run(runId,this.now(),r.seq).changes!==1)throw Error('输入已开始投递');
      return view(this.bySeq(r.seq));
    })();
  }
  /** Success retains queued input; unconsumed steer always becomes held. */
  finish(s:string,runId:string,successful:boolean,reason:string):number {
    if(this.closed||this.o.isSessionDeleted(s))return 0;
    return this.db.prepare(`UPDATE session_inputs SET state='held',claim=NULL,reason=?,updated_at=? WHERE session_id=? AND state IN ('pending','starting') AND ${successful?"(mode='steer' AND run_id=?)":"(mode='queue' OR run_id=?)"}`).run(reason,this.now(),s,runId).changes;
  }
  holdSession(s:string,reason:string):void {if(this.closed)return;this.db.prepare("UPDATE session_inputs SET state='held',claim=NULL,reason=?,updated_at=? WHERE session_id=? AND state IN ('pending','starting')").run(reason,this.now(),s);}
  recover():number {if(this.closed)throw Error('输入队列已关闭');return this.db.prepare("UPDATE session_inputs SET state='held',claim=NULL,reason='引擎重启，未自动补发',updated_at=? WHERE state IN ('pending','starting')").run(this.now()).changes;}
  close():void {this.closed=true;}
}
