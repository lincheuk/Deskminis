/**
 * F09 K 组：启动恢复给「结果未知」的调用补的那一句进程树去向（agent/run-recovery.ts 的 processNote + store/proc-ledger.ts 的 orphanNote）。
 *
 * 用 F05 的进程内崩溃模型（run-recovery-fixture.ts）：调用正在执行的那一刻取库快照，再在副本上开新一代账本做恢复。
 * 执行行由真实的 RunLedger 经调度器落（claims 是调度器对同一个执行器算出来的，不手写）；MCP 工具由真实的 McpManager
 * 注册（工具全名、截断、资源声明都是产品算的），只有 client 是假的；树行由真实的 ProcLedger 落。
 *
 * 钉的是：只有能唯一确定「这次调用跑在哪棵本机进程树上」时才加话；远端（streamable-http）MCP 的调用、前缀对不上的、
 * 试连的树、调用开始之后才起的树、读不出资源声明的，一律不加，F05 的文案逐字不变。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORPHAN_TEXT, recoverOnBoot } from '../src/minisd/agent/run-recovery';
import { McpManager, type McpClientLike } from '../src/minisd/mcp/manager';
import { McpServersStore } from '../src/minisd/mcp/config';
import type { McpNotification, McpToolInfo } from '../src/minisd/mcp/stdio';
import { MinisPaths } from '../src/minisd/paths';
import { PROC_NOTE_JOB, PROC_NOTE_UNVERIFIED, ProcLedger } from '../src/minisd/store/proc-ledger';
import { fxRead, gatedTool, ScriptProvider, toolTurn, withDeadline } from './scheduler-fixture';
import { HookTrace, execRows, ledgerEnv, openGeneration, resultsOf, startRun, type LedgerEnv } from './run-recovery-fixture';

const UNKNOWN = ORPHAN_TEXT['effect-unknown'];
/** 定稿的两句话（设计 §4.7）：写死在这里，文案被改动时这组用例要红。 */
const NOTE_JOB = '[进程] 这次调用所在的进程树由作业对象托管，树内的进程已随引擎停止由系统结束；已经产生的改动不会回滚。经系统服务、计划任务、提权、WSL / Docker 或桥命令另行启动的程序不在这棵树里，可能仍在运行。';
const NOTE_UNVERIFIED = '[进程] 这次调用启动的进程没有被作业对象托管，引擎停止后可能仍在运行并继续产生改动；继续之前请先确认（任务管理器或相关文件），必要时手动结束。';

/** 假 MCP client：调用进来的那一刻同步回调（取快照用），然后照常返回。 */
class FakeClient implements McpClientLike {
  onNotification: ((n: McpNotification) => void) | undefined;
  closed = false;
  constructor(private readonly tools: McpToolInfo[], private readonly onCall: () => void) {}
  async connect(): Promise<void> { /* 连上了 */ }
  async listTools(): Promise<McpToolInfo[]> { return this.tools; }
  async callTool(): Promise<unknown> { this.onCall(); return { content: [{ type: 'text', text: 'ok' }] }; }
  dispose(): void { this.closed = true; }
}

interface Fx {
  env: LedgerEnv; sid: string; trace: HookTrace;
  /** 前代（第 1 代）的进程账本：用例往里放树行。 */
  procs: ProcLedger;
  /** 时间拨到一小时之后的同代账本：放「调用开始之后才起」的树。 */
  later: ProcLedger;
  snap: { path: string };
  take(): void;
  /** 登记一批 MCP 服务器（stdio 用 command，http 用 url），各带一个工具 x；返回每台服务器那个工具的全名。 */
  mcp(servers: { name: string; http?: boolean }[]): Promise<Record<string, string>>;
  /** 跑一轮只调一个工具的 run，调用执行中取快照。 */
  crashIn(tool: string): Promise<void>;
}

