/** F10A · T10：真实 Word 量测的判定函数（judgeDocxLayout）会不会红。
 *
 *  取证脚本只量不判，「合不合格」全在这个纯函数里。这里手工构造一份合格的量测（按 report 夹具的期望），
 *  再逐项只改坏一个读数：不过的检查 id 必须**正好是**对应那一项——判定写成恒真、或容差放得过大，这里就红。
 *  （真实 Word 的变异文件会连带出别的红项，那边用包含关系判；这里的量测是手工构造的，所以要求「正好一项」。）
 *
 *  这些用例证明「检查会红」，不证明任何一份文档的版式——版式证据是取证存档里的量测、PDF 与逐页 PNG。 */
import { describe, it, expect } from 'vitest';
import { normalizeDocx, DOCX_FIELDS } from '../src/minisd/office/docx/model';
import {
  expectationsOf, judgeDocxLayout, DOCX_FIELD_CHECKS,
  type DocxExpectation, type DocxMeasurement, type DocxMeasuredParagraph, type DocxMeasuredTable, type DocxInkPage,
} from '../src/minisd/office/docx/layout-judge';
import { reportInput, variantsInput, emptyInput, DOCX_FIXTURES, DOCX_FIXTURE_PINS } from './office-docx-fixtures';

const b = (v: boolean | undefined): number => (v ? -1 : 0);

/** 按期望合成一份「Word 量出来正好如此」的量测。页的分配：从第 1 页起，必须另起一页的块页码加一；
 *  要求跨页的表前一半行在当前页、后一半在下一页。skipBreak：让这一块不另起一页（造「分页没生效」的量测）。 */
