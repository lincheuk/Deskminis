import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EventLog } from './event-log';

export type AuthMode = 'local' | 'pairing' | 'remote';

export interface RpcConnection {
  notify(method: string, params: unknown): void; authMode: AuthMode; peerFingerprint?: string; remoteAddress?: string;
  /** W2b-8：对端在 sync.hello 里声明的协议版本与能力位（应答端鉴权通过后才写）。一个连接一份，随连接而灭；
   *  W5c 在 sync.pull/sync.push 里按它过滤。用结构类型而不 import sync/wire 的 SyncPeerInfo：rpc 层不依赖 sync 层。 */
  syncPeer?: { readonly protocolVersion: number; readonly caps: Readonly<Record<string, boolean>> };
  /** F11A：这条连接的收发是否全部走加密通道（?ch=1 握手之后）。回环上还留着明文的 ?paseto= remote 路径，
   *  附件同步的处理器据此只认加密通道上的连接。 */
  readonly encrypted?: boolean;
  /** W3-sec4：这一次调用的回包发出去之后关掉连接。remote.pair.complete 用（配对阶段的连接随后就不留了）；
   *  业务守卫发现对端已取消配对时也用（拒绝的回包要送到）。 */
  closeAfterReply?(): void;
  /** F13：连接序号，本引擎进程内从 1 起单调递增，在 attach 里创建连接对象时分配（加密通道是握手完成那一刻）。
   *  权限卡据此只接受「发卡时已经连着的连接」的答复。可选：手写连接替身的调用方不用填（没有序号按不可答复处理）。 */
  seq?: number;
}

/** pairing 连接的时限缺省值：与配对码有效期（remote/pairing.ts 的 PAIRING_CODE_TTL_S，300 秒）一致。rpc 层不依赖 remote 层，这里写数值。 */
export const PAIRING_CONN_IDLE_MS = 300_000;
export interface RpcMethods { [method: string]: (params: any, conn: RpcConnection) => Promise<unknown> | unknown }

export type AdditionalVerifyResult = { ok: true; authMode: AuthMode; peerFingerprint?: string } | { ok: false };

/** 加密通道（W3-sec6）：握手之后每一帧的加解密。结构类型，rpc 层不依赖 remote 层（实现在 remote/channel.ts）。 */
export interface ChannelCipher { seal(text: string): Uint8Array; open(frame: Uint8Array): string }
export type ChannelAccept = { ok: true; peerFingerprint: string; reply: string; cipher: ChannelCipher } | { ok: false };

/** 认证配对（F11C）：?pair=2 连接上的一次握手。结构类型，rpc 层不依赖 remote 层（实现在 remote/pair-host.ts）。 */
export interface PairingStep { reply?: string; end?: boolean }
export interface PairingSession {
  /** 同步处理一帧文本；抛错等同 { end: true }。 */
  onFrame(text: string): PairingStep;
  /** 握手结束（正常、失败、超时、对端断开）时恰好调一次。 */
  onClose(): void;
}
export interface PairingAcceptor {
  /** verifyClient 阶段：现在收不收新的配对连接。不扣尝试次数，不得抛错。 */
  admit(): boolean;
  /** 连接建立后开会话；状态已变返回 undefined，调用方关连接。 */
  open(info: { remoteAddress?: string }): PairingSession | undefined;
}

/** 远程鉴权回调。带 channel 的（createAdditionalVerify 产出的就带）才受理 ?ch=1 的加密通道连接；
 *  带 pairing 的才受理 ?pair=2 的认证配对连接（F11C）。 */
export type AdditionalVerify = ((info: { req: IncomingMessage; url: URL }) => Promise<AdditionalVerifyResult> | AdditionalVerifyResult)
  & { channel?: (hello: string) => ChannelAccept; pairing?: PairingAcceptor };

/** ?ch=1 连上之后多久之内必须握完手（W3-sec6）。 */
export const CHANNEL_HANDSHAKE_MS = 10_000;

/** ?pair=2 连接每一步的时限与单帧上限（F11C）。rpc 层不依赖 remote 层，这里写数值；
 *  与 remote/pair-proto.ts 的 PAIR_STEP_TIMEOUT_MS、PAIR_MAX_FRAME_BYTES 相等（tests/pair-proto.test.ts 钉住）。 */
export const PAIR_STEP_MS = 10_000;
export const PAIR_FRAME_MAX_BYTES = 2048;

/** 每条连接：它的 RpcConnection 与发一帧文本的办法（加密通道上先加密再发）。 */
interface Client { conn: RpcConnection; send(text: string): void }

