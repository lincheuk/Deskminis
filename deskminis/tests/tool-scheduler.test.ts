/**
 * F04 调度器（tools/scheduler.ts）：同批顺序、不重叠调用的实际并发、跨会话互斥、barrier、取消与超时、失败放锁。
 *
 * 顺序断言一律看工具侧 Trace（进门 / 副作用 / 出门）、真实文件内容、网关收到的请求、假 spawn 与假 MCP client 的调用记录；
 * 受控延迟只用 Gate、Rendezvous 与挂起的权限请求，由测试决定谁先放行。「还在等」用锁表快照正面断言（untilWaiting），
 * 不靠睡一会儿看它没跑。
 *
 * 每个用例自己建 ToolScheduler（要读 locks.snapshot()、注入超时），数据根与会话 id 互不相同。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getEventListeners } from 'node:events';
import {
  ToolScheduler, cancelSourceOf, wrapPermissions,
  type ScheduledCall, type ScheduledResult, type SchedulerEvent, type ToolSchedulerOptions,
} from '../src/minisd/tools/scheduler';
import { ResourceLockManager } from '../src/minisd/tools/resource-locks';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { MinisPaths } from '../src/minisd/paths';
import type {
  PermissionDecision, PermissionGateway, PermissionRequest, ToolContext, ToolExecutor, ToolScheduling,
} from '../src/minisd/tools/types';
import { fileReadTool, fileWriteTool } from '../src/minisd/tools/files';
import { ShellManager, makeShellTool } from '../src/minisd/tools/shell';
import type { McpToolInfo } from '../src/minisd/mcp/stdio';
import {
  Gate, ManualGateway, Rendezvous, Trace, allowAll, fakeShellSpawn, fxPure, fxRead, fxSwap, fxTreeRead, fxUnknown, fxWrite,
  gatedTool, mcpOn, settle, untilWaiting, withDeadline,
} from './scheduler-fixture';

// ---------- 环境 ----------

type RunOver = Partial<Pick<ToolContext, 'permissions' | 'signal'>>;

/** 一个用例的环境：自己的数据根、注册表、调度器与 trace。预置 fixture 工具共用一张 gates 表（入参 gate 指名）。 */
function mkEnv(label: string, opts: ToolSchedulerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), `dm-f04-s-${label}-`));
  const paths = new MinisPaths(root);
  const registry = new ToolRegistry();
  const scheduler = new ToolScheduler(opts);
  const trace = new Trace();
  const gates = new Map<string, Gate>();
  const events: SchedulerEvent[] = [];
  const gateOf = (input: Record<string, unknown>): Gate | undefined => gates.get(String(input.gate));
  for (const mk of [fxRead, fxWrite, fxSwap, fxUnknown, fxTreeRead, fxPure]) registry.register(mk({ trace, gateOf }));
  return {
    root, paths, registry, scheduler, trace, events, gateOf,
    locks: scheduler.locks,
    gate(name: string): Gate { const g = new Gate(); gates.set(name, g); return g; },
    /** 数据根 shared/f04 下的宿主绝对路径（在任何会话的工作区之外）；给了 content 就先写好。 */
    file(rel: string, content?: string): string {
      const abs = join(root, 'shared', 'f04', rel);
      if (content !== undefined) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content, 'utf8'); }
      return abs;
    },
    ctx(sessionId: string, over: RunOver = {}): ToolContext {
      paths.ensureSessionDirs(sessionId);
      return { sessionId, paths, permissions: allowAll, ...over };
    },
    run(sessionId: string, calls: ScheduledCall[], over: RunOver = {}): Promise<ScheduledResult[]> {
      return scheduler.runBatch({ calls, registry, ctx: this.ctx(sessionId, over), onEvent: e => { events.push(e); } });
    },
    kindsOf(toolUseId: string): string[] { return events.filter(e => e.toolUseId === toolUseId).map(e => e.kind); },
  };
}

/** 一次调用：toolUseId 同时作 trace 前缀（tag）。 */
function call(id: string, name: string, input: Record<string, unknown> = {}): ScheduledCall {
  return { toolUseId: id, name, input: JSON.stringify({ tag: id, tool_title: id, ...input }) };
}

const read = (p: string): string => readFileSync(p, 'utf8');
/** trace 里只留进门与出门两笔。 */
const doors = (t: Trace): string[] => t.lines.filter(l => l.endsWith(':enter') || l.endsWith(':exit'));

// ---------- V1：同批顺序与实际并发 ----------

describe('F04 调度器 V1：同批顺序稳定', () => {
  it('S1 写→读：写没出门之前读不进门，读到的是新内容', async () => {
    const e = mkEnv('S1');
    const P = e.file('p.txt', 'old');
    const g = e.gate('g');
    const done = e.run('s1', [call('W', 'fx_write', { path: P, content: 'new', gate: 'g' }), call('R', 'fx_read', { path: P })]);

    await e.trace.until('W:enter');
    const waiting = await untilWaiting(e.locks, '/R/');
    expect(waiting.foreignBlocked).toBe(false);
    expect(e.trace.lines).toEqual(['W:enter']);
    g.open();
    const [w, r] = await withDeadline(done, 5000, 'S1 批次结束');

    expect(w).toMatchObject({ end: 'completed', started: true, outcome: { success: true } });
    expect(r.outcome).toEqual({ output: 'new', success: true });
    expect(doors(e.trace)).toEqual(['W:enter', 'W:exit', 'R:enter', 'R:exit']);
  });

  it('S2 读→写：读没出门之前写不进门，读到旧内容，最终磁盘是新内容', async () => {
    const e = mkEnv('S2');
    const P = e.file('p.txt', 'old');
    const g = e.gate('g');
    const done = e.run('s2', [call('R', 'fx_read', { path: P, gate: 'g' }), call('W', 'fx_write', { path: P, content: 'new' })]);

    await e.trace.until('R:enter');
    await untilWaiting(e.locks, '/W/');
    expect(e.trace.has('W:enter')).toBe(false);
    expect(read(P)).toBe('old');
    g.open();
    const [r, w] = await withDeadline(done, 5000, 'S2 批次结束');

    expect(r.outcome).toEqual({ output: 'old', success: true });
    expect(w.outcome.success).toBe(true);
    expect(read(P)).toBe('new');
    expect(doors(e.trace)).toEqual(['R:enter', 'R:exit', 'W:enter', 'W:exit']);
  });

  it('S3 写→写：按调用顺序各执行一次，最终是后一次的内容', async () => {
    const e = mkEnv('S3');
    const P = e.file('p.txt', '0');
    const g = e.gate('g');
    const done = e.run('s3', [
      call('1', 'fx_write', { path: P, content: '1', gate: 'g' }),
      call('2', 'fx_write', { path: P, content: '2' }),
    ]);

    await e.trace.until('1:enter');
    await untilWaiting(e.locks, '/2/');
    expect(e.trace.has('2:enter')).toBe(false);
    g.open();
    await withDeadline(done, 5000, 'S3 批次结束');

    expect(doors(e.trace)).toEqual(['1:enter', '1:exit', '2:enter', '2:exit']);
    expect(read(P)).toBe('2');
  });
});

