/** T2 会话分组纯模块（新导航 NavRail 的数据整形）。
 *  纯函数：不碰 store 不碰 DOM，"现在"由调用方传入——分组跨午夜的边界才测得动。 */
import { describe, it, expect } from 'vitest';
import { groupSessions } from '../src/renderer/src/lib/nav/group';

// 2026-08-21 12:00:00 UTC 当基准；用例里的时刻都相对它算
const NOW = Math.floor(Date.UTC(2026, 7, 21, 12, 0, 0) / 1000);
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
    const earlyToday = Math.floor(Date.UTC(2026, 7, 21, 0, 30, 0) / 1000);
    const lastNight = Math.floor(Date.UTC(2026, 7, 20, 23, 30, 0) / 1000);
    // 用 UTC 基准时刻构造，避免测试机时区把「自然日」判飘
    const r = groupSessions([s('early', earlyToday), s('night', lastNight)], NOW);
    const labels = r.map(g => g.label);
    expect(labels).toContain('今天');
    expect(labels).toContain('昨天');
  });
});
