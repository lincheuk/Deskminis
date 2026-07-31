import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { toWireMessage, type WireMessage, type WireCompactMarker } from '../src/minisd/sync/wire';
import type Database from 'better-sqlite3';

let db: Database.Database; let store: ChatStore;
beforeEach(() => { db = openDb(':memory:'); store = new ChatStore(db, 'me'); });

function mkMsg(id: string, sid: string, origin: string, localTs: number, sortOrder: number) {
  return {
    id, sessionId: sid, role: 'user' as const,
    parts: [{ type: 'text' as const, value: 'x' }],
    createdAt: localTs, updatedAt: localTs, sortOrder, streamInterruptCount: 0,
    originDeviceId: origin, createdLocallyAt: localTs,
  };
}

describe('ChatStore.mergeRemoteSession', () => {
  it('远端新消息 → INSERT OR IGNORE 落库', () => {
    const s = store.createSession();
    const remote: WireMessage[] = [toWireMessage(mkMsg('R1', s.id, 'phone', 100.0, 0) as any)];
    const r = store.mergeRemoteSession({ messages: remote, markers: [] }, s.id);
    expect(r.mergedCount).toBe(1);
    const list = store.listMessages(s.id);
    expect(list.map(m => m.id)).toContain('R1');
    expect(list.find(m => m.id === 'R1')?.originDeviceId).toBe('phone');
  });

  it('id 重复 → 跳过（parts_json 永不改写红线）', () => {
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('DUP', s.id, 'me', 1.0, 0), parts: [{ type: 'text', value: 'local原文' }] });
    // 远端同 id 不同 parts（理论不会，但容错测试）
    const remoteMsg = { ...toWireMessage(mkMsg('DUP', s.id, 'phone', 2.0, 5) as any), partsJson: JSON.stringify([{ type: 'text', value: 'remote篡改' }]) };
    store.mergeRemoteSession({ messages: [remoteMsg], markers: [] }, s.id);
    const list = store.listMessages(s.id);
    expect(list.find(m => m.id === 'DUP')?.parts).toEqual([{ type: 'text', value: 'local原文' }]); // local 胜
  });

  it('sortOrder 按合并后序重排（UPDATE sort_order，不改 parts_json）', () => {
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('A', s.id, 'me', 2.0, 0), parts: [{ type: 'text', value: 'a' }] });
    store.appendMessage({ ...mkMsg('B', s.id, 'me', 1.0, 1), parts: [{ type: 'text', value: 'b' }] });
    // 远端推一条更早的 → sortOrder 重排
    store.mergeRemoteSession({ messages: [toWireMessage(mkMsg('Z', s.id, 'aaa', 0.5, 0) as any)], markers: [] }, s.id);
    const list = store.listMessages(s.id);
    expect(list.map(m => m.id)).toEqual(['Z', 'B', 'A']); // (originDeviceId, createdLocallyAt) 序
    expect(list.map(m => m.sortOrder)).toEqual([0, 1, 2]);
    // parts 不变
    expect(list.find(m => m.id === 'A')?.parts).toEqual([{ type: 'text', value: 'a' }]);
  });

  it('远端 marker → INSERT OR IGNORE + LWW 决定是否 UPDATE', () => {
    const s = store.createSession();
    store.appendMessage(mkMsg('A', s.id, 'me', 1.0, 0) as any);
    store.appendCompactMarker(s.id, 'local摘要', 'A');
    // 远端同 id 不同 summary，createdAt 更晚 → LWW 远端胜
    const localMarker = store.getLatestCompactMarker(s.id)!;
    const remoteMarker: WireCompactMarker = {
      id: localMarker.id, sessionId: s.id, summary: 'remote摘要', createdAt: localMarker.createdAt + 100,
      lastCompactedMessageId: 'A', firstKeptSortOrder: 1, compactedCount: 1, version: 2,
    };
    store.mergeRemoteSession({ messages: [], markers: [remoteMarker] }, s.id);
    const got = store.getLatestCompactMarker(s.id);
    expect(got?.summary).toBe('remote摘要');
  });

  it('session 元数据 LWW on updatedAt', () => {
    const s = store.createSession();
    const oldUpdatedAt = s.updatedAt;
    const remote = { messages: [], markers: [], session: { id: s.id, title: '远端改名', createdAt: s.createdAt, updatedAt: oldUpdatedAt + 100, memoryEnabled: 1 } };
    store.mergeRemoteSession(remote as any, s.id);
    const got = store.getSession(s.id);
    expect(got?.title).toBe('远端改名');
    expect(got?.updatedAt).toBe(oldUpdatedAt + 100);
  });

  it('raw history 永不改写：UPDATE 只碰 sort_order / updated_at，不改 parts_json / role / created_at', () => {
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('A', s.id, 'me', 1.0, 0), role: 'user', parts: [{ type: 'text', value: '原文' }] });
    // 故意推一条同 id 不同 role/parts/createdAt 的远端消息
    const hack: WireMessage = {
      ...toWireMessage(mkMsg('A', s.id, 'phone', 999.0, 5) as any),
      role: 'assistant', partsJson: JSON.stringify([{ type: 'text', value: '篡改' }]),
    };
    store.mergeRemoteSession({ messages: [hack], markers: [] }, s.id);
    const row = db.prepare('SELECT parts_json, role, created_at FROM messages WHERE id=?').get('A') as any;
    expect(row.role).toBe('user'); // 不改
    expect(JSON.parse(row.parts_json)).toEqual([{ type: 'text', value: '原文' }]); // 不改
    expect(row.created_at).toBe(1.0); // 不改
  });

  it('orphan marker 入 sync_orphan_markers，不入 compact_markers（评审命门 2 红线）', () => {
    const s = store.createSession();
    store.appendMessage(mkMsg('A', s.id, 'me', 1.0, 0) as any);
    // 远端 marker firstKeptMessageId='B'（B 不在本地）→ orphan
    const remoteMarker: WireCompactMarker = {
      id: 'MK_ORPHAN', sessionId: s.id, summary: 'phone压缩', createdAt: 200.0,
      lastCompactedMessageId: undefined, firstKeptMessageId: 'B',
      firstKeptSortOrder: 1, compactedCount: 1, version: 2,
    };
    const r = store.mergeRemoteSession({ messages: [], markers: [remoteMarker] }, s.id);
    expect(r.orphanMarkerIds).toEqual(['MK_ORPHAN']);
    // orphan 行在 sync_orphan_markers
    const orphanRow = db.prepare('SELECT id, summary FROM sync_orphan_markers WHERE session_id=?').get(s.id) as any;
    expect(orphanRow.id).toBe('MK_ORPHAN');
    expect(orphanRow.summary).toBe('phone压缩');
    // compact_markers 表为空——getLatestCompactMarker 返回 undefined（不污染 buildEffectiveHistory）
    expect(store.getLatestCompactMarker(s.id)).toBeUndefined();
    const compactRows = db.prepare('SELECT COUNT(*) c FROM compact_markers WHERE session_id=?').get(s.id) as any;
    expect(compactRows.c).toBe(0);
  });

  it('orphan marker 脱孤：补齐消息后转 compact_markers + 删 sync_orphan_markers', () => {
    const s = store.createSession();
    store.appendMessage(mkMsg('A', s.id, 'me', 1.0, 0) as any);
    // 第一次合并：firstKeptMessageId='B' → orphan
    const remoteMarker: WireCompactMarker = {
      id: 'MK_ORPHAN', sessionId: s.id, summary: 'phone压缩', createdAt: 200.0,
      lastCompactedMessageId: undefined, firstKeptMessageId: 'B',
      firstKeptSortOrder: 1, compactedCount: 1, version: 2,
    };
    store.mergeRemoteSession({ messages: [], markers: [remoteMarker] }, s.id);
    expect(store.getLatestCompactMarker(s.id)).toBeUndefined(); // 仍 orphan

    // 第二次合并：补 B 进来 → 脱孤
    const remoteMsgB = toWireMessage(mkMsg('B', s.id, 'phone', 2.0, 1) as any);
    store.mergeRemoteSession({ messages: [remoteMsgB], markers: [remoteMarker] }, s.id);
    // 已转 compact_markers
    const got = store.getLatestCompactMarker(s.id);
    expect(got).toBeDefined();
    expect(got?.summary).toBe('phone压缩');
    expect(got?.lastCompactedMessageId).toBe('A'); // B 的前一条
    // sync_orphan_markers 已删
    const orphanCount = db.prepare('SELECT COUNT(*) c FROM sync_orphan_markers WHERE session_id=?').get(s.id) as any;
    expect(orphanCount.c).toBe(0);
  });
});

