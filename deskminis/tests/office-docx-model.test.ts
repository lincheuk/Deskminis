/** F10A · T2：Word 输入的规范化（normalizeDocx）。
 *
 *  两头都要守住：旧输入照常生成（不能因为新规则把以前能生成的输入拒掉），
 *  不合法的输入不再被静默吞掉（报错带字段路径、一次列全；不认识的字段逐个点名）。
 *  这里只测规范化这个纯函数，证明不了生成的文档在 Word 里的样子。 */
import { describe, it, expect } from 'vitest';
import { normalizeDocx, DOCX_LIMITS, type DocxModel } from '../src/minisd/office/docx/model';
import { OfficeInputError } from '../src/minisd/office/format';

const ok = (spec: unknown): { model: DocxModel; notes: string[] } => normalizeDocx(spec);
function errorOf(spec: unknown): string {
  try { normalizeDocx(spec); } catch (e) {
    expect(e).toBeInstanceOf(OfficeInputError);
    return (e as Error).message;
  }
  throw new Error('应该报错却通过了');
}

describe('T2 旧输入与空输入：成功且没有任何提示', () => {
  it('旧形态输入（heading / para / table）', () => {
    const { model, notes } = ok({ blocks: [
      { kind: 'heading', level: 1, text: '季度报告' },
      { kind: 'para', text: '营收增长 25%。' },
      { kind: 'table', rows: [['区域', '金额'], ['华东', '42']] },
    ] });
    expect(notes).toEqual([]);
    expect(model.inputBlocks).toBe(3);
    expect(model.blocks.map(b => b.kind)).toEqual(['heading', 'para', 'table']);
  });

  it('buildDocx({ title, blocks }) 的形态：title 进模型', () => {
    const { model, notes } = ok({ title: '季度报告', blocks: [{ kind: 'para', text: 'x' }] });
    expect(notes).toEqual([]);
    expect(model.title).toBe('季度报告');
  });

  it('{} 与 {"blocks":[]}：空文档', () => {
    for (const spec of [{}, { blocks: [] }]) {
      const { model, notes } = ok(spec);
      expect(notes).toEqual([]);
      expect(model.blocks).toEqual([]);
      expect(model.inputBlocks).toBe(0);
      expect(model.title).toBeUndefined();
    }
  });

  it('旧代码收下的宽松写法照旧：缺 text、缺 rows、缺 level、数字单元格', () => {
    const { model, notes } = ok({ blocks: [{ kind: 'heading' }, { kind: 'para' }, { kind: 'table' }, { kind: 'table', rows: [[1, 2.5]] }] });
    expect(model.blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: '' });
    expect(model.blocks[1]).toMatchObject({ kind: 'para', text: '' });
    expect(model.blocks[2]).toMatchObject({ kind: 'table', rows: [['1', '2.5']] });
    // 没有行的表不再写出一张空表（Word 里是不合法的），跳过并说明
    expect(notes).toEqual(['blocks[2]：表格没有任何单元格，已跳过']);
  });
});

describe('T2 默认值', () => {
  const { model } = ok({ blocks: [{ kind: 'para', text: '正文' }, { kind: 'table', rows: [['a', 'b'], ['c', 'd']] }] });
  it('页面：A4 纵向，上下 2.54 厘米、左右 3.18 厘米，页脚居中页码', () => {
    expect(model.page).toEqual({
      paper: 'A4', landscape: false, widthTw: 11906, heightTw: 16838,
      marginTw: { top: 1440, right: 1800, bottom: 1440, left: 1800 }, headerTw: 851, footerTw: 992,
      textWidthTw: 8306, pageNumber: 'bottom-center',
    });
  });
  it('字体与字号：正文宋体 + Times New Roman 小四，标题黑体 + Arial，表内五号', () => {
    expect(model.fonts).toEqual({
      bodyEastAsia: '宋体', bodyLatin: 'Times New Roman', headEastAsia: '黑体', headLatin: 'Arial',
      bodyHalfPt: 24, headHalfPt: [36, 32, 28, 24, 24, 24], tableHalfPt: 21,
    });
  });
  it('段落：1.5 倍行距、段前段后 0、首行缩进 2 字符、两端对齐', () => {
    expect(model.para).toEqual({ line240: 360, beforeTw: 0, afterTw: 0, firstLineChars: 2 });
    expect(model.blocks[0]).toEqual({ kind: 'para', text: '正文', align: 'justify', keepWithNext: false });
  });
  it('表格：首行当表头、各行不跨页断开、列宽铺满版心', () => {
    const t = model.blocks[1];
    expect(t.kind === 'table' && t.headerRows).toBe(1);
    expect(t.kind === 'table' && t.cantSplit).toEqual([true, true]);
    expect(t.kind === 'table' && t.colsTw.reduce((a, b) => a + b, 0)).toBe(8306);
    expect(t.kind === 'table' && [t.padTw, t.dense]).toEqual([108, false]);
  });
});

