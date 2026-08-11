/** 键盘可达守卫（用户 2026-08-11：「重新全部检测一遍 UI 点击功能是否可用」的产出）。
 *
 *  背景：`npm run audit:clicks` 的静态盘点发现 **17 处 `<div @click>` 没有 tabindex**——
 *  鼠标能点、Tab 键到不了。这是 MU3 就记在 backlog 的老账（当时 9 处，一路长到 17 处），
 *  因为没有守卫拦着，每加一个 div 型控件就多欠一笔。
 *
 *  本文件把规则钉死：**凡是带 @click 的非原生控件元素，必须自带键盘通路**
 *  （tabindex + Enter/Space），否则测试红。
 *
 *  为什么不干脆全改成 <button>：`.scard` 内部已经嵌了 `<button class="smore">`，
 *  button 套 button 是非法 HTML 且交互会坏；`.mrow`/`.sitem` 同理有嵌套风险。
 *  故统一用 tabindex + role + keydown，形态一致、零 DOM 结构变动。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const COMPONENTS = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'components');
const vueFiles = fs.readdirSync(COMPONENTS).filter(f => f.endsWith('.vue'));

/** 只取 <template> 段；行尾归一化（仓库强制 LF，Windows 检出仍可能带 CRLF）。 */
function template(file: string): string {
  const src = fs.readFileSync(path.join(COMPONENTS, file), 'utf8').replace(/\r\n/g, '\n');
  const m = src.match(/<template>([\s\S]*)<\/template>/);
  return m ? m[1] : src;
}

/** 带 @click 的 div/span/li 开标签。原生可聚焦元素（button/a/input/label）不在此列。 */
const CLICKABLE = /<(div|span|li)\b([^>]*@click[^>]*)>/g;

describe('键盘可达：div 型控件必须能用 Tab + Enter/Space 操作', () => {
  it('每个 <div @click> 都带 tabindex 与 Enter/Space 处理（@click.stop 的冒泡拦截层除外）', () => {
    const offenders: string[] = [];
    for (const f of vueFiles) {
      const tpl = template(f);
      for (const m of tpl.matchAll(CLICKABLE)) {
        const attrs = m[1] === 'div' ? m[2] : m[2];
        // 两类不是「控件」的 @click，给它们 tabindex 只会多出没用的空焦点位：
        // ① @click.stop 且无别的 @click —— 纯冒泡拦截层（.wrap / .menubar）；
        // ② @click.self —— 模态遮罩「点空白处关闭」。它的键盘等价物是 Esc 与标题行的 X 钮，
        //    两者都已具备（见 SettingsModal / DevicesModal 的 .xbtn 与 Escape 监听）。
        const onlyStop = /@click\.stop(?!=)/.test(attrs) && !/@click(?:\.\w+)*="/.test(attrs);
        const isBackdrop = /@click\.self=/.test(attrs) && /class="mask"/.test(attrs);
        if (onlyStop || isBackdrop) continue;
        const hasTab = /tabindex=/.test(attrs);
        const hasKey = /@keydown\.enter/.test(attrs) && /@keydown\.space/.test(attrs);
        if (!hasTab || !hasKey) {
          const line = tpl.slice(0, m.index).split('\n').length;
          offenders.push(`${f}:${line} ${!hasTab ? '缺 tabindex' : ''}${!hasKey ? ' 缺 Enter/Space' : ''}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('空格键必须 .prevent——否则按空格会滚动页面而不是激活控件', () => {
    const offenders: string[] = [];
    for (const f of vueFiles) {
      for (const m of template(f).matchAll(/@keydown\.space([^=\s]*)=/g)) {
        if (!m[1].includes('.prevent')) offenders.push(`${f}: @keydown.space${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('已补的控件带语义 role（读屏要知道这是按钮/选项/标签页，不是一块 div）', () => {
    // 抽查四个代表：会话行、设置导航、选项行、标题栏菜单项
    const cases: [string, string][] = [
      ['SessionList.vue', 'scard'],
      ['SettingsModal.vue', 'sitem'],
      ['PermissionPicker.vue', 'mrow'],
      ['TitleBar.vue', 'mi'],
    ];
    for (const [file, cls] of cases) {
      const tpl = template(file);
      const i = tpl.indexOf(`class="${cls}"`);
      expect(i, `${file} 找不到 .${cls}`).toBeGreaterThan(-1);
      // 开标签范围内应出现 role=
      const start = tpl.lastIndexOf('<', i);
      const end = tpl.indexOf('>', i);
      expect(tpl.slice(start, end), `${file} .${cls} 缺 role`).toMatch(/role="/);
    }
  });
});
