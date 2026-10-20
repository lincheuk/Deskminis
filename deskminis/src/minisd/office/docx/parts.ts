/** Word 包里除正文之外的部件（F10A）。都只吃 DocxModel，确定性输出。
 *
 *  写法是在真实 Word（16.0.15128，中文版）里逐项量出来的，不是照规范猜的：
 *  - 没有 settings.xml 时 Word 按 2007 的规则打开（「兼容性模式」）；带上 compatibilityMode=15 即恢复；
 *  - 字体要「多处同写」：docDefaults 四个槽、每个样式的 rFonts、fontTable 条目，名字写中文名。
 *    只在 docDefaults 里写英文名（旧代码的做法）时东亚槽不被采用，中文落到主题字体等线；
 *  - 不写 w:docGrid（写了行距会被网格吸附放大）；不写 w:updateFields（会弹更新域的对话框）。
 *
 *  子元素顺序按 ECMA-376 的 sequence 写——Word 对乱序不总是宽容。 */
import { XML_DECL as XML, esc } from '../xml';
import type { DocxModel, DocxCjkFont, DocxLatinFont } from './model';
import { DOCX_DEFAULTS as D, DOCX_FONTS } from './layout';

export const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
export const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const PKG = 'http://schemas.openxmlformats.org/package/2006';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';

/** 项目符号用的字体：宋体里这三个符号都有，而且是文档里本来就可能用到的字体。 */
const BULLET_FONT: DocxCjkFont = '宋体';

const hasNumbering = (m: DocxModel): boolean => m.blocks.some(b => b.kind === 'list');
const hasBullets = (m: DocxModel): boolean => m.blocks.some(b => b.kind === 'list' && !b.ordered);
const hasFooter = (m: DocxModel): boolean => m.page.pageNumber !== 'none';

/** 这份文档的部件清单，顺序固定（也是写进 ZIP 的顺序）。 */
export function docxPartNames(m: DocxModel): string[] {
  const names = ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml',
    'word/_rels/document.xml.rels', 'word/styles.xml', 'word/settings.xml', 'word/fontTable.xml'];
  if (hasNumbering(m)) names.push('word/numbering.xml');
  if (hasFooter(m)) names.push('word/footer1.xml');
  names.push('word/document.xml');
  return names;
}

/** 四个槽都写：只写 eastAsia 的话西文与复杂文种会各落各的默认字体。 */
export function rFonts(eastAsia: DocxCjkFont, latin: DocxLatinFont): string {
  return `<w:rFonts w:ascii="${latin}" w:hAnsi="${latin}" w:eastAsia="${eastAsia}" w:cs="${latin}"/>`;
}
const sz = (halfPt: number): string => `<w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/>`;
const spacing = (before: number, after: number, line: number, rule: 'auto' | 'exact' = 'auto'): string =>
  `<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="${rule}"/>`;

