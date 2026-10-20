/** F11B 端到端（三）：重复与乱序、第三台设备、暂停与恢复、取消配对与重新配对、墓碑压实前后。
 *
 *  E6：同一墓碑重复注入只生效一次；恢复与墓碑乱序到达，终态相同。
 *  E8：第三台设备带着旧副本只与其中一台配对——不复活，它自己的副本被清掉（墓碑会转发给没有过这个会话的设备）。
 *  E9：暂停期间删除既不发出也不生效，内容照收；恢复同步后补齐（两种拨号角色）。
 *  E10：取消配对期间的删除不传；重新配对后按登记补传，别的会话不受影响；从没配过对时的删除，首次配对后同样生效。
 *  E12：墓碑压实（GC）之后旧设备带着副本回来——不复活；副本与删除方当时完全相同才清除，否则保留。 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import {
  aliveIds, auditTypes, deleteSession, disposeAll, inject, msgRows, orderedDirs, pair, payloadOf, regCore, regRow, retained, rows,
  seedSession, seedText, sessionRow, settle, startNode, waitFor, waitOnline, type TestNode,
} from './sync-delete-util';

afterEach(disposeAll);

const T = 150_000;

async function boot(n: number): Promise<TestNode[]> {
  const dirs = orderedDirs(n);
  const out: TestNode[] = [];
  for (let i = 0; i < n; i++) out.push(await startNode(`N${i}`, dirs[i]));
  return out;
}
const gone = (n: TestNode, sid: string, timeoutMs = 40_000): Promise<unknown> =>
  waitFor(`${n.name} 上会话不再存活`, async () => !(await aliveIds(n)).includes(sid), timeoutMs, 50);
/** 在一段时间里反复确认条件一直成立（用于「没有发生」的断言）。 */
async function stays(what: string, cond: () => boolean | Promise<boolean>, ms = 1200): Promise<void> {
  const until = Date.now() + ms;
  do {
    if (!(await cond())) throw new Error(`本该一直成立：${what}`);
    await new Promise<void>(r => setTimeout(r, 60));
  } while (Date.now() < until);
}
/** 往对照会话追加一条并等它到对端：证明两端此刻连着、同步在走（暂停期间内容也照收）。 */
async function contentFlows(from: TestNode, to: TestNode, kid: string, text: string): Promise<string> {
  const id = await seedText(from, kid, text);
  await waitFor(`${from.name} 的新消息到 ${to.name}`, () => msgRows(to, kid).includes(id), 40_000, 50);
  return id;
}