describe('T2 取值不合法：报错、带字段路径、一次列全', () => {
  it('content 不是对象', () => {
    for (const spec of [null, [], 'x', 5]) expect(errorOf(spec)).toMatch(/content 应是一个 JSON 对象/);
  });

  it('未知的块类型报错并列出支持的五种（以前静默当段落）', () => {
    expect(errorOf({ blocks: [{ kind: 'image', text: 'x' }] })).toBe('blocks[0].kind：不支持 "image"，只支持 heading / para / list / table / pageBreak');
    expect(errorOf({ blocks: [{ text: '没有 kind' }] })).toBe('blocks[0].kind：缺少 kind，只支持 heading / para / list / table / pageBreak');
    expect(errorOf({ blocks: ['不是对象'] })).toBe('blocks[0]：应是一个对象');
    expect(errorOf({ blocks: 'x' })).toBe('blocks：应是一个数组');
  });

  it('逐类非法取值', () => {
    const cases: [unknown, RegExp][] = [
      [{ page: { size: 'A2' } }, /^page\.size：只支持 A4 \/ A3 \/ A5 \/ B5 \/ Letter$/],
      [{ page: { orientation: 'sideways' } }, /^page\.orientation：只能是 portrait 或 landscape$/],
      [{ page: { pageNumber: 'top' } }, /^page\.pageNumber：只能是 bottom-center 或 none$/],
      [{ page: { marginsCm: { left: 0.2 } } }, /^page\.marginsCm\.left：应是 0\.5–8（厘米）$/],
      [{ page: { marginsCm: { top: 9 } } }, /^page\.marginsCm\.top：应是 0\.5–8（厘米）$/],
      [{ page: { marginsCm: { left: 8, right: 8 } } }, /版心只剩 5\.00 厘米宽（至少 8 厘米）/],
      [{ page: { size: 'A5', orientation: 'landscape', marginsCm: { top: 4, bottom: 4 } } }, /版心只剩 6\.80 厘米高（至少 8 厘米）/],
      [{ page: 'A4' }, /^page：应是一个对象$/],
      [{ style: { bodyFont: { eastAsia: '方正小标宋' } } }, /^style\.bodyFont\.eastAsia：只支持 宋体 \/ 黑体 \/ 微软雅黑 \/ 仿宋 \/ 楷体 \/ 等线$/],
      [{ style: { headingFont: { latin: 'Comic Sans' } } }, /^style\.headingFont\.latin：只支持 Times New Roman \/ Arial \/ Calibri$/],
      [{ style: { bodySizePt: 8 } }, /^style\.bodySizePt：应是 9–16 之间、0\.5 的倍数的字号（磅）$/],
      [{ style: { bodySizePt: 12.3 } }, /^style\.bodySizePt：/],
      [{ style: { tableSizePt: 15 } }, /^style\.tableSizePt：应是 8–14/],
      [{ style: { headingSizesPt: [18, 40] } }, /^style\.headingSizesPt\[1\]：应是 9–36/],
      [{ style: { headingSizesPt: [1, 2, 3, 4, 5, 6, 7] } }, /^style\.headingSizesPt：应是至多 6 个字号的数组/],
      [{ style: { lineSpacing: 0.8 } }, /^style\.lineSpacing：应是 1\.0–3\.0（倍）$/],
      [{ style: { paraSpacingPt: { after: 40 } } }, /^style\.paraSpacingPt\.after：应是 0–36（磅）$/],
      [{ style: { firstLineIndentChars: 1 } }, /^style\.firstLineIndentChars：只能是 0 或 2$/],
      [{ blocks: [{ kind: 'para', text: 'x', align: 'middle' }] }, /^blocks\[0\]\.align：只能是 left \/ center \/ right \/ justify$/],
      [{ blocks: [{ kind: 'para', text: { a: 1 } }] }, /^blocks\[0\]\.text：应是文字，收到的是对象$/],
      [{ blocks: [{ kind: 'para', text: ['a'] }] }, /^blocks\[0\]\.text：应是文字，收到的是数组$/],
      [{ blocks: [{ kind: 'para', text: 'x', keepWithNext: 'yes' }] }, /^blocks\[0\]\.keepWithNext：只能是 true 或 false$/],
      [{ blocks: [{ kind: 'heading', text: 'x', pageBreakBefore: 1 }] }, /^blocks\[0\]\.pageBreakBefore：只能是 true 或 false$/],
      [{ blocks: [{ kind: 'list', items: 'a,b' }] }, /^blocks\[0\]\.items：应是一个数组$/],
      [{ blocks: [{ kind: 'list', ordered: 'yes', items: ['a'] }] }, /^blocks\[0\]\.ordered：只能是 true 或 false$/],
      [{ blocks: [{ kind: 'table', rows: 'a' }] }, /^blocks\[0\]\.rows：应是「行的数组」/],
      [{ blocks: [{ kind: 'table', rows: [['a'], 'b'] }] }, /^blocks\[0\]\.rows：应是「行的数组」/],
      [{ blocks: [{ kind: 'table', rows: [['a', 'b'], ['c', 'd']], headerRows: 2 }] }, /^blocks\[0\]\.headerRows：应是 0–1 的整数/],
      [{ blocks: [{ kind: 'table', rows: [['a', 'b']], headerRows: 1.5 }] }, /^blocks\[0\]\.headerRows：应是 0–0 的整数/],
      [{ blocks: [{ kind: 'table', rows: [['a', 'b']], colWidths: [1] }] }, /^blocks\[0\]\.colWidths：应是 2 个大于 0 的数/],
      [{ blocks: [{ kind: 'table', rows: [['a', 'b']], colWidths: [1, 0] }] }, /^blocks\[0\]\.colWidths：应是 2 个大于 0 的数/],
      [{ blocks: [{ kind: 'table', rows: [['a', 'b']], colWidths: [1, 100] }] }, /^blocks\[0\]\.colWidths：colWidths 的第 1 列折算后只有/],
      [{ blocks: [{ kind: 'table', rows: [['a']], allowRowSplit: 'no' }] }, /^blocks\[0\]\.allowRowSplit：只能是 true 或 false$/],
    ];
    for (const [spec, re] of cases) expect(errorOf(spec), JSON.stringify(spec)).toMatch(re);
  });

  it('一次列全：三处错误都在同一句里', () => {
    const msg = errorOf({ page: { size: 'A2' }, style: { lineSpacing: 5 }, blocks: [{ kind: 'para', text: 'x', align: 'middle' }] });
    expect(msg.split('；')).toHaveLength(3);
    expect(msg).toContain('page.size');
    expect(msg).toContain('style.lineSpacing');
    expect(msg).toContain('blocks[0].align');
  });

  it('超过 10 处只列 10 处，其余写「另有 N 处」', () => {
    const blocks = Array.from({ length: 13 }, () => ({ kind: 'para', text: 'x', align: 'middle' }));
    const msg = errorOf({ blocks });
    expect(msg.endsWith('；另有 3 处')).toBe(true);
    expect(msg.split('；')).toHaveLength(11);
  });
});

