/** OOXML 生成与解析共用的 XML 小件（F10A 拆分时从 build.ts / parse.ts 原样搬来）。
 *
 *  为什么不引 XML 库：OOXML 的部件结构固定，生成侧是字符串拼接、解析侧只取文本层，
 *  用标签扫描足够且可控；引一个 XML 解析器要破零新依赖红线，不值。
 *
 *  三种格式（docx / xlsx / pptx）都从这里取，各自的目录之间互不引用。 */

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** XML 文本转义。顺序要紧：& 必须先转，否则会把后面转出来的实体再转一遍。 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
export const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

/** XML 实体反转义。OOXML 只会出现这五个预定义实体 + 数字实体。 */
export function unesc(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');   // 必须最后：否则 &amp;lt; 会被二次解码
}

/** 取某标签（忽略命名空间前缀）的全部文本内容，按出现序返回。 */
export function textsOf(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${local}>`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(unesc(m[1]));
  return out;
}
/** 按标签切块（返回每个块的完整内部 XML），用于逐段落 / 逐行 / 逐单元格遍历。 */
export function chunksOf(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${local}>`, 'g');
  return [...xml.matchAll(re)].map(m => m[1]);
}
/** 自闭合标签的属性值，如 <w:pStyle w:val="Heading1"/>。 */
export function attrOf(xml: string, local: string, attr: string): string | undefined {
  const re = new RegExp(`<(?:\\w+:)?${local}[^>]*\\b(?:\\w+:)?${attr}="([^"]*)"`);
  return re.exec(xml)?.[1];
}

export function need(parts: Map<string, Buffer>, path: string, what: string): string {
  const b = parts.get(path);
  if (!b) throw new Error(`${what}：缺少部件 ${path}`);
  return b.toString('utf8');
}

/** 需要清洗的字符：C0 控制字符（制表、换行除外；回车在这里是为了归一化）、U+FFFE / U+FFFF、任何代理项。
 *  先用它探一下，绝大多数文本一个都没有，直接原样返回。 */
const NEEDS_CLEANING = /[\u0000-\u0008\u000b-\u001f￾￿\ud800-\udfff]/;

/** 让一段文本可以放进 XML 1.0：
 *  - 删掉不允许出现的字符（U+0000–0008、000B、000C、000E–001F、FFFE、FFFF）——带着它们的部件 Word 直接打不开
 *    （实测 `Documents.Open` 报 0x800A1401）；
 *  - 落单的代理项换成 U+FFFD（`Buffer.from(s, 'utf8')` 本来也会这么编码，显式换掉是为了回读比对时期望与实际一致）；
 *  - `\r\n` 与 `\r` 归成 `\n`。
 *
 *  不做实体转义（那是 esc 的事）。removed = 被删掉与被换掉的字符数，不含换行归一化。 */
export function cleanXmlText(s: string): { text: string; removed: number } {
  if (!NEEDS_CLEANING.test(s)) return { text: s, removed: 0 };
  const out: string[] = [];
  let removed = 0;
  let from = 0;                                   // 还没写出去的那一段的起点
  const flush = (to: number): void => { if (to > from) out.push(s.slice(from, to)); };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0d) {
      flush(i); out.push('\n');
      if (s.charCodeAt(i + 1) === 0x0a) i++;
      from = i + 1;
    } else if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0xfffe || c === 0xffff) {
      flush(i); removed++; from = i + 1;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;         // 成对的代理项：原样留下
      else { flush(i); out.push('�'); removed++; from = i + 1; }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      flush(i); out.push('�'); removed++; from = i + 1;
    }
  }
  flush(s.length);
  return { text: out.join(''), removed };
}

