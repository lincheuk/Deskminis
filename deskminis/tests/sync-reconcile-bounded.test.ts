/** Q12：重连对账里对账自己发起的推和拉限并发地走（先推后拉），一轮只属于起它的那条连接。
 *
 *  真 ChatStore 加真 SyncCoordinator，出站连接是脚本：每个 RPC 的应答晚一个宏任务到（像真的套接字），
 *  脚本数「同时在途的 RPC」和「已经切好、还没被对端应答的批次」。会话用很小的批次上限切成多批，
 *  这样「几个会话的批次」与「全部会话的批次」数得出差别。
 *
 *  这里钉的只是对账自己的扇出。脚本不接 chat.onDirty，拉回来的也是空载荷：合并有变化之后经 flush() 的回推、
 *  收到 sync.dirty 之后的拉取不在这个上限之内，本文件看不到它们。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { SyncCoordinator } from '../src/minisd/sync/coordinator';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import type { TombstoneHost, TombstoneOutcome } from '../src/minisd/sync/receive';
import type { RpcServer } from '../src/minisd/rpc/server';
import type { OutboundClient } from '../src/minisd/sync/outbound-client';

const PEER = 'aabbccddeeff';
/** 另一台一直在线的设备：对端在不在线要按指纹看，不能看「有没有任何连接」。 */
const BYSTANDER = '001122334455';
/** 协调器里的并发上限（coordinator.ts 的 RECONCILE_CONCURRENCY）。 */
const LIMIT = 16;
const SESSIONS = 24;
const MSGS = 5;
/** 每条消息约 400 字节：1000 字节一批放得下两条，5 条消息切成 3 批。 */
const BATCH_BYTES = 1000;
const BATCHES = 3;

interface Call { method: string; sid?: string }
type Answer = (method: string, params: any) => unknown;

interface Rig {
  chat: ChatStore; coord: SyncCoordinator; calls: Call[]; ob: { onOnline?: (fp: string) => void };
  /** 本机会话 id，按对账取用的顺序。 */
  order: string[];
  /** buildPushBatches 被调用的会话，按调用顺序。 */
  builds: string[];
  peak: { inFlight: number; liveBatches: number };
  online: boolean;
  /** 对端不在线时仍然发起的 RPC 次数（脚本当即拒掉，不进 calls）。 */
  offlineAttempts: number;
  /** 每次 sync.list 发出的那一刻，还有几个别的 RPC 在途。 */
  inFlightAtList: number[];
  /** 在缺省应答之前插一层：返回 undefined 表示照缺省应答，抛错表示这次 RPC 失败。 */
  intercept(a: Answer): void;
  idle(): Promise<void>;
  by(method: string, sid?: string): Call[];
}

const rigs: Rig[] = [];
afterEach(() => { for (const r of rigs.splice(0)) r.coord.stop(); });

