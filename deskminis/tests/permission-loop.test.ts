/**
 * F13：调度器的权限包装层（wrapPermissions）与循环级行为——审批与执行绑定（toolUseId ↔ requestId）、
 * 取消经包装层交给网关当场了结卡片、批准了却没执行时记一条、连续无人答复不无限弹卡。
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentLoop, type LoopEvent } from '../src/minisd/agent/loop';
import { fileWriteTool } from '../src/minisd/tools/files';
import { cancelSourceOf, wrapPermissions, type CancelSource, type SchedulerEvent } from '../src/minisd/tools/scheduler';
import type { PermissionAskOptions, PermissionDenied, PermissionGateway, PermissionOutcome, PermissionRequest, ToolContext } from '../src/minisd/tools/types';
import { ScriptProvider, collect, loopEnv, toolEndOf, toolTurn, withDeadline } from './scheduler-fixture';
import { mkStack } from './permission-stack-fixture';
import { settle, waitFor } from './permission-fixture';

const REQ: PermissionRequest = { kind: 'file-write', detail: 'C:\\w\\a.txt', sessionId: 'S1', toolTitle: 't' };

/** 带 decide 的内层网关：询问挂着，测试决定何时交回；记下收到的 opts 与 noteDenied。 */
function heldInner(issue: string | undefined) {
  const noted: { req: PermissionRequest; denied: PermissionDenied; opts?: Pick<PermissionAskOptions, 'toolUseId' | 'origin'> }[] = [];
  const seen: (PermissionAskOptions | undefined)[] = [];
  let resolve!: (o: PermissionOutcome) => void;
  const gw: PermissionGateway = {
    async check() { throw new Error('包装层不该调内层的 check'); },
    decide(_req, opts) {
      seen.push(opts);
      if (issue !== undefined) opts?.onIssued?.(issue);
      return new Promise<PermissionOutcome>(r => { resolve = r; });
    },
    noteDenied(req, denied, opts) { noted.push({ req, denied, opts }); },
    hasBridgeGrant: () => false,
  };
  return { gw, noted, seen, answer: (o: PermissionOutcome): void => { resolve(o); } };
}