describe('E6 重复与乱序（经本机连接注入）', () => {
  it('同一墓碑注入三次：只生效一次、只广播一次、登记行不变，之后没有新的 sync.dirty', async () => {
    const [A] = await boot(1);
    const S = await seedSession(A, 'S', 2);
    const tomb = { messages: [], markers: [], lifecycle: { v: 1, opId: 'AAAA-INJECTED', originDeviceId: 'aabbccddeeff', at: 1, seen: makeSeen(S.ids) } };
    const dirtyCount = (): number => A.notes('sync.dirty').filter(p => p.sessionId === S.sid).length;
    // 先等建会话引起的那一轮去抖广播发完，再开始数
    let seen = -1;
    await waitFor('建会话的 sync.dirty 发完', async () => { const n = dirtyCount(); const same = n === seen && n > 0; seen = n; if (!same) await new Promise<void>(r => setTimeout(r, 500)); return same; }, 10_000, 10);
    const dirtyBefore = dirtyCount();

    expect((await inject(A, S.sid, tomb)).tombstone).toBe('applied');
    const row = regRow(A, S.sid)!;
    await waitFor('转发用的 sync.dirty 发出', () => dirtyCount() === dirtyBefore + 1, 5_000);
    expect((await inject(A, S.sid, tomb)).tombstone).toBe('duplicate');
    expect((await inject(A, S.sid, tomb)).tombstone).toBe('duplicate');
    await stays('没有新的 sync.dirty', () => dirtyCount() === dirtyBefore + 1, 1500);

    expect(regRow(A, S.sid)).toEqual(row);
    expect(A.notes('chat.sessions.lifecycle').filter(n => n.sessionId === S.sid).map(n => n.kind)).toEqual(['tombstone-applied']);
    expect((await auditTypes(A, S.sid)).filter(a => a.type === 'session.deleted.remote')).toHaveLength(1);
    expect(msgRows(A, S.sid)).toEqual([]);
    expect(await aliveIds(A)).not.toContain(S.sid);
  }, T);

  it('恢复载荷与墓碑乱序到达：两种顺序终态都存活、登记相同', async () => {
    const [A] = await boot(1);
    const first = await seedSession(A, '先恢复后墓碑', 2);
    const second = await seedSession(A, '先墓碑后恢复', 2);
    const restoreReg = { v: 2, opId: 'REST-OP', originDeviceId: 'aabbccddeeff', at: 9 };
    const mk = async (sid: string, ids: string[]) => {
      const copy = await payloadOf(A, sid);
      return {
        tomb: { messages: [], markers: [], lifecycle: { v: 1, opId: 'DEL-OP', originDeviceId: 'aabbccddeeff', at: 5, seen: makeSeen(ids) } },
        restore: { ...copy, lifecycle: restoreReg },
      };
    };
    const p1 = await mk(first.sid, first.ids);
    const p2 = await mk(second.sid, second.ids);

    expect((await inject(A, first.sid, p1.restore)).rejected).toBeUndefined();
    expect((await inject(A, first.sid, p1.tomb)).tombstone).toBe('stale');

    expect((await inject(A, second.sid, p2.tomb)).tombstone).toBe('applied');
    expect(await aliveIds(A)).not.toContain(second.sid);
    expect(await inject(A, second.sid, p2.restore)).toMatchObject({ restored: true, sessionCreated: true });

    for (const s of [first, second]) {
      expect(await aliveIds(A)).toContain(s.sid);
      expect(msgRows(A, s.sid)).toEqual([...s.ids].sort());
      expect(regRow(A, s.sid)).toMatchObject({ version: 2, op_id: 'REST-OP' });
    }
  }, T);
});

describe('E8 第三台设备带着旧副本回来（V3、V5）', () => {
  it('C 只与 B 配对：A、B 上不复活，C 的副本（完全相同的、少一条的）被清掉', async () => {
    const [A, B, C] = await boot(3);
    await pair(A, B);
    const S = await seedSession(A, 'S', 3);
    const P = await seedSession(A, 'P', 3);
    await settle([A, B]);
    // C 从没配过对：经本机连接得到 S 的同一份副本，以及 P 少最后一条消息的副本
    const copyS = await payloadOf(B, S.sid);
    const copyP = await payloadOf(B, P.sid);
    await inject(C, S.sid, copyS);
    await inject(C, P.sid, { ...copyP, messages: copyP.messages.filter((m: { id: string }) => m.id !== P.ids[2]) });
    expect(msgRows(C, S.sid)).toHaveLength(3);
    expect(msgRows(C, P.sid)).toHaveLength(2);

    await deleteSession(A, S.sid);
    await deleteSession(A, P.sid);
    await gone(B, S.sid); await gone(B, P.sid);
    await settle([A, B]);

    await pair(C, B);
    await gone(C, S.sid); await gone(C, P.sid);
    await settle([A, B, C]);
    for (const sid of [S.sid, P.sid]) {
      for (const n of [A, B, C]) {
        expect(msgRows(n, sid), `${n.name}`).toEqual([]);
        expect(sessionRow(n, sid), `${n.name}`).toBeUndefined();
        expect(regCore(n, sid)).toEqual(regCore(A, sid));
      }
      // C 是从 B 那里得知的：墓碑会转发给别的对端，不只在删除方手里
      expect(regRow(C, sid)).toMatchObject({ origin_device_id: A.fp, received_from: B.fp });
    }
    expect(await retained(C)).toEqual([]);
  }, T);

  it('C 有本机没见过的内容：A、B 不复活，C 保留；墓碑转发到没有过这个会话的设备', async () => {
    const [A, B, C] = await boot(3);
    await pair(A, B);
    const S = await seedSession(A, 'S', 2);
    await settle([A, B]);
    await inject(C, S.sid, await payloadOf(B, S.sid));
    const own = await seedText(C, S.sid, 'C 自己追加的');
    // D 会话 C 从没有过：它的墓碑也要经 B 转发到 C
    const D = await seedSession(A, 'D', 1);
    await settle([A, B]);
    await deleteSession(A, S.sid);
    await deleteSession(A, D.sid);
    await settle([A, B]);

    await pair(C, B);
    await gone(C, S.sid);
    await settle([A, B, C]);
    expect(msgRows(A, S.sid)).toEqual([]);
    expect(msgRows(B, S.sid)).toEqual([]);
    expect(msgRows(C, S.sid)).toContain(own);
    expect((await retained(C)).map(r => [r.id, r.unseenCount])).toEqual([[S.sid, 1]]);
    expect(regCore(C, D.sid)).toEqual(regCore(A, D.sid));
    // 本机从没有过的会话的墓碑：不记审计、不广播
    expect(await auditTypes(C, D.sid)).toEqual([]);
    expect(C.notes('chat.sessions.lifecycle').filter(n => n.sessionId === D.sid)).toEqual([]);
  }, T);
});

