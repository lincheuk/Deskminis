/** F11B：ChatStore 的墓碑、防复活闸、保留副本、显式恢复、压实（设计 §4.1–§4.6、§4.11、§4.12）。
 *
 *  真库（内存 sqlite）加真 ChatStore；两三个 store 之间用线格式互传。断言落在物理行上。
 *  每条用例对着一种会丢数据或会复活的写法：只删行不写墓碑、清内容与写登记不同事务、按时间戳比较、
 *  无条件清除对端没见过的内容、压实删掉墓碑行、恢复的批次不带版本或不带会话行。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, openDb, runMigrations } from '../src/minisd/store/db';
import { ChatStore, type LifecycleEvent } from '../src/minisd/store/chat-store';
import { compareLifecycle, digestIds, makeSeen } from '../src/minisd/sync/lifecycle';
import { toWireMarker, toWireMessage, toWireSession, type SyncPayload, type WireCompactMarker, type WireLifecycle, type WireMessage } from '../src/minisd/sync/wire';
import { watchEngine } from './engine-wiring';
import { callMark, onCall } from './engine-trace';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import type { StartMinisdOpts } from '../src/minisd/index';

const qEngines: CapturedEngine[] = [];

const qSavedFake = process.env.DESKMINIS_FAKE_PROVIDER;

afterEach(async () => {
  for (const e of qEngines.splice(0).reverse()) await e.close();
  vi.restoreAllMocks();
  if (qSavedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER;
  else process.env.DESKMINIS_FAKE_PROVIDER = qSavedFake;
});

async function qStart(opts: StartMinisdOpts = {}): Promise<CapturedEngine> {
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const e = await startCapturedEngine(opts);
  qEngines.push(e);
  return e;
}

async function qRpc(e: CapturedEngine, name: string, p: any = {}, conn = probeConnection('local')): Promise<any> {
  return await e.methods[name](p, conn);
}

const SRC = join(__dirname, '../src');
const Y2100 = 4102444800;

interface Node { db: Database.Database; store: ChatStore; dirty: string[]; events: LifecycleEvent[]; clock: { ms: number } }

function mk(deviceId: string, startMs = 1_700_000_000_000): Node {
  const db = openDb(':memory:');
  const clock = { ms: startMs };
  // 每读一次时钟前进 1ms：同一毫秒里的两条消息顺序才确定
  const store = new ChatStore(db, deviceId, { now: () => clock.ms++ });
  const dirty: string[] = [];
  const events: LifecycleEvent[] = [];
  store.onDirty = sid => { dirty.push(sid); };
  store.onLifecycle = e => { events.push(e); };
  return { db, store, dirty, events, clock };
}

function addMsg(n: Node, sid: string, text = 'x'): string {
  const id = n.store.newId();
  n.store.appendMessage({ id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: text }], createdAt: n.store.nowEpoch(), streamInterruptCount: 0 });
  return id;
}

const count = (n: Node, table: string, col: string, sid: string): number =>
  (n.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col}=?`).get(sid) as { c: number }).c;
const msgCount = (n: Node, sid: string): number => count(n, 'messages', 'session_id', sid);
const sessionRows = (n: Node, sid: string): number => count(n, 'sessions', 'id', sid);
const msgIds = (n: Node, sid: string): string[] =>
  (n.db.prepare('SELECT id FROM messages WHERE session_id=? ORDER BY id').all(sid) as Array<{ id: string }>).map(r => r.id);
const regRow = (n: Node, sid: string): Record<string, unknown> | undefined =>
  n.db.prepare('SELECT * FROM session_lifecycle WHERE session_id=?').get(sid) as Record<string, unknown> | undefined;
/** 登记里与设备无关的列（received_from / recorded_at 是本机记账，各设备不同）。 */
const regCore = (n: Node, sid: string): unknown => {
  const r = regRow(n, sid);
  return r && { version: r.version, op_id: r.op_id, origin_device_id: r.origin_device_id, origin_at: r.origin_at };
};
const tombstonedAt = (n: Node, sid: string): number | null | undefined =>
  (n.db.prepare('SELECT remote_tombstoned_at AS t FROM sessions WHERE id=?').get(sid) as { t: number | null } | undefined)?.t;

/** 整包载荷（等价于 sync.pull 的应答）：全部消息、摘要、会话行，登记为偶数时带版本。直接读表，不受隐藏过滤影响。 */
function fullPayload(n: Node, sid: string): SyncPayload {
  const msgs = n.store.listMessages(sid);
  const s = n.db.prepare('SELECT id, title, created_at, updated_at, memory_enabled FROM sessions WHERE id=?').get(sid) as
    { id: string; title: string; created_at: number; updated_at: number; memory_enabled: number } | undefined;
  const p: SyncPayload = { messages: msgs.map(toWireMessage), markers: n.store.listCompactMarkers(sid).map(m => toWireMarker(m, msgs)) };
  if (s) p.session = toWireSession({ id: s.id, title: s.title, createdAt: s.created_at, updatedAt: s.updated_at, memoryEnabled: s.memory_enabled === 1 });
  return p;
}

/** 走真实的分批出口把一个存活会话从 from 推到 to。 */
function push(from: Node, to: Node, sid: string, maxBytes?: number): Array<ReturnType<ChatStore['mergeRemoteSession']>> {
  return from.store.buildPushBatches(sid, maxBytes).map(b => to.store.mergeRemoteSession(b, sid, { fromPeer: 'peer' }));
}

/** 在若干 store 上造出同一个会话的同一份副本；返回会话 id 与消息 id。 */
function shared(origin: Node, others: Node[], nMsgs: number): { sid: string; ids: string[] } {
  const s = origin.store.createSession('共享');
  const ids = Array.from({ length: nMsgs }, (_, i) => addMsg(origin, s.id, `m${i}`));
  for (const o of others) push(origin, o, s.id);
  for (const n of [origin, ...others]) { n.dirty.length = 0; n.events.length = 0; }
  return { sid: s.id, ids };
}

function tomb(v: number, opId: string, ids: string[] | undefined, at = 1): WireLifecycle {
  const t: WireLifecycle = { v, opId, originDeviceId: 'devRemote', at };
  if (ids) t.seen = makeSeen(ids);
  return t;
}

function faultTrigger(db: Database.Database, table: string, op: 'INSERT' | 'UPDATE' | 'DELETE'): () => void {
  const name = `fault_${table}_${op}`;
  db.exec(`CREATE TEMP TRIGGER ${name} BEFORE ${op} ON main.${table} BEGIN SELECT RAISE(ABORT, 'inject'); END;`);
  return () => db.exec(`DROP TRIGGER ${name}`);
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|vue|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe('S1–S3 本机删除写墓碑，且与清内容同事务（B1）', () => {
  it('S1 deleteSession：内容各表清空，登记 v=1、来源是本机、seen 等于删除前的消息 id，onDirty 恰一次', () => {
    const a = mk('devA');
    const s = a.store.createSession('要删的');
    const ids = [addMsg(a, s.id), addMsg(a, s.id), addMsg(a, s.id)];
    a.store.appendCompactMarker(s.id, '摘要', ids[1]);
    a.store.addAnnotation({ sessionId: s.id, messageId: ids[0], exact: '划线' });
    a.db.prepare('INSERT INTO sync_orphan_markers (id, session_id, summary, last_compacted_message_id, created_at, received_at) VALUES (?,?,?,?,?,?)').run('OM1', s.id, 'x', 'nope', 1, 1);
    a.db.prepare(`INSERT INTO sync_attachments (session_id, name, sha256, size, state, created_at, updated_at) VALUES (?, 'a.png', ?, 1, 'present', 0, 0)`).run(s.id, 'a'.repeat(64));
    a.dirty.length = 0;

    const r = a.store.deleteSession(s.id);
    expect(r.kind).toBe('deleted');
    for (const [table, col] of [['messages', 'session_id'], ['compact_markers', 'session_id'], ['sync_orphan_markers', 'session_id'], ['annotations', 'session_id'], ['session_skill_overrides', 'session_id'], ['sync_attachments', 'session_id'], ['sessions', 'id']] as const) {
      expect(count(a, table, col, s.id), table).toBe(0);
    }
    const row = regRow(a, s.id)!;
    expect(row.version).toBe(1);
    expect(row.origin_device_id).toBe('devA');
    expect(row.received_from).toBeNull();
    expect(JSON.parse(row.seen_ids_json as string)).toEqual([...ids].sort());
    expect(row.seen_count).toBe(3);
    expect(row.seen_digest).toBe(digestIds(ids));
    expect(a.dirty).toEqual([s.id]);
    expect(a.events.map(e => e.kind)).toEqual(['deleted']);
    expect(a.store.isDeleted(s.id)).toBe(true);
    expect(a.store.listTombstoneHeads()).toEqual([{ id: s.id, v: 1, opId: row.op_id }]);
    expect(a.store.getSession(s.id)).toBeUndefined();
    if (r.kind === 'deleted') { expect(r.messageCount).toBe(3); expect(r.lifecycle.v).toBe(1); }
  });

  it('S1 重复删除、删除从未存在的 id：absent，不造墓碑、不触发任何钩子', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    addMsg(a, s.id);
    a.store.deleteSession(s.id);
    a.dirty.length = 0; a.events.length = 0;
    const before = regRow(a, s.id);
    expect(a.store.deleteSession(s.id)).toEqual({ kind: 'absent' });
    expect(a.store.deleteSession('NEVER-EXISTED')).toEqual({ kind: 'absent' });
    expect(regRow(a, s.id)).toEqual(before);
    expect(regRow(a, 'NEVER-EXISTED')).toBeUndefined();
    expect(a.dirty).toEqual([]);
    expect(a.events).toEqual([]);
  });

  it('S1 这个 id 名下只剩技能覆盖行（从未存在过的 id、已清除的 id）：absent，覆盖行清掉，不造墓碑、登记不动、不触发任何钩子', () => {
    const a = mk('devA');
    const override = (sid: string): void => {
      a.db.prepare('INSERT INTO session_skill_overrides (session_id, skill_id, is_enabled) VALUES (?,?,0)').run(sid, 'sk-x');
    };
    // 已清除的会话：登记为奇数，名下没有任何内容行
    const s = a.store.createSession();
    addMsg(a, s.id);
    a.store.deleteSession(s.id);
    const reg = regRow(a, s.id);
    const other = a.store.createSession('别的会话');
    // 覆盖行按会话归属、只在本机：没有会话行可挂时就是没人回收的孤儿（旧库里可能已有；从未存在过的 id 可以被直接调用写出来）
    override(s.id); override('NEVER-EXISTED'); override(other.id);
    a.dirty.length = 0; a.events.length = 0;

    for (const sid of [s.id, 'NEVER-EXISTED']) {
      expect(a.store.deleteSession(sid), sid).toEqual({ kind: 'absent' });
      expect(count(a, 'session_skill_overrides', 'session_id', sid), sid).toBe(0);
    }
    expect(regRow(a, s.id)).toEqual(reg);
    expect(regRow(a, 'NEVER-EXISTED')).toBeUndefined();
    // 别的会话的覆盖行不动
    expect(count(a, 'session_skill_overrides', 'session_id', other.id)).toBe(1);
    expect(a.dirty).toEqual([]);
    expect(a.events).toEqual([]);
  });

  it('S1 没有会话行但有残留消息（首次同步推到一半）：删除照样写墓碑', () => {
    const a = mk('devA'); const b = mk('devB');
    const s = a.store.createSession();
    const id = addMsg(a, s.id);
    // 只有消息、没有会话行的批次
    b.store.mergeRemoteSession({ messages: a.store.listMessages(s.id).map(toWireMessage), markers: [] }, s.id);
    expect(sessionRows(b, s.id)).toBe(0);
    expect(msgCount(b, s.id)).toBe(1);
    const r = b.store.deleteSession(s.id);
    expect(r.kind).toBe('deleted');
    expect(msgCount(b, s.id)).toBe(0);
    expect(JSON.parse(regRow(b, s.id)!.seen_ids_json as string)).toEqual([id]);
  });

  it('S2 登记写入失败：整体回滚，会话与消息完好、没有登记；清内容失败：登记也不存在', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    addMsg(a, s.id); addMsg(a, s.id);
    a.dirty.length = 0;

    let undo = faultTrigger(a.db, 'session_lifecycle', 'INSERT');
    expect(() => a.store.deleteSession(s.id)).toThrow(/inject/);
    expect(sessionRows(a, s.id)).toBe(1);
    expect(msgCount(a, s.id)).toBe(2);
    expect(regRow(a, s.id)).toBeUndefined();
    undo();

    undo = faultTrigger(a.db, 'messages', 'DELETE');
    expect(() => a.store.deleteSession(s.id)).toThrow(/inject/);
    expect(sessionRows(a, s.id)).toBe(1);
    expect(msgCount(a, s.id)).toBe(2);
    expect(regRow(a, s.id), '清内容失败时墓碑也不能留下').toBeUndefined();
    expect(a.store.getSession(s.id)).toBeDefined();
    expect(a.dirty).toEqual([]);
    expect(a.events).toEqual([]);
    undo();

    expect(a.store.deleteSession(s.id).kind).toBe('deleted');
    expect(sessionRows(a, s.id)).toBe(0);
    expect(regRow(a, s.id)!.version).toBe(1);
  });

  it('S3 purgeSessionRows 对存活会话抛错，行都还在（运行期防线）', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    addMsg(a, s.id);
    expect(() => (a.store as unknown as { purgeSessionRows(id: string): void }).purgeSessionRows(s.id)).toThrow(/登记不是已删除/);
    expect(sessionRows(a, s.id)).toBe(1);
    expect(msgCount(a, s.id)).toBe(1);
  });
});

