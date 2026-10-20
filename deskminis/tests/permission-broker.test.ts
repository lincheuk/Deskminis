/**
 * F13：PermissionBroker——一张卡只了结一次（第一终态获胜）、晚到的答复不生效、审计与广播故障不影响了结、
 * 断线后换连接发来的旧批准不生效。超时一律用 fake timers；K10 用真 RpcServer 与真 WebSocket。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PermissionBroker, responderOf, type SystemSettle } from '../src/minisd/tools/permission-broker';
import { PromptAbort } from '../src/minisd/tools/permissions';
import { askPermission } from '../src/minisd/tools/permission-outcome';
import type { PermissionRequest } from '../src/minisd/tools/types';
import type { PermissionOutcome } from '../src/shared/permission';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService, StaticIdentity, derivePairingKey } from '../src/minisd/remote/pairing';
import { createAdditionalVerify, guardBusinessMethod } from '../src/minisd/remote';
import { encodePaseto } from '../src/minisd/remote/paseto';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { MinisPaths } from '../src/minisd/paths';
import { makeBridgeDispatcher, type BridgeEnvelope, type BridgeRequest } from '../src/minisd/bridge/handlers';
import { detectBridgeTriggers } from '../src/minisd/bridge/detect';
import { mkStack, MemAudit, Wire, type Stack } from './permission-stack-fixture';
import { waitFor } from './permission-fixture';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) { try { await cleanups.pop()!(); } catch { /* 收尾尽力 */ } }
});

const req = (kind: PermissionRequest['kind'], detail: string, sessionId = 'S1'): PermissionRequest => ({ kind, detail, sessionId, toolTitle: 't' });
/** 带桥触发的 shell 命令：批准它会顺带发桥合并授权（晚到的批准不该发）。 */
const BRIDGE_SHELL = req('shell', 'windows-clipboard get');
const WRITE = req('file-write', 'C:\\w\\a.txt');

/** 发起一次询问，返回它的卡片 id（decide 同步登记卡片）。 */
function ask(s: Stack, r: PermissionRequest, opts?: Parameters<Stack['gateway']['decide']>[1]): { p: Promise<PermissionOutcome>; id: string } {
  const before = s.wire.cards().length;
  const p = s.gateway.decide(r, opts);
  const ids = s.wire.cards();
  if (ids.length !== before + 1) throw new Error('这次 decide 没有弹卡');
  return { p, id: ids[ids.length - 1] };
}

describe('卡片登记', () => {
  it('广播与审计的形态：meta 带 timeoutMs / riskClass / bridgeTriggers / toolUseId；审计剔除 preview 只记 hasPreview', async () => {
    const s = mkStack({ timeoutMs: 5000 });
    const a = ask(s, BRIDGE_SHELL, { toolUseId: 'TU-1' });
    const card = s.wire.of('permission.request')[0].params;
    expect(card).toEqual({ requestId: a.id, req: BRIDGE_SHELL, meta: { timeoutMs: 5000, riskClass: 'gated', bridgeTriggers: ['bridge-clipboard-read'], toolUseId: 'TU-1' } });
    expect(a.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-/);
    expect(s.broker.pending()).toEqual([{ requestId: a.id, req: BRIDGE_SHELL, toolUseId: 'TU-1', origin: 'tool', askedAt: expect.any(Number), bridgeTriggers: ['bridge-clipboard-read'] }]);
    s.broker.respond(a.id, 'deny');
    await a.p;

    const w = { ...WRITE, preview: { oldText: 'o', newText: 'n' }, note: '说明' };
    const b = ask(s, w);
    expect(s.wire.of('permission.request', b.id)[0].params).toEqual({ requestId: b.id, req: w, meta: { timeoutMs: 5000 } });
    expect(s.audit.of('permission.request', b.id)[0]).toEqual({
      eventType: 'permission.request', opts: { sessionId: 'S1' },
      payload: { requestId: b.id, req: { ...WRITE, note: '说明' }, hasPreview: true, meta: { timeoutMs: 5000 } },
    });
    s.broker.respond(b.id, 'deny');
    await b.p;
  });

  it('询问方进门前已取消：不建卡', async () => {
    const s = mkStack();
    const c = new AbortController(); c.abort(new PromptAbort('cancelled', 'shutdown'));
    expect(await s.broker.ask(WRITE, { signal: c.signal, origin: 'tool' })).toEqual({ answer: 'deny', reason: 'cancelled', cause: 'shutdown' });
    expect(s.wire.sent).toEqual([]); expect(s.audit.rows).toEqual([]); expect(s.broker.pending()).toEqual([]);
  });
});