describe('T2 不认识的字段：不报错、不影响生成、逐个点名', () => {
  it('任何层级的未知字段都进 notes', () => {
    const { model, notes } = ok({
      author: '某人',
      page: { size: 'A4', columns: 2, marginsCm: { top: 2, gutter: 1 } },
      style: { bodySizePt: 12, color: 'red', bodyFont: { eastAsia: '宋体', weight: 'bold' }, paraSpacingPt: { before: 0, between: 3 } },
      blocks: [
        { kind: 'para', text: '正文', bold: true },
        { kind: 'heading', text: '标题', align: 'center' },
        { kind: 'list', items: [{ text: '项', level: 0, checked: true }], start: 5 },
        { kind: 'table', rows: [['a']], merge: [[0, 0]] },
        { kind: 'pageBreak', text: '多余' },
      ],
    });
    expect(notes).toEqual([
      '未采用的字段 author',
      '未采用的字段 page.columns',
      '未采用的字段 page.marginsCm.gutter',
      '未采用的字段 style.color',
      '未采用的字段 style.bodyFont.weight',
      '未采用的字段 style.paraSpacingPt.between',
      '未采用的字段 blocks[0].bold',
      '未采用的字段 blocks[1].align',
      '未采用的字段 blocks[2].start',
      '未采用的字段 blocks[2].items[0].checked',
      '未采用的字段 blocks[3].merge',
      '未采用的字段 blocks[4].text',
    ]);
    expect(model.blocks).toHaveLength(5);
  });
});

