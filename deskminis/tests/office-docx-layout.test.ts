/** F10A · T4：表格列宽与行高估算（整数运算、确定性）。
 *
 *  这里钉住的是算法的不变量：列宽之和恒等于版心宽、每列不小于该表适用的最窄列宽、同输入同输出。
 *  「不越界」在真实 Word 里靠固定布局加这条恒等式成立；这些用例只证明恒等式，证明不了 Word 里的样子。 */
import { describe, it, expect } from 'vitest';
import { columnWidths, rowLineEstimate, tableParams, textUnits, cmToTw, DOCX_DEFAULTS } from '../src/minisd/office/docx/layout';
import { OfficeInputError } from '../src/minisd/office/format';

const A4_PORTRAIT = 11906 - 1800 - 1800;   // 8306：A4 纵向默认边距的版心宽
const A4_LANDSCAPE = 16838 - 1800 - 1800;  // 13238
const H = DOCX_DEFAULTS.tableHalfPt;       // 21

/** 固定种子的伪随机数（mulberry32）：测试可复现，不用 Math.random。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('T4 列宽：不变量', () => {
  it('500 张固定种子的随机表：Σw === 版心宽、每列 ≥ 最窄列宽、同输入同输出', () => {
    const r = rng(20261004);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const widths = [A4_PORTRAIT, A4_LANDSCAPE, 6000, 4535, 20000];
    for (let k = 0; k < 500; k++) {
      const W = pick(widths);
      const h = pick([16, 18, 21, 24, 28]);
      const maxCols = Math.floor(W / (2 * 5 * h + 90));
      const n = 1 + Math.floor(r() * Math.min(maxCols, 30));
      const rows: string[][] = [];
      const rowCount = 1 + Math.floor(r() * 6);
      for (let i = 0; i < rowCount; i++) {
        const row: string[] = [];
        const len = r() < 0.2 ? Math.floor(r() * n) : n;       // 有的行短
        for (let c = 0; c < len; c++) {
          const kind = r();
          row.push(kind < 0.3 ? '' : kind < 0.6 ? '字'.repeat(1 + Math.floor(r() * 12)) : kind < 0.9 ? 'ab'.repeat(Math.floor(r() * 30)) : '长'.repeat(60) + '\n短');
        }
        rows.push(row);
      }
      if (rows.every(x => x.length < n)) rows[0] = Array.from({ length: n }, () => 'x');
      const w = columnWidths(rows, W, h);
      const { minColTw } = tableParams(n, W, h);
      expect(w).toHaveLength(n);
      expect(w.reduce((a, b) => a + b, 0)).toBe(W);
      for (const x of w) { expect(Number.isInteger(x)).toBe(true); expect(x).toBeGreaterThanOrEqual(minColTw); }
      expect(columnWidths(rows, W, h)).toEqual(w);
    }
  });

  it('带权重的随机表：同样满足 Σw === 版心宽', () => {
    const r = rng(7);
    for (let k = 0; k < 100; k++) {
      // 至多 4 列、权重 1–3：最不利的 1:3:3:3 下最窄一列仍有 830，不低于最窄列宽 636
      const n = 1 + Math.floor(r() * 4);
      const weights = Array.from({ length: n }, () => 1 + Math.floor(r() * 3));
      const w = columnWidths([Array.from({ length: n }, () => 'x')], A4_PORTRAIT, H, weights);
      expect(w.reduce((a, b) => a + b, 0)).toBe(A4_PORTRAIT);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(636);
    }
  });
});

describe('T4 列宽：黄金值', () => {
  it('小表铺满版心：两列等长 → 对半分，差额给最后一列', () => {
    expect(columnWidths([['名称', '数值'], ['甲', '1']], A4_PORTRAIT, H)).toEqual([4153, 4153]);
    expect(columnWidths([['一', '二', '三']], A4_PORTRAIT, H)).toEqual([2768, 2768, 2770]);
  });

  it('放不下时注水：短列拿到自然宽度，长列分掉剩下的', () => {
    // 自然宽度 = 字宽 + 单元格边距 + 一个汉字的余量：短列 2 个字 = 4×105+216+210 = 846；
    // 长列封顶 40 个字 = 80×105+216+210 = 8826 → 合计超过版心
    const w = columnWidths([['短', '长'.repeat(100)], ['短短', '长']], A4_PORTRAIT, H);
    expect(w).toEqual([846, 8306 - 846]);
    // 两个长列平分剩余
    const w3 = columnWidths([['序号', '甲'.repeat(60), '乙'.repeat(60)]], A4_PORTRAIT, H);
    expect(w3).toEqual([846, 3730, 3730]);
  });

  it('自然宽度留一个汉字的余量：真实 Word 里「正好放得下」的格子会折行', () => {
    // 6 列的报告表：前五列都拿到「内容 + 余量」，剩下的全给备注列；两个字的「序号」列是 846 而不是 636
    const rows = [['序号', '项目名称', '负责人', '状态', '金额（元）', '备注'], ['80', '项目80的名称', '张三', '进行中', '98760.00', '备'.repeat(60)]];
    expect(columnWidths(rows, A4_PORTRAIT, H)).toEqual([846, 1686, 1056, 1056, 1476, 2186]);
  });

  it('自然宽度封顶 40 个汉字：一格长文不会吃掉整张表', () => {
    // 两列都超过封顶 → 自然宽度相同 → 对半分，而不是按 100:1000 的比例
    expect(columnWidths([['字'.repeat(100), '字'.repeat(1000)]], 30000, H)).toEqual([15000, 15000]);
  });

  it('权重生效：1:2:3', () => {
    expect(columnWidths([['a', 'b', 'c']], A4_PORTRAIT, H, [1, 2, 3])).toEqual([1384, 2768, 4154]);
  });

  it('取最长的一行（按 \\n 分）算宽度单位：汉字记 2、其余记 1', () => {
    expect(textUnits('abc')).toBe(3);
    expect(textUnits('汉字')).toBe(4);
    expect(textUnits('ab\n汉字汉\nx')).toBe(6);
    expect(textUnits('')).toBe(0);
  });

  it('没有列时返回空数组', () => {
    expect(columnWidths([], A4_PORTRAIT, H)).toEqual([]);
    expect(columnWidths([[]], A4_PORTRAIT, H)).toEqual([]);
  });
});

describe('T4 常规 / 降级 / 报错的边界', () => {
  it('A4 纵向默认边距：13 列常规，14–27 列降级，28 列报错', () => {
    expect(tableParams(13, A4_PORTRAIT, H)).toEqual({ padTw: 108, minColTw: 636, dense: false });
    expect(tableParams(14, A4_PORTRAIT, H)).toEqual({ padTw: 45, minColTw: 300, dense: true });
    expect(tableParams(27, A4_PORTRAIT, H)).toEqual({ padTw: 45, minColTw: 300, dense: true });
    expect(() => tableParams(28, A4_PORTRAIT, H)).toThrow(OfficeInputError);
    expect(() => tableParams(28, A4_PORTRAIT, H)).toThrow(/28 列在当前版心里连一个字都放不下（最多 27 列）/);
  });

  it('A4 横向：20 列常规，21–44 列降级，45 列报错', () => {
    expect(tableParams(20, A4_LANDSCAPE, H).dense).toBe(false);
    expect(tableParams(21, A4_LANDSCAPE, H).dense).toBe(true);
    expect(tableParams(44, A4_LANDSCAPE, H).dense).toBe(true);
    expect(() => tableParams(45, A4_LANDSCAPE, H)).toThrow(OfficeInputError);
  });

  it('64 列在 A4 上无论横竖都报错（列宽函数同样拒绝）', () => {
    const row = Array.from({ length: 64 }, () => 'x');
    expect(() => columnWidths([row], A4_PORTRAIT, H)).toThrow(OfficeInputError);
    expect(() => columnWidths([row], A4_LANDSCAPE, H)).toThrow(OfficeInputError);
  });

  it('降级的表：列宽之和仍是版心宽，每列不小于一个汉字的宽度', () => {
    const w = columnWidths([Array.from({ length: 20 }, (_, i) => `第${i + 1}列`)], A4_PORTRAIT, H);
    expect(w.reduce((a, b) => a + b, 0)).toBe(A4_PORTRAIT);
    for (const x of w) expect(x).toBeGreaterThanOrEqual(300);
  });

  it('权重过小：折算后小于最窄列宽 → 报错并点出是哪一列', () => {
    expect(() => columnWidths([['a', 'b']], A4_PORTRAIT, H, [1, 100])).toThrow(/colWidths 的第 1 列折算后只有 0\.14 厘米，小于最窄列宽 1\.12 厘米/);
  });

  it('表内字号改了，边界跟着变', () => {
    expect(tableParams(13, A4_PORTRAIT, 28).dense).toBe(true);     // 14 磅的字：13 列放不下常规排版了
    expect(tableParams(14, A4_PORTRAIT, 16).dense).toBe(false);    // 8 磅的字：14 列仍是常规
  });
});

describe('T4 行高估算', () => {
  it('定点：一格的行数 = 各行 ceil(单位数 / 一行放得下的单位数) 之和，整行取最大的一格', () => {
    // 列宽 636：(636 − 216) / 105 = 4 个单位一行
    expect(rowLineEstimate(['ab'], [636], H)).toBe(1);
    expect(rowLineEstimate(['汉字汉'], [636], H)).toBe(2);              // 6 个单位 → 2 行
    expect(rowLineEstimate(['a\nb\nc'], [636], H)).toBe(3);             // 三个硬换行
    expect(rowLineEstimate(['', ''], [636, 636], H)).toBe(1);           // 空行也占一行
    expect(rowLineEstimate(['x', '汉'.repeat(20)], [636, 636], H)).toBe(10);
    expect(rowLineEstimate(['x', '汉'.repeat(20)], [636, 4416], H)).toBe(1);   // (4416 − 216) / 105 = 40 个单位
  });

  it('降级的表按收窄后的单元格边距算', () => {
    // 列宽 300：常规边距下一行只放得下 max(1, floor((300−216)/105)) = 1 个单位；降级边距下 (300−90)/105 = 2 个单位
    expect(rowLineEstimate(['汉字'], [300], H)).toBe(4);
    expect(rowLineEstimate(['汉字'], [300], H, 45)).toBe(2);
  });

  it('列比行多、行比列多都不越界读', () => {
    expect(rowLineEstimate(['a'], [636, 636, 636], H)).toBe(1);
    expect(rowLineEstimate(['a', 'b', 'c'], [636], H)).toBe(1);
  });
});

describe('T4 单位换算', () => {
  it('厘米 → twips：2.54 厘米 = 1440，3.18 厘米 = 1803（Word 的「常规」左右边距取整后是 1800）', () => {
    expect(cmToTw(2.54)).toBe(1440);
    expect(cmToTw(0.5)).toBe(283);
    expect(cmToTw(8)).toBe(4535);
    expect(DOCX_DEFAULTS.marginTw).toEqual({ top: 1440, right: 1800, bottom: 1440, left: 1800 });
  });
});
