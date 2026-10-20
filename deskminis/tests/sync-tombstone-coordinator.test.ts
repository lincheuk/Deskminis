/** F11B：拨号方收发墓碑、差量对账、暂停与恢复（设计 §4.7、§4.9）。
 *
 *  真 ChatStore 加真 SyncCoordinator，出站连接是脚本：记录每一次 callRpc，由用例决定对端怎么答。
 *  等待一律用「调用记录在一段时间内不再增长」判定，不靠固定时长猜对账走到了哪一步。 */
import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { SyncCoordinator } from '../src/minisd/sync/coordinator';
import { receiveRemotePayload } from '../src/minisd/sync/receive';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import { toWireSession, type WireLifecycle } from '../src/minisd/sync/wire';
import type { RpcServer } from '../src/minisd/rpc/server';
import type { OutboundClient } from '../src/minisd/sync/outbound-client';

const PEER = 'aabbccddeeff';
interface Call { method: string; params: any }
type Handler = (method: string, params: any) => unknown;

interface Rig {
  chat: ChatStore; coord: SyncCoordinator; calls: Call[]; broadcasts: Array<{ method: string; payload: any }>;
  ob: { onOnline?: (fp: string) => void; onRemoteDirty?: (fp: string, sid: string) => void };
  setHandler(h: Handler): void;
  /** 触发一次对账并等它走完。 */
  reconcile(): Promise<void>;
  /** 调用记录与广播在 quietMs 内不再增长。 */
  idle(quietMs?: number): Promise<void>;
  pushes(sid?: string): Call[]; tombPushes(sid?: string): Call[]; contentPushes(sid?: string): Call[]; pulls(sid?: string): Call[];
}

const rigs: Rig[] = [];
afterEach(() => { for (const r of rigs.splice(0)) r.coord.stop(); });

function rig(opts: { caps?: Record<string, boolean> | null; handler?: Handler } = {}): Rig {
  const chat = new ChatStore(openDb(':memory:'), 'me');
  const calls: Call[] = [];
  const broadcasts: Array<{ method: string; payload: any }> = [];
  let handler: Handler = opts.handler ?? (m => (m === 'sync.list' ? { sessions: [], tombstones: [] } : {}));
  const caps = opts.caps === undefined ? { tombstones: true } : opts.caps;
  const ob: any = {
    dialedPeers: () => [PEER],
    callRpc: async (_fp: string, method: string, params: unknown) => {
      calls.push({ method, params });
      return handler(method, params);
    },
    start() { /* 不真拨号 */ }, stop() { /* 无 */ },
    onRemoteDirty: undefined, onOnline: undefined,
  };
  // caps 为 null：出站桩没有 peerInfo（既有测试的桩就是这样），协调器必须按旧版对待
  if (caps !== null) ob.peerInfo = () => ({ protocolVersion: 2, caps });
  const rpc = { broadcast: (method: string, payload: unknown) => { broadcasts.push({ method, payload }); } };
  const coord = new SyncCoordinator(chat, rpc as unknown as RpcServer, { debounceMs: 10, outbound: ob as OutboundClient });
  chat.onDirty = sid => coord.onDirty(sid);
  coord.start();
  const idle = async (quietMs = 120): Promise<void> => {
    const deadline = Date.now() + 5000;
    let last = -1; let since = Date.now();
    while (Date.now() < deadline) {
      const n = calls.length + broadcasts.length;
      if (n !== last) { last = n; since = Date.now(); }
      else if (Date.now() - since >= quietMs) return;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('协调器没有安静下来');
  };
  const by = (method: string, sid?: string): Call[] => calls.filter(c => c.method === method && (sid === undefined || c.params.sessionId === sid));
  const r: Rig = {
    chat, coord, calls, broadcasts, ob,
    setHandler: h => { handler = h; },
    reconcile: async () => { ob.onOnline(PEER); await idle(); },
    idle,
    pushes: sid => by('sync.push', sid),
    tombPushes: sid => by('sync.push', sid).filter(c => c.params.payload.lifecycle && c.params.payload.lifecycle.v % 2 === 1),
    contentPushes: sid => by('sync.push', sid).filter(c => !(c.params.payload.lifecycle && c.params.payload.lifecycle.v % 2 === 1)),
    pulls: sid => by('sync.pull', sid),
  };
  rigs.push(r);
  return r;
}

function addMsg(chat: ChatStore, sid: string, text = 'x'): string {
  const id = chat.newId();
  chat.appendMessage({ id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: text }], createdAt: chat.nowEpoch(), streamInterruptCount: 0 });
  return id;
}
function session(chat: ChatStore, n = 2): { sid: string; ids: string[] } {
  const s = chat.createSession('S');
  return { sid: s.id, ids: Array.from({ length: n }, () => addMsg(chat, s.id)) };
}
const tomb = (opId: string, ids: string[], v = 1): WireLifecycle => ({ v, opId, originDeviceId: PEER, at: 1, seen: makeSeen(ids) });
/** 建好初始数据之后清掉记录，只看被测动作引起的出站。 */
async function quiesce(r: Rig): Promise<void> { await r.idle(); r.calls.length = 0; r.broadcasts.length = 0; }