describe('S4–S5 防复活闸：已删除的会话，任何旧内容都不落库（V1、B2）', () => {
  it('S4 带会话行的整包、只有消息的分批包、带垃圾版本的包：一律 rejected，不写行、不 onDirty', () => {
    const a = mk('devA'); const b = mk('devB');
    const { sid } = shared(a, [b], 3);
    const whole = fullPayload(b, sid);
    const tiny = b.store.buildPushBatches(sid, 700);
    expect(tiny.length).toBeGreaterThan(1);
    expect(tiny[0].session).toBeUndefined();
    a.store.deleteSession(sid);
    a.dirty.length = 0; a.events.length = 0;

    const garbage = [{ v: 0, opId: 'X', originDeviceId: 'd', at: 1 }, { v: 2 }, 'x', { v: 2.5, opId: 'X', originDeviceId: 'd', at: 1 }];
    const payloads: SyncPayload[] = [whole, tiny[0], ...garbage.map(g => ({ ...whole, lifecycle: g as unknown as WireLifecycle }))];
    for (const p of payloads) {
      const r = a.store.mergeRemoteSession(p, sid, { fromPeer: 'devB' });
      expect(r.rejected).toBe('tombstoned');
      expect(r.hasChange).toBe(false);
      expect(r.mergedCount).toBe(0);
      expect(r.lifecycle?.v).toBe(1);
    }
    expect(msgCount(a, sid)).toBe(0);
    expect(sessionRows(a, sid)).toBe(0);
    expect(a.dirty).toEqual([]);
    expect(a.events.every(e => e.kind === 'stale-content-rejected')).toBe(true);
    expect(a.events.length).toBe(payloads.length);
  });

  it('S5 时钟不参与：2100 年的旧内容照样被 1970 年的墓碑拒收', () => {
    const a = mk('devA', 1000); const b = mk('devB', Y2100 * 1000);
    const s = b.store.createSession('来自未来');
    addMsg(b, s.id); addMsg(b, s.id);
    push(b, a, s.id);
    a.store.deleteSession(s.id);
    expect(regRow(a, s.id)!.origin_at).toBeLessThan(10);
    addMsg(b, s.id);
    const p = fullPayload(b, s.id);
    expect(p.session!.updatedAt).toBeGreaterThan(Y2100 - 1);
    expect(a.store.mergeRemoteSession(p, s.id).rejected).toBe('tombstoned');
    expect(msgCount(a, s.id)).toBe(0);
    expect(sessionRows(a, s.id)).toBe(0);
  });

  it('S5 反过来：at 为 1970 年的墓碑照样删掉 updatedAt 为 2100 年、消息都见过的本机会话', () => {
    const b = mk('devB', Y2100 * 1000);
    const s = b.store.createSession('来自未来');
    const ids = [addMsg(b, s.id), addMsg(b, s.id)];
    const r = b.store.applyTombstone(s.id, tomb(1, 'OP-OLD', ids, 1));
    expect(r).toMatchObject({ status: 'applied', hadLocalCopy: true, retained: false });
    expect(sessionRows(b, s.id)).toBe(0);
    expect(msgCount(b, s.id)).toBe(0);
  });
});

