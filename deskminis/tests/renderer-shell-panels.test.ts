/**
 * V4-V5 · 终端与任务面板的新壳落位守卫。
 *
 * T 波换壳后这两块整个不可达：终端是一整条能力（长驻 shell 的实况），
 * 任务面板是「这一轮到底怎么了」的唯一去处（上下文水位 / 降级 / 压缩 / 卸载）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '../src/renderer/src/ui/');
const read = (p: string): string => readFileSync(join(UI, p), 'utf8').replace(/\r\n/g, '\n');

describe('V4 — 终端', () => {
  const shell = read('AppShell.vue');
  it('终端面板存在且挂在外壳里，有开关', () => {
    expect(existsSync(join(UI, 'TerminalPane.vue'))).toBe(true);
    expect(shell).toContain("import TerminalPane from './TerminalPane.vue'");
    expect(read('TopBar.vue')).toContain('toggle-term');
  });
  it('挂载时序：先订阅推送再 attach，缝隙里的输出进缓冲不丢', () => {
    const t = read('TerminalPane.vue');
    expect(t).toContain("rpc.on('terminal.output'");
    expect(t).toContain("terminal.attach");
    expect(t).toMatch(/pending/);
  });
  it('主题跟新令牌走（--c-*），不是旧令牌名', () => {
    const t = read('TerminalPane.vue');
    expect(t).toContain("'--c-bg'");
    expect(t).not.toMatch(/getPropertyValue\(['"]--label['"]\)/);
  });
});

describe('V5 — 任务面板', () => {
  const ws = read('WorkspacePanel.vue');
  it('工作区面板多一个「任务」tab', () => {
    expect(ws).toContain("'tasks'");
    expect(existsSync(join(UI, 'TaskPanel.vue'))).toBe(true);
    expect(ws).toContain("import TaskPanel from './TaskPanel.vue'");
  });
  it('上下文水位 + 四类回合状态都有去处', () => {
    const t = read('TaskPanel.vue');
    expect(t).toContain('contextInfo');
    expect(t).toContain('fetchContextInfo');
    for (const k of ['fallbackState', 'compactedState', 'offloadedState', 'pendingPerms']) {
      expect(t).toContain(k);
    }
  });
});

describe('V5b — 改动清单单一数据源', () => {
  it('改动 tab 走 collectArtifacts 纯模块，不自己再扫一遍 messages', () => {
    // 同一份数据两处各写一遍必然两处不一致；且手写那版拿不到实时 toolCards
    const ws = read('WorkspacePanel.vue');
    expect(ws).toContain('collectArtifacts(chat.messages, chat.toolCards)');
    expect(ws).not.toContain("p?.type !== 'toolUse'");
  });
});

describe('V5c — 内部枚举不许漏给用户', () => {
  it('StopReason 四值都有中文文案（实拍逮到过 endTurn 原样上屏）', () => {
    const shared = readFileSync(join(__dirname, '../src/shared/types.ts'), 'utf8');
    const line = /export type StopReason = ([^;]+);/.exec(shared)?.[1] ?? '';
    const vals = [...line.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
    expect(vals.length).toBe(4);
    const t = read('TaskPanel.vue');
    for (const v of vals) expect(t).toContain(`${v}:`);
  });
});
