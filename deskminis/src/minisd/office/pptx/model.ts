import {OfficeInputError} from '../format';
import {cleanXmlText} from '../xml';
import {decodeImage} from './assets';
export type Layout='title'|'single'|'columns'|'image'|'table';
export interface Column {heading:string;bullets:string[]}
export interface Slide {layout:Layout;title:string;bullets?:string[];subtitle?:string;columns?:Column[];image?:{dataUrl:string;alt:string;caption:string};table?:{rows:string[][];colWidths:number[]}}
export interface Deck {slides:Slide[]}
const fail=(s:string):never=>{throw new OfficeInputError(s);};
function object(v:unknown,keys:string[],label:string):Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v))return fail(`${label}必须是对象`);
  const r=v as Record<string,unknown>;for(const k of Object.keys(r))if(!keys.includes(k))return fail(`${label}不支持字段${k}`);return r;
}
export function normalizePptx(input:unknown):Deck{
  const root=object(input,['slides'],'pptx');if(!Array.isArray(root.slides)||!root.slides.length||root.slides.length>50)return fail('必须提供1至50页slides');
  let chars=0,media=0;
  const text=(v:unknown,label:string):string=>{if(typeof v!=='string')return fail(`${label}必须是文字`);chars+=v.length;if(chars>100000)return fail('演示文字超过10万字符，请拆分');const c=cleanXmlText(v);if(c.removed)return fail(`${label}含XML不支持字符`);return c.text;};
  const bullets=(v:unknown,label:string):string[]=>{if(v===undefined)return [];if(!Array.isArray(v)||v.length>100)return fail(`${label}必须是最多100段文字`);return v.map(x=>text(x,label));};
  const slides=root.slides.map((v,i):Slide=>{
    const label=`第${i+1}页`,s=object(v,['layout','title','bullets','subtitle','columns','image','table'],label),layout=s.layout??'single';
    if(!['title','single','columns','image','table'].includes(layout as string))return fail(`${label}布局不支持`);
    const fields:Record<string,string[]>={title:['subtitle'],single:['bullets'],columns:['columns'],image:['image'],table:['table']};
    for(const k of ['subtitle','bullets','columns','image','table'])if(s[k]!==undefined&&!fields[layout as string].includes(k))return fail(`${label}布局${layout}不能使用${k}`);
    const slide:Slide={layout:layout as Layout,title:text(s.title??'',label+'标题')};
    if(layout==='title')slide.subtitle=text(s.subtitle??'',label+'副标题');
    if(layout==='single')slide.bullets=bullets(s.bullets,label+'正文');
    if(layout==='columns'){
      if(!Array.isArray(s.columns)||s.columns.length!==2)return fail(`${label}双栏必须恰好两栏`);
      slide.columns=s.columns.map(v=>{const c=object(v,['heading','bullets'],label+'栏');return {heading:text(c.heading??'',label+'栏标题'),bullets:bullets(c.bullets,label+'栏正文')};});
    }
    if(layout==='image'){
      const im=object(s.image,['dataUrl','alt','caption'],label+'图片'),a=decodeImage(im.dataUrl);media+=a.bytes.length;if(media>32*1024*1024)return fail('全部图片超过32MiB');
      slide.image={dataUrl:im.dataUrl as string,alt:text(im.alt??'',label+'替代文字'),caption:text(im.caption??'',label+'图片说明')};
    }
    if(layout==='table'){
      const t=object(s.table,['rows','colWidths'],label+'表格');if(!Array.isArray(t.rows)||!t.rows.length||t.rows.length>8)return fail(`${label}表格必须1至8行`);
      const n=Array.isArray(t.rows[0])?t.rows[0].length:0;if(n<1||n>5)return fail(`${label}表格必须1至5列`);
      const rows=t.rows.map(row=>{if(!Array.isArray(row)||row.length!==n)return fail(`${label}表格每行列数必须一致`);return row.map(c=>text(typeof c==='number'&&Number.isFinite(c)?String(c):c,label+'表格单元格'));});
      const widths=t.colWidths??Array(n).fill(1);if(!Array.isArray(widths)||widths.length!==n||widths.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<0.1||x>100))return fail(`${label}colWidths须为各列正数比例（0.1至100）`);
      slide.table={rows,colWidths:widths as number[]};
    }
    return slide;
  });return {slides};
}
