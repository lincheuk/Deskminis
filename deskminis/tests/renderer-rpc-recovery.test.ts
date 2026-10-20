/**
 * F06 C 组：渲染端 RpcClient 的续传与重连（设计 §4.8）。假套接字 + 注入的定时器与时钟：
 * 每一步由用例推进（开套接字、回应答、推帧、拨时钟），不靠真实时间。
 *
 * 钉的行为：
 *  - 按 seq 去重、跳号走带游标的 attach、别的代次走不带游标的 attach、同步期间扣帧、快照之后按水位放行；
 *  - join 的快照不吞水位之前没覆盖的帧；没凑齐时报 missed；
 *  - 断线：在途调用以原文案拒绝并带「在途」标记，重连后**一帧都不重发**；新连接上的第一帧是 state.attach；
 *  - 闸先开、再交付：回放帧的处理器里发起的调用在新套接字上发得出去；应答对不上的那一轮闸不开；
 *  - 落定保证：断线时在跑与排队的 resync() 都被拒，重连后不补跑；
 *  - 每次重连都重新向主进程要端口与 token；alive:false 立即终态；退避有上限，用尽后进入终态，retryNow 重新开始；
 *  - 旧套接字晚到的帧、应答、关闭都不起作用；
 *  - 静默探测（idle / poll）；
 *  - 不开恢复时与以前相同。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RpcClient, RECONNECT_POLICY, isInFlightLoss, reconnectDelayMs, type LinkStatus, type RecoveryHooks, type ReconnectPolicy, type SyncInfo } from '../src/renderer/src/rpc';
import { STREAM_HELD_MAX, type EventFrame } from '../src/shared/event-stream';

const LOST = '与后台服务的连接已断开';

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  static get last(): FakeWebSocket { return FakeWebSocket.all[FakeWebSocket.all.length - 1]; }
  sent: string[] = [];
  opened = false;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeWebSocket.all.push(this); }
  send(data: string): void {
    if (!this.opened) throw new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
    this.sent.push(data);
  }
  /** 浏览器里 close() 之后 close 事件会到；这里当场回调，顺带验证「主动关掉的套接字的 close 不再触发断线流程」。 */
  close(): void { if (this.closed) return; this.closed = true; this.onclose?.({}); }
  open(): void { this.opened = true; this.onopen?.(); }
  /** 对端掐断。 */
  drop(): void { this.closed = true; this.onclose?.({}); }
  frames(): any[] { return this.sent.map(s => JSON.parse(s)); }
  attaches(): any[] { return this.frames().filter(f => f.method === 'state.attach'); }
  reply(id: number, result: unknown): void { this.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) }); }
  fail(id: number, message: string): void { this.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) }); }
  push(f: EventFrame): void { this.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', method: f.method, params: f.params, ev: f.ev }) }); }
}

/** 微任务排空（不碰真实定时器）。 */
const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function fakeClock() {
  let now = 1000; let ids = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    api: {
      set: (fn: () => void, ms: number): unknown => { const id = ++ids; timers.set(id, { at: now + ms, fn }); return id; },
      clear: (h: unknown): void => { timers.delete(h as number); },
    },
    /** 往前拨 ms：到点的定时器按时间先后触发，每触发一个排空一次微任务。 */
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => timers.size,
  };
}

const head = (o: { epoch?: number; instanceId?: string; lastSeq: number; revision?: number }) => ({
  protocol: 1, epoch: o.epoch ?? 1, instanceId: o.instanceId ?? 'I1', lastSeq: o.lastSeq, revision: o.revision ?? 0,
  window: { firstSeq: 1, maxEvents: 8192, maxChars: 8_000_000 },
});
const snapshotOf = (o: { epoch?: number; instanceId?: string; lastSeq: number; revision?: number; reason?: string }) => ({
  ...head(o), mode: 'snapshot', reason: o.reason ?? 'no-cursor',
  snapshot: { epoch: o.epoch ?? 1, instanceId: o.instanceId ?? 'I1', revision: o.revision ?? 0, lastSeq: o.lastSeq, takenAt: 0,
    sessions: [], runs: [], executions: [], live: [], pendingPermissions: [], artifacts: [] },
});
const resumeOf = (o: { epoch?: number; instanceId?: string; lastSeq: number; events: EventFrame[] }) => ({ ...head(o), mode: 'resume', events: o.events, runs: [], pendingPermissions: [] });
const frame = (seq: number, method = 'x.evt', params: unknown = { n: seq }, epoch = 1): EventFrame => ({ method, params, ev: { epoch, seq } });

const g = globalThis as any;
let savedWs: unknown; let savedWindow: unknown;
/** 主进程的 minisd:info：每次调用记一笔，返回值由用例改。 */
let info: { calls: number; next: () => Promise<any> };
beforeEach(() => {
  savedWs = g.WebSocket; savedWindow = g.window;
  g.WebSocket = FakeWebSocket;
  FakeWebSocket.all = [];
  info = { calls: 0, next: async () => ({ port: 1234, token: `T${info.calls}`, alive: true }) };
  g.window = { deskminis: { minisdInfo: () => { info.calls += 1; return info.next(); } } };
});
afterEach(() => { g.WebSocket = savedWs; g.window = savedWindow; vi.useRealTimers(); });

const TEST_POLICY: ReconnectPolicy = { delaysMs: [100, 200, 400], jitter: 0, connectTimeoutMs: 1000, attachTimeoutMs: 1000, probeIdleMs: 0, startPollMs: 50 };

interface Rig {
  c: RpcClient; clock: ReturnType<typeof fakeClock>; ws: FakeWebSocket;
  /** 钩子与处理器的调用顺序。 */
  log: string[]; statuses: LinkStatus[]; syncs: SyncInfo[]; lost: string[];
  /** 在 x.evt 上登记一个把 seq 记进 log 的处理器。 */
  watch(method?: string): void;
}

