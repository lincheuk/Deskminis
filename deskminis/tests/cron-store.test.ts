import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { CronStore } from '../src/minisd/cron/store';
import type Database from 'better-sqlite3';

/** K1 定时任务——存储层（设计稿 2026-08-20-cron-design.md §1/§3）。
 *  next_run_at 在 create/update 即算定（非法表达式抛错，坏行不入库）；
 *  once 跑一次即自动停用；同刻排序 rowid 兜底（Windows 15ms 教训）。 */

let db: Database.Database; let store: CronStore;
beforeEach(() => { db = openDb(':memory:'); store = new CronStore(db); });

const FUTURE = () => String(Math.floor(Date.now() / 1000) + 3600);

describe('迁移 [10] cron_jobs', () => {
  it('新库 user_version=11 且 cron_jobs 表列全', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(11);
    const cols = (db.prepare('PRAGMA table_info(cron_jobs)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'name', 'prompt', 'schedule_kind', 'schedule_value', 'assistant_id', 'workspace_root',
      'enabled', 'next_run_at', 'last_run_at', 'last_session_id', 'last_status', 'created_at', 'updated_at',
    ]));
  });
});

describe('CronStore CRUD', () => {
  it('create：interval 任务 next_run_at 即算定（约 n 分钟后）', () => {
    const j = store.create({ name: '巡检', prompt: '检查工作区', scheduleKind: 'interval', scheduleValue: '30' });
    expect(j.nextRunAt).toBeGreaterThan(Date.now() / 1000 + 29 * 60);
    expect(j.nextRunAt).toBeLessThan(Date.now() / 1000 + 31 * 60);
    expect(j.enabled).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it('create：非法调度拒收不入库（interval<5 / 坏 cron / 过去的 once）', () => {
    expect(() => store.create({ name: 'x', prompt: 'p', scheduleKind: 'interval', scheduleValue: '2' })).toThrow();
    expect(() => store.create({ name: 'x', prompt: 'p', scheduleKind: 'cron', scheduleValue: '* *' })).toThrow();
    expect(() => store.create({ name: 'x', prompt: 'p', scheduleKind: 'once', scheduleValue: '100' })).toThrow();
    expect(store.list()).toHaveLength(0);
  });

  it('入参截断：name 50 / prompt 4000；空名/空指令拒收', () => {
    const j = store.create({ name: 'n'.repeat(80), prompt: 'p'.repeat(5000), scheduleKind: 'interval', scheduleValue: '10' });
    expect(j.name).toHaveLength(50);
    expect(j.prompt).toHaveLength(4000);
    expect(() => store.create({ name: ' ', prompt: 'p', scheduleKind: 'interval', scheduleValue: '10' })).toThrow();
    expect(() => store.create({ name: 'n', prompt: '', scheduleKind: 'interval', scheduleValue: '10' })).toThrow();
  });

  it('update：改调度即重算 next；enabled=false 清 next、重开重算；未知 id 抛错', () => {
    const j = store.create({ name: 'a', prompt: 'p', scheduleKind: 'interval', scheduleValue: '10' });
    const j2 = store.update(j.id, { scheduleValue: '60' });
    expect(j2.nextRunAt).toBeGreaterThan(Date.now() / 1000 + 59 * 60);
    const j3 = store.update(j.id, { enabled: false });
    expect(j3.nextRunAt).toBeUndefined();
    const j4 = store.update(j.id, { enabled: true });
    expect(j4.nextRunAt).toBeGreaterThan(Date.now() / 1000);
    expect(() => store.update('missing', { name: 'x' })).toThrow(/任务不存在/);
  });

  it('dueJobs：只回 enabled 且到点的任务', () => {
    const a = store.create({ name: 'due', prompt: 'p', scheduleKind: 'once', scheduleValue: FUTURE() });
    store.create({ name: 'later', prompt: 'p', scheduleKind: 'interval', scheduleValue: '60' });
    // 手工把 a 的 next 拨到过去（模拟到点/错过）
    db.prepare('UPDATE cron_jobs SET next_run_at=? WHERE id=?').run(Date.now() / 1000 - 60, a.id);
    const due = store.dueJobs(Date.now());
    expect(due.map(j => j.name)).toEqual(['due']);
  });

  it('markRun：记会话与 running 态；once 自动停用清 next；interval 重算 next', () => {
    const a = store.create({ name: 'once1', prompt: 'p', scheduleKind: 'once', scheduleValue: FUTURE() });
    store.markRun(a.id, 'S1');
    const g = store.get(a.id)!;
    expect(g.lastSessionId).toBe('S1');
    expect(g.lastStatus).toBe('running');
    expect(g.enabled).toBe(false);
    expect(g.nextRunAt).toBeUndefined();

    const b = store.create({ name: 'iv', prompt: 'p', scheduleKind: 'interval', scheduleValue: '10' });
    store.markRun(b.id, 'S2');
    const gb = store.get(b.id)!;
    expect(gb.enabled).toBe(true);
    expect(gb.nextRunAt).toBeGreaterThan(Date.now() / 1000 + 9 * 60);
  });

  it('markDone 记终态；remove 删除；未知 id 各自抛错', () => {
    const a = store.create({ name: 'd', prompt: 'p', scheduleKind: 'interval', scheduleValue: '10' });
    store.markDone(a.id, 'ok');
    expect(store.get(a.id)!.lastStatus).toBe('ok');
    store.remove(a.id);
    expect(store.get(a.id)).toBeUndefined();
    expect(() => store.remove(a.id)).toThrow(/任务不存在/);
    expect(() => store.markDone('missing', 'ok')).toThrow(/任务不存在/);
  });
});
