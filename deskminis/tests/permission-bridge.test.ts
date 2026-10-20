/**
 * F13：桥路径上的权限结果（真实 BridgeServer + 分发器 + 命名管道）。
 *
 * 本文件运行时不引入 F13 的新模块：标「先红」的用例在实现之前就能加载、红在行为上（设计 §7.2；先红日志 F13-impl-red）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinisPaths } from '../src/minisd/paths';
import { BridgeServer } from '../src/minisd/bridge/server';
import { encodeFrame } from '../src/minisd/bridge/frame';
import { makeBridgeDispatcher, type BridgeEnvelope, type BridgeRequest } from '../src/minisd/bridge/handlers';
import { PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import { pipeRequest, uniquePipePath } from './bridge-util';
import { heldPrompt, withDeadline, bootMinisd, cards, resolvedOf, readAudit, waitFor, settle } from './permission-fixture';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) { try { await cleanups.pop()!(); } catch { /* 收尾尽力 */ } } });

const SID = 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789';
const CLIP_GET: BridgeRequest = { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: SID };

type Dispatch = (req: BridgeRequest, ctl?: { signal?: AbortSignal }) => Promise<BridgeEnvelope>;

/** 真实 BridgeServer + 真实分发器 + 真网关（旧式询问函数，测试决定何时答复）+ 可数的假 PowerShell。 */
async function bridgeRig() {
  const held = heldPrompt();
  const gateway = new PermissionGatewayImpl(held.prompt);
  const psCalls: string[] = [];
  const dispatch = makeBridgeDispatcher({
    paths: new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-f13-bridge-'))), permissions: gateway,
    runPs: async script => { psCalls.push(script); return { stdout: 'clip', stderr: '', exitCode: 0 }; },
  }) as Dispatch;
  // 分发器包一层：记下每次交回的信封，以及「这次分发结束了」的 promise
  const envelopes: BridgeEnvelope[] = [];
  const runs: Promise<void>[] = [];
  const wrapped: Dispatch = (req, ctl) => {
    const p = dispatch(req, ctl);
    runs.push(p.then(env => { envelopes.push(env); }, () => undefined));
    return p;
  };
  const pipePath = uniquePipePath();
  const server = new BridgeServer(wrapped as never);
  await server.listen(pipePath);
  cleanups.push(() => server.close());
  return { held, gateway, psCalls, envelopes, runs, pipePath };
}

/** 发完请求帧就不管应答的管道客户端（测试决定何时 destroy）。 */
function rawClient(pipePath: string, req: unknown): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(encodeFrame(req), () => { socket.off('error', reject); socket.on('error', () => undefined); resolve(socket); }));
  });
}

describe('先红 B1：桥请求方在等卡期间退出，之后的批准不执行', () => {
  it('客户端断开后再批准：PowerShell 0 次；信封是 cancelled；同一请求方重发会重新询问', async () => {
    const rig = await bridgeRig();
    const socket = await rawClient(rig.pipePath, CLIP_GET);
    await rig.held.untilCalled(1);
    socket.destroy();
    // 等分发器因请求方断开而交回信封（上限 3 秒；等不到也往下走——那正是要测出来的故障）
    await withDeadline(rig.runs[0], 3000, '分发器交回信封').catch(() => undefined);
    // 晚到的批准
    rig.held.answer('allow-once');
    await withDeadline(rig.runs[0], 5000, '分发器收尾');

    expect(rig.psCalls.length, '请求方已经走了，批准不该再执行桥操作').toBe(0);
    expect(rig.envelopes.length).toBe(1);
    expect(rig.envelopes[0].ok).toBe(false);
    expect(rig.envelopes[0].error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'cancelled' });

    // 没有留下任何授权：同一请求方重发，重新询问
    const again = pipeRequest(rig.pipePath, CLIP_GET);
    await rig.held.untilCalled(2);
    rig.held.answer('deny');
    const env = await again;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PERMISSION_DENIED');
    expect(rig.psCalls.length).toBe(0);
  }, 20000);
});

// =================================================================================================================
// 以下是先红之外的用例（实现之后补写）。
// =================================================================================================================

