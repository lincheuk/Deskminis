/** F11B：会话生命周期登记的纯判定（设计 §3.1、§3.2、§4.4）。
 *
 *  这里钉的是「裁决只读 (v, opId) 与消息 id 集合」：
 *   - 全序、真值表、任意排列与重复之后折叠出同一条登记（V2、V3）；
 *   - 网络输入里的垃圾一律按「没有版本」处理，方向永远是保留而不是清除；
 *   - 「对方见过本机全部消息」只有集合包含才算证明，条数更少不算；
 *   - 源码守卫：裁决函数里不出现任何时间戳（B2）。 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareLifecycle, decideIncoming, digestIds, isDeletedVersion, makeSeen, unseenOf,
} from '../src/minisd/sync/lifecycle';
import {
  LIFECYCLE_MAX, MAX_SEEN_IDS, LOCAL_SYNC_CAPS, SYNC_CAP, parseLifecycleHead, parseWireLifecycle,
  type WireLifecycle,
} from '../src/minisd/sync/wire';

const DIGEST0 = 'a'.repeat(64);
const lc = (v: number, opId: string, extra: Partial<WireLifecycle> = {}): WireLifecycle =>
  ({ v, opId, originDeviceId: 'aabbccddeeff', at: 1, ...extra });

/** 固定种子的伪随机（mulberry32）：性质测试要可复现。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/** 剥掉注释再做源码守卫：注释里可以解释「为什么不读时钟」。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`);
  expect(start, `找不到函数 ${name}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe('L1 decideIncoming 真值表', () => {
  const odd1 = { v: 1, opId: 'M' };
  const even2 = { v: 2, opId: 'M' };

  it('墓碑：对端胜出 → apply-tombstone，localDeleted 反映本机是否已是删除态', () => {
    expect(decideIncoming(undefined, lc(1, 'M'))).toEqual({ action: 'apply-tombstone', localDeleted: false });
    expect(decideIncoming(even2, lc(3, 'A'))).toEqual({ action: 'apply-tombstone', localDeleted: false });
    // 同一代、对端 opId 更小：对端胜出，本机已是删除态
    expect(decideIncoming(odd1, lc(1, 'A'))).toEqual({ action: 'apply-tombstone', localDeleted: true });
    expect(decideIncoming(odd1, lc(3, 'Z'))).toEqual({ action: 'apply-tombstone', localDeleted: true });
  });

  it('墓碑：同一条 → duplicate；同一代输在 opId 上 → same-generation；更早的一代 → stale', () => {
    expect(decideIncoming(odd1, lc(1, 'M'))).toEqual({ action: 'ignore-tombstone', reason: 'duplicate' });
    expect(decideIncoming(odd1, lc(1, 'Z'))).toEqual({ action: 'ignore-tombstone', reason: 'same-generation' });
    expect(decideIncoming({ v: 3, opId: 'M' }, lc(1, 'A'))).toEqual({ action: 'ignore-tombstone', reason: 'stale' });
    // 本机已恢复（偶数、更高）：旧墓碑过期
    expect(decideIncoming(even2, lc(1, 'A'))).toEqual({ action: 'ignore-tombstone', reason: 'stale' });
  });

  it('内容：本机已删除而对端版本更低（含不带版本）→ 整包拒收', () => {
    expect(decideIncoming(odd1, undefined)).toEqual({ action: 'reject-stale-content' });
    expect(decideIncoming({ v: 3, opId: 'M' }, lc(2, 'A'))).toEqual({ action: 'reject-stale-content' });
  });

  it('内容：更高的偶数登记 → 采纳；本机原是删除态时算恢复', () => {
    expect(decideIncoming(odd1, lc(2, 'Q'))).toEqual({ action: 'merge', adopt: true, restore: true });
    expect(decideIncoming(undefined, lc(2, 'Q'))).toEqual({ action: 'merge', adopt: true, restore: false });
    expect(decideIncoming(even2, lc(4, 'Q'))).toEqual({ action: 'merge', adopt: true, restore: false });
    // 同一代偶数、对端 opId 更小：采纳但不是恢复
    expect(decideIncoming(even2, lc(2, 'A'))).toEqual({ action: 'merge', adopt: true, restore: false });
  });

  it('内容：本机存活、对端不更高 → 照常合并，不改登记', () => {
    expect(decideIncoming(undefined, undefined)).toEqual({ action: 'merge', adopt: false, restore: false });
    expect(decideIncoming(even2, undefined)).toEqual({ action: 'merge', adopt: false, restore: false });
    expect(decideIncoming(even2, lc(2, 'M'))).toEqual({ action: 'merge', adopt: false, restore: false });
    expect(decideIncoming({ v: 4, opId: 'M' }, lc(2, 'A'))).toEqual({ action: 'merge', adopt: false, restore: false });
  });

  it('时间字段不影响判定：at 取 1970 与 2100 结果相同', () => {
    for (const at of [0, 4102444800]) {
      expect(decideIncoming(odd1, lc(2, 'Q', { at }))).toEqual({ action: 'merge', adopt: true, restore: true });
      expect(decideIncoming(undefined, lc(1, 'Q', { at }))).toEqual({ action: 'apply-tombstone', localDeleted: false });
      expect(decideIncoming({ v: 3, opId: 'M' }, lc(2, 'Q', { at }))).toEqual({ action: 'reject-stale-content' });
    }
  });
});

describe('L2 compareLifecycle 是全序', () => {
  const rand = rng(20261004);
  const regs = Array.from({ length: 60 }, () => ({
    v: Math.floor(rand() * 6), opId: String.fromCharCode(65 + Math.floor(rand() * 5)) + Math.floor(rand() * 3),
  }));
  const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

  it('v 大者胜；v 相同 opId 字典序小者胜；undefined 等于 {0, ""}', () => {
    expect(compareLifecycle({ v: 3, opId: 'Z' }, { v: 1, opId: 'A' })).toBeGreaterThan(0);
    expect(compareLifecycle({ v: 1, opId: 'A' }, { v: 1, opId: 'B' })).toBeGreaterThan(0);
    expect(compareLifecycle({ v: 1, opId: 'B' }, { v: 1, opId: 'A' })).toBeLessThan(0);
    expect(compareLifecycle({ v: 1, opId: 'A' }, { v: 1, opId: 'A' })).toBe(0);
    expect(compareLifecycle(undefined, undefined)).toBe(0);
    expect(compareLifecycle({ v: 1, opId: 'A' }, undefined)).toBeGreaterThan(0);
    expect(compareLifecycle(undefined, { v: 1, opId: 'A' })).toBeLessThan(0);
  });

  it('反对称：cmp(a,b) 与 cmp(b,a) 符号相反', () => {
    for (const a of regs) for (const b of regs) {
      expect(sign(compareLifecycle(a, b))).toBe(-sign(compareLifecycle(b, a)) + 0);
    }
  });

  it('传递：a ≥ b 且 b ≥ c 则 a ≥ c', () => {
    for (const a of regs) for (const b of regs) {
      if (compareLifecycle(a, b) < 0) continue;
      for (const c of regs) {
        if (compareLifecycle(b, c) < 0) continue;
        expect(compareLifecycle(a, c)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('L3 任意排列与重复之后折叠出同一条登记', () => {
  /** 一台设备只按登记做的折叠：墓碑胜出就换成它，采纳更高的偶数登记，其余不动。 */
  function fold(events: WireLifecycle[]): { v: number; opId: string } | undefined {
    let local: { v: number; opId: string } | undefined;
    for (const e of events) {
      const d = decideIncoming(local, e);
      if (d.action === 'apply-tombstone' || (d.action === 'merge' && d.adopt)) local = { v: e.v, opId: e.opId };
    }
    return local;
  }

  it('≤6 个事件的全部排列、再掺随机重复，终态相同且等于全序最大值', () => {
    const rand = rng(7);
    for (let round = 0; round < 12; round++) {
      const n = 2 + Math.floor(rand() * 5); // 2..6
      const events = Array.from({ length: n }, (_, i) => lc(1 + Math.floor(rand() * 4), `OP-${Math.floor(rand() * 4)}-${i % 2}`));
      const max = events.reduce((m, e) => (compareLifecycle(e, m) > 0 ? e : m));
      const expected = { v: max.v, opId: max.opId };
      for (const perm of permutations(events)) {
        const withDup = [...perm];
        for (let k = 0; k < 3; k++) withDup.splice(Math.floor(rand() * (withDup.length + 1)), 0, perm[Math.floor(rand() * perm.length)]);
        expect(fold(withDup)).toEqual(expected);
      }
    }
  });
});