describe('V2 一张卡只了结一次', () => {
  it('K1 超时之后的 allow-session：不生效、不发桥授权、不写会话授权；广播与审计各只有一条 timeout，另记一条 late-response', async () => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000 });
    const a = ask(s, BRIDGE_SHELL);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await a.p).toMatchObject({ decision: 'deny', reason: 'timeout', cause: 'unanswered', requestId: a.id });

    expect(s.broker.respond(a.id, 'allow-session')).toEqual({ ok: true, applied: false, settled: { reason: 'timeout', decision: 'deny' } });
    expect(s.gateway.hasBridgeGrant('S1')).toBe(false);
    expect(s.approved).toEqual([]);
    expect(s.wire.of('permission.resolved', a.id).map(x => x.params.reason)).toEqual(['timeout']);
    expect(s.audit.of('permission.resolved', a.id).length).toBe(1);
    expect(s.audit.of('permission.resolved', a.id)[0].payload).toMatchObject({ reason: 'timeout', outcome: { decision: 'deny', reason: 'timeout', cause: 'unanswered', requestId: a.id } });
    expect(s.audit.of('permission.late-response', a.id).map(r => r.payload)).toEqual([
      { requestId: a.id, decision: 'allow-session', by: 'local', cause: 'settled', settled: { reason: 'timeout', decision: 'deny' } },
    ]);
    // 同一请求再来：重新弹卡（没有留下会话授权）
    const b = ask(s, BRIDGE_SHELL);
    expect(b.id).not.toBe(a.id);
    s.broker.respond(b.id, 'deny'); await b.p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('K2 超时之前的 allow-once：生效；两个定时器都已清，没有 timeout 广播', async () => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000 });
    const a = ask(s, BRIDGE_SHELL);
    await vi.advanceTimersByTimeAsync(999);
    expect(s.broker.respond(a.id, 'allow-once', { via: 'local' })).toEqual({ ok: true, applied: true });
    expect(await a.p).toEqual({ decision: 'allow', via: 'user-once', requestId: a.id });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.wire.of('permission.resolved', a.id).map(x => x.params)).toEqual([{ requestId: a.id, reason: 'answered', outcome: { decision: 'allow', via: 'user-once', requestId: a.id } }]);
    expect(s.audit.of('permission.resolved', a.id).map(r => r.payload)).toEqual([
      { requestId: a.id, reason: 'answered', outcome: { decision: 'allow', via: 'user-once', requestId: a.id }, decision: 'allow-once', by: 'local' },
    ]);
    // 有效的批准确实发了桥授权（对照 K1：晚到的没有）
    expect(s.approved).toEqual([{ requestId: a.id, decision: 'allow-once' }]);
    expect(s.gateway.hasBridgeGrant('S1')).toBe(true);
  });

  it.each([
    ['(a) 网关 1000、broker 1001', 1000, 1001],
    ['(b) 网关 1001、broker 1000', 1001, 1000],
  ])('K3 两个定时器错开 %s：先到的那个把卡了结，紧跟着的 allow-session 不生效', async (_n, askTimeoutMs, timeoutMs) => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs, askTimeoutMs });
    const a = ask(s, BRIDGE_SHELL);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.broker.respond(a.id, 'allow-session')).toMatchObject({ applied: false, settled: { reason: 'timeout' } });
    await vi.advanceTimersByTimeAsync(5);
    expect(await a.p).toMatchObject({ decision: 'deny', reason: 'timeout', requestId: a.id });
    expect(s.wire.of('permission.resolved', a.id).map(x => x.params.reason)).toEqual(['timeout']);
    expect(s.wire.of('permission.resolved', a.id)[0].params.outcome).toMatchObject({ decision: 'deny', reason: 'timeout', cause: 'unanswered' });
    expect(s.gateway.hasBridgeGrant('S1')).toBe(false);
    expect(s.approved).toEqual([]);
    expect(s.broker.pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['deny', 'allow-once'], ['allow-once', 'deny'], ['allow-session', 'allow-once'], ['deny', 'allow-session'],
  ] as const)('K4 同一段同步代码里先 %s 后 %s：第一条生效，第二条不生效', async (first, second) => {
    const s = mkStack();
    const a = ask(s, BRIDGE_SHELL);
    const r1 = s.broker.respond(a.id, first);
    const r2 = s.broker.respond(a.id, second);
    expect(r1).toEqual({ ok: true, applied: true });
    expect(r2).toEqual({ ok: true, applied: false, settled: { reason: 'answered', decision: first === 'deny' ? 'deny' : 'allow' } });
    const o = await a.p;
    expect(o.decision).toBe(first === 'deny' ? 'deny' : 'allow');
    expect(s.approved.map(x => x.decision)).toEqual(first === 'deny' ? [] : [first]);
    expect(s.gateway.hasBridgeGrant('S1')).toBe(first !== 'deny');
    expect(s.wire.of('permission.resolved', a.id).length).toBe(1);
    expect(s.audit.of('permission.resolved', a.id).length).toBe(1);
    expect(s.audit.of('permission.resolved', a.id)[0].payload.decision).toBe(first);
  });

  it('K5 取消后晚到 allow：结果 cancelled，卡当场了结，批准不生效', async () => {
    const s = mkStack();
    const c = new AbortController();
    const a = ask(s, BRIDGE_SHELL, { signal: c.signal });
    c.abort('session-deleted');
    expect(s.broker.pending(), 'abort 同步了结卡片').toEqual([]);
    expect(s.broker.respond(a.id, 'allow-once')).toEqual({ ok: true, applied: false, settled: { reason: 'session-deleted', decision: 'deny' } });
    expect(await a.p).toMatchObject({ decision: 'deny', reason: 'cancelled', cause: 'session-deleted', requestId: a.id });
    expect(s.wire.of('permission.resolved', a.id).map(x => x.params.reason)).toEqual(['session-deleted']);
    expect(s.approved).toEqual([]);
    expect(s.gateway.hasBridgeGrant('S1')).toBe(false);
  });

  // 变异检查补的：K5 直接调 gateway.decide；工具走的是 askPermission，它不把 ctx.signal 交给网关时 K5 / L2 都不红
  // （L2 经调度器包装层，包装层用自己的信号）。不经包装层的调用方靠询问入口这一步
  it('K5b 经询问入口（askPermission 直接对网关，不经调度器包装层）等卡时取消：卡当场了结，晚到的批准不生效', async () => {
    const s = mkStack();
    const c = new AbortController();
    const p = askPermission({ permissions: s.gateway, signal: c.signal }, WRITE);
    const ids = s.wire.cards();
    expect(ids.length, '卡片在同一拍登记').toBe(1);
    const id = ids[0];
    try {
      c.abort('shutdown');
      expect(s.broker.pending(), 'abort 同步了结卡片：询问入口没把 signal 交给网关的话，卡要挂到超时').toEqual([]);
      expect(s.broker.respond(id, 'allow-session')).toEqual({ ok: true, applied: false, settled: { reason: 'shutdown', decision: 'deny' } });
      expect(await p).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'shutdown', requestId: id });
      expect(s.wire.of('permission.resolved', id).map(x => x.params.reason)).toEqual(['shutdown']);
      expect(s.approved).toEqual([]);
    } finally {
      // 断言失败时别把卡和定时器留给后面的用例
      s.broker.settleWhere(() => true, { reason: 'cancelled', cause: 'user-stop' });
    }
  });

  it('K6 settleWhere 之后，同一条目的定时器到点、abort 监听触发：都没有第二条广播与审计', async () => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 2000 });
    const c = new AbortController();
    const a = ask(s, WRITE, { signal: c.signal });
    const other = ask(s, req('file-write', 'C:\\w\\b.txt', 'S2'));
    expect(s.broker.settleWhere(e => e.req.sessionId === 'S1', { reason: 'cancelled', cause: 'user-stop' })).toBe(1);
    expect(await a.p).toMatchObject({ reason: 'cancelled', cause: 'user-stop', requestId: a.id });
    c.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.wire.of('permission.resolved', a.id).map(x => x.params.reason)).toEqual(['cancelled']);
    expect(s.audit.of('permission.resolved', a.id).length).toBe(1);
    // 别的会话的卡不受 settleWhere 影响：它按自己的时限超时
    expect(await other.p).toMatchObject({ reason: 'timeout', requestId: other.id });
    expect(s.broker.settleWhere(() => true, { reason: 'cancelled', cause: 'shutdown' })).toBe(0);
  });

  it('线上 reason 的取法：cancelled 按 cause 分 cancelled / session-deleted / shutdown；invalidated 单列', async () => {
    const s = mkStack();
    const hows: [SystemSettle, string][] = [
      [{ reason: 'cancelled', cause: 'user-stop' }, 'cancelled'], [{ reason: 'cancelled', cause: 'requester-gone' }, 'cancelled'],
      [{ reason: 'cancelled', cause: 'session-deleted' }, 'session-deleted'], [{ reason: 'cancelled', cause: 'shutdown' }, 'shutdown'],
      [{ reason: 'invalidated', cause: 'mcp-disabled' }, 'invalidated'],
    ];
    for (const [how, wire] of hows) {
      const a = ask(s, WRITE);
      s.broker.settleWhere(() => true, how);
      expect(await a.p).toMatchObject({ decision: 'deny', reason: how.reason, cause: how.cause, requestId: a.id });
      expect(s.wire.of('permission.resolved', a.id)[0].params).toMatchObject({ reason: wire, outcome: { reason: how.reason, cause: how.cause } });
      const row = s.audit.of('permission.resolved', a.id)[0].payload;
      expect(row).toMatchObject({ reason: wire });
      expect(row.decision, '系统代为了结的卡不记 decision / by').toBeUndefined();
      expect(row.by).toBeUndefined();
    }
  });

  it("K8 非法 decision（'yes' / undefined / 'ALLOW-ONCE' / 对象）：抛错，卡仍待批，定时器仍在", async () => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000 });
    const a = ask(s, BRIDGE_SHELL);
    for (const bad of ['yes', undefined, 'ALLOW-ONCE', '', null, { decision: 'allow-once' }, 1]) {
      expect(() => s.broker.respond(a.id, bad), String(bad)).toThrow('非法权限决定');
    }
    // 对不存在的卡也一样报错（先校验取值）
    expect(() => s.broker.respond('NOPE', 'yes')).toThrow('非法权限决定');
    expect(s.broker.pending().map(p => p.requestId)).toEqual([a.id]);
    expect(s.wire.of('permission.resolved')).toEqual([]);
    expect(s.approved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await a.p).toMatchObject({ reason: 'timeout' });
  });

  it('K9(a) 没见过的 id、滚出最近记录的 id：applied:false 且没有 settled，不写审计', async () => {
    const s = mkStack({ recentLimit: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { const a = ask(s, req('file-write', `C:\\w\\${i}.txt`)); s.broker.respond(a.id, 'deny'); await a.p; ids.push(a.id); }
    const rowsBefore = s.audit.rows.length;
    expect(s.broker.respond('从没见过的-ID', 'allow-once')).toEqual({ ok: true, applied: false });
    expect(s.broker.respond(ids[0], 'allow-once'), '最早的一张已滚出最近记录').toEqual({ ok: true, applied: false });
    expect(s.audit.rows.length).toBe(rowsBefore);
    expect(s.broker.respond(ids[2], 'allow-once')).toMatchObject({ applied: false, settled: { reason: 'answered', decision: 'deny' } });
    expect(s.approved).toEqual([]);
  });

  it('K9(b) 对同一张已了结的卡连答三次：每次都带 settled，审计只多一行 late-response（记第一次的 decision）', async () => {
    const s = mkStack();
    const a = ask(s, WRITE);
    s.broker.settleWhere(() => true, { reason: 'cancelled', cause: 'user-stop' });
    await a.p;
    const rowsBefore = s.audit.rows.length;
    const settled = { reason: 'cancelled', decision: 'deny' };
    expect(s.broker.respond(a.id, 'allow-once', { via: 'remote', peerFingerprint: 'FP-1', seq: 9 })).toEqual({ ok: true, applied: false, settled });
    expect(s.broker.respond(a.id, 'deny')).toEqual({ ok: true, applied: false, settled });
    expect(s.broker.respond(a.id, 'allow-session')).toEqual({ ok: true, applied: false, settled });
    expect(s.audit.rows.length).toBe(rowsBefore + 1);
    expect(s.audit.of('permission.late-response', a.id)).toEqual([{
      eventType: 'permission.late-response', opts: { sessionId: 'S1', peerFingerprint: 'FP-1' },
      payload: { requestId: a.id, decision: 'allow-once', by: 'remote', cause: 'settled', settled },
    }]);
    expect(s.audit.of('permission.resolved', a.id).length).toBe(1);
    expect(s.wire.of('permission.resolved', a.id).length).toBe(1);
    expect(s.approved).toEqual([]);
  });
});

