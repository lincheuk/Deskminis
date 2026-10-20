/** Word 内容模型（F10A）：输入长什么样、怎么规范化成生成器读的模型。
 *
 *  两条要守住的：
 *  - **收下的字段必须落到文档里**。认识的字段在 DOCX_FIELDS 里逐项登记，每一项都有测试证明它改变了生成的 XML；
 *    不认识的字段不报错，但逐个记进 notes（「未采用的字段 blocks[3].bold」），不会静默吞掉。
 *  - **旧输入照常生成**。`{blocks:[heading|para|table]}` 与 `buildDocx({ title, blocks })` 原样可用；
 *    没有版本字段，v2 是旧形态的超集。
 *
 *  规范化之后的 DocxModel 里：默认值已填、单位已换成 twips / 半磅、文本已清洗、列宽已算。
 *  生成器、内容核验、版式期望都只读它。 */
import { OfficeInputError } from '../format';
import { cleanXmlText } from '../xml';
import { DOCX_DEFAULTS, cmToTw, columnWidths, rowLineEstimate, tableParams, type DocxTableParams } from './layout';

export type DocxAlign = 'left' | 'center' | 'right' | 'justify';
/** 输入也接受英文名（SimSun、SimHei、Microsoft YaHei、FangSong、KaiTi、DengXian，不分大小写） */
export type DocxCjkFont = '宋体' | '黑体' | '微软雅黑' | '仿宋' | '楷体' | '等线';
export type DocxLatinFont = 'Times New Roman' | 'Arial' | 'Calibri';
export interface DocxPage {
  size?: 'A4' | 'A3' | 'A5' | 'B5' | 'Letter';
  orientation?: 'portrait' | 'landscape';
  /** 各 0.5–8 */
  marginsCm?: { top?: number; bottom?: number; left?: number; right?: number };
  pageNumber?: 'bottom-center' | 'none';
}
export interface DocxStyle {
  bodyFont?: { eastAsia?: DocxCjkFont; latin?: DocxLatinFont };
  headingFont?: { eastAsia?: DocxCjkFont; latin?: DocxLatinFont };
  /** 9–16，0.5 的倍数 */
  bodySizePt?: number;
  /** 第 1..6 级，给几个覆盖几个；各 9–36 */
  headingSizesPt?: readonly number[];
  /** 8–14 */
  tableSizePt?: number;
  /** 倍数，1.0–3.0 */
  lineSpacing?: number;
  /** 正文段前、段后，各 0–36 */
  paraSpacingPt?: { before?: number; after?: number };
  firstLineIndentChars?: 0 | 2;
}
export type DocxBlock =
  | { kind: 'heading'; level?: number; text?: string; pageBreakBefore?: boolean }
  | { kind: 'para'; text?: string; align?: DocxAlign; keepWithNext?: boolean }
  | { kind: 'list'; ordered?: boolean; items: readonly (string | { text: string; level?: number })[] }
  | { kind: 'table'; rows?: readonly (readonly (string | number)[])[]; headerRows?: number; colWidths?: readonly number[]; allowRowSplit?: boolean }
  | { kind: 'pageBreak' };
export interface DocxInput { title?: string; page?: DocxPage; style?: DocxStyle; blocks: readonly DocxBlock[] }

/** 受支持字段的路径名单。字段生效测试与工具说明都对着它核。 */
export const DOCX_FIELDS: readonly string[] = [
  'title',
  'page.size', 'page.orientation', 'page.marginsCm.top', 'page.marginsCm.bottom', 'page.marginsCm.left', 'page.marginsCm.right', 'page.pageNumber',
  'style.bodyFont.eastAsia', 'style.bodyFont.latin', 'style.headingFont.eastAsia', 'style.headingFont.latin',
  'style.bodySizePt', 'style.headingSizesPt', 'style.tableSizePt', 'style.lineSpacing',
  'style.paraSpacingPt.before', 'style.paraSpacingPt.after', 'style.firstLineIndentChars',
  'blocks[].kind', 'blocks[].level', 'blocks[].text', 'blocks[].pageBreakBefore', 'blocks[].align', 'blocks[].keepWithNext',
  'blocks[].ordered', 'blocks[].items', 'blocks[].items[].text', 'blocks[].items[].level',
  'blocks[].rows', 'blocks[].headerRows', 'blocks[].colWidths', 'blocks[].allowRowSplit',
];

