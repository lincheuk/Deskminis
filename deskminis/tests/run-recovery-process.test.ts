// Q07：此文件含已知受高负载影响的真实进程或计时用例；保留原断言，无自动重试。见 docs/TESTING.md。
/**
 * F05 R 组：真实进程的强杀与重启（任务卡验收 5）。
 *
 * 四个引擎进程，同一个临时数据根，按顺序跑：
 *  R1 第一代：每个故障点一个独立会话，逐个确认它确实停在那个点上，然后强杀引擎；
 *  R2 第二代：重启后断言账本状态、历史里的结果、真实副作用的次数（不重放、不自动续跑）；
 *  R3 第二代上有脚本正在执行时有序关停（发 shutdown、不强杀、等它自己退出）；
 *  R4 第三代：再次启动幂等——有序关停之后没有任何恢复动作；
 *  R5 第三代上「关停中」强杀：先从外面确认引擎已经进了关停，再结束它；
 *  R6 第四代：按 R5 实际停在的那一步逐分支核对，再有序关停。
 * R5 的落点是一场赛跑（关停从开始到走完只有两三百毫秒），可能落在「run 还没停下」「run 已收尾但没封账」「关停已走完」
 * 任何一步；用例记下实际落点，对每个分支各有一套严格的断言，不用并集。
 *
 * 为什么算证据：副作用是引擎之外的真实进程（PowerShell）写的真实文件，计数在引擎被结束之后由测试进程直接读盘；
 * 引擎各代之间没有任何共享内存；产品里没有故障开关，故障点全部由外部强杀命中。
 * 模型是测试进程里的假端点（OpenAI 兼容），它跨代存活，所以能断言「重启后引擎有没有再请求模型」。
 *
 * 本文件不引任何 F05 的新模块：只经 RPC、直接读库、读文件系统断言。强杀前的故障点确认以外部信号为主
 * （计数文件、权限卡广播、假端点收到的请求），chat.runs.snapshot 的核对在方法不存在时跳过。
 *
 * 需要 PowerShell 的会话（S1、S2、S3、S7、S8）只在 Windows 上跑，其它平台跳过对应用例。
 * 强杀只按 PID 结束测试自己起的引擎（Windows 上 taskkill /PID <引擎> /F）；它起的 PowerShell 驱动是直接子进程，
 * 随引擎的作业对象一并结束，不再另按 pid 去杀（见 run-ledger-fixture.ts 的 killTree）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoAllow, cardsOf, eventsOf, gatedScript, killTree, lines, mockLlm, pidAlive, readDb, rpcClient, runsSnapshot,
  sleep, spawnEngine, waitFor, type Client, type Engine, type LlmStep,
} from './run-ledger-fixture';

const HAS_PS = process.platform === 'win32';

const root = mkdtempSync(join(tmpdir(), 'dm-f05-r-'));
const dataDir = join(root, 'data');
const W1 = join(root, 'w1'); const W2 = join(root, 'w2'); const W4 = join(root, 'w4'); const W7 = join(root, 'w7'); const W8 = join(root, 'w8');
const FX1 = join(root, 'fx1'); const FX3 = join(root, 'fx3'); const FX7 = join(root, 'fx7'); const FX8 = join(root, 'fx8');
for (const d of [dataDir, W1, W2, W4, W7, W8, FX1, FX3, FX7, FX8]) mkdirSync(d, { recursive: true });

const SKILL_S4 = join(dataDir, 'skills', 'f05', 'note.md');
const SKILL_S5 = join(dataDir, 'skills', 'f05c', 'note.md');
const P6 = 'f05-r-p6-0001';
const TEXT = {
  S0: '[[S0]] 只问一个问题', S1: '[[S1]] 跑带闸脚本', S2: '[[S2]] 追加一行', S3: '[[S3]] 一批三个调用',
  S4: '[[S4]] 一批两个写入', S5: '[[S5]] 定时写技能目录', S6: '[[S6]] 写一个文件', S7: '[[S7]] 关停时在跑的脚本',
  S8: '[[S8]] 关停中被杀时在跑的脚本',
};
const scripts: Record<string, LlmStep[]> = {
  S0: [{ hang: true }],
  S1: [{ tools: [{ name: 'shell_execute', input: { command: gatedScript(FX1), tool_title: '带闸脚本' } }] }, { text: 'S1 续跑完成' }],
  S2: [{ tools: [{ name: 'shell_execute', input: { command: `Add-Content -LiteralPath '${W1}\\effects-b.log' -Value 'b'`, tool_title: '追加一行' } }] }, { text: 'S2 完成' }],
  S3: [{
    tools: [
      { name: 'file_write', input: { path: 'w.txt', content: 'W 的内容', tool_title: '写 w' } },
      { name: 'shell_execute', input: { command: gatedScript(FX3), tool_title: '带闸脚本' } },
      { name: 'file_write', input: { path: 'z.txt', content: 'Z 的内容', tool_title: '写 z' } },
    ],
  }, { text: 'S3 完成' }],
  S4: [{
    tools: [
      { name: 'file_write', input: { path: 'w2.txt', content: 'W2 的内容', tool_title: '写 w2' } },
      { name: 'file_write', input: { path: '/var/minis/skills/f05/note.md', content: '不该落盘', tool_title: '写技能目录' } },
    ],
  }, { text: 'S4 完成' }],
  S5: [{ tools: [{ name: 'file_write', input: { path: '/var/minis/skills/f05c/note.md', content: '不该落盘', tool_title: '定时写技能目录' } }] }, { text: 'S5 完成' }],
  S6: [{ tools: [{ name: 'file_write', input: { path: 's6.txt', content: 'S6 的内容', tool_title: '写 s6' } }] }, { hang: true }],
  S7: [{ tools: [{ name: 'shell_execute', input: { command: gatedScript(FX7), tool_title: '带闸脚本' } }] }, { text: 'S7 完成' }],
  S8: [{ tools: [{ name: 'shell_execute', input: { command: gatedScript(FX8), tool_title: '带闸脚本' } }] }, { text: 'S8 完成' }],
};

let llm: Awaited<ReturnType<typeof mockLlm>>;
const engines: Engine[] = [];
const clients: Client[] = [];
/** 走到了第几步（1 = 第一代已布置并强杀，2 = 第二代已起，3 = 第二代已有序关停退出，4 = 第三代已起，5 = 第三代已在关停中被强杀）。
 *  前一步没成，后面的用例直接失败。 */
