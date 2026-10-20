/**
 * F06 × F11B × F08（X 组）：真实引擎上，快照 / 续传 / 结果查询遇到已删除的会话，以及两个新广播的入序。
 *
 * F11B 的口径：已删除的会话（已清除的，与「对端删了、本机留着副本」的保留副本）不显示、拒写。
 * chat.runs.snapshot 滤掉了它们的运行；state.attach 与 state.outcomes 是 F06 另写的两条路，这里钉住它们读同一个判据。
 * 对端的墓碑经本机连接的 sync.push 注入（与 F11B、F08 的端到端夹具同一做法），走真实的收包入口 → 宿主（先停 run）→ 落库 → 生命周期钩子。
 *
 *  X1 保留副本：attach（快照、续传）不带出它的运行、执行记录、产物与消息，session.exists 为 false；
 *     outcomes 对它名下的 promptId 答 not-accepted +「会话已删除」（与 chat.prompt 的入口闸同一句）；显式恢复之后都回来。
 *  X2 已清除的会话（本机删除、对端墓碑覆盖全部内容）：同上。
 *  X3 回合停在权限卡上时对端墓碑落地：卡先了结；之后的新连接经 attach 拿不到这张卡，也答不了它；文件没有写。
 *  X4 生命周期与检查点通知入序；删除后会话帧清空，生命周期通知仍回放，序号连续。
 *  X5 启动次序（源码守卫 + 行为）：生命周期自检 → 账本 → 检查点对账 → 事件日志（代次取账本的）→ 启动恢复。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import type { WireLifecycle } from '../src/minisd/sync/wire';
import { coveredBySnapshot } from '../src/shared/event-stream';
import { watchEngine } from './engine-wiring';
import { callMark } from './engine-trace';
import type { ChatStore } from '../src/minisd/store/chat-store';
import { readDb } from './run-ledger-fixture';
import { readAudit } from './permission-fixture';
import {
  bootEngine, gatedLlm, runEventsOf, skillFile, skillWriteInput, streamClient, waitFor, wireClient,
  type BootOpts, type BootedEngine, type GatedLlm, type GatedStep, type StreamClient, type WireClient, type WireFrame,
} from './state-sync-fixture';
import { expectSame } from './engine-trace';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
  vi.restoreAllMocks();
});

async function boot(scripts: Record<string, GatedStep[]> = {}, opts: BootOpts = {}): Promise<{ engine: BootedEngine; llm: GatedLlm }> {
  const llm = await gatedLlm(scripts);
  cleanups.push(() => llm.close());
  const engine = await bootEngine({ llm, ...opts });
  cleanups.push(() => engine.close());
  return { engine, llm };
}
async function wire(port: number, token: string): Promise<WireClient> {
  const c = wireClient(port, token);
  await c.ready;
  cleanups.push(() => c.terminate());
  return c;
}
async function stream(port: number, token: string): Promise<StreamClient> {
  const c = streamClient(port, token);
  await c.ready;
  cleanups.push(() => c.sock.terminate());
  await c.attach();
  return c;
}
type Caller = { call(method: string, params?: unknown): Promise<WireFrame> };
async function ok(c: Caller, method: string, params?: unknown): Promise<any> {
  const r = await c.call(method, params);
  expect(r.error, `${method} 应当成功`).toBeUndefined();
  return r.result;
}
const ended = (events: any[]): boolean => events.some(e => e.kind === 'turnEnd' || e.kind === 'error');
const runRows = (dataDir: string, sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation', sessionId);
const msgIds = (dataDir: string, sessionId: string): string[] =>
  (readDb(dataDir, 'SELECT id FROM messages WHERE session_id=? ORDER BY id', sessionId) as { id: string }[]).map(r => r.id);
const sessionRow = (dataDir: string, sessionId: string): { t: number | null } | undefined =>
  readDb<{ t: number | null }>(dataDir, 'SELECT remote_tombstoned_at AS t FROM sessions WHERE id=?', sessionId)[0];
/** 对端的墓碑，经本机连接注入。ids = 删除方见过的消息：给全 → 清除；给空 → 本机留副本。 */
function pushTombstone(c: Caller, sessionId: string, v: number, opId: string, ids: string[]): Promise<any> {
  const lifecycle: WireLifecycle = { v, opId, originDeviceId: 'devRemote', at: 1, seen: makeSeen(ids) };
  return ok(c, 'sync.push', { sessionId, payload: { messages: [], markers: [], lifecycle } });
}
/** 建会话，工作区绑到一个新的临时目录（数据根之外，写入不走权限卡），跑完一个「写一个文件再答一句」的回合。 */
async function ranSession(c: WireClient, tag: string, promptId: string): Promise<{ sid: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dm-f06-x-user-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sid = (await ok(c, 'chat.sessions.create', {})).id as string;
  await ok(c, 'workspace.set', { sessionId: sid, root: dir });
  await ok(c, 'chat.prompt', { sessionId: sid, text: `[[${tag}]] 写文件`, promptId });
  await waitFor(`${tag} 的回合结束`, () => ended(runEventsOf(c, sid)), 30_000);
  return { sid, dir };
}
const writeStep = (name: string): GatedStep[] => [{ tools: [{ name: 'file_write', input: { path: name, content: `${name} 的内容`, tool_title: `写 ${name}` } }] }, { text: '完成' }];
const attach = async (c: Caller, p: Record<string, unknown> = {}): Promise<any> => ok(c, 'state.attach', p);
const outcomesOf = async (c: Caller, refs: unknown[]): Promise<any[]> => (await ok(c, 'state.outcomes', { refs })).outcomes as any[];
/** 快照里凡是按会话归属的列表，都不含这个会话。 */
function expectNothingOf(snapshot: any, sid: string, what: string): void {
  for (const k of ['sessions', 'runs', 'executions', 'artifacts', 'live'] as const) {
    const rows = (snapshot[k] as any[]).filter(x => (k === 'sessions' ? x.id : x.sessionId) === sid);
    expect(rows, `${what}：snapshot.${k} 不应带出已删除的会话`).toEqual([]);
  }
  expect((snapshot.pendingPermissions as any[]).filter(v => v.req.sessionId === sid), `${what}：待批卡`).toEqual([]);
}

