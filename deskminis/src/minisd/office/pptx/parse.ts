/** Relationship-ordered preview with explicit image/table footprint. No rendered-layout claim. */
import {posix} from 'node:path';
import {createHash} from 'node:crypto';
import type {OfficeDoc} from '../parse';
import {need,unesc,chunksOf,attrOf} from '../xml';
export interface ReadElement {kind:'text'|'table'|'image';name:string;x:number;y:number;w:number;h:number;paras?:string[];fonts?:number[];fontNames?:string[];styleFonts?:number[];styleFontNames?:string[];bolds?:boolean[];colors?:string[];rows?:string[][];widths?:number[];heights?:number[];sha256?:string;alt?:string;path?:string;noAutofit?:boolean}
export interface SlideData {title:string;bullets:string[];elements?:ReadElement[]}
export interface Relationship {id:string;type:string;target:string}
const fail=(s:string):never=>{throw new Error(`PowerPoint读取失败：${s}`);};
export const attr=(s:string,key:string):string|undefined=>{const m=new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(s);return m?unesc(m[1]):undefined;};
export function relationships(parts:Map<string,Buffer>,base:string):Relationship[]{
  const file=posix.join(posix.dirname(base),'_rels',posix.basename(base)+'.rels'),xml=need(parts,file,'PowerPoint关系');
  const seen=new Set<string>(),out:Relationship[]=[];
  for(const m of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/g)){
    const id=attr(m[1],'Id'),type=attr(m[1],'Type'),target=attr(m[1],'Target');
    if(!id||!type||!target||seen.has(id))return fail('关系缺少字段或Id重复');seen.add(id);
    if(attr(m[1],'TargetMode')==='External')continue;
    if(/[\\%#?]/.test(target)||target.startsWith('//')||/^[a-z][a-z0-9+.-]*:/i.test(target))return fail('关系目标不支持');
    const path=target.startsWith('/')?target.slice(1):posix.normalize(posix.join(posix.dirname(base),target));
    if(path.startsWith('../')||!parts.has(path))return fail(`关系目标缺失或越界：${path}`);out.push({id,type,target:path});
  }return out;
}
function paragraphs(xml:string):string[]{
  return chunksOf(xml,'p').map(p=>{let out='';for(const m of p.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?br\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?br>)/g))out+=m[1]===undefined?'\n':unesc(m[1]);return out;});
}
function box(xml:string){
  const transform=chunksOf(xml,'xfrm')[0];if(!transform)return {x:0,y:0,w:0,h:0};
  const nums=['x','y','cx','cy'].map((key,i)=>Number(attrOf(transform,i<2?'off':'ext',key))/12700);
  if(nums.some(n=>!Number.isFinite(n)))return fail('形状坐标错误');return {x:nums[0],y:nums[1],w:nums[2],h:nums[3]};
}
const fonts=(xml:string)=>[...xml.matchAll(/<(?:\w+:)?rPr\b[^>]*\bsz="(\d+)"/g)].map(m=>Number(m[1])/100);
function runStyles(xml:string){const runs=[...xml.matchAll(/<(?:\w+:)?rPr\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?rPr>/g)],all=[...xml.matchAll(/<(?:\w+:)?(rPr|defRPr|endParaRPr)\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?\1>/g)];return {fontNames:runs.map(m=>unesc(attrOf(m[2],'latin','typeface')??'')),styleFonts:all.map(m=>Number(attr(m[2],'sz'))/100),styleFontNames:all.map(m=>unesc(attrOf(m[3],'latin','typeface')??'')),bolds:runs.map(m=>attr(m[1],'b')==='1'),colors:runs.map(m=>attrOf(m[2],'srgbClr','val')??'')};}
export function parsePptx(parts:Map<string,Buffer>):OfficeDoc{
  const pres=need(parts,'ppt/presentation.xml','PowerPoint'),rels=relationships(parts,'ppt/presentation.xml'),ids=[...pres.matchAll(/<(?:\w+:)?sldId\b([^>]*)\/?\s*>/g)];
  if(!ids.length||ids.length>50)return fail('只能预览1至50页演示');const slides:SlideData[]=[],omitted:string[]=[];let chars=0,objects=0,images=0;
  for(const [i,m]of ids.entries()){
    const id=attr(m[1],'r:id'),relationship=rels.find(r=>r.id===id&&r.type.endsWith('/slide'));if(!relationship)return fail('幻灯片Id没有匹配的slide关系');
    const xml=need(parts,relationship.target,'PowerPoint页'),srels=relationships(parts,relationship.target),elements:ReadElement[]=[];
    for(const sp of chunksOf(xml,'sp')){
      const paras=paragraphs(sp),name=attrOf(sp,'cNvPr','name')??'';elements.push({kind:'text',name,...box(sp),paras,fonts:fonts(sp),...runStyles(sp),noAutofit:/<(?:\w+:)?noAutofit\s*\/>/.test(sp)});
    }
    for(const frame of chunksOf(xml,'graphicFrame')){
      const tbl=chunksOf(frame,'tbl')[0];if(!tbl){omitted.push(`第${i+1}页的图表或其它图形数据未提取`);continue;}
      if(attrOf(frame,'graphicData','uri')!=='http://schemas.openxmlformats.org/drawingml/2006/table')return fail('表格图形数据URI错误');
      const rows=chunksOf(tbl,'tr').map(row=>chunksOf(row,'tc').map(cell=>paragraphs(cell).join('\n')));
      if(rows.length>100||rows.some(r=>r.length>100))return fail('表格超过预览范围');
      elements.push({kind:'table',name:attrOf(frame,'cNvPr','name')??'',...box(frame),rows,fonts:fonts(frame),...runStyles(frame),widths:[...tbl.matchAll(/<(?:\w+:)?gridCol\b[^>]*\bw="(\d+)"/g)].map(m=>Number(m[1])/12700),heights:[...tbl.matchAll(/<(?:\w+:)?tr\b[^>]*\bh="(\d+)"/g)].map(m=>Number(m[1])/12700),noAutofit:/<(?:\w+:)?noAutofit\s*\/>/.test(frame)});
    }
    for(const pic of chunksOf(xml,'pic')){
      const rid=attrOf(pic,'blip','embed'),r=srels.find(r=>r.id===rid&&r.type.endsWith('/image'));
      if(!r){omitted.push(`第${i+1}页有未提取的外部或不支持图片`);continue;}
      const b=parts.get(r.target)!;images+=b.length;if(images>32*1024*1024)return fail('媒体超过32MiB');
      elements.push({kind:'image',name:attrOf(pic,'cNvPr','name')??'',alt:unesc(attrOf(pic,'cNvPr','descr')??''),...box(pic),path:r.target,sha256:createHash('sha256').update(b).digest('hex')});
    }
    objects+=elements.length;if(objects>1000)return fail('形状超过1000个');
    const text=elements.filter(e=>e.kind==='text'&&!(e.name==='PageNumber'&&e.paras?.join('')===String(i+1)&&e.y>=500&&e.fonts?.every(f=>f<=12))).flatMap(e=>e.paras??[]);
    chars+=elements.reduce((n,e)=>n+(e.paras??e.rows?.flat()??[]).join('').length,0);if(chars>100000)return fail('预览文字超过10万字符');
    slides.push({title:text[0]??'',bullets:text.slice(1),elements});
    if(/<(?:\w+:)?(?:timing|transition)\b/.test(xml))omitted.push(`第${i+1}页的动画或转场未提取`);
  }
  omitted.push('此预览只提取文字、表格单元格和图片信息，母版背景、图片内容、动画及最终版式未还原');
  return {kind:'pptx',blocks:[],slides,omitted};
}
