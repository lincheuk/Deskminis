import type {AgentMessage, ContentPart, RawMessage} from '../../shared/types';
import {userTurnText} from './compact-meta';

interface Origin {messageId:string; index:number; total:number}
/** Private identity metadata never appears in request JSON, storage or diagnostics. */
const origins=new WeakMap<object,readonly Origin[]>();
export function userPartWithOrigin(message:RawMessage,index:number):ContentPart {
  const original=message.parts[index];
  const target={...original};
  if(message.role==='user')origins.set(target,[{messageId:message.id,index,total:message.parts.length}]);
  return target;
}
/** Use only when the original part is carried in full (possibly with a separator). */
export function carryInputOrigin(from:ContentPart,to:ContentPart):ContentPart {
  const tags=origins.get(from);if(tags)origins.set(to,tags);return to;
}
/** F03 composes the exact complete text parts into its verbatim user-turn block. */
export function verbatimUserTextPart(message:RawMessage,prefix:string):ContentPart {
  const target:ContentPart={type:'text',value:prefix+userTurnText(message)};
  const tags:Origin[]=message.parts.flatMap((part,index)=>part.type==='text'&&String(part.value??'').trim()
    ?[{messageId:message.id,index,total:message.parts.length}]:[]);
  if(tags.length)origins.set(target,tags);
  return target;
}
export function fullyCoveredInputIds(messages:readonly AgentMessage[]):Set<string> {
  const found=new Map<string,{total:number;indices:Set<number>;consistent:boolean}>();
  for(const m of messages)for(const p of m.parts)for(const t of origins.get(p)??[]){
    const row=found.get(t.messageId)??{total:t.total,indices:new Set<number>(),consistent:true};
    row.consistent&&=row.total===t.total&&Number.isInteger(t.index)&&t.index>=0&&t.index<t.total;
    row.indices.add(t.index);found.set(t.messageId,row);
  }
  return new Set([...found].filter(([,r])=>r.consistent&&r.total>0&&r.indices.size===r.total).map(([id])=>id));
}

/** Wait for the first successful iterator result; creating/calling a stream is not a receipt.
 * Observer failure cannot turn an outgoing request into a retry. The original iterator is
 * retained so cancellation/throw is forwarded and it can close its network reader. */
export function observeInputRequest<T>(iterable:AsyncIterable<T>,observe:()=>void,signal?:AbortSignal):AsyncIterable<T> {
  return {[Symbol.asyncIterator](){
    const it=iterable[Symbol.asyncIterator]();let first=true;
    return {
      async next(...args:[]|[unknown]):Promise<IteratorResult<T>>{
        const isFirst=first;first=false;
        const result=await it.next(...args);
        if(isFirst&&!signal?.aborted){try{observe();}catch{/* Outgoing request remains in flight; status stays unconfirmed. */}}
        return result;
      },
      async return(value?:unknown):Promise<IteratorResult<T>>{return it.return?it.return(value):{done:true,value:value as T};},
      async throw(error?:unknown):Promise<IteratorResult<T>>{if(it.throw)return it.throw(error);if(it.return)await it.return();throw error;},
    };
  }};
}
