/** F11B 端到端（二）：对端的删除落到一个正在跑的会话上（设计 §4.3、§4.10、§4.12）。
 *
 *  E13：权限卡挂着时对端删除 → 卡按 session-deleted 了结，之后再批准工具也不执行；run 收尾后才落墓碑，
 *       收尾时写下的消息删除方没见过，所以本机保留副本；工具调用与结果仍然配对。
 *  E14：run 停不下来（握手不应答的 MCP）→ 不硬删，推迟到 run 自己收尾后本机重试。
 *  E10b / E10c：墓碑在等 run 停下期间，送来它的设备被取消配对 → 不落地（重试入口、await 之后各一例）。
 *  E17：宿主的源码守卫（收尾顺序、主路径上只有一处落库、await 前后各复查一次）。
 *
 *  「墓碑已经进了对端的处理器」用同一条连接上排在它后面的另一次推送作闸：对照会话的新消息到了，
 *  排在前面的墓碑请求一定已经开始处理。不靠固定时长猜。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchEngine, type EngineWatch } from './engine-wiring';
import { callMark, onCall, yieldProbe } from './engine-trace';
import { StaticIdentity, type PairingService } from '../src/minisd/remote/pairing';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import type { TombstoneHost } from '../src/minisd/sync/receive';
import type { WireLifecycle } from '../src/minisd/sync/wire';
import type { ChatStore } from '../src/minisd/store/chat-store';
import {
  aliveIds, auditTypes, deleteSession, disposeAll, inject, msgRows, orderedDirs, pair, payloadOf, regCore, regRow, retained, rows,
  seedSession, seedText, sessionRow, settle, startNode, waitFor, waitOnline, type NodeOpts, type TestNode,
} from './sync-delete-util';
import { expectSame } from './engine-trace';

const servers: Server[] = [];
afterEach(async () => {
  await disposeAll();
  for (const s of servers.splice(0)) await new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); });
  vi.restoreAllMocks();
});

const T = 120_000;
const toolScript = (name: string, input: Record<string, unknown>): string => `__tool__ ${name} ${JSON.stringify(input)}`;

/** 本地 HTTP 服务器。hang=true 时收下请求永不应答（模拟握手不应答的 MCP）。 */
async function localServer(hang: boolean): Promise<{ url: string; hits: () => number }> {
  let n = 0;
  const server = createServer((_req, res) => {
    n++;
    if (hang) return;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('抓到了');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, hits: () => n };
}

/** A 是拨号方（指纹小），B 是监听方；B 的数据根可以预先铺一台握手不应答的 MCP。
 *  bDials：角色互换，B 是拨号方——A 的删除不是推给 B 的，而是 B 收到 sync.dirty 之后自己拉来的。 */
async function twoWithB(optsB: NodeOpts, hangingMcp?: { url: string; startupTimeoutSeconds: number }, bDials = false): Promise<{ A: TestNode; B: TestNode }> {
  const dirs = orderedDirs(2);
  const [dA, dB] = bDials ? [dirs[1], dirs[0]] : dirs;
  if (hangingMcp) {
    mkdirSync(join(dB.dir, 'mcp-servers'), { recursive: true });
    writeFileSync(join(dB.dir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { hang: hangingMcp } }), 'utf8');
  }
  const A = await startNode('A', dA);
  const B = await startNode('B', dB, optsB);
  await pair(A, B);
  return { A, B };
}

/** A 删 S，紧接着往对照会话 K 追加一条；等 K 的新消息到 B。此时排在它前面的 S 的墓碑一定已进了 B 的宿主。 */
async function deleteThenGate(A: TestNode, B: TestNode, sid: string, kid: string): Promise<void> {
  expect(await deleteSession(A, sid)).toEqual({ ok: true });
  const gateMsg = await seedText(A, kid, '排在墓碑后面的闸');
  await waitFor('对照会话的新消息到 B（墓碑请求已在处理）', () => msgRows(B, kid).includes(gateMsg), 20_000, 20);
}

