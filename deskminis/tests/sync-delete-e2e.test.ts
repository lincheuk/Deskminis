// Q07：此文件含已知受高负载影响的真实进程或计时用例；保留原断言，无自动重试。见 docs/TESTING.md。
/** F11B 端到端（一）：两个真实的 minisd，真实配对后的加密通道，真实的同步路径。
 *
 *  E1 / E2：一端删除、另一端离线后重连，删除不复活（两种拨号角色、两种会话来源）；
 *  E3 / E15：删除同时另一端离线追加了消息 → 删除方清掉，追加方保留副本；重启后状态还在；
 *  E4：另一端只改了标题 → 两端都删，不保留；
 *  E5：两端时钟差 10 天，结果与没有偏差时逐项相同；
 *  E7：显式恢复区别于旧同步；E7b：彻底删除保留副本只清此刻仍是保留副本的（与另一台设备的恢复撞在一起时不变成传播删除）；
 *  E11：收敛后再强制两轮全量对账，状态不变；E16：已删会话再发消息被拒，保留副本的属性、标注、技能覆盖也改不了，
 *  sync.ack 不动它的会话行。
 *
 *  断言落在物理行上（另开只读连接查库），等待一律是「条件成立」或「各端 digest 相等且不再变化」。 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import {
  aliveIds, auditTypes, deleteSession, digest, disposeAll, inject, msgRows, orderedDirs, pair, payloadOf, regCore, regRow, retained, rows,
  seedSession, seedText, sessionRow, settle, startNode, waitFor, waitOnline, type NodeOpts, type TestNode,
} from './sync-delete-util';

afterEach(disposeAll);

const DAY = 86_400_000;
const T = 120_000;

/** 起两台并配对。lo 的指纹小，是拨号方；hi 是监听方。 */
async function two(opts: { lo?: NodeOpts; hi?: NodeOpts } = {}): Promise<{ lo: TestNode; hi: TestNode }> {
  const [dLo, dHi] = orderedDirs(2);
  const lo = await startNode('LO', dLo, opts.lo);
  const hi = await startNode('HI', dHi, opts.hi);
  await pair(lo, hi);
  return { lo, hi };
}

const gone = (n: TestNode, sid: string): Promise<unknown> =>
  waitFor(`${n.name} 上会话不再存活`, async () => !(await aliveIds(n)).includes(sid), 40_000, 50);

/** E1 / E2 的主体：other 离线期间 deleter 删除 S，other 重连。返回 S 的旧副本供后续注入。 */
async function offlineDelete(deleter: TestNode, other: TestNode, creator: TestNode): Promise<{ sid: string; kid: string; oldCopy: Record<string, any> }> {
  const S = await seedSession(creator, 'S', 3);
  const K = await seedSession(creator, 'K', 2);
  await settle([deleter, other]);
  expect((await aliveIds(other)).sort()).toEqual([K.sid, S.sid].sort());
  const oldCopy = await payloadOf(other, S.sid);
  expect(oldCopy.messages).toHaveLength(3);

  await other.stop();
  expect(await deleteSession(deleter, S.sid)).toEqual({ ok: true });
  // 本机删除当场清内容并留下墓碑
  expect(msgRows(deleter, S.sid)).toEqual([]);
  expect(regRow(deleter, S.sid)).toMatchObject({ version: 1, origin_device_id: deleter.fp, received_from: null });
  await other.restart();
  await waitOnline(deleter, other);
  await gone(other, S.sid);
  const d = await settle([deleter, other]);

  // 不复活：删除方没有把会话收回来；离线方的副本被清掉
  expect(d.alive).toEqual([K.sid]);
  for (const n of [deleter, other]) {
    expect(msgRows(n, S.sid), `${n.name} 的消息行`).toEqual([]);
    expect(sessionRow(n, S.sid), `${n.name} 的会话行`).toBeUndefined();
  }
  expect(regCore(other, S.sid)).toEqual(regCore(deleter, S.sid));
  expect(regRow(other, S.sid)!.received_from).toBe(deleter.fp);
  // 对照会话没有被连带破坏
  expect(d.msgs[K.sid]).toEqual([...K.ids].sort());
  expect(msgRows(other, K.sid)).toEqual([...K.ids].sort());
  expect(msgRows(deleter, K.sid)).toEqual([...K.ids].sort());
  // 离线方有一条「对端删除」的审计，没有保留
  const audits = await auditTypes(other, S.sid);
  expect(audits.find(a => a.type === 'session.deleted.remote')?.payload).toMatchObject({ v: 1, by: deleter.fp, via: deleter.fp, retained: false });
  expect((await auditTypes(deleter, S.sid)).some(a => a.type === 'session.deleted')).toBe(true);
  expect(await retained(other)).toEqual([]);
  return { sid: S.sid, kid: K.sid, oldCopy };
}