describe('W1 wrapPermissions：带原因、带绑定；批准了却没执行时记一条', () => {
  it('(a) 批准与取消写在同一段同步代码里：交回 cancelled（带那张卡的 id），内层晚到的批准补记一条', async () => {
    const ctl = new AbortController();
    const h = heldInner('CARD-W1');
    const returned: unknown[][] = [];
    const wrapped = wrapPermissions(h.gw, cancelSourceOf(ctl.signal), { returned: (...a) => { returned.push(a); } }, { toolUseId: 'TU-1', signal: ctl.signal });
    const p = wrapped.decide!(REQ);
    h.answer({ decision: 'allow', via: 'user-once', requestId: 'CARD-W1' }); ctl.abort('session-deleted');
    const o = await withDeadline(p, 2000, 'W1(a) 交回');
    expect(o).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'session-deleted', requestId: 'CARD-W1' });
    expect(returned).toEqual([['deny', true, o]]);
    expect(h.seen.length).toBe(1);
    expect(h.seen[0]).toMatchObject({ toolUseId: 'TU-1', origin: 'tool' });
    expect(h.seen[0]!.signal!.aborted, '取消交给了内层网关').toBe(true);
    await settle();
    expect(h.noted).toEqual([{
      req: REQ, opts: { toolUseId: 'TU-1', origin: 'tool' },
      denied: { decision: 'deny', reason: 'cancelled', cause: 'session-deleted', requestId: 'CARD-W1' },
    }]);
  });

  it('(b) 内层先交回批准、交回那一刻已取消（订阅者没被通知）：不放行，当场记一条', async () => {
    let aborted = false;
    const cancel: CancelSource = { get aborted() { return aborted; }, subscribe: () => () => undefined, dispose: () => undefined };
    const h = heldInner('CARD-W2');
    const returned: unknown[][] = [];
    const wrapped = wrapPermissions(h.gw, cancel, { returned: (...a) => { returned.push(a); } }, { toolUseId: 'TU-2' });
    const p = wrapped.decide!(REQ);
    h.answer({ decision: 'allow', via: 'user-session', requestId: 'CARD-W2' }); aborted = true;
    const o = await withDeadline(p, 2000, 'W1(b) 交回');
    expect(o).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: 'CARD-W2' });
    expect(returned).toEqual([['deny', true, o]]);
    await settle();
    expect(h.noted.map(n => [n.denied, n.opts])).toEqual([
      [{ decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: 'CARD-W2' }, { toolUseId: 'TU-2', origin: 'tool' }],
    ]);
  });

  it('(c) 没弹卡的放行（不带 requestId）被取消：交回 cancelled，不记', async () => {
    const ctl = new AbortController();
    const h = heldInner(undefined);
    const wrapped = wrapPermissions(h.gw, cancelSourceOf(ctl.signal), undefined, { toolUseId: 'TU-3', signal: ctl.signal });
    const p = wrapped.decide!(REQ);
    h.answer({ decision: 'allow', via: 'level-bypass' }); ctl.abort();
    expect(await withDeadline(p, 2000, 'W1(c) 交回')).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'user-stop' });
    await settle();
    expect(h.noted).toEqual([]);
  });

  // 变异检查补的：(a) 只看内层的 signal 有没有 abort，不看原因——包装层不转交原因时它不红
  it.each(['session-deleted', 'shutdown'] as const)('(d) 取消的原因随 signal 交给内层（%s）：网关据此把卡记成删除 / 关停，而不是 user-stop', async why => {
    const ctl = new AbortController();
    const h = heldInner('CARD-W6');
    const p = wrapPermissions(h.gw, cancelSourceOf(ctl.signal), undefined, { toolUseId: 'TU-7', signal: ctl.signal }).decide!(REQ);
    ctl.abort(why);
    expect(await withDeadline(p, 2000, 'W1(d) 交回')).toEqual({ decision: 'deny', reason: 'cancelled', cause: why, requestId: 'CARD-W6' });
    expect(h.seen[0]!.signal!.aborted).toBe(true);
    expect(h.seen[0]!.signal!.reason, '内层拿到的取消原因就是会话 signal 的 reason').toBe(why);
  });

  it('内层晚到的是拒绝：不记；没有取消时结果原样交回，check 是它的投影', async () => {
    const ctl = new AbortController();
    const h = heldInner('CARD-W4');
    const p = wrapPermissions(h.gw, cancelSourceOf(ctl.signal), undefined, { toolUseId: 'TU-4', signal: ctl.signal }).decide!(REQ);
    ctl.abort();
    expect(await p).toMatchObject({ reason: 'cancelled', requestId: 'CARD-W4' });
    h.answer({ decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: 'CARD-W4' });
    await settle();
    expect(h.noted).toEqual([]);

    const h2 = heldInner('CARD-W5');
    const returned: unknown[][] = [];
    const w2 = wrapPermissions(h2.gw, cancelSourceOf(new AbortController().signal), { returned: (...a) => { returned.push(a); } }, { toolUseId: 'TU-5' });
    const p2 = w2.decide!(REQ);
    const timeout: PermissionOutcome = { decision: 'deny', reason: 'timeout', cause: 'unanswered', requestId: 'CARD-W5', waitedMs: 7 };
    h2.answer(timeout);
    expect(await p2).toEqual(timeout);
    expect(returned).toEqual([['deny', false, timeout]]);
    const h3 = heldInner(undefined);
    const p3 = wrapPermissions(h3.gw, undefined).check(REQ);
    h3.answer({ decision: 'allow', via: 'session-grant' });
    expect(await p3).toBe('allow');
  });

  it('已取消时不调内层；noteDenied 带上绑定的 toolUseId 转给内层；内层没有 decide（旧式二值）读成「没有说明原因」', async () => {
    const ctl = new AbortController(); ctl.abort('shutdown');
    const h = heldInner('X');
    const wrapped = wrapPermissions(h.gw, cancelSourceOf(ctl.signal), undefined, { toolUseId: 'TU-6', signal: ctl.signal });
    expect(await wrapped.decide!(REQ)).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'shutdown' });
    expect(h.seen).toEqual([]);
    wrapped.noteDenied!(REQ, { decision: 'deny', reason: 'rule-blocked', cause: 'core-data' });
    expect(h.noted).toEqual([{ req: REQ, denied: { decision: 'deny', reason: 'rule-blocked', cause: 'core-data' }, opts: { toolUseId: 'TU-6', origin: 'tool' } }]);

    const binary: PermissionGateway = { async check() { return 'deny'; }, hasBridgeGrant: () => false };
    expect(await wrapPermissions(binary, undefined).decide!(REQ)).toEqual({ decision: 'deny', reason: 'unspecified', cause: 'legacy-binary' });
    expect(() => wrapPermissions(binary, undefined).noteDenied!(REQ, { decision: 'deny', reason: 'rule-blocked' })).not.toThrow();
  });
});

