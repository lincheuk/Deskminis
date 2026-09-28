/** T2 会话分组纯模块（新导航 NavRail 的数据整形）。
 *  纯函数：不碰 store 不碰 DOM，"现在"由调用方传入——分组跨午夜的边界才测得动。
 *
 *  时刻一律按**本地时间**构造（W3-tz）：实现按本地午夜切「今天 / 昨天」（group.ts 的 dayStart 用 setHours(0,0,0,0)），
 *  测试以前用 Date.UTC 构造，只在 UTC 的机器上凑巧成立——云端是 UTC 所以一直绿，UTC+8 的发版机上
 *  「昨晚 23:30 UTC」是本地次日 07:30，和「此刻」同属今天，稳定失败（0.3.0 真机验证报告 §3.6）。
 *  现在各时区结果相同；W3-tz 在 UTC、东八区、西八区、+14、−11 各跑过一遍。 */
import { describe, it, expect } from 'vitest';
import { groupSessions } from '../src/renderer/src/lib/nav/group';

// 本地时间 2026-08-21 12:00:00 当基准（正午：前后几个小时都还在同一个自然日里）；用例里的时刻都相对它算
const local = (y: number, mo: number, d: number, h: number, mi: number): number => Math.floor(new Date(y, mo, d, h, mi, 0).getTime() / 1000);
const NOW = local(2026, 7, 21, 12, 0);
const D = 86400;
const s = (id: string, updatedAt?: number, pinnedAt?: number) => ({ id, title: id, updatedAt, pinnedAt });

describe('groupSessions', () => {
  it('空表回空数组（不产出空组）', () => {
    expect(groupSessions([], NOW)).toEqual([]);
  });

  it('置顶单列一组且排最前，组内按 pinnedAt 新的在前', () => {
    const r = groupSessions([s('a', NOW - 10), s('b', NOW - 5, NOW - 100), s('c', NOW - 5, NOW - 50)], NOW);
    expect(r[0].label).toBe('已置顶');
    expect(r[0].items.map(x => x.id)).toEqual(['c', 'b']);
  });

  it('按今天/昨天/最近七天/更早切组，空组不出现', () => {
    const r = groupSessions([
      s('today', NOW - 3600),
      s('yday', NOW - D - 3600),
      s('week', NOW - D * 4),
      s('old', NOW - D * 40),
    ], NOW);
    expect(r.map(g => g.label)).toEqual(['今天', '昨天', '最近七天', '更早']);
    expect(r.map(g => g.items.length)).toEqual([1, 1, 1, 1]);
  });

  it('组内按 updatedAt 降序；缺 updatedAt 的沉到「更早」尾部', () => {
    const r = groupSessions([s('x', NOW - 7200), s('y', NOW - 60), s('nodate')], NOW);
    expect(r[0].label).toBe('今天');
    expect(r[0].items.map(i => i.id)).toEqual(['y', 'x']);
    const last = r[r.length - 1];
    expect(last.label).toBe('更早');
    expect(last.items.map(i => i.id)).toEqual(['nodate']);
  });

  it('「今天」按自然日算而非 24 小时：凌晨的会话与此刻同组，昨晚的进昨天', () => {
    // 本地的今天 00:30 与昨天 23:30：只差一小时，但隔着本地午夜
    const earlyToday = local(2026, 7, 21, 0, 30);
    const lastNight = local(2026, 7, 20, 23, 30);
    const r = groupSessions([s('early', earlyToday), s('night', lastNight)], NOW);
    expect(r.map(g => g.label)).toEqual(['今天', '昨天']);
    expect(r[0].items.map(i => i.id)).toEqual(['early']);
    expect(r[1].items.map(i => i.id)).toEqual(['night']);
  });
});