describe('L4 parseWireLifecycle：垃圾输入不会变成墓碑', () => {
  const good = { v: 1, opId: 'ABCDEF-01', originDeviceId: 'aabbccddeeff', at: 12.5, seen: { count: 2, digest: DIGEST0, ids: ['b', 'a'] } };

  it('合规输入：ids 排序去重后返回', () => {
    expect(parseWireLifecycle(good)).toEqual({ v: 1, opId: 'ABCDEF-01', originDeviceId: 'aabbccddeeff', at: 12.5, seen: { count: 2, digest: DIGEST0, ids: ['a', 'b'] } });
    expect(parseWireLifecycle({ v: 2, opId: 'X', originDeviceId: 'local', at: 0 })).toEqual({ v: 2, opId: 'X', originDeviceId: 'local', at: 0 });
  });

  it('不是普通对象 → undefined，不抛', () => {
    for (const raw of [undefined, null, 1, 'x', [], [good], () => good]) expect(parseWireLifecycle(raw)).toBeUndefined();
  });

  it('v 不合规（0、负数、小数、字符串、超上限、NaN）→ undefined', () => {
    for (const v of [0, -1, 1.5, '1', LIFECYCLE_MAX + 1, NaN, Infinity, null, true]) {
      expect(parseWireLifecycle({ ...good, v })).toBeUndefined();
    }
    expect(parseWireLifecycle({ ...good, v: LIFECYCLE_MAX })?.v).toBe(LIFECYCLE_MAX);
  });

  it('opId、originDeviceId、at 不合规 → undefined', () => {
    for (const opId of ['', 'a'.repeat(65), 'has space', 'a/b', 7, null]) expect(parseWireLifecycle({ ...good, opId })).toBeUndefined();
    for (const originDeviceId of ['__proto__', '', '-lead', 'a'.repeat(65), 'a b', 7]) expect(parseWireLifecycle({ ...good, originDeviceId })).toBeUndefined();
    for (const at of [NaN, Infinity, '1', null, undefined]) expect(parseWireLifecycle({ ...good, at })).toBeUndefined();
  });

  it('seen 不合规 → 整个 seen 丢弃（接收端只会更保守）', () => {
    for (const seen of [['a'], 'x', 7, null, { count: -1, digest: DIGEST0 }, { count: 1.5, digest: DIGEST0 }, { count: 1, digest: 'ABC' }, { count: 1, digest: DIGEST0.toUpperCase() }, { count: '1', digest: DIGEST0 }]) {
      const r = parseWireLifecycle({ ...good, seen });
      expect(r, JSON.stringify(seen)).toBeDefined();
      expect(r!.seen, JSON.stringify(seen)).toBeUndefined();
    }
  });

  it('ids 不合规 → 只丢 ids，条数与摘要留着', () => {
    const tooMany = Array.from({ length: MAX_SEEN_IDS + 1 }, (_, i) => `id-${i}`);
    const cases: Array<{ count: number; ids: unknown }> = [
      { count: 3, ids: ['a', 'b'] },            // 个数与 count 不符
      { count: 2, ids: ['a', 'a'] },            // 去重后不符
      { count: 2, ids: ['a', 7] },              // 不是字符串
      { count: 2, ids: ['a', ''] },             // 空串
      { count: 2, ids: ['a', 'x'.repeat(129)] }, // 超长
      { count: 2, ids: 'ab' },                  // 不是数组
      { count: tooMany.length, ids: tooMany },  // 超过上限
    ];
    for (const c of cases) {
      const r = parseWireLifecycle({ ...good, seen: { count: c.count, digest: DIGEST0, ids: c.ids } });
      expect(r!.seen).toEqual({ count: c.count, digest: DIGEST0 });
    }
  });

  it('偶数版本不读 seen', () => {
    expect(parseWireLifecycle({ ...good, v: 2 })).toEqual({ v: 2, opId: 'ABCDEF-01', originDeviceId: 'aabbccddeeff', at: 12.5 });
  });

  it('parseLifecycleHead：只认 v 与 opId，规则相同', () => {
    expect(parseLifecycleHead({ id: 'S', v: 3, opId: 'K', junk: 1 })).toEqual({ v: 3, opId: 'K' });
    for (const raw of [undefined, null, [], { v: 0, opId: 'K' }, { v: 1 }, { v: 1, opId: '' }, { v: '1', opId: 'K' }]) expect(parseLifecycleHead(raw)).toBeUndefined();
  });

  it('能力位：本端声明 tombstones', () => {
    expect(SYNC_CAP.TOMBSTONES).toBe('tombstones');
    expect(LOCAL_SYNC_CAPS[SYNC_CAP.TOMBSTONES]).toBe(true);
  });
});

