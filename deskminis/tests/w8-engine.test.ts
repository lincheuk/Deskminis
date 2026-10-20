import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {startCapturedEngine,probeConnection} from './engine-assembly';
import {ModelCatalog} from '../src/minisd/providers/model-catalog';
import {OpenAIProvider} from '../src/minisd/providers/openai';
import {buildAnthropicBody} from '../src/minisd/providers/anthropic';
import {PermissionGatewayImpl} from '../src/minisd/tools/permissions';
const PLAN='当前权限档是「只读 / 计划」：可以读文件、运行只读命令，联网会询问用户；写文件、会改动东西的命令、MCP 工具会被直接拒绝。需要改动时，先给出具体方案，等用户切换档位后再做。';
afterEach(()=>vi.restoreAllMocks());
it.each([true,false])('真实引擎下一次请求实时切档，稳定段逐字不变，memory=%s',async enabled=>{
 vi.spyOn(ModelCatalog.prototype,'refresh').mockResolvedValue(true);const requests:any[]=[];vi.spyOn(OpenAIProvider.prototype,'streamAgentMessage').mockImplementation(async function*(req){requests.push(structuredClone(req));yield{kind:'textDelta',text:'ok'};yield{kind:'done',stopReason:'endTurn'};});
 const e=await startCapturedEngine(),rpc=async(m:string,p:any={}):Promise<any>=>e.methods[m](p,probeConnection('local'));
 try{const p:any=await rpc('provider.instances.create',{name:'W8',kind:'openai-compat',baseUrl:'https://synthetic.invalid/v1',modelId:'unlisted-model',apiKey:'synthetic',capabilityOverrides:{toolCall:true}});const s:any=await rpc('chat.sessions.create',{title:'W8'});await rpc('chat.sessions.setModelBinding',{sessionId:s.id,binding:'provider:'+p.id});await rpc('chat.sessions.setMemoryEnabled',{sessionId:s.id,enabled});
 async function turn(tier:string){await rpc('permission.setPreset',{preset:tier});const n=requests.length;await rpc('chat.prompt',{sessionId:s.id,text:'W8'});await vi.waitFor(()=>expect(requests).toHaveLength(n+1));await vi.waitFor(async()=>expect((await rpc('chat.runs.snapshot',{})).runs.filter((r:any)=>r.state==='running'||r.state==='starting')).toHaveLength(0));await new Promise(r=>setImmediate(r));return requests.at(-1);}
 const ask=await turn('ask'),plan=await turn('plan');expect(plan.systemPromptParts.stable).toBe(ask.systemPromptParts.stable);expect(plan.systemPromptParts.dynamic).toBe(enabled&&ask.systemPromptParts.dynamic?ask.systemPromptParts.dynamic+'\n\n'+PLAN:PLAN);expect(plan.systemPromptParts.stable).not.toContain(PLAN);expect((buildAnthropicBody(plan,'synthetic') as any).system[0]).toMatchObject({text:ask.systemPromptParts.stable,cache_control:{type:'ephemeral'}});const back=await turn('ask');expect(back.systemPromptParts).toEqual(ask.systemPromptParts);
 await rpc('provider.instances.update',{id:p.id,capabilityOverrides:{toolCall:false}});const textOnly=await turn('plan');expect(textOnly.systemPrompt).not.toContain(PLAN);
 }finally{await e.close();}
},30000);
it('plan RPC持久化、启动读回真实网关、非法值拒绝',async()=>{vi.spyOn(ModelCatalog.prototype,'refresh').mockResolvedValue(true);const spy=vi.spyOn(PermissionGatewayImpl.prototype,'applyPreset');const e=await startCapturedEngine();let second:any;try{expect(await e.methods['permission.setPreset']({preset:'plan'},probeConnection('local'))).toEqual({ok:true,preset:'plan'});expect(await e.methods['permission.getPreset']({},probeConnection('local'))).toEqual({preset:'plan'});expect(()=>e.methods['permission.setPreset']({preset:'invalid'},probeConnection('local'))).toThrow('非法权限档位');await e.handle.close();second=await startCapturedEngine({dataDir:e.root});expect(await second.methods['permission.getPreset']({},probeConnection('local'))).toEqual({preset:'plan'});const at=spy.mock.calls.map(c=>c[0]).lastIndexOf('plan');expect(at).toBeGreaterThan(0);const g=spy.mock.contexts[at] as PermissionGatewayImpl;expect(g.isPlanMode()).toBe(true);expect(await g.decide({kind:'shell',detail:'New-Item a.txt',sessionId:'s',toolTitle:'t'})).toMatchObject({decision:'deny',cause:'plan-mode'});}finally{await second?.handle.close();await e.close();}});

it('真实引擎同一运行中切档，下次工具循环请求马上改变动态段',async()=>{
 vi.spyOn(ModelCatalog.prototype,'refresh').mockResolvedValue(true);const e=await startCapturedEngine(),rpc=async(m:string,p:any={}):Promise<any>=>e.methods[m](p,probeConnection('local'));const requests:any[]=[];
 try{const p:any=await rpc('provider.instances.create',{name:'W8 live',kind:'openai-compat',baseUrl:'https://synthetic.invalid/v1',modelId:'unlisted-model',apiKey:'synthetic',capabilityOverrides:{toolCall:true}}),s:any=await rpc('chat.sessions.create',{title:'W8 live'});await rpc('chat.sessions.setModelBinding',{sessionId:s.id,binding:'provider:'+p.id});await rpc('chat.sessions.setMemoryEnabled',{sessionId:s.id,enabled:false});const dir=(await rpc('workspace.get',{sessionId:s.id})).root;mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'r.txt'),'W8 read');
 vi.spyOn(OpenAIProvider.prototype,'streamAgentMessage').mockImplementation(async function*(req){requests.push(structuredClone(req));const n=requests.length;if(n<3){await rpc('permission.setPreset',{preset:n===1?'plan':'ask'});yield{kind:'toolCallComplete',name:'file_read',input:JSON.stringify({path:'r.txt',tool_title:'read'}),toolUseId:'r'+n};yield{kind:'done',stopReason:'toolUse'};}else{yield{kind:'textDelta',text:'ok'};yield{kind:'done',stopReason:'endTurn'};}});
 await rpc('chat.prompt',{sessionId:s.id,text:'W8'});await vi.waitFor(()=>expect(requests).toHaveLength(3));await vi.waitFor(async()=>expect((await rpc('chat.runs.snapshot')).runs).toHaveLength(0));expect(requests.map(r=>r.systemPromptParts.dynamic)).toEqual(['',PLAN,'']);expect(new Set(requests.map(r=>r.systemPromptParts.stable)).size).toBe(1);
 }finally{await e.close();}
},30000);