describe('F06 × F11B：快照、续传与结果查询里的已删除会话', () => {
  it('X1 保留副本：带它的 sessionId 来 attach——快照与续传都不带出它的运行、执行记录、产物、消息，session.exists 为 false；outcomes 答 not-accepted +「会话已删除」；显式恢复之后都回来', async () => {
    const { engine } = await boot({ S1: writeStep('x1.txt') });
    const q = await wire(engine.port, engine.token);
    const other = (await ok(q, 'chat.sessions.create', {})).id as string;
    const promptId = 'f06-x1-0001';
    const { sid, dir } = await ranSession(q, 'S1', promptId);
    expect(readFileSync(join(dir, 'x1.txt'), 'utf8')).toBe('x1.txt 的内容');

    // 删除之前：快照带得出它（下面的「不带出」才不是空对空）
    const before = await attach(q, { sessionId: sid });
    expect(before.mode).toBe('snapshot');
    expect(before.snapshot.session).toMatchObject({ sessionId: sid, exists: true });
    const messagesBefore = before.snapshot.session.messages.length as number;
    expect(messagesBefore).toBeGreaterThan(0);
    expect((before.snapshot.runs as any[]).map(r => [r.sessionId, r.state, r.promptId])).toEqual([[sid, 'completed', promptId]]);
    expect((before.snapshot.executions as any[]).some(x => x.sessionId === sid)).toBe(true);
    expect((before.snapshot.artifacts as any[]).some(a => a.sessionId === sid)).toBe(true);
    const cursor = { epoch: before.epoch, instanceId: before.instanceId, lastSeq: before.lastSeq };

    // 对端删除，删除方什么都没见过：本机留副本（会话行隐藏，内容与账本行原样留着）
    await pushTombstone(q, sid, 1, 'OP-X1', []);
    expect(sessionRow(engine.dataDir, sid)?.t).not.toBeNull();
    expect(msgIds(engine.dataDir, sid)).toHaveLength(messagesBefore);
    expect(runRows(engine.dataDir, sid)).toHaveLength(1);
    expect(((await ok(q, 'chat.sessions.listRetained', {})) as any[]).map(r => r.id ?? r.sessionId)).toContain(sid);

    // 不带 sessionId 的快照
    const all = await attach(q);
    expect((all.snapshot.sessions as any[]).map(s => s.id)).toEqual([other]);
    expectNothingOf(all.snapshot, sid, '不带 sessionId');
    expect(all.snapshot.session).toBeUndefined();

    // 带着保留副本的 sessionId：会话已不存在
    const at = await attach(q, { sessionId: sid });
    expect(at.mode).toBe('snapshot');
    expect(at.snapshot.session).toEqual({ sessionId: sid, exists: false, messages: [] });
    expectNothingOf(at.snapshot, sid, '带保留副本的 sessionId');

    // 续传应答里的 runs 同样不带；回放里有那条生命周期广播
    const rs = await attach(q, { sessionId: sid, resume: cursor });
    expect(rs.mode).toBe('resume');
    expect((rs.runs as any[]).filter(r => r.sessionId === sid)).toEqual([]);
    expect((rs.events as any[]).filter(f => f.method === 'chat.sessions.lifecycle').map(f => [f.params.sessionId, f.params.kind, f.params.origin, f.params.retained]))
      .toEqual([[sid, 'tombstone-applied', 'remote', true]]);

    // 与 chat.runs.snapshot 同一口径
    expect((await ok(q, 'chat.runs.snapshot', { sessionId: sid })).runs).toEqual([]);

    // 结果查询：不带出保留副本的运行；说法与 chat.prompt 的入口闸相同
    expect(await outcomesOf(q, [{ kind: 'prompt', sessionId: sid, promptId }]))
      .toEqual([{ kind: 'prompt', sessionId: sid, promptId, status: 'not-accepted', error: '会话已删除' }]);
    expect((await q.call('chat.prompt', { sessionId: sid, text: '[[S1]] 写文件', promptId })).error?.message).toBe('会话已删除');
    expect(runRows(engine.dataDir, sid)).toHaveLength(1);

    // 显式恢复：都回来（账本行与内容一直留着）
    await ok(q, 'chat.sessions.restore', { sessionId: sid, confirm: true });
    const back = await attach(q, { sessionId: sid });
    expect(back.snapshot.session).toMatchObject({ sessionId: sid, exists: true });
    expect(back.snapshot.session.messages).toHaveLength(messagesBefore);
    expect((back.snapshot.runs as any[]).map(r => [r.sessionId, r.state])).toEqual([[sid, 'completed']]);
    expect((back.snapshot.artifacts as any[]).some(a => a.sessionId === sid)).toBe(true);
    expect((await outcomesOf(q, [{ kind: 'prompt', sessionId: sid, promptId }]))[0]).toMatchObject({ status: 'accepted', run: { sessionId: sid, state: 'completed' } });
  }, 60_000);

  it('X2 已清除的会话（本机删除；对端墓碑覆盖了全部内容）：attach 答 exists:false、不带任何它名下的行；outcomes 答 not-accepted +「会话已删除」', async () => {
    const { engine } = await boot({ S1: writeStep('x2a.txt'), S2: writeStep('x2b.txt') });
    const q = await wire(engine.port, engine.token);
    const local = await ranSession(q, 'S1', 'f06-x2-0001');
    const remote = await ranSession(q, 'S2', 'f06-x2-0002');

    await ok(q, 'chat.sessions.delete', { sessionId: local.sid, confirm: true });
    await pushTombstone(q, remote.sid, 1, 'OP-X2', msgIds(engine.dataDir, remote.sid));

    for (const [what, sid, promptId] of [['本机删除', local.sid, 'f06-x2-0001'], ['对端墓碑清除', remote.sid, 'f06-x2-0002']] as const) {
      expect(sessionRow(engine.dataDir, sid), `${what}：会话行`).toBeUndefined();
      expect(runRows(engine.dataDir, sid), `${what}：账本行`).toEqual([]);
      const at = await attach(q, { sessionId: sid });
      expect(at.snapshot.session, what).toEqual({ sessionId: sid, exists: false, messages: [] });
      expectNothingOf(at.snapshot, sid, what);
      expect(await outcomesOf(q, [{ kind: 'prompt', sessionId: sid, promptId }]), what)
        .toEqual([{ kind: 'prompt', sessionId: sid, promptId, status: 'not-accepted', error: '会话已删除' }]);
    }
    expect((await ok(q, 'chat.sessions.list')) as any[]).toEqual([]);
    // 从未删除过的 id 不受影响：账本里没有这个 promptId → 不带原因的 not-accepted
    const fresh = (await ok(q, 'chat.sessions.create', {})).id as string;
    expect(await outcomesOf(q, [{ kind: 'prompt', sessionId: fresh, promptId: 'f06-x2-0003' }]))
      .toEqual([{ kind: 'prompt', sessionId: fresh, promptId: 'f06-x2-0003', status: 'not-accepted' }]);
  }, 60_000);

  it('X3 回合停在权限卡上时对端墓碑落地（先停 run 再落库）：卡先了结；之后的新连接 attach 拿不到这张卡、没有补发记录、答了也不生效；彻底删除保留副本之后仍然如此；文件没有写', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    cleanups.push(() => warn.mockRestore());
    const { engine } = await boot({ S3: [{ tools: [{ name: 'file_write', input: skillWriteInput('x3.txt', '不该落盘') }] }, { text: 'X3 完成' }] }, { permTimeoutMs: 60_000 });
    const file = skillFile(engine.dataDir, 'x3.txt');
    const a = await stream(engine.port, engine.token);
    const q = await wire(engine.port, engine.token);
    const sid = (await ok(q, 'chat.sessions.create', {})).id as string;
    await ok(q, 'chat.prompt', { sessionId: sid, text: '[[S3]] 写技能目录', promptId: 'f06-x3-0001' });
    await waitFor('A 收到权限卡', () => a.cardIds().length === 1);
    const R = a.cardIds()[0];
    // 发卡时：一条刚连上的连接经 attach 拿得到它（对照）
    const pre = await wire(engine.port, engine.token);
    expect(((await attach(pre, { sessionId: sid })).snapshot.pendingPermissions as any[]).map(v => v.requestId)).toEqual([R]);
    pre.terminate();
    const redeliveredBefore = readAudit(engine.dataDir).filter(x => x.eventType === 'permission.redelivered').length;

    // 对端删除落地。run 收尾时还会落消息，删除方没见过它们，所以本机留成保留副本
    await pushTombstone(q, sid, 1, 'OP-X3', msgIds(engine.dataDir, sid));
    expect(a.cardIds()).toEqual([]);                       // 连着的窗口：卡已摘
    expect(ended(runEventsOf(q, sid))).toBe(true);         // run 已收尾
    expect(((await ok(q, 'chat.sessions.list')) as any[]).map(s => s.id)).not.toContain(sid);

    const check = async (what: string): Promise<void> => {
      const b = await wire(engine.port, engine.token);
      const at = await attach(b, { sessionId: sid });
      expect(at.snapshot.pendingPermissions, `${what}：快照里的待批卡`).toEqual([]);
      expect(at.snapshot.session, what).toEqual({ sessionId: sid, exists: false, messages: [] });
      expectNothingOf(at.snapshot, sid, what);
      expect((await b.call('permission.respond', { requestId: R, decision: 'allow-once' })).result, `${what}：答复不生效`).toMatchObject({ ok: true, applied: false });
      expect((await outcomesOf(b, [{ kind: 'permission', requestId: R }]))[0], what).toMatchObject({ kind: 'permission', requestId: R, status: 'settled', source: 'broker' });
      b.terminate();
    };
    await check('墓碑落地之后');
    if (sessionRow(engine.dataDir, sid) !== undefined) {
      await ok(q, 'chat.sessions.purgeRetained', { sessionId: sid, confirm: true });
      expect(sessionRow(engine.dataDir, sid)).toBeUndefined();
      await check('彻底删除保留副本之后');
    }
    expect(existsSync(file)).toBe(false);
    // 墓碑落地之后没有任何连接再经补发获得这张卡的答复资格
    expect(readAudit(engine.dataDir).filter(x => x.eventType === 'permission.redelivered')).toHaveLength(redeliveredBefore);
  }, 60_000);
});