/** E3 的主体：B 离线期间给 S 追加一条，A 同时删 S，B 重连。 */
/** big：追加的是两条各约 300KB 的消息，恢复时要分成多批推送（每一批都得带版本与会话行，对端才收）。 */
async function appendVsDelete(A: TestNode, B: TestNode, big = false): Promise<{ sid: string; all: string[]; extra: string; oldCopy: Record<string, any> }> {
  const S = await seedSession(A, 'S', 3);
  await settle([A, B]);
  const oldCopy = await payloadOf(B, S.sid);

  await A.stop();
  const extra = await seedText(B, S.sid, big ? 'a'.repeat(300_000) : 'B 离线时追加的');
  const more = big ? [await seedText(B, S.sid, 'b'.repeat(300_000))] : [];
  await B.stop();
  await A.restart();
  expect(await deleteSession(A, S.sid)).toEqual({ ok: true });
  await B.restart();
  await waitOnline(A, B);
  await gone(B, S.sid);
  await settle([A, B]);

  const all = [...S.ids, extra, ...more].sort();
  // A：不存活，也没有收下 B 的追加
  expect(await aliveIds(A)).not.toContain(S.sid);
  expect(msgRows(A, S.sid)).toEqual([]);
  expect(sessionRow(A, S.sid)).toBeUndefined();
  // B：从列表消失，内容原样保留，列在「已在其他设备删除」里
  expect(msgRows(B, S.sid)).toEqual(all);
  expect(sessionRow(B, S.sid)!.remote_tombstoned_at).toBeGreaterThan(0);
  const kept = await retained(B);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ id: S.sid, deletedBy: A.fp, messageCount: all.length, unseenCount: all.length - 3, annotationCount: 0 });
  expect((await auditTypes(B, S.sid)).find(a => a.type === 'session.deleted.remote')?.payload).toMatchObject({ retained: true, unseenCount: all.length - 3, by: A.fp });
  expect(regCore(B, S.sid)).toEqual(regCore(A, S.sid));
  return { sid: S.sid, all, extra, oldCopy };
}

/** E4 的主体：B 离线期间只改标题，A 删 S，B 重连。 */
async function renameVsDelete(A: TestNode, B: TestNode): Promise<void> {
  const S = await seedSession(A, 'S', 2);
  await settle([A, B]);
  await A.stop();
  expect(await B.call('chat.sessions.rename', { sessionId: S.sid, title: 'B 离线时改的标题' })).toEqual({ ok: true });
  await B.stop();
  await A.restart();
  await deleteSession(A, S.sid);
  await B.restart();
  await waitOnline(A, B);
  await gone(B, S.sid);
  await settle([A, B]);
  for (const n of [A, B]) {
    expect(await aliveIds(n)).not.toContain(S.sid);
    expect(msgRows(n, S.sid)).toEqual([]);
    expect(sessionRow(n, S.sid)).toBeUndefined();
  }
  expect((await retained(B)).map(r => r.id)).not.toContain(S.sid);
  expect(regCore(B, S.sid)).toEqual(regCore(A, S.sid));
}

