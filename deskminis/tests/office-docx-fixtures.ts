/** F10A：Word 的固定夹具输入——仓库内用例与真实 Word 取证（work\verify\F10A\）共用同一份。
 *
 *  输入由这里的代码确定性地造出来（不读时钟、不取随机数），内容全是合成的，不含任何用户文件。
 *  取证脚本经 load-ts.mjs 直接加载本文件，所以「单测断言的」与「真实 Word 打开的」是同一份输入。
 *
 *  夹具各自要证明什么，见各函数上的注释与设计 §7.2。这里只有输入；它们在真实 Word 里长什么样，
 *  要看取证存档的逐页 PNG 与检查记录——仓库内的用例证明不了版式。 */
import type { DocxBlock, DocxInput } from '../src/minisd/office/docx/model';

const SENTENCE = '本段用于核对正文的排版效果，文字夹有 English words、数字 2026 与全角标点（括号）、“引号”；';
/** 一个 120 个字符、中间没有任何断行机会的网址 */
const LONG_URL = 'https://example.com/' + 'abcdefghij'.repeat(10);
/** 八百字以上的长段落：逐句编号，夹英文、数字和一个不断行的网址。 */
function longPara(tag: string): string {
  const parts: string[] = [];
  for (let i = 1; i <= 14; i++) parts.push(`${tag}第${i}句：${SENTENCE}`);
  parts.push(`参考网址 ${LONG_URL} 到此为止。`);
  return parts.join('');
}
/** 逐句编号、互不重复的文字：少画一句，字数就对不上（截断的判据靠它）。避开表头用字与纯数字。 */
function numberedProse(sentences: number): string {
  const tian = '甲乙丙丁戊己庚辛壬癸';
  const di = '子丑寅卯辰巳午未申酉戌亥';
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++) {
    parts.push(`${tian[i % 10]}${di[i % 12]}句${tian[Math.floor(i / 10) % 10]}${di[Math.floor(i / 12) % 12]}：逐句核对这一格里的文字有没有被裁掉。`);
  }
  return parts.join('');
}

/** `report` 里两处「卡在页底」的位置由填充行数决定，数值是在真实 Word 里标定后写死的（设计 R4）：
 *  - rowFill：长表之前的单行段落数，使去掉 cantSplit 的变异（M8）里恰有一行跨页断开；
 *  - headFill：「标定小节」标题之前的单行段落数，使去掉 keepNext 的变异（M9）里这个标题孤零零留在页底。 */
export const REPORT_CALIBRATION = { rowFill: 0, headFill: 26 };