describe('S6–S10 应用对端墓碑：清除、保留、幂等、同代（V2、V3）', () => {
  it('S6 seen 覆盖本机全部消息 → 清掉；只改过标题也一样清', () => {
    const b = mk('devB');
    const s = b.store.createSession();
    const ids = [addMsg(b, s.id), addMsg(b, s.id)];
    b.store.updateSessionTitle(s.id, '离线改的标题');
    b.store.setMemoryEnabled(s.id, false);
    b.dirty.length = 0;
    const r = b.store.applyTombstone(s.id, tomb(1, 'OP1', [...ids, 'EXTRA']), { fromPeer: 'devA' });
    expect(r).toEqual({ status: 'applied', hadLocalCopy: true, retained: false, unseenCount: 0, annotationCount: 0 });
    expect(b.store.listSessions().map(x => x.id)).not.toContain(s.id);
    expect(sessionRows(b, s.id)).toBe(0);
    expect(msgCount(b, s.id)).toBe(0);
    expect(regRow(b, s.id)).toMatchObject({ version: 1, op_id: 'OP1', origin_device_id: 'devRemote', received_from: 'devA' });
    expect(b.dirty).toEqual([s.id]); // 向本机的其它对端转发
    expect(b.events.map(e => e.kind)).toEqual(['tombstone-applied']);
  });

  it('S7 本机多两条 seen 之外的消息 → 内容原封不动、隐藏、不参与同步、列入保留副本', () => {
    const b = mk('devB');
    const s = b.store.createSession('有新内容');
    const seenIds = [addMsg(b, s.id), addMsg(b, s.id)];
    addMsg(b, s.id); addMsg(b, s.id);
    const before = msgIds(b, s.id);
    const r = b.store.applyTombstone(s.id, tomb(1, 'OP1', seenIds), { fromPeer: 'devA' });
    expect(r).toEqual({ status: 'applied', hadLocalCopy: true, retained: true, unseenCount: 2, annotationCount: 0 });
    expect(msgIds(b, s.id)).toEqual(before);
    expect(tombstonedAt(b, s.id)).toBeGreaterThan(0);
    expect(b.store.isDeleted(s.id)).toBe(true);
    // 每一个过滤点：漏掉任何一个，保留副本就会被显示或被推给对端
    expect(b.store.getSession(s.id)).toBeUndefined();
    expect(b.store.listSessions().map(x => x.id)).not.toContain(s.id);
    expect(b.store.listSyncedSessions().map(x => x.id)).not.toContain(s.id);
    expect(b.store.buildPushBatches(s.id)).toEqual([]);
    const retained = b.store.listRetainedSessions();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ id: s.id, title: '有新内容', deletedBy: 'devRemote', messageCount: 4, unseenCount: 2, annotationCount: 0 });
  });

  it('S7 消息都在 seen 里但有一条本机标注 → 保留，annotationCount 为 1', () => {
    const b = mk('devB');
    const s = b.store.createSession();
    const ids = [addMsg(b, s.id), addMsg(b, s.id)];
    b.store.addAnnotation({ sessionId: s.id, messageId: ids[0], exact: '我的笔记' });
    const r = b.store.applyTombstone(s.id, tomb(1, 'OP1', ids));
    expect(r).toEqual({ status: 'applied', hadLocalCopy: true, retained: true, unseenCount: 0, annotationCount: 1 });
    expect(msgCount(b, s.id)).toBe(2);
    expect(count(b, 'annotations', 'session_id', s.id)).toBe(1);
    expect(b.store.listRetainedSessions()[0]).toMatchObject({ id: s.id, unseenCount: 0, annotationCount: 1 });
  });

  it('S7 墓碑不带 seen（被解析器丢弃了）→ 有消息就保留，无法判断条数', () => {
    const b = mk('devB');
    const s = b.store.createSession();
    addMsg(b, s.id);
    const r = b.store.applyTombstone(s.id, tomb(1, 'OP1', undefined));
    expect(r).toMatchObject({ status: 'applied', retained: true, unseenCount: null });
    expect(msgCount(b, s.id)).toBe(1);
  });

  it('S7 本机从没有过这个会话 → 只记登记', () => {
    const b = mk('devB');
    const r = b.store.applyTombstone('S-UNKNOWN', tomb(1, 'OP1', ['a']), { fromPeer: 'devA' });
    expect(r).toEqual({ status: 'applied', hadLocalCopy: false, retained: false, unseenCount: 0, annotationCount: 0 });
    expect(regRow(b, 'S-UNKNOWN')!.version).toBe(1);
    expect(sessionRows(b, 'S-UNKNOWN')).toBe(0);
  });

  it('S7 没有会话行、只有首次同步推到一半留下的残留行 → 清掉残留，不算本机有过副本', () => {
    const a = mk('devA'); const b = mk('devB');
    const s = a.store.createSession();
    addMsg(a, s.id); addMsg(a, s.id);
    // 只有消息、没有会话行的批次（分批推送的前几批），外加一条孤儿摘要
    b.store.mergeRemoteSession({ messages: a.store.listMessages(s.id).map(toWireMessage), markers: [] }, s.id);
    b.db.prepare('INSERT INTO sync_orphan_markers (id, session_id, summary, last_compacted_message_id, created_at, received_at) VALUES (?,?,?,?,?,?)').run('OM1', s.id, 'x', 'nope', 1, 1);
    expect(sessionRows(b, s.id)).toBe(0);
    expect(msgCount(b, s.id)).toBe(2);
    b.dirty.length = 0; b.events.length = 0;

    // 墓碑的 seen 没有覆盖这两条也照清：没有会话行就不是一份能恢复的副本（恢复要求会话行在），
    // 留下来只会是界面上看不见、此后再也没人清的孤儿行
    const r = b.store.applyTombstone(s.id, tomb(1, 'OP1', []), { fromPeer: 'devA' });
    expect(r).toEqual({ status: 'applied', hadLocalCopy: false, retained: false, unseenCount: 0, annotationCount: 0 });
    expect(msgCount(b, s.id)).toBe(0);
    expect(count(b, 'sync_orphan_markers', 'session_id', s.id)).toBe(0);
    expect((b.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)').get() as { c: number }).c).toBe(0);
    expect(regRow(b, s.id)).toMatchObject({ version: 1, op_id: 'OP1', received_from: 'devA' });
    expect(b.store.listRetainedSessions()).toEqual([]);
    expect(b.dirty).toEqual([s.id]);
  });

  it('S7 偶数登记不是墓碑：applyTombstone 抛错，库不变', () => {
    const b = mk('devB');
    const s = b.store.createSession();
    addMsg(b, s.id);
    expect(() => b.store.applyTombstone(s.id, { v: 2, opId: 'X', originDeviceId: 'd', at: 1 })).toThrow();
    expect(sessionRows(b, s.id)).toBe(1);
    expect(regRow(b, s.id)).toBeUndefined();
  });

  it('S8 同一墓碑应用三次：后两次 duplicate，库不变，不再 onDirty、不再发事件', () => {
    const b = mk('devB');
    const s = b.store.createSession();
    const ids = [addMsg(b, s.id)];
    const t = tomb(1, 'OP1', ids);
    b.dirty.length = 0;
    expect(b.store.applyTombstone(s.id, t).status).toBe('applied');
    const row = regRow(b, s.id);
    const dirtyAfterFirst = [...b.dirty]; const eventsAfterFirst = b.events.length;
    expect(b.store.applyTombstone(s.id, t)).toEqual({ status: 'duplicate', released: false });
    expect(b.store.applyTombstone(s.id, t, { fromPeer: 'someone-else' })).toEqual({ status: 'duplicate', released: false });
    expect(regRow(b, s.id)).toEqual(row);
    expect(b.dirty).toEqual(dirtyAfterFirst);
    expect(b.events.length).toBe(eventsAfterFirst);
  });

  it('S9 同版本两条不同 opId 的墓碑，两种顺序：登记都等于 opId 小的那条', () => {
    const t1 = tomb(1, 'AAAA', []); const t2 = tomb(1, 'BBBB', []);
    const x = mk('devX'); const y = mk('devY');
    expect(x.store.applyTombstone('S', t1).status).toBe('applied');
    expect(x.store.applyTombstone('S', t2)).toEqual({ status: 'stale', released: false });
    expect(y.store.applyTombstone('S', t2).status).toBe('applied');
    expect(y.store.applyTombstone('S', t1).status).toBe('superseded');
    expect(regCore(x, 'S')).toEqual(regCore(y, 'S'));
    expect(regRow(x, 'S')!.op_id).toBe('AAAA');
    // 更早的一代：stale，不动
    const z = mk('devZ');
    z.store.applyTombstone('S', tomb(3, 'ZZZZ', []));
    expect(z.store.applyTombstone('S', t1)).toEqual({ status: 'stale', released: false });
    expect(regRow(z, 'S')!.version).toBe(3);
  });

  it('S10(a) 并发双删、seen 不同：同一个库两条都收到，两种顺序去留相同', () => {
    for (const loserSeenCoversAll of [true, false]) {
      const outcomes: Array<{ alive: number; msgs: number; reg: unknown }> = [];
      for (const order of ['TA-first', 'TB-first'] as const) {
        const c = mk('devC');
        const s = c.store.createSession();
        const [m1, m2, m3] = [addMsg(c, s.id), addMsg(c, s.id), addMsg(c, s.id)];
        const TA = tomb(1, 'AAAA', [m1, m2]);                                  // 赢家（opId 小），没见过 m3
        const TB = tomb(1, 'BBBB', loserSeenCoversAll ? [m1, m2, m3] : [m1, m3]); // 落败
        const seq = order === 'TA-first' ? [TA, TB] : [TB, TA];
        for (const t of seq) c.store.applyTombstone(s.id, t);
        outcomes.push({ alive: sessionRows(c, s.id), msgs: msgCount(c, s.id), reg: { v: regRow(c, s.id)!.version, op: regRow(c, s.id)!.op_id } });
      }
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(outcomes[0].reg).toEqual({ v: 1, op: 'AAAA' });
      // 落败那条覆盖了全部消息 → 清除；两条都没覆盖 m2+m3 → 保留
      expect(outcomes[0].msgs).toBe(loserSeenCoversAll ? 0 : 3);
      expect(outcomes[0].alive).toBe(loserSeenCoversAll ? 0 : 1);
    }
  });

  /** A、B 各自删除同一个会话（A 的 opId 更小、没见过 m3）；C 持有 {m1,m2,m3}。 */
  function doubleDelete(): { a: Node; b: Node; c: Node; sid: string } {
    const a = mk('devA'); const b = mk('devB'); const c = mk('devC');
    const { sid } = shared(a, [b, c], 2);
    addMsg(b, sid, 'm3');
    push(b, c, sid);
    expect(msgCount(c, sid)).toBe(3);
    const forceOp = (n: Node, op: string): void => {
      const orig = n.store.newId;
      n.store.newId = () => op;
      try { n.store.deleteSession(sid); } finally { n.store.newId = orig; }
    };
    forceOp(a, 'AAAA-OP'); forceOp(b, 'BBBB-OP');
    return { a, b, c, sid };
  }

  it('S10(b) 落败墓碑先被覆盖：C 只见到赢家 → 保留 1 条，三库登记相同、都不存活', () => {
    const { a, b, c, sid } = doubleDelete();
    expect(b.store.applyTombstone(sid, a.store.wireLifecycle(sid)!).status).toBe('superseded');
    expect(JSON.parse(regRow(b, sid)!.seen_ids_json as string)).toHaveLength(2);
    expect(a.store.applyTombstone(sid, tomb(1, 'BBBB-OP', []))).toEqual({ status: 'stale', released: false });
    c.store.applyTombstone(sid, b.store.wireLifecycle(sid)!);
    c.store.applyTombstone(sid, a.store.wireLifecycle(sid)!);
    expect(msgCount(c, sid)).toBe(3);
    expect(c.store.listRetainedSessions()[0]).toMatchObject({ id: sid, unseenCount: 1 });
    for (const n of [a, b, c]) {
      expect(regCore(n, sid)).toEqual(regCore(a, sid));
      expect(n.store.getSession(sid)).toBeUndefined();
    }
  });

  it('S10(c) C 在 B 被覆盖之前先收到落败墓碑 → 清除；三库登记仍相同', () => {
    const { a, b, c, sid } = doubleDelete();
    expect(c.store.applyTombstone(sid, b.store.wireLifecycle(sid)!)).toMatchObject({ status: 'applied', retained: false });
    b.store.applyTombstone(sid, a.store.wireLifecycle(sid)!);
    expect(c.store.applyTombstone(sid, a.store.wireLifecycle(sid)!).status).toBe('superseded');
    expect(msgCount(c, sid)).toBe(0);
    expect(sessionRows(c, sid)).toBe(0);
    for (const n of [a, b, c]) expect(regCore(n, sid)).toEqual(regCore(a, sid));
  });

  it('S10 保留副本被一条覆盖它的同代墓碑释放：retained-released，不 onDirty', () => {
    const c = mk('devC');
    const s = c.store.createSession();
    const [m1, m2] = [addMsg(c, s.id), addMsg(c, s.id)];
    c.store.applyTombstone(s.id, tomb(1, 'AAAA', [m1]));
    expect(msgCount(c, s.id)).toBe(2);
    c.dirty.length = 0; c.events.length = 0;
    expect(c.store.applyTombstone(s.id, tomb(1, 'BBBB', [m1, m2]), { fromPeer: 'devB' })).toEqual({ status: 'stale', released: true });
    expect(msgCount(c, s.id)).toBe(0);
    expect(sessionRows(c, s.id)).toBe(0);
    expect(regRow(c, s.id)!.op_id).toBe('AAAA');
    expect(c.dirty).toEqual([]);
    expect(c.events.map(e => e.kind)).toEqual(['retained-released']);
  });

  it('S10 更早一代的墓碑不释放保留副本：它的 seen 覆盖本机全部消息也不清（只有同代的才再判）', () => {
    // 乱序的一种：这个会话在第 1 代被删过、被显式恢复过，又在第 3 代被一台只见过 m1 的设备删掉；本机因为 m2 留着副本。
    // 之后第 1 代的旧墓碑才送到（发它的设备一直离线，或是照着旧登记伪造的），它当时见过 m1 与 m2。
    // 第 1 代的删除早被那次恢复盖过去了：它不能回头清掉第 3 代留下的副本
    const c = mk('devC');
    const s = c.store.createSession('删过、恢复过、又被删');
    const [m1, m2] = [addMsg(c, s.id), addMsg(c, s.id)];
    expect(c.store.applyTombstone(s.id, tomb(3, 'GEN3', [m1]), { fromPeer: 'devA' })).toMatchObject({ status: 'applied', retained: true, unseenCount: 1 });
    const row = regRow(c, s.id);
    const hiddenAt = tombstonedAt(c, s.id);
    c.dirty.length = 0; c.events.length = 0;

    // 见过全部消息的、见得更多的、重复送达的：都是更早的一代
    for (const stale of [tomb(1, 'GEN1', [m1, m2]), tomb(1, 'AAAA', [m1, m2, 'EXTRA']), tomb(1, 'GEN1', [m1, m2])]) {
      expect(c.store.applyTombstone(s.id, stale, { fromPeer: 'devOld' })).toEqual({ status: 'stale', released: false });
    }
    expect(msgIds(c, s.id)).toEqual([m1, m2].sort());
    expect(sessionRows(c, s.id)).toBe(1);
    expect(tombstonedAt(c, s.id)).toBe(hiddenAt);
    expect(regRow(c, s.id)).toEqual(row);
    expect(c.store.listRetainedSessions().map(r => [r.id, r.messageCount, r.unseenCount])).toEqual([[s.id, 2, 1]]);
    expect(c.dirty).toEqual([]);
    expect(c.events).toEqual([]);
    // 对照：同一代（第 3 代）里见过全部消息的另一条墓碑照常释放它
    expect(c.store.applyTombstone(s.id, tomb(3, 'ZZZZ', [m1, m2]))).toEqual({ status: 'stale', released: true });
    expect(sessionRows(c, s.id)).toBe(0);
    expect(msgCount(c, s.id)).toBe(0);
  });
});

