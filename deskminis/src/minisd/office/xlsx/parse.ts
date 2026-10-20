/** Content readback follows workbook relationships; cached formula results are explicitly identified. */
import {posix} from 'node:path';
import type {OfficeDoc} from '../parse';
import {unesc,textsOf,chunksOf,need} from '../xml';
import {cellPosition,serialDate,fail} from './model';
export interface ReadCell {type:'text'|'number'|'date'|'boolean'|'error'|'blank'|'formula';value?:string|number|boolean;formula?:string;cached?:string|number|boolean;numFmt:string;wrap:boolean;style:number;unsupported?:string}
export interface SheetData {name:string;rows:string[][];cells:ReadCell[][];colWidths:number[];freeze:{rows:number;columns:number};rowHeights:number[]}
const attr=(s:string,k:string)=>{const m=new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(s);return m?unesc(m[1]):undefined;};
function target(path:string):string {
  if(path.includes('\\')||/^[a-z]+:/i.test(path))return fail('工作簿关系不是内部部件');
  const resolved=path.startsWith('/')?path.slice(1):posix.normalize(posix.join('xl',path));
  if(!resolved.startsWith('xl/')||resolved.includes('..'))return fail('工作簿关系越界');return resolved;
}
export function parseXlsx(parts:Map<string,Buffer>):OfficeDoc{
  const wb=need(parts,'xl/workbook.xml','这不像一个Excel工作簿'),rels=need(parts,'xl/_rels/workbook.xml.rels','工作簿关系缺失');
  const relationships=new Map<string,{path:string;type:string}>();
  for(const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?\s*>/g)){
    const id=attr(m[1],'Id'),type=attr(m[1],'Type'),t=attr(m[1],'Target');
    if(id&&type&&t&&attr(m[1],'TargetMode')!=='External')relationships.set(id,{path:target(t),type});
  }
  const find=(type:string)=>[...relationships.values()].find(r=>r.type.endsWith('/'+type))?.path;
  const sharedPath=find('sharedStrings'),stylePath=find('styles');
  const shared=sharedPath?chunksOf(need(parts,sharedPath,'共享字符串缺失'),'si').map(s=>textsOf(s,'t').join('')):[];
  if(shared.length>50000||shared.some(s=>s.length>32767)||shared.reduce((n,s)=>n+s.length,0)>2000000)return fail('共享字符串超过读取上限');
  const styleXml=stylePath?need(parts,stylePath,'样式缺失'):'';
  const formats=new Map<number,string>([[0,'General'],[1,'0'],[2,'0.00'],[9,'0%'],[10,'0.00%'],[14,'mm-dd-yy'],[49,'@']]);
  for(const m of styleXml.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?\s*>/g))formats.set(Number(attr(m[1],'numFmtId')),attr(m[1],'formatCode')??'General');
  const xfs=chunksOf(styleXml,'cellXfs')[0]??'',styles:{numFmt:string;wrap:boolean;date:boolean}[]=[];
  for(const m of xfs.matchAll(/<(?:\w+:)?xf\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?xf>)/g)){
    const id=Number(attr(m[1],'numFmtId')??0),numFmt=formats.get(id)??`[格式${id}]`;
    const stripped=numFmt.replace(/"[^"]*"|\\.|\[[^\]]*\]/g,'');
    styles.push({numFmt,wrap:/\bwrapText="(?:1|true)"/.test(m[2]??''),date:[14,15,16,17].includes(id)||/[yd]/i.test(stripped)});
  }
  const date1904=/<(?:\w+:)?workbookPr\b[^>]*date1904="(?:1|true)"/.test(wb),sheets:SheetData[]=[];let total=0,rectangles=0,characters=0;
  for(const sm of wb.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?\s*>/g)){
    const name=attr(sm[1],'name'),id=attr(sm[1],'r:id'),rel=id?relationships.get(id):undefined;
    if(name===undefined||!rel||!rel.type.endsWith('/worksheet'))return fail('工作表关系缺失或类型错误');
    if(sheets.length>=32)return fail('读取超过32张工作表');
    const xml=need(parts,rel.path,'工作表部件缺失'),rows:string[][]=[],cells:ReadCell[][]=[],rowHeights:number[]=[],colWidths:number[]=[];let maxWidth=0;
    for(const cm of xml.matchAll(/<(?:\w+:)?col\b([^>]*)\/?\s*>/g)){
      const min=Number(attr(cm[1],'min')),max=Number(attr(cm[1],'max')),w=Number(attr(cm[1],'width'));
      if(!Number.isInteger(min)||!Number.isInteger(max)||min<1||max>256||max<min||!Number.isFinite(w))return fail('读取列宽范围超限');
      for(let i=min-1;i<max;i++)colWidths[i]=w;
    }
    for(const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)){
      const n=Number(attr(rm[1],'r')??rows.length+1);if(!Number.isInteger(n)||n<1||n>10000||cells[n-1])return fail('读取行号超限或重复');
      while(rows.length<n){rows.push([]);cells.push([]);} // sparse rows preserve their physical row numbers
      const row:string[]=[],cs:ReadCell[]=[];rowHeights[n-1]=Number(attr(rm[1],'ht')??22);
      for(const cm of (rm[2]??'').matchAll(/<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)){
        const ref=attr(cm[1],'r');if(!ref)return fail('单元格缺少引用');const p=cellPosition(ref);
        if(p.row!==n-1||p.col>=256||cs[p.col])return fail('单元格引用越界或重复');
        maxWidth=Math.max(maxWidth,p.col+1);if(rectangles+n*maxWidth>50000)return fail('读取矩形范围超过50000格');
        total++;if(total>50000)return fail('读取超过50000个单元格');
        const type=attr(cm[1],'t'),inner=cm[2]??'',raw=textsOf(inner,'v')[0],style=Number(attr(cm[1],'s')??0),fmt=styles[style]??{numFmt:'General',wrap:false,date:false};
        if(type!==undefined&&!['n','s','inlineStr','str','b','e','d'].includes(type))return fail('不支持的单元格类型');
        if(!Number.isInteger(style)||style<0||(style!==0&&!styles[style]))return fail('单元格样式不存在');
        const base={numFmt:fmt.numFmt,wrap:fmt.wrap,style};let c:ReadCell;
        const form=/<(?:\w+:)?f\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/.exec(inner);
        const numeric=raw===undefined?undefined:Number(raw);
        if(form){
          const cached=raw===undefined?undefined:type==='b'?raw==='1':type==='str'||type==='e'?raw:numeric;
          c={...base,type:'formula',formula:unesc(form[2]??''),...(cached===undefined?{}:{cached}),...(attr(form[1],'t')?{unsupported:`未展开 ${attr(form[1],'t')} 公式`}:{})};
        }else if(type==='s'){
          if(raw===undefined||!Number.isInteger(numeric)||numeric!<0||numeric!>=shared.length)return fail('共享字符串索引错误');c={...base,type:'text',value:shared[numeric!]};
        }else if(type==='inlineStr'||type==='str')c={...base,type:'text',value:type==='inlineStr'?textsOf(inner,'t').join(''):raw??''};
        else if(type==='b'){if(raw!=='0'&&raw!=='1')return fail('布尔值错误');c={...base,type:'boolean',value:raw==='1'};}
        else if(type==='e')c={...base,type:'error',value:raw??''};
        else if(type==='d')c={...base,type:'date',value:raw??''};
        else if(raw===undefined)c={...base,type:'blank'};
        else {if(!Number.isFinite(numeric))return fail('数值单元格无效');const date=fmt.date?serialDate(numeric!,date1904):undefined;c=date?{...base,type:'date',value:date}:{...base,type:'number',value:numeric!,...(fmt.date?{unsupported:'日期序列含时间或伪1900-02-29，保留原数值'}:{})};}
        while(cs.length<p.col){cs.push({type:'blank',...base});row.push('');}cs[p.col]=c;
        characters+=typeof c.value==='string'?c.value.length:c.formula?.length??0;if(characters>2000000)return fail('读取文字和公式超过200万字符');
        row[p.col]=c.type==='formula'?`=${c.formula}${c.cached===undefined?' [未计算]':` [缓存：${c.cached}]`}`:c.value===undefined?'':String(c.value);
      }
      rows[n-1]=row;cells[n-1]=cs;
    }
    const pane=/<(?:\w+:)?pane\b([^>]*)/.exec(xml)?.[1]??'',frozen=/\bstate="frozen(?:Split)?"/.test(pane);
    const freeze={rows:frozen?Number(attr(pane,'ySplit')??0):0,columns:frozen?Number(attr(pane,'xSplit')??0):0};
    if(!Number.isInteger(freeze.rows)||freeze.rows<0||freeze.rows>10000||!Number.isInteger(freeze.columns)||freeze.columns<0||freeze.columns>256)return fail('读取冻结范围错误');
    rectangles+=rows.length*maxWidth;if(rectangles>50000)return fail('读取矩形范围超过50000格');
    sheets.push({name,rows,cells,colWidths,freeze,rowHeights});
  }
  if(!sheets.length)return fail('工作簿没有可读取的工作表');
  return {kind:'xlsx',blocks:[],sheets};
}
