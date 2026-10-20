/** F11B：监听方收发墓碑（设计 §3.3、§3.5、§4.8、§4.9）。
 *
 *  真库加真 ChatStore，createSyncMethods 加伪造的连接对象。钉住的是：
 *   - 墓碑只交给认识它的调用方（本机连接，或声明了 tombstones 能力的对端）；旧版看到的面与以前逐字相同；
 *   - 旧副本推不回来：认识墓碑的对端收到 rejected 加本机登记，旧版收到错误；
 *   - 墓碑载荷不经合并：夹带的消息不落库、不广播「同步了 N 条」；
 *   - 本端暂停时墓碑平面静默；宿主说「现在不能落」时应答照常返回、库不动；
 *   - 垃圾输入不删任何东西；
 *   - sync.ack 不改保留副本的会话行，应答与不存在的会话相同。 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { createSyncMethods, type SyncMethodsOpts } from '../src/minisd/sync/rpc';
import { receiveRemotePayload, type TombstoneHost, type TombstoneOutcome } from '../src/minisd/sync/receive';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import { toWireMessage, toWireSession, type SyncPayload, type WireLifecycle } from '../src/minisd/sync/wire';
import type { RpcConnection, RpcMethods } from '../src/minisd/rpc/server';

const FP = 'aabbccddeeff';
const CAPABLE = { protocolVersion: 2, caps: { tombstones: true } };

let db: Database.Database; let store: ChatStore;
beforeEach(() => { db = openDb(':memory:'); store = new ChatStore(db, 'me'); });

const local = (): RpcConnection => ({ authMode: 'local', notify: () => {} });
/** 声明了 tombstones 能力的已配对对端。 */
const peer = (): RpcConnection => ({ authMode: 'remote', peerFingerprint: FP, syncPeer: CAPABLE, notify: () => {} } as RpcConnection);
/** 旧版对端：做过 hello 但不声明能力位；或经本机回环 ?paseto= 进来、没做过 hello。 */
const legacy = (): RpcConnection => ({ authMode: 'remote', peerFingerprint: FP, syncPeer: { protocolVersion: 2, caps: { attachments: true } }, notify: () => {} } as RpcConnection);
const noHello = (): RpcConnection => ({ authMode: 'remote', peerFingerprint: FP, notify: () => {} });