describe('S11–S13、S20 显式恢复（V3、I8）', () => {
  /** annotate：被删之前在第一条消息上留一条本机标注（保留副本是冻结的，落成之后加不了）。 */
  function retainedOn(b: Node, extra = 2, annotate = false): { sid: string; all: string[] } {
    const s = b.store.createSession('被别处删掉');
    const seen = [addMsg(b, s.id, 'a'.repeat(300)), addMsg(b, s.id, 'b'.repeat(300))];
    const more = Array.from({ length: extra }, (_, i) => addMsg(b, s.id, `${i}`.repeat(300)));
    if (annotate) b.store.addAnnotation({ sessionId: s.id, messageId: seen[0], exact: 'x' });
    b.store.applyTombstone(s.id, tomb(1, 'OP1', seen), { fromPeer: 'devA' });
    b.dirty.length = 0; b.events.length = 0;
    return { sid: s.id, all: [...seen, ...more].sort() };
  }

  it('S11 restoreSession：登记变偶数、来源是本机、会话重新可见、消息与标注一条不少', () => {
    const b = mk('devB');
    const { sid, all } = retainedOn(b, 2, true);
    const r = b.store.restoreSession(sid);
    expect(r.lifecycle).toMatchObject({ v: 2, originDeviceId: 'devB' });
    expect(r.lifecycle.seen).toBeUndefined();
    expect(regRow(b, sid)).toMatchObject({ version: 2, origin_device_id: 'devB', seen_ids_json: null, seen_count: null, seen_digest: null, received_from: null });
    expect(tombstonedAt(b, sid)).toBeNull();
    expect(b.store.getSession(sid)).toBeDefined();
    expect(b.store.listSessions().map(x => x.id)).toContain(sid);
    expect(b.store.listRetainedSessions()).toEqual([]);
    expect(msgIds(b, sid)).toEqual(all);
    expect(count(b, 'annotations', 'session_id', sid)).toBe(1);
    expect(b.dirty).toEqual([sid]);
    expect(b.events.map(e => e.kind)).toEqual(['restored']);
    expect(b.store.listSyncedSessions().find(x => x.id === sid)!.lifecycle).toEqual({ v: 2, opId: r.lifecycle.opId });
    // 恢复后可以照常写
    expect(() => addMsg(b, sid)).not.toThrow();
  });

  it('S11 不是保留副本（存活的、已清除的、不存在的）调 restoreSession 抛错，登记不变', () => {
    const b = mk('devB');
    const alive = b.store.createSession();
    const gone = b.store.createSession();
    addMsg(b, gone.id);
    b.store.deleteSession(gone.id);
    for (const id of [alive.id, gone.id, 'NOPE']) expect(() => b.store.restoreSession(id)).toThrow(/没有可恢复的内容/);
    expect(regRow(b, alive.id)).toBeUndefined();
    expect(regRow(b, gone.id)!.version).toBe(1);
    // 恢复过的会话（存活、登记为偶数）不是保留副本：再「恢复」一次不行——否则版本加一变成奇数，一个看得见的会话成了「已删除」
    const { sid } = retainedOn(b);
    b.store.restoreSession(sid);
    const before = regRow(b, sid);
    expect(before!.version).toBe(2);
    expect(() => b.store.restoreSession(sid)).toThrow(/没有可恢复的内容/);
    expect(regRow(b, sid)).toEqual(before);
    expect(b.store.isDeleted(sid)).toBe(false);
    expect(b.store.getSession(sid)).toBeDefined();
  });

  it('S11 偶数登记下每一批都带 lifecycle 与 session，摘要只在最后一批；登记为 0 的会话分批形态不变', () => {
    const b = mk('devB');
    const { sid, all } = retainedOn(b, 3);
    b.store.restoreSession(sid);
    b.store.appendCompactMarker(sid, '摘要', all[0]);
    const batches = b.store.buildPushBatches(sid, 1200);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const batch of batches) {
      expect(batch.lifecycle?.v).toBe(2);
      expect(batch.session?.id).toBe(sid);
    }
    expect(batches.slice(0, -1).every(x => x.markers.length === 0)).toBe(true);
    expect(batches[batches.length - 1].markers).toHaveLength(1);
    expect(batches.flatMap(x => x.messages.map(m => m.id)).sort()).toEqual(all);

    const plain = b.store.createSession('普通');
    for (let i = 0; i < 5; i++) addMsg(b, plain.id, `${i}`.repeat(300));
    const pb = b.store.buildPushBatches(plain.id, 1200);
    expect(pb.length).toBeGreaterThanOrEqual(3);
    expect(pb.slice(0, -1).every(x => x.session === undefined && x.lifecycle === undefined)).toBe(true);
    expect(pb[pb.length - 1].session?.id).toBe(plain.id);
    expect(pb[pb.length - 1].lifecycle).toBeUndefined();
  });

  it('S12 已清除的库收到 v=2 的内容：接受并建会话行；不带版本、或版本低于本机的：拒收', () => {
    const a = mk('devA'); const b = mk('devB');
    const { sid, all } = retainedOn(b);
    const stale = fullPayload(b, sid); // 恢复之前的整包：不带版本
    a.store.applyTombstone(sid, tomb(1, 'OP1', []));
    b.store.restoreSession(sid);
    a.dirty.length = 0; a.events.length = 0;

    expect(a.store.mergeRemoteSession(stale, sid).rejected).toBe('tombstoned');
    expect(msgCount(a, sid)).toBe(0);

    const results = push(b, a, sid);
    expect(results[0]).toMatchObject({ restored: true, sessionCreated: true, hasChange: true });
    expect(results[0].rejected).toBeUndefined();
    expect(results[0].lifecycle?.v).toBe(2);
    expect(msgIds(a, sid)).toEqual(all);
    expect(a.store.getSession(sid)).toBeDefined();
    expect(regCore(a, sid)).toEqual(regCore(b, sid));
    expect(regRow(a, sid)!.received_from).toBe('peer');
    expect(a.events.map(e => e.kind)).toEqual(['stale-content-rejected', 'restore-applied']);
    expect(a.dirty).toContain(sid);

    // v=2 打到 v=3 的已删库：拒收
    const c = mk('devC');
    c.store.applyTombstone(sid, tomb(3, 'OP3', []));
    expect(push(b, c, sid)[0].rejected).toBe('tombstoned');
    expect(msgCount(c, sid)).toBe(0);
    expect(regRow(c, sid)!.version).toBe(3);
  });

  it('S12 仍是保留副本的库收到 v=2：原地解冻后合并，本机独有的消息还在', () => {
    const b = mk('devB'); const c = mk('devC');
    const { sid, all } = retainedOn(b);
    // C 也是同一条墓碑下的保留副本，另有一条自己的消息
    expect(push(b, c, sid)).toEqual([]); // B 的副本是隐藏的：没有任何批次可推
    expect(msgCount(c, sid)).toBe(0);
    const cs = c.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)');
    cs.run(sid, 'C 的副本', 1, 1);
    const own = addMsg(c, sid, 'C 独有');
    c.store.applyTombstone(sid, tomb(1, 'OP1', []));
    expect(c.store.listRetainedSessions()).toHaveLength(1);
    c.events.length = 0;

    b.store.restoreSession(sid);
    const r = push(b, c, sid);
    expect(r[0]).toMatchObject({ restored: true, sessionCreated: true });
    expect(tombstonedAt(c, sid)).toBeNull();
    expect(msgIds(c, sid)).toEqual([...all, own].sort());
    expect(c.store.listRetainedSessions()).toEqual([]);
    expect(c.events.map(e => e.kind)).toEqual(['restore-applied']);
  });

  it('S12 I8：偶数登记、只有消息没有 session、本机也没有会话行 → session-required，登记不动、不写行', () => {
    const b = mk('devB');
    const { sid } = retainedOn(b);
    b.store.restoreSession(sid);
    const full = b.store.buildPushBatches(sid)[0];
    const noSession: SyncPayload = { messages: full.messages, markers: [], lifecycle: full.lifecycle };

    const purged = mk('devA'); purged.store.applyTombstone(sid, tomb(1, 'OP1', []));
    const fresh = mk('devC');
    purged.dirty.length = 0; purged.events.length = 0;
    for (const [n, v] of [[purged, 1], [fresh, undefined]] as const) {
      const r = n.store.mergeRemoteSession(noSession, sid);
      expect(r).toMatchObject({ rejected: 'session-required', hasChange: false, mergedCount: 0 });
      expect(regRow(n, sid)?.version).toBe(v);
      expect(msgCount(n, sid)).toBe(0);
      expect(n.dirty).toEqual([]);
      expect(n.events).toEqual([]);
      // 同一批消息带上 session 再来 → 接受
      const ok = n.store.mergeRemoteSession(full, sid);
      expect(ok.rejected).toBeUndefined();
      expect(ok.sessionCreated).toBe(true);
      expect(msgCount(n, sid)).toBe(full.messages.length);
      expect(regRow(n, sid)!.version).toBe(2);
    }

    // 保留副本的库：本机有会话行，不带 session 的载荷也接受
    const kept = mk('devD');
    kept.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)').run(sid, 'D', 1, 1);
    addMsg(kept, sid);
    kept.store.applyTombstone(sid, tomb(1, 'OP1', []));
    const r = kept.store.mergeRemoteSession(noSession, sid);
    expect(r.rejected).toBeUndefined();
    expect(r.restored).toBe(true);
    expect(kept.store.getSession(sid)).toBeDefined();
  });

  it('S12 墓碑载荷直接进 mergeRemoteSession 是编程错误：抛错，不写任何行', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    addMsg(a, s.id);
    expect(() => a.store.mergeRemoteSession({ messages: [], markers: [], lifecycle: tomb(1, 'OP1', []) }, s.id)).toThrow(/receiveRemotePayload/);
    expect(sessionRows(a, s.id)).toBe(1);
    expect(regRow(a, s.id)).toBeUndefined();
  });

  it('S13 先恢复后墓碑、先墓碑后恢复：终态登记相同、都存活', () => {
    const src = mk('devB');
    const { sid, all } = retainedOn(src);
    src.store.restoreSession(sid);
    const restore = src.store.buildPushBatches(sid)[0];
    const T1 = tomb(1, 'OP1', all.slice(0, 2));
    const d1 = mk('devX'); const d2 = mk('devY');
    for (const d of [d1, d2]) {
      d.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)').run(sid, '旧', 1, 1);
    }
    d1.store.applyTombstone(sid, T1);
    d1.store.mergeRemoteSession(restore, sid);
    d2.store.mergeRemoteSession(restore, sid);
    expect(d2.store.applyTombstone(sid, T1)).toEqual({ status: 'stale', released: false });
    for (const d of [d1, d2]) {
      expect(regCore(d, sid)).toEqual(regCore(src, sid));
      expect(d.store.getSession(sid)).toBeDefined();
      expect(msgIds(d, sid)).toEqual(all);
    }
  });

  it('S20 恢复只送达第一批后恢复方消失：接收端是一个可见、可同步的存活会话，第三台照常追平', () => {
    const a = mk('devA'); const b = mk('devB'); const c = mk('devC');
    const { sid } = retainedOn(b, 4);
    for (const n of [a, c]) n.store.applyTombstone(sid, tomb(1, 'OP1', []));
    b.store.restoreSession(sid);
    const batches = b.store.buildPushBatches(sid, 1200);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    a.store.mergeRemoteSession(batches[0], sid, { fromPeer: 'devB' }); // 只有第一批，此后 B 不再参与

    expect(sessionRows(a, sid)).toBe(1);
    expect(a.store.listSessions().map(x => x.id)).toContain(sid);
    const head = a.store.listSyncedSessions().find(x => x.id === sid)!;
    expect(head.lifecycle).toEqual({ v: 2, opId: regRow(b, sid)!.op_id });
    expect(regCore(a, sid)).toEqual(regCore(b, sid));

    // C 与 A 两轮对账的等价步骤：C 的墓碑打到 A 是过期的；C 拉 A 的内容
    expect(a.store.applyTombstone(sid, c.store.wireLifecycle(sid)!)).toEqual({ status: 'stale', released: false });
    for (let round = 0; round < 2; round++) {
      c.store.mergeRemoteSession({ ...fullPayload(a, sid), lifecycle: a.store.wireLifecycle(sid) }, sid, { fromPeer: 'devA' });
      push(c, a, sid);
    }
    expect(regCore(c, sid)).toEqual(regCore(a, sid));
    expect(c.store.getSession(sid)).toBeDefined();
    expect(msgIds(c, sid)).toEqual(msgIds(a, sid));
    expect(msgIds(a, sid).length).toBeGreaterThan(0);
    for (const n of [a, b, c]) {
      expect((n.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)').get() as { c: number }).c).toBe(0);
    }
  });
});