describe('V4 审计 / 广播故障不影响了结', () => {
  const paths = ['respond', 'timeout', 'settleWhere'] as const;
  async function drive(s: Stack, a: { p: Promise<PermissionOutcome>; id: string }, how: (typeof paths)[number]): Promise<PermissionOutcome> {
    if (how === 'respond') expect(s.broker.respond(a.id, 'allow-once')).toEqual({ ok: true, applied: true });
    else if (how === 'timeout') await vi.advanceTimersByTimeAsync(1000);
    else expect(s.broker.settleWhere(() => true, { reason: 'invalidated', cause: 'mcp-disabled' })).toBe(1);
    return a.p;
  }
  const expected = { respond: { decision: 'allow', via: 'user-once' }, timeout: { decision: 'deny', reason: 'timeout' }, settleWhere: { decision: 'deny', reason: 'invalidated', cause: 'mcp-disabled' } };
  const wireReason = { respond: 'answered', timeout: 'timeout', settleWhere: 'invalidated' };

  for (const failing of ['permission.request', 'permission.resolved'] as const) {
    it.each(paths)(`K7 ${failing} 的审计写入失败 × %s：询问方得到正确结果，广播照发，只记一笔带 requestId 的警告`, async how => {
      vi.useFakeTimers();
      const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000 });
      s.audit.failOn.add(failing);
      const a = ask(s, BRIDGE_SHELL);
      expect(await drive(s, a, how)).toMatchObject({ ...expected[how], requestId: a.id });
      expect(s.wire.of('permission.resolved', a.id).map(x => x.params.reason)).toEqual([wireReason[how]]);
      expect(s.warns.filter(w => w.includes(a.id) && w.includes('审计')).length).toBe(1);
      // 没失败的那一条审计照写
      const other = failing === 'permission.request' ? 'permission.resolved' : 'permission.request';
      expect(s.audit.of(other, a.id).length).toBe(1);
      expect(s.audit.of(failing, a.id).length).toBe(0);
      expect(s.broker.pending()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it.each(paths)('K7 permission.late-response 的审计写入失败 × %s：晚到的答复照常不生效，不抛', async how => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000 });
    s.audit.failOn.add('permission.late-response');
    const a = ask(s, BRIDGE_SHELL);
    await drive(s, a, how);
    const grantsBefore = s.approved.length;
    expect(s.broker.respond(a.id, 'allow-session')).toMatchObject({ ok: true, applied: false, settled: { reason: wireReason[how] } });
    expect(s.approved.length).toBe(grantsBefore);
    expect(s.warns.filter(w => w.includes(a.id) && w.includes('审计')).length).toBe(1);
  });

  it('K11(a) permission.request 广播抛错：询问方得到异常；不留孤儿卡、孤儿定时器；之后对这个 id 的答复查无此卡', async () => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000, newId: () => 'KNOWN-ID' });
    s.wire.failOn.add('permission.request');
    await expect(s.gateway.decide(BRIDGE_SHELL)).rejects.toThrow('注入：广播失败');
    expect(s.broker.pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.wire.sent).toEqual([]);
    expect(s.audit.rows).toEqual([]);
    expect(s.broker.respond('KNOWN-ID', 'allow-once')).toEqual({ ok: true, applied: false });
    expect(s.approved).toEqual([]);
    expect(s.gateway.hasBridgeGrant('S1')).toBe(false);
  });

  it.each(paths)('K11(b) permission.resolved 广播抛错 × %s：询问方得到正确结果，审计照写，只记警告', async how => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000 });
    s.wire.failOn.add('permission.resolved');
    const a = ask(s, BRIDGE_SHELL);
    expect(await drive(s, a, how)).toMatchObject({ ...expected[how], requestId: a.id });
    expect(s.audit.of('permission.resolved', a.id).map(r => r.payload.reason)).toEqual([wireReason[how]]);
    expect(s.warns.filter(w => w.includes(a.id) && w.includes('广播')).length).toBe(1);
    expect(s.broker.pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onApproved / describe / onUserSeen / issued 抛错：都被兜住，卡片照常', async () => {
    const audit = new MemAudit(); const wire = new Wire(); const warns: string[] = [];
    const broker = new PermissionBroker({
      timeoutMs: 1000, broadcast: (m, p) => wire.broadcast(m, p), audit: (t, p, o) => audit.append(t, p, o),
      describe: () => { throw new Error('describe 炸了'); }, onApproved: () => { throw new Error('授权炸了'); },
      onUserSeen: () => { throw new Error('通知炸了'); }, warn: m => { warns.push(m); },
    });
    const c = new AbortController();
    const p = broker.ask(WRITE, { signal: c.signal, origin: 'tool', issued: () => { throw new Error('issued 炸了'); } });
    const id = wire.cards()[0];
    expect(broker.respond(id, 'allow-once')).toEqual({ ok: true, applied: true });
    expect(await p).toEqual({ answer: 'allow-once', requestId: id });
    expect(broker.respond(id, 'deny')).toMatchObject({ applied: false });
    expect(warns.length).toBe(3);
  });
});

