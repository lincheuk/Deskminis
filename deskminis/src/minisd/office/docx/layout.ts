/** Word 的版式常量与表格列宽（F10A）。全是整数运算，同输入同输出。
 *
 *  单位：twips（1/20 磅），字号是半磅。这里的默认值是「中文正式文档的通行写法」，
 *  每一项都在真实 Word 里读回核对过（取证见 work\verify\F10A\）。 */
import { OfficeInputError } from '../format';
import type { DocxCjkFont, DocxLatinFont } from './model';

/** 厘米 → twips。Word 的页边距以 twips 存；2.54 厘米 = 1440。 */
export const cmToTw = (cm: number): number => Math.round(cm * 1440 / 2.54);

export const DOCX_DEFAULTS = {
  /** 纵向纸张的宽高。横向时宽高互换 */
  papers: {
    A4: { w: 11906, h: 16838 }, A3: { w: 16838, h: 23811 }, A5: { w: 8391, h: 11906 },
    B5: { w: 10318, h: 14570 }, Letter: { w: 12240, h: 15840 },
  },
  /** 中文版 Word 的「常规」页边距：上下 2.54 厘米，左右 3.18 厘米 */
  marginTw: { top: 1440, right: 1800, bottom: 1440, left: 1800 },
  headerTw: 851,
  footerTw: 992,
  /** 版心的宽与高都不能小于 8 厘米：再小就排不下一行像样的字 */
  minTextTw: 4535,
  bodyEastAsia: '宋体' as DocxCjkFont,
  bodyLatin: 'Times New Roman' as DocxLatinFont,
  headEastAsia: '黑体' as DocxCjkFont,
  headLatin: 'Arial' as DocxLatinFont,
  /** 小四 12 磅 */
  bodyHalfPt: 24,
  /** 小二 18 / 三号 16 / 四号 14 / 小四 12 / 12 / 12 磅 */
  headHalfPt: [36, 32, 28, 24, 24, 24] as readonly number[],
  /** 五号 10.5 磅 */
  tableHalfPt: 21,
  /** 小五 9 磅 */
  footerHalfPt: 18,
  /** 1.5 倍行距（240 = 单倍） */
  line240: 360,
  beforeTw: 0,
  afterTw: 0,
  firstLineChars: 2 as 0 | 2,
  /** 标题：1.25 倍行距；各级段前 / 段后（twips） */
  headLine240: 300,
  headBeforeTw: [240, 240, 180, 120, 120, 120] as readonly number[],
  headAfterTw: [240, 120, 120, 60, 60, 60] as readonly number[],
  /** 单元格上下边距；左右边距见 tableParams */
  cellPadVTw: 57,
  /** 间隔段落的固定行高：两表之间 6 磅（防止被 Word 并成一张），其余 1 磅 */
  gapBetweenTablesTw: 120,
  gapTinyTw: 20,
  /** 估算超过这个行数的行允许跨页；表头各行合计超过它就不设表头 */
  tallRowLines: 12,
  defaultTabStopTw: 420,
} as const;

/** 字体白名单。白名单内的字体都能给出完整的 fontTable 条目，并在真实 Word 里取过证。
 *  rFonts 里写中文名（实测：只在 docDefaults 里写英文名时，中文版 Word 认不出来，东亚槽会落到主题字体等线）。 */
export const DOCX_FONTS: Record<DocxCjkFont | DocxLatinFont, { name: string; altName?: string; charset: string; family: string; pitch: string }> = {
  宋体: { name: '宋体', altName: 'SimSun', charset: '86', family: 'auto', pitch: 'variable' },
  黑体: { name: '黑体', altName: 'SimHei', charset: '86', family: 'modern', pitch: 'fixed' },
  微软雅黑: { name: '微软雅黑', altName: 'Microsoft YaHei', charset: '86', family: 'swiss', pitch: 'variable' },
  仿宋: { name: '仿宋', altName: 'FangSong', charset: '86', family: 'modern', pitch: 'fixed' },
  楷体: { name: '楷体', altName: 'KaiTi', charset: '86', family: 'modern', pitch: 'fixed' },
  等线: { name: '等线', altName: 'DengXian', charset: '86', family: 'auto', pitch: 'variable' },
  'Times New Roman': { name: 'Times New Roman', charset: '00', family: 'roman', pitch: 'variable' },
  Arial: { name: 'Arial', charset: '00', family: 'swiss', pitch: 'variable' },
  Calibri: { name: 'Calibri', charset: '00', family: 'swiss', pitch: 'variable' },
};

/** 一行文字的宽度单位数：码点 ≥ U+2E80（中日韩文字与全角符号）记 2，其余记 1。 */
function lineUnits(line: string): number {
  let u = 0;
  for (const ch of line) u += (ch.codePointAt(0) as number) >= 0x2e80 ? 2 : 1;
  return u;
}
/** 一个单元格的宽度单位数 = 最长的一行（按 \n 分）。 */
export function textUnits(s: string): number {
  let max = 0;
  for (const line of s.split('\n')) { const u = lineUnits(line); if (u > max) max = u; }
  return max;
}