/** E11：收敛之后依次重启两端，强制两轮全量对账；状态不变、没有同步广播、登记行逐列不变。 */
async function fixpoint(first: TestNode, second: TestNode): Promise<void> {
  const nodes = [first, second];
  const before = await settle(nodes);
  const regs = nodes.map(n => rows(n.dir, 'SELECT * FROM session_lifecycle ORDER BY session_id'));
  for (const n of [second, first]) {
    await n.restart();
    await waitOnline(first, second);
    expect(await settle(nodes, 45_000, 1500)).toEqual(before);
  }
  for (const n of nodes) {
    expect(n.notes('chat.event').filter(e => e?.kind === 'synced'), `${n.name} 的 synced 广播`).toEqual([]);
    expect(n.notes('chat.sessions.lifecycle'), `${n.name} 的生命周期广播`).toEqual([]);
  }
  expect(nodes.map(n => rows(n.dir, 'SELECT * FROM session_lifecycle ORDER BY session_id'))).toEqual(regs);
}

describe('E1 / E2 一端删除、另一端离线后重连：不复活', () => {
  it('E1 删除端是拨号方（会话由删除端创建）；收敛后再跑两轮对账状态不变（E11）', async () => {
    const { lo, hi } = await two();
    const { sid, oldCopy } = await offlineDelete(lo, hi, lo);
    // 旧副本再注入（等价于从没配过对的第三方带着旧副本来）：仍被拒
    expect(await inject(lo, sid, oldCopy)).toMatchObject({ rejected: 'tombstoned' });
    expect(msgRows(lo, sid)).toEqual([]);
    await fixpoint(lo, hi);
  }, T);

  it('E1 删除端是监听方（会话由删除端创建）', async () => {
    const { lo, hi } = await two();
    await offlineDelete(hi, lo, hi);
  }, T);

  it('E2 反方向：删除端不是会话的创建者，删除端是监听方', async () => {
    const { lo, hi } = await two();
    await offlineDelete(hi, lo, lo);
  }, T);

  it('E2 反方向：删除端不是会话的创建者，删除端是拨号方', async () => {
    const { lo, hi } = await two();
    await offlineDelete(lo, hi, hi);
  }, T);
});

describe('E3 / E4 删除同时另一端离线改动', () => {
  it('E3 另一端追加了消息：删除方清掉、追加方保留副本；E15 重启后状态还在；E11 两轮对账不变', async () => {
    const { lo, hi } = await two();
    const { sid, all, oldCopy } = await appendVsDelete(lo, hi);
    // E15：重启 B，保留副本还在、仍不存活
    await hi.restart();
    await waitOnline(lo, hi);
    expect(await aliveIds(hi)).not.toContain(sid);
    expect((await retained(hi)).map(r => r.id)).toEqual([sid]);
    expect(msgRows(hi, sid)).toEqual(all);
    // 重启 A，登记还在；注入旧副本仍被拒
    await lo.restart();
    await waitOnline(lo, hi);
    expect(regRow(lo, sid)!.version).toBe(1);
    expect(await inject(lo, sid, oldCopy)).toMatchObject({ rejected: 'tombstoned' });
    expect(msgRows(lo, sid)).toEqual([]);
    // 保留副本是冻结的：再发消息报错
    await expect(hi.call('chat.prompt', { sessionId: sid, text: '还能写吗', providerId: '__fake__' })).rejects.toThrow(/会话已删除/);
    expect(msgRows(hi, sid)).toEqual(all);
    await fixpoint(lo, hi);
    expect((await retained(hi)).map(r => r.id)).toEqual([sid]);
  }, T);

  it('E3 角色互换：删除方是监听方、追加方是拨号方', async () => {
    const { lo, hi } = await two();
    await appendVsDelete(hi, lo);
  }, T);

  it('E4 另一端只改了标题：两端都删，不保留', async () => {
    const { lo, hi } = await two();
    await renameVsDelete(lo, hi);
  }, T);
});

