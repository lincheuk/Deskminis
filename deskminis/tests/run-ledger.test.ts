/**
 * F05 L 组：RunLedger 单元（真实 SQLite 文件库）——代次与租约、run 状态机、工具执行的条件更新、
 * 持久提交、快照、关停后不碰库；外加 shared/run.ts 两个纯函数的真值表。
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { LeaseLostError, RunActiveError, RunLedger, type ExecutionPlan } from '../src/minisd/store/run-ledger';
import { createRunRecorder } from '../src/minisd/agent/run-recorder';
import { recoverOnBoot } from '../src/minisd/agent/run-recovery';
import { terminalOf, toolResultStatusOf, TOOL_EXEC_STATES } from '../src/shared/run';
import type { ToolContext } from '../src/minisd/tools/types';
import { Trace, allowAll, fxUnknown } from './scheduler-fixture';
import { execRows, ledgerEnv, runRows, type LedgerEnv } from './run-recovery-fixture';

const WRITE_PLAN: ExecutionPlan = { name: 'fx', barrier: true, readOnly: false, sideEffects: 'unknown', claims: ['session:s'], writePaths: ['C:\\w\\a.txt'] };
const READ_PLAN: ExecutionPlan = { name: 'fx_read', barrier: false, readOnly: true, sideEffects: 'none', claims: [], writePaths: [] };
const DONE = { state: 'completed' as const, endKind: 'completed' as const, started: true, success: true, output: '结果正文', chars: 4 };

const userMsg = (env: LedgerEnv, sessionId: string, text = '开始') => () => env.store.appendMessage({
  id: env.store.newId(), sessionId, role: 'user', parts: [{ type: 'text', value: text }], createdAt: env.store.nowEpoch(), streamInterruptCount: 0,
});
const assistantMsg = (env: LedgerEnv, sessionId: string, ids: string[]) => () => env.store.appendMessage({
  id: env.store.newId(), sessionId, role: 'assistant',
  parts: ids.map(id => ({ type: 'toolUse' as const, value: { toolUseId: id, name: 'fx_unknown', input: '{}' } })),
  createdAt: env.store.nowEpoch(), streamInterruptCount: 0,
});
/** 起一个 running 的 run 并开一批。 */
function runWithBatch(env: LedgerEnv, ids: string[]) {
  const sid = env.newSession();
  const run = env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
  run.started(userMsg(env, sid));
  const a = env.ledger.atomic(() => {
    const m = assistantMsg(env, sid, ids)();
    return { m, ...env.ledger.openBatch(run.ref.runId, m.id, ids.map(id => ({ toolUseId: id, name: 'fx_unknown' }))) };
  });
  return { sid, run, assistantId: a.m.id, batch: a.batch, rowIds: a.rowIds };
}

describe('L1 数据库约束', () => {
  it('同一会话第二条 active=1、同一 (session, prompt_id) 第二条：约束失败', () => {
    const env = ledgerEnv('l1');
    const ins = env.db.prepare("INSERT INTO agent_runs (id, session_id, generation, epoch, state, active, prompt_id, created_at, updated_at) VALUES (?,?,?,1,'running',?,?,1,1)");
    ins.run('R1', 'S', 1, 1, 'P');
    expect(() => ins.run('R2', 'S', 2, 1, null)).toThrow(/UNIQUE/);
    expect(() => ins.run('R3', 'S', 3, null, 'P')).toThrow(/UNIQUE/);
    // 终态（active 为 NULL）不占活动索引；别的会话不受影响
    ins.run('R4', 'S', 4, null, 'P2');
    ins.run('R5', 'S2', 1, 1, 'P');
    expect(() => ins.run('R6', 'S', 4, null, null)).toThrow(/UNIQUE/); // generation 重复
  });

  it('去掉活动索引的库上第二条 active=1 插得进去（约束确实来自那条索引）', () => {
    const db = new Database(':memory:');
    // 按内容找 F05 那条迁移（不写死编号：别的任务也在末尾追加迁移）
    const at = MIGRATIONS.findIndex(m => m.includes('CREATE TABLE agent_runs'));
    expect(at).toBeGreaterThanOrEqual(0);
    runMigrations(db, MIGRATIONS.map((m, i) => (i === at ? m.replace(/CREATE UNIQUE INDEX idx_agent_runs_active[^;]*;/, '') : m)));
    const ins = db.prepare("INSERT INTO agent_runs (id, session_id, generation, epoch, state, active, created_at, updated_at) VALUES (?,?,?,1,'running',1,1,1)");
    ins.run('R1', 'S', 1);
    expect(() => ins.run('R2', 'S', 2)).not.toThrow();
  });
});

