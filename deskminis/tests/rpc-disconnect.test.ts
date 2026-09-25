/**
 * W2b-3 · rpc 断线统一结算（止血设计稿 §3 第 7 条「rpc.onLost(handler) 专门 API」；侦察 renderer.md「W2b-disconnect」；
 * cross.md S20）。
 *
 * 旧实现只挂了 onopen / onerror / onmessage，没有 onclose：minisd 在握手之后崩了（或被杀、端口被关），
 *  - 在途的 call 永远不结算——停止键一直亮、await 它的界面动作永远等下去；
 *  - 浏览器的 WebSocket.send 在 CLOSING / CLOSED 状态下不抛错、静默丢弃，断线之后发起的 call 同样永远挂着；
 *  - 界面没有任何办法知道连接没了。
 *
 * 本文件钉：
 *  ① onclose 一到，在途的 call 全部以「与后台服务的连接已断开」拒绝；
 *  ② 断线之后的新 call 立即拒绝，不再碰 socket；
 *  ③ onLost 的订阅者只被通知一次（error 与 close 先后到、close 重复到都一样）；
 *  ④ 握手结构不动：握手期间排队的 call 在 open 之后照常补发（renderer-rpc-connecting 的回归网另在那边）；
 *  ⑤ 真 socket（ws 包的客户端与服务端，已在 dependencies，零新依赖）：服务端掐断连接后 1 秒内在途 call 被拒；
 *     首次连接就连不上（端口没人听）时 connect 报错，断线通知照样发出——横幅在首启失败时也要出现。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import type { AddressInfo } from 'node:net';
import { RpcClient } from '../src/renderer/src/rpc';

const LOST = '与后台服务的连接已断开';

/** 可控假 WebSocket：照 renderer-rpc-connecting 的那个抄，多一个 onclose 字段。 */
class FakeWebSocket {
  static last: FakeWebSocket | undefined;
  sent: string[] = [];
  opened = false;
  onopen: (() => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(data: string): void {
    if (!this.opened) throw new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
    this.sent.push(data);
  }
  open(): void { this.opened = true; this.onopen?.(); }
  /** 浏览器断线时先 error 后 close（异常断开）；用可选调用：没挂处理器时什么也不发生，与浏览器一致 */
  fail(): void { this.onerror?.({}); this.onclose?.({}); }
}

const g = globalThis as any;
let savedWs: unknown; let savedWindow: unknown;
beforeEach(() => {
  savedWs = g.WebSocket; savedWindow = g.window;
  g.WebSocket = FakeWebSocket;
  g.window = { deskminis: { minisdInfo: async () => ({ port: 1234, token: 'T' }) } };
  FakeWebSocket.last = undefined;
});
afterEach(() => { g.WebSocket = savedWs; g.window = savedWindow; });

const tick = () => new Promise(r => setTimeout(r, 0));

/** 等 p 结算，最多 ms 毫秒：结算了返回 { status, value/reason }，没结算返回 'pending'（不让测试挂死）。 */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown } | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'pending'>(r => { timer = setTimeout(() => r('pending'), ms); });
  const settled = p.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
  try { return await Promise.race([settled, timeout]); } finally { clearTimeout(timer); }
}

async function connected(): Promise<{ c: RpcClient; ws: FakeWebSocket }> {
  const c = new RpcClient();
  const connecting = c.connect();
  await tick();
  const ws = FakeWebSocket.last!;
  ws.open();
  await connecting;
  return { c, ws };
}

