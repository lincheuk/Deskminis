/**
 * F09 R 组：真实引擎、真实 PowerShell、真实强杀（任务卡验收 1–3、5）。
 *
 * 本文件不引任何 F09 新模块：只经 RPC、读库、读文件系统、经观察者握着的进程句柄断言，在 F09 之前的基线上也跑得起来、
 * 红在行为上（proc.trees.snapshot 与 process_trees 的核对在方法或表不存在时跳过，树的断言照做）。
 *
 * 为什么实现被改坏会红：断言的是引擎之外的真实进程是否还活着，由测试进程握着的句柄与心跳文件在引擎死后直接看；
 * 引擎与测试之间没有共享内存，产品里没有故障开关。
 *
 * 判定规则、锚点、只动自己起的进程等约定见 proc-lifecycle-fixture.ts。带 [环境] 前缀的失败是环境没准备好或没有结论，
 * 不是断言失败：单独重跑本文件确认。
 *
 * 分档：默认档（随全量跑，2 次引擎冷启动）R-A1、R-A2、R-A2r、R-A4、R-A6、R-B、R-E；
 * DESKMINIS_F09_FULL=1 再加 R-A0、R-A3、R-A5、R-F、R-B 的第二引擎、R-C、R-D（每格、每轮各起一个引擎）。
 * R-G（开发态图形应用）不在本文件：用探针脚本跑（见 proc-lifecycle-probe.ts）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENGINE_HANDSHAKE_MS, EnvNotReady, Lab, TREE_GROWN_MS, VERDICT_MS, procsOf, roleProc, runCell, summary, until, writeEvidence,
  type Entry, type Evidence, type Tree,
} from './proc-lifecycle-fixture';
import { eventsOf, lines, readDb } from './run-ledger-fixture';

const WIN = process.platform === 'win32';
const FULL = process.env.DESKMINIS_F09_FULL === '1';
const EVIDENCE = process.env.DESKMINIS_F09_EVIDENCE;
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
/** 留「没有托管时是红的」的证据用：FULL 档里 R-A5、R-B 第二引擎、R-C、R-D 的引擎带总开关关闭起（= F09 之前的启动与回收路径），断言不变。 */
const RED = process.env.DESKMINIS_F09_RED === '1';
const RED_ENV: Record<string, string> = RED ? { DESKMINIS_PROC_OWNERSHIP: 'off' } : {};
const SLOW = Math.max(1, Number(process.env.DESKMINIS_F09_SLOW) || 1);
const T = (n: number): number => n * 60_000 * SLOW;
const JOB_NOTE = '树内的进程已随引擎停止由系统结束';

if (!WIN) console.log('F09 R 组：非 Windows 平台，未运行');
if (WIN && !FULL) console.log('F09 R 组：R-A0、R-A3、R-A5、R-F、R-B 第二引擎、R-C、R-D 未运行（需要 DESKMINIS_F09_FULL=1）');
if (WIN && FULL && RED) console.log('F09 R 组：DESKMINIS_F09_RED=1——R-A5、R-B 第二引擎、R-C、R-D 的引擎带 DESKMINIS_PROC_OWNERSHIP=off，预期是红的（留证用）');

let lab: Lab;
const keep = (ev: Evidence, tag = ''): Evidence => {
  console.log('F09-R 证据：' + summary(ev));
  if (EVIDENCE) writeEvidence(EVIDENCE, ev, tag);
  return ev;
};
/** 没有结论按 [环境] 失败；有残留是断言失败。 */
function expectClean(ev: Evidence): void {
  expect(ev.bystanders.filter(b => !b.aliveAfter)).toEqual([]);              // R-B：任何清理都不能结束无关进程
  expect(ev.rootReaped).toBe(true);                                         // 根被回收
  if (ev.verdict === 'inconclusive') throw new EnvNotReady(`没有结论：${summary(ev)}`, 0);
  expect(ev.tree.map(r => `${r.role}=${r.verdict}`).join(' ')).toBe(ev.tree.map(r => `${r.role}=dead`).join(' '));
}
/** process_trees 的行；表不存在（基线）返回 undefined。 */
function ledgerRows(where: string, ...args: unknown[]): any[] | undefined {
  try { return readDb(lab.dataDir, `SELECT * FROM process_trees WHERE ${where} ORDER BY started_at`, ...args); } catch { return undefined; }
}
/** 快照里那棵树离开 pending 之后才动手（方法不存在则跳过）。none / no-marker 与 launcher-deadline 记 [环境]。 */
async function armed(t: Tree): Promise<any | undefined> {
  if ((await lab.snapshot()) === undefined) return undefined;
  let view: any;
  await until('树离开 pending', async () => {
    view = ((await lab.snapshot()).trees as any[]).find(v => v.root?.pid === t.rootPid || (t.server !== undefined && v.ownerRef === t.server && v.endedAt === undefined));
    return view !== undefined && view.protection !== 'pending';
  }, TREE_GROWN_MS);
  if (view.protection === 'none' && /no-marker|launcher-deadline/.test(String(view.protectionReason))) throw new EnvNotReady(`归属没等到：${view.protectionReason}`, 0);
  expect(view.protection).toBe('job');
  return view;
}
async function grownTree(entry: Entry, o: { timeout?: boolean } = {}): Promise<Tree> {
  const t = await lab.startTree(entry, o);
  await lab.grown(t);
  return t;
}
const act = (what: string, how: string, pid: number | null): Evidence['action'] => ({ what, pid, requestedAt: Date.now(), how });

