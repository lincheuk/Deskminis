/**
 * M3c 出站 WS 客户端 OutboundClient（决策 1/2/4/6）。
 *
 * 主动连已配对对端（LAN 直连，noProxy），实现：
 *   - PASETO jti/aud/60s 防重放（决策 1 层 1，握手层防错连投毒）
 *   - sync.hello 挑战应答双向互认（决策 1 层 2，HMAC-SHA256(authKey, 'm3c-hello'||nonce)）
 *     W2b-8：hello 两个方向都多带 protocolVersion/caps（不进 MAC）；对端不带就按 0.1.1 旧版处理，
 *     更高版本不拒绝。MAC 校验通过后才记对端声明，经 peerInfo(fp) 公开，供 W5c 按对端能力决定推什么。
 *   - 指纹字典序主从裁决避免双连（决策 2，myFp < peerFp 者主拨）
 *   - 断线指数退避重连（决策 6，1→2→4→8→16→30s 上限）
 *   - WS ping/pong 保活（决策 6，30s ping / 60s 判死）
 *   - PASETO TTL 到期前重铸（连接存活超 TTL → 主动重连重铸 token 新 jti）
 *
 * 红线：
 *   - 密钥脱敏：authKey/PASETO token/nonce/mac 一律不入日志
 *   - noProxy：new WebSocket(url) 默认不读 HTTP_PROXY，天然直连 LAN
 *   - 不传 agent，provider 流量继续走系统代理
 */
import { WebSocket } from 'ws';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PairingService } from '../remote/pairing';
import { encodePaseto } from '../remote/paseto';
import { LEGACY_SYNC_PEER, LOCAL_SYNC_CAPS, SYNC_PROTOCOL_VERSION, parseSyncHello, type SyncPeerInfo } from './wire';

/** 默认参数（决策 6）。 */
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 60_000;
const DEFAULT_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const DEFAULT_PASETO_TTL_MS = 60_000;
const CALL_RPC_TIMEOUT_MS = 10_000;

export interface OutboundClientOpts {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  reconnectBackoffMs?: number[];
  pasetoTtlMs?: number;
}

/** 单个对端的连接状态。 */
interface PeerConnection {
  ws: WebSocket;
  online: boolean;
  helloDone: boolean;
  reqId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  pingTimer?: ReturnType<typeof setTimeout>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectIdx: number;
  tokenIssuedAt: number;
  stopped: boolean;
  /** 最近一次收到 pong 的时间戳（判死用，决策 6） */
  lastPongAt: number;
  /** 当前拨号的目标地址（重连用） */
  addr: string;
  /** 对端在 sync.hello 响应里声明的协议版本与能力位；互认通过前一律按旧版（W2b-8） */
  peer: SyncPeerInfo;
}

export class OutboundClient {
  /** 连接状态回调——sync.hello 互认通过后才触发 */
  onOnline?: (peerFingerprint: string) => void;
  onOffline?: (peerFingerprint: string) => void;
  /** 收到对端 sync.dirty notify → 触发本端 pull（自动收敛，拨号方职责，Task 5/6 接线） */
  onRemoteDirty?: (peerFingerprint: string, sessionId: string) => void;

  private connections = new Map<string, PeerConnection>();
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly reconnectBackoffMs: number[];
  private readonly pasetoTtlMs: number;

  constructor(
    private pairing: PairingService,
    private myFingerprint: string,
    opts: OutboundClientOpts = {},
  ) {
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.reconnectBackoffMs = opts.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
    this.pasetoTtlMs = opts.pasetoTtlMs ?? DEFAULT_PASETO_TTL_MS;
  }

  /** 启动：遍历 PairingStore 已配对设备，仅对 myFp < peerFp 者拨号（决策 2 主从裁决）。 */
  start(): void {
    const peers = this.pairing.listWithAddress();
    for (const peer of peers) {
      // 主从裁决：字典序小者主拨，大者只监听
      if (this.myFingerprint < peer.peerFingerprint && peer.address) {
        this.dial(peer.peerFingerprint, peer.address);
      }
    }
  }

