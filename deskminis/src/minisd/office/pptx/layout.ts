/** Deterministic conservative layout, in points. Runtime visual validation remains separate. */
import {OfficeInputError} from '../format';
import {decodeImage,type ImageAsset} from './assets';
import type {Slide} from './model';
export const PAGE={width:960,height:540};
export interface Box {x:number;y:number;w:number;h:number}
export interface TextBox extends Box {kind:'text';name:string;paras:string[];font:number;bold:boolean;color:string;align:'l'|'ctr'|'r';bullet:boolean}
export interface Picture extends Box {kind:'image';name:string;asset:ImageAsset;alt:string}
export interface Table extends Box {kind:'table';name:string;rows:string[][];widths:number[];heights:number[];font:number}
export type Element=TextBox|Picture|Table;
export function requiredHeight(paras:readonly string[],w:number,font:number,bullet=false):number{
  const capacity=Math.max(1,(w-14-(bullet?18:0))/font);let height=0;
  for(const para of paras){let lines=0;for(const part of para.split('\n')){let units=0;for(const ch of part){units+=/\s/.test(ch)?0.45:ch.codePointAt(0)!>255?1:0.58;}lines+=Math.max(1,Math.ceil(units/capacity));}height+=lines*font*1.25+8;}
  return height+8;
}
export function compileSlide(s:Slide,index:number):Element[]{
  const out:Element[]=[];
  const text=(name:string,paras:string[],box:Box,font:number,bold=false,bullet=false,align:TextBox['align']='l',color='234B73')=>{
    if(!paras.some(p=>p.length))return;
    if(requiredHeight(paras,box.w,font,bullet)>box.h)throw new OfficeInputError(`第${index+1}页${name}文字溢出，请缩短文字或拆页；不会自动缩小字号`);
    out.push({...box,kind:'text',name,paras,font,bold,bullet,align,color});
  };
  if(s.layout==='title'){
    text('Title',[s.title],{x:60,y:128,w:840,h:132},38,true,false,'ctr');
    text('Subtitle',[s.subtitle??''],{x:100,y:290,w:760,h:128},22,false,false,'ctr','526171');
  }else{
    text('Title',[s.title],{x:50,y:27,w:860,h:95},30,true);
    if(s.layout==='single')text('Content',s.bullets??[],{x:60,y:143,w:840,h:333},20,false,true,'l','263746');
    if(s.layout==='columns')s.columns!.forEach((c,i)=>{
      const x=60+i*438;text(`Column${i+1}Heading`,[c.heading],{x,y:137,w:402,h:65},22,true);
      text(`Column${i+1}Body`,c.bullets,{x,y:214,w:402,h:262},20,false,true,'l','263746');
    });
    if(s.layout==='image'){
      const im=s.image!,asset=decodeImage(im.dataUrl),box={x:60,y:135,w:840,h:im.caption?288:340},scale=Math.min(box.w/asset.width,box.h/asset.height),w=asset.width*scale,h=asset.height*scale;
      out.push({kind:'image',name:'Picture',asset,alt:im.alt,x:box.x+(box.w-w)/2,y:box.y+(box.h-h)/2,w,h});
      text('Caption',[im.caption],{x:60,y:435,w:840,h:48},18,false,false,'ctr','526171');
    }
    if(s.layout==='table'){
      const t=s.table!,sum=t.colWidths.reduce((a,b)=>a+b,0),widths=t.colWidths.map(x=>840*x/sum);
      if(widths.some(w=>w<60))throw new OfficeInputError(`第${index+1}页表格列过窄，请调整colWidths或拆表`);
      const heights=t.rows.map(row=>Math.max(42,...row.map((c,i)=>requiredHeight([c],widths[i]-8,18)+10))),h=heights.reduce((a,b)=>a+b,0);
      if(h>340)throw new OfficeInputError(`第${index+1}页表格溢出，请减少行数、缩短单元格或拆页`);
      out.push({kind:'table',name:'Table',rows:t.rows,widths,heights,font:18,x:60,y:140,w:840,h});
    }
  }
  text('PageNumber',[String(index+1)],{x:864,y:502,w:48,h:34},12,false,false,'r','526171');
  return out;
}
