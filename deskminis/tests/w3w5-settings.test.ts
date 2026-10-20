import {it,expect,vi,beforeEach,afterEach} from 'vitest';import {join} from 'node:path';import {mkdirSync,writeFileSync} from 'node:fs';
import {effectScope,nextTick} from 'vue';import {useChat} from '../src/renderer/src/stores/chat';import {renderSfc,runSetup} from './sfc-setup';import {resetStoreRpc} from './renderer-store-fixture';
import {startCapturedEngine,probeConnection} from './engine-assembly';import {ModelCatalog} from '../src/minisd/providers/model-catalog';
const probe=vi.hoisted(()=>{const handlers=new Map<string,any>();return{call:vi.fn(),on:vi.fn((n:string,f:any)=>handlers.set(n,f)),handlers,lost:vi.fn(),connect:vi.fn(async()=>{})};});
vi.mock('../src/renderer/src/rpc',()=>({rpc:{call:probe.call,on:probe.on,onLost:probe.lost,connect:probe.connect}}));
const file=(s:string)=>join(__dirname,'../src/renderer/src/ui/settings/'+s+'.vue');
const hint='模型只看得到名字，几乎不会自己用它；在 SKILL.md 开头加一行 description: 说明它做什么';
beforeEach(()=>resetStoreRpc(probe));afterEach(()=>vi.restoreAllMocks());
it('MCP renders distinct reasons and raw-name titles; empty remains the original tool tag',async()=>{
 const chat=useChat();chat.mcpServers={servers:[{name:'a',transport:'stdio',command:'fake',enabled:true},{name:'b',transport:'stdio',command:'fake',enabled:true}],statuses:[{name:'a',status:'connected',toolCount:40,limitSkipped:['raw.40','raw.41'],collisionSkipped:['dup&name']},{name:'b',status:'connected',toolCount:3,limitSkipped:[],collisionSkipped:[]}],configError:false};
 const html=await renderSfc(file('SecMcp'),{});expect(html).toContain('另有 2 个没加载（超过每台 40 / 全局 120 的上限）');expect(html).toContain('1 个与已有工具重名、没加载');expect(html).toContain('title="raw.40、raw.41"');expect(html).toContain('title="dup&amp;name"');
 expect(html).toMatch(/class="f-tag ok" title>\s*3 个工具/);expect((html.match(/mcp-skipped/g)||[])).toHaveLength(2);
});
it('missing descriptions warn; described skills retain their normal text',async()=>{
 const chat=useChat();chat.allSkills=[{id:'a',name:'Bare',description:'',isEnabled:true,useCount:0},{id:'b',name:'Documented',description:'Known description',isEnabled:true,useCount:0}] as any;
 const html=await renderSfc(file('SecSkills'),{});expect(html).toMatch(/class="sdesc t-aux skill-warning">没有描述/);expect(html).toContain(hint);expect(html).toContain('class="sdesc t-aux">Known description');expect((html.match(/几乎不会自己用它/g)||[])).toHaveLength(1);
});
it('real successful folder import and actual polling show the same non-blocking warning',async()=>{
 vi.spyOn(ModelCatalog.prototype,'refresh').mockResolvedValue(true);const e=await startCapturedEngine();const call=(m:string,p:any)=>e.methods[m](p,probeConnection('local'));
 try{const source=join(e.root,'source');mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'---\nname: Bare Import\n---\nSynthetic skill body');
 const chat=useChat();probe.call.mockImplementation((m:string,p:any)=>call(m,p));const setup=await runSetup<any>(file('SecSkills'),{},effectScope());setup.mount();
 try{await chat.importSkillFolder(source);let t:any;for(let i=0;i<100;i++){t=await chat.pollSkillImport(chat.skillImport!.taskId);if(chat.skillImport!.state!=='running')break;await new Promise(r=>setTimeout(r,10));}
 await nextTick();for(let i=0;i<100&&!chat.allSkills.length;i++)await new Promise(r=>setTimeout(r,10));expect(chat.skillImport!.state).toBe('done');expect(chat.skillImport!.succeeded).toHaveLength(1);expect(chat.skillImport!.failures).toEqual([]);
 const html=await renderSfc(file('SecSkills'),{});expect(html).toContain('成功 1 个');expect(html).toMatch(/class="skill-warning import-warning t-aux"/);expect(html).toContain('Bare Import：没有描述。'+hint);
 }finally{setup.unmount();}
 }finally{await e.close();}
},30000);