describe('断线后旧批准：一张卡只接受发卡时已经连着的连接的答复', () => {
  it('K12 发卡之后才建立的连接、没有序号的应答方：不生效、卡不动、审计至多一条；发卡时就在的连接照常生效', async () => {
    let cur = 3;
    const s = mkStack({ connSeq: () => cur });
    const a = ask(s, BRIDGE_SHELL);
    cur = 4; // 发卡之后又来了一条连接
    const stale = { ok: true, applied: false, undelivered: true };
    expect(s.broker.respond(a.id, 'allow-once', { via: 'local', seq: 4 })).toEqual(stale);
    expect(s.broker.respond(a.id, 'allow-once', { via: 'local' })).toEqual(stale);
    expect(s.broker.respond(a.id, 'allow-once')).toEqual(stale);
    expect(s.broker.pending().map(p => p.requestId)).toEqual([a.id]);
    expect(s.wire.of('permission.resolved')).toEqual([]);
    expect(s.approved).toEqual([]);
    expect(s.audit.of('permission.late-response', a.id).map(r => r.payload)).toEqual([{ requestId: a.id, decision: 'allow-once', by: 'local', cause: 'stale-connection' }]);
    // 发卡时已经连着的连接（序号 ≤ 3）
    expect(s.broker.respond(a.id, 'allow-once', { via: 'local', seq: 3 })).toEqual({ ok: true, applied: true });
    expect(await a.p).toEqual({ decision: 'allow', via: 'user-once', requestId: a.id });
    expect(s.approved.length).toBe(1);
  });

  it('K12 被挡下的答复不动定时器：之后无人答复，照常按 timeout 了结', async () => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000, connSeq: () => 3 });
    const a = ask(s, WRITE);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.broker.respond(a.id, 'allow-once', { via: 'local', seq: 4 })).toMatchObject({ applied: false, undelivered: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(await a.p).toMatchObject({ reason: 'timeout', requestId: a.id });
    expect(s.wire.of('permission.resolved', a.id).map(x => x.params.reason)).toEqual(['timeout']);
  });

  it('K12 不给 connSeq：不做连接检查，没有序号的应答方照常生效', async () => {
    const s = mkStack();
    const a = ask(s, WRITE);
    expect(s.broker.respond(a.id, 'allow-once')).toEqual({ ok: true, applied: true });
    expect((await a.p).decision).toBe('allow');
  });

  it('responderOf：remote 连接带指纹与序号；缺省按 local', () => {
    expect(responderOf(undefined)).toEqual({ via: 'local' });
    expect(responderOf({ authMode: 'local', seq: 2 })).toEqual({ via: 'local', seq: 2 });
    expect(responderOf({ authMode: 'remote', peerFingerprint: 'FP', seq: 5 })).toEqual({ via: 'remote', peerFingerprint: 'FP', seq: 5 });
  });
});

