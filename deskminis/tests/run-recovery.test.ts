/**
 * F05 K 组：故障矩阵与恢复（进程内崩溃模型）。
 *
 * 在故障点同步取库快照（那一刻已提交状态的完整副本），原进程继续跑完；再在副本上开新一代账本做恢复。
 * 故障点全部取自实现之外：
 *   K-a 意图前      —— 消费循环事件，收到第一个 toolStart 时
 *   K-b 启动后      —— 工具进门那一刻（Trace 的 :enter）
 *   K-c 审批中      —— 权限卡发出、已回报给询问方之后
 *   K-d 副作用后    —— 工具的副作用回调里，做完副作用之后
 *   K-e 结果提交后  —— 收到第一个 toolEnd 时（结果消息还没落）
 *   K-f 结果消息后  —— 收到结果消息的 messagePersisted 时
 * 「没有执行」「只执行了一次」看工具侧：Trace 与计数文件的行数，不拿账本自己说的状态来证明。
 * 真实进程的强杀在 run-recovery-process.test.ts。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage, AgentStreamEvent, RawMessage } from '../src/shared/types';
import type { AgentProvider, StreamRequest } from '../src/minisd/providers/types';
import { buildAnthropicBody } from '../src/minisd/providers/anthropic';
import { buildOpenAIBody } from '../src/minisd/providers/openai';
import type { PermissionRequest, ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import { pairToolResults, runAgentLoop, toAgentMessages } from '../src/minisd/agent/loop';
import { OffloadEngine } from '../src/minisd/agent/offload';
import { ORPHAN_TEXT, classifyOrphan, recoverOnBoot } from '../src/minisd/agent/run-recovery';
import { CronStore } from '../src/minisd/cron/store';
import { MinisPaths } from '../src/minisd/paths';
import type { ChatStore } from '../src/minisd/store/chat-store';
import type { RunLedger } from '../src/minisd/store/run-ledger';
import { toWireMessage } from '../src/minisd/sync/wire';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ToolScheduler } from '../src/minisd/tools/scheduler';
import { TOOL_EXEC_STATES } from '../src/shared/run';
import { ScriptProvider, Trace, allowAll, collect, fxPure, fxRead, gatedTool, toolTurn, withDeadline } from './scheduler-fixture';
import { assertPaired } from './run-ledger-fixture';
import { HookTrace, IssuingGateway, execRows, ledgerEnv, openGeneration, recoverOn, resultsOf, runRows, startRun } from './run-recovery-fixture';
import { stripComments } from './strip-comments';

const PLACEHOLDER = '[工具执行被中断，结果未知]';
const askShell = (i: Record<string, unknown>, ctx: Pick<ToolContext, 'sessionId'>): PermissionRequest =>
  ({ kind: 'shell', detail: String(i.tag), sessionId: ctx.sessionId, toolTitle: 't' });

/** 一个会话 + 一个等同 shell 的工具（没有调度声明；副作用是往计数文件追加一行，输出是「<tag> 的真实输出」）。 */
function setup(label: string) {
  const env = ledgerEnv(label);
  const trace = new HookTrace();
  const sid = env.newSession();
  const counter = join(env.root, 'effects.log');
  /** 某个 tag 的副作用做完之后同步回调一次（K-d）。 */
  const afterEffect = new Map<string, () => void>();
  const effect = (input: Record<string, unknown>): string => {
    appendFileSync(counter, 'x\n', 'utf8');
    const tag = String(input.tag);
    const h = afterEffect.get(tag);
    afterEffect.delete(tag);
    h?.();
    return `${tag} 的真实输出`;
  };
  env.tools.register(gatedTool({ name: 'fx_shell', trace, effect }));
  env.tools.register(gatedTool({ name: 'fx_card', trace, effect, ask: askShell }));
  const count = (): number => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
  /** 取快照（只取第一次），同时记下那一刻的副作用次数与工具记录。 */
  const snap = { path: '', count: -1, trace: [] as string[] };
  const take = (): void => {
    if (snap.path) return;
    snap.count = count();
    snap.trace = [...trace.lines];
    snap.path = env.snapshot();
  };
  return { env, trace, sid, counter, afterEffect, count, snap, take };
}
const one = (name = 'fx_shell', id = 'T') => new ScriptProvider([toolTurn([{ id, name, input: { tag: id } }])]);

/** 记下每次请求的 messages、只回一段文本的 provider。 */
class CaptureProvider implements AgentProvider {
  readonly name = 'f05-capture'; readonly modelId = 'fake';
  readonly requests: AgentMessage[][] = [];
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    this.requests.push(req.messages);
    yield { kind: 'textDelta', text: '好的' };
    yield { kind: 'done', stopReason: 'endTurn' };
  }
}

/** 在恢复过的库上接着提问一轮（只回文本）。返回 provider 收到的请求与工具侧的记录。 */
async function continueTurn(chat: ChatStore, root: string, sid: string): Promise<{ sent: AgentMessage[]; trace: Trace }> {
  const trace = new Trace();
  const tools = new ToolRegistry();
  tools.register(gatedTool({ name: 'fx_shell', trace }));
  const last = chat.lastMessageRef(sid);
  chat.appendMessage({
    id: chat.newId(), sessionId: sid, role: 'user', parts: [{ type: 'text', value: '继续' }],
    createdAt: Math.max(chat.nowEpoch(), (last?.createdAt ?? 0) + 0.001), streamInterruptCount: 0,
  });
  const provider = new CaptureProvider();
  const events = await withDeadline(collect(runAgentLoop(chat, {
    sessionId: sid, provider, tools, systemPrompt: 'sys', scheduler: new ToolScheduler(),
    toolContext: { sessionId: sid, paths: new MinisPaths(root), permissions: allowAll },
  })), 5000, '恢复后的下一轮');
  expect(events.some(e => e.kind === 'turnEnd')).toBe(true);
  expect(provider.requests).toHaveLength(1);
  return { sent: provider.requests[0], trace };
}
const toolResultsIn = (ms: AgentMessage[]): { toolUseId: string; output: string }[] =>
  ms.flatMap(m => m.parts).filter(p => p.type === 'toolResult').map(p => p.value as { toolUseId: string; output: string });