function synth(e: DocxExpectation, opt: { skipBreak?: number } = {}): DocxMeasurement {
  let page = 1;
  const paragraphs: DocxMeasuredParagraph[] = e.paragraphs.map((w, i) => ({
    i: i + 1, text: `${w.text.slice(0, 39)}\r`, empty: w.kind === 'gap' || w.kind === 'pageBreak' || w.text.trim() === '', style: null,
    farEast: w.farEast ?? e.fonts.bodyEastAsia, ascii: w.ascii ?? e.fonts.bodyLatin, size: w.sizePt ?? 1,
    align: w.align ?? (w.kind === 'heading' && w.level === 1 ? 1 : w.kind === 'heading' ? 0 : 3),
    firstLineChars: w.firstLineChars ?? 0, firstLineIndent: 0, lineRule: 5, lineSpacing: w.lineSpacingPt ?? 15,
    before: w.beforePt ?? 0, after: w.afterPt ?? 0, leftIndent: 0,
    keepNext: b(w.keepNext), keepTogether: b(w.keepTogether), pageBreakBefore: b(w.pageBreakBefore),
    startPage: 1, endPage: 1, nextPage: null, listString: w.listString ?? '', listLevel: w.listLevel ?? 1,
  }));
  const tables: DocxMeasuredTable[] = e.tables.map((w, i) => ({
    i: i + 1, rows: w.rows, cols: w.colsPt.length, leftIndent: 0, allowAutoFit: false, colWidths: [...w.colsPt],
    firstCell: { text: 'x', farEast: e.fonts.bodyEastAsia, ascii: e.fonts.bodyLatin, size: e.fonts.tablePt },
    rowInfo: w.cantSplit.map((cant, r) => ({ heading: b(r < w.headerRows), allowBreak: b(!cant), startPage: 1, endPage: 1 })),
  }));
  const starts: number[] = [];
  e.blocks.forEach((blk, bi) => {
    if (blk.newPage && bi > 0 && opt.skipBreak !== bi) page++;
    starts.push(page);
    for (const pi of blk.paragraphs) { paragraphs[pi].startPage = page; paragraphs[pi].endPage = page; }
    if (blk.table !== undefined) {
      const rows = tables[blk.table].rowInfo;
      const spans = (e.tablesSpanPages ?? []).includes(blk.table) && rows.length > 1;
      rows.forEach((r, ri) => { const p = spans && ri >= Math.ceil(rows.length / 2) ? page + 1 : page; r.startPage = p; r.endPage = p; });
      if (spans) page++;
    }
  });
  // 夹具指定要断开的行：首尾不同页
  for (const [t, r] of e.splitRows ?? []) tables[t].rowInfo[r].endPage = tables[t].rowInfo[r].startPage + 1;
  // 间隔段落与分页符段落跟着前一块；每个段落的「下一块所在页」
  e.blocks.forEach((blk, bi) => { for (const pi of blk.paragraphs) paragraphs[pi].nextPage = bi + 1 < starts.length ? starts[bi + 1] : null; });
  let last = 1;
  paragraphs.forEach((p, i) => { if (e.paragraphs[i].kind === 'gap' || e.paragraphs[i].kind === 'pageBreak') { p.startPage = last; p.endPage = last; } else last = p.endPage; });
  const pages = page;
  const footY = e.page.heightPt - e.page.footerPt;
  const ink: DocxInkPage[] = Array.from({ length: pages }, (_, i) => ({
    page: i + 1, nonWhiteRatio: 0.05, all: { dark: 5000, bbox: [e.page.leftPt, e.page.topPt, e.page.widthPt - e.page.rightPt, footY] },
    left: { dark: 0, bbox: null }, right: { dark: 0, bbox: null }, top: { dark: 0, bbox: null },
    bottom: e.pageNumber ? { dark: 30, bbox: [296, footY - 8, 299, footY - 2] } : { dark: 0, bbox: null },
  }));
  const pdfFonts = ['SimSun', 'SimHei', 'TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT', 'ArialMT'];
  return {
    compatMode: 15, pages,
    section: { pageWidth: e.page.widthPt, pageHeight: e.page.heightPt, orientation: e.page.landscape ? 1 : 0, top: e.page.topPt, bottom: e.page.bottomPt, left: e.page.leftPt, right: e.page.rightPt },
    footerFieldTypes: e.pageNumber ? [33] : [], docTitle: e.title, paragraphs, tables,
    text: e.texts.map(t => t.replace(/\n/g, '\u000b')).join('\r'), lastContentPage: e.blank ? null : pages,
    pdfPages: pages, pdfFonts, pdfText: [e.texts.join(' '), ...Array.from({ length: pages - 1 }, () => '2')], ink,
  };
}
const redOf = (m: DocxMeasurement, e: DocxExpectation): string[] => judgeDocxLayout(m, e).filter(c => !c.ok && !c.unmeasured).map(c => c.id);
const unmeasuredOf = (m: DocxMeasurement, e: DocxExpectation): string[] => judgeDocxLayout(m, e).filter(c => c.unmeasured).map(c => c.id);

/** 夹具附加的期望，去掉钉住的页数：合成的量测自己排页，页数与真实 Word 排出来的不是一回事（钉页数另有一条用例）。 */
function pinsOf(name: string): Omit<NonNullable<(typeof DOCX_FIXTURE_PINS)[string]>, 'pages'> {
  const { pages: _pages, ...rest } = DOCX_FIXTURE_PINS[name] ?? {};
  return rest;
}
const E: DocxExpectation = { ...expectationsOf(normalizeDocx(reportInput()).model), ...pinsOf('report') };
const good = (): DocxMeasurement => synth(E);
const paraIndex = (kind: string, pred: (i: number) => boolean = () => true): number => E.paragraphs.findIndex((p, i) => p.kind === kind && pred(i));
const BODY = paraIndex('para');
const HEAD2 = E.paragraphs.findIndex(p => p.kind === 'heading' && p.level === 2);
const LIST_SECOND_ORDERED = E.paragraphs.findIndex(p => p.kind === 'list' && p.text === '第二个有序列表的第一项');

