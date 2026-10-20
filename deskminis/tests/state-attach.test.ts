/**
 * F06：state.attach / state.outcomes 处理器的判定表（src/minisd/state-attach.ts）。
 *
 * 真实引擎上的行为在 state-sync-minisd / state-sync-outcomes；这里用桩依赖把每条判定分支各走一遍，
 * 包括真实引擎上不好造的几种（回放过大、取状态中途抛错、账本里各种审批终态、经桥发起的卡在引擎重启后）。
 * 账本与 broker 用真实的类（临时库），其余是记录调用顺序的桩。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/minisd/store/db';
import { RunLedger } from '../src/minisd/store/run-ledger';
import { PermissionBroker } from '../src/minisd/tools/permission-broker';
import { EventLog, RESUME_MAX_CHARS } from '../src/minisd/rpc/event-log';
import { LiveTails } from '../src/minisd/agent/live-tails';
import { createAttachHandler, createOutcomesHandler, type AttachDeps } from '../src/minisd/state-attach';
import type { RpcConnection } from '../src/minisd/rpc/server';
import type { RunView, ToolExecutionView } from '../src/shared/run';
import type { PendingPermissionView } from '../src/shared/event-stream';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) { try { f(); } catch { /* 收尾尽力 */ } } });

const INST = 'INST-1';
const SID = '11111111-2222-3333-4444-555555555555';
const runView = (o: Partial<RunView> & { runId: string }): RunView => ({
  sessionId: SID, generation: 1, epoch: 3, state: 'running', step: 'model', toolBatches: 0, origin: { kind: 'user' }, createdAt: 1, updatedAt: 1, ...o,
});
const execView = (o: Partial<ToolExecutionView> & { id: string; runId: string }): ToolExecutionView => ({
  sessionId: SID, epoch: 3, batch: 1, index: 0, toolUseId: `tu-${o.id}`, name: 'file_write', assistantMessageId: 'm', state: 'completed', started: true,
  delivered: true, artifacts: { writePaths: [] }, createdAt: 1, updatedAt: 1, ...o,
});
const conn = (seq: number, authMode: 'local' | 'remote' = 'local'): RpcConnection => ({ notify: () => undefined, authMode, seq });

/** 桩依赖：记下调用顺序；log 用真实的 EventLog（代次 3）。 */
function rig(over: Partial<AttachDeps> = {}, logOpts: { maxEvents?: number } = {}) {
  const calls: string[] = [];
  const tails = new LiveTails();
  const log = new EventLog({ epoch: 3, ...logOpts, onAppend: (m, p, s) => tails.observe(m, p, s) });
  const runs: RunView[] = [];
  const executions: ToolExecutionView[] = [];
  const byRun = new Map<string, ToolExecutionView[]>();
  const cards: PendingPermissionView[] = [];
  let revision = 100;
  const deps: AttachDeps = {
    log, instanceId: INST, tails,
    ledger: {
      snapshot: q => { calls.push(`snapshot:${q?.sessionId ?? ''}`); return { epoch: 3, instanceId: INST, heartbeatAt: 0, takenAt: 0, runs: [...runs], executions: [...executions] }; },
      listExecutions: id => { calls.push(`listExecutions:${id}`); return byRun.get(id) ?? []; },
    },
    chat: {
      listSessions: () => { calls.push('listSessions'); return [{ id: SID, title: 't', createdAt: 1, updatedAt: 1 }]; },
      getSession: id => (id === SID ? { id: SID, title: 't', createdAt: 1, updatedAt: 1 } : undefined),
      listMessages: id => { calls.push(`listMessages:${id}`); return [{ id: 'M1', sessionId: id, role: 'user', parts: [{ type: 'text', value: 'hi' }], createdAt: 1, updatedAt: 1, sortOrder: 1, streamInterruptCount: 0 }]; },
    },
    broker: { deliver: to => { calls.push(`deliver:${to?.via ?? '-'}:${to?.seq ?? '-'}`); revision += 1; return cards.map(c => ({ ...c })); } },
    revision: () => { calls.push('revision'); return revision; },
    now: () => 7777,
    ...over,
  };
  return { deps, attach: createAttachHandler(deps), log, tails, calls, runs, executions, byRun, cards };
}