/** 同批三个调用：A 已完成、B 做完副作用（K-d）、C 还在排队。 */
async function threeCallCrash(label: string) {
  const s = setup(label);
  const run = startRun(s.env, s.sid, new ScriptProvider([toolTurn([
    { id: 'A', name: 'fx_shell', input: { tag: 'A' } }, { id: 'B', name: 'fx_shell', input: { tag: 'B' } }, { id: 'C', name: 'fx_shell', input: { tag: 'C' } },
  ])]));
  s.afterEffect.set('B', s.take);
  await withDeadline(run.done, 5000, label);
  return s;
}

describe('F05 四个故障点（单个等同 shell 的调用）', () => {
  it('K1 意图前（K-a）：未执行，可重新调用；恢复不执行任何工具', async () => {
    const s = setup('k1');
    const run = startRun(s.env, s.sid, one());
    run.onEvent(e => { if (e.kind === 'toolStart') s.take(); });
    await withDeadline(run.done, 5000, 'K1');
    expect(s.snap.count).toBe(0);
    expect(s.snap.trace).toEqual([]);
    const lines = s.trace.lines.length; const total = s.count();

    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'cancelled', end_kind: 'not-started', started: 0 }]);
    expect(resultsOf(r.chat, s.sid)).toEqual([{ toolUseId: 'T', output: ORPHAN_TEXT['not-started'], success: false, status: 'cancelled' }]);
    expect(ORPHAN_TEXT['not-started']).toContain('[未执行]');
    expect(runRows(r.db, s.sid)).toMatchObject([{ state: 'interrupted', active: null, stop_reason: 'engine-crash', recovered_epoch: 2 }]);
    expect(r.report).toMatchObject({ epoch: 2, failed: [], sessions: [s.sid] });
    // 恢复之后工具侧没有任何新动静
    expect(s.trace.lines.length).toBe(lines);
    expect(s.count()).toBe(total);
  });

  it('K2 启动后（K-b）：结果未知，started 为真，落库 status 是 unknown', async () => {
    const s = setup('k2');
    s.trace.on('T:enter', s.take);
    await withDeadline(startRun(s.env, s.sid, one()).done, 5000, 'K2');
    expect(s.snap.count).toBe(0);
    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown', started: 1 }]);
    expect(resultsOf(r.chat, s.sid)).toEqual([{ toolUseId: 'T', output: ORPHAN_TEXT['effect-unknown'], success: false, status: 'unknown' }]);
    expect(ORPHAN_TEXT['effect-unknown']).toContain('[结果未知]');
    expect(ORPHAN_TEXT['effect-unknown']).toContain('不要直接重复执行');
  });

  it('K3 副作用后、结果提交前（K-d）：结果未知；副作用恰好一次，恢复后仍是一次', async () => {
    const s = setup('k3');
    s.afterEffect.set('T', s.take);
    await withDeadline(startRun(s.env, s.sid, one()).done, 5000, 'K3');
    expect(s.snap.count).toBe(1);
    const lines = s.trace.lines.length;
    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown', started: 1 }]);
    expect(resultsOf(r.chat, s.sid).map(x => x.status)).toEqual(['unknown']);
    expect(r.report.batches).toMatchObject([{ counts: { completed: 0, failed: 0, cancelled: 0, unknown: 1 }, superseded: false }]);
    expect(s.count()).toBe(1);
    expect(s.trace.lines.length).toBe(lines);
  });

  it('K4 结果提交后（K-e）：已完成，补的结果消息里是工具的真实输出', async () => {
    const s = setup('k4');
    const run = startRun(s.env, s.sid, one());
    run.onEvent(e => { if (e.kind === 'toolEnd') s.take(); });
    await withDeadline(run.done, 5000, 'K4');
    expect(s.snap.count).toBe(1);
    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'completed', end_kind: 'completed', result_output: null }]);
    expect(execRows(r.db, s.sid)[0].delivered_at).not.toBeNull();
    expect(resultsOf(r.chat, s.sid)).toEqual([{ toolUseId: 'T', output: 'T 的真实输出', success: true, status: 'success' }]);
    expect(s.count()).toBe(1);
  });

  it('K5 结果消息落库后（K-f）：恢复不追加任何消息，那次调用的结果恰好一条', async () => {
    const s = setup('k5');
    const run = startRun(s.env, s.sid, one());
    let persisted = 0;
    run.onEvent(e => { if (e.kind === 'messagePersisted' && ++persisted === 2) s.take(); });
    await withDeadline(run.done, 5000, 'K5');
    const r = recoverOn(s.snap.path);
    expect(r.report.batches).toEqual([]);
    expect(r.chat.listMessages(s.sid).map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(resultsOf(r.chat, s.sid).filter(x => x.toolUseId === 'T')).toHaveLength(1);
    // 那一刻 run 还活动着（等模型的下一次回复）：照样记成中断
    expect(runRows(r.db, s.sid)).toMatchObject([{ state: 'interrupted', stop_reason: 'engine-crash' }]);
  });
});