describe('E5 两端时钟差 10 天：结果与没有偏差时逐项相同', () => {
  it('B 快 10 天：A 删、B 离线重连（旧副本的时间戳都在「未来」）', async () => {
    const { lo, hi } = await two({ hi: { skewMs: 10 * DAY } });
    // 会话由时钟快的 B 创建：它的 createdAt / updatedAt / 消息时间全都比 A 的删除时刻晚 10 天
    const { sid, oldCopy } = await offlineDelete(lo, hi, hi);
    const deletedAt = regRow(lo, sid)!.origin_at as number;
    expect(deletedAt).toBeLessThan(Date.now() / 1000 + 60);
    // 上面走的是对账：墓碑先送到 B，B 的旧副本根本到不了 A 的入口闸。这里把那份时间戳全在「未来」的旧副本直接推给 A
    // （等价于不受对账顺序保护的来源：旧版对端、从没配过对的第三方）：仍被拒。
    // 按「会话的更新时间晚于删除时刻就收下」写的闸，只有这一步拦得住
    expect(oldCopy.session.updatedAt).toBeGreaterThan(deletedAt + 9 * 86_400);
    expect(await inject(lo, sid, oldCopy)).toMatchObject({ rejected: 'tombstoned' });
    expect(msgRows(lo, sid)).toEqual([]);
    expect(sessionRow(lo, sid)).toBeUndefined();
  }, T);

  it('B 快 10 天：B 离线追加 → 保留；B 离线改标题 → 清掉', async () => {
    const { lo, hi } = await two({ hi: { skewMs: 10 * DAY } });
    await appendVsDelete(lo, hi);
    await renameVsDelete(lo, hi);
  }, T);

  it('B 慢 10 天：由 B 发起删除（墓碑的时间比 A 上会话的任何时间戳都早）', async () => {
    const { lo, hi } = await two({ hi: { skewMs: -10 * DAY } });
    const { sid } = await offlineDelete(hi, lo, lo);
    // 墓碑上的墙钟确实比会话早：删除照样生效，说明裁决没有看它
    expect(regRow(lo, sid)!.origin_at).toBeLessThan(Date.now() / 1000 - 9 * 86_400);
  }, T);

  // 两条登记直接相比、而墙钟的先后与版本的先后相反：恢复（v=2）的时间比它要盖过的墓碑（v=1）早 10 天。
  // 按时间比的实现会把这次恢复当成旧的丢掉，会话在删除方回不来。
  it.each([
    ['B 慢 10 天：A 删、B 保留后恢复', -10 * DAY, 'lo'],
    ['B 快 10 天：B 删、A 保留后恢复', 10 * DAY, 'hi'],
  ] as const)('%s——恢复的登记时间比墓碑早 10 天，删除方照样接受', async (_name, skewMs, deleterIs) => {
    const { lo, hi } = await two({ hi: { skewMs } });
    const [deleter, keeper] = deleterIs === 'lo' ? [lo, hi] : [hi, lo];
    const { sid, all } = await appendVsDelete(deleter, keeper);
    const tombAt = regRow(deleter, sid)!.origin_at as number;

    expect(await keeper.call('chat.sessions.restore', { sessionId: sid, confirm: true })).toEqual({ ok: true });
    const restoreAt = regRow(keeper, sid)!.origin_at as number;
    // 前提成立：恢复的墙钟确实比墓碑早（约 10 天）
    expect(restoreAt).toBeLessThan(tombAt - 9 * 86_400);
    await waitFor('删除方上会话回来', async () => (await aliveIds(deleter)).includes(sid), 20_000, 50);
    const d = await settle([lo, hi]);
    expect(d.alive).toContain(sid);
    expect(d.msgs[sid]).toEqual(all);
    expect(msgRows(deleter, sid)).toEqual(all);
    expect(regCore(deleter, sid)).toEqual(regCore(keeper, sid));
    expect(regRow(deleter, sid)).toMatchObject({ version: 2, origin_device_id: keeper.fp, origin_at: restoreAt });
  }, T);
});