describe('ChatStore.listCompactMarkers', () => {
  it('返回会话全部 marker（按 createdAt ASC）', () => {
    const s = store.createSession();
    store.appendCompactMarker(s.id, '旧', 'A');
    store.appendCompactMarker(s.id, '新', 'B');
    const list = store.listCompactMarkers(s.id);
    expect(list).toHaveLength(2);
    expect(list[0].summary).toBe('旧');
    expect(list[1].summary).toBe('新');
  });
});

describe('ChatStore.getSessionCursor', () => {
  it('返回 lastMessageTs + lastMarkerTs', () => {
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('A', s.id, 'me', 100.0, 0), parts: [] } as any);
    store.appendMessage({ ...mkMsg('B', s.id, 'me', 200.0, 1), parts: [] } as any);
    store.appendCompactMarker(s.id, '摘要', 'A');
    const cursor = store.getSessionCursor(s.id);
    expect(cursor.lastMessageTs).toBe(200.0);
    expect(cursor.lastMarkerTs).toBe(store.getLatestCompactMarker(s.id)!.createdAt);
  });

  it('无消息无 marker → { lastMessageTs: 0, lastMarkerTs: 0 }', () => {
    const s = store.createSession();
    const cursor = store.getSessionCursor(s.id);
    expect(cursor).toEqual({ lastMessageTs: 0, lastMarkerTs: 0 });
  });
});

describe('ChatStore.onDirty 钩子（Task 6 SyncCoordinator 用）', () => {
  it('appendMessage 后触发 onDirty(sid)', () => {
    const dirty: string[] = [];
    store.onDirty = sid => dirty.push(sid);
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('A', s.id, 'me', 1.0, 0), parts: [] } as any);
    expect(dirty).toContain(s.id);
  });

  it('appendCompactMarker 后触发 onDirty(sid)', () => {
    const dirty: string[] = [];
    store.onDirty = sid => dirty.push(sid);
    const s = store.createSession();
    store.appendCompactMarker(s.id, '摘要', 'A');
    expect(dirty).toContain(s.id);
  });
});
