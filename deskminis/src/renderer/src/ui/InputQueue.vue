<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue';
import {useChat} from '../stores/chat';
import type {InputView} from '@shared/inputs';
const chat=useChat();
defineEmits<{restore:[index:number]}>();
const inputs=computed(()=>{
  const all=chat.inputsBySession[chat.activeId]??[];
  const unresolved=all.filter(i=>['pending','starting','held','admitted'].includes(i.state));
  const received=all.filter(i=>i.state==='delivered').slice(-3);
  return [...unresolved,...received].sort((a,b)=>(a.position??a.seq)-(b.position??b.seq)||a.seq-b.seq);
});
const uncertain=computed(()=>chat.inDoubtInputs.filter(i=>i.sessionId===chat.activeId));
const drafts=computed(()=>chat.failedInputDrafts[chat.activeId]??[]);
const stopped=computed(()=>chat.stopSummaries[chat.activeId]);
const movable=(i:InputView)=>i.mode==='queue'&&['pending','held'].includes(i.state);
const moving=computed(()=>inputs.value.filter(movable));
const runId=computed(()=>{const r=chat.runOf[chat.activeId];return r&&!r.ended?r.runId:'';});
const label=(i:InputView):string=>({pending:i.mode==='steer'?'等待下一次安全边界':'排队等待新一轮',starting:'正在准备新一轮',admitted:'已写入历史，模型接收尚未确认',delivered:'已交给完整模型请求',held:'已暂停，需自行继续',cancelled:'已取消'}[i.state]);
function time(i:InputView):string{return new Date(i.createdAt*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
const editing=ref<{sessionId:string;messageId:string;text:string;updatedAt:number;resume:boolean;attachments:number}|null>(null);
const errors=ref<Record<string,string>>({}),busy=ref(''),announcement=ref('');
const dragId=ref(''),dropAt=ref('');
const QUEUE_MIME='application/x-deskminis-queue-input';
watch(()=>chat.activeId,()=>{editing.value=null;errors.value={};announcement.value='';dragId.value='';dropAt.value='';});
async function operate(id:string,action:()=>Promise<unknown>):Promise<boolean>{
  if(busy.value)return false;
  const sid=chat.activeId;busy.value=id;delete errors.value[id];
  try{await action();return sid===chat.activeId;}
  catch(e){if(sid===chat.activeId)errors.value[id]=e instanceof Error?e.message:String(e);return false;}
  finally{busy.value='';}
}
async function beginEdit(i:InputView){
  if(editing.value)return;
  const sid=chat.activeId,resume=i.state==='pending';
  await operate(i.messageId,async()=>{
    const held=await chat.holdQueueInput(i.messageId,sid);
    if(chat.activeId===sid)editing.value={sessionId:sid,messageId:i.messageId,text:held.text,updatedAt:held.updatedAt,resume,attachments:held.attachments.length};
  });
}
async function saveEdit(){
  const e=editing.value;if(!e||(!e.text.trim()&&!e.attachments))return;
  if(await operate(e.messageId,()=>chat.editQueueInput(e.messageId,e.text,e.updatedAt,e.resume,e.sessionId)))editing.value=null;
}
async function cancelEdit(){
  const e=editing.value;if(!e)return;
  if(await operate(e.messageId,async()=>{if(e.resume)await chat.resumeQueueInput(e.messageId,e.sessionId);}))editing.value=null;
}
function editorKey(event:KeyboardEvent){
  if(event.isComposing||event.keyCode===229)return;
  if(event.key==='Escape'){event.preventDefault();void cancelEdit();}
  else if(event.key==='Enter'&&event.ctrlKey){event.preventDefault();void saveEdit();}
}
async function move(i:InputView,beforeMessageId:string|null,button?:HTMLButtonElement){
  const sid=chat.activeId;
  if(await operate(i.messageId,()=>chat.moveQueueInput(i.messageId,beforeMessageId,sid))){
    announcement.value='';await nextTick();
    announcement.value='已移到第 '+(moving.value.findIndex(r=>r.messageId===i.messageId)+1)+' 位';
    await nextTick();button?.focus();
  }
}
function step(i:InputView,delta:number,event:Event){
  const at=moving.value.findIndex(r=>r.messageId===i.messageId),next=at+delta;
  if(editing.value||busy.value||next<0||next>=moving.value.length)return;
  const before=delta<0?moving.value[next].messageId:moving.value[next+1]?.messageId??null;
  void move(i,before,event.currentTarget as HTMLButtonElement);
}
function dragStart(i:InputView,event:DragEvent){
  if(!movable(i)||editing.value||busy.value||!event.dataTransfer){event.preventDefault();return;}
  dragId.value=i.messageId;event.dataTransfer.setData(QUEUE_MIME,i.messageId);event.dataTransfer.effectAllowed='move';
}
function dragOver(i:InputView,event:DragEvent){
  if(!movable(i)||editing.value||!dragId.value||!event.dataTransfer?.types.includes(QUEUE_MIME))return;
  event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';
  const box=(event.currentTarget as HTMLElement).getBoundingClientRect();
  dropAt.value=event.clientY>box.top+box.height/2?(moving.value[moving.value.findIndex(r=>r.messageId===i.messageId)+1]?.messageId??'end'):i.messageId;
}
function drop(i:InputView,event:DragEvent){
  if(!movable(i)||!event.dataTransfer?.types.includes(QUEUE_MIME)||event.dataTransfer.getData(QUEUE_MIME)!==dragId.value)return;
  event.preventDefault();event.stopPropagation();
  const source=moving.value.find(r=>r.messageId===dragId.value),before=dropAt.value;
  dragId.value='';dropAt.value='';if(source&&before)void move(source,before==='end'?null:before);
}
async function steer(i:InputView){const current=runId.value;if(current)await operate(i.messageId,()=>chat.steerQueueInput(i.messageId,current));}
</script>
<template>
  <div v-if="inputs.length || uncertain.length || drafts.length || stopped" class="input-inbox" aria-label="追加输入与队列">
    <p class="sr-only" aria-live="polite">{{announcement}}</p>
    <p v-if="stopped" class="stop-facts">停止记录：{{stopped.started}} 项工具已开始，{{stopped.notStarted}} 项未开始，{{stopped.unknown}} 项结果未知。{{stopped.possibleSideEffects?'已开始的操作可能已产生副作用；停止不会撤销这些操作。':'账本未记录已开始的副作用工具。'}}</p>
    <details v-if="inputs.length" open>
      <summary>追加输入 · {{inputs.length}} 条</summary>
      <div v-for="input in inputs" :key="input.messageId" class="input-row" :class="{'drop-before':dropAt===input.messageId,'drop-after':dropAt==='end'&&input===moving[moving.length-1]}" :data-input-id="input.messageId" :data-input-state="input.state"
        :draggable="movable(input)&&!editing&&!busy" @dragstart="dragStart(input,$event)" @dragover="dragOver(input,$event)" @drop="drop(input,$event)" @dragend="dragId='';dropAt=''">
        <div class="input-head"><span>{{input.mode==='steer'?'补充指示':'排队消息'}} · {{label(input)}}</span><time>{{time(input)}}</time></div>
        <template v-if="editing?.messageId===input.messageId">
          <textarea v-model="editing.text" aria-label="编辑这条排队消息" rows="3" @keydown="editorKey"></textarea>
          <div class="input-controls"><button type="button" :disabled="!!busy || (!editing.text.trim()&&!editing.attachments)" @click="saveEdit">保存</button><button type="button" :disabled="!!busy" @click="cancelEdit">取消</button></div>
        </template>
        <p v-else class="input-text">{{input.text || '图片消息'}}<span v-if="input.attachments.length"> · {{input.attachments.length}} 张图片</span></p>
        <p v-if="input.reason" class="input-reason">{{input.reason}}</p>
        <p v-if="errors[input.messageId]" class="input-error" role="alert">{{errors[input.messageId]}}</p>
        <div v-if="(input.state==='pending' || input.state==='held') && editing?.messageId!==input.messageId" class="input-controls">
          <template v-if="movable(input)">
            <button type="button" :disabled="!!editing||!!busy" @click="beginEdit(input)">编辑</button>
            <button type="button" aria-label="上移这条排队消息" :aria-disabled="!!editing||!!busy||moving[0]?.messageId===input.messageId" @click="step(input,-1,$event)">上移</button>
            <button type="button" aria-label="下移这条排队消息" :aria-disabled="!!editing||!!busy||moving[moving.length-1]?.messageId===input.messageId" @click="step(input,1,$event)">下移</button>
            <button v-if="runId&&!input.attachments.length" type="button" :disabled="!!editing||!!busy" @click="steer(input)">立即作为补充发送</button>
          </template>
          <button v-if="input.state==='held'" type="button" :disabled="!!editing||!!busy" @click="chat.changeInput(input.messageId,'resume')">继续为排队消息</button>
          <button type="button" :disabled="!!editing||!!busy" @click="chat.changeInput(input.messageId,'cancel')">取消这条输入</button>
        </div>
      </div>
    </details>
    <div v-for="input in uncertain" :key="input.messageId" class="input-row"><span>发送结果待核对，重连后查询</span><p class="input-text">{{input.text}}</p></div>
    <div v-for="(draft,index) in drafts" :key="draft.messageId" class="input-row"><span>没有送达 · 草稿已保留</span><p class="input-text">{{draft.text}}</p><button type="button" @click="$emit('restore',index)">取回输入框</button></div>
  </div>
</template>
<style scoped>
.input-inbox{width:100%;margin-bottom:10px;padding:12px;border:1px solid var(--c-line);border-radius:12px;max-height:220px;overflow:auto;background:var(--c-bg-2);font-size:12px;color:var(--c-ink-2)}
summary{cursor:pointer;font-weight:600}.input-row{padding:9px 0;border-top:1px solid var(--c-line);margin-top:8px}.input-head{display:flex;gap:12px;justify-content:space-between}.input-head time{white-space:nowrap;color:var(--c-ink-3)}
.input-text{white-space:pre-wrap;overflow-wrap:anywhere;margin:5px 0;max-height:72px;overflow:auto}.input-reason{color:var(--c-ink-3);margin:4px 0}.input-error{color:var(--c-err);margin:4px 0}.input-controls{display:flex;flex-wrap:wrap;gap:4px 12px}.input-inbox button{cursor:pointer;color:var(--c-brand);background:none;padding:3px 0;font-size:12px}.input-inbox button:disabled,.input-inbox button[aria-disabled="true"]{opacity:.45;cursor:default}.stop-facts{line-height:1.7;margin:0 0 8px}
textarea{display:block;width:100%;resize:vertical;min-height:60px;max-height:140px;margin:6px 0;padding:6px;border:1px solid var(--c-line);border-radius:6px;background:var(--c-bg);color:var(--c-ink)}.drop-before{border-top:2px solid var(--c-brand)}.drop-after{border-bottom:2px solid var(--c-brand)}
</style>
