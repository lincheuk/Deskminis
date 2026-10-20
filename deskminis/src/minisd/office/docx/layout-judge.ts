/** 真实 Word 量测的类型与判定（F10A）。
 *
 *  **产品运行时不调用这里的任何东西**（产品不启动 Office）。使用者是单测与取证管线：
 *  取证脚本只量不判，把 Word 对象模型的读数、导出 PDF 的页数 / 字体 / 文字层、逐页 PNG 的墨迹位置交回来；
 *  「合不合格」由这里的纯函数判——所以判定可以单测、可以对存档的量测重判，许可到期之后仍能证明「检查会红」。
 *
 *  期望值由 `expectationsOf(model)` 从模型算出来，不是从 Word 抄回来的。容差单位是磅。
 *
 *  没量到的读数（某个属性读不出、PDF 字体名取不到）记 `unmeasured`，不混同于不合格。 */
import type { OfficeCheckItem } from '../../../shared/office-verification';
import type { DocxModel, DocxCjkFont, DocxLatinFont } from './model';
import { DOCX_DEFAULTS as D, DOCX_FONTS } from './layout';
import { docxFontsUsed } from './parts';

// ---------------- 量测（render-word.ps1 写出的 measured，加驱动补的 PDF 与墨迹） ----------------

export interface DocxMeasuredParagraph {
  i: number;
  /** 文本前 40 个字符（含段落标记） */
  text: string;
  empty: boolean;
  style: string | null;
  farEast: string; ascii: string; size: number;
  /** 0 左，1 居中，2 右，3 两端 */
  align: number;
  firstLineChars: number; firstLineIndent: number;
  lineRule: number; lineSpacing: number;
  before: number; after: number; leftIndent: number;
  /** Word 的布尔属性读回是 -1 / 0 */
  keepNext: number; keepTogether: number; pageBreakBefore: number;
  startPage: number; endPage: number;
  /** 下一个非空块首字符所在页；没有下一块时为 null */
  nextPage: number | null;
  listString: string | null; listLevel: number | null;
}
export interface DocxMeasuredTable {
  i: number; rows: number; cols: number;
  leftIndent: number | null;
  allowAutoFit: boolean | null;
  colWidths: number[] | null;
  firstCell: { text: string; farEast: string; ascii: string; size: number } | null;
  rowInfo: { heading: number; allowBreak: number; startPage: number; endPage: number }[];
}
export interface DocxInkBand { dark: number; bbox: [number, number, number, number] | null }
export interface DocxInkPage { page: number; nonWhiteRatio: number; all: DocxInkBand; left: DocxInkBand; right: DocxInkBand; top: DocxInkBand; bottom: DocxInkBand }
export interface DocxMeasurement {
  compatMode: number;
  pages: number;
  section: { pageWidth: number; pageHeight: number; orientation: number; top: number; bottom: number; left: number; right: number; header?: number; footer?: number };
  /** 页脚里各个域的类型（PAGE = 33）；读不出时为 null */
  footerFieldTypes: number[] | null;
  docTitle: string | null;
  /** 全部正文级段落（不在表格里的每一个段落，含分页符与间隔段落），按出现序 */
  paragraphs: DocxMeasuredParagraph[];
  paragraphsTruncated?: boolean;
  tables: DocxMeasuredTable[];
  /** Content.Text */
  text: string;
  lastContentPage: number | null;
  // ---- 驱动补的四样；取不到为 null / 缺省
  pdfPages?: number | null;
  /** PDF 里嵌入的字体名（PostScript 名，已去掉子集前缀） */
  pdfFonts?: string[] | null;
  /** 逐页的文字层；某一页取不出时该项为 null */
  pdfText?: (string | null)[] | null;
  /** 逐页 PNG 的墨迹位置（png-ink.ps1） */
  ink?: DocxInkPage[] | null;
}

// ---------------- 期望 ----------------

