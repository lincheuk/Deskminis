import {describe,it,expect,afterEach,vi} from 'vitest';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {officeWriteTool,officeReadTool,docToText} from '../src/minisd/tools/office';
import {buildDocx} from '../src/minisd/office/docx/build';
import {inspectDocx,refuseDocxOverwrite,DOCX_OWN_PARTS,DOCX_OWN_ELEMENTS} from '../src/minisd/office/docx/inspect';
import {readZip,writeZip} from '../src/minisd/office/zip';
import {parseOffice} from '../src/minisd/office/parse';
import {legacyBuildDocx,LEGACY_DOCX_INPUTS} from './office-legacy-docx';
import {DOCX_FIXTURES} from './office-docx-fixtures';
import {randomDocxInput} from './office-docx-random';
import {closeAllCpEnvs,cpEnv} from './checkpoint-fixture';
afterEach(closeAllCpEnvs);
const fixture=(name:string)=>readFileSync(join(__dirname,`fixtures/office/${name}.docx`));
const own=()=>buildDocx({blocks:[{kind:'para',text:'原文'}]});
async function altered(kind:string):Promise<Buffer> {
  const p=await readZip(own());
  if(kind==='media')p.set('word/media/image1.png',Buffer.from('png'));
  if(kind==='header')p.set('word/header1.xml',Buffer.from('<w:hdr/>'));
  if(kind==='comments')p.set('word/comments.xml',Buffer.from('<w:comments><w:comment w:id="1"/></w:comments>'));
  if(kind==='revision')p.set('word/document.xml',Buffer.from(p.get('word/document.xml')!.toString().replace('<w:body>','<w:body><w:ins/>')));
  if(kind==='app')p.set('docProps/app.xml',Buffer.from(p.get('docProps/app.xml')!.toString().replace('DeskMinis','Microsoft Office Word')));
  if(kind==='edited-footer')p.set('word/footer1.xml',Buffer.from(p.get('word/footer1.xml')!.toString().replace('<w:t>1</w:t>','<w:t>Important footer text</w:t>')));
  return writeZip([...p].map(([path,data])=>({path,data})));
}
describe('T8 Word overwrite protection and extraction disclosure',()=>{
  const denied:[string,()=>Promise<Buffer>|Buffer][]=[
    ['real Word with images/header/comments',()=>fixture('foreign-word')],['real Word resaved generated file',()=>fixture('deskminis-resaved')],
    ...['media','header','comments','revision','app','edited-footer'].map(k=>[k,()=>altered(k)] as [string,()=>Promise<Buffer>]),
    ['legacy drawing',async()=>{const p=await readZip(legacyBuildDocx(LEGACY_DOCX_INPUTS.a));p.set('word/document.xml',Buffer.from(p.get('word/document.xml')!.toString().replace('<w:body>','<w:body><w:drawing/>')));return writeZip([...p].map(([path,data])=>({path,data})));}],
    ['garbage',()=>Buffer.from('garbage')],['compound encrypted file',()=>Buffer.from([0xd0,0xcf,0x11,0xe0])],['truncated ZIP',()=>own().subarray(0,100)],
  ];
  it.each(denied)('%s: one approval, unchanged original, no new file or checkpoint',async(name,make)=>{
    const env=cpEnv('f10a-deny'),sid=env.newSession(join(env.root,'other-workspace')),path=join(env.userDir,'original.docx'),original=await make();writeFileSync(path,original);
    const check=vi.fn(async()=> 'allow' as const);
    const r=await officeWriteTool.execute({path,content:'{"blocks":[]}',tool_title:'创建文档'},env.ctx(sid,{permissions:{check,hasBridgeGrant:()=>false}}));
    expect(r.success,name).toBe(false);expect(r.output).toContain('原文件没有改动');expect(r.output).toContain('另存');
    if(name.startsWith('real Word with'))for(const label of ['图片或媒体','页眉','批注'])expect(r.output).toContain(label);
    expect(check).toHaveBeenCalledTimes(1);expect(readFileSync(path)).toEqual(original);expect(readdirSync(env.userDir)).toEqual(['original.docx']);expect(env.rows()).toEqual([]);
  });
  it.each([['empty',()=>Buffer.alloc(0)],['new generator',own],['legacy',()=>legacyBuildDocx(LEGACY_DOCX_INPUTS.a)]] as const)('%s: permitted overwrite is checkpointed and restores original bytes',async(_,make)=>{
    const env=cpEnv('f10a-allow'),sid=env.newSession(),path=join(env.userDir,'original.docx'),original=make();writeFileSync(path,original);
    const r=await env.runTool(sid,'office_write',{path,content:'{"blocks":[{"kind":"para","text":"新文档"}]}'});
    expect(r.success,r.output).toBe(true);expect(env.rows()[0]).toMatchObject({state:'applied'});
    await env.service.restore(sid,[env.rows()[0].id]);expect(readFileSync(path)).toEqual(original);
  });
  it('target changed to foreign bytes while approval is pending is checked at commit time',async()=>{
    const env=cpEnv('f10a-delay'),sid=env.newSession(join(env.root,'other-workspace')),path=join(env.userDir,'out.docx');writeFileSync(path,own());
    let asked!:()=>void,allow!:()=>void;const started=new Promise<void>(r=>{asked=r;}),released=new Promise<void>(r=>{allow=r;});
    const pending=officeWriteTool.execute({path,content:'{"blocks":[]}',tool_title:'创建文档'},env.ctx(sid,{permissions:{check:async()=>{asked();await released;return 'allow';},hasBridgeGrant:()=>false}}));
    await started;const foreign=fixture('foreign-word');writeFileSync(path,foreign);allow();const result=await pending;
    expect(result.success).toBe(false);expect(readFileSync(path)).toEqual(foreign);expect(env.rows()).toEqual([]);
  });
  it('foreign read names omissions, retains list/soft-break/table content; comparison text excludes advisory',async()=>{
    const env=cpEnv('f10a-read'),sid=env.newSession(),path=join(env.userDir,'foreign.docx');writeFileSync(path,fixture('foreign-word'));
    const r=await officeReadTool.execute({path,tool_title:'读取文档'},env.ctx(sid));expect(r.success,r.output).toBe(true);
    for(const label of ['图片或媒体','页眉','批注'])expect(r.output).toContain(label);
    const doc=await parseOffice(path,readFileSync(path));expect(doc.blocks.filter(b=>b.list?.ordered).map(b=>b.list!.index)).toEqual([1,2,3]);
    expect(doc.blocks.some(b=>b.text?.includes('\n'))).toBe(true);expect(doc.blocks.find(b=>b.kind==='table')?.rows?.map(r=>r.length)).toEqual([2,2]);
    expect(docToText(doc)).not.toContain('未提取');
  });
  it.each([own,()=>legacyBuildDocx(LEGACY_DOCX_INPUTS.a)])('own generated footer is not reported as omitted',async make=>{
    const env=cpEnv('f10a-read-own'),sid=env.newSession(),path=join(env.userDir,'own.docx');writeFileSync(path,make());
    const r=await officeReadTool.execute({path,tool_title:'读取文档'},env.ctx(sid));expect(r.success).toBe(true);expect(r.output).not.toContain('未提取');
  });
  it('every fixture and 300 random legal inputs remain overwritable; whitelist has no unused entries',async()=>{
    const parts=new Set<string>(),elements=new Set<string>();
    const inputs=[...Object.values(DOCX_FIXTURES).map(make=>make()),...Array.from({length:300},(_,i)=>randomDocxInput(i+1))];
    for(const input of inputs) {
      const bytes=buildDocx(input);expect(inspectDocx(bytes).origin).toBe('deskminis');expect(refuseDocxOverwrite(bytes,'C:/sample.docx')).toBeUndefined();
      const zip=await readZip(bytes);for(const p of zip.keys())parts.add(p);
      for(const m of zip.get('word/document.xml')!.toString().matchAll(/<([\w:]+)[\s/>]/g))elements.add(m[1]);
    }
    expect([...parts].sort()).toEqual([...DOCX_OWN_PARTS].sort());expect([...elements].sort()).toEqual([...DOCX_OWN_ELEMENTS].sort());
  },60000);
});
