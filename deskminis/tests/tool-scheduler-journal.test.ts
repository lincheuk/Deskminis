/**
 * F05 J 组：调度器的调用账本接缝（CallJournal）。
 *
 * 接缝只有三件事：执行前一个能否决的同步点（begin 抛错即不执行）、落定时拿得到真实结果（settled 带 outcome）、
 * 落定在放锁之前。这里用记录型的假账本验证时机与顺序；真实账本在 run-ledger-loop.test.ts。
 * 顺序断言看工具侧的 Trace，不看账本自己说的。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinisPaths } from '../src/minisd/paths';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ToolScheduler, type CallJournal, type CallRef, type SchedulerEvent } from '../src/minisd/tools/scheduler';
import type { PermissionGateway, ToolContext, ToolOutcome } from '../src/minisd/tools/types';
import { Gate, ManualGateway, Trace, allowAll, fxUnknown, fxWrite, gatedTool, withDeadline } from './scheduler-fixture';
import { stripComments } from './strip-comments';

function env(lockWaitTimeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), 'dm-f05-j-'));
  const paths = new MinisPaths(root);
  const registry = new ToolRegistry();
  const scheduler = new ToolScheduler({ lockWaitTimeoutMs });
  const trace = new Trace();
  const ctx = (sessionId: string, over: Partial<ToolContext> = {}): ToolContext => ({ sessionId, paths, permissions: allowAll, ...over });
  return { root, paths, registry, scheduler, trace, ctx };
}
const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({ toolUseId: id, name, input: JSON.stringify({ tag: id, ...input }) });

/** 记录型账本：begin / settled 各记一笔进同一个 Trace（与工具侧的记录同一条时间线）。 */
function recordingJournal(trace: Trace, o: { failBegin?: (at: CallRef) => boolean; failSettled?: boolean; permissions?: CallJournal['permissions'] } = {}): CallJournal & { settledCalls: { at: CallRef; end: string; started: boolean; outcome: ToolOutcome }[]; plans: Record<string, unknown> } {
  const settledCalls: { at: CallRef; end: string; started: boolean; outcome: ToolOutcome }[] = [];
  const plans: Record<string, unknown> = {};
  const j: CallJournal = {
    begin(at, plan) {
      trace.log(`${at.toolUseId}:journal-begin`);
      plans[at.toolUseId] = plan;
      if (o.failBegin?.(at)) throw new Error('注入：库写失败');
    },
    settled(at, r) {
      trace.log(`${at.toolUseId}:journal-settled`);
      settledCalls.push({ at, end: r.end, started: r.started, outcome: r.outcome });
      if (o.failSettled) throw new Error('注入：结果提交失败');
    },
  };
  if (o.permissions) j.permissions = o.permissions;
  return Object.assign(j, { settledCalls, plans });
}