/** 固定中文报告：多级标题、长段落、两级无序列表、两个有序列表、6 列 × 80 行的长表、小表、12 列宽表、分页符、附录、页码。 */
export function reportInput(cal: { rowFill: number; headFill: number } = REPORT_CALIBRATION): DocxInput {
  const filler = (prefix: string, n: number): DocxBlock[] =>
    Array.from({ length: n }, (_, i): DocxBlock => ({ kind: 'para', text: `${prefix}${String(i + 1).padStart(2, '0')}：单行的填充段落。` }));
  const longRows: string[][] = [['序号', '项目名称', '负责人', '状态', '金额（元）', '备注']];
  for (let i = 1; i <= 80; i++) {
    // 备注列两到五行不等：有的行够高，去掉「不跨页断开」之后会在页底被拆开
    const remark = `第${i}行的备注，写得稍长一些，好让这一格折成几行，用来观察行高与跨页。`.repeat(i % 5 === 0 ? 2 : 1);
    longRows.push([String(i), `项目${i}的名称`, ['张三', '李四', '王五'][i % 3], ['进行中', '已完成', '待启动'][i % 3], (i * 1234.5).toFixed(2), remark]);
  }
  const wide: string[][] = [Array.from({ length: 12 }, (_, c) => `列${c + 1}`)];
  for (let r = 1; r <= 4; r++) wide.push(Array.from({ length: 12 }, (_, c) => `${r}-${c + 1}`));
  return {
    title: '固定中文报告',
    blocks: [
      { kind: 'heading', level: 1, text: '固定中文报告' },
      { kind: 'heading', level: 2, text: '一、概述' },
      { kind: 'para', text: longPara('概述') },
      { kind: 'heading', level: 3, text: '1.1 背景' },
      { kind: 'para', text: '背景部分的一段普通正文，长度适中，用来观察首行缩进、两端对齐与一点五倍行距。' },
      { kind: 'heading', level: 4, text: '1.1.1 细节' },
      { kind: 'para', text: '四级标题之下的一小段说明。' },
      { kind: 'heading', level: 2, text: '二、要点' },
      { kind: 'list', items: ['无序列表第一项', { text: '无序列表的二级项甲', level: 1 }, { text: '无序列表的二级项乙', level: 1 }, '无序列表第二项'] },
      { kind: 'list', ordered: true, items: ['有序列表第一项', '有序列表第二项', { text: '有序列表的二级项', level: 1 }, '有序列表第三项'] },
      { kind: 'para', text: '两个有序列表之间的一段正文：下一个列表必须重新从一开始编号。' },
      { kind: 'list', ordered: true, items: ['第二个有序列表的第一项', '第二个有序列表的第二项'] },
      { kind: 'heading', level: 2, text: '三、数据' },
      { kind: 'heading', level: 3, text: '3.1 项目明细' },
      ...filler('明细说明', cal.rowFill),
      { kind: 'table', rows: longRows },
      { kind: 'heading', level: 3, text: '3.2 汇总' },
      { kind: 'table', rows: [['指标', '数值'], ['项目总数', '80'], ['已完成', '27']] },
      { kind: 'heading', level: 3, text: '3.3 宽表' },
      { kind: 'table', rows: wide },
      { kind: 'pageBreak' },
      { kind: 'heading', level: 2, text: '四、结论' },
      ...filler('核对项', cal.headFill),
      { kind: 'heading', level: 3, text: '4.1 标定小节' },
      { kind: 'para', text: longPara('结论') },
      { kind: 'heading', level: 2, text: '附录', pageBreakBefore: true },
      { kind: 'para', text: '附录从新的一页开始，这里只有一段说明。' },
    ],
  };
}

/** 每个字段都取非默认值：真实 Word 里逐项读回，证明「收下的字段都落到了文档里」。 */
export function variantsInput(): DocxInput {
  return {
    title: '字段取值样本',
    page: { size: 'B5', orientation: 'landscape', marginsCm: { top: 2, bottom: 2.2, left: 2.4, right: 2.6 }, pageNumber: 'none' },
    style: {
      bodyFont: { eastAsia: '微软雅黑', latin: 'Arial' },
      headingFont: { eastAsia: '楷体', latin: 'Times New Roman' },
      bodySizePt: 11, headingSizesPt: [22, 18, 15, 13, 12, 11], tableSizePt: 9,
      lineSpacing: 1.25, paraSpacingPt: { before: 3, after: 6 }, firstLineIndentChars: 0,
    },
    blocks: [
      { kind: 'heading', level: 1, text: '字段取值样本 Sample' },
      { kind: 'para', text: '默认对齐（两端）的一段正文，字体是微软雅黑加 Arial，十一磅，一点二五倍行距，段前三磅、段后六磅，不缩进。' },
      { kind: 'para', text: '靠左的一段。', align: 'left' },
      { kind: 'para', text: '居中的一段。', align: 'center' },
      { kind: 'para', text: '靠右的一段。', align: 'right' },
      { kind: 'para', text: '这一段要求与下一段同页。', keepWithNext: true },
      { kind: 'para', text: '紧跟着的下一段。', align: 'justify' },
      { kind: 'heading', level: 2, text: '二级标题' },
      { kind: 'list', ordered: true, items: ['有序一级', { text: '有序二级', level: 1 }, { text: '有序三级', level: 2 }, '有序一级之二'] },
      { kind: 'list', ordered: false, items: ['无序一级', { text: '无序二级', level: 1 }, { text: '无序三级', level: 2 }] },
      { kind: 'heading', level: 3, text: '三级标题' },
      { kind: 'table', headerRows: 2, colWidths: [1, 2, 3], allowRowSplit: true,
        rows: [['组别', '说明', '备注'], ['代号', '名称', '补充'], ['一', '第一行', '允许跨页断开'], ['二', '第二行', 42]] },
      { kind: 'pageBreak' },
      { kind: 'heading', level: 4, text: '四级标题（分页符之后）' },
      { kind: 'para', text: '分页符之后的正文。' },
      { kind: 'heading', level: 2, text: '另起一页的标题', pageBreakBefore: true },
      { kind: 'heading', level: 5, text: '五级标题' },
      { kind: 'heading', level: 6, text: '六级标题' },
      { kind: 'para', text: '结尾的一段。' },
    ],
  };
}