/** 只为给同步计算一个上界，定在工具入参实际到不了的量级。
 *  units = 块数 + 列表项数 + 单元格数；tableRows / tableCols 是 Word 自身的表格上限。 */
export const DOCX_LIMITS = { textChars: 2_000_000, units: 200_000, tableRows: 32_767, tableCols: 63 } as const;

export type DocxModelBlock =
  | { kind: 'heading'; level: number; text: string; pageBreakBefore: boolean }
  | { kind: 'para'; text: string; align: DocxAlign; keepWithNext: boolean }
  | { kind: 'list'; ordered: boolean; numId: number; items: readonly { text: string; level: number }[] }
  | { kind: 'table'; rows: readonly (readonly string[])[]; headerRows: number; colsTw: readonly number[];
      /** 单元格左右边距（单侧）：常规 108，降级 45 */
      padTw: number; dense: boolean;
      /** 逐行：这一行写不写 w:cantSplit */
      cantSplit: readonly boolean[] }
  | { kind: 'pageBreak' };

export interface DocxModel {
  title?: string;
  page: {
    paper: string; landscape: boolean; widthTw: number; heightTw: number;
    marginTw: { top: number; right: number; bottom: number; left: number }; headerTw: number; footerTw: number;
    textWidthTw: number; pageNumber: 'bottom-center' | 'none';
  };
  fonts: {
    bodyEastAsia: DocxCjkFont; bodyLatin: DocxLatinFont; headEastAsia: DocxCjkFont; headLatin: DocxLatinFont;
    bodyHalfPt: number; headHalfPt: readonly number[]; tableHalfPt: number;
  };
  para: { line240: number; beforeTw: number; afterTw: number; firstLineChars: 0 | 2 };
  blocks: readonly DocxModelBlock[];
  /** 输入里 blocks 的个数（摘要用） */
  inputBlocks: number;
}

const CJK_FONTS: readonly DocxCjkFont[] = ['宋体', '黑体', '微软雅黑', '仿宋', '楷体', '等线'];
const CJK_ALIASES: Record<string, DocxCjkFont> = {
  simsun: '宋体', simhei: '黑体', 'microsoft yahei': '微软雅黑', fangsong: '仿宋', kaiti: '楷体', dengxian: '等线',
};
const LATIN_FONTS: readonly DocxLatinFont[] = ['Times New Roman', 'Arial', 'Calibri'];
const ALIGNS: readonly DocxAlign[] = ['left', 'center', 'right', 'justify'];
const KINDS = ['heading', 'para', 'list', 'table', 'pageBreak'] as const;
const BLOCK_FIELDS: Record<(typeof KINDS)[number], readonly string[]> = {
  heading: ['kind', 'level', 'text', 'pageBreakBefore'],
  para: ['kind', 'text', 'align', 'keepWithNext'],
  list: ['kind', 'ordered', 'items'],
  table: ['kind', 'rows', 'headerRows', 'colWidths', 'allowRowSplit'],
  pageBreak: ['kind'],
};
const MAX_ERRORS = 10;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const tw2cm = (tw: number): string => (tw * 2.54 / 1440).toFixed(2);

