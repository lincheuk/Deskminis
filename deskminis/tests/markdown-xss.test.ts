/** MU2a Task 1：XSS 消毒红线（决策 2c，12 例）。
 *  核心不变量：解析器根本不产生 HTML 节点——输入中一切 HTML 按纯文本转义输出；
 *  链接 href 协议白名单 http:/https:/mailto:，其余一律降级为纯文本。 */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, isSafeHref, type MdNode, type MdInline } from '../src/renderer/src/lib/markdown/parse';

const WHITELIST = new Set([
  'paragraph', 'heading', 'bold', 'italic', 'strikethrough', 'inlineCode',
  'codeBlock', 'ul', 'ol', 'li', 'blockquote', 'link', 'table', 'hr', 'text',
]);

/** 递归收集 AST 全部节点 type。 */
function collectTypes(nodes: (MdNode | MdInline)[], out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(n.type);
    if ('children' in n) collectTypes(n.children as MdInline[], out);
    if (n.type === 'ul' || n.type === 'ol') collectTypes(n.items, out);
    if (n.type === 'table') { n.header.forEach(r => collectTypes(r, out)); n.rows.forEach(r => r.forEach(c => collectTypes(c, out))); }
  }
  return out;
}

/** 递归找 link 节点。 */
function findLinks(nodes: (MdNode | MdInline)[]): Extract<MdInline, { type: 'link' }>[] {
  const out: Extract<MdInline, { type: 'link' }>[] = [];
  const walk = (ns: (MdNode | MdInline)[]): void => {
    for (const n of ns) {
      if (n.type === 'link') out.push(n);
      if ('children' in n) walk(n.children as MdInline[]);
      if (n.type === 'ul' || n.type === 'ol') walk(n.items);
    }
  };
  walk(nodes);
  return out;
}

describe('MU2a Task 1 XSS 消毒（红线）', () => {
  it('<script>alert(1)</script> → 无 html 节点，按纯文本', () => {
    const nodes = parseMarkdown('<script>alert(1)</script>');
    expect(collectTypes(nodes)).not.toContain('html');
    expect(JSON.stringify(nodes)).toContain('<script>alert(1)</script>');
    expect(nodes[0].type).toBe('paragraph');
  });

  it('<img src=x onerror=alert(1)> → 纯文本', () => {
    const nodes = parseMarkdown('<img src=x onerror=alert(1)>');
    expect(collectTypes(nodes)).not.toContain('html');
    expect(JSON.stringify(nodes)).toContain('onerror=alert(1)');
  });

  it('<a href="https://x">t</a> → 纯文本（不生成 link 节点）', () => {
    const nodes = parseMarkdown('<a href="https://x">t</a>');
    expect(findLinks(nodes)).toHaveLength(0);
    expect(JSON.stringify(nodes)).toContain('<a href=');
  });

  it('<!-- 注释 --> → 纯文本', () => {
    const nodes = parseMarkdown('前文\n\n<!-- 注释 -->\n\n后文');
    expect(collectTypes(nodes)).not.toContain('html');
    expect(JSON.stringify(nodes)).toContain('<!-- 注释 -->');
  });

  it('[x](javascript:alert(1)) → link 不生成，按纯文本', () => {
    const nodes = parseMarkdown('[x](javascript:alert(1))');
    expect(findLinks(nodes)).toHaveLength(0);
    expect(JSON.stringify(nodes)).toContain('javascript:alert(1)');
  });

  it('[x](JaVaScRiPt:alert(1)) 大小写混淆 → 纯文本', () => {
    expect(findLinks(parseMarkdown('[x](JaVaScRiPt:alert(1))'))).toHaveLength(0);
  });

  it('[x]( javascript:alert(1)) 前导空白 → 纯文本', () => {
    expect(findLinks(parseMarkdown('[x]( javascript:alert(1))'))).toHaveLength(0);
  });

  it('[x](&#106;avascript:alert(1)) 实体编码绕过 → 纯文本', () => {
    expect(findLinks(parseMarkdown('[x](&#106;avascript:alert(1))'))).toHaveLength(0);
  });

  it('[x](data:text/html,<script>alert(1)</script>) → 纯文本', () => {
    expect(findLinks(parseMarkdown('[x](data:text/html,<script>alert(1)</script>)'))).toHaveLength(0);
  });

  it('[x](vbscript:msgbox(1)) → 纯文本', () => {
    expect(findLinks(parseMarkdown('[x](vbscript:msgbox(1))'))).toHaveLength(0);
  });

  it('白名单放行：[ok](https://a.b/c?d=e) 与 [ok](mailto:a@b.c) 保留 href', () => {
    const a = findLinks(parseMarkdown('[ok](https://a.b/c?d=e)'));
    expect(a).toHaveLength(1);
    expect(a[0].href).toBe('https://a.b/c?d=e');
    const m = findLinks(parseMarkdown('[ok](mailto:a@b.c)'));
    expect(m).toHaveLength(1);
    expect(m[0].href).toBe('mailto:a@b.c');
    expect(isSafeHref('https://a.b')).toBe(true);
    expect(isSafeHref('mailto:a@b.c')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
  });

  it('AST 序列化不含 html/rawHtml 类型字段（复杂文档闭集断言）', () => {
    const doc = '# t\n\n**b** *i* ~~s~~ `c` [l](https://a.b)\n\n```js\nx();\n```\n\n- a\n  - b\n\n> q\n\n| h |\n| --- |\n| d |\n\n---\n\n<script>x</script>';
    const nodes = parseMarkdown(doc);
    const types = collectTypes(nodes);
    for (const t of types) expect(WHITELIST.has(t), `节点类型 ${t} 不在白名单`).toBe(true);
    expect(types).not.toContain('html');
    expect(types).not.toContain('rawHtml');
  });
});
