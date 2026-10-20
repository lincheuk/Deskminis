/**
 * F06 S 组：共享契约里的纯函数与客户端状态机（src/shared/event-stream.ts）。
 * 不起引擎、不开套接字：帧序列是造的，断言的是「交付给上层的序列」。
 */
import { describe, it, expect } from 'vitest';
import {
  STREAM_HELD_MAX, StreamTracker, coveredBySnapshot, isAttachResult, isEventStamp, judgeFrame,
  type AttachResult, type EventFrame, type StateSnapshot,
} from '../src/shared/event-stream';

const INST = 'INST-A';
const fr = (seq: number, method = 'x.changed', params: unknown = {}, epoch = 1): EventFrame => ({ method, params, ev: { epoch, seq } });
const run = (seq: number, epoch = 1): EventFrame => fr(seq, 'chat.event', { sessionId: 's', event: { kind: 'textDelta', text: `‹${seq}›` }, run: { id: 'r', generation: 1, epoch } }, epoch);
const seqs = (fs: EventFrame[]): number[] => fs.map(f => f.ev.seq);
const head = (lastSeq: number, epoch = 1, instanceId = INST) =>
  ({ protocol: 1 as const, epoch, instanceId, lastSeq, revision: 0, window: { firstSeq: 1, maxEvents: 8192, maxChars: 8_000_000 } });
const snapshotOf = (lastSeq: number, epoch = 1, instanceId = INST): AttachResult => {
  const snapshot: StateSnapshot = { epoch, instanceId, revision: 0, lastSeq, takenAt: 0, sessions: [], runs: [], executions: [], live: [], pendingPermissions: [], artifacts: [] };
  return { ...head(lastSeq, epoch, instanceId), mode: 'snapshot', reason: 'no-cursor', snapshot };
};
const resumeOf = (events: EventFrame[], lastSeq: number, epoch = 1, instanceId = INST): AttachResult =>
  ({ ...head(lastSeq, epoch, instanceId), mode: 'resume', events, runs: [], pendingPermissions: [] });
/** 已经装过一份 lastSeq 的快照、处于放行状态的跟踪器。 */
function liveAt(lastSeq: number): StreamTracker {
  const t = new StreamTracker();
  expect(t.begin({ newConnection: true })).toBeUndefined();
  expect(t.settle(snapshotOf(lastSeq)).accepted).toBe(true);
  expect(t.phase).toBe('live');
  return t;
}

describe('F06 S 组：judgeFrame / coveredBySnapshot / 形状校验', () => {
  it('judgeFrame 四种判定的边界', () => {
    const c = { epoch: 3, lastSeq: 10 };
    expect(judgeFrame(c, { epoch: 3, seq: 11 })).toBe('apply');
    expect(judgeFrame(c, { epoch: 3, seq: 10 })).toBe('duplicate');
    expect(judgeFrame(c, { epoch: 3, seq: 1 })).toBe('duplicate');
    expect(judgeFrame(c, { epoch: 3, seq: 12 })).toBe('gap');
    expect(judgeFrame(c, { epoch: 2, seq: 11 })).toBe('foreign');
    expect(judgeFrame(c, { epoch: 4, seq: 1 })).toBe('foreign');
    // 还没有任何事件时（lastSeq = 0）第一条是 seq 1
    expect(judgeFrame({ epoch: 1, lastSeq: 0 }, { epoch: 1, seq: 1 })).toBe('apply');
    expect(judgeFrame({ epoch: 1, lastSeq: 0 }, { epoch: 1, seq: 2 })).toBe('gap');
  });

  it('coveredBySnapshot：四类覆盖；synced 与其余广播不覆盖', () => {
    expect(coveredBySnapshot('permission.request', { requestId: 'R' })).toBe(true);
    expect(coveredBySnapshot('permission.resolved', { requestId: 'R' })).toBe(true);
    expect(coveredBySnapshot('chat.sessions.changed', {})).toBe(true);
    expect(coveredBySnapshot('chat.event', { sessionId: 's', event: { kind: 'textDelta', text: 'a' }, run: { id: 'r', generation: 1, epoch: 1 } })).toBe(true);
    expect(coveredBySnapshot('chat.event', { kind: 'synced', sessionId: 's', mergedCount: 1 })).toBe(false);
    for (const m of ['assistants.changed', 'skills.changed', 'cron.changed', 'chat.annotations.changed', 'attachments.changed', 'skills.import.progress', 'sync.dirty', 'some.future.broadcast']) {
      expect(coveredBySnapshot(m, {})).toBe(false);
    }
    expect(coveredBySnapshot('chat.event', null)).toBe(false);
  });

  it('isEventStamp / isAttachResult：不合法的形状一律不认', () => {
    expect(isEventStamp({ epoch: 1, seq: 1 })).toBe(true);
    for (const bad of [undefined, null, {}, { epoch: 1 }, { epoch: '1', seq: 1 }, { epoch: 1, seq: 0 }, { epoch: 1, seq: 1.5 }, { epoch: 1, seq: Number.MAX_SAFE_INTEGER + 2 }]) {
      expect(isEventStamp(bad)).toBe(false);
    }
    expect(isAttachResult(snapshotOf(3))).toBe(true);
    expect(isAttachResult(resumeOf([], 3))).toBe(true);
    expect(isAttachResult({ ...snapshotOf(3), protocol: 2 })).toBe(false);
    expect(isAttachResult({ ...resumeOf([], 3), mode: 'other' })).toBe(false);
    expect(isAttachResult({ ...resumeOf([], 3), lastSeq: '3' })).toBe(false);
    expect(isAttachResult({ ...resumeOf([], 3), events: undefined })).toBe(false);
    expect(isAttachResult({ ...snapshotOf(3), snapshot: null })).toBe(false);
    expect(isAttachResult(undefined)).toBe(false);
  });
});

