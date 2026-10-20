/**
 * F08 P 组：真实引擎进程上的检查点（强杀、同一数据根重启）。
 *
 * 起真实的 minisd 进程（standalone），假模型端点驱动工具调用；强杀只按 PID、只杀自己起的进程；重启后只经 RPC、读库、读文件断言。
 *  P1：一批 [file_write A, shell 带闸脚本]——脚本启动（说明 A 已落盘）后强杀引擎 → 重启 → A 的记录是 applied、文件是新内容
 *      → 经 RPC 恢复 → 字节等于原始。验证检查点跨重启可用。
 *  P2：一批 [shell 带闸脚本, file_write B]——脚本运行期间强杀 → 重启 → B 没有检查点行、文件是原内容、账本里 B 是未执行。
 * shell 的带闸脚本是 PowerShell：只在 Windows 上跑。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoAllow, gatedScript, killTree, lines, mockLlm, pidAlive, readDb, rpcClient, spawnEngine, waitFor,
  type Client, type Engine, type LlmStep,
} from './run-ledger-fixture';

const HAS_PS = process.platform === 'win32';
const root = mkdtempSync(join(tmpdir(), 'dm-f08-p-'));
const dataDir = join(root, 'data');
const W1 = join(root, 'w1'); const W2 = join(root, 'w2'); const FX1 = join(root, 'fx1'); const FX2 = join(root, 'fx2');
for (const d of [dataDir, W1, W2, FX1, FX2]) mkdirSync(d, { recursive: true });
const A = join(W1, 'a.txt'); const B = join(W2, 'b.txt');
const A_ORIGINAL = Buffer.from('A 的原始内容\r\n第二行\r\n', 'utf8');
const B_ORIGINAL = Buffer.from('B 的原始内容\n', 'utf8');

const scripts: Record<string, LlmStep[]> = {
  S1: [{ tools: [
    { name: 'file_write', input: { path: 'a.txt', content: 'A 被 agent 改写\n', tool_title: '写 A' } },
    { name: 'shell_execute', input: { command: gatedScript(FX1), tool_title: '带闸脚本' } },
  ] }, { text: 'S1 完成' }],
  S2: [{ tools: [
    { name: 'shell_execute', input: { command: gatedScript(FX2), tool_title: '带闸脚本' } },
    { name: 'file_write', input: { path: 'b.txt', content: 'B 被 agent 改写\n', tool_title: '写 B' } },
  ] }, { text: 'S2 完成' }],
};

let llm: Awaited<ReturnType<typeof mockLlm>>;
const engines: Engine[] = [];
const clients: Client[] = [];
const S: Record<string, string> = {};
let stage = 0;

beforeAll(async () => { llm = await mockLlm(scripts); });
afterAll(async () => {
  for (const c of clients) { try { c.close(); } catch { /* 已断开 */ } }
  for (const e of engines) { try { await killTree(e); } catch { /* 已退出 */ } }
  await llm?.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 上偶有占用，留给系统清 */ }
});

