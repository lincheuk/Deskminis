import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/minisd/store/db';

// M6 决策点 2-3/2-6：MIGRATIONS 纯追加 [4]，新增 audit_logs + settings 两表。
describe('MIGRATIONS[4]（M6 审计 + 暂停标志）', () => {
  it('openDb 建出 audit_logs 与 settings 表及其索引', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toEqual(
      expect.arrayContaining(['audit_logs', 'settings']),
    );
    const auditCols = db.prepare('PRAGMA table_info(audit_logs)').all() as { name: string }[];
    expect(auditCols.map(c => c.name)).toEqual(
      expect.arrayContaining(['id', 'event_type', 'session_id', 'peer_fingerprint', 'payload_json', 'created_at']),
    );
    const settingsCols = db.prepare('PRAGMA table_info(settings)').all() as { name: string }[];
    expect(settingsCols.map(c => c.name)).toEqual(
      expect.arrayContaining(['key', 'value', 'updated_at']),
    );
    // 索引存在：audit_logs 两个显式索引；settings 的 key 是 PRIMARY KEY，
    // SQLite 为非 INTEGER PRIMARY KEY 自动建 sqlite_autoindex_settings_1（无需也不应再显式建）。
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    expect(idx.map(i => i.name)).toEqual(
      expect.arrayContaining(['idx_audit_logs_created', 'idx_audit_logs_type']),
    );
    const settingsIdx = db.prepare("SELECT name FROM pragma_index_list('settings')").all() as { name: string }[];
    expect(settingsIdx.length).toBeGreaterThan(0);
    db.close();
  });

  it('user_version 演进到 9，既有表结构不被破坏', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(11); // 11 条迁移 [0..10]（[9] = J1 助手表；[10] = K1 定时任务表）
    // 既有 6 张表仍在
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of ['sessions', 'messages', 'compact_markers', 'skills', 'session_skill_overrides', 'sync_orphan_markers']) {
      expect(tables.some(x => x.name === t)).toBe(true);
    }
    db.close();
  });

  // 上面四条走的都是 openDb(':memory:')，即 user_version=0 的新建库一次跑完 [0..7]。
  // 但真实用户库停在 user_version=4（M3b 之后 / M6 之前），M6 首次启动才补跑 [4]——
  // 这才是「MIGRATIONS 纯追加」红线要保护的路径，必须单独覆盖。
  it('已有 user_version=4 的库重开：补跑 [4]..[10] 到 11，既有数据不丢，且幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-mig6-'));
    const file = join(dir, 'test.db');
    try {
      // 造出「M6 之前」的真实库形态：跑满后删掉 M6 两表并把版本退回 4，再写入既有数据。
      let db = openDb(file);
      // 造老库要把**每一条**后续迁移的产物都撤掉，只撤最后一条不够：
      // [4] 建的两张表 + [5] 加的 workspace_root 列 + [6] 建的 market_cache 表 + [7] 建的 market_installs 表。
      // 漏撤列会在重开时报「duplicate column name」，漏撤表报「table already exists」。
      db.exec('DROP TABLE IF EXISTS audit_logs; DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS market_cache; DROP TABLE IF EXISTS market_installs; DROP TABLE IF EXISTS annotations; DROP TABLE IF EXISTS assistants; DROP TABLE IF EXISTS cron_jobs;');
      db.exec('ALTER TABLE sessions DROP COLUMN workspace_root;');
      db.pragma('user_version = 4');
      const now = Date.now() / 1000;
      db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)')
        .run('S_OLD', '升级前的会话', now, now);
      db.prepare(
        'INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?)',
      ).run('M_OLD', 'S_OLD', 'user', JSON.stringify([{ type: 'text', text: '升级前的消息' }]), now, now, 1);
      db.prepare(
        'INSERT INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)',
      ).run('CM_OLD', 'S_OLD', '升级前的摘要', 'M_OLD', now);
      expect(db.pragma('user_version', { simple: true })).toBe(4);
      db.close();

      // 关键动作：当前 openDb 重开该库
      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(11);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map(t => t.name);
      expect(tables).toEqual(expect.arrayContaining(['audit_logs', 'settings']));
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
        .map(i => i.name);
      expect(idx).toEqual(expect.arrayContaining(['idx_audit_logs_created', 'idx_audit_logs_type']));

      // 既有数据完好（升级不得动存量）
      expect((db.prepare('SELECT title FROM sessions WHERE id=?').get('S_OLD') as { title: string }).title)
        .toBe('升级前的会话');
      const m = db.prepare('SELECT parts_json FROM messages WHERE id=?').get('M_OLD') as { parts_json: string };
      expect(JSON.parse(m.parts_json)[0].text).toBe('升级前的消息');
      expect((db.prepare('SELECT summary FROM compact_markers WHERE id=?').get('CM_OLD') as { summary: string }).summary)
        .toBe('升级前的摘要');

      // 新表在升级后的库上真能用
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)').run('sync.paused', '1', now);
      db.prepare('INSERT INTO audit_logs (id, event_type, payload_json, created_at) VALUES (?,?,?,?)')
        .run('A_NEW', 'permission.request', '{}', now);
      db.close();

      // 幂等：再开一次不重跑迁移、不清数据
      db = openDb(file);
      expect(db.pragma('user_version', { simple: true })).toBe(11);
      expect(db.prepare('SELECT id FROM audit_logs WHERE id=?').get('A_NEW')).toBeTruthy();
      expect((db.prepare('SELECT value FROM settings WHERE key=?').get('sync.paused') as { value: string }).value).toBe('1');
      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
    }
  });

  it('settings 可读写（R2 暂停标志存储）', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)').run('sync.paused', '1', 1.0);
    const row = db.prepare('SELECT key, value FROM settings WHERE key=?').get('sync.paused') as { key: string; value: string };
    expect(row).toEqual({ key: 'sync.paused', value: '1' });
    db.close();
  });

  it('audit_logs 可写入（R4 审计存储）', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO audit_logs (id, event_type, session_id, payload_json, created_at) VALUES (?,?,?,?,?)')
      .run('A1', 'permission.request', 'S1', '{"kind":"shell"}', 1.0);
    const row = db.prepare('SELECT event_type, payload_json FROM audit_logs WHERE id=?').get('A1') as { event_type: string; payload_json: string };
    expect(row.event_type).toBe('permission.request');
    expect(JSON.parse(row.payload_json)).toEqual({ kind: 'shell' });
    db.close();
  });
});