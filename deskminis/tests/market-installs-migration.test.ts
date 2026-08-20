/** G2 安装登记表迁移例（迁移纪律：只追加，不动既有表）：MIGRATIONS[7] 新增 market_installs。
 *  新库建表成功；带旧数据（user_version=7）的库升级后 user_version=11（J1 追加 [9]、K1 追加 [10]）、既有表无损、幂等。
 *  照 market-cache-migration.test.ts 成例。 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/minisd/store/db';

describe('MIGRATIONS[7]（G2 市场安装登记表）', () => {
  it('openDb 建出 market_installs 表，列结构符合设计（item_id 主键 / kind / local_ref / content_hash / installed_at）', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toEqual(expect.arrayContaining(['market_installs']));
    const cols = db.prepare('PRAGMA table_info(market_installs)').all() as { name: string; pk: number; notnull: number }[];
    expect(cols.map(c => c.name)).toEqual(['item_id', 'kind', 'local_ref', 'content_hash', 'installed_at']);
    expect(cols.find(c => c.name === 'item_id')?.pk).toBe(1); // item_id 是主键：同条目重装走 upsert
    expect(cols.find(c => c.name === 'kind')?.notnull).toBe(1);
    expect(cols.find(c => c.name === 'local_ref')?.notnull).toBe(1);
    expect(cols.find(c => c.name === 'installed_at')?.notnull).toBe(1);
    db.close();
  });

  it('user_version 演进到 11，既有表结构不被破坏', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(11); // 9 条迁移 [0..8]
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of ['sessions', 'messages', 'skills', 'audit_logs', 'settings', 'market_cache', 'market_installs']) {
      expect(tables.some(x => x.name === t)).toBe(true);
    }
    db.close();
  });

  it('已有 user_version=7 的库重开：补跑 [7]..[10] 到 11，既有数据不丢，且幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-mig8-'));
    const file = join(dir, 'test.db');
    try {
      // 造「G2 之前」的库形态：跑满后撤掉 [7] 的产物并退回版本 7，再写入既有数据
      let db = openDb(file);
      db.exec('DROP TABLE IF EXISTS market_installs; DROP TABLE IF EXISTS annotations; DROP TABLE IF EXISTS assistants; DROP TABLE IF EXISTS cron_jobs;');
      db.pragma('user_version = 7');
      const now = Date.now() / 1000;
      db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)')
        .run('S_OLD', '升级前的会话', now, now);
      db.prepare("INSERT INTO market_cache (key, etag, body, fetched_at) VALUES (?,?,?,?)")
        .run('clawhub:probe', 'W/"e"', '{}', Date.now());
      expect(db.pragma('user_version', { simple: true })).toBe(7);
      db.close();

      // 关键动作：当前 openDb 重开该库 → 补跑 [7]
      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(11);
      expect((db.prepare('SELECT title FROM sessions WHERE id=?').get('S_OLD') as { title: string }).title)
        .toBe('升级前的会话');
      expect(db.prepare('SELECT key FROM market_cache WHERE key=?').get('clawhub:probe')).toBeTruthy();

      // 新表真能用：provenance 登记（同 item_id 重装覆盖 installed_at/local_ref——upsert 语义）
      const ins = db.prepare(`INSERT INTO market_installs (item_id, kind, local_ref, content_hash, installed_at)
        VALUES (?,?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET local_ref=excluded.local_ref, content_hash=excluded.content_hash, installed_at=excluded.installed_at`);
      ins.run('clawhub:o/s', 'skill', 'demo-skill', 'deadbeef', 1000);
      ins.run('clawhub:o/s', 'skill', 'demo-skill-2', 'cafebabe', 2000);
      const row = db.prepare('SELECT * FROM market_installs WHERE item_id=?').get('clawhub:o/s') as { local_ref: string; content_hash: string; installed_at: number };
      expect(row.local_ref).toBe('demo-skill-2');
      expect(row.content_hash).toBe('cafebabe');
      expect(row.installed_at).toBe(2000);
      expect(db.prepare('SELECT COUNT(*) c FROM market_installs').get() as { c: number }).toEqual({ c: 1 });
      db.close();

      // 幂等：再开一次不重跑迁移、不清数据
      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(11);
      expect(db.prepare('SELECT item_id FROM market_installs WHERE item_id=?').get('clawhub:o/s')).toBeTruthy();
      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
    }
  });
});
