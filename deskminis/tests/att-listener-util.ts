/**
 * F11A 故障注入用的对端，作监听方 L（文件名不匹配 *.test.ts）。
 *
 * 受测的真引擎是拨号方 D：它经**真实的配对协议**加入这个监听方，再用自己的 OutboundClient 拨过来、握**真实的加密通道**。
 * 监听方这边是真实的 RpcServer + createAdditionalVerify + createRemoteMethods + createSyncMethods（真 sync.hello、
 * 真 ChatStore 上的 sync.list / pull / push），只有三个 sync.att.* 由测试脚本应答——
 * 重复的应答、坏字节、越界名字、扣住不回、说自己没有：两个真引擎之间造不出这些故障，生产代码里也不放故障注入钩子。
 *
 * legacy：扮「没有附件同步的旧构建」。sync.hello 的应答与基线逐字段相同（只有 mac 与 listenPort），
 * 不注册 sync.att.*，另挂三个只计数、回「未知方法」的探针：真引擎只要发过任何一个，计数就不是 0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService } from '../src/minisd/remote/pairing';
import { createAdditionalVerify, createRemoteMethods, guardBusinessMethod } from '../src/minisd/remote';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import { sha256Of, waitFor } from './att-util';
import { wsConnect, type RpcClient } from './att-engines-util';

const CHUNK = 256 * 1024;
type AttMethod = 'sync.att.manifest' | 'sync.att.get' | 'sync.att.put';

export interface ListenerCall { method: AttMethod; params: any; conn: number }
export interface ListenerFile { data: Buffer; mimeType: string }

export class ScriptedListener {
  readonly dir: string;
  readonly db: Database.Database;
  readonly chat: ChatStore;
  readonly service: PairingService;
  /** 收到的每一次 sync.att.*（按到达顺序）；conn 是第几条入站连接（从 1 起），用来断言「没有经过重连」。 */
  readonly calls: ListenerCall[] = [];
  /** legacy 时三个探针各被调了几次。 */
  readonly probes: Record<AttMethod, number> = { 'sync.att.manifest': 0, 'sync.att.get': 0, 'sync.att.put': 0 };
  /** 这个监听方声明自己有的文件：会话 → 名字 → 内容。honestManifest / honestGet 据此作答。 */
  readonly files = new Map<string, Map<string, ListenerFile>>();
  /** 脚本：不设就诚实作答。返回值原样当应答；抛 Error 时它的 message 原样回给对端（协议的错误码就在 message 里）。 */
  on: {
    manifest?: (params: any, nth: number) => unknown;
    get?: (params: any, nth: number) => unknown;
    put?: (params: any, nth: number) => unknown;
  } = {};
  port = 0;
  engineFp = '';
  private rpc!: RpcServer;
  private local!: RpcClient;
  private conns = new Map<RpcConnection, number>();
  private closed = false;

  private constructor(private readonly legacy: boolean) {
    this.dir = mkdtempSync(join(tmpdir(), 'f11a-listener-'));
    this.db = openDb(join(this.dir, 'minis.db'));
    const vault = new InMemoryVault();
    this.service = new PairingService(new PairingStore(this.dir, vault), vault);
    this.chat = new ChatStore(this.db, this.service.myFingerprint);
  }

  static async start(opts: { legacy?: boolean } = {}): Promise<ScriptedListener> {
    const l = new ScriptedListener(opts.legacy === true);
    const syncOpts = { pairingService: l.service, listenPort: 0 };
    const sync = createSyncMethods(l.chat, syncOpts);
    if (l.legacy) {
      // 基线构建的应答只有这两个字段；真引擎据此把它记成「没声明任何能力位」
      const hello = sync['sync.hello']!;
      sync['sync.hello'] = async (p: unknown, conn: RpcConnection) => {
        const r = await hello(p, conn) as { mac: string; listenPort: number };
        return { mac: r.mac, listenPort: r.listenPort };
      };
    }
    const methods: RpcMethods = { ...sync };
    const record = (method: AttMethod, conn: RpcConnection, params: unknown): number => {
      if (!l.conns.has(conn)) l.conns.set(conn, l.conns.size + 1);
      l.calls.push({ method, params, conn: l.conns.get(conn)! });
      return l.calls.filter(c => c.method === method).length;
    };
    if (l.legacy) {
      for (const k of Object.keys(l.probes) as AttMethod[]) {
        methods[k] = () => { l.probes[k] += 1; throw new Error(`未知方法: ${k}`); };
      }
    } else {
      methods['sync.att.manifest'] = async (p: unknown, conn: RpcConnection) => {
        const nth = record('sync.att.manifest', conn, p);
        return l.on.manifest ? l.on.manifest(p, nth) : l.honestManifest(p);
      };
      methods['sync.att.get'] = async (p: unknown, conn: RpcConnection) => {
        const nth = record('sync.att.get', conn, p);
        return l.on.get ? l.on.get(p, nth) : l.honestGet(p);
      };
      methods['sync.att.put'] = async (p: unknown, conn: RpcConnection) => {
        const nth = record('sync.att.put', conn, p);
        if (l.on.put) return l.on.put(p, nth);
        throw new Error('ATT_CANCELLED');
      };
    }
    // 与 minisd/index.ts 相同：remote.* 以外的方法统一包业务守卫（每次调用复查配对）
    const isPaired = (fp: string): boolean => l.service.get(fp) !== undefined;
    for (const k of Object.keys(methods)) (methods as any)[k] = guardBusinessMethod((methods as any)[k], k, isPaired);
    Object.assign(methods, createRemoteMethods(l.service, { getRpcServer: () => l.rpc }));
    l.rpc = new RpcServer(methods, 'LISTENER-LOCAL-TOKEN', createAdditionalVerify(l.service));
    l.port = await l.rpc.listen('127.0.0.1', 0);
    syncOpts.listenPort = l.port;
    l.local = await wsConnect(`ws://127.0.0.1:${l.port}/?token=LISTENER-LOCAL-TOKEN`);
    return l;
  }

  get fp(): string { return this.service.myFingerprint; }

  /** 真实配对：本端 remote.pair.begin 出配对码，受测引擎经它的本机连接跑产品的 remote.pair.join 拨过来；等它上线并互认。 */
  async pairWith(engineLocal: RpcClient): Promise<void> {
    const begin = await this.local.call('remote.pair.begin', {});
    await engineLocal.call('remote.pair.join', { host: '127.0.0.1', port: this.port, pairingCode: begin.pairingCode, peerName: '脚本监听方', listenPort: 0 });
    this.engineFp = this.service.list()[0].peerFingerprint;
    await waitFor('真引擎拨到脚本监听方并互认', () => this.rpc.inboundSyncPeer(this.engineFp) !== undefined || (this.legacy && this.rpc.isInboundOnline(this.engineFp)), 8000);
  }

  /** 建一个会话，写一条引用这些名字的用户消息；给了 data 的文件同时登记成「本端有」。返回会话 id。 */
  addSession(title: string, refs: Array<{ name: string; data?: Buffer; mimeType?: string }>): string {
    const s = this.chat.createSession(title);
    const now = Date.now();
    this.chat.appendMessage({
      id: randomUUID().toUpperCase(), sessionId: s.id, role: 'user', createdAt: now, streamInterruptCount: 0,
      parts: [
        { type: 'text', value: '脚本监听方的附件' },
        ...refs.map(r => ({ type: 'mediaRef' as const, value: { id: randomUUID(), relativePath: `attachments/${r.name}`, mimeType: r.mimeType ?? 'image/png' } })),
      ],
    } as never);
    for (const r of refs) if (r.data) this.setFile(s.id, r.name, r.data, r.mimeType);
    return s.id;
  }

  setFile(sid: string, name: string, data: Buffer, mimeType = 'image/png'): void {
    let per = this.files.get(sid);
    if (!per) { per = new Map(); this.files.set(sid, per); }
    per.set(name, { data, mimeType });
  }

  removeFile(sid: string, name: string): void { this.files.get(sid)?.delete(name); }

  /** 按协议诚实作答：列出本端有、对方这次没列的条目；本端什么都不要。 */
  honestManifest(params: any): unknown {
    const listed = new Set<string>((Array.isArray(params?.entries) ? params.entries : []).map((e: any) => `${String(e?.name).toLowerCase()}:${e?.sha256}`));
    const entries = [...(this.files.get(params?.sessionId) ?? new Map<string, ListenerFile>())]
      .map(([name, f]) => ({ name, size: f.data.length, sha256: sha256Of(f.data), mimeType: f.mimeType }))
      .filter(e => !listed.has(`${e.name.toLowerCase()}:${e.sha256}`));
    return { v: 1, entries, want: [], rejected: [], indexing: false };
  }

  /** 按协议诚实作答：正是请求的那一块；没有或内容对不上回 ATT_NOT_FOUND。 */
  honestGet(params: any): unknown {
    const f = this.files.get(params?.sessionId)?.get(params?.name);
    if (!f || sha256Of(f.data) !== params?.sha256) throw new Error('ATT_NOT_FOUND');
    const bytes = f.data.subarray(params.offset, Math.min(f.data.length, params.offset + CHUNK));
    return { v: 1, offset: params.offset, size: f.data.length, data: bytes.toString('base64') };
  }

  /** 发 sync.dirty 通知：真引擎（拨号方）收到后在同一条连接上拉取并重发清单。 */
  dirty(sid: string): void {
    this.rpc.broadcast('sync.dirty', { sessionId: sid, cursor: this.chat.getSessionCursor(sid) });
  }

  /** 掐断真引擎的入站连接（不走关闭握手）。它会按退避重拨。 */
  dropConnections(): void { this.rpc.terminateByFingerprint(this.engineFp); }

  manifests(sid?: string): ListenerCall[] { return this.calls.filter(c => c.method === 'sync.att.manifest' && (sid === undefined || c.params?.sessionId === sid)); }
  gets(name?: string): ListenerCall[] { return this.calls.filter(c => c.method === 'sync.att.get' && (name === undefined || c.params?.name === name)); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.local.close(); } catch { /* 已关 */ }
    await this.rpc.close();
    try { this.db.close(); } catch { /* 已关 */ }
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
  }
}