describe('T10 合格的量测', () => {
  it('report 夹具的期望 + 按它合成的量测 → 每一项都通过，一项都没有「没量到」', () => {
    const items = judgeDocxLayout(good(), E);
    expect(items.filter(c => !c.ok)).toEqual([]);
    expect(items.map(c => c.id)).toEqual(['open', 'compat-mode', 'paper', 'margins', 'font-body', 'font-heading', 'font-table', 'fonts-pdf', 'heading-size',
      'para-format', 'para-spacing', 'table-bounds', 'table-col-widths', 'ink-outside', 'table-header-repeat', 'row-split', 'row-allow-split',
      'heading-with-next', 'keep-with-next', 'page-break', 'page-number', 'list-restart', 'text-complete', 'text-rendered', 'no-trailing-blank',
      'page-count', 'doc-title']);
  });

  it('另外几份夹具（每个字段都取非默认值的 variants、空文档、其余全部）合成出来也都通过', () => {
    for (const [name, make] of Object.entries({ ...DOCX_FIXTURES, variants: variantsInput, empty: emptyInput })) {
      const e = { ...expectationsOf(normalizeDocx(make()).model), ...pinsOf(name) };
      const m = synth(e);
      // 合成的 PDF 字体按默认字体给；换了字体的夹具把它换成模型用到的那几种
      m.pdfFonts = e.pdfFontsAllowed.map(f => ({ 宋体: 'SimSun', 黑体: 'SimHei', 微软雅黑: 'MicrosoftYaHei', 仿宋: 'FangSong', 楷体: 'KaiTi', 等线: 'DengXian', 'Times New Roman': 'TimesNewRomanPSMT', Arial: 'ArialMT', Calibri: 'Calibri' })[f]);
      expect(judgeDocxLayout(m, e).filter(c => !c.ok), name).toEqual([]);
    }
  });
});