describe('E7 显式恢复区别于普通旧同步', () => {
  it('旧载荷推不回来；恢复产生更高的偶数版本，对端接受，含追加的消息；E11 两轮对账不变', async () => {
    const { lo: A, hi: B } = await two();
    const { sid, all, oldCopy } = await appendVsDelete(A, B);

    // 对照：恢复之前把不带版本的旧载荷再推一次，A 仍然没有 S
    expect(await inject(A, sid, oldCopy)).toMatchObject({ rejected: 'tombstoned', mergedCount: 0 });
    expect(await aliveIds(A)).not.toContain(sid);
    expect(msgRows(A, sid)).toEqual([]);
    // 同一个来源反复拿旧副本来：每次都拒，「旧副本被拒」的审计只记一次（拿着旧副本的旧版对端每次对账都会再推一遍）
    for (let i = 0; i < 3; i++) expect(await inject(A, sid, oldCopy)).toMatchObject({ rejected: 'tombstoned' });
    const stale = (await auditTypes(A, sid)).filter(a => a.type === 'session.stale-copy.rejected');
    const vias = stale.map(a => (a.payload?.via as string | undefined) ?? 'local');
    expect(vias.filter(v => v === 'local')).toHaveLength(1);
    expect(new Set(vias).size).toBe(vias.length);
    for (const a of stale) expect(a.payload).toMatchObject({ v: 1 });

    const changedBefore = A.notes('chat.sessions.changed').length;
    expect(await B.call('chat.sessions.restore', { sessionId: sid, confirm: true })).toEqual({ ok: true });
    await waitFor('A 上会话回来', async () => (await aliveIds(A)).includes(sid), 20_000, 50);
    const d = await settle([A, B]);
    expect(d.alive).toContain(sid);
    expect(d.msgs[sid]).toEqual(all);
    // 两端消息 id 序列逐位一致
    const seqA = ((await A.call('chat.messages.list', { sessionId: sid })) as Array<{ id: string }>).map(m => m.id);
    const seqB = ((await B.call('chat.messages.list', { sessionId: sid })) as Array<{ id: string }>).map(m => m.id);
    expect(seqA).toEqual(seqB);
    expect(seqA).toHaveLength(4);
    // 登记相同且为偶数，来源是做恢复的 B
    expect(regCore(A, sid)).toEqual(regCore(B, sid));
    expect(regRow(A, sid)).toMatchObject({ version: 2, origin_device_id: B.fp, received_from: B.fp, seen_ids_json: null });
    expect(sessionRow(B, sid)!.remote_tombstoned_at).toBeNull();
    expect(await retained(B)).toEqual([]);
    // A 的界面要重拉列表：恢复出来的会话才会出现
    expect(A.notes('chat.sessions.changed').length).toBeGreaterThan(changedBefore);
    expect(A.notes('chat.sessions.lifecycle').some(n => n.kind === 'restore-applied' && n.sessionId === sid && n.v === 2 && n.origin === 'remote')).toBe(true);
    expect((await auditTypes(B, sid)).some(a => a.type === 'session.restored')).toBe(true);
    expect((await auditTypes(A, sid)).find(a => a.type === 'session.restored.remote')?.payload).toMatchObject({ v: 2, by: B.fp, via: B.fp });
    // 恢复之后旧载荷不再被拒（本机此刻存活，按 id 并集合并），也不会把版本带回去
    expect((await inject(A, sid, oldCopy)).rejected).toBeUndefined();
    expect(regRow(A, sid)!.version).toBe(2);

    // 不是保留副本的会话不能恢复；没有 confirm 不能恢复
    await expect(A.call('chat.sessions.restore', { sessionId: sid, confirm: true })).rejects.toThrow(/没有可恢复的内容/);
    await expect(B.call('chat.sessions.restore', { sessionId: sid })).rejects.toThrow(/confirm/);
    await fixpoint(A, B);
    expect((await digest(A)).msgs[sid]).toEqual(all);
  }, T);

  it('恢复方是拨号方：对端已清的整份接收（内容超过一批，分批恢复）', async () => {
    const { lo: B, hi: A } = await two();
    const { sid, all } = await appendVsDelete(A, B, true);
    expect(all).toHaveLength(5);
    await B.call('chat.sessions.restore', { sessionId: sid, confirm: true });
    await waitFor('A 上会话回来', async () => (await aliveIds(A)).includes(sid), 20_000, 50);
    const d = await settle([A, B]);
    expect(d.msgs[sid]).toEqual(all);
    expect(msgRows(A, sid)).toEqual(all);
    expect(regCore(A, sid)).toEqual(regCore(B, sid));
  }, T);
});

