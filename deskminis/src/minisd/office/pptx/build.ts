/** Complete editable PresentationML package. Format-local, deterministic, no external resources. */
import {writeZip,type ZipEntry} from '../zip';
import {XML_DECL as XML,esc,buf} from '../xml';
import {normalizePptx,type Deck,type Layout} from './model';
import {OfficeInputError} from '../format';
import {compileSlide,PAGE,type Element,type TextBox,type Table} from './layout';
export interface PptxSlide {title:string;bullets?:readonly string[];layout?:Layout}
export interface PptxInput {slides:readonly PptxSlide[]}
export const MANIFEST='docProps/deskminis.json';
const A='http://schemas.openxmlformats.org/drawingml/2006/main',P='http://schemas.openxmlformats.org/presentationml/2006/main',R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS=`xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}"`,emu=(pt:number)=>Math.round(pt*12700);
const rel=(id:string,type:string,target:string)=>`<Relationship Id="${id}" Type="${R}/${type}" Target="${esc(target)}"/>`;
const rels=(body:string)=>`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const group='<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const colorMap='<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';
const fill=(color:string)=>`<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
function run(text:string,font:number,bold:boolean,color:string):string{
  const rp=`lang="zh-CN" sz="${font*100}"${bold?' b="1"':''}`;
  const style=`${fill(color)}<a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface="微软雅黑"/>`;
  return text.split('\n').map((line,i)=>(i?'<a:br/>':'')+`<a:r><a:rPr ${rp}>${style}</a:rPr><a:t xml:space="preserve">${esc(line)}</a:t></a:r>`).join('');
}
function paragraphs(e:Pick<TextBox,'paras'|'font'|'bold'|'color'|'align'|'bullet'>):string{
  const props=`lang="zh-CN" sz="${e.font*100}"${e.bold?' b="1"':''}`,style=`${fill(e.color)}<a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface="微软雅黑"/>`;
  return e.paras.map(text=>`<a:p><a:pPr algn="${e.align}"${e.bullet?' marL="228600" indent="-152400"':''}><a:lnSpc><a:spcPct val="125000"/></a:lnSpc><a:spcAft><a:spcPts val="800"/></a:spcAft>${e.bullet?'<a:buChar char="•"/>':'<a:buNone/>'}<a:defRPr ${props}>${style}</a:defRPr></a:pPr>${run(text,e.font,e.bold,e.color)}<a:endParaRPr ${props}>${style}</a:endParaRPr></a:p>`).join('');
}
const xfrm=(e:Element)=>`<a:xfrm><a:off x="${emu(e.x)}" y="${emu(e.y)}"/><a:ext cx="${emu(e.w)}" cy="${emu(e.h)}"/></a:xfrm>`;
function shape(e:Element,id:number):string{
  if(e.kind==='text')return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${e.name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(e)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="63500" rIns="63500" tIns="38100" bIns="38100" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(e)}</p:txBody></p:sp>`;
  if(e.kind==='image')return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture" descr="${esc(e.alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(e)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  return tableShape(e,id);
}
function tableShape(e:Table,id:number):string{
  const rows=e.rows.map((row,r)=>`<a:tr h="${emu(e.heights[r])}">${row.map(c=>{
    const paras=paragraphs({paras:[c],font:e.font,bold:r===0,color:r===0?'FFFFFF':'263746',align:'l',bullet:false});
    const border=['L','R','T','B'].map(side=>`<a:ln${side} w="12700">${fill('CBD5DF')}<a:prstDash val="solid"/></a:ln${side}>`).join('');
    return `<a:tc><a:txBody><a:bodyPr wrap="square" lIns="88900" rIns="88900" tIns="63500" bIns="63500"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</a:txBody><a:tcPr marL="88900" marR="88900" marT="63500" marB="63500" anchor="ctr">${border}${fill(r===0?'234B73':r%2?'F1F5F9':'FFFFFF')}</a:tcPr></a:tc>`;
  }).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(e.x)}" y="${emu(e.y)}"/><a:ext cx="${emu(e.w)}" cy="${emu(e.h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${e.widths.map(w=>`<a:gridCol w="${emu(w)}"/>`).join('')}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function theme():string{
  const colors=[['dk1','263746'],['lt1','FFFFFF'],['dk2','234B73'],['lt2','F1F5F9'],['accent1','234B73'],['accent2','397B91'],['accent3','62A19A'],['accent4','E2A551'],['accent5','917DB2'],['accent6','B96F74'],['hlink','0563C1'],['folHlink','954F72']];
  const fonts=(tag:string)=>`<a:${tag}><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface="微软雅黑"/></a:${tag}>`;
  const sf='<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `${XML}<a:theme xmlns:a="${A}" name="DeskMinis"><a:themeElements><a:clrScheme name="DeskMinis">${colors.map(([k,v])=>`<a:${k}><a:srgbClr val="${v}"/></a:${k}>`).join('')}</a:clrScheme><a:fontScheme name="Chinese">${fonts('majorFont')}${fonts('minorFont')}</a:fontScheme><a:fmtScheme name="DeskMinis"><a:fillStyleLst>${sf.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350,12700,19050].map(w=>`<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${sf}<a:prstDash val="solid"/><a:miter lim="800000"/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${sf.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}
export function buildPptx(input:unknown):Buffer{return renderPptx(normalizePptx(input));}
export function renderPptx(deck:Deck):Buffer{
  const elements=deck.slides.map(compileSlide),entries:ZipEntry[]=[],media=new Map<string,Element & {kind:'image'}>();
  for(const es of elements)for(const e of es)if(e.kind==='image')media.set(e.asset.sha256,e);
  const add=(path:string,data:string|Buffer)=>entries.push({path,data:typeof data==='string'?buf(data):data});
  const override=(part:string,type:string)=>`<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`;
  add('[Content_Types].xml',`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="json" ContentType="application/json"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${override('ppt/presentation.xml','presentation.main')}${override('ppt/slideMasters/slideMaster1.xml','slideMaster')}${override('ppt/slideLayouts/slideLayout1.xml','slideLayout')}${override('ppt/presProps.xml','presProps')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${deck.slides.map((_,i)=>override(`ppt/slides/slide${i+1}.xml`,'slide')).join('')}</Types>`);
  add('_rels/.rels',rels(rel('rIdOffice','officeDocument','ppt/presentation.xml')+'<Relationship Id="rIdSource" Type="https://deskminis.local/source" Target="docProps/deskminis.json"/>'));
  add(MANIFEST,JSON.stringify({schema:1,input:deck}));
  add('ppt/presentation.xml',`${XML}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${deck.slides.map((_,i)=>`<p:sldId id="${256+i}" r:id="rIdSlide${i+1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${emu(PAGE.width)}" cy="${emu(PAGE.height)}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle></p:presentation>`);
  add('ppt/_rels/presentation.xml.rels',rels(rel('rIdMaster','slideMaster','slideMasters/slideMaster1.xml')+rel('rIdProps','presProps','presProps.xml')+deck.slides.map((_,i)=>rel(`rIdSlide${i+1}`,'slide',`slides/slide${i+1}.xml`)).join('')));
  add('ppt/presProps.xml',`${XML}<p:presentationPr ${NS}/>`);
  add('ppt/slideMasters/slideMaster1.xml',`${XML}<p:sldMaster ${NS}><p:cSld name="DeskMinis"><p:bg><p:bgPr>${fill('FFFFFF')}<a:effectLst/></p:bgPr></p:bg><p:spTree>${group}</p:spTree></p:cSld>${colorMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3000"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr sz="1800"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`);
  add('ppt/slideMasters/_rels/slideMaster1.xml.rels',rels(rel('rIdLayout','slideLayout','../slideLayouts/slideLayout1.xml')+rel('rIdTheme','theme','../theme/theme1.xml')));
  add('ppt/slideLayouts/slideLayout1.xml',`${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  add('ppt/slideLayouts/_rels/slideLayout1.xml.rels',rels(rel('rIdMaster','slideMaster','../slideMasters/slideMaster1.xml')));
  add('ppt/theme/theme1.xml',theme());
  elements.forEach((es,i)=>{
    add(`ppt/slides/slide${i+1}.xml`,`${XML}<p:sld ${NS}><p:cSld><p:spTree>${group}${es.map((e,j)=>shape(e,j+2)).join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    const pic=es.find(e=>e.kind==='image');add(`ppt/slides/_rels/slide${i+1}.xml.rels`,rels(rel('rIdLayout','slideLayout','../slideLayouts/slideLayout1.xml')+(pic?.kind==='image'?rel('rIdImage','image',`../media/${pic.asset.sha256}.${pic.asset.ext}`):'')));
  });for(const [sha,e]of media)add(`ppt/media/${sha}.${e.asset.ext}`,e.asset.bytes);
  if(entries.reduce((n,e)=>n+e.data.length,0)>60*1024*1024)throw new OfficeInputError('演示部件总量超过60MiB，请拆分或减少图片');
  return writeZip(entries);
}