describe('L2 / L3 / L11 run 状态机与幂等 id', () => {
  it('L2 beginRun → started → end 的每次转移与字段；end 幂等；generation 递增', () => {
    let t = 1000;
    const env = ledgerEnv('l2');
    const ledger = new RunLedger(env.db, { now: () => t });
    const sid = env.newSession();

    const run = ledger.beginRun({ sessionId: sid, origin: { kind: 'cron', ref: 'JOB-1' }, promptId: 'p-1', promptDigest: 'd-1' });
    expect(run.ref).toMatchObject({ sessionId: sid, generation: 1, epoch: ledger.epoch });
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'starting', active: 1, step: 'starting', origin: 'cron', origin_ref: 'JOB-1', prompt_id: 'p-1', user_message_id: null, created_at: 1000 }]);

    t = 1001;
    const m = run.started(userMsg(env, sid));
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'running', active: 1, step: 'model', user_message_id: m.id, updated_at: 1001 }]);
    expect(ledger.getRun(run.ref.runId)).toMatchObject({ state: 'running', step: 'model', origin: { kind: 'cron', ref: 'JOB-1' }, promptId: 'p-1', userMessageId: m.id });

    t = 1002;
    run.end({ state: 'completed', reason: 'endTurn' });
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'completed', active: null, step: 'finished', stop_reason: 'endTurn', ended_at: 1002, prompt_id: 'p-1' }]);
    // 幂等：第二次 end 改不动已是终态的行
    t = 1003;
    run.end({ state: 'failed', reason: 'error', detail: 'x' });
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'completed', stop_reason: 'endTurn', ended_at: 1002 }]);

    const second = ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
    expect(second.ref.generation).toBe(2);
    second.end({ state: 'cancelled', reason: 'user-stop', detail: 'y'.repeat(900) });
    const rows = runRows(env.db, sid);
    expect(rows[1]).toMatchObject({ state: 'cancelled', stop_reason: 'user-stop', origin: 'user', origin_ref: null });
    expect(rows[1].stop_detail).toHaveLength(500);
  });

  it('L2 starting 时结束（从未落过 user 消息）：prompt_id 清空，同一个 id 可以再提交', () => {
    const env = ledgerEnv('l2b');
    const sid = env.newSession();
    const run = env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' }, promptId: 'p-x', promptDigest: 'd' });
    run.end({ state: 'failed', reason: 'start-failed', detail: '连 MCP 失败' });
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'failed', prompt_id: null, user_message_id: null }]);
    expect(env.ledger.findByPrompt(sid, 'p-x')).toBeUndefined();
    const again = env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' }, promptId: 'p-x', promptDigest: 'd' });
    expect(again.ref.generation).toBe(2);
  });

  it('L3 findByPrompt：活动的、已完成的都找得到（带摘要）；别的会话、别的 id 找不到', () => {
    const env = ledgerEnv('l3');
    const sid = env.newSession(); const other = env.newSession();
    const run = env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' }, promptId: 'p-1', promptDigest: 'dg' });
    expect(env.ledger.findByPrompt(sid, 'p-1')).toMatchObject({ promptDigest: 'dg', run: { runId: run.ref.runId, state: 'starting' } });
    run.started(userMsg(env, sid));
    run.end({ state: 'completed', reason: 'endTurn' });
    expect(env.ledger.findByPrompt(sid, 'p-1')).toMatchObject({ run: { state: 'completed', stopReason: 'endTurn' } });
    expect(env.ledger.findByPrompt(other, 'p-1')).toBeUndefined();
    expect(env.ledger.findByPrompt(sid, 'p-2')).toBeUndefined();
  });

  it('L11 同一会话 beginRun 两次 → RunActiveError；本代留下的陈旧活动行被记成 failed / finalize-failed 后正常起跑', () => {
    const env = ledgerEnv('l11');
    const sid = env.newSession();
    env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
    expect(() => env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } })).toThrow(RunActiveError);
    expect(runRows(env.db, sid)).toHaveLength(1);

    // 另一个会话：手工留一条本代的陈旧活动行（上一次 end() 写库失败的样子：库里活动、内存里已不在）
    const stale = env.newSession();
    env.db.prepare("INSERT INTO agent_runs (id, session_id, generation, epoch, state, active, user_message_id, prompt_id, created_at, updated_at) VALUES ('OLD',?,1,?,'running',1,'M','p-old',1,1)")
      .run(stale, env.ledger.epoch);
    const run = env.ledger.beginRun({ sessionId: stale, origin: { kind: 'user' } });
    expect(run.ref.generation).toBe(2);
    expect(runRows(env.db, stale)).toMatchObject([
      { id: 'OLD', state: 'failed', active: null, stop_reason: 'finalize-failed', prompt_id: 'p-old', recovered_epoch: null },
      { state: 'starting', active: 1 },
    ]);
  });

  it('L11b end() 写库失败（不是租约丢了）：不抛、只告警，会话照样从内存的活动表里摘掉——下一次 beginRun 把那条陈旧行记成 failed / finalize-failed 后正常起跑', () => {
    const env = ledgerEnv('l11b');
    const warns: string[] = [];
    const ledger = new RunLedger(env.db, { warn: msg => { warns.push(msg); } });
    const sid = env.newSession();
    const run = ledger.beginRun({ sessionId: sid, origin: { kind: 'user' }, promptId: 'p-1', promptDigest: 'd' });
    run.started(userMsg(env, sid));
    // 终态那一笔写不进去（库满 / 被占的样子）
    env.db.exec("CREATE TRIGGER f05_l11b BEFORE UPDATE OF state ON agent_runs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT, '注入：终态写入失败'); END");
    expect(() => run.end({ state: 'completed', reason: 'endTurn' })).not.toThrow();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('run 终态写入失败');
    // 终态确实没写成：库里这一行还标着活动
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'running', active: 1 }]);
    // 账本的失败不能让会话一直「运行中」：同一个会话可以再起跑，陈旧行在这时被收掉
    const next = ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
    expect(next.ref.generation).toBe(2);
    expect(runRows(env.db, sid)).toMatchObject([
      { state: 'failed', active: null, stop_reason: 'finalize-failed', prompt_id: 'p-1', recovered_epoch: null },
      { state: 'starting', active: 1, generation: 2 },
    ]);
  });
});