describe('E7b 彻底删除保留副本与另一台设备的恢复撞在一起', () => {
  /** 两台都留着 S 的保留副本：经 A 的本机连接注入一条没见过任何消息的墓碑（相当于第三台设备的删除），A 转发给 B。 */
  async function bothRetained(): Promise<{ A: TestNode; B: TestNode; sid: string; ids: string[] }> {
    const { lo: A, hi: B } = await two();
    const S = await seedSession(A, 'S', 2);
    await settle([A, B]);
    const tomb = { messages: [], markers: [], lifecycle: { v: 1, opId: 'AAAA-THIRD-DEVICE', originDeviceId: 'aabbccddeeff', at: 1, seen: makeSeen([]) } };
    expect((await inject(A, S.sid, tomb)).tombstone).toBe('applied');
    await waitFor('两端都留着保留副本', async () => (await retained(A)).some(r => r.id === S.sid) && (await retained(B)).some(r => r.id === S.sid), 40_000, 50);
    await settle([A, B]);
    return { A, B, sid: S.sid, ids: [...S.ids].sort() };
  }

  it('恢复先到：chat.sessions.purgeRetained 被拒，两端都存活、登记都是恢复的那一条、消息一条不少（以前走通用的删除：写出 v=3 的墓碑，把刚恢复的会话在两端都清掉）', async () => {
    const { A, B, sid, ids } = await bothRetained();
    await A.call('chat.sessions.restore', { sessionId: sid, confirm: true });
    await waitFor('B 上会话被恢复', async () => (await aliveIds(B)).includes(sid), 20_000, 50);
    // B 的设备页此刻可能还列着它（保留清单没重拉）：用户按下「彻底删除」
    await expect(B.call('chat.sessions.purgeRetained', { sessionId: sid, confirm: true })).rejects.toThrow(/已不是保留副本/);

    const d = await settle([A, B]);
    expect(d.alive).toContain(sid);
    expect(d.msgs[sid]).toEqual(ids);
    for (const n of [A, B]) {
      expect(msgRows(n, sid), n.name).toEqual(ids);
      expect(regRow(n, sid), n.name).toMatchObject({ version: 2, origin_device_id: A.fp });
      expect(sessionRow(n, sid)!.remote_tombstoned_at, n.name).toBeNull();
    }
    // B 没有写出新的墓碑，也没有「彻底删除」的审计与广播
    const typesB = (await auditTypes(B, sid)).map(a => a.type);
    expect(typesB).not.toContain('session.deleted');
    expect(typesB).not.toContain('session.retained.purged');
    expect(B.notes('chat.sessions.lifecycle').filter(n => n.sessionId === sid).map(n => n.kind)).toEqual(['tombstone-applied', 'restore-applied']);
  }, T);

  it('对照顺序——彻底删除先到：清的只是本机这份（版本不变、不传播）；另一台随后恢复，会话照常回到两端', async () => {
    const { A, B, sid, ids } = await bothRetained();
    await expect(B.call('chat.sessions.purgeRetained', { sessionId: sid })).rejects.toThrow(/confirm/);
    expect(await B.call('chat.sessions.purgeRetained', { sessionId: sid, confirm: true })).toEqual({ ok: true });
    expect(msgRows(B, sid)).toEqual([]);
    expect(sessionRow(B, sid)).toBeUndefined();
    expect(regRow(B, sid)).toMatchObject({ version: 1, op_id: 'AAAA-THIRD-DEVICE' });
    expect(await retained(B)).toEqual([]);
    expect((await auditTypes(B, sid)).map(a => a.type)).toContain('session.retained.purged');
    expect(B.notes('chat.sessions.lifecycle').filter(n => n.sessionId === sid).map(n => n.kind)).toEqual(['tombstone-applied', 'purged']);
    // 已经清掉的再清一次：没有可清的
    await expect(B.call('chat.sessions.purgeRetained', { sessionId: sid, confirm: true })).rejects.toThrow(/已经清除/);
    // 不传播：A 的保留副本原样在
    await settle([A, B]);
    expect((await retained(A)).map(r => r.id)).toEqual([sid]);
    expect(msgRows(A, sid)).toEqual(ids);

    await A.call('chat.sessions.restore', { sessionId: sid, confirm: true });
    await waitFor('B 上会话回来', async () => (await aliveIds(B)).includes(sid), 20_000, 50);
    const d = await settle([A, B]);
    expect(d.alive).toContain(sid);
    expect(d.msgs[sid]).toEqual(ids);
    for (const n of [A, B]) {
      expect(msgRows(n, sid), n.name).toEqual(ids);
      expect(regRow(n, sid), n.name).toMatchObject({ version: 2, origin_device_id: A.fp });
    }
  }, T);
});

