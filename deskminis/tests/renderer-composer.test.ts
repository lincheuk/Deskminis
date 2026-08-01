/** MU2b Task 6：空状态任务起点页 + Composer v2——lib/composer 纯模块单测
 *  + EmptyState/ChatView/main/preload 源文本守卫。
 *  main/preload 白名单：本 Task 仅 main 一处 attachments:save handler + preload 一个 saveAttachment 方法。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rowsFor } from '../src/renderer/src/lib/composer/autogrow';
import { attachNote } from '../src/renderer/src/lib/composer/attach';

const root = path.resolve(__dirname, '..');
const emptyState = fs.readFileSync(path.join(root, 'src/renderer/src/components/EmptyState.vue'), 'utf8');
const chatView = fs.readFileSync(path.join(root, 'src/renderer/src/components/ChatView.vue'), 'utf8');
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

describe('MU2b Task 6 Composer v2：lib/composer/attach 纯模块（2 例）', () => {
  it('空数组 → 空串（无尾注）', () => {
    expect(attachNote([])).toBe('');
  });

  it('多路径 → 每行一条 [附件] 前缀尾注', () => {
    expect(attachNote(['attachments/paste-1.png', 'attachments/paste-2.png']))
      .toBe('\n[附件] attachments/paste-1.png\n[附件] attachments/paste-2.png');
  });
});

describe('MU2b Task 6 起点页与 Composer：组件与进程守卫（2 例）', () => {
  it('EmptyState.vue：三示例卡（读代码/写脚本/跑命令）+ 最近任务前 3 + fmtRelative + fill/open 行为；ChatView @fill 接线', () => {
    expect(emptyState).toContain('读代码');
    expect(emptyState).toContain('写脚本');
    expect(emptyState).toContain('跑命令');
    expect(emptyState).toContain('chat.sessions.slice(0, 3)');
    expect(emptyState).toContain('fmtRelative');
    expect(emptyState).toContain("emit('fill'");
    expect(emptyState).toContain('chat.open(');
    expect(chatView).toContain('@fill=');
  });

  it('ChatView/main/preload：autogrow 接线 + paste/drop + 48px chip + 发送键 --action 32px + attachments:save 白名单', () => {
    // textarea 自适应长高：rows 不写死
    expect(chatView).not.toContain('rows="1"');
    expect(chatView).toContain(':rows="rowsFor(input)"');
    // 图片粘贴/拖拽处理器
    expect(chatView).toContain('@paste=');
    expect(chatView).toContain('@drop=');
    // chip 列表：48px + 删除 ×
    expect(chatView).toContain('48px');
    expect(chatView).toContain('class="adel"');
    // 发送键：32px 圆形 --action 实底（var(--label) 黑底退场）
    expect(chatView).toMatch(/\.send\s*\{[^}]*width:\s*32px[^}]*background:\s*var\(--action\)/);
    expect(chatView).not.toMatch(/\.send\s*\{[^}]*background:\s*var\(--label\)\s*;/);
    // main 白名单：仅此一处 handler；preload 暴露 saveAttachment
    expect(mainIdx).toContain("ipcMain.handle('attachments:save'");
    expect(mainIdx).toContain("from './attachments'");
    expect(preload).toContain('saveAttachment');
    expect(preload).toContain("ipcRenderer.invoke('attachments:save'");
  });
});
