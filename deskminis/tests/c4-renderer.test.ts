import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {effectScope,nextTick,type VNode} from 'vue';
import {resolve} from 'node:path';
import {createPinia,setActivePinia} from 'pinia';
const {call}=vi.hoisted(()=>({call:vi.fn()}));
vi.mock('../src/renderer/src/rpc',()=>({rpc:{call,connect:async()=>{},on:()=>{},onLost:()=>{}}}));
import {useChat} from '../src/renderer/src/stores/chat';
import {runSetup} from './sfc-setup';
import {settleStore} from './renderer-store-fixture';
import type {InputView} from '../src/shared/inputs';
const file=resolve('src/renderer/src/ui/InputQueue.vue'),cleanups:(()=>void)[]=[];
let chat:ReturnType<typeof useChat>;
const row=(id:string,extra:Partial<InputView>={}):InputView=>({sessionId:'A',messageId:id,seq:Number(id)||1,mode:'queue',state:'pending',text:'body '+id,attachments:[],createdAt:1,updatedAt:1,...extra});
beforeEach(()=>{setActivePinia(createPinia());chat=useChat();chat.activeId='A';chat.inputsOn=true;chat.connection='ok';chat.engineEpoch=1;chat.runOf={A:{runId:'R',generation:1,ended:false}};call.mockReset();
 call.mockImplementation(async(method:string,p:any)=>{
  if(method==='chat.input.list')return {sessionId:p.sessionId,inputs:chat.inputsBySession[p.sessionId]??[]};
  if(method==='chat.input.resume'||method==='chat.input.edit')return {input:row(p.messageId,{text:p.text??'body '+p.messageId,state:p.resume===false?'held':'pending',updatedAt:3})};
  if(method==='chat.input.hold')return {input:{...chat.inputsBySession.A.find(i=>i.messageId===p.messageId),state:'held',reason:'正在编辑',updatedAt:2}};
  if(method==='chat.input.move')return {input:chat.inputsBySession.A.find(i=>i.messageId===p.messageId)};
  return {input:row(p.messageId,{mode:'steer',runId:p.runId,updatedAt:3})};
 });});