let stage = 0;
const need = (n: number): void => { if (stage < n) throw new Error(`前置步骤没有完成（需要 ${n}，当前 ${stage}）`); };

const S: Record<string, string> = {};
let cronJobId = '';
let s4RequestId = ''; let s5RequestId = '';
let wMtime = 0;
let hitsAtRestart = 0; let sessionsAtRestart = 0;
let stateAfterR2 = '';

type Part = { type: string; value: any };
type Msg = { id: string; role: string; parts: Part[] };
/** R3 结束（第二代有序关停退出）时 S7 的消息，直接读库得到；R4、R6 拿它核对「之后的启动没有动过它」。 */
let s7Messages: Msg[] = [];
/** R5 强杀之后、第四代启动之前直接读库得到的落点。 */
let s8Crash: {
  seen: string; exitCode: number | null; closeKind: string | null;
  run: { state: string; active: number | null; stop_reason: string | null };
  row: { state: string; end_kind: string | null; delivered: boolean };
} | undefined;
async function messagesOf(c: Client, sessionId: string): Promise<Msg[]> {
  return (await c.call('chat.messages.list', { sessionId })).result as Msg[];
}
/** 直接读库里的消息（引擎不在时也能读；顺序与 chat.messages.list 相同）。 */
const rawMessages = (sessionId: string): Msg[] =>
  readDb(dataDir, 'SELECT id, role, parts_json FROM messages WHERE session_id=? ORDER BY created_at, id', sessionId)
    .map(r => ({ id: r.id, role: r.role, parts: JSON.parse(r.parts_json) as Part[] }));
