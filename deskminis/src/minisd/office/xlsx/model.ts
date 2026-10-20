/** Bounded, explicit spreadsheet input. Plain strings never become executable formulas. */
import {OfficeInputError} from '../format';
import {cleanXmlText} from '../xml';
import {checkFormulas} from './formula';

export const FORMATS = ['General','0','0.00','#,##0.00','¥#,##0.00','0%','0.00%','yyyy-mm-dd','@'] as const;
export type NumberFormat = typeof FORMATS[number];
export type CellType = 'text'|'number'|'date'|'boolean'|'formula'|'error'|'blank';
export interface XlsxCell {type: CellType; value?: string|number|boolean; formula?: string; numFmt?: NumberFormat; wrap?: boolean}
export type CellInput = string|number|boolean|null|XlsxCell;
export interface XlsxSheet {name: string; rows: readonly (readonly CellInput[])[]; colWidths?: readonly number[]; headerRows?: number; freeze?: {rows?: number; columns?: number}}
export interface XlsxInput {sheets: readonly XlsxSheet[]}
export interface Cell {type: CellType; value?: string|number|boolean; formula?: string; numFmt: NumberFormat; wrap: boolean}
export interface Sheet {name: string; rows: Cell[][]; colWidths: number[]; headerRows: number; freeze: {rows: number; columns: number}}
export interface Workbook {sheets: Sheet[]}
export const fail = (message: string): never => {throw new OfficeInputError(message);};
export function object(value: unknown, label: string): Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value)) return fail(`${label}必须是对象`);
  return value as Record<string,unknown>;
}
export function only(o: Record<string,unknown>, keys: readonly string[], label: string): void {
  const unknown=Object.keys(o).filter(k=>!keys.includes(k));
  if(unknown.length) fail(`${label}含不支持的字段：${unknown.join('、')}`);
}
export function colName(i: number): string {let s='';for(let n=i+1;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
export function cellPosition(ref: string): {row: number; col: number} {
  const m=/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(ref); if(!m) return fail(`不支持的单元格引用 ${ref}`);
  let col=0;for(const c of m[1].toUpperCase())col=col*26+c.charCodeAt(0)-64;
  return {row:Number(m[2])-1,col:col-1};
}
const DAY=86400000,BASE=Date.UTC(1899,11,31),LEAP=Date.UTC(1900,2,1);
export function dateSerial(value: string): number {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'9999-12-31')return fail('日期必须是真实的 YYYY-MM-DD（1900-01-01 至 9999-12-31）');
  const ms=Date.parse(value+'T00:00:00.000Z');
  if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==value)return fail(`非法日期 ${value}`);
  return (ms-BASE)/DAY+(ms>=LEAP?1:0);
}
export function serialDate(serial: number,date1904=false): string|undefined {
  if(!Number.isFinite(serial)||!Number.isInteger(serial)||(!date1904&&serial===60))return undefined;
  const ms=date1904?Date.UTC(1904,0,1)+serial*DAY:BASE+(serial-(serial>60?1:0))*DAY;
  try{return new Date(ms).toISOString().slice(0,10);}catch{return undefined;}
}
function text(value: unknown,label: string): string {
  if(typeof value!=='string')return fail(`${label}必须是字符串`);
  if(value.length>32767)return fail(`${label}超过32767字符`);
  const cleaned=cleanXmlText(value);if(cleaned.removed)return fail(`${label}含XML不允许的字符`);
  return cleaned.text;
}
function integer(value: unknown,min: number,max: number,label: string): number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)return fail(`${label}必须是${min}至${max}的整数`);return value;
}
function cell(input: unknown): Cell {
  let o: Record<string,unknown>;
  if(input===null)o={type:'blank'};
  else if(typeof input==='string')o={type:'text',value:input};
  else if(typeof input==='number')o={type:'number',value:input};
  else if(typeof input==='boolean')o={type:'boolean',value:input};
  else o=object(input,'单元格');
  only(o,['type','value','formula','numFmt','wrap'],'单元格');
  if(!['text','number','date','boolean','formula','error','blank'].includes(String(o.type)))return fail(`不支持的单元格类型 ${String(o.type)}`);
  const type=o.type as CellType;
  const numFmt=o.numFmt??(type==='date'?'yyyy-mm-dd':type==='text'?'@':'General');
  if(!FORMATS.includes(numFmt as NumberFormat))return fail('不支持的数值格式');
  if((type==='date'&&numFmt!=='yyyy-mm-dd')||(type!=='date'&&numFmt==='yyyy-mm-dd')||(type==='text'&&numFmt!=='@')||(type!=='text'&&numFmt==='@'))return fail('日期或文本格式与单元格类型不一致');
  if(o.wrap!==undefined&&typeof o.wrap!=='boolean')return fail('wrap必须是布尔值');
  const c:Cell={type,numFmt:numFmt as NumberFormat,wrap:o.wrap!==false};
  if(type==='formula') {
    if(o.value!==undefined)return fail('公式不接受缓存value；结果尚未计算');
    c.formula=text(o.formula,'公式').trim().replace(/^=/,'');
    if(!c.formula||c.formula.length>8192)return fail('公式不能为空或超过8192字符');
  }else{
    if(o.formula!==undefined)return fail('只有formula类型可以写formula字段');
    if(type==='blank'){if(o.value!==undefined)return fail('blank不能带value');}
    else if(type==='number'){if(typeof o.value!=='number'||!Number.isFinite(o.value))return fail('数值必须是有限数字');c.value=o.value;}
    else if(type==='boolean'){if(typeof o.value!=='boolean')return fail('布尔单元格必须带布尔value');c.value=o.value;}
    else {
      c.value=text(o.value,'单元格文字');
      if(type==='date')dateSerial(c.value);
      if(type==='error'&&!['#NULL!','#DIV/0!','#VALUE!','#REF!','#NAME?','#NUM!','#N/A'].includes(c.value))return fail('不支持的错误值');
    }
  }
  return c;
}
export function displayUnits(s: string): number {return Array.from(s).reduce((n,c)=>n+(c.codePointAt(0)!>255?2:1),0);}
export function normalizeXlsx(input: unknown): Workbook {
  const spec=object(input,'工作簿');only(spec,['sheets'],'工作簿');
  if(!Array.isArray(spec.sheets)||spec.sheets.length<1||spec.sheets.length>32)return fail('工作簿必须有1至32张工作表');
  const names=new Set<string>();let count=0,characters=0;
  const sheets=spec.sheets.map(raw=>{
    const s=object(raw,'工作表');only(s,['name','rows','colWidths','headerRows','freeze'],'工作表');
    const name=text(s.name,'工作表名');
    if(!name.trim()||name.length>31||/[\\/*?:\[\]]/.test(name)||name.startsWith("'")||name.endsWith("'"))return fail(`非法工作表名 ${name}`);
    const key=name.toLowerCase();if(names.has(key))return fail(`重复工作表名 ${name}`);names.add(key);
    if(!Array.isArray(s.rows)||s.rows.length>10000)return fail('工作表rows必须是数组，最多10000行');
    let width=0;
    for(const r of s.rows){if(!Array.isArray(r)||r.length>256)return fail('每行必须是数组，最多256列');width=Math.max(width,r.length);}
    count+=width*s.rows.length;if(count>50000)return fail('工作簿超过50000个矩形单元格');
    const rows=(s.rows as unknown[][]).map(r=>r.map(v=>{
      const c=cell(v);characters+=typeof c.value==='string'?c.value.length:c.formula?.length??0;
      if(characters>2000000)return fail('工作簿文字和公式超过200万字符');return c;
    }));
    const headerRows=s.headerRows===undefined?Math.min(1,rows.length):integer(s.headerRows,0,Math.min(10,rows.length),'headerRows');
    let colWidths:number[];
    if(s.colWidths===undefined)colWidths=Array.from({length:width},(_,col)=>{
      const largest=rows.reduce((n,r)=>Math.max(n,displayUnits(String(r[col]?.value??''))),0);
      return Math.max(8,Math.min(36,largest+2));
    });
    else {if(!Array.isArray(s.colWidths)||s.colWidths.length!==width)return fail('colWidths必须为每列提供宽度');colWidths=s.colWidths.map(v=>{if(typeof v!=='number'||!Number.isFinite(v)||v<6||v>60)return fail('列宽必须为6至60');return v;});}
    const f=s.freeze===undefined?{}:object(s.freeze,'freeze');only(f,['rows','columns'],'freeze');
    const freeze={rows:f.rows===undefined?headerRows:integer(f.rows,0,rows.length,'冻结行数'),columns:f.columns===undefined?0:integer(f.columns,0,width,'冻结列数')};
    return {name,rows,colWidths,headerRows,freeze};
  });
  const model={sheets};checkFormulas(model);return model;
}
