/** U1：OOXML 解析——把 .docx/.xlsx/.pptx 解成结构化内容。
 *
 *  **定位是「内容预览」不是「版式还原」**：文字、表格、幻灯片大纲都拿得到，
 *  字体/精确排版/图片位置/动画不还原（那需要版式引擎，是另一个量级的东西）。
 *  这条边界要在 UI 上说清楚——照 OfficeCLI 的教训：把渲染不了的格式硬塞给渲染器，
 *  只会让用户对着"请安装 X"发呆。
 *
 *  为什么不引 XML 库：OOXML 的部件结构固定且我们只取文本层，
 *  用标签扫描足够且可控；引一个 XML 解析器要破零新依赖红线，不值。 */
import { readZip } from './zip';

export interface DocBlock {
  kind: 'heading' | 'para' | 'table';
  level?: number;
  text?: string;
  rows?: string[][];
}
export interface SheetData { name: string; rows: string[][] }
export interface SlideData { title: string; bullets: string[] }
export interface OfficeDoc {
  kind: 'docx' | 'xlsx' | 'pptx';
  blocks: DocBlock[];
  sheets?: SheetData[];
  slides?: SlideData[];
}

/** XML 实体反转义。OOXML 只会出现这五个预定义实体 + 数字实体。 */
function unesc(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');   // 必须最后：否则 &amp;lt; 会被二次解码
}

/** 取某标签（忽略命名空间前缀）的全部文本内容，按出现序返回。 */
function textsOf(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${local}>`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(unesc(m[1]));
  return out;
}
/** 按标签切块（返回每个块的完整内部 XML），用于逐段落 / 逐行 / 逐单元格遍历。 */
function chunksOf(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${local}>`, 'g');
  return [...xml.matchAll(re)].map(m => m[1]);
}
/** 自闭合标签的属性值，如 <w:pStyle w:val="Heading1"/>。 */
function attrOf(xml: string, local: string, attr: string): string | undefined {
  const re = new RegExp(`<(?:\\w+:)?${local}[^>]*\\b(?:\\w+:)?${attr}="([^"]*)"`);
  return re.exec(xml)?.[1];
}

function need(parts: Map<string, Buffer>, path: string, what: string): string {
  const b = parts.get(path);
  if (!b) throw new Error(`${what}：缺少部件 ${path}`);
  return b.toString('utf8');
}

/** Word：body 下按出现序取段落与表格；pStyle=HeadingN 视为标题。 */
function parseDocx(parts: Map<string, Buffer>): OfficeDoc {
  const xml = need(parts, 'word/document.xml', '这不像一个 Word 文档');
  const body = /<(?:\w+:)?body(?:\s[^>]*)?>([\s\S]*)<\/(?:\w+:)?body>/.exec(xml)?.[1] ?? xml;
  const blocks: DocBlock[] = [];

  // 段落与表格在 body 里交替出现，按位置扫描保持原序
  const re = /<(?:\w+:)?(p|tbl)(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?\1>/g;
  for (const m of body.matchAll(re)) {
    const [, tag, inner] = m;
    if (tag === 'p') {
      const text = textsOf(inner, 't').join('');
      if (!text.trim()) continue;
      const style = attrOf(inner, 'pStyle', 'val') ?? '';
      const lv = /^Heading(\d)/i.exec(style)?.[1];
      blocks.push(lv ? { kind: 'heading', level: Number(lv), text } : { kind: 'para', text });
    } else {
      const rows = chunksOf(inner, 'tr').map(tr => chunksOf(tr, 'tc').map(tc => textsOf(tc, 't').join('')));
      if (rows.length) blocks.push({ kind: 'table', rows });
    }
  }
  return { kind: 'docx', blocks };
}

/** 列名 → 0 基列号（A→0, Z→25, AA→26）。单元格可能跳列，得靠它对齐。 */
function colOf(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel：sharedStrings + 每张 sheet 的行列。数值原样转字符串（预览不做格式化）。 */
function parseXlsx(parts: Map<string, Buffer>): OfficeDoc {
  const wb = need(parts, 'xl/workbook.xml', '这不像一个 Excel 工作簿');
  const shared = parts.has('xl/sharedStrings.xml')
    ? chunksOf(parts.get('xl/sharedStrings.xml')!.toString('utf8'), 'si').map(si => textsOf(si, 't').join(''))
    : [];

  const names = [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]*)"/g)].map(m => unesc(m[1]));
  const sheets: SheetData[] = [];
  names.forEach((name, i) => {
    const xml = parts.get(`xl/worksheets/sheet${i + 1}.xml`)?.toString('utf8');
    if (!xml) return;
    const rows: string[][] = [];
    for (const rowXml of chunksOf(xml, 'row')) {
      const cells: string[] = [];
      const cre = /<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
      for (const cm of rowXml.matchAll(cre)) {
        const attrs = cm[1] ?? '';
        const inner = cm[2] ?? '';
        const at = colOf(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? 'A');
        while (cells.length < at) cells.push('');           // 跳过的列补空，保持列对齐
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
        const raw = textsOf(inner, 'v')[0] ?? '';
        const inline = textsOf(inner, 't')[0] ?? '';
        cells.push(type === 's' ? (shared[Number(raw)] ?? '') : (type === 'inlineStr' ? inline : raw));
      }
      rows.push(cells);
    }
    sheets.push({ name, rows });
  });
  return { kind: 'xlsx', blocks: [], sheets };
}

/** PowerPoint：逐页取所有文本；第一段当标题，其余为要点。 */
function parsePptx(parts: Map<string, Buffer>): OfficeDoc {
  const nums = [...parts.keys()]
    .map(k => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k)?.[1])
    .filter((v): v is string => !!v)
    .map(Number)
    .sort((a, b) => a - b);
  if (!nums.length) throw new Error('这不像一个 PowerPoint 演示文稿：找不到任何幻灯片');

  const slides: SlideData[] = nums.map(n => {
    const xml = parts.get(`ppt/slides/slide${n}.xml`)!.toString('utf8');
    // 每个 <a:p> 是一段；段内可能被拆成多个 <a:t> run，需拼接
    const paras = chunksOf(xml, 'p').map(p => textsOf(p, 't').join('').trim()).filter(Boolean);
    return { title: paras[0] ?? '', bullets: paras.slice(1) };
  });
  return { kind: 'pptx', blocks: [], slides };
}

/** 入口：按扩展名分派。不认识的格式**明说不支持**——照 OfficeCLI 的教训，
 *  legacy .doc/.xls/.ppt 与 ODF 跟 OOXML 无关，硬塞给解析器只会给用户假希望。 */
export async function parseOffice(fileName: string, buf: Buffer): Promise<OfficeDoc> {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (!['docx', 'xlsx', 'xlsm', 'pptx'].includes(ext)) {
    throw new Error(`不支持的格式 .${ext}——只能读 OOXML（.docx/.xlsx/.pptx）；` +
      `旧版 .doc/.xls/.ppt 与 ODF 是另一套二进制格式，请用 Office 应用打开`);
  }
  const parts = await readZip(buf);
  if (ext === 'docx') return parseDocx(parts);
  if (ext === 'pptx') return parsePptx(parts);
  return parseXlsx(parts);
}
