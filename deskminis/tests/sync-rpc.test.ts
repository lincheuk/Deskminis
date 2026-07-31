import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import { toWireMessage } from '../src/minisd/sync/wire';
import type { AuthMode, RpcConnection, RpcMethods } from '../src/minisd/rpc/server';
import type Database from 'better-sqlite3';

let db: Database.Database; let store: ChatStore; let methods: RpcMethods;
beforeEach(() => { db = openDb(':memory:'); store = new ChatStore(db, 'me'); methods = createSyncMethods(store); });

function makeConn(mode: AuthMode): RpcConnection {
  return { authMode: mode, notify: () => {} };
}

describe('sync.push（local + remote 可调，pairing 拒）', () => {
  it('local 模式推远端消息 → mergeRemoteSession 落库', async () => {
    const s = store.createSession();
    const remoteMsg = toWireMessage({
      id: 'R1', sessionId: s.id, role: 'user', parts: [{ type: 'text', value: 'x' }],
      createdAt: 100.0, updatedAt: 100.0, sortOrder: 0, streamInterruptCount: 0,
      originDeviceId: 'phone', createdLocallyAt: 100.0,
    } as any);
    const r = await methods['sync.push']!({ sessionId: s.id, payload: { messages: [remoteMsg], markers: [] } }, makeConn('local')) as any;
    expect(r.mergedCount).toBe(1);
    expect(store.listMessages(s.id).map(m => m.id)).toContain('R1');
  });

  it('remote 模式推 → 同样可调', async () => {
    const s = store.createSession();
    const remoteMsg = toWireMessage({
      id: 'R2', sessionId: s.id, role: 'user', parts: [], createdAt: 100.0, updatedAt: 100.0, sortOrder: 0, streamInterruptCount: 0,
      originDeviceId: 'phone', createdLocallyAt: 100.0,
    } as any);
    const r = await methods['sync.push']!({ sessionId: s.id, payload: { messages: [remoteMsg], markers: [] } }, makeConn('remote')) as any;
    expect(r.mergedCount).toBe(1);
  });

  it('pairing 模式 → 拒', async () => {
    await expect(methods['sync.push']!({}, makeConn('pairing'))).rejects.toThrow(/local|remote|authMode/i);
  });

  it('payload 超 1MB → 拒', async () => {
    const s = store.createSession();
    const bigPayload = { messages: [{ id: 'X', sessionId: s.id, role: 'user', partsJson: 'x'.repeat(2 * 1024 * 1024), tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0, sortOrder: 0, createdAt: 1.0, updatedAt: 1.0, originDeviceId: 'x', createdLocallyAt: 1.0 }], markers: [] };
    await expect(methods['sync.push']!({ sessionId: s.id, payload: bigPayload }, makeConn('local'))).rejects.toThrow(/1MB|payload/i);
  });
});

describe('sync.pull（增量拉取）', () => {
  it('local 模式拉本地增量', async () => {
    const s = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 100.0, streamInterruptCount: 0 } as any);
    store.appendMessage({ id: 'B', sessionId: s.id, role: 'user', parts: [], createdAt: 200.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.pull']!({ sessionId: s.id, afterTs: 150.0 }, makeConn('local')) as any;
    expect(r.messages.map((m: any) => m.id)).toEqual(['B']); // 只拉 afterTs 之后的
  });

  it('remote 模式拉 → 同样可调', async () => {
    const s = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.pull']!({ sessionId: s.id, afterTs: 0 }, makeConn('remote')) as any;
    expect(r.messages).toHaveLength(1);
  });

  it('pairing 模式 → 拒', async () => {
    await expect(methods['sync.pull']!({}, makeConn('pairing'))).rejects.toThrow(/local|remote|authMode/i);
  });
});

describe('sync.cursor', () => {
  it('返回各会话 cursor', async () => {
    const s = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 100.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.cursor']!({ sessionIds: [s.id] }, makeConn('remote')) as any;
    expect(r).toHaveLength(1);
    expect(r[0].sessionId).toBe(s.id);
    expect(r[0].lastMessageTs).toBe(100.0);
  });

  it('不传 sessionIds → 返回本地全部会话 cursor', async () => {
    const s1 = store.createSession();
    const s2 = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s1.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.cursor']!({}, makeConn('local')) as any;
    expect(r).toHaveLength(2);
  });
});

describe('sync.list', () => {
  it('返回本地全部会话 + cursor', async () => {
    const s = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.list']!({}, makeConn('remote')) as any;
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].id).toBe(s.id);
    expect(r.sessions[0].cursor.lastMessageTs).toBe(1.0);
  });
});

describe('sync.ack（更新 last_synced_at）', () => {
  it('local 模式 ack → 更新 sessions.last_synced_at', async () => {
    const s = store.createSession();
    await methods['sync.ack']!({ sessionId: s.id, lastMergedTs: 1234.5 }, makeConn('local'));
    const row = db.prepare('SELECT last_synced_at FROM sessions WHERE id=?').get(s.id) as any;
    expect(row.last_synced_at).toBe(1234.5);
  });
});

describe('方法面只含 sync.* 五个', () => {
  it('createSyncMethods 返回的方法集 keys', () => {
    expect(Object.keys(methods).sort()).toEqual(['sync.ack', 'sync.cursor', 'sync.list', 'sync.pull', 'sync.push']);
  });
});