export interface DocxExpectedParagraph {
  kind: 'heading' | 'para' | 'list' | 'gap' | 'pageBreak';
  text: string;
  /** 所属的输入块在模型 blocks 里的序号 */
  block: number;
  level?: number;
  farEast?: DocxCjkFont; ascii?: DocxLatinFont; sizePt?: number;
  align?: number; firstLineChars?: number; lineSpacingPt?: number;
  beforePt?: number; afterPt?: number;
  keepNext?: boolean; keepTogether?: boolean; pageBreakBefore?: boolean;
  /** 列表项：应读回的标号与级别（从 1 起） */
  listString?: string; listLevel?: number;
}
export interface DocxExpectedTable {
  block: number;
  colsPt: number[];
  rows: number;
  headerRows: number;
  cantSplit: boolean[];
}
export interface DocxExpectation {
  compatMode: number;
  page: { widthPt: number; heightPt: number; landscape: boolean; topPt: number; rightPt: number; bottomPt: number; leftPt: number; footerPt: number; textWidthPt: number };
  pageNumber: boolean;
  title: string;
  fonts: { bodyEastAsia: DocxCjkFont; bodyLatin: DocxLatinFont; headEastAsia: DocxCjkFont; headLatin: DocxLatinFont; tablePt: number };
  /** PDF 里允许出现的字体（模型用到的全部）与必须出现的中文字体（有中文字的地方用到的） */
  pdfFontsAllowed: (DocxCjkFont | DocxLatinFont)[];
  pdfFontsRequired: DocxCjkFont[];
  /** 正文级段落，按出现序，与量测的 paragraphs 一一对应 */
  paragraphs: DocxExpectedParagraph[];
  tables: DocxExpectedTable[];
  /** 按文档顺序排的内容块：每块对应哪些段落 / 哪张表，以及它是不是必须另起一页 */
  blocks: { paragraphs: number[]; table?: number; newPage: boolean }[];
  /** 每个块的文字，按顺序（表格逐格）：真实 Word 读出的全文里必须依次出现 */
  texts: string[];
  /** 模型全部文字里每个字符（只计字母、数字、汉字，先做 NFKC）的出现次数 */
  chars: Record<string, number>;
  /** 整份文档没有任何看得见的内容（空文档）：不要求页面上有墨迹 */
  blank: boolean;
  // ---- 夹具附加（首轮实测后钉住的回归值）
  pages?: number;
  /** 这些表（按出现序的序号）必须跨至少两页 */
  tablesSpanPages?: number[];
  /** 这些行（[表序号, 行序号]）必须首尾不同页 */
  splitRows?: [number, number][];
}

const ALIGN: Record<string, number> = { left: 0, center: 1, right: 2, justify: 3 };
const pt = (tw: number): number => tw / 20;
const HAS_CJK = /[⺀-鿿豈-﫿︰-￯]/;
const COUNTED = /[\p{L}\p{N}]/u;
/** 只计字母、数字、汉字；两边先做 NFKC（全角数字、兼容字形归一）。 */
function countChars(s: string, into: Record<string, number>): void {
  for (const ch of s.normalize('NFKC')) if (COUNTED.test(ch)) into[ch] = (into[ch] ?? 0) + 1;
}
const ORDERED_LABEL = [(n: number): string => `${n}.`, (n: number): string => `（${n}）`, (n: number): string => `${String.fromCharCode(96 + ((n - 1) % 26) + 1)})`];
const BULLETS = ['●', '○', '■'];

