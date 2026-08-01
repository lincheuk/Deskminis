/** MU2a Task 4：令牌层演进（设计 §3.1/§3.2，决策 7）源文本守卫（8 例）。
 *  红线：tokens.css 只追加不改既有值；组件禁写死颜色与 color-mix 百分比。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const tokens = R('../src/renderer/src/styles/tokens.css');
const chatView = R('../src/renderer/src/components/ChatView.vue');
const sessionList = R('../src/renderer/src/components/SessionList.vue');
const mdView = R('../src/renderer/src/components/MarkdownView.vue');
// MU2a Task 8 同步修订：事件条样式从 ChatView 迁入 EventNote.vue，状态槽断言随之迁移
const eventNote = R('../src/renderer/src/components/EventNote.vue');

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

describe('MU2a Task 4 令牌层演进（8 例）', () => {
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

  it('color-mix 比例槽三模式各调：浅 bg 10% / 暗 bg 12%，border 30%（§3.3-1）', () => {
    expect(rootLight).toContain('--state-warn-bg: color-mix(in srgb, var(--orange) 10%');
    expect(mediaDark).toContain('--state-warn-bg: color-mix(in srgb, var(--orange) 12%');
    expect(rootLight).toContain('--state-warn-border: color-mix(in srgb, var(--orange) 30%');
  });

  it('既有色值不回归（6 组抽样）：浅 accent/brand/green 与暗 accent/brand/green 原值仍在', () => {
    expect(rootLight).toContain('--accent: #3686EE');
    expect(rootLight).toContain('--brand: #B7AF96');
    expect(rootLight).toContain('--green: #34C759');
    expect(mediaDark).toContain('--accent: #5490E4');
    expect(mediaDark).toContain('--brand: #504C42');
    expect(mediaDark).toContain('--green: #30D158');
  });

  it('ChatView 尺度迁移：16.5px 清零；正文 --fs-body；助手名 --fs-title；辅助 13px→--fs-ui', () => {
    expect(chatView).not.toContain('16.5px');
    expect(chatView).toContain('font-size: var(--fs-body)');
    expect(chatView).toMatch(/\.aname \{[^}]*--fs-title/);
    expect(chatView).toContain('font-size: var(--fs-ui)');
  });

  it('SessionList 新建按钮 brand 降权：newbtn 块无 var(--brand)/--on-brand，中性 --fill-tertiary 底', () => {
    const newbtn = section(sessionList, '.newbtn {', '}');
    expect(newbtn).not.toContain('var(--brand)');
    expect(newbtn).toContain('var(--fill-tertiary)');
    expect(sessionList).not.toContain('var(--on-brand)');
  });

  it('evnote color-mix 迁槽：orange/purple/link 写死比例清零，走 --state-*-bg/border；MarkdownView 字号全令牌化', () => {
    expect(chatView).not.toContain('color-mix(in srgb, var(--orange)');
    expect(chatView).not.toContain('color-mix(in srgb, var(--purple)');
    expect(chatView).not.toContain('color-mix(in srgb, var(--link');
    // MU2a Task 8 同步修订：事件条组件化为 EventNote.vue，状态槽消费锚随之从 ChatView 迁到该组件
    expect(eventNote).toContain('var(--state-warn-bg)');
    expect(eventNote).toContain('var(--state-info-bg)');
    expect(mdView).not.toMatch(/font-size: [\d.]+px/);
    expect(mdView).toContain('--fs-mono');
    expect(mdView).toContain('--fs-micro');
  });
});
