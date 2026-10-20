/** C3：格式、真实store/SFC、独立计时与鼠标焦点入口。 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {effectScope,isVNode,nextTick,type VNode} from 'vue';
import {join} from 'node:path';
import {runSetup,type SetupRun} from './sfc-setup';
import {initStore,minimalReply,resetStoreRpc,type Chat} from './renderer-store-fixture';
import {formatDuration} from '../src/renderer/src/lib/time/duration';
const probe=vi.hoisted(()=>({call:vi.fn(),on:vi.fn(),handlers:new Map(),lost:vi.fn(),connect:vi.fn(),parse:vi.fn()}));
vi.mock('../src/renderer/src/rpc',()=>({rpc:{call:probe.call,on:probe.on,onLost:probe.lost,connect:probe.connect}}));
vi.mock('../src/renderer/src/lib/markdown/parse',async importOriginal=>{const real=await importOriginal<typeof import('../src/renderer/src/lib/markdown/parse')>();return{...real,parseLiveMarkdown:(s:string)=>{probe.parse(s);return real.parseLiveMarkdown(s);}};});
type Render=(ctx:object,cache:unknown[])=>VNode;
const all=(v:unknown):VNode[]=>Array.isArray(v)?v.flatMap(all):isVNode(v)?[v,...all(v.children)]:[];
const text=(v:unknown):string=>Array.isArray(v)?v.map(text).join(''):isVNode(v)?text(v.children):typeof v==='string'?v:'';
const clock=(v:VNode)=>all(v).filter(n=>String(n.props?.class??'').split(' ').includes('turn-elapsed')).map(text);
const mounted:SetupRun<any>[]=[];let chat:Chat;
async function setup(name:string){const run=await runSetup<Render>(join(__dirname,'../src/renderer/src/ui',name),{},effectScope(),{inlineTemplate:true});mounted.push(run);run.mount();return{run,render:()=>run.bindings({},[])};}
const m=(id:string,role:string,createdAt:number,parts:any[]=[])=>({id,role,createdAt,parts});
async function history(rows:any[]){probe.call.mockImplementation((method:string)=>method==='chat.messages.list'?Promise.resolve(rows):minimalReply(method));await chat.open('s');await nextTick();}
beforeEach(async()=>{resetStoreRpc(probe);vi.stubGlobal('window',{deskminis:{},matchMedia:()=>({matches:false}),addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('localStorage',{getItem:()=>null});vi.stubGlobal('requestAnimationFrame',()=>0);vi.stubGlobal('cancelAnimationFrame',vi.fn());chat=await initStore(probe);probe.parse.mockClear();});
afterEach(()=>{mounted.splice(0).forEach(r=>r.unmount());vi.useRealTimers();vi.unstubAllGlobals();});

describe('共用用时格式',()=>{
  it.each([[0.4,'不到 1 秒'],[0,'不到 1 秒'],[1,'1 秒'],[59,'59 秒'],[59.999,'59 秒'],[60,'1 分'],[72,'1 分 12 秒'],[3599,'59 分 59 秒'],[3599.999,'59 分 59 秒'],[3600,'1 小时'],[3725,'1 小时 2 分'],[7200,'2 小时'],[-1,''],[NaN,''],[Infinity,'']] as const)('%s → %s',(s,w)=>expect(formatDuration(s)).toBe(w));
});

describe('历史用时',()=>{
  it.each(['tool','user'])('终点取最后一条%s工具结果，起点取user',async role=>{
    await history([m('u','user',100,[{type:'text',value:'问题'}]),m('a','assistant',120,[{type:'text',value:'回答'}]),m('r',role,172,[{type:'toolResult',value:{toolUseId:'t',success:true}}])]);
    const v=await setup('StageChat.vue');expect(clock(v.render())).toEqual(['用时 1 分 12 秒']);
  });
  it('只有工具的回合显示用时，没有复制',async()=>{
    await history([m('u','user',100),m('a','assistant',172,[{type:'toolUse',value:{name:'file_read',toolUseId:'t',input:'{}'}}])]);
    const v=await setup('StageChat.vue');expect(clock(v.render())).toEqual(['用时 1 分 12 秒']);expect(all(v.render()).some(n=>n.props?.['aria-label']==='复制这条回复')).toBe(false);
  });
  it.each([
    [m('a','assistant',172,[{type:'text',value:'无user'}])],
    [m('u','user',100)],
    [m('u','user',100),m('a','assistant',99,[{type:'text',value:'负数'}])],
  ])('缺user、无后继或负数不显示 %#',async(...rows:any[])=>{await history(rows);expect(clock((await setup('StageChat.vue')).render())).toEqual([]);});
  it('在跑和收尾时只隐藏最后回合，历史取回后恢复',async()=>{
    await history([m('u1','user',100),m('a1','assistant',172,[{type:'text',value:'第一'}]),m('u2','user',200),m('a2','assistant',260,[{type:'text',value:'第二'}])]);
    const v=await setup('StageChat.vue');chat.running=true;await nextTick();expect(clock(v.render())).toEqual(['用时 1 分 12 秒']);chat.running=false;await nextTick();expect(clock(v.render())).toEqual(['用时 1 分 12 秒']);chat.messages=[...chat.messages];await nextTick();expect(clock(v.render())).toEqual(['用时 1 分 12 秒','用时 1 分']);
  });
});

describe('实时用时不驱动正文',()=>{
  it.each([false,true])('每秒走钟，结束和卸载清理，midRun=%s',async midRun=>{
    vi.useFakeTimers();vi.setSystemTime(172000);chat.messages=[m('u','user',100)];chat.running=true;chat.midRun=midRun;chat.streamingText='稳定正文';
    const v=await setup('LiveTurn.vue');expect(clock(v.render())).toEqual(['已用 1 分 12 秒']);const parsed=probe.parse.mock.calls.length;expect(parsed).toBe(midRun?0:1);
    await vi.advanceTimersByTimeAsync(1000);expect(clock(v.render())).toEqual(['已用 1 分 13 秒']);await vi.advanceTimersByTimeAsync(1000);expect(clock(v.render())).toEqual(['已用 1 分 14 秒']);expect(probe.parse).toHaveBeenCalledTimes(parsed);
    expect(vi.getTimerCount()).toBe(1);chat.running=false;await nextTick();expect(clock(v.render())).toEqual([]);expect(vi.getTimerCount()).toBe(0);
    chat.running=true;await nextTick();expect(clock(v.render())).toEqual(['已用 1 分 14 秒']);expect(vi.getTimerCount()).toBe(1);v.run.unmount();mounted.pop();expect(vi.getTimerCount()).toBe(0);
  });
  it('无真实user时从显示时刻起算，不把工具结果载体当起点',async()=>{
    vi.useFakeTimers();vi.setSystemTime(172000);chat.messages=[m('r','user',1,[{type:'toolResult',value:{}}])];chat.running=true;
    const v=await setup('LiveTurn.vue');expect(clock(v.render())).toEqual(['已用 不到 1 秒']);await vi.advanceTimersByTimeAsync(1000);expect(clock(v.render())).toEqual(['已用 1 秒']);
  });
  it('负的本机时间差不显示',async()=>{
    vi.useFakeTimers();vi.setSystemTime(99000);chat.messages=[m('u','user',100)];chat.running=true;expect(clock((await setup('LiveTurn.vue')).render())).toEqual([]);
  });
});

it('分隔条鼠标防默认聚焦并清焦点，保留Tab入口和键盘处理器',async()=>{
  chat.init=async()=>{};chat.activeId='s';chat.messages=[m('u','user',100,[{type:'text',value:'问题'}])];
  const v=await setup('AppShell.vue');chat.pendingFilePreview='synthetic.md';await nextTick();
  const h=all(v.render()).find(n=>n.props?.role==='separator')!;expect(h.props?.tabindex).toBe('0');expect(h.props?.onKeydown).toBeTypeOf('function');
  const blur=vi.fn(),preventDefault=vi.fn();h.props!.onMousedown({currentTarget:{blur},preventDefault});expect(preventDefault).toHaveBeenCalledOnce();expect(blur).toHaveBeenCalledOnce();
});