describe('W2b-3 · 断线时在途的 call 统一结算', () => {
  it('onclose 一到，两个没回包的 call 都以「与后台服务的连接已断开」拒绝（不再永远挂着）', async () => {
    const { c, ws } = await connected();
    const a = c.call('chat.sessions.list');
    const b = c.call('chat.prompt', { sessionId: 'A', text: 'x' });
    await tick();
    expect(ws.sent).toHaveLength(2);

    ws.onclose?.({});
    const [ra, rb] = await Promise.all([settleWithin(a, 50), settleWithin(b, 50)]);
    expect(ra, '断线后在途 call 必须结算，不能挂着').not.toBe('pending');
    expect(rb, '断线后在途 call 必须结算，不能挂着').not.toBe('pending');
    for (const r of [ra, rb]) {
      if (r === 'pending') continue;
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect((r.reason as Error).message).toBe(LOST);
    }
  });

  it('断线之后的新 call 立即拒绝，而且不再碰 socket（浏览器对已关闭的 socket send 静默丢弃，不拒绝就永远挂着）', async () => {
    const { c, ws } = await connected();
    ws.onclose?.({});
    const before = ws.sent.length;
    const r = await settleWithin(c.call('chat.sessions.list'), 50);
    expect(r, '断线后的新 call 必须立即结算').not.toBe('pending');
    if (r !== 'pending') {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect((r.reason as Error).message).toBe(LOST);
    }
    expect(ws.sent).toHaveLength(before);
  });

  it('onLost 的订阅者只通知一次：error 与 close 先后到、close 再到一次，都只算一次断线', async () => {
    const { c, ws } = await connected();
    const reasons: string[] = [];
    c.onLost(r => { reasons.push(r); });
    ws.fail();
    ws.onclose?.({});
    await tick();
    expect(reasons).toEqual([LOST]);
  });

  it('一个订阅者抛错不拦住别的订阅者，也不让结算半途而废', async () => {
    const { c, ws } = await connected();
    const seen: string[] = [];
    c.onLost(() => { throw new Error('订阅者自己坏了'); });
    c.onLost(r => { seen.push(r); });
    const p = c.call('chat.sessions.list');
    await tick();
    ws.fail();
    const r = await settleWithin(p, 50);
    expect(r).not.toBe('pending');
    expect(seen).toEqual([LOST]);
  });

  it('回归：握手期间排队的 call 在 open 之后照常补发、正常收到响应（握手结构一行不动）', async () => {
    const c = new RpcClient();
    const connecting = c.connect();
    const inflight = c.call('chat.sessions.list');
    await tick();
    const ws = FakeWebSocket.last!;
    expect(ws.sent).toHaveLength(0);
    ws.open();
    await connecting;
    await tick();
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]);
    ws.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: ['ok'] }) });
    await expect(inflight).resolves.toEqual(['ok']);
  });
});

describe('W2b-3 · 真 socket：服务端掐断与首次连不上', () => {
  let wss: WebSocketServer | undefined;
  afterEach(async () => {
    const s = wss; wss = undefined;
    if (s) await new Promise<void>(r => s.close(() => r()));
  });

  async function listen(onFrame: (server: WebSocketServer) => void): Promise<number> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss = server;
    await new Promise<void>(r => server.once('listening', () => r()));
    server.on('connection', sock => sock.on('message', () => onFrame(server)));
    return (server.address() as AddressInfo).port;
  }

  /** 模拟 minisd 崩溃：服务端收到帧不回包，直接掐断全部连接（进程没了，没有 close 帧）。 */
  async function crashingServerClient(): Promise<RpcClient> {
    const port = await listen(server => { for (const s of server.clients) s.terminate(); });
    g.WebSocket = WsClient;
    g.window = { deskminis: { minisdInfo: async () => ({ port, token: 'T' }) } };
    return new RpcClient();
  }

  it('服务端收到帧不回包、直接掐断全部连接：1 秒内在途 call 被拒；之后的新 call 立即被拒', async () => {
    const c = await crashingServerClient();
    await c.connect();

    const r = await settleWithin(c.call('chat.sessions.list'), 1000);
    expect(r, '服务端掐断后 1 秒内在途 call 必须结算').not.toBe('pending');
    if (r !== 'pending') {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect((r.reason as Error).message).toBe(LOST);
    }
    const again = await settleWithin(c.call('chat.sessions.list'), 50);
    expect(again, '断线后的新 call 必须立即结算').not.toBe('pending');
  });

  it('同一场景：onLost 的订阅者恰好收到一次断线', async () => {
    const c = await crashingServerClient();
    const reasons: string[] = [];
    c.onLost(r => { reasons.push(r); });
    await c.connect();
    await settleWithin(c.call('chat.sessions.list'), 1000);
    expect(reasons).toEqual([LOST]);
  });

  it('首次连接就连不上（端口没人听）：connect 报错，断线通知照样发出——首启失败时横幅也要出现', async () => {
    const port = await listen(() => {});
    await new Promise<void>(r => wss!.close(() => r()));
    wss = undefined;
    g.WebSocket = WsClient;
    g.window = { deskminis: { minisdInfo: async () => ({ port, token: 'T' }) } };
    const c = new RpcClient();
    const reasons: string[] = [];
    c.onLost(r => { reasons.push(r); });
    await expect(c.connect()).rejects.toThrow('WebSocket 连接失败');
    for (let t = 0; t < 1000 && reasons.length === 0; t += 10) await new Promise(r => setTimeout(r, 10));
    expect(reasons).toEqual([LOST]);
  });
});
