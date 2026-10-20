/**
 * F05 G 组：循环 + 真实调度器 + 真实账本（实时路径）。
 *
 * 验证四个提交点各自在该在的时刻已经落库（都用旁路连接读——读到的只有已提交的东西）：
 * 执行意图先于 execute；结果在调用落定时提交；结果消息与「已交付」同一事务；状态先提交、事件后发布。
 * 库写失败用旁路连接建触发器注入（RAISE(ABORT)），产品里没有故障开关。
 * 「没有执行」的断言看工具侧的 Trace 与磁盘，不看账本自己说的。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionAskOptions, PermissionDenied, PermissionGateway, PermissionOutcome, PermissionRequest, ToolExecutor } from '../src/minisd/tools/types';
import { runAgentLoop, type LoopEvent } from '../src/minisd/agent/loop';
import { OffloadEngine } from '../src/minisd/agent/offload';
import { settleOpenBatches } from '../src/minisd/agent/run-recovery';
import { PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import { ToolScheduler } from '../src/minisd/tools/scheduler';
import { Gate, ScriptProvider, Trace, allowAll, collect, fxUnknown, fxWrite, gatedTool, loopEnv, toolTurn, withDeadline } from './scheduler-fixture';
import { IssuingGateway, execRows, ledgerEnv, resultsOf, runRows, startRun } from './run-recovery-fixture';

const askShell = (i: Record<string, unknown>, ctx: { sessionId: string }) => ({ kind: 'shell' as const, detail: String(i.tag), sessionId: ctx.sessionId, toolTitle: 't' });

describe('F05 执行意图先落账再调工具', () => {
  it('G1 工具在 execute 第一行用旁路连接读自己的行：已是 running、started=1，那条 assistant 消息已在库里', async () => {
    const env = ledgerEnv('g1');
    const sid = env.newSession();
    const side = env.side();
    let row: any; let roles: string[] = [];
    const probe: ToolExecutor = {
      definition: { name: 'fx_probe', description: 'probe', parameters: {}, required: [] },
      async execute() {
        row = side.prepare('SELECT state, started, delivered_at, read_only, side_effects FROM tool_executions WHERE tool_use_id=?').get('P1');
        roles = (side.prepare('SELECT role FROM messages WHERE session_id=? ORDER BY created_at, id').all(sid) as { role: string }[]).map(r => r.role);
        return { output: 'probed', success: true };
      },
    };
    env.tools.register(probe);
    const run = startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'P1', name: 'fx_probe', input: {} }])]));
    await withDeadline(run.done, 5000, 'G1');
    expect(row).toEqual({ state: 'running', started: 1, delivered_at: null, read_only: 0, side_effects: 'unknown' });
    expect(roles).toEqual(['user', 'assistant']);
    side.close();
    // 跑完之后：行已交付，run 已完成，步骤回到 finished
    expect(execRows(env.db, sid)).toMatchObject([{ state: 'completed', end_kind: 'completed', result_output: null }]);
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'completed', step: 'finished', tool_batches: 1, stop_reason: 'endTurn' }]);
  });

  it('G2 意图写入失败（触发器让 state 改成 running 的更新抛错）：工具没有进门、磁盘无改动、结果说明原因，同批后一个调用照常', async () => {
    const env = ledgerEnv('g2');
    const sid = env.newSession();
    const trace = new Trace();
    env.tools.register(fxWrite({ trace }));
    const A = join(env.root, 'g2-a.txt'); const B = join(env.root, 'g2-b.txt');
    const side = env.side();
    side.exec("CREATE TRIGGER f05_g2 BEFORE UPDATE OF state ON tool_executions WHEN NEW.state='running' AND OLD.tool_use_id='W1' BEGIN SELECT RAISE(ABORT, '注入：意图写入失败'); END");
    side.close();
    const run = startRun(env, sid, new ScriptProvider([toolTurn([
      { id: 'W1', name: 'fx_write', input: { tag: 'W1', path: A, content: 'a' } },
      { id: 'W2', name: 'fx_write', input: { tag: 'W2', path: B, content: 'b' } },
    ])]));
    await withDeadline(run.done, 5000, 'G2');
    expect(trace.has('W1:enter')).toBe(false);
    expect(existsSync(A)).toBe(false);
    expect(readFileSync(B, 'utf8')).toBe('b');
    const results = resultsOf(env.store, sid);
    expect(results.map(r => [r.toolUseId, r.success, r.status])).toEqual([['W1', false, 'failed'], ['W2', true, 'success']]);
    expect(results[0].output).toContain('执行记录写入失败');
    expect(results[0].output).toContain('没有产生任何改动');
    expect(execRows(env.db, sid)).toMatchObject([
      { tool_use_id: 'W1', state: 'failed', end_kind: 'refused', started: 0 },
      { tool_use_id: 'W2', state: 'completed', end_kind: 'completed', started: 1 },
    ]);
  });
});

describe('F05 结果在调用落定时提交', () => {
  it('G3 同批 [快写, 被闸挂住的慢调用]：慢调用还挂着时，快写的结果已在账本里（未交付），历史里还没有结果消息', async () => {
    const env = ledgerEnv('g3');
    const sid = env.newSession();
    const trace = new Trace();
    const gate = new Gate();
    env.tools.register(fxWrite({ trace }));
    env.tools.register(fxWrite({ name: 'fx_slow', trace, gateOf: () => gate }));
    const A = join(env.root, 'g3-a.txt'); const B = join(env.root, 'g3-b.txt');
    const run = startRun(env, sid, new ScriptProvider([toolTurn([
      { id: 'FAST', name: 'fx_write', input: { tag: 'FAST', path: A, content: 'fast' } },
      { id: 'SLOW', name: 'fx_slow', input: { tag: 'SLOW', path: B, content: 'slow' } },
    ])]));
    await trace.until('FAST:exit');
    await trace.until('SLOW:enter');
    const side = env.side();
    // 快写落定是同步发生在它返回之后的那个续体里：等到旁路连接读到终态为止（上限 2 秒）
    const fast = (): any => side.prepare("SELECT state, result_output, delivered_at FROM tool_executions WHERE tool_use_id='FAST'").get();
    await withDeadline((async () => { while (fast().state !== 'completed') await new Promise(r => setImmediate(r)); })(), 2000, '快写的结果入账');
    expect(fast()).toMatchObject({ state: 'completed', delivered_at: null });
    expect(fast().result_output).toContain('FAST ok');
    expect(side.prepare("SELECT state FROM tool_executions WHERE tool_use_id='SLOW'").get()).toEqual({ state: 'running' });
    expect(resultsOf(env.store, sid)).toEqual([]);
    side.close();
    gate.open();
    await withDeadline(run.done, 5000, 'G3');
    expect(resultsOf(env.store, sid).map(r => r.toolUseId)).toEqual(['FAST', 'SLOW']);
    expect(execRows(env.db, sid).map(r => [r.state, r.result_output, r.delivered_at !== null])).toEqual([['completed', null, true], ['completed', null, true]]);
  });

  it('G4 交付更新失败：结果消息没有落库（同事务回滚）、行仍未交付；随后收尾补写恰好一条', async () => {
    const env = ledgerEnv('g4');
    const sid = env.newSession();
    const trace = new Trace();
    env.tools.register(fxUnknown({ trace }));
    const counter = join(env.root, 'g4.log');
    const side = env.side();
    side.exec("CREATE TRIGGER f05_g4 BEFORE UPDATE OF delivered_at ON tool_executions BEGIN SELECT RAISE(ABORT, '注入：交付失败'); END");
    const run = startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'U1', name: 'fx_unknown', input: { tag: 'U1', counter } }])]));
    await expect(withDeadline(run.done, 5000, 'G4')).rejects.toThrow(/注入：交付失败/);
    expect(readFileSync(counter, 'utf8')).toBe('x\n');
    expect(env.store.listMessages(sid).map(m => m.role)).toEqual(['user', 'assistant']);
    expect(execRows(env.db, sid)).toMatchObject([{ state: 'completed', delivered_at: null }]);
    expect(execRows(env.db, sid)[0].result_output).toContain('U1 ok');

    side.exec('DROP TRIGGER f05_g4');
    side.close();
    const deps = { ledger: env.ledger, chat: env.store, warn: () => undefined };
    const reports = settleOpenBatches(deps, { runId: run.handle.ref.runId });
    expect(reports).toMatchObject([{ superseded: false, counts: { completed: 1, failed: 0, cancelled: 0, unknown: 0 } }]);
    expect(resultsOf(env.store, sid)).toEqual([{ toolUseId: 'U1', output: 'U1 ok', success: true, status: 'success' }]);
    // 再来一次：没有东西要补，工具也没有再进门
    expect(settleOpenBatches(deps, { runId: run.handle.ref.runId })).toEqual([]);
    expect(resultsOf(env.store, sid)).toHaveLength(1);
    expect(trace.lines.filter(l => l === 'U1:enter')).toHaveLength(1);
    expect(readFileSync(counter, 'utf8')).toBe('x\n');
  });

  it('G10 落定时结果提交失败（触发器让落定那一笔抛错）：调用照常返回，交付时按内存里的终态补写——真实结果进历史恰好一条、行已完成已交付，工具只执行一次', async () => {
    const env = ledgerEnv('g10');
    const sid = env.newSession();
    const trace = new Trace();
    env.tools.register(fxUnknown({ trace }));
    const counter = join(env.root, 'g10.log');
    const side = env.side();
    // 只拦「落定」那一笔（settled_at 从空变成有值）
    side.exec("CREATE TRIGGER f05_g10 BEFORE UPDATE OF settled_at ON tool_executions WHEN NEW.settled_at IS NOT NULL BEGIN SELECT RAISE(ABORT, '注入：落定写入失败'); END");
    const run = startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'U1', name: 'fx_unknown', input: { tag: 'U1', counter } }])]));
    let atToolEnd: any;
    run.onEvent(e => {
      if (e.kind !== 'toolEnd') return;
      // 工具已经返回、落定的写入被拦下：行还停在执行中，结果只在记录器的内存里
      atToolEnd = side.prepare("SELECT state, result_output, delivered_at FROM tool_executions WHERE tool_use_id='U1'").get();
      // 库恢复可写：接下来的交付要把这一行按内存里的终态补上（生成器此刻停在 toolEnd 这个 yield 上，结果消息还没落）
      side.exec('DROP TRIGGER f05_g10');
    });
    await withDeadline(run.done, 5000, 'G10');
    side.close();
    expect(atToolEnd).toEqual({ state: 'running', result_output: null, delivered_at: null });
    // 没有因为那次写入失败丢结果、也没有把它说成未知或失败
    expect(resultsOf(env.store, sid)).toEqual([{ toolUseId: 'U1', output: 'U1 ok', success: true, status: 'success' }]);
    const rows = execRows(env.db, sid);
    expect(rows).toMatchObject([{ state: 'completed', end_kind: 'completed', started: 1, result_success: 1, result_output: null }]);
    expect(rows[0].delivered_at).not.toBeNull();
    expect(rows[0].result_message_id).toBe(env.store.listMessages(sid)[2].id);
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'completed', active: null }]);
    expect(trace.lines.filter(l => l === 'U1:enter')).toHaveLength(1);
    expect(readFileSync(counter, 'utf8')).toBe('x\n');
  });
});

describe('F05 状态先提交，事件后发布', () => {
  it('G5 收到 toolStart 时行已是 pending；收到 toolEnd 时该行已是终态；收到结果消息的 messagePersisted 时全批已交付', async () => {
    const env = ledgerEnv('g5');
    const sid = env.newSession();
    env.tools.register(fxUnknown({ trace: new Trace() }));
    const side = env.side();
    const states = (): string[] => (side.prepare('SELECT state, delivered_at FROM tool_executions WHERE session_id=? ORDER BY call_index').all(sid) as { state: string; delivered_at: number | null }[])
      .map(r => `${r.state}${r.delivered_at !== null ? '+delivered' : ''}`);
    const seen: Record<string, string[]> = {};
    let persisted = 0;
    const run = startRun(env, sid, new ScriptProvider([toolTurn([
      { id: 'A', name: 'fx_unknown', input: { tag: 'A' } }, { id: 'B', name: 'fx_unknown', input: { tag: 'B' } },
    ])]));
    run.onEvent(e => {
      if (e.kind === 'toolStart' && !seen.toolStart) seen.toolStart = states();
      if (e.kind === 'toolEnd' && e.toolUseId === 'A') seen.toolEndA = states();
      if (e.kind === 'messagePersisted' && ++persisted === 2) seen.resultsPersisted = states();
      if (e.kind === 'turnEnd') seen.turnEnd = [(side.prepare('SELECT state FROM agent_runs WHERE session_id=?').get(sid) as { state: string }).state];
    });
    await withDeadline(run.done, 5000, 'G5');
    side.close();
    expect(seen.toolStart).toEqual(['pending', 'pending']);
    expect(seen.toolEndA).toEqual(['completed', 'completed']);
    expect(seen.resultsPersisted).toEqual(['completed+delivered', 'completed+delivered']);
    // startRun 像 index.ts 那样在收到 turnEnd 时落终态：这里读到的是提交之前的 running，提交紧随其后
    expect(seen.turnEnd).toEqual(['running']);
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'completed' }]);
  });
});

describe('F05 账本状态与落库 status', () => {
  it('G6a 取消：等审批的调用 cancelled-during-run，同批还没启动的 cancelled-before-start；两个结果的 status 都是 cancelled', async () => {
    const env = ledgerEnv('g6a');
    const sid = env.newSession();
    const trace = new Trace();
    const counter = join(env.root, 'g6a.log');
    env.tools.register(fxUnknown({ trace, ask: askShell }));
    const gw = new IssuingGateway();
    const run = startRun(env, sid, new ScriptProvider([toolTurn([
      { id: 'W', name: 'fx_unknown', input: { tag: 'W', counter } }, { id: 'X', name: 'fx_unknown', input: { tag: 'X', counter } },
    ])]), { gateway: gw });
    await gw.untilCards(1);
    expect(execRows(env.db, sid).map(r => [r.state, r.approval_state, r.approval_request_id])).toEqual([['awaiting-approval', 'pending', 'CARD-1'], ['pending', null, null]]);
    run.controller.abort();
    await withDeadline(run.done, 5000, 'G6a');
    expect(existsSync(counter)).toBe(false);
    expect(trace.has('X:enter')).toBe(false);
    expect(resultsOf(env.store, sid).map(r => [r.toolUseId, r.output, r.success, r.status])).toEqual([['W', '[已取消]', false, 'cancelled'], ['X', '[已取消]', false, 'cancelled']]);
    expect(execRows(env.db, sid)).toMatchObject([
      { state: 'cancelled', end_kind: 'cancelled-during-run', started: 1, approval_state: 'denied', approval_reason: 'cancelled' },
      { state: 'cancelled', end_kind: 'cancelled-before-start', started: 0 },
    ]);
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'cancelled', stop_reason: 'user-stop' }]);
  });

  it('G6b 被拒（未知工具）、权限拒绝、工具失败：账本各自如实，status 都是 failed', async () => {
    const env = ledgerEnv('g6b');
    const sid = env.newSession();
    const trace = new Trace();
    const counter = join(env.root, 'g6b.log');
    env.tools.register(fxUnknown({ trace, ask: askShell }));
    env.tools.register(gatedTool({ name: 'fx_bad', trace, fail: 'outcome' }));
    const gw = new IssuingGateway();
    const run = startRun(env, sid, new ScriptProvider([toolTurn([
      { id: 'N', name: 'no_such_tool', input: {} },
      { id: 'D', name: 'fx_unknown', input: { tag: 'D', counter } },
      { id: 'F', name: 'fx_bad', input: { tag: 'F' } },
    ])]), { gateway: gw });
    await gw.untilCards(1);
    gw.deny('CARD-1');
    await withDeadline(run.done, 5000, 'G6b');
    expect(existsSync(counter)).toBe(false);
    expect(resultsOf(env.store, sid).map(r => [r.toolUseId, r.success, r.status])).toEqual([['N', false, 'failed'], ['D', false, 'failed'], ['F', false, 'failed']]);
    expect(execRows(env.db, sid)).toMatchObject([
      { state: 'failed', end_kind: 'refused', started: 0, approval_state: null },
      { state: 'failed', end_kind: 'completed', started: 1, approval_state: 'denied', approval_reason: 'user-denied', approval_request_id: 'CARD-1' },
      { state: 'failed', end_kind: 'completed', started: 1, approval_state: null },
    ]);
  });

  it('G6c 等锁超时：没有执行，账本 failed / lock-timeout', async () => {
    const env = ledgerEnv('g6c');
    env.scheduler = new ToolScheduler({ lockWaitTimeoutMs: 60 });
    const trace = new Trace();
    const gate = new Gate();
    env.tools.register(fxWrite({ trace, gateOf: i => (i.tag === 'HOLD' ? gate : undefined) }));
    const P = join(env.root, 'g6c.txt');
    const holderSid = env.newSession(); const waiterSid = env.newSession();
    const holder = startRun(env, holderSid, new ScriptProvider([toolTurn([{ id: 'HOLD', name: 'fx_write', input: { tag: 'HOLD', path: P, content: 'h' } }])]));
    await trace.until('HOLD:enter');
    const waiter = startRun(env, waiterSid, new ScriptProvider([toolTurn([{ id: 'WAIT', name: 'fx_write', input: { tag: 'WAIT', path: P, content: 'w' } }])]));
    await withDeadline(waiter.done, 5000, 'G6c 等的那一方');
    expect(trace.has('WAIT:enter')).toBe(false);
    expect(execRows(env.db, waiterSid)).toMatchObject([{ state: 'failed', end_kind: 'lock-timeout', started: 0 }]);
    expect(resultsOf(env.store, waiterSid).map(r => r.status)).toEqual(['failed']);
    gate.open();
    await withDeadline(holder.done, 5000, 'G6c 占着的那一方');
    expect(readFileSync(P, 'utf8')).toBe('h');
  });
});

describe('F05 不传 recorder 时工具段与 F04 相同', () => {
  /** 同一份剧本：一次成功 + 一次工具失败；第二轮批次中途取消。 */
  async function play(withRecorder: boolean): Promise<{ events: unknown[]; stored: { toolUseId: string; output: string; success: boolean; status: string }[] }> {
    const trace = new Trace();
    const gate = new Gate();
    const provider = new ScriptProvider([
      toolTurn([{ id: 'OK', name: 'fx_unknown', input: { tag: 'OK' } }, { id: 'BAD', name: 'fx_bad', input: { tag: 'BAD' } }]),
      toolTurn([{ id: 'C1', name: 'fx_unknown', input: { tag: 'C1', hold: true } }, { id: 'C2', name: 'fx_unknown', input: { tag: 'C2' } }]),
    ]);
    const tools = [fxUnknown({ trace, gateOf: i => (i.hold ? gate : undefined) }), gatedTool({ name: 'fx_bad', trace, fail: 'outcome' })];
    const normalize = (events: LoopEvent[]): unknown[] => events.map(e => (e.kind === 'messagePersisted' ? { kind: e.kind } : e));
    if (withRecorder) {
      const env = ledgerEnv('g7r');
      for (const t of tools) env.tools.register(t);
      const sid = env.newSession();
      const run = startRun(env, sid, provider);
      await trace.until('C1:enter');
      run.controller.abort();
      const events = await withDeadline(run.done, 5000, 'G7 带记录器');
      return { events: normalize(events), stored: resultsOf(env.store, sid) };
    }
    const env = loopEnv('g7');
    for (const t of tools) env.tools.register(t);
    const sid = env.newSession();
    const controller = new AbortController();
    const done = collect(runAgentLoop(env.store, {
      sessionId: sid, provider, tools: env.tools, systemPrompt: 'sys', signal: controller.signal,
      toolContext: { sessionId: sid, paths: env.paths, permissions: allowAll, signal: controller.signal },
      scheduler: new ToolScheduler(),
    }));
    await trace.until('C1:enter');
    controller.abort();
    const events = await withDeadline(done, 5000, 'G7 不带记录器');
    return { events: normalize(events), stored: resultsOf(env.store, sid) };
  }

  it('G7 事件序列与落库的 output / success 逐项相同；取消类结果的 status 不带时是 failed、带时是 cancelled', async () => {
    const bare = await play(false);
    const ledgered = await play(true);
    expect(ledgered.events).toEqual(bare.events);
    expect(ledgered.stored.map(r => [r.toolUseId, r.output, r.success])).toEqual(bare.stored.map(r => [r.toolUseId, r.output, r.success]));
    expect(bare.stored.map(r => [r.toolUseId, r.status])).toEqual([['OK', 'success'], ['BAD', 'failed'], ['C1', 'failed'], ['C2', 'failed']]);
    expect(ledgered.stored.map(r => [r.toolUseId, r.status])).toEqual([['OK', 'success'], ['BAD', 'failed'], ['C1', 'cancelled'], ['C2', 'cancelled']]);
  });
});

