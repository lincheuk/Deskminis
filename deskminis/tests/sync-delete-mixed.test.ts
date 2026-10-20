/** F11B 新旧版本混连（设计 §4.8）：新版 A（真实的 minisd）与旧版 O（9d0a32d 同步代码的逐字快照，不声明任何能力位）。
 *
 *  可解释的边界：删除传不到旧版（它留着自己的副本），旧版也推不回来；旧版自己删掉的会话会被新版推回去；
 *  其它会话的消息同步照常，不被连带破坏。
 *  M1：A 拨 O。M2：O 拨 A。M3：旧版物理删除。M4：A 上恢复过的会话，旧版往里追加照常合并。 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import { startLegacyPeer, type LegacyPeer } from './legacy-sync-peer';
import {
  aliveIds, deleteSession, disposeAll, inject, msgRows, orderedDirs, pair, regRow, seedSession, seedText, sessionRow, startNode, waitFor, waitOnline,
  type TestNode,
} from './sync-delete-util';

const legacies: LegacyPeer[] = [];
afterEach(async () => {
  for (const o of legacies.splice(0)) { try { await o.stop(); } catch { /* 收尾尽力 */ } }
  await disposeAll();
});

const T = 120_000;
const asNode = (o: LegacyPeer): TestNode => o as unknown as TestNode;

/** dialer='A'：新版 A 拨旧版 O；dialer='O' 反过来。 */
async function mixed(dialer: 'A' | 'O'): Promise<{ A: TestNode; O: LegacyPeer }> {
  const [lo, hi] = orderedDirs(2);
  const A = await startNode('A', dialer === 'A' ? lo : hi);
  const O = await startLegacyPeer('O', dialer === 'A' ? hi : lo);
  legacies.push(O);
  await pair(A, asNode(O));
  return { A, O };
}
const onO = (O: LegacyPeer, what: string, cond: () => boolean): Promise<unknown> => waitFor(`旧版 O：${what}`, cond, 40_000, 50);
const stays = async (what: string, cond: () => boolean | Promise<boolean>, ms = 1200): Promise<void> => {
  const until = Date.now() + ms;
  do {
    if (!(await cond())) throw new Error(`本该一直成立：${what}`);
    await new Promise<void>(r => setTimeout(r, 60));
  } while (Date.now() < until);
};
/** 等旧版一侧的收发都停下来（建会话引起的回声推拉走完），之后再记起点。 */
async function quiet(O: LegacyPeer, ms = 600): Promise<void> {
  let last = -1; let since = Date.now();
  await waitFor('旧版一侧安静下来', () => {
    const n = O.requests.length + O.outCalls.length;
    if (n !== last) { last = n; since = Date.now(); return false; }
    return Date.now() - since >= ms;
  }, 20_000, 40);
}
const isTombstonePush = (r: { method: string; params: any }): boolean =>
  r.method === 'sync.push' && (r.params?.payload?.lifecycle !== undefined && r.params.payload.lifecycle.v % 2 === 1);

