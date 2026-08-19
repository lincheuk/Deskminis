/** E2 新守卫：Aurora 壳层材质的源文本断言（6 例）。
 *
 *  背景：E1（3d0c280）落了 Aurora 色板与玻璃令牌（--aurora-ground / --glass-thin /
 *  --glass-edge / --glow-accent），但当时「只定义不消费」。本文件把 E2 的消费面钉死：
 *    1. .shell 极光底必须 background-color 与 background-image 分两属性写——
 *       --aurora-ground 是 image 列表，并进 background 简写会把颜色冲掉；
 *    2. taskbar/rail/wtabs 三处壳层玻璃 = --glass-thin + --glass-blur（设计稿 §5 白名单内，
 *       壳层数量恒定，blur 开销 O(1)）；
 *    3. --glass-edge（玻璃顶缘内高光）与 --glow-accent（运行点光晕）各至少消费一处——
 *       定义了没人用等于没做；
 *    4. HUD 读数 .tb-text 走等宽 --font-mono（任务条读数属「数据语言」，§4）；
 *    5. ArtifactsPanel/FilesPanel 恰好一处玻璃——克制是纪律（§5：blur 面恒定 ≤6）；
 *    6. TerminalPanel xterm 兜底值换算完成后，旧 Appica 值不得残留（反向锚；
 *       正向锚 = tokens-mu3-appica 例 9 白名单三值）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const APP = 'src/renderer/src/App.vue';
const ARTIFACTS = 'src/renderer/src/components/ArtifactsPanel.vue';
const FILES = 'src/renderer/src/components/FilesPanel.vue';
const TERMINAL = 'src/renderer/src/components/TerminalPanel.vue';

/** 取某个 class 选择器的规则块正文（守的是样式声明本身，不是渲染结果） */
function ruleBlock(src: string, selector: string): string {
  const m = src.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\}`));
  if (!m) throw new Error(`找不到 ${selector} 规则块`);
  return m[1];
}

describe('E2 Aurora 壳层：源码守卫', () => {
  it('1. .shell 极光底：background-color 与 background-image 分两属性写（image 列表不能并入 background 简写）', () => {
    const b = ruleBlock(read(APP), '.shell');
    expect(b).toContain('background-color: var(--bg)');
    expect(b).toContain('background-image: var(--aurora-ground)');
  });

  it('2. 三处玻璃壳：.taskbar/.rail/.wtabs 各含 var(--glass-thin) + backdrop-filter: var(--glass-blur)', () => {
    const app = read(APP);
    for (const sel of ['.taskbar', '.rail', '.wtabs']) {
      const b = ruleBlock(app, sel);
      expect(b, `${sel} 应含 var(--glass-thin)`).toContain('var(--glass-thin)');
      expect(b, `${sel} 应含 backdrop-filter: var(--glass-blur)`).toContain('backdrop-filter: var(--glass-blur)');
    }
  });

  it('3. App.vue 消费 --glass-edge（顶缘内高光）与 --glow-accent（运行点光晕）各至少一处', () => {
    const app = read(APP);
    expect(app).toContain('var(--glass-edge)');
    expect(app).toContain('var(--glow-accent)');
  });

  it('4. HUD 读数等宽：.tb-text 块含 var(--font-mono)', () => {
    expect(ruleBlock(read(APP), '.tb-text')).toContain('var(--font-mono)');
  });

  it('5. ArtifactsPanel/FilesPanel 恰好一处玻璃（var(--glass-thin) 与 backdrop-filter 各恰好一次）', () => {
    for (const f of [ARTIFACTS, FILES]) {
      const src = read(f);
      expect(src.split('var(--glass-thin)').length - 1, `${f} var(--glass-thin) 应恰好一处`).toBe(1);
      expect(src.split('backdrop-filter').length - 1, `${f} backdrop-filter 应恰好一处`).toBe(1);
    }
  });

  it('6. TerminalPanel xterm 兜底换算完成：旧 Appica 值 #4a5565/#e5e7eb 清零', () => {
    const t = read(TERMINAL);
    expect(t).not.toContain('#4a5565');
    expect(t).not.toContain('#e5e7eb');
  });
});