describe.skipIf(!WIN)('F09 真实引擎：进程树的回收（R 组）', () => {
  beforeAll(async () => { lab = await Lab.open(); await lab.startBystanders(); await lab.startEngine(); }, ENGINE_HANDSHAKE_MS + T(5));
  afterAll(async () => { if (lab) { await lab.settle().catch(() => undefined); await lab.close(); } }, T(4));

  it('R-A1 / R-E 正常取消（shell）：根被回收，五个角色全部退出（含父链已断的）；调用记为已取消；行 stopped / cancel', async () => {
    const t = await grownTree('shell');
    const view = await armed(t);
    if (view) {
      // R-E：树在跑时的状态面
      expect(view).toMatchObject({ kind: 'shell', sessionId: t.sessionId, protection: 'job', root: { pid: t.rootPid } });
      expect((await lab.snapshot()).ownership.state).toBe('active');
      const dry = (await lab.c!.call('diagnostics.dryRun', {})).result;
      expect(dry.checks.processOwnership.status).toBe('ready');
    }
    void lab.c!.call('chat.cancel', { sessionId: t.sessionId });
    const ev = keep(await lab.judge(t, 'cancel', act('取消', 'chat.cancel', t.rootPid ?? null), 'root'));
    expectClean(ev);
    // 那次调用落库的状态是已取消（后代都没了，驱动的输出管道才关得上，调用才收得了口）
    await until('调用收口', () => eventsOf(lab.c!, t.sessionId!).some(e => e.kind === 'toolEnd'), VERDICT_MS);
    const msgs = readDb(lab.dataDir, 'SELECT parts_json FROM messages WHERE session_id=? ORDER BY created_at, id', t.sessionId);
    const results = msgs.flatMap(m => JSON.parse(m.parts_json) as { type: string; value: any }[]).filter(p => p.type === 'toolResult');
    expect(results.map(r => r.value.status)).toEqual(['cancelled']);
    expect(readDb(lab.dataDir, 'SELECT state, end_kind FROM tool_executions WHERE session_id=?', t.sessionId)).toEqual([{ state: 'cancelled', end_kind: 'cancelled-during-run' }]);
    const rows = ledgerRows('session_id=?', t.sessionId);
    if (rows) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'shell', protection: 'job', stop_cause: 'cancel', end_kind: 'stopped', root_pid: t.rootPid });
      expect(rows[0].stop_run_id).toBe(readDb(lab.dataDir, 'SELECT id FROM agent_runs WHERE session_id=?', t.sessionId)[0].id);
      expect(rows[0].run_id).toBe(rows[0].stop_run_id);
    }
  }, T(8));

  it('R-A1 删除会话（终端）：五个角色全部退出；该会话在进程账本里没有残留行', async () => {
    const t = await grownTree('terminal');
    await armed(t);
    void lab.c!.call('chat.sessions.delete', { sessionId: t.sessionId, confirm: true });
    expectClean(keep(await lab.judge(t, 'cancel', act('删除会话', 'chat.sessions.delete', t.rootPid ?? null), 'root')));
    const rows = ledgerRows('session_id=?', t.sessionId);
    if (rows) expect(rows).toEqual([]); // 行随会话在同一次 RPC 里删掉
  }, T(8));

  it('R-A1 移除服务器（MCP，裸名经 cmd.exe）：五个角色全部退出；行 stopped / config-changed', async () => {
    const t = await grownTree('mcp-bare');
    await armed(t);
    void lab.c!.call('mcp.servers.remove', { name: t.server });
    expectClean(keep(await lab.judge(t, 'cancel', act('移除服务器', 'mcp.servers.remove', t.rootPid ?? null), 'root')));
    const rows = ledgerRows('owner_ref=?', t.server);
    if (rows) expect(rows.map(r => ({ kind: r.kind, stop: r.stop_cause, end: r.end_kind }))).toEqual([{ kind: 'mcp', stop: 'config-changed', end: 'stopped' }]);
  }, T(8));

  it('R-A4 工具超时（shell）：以 124 返回并含超时提示；五个角色全部退出；行 stopped / timeout', async () => {
    const t = await grownTree('shell', { timeout: true });
    await armed(t);
    const ev = keep(await lab.judge(t, 'timeout', act('工具超时', 'timeout_seconds', t.rootPid ?? null), 'root'));
    expectClean(ev);
    await until('调用收口', () => eventsOf(lab.c!, t.sessionId!).some(e => e.kind === 'toolEnd'), VERDICT_MS);
    const end = eventsOf(lab.c!, t.sessionId!).find(e => e.kind === 'toolEnd');
    expect(end.output).toContain('[命令超时被终止]');
    expect(end.output).toContain('exit=124');
    const rows = ledgerRows('session_id=?', t.sessionId);
    if (rows) expect(rows.map(r => ({ stop: r.stop_cause, end: r.end_kind }))).toEqual([{ stop: 'timeout', end: 'stopped' }]);
  }, T(8));

  it('R-A4 MCP 握手超时：连接以启动超时失败，五个角色全部退出；行 stopped / startup-failed', async () => {
    const t = await grownTree('mcp-abs', { timeout: true });
    const ev = keep(await lab.judge(t, 'timeout', act('握手超时', 'startupTimeoutSeconds', t.rootPid ?? null), 'root'));
    expectClean(ev);
    await until('这台服务器记为出错', async () => ((await lab.c!.call('mcp.servers.list', {})).result?.statuses as any[] | undefined)?.find(s => s.name === t.server)?.status === 'error', VERDICT_MS);
    const st = ((await lab.c!.call('mcp.servers.list', {})).result.statuses as any[]).find(s => s.name === t.server);
    expect(st.lastError).toContain('MCP server 启动超时');
    const rows = ledgerRows('owner_ref=?', t.server);
    if (rows) expect(rows.map(r => ({ stop: r.stop_cause, end: r.end_kind }))).toEqual([{ stop: 'startup-failed', end: 'stopped' }]);
    void lab.c!.call('mcp.servers.remove', { name: t.server });
  }, T(8));

  it('R-A6 根自己退出（MCP server 收到约定入参后退出）：它留下的后代全部退出；行 exited，退出码相符', async () => {
    const t = await grownTree('mcp-abs');
    await armed(t);
    await lab.callTool(`mcp__${t.server}__noop`, { exit: 3 });
    const ev = keep(await lab.judge(t, 'self-exit', act('根自己退出', 'noop {exit:3}', t.rootPid ?? null), 'root'));
    expectClean(ev);
    expect(ev.tree[0].exitCode).toBe(3);
    const rows = ledgerRows('owner_ref=?', t.server);
    if (rows) expect(rows.map(r => ({ end: r.end_kind, code: r.exit_code, stop: r.stop_cause }))).toEqual([{ end: 'exited', code: 3, stop: null }]);
    void lab.c!.call('mcp.servers.remove', { name: t.server });
  }, T(8));

  it('R-A6 根自己退出（shell 里跑 exit）：驱动以那个退出码退出，它留下的后代全部退出；那次调用以 129 收口；行 exited', async () => {
    const t = await lab.startTree('shell', { exitWith: 7 });
    await lab.grown(t);
    await armed(t);
    writeFileSync(join(t.fx, 'go-exit'), ''); // 命令里的循环看到它就 exit 7：没有人对这棵树调过 stop
    const ev = keep(await lab.judge(t, 'self-exit', act('根自己退出', 'shell 命令里 exit 7', t.rootPid ?? null), 'root'));
    expectClean(ev);
    expect(ev.tree[0].exitCode).toBe(7);
    await until('调用收口', () => eventsOf(lab.c!, t.sessionId!).some(e => e.kind === 'toolEnd'), VERDICT_MS);
    const end = eventsOf(lab.c!, t.sessionId!).find(e => e.kind === 'toolEnd');
    expect(end.output).toContain('[shell 进程意外退出]');
    expect(end.output).toContain('exit=129');
    const rows = ledgerRows('session_id=?', t.sessionId);
    if (rows) {
      expect(rows.map(r => ({ end: r.end_kind, code: r.exit_code, stop: r.stop_cause, protection: r.protection }))).toEqual([{ end: 'exited', code: 7, stop: null, protection: 'job' }]);
      // 根自己退出不是机制失败：托管没有被停用
      expect((await lab.snapshot()).ownership.state).toBe('active');
    }
  }, T(8));

  let killed: { shell: Tree; terminal: Tree; mcp: Tree } | undefined;
  let hitsBefore = 0;
  it('R-A2 只结束引擎：shell、终端、MCP 三种入口的树全部退出，无关进程全在', async () => {
    const shell = await grownTree('shell'); const terminal = await grownTree('terminal'); const mcp = await grownTree('mcp-bare');
    for (const t of [shell, terminal, mcp]) await armed(t);
    hitsBefore = lab.llm.hits.length;
    await lab.killEngine();
    const a = act('只结束引擎', 'taskkill /PID <引擎> /F（不带 /T）', lab.ref!.pid);
    const evs = [keep(await lab.judge(shell, 'engine-kill', a, 'engine')), keep(await lab.judge(terminal, 'engine-kill', a, 'engine')), keep(await lab.judge(mcp, 'engine-kill', a, 'engine'))];
    killed = { shell, terminal, mcp };
    for (const ev of evs) expectClean(ev);
    console.log('R-A2 根的退出码与回收路径：' + JSON.stringify(evs.map(e => ({ entry: e.entry, code: e.tree[0].exitCode, by: e.rootReapedBy }))));
  }, T(10));

  it('R-A2r 同数据根重启：行 engine-lost / reaped=job；shell 那次调用是结果未知并写明树的去向；没有重放、没有新的心跳', async () => {
    if (!killed) throw new Error('前置步骤没有完成（R-A2）');
    await lab.startEngine();
    const { shell, terminal, mcp } = killed;
    const rows = readDb(lab.dataDir, 'SELECT state, end_kind FROM tool_executions WHERE session_id=?', shell.sessionId);
    expect(rows).toEqual([{ state: 'unknown', end_kind: 'effect-unknown' }]);
    const msgs = readDb(lab.dataDir, 'SELECT parts_json FROM messages WHERE session_id=? ORDER BY created_at, id', shell.sessionId);
    const result = msgs.flatMap(m => JSON.parse(m.parts_json) as { type: string; value: any }[]).filter(p => p.type === 'toolResult')[0].value;
    expect(result.status).toBe('unknown');
    expect(String(result.output).startsWith('[结果未知]')).toBe(true);
    expect(result.output).toContain(JOB_NOTE);
    const led = ledgerRows('epoch=1 AND recovered_epoch IS NOT NULL');
    expect(led!.filter(r => [shell.rootPid, terminal.rootPid, mcp.rootPid].includes(r.root_pid)).map(r => ({ kind: r.kind, end: r.end_kind, reaped: r.reaped, by: r.recovered_epoch })).sort((x, y) => x.kind.localeCompare(y.kind)))
      .toEqual([{ kind: 'mcp', end: 'engine-lost', reaped: 'job', by: 2 }, { kind: 'shell', end: 'engine-lost', reaped: 'job', by: 2 }, { kind: 'terminal', end: 'engine-lost', reaped: 'job', by: 2 }]);
    // 恢复没有重新请求模型（没有重放、没有续跑），各角色的句柄仍是已退出
    expect(lab.llm.hits.length).toBe(hitsBefore);
    for (const t of [shell, terminal, mcp]) expect(lab.observer.exited(t.rootPid!)).toBe(true);
    expect((await lab.checkBystanders()).filter(b => !b.aliveAfter)).toEqual([]);
  }, ENGINE_HANDSHAKE_MS + T(4));
});

