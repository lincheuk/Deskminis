import {it,expect,vi,afterEach} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {McpManager} from '../src/minisd/mcp/manager';import {McpServersStore} from '../src/minisd/mcp/config';import {McpStdioClient} from '../src/minisd/mcp/stdio';
import {MinisPaths} from '../src/minisd/paths';import {ToolRegistry} from '../src/minisd/tools/registry';import {ChatStore} from '../src/minisd/store/chat-store';import {openDb} from '../src/minisd/store/db';
import {ModelCatalog} from '../src/minisd/providers/model-catalog';import {buildAnthropicBody} from '../src/minisd/providers/anthropic';import {OpenAIProvider} from '../src/minisd/providers/openai';import {startCapturedEngine,probeConnection} from './engine-assembly';
import {TOOL_USE_GUIDANCE,WINDOWS_COMMAND_SAFETY} from '../src/minisd/agent/system-prompt';
const info=(name:string)=>({name,inputSchema:{type:'object',properties:{}}});
afterEach(()=>vi.restoreAllMocks());
it('45 tools and a built-in collision keep separate raw names, totals and reset state',async()=>{
 const db=openDb(':memory:');const chat=new ChatStore(db), sid=chat.createSession().id;
 const store=new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(),'dm-w3-'))));
 for(const name of ['a','b','c','d'])store.upsert({name,command:'synthetic',enabled:true});
 const registry=new ToolRegistry();registry.register({definition:{name:'mcp__b__file_read',description:'built in collision',parameters:{},required:[]},execute:async()=>({success:true,output:'ok'})});
 const mgr=new McpManager({store,chatStore:chat,registry,factories:e=>({closed:false,onNotification:undefined,connect:async()=>{},dispose:()=>{},callTool:async()=>({}),listTools:async()=>e.name==='b'?[info('file_read')]:Array.from({length:45},(_,i)=>info('raw.'+i))})});
 try{await mgr.ensureForRun();const statuses=mgr.statuses();expect(statuses[0]).toMatchObject({toolCount:40,truncated:5,limitSkipped:['raw.40','raw.41','raw.42','raw.43','raw.44'],collisionSkipped:[]});
 expect(statuses[1]).toMatchObject({toolCount:0,truncated:1,limitSkipped:[],collisionSkipped:['file_read']});
 expect(statuses[3]).toMatchObject({toolCount:40,truncated:5}); // total MCP loaded 120
 const first=mgr.omissionBlock(sid);expect(first).toContain('raw.40');expect(first).toContain('与已有工具重名');
 statuses[0].limitSkipped.length=0;expect(mgr.statuses()[0].limitSkipped).toHaveLength(5); // defensive snapshot
 chat.setMcpDisabled(sid,['a','b','c','d']);expect(mgr.omissionBlock(sid)).toBe('');
 chat.setMcpDisabled(sid,[]);store.toggle('a',false);expect(mgr.omissionBlock(sid)).not.toContain('服务器 "a"');
 mgr.forget('b');expect(mgr.statuses()[1]).toMatchObject({truncated:0,limitSkipped:[],collisionSkipped:[]});
 await mgr.disposeAll();expect(mgr.statuses().every(s=>s.truncated===0&&s.limitSkipped.length===0&&s.collisionSkipped.length===0)).toBe(true);
 }finally{await mgr.disposeAll();db.close();}
});
it('global 120 records all 45 names on the next server as limit omissions',async()=>{
 const db=openDb(':memory:');const store=new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(),'dm-w3-global-'))));for(const name of ['a','b','c','d'])store.upsert({name,command:'synthetic',enabled:true});
 const mgr=new McpManager({store,chatStore:new ChatStore(db),registry:new ToolRegistry(),factories:()=>({closed:false,onNotification:undefined,connect:async()=>{},dispose:()=>{},callTool:async()=>({}),listTools:async()=>Array.from({length:45},(_,i)=>info('g'+i))})});
 try{await mgr.ensureForRun();expect(mgr.statuses()[3]).toMatchObject({toolCount:0,truncated:45,limitSkipped:Array.from({length:45},(_,i)=>'g'+i),collisionSkipped:[]});}finally{await mgr.disposeAll();db.close();}
});
it('actual engine request keeps pristine empty prompts; omitted names are capped, stable and follow skills',async()=>{
 vi.spyOn(ModelCatalog.prototype,'refresh').mockResolvedValue(true);
 let listed=0;vi.spyOn(McpStdioClient.prototype,'connect').mockResolvedValue();vi.spyOn(McpStdioClient.prototype,'listTools').mockImplementation(async()=>Array.from({length:listed},(_,i)=>info('omitted_'+String(i).padStart(3,'0'))));
 const requests:any[]=[];let resolve!:()=>void;
 vi.spyOn(OpenAIProvider.prototype,'streamAgentMessage').mockImplementation(async function*(req){requests.push(structuredClone(req));yield {kind:'textDelta',text:'ok'};yield {kind:'done',stopReason:'endTurn'};resolve();});
 const e=await startCapturedEngine();const call=(m:string,p:any)=>e.methods[m](p,probeConnection('local'));
 const original=JSON.parse(readFileSync(join(__dirname,'fixtures/w3-before-prompts.json'),'utf8')).rows;
 const guidance='\n\n'+TOOL_USE_GUIDANCE+'\n\n'+WINDOWS_COMMAND_SAFETY;
 const baseline={...original,tools:{systemPrompt:original.tools.systemPrompt+guidance,systemPromptParts:{...original.tools.systemPromptParts,stable:original.tools.systemPromptParts.stable+guidance}}};
 try{
 const sessions:any={};for(const tools of [true,false]){const inst:any=await call('provider.instances.create',{name:'synthetic',kind:'openai-compat',baseUrl:'https://synthetic.invalid/v1',modelId:'unlisted-model',apiKey:'synthetic',capabilityOverrides:{toolCall:tools}});const s:any=await call('chat.sessions.create',{title:'W3 synthetic'});await call('chat.sessions.setModelBinding',{sessionId:s.id,binding:'provider:'+inst.id});await call('chat.sessions.setMemoryEnabled',{sessionId:s.id,enabled:false});sessions[tools?'tools':'noTools']=s.id;}
 async function prompt(which='tools'){const done=new Promise<void>(r=>resolve=r);await call('chat.prompt',{sessionId:sessions[which],text:'synthetic'});await done;await new Promise(r=>setImmediate(r));return requests.at(-1);}
 for(const which of ['tools','noTools']){const r=await prompt(which);expect({systemPrompt:r.systemPrompt,systemPromptParts:r.systemPromptParts}).toEqual(baseline[which]);}
 const source=join(e.root,'skill-source');mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'---\nname: W3 skill order\ndescription: synthetic order fixture\n---\nbody');
 const task:any=await call('skills.import',{kind:'folder',source});let progress:any;
 for(let i=0;i<100;i++){progress=await call('skills.importStatus',{taskId:task.taskId});if(progress?.state!=='running')break;await new Promise(r=>setTimeout(r,10));}
 expect(progress.state).toBe('done');const withSkills=await prompt();expect(withSkills.systemPrompt).toContain('<available_skills>');
 // Real MCP connect/list + registration, no model/network traffic.
 listed=75;await call('mcp.servers.upsert',{name:'synthetic',command:'fake',enabled:true});
 const r=await prompt();const block=r.systemPromptParts.stable.slice(withSkills.systemPromptParts.stable.length);
 expect(block).toContain('MCP 工具未加载');expect(block).toContain('超过每台 40 / 全局 120 的上限');expect(block).toContain('等 35 个');expect(block).toContain('这一轮不能用');expect(block).toContain('设置里停用');
 expect(block.match(/omitted_\d+/g)).toHaveLength(30);expect(block).toContain('omitted_040');expect(block).not.toContain('omitted_070');expect(r.systemPromptParts.dynamic).toBe('');expect(r.systemPrompt.indexOf('</available_skills>')).toBeLessThan(r.systemPrompt.indexOf('MCP 工具未加载'));
 const body:any=buildAnthropicBody(r,'synthetic');expect(body.system[0].text).toBe(r.systemPromptParts.stable);expect(body.system[0].cache_control).toEqual({type:'ephemeral'});
 expect((await prompt()).systemPromptParts).toEqual(r.systemPromptParts);
 expect((await prompt('noTools')).systemPrompt).toBe(baseline.noTools.systemPrompt);
 await call('chat.sessions.setMcpDisabled',{sessionId:sessions.tools,servers:['synthetic']});
 expect((await prompt()).systemPrompt).toBe(withSkills.systemPrompt); listed=1;await call('chat.sessions.setMcpDisabled',{sessionId:sessions.tools,servers:[]});await call('mcp.servers.upsert',{name:'synthetic',command:'fake',enabled:true});expect((await prompt()).systemPrompt).toBe(withSkills.systemPrompt);
 }finally{await e.close();}
},30000);