/** S0–S6 的会话 id（R2 结束时已有的那些；S7、S8 是后来建的）。 */
const s0to6 = (): string[] => Object.entries(S).filter(([k]) => k !== 'S7' && k !== 'S8').map(([, id]) => id);
const resultsIn = (msgs: Msg[]): any[] => msgs.flatMap(m => m.parts).filter(p => p.type === 'toolResult').map(p => p.value);
const rowsOf = (sessionId: string): any[] =>
  readDb(dataDir, 'SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sessionId);
const latestRun = (sessionId: string): any =>
  readDb(dataDir, 'SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation DESC LIMIT 1', sessionId)[0];
async function prompt(c: Client, sessionId: string, text: string, promptId?: string): Promise<any> {
  const r = await c.call('chat.prompt', { sessionId, text, ...(promptId ? { promptId } : {}) });
  expect(r.error).toBeUndefined();
  return r.result;
}
/** 各会话的消息数与账本行（R4 用它核对「再次启动幂等」）。 */
function ledgerState(counts: Record<string, number>): string {
  const rows = readDb(dataDir, 'SELECT session_id, batch, call_index, state, end_kind, started, delivered_at IS NOT NULL AS delivered, result_message_id FROM tool_executions ORDER BY session_id, run_id, batch, call_index');
  const runs = readDb(dataDir, 'SELECT session_id, generation, epoch, state, stop_reason, recovered_epoch FROM agent_runs ORDER BY session_id, generation');
  return JSON.stringify({ counts, rows, runs });
}
async function countsOf(c: Client, ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (await messagesOf(c, id)).length;
  return out;
}

beforeAll(async () => { llm = await mockLlm(scripts); });

afterAll(async () => {
  // 证据打进日志（验证附件，不进产品补丁）：各计数文件与三张表的导出
  try {
    const dump = {
      sessions: S,
      startedLog: { S1: lines(join(FX1, 'started.log')), S3: lines(join(FX3, 'started.log')), S7: lines(join(FX7, 'started.log')), S8: lines(join(FX8, 'started.log')) },
      effectsLog: { S1: lines(join(FX1, 'effects.log')), S3: lines(join(FX3, 'effects.log')), S7: lines(join(FX7, 'effects.log')), S8: lines(join(FX8, 'effects.log')), S2: lines(join(W1, 'effects-b.log')) },
      midShutdownKill: s8Crash ?? null,
      engine_instances: readDb(dataDir, 'SELECT * FROM engine_instances ORDER BY epoch'),
      agent_runs: readDb(dataDir, 'SELECT id, session_id, generation, epoch, state, step, tool_batches, origin, origin_ref, prompt_id, stop_reason, recovered_epoch FROM agent_runs ORDER BY created_at'),
      tool_executions: readDb(dataDir, 'SELECT session_id, batch, call_index, tool_use_id, tool_name, state, end_kind, started, approval_state, approval_request_id, approval_cause, prior_allows, result_success, result_message_id, delivered_at FROM tool_executions ORDER BY created_at, call_index'),
      llmHits: llm.hits.map(h => ({ at: h.at, tag: h.tag, step: h.step })),
    };
    console.log('F05-R 证据导出：' + JSON.stringify(dump));
  } catch (e) { console.log('F05-R 证据导出失败（基线上没有账本表时属正常）：' + String(e)); }
  for (const c of clients) { try { c.close(); } catch { /* 已断开 */ } }
  for (const e of engines) { try { await killTree(e); } catch { /* 已退出 */ } }
  await llm?.close();
});

async function start(): Promise<{ engine: Engine; c: Client }> {
  const engine = await spawnEngine(dataDir);
  engines.push(engine);
  const c = rpcClient(engine.port, engine.token);
  await c.ready;
  clients.push(c);
  return { engine, c };
}

describe('F05 真实进程：强杀与重启', () => {
  it('R1 第一代：每个故障点布置一个会话并确认停在那个点上，然后强杀整棵进程树', async () => {
    const { engine, c } = await start();
    const allow = new Set<string>();
    autoAllow(c, allow);
    const prov = (await c.call('provider.instances.create', { name: 'f05-mock', kind: 'ollama', baseUrl: llm.baseUrl, modelId: 'f05-mock' })).result;
    expect((await c.call('provider.setDefault', { id: prov.id })).error).toBeUndefined();
    for (const k of ['S0', 'S1', 'S2', 'S3', 'S4', 'S6']) S[k] = (await c.call('chat.sessions.create', {})).result.id;
    for (const [k, w] of [['S1', W1], ['S2', W1], ['S3', W2], ['S4', W4], ['S6', W4]] as const) {
      expect((await c.call('workspace.set', { sessionId: S[k], root: w })).error).toBeUndefined();
    }

    // S0：模型请求挂着（执行意图之前，连 assistant 都没有）
    await prompt(c, S.S0, TEXT.S0);
    await waitFor('S0 的请求到达假端点', () => llm.hitsOf('S0').length === 1);
    const snap0 = await runsSnapshot(c, { sessionId: S.S0 });
    if (snap0) {
      expect(snap0.runs.find((r: any) => r.sessionId === S.S0)).toMatchObject({ state: 'running', step: 'model', epoch: 1 });
      expect(snap0.executions.filter((x: any) => x.sessionId === S.S0)).toEqual([]);
    }

    if (HAS_PS) {
      // S1：脚本已启动、停在副作用之前
      allow.add(S.S1);
      await prompt(c, S.S1, TEXT.S1);
      await waitFor('S1 的脚本已启动', () => lines(join(FX1, 'started.log')).length === 1, 40_000);
      expect(existsSync(join(FX1, 'effects.log'))).toBe(false);
      const snap1 = await runsSnapshot(c, { sessionId: S.S1 });
      if (snap1) expect(snap1.executions.filter((x: any) => x.sessionId === S.S1).map((x: any) => x.state)).toEqual(['running']);

      // S2：同一工作区的 shell，被 S1 手里的工作区写锁挡住（没启动）
      await prompt(c, S.S2, TEXT.S2);
      await waitFor('S2 的 toolStart', () => eventsOf(c, S.S2).some(e => e.kind === 'toolStart'));
      await sleep(500);
      expect(cardsOf(c, S.S2)).toHaveLength(0);
      expect(existsSync(join(W1, 'effects-b.log'))).toBe(false);
      const snap2 = await runsSnapshot(c, { sessionId: S.S2 });
      if (snap2) expect(snap2.executions.filter((x: any) => x.sessionId === S.S2).map((x: any) => x.state)).toEqual(['pending']);

      // S3：同批三个——写文件已完成、shell 做完副作用后停住、后一个写文件还在排队
      allow.add(S.S3);
      writeFileSync(join(FX3, 'go'), '');
      await prompt(c, S.S3, TEXT.S3);
      await waitFor('S3 的副作用已发生', () => lines(join(FX3, 'effects.log')).length === 1, 40_000);
      expect(readFileSync(join(W2, 'w.txt'), 'utf8')).toBe('W 的内容');
      expect(existsSync(join(W2, 'z.txt'))).toBe(false);
      expect(lines(join(FX3, 'started.log'))).toHaveLength(1);
      wMtime = statSync(join(W2, 'w.txt')).mtimeMs;
      const snap3 = await runsSnapshot(c, { sessionId: S.S3 });
      if (snap3) {
        const rows = snap3.executions.filter((x: any) => x.sessionId === S.S3);
        expect(rows.map((x: any) => x.state)).toEqual(['completed', 'running', 'pending']);
        expect(rows[0].delivered).toBe(false);
      }
    }

    // S4：同批两个——工作区里的写（免审）已完成，技能目录的写停在权限卡上
    await prompt(c, S.S4, TEXT.S4);
    await waitFor('S4 的权限卡', () => cardsOf(c, S.S4).length === 1);
    // 同批两个写入互不冲突、是并行的：第二个的权限卡可能先于第一个落盘到达。等第一个写完、它的结果入账，再往下
    await waitFor('S4 的 w2.txt 已写入', () => existsSync(join(W4, 'w2.txt')));
    if (await runsSnapshot(c, { sessionId: S.S4 })) {
      await waitFor('S4 第 0 个调用的结果已入账', async () =>
        (await runsSnapshot(c, { sessionId: S.S4 })).executions.find((x: any) => x.sessionId === S.S4 && x.index === 0)?.state === 'completed');
    }
    expect(readFileSync(join(W4, 'w2.txt'), 'utf8')).toBe('W2 的内容');
    s4RequestId = cardsOf(c, S.S4)[0].params.requestId;
    expect(cardsOf(c, S.S4)[0].params.meta.toolUseId).toBe('call_S4_0_1');
    const snap4 = await runsSnapshot(c, { sessionId: S.S4 });
    if (snap4) {
      const rows = snap4.executions.filter((x: any) => x.sessionId === S.S4);
      expect(rows.map((x: any) => x.state)).toEqual(['completed', 'awaiting-approval']);
      expect(rows[0].delivered).toBe(false);
      expect(rows[1].approval.requestId).toBe(s4RequestId);
    }

    // S5：定时任务（cron.runNow），停在权限卡上
    const job = (await c.call('cron.create', { name: 'f05 定时', prompt: TEXT.S5, scheduleKind: 'interval', scheduleValue: '60' })).result;
    cronJobId = job.id;
    const known = new Set(Object.values(S));
    expect((await c.call('cron.runNow', { id: cronJobId })).error).toBeUndefined();
    await waitFor('S5 的权限卡', () => cardsOf(c).some(n => !known.has(n.params.req.sessionId)));
    const card5 = cardsOf(c).find(n => !known.has(n.params.req.sessionId))!;
    S.S5 = card5.params.req.sessionId;
    s5RequestId = card5.params.requestId;
    const jobNow = ((await c.call('cron.list', {})).result as any[]).find(j => j.id === cronJobId);
    expect(jobNow.lastStatus).toMatch(/^running/);
    expect(jobNow.lastSessionId).toBe(S.S5);

    // S6：结果消息已落库，模型的下一次请求挂着
    await prompt(c, S.S6, TEXT.S6, P6);
    await waitFor('S6 带着工具结果的第二次请求到达假端点', () => llm.hitsOf('S6').length === 2);
    expect(llm.hitsOf('S6')[1].messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_S6_0_0')).toBe(true);

    const pids = [...lines(join(FX1, 'started.log')), ...lines(join(FX3, 'started.log'))].map(Number);
    // 只结束引擎本身：它来不及看到任何子进程的结局；它起的 PowerShell 随作业对象一并结束（见 killTree 的说明），下一句核对
    await killTree(engine, pids);
    for (const pid of pids) await waitFor(`PowerShell ${pid} 已随引擎结束`, () => !pidAlive(pid), 15_000);
    stage = 1;
  }, 240_000);

  let c2!: Client;
  let g2!: Engine;

  it('R2-0 第二代握手成功时恢复已经做完：没有活动 run，被打断的 run 都记成 interrupted / engine-crash', async () => {
    need(1);
    hitsAtRestart = llm.hits.length;
    ({ engine: g2, c: c2 } = await start());
    sessionsAtRestart = ((await c2.call('chat.sessions.list', {})).result as any[]).length;
    stage = 2;
    const snap = await runsSnapshot(c2);
    expect(snap).toBeDefined();
    expect(snap.epoch).toBe(2);
    expect(snap.runs).toEqual([]);
    // 没有 PowerShell 的平台上 S1–S3 只建了会话、没有提交过
    for (const k of Object.keys(S).filter(x => HAS_PS || !['S1', 'S2', 'S3'].includes(x))) {
      const one = await runsSnapshot(c2, { sessionId: S[k] });
      expect(one.runs.find((r: any) => r.sessionId === S[k]), k).toMatchObject({ state: 'interrupted', stopReason: 'engine-crash', recoveredEpoch: 2, epoch: 1, generation: 1 });
    }
  }, 120_000);

  it('R2-1 S0（执行意图之前，模型请求挂着时被杀）：历史只有 user 消息，没有工具行', async () => {
    need(2);
    const msgs = await messagesOf(c2, S.S0);
    expect(msgs.map(m => m.role)).toEqual(['user']);
    expect(rowsOf(S.S0)).toEqual([]);
    expect(latestRun(S.S0)).toMatchObject({ state: 'interrupted', stop_reason: 'engine-crash' });
  });

  it.skipIf(!HAS_PS)('R2-2 S1（启动后、副作用前被杀的 shell）：结果未知，重启后没有再执行', async () => {
    need(2);
    const results = resultsIn(await messagesOf(c2, S.S1));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolUseId: 'call_S1_0_0', success: false, status: 'unknown' });
    expect(results[0].output).toContain('[结果未知]');
    expect(lines(join(FX1, 'started.log'))).toHaveLength(1);
    expect(existsSync(join(FX1, 'effects.log'))).toBe(false);
    expect(rowsOf(S.S1)).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown', started: 1 }]);
  });

  it.skipIf(!HAS_PS)('R2-3 S2（排队中被杀）：未执行、可重新调用，副作用没有发生', async () => {
    need(2);
    const results = resultsIn(await messagesOf(c2, S.S2));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolUseId: 'call_S2_0_0', success: false, status: 'cancelled' });
    expect(results[0].output).toContain('[未执行]');
    expect(existsSync(join(W1, 'effects-b.log'))).toBe(false);
    expect(rowsOf(S.S2)).toMatchObject([{ state: 'cancelled', end_kind: 'not-started', started: 0 }]);
  });

  it.skipIf(!HAS_PS)('R2-4 S3（同批：已完成 + 副作用后被杀 + 排队）：同批已完成的写文件，结果在重启后还在；三种状态各归各', async () => {
    need(2);
    const msgs = await messagesOf(c2, S.S3);
    // 一条结果消息，三个结果按调用顺序
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    const results = resultsIn(msgs.slice(2));
    expect(results.map(r => r.toolUseId)).toEqual(['call_S3_0_0', 'call_S3_0_1', 'call_S3_0_2']);
    // W：真实输出，文件没被重写
    expect(results[0]).toMatchObject({ success: true, status: 'success' });
    expect(results[0].output).toContain('已写入');
    expect(readFileSync(join(W2, 'w.txt'), 'utf8')).toBe('W 的内容');
    expect(statSync(join(W2, 'w.txt')).mtimeMs).toBe(wMtime);
    // shell：结果未知，副作用恰好一次、脚本只启动过一次
    expect(results[1]).toMatchObject({ success: false, status: 'unknown' });
    expect(results[1].output).toContain('[结果未知]');
    expect(lines(join(FX3, 'effects.log'))).toHaveLength(1);
    expect(lines(join(FX3, 'started.log'))).toHaveLength(1);
    // Z：未执行
    expect(results[2]).toMatchObject({ success: false, status: 'cancelled' });
    expect(results[2].output).toContain('[未执行]');
    expect(existsSync(join(W2, 'z.txt'))).toBe(false);
    expect(rowsOf(S.S3)).toMatchObject([
      { state: 'completed', end_kind: 'completed', started: 1 },
      { state: 'unknown', end_kind: 'effect-unknown', started: 1 },
      { state: 'cancelled', end_kind: 'not-started', started: 0 },
    ]);
  });

  it('R2-5 S4（结果已提交未交付 + 审批中被杀）：已完成的结果恰好一条；审批过期有明确终态，文件没有写', async () => {
    need(2);
    const msgs = await messagesOf(c2, S.S4);
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    const results = resultsIn(msgs);
    expect(results.map(r => r.toolUseId)).toEqual(['call_S4_0_0', 'call_S4_0_1']);
    expect(results[0]).toMatchObject({ success: true, status: 'success' });
    expect(results[0].output).toContain('已写入');
    expect(results[1]).toMatchObject({ success: false, status: 'cancelled' });
    expect(results[1].output).toContain('权限请求已作废');
    expect(existsSync(SKILL_S4)).toBe(false);
    // 审批过期有明确终态：审计里那张卡有 permission.resolved（invalidated）
    const resolved = readDb(dataDir, "SELECT payload_json FROM audit_logs WHERE event_type='permission.resolved'")
      .map(r => JSON.parse(r.payload_json)).filter(p => p.requestId === s4RequestId);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ reason: 'invalidated', outcome: { decision: 'deny', reason: 'invalidated', cause: 'engine-restarted' }, toolUseId: 'call_S4_0_1' });
    expect(rowsOf(S.S4)).toMatchObject([
      { state: 'completed', end_kind: 'completed' },
      { state: 'cancelled', end_kind: 'approval-expired', approval_state: 'expired', approval_request_id: s4RequestId, approval_cause: 'engine-restarted' },
    ]);
  });

  it('R2-6 S5（定时任务审批中被杀）：定时任务被中断后状态不是 running；run 记着来源', async () => {
    need(2);
    const job = ((await c2.call('cron.list', {})).result as any[]).find(j => j.id === cronJobId);
    expect(job.lastStatus).toMatch(/^error:/);
    expect(job.lastStatus).toContain('中断');
    expect(existsSync(SKILL_S5)).toBe(false);
    expect(rowsOf(S.S5)).toMatchObject([{ state: 'cancelled', end_kind: 'approval-expired', approval_request_id: s5RequestId }]);
    expect(latestRun(S.S5)).toMatchObject({ origin: 'cron', origin_ref: cronJobId, state: 'interrupted' });
  });

  it('R2-7 S6（结果消息落库之后被杀）：那次调用的结果恰好一条，账本行已交付', async () => {
    need(2);
    const msgs = await messagesOf(c2, S.S6);
    expect(resultsIn(msgs).filter(r => r.toolUseId === 'call_S6_0_0')).toHaveLength(1);
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    const rows = rowsOf(S.S6);
    expect(rows).toMatchObject([{ state: 'completed', end_kind: 'completed' }]);
    expect(rows[0].delivered_at).not.toBeNull();
    expect(rows[0].result_message_id).toBe(msgs[2].id);
  });

  it('R2-8 重启后 5 秒内（覆盖启动后 3 秒那次定时检查）：不重放、不自动续跑', async () => {
    need(2);
    await sleep(5000);
    expect(lines(join(FX1, 'started.log')).length).toBe(HAS_PS ? 1 : 0);
    expect(lines(join(FX3, 'started.log')).length).toBe(HAS_PS ? 1 : 0);
    expect(lines(join(FX3, 'effects.log')).length).toBe(HAS_PS ? 1 : 0);
    expect(existsSync(join(FX1, 'effects.log'))).toBe(false);
    expect(existsSync(join(W1, 'effects-b.log'))).toBe(false);
    expect(existsSync(join(W2, 'z.txt'))).toBe(false);
    expect(existsSync(SKILL_S4)).toBe(false);
    expect(existsSync(SKILL_S5)).toBe(false);
    expect(((await c2.call('chat.sessions.list', {})).result as any[]).length).toBe(sessionsAtRestart);
    expect(c2.notifications.filter(n => n.method === 'chat.event' && n.params.event?.kind === 'toolStart')).toEqual([]);
    // 假端点从重启到此刻没有收到任何请求
    expect(llm.hits.length).toBe(hitsAtRestart);
  }, 30_000);

  it('R2-9 重启后答复旧权限卡：不生效，文件仍然没有写', async () => {
    need(2);
    for (const requestId of [s4RequestId, s5RequestId]) {
      const r = await c2.call('permission.respond', { requestId, decision: 'allow-once' });
      expect(r.error).toBeUndefined();
      expect(r.result).toMatchObject({ applied: false });
    }
    await sleep(300);
    expect(existsSync(SKILL_S4)).toBe(false);
    expect(existsSync(SKILL_S5)).toBe(false);
  });

  it('R2-10 S6：重启后同一 promptId 不起新 run（duplicate，状态如实是 interrupted），消息数不变', async () => {
    need(2);
    const before = (await messagesOf(c2, S.S6)).length;
    const hits = llm.hitsOf('S6').length;
    const r = await c2.call('chat.prompt', { sessionId: S.S6, text: TEXT.S6, promptId: P6 });
    expect(r.error).toBeUndefined();
    await sleep(500);
    expect((await messagesOf(c2, S.S6)).length).toBe(before);
    expect(llm.hitsOf('S6').length).toBe(hits);
    expect(r.result).toMatchObject({ ok: true, duplicate: true, state: 'interrupted', stopReason: 'engine-crash', generation: 1 });
  });

  it.skipIf(!HAS_PS)('R2-11 S1：重启后在被中断的会话里继续提问：照常起新 run，模型看到的是「结果未知」那段话恰好一次，脚本没有再启动', async () => {
    need(2);
    const r = await c2.call('chat.prompt', { sessionId: S.S1, text: '接着做，先核实上一步' });
    expect(r.error).toBeUndefined();
    await waitFor('S1 的新一轮跑完', () => eventsOf(c2, S.S1).some(e => e.kind === 'turnEnd'), 30_000);
    const hit = llm.hitsOf('S1').find(h => h.step === 1);
    expect(hit).toBeDefined();
    const toolMsgs = hit!.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.map((m: any) => m.tool_call_id)).toEqual(['call_S1_0_0']);
    expect(String(toolMsgs[0].content)).toContain('[结果未知]');
    expect(JSON.stringify(hit!.messages)).not.toContain('工具执行被中断');
    expect(lines(join(FX1, 'started.log'))).toHaveLength(1);
    expect(latestRun(S.S1)).toMatchObject({ generation: 2, epoch: 2, state: 'completed' });
  }, 60_000);

  it('R3 第二代：有脚本正在执行时有序关停（不强杀）——关停走完、退出码 0；run 记 cancelled / shutdown，那次调用的结果已交付恰好一条，副作用仍只有一次', async () => {
    need(2);
    stateAfterR2 = ledgerState(await countsOf(c2, Object.values(S)));
    let scriptPid = 0;
    if (HAS_PS) {
      const allow = new Set<string>();
      autoAllow(c2, allow);
      S.S7 = (await c2.call('chat.sessions.create', {})).result.id;
      expect((await c2.call('workspace.set', { sessionId: S.S7, root: W7 })).error).toBeUndefined();
      allow.add(S.S7);
      writeFileSync(join(FX7, 'go'), '');
      await prompt(c2, S.S7, TEXT.S7);
      await waitFor('S7 的副作用已发生', () => lines(join(FX7, 'effects.log')).length === 1, 40_000);
      scriptPid = Number(lines(join(FX7, 'started.log'))[0]);
      expect(pidAlive(scriptPid)).toBe(true);
      // 关停那一刻这次调用正在执行（不是挂在权限卡上，也不是还没开始）
      const snap = await runsSnapshot(c2, { sessionId: S.S7 });
      expect(snap.executions.filter((x: any) => x.sessionId === S.S7).map((x: any) => x.state)).toEqual(['running']);
    }
    // 主进程发 shutdown 的那条通道；等引擎自己退出，不杀它。
    // 关停过程中引擎自己收掉在跑的脚本：边等边看，紧挨着它消失的那一刻记下（不留给这个 pid 被别的进程复用的时间）
    let scriptGone = false;
    const watch = setInterval(() => { if (scriptPid !== 0 && !pidAlive(scriptPid)) scriptGone = true; }, 10);
    g2.post({ type: 'shutdown' });
    const exit = await g2.exited;
    clearInterval(watch);
    stage = 3;
    expect(exit.code).toBe(0);

    // 引擎已经不在了：以下全部直接读库、读盘
    expect(readDb(dataDir, 'SELECT epoch, close_kind FROM engine_instances ORDER BY epoch'))
      .toEqual([{ epoch: 1, close_kind: 'superseded' }, { epoch: 2, close_kind: 'shutdown' }]);
    expect(readDb(dataDir, 'SELECT id FROM agent_runs WHERE active = 1')).toEqual([]);
    expect(readDb(dataDir, 'SELECT id FROM tool_executions WHERE delivered_at IS NULL')).toEqual([]);
    if (HAS_PS) {
      expect(scriptGone || !pidAlive(scriptPid)).toBe(true);
      expect(latestRun(S.S7)).toMatchObject({ generation: 1, epoch: 2, state: 'cancelled', active: null, stop_reason: 'shutdown', recovered_epoch: null });
      const rows = rowsOf(S.S7);
      expect(rows).toMatchObject([{ tool_use_id: 'call_S7_0_0', state: 'cancelled', end_kind: 'cancelled-during-run', started: 1 }]);
      expect(rows[0].delivered_at).not.toBeNull();
      s7Messages = rawMessages(S.S7);
      expect(s7Messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(rows[0].result_message_id).toBe(s7Messages[2].id);
      const results = resultsIn(s7Messages).filter(r => r.toolUseId === 'call_S7_0_0');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ success: false, status: 'cancelled' });
      expect(lines(join(FX7, 'effects.log'))).toHaveLength(1);
      expect(lines(join(FX7, 'started.log'))).toHaveLength(1);
    }
  }, 120_000);

  let c3!: Client;
  let g3!: Engine;

  it('R4 第三代：再次启动幂等——有序关停留下的 S7 没有任何恢复动作、消息不变；S0–S6 与 R2 结束时逐项相同', async () => {
    need(3);
    const recoveredAudits = (): number => (readDb(dataDir, "SELECT COUNT(*) n FROM audit_logs WHERE event_type='run.recovered'")[0] as { n: number }).n;
    const before = recoveredAudits();
    ({ engine: g3, c: c3 } = await start());
    stage = 4;
    const snap = await runsSnapshot(c3);
    expect(snap).toBeDefined();
    expect(snap.runs).toEqual([]);
    expect(snap.epoch).toBe(3);
    // 第三代没有做任何恢复：没有被它收尾的 run，没有新的 run.recovered 审计
    expect(readDb(dataDir, 'SELECT id FROM agent_runs WHERE recovered_epoch = 3')).toEqual([]);
    expect(recoveredAudits()).toBe(before);

    if (HAS_PS) {
      expect(rawMessages(S.S7)).toEqual(s7Messages);
      expect((await messagesOf(c3, S.S7)).map(m => m.id)).toEqual(s7Messages.map(m => m.id));
      expect(latestRun(S.S7)).toMatchObject({ state: 'cancelled', stop_reason: 'shutdown', recovered_epoch: null });
      expect(rowsOf(S.S7)).toMatchObject([{ state: 'cancelled', end_kind: 'cancelled-during-run' }]);
      expect(lines(join(FX7, 'effects.log'))).toHaveLength(1);
      expect(lines(join(FX7, 'started.log'))).toHaveLength(1);
    }

    // S0–S6：与 R2 结束时逐项相同
    const now = JSON.parse(ledgerState(await countsOf(c3, s0to6())));
    const then = JSON.parse(stateAfterR2);
    expect(now.counts).toEqual(then.counts);
    expect(now.rows.filter((r: any) => r.session_id !== S.S7)).toEqual(then.rows);
    expect(now.runs.filter((r: any) => r.session_id !== S.S7)).toEqual(then.runs);
    expect(readDb(dataDir, 'SELECT id FROM tool_executions WHERE delivered_at IS NULL')).toEqual([]);
  }, 120_000);

  it.skipIf(!HAS_PS)('R5 第三代：关停已经开始之后强杀（关停中）——先从外面确认引擎进了关停，再结束它；记下它停在哪一步', async () => {
    need(4);
    const allow = new Set<string>();
    autoAllow(c3, allow);
    S.S8 = (await c3.call('chat.sessions.create', {})).result.id;
    expect((await c3.call('workspace.set', { sessionId: S.S8, root: W8 })).error).toBeUndefined();
    allow.add(S.S8);
    writeFileSync(join(FX8, 'go'), '');
    await prompt(c3, S.S8, TEXT.S8);
    await waitFor('S8 的副作用已发生', () => lines(join(FX8, 'effects.log')).length === 1, 40_000);
    const scriptPid = Number(lines(join(FX8, 'started.log'))[0]);

    g3.post({ type: 'shutdown' });
    // 确认关停已经开始：关停第一步置位之后，chat.prompt 一律以「后台正在关闭」拒绝（在那之前，空文本得到的是「消息内容不能为空」，
    // 两种应答都不落任何东西）。连接已被关掉、或进程已经退出，说明关停走得更远。确认不了就失败，不把一次普通强杀当成「关停中」
    let seen: 'closing' | 'rpc-closed' | 'exited' | undefined;
    const deadline = Date.now() + 20_000;
    while (seen === undefined) {
      if (Date.now() > deadline) throw new Error('等待超时: 引擎一直没有进入关停');
      if (g3.child.exitCode !== null || g3.child.signalCode !== null) { seen = 'exited'; break; }
      let msg: string;
      try { msg = String((await c3.call('chat.prompt', { sessionId: S.S0, text: '' })).error?.message ?? ''); }
      catch { msg = '连接已断开'; }
      if (msg.includes('后台正在关闭')) seen = 'closing';
      else if (msg.includes('连接已断开')) seen = 'rpc-closed';
      else expect(msg).toContain('消息内容不能为空');
    }
    // 只结束引擎本身（它起的 PowerShell 是直接子进程，随作业对象一并结束；关停里引擎自己也在收它）
    await killTree(g3, []);
    const exit = await g3.exited;
    await waitFor('S8 的脚本进程已不在', () => !pidAlive(scriptPid), 15_000);

    // 引擎停在了哪一步：直接读库（这一刻没有任何引擎在写）。R6 按它逐分支核对
    const row = rowsOf(S.S8)[0];
    const run = latestRun(S.S8);
    s8Crash = {
      seen, exitCode: exit.code,
      closeKind: readDb(dataDir, 'SELECT close_kind FROM engine_instances WHERE epoch = 3')[0].close_kind,
      run: { state: run.state, active: run.active, stop_reason: run.stop_reason },
      row: { state: row.state, end_kind: row.end_kind, delivered: row.delivered_at !== null },
    };
    console.log('F05-R5 关停中强杀的落点：' + JSON.stringify(s8Crash));
    stage = 5;
  }, 120_000);

  it('R6 第四代：关停中被杀的 S8 按它实际停在的那一步收口（不重放、结果恰好一条）；再多启动一次仍幂等；有序关停后四代齐全、没有未交付的行', async () => {
    need(HAS_PS ? 5 : 4);
    if (!HAS_PS) {
      // 没有 R5：第三代还活着，先让它有序关停
      c3.close();
      g3.post({ type: 'shutdown' });
      expect((await g3.exited).code).toBe(0);
    }
    const { engine: g4, c: c4 } = await start();
    const snap = await runsSnapshot(c4);
    expect(snap).toBeDefined();
    expect(snap.runs).toEqual([]);
    expect(snap.epoch).toBe(4);

    if (HAS_PS) {
      const crash = s8Crash!;
      // 落在哪个分支都成立的：副作用一次、脚本只启动过一次、历史里那次调用的结果恰好一条、行已交付
      expect(lines(join(FX8, 'effects.log'))).toHaveLength(1);
      expect(lines(join(FX8, 'started.log'))).toHaveLength(1);
      const msgs = await messagesOf(c4, S.S8);
      expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      const results = resultsIn(msgs).filter(r => r.toolUseId === 'call_S8_0_0');
      expect(results).toHaveLength(1);
      const run = latestRun(S.S8);
      const rows = rowsOf(S.S8);
      expect(rows).toHaveLength(1);
      expect(rows[0].delivered_at).not.toBeNull();
      expect(rows[0].result_message_id).toBe(msgs[2].id);
      // 第三代那一行：封过账的保持 shutdown，没封账的被第四代记成 superseded
      expect(readDb(dataDir, 'SELECT close_kind FROM engine_instances WHERE epoch = 3')[0].close_kind).toBe(crash.closeKind ?? 'superseded');

      if (crash.run.active === 1) {
        // 被杀时 run 还没停下：第四代把它记成中断（没封账 = 崩溃；封了账 = 关停时限内没停下）
        expect(run).toMatchObject({ state: 'interrupted', active: null, recovered_epoch: 4, stop_reason: crash.closeKind === 'shutdown' ? 'shutdown-timeout' : 'engine-crash' });
        if (crash.row.state === 'running') {
          // 脚本的结局没来得及入账：结果未知，不重放
          expect(rows[0]).toMatchObject({ state: 'unknown', end_kind: 'effect-unknown', started: 1 });
          expect(results[0]).toMatchObject({ success: false, status: 'unknown' });
          expect(results[0].output).toContain('[结果未知]');
        } else {
          // 取消的结局已经入账（交付与否都一样）：历史里是当时入账的那个结果，终态不变
          expect(crash.row).toMatchObject({ state: 'cancelled', end_kind: 'cancelled-during-run' });
          expect(rows[0]).toMatchObject({ state: 'cancelled', end_kind: 'cancelled-during-run', started: 1 });
          expect(results[0]).toMatchObject({ success: false, status: 'cancelled' });
        }
      } else {
        // 被杀时 run 已经按关停收尾：与有序关停走完（R3）同一个结局，第四代没有东西要恢复
        expect(crash.run).toMatchObject({ state: 'cancelled', active: null, stop_reason: 'shutdown' });
        expect(crash.row).toMatchObject({ state: 'cancelled', end_kind: 'cancelled-during-run', delivered: true });
        expect(run).toMatchObject({ state: 'cancelled', active: null, stop_reason: 'shutdown', recovered_epoch: null });
        expect(rows[0]).toMatchObject({ state: 'cancelled', end_kind: 'cancelled-during-run', started: 1 });
        expect(results[0]).toMatchObject({ success: false, status: 'cancelled' });
      }
      // S7（有序关停留下的）又过了一次启动，仍然原样
      expect(rawMessages(S.S7)).toEqual(s7Messages);
    }

    // S0–S6：多启动一次仍与 R2 结束时逐项相同
    const now = JSON.parse(ledgerState(await countsOf(c4, s0to6())));
    const then = JSON.parse(stateAfterR2);
    const later = new Set([S.S7, S.S8]);
    expect(now.counts).toEqual(then.counts);
    expect(now.rows.filter((r: any) => !later.has(r.session_id))).toEqual(then.rows);
    expect(now.runs.filter((r: any) => !later.has(r.session_id))).toEqual(then.runs);

    c4.close();
    g4.post({ type: 'shutdown' });
    const exit = await g4.exited;
    expect(exit.code).toBe(0);
    const inst = readDb(dataDir, 'SELECT epoch, close_kind FROM engine_instances ORDER BY epoch');
    expect(inst.map(r => r.epoch)).toEqual([1, 2, 3, 4]);
    expect(inst[0].close_kind).toBe('superseded');
    expect(inst[1].close_kind).toBe('shutdown');
    expect(inst[3].close_kind).toBe('shutdown');
    expect(readDb(dataDir, 'SELECT id FROM tool_executions WHERE delivered_at IS NULL')).toEqual([]);
    expect(readDb(dataDir, 'SELECT id FROM agent_runs WHERE active = 1')).toEqual([]);
  }, 120_000);
});