describe('S14 已删会话写不进去（I4）', () => {
  it('已清除的、保留副本的：appendMessage 与 appendCompactMarker 抛「会话已删除」，行数不变', () => {
    const a = mk('devA');
    const gone = a.store.createSession();
    addMsg(a, gone.id);
    a.store.deleteSession(gone.id);
    const kept = a.store.createSession();
    const k1 = addMsg(a, kept.id);
    a.store.applyTombstone(kept.id, tomb(1, 'OP1', []));
    expect(msgCount(a, kept.id)).toBe(1);
    for (const sid of [gone.id, kept.id]) {
      const before = msgCount(a, sid);
      expect(() => addMsg(a, sid)).toThrow('会话已删除');
      expect(() => a.store.appendCompactMarker(sid, 's', k1)).toThrow('会话已删除');
      expect(msgCount(a, sid)).toBe(before);
      expect(count(a, 'compact_markers', 'session_id', sid)).toBe(0);
    }
  });

  it('会话属性同样改不了（标题、工作区、模型绑定、助手、记忆开关、MCP 禁用名单）：会话行与登记原样，不 onDirty；恢复之后照常可改', () => {
    const a = mk('devA');
    const gone = a.store.createSession();
    addMsg(a, gone.id);
    a.store.deleteSession(gone.id);
    const kept = a.store.createSession('原标题');
    addMsg(a, kept.id);
    a.store.applyTombstone(kept.id, tomb(1, 'OP1', []));
    const rowOf = (sid: string): unknown => a.db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
    const row = rowOf(kept.id);
    const reg = regRow(a, kept.id);
    a.dirty.length = 0; a.events.length = 0;

    const writes: Array<[string, (sid: string) => void]> = [
      ['updateSessionTitle', sid => a.store.updateSessionTitle(sid, '改过的')],
      ['setWorkspaceRoot', sid => a.store.setWorkspaceRoot(sid, 'C:/somewhere')],
      ['setWorkspaceRoot(清除)', sid => a.store.setWorkspaceRoot(sid, undefined)],
      ['setModelBinding', sid => a.store.setModelBinding(sid, 'provider:p1')],
      ['setAssistant', sid => a.store.setAssistant(sid, 'asst-1')],
      ['setMemoryEnabled', sid => a.store.setMemoryEnabled(sid, false)],
      ['setMcpDisabled', sid => a.store.setMcpDisabled(sid, ['srv'])],
    ];
    for (const sid of [gone.id, kept.id]) {
      for (const [name, write] of writes) expect(() => write(sid), name).toThrow('会话已删除');
    }
    expect(rowOf(kept.id)).toEqual(row);
    expect(rowOf(gone.id)).toBeUndefined();
    expect(regRow(a, kept.id)).toEqual(reg);
    expect(a.dirty).toEqual([]);
    expect(a.events).toEqual([]);
    expect(a.store.listRetainedSessions().map(r => [r.id, r.title])).toEqual([[kept.id, '原标题']]);

    // 恢复之后是普通的存活会话
    a.store.restoreSession(kept.id);
    for (const [name, write] of writes) expect(() => write(kept.id), name).not.toThrow();
    expect(a.store.getSession(kept.id)).toMatchObject({ title: '改过的', modelBinding: 'provider:p1', assistantId: 'asst-1', memoryEnabled: false, mcpDisabled: ['srv'] });
    // 从未删除过的、不存在的 id 不受这道闸影响（与以前一样是空操作）
    expect(() => a.store.updateSessionTitle('NOPE', 'x')).not.toThrow();
  });

  it('保留副本上的标注不许增、改、删：只因标注而留下的副本，不会因为标注被删而被同代墓碑清掉', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    const m1 = addMsg(a, s.id);
    const anno = a.store.addAnnotation({ sessionId: s.id, messageId: m1, exact: '划线', note: '原笔记' });
    // 对端见过全部消息：这份副本只因这条标注而留下
    expect(a.store.applyTombstone(s.id, tomb(1, 'OP1', [m1]))).toMatchObject({ retained: true, unseenCount: 0, annotationCount: 1 });

    expect(() => a.store.removeAnnotation(anno.id)).toThrow('会话已删除');
    expect(() => a.store.updateAnnotationNote(anno.id, '改掉')).toThrow('会话已删除');
    expect(() => a.store.addAnnotation({ sessionId: s.id, messageId: m1, exact: '再划一条' })).toThrow('会话已删除');
    expect(a.store.listAnnotations(s.id)).toEqual([anno]);
    // 同一条墓碑再来、同代落败的另一条（seen 同样覆盖全部消息）：标注还在，副本不被释放
    expect(a.store.applyTombstone(s.id, tomb(1, 'OP1', [m1]))).toEqual({ status: 'duplicate', released: false });
    expect(a.store.applyTombstone(s.id, tomb(1, 'ZZZ', [m1]))).toEqual({ status: 'stale', released: false });
    expect(msgCount(a, s.id)).toBe(1);
    expect(a.store.listRetainedSessions().map(r => [r.id, r.annotationCount])).toEqual([[s.id, 1]]);

    // 已清除的会话：加标注同样被拒，不留没有会话行的孤儿标注
    const gone = a.store.createSession();
    const g1 = addMsg(a, gone.id);
    a.store.deleteSession(gone.id);
    expect(() => a.store.addAnnotation({ sessionId: gone.id, messageId: g1, exact: 'x' })).toThrow('会话已删除');
    expect(count(a, 'annotations', 'session_id', gone.id)).toBe(0);

    // 未知的标注 id 仍然幂等；恢复之后照常可改可删
    expect(a.store.removeAnnotation('NOPE')).toBeUndefined();
    expect(a.store.updateAnnotationNote('NOPE', 'x')).toBeUndefined();
    a.store.restoreSession(s.id);
    expect(a.store.updateAnnotationNote(anno.id, '改掉')).toBe(s.id);
    expect(a.store.removeAnnotation(anno.id)).toBe(s.id);
    expect(a.store.listAnnotations(s.id)).toEqual([]);
  });

  // 技能覆盖表不归 ChatStore 管（SkillStore 写），存储层的闸够不着它：钉住它的每一个写入口之前都先判过会话。
  // 行为由 sync-delete-e2e 的 E16 经真实引擎的 RPC 钉住，这里是它的源码守卫（先剥注释）
  it('源码守卫：会话技能覆盖的写入口（.setSessionOverride(）只有三处，每一处之前都先判过「会话已删除」或「会话不可见」', async () => {
    const read = (rel: string): string => stripComments(readFileSync(join(SRC, rel), 'utf8'));
    const preset = read('minisd/assistants/store.ts').split('export function applyAssistantPreset(')[1] ?? '';
    const first = preset.indexOf('deps.chat.setAssistant(sessionId');
    expect(first).toBeGreaterThan(0);
    expect(preset.indexOf('.setSessionOverride(')).toBeGreaterThan(first);
    // 真技能与真会话通过两个写入口；已删除、保留副本被拒时没有任何覆盖写入。
    const w = watchEngine();
    const e = await qStart();
    const chat = w.made('new ChatStore');
    const skills = w.made('new SkillStore');
    const skill = skills.upsert({ id: 'Q20A-SKILL', meta: {}, fallbackName: 'Q20A-SKILL', importSource: 'Q20A' });
    const sid = (await qRpc(e, 'chat.sessions.create')).id;
    let from = callMark();
    await qRpc(e, 'skills.setEnabled', { sessionId: sid, id: skill.id, enabled: false });
    expect(w.seq(['chat.isDeleted', 'skills.setSessionOverride'], from)).toEqual(['chat.isDeleted', 'skills.setSessionOverride']);
    expect(w.args('skills.setSessionOverride')).toEqual([sid, skill.id, false]);
    expect(w.spy('skills.setSessionOverride').mock.contexts.at(-1)).toBe(skills);
    from = callMark();
    await qRpc(e, 'chat.sessions.applyAssistant', { sessionId: sid, assistantId: '' });
    expect(w.seq(['chat.getSession', 'skills.setSessionOverride'], from)).toEqual(['chat.getSession', 'skills.setSessionOverride', 'chat.getSession']);
    expect(w.args('skills.setSessionOverride')).toEqual([sid, skill.id, null]);
    expect(w.spy('skills.setSessionOverride').mock.contexts.at(-1)).toBe(skills);
    const dead = chat.createSession('Q20A-DEAD').id;
    chat.deleteSession(dead);
    const retained = chat.createSession('Q20A-RETAINED').id;
    chat.appendMessage({ id: chat.newId(), sessionId: retained, role: 'user', parts: [{ type: 'text', value: '本地保留' }], createdAt: chat.nowEpoch(), streamInterruptCount: 0, streaming: false });
    expect(chat.applyTombstone(retained, tomb(1, 'Q20A-RETAIN', []))).toMatchObject({ status: 'applied', retained: true });
    for (const sessionId of [dead, retained]) {
      from = callMark();
      await expect(qRpc(e, 'skills.setEnabled', { sessionId, id: skill.id, enabled: true })).rejects.toThrow('会话已删除');
      expect(w.count('skills.setSessionOverride', from)).toBe(0);
      expect(w.count('chat.isDeleted', from)).toBe(1);
      expect(w.args('chat.isDeleted')).toEqual([sessionId]);
      expect(w.spy('chat.isDeleted').mock.contexts.at(-1)).toBe(chat);
      from = callMark();
      await expect(qRpc(e, 'chat.sessions.applyAssistant', { sessionId, assistantId: '' })).rejects.toThrow('会话不存在');
      expect(w.count('skills.setSessionOverride', from)).toBe(0);
      expect(w.count('chat.getSession', from)).toBe(1);
      expect(w.args('chat.getSession')).toEqual([sessionId]);
      expect(w.spy('chat.getSession').mock.contexts.at(-1)).toBe(chat);
    }
  }, 60000);
});

