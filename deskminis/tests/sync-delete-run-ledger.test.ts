/** F11B × F05：会话删除（本机删除、对端墓碑、保留副本、显式恢复）与运行账本、启动恢复的交界。
 *
 *  F05 的 agent_runs / tool_executions 按会话归属。要钉住的口径：
 *   - 物理清会话（purgeSessionRows）时账本行同一事务清掉，任何一句失败整体回滚；
 *   - 保留副本（对端删除、本机留着内容）不清账本行：内容一行不动，显式恢复之后「第几次运行」接着数、旧的 promptId 仍去重；
 *   - 启动恢复遇到已删除的会话（保留副本、已清除却还留着账本行的）只关账，不补结果消息，不抛、不挡启动；
 *   - 登记与隐藏标记不一致的库，先自检再恢复（index.ts 的次序），恢复看到的是修好的状态；
 *   - 生产链路：已删除的会话（含保留副本）chat.prompt 被拒且不留 run 行，chat.runs.snapshot 不带出它的运行。
 *
 *  进程内崩溃模型沿用 F05 的夹具（run-recovery-fixture）：在故障点取库快照，再在副本上开新一代。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, AgentStreamEvent } from '../src/shared/types';
import type { AgentProvider, StreamRequest } from '../src/minisd/providers/types';
import { runAgentLoop } from '../src/minisd/agent/loop';
import { recoverOnBoot } from '../src/minisd/agent/run-recovery';
import { startMinisd } from '../src/minisd/index';
import { MinisPaths } from '../src/minisd/paths';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import type { WireLifecycle } from '../src/minisd/sync/wire';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ToolScheduler } from '../src/minisd/tools/scheduler';
import { ScriptProvider, allowAll, collect, gatedTool, toolTurn, withDeadline } from './scheduler-fixture';
import { assertPaired, eventsOf, readDb, rpcClient, waitFor, type Client } from './run-ledger-fixture';
import { HookTrace, execRows, ledgerEnv, openGeneration, resultsOf, runRows, startRun, type LedgerEnv } from './run-recovery-fixture';
import { watchEngine } from './engine-wiring';
import { callMark, yieldProbe } from './engine-trace';
import { expectSame } from './engine-trace';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

function tomb(v: number, opId: string, seenIds: string[] | undefined): WireLifecycle {
  const t: WireLifecycle = { v, opId, originDeviceId: 'devRemote', at: 1 };
  if (seenIds) t.seen = makeSeen(seenIds);
  return t;
}
const msgIds = (chat: ChatStore, sid: string): string[] => chat.listMessages(sid).map(m => m.id);
const lifecycleRow = (db: Database.Database, sid: string): Record<string, unknown> | undefined =>
  db.prepare('SELECT * FROM session_lifecycle WHERE session_id=?').get(sid) as Record<string, unknown> | undefined;
const sessionCount = (db: Database.Database, sid: string): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id=?').get(sid) as { c: number }).c;

/** 一次不带工具、已经跑完的运行（账本里一行 completed，历史里一条 user 消息）。 */
function completedRun(env: LedgerEnv, sid: string, promptId: string): string {
  const h = env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' }, promptId, promptDigest: 'D-' + promptId });
  h.started(() => env.store.appendMessage({
    id: env.store.newId(), sessionId: sid, role: 'user', parts: [{ type: 'text', value: promptId }], createdAt: env.store.nowEpoch(), streamInterruptCount: 0,
  }));
  h.end({ state: 'completed', reason: 'endTurn' });
  return h.ref.runId;
}

/** 一个会话 + 一个等同 shell 的工具（未声明调度 = 按有副作用处理）；跑完一轮带工具的运行。 */
async function sessionWithToolRun(label: string): Promise<{ env: LedgerEnv; sid: string }> {
  const env = ledgerEnv(label);
  cleanups.push(() => { try { env.db.close(); } catch { /* 已关 */ } });
  env.tools.register(gatedTool({ name: 'fx_shell', trace: new HookTrace() }));
  const sid = env.newSession();
  await withDeadline(startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'T', name: 'fx_shell', input: { tag: 'T' } }])])).done, 5000, label);
  return { env, sid };
}