async function rig(o: { hooks?: Partial<RecoveryHooks>; policy?: Partial<ReconnectPolicy> } = {}): Promise<Rig> {
  const clock = fakeClock();
  const log: string[] = []; const statuses: LinkStatus[] = []; const syncs: SyncInfo[] = []; const lost: string[] = [];
  const c = new RpcClient();
  c.onLost(r => { lost.push(r); log.push('onLost'); });
  c.enableRecovery({
    attachParams: () => ({ sessionId: 'S' }),
    applySnapshot: (s, i) => { log.push(`snapshot@${s.lastSeq}:${i.reason}:${i.cause}:${i.epochChanged ? 'epoch-changed' : 'same-epoch'}`); },
    resumed: (r, i) => { log.push(`resumed@${r.lastSeq}:${i.cause}`); },
    synced: i => { syncs.push(i); log.push(`synced:${i.via}:${i.cause}`); },
    status: s => { statuses.push(s); log.push(`status:${s.state}${s.state === 'reconnecting' ? `#${s.attempt}` : ''}`); },
    ...o.hooks,
  }, { policy: { ...TEST_POLICY, ...o.policy }, timers: clock.api, now: clock.now, rand: () => 0.5 });
  const connecting = c.connect();
  await flush();
  const ws = FakeWebSocket.last;
  ws.open();
  await connecting;
  return { c, clock, ws, log, statuses, syncs, lost, watch: (method = 'x.evt') => c.on(method, (p, ev) => { log.push(`${method}#${ev?.seq}`); void p; }) };
}

/** 首次同步：取一份水位为 lastSeq 的快照。 */
async function initial(r: Rig, lastSeq = 5): Promise<void> {
  const p = r.c.resync('initial');
  await flush();
  const req = r.ws.attaches().at(-1);
  r.ws.reply(req.id, snapshotOf({ lastSeq }));
  await p;
  r.log.length = 0; r.syncs.length = 0;
}

/** 掐断当前套接字、拨到第一次重连尝试、让新套接字连上；返回新套接字（state.attach 已发出，还没应答）。 */
async function reconnectTo(r: Rig): Promise<FakeWebSocket> {
  const before = FakeWebSocket.all.length;
  FakeWebSocket.last.drop();
  await flush();
  await r.clock.advance(100);
  expect(FakeWebSocket.all.length).toBe(before + 1);
  const ws = FakeWebSocket.last;
  ws.open();
  await flush();
  return ws;
}

describe('F06 C 组 · 去重、空洞、别的代次、同步期间扣帧', () => {
  it('重复帧只分发一次；按序的帧各一次', async () => {
    const r = await rig(); await initial(r, 5); r.watch();
    r.ws.push(frame(6)); r.ws.push(frame(6)); r.ws.push(frame(7)); r.ws.push(frame(5)); r.ws.push(frame(7));
    expect(r.log).toEqual(['x.evt#6', 'x.evt#7']);
    expect(r.ws.attaches()).toHaveLength(1); // 只有首次同步那一次
  });

  it('N+2 先到：发起带游标的 attach，补齐之后三帧按序各分发一次', async () => {
    const r = await rig(); await initial(r, 5); r.watch();
    r.ws.push(frame(7));
    await flush();
    expect(r.log).toEqual([]); // 跳号的那一帧先扣着
    const req = r.ws.attaches().at(-1);
    expect(req.params.resume).toEqual({ epoch: 1, instanceId: 'I1', lastSeq: 5 });
    r.ws.push(frame(8)); // 应答之前又到一帧
    r.ws.reply(req.id, resumeOf({ lastSeq: 7, events: [frame(6), frame(7)] }));
    await flush();
    expect(r.log).toEqual(['x.evt#6', 'x.evt#7', 'resumed@7:gap', 'x.evt#8', 'synced:resume:gap']);
    expect(r.syncs[0].inDoubt).toEqual([]);
  });

  it('别的代次的帧：丢掉，并发起不带游标的 attach（取快照）；快照的 epochChanged 为真', async () => {
    const r = await rig(); await initial(r, 5); r.watch();
    r.ws.push(frame(1, 'x.evt', {}, 2));
    await flush();
    const req = r.ws.attaches().at(-1);
    expect(req.params.resume).toBeUndefined();
    r.ws.reply(req.id, snapshotOf({ epoch: 2, instanceId: 'I2', lastSeq: 1, reason: 'no-cursor' }));
    await flush();
    expect(r.log).toEqual(['snapshot@1:no-cursor:foreign:epoch-changed', 'synced:snapshot:foreign']);
    expect(r.syncs[0].epochChanged).toBe(true);
  });

  it('attach 期间到达的帧在 applySnapshot 之后才放行；水位之前、快照已覆盖的帧丢弃', async () => {
    const r = await rig(); r.watch(); r.watch('permission.request');
    const p = r.c.resync('initial');
    await flush();
    const req = r.ws.attaches().at(-1);
    // 应答之前到了四帧：两帧在水位之前（一帧快照已覆盖、一帧没覆盖），两帧在水位之后
    r.ws.push(frame(9, 'permission.request', { requestId: 'R' }));
    r.ws.push(frame(10));
    r.ws.push(frame(11));
    r.ws.push(frame(12));
    expect(r.log).toEqual([]);
    r.ws.reply(req.id, snapshotOf({ lastSeq: 10 }));
    await p;
    expect(r.log).toEqual(['snapshot@10:no-cursor:initial:same-epoch', 'x.evt#10', 'x.evt#11', 'x.evt#12', 'synced:snapshot:initial']);
  });

  it('同步期间缓冲溢出：之后的那一轮改取快照（不带游标）', async () => {
    const r = await rig(); await initial(r, 5);
    r.ws.push(frame(7)); // 空洞 → 带游标的 attach 在途
    await flush();
    const first = r.ws.attaches().at(-1);
    expect(first.params.resume.lastSeq).toBe(5);
    for (let i = 0; i < STREAM_HELD_MAX; i++) r.ws.push(frame(8 + i));
    r.ws.reply(first.id, resumeOf({ lastSeq: 7, events: [frame(6), frame(7)] }));
    await flush();
    // 被清掉的帧补不回来：下一帧到达时是空洞，这一轮必须取快照
    r.ws.push(frame(8 + STREAM_HELD_MAX));
    await flush();
    const second = r.ws.attaches().at(-1);
    expect(second.id).not.toBe(first.id);
    expect(second.params.resume).toBeUndefined();
  });

  it('游标已被挤出保留窗口：带游标去要，引擎回快照（window-expired），按快照重建', async () => {
    const r = await rig(); await initial(r, 5);
    const ws2 = await reconnectTo(r);
    const req = ws2.attaches().at(-1);
    expect(req.params.resume).toEqual({ epoch: 1, instanceId: 'I1', lastSeq: 5 });
    ws2.reply(req.id, snapshotOf({ lastSeq: 500, reason: 'window-expired' }));
    await flush();
    expect(r.log).toContain('snapshot@500:window-expired:reconnect:same-epoch');
    expect(r.syncs.at(-1)).toMatchObject({ via: 'snapshot', cause: 'reconnect', epochChanged: false });
  });
});

// 变异检查补的：设计 §4.8 第 7 步「有 need → 再来一轮；第 3 轮起强制快照；满 5 轮仍对不齐 → 按失败处理」。
// 去掉「第 3 轮起强制快照」、或去掉轮数上限，原有用例全绿——没有一条用例让一轮同步走到第 3 次 attach
describe('F06 C 组 · 一轮同步里补洞补不齐', () => {
  it('前两次带游标续传，每次补完缓冲里又有新的空洞：第 3 次不带游标取快照；水位之前没到过的帧报 missed；每个 seq 至多分发一次、升序', async () => {
    const r = await rig(); await initial(r, 5); r.watch();
    r.ws.push(frame(7));                                         // 跳号 → 第 1 次 attach
    await flush();
    const a1 = r.ws.attaches().at(-1);
    expect(a1.params.resume).toEqual({ epoch: 1, instanceId: 'I1', lastSeq: 5 });
    r.ws.push(frame(9));                                         // 应答之前又到一帧，和这次的水位之间隔着 8
    r.ws.reply(a1.id, resumeOf({ lastSeq: 7, events: [frame(6), frame(7)] }));
    await flush();
    const a2 = r.ws.attaches().at(-1);
    expect(a2.id).not.toBe(a1.id);
    expect(a2.params.resume).toEqual({ epoch: 1, instanceId: 'I1', lastSeq: 7 }); // 第 2 次仍带游标
    r.ws.push(frame(11));                                        // 又隔着 10
    r.ws.reply(a2.id, resumeOf({ lastSeq: 9, events: [frame(8), frame(9)] }));
    await flush();
    const a3 = r.ws.attaches().at(-1);
    expect(a3.id).not.toBe(a2.id);
    expect(a3.params.resume).toBeUndefined();                    // 第 3 次起不再带游标
    expect(r.syncs).toEqual([]);                                 // 这一轮还没完
    r.ws.reply(a3.id, snapshotOf({ lastSeq: 11 }));
    await flush();
    expect(r.ws.attaches()).toHaveLength(4);                     // 首次同步 1 次 + 这一轮 3 次，之后不再要
    expect(r.log).toEqual([
      'x.evt#6', 'x.evt#7', 'resumed@7:gap', 'x.evt#8', 'x.evt#9', 'resumed@9:gap',
      'snapshot@11:no-cursor:gap:same-epoch', 'x.evt#11', 'synced:snapshot:gap',
    ]);
    // 10 从没到过这条连接、快照又不覆盖它：上层据 missed 整体刷新
    expect(r.syncs).toHaveLength(1);
    expect(r.syncs[0]).toMatchObject({ via: 'snapshot', cause: 'gap', missed: true, inDoubt: [] });
    r.ws.push(frame(12));
    expect(r.log.at(-1)).toBe('x.evt#12');                       // 回到放行状态
  });

  it('每次补完都还有空洞：满 5 次 attach 仍对不齐按失败处理——没有第 6 次，这条套接字被关、进入重连，synced 没调', async () => {
    const r = await rig(); await initial(r, 5); r.watch();
    r.ws.push(frame(7));
    await flush();
    let top = 7;
    for (let round = 1; round <= 5; round++) {
      expect(r.ws.attaches(), `第 ${round} 次`).toHaveLength(1 + round);
      const req = r.ws.attaches().at(-1);
      expect(req.params.resume === undefined, `第 ${round} 次带不带游标`).toBe(round >= 3);
      top += 2;
      r.ws.push(frame(top));                                     // 这一次的水位是 top - 2，缓冲里的这一帧和它之间隔着一帧
      r.ws.reply(req.id, round <= 2 ? resumeOf({ lastSeq: top - 2, events: [frame(top - 3), frame(top - 2)] }) : snapshotOf({ lastSeq: top - 2 }));
      await flush();
    }
    expect(r.ws.attaches()).toHaveLength(6);                     // 首次同步 1 次 + 5 次；没有第 6 次
    expect(r.ws.closed).toBe(true);
    expect(r.statuses.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 1 });
    expect(r.syncs).toEqual([]);
    expect(r.lost).toEqual([]);                                  // 是重连，不是终态
  });
});

describe('F06 C 组 · join 的快照不吞水位之前没覆盖的帧', () => {
  it('attach 往返期间到达的导入进度终态帧：applySnapshot 之后、after 之前分发恰一次；同样位置的 permission.request 不分发', async () => {
    const r = await rig(); await initial(r, 5);
    r.watch('skills.import.progress'); r.watch('permission.request'); r.watch('chat.event'); r.watch();
    const p = r.c.resync('join');
    await flush();
    const req = r.ws.attaches().at(-1);
    expect(req.params.resume).toBeUndefined(); // join 取快照
    r.ws.push(frame(6, 'skills.import.progress', { taskId: 't', state: 'done' }));
    r.ws.push(frame(7, 'permission.request', { requestId: 'R' }));
    r.ws.push(frame(8, 'chat.event', { sessionId: 'S', event: { kind: 'textDelta', text: 'x' }, run: { id: 'r', generation: 1, epoch: 1 } }));
    r.ws.push(frame(9));
    r.ws.reply(req.id, snapshotOf({ lastSeq: 8 }));
    await p;
    expect(r.log).toEqual(['snapshot@8:no-cursor:join:same-epoch', 'skills.import.progress#6', 'x.evt#9', 'synced:snapshot:join']);
    expect(r.syncs[0].missed).toBe(false);
  });

  it('attach 往返期间到达的 run 终止事件：在 applySnapshot 之前分发恰一次，处理器里发起的调用发得出去；同样位置的别的 run 事件不分发', async () => {
    const r = await rig(); await initial(r, 5);
    const runOf = { id: 'r', generation: 1, epoch: 1 };
    r.watch();
    const reads: Promise<unknown>[] = [];
    r.c.on('chat.event', (p, ev) => {
      r.log.push(`chat.event#${ev?.seq}:${p.event.kind}`);
      // 终止事件的处理器会重取历史：join 走的是完好的连接，这次调用要发得出去
      reads.push(r.c.call('chat.messages.list', { sessionId: p.sessionId }).then(v => v, e => e));
    });
    const p = r.c.resync('join');
    await flush();
    const req = r.ws.attaches().at(-1);
    r.ws.push(frame(6, 'chat.event', { sessionId: 'S', event: { kind: 'textDelta', text: 'x' }, run: runOf }));
    r.ws.push(frame(7, 'chat.event', { sessionId: 'S', event: { kind: 'error', code: 'contextFull', message: '满了', relayDraft: '草稿' }, run: runOf }));
    r.ws.push(frame(8));
    r.ws.push(frame(9));
    expect(r.log).toEqual([]);
    r.ws.reply(req.id, snapshotOf({ lastSeq: 8 }));
    await p;
    expect(r.log).toEqual(['chat.event#7:error', 'snapshot@8:no-cursor:join:same-epoch', 'x.evt#8', 'x.evt#9', 'synced:snapshot:join']);
    expect(r.syncs[0].missed).toBe(false);
    await flush();
    const sent = r.ws.frames().filter(f => f.method === 'chat.messages.list');
    expect(sent).toHaveLength(1);
    r.ws.reply(sent[0].id, ['历史']);
    await expect(reads[0]).resolves.toEqual(['历史']);
  });

  it('首次同步、重连后的新连接上扣下的终止事件不先交付（上层没有在跟踪的 run / 缓冲与旧游标没有先后关系）：由快照里那次 run 的终态去收口', async () => {
    const end = (seq: number) => frame(seq, 'chat.event', { sessionId: 'S', event: { kind: 'turnEnd', stopReason: 'endTurn' }, run: { id: 'r', generation: 1, epoch: 1 } });
    const a = await rig(); a.watch('chat.event');
    const p = a.c.resync('initial');
    await flush();
    a.ws.push(end(3));
    a.ws.reply(a.ws.attaches().at(-1).id, snapshotOf({ lastSeq: 5 }));
    await p;
    expect(a.log).toEqual(['snapshot@5:no-cursor:initial:same-epoch', 'synced:snapshot:initial']);

    const b = await rig(); await initial(b, 5); b.watch('chat.event');
    const ws2 = await reconnectTo(b);
    ws2.push(end(6));
    ws2.reply(ws2.attaches().at(-1).id, snapshotOf({ lastSeq: 6, reason: 'window-expired' }));
    await flush();
    expect(b.log.filter(x => x.startsWith('chat.event'))).toEqual([]);
    expect(b.log).toContain('snapshot@6:window-expired:reconnect:same-epoch');
  });

  it('那一帧在到达之前丢了：synced 的 missed 为真（上层据此整体刷新）', async () => {
    const r = await rig(); await initial(r, 5);
    r.watch('skills.import.progress');
    const p = r.c.resync('join');
    await flush();
    const req = r.ws.attaches().at(-1);
    r.ws.push(frame(7, 'permission.request', { requestId: 'R' }));
    r.ws.push(frame(8));
    r.ws.reply(req.id, snapshotOf({ lastSeq: 8 }));
    await p;
    expect(r.log.filter(x => x.startsWith('skills.import.progress'))).toEqual([]);
    expect(r.syncs[0].missed).toBe(true);
  });
});

describe('F06 C 组 · 断线：在途调用不重发', () => {
  it('两个在途调用以原文案拒绝并带在途标记；重连期间的新调用当场拒绝、不带标记；重连后新套接字上没有任何断线前在途的帧', async () => {
    const r = await rig(); await initial(r, 5);
    const prompt = r.c.call('chat.prompt', { sessionId: 'S', text: 'hi', promptId: 'p-1' });
    const respond = r.c.call('permission.respond', { requestId: 'R', decision: 'allow-once' });
    const read = r.c.call('chat.sessions.list');
    await flush();
    const inFlightIds = r.ws.frames().filter(f => f.method !== 'state.attach').map(f => f.id);
    expect(inFlightIds).toHaveLength(3);

    r.ws.drop();
    const errs = await Promise.all([prompt, respond, read].map(p => p.then(() => undefined, e => e as Error)));
    for (const e of errs) { expect(e?.message).toBe(LOST); expect(isInFlightLoss(e)).toBe(true); }
    expect(r.statuses.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 1, maxAttempts: 3, retryInMs: 100 });

    // 重连期间：新调用立即拒绝，没有发出去，所以不带在途标记
    const during = await r.c.call('chat.prompt', { sessionId: 'S', text: 'again' }).then(() => undefined, e => e as Error);
    expect(during?.message).toBe(LOST);
    expect(isInFlightLoss(during)).toBe(false);
    await expect(r.c.resync('join')).rejects.toThrow(LOST);

    await r.clock.advance(100);
    const ws2 = FakeWebSocket.last;
    expect(ws2).not.toBe(r.ws);
    ws2.open();
    await flush();
    const req = ws2.attaches().at(-1);
    ws2.reply(req.id, resumeOf({ lastSeq: 5, events: [] }));
    await flush();

    // 新套接字上：第一帧是 state.attach；断线前在途的 id 一个都没有再出现；没有 chat.prompt / permission.respond
    const frames = ws2.frames();
    expect(frames[0].method).toBe('state.attach');
    expect(frames.filter(f => inFlightIds.includes(f.id))).toEqual([]);
    expect(frames.map(f => f.method).filter(m => m === 'chat.prompt' || m === 'permission.respond')).toEqual([]);
    // 在途的调用原样交给上层核对（方法与参数），只交一次
    expect(r.syncs.at(-1)!.inDoubt).toEqual([
      { method: 'chat.prompt', params: { sessionId: 'S', text: 'hi', promptId: 'p-1' } },
      { method: 'permission.respond', params: { requestId: 'R', decision: 'allow-once' } },
      { method: 'chat.sessions.list', params: undefined },
    ]);
    // 之后的调用恢复可用
    const ok = r.c.call('chat.sessions.list');
    await flush();
    const sent = ws2.frames().at(-1);
    expect(sent.method).toBe('chat.sessions.list');
    ws2.reply(sent.id, ['ok']);
    await expect(ok).resolves.toEqual(['ok']);
  });

  it('旧套接字晚到的通知、应答、关闭都不起作用', async () => {
    const r = await rig(); await initial(r, 5); r.watch();
    const ws1 = r.ws;
    const ws2 = await reconnectTo(r);
    ws2.reply(ws2.attaches().at(-1).id, resumeOf({ lastSeq: 5, events: [] }));
    await flush();
    r.log.length = 0;
    const call = r.c.call('chat.sessions.list');
    await flush();
    const id = ws2.frames().at(-1).id;
    let settled = false;
    void call.then(() => { settled = true; }, () => { settled = true; });

    ws1.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', method: 'x.evt', params: {}, ev: { epoch: 1, seq: 6 } }) });
    ws1.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', id, result: ['来自旧连接'] }) });
    ws1.onclose!({});
    await flush();
    expect(r.log).toEqual([]);          // 通知没进处理器，也没有新的状态变化
    expect(settled).toBe(false);        // 旧连接上的应答结不了新连接上的调用
    ws2.push(frame(6));                 // 新连接上同一个 seq 照常应用（旧连接那帧没有推进游标）
    expect(r.log).toEqual(['x.evt#6']);
    ws2.reply(id, ['来自新连接']);
    await expect(call).resolves.toEqual(['来自新连接']);
  });
});

