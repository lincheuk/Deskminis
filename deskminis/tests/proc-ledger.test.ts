/**
 * F09 L 组：进程账本（store/proc-ledger.ts），真实 SQLite 文件库。
 * 钉的是：字段与 F05 的关联、启动恢复只关前代的行且不多报 job、写失败不外泄、恢复不按记录的 PID 动任何进程、
 * 迁移只加新表、行随会话删除。
 */
import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openDb, runMigrations } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { PROC_NOTE_JOB, PROC_NOTE_UNVERIFIED, ProcLedger } from '../src/minisd/store/proc-ledger';
import type { ProcOwnershipStatus } from '../src/shared/proc';

const dbs: Database.Database[] = [];
const kids: ChildProcess[] = [];
afterAll(() => { for (const d of dbs) { try { d.close(); } catch { /* 已关 */ } } for (const k of kids) { try { k.kill(); } catch { /* 已退出 */ } } });

function env(label: string) {
  const file = join(mkdtempSync(join(tmpdir(), `dm-f09-l-${label}-`)), 'minis.db');
  const db = openDb(file); dbs.push(db);
  let clock = 1000;
  const warns: string[] = [];
  const status: ProcOwnershipStatus = { state: 'active' };
  const ledger = (epoch: number, o: { isSessionDeleted?: (id: string) => boolean } = {}): ProcLedger =>
    new ProcLedger(db, { epoch, status: () => status, now: () => ++clock, warn: m => { warns.push(m); }, ...o });
  const rows = (): any[] => db.prepare('SELECT * FROM process_trees ORDER BY started_at, rowid').all();
  const run = (id: string, sessionId: string, active: 1 | null): void => {
    db.prepare(`INSERT INTO agent_runs (id, session_id, generation, epoch, state, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, sessionId, (db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE session_id=?').get(sessionId) as { n: number }).n + 1, 1, active ? 'running' : 'completed', active, 1, 1);
  };
  return { file, db, ledger, rows, run, warns };
}

describe('F09 进程账本', () => {
  it('L1 opened → protection（none 再到 job 的改写）→ stopRequested → ended 的字段；run_id / stop_run_id 取自活动 run', () => {
    const e = env('l1'); const l = e.ledger(3);
    e.run('run-old', 'S', null); e.run('run-live', 'S', 1);
    l.opened('t1', { kind: 'shell', sessionId: 'S' }, { pid: 4321 });
    expect(e.rows()[0]).toMatchObject({ id: 't1', epoch: 3, kind: 'shell', session_id: 'S', run_id: 'run-live', root_pid: 4321, protection: 'pending', ended_at: null, stop_cause: null });
    l.protection('t1', { protection: 'none', reason: 'no-marker' });
    expect(e.rows()[0]).toMatchObject({ protection: 'none', protection_reason: 'no-marker', root_pid: 4321, root_created: null });
    l.protection('t1', { protection: 'job', root: { pid: 4321, createdAt: '133500000000000000' }, preJob: true });
    expect(e.rows()[0]).toMatchObject({ protection: 'job', protection_reason: null, root_created: '133500000000000000', pre_job: 1 });
    l.stopRequested('t1', 'cancel'); l.stopRequested('t1', 'shutdown'); // 只记第一次
    expect(e.rows()[0]).toMatchObject({ stop_cause: 'cancel', stop_run_id: 'run-live' });
    l.ended('t1', { kind: 'stopped', exitCode: 1, signal: null }); l.ended('t1', { kind: 'exited', exitCode: 9, signal: null }); // 只关一次
    expect(e.rows()[0]).toMatchObject({ end_kind: 'stopped', exit_code: 1, exit_signal: null });
    expect(e.rows()[0].ended_at).toBeGreaterThan(e.rows()[0].stop_at);
    l.stopRequested('t1', 'timeout'); // 已结束的不记
    expect(e.rows()[0].stop_cause).toBe('cancel');
    // MCP：不查 run；原因不是 cancel / timeout 时不写 stop_run_id；终端不写 run_id
    l.opened('t2', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__srv__' }, { pid: 5 });
    l.protection('t2', { protection: 'job', root: { pid: 5, createdAt: '1' }, targetPid: 77 });
    l.stopRequested('t2', 'config-changed');
    l.opened('t3', { kind: 'terminal', sessionId: 'S' }, {});
    l.stopRequested('t3', 'session-deleted');
    expect(e.rows().slice(1).map(r => ({ id: r.id, run: r.run_id, owner: r.owner_ref, prefix: r.tool_prefix, target: r.target_pid, stop: r.stop_cause, stopRun: r.stop_run_id, pid: r.root_pid }))).toEqual([
      { id: 't2', run: null, owner: 'srv', prefix: 'mcp__srv__', target: 77, stop: 'config-changed', stopRun: null, pid: 5 },
      { id: 't3', run: null, owner: null, prefix: null, target: null, stop: 'session-deleted', stopRun: null, pid: null },
    ]);
    const snap = l.snapshot();
    expect(snap).toMatchObject({ epoch: 3, ownership: { state: 'active' } });
    expect(snap.trees.map(t => t.id).sort()).toEqual(['t1', 't2', 't3']);
    expect(snap.trees.find(t => t.id === 't1')).toMatchObject({ kind: 'shell', sessionId: 'S', runId: 'run-live', protection: 'job', preJob: true, root: { pid: 4321, createdAt: '133500000000000000' }, stopCause: 'cancel', stopRunId: 'run-live', endKind: 'stopped', exitCode: 1 });
    expect(e.warns).toEqual([]);
  });

  it('L2 closeOrphans：只动前代未结束的行；job → reaped=job，pending / none → unverified；有 stop_cause → stopped，否则 engine-lost；幂等', () => {
    const e = env('l2'); const old = e.ledger(1);
    old.opened('job', { kind: 'shell', sessionId: 'A' }, { pid: 1 }); old.protection('job', { protection: 'job', root: { pid: 1, createdAt: '1' } });
    old.opened('pending', { kind: 'terminal', sessionId: 'A' }, { pid: 2 });
    old.opened('none', { kind: 'mcp', ownerRef: 'x' }, { pid: 3 }); old.protection('none', { protection: 'none', reason: 'no-owner-watch' });
    old.opened('stopping', { kind: 'shell', sessionId: 'B' }, { pid: 4 }); old.protection('stopping', { protection: 'job', root: { pid: 4, createdAt: '1' } }); old.stopRequested('stopping', 'shutdown');
    old.opened('done', { kind: 'shell', sessionId: 'C' }, { pid: 5 }); old.ended('done', { kind: 'exited', exitCode: 0, signal: null });
    const cur = e.ledger(2);
    cur.opened('mine', { kind: 'shell', sessionId: 'D' }, { pid: 6 });
    const closed = cur.closeOrphans();
    expect(closed.map(t => ({ id: t.id, end: t.endKind, reaped: t.reaped, by: t.recoveredEpoch }))).toEqual([
      { id: 'job', end: 'engine-lost', reaped: 'job', by: 2 }, { id: 'pending', end: 'engine-lost', reaped: 'unverified', by: 2 },
      { id: 'none', end: 'engine-lost', reaped: 'unverified', by: 2 }, { id: 'stopping', end: 'stopped', reaped: 'job', by: 2 },
    ]);
    const byId = Object.fromEntries(e.rows().map(r => [r.id, r]));
    expect(byId.mine).toMatchObject({ ended_at: null, reaped: null, recovered_epoch: null }); // 本代的行不动
    expect(byId.done).toMatchObject({ end_kind: 'exited', reaped: null, recovered_epoch: null }); // 那一代里已结束的不动
    expect(byId.job.ended_at).not.toBeNull();
    expect(cur.closeOrphans()).toEqual([]);
    // 前代的账本对象晚到的写入碰不到已被关账的行
    old.ended('pending', { kind: 'exited', exitCode: 0, signal: null });
    expect(e.rows().find(r => r.id === 'pending')).toMatchObject({ end_kind: 'engine-lost' });
  });

  it('L3 写入失败：每个方法都不抛，只告警一次；L4 close() 之后写入是空操作', () => {
    const e = env('l3'); const l = e.ledger(1);
    l.opened('a', { kind: 'shell', sessionId: 'S' }, { pid: 1 });
    e.db.exec(`CREATE TRIGGER f09_no_ins BEFORE INSERT ON process_trees BEGIN SELECT RAISE(ABORT, '注入：写入失败'); END;
               CREATE TRIGGER f09_no_upd BEFORE UPDATE ON process_trees BEGIN SELECT RAISE(ABORT, '注入：写入失败'); END;`);
    expect(() => {
      l.opened('b', { kind: 'shell', sessionId: 'S' }, { pid: 2 });
      l.protection('a', { protection: 'job' }); l.stopRequested('a', 'cancel'); l.ended('a', { kind: 'exited', exitCode: 0, signal: null });
      e.ledger(2).closeOrphans(); l.prune();
    }).not.toThrow();
    expect(e.warns).toHaveLength(2); // 两个账本对象各告警一次
    expect(e.rows().map(r => ({ id: r.id, p: r.protection, end: r.ended_at }))).toEqual([{ id: 'a', p: 'pending', end: null }]);
    e.db.exec('DROP TRIGGER f09_no_ins; DROP TRIGGER f09_no_upd;');
    const l2 = e.ledger(1); l2.close();
    l2.opened('c', { kind: 'shell', sessionId: 'S' }, { pid: 3 }); l2.protection('a', { protection: 'job' }); l2.ended('a', { kind: 'exited', exitCode: 0, signal: null });
    expect(l2.closeOrphans()).toEqual([]);
    expect(e.rows().map(r => ({ id: r.id, p: r.protection, end: r.ended_at }))).toEqual([{ id: 'a', p: 'pending', end: null }]);
    // 库关了之后同样不抛
    const l3 = e.ledger(1); e.db.close();
    expect(() => { l3.opened('d', { kind: 'shell' }, {}); l3.ended('a', { kind: 'exited', exitCode: 0, signal: null }); l3.snapshot(); }).not.toThrow();
  });

  it('L5 PID 被复用：库里前代未结束的行记着一个活进程的 PID，恢复关账与恢复文案都不动它', async () => {
    const e = env('l5');
    const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    kids.push(alive);
    await new Promise<void>((res, rej) => { alive.once('spawn', () => res()); alive.once('error', rej); });
    const old = e.ledger(1);
    old.opened('reused', { kind: 'shell', sessionId: 'S' }, { pid: alive.pid });
    old.protection('reused', { protection: 'none', reason: 'no-marker', root: { pid: alive.pid!, createdAt: '1' } });
    const cur = e.ledger(2);
    expect(cur.orphanNote({ executionId: 'x', sessionId: 'S', name: 'shell_execute', epoch: 1 })).toBe(PROC_NOTE_UNVERIFIED);
    expect(cur.closeOrphans().map(t => t.reaped)).toEqual(['unverified']);
    expect(cur.orphanNote({ executionId: 'x', sessionId: 'S', name: 'shell_execute', epoch: 1 })).toBe(PROC_NOTE_UNVERIFIED);
    await new Promise(r => setTimeout(r, 300));
    expect(alive.exitCode).toBeNull();
    expect(alive.signalCode).toBeNull();
    expect(() => process.kill(alive.pid!, 0)).not.toThrow();
  });

  it('L6 旧库升级：用到本迁移之前的 MIGRATIONS 建库并放数据，再完整打开；旧数据不变，新表为空', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dm-f09-l-l6-')), 'minis.db');
    const before = new Database(file);
    // 按内容找这条迁移（不写死编号：别的任务也在末尾追加迁移）
    const at = MIGRATIONS.findIndex(m => m.includes('CREATE TABLE process_trees'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(MIGRATIONS.filter(m => m.includes('process_trees'))).toHaveLength(1); // 只有这一条提到这张表
    expect(MIGRATIONS[at]).not.toMatch(/ALTER\s+TABLE|DROP\s|UPDATE\s|DELETE\s|REFERENCES/i); // 只建新表与索引，不建外键
    runMigrations(before, MIGRATIONS.slice(0, at));
    expect(before.pragma('user_version', { simple: true })).toBe(at);
    expect(before.prepare(`SELECT name FROM sqlite_master WHERE name='process_trees'`).get()).toBeUndefined();
    before.prepare('INSERT INTO engine_instances (instance_id, pid, started_at, heartbeat_at) VALUES (?,?,?,?)').run('old', 1, 1, 1);
    const dump = (d: Database.Database): string => JSON.stringify(d.prepare(`SELECT name, sql FROM sqlite_master WHERE name NOT LIKE '%process_trees%' ORDER BY name`).all());
    const schema = dump(before);
    // 只跑到本迁移为止再比（之后的任务追加的迁移不归这条管）
    runMigrations(before, MIGRATIONS.slice(0, at + 1));
    expect(before.pragma('user_version', { simple: true })).toBe(at + 1);
    expect(dump(before)).toBe(schema); // 没有 ALTER 任何既有表
    before.close();
    const db = openDb(file); dbs.push(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT instance_id FROM engine_instances').all()).toEqual([{ instance_id: 'old' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM process_trees').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name='process_trees' AND type='index' AND name LIKE 'idx_%' ORDER BY name`).all().map((r: any) => r.name))
      .toEqual(['idx_process_trees_open', 'idx_process_trees_session']);
  });

  it('L7 删除会话带走该会话的行；之后迟到的写入不抛；已删除的会话不再写行；prune 不删未关账的行', () => {
    const e = env('l7'); const store = new ChatStore(e.db);
    const l = e.ledger(1, { isSessionDeleted: id => store.isDeleted(id) });
    const s = store.createSession().id; const keep = store.createSession().id;
    l.opened('sh', { kind: 'shell', sessionId: s }, { pid: 1 }); l.opened('term', { kind: 'terminal', sessionId: s }, { pid: 2 });
    l.opened('other', { kind: 'terminal', sessionId: keep }, { pid: 3 }); l.opened('mcp', { kind: 'mcp', ownerRef: 'srv' }, { pid: 4 });
    store.deleteSession(s);
    expect(e.rows().map(r => r.id)).toEqual(['other', 'mcp']);
    expect(() => { l.stopRequested('sh', 'session-deleted'); l.ended('sh', { kind: 'stopped', exitCode: 1, signal: null }); }).not.toThrow();
    l.opened('late', { kind: 'terminal', sessionId: s }, { pid: 5 }); // 已删除的会话拒写
    expect(e.rows().map(r => r.id)).toEqual(['other', 'mcp']);
    // 对着从没有会话行的 id 开过终端：删除（absent 分支）同样清掉它的行
    l.opened('ghost', { kind: 'terminal', sessionId: 'no-such-session' }, { pid: 6 });
    store.deleteSession('no-such-session');
    expect(e.rows().map(r => r.id)).toEqual(['other', 'mcp']);
    for (let i = 0; i < 5; i++) { l.opened(`done${i}`, { kind: 'mcp', ownerRef: 'srv' }, { pid: 10 + i }); l.ended(`done${i}`, { kind: 'exited', exitCode: 0, signal: null }); }
    l.prune();
    expect(e.rows()).toHaveLength(7); // 没到上限：已结束的 5 行都留着，未关账的 2 行不动
    expect(e.warns).toEqual([]);
  });

  it('恢复文案只在能唯一对到一棵树时才加：shell 取同会话最新的一棵；本代的行、别的工具、没有树 → 不加', () => {
    const e = env('note'); const old = e.ledger(1);
    old.opened('first', { kind: 'shell', sessionId: 'S' }, { pid: 1 }); old.protection('first', { protection: 'none', reason: 'no-marker' });
    old.ended('first', { kind: 'stopped', exitCode: 1, signal: null }); // 那一代里已经结束的树与这次中断无关
    old.opened('second', { kind: 'shell', sessionId: 'S' }, { pid: 2 }); old.protection('second', { protection: 'job', root: { pid: 2, createdAt: '1' } });
    old.opened('term', { kind: 'terminal', sessionId: 'S' }, { pid: 3 });
    const cur = e.ledger(2);
    const ask = (name: string, sessionId = 'S', epoch = 1): string | undefined => cur.orphanNote({ executionId: 'x', sessionId, name, epoch });
    expect(ask('shell_execute')).toBe(PROC_NOTE_JOB);
    cur.closeOrphans();
    expect(ask('shell_execute')).toBe(PROC_NOTE_JOB); // 关账前后都认
    expect(ask('shell_execute', 'other')).toBeUndefined();
    expect(ask('file_write')).toBeUndefined();
    expect(ask('shell_execute', 'S', 2)).toBeUndefined(); // 本代的行不作答
    expect(ask('mcp__srv__tool')).toBeUndefined(); // 没有执行行、没有资源声明：没有依据
    expect(PROC_NOTE_JOB).toContain('树内的进程已随引擎停止由系统结束');
    expect(PROC_NOTE_JOB).not.toContain('不会继续运行');
    expect(PROC_NOTE_UNVERIFIED).toContain('可能仍在运行');
  });
  it('保留副本的进程记录仍留在库中，快照隐藏未结束和已结束的记录；恢复后再显示', () => {
    const e = env('retained-snapshot'); const store = new ChatStore(e.db);
    const l = e.ledger(1, { isSessionDeleted: id => store.isDeleted(id) });
    const hidden = store.createSession('local-only').id; const visible = store.createSession('visible').id;
    store.appendMessage({ id: 'unseen', sessionId: hidden, role: 'user', parts: [{ type: 'text', value: 'local content' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    l.opened('hidden-live', { kind: 'terminal', sessionId: hidden }, { pid: 11 });
    l.opened('hidden-done', { kind: 'shell', sessionId: hidden }, { pid: 12 });
    l.ended('hidden-done', { kind: 'exited', exitCode: 0, signal: null });
    l.opened('visible', { kind: 'terminal', sessionId: visible }, { pid: 13 });
    l.opened('global-mcp', { kind: 'mcp', ownerRef: 'shared' }, { pid: 14 });
    expect(store.applyTombstone(hidden, { v: 1, opId: 'remote-delete', originDeviceId: 'peer', at: 1 })).toMatchObject({ retained: true });
    expect(e.rows().map(r => r.id)).toEqual(['hidden-live', 'hidden-done', 'visible', 'global-mcp']);
    expect(l.snapshot().trees.map(t => t.id)).toEqual(['visible', 'global-mcp']);
    l.opened('late', { kind: 'shell', sessionId: hidden }, { pid: 15 });
    expect(e.rows()).toHaveLength(4);
    store.restoreSession(hidden);
    expect(l.snapshot().trees.map(t => t.id)).toEqual(['hidden-live', 'visible', 'global-mcp', 'hidden-done']);
    expect(e.warns).toEqual([]);
  });

});
