/** I2 守卫（改造自 E2 renderer-aurora-shell，AionUi 换向）：平面壳层的源文本断言（6 例）。
 *
 *  背景：E2 曾把 taskbar/rail/wtabs 三处壳层玻璃化（--glass-thin + blur）。I 波按用户
 *  2026-08-20 指令换向 AionUi 平面语言（设计稿 2026-08-20-ui-redo-aionui-design.md §0：
 *  玻璃/极光退场是对 2026-08-10「苹果磨砂」要求的覆盖性偏离，已申报）。本文件把
 *  「平面壳层」钉死：
 *    1. .shell 底保持 background-color 与 background-image 分两属性写——--aurora-ground
 *       槽位保留（取值已全透明），并进简写会把颜色冲掉的坑不因斑退场而消失；
 *    2. 三处壳层实色 --surface-1，App.vue 全文 backdrop-filter 清零；
 *    3. --glass-edge（顶缘内高光）在 App.vue 清零——平面语言无受光边；
 *       --glow-accent（运行点光晕）保留 ≥1——「过程可见」的活动指示不退场；
 *    4. HUD 读数 .tb-text 走等宽 --font-mono（数据语言保留，不随皮换）；
 *    5. 工作台三面板（Progress/Artifacts/Files）玻璃清零：backdrop-filter 与
 *       --glass-thin/--glass-thick/--glass-ground 均为 0——例 8 白名单同步缩容为空集；
 *    6. TerminalPanel 旧 Appica 值不得残留（E2 反向锚原样保留）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const APP = 'src/renderer/src/App.vue';
const PROGRESS = 'src/renderer/src/components/ProgressPanel.vue';
const ARTIFACTS = 'src/renderer/src/components/ArtifactsPanel.vue';
const FILES = 'src/renderer/src/components/FilesPanel.vue';
const TERMINAL = 'src/renderer/src/components/TerminalPanel.vue';

/** 取某个 class 选择器的规则块正文（守的是样式声明本身，不是渲染结果） */
function ruleBlock(src: string, selector: string): string {
  const m = src.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\}`));
  if (!m) throw new Error(`找不到 ${selector} 规则块`);
  return m[1];
}
const count = (src: string, needle: string): number => src.split(needle).length - 1;

describe('I2 平面壳层：源码守卫', () => {
  it('1. .shell 底：background-color 与 background-image 仍分两属性写（--aurora-ground 槽位保留）', () => {
    const b = ruleBlock(read(APP), '.shell');
    expect(b).toContain('background-color: var(--bg)');
    expect(b).toContain('background-image: var(--aurora-ground)');
  });

  it('2. 三处壳层实色：.taskbar/.rail/.wtabs 各含 var(--surface-1)；App.vue backdrop-filter 清零', () => {
    const app = read(APP);
    for (const sel of ['.taskbar', '.rail', '.wtabs']) {
      expect(ruleBlock(app, sel), `${sel} 应含 var(--surface-1)`).toContain('var(--surface-1)');
    }
    expect(count(app, 'backdrop-filter')).toBe(0);
  });

  it('3. App.vue：--glass-edge 清零（受光边退场）；--glow-accent 保留 ≥1（运行点光晕）', () => {
    const app = read(APP);
    expect(count(app, 'var(--glass-edge)')).toBe(0);
    expect(count(app, 'var(--glow-accent)')).toBeGreaterThanOrEqual(1);
  });

  it('4. HUD 读数等宽：.tb-text 块含 var(--font-mono)', () => {
    expect(ruleBlock(read(APP), '.tb-text')).toContain('var(--font-mono)');
  });

  it('5. 工作台三面板玻璃清零：backdrop-filter 与 --glass-thin/thick/ground 均为 0', () => {
    for (const f of [PROGRESS, ARTIFACTS, FILES]) {
      const src = read(f);
      expect(count(src, 'backdrop-filter'), `${f} backdrop-filter 应为 0`).toBe(0);
      for (const t of ['var(--glass-thin)', 'var(--glass-thick)', 'var(--glass-ground)']) {
        expect(count(src, t), `${f} ${t} 应为 0`).toBe(0);
      }
    }
  });

  it('6. TerminalPanel xterm 兜底：旧 Appica 值 #4a5565/#e5e7eb 清零（E2 反向锚保留）', () => {
    const t = read(TERMINAL);
    expect(t).not.toContain('#4a5565');
    expect(t).not.toContain('#e5e7eb');
  });
});