describe('F06 S 组：StreamTracker', () => {
  it('没开启时原样交付；begin 之后到达的帧只进缓冲，没有游标时 begin 返回 undefined（取快照）', () => {
    const t = new StreamTracker();
    expect(t.phase).toBe('off');
    expect(seqs(t.offer(fr(7)).deliver)).toEqual([7]);
    expect(t.begin({ newConnection: true })).toBeUndefined();
    expect(t.phase).toBe('syncing');
    expect(t.offer(fr(4)).deliver).toEqual([]);
    expect(t.offer(fr(5)).deliver).toEqual([]);
    const out = t.settle(snapshotOf(4));
    // 快照水位是 4：缓冲里的 4 被丢（或进 uncovered），5 接在后面
    expect(out.accepted).toBe(true);
    expect(seqs(out.after)).toEqual([5]);
    expect(t.cursor).toEqual({ epoch: 1, instanceId: INST, lastSeq: 5 });
    expect(t.phase).toBe('live');
  });

  it('放行状态：按序应用；重复帧丢弃且只计数；游标不后退', () => {
    const t = liveAt(10);
    expect(seqs(t.offer(fr(11)).deliver)).toEqual([11]);
    expect(t.offer(fr(11)).deliver).toEqual([]);
    expect(t.offer(fr(3)).deliver).toEqual([]);
    expect(seqs(t.offer(fr(12)).deliver)).toEqual([12]);
    expect(t.stats).toMatchObject({ applied: 2, duplicates: 2, gaps: 0, foreign: 0 });
    expect(t.cursor!.lastSeq).toBe(12);
  });

  it('空洞：跳号的那一帧不交付，要求续传；续传补齐后每个 seq 恰好交付一次、升序', () => {
    const t = liveAt(10);
    const r = t.offer(fr(13));
    expect(r).toEqual({ deliver: [], need: 'resume' });
    expect(t.phase).toBe('syncing');
    expect(t.begin({ newConnection: false })).toEqual({ epoch: 1, instanceId: INST, lastSeq: 10 });
    // 续传往返期间又到了 14；晚到的 11 也在这时到
    expect(t.offer(fr(14)).deliver).toEqual([]);
    expect(t.offer(fr(11)).deliver).toEqual([]);
    const out = t.settle(resumeOf([fr(11), fr(12), fr(13)], 13));
    expect(out.accepted).toBe(true);
    expect(seqs(out.replay)).toEqual([11, 12, 13]);
    expect(seqs(out.after)).toEqual([14]);
    expect(out.uncovered).toEqual([]);
    expect(out.missed).toBe(false);
    expect(t.phase).toBe('live');
    expect(t.cursor!.lastSeq).toBe(14);
    expect(t.stats.gaps).toBe(1);
    expect(t.stats.resumes).toBe(1);
    // 缓冲里的 13（触发空洞的那一帧）与 11（晚到的）都已在回放里：算重复，不再交付
    expect(t.stats.duplicates).toBe(2);
  });

  it('续传应答对不上（中间缺帧 / 没走到应答的水位 / 换了代次 / 带着别的代次的帧）：整份不采用，什么都不交付，游标不动，下一轮取快照', () => {
    const cases: AttachResult[] = [
      resumeOf([fr(11), fr(13)], 13),                // 应答里自己有洞
      resumeOf([fr(11), fr(12)], 13),                // 没走到 lastSeq
      resumeOf([fr(11)], 11, 2),                     // 代次变了却回了续传
      resumeOf([fr(11)], 11, 1, 'INST-B'),           // 实例变了
      resumeOf([fr(11), fr(12, 'x', {}, 2)], 12),    // 混进了别的代次的帧
      resumeOf([{ method: 'x', params: {}, ev: undefined as never }], 11), // 帧没有戳
    ];
    for (const r of cases) {
      const t = liveAt(10);
      t.offer(fr(12));
      const cursor = t.begin({ newConnection: false });
      expect(cursor?.lastSeq).toBe(10);
      const out = t.settle(r);
      expect(out).toMatchObject({ accepted: false, replay: [], uncovered: [], after: [], missed: false, need: 'snapshot' });
      expect(t.cursor!.lastSeq).toBe(10);
      expect(t.phase).toBe('syncing');
      // 下一轮不带游标
      expect(t.begin({ newConnection: false })).toBeUndefined();
    }
  });

  it('别的代次的帧：丢弃、清空缓冲、要求取快照；装了新代次的快照之后旧代次的帧仍然不起作用', () => {
    const t = liveAt(10);
    const r = t.offer(fr(1, 'x.changed', {}, 2));
    expect(r).toEqual({ deliver: [], need: 'snapshot' });
    expect(t.stats.foreign).toBe(1);
    expect(t.begin({ newConnection: false })).toBeUndefined();
    t.offer(fr(2, 'x.changed', {}, 2));
    t.offer(fr(11, 'x.changed', {}, 1)); // 旧代次晚到的一帧
    const out = t.settle(snapshotOf(1, 2, 'INST-B'));
    expect(seqs(out.after)).toEqual([2]);
    expect(out.after[0].ev.epoch).toBe(2);
    expect(out.missed).toBe(false); // 换了代次：上层本来就整体刷新
    expect(t.cursor).toEqual({ epoch: 2, instanceId: 'INST-B', lastSeq: 2 });
    expect(t.offer(fr(12, 'x.changed', {}, 1))).toEqual({ deliver: [], need: 'snapshot' });
  });

  it('排空缓冲时遇到空洞：能接上的先交付，剩下的留着并要求再续传一轮', () => {
    const t = new StreamTracker();
    t.begin({ newConnection: true });
    for (const s of [6, 7, 9, 10]) t.offer(fr(s));
    const out = t.settle(snapshotOf(5));
    expect(seqs(out.after)).toEqual([6, 7]);
    expect(out.need).toBe('resume');
    expect(t.phase).toBe('syncing');
    expect(t.begin({ newConnection: false })?.lastSeq).toBe(7);
    const out2 = t.settle(resumeOf([fr(8), fr(9), fr(10), fr(11)], 11));
    expect(seqs(out2.replay)).toEqual([8, 9, 10, 11]);
    expect(out2.after).toEqual([]);
    expect(t.phase).toBe('live');
    expect(t.cursor!.lastSeq).toBe(11);
  });

  it('缓冲上限：超过 STREAM_HELD_MAX 就清空缓冲并改取快照（即使原来有游标）', () => {
    const t = liveAt(10);
    expect(t.offer(fr(12)).need).toBe('resume');
    for (let i = 0; i < STREAM_HELD_MAX + 1; i++) t.offer(fr(13 + i));
    expect(t.begin({ newConnection: false })).toBeUndefined();
    const out = t.settle(snapshotOf(13 + STREAM_HELD_MAX + 5));
    expect(out.accepted).toBe(true);
    // 清空之后到的不多，水位之前的都已被快照盖住
    expect(out.after).toEqual([]);
    expect(t.phase).toBe('live');
    // 清掉「必须取快照」：下一轮又可以带游标
    expect(t.begin({ newConnection: false })?.lastSeq).toBe(13 + STREAM_HELD_MAX + 5);
  });

  it('新连接：旧套接字上扣下的帧不带到新连接的这一轮里', () => {
    const t = liveAt(10);
    expect(t.offer(fr(12)).need).toBe('resume'); // 扣着 12
    expect(t.begin({ newConnection: true })?.lastSeq).toBe(10);
    const out = t.settle(resumeOf([fr(11)], 11));
    // 12 若还在缓冲里，这里会被当成 after 交付——而新连接上它还没到过
    expect(seqs(out.replay)).toEqual([11]);
    expect(out.after).toEqual([]);
    expect(t.cursor!.lastSeq).toBe(11);
  });

  it('forceSnapshot：有游标也不带', () => {
    const t = liveAt(10);
    expect(t.begin({ newConnection: false, forceSnapshot: true })).toBeUndefined();
  });

  it('off()：按到达顺序交还缓冲里的帧，之后原样放行', () => {
    const t = new StreamTracker();
    t.begin({ newConnection: true });
    t.offer(fr(9)); t.offer(fr(3)); t.offer(fr(5));
    expect(seqs(t.off())).toEqual([9, 3, 5]);
    expect(t.phase).toBe('off');
    expect(seqs(t.offer(fr(1)).deliver)).toEqual([1]);
  });

  it('reopen()：同步没取到应答而连接还在——缓冲里接得上的交付，有空洞的要求续传', () => {
    const t = liveAt(10);
    t.begin({ newConnection: false });
    t.offer(fr(11)); t.offer(fr(12));
    const a = t.reopen();
    expect(seqs(a.deliver)).toEqual([11, 12]);
    expect(a.need).toBeUndefined();
    expect(t.phase).toBe('live');

    t.begin({ newConnection: false });
    t.offer(fr(13)); t.offer(fr(15)); t.offer(fr(16));
    const b = t.reopen();
    expect(seqs(b.deliver)).toEqual([13]);
    expect(b.need).toBe('resume');
    expect(t.phase).toBe('syncing');
    const out = (t.begin({ newConnection: false }), t.settle(resumeOf([fr(14), fr(15)], 15)));
    expect(seqs(out.replay)).toEqual([14, 15]);
    expect(seqs(out.after)).toEqual([16]);
  });
});

