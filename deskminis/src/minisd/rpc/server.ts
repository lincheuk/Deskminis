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
      this.wss = new WebSocketServer({ host, port });
      this.wss.on('error', reject);
      this.wss.on('listening', () => resolve((this.wss!.address() as AddressInfo).port));
      this.wss.on('connection', ws => this.onConnection(ws));
    });
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    const conn: RpcConnection = { notify: (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })) };
    ws.on('close', () => this.clients.delete(ws));
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