describe('C1 对账只补对端缺的墓碑', () => {
  it('对端清单里缺的各推一次；对端已有的不推；存活会话照常推', async () => {
    const r = rig();
    const t1 = session(r.chat); const t2 = session(r.chat); const k = session(r.chat);
    r.chat.deleteSession(t1.sid); r.chat.deleteSession(t2.sid);
    await quiesce(r);
    const head1 = r.chat.listTombstoneHeads().find(h => h.id === t1.sid)!;
    r.setHandler(m => (m === 'sync.list' ? { sessions: [], tombstones: [head1] } : {}));
    await r.reconcile();
    expect(r.tombPushes(t1.sid)).toHaveLength(0);
    expect(r.tombPushes(t2.sid)).toHaveLength(1);
    const p = r.tombPushes(t2.sid)[0].params.payload;
    expect(p.messages).toEqual([]);
    expect(p.markers).toEqual([]);
    expect(p.lifecycle).toMatchObject({ v: 1, originDeviceId: 'me' });
    expect(p.lifecycle.seen.ids).toEqual([...t2.ids].sort());
    expect(r.contentPushes(k.sid)).toHaveLength(1);
    expect(r.calls.filter(c => c.method === 'sync.list')).toHaveLength(1);

    // 稳态：对端两条都有了，再对账一条墓碑都不推
    r.calls.length = 0;
    r.setHandler(m => (m === 'sync.list' ? { sessions: [], tombstones: r.chat.listTombstoneHeads() } : {}));
    await r.reconcile();
    expect(r.tombPushes()).toHaveLength(0);
  });

  for (const [name, caps] of [['对端没声明能力', { attachments: true }], ['出站桩没有 peerInfo', null]] as const) {
    it(`${name}：一条墓碑都不推，也不去拉它清单里的墓碑`, async () => {
      const r = rig({ caps: caps as Record<string, boolean> | null });
      const t = session(r.chat); const k = session(r.chat);
      r.chat.deleteSession(t.sid);
      await quiesce(r);
      // 即使它的应答里（不该有地）带了墓碑清单，也不拉
      r.setHandler(m => (m === 'sync.list' ? { sessions: [], tombstones: [{ id: k.sid, v: 1, opId: 'ZZZ' }] } : {}));
      await r.reconcile();
      expect(r.tombPushes()).toHaveLength(0);
      expect(r.pulls(k.sid)).toHaveLength(0);
      expect(r.contentPushes(k.sid)).toHaveLength(1);
      expect(r.chat.getSession(k.sid)).toBeDefined();
    });
  }

  it('对端 lifecyclePaused：一条墓碑都不推、也不拉墓碑；内容照常', async () => {
    const r = rig();
    const t = session(r.chat); const k = session(r.chat);
    r.chat.deleteSession(t.sid);
    await quiesce(r);
    r.setHandler(m => (m === 'sync.list' ? { sessions: [], lifecyclePaused: true, tombstones: [{ id: k.sid, v: 1, opId: 'ZZZ' }] } : {}));
    await r.reconcile();
    expect(r.tombPushes()).toHaveLength(0);
    expect(r.pulls(k.sid)).toHaveLength(0);
    expect(r.contentPushes(k.sid)).toHaveLength(1);
  });

  it('删除当场经 flush 推出墓碑并广播 sync.dirty；旧版对端不发', async () => {
    const r = rig();
    const t = session(r.chat);
    await quiesce(r);
    r.chat.deleteSession(t.sid);
    await r.idle();
    expect(r.tombPushes(t.sid)).toHaveLength(1);
    expect(r.broadcasts.filter(b => b.method === 'sync.dirty' && b.payload.sessionId === t.sid)).toHaveLength(1);

    const old = rig({ caps: {} });
    const t2 = session(old.chat);
    await quiesce(old);
    old.chat.deleteSession(t2.sid);
    await old.idle();
    expect(old.pushes()).toHaveLength(0);
  });
});

