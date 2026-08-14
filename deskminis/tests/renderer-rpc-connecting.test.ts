import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RpcClient } from '../src/renderer/src/rpc';

/** 可控假 WebSocket：send 在 open 前抛真浏览器同款错误，暴露「握手期间直接 send」的竞态。 */
class FakeWebSocket {
  static last: FakeWebSocket | undefined;
  sent: string[] = [];
  opened = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(data: string): void {
    if (!this.opened) throw new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
    this.sent.push(data);
  }
  open(): void { this.opened = true; this.onopen?.(); }
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

describe('RpcClient 握手期间的 call 排队（真机冒烟逮到的 CONNECTING 竞态）', () => {
  it('connect 未完成时发起的 call 不抛错，open 后自动补发并正常收到响应', async () => {
    const c = new RpcClient();
    const connecting = c.connect();
    // 等 minisdInfo 的微任务链走完、FakeWebSocket 实例化（此刻握手仍未完成）
    await new Promise(r => setTimeout(r, 0));
    const ws = FakeWebSocket.last!;
    expect(ws.opened).toBe(false);

    // 组件 onMounted 抢跑的首批调用：修复前这里同步 send 抛 InvalidStateError
    const inflight = c.call('chat.sessions.list');
    await new Promise(r => setTimeout(r, 0));
    expect(ws.sent).toHaveLength(0); // 排队中，未发出、也没抛

    ws.open();
    await connecting;
    await new Promise(r => setTimeout(r, 0));
    expect(ws.sent).toHaveLength(1); // open 后自动补发
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.method).toBe('chat.sessions.list');

    ws.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: ['ok'] }) });
    await expect(inflight).resolves.toEqual(['ok']);
  });

  it('connect 完成后的 call 立即发出（排队不拖累正常路径）', async () => {
    const c = new RpcClient();
    const connecting = c.connect();
    await new Promise(r => setTimeout(r, 0));
    FakeWebSocket.last!.open();
    await connecting;

    const p = c.call('control.status');
    await new Promise(r => setTimeout(r, 0));
    expect(FakeWebSocket.last!.sent).toHaveLength(1);
    const frame = JSON.parse(FakeWebSocket.last!.sent[0]);
    FakeWebSocket.last!.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { syncPaused: false } }) });
    await expect(p).resolves.toEqual({ syncPaused: false });
  });
});