describe('F06 S 组：快照水位之前的帧（uncovered / missed）', () => {
  it('join：(基线, 水位] 的帧都在缓冲里——没覆盖的按序进 uncovered、覆盖的丢、missed 为假', () => {
    const t = liveAt(10);
    expect(t.begin({ newConnection: false, forceSnapshot: true })).toBeUndefined();
    t.offer(fr(11, 'skills.import.progress', { taskId: 'T', state: 'done' }));
    t.offer(run(12));
    t.offer(fr(13, 'permission.request', { requestId: 'R' }));
    t.offer(fr(14, 'assistants.changed', {}));
    t.offer(fr(15, 'chat.event', { kind: 'synced', sessionId: 's', mergedCount: 2 }));
    t.offer(run(16));
    const out = t.settle(snapshotOf(15));
    expect(out.accepted).toBe(true);
    expect(out.uncovered.map(f => [f.ev.seq, f.method])).toEqual([[11, 'skills.import.progress'], [14, 'assistants.changed'], [15, 'chat.event']]);
    expect(seqs(out.after)).toEqual([16]);
    expect(out.missed).toBe(false);
    expect(t.cursor!.lastSeq).toBe(16);
  });

  it('少一帧：missed 为真（那一帧没到过这条连接，其中快照没覆盖的无从补发）', () => {
    const t = liveAt(10);
    t.begin({ newConnection: false, forceSnapshot: true });
    t.offer(fr(11, 'assistants.changed', {}));
    t.offer(fr(13, 'cron.changed', {})); // 12 没到
    const out = t.settle(snapshotOf(13));
    expect(seqs(out.uncovered)).toEqual([11, 13]);
    expect(out.missed).toBe(true);
  });

  it('基线之前的重复帧不进 uncovered；同一个 seq 到两次只交一次；乱序到达按 seq 升序交', () => {
    const t = liveAt(10);
    t.begin({ newConnection: false, forceSnapshot: true });
    t.offer(fr(9, 'assistants.changed', {}));   // 已应用过的重复帧
    t.offer(fr(12, 'cron.changed', {}));
    t.offer(fr(11, 'assistants.changed', {}));
    t.offer(fr(12, 'cron.changed', {}));        // 同一个 seq 第二次
    const out = t.settle(snapshotOf(12));
    expect(out.uncovered.map(f => [f.ev.seq, f.method])).toEqual([[11, 'assistants.changed'], [12, 'cron.changed']]);
    expect(out.missed).toBe(false);
  });

  it('ended：缓冲里水位之前的 run 终止事件（turnEnd / error）单独交出来，升序、每个 seq 一条；别的 run 事件仍然丢；水位之后的不算', () => {
    const end = (seq: number, kind: 'turnEnd' | 'error', id = 'r'): EventFrame =>
      fr(seq, 'chat.event', { sessionId: 's', event: kind === 'error' ? { kind, code: 'contextFull', message: '满了', relayDraft: '草稿' } : { kind, stopReason: 'maxTokens' }, run: { id, generation: 1, epoch: 1 } });
    const t = liveAt(10);
    t.begin({ newConnection: false, forceSnapshot: true });
    t.offer(run(11));                                   // 正文增量：快照里有它的效果，丢
    t.offer(end(13, 'error', 'r2'));
    t.offer(end(12, 'turnEnd'));                        // 乱序到达
    t.offer(end(12, 'turnEnd'));                        // 同一个 seq 第二次
    t.offer(fr(14, 'permission.resolved', { requestId: 'R' }));
    t.offer(end(16, 'turnEnd', 'r3'));                  // 水位之后：照常进 after
    t.offer(run(15));
    const out = t.settle(snapshotOf(15));
    expect(out.ended.map(f => [f.ev.seq, (f.params as any).event.kind])).toEqual([[12, 'turnEnd'], [13, 'error']]);
    expect((out.ended[1].params as any).event).toMatchObject({ code: 'contextFull', relayDraft: '草稿' });   // 原帧，事件自带的东西都在
    expect(out.uncovered).toEqual([]);                  // 终止事件仍算「已覆盖」，不会在装完快照之后再交一遍
    expect(seqs(out.after)).toEqual([16]);
    expect(out.missed).toBe(false);
    // synced 形态的 chat.event 不是 run 事件
    const u = liveAt(10);
    u.begin({ newConnection: false, forceSnapshot: true });
    u.offer(fr(11, 'chat.event', { kind: 'synced', sessionId: 's', mergedCount: 1 }));
    expect(u.settle(snapshotOf(11)).ended).toEqual([]);
  });

  it('ended 只在原来有同一代次的游标时给：新连接（缓冲清过）、换了代次、首次同步（没有游标）恒为空；续传恒为空', () => {
    const end = (seq: number, epoch = 1): EventFrame => fr(seq, 'chat.event', { sessionId: 's', event: { kind: 'turnEnd' }, run: { id: 'r', generation: 1, epoch } }, epoch);
    // 新连接：旧套接字上扣下的帧不带过来
    const a = liveAt(10);
    a.begin({ newConnection: false, forceSnapshot: true });
    a.offer(end(11));
    a.begin({ newConnection: true, forceSnapshot: true });
    expect(a.settle(snapshotOf(11)).ended).toEqual([]);
    // 换了代次
    const b = liveAt(10);
    b.begin({ newConnection: false, forceSnapshot: true });
    b.offer(end(2, 2));
    expect(b.settle(snapshotOf(5, 2, 'INST-B')).ended).toEqual([]);
    // 首次同步：上层还没有在跟踪的 run，不给
    const c = new StreamTracker();
    c.begin({ newConnection: true });
    c.offer(end(3));
    expect(c.settle(snapshotOf(4)).ended).toEqual([]);
    // 续传：回放本身就带着终止事件
    const d = liveAt(10);
    d.begin({ newConnection: false });
    d.offer(end(11));
    const od = d.settle(resumeOf([end(11)], 11));
    expect([od.accepted, od.ended, seqs(od.replay)]).toEqual([true, [], [11]]);
  });

  it('新连接、换代次、没有基线：missed 恒为假（这几种情形上层本来就整体刷新）；没有基线时缓冲里水位之前没覆盖的帧照样交付', () => {
    // 新连接：缓冲被清过
    const a = liveAt(10);
    a.begin({ newConnection: true, forceSnapshot: true });
    expect(a.settle(snapshotOf(20)).missed).toBe(false);
    // 换代次
    const b = liveAt(10);
    b.begin({ newConnection: false, forceSnapshot: true });
    b.offer(fr(2, 'assistants.changed', {}, 2));
    const ob = b.settle(snapshotOf(5, 2, 'INST-B'));
    expect(ob.missed).toBe(false);
    expect(seqs(ob.uncovered)).toEqual([2]);
    // 没有基线（首次同步）
    const c = new StreamTracker();
    c.begin({ newConnection: true });
    c.offer(fr(3, 'assistants.changed', {}));
    c.offer(run(4));
    const oc = c.settle(snapshotOf(4));
    expect(oc.missed).toBe(false);
    expect(seqs(oc.uncovered)).toEqual([3]);
  });
});