describe('K13 晚到的答复说明用户在场：清掉无人答复计数', () => {
  it('两次超时后对已超时的卡点了拒绝：没生效，但下一个请求重新弹卡', async () => {
    vi.useFakeTimers();
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000 });
    const a = ask(s, req('file-write', 'C:\\w\\1.txt')); await vi.advanceTimersByTimeAsync(1000); await a.p;
    const b = ask(s, req('file-write', 'C:\\w\\2.txt')); await vi.advanceTimersByTimeAsync(1000); await b.p;
    // 对照：此刻已到上限，新请求不弹卡
    expect(await s.gateway.decide(req('file-write', 'C:\\w\\3.txt'))).toEqual({ decision: 'deny', reason: 'timeout', cause: 'unattended' });
    expect(s.audit.of('permission.denied').map(r => r.payload.outcome.cause)).toEqual(['unattended']);

    expect(s.broker.respond(b.id, 'deny')).toEqual({ ok: true, applied: false, settled: { reason: 'timeout', decision: 'deny' } });
    const c = ask(s, req('file-write', 'C:\\w\\3.txt'));
    expect(c.id).not.toBe(b.id);
    s.broker.respond(c.id, 'allow-once');
    expect((await c.p).decision).toBe('allow');
  });
});

describe('K14 重入：了结一张卡的回调里又了结了同一批的另一张卡', () => {
  it('settleWhere 途中（广播回调里）再来一轮 settleWhere：每张卡仍只了结一次，张数不重复计', async () => {
    const audit = new MemAudit(); const wire = new Wire();
    let reentered = 0;
    let inner = -1;
    const broker: PermissionBroker = new PermissionBroker({
      timeoutMs: 60_000,
      broadcast: (m, p) => {
        wire.broadcast(m, p);
        // 第一张卡了结的广播触发了又一轮系统了结（例如关停与取消撞在一起）：此刻外层循环手里还攥着第二张卡的旧引用
        if (m === 'permission.resolved' && reentered++ === 0) inner = broker.settleWhere(() => true, { reason: 'cancelled', cause: 'shutdown' });
      },
      audit: (t, p, o) => audit.append(t, p, o),
    });
    const mk = (d: string) => broker.ask(req('file-write', d), { signal: new AbortController().signal, origin: 'tool' });
    const pa = mk('C:\\w\\a.txt'); const pb = mk('C:\\w\\b.txt');
    const [ida, idb] = wire.cards();

    const outer = broker.settleWhere(() => true, { reason: 'cancelled', cause: 'user-stop' });
    expect([outer, inner], '外层只了结了 A，重入的那一轮了结了 B').toEqual([1, 1]);
    expect(await pa).toMatchObject({ answer: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: ida });
    expect(await pb).toMatchObject({ answer: 'deny', reason: 'cancelled', cause: 'shutdown', requestId: idb });
    // 第一终态获胜：B 已经按 shutdown 了结，外层循环轮到它时不再了结第二次
    expect(wire.of('permission.resolved', ida).map(x => x.params.reason)).toEqual(['cancelled']);
    expect(wire.of('permission.resolved', idb).map(x => x.params.reason)).toEqual(['shutdown']);
    expect(audit.of('permission.resolved', ida).length).toBe(1);
    expect(audit.of('permission.resolved', idb).length).toBe(1);
    expect(broker.pending()).toEqual([]);
    expect(broker.respond(idb, 'allow-once')).toEqual({ ok: true, applied: false, settled: { reason: 'shutdown', decision: 'deny' } });
  });
});