function setup(label: string): Fx {
  const env = ledgerEnv(`f09k-${label}`);
  const trace = new HookTrace();
  const sid = env.newSession();
  const snap = { path: '' };
  const take = (): void => { if (!snap.path) snap.path = env.snapshot(); };
  // shell_execute 的替身：与真实的一样不是只读调用，执行中被打断落成 effect-unknown。副作用回调里取快照（调用正在执行）
  env.tools.register(gatedTool({ name: 'shell_execute', trace, effect: () => { take(); } }));
  env.tools.register(gatedTool({ name: 'file_write', trace, effect: () => { take(); } }));
  const status = () => ({ state: 'active' as const });
  const procs = new ProcLedger(env.db, { epoch: env.ledger.epoch, status, warn: () => undefined });
  const later = new ProcLedger(env.db, { epoch: env.ledger.epoch, status, warn: () => undefined, now: () => Date.now() / 1000 + 3600 });
  const mcp = async (servers: { name: string; http?: boolean }[]): Promise<Record<string, string>> => {
    const store = new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-f09k-mcp-'))));
    const before = new Set(env.tools.definitions().map(d => d.name));
    const names: Record<string, string> = {};
    const mgr = new McpManager({
      store, chatStore: env.store, registry: env.tools,
      factories: () => new FakeClient([{ name: 'x', description: '工具 x', inputSchema: { type: 'object', properties: {} } }], take),
    });
    // 一台一台连，才分得清新注册的那个工具是哪台服务器的（全名可能被截断，不能靠拼）
    for (const s of servers) {
      store.upsert(s.http ? { name: s.name, url: 'http://127.0.0.1:9/mcp' } : { name: s.name, command: 'echo', args: [] });
      await mgr.ensureForRun();
      const added = env.tools.definitions().map(d => d.name).filter(n => !before.has(n));
      expect(added, `服务器 ${s.name} 注册的工具`).toHaveLength(1);
      names[s.name] = added[0]; before.add(added[0]);
    }
    return names;
  };
  const crashIn = async (tool: string): Promise<void> => {
    // tool_title 是 MCP 工具的必填项（缺了在进门之前就被拒，谈不上「执行中」）
    await withDeadline(startRun(env, sid, new ScriptProvider([toolTurn([{ id: 'T', name: tool, input: { tag: 'T', tool_title: '调一下' } }])])).done, 5000, label);
    expect(snap.path, '调用执行中取到了快照').not.toBe('');
  };
  return { env, sid, trace, procs, later, snap, take, mcp, crashIn };
}

/** 在快照上「重启」：新一代运行账本 + 新一代进程账本，恢复时带上 processNote。返回那次调用落库的输出。 */
function recover(f: Fx, o: { note?: 'ledger' | 'none' | ((x: { executionId: string; sessionId: string; name: string; epoch: number }) => string | undefined) } = {}) {
  const g = openGeneration(f.snap.path);
  const procs = new ProcLedger(g.db, { epoch: g.ledger.epoch, status: () => ({ state: 'untested' }), warn: () => undefined });
  const asked: { executionId: string; sessionId: string; name: string; epoch: number }[] = [];
  const mode = o.note ?? 'ledger';
  const processNote = mode === 'none' ? undefined : (x: { executionId: string; sessionId: string; name: string; epoch: number }): string | undefined => {
    asked.push(x);
    return mode === 'ledger' ? procs.orphanNote(x) : mode(x);
  };
  const report = recoverOnBoot({ ...g.deps, ...(processNote ? { processNote } : {}) });
  const results = resultsOf(g.chat, f.sid);
  expect(results).toHaveLength(1);
  return { g, procs, report, asked, output: results[0].output, status: results[0].status, rows: execRows(g.db, f.sid) };
}
/** 直接改快照里那次调用的资源声明（模拟 F05 的行读不出依据）。 */
function setClaims(f: Fx, value: string | null): void {
  const side = new Database(f.snap.path);
  try { expect(side.prepare('UPDATE tool_executions SET claims_json=?').run(value).changes).toBe(1); } finally { side.close(); }
}
const jobTree = (l: ProcLedger, id: string, meta: Parameters<ProcLedger['opened']>[1], pid = 100): void => {
  l.opened(id, meta, { pid });
  l.protection(id, { protection: 'job', root: { pid, createdAt: '133500000000000000' }, preJob: true });
};
const noneTree = (l: ProcLedger, id: string, meta: Parameters<ProcLedger['opened']>[1], reason = 'no-owner-watch', pid = 200): void => {
  l.opened(id, meta, { pid });
  l.protection(id, { protection: 'none', reason });
};