describe('E13 应用墓碑时会话正在跑（权限卡挂着）', () => {
  it('卡按 session-deleted 了结，之后批准也不执行；本机保留副本，工具调用与结果配对；再发消息被拒', async () => {
    const { A, B } = await twoWithB({ permTimeoutMs: 60_000 });
    const target = await localServer(false);
    const S = await seedSession(A, 'S', 2);
    await settle([A, B]);

    await B.call('chat.prompt', { sessionId: S.sid, providerId: '__fake__', text: toolScript('web_fetch', { url: target.url.replace('/mcp', '/page'), tool_title: '抓网页' }) });
    const card = await waitFor('B 上挂出权限卡', () => B.notes('permission.request').find(p => p.req?.sessionId === S.sid), 15_000);
    const requestId = card.requestId as string;

    expect(await deleteSession(A, S.sid)).toEqual({ ok: true });
    await waitFor('B 的卡按 session-deleted 了结', () => B.notes('permission.resolved').some(p => p.requestId === requestId && p.reason === 'session-deleted'), 20_000);
    await waitFor('B 上会话进入保留列表', async () => (await retained(B)).some(r => r.id === S.sid), 20_000, 50);

    // 删除之后才点「允许」：卡早已了结，工具不执行
    await B.call('permission.respond', { requestId, decision: 'allow-once' });
    await waitFor('批准之后 B 仍安静', async () => (await aliveIds(B)).includes(S.sid) === false, 5_000);
    await new Promise<void>(r => setTimeout(r, 300));
    expect(target.hits()).toBe(0);

    // B：不在列表、内容留着、有删除方没见过的消息
    expect(await aliveIds(B)).not.toContain(S.sid);
    const kept = (await retained(B)).find(r => r.id === S.sid)!;
    expect(kept.deletedBy).toBe(A.fp);
    expect(kept.unseenCount).toBeGreaterThanOrEqual(1);
    expect(sessionRow(B, S.sid)!.remote_tombstoned_at).toBeGreaterThan(0);
    // 每个 toolUse 都有配对的 toolResult（run 先走完取消收尾，之后才落墓碑）
    const parts = rows<{ parts_json: string }>(B.dir, 'SELECT parts_json FROM messages WHERE session_id=?', S.sid)
      .flatMap(r => JSON.parse(r.parts_json) as Array<{ type: string; value: any }>);
    const uses = parts.filter(p => p.type === 'toolUse').map(p => p.value.toolUseId as string);
    const results = parts.filter(p => p.type === 'toolResult');
    expect(uses).toHaveLength(1);
    expect(results.map(p => p.value.toolUseId)).toEqual(uses);
    // 结果是「没有执行」的那一种（具体取值归权限结果的分类管，这里只钉它不是成功）
    expect(results[0].value.success).toBe(false);
    // 运行账本（F05）：run 先落了终态、那一批已交付，之后才落墓碑——保留副本名下没有活动的 run、没有未交付的调用
    const ledger = (): unknown => ({
      runs: rows(B.dir, 'SELECT state, active, stop_reason FROM agent_runs WHERE session_id=? ORDER BY generation', S.sid),
      execs: rows(B.dir, 'SELECT state, delivered_at IS NOT NULL AS delivered FROM tool_executions WHERE session_id=?', S.sid),
    });
    expect(ledger()).toEqual({
      runs: [{ state: 'cancelled', active: null, stop_reason: 'session-deleted' }],
      execs: [{ state: 'cancelled', delivered: 1 }],
    });
    // 再对这个会话发消息：被拒，消息行不变，账本里也不多出一行 run
    const before = msgRows(B, S.sid);
    const ledgerBefore = ledger();
    await expect(B.call('chat.prompt', { sessionId: S.sid, providerId: '__fake__', text: '还在吗' })).rejects.toThrow(/会话已删除/);
    expect(msgRows(B, S.sid)).toEqual(before);
    expect(ledger()).toEqual(ledgerBefore);
    // 广播：这个会话已从列表消失之后才通知界面
    expect(B.notes('chat.sessions.lifecycle').filter(n => n.sessionId === S.sid).map(n => [n.kind, n.origin, n.retained])).toEqual([['tombstone-applied', 'remote', true]]);
    expect((await auditTypes(B, S.sid)).find(a => a.type === 'session.deleted.remote')?.payload).toMatchObject({ retained: true, by: A.fp });
    // A：不存活，也没有收下 B 收尾时写的消息
    expect(await aliveIds(A)).not.toContain(S.sid);
    expect(msgRows(A, S.sid)).toEqual([]);
    expect(regCore(B, S.sid)).toEqual(regCore(A, S.sid));
  }, T);
});