function rig(opts: { host?: TombstoneHost } = {}): Rig {
  const chat = new ChatStore(openDb(':memory:'), 'me');
  for (let s = 0; s < SESSIONS; s++) {
    const sid = chat.createSession(`S${s}`).id;
    for (let i = 0; i < MSGS; i++) {
      chat.appendMessage({ id: chat.newId(), sessionId: sid, role: 'user', parts: [{ type: 'text', value: `${s}/${i} ` + 'x'.repeat(100) }], createdAt: chat.nowEpoch(), streamInterruptCount: 0 });
    }
  }
  const order = chat.listSyncedSessions().map(s => s.id);
  const realBuild = chat.buildPushBatches.bind(chat);
  for (const sid of order) expect(realBuild(sid, BATCH_BYTES)).toHaveLength(BATCHES);

  const calls: Call[] = [];
  const builds: string[] = [];
  const peak = { inFlight: 0, liveBatches: 0 };
  let inFlight = 0;
  let liveBatches = 0;
  const intercepts: Answer[] = [];
  const answer: Answer = (method, params) => {
    for (const a of intercepts) { const out = a(method, params); if (out !== undefined) return out; }
    if (method === 'sync.list') return { sessions: order.map(id => ({ id })), tombstones: [] };
    if (method === 'sync.pull') return { messages: [], markers: [] };
    return { mergedCount: 0, orphanMarkerIds: [], hasChange: false };
  };
  chat.buildPushBatches = (sid: string) => {
    builds.push(sid);
    const batches = realBuild(sid, BATCH_BYTES);
    liveBatches += batches.length;
    peak.liveBatches = Math.max(peak.liveBatches, liveBatches);
    return batches;
  };
  const r = {} as Rig;
  const ob: any = {
    dialedPeers: () => (r.online ? [BYSTANDER, PEER] : [BYSTANDER]),
    peerInfo: () => ({ protocolVersion: 2, caps: { tombstones: true } }),
    start() { /* 不真拨号 */ }, stop() { /* 无 */ },
    onRemoteDirty: undefined, onOnline: undefined,
    callRpc: (_fp: string, method: string, params: any) => {
      if (!r.online) { r.offlineAttempts++; return Promise.reject(new Error('对端未在线')); }
      if (method === 'sync.list') r.inFlightAtList.push(inFlight);
      calls.push({ method, sid: params?.sessionId });
      inFlight++;
      peak.inFlight = Math.max(peak.inFlight, inFlight);
      return new Promise((resolve, reject) => setImmediate(() => {
        inFlight--;
        if (method === 'sync.push') liveBatches--;
        try { resolve(answer(method, params)); } catch (e) { reject(e); }
      }));
    },
  };
  const coord = new SyncCoordinator(chat, { broadcast: () => { /* 不看 */ } } as unknown as RpcServer,
    { debounceMs: 10, outbound: ob as OutboundClient, ...(opts.host ? { lifecycleHost: opts.host } : {}) });
  coord.start();
  const idle = async (): Promise<void> => {
    const deadline = Date.now() + 5000;
    let last = -1; let since = Date.now();
    while (Date.now() < deadline) {
      if (calls.length !== last) { last = calls.length; since = Date.now(); }
      else if (inFlight === 0 && Date.now() - since >= 100) return;
      await new Promise(res => setTimeout(res, 5));
    }
    throw new Error('协调器没有安静下来');
  };
  Object.assign(r, {
    chat, coord, calls, ob, order, builds, peak, online: true, offlineAttempts: 0, inFlightAtList: [],
    intercept: (a: Answer) => { intercepts.push(a); },
    idle,
    by: (method: string, sid?: string) => calls.filter(c => c.method === method && (sid === undefined || c.sid === sid)),
  });
  rigs.push(r);
  return r;
}

/** 某个会话第一批推送的应答到达时做一件事（只做一次）。 */
function onFirstPush(r: Rig, sid: string, act: () => unknown): void {
  let done = false;
  r.intercept((m, p) => { if (!done && m === 'sync.push' && p.sessionId === sid) { done = true; return act(); } return undefined; });
}
/** 第 n 次拉取（从 1 数）的应答到达时做一件事。 */
function onNthPull(r: Rig, n: number, act: () => void): void {
  let seen = 0;
  r.intercept((m) => { if (m === 'sync.pull' && ++seen === n) act(); return undefined; });
}
const sorted = (xs: Array<string | undefined>): Array<string | undefined> => [...xs].sort();
/** 每个会话都推满了全部批次、拉了一次。 */
function expectFullRound(r: Rig, from = 0): void {
  const calls = r.calls.slice(from);
  for (const sid of r.order) {
    expect(calls.filter(c => c.method === 'sync.push' && c.sid === sid)).toHaveLength(BATCHES);
    expect(calls.filter(c => c.method === 'sync.pull' && c.sid === sid)).toHaveLength(1);
  }
}

