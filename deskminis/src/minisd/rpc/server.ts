import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

export interface RpcConnection { notify(method: string, params: unknown): void }
export interface RpcMethods { [method: string]: (params: any, conn: RpcConnection) => Promise<unknown> | unknown }

export class RpcServer {
  private wss: WebSocketServer | undefined;
  private clients = new Set<WebSocket>();

  constructor(private methods: RpcMethods) {}

  listen(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host, port });
      this.wss = wss;
      let listening = false;
      // 监听前的错误 = 真正的绑定失败，需要 reject；监听后出现的服务器级错误不应崩溃守护进程
      wss.on('error', err => { if (!listening) reject(err); });
      wss.on('listening', () => { listening = true; resolve((wss.address() as AddressInfo).port); });
      wss.on('connection', ws => this.onConnection(ws));
    });
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    const conn: RpcConnection = { notify: (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })) };
    ws.on('close', () => this.clients.delete(ws));
    // ws 会把 receiver/协议层错误重新抛在 WebSocket 实例上：没有监听器则变成未捕获异常并杀死整个守护进程
    ws.on('error', () => { this.clients.delete(ws); try { ws.terminate(); } catch { /* 已关闭 */ } });
    ws.on('message', async raw => {
      let msg: { id?: number; method?: string; params?: unknown };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
      if (!msg.method) return;
      const handler = this.methods[msg.method];
      if (!handler) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未知方法: ${msg.method}` } }));
        return;
      }
      try {
        const result = await handler(msg.params ?? {}, conn);
        if (msg.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      } catch (e) {
        if (msg.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e instanceof Error ? e.message : e) } }));
      }
    });
  }

  broadcast(method: string, params: unknown): void {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const ws of this.clients) { try { ws.send(frame); } catch { /* 断开连接忽略 */ } }
  }

  close(): Promise<void> {
    return new Promise(resolve => { if (!this.wss) return resolve(); for (const c of this.clients) c.terminate(); this.wss.close(() => resolve()); });
  }
}
