/** MU2b Task 1 立的分栏守卫，MU5 重锚（计划 §3-1 命门 1）。
 *
 *  为什么是重锚而不是删除：这组守卫的价值是「分栏宽度受控且可拖、面板可切换、宽度可持久化」。
 *  MU5 把可拖边界从右栏左缘移到对话列右缘、区间 [320,480]→[280,520]、默宽 360→336，
 *  **该价值一点没变，变的只是它挂在哪一栏**。删掉等于白丢一组回归保护。
 *
 *  与 mu5-workbench-layout.test.ts 的分工：那边锚「新结构该长什么样」（图标轨/任务条/标签系统/
 *  输入卡片/字体），这边锚「旧契约换栏后仍成立」（边界算术、面板切换、拖拽热区、持久化）。
 *  断言刻意取不同角度，不是复制一份。
 *
 *  MU2b 原文件头保留的说明：双轨 = lib/pane/drag 纯模块单测 + App.vue 源文本守卫
 *  （MU2b 决策 5，不启动浏览器）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clampPaneWidth, nextWidth, PANE_MIN, PANE_MAX } from '../src/renderer/src/lib/pane/drag';

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n');

describe('MU5 重锚 · lib/pane/drag 纯模块（3 例）', () => {
  it('导出的区间常量即契约本身：PANE_MIN/PANE_MAX 与 clamp 行为一致', () => {
    // 常量与行为分开断言：防「改了 clamp 里的字面量却忘了改导出常量」这种半吊子迁移。
    expect(PANE_MIN).toBe(280);
    expect(PANE_MAX).toBe(520);
    expect(clampPaneWidth(PANE_MIN - 1)).toBe(PANE_MIN);
    expect(clampPaneWidth(PANE_MAX + 1)).toBe(PANE_MAX);
  });

  it('clamp 幂等：已在区间内的值再钳制不变，边界值反复钳制稳定', () => {
    for (const v of [280, 336, 400, 520]) {
      expect(clampPaneWidth(clampPaneWidth(v))).toBe(clampPaneWidth(v));
    }
    // 非整数与负数不得穿透（拖拽中 clientX 可能给出小数）
    expect(clampPaneWidth(-1)).toBe(280);
    expect(clampPaneWidth(336.5)).toBe(336.5);
  });

  it('nextWidth 与 clamp 复合：任意起点与位移，结果必在区间内且方向为「右拖增宽」', () => {
    // 方向断言换个角度写：不给具体数字，而是断言单调性——
    // 同一起点下，moveX 越大结果越不小于 moveX 较小时的结果。符号写反则单调性反转。
    const w = (moveX: number): number => nextWidth(1000, 336, moveX);
    expect(w(900)).toBeLessThan(w(1100));
    expect(w(1100)).toBeGreaterThan(w(1000));
    for (const mx of [-5000, 0, 999, 1000, 1001, 5000]) {
      const r = nextWidth(1000, 336, mx);
      expect(r).toBeGreaterThanOrEqual(PANE_MIN);
      expect(r).toBeLessThanOrEqual(PANE_MAX);
    }
  });
});

describe('MU5 重锚 · App.vue 源文本守卫（3 例）', () => {
  it('对话列承担定宽与拖拽：默宽 336px，宽度状态名与持久化键同步换成 chat 语义', () => {
    expect(app).toMatch(/\.pane-chat\s*\{[^}]*width:\s*336px/);
    expect(app).toContain('chatW');
    // 旧的 rightW 语义整体退场，不留半套。锚在**标识符形态**上而非裸子串——
    // 注释里提到旧名（说明换名理由）是有价值的文档，守卫要拦的是「代码里还有旧状态」。
    expect(app).not.toMatch(/\brightW\.value\b/);
    expect(app).not.toMatch(/\b(const|let|ref)\s*\(?\s*rightW\b/);
  });

  it('工作台四种内容仍可切换且懒挂载保活不丢（progress/artifacts/files/terminal 组件全部还在用）', () => {
    // MU2b 的懒挂载 + v-show 保活是已验收行为，换布局不得顺手弄丢。
    for (const c of ['ProgressPanel', 'ArtifactsPanel', 'FilesPanel', 'TerminalPanel']) {
      expect(app).toContain(c);
    }
    expect(app).toContain('visited');
    expect(app).toContain('v-show');
  });

  it('拖拽热区仍在且绑定 mousedown，热区跨骑在对话列右缘（不再是右栏左缘）', () => {
    expect(app).toContain('class="cdrag"');
    expect(app).toContain('@mousedown="startCDrag"');
    // 热区跨骑：绝对定位、不占布局宽度
    expect(app).toMatch(/\.cdrag\s*\{[^}]*position:\s*absolute/);
    expect(app).toMatch(/\.cdrag\s*\{[^}]*cursor:\s*col-resize/);
  });
});