describe('B2 BridgeServer：请求方的取消信号', () => {
  /** 分发器挂着，测试决定何时交回；记下每次收到的 ctl。 */
  async function heldServer() {
    const ctls: ({ signal?: AbortSignal } | undefined)[] = [];
    const replies: ((env: BridgeEnvelope) => void)[] = [];
    let waiters: (() => void)[] = [];
    const server = new BridgeServer((req, ctl) => new Promise<BridgeEnvelope>(resolve => {
      ctls.push(ctl);
      replies.push(resolve);
      for (const w of waiters) w();
      waiters = [];
      void req;
    }));
    const pipePath = uniquePipePath();
    await server.listen(pipePath);
    cleanups.push(() => server.close());
    const untilDispatched = (n: number): Promise<void> =>
      ctls.length >= n ? Promise.resolve() : withDeadline(new Promise<void>(r => { waiters.push(r); }), 3000, `分发器第 ${n} 次被调`);
    return { server, ctls, replies, pipePath, untilDispatched };
  }
  const abortedOf = (signal: AbortSignal): Promise<void> =>
    signal.aborted ? Promise.resolve() : new Promise(r => signal.addEventListener('abort', () => r(), { once: true }));

  it('客户端没等应答就断开：signal abort，reason 是 requester-gone', async () => {
    const s = await heldServer();
    const socket = await rawClient(s.pipePath, CLIP_GET);
    await s.untilDispatched(1);
    const signal = s.ctls[0]!.signal!;
    expect(signal.aborted, '请求方还连着：不触发').toBe(false);
    socket.destroy();
    await withDeadline(abortedOf(signal), 3000, '连接关闭传到分发器');
    expect(signal.reason).toBe('requester-gone');
    s.replies[0]({ ok: true, tool: 't', action: 'a', timestamp: 0 });
  });

  it('正常应答之后客户端关闭：不触发（已应答不算断开）', async () => {
    const s = await heldServer();
    const reply = pipeRequest(s.pipePath, CLIP_GET);
    await s.untilDispatched(1);
    const signal = s.ctls[0]!.signal!;
    s.replies[0]({ ok: true, tool: 'windows-clipboard', action: 'get', data: { text: 'x' }, timestamp: 0 });
    expect((await reply).ok).toBe(true);
    // 关掉服务：net.Server 要等所有连接都关闭才回调，所以这之后那条连接的 close 一定已经处理过
    await s.server.close();
    await settle();
    expect(signal.aborted).toBe(false);
  });
});

describe('B3 真实 minisd + 真实管道：请求方断开，卡片当场作废', () => {
  it.skipIf(process.platform !== 'win32')('卡按 cancelled / requester-gone 了结；之后的 allow-once 不生效', async () => {
    const m = await bootMinisd(cleanups);
    expect(m.bridgePipe).toBeTruthy();
    const sid = (await m.c.call('chat.sessions.create', {})).result.id as string;
    const socket = await rawClient(m.bridgePipe!, { ...CLIP_GET, sessionId: sid });
    await waitFor('桥的权限卡', () => cards(m.c, sid).length > 0);
    const card = cards(m.c, sid)[0].params;
    expect(card.req.kind).toBe('bridge-clipboard-read');
    const requestId = card.requestId as string;

    socket.destroy();
    // 权限卡的兜底时限是 60 秒：几秒内了结只能是断开触发的
    await waitFor('这张卡的 permission.resolved', () => resolvedOf(m.c, requestId).length > 0, 5000);
    const resolved = resolvedOf(m.c, requestId);
    expect(resolved.map(n => n.params.reason)).toEqual(['cancelled']);
    expect(resolved[0].params.outcome).toMatchObject({ decision: 'deny', reason: 'cancelled', cause: 'requester-gone', requestId });
    const rows = readAudit(m.dataDir).filter(r => r.eventType === 'permission.resolved' && r.payload.requestId === requestId);
    expect(rows.map(r => [r.payload.reason, r.payload.outcome.cause])).toEqual([['cancelled', 'requester-gone']]);

    const late = await m.c.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(late.result).toEqual({ ok: true, applied: false, settled: { reason: 'cancelled', decision: 'deny' } });
    // 没有留下任何授权：同一会话再发一次桥请求，仍然弹卡
    const again = pipeRequest(m.bridgePipe!, { ...CLIP_GET, sessionId: sid });
    await waitFor('第二张桥卡', () => cards(m.c, sid).length > 1);
    await m.c.call('permission.respond', { requestId: cards(m.c, sid)[1].params.requestId, decision: 'deny' });
    const env = await again;
    expect(env.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'user-denied', message: '权限拒绝: windows-clipboard get' });
  }, 30000);
});