/** 由模型推出期望。夹具再附加 pages / tablesSpanPages / splitRows。 */
export function expectationsOf(model: DocxModel): DocxExpectation {
  const f = model.fonts;
  const p = model.page;
  const paragraphs: DocxExpectedParagraph[] = [];
  const tables: DocxExpectedTable[] = [];
  const blocks: DocxExpectation['blocks'] = [];
  const texts: string[] = [];
  const chars: Record<string, number> = {};
  let needBody = false;
  let needHead = false;
  let breakPending = false;
  const body = { farEast: f.bodyEastAsia, ascii: f.bodyLatin, sizePt: f.bodyHalfPt / 2 };
  const addText = (s: string, heading: boolean): void => {
    texts.push(s);
    countChars(s, chars);
    if (HAS_CJK.test(s)) { if (heading) needHead = true; else needBody = true; }
  };
  model.blocks.forEach((b, bi) => {
    const at = paragraphs.length;
    if (b.kind === 'heading') {
      paragraphs.push({
        kind: 'heading', text: b.text, block: bi, level: b.level, farEast: f.headEastAsia, ascii: f.headLatin, sizePt: f.headHalfPt[b.level - 1] / 2,
        beforePt: pt(D.headBeforeTw[b.level - 1]), afterPt: pt(D.headAfterTw[b.level - 1]),
        keepNext: true, keepTogether: true, pageBreakBefore: b.pageBreakBefore,
      });
      blocks.push({ paragraphs: [at], newPage: breakPending || b.pageBreakBefore });
      breakPending = false;
      addText(b.text, true);
    } else if (b.kind === 'para') {
      const off = b.align === 'center' || b.align === 'right';
      paragraphs.push({
        kind: 'para', text: b.text, block: bi, ...body, align: ALIGN[b.align], firstLineChars: off ? 0 : model.para.firstLineChars,
        lineSpacingPt: pt(model.para.line240), beforePt: pt(model.para.beforeTw), afterPt: pt(model.para.afterTw),
        keepNext: b.keepWithNext, keepTogether: false, pageBreakBefore: false,
      });
      blocks.push({ paragraphs: [at], newPage: breakPending });
      breakPending = false;
      addText(b.text, false);
    } else if (b.kind === 'list') {
      const counters: number[] = [];
      const idx: number[] = [];
      for (const it of b.items) {
        counters[it.level] = (counters[it.level] ?? 0) + 1;
        counters.length = it.level + 1;
        idx.push(paragraphs.length);
        paragraphs.push({
          kind: 'list', text: it.text, block: bi, ...body, beforePt: 0, afterPt: 0, keepNext: false, keepTogether: false, pageBreakBefore: false,
          listString: b.ordered ? ORDERED_LABEL[it.level](counters[it.level]) : BULLETS[it.level], listLevel: it.level + 1,
        });
        addText(it.text, false);
      }
      blocks.push({ paragraphs: idx, newPage: breakPending });
      breakPending = false;
    } else if (b.kind === 'pageBreak') {
      paragraphs.push({ kind: 'pageBreak', text: '', block: bi });
      breakPending = true;
    } else {
      const ti = tables.length;
      tables.push({ block: bi, colsPt: b.colsTw.map(pt), rows: b.rows.length, headerRows: b.headerRows, cantSplit: [...b.cantSplit] });
      blocks.push({ paragraphs: [], table: ti, newPage: breakPending });
      breakPending = false;
      for (const r of b.rows) for (const c of r) addText(c, false);
      const next = model.blocks[bi + 1];
      if (next === undefined || next.kind === 'table') paragraphs.push({ kind: 'gap', text: '', block: bi });
    }
  });
  // 没有任何块时正文里有一个空的 BodyText 段落
  if (model.blocks.length === 0) {
    paragraphs.push({
      kind: 'para', text: '', block: -1, ...body, align: ALIGN.justify, firstLineChars: model.para.firstLineChars, lineSpacingPt: pt(model.para.line240),
      beforePt: pt(model.para.beforeTw), afterPt: pt(model.para.afterTw), keepNext: false, keepTogether: false, pageBreakBefore: false,
    });
  }
  const required: DocxCjkFont[] = [];
  if (needBody) required.push(f.bodyEastAsia);
  if (needHead && !required.includes(f.headEastAsia)) required.push(f.headEastAsia);
  return {
    compatMode: 15,
    page: {
      widthPt: pt(p.widthTw), heightPt: pt(p.heightTw), landscape: p.landscape,
      topPt: pt(p.marginTw.top), rightPt: pt(p.marginTw.right), bottomPt: pt(p.marginTw.bottom), leftPt: pt(p.marginTw.left),
      footerPt: pt(p.footerTw), textWidthPt: pt(p.textWidthTw),
    },
    pageNumber: p.pageNumber !== 'none',
    title: model.title ?? '',
    fonts: { bodyEastAsia: f.bodyEastAsia, bodyLatin: f.bodyLatin, headEastAsia: f.headEastAsia, headLatin: f.headLatin, tablePt: f.tableHalfPt / 2 },
    pdfFontsAllowed: docxFontsUsed(model),
    pdfFontsRequired: required,
    paragraphs, tables, blocks, texts, chars,
    blank: texts.every(t => t.trim() === ''),
  };
}

// ---------------- 判定 ----------------

