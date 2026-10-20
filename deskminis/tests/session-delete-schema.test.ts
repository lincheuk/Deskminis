/** Q02：按真实表结构检查会话删除，新增 session_id 表会自动进入夹具和断言。 */
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { receiveRemotePayload } from '../src/minisd/sync/receive';

type Row = Record<string, unknown>;
interface Column { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function sessionTables(db: Database.Database): string[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  return tables.map(t => t.name).filter(table =>
    (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Column[]).some(c => c.name === 'session_id'));
}

function rows(db: Database.Database, table: string, sid: string): Row[] {
  return db.prepare(`SELECT * FROM ${quote(table)} WHERE session_id=?`).all(sid) as Row[];
}

/** 表名单来自 schema；这里只给 CHECK 约束和业务字段合法样本，不决定哪些表要清。 */
function seedRow(db: Database.Database, table: string, sid: string, patch: Row = {}): void {
  const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Column[];
  const samples: Row = {
    session_id: sid, role: 'user', origin_device_id: 'devReceiver', version: 2, op_id: `BASE-${sid}`,
    mode: 'queue', state: 'completed', attachments_json: '[]', request_json: '{}', meta_json: '{}',
  };
  if (table === 'session_inputs') samples.state = 'pending';
  if (table === 'sync_attachments') samples.state = 'present';
  if (table === 'file_checkpoints') Object.assign(samples, {
    state: 'applied', path: `${sid}/file.txt`, requested_path: `${sid}/file.txt`, path_key: `${sid}/file.txt`,
    before_exists: 1, before_blob: 'before-content', after_blob: 'after-content', restoring_at: 1,
  });
  Object.assign(samples, patch);
  const selected = columns.filter(c => Object.hasOwn(samples, c.name) ||
    (c.notnull && c.dflt_value === null) ||
    (c.pk && !(c.type === 'INTEGER' && columns.filter(p => p.pk).length === 1)));
  const values = selected.map(c => Object.hasOwn(samples, c.name) ? samples[c.name] :
    /INT|REAL|NUM|DOUB|FLOA/i.test(c.type) ? 1 : c.type === 'BLOB' ? Buffer.from('sample') : `${table}-${sid}-${c.name}`);
  db.prepare(`INSERT INTO ${quote(table)} (${selected.map(c => quote(c.name)).join(',')}) VALUES (${selected.map(() => '?').join(',')})`)
    .run(...values);
}

function seedSession(db: Database.Database, tables: string[], sid: string): void {
  for (const table of tables) {
    seedRow(db, table, sid);
    expect(rows(db, table, sid).length, `${table}: 删除前必须有行`).toBeGreaterThan(0);
  }
  // F08 / F11B §3.11：两种残留临时路径均须留下占位；普通检查点则必须删掉。
  seedRow(db, 'file_checkpoints', sid, { id: `write-temp-${sid}`, tmp_path: `${sid}/.dm-write.tmp` });
  seedRow(db, 'file_checkpoints', sid, { id: `restore-temp-${sid}`, restore_tmp_path: `${sid}/.dm-restore.tmp` });
}

function snapshot(db: Database.Database, tables: string[], sid: string): Record<string, Row[]> {
  return Object.fromEntries(tables.map(table => [table, rows(db, table, sid)]));
}

function fixture() {
  const db = openDb(':memory:');
  try {
    const chat = new ChatStore(db, 'devReceiver');
    const tables = sessionTables(db);
    expect(tables.length).toBeGreaterThan(0);
    const sid = chat.createSession('目标会话').id;
    const control = chat.createSession('不得清除的另一会话').id;
    seedSession(db, tables, sid);
    seedSession(db, tables, control);
    return { db, chat, tables, sid, control };
  } catch (error) { db.close(); throw error; }
}

function expectCleared(db: Database.Database, tables: string[], sid: string, before: Record<string, Row[]>): void {
  // 白名单依据：F11B §1 / §3.8 登记永不删除；chat-store.ts 的 purgeSessionRows 注释：审计独立于会话。
  // file_checkpoints 只豁免带临时路径的占位行，依据 F11B §3.11；并非整张表豁免。
  for (const table of sessionTables(db)) {
    const actual = rows(db, table, sid);
    if (table === 'session_lifecycle') {
      expect(actual, table).toHaveLength(1);
      expect(actual[0], table).toMatchObject({ session_id: sid, version: 3 });
    } else if (table === 'audit_logs') {
      expect(actual, table).toEqual(before[table]);
    } else if (table === 'file_checkpoints') {
      const placeholders = before[table].filter(r => r.tmp_path !== null || r.restore_tmp_path !== null);
      expect(actual, table).toEqual(placeholders.map(r => ({
        ...r, state: 'aborted', abort_reason: 'session-deleted', before_blob: null, after_blob: null,
        restoring_at: null, updated_at: expect.any(Number),
      })));
    } else {
      expect(actual, `${table}: 删除后不应残留会话行`).toEqual([]);
    }
  }
  expect(sessionTables(db)).toEqual(tables);
  expect(db.prepare('SELECT * FROM sessions WHERE id=?').all(sid)).toEqual([]);
}

/** 两个真实 ChatStore：先传内容，再本机删除发送方，将其真实墓碑经生产收包入口送回接收方。
 *  无运行中的进程，使用 receiveRemotePayload 的存储测试入口，不模拟 purge SQL。 */
async function remoteDelete(receiver: ChatStore, sid: string, beforeSend?: () => void): Promise<void> {
  const senderDb = openDb(':memory:');
  try {
    const sender = new ChatStore(senderDb, 'devSender');
    for (const batch of receiver.buildPushBatches(sid)) {
      await receiveRemotePayload(sender, undefined, sid, batch, 'devReceiver');
    }
    expect(sender.listMessages(sid).map(m => m.id)).toEqual(receiver.listMessages(sid).map(m => m.id));
    beforeSend?.();
    expect(sender.deleteSession(sid).kind).toBe('deleted');
    const lifecycle = sender.wireLifecycle(sid);
    expect(lifecycle?.v).toBe(3);
    const result = await receiveRemotePayload(receiver, undefined, sid, { messages: [], markers: [], lifecycle }, 'devSender');
    expect(result.tombstone).toBe('applied');
  } finally { senderDb.close(); }
}

describe('Q02 会话删除的表结构守卫', () => {
  it.each(['本机删除', '对端删除传播'])('%s 清除所有会话表，只保留有依据的行且不连累另一会话', async path => {
    const f = fixture();
    try {
      const { db, chat, tables, sid, control } = f;
      if (path === '对端删除传播') {
        // F11B §3.3：本机有标注时必须保留副本。先走真实标注删除，造出允许物理清除的状态。
        for (const row of rows(db, 'annotations', sid)) expect(chat.removeAnnotation(row.id as string)).toBe(sid);
        expect(rows(db, 'annotations', sid)).toEqual([]);
      }
      const before = snapshot(db, tables, sid);
      const untouched = snapshot(db, tables, control);
      const controlSession = chat.getSession(control);
      if (path === '本机删除') expect(chat.deleteSession(sid).kind).toBe('deleted');
      else await remoteDelete(chat, sid);
      expectCleared(db, tables, sid, before);
      expect(snapshot(db, tables, control)).toEqual(untouched);
      expect(chat.getSession(control)).toEqual(controlSession);
    } finally { f.db.close(); }
  });

  it.each(['本机标注', '对方未见消息'])('对端删除遇到%s 保留全部内容；显式清除保留副本后各表随动', async reason => {
    const f = fixture();
    try {
      const { db, chat, tables, sid, control } = f;
      if (reason === '对方未见消息') for (const row of rows(db, 'annotations', sid)) chat.removeAnnotation(row.id as string);
      const untouched = snapshot(db, tables, control);
      let before = snapshot(db, tables, sid);
      await remoteDelete(chat, sid, () => {
        if (reason === '对方未见消息') chat.appendMessage({
          id: 'UNSEEN-MESSAGE', sessionId: sid, role: 'user', parts: [{ type: 'text', value: '本机新内容' }],
          createdAt: chat.nowEpoch(), streamInterruptCount: 0,
        });
        before = snapshot(db, tables, sid);
      });
      for (const table of tables.filter(t => t !== 'session_lifecycle')) expect(rows(db, table, sid), table).toEqual(before[table]);
      expect(chat.getSession(sid)).toBeUndefined();
      expect(chat.listRetainedSessions().map(s => s.id)).toContain(sid);
      const lifecycle = rows(db, 'session_lifecycle', sid);
      expect(chat.purgeRetained(sid).lifecycle.v).toBe(3);
      expectCleared(db, tables, sid, before);
      expect(rows(db, 'session_lifecycle', sid)).toEqual(lifecycle);
      expect(snapshot(db, tables, control)).toEqual(untouched);
    } finally { f.db.close(); }
  });
});