describe('L5 unseenOf：只有集合包含才算「对方见过」', () => {
  const seenFull = makeSeen(['m1', 'm2', 'm3']);

  it('本机是 seen 的子集 → 覆盖', () => {
    expect(unseenOf(['m1', 'm3'], seenFull)).toEqual({ covered: true, unseen: 0 });
    expect(unseenOf(['m1', 'm2', 'm3'], seenFull)).toEqual({ covered: true, unseen: 0 });
  });

  it('本机多出 seen 之外的 id → 不覆盖，给出准确条数', () => {
    expect(unseenOf(['m1', 'm4'], seenFull)).toEqual({ covered: false, unseen: 1 });
    expect(unseenOf(['x', 'y', 'm2'], seenFull)).toEqual({ covered: false, unseen: 2 });
  });

  it('本机没有消息 → 覆盖；seen 缺失 → 不覆盖且无法判断', () => {
    expect(unseenOf([], undefined)).toEqual({ covered: true, unseen: 0 });
    expect(unseenOf([], seenFull)).toEqual({ covered: true, unseen: 0 });
    expect(unseenOf(['m1'], undefined)).toEqual({ covered: false, unseen: null });
  });

  it('只有条数与摘要（已压实）：完全相同才覆盖；本机是真子集 → 不覆盖且无法判断', () => {
    const compacted = { count: seenFull.count, digest: seenFull.digest };
    expect(unseenOf(['m3', 'm1', 'm2'], compacted)).toEqual({ covered: true, unseen: 0 });
    // 「本机条数更少就算都见过」不是证明
    expect(unseenOf(['m1', 'm2'], compacted)).toEqual({ covered: false, unseen: null });
    // 条数相同、内容不同
    expect(unseenOf(['m1', 'm2', 'mX'], compacted)).toEqual({ covered: false, unseen: null });
  });
});