describe('T10 只改坏一个读数：红的正好是对应那一项', () => {
  const cases: [string, string, (m: DocxMeasurement) => void][] = [
    ['兼容模式回到 12', 'compat-mode', m => { m.compatMode = 12; }],
    ['纸张宽了 20 磅', 'paper', m => { m.section.pageWidth += 20; }],
    ['方向读回是横向', 'paper', m => { m.section.orientation = 1; }],
    ['左边距差 5 磅', 'margins', m => { m.section.left -= 5; }],
    ['正文的东亚字体落到主题字体 +中文正文', 'font-body', m => { m.paragraphs[BODY].farEast = '+中文正文'; }],
    ['正文的西文字体是 Calibri', 'font-body', m => { m.paragraphs[BODY].ascii = 'Calibri'; }],
    ['正文字号差半磅', 'font-body', m => { m.paragraphs[BODY].size += 0.5; }],
    ['标题的东亚字体是等线', 'font-heading', m => { m.paragraphs[HEAD2].farEast = '等线'; }],
    ['表格首格的字体落到主题字体', 'font-table', m => { m.tables[0].firstCell!.farEast = '+中文正文'; }],
    ['表格首格的字号不对', 'font-table', m => { m.tables[1].firstCell!.size = 12; }],
    ['PDF 里嵌了等线', 'fonts-pdf', m => { m.pdfFonts = [...m.pdfFonts!, 'DengXian-Bold']; }],
    ['PDF 里没有宋体', 'fonts-pdf', m => { m.pdfFonts = m.pdfFonts!.filter(f => f !== 'SimSun'); }],
    ['标题字号翻倍', 'heading-size', m => { m.paragraphs[HEAD2].size *= 2; }],
    ['首行缩进读回是 0', 'para-format', m => { m.paragraphs[BODY].firstLineChars = 0; }],
    ['行距读回是单倍', 'para-format', m => { m.paragraphs[BODY].lineSpacing = 12; }],
    ['对齐读回是左对齐', 'para-format', m => { m.paragraphs[BODY].align = 0; }],
    ['标题段前差 3 磅', 'para-spacing', m => { m.paragraphs[HEAD2].before -= 3; }],
    ['列表项段后不是 0', 'para-spacing', m => { m.paragraphs[LIST_SECOND_ORDERED].after = 6; }],
    ['表格左缩进 30 磅（左缩进 + 列宽之和超出版心）', 'table-bounds', m => { m.tables[0].leftIndent = 30; }],
    ['表格左探 6 磅', 'table-bounds', m => { m.tables[0].leftIndent = -6; }],
    ['列宽偏 3 磅（总宽不变）', 'table-col-widths', m => { m.tables[0].colWidths![0] += 3; m.tables[0].colWidths![1] -= 3; }],
    ['表格允许自动调整', 'table-col-widths', m => { m.tables[2].allowAutoFit = true; }],
    ['右页边带里有墨迹', 'ink-outside', m => { m.ink![1].right = { dark: 40, bbox: [520, 300, 530, 310] }; }],
    ['上页边带里有一条线', 'ink-outside', m => { m.ink![0].top = { dark: 872, bbox: [88.7, 53.7, 507, 54.2] }; }],
    ['下页边带里页脚之外还有墨迹', 'ink-outside', m => { m.ink![0].bottom = { dark: 300, bbox: [90, 771, 505, 790] }; }],
    ['表头行不再跨页重复', 'table-header-repeat', m => { m.tables[0].rowInfo[0].heading = 0; }],
    ['长表只在一页里', 'table-header-repeat', m => { const first = m.tables[0].rowInfo[0].startPage; for (const r of m.tables[0].rowInfo) { r.startPage = first; r.endPage = first; } }],
    ['计划不断开的行跨了页', 'row-split', m => { m.tables[0].rowInfo[5].endPage = m.tables[0].rowInfo[5].startPage + 1; }],
    ['某行的「允许跨页断开」与计划相反', 'row-allow-split', m => { m.tables[0].rowInfo[5].allowBreak = -1; }],
    ['标题与下一块不在同一页', 'heading-with-next', m => { m.paragraphs[HEAD2].nextPage = m.paragraphs[HEAD2].endPage + 1; }],
    ['标题的「与下段同页」读回为假', 'keep-with-next', m => { m.paragraphs[HEAD2].keepNext = 0; }],
    ['正文段落多了「段前分页」', 'keep-with-next', m => { m.paragraphs[BODY].pageBreakBefore = -1; }],
    ['页脚里没有 PAGE 域', 'page-number', m => { m.footerFieldTypes = []; }],
    ['某一页页脚没有墨迹', 'page-number', m => { m.ink![1].bottom = { dark: 0, bbox: null }; }],
    ['第二个有序列表接着数（标号读回是 4.）', 'list-restart', m => { m.paragraphs[LIST_SECOND_ORDERED].listString = '4.'; }],
    ['列表级别不符', 'list-restart', m => { m.paragraphs[LIST_SECOND_ORDERED].listLevel = 2; }],
    ['全文少一块', 'text-complete', m => { m.text = m.text.replace('附录从新的一页开始，这里只有一段说明。', ''); }],
    ['全文里两块的顺序反了', 'text-complete', m => { m.text = m.text.replace('四、结论', '#').replace('附录', '四、结论').replace('#', '附录'); }],
    ['PDF 文字层少一段（对象模型的全文完整）', 'text-rendered', m => { m.pdfText = [m.pdfText![0]!.replace(/第10行的备注[^ ]*/, ''), ...m.pdfText!.slice(1)]; }],
    ['末页空白', 'no-trailing-blank', m => { m.lastContentPage = m.pages - 1; }],
    ['PDF 页数与 Word 不符', 'page-count', m => { m.pdfPages = m.pages + 1; }],
    ['PNG 少一张', 'page-count', m => { m.ink = m.ink!.slice(0, -1); }],
    ['有一页整页空白', 'page-count', m => { m.ink![1].all = { dark: m.ink![1].bottom.dark, bbox: m.ink![1].bottom.bbox }; }],
    ['文档标题不符', 'doc-title', m => { m.docTitle = '别的标题'; }],
  ];
  for (const [name, id, breakIt] of cases) {
    it(`${name} → ${id}`, () => {
      const m = good();
      breakIt(m);
      expect(redOf(m, E)).toEqual([id]);
    });
  }

  it('分页符之后的块没有另起一页 → page-break', () => {
    const afterBreak = E.blocks.findIndex(blk => blk.newPage);
    expect(afterBreak).toBeGreaterThan(0);
    expect(redOf(synth(E, { skipBreak: afterBreak }), E)).toEqual(['page-break']);
  });

  it('钉住的页数不符 → page-count（期望里钉的是回归值）', () => {
    const m = good();
    expect(redOf(m, { ...E, pages: m.pages })).toEqual([]);
    expect(redOf(m, { ...E, pages: m.pages + 1 })).toEqual(['page-count']);
    // 每个夹具都钉了页数（首轮真实 Word 取证的读数）
    for (const name of Object.keys(DOCX_FIXTURES)) expect(DOCX_FIXTURE_PINS[name]?.pages, name).toBeGreaterThanOrEqual(1);
  });

  it('夹具指定要断开的高行没有断开 → row-split', () => {
    const e = { ...expectationsOf(normalizeDocx(DOCX_FIXTURES['huge-cell']()).model), ...pinsOf('huge-cell') };
    const m = synth(e);
    expect(redOf(m, e)).toEqual([]);
    const [t, r] = e.splitRows![0];
    m.tables[t].rowInfo[r].endPage = m.tables[t].rowInfo[r].startPage;
    expect(redOf(m, e)).toEqual(['row-split']);
  });

  it('不要页码的文档里出现了页码 → page-number（域）与 ink-outside（下页边带的墨迹）分开报', () => {
    const e = expectationsOf(normalizeDocx(variantsInput()).model);
    const base = (): DocxMeasurement => { const m = synth(e); m.pdfFonts = ['MicrosoftYaHei', 'KaiTi', 'ArialMT', 'TimesNewRomanPSMT']; return m; };
    expect(redOf(base(), e)).toEqual([]);
    const withField = base(); withField.footerFieldTypes = [33];
    expect(redOf(withField, e)).toEqual(['page-number']);
    const withInk = base(); withInk.ink![0].bottom = { dark: 20, bbox: [296, 660, 299, 666] };
    expect(redOf(withInk, e)).toEqual(['ink-outside']);
  });
});

