/**
 * F06 P 组：真实引擎进程被强杀之后的续传与结果查询（任务卡验收 2 的「epoch 更换」、验收 3 的「查询能解释真实结果或 unknown」）。
 *
 * 两代引擎进程、同一个临时数据根：
 *  第一代：会话 A 的脚本已经做完副作用、停在那里（它的权限卡已被批准）；会话 B 停在一张待批的权限卡上。然后按 PID 强杀引擎。
 *  第二代：带着第一代的游标重连。
 * 进程内的有序重启（state-sync-minisd 的 B5）到不了这里：有序关停会先了结卡片、把 run 收尾成 cancelled；
 * interrupted、审批过期（expired / engine-restarted）、结果未知只在强杀之后由后一代的恢复写出来。
 *
 * 为什么算证据：副作用是引擎之外的真实进程（PowerShell）写的真实文件，计数在引擎被结束之后由测试进程直接读盘；
 * 两代引擎之间没有任何共享内存；模型是测试进程里的端点，跨代存活，所以能断言「重启后引擎有没有再请求模型」。
 * 产品里没有故障开关，故障点由外部强杀命中。强杀只按 PID 结束测试自己起的引擎。
 *
 * 需要 PowerShell 的会话 A 只在 Windows 上跑；会话 B（待批卡）在任何平台都跑。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatedScript, killTree, lines, readDb, spawnEngine, waitFor, type Engine } from './run-ledger-fixture';
import { gatedLlm, skillFile, skillWriteInput, streamClient, type GatedLlm, type GatedStep, type StreamClient } from './state-sync-fixture';
import type { StreamCursor } from '../src/shared/event-stream';

const HAS_PS = process.platform === 'win32';
const root = mkdtempSync(join(tmpdir(), 'dm-f06-p-'));
const dataDir = join(root, 'data');
const W = join(root, 'w');
const FX = join(root, 'fx');
for (const d of [dataDir, W, FX]) mkdirSync(d, { recursive: true });
const FILE_B = skillFile(dataDir, 'p2.txt');
const PROMPT_A = 'f06-p-a-0001';
const PROMPT_B = 'f06-p-b-0001';

const scripts: Record<string, GatedStep[]> = {
  S1: [{ tools: [{ name: 'shell_execute', input: { command: gatedScript(FX), tool_title: '带闸脚本' } }] }, { text: 'S1 续跑完成' }],
  S2: [{ tools: [{ name: 'file_write', input: skillWriteInput('p2.txt', '不该落盘') }] }, { text: 'S2 完成' }],
};

let llm: GatedLlm;
const engines: Engine[] = [];
let p: StreamClient;
let sa = ''; let sb = '';
let R1 = ''; let R2 = '';
let old: { cursor: StreamCursor; token: string; port: number } | undefined;
let hitsAtKill = 0;
/** 1 = 第一代已布置并强杀；2 = 第二代已起、已重连。前一步没成，后面的用例直接失败。 */
let stage = 0;
const need = (n: number): void => { if (stage < n) throw new Error(`前置步骤没有完成（需要 ${n}，当前 ${stage}）`); };
type Msg = { role: string; parts: { type: string; value: any }[] };
const resultsIn = (msgs: Msg[]): any[] => msgs.flatMap(m => m.parts).filter(x => x.type === 'toolResult').map(x => x.value);
const cardOfSession = (c: StreamClient, sessionId: string): string | undefined => (c.cards() as any[]).find(x => x.req.sessionId === sessionId)?.requestId;

beforeAll(async () => { llm = await gatedLlm(scripts); });
afterAll(async () => {
  try { p?.sock.terminate(); } catch { /* 已关 */ }
  for (const e of engines) { try { await killTree(e); } catch { /* 尽力 */ } }
  await llm?.close();
});

