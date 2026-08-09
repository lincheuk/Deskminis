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

describe('MU3 Appica 移植守卫（12 例）', () => {
  it('1. tokens.css 头部 MIT 归属四要素（来源 URL / 版本 / 许可证 / 参考文件路径）', () => {
    expect(tokens).toContain('https://unpkg.com/@appica/ui-react@1.0.0/styles.css');
    expect(tokens).toContain('@appica/ui-react@1.0.0');
    expect(tokens).toContain('MIT');
    expect(tokens).toContain('docs/specs/2026-08-09-appica-tokens-reference.css');
  });

  it('2. A 区与参考文件逐行一致：四段 raw 层 == 参考 :root,.light / .dark 声明体（有序比对）', () => {
    expect(refLight.length).toBeGreaterThan(0); // 提取器自检：空表会让 toEqual 假绿
    expect(refDark.length).toBeGreaterThan(0);
    expect(decls(areaA(rootLight))).toEqual(refLight);
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
      ['--label', 'var(--foreground)'],
      ['--label-secondary', 'var(--foreground-muted)'],
      ['--label-tertiary', 'var(--foreground-subtle)'],
      ['--label-quaternary', 'var(--foreground-subtle)'], // 与 tertiary 视觉合并（Appica 弱级仅 2 档）
      ['--label-strong', 'var(--foreground-strong)'],
      ['--label-emphasis', 'var(--foreground-emphasis)'],
      ['--label-intense', 'var(--foreground-intense)'],
      ['--separator', 'var(--border)'],
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
    expect(rootLight).toContain('--label-strong: var(--foreground-strong);');
    expect(rootLight).toContain('--label-emphasis: var(--foreground-emphasis);');
    expect(rootLight).toContain('--label-intense: var(--foreground-intense);');
  });

  it('5. color-mix 清零：tokens.css 全文不含 color-mix（命门 3 选 B：Appica 直给 alpha）', () => {
    expect(tokens).not.toContain('color-mix');
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

  it('8. 组件侧 backdrop-filter 清零：walk 全部 .vue 的 <style> 块零命中（§3-4 配套加宽）', () => {
    const offenders: string[] = [];
    for (const f of vueFiles) {
      styleBlocks(R(f)).forEach((b, i) => {
        if (b.includes('backdrop-filter')) offenders.push(`${rel(f)} <style>#${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
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
    expect(found).toEqual(['#000000', '#ffffff', 'rgba(120,120,128,.2)'].sort());
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
});
