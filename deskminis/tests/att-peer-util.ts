/**
 * F11A 故障注入用的对端（文件名不匹配 *.test.ts）。
 *
 * RawPeer 有自己的 PairingService（临时目录、内存 vault），与受测的真引擎走**真实的配对协议**配对，
 * 再用手写的 WebSocket 客户端连 ?ch=1、用 remote/channel.ts 的 beginClientHandshake 握**真实的加密通道**，
 * 之后逐帧加解密、自己发 sync.hello（带什么能力位由测试决定）与任意 RPC。
 * 受测引擎看到的是一条真实配对出来的、加密的 remote 连接；只是方法层的参数由测试脚本控制
 * （重复块、坏字节、越界名字、不声明能力位）——两个真引擎之间不可能自己产生这些故障，生产代码里也不放故障注入钩子。
 *
 * 不用 OutboundClient 扮这个对端：它的 sync.hello 写死带本进程的 LOCAL_SYNC_CAPS，扮不了「不声明能力位的拨号方」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService } from '../src/minisd/remote/pairing';
import { createRemoteMethods } from '../src/minisd/remote';
import { beginClientHandshake, type FrameCipher } from '../src/minisd/remote/channel';
import { encodePaseto } from '../src/minisd/remote/paseto';
import type { RpcClient } from './att-engines-util';

export interface RawConn {
  /** 发一个 RPC；对端回错误时 reject，message 就是对端给的那一句。 */
  call<T = any>(method: string, params?: unknown): Promise<T>;
  /** 发 sync.hello 并核对应答的 MAC。extra 不给就只带 nonce（旧构建的形状）。返回对端的应答。 */
  hello(extra?: { protocolVersion?: number; caps?: Record<string, boolean> }): Promise<any>;
  notifications: Array<{ method: string; params: any }>;
  closed: Promise<void>;
  close(): void;
}

export class RawPeer {
  readonly dir: string;
  readonly service: PairingService;
  engineFp = '';
  private enginePort = 0;
  private conns: RawConn[] = [];

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'f11a-rawpeer-'));
    const vault = new InMemoryVault();
    this.service = new PairingService(new PairingStore(this.dir, vault), vault);
  }

  get fp(): string { return this.service.myFingerprint; }

  /** 真实配对：受测引擎 remote.pair.begin 出配对码，本端跑产品自己的 remote.pair.join。 */
  async pair(engineLocal: RpcClient, enginePort: number): Promise<void> {
    this.enginePort = enginePort;
    const begin = await engineLocal.call('remote.pair.begin', {});
    const join = createRemoteMethods(this.service)['remote.pair.join']!;
    await join({ host: '127.0.0.1', port: enginePort, pairingCode: begin.pairingCode, peerName: '脚本对端', listenPort: 0 }, { authMode: 'local', notify: () => { /* 不用 */ } } as never);
    this.engineFp = this.service.list()[0].peerFingerprint;
  }

  /** plain=true：连回环的明文 ?paseto= 老路径（帧是明文）；否则连 ?ch=1 并握加密通道。 */
  connect(opts: { plain?: boolean } = {}): Promise<RawConn> {
    const key = this.service.get(this.engineFp);
    if (!key) throw new Error('还没配对');
    const now = Date.now();
    const url = opts.plain
      ? `ws://127.0.0.1:${this.enginePort}/?paseto=${encodeURIComponent(encodePaseto({ exp: now + 60000, iat: now, device_fingerprint: this.fp, jti: randomUUID(), aud: this.engineFp }, key.authKey))}`
      : `ws://127.0.0.1:${this.enginePort}/?ch=1`;
    const ws = new WebSocket(url);
    return new Promise<RawConn>((resolve, reject) => {
      let cipher: FrameCipher | undefined;
      let finish: ((reply: string) => FrameCipher) | undefined;
      let idc = 0;
      const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
      const notifications: RawConn['notifications'] = [];
      let onClosed!: () => void;
      const closed = new Promise<void>(r => { onClosed = r; });
      const call = (method: string, params?: unknown): Promise<any> => new Promise((res, rej) => {
        const id = ++idc;
        pending.set(id, { resolve: res, reject: rej });
        const text = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        try { ws.send(cipher ? cipher.seal(text) : text); } catch (e) { pending.delete(id); rej(e as Error); }
      });
      const conn: RawConn = {
        call, notifications, closed,
        close: () => { try { ws.terminate(); } catch { /* 已关 */ } },
        hello: async (extra = {}) => {
          const nonce = randomBytes(16).toString('hex');
          const resp = await call('sync.hello', { nonce, ...extra });
          const expect = Buffer.from(hmac(sha256, key.authKey, new TextEncoder().encode('m3c-hello' + nonce))).toString('hex');
          if (resp?.mac !== expect) throw new Error('sync.hello 的 MAC 不对');
          return resp;
        },
      };
      this.conns.push(conn);
      ws.on('open', () => {
        if (opts.plain) { resolve(conn); return; }
        const hs = beginClientHandshake({ authKey: key.authKey, sessionSecret: key.sessionSecret }, this.fp, this.engineFp);
        finish = hs.finish;
        ws.send(hs.hello);
      });
      ws.on('message', (raw: Buffer, isBinary: boolean) => {
        let text: string;
        if (!opts.plain && !cipher) {
          // 握手阶段：唯一该来的是文本的 accept
          try { cipher = finish!(String(raw)); } catch (e) { reject(e as Error); return; }
          resolve(conn);
          return;
        }
        if (cipher) {
          if (!isBinary) return;
          try { text = cipher.open(new Uint8Array(raw)); } catch { return; }
        } else text = String(raw);
        const msg = JSON.parse(text);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!; pending.delete(msg.id);
          if (msg.error) p.reject(new Error(String(msg.error.message ?? msg.error))); else p.resolve(msg.result);
        } else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
      });
      ws.on('close', () => {
        for (const p of pending.values()) p.reject(new Error('连接断开'));
        pending.clear();
        onClosed();
        reject(new Error('连接在握手完成前被关闭'));
      });
      ws.on('error', () => { /* close 里处理 */ });
    });
  }

  dispose(): void {
    for (const c of this.conns) c.close();
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
  }
}

/** 一条带附件引用的用户消息（线格式），给 sync.push 用。 */
export function refMessage(sid: string, refs: Array<{ relativePath: unknown; mimeType?: string }>, text = '附件'): Record<string, unknown> {
  const now = Date.now();
  const parts = [{ type: 'text', value: text }, ...refs.map(r => ({ type: 'mediaRef', value: { id: randomUUID(), relativePath: r.relativePath, mimeType: r.mimeType ?? 'image/png' } }))];
  return {
    id: randomUUID().toUpperCase(), sessionId: sid, role: 'user', partsJson: JSON.stringify(parts),
    tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0, sortOrder: now, createdAt: now, updatedAt: now,
    originDeviceId: 'f11a-raw-peer', createdLocallyAt: now,
  };
}
