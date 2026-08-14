/** MU3 新守卫：Appica 视觉语言移植保真度 + 别名映射防漂移（12 例）。
 *
 *  取值唯一来源（MU3 新红线）：docs/specs/2026-08-09-appica-tokens-reference.css
 *    来源 https://unpkg.com/@appica/ui-react@1.0.0/styles.css（@appica/ui-react@1.0.0，MIT）
 *  禁止联网重取、禁止凭印象写值（xterm 兜底换算值除外，见例 9 白名单）。
 *
 *  转绿映射（MU3 计划 §4）：例 1-7 → Task 2（tokens.css 双层重构）；例 8 → Task 3（material 退场）；
 *  例 9/12 → Task 4（硬编码收编）；例 10 → Task 5（7 级 label 消费）；例 11 → Task 6（焦点环）。
 *  （计划文本估算「新守卫 +11 例」；实落 12 例——7 级 label 拆「别名定义」（例 4，Task 2 绿）与
 *   「组件消费清单」（例 10，Task 5 绿）两例，否则 Task 5 没有自己的先红→转绿目标。）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const tokens = R('../src/renderer/src/styles/tokens.css');
const REF = R('../../docs/specs/2026-08-09-appica-tokens-reference.css');

/** 按选择器切片（与 tokens-evolution 相同的 6 个字面切片标记，红线：逐字保留） */
function section(src: string, start: string, end?: string): string {
  const i = src.indexOf(start);
  if (i < 0) return '';
  const j = end ? src.indexOf(end, i + start.length) : -1;
  return src.slice(i, j < 0 ? src.length : j);
}
const rootLight = section(tokens, ':root {', '@media (prefers-color-scheme: dark)');
const mediaDark = section(tokens, '@media (prefers-color-scheme: dark)', '/* 强制深色');
const darkForced = section(tokens, ':root[data-theme="dark"]', ':root[data-theme="light"]');
const lightForced = section(tokens, ':root[data-theme="light"]', '/* 基础复位');

/** 提取花括号块正文（startMarker 之后第一个 { 到其后第一个行首 }） */
function blockOf(src: string, startMarker: string): string {
  const i = src.indexOf(startMarker);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  const close = src.indexOf('\n}', open);
  return open < 0 || close < 0 ? '' : src.slice(open + 1, close);
}
/** 提取自定义属性声明（跨行声明折叠单行、空白归一），保持源序——「逐行一致」做有序比对 */
function decls(css: string): string[] {
  return [...css.matchAll(/--[\w-]+\s*:[^;]+;/g)].map(m => m[0].replace(/\s+/g, ' ').trim());
}
/** tokens.css 段内 A 区（Appica raw 层）切片：A 区标记到 B 区标记之间 */
function areaA(seg: string): string {
  const i = seg.indexOf('/* ===== A 区');
  const j = seg.indexOf('/* ===== B 区');
  return i < 0 || j < 0 ? '' : seg.slice(i, j);
}

const refLight = decls(blockOf(REF, ':root,'));
const refDark = decls(blockOf(REF, '.dark {'));
/** 主题无关 raw（只在 :root 写一次，与参考文件一致；.dark 块本就不含这些族） */
const THEME_INDEPENDENT = /^--(font-sans|font-mono|radius|border-width|opacity-disabled)/;
/** A 区唯一申报偏离：--font-mono 在栈尾 monospace 泛型前补了 CJK 回退
 *  （等宽栈无中文字形，代码块/权限卡里的中文会掉进宋体）。raw 层同样被组件直接
 *  消费，只修 C 区别名修不干净，故两处都补、该键退出逐行一致比对，内容由例 13 单独守。 */
const RAW_FONT_MONO_OVERRIDE = /^--font-mono\s*:/;

