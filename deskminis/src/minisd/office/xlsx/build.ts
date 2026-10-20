/** Deterministic OOXML with explicit types, calculation instructions and bounded basic styling. */
import {writeZip,type ZipEntry} from '../zip';
import {XML_DECL as XML,esc,buf} from '../xml';
import {FORMATS,colName,dateSerial,displayUnits,normalizeXlsx,fail,type Workbook,type Cell,type XlsxInput} from './model';
export type {XlsxCell,CellInput,XlsxInput,XlsxSheet} from './model';
export const MANIFEST='docProps/deskminis.json';
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export function cellStyle(c:Cell,header:boolean):number{return (header?18:0)+(c.wrap?9:0)+FORMATS.indexOf(c.numFmt);}
export function stylesXml():string{
  const formats=FORMATS.map((f,i)=>`<numFmt numFmtId="${164+i}" formatCode="${esc(f)}"/>`).join('');
  const xfs=Array.from({length:36},(_,i)=>`<xf numFmtId="${164+i%9}" fontId="${i>=18?1:0}" fillId="${i>=18?2:0}" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="${Math.floor(i/9)%2}"/></xf>`).join('');
  return `${XML}<styleSheet xmlns="${NS}"><numFmts count="9">${formats}</numFmts><fonts count="2"><font><sz val="11"/><name val="微软雅黑"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF234B73"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD6E0E9"/></left><right style="thin"><color rgb="FFD6E0E9"/></right><top style="thin"><color rgb="FFD6E0E9"/></top><bottom style="thin"><color rgb="FFD6E0E9"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="36">${xfs}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
}
export function renderXlsx(model:Workbook):Buffer{
  const shared:string[]=[],ids=new Map<string,number>();let totalStrings=0;
  const sid=(s:string)=>{totalStrings++;if(!ids.has(s)){ids.set(s,shared.length);shared.push(s);}return ids.get(s)!;};
  const sheetXmls=model.sheets.map(sh=>{
    const rows=sh.rows.map((row,r)=>{
      let height=r<sh.headerRows?28:22;
      const cells=row.map((c,x)=>{
        const ref=`${colName(x)}${r+1}`,style=cellStyle(c,r<sh.headerRows);
        if(c.wrap&&c.type==='text') {
          const lines=String(c.value).split('\n').reduce((n,s)=>n+Math.max(1,Math.ceil(displayUnits(s)/Math.max(1,sh.colWidths[x]-1))),0);
          height=Math.max(height,lines*18+6);if(height>409)return fail(`工作表 ${sh.name} 的 ${ref} 文字过长，换行行高超过409pt；请缩短文字或增加列宽`);
        }
        const open=`<c r="${ref}" s="${style}"`;
        if(c.type==='blank')return open+'/>';
        if(c.type==='formula')return open+`><f>${esc(c.formula!)}</f></c>`;
        if(c.type==='text')return open+` t="s"><v>${sid(String(c.value))}</v></c>`;
        if(c.type==='boolean')return open+` t="b"><v>${c.value?1:0}</v></c>`;
        if(c.type==='error')return open+` t="e"><v>${esc(String(c.value))}</v></c>`;
        return open+`><v>${c.type==='date'?dateSerial(String(c.value)):c.value}</v></c>`;
      }).join('');return `<row r="${r+1}" ht="${height}" customHeight="1">${cells}</row>`;
    }).join('');
    const {rows:y,columns:x}=sh.freeze,pane=x&&y?'bottomRight':x?'topRight':'bottomLeft';
    const view=x||y?`<pane${x?` xSplit="${x}"`:''}${y?` ySplit="${y}"`:''} topLeftCell="${colName(x)}${y+1}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${colName(x)}${y+1}" sqref="${colName(x)}${y+1}"/>`:'';
    const width=sh.colWidths.length,last=width&&sh.rows.length?`${colName(width-1)}${sh.rows.length}`:'A1';
    return `${XML}<worksheet xmlns="${NS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0">${view}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="22"/>${width?`<cols>${sh.colWidths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>`:''}<sheetData>${rows}</sheetData>${sh.headerRows===1&&width&&sh.rows.length>1?`<autoFilter ref="A1:${last}"/>`:''}<printOptions gridLines="0"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="${width>5?'landscape':'portrait'}" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter></worksheet>`;
  });
  const entries:ZipEntry[]=[];
  const add=(path:string,s:string)=>entries.push({path,data:buf(s)});
  add('[Content_Types].xml',`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="json" ContentType="application/json"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${model.sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  add('_rels/.rels',`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="https://deskminis.local/relationships/source" Target="${MANIFEST}"/></Relationships>`);
  add('xl/_rels/workbook.xml.rels',`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${model.sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${model.sheets.length+1}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId${model.sheets.length+2}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  add('xl/workbook.xml',`${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr date1904="0"/><bookViews><workbookView activeTab="0"/></bookViews><sheets>${model.sheets.map((s,i)=>`<sheet name="${esc(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets><calcPr calcId="0" calcMode="auto" fullCalcOnLoad="1"/></workbook>`);
  add('xl/styles.xml',stylesXml());
  add('xl/sharedStrings.xml',`${XML}<sst xmlns="${NS}" count="${totalStrings}" uniqueCount="${shared.length}">${shared.map(s=>`<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`);
  sheetXmls.forEach((s,i)=>add(`xl/worksheets/sheet${i+1}.xml`,s));
  add(MANIFEST,JSON.stringify({schema:1,input:model}));
  return writeZip(entries);
}
export function buildXlsx(input:XlsxInput):Buffer{return renderXlsx(normalizeXlsx(input));}