describe('E9 暂停与恢复：墓碑平面双向静默，内容照收', () => {
  for (const role of ['删除端是拨号方', '删除端是监听方'] as const) {
    it(`${role}：本端暂停时删除不发出；对端暂停时删除不生效；恢复后都补齐`, async () => {
      const [lo, hi] = await boot(2);
      await pair(lo, hi);
      const [A, B] = role === '删除端是拨号方' ? [lo, hi] : [hi, lo];
      const S1 = await seedSession(A, 'S1', 2);
      const S2 = await seedSession(A, 'S2', 2);
      const K = await seedSession(A, 'K', 1);
      await settle([A, B]);

      // (1) A 暂停后删 S1；重启 B 强制一次对账
      expect(await A.call('control.pause')).toMatchObject({ syncPaused: true });
      await deleteSession(A, S1.sid);
      await B.restart();
      await waitOnline(A, B);
      // 暂停期间 B 往另一个会话追加的消息 A 照常收下（同时证明两端连着、对账走过）
      await contentFlows(B, A, K.sid, 'A 暂停期间 B 追加的');
      await stays('A 暂停期间 B 上的会话原样在', async () => (await aliveIds(B)).includes(S1.sid) && msgRows(B, S1.sid).length === 2 && regRow(B, S1.sid) === undefined);
      // 墓碑也不经对账漏出去：B 的本机连接看不到它
      expect(((await B.call('sync.list', {})).tombstones as unknown[]).length).toBe(0);
      expect(await A.call('control.resume')).toMatchObject({ syncPaused: false });
      await gone(B, S1.sid, 10_000);
      expect(msgRows(B, S1.sid)).toEqual([]);

      // (2) 反过来：B 暂停，A 删 S2。先不重启：这条删除当场就往 B 送（拨号方直接推墓碑；监听方广播 sync.dirty，B 来拉）。
      // 排在它后面的对照消息到了 B，说明墓碑已经进过 B 的宿主——B 暂停着，不应用
      await B.call('control.pause');
      await deleteSession(A, S2.sid);
      await contentFlows(A, B, K.sid, 'B 暂停期间 A 删除之后追加的');
      await stays('B 暂停期间当场送到的删除不生效', async () => (await aliveIds(B)).includes(S2.sid) && msgRows(B, S2.sid).length === 2 && regRow(B, S2.sid) === undefined);
      // 再重启 A 强制一次全量对账（重连即对账）。A 停着的时候 B 往对照会话追加一条：B 暂停着，这条它自己不会送出去，
      // 只有拨号方的 A 在对账里拉得到——用它证明对账确实走过，而不是只把重启前的断言再做一遍
      const regBeforeRestart = regRow(A, S2.sid);
      await A.stop();
      const whileDown = await seedText(B, K.sid, 'A 停着的时候 B 追加的');
      await A.restart();
      await waitOnline(A, B);
      // 墓碑落过库：重启之后原样在
      expect(regRow(A, S2.sid)).toEqual(regBeforeRestart);
      if (A === lo) {
        // A 是拨号方：对账第 3 步把 B 的会话拉了一遍（B 清单里存活的 S2 除外）
        await waitFor('A 的对账拉到 B 追加的消息', () => msgRows(A, K.sid).includes(whileDown), 40_000, 50);
      }
      await contentFlows(A, B, K.sid, 'B 暂停期间 A 追加的');
      await stays('B 暂停期间对端的删除不生效', async () => (await aliveIds(B)).includes(S2.sid) && msgRows(B, S2.sid).length === 2 && regRow(B, S2.sid) === undefined);
      // 暂停的拨号方重连之后只拉不推：它在暂停期间追加的那条到恢复同步才过去
      if (B === lo) expect(msgRows(A, K.sid)).not.toContain(whileDown);
      // 防复活闸不受暂停影响：A 没有被 B 的副本带回来，对账里也没有去拉它（拉了会在审计里留下「旧副本被拒」）
      expect(await aliveIds(A)).not.toContain(S2.sid);
      expect(msgRows(A, S2.sid)).toEqual([]);
      expect((await auditTypes(A, S2.sid)).map(a => a.type)).not.toContain('session.stale-copy.rejected');
      await B.call('control.resume');
      await gone(B, S2.sid, 10_000);

      const d = await settle([A, B]);
      expect(d.alive).toEqual([K.sid]);
      expect(d.msgs[K.sid]).toHaveLength(5);
      expect(d.msgs[K.sid]).toContain(whileDown);
      for (const sid of [S1.sid, S2.sid]) {
        expect(msgRows(A, sid)).toEqual([]);
        expect(msgRows(B, sid)).toEqual([]);
        expect(regCore(B, sid)).toEqual(regCore(A, sid));
      }
    }, T);
  }

  it('暂停期间保留副本也不动：覆盖它的同代墓碑被推迟（不走「本机已是删除态」的捷径落库）；恢复同步后才释放', async () => {
    const [A, B] = await boot(2);
    await pair(A, B);
    const S = await seedSession(A, 'S', 2);
    await settle([A, B]);
    // B 离线追加一条，A 删除：B 保留副本
    await A.stop();
    await seedText(B, S.sid, 'B 离线时追加的');
    await B.stop();
    await A.restart();
    await deleteSession(A, S.sid);
    await B.restart();
    await waitOnline(A, B);
    await waitFor('B 上会话进入保留列表', async () => (await retained(B)).some(r => r.id === S.sid), 40_000, 50);
    await settle([A, B]);
    const all = msgRows(B, S.sid);
    expect(all).toHaveLength(3);
    const reg = regCore(B, S.sid);

    // 另一台设备并发删了同一个会话、见过 B 的全部消息：同一代、opId 更大（落败），本该让 B 的保留副本被清掉
    const covering = { v: 1, opId: 'ZZZZ-COVERING', originDeviceId: 'devOther', at: 1, seen: makeSeen(all) };
    await B.call('control.pause');
    expect(await inject(B, S.sid, { messages: [], markers: [], lifecycle: covering })).toMatchObject({ tombstone: 'deferred' });
    expect(msgRows(B, S.sid)).toEqual(all);
    expect((await retained(B)).map(r => r.id)).toEqual([S.sid]);
    // 更新一代的墓碑（盖过本机登记）同样被推迟：登记不动、内容不动
    const newer = { v: 3, opId: 'AAAA-NEWER', originDeviceId: 'devOther', at: 1, seen: makeSeen(all) };
    expect(await inject(B, S.sid, { messages: [], markers: [], lifecycle: newer })).toMatchObject({ tombstone: 'deferred' });
    expect(regCore(B, S.sid)).toEqual(reg);
    expect(msgRows(B, S.sid)).toEqual(all);

    await B.call('control.resume');
    expect(await inject(B, S.sid, { messages: [], markers: [], lifecycle: covering })).toMatchObject({ tombstone: 'stale' });
    expect(msgRows(B, S.sid)).toEqual([]);
    expect(await retained(B)).toEqual([]);
    expect(regCore(B, S.sid)).toEqual(reg);
    expect(B.notes('chat.sessions.lifecycle').filter(n => n.sessionId === S.sid && n.kind === 'retained-released')).toHaveLength(1);
  }, T);
});