describe('F05 审批关联与放行落账', () => {
  it('G8 弹卡后的放行落账失败：工具得到拒绝、没有副作用；记一条 record-failed 的拒绝（带那张卡的 requestId 与 toolUseId）', async () => {
    const env = ledgerEnv('g8');
    const sid = env.newSession();
    const trace = new Trace();
    const counter = join(env.root, 'g8.log');
    env.tools.register(fxUnknown({ trace, ask: askShell }));
    const side = env.side();
    side.exec("CREATE TRIGGER f05_g8 BEFORE UPDATE OF approval_state ON tool_executions WHEN NEW.approval_state='allowed' BEGIN SELECT RAISE(ABORT, '注入：放行落账失败'); END");
    side.close();
    const gw = new IssuingGateway();
    const run = startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'S', name: 'fx_unknown', input: { tag: 'S', counter } }])]), { gateway: gw });
    await gw.untilCards(1);
    gw.allow('CARD-1');
    await withDeadline(run.done, 5000, 'G8');
    expect(trace.has('S:effect')).toBe(false);
    expect(existsSync(counter)).toBe(false);
    expect(gw.noted.map(n => [n.denied, n.opts?.toolUseId])).toEqual([[{ decision: 'deny', reason: 'invalidated', cause: 'record-failed', requestId: 'CARD-1' }, 'S']]);
    expect(resultsOf(env.store, sid).map(r => [r.success, r.status])).toEqual([[false, 'failed']]);
    // 行没有被记成「已放行」
    expect(execRows(env.db, sid)).toMatchObject([{ state: 'failed', approval_request_id: 'CARD-1' }]);
    expect(execRows(env.db, sid)[0].approval_state).not.toBe('allowed');
  });

  it('G8c 「本会话允许」之后放行落账失败：这张卡的会话授权被收回——同样的请求再来一次重新弹卡，不是不问就放行', async () => {
    const env = ledgerEnv('g8c');
    const sid = env.newSession();
    const trace = new Trace();
    const counter = join(env.root, 'g8c.log');
    // 三次调用问的是同一个请求（同会话、同 kind、同 detail）：会话授权按它记
    env.tools.register(fxUnknown({ trace, ask: (_i, ctx) => ({ kind: 'shell' as const, detail: 'same-command', sessionId: ctx.sessionId, toolTitle: 't' }) }));
    const side = env.side();
    side.exec("CREATE TRIGGER f05_g8c BEFORE UPDATE OF approval_state ON tool_executions WHEN NEW.approval_state='allowed' AND OLD.tool_use_id='S1' BEGIN SELECT RAISE(ABORT, '注入：放行落账失败'); END");
    side.close();
    // 真实网关：每次询问发一张卡（回报 requestId），用户答「本会话允许」
    const asked: string[] = [];
    const noted: unknown[] = [];
    const gw = new PermissionGatewayImpl(async (_req, ctl) => {
      const id = `CARD-${asked.length + 1}`;
      asked.push(id);
      ctl.issued?.(id);
      return { answer: 'allow-session', requestId: id };
    }, undefined, 90000, undefined, { onDenied: (_req, d, o) => { noted.push([d, o?.toolUseId]); } });
    const one = (id: string) => toolTurn([{ id, name: 'fx_unknown', input: { tag: id, counter } }]);
    const run = startRun(env, sid, new ScriptProvider([one('S1'), one('S2'), one('S3')]), { gateway: gw });
    await withDeadline(run.done, 5000, 'G8c');
    // S1：批准到了但没落账——没有执行，记一条 record-failed
    expect(trace.has('S1:effect')).toBe(false);
    expect(noted).toEqual([[{ decision: 'deny', reason: 'invalidated', cause: 'record-failed', requestId: 'CARD-1' }, 'S1']]);
    // S2：重新弹了卡（CARD-2），不是靠 CARD-1 留下的会话授权不问就过
    expect(trace.lines.filter(l => l.startsWith('S2:'))).toEqual(['S2:enter', 'S2:ask', 'S2:ret', 'S2:effect', 'S2:exit']);
    // S3：CARD-2 的「本会话允许」正常落了账，它的会话授权有效——不再弹卡。一共只问了两次
    expect(asked).toEqual(['CARD-1', 'CARD-2']);
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\n');
    expect(execRows(env.db, sid).map(r => [r.tool_use_id, r.state, r.approval_state, r.approval_request_id])).toEqual([
      ['S1', 'failed', 'denied', 'CARD-1'],
      ['S2', 'completed', 'allowed', 'CARD-2'],
      ['S3', 'completed', null, null],
    ]);
  });

  it('G8b 正常的审批往返：发卡时 awaiting-approval 带 requestId；放行后回到 running、approval=allowed；免审的放行不落审批字段', async () => {
    const env = ledgerEnv('g8b');
    const sid = env.newSession();
    const trace = new Trace();
    const counter = join(env.root, 'g8b.log');
    env.tools.register(fxUnknown({ trace, ask: askShell }));
    const gw = new IssuingGateway(req => (req.detail === 'FREE' ? 'free' : 'card'));
    const during: any[] = [];
    gw.onCard = () => { during.push(...execRows(env.db, sid).map(r => ({ id: r.tool_use_id, state: r.state, a: r.approval_state, req: r.approval_request_id, prior: r.prior_allows }))); };
    const run = startRun(env, sid, new ScriptProvider([toolTurn([
      { id: 'FREE', name: 'fx_unknown', input: { tag: 'FREE', counter } }, { id: 'CARD', name: 'fx_unknown', input: { tag: 'CARD', counter } },
    ])]), { gateway: gw });
    await gw.untilCards(1);
    expect(during).toEqual([
      { id: 'FREE', state: 'completed', a: null, req: null, prior: 0 },
      { id: 'CARD', state: 'awaiting-approval', a: 'pending', req: 'CARD-1', prior: 0 },
    ]);
    gw.allow('CARD-1');
    await withDeadline(run.done, 5000, 'G8b');
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\n');
    expect(execRows(env.db, sid)).toMatchObject([
      { state: 'completed', approval_state: null },
      { state: 'completed', approval_state: 'allowed', approval_request_id: 'CARD-1', approval_kind: 'shell' },
    ]);
  });

  it('G8d 取消先到、批准晚到（那一行已经落定）：不算放行落账失败——不记 record-failed、不收回这张卡的授权，只有取消赛跑层那一条「批准了却没执行」', async () => {
    const env = ledgerEnv('g8d');
    const sid = env.newSession();
    const trace = new Trace();
    const counter = join(env.root, 'g8d.log');
    env.tools.register(fxUnknown({ trace, ask: askShell }));
    // 不理会取消信号的网关：卡片一直挂着，由测试在调用落定之后才批准（同一拍里卡先被批准、取消紧跟着到的样子）
    let answer!: (o: PermissionOutcome) => void;
    let cardOut!: () => void;
    const issued = new Promise<void>(resolve => { cardOut = resolve; });
    const noted: PermissionDenied[] = [];
    const revoked: string[] = [];
    const decide = (_req: PermissionRequest, opts?: PermissionAskOptions): Promise<PermissionOutcome> => {
      const pending = new Promise<PermissionOutcome>(resolve => { answer = resolve; });
      opts?.onIssued?.('CARD-1');
      cardOut();
      return pending;
    };
    const gw: PermissionGateway = {
      decide,
      check: async req => (await decide(req)).decision,
      noteDenied: (_req, d) => { noted.push(d); },
      revokeGrant: req => { revoked.push(req.detail); },
      hasBridgeGrant: () => false,
    };
    const run = startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'S', name: 'fx_unknown', input: { tag: 'S', counter } }])]), { gateway: gw });
    await withDeadline(issued, 3000, 'G8d 发卡');
    run.controller.abort();
    await withDeadline(run.done, 5000, 'G8d');
    // 取消先到：工具拿到的是 cancelled，这一行已经落定并交付
    const before = execRows(env.db, sid)[0];
    expect(before).toMatchObject({ state: 'cancelled', end_kind: 'cancelled-during-run', approval_state: 'denied', approval_reason: 'cancelled', approval_request_id: 'CARD-1' });
    expect(before.delivered_at).not.toBeNull();
    expect(noted).toEqual([]);

    // 批准这时才到
    answer({ decision: 'allow', via: 'user-session', requestId: 'CARD-1' });
    for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
    // 「本会话允许」是用户真的点了的：不收回；审计里只有「批准了却没执行（已取消）」这一条，没有误导性的 record-failed
    expect(revoked).toEqual([]);
    expect(noted).toEqual([{ decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: 'CARD-1' }]);
    // 晚到的批准改不动已落定的行；工具没有执行
    expect(execRows(env.db, sid)[0]).toEqual(before);
    expect(trace.has('S:effect')).toBe(false);
    expect(existsSync(counter)).toBe(false);
  });
});