function addMsg(sid: string): string {
  const id = store.newId();
  store.appendMessage({ id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
  return id;
}
/** 建一个带两条消息的会话，返回它的整包载荷（旧副本）。 */
function seeded(): { sid: string; ids: string[]; payload: SyncPayload } {
  const s = store.createSession('S');
  const ids = [addMsg(s.id), addMsg(s.id)];
  const payload: SyncPayload = { messages: store.listMessages(s.id).map(toWireMessage), markers: [], session: toWireSession(store.getSession(s.id)!) };
  return { sid: s.id, ids, payload };
}
const tomb = (opId: string, ids: string[]): WireLifecycle => ({ v: 1, opId, originDeviceId: FP, at: 1, seen: makeSeen(ids) });
const rows = (table: string, col: string, sid: string): number => (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col}=?`).get(sid) as { c: number }).c;
const call = (m: RpcMethods, name: string, p: unknown, conn: RpcConnection): Promise<any> => Promise.resolve(m[name]!(p as never, conn));

describe('R1 sync.pull 已删会话', () => {
  it('认识墓碑的调用方得到墓碑载荷；旧版得到与以前逐字相同的「会话不存在」', async () => {
    const m = createSyncMethods(store);
    const { sid, ids } = seeded();
    store.deleteSession(sid);
    for (const conn of [peer(), local()]) {
      const r = await call(m, 'sync.pull', { sessionId: sid }, conn);
      expect(r.messages).toEqual([]);
      expect(r.markers).toEqual([]);
      expect(r.session).toBeUndefined();
      expect(r.lifecycle).toMatchObject({ v: 1, originDeviceId: 'me', seen: { count: 2, ids: [...ids].sort() } });
    }
    for (const conn of [legacy(), noHello()]) {
      await expect(call(m, 'sync.pull', { sessionId: sid }, conn)).rejects.toThrow(`sync.pull 会话不存在: ${sid}`);
    }
    // 从未存在过的会话：对谁都是原来的错误
    await expect(call(m, 'sync.pull', { sessionId: 'NOPE' }, peer())).rejects.toThrow('sync.pull 会话不存在: NOPE');
  });

  it('保留副本同样只交出墓碑，不交出内容', async () => {
    const m = createSyncMethods(store);
    const { sid } = seeded();
    store.applyTombstone(sid, tomb('OP1', []));
    expect(rows('messages', 'session_id', sid)).toBe(2);
    const r = await call(m, 'sync.pull', { sessionId: sid }, peer());
    expect(r.messages).toEqual([]);
    expect(r.lifecycle.v).toBe(1);
    await expect(call(m, 'sync.pull', { sessionId: sid }, legacy())).rejects.toThrow(/会话不存在/);
  });

  it('恢复过的存活会话：应答多一个偶数 lifecycle', async () => {
    const m = createSyncMethods(store);
    const { sid } = seeded();
    store.applyTombstone(sid, tomb('OP1', []));
    store.restoreSession(sid);
    const r = await call(m, 'sync.pull', { sessionId: sid }, legacy());
    expect(r.messages).toHaveLength(2);
    expect(r.session.id).toBe(sid);
    expect(r.lifecycle).toMatchObject({ v: 2, originDeviceId: 'me' });
    // 从未删除过的会话不带这个键
    const plain = seeded();
    expect('lifecycle' in await call(m, 'sync.pull', { sessionId: plain.sid }, peer())).toBe(false);
  });
});

describe('R2 sync.list', () => {
  it('旧版看到的键恰为 sessions；认识墓碑的才有 tombstones；已删会话与保留副本不在 sessions 里', async () => {
    const m = createSyncMethods(store);
    const alive = seeded(); const gone = seeded(); const kept = seeded();
    store.deleteSession(gone.sid);
    store.applyTombstone(kept.sid, tomb('OP-K', []));

    for (const conn of [legacy(), noHello()]) {
      const r = await call(m, 'sync.list', {}, conn);
      expect(Object.keys(r)).toEqual(['sessions']);
      expect(r.sessions.map((s: { id: string }) => s.id)).toEqual([alive.sid]);
    }
    for (const conn of [peer(), local()]) {
      const r = await call(m, 'sync.list', {}, conn);
      expect(Object.keys(r).sort()).toEqual(['sessions', 'tombstones']);
      expect(r.sessions.map((s: { id: string }) => s.id)).toEqual([alive.sid]);
      expect(r.tombstones.map((t: { id: string }) => t.id).sort()).toEqual([gone.sid, kept.sid].sort());
      expect(r.tombstones.every((t: Record<string, unknown>) => Object.keys(t).sort().join() === 'id,opId,v')).toBe(true);
      expect(r.sessions[0].lifecycle).toBeUndefined();
    }
  });

  it('恢复过的会话在 sessions 里带 lifecycle 头（对所有调用方）', async () => {
    const m = createSyncMethods(store);
    const { sid } = seeded();
    store.applyTombstone(sid, tomb('OP1', []));
    const { lifecycle } = store.restoreSession(sid);
    for (const conn of [legacy(), peer()]) {
      const r = await call(m, 'sync.list', {}, conn);
      expect(r.sessions[0].lifecycle).toEqual({ v: 2, opId: lifecycle.opId });
    }
  });
});

describe('R3 旧副本 sync.push：不复活', () => {
  it('认识墓碑的对端：返回 rejected 加本机登记，不抛；旧版：抛「被拒：会话已删除」；两种情况库里都没有新行', async () => {
    const merged: string[] = [];
    const m = createSyncMethods(store, { onMergedRemote: (_fp, sid) => { merged.push(sid); } });
    const { sid, payload } = seeded();
    store.deleteSession(sid);

    for (const conn of [peer(), local()]) {
      const r = await call(m, 'sync.push', { sessionId: sid, payload }, conn);
      expect(r).toMatchObject({ rejected: 'tombstoned', mergedCount: 0, hasChange: false });
      expect(r.lifecycle).toMatchObject({ v: 1, originDeviceId: 'me' });
    }
    for (const conn of [legacy(), noHello()]) {
      await expect(call(m, 'sync.push', { sessionId: sid, payload }, conn)).rejects.toThrow(`sync.push 被拒：会话已删除: ${sid}`);
    }
    // 只有消息、没有会话行的分批包同样被拒
    await expect(call(m, 'sync.push', { sessionId: sid, payload: { messages: payload.messages, markers: [] } }, legacy())).rejects.toThrow(/被拒/);
    expect(rows('messages', 'session_id', sid)).toBe(0);
    expect(rows('sessions', 'id', sid)).toBe(0);
    expect(merged).toEqual([]);
  });

  it('借存活会话夹带：外层写存活的会话、消息自带的会话 id 写已删的那个——不落库、不算有变化（认识墓碑的对端与旧版连接都一样）', async () => {
    const merged: string[] = [];
    const m = createSyncMethods(store, { onMergedRemote: (_fp, sid) => { merged.push(sid); } });
    const gone = seeded();
    store.deleteSession(gone.sid);
    const kept = seeded();
    store.applyTombstone(kept.sid, tomb('OP-K', [kept.ids[0]]));
    const alive = seeded();
    const before = store.listRetainedSessions();

    for (const conn of [peer(), legacy(), local()]) {
      for (const target of [gone.sid, kept.sid]) {
        const smuggled = toWireMessage({ id: store.newId(), sessionId: target, role: 'user', parts: [], createdAt: 9, updatedAt: 9, sortOrder: 9, streamInterruptCount: 0 });
        const r = await call(m, 'sync.push', { sessionId: alive.sid, payload: { messages: [smuggled], markers: [] } }, conn);
        expect(r).toMatchObject({ mergedCount: 0, hasChange: false });
        expect(r.rejected).toBeUndefined();
        expect((db.prepare('SELECT COUNT(*) AS c FROM messages WHERE id=?').get(smuggled.id) as { c: number }).c).toBe(0);
      }
    }
    expect(rows('messages', 'session_id', gone.sid)).toBe(0);
    expect(rows('messages', 'session_id', kept.sid)).toBe(2);
    expect(rows('messages', 'session_id', alive.sid)).toBe(2);
    expect(store.listRetainedSessions()).toEqual(before);
    expect(merged).toEqual([]);
  });

  it('存活会话照常合并并回调 onMergedRemote（既有行为不变）', async () => {
    const merged: Array<{ fp: string | undefined; sid: string }> = [];
    const m = createSyncMethods(store, { onMergedRemote: (fp, sid) => { merged.push({ fp, sid }); } });
    const other = new ChatStore(openDb(':memory:'), 'other');
    const s = other.createSession('来自对端');
    other.appendMessage({ id: 'M1', sessionId: s.id, role: 'user', parts: [], createdAt: 1, streamInterruptCount: 0 });
    const r = await call(m, 'sync.push', { sessionId: s.id, payload: other.buildPushBatches(s.id)[0] }, legacy());
    expect(r).toMatchObject({ mergedCount: 1, hasChange: true, sessionCreated: true });
    expect(r.rejected).toBeUndefined();
    expect(r.tombstone).toBeUndefined();
    expect(merged).toEqual([{ fp: FP, sid: s.id }]);
  });
});

describe('R4 墓碑 sync.push：幂等，且不经合并', () => {
  it('第一次 applied，第二次 duplicate；onMergedRemote 一次都不调；夹带的消息没有落库', async () => {
    const merged: string[] = [];
    const m = createSyncMethods(store, { onMergedRemote: (_fp, sid) => { merged.push(sid); } });
    const { sid, ids, payload } = seeded();
    const smuggled = toWireMessage({ id: 'SMUGGLED', sessionId: sid, role: 'user', parts: [], createdAt: 9, updatedAt: 9, sortOrder: 9, streamInterruptCount: 0 });
    const p = { messages: [smuggled], markers: [], session: payload.session, lifecycle: tomb('OP1', ids) };

    const r1 = await call(m, 'sync.push', { sessionId: sid, payload: p }, peer());
    expect(r1).toMatchObject({ tombstone: 'applied', mergedCount: 0 });
    expect(r1.lifecycle).toMatchObject({ v: 1, opId: 'OP1' });
    const reg = db.prepare('SELECT * FROM session_lifecycle WHERE session_id=?').get(sid) as Record<string, unknown>;
    expect(reg.received_from).toBe(FP);
    const r2 = await call(m, 'sync.push', { sessionId: sid, payload: p }, peer());
    expect(r2).toMatchObject({ tombstone: 'duplicate', hasChange: false });
    expect(db.prepare('SELECT * FROM session_lifecycle WHERE session_id=?').get(sid)).toEqual(reg);

    expect(merged).toEqual([]);
    expect(rows('messages', 'session_id', sid)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM messages WHERE id=?').get('SMUGGLED') as { c: number }).c).toBe(0);
    expect(rows('sessions', 'id', sid)).toBe(0);
  });

  it('旧版连接推来墓碑载荷也按墓碑处理（能力位只管本端发不发，不管收）', async () => {
    const m = createSyncMethods(store);
    const { sid, ids } = seeded();
    const r = await call(m, 'sync.push', { sessionId: sid, payload: { messages: [], markers: [], lifecycle: tomb('OP1', ids) } }, legacy());
    expect(r.tombstone).toBe('applied');
    expect(store.isDeleted(sid)).toBe(true);
  });
});

describe('R5 本端暂停：墓碑平面对 remote 连接静默', () => {
  it('sync.list 带 lifecyclePaused、不带 tombstones；sync.pull 已删会话抛「会话不存在」；被拒应答不带 lifecycle；本机连接照常', async () => {
    let paused = true;
    const m = createSyncMethods(store, { isPaused: () => paused });
    const { sid, payload } = seeded();
    store.deleteSession(sid);

    const list = await call(m, 'sync.list', {}, peer());
    expect(list.lifecyclePaused).toBe(true);
    expect('tombstones' in list).toBe(false);
    await expect(call(m, 'sync.pull', { sessionId: sid }, peer())).rejects.toThrow(`sync.pull 会话不存在: ${sid}`);
    const pushed = await call(m, 'sync.push', { sessionId: sid, payload }, peer());
    expect(pushed.rejected).toBe('tombstoned');
    expect('lifecycle' in pushed).toBe(false);
    // 旧版照旧抛错（闸是本机保护，不受暂停影响）
    await expect(call(m, 'sync.push', { sessionId: sid, payload }, legacy())).rejects.toThrow(/被拒/);
    expect(Object.keys(await call(m, 'sync.list', {}, legacy()))).toEqual(['sessions']);
    expect(rows('messages', 'session_id', sid)).toBe(0);

    // 本机连接不受静默影响
    const l = await call(m, 'sync.list', {}, local());
    expect(l.tombstones).toHaveLength(1);
    expect('lifecyclePaused' in l).toBe(false);
    expect((await call(m, 'sync.pull', { sessionId: sid }, local())).lifecycle.v).toBe(1);
    expect((await call(m, 'sync.push', { sessionId: sid, payload }, local())).lifecycle.v).toBe(1);

    // 恢复之后 remote 连接重新看得到
    paused = false;
    expect((await call(m, 'sync.list', {}, peer())).tombstones).toHaveLength(1);
    expect((await call(m, 'sync.pull', { sessionId: sid }, peer())).lifecycle.v).toBe(1);
  });
});

describe('R6 宿主说现在不能落：应答照常返回，库不动', () => {
  for (const reason of ['paused', 'run-stopping', 'unpaired', 'closing'] as const) {
    it(`deferred / ${reason}`, async () => {
      const seen: Array<{ sid: string; t: WireLifecycle; from: string | undefined }> = [];
      const host: TombstoneHost = {
        applyRemoteTombstone: async (sid, t, from): Promise<TombstoneOutcome> => { seen.push({ sid, t, from }); return { status: 'deferred', reason }; },
      };
      const opts: SyncMethodsOpts = { lifecycleHost: host };
      const m = createSyncMethods(store, opts);
      const { sid, ids } = seeded();
      const r = await call(m, 'sync.push', { sessionId: sid, payload: { messages: [], markers: [], lifecycle: tomb('OP1', ids) } }, peer());
      expect(r).toMatchObject({ tombstone: 'deferred', mergedCount: 0, hasChange: false });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ sid, from: FP });
      expect(seen[0].t).toMatchObject({ v: 1, opId: 'OP1' });
      expect(store.getSession(sid)).toBeDefined();
      expect(rows('messages', 'session_id', sid)).toBe(2);
      expect(store.getLifecycle(sid)).toBeUndefined();
    });
  }

  it('有宿主时内容仍走合并，不经宿主', async () => {
    let called = 0;
    const host: TombstoneHost = { applyRemoteTombstone: async () => { called++; return { status: 'deferred', reason: 'paused' }; } };
    const m = createSyncMethods(store, { lifecycleHost: host });
    const { sid, payload } = seeded();
    const r = await call(m, 'sync.push', { sessionId: sid, payload }, peer());
    expect(r.tombstone).toBeUndefined();
    expect(called).toBe(0);
  });
});

describe('R7 垃圾输入不删任何东西', () => {
  it('载荷不是对象、messages 或 markers 不是数组、会话 id 不合规：抛错且库不变', async () => {
    const m = createSyncMethods(store);
    const { sid } = seeded();
    const bad: unknown[] = [undefined, null, 'x', 7, [], { messages: 'x', markers: [] }, { messages: [], markers: {} }, { messages: [] }, { lifecycle: tomb('OP1', []) }];
    for (const payload of bad) {
      await expect(call(m, 'sync.push', { sessionId: sid, payload }, peer()), JSON.stringify(payload)).rejects.toThrow();
    }
    for (const sessionId of [undefined, '', 7, 'x'.repeat(129)]) {
      await expect(call(m, 'sync.push', { sessionId, payload: { messages: [], markers: [], lifecycle: tomb('OP1', []) } }, peer())).rejects.toThrow('同步载荷不合规');
    }
    expect(store.getSession(sid)).toBeDefined();
    expect(rows('messages', 'session_id', sid)).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM session_lifecycle').get() as { c: number }).c).toBe(0);
  });

  it('畸形 lifecycle 加正常消息：按不带版本合并，不当成墓碑', async () => {
    const m = createSyncMethods(store);
    const { sid, payload } = seeded();
    const extra = toWireMessage({ id: 'EXTRA', sessionId: sid, role: 'user', parts: [], createdAt: 9, updatedAt: 9, sortOrder: 9, streamInterruptCount: 0 });
    for (const lifecycle of [{ v: 1 }, { v: 0, opId: 'X', originDeviceId: FP, at: 1 }, { v: '1', opId: 'X', originDeviceId: FP, at: 1 }, 'tombstone', { v: 1, opId: 'X', originDeviceId: '__proto__', at: 1 }]) {
      const r = await call(m, 'sync.push', { sessionId: sid, payload: { ...payload, messages: [...payload.messages, extra], lifecycle } }, peer());
      expect(r.tombstone, JSON.stringify(lifecycle)).toBeUndefined();
      expect(r.rejected).toBeUndefined();
    }
    expect(store.getSession(sid)).toBeDefined();
    expect(rows('messages', 'session_id', sid)).toBe(3);
    expect(store.getLifecycle(sid)).toBeUndefined();
  });

  it('receiveRemotePayload 没有宿主时直接落库（单测路径），结果带本机登记', async () => {
    const { sid, ids } = seeded();
    const r = await receiveRemotePayload(store, undefined, sid, { messages: [], markers: [], lifecycle: tomb('OP1', ids) }, 'peerX');
    expect(r).toMatchObject({ tombstone: 'applied', mergedCount: 0, orphanMarkerIds: [] });
    expect(r.lifecycle).toMatchObject({ v: 1, opId: 'OP1' });
    expect(store.getLifecycle(sid)!.receivedFrom).toBe('peerX');
  });
});

describe('R8 方法名单不变', () => {
  it('sync.* 仍是六个', () => {
    expect(Object.keys(createSyncMethods(store)).sort()).toEqual(['sync.ack', 'sync.cursor', 'sync.hello', 'sync.list', 'sync.pull', 'sync.push']);
  });
});

describe('R9 sync.ack：保留副本的会话行不动，应答与不存在的会话分不出来', () => {
  const rowOf = (sid: string): Record<string, unknown> | undefined =>
    db.prepare('SELECT * FROM sessions WHERE id=?').get(sid) as Record<string, unknown> | undefined;

  it('保留副本、已清除的、从未存在的：对谁都回 { ok: true }（暂停与否一样），库里一列都不改；存活的、恢复过的照常记', async () => {
    let paused = false;
    const m = createSyncMethods(store, { isPaused: () => paused });
    const alive = seeded(); const kept = seeded(); const gone = seeded();
    store.applyTombstone(kept.sid, tomb('OP-K', []));
    store.deleteSession(gone.sid);
    const frozen = rowOf(kept.sid)!;
    expect(frozen.last_synced_at).toBeNull();
    expect(frozen.remote_tombstoned_at).not.toBeNull();

    for (const p of [false, true]) {
      paused = p;
      for (const conn of [peer(), legacy(), noHello(), local()]) {
        for (const sid of [kept.sid, gone.sid, 'NOPE']) {
          expect(await call(m, 'sync.ack', { sessionId: sid, lastMergedTs: 777 }, conn), `${sid} paused=${p}`).toEqual({ ok: true });
        }
      }
    }
    // 保留副本是冻结的：last_synced_at 也不改
    expect(rowOf(kept.sid)).toEqual(frozen);
    expect(rowOf(gone.sid)).toBeUndefined();
    expect(rowOf('NOPE')).toBeUndefined();
    expect(store.listRetainedSessions().map(r => r.id)).toEqual([kept.sid]);

    // 存活的会话照常记（既有行为）
    paused = false;
    await call(m, 'sync.ack', { sessionId: alive.sid, lastMergedTs: 12.5 }, peer());
    expect(rowOf(alive.sid)!.last_synced_at).toBe(12.5);
    // 恢复之后是普通的存活会话
    store.restoreSession(kept.sid);
    await call(m, 'sync.ack', { sessionId: kept.sid, lastMergedTs: 99 }, legacy());
    expect(rowOf(kept.sid)).toMatchObject({ last_synced_at: 99, remote_tombstoned_at: null });
  });
});