describe('T2 heading.level', () => {
  const levelOf = (level: unknown): { level: number; notes: string[] } => {
    const { model, notes } = ok({ blocks: [{ kind: 'heading', level, text: 't' }] });
    const b = model.blocks[0];
    return { level: b.kind === 'heading' ? b.level : -1, notes };
  };
  it('数字字符串 "2" 仍是二级标题（旧代码的 Math.max("2", 1) 得 2），没有提示', () => {
    expect(levelOf('2')).toEqual({ level: 2, notes: [] });
    expect(levelOf(3)).toEqual({ level: 3, notes: [] });
  });
  it('2.5 取整成二级并提示；"abc" 按一级并提示（旧代码会写出不存在的样式名）', () => {
    expect(levelOf(2.5)).toEqual({ level: 2, notes: ['blocks[0].level：2.5 按 2 级处理（只有 1–6 级的整数）'] });
    expect(levelOf('abc')).toEqual({ level: 1, notes: ['blocks[0].level："abc" 不是数字，按 1 级处理'] });
  });
  it('越界的夹到 1–6 并提示；缺省与 null 是一级，没有提示', () => {
    expect(levelOf(9)).toEqual({ level: 6, notes: ['blocks[0].level：9 按 6 级处理（只有 1–6 级的整数）'] });
    expect(levelOf(0)).toEqual({ level: 1, notes: ['blocks[0].level：0 按 1 级处理（只有 1–6 级的整数）'] });
    expect(levelOf(undefined)).toEqual({ level: 1, notes: [] });
    expect(levelOf(null)).toEqual({ level: 1, notes: [] });
  });
});

