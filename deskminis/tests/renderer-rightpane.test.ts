/** MU2b Task 1：右栏骨架（360px 默宽 + 320-480 拖拽 + tab 重排为 进度/产物/文件/终端）。
 *  双轨：lib/pane/drag 纯模块单测 + App.vue 源文本守卫（决策 5，不启动浏览器）。
 *  修订说明：renderer-files-panel/renderer-tasks-panel 的 App.vue 锚在本 Task 内同步修订
 *  （rightTab 'tasks' → 'progress'、visited.tasks → visited.progress，断言语义不变只换名，
 *  Global Constraints 源文本守卫同步修订清单允许）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clampPaneWidth, nextWidth } from '../src/renderer/src/lib/pane/drag';

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8');

describe('MU2b Task 1 右栏骨架：lib/pane/drag 纯模块（3 例）', () => {
  it('clampPaneWidth：<320 → 320；>480 → 480；区间原值', () => {
    expect(clampPaneWidth(0)).toBe(320);
    expect(clampPaneWidth(319)).toBe(320);
    expect(clampPaneWidth(320)).toBe(320);
    expect(clampPaneWidth(360)).toBe(360);
    expect(clampPaneWidth(479)).toBe(479);
    expect(clampPaneWidth(480)).toBe(480);
    expect(clampPaneWidth(481)).toBe(480);
    expect(clampPaneWidth(1200)).toBe(480);
  });

  it('nextWidth：左拖（moveX < startX）增宽，右拖减宽——dx 取反后加在起始宽上', () => {
    expect(nextWidth(1000, 360, 960)).toBe(400); // 左拖 40px → +40
    expect(nextWidth(1000, 360, 1040)).toBe(320); // 右拖 40px → -40 → 320（区间值）
    expect(nextWidth(1000, 360, 1000)).toBe(360); // 未移动
  });

  it('nextWidth 结果恒 clamp 在 [320, 480]', () => {
    expect(nextWidth(1000, 360, 0)).toBe(480); // 左拖 1000 → 1360 → clamp 480
    expect(nextWidth(1000, 480, -500)).toBe(480); // 已在右缘再左拖仍 480
    expect(nextWidth(1000, 360, 2500)).toBe(320); // 右拖 1500 → -1140 → clamp 320
  });
});

describe('MU2b Task 1 右栏骨架：App.vue 源文本守卫（3 例）', () => {
  it('pane-r 默认宽 360px；rightTab 类型四值（progress/artifacts/files/terminal）；默认 tab progress', () => {
    expect(app).toMatch(/\.pane-r\s*\{[^}]*width:\s*360px/);
    expect(app).toContain("rightTab = ref<'progress' | 'artifacts' | 'files' | 'terminal'>('progress')");
    // visited 懒挂载保活四键同步
    expect(app).toContain('visited = reactive({ progress: true, artifacts: false, files: false, terminal: false })');
  });

  it('tab 行四文本 tab（进度/产物/文件/终端）+ gear 暂存锚（Task 5 移除）+ 分隔条 class="rdrag" + mousedown 绑定', () => {
    expect(app).toContain('@click="showTab(\'progress\')">进度');
    expect(app).toContain('@click="showTab(\'artifacts\')">产物');
    expect(app).toContain('@click="showTab(\'files\')">文件');
    expect(app).toContain('@click="showTab(\'terminal\')">终端');
    // gear 暂存（T1 保留，T5 移除时同步删本锚）
    expect(app).toContain('class="tab gear"');
    // 6px 热区分隔条 + 拖拽接线
    expect(app).toContain('class="rdrag"');
    expect(app).toContain('@mousedown="startRDrag"');
  });

  it('宽度持久化：拖拽结束写 localStorage deskminis.rightW；启动读回并 clamp', () => {
    expect(app).toContain("localStorage.setItem('deskminis.rightW', String(rightW.value))");
    expect(app).toContain("localStorage.getItem('deskminis.rightW')");
  });
});