describe('F06 真实进程：强杀之后带旧游标重连', () => {
  it('P0 第一代：A 的脚本做完副作用后停住（卡已批准），B 停在待批的卡上；然后强杀引擎', async () => {
    const engine = await spawnEngine(dataDir);
    engines.push(engine);
    p = streamClient(engine.port, engine.token);
    await p.ready;
    const first = await p.attach();
    expect(first).toMatchObject({ mode: 'snapshot', reason: 'no-cursor', epoch: 1 });
    const prov = (await p.call('provider.instances.create', { name: 'f06-gated', kind: 'ollama', baseUrl: llm.baseUrl, modelId: 'f06-gated' })).result;
    expect((await p.call('provider.setDefault', { id: prov.id })).error).toBeUndefined();
    sa = (await p.call('chat.sessions.create', {})).result.id;
    sb = (await p.call('chat.sessions.create', {})).result.id;

    // B：停在权限卡上（技能目录的写要问）
    expect((await p.call('chat.prompt', { sessionId: sb, text: '[[S2]] 写技能目录', promptId: PROMPT_B })).error).toBeUndefined();
    await waitFor('B 的权限卡', () => cardOfSession(p, sb) !== undefined, 40_000);
    R2 = cardOfSession(p, sb)!;
    expect(existsSync(FILE_B)).toBe(false);

    if (HAS_PS) {
      // A：预先放好 go——脚本做完副作用后停住，等一个永远不来的 release
      expect((await p.call('workspace.set', { sessionId: sa, root: W })).error).toBeUndefined();
      writeFileSync(join(FX, 'go'), '');
      expect((await p.call('chat.prompt', { sessionId: sa, text: '[[S1]] 跑带闸脚本', promptId: PROMPT_A })).error).toBeUndefined();
      await waitFor('A 的权限卡', () => cardOfSession(p, sa) !== undefined, 40_000);
      R1 = cardOfSession(p, sa)!;
      expect((await p.call('permission.respond', { requestId: R1, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
      await waitFor('A 的副作用已发生', () => lines(join(FX, 'effects.log')).length === 1, 60_000);
      expect(lines(join(FX, 'started.log'))).toHaveLength(1);
    }
    await waitFor('P 没有在同步', () => p.settled());
    expect(p.cardIds()).toEqual([R2]);
    old = { cursor: { ...p.tracker.cursor! }, token: engine.token, port: engine.port };
    hitsAtKill = llm.hits.length;

    await killTree(engine, HAS_PS ? lines(join(FX, 'started.log')).map(Number) : []);
    stage = 1;
    // 被杀的那一代没有来得及关账
    expect(readDb(dataDir, 'SELECT epoch, close_kind FROM engine_instances')).toEqual([{ epoch: 1, close_kind: null }]);
  }, 180_000);

  it('P1/P2 第二代：带旧游标重连 → 快照 / epoch-changed，没有待批卡、没有尾巴；两个会话的 run 都是 interrupted / engine-crash', async () => {
    need(1);
    const engine = await spawnEngine(dataDir);
    engines.push(engine);
    expect(engine.token).not.toBe(old!.token);
    const r = await p.reconnect(engine.port, engine.token, { sessionId: sb });
    stage = 2;
    expect(r.mode).toBe('snapshot');
    if (r.mode !== 'snapshot') throw new Error('应当是快照');
    expect(r.reason).toBe('epoch-changed');
    expect(r.epoch).toBe(2);
    expect(r.instanceId).not.toBe(old!.cursor.instanceId);
    expect(r.snapshot.pendingPermissions).toEqual([]);
    expect(r.snapshot.live).toEqual([]);
    expect(p.cardIds()).toEqual([]);
    // 没有任何本代次的活动 run：重启不续跑
    expect(r.snapshot.runs.filter(x => x.state === 'running' || x.state === 'starting')).toEqual([]);
    expect(r.snapshot.runs.filter(x => x.sessionId === sb).map(x => [x.state, x.stopReason, x.epoch, x.recoveredEpoch])).toEqual([['interrupted', 'engine-crash', 1, 2]]);
    // B 的历史：那次写入由恢复补了一条「未执行」的结果（审批过期），文件没写
    const msgs = r.snapshot.session!.messages as unknown as Msg[];
    expect(resultsIn(msgs).map(x => x.status)).toEqual(['cancelled']);
    expect(existsSync(FILE_B)).toBe(false);
    expect(p.continuity()).toBeUndefined();
  }, 120_000);

  it('P2 审批中被杀的卡：凭旧 requestId 答复不生效；查询回 settled / ledger——expired / engine-restarted，调用没有执行', async () => {
    need(2);
    expect((await p.call('permission.respond', { requestId: R2, decision: 'allow-once' })).result).toEqual({ ok: true, applied: false });
    const o = (await p.call('state.outcomes', { refs: [{ kind: 'permission', requestId: R2 }, { kind: 'prompt', sessionId: sb, promptId: PROMPT_B }] })).result;
    expect(o.epoch).toBe(2);
    expect(o.outcomes[0]).toEqual({
      kind: 'permission', requestId: R2, status: 'settled', source: 'ledger', sessionId: sb, toolUseId: 'call_S2_0_0', epoch: 1,
      approval: { state: 'expired', reason: 'invalidated', cause: 'engine-restarted' }, execution: 'cancelled',
    });
    // 那次提交被接收过（消息在历史里）：状态如实是 interrupted，不是 not-accepted
    expect(o.outcomes[1]).toMatchObject({ kind: 'prompt', status: 'accepted', run: { state: 'interrupted', stopReason: 'engine-crash', sessionId: sb, promptId: PROMPT_B } });
    expect(existsSync(FILE_B)).toBe(false);
    expect(readDb(dataDir, 'SELECT state, end_kind, started, approval_state FROM tool_executions WHERE session_id=?', sb))
      .toEqual([{ state: 'cancelled', end_kind: 'approval-expired', started: 1, approval_state: 'expired' }]);
    // 没有任何东西因为这次批准而执行；重启后引擎没有再请求模型
    expect(llm.hits.length).toBe(hitsAtKill);
  }, 60_000);

  it.skipIf(!HAS_PS)('P1 副作用之后被杀的脚本：run 是 interrupted、结果未知；凭旧 requestId 答复不生效；脚本只启动过一次、副作用一次；查询说得清那张卡当时已批准', async () => {
    need(2);
    const r = await p.attach({ sessionId: sa, forceSnapshot: true });
    if (r.mode !== 'snapshot') throw new Error('应当是快照');
    expect(r.snapshot.runs.filter(x => x.sessionId === sa).map(x => [x.state, x.stopReason, x.epoch, x.recoveredEpoch])).toEqual([['interrupted', 'engine-crash', 1, 2]]);
    const msgs = r.snapshot.session!.messages as unknown as Msg[];
    expect(resultsIn(msgs).map(x => x.status)).toEqual(['unknown']);
    expect((await p.call('permission.respond', { requestId: R1, decision: 'allow-once' })).result).toEqual({ ok: true, applied: false });
    const o = (await p.call('state.outcomes', { refs: [{ kind: 'permission', requestId: R1 }, { kind: 'prompt', sessionId: sa, promptId: PROMPT_A }] })).result;
    expect(o.outcomes[0]).toMatchObject({
      kind: 'permission', requestId: R1, status: 'settled', source: 'ledger', sessionId: sa, epoch: 1,
      approval: { state: 'allowed' }, execution: 'unknown',
    });
    expect(o.outcomes[1]).toMatchObject({ status: 'accepted', run: { state: 'interrupted' } });
    // 不重放：脚本启动次数、副作用次数都还是 1；模型没有被再请求
    expect(lines(join(FX, 'started.log'))).toHaveLength(1);
    expect(lines(join(FX, 'effects.log'))).toHaveLength(1);
    expect(llm.hitsOf('S1')).toHaveLength(1);
    expect(llm.hits.length).toBe(hitsAtKill);
    expect(readDb(dataDir, 'SELECT COUNT(*) n FROM agent_runs WHERE active=1')).toEqual([{ n: 0 }]);
  }, 60_000);
});