describe.skipIf(!WIN || !FULL)('F09 真实引擎：每格一个引擎的情形（FULL 档）', () => {
  const cell = async (o: Parameters<typeof runCell>[0], tag = ''): Promise<Evidence> => {
    const ev = await runCell(o);
    console.log('F09-R 证据：' + summary(ev) + ` 引擎=${ev.engine.engineEnd}(code=${ev.engine.exitCode})`);
    if (EVIDENCE) writeEvidence(EVIDENCE, ev, tag);
    return ev;
  };
  for (const entry of ['shell', 'terminal', 'mcp-abs', 'mcp-bare'] as const) {
    it(`R-A0 有序关停（${entry}）：退出码 0，全部角色退出`, async () => {
      const ev = await cell({ scenario: 'shutdown', entry });
      expectClean(ev);
      expect(ev.engine.exitCode).toBe(0);
    }, ENGINE_HANDSHAKE_MS + T(8));
    it(`R-A3 结束替身主进程（${entry}，文件形态）：引擎自己有序退出（退出码 0），树全部退出`, async () => {
      const ev = await cell({ scenario: 'main-kill', entry });
      expectClean(ev);
      expect({ end: ev.engine.engineEnd, code: ev.engine.exitCode }).toEqual({ end: 'exited', code: 0 });
    }, ENGINE_HANDSHAKE_MS + T(8));
  }
  it('R-A3 管道形态（shell）：引擎的输出管道随替身断开，照样以 0 退出、树全部退出', async () => {
    const ev = await cell({ scenario: 'main-kill', entry: 'shell', stdio: 'pipe' }, '-pipe');
    expectClean(ev);
    expect({ end: ev.engine.engineEnd, code: ev.engine.exitCode }).toEqual({ end: 'exited', code: 0 });
  }, ENGINE_HANDSHAKE_MS + T(8));
  it('R-F 总开关关闭（DESKMINIS_PROC_OWNERSHIP=off）：功能正常，取消仍收得掉父链完整的部分，状态如实', async () => {
    const ev = await cell({ scenario: 'cancel', entry: 'shell', extraEnv: { DESKMINIS_PROC_OWNERSHIP: 'off' } }, '-off');
    expect(ev.ownership).toMatchObject({ state: 'disabled', reason: 'disabled-by-env' });
    expect(ev.rootReaped).toBe(true);
    expect(ev.tree.filter(r => r.role !== 'leaf-orphan').map(r => r.verdict)).toEqual(['dead', 'dead', 'dead', 'dead']);
    expect(ev.bystanders.filter(b => !b.aliveAfter)).toEqual([]);
  }, ENGINE_HANDSHAKE_MS + T(8));

  for (const entry of ['shell', 'mcp-bare'] as const) {
    it(`R-A5 关停超时的形态（${entry}）：发 shutdown 后不等退出立刻只结束引擎，树全部退出`, async () => {
      const ev = await cell({ scenario: 'shutdown-kill', entry, extraEnv: RED_ENV });
      expectClean(ev);
    }, ENGINE_HANDSHAKE_MS + T(8));
  }

  it('R-B 第二个引擎：结束第一个引擎后，另一个数据根上的引擎与它自己的那棵树身份不变、心跳仍在涨', async () => {
    const a = await Lab.open(); const b = await Lab.open();
    try {
      await a.startEngine(RED_ENV); await b.startEngine(RED_ENV); // 一个握手之后才起下一个
      const ta = await a.startTree('shell'); await a.grown(ta);
      const tb = await b.startTree('shell'); await b.grown(tb);
      await a.killEngine();
      const ev = await a.judge(ta, 'engine-kill', act('只结束第一个引擎', 'taskkill /PID <引擎 A> /F（不带 /T）', a.ref!.pid), 'engine');
      console.log('F09-R 证据：' + summary(ev));
      if (EVIDENCE) writeEvidence(EVIDENCE, ev, '-two-engines');
      // 第二个引擎与它的树：句柄都没退出，心跳在第一个引擎死后还在涨
      const roles = ['child', 'leaf', 'leaf-detached', 'leaf-orphan'].map(r => roleProc(tb, r)!);
      const beats = (): number[] => roles.map(p => lines(join(tb.fx, `beat-${p.role}-${p.pid}.log`)).length);
      const before = beats();
      await until('第二个引擎的树心跳仍在涨', () => beats().every((n, i) => n >= before[i] + 5), VERDICT_MS);
      expect([b.ref!.pid, tb.rootPid!, ...roles.map(p => p.pid)].filter(pid => b.observer.exited(pid))).toEqual([]);
      const snapB = await b.snapshot();
      if (snapB) expect((snapB.trees as any[]).filter(v => v.endedAt === undefined).map(v => v.root?.pid)).toEqual([tb.rootPid]);
      // 第一个引擎的树照常回收（a 没有起无关进程，这里只看树）
      expect(ev.rootReaped).toBe(true);
      if (ev.verdict === 'inconclusive') throw new EnvNotReady(`没有结论：${summary(ev)}`, 0);
      expect(ev.tree.map(r => `${r.role}=${r.verdict}`).join(' ')).toBe(ev.tree.map(r => `${r.role}=dead`).join(' '));
    } finally {
      await a.settle(true).catch(() => undefined); await a.close();
      await b.settle().catch(() => undefined); await b.close();
    }
  }, 2 * ENGINE_HANDSHAKE_MS + T(10));
});

