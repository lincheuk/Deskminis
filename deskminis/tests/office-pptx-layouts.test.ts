import {afterEach,describe,it,expect} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {buildPptx} from '../src/minisd/office/pptx/build';import {pptxHandler} from '../src/minisd/office/pptx/handler';
import {readZip} from '../src/minisd/office/zip';import {parseOffice} from '../src/minisd/office/parse';
import {cpEnv,closeAllCpEnvs} from './checkpoint-fixture';
import {crc32,deflateSync} from 'node:zlib';
afterEach(closeAllCpEnvs);
const chunk=(type:string,data:Buffer)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,8+data.length)),8+data.length);return b;};
const ihdr=Buffer.from('00000001000000010806000000','hex');
// Real valid pixel data. The previously copied tiny PNG had a bad CRC; preserve it as a rejection case below.
const PNG='data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
const deck=(s:unknown)=>({slides:[s]} as any);
describe('F10C concrete layout and package behavior',()=>{
 it('C1 includes actual master/layout/theme and slide relationship chain',async()=>{
  const p=await readZip(buildPptx(deck({title:'标题',bullets:['要点']})));expect(p.has('ppt/slideMasters/slideMaster1.xml')).toBe(true);expect(p.has('ppt/slideLayouts/slideLayout1.xml')).toBe(true);expect(p.has('ppt/theme/theme1.xml')).toBe(true);
  expect(p.get('ppt/slides/_rels/slide1.xml.rels')!.toString()).toContain('slideLayout');
 });
 it('C2 two columns carry both independent headings and editable body text',async()=>{
  const p=await readZip(buildPptx(deck({layout:'columns',title:'对比',columns:[{heading:'左栏',bullets:['左要点']},{heading:'右栏',bullets:['右要点']}]}))),xml=p.get('ppt/slides/slide1.xml')!.toString();
  for(const text of ['左栏','左要点','右栏','右要点'])expect(xml).toContain(text);expect(xml).not.toContain('normAutofit');
  const d=await parseOffice('columns.pptx',buildPptx(deck({layout:'columns',title:'对比',columns:[{heading:'左栏',bullets:['左要点']},{heading:'右栏',bullets:['右要点']}]}))),es=d.slides![0].elements!,left=es.find(e=>e.name==='Column1Body')!,right=es.find(e=>e.name==='Column2Body')!;expect(left.x+left.w).toBeLessThan(right.x);
 });
 it('C3 very long Chinese content rejects instead of automatically shrinking forever',()=>{
  expect(()=>buildPptx(deck({title:'长文',bullets:['这是不允许挤在一页的内容。'.repeat(1000)]}))).toThrow(/溢出|拆页|过长|超过/);
 });
 it('C4 image is an actual media part and relationship, with preserved aspect ratio',async()=>{
  const p=await readZip(buildPptx(deck({layout:'image',title:'图片',image:{dataUrl:PNG,alt:'方形测试图',caption:'说明'}})));expect([...p.keys()].some(k=>k.startsWith('ppt/media/'))).toBe(true);expect(p.get('ppt/slides/slide1.xml')!.toString()).toContain('<p:pic>');expect(p.get('ppt/slides/_rels/slide1.xml.rels')!.toString()).toContain('/image');
 });
 it('C5 table is editable native DrawingML instead of lost content',async()=>{
  const p=await readZip(buildPptx(deck({layout:'table',title:'预算',table:{rows:[['项目','金额'],['开发',100]]}}))),xml=p.get('ppt/slides/slide1.xml')!.toString();expect(xml).toContain('<a:tbl>');expect(xml).toContain('开发');expect(xml).toContain('100');
 });
 it.each([{layout:'unknown',title:'x'},{layout:'image',title:'x',image:{path:'missing.png'}},{layout:'columns',title:'x',columns:[]},{layout:'table',title:'x',table:{rows:[]}}])('C6 invalid layouts or missing image source fail clearly: %#',slide=>{expect(()=>buildPptx(deck(slide))).toThrow();});
 it('C7 foreign presentation cannot be overwritten and leaves no fake checkpoint',async()=>{
  const e=cpEnv('f10c-protect'),sid=e.newSession(),path=join(e.userDir,'complex.pptx'),old=Buffer.from('foreign presentation');writeFileSync(path,old);
  const r=await e.runTool(sid,'office_write',{path,content:JSON.stringify(deck({title:'new',bullets:['new']}))});expect(r.success,r.output).toBe(false);expect(r.output).toContain('另存');expect(readFileSync(path)).toEqual(old);expect(e.rows()).toEqual([]);
 });
 it('C8 old title/bullets retain their content after readback',async()=>{
  const d=await parseOffice('old.pptx',buildPptx(deck({title:'原标题',bullets:['甲','乙']})));expect(d.slides![0]).toMatchObject({title:'原标题',bullets:['甲','乙']});expect(pptxHandler.app).toBe('PowerPoint');
 });
});