describe('F05 分类：只读、网络、审批', () => {
  it('K6 只读且无副作用的调用被打断（K-b）：cancelled / interrupted-readonly，说明可以重做', async () => {
    const s = setup('k6');
    s.env.tools.register(fxRead({ trace: s.trace }));
    const file = join(s.env.root, 'k6.txt');
    writeFileSync(file, '内容', 'utf8');
    s.trace.on('R:enter', s.take);
    await withDeadline(startRun(s.env, s.sid, new ScriptProvider([toolTurn([{ id: 'R', name: 'fx_read', input: { tag: 'R', path: file } }])])).done, 5000, 'K6');
    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'cancelled', end_kind: 'interrupted-readonly', started: 1, read_only: 1, side_effects: 'none' }]);
    expect(resultsOf(r.chat, s.sid)).toEqual([{ toolUseId: 'R', output: ORPHAN_TEXT['interrupted-readonly'], success: false, status: 'cancelled' }]);
    expect(ORPHAN_TEXT['interrupted-readonly']).toContain('可以重新调用');
  });

  it('K7 只读但会发网络请求的调用被打断（K-b）：结果未知，不当成可安全重查', async () => {
    const s = setup('k7');
    s.env.tools.register(fxPure({ trace: s.trace }));
    s.trace.on('N:enter', s.take);
    await withDeadline(startRun(s.env, s.sid, one('fx_pure', 'N')).done, 5000, 'K7');
    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown', read_only: 1, side_effects: 'network' }]);
  });

  it('K8 首次审批中（K-c）：未执行、审批过期有明确终态，审计补一条带那张卡 requestId 的 permission.resolved', async () => {
    const s = setup('k8');
    const gw = new IssuingGateway();
    gw.onCard = s.take;
    const run = startRun(s.env, s.sid, one('fx_card'), { gateway: gw });
    await gw.untilCards(1);
    gw.deny('CARD-1');
    await withDeadline(run.done, 5000, 'K8');
    expect(s.snap.count).toBe(0);
    expect(s.snap.trace).toEqual(['T:enter', 'T:ask']);

    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{
      state: 'cancelled', end_kind: 'approval-expired', approval_state: 'expired', approval_reason: 'invalidated', approval_cause: 'engine-restarted',
      approval_request_id: 'CARD-1', prior_allows: 0,
    }]);
    expect(resultsOf(r.chat, s.sid)).toEqual([{ toolUseId: 'T', output: ORPHAN_TEXT['approval-expired'], success: false, status: 'cancelled' }]);
    expect(r.audits.filter(a => a.type === 'permission.resolved')).toEqual([{
      type: 'permission.resolved', sessionId: s.sid,
      payload: { requestId: 'CARD-1', reason: 'invalidated', outcome: { decision: 'deny', reason: 'invalidated', cause: 'engine-restarted', requestId: 'CARD-1' }, toolUseId: 'T' },
    }]);
    expect(r.audits.filter(a => a.type === 'run.recovered')).toMatchObject([{ sessionId: s.sid, payload: { generation: 1, from: 'running', stopReason: 'engine-crash', counts: { cancelled: 1 }, superseded: false } }]);
    expect(r.report.batches).toMatchObject([{ expiredRequestIds: ['CARD-1'] }]);
  });

  it('K9 放行之后做了副作用（K-d）：结果未知——放行已落账，不会被说成「审批过期、未执行」', async () => {
    const s = setup('k9a');
    const gw = new IssuingGateway();
    const run = startRun(s.env, s.sid, one('fx_card'), { gateway: gw });
    await gw.untilCards(1);
    s.afterEffect.set('T', s.take);
    gw.allow('CARD-1');
    await withDeadline(run.done, 5000, 'K9a');
    expect(s.snap.count).toBe(1);
    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown', approval_state: 'allowed', approval_request_id: 'CARD-1' }]);
    expect(r.audits.filter(a => a.type === 'permission.resolved')).toEqual([]);
  });

  it('K9 先免审放行、动了手、再弹卡时中断（K-c，priorAllows=1）：结果未知，不判成未执行', async () => {
    const s = setup('k9b');
    const gw = new IssuingGateway(req => (req.detail === 'FREE' ? 'free' : 'card'));
    gw.onCard = s.take;
    const twice: ToolExecutor = {
      definition: { name: 'fx_twice', description: '问两次权限，中间动手', parameters: {}, required: [] },
      async execute(_input, ctx) {
        await ctx.permissions.check({ kind: 'shell', detail: 'FREE', sessionId: ctx.sessionId, toolTitle: 't' });
        appendFileSync(s.counter, 'x\n', 'utf8');
        const d = await ctx.permissions.check({ kind: 'shell', detail: 'CARD', sessionId: ctx.sessionId, toolTitle: 't' });
        return { output: `第二次询问：${d}`, success: d === 'allow' };
      },
    };
    s.env.tools.register(twice);
    const run = startRun(s.env, s.sid, one('fx_twice'), { gateway: gw });
    await gw.untilCards(1);
    gw.deny('CARD-1');
    await withDeadline(run.done, 5000, 'K9b');
    expect(s.snap.count).toBe(1);
    const before = new Database(s.snap.path, { readonly: true });
    expect(execRows(before, s.sid)).toMatchObject([{ state: 'awaiting-approval', prior_allows: 1, approval_request_id: 'CARD-1' }]);
    before.close();
    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown' }]);
    expect(resultsOf(r.chat, s.sid).map(x => x.status)).toEqual(['unknown']);
  });

  it('K14 classifyOrphan 真值表（含计划为空）', () => {
    const table = TOOL_EXEC_STATES.flatMap(state => [0, 1].flatMap(priorAllows => [
      { readOnly: true, sideEffects: 'none' }, { readOnly: true, sideEffects: 'network' }, { readOnly: false, sideEffects: 'local-files' }, {},
    ].map(plan => [state, priorAllows, plan.readOnly ?? '-', plan.sideEffects ?? '-', classifyOrphan({ state, priorAllows, ...plan })?.endKind ?? null])));
    const of = (state: string, prior: number, ro: unknown, se: unknown): unknown => table.find(r => r[0] === state && r[1] === prior && r[2] === ro && r[3] === se)![4];
    for (const prior of [0, 1]) {
      for (const [ro, se] of [[true, 'none'], [true, 'network'], [false, 'local-files'], ['-', '-']]) {
        expect(of('pending', prior, ro, se)).toBe('not-started');
        for (const done of ['completed', 'failed', 'cancelled', 'unknown']) expect(of(done, prior, ro, se)).toBeNull();
        expect(of('awaiting-approval', 0, ro, se)).toBe('approval-expired');
      }
      expect(of('running', prior, true, 'none')).toBe('interrupted-readonly');
      expect(of('running', prior, true, 'network')).toBe('effect-unknown');
      expect(of('running', prior, false, 'local-files')).toBe('effect-unknown');
      expect(of('running', prior, '-', '-')).toBe('effect-unknown');
    }
    expect(of('awaiting-approval', 1, true, 'none')).toBe('interrupted-readonly');
    expect(of('awaiting-approval', 1, false, 'local-files')).toBe('effect-unknown');
    expect(of('awaiting-approval', 1, '-', '-')).toBe('effect-unknown');
    // 恢复从不把任何状态判成已完成或失败
    expect(new Set(table.map(r => r[4]))).toEqual(new Set(['not-started', 'approval-expired', 'interrupted-readonly', 'effect-unknown', null]));
    expect(classifyOrphan({ state: 'running', priorAllows: 0 })).toEqual({ state: 'unknown', endKind: 'effect-unknown' });
    expect(classifyOrphan({ state: 'pending', priorAllows: 0 })).toEqual({ state: 'cancelled', endKind: 'not-started' });
  });
});

