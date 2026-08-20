import { describe, it, expect } from 'vitest';
import { computeNextRun, parseCronExpr, cronMatches, validateSchedule } from '../src/minisd/cron/schedule';

/** K1 调度纯核心（设计稿 2026-08-20-cron-design.md §2）。
 *  interval=分钟数（≥5）/ once=epoch 秒 / cron=5 段（分 时 日 月 周，本机时区）。
 *  日/周同时受限 = 任一命中即触发（Vixie cron 经典 OR 语义）。 */

const T0 = new Date(2026, 7, 20, 10, 30, 45).getTime(); // 2026-08-20 周四 10:30:45 本机时区

describe('interval / once', () => {
  it('interval：fromMs + n 分钟', () => {
    expect(computeNextRun('interval', '30', T0)).toBe(T0 + 30 * 60_000);
  });
  it('once：未来时刻返回该时刻；已过返回 null（错过补跑由调度器 tick 单独处理）', () => {
    const future = Math.floor(T0 / 1000) + 3600;
    expect(computeNextRun('once', String(future), T0)).toBe(future * 1000);
    expect(computeNextRun('once', String(Math.floor(T0 / 1000) - 60), T0)).toBeNull();
  });
});

describe('cron 表达式解析', () => {
  it('五字段各形态：*、*/n、单值、区间、逗号列表（可混区间）', () => {
    const s = parseCronExpr('0,30 8-20/2 * * 1-5');
    expect(s.minute).toEqual(new Set([0, 30]));
    expect(s.hour).toEqual(new Set([8, 10, 12, 14, 16, 18, 20]));
    expect(s.domWildcard).toBe(true);
    expect(s.dowWildcard).toBe(false);
    expect(s.dow).toEqual(new Set([1, 2, 3, 4, 5]));
  });
  it('周 7 归一为 0（两者都是周日）', () => {
    expect(parseCronExpr('* * * * 7').dow).toEqual(new Set([0]));
  });
  it('非法表达式抛错：字段数不对/越界/乱写', () => {
    expect(() => parseCronExpr('* * * *')).toThrow();
    expect(() => parseCronExpr('61 * * * *')).toThrow();
    expect(() => parseCronExpr('* 25 * * *')).toThrow();
    expect(() => parseCronExpr('a b c d e')).toThrow();
    expect(() => parseCronExpr('*/0 * * * *')).toThrow();
  });
});

describe('cron 匹配与 next 计算（本机时区）', () => {
  it('每天 09:00：从 10:30 起算 → 明天 09:00', () => {
    const next = computeNextRun('cron', '0 9 * * *', T0)!;
    const d = new Date(next);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([9, 0, 0]);
    expect(d.getDate()).toBe(21);
  });
  it('每 15 分钟：10:30:45 起算 → 10:45:00（下一整分对齐后首个命中）', () => {
    const next = computeNextRun('cron', '*/15 * * * *', T0)!;
    const d = new Date(next);
    expect([d.getHours(), d.getMinutes()]).toEqual([10, 45]);
  });
  it('日/周 OR 语义：日=1 或 周一，两者任一命中', () => {
    const spec = parseCronExpr('0 0 1 * 1');
    expect(cronMatches(spec, new Date(2026, 8, 1, 0, 0))).toBe(true);  // 9/1 是周二：日命中
    expect(cronMatches(spec, new Date(2026, 7, 24, 0, 0))).toBe(true); // 8/24 是周一：周命中
    expect(cronMatches(spec, new Date(2026, 7, 25, 0, 0))).toBe(false); // 8/25 周二非 1 号
  });
  it('跨月：8/31 之后的「每月 31 日」落到 10/31（9 月无 31）', () => {
    const from = new Date(2026, 7, 31, 12, 0).getTime();
    const d = new Date(computeNextRun('cron', '0 0 31 * *', from)!);
    expect([d.getMonth(), d.getDate()]).toEqual([9, 31]);
  });
  it('永不命中（2/30）扫描一年后返回 null 而不是死循环', () => {
    expect(computeNextRun('cron', '0 0 30 2 *', T0)).toBeNull();
  });
});

describe('validateSchedule（入库前校验，坏行不入库）', () => {
  it('interval：非数字/低于 5 分钟拒收', () => {
    expect(() => validateSchedule('interval', 'abc')).toThrow();
    expect(() => validateSchedule('interval', '3')).toThrow(/5/);
    expect(() => validateSchedule('interval', '5')).not.toThrow();
  });
  it('once：非数字拒收；过去时刻拒收（新建就该是将来的事）', () => {
    expect(() => validateSchedule('once', 'xyz')).toThrow();
    expect(() => validateSchedule('once', String(Math.floor(Date.now() / 1000) - 10))).toThrow(/已过/);
  });
  it('cron：转发解析错误；未知 kind 拒收', () => {
    expect(() => validateSchedule('cron', '* * * *')).toThrow();
    expect(() => validateSchedule('weird' as never, '1')).toThrow();
  });
});