describe('T2 表格：列数、表头、补齐与跳过', () => {
  const wide = (cols: number): unknown => ({ blocks: [{ kind: 'table', rows: [Array.from({ length: cols }, (_, i) => `列${i + 1}`), Array.from({ length: cols }, () => '值')] }] });
  it('旧形态的 14 列、20 列表格在默认页面上成功，各有一条降级提示', () => {
    for (const cols of [14, 20]) {
      const { model, notes } = ok(wide(cols));
      const t = model.blocks[0];
      expect(t.kind === 'table' && [t.dense, t.padTw]).toEqual([true, 45]);
      expect(t.kind === 'table' && t.colsTw.reduce((a, b) => a + b, 0)).toBe(8306);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(new RegExp(`^blocks\\[0\\]：表格有 ${cols} 列，每列只有 \\d\\.\\d\\d 厘米，文字会逐字折行；建议 page\\.orientation 用 landscape、拆表或改用 xlsx$`));
    }
    expect(ok(wide(20)).notes[0]).toContain('每列只有 0.73 厘米');
  });
  it('13 列是常规排版，没有提示', () => {
    const { model, notes } = ok(wide(13));
    expect(notes).toEqual([]);
    expect(model.blocks[0].kind === 'table' && model.blocks[0].dense).toBe(false);
  });
  it('28 列（一个字也放不下）与 64 列（超过 Word 的上限）报错', () => {
    expect(errorOf(wide(28))).toBe('blocks[0].rows：28 列在当前版心里连一个字都放不下（最多 27 列）');
    expect(errorOf(wide(64))).toBe('blocks[0].rows：64 列，超过 Word 一张表的上限 63 列');
  });
  it('横向 A4 上 28 列可以生成（降级）', () => {
    const spec = wide(28) as { blocks: unknown[]; page?: unknown };
    spec.page = { orientation: 'landscape' };
    expect(ok(spec).notes).toHaveLength(1);
  });

  it('各行补空串到最宽列数', () => {
    const t = ok({ blocks: [{ kind: 'table', rows: [['a', 'b', 'c'], ['d'], []] }] }).model.blocks[0];
    expect(t.kind === 'table' && t.rows).toEqual([['a', 'b', 'c'], ['d', '', ''], ['', '', '']]);
  });

  it('0 行或 0 列的表跳过并说明；空列表、全是空白项的列表同样', () => {
    const { model, notes } = ok({ blocks: [
      { kind: 'table', rows: [] }, { kind: 'table', rows: [[], []] },
      { kind: 'list', items: [] }, { kind: 'list', items: ['', '   ', { text: '\n' }] },
      { kind: 'para', text: '还在' },
    ] });
    expect(model.blocks).toHaveLength(1);
    expect(model.inputBlocks).toBe(5);
    expect(notes).toEqual([
      'blocks[0]：表格没有任何单元格，已跳过', 'blocks[1]：表格没有任何单元格，已跳过',
      'blocks[2]：列表没有任何非空的项，已跳过', 'blocks[3]：列表没有任何非空的项，已跳过',
    ]);
  });

  it('headerRows 缺省：两行及以上是 1，只有一行是 0；显式给 0 就没有表头', () => {
    const hr = (rows: unknown[][], headerRows?: number): number => {
      const t = ok({ blocks: [{ kind: 'table', rows, ...(headerRows === undefined ? {} : { headerRows }) }] }).model.blocks[0];
      return t.kind === 'table' ? t.headerRows : -1;
    };
    expect(hr([['a'], ['b']])).toBe(1);
    expect(hr([['只有一行']])).toBe(0);
    expect(hr([['a'], ['b'], ['c']], 0)).toBe(0);
    expect(hr([['a'], ['b'], ['c']], 2)).toBe(2);
  });

  it('表头过长（估算超过 12 行）时归 0 并说明：缺省与显式给的一视同仁', () => {
    const long = '字'.repeat(3000);
    for (const extra of [{}, { headerRows: 1 }]) {
      const { model, notes } = ok({ blocks: [{ kind: 'table', rows: [['首行', long], ['a', 'b'], ['c', 'd']], ...extra }] });
      const t = model.blocks[0];
      expect(t.kind === 'table' && t.headerRows).toBe(0);
      // 首行太高：不设表头，也不强行留在一页里；其余行照常不跨页断开
      expect(t.kind === 'table' && t.cantSplit).toEqual([false, true, true]);
      expect(notes).toEqual(['blocks[0]：首行内容太长，没有按表头处理（不跨页重复）']);
    }
  });

  it('高行（估算超过 12 行）允许跨页断开；allowRowSplit 让所有数据行都允许，表头行仍不拆', () => {
    const tall = '字'.repeat(2000);
    const a = ok({ blocks: [{ kind: 'table', rows: [['h1', 'h2'], ['x', tall], ['y', 'z']] }] }).model.blocks[0];
    expect(a.kind === 'table' && a.cantSplit).toEqual([true, false, true]);
    const b = ok({ blocks: [{ kind: 'table', rows: [['h1', 'h2'], ['x', 'y'], ['z', 'w']], allowRowSplit: true }] }).model.blocks[0];
    expect(b.kind === 'table' && b.cantSplit).toEqual([true, false, false]);
  });
});

describe('T2 列表', () => {
  it('每个 list 块一个 numId（按出现序，从 1 起）；空白项丢弃；级别夹到 0–2 并提示', () => {
    const { model, notes } = ok({ blocks: [
      { kind: 'list', items: ['甲', { text: '乙', level: 1 }, '', { text: '丙', level: 5 }, 42] },
      { kind: 'list', ordered: true, items: ['一'] },
    ] });
    expect(model.blocks[0]).toEqual({ kind: 'list', ordered: false, numId: 1, items: [{ text: '甲', level: 0 }, { text: '乙', level: 1 }, { text: '丙', level: 2 }, { text: '42', level: 0 }] });
    expect(model.blocks[1]).toMatchObject({ kind: 'list', ordered: true, numId: 2 });
    expect(notes).toEqual(['blocks[0].items[3].level：5 按 2 处理（只有 0–2 三级）']);
  });
});