describe('E10 取消配对与重新配对', () => {
  it('解绑期间的删除不传；重新配对后按登记补传，别的会话照常双向合并', async () => {
    const [A, B] = await boot(2);
    await pair(A, B);
    const S = await seedSession(A, 'S', 2);
    const Tt = await seedSession(A, 'T', 2);
    await settle([A, B]);

    expect(await A.call('remote.unpair', { peerFingerprint: B.fp })).toEqual({ ok: true });
    await waitFor('B 看到 A 离线', async () => ((await B.call('remote.status')).devices as Array<{ online: boolean }>).every(d => !d.online), 20_000);
    await deleteSession(A, S.sid);
    const added = await seedText(B, Tt.sid, 'B 在解绑期间追加');
    await stays('解绑期间 B 上的会话原样在', async () => (await aliveIds(B)).includes(S.sid) && msgRows(B, S.sid).length === 2 && regRow(B, S.sid) === undefined);
    expect(msgRows(A, Tt.sid)).not.toContain(added);

    await pair(A, B);
    await gone(B, S.sid);
    const d = await settle([A, B]);
    expect(d.alive).toEqual([Tt.sid]);
    expect(msgRows(A, S.sid)).toEqual([]);
    expect(msgRows(B, S.sid)).toEqual([]);
    expect(sessionRow(A, S.sid)).toBeUndefined();
    expect(regCore(B, S.sid)).toEqual(regCore(A, S.sid));
    // T 的消息在两端一条不少
    const all = [...Tt.ids, added].sort();
    expect(msgRows(A, Tt.sid)).toEqual(all);
    expect(msgRows(B, Tt.sid)).toEqual(all);
  }, T);

  it('从没配过对时的删除：之后首次配对，对方设备上的同一份副本被删除；对方有新内容的保留', async () => {
    const [x, y] = await boot(2);
    const [A, B] = [y, x]; // 删除端是监听方
    const S2 = await seedSession(A, 'S2', 2);
    const S3 = await seedSession(A, 'S3', 2);
    await inject(B, S2.sid, await payloadOf(A, S2.sid));
    await inject(B, S3.sid, await payloadOf(A, S3.sid));
    const own = await seedText(B, S3.sid, 'B 自己追加的');
    await deleteSession(A, S2.sid);
    await deleteSession(A, S3.sid);
    expect((await A.call('remote.status')).devices).toEqual([]);

    await pair(A, B);
    await gone(B, S2.sid); await gone(B, S3.sid);
    await settle([A, B]);
    expect(msgRows(B, S2.sid)).toEqual([]);
    expect(sessionRow(B, S2.sid)).toBeUndefined();
    expect(msgRows(B, S3.sid)).toContain(own);
    expect((await retained(B)).map(r => r.id)).toEqual([S3.sid]);
    for (const sid of [S2.sid, S3.sid]) {
      expect(await aliveIds(A)).not.toContain(sid);
      expect(msgRows(A, sid)).toEqual([]);
      expect(regCore(B, sid)).toEqual(regCore(A, sid));
    }
  }, T);
});