describe('L4 代次栅栏：被后一代接管的旧实例写不进去', () => {
  it('后者把前者标为 superseded；前者 beginRun 抛、接上调度器后工具不执行、persistResults 抛且结果消息不落、end 什么都不做', async () => {
    const env = ledgerEnv('l4');
    const { sid, run } = (() => {
      const s = env.newSession();
      const r = env.ledger.beginRun({ sessionId: s, origin: { kind: 'user' } });
      r.started(userMsg(env, s));
      return { sid: s, run: r };
    })();
    const controller = new AbortController();
    const rec = createRunRecorder(env.ledger, run.ref, { signal: controller.signal, warn: () => undefined });
    const calls = [{ toolUseId: 'T1', name: 'fx_unknown', input: JSON.stringify({ counter: 'c.log' }) }];
    rec.persistAssistant(calls, assistantMsg(env, sid, ['T1']));
    expect(execRows(env.db, sid)).toMatchObject([{ state: 'pending', epoch: 1 }]);

    // 第二个连接开第二代（锁文件被手动删掉、两个引擎并存的样子）
    const db2 = env.side();
    const ledger2 = new RunLedger(db2, { warn: () => undefined });
    expect(ledger2.epoch).toBe(2);
    expect(env.db.prepare('SELECT epoch, close_kind FROM engine_instances ORDER BY epoch').all()).toMatchObject([{ epoch: 1, close_kind: 'superseded' }, { epoch: 2, close_kind: null }]);

    expect(() => env.ledger.beginRun({ sessionId: env.newSession(), origin: { kind: 'user' } })).toThrow(LeaseLostError);

    // 前者的意图落不下：工具不执行
    const trace = new Trace();
    env.tools.register(fxUnknown({ trace }));
    const ctx: ToolContext = { sessionId: sid, paths: env.paths, permissions: allowAll, signal: controller.signal };
    const results = await env.scheduler.runBatch({ calls, registry: env.tools, ctx, journal: rec.journal });
    expect(trace.lines).toEqual([]);
    expect(results[0]).toMatchObject({ end: 'refused', started: false });
    expect(results[0].outcome.output).toContain('执行记录写入失败');
    expect(execRows(env.db, sid)).toMatchObject([{ state: 'pending', started: 0 }]);

    // 前者的结果消息落不下：与交付同一事务，一并回滚
    const before = env.store.listMessages(sid).length;
    expect(() => rec.persistResults(results, () => env.store.appendMessage({
      id: env.store.newId(), sessionId: sid, role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'x', success: false, status: 'failed' } }],
      createdAt: env.store.nowEpoch(), streamInterruptCount: 0,
    }))).toThrow(LeaseLostError);
    expect(env.store.listMessages(sid)).toHaveLength(before);

    // end 不抛、也不改库：这个 run 留给后一代
    expect(() => run.end({ state: 'completed', reason: 'endTurn' })).not.toThrow();
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'running', active: 1 }]);
    db2.close();
  });
});

