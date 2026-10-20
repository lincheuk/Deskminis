/** Verify this exact byte subject by decoding its real cells and style declarations. No calculation claim. */
import {createHash} from 'node:crypto';
import {readZip} from '../zip';
import {checkWellFormed,chunksOf,attrOf} from '../xml';
import {officeFailed,officeVerified,type OfficeCheckItem,type OfficeSubject,type OfficeVerification} from '../../../shared/office-verification';
import {parseXlsx} from './parse';
import {colName,type Workbook} from './model';
export async function verifyXlsxContent(bytes:Buffer,model:Workbook,subject:OfficeSubject):Promise<OfficeVerification>{
  const engine={id:'deskminis-readback' as const,version:'1'},checks:OfficeCheckItem[]=[];
  const check=(id:string,expected:unknown,actual:unknown)=>checks.push({id,ok:JSON.stringify(expected)===JSON.stringify(actual),expected:JSON.stringify(expected),actual:JSON.stringify(actual)});
  check('subject',subject,{sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
  try{
    const parts=await readZip(bytes);for(const [name,part]of parts)if(name.endsWith('.xml')||name.endsWith('.rels'))check('xml:'+name,null,checkWellFormed(part.toString('utf8')));
    const doc=parseXlsx(parts);check('sheets',model.sheets.map(s=>s.name),doc.sheets!.map(s=>s.name));
    const style=parts.get('xl/styles.xml')?.toString('utf8')??'';
    const fonts=chunksOf(chunksOf(style,'fonts')[0]??'','font');
    check('font-definitions',[{name:'微软雅黑',size:'11',bold:false},{name:'微软雅黑',size:'11',bold:true,color:'FFFFFFFF'}],fonts.map(f=>({name:attrOf(f,'name','val'),size:attrOf(f,'sz','val'),bold:/<(?:\w+:)?b\s*\/>/.test(f),...(attrOf(f,'color','rgb')?{color:attrOf(f,'color','rgb')}:{})})));
    const fills=chunksOf(chunksOf(style,'fills')[0]??'','fill');
    check('fill-definitions',[{pattern:'none'},{pattern:'gray125'},{pattern:'solid',color:'FF234B73'}],fills.map(f=>({pattern:attrOf(f,'patternFill','patternType'),...(attrOf(f,'fgColor','rgb')?{color:attrOf(f,'fgColor','rgb')}:{})})));
    const borders=chunksOf(chunksOf(style,'borders')[0]??'','border'),grid=borders[1]??'';
    check('grid-border',true,['left','right','top','bottom'].every(side=>attrOf(grid,side,'style')==='thin'&&chunksOf(grid,side)[0]?.includes('rgb="FFD6E0E9"')));
    const cellXfs=chunksOf(style,'cellXfs')[0]??'',xfs=[...cellXfs.matchAll(/<(?:\w+:)?xf\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?xf>/g)];
    check('actual-style-references',Array.from({length:36},(_,i)=>({font:String(i>=18?1:0),fill:String(i>=18?2:0),border:'1',format:String(164+i%9),wrap:String(Math.floor(i/9)%2),vertical:'center',applied:['1','1','1','1','1']})),xfs.map(m=>{const tag='<xf '+m[1]+'>';return {font:attrOf(tag,'xf','fontId'),fill:attrOf(tag,'xf','fillId'),border:attrOf(tag,'xf','borderId'),format:attrOf(tag,'xf','numFmtId'),wrap:attrOf(m[2],'alignment','wrapText'),vertical:attrOf(m[2],'alignment','vertical'),applied:['applyFont','applyFill','applyBorder','applyNumberFormat','applyAlignment'].map(k=>attrOf(tag,'xf',k))};}));
    const wb=parts.get('xl/workbook.xml')?.toString('utf8')??'';
    checks.push({id:'calculation-instructions',ok:wb.includes('date1904="0"')&&wb.includes('calcMode="auto"')&&wb.includes('fullCalcOnLoad="1"')&&!wb.includes('forceFullCalc="1"')});
    model.sheets.forEach((s,i)=>{
      const got=doc.sheets![i];check(`sheet${i}:rows`,s.rows.length,got?.rows.length);check(`sheet${i}:widths`,s.colWidths,got?.colWidths);check(`sheet${i}:freeze`,s.freeze,got?.freeze);
      s.rows.forEach((row,r)=>{check(`sheet${i}:row${r}:length`,row.length,got?.cells[r]?.length);
        row.forEach((c,x)=>{
          const actual=got?.cells[r]?.[x];check(`${s.name}!${colName(x)}${r+1}`,{type:c.type,...(c.value===undefined?{}:{value:c.value}),...(c.formula===undefined?{}:{formula:c.formula}),numFmt:c.numFmt,wrap:c.wrap},actual?{type:actual.type,...(actual.value===undefined?{}:{value:actual.value}),...(actual.formula===undefined?{}:{formula:actual.formula}),numFmt:actual.numFmt,wrap:actual.wrap}:undefined);
          if(c.type==='formula')check(`${s.name}!${colName(x)}${r+1}:no-fake-cache`,undefined,actual?.cached);
          check(`${s.name}!${colName(x)}${r+1}:header`,r<s.headerRows,actual!==undefined&&actual.style>=18);
        });
      });
    });
  }catch(e){checks.push({id:'parse',ok:false,actual:e instanceof Error?e.message:String(e)});}
  return checks.some(c=>!c.ok)?officeFailed('content',subject,engine,checks):officeVerified('content',subject,engine,checks,'逐表逐格类型、值、公式、格式及冻结一致；公式结果尚未计算');
}