describe('T2 文本清洗', () => {
  it('控制字符去掉、落单代理项换成 U+FFFD、\\r\\n 与 \\r 归成 \\n，并提示去掉了多少个', () => {
    const { model, notes } = ok({ blocks: [
      { kind: 'para', text: 'a\u0001b\u000bc\u001fd' },
      { kind: 'para', text: '前\ud83d后\udc00尾，成对的 😀 不动' },
      { kind: 'para', text: '一\r\n二\r三\n四\t五' },
    ] });
    expect(model.blocks.map(b => (b.kind === 'para' ? b.text : ''))).toEqual(['abcd', '前�后�尾，成对的 😀 不动', '一\n二\n三\n四\t五']);
    expect(notes).toEqual(['已去掉 5 个 Word 不接受的字符（控制字符等）']);
  });

  it('标题与文档标题是单行的：换行、制表符变空格；正文里的保留', () => {
    const { model } = ok({ title: '第一行\n第二行', blocks: [{ kind: 'heading', text: '甲\t乙\n丙' }, { kind: 'para', text: '甲\t乙\n丙' }] });
    expect(model.title).toBe('第一行 第二行');
    expect(model.blocks[0]).toMatchObject({ text: '甲 乙 丙' });
    expect(model.blocks[1]).toMatchObject({ text: '甲\t乙\n丙' });
  });

  it('数字、布尔当文字收下；null 当空串', () => {
    const { model } = ok({ title: 2026, blocks: [{ kind: 'para', text: 3.5 }, { kind: 'para', text: true }, { kind: 'para', text: null }] });
    expect(model.title).toBe('2026');
    expect(model.blocks.map(b => (b.kind === 'para' ? b.text : '?'))).toEqual(['3.5', 'true', '']);
  });
});

describe('T2 规模：上界定在旧输入到不了的量级', () => {
  it('2500 行的表、6000 个块照常生成', () => {
    const rows = Array.from({ length: 2500 }, (_, i) => [`${i}`, '值']);
    expect(ok({ blocks: [{ kind: 'table', rows }] }).model.blocks).toHaveLength(1);
    const blocks = Array.from({ length: 6000 }, (_, i) => ({ kind: 'para', text: `第 ${i} 段` }));
    expect(ok({ blocks }).model.blocks).toHaveLength(6000);
  });

  it('超过 DOCX_LIMITS 才报错：块 + 列表项 + 单元格合计、全文字符数、单表行数', () => {
    expect(DOCX_LIMITS).toEqual({ textChars: 2_000_000, units: 200_000, tableRows: 32_767, tableCols: 63 });
    const cells = Array.from({ length: 20_001 }, () => Array.from({ length: 10 }, () => ''));
    expect(errorOf({ blocks: [{ kind: 'table', rows: cells }] })).toBe('内容太多：块、列表项、单元格合计超过 200000 个');
    const big = 'x'.repeat(1_000_001);
    expect(errorOf({ blocks: [{ kind: 'para', text: big }, { kind: 'para', text: big }] })).toBe('内容太多：全文超过 2000000 个字符');
    const rows = Array.from({ length: 32_768 }, () => ['x']);
    expect(errorOf({ blocks: [{ kind: 'table', rows }] })).toBe('blocks[0].rows：32768 行，超过 Word 一张表的上限 32767 行');
  });

  it('字体别名：英文名不分大小写，落到白名单里的中文名', () => {
    const { model } = ok({ style: { bodyFont: { eastAsia: 'microsoft yahei', latin: 'arial' }, headingFont: { eastAsia: 'KaiTi', latin: 'CALIBRI' } } });
    expect(model.fonts).toMatchObject({ bodyEastAsia: '微软雅黑', bodyLatin: 'Arial', headEastAsia: '楷体', headLatin: 'Calibri' });
  });
});