describe('S21 载荷里的消息、摘要自带的会话 id 与外层不一致：丢弃，写不进别的会话（I4）', () => {
  const rowsOf = (n: Node, sid: string): { messages: number; markers: number; orphans: number } => ({
    messages: msgCount(n, sid), markers: count(n, 'compact_markers', 'session_id', sid), orphans: count(n, 'sync_orphan_markers', 'session_id', sid),
  });
  const wireMsg = (n: Node, sid: string, text: string): WireMessage => {
    const now = n.store.nowEpoch();
    return { id: n.store.newId(), sessionId: sid, role: 'user', partsJson: JSON.stringify([{ type: 'text', value: text }]), tokenUsageJson: null,
      reasoningContent: null, streamInterruptCount: 0, sortOrder: 0, createdAt: now, updatedAt: now, originDeviceId: 'devEvil', createdLocallyAt: now };
  };
  /** 外层写存活的会话 y；载荷里一条消息、一条锚在 y 的消息上（能解析）的摘要、一条孤儿摘要，自带的会话 id 都是 x。 */
  function smuggle(n: Node, y: string, x: string, anchorInY: string): ReturnType<ChatStore['mergeRemoteSession']> {
    const now = n.store.nowEpoch();
    const resolved: WireCompactMarker = { id: n.store.newId(), sessionId: x, summary: '夹带的摘要', createdAt: now, lastCompactedMessageId: anchorInY, firstKeptSortOrder: 1, compactedCount: 1, version: 2 };
    const orphan: WireCompactMarker = { id: n.store.newId(), sessionId: x, summary: '夹带的孤儿摘要', createdAt: now, firstKeptMessageId: 'NO-SUCH-MESSAGE', firstKeptSortOrder: 99, compactedCount: 0, version: 2 };
    return n.store.mergeRemoteSession({ messages: [wireMsg(n, x, '夹带的消息')], markers: [resolved, orphan] }, y, { fromPeer: 'devEvil' });
  }

  it('已清除的会话：借存活会话夹带进来的消息、摘要、孤儿摘要一行不落；存活会话自己也不收这些', () => {
    const a = mk('devA');
    const x = a.store.createSession('X');
    addMsg(a, x.id);
    a.store.deleteSession(x.id);
    const y = a.store.createSession('Y');
    const y1 = addMsg(a, y.id);
    // 对照：直接推已删的会话，入口闸拒掉
    expect(a.store.mergeRemoteSession({ messages: [wireMsg(a, x.id, '直推')], markers: [] }, x.id).rejected).toBe('tombstoned');
    a.dirty.length = 0; a.events.length = 0;

    const r = smuggle(a, y.id, x.id, y1);
    expect(r).toMatchObject({ mergedCount: 0, hasChange: false, orphanMarkerIds: [] });
    expect(r.rejected).toBeUndefined();
    expect(rowsOf(a, x.id)).toEqual({ messages: 0, markers: 0, orphans: 0 });
    expect(rowsOf(a, y.id)).toEqual({ messages: 1, markers: 0, orphans: 0 });
    expect((a.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)').get() as { c: number }).c).toBe(0);
    expect(a.dirty).toEqual([]);
    expect(a.store.isDeleted(x.id)).toBe(true);
    expect(sessionRows(a, x.id)).toBe(0);
  });

  it('保留副本：夹带的进不来，条数与「对方没见过」不变；之后覆盖它的同代墓碑照常释放它', () => {
    const a = mk('devA');
    const x = a.store.createSession('X');
    const [x1, x2] = [addMsg(a, x.id), addMsg(a, x.id)];
    a.store.applyTombstone(x.id, tomb(1, 'AAAA', [x1]));
    const y = a.store.createSession('Y');
    const y1 = addMsg(a, y.id);
    const before = a.store.listRetainedSessions();
    expect(before.map(r => [r.id, r.messageCount, r.unseenCount])).toEqual([[x.id, 2, 1]]);
    a.dirty.length = 0; a.events.length = 0;

    smuggle(a, y.id, x.id, y1);
    expect(a.store.listRetainedSessions()).toEqual(before);
    expect(rowsOf(a, x.id)).toEqual({ messages: 2, markers: 0, orphans: 0 });
    expect(msgIds(a, x.id)).toEqual([x1, x2].sort());
    expect(a.dirty).toEqual([]);
    // 另一条同代墓碑见过它原来的两条消息：照常释放。被掺进第三条的话，这里就释放不了
    expect(a.store.applyTombstone(x.id, tomb(1, 'BBBB', [x1, x2]))).toEqual({ status: 'stale', released: true });
    expect(rowsOf(a, x.id)).toEqual({ messages: 0, markers: 0, orphans: 0 });
  });

  it('同一个载荷里属于这个会话的照收、不属于的丢掉；两个存活会话之间也不串', () => {
    const a = mk('devA'); const b = mk('devB');
    const y = a.store.createSession('Y');
    addMsg(a, y.id);
    const z = a.store.createSession('Z');
    addMsg(a, z.id);
    push(a, b, y.id);
    const extra = addMsg(b, y.id);
    const p = fullPayload(b, y.id);
    const stray = wireMsg(b, z.id, '标着 Z 的消息');

    const r = a.store.mergeRemoteSession({ ...p, messages: [...p.messages, stray] }, y.id, { fromPeer: 'devB' });
    expect(r.mergedCount).toBe(1);
    expect(msgIds(a, y.id)).toContain(extra);
    expect(msgCount(a, y.id)).toBe(2);
    expect(msgCount(a, z.id)).toBe(1);
    expect((a.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE id=?').get(stray.id) as { c: number }).c).toBe(0);
  });
});

describe('S15 墓碑 GC 只压实 id 列表，行永不删（V5、B3）', () => {
  it('超龄的 seen_ids_json 置空，条数、摘要、行都还在；保留副本的那一行不压', () => {
    const a = mk('devA', 1_000_000);
    const s = a.store.createSession();
    const ids = [addMsg(a, s.id), addMsg(a, s.id), addMsg(a, s.id)];
    a.store.deleteSession(s.id);
    const young = a.store.createSession();
    addMsg(a, young.id);
    const kept = a.store.createSession();
    addMsg(a, kept.id);
    a.store.applyTombstone(kept.id, tomb(1, 'OPK', []));
    const recordedAt = regRow(a, s.id)!.recorded_at as number;
    a.clock.ms += 50_000;
    a.store.deleteSession(young.id);

    // 截止点落在两次删除之间：只压第一条
    expect(a.store.compactTombstones(recordedAt + 20, 10)).toBe(1);
    expect(regRow(a, s.id)).toMatchObject({ version: 1, seen_ids_json: null, seen_count: 3, seen_digest: digestIds(ids) });
    expect(regRow(a, young.id)!.seen_ids_json).not.toBeNull();
    expect(a.store.wireLifecycle(s.id)!.seen).toEqual({ count: 3, digest: digestIds(ids) });
    // 全部超龄：保留副本的那一行仍不压
    expect(a.store.compactTombstones(recordedAt + 10_000_000, 0)).toBe(1);
    expect(regRow(a, kept.id)!.seen_ids_json).not.toBeNull();
    expect((a.db.prepare('SELECT COUNT(*) AS c FROM session_lifecycle').get() as { c: number }).c).toBe(3);
    // 再跑一次没有可压的
    expect(a.store.compactTombstones(recordedAt + 10_000_000, 0)).toBe(0);
  });

  it('压实后的墓碑：完全相同的副本 → 清除；真子集 → 保留且条数未知；没有消息 → 只记登记；旧副本仍被拒', () => {
    const a = mk('devA'); const same = mk('devB'); const subset = mk('devC'); const empty = mk('devD');
    const s = a.store.createSession();
    addMsg(a, s.id); addMsg(a, s.id);
    push(a, subset, s.id);
    addMsg(a, s.id);
    push(a, same, s.id);
    const stale = fullPayload(same, s.id);
    a.store.deleteSession(s.id);
    expect(a.store.compactTombstones(a.store.nowEpoch() + 10, 0)).toBe(1);
    const t = a.store.wireLifecycle(s.id)!;
    expect(t.seen!.ids).toBeUndefined();

    expect(same.store.applyTombstone(s.id, t)).toMatchObject({ status: 'applied', retained: false });
    expect(msgCount(same, s.id)).toBe(0);
    expect(subset.store.applyTombstone(s.id, t)).toMatchObject({ status: 'applied', retained: true, unseenCount: null });
    expect(msgCount(subset, s.id)).toBe(2);
    expect(subset.store.listRetainedSessions()[0].unseenCount).toBeNull();
    expect(empty.store.applyTombstone(s.id, t)).toMatchObject({ status: 'applied', hadLocalCopy: false });

    expect(a.store.mergeRemoteSession(stale, s.id).rejected).toBe('tombstoned');
    expect(msgCount(a, s.id)).toBe(0);
    expect(sessionRows(a, s.id)).toBe(0);
  });
});

describe('S16 源码守卫：物理删除只有一个出口，墓碑行没有删除路径，收包只有一个入口（B1、B3）', () => {
  const files = walk(SRC).map(p => ({ rel: relative(SRC, p).split(sep).join('/'), text: stripComments(readFileSync(p, 'utf8')) }));

  it('src 下 DELETE FROM sessions 只出现一次，且在 purgeSessionRows 里', () => {
    const hits = files.flatMap(f => (f.text.match(/DELETE\s+FROM\s+sessions\b/gi) ?? []).map(() => f.rel));
    expect(hits).toEqual(['minisd/store/chat-store.ts']);
    const src = files.find(f => f.rel === 'minisd/store/chat-store.ts')!.text;
    const start = src.indexOf('private purgeSessionRows(');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    expect(body).toMatch(/DELETE\s+FROM\s+sessions\b/i);
    // 防线在任何 DELETE 之前
    expect(body.indexOf('登记不是已删除')).toBeGreaterThan(0);
    expect(body.indexOf('登记不是已删除')).toBeLessThan(body.search(/DELETE\s+FROM/i));
    // 会话名下的内容行只在这里清
    for (const table of ['messages', 'compact_markers', 'sync_orphan_markers', 'session_skill_overrides', 'sync_attachments']) {
      expect(body, table).toMatch(new RegExp(`DELETE\\s+FROM\\s+${table}\\s+WHERE\\s+session_id`, 'i'));
    }
  });

  it('src 下没有 DELETE FROM session_lifecycle', () => {
    for (const f of files) expect(f.text, f.rel).not.toMatch(/DELETE\s+FROM\s+session_lifecycle/i);
  });

  it('src 下 .mergeRemoteSession( 只在 sync/receive.ts 里被调用', () => {
    const callers = files.filter(f => /\.mergeRemoteSession\(/.test(f.text)).map(f => f.rel);
    expect(callers).toEqual(['minisd/sync/receive.ts']);
  });
});

describe('S17 三个库的随机模拟：时钟偏移与乱序下收敛，且不丢没人见过的内容（V2、V5、B2）', () => {
  function rng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (x + 0x6D2B79F5) >>> 0;
      let t = x;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 协调器对一个会话做的事的等价步骤：已删除的一方给墓碑；存活的一方分批推内容，被拒就当场应用对方的墓碑；
   *  对方的偶数登记更高就反过来拉一次。truncate > 0 时只送前几批（模拟中途断线）。 */
  function deliver(from: Node, to: Node, sid: string, truncate = 0, depth = 0): void {
    if (from.store.isDeleted(sid)) {
      to.store.applyTombstone(sid, from.store.wireLifecycle(sid)!, { fromPeer: 'p' });
      return;
    }
    const batches = from.store.buildPushBatches(sid, truncate > 0 ? 600 : undefined);
    const send = truncate > 0 ? batches.slice(0, truncate) : batches;
    let last: ReturnType<ChatStore['mergeRemoteSession']> | undefined;
    for (const b of send) {
      last = to.store.mergeRemoteSession(b, sid, { fromPeer: 'p' });
      if (last.rejected === 'tombstoned') break;
    }
    const wl = last?.lifecycle;
    if (!wl || compareLifecycle(wl, from.store.getLifecycle(sid)) <= 0) return;
    if (wl.v % 2 === 1) from.store.applyTombstone(sid, wl, { fromPeer: 'p' });
    else if (depth === 0) deliver(to, from, sid, 0, 1);
  }

  it('300 个种子：登记、存活集合、存活会话的消息集合三库相等；消失的消息都有删除方见过', () => {
    const DAY = 86_400_000;
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
      const nodes = [mk('dev0', 1_700_000_000_000 - 10 * DAY), mk('dev1', 1_700_000_000_000), mk('dev2', 1_700_000_000_000 + 10 * DAY)];
      const sids = [nodes[0].store.createSession('s0').id, nodes[1].store.createSession('s1').id];
      const created = new Set<string>();
      const seenByDeleters = new Set<string>();
      for (let i = 0; i < 2; i++) created.add(addMsg(nodes[i], sids[i]));

      for (let step = 0; step < 45; step++) {
        const n = pick(nodes); const sid = pick(sids);
        const roll = rand();
        const alive = n.store.getSession(sid) !== undefined;
        const retained = n.store.listRetainedSessions().some(r => r.id === sid);
        if (roll < 0.30) {
          if (alive) created.add(addMsg(n, sid));
        } else if (roll < 0.40) {
          if (alive) {
            const r = n.store.deleteSession(sid);
            if (r.kind === 'deleted') for (const id of r.lifecycle.seen?.ids ?? []) seenByDeleters.add(id);
          }
        } else if (roll < 0.48) {
          if (retained) n.store.restoreSession(sid);
        } else if (roll < 0.53) {
          if (alive) { const ids = msgIds(n, sid); if (ids.length) n.store.addAnnotation({ sessionId: sid, messageId: ids[0], exact: 'x' }); }
        } else {
          const to = pick(nodes.filter(x => x !== n));

          deliver(n, to, sid, rand() < 0.2 ? 1 : 0);
          if (rand() < 0.3) deliver(n, to, sid); // 重复投递

        }
      }
      // 全量对账若干轮：每一对、两个方向
      for (let round = 0; round < 4; round++) {
        for (const x of nodes) for (const y of nodes) if (x !== y) for (const sid of sids) {

          deliver(x, y, sid);

        }
      }

      for (const sid of sids) {
        const reg0 = regCore(nodes[0], sid);
        const alive0 = nodes[0].store.getSession(sid) !== undefined;
        for (const n of nodes) {
          expect(regCore(n, sid), `seed ${seed} 登记`).toEqual(reg0);
          expect(n.store.getSession(sid) !== undefined, `seed ${seed} 存活`).toBe(alive0);
          if (alive0) expect(msgIds(n, sid), `seed ${seed} 消息`).toEqual(msgIds(nodes[0], sid));
          // I2：隐藏标记与登记一致
          const hidden = tombstonedAt(n, sid);
          if (hidden !== undefined && hidden !== null) expect(n.store.isDeleted(sid), `seed ${seed} I2`).toBe(true);
        }
      }
      const surviving = new Set(nodes.flatMap(n => (n.db.prepare('SELECT id FROM messages').all() as Array<{ id: string }>).map(r => r.id)));
      for (const id of created) {
        if (surviving.has(id)) continue;
        expect(seenByDeleters.has(id), `seed ${seed}：消息 ${id} 从全部库里消失，却没有任何删除方见过它`).toBe(true);
      }
      for (const n of nodes) n.db.close();
    }
  }, 120_000);
});

describe('S18 迁移：只建新表，旧数据不动、全部可见、幂等', () => {
  it('停在上一个 user_version 的库重开', () => {
    // 按内容找这条迁移（不写死它是最后一条：之后的任务也在末尾追加迁移）
    const idx = MIGRATIONS.findIndex(m => m.includes('CREATE TABLE session_lifecycle'));
    // 钉死下标：这条迁移发布在 [13]。原先写的是「最后一条」（MIGRATIONS.length - 1），F08 在它后面追加了 [14] 之后不再成立；
    // 下面照旧从「停在 13 的库」补跑到最新，只是补跑的不止这一条
    expect(idx).toBe(13);
    expect(MIGRATIONS[idx]).not.toMatch(/ALTER\s+TABLE|DROP\s|UPDATE\s|DELETE\s/i);
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.slice(0, idx));
    expect(db.pragma('user_version', { simple: true })).toBe(idx);
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)').run('OLD-1', '旧会话一', 1, 2);
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)').run('OLD-2', '旧会话二', 3, 4);
    db.prepare('INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?)').run('M1', 'OLD-1', 'user', '[]', 3, 3, 0);
    const before = { sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(), messages: db.prepare('SELECT * FROM messages').all() };

    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const cols = (db.prepare(`PRAGMA table_info('session_lifecycle')`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(['session_id', 'version', 'op_id', 'origin_device_id', 'origin_at', 'seen_count', 'seen_digest', 'seen_ids_json', 'received_from', 'recorded_at']);
    expect(db.prepare('SELECT COUNT(*) AS c FROM session_lifecycle').get()).toEqual({ c: 0 });
    const store = new ChatStore(db, 'devA');
    // 构造器会幂等补两列，比较时只看迁移前就有的列
    const after = (db.prepare('SELECT * FROM sessions ORDER BY id').all() as Array<Record<string, unknown>>).map(r => {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(before.sessions[0] as object)) o[k] = r[k];
      return o;
    });
    expect(after).toEqual(before.sessions);
    expect(db.prepare('SELECT * FROM messages').all()).toEqual(before.messages);
    expect(store.listSessions().map(s => s.id).sort()).toEqual(['OLD-1', 'OLD-2']);
    expect(store.listTombstoneHeads()).toEqual([]);
    expect(store.listRetainedSessions()).toEqual([]);
    expect(store.repairLifecycle()).toEqual({ unhidden: 0, hidden: 0 });

    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });
});

describe('S19 启动自检：登记与隐藏标记不一致时让会话可见或保留，不清内容', () => {
  it('标记非空、登记缺失 → 重新可见；登记为奇数、会话行存在、标记为空 → 隐藏并列入保留副本', () => {
    const a = mk('devA');
    const ghost = a.store.createSession('被外力藏起来的');
    addMsg(a, ghost.id);
    a.db.prepare('UPDATE sessions SET remote_tombstoned_at=? WHERE id=?').run(123, ghost.id);
    expect(a.store.getSession(ghost.id)).toBeUndefined();

    const zombie = a.store.createSession('登记说已删、行却还在');
    addMsg(a, zombie.id); addMsg(a, zombie.id);
    a.db.prepare(`INSERT INTO session_lifecycle (session_id, version, op_id, origin_device_id, origin_at, recorded_at) VALUES (?, 1, 'OP', 'devX', 1, 1)`).run(zombie.id);
    expect(a.store.getSession(zombie.id)).toBeDefined();

    expect(a.store.repairLifecycle()).toEqual({ unhidden: 1, hidden: 1 });
    expect(a.store.getSession(ghost.id)).toBeDefined();
    expect(msgCount(a, ghost.id)).toBe(1);
    expect(a.store.getSession(zombie.id)).toBeUndefined();
    expect(msgCount(a, zombie.id)).toBe(2);
    expect(a.store.listRetainedSessions().map(r => r.id)).toEqual([zombie.id]);
    // 幂等
    expect(a.store.repairLifecycle()).toEqual({ unhidden: 0, hidden: 0 });
  });
});

describe('S22 purgeRetained：只清此刻仍是保留副本的会话', () => {
  it('保留副本：清内容，登记不变，不 onDirty，事件是 purged；再清一次没有可清的', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    addMsg(a, s.id);
    a.store.applyTombstone(s.id, tomb(1, 'OP1', []));
    const row = regRow(a, s.id);
    a.dirty.length = 0; a.events.length = 0;
    expect(a.store.purgeRetained(s.id).lifecycle).toMatchObject({ v: 1, opId: 'OP1' });
    expect(msgCount(a, s.id)).toBe(0);
    expect(sessionRows(a, s.id)).toBe(0);
    expect(regRow(a, s.id)).toEqual(row);
    expect(a.dirty).toEqual([]);
    expect(a.events.map(e => e.kind)).toEqual(['purged']);
    expect(a.store.listRetainedSessions()).toEqual([]);
    expect(() => a.store.purgeRetained(s.id)).toThrow(/已经清除/);
    expect(a.events.map(e => e.kind)).toEqual(['purged']);
  });

  it('保留副本刚被别的设备恢复（偶数登记合并进来、原地解冻）：抛错，登记仍是 2，会话与消息都在，不 onDirty、不发事件', () => {
    const b = mk('devB'); const c = mk('devC');
    const { sid } = shared(b, [c], 2);
    // 第三台设备的删除，没见过这两条消息：b、c 各留一份保留副本
    const t = tomb(1, 'OP1', []);
    b.store.applyTombstone(sid, t, { fromPeer: 'devA' });
    c.store.applyTombstone(sid, t, { fromPeer: 'devA' });
    expect(b.store.listRetainedSessions().map(r => r.id)).toEqual([sid]);
    // c 恢复并同步到 b：b 的副本原地解冻。b 的界面此刻可能还列着它
    c.store.restoreSession(sid);
    expect(push(c, b, sid)[0]).toMatchObject({ restored: true });
    expect(b.store.getSession(sid)).toBeDefined();
    const reg = regRow(b, sid);
    expect(reg!.version).toBe(2);
    b.dirty.length = 0; b.events.length = 0;

    expect(() => b.store.purgeRetained(sid)).toThrow(/已不是保留副本/);
    expect(regRow(b, sid)).toEqual(reg);
    expect(msgCount(b, sid)).toBe(2);
    expect(sessionRows(b, sid)).toBe(1);
    expect(b.store.getSession(sid)).toBeDefined();
    expect(b.dirty).toEqual([]);
    expect(b.events).toEqual([]);

    // 对照（界面以前走的就是这一个）：通用的删除此刻落到存活会话上，写出 v=3 的新墓碑并传播，c 刚恢复的会话被清掉
    const d = b.store.deleteSession(sid);
    expect(d.kind === 'deleted' && d.lifecycle.v).toBe(3);
    expect(b.dirty).toEqual([sid]);
    expect(c.store.applyTombstone(sid, b.store.wireLifecycle(sid)!)).toMatchObject({ status: 'applied', retained: false });
    expect(msgCount(c, sid)).toBe(0);
  });

  it('存活的（从未删除、本机恢复过的）、已清除的、不存在的：都抛错，什么都不动', () => {
    const a = mk('devA');
    const alive = a.store.createSession();
    addMsg(a, alive.id);
    const gone = a.store.createSession();
    addMsg(a, gone.id);
    a.store.deleteSession(gone.id);
    const restored = a.store.createSession();
    addMsg(a, restored.id);
    a.store.applyTombstone(restored.id, tomb(1, 'OP1', []));
    a.store.restoreSession(restored.id);
    const ids = [alive.id, gone.id, restored.id];
    const regs = ids.map(id => regRow(a, id));
    a.dirty.length = 0; a.events.length = 0;

    expect(() => a.store.purgeRetained(alive.id)).toThrow(/已不是保留副本/);
    expect(() => a.store.purgeRetained(restored.id)).toThrow(/已不是保留副本/);
    expect(() => a.store.purgeRetained(gone.id)).toThrow(/已经清除/);
    expect(() => a.store.purgeRetained('NOPE')).toThrow(/已经清除/);
    expect(ids.map(id => regRow(a, id))).toEqual(regs);
    expect(regRow(a, 'NOPE')).toBeUndefined();
    expect(msgCount(a, alive.id)).toBe(1);
    expect(msgCount(a, restored.id)).toBe(1);
    expect(a.store.listSessions().map(s => s.id).sort()).toEqual([alive.id, restored.id].sort());
    expect(a.dirty).toEqual([]);
    expect(a.events).toEqual([]);
  });
});

