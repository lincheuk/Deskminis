/** F10A：固定种子的随机**合法** Word 输入（防误报用）。
 *
 *  内容核验「不过就不写文件」，所以它绝不能对合法输入误报；覆盖判定「不是自己的产物就拒绝」，
 *  所以生成器走到的任何分支都不能被自己拒掉。固定夹具走不到的分支（空白文本、控制字符、嵌套列表、
 *  空表、各字段的非默认值……）靠这里的随机输入兜住。
 *
 *  生成的输入一定通过 normalizeDocx（取值都在合法范围内）；同一个种子永远得到同一份输入。 */
import type { DocxBlock, DocxInput, DocxPage, DocxStyle } from '../src/minisd/office/docx/model';

/** mulberry32：测试要可复现，不用 Math.random。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = [
  '', ' ', '   ', '中文文本', 'English text', 'a & b < c > "d" \'e\'', '多行\n文本\t制表', '控制\u0001字符\u000b在\u001f内', '  两侧有空格  ',
  '表情 😀 与生僻字 𠮷', 'Windows\r\n换行与\r回车', '实体样子的 &amp; &#65; &lt;', '落单代理项\ud83d在此', '全角（括号）与“引号”——破折号……',
  '较长的一段文字，'.repeat(12), '\n', '\t', '末尾换行\n', '12345', 'x'.repeat(70),
];

export function randomDocxInput(seed: number): DocxInput {
  const r = seededRandom(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const maybe = (p: number): boolean => r() < p;
  const text = (): string => pick(TEXTS);

  const input: { title?: string; page?: DocxPage; style?: DocxStyle; blocks: DocxBlock[] } = { blocks: [] };
  if (maybe(0.4)) input.title = text();
  if (maybe(0.5)) {
    const page: DocxPage = {};
    if (maybe(0.6)) page.size = pick(['A4', 'A3', 'A5', 'B5', 'Letter'] as const);
    if (maybe(0.5)) page.orientation = pick(['portrait', 'landscape'] as const);
    if (maybe(0.5)) page.pageNumber = pick(['bottom-center', 'none'] as const);
    if (maybe(0.5)) {
      // 每边 0.5–2.5 厘米：最小的纸（A5）扣掉之后版心仍有 9.8 厘米
      const cm = (): number => int(5, 25) / 10;
      page.marginsCm = { top: cm(), bottom: cm(), left: cm(), right: cm() };
    }
    input.page = page;
  }
  if (maybe(0.5)) {
    const style: DocxStyle = {};
    if (maybe(0.5)) style.bodyFont = { eastAsia: pick(['宋体', '黑体', '微软雅黑', '仿宋', '楷体', '等线'] as const), latin: pick(['Times New Roman', 'Arial', 'Calibri'] as const) };
    if (maybe(0.5)) style.headingFont = { eastAsia: pick(['宋体', '黑体', '微软雅黑', '楷体'] as const), latin: pick(['Arial', 'Calibri'] as const) };
    if (maybe(0.5)) style.bodySizePt = int(18, 32) / 2;
    if (maybe(0.3)) style.headingSizesPt = Array.from({ length: int(0, 6) }, () => int(18, 72) / 2);
    if (maybe(0.4)) style.tableSizePt = int(16, 28) / 2;
    if (maybe(0.4)) style.lineSpacing = int(100, 300) / 100;
    if (maybe(0.4)) style.paraSpacingPt = { before: int(0, 36), after: int(0, 36) };
    if (maybe(0.4)) style.firstLineIndentChars = pick([0, 2] as const);
    input.style = style;
  }
  const n = int(0, 12);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.2) {
      input.blocks.push({ kind: 'heading', ...(maybe(0.8) ? { level: int(1, 6) } : {}), text: text(), ...(maybe(0.2) ? { pageBreakBefore: maybe(0.5) } : {}) });
    } else if (k < 0.5) {
      input.blocks.push({ kind: 'para', text: text(), ...(maybe(0.4) ? { align: pick(['left', 'center', 'right', 'justify'] as const) } : {}), ...(maybe(0.2) ? { keepWithNext: maybe(0.5) } : {}) });
    } else if (k < 0.7) {
      const items = Array.from({ length: int(0, 6) }, () => (maybe(0.5) ? text() : { text: text(), ...(maybe(0.7) ? { level: int(0, 2) } : {}) }));
      input.blocks.push({ kind: 'list', ...(maybe(0.6) ? { ordered: maybe(0.5) } : {}), items });
    } else if (k < 0.93) {
      const cols = int(0, 5);
      const rowCount = int(0, 5);
      const rows = Array.from({ length: rowCount }, () => Array.from({ length: maybe(0.8) ? cols : int(0, cols) }, () => (maybe(0.2) ? int(-5, 5000) / (maybe(0.5) ? 1 : 4) : text())));
      const width = rows.reduce((a, row) => Math.max(a, row.length), 0);
      const b: Extract<DocxBlock, { kind: 'table' }> = { kind: 'table', rows };
      if (rowCount >= 1 && width >= 1 && maybe(0.4)) b.headerRows = int(0, Math.min(5, rowCount - 1));
      // 权重只在三列以内给：最窄的版心（8 厘米）下 1:2:2 也不会低于最窄列宽
      if (width >= 1 && width <= 3 && maybe(0.4)) b.colWidths = Array.from({ length: width }, () => int(1, 2));
      if (maybe(0.3)) b.allowRowSplit = maybe(0.5);
      input.blocks.push(b);
    } else {
      input.blocks.push({ kind: 'pageBreak' });
    }
  }
  return input;
}