describe('F05 同批三种状态各归各、不重放', () => {
  it('K10 A 已完成、B 副作用后中断、C 排队：一条结果消息三个结果按调用顺序；C 从未进门', async () => {
    const s = await threeCallCrash('k10');
    expect(s.snap.count).toBe(2);
    expect(s.snap.trace.some(l => l.startsWith('C:'))).toBe(false);
    const r = recoverOn(s.snap.path);
    expect(execRows(r.db, s.sid)).toMatchObject([
      { tool_use_id: 'A', state: 'completed', end_kind: 'completed' },
      { tool_use_id: 'B', state: 'unknown', end_kind: 'effect-unknown' },
      { tool_use_id: 'C', state: 'cancelled', end_kind: 'not-started', started: 0 },
    ]);
    const msgs = r.chat.listMessages(s.sid);
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(resultsOf(r.chat, s.sid)).toEqual([
      { toolUseId: 'A', output: 'A 的真实输出', success: true, status: 'success' },
      { toolUseId: 'B', output: ORPHAN_TEXT['effect-unknown'], success: false, status: 'unknown' },
      { toolUseId: 'C', output: ORPHAN_TEXT['not-started'], success: false, status: 'cancelled' },
    ]);
    expect(execRows(r.db, s.sid).every(x => x.result_message_id === msgs[2].id && x.delivered_at !== null)).toBe(true);
    expect(r.report.batches).toMatchObject([{ counts: { completed: 1, failed: 0, cancelled: 1, unknown: 1 }, resultMessageId: msgs[2].id }]);
  });

  it('K12 恢复跑两次（再开一代）：第二次没有待处理的东西，消息不变', async () => {
    const s = await threeCallCrash('k12');
    const first = recoverOn(s.snap.path);
    const before = JSON.stringify(first.chat.listMessages(s.sid));
    first.db.close();
    const second = recoverOn(s.snap.path);
    expect(second.report).toMatchObject({ epoch: 3, runs: [], batches: [], cronJobs: [], sessions: [], failed: [] });
    expect(JSON.stringify(second.chat.listMessages(s.sid))).toBe(before);
    expect(second.audits).toEqual([]);
    expect(s.count()).toBe(3); // 原进程里 A、B、C 各一次；两次恢复都没有再执行
  });

  it('K15 恢复之后在同一会话再跑一轮：没有任何工具进门；请求里那一批每个调用紧跟各自的结果，各出现一次，没有占位', async () => {
    const s = await threeCallCrash('k15');
    const r = recoverOn(s.snap.path);
    const { sent, trace } = await continueTurn(r.chat, s.env.root, s.sid);
    expect(trace.lines).toEqual([]);
    expect(() => assertPaired(sent)).not.toThrow();
    expect(toolResultsIn(sent)).toEqual([
      expect.objectContaining({ toolUseId: 'A', output: '<tool-output>\nA 的真实输出\n</tool-output>' }),
      expect.objectContaining({ toolUseId: 'B', output: '<tool-output>\n' + ORPHAN_TEXT['effect-unknown'] + '\n</tool-output>' }),
      expect.objectContaining({ toolUseId: 'C', output: '<tool-output>\n' + ORPHAN_TEXT['not-started'] + '\n</tool-output>' }),
    ]);
    expect(JSON.stringify(sent)).not.toContain(PLACEHOLDER);
    expect(s.count()).toBe(3);
  });

  it('K11 输出超过卸载阈值（K-e）：补的结果是卸载桩，卸载文件是全文；与正常循环落库的那一份逐字相等', async () => {
    const s = setup('k11');
    const big = '大'.repeat(25_000);
    s.env.tools.register(gatedTool({ name: 'fx_big', trace: s.trace, effect: () => big }));
    const run = startRun(s.env, s.sid, one('fx_big', 'BIG'), { offload: new OffloadEngine(s.env.paths) });
    run.onEvent(e => { if (e.kind === 'toolEnd') s.take(); });
    await withDeadline(run.done, 5000, 'K11');
    const normal = resultsOf(s.env.store, s.sid);
    const r = recoverOn(s.snap.path);
    expect(resultsOf(r.chat, s.sid)).toEqual(normal);
    expect(normal[0].output.length).toBeLessThan(2000);
    expect(normal[0].output).toContain('/var/minis/offloads/BIG.txt');
    expect(readFileSync(join(s.env.paths.sessionBucket(s.sid, 'offloads'), 'BIG.txt'), 'utf8')).toBe(big);
    expect(execRows(r.db, s.sid)).toMatchObject([{ state: 'completed', result_offload_path: 'offloads/BIG.txt', result_output: null }]);
  });
});