/** PDF 里的 PostScript 字体名 → 白名单里的字体。 */
const PDF_FONT_PATTERNS: [RegExp, DocxCjkFont | DocxLatinFont][] = [
  [/^N?SimSun/i, '宋体'], [/^SimHei/i, '黑体'], [/^MicrosoftYaHei/i, '微软雅黑'], [/^FangSong/i, '仿宋'], [/^KaiTi/i, '楷体'], [/^DengXian/i, '等线'],
  [/^TimesNewRoman/i, 'Times New Roman'], [/^Arial/i, 'Arial'], [/^Calibri/i, 'Calibri'],
];
/** 认得出是中日韩字体、但不在白名单里的名字：出现即算「计划外的中文字体」。 */
const OTHER_CJK_FONT = /^(ST(Song|Hei|Kai|Fang|Zhong|Xi|Xin)|FZ|Microsoft-?JhengHei|P?MingLiU|MS-?(P?Gothic|P?Mincho)|Yu(Gothic|Mincho)|Meiryo|Malgun|Batang|Gulim|LiSu|YouYuan|Noto(Sans|Serif)(CJK|SC|TC|JP|KR)|SourceHan)/i;
const pdfFontOf = (name: string): DocxCjkFont | DocxLatinFont | undefined => PDF_FONT_PATTERNS.find(([re]) => re.test(name))?.[1];
const isCjkFont = (x: DocxCjkFont | DocxLatinFont): x is DocxCjkFont => DOCX_FONTS[x].charset === '86';