/**
 * R-C、R-D：故意在树长到一半时动手（设计 §7.5）。每一轮一个引擎。
 *
 * 动手时刻锚在树的生长事件上（driver.pid 出现、某个角色登记），不锚在 RPC 应答上：应答之后的头几百毫秒里根还在冷启动、
 * 没有任何后代，那时结束引擎在 F09 之前也没有幸存者，这样的轮次把归属改坏了也照样绿。
 * 判定：引擎由内核记录退出之后，命令行里带本实验目录的进程（本实验起的全部 fixture 进程，只观察）应当一个不剩；
 * 回收是内核做的，轮询到没有为止，到引擎退出之后 VERDICT_MS 还有就是残留。
 * 有效轮：动手之前已经从 procs.jsonl 读到至少一个后代登记。空轮照样断言（不该有幸存者），但不计入结论。
 *
 * DESKMINIS_F09_RED=1：引擎带 DESKMINIS_PROC_OWNERSHIP=off 跑（托管停用 = F09 之前的启动与回收路径），断言不变——
 * 用来留「没有托管时这些格子是红的」的证据。DESKMINIS_F09_RD_DELAYS / _REPEAT 调整 R-D 的延迟档与每档次数（缺省 0,5,20,100 × 2）。
 */
const RD_DELAYS = (process.env.DESKMINIS_F09_RD_DELAYS ?? '0,5,20,100').split(',').map(Number).filter(n => Number.isFinite(n) && n >= 0);
const RD_REPEAT = Math.max(1, Number(process.env.DESKMINIS_F09_RD_REPEAT) || 2);
const RC_SESSIONS = Math.max(1, Number(process.env.DESKMINIS_F09_RC_SESSIONS) || 8);
type Anchor = 'E1' | 'E2' | 'E3' | 'E4';
type RapidEntry = Entry | 'mcp-probe';
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const descendants = (t: Tree): string[] => procsOf(t).map(p => p.role);