describe('C2–C3 对账的 pull 方向', () => {
  it('C2 对端清单把本机已删的会话列为存活：不去拉它，把墓碑推给它', async () => {
    const r = rig();
    const t = session(r.chat);
    r.chat.deleteSession(t.sid);
    await quiesce(r);
    r.setHandler(m => (m === 'sync.list' ? { sessions: [{ id: t.sid }], tombstones: [] } : {}));
    await r.reconcile();
    expect(r.pulls(t.sid)).toHaveLength(0);
    expect(r.tombPushes(t.sid)).toHaveLength(1);
    expect(r.chat.isDeleted(t.sid)).toBe(true);
  });

  it('C2 对端是旧版时同样不拉；收到它的 sync.dirty 也不拉', async () => {
    const r = rig({ caps: {} });
    const t = session(r.chat);
    r.chat.deleteSession(t.sid);
    await quiesce(r);
    r.setHandler(m => (m === 'sync.list' ? { sessions: [{ id: t.sid }] } : {}));
    await r.reconcile();
    r.ob.onRemoteDirty!(PEER, t.sid);
    await r.idle();
    expect(r.pulls(t.sid)).toHaveLength(0);
    expect(r.pushes(t.sid)).toHaveLength(0);
  });

  it('C2 对端把它恢复了（清单里是更高的偶数头）：去拉', async () => {
    const r = rig();
    const t = session(r.chat);
    r.chat.deleteSession(t.sid);
    await quiesce(r);
    r.setHandler(m => (m === 'sync.list' ? { sessions: [{ id: t.sid, lifecycle: { v: 2, opId: 'REST' } }], tombstones: [] } : {}));
    await r.reconcile();
    expect(r.pulls(t.sid)).toHaveLength(1);
    expect(r.tombPushes(t.sid)).toHaveLength(0);
  });

  it('C3 对端墓碑比本机新：先拉取并应用，之后不再推这个会话的内容', async () => {
    const r = rig();
    const s = session(r.chat); const k = session(r.chat);
    await quiesce(r);
    const T = tomb('OP-PEER', s.ids);
    r.setHandler((m, p) => {
      if (m === 'sync.list') return { sessions: [], tombstones: [{ id: s.sid, v: 1, opId: 'OP-PEER' }] };
      if (m === 'sync.pull' && p.sessionId === s.sid) return { messages: [], markers: [], lifecycle: T };
      return {};
    });
    await r.reconcile();
    expect(r.pulls(s.sid)).toHaveLength(1);
    expect(r.chat.isDeleted(s.sid)).toBe(true);
    // 拉来的墓碑记着是从哪台设备得知的（宿主据此复查这台设备还在不在配对表里）
    expect(r.chat.getLifecycle(s.sid)).toMatchObject({ v: 1, opId: 'OP-PEER', receivedFrom: PEER });
    expect(r.chat.listMessages(s.sid)).toEqual([]);
    expect(r.contentPushes(s.sid)).toHaveLength(0);
    expect(r.contentPushes(k.sid)).toHaveLength(1);
    // 墓碑不算「同步了 N 条」
    expect(r.broadcasts.filter(b => b.method === 'chat.event')).toHaveLength(0);
    // 拉取先于任何推送
    expect(r.calls.findIndex(c => c.method === 'sync.pull')).toBeLessThan(r.calls.findIndex(c => c.method === 'sync.push'));
  });
});