describe('F06 close: deleted-session replay', () => {
  it('redacts late content for deleted sessions while preserving every sequence and lifecycle notice', () => {
    const deleted = new Set([SID]);
    const r = rig({ isSessionDeleted: id => deleted.has(id) });
    r.log.append('chat.event', { sessionId: SID, event: { kind: 'textDelta', text: 'SECRET' } });
    r.log.append('permission.request', { requestId: 'R', req: { sessionId: SID, preview: { oldText: 'SECRET' } } });
    r.log.append('chat.sessions.lifecycle', { sessionId: SID, kind: 'deleted' });
    r.log.append('chat.event', { sessionId: 'other', event: { kind: 'textDelta', text: 'visible' } });
    const result = r.attach({ resume: { epoch: 3, instanceId: INST, lastSeq: 0 } });
    expect(result.mode).toBe('resume');
    if (result.mode !== 'resume') throw new Error('expected replay');
    expect(result.events.map(f => f.ev.seq)).toEqual([1, 2, 3, 4]);
    expect(result.events.slice(0, 2).map(f => [f.method, f.params])).toEqual([['state.redacted', {}], ['state.redacted', {}]]);
    expect(result.events[2].method).toBe('chat.sessions.lifecycle');
    expect(result.events[3].params).toMatchObject({ sessionId: 'other' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('F06 state.attach 的判定表', () => {
  it('没带游标 / 游标形状不对 → 快照 no-cursor；头部字段齐全；快照里的值来自同一次调用', () => {
    const r = rig();
    for (let i = 0; i < 3; i++) r.log.append('x.changed', { i });
    for (const p of [undefined, {}, { resume: undefined }, { resume: null }, { resume: { epoch: 3, instanceId: INST } }, { resume: { epoch: '3', instanceId: INST, lastSeq: 1 } },
      { resume: { epoch: 3, instanceId: 5, lastSeq: 1 } }, { resume: { epoch: 3, instanceId: INST, lastSeq: -1 } }, { resume: { epoch: 3, instanceId: INST, lastSeq: 0.5 } },
      { resume: { epoch: 3, instanceId: INST, lastSeq: Number.MAX_SAFE_INTEGER + 1 } }]) {
      const out = r.attach(p as never);
      expect(out.mode).toBe('snapshot');
      if (out.mode !== 'snapshot') continue;
      expect(out.reason).toBe('no-cursor');
      expect(out).toMatchObject({ protocol: 1, epoch: 3, instanceId: INST, lastSeq: 3, window: { firstSeq: 1, maxEvents: 8192, maxChars: 8_000_000 } });
      expect(out.snapshot).toMatchObject({ epoch: 3, instanceId: INST, lastSeq: 3, takenAt: 7777, revision: out.revision, live: [], artifacts: [], pendingPermissions: [] });
      expect(out.snapshot.session).toBeUndefined();
    }
  });

  it('代次或实例变了 → epoch-changed；游标超前 → ahead；窗口盖不住 → window-expired；回放超过上限 → replay-too-large；否则续传', () => {
    const r = rig({}, { maxEvents: 4 });
    for (let i = 1; i <= 10; i++) r.log.append('x.changed', { i });
    const at = (lastSeq: number, epoch = 3, instanceId = INST) => r.attach({ resume: { epoch, instanceId, lastSeq } });
    expect(at(10, 2)).toMatchObject({ mode: 'snapshot', reason: 'epoch-changed' });
    expect(at(10, 4)).toMatchObject({ mode: 'snapshot', reason: 'epoch-changed' });
    expect(at(10, 3, 'INST-2')).toMatchObject({ mode: 'snapshot', reason: 'epoch-changed' });
    expect(at(11)).toMatchObject({ mode: 'snapshot', reason: 'ahead' });
    expect(at(5)).toMatchObject({ mode: 'snapshot', reason: 'window-expired' });
    const edge = at(6);
    expect(edge.mode).toBe('resume');
    if (edge.mode === 'resume') {
      expect(edge.events.map(e => e.ev.seq)).toEqual([7, 8, 9, 10]);
      expect(edge.events.map(e => (e.params as { i: number }).i)).toEqual([7, 8, 9, 10]);
      expect(edge).toMatchObject({ lastSeq: 10, window: { firstSeq: 7, maxEvents: 4 } });
    }
    expect(at(10)).toMatchObject({ mode: 'resume', events: [] });

    // 回放过大：窗口里留得住，但一次续传不回这么多
    const big = rig();
    big.log.append('a', {});
    big.log.append('chat.event', { blob: 'x'.repeat(RESUME_MAX_CHARS) });
    big.log.append('b', {});
    const tooLarge = big.attach({ resume: { epoch: 3, instanceId: INST, lastSeq: 1 } });
    expect(tooLarge).toMatchObject({ mode: 'snapshot', reason: 'replay-too-large', lastSeq: 3 });
    expect(big.attach({ resume: { epoch: 3, instanceId: INST, lastSeq: 2 } })).toMatchObject({ mode: 'resume' });
  });

  it('两种应答都把调用连接交给 broker.deliver，并带回它给的卡；revision 取在 deliver 之后；进程内调用（没有 conn）也照取', () => {
    const r = rig();
    r.log.append('x.changed', {});
    r.cards.push({ requestId: 'R1', req: { sessionId: SID, kind: 'file-write', detail: 'd', toolTitle: 't' }, meta: { timeoutMs: 1000 }, origin: 'tool', askedAt: 1, remainingMs: 900 });
    const snap = r.attach({}, conn(7));
    expect(r.calls.filter(c => c.startsWith('deliver') || c === 'revision')).toEqual(['deliver:local:7', 'revision']);
    expect(snap.mode === 'snapshot' && snap.snapshot.pendingPermissions.map(c => c.requestId)).toEqual(['R1']);
    expect(snap.revision).toBe(101);
    r.calls.length = 0;
    const res = r.attach({ resume: { epoch: 3, instanceId: INST, lastSeq: 1 } }, conn(9, 'remote'));
    expect(r.calls.filter(c => c.startsWith('deliver') || c === 'revision')).toEqual(['deliver:remote:9', 'revision']);
    expect(res.mode === 'resume' && res.pendingPermissions.map(c => c.requestId)).toEqual(['R1']);
    expect(res.revision).toBe(102);
    r.calls.length = 0;
    r.attach({});
    expect(r.calls).toContain('deliver:local:-');
  });

  it('尾巴：只留本代次仍在活动的 run 的（账本已收尾、别的代次的条目被清掉）；应答里的尾巴不被之后的事件改写', () => {
    const r = rig();
    const ev = (id: string, text: string, epoch = 3) => r.log.append('chat.event', { sessionId: SID, event: { kind: 'textDelta', text }, run: { id, generation: 1, epoch } });
    ev('RUN-A', '甲');
    ev('RUN-B', '乙');
    ev('RUN-C', '丙');
    ev('RUN-OLD', '旧', 2);
    r.runs.push(runView({ runId: 'RUN-A', state: 'running' }), runView({ runId: 'RUN-B', state: 'completed' }), runView({ runId: 'RUN-OLD', epoch: 2, state: 'running' }));
    // RUN-C 不在账本的活动表里（没有终止事件就结束了）
    const out = r.attach({});
    if (out.mode !== 'snapshot') throw new Error('应当是快照');
    expect(out.snapshot.live.map(t => [t.runId, t.text])).toEqual([['RUN-A', '甲']]);
    expect(r.tails.list().map(t => t.runId)).toEqual(['RUN-A']);
    const frozen = JSON.stringify(out);
    ev('RUN-A', '后来的');
    expect(JSON.stringify(out)).toBe(frozen);
    expect(out.snapshot.lastSeq).toBe(4);
    // starting 的 run 同样算活动
    r.runs.push(runView({ runId: 'RUN-D', state: 'starting' }));
    ev('RUN-D', '丁');
    const again = r.attach({});
    expect(again.mode === 'snapshot' && again.snapshot.live.map(t => t.runId).sort()).toEqual(['RUN-A', 'RUN-D']);
  });

  it('改动清单：所列 run 全部批次里声明了写入目标或产生了卸载文件的调用；带 sessionId 时附上消息，会话不存在时 exists:false', () => {
    const r = rig();
    r.runs.push(runView({ runId: 'RUN-A' }));
    r.byRun.set('RUN-A', [
      execView({ id: 'e1', runId: 'RUN-A', artifacts: { writePaths: ['C:\\w\\a.txt'] } }),
      execView({ id: 'e2', runId: 'RUN-A', name: 'shell_execute', artifacts: { writePaths: [], offloadPath: 'offload/x.txt' }, state: 'failed' }),
      execView({ id: 'e3', runId: 'RUN-A', name: 'file_read', artifacts: { writePaths: [] } }),
    ]);
    const out = r.attach({ sessionId: SID });
    if (out.mode !== 'snapshot') throw new Error('应当是快照');
    expect(out.snapshot.artifacts).toEqual([
      { sessionId: SID, runId: 'RUN-A', toolUseId: 'tu-e1', tool: 'file_write', state: 'completed', writePaths: ['C:\\w\\a.txt'] },
      { sessionId: SID, runId: 'RUN-A', toolUseId: 'tu-e2', tool: 'shell_execute', state: 'failed', writePaths: [], offloadPath: 'offload/x.txt' },
    ]);
    expect(out.snapshot.session).toMatchObject({ sessionId: SID, exists: true });
    expect(out.snapshot.session!.messages.map(m => m.id)).toEqual(['M1']);
    expect(r.calls).toContain(`snapshot:${SID}`);
    const gone = r.attach({ sessionId: '99999999-2222-3333-4444-555555555555' });
    expect(gone.mode === 'snapshot' && gone.snapshot.session).toEqual({ sessionId: '99999999-2222-3333-4444-555555555555', exists: false, messages: [] });
    // 续传不取会话列表与消息
    r.calls.length = 0;
    r.attach({ resume: { epoch: 3, instanceId: INST, lastSeq: 0 }, sessionId: SID });
    expect(r.calls.filter(c => c.startsWith('list'))).toEqual([]);
  });

  it('F11B 已删除的会话：它名下的 runs / executions / artifacts / live 不进快照，续传应答的 runs 也不带；别的会话的照常；尾巴表按账本原样留（不因为会话已删除就清条目）', () => {
    const GONE = '99999999-2222-3333-4444-555555555555';
    const r = rig({ isSessionDeleted: id => id === GONE });
    const ev = (sessionId: string, id: string, text: string) => r.log.append('chat.event', { sessionId, event: { kind: 'textDelta', text }, run: { id, generation: 1, epoch: 3 } });
    ev(SID, 'RUN-A', '甲');
    ev(GONE, 'RUN-G', '已删会话的尾巴');
    r.runs.push(runView({ runId: 'RUN-A', state: 'running' }), runView({ runId: 'RUN-G', sessionId: GONE, state: 'running' }));
    r.executions.push(execView({ id: 'e1', runId: 'RUN-A' }), execView({ id: 'g1', runId: 'RUN-G', sessionId: GONE }));
    r.byRun.set('RUN-A', [execView({ id: 'e1', runId: 'RUN-A', artifacts: { writePaths: ['C:\\w\\a.txt'] } })]);
    r.byRun.set('RUN-G', [execView({ id: 'g1', runId: 'RUN-G', sessionId: GONE, artifacts: { writePaths: ['C:\\w\\g.txt'] } })]);
    const out = r.attach({ sessionId: GONE });
    if (out.mode !== 'snapshot') throw new Error('应当是快照');
    expect(out.snapshot.runs.map(x => x.runId)).toEqual(['RUN-A']);
    expect(out.snapshot.executions.map(x => x.runId)).toEqual(['RUN-A']);
    expect(out.snapshot.artifacts.map(x => x.runId)).toEqual(['RUN-A']);
    expect(out.snapshot.live.map(t => [t.runId, t.text])).toEqual([['RUN-A', '甲']]);
    expect(out.snapshot.session).toEqual({ sessionId: GONE, exists: false, messages: [] });
    expect(r.calls).not.toContain('listExecutions:RUN-G');
    // 尾巴表本身不动：RUN-G 在账本里仍是活动的
    expect(r.tails.list().map(t => t.runId).sort()).toEqual(['RUN-A', 'RUN-G']);
    const res = r.attach({ resume: { epoch: 3, instanceId: INST, lastSeq: 0 }, sessionId: GONE });
    expect(res.mode === 'resume' && res.runs.map(x => x.runId)).toEqual(['RUN-A']);
  });

  it('取状态中途抛错：整个调用报错，不给部分快照', () => {
    const r = rig({ chat: { listSessions: () => { throw new Error('库读失败'); }, getSession: () => undefined, listMessages: () => [] } });
    expect(() => r.attach({})).toThrow('库读失败');
    const l = rig();
    l.deps.ledger.snapshot = () => { throw new Error('账本读失败'); };
    expect(() => createAttachHandler(l.deps)({ resume: { epoch: 3, instanceId: INST, lastSeq: 0 } })).toThrow('账本读失败');
  });
});

describe('F06 state.outcomes 的判定表（真实账本 + 真实 broker）', () => {
  function ledgerRig() {
    const dir = mkdtempSync(join(tmpdir(), 'dm-f06-oc-'));
    const db = openDb(join(dir, 'minis.db'));
    cleanups.push(() => db.close());
    let conns = 1;
    const mk = () => {
      const ledger = new RunLedger(db);
      const broker = new PermissionBroker({ timeoutMs: 60_000, connSeq: () => conns, broadcast: () => undefined, audit: () => undefined });
      const launches = new Map<string, Promise<void>>();
      const outcomes = createOutcomesHandler({
        epoch: ledger.epoch, instanceId: ledger.instanceId, ledger, broker, launchOf: id => launches.get(id),
        sessionId: id => { if (typeof id !== 'string' || !/^[0-9A-F-]{36}$/i.test(id)) throw new Error('非法 sessionId'); return id; },
      });
      return { ledger, broker, launches, outcomes };
    };
    return { db, mk, bump: () => { conns += 1; } };
  }
  const one = async (h: ReturnType<ReturnType<typeof ledgerRig>['mk']>, ref: unknown): Promise<any> => (await h.outcomes({ refs: [ref] })).outcomes[0];

  it('prompt：没有这个 id → not-accepted；starting 且本进程在起它 → 等起跑结果（失败带原因 / 成功 accepted）；陈旧的 starting 行 → not-accepted；终态 → accepted 且状态如实', async () => {
    const r = ledgerRig();
    const h = r.mk();
    const ref = (promptId: string) => ({ kind: 'prompt', sessionId: SID, promptId });
    expect(await one(h, ref('p-none'))).toEqual({ kind: 'prompt', sessionId: SID, promptId: 'p-none', status: 'not-accepted' });

    // 起跑失败
    const a = h.ledger.beginRun({ sessionId: SID, origin: { kind: 'user' }, promptId: 'p-a', promptDigest: 'd' });
    let fail!: (e: unknown) => void;
    const la = new Promise<void>((_, rej) => { fail = rej; });
    la.catch(() => undefined);
    h.launches.set(a.ref.runId, la);
    let got: any;
    const asking = one(h, ref('p-a')).then(x => (got = x));
    await Promise.resolve(); await Promise.resolve();
    expect(got).toBeUndefined();
    a.end({ state: 'cancelled', reason: 'user-stop' });
    fail(new Error('会话已取消'));
    await asking;
    expect(got).toEqual({ kind: 'prompt', sessionId: SID, promptId: 'p-a', status: 'not-accepted', error: '会话已取消' });

    // 起跑成功：兑现之后重查，run 已是 running
    const b = h.ledger.beginRun({ sessionId: SID, origin: { kind: 'user' }, promptId: 'p-b', promptDigest: 'd' });
    let ok!: () => void;
    h.launches.set(b.ref.runId, new Promise<void>(res => { ok = res; }));
    const asking2 = one(h, ref('p-b'));
    r.db.prepare("UPDATE agent_runs SET state='running', step='model', user_message_id='UM' WHERE id=?").run(b.ref.runId);
    ok();
    expect(await asking2).toMatchObject({ status: 'accepted', run: { runId: b.ref.runId, state: 'running', userMessageId: 'UM', promptId: 'p-b' } });
    b.end({ state: 'completed', reason: 'endTurn' });
    expect(await one(h, ref('p-b'))).toMatchObject({ status: 'accepted', run: { state: 'completed', stopReason: 'endTurn' } });

    // 陈旧的 starting 行（本进程并没有在起它）：这条消息从没被接收过
    const c = h.ledger.beginRun({ sessionId: SID, origin: { kind: 'user' }, promptId: 'p-c', promptDigest: 'd' });
    expect(await one(h, ref('p-c'))).toEqual({ kind: 'prompt', sessionId: SID, promptId: 'p-c', status: 'not-accepted' });
    c.end({ state: 'failed', reason: 'start-failed' });

    // 下一代引擎：上一代的 completed 仍然答 accepted（持久去重跨重启）
    h.ledger.close();
    const h2 = r.mk();
    expect(await one(h2, ref('p-b'))).toMatchObject({ status: 'accepted', run: { state: 'completed', epoch: 1 } });
    expect((await h2.outcomes({ refs: [] }))).toMatchObject({ epoch: 2, outcomes: [] });
  });

  it('permission：账本里的审批记录按取值作答（allowed / denied / expired 带 reason、cause）；仍是 pending 或查不到 → unknown；同一个 id 取最近更新的那一行', async () => {
    const r = ledgerRig();
    const h = r.mk();
    const run = h.ledger.beginRun({ sessionId: SID, origin: { kind: 'user' } });
    const ins = r.db.prepare(`INSERT INTO tool_executions (id, run_id, session_id, epoch, batch, call_index, tool_use_id, tool_name, assistant_message_id, state,
      approval_state, approval_request_id, approval_reason, approval_cause, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const row = (i: number, state: string, approval: string | null, requestId: string | null, reason: string | null, cause: string | null, updatedAt = 10 + i): void => {
      ins.run(`E${i}`, run.ref.runId, SID, 1, 1, i, `tu-${i}`, 'file_write', 'AM', state, approval, requestId, reason, cause, 1, updatedAt);
    };
    row(0, 'completed', 'allowed', 'R-ALLOW', null, null);
    row(1, 'failed', 'denied', 'R-DENY', 'user-denied', null);
    row(2, 'cancelled', 'denied', 'R-CANCEL', 'cancelled', 'shutdown');
    row(3, 'cancelled', 'expired', 'R-EXPIRED', 'invalidated', 'engine-restarted');
    row(4, 'awaiting-approval', 'pending', 'R-PENDING', null, null);
    row(5, 'completed', null, null, null, null);
    // 同一张卡的 id 出现在两行（理论上不会；取最近更新的）
    row(6, 'failed', 'denied', 'R-TWICE', 'timeout', 'unanswered', 50);
    row(7, 'completed', 'allowed', 'R-TWICE', null, null, 60);
    const ask = (requestId: string) => one(h, { kind: 'permission', requestId });
    const base = { kind: 'permission', status: 'settled', source: 'ledger', sessionId: SID, epoch: 1 };
    expect(await ask('R-ALLOW')).toEqual({ ...base, requestId: 'R-ALLOW', toolUseId: 'tu-0', approval: { state: 'allowed' }, execution: 'completed' });
    expect(await ask('R-DENY')).toEqual({ ...base, requestId: 'R-DENY', toolUseId: 'tu-1', approval: { state: 'denied', reason: 'user-denied' }, execution: 'failed' });
    expect(await ask('R-CANCEL')).toEqual({ ...base, requestId: 'R-CANCEL', toolUseId: 'tu-2', approval: { state: 'denied', reason: 'cancelled', cause: 'shutdown' }, execution: 'cancelled' });
    expect(await ask('R-EXPIRED')).toEqual({ ...base, requestId: 'R-EXPIRED', toolUseId: 'tu-3', approval: { state: 'expired', reason: 'invalidated', cause: 'engine-restarted' }, execution: 'cancelled' });
    expect(await ask('R-PENDING')).toEqual({ kind: 'permission', requestId: 'R-PENDING', status: 'unknown' });
    expect(await ask('R-NONE')).toEqual({ kind: 'permission', requestId: 'R-NONE', status: 'unknown' });
    expect(await ask('R-TWICE')).toMatchObject({ toolUseId: 'tu-7', approval: { state: 'allowed' } });
    // 下一代引擎照样查得到（跨代次）
    h.ledger.close();
    const h2 = r.mk();
    expect(await one(h2, { kind: 'permission', requestId: 'R-EXPIRED' })).toMatchObject({ source: 'ledger', epoch: 1, approval: { state: 'expired', cause: 'engine-restarted' } });
    run.end({ state: 'completed', reason: 'endTurn' });
  });

  it('permission：本进程的 broker 认识的卡优先按 broker 作答（pending / settled）；经桥发起的卡不在账本里，引擎重启后 → unknown', async () => {
    const r = ledgerRig();
    const h = r.mk();
    const ids: string[] = [];
    const broker = new PermissionBroker({
      timeoutMs: 60_000, connSeq: () => 1, audit: () => undefined,
      broadcast: (m, p) => { if (m === 'permission.request') ids.push((p as { requestId: string }).requestId); },
    });
    const outcomes = createOutcomesHandler({ epoch: h.ledger.epoch, instanceId: h.ledger.instanceId, ledger: h.ledger, broker, launchOf: () => undefined, sessionId: id => String(id) });
    const answer = broker.ask({ kind: 'bridge-clipboard-read', detail: '读剪贴板', sessionId: SID, toolTitle: 't' }, { signal: new AbortController().signal, origin: 'bridge' });
    const R = ids[0];
    expect((await outcomes({ refs: [{ kind: 'permission', requestId: R }] })).outcomes).toEqual([{ kind: 'permission', requestId: R, status: 'pending', sessionId: SID }]);
    broker.respond(R, 'allow-once', { via: 'local', seq: 1 });
    await answer;
    expect((await outcomes({ refs: [{ kind: 'permission', requestId: R }] })).outcomes).toEqual([
      { kind: 'permission', requestId: R, status: 'settled', source: 'broker', settled: { reason: 'answered', decision: 'allow' } },
    ]);
    // 引擎重启：新的 broker 不认识它，账本里也没有（桥的卡不走执行账本）
    h.ledger.close();
    const h2 = r.mk();
    expect(await one(h2, { kind: 'permission', requestId: R })).toEqual({ kind: 'permission', requestId: R, status: 'unknown' });
  });

  it('F11B 已删除的会话（账本行还在的保留副本）：prompt → not-accepted +「会话已删除」，不等起跑结果、不带出 run；permission 走账本那一支 → unknown，不带出执行记录；会话恢复之后照旧作答', async () => {
    const r = ledgerRig();
    const h = r.mk();
    const deleted = new Set<string>([SID]);
    const outcomes = createOutcomesHandler({
      epoch: h.ledger.epoch, instanceId: h.ledger.instanceId, ledger: h.ledger, broker: h.broker, launchOf: id => h.launches.get(id),
      sessionId: id => String(id), isSessionDeleted: id => deleted.has(id),
    });
    const ask = async (ref: unknown): Promise<any> => (await outcomes({ refs: [ref] })).outcomes[0];
    const done = h.ledger.beginRun({ sessionId: SID, origin: { kind: 'user' }, promptId: 'p-x', promptDigest: 'd' });
    r.db.prepare("UPDATE agent_runs SET state='running', step='model', user_message_id='UM' WHERE id=?").run(done.ref.runId);
    r.db.prepare(`INSERT INTO tool_executions (id, run_id, session_id, epoch, batch, call_index, tool_use_id, tool_name, assistant_message_id, state,
      approval_state, approval_request_id, approval_reason, approval_cause, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('E0', done.ref.runId, SID, 1, 1, 0, 'tu-0', 'file_write', 'AM', 'completed', 'allowed', 'R-KEPT', null, null, 1, 10);
    done.end({ state: 'completed', reason: 'endTurn' });
    // 一条 starting 的 run，起跑结果永远不来：已删除的会话不等它
    const starting = h.ledger.beginRun({ sessionId: SID, origin: { kind: 'user' }, promptId: 'p-s', promptDigest: 'd' });
    h.launches.set(starting.ref.runId, new Promise<void>(() => undefined));

    const gone = (promptId: string) => ({ kind: 'prompt', sessionId: SID, promptId, status: 'not-accepted', error: '会话已删除' });
    expect(await ask({ kind: 'prompt', sessionId: SID, promptId: 'p-x' })).toEqual(gone('p-x'));
    expect(await ask({ kind: 'prompt', sessionId: SID, promptId: 'p-s' })).toEqual(gone('p-s'));
    expect(await ask({ kind: 'prompt', sessionId: SID, promptId: 'p-none' })).toEqual(gone('p-none'));
    expect(await ask({ kind: 'permission', requestId: 'R-KEPT' })).toEqual({ kind: 'permission', requestId: 'R-KEPT', status: 'unknown' });
    // 别的会话不受影响
    const OTHER = '99999999-2222-3333-4444-555555555555';
    expect(await ask({ kind: 'prompt', sessionId: OTHER, promptId: 'p-x' })).toEqual({ kind: 'prompt', sessionId: OTHER, promptId: 'p-x', status: 'not-accepted' });

    // 显式恢复之后：账本行一直都在，照旧作答
    deleted.clear();
    expect(await ask({ kind: 'prompt', sessionId: SID, promptId: 'p-x' })).toMatchObject({ status: 'accepted', run: { runId: done.ref.runId, state: 'completed' } });
    expect(await ask({ kind: 'permission', requestId: 'R-KEPT' })).toMatchObject({ status: 'settled', source: 'ledger', sessionId: SID, toolUseId: 'tu-0', approval: { state: 'allowed' } });
    starting.end({ state: 'failed', reason: 'start-failed' });
  });

  it('入参：refs 不是数组、超过 64 条、某条形状不对 → 抛错；空数组照答', async () => {
    const h = ledgerRig().mk();
    await expect(h.outcomes(undefined)).rejects.toThrow('refs');
    await expect(h.outcomes({ refs: {} })).rejects.toThrow('refs');
    await expect(h.outcomes({ refs: Array.from({ length: 65 }, () => ({ kind: 'permission', requestId: 'X' })) })).rejects.toThrow('64');
    await expect(h.outcomes({ refs: [{ kind: 'prompt', sessionId: 'nope', promptId: 'ok' }] })).rejects.toThrow('非法 sessionId');
    await expect(h.outcomes({ refs: [{ kind: 'prompt', sessionId: SID, promptId: 'has space' }] })).rejects.toThrow('非法 promptId');
    await expect(h.outcomes({ refs: [{ kind: 'prompt', sessionId: SID }] })).rejects.toThrow('非法 promptId');
    await expect(h.outcomes({ refs: [{ kind: 'permission', requestId: '' }] })).rejects.toThrow('非法 requestId');
    await expect(h.outcomes({ refs: [{ kind: 'unrecognized', id: 'x' }] })).rejects.toThrow('不支持');
    await expect(h.outcomes({ refs: [{ kind: 'input', id: 'x' }] })).rejects.toThrow('非法 sessionId');
    await expect(h.outcomes({ refs: [{ kind: 'input', sessionId: SID, messageId: 'bad id' }] })).rejects.toThrow('非法 messageId');
    await expect(h.outcomes({ refs: ['x'] })).rejects.toThrow('不支持');
    expect(await h.outcomes({ refs: [] })).toMatchObject({ epoch: 1, outcomes: [] });
  });
});
