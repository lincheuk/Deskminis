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

/** W2b-11d：错过的任务补跑一次，不分 kind。
 *  store.ts 头部与 minisd/index.ts 调度器上方的注释原写 interval/cron 错过「从当下重算（不补跑）」「跳过重算」，与行为相反：
 *  dueJobs 只看 next_run_at 过没过点，应用没在跑时过了点的 interval/cron 任务，启动后 3 秒那次检查照样取出来补跑一次；
 *  markRun 再从当下重算下一次，所以错过几次也只补这一次。定时页页头按这个行为写（W2b-11a：「错过的任务下次启动时只补跑一次」），
 *  注释这一步按行为改正。这里钉住行为本身：以后要改成「interval/cron 错过不补」，得连同界面文案一起改。 */
describe('错过的任务：补跑一次、不逐次补（W2b-11d 注释订正所依据的行为）', () => {
  it('interval 与 cron 过了点（应用没在跑时错过好几次）：dueJobs 照样取出，与 once 一样', () => {
    const iv = store.create({ name: '每十分钟', prompt: 'p', scheduleKind: 'interval', scheduleValue: '10' });
    const cr = store.create({ name: '每小时整点', prompt: 'p', scheduleKind: 'cron', scheduleValue: '0 * * * *' });
    const on = store.create({ name: '一次性', prompt: 'p', scheduleKind: 'once', scheduleValue: FUTURE() });
    // 三小时前就该跑了：interval 错过了 18 次，cron 错过了 3 次
    const past = Date.now() / 1000 - 3 * 3600;
    for (const j of [iv, cr, on]) db.prepare('UPDATE cron_jobs SET next_run_at=? WHERE id=?').run(past, j.id);
    expect(store.dueJobs(Date.now()).map(j => j.name).sort()).toEqual(['一次性', '每十分钟', '每小时整点'].sort());
  });

  it('补跑那一次 markRun 之后，下一次从当下重算：错过的其余几次不再补', () => {
    const iv = store.create({ name: '每十分钟', prompt: 'p', scheduleKind: 'interval', scheduleValue: '10' });
    const cr = store.create({ name: '每小时整点', prompt: 'p', scheduleKind: 'cron', scheduleValue: '0 * * * *' });
    const past = Date.now() / 1000 - 3 * 3600;
    for (const j of [iv, cr]) db.prepare('UPDATE cron_jobs SET next_run_at=? WHERE id=?').run(past, j.id);
    for (const j of store.dueJobs(Date.now())) store.markRun(j.id, `S-${j.name}`);
    const now = Date.now() / 1000;
    expect(store.get(iv.id)!.nextRunAt).toBeGreaterThan(now + 9 * 60);
    expect(store.get(cr.id)!.nextRunAt).toBeGreaterThan(now);
    expect(store.dueJobs(Date.now())).toEqual([]);
  });
});
