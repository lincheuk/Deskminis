/** MU2a Task 6：工具行 ToolLine（设计 §2.2）守卫 + group/duration 纯模块（10 例）。
 *  守卫工具：源文本读取统一归一化 CRLF→LF（项目记忆）。 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { groupToolCards, isGroup } from '../src/renderer/src/lib/toolline/group';
import { fmtDuration } from '../src/renderer/src/lib/toolline/duration';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const toolLine = R('../src/renderer/src/components/ToolLine.vue');
const chatView = R('../src/renderer/src/components/ChatView.vue');

const c = (name: string, id: string) => ({ toolUseId: id, name, title: `${name} 标题` });

describe('MU2a Task 6 groupToolCards（5 例）', () => {
  it('空数组 → 空数组', () => {
    expect(groupToolCards([])).toEqual([]);
  });

  it('不足 3 个连续同名不成组（原样保留）', () => {
    const cards = [c('file_read', '1'), c('file_read', '2'), c('shell_execute', '3')];
    const out = groupToolCards(cards);
    expect(out).toHaveLength(3);
    expect(out.every(x => !isGroup(x))).toBe(true);
  });

  it('连续 ≥3 个同名成组：kind/name/count/items 保序保引用', () => {
    const cards = [c('file_read', '1'), c('file_read', '2'), c('file_read', '3'), c('file_read', '4')];
    const out = groupToolCards(cards);
    expect(out).toHaveLength(1);
    const g = out[0];
    expect(isGroup(g)).toBe(true);
    if (isGroup(g)) {
      expect(g.name).toBe('file_read');
      expect(g.count).toBe(4);
      expect(g.items).toHaveLength(4);
      expect(g.items[0]).toBe(cards[0]);
      expect(g.items[3]).toBe(cards[3]);
    }
  });

  it('组边界被异名打断：多组并存 + 落单原样保留', () => {
    const cards = [
      c('file_read', '1'), c('file_read', '2'), c('file_read', '3'), // 组 A
      c('shell_execute', '4'),                                       // 落单
      c('file_edit', '5'), c('file_edit', '6'), c('file_edit', '7'),   // 组 B
      c('memory', '8'), c('memory', '9'),                              // 不足 3 同名，落单 ×2
    ];
    const out = groupToolCards(cards);
    expect(out).toHaveLength(5);
    expect(isGroup(out[0]) && out[0].name === 'file_read' && out[0].count === 3).toBe(true);
    expect(!isGroup(out[1]) && out[1].toolUseId === '4').toBe(true);
    expect(isGroup(out[2]) && out[2].name === 'file_edit' && out[2].count === 3).toBe(true);
    expect(!isGroup(out[3]) && out[3].toolUseId === '8').toBe(true);
    expect(!isGroup(out[4]) && out[4].toolUseId === '9').toBe(true);
  });

  it('isGroup 类型守卫：组为 true、单卡为 false', () => {
    const out = groupToolCards([c('a', '1'), c('a', '2'), c('a', '3'), c('b', '4')]);
    expect(isGroup(out[0])).toBe(true);
    expect(isGroup(out[1])).toBe(false);
  });
});

describe('MU2a Task 6 fmtDuration（2 例）', () => {
  it('秒级：<60s 一位小数（0.3s / 11.5s / 59.9s）', () => {
    expect(fmtDuration(0, 300)).toBe('0.3s');
    expect(fmtDuration(1000, 12500)).toBe('11.5s');
    expect(fmtDuration(0, 59949)).toBe('59.9s');
  });

  it('分钟级：≥60s 改 XmYYs；负差钳 0', () => {
    expect(fmtDuration(0, 60000)).toBe('1m00s');
    expect(fmtDuration(0, 62000)).toBe('1m02s');
    expect(fmtDuration(0, 600000)).toBe('10m00s');
    expect(fmtDuration(500, 100)).toBe('0.0s');
  });
});

describe('MU2a Task 6 ToolLine 守卫（3 例）', () => {
  it('ToolLine.vue：props 契约 + 单行 32px（--h-control）+ 三态符号 + chevron + 展开区 240px 内滚 + spinner', () => {
    expect(toolLine).toContain("state?: 'running' | 'ok' | 'fail'");
    expect(toolLine).toContain('duration?: string');
    expect(toolLine).toContain('height: var(--h-control)');
    expect(toolLine).toContain('✓');
    expect(toolLine).toContain('✕');
    expect(toolLine).toContain('class="spin"'); // 执行中 14px CSS 圆环（shimmer 取消，§2.2）
    expect(toolLine).toContain('chevron-right');
    expect(toolLine).toContain('chevron-down');
    expect(toolLine).toContain('max-height: 240px');
    expect(toolLine).toContain('font-family: var(--font-mono)'); // 展开区 mono
  });

  it('类型色五色退役：ToolLine/ChatView 均无 --tool- 引用', () => {
    expect(toolLine).not.toContain('--tool-');
    expect(chatView).not.toContain('--tool-');
  });

  it('ChatView 接线：ToolLine import + groupToolCards( 调用点；ToolPill 组件已删除', () => {
    expect(chatView).toContain("import ToolLine from './ToolLine.vue'");
    expect(chatView).toContain('groupToolCards(');
    expect(chatView).not.toContain('ToolPill');
    expect(existsSync(resolve(__dirname, '../src/renderer/src/components/ToolPill.vue'))).toBe(false);
  });
});
