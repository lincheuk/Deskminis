/** db2a0ab 的 Word 生成器的**冻结副本**（原 src/minisd/office/build.ts 第 34–94 行，一个字没改）。
 *
 *  两个用途：
 *  1. 拆分的黄金值：证明把三种格式搬进各自目录时没有改动任何字节；
 *  2. 「旧产物」夹具：F10A 重写生成器之后，旧版本已经写到用户磁盘上的 docx 长这样——
 *     覆盖判定必须仍把它认作本工具的产物（5 个部件、没有 app.xml）。
 *
 *  这是测试夹具，不是产品代码；不要跟着新生成器改。 */
import { writeZip } from '../src/minisd/office/zip';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

export interface LegacyDocxBlock {
  kind: 'heading' | 'para' | 'table';
  level?: number;
  text?: string;
  rows?: string[][];
}
export interface LegacyDocxInput { title?: string; blocks: readonly LegacyDocxBlock[] }

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docxPara(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}
function docxTable(rows: readonly (readonly string[])[]): string {
  const trs = rows.map(r =>
    `<w:tr>${r.map(c =>
      `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${docxPara(c)}</w:tc>`).join('')}</w:tr>`).join('');
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(s => `<w:${s} w:val="single" w:sz="4" w:color="D9D9D9"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${trs}</w:tbl>`;
}

export function legacyBuildDocx(input: LegacyDocxInput): Buffer {
  const body = input.blocks.map(b => {
    if (b.kind === 'heading') return docxPara(b.text ?? '', `Heading${Math.min(Math.max(b.level ?? 1, 1), 6)}`);
    if (b.kind === 'table') return docxTable(b.rows ?? []);
    return docxPara(b.text ?? '');
  }).join('');

  const doc = `${XML}<w:document ${W_NS}><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const heads = [1, 2, 3, 4, 5, 6].map(n => {
    const sz = [32, 28, 24, 22, 21, 21][n - 1] * 2;
    return `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
      `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
      `<w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  }).join('');
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

/** 黄金值用的两份固定输入（与 work\verify\F10A\golden-inputs.json 的 docx 一节相同）。 */
export const LEGACY_DOCX_INPUTS: Record<'a' | 'b', LegacyDocxInput> = {
  a: {
    title: '季度报告',
    blocks: [
      { kind: 'heading', level: 1, text: '季度报告' },
      { kind: 'para', text: '营收增长 25%，其中华东占比最高。' },
      { kind: 'table', rows: [['区域', '金额'], ['华东', '42'], ['华南', '31']] },
    ],
  },
  b: {
    blocks: [
      { kind: 'heading', level: 2, text: 'A & B < C > D' },
      { kind: 'para', text: '"quoted" \'single\' 末尾空格 ' },
      { kind: 'table', rows: [['只有一行']] },
      { kind: 'heading', level: 9, text: '级别越界' },
    ],
  },
};

/** 上面两份输入在 db2a0ab 上逐部件的 sha256（拆分之前算好写死；算法见 work\verify\F10A\golden-base.mjs）。 */
export const LEGACY_DOCX_PART_HASHES: Record<'a' | 'b', Record<string, string>> = {
  a: {
    '[Content_Types].xml': '3fd5cc9b5c673dbef990d3b88a7c77bf1f19cf6609dd4f739d4b5a4c2ecb9e6d',
    '_rels/.rels': '6b1f432240d639e697da68ee65a70d6252b5eb7204e58daeae6514a0f85f2285',
    'word/_rels/document.xml.rels': '5931ab90e9e45812ef85cddf5b661f7dcc8992d293f0b9890337ba5ffd38737a',
    'word/document.xml': 'fead144f4119d90c04ed60d4ba38897ae0930ecdb0fc749f0458dcbd7689cc45',
    'word/styles.xml': 'f1fef1f23f5994846e37587d2c6ddb515f9bf8b8563e7cfc01bc48577f988bc1',
  },
  b: {
    '[Content_Types].xml': '3fd5cc9b5c673dbef990d3b88a7c77bf1f19cf6609dd4f739d4b5a4c2ecb9e6d',
    '_rels/.rels': '6b1f432240d639e697da68ee65a70d6252b5eb7204e58daeae6514a0f85f2285',
    'word/_rels/document.xml.rels': '5931ab90e9e45812ef85cddf5b661f7dcc8992d293f0b9890337ba5ffd38737a',
    'word/document.xml': 'ce3f64ec969a1be4158498cefc833f5a9f2391f1986320a667939f522006ff90',
    'word/styles.xml': 'f1fef1f23f5994846e37587d2c6ddb515f9bf8b8563e7cfc01bc48577f988bc1',
  },
};