describe('Q12 重连对账限并发', () => {
  it(`${SESSIONS} 个会话各 ${BATCHES} 批：对账在途的 RPC 不超过 ${LIMIT} 个，内存里不超过 ${LIMIT} 个会话的批次；每个会话推一遍、拉一遍，全部推完才开始拉`, async () => {
    const r = rig();
    r.ob.onOnline!(PEER);
    await r.idle();

    // 上限是被顶到过的（不是碰巧只走了一个），也没有被超过
    expect(r.peak.inFlight).toBe(LIMIT);
    expect(r.peak.liveBatches).toBe(LIMIT * BATCHES);
    // 每个会话恰好读一次库，按清单的顺序取用
    expect(r.builds).toEqual(r.order);
    expect(r.calls[0]).toEqual({ method: 'sync.list', sid: undefined });
    expect(r.by('sync.list')).toHaveLength(1);
    expectFullRound(r);
    const lastPush = r.calls.map(c => c.method).lastIndexOf('sync.push');
    const firstPull = r.calls.findIndex(c => c.method === 'sync.pull');
    expect(firstPull).toBeGreaterThan(lastPush);
  });

  it('第一波推送里对端掉线（别的设备还连着）：没轮到的会话不再读库，也不拉；标志已释放，重连后的对账从头整推', async () => {
    const r = rig();
    onFirstPush(r, r.order[1], () => { r.online = false; throw new Error('连接断开'); });
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.builds).toEqual(r.order.slice(0, LIMIT));
    expect(r.by('sync.pull')).toHaveLength(0);

    r.online = true;
    const mark = r.calls.length;
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.calls.slice(mark).filter(c => c.method === 'sync.list')).toHaveLength(1);
    expect(r.builds.slice(LIMIT)).toEqual(r.order);
    expectFullRound(r, mark);
  });

  it(`${LIMIT + 1} 个会话的推送被对端报错、连接还在：它们各停在出错的那一批，其余会话照常推、照常拉`, async () => {
    const r = rig();
    const bad = new Set(r.order.slice(0, LIMIT + 1));
    r.intercept((m, p) => { if (m === 'sync.push' && bad.has(p.sessionId)) throw new Error('sync.push payload 超过 1MB 限制'); return undefined; });
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.builds).toEqual(r.order);
    for (const sid of r.order) expect(r.by('sync.push', sid)).toHaveLength(bad.has(sid) ? 1 : BATCHES);
    expect(sorted(r.by('sync.pull').map(c => c.sid))).toEqual(sorted(r.order));
  });

  it(`${LIMIT + 1} 个会话读库抛错：只跳过它们，其余会话照常推、照常拉；每个会话只警告一次（下一轮不再报），不带错误文本`, async () => {
    const r = rig();
    const bad = new Set(r.order.slice(0, LIMIT + 1));
    const build = r.chat.buildPushBatches;
    r.chat.buildPushBatches = (sid: string, maxBytes?: number) => { if (bad.has(sid)) throw new Error('非法 ContentPart: {"机密":"正文"}'); return build(sid, maxBytes); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 只数 */ });
    try {
      r.ob.onOnline!(PEER);
      await r.idle();
      for (const sid of r.order) expect(r.by('sync.push', sid)).toHaveLength(bad.has(sid) ? 0 : BATCHES);
      expect(sorted(r.by('sync.pull').map(c => c.sid))).toEqual(sorted(r.order));
      r.ob.onOnline!(PEER);
      await r.idle();
      const lines = warn.mock.calls.map(c => String(c[0]));
      for (const sid of bad) expect(lines.filter(l => l.includes(sid))).toHaveLength(1);
      expect(lines).toHaveLength(bad.size);
      expect(lines.join('\n')).not.toContain('机密');
    } finally { warn.mockRestore(); }
  });

  it('对账途中暂停：没轮到的会话不再推，拉取照常', async () => {
    const r = rig();
    onFirstPush(r, r.order[1], () => { r.coord.setPaused(true); });
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.builds).toEqual(r.order.slice(0, LIMIT));
    expect(sorted(r.by('sync.pull').map(c => c.sid))).toEqual(sorted(r.order));
  });

  it('推送途中 stop()：不再轮到后面的会话，也不拉', async () => {
    const r = rig();
    onFirstPush(r, r.order[1], () => { r.coord.stop(); });
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.builds).toEqual(r.order.slice(0, LIMIT));
    expect(r.by('sync.pull')).toHaveLength(0);
  });

  it('拉取途中 stop()：没发出去的不再拉', async () => {
    const r = rig();
    onNthPull(r, 1, () => { r.coord.stop(); });
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.by('sync.pull').map(c => c.sid)).toEqual(r.order.slice(0, LIMIT));
  });

  it('第一波拉取里对端掉线：没发出去的不再拉，连试都不试；重连后的对账重新走一遍', async () => {
    const r = rig();
    onNthPull(r, 1, () => { r.online = false; throw new Error('连接断开'); });
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.by('sync.pull').map(c => c.sid)).toEqual(r.order.slice(0, LIMIT));
    expect(r.offlineAttempts).toBe(0);

    r.online = true;
    const mark = r.calls.length;
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.calls.slice(mark).filter(c => c.method === 'sync.list')).toHaveLength(1);
    expectFullRound(r, mark);
  });
});

