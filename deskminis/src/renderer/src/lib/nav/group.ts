/** T2 会话分组（新导航 NavRail 的数据整形，设计稿 2026-08-21-ui-rebuild-design.md §3）。
 *
 *  纯函数：不碰 store 不碰 DOM，"现在"由调用方传入，跨午夜的边界才测得动。
 *  分组按**自然日**而非"过去 24 小时"——用户说"今天"指的是日历上的今天，
 *  凌晨 0:30 的会话和此刻同属今天，昨晚 23:30 的属昨天。 */

export interface NavSession {
  id: string;
  title?: string;
  updatedAt?: number;   // epoch 秒
  pinnedAt?: number;    // epoch 秒；有值 = 置顶
  [k: string]: unknown; // store 里的会话还带 assistantId/modelBinding 等，原样透传
}

export interface NavGroup<T = NavSession> {
  label: string;
  items: T[];
}

/** 某个 epoch 秒所在自然日的 0 点（本地时区）。 */
function dayStart(epochSec: number): number {
  const d = new Date(epochSec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** 分组：已置顶 → 今天 → 昨天 → 最近七天 → 更早。空组不产出。 */
export function groupSessions<T extends NavSession>(sessions: readonly T[], nowSec: number): NavGroup<T>[] {
  const today0 = dayStart(nowSec);
  const yday0 = today0 - 86400;
  const week0 = today0 - 86400 * 6; // 含今天在内的七天窗

  const pinned: T[] = [];
  const buckets: Record<string, T[]> = { 今天: [], 昨天: [], 最近七天: [], 更早: [] };

  for (const s of sessions) {
    if (s.pinnedAt) { pinned.push(s); continue; }
    const t = s.updatedAt;
    if (t === undefined) { buckets['更早'].push(s); continue; }
    if (t >= today0) buckets['今天'].push(s);
    else if (t >= yday0) buckets['昨天'].push(s);
    else if (t >= week0) buckets['最近七天'].push(s);
    else buckets['更早'].push(s);
  }

  // 置顶按钉住时间新的在前；其余按最近更新在前，无时间的沉底
  pinned.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity));
  }

  const out: NavGroup<T>[] = [];
  if (pinned.length) out.push({ label: '已置顶', items: pinned });
  for (const k of ['今天', '昨天', '最近七天', '更早']) {
    if (buckets[k].length) out.push({ label: k, items: buckets[k] });
  }
  return out;
}