const XML_NAME = /[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/y;
const XML_ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/y;

/** 一段文字或属性值里有没有裸的 &（不是五个预定义实体，也不是数字实体）。返回位置或 -1。 */
function bareAmpersand(xml: string, from: number, to: number): number {
  for (let i = xml.indexOf('&', from); i >= 0 && i < to; i = xml.indexOf('&', i + 1)) {
    XML_ENTITY.lastIndex = i;
    if (!XML_ENTITY.test(xml)) return i;
  }
  return -1;
}

/** 栈式检查一个部件是不是良构的 XML：标签配平、属性值带引号、没有裸的 & 与 <、没有不允许的字符。
 *  只覆盖本项目生成器会写的子集（XML 声明、元素、属性、文字）；注释、CDATA、处理指令、DOCTYPE 生成器不写，
 *  出现即报。返回第一处问题（一句中文），良构则返回 null。 */
export function checkWellFormed(xml: string): string | null {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(xml)) return '含有 XML 不允许的字符';
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(xml)) return '含有落单的代理项';
  const n = xml.length;
  let i = 0;
  if (xml.startsWith('<?xml')) {
    const e = xml.indexOf('?>');
    if (e < 0) return 'XML 声明没有结束';
    i = e + 2;
  }
  const stack: string[] = [];
  let sawRoot = false;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      if (stack.length === 0) { if (xml.slice(i, textEnd).trim() !== '') return '根元素之外有文字'; }
      else {
        const amp = bareAmpersand(xml, i, textEnd);
        if (amp >= 0) return `文字里有没转义的 &（位置 ${amp}）`;
      }
    }
    if (lt < 0) break;
    i = lt + 1;
    const ch = xml[i];
    if (ch === '!' || ch === '?') return `出现了生成器不会写的结构（位置 ${lt}）`;
    if (ch === '/') {
      XML_NAME.lastIndex = i + 1;
      const m = XML_NAME.exec(xml);
      if (!m) return `结束标签没有名字（位置 ${lt}）`;
      let j = XML_NAME.lastIndex;
      while (j < n && /\s/.test(xml[j])) j++;
      if (xml[j] !== '>') return `结束标签 </${m[0]} 没有以 > 收尾`;
      const open = stack.pop();
      if (open !== m[0]) return open === undefined ? `多出来的结束标签 </${m[0]}>` : `标签不配平：<${open}> 遇到 </${m[0]}>`;
      i = j + 1;
      continue;
    }
    XML_NAME.lastIndex = i;
    const m = XML_NAME.exec(xml);
    if (!m) return `< 之后不是标签名（位置 ${lt}）——文字里有没转义的 <`;
    if (stack.length === 0) {
      if (sawRoot) return '有不止一个根元素';
      sawRoot = true;
    }
    const name = m[0];
    let j = XML_NAME.lastIndex;
    const seen = new Set<string>();
    for (;;) {
      const wsFrom = j;
      while (j < n && /\s/.test(xml[j])) j++;
      if (j >= n) return `标签 <${name} 没有结束`;
      if (xml[j] === '>') { stack.push(name); j++; break; }
      if (xml[j] === '/') {
        if (xml[j + 1] !== '>') return `标签 <${name} 里的 / 后面不是 >`;
        j += 2; break;
      }
      if (j === wsFrom) return `标签 <${name} 的属性之间缺空白`;
      XML_NAME.lastIndex = j;
      const a = XML_NAME.exec(xml);
      if (!a) return `标签 <${name} 里有不合法的属性名（位置 ${j}）`;
      if (seen.has(a[0])) return `标签 <${name} 的属性 ${a[0]} 重复`;
      seen.add(a[0]);
      j = XML_NAME.lastIndex;
      if (xml[j] !== '=') return `属性 ${a[0]} 后面没有 =`;
      const q = xml[j + 1];
      if (q !== '"' && q !== "'") return `属性 ${a[0]} 的值没有引号`;
      const end = xml.indexOf(q, j + 2);
      if (end < 0) return `属性 ${a[0]} 的引号没有闭合`;
      const ltIn = xml.indexOf('<', j + 2);
      if (ltIn >= 0 && ltIn < end) return `属性 ${a[0]} 的值里有没转义的 <`;
      if (bareAmpersand(xml, j + 2, end) >= 0) return `属性 ${a[0]} 的值里有没转义的 &`;
      j = end + 1;
    }
    i = j;
  }
  if (stack.length > 0) return `标签没有闭合：<${stack[stack.length - 1]}>`;
  if (!sawRoot) return '没有根元素';
  return null;
}