describe('C4–C5 本端暂停与恢复', () => {
  it('C4 暂停时对账：不推任何东西、不拉墓碑，照常拉存活会话的内容；sync.list 恰一次', async () => {
    const r = rig();
    const t = session(r.chat); const k = session(r.chat);
    r.chat.deleteSession(t.sid);
    await quiesce(r);
    r.coord.setPaused(true);
    r.setHandler(m => (m === 'sync.list' ? { sessions: [{ id: 'REMOTE-ALIVE' }], tombstones: [{ id: k.sid, v: 1, opId: 'ZZZ' }] } : {}));
    await r.reconcile();
    expect(r.pushes()).toHaveLength(0);
    expect(r.pulls(k.sid)).toHaveLength(0);
    expect(r.pulls('REMOTE-ALIVE')).toHaveLength(1);
    expect(r.calls.filter(c => c.method === 'sync.list')).toHaveLength(1);
    expect(r.chat.getSession(k.sid)).toBeDefined();
  });

  it('C5 暂停期间删除：没有任何出站；resumeSync 恰好推出这条墓碑并广播 sync.dirty', async () => {
    const r = rig();
    const t = session(r.chat); const k = session(r.chat);
    await quiesce(r);
    r.coord.setPaused(true);
    r.chat.deleteSession(t.sid);
    await r.idle(200);
    expect(r.calls).toHaveLength(0);
    expect(r.broadcasts).toHaveLength(0);

    r.coord.setPaused(false);
    await r.coord.resumeSync();
    await r.idle();
    expect(r.tombPushes(t.sid)).toHaveLength(1);
    expect(r.broadcasts.filter(b => b.method === 'sync.dirty' && b.payload.sessionId === t.sid)).toHaveLength(1);
    expect(r.contentPushes(k.sid)).toHaveLength(1);
    // 只补一次：再恢复一遍不重复推这条墓碑
    r.calls.length = 0;
    await r.coord.resumeSync();
    await r.idle();
    expect(r.tombPushes(t.sid)).toHaveLength(0);
  });
});

