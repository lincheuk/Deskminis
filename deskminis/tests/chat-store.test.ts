import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import type Database from 'better-sqlite3';

let db: Database.Database; let store: ChatStore;
beforeEach(() => { db = openDb(':memory:'); store = new ChatStore(db); });

describe('ChatStore', () => {
  it('建会话 + 追加消息 + 读回', () => {
    const s = store.createSession('测试会话');
    const m = store.appendMessage({
      id: 'A'.repeat(36), sessionId: s.id, role: 'user',
      parts: [{ type: 'text', value: 'hi' }], createdAt: store.nowEpoch(), streamInterruptCount: 0,
    });
    expect(m.sortOrder).toBe(0);
    const list = store.listMessages(s.id);
    expect(list).toHaveLength(1);
    expect(list[0].parts).toEqual([{ type: 'text', value: 'hi' }]);
  });
  it('sortOrder 递增, listMessages 按 created_at,id 排序', () => {
    const s = store.createSession();
    const t = store.nowEpoch();
    const base = { sessionId: s.id, role: 'user' as const, parts: [], streamInterruptCount: 0 };
    store.appendMessage({ ...base, id: 'B2', createdAt: t + 1 });
    store.appendMessage({ ...base, id: 'B1', createdAt: t });
    const list = store.listMessages(s.id);
    expect(list.map(m => m.id)).toEqual(['B1', 'B2']);
    expect(store.appendMessage({ ...base, id: 'B3', createdAt: t + 2 }).sortOrder).toBe(2);
  });
  it('updateMessage 改 parts 与 errorInfo', () => {
    const s = store.createSession();
    store.appendMessage({ id: 'C1', sessionId: s.id, role: 'assistant', parts: [], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    store.updateMessage('C1', { parts: [{ type: 'text', value: 'done' }], errorInfo: 'boom' });
    const m = store.listMessages(s.id)[0];
    expect(m.parts).toEqual([{ type: 'text', value: 'done' }]);
    expect(m.errorInfo).toBe('boom');
  });
  it('deleteSession 级联删消息', () => {
    const s = store.createSession();
    store.appendMessage({ id: 'D1', sessionId: s.id, role: 'user', parts: [], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    store.deleteSession(s.id);
    expect(store.getSession(s.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 0 });
  });
});

describe('ChatStore modelBinding', () => {
  it('setModelBinding 写 provider: 前缀', () => {
    const s = store.createSession();
    store.setModelBinding(s.id, 'provider:ABC-123');
    const got = store.getSession(s.id);
    expect(got?.modelBinding).toBe('provider:ABC-123');
  });

  it('setModelBinding 写 group: 前缀', () => {
    const s = store.createSession();
    store.setModelBinding(s.id, 'group:GID-456');
    expect(store.getSession(s.id)?.modelBinding).toBe('group:GID-456');
  });

  it('setModelBinding undefined → 清除绑定（写 NULL）', () => {
    const s = store.createSession();
    store.setModelBinding(s.id, 'provider:ABC');
    store.setModelBinding(s.id, undefined);
    expect(store.getSession(s.id)?.modelBinding).toBeUndefined();
  });

  it('setModelBinding 空串 → 同 undefined（清除）', () => {
    const s = store.createSession();
    store.setModelBinding(s.id, 'group:G');
    store.setModelBinding(s.id, '');
    expect(store.getSession(s.id)?.modelBinding).toBeUndefined();
  });
});

describe('ChatStore compact_markers', () => {
  it('appendCompactMarker + getLatestCompactMarker', () => {
    const store = new ChatStore(openDb(':memory:'));
    const s = store.createSession();
    const m1 = store.appendCompactMarker(s.id, '摘要1', 'MSG1');
    expect(m1.id).toBeTruthy();
    expect(m1.summary).toBe('摘要1');
    expect(m1.lastCompactedMessageId).toBe('MSG1');
    const got = store.getLatestCompactMarker(s.id);
    expect(got?.summary).toBe('摘要1');
  });

  it('getLatestCompactMarker: 多个 marker 返回最新（createdAt 最大）', () => {
    const store = new ChatStore(openDb(':memory:'));
    const s = store.createSession();
    store.appendCompactMarker(s.id, '旧', 'MSG1');
    // 确保 createdAt 递增
    const m2 = store.appendCompactMarker(s.id, '新', 'MSG2');
    const got = store.getLatestCompactMarker(s.id);
    expect(got?.summary).toBe('新');
    expect(got?.lastCompactedMessageId).toBe('MSG2');
  });

  it('getLatestCompactMarker: 无 marker 返回 undefined', () => {
    const store = new ChatStore(openDb(':memory:'));
    const s = store.createSession();
    expect(store.getLatestCompactMarker(s.id)).toBeUndefined();
  });

  it('getLatestCompactMarker: 跨会话隔离', () => {
    const store = new ChatStore(openDb(':memory:'));
    const a = store.createSession();
    const b = store.createSession();
    store.appendCompactMarker(a.id, 'A摘要', 'MA');
    expect(store.getLatestCompactMarker(b.id)).toBeUndefined();
  });
});
