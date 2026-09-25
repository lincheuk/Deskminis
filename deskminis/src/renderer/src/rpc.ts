type Handler = (params: any) => void;

/** W2b-3：连接断了之后，在途与新发起的 call 都以这句拒绝（设计稿 §3 第 7 条）。 */
const LOST = '与后台服务的连接已断开';

export class RpcClient {
  private ws: WebSocket | undefined;
  private idc = 0;
  private pending = new Map<number, (v: any) => void>();
  private handlers = new Map<string, Set<Handler>>();
  /** 握手完成信号：connect() 在**第一个 await 之前**就赋值。组件 onMounted 的首批 call 可能赶在
   *  握手完成前触发，不排队直接 send 会撞 CONNECTING 态抛 InvalidStateError（真机冒烟逮到）。
   *  X 波订正：此前这行注释是假话——ready 在 await minisdInfo() 之后才赋值，那几毫秒里的 call
   *  走 sendNow() 撞 this.ws 未建（TypeError）。子组件 onMounted 先于父组件跑，「先于 init 的 call」
   *  是生命周期事实，不是编程错误。 */
  private ready: Promise<void> | undefined;
  /** W2b-3：socket 关了（minisd 崩溃、被杀、端口被关）。只置一次，不重连也不重放（W6 才有代次与重连）：
   *  之后的 call 立即拒绝——浏览器对 CLOSING / CLOSED 的 socket send 不抛错、静默丢弃，不主动拒绝的话它会永远挂着。
   *  不按 readyState 判：握手期的假 socket（renderer-rpc-connecting）没有这个字段。 */
  private lost = false;
  private lostHandlers = new Set<(reason: string) => void>();

  async connect(): Promise<void> {
    // 整段包成一个 promise 同步挂到 ready：minisdInfo 的 IPC 往返也算握手的一部分，
    // 期间到达的 call 一律排队（与 CONNECTING 竞态同源、同一种修法）。
    this.ready = (async () => {
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
        // W2b-3：断线只认 close——浏览器异常断开是先 error 后 close，首次就连不上也一样，横幅在首启失败时同样出现
        this.ws.onclose = () => this.markLost();
        this.ws.onmessage = ev => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== undefined && this.pending.has(msg.id)) { this.pending.get(msg.id)!(msg); this.pending.delete(msg.id); }
          else if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
        };
      });
    })();
    await this.ready;
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    const sendNow = (): Promise<T> => {
      if (this.lost) return Promise.reject(new Error(LOST));
      const id = ++this.idc;
      return new Promise((resolve, reject) => {
        this.pending.set(id, msg => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
        this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    };
    // 握手期间到达的调用排队等 open 再发；未 connect 过则维持原行为（ws! 抛错，暴露编程错误）
    return this.ready ? this.ready.then(sendNow) : sendNow();
  }

  on(method: string, h: Handler): void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(h);
  }

  // M2d Task 3：组件卸载时摘订阅（TerminalPanel.vue onUnmounted）
  off(method: string, h: Handler): void {
    this.handlers.get(method)?.delete(h);
  }

  /** W2b-3：订阅断线（store 在 connect 之前挂，横幅靠它出现）。只通知一次。 */
  onLost(h: (reason: string) => void): void {
    this.lostHandlers.add(h);
  }

  /** 断线结算：在途的 call 用 { error } 结算（与服务端报错同一条路：reject 出 LOST），再通知订阅者。
   *  只生效一次——close 重复到、error 与 close 先后到，都只算一次断线。 */
  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    const settles = [...this.pending.values()];
    this.pending.clear();
    for (const settle of settles) settle({ error: { message: LOST } });
    for (const h of this.lostHandlers) {
      try { h(LOST); } catch { /* 一个订阅者坏了不拦别的：横幅照样要出现 */ }
    }
  }
}

export const rpc = new RpcClient();