describe('E14 run 停不下来：推迟，不硬删', () => {
  it('墓碑先被推迟（会话仍在），run 自己收尾后本机重试并清除', async () => {
    const mcp = await localServer(true);
    const { A, B } = await twoWithB({ runStopTimeoutMs: 200 }, { url: mcp.url, startupTimeoutSeconds: 2 });
    const S = await seedSession(A, 'S', 2);
    await settle([A, B]);

    const prompting = B.call('chat.prompt', { sessionId: S.sid, providerId: '__fake__', text: '你好' });
    const settled = prompting.then(() => 'ok', (e: Error) => e.message);
    await waitFor('MCP 握手请求到达（prompt 正卡在 ensureForRun）', () => mcp.hits() > 0, 15_000, 10);

    expect(await deleteSession(A, S.sid)).toEqual({ ok: true });
    // 用同一条墓碑经 B 的本机连接再探一次：宿主答「run 还没停下」，库没有动
    const tomb = await payloadOf(A, S.sid);
    expect(tomb.lifecycle.v).toBe(1);
    const probe = await inject(B, S.sid, tomb);
    expect(probe.tombstone).toBe('deferred');
    expect(sessionRow(B, S.sid)).toMatchObject({ id: S.sid, remote_tombstoned_at: null });
    expect(regRow(B, S.sid)).toBeUndefined();
    expect(msgRows(B, S.sid)).toEqual([...S.ids].sort());

    // run 自己收尾（MCP 启动超时后看到已中止），随后本机重试落地
    expect(await settled).toContain('会话已取消');
    await waitFor('run 收尾后 B 上会话被清除', async () => !(await aliveIds(B)).includes(S.sid), 4_000, 20);
    expect(msgRows(B, S.sid)).toEqual([]);
    expect(sessionRow(B, S.sid)).toBeUndefined();
    expect(regCore(B, S.sid)).toEqual(regCore(A, S.sid));
    expect(await retained(B)).toEqual([]);
    // 运行账本（F05）：那次被中止的 run 的行随会话一起清掉，之后也没有谁再写回来
    expect(rows(B.dir, 'SELECT id FROM agent_runs WHERE session_id=?', S.sid)).toEqual([]);
    expect(rows(B.dir, 'SELECT id FROM tool_executions WHERE session_id=?', S.sid)).toEqual([]);
    expect(rows(B.dir, 'SELECT COUNT(*) AS n FROM agent_runs WHERE active=1')).toEqual([{ n: 0 }]);
  }, T);
});