describe('F06 × F11B × F08：新广播的入序与白名单', () => {
  it('X4 生命周期与检查点通知都入序；删除后检查点帧清空，生命周期仍回放，序号连续', async () => {
    const { engine } = await boot({ S1: writeStep('x4.txt') });
    const q = await wire(engine.port, engine.token);
    const first = await attach(q);
    const cursor = { epoch: first.epoch, instanceId: first.instanceId, lastSeq: first.lastSeq };
    const { sid } = await ranSession(q, 'S1', 'f06-x4-0001');
    await ok(q, 'chat.sessions.delete', { sessionId: sid, confirm: true });

    const live = q.notifications.filter(n => n.method === 'checkpoints.changed' || n.method === 'chat.sessions.lifecycle');
    expect(live.filter(n => n.method === 'checkpoints.changed').length).toBeGreaterThan(0);
    expect(live.filter(n => n.method === 'chat.sessions.lifecycle').map(n => [n.params.sessionId, n.params.kind, n.params.origin])).toEqual([[sid, 'deleted', 'local']]);
    for (const n of live) {
      expect(n.ev, `${n.method} 应带序号`).toMatchObject({ epoch: first.epoch });
      expect(Number.isSafeInteger(n.ev!.seq) && n.ev!.seq > cursor.lastSeq).toBe(true);
      expect(coveredBySnapshot(n.method!, n.params), `${n.method} 不在白名单里`).toBe(false);
    }
    // 全部入序帧的序号连续（没有哪条广播绕过了序号）
    const seqs = q.notifications.filter(n => n.ev !== undefined && n.ev.seq > cursor.lastSeq).map(n => n.ev!.seq);
    expect(seqs).toEqual(seqs.map((_, i) => cursor.lastSeq + 1 + i));

    // 删除后会话拥有的帧清空；生命周期仍原样回放，原检查点帧的序号不丢。
    const rs = await attach(q, { resume: cursor });
    expect(rs.mode).toBe('resume');
    const replayed = rs.events as WireFrame[];
    for (const n of live) {
      const got = replayed.find(f => f.ev!.seq === n.ev!.seq)!;
      expect(got).toBeDefined();
      expect([got.method, got.params]).toEqual(n.method === 'checkpoints.changed'
        ? ['state.redacted', {}] : [n.method, n.params]);
    }
    expect(replayed.map(f => f.ev!.seq)).toEqual(seqs);
    // 快照覆盖的域照旧在白名单里
    expect(coveredBySnapshot('chat.sessions.changed', {})).toBe(true);
  }, 60_000);
});