describe('M1 新版拨旧版', () => {
  it('不向旧版发墓碑；旧版留着副本；旧版的 sync.dirty 与重启对账都带不回来；其它会话照常', async () => {
    const { A, O } = await mixed('A');
    // 握手里旧版没有声明任何能力位
    const S = await seedSession(A, 'S', 2);
    const K = await seedSession(A, 'K', 2);
    await onO(O, '收到 S 与 K', () => O.messageIds(S.sid).length === 2 && O.messageIds(K.sid).length === 2);

    await quiet(O);
    const mark = O.requests.length;
    await deleteSession(A, S.sid);
    // 闸：删除之后 A 往 K 追加的消息到了 O（同一轮去抖里，S 的脏标记排在前面）
    const k3 = await seedText(A, K.sid, 'A 在删除之后追加');
    await onO(O, '收到 K 的新消息', () => O.messageIds(K.sid).includes(k3));

    // O 记录到的全部请求里没有墓碑，也没有针对 S 的任何推送
    expect(O.requests.filter(isTombstonePush)).toEqual([]);
    expect(O.requests.some(r => r.method === 'sync.push' && r.params?.payload?.lifecycle !== undefined)).toBe(false);
    expect(O.requests.slice(mark).filter(r => r.params?.sessionId === S.sid)).toEqual([]);
    // 旧版设备上的副本保留，消息完好
    expect(O.sessionIds()).toContain(S.sid);
    expect(O.messageIds(S.sid)).toEqual([...S.ids].sort());

    // 旧版往 S 里追加并广播 sync.dirty：A 不去拉
    const o1 = O.append(S.sid, '旧版在已删会话里追加');
    const k4 = O.append(K.sid, '旧版在对照会话里追加');
    await waitFor('旧版对照会话的新消息到 A', () => msgRows(A, K.sid).includes(k4), 40_000, 50);
    expect(await aliveIds(A)).not.toContain(S.sid);
    expect(msgRows(A, S.sid)).toEqual([]);
    expect(O.requests.slice(mark).filter(r => r.method === 'sync.pull' && r.params?.sessionId === S.sid)).toEqual([]);

    // A 重启，强制一轮全量对账：仍不拉 S，也不被带回来
    const mark2 = O.requests.length;
    await A.restart();
    await waitOnline(A, asNode(O));
    const k5 = await seedText(A, K.sid, 'A 重启之后追加');
    await onO(O, '收到重启后的新消息', () => O.messageIds(K.sid).includes(k5));
    await stays('A 上没有 S', async () => !(await aliveIds(A)).includes(S.sid) && msgRows(A, S.sid).length === 0 && sessionRow(A, S.sid) === undefined);
    expect(O.requests.slice(mark2).filter(r => r.params?.sessionId === S.sid)).toEqual([]);
    expect(O.requests.slice(mark2).some(r => r.method === 'sync.list')).toBe(true);
    expect(O.requests.filter(isTombstonePush)).toEqual([]);
    expect(regRow(A, S.sid)!.version).toBe(1);
    // K 的消息两端一致
    expect(O.messageIds(K.sid)).toEqual(msgRows(A, K.sid));
    expect(msgRows(A, K.sid)).toEqual([...K.ids, k3, k4, k5].sort());
    expect(O.messageIds(S.sid)).toContain(o1);
  }, T);
});

describe('M2 旧版拨新版', () => {
  it('旧版推已删会话：应答是错误，库里没有；它看到的清单没有墓碑、拉取报「会话不存在」；其它会话照常', async () => {
    const { A, O } = await mixed('O');
    const S = await seedSession(A, 'S', 2);
    const K = await seedSession(A, 'K', 2);
    await onO(O, '收到 S 与 K', () => O.messageIds(S.sid).length === 2 && O.messageIds(K.sid).length === 2);

    await quiet(O);
    const mark = O.outCalls.length;
    await deleteSession(A, S.sid);
    // A 广播 sync.dirty(S)，旧版来拉：与从未存在过的会话逐字相同的错误
    await onO(O, '来拉过已删会话', () => O.outCalls.slice(mark).some(c => c.method === 'sync.pull' && c.params.sessionId === S.sid && c.error !== undefined));
    const pulled = O.outCalls.slice(mark).find(c => c.method === 'sync.pull' && c.params.sessionId === S.sid)!;
    expect(pulled.error).toContain(`sync.pull 会话不存在: ${S.sid}`);
    expect(O.sessionIds()).toContain(S.sid);

    // 旧版把 S 再推一遍（往里追加一条）：被拒
    const o1 = O.append(S.sid, '旧版往已删会话里追加');
    await onO(O, '推送被拒', () => O.outCalls.slice(mark).some(c => c.method === 'sync.push' && c.params.sessionId === S.sid && c.error !== undefined));
    const pushed = O.outCalls.slice(mark).filter(c => c.method === 'sync.push' && c.params.sessionId === S.sid);
    expect(pushed.every(c => c.error !== undefined && c.error.includes(`sync.push 被拒：会话已删除: ${S.sid}`))).toBe(true);
    expect(await aliveIds(A)).not.toContain(S.sid);
    expect(msgRows(A, S.sid)).toEqual([]);
    expect(sessionRow(A, S.sid)).toBeUndefined();

    // 旧版往 K 推新消息照常落库
    const k3 = O.append(K.sid, '旧版在对照会话里追加');
    await waitFor('K 的新消息到 A', () => msgRows(A, K.sid).includes(k3), 40_000, 50);

    // A 重启 → 旧版重拨、全量对账：它整推 S 仍被拒；它拿到的清单的键恰为 sessions，里面没有 S
    const mark2 = O.outCalls.length;
    await A.restart();
    await waitOnline(A, asNode(O));
    await onO(O, '重连后对账取过清单', () => O.outCalls.slice(mark2).some(c => c.method === 'sync.list' && c.result !== undefined));
    const k4 = await seedText(A, K.sid, 'A 重启之后追加');
    await onO(O, '收到 A 重启后的新消息', () => O.messageIds(K.sid).includes(k4));
    const list = O.outCalls.slice(mark2).find(c => c.method === 'sync.list' && c.result !== undefined)!;
    expect(Object.keys(list.result)).toEqual(['sessions']);
    expect((list.result.sessions as Array<{ id: string }>).map(s => s.id)).toEqual([K.sid]);
    const repush = O.outCalls.slice(mark2).filter(c => c.method === 'sync.push' && c.params.sessionId === S.sid);
    expect(repush.length).toBeGreaterThanOrEqual(1);
    expect(repush.every(c => c.error !== undefined)).toBe(true);
    await stays('A 上没有 S', async () => !(await aliveIds(A)).includes(S.sid) && msgRows(A, S.sid).length === 0);
    expect(O.messageIds(S.sid)).toContain(o1);
    expect(O.messageIds(K.sid)).toEqual(msgRows(A, K.sid));
  }, T);
});