describe('E10b / E10c 取消配对后，等着 run 停下的墓碑不落地', () => {
  async function stuck(optsB: NodeOpts, startupTimeoutSeconds: number, bDials = false): Promise<{ A: TestNode; B: TestNode; sid: string; kid: string; ids: string[]; settled: Promise<string> }> {
    const mcp = await localServer(true);
    const { A, B } = await twoWithB(optsB, { url: mcp.url, startupTimeoutSeconds }, bDials);
    const S = await seedSession(A, 'S', 2);
    const K = await seedSession(A, 'K', 1);
    await settle([A, B]);
    const prompting = B.call('chat.prompt', { sessionId: S.sid, providerId: '__fake__', text: '你好' });
    const settled = prompting.then(() => 'ok', (e: Error) => e.message);
    await waitFor('prompt 正卡在 ensureForRun', () => mcp.hits() > 0, 15_000, 10);
    return { A, B, sid: S.sid, kid: K.sid, ids: [...S.ids].sort(), settled };
  }

  async function expectNotLanded(B: TestNode, sid: string, ids: string[]): Promise<void> {
    expect(await aliveIds(B)).toContain(sid);
    expect(msgRows(B, sid)).toEqual(ids);
    expect(sessionRow(B, sid)).toMatchObject({ id: sid, remote_tombstoned_at: null });
    expect(regRow(B, sid)).toBeUndefined();
    expect((await auditTypes(B, sid)).some(a => a.type === 'session.deleted.remote')).toBe(false);
  }

  it('E10c 解绑落在 await stopRun 期间：run 停下后复查配对，不落库', async () => {
    // runStopTimeoutMs 8 秒 > MCP 启动超时 2 秒：stopRun 兑现为「已停下」而不是超时
    const { A, B, sid, kid, ids, settled } = await stuck({ runStopTimeoutMs: 8_000 }, 2);
    await deleteThenGate(A, B, sid, kid);
    expect(await B.call('remote.unpair', { peerFingerprint: A.fp })).toEqual({ ok: true });
    expect(await settled).toContain('会话已取消');
    // 再走一个来回：宿主在 run 兑现的同一拍里已经跑完
    await B.call('chat.sessions.list');
    await expectNotLanded(B, sid, ids);
  }, T);

  it('E10c 角色互换（墓碑是 B 自己拉来的，不经 sync.push 的入口守卫）：解绑落在 await stopRun 期间，同样不落库', async () => {
    const { A, B, sid, kid, ids, settled } = await stuck({ runStopTimeoutMs: 8_000 }, 2, true);
    expect(B.fp < A.fp).toBe(true);
    await deleteThenGate(A, B, sid, kid);
    expect(await B.call('remote.unpair', { peerFingerprint: A.fp })).toEqual({ ok: true });
    expect(await settled).toContain('会话已取消');
    await B.call('chat.sessions.list');
    await expectNotLanded(B, sid, ids);
  }, T);

  it('E10b 解绑落在延后重试之前：重试入口复查配对，不落库；重新配对后经对账重新送达', async () => {
    // runStopTimeoutMs 200ms，MCP 启动超时 6 秒：stopRun 超时，墓碑记进延后表，等 run 收尾重试
    const { A, B, sid, kid, ids, settled } = await stuck({ runStopTimeoutMs: 200 }, 6);
    await deleteThenGate(A, B, sid, kid);
    // 墓碑请求已在处理；等过 stopRun 的 200ms 上限（留 5 倍余量，离 run 收尾还有数秒）
    await new Promise<void>(r => setTimeout(r, 1_000));
    await expectNotLanded(B, sid, ids);
    expect(await B.call('remote.unpair', { peerFingerprint: A.fp })).toEqual({ ok: true });
    expect(await settled).toContain('会话已取消');
    await B.call('chat.sessions.list');
    await expectNotLanded(B, sid, ids);

    // 重新配对：那条墓碑经对账重新送达，B 上会话不再存活；A 不被带回来
    await pair(A, B);
    await waitFor('重新配对后 B 上会话被删除', async () => !(await aliveIds(B)).includes(sid), 30_000, 50);
    await settle([A, B]);
    expect(await aliveIds(A)).not.toContain(sid);
    expect(msgRows(A, sid)).toEqual([]);
    expect(regCore(B, sid)).toEqual(regCore(A, sid));
  }, T);

  // 一个会话上等着 run 收尾的墓碑至多一条。后到的一条顶替它只有两种情形：原来那条的来源已被解绑，或后到的在全序里更优先。
  // 这两例钉住的是「顶替」本身：不顶替的话，第一例里这条删除跟着已解绑的来源一起被丢掉，第二例里落地的是落败的那条。
  it('E10d 等着的那条的来源被解绑之后，同一条墓碑由仍可信的来源再送到：顶替它，run 收尾后照常落地', async () => {
    const { A, B, sid, kid, ids, settled } = await stuck({ runStopTimeoutMs: 200 }, 6);
    await deleteThenGate(A, B, sid, kid);
    const tomb = await payloadOf(A, sid);
    expect(tomb.lifecycle.v).toBe(1);
    // 等过 stopRun 的 200ms 上限：A 送来的那条已记进延后表
    await new Promise<void>(r => setTimeout(r, 1_000));
    await expectNotLanded(B, sid, ids);
    expect(await B.call('remote.unpair', { peerFingerprint: A.fp })).toEqual({ ok: true });
    // 同一条墓碑再到一次，这回经本机连接（真实情形里是另一台仍配对的设备转发来的）。run 还没停下：答「推迟」，库不动
    expect((await inject(B, sid, tomb)).tombstone).toBe('deferred');
    await expectNotLanded(B, sid, ids);

    expect(await settled).toContain('会话已取消');
    await waitFor('run 收尾后 B 上会话被清除', async () => !(await aliveIds(B)).includes(sid), 4_000, 20);
    expect(msgRows(B, sid)).toEqual([]);
    expect(sessionRow(B, sid)).toBeUndefined();
    expect(regCore(B, sid)).toEqual(regCore(A, sid));
    // 落地的是后到的那一条：没有记在已解绑的设备名下
    expect(regRow(B, sid)!.received_from).toBeNull();
  }, T);

  it('E10d 等着的那条之后来了同一代里更优先的一条（opId 更小）：顶替它；再来一条更靠后的不顶替；run 收尾后落地的是最优先的', async () => {
    const { A, B, sid, kid, ids, settled } = await stuck({ runStopTimeoutMs: 200 }, 6);
    await deleteThenGate(A, B, sid, kid);
    const tomb = await payloadOf(A, sid);
    await new Promise<void>(r => setTimeout(r, 1_000));
    await expectNotLanded(B, sid, ids);
    // 并发双删里的另外两条（同一代）。'0-…' 比任何大写 UUID 都小，'ZZZZ-…' 比任何大写 UUID 都大
    const preferred = { ...tomb, lifecycle: { ...tomb.lifecycle, opId: '0-PREFERRED', originDeviceId: 'devOther' } };
    const worse = { ...tomb, lifecycle: { ...tomb.lifecycle, opId: 'ZZZZ-WORSE', originDeviceId: 'devWorse' } };
    expect((await inject(B, sid, preferred)).tombstone).toBe('deferred');
    expect((await inject(B, sid, worse)).tombstone).toBe('deferred');
    await expectNotLanded(B, sid, ids);

    expect(await settled).toContain('会话已取消');
    await waitFor('run 收尾后 B 上会话被清除', async () => !(await aliveIds(B)).includes(sid), 4_000, 20);
    expect(regRow(B, sid)).toMatchObject({ version: 1, op_id: '0-PREFERRED', origin_device_id: 'devOther' });
    expect(msgRows(B, sid)).toEqual([]);
    // A 仍配对：两端收敛到最优先的那一条
    await settle([A, B]);
    expect(regCore(A, sid)).toEqual(regCore(B, sid));
    expect(regRow(A, sid)!.op_id).toBe('0-PREFERRED');
  }, T);
});

