type Handler = (params: any) => void;

export class RpcClient {
  private ws: WebSocket | undefined;
  private idc = 0;
  private pending = new Map<number, (v: any) => void>();
  private handlers = new Map<string, Set<Handler>>();

  async connect(): Promise<void> {
    const bridge = (window as any).deskminis;
    // minisd 要求 per-run token（否则任意网页都能连上本地端口驱动 agent）。
    // 老的 minisdPort() 只在 minisdInfo 不存在时兜底。
    let port: number;
    let token: string | undefined;
    if (typeof bridge?.minisdInfo === 'function') {
      const info = await bridge.minisdInfo();
      port = info?.port;
      token = info?.token;
    } else {
      port = await bridge.minisdPort();
    }
    const url = token
      ? `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
      : `ws://127.0.0.1:${port}`;
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      this.ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined && this.pending.has(msg.id)) { this.pending.get(msg.id)!(msg); this.pending.delete(msg.id); }
        else if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
      };
    });
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    const id = ++this.idc;
    return new Promise((resolve, reject) => {
      this.pending.set(id, msg => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  on(method: string, h: Handler): void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(h);
  }

  // M2d Task 3：组件卸载时摘订阅（TerminalPanel.vue onUnmounted）
  off(method: string, h: Handler): void {
    this.handlers.get(method)?.delete(h);
  }
}

export const rpc = new RpcClient();