describe('F04 调度器 V1：不重叠的调用实际并发', () => {
  it('S4 5 个读不同文件的只读调用 + 2 个无资源只读调用同时在场', async () => {
    const e = mkEnv('S4');
    const rv = new Rendezvous(7);
    e.registry.register(fxRead({ name: 'rv_read', trace: e.trace, rendezvous: rv }));
    e.registry.register(fxPure({ name: 'rv_pure', trace: e.trace, rendezvous: rv }));
    const calls = [
      ...[0, 1, 2, 3, 4].map(i => call(`R${i}`, 'rv_read', { path: e.file(`f${i}.txt`, `c${i}`) })),
      call('N0', 'rv_pure'), call('N1', 'rv_pure'),
    ];
    const results = await withDeadline(e.run('s4', calls), 10000, 'S4 批次结束');

    expect(rv.met).toBe(true);
    expect(rv.maxActive).toBe(7);
    expect(results.map(r => r.outcome.success)).toEqual(Array(7).fill(true));
    expect(results.slice(0, 5).map(r => r.outcome.output)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('S5 真实 file_read 的声明：读三个文件的调用同时在场，输出各是各的内容', async () => {
    const e = mkEnv('S5');
    const rv = new Rendezvous(3);
    // 元数据原样沿用真实工具的；只在 execute 外面套一层会合点
    const probe: ToolExecutor = {
      ...fileReadTool,
      async execute(input, ctx) {
        await rv.arrive();
        try { return await fileReadTool.execute(input, ctx); } finally { rv.leave(); }
      },
    };
    e.registry.register(probe);
    const ws = e.ctx('s5').paths.workspaceOf('s5');
    for (const n of ['a', 'b', 'c']) writeFileSync(join(ws, `${n}.txt`), `内容-${n}`, 'utf8');
    const results = await withDeadline(
      e.run('s5', ['a', 'b', 'c'].map(n => call(n, 'file_read', { path: `${n}.txt` }))), 10000, 'S5 批次结束');

    expect(rv.maxActive).toBe(3);
    expect(results.map(r => r.outcome)).toEqual(['a', 'b', 'c'].map(n => ({ output: `内容-${n}`, success: true })));
  });

  it('S6 写不同文件的两个调用同时在场（不是把所有写都串行）', async () => {
    const e = mkEnv('S6');
    const rv = new Rendezvous(2);
    e.registry.register(fxWrite({ name: 'rv_write', trace: e.trace, rendezvous: rv }));
    const A = e.file('a.txt'); const B = e.file('b.txt');
    const results = await withDeadline(e.run('s6', [
      call('A', 'rv_write', { path: A, content: 'a' }), call('B', 'rv_write', { path: B, content: 'b' }),
    ]), 10000, 'S6 批次结束');

    expect(rv.maxActive).toBe(2);
    expect(results.map(r => r.outcome.success)).toEqual([true, true]);
    expect([read(A), read(B)]).toEqual(['a', 'b']);
  });

  it('S7 每会话并发上限 10：12 个互不重叠的读只有 10 个同时在场，放掉一个第 11 个才进门', async () => {
    const e = mkEnv('S7');
    const rv = new Rendezvous(10);
    e.registry.register(fxRead({ name: 'rv_read', trace: e.trace, rendezvous: rv, gateOf: e.gateOf }));
    const gates = Array.from({ length: 12 }, (_, i) => e.gate(`g${i}`));
    const calls = Array.from({ length: 12 }, (_, i) => call(`R${i}`, 'rv_read', { path: e.file(`f${i}.txt`, `c${i}`), gate: `g${i}` }));
    const done = e.run('s7', calls);

    await e.trace.until('R9:enter');
    await untilWaiting(e.locks, '/R10/');
    await settle();
    expect(rv.maxActive).toBe(10);
    expect(e.trace.lines.filter(l => l.endsWith(':enter'))).toHaveLength(10);
    // 只被并发上限挡住：不算被别的会话挡住，不计时
    expect(e.locks.snapshot().waiting.map(w => w.foreignBlocked)).toEqual([false, false]);

    gates[0].open();
    await e.trace.until('R10:enter');
    await settle();
    expect(e.trace.has('R11:enter')).toBe(false);
    for (const g of gates) g.open();
    const results = await withDeadline(done, 10000, 'S7 批次结束');

    expect(rv.maxActive).toBe(10);
    expect(results.map(r => r.outcome.output)).toEqual(Array.from({ length: 12 }, (_, i) => `c${i}`));
  });

  it('S8 结果按调用下标交回：逆序完成、toolUseId 重复都不串', async () => {
    const e = mkEnv('S8');
    const gates = [0, 1, 2, 3].map(i => e.gate(`g${i}`));
    // 后两个调用的 toolUseId 相同
    const calls: ScheduledCall[] = ['A', 'B', 'DUP', 'DUP'].map((id, i) => ({
      toolUseId: id, name: 'fx_pure', input: JSON.stringify({ tag: `t${i}`, tool_title: id, gate: `g${i}` }),
    }));
    const done = e.run('s8', calls);
    for (const i of [3, 2, 1, 0]) {
      await e.trace.until(`t${i}:enter`);
      gates[i].open();
      await e.trace.until(`t${i}:exit`);
    }
    const results = await withDeadline(done, 5000, 'S8 批次结束');

    expect(e.trace.lines.filter(l => l.endsWith(':exit'))).toEqual(['t3:exit', 't2:exit', 't1:exit', 't0:exit']);
    expect(results).toHaveLength(4);
    results.forEach((r, i) => {
      expect(r.call).toBe(calls[i]);
      expect(r.outcome).toEqual({ output: `t${i} ok`, success: true });
    });
  });
});

// ---------- V2：跨会话、路径身份、父子、多资源 ----------

describe('F04 调度器 V2：跨会话与路径身份', () => {
  it('S9 两个会话写同一文件：后到的在锁表里等（被别的会话挡住），前一个出门后才进门', async () => {
    const e = mkEnv('S9');
    const P = e.file('p.txt', '0');
    const g = e.gate('g');
    const doneA = e.run('a', [call('A', 'fx_write', { path: P, content: 'A', gate: 'g' })]);
    await e.trace.until('A:enter');
    const doneB = e.run('b', [call('B', 'fx_write', { path: P, content: 'B' })]);

    expect((await untilWaiting(e.locks, '/B/')).foreignBlocked).toBe(true);
    await settle();
    expect(e.trace.has('B:enter')).toBe(false);
    g.open();
    await withDeadline(Promise.all([doneA, doneB]), 5000, 'S9 两个会话结束');

    expect(doors(e.trace)).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
    expect(read(P)).toBe('B');
  });

  it.runIf(process.platform === 'win32')('S10 Windows 大小写别名是同一把锁：同批、跨会话都有序，目录里只有一个文件（真机）', async () => {
    const e = mkEnv('S10');
    const dir = join(e.root, 'shared', 'case');
    mkdirSync(dir, { recursive: true });
    const mixed = join(dir, 'Foo.txt'); const upper = join(dir, 'FOO.TXT');

    const g1 = e.gate('g1');
    const batch = e.run('s10', [
      call('1', 'fx_write', { path: mixed, content: '1', gate: 'g1' }), call('2', 'fx_write', { path: upper, content: '2' }),
    ]);
    await e.trace.until('1:enter');
    await untilWaiting(e.locks, '/2/');
    expect(e.trace.has('2:enter')).toBe(false);
    g1.open();
    await withDeadline(batch, 5000, 'S10 同批结束');
    expect(doors(e.trace)).toEqual(['1:enter', '1:exit', '2:enter', '2:exit']);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(read(mixed)).toBe('2');

    const g2 = e.gate('g2');
    const doneA = e.run('a', [call('3', 'fx_write', { path: upper, content: '3', gate: 'g2' })]);
    await e.trace.until('3:enter');
    const doneB = e.run('b', [call('4', 'fx_write', { path: mixed, content: '4' })]);
    expect((await untilWaiting(e.locks, '/4/')).foreignBlocked).toBe(true);
    await settle();
    expect(e.trace.has('4:enter')).toBe(false);
    g2.open();
    await withDeadline(Promise.all([doneA, doneB]), 5000, 'S10 跨会话结束');
    expect(doors(e.trace).slice(4)).toEqual(['3:enter', '3:exit', '4:enter', '4:exit']);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(read(mixed)).toBe('4');
  });

  it('S11 经链接路径与真实路径写同一文件（真实 junction / 目录符号链接）：两个会话有序，内容是后者的', async () => {
    const e = mkEnv('S11');
    const real = join(e.root, 'shared', 'real');
    const link = join(e.root, 'shared', 'link');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const viaLink = join(link, 'f.txt'); const viaReal = join(real, 'f.txt');

    const g = e.gate('g');
    const doneA = e.run('a', [call('A', 'fx_write', { path: viaLink, content: 'A', gate: 'g' })]);
    await e.trace.until('A:enter');
    const doneB = e.run('b', [call('B', 'fx_write', { path: viaReal, content: 'B' })]);
    expect((await untilWaiting(e.locks, '/B/')).foreignBlocked).toBe(true);
    await settle();
    expect(e.trace.has('B:enter')).toBe(false);
    g.open();
    await withDeadline(Promise.all([doneA, doneB]), 5000, 'S11 两个会话结束');

    expect(doors(e.trace)).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
    expect(read(viaReal)).toBe('B');
    expect(read(viaLink)).toBe('B');
  });

  it('S12 父目录与子文件算重叠：同批「列目录→往里写」要排；跨会话，工作区写锁挡住别的会话往里写', async () => {
    const e = mkEnv('S12');
    const D = join(e.root, 'shared', 'tree');
    mkdirSync(join(D, 'sub'), { recursive: true });
    writeFileSync(join(D, 'sub', 'old.txt'), 'o', 'utf8');
    const g1 = e.gate('g1');
    const batch = e.run('s12', [
      call('T', 'fx_tree', { path: D, gate: 'g1' }), call('W', 'fx_write', { path: join(D, 'sub', 'x.txt'), content: 'x' }),
    ]);
    await e.trace.until('T:enter');
    await untilWaiting(e.locks, '/W/');
    expect(e.trace.has('W:enter')).toBe(false);
    g1.open();
    const [t] = await withDeadline(batch, 5000, 'S12 同批结束');
    // 清单是写入之前的：后写的 x.txt 不在里面
    expect(t.outcome).toEqual({ output: 'sub/old.txt', success: true });
    expect(doors(e.trace)).toEqual(['T:enter', 'T:exit', 'W:enter', 'W:exit']);

    // 跨会话：未声明工具占着会话 a 的工作区（子树写），会话 b 往里面的子目录写
    const wsA = e.ctx('a').paths.workspaceOf('a');
    const target = join(wsA, 'sub', 'x.txt');
    const g2 = e.gate('g2');
    const doneA = e.run('a', [call('U', 'fx_unknown', { gate: 'g2' })]);
    await e.trace.until('U:enter');
    const doneB = e.run('b', [call('B', 'fx_write', { path: target, content: 'b' })]);
    expect((await untilWaiting(e.locks, '/B/')).foreignBlocked).toBe(true);
    await settle();
    expect(e.trace.has('B:enter')).toBe(false);
    expect(existsSync(target)).toBe(false);
    g2.open();
    await withDeadline(Promise.all([doneA, doneB]), 5000, 'S12 跨会话结束');
    expect(e.trace.at('U:exit')).toBeLessThan(e.trace.at('B:enter'));
    expect(read(target)).toBe('b');
  });

  it('S13 D 与 D-evil 不重叠（按段比较，不是字符串前缀）：占着工作区 D 时，别的会话写 D-evil 下的文件不被挡', async () => {
    const e = mkEnv('S13');
    const rv = new Rendezvous(2);
    e.registry.register(fxUnknown({ name: 'rv_unknown', trace: e.trace, rendezvous: rv, gateOf: e.gateOf }));
    e.registry.register(fxWrite({ name: 'rv_write', trace: e.trace, rendezvous: rv }));
    const wsA = e.ctx('a').paths.workspaceOf('a');
    const evil = join(`${wsA}-evil`, 'x.txt');
    const g = e.gate('g');
    const doneA = e.run('a', [call('U', 'rv_unknown', { gate: 'g' })]);
    await e.trace.until('U:enter');
    // 同场对照：往 D 里面写的会话 b 要等
    const doneB = e.run('b', [call('B', 'fx_write', { path: join(wsA, 'sub', 'x.txt'), content: 'b' })]);
    await untilWaiting(e.locks, '/B/');

    const [c] = await withDeadline(e.run('c', [call('C', 'rv_write', { path: evil, content: 'c' })]), 5000, 'S13 会话 c 结束');
    expect(c).toMatchObject({ end: 'completed', outcome: { success: true } });
    // c 与持锁的 U 同时在场
    expect(rv.maxActive).toBe(2);
    expect(read(evil)).toBe('c');
    expect(e.trace.has('U:exit')).toBe(false);
    expect(e.trace.has('B:enter')).toBe(false);
    g.open();
    await withDeadline(Promise.all([doneA, doneB]), 5000, 'S13 收尾');
  });

  it('S14 两个多资源调用（A 换 X、Y，B 换 Y、X）同一拍提交不死锁，再叠一个 C 换 X、Z', async () => {
    const e = mkEnv('S14');
    const X = e.file('x.txt', 'x'); const Y = e.file('y.txt', 'y'); const Z = e.file('z.txt', 'z');
    const all = Promise.all([
      e.run('a', [call('A', 'fx_swap', { a: X, b: Y })]),
      e.run('b', [call('B', 'fx_swap', { a: Y, b: X })]),
      e.run('c', [call('C', 'fx_swap', { a: X, b: Z })]),
    ]);
    const results = await withDeadline(all, 2000, 'S14 三个会话全部完成');
    expect(results.flat().map(r => r.outcome.success)).toEqual([true, true, true]);

    // 三个调用两两冲突（都碰 X）：trace 里各自的 进门…出门 是连续的一段，互不交错
    for (const tag of ['A', 'B', 'C']) {
      const from = e.trace.at(`${tag}:enter`);
      expect(e.trace.lines.slice(from, from + 3)).toEqual([`${tag}:enter`, `${tag}:effect`, `${tag}:exit`]);
    }
    // 最终内容与某个串行顺序一致
    const swaps: Record<string, [string, string]> = { A: ['X', 'Y'], B: ['Y', 'X'], C: ['X', 'Z'] };
    const serial = (order: string[]): string => {
      const v: Record<string, string> = { X: 'x', Y: 'y', Z: 'z' };
      for (const t of order) { const [p, q] = swaps[t]; [v[p], v[q]] = [v[q], v[p]]; }
      return v.X + v.Y + v.Z;
    };
    const orders = [['A', 'B', 'C'], ['A', 'C', 'B'], ['B', 'A', 'C'], ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A']];
    expect(orders.map(serial)).toContain(read(X) + read(Y) + read(Z));
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });
});

// ---------- V3：barrier 与权限（fixture 工具） ----------

describe('F04 调度器 V3：未声明工具按 barrier，权限不被调度绕过', () => {
  it('S15 未声明工具与读同批：前面的读先出门，它出门后后面的读才进门', async () => {
    const e = mkEnv('S15');
    const A = e.file('a.txt', 'a'); const B = e.file('b.txt', 'b');
    const g1 = e.gate('g1'); const g2 = e.gate('g2');
    const done = e.run('s15', [
      call('A', 'fx_read', { path: A, gate: 'g1' }), call('U', 'fx_unknown', { gate: 'g2' }), call('B', 'fx_read', { path: B }),
    ]);

    await e.trace.until('A:enter');
    await untilWaiting(e.locks, '/U/');
    await untilWaiting(e.locks, '/B/');
    await settle();
    expect(e.trace.lines).toEqual(['A:enter']);
    g1.open();
    await e.trace.until('U:enter');
    await settle();
    // B 与 U 的资源并不重叠（B 读 shared 下的文件，U 占的是工作区）：只有 barrier 能挡住它
    expect(e.trace.has('B:enter')).toBe(false);
    g2.open();
    const results = await withDeadline(done, 5000, 'S15 批次结束');

    expect(doors(e.trace)).toEqual(['A:enter', 'A:exit', 'U:enter', 'U:exit', 'B:enter', 'B:exit']);
    expect(results.map(r => r.outcome.success)).toEqual([true, true, true]);
  });

  it('S16 未声明工具被拒：没有副作用，锁放开，同批后面的写照常执行', async () => {
    const e = mkEnv('S16');
    e.registry.register(fxUnknown({
      name: 'ask_unknown', trace: e.trace,
      ask: (_input, ctx) => ({ kind: 'shell', detail: 'u', sessionId: ctx.sessionId, toolTitle: 'u' }),
    }));
    const counter = e.file('counter.txt'); const P = e.file('p.txt');
    const deny = new ManualGateway(req => (req.kind === 'shell' ? 'deny' : 'allow'));
    const [u, w] = await withDeadline(e.run('s16', [
      call('U', 'ask_unknown', { counter }), call('W', 'fx_write', { path: P, content: 'w' }),
    ], { permissions: deny }), 5000, 'S16 批次结束');

    expect(deny.requests.map(r => r.kind)).toEqual(['shell']);
    expect(u).toMatchObject({ end: 'completed', started: true, outcome: { success: false } });
    expect(e.trace.has('U:effect')).toBe(false);
    expect(existsSync(counter)).toBe(false);
    expect(w.outcome.success).toBe(true);
    expect(read(P)).toBe('w');
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });

    // 对照：放行时副作用确实发生（计数文件是有效的探针）
    const [u2] = await e.run('s16', [call('U2', 'ask_unknown', { counter })], { permissions: new ManualGateway(() => 'allow') });
    expect(u2.outcome.success).toBe(true);
    expect(read(counter)).toBe('x\n');
  });

  it('S20 声明只读不等于免审：只读工具照样过权限闸，被拒就没有副作用', async () => {
    const e = mkEnv('S20');
    e.registry.register(fxRead({
      name: 'ask_read', trace: e.trace,
      ask: (input, ctx) => ({ kind: 'file-read', detail: String(input.path), sessionId: ctx.sessionId, toolTitle: 'r' }),
    }));
    const P = e.file('secret.txt', 'secret');
    const gw = new ManualGateway(() => 'deny');
    const [r] = await withDeadline(e.run('s20', [call('R', 'ask_read', { path: P })], { permissions: gw }), 5000, 'S20 批次结束');

    expect(gw.requests.map(q => q.kind)).toEqual(['file-read']);
    expect(e.trace.lines).toEqual(['R:enter', 'R:ask', 'R:ret', 'R:exit']);
    expect(r.outcome.success).toBe(false);
    expect(r.outcome.output).not.toContain('secret');
    expect(e.kindsOf('R')).toEqual(['queued', 'started', 'approval-requested', 'approval-returned', 'settled']);
    expect(e.events.find(x => x.kind === 'approval-returned')).toMatchObject({ decision: 'deny', cancelled: false });
  });

  it('S22 资源解析抛错（file_read 给了未知命名空间）：按 barrier 排、不占任何路径锁，错误文案是工具自己的', async () => {
    const e = mkEnv('S22');
    // 真实 file_read 的声明与执行；只在进门时记一笔
    e.registry.register({
      ...fileReadTool,
      async execute(input, ctx) { e.trace.log('X:enter'); return fileReadTool.execute(input, ctx); },
    });
    const A = e.file('a.txt', 'a'); const B = e.file('b.txt', 'b');
    const g1 = e.gate('g1');
    const done = e.run('s22', [
      call('A', 'fx_read', { path: A, gate: 'g1' }), call('X', 'file_read', { path: '/var/minis/nope/x.txt' }), call('B', 'fx_read', { path: B }),
    ]);

    await e.trace.until('A:enter');
    const waiting = await untilWaiting(e.locks, '/X/');
    expect(waiting.claims).toEqual(['session:s22']);
    await settle();
    // 它不碰 A 读的文件，却要等 A 出门；B 又要等它：barrier
    expect(e.trace.lines).toEqual(['A:enter']);
    g1.open();
    const [, x, b] = await withDeadline(done, 5000, 'S22 批次结束');

    expect(x).toMatchObject({ end: 'completed', started: true, outcome: { success: false } });
    expect(x.outcome.output).toContain('未知 minis 命名空间: nope');
    expect(b.outcome).toEqual({ output: 'b', success: true });
    expect(e.trace.at('A:exit')).toBeLessThan(e.trace.at('X:enter'));
    expect(e.trace.at('X:enter')).toBeLessThan(e.trace.at('B:enter'));
    expect(e.events.find(q => q.kind === 'queued' && q.toolUseId === 'X')).toMatchObject({ barrier: true, claims: ['session:s22'] });
  });

  it('S42 声明自相矛盾的工具按 barrier 排：只读却写本地文件、只读却给出写 claim、写本地文件却没有写 claim', async () => {
    // 声明写错了不在启动时抛错，而是当成「说不清会动什么」：信不过的声明不能换来并行
    const variants: { label: string; scheduling: (other: string) => ToolScheduling }[] = [
      {
        label: '只读却声明写本地文件',
        scheduling: other => ({ readOnly: true, concurrencySafe: true, sideEffects: 'local-files', resources: () => [{ kind: 'path', mode: 'read', path: other }] }),
      },
      {
        label: '只读却给出写 claim',
        scheduling: other => ({ readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: () => [{ kind: 'path', mode: 'write', path: other }] }),
      },
      { label: '写本地文件却没有写 claim', scheduling: () => ({ readOnly: false, concurrencySafe: true, sideEffects: 'local-files' }) },
    ];
    for (const [i, v] of variants.entries()) {
      const e = mkEnv(`S42-${i}`);
      const A = e.file('a.txt', 'a'); const B = e.file('b.txt', 'b'); const C = e.file('c.txt', 'c');
      e.registry.register(gatedTool({ name: 'odd', trace: e.trace, gateOf: e.gateOf, scheduling: v.scheduling(C) }));
      const g1 = e.gate('g1'); const g2 = e.gate('g2');
      const done = e.run(`s42-${i}`, [
        call('A', 'fx_read', { path: A, gate: 'g1' }), call('X', 'odd', { gate: 'g2' }), call('B', 'fx_read', { path: B }),
      ]);

      await e.trace.until('A:enter');
      // 它声明的资源（C，或者一条都没有）与 A、B 读的文件都不重叠：只有 barrier 能让它等 A、让 B 等它
      await untilWaiting(e.locks, '/X/');
      await untilWaiting(e.locks, '/B/');
      await settle();
      expect(e.trace.lines, v.label).toEqual(['A:enter']);
      g1.open();
      await e.trace.until('X:enter');
      await settle();
      expect(e.trace.has('B:enter'), v.label).toBe(false);
      g2.open();
      const results = await withDeadline(done, 5000, `S42 批次结束（${v.label}）`);

      expect(doors(e.trace), v.label).toEqual(['A:enter', 'A:exit', 'X:enter', 'X:exit', 'B:enter', 'B:exit']);
      expect(results.map(r => r.outcome.success), v.label).toEqual([true, true, true]);
      expect(e.events.find(q => q.kind === 'queued' && q.toolUseId === 'X'), v.label).toMatchObject({ barrier: true });
    }
  });

  it('S45 同一路径既读又写的声明按写算：别的会话写同一文件要等它出门', async () => {
    const e = mkEnv('S45');
    const P = e.file('p.txt', '0');
    // 资源解析先给读、再给写同一条路径（先读后改的工具照实声明就是这样）：同键去重时取写
    e.registry.register(gatedTool({
      name: 'rw', trace: e.trace, gateOf: e.gateOf,
      scheduling: {
        readOnly: false, concurrencySafe: true, sideEffects: 'local-files',
        resources: () => [{ kind: 'path', mode: 'read', path: P }, { kind: 'path', mode: 'write', path: P }],
      },
      effect: () => { writeFileSync(P, `${read(P)}+A`, 'utf8'); },
    }));
    const g = e.gate('g');
    const doneA = e.run('a', [call('A', 'rw', { gate: 'g' })]);
    await e.trace.until('A:enter');
    const doneB = e.run('b', [call('B', 'fx_write', { path: P, content: 'B' })]);

    // 去重时留下的若是读：跨会话读不等写，B 当场进门，与 A 的「读、改、写」交错
    expect((await untilWaiting(e.locks, '/B/')).foreignBlocked).toBe(true);
    expect(e.trace.has('B:enter')).toBe(false);
    expect(e.events.find(q => q.kind === 'queued' && q.toolUseId === 'A')).toMatchObject({ barrier: false });
    g.open();
    await withDeadline(Promise.all([doneA, doneB]), 5000, 'S45 两个会话结束');

    expect(doors(e.trace)).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
    expect(read(P)).toBe('B');
  });
});

describe('F04 调度器 V3：等锁期间注册表变了（拿到锁后复核）', () => {
  /** [读 A（闸 g1）, N]，N 是未声明工具；返回时 N 已确认在锁表里等着。 */
  async function queuedBehindRead(label: string) {
    const e = mkEnv(label);
    e.registry.register(gatedTool({ name: 'N', trace: e.trace }));
    const A = e.file('a.txt', 'a');
    const g1 = e.gate('g1');
    const sid = label.toLowerCase();
    const done = e.run(sid, [call('A', 'fx_read', { path: A, gate: 'g1' }), call('N', 'N')]);
    await e.trace.until('A:enter');
    await untilWaiting(e.locks, '/N/');
    return { e, g1, done, sid };
  }

  it('S34 等锁期间工具被摘：拿到锁后按未知工具失败，旧执行器不进门，锁照常放开', async () => {
    const { e, g1, done, sid } = await queuedBehindRead('S34');
    e.registry.unregister('N');
    g1.open();
    const [, n] = await withDeadline(done, 5000, 'S34 批次结束');

    expect(n).toMatchObject({ end: 'refused', started: false, outcome: { output: '未知工具: N', success: false } });
    expect(e.trace.has('N:enter')).toBe(false);
    expect(e.kindsOf('N')).toEqual(['queued', 'settled']);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });

    // 同会话再发一批照常执行
    const P = e.file('p.txt');
    const [w] = await withDeadline(e.run(sid, [call('W', 'fx_write', { path: P, content: 'w' })]), 5000, 'S34 第二批');
    expect(w.outcome.success).toBe(true);
    expect(read(P)).toBe('w');
  });

  it('S35(a) 等锁期间同名工具被换、调度条件相同：执行表里当前的对象，不执行已被摘掉的旧对象', async () => {
    const { e, g1, done } = await queuedBehindRead('S35a');
    e.registry.unregister('N');
    e.registry.register(gatedTool({ name: 'N', tagOf: () => 'N2', trace: e.trace }));
    g1.open();
    const [, n] = await withDeadline(done, 5000, 'S35a 批次结束');

    expect(n).toMatchObject({ end: 'completed', started: true, outcome: { success: true } });
    expect(e.trace.has('N:enter')).toBe(false);
    expect(e.trace.at('A:exit')).toBeGreaterThanOrEqual(0);
    expect(e.trace.at('A:exit')).toBeLessThan(e.trace.at('N2:enter'));
  });

  it('S35(b) 等锁期间同名工具被换、调度条件不同：新旧两个都不执行，说明可以重试', async () => {
    const { e, g1, done } = await queuedBehindRead('S35b');
    const other = e.file('other.txt', 'o');
    e.registry.unregister('N');
    // 换上来的是并发安全的只读工具：它要的锁（会话读 + 一条路径读）与排队时拿的（会话写 + 工作区写）不是一组
    e.registry.register(gatedTool({
      name: 'N', tagOf: () => 'N2', trace: e.trace,
      scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: () => [{ kind: 'path', mode: 'read', path: other }] },
    }));
    g1.open();
    const [, n] = await withDeadline(done, 5000, 'S35b 批次结束');

    expect(n).toMatchObject({ end: 'refused', started: false, outcome: { success: false } });
    expect(n.outcome.output).toContain('调度条件已变');
    expect(e.trace.has('N:enter')).toBe(false);
    expect(e.trace.has('N2:enter')).toBe(false);
    expect(e.kindsOf('N')).toEqual(['queued', 'settled']);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('S35(c) 等锁期间同名工具被换、资源相同但读变成写：手里只有读锁，新旧两个都不执行，说明可以重试', async () => {
    const e = mkEnv('S35c');
    const P = e.file('p.txt', '0');
    const onP = (mode: 'read' | 'write') => () => [{ kind: 'path' as const, mode, path: P }];
    // N 起初是读 P 的只读工具，排在写 P 的调用后面等
    e.registry.register(gatedTool({
      name: 'N', trace: e.trace,
      scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: onP('read') },
    }));
    const g1 = e.gate('g1');
    const done = e.run('s35c', [call('W', 'fx_write', { path: P, content: '1', gate: 'g1' }), call('N', 'N')]);
    await e.trace.until('W:enter');
    await untilWaiting(e.locks, '/N/');
    e.registry.unregister('N');
    // 换上来的同名工具要写同一个文件：两份计划的键逐条相同（同一条路径 + 会话读），只有那条路径从读变成了写。
    // 只比键不比读写的话，它会拿着读锁去写——别的会话对 P 的写挡不住它（跨会话只排写-写）
    e.registry.register(gatedTool({
      name: 'N', tagOf: () => 'N2', trace: e.trace,
      scheduling: { readOnly: false, concurrencySafe: true, sideEffects: 'local-files', resources: onP('write') },
      effect: () => { writeFileSync(P, 'N2', 'utf8'); },
    }));
    g1.open();
    const [, n] = await withDeadline(done, 5000, 'S35c 批次结束');

    expect(n).toMatchObject({ end: 'refused', started: false, outcome: { success: false } });
    expect(n.outcome.output).toContain('调度条件已变');
    expect(e.trace.has('N:enter')).toBe(false);
    expect(e.trace.has('N2:enter')).toBe(false);
    expect(e.kindsOf('N')).toEqual(['queued', 'settled']);
    expect(read(P)).toBe('1');
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('S35(d) 等锁期间同名工具被换、这次调用过不了新对象的必填检查：按新对象的预检失败，不退回去执行旧对象', async () => {
    const { e, g1, done } = await queuedBehindRead('S35d');
    e.registry.unregister('N');
    // 换上来的同名工具多了一个必填参数，排队的这次调用没给
    e.registry.register(gatedTool({ name: 'N', tagOf: () => 'N2', trace: e.trace, required: ['need'] }));
    g1.open();
    const [, n] = await withDeadline(done, 5000, 'S35d 批次结束');

    expect(n).toMatchObject({ end: 'refused', started: false, outcome: { output: '缺少必填参数: need', success: false } });
    // 入队时攥着的旧对象已经被摘了：新对象预检不过，也不能拿它顶上
    expect(e.trace.has('N:enter')).toBe(false);
    expect(e.trace.has('N2:enter')).toBe(false);
    expect(e.kindsOf('N')).toEqual(['queued', 'settled']);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });
});

describe('F04 调度器 V2：等锁期间会话工作区被改（拿到锁后按当前状态重新规划）', () => {
  /** 数据根下 `under` 里的两个目录当工作区；会话 → 工作区的绑定表在用例中途可改。
   *  生产里对应 workspace.set / reset：它们不看会话是否在跑，所以排队等锁的调用入队时按旧工作区解析路径（算锁）、
   *  进 execute 时按新工作区解析（动文件）。 */
  function twoWorkspaces(label: string, under: string) {
    const e = mkEnv(label);
    const W1 = join(e.root, under, 'w1'); const W2 = join(e.root, under, 'w2');
    mkdirSync(W1, { recursive: true }); mkdirSync(W2, { recursive: true });
    const bound = new Map<string, string>();
    e.paths.setWorkspaceResolver(sid => bound.get(sid));
    return { e, W1, W2, bound };
  }
  const STALE = '调度条件在等待执行期间已变';

  it('S38 同批排在 barrier 后面的 file_write（相对路径），等锁时工作区从 W1 改到 W2：不拿着 W1 的锁去写 W2，本次不执行；重试按 W2 排队', async () => {
    const { e, W1, W2, bound } = twoWorkspaces('S38', 'ext');
    e.registry.register(fileWriteTool);
    bound.set('a', W1);
    const gu = e.gate('gu'); const gb = e.gate('gb');
    // 会话 b 正在写 W2/x.txt：持有这条路径的写锁，停在副作用之前
    const doneB = e.run('b', [call('B', 'fx_write', { path: join(W2, 'x.txt'), content: 'from-b', gate: 'gb' })]);
    await e.trace.until('B:enter');
    const doneA = e.run('a', [call('U', 'fx_unknown', { gate: 'gu' }), call('W', 'file_write', { path: 'x.txt', content: 'from-a' })]);
    await e.trace.until('U:enter');
    const queued = await untilWaiting(e.locks, '/W/');
    // 入队时按 W1 解析：只被同批前序挡着，与会话 b 无关
    expect(queued.foreignBlocked).toBe(false);
    expect(queued.claims.filter(k => k.startsWith('path:')).map(k => k.split('/').slice(-2).join('/'))).toEqual(['w1/x.txt']);

    bound.set('a', W2);
    gu.open();
    const [u, w] = await withDeadline(doneA, 5000, 'S38 会话 a 批次结束');

    expect(u.outcome.success).toBe(true);
    expect(w).toMatchObject({ end: 'refused', started: false, outcome: { success: false } });
    expect(w.outcome.output).toContain(STALE);
    expect(w.outcome.output).toContain('没有执行');
    expect(w.outcome.output).not.toContain('被重新注册');
    expect(e.kindsOf('W')).toEqual(['queued', 'settled']);
    // 两个目录里都没有它写的东西；会话 b 还在临界区里，它的锁没被绕过
    expect(existsSync(join(W1, 'x.txt'))).toBe(false);
    expect(existsSync(join(W2, 'x.txt'))).toBe(false);
    expect(e.trace.has('B:exit')).toBe(false);
    expect(e.locks.snapshot().held.map(h => h.label)).toEqual(['b/B/fx_write']);
    expect(e.locks.snapshot().waiting).toEqual([]);

    // 重试：这回入队时就按 W2 解析，锁的正是它要写的那条路径——被会话 b 挡住，b 出门后才落盘
    const retry = e.run('a', [call('R', 'file_write', { path: 'x.txt', content: 'from-a' })]);
    expect((await untilWaiting(e.locks, '/R/')).foreignBlocked).toBe(true);
    await settle();
    expect(existsSync(join(W2, 'x.txt'))).toBe(false);
    gb.open();
    const [[b], [again]] = await withDeadline(Promise.all([doneB, retry]), 5000, 'S38 会话 b 出门、重试落盘');
    expect(b.outcome.success).toBe(true);
    expect(again).toMatchObject({ end: 'completed', started: true, outcome: { success: true } });
    expect(read(join(W2, 'x.txt'))).toBe('from-a');
    expect(existsSync(join(W1, 'x.txt'))).toBe(false);
  });

  it('S39 等别的会话放锁时工作区被改：另一会话对新工作区同一文件的权限卡还挂着，这次写不执行、不问权限，卡上的差分仍然属实', async () => {
    // 工作区放在 skills 下：写入要问（data-gate），真实 file_write 的权限卡就是受控延迟
    const { e, W1, W2, bound } = twoWorkspaces('S39', 'skills');
    e.registry.register(fileWriteTool);
    bound.set('sx', W1); bound.set('sy', W2);
    const gh = e.gate('gh');
    const gw = new ManualGateway(q => (q.sessionId === 'sy' ? 'hold' : 'allow'));
    // 会话 sh 占着 W1/a.txt；会话 sy 对 W2/a.txt 的写卡在权限上（锁内审批：它持有 W2/a.txt 的写锁）
    const doneH = e.run('sh', [call('H', 'fx_write', { path: join(W1, 'a.txt'), content: 'from-sh', gate: 'gh' })]);
    await e.trace.until('H:enter');
    const doneY = e.run('sy', [call('Y', 'file_write', { path: 'a.txt', content: 'from-sy' })], { permissions: gw });
    await gw.untilRequests(1);
    expect(gw.held[0].preview?.oldText).toBe('');
    // 会话 sx 的写按 W1 入队，只在等 sh 放锁——同批里没有别的调用
    const doneX = e.run('sx', [call('X', 'file_write', { path: 'a.txt', content: 'from-sx' })], { permissions: gw });
    expect(await untilWaiting(e.locks, '/X/')).toMatchObject({ foreignBlocked: true, blockedBy: 'sh/H/fx_write' });

    bound.set('sx', W2);
    gh.open();
    const [[h], [x]] = await withDeadline(Promise.all([doneH, doneX]), 5000, 'S39 sh 出门、sx 落定');

    expect(h.outcome.success).toBe(true);
    expect(x).toMatchObject({ end: 'refused', started: false, outcome: { success: false } });
    expect(x.outcome.output).toContain(STALE);
    expect(e.kindsOf('X')).toEqual(['queued', 'settled']);
    // 没有为它问过权限；sy 的卡还是唯一挂着的那张，W2/a.txt 仍不存在（卡上「新建文件」的差分没有过期）
    expect(gw.requests.map(q => q.sessionId)).toEqual(['sy']);
    expect(gw.held.map(q => q.sessionId)).toEqual(['sy']);
    expect(existsSync(join(W2, 'a.txt'))).toBe(false);
    expect(read(join(W1, 'a.txt'))).toBe('from-sh');
    expect(e.locks.snapshot().held.map(l => l.label)).toEqual(['sy/Y/file_write']);

    gw.allow();
    const [y] = await withDeadline(doneY, 5000, 'S39 sy 批准后落盘');
    expect(y.outcome.success).toBe(true);
    expect(read(join(W2, 'a.txt'))).toBe('from-sy');
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('S40 shell 排队期间工作区被改（常驻 shell 还没建）：不起进程、不问权限；重试时在新工作区出生，锁也在新工作区上', async () => {
    const { e, W1, W2, bound } = twoWorkspaces('S40', 'ext');
    const sh = fakeShellSpawn();
    e.registry.register(makeShellTool(new ShellManager({ spawnImpl: sh.spawnImpl })));
    bound.set('a', W1);
    const gu = e.gate('gu');
    const gw = new ManualGateway(() => 'allow');
    const done = e.run('a', [call('U', 'fx_unknown', { gate: 'gu' }), call('S', 'shell_execute', { command: 'one' })], { permissions: gw });
    await e.trace.until('U:enter');
    await untilWaiting(e.locks, '/S/');

    bound.set('a', W2);
    gu.open();
    await e.trace.until('U:exit');
    await settle();
    // 进了工具就会问 kind:'shell' 的权限、在 W2 里起驱动（锁却在 W1 上）
    expect(gw.requests.filter(q => q.kind === 'shell')).toHaveLength(0);
    expect(sh.spawns).toHaveLength(0);
    const [, s] = await withDeadline(done, 5000, 'S40 批次结束');

    expect(s).toMatchObject({ end: 'refused', started: false, outcome: { success: false } });
    expect(s.outcome.output).toContain(STALE);
    expect(e.kindsOf('S')).toEqual(['queued', 'settled']);
    expect(sh.spawns).toHaveLength(0);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });

    // 重试：shell 在 W2 里出生；别的会话往 W2 里写要等这条命令
    const retry = e.run('a', [call('S2', 'shell_execute', { command: 'two' })], { permissions: gw });
    await sh.untilCommands(1);
    expect(sh.spawns.map(p => p.cwd)).toEqual([W2]);
    const doneC = e.run('c', [call('C', 'fx_write', { path: join(W2, 'y.txt'), content: 'c' })]);
    expect((await untilWaiting(e.locks, '/C/')).foreignBlocked).toBe(true);
    sh.commands[0].reply('2');
    const [[again]] = await withDeadline(Promise.all([retry, doneC]), 5000, 'S40 重试与会话 c 结束');
    expect(again.outcome.success).toBe(true);
    expect(read(join(W2, 'y.txt'))).toBe('c');
  });

  it('S41 重新规划不误拒：状态没变的调用照常执行——同批两条 shell（第一条建出常驻 shell）、同批「写新目录下的文件→读它」', async () => {
    const { e, W1, bound } = twoWorkspaces('S41', 'ext');
    const sh = fakeShellSpawn();
    e.registry.register(makeShellTool(new ShellManager({ spawnImpl: sh.spawnImpl })));
    e.registry.register(fileWriteTool);
    e.registry.register(fileReadTool);
    bound.set('a', W1);

    // 第二条 shell 入队时常驻 shell 还没建（只有工作区一条 claim），拿到锁时已建（多一条出生目录，与工作区同键、去重后不变）
    const shells = e.run('a', [call('S1', 'shell_execute', { command: 'one' }), call('S2', 'shell_execute', { command: 'two' })]);
    await sh.untilCommands(1);
    sh.commands[0].reply('1');
    await sh.untilCommands(2);
    sh.commands[1].reply('2');
    const [s1, s2] = await withDeadline(shells, 5000, 'S41 两条 shell');
    expect([s1, s2].map(r => [r.end, r.started, r.outcome.success])).toEqual([['completed', true, true], ['completed', true, true]]);
    expect(sh.spawns.map(p => p.cwd)).toEqual([W1]);

    // 读入队时 sub/deep 还不存在（键由「最近存在的祖先 + 尾段」拼出），拿到锁时已被前一个写建出来：键不变
    const [w, r] = await withDeadline(e.run('a', [
      call('W', 'file_write', { path: 'sub/deep/n.txt', content: 'new' }), call('R', 'file_read', { path: 'sub/deep/n.txt' }),
    ]), 5000, 'S41 写新目录下的文件再读');
    expect(w.outcome.success).toBe(true);
    expect(r).toMatchObject({ end: 'completed', started: true, outcome: { output: 'new', success: true } });
    expect(read(join(W1, 'sub', 'deep', 'n.txt'))).toBe('new');
  });
});

describe('S21 wrapPermissions：只转发，取消时交回 deny，从不自己放行', () => {
  const req: PermissionRequest = { kind: 'file-write', detail: 'x', sessionId: 's', toolTitle: 't' };
  function observed() {
    const log: string[] = [];
    return {
      log,
      hooks: {
        requested: (): void => { log.push('requested'); },
        returned: (d: PermissionDecision, cancelled: boolean): void => { log.push(`returned:${d}:${cancelled}`); },
      },
    };
  }

  it('内层 deny → deny；内层 allow → allow（都不算因取消交回）', async () => {
    for (const decision of ['deny', 'allow'] as const) {
      const ctl = new AbortController();
      const o = observed();
      const wrapped = wrapPermissions(new ManualGateway(() => decision), cancelSourceOf(ctl.signal), o.hooks);
      expect(await wrapped.check(req)).toBe(decision);
      expect(o.log).toEqual(['requested', `returned:${decision}:false`]);
    }
  });

  it('内层挂起时取消：立即交回 deny，cancelled=true；晚到的 allow 没有消费者', async () => {
    const ctl = new AbortController();
    const inner = new ManualGateway(() => 'hold');
    const o = observed();
    const pending = wrapPermissions(inner, cancelSourceOf(ctl.signal), o.hooks).check(req);
    await inner.untilRequests(1);
    ctl.abort();
    expect(await withDeadline(pending, 2000, '取消后交回')).toBe('deny');
    expect(o.log).toEqual(['requested', 'returned:deny:true']);
    inner.allow();
    await settle();
    expect(o.log).toEqual(['requested', 'returned:deny:true']);
  });

  it('内层兑现 allow 与取消写在同一段同步代码里（先兑现、后 abort）：仍按取消交回 deny', async () => {
    const ctl = new AbortController();
    const inner = new ManualGateway(() => 'hold');
    const o = observed();
    const pending = wrapPermissions(inner, cancelSourceOf(ctl.signal), o.hooks).check(req);
    await inner.untilRequests(1);
    inner.allow(); ctl.abort();
    expect(await withDeadline(pending, 2000, '同一拍交回')).toBe('deny');
    expect(o.log).toEqual(['requested', 'returned:deny:true']);
  });

  it('已取消时不调内层，直接交回 deny', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const inner = new ManualGateway(() => 'allow');
    const o = observed();
    expect(await wrapPermissions(inner, cancelSourceOf(ctl.signal), o.hooks).check(req)).toBe('deny');
    expect(inner.requests).toHaveLength(0);
    expect(o.log).toEqual(['returned:deny:true']);
  });

  it('未取消时内层拒绝原样抛出；取消后内层晚到的拒绝不变成未处理的拒绝', async () => {
    const boom = new Error('网关故障');
    const failing: PermissionGateway = { check: () => Promise.reject(boom), hasBridgeGrant: () => false };
    await expect(wrapPermissions(failing, cancelSourceOf(new AbortController().signal)).check(req)).rejects.toBe(boom);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const ctl = new AbortController();
      let fail!: (e: Error) => void;
      const late: PermissionGateway = {
        check: () => new Promise<PermissionDecision>((_resolve, reject) => { fail = reject; }),
        hasBridgeGrant: () => false,
      };
      const pending = wrapPermissions(late, cancelSourceOf(ctl.signal)).check(req);
      ctl.abort();
      expect(await withDeadline(pending, 2000, '取消后交回')).toBe('deny');
      fail(new Error('晚到的拒绝'));
      await settle(5);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('没有取消源时原样转发；hasBridgeGrant 原样转发；观察回调抛错不影响决议', async () => {
    const inner: PermissionGateway = { check: async () => 'allow', hasBridgeGrant: sid => sid === 'granted' };
    const wrapped = wrapPermissions(inner, undefined, {
      requested: () => { throw new Error('观察者故障'); },
      returned: () => { throw new Error('观察者故障'); },
    });
    expect(await wrapped.check(req)).toBe('allow');
    expect(wrapped.hasBridgeGrant('granted')).toBe(true);
    expect(wrapped.hasBridgeGrant('other')).toBe(false);
  });
});

// ---------- V4：取消、超时、失败放锁 ----------

/** fixture 写工具过权限闸时发的请求：detail 取调用的 tag，网关按它决定挂起谁。 */
const askWrite = (input: Record<string, unknown>, ctx: ToolContext): PermissionRequest =>
  ({ kind: 'file-write', detail: String(input.tag), sessionId: ctx.sessionId, toolTitle: 't' });

describe('F04 调度器 V4：等锁、等审批、执行中分别取消', () => {
  it('S23 等锁时取消（同批）：排队的调用不执行、不问权限，结果是 [已取消]', async () => {
    const e = mkEnv('S23');
    e.registry.register(fxWrite({ name: 'ask_write', trace: e.trace, gateOf: e.gateOf, ask: askWrite }));
    // 持锁的那个不理会取消：闸不开它就不出门、锁就不放。排队的调用只能靠「等锁时认取消」自己出队——
    // 持有者认取消的话，它一放锁、排队的拿到锁再被启动前的复查拦下，结果一样，分不出等锁时到底认不认取消
    e.registry.register(fxWrite({ name: 'deaf_write', trace: e.trace, gateOf: e.gateOf, ask: askWrite, honorAbort: false }));
    const P = e.file('p.txt', '0');
    const g = e.gate('g');
    const gw = new ManualGateway(() => 'allow');
    const ctl = new AbortController();
    const done = e.run('s23', [
      call('1', 'deaf_write', { path: P, content: '1', gate: 'g' }), call('2', 'ask_write', { path: P, content: '2' }),
    ], { permissions: gw, signal: ctl.signal });
    await e.trace.until('1:ret');
    await untilWaiting(e.locks, '/2/');
    ctl.abort();
    await settle();

    // 持有者还在里面（闸没开）：排队的那个已经出队并落定，没有等它放锁
    expect(g.isOpen).toBe(false);
    expect(e.locks.snapshot().held.map(h => h.label)).toEqual(['s23/1/deaf_write']);
    expect(e.locks.snapshot().waiting).toEqual([]);
    expect(e.kindsOf('2')).toEqual(['queued', 'settled']);
    expect(e.events.find(x => x.toolUseId === '2' && x.kind === 'settled')).toMatchObject({ end: 'cancelled-before-start', started: false });
    g.open();
    const [r1, r2] = await withDeadline(done, 5000, 'S23 批次结束');

    expect(r2).toMatchObject({ end: 'cancelled-before-start', started: false, outcome: { output: '[已取消]', success: false } });
    expect(r1).toMatchObject({ end: 'completed', started: true });
    expect(e.trace.has('2:enter')).toBe(false);
    // 不理会取消的那个照旧写完了自己的内容；排队的 '2' 没有写、没有问权限
    expect(read(P)).toBe('1');
    expect(gw.requests.map(q => q.detail)).toEqual(['1']);
    expect(e.kindsOf('2')).toEqual(['queued', 'settled']);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  /** 会话 a 的写占着 X 不放；会话 b 要 {X, Y} 在等；会话 c 只要 Y——与持有者 a 不冲突，只被等待中的 b 按先后挡住。 */
  async function fifoBlockedByWaiter(label: string, opts: ToolSchedulerOptions, signalB?: AbortSignal) {
    const e = mkEnv(label, opts);
    const X = e.file('x.txt', 'x0'); const Y = e.file('y.txt', 'y0');
    const g = e.gate('g');
    const doneA = e.run('a', [call('A', 'fx_write', { path: X, content: 'xa', gate: 'g' })]);
    await e.trace.until('A:enter');
    const doneB = e.run('b', [call('B', 'fx_swap', { a: X, b: Y })], { signal: signalB });
    await untilWaiting(e.locks, '/B/');
    const doneC = e.run('c', [call('C', 'fx_write', { path: Y, content: 'yc' })]);
    const waitingC = await untilWaiting(e.locks, '/C/');
    expect(waitingC).toMatchObject({ foreignBlocked: true, blockedBy: 'b/B/fx_swap' });
    return { e, X, Y, g, doneA, doneB, doneC };
  }

  it('S24a 等锁取消后队列继续推进：只被它按先后挡住的别的会话调用当场执行，不用等持有者放锁', async () => {
    const ctlB = new AbortController();
    const { e, X, Y, g, doneA, doneB, doneC } = await fifoBlockedByWaiter('S24a', {}, ctlB.signal);
    ctlB.abort();
    const [b] = await withDeadline(doneB, 2000, 'S24a 会话 b 取消后返回');
    expect(b).toMatchObject({ end: 'cancelled-before-start', started: false, outcome: { output: '[已取消]', success: false } });
    const [c] = await withDeadline(doneC, 2000, 'S24a 持有者没放锁时会话 c 完成');

    // a 的闸还没开
    expect(g.isOpen).toBe(false);
    expect(e.trace.has('A:exit')).toBe(false);
    expect(c).toMatchObject({ end: 'completed', started: true, outcome: { success: true } });
    expect(read(Y)).toBe('yc');
    expect(e.trace.has('B:enter')).toBe(false);
    g.open();
    await withDeadline(doneA, 2000, 'S24a 收尾');
    expect(read(X)).toBe('xa');
  });

  it('S24b 等锁超时后队列继续推进：排在它后面的调用在它超时出队时执行，不跟着超时', async () => {
    const { e, X, Y, g, doneA, doneB, doneC } = await fifoBlockedByWaiter('S24b', { lockWaitTimeoutMs: 100 });
    const [b] = await withDeadline(doneB, 5000, 'S24b 会话 b 等锁超时返回');
    expect(b).toMatchObject({ end: 'lock-timeout', started: false, outcome: { success: false } });
    const [c] = await withDeadline(doneC, 2000, 'S24b 持有者没放锁时会话 c 完成');

    expect(g.isOpen).toBe(false);
    expect(e.trace.has('A:exit')).toBe(false);
    expect(c).toMatchObject({ end: 'completed', started: true, outcome: { success: true } });
    expect(read(Y)).toBe('yc');
    expect(e.trace.has('B:enter')).toBe(false);
    g.open();
    await withDeadline(doneA, 2000, 'S24b 收尾');
    expect(read(X)).toBe('xa');
  });

  it('S25 等审批时取消：立即交回 [已取消]、没有副作用、锁放开；晚到的 allow 不执行任何东西', async () => {
    const e = mkEnv('S25');
    e.registry.register(fxWrite({ name: 'ask_write', trace: e.trace, ask: askWrite }));
    const P = e.file('p.txt', '0');
    const gw = new ManualGateway(q => (q.detail === 'W1' ? 'hold' : 'allow'));
    const ctl = new AbortController();
    const done1 = e.run('a', [call('W1', 'ask_write', { path: P, content: '1' })], { permissions: gw, signal: ctl.signal });
    await gw.untilRequests(1);
    await e.trace.until('W1:ask');
    ctl.abort();
    const [r1] = await withDeadline(done1, 2000, 'S25 审批等待中取消后返回');

    expect(r1).toMatchObject({ end: 'completed', started: true, outcome: { output: '[已取消]', success: false } });
    expect(e.trace.has('W1:effect')).toBe(false);
    expect(e.events.find(x => x.kind === 'approval-returned')).toMatchObject({ decision: 'deny', cancelled: true });
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });

    // 别的会话写同一路径：立即执行
    const [r2] = await withDeadline(e.run('b', [call('W2', 'ask_write', { path: P, content: '2' })], { permissions: gw }), 2000, 'S25 别的会话');
    expect(r2.outcome.success).toBe(true);
    expect(read(P)).toBe('2');

    // 旧请求还挂在网关里（包装层不了结卡片）；这时再放行，没有消费者
    expect(gw.held.map(q => q.detail)).toEqual(['W1']);
    gw.allow();
    await settle();
    expect(read(P)).toBe('2');
    expect(e.trace.has('W1:effect')).toBe(false);
  });

  it('S27 执行中取消（认取消的工具）：结果 [已取消]，锁放开，别的会话的等待者随后执行', async () => {
    const e = mkEnv('S27');
    const P = e.file('p.txt', '0');
    const g = e.gate('g');
    const ctl = new AbortController();
    const doneA = e.run('a', [call('A', 'fx_write', { path: P, content: 'A', gate: 'g' })], { signal: ctl.signal });
    await e.trace.until('A:enter');
    const doneB = e.run('b', [call('B', 'fx_write', { path: P, content: 'B' })]);
    await untilWaiting(e.locks, '/B/');
    ctl.abort();
    const [a] = await withDeadline(doneA, 2000, 'S27 会话 a 取消后返回');
    const [b] = await withDeadline(doneB, 2000, 'S27 会话 b 执行');

    expect(a).toMatchObject({ end: 'completed', started: true, outcome: { output: '[已取消]', success: false } });
    expect(e.trace.has('A:effect')).toBe(false);
    expect(g.isOpen).toBe(false);
    expect(b.outcome.success).toBe(true);
    expect(read(P)).toBe('B');
    expect(doors(e.trace)).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
  });

  it('S28 执行中取消（不理会取消的工具）：工具真正出门之前不放锁，等待者不进门', async () => {
    const e = mkEnv('S28');
    e.registry.register(fxWrite({ name: 'deaf_write', trace: e.trace, gateOf: e.gateOf, honorAbort: false }));
    const P = e.file('p.txt', '0');
    const g = e.gate('g');
    const ctl = new AbortController();
    const doneA = e.run('a', [call('A', 'deaf_write', { path: P, content: 'A', gate: 'g' })], { signal: ctl.signal });
    await e.trace.until('A:enter');
    const doneB = e.run('b', [call('B', 'fx_write', { path: P, content: 'B' })]);
    await untilWaiting(e.locks, '/B/');
    ctl.abort();
    await settle();

    // 工具还在里面：锁不能放
    expect(e.locks.snapshot().waiting.map(w => w.label)).toEqual(['b/B/fx_write']);
    expect(e.locks.snapshot().held.map(h => h.label)).toEqual(['a/A/deaf_write']);
    expect(e.trace.has('B:enter')).toBe(false);
    g.open();
    const [[a], [b]] = await withDeadline(Promise.all([doneA, doneB]), 2000, 'S28 两个会话结束');

    expect(a).toMatchObject({ end: 'completed', started: true });
    expect(b.outcome.success).toBe(true);
    expect(doors(e.trace)).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
    expect(read(P)).toBe('B');
  });

  it('S29 拿到锁的同一刻已取消：不启动工具，锁已放', async () => {
    const e = mkEnv('S29');
    // 不理会取消的工具：只有调度器「授予后、启动前」的复查能拦住它
    e.registry.register(fxWrite({ name: 'deaf_write', trace: e.trace, honorAbort: false }));
    const P = e.file('p.txt', '0');
    const ctl = new AbortController();
    const done = e.run('s29', [call('W', 'deaf_write', { path: P, content: 'W' })], { signal: ctl.signal });
    // 入队与授予是同步的：此刻锁已拿到，续体还没跑
    expect(e.locks.snapshot().held.map(h => h.label)).toEqual(['s29/W/deaf_write']);
    ctl.abort();
    const [w] = await withDeadline(done, 2000, 'S29 批次结束');

    expect(w).toMatchObject({ end: 'cancelled-before-start', started: false, outcome: { output: '[已取消]', success: false } });
    expect(e.trace.lines).toEqual([]);
    expect(read(P)).toBe('0');
    expect(e.kindsOf('W')).toEqual(['queued', 'settled']);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });

    const [again] = await withDeadline(e.run('s29', [call('W2', 'deaf_write', { path: P, content: 'W2' })]), 2000, 'S29 再发');
    expect(again.outcome.success).toBe(true);
    expect(read(P)).toBe('W2');
  });

  it('S30 批次开始前已取消：一个工具都不进（进门不查取消的也一样），每个调用都有 [已取消] 结果', async () => {
    const e = mkEnv('S30');
    e.registry.register(fxWrite({ name: 'deaf_write', trace: e.trace, honorAbort: false }));
    const P = e.file('p.txt', '0');
    const ctl = new AbortController();
    ctl.abort();
    const results = await withDeadline(e.run('s30', [
      call('R', 'fx_read', { path: P }), call('W', 'deaf_write', { path: P, content: 'W' }), call('U', 'fx_unknown'),
    ], { signal: ctl.signal }), 2000, 'S30 批次结束');

    expect(results.map(r => [r.end, r.started, r.outcome.output, r.outcome.success]))
      .toEqual(Array(3).fill(['cancelled-before-start', false, '[已取消]', false]));
    expect(e.trace.lines).toEqual([]);
    expect(read(P)).toBe('0');
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });
});

describe('F04 调度器 V4：失败与超时之后锁表照常工作', () => {
  it('S31 失败放锁：工具抛错、返回失败、资源解析抛错、观察回调抛错，后面的等待者都能执行', async () => {
    const e = mkEnv('S31');
    e.registry.register(fxWrite({ name: 'throwing', trace: e.trace, fail: 'throw' }));
    e.registry.register(fxWrite({ name: 'failing', trace: e.trace, fail: 'outcome' }));
    e.registry.register(gatedTool({
      name: 'bad_plan', trace: e.trace, fail: 'outcome',
      scheduling: { readOnly: false, concurrencySafe: true, sideEffects: 'local-files', resources: () => { throw new Error('解析不出'); } },
    }));
    for (const [i, name] of ['throwing', 'failing', 'bad_plan'].entries()) {
      const P = e.file(`p${i}.txt`, '0');
      const [bad, after] = await withDeadline(e.run('s31', [
        call(`F${i}`, name, { path: P, content: 'bad' }), call(`W${i}`, 'fx_write', { path: P, content: 'after' }),
      ]), 2000, `S31 ${name}`);
      expect(bad, name).toMatchObject({ end: 'completed', started: true, outcome: { success: false } });
      expect(after.outcome.success, name).toBe(true);
      expect(read(P), name).toBe('after');
      expect(e.trace.at(`F${i}:exit`), name).toBeLessThan(e.trace.at(`W${i}:enter`));
      expect(e.locks.snapshot(), name).toEqual({ held: [], waiting: [] });
    }
    expect(e.events.find(x => x.toolUseId === 'F0' && x.kind === 'settled')).toMatchObject({ success: false });

    // 观察回调每次都抛：执行与放锁不受影响
    const P = e.file('p-ev.txt', '0');
    const results = await withDeadline(e.scheduler.runBatch({
      calls: [call('E1', 'fx_write', { path: P, content: '1' }), call('E2', 'fx_write', { path: P, content: '2' })],
      registry: e.registry, ctx: e.ctx('s31'),
      onEvent: () => { throw new Error('观察者故障'); },
    }), 2000, 'S31 观察回调抛错');
    expect(results.map(r => r.outcome.success)).toEqual([true, true]);
    expect(read(P)).toBe('2');
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('S32 等别的会话超过上限：给出超时文案、没有执行；对方放开后重发成功', async () => {
    const e = mkEnv('S32', { lockWaitTimeoutMs: 50 });
    const P = e.file('p.txt', '0');
    const g = e.gate('g');
    const doneA = e.run('a', [call('A', 'fx_write', { path: P, content: 'A', gate: 'g' })]);
    await e.trace.until('A:enter');
    const [b] = await withDeadline(e.run('b', [call('B', 'fx_write', { path: P, content: 'B' })]), 5000, 'S32 会话 b 等锁超时返回');

    expect(b).toMatchObject({ end: 'lock-timeout', started: false, outcome: { success: false } });
    expect(b.outcome.output).toContain('等待资源超时');
    expect(b.outcome.output).toContain('没有执行');
    // 只带它自己给的路径，不带对方会话的标识
    expect(b.outcome.output).toContain(P);
    expect(b.outcome.output).not.toContain('a/A');
    expect(e.trace.has('B:enter')).toBe(false);
    expect(e.kindsOf('B')).toEqual(['queued', 'settled']);
    expect(read(P)).toBe('0');

    g.open();
    await withDeadline(doneA, 2000, 'S32 会话 a 结束');
    const [again] = await withDeadline(e.run('b', [call('B2', 'fx_write', { path: P, content: 'B' })]), 2000, 'S32 重发');
    expect(again.outcome.success).toBe(true);
    expect(read(P)).toBe('B');
  });

  it('S33 前序等别的会话超时不连累同批后续：后面的未声明工具照常执行', async () => {
    const e = mkEnv('S33', { lockWaitTimeoutMs: 60 });
    // X 在会话 b 的工作区之外：未声明工具的工作区写锁盖不到它，不会自己也被会话 a 挡住
    const X = e.file('x.txt', 'x0');
    const counter = e.file('counter.txt');
    const g = e.gate('g');
    const doneA = e.run('a', [call('A', 'fx_write', { path: X, content: 'A', gate: 'g' })]);
    await e.trace.until('A:enter');
    const [w, u] = await withDeadline(e.run('b', [
      call('W', 'fx_write', { path: X, content: 'B' }), call('U', 'fx_unknown', { counter }),
    ]), 5000, 'S33 会话 b 批次结束');

    expect(w).toMatchObject({ end: 'lock-timeout', started: false });
    expect(u).toMatchObject({ end: 'completed', started: true, outcome: { success: true } });
    expect(read(counter)).toBe('x\n');
    // U 进门时 a 的闸还没开
    expect(g.isOpen).toBe(false);
    expect(e.trace.has('A:exit')).toBe(false);
    expect(e.trace.has('W:enter')).toBe(false);
    g.open();
    await withDeadline(doneA, 2000, 'S33 收尾');
    expect(read(X)).toBe('A');
  });
});

describe('F04 调度器：落定事件、批次收尾与构造参数（后续任务依赖的契约）', () => {
  it('S43 settled 在放锁之前发出：回调里看锁表，这个调用还持有它的锁，排在它后面的还在等', async () => {
    const e = mkEnv('S43');
    const P = e.file('p.txt', '0');
    const seen: { id: string; held: string[]; waiting: string[] }[] = [];
    const results = await withDeadline(e.scheduler.runBatch({
      calls: [call('W', 'fx_write', { path: P, content: '1' }), call('R', 'fx_read', { path: P })],
      registry: e.registry, ctx: e.ctx('s43'),
      onEvent: ev => {
        if (ev.kind !== 'settled') return;
        const snap = e.locks.snapshot();
        seen.push({ id: ev.toolUseId, held: snap.held.map(h => h.label), waiting: snap.waiting.map(w => w.label) });
      },
    }), 5000, 'S43 批次结束');

    expect(results.map(r => r.outcome)).toEqual([{ output: 'W ok', success: true }, { output: '1', success: true }]);
    // 执行账本（F05）在这个回调里提交：此刻写还没放锁，排在它后面的读还没被放行。
    // 只看事件先后分不出来——先放锁再发事件时，读的续体要到下一个微任务才跑，settled(W) 照样排在 started(R) 前面
    expect(seen).toEqual([
      { id: 'W', held: ['s43/W/fx_write'], waiting: ['s43/R/fx_read'] },
      { id: 'R', held: ['s43/R/fx_read'], waiting: [] },
    ]);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('S44 批次结束后不在取消信号上留监听：同一个 signal 连跑多批，监听数回到 0', async () => {
    const e = mkEnv('S44');
    const P = e.file('p.txt', '0');
    const controller = new AbortController();
    for (let i = 0; i < 12; i++) {
      const [w] = await withDeadline(
        e.run('s44', [call(`W${i}`, 'fx_write', { path: P, content: String(i) })], { signal: controller.signal }), 5000, `S44 第 ${i} 批`);
      expect(w.outcome.success).toBe(true);
    }
    // 一个 run 的 signal 要撑过很多批（每个回合一批）：每批留一个监听，十来个回合后 Node 就报 MaxListenersExceededWarning
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(read(P)).toBe('11');
  });

  it('S46(a) 构造参数 locks：传进来的锁表就是它用的那一张——两个调度器共用它，写同一文件照样排队', async () => {
    const e = mkEnv('S46a');
    const locks = new ResourceLockManager();
    const one = new ToolScheduler({ locks }); const two = new ToolScheduler({ locks });
    expect(one.locks).toBe(locks);
    const P = e.file('p.txt', '0');
    const g = e.gate('g');
    const doneA = one.runBatch({ calls: [call('A', 'fx_write', { path: P, content: 'A', gate: 'g' })], registry: e.registry, ctx: e.ctx('a') });
    await e.trace.until('A:enter');
    const doneB = two.runBatch({ calls: [call('B', 'fx_write', { path: P, content: 'B' })], registry: e.registry, ctx: e.ctx('b') });

    expect((await untilWaiting(locks, '/B/')).foreignBlocked).toBe(true);
    expect(e.trace.has('B:enter')).toBe(false);
    g.open();
    await withDeadline(Promise.all([doneA, doneB]), 5000, 'S46a 两批结束');
    expect(doors(e.trace)).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
    expect(read(P)).toBe('B');
  });

  it('S46(b) 构造参数 maxConcurrentPerSession：上限 2 时三个互不重叠的读只有两个同时在场', async () => {
    const e = mkEnv('S46b', { maxConcurrentPerSession: 2 });
    const rv = new Rendezvous(2);
    e.registry.register(fxRead({ name: 'rv_read', trace: e.trace, rendezvous: rv, gateOf: e.gateOf }));
    const g = e.gate('g');
    const done = e.run('s46b', [0, 1, 2].map(i => call(`R${i}`, 'rv_read', { path: e.file(`r${i}.txt`, `c${i}`), gate: 'g' })));

    await e.trace.until('R1:enter');
    await untilWaiting(e.locks, '/R2/');
    await settle();
    expect(e.trace.has('R2:enter')).toBe(false);
    g.open();
    const results = await withDeadline(done, 5000, 'S46b 批次结束');
    expect(results.map(r => r.outcome.output)).toEqual(['c0', 'c1', 'c2']);
    expect(rv.maxActive).toBe(2);
  });

  it('S46(c) 构造参数 path：注入的 realpath 用在规划上——解析到同一处的两条路径是同一把锁', async () => {
    // 假 realpath 把路径里的 alias 段当成指向 real 的链接。真实链接的用例是 S11；这里守的是参数确实交到了规划上
    const e = mkEnv('S46c', { path: { realpath: p => p.replace(/([\\/])alias(?=[\\/]|$)/, '$1real') } });
    const viaAlias = e.file(join('alias', 'p.txt')); const viaReal = e.file(join('real', 'p.txt'));
    const g = e.gate('g');
    const doneA = e.run('a', [call('A', 'fx_write', { path: viaAlias, content: 'A', gate: 'g' })]);
    await e.trace.until('A:enter');
    const doneB = e.run('b', [call('B', 'fx_write', { path: viaReal, content: 'B' })]);

    expect((await untilWaiting(e.locks, '/B/')).foreignBlocked).toBe(true);
    expect(e.trace.has('B:enter')).toBe(false);
    g.open();
    await withDeadline(Promise.all([doneA, doneB]), 5000, 'S46c 两个会话结束');
    expect(doors(e.trace)).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
  });
});

// ---------- 真实工具：file_write、shell_execute、MCP ----------

// 假 PowerShell 驱动（fakeShellSpawn）与假 MCP client（mcpOn）在 scheduler-fixture.ts：ShellManager、McpManager、工具本身都是真的。

describe('F04 调度器 V3：真实 file_write / shell_execute', () => {
  it('S19 真实 file_write 被拒：没有落盘，结果是「被用户拒绝」；随后同路径的写立即拿到锁', async () => {
    const e = mkEnv('S19');
    e.registry.register(fileWriteTool);
    const guest = '/var/minis/skills/x/SKILL.md';
    const abs = join(e.root, 'skills', 'x', 'SKILL.md');
    const deny = new ManualGateway(() => 'deny');
    const [r] = await withDeadline(
      e.run('s19', [call('W', 'file_write', { path: guest, content: '不该落盘' })], { permissions: deny }), 5000, 'S19 被拒的写');

    expect(deny.requests.map(q => q.kind)).toEqual(['file-write']);
    expect(r.outcome.success).toBe(false);
    expect(r.outcome.output).toContain('被用户拒绝');
    expect(existsSync(abs)).toBe(false);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });

    const [again] = await withDeadline(
      e.run('other', [call('W2', 'file_write', { path: guest, content: '放行的内容' })], { permissions: new ManualGateway(() => 'allow') }),
      2000, 'S19 随后的写');
    expect(again.outcome.success).toBe(true);
    expect(read(abs)).toBe('放行的内容');
  });

  it('S26 真实 file_write 等审批时取消：立即 [已取消]、没有落盘、锁放开；晚到的 allow 不落盘', async () => {
    const e = mkEnv('S26');
    e.registry.register(fileWriteTool);
    const guest = '/var/minis/skills/f04/s26.txt';
    const abs = join(e.root, 'skills', 'f04', 's26.txt');
    const gw = new ManualGateway(q => (q.sessionId === 'a' ? 'hold' : 'allow'));
    const ctl = new AbortController();
    const done1 = e.run('a', [call('W1', 'file_write', { path: guest, content: '1' })], { permissions: gw, signal: ctl.signal });
    await gw.untilRequests(1);
    ctl.abort();
    const [r1] = await withDeadline(done1, 2000, 'S26 审批等待中取消后返回');

    expect(r1).toMatchObject({ end: 'completed', started: true, outcome: { output: '[已取消]', success: false } });
    expect(existsSync(abs)).toBe(false);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });

    const [r2] = await withDeadline(
      e.run('b', [call('W2', 'file_write', { path: guest, content: '2' })], { permissions: gw }), 2000, 'S26 别的会话');
    expect(r2.outcome.success).toBe(true);
    expect(read(abs)).toBe('2');

    expect(gw.held.map(q => q.sessionId)).toEqual(['a']);
    gw.allow();
    await settle();
    expect(read(abs)).toBe('2');
  });

  it('S18 真实 shell_execute 与文件工具同批：写结束前 shell 不问权限、不起进程；shell 结束前后面的读不开始；入参自称只读不改变这些', async () => {
    const e = mkEnv('S18');
    const sh = fakeShellSpawn();
    e.registry.register(makeShellTool(new ShellManager({ spawnImpl: sh.spawnImpl })));
    e.registry.register(fileWriteTool);
    e.registry.register({
      ...fileReadTool,
      async execute(input, ctx) { e.trace.log('R:enter'); return fileReadTool.execute(input, ctx); },
    });
    const ws = e.ctx('s18').paths.workspaceOf('s18');
    writeFileSync(join(ws, 'other.txt'), '别的文件', 'utf8');
    const written = join(e.root, 'skills', 'f04', 's18.txt');
    const gw = new ManualGateway(q => (q.kind === 'file-write' ? 'hold' : 'allow'));
    const done = e.run('s18', [
      call('W', 'file_write', { path: '/var/minis/skills/f04/s18.txt', content: 'w' }),
      call('SH', 'shell_execute', { command: 'echo hi', readOnly: true, concurrencySafe: true }),
      call('R', 'file_read', { path: 'other.txt' }),
    ], { permissions: gw });

    await gw.untilRequests(1);
    await untilWaiting(e.locks, '/SH/');
    await untilWaiting(e.locks, '/R/');
    await settle();
    // 写的卡还挂着
    expect(gw.requests.map(q => q.kind)).toEqual(['file-write']);
    expect(sh.spawns).toHaveLength(0);
    expect(sh.commands).toHaveLength(0);
    expect(e.trace.has('R:enter')).toBe(false);

    gw.allow();
    await sh.untilCommands(1);
    await settle();
    // shell 在跑：写已落盘；它照样过了 kind:'shell' 的权限闸；读还没开始
    expect(read(written)).toBe('w');
    expect(gw.requests.map(q => q.kind)).toEqual(['file-write', 'shell']);
    expect(sh.commands[0].command).toBe('echo hi');
    expect(e.trace.has('R:enter')).toBe(false);

    sh.commands[0].reply('hi');
    const [w, s, r] = await withDeadline(done, 5000, 'S18 批次结束');
    expect(w.outcome.success).toBe(true);
    expect(s.outcome.success).toBe(true);
    expect(s.outcome.output).toContain('hi');
    expect(r.outcome).toEqual({ output: '别的文件', success: true });
    expect(e.events.find(x => x.kind === 'queued' && x.toolUseId === 'SH')).toMatchObject({ barrier: true, readOnly: false, sideEffects: 'unknown' });
  });

  it('S37 shell 的锁跟着常驻 shell 的出生目录：会话中途改了工作区，旧目录与新目录里别的会话的写都要等这条命令', async () => {
    const e = mkEnv('S37');
    const sh = fakeShellSpawn();
    e.registry.register(makeShellTool(new ShellManager({ spawnImpl: sh.spawnImpl })));
    const W1 = join(e.root, 'ext', 'w1'); const W2 = join(e.root, 'ext', 'w2');
    mkdirSync(W1, { recursive: true }); mkdirSync(W2, { recursive: true });
    const bound = new Map<string, string>([['a', W1]]);
    e.paths.setWorkspaceResolver(sid => bound.get(sid));

    // 第一条命令：会话 a 的 shell 在 W1 里出生
    const first = e.run('a', [call('S1', 'shell_execute', { command: 'one' })]);
    await sh.untilCommands(1);
    sh.commands[0].reply('1');
    await withDeadline(first, 5000, 'S37 第一条命令');
    expect(sh.spawns.map(s => s.cwd)).toEqual([W1]);

    // 改工作区到 W2（shell 不跟着走），再跑一条命令并让它挂住
    bound.set('a', W2);
    const second = e.run('a', [call('S2', 'shell_execute', { command: 'two' })]);
    await sh.untilCommands(2);
    const doneB = e.run('b', [call('B', 'fx_write', { path: join(W1, 'x.txt'), content: 'b' })]);
    const doneC = e.run('c', [call('C', 'fx_write', { path: join(W2, 'y.txt'), content: 'c' })]);
    expect((await untilWaiting(e.locks, '/B/')).foreignBlocked).toBe(true);
    expect((await untilWaiting(e.locks, '/C/')).foreignBlocked).toBe(true);
    await settle();
    expect(e.trace.has('B:enter')).toBe(false);
    expect(e.trace.has('C:enter')).toBe(false);

    sh.commands[1].reply('2');
    await withDeadline(Promise.all([second, doneB, doneC]), 5000, 'S37 命令答复后三方结束');
    expect(read(join(W1, 'x.txt'))).toBe('b');
    expect(read(join(W2, 'y.txt'))).toBe('c');
    // 还是 W1 里出生的那个驱动，没有重建
    expect(sh.spawns.map(s => s.cwd)).toEqual([W1]);

    // 对照：从没建过 shell 的会话 d（工作区 W2）只锁 W2，别的会话写 W1 不被挡
    bound.set('d', W2);
    const third = e.run('d', [call('S3', 'shell_execute', { command: 'three' })]);
    await sh.untilCommands(3);
    const [free] = await withDeadline(
      e.run('b', [call('B2', 'fx_write', { path: join(W1, 'x.txt'), content: 'b2' })]), 2000, 'S37 对照：写 W1 不被挡');
    expect(free.outcome.success).toBe(true);
    expect(sh.commands[2].replied).toBe(false);
    sh.commands[2].reply('3');
    await withDeadline(third, 5000, 'S37 收尾');
  });
});

describe('F04 调度器 V3：真实 McpManager（假 client）', () => {
  // 服务器自报只读、名字也叫只读查询。annotations 不在 McpToolInfo 里（宿主不读它），这里照服务器实际会回的样子带上
  const selfReported = [{
    name: 'read_only_query', description: '只读查询', inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  }] as unknown as McpToolInfo[];
  const plain: McpToolInfo[] = [{ name: 'echo', description: '回显', inputSchema: { type: 'object', properties: {} } }];

  for (const decision of ['allow', 'deny'] as const) {
    it(`S17 MCP 工具自报只读、入参也自称只读：照样按 barrier 排、照样过 kind:'mcp' 的权限闸（网关 ${decision}）`, async () => {
      const e = mkEnv(`S17-${decision}`);
      const callGate = new Gate();
      const mcp = mcpOn(e.registry, selfReported, async () => { e.trace.log('M:call'); await callGate.opened; });
      await mcp.manager.ensureForRun();
      const name = 'mcp__srv__read_only_query';
      expect(e.registry.get(name)).toBeDefined();
      const A = e.file('a.txt', 'a'); const B = e.file('b.txt', 'b');
      const g1 = e.gate('g1');
      const gw = new ManualGateway(q => (q.kind === 'mcp' ? decision : 'allow'));
      const done = e.run('s17', [
        call('A', 'fx_read', { path: A, gate: 'g1' }),
        call('M', name, { readOnly: true, concurrencySafe: true }),
        call('B', 'fx_read', { path: B }),
      ], { permissions: gw });

      await e.trace.until('A:enter');
      await untilWaiting(e.locks, '/M/');
      await untilWaiting(e.locks, '/B/');
      await settle();
      // 前面的读没出门：MCP 调用没问权限、没发出去；后面的读没进门
      expect(gw.requests).toHaveLength(0);
      expect(e.trace.lines).toEqual(['A:enter']);
      g1.open();
      if (decision === 'allow') {
        await e.trace.until('M:call');
        await settle();
        expect(e.trace.has('B:enter')).toBe(false);
        callGate.open();
      }
      const [, m, b] = await withDeadline(done, 5000, 'S17 批次结束');

      expect(gw.requests.map(q => [q.kind, q.detail])).toEqual([['mcp', 'srv']]);
      expect(b.outcome).toEqual({ output: 'b', success: true });
      expect(e.events.find(x => x.kind === 'queued' && x.toolUseId === 'M'))
        .toMatchObject({ barrier: true, readOnly: false, sideEffects: 'unknown', claims: ['named:mcp:srv', 'session:s17'] });
      if (decision === 'allow') {
        expect(m.outcome).toEqual({ output: 'mcp ok', success: true });
        expect(mcp.clients[0].callLog.map(c => c.name)).toEqual(['read_only_query']);
        expect(e.trace.lines.filter(l => ['A:exit', 'M:call', 'B:enter'].includes(l))).toEqual(['A:exit', 'M:call', 'B:enter']);
      } else {
        expect(m.outcome.success).toBe(false);
        expect(m.outcome.output).toContain('被用户拒绝');
        expect(mcp.clients[0].callLog).toEqual([]);
        expect(e.trace.has('M:call')).toBe(false);
      }
    });
  }

  /** [读 A（闸 g1）, MCP 调用]，返回时 MCP 调用已确认在锁表里等着。 */
  async function mcpQueuedBehindRead(label: string) {
    const e = mkEnv(label);
    const mcp = mcpOn(e.registry, plain);
    await mcp.manager.ensureForRun();
    const name = 'mcp__srv__echo';
    const before = e.registry.get(name);
    expect(before).toBeDefined();
    const A = e.file('a.txt', 'a');
    const g1 = e.gate('g1');
    const gw = new ManualGateway(() => 'allow');
    const done = e.run(label.toLowerCase(), [call('A', 'fx_read', { path: A, gate: 'g1' }), call('M', name)], { permissions: gw });
    await e.trace.until('A:enter');
    await untilWaiting(e.locks, '/M/');
    return { e, mcp, name, before, g1, gw, done };
  }

  it('S36(a) 等锁期间这台 MCP 被 forget：调用按未知工具失败，不问权限、不发调用，刚复位的服务器不被标成出错', async () => {
    const { e, mcp, name, g1, gw, done } = await mcpQueuedBehindRead('S36a');
    mcp.manager.forget('srv');
    expect(e.registry.get(name)).toBeUndefined();
    g1.open();
    const [, m] = await withDeadline(done, 5000, 'S36a 批次结束');

    expect(m).toMatchObject({ end: 'refused', started: false, outcome: { output: `未知工具: ${name}`, success: false } });
    expect(gw.requests.filter(q => q.kind === 'mcp')).toHaveLength(0);
    expect(mcp.clients[0].callLog).toEqual([]);
    expect(mcp.manager.statuses()).toMatchObject([{ name: 'srv', status: 'idle' }]);
    expect(e.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('S36(b) 等锁期间 forget 之后又重连（同名工具换了新的执行器）：调用落在新连接上并成功', async () => {
    const { e, mcp, name, before, g1, gw, done } = await mcpQueuedBehindRead('S36b');
    mcp.manager.forget('srv');
    await mcp.manager.ensureForRun();
    expect(mcp.clients).toHaveLength(2);
    expect(e.registry.get(name)).toBeDefined();
    expect(e.registry.get(name)).not.toBe(before);
    g1.open();
    const [, m] = await withDeadline(done, 5000, 'S36b 批次结束');

    expect(m).toMatchObject({ end: 'completed', started: true, outcome: { output: 'mcp ok', success: true } });
    expect(mcp.clients[0].callLog).toEqual([]);
    expect(mcp.clients[1].callLog.map(c => c.name)).toEqual(['echo']);
    expect(gw.requests.map(q => q.kind)).toEqual(['mcp']);
    expect(mcp.manager.statuses()).toMatchObject([{ name: 'srv', status: 'connected' }]);
  });
});
