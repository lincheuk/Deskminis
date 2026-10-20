/** F11B 端到端（四）：删除与运行账本（F05）在真实引擎上的交界——真实配对、真实同步路径、真实的 chat.prompt。
 *
 *  L1：本机删除之后对这个会话提问（同一个 promptId、新的 promptId、不带 promptId）都被拒，不留 run 行，快照里没有它；
 *  L2：对端删除、本机保留副本——账本行原样留着；同一个 promptId 再提交答「会话已删除」而不是 duplicate，
 *      快照不带出它的运行；显式恢复之后旧 promptId 仍去重、下一次运行接着数；接受恢复的那一端从第 1 次数起；
 *  L3：对端删除覆盖本机全部内容（清除）——这个会话的 run 行与工具执行行一并清掉，别的会话的不动；
 *  L4：定时任务触发的会话正在跑时被对端删除——任务终态记「会话已删除」，run 记 cancelled / session-deleted，
 *      工具没有执行；再触发是一个新会话，不碰已删除的那个。
 *
 *  断言落在物理行上（另开只读连接查库）；等待一律是「条件成立」或「各端 digest 相等且不再变化」。 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  aliveIds, deleteSession, disposeAll, msgRows, newSession, orderedDirs, pair, regCore, retained, rows, seedSession, sessionRow, settle,
  startNode, waitFor, waitOnline, type NodeOpts, type TestNode,
} from './sync-delete-util';

const servers: Server[] = [];
afterEach(async () => {
  await disposeAll();
  for (const s of servers.splice(0)) await new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); });
});

const T = 120_000;
const toolScript = (name: string, input: Record<string, unknown>): string => `__tool__ ${name} ${JSON.stringify(input)}`;
/** 技能目录的写要问（放行前不落盘）：用它得到一张权限卡，任何平台都可用。 */
const SKILL_WRITE = (name: string): string => toolScript('file_write', { path: `/var/minis/skills/f11b/${name}`, content: 'x', tool_title: `写 ${name}` });

const runsOf = (n: TestNode, sid: string): Array<Record<string, any>> =>
  rows(n.dir, 'SELECT id, generation, state, active, stop_reason, origin, origin_ref, prompt_id, user_message_id FROM agent_runs WHERE session_id=? ORDER BY generation', sid);