describe('Q12 一轮对账只属于起它的那条连接', () => {
  for (const [phase, arm] of [
    ['推送', (r: Rig, again: () => void) => onFirstPush(r, r.order[1], again)],
    ['拉取', (r: Rig, again: () => void) => onNthPull(r, 1, again)],
  ] as const) {
    it(`${phase}途中对端又上线一次（连接换过）：两轮不并行；旧的一轮收手，等它在途的都结束后给新连接补一轮完整的`, async () => {
      const r = rig();
      let mark = -1;
      arm(r, () => { mark = r.calls.length; r.ob.onOnline!(PEER); });
      r.ob.onOnline!(PEER);
      await r.idle();
      expect(mark).toBeGreaterThan(0);
      // 恰好补一轮；它的清单是在旧一轮的 RPC 全部结束之后才发出的
      expect(r.by('sync.list')).toHaveLength(2);
      expect(r.inFlightAtList).toEqual([0, 0]);
      expect(r.peak.inFlight).toBe(LIMIT);
      // 旧的一轮在换连接之后没有再取新的会话
      const firstRoundBuilds = phase === '推送' ? LIMIT : SESSIONS;
      expect(r.builds.slice(0, firstRoundBuilds)).toEqual(r.order.slice(0, firstRoundBuilds));
      // 补的那一轮把每个会话各读一次（拉过的会话 updated_at 变了，清单的次序可能与第一轮不同，所以只比集合）
      expect(sorted(r.builds.slice(firstRoundBuilds))).toEqual(sorted(r.order));
      const secondList = r.calls.map(c => c.method).lastIndexOf('sync.list');
      expectFullRound(r, secondList);
    });
  }

  it('某个会话正等本机 run 停下时连接被换掉：新连接的上线不被吞掉；旧的一轮不再接着走旧清单，停稳后补一轮完整的', async () => {
    let release: (o: TombstoneOutcome) => void = () => { /* 占位 */ };
    let parked = 0;
    const host: TombstoneHost = { applyRemoteTombstone: () => new Promise<TombstoneOutcome>(res => { parked++; release = res; }) };
    const r = rig({ host });
    const victim = r.order[2];
    const tombstone = { v: 1, opId: 'OP-PEER', originDeviceId: PEER, at: 1, seen: makeSeen([]) };
    // 对端说这个会话它已经删了：本机去应用墓碑，宿主要先等这个会话的 run 停下（这里一直不放行）
    onFirstPush(r, victim, () => ({ mergedCount: 0, orphanMarkerIds: [], hasChange: false, rejected: 'tombstoned', lifecycle: tombstone }));
    r.ob.onOnline!(PEER);
    await vi.waitFor(() => { expect(parked).toBe(1); });
    // 连接断开：在途的都失败；等其余的收手，只剩等 run 的那一个
    r.online = false;
    await r.idle();
    const buildsBefore = r.builds.length;
    const mark = r.calls.length;
    // 新连接上线，旧的一轮还没收手
    r.online = true;
    r.ob.onOnline!(PEER);
    await r.idle();
    expect(r.calls.length).toBe(mark);            // 没有并行起第二轮
    // run 停稳（这次不落库）：旧的一轮到此为止，随后补的那一轮重新取清单、把每个会话推一遍拉一遍
    release({ status: 'deferred', reason: 'run-stopping' });
    await r.idle();
    expect(r.calls.slice(mark).filter(c => c.method === 'sync.list')).toHaveLength(1);
    expect(r.calls[mark]).toEqual({ method: 'sync.list', sid: undefined });
    expect(sorted(r.builds.slice(buildsBefore))).toEqual(sorted(r.order));
    expectFullRound(r, mark);
  });
});