describe('M3 旧版自己删会话（物理删、无墓碑）', () => {
  it('新版的会话与消息完好；对账后被推回旧版（旧版的既有行为，写进文档的边界）', async () => {
    const { A, O } = await mixed('A');
    const S = await seedSession(A, 'S', 3);
    await onO(O, '收到 S', () => O.messageIds(S.sid).length === 3);
    O.physicalDelete(S.sid);
    expect(O.sessionIds()).not.toContain(S.sid);

    await A.restart();
    await waitOnline(A, asNode(O));
    await onO(O, 'S 被新版推回', () => O.messageIds(S.sid).length === 3 && O.sessionIds().includes(S.sid));
    // 新版没有因为对端是旧版而丢任何东西，也没有凭空造出墓碑
    expect(await aliveIds(A)).toContain(S.sid);
    expect(msgRows(A, S.sid)).toEqual([...S.ids].sort());
    expect(regRow(A, S.sid)).toBeUndefined();
  }, T);
});

describe('M4 新版上恢复过的会话，旧版往里追加', () => {
  it('本机此刻存活：不带版本的内容照常按 id 并集合并，登记不动', async () => {
    const { A, O } = await mixed('A');
    const S = await seedSession(A, 'S', 2);
    await onO(O, '收到 S', () => O.messageIds(S.sid).length === 2);
    // 造出保留副本再恢复：一条没见过任何消息的墓碑（经本机连接注入），然后显式恢复
    expect((await inject(A, S.sid, { messages: [], markers: [], lifecycle: { v: 1, opId: 'DEL-ELSEWHERE', originDeviceId: 'aabbccddeeff', at: 1, seen: makeSeen([]) } })).tombstone).toBe('applied');
    expect(await aliveIds(A)).not.toContain(S.sid);
    expect(await A.call('chat.sessions.restore', { sessionId: S.sid, confirm: true })).toEqual({ ok: true });
    expect(regRow(A, S.sid)!.version).toBe(2);

    const fromA = await seedText(A, S.sid, '恢复之后 A 追加');
    await onO(O, '收到恢复后的新消息（带版本与会话行的批次旧版照收）', () => O.messageIds(S.sid).includes(fromA));
    const fromO = O.append(S.sid, '旧版往恢复过的会话里追加');
    await waitFor('旧版的追加到 A', () => msgRows(A, S.sid).includes(fromO), 40_000, 50);
    expect(await aliveIds(A)).toContain(S.sid);
    expect(msgRows(A, S.sid)).toEqual([...S.ids, fromA, fromO].sort());
    expect(O.messageIds(S.sid)).toEqual(msgRows(A, S.sid));
    expect(regRow(A, S.sid)).toMatchObject({ version: 2, origin_device_id: A.fp });
  }, T);
});
