/** Q12：合并只写新出现的消息和序号变了的行，语句不在循环里逐行准备。
 *
 *  写入的行数用 SQLite 的 total_changes() 数（被忽略的 INSERT、改不到行的 UPDATE 都不计）；
 *  语句的准备与执行次数用包在 db.prepare 外面的计数器数，按 SQL 的开头归类。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { SyncCoordinator } from '../src/minisd/sync/coordinator';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import type { OutboundClient } from '../src/minisd/sync/outbound-client';
import type { RpcServer } from '../src/minisd/rpc/server';
import type { SyncPayload, WireCompactMarker, WireMessage } from '../src/minisd/sync/wire';

const INSERT_MESSAGE = 'INSERT OR IGNORE INTO messages';
const MOVE_MESSAGE = 'UPDATE messages SET sort_order';
const PUT_ORPHAN = 'INSERT OR REPLACE INTO sync_orphan_markers';
const INSERT_MARKER = 'INSERT OR IGNORE INTO compact_markers';
const UPDATE_MARKER = 'UPDATE compact_markers SET summary';
const DROP_ORPHAN = 'DELETE FROM sync_orphan_markers WHERE id';

interface Counts { prepared: Map<string, number>; executed: Map<string, number> }
/** 在建 ChatStore 之前包住 db.prepare：之后这条连接上每一次准备、每一次 run/get/all 都记数。 */
function counted(db: Database.Database): Counts {
  const c: Counts = { prepared: new Map(), executed: new Map() };
  const real = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const key = sql.replace(/\s+/g, ' ').trim();
    c.prepared.set(key, (c.prepared.get(key) ?? 0) + 1);
    const st = real(sql);
    return new Proxy(st, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== 'function') return v;
        if (prop === 'run' || prop === 'get' || prop === 'all') {
          return (...args: unknown[]) => { c.executed.set(key, (c.executed.get(key) ?? 0) + 1); return (v as (...a: unknown[]) => unknown).apply(target, args); };
        }
        return (v as (...a: unknown[]) => unknown).bind(target);
      },
    });
  };
  return c;
}
const sum = (m: Map<string, number>, prefix: string): number => [...m].filter(([k]) => k.startsWith(prefix)).reduce((n, [, v]) => n + v, 0);

let a: ChatStore;
let b: ChatStore;
let dbB: Database.Database;
let counts: Counts;
let sid: string;

const totalChanges = (): number => (dbB.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
function append(store: ChatStore, id: string, at: number, text = 'x'): void {
  store.appendMessage({ id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: text }], createdAt: at, streamInterruptCount: 0 });
}
/** A 上整个会话的一个载荷（消息、摘要、会话行都在）。 */
const payload = (): SyncPayload => { const batches = a.buildPushBatches(sid); expect(batches).toHaveLength(1); return JSON.parse(JSON.stringify(batches[0])) as SyncPayload; };
/** 合并一次，返回这次合并写了几行、消息的两条语句各准备和执行了几次。 */
function merge(p: SyncPayload) {
  const before = totalChanges();
  counts.prepared.clear(); counts.executed.clear();
  const result = b.mergeRemoteSession(p, sid, { fromPeer: 'A' });
  const stmts = {
    insertPrepared: sum(counts.prepared, INSERT_MESSAGE), insertExecuted: sum(counts.executed, INSERT_MESSAGE),
    movePrepared: sum(counts.prepared, MOVE_MESSAGE), moveExecuted: sum(counts.executed, MOVE_MESSAGE),
  };
  return { result, stmts, rowsWritten: totalChanges() - before };
}
const sortOrders = (): Array<[string, number]> =>
  (dbB.prepare('SELECT id, sort_order FROM messages WHERE session_id=? ORDER BY sort_order, id').all(sid) as Array<{ id: string; sort_order: number }>).map(r => [r.id, r.sort_order]);

beforeEach(() => {
  a = new ChatStore(openDb(':memory:'), 'A');
  sid = a.createSession('会话').id;
  for (let i = 0; i < 40; i++) append(a, `M${String(i).padStart(2, '0')}`, 100 + i, `第 ${i} 条`);
  a.appendCompactMarker(sid, '摘要', 'M10');
  dbB = openDb(':memory:');
  counts = counted(dbB);
  b = new ChatStore(dbB, 'B');
});