describe('T10 没量到不等于不合格', () => {
  it('PDF 字体名读不出（空或缺）→ fonts-pdf 记 unmeasured，不算红项', () => {
    for (const fonts of [[], null, undefined]) {
      const m = good(); m.pdfFonts = fonts as string[] | null | undefined;
      expect(redOf(m, E)).toEqual([]);
      expect(unmeasuredOf(m, E)).toEqual(['fonts-pdf']);
    }
  });

  it('PDF 文字层取不出（整体为 null，或某一页为 null）→ text-rendered 记 unmeasured', () => {
    const whole = good(); whole.pdfText = null;
    expect(redOf(whole, E)).toEqual([]);
    expect(unmeasuredOf(whole, E)).toEqual(['text-rendered']);
    const onePage = good(); onePage.pdfText = [onePage.pdfText![0], null, ...onePage.pdfText!.slice(2)];
    expect(unmeasuredOf(onePage, E)).toEqual(['text-rendered']);
  });

  it('没有逐页 PNG 的墨迹读数 → ink-outside、page-number、page-count 都是 unmeasured', () => {
    const m = good(); m.ink = null;
    expect(redOf(m, E)).toEqual([]);
    expect(unmeasuredOf(m, E).sort()).toEqual(['ink-outside', 'page-count', 'page-number']);
  });

  it('页脚的域、文档标题、表格读数、列表标号读不出 → 各自 unmeasured', () => {
    const m = good();
    m.footerFieldTypes = null; m.docTitle = null; m.tables[0].colWidths = null; m.tables[1].firstCell = null; m.paragraphs[LIST_SECOND_ORDERED].listString = null;
    expect(redOf(m, E)).toEqual([]);
    expect(unmeasuredOf(m, E).sort()).toEqual(['doc-title', 'font-table', 'list-restart', 'page-number', 'table-bounds', 'table-col-widths']);
  });

  it('带 unmeasured 的项 ok 一定是 false，actual 写「未量测」', () => {
    const m = good(); m.pdfText = null;
    const item = judgeDocxLayout(m, E).find(c => c.id === 'text-rendered')!;
    expect(item).toMatchObject({ ok: false, unmeasured: true, actual: '未量测' });
  });
});

