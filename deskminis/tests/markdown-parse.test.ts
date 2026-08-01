/** MU2a Task 1：Markdown 解析引擎（块级 + 行内 AST，纯模块）。
 *  契约：docs/plans/2026-07-31-mu2-ui-implementation.md Task 1 Step 1（18 例）。 */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, type MdNode, type MdInline } from '../src/renderer/src/lib/markdown/parse';

/** 便捷取第一个节点（断言单节点文档）。 */
function one(src: string): MdNode {
  const nodes = parseMarkdown(src);
  expect(nodes).toHaveLength(1);
  return nodes[0];
}

describe('MU2a Task 1 块级解析', () => {
  it('h2/h3 标题；h1 降级 h2（§2.3 标题层级 ≤3）', () => {
    expect(one('## 标题')).toEqual({ type: 'heading', level: 2, children: [{ type: 'text', text: '标题' }] });
    expect(one('### 小节')).toEqual({ type: 'heading', level: 3, children: [{ type: 'text', text: '小节' }] });
    expect(one('# 大标题')).toEqual({ type: 'heading', level: 2, children: [{ type: 'text', text: '大标题' }] });
  });

  it('#### 四级标题不解析，按段落文本', () => {
    expect(one('#### 太深')).toEqual({ type: 'paragraph', children: [{ type: 'text', text: '#### 太深' }] });
  });

  it('段落多行保留换行；行内混排', () => {
    const n = one('第一行\n第二行 **粗** 尾');
    expect(n.type).toBe('paragraph');
    if (n.type !== 'paragraph') return;
    expect(n.children[0]).toEqual({ type: 'text', text: '第一行\n第二行 ' });
    expect(n.children[1]).toEqual({ type: 'bold', children: [{ type: 'text', text: '粗' }] });
  });

  it('围栏带语言名', () => {
    expect(one('```ts\nconst a = 1;\n```')).toEqual({ type: 'codeBlock', lang: 'ts', code: 'const a = 1;' });
  });

  it('围栏无语言名 lang 为空串', () => {
    expect(one('```\nplain\n```')).toEqual({ type: 'codeBlock', lang: '', code: 'plain' });
  });

  it('未闭合围栏 → 纯文本兜底（围栏开始行也按文本显示）', () => {
    const nodes = parseMarkdown('前文\n\n```ts\nconst a = 1;');
    // 围栏未闭合：``` 行不当 codeBlock，整体回落为普通文本行（段落）
    expect(nodes.every(n => n.type !== 'codeBlock')).toBe(true);
    const text = JSON.stringify(nodes);
    expect(text).toContain('```ts');
    expect(text).toContain('const a = 1;');
  });

  it('ul 简单列表', () => {
    const n = one('- 甲\n- 乙');
    expect(n.type).toBe('ul');
    if (n.type !== 'ul') return;
    expect(n.items).toHaveLength(2);
    expect(n.items[0]).toEqual({ type: 'li', children: [{ type: 'paragraph', children: [{ type: 'text', text: '甲' }] }] });
  });

  it('ul 两级嵌套（2 空格缩进）', () => {
    const n = one('- 甲\n  - 甲一\n  - 甲二\n- 乙');
    expect(n.type).toBe('ul');
    if (n.type !== 'ul') return;
    expect(n.items).toHaveLength(2);
    const first = n.items[0];
    expect(first.type).toBe('li');
    if (first.type !== 'li') return;
    const nested = first.children.find(c => c.type === 'ul');
    expect(nested).toBeDefined();
    if (nested?.type === 'ul') expect(nested.items).toHaveLength(2);
  });

  it('ol 有序列表（start 保留）', () => {
    const n = one('3. 第三\n4. 第四');
    expect(n).toMatchObject({ type: 'ol', start: 3 });
    if (n.type === 'ol') expect(n.items).toHaveLength(2);
  });

  it('引用块可含列表', () => {
    const n = one('> 引文\n> - 项一\n> - 项二');
    expect(n.type).toBe('blockquote');
    if (n.type !== 'blockquote') return;
    expect(n.children.some(c => c.type === 'ul')).toBe(true);
  });

  it('hr：--- 与 *** 都是分隔线', () => {
    const nodes = parseMarkdown('上\n\n---\n\n下');
    expect(nodes.map(n => n.type)).toEqual(['paragraph', 'hr', 'paragraph']);
    expect(one('***')).toEqual({ type: 'hr' });
  });

  it('简单表格：表头 + 分隔行 + 数据行', () => {
    const n = one('| 名 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |');
    expect(n.type).toBe('table');
    if (n.type !== 'table') return;
    expect(n.header).toHaveLength(2);
    expect(n.rows).toHaveLength(2);
    expect(n.header[0][0]).toEqual({ type: 'text', text: '名' });
    expect(n.rows[1][1][0]).toEqual({ type: 'text', text: '2' });
  });

  it('表格缺分隔行 → 按段落', () => {
    expect(one('| 名 | 值 |\n| a | 1 |').type).toBe('paragraph');
  });
});

describe('MU2a Task 1 行内解析', () => {
  it('粗/斜/删/行内码/链接五件套', () => {
    const n = one('**b** *i* ~~s~~ `c` [t](https://a.b)');
    if (n.type !== 'paragraph') throw new Error('expect paragraph');
    const types = n.children.filter(c => c.type !== 'text').map(c => c.type);
    expect(types).toEqual(['bold', 'italic', 'strikethrough', 'inlineCode', 'link']);
  });

  it('行内码内容不二次解析（` ** ` 原样）', () => {
    const n = one('`**不是粗**`');
    if (n.type !== 'paragraph') throw new Error('expect paragraph');
    expect(n.children[0]).toEqual({ type: 'inlineCode', text: '**不是粗**' });
  });

  it('嵌套：**粗中斜*斜体*尾**', () => {
    const n = one('**粗中斜*斜体*尾**');
    if (n.type !== 'paragraph') throw new Error('expect paragraph');
    const b = n.children[0] as MdInline & { children: MdInline[] };
    expect(b.type).toBe('bold');
    expect(b.children.some(c => c.type === 'italic')).toBe(true);
  });

  it('链接 children 是行内解析的文本', () => {
    const n = one('[**粗链**](https://a.b)');
    if (n.type !== 'paragraph') throw new Error('expect paragraph');
    const l = n.children[0];
    expect(l.type).toBe('link');
    if (l.type === 'link') {
      expect(l.href).toBe('https://a.b');
      expect(l.children[0].type).toBe('bold');
    }
  });
});

describe('MU2a Task 1 混合文档与归一化', () => {
  it('「段落 + 围栏 + 列表」组合文档逐节点断言', () => {
    const nodes = parseMarkdown('先说两句。\n\n```js\nfn();\n```\n\n- 要点一\n- 要点二');
    expect(nodes.map(n => n.type)).toEqual(['paragraph', 'codeBlock', 'ul']);
    expect(nodes[1]).toMatchObject({ lang: 'js', code: 'fn();' });
  });

  it('\\r\\n 归一化：与 \\n 文档产出相同 AST', () => {
    const a = parseMarkdown('## t\r\n\r\n- x\r\n- y');
    const b = parseMarkdown('## t\n\n- x\n- y');
    expect(a).toEqual(b);
  });

  it('空串 / 纯空白 → 空数组；无尾换行正常解析', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('  \n \n')).toEqual([]);
    expect(parseMarkdown('无尾换行')).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: '无尾换行' }] }]);
  });
});
