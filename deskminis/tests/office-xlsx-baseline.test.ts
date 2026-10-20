/** F10B replaces the explicitly owned F10A byte baseline with the new format contract. */
import {afterEach,describe,it,expect} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildXlsx} from '../src/minisd/office/xlsx/build';
import {xlsxHandler} from '../src/minisd/office/xlsx/handler';
import {readZip,writeZip} from '../src/minisd/office/zip';
import {parseOffice} from '../src/minisd/office/parse';
import {normalizeXlsx} from '../src/minisd/office/xlsx/model';
import {verifyXlsxContent} from '../src/minisd/office/xlsx/content-check';
import {createHash} from 'node:crypto';
import {cpEnv,closeAllCpEnvs} from './checkpoint-fixture';
afterEach(closeAllCpEnvs);
const spec=(rows:any[][],extra={})=>({sheets:[{name:'A&B <1>',rows,...extra}]});
const subject=(b:Buffer)=>({sha256:createHash('sha256').update(b).digest('hex'),size:b.length});
const replace=(parts:Map<string,Buffer>,name:string,from:string,to:string)=>{const old=parts.get(name)!.toString();expect(old).toContain(from);parts.set(name,Buffer.from(old.replace(from,to)));return writeZip([...parts].map(([path,data])=>({path,data})));};
describe('F10B workbook contract and real byte verification',()=>{
 it('X1 legacy rows remain deterministic and legal special sheet names round trip',async()=>{
  const input=spec([['月份','销量'],['一月',120],['二月',98.5],[],['','右侧']]);
  const b=buildXlsx(input);expect(b.equals(buildXlsx(input))).toBe(true);const doc=await parseOffice('a.xlsx',b);
  expect(doc.sheets![0].name).toBe('A&B <1>');expect(doc.sheets![0].rows).toEqual([['月份','销量'],['一月','120'],['二月','98.5'],[],['','右侧']]);
  expect(xlsxHandler.refuseOverwrite!(b,'a.xlsx')).toBeUndefined();expect((await xlsxHandler.plan(input).verifyContent!(subject(b))).status).toBe('verified');
 });
 it('X2 explicit widths, header, freeze and number formatting decode from actual OOXML',async()=>{
  const input=spec([['金额','比例'],[{type:'number',value:1234.5,numFmt:'¥#,##0.00',wrap:false},{type:'number',value:.125,numFmt:'0.00%'}]],{colWidths:[20,16],headerRows:1,freeze:{rows:1,columns:1}});
  const b=buildXlsx(input),s=(await parseOffice('x.xlsx',b)).sheets![0];expect(s.colWidths).toEqual([20,16]);expect(s.freeze).toEqual({rows:1,columns:1});
  expect(s.cells[1]).toMatchObject([{type:'number',value:1234.5,numFmt:'¥#,##0.00',wrap:false},{type:'number',value:.125,numFmt:'0.00%',wrap:true}]);
  expect(s.cells[0].every(c=>c.style>=18)).toBe(true);expect(s.cells[1].every(c=>c.style<18)).toBe(true);
 });
 it('X3 self-produced overwrite follows F08 and restores the exact prior workbook',async()=>{
  const e=cpEnv('f10b-own'),sid=e.newSession(),path=join(e.userDir,'own.xlsx'),old=buildXlsx(spec([['old',1]]));writeFileSync(path,old);
  const r=await e.runTool(sid,'office_write',{path,content:JSON.stringify(spec([['new',2]]))});expect(r.success,r.output).toBe(true);expect(r.output).toContain('内容核验：通过');expect(r.output).toContain('版式核验：未核验');
  expect(e.rows()).toHaveLength(1);expect(readFileSync(path)).not.toEqual(old);await e.service.restore(sid,[e.rows()[0].id]);expect(readFileSync(path)).toEqual(old);
 });
 it('X4 marker and original manifest cannot authorize replacing edited values or added chart parts',async()=>{
  const p=await readZip(buildXlsx(spec([['original',1]])));const edited=replace(p,'xl/worksheets/sheet1.xml','<v>1</v>','<v>2</v>');
  expect(xlsxHandler.refuseOverwrite!(edited,'edited.xlsx')).toContain('另存');p.set('xl/charts/chart1.xml',Buffer.from('<chart/>'));
  expect(xlsxHandler.refuseOverwrite!(writeZip([...p].map(([path,data])=>({path,data}))),'chart.xlsx')).toContain('另存');
 });
 it('X5 verifier detects mutated actual values and incorrect subject identity',async()=>{
  const input=spec([[123]]),b=buildXlsx(input),p=await readZip(b),edited=replace(p,'xl/worksheets/sheet1.xml','<v>123</v>','<v>124</v>');
  const bad=await verifyXlsxContent(edited,normalizeXlsx(input),subject(edited));expect(bad.status).toBe('failed');expect(bad.checks?.some(c=>c.id==='A&B <1>!A1'&&!c.ok)).toBe(true);
  expect((await verifyXlsxContent(b,normalizeXlsx(input),subject(edited))).status).toBe('failed');
 });
 it('X6 reader follows changed relationships instead of guessing sheetN and preserves sparse physical rows',async()=>{
  const p=await readZip(buildXlsx(spec([['header'],['value']]))),sheet=p.get('xl/worksheets/sheet1.xml')!.toString().replace('r="2"','r="4"').replace('r="A2"','r="C4"');
  p.delete('xl/worksheets/sheet1.xml');p.set('xl/worksheets/custom.xml',Buffer.from(sheet));
  replace(p,'xl/_rels/workbook.xml.rels','worksheets/sheet1.xml','worksheets/custom.xml');
  const s=(await parseOffice('x.xlsx',writeZip([...p].map(([path,data])=>({path,data}))))).sheets![0];expect(s.rows).toEqual([['header'],[],[],['','','value']]);expect(s.cells[3][2].value).toBe('value');
 });
 it('X7 cached and shared formulas are read with explicit uncertainty, never reported as recalculated',async()=>{
  const p=await readZip(buildXlsx(spec([[{type:'formula',formula:'1+2'}]])));
  const b=replace(p,'xl/worksheets/sheet1.xml','<f>1+2</f>','<f t="shared" si="0">1+2</f><v>3</v>');const doc=await parseOffice('cached.xlsx',b);
  expect(doc.sheets![0].cells[0][0]).toMatchObject({type:'formula',formula:'1+2',cached:3,unsupported:'未展开 shared 公式'});expect(doc.sheets![0].rows[0][0]).toContain('缓存');expect(xlsxHandler.readNote!(doc)).toContain('未重新计算');
 });
 it.each(['A1','B1','SUM(A1:B1)'])('X8 direct and range cycles reject before any workbook exists: %s',formula=>{
  expect(()=>buildXlsx(spec([[{type:'formula',formula},{type:'formula',formula:'A1'}]]))).toThrow(/循环/);
 });
 it.each(['[other.xlsx]Sheet1!A1',"'C:\\other.xlsx'!A1",'WEBSERVICE("https://example.com")','HYPERLINK("https://example.com")',"cmd|'/C calc'!A1",'UnknownName','SUM(A1:ZZ10000)','ABS(1,2)','IF(1)','1+','SUM()','1e999'])('X9 unsupported formulas fail clearly: %s',formula=>{
  expect(()=>buildXlsx(spec([[{type:'formula',formula}]]))).toThrow();
 });
 it('X10 supported formulas across existing sheets and explicit error-producing formula remain uncomputed',async()=>{
  const b=buildXlsx({sheets:[{name:'数据',rows:[[2,3]]},{name:'预算',rows:[[{type:'formula',formula:"ROUND(SUM('数据'!$A$1:$B$1)*0.1,2)"},{type:'formula',formula:'IF(1<2,ABS(-3),0)'},{type:'formula',formula:'1/0'}]]}]});
  const d=await parseOffice('x.xlsx',b);expect(d.sheets![1].cells[0].map(c=>c.cached)).toEqual([undefined,undefined,undefined]);
 });
 it.each([{sheets:[]},{sheets:[{name:'a',rows:[]},{name:'A',rows:[]}]},spec([[{type:'date',value:'1900-02-29'}]]),spec([[{type:'date',value:'2026-02-30'}]]),spec([[{type:'formula',formula:'1',value:1}]]),spec([[{type:'wat',value:'x'}]]),spec([[undefined]]),spec([['\u0000']]),spec([['x']],{colWidths:[61]}),spec([['x']],{freeze:{rows:2}}),spec(Array.from({length:201},()=>Array(256).fill(null)))])('X11 invalid or excessive inputs reject: %#',input=>{expect(()=>buildXlsx(input as any)).toThrow();});
 it('X12 empty sheet is a valid single-sheet package',async()=>{const b=buildXlsx({sheets:[{name:'空表',rows:[]}]});expect((await parseOffice('empty.xlsx',b)).sheets![0].rows).toEqual([]);});
 it('X13 sparse expansion and unknown cell types reject before returning misleading text',async()=>{
  const p=await readZip(buildXlsx(spec([[123]])));let b=replace(p,'xl/worksheets/sheet1.xml','r="1"','r="10000"');
  b=replace(p,'xl/worksheets/sheet1.xml','r="A1"','r="IV10000"');await expect(parseOffice('huge.xlsx',b)).rejects.toThrow(/矩形/);
  const p2=await readZip(buildXlsx(spec([[123]]))),invalid=replace(p2,'xl/worksheets/sheet1.xml','r="A1"','r="A1" t="mystery"');await expect(parseOffice('type.xlsx',invalid)).rejects.toThrow(/类型/);
 });
 it('X14 external 1904 dates use their declared epoch; pseudo-1900 serial retains an explicit uncertainty',async()=>{
  const p=await readZip(buildXlsx(spec([[{type:'date',value:'1900-01-01'}]])));
  const b=replace(p,'xl/workbook.xml','date1904="0"','date1904="1"');expect((await parseOffice('1904.xlsx',b)).sheets![0].cells[0][0].value).toBe('1904-01-02');
  const p2=await readZip(buildXlsx(spec([[{type:'date',value:'1900-02-28'}]]))),bad=replace(p2,'xl/worksheets/sheet1.xml','<v>59</v>','<v>60</v>');expect((await parseOffice('pseudo.xlsx',bad)).sheets![0].cells[0][0]).toMatchObject({type:'number',value:60,unsupported:expect.stringContaining('伪1900-02-29')});
 });
 it('X15 invalid formulas never create a file or checkpoint through the real office_write path',async()=>{
  const e=cpEnv('f10b-invalid-tool'),sid=e.newSession(),path=join(e.userDir,'invalid.xlsx');
  const r=await e.runTool(sid,'office_write',{path,content:JSON.stringify(spec([[{type:'formula',formula:'A1'}]]))});expect(r.success,r.output).toBe(false);expect(r.output).toContain('循环');expect(()=>readFileSync(path)).toThrow();expect(e.rows()).toEqual([]);
 });
 it.each(['fontId="1" fillId="2"','borderId="1"','applyFont="1"'])('X17 styles must be actually referenced and applied: %s',original=>{
  return (async()=>{const input=spec([['表头'],['正文']]),p=await readZip(buildXlsx(input)),b=replace(p,'xl/styles.xml',original,original.replace(/="[12]"/g,'="0"'));const v=await verifyXlsxContent(b,normalizeXlsx(input),subject(b));expect(v.status).toBe('failed');expect(v.checks!.some(c=>c.id==='actual-style-references'&&!c.ok)).toBe(true);})();
 });
 it.each([['font','<sz val="11"/>','<sz val="8"/>'],['fill','fgColor rgb="FF234B73"','fgColor rgb="FF000000"'],['border','<left style="thin">','<left style="none">']])('X18 actual %s definitions must match the basic style contract',async(_,from,to)=>{
  const input=spec([['表头'],['正文']]),p=await readZip(buildXlsx(input)),b=replace(p,'xl/styles.xml',from,to);expect((await verifyXlsxContent(b,normalizeXlsx(input),subject(b))).status).toBe('failed');
 });
 it('X16 text budget prevents highly compressible oversized input; invalid relationships cannot guess another sheet',async()=>{
  expect(()=>buildXlsx(spec([Array(70).fill({type:'text',value:'a'.repeat(32767),wrap:false})]))).toThrow(/200万/);
  const p=await readZip(buildXlsx(spec([[1]]))),b=replace(p,'xl/_rels/workbook.xml.rels','worksheets/sheet1.xml','../foreign.xml');await expect(parseOffice('relation.xlsx',b)).rejects.toThrow(/越界/);
 });
});