describe('E12 墓碑压实（GC）之后旧设备带着副本回来（V5、B3）', () => {
  it('压实只置空 id 列表、行还在；A、B 不复活；C 的副本完全相同才清除，少一条的、条数相同但内容不同的都保留且条数未知', async () => {
    const dirs = orderedDirs(3);
    const A = await startNode('A', dirs[0]);
    const B = await startNode('B', dirs[1]);
    const C = await startNode('C', dirs[2]);
    await pair(A, B);
    const Same = await seedSession(A, '副本完全相同', 3);
    const Sub = await seedSession(A, '副本少一条', 3);
    const Diff = await seedSession(A, '条数相同内容不同', 3);
    await settle([A, B]);
    const copySame = await payloadOf(B, Same.sid);
    const copySub = await payloadOf(B, Sub.sid);
    const copyDiff = await payloadOf(B, Diff.sid);
    await inject(C, Same.sid, copySame);
    await inject(C, Sub.sid, { ...copySub, messages: copySub.messages.filter((m: { id: string }) => m.id !== Sub.ids[2]) });
    // C 手里少了删除方见过的一条、多了自己的一条：条数与删除方当时的相同（3 条），内容不同
    await inject(C, Diff.sid, { ...copyDiff, messages: copyDiff.messages.filter((m: { id: string }) => m.id !== Diff.ids[2]) });
    const cOwn = await seedText(C, Diff.sid, 'C 自己的一条');

    await deleteSession(A, Same.sid);
    await deleteSession(A, Sub.sid);
    await deleteSession(A, Diff.sid);
    await gone(B, Same.sid); await gone(B, Sub.sid); await gone(B, Diff.sid);
    await settle([A, B]);
    for (const n of [A, B]) for (const sid of [Same.sid, Sub.sid, Diff.sid]) expect(JSON.parse(regRow(n, sid)!.seen_ids_json)).toHaveLength(3);

    // 以保留时长 0 重启：启动即压实
    await A.restart({ tombstoneSeenTtlS: 0 });
    await B.restart({ tombstoneSeenTtlS: 0 });
    await waitOnline(A, B);
    for (const n of [A, B]) {
      for (const sid of [Same.sid, Sub.sid, Diff.sid]) {
        expect(regRow(n, sid), `${n.name} 的墓碑行还在`).toMatchObject({ version: 1, seen_ids_json: null, seen_count: 3 });
        expect(regRow(n, sid)!.seen_digest).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(rows(A.dir, 'SELECT COUNT(*) AS c FROM session_lifecycle')[0].c).toBe(3);

    await pair(C, B);
    await gone(C, Same.sid); await gone(C, Sub.sid); await gone(C, Diff.sid);
    await settle([A, B, C]);
    // 压实后 A、B 仍不复活
    for (const n of [A, B]) {
      for (const sid of [Same.sid, Sub.sid, Diff.sid]) {
        expect(await aliveIds(n)).not.toContain(sid);
        expect(msgRows(n, sid), `${n.name}`).toEqual([]);
        expect(sessionRow(n, sid)).toBeUndefined();
      }
    }
    // C：完全相同的副本靠条数与摘要精确清除；少一条的无法证明对方都见过，保留且写「无法确认」
    expect(msgRows(C, Same.sid)).toEqual([]);
    expect(sessionRow(C, Same.sid)).toBeUndefined();
    expect(msgRows(C, Sub.sid)).toHaveLength(2);
    // 条数相同但内容不同的：只有条数与摘要都对上才算见过，摘要对不上 → 保留（C 自己的那一条没有被悄悄清掉）
    expect(msgRows(C, Diff.sid)).toContain(cOwn);
    expect(msgRows(C, Diff.sid)).toHaveLength(3);
    const keptOnC = (await retained(C)).map(r => [r.id, r.unseenCount, r.messageCount]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    expect(keptOnC).toEqual([[Sub.sid, null, 2], [Diff.sid, null, 3]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    for (const sid of [Same.sid, Sub.sid, Diff.sid]) expect(regCore(C, sid)).toEqual(regCore(A, sid));
    // 再把旧副本直接推给 A：仍被拒
    expect(await inject(A, Sub.sid, copySub)).toMatchObject({ rejected: 'tombstoned' });
    expect(msgRows(A, Sub.sid)).toEqual([]);
  }, T);
});
