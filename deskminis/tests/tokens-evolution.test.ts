/** N14a：保留值仍以AionUi参考文件为唯一来源；旧文件内部结构断言按裁定退场。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { MODES, themeTokens, oklchParts } from './theme-token-fixture';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const chatView = R('../src/renderer/src/ui/StageChat.vue');
const mdView = R('../src/renderer/src/components/MarkdownView.vue');
const eventNote = R('../src/renderer/src/ui/EventNotes.vue');
const reference = postcss.parse(R('../../docs/specs/2026-08-20-aionui-tokens-reference.css'));
const source: Record<string, Record<string, string>> = { light: {}, dark: {} };
reference.walkRules(rule => {
  const mode = rule.selector === '.dark' ? 'dark' : rule.selector.includes('.light') ? 'light' : null;
  if (mode) rule.walkDecls(d => { source[mode][d.prop] = d.value; });
});
// 对应旧文件别名链；bg与grouped底色在明暗中原本就有分叉。
const REFERENCE_MAP = [
  ['--bg', '--background-subtle', '--background'],
  ['--label', '--foreground-strong', '--foreground-strong'],
  ['--label-secondary', '--foreground-muted', '--foreground-muted'],
  ['--link', '--secondary-emphasis', '--secondary-emphasis'],
  ['--separator', '--border-strong', '--border-strong'],
  ['--fill-tertiary', '--background-muted', '--background-muted'],
  ['--fill-quaternary', '--background-subtle', '--background-subtle'],
  ['--grouped-bg-secondary', '--background', '--background-muted'],
  // 参考文件本身已把secondary-emphasis加18%/25%透明度，保留其alpha而非转成实色。
  ['--selection-color', '--selection-color', '--selection-color'],
] as const;

describe('MU2a 保留令牌出处与组件纪律（补充14a）', () => {
  it('AionUi 保留值与参考文件对应原始值相同（浅深与强制覆盖）', () => {
    for (const mode of MODES) {
      const dark = mode === 'system-dark' || mode === 'forced-dark', raw = source[dark ? 'dark' : 'light'];
      const actual = themeTokens(mode);
      for (const [name, lightKey, darkKey] of REFERENCE_MAP) expect(oklchParts(actual[name]), `${mode} ${name}`).toEqual(oklchParts(raw[dark ? darkKey : lightKey]));
      const selection = oklchParts(raw['--selection-color']);
      expect(selection).toEqual([...oklchParts(raw['--secondary-emphasis']).slice(0, 3), dark ? .25 : .18]);
    }
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