describe('F09 恢复文案：结果未知的调用所在进程树的去向（K 组）', () => {
  it('两句话是定稿的字面量；第一句只对树内的进程下结论', () => {
    expect(PROC_NOTE_JOB).toBe(NOTE_JOB);
    expect(PROC_NOTE_UNVERIFIED).toBe(NOTE_UNVERIFIED);
    expect(NOTE_JOB).not.toContain('不会继续运行');
  });

  it('shell：树是 job → F05 原文 + 换行 + 第一句；processNote 拿到的是那次调用的执行行 id、会话、工具名与代次', async () => {
    const f = setup('shell-job');
    jobTree(f.procs, 't', { kind: 'shell', sessionId: f.sid });
    await f.crashIn('shell_execute');
    const r = recover(f);
    expect(r.rows).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown' }]);
    expect(r.status).toBe('unknown');
    expect(r.output).toBe(UNKNOWN + '\n' + NOTE_JOB);
    expect(r.asked).toEqual([{ executionId: r.rows[0].id, sessionId: f.sid, name: 'shell_execute', epoch: 1 }]);
    expect(r.report.failed).toEqual([]);
  });

  it('shell：树是 none 或还停在 pending → 第二句（状态只少报、不多报）', async () => {
    for (const kind of ['none', 'pending'] as const) {
      const f = setup(`shell-${kind}`);
      if (kind === 'none') noneTree(f.procs, 't', { kind: 'shell', sessionId: f.sid }, 'no-marker');
      else f.procs.opened('t', { kind: 'shell', sessionId: f.sid }, { pid: 7 });
      await f.crashIn('shell_execute');
      expect(recover(f).output, kind).toBe(UNKNOWN + '\n' + NOTE_UNVERIFIED);
    }
  });

  it('shell：同会话先后两棵树，取引擎停止时还开着的最新一棵；别的会话的树、终端的树不算', async () => {
    const f = setup('shell-latest');
    noneTree(f.procs, 'old', { kind: 'shell', sessionId: f.sid }, 'no-marker');
    f.procs.stopRequested('old', 'timeout'); f.procs.ended('old', { kind: 'stopped', exitCode: 1, signal: null }); // 那一代里已经结束
    jobTree(f.procs, 'new', { kind: 'shell', sessionId: f.sid });
    noneTree(f.procs, 'term', { kind: 'terminal', sessionId: f.sid });
    noneTree(f.procs, 'other', { kind: 'shell', sessionId: 'someone-else' });
    await f.crashIn('shell_execute');
    expect(recover(f).output).toBe(UNKNOWN + '\n' + NOTE_JOB);
  });

  it('stdio MCP：资源声明里的服务器名等于树的 owner_ref、前缀相符 → 取那棵树；同名两棵、一棵 none → 第二句', async () => {
    const one = setup('mcp-one');
    const n1 = await one.mcp([{ name: 'srv' }]);
    expect(n1.srv).toBe('mcp__srv__x');
    jobTree(one.procs, 't', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__srv__' });
    await one.crashIn(n1.srv);
    const r = recover(one);
    expect(JSON.parse(r.rows[0].claims_json)).toContain('named:mcp:srv'); // 声明是调度器算的，不是手写的
    expect(r.output).toBe(UNKNOWN + '\n' + NOTE_JOB);

    const two = setup('mcp-two');
    const n2 = await two.mcp([{ name: 'srv' }]);
    jobTree(two.procs, 'a', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__srv__' });
    noneTree(two.procs, 'b', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__srv__' }, 'fallback:launcher-deadline');
    await two.crashIn(n2.srv);
    expect(recover(two).output).toBe(UNKNOWN + '\n' + NOTE_UNVERIFIED);
  });

  it('http MCP 的孤儿调用没有进程树：同代另有一棵 job 的 stdio 树也不加话（远端的操作可能还在进行）', async () => {
    const f = setup('http');
    const n = await f.mcp([{ name: 'remote', http: true }, { name: 'local' }]);
    expect(n.remote).toBe('mcp__remote__x');
    jobTree(f.procs, 't', { kind: 'mcp', ownerRef: 'local', toolPrefix: 'mcp__local__' });
    await f.crashIn(n.remote);
    const r = recover(f);
    expect(JSON.parse(r.rows[0].claims_json)).toContain('named:mcp:remote');
    expect(r.asked).toHaveLength(1); // 问过了，账本答的是「没有依据」
    expect(r.output).toBe(UNKNOWN);
  });

  it('前缀互相包含（stdio a 与 http a__b）、规范化后同名（stdio a_b 与 http a.b）：都不加话', async () => {
    const f = setup('contain');
    const n = await f.mcp([{ name: 'a__b', http: true }]);
    expect(n['a__b']).toBe('mcp__a__b__x'); // 以 stdio 服务器 a 的前缀 mcp__a__ 开头
    jobTree(f.procs, 't', { kind: 'mcp', ownerRef: 'a', toolPrefix: 'mcp__a__' });
    await f.crashIn(n['a__b']);
    expect(recover(f).output).toBe(UNKNOWN);

    const g = setup('normalized');
    const m = await g.mcp([{ name: 'a.b', http: true }]);
    expect(m['a.b']).toBe('mcp__a_b__x'); // 与 stdio 服务器 a_b 的工具全名一模一样
    jobTree(g.procs, 't', { kind: 'mcp', ownerRef: 'a_b', toolPrefix: 'mcp__a_b__' });
    await g.crashIn(m['a.b']);
    const r = recover(g);
    expect(JSON.parse(r.rows[0].claims_json)).toContain('named:mcp:a.b'); // 声明里是原文
    expect(r.output).toBe(UNKNOWN);
  });

  it('超长服务器名（全名被截断成 65 个字符）：命中自己的那棵树；前 52 个字符相同的另一台服务器的树不被选中', async () => {
    const L1 = 'x'.repeat(60) + '1'; const L2 = 'x'.repeat(60) + '2';
    for (const [mine, jobOwner] of [[L1, L2], [L2, L1]] as const) {
      const f = setup('long');
      const n = await f.mcp([{ name: L1 }, { name: L2 }]);
      expect(n[L1]).toHaveLength(65); expect(n[L2]).toHaveLength(65);
      expect(n[L1].slice(0, 52)).toBe(n[L2].slice(0, 52)); expect(n[L1]).not.toBe(n[L2]);
      // 一台的树是 job，另一台的是 none：选错了树，句子就会反过来
      for (const s of [L1, L2]) {
        if (s === jobOwner) jobTree(f.procs, s, { kind: 'mcp', ownerRef: s, toolPrefix: `mcp__${s}__` });
        else noneTree(f.procs, s, { kind: 'mcp', ownerRef: s, toolPrefix: `mcp__${s}__` });
      }
      await f.crashIn(n[mine]);
      expect(recover(f).output).toBe(UNKNOWN + '\n' + (mine === jobOwner ? NOTE_JOB : NOTE_UNVERIFIED));
    }
  });

  it('对不上就不加：前缀不符、试连的树（没有 tool_prefix）、调用开始之后才起的树、那一代里已结束的树；没有「按全部 MCP 树」这条路', async () => {
    const cases: [string, (f: Fx) => void][] = [
      ['前缀不符', f => jobTree(f.procs, 't', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__other__' })],
      ['试连的树', f => jobTree(f.procs, 't', { kind: 'mcp', ownerRef: 'srv' })],
      ['晚于调用的树', f => jobTree(f.later, 't', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__srv__' })],
      ['已结束的树', f => { jobTree(f.procs, 't', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__srv__' }); f.procs.ended('t', { kind: 'exited', exitCode: 0, signal: null }); }],
      ['别的服务器的树', f => { jobTree(f.procs, 't', { kind: 'mcp', ownerRef: 'elsewhere', toolPrefix: 'mcp__elsewhere__' }); jobTree(f.procs, 'u', { kind: 'shell', sessionId: f.sid }); }],
    ];
    for (const [what, plant] of cases) {
      const f = setup('miss');
      const n = await f.mcp([{ name: 'srv' }]);
      plant(f);
      await f.crashIn(n.srv);
      expect(recover(f).output, what).toBe(UNKNOWN);
    }
  });

  it('资源声明读不出依据（为空、不是合法 JSON、不是数组、没有 named:mcp:、有两条）：不加话', async () => {
    const bad: [string, string | null][] = [
      ['为空', null], ['不是合法 JSON', '{oops'], ['不是数组', '{"named:mcp:srv":1}'],
      ['没有 named:mcp:', '["session:abc"]'], ['有两条', '["named:mcp:srv","named:mcp:srv2"]'],
    ];
    for (const [what, value] of bad) {
      const f = setup('claims');
      const n = await f.mcp([{ name: 'srv' }]);
      jobTree(f.procs, 't', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__srv__' });
      await f.crashIn(n.srv);
      setClaims(f, value);
      expect(recover(f).output, what).toBe(UNKNOWN);
    }
    // 对照：同样的布置、声明原样时是加话的（上面五格不是因为别的原因才不加）
    const f = setup('claims-ok');
    const n = await f.mcp([{ name: 'srv' }]);
    jobTree(f.procs, 't', { kind: 'mcp', ownerRef: 'srv', toolPrefix: 'mcp__srv__' });
    await f.crashIn(n.srv);
    expect(recover(f).output).toBe(UNKNOWN + '\n' + NOTE_JOB);
  });

  it('没有 processNote、没有树行、别的工具：输出与 F05 逐字相同', async () => {
    const noHook = setup('no-hook');
    jobTree(noHook.procs, 't', { kind: 'shell', sessionId: noHook.sid });
    await noHook.crashIn('shell_execute');
    expect(recover(noHook, { note: 'none' }).output).toBe(UNKNOWN);

    const noTree = setup('no-tree');
    await noTree.crashIn('shell_execute');
    expect(recover(noTree).output).toBe(UNKNOWN);

    const other = setup('other-tool');
    jobTree(other.procs, 't', { kind: 'shell', sessionId: other.sid });
    await other.crashIn('file_write');
    const r = recover(other);
    expect(r.asked.map(x => x.name)).toEqual(['file_write']);
    expect(r.output).toBe(UNKNOWN);
  });

  it('别的 endKind 不问 processNote：未执行、只读被打断的调用输出是 F05 原文', async () => {
    // 意图之前：toolStart 事件那一刻取快照 → not-started
    const f = setup('not-started');
    jobTree(f.procs, 't', { kind: 'shell', sessionId: f.sid });
    const run = startRun(f.env, f.sid, new ScriptProvider([toolTurn([{ id: 'T', name: 'shell_execute', input: { tag: 'T' } }])]));
    run.onEvent(e => { if (e.kind === 'toolStart') f.take(); });
    await withDeadline(run.done, 5000, 'not-started');
    const r = recover(f, { note: () => NOTE_JOB });
    expect(r.rows).toMatchObject([{ end_kind: 'not-started' }]);
    expect(r.asked).toEqual([]);
    expect(r.output).toBe(ORPHAN_TEXT['not-started']);

    // 只读调用执行中被打断 → interrupted-readonly
    const g = setup('readonly');
    jobTree(g.procs, 't', { kind: 'shell', sessionId: g.sid });
    g.env.tools.register(fxRead({ trace: g.trace }));
    g.trace.on('R:enter', g.take);
    const file = join(g.env.root, 'read-me.txt');
    writeFileSync(file, '内容', 'utf8');
    await withDeadline(startRun(g.env, g.sid, new ScriptProvider([toolTurn([{ id: 'R', name: 'fx_read', input: { tag: 'R', path: file } }])])).done, 5000, 'readonly');
    const g2 = openGeneration(g.snap.path);
    const asked: string[] = [];
    recoverOnBoot({ ...g2.deps, processNote: x => { asked.push(x.name); return NOTE_JOB; } });
    expect(execRows(g2.db, g.sid)).toMatchObject([{ end_kind: 'interrupted-readonly' }]);
    expect(asked).toEqual([]);
    expect(resultsOf(g2.chat, g.sid).map(x => x.output)).toEqual([ORPHAN_TEXT['interrupted-readonly']]);
  });

  it('processNote 抛错或返回空串：恢复照常完成，文案是 F05 原文', async () => {
    for (const note of [() => { throw new Error('注入：查询失败'); }, () => ''] as const) {
      const f = setup('throws');
      jobTree(f.procs, 't', { kind: 'shell', sessionId: f.sid });
      await f.crashIn('shell_execute');
      const r = recover(f, { note });
      expect(r.asked).toHaveLength(1);
      expect(r.output).toBe(UNKNOWN);
      expect(r.report.failed).toEqual([]);
      expect(r.rows).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown' }]);
    }
  });

  it('恢复之后关账不改变已经落库的文案；本代的进程账本对本代的行不作答', async () => {
    const f = setup('after-close');
    jobTree(f.procs, 't', { kind: 'shell', sessionId: f.sid });
    await f.crashIn('shell_execute');
    const r = recover(f);
    expect(r.procs.closeOrphans().map(t => ({ end: t.endKind, reaped: t.reaped }))).toEqual([{ end: 'engine-lost', reaped: 'job' }]);
    expect(resultsOf(r.g.chat, f.sid)[0].output).toBe(UNKNOWN + '\n' + NOTE_JOB);
    expect(r.procs.orphanNote({ executionId: r.rows[0].id, sessionId: f.sid, name: 'shell_execute', epoch: r.g.ledger.epoch })).toBeUndefined();
  });
  it.each(['both', 'file-throws', 'process-throws'] as const)('F08 文件事实与 F09 进程说明独立追加：%s', async mode => {
    const f = setup('file-process-' + mode);
    await f.crashIn('shell_execute');
    const g = openGeneration(f.snap.path);
    const calls: string[] = [];
    const report = recoverOnBoot({
      ...g.deps,
      effectEvidence: () => { calls.push('file'); if (mode === 'file-throws') throw new Error('file evidence unavailable'); return ['checkpoint fact']; },
      processNote: () => { calls.push('process'); if (mode === 'process-throws') throw new Error('process evidence unavailable'); return NOTE_JOB; },
    });
    const result = resultsOf(g.chat, f.sid);
    expect(calls).toEqual(['file', 'process']);
    expect(result).toHaveLength(1);
    const fileNote = mode === 'file-throws' ? '' : '\n按文件检查点核实：\ncheckpoint fact';
    const processNote = mode === 'process-throws' ? '' : '\n' + NOTE_JOB;
    expect(result[0].output).toBe(UNKNOWN + fileNote + processNote);
    expect(result[0].status).toBe('unknown');
    expect(execRows(g.db, f.sid)).toMatchObject([{ state: 'unknown', end_kind: 'effect-unknown' }]);
    expect(report.failed).toEqual([]);
  });

});
