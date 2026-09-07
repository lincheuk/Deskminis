/**
 * T6a · `ui/UiIcon.vue` 的 v-html 白名单守卫。
 *
 * 真空来历：旧 `components/Icon.vue` 的同类 `v-html` 由 `renderer-icon-guard.test.ts`
 * 守着，**而那个文件至今仍活**（被 MarkdownView 引用）——所以 T6 删掉其余旧组件
 * **不会让这个真空变红**，问题不会被自动暴露。补网必须排在拆网之前。
 *
 * 与旧守卫的三处差异（照搬会假阳性，逐条记明）：
 * ① 新组件把表达式内联写在模板里，没有 `computed inner` 中间变量，锚串不同；
 * ② 字典名是 `P` 不是 `PATHS`；
 * ③ **UiIcon 的字典里没有 `<ellipse`**（那是旧 Icon.vue 的 memory 图标才有的），
 *    照抄「必须含 ellipse」这条会直接红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '../src/renderer/src/ui/UiIcon.vue'),
  'utf8',
).replace(/\r\n/g, '\n');

/** 字典体：从 `const P` 起到第一个 `};` 止。 */
function dictBlock(): string {
  const start = src.indexOf('const P');
  const end = src.indexOf('};', start);
  expect(start, '找不到 const P 字典').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('T6a — UiIcon v-html 白名单', () => {
  it('绑定表达式是静态字典查找，无用户输入可达的内容通道', () => {
    // props.name 只作**键**用；未命中落 P.dots。用户能选「输出哪一条静态串」，不能提供内容。
    expect(src).toContain('v-html="P[props.name] ?? P.dots"');
    // 字典必须是编译期 const 字面量：声明一次、此后只读
    expect(src).toMatch(/const P: Record<string, string> = \{/);
    expect(src.match(/\bconst P\b/g) ?? []).toHaveLength(1);
    // 任何写入（整体重赋 / 按键赋值 / Object.assign）都意味着有了动态来源
    expect(src).not.toMatch(/\bP\s*\[[^\]]*\]\s*=[^=]/);
    expect(src).not.toMatch(/\bP\s*=[^=]/);
    expect(src).not.toMatch(/Object\.assign\(\s*P\b/);
  });

  it('字典值不含可执行 / 可导航内容（XSS 红线）', () => {
    const block = dictBlock();
    const forbidden = [
      /on\w+\s*=/i, /<script/i, /<\/script>/i, /javascript:/i,
      /<img/i, /<iframe/i, /<style/i, /<link/i, /<a\b/i, /<svg/i, /<foreignObject/i,
      // 旧守卫漏的四条，这里补上：图标是纯几何，不该有任何 URL/引用/实体
      /href/i, /xlink/i, /url\(/i, /&#/,
    ];
    for (const re of forbidden) {
      expect(block, `字典命中禁用模式 ${re}`).not.toMatch(re);
    }
  });

  it('字典只用几何标签（rect / path / circle）', () => {
    // 切片必须从 `= {` 之后开始：从 `const P` 开始会把 `Record<string, string>`
    // 里的 `<string` 当成一个标签抽出来，白名单必红（旧守卫就是这么规避的）
    const start = src.indexOf('const P');
    const open = src.indexOf('= {', start) + 3;
    const body = src.slice(open, src.indexOf('};', start));
    const tags = [...new Set([...body.matchAll(/<([a-zA-Z]+)/g)].map(m => m[1]))].sort();
    expect(tags).toEqual(['circle', 'path', 'rect']);
  });

  it('svg 上有 aria-hidden——图标是装饰，语义由外层控件的可访问名承担', () => {
    expect(src).toContain('aria-hidden="true"');
  });
});