describe('Q12 合并只写新出现的消息和序号变了的行', () => {
  it('第一次合并：40 条消息各插入一次，语句只准备一次，不为刚插入的行再改序号', () => {
    const first = merge(payload());
    expect(first.result).toMatchObject({ mergedCount: 40, hasChange: true });
    expect(first.stmts).toEqual({ insertPrepared: 1, insertExecuted: 40, movePrepared: 0, moveExecuted: 0 });
    // 40 条消息、1 条摘要、1 行会话
    expect(first.rowsWritten).toBe(42);
    expect(sortOrders()).toEqual(Array.from({ length: 40 }, (_, i) => [`M${String(i).padStart(2, '0')}`, i]));
  });

  it('对端重推一批带会话行的完全相同的内容：写入 0 行（Q12 之前也是 0 行），消息的两条语句既不准备也不执行（这才是 Q12 改掉的）', () => {
    merge(payload());
    const again = merge(payload());
    expect(again.rowsWritten).toBe(0);
    expect(again.result).toMatchObject({ mergedCount: 0, hasChange: false, orphanMarkerIds: [] });
    expect(again.stmts).toEqual({ insertPrepared: 0, insertExecuted: 0, movePrepared: 0, moveExecuted: 0 });
  });

  it('只多一条排在末尾的新消息：恰好写入这一行', () => {
    merge(payload());
    append(a, 'M40', 140, '新的一条');
    const next = merge(payload());
    expect(next.result).toMatchObject({ mergedCount: 1, hasChange: true });
    expect(next.rowsWritten).toBe(1);
    expect(next.stmts).toEqual({ insertPrepared: 1, insertExecuted: 1, movePrepared: 0, moveExecuted: 0 });
    expect(b.listMessages(sid).map(m => m.id).at(-1)).toBe('M40');
  });

  it('一条排到中间的新消息：写入它自己，再改它后面那些行的序号，前面的行不碰', () => {
    merge(payload());
    append(a, 'MID', 119.5, '插在 M19 与 M20 之间');
    const next = merge(payload());
    expect(next.result).toMatchObject({ mergedCount: 1, hasChange: true });
    // 新消息 1 行；M20..M39 这 20 行的序号各加一
    expect(next.rowsWritten).toBe(21);
    expect(next.stmts).toEqual({ insertPrepared: 1, insertExecuted: 1, movePrepared: 1, moveExecuted: 20 });
    const ids = [...Array.from({ length: 20 }, (_, i) => `M${String(i).padStart(2, '0')}`), 'MID', ...Array.from({ length: 20 }, (_, i) => `M${20 + i}`)];
    expect(sortOrders()).toEqual(ids.map((id, i) => [id, i]));
    // 再推一遍：已经对齐，什么都不写
    expect(merge(payload()).rowsWritten).toBe(0);
  });

  it('库里的序号被改乱（内容相同）：重推时只把不对的那几行改回来', () => {
    merge(payload());
    dbB.prepare('UPDATE messages SET sort_order=? WHERE id=?').run(7, 'M30');
    dbB.prepare('UPDATE messages SET sort_order=? WHERE id=?').run(99, 'M31');
    const again = merge(payload());
    expect(again.rowsWritten).toBe(2);
    expect(again.stmts).toEqual({ insertPrepared: 0, insertExecuted: 0, movePrepared: 1, moveExecuted: 2 });
    expect(again.result).toMatchObject({ mergedCount: 0, hasChange: false });
    expect(sortOrders()).toEqual(Array.from({ length: 40 }, (_, i) => [`M${String(i).padStart(2, '0')}`, i]));
  });

  it('本机已有的消息不重写内容：对端同 id 不同正文，行不变、不执行 INSERT', () => {
    merge(payload());
    const tampered = payload();
    tampered.messages[5].partsJson = JSON.stringify([{ type: 'text', value: '对端改过的正文' }]);
    const again = merge(tampered);
    expect(again.rowsWritten).toBe(0);
    expect(again.stmts.insertExecuted).toBe(0);
    expect(b.listMessages(sid).find(m => m.id === 'M05')?.parts).toEqual([{ type: 'text', value: '第 5 条' }]);
  });

  it('多条摘要与多条孤儿摘要：各自的语句只准备一次', () => {
    merge(payload());
    const marker = (id: string, anchor: string): WireCompactMarker => ({ id, sessionId: sid, summary: `摘要 ${id}`, createdAt: 500, lastCompactedMessageId: anchor, firstKeptSortOrder: 9999, compactedCount: 0, version: 2 });
    const p = payload();
    p.markers.push(marker('K1', 'M03'), marker('K2', 'M04'), marker('K3', 'M05'), marker('O1', '不存在-1'), marker('O2', '不存在-2'));
    const next = merge(p);
    expect(next.result.orphanMarkerIds.sort()).toEqual(['O1', 'O2']);
    expect(sum(counts.prepared, INSERT_MARKER)).toBe(1);
    expect(sum(counts.executed, INSERT_MARKER)).toBe(4); // 原有的一条加三条新的
    expect(sum(counts.prepared, PUT_ORPHAN)).toBe(1);
    expect(sum(counts.executed, PUT_ORPHAN)).toBe(2);
    expect(b.listCompactMarkers(sid).map(m => m.id).sort()).toHaveLength(4);
    expect(b.listOrphanMarkers(sid).map(m => m.id).sort()).toEqual(['O1', 'O2']);

    // 下一轮：两条摘要被对端改写（更晚的那份胜出），两条孤儿摘要的锚点补上了（脱孤）
    const q = payload();
    q.markers.push(
      { ...marker('K1', 'M06'), summary: '改写 K1', createdAt: 600 }, { ...marker('K2', 'M07'), summary: '改写 K2', createdAt: 600 },
      marker('K3', 'M05'), marker('O1', 'M08'), marker('O2', 'M09'),
    );
    const after = merge(q);
    expect(after.result).toMatchObject({ hasChange: true, orphanMarkerIds: [] });
    expect(sum(counts.prepared, UPDATE_MARKER)).toBe(1);
    expect(sum(counts.executed, UPDATE_MARKER)).toBe(2);
    expect(sum(counts.prepared, DROP_ORPHAN)).toBe(1);
    expect(sum(counts.executed, DROP_ORPHAN)).toBe(2);
    expect(b.listOrphanMarkers(sid)).toEqual([]);
    const byId = new Map(b.listCompactMarkers(sid).map(m => [m.id, m]));
    expect(byId.get('K1')).toMatchObject({ summary: '改写 K1', lastCompactedMessageId: 'M06' });
    expect(byId.get('K2')).toMatchObject({ summary: '改写 K2', lastCompactedMessageId: 'M07' });
    expect(byId.get('O1')).toMatchObject({ lastCompactedMessageId: 'M08' });
    expect(byId.get('O2')).toMatchObject({ lastCompactedMessageId: 'M09' });
  });
});

