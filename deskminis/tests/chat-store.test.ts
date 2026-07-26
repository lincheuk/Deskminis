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