/** 结束引擎之后：等内核记下它的退出，再轮询本实验的幸存者到没有为止（上限 VERDICT_MS）。返回到点仍在的 PID，
 *  以及两段用时（发起结束到引擎退出、引擎退出到观察不到幸存者；后一段含观察者那次 CIM 查询自己的耗时）。 */
async function survivorsAfterKill(l: Lab): Promise<{ left: number[]; killMs: number; reapMs: number }> {
  const t0 = Date.now();
  await l.killEngine();
  try { await until('引擎退出', () => l.observer.exited(l.ref!.pid), VERDICT_MS); }
  catch { throw new EnvNotReady('结束引擎的动作没有生效', VERDICT_MS); }
  const t1 = Date.now();
  let left: number[] = [];
  try { await until('本实验的进程全部退出', async () => (left = await l.observer.survivors(l.token)).length === 0, VERDICT_MS, 250); } catch { /* 到点仍有：残留 */ }
  return { left, killMs: t1 - t0, reapMs: Date.now() - t1 };
}

interface RapidResult { registered: string[]; left: number[]; ms: { handshake: number; anchor: number; kill: number; reap: number } }
async function rapidRound(entry: RapidEntry, anchor: Anchor, delayMs: number): Promise<RapidResult> {
  const l = await Lab.open();
  try {
    await l.startEngine(RED_ENV);
    const started = Date.now();
    const t = entry === 'mcp-probe' ? await l.startProbe() : await l.startTree(entry);
    const kid = entry.startsWith('mcp') ? 'mcp' : 'child';
    const has = (role: string): boolean => roleProc(t, role) !== undefined;
    const reached: Record<Anchor, () => boolean> = {
      E1: () => existsSync(join(t.fx, 'driver.pid')),
      E2: () => has(kid),
      E3: () => has('leaf') || has('leaf-detached'),
      E4: () => has('bouncer'),
    };
    await until(`生长事件 ${anchor}（${entry}）`, reached[anchor], TREE_GROWN_MS, 5);
    const anchorMs = Date.now() - started;
    if (delayMs > 0) await sleep(delayMs); // 这不是用来排顺序的等待：延迟本身就是这一格的参数（锚点之后多久动手）
    const registered = descendants(t);
    const k = await survivorsAfterKill(l);
    return { registered, left: k.left, ms: { handshake: l.handshakeMs, anchor: anchorMs, kill: k.killMs, reap: k.reapMs } };
  } finally {
    await l.settle(true).catch(() => undefined);
    await l.close();
  }
}

