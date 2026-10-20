import {describe,it,expect,afterEach,vi} from 'vitest';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {makeOfficeWriteTool,OFFICE_FORMATS} from '../src/minisd/tools/office';
import type {OfficeFormatHandler,OfficeWritePlan} from '../src/minisd/office/format';
import {officeFailed,officeUnverified} from '../src/shared/office-verification';
import {normalizeDocx} from '../src/minisd/office/docx/model';
import {verifyDocxContent} from '../src/minisd/office/docx/content-check';
import {closeAllCpEnvs,cpEnv} from './checkpoint-fixture';
afterEach(closeAllCpEnvs);
const fake = (plan:Partial<OfficeWritePlan>={}, extra:Partial<OfficeFormatHandler>={}): OfficeFormatHandler => ({format:'docx',app:'Word',help:{brief:'测试',content:'测试'},toText:()=>'',plan:()=>({bytes:Buffer.from('new'),summary:'测试文档',notes:[],...plan}),...extra});
async function run(handler:OfficeFormatHandler, old?:Buffer, inject?:Parameters<ReturnType<typeof cpEnv>['io']['hook']>[1]) {
  const env=cpEnv('f10a-flow'),sid=env.newSession(join(env.root, 'other-workspace'));
  const path=join(env.userDir,'out.docx'); if(old)writeFileSync(path,old);
  if(inject)env.io.hook('before-replace',inject);
  const check=vi.fn(async()=> 'allow' as const);
  const ctx=env.ctx(sid,{permissions:{check,hasBridgeGrant:()=>false}});
  const result=await makeOfficeWriteTool({...OFFICE_FORMATS,docx:handler}).execute({path,content:'{}',tool_title:'创建文档'},ctx);
  return {env,sid,path,check,result};
}
describe('T12 common Office write flow',()=>{
  it('unimplemented content verification is disclosed, exact success first line and one layout line',async()=>{
    const {result,path,env}=await run(fake());
    expect(result.success).toBe(true); expect(result.output.split('\n')[0]).toBe(`已生成 ${path}（测试文档）`);
    expect(result.output).toContain('内容核验：未核验——这种格式还没有接入内容核验');
    expect(result.output.match(/^版式核验：未核验——/gm)).toHaveLength(1);expect(result.output).not.toContain('版式核验：通过');
    expect(readFileSync(path)).toEqual(Buffer.from('new'));expect(env.rows()).toHaveLength(1);
  });
  it('failed content prevents approval, file creation and checkpoints',async()=>{
    const {result,path,check,env}=await run(fake({verifyContent:async s=>officeFailed('content',s,{id:'deskminis-readback',version:'1'},[{id:'parts',ok:false}], '包坏了')}));
    expect(result).toMatchObject({success:false});expect(result.output).toMatch(/^生成失败：内容核验未通过/);expect(check).not.toHaveBeenCalled();expect(existsSync(path)).toBe(false);expect(env.rows()).toEqual([]);
  });
  it('unexpected verifier errors still write but are reported as unverified',async()=>{
    const {result,path}=await run(fake({verifyContent:async()=>{throw new Error('unexpected');}}));
    expect(result.success).toBe(true);expect(result.output).toContain('内容核验：未核验');expect(readFileSync(path).toString()).toBe('new');
  });
  it('a mismatched verification subject cannot claim content passed',async()=>{
    const {result}=await run(fake({verifyContent:async s=>officeUnverified('content',{...s,size:123},'not-run','wrong')}));
    expect(result.success).toBe(true);expect(result.output).toContain('核验结果没有绑定本次生成字节');
  });
  it('no overwrite predicate keeps legacy format behavior with a recoverable checkpoint',async()=>{
    const old=Buffer.from('old'),{result,path,env,sid}=await run(fake(),old);
    expect(result.success).toBe(true);expect(env.rows()[0]).toMatchObject({state:'applied',before_size:3});
    await env.service.restore(sid,[env.rows()[0].id]);expect(readFileSync(path)).toEqual(old);
  });
  it.each(['reason','throw'] as const)('overwrite %s leaves the original byte-for-byte and no checkpoint',async kind=>{
    const old=Buffer.from('old'),{result,path,env,check}=await run(fake({}, {refuseOverwrite:()=>{if(kind==='throw')throw new Error('inspection');return '不能覆盖，请另存';}}),old);
    expect(result.success).toBe(false);expect(result.output).toBe(kind==='reason'?'不能覆盖，请另存':`没有覆盖 ${path}：检查原文件时出错，不能确认覆盖不会丢内容。原文件没有改动；请换一个文件名另存。`);
    expect(readFileSync(path)).toEqual(old);expect(env.rows()).toEqual([]);expect(check).toHaveBeenCalledTimes(1);expect(result.output).not.toMatch(/核验：/);
  });
  it('checkpoint IO failure emits only its failure message',async()=>{
    const {result,path}=await run(fake(),Buffer.from('old'),()=>{throw new Error('injected IO');});
    expect(result.success).toBe(false);expect(result.output).not.toMatch(/核验：/);expect(readFileSync(path).toString()).toBe('old');
  });
  it('notes are capped at twenty physical lines',async()=>{
    const {result}=await run(fake({notes:Array.from({length:22},(_,i)=>`note ${i}`)}));
    expect(result.output.match(/^提示：note /gm)).toHaveLength(20);expect(result.output).toContain('提示：另有 2 条');
  });
  it('cancellation while content verification is pending prevents approval and IO',async()=>{
    const env=cpEnv('f10a-content-cancel'),sid=env.newSession(join(env.root,'other-workspace')),path=join(env.userDir,'cancel.docx');
    let release!:()=>void;const pending=new Promise<void>(r=>{release=r;}),controller=new AbortController();
    const check=vi.fn(async()=> 'allow' as const);
    const handler=fake({verifyContent:async s=>{await pending;return officeUnverified('content',s,'not-run','test');}});
    const result=makeOfficeWriteTool({...OFFICE_FORMATS,docx:handler}).execute({path,content:'{}',tool_title:'创建文档'},env.ctx(sid,{signal:controller.signal,permissions:{check,hasBridgeGrant:()=>false}}));
    controller.abort();release();expect(await result).toEqual({output:'[已取消]',success:false});expect(check).not.toHaveBeenCalled();expect(existsSync(path)).toBe(false);expect(env.rows()).toEqual([]);
  });
  it('real handler emits qualified content success; truncated final bytes fail before approval',async()=>{
    const good=await run(OFFICE_FORMATS.docx);
    expect(good.result.output).toContain('不涉及版式，也不代表与其它文档一致');
    const model=normalizeDocx({}).model;
    const bad={...OFFICE_FORMATS.docx,plan:()=>{const p=OFFICE_FORMATS.docx.plan({}),bytes=p.bytes.subarray(0,p.bytes.length>>1);return {...p,bytes,verifyContent:(s:Parameters<typeof verifyDocxContent>[2])=>verifyDocxContent(bytes,model,s)};}};
    const {result,path,check}=await run(bad);expect(result.success).toBe(false);expect(check).not.toHaveBeenCalled();expect(existsSync(path)).toBe(false);
  });
});
