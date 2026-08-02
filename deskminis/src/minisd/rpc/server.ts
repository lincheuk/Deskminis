import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type AuthMode = 'local' | 'pairing' | 'remote';

export interface RpcConnection { notify(method: string, params: unknown): void; authMode: AuthMode; peerFingerprint?: string; remoteAddress?: string }
export interface RpcMethods { [method: string]: (params: any, conn: RpcConnection) => Promise<unknown> | unknown }

export type AdditionalVerifyResult = { ok: true; authMode: AuthMode; peerFingerprint?: string } | { ok: false };
export type AdditionalVerify = (info: { req: IncomingMessage; url: URL }) => Promise<AdditionalVerifyResult> | AdditionalVerifyResult;

export class RpcServer {
  private wss: WebSocketServer | undefined;
  private clients = new Set<WebSocket>();
  /** M3c 命门 2 入站注册表：peerFingerprint → 活跃连接计数（open++/close--） */
  private inboundRemote = new Map<string, number>();

  /** authToken：每次启动新生成，只经 IPC 交给自己的渲染进程。浏览器页面拿不到它。
   *  additionalVerify（可选）：远程客户端鉴权回调；返回 {ok:true,authMode} 放行并标记连接模式，{ok:false} 拒绝。 */
  constructor(private methods: RpcMethods, private authToken: string, private additionalVerify?: AdditionalVerify) {}

  listen(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      // WebSocket 不受同源策略约束：没有这道门，用户访问的任意网页都能连上
      // ws://127.0.0.1:<port>，发 chat.prompt 驱动 agent，还能收到广播的
      // permission.request 并自己回 allow-session —— 即自我批准执行命令。
      const wss = new WebSocketServer({
        host, port,
        verifyClient: (info, cb) => {
          const url = new URL(info.req.url ?? '/', 'ws://127.0.0.1');
          const origin = info.req.headers.origin;
          // 老路径（评审缺口修订：token + 回环源地址双条件）：
          //   MINISD_HOST=0.0.0.0 后老 token 可能被嗅探；local 的「本机」语义由 socket.remoteAddress 保证。
          //   非回环源地址的老 token 一律 401，不落入 additionalVerify——老 token 语义就是本机，远程走 PASETO/配对码。
          const tokenMatch = url.searchParams.get('token') === this.authToken;
          const remoteAddr = info.req.socket.remoteAddress;
          const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
          if (tokenMatch) {
            if (!isLoopback) { cb(false, 401, 'Unauthorized'); return; }
            const originOk = origin === undefined || origin === 'file://' || /^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
            if (!originOk) { cb(false, 401, 'Unauthorized'); return; }
            // 实测 ws@8.21.1：verifyClient 第四参 userProps 不会合并到 connection 事件的 req 上。
            // 改为直接挂到 info.req（同一 IncomingMessage 实例会在 connection 事件里作为第二参再次出现）。
            (info.req as any).__authMode = 'local' as AuthMode;
            cb(true, 200);
            return;
          }
          // 新路径：additionalVerify（paseto / pairingCode）→ pairing/remote 模式
          if (this.additionalVerify) {
            const r = this.additionalVerify({ req: info.req, url });
            const settle = (res: AdditionalVerifyResult) => {
              if (!res.ok) { cb(false, 401, 'Unauthorized'); return; }
              // Origin 白名单对远程关闭：WS 本来就不关同源，Origin 防线本来只针对
              // 「浏览器任意网页能偷连本机 token」——远程客户端本来就不是浏览器页（设计 §3.2 原文）
              (info.req as any).__authMode = res.authMode;
              // M3c：remote 模式携带 peerFingerprint（sync.hello 找 authKey + presence 用）
              if (res.peerFingerprint) (info.req as any).__peerFingerprint = res.peerFingerprint;
              cb(true, 200);
            };
            if (r instanceof Promise) r.then(settle).catch(() => cb(false, 401, 'Unauthorized'));
            else settle(r);
            return;
          }
          cb(false, 401, 'Unauthorized');
        },
      });
      this.wss = wss;
      let listening = false;
      // 监听前的错误 = 真正的绑定失败，需要 reject；监听后出现的服务器级错误不应崩溃守护进程
      wss.on('error', err => { if (!listening) reject(err); });
      wss.on('listening', () => { listening = true; resolve((wss.address() as AddressInfo).port); });
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
    });
  }

  private onConnection(ws: WebSocket, req?: IncomingMessage): void {
    // verifyClient 第四参（WebSocketServer 透传的 userProps）承载 authMode；老路径/无 additionalVerify 默认 local
    const authMode: AuthMode = (req as any)?.__authMode ?? 'local';
    const peerFingerprint: string | undefined = (req as any)?.__peerFingerprint;
    const remoteAddress: string | undefined = req?.socket.remoteAddress;
    this.clients.add(ws);
    // M3c 命门 2：入站注册表 open++（remote 模式有 peerFingerprint 才记）
    if (peerFingerprint) {
      this.inboundRemote.set(peerFingerprint, (this.inboundRemote.get(peerFingerprint) ?? 0) + 1);
    }
    const conn: RpcConnection = { authMode, peerFingerprint, remoteAddress, notify: (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })) };
    ws.on('close', () => {
      this.clients.delete(ws);
      // M3c 命门 2：入站注册表 close--
      if (peerFingerprint) {
        const count = (this.inboundRemote.get(peerFingerprint) ?? 0) - 1;
        if (count <= 0) this.inboundRemote.delete(peerFingerprint);
        else this.inboundRemote.set(peerFingerprint, count);
      }
    });
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

  /** M3c 命门 2：对端指纹是否有活跃入站连接（出站 ∪ 入站合并两源的入站源）。 */
  isInboundOnline(peerFingerprint: string): boolean {
    return (this.inboundRemote.get(peerFingerprint) ?? 0) > 0;
  }

  broadcast(method: string, params: unknown): void {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const ws of this.clients) { try { ws.send(frame); } catch { /* 断开连接忽略 */ } }
  }

  close(): Promise<void> {
    return new Promise(resolve => { if (!this.wss) return resolve(); for (const c of this.clients) c.terminate(); this.wss.close(() => resolve()); });
  }
}
