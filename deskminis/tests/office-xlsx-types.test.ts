import {afterEach,describe,expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildXlsx} from '../src/minisd/office/xlsx/build';
import {xlsxHandler} from '../src/minisd/office/xlsx/handler';
import {parseOffice} from '../src/minisd/office/parse';
import {readZip} from '../src/minisd/office/zip';
import {cpEnv,closeAllCpEnvs} from './checkpoint-fixture';
afterEach(closeAllCpEnvs);
const book=(rows:unknown[][],extra={})=>({sheets:[{name:'预算',rows,...extra}]} as any);
describe('F10B concrete type and overwrite behavior',()=>{
 it('B1 literal equals/leading zeros and explicit formula remain distinct in real OOXML and readback',async()=>{
  const bytes=buildXlsx(book([['00123','=SUM(A1:A2)',{type:'formula',formula:'SUM(D1:D2)'},2],[null,null,null,3]]));
  const parts=await readZip(bytes),sheet=parts.get('xl/worksheets/sheet1.xml')!.toString('utf8');
  expect(sheet).toContain('<f>SUM(D1:D2)</f>');expect(sheet).not.toContain('<v>5</v>');
  const doc=await parseOffice('budget.xlsx',bytes),cells=(doc.sheets![0] as any).cells;
  expect(cells[0].slice(0,4)).toMatchObject([{type:'text',value:'00123'},{type:'text',value:'=SUM(A1:A2)'},{type:'formula',formula:'SUM(D1:D2)'},{type:'number',value:2}]);
  expect(cells[0][2].cached).toBeUndefined();
 });
 it('B2 boolean/date/error write valid typed values, including 1900 leap compatibility boundaries',async()=>{
  const bytes=buildXlsx(book([[true,{type:'date',value:'1900-01-01'},{type:'date',value:'1900-02-28'},{type:'date',value:'1900-03-01'},{type:'error',value:'#DIV/0!'}]]));
  const p=await readZip(bytes),xml=p.get('xl/worksheets/sheet1.xml')!.toString('utf8');
  expect(xml).toMatch(/t="b"[^>]*><v>1<\/v>/);expect(xml).toContain('<v>59</v>');expect(xml).toContain('<v>61</v>');
  const cells=((await parseOffice('x.xlsx',bytes)).sheets![0] as any).cells[0];
  expect(cells.map((c:any)=>c.value)).toEqual([true,'1900-01-01','1900-02-28','1900-03-01','#DIV/0!']);
  expect(cells.map((c:any)=>c.type)).toEqual(['boolean','date','date','date','error']);
 });
 it.each([NaN,Infinity,-Infinity])('B3 invalid numeric %s never becomes a hidden string',value=>{
  expect(()=>buildXlsx(book([[value]]))).toThrow(/数值|有限/);
 });
 it.each(['bad/name','a'.repeat(32),"'bad",'   '])('B4 invalid sheet name %s cannot create a broken workbook',name=>{
  expect(()=>buildXlsx({sheets:[{name,rows:[['x']]}]})).toThrow(/表名|工作表/);
 });
 it('B5 foreign workbook cannot be replaced or leave a fake checkpoint',async()=>{
  const e=cpEnv('f10b-protect'),sid=e.newSession(),path=join(e.userDir,'foreign.xlsx'),original=Buffer.from('original foreign bytes');
  writeFileSync(path,original);const result=await e.runTool(sid,'office_write',{path,content:JSON.stringify(book([['new',1]]))});
  expect(result.success,result.output).toBe(false);expect(result.output).toMatch(/另存|不能.*覆盖|没有覆盖/);
  expect(readFileSync(path)).toEqual(original);expect(e.rows()).toEqual([]);
 });
 it('B6 formula computation is explicitly unverified in the generator plan',()=>{
  const p=xlsxHandler.plan(book([[{type:'formula',formula:'1/0'}]]));expect(p.notes.join('\n')).toMatch(/公式.*未.*计算|公式.*尚未计算/);
 });
});