describe('钩子与时钟', () => {
  it('onLifecycle 钩子抛错不影响操作本身', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    addMsg(a, s.id);
    a.store.onLifecycle = () => { throw new Error('审计库坏了'); };
    expect(a.store.deleteSession(s.id).kind).toBe('deleted');
    expect(sessionRows(a, s.id)).toBe(0);
    expect(regRow(a, s.id)!.version).toBe(1);
  });

  it('彻底删除保留副本：purged，登记不变，不 onDirty', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    addMsg(a, s.id);
    a.store.applyTombstone(s.id, tomb(1, 'OP1', []));
    const row = regRow(a, s.id);
    a.dirty.length = 0; a.events.length = 0;
    const r = a.store.deleteSession(s.id);
    expect(r.kind).toBe('purged');
    expect(msgCount(a, s.id)).toBe(0);
    expect(sessionRows(a, s.id)).toBe(0);
    expect(regRow(a, s.id)).toEqual(row);
    expect(a.dirty).toEqual([]);
    expect(a.events.map(e => e.kind)).toEqual(['purged']);
  });

  it('删除恢复过的会话：版本加一成 3；版本到上限时删除抛错且什么都没删', () => {
    const a = mk('devA');
    const s = a.store.createSession();
    addMsg(a, s.id);
    a.store.applyTombstone(s.id, tomb(1, 'OP1', []));
    a.store.restoreSession(s.id);
    const r = a.store.deleteSession(s.id);
    expect(r.kind === 'deleted' && r.lifecycle.v).toBe(3);

    const t = a.store.createSession();
    addMsg(a, t.id);
    a.db.prepare(`INSERT INTO session_lifecycle (session_id, version, op_id, origin_device_id, origin_at, recorded_at) VALUES (?, 1000000, 'OP', 'devX', 1, 1)`).run(t.id);
    expect(() => a.store.deleteSession(t.id)).toThrow();
    expect(sessionRows(a, t.id)).toBe(1);
    expect(msgCount(a, t.id)).toBe(1);
    expect(regRow(a, t.id)!.version).toBe(1000000);
  });

  it('已知边界：对端把登记顶到上限（v=1000000 的内容，或 v=999999 的墓碑之后本机恢复）——照规则采纳，此后删除抛错且什么都没动；超过上限的版本不采信', () => {
    const a = mk('devA');
    const s = a.store.createSession('S');
    const m = addMsg(a, s.id);
    const top: WireLifecycle = { v: 1_000_000, opId: 'OP-TOP', originDeviceId: 'devPeer', at: 1 };
    expect(a.store.mergeRemoteSession({ messages: [], markers: [], lifecycle: top }, s.id, { fromPeer: 'devPeer' })).toMatchObject({ hasChange: true });
    const row = regRow(a, s.id);
    expect(row).toMatchObject({ version: 1_000_000, op_id: 'OP-TOP' });
    a.dirty.length = 0; a.events.length = 0;
    expect(() => a.store.deleteSession(s.id)).toThrow(/已到上限/);
    expect(regRow(a, s.id)).toEqual(row);
    expect(sessionRows(a, s.id)).toBe(1);
    expect(msgIds(a, s.id)).toEqual([m]);
    expect(a.store.getSession(s.id)).toBeDefined();
    expect(a.dirty).toEqual([]);
    expect(a.events).toEqual([]);
    // 这条登记照常随内容同步出去：采纳它的设备同样删不掉（规格文档 §5）
    expect(a.store.buildPushBatches(s.id).every(b => b.lifecycle?.v === 1_000_000)).toBe(true);

    // v=999999 的墓碑 → 保留副本 → 本机恢复到 1000000 → 再删同样抛错、什么都没动
    const t = a.store.createSession('T');
    addMsg(a, t.id);
    a.store.applyTombstone(t.id, tomb(999_999, 'OP-ODD', []));
    expect(a.store.restoreSession(t.id).lifecycle.v).toBe(1_000_000);
    const rowT = regRow(a, t.id);
    expect(() => a.store.deleteSession(t.id)).toThrow(/已到上限/);
    expect(regRow(a, t.id)).toEqual(rowT);
    expect(msgCount(a, t.id)).toBe(1);

    // 超过上限的版本按「不带版本」处理：不采纳，这个会话照常可删
    const u = a.store.createSession('U');
    addMsg(a, u.id);
    a.store.mergeRemoteSession({ messages: [], markers: [], lifecycle: { ...top, v: 1_000_001 } }, u.id);
    expect(regRow(a, u.id)).toBeUndefined();
    expect(a.store.deleteSession(u.id).kind).toBe('deleted');
  });

  it('登记只增不减：写入一条不更大的登记抛错，原登记不变（运行期防线）', () => {
    const a = mk('devA');
    a.store.applyTombstone('S', tomb(3, 'OP3', []));
    const write = (l: WireLifecycle): void => (a.store as unknown as { writeLifecycle(id: string, l: WireLifecycle, from: string | undefined): void }).writeLifecycle('S', l, undefined);
    for (const lower of [tomb(1, 'OP1', []), tomb(3, 'OP3', []), tomb(3, 'ZZZ', []), { v: 2, opId: 'R', originDeviceId: 'd', at: 1 }]) {
      expect(() => write(lower)).toThrow(/只增不减/);
    }
    expect(regRow(a, 'S')).toMatchObject({ version: 3, op_id: 'OP3' });
  });

  it('ChatStoreOpts.now：时间戳取注入的时钟', () => {
    const a = mk('devA', 5_000);
    const s = a.store.createSession();
    expect(s.createdAt).toBeGreaterThanOrEqual(5);
    expect(s.createdAt).toBeLessThan(6);
  });
});
