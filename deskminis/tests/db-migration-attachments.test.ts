/** F11A：sync_attachments 迁移只追加新表与索引，旧库升级后既有行不变、幂等。 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from '../src/minisd/store/db';

const SID = '11111111-2222-4333-8444-555555555555';

describe('F11A 迁移：sync_attachments', () => {
  const idx = MIGRATIONS.findIndex(m => m.includes('CREATE TABLE sync_attachments'));

  it('迁移存在，且只建新表与索引（不动任何已有表）', () => {
    expect(idx).toBeGreaterThanOrEqual(11);
    const sql = MIGRATIONS[idx];
    expect(sql).not.toMatch(/ALTER\s+TABLE|DROP\s|UPDATE\s|DELETE\s/i);
    expect(sql.match(/CREATE\s+TABLE/gi)).toHaveLength(1);
  });

  it('带旧数据的库（停在这条迁移之前）升级：新表与索引就位，旧行不变，再跑一次不出错', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.slice(0, idx));
    expect(db.pragma('user_version', { simple: true })).toBe(idx);
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(SID, '旧会话', 1, 2);
    const parts = JSON.stringify([{ type: 'text', value: '看图' }, { type: 'mediaRef', value: { id: 'm1', relativePath: 'attachments/paste-1700000000000.png', mimeType: 'image/png' } }]);
    db.prepare('INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('msg-1', SID, 'user', parts, 3, 3, 0);
    const before = {
      sessions: db.prepare('SELECT * FROM sessions').all(),
      messages: db.prepare('SELECT * FROM messages').all(),
    };

    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before.sessions);
    expect(db.prepare('SELECT * FROM messages').all()).toEqual(before.messages);

    const cols = (db.prepare(`PRAGMA table_info('sync_attachments')`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual([
      'session_id', 'name', 'sha256', 'size', 'mime_type', 'state', 'want', 'fail_code', 'attempts',
      'conflict_sha256', 'conflict_size', 'stat_size', 'stat_mtime_ms', 'source_fp', 'created_at', 'updated_at',
    ]);
    const indexes = (db.prepare(`PRAGMA index_list('sync_attachments')`).all() as Array<{ name: string }>).map(i => i.name);
    expect(indexes).toContain('idx_sync_attachments_content');
    // 新表是空的：不做启动时回填，旧附件在第一次用到时登记
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_attachments').get()).toEqual({ n: 0 });

    // 名字不分大小写：A.png 与 a.png 落在同一行
    const ins = db.prepare(`INSERT INTO sync_attachments (session_id, name, sha256, size, state, created_at, updated_at) VALUES (?, ?, ?, 1, 'missing', 0, 0)`);
    ins.run(SID, 'A.png', 'a'.repeat(64));
    expect(() => ins.run(SID, 'a.png', 'b'.repeat(64))).toThrow(/UNIQUE|PRIMARY/i);
    expect(db.prepare('SELECT name FROM sync_attachments WHERE session_id=? AND name=?').get(SID, 'a.PNG')).toEqual({ name: 'A.png' });

    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });
});