describe('E17 宿主的接线（真实引擎）', () => {
  const STEPS = ['run.end', 'terminals.dispose', 'shells.dispose', 'chat.applyTombstone'];
  const tomb = (id: string, ids: string[] = []): WireLifecycle => ({ v: 1, opId: id, originDeviceId: 'Q20-PEER', at: 1, seen: makeSeen(ids) });
  const host = (w: EngineWatch): TombstoneHost => w.args('createSyncMethods')[1].lifecycleHost;
  const chat = (w: EngineWatch): ChatStore => w.args('createSyncMethods')[0];
  async function node(w: EngineWatch, timeout = 200): Promise<TestNode> {
    return startNode('Q20', orderedDirs(1)[0], { runStopTimeoutMs: timeout, permTimeoutMs: 60000 });
  }
  async function running(n: TestNode, sid: string): Promise<void> {
    await n.call('chat.prompt', { sessionId: sid, providerId: '__fake__', text: toolScript('web_fetch', { url: 'http://127.0.0.1:9/q20', tool_title: 'Q20' }) });
    await waitFor('权限卡挂出', () => n.notes('permission.request').some(p => p.req?.sessionId === sid), 10000);
  }
  async function stuckRun(n: TestNode, w: EngineWatch, sid: string): Promise<{ release(): void; settled: Promise<unknown> }> {
    let release!: () => void;
    w.spy('mcp.ensureForRun').mockImplementationOnce(() => new Promise<void>(res => { release = res; }));
    const settled = n.call('chat.prompt', { sessionId: sid, providerId: '__fake__', text: 'Q20 起跑' }).catch(e => String(e));
    await waitFor('起跑停在 MCP', () => typeof release === 'function', 10000);
    return { release, settled };
  }
  function pairPeer(w: EngineWatch): string {
    const svc = w.args('createSyncMethods')[1].pairingService as PairingService;
    const peer = new StaticIdentity();
    const begin = svc.beginPairing();
    svc.completePairing(begin.code, Buffer.from(peer.publicKey).toString('base64'), peer.fingerprint);
    return peer.fingerprint;
  }

  it('主函数体里 chat.applyTombstone( 恰好出现一次', async () => {
    // 空闲和运行中的收包都只在引擎那份 ChatStore 落一次墓碑。
    const w = watchEngine();
    const n = await node(w);
    const a = await seedSession(n, 'idle', 1), b = await seedSession(n, 'running', 1);
    for (const [target, active] of [[a, false], [b, true]] as const) {
      if (active)
        await running(n, target.sid);
      const from = callMark();
      expect((await inject(n, target.sid, { messages: [], markers: [], lifecycle: tomb('Q20-ONE-' + target.sid, target.ids) })).tombstone).toBe('applied');
      expect(w.count('chat.applyTombstone', from)).toBe(1);
      expect(w.spy('chat.applyTombstone').mock.contexts.at(-1)).toBe(chat(w));
      expect(w.spy('chat.applyTombstone').mock.calls.at(-1)?.[0]).toBe(target.sid);
      expect(await aliveIds(n)).not.toContain(target.sid);
      if (active)
        expect(sessionRow(n, target.sid)?.remote_tombstoned_at).toEqual(expect.any(Number));
      else
        expect(sessionRow(n, target.sid)).toBeUndefined();
    }
  }, 30000);

  it('顺序：停 run → 释放终端 → 释放 shell → 落库', async () => {
    // 先起挂着权限卡的运行，再观察停 run、释放进程和落库的完整次序。
    const w = watchEngine();
    const n = await node(w);
    const s = await seedSession(n, 'order', 1);
    await running(n, s.sid);
    const from = callMark();
    expect((await inject(n, s.sid, { messages: [], markers: [], lifecycle: tomb('Q20-ORDER', s.ids) })).tombstone).toBe('applied');
    expect(w.seq(STEPS, from)).toEqual(STEPS);
    expect(w.spy('run.end').mock.calls.at(-1)?.[1]).toMatchObject({ state: 'cancelled', reason: 'session-deleted' });
    for (const name of STEPS.slice(1))
      expect(w.spy(name).mock.calls.at(-1)?.[0], name).toBe(s.sid);
    expect(sessionRow(n, s.sid)?.remote_tombstoned_at).toEqual(expect.any(Number));
    expect(await aliveIds(n)).not.toContain(s.sid);
  }, 30000);

  it('await stopRun 前后各有一次 tombstoneBlock(fromPeer)', async () => {
    // 暂停、解绑和关停分别落在 stopRun 的等待窗口，前后两道闸都要生效。
    const w = watchEngine();
    const n = await node(w, 2000);
    const h = host(w);
    for (const change of ['paused', 'unpaired', 'closing'] as const) {
      const s = await seedSession(n, change, 1);
      const pending = await stuckRun(n, w, s.sid);
      const fp = change === 'unpaired' ? pairPeer(w) : undefined;
      // 入口先查闸：此时还没有停止 run 的动作，入口闸失败也不会释放进程/落库。
      await n.call('control.pause');
      const before = callMark();
      expect(await h.applyRemoteTombstone(s.sid, tomb('Q20-BEFORE-' + change, s.ids), fp)).toEqual({ status: 'deferred', reason: 'paused' });
      expect(w.seq(STEPS, before)).toEqual([]);
      expect(w.count('broker.settleWhere', before)).toBe(0);
      await n.call('control.resume');
      // 入口放行后，确认已经开始 stopRun，再改变闸的状态。
      const from = callMark();
      const landing = h.applyRemoteTombstone(s.sid, tomb('Q20-AFTER-' + change, s.ids), fp);
      await waitFor('stopRun 已了结权限卡', () => w.count('broker.settleWhere', from) > 0, 10000);
      expect(w.count('chat.applyTombstone', from)).toBe(0);
      let closing: Promise<void> | undefined;
      if (change === 'paused')
        await n.call('control.pause');
      else if (change === 'unpaired')
        await n.call('remote.unpair', { peerFingerprint: fp });
      else
        closing = n.stop();
      pending.release();
      if (!closing)
        await pending.settled;
      expect(await landing).toEqual({ status: 'deferred', reason: change });
      expect(w.count('chat.applyTombstone', from)).toBe(0);
      expect(w.count('terminals.dispose', from)).toBe(0);
      expect(w.count('shells.dispose', from)).toBe(0);
      if (closing)
        await closing;
      else {
        expect(sessionRow(n, s.sid)).toBeDefined();
        if (change === 'paused')
          await n.call('control.resume');
      }
    }
  }, 60000);

  it('tombstoneBlock 同时看关停、暂停、配对；早退路径不停 run、没有 await', async () => {
    // 暂停和未配对的来源在入口被拒，不进入收尾或落库。
    const w = watchEngine();
    const n = await node(w);
    const h = host(w);
    const s = await seedSession(n, 'entry', 1);
    const t = tomb('Q20-ENTRY', s.ids);
    await n.call('control.pause');
    let from = callMark();
    expect(await h.applyRemoteTombstone(s.sid, t, undefined)).toEqual({ status: 'deferred', reason: 'paused' });
    expect(w.seq(STEPS, from)).toEqual([]);
    await n.call('control.resume');
    from = callMark();
    expect(await h.applyRemoteTombstone(s.sid, t, 'not-paired')).toEqual({ status: 'deferred', reason: 'unpaired' });
    expect(w.seq(STEPS, from)).toEqual([]);
    expect(sessionRow(n, s.sid)).toBeDefined();
    expect(await h.applyRemoteTombstone(s.sid, t, undefined)).toMatchObject({ status: 'applied' });

    // 重复墓碑（无 run 的早退分支）：判定确实先于落库，没有让出，且不走 stopRun 的卡片收口/进程释放。
    const gaps = yieldProbe(w.spy('chat.getLifecycle'), w.spy('chat.applyTombstone'));
    from = callMark();
    expect(await h.applyRemoteTombstone(s.sid, t, undefined)).toMatchObject({ status: 'duplicate' });
    expect(w.seq(['chat.getLifecycle', 'chat.applyTombstone'], from)).toEqual(['chat.getLifecycle', 'chat.applyTombstone', 'chat.getLifecycle']);
    expect(gaps).toEqual([false]);
    expect(w.count('broker.settleWhere', from)).toBe(0);
    expect(w.count('terminals.dispose', from)).toBe(0);
    expect(w.count('shells.dispose', from)).toBe(0);

    // 延后重试也经过入口闸：停不下时不落库，run 收尾前暂停使重试继续不落库；恢复后同一墓碑可再应用。
    const d = await seedSession(n, 'retry', 1);
    const pending = await stuckRun(n, w, d.sid);
    from = callMark();
    expect(await h.applyRemoteTombstone(d.sid, tomb('Q20-RETRY', d.ids), undefined)).toEqual({ status: 'deferred', reason: 'run-stopping' });
    const isRunning = w.args('new CheckpointService')[0].isSessionRunning as (sid: string) => boolean;
    const ledger = w.made<{ getRun(runId: string): { state: string } | undefined }>('new RunLedger');
    const committed: string[] = [];
    onCall(w.spy('run.ended'), (_self, [ref]: any[]) => {
      if (ref.sessionId === d.sid) committed.push(ledger.getRun(ref.runId)?.state ?? 'missing');
    });
    await n.call('control.pause');
    pending.release();
    await pending.settled;

    // 等终态已落且占位已放，再留一次 RPC 往返，让收尾 Promise 上的重试有机会完成。
    await waitFor('延后重试前 run 确实收尾', () => !isRunning(d.sid) && committed.length === 1, 10000);
    expect(committed).toEqual(['cancelled']);
    await n.call('chat.sessions.list');
    expect(w.count('chat.applyTombstone', from)).toBe(0);
    expect(sessionRow(n, d.sid)).toBeDefined();
    await n.call('control.resume');
    expect(await h.applyRemoteTombstone(d.sid, tomb('Q20-RETRY', d.ids), undefined)).toMatchObject({ status: 'applied' });

    // 关停已经开始时，宿主拒绝新的墓碑落地。
    const closed = n.stop();
    from = callMark();
    expect(await h.applyRemoteTombstone('Q20-CLOSING', tomb('Q20-CLOSE'), undefined)).toEqual({ status: 'deferred', reason: 'closing' });
    expect(w.count('chat.applyTombstone', from)).toBe(0);
    await closed;
  }, 60000);

  it('宿主接到了两条收包路径上；生命周期钩子第一句让附件侧失效', async () => {
    // 两条收包路径拿到同一个实际宿主，各调用一遍都有落库后果。
    const w = watchEngine();
    const n = await node(w);
    const a = host(w), b = w.args('new SyncCoordinator')[2].lifecycleHost as TombstoneHost;
    expect(w.count('createSyncMethods')).toBe(1);
    expect(w.count('new SyncCoordinator')).toBe(1);
    expect(a).toBe(b);
    for (const h of [a, b]) {
      const s = await seedSession(n, 'host', 1);
      const from = callMark();
      expect(await h.applyRemoteTombstone(s.sid, tomb('Q20-HOST-' + s.sid, s.ids), undefined)).toMatchObject({ status: 'applied' });
      expect(w.count('chat.applyTombstone', from)).toBe(1);
      expect(sessionRow(n, s.sid)).toBeUndefined();
    }

    // 生命周期钩子先使附件侧失效，后写审计；审计失败仍已失效。
    const s = await seedSession(n, 'hook', 1);
    const from = callMark();
    w.spy('audit.append').mockImplementationOnce(() => {
      throw new Error('Q20 audit failure');
    });
    chat(w).onLifecycle!({ kind: 'deleted', sessionId: s.sid, lifecycle: tomb('Q20-HOOK'), messageCount: 1 });
    expect(w.seq(['attachments.markDirty', 'audit.append'], from)).toEqual(['attachments.markDirty', 'audit.append']);
    expect(w.spy('attachments.markDirty').mock.calls.at(-1)).toEqual([s.sid]);

    // 旧副本被拒只写审计，不使附件侧失效。
    const stale = callMark();
    chat(w).onLifecycle!({ kind: 'stale-content-rejected', sessionId: s.sid, lifecycle: tomb('Q20-STALE') });
    expect(w.count('attachments.markDirty', stale)).toBe(0);
    expect(w.count('audit.append', stale)).toBe(1);

    const { allLifecycleEvents } = await import('./engine-trace');
    const attachmentPort = w.made('createAttachmentSync').port;
    for (const event of allLifecycleEvents(s.sid, tomb('Q20-ALL-KINDS'))) {
      const mark = callMark();
      chat(w).onLifecycle!(event);
      const expected = event.kind === 'stale-content-rejected' ? 0 : 1;
      expect(w.count('attachments.markDirty', mark), event.kind).toBe(expected);
      if (expected === 1) {
        expect(w.args('attachments.markDirty'), event.kind).toEqual([s.sid]);
        expectSame(w.spy('attachments.markDirty').mock.contexts.at(-1), attachmentPort, event.kind);
      }
    }
  }, 30000);
});
