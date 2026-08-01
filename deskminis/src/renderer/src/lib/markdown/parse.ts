/** MU2a Task 1：Markdown 解析引擎（自研白名单 AST，零依赖零 DOM）。
 *  契约：docs/plans/2026-07-31-mu2-ui-implementation.md 决策 2。
 *  XSS 红线（决策 2c）：本解析器根本不产生 HTML 节点——输入中一切 HTML 按纯文本处理；
 *  链接 href 协议白名单 http:/https:/mailto:，其余一律降级为纯文本。
 *  渲染范围：GFM 小子集（设计 v2 §5.1 十一项）——h2/h3、粗/斜/删、行内码、围栏、
 *  ul/ol、引用、链接、简单表格、分隔线；无 HTML、无任务列表、无脚注。 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: MdInline[] }
  | { type: 'italic'; children: MdInline[] }
  | { type: 'strikethrough'; children: MdInline[] }
  | { type: 'inlineCode'; text: string }
  | { type: 'link'; href: string; children: MdInline[] };

export type MdNode =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'heading'; level: 2 | 3; children: MdInline[] }
  | { type: 'codeBlock'; lang: string; code: string }
  | { type: 'ul'; items: MdNode[] }
  | { type: 'ol'; items: MdNode[]; start: number }
  | { type: 'li'; children: MdNode[] }
  | { type: 'blockquote'; children: MdNode[] }
  | { type: 'table'; header: MdInline[][]; rows: MdInline[][][] }
  | { type: 'hr' };

// ---------- XSS：href 协议白名单（决策 2c-②） ----------

/** HTML 实体解码两轮（防 `&amp;#106;` 双重编码绕过）。 */
function decodeEntities(s: string): string {
  let out = s;
  for (let round = 0; round < 2; round++) {
    out = out
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, n: string) => (
        { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>
      )[n]);
  }
  return out;
}

/** href 是否安全：实体解码 + 剥控制符/空白 + 小写后，协议必须在白名单 http/https/mailto。
 *  相对链接与无协议 href 一律不放行（白名单闭集，LLM 产出场景绝对 URL 为常态）。 */
export function isSafeHref(href: string): boolean {
  const decoded = decodeEntities(href).replace(/[\x00-\x20\x7f]+/g, '').toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):/.exec(decoded);
  if (!m) return false;
  return m[1] === 'http' || m[1] === 'https' || m[1] === 'mailto';
}

// ---------- 行内解析（递归；行内码内容不二次解析） ----------

export function parseInlines(text: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => { if (buf !== '') { out.push({ type: 'text', text: buf }); buf = ''; } };

  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'inlineCode', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      buf += text[i]; i++; continue;
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'bold', children: parseInlines(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
      buf += text[i]; i++; continue;
    }
    if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'strikethrough', children: parseInlines(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
      buf += text[i]; i++; continue;
    }
    if (text[i] === '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'italic', children: parseInlines(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
      buf += text[i]; i++; continue;
    }
    if (text[i] === '[') {
      const close = text.indexOf('](', i + 1);
      if (close > i + 1) {
        const endParen = text.indexOf(')', close + 2);
        if (endParen > close + 2) {
          const href = text.slice(close + 2, endParen).trim();
          if (isSafeHref(href)) {
            flush();
            out.push({ type: 'link', href, children: parseInlines(text.slice(i + 1, close)) });
            i = endParen + 1;
            continue;
          }
        }
      }
      buf += text[i]; i++; continue;
    }
    buf += text[i]; i++;
  }
  flush();
  return out;
}

// ---------- 块级解析（按行扫描） ----------

const FENCE_RE = /^```([A-Za-z0-9_+-]*)\s*$/;
const FENCE_END_RE = /^```\s*$/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const UL_RE = /^(\s*)[-*]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const HR_RE = /^\s*((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/;

export function parseMarkdown(src: string): MdNode[] {
  if (src.trim() === '') return [];
  return parseBlocks(src.replace(/\r\n/g, '\n').split('\n'));
}

function isTableDivider(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-') || !t.includes('|')) return false;
  return /^\|?[\s:|-]+\|?$/.test(t);
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => c.trim());
}

/** 该行是否开启一个新块（段落收集的截断条件；围栏行可截断段落——CommonMark 语义）。 */
function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line)
    || QUOTE_RE.test(line) || UL_RE.test(line) || OL_RE.test(line)
    || (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]));
}

function parseBlocks(lines: string[]): MdNode[] {
  const out: MdNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // 围栏代码块（未闭合 → 围栏开始行回落为普通文本行，决策 3 兜底语义）
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (FENCE_END_RE.test(lines[j])) { closed = true; break; }
        body.push(lines[j]); j++;
      }
      if (closed) {
        out.push({ type: 'codeBlock', lang: fence[1] ?? '', code: body.join('\n') });
        i = j + 1;
        continue;
      }
      // 未闭合：不 continue，``` 行落入下方段落分支
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      out.push({ type: 'heading', level: h[1].length === 3 ? 3 : 2, children: parseInlines(h[2].trim()) });
      i++; continue;
    }

    if (HR_RE.test(line)) { out.push({ type: 'hr' }); i++; continue; }

    // 简单表格：当前行 + 下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const header = splitTableRow(line).map(c => parseInlines(c));
      const rows: MdInline[][][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]).map(c => parseInlines(c)));
        j++;
      }
      out.push({ type: 'table', header, rows });
      i = j; continue;
    }

    // 引用块（去掉 > 前缀递归；可含列表）
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(QUOTE_RE.exec(lines[i])![1]); i++;
      }
      out.push({ type: 'blockquote', children: parseBlocks(inner) });
      continue;
    }

    // 列表（含 2 空格缩进嵌套）
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const { node, next } = parseList(lines, i);
      out.push(node); i = next; continue;
    }

    // 段落：首行必吃，后续行遇块起始截断
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      if (para.length > 0 && isBlockStart(lines, i)) break;
      para.push(lines[i]); i++;
    }
    out.push({ type: 'paragraph', children: parseInlines(para.join('\n')) });
  }
  return out;
}

function parseList(lines: string[], start: number): { node: MdNode; next: number } {
  const ordered = OL_RE.test(lines[start]);
  const first = (ordered ? OL_RE.exec(lines[start]) : UL_RE.exec(lines[start]))!;
  const baseIndent = first[1].length;
  const startNum = ordered ? parseInt((first as RegExpExecArray)[2], 10) : 1;
  const items: MdNode[] = [];
  let i = start;

  while (i < lines.length) {
    const m = ordered ? OL_RE.exec(lines[i]) : UL_RE.exec(lines[i]);
    if (!m || m[1].length !== baseIndent) break;
    const itemLines: string[] = [ordered ? m[3] : m[2]];
    i++;
    // 项的延续行（更深缩进：嵌套列表或多行内容）
    while (i < lines.length && lines[i].trim() !== '') {
      const ind = /^(\s*)/.exec(lines[i])![1].length;
      if (ind <= baseIndent) break;
      itemLines.push(lines[i].slice(Math.min(baseIndent + 2, ind)));
      i++;
    }
    items.push({ type: 'li', children: parseBlocks(itemLines) });
  }
  return {
    node: ordered ? { type: 'ol', items, start: startNum } : { type: 'ul', items },
    next: i,
  };
}