describe('F06 close: deleted-session replay in the real engine', () => {
  for (const remote of [false, true]) {
    it(`X6 ${remote ? 'retained remote tombstone' : 'local deletion'} removes old content without sequence gaps`, async () => {
      const secret = 'f06-x6-secret.txt';
      const { engine } = await boot({ S1: writeStep(secret) });
      const q = await wire(engine.port, engine.token);
      const first = await attach(q);
      const cursor = { epoch: first.epoch, instanceId: first.instanceId, lastSeq: first.lastSeq };
      const { sid } = await ranSession(q, 'S1', remote ? 'f06-x6-remote' : 'f06-x6-local');
      const before = await attach(q, { resume: cursor });
      expect(before.mode).toBe('resume');
      expect(JSON.stringify(before.events)).toContain(secret);
      if (remote) await pushTombstone(q, sid, 1, 'OP-X6', []);
      else await ok(q, 'chat.sessions.delete', { sessionId: sid, confirm: true });
      const result = await attach(q, { resume: cursor });
      expect(result.mode).toBe('resume');
      expect(JSON.stringify(result.events)).not.toContain(secret);
      expect(result.events.some((f: any) => f.method === 'state.redacted')).toBe(true);
      expect(result.events.map((f: any) => f.ev.seq)).toEqual(
        Array.from({ length: result.lastSeq - cursor.lastSeq }, (_, i) => cursor.lastSeq + i + 1));
      expect(result.events.some((f: any) => f.method === 'chat.sessions.lifecycle' && f.params.sessionId === sid)).toBe(true);
      if (remote) {
        await ok(q, 'chat.sessions.restore', { sessionId: sid, confirm: true });
        const restored = await attach(q, { sessionId: sid });
        expect(JSON.stringify(restored.snapshot.session.messages)).toContain(secret);
        const oldReplay = await attach(q, { resume: cursor });
        expect(JSON.stringify(oldReplay.events)).not.toContain(secret);
      }
    }, 60_000);
  }
});