describe('F06 S 组：随机丢 / 重 / 换，交付序列恒等于原序列', () => {
  /** 固定种子的小随机数（mulberry32）。 */
  const rng = (seed: number) => (): number => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('200 组：服务端发 1..N，线上随机丢帧、重复、交换相邻两帧；客户端靠续传补齐——每个 seq 恰好交付一次、严格升序', () => {
    for (let round = 0; round < 200; round++) {
      const rand = rng(round + 1);
      const N = 20 + Math.floor(rand() * 60);
      // 服务端的「保留窗口」：全部帧
      const all = Array.from({ length: N }, (_, i) => fr(i + 1, i % 3 === 0 ? 'assistants.changed' : 'chat.event', i % 3 === 0 ? {} : { sessionId: 's', event: { kind: 'textDelta', text: String(i) } }));
      // 线上实际到达的序列
      const wire: EventFrame[] = [];
      for (let i = 0; i < N; i++) {
        const x = rand();
        if (x < 0.12) continue;                                  // 丢
        if (x < 0.24) { wire.push(all[i], all[i]); continue; }   // 重复
        if (x < 0.36 && i + 1 < N) { wire.push(all[i + 1], all[i]); i++; continue; } // 交换
        wire.push(all[i]);
      }
      const t = new StreamTracker();
      const delivered: number[] = [];
      // 首次同步：水位 0 的快照
      t.begin({ newConnection: true });
      t.settle(snapshotOf(0));
      let sent = 0; // 服务端已经「发生」到第几条（续传的 lastSeq 取它）
      const sync = (): void => {
        for (let guard = 0; guard < 10; guard++) {
          const cursor = t.begin({ newConnection: false });
          // 窗口盖得住、应答是全的：这里不该退到快照
          if (!cursor) throw new Error('不该退到快照');
          const out = t.settle(resumeOf(all.slice(cursor.lastSeq, sent), sent));
          expect(out.accepted).toBe(true);
          for (const f of [...out.replay, ...out.after]) delivered.push(f.ev.seq);
          if (!out.need) return;
        }
        throw new Error('同步没有收敛');
      };
      for (const f of wire) {
        sent = Math.max(sent, f.ev.seq);
        const r = t.offer(f);
        for (const d of r.deliver) delivered.push(d.ev.seq);
        if (r.need) sync();
      }
      // 尾部被丢掉的帧没有后续帧来暴露空洞：静默探测（带游标 attach 一次）补上
      sent = N;
      sync();
      expect(delivered, `第 ${round} 组`).toEqual(Array.from({ length: N }, (_, i) => i + 1));
      expect(t.phase).toBe('live');
    }
  });
});