describe('F06 C 组 · 闸先开、再交付', () => {
  it('续传：回放的两帧各发起一次调用，都在新套接字上发出并得到应答；status(open) 先于第一帧回放，synced 恰一次且在最后', async () => {
    const r = await rig(); await initial(r, 5);
    const reads: Promise<unknown>[] = [];
    r.c.on('x.evt', (_p, ev) => { r.log.push(`x.evt#${ev?.seq}`); reads.push(r.c.call('x.read', { for: ev?.seq })); });
    const ws2 = await reconnectTo(r);
    r.log.length = 0;
    ws2.reply(ws2.attaches().at(-1).id, resumeOf({ lastSeq: 7, events: [frame(6), frame(7)] }));
    await flush();
    expect(r.log).toEqual(['status:open', 'x.evt#6', 'x.evt#7', 'resumed@7:reconnect', 'synced:resume:reconnect']);
    const sent = ws2.frames().filter(f => f.method === 'x.read');
    expect(sent.map(f => f.params)).toEqual([{ for: 6 }, { for: 7 }]);
    for (const f of sent) ws2.reply(f.id, `ok-${f.params.for}`);
    await expect(Promise.all(reads)).resolves.toEqual(['ok-6', 'ok-7']);
  });

  it('快照：水位之后的帧在 applySnapshot 之后分发，处理器里的调用同样发得出去', async () => {
    const r = await rig(); await initial(r, 5);
    const reads: Promise<unknown>[] = [];
    r.c.on('x.evt', (_p, ev) => { r.log.push(`x.evt#${ev?.seq}`); reads.push(r.c.call('x.read', { for: ev?.seq })); });
    const ws2 = await reconnectTo(r);
    r.log.length = 0;
    ws2.push(frame(3, 'x.evt', {}, 2)); // 新代次：应答之前到了一帧水位之后的
    ws2.reply(ws2.attaches().at(-1).id, snapshotOf({ epoch: 2, instanceId: 'I2', lastSeq: 2, reason: 'epoch-changed' }));
    await flush();
    expect(r.log).toEqual(['status:open', 'snapshot@2:epoch-changed:reconnect:epoch-changed', 'x.evt#3', 'synced:snapshot:reconnect']);
    const sent = ws2.frames().filter(f => f.method === 'x.read');
    expect(sent).toHaveLength(1);
    ws2.reply(sent[0].id, 'ok');
    await expect(reads[0]).resolves.toBe('ok');
  });

  it('续传应答对不上（回放里有洞）：这一轮闸不开、什么都不分发；下一轮不带游标取快照，装好之后才开闸', async () => {
    const r = await rig(); await initial(r, 5); r.watch();
    const ws2 = await reconnectTo(r);
    r.log.length = 0;
    ws2.reply(ws2.attaches().at(-1).id, resumeOf({ lastSeq: 8, events: [frame(6), frame(8)] }));
    await flush();
    expect(r.log).toEqual([]); // 没有 status:open，没有任何分发
    await expect(r.c.call('chat.sessions.list')).rejects.toThrow(LOST);
    const second = ws2.attaches().at(-1);
    expect(ws2.attaches()).toHaveLength(2);
    expect(second.params.resume).toBeUndefined();
    ws2.reply(second.id, snapshotOf({ lastSeq: 8 }));
    await flush();
    expect(r.log).toEqual(['status:open', 'snapshot@8:no-cursor:reconnect:same-epoch', 'synced:snapshot:reconnect']);
  });
});