export interface DocxTableParams {
  /** 单元格左右边距（单侧） */
  padTw: number;
  /** 这张表适用的最窄列宽 */
  minColTw: number;
  /** 降级排版：列太多，收窄了单元格边距、最窄列宽降到一个汉字 */
  dense: boolean;
}

/** 按列数选排版参数。常规：左右边距各 108、最窄两个汉字；放不下就降级：各 45、最窄一个汉字；
 *  再放不下就报错——一个字也放不下的表，生成出来只能是越界或截断。
 *  降级是为旧形态输入留的：它没法声明横向纸张，以前任意列数都能生成，不能因为列多就拒掉。 */
export function tableParams(cols: number, textWidthTw: number, halfPt: number): DocxTableParams {
  const u = 5 * halfPt;                        // 半个字宽
  const normal = 4 * u + 216;
  if (cols * normal <= textWidthTw) return { padTw: 108, minColTw: normal, dense: false };
  const dense = 2 * u + 90;
  if (cols * dense <= textWidthTw) return { padTw: 45, minColTw: dense, dense: true };
  throw new OfficeInputError(`${cols} 列在当前版心里连一个字都放不下（最多 ${Math.floor(textWidthTw / dense)} 列）`);
}

/** 列宽。给了权重就按权重分；没给就按内容的自然宽度，放不下时「注水」：短列拿到自然宽度，长列分掉剩下的
 *  （按比例缩放会把短列也压到折行）。
 *
 *  不变量：Σw === textWidthTw；每列 ≥ 该表适用的最窄列宽；同输入同输出。
 *  越不越界由「固定布局 + 总宽恒等于版心」保证，不靠字宽估算；估算只影响好不好看。 */
export function columnWidths(rows: readonly (readonly string[])[], textWidthTw: number, halfPt: number, weights?: readonly number[]): number[] {
  const n = rows.reduce((a, r) => Math.max(a, r.length), 0);
  if (n === 0) return [];
  const { padTw, minColTw } = tableParams(n, textWidthTw, halfPt);
  const pad = 2 * padTw;
  const u = 5 * halfPt;
  let w: number[];
  if (weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    w = weights.map(g => Math.floor(textWidthTw * g / sum));
    const small = w.findIndex(x => x < minColTw);
    if (small >= 0) throw new OfficeInputError(`colWidths 的第 ${small + 1} 列折算后只有 ${(w[small] * 2.54 / 1440).toFixed(2)} 厘米，` +
      `小于最窄列宽 ${(minColTw * 2.54 / 1440).toFixed(2)} 厘米`);
  } else {
    // 自然宽度封顶 40 个汉字：免得一格长文吃掉整张表。
    // 另加一个汉字的余量：真实 Word 里「正好放得下」的格子会折行——中西文之间有自动加的间距，加粗的表头也更宽
    // （首轮取证的逐页 PNG：两个字的表头「序号」在恰好两个字宽的列里被拆成了两行）。
    const nat: number[] = [];
    for (let c = 0; c < n; c++) {
      let m = 0;
      for (const r of rows) { const x = textUnits(r[c] ?? ''); if (x > m) m = x; }
      nat.push(Math.max(minColTw, Math.min(m, 80) * u + pad + 2 * u));
    }
    const sum = nat.reduce((a, b) => a + b, 0);
    if (sum <= textWidthTw) {
      w = nat.map(x => Math.floor(x * textWidthTw / sum));      // 小表也铺满版心
    } else {
      w = new Array<number>(n).fill(0);
      const order = nat.map((_, i) => i).sort((a, b) => nat[a] - nat[b] || a - b);
      let rest = textWidthTw;
      let left = n;
      for (const c of order) {
        const share = Math.floor(rest / left);
        w[c] = nat[c] <= share ? nat[c] : share;
        rest -= w[c];
        left--;
      }
    }
  }
  // 取整留下的差额全部给最后一列
  w[n - 1] += textWidthTw - w.reduce((a, b) => a + b, 0);
  return w;
}

/** 一行估算要占几行文字：各格行数的最大值；一格的行数 = 各行 ceil(单位数 / 这一列一行放得下的单位数) 之和。
 *  padTw 是单侧单元格边距（常规 108，降级 45）。 */
export function rowLineEstimate(row: readonly string[], colsTw: readonly number[], halfPt: number, padTw = 108): number {
  const u = 5 * halfPt;
  let max = 1;
  for (let c = 0; c < row.length && c < colsTw.length; c++) {
    const perLine = Math.max(1, Math.floor((colsTw[c] - 2 * padTw) / u));
    let lines = 0;
    for (const line of row[c].split('\n')) lines += Math.max(1, Math.ceil(lineUnits(line) / perLine));
    if (lines > max) max = lines;
  }
  return max;
}
