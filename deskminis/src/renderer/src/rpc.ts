type Handler = (params: any) => void;

export class RpcClient {
  private ws: WebSocket | undefined;
  private idc = 0;
  private pending = new Map<number, (v: any) => void>();
  private handlers = new Map<string, Set<Handler>>();

  async connect(): Promise<void> {
    const port = await (window as any).deskminis.minisdPort();
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
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
}

export const rpc = new RpcClient();