describe('F06 C 组 · 落定保证', () => {
  it('join 在跑、另一个 join 排队时掐线：两个 promise 都以 LOST 拒绝；重连后新套接字上只有一次 state.attach', async () => {
    const r = await rig(); await initial(r, 5);
    const a = r.c.resync('join');
    const b = r.c.resync('join');
    await flush();
    const before = r.ws.attaches().length;
    const ra = a.then(() => 'ok', e => (e as Error).message);
    const rb = b.then(() => 'ok', e => (e as Error).message);
    r.ws.drop();
    expect(await ra).toBe(LOST);
    expect(await rb).toBe(LOST);
    expect(r.ws.attaches()).toHaveLength(before); // 排队的那一轮没有在旧连接上补发

    await r.clock.advance(100);
    const ws2 = FakeWebSocket.last;
    ws2.open();
    await flush();
    ws2.reply(ws2.attaches().at(-1).id, resumeOf({ lastSeq: 5, events: [] }));
    await flush();
    await r.clock.advance(5000);
    expect(ws2.attaches()).toHaveLength(1); // 没有替排队的轮次补跑
    expect(r.syncs.filter(s => s.cause === 'join')).toEqual([]);
  });

  it('重连成功后的补洞一轮 attach 超时：套接字被关、重新进入重连（从第 1 次起）、synced 没调；期间排队的 resync 被拒；inDoubt 在下一次成功时原样交出', async () => {
    const r = await rig(); await initial(r, 5);
    const prompt = r.c.call('chat.prompt', { sessionId: 'S', text: 'hi', promptId: 'p-9' });
    await flush();
    const ws2 = await reconnectTo(r);
    await prompt.catch(() => undefined);
    r.log.length = 0;
    let queued: Promise<string> | undefined;
    r.c.on('x.evt', (_p, ev) => {
      r.log.push(`x.evt#${ev?.seq}`);
      // 回放帧的处理器要了一轮 join（store 的 trackRun → joinRun）：排在这一轮后面
      if (ev?.seq === 6) queued = r.c.resync('join').then(() => 'ok', e => (e as Error).message);
    });
    ws2.push(frame(9)); // 应答之前到了一帧，与回放之间隔着一个洞（seq 8）
    ws2.reply(ws2.attaches().at(-1).id, resumeOf({ lastSeq: 7, events: [frame(6), frame(7)] }));
    await flush();
    expect(r.log).toEqual(['status:open', 'x.evt#6', 'x.evt#7', 'resumed@7:reconnect']);
    expect(ws2.attaches()).toHaveLength(2); // 补洞的一轮已经发出
    expect(r.syncs).toEqual([]);

    await r.clock.advance(1000); // attach 超时
    expect(ws2.closed).toBe(true);
    expect(r.log.slice(4)).toEqual(['status:reconnecting#1']);
    expect(await queued).toBe(LOST);
    expect(r.syncs).toEqual([]);

    await r.clock.advance(100);
    const ws3 = FakeWebSocket.last;
    expect(ws3).not.toBe(ws2);
    ws3.open();
    await flush();
    ws3.reply(ws3.attaches().at(-1).id, resumeOf({ lastSeq: 9, events: [frame(8), frame(9)] }));
    await flush();
    expect(r.syncs).toHaveLength(1);
    expect(r.syncs[0].inDoubt).toEqual([{ method: 'chat.prompt', params: { sessionId: 'S', text: 'hi', promptId: 'p-9' } }]);
    expect(ws3.frames().map(f => f.method)).toEqual(['state.attach']);
  });

  it('首次同步之前就断线：按原来的终态处理（onLost 一次、不重连），在跑的 resync 被拒', async () => {
    const r = await rig();
    const p = r.c.resync('initial').then(() => 'ok', e => (e as Error).message);
    await flush();
    r.ws.drop();
    expect(await p).toBe(LOST);
    expect(r.lost).toEqual([LOST]);
    expect(r.statuses).toEqual([]);
    await r.clock.advance(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it('上层说还没就绪（canRecover 回 false）：断线按终态处理，不重连', async () => {
    let ready = false;
    const r = await rig({ hooks: { canRecover: () => ready } });
    await initial(r, 5);
    r.ws.drop();
    await flush();
    expect(r.lost).toEqual([LOST]);
    expect(r.statuses).toEqual([]);
    await r.clock.advance(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    ready = true;
  });
});

describe('F06 C 组 · 重连：重新认证、退避、上限、手动重试', () => {
  it('每次尝试都重新向主进程要端口与 token，URL 用当次的 token', async () => {
    const r = await rig(); await initial(r, 5);
    const callsBefore = info.calls;
    info.next = async () => ({ port: 4000 + info.calls, token: `tok-${info.calls}`, alive: true });
    r.ws.drop();
    await r.clock.advance(100);
    const ws2 = FakeWebSocket.last;
    expect(info.calls).toBe(callsBefore + 1);
    expect(ws2.url).toBe(`ws://127.0.0.1:${4000 + info.calls}/?token=tok-${info.calls}`);
    // 这一次没连上（建连超时）→ 关掉它，第二次尝试再问一遍
    await r.clock.advance(1000);
    expect(ws2.closed).toBe(true);
    expect(r.statuses.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 2, retryInMs: 200 });
    await r.clock.advance(200);
    const ws3 = FakeWebSocket.last;
    expect(ws3).not.toBe(ws2);
    expect(info.calls).toBe(callsBefore + 2);
    expect(ws3.url).toBe(`ws://127.0.0.1:${4000 + info.calls}/?token=tok-${info.calls}`);
  });

  it('主进程说引擎已经退出（alive:false）：立即进入终态，不建套接字', async () => {
    const r = await rig(); await initial(r, 5);
    info.next = async () => ({ port: 1234, token: 'T', alive: false });
    r.ws.drop();
    await r.clock.advance(100);
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(r.statuses.at(-1)).toMatchObject({ state: 'lost', reason: 'engine-exited' });
    expect(r.lost).toEqual([LOST]);
    await r.clock.advance(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it('退避按表递增、到表长为止；用尽后 status(lost, exhausted) 在前、onLost 恰一次，之后不再建套接字；retryNow 重新开始且不带游标', async () => {
    const r = await rig(); await initial(r, 5);
    info.next = async () => { throw new Error('主进程没应答'); };
    r.ws.drop();
    await r.clock.advance(100);
    await r.clock.advance(200);
    await r.clock.advance(400);
    expect(r.statuses.map(s => [s.state, s.attempt, s.retryInMs ?? null, s.reason ?? null])).toEqual([
      ['reconnecting', 1, 100, null], ['reconnecting', 2, 200, null], ['reconnecting', 3, 400, null], ['lost', 0, null, 'exhausted'],
    ]);
    expect(r.log.slice(-2)).toEqual(['status:lost', 'onLost']);
    expect(r.lost).toEqual([LOST]);
    const sockets = FakeWebSocket.all.length;
    await r.clock.advance(600_000);
    expect(FakeWebSocket.all).toHaveLength(sockets);
    expect(r.clock.pending()).toBe(0);
    await expect(r.c.call('chat.sessions.list')).rejects.toThrow(LOST);

    // 手动重连：立即问主进程、建新套接字；这一轮强制取快照
    info.next = async () => ({ port: 1234, token: 'T-new', alive: true });
    r.c.retryNow();
    await flush();
    expect(r.statuses.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 1, retryInMs: 0 });
    const ws2 = FakeWebSocket.last;
    expect(FakeWebSocket.all).toHaveLength(sockets + 1);
    ws2.open();
    await flush();
    const req = ws2.attaches().at(-1);
    expect(req.params.resume).toBeUndefined();
    ws2.reply(req.id, snapshotOf({ lastSeq: 9 }));
    await flush();
    expect(r.syncs.at(-1)).toMatchObject({ via: 'snapshot', cause: 'retry' });
    expect(r.statuses.at(-1)).toMatchObject({ state: 'open' });
    // 不在终态时 retryNow 不起作用
    r.c.retryNow();
    await flush();
    expect(FakeWebSocket.all).toHaveLength(sockets + 1);
  });

  it('缺省策略：8 次、0.5 → 8 秒封顶、±20%；超出表长按最后一项', () => {
    expect(RECONNECT_POLICY.delaysMs).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000]);
    expect(reconnectDelayMs(1, RECONNECT_POLICY, () => 0.5)).toBe(500);
    expect(reconnectDelayMs(1, RECONNECT_POLICY, () => 0)).toBe(400);
    expect(reconnectDelayMs(1, RECONNECT_POLICY, () => 1)).toBe(600);
    expect(reconnectDelayMs(5, RECONNECT_POLICY, () => 0.5)).toBe(8000);
    expect(reconnectDelayMs(8, RECONNECT_POLICY, () => 1)).toBe(9600);
    expect(reconnectDelayMs(99, RECONNECT_POLICY, () => 1)).toBe(9600);
    expect(RECONNECT_POLICY.delaysMs.reduce((a, b) => a + b, 0)).toBe(39_500);
  });
});

describe('F06 C 组 · 旧引擎与首次同步失败', () => {
  it('引擎回「未知方法: state.attach」：resync 正常兑现，扣下的帧按到达顺序原样分发，此后断线走原来的终态', async () => {
    const r = await rig(); r.watch();
    r.ws.push(frame(2)); r.ws.push(frame(1)); // 首次同步之前到的帧先扣着
    expect(r.log).toEqual([]);
    const p = r.c.resync('initial');
    await flush();
    r.ws.fail(r.ws.attaches().at(-1).id, '未知方法: state.attach');
    await expect(p).resolves.toBeUndefined();
    expect(r.log).toEqual(['x.evt#2', 'x.evt#1']);
    r.ws.push(frame(1)); // 此后不去重、不扣帧
    expect(r.log).toEqual(['x.evt#2', 'x.evt#1', 'x.evt#1']);
    await expect(r.c.resync('join')).resolves.toBeUndefined(); // 没有可同步的
    expect(r.ws.attaches()).toHaveLength(1);
    r.ws.drop();
    await flush();
    expect(r.lost).toEqual([LOST]);
    expect(r.statuses).toEqual([]);
    expect(r.clock.pending()).toBe(0);
  });

  it('首次同步的其它失败：resync 拒绝，恢复关闭，扣下的帧照常分发', async () => {
    const r = await rig(); r.watch();
    r.ws.push(frame(1));
    const p = r.c.resync('initial');
    await flush();
    r.ws.fail(r.ws.attaches().at(-1).id, '内部错误');
    await expect(p).rejects.toThrow('内部错误');
    expect(r.log).toEqual(['x.evt#1']);
    r.ws.drop();
    await flush();
    expect(r.lost).toEqual([LOST]);
    expect(r.statuses).toEqual([]);
  });

  it('join 的应答形状不对：resync 拒绝，连接留着，之后的帧按游标接续', async () => {
    const r = await rig(); await initial(r, 5); r.watch();
    const p = r.c.resync('join');
    await flush();
    r.ws.push(frame(6));
    r.ws.reply(r.ws.attaches().at(-1).id, { mode: 'snapshot' });
    await expect(p).rejects.toThrow('形状不对');
    expect(r.log).toEqual(['x.evt#6']); // 扣下的那一帧接得上，照常交付
    r.ws.push(frame(7));
    expect(r.log).toEqual(['x.evt#6', 'x.evt#7']);
    expect(r.ws.closed).toBe(false);
  });
});

describe('F06 C 组 · 静默探测', () => {
  it("wantProbe 回 'idle'：一直有帧就不探测；静下来超过 probeIdleMs 发一次带游标的 attach；没有应答则超时关套接字、进入重连", async () => {
    let want: false | 'idle' | 'poll' = 'idle';
    const r = await rig({ hooks: { wantProbe: () => want }, policy: { probeIdleMs: 200, startPollMs: 50 } });
    await initial(r, 5);
    for (let i = 0; i < 10; i++) { await r.clock.advance(40); r.ws.push(frame(6 + i)); }
    expect(r.ws.attaches()).toHaveLength(1); // 400 毫秒里一直有帧：没有探测
    await r.clock.advance(250);
    const probe = r.ws.attaches().at(-1);
    expect(r.ws.attaches()).toHaveLength(2);
    expect(probe.params.resume).toEqual({ epoch: 1, instanceId: 'I1', lastSeq: 15 });
    want = false;
    await r.clock.advance(1000); // 应答一直没来
    expect(r.ws.closed).toBe(true);
    expect(r.statuses.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 1 });
  });

  it("wantProbe 回 'poll'：即使一直有别的帧，距上一次 attach 应答 startPollMs 之后也探测；应答之后再过 startPollMs 再探测", async () => {
    const r = await rig({ hooks: { wantProbe: () => 'poll' }, policy: { probeIdleMs: 200, startPollMs: 50 } });
    await initial(r, 5);
    let seq = 5;
    for (let i = 0; i < 4; i++) { await r.clock.advance(20); r.ws.push(frame(++seq)); }
    expect(r.ws.attaches()).toHaveLength(2);
    const probe = r.ws.attaches().at(-1);
    expect(probe.params.resume.epoch).toBe(1);
    // 探测发出之后又到的帧扣在缓冲里；应答把游标之后的帧全部带回来
    const from: number = probe.params.resume.lastSeq;
    r.ws.reply(probe.id, resumeOf({ lastSeq: seq, events: Array.from({ length: seq - from }, (_, i) => frame(from + 1 + i)) }));
    await flush();
    expect(r.syncs.at(-1)).toMatchObject({ via: 'resume', cause: 'probe', inDoubt: [] });
    for (let i = 0; i < 4; i++) { await r.clock.advance(20); r.ws.push(frame(++seq)); }
    expect(r.ws.attaches()).toHaveLength(3);
  });

  it('wantProbe 回 false 不探测；probeIdleMs = 0 时连定时器都不设', async () => {
    const r = await rig({ hooks: { wantProbe: () => false }, policy: { probeIdleMs: 200, startPollMs: 50 } });
    await initial(r, 5);
    await r.clock.advance(5000);
    expect(r.ws.attaches()).toHaveLength(1);

    const off = await rig({ hooks: { wantProbe: () => 'poll' }, policy: { probeIdleMs: 0 } });
    await initial(off, 5);
    expect(off.clock.pending()).toBe(0);
    await off.clock.advance(5000);
    expect(off.ws.attaches()).toHaveLength(1);
  });
});

describe('F06 C 组 · 不开恢复时与以前相同', () => {
  it('带戳的帧原样分发（重复、乱序都不管），处理器多收到一个戳；没有任何定时器；断线即终态', async () => {
    vi.useFakeTimers();
    const c = new RpcClient();
    const lost: string[] = [];
    c.onLost(x => { lost.push(x); });
    const connecting = c.connect();
    await flush();
    const ws = FakeWebSocket.last;
    ws.open();
    await connecting;
    const got: unknown[] = [];
    c.on('x.evt', (p, ev) => { got.push([p, ev]); });
    ws.push(frame(7)); ws.push(frame(7)); ws.push(frame(3));
    ws.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', method: 'x.evt', params: { plain: true } }) });
    expect(got).toEqual([[{ n: 7 }, { epoch: 1, seq: 7 }], [{ n: 7 }, { epoch: 1, seq: 7 }], [{ n: 3 }, { epoch: 1, seq: 3 }], [{ plain: true }, undefined]]);
    expect(ws.sent).toEqual([]);          // 没有 state.attach
    expect(vi.getTimerCount()).toBe(0);
    const p = c.call('chat.prompt', { sessionId: 'S', text: 'x' });
    await flush();
    ws.drop();
    const e = await p.then(() => undefined, x => x as Error);
    expect(e?.message).toBe(LOST);
    expect(isInFlightLoss(e)).toBe(false); // 旧路径不打标记
    expect(lost).toEqual([LOST]);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.all).toHaveLength(1);
    await expect(c.resync('join')).resolves.toBeUndefined();
    c.retryNow();
    expect(FakeWebSocket.all).toHaveLength(1);
  });
});