describe('L6 digestIds 与 makeSeen', () => {
  it('摘要与输入顺序、重复无关，等于「升序、\\n 连接、UTF-8」的 sha256', () => {
    const ids = ['B', 'a', 'A', '10', '9'];
    const expected = createHash('sha256').update(['10', '9', 'A', 'B', 'a'].join('\n'), 'utf8').digest('hex');
    expect(digestIds(ids)).toBe(expected);
    expect(digestIds([...ids].reverse())).toBe(expected);
    expect(digestIds([...ids, 'a', '9'])).toBe(expected);
    // 写死的期望值：排序若依赖平台或 SQL 的排序规则，这个值会变
    expect(digestIds(['m2', 'm1'])).toBe('b82a5b7a3e0f601f81efe9e950affdb47c5e2379fd736be291bcee83a9f6a2ff');
    expect(digestIds([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('makeSeen：排序去重；超过上限不带 ids，条数与摘要照带', () => {
    expect(makeSeen(['b', 'a', 'b'])).toEqual({ count: 2, digest: digestIds(['a', 'b']), ids: ['a', 'b'] });
    const many = Array.from({ length: MAX_SEEN_IDS + 1 }, (_, i) => `id-${i}`);
    const s = makeSeen(many);
    expect(s.count).toBe(MAX_SEEN_IDS + 1);
    expect(s.ids).toBeUndefined();
    expect(s.digest).toBe(digestIds(many));
    expect(makeSeen(many.slice(0, MAX_SEEN_IDS)).ids).toHaveLength(MAX_SEEN_IDS);
  });

  it('isDeletedVersion：奇数即删除', () => {
    expect([0, 1, 2, 3, 4].map(isDeletedVersion)).toEqual([false, true, false, true, false]);
  });
});

describe('L7 源码守卫：裁决不读时钟', () => {
  const src = stripComments(readFileSync(join(__dirname, '../src/minisd/sync/lifecycle.ts'), 'utf8'));

  it('lifecycle.ts 整个文件不含 Date.now 与 nowEpoch', () => {
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/nowEpoch/);
    expect(src).not.toMatch(/new Date\b/);
  });

  it('decideIncoming 与 compareLifecycle 的函数体不含任何时间字段', () => {
    for (const name of ['decideIncoming', 'compareLifecycle']) {
      const body = functionBody(src, name);
      expect(body.length).toBeGreaterThan(40);
      for (const word of ['at', 'recordedAt', 'updatedAt', 'createdAt']) {
        expect(body, `${name} 里出现了 ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`));
      }
    }
  });
});