describe('K10 远程应答方（真 RpcServer + guardBusinessMethod + 真 broker）', () => {
  interface Client { ws: WebSocket; call(method: string, params?: unknown): Promise<any> }
  function connect(port: number, query: string): Promise<Client> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
      const pending = new Map<number, (m: any) => void>();
      let idc = 0;
      ws.on('message', d => { const m = JSON.parse(String(d)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
      ws.on('open', () => res({
        ws,
        call: (method, params) => new Promise(resolve => { const id = ++idc; pending.set(id, resolve); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })); }),
      }));
      ws.on('error', rej);
    });
  }

  async function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'dm-f13-k10-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ } });
    const vault = new InMemoryVault();
    const store = new PairingStore(dir, vault);
    const service = new PairingService(store, vault);
    const audit = new MemAudit(); const wire = new Wire();
    const seen: RpcConnection[] = [];
    let rpc!: RpcServer;
    const broker = new PermissionBroker({
      timeoutMs: 60_000, connSeq: () => rpc.lastConnSeq(),
      broadcast: (m, p) => { wire.broadcast(m, p); rpc.broadcast(m, p); }, audit: (t, p, o) => audit.append(t, p, o),
    });
    const methods: RpcMethods = {
      'permission.respond': (p: any, conn: RpcConnection) => { seen.push(conn); return broker.respond(String(p?.requestId ?? ''), p?.decision, responderOf(conn)); },
    };
    const isPaired = (fp: string): boolean => service.get(fp) !== undefined;
    for (const k of Object.keys(methods)) methods[k] = guardBusinessMethod(methods[k], k, isPaired);
    rpc = new RpcServer(methods, 'LOCAL-TOKEN-K10', createAdditionalVerify(service));
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());
    const pairPeer = (): { fp: string; paseto: string } => {
      const peer = new StaticIdentity(); const me = new StaticIdentity();
      const key = derivePairingKey(me.privateKey, peer.publicKey, 'CODE1234', peer.fingerprint, 'peer');
      store.save(key);
      return { fp: peer.fingerprint, paseto: encodePaseto({ exp: Date.now() + 60_000, iat: Date.now(), device_fingerprint: peer.fingerprint }, key.authKey) };
    };
    const card = (): { p: Promise<unknown>; id: string } => {
      const p = broker.ask(WRITE, { signal: new AbortController().signal, origin: 'tool' });
      const ids = wire.cards();
      return { p, id: ids[ids.length - 1] };
    };
    return { rpc, port, broker, audit, wire, service, store, seen, pairPeer, card };
  }

  it('(a) 发卡前已连上的已配对设备批准：生效，审计记 by:remote 与对端指纹；连接序号递增', async () => {
    const r = await rig();
    expect(r.rpc.lastConnSeq()).toBe(0);
    const peer = r.pairPeer();
    const local = await connect(r.port, 'token=LOCAL-TOKEN-K10');
    const remote = await connect(r.port, `paseto=${encodeURIComponent(peer.paseto)}`);
    cleanups.push(() => { local.ws.close(); remote.ws.close(); });
    await waitFor('两条连接都分到序号', () => r.rpc.lastConnSeq() === 2);
    const c = r.card();
    const res = await remote.call('permission.respond', { requestId: c.id, decision: 'allow-once' });
    expect(res.result).toEqual({ ok: true, applied: true });
    expect(await c.p).toEqual({ answer: 'allow-once', requestId: c.id });
    expect(r.seen.map(x => [x.authMode, x.seq])).toEqual([['remote', 2]]);
    expect(r.audit.of('permission.resolved', c.id)).toEqual([{
      eventType: 'permission.resolved', opts: { sessionId: 'S1', peerFingerprint: peer.fp },
      payload: { requestId: c.id, reason: 'answered', outcome: { decision: 'allow', via: 'user-once', requestId: c.id }, decision: 'allow-once', by: 'remote' },
    }]);
    // 本机连接答另一张卡：by:local，不写指纹列
    const c2 = r.card();
    expect((await local.call('permission.respond', { requestId: c2.id, decision: 'deny' })).result).toEqual({ ok: true, applied: true });
    expect(r.audit.of('permission.resolved', c2.id)[0]).toMatchObject({ opts: { sessionId: 'S1' }, payload: { by: 'local', decision: 'deny' } });
    expect(r.audit.of('permission.resolved', c2.id)[0].opts.peerFingerprint).toBeUndefined();
  });

  it('(b) 配对被删之后再答复：RPC 被拒，卡仍待批', async () => {
    const r = await rig();
    const peer = r.pairPeer();
    const remote = await connect(r.port, `paseto=${encodeURIComponent(peer.paseto)}`);
    cleanups.push(() => { remote.ws.close(); });
    const c = r.card();
    r.service.delete(peer.fp);
    const res = await remote.call('permission.respond', { requestId: c.id, decision: 'allow-once' });
    expect(res.error).toBeDefined();
    expect(r.broker.pending().map(p => p.requestId)).toEqual([c.id]);
    expect(r.seen).toEqual([]);
    expect(r.audit.of('permission.resolved')).toEqual([]);
  });

  it('(c) 发卡之后才连上的已配对设备答复：不生效（undelivered），卡仍待批', async () => {
    const r = await rig();
    const peer = r.pairPeer();
    const early = await connect(r.port, 'token=LOCAL-TOKEN-K10');
    cleanups.push(() => { early.ws.close(); });
    const c = r.card();
    const late = await connect(r.port, `paseto=${encodeURIComponent(peer.paseto)}`);
    cleanups.push(() => { late.ws.close(); });
    await waitFor('第二条连接分到序号', () => r.rpc.lastConnSeq() === 2);
    const res = await late.call('permission.respond', { requestId: c.id, decision: 'allow-once' });
    expect(res.result).toEqual({ ok: true, applied: false, undelivered: true });
    expect(r.broker.pending().map(p => p.requestId)).toEqual([c.id]);
    expect(r.audit.of('permission.late-response', c.id)).toMatchObject([{ opts: { peerFingerprint: peer.fp }, payload: { by: 'remote', cause: 'stale-connection' } }]);
    // 发卡时就在的连接照常能答
    expect((await early.call('permission.respond', { requestId: c.id, decision: 'deny' })).result).toEqual({ ok: true, applied: true });
  });
});