  /** 手动触发单个对端拨号（remote.pair.join 成功后立即拨，不等下次 start；测试用）。 */
  dialNow(peerFp: string): void {
    const addr = this.pairing.getAddress(peerFp);
    if (!addr) return; // 无地址无法拨
    // 如果已有连接且在线，不重复拨
    const existing = this.connections.get(peerFp);
    if (existing && (existing.online || !existing.stopped)) return;
    this.dial(peerFp, addr);
  }

  /** 拨单个对端：铸 PASETO(jti/aud/60s) + new WebSocket + sync.hello 互认 + ping/pong/reconnect。 */
  private dial(peerFp: string, addr: string): void {
    const key = this.pairing.get(peerFp);
    if (!key) return; // 未配对，不拨

    // 清理旧连接（如果有）
    const old = this.connections.get(peerFp);
    if (old) this.cleanupConnection(peerFp, old);

    // 铸 PASETO（jti/aud/短 TTL，决策 1 层 1）
    const now = Date.now();
    const jti = randomUUID();
    const token = encodePaseto({
      exp: now + this.pasetoTtlMs,
      iat: now,
      device_fingerprint: this.myFingerprint,
      jti,
      aud: peerFp,
    }, key.authKey);

    const url = `ws://${addr}/?paseto=${encodeURIComponent(token)}`;
    // noProxy：ws 库默认不读 HTTP_PROXY，天然直连 LAN（红线 4e）
    const ws = new WebSocket(url);

    const conn: PeerConnection = {
      ws,
      online: false,
      helloDone: false,
      reqId: 0,
      pending: new Map(),
      reconnectIdx: 0,
      tokenIssuedAt: now,
      stopped: false,
      lastPongAt: now,
      addr,
      // 每次拨号都从旧版起步：上一条连接的声明不能带到新连接（对端可能已经换了版本）
      peer: LEGACY_SYNC_PEER,
    };
    this.connections.set(peerFp, conn);

    ws.on('open', () => {
      // 不立即 onOnline——先发 sync.hello 互认（决策 1 层 2）
      this.doHello(peerFp, conn, key.authKey).then(ok => {
        if (ok) {
          conn.helloDone = true;
          conn.online = true;
          conn.reconnectIdx = 0;
          // setLastSeen + setAddress（端口漂移自愈由 sync.hello 响应的 listenPort 处理）
          this.pairing.setLastSeen(peerFp, Math.floor(Date.now() / 1000));
          this.startPing(peerFp, conn);
          this.onOnline?.(peerFp);
        } else {
          // 互认失败 → onOffline（连接已建立但鉴权失败）+ terminate + 退避重连
          // wasOnline=false 所以 onClose 不会重复调 onOffline
          this.onOffline?.(peerFp);
          try { ws.terminate(); } catch { /* */ }
          this.scheduleReconnect(peerFp, conn);
        }
      }).catch(() => {
        this.onOffline?.(peerFp);
        try { ws.terminate(); } catch { /* */ }
        this.scheduleReconnect(peerFp, conn);
      });
    });

    ws.on('message', (raw: Buffer | string) => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      // RPC 响应（有 id）→ resolve pending callRpc
      if (msg.id !== undefined && conn.pending.has(msg.id)) {
        const entry = conn.pending.get(msg.id)!;
        conn.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(String((msg as any).error?.message ?? msg.error)));
        else entry.resolve(msg.result);
        return;
      }
      // notify（有 method 无 id）→ sync.dirty 监听（仅 helloDone 后处理）
      if (msg.method && msg.id === undefined && conn.helloDone) {
        if (msg.method === 'sync.dirty') {
          const sid = (msg.params as any)?.sessionId;
          if (typeof sid === 'string') this.onRemoteDirty?.(peerFp, sid);
        }
      }
    });

    ws.on('pong', () => {
      // 记录 pong 到达时间——startPing 的 tick 检测超时判死（决策 6）
      conn.lastPongAt = Date.now();
    });

    const onClose = () => {
      if (conn.stopped) return;
      const wasOnline = conn.online;
      conn.online = false;
      conn.helloDone = false;
      this.clearTimers(conn);
      if (wasOnline) this.onOffline?.(peerFp);
      this.scheduleReconnect(peerFp, conn);
    };

    ws.on('close', onClose);
    ws.on('error', () => {
      // error 后 ws 会 close，onClose 处理重连；这里只防未捕获异常
      // 如果还没 open 就 error，onClose 可能不触发——手动调
      if (!conn.helloDone && !conn.stopped) {
        try { ws.terminate(); } catch { /* */ }
      }
    });
  }

  /** sync.hello 挑战应答（决策 1 层 2）。 */
  private async doHello(peerFp: string, conn: PeerConnection, authKey: Uint8Array): Promise<boolean> {
    const nonce = randomBytes(16).toString('hex');
    try {
      // 多带的 protocolVersion/caps 不进 MAC；0.1.1 的应答端忽略多余参数，只回 {mac, listenPort}
      const raw = await this.callRpcOnConn(conn, 'sync.hello', { nonce, protocolVersion: SYNC_PROTOCOL_VERSION, caps: { ...LOCAL_SYNC_CAPS } });
      // 响应来自网络，先当 unknown：取不到字符串 mac 就走下面的长度校验判失败，不靠抛错
      const resp = (raw !== null && typeof raw === 'object' ? raw : {}) as { mac?: unknown; listenPort?: unknown };
      const respMac = typeof resp.mac === 'string' ? resp.mac : '';
      // 本地算 HMAC 比对
      const expectedMac = hmac(sha256, authKey, new TextEncoder().encode('m3c-hello' + nonce));
      const expectedHex = Buffer.from(expectedMac).toString('hex');
      // 常量时间比较：先比长度，长度不等直接返回 false（timingSafeEqual 长度不等会抛，必须先比长度）
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const respBuf = Buffer.from(respMac, 'hex');
      const ok = expectedBuf.length === respBuf.length && expectedBuf.length > 0
        ? timingSafeEqual(expectedBuf, respBuf)
        : false;
      if (!ok) return false; // 伪造/中间人
      // MAC 通过之后才采信对端的版本声明（未通过的连接会被 terminate，它说的什么都不记）
      conn.peer = parseSyncHello(raw);
      // 端口漂移自愈：用响应的 listenPort 刷新地址簿
      if (typeof resp.listenPort === 'number' && resp.listenPort > 0) {
        const addrParts = conn.addr.split(':');
        const host = addrParts[0] || '127.0.0.1';
        const newAddr = `${host}:${resp.listenPort}`;
        if (newAddr !== conn.addr) {
          conn.addr = newAddr;
          this.pairing.setAddress(peerFp, newAddr);
        }
      }
      return true;
    } catch {
      return false; // callRpc 超时/错误 → 互认失败
    }
  }

  /** 在出站连接上调 RPC（sync.push / sync.pull / sync.hello）。 */
  async callRpc(peerFp: string, method: string, params: unknown): Promise<unknown> {
    const conn = this.connections.get(peerFp);
    if (!conn || !conn.online) throw new Error(`对端 ${peerFp} 未在线`);
    return this.callRpcOnConn(conn, method, params);
  }

  /** 在指定连接上发 RPC request，等响应，10s 超时。 */
  private callRpcOnConn(conn: PeerConnection, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++conn.reqId;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`callRpc ${method} 超时`));
      }, CALL_RPC_TIMEOUT_MS);
      timer.unref?.();
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 启动 ping/pong 保活 + PASETO TTL 检测（决策 6）。 */
  private startPing(peerFp: string, conn: PeerConnection): void {
    const tick = () => {
      if (conn.stopped || !conn.online) return;
      // PASETO TTL 检测：token 将过期 → 主动 close 触发重连重铸（新 jti）
      const elapsed = Date.now() - conn.tokenIssuedAt;
      if (elapsed > this.pasetoTtlMs - this.pingIntervalMs) {
        // 主动重连：先清 reconnectTimer 避免 onClose 重复调度
        conn.online = false;
        conn.helloDone = false;
        this.clearTimers(conn);
        this.onOffline?.(peerFp);
        // 重拨（新 PASETO 新 jti）
        this.dial(peerFp, conn.addr);
        return;
      }
      // pong 超时判死：上次 pong 距今超过 pongTimeoutMs → terminate（决策 6）
      if (Date.now() - conn.lastPongAt > this.pongTimeoutMs) {
        try { conn.ws.terminate(); } catch { /* */ }
        return;
      }
      // 发 ping
      try { conn.ws.ping(); } catch { /* */ }
    };
    conn.pingTimer = setInterval(tick, this.pingIntervalMs);
    conn.pingTimer.unref?.();
  }

  /** 调度重连（指数退避，决策 6）。 */
  private scheduleReconnect(peerFp: string, conn: PeerConnection): void {
    if (conn.stopped) return;
    if (conn.reconnectTimer) return; // 已在调度中
    const delay = this.reconnectBackoffMs[Math.min(conn.reconnectIdx, this.reconnectBackoffMs.length - 1)];
    conn.reconnectIdx++;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = undefined;
      if (conn.stopped) return;
      // 重拨（新 PASETO 新 jti）
      this.dial(peerFp, conn.addr);
    }, delay);
    conn.reconnectTimer.unref?.();
  }

  /** 清理单个连接的所有计时器（不删 Map 条目，重连时复用）。 */
  private clearTimers(conn: PeerConnection): void {
    if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = undefined; }
    // 不清 reconnectTimer——由 scheduleReconnect 管理和检查
    // 清理 pending callRpc
    for (const [, entry] of conn.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('连接断开'));
    }
    conn.pending.clear();
  }

  /** 完全清理连接（disconnect/stop 用）。 */
  private cleanupConnection(peerFp: string, conn: PeerConnection): void {
    conn.stopped = true;
    this.clearTimers(conn);
    if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = undefined; }
    try { conn.ws.terminate(); } catch { /* */ }
    this.connections.delete(peerFp);
  }

  /** 返回当前已拨号成功的对端指纹集合（SyncCoordinator.onDirty 拨号方 push 用，Task 6）。 */
  dialedPeers(): string[] {
    const result: string[] = [];
    for (const [fp, conn] of this.connections) {
      if (conn.online) result.push(fp);
    }
    return result;
  }

  /** 主动断开并停止重连（unpair 时调）。 */
  disconnect(peerFp: string): void {
    const conn = this.connections.get(peerFp);
    if (conn) this.cleanupConnection(peerFp, conn);
  }

  /** 关闭所有出站连接 + 停止重连（SyncCoordinator.stop 调）。 */
  stop(): void {
    for (const [fp, conn] of this.connections) {
      this.cleanupConnection(fp, conn);
    }
    this.connections.clear();
  }

  // ---- presence 接口（命门 2 出站源，Task 5 接线） ----

  isOnline(fp: string): boolean {
    return this.connections.get(fp)?.online ?? false;
  }

  /** 对端在 sync.hello 里声明的协议版本与能力位（W2b-8）。只在在线时返回：离线时那份声明属于已断开的连接，不代表现状。 */
  peerInfo(fp: string): SyncPeerInfo | undefined {
    const conn = this.connections.get(fp);
    return conn?.online ? conn.peer : undefined;
  }

  lastSeen(fp: string): number {
    // 从地址簿读 lastSeenAt（pairing.setLastSeen 维护）
    const peers = this.pairing.listWithAddress();
    return peers.find(p => p.peerFingerprint === fp)?.lastSeenAt ?? 0;
  }
}
