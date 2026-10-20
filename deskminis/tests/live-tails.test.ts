/**
 * F06 T 组：LiveTails——每个活动 run 最近一次落库之后已发布的正文与思考（src/minisd/agent/live-tails.ts）。
 */
import { describe, it, expect } from 'vitest';
import { LiveTails } from '../src/minisd/agent/live-tails';
import { EventLog } from '../src/minisd/rpc/event-log';

const RUN = { id: 'RUN-1', generation: 3, epoch: 2 };
const ev = (event: Record<string, unknown>, run: Record<string, unknown> = RUN, sessionId = 'S-1') => ({ sessionId, event, run });
/** 按顺序喂一串事件，seq 从 from 起。 */
function feed(t: LiveTails, events: Record<string, unknown>[], from = 1, run: Record<string, unknown> = RUN, sessionId = 'S-1'): void {
  events.forEach((e, i) => t.observe('chat.event', ev(e, run, sessionId), from + i));
}

describe('F06 T 组：LiveTails', () => {
  it('textDelta / thinkingDelta 分开累积；条目带 run 的 id、会话、generation、epoch 与最近一条事件的 seq', () => {
    const t = new LiveTails();
    feed(t, [{ kind: 'thinkingDelta', text: '想' }, { kind: 'textDelta', text: '甲' }, { kind: 'thinkingDelta', text: '一想' }, { kind: 'textDelta', text: '乙' }], 10);
    expect(t.list()).toEqual([{ runId: 'RUN-1', sessionId: 'S-1', generation: 3, epoch: 2, text: '甲乙', thinking: '想一想', seq: 13 }]);
  });

  it('retry、fallback、messagePersisted 都清空两个缓冲（条目还在）；之后的增量从空开始', () => {
    for (const kind of ['retry', 'fallback', 'messagePersisted']) {
      const t = new LiveTails();
      feed(t, [{ kind: 'textDelta', text: '旧正文' }, { kind: 'thinkingDelta', text: '旧思考' }, { kind }, { kind: 'textDelta', text: '新' }]);
      expect(t.list(), kind).toEqual([{ runId: 'RUN-1', sessionId: 'S-1', generation: 3, epoch: 2, text: '新', thinking: '', seq: 4 }]);
    }
  });

  it('turnEnd / error 删掉这个 run 的条目；别的 run 不受影响', () => {
    const t = new LiveTails();
    feed(t, [{ kind: 'textDelta', text: 'A' }], 1);
    feed(t, [{ kind: 'textDelta', text: 'B' }], 2, { id: 'RUN-2', generation: 1, epoch: 2 }, 'S-2');
    feed(t, [{ kind: 'turnEnd', stopReason: 'endTurn' }], 3);
    expect(t.list().map(x => [x.runId, x.text])).toEqual([['RUN-2', 'B']]);
    feed(t, [{ kind: 'error', message: '已取消' }], 4, { id: 'RUN-2', generation: 1, epoch: 2 }, 'S-2');
    expect(t.list()).toEqual([]);
  });

  it('其它事件（toolStart / toolEnd / capability …）只更新 seq，不动缓冲', () => {
    const t = new LiveTails();
    feed(t, [{ kind: 'textDelta', text: '甲' }, { kind: 'toolStart', toolUseId: 'u', name: 'n', title: 't', input: '{}' }, { kind: 'toolEnd', toolUseId: 'u', success: true, output: 'o' }, { kind: 'capability', label: 'l', notices: [] }]);
    expect(t.list()).toEqual([{ runId: 'RUN-1', sessionId: 'S-1', generation: 3, epoch: 2, text: '甲', thinking: '', seq: 4 }]);
  });

  it('不是 run 事件的帧不看：synced 形态的 chat.event、没有 run 的事件、别的方法', () => {
    const t = new LiveTails();
    t.observe('chat.event', { kind: 'synced', sessionId: 'S-1', mergedCount: 2 }, 1);
    t.observe('chat.event', { sessionId: 'S-1', event: { kind: 'textDelta', text: 'x' } }, 2);
    t.observe('chat.sessions.changed', {}, 3);
    t.observe('permission.request', { requestId: 'R', req: {}, meta: {} }, 4);
    t.observe('chat.event', null, 5);
    expect(t.list()).toEqual([]);
  });

  it('超上限：停止追加并标 truncated；两个缓冲都不再长；重置点到来时连同标记一起清掉', () => {
    const t = new LiveTails(10);
    feed(t, [{ kind: 'textDelta', text: '12345' }, { kind: 'textDelta', text: '67890' }, { kind: 'textDelta', text: 'X' }, { kind: 'thinkingDelta', text: 'T' }]);
    expect(t.list()[0]).toMatchObject({ text: '1234567890', thinking: '', truncated: true, seq: 4 });
    feed(t, [{ kind: 'messagePersisted', messageId: 'M' }, { kind: 'textDelta', text: 'ok' }], 5);
    const after = t.list()[0];
    expect(after).toEqual({ runId: 'RUN-1', sessionId: 'S-1', generation: 3, epoch: 2, text: 'ok', thinking: '', seq: 6 });
    expect('truncated' in after).toBe(false);
  });

  it('list() 的返回值不被后续事件改写：先序列化、再发 50 条事件、再序列化同一个对象，两次逐字相等', () => {
    const t = new LiveTails();
    feed(t, [{ kind: 'textDelta', text: '已发布' }, { kind: 'thinkingDelta', text: '思考' }]);
    const snap = t.list();
    const before = JSON.stringify(snap);
    feed(t, Array.from({ length: 50 }, (_, i) => ({ kind: i % 2 ? 'textDelta' : 'thinkingDelta', text: `后来的${i}` })), 3);
    expect(JSON.stringify(snap)).toBe(before);
    // 新取的一份带上了后来的内容，说明上面比的不是一份空壳
    expect(t.list()[0].text.length).toBeGreaterThan('已发布'.length);
    expect(t.list()).not.toBe(snap);
  });

  it('retain：只留下给定的 run', () => {
    const t = new LiveTails();
    feed(t, [{ kind: 'textDelta', text: 'A' }], 1);
    feed(t, [{ kind: 'textDelta', text: 'B' }], 2, { id: 'RUN-2', generation: 1, epoch: 2 }, 'S-2');
    t.retain(new Set(['RUN-2', 'RUN-9']));
    expect(t.list().map(x => x.runId)).toEqual(['RUN-2']);
    t.retain(new Set());
    expect(t.list()).toEqual([]);
  });

  it('接在 EventLog.onAppend 上：append 返回的那一刻尾巴已经包含这一帧（尾巴 = seq <= lastSeq 的增量的折叠）', () => {
    const t = new LiveTails();
    const log = new EventLog({ epoch: 2, onAppend: (m, p, seq) => t.observe(m, p, seq) });
    log.append('chat.sessions.changed', {});
    for (let i = 0; i < 5; i++) {
      log.append('chat.event', ev({ kind: 'textDelta', text: `‹${i}›` }));
      const tail = t.list()[0];
      expect(tail.seq).toBe(log.lastSeq);
      expect(tail.text).toBe(Array.from({ length: i + 1 }, (_, k) => `‹${k}›`).join(''));
    }
    // 不入序的方法到不了折叠
    log.append('terminal.output', ev({ kind: 'textDelta', text: '不该出现' }));
    expect(t.list()[0].text).not.toContain('不该出现');
  });
});
