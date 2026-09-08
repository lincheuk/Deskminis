/** T1 新设计系统守卫（设计稿 2026-08-21-ui-rebuild-design.md §2）。
 *
 *  接棒退役的 tokens-aurora-contrast：那份锚的是旧 oklch 令牌体系，随旧 UI 一同作废。
 *  锚的意图不变且更严——**文字必须可读**，逐对算 WCAG 对比度，浅深双主题各一遍。
 *  新色板是 hex，不必再解析 oklch，直接算。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(
  path.join(path.resolve(__dirname, '..'), 'src/renderer/src/styles/theme.css'), 'utf8');

/** 取某个作用域块内的令牌表。scope 为 ':root' 或 ':root[data-theme="dark"]'。 */
function tokensOf(scope: string): Record<string, string> {
  const i = css.indexOf(scope + ' {');
  if (i < 0) throw new Error(`找不到作用域 ${scope}`);
  const body = css.slice(i, css.indexOf('\n}', i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const srgb = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`不是 6 位 hex：${hex}`);
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => srgb(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** 每对 [前景, 背景, 最低对比度, 说明]。
 *  4.5 = 正文 AA；3.0 = 弱文字/大字 AA（仅用于非关键信息）。 */
const PAIRS: [string, string, number, string][] = [
  ['--c-ink', '--c-bg', 7, '主文字/舞台底'],
  ['--c-ink', '--c-bg-1', 7, '主文字/导航底'],
  ['--c-ink', '--c-bg-2', 7, '主文字/卡片底'],
  ['--c-ink-2', '--c-bg', 4.5, '次文字/舞台底'],
  ['--c-ink-2', '--c-bg-1', 4.5, '次文字/导航底'],
  ['--c-ink-2', '--c-bg-2', 4.5, '次文字/卡片底'],
  ['--c-ink-3', '--c-bg', 3, '弱文字/舞台底'],
  ['--c-ink-3', '--c-bg-1', 3, '弱文字/导航底'],
  ['--c-brand-ink', '--c-brand', 4.5, '主色按钮文字'],
  ['--c-ink', '--c-brand-soft', 7, '主文字/选中行底'],
  ['--c-ink-2', '--c-brand-soft', 4.5, '次文字/选中行底'],
  ['--c-link', '--c-bg', 4.5, '链接/舞台底'],
  ['--c-err', '--c-bg', 3, '错误色/舞台底'],
  ['--c-ok', '--c-bg', 3, '成功色/舞台底'],
  ['--c-err-ink', '--c-err', 4.5, '危险按钮文字'],
];

for (const [scope, label] of [[':root', '浅色'], [':root[data-theme="dark"]', '深色']] as const) {
  describe(`T1 主题对比度（${label}）`, () => {
    const t = tokensOf(scope);
    for (const [fg, bg, min, why] of PAIRS) {
      it(`${why}：${fg} on ${bg} ≥ ${min}:1`, () => {
        const f = t[fg] ?? tokensOf(':root')[fg];
        const b = t[bg] ?? tokensOf(':root')[bg];
        expect(contrast(f, b)).toBeGreaterThanOrEqual(min);
      });
    }
  });
}

describe('T1 设计系统立系原则（锚意图，不锚具体值）', () => {
  it('阴影只有两条合法定义：浮层与聚焦晕（卡片零阴影是硬规矩）', () => {
    // 各主题块都会改写 --sh-pop，故数个数是锚实现；锚意图 = 阴影令牌的**名字**只有这两个
    const names = new Set([...css.matchAll(/(--sh-[\w-]+):/g)].map(m => m[1]));
    expect([...names].sort()).toEqual(['--sh-focus', '--sh-paper', '--sh-pop']);
  });
  it('字号与行高成对：每个排版档都必须同时有 -size 与 -lh', () => {
    const sizes = [...css.matchAll(/--t-([\w]+)-size:/g)].map(m => m[1]).sort();
    const lhs = [...css.matchAll(/--t-([\w]+)-lh:/g)].map(m => m[1]).sort();
    expect(sizes).toEqual(lhs);
    expect(sizes.length).toBeGreaterThanOrEqual(7);
  });
  it('字体只从本地随包取，绝不联网；栈里没有 Inter（AionUi 实测：装了它反而显细）', () => {
    // 改锚（申报）：原断言「一个 @font-face 都不许有」锚的是实现，把「随包字体」也一并禁了。
    // 真正的红线是**不联网取字体**（断网即失效、首屏闪字），本地文件不在此列。
    // 故改锚为：@font-face 的 src 必须是相对路径的本地资源，CSS 里不得出现任何字体 CDN。
    expect(css).not.toContain('fonts.googleapis');
    expect(css).not.toContain('fonts.gstatic');
    const srcs = [...css.matchAll(/@font-face[^}]*?src:\s*url\(([^)]+)\)/g)].map(m => m[1]);
    expect(srcs.length).toBeGreaterThan(0);          // 随包字体必须在（否则 Windows 上只剩雅黑）
    for (const u of srcs) expect(u).toMatch(/^"\.\.\/assets\/fonts\//);
    // 只检字体栈的**值**（注释里提到某字体名不算违规）
    const stacks = [...css.matchAll(/--f-(?:ui|mono):\s*([^;]+);/g)].map(m => m[1]).join(' ');
    expect(stacks).not.toMatch(/\bInter\b/);
  });
  it('主色分工：交互蓝 --c-brand 与品牌紫 --c-aou 各司其职', () => {
    // 改锚（申报）：原断言把 --bg-8(#4e5969) 钉成主色——那是**读错源码**留下的锚，
    // 它只是灰阶一档（AionUi 拿它做次文字）。真正的语义主色是 --primary #165dff，
    // 另有 --aou-* 紫色品牌阶梯（源码抬头即 "AOU Purple Theme"）。锚随事实修正。
    const t = tokensOf(':root');
    expect(t['--c-brand'].toLowerCase()).toBe('#165dff');
    expect(t['--c-aou'].toLowerCase()).toBe('#7583b2');
    expect(t['--c-brand']).not.toBe(t['--c-aou']);   // 交互与品牌不许同色，否则界面失焦
  });
  it('边框基线设 transparent（漏写颜色的边框保持隐形，不冒黑线）', () => {
    expect(css).toMatch(/\*::before,\s*\*::after\s*\{[^}]*border-color:\s*transparent/);
  });
});

describe('T6d — 两套令牌文件的同名令牌必须同值', () => {
  /** `main.ts` 先引 theme.css 再引 tokens.css，**后加载的赢**。
   *  两边有九个同名令牌，其中七个值不同——整套间距标尺被旧文件顶高一档，
   *  297 处引用一直渲染的是旧值，theme.css 写的那套从未生效过。
   *
   *  已按「让声明追上像素」对齐（T 波界面正是在旧标尺下审过并被接受的，
   *  反过来改要重新目视 297 处）。这道守卫钉住此后任一边都不许再漂：
   *  一旦漂了，theme.css 就又变成一份「写了不算数」的文件，
   *  而它自称是新设计系统的唯一真相源。
   *
   *  tokens.css 目前不能删——MarkdownView / MarkdownInline 还消费它 18 个变量。
   *  但对齐之后哪天删掉它，视觉零变化。 */
  const tokensCss = fs.readFileSync(
    path.join(path.resolve(__dirname, '..'), 'src/renderer/src/styles/tokens.css'), 'utf8');

  /** 抓一份文件里所有 `--name: value` 的**首次**声明（同名多作用域取第一处，即浅色态）。 */
  function declaredIn(src: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (!out.has(m[1])) out.set(m[1], m[2].trim());
    }
    return out;
  }

  /** 解析成 px 数值再比：tokens.css 那边多是 `var(--radius-2xl)` 这类间接引用，
   *  逐字比会把「值相同、写法不同」误判成漂移。解析不了就抛——
   *  出现新写法要被看见，不能悄悄跳过（跳过等于守卫失效）。 */
  function resolvePx(raw: string, table: Map<string, string>, depth = 0): number {
    const v = raw.trim();
    if (depth > 8) throw new Error(`令牌解析层数过深：${raw}`);
    let m = /^(-?[\d.]+)px$/.exec(v);
    if (m) return Number(m[1]);
    // rem 按浏览器默认根字号 16px 折算——项目没有改 html 的 font-size
    m = /^(-?[\d.]+)rem$/.exec(v);
    if (m) return Number(m[1]) * 16;
    m = /^var\((--[\w-]+)\)$/.exec(v);
    if (m) {
      const next = table.get(m[1]);
      if (next === undefined) throw new Error(`引用了不存在的令牌：${m[1]}`);
      return resolvePx(next, table, depth + 1);
    }
    // 只认实际用到的这一种 calc 形态：calc(var(x) * a / b)
    m = /^calc\(\s*var\((--[\w-]+)\)\s*\*\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)$/.exec(v);
    if (m) {
      const base = table.get(m[1]);
      if (base === undefined) throw new Error(`calc 引用了不存在的令牌：${m[1]}`);
      return resolvePx(base, table, depth + 1) * Number(m[2]) / Number(m[3]);
    }
    throw new Error(`无法解析成 px 的令牌值：${raw}（守卫需要补一条解析规则）`);
  }

  it('同名令牌解析后逐个同值（不同值 = theme.css 那份写了不算数）', () => {
    const a = declaredIn(css);
    const b = declaredIn(tokensCss);
    const clash = [...a.keys()].filter(k => b.has(k)).sort();
    // 碰撞本身是允许的（两文件并存期），值不一样才是问题
    expect(clash.length, '两文件不再有同名令牌了？那这条守卫该退场').toBeGreaterThan(0);
    const mismatch: string[] = [];
    for (const k of clash) {
      const av = resolvePx(a.get(k)!, a);
      const bv = resolvePx(b.get(k)!, b);
      if (av !== bv) mismatch.push(`${k}: theme.css=${a.get(k)}(${av}px) vs tokens.css=${b.get(k)}(${bv}px)`);
    }
    expect(mismatch).toEqual([]);
  });
});