/** 递归收集 src/renderer/src 下全部 .vue（含 App.vue） */
const RENDERER_SRC = resolve(__dirname, '../src/renderer/src');
function walkVue(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walkVue(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}
const vueFiles = walkVue(RENDERER_SRC);
/** 抽出全部 <style> 块正文 */
function styleBlocks(src: string): string[] {
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
}
const rel = (p: string) => relative(RENDERER_SRC, p).replace(/\\/g, '/');
const C = (n: string) => R(`../src/renderer/src/components/${n}.vue`);

describe('MU3 Appica 移植守卫（13 例）', () => {
  it('1. tokens.css 头部 MIT 归属四要素（来源 URL / 版本 / 许可证 / 参考文件路径）', () => {
    expect(tokens).toContain('https://unpkg.com/@appica/ui-react@1.0.0/styles.css');
    expect(tokens).toContain('@appica/ui-react@1.0.0');
    expect(tokens).toContain('MIT');
    expect(tokens).toContain('docs/specs/2026-08-09-appica-tokens-reference.css');
  });

  it('2. A 区与参考文件逐行一致：四段 raw 层 == 参考 :root,.light / .dark 声明体（有序比对）', () => {
    expect(refLight.length).toBeGreaterThan(0); // 提取器自检：空表会让 toEqual 假绿
    expect(refDark.length).toBeGreaterThan(0);
    expect(decls(areaA(rootLight)).filter(d => !RAW_FONT_MONO_OVERRIDE.test(d))).toEqual(refLight.filter(d => !RAW_FONT_MONO_OVERRIDE.test(d)));
    expect(decls(areaA(mediaDark))).toEqual(refDark);
    expect(decls(areaA(darkForced))).toEqual(refDark);
    // 主题无关 raw（--font-*/--radius-*/--border-width/--opacity-disabled）只在 :root 写一次
    expect(decls(areaA(lightForced))).toEqual(refLight.filter(d => !THEME_INDEPENDENT.test(d)));
  });

  it('3. 别名映射总表全量断言（§2-1 逐行 → :root 段；5 个分叉项另断暗段）', () => {
    const light: Array<[string, string]> = [
      ['--bg', 'var(--background)'],
      ['--bg-secondary', 'var(--background-muted)'],
      ['--bg-tertiary', 'var(--background)'], // 分叉：暗段 --background-strong
      ['--grouped-bg', 'var(--background-muted)'], // 分叉：暗段 --background
      ['--grouped-bg-secondary', 'var(--background)'], // 分叉：暗段 --background-muted
      ['--grouped-bg-tertiary', 'var(--background-muted)'], // 分叉：暗段 --background-strong
      ['--surface-0', 'var(--bg)'],
      ['--surface-1', 'var(--grouped-bg-secondary)'],
      ['--surface-2', 'var(--grouped-bg-tertiary)'],
      ['--label', 'var(--foreground-strong)'], // MU3 收尾：正文提一档（base→strong），见 ui-design-v3 §8
      ['--label-secondary', 'var(--foreground-muted)'],
      ['--label-tertiary', 'var(--foreground-subtle)'],
      ['--label-quaternary', 'var(--foreground-subtle)'], // 与 tertiary 视觉合并（Appica 弱级仅 2 档）
      ['--label-strong', 'var(--foreground-emphasis)'], // 随正文连带上移，保住「正文 vs 标题」色差
      ['--label-emphasis', 'var(--foreground-emphasis)'],
      ['--label-intense', 'var(--foreground-intense)'],
      ['--separator', 'var(--border-strong)'], // MU3 收尾：hairline 提一档（border→border-strong）
      ['--separator-opaque', 'var(--border-strong)'],
      ['--fill', 'var(--background-strong)'],
      ['--fill-tertiary', 'var(--background-muted)'],
      ['--fill-quaternary', 'var(--background-subtle)'],
      ['--accent', 'var(--secondary-emphasis)'],
      ['--action', 'var(--accent)'],
      ['--on-action', 'var(--primary-foreground)'], // 分叉：暗段 --foreground-intense（两模式均白）
      ['--link', 'var(--secondary-emphasis)'], // 与 accent 收敛
      ['--assistant-gradient', 'linear-gradient(135deg, var(--foreground-muted), var(--foreground-subtle))'],
      ['--red', 'var(--error-emphasis)'],
      ['--green', 'var(--success-emphasis)'],
      ['--orange', 'var(--warning-emphasis)'],
      ['--yellow', 'var(--warning-intense)'],
      ['--blue', 'var(--info-emphasis)'],
      ['--purple', 'var(--secondary-intense)'],
      ['--cyan', 'var(--info-strong)'],
      ['--state-ok', 'var(--success-emphasis)'],
      ['--state-err', 'var(--error-emphasis)'],
      ['--state-warn', 'var(--warning-emphasis)'],
      ['--state-info', 'var(--info-emphasis)'],
      ['--state-ok-bg', 'var(--success-subtle)'],
      ['--state-ok-border', 'var(--success-soft)'],
      ['--state-err-bg', 'var(--error-subtle)'],
      ['--state-err-border', 'var(--error-soft)'],
      ['--state-warn-bg', 'var(--warning-subtle)'],
      ['--state-warn-border', 'var(--warning-soft)'],
      ['--state-info-bg', 'var(--info-subtle)'],
      ['--state-info-border', 'var(--info-soft)'],
      ['--shadow-fab', '0 4px 8px var(--shadow-color)'],
      ['--shadow-pop', '0 8px 24px var(--shadow-color)'],
      ['--scrim', 'rgba(0,0,0,.4)'],
      ['--r-control', 'var(--radius-2xs)'],
      ['--r-md', 'var(--radius-xs)'],
      ['--r-card', 'var(--radius-sm)'],
      ['--r-input', 'var(--radius-lg)'],
      ['--r-bubble', 'var(--radius-xl)'],
      ['--r-sheet', 'var(--radius-2xl)'], // 20px 无等值阶，模态大面取 2xl（申报项）
      ['--r-pill', '999px'],
      ['--ring', 'var(--focus-ring)'],
      ['--ring-input', 'var(--focus-ring-input)'],
      ['--ring-danger', 'var(--focus-ring-error)'],
    ];
    for (const [k, v] of light) expect(rootLight).toContain(`${k}: ${v};`);
    const darkFork: Array<[string, string]> = [
      ['--bg-tertiary', 'var(--background-strong)'],
      ['--grouped-bg', 'var(--background)'],
      ['--grouped-bg-secondary', 'var(--background-muted)'],
      ['--grouped-bg-tertiary', 'var(--background-strong)'],
      ['--on-action', 'var(--foreground-intense)'],
    ];
    for (const [k, v] of darkFork) expect(mediaDark).toContain(`${k}: ${v};`);
  });

  it('4. 7 级 label 别名定义：strong/emphasis/intense 指向 foreground 同名强级', () => {
    expect(rootLight).toContain('--label-strong: var(--foreground-emphasis);');
    expect(rootLight).toContain('--label-emphasis: var(--foreground-emphasis);');
    expect(rootLight).toContain('--label-intense: var(--foreground-intense);');
  });

  it('5. color-mix 仅限玻璃块：其余全文清零（命门 3 选 B：状态色走 Appica 直给 alpha）', () => {
    // MU3 命门 3 的论证是**针对状态色**的：Appica raw 层本就提供 -subtle 10% / -soft 20%，
    // 再用 color-mix 派生既冗余、又绕开了「raw 值是唯一来源」的纪律。
    // 该论证对玻璃材质不成立——Appica 没有 58%/78% 这两档，而玻璃又必须跟随明暗，
    // 只能从语义令牌派生。故 2026-08-10（用户要求苹果磨砂风格）把本条收窄为
    // 「玻璃块内放行、其余仍然清零」，而不是删掉它：状态色那条纪律一点没松。
    const b = tokens.indexOf('glass:begin');
    const e = tokens.indexOf('glass:end');
    expect(b).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(b);
    const outsideGlass = tokens.slice(0, b) + tokens.slice(e);
    expect(outsideGlass).not.toContain('color-mix');
    // 玻璃块里的 color-mix 只许拿**语义令牌**当原料，不许直接写 raw 色值
    const glass = tokens.slice(b, e);
    expect(glass).not.toMatch(/color-mix\([^)]*oklch\(/);
    expect(glass).not.toMatch(/color-mix\([^)]*#[0-9a-fA-F]{3,8}/);
  });

  it('6. material 清零：tokens.css 全文不含 --material（组件侧滤镜由例 8 守）', () => {
    expect(tokens).not.toContain('--material');
  });

  it('7. 圆角别名：6 条映射 radius 派生阶 + --r-pill 字面值保留（§2-3）', () => {
    expect(rootLight).toContain('--r-control: var(--radius-2xs);');
    expect(rootLight).toContain('--r-md: var(--radius-xs);');
    expect(rootLight).toContain('--r-card: var(--radius-sm);');
    expect(rootLight).toContain('--r-input: var(--radius-lg);');
    expect(rootLight).toContain('--r-bubble: var(--radius-xl);');
    expect(rootLight).toContain('--r-sheet: var(--radius-2xl);');
    expect(rootLight).toContain('--r-pill: 999px;');
  });

  it('8. backdrop-filter 白名单制：仅登记组件可用，且带弹出层的组件一律禁止', () => {
    // MU3 原为「全部 .vue 零命中」。2026-08-10 用户要求苹果磨砂风格，本条由**一刀切**改为
    // **白名单**——但安全约束一点没松：backdrop-filter 会创建**层叠上下文**，
    // 凡是身上有下拉菜单/弹层的组件用了它，弹层就会被压在下面。
    // TitleBar 当年就是这么中招的（renderer-titlebar-stacking 有实测取证），
    // MU5 §15 又刚因为同族问题（容器裁剪弹层）吃过一次「点了没反应」。
    const ALLOW = ['ProgressPanel'];
    // 这些组件自带弹出层/浮层，永久禁用——加进 ALLOW 也不行，下面单独再断言一次
    const POPUP_OWNERS = ['TitleBar', 'ModelPicker', 'PermissionPicker', 'SettingsModal', 'DevicesModal', 'ChatView', 'SessionList'];
    const offenders: string[] = [];
    const usedGlass: string[] = [];
    for (const f of vueFiles) {
      const name = rel(f).replace(/^.*[\/]/, '').replace(/\.vue$/, '');
      styleBlocks(R(f)).forEach((b, i) => {
        if (!b.includes('backdrop-filter')) return;
        usedGlass.push(name);
        if (!ALLOW.includes(name)) offenders.push(`${rel(f)} <style>#${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
    // 双保险：白名单将来被人随手加宽时，这条仍会把「给弹层宿主上滤镜」拦下
    expect(usedGlass.filter(n => POPUP_OWNERS.includes(n))).toEqual([]);
  });

  it('9. 组件零硬编码颜色：<style> 块无 hex/rgba；TerminalPanel xterm 兜底值登记白名单', () => {
    const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
    const offenders: string[] = [];
    for (const f of vueFiles) {
      for (const b of styleBlocks(R(f))) {
        for (const m of b.matchAll(COLOR)) offenders.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    // xterm 主题是 JS 对象、走不进 CSS 变量：TerminalPanel <script> 兜底值登记白名单，
    // 唯一合法硬编码（Task 4 按新调色板 oklch→srgb 换算后同步更新白名单值）。
    const term = C('TerminalPanel');
    const found = [...new Set([...term.matchAll(COLOR)].map(m => m[0]))].sort();
    expect(found).toEqual(['#4a5565', '#e5e7eb', '#ffffff'].sort());
  });

  it('10. 7 级 label 组件消费清单（Task 5 表：15 改各含指定新级；7 不改零引用）', () => {
    const strong = ['ArtifactsPanel', 'ChatView', 'DevicesModal', 'DiffView', 'EmptyState', 'FilesPanel',
      'ModelPicker', 'PermissionCard', 'PermissionPicker', 'ProgressPanel', 'ProviderSettings',
      'SessionList', 'TitleBar', 'ToolLine'];
    const emphasis = ['EmptyState', 'SettingsModal'];
    const intense = ['DevicesModal', 'PermissionCard', 'SettingsModal'];
    for (const n of strong) expect(C(n), `${n} 应含 var(--label-strong)`).toContain('var(--label-strong)');
    for (const n of emphasis) expect(C(n), `${n} 应含 var(--label-emphasis)`).toContain('var(--label-emphasis)');
    for (const n of intense) expect(C(n), `${n} 应含 var(--label-intense)`).toContain('var(--label-intense)');
    for (const n of ['EventNote', 'FadeText', 'FileTreeNode', 'Icon', 'MarkdownInline', 'MarkdownView', 'TerminalPanel']) {
      expect(C(n), `${n} 不应引用新 label 级`).not.toMatch(/var\(--label-(strong|emphasis|intense)\)/);
    }
  });

  it('11. 焦点环：10 组件各含 :focus-visible 与 var(--ring（§2-5 清单）', () => {
    for (const n of ['ChatView', 'TitleBar', 'SessionList', 'SettingsModal', 'ProviderSettings',
      'PermissionCard', 'PermissionPicker', 'ModelPicker', 'DevicesModal', 'ToolLine']) {
      expect(C(n), `${n} 应含 :focus-visible`).toContain(':focus-visible');
      expect(C(n), `${n} 应含 var(--ring`).toContain('var(--ring');
    }
  });

  it('12. --scrim 收编：tokens.css 唯一声明；DevicesModal/SettingsModal 遮罩走 var(--scrim)', () => {
    expect(tokens).toContain('--scrim: rgba(0,0,0,.4)');
    expect(tokens.split('--scrim:').length - 1).toBe(1); // 唯一声明处
    expect(C('DevicesModal')).toContain('var(--scrim)');
    expect(C('SettingsModal')).toContain('var(--scrim)');
  });

  it('13. mono 栈 CJK 回退：两处 --font-mono 均在 monospace 泛型前含 "Noto Sans SC"', () => {
    const monoDecls = [...tokens.matchAll(/--font-mono\s*:[^;]+;/g)].map(m => m[0].replace(/\s+/g, ' '));
    // 恰好两处：A 区 raw 一处 + C 区 DeskMinis 别名一处（见 RAW_FONT_MONO_OVERRIDE 申报）
    expect(monoDecls).toHaveLength(2);
    for (const d of monoDecls) {
      expect(d).toContain('"Noto Sans SC"');
      expect(d).toContain('"Microsoft YaHei"');
      // 必须排在栈尾 monospace 泛型之前，否则泛型兜底先命中、CJK 回退永不生效
      // （用 'monospace;' 定位泛型——'ui-monospace' 不以分号结尾，不会误匹配）
      expect(d.indexOf('"Noto Sans SC"')).toBeLessThan(d.indexOf('monospace;'));
    }
  });
});