/** Word 读回的字体名按别名表比：中文名或它的英文别名都算；`+中文正文` 之类的主题名一律不符。 */
function sameFont(actual: string, want: DocxCjkFont | DocxLatinFont): boolean {
  const d = DOCX_FONTS[want];
  const a = actual.trim().toLowerCase();
  return a === d.name.toLowerCase() || (d.altName !== undefined && a === d.altName.toLowerCase());
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
const yes = (v: number): boolean => v !== 0;
/** 去空白与控制符（含 Word 的单元格标记、换行、分页符），供全文比较。 */
const squash = (s: string): string => s.replace(/[\s\u0000-\u001f\u007f]/g, '');
const show = (s: string): string => JSON.stringify(s.replace(/[\r\u0007]/g, '').slice(0, 20));

/** 一项检查的收集器：记下第一处不符；一处都没有就是通过。 */
class Check {
  private bad: { where?: string; expected?: string; actual?: string } | null = null;
  private missing: string | null = null;
  constructor(readonly id: string) {}
  fail(where: string, expected: string, actual: string): void { if (!this.bad) this.bad = { where, expected, actual }; }
  /** 这一项的读数没有量到 */
  unmeasured(what: string): void { if (!this.missing) this.missing = what; }
  item(): OfficeCheckItem {
    if (this.bad) return { id: this.id, ok: false, ...this.bad };
    if (this.missing) return { id: this.id, ok: false, unmeasured: true, actual: '未量测', where: this.missing };
    return { id: this.id, ok: true };
  }
}

/** 把量测对着期望逐项判。只判，不改量测；每个检查 id 恰好交回一项。 */
export function judgeDocxLayout(m: DocxMeasurement, e: DocxExpectation): OfficeCheckItem[] {
  const ids = ['open', 'compat-mode', 'paper', 'margins', 'font-body', 'font-heading', 'font-table', 'fonts-pdf', 'heading-size', 'para-format',
    'para-spacing', 'table-bounds', 'table-col-widths', 'ink-outside', 'table-header-repeat', 'row-split', 'row-allow-split', 'heading-with-next',
    'keep-with-next', 'page-break', 'page-number', 'list-restart', 'text-complete', 'text-rendered', 'no-trailing-blank', 'page-count', 'doc-title'] as const;
  const c = Object.fromEntries(ids.map(id => [id, new Check(id)])) as Record<(typeof ids)[number], Check>;

  // ---- 文档级
  if (m.compatMode !== e.compatMode) c['compat-mode'].fail('文档', String(e.compatMode), String(m.compatMode));
  const s = m.section;
  if (!near(s.pageWidth, e.page.widthPt, 0.5) || !near(s.pageHeight, e.page.heightPt, 0.5) || yes(s.orientation) !== e.page.landscape) {
    c.paper.fail('第 1 节', `${e.page.widthPt}×${e.page.heightPt} 磅${e.page.landscape ? '，横向' : ''}`, `${s.pageWidth}×${s.pageHeight} 磅${yes(s.orientation) ? '，横向' : ''}`);
  }
  for (const [name, got, want] of [['上', s.top, e.page.topPt], ['下', s.bottom, e.page.bottomPt], ['左', s.left, e.page.leftPt], ['右', s.right, e.page.rightPt]] as const) {
    if (!near(got, want, 0.5)) c.margins.fail(`${name}边距`, `${want} 磅`, `${got} 磅`);
  }
  if (m.docTitle === null || m.docTitle === undefined) c['doc-title'].unmeasured('文档标题读不出');
  else if (m.docTitle !== e.title) c['doc-title'].fail('文档属性', show(e.title), show(m.docTitle));

  // ---- 正文级段落：按出现序一一对应
  const mp = m.paragraphs;
  const ep = e.paragraphs;
  const paired = Math.min(mp.length, ep.length);
  for (let i = 0; i < paired; i++) {
    const g = mp[i];
    const w = ep[i];
    const where = `第 ${i + 1} 个段落 ${show(w.text || g.text)}`;
    if (w.kind === 'gap' || w.kind === 'pageBreak') continue;
    // 字体
    if (w.farEast && w.ascii) {
      const fc = w.kind === 'heading' ? c['font-heading'] : c['font-body'];
      if (!sameFont(g.farEast, w.farEast) || !sameFont(g.ascii, w.ascii)) fc.fail(where, `${w.farEast} / ${w.ascii}`, `${g.farEast} / ${g.ascii}`);
      if (w.sizePt !== undefined && !near(g.size, w.sizePt, 0.01)) {
        (w.kind === 'heading' ? c['heading-size'] : c['font-body']).fail(where, `${w.sizePt} 磅`, `${g.size} 磅`);
      }
    }
    // 正文段落的首行缩进、行距、对齐
    if (w.kind === 'para') {
      if (w.firstLineChars !== undefined && !near(g.firstLineChars, w.firstLineChars, 0.01)) c['para-format'].fail(where, `首行缩进 ${w.firstLineChars} 字符`, `${g.firstLineChars} 字符`);
      if (w.lineSpacingPt !== undefined && !near(g.lineSpacing, w.lineSpacingPt, 0.1)) c['para-format'].fail(where, `行距 ${w.lineSpacingPt} 磅`, `${g.lineSpacing} 磅`);
      if (w.align !== undefined && g.align !== w.align) c['para-format'].fail(where, `对齐 ${w.align}`, `对齐 ${g.align}`);
    }
    if (w.beforePt !== undefined && w.afterPt !== undefined && (!near(g.before, w.beforePt, 0.1) || !near(g.after, w.afterPt, 0.1))) {
      c['para-spacing'].fail(where, `段前 ${w.beforePt} / 段后 ${w.afterPt} 磅`, `段前 ${g.before} / 段后 ${g.after} 磅`);
    }
    if (w.keepNext !== undefined && (yes(g.keepNext) !== w.keepNext || yes(g.keepTogether) !== w.keepTogether || yes(g.pageBreakBefore) !== w.pageBreakBefore)) {
      c['keep-with-next'].fail(where, `与下段同页 ${w.keepNext} / 段中不分页 ${w.keepTogether} / 段前分页 ${w.pageBreakBefore}`,
        `${yes(g.keepNext)} / ${yes(g.keepTogether)} / ${yes(g.pageBreakBefore)}`);
    }
    // 标题末字符与下一非空块首字符同页
    if (w.kind === 'heading' && g.nextPage !== null && g.nextPage !== undefined && g.endPage !== g.nextPage) {
      c['heading-with-next'].fail(where, `与下一块同在第 ${g.endPage} 页`, `下一块在第 ${g.nextPage} 页`);
    }
    if (w.kind === 'list') {
      if (g.listString === null || g.listLevel === null) c['list-restart'].unmeasured(`${where} 的列表标号读不出`);
      else if (g.listString !== w.listString || g.listLevel !== w.listLevel) {
        c['list-restart'].fail(where, `标号 ${w.listString}，第 ${w.listLevel} 级`, `标号 ${g.listString}，第 ${g.listLevel} 级`);
      }
    }
  }

  // ---- 表格
  if (m.tables.length !== e.tables.length) c['table-col-widths'].fail('文档', `${e.tables.length} 张表`, `${m.tables.length} 张表`);
  const tn = Math.min(m.tables.length, e.tables.length);
  for (let t = 0; t < tn; t++) {
    const g = m.tables[t];
    const w = e.tables[t];
    const where = `第 ${t + 1} 张表`;
    if (g.firstCell === null) c['font-table'].unmeasured(`${where}的首格读不出`);
    else {
      if (!sameFont(g.firstCell.farEast, e.fonts.bodyEastAsia) || !sameFont(g.firstCell.ascii, e.fonts.bodyLatin)) {
        c['font-table'].fail(`${where}首格`, `${e.fonts.bodyEastAsia} / ${e.fonts.bodyLatin}`, `${g.firstCell.farEast} / ${g.firstCell.ascii}`);
      }
      if (!near(g.firstCell.size, e.fonts.tablePt, 0.01)) c['font-table'].fail(`${where}首格`, `${e.fonts.tablePt} 磅`, `${g.firstCell.size} 磅`);
    }
    if (g.leftIndent === null || g.colWidths === null) {
      c['table-bounds'].unmeasured(`${where}的缩进或列宽读不出`);
      c['table-col-widths'].unmeasured(`${where}的列宽读不出`);
    } else {
      const sum = g.colWidths.reduce((a, b) => a + b, 0);
      if (g.leftIndent < -0.5) c['table-bounds'].fail(where, '左缩进 ≥ 0', `左缩进 ${g.leftIndent} 磅`);
      if (g.leftIndent + sum > e.page.textWidthPt + 1) c['table-bounds'].fail(where, `不超过版心宽 ${e.page.textWidthPt} 磅`, `左缩进 ${g.leftIndent} + 列宽合计 ${sum.toFixed(2)} 磅`);
      if (g.colWidths.length !== w.colsPt.length) c['table-col-widths'].fail(where, `${w.colsPt.length} 列`, `${g.colWidths.length} 列`);
      else g.colWidths.forEach((x, ci) => { if (!near(x, w.colsPt[ci], 1)) c['table-col-widths'].fail(`${where}第 ${ci + 1} 列`, `${w.colsPt[ci]} 磅`, `${x} 磅`); });
    }
    if (g.allowAutoFit === null) c['table-col-widths'].unmeasured(`${where}的自动调整读不出`);
    else if (g.allowAutoFit) c['table-col-widths'].fail(where, '固定列宽', '允许自动调整');
    if (g.rowInfo.length !== w.rows) c['table-col-widths'].fail(where, `${w.rows} 行`, `${g.rowInfo.length} 行`);
    const rn = Math.min(g.rowInfo.length, w.rows);
    for (let r = 0; r < rn; r++) {
      const row = g.rowInfo[r];
      const rw = `${where}第 ${r + 1} 行`;
      if (yes(row.heading) !== (r < w.headerRows)) c['table-header-repeat'].fail(rw, r < w.headerRows ? '表头行（跨页重复）' : '不是表头行', yes(row.heading) ? '表头行' : '不是表头行');
      if (yes(row.allowBreak) === w.cantSplit[r]) c['row-allow-split'].fail(rw, w.cantSplit[r] ? '不允许跨页断开' : '允许跨页断开', yes(row.allowBreak) ? '允许' : '不允许');
      if (w.cantSplit[r] && row.startPage !== row.endPage) c['row-split'].fail(rw, '首尾同页', `第 ${row.startPage}–${row.endPage} 页`);
    }
  }
  for (const t of e.tablesSpanPages ?? []) {
    const g = m.tables[t];
    if (!g || g.rowInfo.length === 0) c['table-header-repeat'].fail(`第 ${t + 1} 张表`, '跨至少两页', '没有这张表');
    else if (g.rowInfo[g.rowInfo.length - 1].endPage - g.rowInfo[0].startPage < 1) c['table-header-repeat'].fail(`第 ${t + 1} 张表`, '跨至少两页', '只在一页里');
  }
  for (const [t, r] of e.splitRows ?? []) {
    const row = m.tables[t]?.rowInfo[r];
    if (!row) c['row-split'].fail(`第 ${t + 1} 张表第 ${r + 1} 行`, '跨页断开', '没有这一行');
    else if (row.startPage === row.endPage) c['row-split'].fail(`第 ${t + 1} 张表第 ${r + 1} 行`, '跨页断开', `整行在第 ${row.startPage} 页`);
  }

  // ---- 分页：分页符 / 段前分页之后的块，起始页 = 之前的块结束页 + 1
  const span = (b: DocxExpectation['blocks'][number]): { start: number; end: number } | null => {
    if (b.table !== undefined) {
      const rows = m.tables[b.table]?.rowInfo;
      return rows && rows.length > 0 ? { start: rows[0].startPage, end: rows[rows.length - 1].endPage } : null;
    }
    const first = mp[b.paragraphs[0]];
    const last = mp[b.paragraphs[b.paragraphs.length - 1]];
    return first && last ? { start: first.startPage, end: last.endPage } : null;
  };
  e.blocks.forEach((b, bi) => {
    if (!b.newPage || bi === 0) return;
    const cur = span(b);
    const prev = span(e.blocks[bi - 1]);
    if (!cur || !prev) return;
    if (cur.start !== prev.end + 1) c['page-break'].fail(`第 ${bi + 1} 块`, `从第 ${prev.end + 1} 页开始`, `从第 ${cur.start} 页开始`);
  });

  // ---- 全文：每个块的文字按顺序都出现；正文级段落的个数对得上
  const all = squash(m.text);
  let cursor = 0;
  for (let i = 0; i < e.texts.length; i++) {
    const piece = squash(e.texts[i]);
    if (piece === '') continue;
    const at = all.indexOf(piece, cursor);
    if (at < 0) { c['text-complete'].fail(`第 ${i + 1} 段文字`, show(e.texts[i]), '全文里没有（或顺序不对）'); break; }
    cursor = at + piece.length;
  }
  if (!m.paragraphsTruncated && mp.length !== ep.length) c['text-complete'].fail('正文级段落', `${ep.length} 个`, `${mp.length} 个`);

  // ---- 画到页面上的字：按字符计数比 PDF 的文字层
  if (!m.pdfText || m.pdfText.some(t => t === null)) c['text-rendered'].unmeasured('PDF 的文字层取不出');
  else {
    const got: Record<string, number> = {};
    for (const t of m.pdfText) countChars(t as string, got);
    const lacking = Object.entries(e.chars).map(([ch, n]) => [ch, n - (got[ch] ?? 0)] as const).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
    if (lacking.length > 0) {
      c['text-rendered'].fail('PDF 文字层', '每个字都画在页面上', `少了 ${lacking.reduce((a, [, d]) => a + d, 0)} 个字：${lacking.slice(0, 5).map(([ch, d]) => `${ch}×${d}`).join(' ')}`);
    }
  }

  // ---- PDF 里嵌入的字体
  if (e.pdfFontsRequired.length > 0 || (m.pdfFonts && m.pdfFonts.length > 0)) {
    if (!m.pdfFonts || m.pdfFonts.length === 0) c['fonts-pdf'].unmeasured('PDF 的字体名读不出');
    else {
      const seen = new Set<DocxCjkFont | DocxLatinFont>();
      for (const name of m.pdfFonts) {
        const known = pdfFontOf(name);
        if (known) seen.add(known);
        const cjk = known ? isCjkFont(known) : OTHER_CJK_FONT.test(name);
        if (cjk && !(known && e.pdfFontsAllowed.includes(known))) c['fonts-pdf'].fail('PDF', `中文字体只有 ${e.pdfFontsAllowed.filter(isCjkFont).join('、') || '无'}`, `出现了 ${name}`);
      }
      for (const need of e.pdfFontsRequired) if (!seen.has(need)) c['fonts-pdf'].fail('PDF', `嵌入 ${need}`, `只有 ${m.pdfFonts.join('、')}`);
    }
  }

  // ---- 页面上的墨迹
  if (!m.ink || m.ink.length === 0) {
    c['ink-outside'].unmeasured('没有逐页 PNG 的墨迹读数');
    c['page-number'].unmeasured('没有逐页 PNG 的墨迹读数');
  } else {
    // 页脚那一行所在的竖直范围：页脚下缘在「页高 − 页脚距」，小五的一行字不超过 16 磅高
    const footLo = e.page.heightPt - e.page.footerPt - 16;
    const footHi = e.page.heightPt - e.page.footerPt + 3;
    for (const pg of m.ink) {
      const where = `第 ${pg.page} 页`;
      for (const [name, band] of [['左', pg.left], ['右', pg.right], ['上', pg.top]] as const) {
        if (band.dark > 0) c['ink-outside'].fail(`${where}${name}页边`, '没有墨迹', `${band.dark} 个深色像素${band.bbox ? `，范围 ${band.bbox.join(',')} 磅` : ''}`);
      }
      if (e.pageNumber) {
        if (pg.bottom.dark === 0) c['page-number'].fail(`${where}页脚`, '有页码', '没有墨迹');
        else if (pg.bottom.bbox && (pg.bottom.bbox[1] < footLo || pg.bottom.bbox[3] > footHi)) {
          c['ink-outside'].fail(`${where}下页边`, `只有页脚那一行（${footLo.toFixed(1)}–${footHi.toFixed(1)} 磅）`, `墨迹在 ${pg.bottom.bbox[1]}–${pg.bottom.bbox[3]} 磅`);
        }
      } else if (pg.bottom.dark > 0) {
        c['ink-outside'].fail(`${where}下页边`, '没有墨迹', `${pg.bottom.dark} 个深色像素`);
      }
    }
  }
  if (m.footerFieldTypes === null || m.footerFieldTypes === undefined) c['page-number'].unmeasured('页脚的域读不出');
  else if (m.footerFieldTypes.includes(33) !== e.pageNumber) c['page-number'].fail('页脚', e.pageNumber ? '有 PAGE 域' : '没有 PAGE 域', m.footerFieldTypes.includes(33) ? '有 PAGE 域' : '没有 PAGE 域');

  // ---- 页数
  const lastContent = m.lastContentPage ?? (e.blank ? 1 : null);
  if (lastContent === null) c['no-trailing-blank'].unmeasured('末块所在页读不出');
  else if (lastContent !== m.pages) c['no-trailing-blank'].fail('文末', `内容到第 ${m.pages} 页为止`, `内容止于第 ${lastContent} 页，共 ${m.pages} 页`);
  if (m.pdfPages === null || m.pdfPages === undefined) c['page-count'].unmeasured('PDF 页数读不出');
  else if (!m.ink) c['page-count'].unmeasured('没有逐页 PNG');
  else {
    if (m.pdfPages !== m.pages || m.ink.length !== m.pages) c['page-count'].fail('页数', `Word ${m.pages} 页`, `PDF ${m.pdfPages} 页，PNG ${m.ink.length} 张`);
    if (e.pages !== undefined && m.pages !== e.pages) c['page-count'].fail('页数', `${e.pages} 页（钉住的回归值）`, `${m.pages} 页`);
    // 每一页的版心里都要有墨迹（空文档除外）：整页空白说明渲染出了问题
    if (!e.blank) for (const pg of m.ink) if (pg.all.dark - pg.bottom.dark <= 0) c['page-count'].fail(`第 ${pg.page} 页`, '版心里有内容', '整页空白');
  }

  return ids.map(id => c[id].item());
}

/** DOCX_FIELDS 的每一项 → 在真实 Word 里核对它的检查 id。「每个字段都有真实读回」靠这张表与元测试钉住。 */
export const DOCX_FIELD_CHECKS: Readonly<Record<string, readonly string[]>> = {
  title: ['doc-title'],
  'page.size': ['paper'],
  'page.orientation': ['paper'],
  'page.marginsCm.top': ['margins', 'ink-outside'],
  'page.marginsCm.bottom': ['margins', 'ink-outside'],
  'page.marginsCm.left': ['margins', 'ink-outside'],
  'page.marginsCm.right': ['margins', 'ink-outside'],
  'page.pageNumber': ['page-number'],
  'style.bodyFont.eastAsia': ['font-body', 'font-table', 'fonts-pdf'],
  'style.bodyFont.latin': ['font-body', 'font-table'],
  'style.headingFont.eastAsia': ['font-heading', 'fonts-pdf'],
  'style.headingFont.latin': ['font-heading'],
  'style.bodySizePt': ['font-body'],
  'style.headingSizesPt': ['heading-size'],
  'style.tableSizePt': ['font-table'],
  'style.lineSpacing': ['para-format'],
  'style.paraSpacingPt.before': ['para-spacing'],
  'style.paraSpacingPt.after': ['para-spacing'],
  'style.firstLineIndentChars': ['para-format'],
  'blocks[].kind': ['text-complete'],
  'blocks[].level': ['heading-size', 'para-spacing'],
  'blocks[].text': ['text-complete', 'text-rendered'],
  'blocks[].pageBreakBefore': ['keep-with-next', 'page-break'],
  'blocks[].align': ['para-format'],
  'blocks[].keepWithNext': ['keep-with-next'],
  'blocks[].ordered': ['list-restart'],
  'blocks[].items': ['text-complete', 'list-restart'],
  'blocks[].items[].text': ['text-complete', 'text-rendered'],
  'blocks[].items[].level': ['list-restart'],
  'blocks[].rows': ['text-complete', 'table-col-widths'],
  'blocks[].headerRows': ['table-header-repeat'],
  'blocks[].colWidths': ['table-col-widths'],
  'blocks[].allowRowSplit': ['row-allow-split'],
};
