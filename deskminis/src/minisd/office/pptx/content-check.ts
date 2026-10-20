/** Decode the actual package and compare editable objects; manifest alone is never evidence. */
import {createHash} from 'node:crypto';
import {readZip} from '../zip';
import {checkWellFormed,attrOf} from '../xml';
import {officeFailed,officeVerified,type OfficeCheckItem,type OfficeSubject,type OfficeVerification} from '../../../shared/office-verification';
import type {Deck} from './model';
import {compileSlide,PAGE,type Element} from './layout';
import {parsePptx,relationships,type ReadElement} from './parse';
const rounded=(n:number)=>Math.round(n*12700);
function wanted(e:Element){const count=e.kind==='text'?e.paras.reduce((n,p)=>n+p.split('\n').length,0):e.kind==='table'?e.rows.flat().reduce((n,p)=>n+p.split('\n').length,0):0,styleCount=count+2*(e.kind==='text'?e.paras.length:e.kind==='table'?e.rows.flat().length:0);return {kind:e.kind,name:e.name,box:[e.x,e.y,e.w,e.h].map(rounded),
  ...(e.kind==='text'?{paras:e.paras,fonts:Array(e.paras.reduce((n,p)=>n+p.split('\n').length,0)).fill(e.font),noAutofit:true}:{}),
  ...(e.kind==='table'?{rows:e.rows,widths:e.widths.map(rounded),heights:e.heights.map(rounded),fonts:Array(e.rows.flat().reduce((n,p)=>n+p.split('\n').length,0)).fill(e.font),noAutofit:true}:{}),
  ...(e.kind==='image'?{sha256:e.asset.sha256,alt:e.alt}:{fontNames:Array(count).fill('微软雅黑'),styleFonts:Array(styleCount).fill(e.font),styleFontNames:Array(styleCount).fill('微软雅黑'),bolds:e.kind==='text'?Array(count).fill(e.bold):e.rows.flatMap((row,r)=>row.flatMap(p=>Array(p.split('\n').length).fill(r===0))),colors:e.kind==='text'?Array(count).fill(e.color):e.rows.flatMap((row,r)=>row.flatMap(p=>Array(p.split('\n').length).fill(r===0?'FFFFFF':'263746')))}),};}
function got(e:ReadElement){return {kind:e.kind,name:e.name,box:[e.x,e.y,e.w,e.h].map(rounded),
  ...(e.kind==='text'?{paras:e.paras,fonts:e.fonts,noAutofit:e.noAutofit}:{}),
  ...(e.kind==='table'?{rows:e.rows,widths:e.widths?.map(rounded),heights:e.heights?.map(rounded),fonts:e.fonts,noAutofit:e.noAutofit}:{}),
  ...(e.kind==='image'?{sha256:e.sha256,alt:e.alt}:{fontNames:e.fontNames,styleFonts:e.styleFonts,styleFontNames:e.styleFontNames,bolds:e.bolds,colors:e.colors}),};}
export async function verifyPptxContent(bytes:Buffer,deck:Deck,subject:OfficeSubject):Promise<OfficeVerification>{
  const engine={id:'deskminis-readback' as const,version:'1'},checks:OfficeCheckItem[]=[];
  const check=(id:string,expected:unknown,actual:unknown)=>checks.push({id,ok:JSON.stringify(expected)===JSON.stringify(actual),expected:JSON.stringify(expected),actual:JSON.stringify(actual)});
  check('subject',subject,{sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
  try{
    const parts=await readZip(bytes);for(const [path,b]of parts)if(path.endsWith('.xml')||path.endsWith('.rels'))check('xml:'+path,null,checkWellFormed(b.toString('utf8')));
    const pres=parts.get('ppt/presentation.xml')?.toString('utf8')??'';
    check('page-size',[PAGE.width,PAGE.height].map(rounded),[Number(attrOf(pres,'sldSz','cx')),Number(attrOf(pres,'sldSz','cy'))]);
    const masters=relationships(parts,'ppt/presentation.xml').filter(r=>r.type.endsWith('/slideMaster'));check('master-count',1,masters.length);
    if(masters[0]){
      check('presentation-master-reference',masters[0].id,attrOf(pres,'sldMasterId','id')===undefined?undefined:attrOf(pres,'sldMasterId','r:id'));
      const master=parts.get(masters[0].target)?.toString()??'',mr=relationships(parts,masters[0].target),layout=mr.find(r=>r.type.endsWith('/slideLayout')),theme=mr.find(r=>r.type.endsWith('/theme'));
      check('master-layout-theme',true,master.includes('sldLayoutId')&&!!layout&&!!theme);
      if(layout)check('layout-backlink',masters[0].target,relationships(parts,layout.target).find(r=>r.type.endsWith('/slideMaster'))?.target);
      if(theme)check('theme-font',true,parts.get(theme.target)!.toString().includes('typeface="微软雅黑"'));
    }
    const doc=parsePptx(parts);check('slide-count',deck.slides.length,doc.slides!.length);
    deck.slides.forEach((s,i)=>{
      const actual=doc.slides![i]?.elements??[],expected=compileSlide(s,i);
      // Parser groups text, table and image objects. Compare each group in package order.
      const order:Element['kind'][]=['text','table','image'];
      check(`slide${i+1}:objects`,order.flatMap(k=>expected.filter(e=>e.kind===k)).map(wanted),actual.map(got));
      check(`slide${i+1}:bounds`,true,actual.every(e=>e.x>=0&&e.y>=0&&e.w>0&&e.h>0&&e.x+e.w<=PAGE.width+0.001&&e.y+e.h<=PAGE.height+0.001));
      check(`slide${i+1}:font-minimum`,true,actual.every(e=>e.fonts?.every(f=>f>=(e.name==='PageNumber'?12:18))??true));
      check(`slide${i+1}:no-overlap`,true,actual.every((a,j)=>actual.slice(j+1).every(b=>Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)<=.2||Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)<=.2)));
    });
    const pr=relationships(parts,'ppt/presentation.xml');for(const s of pr.filter(r=>r.type.endsWith('/slide')))check('slide-layout:'+s.target,true,relationships(parts,s.target).some(r=>r.type.endsWith('/slideLayout')));
  }catch(e){checks.push({id:'parse',ok:false,actual:e instanceof Error?e.message:String(e)});}
  return checks.some(c=>!c.ok)?officeFailed('content',subject,engine,checks):officeVerified('content',subject,engine,checks,'逐页可编辑文字、表格、图片字节与布局声明一致；最终视觉版式未经PowerPoint核验');
}