describe('循环级：审批与执行绑定、取消了结卡片、不无限弹卡', () => {
  const SKILL = (n: string): string => `/var/minis/skills/f13/${n}`;

  function rig(label: string, stackOpts: Parameters<typeof mkStack>[0] = {}) {
    const env = loopEnv(label);
    env.tools.register(fileWriteTool);
    const stack = mkStack(stackOpts);
    return { env, stack };
  }

  it('L1 卡片的 meta.toolUseId 是发起它的工具调用；approval-returned.outcome.requestId 是这张卡', async () => {
    const { env, stack } = rig('l1');
    const sessionId = env.newSession();
    const provider = new ScriptProvider([toolTurn([{ id: 'TU-L1', name: 'file_write', input: { path: SKILL('l1.md'), content: 'x', tool_title: '写' } }])]);
    const toolEvents: SchedulerEvent[] = [];
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: stack.gateway };
    const done = collect(runAgentLoop(env.store, { sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys', onToolEvent: e => { toolEvents.push(e); } }));

    await waitFor('权限卡', () => stack.wire.cards().length === 1);
    const card = stack.wire.of('permission.request')[0].params;
    expect(card.meta.toolUseId).toBe('TU-L1');
    expect(stack.broker.pending()).toMatchObject([{ requestId: card.requestId, toolUseId: 'TU-L1', origin: 'tool' }]);
    expect(stack.audit.of('permission.request', card.requestId)[0].payload.meta.toolUseId).toBe('TU-L1');
    expect(stack.broker.respond(card.requestId, 'allow-once')).toEqual({ ok: true, applied: true });
    const events = await withDeadline(done, 10000, 'L1 回合结束');

    expect(toolEndOf(events, 'TU-L1')).toMatchObject({ success: true });
    const ret = toolEvents.filter((e): e is Extract<SchedulerEvent, { kind: 'approval-returned' }> => e.kind === 'approval-returned');
    expect(ret.length).toBe(1);
    expect(ret[0]).toMatchObject({ toolUseId: 'TU-L1', decision: 'allow', cancelled: false, outcome: { decision: 'allow', via: 'user-once', requestId: card.requestId } });
    expect(stack.audit.of('permission.resolved', card.requestId)[0].payload).toMatchObject({ reason: 'answered', toolUseId: 'TU-L1' });
  });

  it('L2 等卡时取消（不经 index.ts）：卡当场了结，晚到的 allow-session 不生效，工具没执行；另起一个 run 仍然询问', async () => {
    const { env, stack } = rig('l2');
    const sessionId = env.newSession();
    const input = { path: SKILL('l2.md'), content: 'x', tool_title: '写' };
    const ctl = new AbortController();
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: stack.gateway, signal: ctl.signal };
    const done = collect(runAgentLoop(env.store, {
      sessionId, provider: new ScriptProvider([toolTurn([{ id: 'TU-L2', name: 'file_write', input }])]),
      tools: env.tools, toolContext, systemPrompt: 'sys', signal: ctl.signal,
    }));
    await waitFor('权限卡', () => stack.wire.cards().length === 1);
    const id = stack.wire.cards()[0];
    ctl.abort();
    expect(stack.broker.pending(), '取消经包装层 → 网关 → broker 同步了结卡片').toEqual([]);
    expect(stack.broker.respond(id, 'allow-session')).toEqual({ ok: true, applied: false, settled: { reason: 'cancelled', decision: 'deny' } });
    const events = await withDeadline(done, 10000, 'L2 回合结束');

    expect(events.filter((e): e is Extract<LoopEvent, { kind: 'error' }> => e.kind === 'error').map(e => e.message)).toEqual(['已取消']);
    expect(toolEndOf(events, 'TU-L2')).toMatchObject({ success: false, output: '[已取消]' });
    expect(existsSync(join(env.root, 'skills', 'f13', 'l2.md'))).toBe(false);
    expect(stack.wire.of('permission.resolved', id).map(x => x.params.outcome)).toMatchObject([{ decision: 'deny', reason: 'cancelled', cause: 'user-stop' }]);
    expect(stack.approved).toEqual([]);

    // 没有留下会话授权：另起一个 run，同一请求仍然询问
    const again = collect(runAgentLoop(env.store, {
      sessionId, provider: new ScriptProvider([toolTurn([{ id: 'TU-L2b', name: 'file_write', input }])]),
      tools: env.tools, toolContext: { sessionId, paths: env.paths, permissions: stack.gateway }, systemPrompt: 'sys',
    }));
    await waitFor('第二张权限卡', () => stack.wire.cards().length === 2);
    stack.broker.respond(stack.wire.cards()[1], 'deny');
    const events2 = await withDeadline(again, 10000, 'L2 第二个 run 结束');
    expect(toolEndOf(events2, 'TU-L2b')!.output).toContain('写入被用户拒绝');
  });

  // 变异检查补的：L2 用不带原因的 abort()，包装层丢掉取消原因时它不红
  it("L2b 等卡时带原因取消（不经 index.ts，abort('shutdown')）：原因经包装层 → 网关 → broker，卡按 shutdown 了结，不记成 user-stop", async () => {
    const { env, stack } = rig('l2b');
    const sessionId = env.newSession();
    const ctl = new AbortController();
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: stack.gateway, signal: ctl.signal };
    const done = collect(runAgentLoop(env.store, {
      sessionId, provider: new ScriptProvider([toolTurn([{ id: 'TU-L2c', name: 'file_write', input: { path: SKILL('l2b.md'), content: 'x', tool_title: '写' } }])]),
      tools: env.tools, toolContext, systemPrompt: 'sys', signal: ctl.signal,
    }));
    await waitFor('权限卡', () => stack.wire.cards().length === 1);
    const id = stack.wire.cards()[0];
    ctl.abort('shutdown');
    expect(stack.broker.pending(), '取消同步了结卡片').toEqual([]);
    await withDeadline(done, 10000, 'L2b 回合结束');

    expect(stack.wire.of('permission.resolved', id).map(x => [x.params.reason, x.params.outcome.cause])).toEqual([['shutdown', 'shutdown']]);
    expect(stack.audit.of('permission.resolved', id).map(r => [r.payload.reason, r.payload.outcome.cause])).toEqual([['shutdown', 'shutdown']]);
    expect(stack.broker.respond(id, 'allow-once')).toEqual({ ok: true, applied: false, settled: { reason: 'shutdown', decision: 'deny' } });
    expect(existsSync(join(env.root, 'skills', 'f13', 'l2b.md'))).toBe(false);
  });

  it('L3 连续三轮各发一个要询问的写入、无人应答：只弹 2 张卡，第三个直接说明没有再询问；resetUnanswered 之后重新询问', async () => {
    const { env, stack } = rig('l3', { timeoutMs: 50, askTimeoutMs: 50 });
    const sessionId = env.newSession();
    const call = (id: string, n: string) => toolTurn([{ id, name: 'file_write', input: { path: SKILL(n), content: 'x', tool_title: '写' } }]);
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: stack.gateway };
    const events = await withDeadline(collect(runAgentLoop(env.store, {
      sessionId, provider: new ScriptProvider([call('T1', 'a.md'), call('T2', 'b.md'), call('T3', 'c.md')]), tools: env.tools, toolContext, systemPrompt: 'sys',
    })), 15000, 'L3 回合结束');

    expect(stack.wire.cards().length, '第三次没有再弹卡').toBe(2);
    const outs = ['T1', 'T2', 'T3'].map(id => toolEndOf(events, id)!);
    for (const o of outs) { expect(o.success).toBe(false); expect(o.output).not.toContain('被用户拒绝'); }
    expect(outs[0].output).toContain('没有人答复');
    expect(outs[1].output).toContain('没有人答复');
    expect(outs[2].output).toContain('没有再询问');
    for (const n of ['a.md', 'b.md', 'c.md']) expect(existsSync(join(env.root, 'skills', 'f13', n))).toBe(false);
    expect(stack.audit.of('permission.denied').map(r => [r.payload.outcome.reason, r.payload.outcome.cause, r.payload.toolUseId])).toEqual([['timeout', 'unattended', 'T3']]);

    // 用户发来新消息（index.ts 在 chat.prompt 里调 resetUnanswered）：重新询问
    stack.gateway.resetUnanswered(sessionId);
    const next = collect(runAgentLoop(env.store, { sessionId, provider: new ScriptProvider([call('T4', 'd.md')]), tools: env.tools, toolContext, systemPrompt: 'sys' }));
    await waitFor('第三张权限卡', () => stack.wire.cards().length === 3);
    stack.broker.respond(stack.wire.cards()[2], 'allow-once');
    expect(toolEndOf(await withDeadline(next, 10000, 'L3 第二个 run 结束'), 'T4')).toMatchObject({ success: true });
  });
});