// Q12c：消息与摘要的 id 来自网络。形状不合规的、以及 id 在本机已经属于别的会话的消息，在合并之前就拿掉——
// 当作不在载荷里：不落库、不参与排序、不给摘要当锚点；同一个载荷里其余的照常合并。
// 头两条是 Q12 里钉「原有行为」的那两条改写来的（以前：别的会话的那一行序号被改；两个 id 落在同一行后逐条改序号）。
describe('Q12c 收包时校验 id', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 只数次数 */ }); });
  afterEach(() => { warn.mockRestore(); });

  const DENSE = Array.from({ length: 40 }, (_, i) => [`M${String(i).padStart(2, '0')}`, i]);
  const idsInDb = (): unknown[] => (dbB.prepare('SELECT id FROM messages ORDER BY rowid').all() as Array<{ id: unknown }>).map(r => r.id);
  const marker = (id: unknown, anchor: string, session = sid, summary = '摘要'): WireCompactMarker =>
    ({ id: id as string, sessionId: session, summary, createdAt: 500, lastCompactedMessageId: anchor, firstKeptSortOrder: 9999, compactedCount: 0, version: 2 });
  /** 载荷里再加一条消息：正文照抄第一条，id 和时间另给。 */
  const extra = (p: SyncPayload, id: unknown, at: number): WireMessage => ({ ...p.messages[0], id: id as string, createdAt: at, createdLocallyAt: at });
  /** 本机另一个会话里的一条消息 X1，序号 7。 */
  function otherSessionWithX1(): { other: string; rows: () => unknown[] } {
    const other = b.createSession('另一个会话').id;
    b.appendMessage({ id: 'X1', sessionId: other, role: 'user', parts: [{ type: 'text', value: '别的会话里的消息' }], createdAt: 50, streamInterruptCount: 0 });
    dbB.prepare('UPDATE messages SET sort_order=? WHERE id=?').run(7, 'X1');
    return { other, rows: () => dbB.prepare('SELECT * FROM messages WHERE session_id=?').all(other) };
  }

  it('载荷里的消息 id 在本机属于别的会话：不落库，那个会话的那一行（含序号）一个字节不变，本会话的序号不因它挪动，锚在它身上的摘要按孤儿处理', () => {
    merge(payload());
    const { rows } = otherSessionWithX1();
    const before = rows();
    const p = payload();
    // 排到 M19 与 M20 之间：它要是参与排序，后面 20 行的序号都得挪
    p.messages.push(extra(p, 'X1', 119.5));
    p.markers.push(marker('KX', 'X1'));
    const res = merge(p);
    expect(res.result).toMatchObject({ mergedCount: 0, orphanMarkerIds: ['KX'] });
    expect(res.stmts).toEqual({ insertPrepared: 0, insertExecuted: 0, movePrepared: 0, moveExecuted: 0 });
    // 写下的只有那条孤儿摘要
    expect(res.rowsWritten).toBe(1);
    expect(rows()).toEqual(before);
    expect(sortOrders()).toEqual(DENSE);
    expect(b.listCompactMarkers(sid).map(m => m.id)).not.toContain('KX');
    expect(b.listOrphanMarkers(sid).map(m => m.id)).toEqual(['KX']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('丢弃 1 条');
    // 再推一遍：一行都不写
    const again = merge(p);
    expect(again.rowsWritten).toBe(0);
    expect(again.result).toMatchObject({ mergedCount: 0, hasChange: false });
    expect(rows()).toEqual(before);
    // 警告每个会话只报一次：对端每轮对账都会把同一批再送一遍
    expect(warn).toHaveBeenCalledTimes(1);
    // 换一个会话照样报
    const third = b.createSession('第三个会话').id;
    b.mergeRemoteSession({ messages: [{ ...p.messages[0], id: 'X1', sessionId: third }], markers: [] }, third, { fromPeer: 'A' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain(third);
    expect(rows()).toEqual(before);
  });

  // 这一条只看别的会话的行，别的一概不断言：变异时用它分辨「别的会话被动到了」和「只是本会话的结果变了」
  it('载荷里的消息 id 在本机属于别的会话：那个会话的行不变（只看这一件事）', () => {
    merge(payload());
    const { rows } = otherSessionWithX1();
    const before = rows();
    const p = payload();
    p.messages.push(extra(p, 'X1', 119.5));
    merge(p);
    merge(p);
    expect(rows()).toEqual(before);
  });

  it('载荷里的 id 含落单的代理项（存进库里会与本机另一条消息落成同一行）：丢弃，消息的两条语句都不执行，本机那一行不动', () => {
    const s = b.createSession('两种写法').id;
    const add = (id: string, at: number): void => { b.appendMessage({ id, sessionId: s, role: 'user', parts: [{ type: 'text', value: id }], createdAt: at, streamInterruptCount: 0 }); };
    add('k�', 10);
    add('x', 20);
    const local = b.buildPushBatches(s)[0];
    const rows = (): unknown[] => dbB.prepare('SELECT hex(id) AS id, sort_order FROM messages WHERE session_id=? ORDER BY sort_order').all(s);
    expect(rows()).toEqual([{ id: '6BEFBFBD', sort_order: 0 }, { id: '78', sort_order: 1 }]);
    const twin = { ...local.messages[0], id: 'k\uD800', createdAt: 0, createdLocallyAt: 0 };
    const before = totalChanges();
    counts.prepared.clear(); counts.executed.clear();
    const result = b.mergeRemoteSession({ messages: [twin], markers: [], session: local.session }, s, { fromPeer: 'A' });
    expect(result).toMatchObject({ mergedCount: 0, hasChange: false });
    expect(sum(counts.executed, INSERT_MESSAGE)).toBe(0);
    expect(sum(counts.executed, MOVE_MESSAGE)).toBe(0);
    expect(totalChanges() - before).toBe(0);
    expect(rows()).toEqual([{ id: '6BEFBFBD', sort_order: 0 }, { id: '78', sort_order: 1 }]);
  });

  const BAD_IDS: Array<[string, unknown]> = [
    ['null', null], ['数字', 7], ['空串', ''], ['落单的高位代理项', 'k\uD800'], ['落单的低位代理项', '\uDC00k'], ['129 个码元', 'z'.repeat(129)],
    ['布尔值', true], ['对象', { a: 1 }], ['数组', ['x']], ['undefined', undefined],
  ];

  it.each(BAD_IDS)('消息的 id 是%s：不落库、不计入 mergedCount、不参与排序；同一载荷里合规的消息照常合并', (_what, bad) => {
    merge(payload());
    const p = payload();
    p.messages.push(extra(p, bad, 119.5), extra(p, 'NEW', 200));
    const res = merge(p);
    expect(res.result).toMatchObject({ mergedCount: 1, hasChange: true });
    expect(res.rowsWritten).toBe(1);
    expect(res.stmts).toEqual({ insertPrepared: 1, insertExecuted: 1, movePrepared: 0, moveExecuted: 0 });
    // 整张表只多出 NEW 这一行
    expect(idsInDb()).toEqual([...DENSE.map(([id]) => id), 'NEW']);
    expect(sortOrders()).toEqual([...DENSE, ['NEW', 40]]);
    expect(warn).toHaveBeenCalledTimes(1);
    const again = merge(p);
    expect(again.rowsWritten).toBe(0);
    expect(again.result).toMatchObject({ mergedCount: 0, hasChange: false });
  });

  it.each(BAD_IDS)('摘要的 id 是%s：两张摘要表都不落，重推不算有变化；同一载荷里合规的摘要照常合并', (_what, bad) => {
    merge(payload());
    const mine = a.listCompactMarkers(sid)[0].id;
    const p = payload();
    // 同一个不合规的 id 各来一条锚点找得到的和一条找不到的
    p.markers.push(marker(bad, 'M03'), marker(bad, '不存在'), marker('K1', 'M04'), marker('O1', '不存在'));
    const res = merge(p);
    expect(res.result).toMatchObject({ hasChange: true, orphanMarkerIds: ['O1'] });
    expect(res.rowsWritten).toBe(2);
    const stored = (table: string): unknown[] => (dbB.prepare(`SELECT id FROM ${table} ORDER BY rowid`).all() as Array<{ id: unknown }>).map(r => r.id);
    expect(stored('compact_markers')).toEqual([mine, 'K1']);
    expect(stored('sync_orphan_markers')).toEqual(['O1']);
    const again = merge(p);
    expect(again.rowsWritten).toBe(0);
    expect(again.result).toMatchObject({ hasChange: false, orphanMarkerIds: ['O1'] });
    expect(stored('compact_markers')).toEqual([mine, 'K1']);
  });

  it.each([
    ['孤儿摘要', '孤儿摘要', '不存在', '不存在'], ['孤儿摘要', '锚点找得到的摘要', '不存在', 'M03'],
    ['摘要', '孤儿摘要', 'T0', '不存在'], ['摘要', '锚点找得到的摘要', 'T0', 'M03'],
  ])('摘要的 id 在本机是别的会话的%s，这次作为%s送来：两张摘要表都不写，别的会话的那一行连同它的会话都不动', (_theirs, _ours, theirAnchor, ourAnchor) => {
    merge(payload());
    const other = b.createSession('另一个会话').id;
    b.appendMessage({ id: 'T0', sessionId: other, role: 'user', parts: [{ type: 'text', value: '别的会话里的消息' }], createdAt: 50, streamInterruptCount: 0 });
    b.mergeRemoteSession({ messages: [], markers: [marker('K', theirAnchor, other, '别的会话的摘要')] }, other, { fromPeer: 'A' });
    const rows = (): unknown[] => [dbB.prepare('SELECT * FROM compact_markers ORDER BY rowid').all(), dbB.prepare('SELECT * FROM sync_orphan_markers ORDER BY rowid').all()];
    const before = rows();
    expect(JSON.stringify(before)).toContain('别的会话的摘要');
    const p = payload();
    p.markers.push(marker('K', ourAnchor, sid, '想占用这个 id'));
    const res = merge(p);
    expect(res.rowsWritten).toBe(0);
    expect(res.result).toMatchObject({ hasChange: false, orphanMarkerIds: [] });
    // 摘要的两条写入语句：只为本会话原有的那一条执行过一次 INSERT OR IGNORE（被主键挡掉），没有为 K 执行
    expect(sum(counts.executed, INSERT_MARKER)).toBe(1);
    expect(sum(counts.executed, PUT_ORPHAN)).toBe(0);
    expect(rows()).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(1);
    // 本会话自己的孤儿摘要照旧能写、能改
    p.markers.push(marker('O1', '不存在'));
    expect(merge(p).rowsWritten).toBe(1);
    p.markers[p.markers.length - 1] = marker('O1', '不存在', sid, '改过的摘要');
    expect(merge(p).rowsWritten).toBe(1);
    expect(b.listOrphanMarkers(sid)).toMatchObject([{ id: 'O1', summary: '改过的摘要' }]);
    expect(JSON.stringify(rows())).toContain('别的会话的摘要');
    expect(JSON.stringify(rows())).not.toContain('想占用这个 id');
  });

  it('消息的归属只为本会话里没有的 id 查库：第一次同步每条查一次，相同内容重推一次都不查，多一条新消息只查这一条', () => {
    const OWNER_OF_MESSAGE = 'SELECT 1 FROM messages WHERE id';
    expect(merge(payload()).result.mergedCount).toBe(40);
    expect(sum(counts.prepared, OWNER_OF_MESSAGE)).toBe(1);
    expect(sum(counts.executed, OWNER_OF_MESSAGE)).toBe(40);
    merge(payload());
    expect(sum(counts.prepared, OWNER_OF_MESSAGE)).toBe(0);
    expect(sum(counts.executed, OWNER_OF_MESSAGE)).toBe(0);
    append(a, 'M40', 140, '新的一条');
    expect(merge(payload()).result.mergedCount).toBe(1);
    expect(sum(counts.executed, OWNER_OF_MESSAGE)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('形状合规的 id 不论长相都照收：各自成行、原样读回（只卡形状，不卡字符集）', () => {
    const ids = ['a\u0000b', 'a\u0000c', 'A', 'a', 'é', 'é', '�', '😀', 'x"]', 'x\\', ' ', '中文', 'z'.repeat(128), '7', '7.0', 'null',
      '11111111-2222-3333-4444-555555555555', 'ABCDEF00-1111-2222-3333-444444444444'];
    const p = payload();
    p.messages = ids.map((id, i) => extra(p, id, 300 + i));
    const res = merge(p);
    expect(res.result).toMatchObject({ mergedCount: ids.length, hasChange: true });
    expect(b.listMessages(sid).map(m => m.id)).toEqual(ids);
    expect(warn).not.toHaveBeenCalled();
    expect(merge(p).rowsWritten).toBe(0);
  });

  it('两条收包路径都过这一关：监听方的 sync.push、拨号方拉回来的 sync.pull', async () => {
    merge(payload());
    const { rows } = otherSessionWithX1();
    const before = rows();
    const hostile = (fresh: string, at: number): SyncPayload => {
      const p = payload();
      p.messages.push(extra(p, null, 119.4), extra(p, 'X1', 119.5), extra(p, 'k\uD800', 119.6), extra(p, fresh, at));
      return p;
    };
    const pushed = await createSyncMethods(b)['sync.push']!({ sessionId: sid, payload: hostile('NEW-PUSH', 200) }, { authMode: 'remote', notify: () => { /* 不看 */ } }) as { mergedCount: number };
    expect(pushed.mergedCount).toBe(1);

    const PEER = 'aabbccddeeff';
    const outbound = {
      dialedPeers: () => [PEER], peerInfo: () => ({ protocolVersion: 2, caps: {} }), start() { /* 不拨号 */ }, stop() { /* 无 */ },
      onRemoteDirty: undefined as ((peerFp: string, sessionId: string) => void) | undefined, onOnline: undefined,
      callRpc: async (_fp: string, method: string): Promise<unknown> => { if (method === 'sync.pull') return hostile('NEW-PULL', 201); throw new Error(`没想到的调用 ${method}`); },
    };
    const coord = new SyncCoordinator(b, { broadcast: () => { /* 不看 */ } } as unknown as RpcServer, { outbound: outbound as unknown as OutboundClient });
    coord.start();
    try {
      outbound.onRemoteDirty!(PEER, sid);
      await vi.waitFor(() => { expect(b.listMessages(sid).map(m => m.id)).toContain('NEW-PULL'); });
    } finally { coord.stop(); }

    expect(idsInDb()).toEqual([...DENSE.map(([id]) => id), 'X1', 'NEW-PUSH', 'NEW-PULL']);
    expect(sortOrders()).toEqual([...DENSE, ['NEW-PUSH', 40], ['NEW-PULL', 41]]);
    expect(rows()).toEqual(before);
  });
});

// Q12b：相同内容重推一行都不写。以前不带会话行的批次每批写一行（sessions.updated_at 被刷成本机当前时间），
// 没有变化的孤儿摘要每条写一行（整行重写，变的只有 received_at）。
describe('Q12b 相同内容重推不再写行', () => {
  /** 同一个库上另开一个时钟拨到很久以后的存储：看得出某个时间戳有没有被写成「本机现在」。 */
  const LATER = 5_000_000_000;
  const later = (): ChatStore => new ChatStore(dbB, 'B', { now: () => LATER * 1000 });
  const updatedAt = (): number => (dbB.prepare('SELECT updated_at FROM sessions WHERE id=?').get(sid) as { updated_at: number }).updated_at;
  const orphan = (id: string) => dbB.prepare('SELECT summary, last_compacted_message_id AS anchor, created_at AS createdAt, received_at AS receivedAt FROM sync_orphan_markers WHERE id=?').get(id) as
    { summary: string; anchor: string; createdAt: number; receivedAt: number } | undefined;
  /** 用指定的存储合并一次，返回结果和这次写了几行。 */
  function mergeWith(store: ChatStore, p: SyncPayload) {
    const before = totalChanges();
    counts.prepared.clear(); counts.executed.clear();
    const result = store.mergeRemoteSession(JSON.parse(JSON.stringify(p)) as SyncPayload, sid, { fromPeer: 'A' });
    return { result, rowsWritten: totalChanges() - before };
  }

  it('不带会话行的批次、里面的消息本机都有：写入 0 行，updated_at 不动', () => {
    merge(payload());
    const sent = updatedAt();
    const res = mergeWith(later(), { messages: payload().messages, markers: [] });
    expect(res.result).toMatchObject({ mergedCount: 0, hasChange: false });
    expect(res.rowsWritten).toBe(0);
    expect(updatedAt()).toBe(sent);
  });

  it('不带会话行的批次带来一条新消息：updated_at 照旧刷成本机当前时间', () => {
    merge(payload());
    append(a, 'M40', 140, '新的一条');
    const res = mergeWith(later(), { messages: payload().messages, markers: [] });
    expect(res.result).toMatchObject({ mergedCount: 1, hasChange: true });
    // 新消息一行，会话行一行
    expect(res.rowsWritten).toBe(2);
    expect(updatedAt()).toBe(LATER);
  });

  it('分成多批的会话原样重推：每一批都是 0 行，updated_at 不动；之后只改名，改名落到对端，对端的会话行拉回来也不会把它改回去', () => {
    const batches = (): SyncPayload[] => a.buildPushBatches(sid, 1500);
    expect(batches().length).toBeGreaterThanOrEqual(4);
    expect(batches().slice(0, -1).every(p => p.session === undefined)).toBe(true);
    for (const p of batches()) mergeWith(b, p);
    const sent = updatedAt();
    expect(batches().map(p => mergeWith(later(), p).rowsWritten)).toEqual(batches().map(() => 0));
    expect(updatedAt()).toBe(sent);

    // 改名的时刻要晚于上一次写入（时钟是毫秒级的，等它走一格）
    for (const t = Date.now(); Date.now() === t;) { /* 等 */ }
    a.updateSessionTitle(sid, '改过的标题');
    const renamedAt = a.getSession(sid)!.updatedAt;
    expect(renamedAt).toBeGreaterThan(sent);
    // 对端的时钟此刻比改名的时刻晚：以前头几批就把对端的 updated_at 刷到了改名之后，最后一批带来的新标题因此被拒
    const rows = batches().map(p => mergeWith(later(), p).rowsWritten);
    expect(rows).toEqual([...batches().slice(0, -1).map(() => 0), 1]);
    expect(b.getSession(sid)).toMatchObject({ title: '改过的标题', updatedAt: renamedAt });
    // 反方向：发起方拉对端的整会话，标题不被改回去
    a.mergeRemoteSession(b.buildPushBatches(sid, Number.MAX_SAFE_INTEGER)[0], sid, { fromPeer: 'B' });
    expect(a.getSession(sid)!.title).toBe('改过的标题');
  });

  it('没有变化的孤儿摘要再送一次：写入 0 行，那一行原样不动（received_at 也不动）', () => {
    merge(payload());
    const p = payload();
    p.markers.push({ id: 'O1', sessionId: sid, summary: '锚点不在的摘要', createdAt: 500, lastCompactedMessageId: '不存在', firstKeptSortOrder: 9999, compactedCount: 0, version: 2 });
    // 新出现的孤儿摘要照常落库并计入 hasChange
    const first = mergeWith(b, p);
    expect(first.result).toMatchObject({ hasChange: true, orphanMarkerIds: ['O1'] });
    expect(first.rowsWritten).toBe(1);
    const stored = orphan('O1')!;
    const again = mergeWith(later(), p);
    expect(again.result).toMatchObject({ mergedCount: 0, hasChange: false, orphanMarkerIds: ['O1'] });
    expect(again.rowsWritten).toBe(0);
    expect(sum(counts.executed, PUT_ORPHAN)).toBe(0);
    expect(orphan('O1')).toEqual(stored);
  });

  it.each([
    ['摘要', { summary: '改过的摘要' }, { summary: '改过的摘要', anchor: '不存在', createdAt: 500 }],
    ['锚点', { lastCompactedMessageId: '另一个不存在的' }, { summary: '锚点不在的摘要', anchor: '另一个不存在的', createdAt: 500 }],
    ['创建时间', { createdAt: 501 }, { summary: '锚点不在的摘要', anchor: '不存在', createdAt: 501 }],
  ] as const)('孤儿摘要的%s变了：那一行整行重写', (_what, change, expected) => {
    merge(payload());
    const base: WireCompactMarker = { id: 'O1', sessionId: sid, summary: '锚点不在的摘要', createdAt: 500, lastCompactedMessageId: '不存在', firstKeptSortOrder: 9999, compactedCount: 0, version: 2 };
    const p = payload();
    mergeWith(b, { ...p, markers: [...p.markers, base] });
    const res = mergeWith(later(), { ...p, markers: [...p.markers, { ...base, ...change }] });
    expect(res.rowsWritten).toBe(1);
    expect(sum(counts.executed, PUT_ORPHAN)).toBe(1);
    expect(orphan('O1')).toEqual({ ...expected, receivedAt: LATER });
    // 与以前一样：已有的孤儿摘要内容变了不算 hasChange，只有新出现的才算
    expect(res.result).toMatchObject({ hasChange: false, orphanMarkerIds: ['O1'] });
  });
});

