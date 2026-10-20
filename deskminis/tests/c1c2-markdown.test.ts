/** 补充23：实时围栏与历史兜底互不改变。 */
import { describe, expect, it } from 'vitest';
import { parseLiveMarkdown, parseMarkdown, type MdNode } from '../src/renderer/src/lib/markdown/parse';
import { isReasoningPlaceholder, showLiveReasoning } from '../src/renderer/src/lib/reasoning';
import { turnMarkdown } from '../src/renderer/src/lib/turn-text';

function codes(nodes: MdNode[]): Extract<MdNode, { type: 'codeBlock' }>[] {
  return nodes.flatMap(n => n.type === 'codeBlock' ? [n] : 'children' in n && ['blockquote', 'li'].includes(n.type)
    ? codes(n.children as MdNode[]) : 'items' in n ? codes(n.items) : []);
}

describe('C1 实时围栏', () => {
  it.each(['ts', ''])('顶层未闭合（语言 %s）', lang => {
    expect(parseLiveMarkdown('```' + lang + '\nconst a = 1;')).toEqual([
      { type: 'codeBlock', lang, code: 'const a = 1;', open: true },
    ]);
  });

  it.each(['\n', '\n`', '\n``', '\n  ', '\n ` '])('未完成的末行 %j 不进入代码', tail => {
    expect(codes(parseLiveMarkdown('```js\nx()' + tail))[0]).toEqual({ type: 'codeBlock', lang: 'js', code: 'x()', open: true });
  });

  it('只略掉最后一行，保留代码内的空行和反引号', () => {
    expect(codes(parseLiveMarkdown('```\na\n\nb\n`inside`\n'))[0].code).toBe('a\n\nb\n`inside`');
  });

  it.each([
    '1. 第一项\n2. 第二项\n  ```ts\n  const a = 1;',
    '- 第一项\n- 第二项\n  ```ts\n  const a = 1;\n\n',
    '> 引用\n> ```ts\n> const a = 1;\n\n',
    '> - 嵌套\n>   ```ts\n>   const a = 1;\n\n',
    '- 嵌套\n  > ```ts\n  > const a = 1;',
  ])('最后的列表或引用递归传递全文末尾：%s', src => {
    expect(codes(parseLiveMarkdown(src))).toEqual([{ type: 'codeBlock', lang: 'ts', code: 'const a = 1;', open: true }]);
    expect(codes(parseMarkdown(src))).toEqual([]);
  });

  it.each([
    '- 前项\n  ```ts\n  x()\n- 后项',
    '> ```ts\n> x()\n\n后文',
    '- 前项\n  > ```ts\n  > x()\n- 后项',
    '- 前项\n  ```ts\n  x()\n\n后文',
  ])('容器后还有内容时不把内部围栏当作 open：%s', src => {
    expect(parseLiveMarkdown(src)).toEqual(parseMarkdown(src));
    expect(codes(parseLiveMarkdown(src))).toEqual([]);
  });

  it('引用后紧跟非空行时，内部未闭合围栏不算全文末尾', () => {
    const src = '> ```ts\n> x()\n后文';
    expect(parseLiveMarkdown(src)).toEqual(parseMarkdown(src));
    expect(codes(parseLiveMarkdown(src))).toEqual([]);
  });

  it.each(['```ts\nx()\n```', '- 项\n  ```ts\n  x()\n  ```', '> ```ts\n> x()\n> ```'])('闭合节点与历史相等，且不带 open 键：%s', src => {
    expect(parseLiveMarkdown(src)).toEqual(parseMarkdown(src));
    expect(codes(parseLiveMarkdown(src))[0]).toEqual({ type: 'codeBlock', lang: 'ts', code: 'x()' });
    expect(Object.hasOwn(codes(parseLiveMarkdown(src))[0], 'open')).toBe(false);
  });

  it('空输入与 CRLF', () => {
    expect(parseLiveMarkdown(' \n ')).toEqual([]);
    expect(codes(parseLiveMarkdown('```ts\r\nx()\r\n``'))[0]).toEqual({ type: 'codeBlock', lang: 'ts', code: 'x()', open: true });
  });
});

describe('第31条仅隐藏占位句', () => {
  it.each(['No reasoning available.', ' No reasoning available \n', 'NO REASONING AVAILABLE.', 'no reasoning available'])('历史占位：%j', text => {
    expect(isReasoningPlaceholder(text)).toBe(true);
  });

  it.each(['No reasoning available. But first…', 'Thinking: no reasoning available', 'No, wait', 'No reasoning', ''])('历史真内容不隐藏：%j', text => {
    expect(isReasoningPlaceholder(text)).toBe(false);
  });

  it.each(['', ' \n ', 'N', 'No reas', 'NO REASONING AVAILABLE', 'No reasoning available.'])('实时前缀/空白先不画：%j', text => {
    expect(showLiveReasoning(text)).toBe(false);
  });

  it.each(['No, wait', 'Let me think', 'No reasoning available. But first…'])('实时分歧即画：%j', text => {
    expect(showLiveReasoning(text)).toBe(true);
  });
});

describe('C2 正文复制口径', () => {
  it('保留全部正文原文和顺序，跳过思考与工具输出', () => {
    const blocks = [
      { kind: 'text', text: '## 标题\n第一段  ' },
      { kind: 'think', text: '不要复制的思考' },
      { kind: 'steps', text: '不要复制的工具输出' },
      { kind: 'text', text: '```ts\nx()\n```' },
    ];
    expect(turnMarkdown(blocks)).toBe('## 标题\n第一段  \n\n```ts\nx()\n```');
    expect(turnMarkdown([])).toBe('');
    expect(turnMarkdown([{ kind: 'steps', text: '工具输出' }])).toBe('');
  });
});