describe('C6–C7 推送被拒与失败', () => {
  it('C6 推内容得到 rejected 加墓碑：本机应用墓碑，后续分批不再推', async () => {
    const r = rig();
    const s = r.chat.createSession('大会话');
    const ids = [addMsg(r.chat, s.id, 'a'.repeat(300_000)), addMsg(r.chat, s.id, 'b'.repeat(300_000)), addMsg(r.chat, s.id, 'c'.repeat(300_000))];
    await quiesce(r);
    expect(r.chat.buildPushBatches(s.id).length).toBeGreaterThanOrEqual(3);
    const T = tomb('OP-PEER', ids);
    r.setHandler((m, p) => {
      if (m === 'sync.list') return { sessions: [], tombstones: [] };
      if (m === 'sync.push' && p.payload.messages.length > 0) return { mergedCount: 0, orphanMarkerIds: [], hasChange: false, rejected: 'tombstoned', lifecycle: T };
      return { tombstone: 'duplicate', lifecycle: T };
    });
    await r.reconcile();
    expect(r.contentPushes(s.id)).toHaveLength(1);
    expect(r.chat.isDeleted(s.id)).toBe(true);
    expect(r.chat.getLifecycle(s.id)).toMatchObject({ v: 1, opId: 'OP-PEER', receivedFrom: PEER });
    expect(r.chat.listMessages(s.id)).toEqual([]);
  });

  // 对端应答与清单里的登记来自网络。畸形的、不比本机新的，一律不能让本机删东西
  it.each([
    ['v 不是整数', { v: 1.5, opId: 'OP-X', originDeviceId: PEER, at: 1 }],
    ['v 是字符串', { v: '1', opId: 'OP-X', originDeviceId: PEER, at: 1 }],
    ['v 为 0', { v: 0, opId: 'OP-X', originDeviceId: PEER, at: 1 }],
    ['v 超过上限', { v: 1_000_001, opId: 'OP-X', originDeviceId: PEER, at: 1 }],
    ['opId 带空格', { v: 1, opId: 'OP X', originDeviceId: PEER, at: 1 }],
    ['缺 opId', { v: 1, originDeviceId: PEER, at: 1 }],
    ['originDeviceId 是 __proto__', { v: 1, opId: 'OP-X', originDeviceId: '__proto__', at: 1 }],
    ['at 不是有限数', { v: 1, opId: 'OP-X', originDeviceId: PEER, at: 'now' }],
    ['是数组', [1, 'OP-X']],
    ['是字符串', 'tombstone'],
  ] as const)('C6 应答里的登记畸形（%s）：不当成墓碑，本机会话与消息原样在', async (_name, bad) => {
    const r = rig();
    const s = session(r.chat, 3);
    await quiesce(r);
    r.setHandler((m, p) => {
      if (m === 'sync.list') return { sessions: [{ id: s.sid, lifecycle: bad }], tombstones: [{ id: s.sid, ...(typeof bad === 'object' && !Array.isArray(bad) ? bad : { v: bad }) }] };
      if (m === 'sync.pull' && p.sessionId === s.sid) return { messages: [], markers: [], lifecycle: bad };
      return { mergedCount: 0, orphanMarkerIds: [], hasChange: false, rejected: 'tombstoned', lifecycle: bad };
    });
    await r.reconcile();
    expect(r.chat.isDeleted(s.sid)).toBe(false);
    expect(r.chat.getLifecycle(s.sid)).toBeUndefined();
    expect(r.chat.getSession(s.sid)).toBeDefined();
    expect(r.chat.listMessages(s.sid).map(m => m.id).sort()).toEqual([...s.ids].sort());
  });

  it('C6 应答里的墓碑不比本机登记新（更早的一代、同一条）：不动本机——恢复过的会话不会被旧墓碑再删一次', async () => {
    const r = rig();
    const s = session(r.chat, 2);
    // 本机：被删过（v=1，保留）又恢复（v=2）
    r.chat.applyTombstone(s.sid, tomb('OP-OLD', []), { fromPeer: PEER });
    r.chat.restoreSession(s.sid);
    await quiesce(r);
    const reg = r.chat.getLifecycle(s.sid)!;
    expect(reg.v).toBe(2);
    r.setHandler((m, p) => {
      if (m === 'sync.list') return { sessions: [], tombstones: [{ id: s.sid, v: 1, opId: 'OP-OLD' }] };
      if (m === 'sync.pull' && p.sessionId === s.sid) return { messages: [], markers: [], lifecycle: tomb('OP-OLD', s.ids) };
      return { mergedCount: 0, orphanMarkerIds: [], hasChange: false, lifecycle: tomb('OP-OLD', s.ids) };
    });
    await r.reconcile();
    // 清单里更旧的墓碑不去拉；应答里更旧的墓碑不应用
    expect(r.pulls(s.sid)).toHaveLength(0);
    expect(r.chat.getLifecycle(s.sid)).toMatchObject({ v: 2, opId: reg.opId });
    expect(r.chat.getSession(s.sid)).toBeDefined();
    expect(r.chat.listMessages(s.sid)).toHaveLength(2);
  });

  it('C6 被拒但应答不带登记（对端暂停）：本机副本原样留着，后续分批照样停', async () => {
    const r = rig();
    const s = r.chat.createSession('大会话');
    addMsg(r.chat, s.id, 'a'.repeat(300_000)); addMsg(r.chat, s.id, 'b'.repeat(300_000));
    await quiesce(r);
    r.setHandler(m => (m === 'sync.list' ? { sessions: [], lifecyclePaused: true } : { mergedCount: 0, orphanMarkerIds: [], hasChange: false, rejected: 'tombstoned' }));
    await r.reconcile();
    expect(r.contentPushes(s.id)).toHaveLength(1);
    expect(r.chat.getSession(s.id)).toBeDefined();
    expect(r.chat.listMessages(s.id)).toHaveLength(2);
  });

  it('C7 推送第 2 批失败：不抛、不重试风暴；下一轮对账重新整推', async () => {
    const r = rig();
    const s = r.chat.createSession('大会话');
    addMsg(r.chat, s.id, 'a'.repeat(300_000)); addMsg(r.chat, s.id, 'b'.repeat(300_000)); addMsg(r.chat, s.id, 'c'.repeat(300_000));
    await quiesce(r);
    const total = r.chat.buildPushBatches(s.id).length;
    let n = 0;
    r.setHandler(m => {
      if (m === 'sync.list') return { sessions: [], tombstones: [] };
      if (m === 'sync.push' && ++n === 2) throw new Error('断线');
      return {};
    });
    await r.reconcile();
    expect(r.contentPushes(s.id)).toHaveLength(2);
    r.calls.length = 0;
    r.setHandler(m => (m === 'sync.list' ? { sessions: [], tombstones: [] } : {}));
    await r.reconcile();
    expect(r.contentPushes(s.id)).toHaveLength(total);
  });

  it('C7 推墓碑超时：吞掉，本轮剩下的墓碑不再推；下一次对账补推', async () => {
    const r = rig();
    const a = session(r.chat); const b = session(r.chat);
    r.chat.deleteSession(a.sid); r.chat.deleteSession(b.sid);
    await quiesce(r);
    r.setHandler(m => { if (m === 'sync.list') return { sessions: [], tombstones: [] }; throw new Error('RPC 超时'); });
    await r.reconcile();
    expect(r.tombPushes()).toHaveLength(1); // 第一条失败就停
    r.calls.length = 0;
    r.setHandler(m => (m === 'sync.list' ? { sessions: [], tombstones: [] } : { tombstone: 'applied' }));
    await r.reconcile();
    expect(r.tombPushes().map(c => c.params.sessionId).sort()).toEqual([a.sid, b.sid].sort());
  });

  it('C7 sync.list 失败：存活会话照推，墓碑差量与拉取本轮跳过', async () => {
    const r = rig();
    const t = session(r.chat); const k = session(r.chat);
    r.chat.deleteSession(t.sid);
    await quiesce(r);
    r.setHandler(m => { if (m === 'sync.list') throw new Error('断线'); return {}; });
    await r.reconcile();
    expect(r.contentPushes(k.sid)).toHaveLength(1);
    expect(r.tombPushes()).toHaveLength(0);
    expect(r.pulls()).toHaveLength(0);
  });
});