function faultTrigger(db: Database.Database, table: string, op: 'INSERT' | 'UPDATE' | 'DELETE'): () => void {
  const name = `fault_${table}_${op}`;
  db.exec(`CREATE TEMP TRIGGER ${name} BEFORE ${op} ON main.${table} BEGIN SELECT RAISE(ABORT, 'inject'); END;`);
  return () => db.exec(`DROP TRIGGER ${name}`);
}

describe('X1 清会话时账本行同一事务清掉', () => {
  it('本机删除：两张账本表里这个会话 0 行，别的会话与引擎代次不动', async () => {
    const { env, sid } = await sessionWithToolRun('x1a');
    const keep = env.newSession();
    completedRun(env, keep, 'keep-1');
    expect(runRows(env.db, sid)).toHaveLength(1);
    expect(execRows(env.db, sid)).toHaveLength(1);
    const instances = JSON.stringify(env.db.prepare('SELECT * FROM engine_instances').all());

    expect(env.store.deleteSession(sid).kind).toBe('deleted');
    expect(runRows(env.db, sid)).toEqual([]);
    expect(execRows(env.db, sid)).toEqual([]);
    expect(runRows(env.db, keep)).toMatchObject([{ state: 'completed', prompt_id: 'keep-1' }]);
    expect(JSON.stringify(env.db.prepare('SELECT * FROM engine_instances').all())).toBe(instances);
  });

  it.each(['agent_runs', 'tool_executions'] as const)('清 %s 的那一句失败：整体回滚——会话、消息、账本行都在，也没有留下墓碑', async table => {
    const { env, sid } = await sessionWithToolRun('x1b');
    const before = { msgs: msgIds(env.store, sid), runs: JSON.stringify(runRows(env.db, sid)), execs: JSON.stringify(execRows(env.db, sid)) };
    const drop = faultTrigger(env.db, table, 'DELETE');
    expect(() => env.store.deleteSession(sid)).toThrow(/inject/);
    expect(sessionCount(env.db, sid)).toBe(1);
    expect(env.store.getSession(sid)).toBeDefined();
    expect(msgIds(env.store, sid)).toEqual(before.msgs);
    expect(JSON.stringify(runRows(env.db, sid))).toBe(before.runs);
    expect(JSON.stringify(execRows(env.db, sid))).toBe(before.execs);
    expect(lifecycleRow(env.db, sid)).toBeUndefined();
    drop();
    expect(env.store.deleteSession(sid).kind).toBe('deleted');
    expect(runRows(env.db, sid)).toEqual([]);
    expect(execRows(env.db, sid)).toEqual([]);
  });

  it('对端墓碑覆盖本机全部消息（清除）：账本行一并清掉', async () => {
    const { env, sid } = await sessionWithToolRun('x1c');
    expect(env.store.applyTombstone(sid, tomb(1, 'OP-A', msgIds(env.store, sid)), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', retained: false });
    expect(sessionCount(env.db, sid)).toBe(0);
    expect(runRows(env.db, sid)).toEqual([]);
    expect(execRows(env.db, sid)).toEqual([]);
  });

  it('这个 id 名下只剩账本行（对着不存在的会话起过 run、起跑前就结束）：删除把它们清掉，不为它造墓碑', () => {
    const env = ledgerEnv('x1d');
    cleanups.push(() => { try { env.db.close(); } catch { /* 已关 */ } });
    const ghost = 'GHOST-0001';
    env.ledger.beginRun({ sessionId: ghost, origin: { kind: 'user' } }).end({ state: 'failed', reason: 'start-failed' });
    expect(runRows(env.db, ghost)).toHaveLength(1);
    expect(env.store.deleteSession(ghost)).toEqual({ kind: 'absent' });
    expect(runRows(env.db, ghost)).toEqual([]);
    // 没有会话内容被删，就没有需要传播的删除
    expect(lifecycleRow(env.db, ghost)).toBeUndefined();
  });
});

describe('X2 保留副本不清账本行；显式恢复之后账本自洽', () => {
  it('保留 → 账本行逐字段不变；恢复 → 下一次运行接着数、旧 promptId 仍去重；彻底删除 → 一并清掉', async () => {
    const { env, sid } = await sessionWithToolRun('x2');
    const first = completedRun(env, sid, 'p-1');
    const rowsBefore = { runs: JSON.stringify(runRows(env.db, sid)), execs: JSON.stringify(execRows(env.db, sid)) };
    expect(runRows(env.db, sid)).toHaveLength(2);
    const ids = msgIds(env.store, sid);

    // 删除方只见过第一条：本机保留副本
    expect(env.store.applyTombstone(sid, tomb(1, 'OP-A', ids.slice(0, 1)), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', retained: true });
    expect(env.store.getSession(sid)).toBeUndefined();
    expect(msgIds(env.store, sid)).toEqual(ids);
    expect(JSON.stringify(runRows(env.db, sid))).toBe(rowsBefore.runs);
    expect(JSON.stringify(execRows(env.db, sid))).toBe(rowsBefore.execs);

    // 显式恢复：账本行还是那些；同一个 promptId 仍然查得到原来那次运行；新运行是第 3 次
    env.store.restoreSession(sid);
    expect(JSON.stringify(runRows(env.db, sid))).toBe(rowsBefore.runs);
    expect(env.ledger.findByPrompt(sid, 'p-1')?.run).toMatchObject({ runId: first, state: 'completed', generation: 2 });
    const next = env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' }, promptId: 'p-2', promptDigest: 'D' });
    expect(next.ref.generation).toBe(3);
    next.end({ state: 'failed', reason: 'start-failed' });

    // 再被删一次并保留，然后彻底删除保留副本：内容与账本行一起清
    expect(env.store.applyTombstone(sid, tomb(3, 'OP-B', []), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', retained: true });
    expect(runRows(env.db, sid)).toHaveLength(3);
    expect(env.store.deleteSession(sid).kind).toBe('purged');
    expect(runRows(env.db, sid)).toEqual([]);
    expect(execRows(env.db, sid)).toEqual([]);
    expect(lifecycleRow(env.db, sid)).toMatchObject({ version: 3, op_id: 'OP-B' });
  });
});

// ---------- 启动恢复 ----------

/** 记下每次请求的 messages、只回一段文本的 provider。 */
class CaptureProvider implements AgentProvider {
  readonly name = 'f11b-capture'; readonly modelId = 'fake';
  readonly requests: AgentMessage[][] = [];
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    this.requests.push(req.messages);
    yield { kind: 'textDelta', text: '好的' };
    yield { kind: 'done', stopReason: 'endTurn' };
  }
}

/** 工具进门那一刻取库快照：盘上是一个活动的 run、一批没交付的调用（执行意图已落账）、assistant 是最后一条消息。 */
async function crashedMidTool(label: string): Promise<{ snap: string; sid: string; root: string }> {
  const env = ledgerEnv(label);
  cleanups.push(() => { try { env.db.close(); } catch { /* 已关 */ } });
  const trace = new HookTrace();
  env.tools.register(gatedTool({ name: 'fx_shell', trace }));
  const sid = env.newSession();
  let snap = '';
  trace.on('T:enter', () => { snap = env.snapshot(); });
  await withDeadline(startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'T', name: 'fx_shell', input: { tag: 'T' } }])])).done, 5000, label);
  expect(snap).not.toBe('');
  return { snap, sid, root: env.root };
}