const execsOf = (n: TestNode, sid: string): Array<Record<string, any>> =>
  rows(n.dir, 'SELECT id, state, end_kind, delivered_at, result_message_id FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sid);
const turnEnds = (n: TestNode, sid: string): number =>
  n.notes('chat.event').filter(e => e?.sessionId === sid && e.event?.kind === 'turnEnd').length;
const snapshotOf = async (n: TestNode, q: { sessionId?: string; runId?: string }): Promise<{ runs: Array<Record<string, any>>; executions: Array<Record<string, any>> }> =>
  n.call('chat.runs.snapshot', q);
const prompt = (n: TestNode, sid: string, text: string, promptId?: string): Promise<any> =>
  n.call('chat.prompt', { sessionId: sid, providerId: '__fake__', text, ...(promptId !== undefined ? { promptId } : {}) });

/** A 是拨号方（指纹小），B 是监听方。 */
async function two(optsB: NodeOpts = {}): Promise<{ A: TestNode; B: TestNode }> {
  const [dA, dB] = orderedDirs(2);
  const A = await startNode('A', dA);
  const B = await startNode('B', dB, optsB);
  await pair(A, B);
  return { A, B };
}

async function localServer(): Promise<{ url: string; hits: () => number }> {
  let n = 0;
  const server = createServer((_req, res) => { n++; res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('抓到了'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`, hits: () => n };
}

describe('L1 本机删除之后再提问', () => {
  it('同一个 promptId、新的 promptId、不带 promptId 都被拒；不留 run 行、不留消息；快照里没有它；别的会话照常', async () => {
    const [d] = orderedDirs(1);
    const A = await startNode('A', d);
    const sid = await newSession(A, 'S');
    const kid = await newSession(A, 'K');
    expect(await prompt(A, sid, '你好', 'l1-0001')).toMatchObject({ ok: true, generation: 1, duplicate: false });
    await waitFor('第一轮跑完', () => turnEnds(A, sid) >= 1, 15_000);
    expect(runsOf(A, sid)).toMatchObject([{ state: 'completed', prompt_id: 'l1-0001' }]);
    const runId = runsOf(A, sid)[0].id as string;

    expect(await deleteSession(A, sid)).toEqual({ ok: true });
    expect(runsOf(A, sid)).toEqual([]);
    expect(execsOf(A, sid)).toEqual([]);

    await expect(prompt(A, sid, '你好', 'l1-0001')).rejects.toThrow(/会话已删除/);
    await expect(prompt(A, sid, '换一条', 'l1-0002')).rejects.toThrow(/会话已删除/);
    await expect(prompt(A, sid, '不带 id')).rejects.toThrow(/会话已删除/);
    // 被拒的提交没有占用 run：账本里这个会话一行都没有（以前先占了 run、落消息时才被拒，留下没有会话的 run 行）
    expect(runsOf(A, sid)).toEqual([]);
    expect(msgRows(A, sid)).toEqual([]);
    expect(sessionRow(A, sid)).toBeUndefined();
    for (const q of [{ sessionId: sid }, { runId }]) {
      const snap = await snapshotOf(A, q);
      expect(snap.runs.filter(r => r.sessionId === sid)).toEqual([]);
    }
    expect(rows(A.dir, 'SELECT COUNT(*) AS n FROM agent_runs WHERE active=1')).toEqual([{ n: 0 }]);
    // 没有留下内存占位：别的会话照常提问
    expect(await prompt(A, kid, '另一个会话', 'l1-k-0001')).toMatchObject({ ok: true, generation: 1 });
    await waitFor('对照会话跑完', () => turnEnds(A, kid) >= 1, 15_000);
  }, T);
});

describe('L2 保留副本上的运行账本', () => {
  it('账本行原样留着；重复的 promptId 答「会话已删除」、快照不带出它；显式恢复后旧 promptId 仍去重、运行接着数', async () => {
    const { A, B } = await two();
    const S = await seedSession(A, 'S', 2);
    await settle([A, B]);

    // A 离线期间 B 在这个会话里跑了一轮；随后 A 删除（没见过 B 这一轮）
    await A.stop();
    expect(await prompt(B, S.sid, 'B 离线时的提问', 'l2-0001')).toMatchObject({ ok: true, generation: 1, duplicate: false });
    await waitFor('B 这一轮跑完', () => turnEnds(B, S.sid) >= 1, 15_000);
    const ledgerBefore = JSON.stringify(runsOf(B, S.sid));
    expect(runsOf(B, S.sid)).toMatchObject([{ state: 'completed', active: null, prompt_id: 'l2-0001' }]);
    const runId = runsOf(B, S.sid)[0].id as string;
    const kept = msgRows(B, S.sid);
    await B.stop();
    await A.restart();
    expect(await deleteSession(A, S.sid)).toEqual({ ok: true });
    await B.restart();
    await waitOnline(A, B);
    await waitFor('B 上会话进入保留列表', async () => (await retained(B)).some(r => r.id === S.sid), 40_000, 50);
    await settle([A, B]);

    // 保留副本：内容与账本行一行不动
    expect(msgRows(B, S.sid)).toEqual(kept);
    expect(JSON.stringify(runsOf(B, S.sid))).toBe(ledgerBefore);
    // 已删除的会话拒写：同一个 promptId 再提交不是 duplicate，是「会话已删除」；新的提交同样被拒，不多出 run 行
    await expect(prompt(B, S.sid, 'B 离线时的提问', 'l2-0001')).rejects.toThrow(/会话已删除/);
    await expect(prompt(B, S.sid, '新的提问', 'l2-0002')).rejects.toThrow(/会话已删除/);
    expect(JSON.stringify(runsOf(B, S.sid))).toBe(ledgerBefore);
    expect(msgRows(B, S.sid)).toEqual(kept);
    // 已删除的会话不显示：按会话、按 runId 取快照都不带出它
    for (const q of [{ sessionId: S.sid }, { runId }]) {
      const snap = await snapshotOf(B, q);
      expect(snap.runs.filter(r => r.sessionId === S.sid), JSON.stringify(q)).toEqual([]);
      expect(snap.executions.filter(x => x.sessionId === S.sid), JSON.stringify(q)).toEqual([]);
    }
    // 删除方：这个会话名下没有账本行，提问被拒且不留行
    await expect(prompt(A, S.sid, '删除方再问', 'l2-a-0001')).rejects.toThrow(/会话已删除/);
    expect(runsOf(A, S.sid)).toEqual([]);

    // 显式恢复：快照重新带出原来那次运行；同一个 promptId 仍是 duplicate、不落第二条消息；新的提交是第 2 次运行
    expect(await B.call('chat.sessions.restore', { sessionId: S.sid, confirm: true })).toEqual({ ok: true });
    expect((await snapshotOf(B, { sessionId: S.sid })).runs).toMatchObject([{ runId, sessionId: S.sid, state: 'completed', generation: 1 }]);
    expect(await prompt(B, S.sid, 'B 离线时的提问', 'l2-0001')).toMatchObject({ ok: true, duplicate: true, state: 'completed', runId, generation: 1 });
    expect(msgRows(B, S.sid)).toEqual(kept);
    const ends = turnEnds(B, S.sid);
    expect(await prompt(B, S.sid, '恢复之后的提问', 'l2-0003')).toMatchObject({ ok: true, duplicate: false, generation: 2 });
    await waitFor('恢复之后的一轮跑完', () => turnEnds(B, S.sid) > ends, 15_000);
    await waitFor('A 上会话回来', async () => (await aliveIds(A)).includes(S.sid), 40_000, 50);
    const d = await settle([A, B]);
    expect(d.alive).toContain(S.sid);
    expect(msgRows(A, S.sid)).toEqual(msgRows(B, S.sid));
    expect(regCore(A, S.sid)).toEqual(regCore(B, S.sid));
    // 接受恢复的一端：账本行在删除时清掉了，从第 1 次数起
    expect(runsOf(A, S.sid)).toEqual([]);
    expect(await prompt(A, S.sid, 'A 接着问', 'l2-a-0002')).toMatchObject({ ok: true, duplicate: false, generation: 1 });
    await waitFor('A 这一轮跑完', () => turnEnds(A, S.sid) >= 1, 15_000);
    await settle([A, B]);
    expect(msgRows(A, S.sid)).toEqual(msgRows(B, S.sid));
  }, T);
});

describe('L3 对端删除覆盖本机全部内容', () => {
  it('会话清掉的同时，它的 run 行与工具执行行一并清掉；别的会话的账本行不动', async () => {
    const { A, B } = await two({ permTimeoutMs: 60_000 });
    const S = await seedSession(A, 'S', 2);
    const K = await seedSession(A, 'K', 1);
    await settle([A, B]);

    // B 在 S 里跑完一轮带工具的（批准一次），在 K 里跑完一轮纯文本的；都同步到 A
    await prompt(B, S.sid, SKILL_WRITE('l3.txt'), 'l3-0001');
    const card = await waitFor('B 上挂出权限卡', () => B.notes('permission.request').find(p => p.req?.sessionId === S.sid), 15_000);
    await B.call('permission.respond', { requestId: card.requestId, decision: 'allow-once' });
    await waitFor('S 这一轮跑完', () => turnEnds(B, S.sid) >= 1, 15_000);
    await prompt(B, K.sid, '对照', 'l3-k-0001');
    await waitFor('K 这一轮跑完', () => turnEnds(B, K.sid) >= 1, 15_000);
    await settle([A, B]);
    expect(runsOf(B, S.sid)).toMatchObject([{ state: 'completed' }]);
    expect(execsOf(B, S.sid)).toMatchObject([{ state: 'completed' }]);
    const keepLedger = JSON.stringify(runsOf(B, K.sid));

    expect(await deleteSession(A, S.sid)).toEqual({ ok: true });
    await waitFor('B 上会话不再存活', async () => !(await aliveIds(B)).includes(S.sid), 40_000, 50);
    await settle([A, B]);
    // A 见过 B 的全部消息：B 清除，不保留
    expect(await retained(B)).toEqual([]);
    expect(sessionRow(B, S.sid)).toBeUndefined();
    expect(msgRows(B, S.sid)).toEqual([]);
    expect(runsOf(B, S.sid)).toEqual([]);
    expect(execsOf(B, S.sid)).toEqual([]);
    expect(JSON.stringify(runsOf(B, K.sid))).toBe(keepLedger);
    // 清除之后再提问：被拒，不留 run 行
    await expect(prompt(B, S.sid, '还在吗', 'l3-0002')).rejects.toThrow(/会话已删除/);
    expect(runsOf(B, S.sid)).toEqual([]);
  }, T);
});

describe('L4 定时任务触发的会话正在跑时被对端删除', () => {
  it('任务终态记「会话已删除」；run 记 cancelled / session-deleted，工具没有执行；再触发是新会话', async () => {
    const { A, B } = await two({ permTimeoutMs: 60_000 });
    const target = await localServer();
    const job = await B.call('cron.create', {
      name: '定时抓取', prompt: toolScript('web_fetch', { url: target.url, tool_title: '抓网页' }), scheduleKind: 'interval', scheduleValue: '60',
    });
    const jobNow = async (): Promise<Record<string, any>> => ((await B.call('cron.list', {})) as Array<Record<string, any>>).find(j => j.id === job.id)!;

    expect(await B.call('cron.runNow', { id: job.id })).toEqual({ ok: true });
    const card = await waitFor('定时会话挂出权限卡', () => B.notes('permission.request')[0], 15_000);
    const sid = card.req.sessionId as string;
    expect((await jobNow()).lastSessionId).toBe(sid);
    await waitFor('定时会话同步到 A（带着那条发起工具调用的消息）', () => msgRows(A, sid).length >= 2, 30_000, 50);

    expect(await deleteSession(A, sid)).toEqual({ ok: true });
    await waitFor('任务终态', async () => String((await jobNow()).lastStatus).startsWith('error'), 30_000, 50);
    expect((await jobNow()).lastStatus).toBe('error: 会话已删除');
    await waitFor('B 上会话不再存活', async () => !(await aliveIds(B)).includes(sid), 30_000, 50);
    // run 先收尾（落终态、补「已取消」的结果），之后才落墓碑：账本里没有活动行
    expect(runsOf(B, sid)).toMatchObject([{ state: 'cancelled', active: null, stop_reason: 'session-deleted', origin: 'cron', origin_ref: job.id }]);
    const execs = execsOf(B, sid);
    expect(execs).toMatchObject([{ state: 'cancelled' }]);
    expect(execs[0].delivered_at).not.toBeNull();
    expect(target.hits()).toBe(0);
    // 收尾时写下的结果删除方没见过：本机保留副本
    expect((await retained(B)).map(r => r.id)).toEqual([sid]);
    const kept = msgRows(B, sid);
    // 批准那张早已了结的卡：工具不执行
    await B.call('permission.respond', { requestId: card.requestId, decision: 'allow-once' });

    // 再触发一次：新建一个会话；已删除的那个不动
    expect(await B.call('cron.runNow', { id: job.id })).toEqual({ ok: true });
    const card2 = await waitFor('第二次触发挂出权限卡', () => B.notes('permission.request').find(p => p.req?.sessionId !== sid), 15_000);
    const sid2 = card2.req.sessionId as string;
    expect(sid2).not.toBe(sid);
    expect(await B.call('chat.cancel', { sessionId: sid2 })).toMatchObject({ ok: true });
    await waitFor('第二次触发收尾', async () => String((await jobNow()).lastStatus).startsWith('error'), 15_000, 50);
    expect(target.hits()).toBe(0);
    expect(msgRows(B, sid)).toEqual(kept);
    expect(runsOf(B, sid)).toHaveLength(1);
    expect(await aliveIds(A)).not.toContain(sid);
  }, T);
});