/** 在数据根里放一个技能目录：引擎启动时的孤儿回收把它登记进技能表（id 就是目录名）。要在 startNode 之前调。 */
function seedSkill(dir: string): string {
  const id = 'f11b-demo';
  mkdirSync(join(dir, 'skills', id), { recursive: true });
  writeFileSync(join(dir, 'skills', id, 'SKILL.md'), '---\nname: f11b-demo\ndescription: 演示技能\nversion: 1.0.0\n---\n# Demo\n正文。\n', 'utf8');
  return id;
}
const overrideRows = (n: TestNode, sid: string): Array<Record<string, any>> =>
  rows(n.dir, 'SELECT skill_id, is_enabled FROM session_skill_overrides WHERE session_id=?', sid);

describe('E16 已删会话再发消息', () => {
  it('chat.prompt 报错「会话已删除」，不留孤儿消息；技能覆盖也写不进去，不留孤儿覆盖行', async () => {
    const [d] = orderedDirs(1);
    const skill = seedSkill(d.dir);
    const A = await startNode('A', d);
    const S = await seedSession(A, 'S', 1);
    await deleteSession(A, S.sid);
    await expect(A.call('chat.prompt', { sessionId: S.sid, text: '你好', providerId: '__fake__' })).rejects.toThrow(/会话已删除/);
    expect(msgRows(A, S.sid)).toEqual([]);
    expect(rows(A.dir, 'SELECT COUNT(*) AS c FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)')[0].c).toBe(0);
    // 占位已放掉：没有残留的「运行中」
    expect((await A.call('chat.sessions.listRetained', {}))).toEqual([]);
    // 技能覆盖按会话归属、随会话一起清：已清除的会话再写进去，就是一行没人回收的孤儿
    await expect(A.call('skills.setEnabled', { id: skill, enabled: false, sessionId: S.sid })).rejects.toThrow(/会话已删除/);
    expect(overrideRows(A, S.sid)).toEqual([]);
    // sync.ack 对已清除的会话与对不存在的会话一样：空操作，不造会话行
    expect(await A.call('sync.ack', { sessionId: S.sid, lastMergedTs: 4242 })).toEqual({ ok: true });
    expect(sessionRow(A, S.sid)).toBeUndefined();
    // 重复删除幂等
    expect(await deleteSession(A, S.sid)).toEqual({ ok: true });
    // 对照：从未存在过的 id 不受这道闸影响（既有行为，覆盖照写）；对它调删除，覆盖行一并清掉，不为它造墓碑
    const ghost = randomUUID().toUpperCase();
    expect(await A.call('skills.setEnabled', { id: skill, enabled: false, sessionId: ghost })).toEqual({ ok: true });
    expect(overrideRows(A, ghost)).toEqual([{ skill_id: skill, is_enabled: 0 }]);
    expect(await deleteSession(A, ghost)).toEqual({ ok: true });
    expect(overrideRows(A, ghost)).toEqual([]);
    expect(regRow(A, ghost)).toBeUndefined();
    expect(rows(A.dir, 'SELECT COUNT(*) AS c FROM session_lifecycle')[0].c).toBe(1);
  }, T);

  it('保留副本是冻结的：直接调改标题、模型绑定、记忆开关、工作区、MCP 禁用名单、技能覆盖、改删标注的 RPC 都报「会话已删除」，sync.ack 是空操作，行不变；只因标注而留下的副本不会被绕开；恢复之后照常可写', async () => {
    const [d] = orderedDirs(1);
    const skill = seedSkill(d.dir);
    const A = await startNode('A', d);
    const S = await seedSession(A, '原标题', 2);
    const anno = await A.call('chat.annotations.add', { sessionId: S.sid, messageId: S.ids[0], exact: '划线', note: '原笔记' });
    // 存活时写下的技能覆盖：落成保留副本之后它得原样留着
    expect(await A.call('skills.setEnabled', { id: skill, enabled: false, sessionId: S.sid })).toEqual({ ok: true });
    expect(overrideRows(A, S.sid)).toEqual([{ skill_id: skill, is_enabled: 0 }]);
    // 删除方见过全部消息：这份副本只因那条本机标注而留下
    const tomb = { messages: [], markers: [], lifecycle: { v: 1, opId: 'AAAA-REMOTE', originDeviceId: 'aabbccddeeff', at: 1, seen: makeSeen(S.ids) } };
    expect((await inject(A, S.sid, tomb)).tombstone).toBe('applied');
    expect((await retained(A)).map(r => [r.id, r.title, r.unseenCount, r.annotationCount])).toEqual([[S.sid, '原标题', 0, 1]]);
    const row = rows(A.dir, 'SELECT * FROM sessions WHERE id=?', S.sid)[0];
    const reg = regRow(A, S.sid);

    const refused: Array<[string, unknown]> = [
      ['chat.sessions.rename', { sessionId: S.sid, title: '改过的' }],
      ['chat.sessions.setModelBinding', { sessionId: S.sid, binding: 'provider:__fake__' }],
      ['chat.sessions.setMemoryEnabled', { sessionId: S.sid, enabled: false }],
      ['chat.sessions.setMcpDisabled', { sessionId: S.sid, servers: ['srv'] }],
      ['workspace.set', { sessionId: S.sid, root: A.dir }],
      ['workspace.reset', { sessionId: S.sid }],
      ['chat.annotations.remove', { id: anno.id }],
      ['chat.annotations.update', { id: anno.id, note: '改掉' }],
      ['skills.setEnabled', { id: skill, enabled: true, sessionId: S.sid }],
    ];
    for (const [method, params] of refused) {
      await expect(A.call(method, params), method).rejects.toThrow(/会话已删除/);
    }
    // 加标注在处理器入口就被挡住（它先查会话可不可见）
    await expect(A.call('chat.annotations.add', { sessionId: S.sid, messageId: S.ids[1], exact: '再划一条' })).rejects.toThrow(/会话不存在/);
    // sync.ack 不报错（对不存在的会话它本来就是空操作，已删除的要与之分不出来），但会话行一列都不动——下面整行相等
    expect(await A.call('sync.ack', { sessionId: S.sid, lastMergedTs: 4242 })).toEqual({ ok: true });
    expect(row.last_synced_at).toBeNull();
    expect(rows(A.dir, 'SELECT * FROM sessions WHERE id=?', S.sid)[0]).toEqual(row);
    expect(regRow(A, S.sid)).toEqual(reg);
    expect(overrideRows(A, S.sid)).toEqual([{ skill_id: skill, is_enabled: 0 }]);
    expect(rows(A.dir, 'SELECT id, note FROM annotations WHERE session_id=?', S.sid)).toEqual([{ id: anno.id, note: '原笔记' }]);
    // 同一条墓碑再来一次：标注还在，副本不被释放（标注被删掉的话，这一下就把它清了）
    expect((await inject(A, S.sid, tomb)).tombstone).toBe('duplicate');
    expect(msgRows(A, S.sid)).toEqual([...S.ids].sort());
    expect((await retained(A)).map(r => [r.id, r.title, r.annotationCount])).toEqual([[S.sid, '原标题', 1]]);
    expect(A.notes('chat.sessions.lifecycle').filter(n => n.sessionId === S.sid).map(n => n.kind)).toEqual(['tombstone-applied']);

    // 恢复之后是普通的存活会话：技能覆盖与同步确认照常可写（闸看的是「已删除」，不是「有过删除登记」）
    expect(await A.call('chat.sessions.restore', { sessionId: S.sid, confirm: true })).toEqual({ ok: true });
    expect(regRow(A, S.sid)!.version).toBe(2);
    expect(await A.call('skills.setEnabled', { id: skill, enabled: true, sessionId: S.sid })).toEqual({ ok: true });
    expect(overrideRows(A, S.sid)).toEqual([{ skill_id: skill, is_enabled: 1 }]);
    expect(await A.call('sync.ack', { sessionId: S.sid, lastMergedTs: 4242 })).toEqual({ ok: true });
    expect(rows(A.dir, 'SELECT last_synced_at FROM sessions WHERE id=?', S.sid)[0].last_synced_at).toBe(4242);
  }, T);
});
