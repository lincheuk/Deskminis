import {afterEach,describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';import {crc32,deflateSync} from 'node:zlib';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
import {buildPptx,MANIFEST} from '../src/minisd/office/pptx/build';
import {pptxHandler} from '../src/minisd/office/pptx/handler';import {parseOffice} from '../src/minisd/office/parse';
import {normalizePptx} from '../src/minisd/office/pptx/model';import {verifyPptxContent} from '../src/minisd/office/pptx/content-check';
import {refusePptxOverwrite} from '../src/minisd/office/pptx/inspect';import {decodeImage} from '../src/minisd/office/pptx/assets';
import {readZip,writeZip} from '../src/minisd/office/zip';import {cpEnv,closeAllCpEnvs} from './checkpoint-fixture';
afterEach(closeAllCpEnvs);
const OLD={slides:[{title:'封面',bullets:['2026 年度总结']},{title:'业绩',bullets:['营收 +25%','成本 -8%','净利 +33%']}]};
const subject=(b:Buffer)=>({sha256:createHash('sha256').update(b).digest('hex'),size:b.length});
const chunk=(type:string,data:Buffer)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,8+data.length)),8+data.length);return b;};
const png=(w=8,h=4)=>{const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;const raw=Buffer.alloc((w*4+1)*h,255);for(let y=0;y<h;y++)raw[y*(w*4+1)]=0;return 'data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');};
const mixed={slides:[{layout:'title',title:'年度总结',subtitle:'中文与 English\n第二行'},{layout:'columns',title:'比较',columns:[{heading:'左',bullets:['甲','乙']},{heading:'右',bullets:['丙']}]},{layout:'image',title:'横图',image:{dataUrl:png(),alt:'测试图',caption:'图像说明'}},{layout:'table',title:'预算',table:{rows:[['项目','金额'],['开发',100]],colWidths:[2,1]}}]};
async function changed(b:Buffer,mutate:(p:Map<string,Buffer>)=>void){const p=await readZip(b);mutate(p);return writeZip([...p].map(([path,data])=>({path,data})));}
describe('F10C editable layouts, strict input and actual-content protection',()=>{
 it('P1 legacy text stays intact, deterministic bytes, content verified and exact original overwrite allowed',async()=>{
  const p=pptxHandler.plan(OLD);expect(p.bytes).toEqual(buildPptx(OLD));expect(p.summary).toBe('PowerPoint 演示，2 页');expect(refusePptxOverwrite(p.bytes,'own.pptx')).toBeUndefined();expect((await p.verifyContent!(subject(p.bytes))).status).toBe('verified');
  const d=await parseOffice('old.pptx',p.bytes);expect(d.slides!.map(s=>({title:s.title,bullets:s.bullets}))).toEqual(OLD.slides);
 });
 it('P2 all layout contents, editable table, media ratio and explicit extraction limitations survive readback',async()=>{
  const p=pptxHandler.plan(mixed);expect((await p.verifyContent!(subject(p.bytes))).status).toBe('verified');const d=await parseOffice('mixed.pptx',p.bytes);
  expect(d.slides![0].bullets).toEqual(['中文与 English\n第二行']);expect(d.slides![1].bullets).toEqual(['左','甲','乙','右','丙']);expect(d.slides![3].elements!.find(e=>e.kind==='table')!.rows).toEqual([['项目','金额'],['开发','100']]);
  const pic=d.slides![2].elements!.find(e=>e.kind==='image')!;expect(pic.w/pic.h).toBeCloseTo(2,4);expect(pptxHandler.toText(d)).toContain('开发\t100');expect(pptxHandler.toText(d)).toContain('图片：测试图');expect(pptxHandler.readNote!(d)).toContain('母版');
 });
 it('P3 real F08 overwrites only known generated package and restores exact previous bytes',async()=>{
  const e=cpEnv('f10c-own'),sid=e.newSession(),path=join(e.userDir,'own.pptx'),old=buildPptx(OLD);writeFileSync(path,old);
  const r=await e.runTool(sid,'office_write',{path,content:JSON.stringify(mixed)});expect(r.success,r.output).toBe(true);expect(r.output).toContain('内容核验：通过');expect(r.output).toContain('版式核验：未核验');expect(r.output).not.toContain('版式核验：通过');expect(e.rows()).toHaveLength(1);expect(readFileSync(path)).not.toEqual(old);
  await e.service.restore(sid,[e.rows()[0].id]);expect(readFileSync(path)).toEqual(old);
 });
 it.each(['text','font','fontName','color','geometry','image','table','tableUri','layout','masterReference','theme','source','subject'] as const)('P4 actual %s corruption fails content verification and overwrite protection',async kind=>{
  const b=buildPptx(mixed),bad=kind==='subject'?b:await changed(b,p=>{
    if(kind==='source'){p.set(MANIFEST,Buffer.from(JSON.stringify({schema:1,input:OLD})));return;}
    if(kind==='image'){const k=[...p.keys()].find(k=>k.startsWith('ppt/media/'))!;p.set(k,Buffer.from('wrong image'));return;}
    const path=kind==='masterReference'?'ppt/presentation.xml':kind==='theme'?'ppt/theme/theme1.xml':kind==='layout'?'ppt/slides/_rels/slide1.xml.rels':kind==='table'||kind==='tableUri'?'ppt/slides/slide4.xml':kind==='text'?'ppt/slides/slide1.xml':'ppt/slides/slide2.xml';
    let s=p.get(path)!.toString();if(kind==='text')s=s.replace('年度总结','丢失文字');if(kind==='font')s=s.replace('sz="3000"','sz="800"');if(kind==='fontName')s=s.replace('typeface="微软雅黑"','typeface="Arial"');if(kind==='color')s=s.replaceAll('val="234B73"','val="FFFFFF"');if(kind==='geometry')s=s.replace('x="635000"','x="20000000"');if(kind==='table')s=s.replace('开发','错误');if(kind==='tableUri')s=s.replace('/2006/table','/2006/main/table');if(kind==='masterReference')s=s.replace('r:id="rIdMaster"','r:id="missing"');if(kind==='layout')s=s.replace('../slideLayouts/slideLayout1.xml','missing.xml');if(kind==='theme')s=s.replaceAll('微软雅黑','Arial');expect(s).not.toBe(p.get(path)!.toString());p.set(path,Buffer.from(s));
  });
  const check=await verifyPptxContent(bad,normalizePptx(mixed),kind==='subject'?{sha256:'wrong',size:1}:subject(bad));
  if(kind==='source')expect(check.status).toBe('verified');else expect(check.status,JSON.stringify(check)).toBe('failed');
  // The source manifest is deliberately excluded from content proof; bytes must still reject replacement.
  if(kind!=='subject')expect(refusePptxOverwrite(bad,'bad.pptx')).toContain('另存');
 });
 it('P5 marker forgery cannot grant foreign overwrite; actual tool leaves bytes and checkpoints intact',async()=>{
  const forged=writeZip([{path:MANIFEST,data:Buffer.from(JSON.stringify({schema:1,input:OLD}))}]),e=cpEnv('f10c-forged'),sid=e.newSession(),path=join(e.userDir,'foreign.pptx');writeFileSync(path,forged);
  const r=await e.runTool(sid,'office_write',{path,content:JSON.stringify(OLD)});expect(r.success).toBe(false);expect(r.output).toContain('另存');expect(readFileSync(path)).toEqual(forged);expect(e.rows()).toEqual([]);
 });
 it('P6 presentation relationship order and arbitrary slide filenames determine read order',async()=>{
  const b=await changed(buildPptx(OLD),p=>{const s=p.get('ppt/slides/slide1.xml')!,r=p.get('ppt/slides/_rels/slide1.xml.rels')!;p.delete('ppt/slides/slide1.xml');p.delete('ppt/slides/_rels/slide1.xml.rels');p.set('ppt/slides/custom.xml',s);p.set('ppt/slides/_rels/custom.xml.rels',r);p.set('ppt/_rels/presentation.xml.rels',Buffer.from(p.get('ppt/_rels/presentation.xml.rels')!.toString().replace('slides/slide1.xml','slides/custom.xml')));p.set('ppt/presentation.xml',Buffer.from(p.get('ppt/presentation.xml')!.toString().replace('r:id="rIdSlide1"','r:id="TEMP"').replace('r:id="rIdSlide2"','r:id="rIdSlide1"').replace('r:id="TEMP"','r:id="rIdSlide2"')));});
  expect((await parseOffice('order.pptx',b)).slides!.map(s=>s.title)).toEqual(['业绩','封面']);
 });
 it.each([{slides:[]},{slides:[{layout:'single',title:'x',image:{}}]},{slides:[{layout:'columns',columns:[{},{}],extra:1}]},{slides:[{layout:'table',table:{rows:[[1],[1,2]]}}]},{slides:[{layout:'table',table:{rows:[['x','y']],colWidths:[100,.1]}}]},{slides:[{title:'bad\0'}]},{slides:[{title:'x',bullets:['中'.repeat(2000)]}]}])('P7 invalid or overflowing spec rejects: %#',input=>expect(()=>buildPptx(input)).toThrow());
 it.each(['http://host/image.png','data:image/png;base64,AAAA','data:image/jpeg;base64,AQ==','data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO3sAAAAASUVORK5CYII='])('P8 invalid image fails explicitly: %#',s=>expect(()=>decodeImage(s)).toThrow());
 it('P9 tall and wide images keep ratio, duplicated byte assets share one media part',async()=>{
  const image={dataUrl:png(2,8),alt:'tall'},b=buildPptx({slides:[{layout:'image',image},{layout:'image',image}]}),parts=await readZip(b);expect([...parts.keys()].filter(k=>k.startsWith('ppt/media/'))).toHaveLength(1);for(const s of (await parseOffice('tall.pptx',b)).slides!){const p=s.elements!.find(e=>e.kind==='image')!;expect(p.w/p.h).toBeCloseTo(.25,4);}
 });
 it('P10 invalid layout fails actual office_write before creating file or checkpoint',async()=>{
  const e=cpEnv('f10c-reject'),sid=e.newSession(),path=join(e.userDir,'never.pptx');const r=await e.runTool(sid,'office_write',{path,content:JSON.stringify({slides:[{title:'x',bullets:['中'.repeat(2000)]}]})});expect(r.success).toBe(false);expect(r.output).toMatch(/溢出/);expect(existsSync(path)).toBe(false);expect(e.rows()).toEqual([]);
 });
 it('P11 legal blank slide and XML special characters retain original strings',async()=>{
  const d=await parseOffice('blank.pptx',buildPptx({slides:[{title:'',bullets:[]},{title:'<&>"',bullets:['甲 & <乙>','尾行\n第二行']}]}));expect(d.slides![0]).toMatchObject({title:'',bullets:[]});expect(d.slides![1]).toMatchObject({title:'<&>"',bullets:['甲 & <乙>','尾行\n第二行']});
 });
 it('P12 global text and slide bounds cannot be hidden in non-rendered image alt text',()=>{
  expect(()=>buildPptx({slides:Array.from({length:50},()=>({layout:'image',image:{dataUrl:png(),alt:'a'.repeat(2500)}}))})).toThrow(/10万/);
  expect(()=>buildPptx({slides:Array.from({length:51},()=>({title:''}))})).toThrow(/50/);
 });
 it('P13 intact pixel data with a false PNG CRC, or an over-wide image, must reject before packaging',()=>{
  const b=Buffer.from(png().split(',')[1],'base64');b[29]^=1;expect(()=>decodeImage('data:image/png;base64,'+b.toString('base64'))).toThrow(/校验/);
  expect(()=>decodeImage(png(8193,1))).toThrow(/8192/);
 });
 it('P14 individually fitting table cells cannot produce a table taller than the slide content area',()=>{
  const rows=Array.from({length:8},()=>['中'.repeat(40),'文'.repeat(40)]);
  expect(()=>buildPptx({slides:[{layout:'table',title:'表格高度边界',table:{rows}}]})).toThrow(/表格溢出/);
 });
});