async function start(): Promise<{ engine: Engine; c: Client }> {
  const engine = await spawnEngine(dataDir);
  engines.push(engine);
  const c = rpcClient(engine.port, engine.token);
  await c.ready;
  clients.push(c);
  return { engine, c };
}
const cpRows = (sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM file_checkpoints WHERE session_id=? ORDER BY seq', sessionId);
const execRows = (sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sessionId);

describe.runIf(HAS_PS)('F08 真实进程：检查点跨强杀与重启', () => {
  it('P 第一代：两个会话各停在带闸脚本上（A 已写、B 还没轮到），然后强杀引擎', async () => {
    writeFileSync(A, A_ORIGINAL); writeFileSync(B, B_ORIGINAL);
    const { engine, c } = await start();
    const allow = new Set<string>();
    autoAllow(c, allow);
    const prov = (await c.call('provider.instances.create', { name: 'f08-mock', kind: 'ollama', baseUrl: llm.baseUrl, modelId: 'f08-mock' })).result;
    expect((await c.call('provider.setDefault', { id: prov.id })).error).toBeUndefined();
    for (const [k, w] of [['S1', W1], ['S2', W2]] as const) {
      S[k] = (await c.call('chat.sessions.create', {})).result.id;
      expect((await c.call('workspace.set', { sessionId: S[k], root: w })).error).toBeUndefined();
      allow.add(S[k]);
    }
    expect((await c.call('chat.prompt', { sessionId: S.S1, text: '[[S1]] 先写 A 再跑脚本' })).error).toBeUndefined();
    await waitFor('S1 的脚本已启动', () => lines(join(FX1, 'started.log')).length === 1, 60_000);
    expect((await c.call('chat.prompt', { sessionId: S.S2, text: '[[S2]] 先跑脚本再写 B' })).error).toBeUndefined();
    await waitFor('S2 的脚本已启动', () => lines(join(FX2, 'started.log')).length === 1, 60_000);

    // 强杀之前的落点：A 已是新内容且记录 applied；B 一个字节没动、没有记录
    expect(readFileSync(A, 'utf8')).toBe('A 被 agent 改写\n');
    expect(cpRows(S.S1).map(r => [r.tool_name, r.state])).toEqual([['file_write', 'applied']]);
    expect(readFileSync(B).equals(B_ORIGINAL)).toBe(true);
    expect(cpRows(S.S2)).toEqual([]);

    const pids = [...lines(join(FX1, 'started.log')), ...lines(join(FX2, 'started.log'))].map(Number);
    await killTree(engine, pids);   // 只结束引擎本身；它起的 PowerShell 随作业对象一并结束
    for (const pid of pids) await waitFor(`PowerShell ${pid} 已随引擎结束`, () => !pidAlive(pid), 15_000);
    stage = 1;
  }, 240_000);

  it('P1 重启后：A 的记录仍是 applied、文件是新内容；经 RPC 恢复后字节等于原始；清单按运行分组并标出那次 shell 不在记录里', async () => {
    if (stage < 1) throw new Error('前置步骤没有完成');
    const { c } = await start();
    stage = 2;
    const rows = cpRows(S.S1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'applied', before_exists: 1, restoring_at: null });
    expect(readFileSync(A, 'utf8')).toBe('A 被 agent 改写\n');
    const list = (await c.call('checkpoints.list', { sessionId: S.S1 })).result;
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0].changes.map((x: any) => x.displayPath)).toEqual(['a.txt']);
    expect(list.groups[0].uncovered.shell).toBe(1);
    // 那条 shell 调用按 F05 记成结果未知（文案不带文件事实：它不是文件类工具）
    const execs = execRows(S.S1);
    expect(execs.map(e => [e.tool_name, e.state])).toEqual([['file_write', 'completed'], ['shell_execute', 'unknown']]);

    const rep = (await c.call('checkpoints.restore', { sessionId: S.S1, ids: [rows[0].id], confirm: true })).result;
    expect(rep.items.map((i: any) => i.outcome)).toEqual(['restored']);
    expect(readFileSync(A).equals(A_ORIGINAL)).toBe(true);
    expect(readdirSync(W1).filter(n => n.startsWith('.dm-'))).toEqual([]);
    expect(cpRows(S.S1)[0].state).toBe('restored');
  }, 240_000);

  it('P2 重启后：B 没有检查点行、文件是原内容；账本里 B 是未执行（没有被重放）', async () => {
    if (stage < 2) throw new Error('前置步骤没有完成');
    expect(cpRows(S.S2)).toEqual([]);
    expect(readFileSync(B).equals(B_ORIGINAL)).toBe(true);
    const execs = execRows(S.S2);
    expect(execs.map(e => [e.tool_name, e.state, e.end_kind, e.started])).toEqual([
      ['shell_execute', 'unknown', 'effect-unknown', 1],
      ['file_write', 'cancelled', 'not-started', 0],
    ]);
    // 脚本只被启动过一次：恢复没有重新执行任何工具
    expect(lines(join(FX2, 'started.log'))).toHaveLength(1);
    expect(lines(join(FX1, 'started.log'))).toHaveLength(1);
  }, 60_000);
});