/** 旧形态输入原样（只有 blocks，三种块）：office-ooxml 用例的输入加上探测样本那样的多节文档。 */
export function legacyInput(): DocxInput {
  const para = '这是一段用于渲染验收的中文正文，包含 English words、数字 12345 与标点符号；它会重复多次以撑满版面，从而让 Word 把文档分成多页。';
  const blocks: DocxBlock[] = [
    { kind: 'heading', level: 1, text: '季度报告' },
    { kind: 'para', text: '营收增长 25%，其中华东占比最高。' },
    { kind: 'table', rows: [['区域', '金额'], ['华东', '42'], ['华南', '31']] },
  ];
  for (let s = 1; s <= 4; s++) {
    blocks.push({ kind: 'heading', level: 2, text: `第 ${s} 节 小标题` });
    for (let i = 0; i < 4; i++) blocks.push({ kind: 'para', text: `${s}.${i + 1} ${para}${para}` });
    if (s === 2) blocks.push({ kind: 'table', rows: [['项目', '数量', '备注'], ['苹果', '12', '红富士'], ['香蕉', '7', '进口'], ['合计', '19', '']] });
  }
  return { blocks };
}

/** 旧形态输入里的宽表：14 列与 20 列，默认页面。以前照样生成（越出页面），现在走降级排版，不能越界。 */
export function legacyWideInput(): DocxInput {
  const words = ['华东', '华南区', '西北大区', '东北', '中部地带', '海外市场部'];
  const mk = (cols: number, rows: number): string[][] => {
    const out: string[][] = [Array.from({ length: cols }, (_, c) => `第${c + 1}列`)];
    for (let r = 0; r < rows; r++) out.push(Array.from({ length: cols }, (_, c) => ((r + c) % 3 === 0 ? String((r + 1) * 100 + c) : words[(r * 7 + c) % words.length])));
    return out;
  };
  return {
    blocks: [
      { kind: 'heading', level: 1, text: '宽表（旧形态输入）' },
      { kind: 'para', text: '下面是一张十四列的表。' },
      { kind: 'table', rows: mk(14, 6) },
      { kind: 'para', text: '下面是一张二十列的表。' },
      { kind: 'table', rows: mk(20, 5) },
    ],
  };
}

export function emptyInput(): DocxInput {
  return { blocks: [] };
}

/** 特殊字符：五个要转义的符号、控制字符、落单代理项、表情符号、制表与换行、全角符号、表格里不断行的长串。 */
export function specialInput(): DocxInput {
  return {
    title: '特殊字符 & <样本>',
    blocks: [
      { kind: 'heading', level: 1, text: '特殊字符 & < > " \' 样本' },
      { kind: 'para', text: '五个符号：A & B < C > D "双引号" \'单引号\'，以及实体样子的文字 &amp; &#65; &lt;。' },
      { kind: 'para', text: '控制字符\u0001夹\u0008在\u000b中\u001f间，落单代理项\ud83d在这里，另一个\udc00在这里。' },
      { kind: 'para', text: '表情符号 😀 与 👍🏽，生僻字 𠮷，全角符号（）【】《》“”‘’——……￥％＆。' },
      { kind: 'para', text: '第一行\n第二行（段内换行）\n第三行\t制表之后\t再一个制表' },
      { kind: 'para', text: '  前后各有两个空格  ' },
      { kind: 'para', text: 'Windows 换行\r\n与旧式回车\r都归成换行。' },
      { kind: 'list', items: ['列表里的 & 与 <tag>', { text: '二级项 "引号"', level: 1 }] },
      { kind: 'table', rows: [['名称', '内容'], ['不断行的长串', 'x'.repeat(40) + 'Y'.repeat(40) + '0123456789'.repeat(4)], ['单元格内换行', '上一行\n下一行'], ['符号', '& < > " \'']] },
    ],
  };
}