describe('F05 落定时的落库形态', () => {
  it('G9 超过卸载阈值的输出：落定那一刻行里就是桩，卸载文件是全文；offloaded 事件仍在 toolEnd 之前；落库的 part 与行里的一致', async () => {
    const env = ledgerEnv('g9');
    const sid = env.newSession();
    const big = 'B'.repeat(30_000);
    const gate = new Gate();
    const trace = new Trace();
    env.tools.register(gatedTool({ name: 'fx_big', trace, effect: () => big }));
    env.tools.register(fxUnknown({ trace, gateOf: () => gate }));
    const run = startRun(env, sid, new ScriptProvider([toolTurn([
      { id: 'BIG', name: 'fx_big', input: { tag: 'BIG' } }, { id: 'HOLD', name: 'fx_unknown', input: { tag: 'HOLD' } },
    ])]), { offload: new OffloadEngine(env.paths) });
    await trace.until('HOLD:enter');
    const row = execRows(env.db, sid)[0];
    expect(row).toMatchObject({ state: 'completed', result_offload_path: 'offloads/BIG.txt', result_chars: 30_000, delivered_at: null });
    expect(row.result_output.length).toBeLessThan(2000);
    expect(row.result_output).toContain('offloads/BIG.txt');
    expect(readFileSync(join(env.paths.sessionBucket(sid, 'offloads'), 'BIG.txt'), 'utf8')).toBe(big);
    gate.open();
    const events = await withDeadline(run.done, 5000, 'G9');
    const kinds = events.filter(e => (e.kind === 'offloaded' || e.kind === 'toolEnd') && e.toolUseId === 'BIG').map(e => e.kind);
    expect(kinds).toEqual(['offloaded', 'toolEnd']);
    // toolEnd 广播的是替换前的完整输出；落库的是桩，与账本里落定时存的逐字相同
    expect(events.find(e => e.kind === 'toolEnd' && e.toolUseId === 'BIG')).toMatchObject({ output: big });
    expect(resultsOf(env.store, sid)[0].output).toBe(row.result_output);
    expect(execRows(env.db, sid)[0]).toMatchObject({ result_output: null, result_offload_path: 'offloads/BIG.txt' });
  });

  it('G11 卸载文件写不进去：不丢结果、不让 run 失败——落库的是截断后的前一部分加一句说明，账本里落定时存的与历史里的是同一个字符串', async () => {
    const env = ledgerEnv('g11');
    const sid = env.newSession();
    const big = 'B'.repeat(30_000);
    const trace = new Trace();
    env.tools.register(gatedTool({ name: 'fx_big', trace, effect: () => big }));
    // 写卸载文件那一步失败（磁盘满 / 目录不可写的样子）；阈值判断、读回识别照真实引擎
    const real = new OffloadEngine(env.paths);
    let attempts = 0;
    const broken: OffloadEngine = Object.assign(Object.create(real) as OffloadEngine, {
      offload: (): never => { attempts += 1; throw new Error('注入：卸载文件写入失败'); },
    });
    const run = startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'BIG', name: 'fx_big', input: { tag: 'BIG' } }])]), { offload: broken });
    let atToolEnd: any;
    run.onEvent(e => { if (e.kind === 'toolEnd') atToolEnd = execRows(env.db, sid)[0]; });
    const events = await withDeadline(run.done, 5000, 'G11');
    expect(events.some(e => e.kind === 'turnEnd')).toBe(true);
    expect(events.some(e => e.kind === 'offloaded')).toBe(false);
    // toolEnd 广播的仍是完整输出；落库的是前 20000 个字符加说明
    expect(events.find(e => e.kind === 'toolEnd')).toMatchObject({ toolUseId: 'BIG', success: true, output: big });
    const stored = resultsOf(env.store, sid);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ toolUseId: 'BIG', success: true, status: 'success' });
    expect(stored[0].output).toBe('B'.repeat(20_000) + '\n[输出过长，卸载文件写入失败，后面的部分没有保存]');
    // 落定那一刻账本里就是这一份（恢复补写的也会是它）；卸载只试了一次，循环没有再算一遍
    expect(atToolEnd).toMatchObject({ state: 'completed', result_output: stored[0].output, result_offload_path: null, result_chars: 30_000, delivered_at: null });
    expect(attempts).toBe(1);
    expect(execRows(env.db, sid)).toMatchObject([{ state: 'completed', result_output: null }]);
    expect(runRows(env.db, sid)).toMatchObject([{ state: 'completed', active: null }]);
  });
});