describe('F05 调度器的调用账本接缝', () => {
  it('J1 begin 抛错：工具没有进门、结果是 refused / started:false、锁已放（同资源的下一个调用照常执行）', async () => {
    const e = env();
    e.registry.register(fxWrite({ trace: e.trace }));
    const P = join(e.root, 'j1.txt');
    const journal = recordingJournal(e.trace, { failBegin: at => at.toolUseId === 'W1' });
    const results = await withDeadline(e.scheduler.runBatch({
      calls: [call('W1', 'fx_write', { path: P, content: '1' }), call('W2', 'fx_write', { path: P, content: '2' })],
      registry: e.registry, ctx: e.ctx('j1'), journal,
    }), 3000, 'J1');
    expect(e.trace.has('W1:enter')).toBe(false);
    expect(results[0]).toMatchObject({ end: 'refused', started: false, outcome: { success: false } });
    expect(results[0].outcome.output).toContain('工具 fx_write 没有执行：执行记录写入失败（注入：库写失败）');
    expect(results[0].outcome.output).toContain('可以重试');
    // 同一路径上的下一个调用照常执行：W1 的锁已放
    expect(results[1]).toMatchObject({ end: 'completed', started: true, outcome: { success: true } });
    expect(readFileSync(P, 'utf8')).toBe('2');
    // 没执行的调用也恰好落定一次，带的是那条说明
    expect(journal.settledCalls.map(s => [s.at.toolUseId, s.end, s.started])).toEqual([['W1', 'refused', false], ['W2', 'completed', true]]);
  });

  it('J2 顺序：begin → started 事件 → 进门 → settled 回调 → settled 事件 → 同资源下一个调用的 begin', async () => {
    const e = env();
    e.registry.register(fxWrite({ trace: e.trace }));
    const P = join(e.root, 'j2.txt');
    const journal = recordingJournal(e.trace);
    const onEvent = (ev: SchedulerEvent): void => { if (ev.kind === 'started' || ev.kind === 'settled') e.trace.log(`${ev.toolUseId}:event-${ev.kind}`); };
    await withDeadline(e.scheduler.runBatch({
      calls: [call('A', 'fx_write', { path: P, content: 'a' }), call('B', 'fx_write', { path: P, content: 'b' })],
      registry: e.registry, ctx: e.ctx('j2'), journal, onEvent,
    }), 3000, 'J2');
    expect(e.trace.lines).toEqual([
      'A:journal-begin', 'A:event-started', 'A:enter', 'A:effect', 'A:exit', 'A:journal-settled', 'A:event-settled',
      'B:journal-begin', 'B:event-started', 'B:enter', 'B:effect', 'B:exit', 'B:journal-settled', 'B:event-settled',
    ]);
    // 计划如实交给账本：写集合是声明的写路径
    expect(journal.plans.A).toMatchObject({ name: 'fx_write', barrier: false, readOnly: false, sideEffects: 'local-files', writePaths: [P] });
    expect((journal.plans.A as { claims: string[] }).claims.length).toBeGreaterThan(0);
  });

  it('J3 五种结局各落定恰好一次，带真实的 outcome', async () => {
    // (a) 提前拒绝（未知工具、会话排除）+ (e) 正常完成
    const e = env();
    e.registry.register(fxUnknown({ trace: e.trace }));
    const j1 = recordingJournal(e.trace);
    const r1 = await e.scheduler.runBatch({
      calls: [call('NOPE', 'no_such_tool'), call('EXCL', 'fx_unknown'), call('OK', 'fx_unknown')],
      registry: e.registry, ctx: e.ctx('j3a'), journal: j1,
      refuse: c => (c.toolUseId === 'EXCL' ? { output: '本会话没有启用', success: false } : undefined),
    });
    expect(j1.settledCalls.map(s => [s.at.toolUseId, s.end, s.started, s.outcome.output])).toEqual([
      ['NOPE', 'refused', false, r1[0].outcome.output], ['EXCL', 'refused', false, '本会话没有启用'], ['OK', 'completed', true, 'OK ok'],
    ]);
    expect(r1[0].outcome.output).toContain('未知工具');
    // 没有执行的调用不经过 begin
    expect(e.trace.lines.filter(l => l.endsWith(':journal-begin'))).toEqual(['OK:journal-begin']);

    // (b) 等锁超时：别的会话占着同一路径
    const t = env(60);
    const gate = new Gate();
    t.registry.register(fxWrite({ trace: t.trace, gateOf: i => (i.tag === 'HOLD' ? gate : undefined) }));
    const P = join(t.root, 'j3.txt');
    const holding = t.scheduler.runBatch({ calls: [call('HOLD', 'fx_write', { path: P, content: 'h' })], registry: t.registry, ctx: t.ctx('holder') });
    await t.trace.until('HOLD:enter');
    const j2 = recordingJournal(t.trace);
    const r2 = await withDeadline(t.scheduler.runBatch({ calls: [call('WAIT', 'fx_write', { path: P, content: 'w' })], registry: t.registry, ctx: t.ctx('waiter'), journal: j2 }), 3000, 'J3 等锁超时');
    expect(j2.settledCalls.map(s => [s.end, s.started])).toEqual([['lock-timeout', false]]);
    expect(j2.settledCalls[0].outcome).toBe(r2[0].outcome);
    expect(t.trace.has('WAIT:journal-begin')).toBe(false);
    gate.open();
    await holding;

    // (c) 启动前取消
    const c = env();
    c.registry.register(fxUnknown({ trace: c.trace }));
    const controller = new AbortController();
    controller.abort();
    const j3 = recordingJournal(c.trace);
    await c.scheduler.runBatch({ calls: [call('X', 'fx_unknown')], registry: c.registry, ctx: c.ctx('j3c', { signal: controller.signal }), journal: j3 });
    expect(j3.settledCalls.map(s => [s.end, s.started, s.outcome.output])).toEqual([['cancelled-before-start', false, '[已取消]']]);
    expect(c.trace.lines).toEqual(['X:journal-settled']);

    // (d) 复核不过：等锁期间工具被摘
    const d = env();
    const g2 = new Gate();
    d.registry.register(fxUnknown({ trace: d.trace, gateOf: i => (i.tag === 'FIRST' ? g2 : undefined) }));
    d.registry.register(gatedTool({ name: 'fx_gone', trace: d.trace }));
    const j4 = recordingJournal(d.trace);
    const p4 = d.scheduler.runBatch({ calls: [call('FIRST', 'fx_unknown'), call('GONE', 'fx_gone')], registry: d.registry, ctx: d.ctx('j3d'), journal: j4 });
    await d.trace.until('FIRST:enter');
    d.registry.unregister('fx_gone');
    g2.open();
    const r4 = await withDeadline(p4, 3000, 'J3 复核');
    expect(r4[1]).toMatchObject({ end: 'refused', started: false });
    expect(j4.settledCalls.map(s => [s.at.toolUseId, s.end, s.started])).toEqual([['FIRST', 'completed', true], ['GONE', 'refused', false]]);
    expect(d.trace.has('GONE:journal-begin')).toBe(false);
  });

  it('J4 permissions 接缝在取消赛跑层之内：接缝把放行改成拒绝时工具不产生副作用；询问前已取消时接缝不被调用', async () => {
    const e = env();
    const counter = join(e.root, 'j4.log');
    e.registry.register(fxUnknown({ trace: e.trace, ask: (i, ctx) => ({ kind: 'shell', detail: String(i.tag), sessionId: ctx.sessionId, toolTitle: 't' }) }));
    const asked: string[] = [];
    const deny: CallJournal['permissions'] = (at, inner): PermissionGateway => ({
      async check() { return 'deny'; },
      async decide(req, opts) {
        asked.push(at.toolUseId);
        const o = await inner.decide!(req, opts);
        expect(o.decision).toBe('allow');
        return { decision: 'deny', reason: 'invalidated', cause: 'record-failed' };
      },
      hasBridgeGrant: s => inner.hasBridgeGrant(s),
    });
    const gw = new ManualGateway(() => 'allow');
    const r = await e.scheduler.runBatch({
      calls: [call('S1', 'fx_unknown', { counter })], registry: e.registry, ctx: e.ctx('j4', { permissions: gw }),
      journal: recordingJournal(e.trace, { permissions: deny }),
    });
    expect(asked).toEqual(['S1']);
    expect(gw.requests).toHaveLength(1);
    expect(e.trace.has('S1:effect')).toBe(false);
    expect(existsSync(counter)).toBe(false);
    expect(r[0]).toMatchObject({ end: 'completed', started: true, outcome: { success: false } });

    // 询问前已取消：取消赛跑层直接交回 cancelled，接缝与内层网关都不被调用
    const c = env();
    const controller = new AbortController();
    const asked2: string[] = [];
    const gw2 = new ManualGateway(() => 'allow');
    // 不理会取消的工具：进门后照样去问权限
    c.registry.register(gatedTool({ name: 'fx_stubborn', trace: c.trace, honorAbort: false, ask: (i, ctx) => ({ kind: 'shell', detail: String(i.tag), sessionId: ctx.sessionId, toolTitle: 't' }) }));
    const j = recordingJournal(c.trace, {
      permissions: (at, inner) => ({ async check(req) { asked2.push(at.toolUseId); return inner.check(req); }, async decide(req, o) { asked2.push(at.toolUseId); return inner.decide!(req, o); }, hasBridgeGrant: () => false }),
    });
    // 进门那一刻取消（begin 之后、问权限之前）
    const origBegin = j.begin.bind(j);
    j.begin = (at, plan) => { origBegin(at, plan); controller.abort(); };
    const r2 = await withDeadline(c.scheduler.runBatch({ calls: [call('S2', 'fx_stubborn')], registry: c.registry, ctx: c.ctx('j4b', { permissions: gw2, signal: controller.signal }), journal: j }), 3000, 'J4b');
    expect(c.trace.has('S2:ask')).toBe(true);
    expect(asked2).toEqual([]);
    expect(gw2.requests).toEqual([]);
    expect(r2[0].outcome.success).toBe(false);
  });

  it('J5 settled 回调抛错不影响结果与放锁', async () => {
    const e = env();
    e.registry.register(fxWrite({ trace: e.trace }));
    const P = join(e.root, 'j5.txt');
    const results = await withDeadline(e.scheduler.runBatch({
      calls: [call('A', 'fx_write', { path: P, content: 'a' }), call('B', 'fx_write', { path: P, content: 'b' })],
      registry: e.registry, ctx: e.ctx('j5'), journal: recordingJournal(e.trace, { failSettled: true }),
    }), 3000, 'J5');
    expect(results.map(r => [r.end, r.outcome.success])).toEqual([['completed', true], ['completed', true]]);
    expect(readFileSync(P, 'utf8')).toBe('b');
    expect(e.scheduler.locks.snapshot().held).toEqual([]);
  });

  it('J6 不传 journal：与以前相同（事件序列里没有多出任何东西，结果照常）', async () => {
    const e = env();
    e.registry.register(fxWrite({ trace: e.trace }));
    const P = join(e.root, 'j6.txt');
    const kinds: string[] = [];
    const results = await e.scheduler.runBatch({
      calls: [call('A', 'fx_write', { path: P, content: 'a' })], registry: e.registry, ctx: e.ctx('j6'),
      onEvent: ev => { kinds.push(ev.kind); },
    });
    expect(kinds).toEqual(['queued', 'started', 'settled']);
    expect(results[0]).toMatchObject({ end: 'completed', started: true, outcome: { success: true } });
    expect(e.trace.lines).toEqual(['A:enter', 'A:effect', 'A:exit']);
  });

  it('J8（F08）begin 交回的执行身份出现在工具收到的 ctx.call 里，covers 只认本次调用持有的写路径；返回 void 的账本与不带账本照旧', async () => {
    const e = env();
    const seen: ToolContext['call'][] = [];
    const target = join(e.root, 'w', 'a.txt');
    const readOnly = join(e.root, 'r', 'source.txt');
    e.registry.register({
      definition: { name: 'probe_write', description: 'x', parameters: { tag: { type: 'string', description: 'x' } }, required: [] },
      scheduling: {
        readOnly: false, concurrencySafe: true, sideEffects: 'local-files',
        resources: () => [{ kind: 'path', mode: 'write', path: target }, { kind: 'path', mode: 'read', path: readOnly }],
      },
      async execute(_input, ctx) { seen.push(ctx.call); return { output: 'ok', success: true }; },
    });
    const withIdentity: CallJournal = { begin: at => ({ runId: 'RUN-1', executionId: `EXEC-${at.index}` }), settled: () => undefined };
    const voidJournal: CallJournal = { begin: () => undefined, settled: () => undefined };
    await e.scheduler.runBatch({ calls: [call('A', 'probe_write'), call('B', 'probe_write')], registry: e.registry, ctx: e.ctx('S1'), journal: withIdentity });
    await e.scheduler.runBatch({ calls: [call('C', 'probe_write')], registry: e.registry, ctx: e.ctx('S1'), journal: voidJournal });
    await e.scheduler.runBatch({ calls: [call('D', 'probe_write')], registry: e.registry, ctx: e.ctx('S1') });
    expect(seen.map(c => [c?.toolUseId, c?.index, c?.name, c?.runId, c?.executionId])).toEqual([
      ['A', 0, 'probe_write', 'RUN-1', 'EXEC-0'],
      ['B', 1, 'probe_write', 'RUN-1', 'EXEC-1'],
      ['C', 0, 'probe_write', undefined, undefined],
      ['D', 0, 'probe_write', undefined, undefined],
    ]);
    for (const c of seen) {
      expect(c?.covers?.(target)).toBe(true);
      expect(c?.covers?.(join(e.root, 'w', 'A.TXT'))).toBe(process.platform === 'win32');   // 与锁同一套路径身份：win32 折叠大小写
      expect(c?.covers?.(join(e.root, 'w', 'b.txt'))).toBe(false);
      expect(c?.covers?.(join(e.root, 'w'))).toBe(false);                                   // 父目录不在写锁之内
      expect(c?.covers?.(readOnly)).toBe(false);                                            // 只声明了读的路径：持有的是读锁，不算在写锁之内
    }
  });

  it('J7 源码守卫：runOne 里 journal.begin 在 started 事件与 registry.run 之前，三者之间没有 await；scheduler.ts 没有新增 import', () => {
    const code = stripComments(readFileSync(join(__dirname, '..', 'src', 'minisd', 'tools', 'scheduler.ts'), 'utf8'));
    const runOne = code.slice(code.indexOf('const runOne = async'), code.indexOf('const tasks: Promise<void>[] = []'));
    const begin = runOne.indexOf('journal?.begin(');
    const started = runOne.indexOf("kind: 'started'");
    const run = runOne.indexOf('registry.run(');
    expect(begin).toBeGreaterThan(0);
    expect(started).toBeGreaterThan(begin);
    expect(run).toBeGreaterThan(started);
    // recheck 到 registry.run 之间只有 registry.run 自己那一个 await
    const between = runOne.slice(runOne.indexOf('recheck(call, prepared, plan)'), run);
    expect(between.match(/\bawait\b/g) ?? []).toEqual(['await']);
    expect(between.trimEnd().endsWith('await o.')).toBe(true);
    // 落定只有一个出口，账本提交在 settled 事件之前、放锁在它之后
    const finish = code.slice(code.indexOf('const finish = '), code.indexOf('const refused = '));
    expect(finish.indexOf('journal?.settled(')).toBeGreaterThan(0);
    expect(finish.indexOf("kind: 'settled'")).toBeGreaterThan(finish.indexOf('journal?.settled('));
    expect(code.match(/kind: 'settled', end/g) ?? []).toHaveLength(1);
    expect(runOne.indexOf('lock.release()')).toBeGreaterThan(runOne.lastIndexOf('finish('));
    // 调度器不引账本实现：import 的模块集合与 F04 / F13 合入时相同
    const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
    expect(imports).toEqual(['../../shared/permission', './data-gate', './permission-outcome', './registry', './resource-locks', './types']);
  });
});
