import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import type Database from 'better-sqlite3';

/** H1 文本选区注释——存储层（设计稿 §1-3/§1-5）。
 *  锚定模型 = W3C TextQuoteSelector：库里只存 exact/prefix/suffix 与笔记，
 *  不存任何 DOM 偏移（重渲染即失效的东西不落库），重锚定是 renderer 的事。 */

let db: Database.Database; let store: ChatStore;
beforeEach(() => { db = openDb(':memory:'); store = new ChatStore(db); });

describe('迁移 [8] annotations', () => {
  it('新库 user_version=9 且 annotations 表与会话索引就位', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(9);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='annotations'").get();
    expect(t).toBeTruthy();
    const i = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_annotations_session'").get();
    expect(i).toBeTruthy();
  });
});

describe('AnnotationStore（ChatStore 注释面）', () => {
  it('add + list 读回：字段完整、缺省 note/color 为空串', () => {
    const s = store.createSession();
    const a = store.addAnnotation({ sessionId: s.id, messageId: 'M1', exact: '这段结论', prefix: '前文', suffix: '后文' });
    expect(a.id).toMatch(/^[0-9A-F-]{36}$/);
    const list = store.listAnnotations(s.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: a.id, sessionId: s.id, messageId: 'M1',
      exact: '这段结论', prefix: '前文', suffix: '后文', note: '', color: '',
    });
    expect(list[0].createdAt).toBeGreaterThan(0);
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(list[0].createdAt);
  });

  it('list 按插入顺序稳定返回（created_at 同刻靠 rowid 决序——Windows 时钟 15ms 分辨率教训）', () => {
    const s = store.createSession();
    const a1 = store.addAnnotation({ sessionId: s.id, messageId: 'M1', exact: '甲' });
    const a2 = store.addAnnotation({ sessionId: s.id, messageId: 'M1', exact: '乙' });
    const a3 = store.addAnnotation({ sessionId: s.id, messageId: 'M2', exact: '丙' });
    expect(store.listAnnotations(s.id).map(x => x.id)).toEqual([a1.id, a2.id, a3.id]);
  });

  it('会话隔离：list 只回本会话的注释', () => {
    const s1 = store.createSession(); const s2 = store.createSession();
    store.addAnnotation({ sessionId: s1.id, messageId: 'M1', exact: 'A' });
    store.addAnnotation({ sessionId: s2.id, messageId: 'M9', exact: 'B' });
    expect(store.listAnnotations(s1.id).map(x => x.exact)).toEqual(['A']);
    expect(store.listAnnotations(s2.id).map(x => x.exact)).toEqual(['B']);
  });

  it('updateAnnotationNote 只改 note；返回所属会话 id；未知 id 返回 undefined 不抛', () => {
    const s = store.createSession();
    const a = store.addAnnotation({ sessionId: s.id, messageId: 'M1', exact: 'X', note: '旧' });
    expect(store.updateAnnotationNote(a.id, '新笔记')).toBe(s.id);
    const got = store.listAnnotations(s.id)[0];
    expect(got.note).toBe('新笔记');
    expect(got.exact).toBe('X');
    expect(store.updateAnnotationNote('不存在', 'x')).toBeUndefined();
  });

  it('removeAnnotation 删行并返回所属会话 id；未知 id 返回 undefined 不抛', () => {
    const s = store.createSession();
    const a = store.addAnnotation({ sessionId: s.id, messageId: 'M1', exact: 'X' });
    expect(store.removeAnnotation(a.id)).toBe(s.id);
    expect(store.listAnnotations(s.id)).toHaveLength(0);
    expect(store.removeAnnotation(a.id)).toBeUndefined();
  });

  it('超长入参在存储层截断（prefix/suffix 64、exact/note 20000）——本地 RPC 也不给无界写入面', () => {
    const s = store.createSession();
    const a = store.addAnnotation({
      sessionId: s.id, messageId: 'M1',
      exact: 'e'.repeat(30000), prefix: 'p'.repeat(200), suffix: 's'.repeat(200), note: 'n'.repeat(30000),
    });
    const got = store.listAnnotations(s.id)[0];
    expect(got.exact.length).toBe(20000);
    expect(got.prefix.length).toBe(64);
    expect(got.suffix.length).toBe(64);
    expect(got.note.length).toBe(20000);
    store.updateAnnotationNote(a.id, 'z'.repeat(30000));
    expect(store.listAnnotations(s.id)[0].note.length).toBe(20000);
  });

  it('deleteSession 级联删注释（与 messages/compact_markers 同事务）', () => {
    const s = store.createSession();
    store.addAnnotation({ sessionId: s.id, messageId: 'M1', exact: 'X' });
    store.deleteSession(s.id);
    const n = db.prepare('SELECT COUNT(*) c FROM annotations WHERE session_id=?').get(s.id) as { c: number };
    expect(n.c).toBe(0);
  });
});
