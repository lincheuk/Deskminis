/** 补充14a：仅保留现行令牌归属和仍有效的组件纪律。旧raw/别名结构按裁定退场。 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const theme = R('../src/renderer/src/styles/theme.css');
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
// T6e-3 重指：组件树搬到 ui/（components/ 只剩 Icon / MarkdownInline / MarkdownView 三个活文件）
const C = (n: string) => R(`../src/renderer/src/ui/${n}.vue`);


describe('MU3 保留归属与组件守卫（补充14a）', () => {
  it('1. theme.css 保留值归属：AionUi、Apache-2.0、参考文件与取值唯一来源', () => {
    expect(theme).toContain('AionUi');
    expect(theme).toContain('Apache-2.0');
    expect(theme).toContain('docs/specs/2026-08-20-aionui-tokens-reference.css');
    expect(theme).toContain('取值唯一来源');
  });
  it('5. theme.css 不含 color-mix', () => { expect(theme).not.toContain('color-mix'); });
  it('6. theme.css 不含 --material', () => { expect(theme).not.toContain('--material'); });
  it('8. backdrop-filter 白名单制：仅登记组件可用，且带弹出层的组件一律禁止', () => {
    // MU3 原为「全部 .vue 零命中」。2026-08-10 用户要求苹果磨砂风格，本条由**一刀切**改为
    // **白名单**——但安全约束一点没松：backdrop-filter 会创建**层叠上下文**，
    // 凡是身上有下拉菜单/弹层的组件用了它，弹层就会被压在下面。
    // TitleBar 当年就是这么中招的（renderer-titlebar-stacking 有实测取证），
    // MU5 §15 又刚因为同族问题（容器裁剪弹层）吃过一次「点了没反应」。
    // I2 缩容为空集（AionUi 换向，设计稿 2026-08-20 §6）：玻璃消费全面退场，白名单清零。
    // 白名单机制与 POPUP_OWNERS 双保险保留——将来谁想再上 blur，仍要过这道闸逐个登记
    const ALLOW: string[] = [];
    // 这些组件自带弹出层/浮层，永久禁用——加进 ALLOW 也不行，下面单独再断言一次
    const POPUP_OWNERS = ['TitleBar', 'ModelPicker', 'PermissionPicker', 'SettingsModal', 'DevicesModal', 'ChatView', 'SessionList', 'MarketPanel'];
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
    const term = C('TerminalPane');
    const found = [...new Set([...term.matchAll(COLOR)].map(m => m[0]))].sort();
    // I4 换算：AionUi 暗段等值（底 #0e0e0e / 前景 #e8eaee / selection #262626）
    // T 波重写终端：selection 兜底从 #262626 改为 #333333（更亮一档，暗底上选区看得见）
    expect(found).toEqual(['#0e0e0e', '#e8eaee', '#333333'].sort());
  });
  it('12. StageMarket 遮罩仍走 var(--c-scrim)', () => { expect(C('StageMarket')).toContain('var(--c-scrim)'); });
  it('13. mono 栈 CJK 回退：唯一 --font-mono 在 monospace 前包含两种中文字体', () => {
    const monoDecls = [...theme.matchAll(/--font-mono\s*:[^;]+;/g)].map(m => m[0].replace(/\s+/g, ' '));
    expect(monoDecls).toHaveLength(1);
    for (const d of monoDecls) {
      expect(d).toContain('"Noto Sans SC"'); expect(d).toContain('"Microsoft YaHei"');
      expect(d.indexOf('"Noto Sans SC"')).toBeLessThan(d.indexOf('monospace;'));
      expect(d.indexOf('"Microsoft YaHei"')).toBeLessThan(d.indexOf('monospace;'));
    }
  });
});
