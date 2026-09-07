/**
 * T6a · 焦点环守卫（新树形态）。
 *
 * 旧 `tokens-mu3-appica` 例 11 的形态是「点名 10 个组件，各自必须含 `:focus-visible`
 * 与 `var(--ring`」。那个形态在新树上不成立也不该成立：
 * 新树把焦点环收在 `theme.css` 的**一条全局规则**里，组件不再各写一份
 * （逐组件清单本身就是「锚实现不锚意图」的写法，组件一改名就失效）。
 *
 * 换成两条真正的不变量：
 * ① 全局环存在且可见；
 * ② 谁掐掉了全局环（`outline: none`），谁就必须在同一处给出替代环——
 *    否则键盘用户会在那个控件上彻底失去焦点指示。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src', 'renderer', 'src');
const theme = fs.readFileSync(path.join(SRC, 'styles/theme.css'), 'utf8').replace(/\r\n/g, '\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

describe('T6a — 焦点环', () => {
  it('theme.css 有全局 :focus-visible，且给出可见 outline', () => {
    const m = /:focus-visible\s*\{([^}]*)\}/.exec(theme);
    expect(m, 'theme.css 缺全局 :focus-visible').not.toBeNull();
    // 必须是「画出来」而不是「抹掉」
    expect(m![1]).toMatch(/outline:\s*\d/);
    expect(m![1]).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it('掐掉全局环的地方必须给出替代环', () => {
    const offenders: string[] = [];
    for (const f of [...walk(path.join(SRC, 'ui')), path.join(SRC, 'styles/theme.css')]) {
      const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
      if (!/outline:\s*(none|0)\b/.test(src)) continue;
      // 替代环的形态：任一 focus 态选择器块里给了 box-shadow 或 border-color
      const hasReplacement = /:focus(-within|-visible)?[^{]*\{[^}]*(box-shadow|border-color)/.test(src);
      if (!hasReplacement) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it('组件不各写一份焦点环——环收在 theme.css 一处（改一次全站生效）', () => {
    const dup = walk(path.join(SRC, 'ui'))
      .filter(f => /:focus-visible\s*\{/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f));
    expect(dup).toEqual([]);
  });
});
