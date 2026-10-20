/** Word 生成（F10A）：规范化之后的模型 → docx 字节。
 *
 *  不靠模型手写 OOXML：输入先过 `normalizeDocx`（model.ts）变成确定性的内容模型，这里只把模型逐块写成 XML。
 *  同输入两次产出的字节相同（不读时钟、不取随机数、不读环境）。
 *
 *  生成出来的文件在真实 Word 里长什么样，这里的代码证明不了——那靠取证（work\verify\F10A\）。 */
import { writeZip } from '../zip';
import { XML_DECL as XML, esc, buf } from '../xml';
import { normalizeDocx, type DocxInput, type DocxModel, type DocxModelBlock } from './model';
import { DOCX_DEFAULTS as D } from './layout';
import {
  W_NS, R_NS, FOOTER_REL_ID, docxPartNames, stylesXml, settingsXml, fontTableXml, numberingXml, footerXml,
  corePropsXml, appPropsXml, contentTypesXml, rootRelsXml, documentRelsXml,
} from './parts';

export type { DocxBlock, DocxInput } from './model';

/** 含中日韩文字或全角符号的 run 加 hint：引号、破折号、省略号这些两边都有的字符才会用中文字体。 */
const HAS_EAST_ASIAN = /[⺀-￿]/;

/** 一个段落一个 run。文本已经清洗过（normalizeDocx）；\n → 换行，\t → 制表位，其余进 w:t。 */
function run(text: string, bold = false): string {
  const rPr = (HAS_EAST_ASIAN.test(text) ? '<w:rFonts w:hint="eastAsia"/>' : '') + (bold ? '<w:b/><w:bCs/>' : '');
  const body = text.split(/(\n|\t)/).map(s =>
    s === '\n' ? '<w:br/>' : s === '\t' ? '<w:tab/>' : s === '' ? '' : `<w:t xml:space="preserve">${esc(s)}</w:t>`).join('');
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${body}</w:r>`;
}

interface PPr {
  style: string;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  numPr?: { level: number; numId: number };
  /** 固定行高（间隔段落用） */
  exactLineTw?: number;
  noFirstLineIndent?: boolean;
  jc?: 'left' | 'center' | 'right';
}
/** 段落属性。子元素顺序固定：pStyle, keepNext, pageBreakBefore, numPr, spacing, ind, jc。 */
function pPr(o: PPr): string {
  return `<w:pPr><w:pStyle w:val="${o.style}"/>` +
    (o.keepNext ? '<w:keepNext/>' : '') +
    (o.pageBreakBefore ? '<w:pageBreakBefore/>' : '') +
    (o.numPr ? `<w:numPr><w:ilvl w:val="${o.numPr.level}"/><w:numId w:val="${o.numPr.numId}"/></w:numPr>` : '') +
    (o.exactLineTw !== undefined ? `<w:spacing w:before="0" w:after="0" w:line="${o.exactLineTw}" w:lineRule="exact"/>` : '') +
    (o.noFirstLineIndent ? '<w:ind w:firstLineChars="0" w:firstLine="0"/>' : '') +
    (o.jc ? `<w:jc w:val="${o.jc}"/>` : '') + `</w:pPr>`;
}
const para = (p: PPr, text: string, bold = false): string => `<w:p>${pPr(p)}${text === '' ? '' : run(text, bold)}</w:p>`;
/** 间隔段落：1 磅的字、固定行高，只为把前后两样东西隔开，不留看得见的空行。 */
const gap = (lineTw: number): string => `<w:p>${pPr({ style: 'DmGap', exactLineTw: lineTw })}</w:p>`;

function table(b: Extract<DocxModelBlock, { kind: 'table' }>): string {
  const total = b.colsTw.reduce((a, c) => a + c, 0);
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('');
  const rows = b.rows.map((r, ri) => {
    const header = ri < b.headerRows;
    const trPr = (b.cantSplit[ri] ? '<w:cantSplit/>' : '') + (header ? '<w:tblHeader/>' : '');
    const cells = r.map((c, ci) =>
      `<w:tc><w:tcPr><w:tcW w:w="${b.colsTw[ci]}" w:type="dxa"/>` +
      (header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '') + `<w:vAlign w:val="center"/></w:tcPr>` +
      para({ style: 'TableText', jc: header ? 'center' : undefined }, c, header) + `</w:tc>`).join('');
    return `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells}</w:tr>`;
  }).join('');
  // 固定布局 + 总宽恒等于版心：越不越界不靠字宽估算。tblInd=0 时左边线就在版心左缘（兼容模式 15 下实测）
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/>` +
    `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:top w:w="${D.cellPadVTw}" w:type="dxa"/><w:left w:w="${b.padTw}" w:type="dxa"/>` +
    `<w:bottom w:w="${D.cellPadVTw}" w:type="dxa"/><w:right w:w="${b.padTw}" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${b.colsTw.map(c => `<w:gridCol w:w="${c}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
}

