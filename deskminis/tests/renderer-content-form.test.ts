/** 内容区形态守卫（T6e-3 改写，4 例；前身是 I2 的 10 例）。
 *
 *  沿革：原 10 例逐条锚 I2/E2 那套令牌——`--glow-accent` `--glass-edge` `--surface-1`
 *  `--accent` `--r-card` `--secondary-subtle`——钉的是「玻璃拟物退场、平面语言落到位」。
 *  T 波换掉整套设计系统后这些名字在新树里**全部零命中**，逐条重指没有对应物。
 *
 *  其中「受光边 / 玻璃令牌全站清零」那半场已由 `tests/renderer-shell-form.test.ts`
 *  的反向锚统一接管（扫 ui/ 全树）。本文件只留**内容区自己的形态裁定**——
 *  这几条是看着截图一条条定下来的，换个词汇表也依然成立。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const R = (p: string): string => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const stage = R('../src/renderer/src/ui/StageChat.vue');
const steps = R('../src/renderer/src/ui/StepGroup.vue');
const term = R('../src/renderer/src/ui/TerminalPane.vue');

/** 取某个选择器的规则块正文 */
function rule(src: string, sel: string): string {
  const m = src.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
}

describe('内容区形态（4 例）', () => {
  it('用户消息右对齐成块，助手消息平铺满宽', () => {
    // 这是对话的基本节奏：谁说的话看位置就知道，不靠标签行。
    // ⚠️ 这条裁定被改过一次——MU2a 判定用户消息也不进气泡，T 波又改回了右对齐浅底块。
    // 现在钉的是 T 波这一版；再要改是设计的自由，但别让它悄悄漂移。
    expect(rule(stage, '.urow')).toMatch(/align-items:\s*flex-end/);
    expect(stage).toMatch(/class="ubub/);
    // 助手块不给卡片底：满宽文档式，加了底色就又变回聊天气泡了
    expect(rule(stage, '.ablock')).not.toMatch(/background/);
  });

  it('进行中的工具组有活动指示——「过程可见」不退场', () => {
    // 旧实现是工具行左缘一道 --accent 活动线；新实现是整组描边变品牌色。
    // 锚的是**跑着的时候看得出来**，不是某种画法。
    expect(steps).toMatch(/\.grp\.live[^}]*var\(--c-brand/);
    expect(steps).toMatch(/正在执行/);
  });

  it('终端配色跟随主题令牌，硬编码只作读不到时的兜底', () => {
    // 兜底值必须在 || 右边——写反了就是「永远用兜底」，主题切换对终端无效。
    expect(term).toMatch(/v\('--c-bg'\)\s*\|\|/);
    expect(term).toMatch(/v\('--c-ink'\)\s*\|\|/);
  });

  it('旧 Aurora / Appica 的写死色值不许残留在终端兜底里', () => {
    // 反向锚，原例 10 的意图原样保留：换过两轮皮，兜底色最容易被忘在原地。
    for (const dead of ['#1e2532', '#a2adbd', '#d0d6df', '#4a5565', '#e5e7eb']) {
      expect(term, `${dead} 是上一轮皮的残留`).not.toContain(dead);
    }
  });
});