describe('K15 桥路径上的无人答复上限（真实 broker + 网关 + 桥分发器；复核 A1 / B1）', () => {
  // 故障：shell 命令已获「本会话允许」、命令文本里又探测不到桥触发（省略默认动作的写法，bridge-cli 帮助里就这么写）时
  // 没有桥合并授权——命令每跑一次，里面的 bridge-cli 都经管道弹一张桥卡。没人在场：桥卡挂满时限超时，bridge-cli 以退出码 2 收场，
  // 模型原样重跑（shell 命中会话授权、不再弹卡），又弹一张。桥询问不受上限管的话，这条路能一直弹到回合上限。
  const SID = 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789';
  const CMD = 'windows-notify --title 你好 --body 任务完成';
  const SHELL = req('shell', CMD, SID);
  const NOTIFY: BridgeRequest = { tool: 'windows-notify', action: 'show', args: { title: '你好', body: '任务完成' }, sessionId: SID };
  const UNATTENDED = { decision: 'deny', reason: 'timeout', cause: 'unattended' };

  /** runActive 不给 = 网关不接这个钩子（mkStack 同 index.ts 的接法，只是把 inFlight.has 换成测试可控的函数）。 */
  function rig(runActive?: (sessionId: string) => boolean) {
    const s = mkStack({ timeoutMs: 1000, askTimeoutMs: 1000, ...(runActive ? { runActive } : {}) });
    const dir = mkdtempSync(join(tmpdir(), 'dm-f13-k15-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ } });
    const psCalls: string[] = [];
    const dispatch = makeBridgeDispatcher({
      paths: new MinisPaths(dir), permissions: s.gateway,
      runPs: async script => { psCalls.push(script); return { stdout: '', stderr: '', exitCode: 0 }; },
    });
    const bridgeCards = (): string[] =>
      s.wire.of('permission.request').filter(n => n.params.req.kind === 'bridge-notify').map(n => n.params.requestId as string);
    /** 桥请求到达、没人答复：分发器同步登记卡片（没被挡的话），推进到时限后交回信封。 */
    const unanswered = async (): Promise<BridgeEnvelope> => {
      const p = dispatch(NOTIFY);
      await vi.advanceTimersByTimeAsync(1000);
      return p;
    };
    /** 模型原样重跑这条命令：shell 命中会话授权（不弹卡），命令里的桥请求没人答复。 */
    const rerun = async (): Promise<BridgeEnvelope> => {
      expect(await s.gateway.decide(SHELL)).toEqual({ decision: 'allow', via: 'session-grant' });
      return unanswered();
    };
    return { s, dispatch, psCalls, bridgeCards, unanswered, rerun };
  }

  /** 前提：用户对这条 shell 命令点过「本会话允许」，而它探测不到桥触发——卡上不带 bridgeTriggers，批准后没有任何桥合并授权。 */
  async function grantShell(s: Stack): Promise<void> {
    expect(detectBridgeTriggers(CMD), '省略动作的写法探测不到桥触发').toEqual([]);
    const a = ask(s, SHELL);
    expect(s.wire.of('permission.request', a.id)[0].params.meta.bridgeTriggers).toBeUndefined();
    expect(s.broker.respond(a.id, 'allow-session')).toEqual({ ok: true, applied: true });
    expect(await a.p).toMatchObject({ decision: 'allow', via: 'user-session' });
    expect(s.gateway.hasBridgeGrant(SID)).toBe(false);
  }

  it('run 在跑：两张桥卡超时之后，命令重跑多少次都不再弹桥卡；每次留一条 origin 为 bridge 的 unattended 审计；用户发新消息后恢复', async () => {
    vi.useFakeTimers();
    const r = rig(() => true);
    await grantShell(r.s);

    for (const env of [await r.rerun(), await r.rerun()]) {
      expect(env.ok).toBe(false);
      expect(env.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'timeout' });
      expect(env.error!.message).toContain('超时无人答复');
      expect(env.error!.message, '让模型别原样重跑').toContain('不要立刻重试');
    }
    expect(r.bridgeCards()).toHaveLength(2);

    // 第三次起：不弹卡、不等时限，直接交回
    for (let i = 0; i < 4; i++) {
      const env = await r.rerun();
      expect(env.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'timeout' });
      expect(env.error!.message).toContain('这次没有再询问');
      expect(env.error!.message).not.toContain('权限拒绝');
    }
    expect(r.bridgeCards(), '到上限之后还在弹桥卡').toHaveLength(2);
    expect(r.s.broker.pending()).toEqual([]);
    expect(r.psCalls, '没有任何一次桥操作被执行').toEqual([]);
    expect(r.s.gateway.hasBridgeGrant(SID)).toBe(false);
    expect(r.s.audit.of('permission.denied').map(a => [a.payload.origin, a.payload.req.kind, a.payload.outcome]))
      .toEqual([1, 2, 3, 4].map(() => ['bridge', 'bridge-notify', UNATTENDED]));

    // 用户回来发了新消息（chat.prompt 调 resetUnanswered）：重新询问；人在场、点了允许，桥操作才执行
    r.s.gateway.resetUnanswered(SID);
    expect(await r.s.gateway.decide(SHELL)).toEqual({ decision: 'allow', via: 'session-grant' });
    const p = r.dispatch(NOTIFY);
    expect(r.bridgeCards()).toHaveLength(3);
    expect(r.s.broker.respond(r.bridgeCards()[2], 'allow-once')).toEqual({ ok: true, applied: true });
    expect((await p).ok).toBe(true);
    expect(r.psCalls).toHaveLength(1);
  });

  it('桥卡与工具卡共用一个计数：桥卡把额度用完之后，工具发起的询问也不再弹卡', async () => {
    vi.useFakeTimers();
    const r = rig(() => true);
    await grantShell(r.s);
    await r.rerun(); await r.rerun();
    const before = r.s.wire.cards().length;
    expect(await r.s.gateway.decide(req('web-fetch', 'https://example.com/a', SID))).toEqual(UNATTENDED);
    expect(r.s.wire.cards().length).toBe(before);
  });

  it('回合结束之后（没有 run 在跑）：计数已到上限，用户在终端面板里手动跑的桥命令照常弹卡', async () => {
    vi.useFakeTimers();
    let running = true;
    const r = rig(() => running);
    await grantShell(r.s);
    await r.rerun(); await r.rerun();
    expect((await r.rerun()).error!.message).toContain('这次没有再询问');
    expect(r.bridgeCards()).toHaveLength(2);

    running = false;
    const p = r.dispatch(NOTIFY);
    expect(r.bridgeCards(), 'run 结束后桥询问不该再被挡').toHaveLength(3);
    expect(r.s.broker.respond(r.bridgeCards()[2], 'deny')).toEqual({ ok: true, applied: true });
    expect((await p).error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'user-denied' });
  });

  it.each([
    ['网关没接 runActive', undefined],
    ['runActive 返回 false', (): boolean => false],
  ] as const)('没有 run 在跑（%s）：桥卡超时不计数、不受限，工具询问也不受它影响', async (_n, runActive) => {
    vi.useFakeTimers();
    const r = rig(runActive);
    for (let i = 0; i < 4; i++) expect((await r.unanswered()).error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'timeout' });
    expect(r.bridgeCards(), '每次都照常弹卡').toHaveLength(4);
    expect(r.s.audit.of('permission.denied')).toEqual([]);
    // 四次桥超时都没有计数：工具发起的询问照常弹卡
    const a = ask(r.s, req('web-fetch', 'https://example.com/a', SID));
    r.s.broker.respond(a.id, 'deny');
    expect(await a.p).toMatchObject({ reason: 'user-denied' });
  });

  // ---- 复核 R1-1：shell 命令先于桥卡超时 ----
  // shell_execute 的 timeout_seconds 由模型给（会话授权的键只含命令文本，换个超时值仍命中授权）。它小于卡片时限时，命令先被杀掉进程树，
  // bridge-cli 随之退出、管道断开，BridgeServer 以 'requester-gone' abort 请求方的信号——桥卡按 cancelled 了结，而不是挂满时限按 timeout 了结。
  // 模型拿到的是「[命令超时被终止]」，输出里没有任何权限提示，比拿到明确拒绝更容易原样重跑。
  /** 模型原样重跑这条命令：shell 命中会话授权；桥卡弹出 300ms 后（卡片时限 1000ms）请求方断开。被上限挡住时分发器不等、当场交回。 */
  async function rerunGone(r: ReturnType<typeof rig>): Promise<BridgeEnvelope> {
    expect(await r.s.gateway.decide(SHELL)).toEqual({ decision: 'allow', via: 'session-grant' });
    const gone = new AbortController();
    const p = r.dispatch(NOTIFY, { signal: gone.signal });
    await vi.advanceTimersByTimeAsync(300);
    gone.abort('requester-gone');
    return p;
  }
  const resolvedCauses = (s: Stack, ids: string[]): unknown[] =>
    ids.map(id => s.audit.of('permission.resolved', id).map(a => [a.payload.reason, a.payload.outcome.cause]));

  it('run 在跑、请求方断开：桥卡被提前了结（cancelled / requester-gone）同样计数——两张之后命令重跑多少次都不再弹桥卡；用户发新消息后恢复', async () => {
    vi.useFakeTimers();
    const r = rig(() => true);
    await grantShell(r.s);

    for (const env of [await rerunGone(r), await rerunGone(r)]) {
      expect(env.ok).toBe(false);
      expect(env.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'cancelled' });
    }
    // 这两张卡的了结原因照实记：请求方断开，不是超时
    expect(r.bridgeCards()).toHaveLength(2);
    expect(resolvedCauses(r.s, r.bridgeCards())).toEqual([[['cancelled', 'requester-gone']], [['cancelled', 'requester-gone']]]);
    expect(r.s.audit.of('permission.denied')).toEqual([]);

    // 第三次起：不弹卡、不等到命令超时，bridge-cli 当场拿到说明（模型在命令输出里看得到）
    for (let i = 0; i < 6; i++) {
      const env = await rerunGone(r);
      expect(env.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'timeout' });
      expect(env.error!.message).toContain('这次没有再询问');
    }
    expect(r.bridgeCards(), '请求方断开的桥卡没有计数：命令每重跑一次就再弹一张').toHaveLength(2);
    expect(r.s.broker.pending()).toEqual([]);
    expect(r.psCalls, '没有任何一次桥操作被执行').toEqual([]);
    expect(r.s.gateway.hasBridgeGrant(SID)).toBe(false);
    expect(r.s.audit.of('permission.denied').map(a => [a.payload.origin, a.payload.req.kind, a.payload.outcome]))
      .toEqual([1, 2, 3, 4, 5, 6].map(() => ['bridge', 'bridge-notify', UNATTENDED]));
    // 与工具卡共用一个计数
    const before = r.s.wire.cards().length;
    expect(await r.s.gateway.decide(req('web-fetch', 'https://example.com/a', SID))).toEqual(UNATTENDED);
    expect(r.s.wire.cards().length).toBe(before);

    // 用户回来发了新消息（chat.prompt 调 resetUnanswered）：重新询问；人在场、点了允许，桥操作才执行
    r.s.gateway.resetUnanswered(SID);
    expect(await r.s.gateway.decide(SHELL)).toEqual({ decision: 'allow', via: 'session-grant' });
    const p = r.dispatch(NOTIFY, { signal: new AbortController().signal });
    expect(r.bridgeCards()).toHaveLength(3);
    expect(r.s.broker.respond(r.bridgeCards()[2], 'allow-once')).toEqual({ ok: true, applied: true });
    expect((await p).ok).toBe(true);
    expect(r.psCalls).toHaveLength(1);
  });

  it('run 在跑、请求方断开：与超时记在同一个计数上（超时 1 次 + 断开 1 次即到上限）；对已了结的卡晚到的答复说明用户在场，清零', async () => {
    vi.useFakeTimers();
    const r = rig(() => true);
    await grantShell(r.s);
    expect((await r.rerun()).error).toMatchObject({ reason: 'timeout' });
    expect((await rerunGone(r)).error).toMatchObject({ reason: 'cancelled' });
    expect((await rerunGone(r)).error!.message).toContain('这次没有再询问');
    expect(r.bridgeCards()).toHaveLength(2);

    // 用户回到窗口，点了那张已经因请求方断开而了结的卡：答复不生效（不执行、不留授权），但计数清零，下一次重跑重新询问
    expect(r.s.broker.respond(r.bridgeCards()[1], 'allow-session')).toEqual({ ok: true, applied: false, settled: { reason: 'cancelled', decision: 'deny' } });
    expect(r.psCalls).toEqual([]);
    expect(r.s.gateway.hasBridgeGrant(SID)).toBe(false);
    expect((await rerunGone(r)).error).toMatchObject({ reason: 'cancelled' });
    expect(r.bridgeCards()).toHaveLength(3);
  });

  it.each([
    ['网关没接 runActive', undefined],
    ['runActive 返回 false', (): boolean => false],
  ] as const)('没有 run 在跑（%s）、请求方断开：不计数、不受限（用户在终端面板里手动跑的命令，按了 Ctrl+C）', async (_n, runActive) => {
    vi.useFakeTimers();
    const r = rig(runActive);
    await grantShell(r.s);
    for (let i = 0; i < 4; i++) expect((await rerunGone(r)).error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'cancelled' });
    expect(r.bridgeCards(), '每次都照常弹卡').toHaveLength(4);
    expect(resolvedCauses(r.s, r.bridgeCards())).toEqual([1, 2, 3, 4].map(() => [['cancelled', 'requester-gone']]));
    expect(r.s.audit.of('permission.denied')).toEqual([]);
    // 四次断开都没有计数：工具发起的询问照常弹卡
    const a = ask(r.s, req('web-fetch', 'https://example.com/a', SID));
    r.s.broker.respond(a.id, 'deny');
    expect(await a.p).toMatchObject({ reason: 'user-denied' });
  });
});
