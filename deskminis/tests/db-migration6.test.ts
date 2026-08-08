import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
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
    // 索引存在
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    expect(idx.map(i => i.name)).toEqual(
      expect.arrayContaining(['idx_audit_logs_created', 'idx_audit_logs_type']),
    );
    db.close();
  });

  it('user_version 演进到 5，既有表结构不被破坏', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(5); // 5 条迁移 [0..4]
    // 既有 6 张表仍在
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of ['sessions', 'messages', 'compact_markers', 'skills', 'session_skill_overrides', 'sync_orphan_markers']) {
      expect(tables.some(x => x.name === t)).toBe(true);
    }
    db.close();
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