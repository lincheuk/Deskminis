/**
 * F11B：会话生命周期登记的裁决（纯函数，无 I/O，不读时钟）。
 *
 * 为什么单独成文件：删除与恢复谁胜出、本机内容要不要清，是这项功能里唯一会丢数据的判断。
 * 把它们收成不碰库、不碰时间的纯函数，才能对全部排列与重复做性质测试，也才能用源码守卫钉住
 * 「裁决里不出现任何时间戳」——两台设备的时钟可以差几天，按墙钟比大小的删除要么失效要么误删。
 */
import { createHash } from 'node:crypto';
import { MAX_SEEN_IDS, type WireLifecycle, type WireSeen } from './wire';

/** 奇数 = 已删除。0（没有登记）与偶数都是存活。 */
export const isDeletedVersion = (v: number): boolean => v % 2 === 1;

type Head = { v: number; opId: string };

/** 全序：先比 v（大者胜），v 相同比 opId（字典序小者胜）。undefined 视为 { v: 0, opId: '' }。
 *  返回 >0 表示 a 胜，0 表示同一条，<0 表示 b 胜。 */
export function compareLifecycle(a: Head | undefined, b: Head | undefined): number {
  const av = a?.v ?? 0;
  const bv = b?.v ?? 0;
  if (av !== bv) return av > bv ? 1 : -1;
  const ao = a?.opId ?? '';
  const bo = b?.opId ?? '';
  if (ao === bo) return 0;
  // 同一代两条不同的动作（两台设备各自删了同一个会话）：取 opId 小的那条，任何设备、任何到达顺序都得出同一条
  return ao < bo ? 1 : -1;
}

export type LifecycleDecision =
  /** 内容照常合并；adopt = 先把本机登记换成对端的；restore = 本机原是删除态 */
  | { action: 'merge'; adopt: boolean; restore: boolean }
  /** 本机已删除且对端版本更低：整包拒收 */
  | { action: 'reject-stale-content' }
  /** 对端墓碑胜出；localDeleted = 本机已是删除态 */
  | { action: 'apply-tombstone'; localDeleted: boolean }
  | { action: 'ignore-tombstone'; reason: 'duplicate' | 'same-generation' | 'stale' };

/** 对端带来一条登记（或不带）时本机怎么办。只读 v 与 opId。 */
export function decideIncoming(local: Head | undefined, remote: WireLifecycle | undefined): LifecycleDecision {
  const cmp = compareLifecycle(remote, local);
  const localV = local?.v ?? 0;
  const localDeleted = isDeletedVersion(localV);
  if (remote !== undefined && isDeletedVersion(remote.v)) {
    if (cmp > 0) return { action: 'apply-tombstone', localDeleted };
    if (cmp === 0) return { action: 'ignore-tombstone', reason: 'duplicate' };
    if (remote.v === localV) return { action: 'ignore-tombstone', reason: 'same-generation' };
    return { action: 'ignore-tombstone', reason: 'stale' };
  }
  // 以下是内容（偶数登记或不带登记）
  if (cmp < 0 && localDeleted) return { action: 'reject-stale-content' };
  if (cmp > 0) return { action: 'merge', adopt: true, restore: localDeleted };
  return { action: 'merge', adopt: false, restore: false };
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** 消息 id 集合的摘要：按码元序升序、以 '\n' 连接、UTF-8 编码后取 sha256。与输入顺序、重复无关。 */
export function digestIds(ids: readonly string[]): string {
  return createHash('sha256').update(sortedUnique(ids).join('\n'), 'utf8').digest('hex');
}

/** 由本机消息 id 造 seen：排序、去重；个数超过 MAX_SEEN_IDS 时不带 ids。 */
export function makeSeen(ids: readonly string[]): WireSeen {
  const uniq = sortedUnique(ids);
  const seen: WireSeen = { count: uniq.length, digest: digestIds(uniq) };
  if (uniq.length <= MAX_SEEN_IDS) seen.ids = uniq;
  return seen;
}

/**
 * 本机这些消息里有多少条删除方没见过。
 *  - 本机没有消息 → 覆盖；
 *  - seen 缺失 → 不覆盖，无法判断；
 *  - seen 带 id 列表 → 按集合包含逐条判；
 *  - 只有条数与摘要（已压实或超过上限）→ 条数相等且摘要相等才算覆盖，否则无法判断。
 * 「本机条数更少」不算覆盖：分批推送会跳过超大的单条消息，别处持有的未必是前缀。
 */
export function unseenOf(localIds: readonly string[], seen: WireSeen | undefined): { covered: boolean; unseen: number | null } {
  const local = sortedUnique(localIds);
  if (local.length === 0) return { covered: true, unseen: 0 };
  if (seen === undefined) return { covered: false, unseen: null };
  if (seen.ids !== undefined) {
    const have = new Set(seen.ids);
    let unseen = 0;
    for (const id of local) if (!have.has(id)) unseen++;
    return { covered: unseen === 0, unseen };
  }
  if (local.length === seen.count && digestIds(local) === seen.digest) return { covered: true, unseen: 0 };
  return { covered: false, unseen: null };
}