/** 规范化。不可用的输入抛 OfficeInputError，一次列全（最多 10 处，其余写「另有 N 处」），模型一轮就能改完。 */
export function normalizeDocx(spec: unknown): { model: DocxModel; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  const err = (msg: string): void => { errors.push(msg); };
  const fail = (): never => {
    const shown = errors.slice(0, MAX_ERRORS).join('；');
    throw new OfficeInputError(errors.length > MAX_ERRORS ? `${shown}；另有 ${errors.length - MAX_ERRORS} 处` : shown);
  };
  if (!isObj(spec)) throw new OfficeInputError('content 应是一个 JSON 对象，例如 {"blocks":[{"kind":"para","text":"…"}]}');

  let removedChars = 0;
  let textChars = 0;
  let units = 0;
  /** 把一个值当文本收下：字符串原样；数字、布尔转成字符串；null / 缺省当空串；对象、数组报错。 */
  const textOf = (v: unknown, path: string, oneLine = false): string => {
    let s: string;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else if (v === null || v === undefined) s = '';
    else { err(`${path}：应是文字，收到的是${Array.isArray(v) ? '数组' : '对象'}`); return ''; }
    const c = cleanXmlText(s);
    removedChars += c.removed;
    textChars += c.text.length;
    // 标题与文档标题是单行的：换行、制表符当空格
    return oneLine ? c.text.replace(/[\n\t]/g, ' ') : c.text;
  };
  const unknownFields = (o: Obj, known: readonly string[], prefix: string): void => {
    for (const k of Object.keys(o)) if (!known.includes(k)) notes.push(`未采用的字段 ${prefix}${k}`);
  };
  const bool = (v: unknown, path: string, dflt: boolean): boolean => {
    if (v === undefined) return dflt;
    if (typeof v === 'boolean') return v;
    err(`${path}：只能是 true 或 false`);
    return dflt;
  };
  /** 0.5 的倍数、在范围内的数 */
  const sizePt = (v: unknown, path: string, lo: number, hi: number): number | undefined => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || !Number.isInteger(v * 2)) {
      err(`${path}：应是 ${lo}–${hi} 之间、0.5 的倍数的字号（磅）`);
      return undefined;
    }
    return v;
  };

  unknownFields(spec, ['title', 'page', 'style', 'blocks'], '');

  // ---- 文档标题
  const titleText = spec.title === undefined ? '' : textOf(spec.title, 'title', true);

  // ---- 页面
  const D = DOCX_DEFAULTS;
  let paper: keyof typeof D.papers = 'A4';
  let landscape = false;
  let pageNumber: 'bottom-center' | 'none' = 'bottom-center';
  const marginTw: DocxModel['page']['marginTw'] = { ...D.marginTw };
  if (spec.page !== undefined) {
    if (!isObj(spec.page)) err('page：应是一个对象');
    else {
      const p = spec.page;
      unknownFields(p, ['size', 'orientation', 'marginsCm', 'pageNumber'], 'page.');
      if (p.size !== undefined) {
        if (typeof p.size === 'string' && Object.prototype.hasOwnProperty.call(D.papers, p.size)) paper = p.size as keyof typeof D.papers;
        else err(`page.size：只支持 ${Object.keys(D.papers).join(' / ')}`);
      }
      if (p.orientation !== undefined) {
        if (p.orientation === 'portrait' || p.orientation === 'landscape') landscape = p.orientation === 'landscape';
        else err('page.orientation：只能是 portrait 或 landscape');
      }
      if (p.pageNumber !== undefined) {
        if (p.pageNumber === 'bottom-center' || p.pageNumber === 'none') pageNumber = p.pageNumber;
        else err('page.pageNumber：只能是 bottom-center 或 none');
      }
      if (p.marginsCm !== undefined) {
        if (!isObj(p.marginsCm)) err('page.marginsCm：应是一个对象');
        else {
          unknownFields(p.marginsCm, ['top', 'bottom', 'left', 'right'], 'page.marginsCm.');
          for (const side of ['top', 'bottom', 'left', 'right'] as const) {
            const v = p.marginsCm[side];
            if (v === undefined) continue;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 8) err(`page.marginsCm.${side}：应是 0.5–8（厘米）`);
            else marginTw[side] = cmToTw(v);
          }
        }
      }
    }
  }
  const sz = D.papers[paper];
  const widthTw = landscape ? sz.h : sz.w;
  const heightTw = landscape ? sz.w : sz.h;
  const textWidthTw = widthTw - marginTw.left - marginTw.right;
  const textHeightTw = heightTw - marginTw.top - marginTw.bottom;
  if (textWidthTw < D.minTextTw) err(`page.marginsCm：左右页边距太大，版心只剩 ${tw2cm(textWidthTw)} 厘米宽（至少 8 厘米）`);
  if (textHeightTw < D.minTextTw) err(`page.marginsCm：上下页边距太大，版心只剩 ${tw2cm(textHeightTw)} 厘米高（至少 8 厘米）`);

  // ---- 样式
  let bodyEastAsia = D.bodyEastAsia;
  let bodyLatin = D.bodyLatin;
  let headEastAsia = D.headEastAsia;
  let headLatin = D.headLatin;
  let bodyHalfPt: number = D.bodyHalfPt;
  const headHalfPt = [...D.headHalfPt];
  let tableHalfPt: number = D.tableHalfPt;
  let line240: number = D.line240;
  let beforeTw: number = D.beforeTw;
  let afterTw: number = D.afterTw;
  let firstLineChars: 0 | 2 = D.firstLineChars;
  const cjk = (v: unknown, path: string): DocxCjkFont | undefined => {
    if (typeof v === 'string') {
      const t = v.trim();
      if ((CJK_FONTS as readonly string[]).includes(t)) return t as DocxCjkFont;
      const a = CJK_ALIASES[t.toLowerCase()];
      if (a) return a;
    }
    err(`${path}：只支持 ${CJK_FONTS.join(' / ')}`);
    return undefined;
  };
  const latin = (v: unknown, path: string): DocxLatinFont | undefined => {
    if (typeof v === 'string') {
      const hit = LATIN_FONTS.find(f => f.toLowerCase() === v.trim().toLowerCase());
      if (hit) return hit;
    }
    err(`${path}：只支持 ${LATIN_FONTS.join(' / ')}`);
    return undefined;
  };
  if (spec.style !== undefined) {
    if (!isObj(spec.style)) err('style：应是一个对象');
    else {
      const s = spec.style;
      unknownFields(s, ['bodyFont', 'headingFont', 'bodySizePt', 'headingSizesPt', 'tableSizePt', 'lineSpacing', 'paraSpacingPt', 'firstLineIndentChars'], 'style.');
      for (const which of ['bodyFont', 'headingFont'] as const) {
        const f = s[which];
        if (f === undefined) continue;
        if (!isObj(f)) { err(`style.${which}：应是一个对象`); continue; }
        unknownFields(f, ['eastAsia', 'latin'], `style.${which}.`);
        if (f.eastAsia !== undefined) {
          const v = cjk(f.eastAsia, `style.${which}.eastAsia`);
          if (v) { if (which === 'bodyFont') bodyEastAsia = v; else headEastAsia = v; }
        }
        if (f.latin !== undefined) {
          const v = latin(f.latin, `style.${which}.latin`);
          if (v) { if (which === 'bodyFont') bodyLatin = v; else headLatin = v; }
        }
      }
      if (s.bodySizePt !== undefined) { const v = sizePt(s.bodySizePt, 'style.bodySizePt', 9, 16); if (v !== undefined) bodyHalfPt = v * 2; }
      if (s.tableSizePt !== undefined) { const v = sizePt(s.tableSizePt, 'style.tableSizePt', 8, 14); if (v !== undefined) tableHalfPt = v * 2; }
      if (s.headingSizesPt !== undefined) {
        if (!Array.isArray(s.headingSizesPt) || s.headingSizesPt.length > 6) err('style.headingSizesPt：应是至多 6 个字号的数组（第 1 级起）');
        else s.headingSizesPt.forEach((x, i) => { const v = sizePt(x, `style.headingSizesPt[${i}]`, 9, 36); if (v !== undefined) headHalfPt[i] = v * 2; });
      }
      if (s.lineSpacing !== undefined) {
        if (typeof s.lineSpacing !== 'number' || !Number.isFinite(s.lineSpacing) || s.lineSpacing < 1 || s.lineSpacing > 3) err('style.lineSpacing：应是 1.0–3.0（倍）');
        else line240 = Math.round(s.lineSpacing * 240);
      }
      if (s.paraSpacingPt !== undefined) {
        if (!isObj(s.paraSpacingPt)) err('style.paraSpacingPt：应是一个对象');
        else {
          unknownFields(s.paraSpacingPt, ['before', 'after'], 'style.paraSpacingPt.');
          for (const k of ['before', 'after'] as const) {
            const v = s.paraSpacingPt[k];
            if (v === undefined) continue;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 36) err(`style.paraSpacingPt.${k}：应是 0–36（磅）`);
            else if (k === 'before') beforeTw = Math.round(v * 20);
            else afterTw = Math.round(v * 20);
          }
        }
      }
      if (s.firstLineIndentChars !== undefined) {
        if (s.firstLineIndentChars === 0 || s.firstLineIndentChars === 2) firstLineChars = s.firstLineIndentChars;
        else err('style.firstLineIndentChars：只能是 0 或 2');
      }
    }
  }

  // ---- 块
  let input: readonly unknown[] = [];
  if (spec.blocks !== undefined) {
    if (Array.isArray(spec.blocks)) input = spec.blocks;
    else err('blocks：应是一个数组');
  }
  const blocks: DocxModelBlock[] = [];
  let numId = 0;
  let overLimit = false;
  const addUnits = (n: number): boolean => {
    units += n;
    if (!overLimit && (units > DOCX_LIMITS.units || textChars > DOCX_LIMITS.textChars)) {
      overLimit = true;
      err(units > DOCX_LIMITS.units
        ? `内容太多：块、列表项、单元格合计超过 ${DOCX_LIMITS.units} 个`
        : `内容太多：全文超过 ${DOCX_LIMITS.textChars} 个字符`);
    }
    return !overLimit;
  };
  // 版心不合法时列宽没法算：表格先不排（错误已经记下，最后一并抛出）
  const pageOk = textWidthTw >= D.minTextTw;

  for (let i = 0; i < input.length && !overLimit; i++) {
    const b = input[i];
    const at = `blocks[${i}]`;
    if (!addUnits(1)) break;
    if (!isObj(b)) { err(`${at}：应是一个对象`); continue; }
    const kind = b.kind;
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
      err(`${at}.kind：${kind === undefined ? '缺少 kind' : `不支持 ${JSON.stringify(kind)}`}，只支持 ${KINDS.join(' / ')}`);
      continue;
    }
    unknownFields(b, BLOCK_FIELDS[kind as (typeof KINDS)[number]], `${at}.`);

    if (kind === 'heading') {
      let level = 1;
      if (b.level !== undefined && b.level !== null) {
        // 先 Number()：数字字符串 "2" 照旧是二级（旧代码的 Math.max("2", 1) 得 2，不能变成 1）
        const n = Number(b.level);
        if (!Number.isFinite(n)) notes.push(`${at}.level：${JSON.stringify(b.level)} 不是数字，按 1 级处理`);
        else {
          level = Math.min(Math.max(Math.trunc(n), 1), 6);
          if (level !== n) notes.push(`${at}.level：${JSON.stringify(b.level)} 按 ${level} 级处理（只有 1–6 级的整数）`);
        }
      }
      blocks.push({ kind: 'heading', level, text: textOf(b.text, `${at}.text`, true), pageBreakBefore: bool(b.pageBreakBefore, `${at}.pageBreakBefore`, false) });
    } else if (kind === 'para') {
      let align: DocxAlign = 'justify';
      if (b.align !== undefined) {
        if (typeof b.align === 'string' && (ALIGNS as readonly string[]).includes(b.align)) align = b.align as DocxAlign;
        else err(`${at}.align：只能是 ${ALIGNS.join(' / ')}`);
      }
      blocks.push({ kind: 'para', text: textOf(b.text, `${at}.text`), align, keepWithNext: bool(b.keepWithNext, `${at}.keepWithNext`, false) });
    } else if (kind === 'list') {
      const ordered = bool(b.ordered, `${at}.ordered`, false);
      if (!Array.isArray(b.items)) { err(`${at}.items：应是一个数组`); continue; }
      if (!addUnits(b.items.length)) break;
      const items: { text: string; level: number }[] = [];
      b.items.forEach((it, j) => {
        const p = `${at}.items[${j}]`;
        let text: string;
        let level = 0;
        if (isObj(it)) {
          unknownFields(it, ['text', 'level'], `${p}.`);
          text = textOf(it.text, `${p}.text`);
          if (it.level !== undefined && it.level !== null) {
            const n = Number(it.level);
            const lv = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), 2) : 0;
            if (lv !== n) notes.push(`${p}.level：${JSON.stringify(it.level)} 按 ${lv} 处理（只有 0–2 三级）`);
            level = lv;
          }
        } else text = textOf(it, p);
        if (text.trim() !== '') items.push({ text, level });
      });
      if (items.length === 0) { notes.push(`${at}：列表没有任何非空的项，已跳过`); continue; }
      blocks.push({ kind: 'list', ordered, numId: ++numId, items });
    } else if (kind === 'table') {
      const allowSplit = bool(b.allowRowSplit, `${at}.allowRowSplit`, false);
      const raw = b.rows ?? [];
      if (!Array.isArray(raw) || raw.some(r => !Array.isArray(r))) { err(`${at}.rows：应是「行的数组」，每一行又是单元格的数组`); continue; }
      const rawRows = raw as unknown[][];
      const cols = rawRows.reduce((a, r) => Math.max(a, r.length), 0);
      if (rawRows.length > DOCX_LIMITS.tableRows) { err(`${at}.rows：${rawRows.length} 行，超过 Word 一张表的上限 ${DOCX_LIMITS.tableRows} 行`); continue; }
      if (cols > DOCX_LIMITS.tableCols) { err(`${at}.rows：${cols} 列，超过 Word 一张表的上限 ${DOCX_LIMITS.tableCols} 列`); continue; }
      if (!addUnits(rawRows.length * cols)) break;
      if (rawRows.length === 0 || cols === 0) { notes.push(`${at}：表格没有任何单元格，已跳过`); continue; }
      // 各行补空串到最宽列数
      const rows = rawRows.map((r, ri) => {
        const out: string[] = [];
        for (let c = 0; c < cols; c++) out.push(c < r.length ? textOf(r[c], `${at}.rows[${ri}][${c}]`) : '');
        return out;
      });
      let weights: number[] | undefined;
      if (b.colWidths !== undefined) {
        const cw = b.colWidths;
        if (!Array.isArray(cw) || cw.length !== cols || cw.some(x => typeof x !== 'number' || !Number.isFinite(x) || x <= 0)) {
          err(`${at}.colWidths：应是 ${cols} 个大于 0 的数（各列的相对宽度）`);
          continue;
        }
        weights = cw as number[];
      }
      let headerRows = rows.length >= 2 ? 1 : 0;
      if (b.headerRows !== undefined) {
        const max = Math.min(5, rows.length - 1);
        if (typeof b.headerRows !== 'number' || !Number.isInteger(b.headerRows) || b.headerRows < 0 || b.headerRows > max) {
          err(`${at}.headerRows：应是 0–${Math.max(max, 0)} 的整数（表头行数，至少留一行数据）`);
          continue;
        }
        headerRows = b.headerRows;
      }
      if (!pageOk) continue;
      let params: DocxTableParams;
      let colsTw: number[];
      try {
        params = tableParams(cols, textWidthTw, tableHalfPt);
        colsTw = columnWidths(rows, textWidthTw, tableHalfPt, weights);
      } catch (e) {
        if (e instanceof OfficeInputError) { err(`${at}.${weights ? 'colWidths' : 'rows'}：${e.message}`); continue; }
        throw e;
      }
      if (params.dense) {
        notes.push(`${at}：表格有 ${cols} 列，每列只有 ${tw2cm(Math.floor(textWidthTw / cols))} 厘米，文字会逐字折行；` +
          `建议 page.orientation 用 landscape、拆表或改用 xlsx`);
      }
      const lines = rows.map(r => rowLineEstimate(r, colsTw, tableHalfPt, params.padTw));
      // 表头行也过估算：不许断开、比一页还高、还要每页重复的行，Word 会把整张表挪到下一页去排
      if (headerRows > 0 && lines.slice(0, headerRows).reduce((a, x) => a + x, 0) > D.tallRowLines) {
        headerRows = 0;
        notes.push(`${at}：首行内容太长，没有按表头处理（不跨页重复）`);
      }
      const cantSplit = rows.map((_, ri) => ri < headerRows || (!allowSplit && lines[ri] <= D.tallRowLines));
      blocks.push({ kind: 'table', rows, headerRows, colsTw, padTw: params.padTw, dense: params.dense, cantSplit });
    } else {
      blocks.push({ kind: 'pageBreak' });
    }
  }
  if (!overLimit && textChars > DOCX_LIMITS.textChars) err(`内容太多：全文超过 ${DOCX_LIMITS.textChars} 个字符`);
  if (errors.length > 0) fail();
  if (removedChars > 0) notes.push(`已去掉 ${removedChars} 个 Word 不接受的字符（控制字符等）`);

  const model: DocxModel = {
    ...(titleText !== '' ? { title: titleText } : {}),
    page: { paper, landscape, widthTw, heightTw, marginTw, headerTw: D.headerTw, footerTw: D.footerTw, textWidthTw, pageNumber },
    fonts: { bodyEastAsia, bodyLatin, headEastAsia, headLatin, bodyHalfPt, headHalfPt, tableHalfPt },
    para: { line240, beforeTw, afterTw, firstLineChars },
    blocks,
    inputBlocks: input.length,
  };
  return { model, notes };
}