describe('T10 期望是从模型推出来的', () => {
  it('report：页面、字体、表格与分页的期望', () => {
    expect(E.page).toEqual({ widthPt: 595.3, heightPt: 841.9, landscape: false, topPt: 72, rightPt: 90, bottomPt: 72, leftPt: 90, footerPt: 49.6, textWidthPt: 415.3 });
    expect(E).toMatchObject({ compatMode: 15, pageNumber: true, title: '固定中文报告', blank: false });
    expect(E.pdfFontsRequired).toEqual(['宋体', '黑体']);
    expect(E.tables.map(t => [t.rows, t.colsPt.length, t.headerRows])).toEqual([[81, 6, 1], [3, 2, 1], [5, 12, 1]]);
    expect(E.tables[0].colsPt.reduce((a, x) => a + x, 0)).toBeCloseTo(415.3, 6);
    // 必须另起一页的块：分页符之后的「四、结论」与带段前分页的「附录」
    expect(E.blocks.filter(blk => blk.newPage).map(blk => E.paragraphs[blk.paragraphs[0]].text)).toEqual(['四、结论', '附录']);
    expect(E.paragraphs[LIST_SECOND_ORDERED]).toMatchObject({ listString: '1.', listLevel: 1 });
  });

  it('列表标号：有序三级是 1. （1） a)，无序三级是 ● ○ ■；正文级段落里包含分页符与间隔段落', () => {
    const e = expectationsOf(normalizeDocx(variantsInput()).model);
    const labels = e.paragraphs.filter(p => p.kind === 'list').map(p => `${p.listString}/${p.listLevel}`);
    expect(labels).toEqual(['1./1', '（1）/2', 'a)/3', '2./1', '●/1', '○/2', '■/3']);
    const tail = expectationsOf(normalizeDocx({ blocks: [{ kind: 'para', text: 'a' }, { kind: 'pageBreak' }, { kind: 'table', rows: [['x']] }, { kind: 'table', rows: [['y']] }] }).model);
    expect(tail.paragraphs.map(p => p.kind)).toEqual(['para', 'pageBreak', 'gap', 'gap']);
    expect(tail.blocks.map(blk => blk.newPage)).toEqual([false, true, false]);
  });

  it('空文档：只有一个空段落，标成没有可见内容；合成量测全过', () => {
    const e = expectationsOf(normalizeDocx(emptyInput()).model);
    expect(e.blank).toBe(true);
    expect(e.paragraphs).toHaveLength(1);
    expect(e.pdfFontsRequired).toEqual([]);
    expect(redOf(synth(e), e)).toEqual([]);
  });
});

describe('T10 元测试：每个字段都有真实读回', () => {
  it('DOCX_FIELD_CHECKS 的键集合 = DOCX_FIELDS，每一项都指到至少一个确实存在的检查 id', () => {
    expect(Object.keys(DOCX_FIELD_CHECKS).sort()).toEqual([...DOCX_FIELDS].sort());
    const ids = new Set(judgeDocxLayout(good(), E).map(c => c.id));
    for (const [field, checks] of Object.entries(DOCX_FIELD_CHECKS)) {
      expect(checks.length, field).toBeGreaterThan(0);
      for (const id of checks) expect(ids.has(id), `${field} → ${id}`).toBe(true);
    }
  });
});