describe('X3 启动恢复遇到已删除的会话：只关账，不补消息，不抛', () => {
  it('保留副本：那一批只关账（superseded），消息一条不多；run 记为中断；恢复之后会话不被陈旧行占着，请求侧配对成立', async () => {
    const { snap, sid, root } = await crashedMidTool('x3a');
    const g = openGeneration(snap);
    cleanups.push(() => { try { g.db.close(); } catch { /* 已关 */ } });
    const before = msgIds(g.chat, sid);
    expect(before).toHaveLength(2);
    // 删除方什么都没见过：本机留副本
    expect(g.chat.applyTombstone(sid, tomb(1, 'OP-A', []), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', retained: true });
    expect(runRows(g.db, sid)).toMatchObject([{ active: 1 }]);

    const report = recoverOnBoot(g.deps);
    expect(report.failed).toEqual([]);
    expect(g.warns).toEqual([]);
    expect(report.sessions).toEqual([]);
    expect(report.batches).toMatchObject([{ sessionId: sid, superseded: true }]);
    expect(report.batches[0].resultMessageId).toBeUndefined();
    expect(msgIds(g.chat, sid)).toEqual(before);
    expect(resultsOf(g.chat, sid)).toEqual([]);
    const execs = execRows(g.db, sid);
    expect(execs).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown', result_message_id: null }]);
    expect(execs[0].delivered_at).not.toBeNull();
    expect(runRows(g.db, sid)).toMatchObject([{ state: 'interrupted', active: null, stop_reason: 'engine-crash' }]);
    expect(g.chat.listRetainedSessions().map(r => r.id)).toEqual([sid]);
    expect(lifecycleRow(g.db, sid)).toMatchObject({ version: 1, op_id: 'OP-A' });

    // 显式恢复之后接着提问：那次没有结果的调用由请求侧补占位，发给模型的消息仍然严格配对；下一次运行是第 2 次
    g.chat.restoreSession(sid);
    const h = g.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
    expect(h.ref.generation).toBe(2);
    const last = g.chat.lastMessageRef(sid)!;
    h.started(() => g.chat.appendMessage({
      id: g.chat.newId(), sessionId: sid, role: 'user', parts: [{ type: 'text', value: '继续' }],
      createdAt: Math.max(g.chat.nowEpoch(), last.createdAt + 0.001), streamInterruptCount: 0,
    }));
    const provider = new CaptureProvider();
    const tools = new ToolRegistry();
    const events = await withDeadline(collect(runAgentLoop(g.chat, {
      sessionId: sid, provider, tools, systemPrompt: 'sys', scheduler: new ToolScheduler(),
      toolContext: { sessionId: sid, paths: new MinisPaths(root), permissions: allowAll },
    })), 5000, '恢复后的下一轮');
    h.end({ state: 'completed', reason: 'endTurn' });
    expect(events.some(e => e.kind === 'turnEnd')).toBe(true);
    expect(provider.requests).toHaveLength(1);
    assertPaired(provider.requests[0]);
  });

  it('会话已清除、账本行却还在（旧数据）：不抛、不补消息、不建会话行；账关掉，run 记为中断', async () => {
    const { snap, sid } = await crashedMidTool('x3b');
    const g = openGeneration(snap);
    cleanups.push(() => { try { g.db.close(); } catch { /* 已关 */ } });
    const runs = runRows(g.db, sid) as Record<string, unknown>[];
    const execs = execRows(g.db, sid) as Record<string, unknown>[];
    expect(g.chat.applyTombstone(sid, tomb(1, 'OP-A', msgIds(g.chat, sid)), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', retained: false });
    expect(runRows(g.db, sid)).toEqual([]);
    // 把账本行按原样放回去：模拟「会话已清除、它名下还留着没收口的运行」
    const put = (table: string, row: Record<string, unknown>): void => {
      const cols = Object.keys(row);
      g.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]));
    };
    for (const r of runs) put('agent_runs', r);
    for (const r of execs) put('tool_executions', r);

    const report = recoverOnBoot(g.deps);
    expect(report.failed).toEqual([]);
    expect(report.sessions).toEqual([]);
    expect(report.batches).toMatchObject([{ sessionId: sid, superseded: true }]);
    expect(g.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get(sid)).toEqual({ c: 0 });
    expect(sessionCount(g.db, sid)).toBe(0);
    expect(execRows(g.db, sid)[0].delivered_at).not.toBeNull();
    expect(runRows(g.db, sid)).toMatchObject([{ state: 'interrupted', active: null }]);
    expect(lifecycleRow(g.db, sid)).toMatchObject({ version: 1 });
  });

  it('登记是已删除、会话行却没打隐藏标记（不一致的库）：恢复补不进消息也照常返回；先自检再恢复则按保留副本只关账', async () => {
    const { snap, sid } = await crashedMidTool('x3c');
    const g = openGeneration(snap);
    cleanups.push(() => { try { g.db.close(); } catch { /* 已关 */ } });
    const before = msgIds(g.chat, sid);
    g.db.prepare(`INSERT INTO session_lifecycle (session_id, version, op_id, origin_device_id, origin_at, recorded_at) VALUES (?, 1, 'OP-X', 'devRemote', 1, 1)`).run(sid);

    // 不先自检：恢复看得到会话行，想补结果消息——存储层拒写，那一批原样留着，恢复照常返回
    const r1 = recoverOnBoot(g.deps);
    expect(r1.failed).toHaveLength(1);
    expect(r1.failed[0].error).toContain('会话已删除');
    expect(msgIds(g.chat, sid)).toEqual(before);
    expect(execRows(g.db, sid)[0].delivered_at).toBeNull();
    expect(runRows(g.db, sid)).toMatchObject([{ state: 'interrupted', active: null }]);

    // 自检把它按保留副本隐藏之后：只关账，不补消息
    expect(g.chat.repairLifecycle()).toEqual({ unhidden: 0, hidden: 1 });
    const r2 = recoverOnBoot(g.deps);
    expect(r2.failed).toEqual([]);
    expect(r2.batches).toMatchObject([{ sessionId: sid, superseded: true }]);
    expect(msgIds(g.chat, sid)).toEqual(before);
    expect(execRows(g.db, sid)[0].delivered_at).not.toBeNull();
  });
});

// ---------- 生产链路：在崩溃快照上起真实的引擎 ----------

/** 把库快照放进一个新的数据根，起引擎之前可以先改库（造保留副本、造不一致）。 */
async function bootOn(snapshot: string, prepare: (db: Database.Database, chat: ChatStore) => void): Promise<{ dataDir: string; c: Client }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-f11b-x4-'));
  copyFileSync(snapshot, join(dataDir, 'minis.db'));
  const db = openDb(join(dataDir, 'minis.db'));
  try { prepare(db, new ChatStore(db)); } finally { db.close(); }
  writeFileSync(join(dataDir, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }), 'utf8');
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ host: '127.0.0.1', port: 0, permTimeoutMs: 60000, dataDir });
  cleanups.push(() => srv.close());
  const c = rpcClient(srv.port, srv.authToken);
  await c.ready;
  cleanups.push(() => c.close());
  return { dataDir, c };
}
const call = async (c: Client, method: string, params?: unknown): Promise<any> => {
  const r = await c.call(method, params);
  if (r.error) throw new Error(String(r.error.message ?? JSON.stringify(r.error)));
  return r.result;
};
const dbRuns = (dataDir: string, sid: string): any[] => readDb(dataDir, 'SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation', sid);
const dbExecs = (dataDir: string, sid: string): any[] => readDb(dataDir, 'SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sid);
const dbMsgIds = (dataDir: string, sid: string): string[] =>
  (readDb(dataDir, 'SELECT id FROM messages WHERE session_id=? ORDER BY created_at, id', sid) as { id: string }[]).map(r => r.id);
const toolResultsOf = (dataDir: string, sid: string): unknown[] =>
  (readDb(dataDir, 'SELECT parts_json FROM messages WHERE session_id=?', sid) as { parts_json: string }[])
    .flatMap(r => JSON.parse(r.parts_json) as { type: string }[]).filter(p => p.type === 'toolResult');

describe('X4 引擎在带着保留副本的库上启动（生产链路）', () => {
  it('启动成功；保留副本不被补消息、账关掉；它的运行不出现在快照里，对它提问被拒且不留 run 行；恢复之后一切接上', async () => {
    const { snap, sid } = await crashedMidTool('x4a');
    const { dataDir, c } = await bootOn(snap, (_db, chat) => {
      expect(chat.applyTombstone(sid, tomb(1, 'OP-A', []), { fromPeer: 'peer' })).toMatchObject({ retained: true });
    });
    const before = dbMsgIds(dataDir, sid);
    expect(before).toHaveLength(2);

    // 启动恢复：只关账
    expect(toolResultsOf(dataDir, sid)).toEqual([]);
    expect(dbExecs(dataDir, sid)).toMatchObject([{ state: 'unknown', result_message_id: null }]);
    expect(dbExecs(dataDir, sid)[0].delivered_at).not.toBeNull();
    expect(dbRuns(dataDir, sid)).toMatchObject([{ state: 'interrupted', active: null, generation: 1 }]);
    const runId = dbRuns(dataDir, sid)[0].id as string;
    // 不在会话列表里，在保留列表里
    expect((await call(c, 'chat.sessions.list')).map((s: { id: string }) => s.id)).not.toContain(sid);
    expect((await call(c, 'chat.sessions.listRetained', {})).map((s: { id: string }) => s.id)).toEqual([sid]);

    // 已删除的会话不显示：按会话、按 runId 取快照都不带出它的运行与工具执行
    for (const q of [{ sessionId: sid }, { runId }, { sessionId: sid, runId }]) {
      const snapNow = await call(c, 'chat.runs.snapshot', q);
      expect(snapNow.runs.filter((r: { sessionId: string }) => r.sessionId === sid), JSON.stringify(q)).toEqual([]);
      expect(snapNow.executions.filter((x: { sessionId: string }) => x.sessionId === sid), JSON.stringify(q)).toEqual([]);
    }
    // 已删除的会话拒写：不起 run、不留 run 行、消息不变
    await expect(call(c, 'chat.prompt', { sessionId: sid, providerId: '__fake__', text: '还在吗', promptId: 'x4-0001' })).rejects.toThrow(/会话已删除/);
    await expect(call(c, 'chat.prompt', { sessionId: sid, providerId: '__fake__', text: '还在吗' })).rejects.toThrow(/会话已删除/);
    expect(dbRuns(dataDir, sid)).toHaveLength(1);
    expect(dbMsgIds(dataDir, sid)).toEqual(before);

    // 显式恢复：重新出现在列表与快照里；接着提问是第 2 次运行；那次被打断的调用没有被补结果（请求侧占位）
    expect(await call(c, 'chat.sessions.restore', { sessionId: sid, confirm: true })).toEqual({ ok: true });
    expect((await call(c, 'chat.sessions.list')).map((s: { id: string }) => s.id)).toContain(sid);
    expect((await call(c, 'chat.runs.snapshot', { sessionId: sid })).runs).toMatchObject([{ runId, sessionId: sid, state: 'interrupted', generation: 1 }]);
    expect(await call(c, 'chat.prompt', { sessionId: sid, providerId: '__fake__', text: '恢复之后', promptId: 'x4-0001' }))
      .toMatchObject({ ok: true, generation: 2, duplicate: false });
    await waitFor('恢复之后的一轮跑完', () => eventsOf(c, sid).some(e => e.kind === 'turnEnd'));
    expect(dbRuns(dataDir, sid).map(r => [r.generation, r.state])).toEqual([[1, 'interrupted'], [2, 'completed']]);
    expect(toolResultsOf(dataDir, sid)).toEqual([]);
    expect(dbMsgIds(dataDir, sid).slice(0, 2)).toEqual(before);
  }, 30000);

  it('登记与隐藏标记不一致的库：自检排在启动恢复之前——第一次启动就按保留副本关账，不留一批每次启动都失败的调用', async () => {
    const { snap, sid } = await crashedMidTool('x4b');
    const { dataDir, c } = await bootOn(snap, db => {
      db.prepare(`INSERT INTO session_lifecycle (session_id, version, op_id, origin_device_id, origin_at, recorded_at) VALUES (?, 1, 'OP-X', 'devRemote', 1, 1)`).run(sid);
    });
    expect((await call(c, 'chat.sessions.listRetained', {})).map((s: { id: string }) => s.id)).toEqual([sid]);
    expect(toolResultsOf(dataDir, sid)).toEqual([]);
    expect(dbMsgIds(dataDir, sid)).toHaveLength(2);
    expect(dbExecs(dataDir, sid)[0].delivered_at).not.toBeNull();
    expect(dbRuns(dataDir, sid)).toMatchObject([{ state: 'interrupted', active: null }]);
  }, 30000);
});

describe('X5 接线（在真实引擎上观察调用的先后与结果）', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** 带着一个保留副本（名下有一次被打断的运行和一条工具执行记录）的库上起引擎。 */
  async function withRetained(label: string): Promise<{ dataDir: string; c: Client; sid: string; from: number }> {
    const { snap, sid } = await crashedMidTool(label);
    const from = callMark(); // 之后才是引擎自己的调用（上面造崩溃现场的夹具也开过账本）
    const { dataDir, c } = await bootOn(snap, (_db, chat) => {
      expect(chat.applyTombstone(sid, tomb(1, 'OP-X5', []), { fromPeer: 'peer' })).toMatchObject({ retained: true });
    });
    return { dataDir, c, sid, from };
  }

  it('chat.prompt：已删除的会话在幂等检查与占用 run 之前就被拒（之间没有 await）', async () => {
    const w = watchEngine();
    const { c, sid } = await withRetained('x5a');
    const ledger = w.made<{ findByPrompt(sid: string, promptId: string): unknown }>('new RunLedger');

    // 存活的会话：删除闸（chat.isDeleted）→ 幂等检查（findByPrompt）→ 占 run（beginRun），三步之间执行权没有让出去过
    const gateToCheck = yieldProbe(w.spy('chat.isDeleted'), w.spy('ledger.findByPrompt'));
    const checkToBegin = yieldProbe(w.spy('ledger.findByPrompt'), w.spy('ledger.beginRun'));
    const live = (await call(c, 'chat.sessions.create', {})).id as string;
    let from = callMark();
    expect(await call(c, 'chat.prompt', { sessionId: live, providerId: '__fake__', text: '你好', promptId: 'x5-live-0001' })).toMatchObject({ ok: true, duplicate: false });
    await waitFor('回合跑完', () => eventsOf(c, live).some(e => e.kind === 'turnEnd'));
    const order = w.seq(['chat.isDeleted', 'ledger.findByPrompt', 'ledger.beginRun'], from);
    const iCheck = order.indexOf('ledger.findByPrompt');
    expect(order[iCheck - 1]).toBe('chat.isDeleted');
    expect(order.indexOf('ledger.beginRun')).toBeGreaterThan(iCheck);
    expect(order.slice(iCheck - 1, order.indexOf('ledger.beginRun') + 1)).toEqual(['chat.isDeleted', 'ledger.findByPrompt', 'chat.isDeleted', 'ledger.beginRun']);
    expect(gateToCheck).toEqual([false]);
    expect(checkToBegin).toEqual([false]);

    // 这次运行落成保留副本之后（账本行与用过的 promptId 都还在）：重发同一个 promptId 得到的是「会话已删除」而不是 duplicate，
    // 而且在闸上就被拒——幂等检查与占 run 都没有走到
    await call(c, 'sync.push', { sessionId: live, payload: { messages: [], markers: [], lifecycle: tomb(1, 'OP-X5-LIVE', []) } });
    expect((await call(c, 'chat.sessions.listRetained', {})).map((s: { id: string }) => s.id)).toContain(live);
    expect(ledger.findByPrompt(live, 'x5-live-0001')).toBeDefined();
    from = callMark();
    await expect(call(c, 'chat.prompt', { sessionId: live, providerId: '__fake__', text: '你好', promptId: 'x5-live-0001' })).rejects.toThrow(/会话已删除/);
    await expect(call(c, 'chat.prompt', { sessionId: sid, providerId: '__fake__', text: '还在吗', promptId: 'x5-0002' })).rejects.toThrow(/会话已删除/);
    expect(w.count('ledger.findByPrompt', from)).toBe(0);
    expect(w.count('ledger.beginRun', from)).toBe(0);
  }, 30000);

  it('启动次序：生命周期自检在开账本与启动恢复之前，只调一次', async () => {
    const w = watchEngine();
    const { from } = await withRetained('x5b');
    expect(w.count('chat.repairLifecycle', from)).toBe(1);
    expect(w.seq(['chat.repairLifecycle', 'new RunLedger', 'recoverOnBoot'], from)).toEqual(['chat.repairLifecycle', 'new RunLedger', 'recoverOnBoot']);
    const constructorFrom = w.spy('new ChatStore').mock.invocationCallOrder.at(-1)! - 1;
    expect(w.seq(['new ChatStore', 'chat.repairLifecycle', 'new RunLedger', 'recoverOnBoot'], constructorFrom)).toEqual(['new ChatStore', 'chat.repairLifecycle', 'new RunLedger', 'recoverOnBoot']);
    // 自检修的、恢复读的是同一个会话库
    expect(w.spy('chat.repairLifecycle').mock.contexts.at(-1)).toBe(w.args('recoverOnBoot')[0].chat);
  }, 30000);

  it('chat.runs.snapshot 的处理器按 chat.isDeleted 过滤运行与工具执行', async () => {
    const w = watchEngine();
    const { c, sid } = await withRetained('x5c');
    const ledger = w.made<{ snapshot(q: { sessionId?: string }): { runs: { sessionId: string }[]; executions: { sessionId: string }[] } }>('new RunLedger');
    // 账本里这个保留副本的运行与工具执行都还在（显式恢复之后要用）
    const raw = ledger.snapshot({ sessionId: sid });
    expect(raw.runs.filter(r => r.sessionId === sid)).toHaveLength(1);
    expect(raw.executions.filter(x => x.sessionId === sid)).toHaveLength(1);
    // 经 RPC 取的快照取自账本，但已删除会话的运行与工具执行都滤掉了
    const from = callMark();
    const chat = w.made('new ChatStore');
    const viaRpc = await call(c, 'chat.runs.snapshot', { sessionId: sid });
    expect(w.count('ledger.snapshot', from)).toBe(1);
    expect(w.args('ledger.snapshot')).toEqual([{ sessionId: sid }]);
    expectSame(w.spy('ledger.snapshot').mock.contexts.at(-1), ledger);
    expect(viaRpc).toEqual({ ...w.spy('ledger.snapshot').mock.results.at(-1)?.value, runs: [], executions: [] });
    expect(w.count('chat.isDeleted', from)).toBe(2);
    expect(w.spy('chat.isDeleted').mock.calls.slice(-2)).toEqual([[sid], [sid]]);
    expect(w.spy('chat.isDeleted').mock.contexts.slice(-2).every(context => context === chat)).toBe(true);
    for (const context of w.spy('chat.isDeleted').mock.contexts.slice(-2)) expect(context).toBe(chat);
    expect(w.spy('chat.isDeleted').mock.results.slice(-2).map(r => r.value)).toEqual([true, true]);
    expect(viaRpc.runs.filter((r: { sessionId: string }) => r.sessionId === sid)).toEqual([]);
    expect(viaRpc.executions.filter((x: { sessionId: string }) => x.sessionId === sid)).toEqual([]);
    expect(w.count('chat.isDeleted', from)).toBeGreaterThan(0);
    // 判据就是 chat.isDeleted：显式恢复之后同一个调用把它们带出来，与账本里的一致
    expect(await call(c, 'chat.sessions.restore', { sessionId: sid, confirm: true })).toEqual({ ok: true });
    const restored = await call(c, 'chat.runs.snapshot', { sessionId: sid });
    expect(restored.runs.filter((r: { sessionId: string }) => r.sessionId === sid)).toHaveLength(1);
    expect(restored.executions.filter((x: { sessionId: string }) => x.sessionId === sid)).toHaveLength(1);
  }, 30000);
});
