/** F03：compact_marker_meta 迁移只追加新表与索引；旧 marker 升级后行不变、读出来没有 meta、有效历史与旧实现相同。 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { CompactEngine } from '../src/minisd/agent/compact';
import { buildCompactMeta, defaultToolKindOf, parseSummaryReply } from '../src/minisd/agent/compact-meta';
import { toWireMarker } from '../src/minisd/sync/wire';
import type { AgentMessage, CompactMarker, RawMessage } from '../src/shared/types';

const SID = '11111111-2222-4333-8444-555555555555';
// 按内容查迁移下标，不写死编号（F11B、F08 也在追加迁移，合并顺序由主会话定）
const idx = MIGRATIONS.findIndex(m => m.includes('CREATE TABLE compact_marker_meta'));

/** F03 之前的 buildEffectiveHistory（冻结在这里）：摘要 + 锚点之后的原文；锚点丢失按 createdAt 自愈。 */
function oldEffective(history: RawMessage[], marker: CompactMarker): AgentMessage[] {
  let anchor = history.findIndex(m => m.id === marker.lastCompactedMessageId);
  if (anchor < 0) { const heal = history.findIndex(m => m.createdAt >= marker.createdAt); anchor = heal >= 0 ? heal - 1 : -1; }
  return [{ role: 'user', parts: [{ type: 'text', value: `[对话摘要] ${marker.summary}` }] }, ...history.slice(anchor + 1).map(m => ({ role: m.role, parts: m.parts }))];
}

/** 用停在这条迁移之前的库写入一个会话（消息由 seed 给），返回这个库。 */
function legacyDb(seed: (add: (role: 'user' | 'assistant', parts: unknown[]) => string) => void): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS.slice(0, idx));
  db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(SID, '旧会话', 1, 2);
  let n = 0;
  seed((role, parts) => {
    const id = `msg-${String(++n).padStart(3, '0')}`;
    db.prepare('INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, SID, role, JSON.stringify(parts), 100 + n, 100 + n, n);
    return id;
  });
  return db;
}
const text = (value: string): unknown[] => [{ type: 'text', value }];
const addMarker = (db: Database.Database, id: string, summary: string, anchorId: string, at: number): void => {
  db.prepare('INSERT INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)').run(id, SID, summary, anchorId, at);
};