describe('F05 结果消息只在 assistant 仍是最后一条时补；请求侧保证配对', () => {
  it('K13 那条 assistant 之后已有别的消息：恢复不写消息、只关账（superseded）；请求由 pairToolResults 给占位，配对合法', async () => {
    const s = setup('k13');
    s.afterEffect.set('T', s.take);
    await withDeadline(startRun(s.env, s.sid, one()).done, 5000, 'K13');
    const g = openGeneration(s.snap.path);
    const last = g.chat.lastMessageRef(s.sid)!;
    expect(last.role).toBe('assistant');
    g.chat.appendMessage({ id: g.chat.newId(), sessionId: s.sid, role: 'user', parts: [{ type: 'text', value: '另一台设备上接着说的话' }], createdAt: last.createdAt + 1, streamInterruptCount: 0 });
    const before = g.chat.listMessages(s.sid).length;

    const report = recoverOnBoot(g.deps);
    expect(report.failed).toEqual([]);
    expect(report.batches).toMatchObject([{ superseded: true, counts: { unknown: 1 } }]);
    expect(report.batches[0].resultMessageId).toBeUndefined();
    expect(report.sessions).toEqual([]);
    expect(g.chat.listMessages(s.sid)).toHaveLength(before);
    const row = execRows(g.db, s.sid)[0];
    expect(row).toMatchObject({ state: 'unknown', result_message_id: null });
    expect(row.delivered_at).not.toBeNull();
    expect(g.ledger.snapshot({ sessionId: s.sid }).executions).toMatchObject([{ state: 'unknown', delivered: true }]);
    expect(g.ledger.snapshot({ sessionId: s.sid }).executions[0].resultMessageId).toBeUndefined();

    const sent = pairToolResults(toAgentMessages(g.chat.listMessages(s.sid)));
    expect(() => assertPaired(sent)).not.toThrow();
    expect(toolResultsIn(sent)).toEqual([expect.objectContaining({ toolUseId: 'T', output: PLACEHOLDER })]);
  });

  it('K20 恢复补写之后才合并进来的对端消息把结果隔开：存储不动；请求里那次调用恰有一个紧邻的结果（占位），两家 provider 的请求体都合法', async () => {
    const s = setup('k20');
    s.afterEffect.set('T', s.take);
    await withDeadline(startRun(s.env, s.sid, one()).done, 5000, 'K20');
    const r = recoverOn(s.snap.path);
    const [, assistant, recovered] = r.chat.listMessages(s.sid);
    expect(recovered.parts[0]).toMatchObject({ type: 'toolResult', value: { toolUseId: 'T', status: 'unknown' } });

    // 另一台设备在本机停着的时候接着聊了两条，时间落在那条 assistant 与补写的结果之间
    const gap = recovered.createdAt - assistant.createdAt;
    expect(gap).toBeGreaterThan(0);
    const peer = (id: string, role: RawMessage['role'], text: string, at: number): RawMessage => ({
      id, sessionId: s.sid, role, parts: [{ type: 'text', value: text }], createdAt: at, updatedAt: at, sortOrder: 0,
      streamInterruptCount: 0, originDeviceId: 'PEER-DEVICE', createdLocallyAt: at,
    });
    const merged = r.chat.mergeRemoteSession({
      messages: [peer('PEER-U', 'user', '对端的提问', assistant.createdAt + gap / 3), peer('PEER-A', 'assistant', '对端的回复', assistant.createdAt + (2 * gap) / 3)].map(toWireMessage),
      markers: [],
    }, s.sid);
    expect(merged.mergedCount).toBe(2);
    // 前提：补写的结果确实被隔开了
    expect(r.chat.listMessages(s.sid).map(m => m.id).slice(1)).toEqual([assistant.id, 'PEER-U', 'PEER-A', recovered.id]);

    const { sent, trace } = await continueTurn(r.chat, s.env.root, s.sid);
    expect(trace.lines).toEqual([]);
    expect(() => assertPaired(sent)).not.toThrow();
    expect(toolResultsIn(sent)).toEqual([expect.objectContaining({ toolUseId: 'T', output: '<tool-output>\n' + PLACEHOLDER + '\n</tool-output>' })]);
    expect(JSON.stringify(sent)).not.toContain('[结果未知]');

    // 两家的请求体：没有不跟在对应 tool_use / tool_calls 后面的 tool_result / role:'tool'
    const req: StreamRequest = { messages: sent, tools: [], maxTokens: 1000, thinkingLevel: 'off', systemPrompt: 'sys' };
    const oa = (buildOpenAIBody(req, 'm').messages as any[]);
    oa.forEach((m, i) => {
      if (m.role !== 'tool') return;
      let j = i - 1;
      while (j >= 0 && oa[j].role === 'tool') j--;
      expect(oa[j]?.role).toBe('assistant');
      expect((oa[j].tool_calls as any[]).map(c => c.id)).toContain(m.tool_call_id);
    });
    expect(oa.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['T']);
    const an = (buildAnthropicBody(req, 'm').messages as any[]);
    let anthropicResults = 0;
    an.forEach((m, i) => {
      for (const b of (Array.isArray(m.content) ? m.content : []) as any[]) {
        if (b.type !== 'tool_result') continue;
        anthropicResults++;
        expect(an[i - 1]?.role).toBe('assistant');
        expect((an[i - 1].content as any[]).filter(x => x.type === 'tool_use').map(x => x.id)).toContain(b.tool_use_id);
      }
    });
    expect(anthropicResults).toBe(1);

    // 存储里补写的那条原样还在（界面按 toolUseId 配结果，照常显示它）
    expect(r.chat.listMessages(s.sid).find(m => m.id === recovered.id)?.parts).toEqual(recovered.parts);
  });

  it('K18 没有账本行的旧孤儿 toolUse（F05 之前留下的）：恢复不动它', () => {
    const env = ledgerEnv('k18');
    const sid = env.newSession();
    const at = env.store.nowEpoch();
    env.store.appendMessage({ id: 'U', sessionId: sid, role: 'user', parts: [{ type: 'text', value: '旧会话' }], createdAt: at, streamInterruptCount: 0 });
    env.store.appendMessage({ id: 'A', sessionId: sid, role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'OLD', name: 'shell_execute', input: '{}' } }], createdAt: at + 1, streamInterruptCount: 0 });
    const before = JSON.stringify(env.store.listMessages(sid));
    const r = recoverOn(env.snapshot());
    expect(r.report).toMatchObject({ runs: [], batches: [], failed: [] });
    expect(JSON.stringify(r.chat.listMessages(sid))).toBe(before);
  });
});

