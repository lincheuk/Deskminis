/** G1 缓存表迁移例（迁移纪律：只追加，不动既有表）：MIGRATIONS[6] 新增 market_cache。
 *  新库建表成功；带旧数据（user_version=6）的库升级后 user_version=7、既有表无损、幂等。 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/minisd/store/db';

describe('MIGRATIONS[6]（G1 市场缓存表）', () => {
  it('openDb 建出 market_cache 表，列结构符合设计（key 主键 / etag / body / fetched_at）', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toEqual(expect.arrayContaining(['market_cache']));
    const cols = db.prepare('PRAGMA table_info(market_cache)').all() as { name: string; pk: number }[];
    expect(cols.map(c => c.name)).toEqual(['key', 'etag', 'body', 'fetched_at']);
    expect(cols.find(c => c.name === 'key')?.pk).toBe(1); // key 是主键：缓存行以 key upsert
    db.close();
  });

  it('user_version 演进到 7，既有表结构不被破坏', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(7); // 7 条迁移 [0..6]
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of ['sessions', 'messages', 'skills', 'audit_logs', 'settings', 'market_cache']) {
      expect(tables.some(x => x.name === t)).toBe(true);
    }
    db.close();
  });

  it('已有 user_version=6 的库重开：补跑 [6] 到 7，既有数据不丢，且幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-mig7-'));
    const file = join(dir, 'test.db');
    try {
      // 造「G1 之前」的库形态：跑满后撤掉 [6] 的产物并退回版本 6，再写入既有数据
      let db = openDb(file);
      db.exec('DROP TABLE IF EXISTS market_cache;');
      db.pragma('user_version = 6');
      const now = Date.now() / 1000;
      db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)')
        .run('S_OLD', '升级前的会话', now, now);
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)')
        .run('sync.paused', '1', now);
      expect(db.pragma('user_version', { simple: true })).toBe(6);
      db.close();

      // 关键动作：当前 openDb 重开该库 → 补跑 [6]
      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(7);
      expect((db.prepare('SELECT title FROM sessions WHERE id=?').get('S_OLD') as { title: string }).title)
        .toBe('升级前的会话');
      expect((db.prepare('SELECT value FROM settings WHERE key=?').get('sync.paused') as { value: string }).value)
        .toBe('1');

      // 新表真能用：upsert 语义（同 key 覆盖）
      const ins = db.prepare('INSERT INTO market_cache (key, etag, body, fetched_at) VALUES (?,?,?,?)');
      ins.run('k1', 'W/"e1"', '{"a":1}', Date.now());
      db.prepare('UPDATE market_cache SET body=?, etag=?, fetched_at=? WHERE key=?')
        .run('{"a":2}', 'W/"e2"', Date.now() + 5, 'k1');
      const row = db.prepare('SELECT * FROM market_cache WHERE key=?').get('k1') as { etag: string; body: string };
      expect(row.etag).toBe('W/"e2"');
      expect(JSON.parse(row.body)).toEqual({ a: 2 });
      db.close();

      // 幂等：再开一次不重跑迁移、不清数据
      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(7);
      expect(db.prepare('SELECT key FROM market_cache WHERE key=?').get('k1')).toBeTruthy();
      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
    }
  });
});