describe('F06 × F11B × F08：启动次序与代次', () => {
  it('X5 源码守卫：生命周期自检 → 账本 → 检查点存储与对账 → 事件日志（代次取账本的）→ 启动恢复（带检查点给的文件事实）；recoveryDeps 只有一份', async () => {
    // 启动七步按全序发生，各一次；日志和恢复使用这台引擎的账本代次。
    const w = watchEngine();
    const { engine } = await boot({ Q20: [{ text: 'Q20 done' }] });
    const order = ['chat.repairLifecycle', 'new RunLedger', 'new CheckpointStore', 'checkpoints.reconcile', 'new EventLog', 'recoverOnBoot', 'rpc.listen'];
    expect(w.seq(order)).toEqual(order);
    for (const name of order)
      expect(w.count(name), name).toBe(1);
    const ledger = w.made('new RunLedger'), checkpoints = w.made('new CheckpointStore'), events = w.made('new EventLog');
    const recovery = w.args('recoverOnBoot')[0], c = await wire(engine.port, engine.token);
    expect(recovery.ledger).toBe(ledger);
    expect(w.args('new EventLog')[0].epoch).toBe(ledger.epoch);
    expect(w.args('createAttachHandler')[0].log).toBe(events);

    // 启动恢复交出去的文件事实回调，实际调用同一份检查点存储。
    const evidenceRow = { id: 'Q20-EVIDENCE', name: 'file_write', epoch: ledger.epoch };
    recovery.effectEvidence(evidenceRow);
    expect(w.spy('checkpoints.effectEvidence').mock.calls.at(-1)).toEqual([evidenceRow]);
    expect(w.spy('checkpoints.effectEvidence').mock.contexts.at(-1)).toBe(checkpoints);

    // 两次真实运行收尾复用同一个恢复依赖对象，与启动恢复共享四个字段。
    const sid = (await ok(c, 'chat.sessions.create', {})).id as string;
    await ok(c, 'chat.prompt', { sessionId: sid, text: '[[Q20]] Q20', promptId: 'q20-x5-0001' });
    await waitFor('Q20 run end', () => ended(runEventsOf(c, sid)), 10000);
    const settled = w.args('settleOpenBatches')[0];
    const other = (await ok(c, 'chat.sessions.create', {})).id as string;
    await ok(c, 'chat.prompt', { sessionId: other, text: '[[Q20]] again', promptId: 'q20-x5-0002' });
    await waitFor('second Q20 run end', () => ended(runEventsOf(c, other)), 10000);
    expect(w.count('settleOpenBatches')).toBe(2);

    expectSame(w.args('settleOpenBatches', 0)[0], w.args('settleOpenBatches', 1)[0]);
    for (const field of ['ledger', 'chat', 'audit', 'effectEvidence'])
      expect(settled[field], field).toBe(recovery[field]);
    const actualChat = w.args('createSyncMethods')[0] as ChatStore;
    const a = w.args('createAttachHandler')[0], b = w.args('createOutcomesHandler')[0];

    // 两个处理器每次都问引擎那份 ChatStore 的 isDeleted，实参和返回值原样传递。
    const checkDeleted = (sessionId: string, expected: boolean): void => {
      for (const deps of [a, b]) {
        const isDeleted = w.spy('chat.isDeleted');
        const from = callMark();
        const answer = deps.isSessionDeleted(sessionId);
        expect(w.count('chat.isDeleted', from)).toBe(1);
        expect(isDeleted.mock.calls.at(-1)).toEqual([sessionId]);
        expectSame(isDeleted.mock.contexts.at(-1), actualChat);
        expect(answer).toBe(isDeleted.mock.results.at(-1)?.value);
        expect(answer).toBe(expected);
      }
    };
    expect(a.chat).toBe(actualChat);
    checkDeleted(sid, false);
    checkDeleted('Q20-X5-NEVER-EXISTED', false);

    // 存活、删除、恢复依次改变同一判据，从未存在过的 id 仍不是已删除。
    await pushTombstone(c, sid, 1, 'Q20-DELETE', []);
    checkDeleted(sid, true);
    await ok(c, 'chat.sessions.restore', { sessionId: sid, confirm: true });
    checkDeleted(sid, false);
  }, 60000);

  it('X5b 带着保留副本的库上重启：新代次的快照仍不带它；事件的代次、快照的代次、账本的代次是同一个', async () => {
    const { engine } = await boot({ S1: writeStep('x5a.txt'), S2: [{ text: 'X5 完成' }] });
    const q = await wire(engine.port, engine.token);
    const kept = await ranSession(q, 'S1', 'f06-x5-0001');
    await pushTombstone(q, kept.sid, 1, 'OP-X5', []);
    const e1 = (await attach(q)).epoch as number;

    await engine.restart();
    const q2 = await wire(engine.port, engine.token);
    const at = await attach(q2, { sessionId: kept.sid });
    expect(at.epoch).toBe(e1 + 1);
    expect(at.snapshot.session).toEqual({ sessionId: kept.sid, exists: false, messages: [] });
    expectNothingOf(at.snapshot, kept.sid, '重启之后');

    const sid = (await ok(q2, 'chat.sessions.create', {})).id as string;
    await ok(q2, 'chat.prompt', { sessionId: sid, text: '[[S2]] 一句', promptId: 'f06-x5-0002' });
    await waitFor('回合结束', () => ended(runEventsOf(q2, sid)), 30_000);
    const frames = q2.notifications.filter(n => n.method === 'chat.event' && n.params?.sessionId === sid && n.params.event !== undefined);
    expect(new Set(frames.map(n => n.ev!.epoch))).toEqual(new Set([at.epoch]));
    expect(new Set(frames.map(n => n.params.run.epoch))).toEqual(new Set([at.epoch]));
    expect(runRows(engine.dataDir, sid).map(r => r.epoch)).toEqual([at.epoch]);
  }, 60_000);
});