describe('C8–C9 终止性', () => {
  it('C8 墓碑应用后的回声：重复到达是 duplicate，不再引起任何出站', async () => {
    const r = rig();
    const s = session(r.chat);
    await quiesce(r);
    const T = tomb('OP-PEER', s.ids);
    r.setHandler((m, p) => {
      if (m === 'sync.pull' && p.sessionId === s.sid) return { messages: [], markers: [], lifecycle: T };
      if (m === 'sync.push') return { tombstone: 'duplicate', lifecycle: T };
      return { sessions: [], tombstones: [{ id: s.sid, v: 1, opId: 'OP-PEER' }] };
    });
    r.ob.onRemoteDirty!(PEER, s.sid);
    await r.idle();
    expect(r.chat.isDeleted(s.sid)).toBe(true);
    const settled = r.calls.length;
    const lifecycleEvents: string[] = [];
    r.chat.onLifecycle = e => { lifecycleEvents.push(e.kind); };

    // 对端把同一条墓碑推回来（监听方路径）；对端再发一次 sync.dirty（拨号方路径）
    const echoed = await receiveRemotePayload(r.chat, undefined, s.sid, { messages: [], markers: [], lifecycle: T }, PEER);
    expect(echoed.tombstone).toBe('duplicate');
    await r.idle(1000);
    expect(r.calls.length).toBe(settled);
    r.ob.onRemoteDirty!(PEER, s.sid);
    await r.idle(1000);
    expect(r.calls.slice(settled).map(c => c.method)).toEqual(['sync.pull']);
    expect(lifecycleEvents).toEqual([]);
  });

  it('C9 推内容的应答带更高的偶数登记：拉一次，登记追平；再推应答相同，不再拉', async () => {
    const r = rig();
    const s = session(r.chat);
    await quiesce(r);
    const restored: WireLifecycle = { v: 2, opId: 'REST-OP', originDeviceId: PEER, at: 5 };
    r.setHandler((m, p) => {
      if (m === 'sync.list') return { sessions: [], tombstones: [] };
      if (m === 'sync.pull') return { messages: [], markers: [], session: toWireSession(r.chat.getSession(p.sessionId)!), lifecycle: restored };
      return { mergedCount: 0, orphanMarkerIds: [], hasChange: false, lifecycle: restored };
    });
    await r.reconcile();
    expect(r.pulls(s.sid)).toHaveLength(1);
    expect(r.chat.getLifecycle(s.sid)).toMatchObject({ v: 2, opId: 'REST-OP' });
    expect(r.chat.getSession(s.sid)).toBeDefined();
    // 采纳之后本机会再推一轮（登记变了），这一轮的每一批都带版本
    const after = r.contentPushes(s.sid);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after[after.length - 1].params.payload.lifecycle).toMatchObject({ v: 2, opId: 'REST-OP' });
    r.calls.length = 0;
    await r.reconcile();
    expect(r.pulls(s.sid)).toHaveLength(0);
  });

  it('合并新建了会话行：广播 chat.sessions.changed', async () => {
    const r = rig();
    await quiesce(r);
    const other = new ChatStore(openDb(':memory:'), 'other');
    const s = other.createSession('对端新建的');
    addMsg(other, s.id);
    r.setHandler((m) => {
      if (m === 'sync.list') return { sessions: [{ id: s.id }], tombstones: [] };
      if (m === 'sync.pull') return other.buildPushBatches(s.id)[0];
      return {};
    });
    await r.reconcile();
    expect(r.chat.getSession(s.id)).toBeDefined();
    expect(r.broadcasts.filter(b => b.method === 'chat.sessions.changed')).toHaveLength(1);
    expect(r.broadcasts.filter(b => b.method === 'chat.event' && b.payload.kind === 'synced')).toHaveLength(1);
    // 再对账一轮：没有新行，不再广播
    r.broadcasts.length = 0;
    await r.reconcile();
    expect(r.broadcasts.filter(b => b.method === 'chat.sessions.changed')).toHaveLength(0);
  });
});