export function documentXml(m: DocxModel): string {
  const out: string[] = [];
  m.blocks.forEach((b, i) => {
    if (b.kind === 'heading') {
      out.push(para({ style: `Heading${b.level}`, pageBreakBefore: b.pageBreakBefore }, b.text));
    } else if (b.kind === 'para') {
      // 两端对齐是样式的默认值；居中与靠右的段落不要首行缩进
      const off = b.align === 'center' || b.align === 'right';
      out.push(para({ style: 'BodyText', keepNext: b.keepWithNext, noFirstLineIndent: off, jc: b.align === 'justify' ? undefined : b.align }, b.text));
    } else if (b.kind === 'list') {
      for (const it of b.items) out.push(para({ style: 'ListParagraph', numPr: { level: it.level, numId: b.numId } }, it.text));
    } else if (b.kind === 'pageBreak') {
      // 分页符放在间隔段落里：分页后的段落标记只占 1 磅，不在新页顶上留一个空行
      out.push(`<w:p>${pPr({ style: 'DmGap' })}<w:r><w:br w:type="page"/></w:r></w:p>`);
    } else {
      out.push(table(b));
      const next = m.blocks[i + 1];
      // 两表相邻：隔开 6 磅，否则 Word 会把它们并成一张。表在文末：Word 要求表后有段落，做小免得把它挤到新的一页
      if (next === undefined) out.push(gap(D.gapTinyTw));
      else if (next.kind === 'table') out.push(gap(D.gapBetweenTablesTw));
    }
  });
  // 不产出只有 sectPr 的正文
  if (out.length === 0) out.push(para({ style: 'BodyText' }, ''));
  const p = m.page;
  const sect = `<w:sectPr>${p.pageNumber === 'none' ? '' : `<w:footerReference w:type="default" r:id="${FOOTER_REL_ID}"/>`}` +
    `<w:pgSz w:w="${p.widthTw}" w:h="${p.heightTw}"${p.landscape ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${p.marginTw.top}" w:right="${p.marginTw.right}" w:bottom="${p.marginTw.bottom}" w:left="${p.marginTw.left}"` +
    ` w:header="${p.headerTw}" w:footer="${p.footerTw}" w:gutter="0"/></w:sectPr>`;
  return `${XML}<w:document ${W_NS} ${R_NS}><w:body>${out.join('')}${sect}</w:body></w:document>`;
}

/** 模型 → 各部件的 XML（名字到内容），顺序同 docxPartNames。 */
export function docxParts(m: DocxModel): [string, string][] {
  const xml: Record<string, () => string> = {
    '[Content_Types].xml': () => contentTypesXml(m),
    '_rels/.rels': rootRelsXml,
    'docProps/core.xml': () => corePropsXml(m),
    'docProps/app.xml': appPropsXml,
    'word/_rels/document.xml.rels': () => documentRelsXml(m),
    'word/styles.xml': () => stylesXml(m),
    'word/settings.xml': settingsXml,
    'word/fontTable.xml': () => fontTableXml(m),
    'word/numbering.xml': () => numberingXml(m),
    'word/footer1.xml': footerXml,
    'word/document.xml': () => documentXml(m),
  };
  return docxPartNames(m).map(name => [name, xml[name]()]);
}

export function renderDocx(model: DocxModel): Buffer {
  return writeZip(docxParts(model).map(([path, s]) => ({ path, data: buf(s) })));
}

/** 名字、签名、导出位置（经 office/build.ts）不变：旧的 `buildDocx({ title, blocks })` 原样可用。
 *  输入不可用时抛 OfficeInputError。 */
export function buildDocx(input: DocxInput): Buffer {
  return renderDocx(normalizeDocx(input).model);
}