/** 超长标题：六百字的一级标题、三百个字符不带空格的标题、三百字的文档标题。 */
export function longTitleInput(): DocxInput {
  return {
    title: '很长的文档标题'.repeat(43).slice(0, 300),
    blocks: [
      { kind: 'heading', level: 1, text: '这是一个特别长的一级标题，用来观察标题在多行、乃至超过半页时的排版。'.repeat(18).slice(0, 600) },
      { kind: 'para', text: '长标题之后的第一段正文：标题必须与它在同一页结束。' },
      { kind: 'heading', level: 2, text: 'NoSpaceHeading'.repeat(22).slice(0, 300) },
      { kind: 'para', text: '不带空格的长标题之后的正文。' },
    ],
  };
}

/** 单格三千字的行：前后各有普通行。这一行必须跨页断开，三千字一个不少地画在页面上。 */
export function hugeCellInput(): DocxInput {
  return {
    blocks: [
      { kind: 'heading', level: 1, text: '高行样本' },
      { kind: 'table', rows: [['编号', '内容'], ['前一', '普通行'], ['前二', '普通行'], ['高行', numberedProse(120)], ['后一', '普通行'], ['后二', '普通行']] },
      { kind: 'para', text: '表格之后的一段正文。' },
    ],
  };
}

/** 旧形态的表：首行单格三千字。首行不能再当表头（不许断开、比一页还高、还要每页重复）。 */
export function hugeHeaderInput(): DocxInput {
  const rows: string[][] = [['首行', numberedProse(120)]];
  for (let i = 1; i <= 5; i++) rows.push([`第${i}行`, '普通行']);
  return { blocks: [{ kind: 'heading', level: 1, text: '首行是长文的表' }, { kind: 'table', rows }] };
}

/** 横向 A4：20 列的表、1 列的表、行长短不一、数字单元格、两表相邻、表在文末。 */
export function wideTableInput(): DocxInput {
  const twenty: (string | number)[][] = [Array.from({ length: 20 }, (_, c) => `栏${c + 1}`)];
  for (let r = 1; r <= 6; r++) twenty.push(Array.from({ length: 20 }, (_, c) => (c % 2 === 0 ? r * 1000 + c : `值${r}-${c}`)));
  return {
    page: { orientation: 'landscape' },
    blocks: [
      { kind: 'heading', level: 1, text: '横向宽表' },
      { kind: 'table', rows: twenty },
      { kind: 'para', text: '下面是只有一列的表，随后两张表紧挨着。' },
      { kind: 'table', rows: [['只有一列'], ['第一行'], ['第二行']] },
      { kind: 'table', rows: [['长短不一', '甲', '乙', '丙'], ['只有两格', 1], ['三格', 2.5, -3], []] },
      { kind: 'table', rows: [['文末的表', '数值'], ['合计', 12345.67]] },
    ],
  };
}

/** 首轮真实 Word 取证（Word 16.0.15128）之后钉住的回归值，取证时附加到由模型推出的期望上：
 *  - pages：这一版 Word 排出来的页数（是回归值，不是从模型推出来的）；
 *  - tablesSpanPages：这些表（按出现序）必须跨至少两页（表头重复才有意义）；
 *  - splitRows：这些行（[表序号, 行序号]，从 0 起）必须跨页断开（高行不许被强行留在一页里）。 */
export const DOCX_FIXTURE_PINS: Readonly<Record<string, { pages?: number; tablesSpanPages?: number[]; splitRows?: [number, number][] }>> = {
  report: { pages: 14, tablesSpanPages: [0] },
  variants: { pages: 4 },
  legacy: { pages: 3 },
  'legacy-wide': { pages: 2 },
  empty: { pages: 1 },
  special: { pages: 1 },
  'long-title': { pages: 2 },
  'huge-cell': { pages: 2, splitRows: [[0, 3]] },
  'huge-header': { pages: 2, splitRows: [[0, 0]] },
  'wide-table': { pages: 2 },
};

/** 夹具名 → 输入。名字就是取证存档里的子目录名。 */
export const DOCX_FIXTURES: Readonly<Record<string, () => DocxInput>> = {
  report: () => reportInput(),
  variants: variantsInput,
  legacy: legacyInput,
  'legacy-wide': legacyWideInput,
  empty: emptyInput,
  special: specialInput,
  'long-title': longTitleInput,
  'huge-cell': hugeCellInput,
  'huge-header': hugeHeaderInput,
  'wide-table': wideTableInput,
};