function style(id: string, name: string, extra: string, pPr: string, rPr: string): string {
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}` +
    `${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:rPr>${rPr}</w:rPr></w:style>`;
}

export function stylesXml(m: DocxModel): string {
  const f = m.fonts;
  const body = rFonts(f.bodyEastAsia, f.bodyLatin);
  const head = rFonts(f.headEastAsia, f.headLatin);
  const bodyRPr = `${body}${sz(f.bodyHalfPt)}`;
  // 首行缩进两个都写：firstLineChars 按字符数（字号变了跟着变），firstLine 给不认前者的程序
  const firstLine = m.para.firstLineChars * f.bodyHalfPt * 10;
  const defaults = `<w:docDefaults><w:rPrDefault><w:rPr>${body}${sz(f.bodyHalfPt)}<w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>` +
    // 孤行控制；标点不溢出版心
    `<w:pPrDefault><w:pPr><w:widowControl/><w:overflowPunct w:val="0"/></w:pPr></w:pPrDefault></w:docDefaults>`;
  const normal = `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr>${bodyRPr}</w:rPr></w:style>`;
  // 缩进放在 BodyText 上而不是 Normal 上：表格、列表、页脚才不会继承到
  const bodyText = style('BodyText', 'Body Text', '<w:basedOn w:val="Normal"/><w:qFormat/>',
    `${spacing(m.para.beforeTw, m.para.afterTw, m.para.line240)}` +
    `<w:ind w:firstLineChars="${m.para.firstLineChars * 100}" w:firstLine="${firstLine}"/><w:jc w:val="both"/>`, bodyRPr);
  // 黑体没有粗体字重，标题不加粗；标题与下段同页、自身不拆
  const heads = [1, 2, 3, 4, 5, 6].map(n => style(`Heading${n}`, `heading ${n}`,
    '<w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/>',
    `<w:keepNext/><w:keepLines/>${spacing(D.headBeforeTw[n - 1], D.headAfterTw[n - 1], D.headLine240)}` +
    `<w:jc w:val="${n === 1 ? 'center' : 'left'}"/><w:outlineLvl w:val="${n - 1}"/>`,
    `${head}${sz(f.headHalfPt[n - 1])}`)).join('');
  const list = style('ListParagraph', 'List Paragraph', '<w:basedOn w:val="Normal"/><w:qFormat/>',
    `${spacing(0, 0, m.para.line240)}<w:jc w:val="both"/>`, bodyRPr);
  const table = style('TableText', 'Table Text', '<w:basedOn w:val="Normal"/><w:qFormat/>',
    `${spacing(0, 0, 240)}<w:jc w:val="left"/>`, `${body}${sz(f.tableHalfPt)}`);
  const footer = style('Footer', 'footer', '<w:basedOn w:val="Normal"/>',
    `${spacing(0, 0, 240)}<w:jc w:val="center"/>`, `${body}${sz(D.footerHalfPt)}`);
  // 间隔段落：1 磅的字、固定行高。具体行高由用它的段落自己写
  const gap = style('DmGap', 'DmGap', '<w:basedOn w:val="Normal"/><w:semiHidden/>',
    spacing(0, 0, D.gapTinyTw, 'exact'), `${body}${sz(2)}`);
  return `${XML}<w:styles ${W_NS}>${defaults}${normal}${bodyText}${heads}${list}${table}${footer}${gap}</w:styles>`;
}

export function settingsXml(): string {
  const compat = (name: string, val: string): string =>
    `<w:compatSetting w:name="${name}" w:uri="http://schemas.microsoft.com/office/word" w:val="${val}"/>`;
  return `${XML}<w:settings ${W_NS}><w:defaultTabStop w:val="${D.defaultTabStopTw}"/>` +
    // 标点压缩
    `<w:characterSpacingControl w:val="compressPunctuation"/>` +
    `<w:compat><w:useFELayout/>${compat('compatibilityMode', '15')}${compat('overrideTableStyleFontSizeAndJustification', '1')}` +
    `${compat('enableOpenTypeFeatures', '1')}${compat('doNotFlipMirrorIndents', '1')}${compat('differentiateMultirowTableHeaders', '1')}</w:compat>` +
    `<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/></w:settings>`;
}

/** 这份文档用到的字体，去重，顺序固定。 */
export function docxFontsUsed(m: DocxModel): (DocxCjkFont | DocxLatinFont)[] {
  const f = m.fonts;
  const all: (DocxCjkFont | DocxLatinFont)[] = [f.bodyEastAsia, f.bodyLatin, f.headEastAsia, f.headLatin];
  if (hasBullets(m)) all.push(BULLET_FONT);
  return all.filter((x, i) => all.indexOf(x) === i);
}

export function fontTableXml(m: DocxModel): string {
  const fonts = docxFontsUsed(m).map(n => {
    const d = DOCX_FONTS[n];
    return `<w:font w:name="${d.name}">${d.altName ? `<w:altName w:val="${d.altName}"/>` : ''}` +
      `<w:charset w:val="${d.charset}"/><w:family w:val="${d.family}"/><w:pitch w:val="${d.pitch}"/></w:font>`;
  }).join('');
  return `${XML}<w:fonts ${W_NS}>${fonts}</w:fonts>`;
}

/** 列表：两个抽象定义（无序 ● ○ ■；有序 1. （1） a)），**每个 list 块一个 w:num**。
 *  有序的带三级 startOverride——否则第二个有序列表接着第一个往下数。
 *  编号起点与正文首行对齐：第 L 级左缩进 2 字 ×(L+2)、悬挂 2 字。 */
export function numberingXml(m: DocxModel): string {
  const ch2 = 2 * m.fonts.bodyHalfPt * 10;
  const bf = DOCX_FONTS[BULLET_FONT].name;
  const lvl = (i: number, fmt: string, text: string, symbol: boolean): string =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${ch2 * (i + 2)}" w:hanging="${ch2}"/></w:pPr>` +
    (symbol ? `<w:rPr><w:rFonts w:ascii="${bf}" w:hAnsi="${bf}" w:eastAsia="${bf}" w:cs="${bf}" w:hint="eastAsia"/></w:rPr>` : '') + `</w:lvl>`;
  const bullets = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>` +
    `${lvl(0, 'bullet', '●', true)}${lvl(1, 'bullet', '○', true)}${lvl(2, 'bullet', '■', true)}</w:abstractNum>`;
  const ordered = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>` +
    `${lvl(0, 'decimal', '%1.', false)}${lvl(1, 'decimal', '（%2）', false)}${lvl(2, 'lowerLetter', '%3)', false)}</w:abstractNum>`;
  const nums = m.blocks.map(b => {
    if (b.kind !== 'list') return '';
    const over = b.ordered
      ? [0, 1, 2].map(l => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('')
      : '';
    return `<w:num w:numId="${b.numId}"><w:abstractNumId w:val="${b.ordered ? 1 : 0}"/>${over}</w:num>`;
  }).join('');
  return `${XML}<w:numbering ${W_NS}>${bullets}${ordered}${nums}</w:numbering>`;
}

/** 页脚：居中的 PAGE 域。缓存值写 1，Word 打开时自己重算。 */
export function footerXml(): string {
  return `${XML}<w:ftr ${W_NS}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
}

/** title 进文档属性，不进正文。不写作者、不写任何时间：产出可复现。 */
export function corePropsXml(m: DocxModel): string {
  return `${XML}<cp:coreProperties xmlns:cp="${PKG}/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `${m.title !== undefined ? `<dc:title>${esc(m.title)}</dc:title>` : ''}</cp:coreProperties>`;
}

/** Application 一栏是本生成器的标记：覆盖已有文件前靠它认出「这是自己原样生成的文档」。 */
export const DOCX_APPLICATION = 'DeskMinis';
export function appPropsXml(): string {
  return `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
    `<Application>${DOCX_APPLICATION}</Application></Properties>`;
}

export function contentTypesXml(m: DocxModel): string {
  const ov: [string, string][] = [
    ['/word/document.xml', `${CT}.wordprocessingml.document.main+xml`],
    ['/word/styles.xml', `${CT}.wordprocessingml.styles+xml`],
    ['/word/settings.xml', `${CT}.wordprocessingml.settings+xml`],
    ['/word/fontTable.xml', `${CT}.wordprocessingml.fontTable+xml`],
  ];
  if (hasNumbering(m)) ov.push(['/word/numbering.xml', `${CT}.wordprocessingml.numbering+xml`]);
  if (hasFooter(m)) ov.push(['/word/footer1.xml', `${CT}.wordprocessingml.footer+xml`]);
  ov.push(['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', `${CT}.extended-properties+xml`]);
  return `${XML}<Types xmlns="${PKG}/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    ov.map(([n, t]) => `<Override PartName="${n}" ContentType="${t}"/>`).join('') + `</Types>`;
}

export function rootRelsXml(): string {
  return `${XML}<Relationships xmlns="${PKG}/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="${PKG}/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

/** 页脚的关系 Id：正文的 sectPr 用它引页脚。 */
export const FOOTER_REL_ID = 'rIdFooter1';
export function documentRelsXml(m: DocxModel): string {
  const rels: [string, string, string][] = [
    ['rIdStyles', 'styles', 'styles.xml'], ['rIdSettings', 'settings', 'settings.xml'], ['rIdFontTable', 'fontTable', 'fontTable.xml'],
  ];
  if (hasNumbering(m)) rels.push(['rIdNumbering', 'numbering', 'numbering.xml']);
  if (hasFooter(m)) rels.push([FOOTER_REL_ID, 'footer', 'footer1.xml']);
  return `${XML}<Relationships xmlns="${PKG}/relationships">` +
    rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('') + `</Relationships>`;
}
