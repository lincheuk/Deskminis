/** MU2a Task 4：令牌层演进（设计 §3.1/§3.2，决策 7）源文本守卫（8 例）。
 *  红线（MU3 修订，授权见 MU3 计划 §3-1）：MU2a「tokens.css 只追加不改既有值」红线自 MU3 起解除——
 *  Apple HIG 调色板整体退场；新红线：raw 层取值唯一来源是
 *  docs/specs/2026-08-20-aionui-tokens-reference.css（E1/I1 换锚；禁止凭印象写值），别名层映射禁止漂移；
 *  组件禁写死颜色与 color-mix。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const tokens = R('../src/renderer/src/styles/tokens.css');
const chatView = R('../src/renderer/src/ui/StageChat.vue');
const sessionList = R('../src/renderer/src/ui/NavRail.vue');
const mdView = R('../src/renderer/src/components/MarkdownView.vue');
// MU2a Task 8 同步修订：事件条样式从 ChatView 迁入 EventNote.vue，状态槽断言随之迁移
const eventNote = R('../src/renderer/src/ui/EventNotes.vue');

/** 按选择器切片（start 含、end 不含；无 end 或找不到切到文件尾） */
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

/* T6e-3：三例「组件把硬编码尺寸迁到 --fs-* / --state-* 令牌」在此退场。
   它们守的是 **MU2a 那套令牌词汇**，而 T 波换壳时整套设计系统换成了 theme.css 的
   --c-* / --t-* / --sp-*，新组件根本不消费 tokens.css 的语义槽（只剩 MarkdownView
   与 MarkdownInline 还在用，见 T6d）。强行重指等于把新组件拽回旧词汇。
   新词汇的守卫在 tests/theme-contrast.test.ts（含 T6d 加的同名令牌必须同值）。
   下面留下的 5 例断言的是 tokens.css **自身结构**，与组件无关，仍然有效。 */
describe('MU2a Task 4 令牌层演进（5 例）', () => {
  it('§3.1 尺度令牌：:root 一段含全部尺度令牌且全文唯一（主题无关只写一次）', () => {
    for (const t of [
      '--fs-display', '--fs-title', '--fs-body', '--fs-ui', '--fs-caption', '--fs-mono', '--fs-micro',
      '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6', '--sp-8',
      '--ico-s', '--ico-m', '--ico-l', '--h-control', '--h-input',
    ]) {
      expect(rootLight).toContain(`${t}:`);
      expect(tokens.split(`${t}:`).length - 1).toBe(1); // 尺度与主题无关，只写一次
    }
  });

  it('§3.2 语义槽：surface/action/state 四色 + 四色 bg/border color-mix 比例槽', () => {
    for (const t of [
      '--surface-0', '--surface-1', '--surface-2', '--action',
      '--state-ok', '--state-err', '--state-warn', '--state-info',
      '--state-ok-bg', '--state-ok-border', '--state-err-bg', '--state-err-border',
      '--state-warn-bg', '--state-warn-border', '--state-info-bg', '--state-info-border',
    ]) {
      expect(rootLight).toContain(`${t}:`);
    }
  });

  it('语义槽四段各一份：浅 / 媒体暗 / 强制暗 / 强制浅均含 --surface-1 与 --state-warn-bg', () => {
    for (const seg of [rootLight, mediaDark, darkForced, lightForced]) {
      expect(seg).toContain('--surface-1:');
      expect(seg).toContain('--state-warn-bg:');
    }
  });

  it('state 槽直给（MU3 §3-3 命门 3 选 B）：bg/border 改指 Appica subtle/soft，color-mix 比例槽清零', () => {
    expect(rootLight).toContain('--state-warn-bg: var(--warning-subtle)');
    expect(rootLight).toContain('--state-warn-border: var(--warning-soft)');
    // 暗段同色断言删除：Appica subtle/soft 两段同文（直给 10%/20% alpha），四段存在性由上例保证
  });

  it('AionUi 参考值 6 组抽样锚（I1 换锚，与参考文件逐字一致）+ 核心别名映射防漂移', () => {
    // 浅段：文字基色（7 级体系之锚）/ 交互主色轴（--accent/--action 别名目标，Arco 蓝）/ 语义色轴（--green/--state-ok 别名目标）
    expect(rootLight).toContain('--foreground: oklch(0.42 0.032 266.2)');
    expect(rootLight).toContain('--secondary-emphasis: oklch(0.537 0.239 262.8)');
    expect(rootLight).toContain('--success-emphasis: oklch(0.528 0.141 151.3)');
    // 暗段：文字基色 / 纯中性签名底（AionUi 暗色无色相）/ 主色轴暗段（防暗段漂移）
    expect(mediaDark).toContain('--foreground: oklch(0.746 0.022 264.4)');
    expect(mediaDark).toContain('--background: oklch(0.164 0 0)');
    expect(mediaDark).toContain('--secondary-emphasis: oklch(0.696 0.163 254.1)');
    // 别名映射防漂移（brand 轴无锚：--brand/--on-brand 已消亡，由 L79/L81/L83 不存在性断言替代）
    expect(rootLight).toContain('--accent: var(--secondary-emphasis)');
    expect(rootLight).toContain('--green: var(--success-emphasis)');
    expect(rootLight).toContain('--label: var(--foreground-strong)');
    expect(rootLight).toContain('--state-warn-bg: var(--warning-subtle)');
  });



  it('evnote color-mix 迁槽：orange/purple/link 写死比例清零，走 --state-*-bg/border；MarkdownView 字号全令牌化', () => {
    expect(chatView).not.toContain('color-mix(in srgb, var(--orange)');
    expect(chatView).not.toContain('color-mix(in srgb, var(--purple)');
    expect(chatView).not.toContain('color-mix(in srgb, var(--link');
    // T6e-3：事件条的状态槽断言退场——新 ui/EventNotes.vue 走 theme.css 的
    // --c-warn-soft / --c-tips，不再消费 tokens.css 的 --state-*-bg。
    // 「三种语调各有底色」这条意图改锚新词汇，不锚旧槽名。
    expect(eventNote).toMatch(/\.tone-warn[^}]*var\(--c-warn/);
    expect(eventNote).toMatch(/\.tone-err[^}]*var\(--c-err/);
    expect(eventNote).toMatch(/\.tone-info[^}]*var\(--c-/);
    expect(mdView).not.toMatch(/font-size: [\d.]+px/);
    expect(mdView).toContain('--fs-mono');
    expect(mdView).toContain('--fs-micro');
  });
});
