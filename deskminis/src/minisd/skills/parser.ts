/**
 * SKILL.md 元数据解析器：Claude/Codex 生态兼容（设计 §5.1）。
 * 只提取 name/description/version；未知 frontmatter 键静默忽略（生态技能常带
 * license / allowed-tools / metadata 等键）。全程容错：任何损坏都表现为「字段缺失」
 * 而不是抛异常 —— 中途保存写坏的文件不应炸掉导入与注入链路（保留旧元数据由 store 层做）。
 */

export interface SkillMeta { name?: string; description?: string; version?: string }

/** 稳定 id：NFKD 小写、去重音、非字母数字（CJK 保留）折叠成单个 '-'，首尾去 '-'。 */
export function slugify(input: string): string {
  const s = input.normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'unnamed-skill';
}

/** URL 兜底命名：取最后一个非空路径段（去 .git 后缀）；非法 URL 用斜杠切分兜底。
 *  注意：`new URL('C:\\x')` 不抛错（当 `c:` 协议解析），故只认 http/https，其余走斜杠兜底。 */
export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    const name = decodeURIComponent(last).replace(/\.git$/i, '').trim();
    return name || 'unnamed-skill';
  } catch {
    const segs = url.split(/[\\/]/).filter(Boolean);
    const name = (segs[segs.length - 1] ?? '').replace(/\.git$/i, '').trim();
    return name || 'unnamed-skill';
  }
}

interface RawEntry { key: string; value: string; isBlock?: boolean }

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * 块标量：从 lines[start] 开始收集缩进行与空行，直到下一个顶格非空行。
 * style '|' 保留换行；'>' 段内折叠成空格、空行分段保留单个换行。
 * chomp ''=clip（恰好一个尾部换行）、'-'=strip、'+'=keep。
 */
function parseBlockScalar(lines: string[], start: number, style: '|' | '>', chomp: '' | '+' | '-'): { value: string; next: number } {
  const block: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '') { block.push(''); i++; continue; }
    if (l.startsWith(' ') || l.startsWith('\t')) { block.push(l); i++; continue; }
    break;
  }
  // 末尾空行单独记数（chomping 用），中间空行保留
  let trailing = 0;
  while (block.length > 0 && block[block.length - 1].trim() === '') { block.pop(); trailing++; }
  const indents = block.filter(l => l.trim() !== '').map(l => /^[ \t]*/.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  const stripped = block.map(l => l.trim() === '' ? '' : l.slice(min));
  let text: string;
  if (style === '|') {
    text = stripped.join('\n');
  } else {
    const paras: string[] = [];
    let cur: string[] = [];
    for (const l of stripped) {
      if (l === '') { paras.push(cur.join(' ')); cur = []; } else cur.push(l);
    }
    paras.push(cur.join(' '));
    text = paras.filter((_, idx) => idx < paras.length).join('\n');
  }
  if (chomp === '+') text = text + (text ? '\n'.repeat(trailing + 1) : '');
  else if (chomp === '-') { /* strip：不补 */ }
  else text = text + (text ? '\n' : '');
  return { value: text, next: i };
}

/** 顶层键值扫描：键行 `key: value` 或 `key: |/>` 块标量；垃圾行跳过（容错）。 */
function parseFrontmatterBlock(lines: string[]): RawEntry[] {
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const bm = /^([>|])([+-])?$/.exec(m[2].trim());
    if (bm) {
      const { value, next } = parseBlockScalar(lines, i + 1, bm[1] as '|' | '>', (bm[2] ?? '') as '' | '+' | '-');
      entries.push({ key: m[1], value, isBlock: true });
      i = next;
    } else {
      entries.push({ key: m[1], value: m[2].trim() });
      i++;
    }
  }
  return entries;
}

/** headless 区域：开头连续的键值/缩进行；块标量内的空行不断区，其余空行即正文开始。 */
function headlessRegion(lines: string[]): string[] {
  const head: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (inBlock) { head.push(line); continue; }
      if (head.length === 0) continue;
      break;
    }
    if (/^[A-Za-z_][\w-]*\s*:/.test(line)) {
      head.push(line);
      inBlock = /:\s*[>|][+-]?\s*$/.test(line);
      continue;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && head.length > 0) { head.push(line); continue; }
    break;
  }
  return head;
}

export function parseSkillMd(content: string): SkillMeta {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let fm: RawEntry[] = [];
  if ((lines[0] ?? '').trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---' || lines[i].trim() === '...') { end = i; break; }
    }
    if (end > 0) fm = parseFrontmatterBlock(lines.slice(1, end));
    // 没有闭合 ---（中途保存损坏）：退化成 headless 尝试，能救回多少是多少
    else fm = parseFrontmatterBlock(headlessRegion(lines.slice(1)));
  } else {
    fm = parseFrontmatterBlock(headlessRegion(lines));
  }
  const out: SkillMeta = {};
  for (const e of fm) {
    // 块标量值的尾部换行是 chomping 语义的一部分（clip/keep），不能 trim；
    // 普通值 trim 掉前后空白与引号。两种都过 stripQuotes。
    const v = stripQuotes(e.isBlock ? e.value : e.value.trim());
    if (!v) continue;
    if (e.key === 'name' && out.name === undefined) out.name = v;
    else if (e.key === 'description' && out.description === undefined) out.description = v;
    else if (e.key === 'version' && out.version === undefined) out.version = v;
    // 其余键：静默忽略（Claude/Codex 兼容机制）
  }
  return out;
}
