/** Word 解析：body 下按出现序取段落与表格（内容预览，不还原版式）。
 *
 *  F10A 补认三样——不认的话，自己生成的文档读回会丢结构，内容核验也比不了：
 *  - 列表：带 w:numPr 的段落查 numbering.xml，认出有序 / 无序、级别与序号；
 *  - 段内换行（w:br，分页符除外）→ \n；制表符（不带属性的 w:tab）→ \t；
 *  - 单元格里多个段落用 \n 连接（原先直接连在一起）。 */
import type { OfficeDoc } from '../parse';
import { unesc, need } from '../xml';
import { classifyDocx, docxLostParts } from './inspect';

export interface DocBlock {
  kind: 'heading' | 'para' | 'table';
  level?: number;
  text?: string;
  rows?: string[][];
  /** 列表项仍是 kind:'para'；index 是它在同一列表、同一级别里的序号（从 1 起） */
  list?: { ordered: boolean; level: number; index: number };
}

/** 成对的块标签（段落、表格、行、单元格）。`(?<!\/)>`：Word 会把空段落写成自闭合的 <w:p …/>，
 *  不排除的话它会被当成开标签，一路吞到下一个段落的结束标签，把两段的字并在一起。 */
const blockRe = (names: string): RegExp =>
  new RegExp(`<(?:\\w+:)?(${names})(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</(?:\\w+:)?\\1>`, 'g');

/** 一个段落（或任意一段 run）里的文字：w:t 的内容、换行、制表符，按出现序拼起来。 */
const TEXT_TOKEN = /<(?:\w+:)?t(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?br(\s[^>]*)?\/>|<(?:\w+:)?tab\s*\/>/g;
function runText(inner: string): string {
  let out = '';
  for (const m of inner.matchAll(TEXT_TOKEN)) {
    if (m[1] !== undefined) out += unesc(m[1]);
    else if (m[0].includes('br')) {
      // 分页符、分栏符不是文字里的换行
      if (!/\btype="(?:page|column)"/.test(m[2] ?? '')) out += '\n';
    } else out += '\t';                           // 带属性的 w:tab 是制表位定义（在 w:tabs 里），不会匹配到这里
  }
  return out;
}

/** numbering.xml → numId → 各级是不是有序。查不到的一律当普通段落。 */
function readNumbering(xml: string | undefined): Map<string, boolean[]> {
  const out = new Map<string, boolean[]>();
  if (!xml) return out;
  const abstracts = new Map<string, boolean[]>();
  for (const m of xml.matchAll(/<(?:\w+:)?abstractNum\s[^>]*?\babstractNumId="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?abstractNum>/g)) {
    const levels: boolean[] = [];
    for (const l of m[2].matchAll(/<(?:\w+:)?lvl\s[^>]*?\bilvl="(\d+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?lvl>/g)) {
      const fmt = /<(?:\w+:)?numFmt\s[^>]*?\bval="([^"]*)"/.exec(l[2])?.[1];
      levels[Number(l[1])] = fmt !== undefined && fmt !== 'bullet' && fmt !== 'none';
    }
    abstracts.set(m[1], levels);
  }
  for (const m of xml.matchAll(/<(?:\w+:)?num\s[^>]*?\bnumId="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?num>/g)) {
    const a = /<(?:\w+:)?abstractNumId\s[^>]*?\bval="([^"]*)"/.exec(m[2])?.[1];
    const levels = a === undefined ? undefined : abstracts.get(a);
    if (levels) out.set(m[1], levels);
  }
  return out;
}

/** Word：body 下按出现序取段落与表格；pStyle=HeadingN 视为标题。 */
export function parseDocx(parts: Map<string, Buffer>): OfficeDoc {
  const xml = need(parts, 'word/document.xml', '这不像一个 Word 文档');
  const body = /<(?:\w+:)?body(?:\s[^>]*)?>([\s\S]*)<\/(?:\w+:)?body>/.exec(xml)?.[1] ?? xml;
  const numbering = readNumbering(parts.get('word/numbering.xml')?.toString('utf8'));
  /** 列表序号：同一 numId、同一级别递增；出现更浅的级别时更深的归零 */
  const counters = new Map<string, number[]>();
  const blocks: DocBlock[] = [];

  // 段落与表格在 body 里交替出现，按位置扫描保持原序
  for (const m of body.matchAll(blockRe('p|tbl'))) {
    const [, tag, inner] = m;
    if (tag === 'p') {
      const text = runText(inner);
      if (!text.trim()) continue;
      const style = /<(?:\w+:)?pStyle\s[^>]*?\bval="([^"]*)"/.exec(inner)?.[1] ?? '';
      const lv = /^Heading(\d)/i.exec(style)?.[1];
      if (lv) { blocks.push({ kind: 'heading', level: Number(lv), text }); continue; }
      const numPr = /<(?:\w+:)?numPr>([\s\S]*?)<\/(?:\w+:)?numPr>/.exec(inner)?.[1];
      const numId = numPr === undefined ? undefined : /<(?:\w+:)?numId\s[^>]*?\bval="([^"]*)"/.exec(numPr)?.[1];
      const levels = numId === undefined ? undefined : numbering.get(numId);
      if (numId !== undefined && levels) {
        const level = Number(/<(?:\w+:)?ilvl\s[^>]*?\bval="(\d+)"/.exec(numPr as string)?.[1] ?? 0);
        const c = counters.get(numId) ?? [];
        c[level] = (c[level] ?? 0) + 1;
        c.length = level + 1;                      // 更深的级别归零
        counters.set(numId, c);
        blocks.push({ kind: 'para', text, list: { ordered: levels[level] === true, level, index: c[level] } });
      } else blocks.push({ kind: 'para', text });
    } else {
      const rows = [...inner.matchAll(blockRe('tr'))].map(tr =>
        [...tr[2].matchAll(blockRe('tc'))].map(tc =>
          [...tc[2].matchAll(blockRe('p'))].map(p => runText(p[2])).join('\n')));
      if (rows.length) blocks.push({ kind: 'table', rows });
    }
  }
  const origin = classifyDocx(parts.keys(), parts.get('docProps/app.xml')?.toString('utf8'), xml, parts);
  const omitted = origin === 'other' ? docxLostParts(parts.keys(), xml, parts.get('word/comments.xml')?.toString('utf8')).map(p => `${p.label} ${p.count} ${p.label === '批注' ? '条' : '个'}`) : [];
  return { kind: 'docx', blocks, ...(omitted.length ? {omitted} : {}) };
}