export class RpcServer {
  private wss: WebSocketServer | undefined;
  /** 每条连接与它的 RpcConnection（W3-sec4：广播要按 authMode 挑、取消配对要按指纹找） */
  private clients = new Map<WebSocket, Client>();
  /** M3c 命门 2 入站注册表：peerFingerprint → 活跃连接计数（open++/close--） */
  private inboundRemote = new Map<string, number>();
  /** F11C：正在握手的 ?pair=2 连接。它们不进 clients（收不到广播、调不了方法），单独记着只为关停时一并终止 */
  private pairSockets = new Set<WebSocket>();
  /** F13：已分配的最大连接序号（还没有过连接时是 0）。 */
  private connSeq = 0;

  /** authToken：每次启动新生成，只经 IPC 交给自己的渲染进程。浏览器页面拿不到它。
   *  additionalVerify（可选）：远程客户端鉴权回调；返回 {ok:true,authMode} 放行并标记连接模式，{ok:false} 拒绝。 */
  constructor(
    private methods: RpcMethods, private authToken: string, private additionalVerify?: AdditionalVerify,
    // F06：events 给了，广播就在它那里入序（帧顶层多一个 ev，并留进保留窗口）；不给则帧与以前逐字相同
    private opts: { pairingIdleMs?: number; channelHandshakeMs?: number; pairStepMs?: number; events?: EventLog } = {},
  ) {}

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
          // 加密通道（W3-sec6）：URL 里不带任何秘密，连上之后第一帧握手；握手前这条连接什么也调不了、什么也收不到
          if (url.searchParams.get('ch') === '1') {
            if (!this.additionalVerify?.channel) { cb(false, 401, 'Unauthorized'); return; }
            (info.req as any).__channel = true;
            cb(true, 200);
            return;
          }
          // 认证配对（F11C）：?pair=2。URL 里不带任何秘密，连上之后只走配对握手帧，永不进 RPC 分发。
          // 带 pair 参数的请求不再落进下面的通用分支。
          const pair = url.searchParams.get('pair');
          if (pair !== null) {
            let ok = false;
            // 带 Origin 头的一律拒：浏览器发起的 WebSocket 一定带，Node 的 ws 客户端默认不带；配对的对端是另一台机器上的
            // minisd，没有任何合法的浏览器来源。先于 admit() 判断——本机网页耗不掉尝试次数，也读不到握手里的静态公钥
            try { ok = pair === '2' && origin === undefined && this.additionalVerify?.pairing?.admit() === true; } catch { ok = false; }
            if (!ok) { cb(false, 401, 'Unauthorized'); return; }
            (info.req as any).__pairing = true;
            cb(true, 200);
            return;
          }
          // 新路径：additionalVerify（paseto / pairingCode）→ pairing/remote 模式
          if (this.additionalVerify) {
            const r = this.additionalVerify({ req: info.req, url });
            const settle = (res: AdditionalVerifyResult) => {
              if (!res.ok) { cb(false, 401, 'Unauthorized'); return; }
              // ?paseto= 老路径是明文、令牌在 URL 里（W3-sec6，安全审计第 2 条）：只留给本机回环（测试与 e2e 脚本），
              // 从网络来的远程连接只认加密通道。配对（pairing）仍可从网络来：那一步只交换公钥，见 remote/channel.ts 头注释
              if (res.authMode === 'remote' && !isLoopback) { cb(false, 401, 'Unauthorized'); return; }
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
    const remoteAddress: string | undefined = req?.socket.remoteAddress;
    if ((req as any)?.__channel === true) { this.awaitChannelHandshake(ws, remoteAddress); return; }
    if ((req as any)?.__pairing === true) { this.runPairing(ws, remoteAddress); return; }
    // verifyClient 第四参（WebSocketServer 透传的 userProps）承载 authMode；老路径/无 additionalVerify 默认 local
    const authMode: AuthMode = (req as any)?.__authMode ?? 'local';
    const peerFingerprint: string | undefined = (req as any)?.__peerFingerprint;
    this.attach(ws, authMode, peerFingerprint, remoteAddress);
  }

  /** 加密通道的握手（W3-sec6）：第一帧必须是文本的 hello，交给 additionalVerify.channel 受理；通过了回 accept，
   *  之后这条连接按 remote 模式、带对端指纹接上，收发全部加密。不通过、发的不是文本、到时没握手——一律关掉。
   *  握手前不进 clients（收不到广播）、不算入站在线。 */
  private awaitChannelHandshake(ws: WebSocket, remoteAddress: string | undefined): void {
    const fail = (): void => { try { ws.close(1008, 'channel handshake failed'); } catch { /* 已关闭 */ } };
    const timer = setTimeout(fail, this.opts.channelHandshakeMs ?? CHANNEL_HANDSHAKE_MS);
    timer.unref?.();
    ws.on('error', () => { try { ws.terminate(); } catch { /* 已关闭 */ } });
    ws.once('close', () => clearTimeout(timer));
    ws.once('message', (raw, isBinary) => {
      clearTimeout(timer);
      if (isBinary) { fail(); return; }
      let r: ChannelAccept;
      try { r = this.additionalVerify!.channel!(String(raw)); } catch { r = { ok: false }; }
      if (!r.ok) { fail(); return; }
      ws.send(r.reply);
      this.attach(ws, 'remote', r.peerFingerprint, remoteAddress, r.cipher);
    });
  }

  /** 认证配对的握手（F11C）：?pair=2 连接上只走配对帧，交给 additionalVerify.pairing 开的会话逐帧同步处理。
   *  这条连接不建 RpcConnection、不进 clients、不计入站在线：没有 authMode，调不了任何方法，收不到任何广播，
   *  按指纹关连接也找不到它。握手成功与否，它都只活到握手结束。 */
  private runPairing(ws: WebSocket, remoteAddress: string | undefined): void {
    let session: PairingSession | undefined;
    try { session = this.additionalVerify?.pairing?.open({ remoteAddress }); } catch { session = undefined; }
    // 没有 error 监听器的话，ws 的协议层错误会变成未捕获异常
    if (!session) {
      ws.on('error', () => { try { ws.terminate(); } catch { /* 已关闭 */ } });
      try { ws.close(1008, 'pairing unavailable'); } catch { /* 已关闭 */ }
      return;
    }
    const s = session;
    this.pairSockets.add(ws);
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 协议一结束就调，不等套接字真正关闭：握手槽位不该被半开的连接占住
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { s.onClose(); } catch { /* 会话自己的收尾出错不影响关连接 */ }
      try { ws.close(1000, 'pairing over'); } catch { /* 已关闭 */ }
    };
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, this.opts.pairStepMs ?? PAIR_STEP_MS);
      timer.unref?.();
    };
    arm();
    ws.on('close', () => { this.pairSockets.delete(ws); finish(); });
    ws.on('error', () => { finish(); try { ws.terminate(); } catch { /* 已关闭 */ } });
    ws.on('message', (raw, isBinary) => {
      if (done) return;
      if (isBinary) { finish(); return; }
      const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      if (buf.length > PAIR_FRAME_MAX_BYTES) { finish(); return; }
      let step: PairingStep;
      try { step = s.onFrame(buf.toString('utf8')); } catch { step = { end: true }; }
      if (step.reply !== undefined) { try { ws.send(step.reply); } catch { finish(); return; } }
      if (step.end) finish(); else arm();
    });
  }

  private attach(ws: WebSocket, authMode: AuthMode, peerFingerprint: string | undefined, remoteAddress: string | undefined, cipher?: ChannelCipher): void {
    // 加密通道上：发出去的每一帧先加密（计数在 seal 里前进，seal 与 send 同步紧挨着，顺序不会乱）
    const send = cipher
      ? (text: string): void => { ws.send(cipher.seal(text)); }
      : (text: string): void => { ws.send(text); };
    // M3c 命门 2：入站注册表 open++（remote 模式有 peerFingerprint 才记）
    if (peerFingerprint) {
      this.inboundRemote.set(peerFingerprint, (this.inboundRemote.get(peerFingerprint) ?? 0) + 1);
    }
    let closeAfterReply = false;
    const conn: RpcConnection = {
      authMode, peerFingerprint, remoteAddress, seq: ++this.connSeq,
      notify: (method, params) => send(JSON.stringify({ jsonrpc: '2.0', method, params })),
      closeAfterReply: () => { closeAfterReply = true; },
      // F11A：有 cipher 才是加密通道上的连接（单独成行、放在末尾：纯追加，不动上面几行）
      encrypted: cipher !== undefined,
    };
    this.clients.set(ws, { conn, send });
    // 配对阶段的连接只为跑完一次配对握手而存在（W3-sec4）：到配对码有效期就关，不让它一直挂着
    const pairingTimer = authMode === 'pairing'
      ? setTimeout(() => { try { ws.close(1000, 'pairing window over'); } catch { /* 已关闭 */ } }, this.opts.pairingIdleMs ?? PAIRING_CONN_IDLE_MS)
      : undefined;
    pairingTimer?.unref?.();
    ws.on('close', () => {
      if (pairingTimer) clearTimeout(pairingTimer);
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
    ws.on('message', async (raw, isBinary) => {
      // 加密通道上收到的必须是本通道的密文：解不开（明文、篡改、重放、乱序）当场断开。解密在这里同步做，计数按到达顺序前进
      let text: string;
      if (cipher) {
        if (!isBinary) { try { ws.terminate(); } catch { /* 已关闭 */ } return; }
        const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        try { text = cipher.open(new Uint8Array(buf)); } catch { try { ws.terminate(); } catch { /* 已关闭 */ } return; }
      } else {
        text = String(raw);
      }
      let msg: { id?: number; method?: string; params?: unknown };
      try { msg = JSON.parse(text) as typeof msg; } catch { return; }
      if (!msg.method) return;
      const handler = Object.hasOwn(this.methods, msg.method) ? this.methods[msg.method] : undefined;
      if (!handler) {
        send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未知方法: ${msg.method}` } }));
        return;
      }
      try {
        const result = await handler(msg.params ?? {}, conn);
        if (msg.id !== undefined) send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      } catch (e) {
        if (msg.id !== undefined) send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e instanceof Error ? e.message : e) } }));
      }
      // 回包已经排进发送队列；close 帧排在它后面，对端先收到回包再收到关闭
      if (closeAfterReply) { try { ws.close(1000, 'done'); } catch { /* 已关闭 */ } }
    });
  }

  /** M3c 命门 2：对端指纹是否有活跃入站连接（出站 ∪ 入站合并两源的入站源）。 */
  isInboundOnline(peerFingerprint: string): boolean {
    return (this.inboundRemote.get(peerFingerprint) ?? 0) > 0;
  }

  /** F13：当前已分配的最大连接序号。权限卡在发卡那一刻记下它：序号不大于它的连接当时已经连着。 */
  lastConnSeq(): number {
    return this.connSeq;
  }

  /** 关掉某个对端指纹的全部入站连接（W3-sec4：remote.unpair 时调，取消配对当场生效）。 */
  closeByFingerprint(peerFingerprint: string): void {
    for (const [ws, { conn }] of this.clients) {
      if (conn.peerFingerprint === peerFingerprint) { try { ws.close(1008, 'unpaired'); } catch { /* 已关闭 */ } }
    }
  }

  /** 当场掐断某个对端指纹的全部入站连接（F11C：这个指纹的配对记录被替换或被撤回时调）。
   *  与 closeByFingerprint 的区别是不走关闭握手：ws.close() 之后套接字要等对端回 close 帧（最长 30 秒）才销毁，
   *  这段时间收到的帧照常分发。取消配对时业务守卫按指纹复查会把它们拦下；记录被「替换」时拦不住——
   *  该指纹名下仍有（新的）配对记录，一个不回 close 帧的旧密钥持有者还能继续调业务方法。
   *  terminate() 直接销毁套接字，之后这条连接上不会再有帧进来；登记表由各连接自己的 close 事件清理。 */
  terminateByFingerprint(peerFingerprint: string): void {
    for (const [ws, { conn }] of this.clients) {
      if (conn.peerFingerprint === peerFingerprint) { try { ws.terminate(); } catch { /* 已关闭 */ } }
    }
  }

  /** 业务广播（聊天事件、权限请求全文等）。只发给 local 与 remote 连接（W3-sec4）：只拿着配对码连上的 pairing 连接
   *  只该走配对协议，以前也收得到全部广播。
   *  F06：这里是唯一的入序点——配了 events 时每条广播（不入序的方法除外）先拿序号再成帧，没有连接时也照常入序留窗口。
   *  引擎里别处不得自己拼通知帧绕过它（tests/state-sync-wiring 的守卫）。 */
  broadcast(method: string, params: unknown): void {
    const frame = this.opts.events?.append(method, params) ?? JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const { conn, send } of this.clients.values()) {
      if (conn.authMode === 'pairing') continue;
      try { send(frame); } catch { /* 断开连接忽略 */ }
    }
  }

  /** 对端在 sync.hello 里声明的协议版本与能力位（F11C）：取这个指纹名下第一条已互认的入站连接的声明。
   *  与 OutboundClient.peerInfo(fp) 相对：不分方向地问「对端支不支持某能力」时两边取并。 */
  inboundSyncPeer(peerFingerprint: string): { protocolVersion: number; caps: Readonly<Record<string, boolean>> } | undefined {
    for (const { conn } of this.clients.values()) {
      if (conn.peerFingerprint === peerFingerprint && conn.syncPeer) return conn.syncPeer;
    }
    return undefined;
  }

  close(): Promise<void> {
    // F11C：在途的 ?pair=2 握手不在 clients 里，一并终止
    for (const c of this.pairSockets) { try { c.terminate(); } catch { /* 已关闭 */ } }
    return new Promise(resolve => { if (!this.wss) return resolve(); for (const c of this.clients.keys()) c.terminate(); this.wss.close(() => resolve()); });
  }
}
