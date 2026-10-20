import type {ChatStore} from './store/chat-store';
import type {RunLedger} from './store/run-ledger';
import {InputQueueStore, normalizeInput, type QueueClaim} from './store/input-queue';
import type {InputSend, RunStopSummary} from '../shared/inputs';

/** The same admission/claim path is used by local and authenticated remote clients. */
export function createInputController(o:{
  inbox:InputQueueStore;chat:ChatStore;ledger:RunLedger;
  sessionId:(id:unknown)=>string;closing:()=>boolean;busy:(s:string)=>boolean;
  validateAttachments:(p:InputSend)=>void;
  launch:(p:InputSend,claim:QueueClaim)=>Promise<unknown>;
  broadcast:(method:string,params:unknown)=>void;
}){
  const visible=(s:unknown):string=>{
    const id=o.sessionId(s);if(o.closing())throw Error('引擎正在关闭');
    if(o.chat.isDeleted(id))throw Error('会话已删除');if(!o.chat.getSession(id))throw Error('会话不存在');return id;
  };
  const active=(s:string)=>o.ledger.snapshot({sessionId:s}).runs.find(r=>r.sessionId===s&&(r.state==='starting'||r.state==='running'));
  const changed=(s:string):void=>{
    if(o.closing()||o.chat.isDeleted(s))return;
    try{o.broadcast('chat.inputs.changed',{sessionId:s,inputs:o.inbox.list(s)});}catch{console.warn('输入状态广播失败，可通过快照重新核对');}
  };
  const kick=(s:string):void=>{
    if(o.closing()||o.busy(s)||o.chat.isDeleted(s)||!o.chat.getSession(s))return;
    let claim:QueueClaim|undefined;
    try{claim=o.inbox.claimQueue(s);}catch{console.warn('输入队列起跑失败，未自动重试');return;}if(!claim)return;
    // launch synchronously reserves the F05 run before its first await. No transaction wraps beginRun.
    const owned=claim;
    void o.launch(owned.request,owned).catch(e=>{o.inbox.failClaim(owned,String(e));changed(s);}).catch(()=>{console.warn('输入起跑失败的状态未写成，可通过重启恢复核对');});
    changed(s);
  };
  const hold=(s:string,reason:string):void=>{o.inbox.holdSession(s,reason);changed(s);};
  const stopSummary=(s:string,runId:string):RunStopSummary=>{
    const rows=o.ledger.listExecutions(runId);
    return {sessionId:s,runId,started:rows.filter(r=>r.started).length,notStarted:rows.filter(r=>!r.started).length,
      unknown:rows.filter(r=>r.state==='unknown').length,possibleSideEffects:rows.some(r=>r.started&&r.sideEffects!=='none')};
  };
  return {active,changed,kick,hold,stopSummary,methods:{
    'chat.input.send':(raw:InputSend)=>{
      const p=normalizeInput(raw),sid=visible(p.sessionId);
      // A repeated accepted ID retains its original result after the run ends. Store checks full digest.
      if(o.inbox.get(sid,p.messageId))return o.inbox.send(p);
      if(p.mode==='steer'){
        const run=active(sid);if(!run||run.runId!==p.runId||!o.busy(sid))throw Error('运行已结束或已更换，补充指示没有发送');
      }
      o.validateAttachments(p);
      const result=o.inbox.send(p);changed(sid);if(p.mode==='queue')kick(sid);
      return {...result,input:o.inbox.get(sid,p.messageId)??result.input};
    },
    'chat.input.list':(p:{sessionId:string})=>{const sid=visible(p.sessionId);return {sessionId:sid,inputs:o.inbox.list(sid)};},
    'chat.input.cancel':(p:{sessionId:string;messageId:string})=>{
      const sid=visible(p.sessionId),input=o.inbox.cancel(sid,p.messageId);changed(sid);kick(sid);return {input};
    },
    'chat.input.hold':(p:{sessionId:string;messageId:string})=>{
      const sid=visible(p.sessionId),input=o.inbox.hold(sid,p.messageId);changed(sid);return {input};
    },
    'chat.input.edit':(p:{sessionId:string;messageId:string;text:string;updatedAt:number;resume:boolean})=>{
      const sid=visible(p.sessionId),input=o.inbox.edit(sid,p.messageId,p.text,p.updatedAt,p.resume);changed(sid);if(p.resume)kick(sid);return {input:o.inbox.get(sid,p.messageId)??input};
    },
    'chat.input.move':(p:{sessionId:string;messageId:string;beforeMessageId:string|null})=>{
      const sid=visible(p.sessionId),input=o.inbox.move(sid,p.messageId,p.beforeMessageId);changed(sid);kick(sid);return {input:o.inbox.get(sid,p.messageId)??input};
    },
    'chat.input.steer':(p:{sessionId:string;messageId:string;runId:string})=>{
      const sid=visible(p.sessionId),run=active(sid);
      if(!run||run.runId!==p.runId||!o.busy(sid))throw Error('运行已结束或已更换，没有改成补充指示');
      const input=o.inbox.steer(sid,p.messageId,p.runId);changed(sid);return {input};
    },
    'chat.input.resume':(p:{sessionId:string;messageId:string})=>{
      const sid=visible(p.sessionId),input=o.inbox.resume(sid,p.messageId);changed(sid);kick(sid);return {input:o.inbox.get(sid,p.messageId)??input};
    },
  }};
}