afterEach(()=>{cleanups.splice(0).forEach(f=>f());vi.restoreAllMocks();});
async function setup(inlineTemplate=false){const r=await runSetup<any>(file,{},effectScope(),{inlineTemplate});cleanups.push(r.unmount);return inlineTemplate?()=>r.bindings({},[]):r.bindings;}
function nodes(n:any):VNode[]{if(!n||typeof n!=='object')return [];return [n,...(Array.isArray(n.children)?n.children.flatMap(nodes):[])];}
const text=(v:any):string=>typeof v==='string'?v:Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.children):'';
const button=(v:VNode,label:string)=>nodes(v).find(n=>n.type==='button'&&text(n)===label)!;
const calls=(m:string)=>call.mock.calls.filter(c=>c[0]===m);
describe('C4 queue renderer behavior',()=>{
 it('C4R1 template shows operations only on movable queue and steer only during live run without images',async()=>{
  chat.adoptInputs([row('1'),row('2',{state:'held',attachments:['a.png']}),row('3',{mode:'steer'}),row('4',{state:'starting'}),row('5',{state:'admitted'}),row('6',{state:'delivered'})]);const render=await setup(true);
  const queueRows=()=>nodes(render()).filter(n=>n.props?.['data-input-id']);const controls=()=>queueRows().map(n=>nodes(n).filter(b=>b.type==='button').map(text));
  expect(controls()).toEqual([['编辑','上移','下移','立即作为补充发送','取消这条输入'],['编辑','上移','下移','继续为排队消息','取消这条输入'],['取消这条输入'],[],[],[]]);
  chat.runOf.A.ended=true;expect(controls()[0]).not.toContain('立即作为补充发送');delete chat.runOf.A;expect(controls()[0]).not.toContain('立即作为补充发送');
 });
 it('C4R2 edit waits for hold and saves original pending resume flag and held version',async()=>{
  chat.adoptInputs([row('1')]);const b=await setup();let reply!:(v:any)=>void;call.mockImplementationOnce(()=>new Promise(r=>reply=r));const pending=b.beginEdit(chat.inputsBySession.A[0]);expect(b.editing.value).toBeNull();expect(calls('chat.input.hold')).toEqual([['chat.input.hold',{sessionId:'A',messageId:'1'}]]);
  reply({input:row('1',{state:'held',updatedAt:7})});await pending;expect(b.editing.value).toMatchObject({resume:true,updatedAt:7});b.editing.value.text='new body';await b.saveEdit();expect(calls('chat.input.edit')[0]).toEqual(['chat.input.edit',{sessionId:'A',messageId:'1',text:'new body',updatedAt:7,resume:true}]);expect(b.editing.value).toBeNull();
 });
 it.each(['pending','held'] as const)('C4R3 cancel resumes only original pending: %s',async state=>{
  chat.adoptInputs([row('1',{state})]);const b=await setup();await b.beginEdit(chat.inputsBySession.A[0]);await b.cancelEdit();expect(calls('chat.input.resume')).toHaveLength(state==='pending'?1:0);expect(b.editing.value).toBeNull();
 });
 it('C4R4 held save stays held; empty body cannot save unless attachments exist',async()=>{
  chat.adoptInputs([row('1',{state:'held'})]);const b=await setup();await b.beginEdit(chat.inputsBySession.A[0]);b.editing.value.text='  ';await b.saveEdit();expect(calls('chat.input.edit')).toHaveLength(0);b.editing.value.attachments=1;await b.saveEdit();expect(calls('chat.input.edit')[0][1]).toMatchObject({resume:false,text:'  '});
 });
 it('C4R5 hold rejection stays on row; save and cancel rejection keep editor and refresh list',async()=>{
  chat.adoptInputs([row('1')]);const b=await setup();call.mockRejectedValueOnce(Error('already starting'));await b.beginEdit(chat.inputsBySession.A[0]);expect(b.editing.value).toBeNull();expect(b.errors.value['1']).toBe('already starting');expect(calls('chat.input.list')).toHaveLength(1);
  await b.beginEdit(chat.inputsBySession.A[0]);call.mockRejectedValueOnce(Error('version conflict'));await b.saveEdit();expect(b.errors.value['1']).toBe('version conflict');expect(b.editing.value).not.toBeNull();call.mockRejectedValueOnce(Error('resume failed'));await b.cancelEdit();expect(b.editing.value).not.toBeNull();expect(b.errors.value['1']).toBe('resume failed');expect(calls('chat.input.list')).toHaveLength(3);
 });
 it('C4R6 Esc and Ctrl Enter use cancel/save; IME does neither and only one row can edit',async()=>{
  chat.adoptInputs([row('1'),row('2')]);const b=await setup();await b.beginEdit(chat.inputsBySession.A[0]);await b.beginEdit(chat.inputsBySession.A[1]);expect(calls('chat.input.hold')).toHaveLength(1);
  const preventDefault=vi.fn();b.editorKey({key:'Escape',isComposing:true,preventDefault});b.editorKey({key:'Enter',ctrlKey:true,keyCode:229,preventDefault});await settleStore();expect(preventDefault).not.toHaveBeenCalled();
  b.editorKey({key:'Escape',preventDefault});await settleStore();expect(b.editing.value).toBeNull();expect(calls('chat.input.resume')).toHaveLength(1);await b.beginEdit(chat.inputsBySession.A[0]);b.editorKey({key:'Enter',ctrlKey:true,preventDefault});await settleStore();expect(calls('chat.input.edit')).toHaveLength(1);
 });
 it('C4R7 up/down calculate beforeMessageId, announce location, refocus same button and do nothing at boundary',async()=>{
  chat.adoptInputs([row('1'),row('2'),row('3')]);const b=await setup();const focus=vi.fn(),event={currentTarget:{focus}};
  call.mockImplementation(async(method:string,p:any)=>{if(method==='chat.input.list')return {inputs:[row('2',{position:1}),row('1',{position:2}),row('3',{position:3})]};return {input:row(p.messageId,{position:1})};});
  b.step(b.moving.value[1],-1,event);await settleStore();expect(calls('chat.input.move')[0]).toEqual(['chat.input.move',{sessionId:'A',messageId:'2',beforeMessageId:'1'}]);expect(b.announcement.value).toBe('已移到第 1 位');expect(focus).toHaveBeenCalledOnce();
  b.step(b.moving.value[0],-1,event);await settleStore();expect(calls('chat.input.move')).toHaveLength(1);b.step(b.moving.value[1],1,event);await settleStore();expect(calls('chat.input.move')[1][1]).toMatchObject({messageId:'1',beforeMessageId:null});
 });
 it('C4R8 actual buttons expose disabled boundary, full aria labels, polite region and call move',async()=>{
  chat.adoptInputs([row('1'),row('2'),row('3')]);const render=await setup(true),v=render(),rows=nodes(v).filter(n=>n.props?.['data-input-id']);
  expect(button(rows[0],'上移').props?.['aria-disabled']).toBe(true);expect(button(rows[2],'下移').props?.['aria-disabled']).toBe(true);expect(button(rows[1],'上移').props?.['aria-label']).toBe('上移这条排队消息');expect(nodes(v).some(n=>n.props?.['aria-live']==='polite')).toBe(true);
  button(rows[1],'下移').props!.onClick({currentTarget:{focus:vi.fn()}});await settleStore();expect(calls('chat.input.move')[0][1]).toMatchObject({messageId:'2',beforeMessageId:null});
 });
 it('C4R9 custom MIME drag carries identity only and drops after last row with no text/plain payload',async()=>{
  chat.adoptInputs([row('1'),row('2')]);const b=await setup(),data=new Map<string,string>(),preventDefault=vi.fn(),stopPropagation=vi.fn();
  const transfer={setData:(type:string,value:string)=>data.set(type,value),getData:(type:string)=>data.get(type)??'',get types(){return [...data.keys()];}},event={dataTransfer:transfer,preventDefault,stopPropagation,clientY:100,currentTarget:{getBoundingClientRect:()=>({top:0,height:20})}};
  b.dragStart(b.moving.value[0],event);expect([...data]).toEqual([['application/x-deskminis-queue-input','1']]);expect(data.has('text/plain')).toBe(false);b.dragOver(b.moving.value[1],event);expect(b.dropAt.value).toBe('end');b.drop(b.moving.value[1],event);await settleStore();expect(calls('chat.input.move')[0][1]).toMatchObject({messageId:'1',beforeMessageId:null});
 });
 it('C4R10 external text drag and immutable target are rejected; move errors stay in row and refresh',async()=>{
  chat.adoptInputs([row('1'),row('2',{state:'starting'})]);const b=await setup(),preventDefault=vi.fn();b.dragId.value='1';b.dragOver(chat.inputsBySession.A[0],{dataTransfer:{types:['text/plain']},preventDefault});expect(preventDefault).not.toHaveBeenCalled();
  b.dragOver(chat.inputsBySession.A[1],{dataTransfer:{types:['application/x-deskminis-queue-input']},preventDefault});expect(preventDefault).not.toHaveBeenCalled();call.mockRejectedValueOnce(Error('move failed'));await b.move(chat.inputsBySession.A[0],null);expect(b.errors.value['1']).toBe('move failed');expect(calls('chat.input.list')).toHaveLength(1);
 });
 it('C4R11 component and store sort by position then seq; stale versions do not replace moved row',async()=>{
  chat.adoptInputs([row('1',{position:5}),row('2',{position:1}),row('3',{position:5})]);const b=await setup();expect(b.inputs.value.map((i:InputView)=>i.messageId)).toEqual(['2','1','3']);chat.noteInput(row('1',{position:0,updatedAt:3}));chat.noteInput(row('1',{position:8,updatedAt:2}));expect(chat.inputsBySession.A.map(i=>i.messageId)).toEqual(['1','2','3']);
 });
 it('C4R14 move then noteInput keeps store order in effective positions rather than seq',async()=>{
  chat.adoptInputs([row('1'),row('2'),row('3')]);
  call.mockImplementation(async(method:string)=>method==='chat.input.list'?{inputs:[row('3',{position:1,updatedAt:2}),row('1',{position:2,updatedAt:2}),row('2',{position:3,updatedAt:2})]}:{input:row('3',{position:1,updatedAt:2})});
  await chat.moveQueueInput('3','1');expect(calls('chat.input.move')[0]).toEqual(['chat.input.move',{messageId:'3',beforeMessageId:'1',sessionId:'A'}]);
  expect(chat.inputsBySession.A.map(i=>i.messageId)).toEqual(['3','1','2']);
  chat.noteInput(row('2',{position:3,state:'held',updatedAt:3}));expect(chat.inputsBySession.A.map(i=>i.messageId)).toEqual(['3','1','2']);
  expect(chat.inputsBySession.A[2].state).toBe('held');
 });
 it('C4R12 steer sends current run and failures are displayed; no live run sends no operation',async()=>{
  chat.adoptInputs([row('1')]);const b=await setup();call.mockRejectedValueOnce(Error('run ended'));await b.steer(chat.inputsBySession.A[0]);expect(calls('chat.input.steer')[0]).toEqual(['chat.input.steer',{sessionId:'A',messageId:'1',runId:'R'}]);expect(b.errors.value['1']).toBe('run ended');chat.runOf.A.ended=true;await b.steer(chat.inputsBySession.A[0]);expect(calls('chat.input.steer')).toHaveLength(1);
 });
 it('C4R13 old epoch reply is discarded and switch while hold pending cannot open another session editor',async()=>{
  chat.adoptInputs([row('1')]);const b=await setup();let reply!:(v:any)=>void;call.mockImplementationOnce(()=>new Promise(r=>reply=r));const p=b.beginEdit(chat.inputsBySession.A[0]);chat.engineEpoch=2;reply({input:row('1',{state:'held',updatedAt:99})});await p;expect(b.editing.value).toBeNull();expect(chat.inputsBySession.A[0].updatedAt).toBe(1);
  call.mockImplementationOnce(()=>new Promise(r=>reply=r));const pending=b.beginEdit(chat.inputsBySession.A[0]);chat.activeId='B';await nextTick();reply({input:row('1',{state:'held'})});await pending;expect(b.editing.value).toBeNull();
 });
});
