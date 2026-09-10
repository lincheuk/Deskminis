/** MU2b Task 6：空状态任务起点页 + Composer v2——lib/composer 纯模块单测
 *  + EmptyState/ChatView/main/preload 源文本守卫。
 *  main/preload 白名单：本 Task 仅 main 一处 attachments:save handler + preload 一个 saveAttachment 方法。
 *  附件进模型改走 chat.prompt attachments 参数后，attachNote 尾注路径退役——
 *  原 lib/composer/attach 纯模块用例随之移除（锚定的是被替换行为，接棒见 renderer-attachments.test.ts）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rowsFor } from '../src/renderer/src/lib/composer/autogrow';

const root = path.resolve(__dirname, '..');
const emptyState = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageWelcome.vue'), 'utf8');
// T6e-3 重指：输入卡（历史/@文件/自增高/附件）从 ChatView 独立成 ui/Composer.vue。
const chatView = fs.readFileSync(path.join(root, 'src/renderer/src/ui/Composer.vue'), 'utf8');
const mainIdx = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');

describe('MU2b Task 6 Composer v2：lib/composer/autogrow 纯模块（3 例）', () => {
  it('空文本/单行 → 1；多行按 \n 数 +1', () => {
    expect(rowsFor('')).toBe(1);
    expect(rowsFor('hello')).toBe(1);
    expect(rowsFor('a\nb')).toBe(2);
    expect(rowsFor('a\nb\nc\nd')).toBe(4);
    expect(rowsFor('\n\n')).toBe(3); // 两个换行 = 三行
  });

  it('长行按 ~48 半角字折估（超一行宽度折多行）', () => {
    expect(rowsFor('x'.repeat(48))).toBe(1);
    expect(rowsFor('x'.repeat(49))).toBe(2);
    expect(rowsFor('x'.repeat(97))).toBe(3);
    expect(rowsFor('短行\n' + 'y'.repeat(100))).toBe(1 + 3); // 首行 1 + 次行折 3
  });

  it('clamp 1..maxRows（默认 8；自定义 maxRows 生效）', () => {
    expect(rowsFor(Array.from({ length: 20 }, (_, i) => String(i)).join('\n'))).toBe(8);
    expect(rowsFor('a\nb\nc\nd\ne', 3)).toBe(3);
    expect(rowsFor('a\nb', 3)).toBe(2);
  });
});

describe('MU2b Task 6 起点页与 Composer：组件与进程守卫（2 例）', () => {
  it('StageWelcome：开场提示 + 最近会话 + fmtRelative 接线', () => {
    // 「读代码 / 写脚本 / 跑命令」三张固定示例卡退场：新欢迎页的开场提示来自
    // **选中助手自带的 prompts**（「试试这些开场」区），不再是三条写死的。
    // 保留的意图是——空手进来的人有东西可点、最近会话摸得到、时间是人话。
    expect(emptyState).toMatch(/试试这些开场|prompts/);
    expect(emptyState).toMatch(/fmtRelative/);
    expect(emptyState).toMatch(/recent/);
  });

  it('ChatView/main/preload：autogrow 接线 + paste/drop + 48px chip + 发送键 --c-brand 32px + attachments:save 白名单', () => {
    // textarea 自适应长高：rows 不写死
    expect(chatView).not.toContain('rows="1"');
    expect(chatView).toMatch(/:rows="rowsFor\(/);  // 变量名从 input 改成 text，绑定形态不变
    // 图片粘贴/拖拽处理器
    expect(chatView).toContain('@paste=');
    expect(chatView).toContain('@drop=');
    // chip 列表：缩略图是正方定尺 + 删除 ×。尺寸从 48 调到 56（新输入卡更宽），
    // 断言改锚「定尺且宽高一致」，不锚那个具体数字——版式微调不该让守卫红。
    const att = chatView.match(/\.att \{[^}]*\}/)?.[0] ?? '';
    expect(att).toMatch(/width:\s*(\d+)px/);
    expect(att.match(/width:\s*(\d+)px/)![1]).toBe(att.match(/height:\s*(\d+)px/)![1]);
    expect(chatView).toMatch(/class="ax"/);  // 草稿附件删除钮改名 adel → ax
    // 发送键：32px 圆形 --c-brand 实底（var(--label) 黑底退场）
    // 发送钮改名 .send → .go；锚「主操作用品牌色实底」，不锚像素尺寸
    expect(chatView).toMatch(/\.go\s*\{[^}]*var\(--c-brand\)/);
    expect(chatView).not.toMatch(/\.go\s*\{[^}]*var\(--label\)/);
    // main 白名单：仅此一处 handler；preload 暴露 saveAttachment
    expect(mainIdx).toContain("ipcMain.handle('attachments:save'");
    expect(mainIdx).toContain("from './attachments'");
    expect(preload).toContain('saveAttachment');
    expect(preload).toContain("ipcRenderer.invoke('attachments:save'");
  });
});
