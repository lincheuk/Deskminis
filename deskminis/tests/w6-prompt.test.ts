/** W6：真实引擎请求出口，原文、位置、无工具与稳定缓存段。 */
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {startCapturedEngine,probeConnection} from './engine-assembly';
import {ModelCatalog} from '../src/minisd/providers/model-catalog';
import {ProviderStore} from '../src/minisd/store/provider-store';
import {OpenAIProvider} from '../src/minisd/providers/openai';
import {AnthropicProvider,buildAnthropicBody} from '../src/minisd/providers/anthropic';
import {buildDisciplineBlock} from '../src/minisd/agent/model-discipline';
import {TOOL_USE_GUIDANCE,WINDOWS_COMMAND_SAFETY} from '../src/minisd/agent/system-prompt';

const policy=JSON.parse(readFileSync(join(__dirname,'fixtures/w6-policy.json'),'utf8'));
const before=JSON.parse(readFileSync(join(__dirname,'fixtures/w6-before-prompts.json'),'utf8')).rows;
afterEach(()=>vi.restoreAllMocks());
it('两段原文与补充24一致',()=>{
  expect(TOOL_USE_GUIDANCE).toBe(policy.tool);
  expect(WINDOWS_COMMAND_SAFETY).toBe(policy.windows);
});

it.each([
  {kind:'openai-compat',tools:true,config:{}},
  {kind:'anthropic',tools:true,config:{}},
  {kind:'openai-compat',tools:true,config:{bridgeSection:'off',discipline:{toolUseEnforcement:false}}},
  {kind:'openai-compat',tools:false,config:{}},
  {kind:'anthropic',tools:false,config:{bridgeSection:'off',discipline:{toolUseEnforcement:false}}},
])('真实引擎请求 $kind / tools=$tools / $config',async({kind,tools,config})=>{
  vi.spyOn(ModelCatalog.prototype,'refresh').mockResolvedValue(true);
  vi.spyOn(ProviderStore.prototype,'getPromptConfig').mockReturnValue(config as any);
  const requests:any[]=[];let finished!:()=>void;
  async function* capture(req:any){requests.push(structuredClone(req));yield{kind:'textDelta' as const,text:'ok'};yield{kind:'done' as const,stopReason:'endTurn' as const};finished();}
  vi.spyOn(OpenAIProvider.prototype,'streamAgentMessage').mockImplementation(capture);
  vi.spyOn(AnthropicProvider.prototype,'streamAgentMessage').mockImplementation(capture);
  const e=await startCapturedEngine(),call=(m:string,p:any)=>e.methods[m](p,probeConnection('local'));
  try{
    const p:any=await call('provider.instances.create',{name:'W6 synthetic',kind,baseUrl:'https://synthetic.invalid/v1',modelId:'unlisted-model',apiKey:'synthetic',capabilityOverrides:{toolCall:tools}});
    const s:any=await call('chat.sessions.create',{title:'W6 synthetic'});await call('chat.sessions.setModelBinding',{sessionId:s.id,binding:'provider:'+p.id});await call('chat.sessions.setMemoryEnabled',{sessionId:s.id,enabled:false});
    for(let i=0;i<2;i++){const done=new Promise<void>(r=>finished=r);await call('chat.prompt',{sessionId:s.id,text:'synthetic'});await done;await new Promise(r=>setImmediate(r));}
    for(const req of requests){
      const stable=req.systemPromptParts.stable;
      if(tools){
        for(const text of[policy.tool,policy.windows]){expect(req.systemPrompt.split(text)).toHaveLength(2);expect(stable).toContain(text);expect(req.systemPromptParts.dynamic).not.toContain(text);}
        expect(stable).toContain('\n\n'+policy.tool+'\n\n'+policy.windows);
        expect(stable.endsWith(policy.windows)).toBe(true);
        const discipline=buildDisciplineBlock('unlisted-model',(config as any).discipline??{});
        if(discipline)expect(stable.indexOf(policy.tool)).toBe(stable.indexOf(discipline)+discipline.length+2);
        else{expect(stable).not.toContain('操作纪律');expect(stable).not.toContain('MINIS_BRIDGE');}
      }else{
        expect({systemPrompt:req.systemPrompt,systemPromptParts:req.systemPromptParts}).toEqual(before.noTools);
        expect(req.systemPrompt).not.toContain(policy.tool);expect(req.systemPrompt).not.toContain(policy.windows);
      }
      if(kind==='anthropic'){
        const body:any=buildAnthropicBody(req,'synthetic');expect(body.system[0].text).toBe(stable);expect(body.system[0].cache_control).toEqual({type:'ephemeral'});
      }
    }
    expect(requests).toHaveLength(2);expect(requests[1].systemPromptParts).toEqual(requests[0].systemPromptParts);
  }finally{await e.close();}
},30000);