describe('F05 恢复的容错与边界', () => {
  /** 两个会话各有一批没交付的调用（直接用账本原语造，不跑循环）。 */
  function twoOpenBatches(label: string) {
    const env = ledgerEnv(label);
    const make = (toolUseId: string): string => {
      const sid = env.newSession();
      const run = env.ledger.beginRun({ sessionId: sid, origin: { kind: 'user' } });
      run.started(() => env.store.appendMessage({ id: env.store.newId(), sessionId: sid, role: 'user', parts: [{ type: 'text', value: '开始' }], createdAt: env.store.nowEpoch(), streamInterruptCount: 0 }));
      env.ledger.atomic(() => {
        const m = env.store.appendMessage({
          id: env.store.newId(), sessionId: sid, role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId, name: 'fx_shell', input: '{}' } }],
          createdAt: env.store.nowEpoch() + 0.001, streamInterruptCount: 0,
        });
        const { rowIds } = env.ledger.openBatch(run.ref.runId, m.id, [{ toolUseId, name: 'fx_shell' }]);
        env.ledger.beginExecution(rowIds[0], { name: 'fx_shell', barrier: true, readOnly: false, sideEffects: 'unknown', claims: [], writePaths: [] });
      });
      return sid;
    };
    return { env, x: make('X1'), y: make('Y1') };
  }

  it('K16 一批的恢复事务失败：其余批照常，该 run 仍被记成 interrupted；用户继续之后下一次恢复只关账', () => {
    const { env, x, y } = twoOpenBatches('k16');
    const path = env.snapshot();
    const g = openGeneration(path);
    g.db.exec(`CREATE TRIGGER f05_k16 BEFORE UPDATE OF delivered_at ON tool_executions WHEN OLD.session_id='${x}' BEGIN SELECT RAISE(ABORT, '注入：关账失败'); END`);
    const report = recoverOnBoot(g.deps);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].what).toContain('收口工具批次');
    expect(report.failed[0].error).toContain('注入：关账失败');
    expect(g.warns.length).toBeGreaterThan(0);
    // Y 照常：补了结果消息
    expect(resultsOf(g.chat, y).map(r => [r.toolUseId, r.status])).toEqual([['Y1', 'unknown']]);
    // X 的事务整体回滚：行原样、没有消息
    expect(execRows(g.db, x)).toMatchObject([{ state: 'running', delivered_at: null }]);
    expect(resultsOf(g.chat, x)).toEqual([]);
    // 两个 run 都被记成中断：会话不被活动索引占着
    expect(runRows(g.db, x)).toMatchObject([{ state: 'interrupted', active: null }]);
    expect(runRows(g.db, y)).toMatchObject([{ state: 'interrupted', active: null }]);

    // 用户在 X 里继续提问（那一批由 pairToolResults 给占位），之后再启动一次
    g.db.exec('DROP TRIGGER f05_k16');
    const last = g.chat.lastMessageRef(x)!;
    g.chat.appendMessage({ id: g.chat.newId(), sessionId: x, role: 'user', parts: [{ type: 'text', value: '继续' }], createdAt: last.createdAt + 1, streamInterruptCount: 0 });
    g.db.close();
    const next = recoverOn(path);
    expect(next.report.failed).toEqual([]);
    expect(next.report.batches).toMatchObject([{ sessionId: x, superseded: true, counts: { unknown: 1 } }]);
    expect(resultsOf(next.chat, x)).toEqual([]);
    expect(execRows(next.db, x)).toMatchObject([{ state: 'unknown', result_message_id: null }]);
    expect(next.db.prepare('SELECT COUNT(*) n FROM tool_executions WHERE delivered_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('K17 源码守卫：run-recovery.ts 引不到任何执行入口', () => {
    const code = stripComments(readFileSync(join(__dirname, '..', 'src', 'minisd', 'agent', 'run-recovery.ts'), 'utf8'));
    const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
    expect(imports).toEqual(['../../shared/permission', '../../shared/run', '../../shared/types', '../cron/store', '../store/chat-store', '../store/run-ledger']);
    for (const banned of ['tools/registry', 'tools/scheduler', 'tools/shell', 'tools/files', 'tools/web', 'mcp/', './loop']) expect(imports.join('\n')).not.toContain(banned);
    // 只引类型的三个模块都是 import type（运行期一个执行器都拿不到）
    for (const m of ['../cron/store', '../store/chat-store', '../store/run-ledger', '../../shared/types']) expect(code).toMatch(new RegExp(`import type \\{[^}]*\\} from '${m.replace(/[./]/g, '\\$&')}'`));
    expect(code).not.toMatch(/\.execute\(|runBatch\(|runAgentLoop\(|\.run\(/);
  });

  it('K19 定时任务收口：running、running（…）改成「运行被中断」；skipped-running、ok、error 不动', () => {
    const env = ledgerEnv('k19');
    const cron = new CronStore(env.db);
    const mk = (status: string): string => {
      const j = cron.create({ name: `任务 ${status.slice(0, 6)}`, prompt: 'p', scheduleKind: 'interval', scheduleValue: '60' });
      cron.markDone(j.id, status);
      return j.id;
    };
    const ids = [mk('running'), mk('running（助手已删，按无助手跑）'), mk('skipped-running：上一次触发还在运行'), mk('ok'), mk('error: 之前的失败'), mk('')];
    const r = recoverOn(env.snapshot());
    const status = (id: string): string => r.cron.list().find(j => j.id === id)!.lastStatus;
    expect(status(ids[0])).toBe('error: 运行被中断（应用退出或重启），没有自动重跑');
    expect(status(ids[1])).toBe('error: 运行被中断（应用退出或重启），没有自动重跑');
    expect(ids.slice(2).map(status)).toEqual(['skipped-running：上一次触发还在运行', 'ok', 'error: 之前的失败', '']);
    expect(r.report.cronJobs).toEqual([ids[0], ids[1]]);
    // 不补跑：没有新会话、没有新 run
    expect(r.db.prepare('SELECT COUNT(*) n FROM agent_runs').get()).toEqual({ n: 0 });
  });

  it('K21 recoverOnBoot 从不抛：四种失败各注入一次，其余步骤照做；不注入再跑一次，剩下的被收掉', async () => {
    const s = await threeCallCrash('k21');
    // 快照之前原进程已经跑完；把两个 running 的定时任务补进快照的各份副本
    const copies = [1, 2, 3, 4, 5].map(i => { const p = join(s.env.root, `k21-${i}.db`); copyFileSync(s.snap.path, p); return p; });
    const jobs: string[] = [];
    for (const p of copies) {
      const g = openGeneration(p);
      // 这一代只用来布置数据：立刻有序封账，免得它自己被当成崩溃的前代（它没有 run）
      for (const name of ['甲', '乙']) {
        const id = `JOB-${name}`;
        g.db.prepare("INSERT INTO cron_jobs (id, name, prompt, schedule_kind, schedule_value, enabled, last_status, created_at, updated_at) VALUES (?,?,?,?,?,0,'running',?,?)")
          .run(id, name, 'p', 'interval', '60', name === '甲' ? 1 : 2, 1);
        if (!jobs.includes(id)) jobs.push(id);
      }
      g.ledger.close();
      g.db.close();
    }
    const settled = (g: ReturnType<typeof openGeneration>) => ({
      activeRuns: (g.db.prepare('SELECT COUNT(*) n FROM agent_runs WHERE active=1').get() as { n: number }).n,
      openRows: (g.db.prepare('SELECT COUNT(*) n FROM tool_executions WHERE delivered_at IS NULL').get() as { n: number }).n,
      results: resultsOf(g.chat, s.sid).length,
      cron: g.cron.list().map(j => j.lastStatus.startsWith('error: 运行被中断')),
    });
    const boom = (what: string) => (): never => { throw new Error(`注入：${what}`); };

    // ① 列批次失败：run 仍被记成中断，定时任务仍收口
    let g = openGeneration(copies[0]);
    // 转发到真实账本、只有一个方法抛错的包装
    let bad: RunLedger = Object.assign(Object.create(g.ledger) as RunLedger, { listOpenBatches: boom('列批次') });
    let report = recoverOnBoot({ ...g.deps, ledger: bad });
    expect(report.failed.map(f => f.what)).toEqual(['列出未交付的工具批次']);
    expect(settled(g)).toEqual({ activeRuns: 0, openRows: 3, results: 0, cron: [true, true] });
    g.db.close();

    // ② 列 run 失败：批次仍补了结果消息，定时任务仍收口
    g = openGeneration(copies[1]);
    bad = Object.assign(Object.create(g.ledger) as RunLedger, { listOrphanRuns: boom('列 run') });
    report = recoverOnBoot({ ...g.deps, ledger: bad });
    expect(report.failed.map(f => f.what)).toEqual(['列出被中断的运行']);
    expect(settled(g)).toEqual({ activeRuns: 1, openRows: 0, results: 3, cron: [true, true] });
    g.db.close();

    // ③ 列定时任务失败：前两步照做
    g = openGeneration(copies[2]);
    report = recoverOnBoot({ ...g.deps, cron: { list: boom('列任务'), markDone: (id, st) => g.cron.markDone(id, st) } });
    expect(report.failed.map(f => f.what)).toEqual(['列出定时任务']);
    expect(settled(g)).toEqual({ activeRuns: 0, openRows: 0, results: 3, cron: [false, false] });
    g.db.close();

    // ④ 第一个任务的收口失败：第二个仍收口
    g = openGeneration(copies[3]);
    const g4 = g;
    report = recoverOnBoot({ ...g.deps, cron: { list: () => g4.cron.list(), markDone: (id, st) => { if (id === jobs[0]) throw new Error('注入：任务甲'); g4.cron.markDone(id, st); } } });
    expect(report.failed.map(f => f.what)).toEqual([`收口定时任务 ${jobs[0]}`]);
    expect(report.cronJobs).toEqual([jobs[1]]);
    expect(settled(g)).toEqual({ activeRuns: 0, openRows: 0, results: 3, cron: [false, true] });
    g.db.close();

    // 每一份都不注入再跑一次：剩下的被收掉，failed 为空
    for (const p of copies.slice(0, 4)) {
      const again = recoverOn(p);
      expect(again.report.failed).toEqual([]);
      expect(settled(again)).toEqual({ activeRuns: 0, openRows: 0, results: 3, cron: [true, true] });
      again.db.close();
    }

    // 一行坏数据（claims_json / write_paths_json 不是合法 JSON）不让扫描失败：该批照常恢复
    const raw = new Database(copies[4]);
    raw.prepare("UPDATE tool_executions SET claims_json='{oops', write_paths_json='不是 JSON'").run();
    raw.close();
    const last = recoverOn(copies[4]);
    expect(last.report.failed).toEqual([]);
    expect(last.report.batches).toMatchObject([{ counts: { completed: 1, cancelled: 1, unknown: 1 } }]);
    expect(last.ledger.snapshot({ sessionId: s.sid }).executions.map(e => e.artifacts.writePaths)).toEqual([[], [], []]);
  });

  it('K22 单个 run 的收口失败、审计写入失败都各自兜住：其余 run 与定时任务照常收口，不落到最外层的兜底', () => {
    const { env, x, y } = twoOpenBatches('k22');
    // X 的那次调用停在首次审批上（恢复要为它补一条 permission.resolved 审计）；外加一个 running 的定时任务
    env.ledger.approvalIssued(execRows(env.db, x)[0].id, { requestId: 'CARD-X', kind: 'shell', priorAllows: 0 });
    const cron0 = new CronStore(env.db);
    const job = cron0.create({ name: '任务', prompt: 'p', scheduleKind: 'interval', scheduleValue: '60' });
    cron0.markDone(job.id, 'running');
    const first = env.snapshot();
    const second = join(env.root, 'k22-b.db');
    copyFileSync(first, second);
    const state = (g: ReturnType<typeof openGeneration>) => ({
      x: runRows(g.db, x).map(r => r.state), y: runRows(g.db, y).map(r => r.state),
      results: [...resultsOf(g.chat, x), ...resultsOf(g.chat, y)].map(r => [r.toolUseId, r.status]),
      cron: g.cron.list().map(j => j.lastStatus.startsWith('error: 运行被中断')),
    });
    const settledAll = { x: ['interrupted'], y: ['interrupted'], results: [['X1', 'cancelled'], ['Y1', 'unknown']], cron: [true] };

    // ① X 的 run 收口抛错：记进 failed（指名是哪个 run，不是兜底的「启动恢复」），Y 的 run 照样记成中断，定时任务照样收口
    const g1 = openGeneration(first);
    const runX = g1.ledger.listOrphanRuns().find(r => r.sessionId === x)!;
    const bad: RunLedger = Object.assign(Object.create(g1.ledger) as RunLedger, {
      interruptRun: (id: string, i: Parameters<RunLedger['interruptRun']>[1]): void => {
        if (id === runX.runId) throw new Error('注入：收口 run');
        g1.ledger.interruptRun(id, i);
      },
    });
    let report = recoverOnBoot({ ...g1.deps, ledger: bad });
    expect(report.failed).toEqual([{ what: `收口运行 ${runX.runId}`, error: 'Error: 注入：收口 run' }]);
    expect(report.runs.map(r => r.sessionId)).toEqual([y]);
    expect(report.cronJobs).toEqual([job.id]);
    expect(state(g1)).toEqual({ ...settledAll, x: ['running'] });
    g1.db.close();
    // 没收掉的那个 run 下次启动时收口，别的不再动
    const again = recoverOn(first);
    expect(again.report.failed).toEqual([]);
    expect(again.report.runs.map(r => r.sessionId)).toEqual([x]);
    expect(state(again)).toEqual(settledAll);
    again.db.close();

    // ② 审计一写就抛（permission.resolved 与 run.recovered 两处）：只告警、不记进 failed，批次、run、定时任务全部照常收口
    const g2 = openGeneration(second);
    report = recoverOnBoot({ ...g2.deps, audit: () => { throw new Error('注入：审计写入失败'); } });
    expect(report.failed).toEqual([]);
    expect(Object.fromEntries(report.batches.map(b => [b.sessionId, b.expiredRequestIds]))).toEqual({ [x]: ['CARD-X'], [y]: [] });
    expect(report.runs.map(r => r.sessionId).sort()).toEqual([x, y].sort());
    expect(report.cronJobs).toEqual([job.id]);
    expect(state(g2)).toEqual(settledAll);
    expect(g2.warns.filter(w => w.includes('过期权限请求的审计写入失败'))).toHaveLength(1);
    expect(g2.warns.filter(w => w.includes('run.recovered 审计写入失败'))).toHaveLength(2);
    g2.db.close();
  });
});
