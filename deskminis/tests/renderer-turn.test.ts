/** MU2a Task 5：回合结构 + 用户消息标签行（设计 §2.1）守卫 + fmtHHMM 纯模块（6 例）。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fmtHHMM } from '../src/renderer/src/lib/time/hhmm';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const chatView = R('../src/renderer/src/components/ChatView.vue');

describe('MU2a Task 5 fmtHHMM（2 例）', () => {
  it('epoch 秒 → HH:MM（与本地时区手算一致）', () => {
    for (const sec of [0, 1767225600, 1800000000, 86399, 1767225600 + 14 * 3600 + 32 * 60]) {
      const d = new Date(sec * 1000);
      const want = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      expect(fmtHHMM(sec)).toBe(want);
    }
  });

  it('输出恒为两位补零 HH:MM 格式', () => {
    for (const sec of [0, 3599, 36000, 1767225600]) {
      expect(fmtHHMM(sec)).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
  });
});

describe('MU2a Task 5 回合结构守卫（4 例）', () => {
  it('用户消息标签行：「你 · 」锚 + hover 复制钮（uops/title=复制）+ fmtHHMM 接线 + clipboard', () => {
    expect(chatView).toContain('你 ·');
    expect(chatView).toContain('class="uops"');
    expect(chatView).toContain('title="复制"');
    expect(chatView).toContain('fmtHHMM(');
    expect(chatView).toContain('navigator.clipboard.writeText');
  });

  it('用户气泡退场：flex-end / --r-bubble / msg-u 均不再出现', () => {
    expect(chatView).not.toContain('justify-content: flex-end');
    expect(chatView).not.toContain('--r-bubble');
    expect(chatView).not.toContain('msg-u');
  });

  it('回合容器：class="turn" + turns computed + .turn+.turn 分隔线（border-top + --sp-6）', () => {
    expect(chatView).toContain('class="turn"');
    expect(chatView).toContain('turns');
    expect(chatView).toMatch(/\.turn \+ \.turn \{[^}]*border-top[^}]*--sp-6/);
  });

  it('助手区每回合一头：aname 模板仅一处；消息不再直接 v-for chat.messages', () => {
    expect(chatView.split('class="aname"').length - 1).toBe(1);
    expect(chatView).not.toContain('v-for="m in chat.messages"');
  });
});
