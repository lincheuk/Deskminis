/**
 * F06 L 组：EventLog——序号、保留窗口、续传取帧的边界（src/minisd/rpc/event-log.ts）。
 */
import { describe, it, expect } from 'vitest';
import { EVENT_RETAIN_MAX_CHARS, EVENT_RETAIN_MAX_EVENTS, EventLog } from '../src/minisd/rpc/event-log';

const seqsOf = (r: ReturnType<EventLog['since']>): number[] | string => (typeof r === 'string' ? r : r.map(f => f.ev.seq));

describe('F06 L 组：EventLog', () => {
  it('seq 从 1 起逐条加一；帧 = 原来的通知帧加一个顶层 ev，params 原样', () => {
    const log = new EventLog({ epoch: 7 });
    expect(log.lastSeq).toBe(0);
    expect(log.firstSeq).toBe(1);
    const frames = [log.append('a.changed', { x: 1 }), log.append('chat.event', { sessionId: 's', event: { kind: 'textDelta', text: '你好' } }), log.append('b.changed', {})];
    expect(frames.map(f => JSON.parse(f!))).toEqual([
      { jsonrpc: '2.0', method: 'a.changed', params: { x: 1 }, ev: { epoch: 7, seq: 1 } },
      { jsonrpc: '2.0', method: 'chat.event', params: { sessionId: 's', event: { kind: 'textDelta', text: '你好' } }, ev: { epoch: 7, seq: 2 } },
      { jsonrpc: '2.0', method: 'b.changed', params: {}, ev: { epoch: 7, seq: 3 } },
    ]);
    // 去掉 ev 之后与以前的帧逐字相同（顶层键的顺序也不变）
    expect(frames[0]).toBe(JSON.stringify({ jsonrpc: '2.0', method: 'a.changed', params: { x: 1 } }).replace(/\}$/, ',"ev":{"epoch":7,"seq":1}}'));
    expect(log.lastSeq).toBe(3);
    expect(log.firstSeq).toBe(1);
    expect(log.epoch).toBe(7);
    expect(log.limits).toEqual({ maxEvents: EVENT_RETAIN_MAX_EVENTS, maxChars: EVENT_RETAIN_MAX_CHARS });
  });

  it('terminal.output 不入序：返回 undefined、不占号、不进窗口；可以另指定不入序的方法', () => {
    const log = new EventLog({ epoch: 1 });
    log.append('a', {});
    expect(log.append('terminal.output', { sessionId: 's', data: 'x' })).toBeUndefined();
    expect(log.lastSeq).toBe(1);
    expect(JSON.parse(log.append('b', {})!).ev.seq).toBe(2);
    expect(seqsOf(log.since(0))).toEqual([1, 2]);
    const custom = new EventLog({ epoch: 1, unsequenced: ['noisy'] });
    expect(custom.append('noisy', {})).toBeUndefined();
    expect(JSON.parse(custom.append('terminal.output', {})!).ev.seq).toBe(1);
  });

  it('序列化失败原样抛出，不占号、不留空洞', () => {
    const log = new EventLog({ epoch: 1 });
    log.append('a', {});
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => log.append('bad', loop)).toThrow();
    expect(() => log.append('bad', { n: 10n })).toThrow();
    expect(log.lastSeq).toBe(1);
    expect(JSON.parse(log.append('b', {})!).ev.seq).toBe(2);
    expect(seqsOf(log.since(0))).toEqual([1, 2]);
  });

  it('onAppend：在序号分配之后同步调用，拿到的 seq 与帧一致；抛错不影响帧与序号，只告警一次', () => {
    const seen: [string, unknown, number][] = [];
    /** 回调运行那一刻的 lastSeq 与窗口里已有的帧数（回调里的断言会被 EventLog 兜住，所以记下来在外面比）。 */
    const at: { lastSeq: number; retained: number }[] = [];
    const warns: string[] = [];
    let boom = false;
    const log: EventLog = new EventLog({
      epoch: 1, warn: m => { warns.push(m); },
      onAppend: (m, p, seq) => {
        seen.push([m, p, seq]);
        at.push({ lastSeq: log.lastSeq, retained: log.lastSeq - log.firstSeq + 1 });
        if (boom) throw new Error('折叠出错');
      },
    });
    log.append('a', { v: 1 });
    boom = true;
    const f2 = log.append('b', { v: 2 });
    const f3 = log.append('c', { v: 3 });
    expect(seen).toEqual([['a', { v: 1 }, 1], ['b', { v: 2 }, 2], ['c', { v: 3 }, 3]]);
    // 序号已经分配（lastSeq 就是这一帧），帧还没入窗口
    expect(at.map(x => x.lastSeq)).toEqual([1, 2, 3]);
    expect(JSON.parse(f2!).ev.seq).toBe(2);
    expect(JSON.parse(f3!).ev.seq).toBe(3);
    expect(seqsOf(log.since(0))).toEqual([1, 2, 3]);
    expect(warns).toHaveLength(1);
    // 不入序的方法不调回调
    log.append('terminal.output', {});
    expect(seen).toHaveLength(3);
  });

  it('按条数淘汰：只留最近 maxEvents 条；since 的边界——等于 lastSeq、firstSeq - 1、firstSeq - 2', () => {
    const log = new EventLog({ epoch: 1, maxEvents: 4 });
    for (let i = 1; i <= 10; i++) log.append('e', { i });
    expect(log.lastSeq).toBe(10);
    expect(log.firstSeq).toBe(7);
    expect(seqsOf(log.since(10))).toEqual([]);
    expect(seqsOf(log.since(9))).toEqual([10]);
    // 游标恰好是窗口第一条的前一条：一帧不缺，走续传
    expect(seqsOf(log.since(6))).toEqual([7, 8, 9, 10]);
    // 再小一：第 6 条已经不在了
    expect(log.since(5)).toBe('expired');
    expect(log.since(0)).toBe('expired');
    // 取出来的是新解析的对象，params 完整
    const got = log.since(8);
    expect(got).toEqual([{ method: 'e', params: { i: 9 }, ev: { epoch: 1, seq: 9 } }, { method: 'e', params: { i: 10 }, ev: { epoch: 1, seq: 10 } }]);
    expect(log.since(8)).not.toBe(got);
  });

  it('按字符数淘汰：帧长之和不超过 maxChars；刚入窗口的那一帧不淘汰（单帧超上限时窗口里只剩它）', () => {
    const one = new EventLog({ epoch: 1 }).append('e', { t: 'xxxxxxxxxx' })!.length;
    const log = new EventLog({ epoch: 1, maxChars: one * 3 });
    for (let i = 0; i < 9; i++) log.append('e', { t: 'xxxxxxxxxx' });
    // 第 9 帧的 seq 是一位数，帧长相同：恰好留 3 条
    expect(log.firstSeq).toBe(7);
    expect(seqsOf(log.since(6))).toEqual([7, 8, 9]);
    const big = log.append('e', { t: 'y'.repeat(one * 10) });
    expect(big!.length).toBeGreaterThan(one * 3);
    expect(log.firstSeq).toBe(10);
    expect(log.lastSeq).toBe(10);
    expect(seqsOf(log.since(9))).toEqual([10]);
    expect(log.since(8)).toBe('expired');
    // 之后的小帧进来，大帧被挤出去
    log.append('e', { t: 'z' });
    expect(log.firstSeq).toBe(11);
  });

  it('since 的字符数上限：(afterSeq, lastSeq] 的帧长之和超过 maxChars 返回 too-large，恰好等于时照给', () => {
    const log = new EventLog({ epoch: 1 });
    const lens = [1, 2, 3, 4].map(i => log.append('e', { i })!.length);
    const sum = lens.reduce((a, b) => a + b, 0);
    expect(seqsOf(log.since(0, sum))).toEqual([1, 2, 3, 4]);
    expect(log.since(0, sum - 1)).toBe('too-large');
    expect(seqsOf(log.since(2, lens[2] + lens[3]))).toEqual([3, 4]);
    expect(log.since(2, lens[2] + lens[3] - 1)).toBe('too-large');
    // 空区间不受上限影响
    expect(seqsOf(log.since(4, 0))).toEqual([]);
  });

  it('被淘汰的帧当场放掉：内部数组里全部帧的字符数之和始终不超过字符上限（大帧占多数时不滞留在堆里）', () => {
    // 淘汰只挪 head、攒够 1024 条才整体截掉：帧字符串不在淘汰那一刻放掉的话，窗口里只有几条大帧时，
    // 被淘汰的上千条大帧还被数组引用着（缺省上限下实测到上限的几十倍）
    const maxChars = 100_000;
    const log = new EventLog({ epoch: 1, maxChars });
    const items = (): { seq: number; frame: string }[] => (log as unknown as { items: { seq: number; frame: string }[] }).items;
    const held = (): number => items().reduce((n, x) => n + x.frame.length, 0);
    const big = 'x'.repeat(20_000);
    let peak = 0; let peakSlots = 0;
    for (let i = 1; i <= 1500; i++) {
      // 大帧（toolEnd 带完整输出）之间夹几条小帧
      log.append('chat.event', { sessionId: 's', event: { kind: 'toolEnd', toolUseId: `t${i}`, output: big } });
      if (i % 3 === 0) log.append('chat.event', { sessionId: 's', event: { kind: 'textDelta', text: '字' } });
      peak = Math.max(peak, held());
      peakSlots = Math.max(peakSlots, items().length);
    }
    expect(peak).toBeLessThanOrEqual(maxChars);
    expect(peakSlots).toBeGreaterThan(1000);                      // 确实攒过上千个还没截掉的位置：它们都是空壳
    // 窗口本身不受影响：留着的帧内容完整，续传取得到
    const first = log.firstSeq;
    expect(log.lastSeq - first + 1).toBeGreaterThanOrEqual(4);
    const got = log.since(first - 1) as { params: { event: { kind: string; output?: string } } }[];
    expect(got).toHaveLength(log.lastSeq - first + 1);
    expect(got.filter(f => f.params.event.kind === 'toolEnd').every(f => f.params.event.output === big)).toBe(true);
    expect(log.since(first - 2)).toBe('expired');
  });

  it('大量入队出队之后序号与取帧仍然正确（窗口内部的整理不丢帧）', () => {
    const log = new EventLog({ epoch: 3, maxEvents: 16 });
    for (let i = 1; i <= 5000; i++) {
      log.append('e', { i });
      if (i % 977 === 0) {
        expect(log.firstSeq).toBe(i - 15);
        const got = log.since(i - 16);
        expect(seqsOf(got)).toEqual(Array.from({ length: 16 }, (_, k) => i - 15 + k));
        expect((got as { params: { i: number } }[]).map(f => f.params.i)).toEqual(Array.from({ length: 16 }, (_, k) => i - 15 + k));
        expect(log.since(i - 17)).toBe('expired');
      }
    }
  });
});
