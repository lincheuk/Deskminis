import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {InputSend,InputView} from '../src/shared/inputs';
const {call,handlers}=vi.hoisted(()=>({call:vi.fn(),handlers:new Map<string,(p:any)=>void>()}));
vi.mock('../src/renderer/src/rpc',()=>({rpc:{call,connect:async()=>{},on:(m:string,h:(p:any)=>void)=>handlers.set(m,h),onLost:()=>{}}}));
import {createPinia,setActivePinia} from 'pinia';
import {useChat} from '../src/renderer/src/stores/chat';
import {markInFlightLoss} from '../src/renderer/src/lib/conn/in-doubt';

const receipt=(o:Partial<InputView>={}):InputView=>({seq:1,sessionId:'A',messageId:'i1',mode:'steer',text:'additional',attachments:[],state:'pending',runId:'R',createdAt:1,updatedAt:2,...o});
const row=(id:string,sid='A'):InputSend=>({sessionId:sid,messageId:id,mode:'queue',text:id,attachments:[]});
let chat:ReturnType<typeof useChat>;
beforeEach(()=>{setActivePinia(createPinia());chat=useChat();chat.activeId='A';chat.inputsOn=true;chat.syncOn=true;chat.engineEpoch=1;
  chat.runOf={A:{runId:'R',generation:1,ended:false}};chat.running=true;chat.runningSessions=['A'];chat.streamingText='visible partial reply';
  chat.streamingThinking='reasoning';chat.pendingPerms=[{requestId:'card',sessionId:'A',req:{kind:'shell'}}] as any;
  chat.messages=[{id:'original',role:'user',parts:[{type:'text',value:'original'}],createdAt:1}];call.mockReset();handlers.clear();
  call.mockImplementation(async(m:string,p:any)=>m==='chat.input.send'?{input:receipt({messageId:p.messageId,text:p.text,mode:p.mode}),duplicate:false}:undefined);
});
afterEach(()=>{vi.useRealTimers();});
describe('F07 renderer input facts',()=>{
  it('R1 steer carries exact current run and preserves streaming text, cards, history and running state',async()=>{
    const before=JSON.stringify({text:chat.streamingText,thinking:chat.streamingThinking,cards:chat.pendingPerms,messages:chat.messages,running:chat.running});
    expect(await chat.sendInput('steer','additional')).toBe(true);
    expect(call.mock.calls).toHaveLength(1);expect(call.mock.calls[0]).toMatchObject(['chat.input.send',{sessionId:'A',mode:'steer',runId:'R',text:'additional'}]);
    expect(JSON.stringify({text:chat.streamingText,thinking:chat.streamingThinking,cards:chat.pendingPerms,messages:chat.messages,running:chat.running})).toBe(before);
    expect(chat.inputsBySession.A).toHaveLength(1);
  });
  it('R2 synchronous rejection returns draft ownership without false input bubble or changing the running task',async()=>{
    call.mockRejectedValue(new Error('queue full'));expect(await chat.sendInput('queue','draft',['attachments/x.png'])).toBe(false);
    expect(chat.lastError).toBe('queue full');expect(chat.streamingText).toBe('visible partial reply');expect(chat.running).toBe(true);
    expect(chat.inputsBySession.A).toBeUndefined();expect(chat.messages).toHaveLength(1);
  });
  it('R3 lost accepted reply is queried once; no send retry, no duplicate row and no lost draft',async()=>{
    call.mockRejectedValueOnce(markInFlightLoss(new Error('lost reply')));expect(await chat.sendInput('steer','uncertain')).toBe(true);
    const p=chat.inDoubtInputs[0];expect(p.text).toBe('uncertain');
    call.mockImplementation(async(m:string)=>m==='state.outcomes'?{epoch:1,instanceId:'I',outcomes:[{kind:'input',sessionId:'A',messageId:p.messageId,status:'accepted',input:receipt({messageId:p.messageId,text:p.text,state:'delivered',updatedAt:5})}]}:undefined);
    await chat.settleInputsInDoubt();expect(chat.inDoubtInputs).toEqual([]);expect(chat.inputsBySession.A[0].state).toBe('delivered');
    expect(call.mock.calls.filter(c=>c[0]==='chat.input.send')).toHaveLength(1);expect(chat.failedInputDrafts.A).toBeUndefined();expect(chat.streamingText).toBe('visible partial reply');
  });
  it('R4 multiple not-accepted drafts are retained per session without automatic sending or overwriting each other',async()=>{
    chat.inDoubtInputs=[row('one'),row('two'),row('other','B')];call.mockImplementation(async(m:string,p:any)=>({outcomes:p.refs.map((r:any)=>({...r,status:'not-accepted'}))}));
    await chat.settleInputsInDoubt();expect(chat.failedInputDrafts.A.map(p=>p.text)).toEqual(['one','two']);expect(chat.failedInputDrafts.B.map(p=>p.text)).toEqual(['other']);
    expect(chat.inDoubtInputs).toEqual([]);expect(call.mock.calls.map(c=>c[0])).toEqual(['state.outcomes']);
  });
  it('R5 outcome returning after deletion cannot resurrect a row or draft',async()=>{
    chat.inDoubtInputs=[row('old')];let release!:(v:any)=>void;call.mockReturnValue(new Promise(r=>release=r));const pending=chat.settleInputsInDoubt();
    chat.markGone(['A']);release({outcomes:[{kind:'input',sessionId:'A',messageId:'old',status:'not-accepted'}]});await pending;
    expect(chat.inDoubtInputs).toEqual([]);expect(chat.failedInputDrafts.A).toBeUndefined();expect(chat.inputsBySession.A).toBeUndefined();
  });
  it('R6 older send response cannot regress a newer receipt; held head remains in authoritative snapshot',()=>{
    chat.noteInput(receipt({state:'delivered',updatedAt:4}));chat.noteInput(receipt({state:'pending',updatedAt:2}));expect(chat.inputsBySession.A[0].state).toBe('delivered');
    const many=Array.from({length:50},(_,i)=>receipt({seq:i+2,messageId:'d'+i,state:'delivered'}));
    chat.adoptInputs([receipt({state:'held'}),...many]);expect(chat.inputsBySession.A[0].state).toBe('held');expect(chat.inputsBySession.A).toHaveLength(51);
    chat.adoptInputs([]);expect(chat.inputsBySession).toEqual({});
  });
  it('R7 Stop includes observed run identity; unidentified or ended run sends no cancellation',async()=>{
    await chat.cancel();expect(call.mock.calls[0]).toEqual(['chat.cancel',{sessionId:'A',runId:'R'}]);
    call.mockClear();chat.runOf.A.ended=true;await chat.cancel();expect(call).not.toHaveBeenCalled();expect(chat.lastError).toContain('尚未确认');
  });
  it('R8 reconnecting and unknown run reject steer without calling RPC or touching the reply',async()=>{
    chat.connection='reconnecting';expect(await chat.sendInput('queue','draft')).toBe(false);expect(call).not.toHaveBeenCalled();
    chat.connection='ok';delete chat.runOf.A;expect(await chat.sendInput('steer','draft')).toBe(false);expect(call).not.toHaveBeenCalled();expect(chat.streamingText).toBe('visible partial reply');
  });
  it('R9 query batches are bounded and a failed query retains every uncertain input',async()=>{
    chat.inDoubtInputs=Array.from({length:70},(_,i)=>row('i'+i));let n=0;
    call.mockImplementation(async(m:string,p:any)=>{if(++n===2)throw Error('disconnect');return {outcomes:p.refs.map((r:any)=>({...r,status:'not-accepted'}))};});
    await chat.settleInputsInDoubt();expect(call.mock.calls.map(c=>c[1].refs.length)).toEqual([64,6]);expect(chat.failedInputDrafts.A).toHaveLength(64);expect(chat.inDoubtInputs).toHaveLength(6);
    call.mockImplementation(async(m:string,p:any)=>({outcomes:p.refs.map((r:any)=>({...r,status:'not-accepted'}))}));await chat.settleInputsInDoubt();expect(chat.failedInputDrafts.A).toHaveLength(70);
  });
  it('R10 explicit unchanged draft retry reuses original message ID, changed text gets a new identity',async()=>{
    const original={...row('old-id'),mode:'steer' as const,runId:'R',text:'unchanged'};chat.inputRetryBySession.A=original;
    await chat.sendInput('steer','unchanged');expect(call.mock.calls[0][1].messageId).toBe('old-id');expect(chat.inputRetryBySession.A).toBeUndefined();
    chat.inputRetryBySession.A=original;await chat.sendInput('steer','edited');expect(call.mock.calls[1][1].messageId).not.toBe('old-id');
  });
  it('R11 old engine reply is not applied across epoch change; current engine outcome decides the retained input',async()=>{
    let reply!:(v:any)=>void,queried!:(v:any)=>void;
    call.mockImplementation((m:string)=>m==='chat.input.send'?new Promise(r=>reply=r):new Promise(r=>queried=r));
    const sending=chat.sendInput('steer','old-engine');chat.engineEpoch=2;
    reply({input:receipt({state:'delivered',text:'old-engine'}),duplicate:false});await sending;
    expect(chat.inputsBySession.A).toBeUndefined();expect(chat.inDoubtInputs).toHaveLength(1);
    const p=chat.inDoubtInputs[0];queried({outcomes:[{kind:'input',sessionId:'A',messageId:p.messageId,status:'not-accepted'}]});
    await new Promise(r=>setImmediate(r));expect(chat.failedInputDrafts.A[0].text).toBe('old-engine');expect(call.mock.calls.filter(c=>c[0]==='chat.input.send')).toHaveLength(1);
  });
  it('R12 an outcome from the old epoch keeps uncertain identity until the current engine answers',async()=>{
    chat.inDoubtInputs=[row('epoch-query')];let reply!:(v:any)=>void;
    let current!:(v:any)=>void;call.mockReturnValueOnce(new Promise(r=>reply=r)).mockReturnValueOnce(new Promise(r=>current=r));const query=chat.settleInputsInDoubt();chat.engineEpoch=2;
    reply({outcomes:[{kind:'input',sessionId:'A',messageId:'epoch-query',status:'not-accepted'}]});await query;
    expect(chat.inDoubtInputs).toHaveLength(1);expect(chat.failedInputDrafts.A).toBeUndefined();
    current({outcomes:[{kind:'input',sessionId:'A',messageId:'epoch-query',status:'accepted',input:receipt({messageId:'epoch-query',state:'held'})}]});
    await new Promise(r=>setImmediate(r));expect(chat.inDoubtInputs).toEqual([]);expect(chat.inputsBySession.A[0].state).toBe('held');expect(call.mock.calls.map(c=>c[0])).toEqual(['state.outcomes','state.outcomes']);
  });
  it('R13 old queue-operation reply cannot overwrite current epoch snapshot and requests a fresh list',async()=>{
    let reply!:(v:any)=>void;call.mockImplementation((m:string)=>m==='chat.input.cancel'?new Promise(r=>reply=r):Promise.resolve({sessionId:'A',inputs:[receipt({state:'held',updatedAt:1})]}));
    const changing=chat.changeInput('i1','cancel');chat.engineEpoch=2;chat.adoptInputs([receipt({state:'held',updatedAt:1})]);
    reply({input:receipt({state:'cancelled',updatedAt:999})});await changing;await new Promise(r=>setImmediate(r));
    expect(chat.inputsBySession.A[0].state).toBe('held');expect(call.mock.calls.map(c=>c[0])).toEqual(['chat.input.cancel','chat.input.list']);
  });

});