describe('L5 心跳只是时间戳', () => {
  it('有没收尾的 run 才写；时钟拨快一小时本代的 run 状态不变；前代的 run 心跳再新也照样被恢复记成中断', () => {
    let t = 5000;
    const env = ledgerEnv('l5');
    const ledger = new RunLedger(env.db, { now: () => t, warn: () => undefined });
    const beat = (): number => (env.db.prepare('SELECT heartbeat_at FROM engine_instances WHERE epoch=?').get(ledger.epoch) as { heartbeat_at: number }).heartbeat_at;

    t = 5010;
    expect(ledger.heartbeat()).toBe(false);
    expect(beat()).toBe(5000);

    const sid = env.newSession();
    const run = ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
    run.started(userMsg(env, sid));
    t = 5020;
    expect(ledger.heartbeat()).toBe(true);
    expect(beat()).toBe(5020);
    expect(ledger.snapshot().heartbeatAt).toBe(5020);

    // 一小时没有心跳：没有任何东西把它改成失败
    t = 5020 + 3600;
    expect(ledger.snapshot({ sessionId: sid }).runs).toMatchObject([{ state: 'running' }]);
    expect(ledger.listOrphanRuns()).toEqual([]);
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'running', active: 1 }]);

    // 后一代：前代的心跳再新（写成真实时钟的一小时之后，任何「心跳超过多久算死」的判据都会当它还活着）也照样按代次判成中断
    env.db.prepare('UPDATE engine_instances SET heartbeat_at=? WHERE epoch=?').run(Date.now() / 1000 + 3600, ledger.epoch);
    const next = new RunLedger(env.db, { now: () => t, warn: () => undefined });
    const report = recoverOnBoot({ ledger: next, chat: env.store, warn: () => undefined });
    expect(report.runs).toMatchObject([{ runId: run.ref.runId, state: 'interrupted', stopReason: 'engine-crash', recoveredEpoch: next.epoch }]);
    // 没有 run 之后不再写
    run.end({ state: 'completed', reason: 'endTurn' });
    expect(ledger.heartbeat()).toBe(false);
  });

  it('startHeartbeat 按间隔写（假时钟）；stopHeartbeat 之后不再写', () => {
    vi.useFakeTimers();
    try {
      const env = ledgerEnv('l5b');
      const sid = env.newSession();
      env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
      const spy = vi.spyOn(env.ledger, 'heartbeat');
      env.ledger.startHeartbeat(1000);
      vi.advanceTimersByTime(3500);
      expect(spy).toHaveBeenCalledTimes(3);
      env.ledger.stopHeartbeat();
      vi.advanceTimersByTime(5000);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

describe('L6 纯函数真值表', () => {
  it('terminalOf', () => {
    for (const aborted of [true, false]) {
      expect(terminalOf({ end: 'cancelled-before-start', started: false, success: false }, aborted)).toEqual({ state: 'cancelled', endKind: 'cancelled-before-start' });
      expect(terminalOf({ end: 'lock-timeout', started: false, success: false }, aborted)).toEqual({ state: 'failed', endKind: 'lock-timeout' });
      expect(terminalOf({ end: 'refused', started: false, success: false }, aborted)).toEqual({ state: 'failed', endKind: 'refused' });
      expect(terminalOf({ end: 'completed', started: true, success: true }, aborted)).toEqual({ state: 'completed', endKind: 'completed' });
    }
    expect(terminalOf({ end: 'completed', started: true, success: false }, true)).toEqual({ state: 'cancelled', endKind: 'cancelled-during-run' });
    expect(terminalOf({ end: 'completed', started: true, success: false }, false)).toEqual({ state: 'failed', endKind: 'completed' });
  });

  it('toolResultStatusOf：四个终态一一对应；非终态不会被说成成功或失败', () => {
    expect(TOOL_EXEC_STATES.map(s => [s, toolResultStatusOf(s)])).toEqual([
      ['pending', 'unknown'], ['awaiting-approval', 'unknown'], ['running', 'unknown'],
      ['completed', 'success'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['unknown', 'unknown'],
    ]);
  });
});

describe('L7 各写入点的条件更新', () => {
  it('beginExecution 只认 pending；settle 改不动已交付的行；approvalDenied 改不动终态行；deliverBatch 行数不符即抛', () => {
    const env = ledgerEnv('l7');
    const b = runWithBatch(env, ['A', 'B']);
    const [a, bb] = b.rowIds;

    env.ledger.beginExecution(a, WRITE_PLAN);
    expect(execRows(env.db, b.sid)[0]).toMatchObject({ state: 'running', started: 1, barrier: 1, read_only: 0, side_effects: 'unknown', write_paths_json: JSON.stringify(WRITE_PLAN.writePaths) });
    // 同一行再 begin：不在待执行状态
    expect(() => env.ledger.beginExecution(a, WRITE_PLAN)).toThrow(/待执行/);

    // 审批往返
    env.ledger.approvalIssued(a, { requestId: 'CARD-1', kind: 'shell', priorAllows: 0 });
    expect(execRows(env.db, b.sid)[0]).toMatchObject({ state: 'awaiting-approval', approval_state: 'pending', approval_request_id: 'CARD-1', approval_kind: 'shell', prior_allows: 0 });
    expect(env.ledger.approvalAllowed(a)).toBe(true);
    expect(execRows(env.db, b.sid)[0]).toMatchObject({ state: 'running', approval_state: 'allowed' });

    env.ledger.settleExecution(a, DONE);
    expect(execRows(env.db, b.sid)[0]).toMatchObject({ state: 'completed', end_kind: 'completed', result_output: '结果正文', result_success: 1, delivered_at: null });
    // 终态行：再落定、再记拒绝都改不动；晚到的放行返回 false（没有东西要记）
    env.ledger.settleExecution(a, { ...DONE, state: 'failed', output: '别的' });
    env.ledger.approvalDenied(a, { reason: 'user-denied' });
    expect(env.ledger.approvalAllowed(a)).toBe(false);
    expect(execRows(env.db, b.sid)[0]).toMatchObject({ state: 'completed', result_output: '结果正文', approval_state: 'allowed' });

    // B 还没落定、也没给补写：标记到的行数（1）不等于本批调用数（2）→ 抛，A 也不被标成已交付
    expect(() => env.ledger.atomic(() => env.ledger.deliverBatch(b.run.ref.runId, b.batch, 'MSG', [undefined, undefined]))).toThrow(LeaseLostError);
    expect(execRows(env.db, b.sid).map(r => r.delivered_at)).toEqual([null, null]);

    // 给了补写：B 按补写落定，全批交付，result_output 清空，run 的步骤回到 model
    env.ledger.deliverBatch(b.run.ref.runId, b.batch, 'MSG', [undefined, { state: 'cancelled', endKind: 'cancelled-before-start', started: false, success: false, output: '[已取消]', chars: 5 }]);
    const rows = execRows(env.db, b.sid);
    expect(rows).toMatchObject([
      { state: 'completed', result_message_id: 'MSG', result_output: null },
      { state: 'cancelled', end_kind: 'cancelled-before-start', result_message_id: 'MSG', result_output: null },
    ]);
    expect(rows.every(r => r.delivered_at !== null)).toBe(true);
    expect(runRows(env.db, b.sid)).toMatchObject([{ step: 'model', tool_batches: 1 }]);

    // 已交付的行：落定改不动
    env.ledger.settleExecution(bb, DONE);
    expect(execRows(env.db, b.sid)[1]).toMatchObject({ state: 'cancelled' });
  });

  it('取消赛跑先交回：落定时审批还挂着的行顺带记成 denied / cancelled', () => {
    const env = ledgerEnv('l7b');
    const b = runWithBatch(env, ['A']);
    env.ledger.beginExecution(b.rowIds[0], WRITE_PLAN);
    env.ledger.approvalIssued(b.rowIds[0], { requestId: 'CARD-9', kind: 'file-write', priorAllows: 0 });
    env.ledger.settleExecution(b.rowIds[0], { state: 'cancelled', endKind: 'cancelled-during-run', started: true, success: false, output: '[已取消]', chars: 5 });
    expect(execRows(env.db, b.sid)[0]).toMatchObject({ state: 'cancelled', end_kind: 'cancelled-during-run', approval_state: 'denied', approval_reason: 'cancelled', approval_request_id: 'CARD-9' });
  });

  it('权限未放行：记原因，行从审批中回到执行中', () => {
    const env = ledgerEnv('l7c');
    const b = runWithBatch(env, ['A']);
    env.ledger.beginExecution(b.rowIds[0], WRITE_PLAN);
    env.ledger.approvalIssued(b.rowIds[0], { requestId: 'CARD-2', kind: 'shell', priorAllows: 1 });
    env.ledger.approvalDenied(b.rowIds[0], { reason: 'timeout', cause: 'unanswered', requestId: 'CARD-2' });
    expect(execRows(env.db, b.sid)[0]).toMatchObject({ state: 'running', approval_state: 'denied', approval_reason: 'timeout', approval_cause: 'unanswered', prior_allows: 1 });
  });
});

describe('L8 持久提交：意图与放行两处用 synchronous = FULL', () => {
  /** 记录 pragma 调用与事务边界的库包装。 */
  function recording(db: Database.Database): { db: Database.Database; log: string[] } {
    const log: string[] = [];
    const proxy = new Proxy(db, {
      get(target, prop) {
        if (prop === 'pragma') return (sql: string, o?: unknown) => { log.push(`pragma ${sql}`); return (target.pragma as (s: string, o?: unknown) => unknown)(sql, o); };
        if (prop === 'transaction') return (fn: (...a: unknown[]) => unknown) => {
          const tx = target.transaction((...a: unknown[]) => { log.push('tx-begin'); try { return fn(...a); } finally { log.push('tx-end'); } });
          return tx;
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { db: proxy, log };
  }

  it('有副作用的调用 beginExecution：切 FULL → 事务 → 恢复原值；只读无副作用的不切；弹过卡的放行切', () => {
    const env = ledgerEnv('l8');
    const rec = recording(env.db);
    const ledger = new RunLedger(rec.db, { warn: () => undefined });
    expect(env.db.pragma('synchronous', { simple: true })).toBe(1);
    const sid = env.newSession();
    const run = ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
    run.started(userMsg(env, sid));
    const m = assistantMsg(env, sid, ['W', 'R'])();
    const { rowIds } = ledger.openBatch(run.ref.runId, m.id, [{ toolUseId: 'W', name: 'fx_write' }, { toolUseId: 'R', name: 'fx_read' }]);

    rec.log.length = 0;
    ledger.beginExecution(rowIds[0], WRITE_PLAN);
    expect(rec.log).toEqual(['pragma synchronous = FULL', 'tx-begin', 'tx-end', 'pragma synchronous = 1']);
    expect(env.db.pragma('synchronous', { simple: true })).toBe(1);

    rec.log.length = 0;
    ledger.beginExecution(rowIds[1], READ_PLAN);
    expect(rec.log).toEqual(['tx-begin', 'tx-end']);

    ledger.approvalIssued(rowIds[0], { requestId: 'C', kind: 'shell', priorAllows: 0 });
    rec.log.length = 0;
    ledger.approvalAllowed(rowIds[0]);
    expect(rec.log).toEqual(['pragma synchronous = FULL', 'tx-begin', 'tx-end', 'pragma synchronous = 1']);

    // 写入抛错也恢复原值
    rec.log.length = 0;
    expect(() => ledger.beginExecution(rowIds[0], WRITE_PLAN)).toThrow();
    expect(rec.log[0]).toBe('pragma synchronous = FULL');
    expect(rec.log[rec.log.length - 1]).toBe('pragma synchronous = 1');
    expect(env.db.pragma('synchronous', { simple: true })).toBe(1);
  });
});

describe('L9 快照', () => {
  it('恒含全部活动 run；sessionId / runId 两种查询；不含入参与输出正文；executions 只含最后一批与未交付的行', () => {
    const env = ledgerEnv('l9');
    // 会话 X：两批，第一批已交付，第二批进行中
    const x = runWithBatch(env, ['X1']);
    env.ledger.beginExecution(x.rowIds[0], WRITE_PLAN);
    env.ledger.settleExecution(x.rowIds[0], DONE);
    env.ledger.deliverBatch(x.run.ref.runId, x.batch, 'MSG-1', [undefined]);
    const second = env.ledger.atomic(() => {
      const m = assistantMsg(env, x.sid, ['X2', 'X3'])();
      return env.ledger.openBatch(x.run.ref.runId, m.id, [{ toolUseId: 'X2', name: 'fx_unknown' }, { toolUseId: 'X3', name: 'fx_unknown' }]);
    });
    env.ledger.beginExecution(second.rowIds[0], WRITE_PLAN);
    env.ledger.settleExecution(second.rowIds[0], { ...DONE, output: '机密输出正文', offloadPath: 'offloads/x2.txt' });
    // 会话 Y：已结束的 run
    const y = runWithBatch(env, ['Y1']);
    env.ledger.beginExecution(y.rowIds[0], READ_PLAN);
    env.ledger.settleExecution(y.rowIds[0], DONE);
    env.ledger.deliverBatch(y.run.ref.runId, y.batch, 'MSG-Y', [undefined]);
    y.run.end({ state: 'completed', reason: 'endTurn' });

    const all = env.ledger.snapshot();
    expect(all).toMatchObject({ epoch: env.ledger.epoch, instanceId: env.ledger.instanceId });
    expect(all.runs.map(r => r.runId)).toEqual([x.run.ref.runId]);
    expect(all.executions.map(e => [e.toolUseId, e.state, e.delivered])).toEqual([['X2', 'completed', false], ['X3', 'pending', false]]);
    expect(all.executions[0]).toMatchObject({ batch: 2, index: 0, started: true, success: true, barrier: true, readOnly: false, sideEffects: 'unknown', artifacts: { writePaths: WRITE_PLAN.writePaths, offloadPath: 'offloads/x2.txt' } });
    expect(JSON.stringify(all)).not.toContain('机密输出正文');
    expect(JSON.stringify(all)).not.toContain('结果正文');

    // 按会话：带上该会话最近一次 run（已结束的也给），连同它的最后一批
    const byY = env.ledger.snapshot({ sessionId: y.sid });
    expect(byY.runs.map(r => r.runId).sort()).toEqual([x.run.ref.runId, y.run.ref.runId].sort());
    expect(byY.executions.filter(e => e.sessionId === y.sid)).toMatchObject([{ toolUseId: 'Y1', state: 'completed', delivered: true, resultMessageId: 'MSG-Y', readOnly: true, sideEffects: 'none' }]);
    // 按 runId
    expect(env.ledger.snapshot({ runId: y.run.ref.runId }).runs.some(r => r.runId === y.run.ref.runId)).toBe(true);
    expect(env.ledger.snapshot({ runId: 'NOPE' }).runs.map(r => r.runId)).toEqual([x.run.ref.runId]);
    // listExecutions：全部批次 / 指定批次
    expect(env.ledger.listExecutions(x.run.ref.runId).map(e => e.toolUseId)).toEqual(['X1', 'X2', 'X3']);
    expect(env.ledger.listExecutions(x.run.ref.runId, { batch: 1 }).map(e => e.toolUseId)).toEqual(['X1']);
  });
});

describe('L10 删除会话', () => {
  it('ChatStore.deleteSession 删掉该会话的 run 与调用，不动别的会话', () => {
    const env = ledgerEnv('l10');
    const a = runWithBatch(env, ['A1', 'A2']);
    const b = runWithBatch(env, ['B1']);
    a.run.end({ state: 'cancelled', reason: 'session-deleted' });
    env.store.deleteSession(a.sid);
    expect(runRows(env.db, a.sid)).toEqual([]);
    expect(execRows(env.db, a.sid)).toEqual([]);
    expect(runRows(env.db, b.sid)).toHaveLength(1);
    expect(execRows(env.db, b.sid)).toHaveLength(1);
  });
});

describe('L12 关停之后不碰库', () => {
  it('close 记 shutdown；此后 end / heartbeat / settle / approval* 不碰库（连接已关也不抛、不告警），beginExecution 抛，列表为空', () => {
    const warns: string[] = [];
    const env = ledgerEnv('l12');
    const ledger = new RunLedger(env.db, { warn: m => { warns.push(m); } });
    const sid = env.newSession();
    const run = ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
    run.started(userMsg(env, sid));
    const m = assistantMsg(env, sid, ['A'])();
    const { rowIds } = ledger.openBatch(run.ref.runId, m.id, [{ toolUseId: 'A', name: 'fx' }]);

    ledger.close();
    expect(ledger.closed).toBe(true);
    expect(env.db.prepare('SELECT close_kind FROM engine_instances WHERE epoch=?').get(ledger.epoch)).toEqual({ close_kind: 'shutdown' });
    // 仍在活动的 run 不动，留给下次启动
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'running', active: 1 }]);

    env.db.close();
    expect(() => run.end({ state: 'cancelled', reason: 'shutdown' })).not.toThrow();
    expect(ledger.heartbeat()).toBe(false);
    expect(() => ledger.settleExecution(rowIds[0], DONE)).not.toThrow();
    expect(() => ledger.approvalIssued(rowIds[0], { requestId: 'C', kind: 'shell', priorAllows: 0 })).not.toThrow();
    expect(() => ledger.approvalDenied(rowIds[0], { reason: 'cancelled' })).not.toThrow();
    expect(ledger.listOpenBatches({ runId: run.ref.runId })).toEqual([]);
    expect(ledger.listOrphanRuns()).toEqual([]);
    expect(() => ledger.beginExecution(rowIds[0], WRITE_PLAN)).toThrow('引擎正在关闭');
    // 放行不能没有记录：关停后的放行落不了账，抛（调用方据此不放行）
    expect(() => ledger.approvalAllowed(rowIds[0])).toThrow('引擎正在关闭');
    expect(() => ledger.close()).not.toThrow();
    expect(warns).toEqual([]);
  });

  it('有序关停后再开一代：前代是 shutdown 而不是 superseded；它没停下的 run 被记成 shutdown-timeout', () => {
    const env = ledgerEnv('l12b');
    const sid = env.newSession();
    const run = env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
    run.started(userMsg(env, sid));
    env.ledger.close();
    const next = new RunLedger(env.db, { warn: () => undefined });
    expect(env.db.prepare('SELECT close_kind FROM engine_instances WHERE epoch=1').get()).toEqual({ close_kind: 'shutdown' });
    const report = recoverOnBoot({ ledger: next, chat: new ChatStore(env.db), warn: () => undefined });
    expect(report.runs).toMatchObject([{ state: 'interrupted', stopReason: 'shutdown-timeout', recoveredEpoch: 2 }]);
  });
});