describe('F03 迁移：compact_marker_meta', () => {
  it('迁移存在，且只建新表与索引（不 ALTER compact_markers、不动任何已有表）', () => {
    expect(idx).toBeGreaterThanOrEqual(13);
    const sql = MIGRATIONS[idx];
    expect(sql).not.toMatch(/ALTER\s+TABLE|DROP\s|UPDATE\s|DELETE\s|REFERENCES/i);
    expect(sql.match(/CREATE\s+TABLE/gi)).toHaveLength(1);
  });

  it('K5a 三种旧 marker（正常、「[摘要为空]」、锚点 id 不存在）：升级后行不变、读出来没有 meta，有效历史与旧实现相同；之后再追加用户消息仍相同；重开幂等', () => {
    for (const kind of ['normal', 'empty', 'lost'] as const) {
      const ids: string[] = [];
      const db = legacyDb(add => {
        for (let i = 1; i <= 4; i++) { ids.push(add('user', text(`question ${i}`))); ids.push(add('assistant', text(`answer ${i}`))); }
        ids.push(add('user', text('question 5')));
      });
      addMarker(db, 'old-marker', kind === 'empty' ? '[摘要为空]' : 'old summary text', kind === 'lost' ? 'no-such-message' : ids[1], 103.5);
      const rowsBefore = db.prepare('SELECT * FROM compact_markers').all();

      runMigrations(db);
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT * FROM compact_markers').all()).toEqual(rowsBefore);
      expect(db.prepare('SELECT COUNT(*) AS n FROM compact_marker_meta').get()).toEqual({ n: 0 });
      const cols = (db.prepare(`PRAGMA table_info('compact_marker_meta')`).all() as Array<{ name: string }>).map(c => c.name);
      expect(cols).toEqual(['marker_id', 'session_id', 'v', 'meta_json', 'created_at']);
      expect((db.prepare(`PRAGMA index_list('compact_marker_meta')`).all() as Array<{ name: string }>).map(i => i.name)).toContain('idx_compact_marker_meta_session');

      const store = new ChatStore(db);
      const engine = new CompactEngine(store);
      const marker = store.getLatestCompactMarker(SID)!;
      expect('meta' in marker).toBe(false);
      expect(engine.buildEffectiveHistory(store.listMessages(SID), marker), kind).toEqual(oldEffective(store.listMessages(SID), marker));
      // 之后再追加 1、2、3 条用户消息：保留回合都在锚点之后，仍与旧实现逐条相同
      for (let i = 6; i <= 8; i++) {
        store.appendMessage({ id: `more-${i}a`, sessionId: SID, role: 'assistant', parts: [{ type: 'text', value: `answer ${i - 1}` }], createdAt: 200 + i, streamInterruptCount: 0 });
        store.appendMessage({ id: `more-${i}u`, sessionId: SID, role: 'user', parts: [{ type: 'text', value: `question ${i}` }], createdAt: 200 + i + 0.5, streamInterruptCount: 0 });
        expect(engine.buildEffectiveHistory(store.listMessages(SID), marker), `${kind} +${i - 5}`).toEqual(oldEffective(store.listMessages(SID), marker));
      }
      runMigrations(db);
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      db.close();
    }
  });

  it('K5a 第四种：旧版本在单回合长任务里按 length − 15 写下的 marker 盖住了唯一的用户消息（带一张图）——摘要消息是旧的那段文字加「保留的用户原话」段，没有程序记录', () => {
    const ids: string[] = [];
    const db = legacyDb(add => {
      ids.push(add('user', [{ type: 'text', value: 'refactor everything, keep the API stable' }, { type: 'mediaRef', value: { id: 'm1', relativePath: 'attachments/plan.png', mimeType: 'image/png' } }]));
      for (let i = 1; ids.length < 40; i++) {
        ids.push(add('assistant', [{ type: 'toolUse', value: { toolUseId: `T${i}`, name: 'echo', input: '{}' } }]));
        ids.push(add('user', [{ type: 'toolResult', value: { toolUseId: `T${i}`, output: 'ok', success: true } }]));
      }
    });
    expect(ids).toHaveLength(41);
    addMarker(db, 'old-marker', 'old summary text', ids[41 - 15], 500);
    runMigrations(db);
    const store = new ChatStore(db);
    const history = store.listMessages(SID);
    const marker = store.getLatestCompactMarker(SID)!;
    const eff = new CompactEngine(store).buildEffectiveHistory(history, marker);
    const old = oldEffective(history, marker);
    expect(eff.slice(1)).toEqual(old.slice(1));
    expect(eff[0].parts[0]).toEqual(old[0].parts[0]);
    const all = eff[0].parts.filter(p => p.type === 'text').map(p => String(p.value)).join('');
    expect(all).toBe('[对话摘要] old summary text\n\n【保留的用户原话】以下 1 条是摘要覆盖范围内最近的用户消息，按时间顺序原样保留。\n\n（1/1）\nrefactor everything, keep the API stable\n\n最后一条就是当前这一轮的用户指示。');
    expect(all).not.toContain('【程序记录】');
    expect(eff[0].parts.filter(p => p.type === 'mediaRef')).toEqual([history[0].parts[1]]);
    db.close();
  });

  it('新库：带 meta 的 marker 读写全等；删除会话后 meta 行没了；上线路的 marker 键集合不变；不带 meta 的写入只有 marker 行', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const store = new ChatStore(db);
    const sid = store.createSession().id;
    let at = 10;
    const add = (role: 'user' | 'assistant', value: string): RawMessage =>
      store.appendMessage({ id: store.newId(), sessionId: sid, role, parts: [{ type: 'text', value }], createdAt: ++at, streamInterruptCount: 0 });
    for (let i = 1; i <= 3; i++) { add('user', `question ${i}`); add('assistant', `answer ${i}`); }
    add('user', 'question 4');
    const history = store.listMessages(sid);
    const reply = parseSummaryReply('【目标】\n- g\n【约束】\n- c\n【已完成】\n- （无）\n【进行中】\n- （无）\n【待办】\n- t\n【关键决策】\n- （无）\n【涉及文件】\n- （无）');
    if (!reply.ok) throw new Error('fixture');
    const built = buildCompactMeta({ history, to: 1, rule: 'recent-turns', prev: undefined, reply, toolKindOf: defaultToolKindOf, record: { trigger: 'watermark', request: { estInput: 1, maxTokens: 2, attempts: 1 } } });
    const written = store.appendCompactMarker(sid, built.summary, history[1].id, built.meta);
    expect(written.meta).toEqual(built.meta);
    expect(store.getLatestCompactMarker(sid)).toEqual(written);
    expect(db.prepare('SELECT marker_id, session_id, v FROM compact_marker_meta').all()).toEqual([{ marker_id: written.id, session_id: sid, v: 2 }]);
    // 同步线路上的 marker 不带 meta（WireCompactMarker 的键集合不变）；listCompactMarkers 也不带
    expect(Object.keys(toWireMarker(written, history)).sort()).toEqual(Object.keys(toWireMarker({ ...written, meta: undefined }, history)).sort());
    expect(JSON.stringify(toWireMarker(written, history))).not.toContain('coverage');
    expect(store.listCompactMarkers(sid).every(m => !('meta' in m))).toBe(true);
    // 没有 meta 的写入（同步合并、旧调用方）：只有 marker 行
    const plain = store.appendCompactMarker(sid, 'plain text', history[3].id);
    expect('meta' in plain).toBe(false);
    expect('meta' in store.getLatestCompactMarker(sid)!).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM compact_marker_meta').get()).toEqual({ n: 1 });

    store.deleteSession(sid);
    expect(db.prepare('SELECT COUNT(*) AS n FROM compact_marker_meta').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM compact_markers').get()).toEqual({ n: 0 });
    db.close();
  });
});