describe.skipIf(!WIN || !FULL)('F09 真实引擎：快速起停与批量（R-C、R-D，FULL 档）', () => {
  const cells: [RapidEntry, Anchor[]][] = [
    ['shell', ['E1', 'E2', 'E3', 'E4']], ['terminal', ['E1', 'E2', 'E3', 'E4']],
    ['mcp-abs', ['E2', 'E3', 'E4']], ['mcp-bare', ['E2', 'E3', 'E4']], ['mcp-probe', ['E2', 'E3', 'E4']],
  ];
  for (const [entry, anchors] of cells) {
    for (const anchor of anchors) {
      it(`R-D ${entry} ${anchor}：生长事件之后 ${RD_DELAYS.join(' / ')} ms 只结束引擎（各 ${RD_REPEAT} 次），没有幸存者`, async () => {
        const rounds: ({ delay: number } & RapidResult)[] = [];
        for (const delay of RD_DELAYS) for (let i = 0; i < RD_REPEAT; i++) rounds.push({ delay, ...(await rapidRound(entry, anchor, delay)) });
        const line = rounds.map(r => `+${r.delay}ms 已登记[${r.registered.join(',')}] 幸存=${r.left.length}（握手 ${r.ms.handshake}ms、到锚点 ${r.ms.anchor}ms、引擎退出 ${r.ms.kill}ms、之后 ${r.ms.reap}ms 观察不到幸存者）`).join('；');
        console.log(`F09-R-D ${entry} ${anchor}: ${line}`);
        if (EVIDENCE) writeFileSync(join(EVIDENCE, `rd-${entry}-${anchor}.json`), JSON.stringify({ entry, anchor, red: RED, rounds }, null, 2));
        expect(rounds.filter(r => r.left.length > 0).map(r => `+${r.delay}ms 幸存 ${r.left.length} 个`)).toEqual([]);
        // 非空约束：E2–E4 按构造动手时根已有后代；E1 可能是空轮（没有后代出生），只记录
        if (anchor !== 'E1' && !rounds.every(r => r.registered.length > 0)) throw new EnvNotReady(`${anchor} 的轮次里有空轮：${line}`, 0);
        // E4 专门卡「父链刚断、最后一个角色还没起来」：至少一轮动手时 leaf-orphan 还没登记（凑不出只记录，不算失败）
        if (anchor === 'E4' && !rounds.some(r => !r.registered.includes('leaf-orphan'))) console.log(`F09-R-D ${entry} E4：本次各轮动手时 leaf-orphan 都已登记`);
      }, RD_DELAYS.length * RD_REPEAT * (ENGINE_HANDSHAKE_MS + T(5)));
    }
  }

  /** 批量：RC_SESSIONS 个会话各一棵 shell 树与一棵终端树，外加 2 台 MCP（绝对路径、裸名各一）。killAfter 为空 = 不动手、量生长窗口。 */
  interface BatchResult { windowMs: number; killAtMs: number | null; valid: boolean; registered: number; treesWithKids: number; trees: number; mcpStarts: number[]; left: number[] }
  async function batchRound(killAfter: number | null): Promise<BatchResult> {
    const l = await Lab.open();
    let killed = false;
    try {
      await l.startEngine(RED_ENV);
      // 一起发起、不逐棵等：生长事件在这些 RPC 还没全部应答时就开始了。引擎被结束之后在途的调用会失败，allSettled 兜住
      const entries: Entry[] = [];
      for (let i = 0; i < RC_SESSIONS; i++) entries.push('shell', 'terminal');
      entries.push('mcp-abs', 'mcp-bare');
      const starting = Promise.allSettled(entries.map(e => l.startTree(e)));
      const trees = (): Tree[] => l.trees; // startTree 一建目录就登记进来，不用等它返回
      const count = (): number => trees().reduce((n, t) => n + procsOf(t).length, 0);
      // 每台 MCP 服务器被起了几次（server 进程每起一次登记一行 mcp）：批量起跑时各会话的 run 都会去连它，应当只起一次
      const mcpStarts = (): number[] => trees().filter(t => t.entry.startsWith('mcp')).map(t => procsOf(t).filter(p => p.role === 'mcp').length);
      await until('批量：第一个生长事件', () => trees().some(t => existsSync(join(t.fx, 'driver.pid')) || procsOf(t).length > 0), TREE_GROWN_MS, 5);
      const first = Date.now();
      if (killAfter === null) {
        // 每棵树登记满五行（child / mcp、leaf、leaf-detached、bouncer、leaf-orphan）才算长成；只读文件，不经观察者，量出来的就是生长本身
        await until('批量：全部树长成', () => trees().length === entries.length && trees().every(t => procsOf(t).length >= 5), TREE_GROWN_MS, 5);
        const windowMs = Date.now() - first;
        await starting;
        return { windowMs, killAtMs: null, valid: true, registered: count(), treesWithKids: trees().length, trees: trees().length, mcpStarts: mcpStarts(), left: [] };
      }
      if (killAfter > 0) await sleep(killAfter); // 窗口内的随机时刻：延迟是这一轮的参数
      const registered = count();
      const treesWithKids = trees().filter(t => procsOf(t).length > 0).length;
      const killAtMs = Date.now() - first;
      killed = true;
      const k = await survivorsAfterKill(l);
      await starting;
      return { windowMs: killAtMs, killAtMs, valid: registered > 0, registered, treesWithKids, trees: trees().length, mcpStarts: mcpStarts(), left: k.left };
    } finally {
      await l.settle(killed).catch(() => undefined);
      await l.close();
    }
  }

  it(`R-C 批量（${RC_SESSIONS} 个会话各一棵 shell 树与终端树 + 2 台 MCP）：生长窗口内的随机时刻只结束引擎，3 个有效轮都没有幸存者`, async () => {
    const measure = await batchRound(null);
    console.log(`F09-R-C 生长窗口：${measure.windowMs}ms（${measure.trees} 棵树全部长成时共登记 ${measure.registered} 个进程；两台 MCP 各起了 ${measure.mcpStarts.join(' / ')} 次）`);
    expect(measure.mcpStarts).toEqual([1, 1]); // 各会话的 run 同时去连同一台服务器，只起一个进程
    expect(measure.registered).toBe(measure.trees * 5);
    const rounds: BatchResult[] = [];
    for (let attempt = 0; attempt < 10 && rounds.filter(r => r.valid).length < 3; attempt++) {
      const r = await batchRound(Math.floor(Math.random() * measure.windowMs));
      rounds.push(r);
      console.log(`F09-R-C 第 ${attempt + 1} 轮：第一个生长事件之后 ${r.killAtMs}ms 动手，那时 ${r.treesWithKids}/${r.trees} 棵树已有后代、共登记 ${r.registered} 个进程（${r.valid ? '有效' : '空轮'}），幸存 ${r.left.length}`);
    }
    if (EVIDENCE) writeFileSync(join(EVIDENCE, 'rc-batch.json'), JSON.stringify({ sessions: RC_SESSIONS, red: RED, measure, rounds }, null, 2));
    expect(rounds.filter(r => r.left.length > 0).map(r => `已登记 ${r.registered}，幸存 ${r.left.length}`)).toEqual([]); // 空轮同样不该有幸存者
    expect(rounds.filter(r => r.mcpStarts.some(n => n > 1)).map(r => r.mcpStarts.join(' / '))).toEqual([]);
    if (rounds.filter(r => r.valid).length < 3) throw new EnvNotReady(`重取 10 次仍凑不满 3 个有效轮（有效 ${rounds.filter(r => r.valid).length}）`, 0);
  }, 11 * (ENGINE_HANDSHAKE_MS + T(8)));
});
