/** U3：OOXML 生成——产出能被 Word / Excel / PowerPoint 正常打开的文件。
 *
 *  每种格式都是同一套骨架：`[Content_Types].xml` 声明部件类型、`_rels/.rels` 指向主文档、
 *  主文档自身，再加各格式必需的少量附件。这里只写**最小合法集**——
 *  内容正确、结构合法，但不做主题/母版/样式表那套（我们的定位是内容产出，不是排版设计）。
 *
 *  设计参考 OfficeCLI 的能力分层：它的 L1 是 create + 结构化写入，我们对应到这一层；
 *  它的 L2（DOM 精改）需要完整 OOXML 对象模型，留候选。 */
import { writeZip, type ZipEntry } from './zip';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** XML 文本转义。顺序要紧：& 必须先转，否则会把后面转出来的实体再转一遍。 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

// ---------------- docx ----------------

export interface DocxBlock {
  kind: 'heading' | 'para' | 'table';
  level?: number;
  text?: string;
  rows?: string[][];
}
export interface DocxInput { title?: string; blocks: readonly DocxBlock[] }

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docxPara(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  // xml:space="preserve" 是必须的：否则前后空格会被 Word 吃掉
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}
function docxTable(rows: readonly (readonly string[])[]): string {
  const trs = rows.map(r =>
    `<w:tr>${r.map(c =>
      `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${docxPara(c)}</w:tc>`).join('')}</w:tr>`).join('');
  // 无边框表格在 Word 里几乎看不出是表格，故显式给单线边框
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(s => `<w:${s} w:val="single" w:sz="4" w:color="D9D9D9"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${trs}</w:tbl>`;
}

export function buildDocx(input: DocxInput): Buffer {
  const body = input.blocks.map(b => {
    if (b.kind === 'heading') return docxPara(b.text ?? '', `Heading${Math.min(Math.max(b.level ?? 1, 1), 6)}`);
    if (b.kind === 'table') return docxTable(b.rows ?? []);
    return docxPara(b.text ?? '');
  }).join('');

  const doc = `${XML}<w:document ${W_NS}><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  // 标题样式：不带 styles.xml 的话 Heading1 只是个没有定义的样式名，Word 里看不出层级
  const heads = [1, 2, 3, 4, 5, 6].map(n => {
    const sz = [32, 28, 24, 22, 21, 21][n - 1] * 2;   // 半点单位
    return `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
      `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
      `<w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  }).join('');
  // docDefaults + Normal 是**必需的**：只定义 Heading 而不定义默认段落样式时，
  // 普通段落的 style 解析为 null——python-docx 直接抛 AttributeError（交叉验证逮到），
  // Word 虽然宽容些，但字号行距会落到实现默认值，两台机器可能不一样。
  const defaults = `<w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/>` +
    `<w:sz w:val="22"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
    `</w:docDefaults>`;
  const normal = `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`;
  const styles = `${XML}<w:styles ${W_NS}>${defaults}${normal}${heads}</w:styles>`;

  return writeZip([
    { path: '[Content_Types].xml', data: buf(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `</Types>`) },
    { path: '_rels/.rels', data: buf(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`) },
    { path: 'word/_rels/document.xml.rels', data: buf(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`) },
    { path: 'word/styles.xml', data: buf(styles) },
    { path: 'word/document.xml', data: buf(doc) },
  ]);
}

// ---------------- xlsx ----------------

export interface XlsxSheet { name: string; rows: readonly (readonly (string | number)[])[] }
export interface XlsxInput { sheets: readonly XlsxSheet[] }

function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function buildXlsx(input: XlsxInput): Buffer {
  // 共享字符串表：Excel 的常规做法，重复文本只存一份
  const shared: string[] = [];
  const idx = new Map<string, number>();
  const sid = (s: string): number => {
    let i = idx.get(s);
    if (i === undefined) { i = shared.length; shared.push(s); idx.set(s, i); }
    return i;
  };

  const sheetXmls = input.sheets.map(sh => {
    const rows = sh.rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = `${colName(c)}${r + 1}`;
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        const text = String(v ?? '');
        if (text === '') return '';                        // 空单元格干脆不写，读回时按列号补齐
        return `<c r="${ref}" t="s"><v>${sid(text)}</v></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const wb = `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    input.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets></workbook>`;

  const sst = `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') + `</sst>`;

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: buf(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
      input.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      `</Types>`) },
    { path: '_rels/.rels', data: buf(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`) },
    { path: 'xl/_rels/workbook.xml.rels', data: buf(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      input.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${input.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
      `</Relationships>`) },
    { path: 'xl/workbook.xml', data: buf(wb) },
    { path: 'xl/sharedStrings.xml', data: buf(sst) },
  ];
  sheetXmls.forEach((x, i) => entries.push({ path: `xl/worksheets/sheet${i + 1}.xml`, data: buf(x) }));
  return writeZip(entries);
}

// ---------------- pptx ----------------

export interface PptxSlide { title: string; bullets?: readonly string[] }
export interface PptxInput { slides: readonly PptxSlide[] }

const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** 一个文本框。EMU 单位（1 英寸 = 914400），16:9 版面 12192000 × 6858000。 */
function pptxShape(id: number, name: string, x: number, y: number, cx: number, cy: number, paras: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}
const pptxPara = (text: string, sz: number, bold = false): string =>
  `<a:p><a:pPr/><a:r><a:rPr lang="zh-CN" sz="${sz}"${bold ? ' b="1"' : ''} dirty="0"/>` +
  `<a:t>${esc(text)}</a:t></a:r></a:p>`;

export function buildPptx(input: PptxInput): Buffer {
  const slideXmls = input.slides.map(s => {
    const title = pptxShape(2, 'Title', 838200, 685800, 10515600, 1325563, pptxPara(s.title, 3600, true));
    const bullets = (s.bullets ?? []).map(b => pptxPara(b, 2000)).join('');
    const body = bullets
      ? pptxShape(3, 'Content', 838200, 2360613, 10515600, 3602038, bullets)
      : '';
    return `${XML}<p:sld ${P_NS}><p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
      `${title}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  });

  const n = input.slides.length;
  const pres = `${XML}<p:presentation ${P_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<p:sldIdLst>${input.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: buf(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      input.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
      `</Types>`) },
    { path: '_rels/.rels', data: buf(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `</Relationships>`) },
    { path: 'ppt/_rels/presentation.xml.rels', data: buf(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      input.slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('') +
      `</Relationships>`) },
    { path: 'ppt/presentation.xml', data: buf(pres) },
  ];
  slideXmls.forEach((x, i) => {
    entries.push({ path: `ppt/slides/slide${i + 1}.xml`, data: buf(x) });
    entries.push({ path: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: buf(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`) });
  });
  void n;
  return writeZip(entries);
}
