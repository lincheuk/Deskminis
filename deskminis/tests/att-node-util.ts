/**
 * F11A 组件级夹具（文件名不匹配 *.test.ts）：只给需要注入的用例用。
 *
 * bootAttNode 手工装配一个节点：真 openDb、真 ChatStore、真 PairingService、真 RpcServer（127.0.0.1:0）、真 OutboundClient、
 * 真 SyncCoordinator、createAttachmentSync。两个节点之间走真实的配对协议与真实的加密通道，字节真的经 WebSocket 传。
 * 与 minisd/index.ts 的装配不是同一段代码（那一段由 tests/att-sync-engines.test.ts 用 startMinisd 测）；
 * 这里多出来的只有测试要的三样：
 *   - limits / now 可注入（块长、时限、配额调小，两端一起缩）；
 *   - io 的 verify / hash / copy 各有一个闸门（缺省开着），关上之后相应调用停在入口，放行后才继续；
 *   - 每个 sync.* / sync.att.* 处理器外面包一层记录（参数、应答或错误、第几条连接），并可挂拦截器在处理前后扣住。
 * 生产代码里没有故障注入钩子。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { MinisPaths } from '../src/minisd/paths';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService } from '../src/minisd/remote/pairing';
import { createAdditionalVerify, createRemoteMethods, guardBusinessMethod } from '../src/minisd/remote';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import { OutboundClient } from '../src/minisd/sync/outbound-client';
import { SyncCoordinator } from '../src/minisd/sync/coordinator';
import { createAttachmentSync, type AttachmentLimits, type AttachmentSync } from '../src/minisd/sync/attachments';
import { createAttachmentIo } from '../src/minisd/sync/attachments/io';
import type { AttachmentStatusResult, AttachmentView } from '../src/shared/attachments';
import { makeGate, waitFor, type Gate } from './att-util';
import { wsConnect, type RpcClient } from './att-engines-util';

export interface NodeCall { method: string; params: any; result?: any; error?: string; conn: number }
/** next() 调真实的处理器。拦截器可以在它前面或后面等一个闸门。 */
export type Intercept = (params: any, next: () => Promise<unknown>) => unknown;

export interface AttNode {
  readonly name: string;
  readonly dir: string;
  readonly db: Database.Database;
  readonly chat: ChatStore;
  readonly paths: MinisPaths;
  readonly service: PairingService;
  readonly rpc: RpcServer;
  readonly outbound: OutboundClient;
  readonly coordinator: SyncCoordinator;
  readonly att: AttachmentSync;
  readonly port: number;
  readonly fp: string;
  readonly local: RpcClient;
  /** io 的闸门：关上（close()）之后相应调用停在入口。 */
  readonly gates: { verify: Gate; hash: Gate; copy: Gate };
  /** 本端收到的 sync.* 与 sync.att.* 调用（按到达顺序）。 */
  readonly calls: NodeCall[];
  readonly intercept: Record<string, Intercept | undefined>;
  bucket(sid: string): string;
  /** 建会话（不带附件）。 */
  newSession(title: string): string;
  /** 文件放进附件桶，再追加一条引用它的用户消息（走真 ChatStore，触发真协调器的推送）。 */
  addFile(sid: string, name: string, data: Buffer, mimeType?: string): void;
  /** 只放文件，不写消息。 */
  putFile(sid: string, name: string, data: Buffer): void;
  addText(sid: string, text: string): void;
  item(sid: string, name: string): Promise<AttachmentView | undefined>;
  state(sid: string, name: string): Promise<string>;
  incoming(): Array<{ name: string; size: number }>;
  pause(): void;
  resume(): Promise<void>;
  /** 向已连入的拨号方发 sync.dirty：让它对这个会话再来一轮。 */
  dirty(sid: string): void;
  attCalls(method: 'manifest' | 'get' | 'put'): NodeCall[];
  close(): Promise<void>;
}

export interface AttNodeOpts {
  name?: string;
  limits?: Partial<AttachmentLimits>;
  now?: () => number;
}

export async function bootAttNode(opts: AttNodeOpts = {}): Promise<AttNode> {
  const name = opts.name ?? 'node';
  const dir = mkdtempSync(join(tmpdir(), `f11a-node-${name}-`));
  const db = openDb(join(dir, 'minis.db'));
  const paths = new MinisPaths(dir);
  const vault = new InMemoryVault();
  const pairingStore = new PairingStore(dir, vault);
  const service = new PairingService(pairingStore, vault);
  const chat = new ChatStore(db, service.myFingerprint);
  const gates = { verify: makeGate(), hash: makeGate(), copy: makeGate() };
  const real = createAttachmentIo();
  let rpc!: RpcServer;
  // 短退避：掐断之后的重连不用等一秒
  const outbound = new OutboundClient(service, service.myFingerprint, { reconnectBackoffMs: [100] });
  const isPaired = (fp: string): boolean => service.get(fp) !== undefined;

  const att = createAttachmentSync({
    db, root: dir, paths, isPaired,
    pairedPeers: () => service.list().map(d => d.peerFingerprint),
    sessionExists: sid => chat.getSession(sid) !== undefined,
    sessionCursor: sid => chat.getSessionCursor(sid),
    outbound: () => outbound,
    isInboundOnline: fp => rpc.isInboundOnline(fp),
    broadcast: (m, p) => rpc.broadcast(m, p),
    limits: opts.limits,
    now: opts.now,
    io: {
      verify: async (path, sha256, size) => { await gates.verify.wait(); return real.verify(path, sha256, size); },
      hash: async path => { await gates.hash.wait(); return real.hash(path); },
      copy: async (src, dst) => { await gates.copy.wait(); return real.copy(src, dst); },
    },
  });

  const syncOpts = {
    pairingService: service, listenPort: 0,
    onMergedRemote: (peerFp: string | undefined, sid: string, result: { mergedCount: number }) => {
      rpc.broadcast('chat.event', { kind: 'synced', sessionId: sid, mergedCount: result.mergedCount, fromDevice: peerFp });
    },
    onPeerHello: (fp: string | undefined, peer: { protocolVersion: number; caps: Readonly<Record<string, boolean>> }) => att.onPeerHello(fp, peer),
  };
  const calls: NodeCall[] = [];
  const intercept: AttNode['intercept'] = {};
  const conns = new Map<RpcConnection, number>();
  const recorded = (k: string, handler: (p: any, conn: RpcConnection) => unknown) => async (p: any, conn: RpcConnection): Promise<unknown> => {
    if (!conns.has(conn)) conns.set(conn, conns.size + 1);
    const rec: NodeCall = { method: k, params: p, conn: conns.get(conn)! };
    calls.push(rec);
    const next = async (): Promise<unknown> => handler(p, conn);
    try {
      const hook = intercept[k];
      const result = await (hook ? hook(p, next) : next());
      rec.result = result;
      return result;
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  };
  const methods: RpcMethods = {};
  const groups: RpcMethods[] = [createSyncMethods(chat, syncOpts), att.peerMethods];
  for (const group of groups) for (const k of Object.keys(group)) methods[k] = recorded(k, (group as any)[k]);
  Object.assign(methods, att.localMethods);
  // 与 minisd/index.ts 相同：remote.* 以外的方法统一包业务守卫（每次调用复查配对）
  for (const k of Object.keys(methods)) (methods as any)[k] = guardBusinessMethod((methods as any)[k], k, isPaired);
  Object.assign(methods, createRemoteMethods(service, {
    onPairComplete: (fp, remoteAddr, listenPort) => {
      if (listenPort && listenPort > 0) pairingStore.setAddress(fp, `${remoteAddr?.replace(/^::ffff:/, '') ?? '127.0.0.1'}:${listenPort}`);
    },
    getOutbound: () => outbound,
    getRpcServer: () => rpc,
  }));
  const token = `NODE-TOKEN-${name}`;
  rpc = new RpcServer(methods, token, createAdditionalVerify(service));
  const port = await rpc.listen('127.0.0.1', 0);
  syncOpts.listenPort = port;

  const coordinator = new SyncCoordinator(chat, rpc, { outbound, attachments: att.port, debounceMs: 20 });
  chat.onDirty = sid => coordinator.onDirty(sid);
  coordinator.start();
  const local = await wsConnect(`ws://127.0.0.1:${port}/?token=${token}`);

  const bucket = (sid: string): string => paths.sessionBucket(sid, 'attachments');
  const append = (sid: string, parts: unknown[]): void => {
    chat.appendMessage({ id: randomUUID().toUpperCase(), sessionId: sid, role: 'user', createdAt: Date.now(), streamInterruptCount: 0, parts } as never);
  };
  let closed = false;
  const node: AttNode = {
    name, dir, db, chat, paths, service, rpc, outbound, coordinator, att, port, fp: service.myFingerprint, local, gates, calls, intercept,
    bucket,
    newSession: title => chat.createSession(title).id,
    putFile(sid, fileName, data) { mkdirSync(bucket(sid), { recursive: true }); writeFileSync(join(bucket(sid), fileName), data); },
    addFile(sid, fileName, data, mimeType = 'image/png') {
      node.putFile(sid, fileName, data);
      append(sid, [{ type: 'text', value: `附件 ${fileName}` }, { type: 'mediaRef', value: { id: randomUUID(), relativePath: `attachments/${fileName}`, mimeType } }]);
    },
    addText(sid, text) { append(sid, [{ type: 'text', value: text }]); },
    async item(sid, fileName) {
      const st = await local.call<AttachmentStatusResult>('attachments.status', { sessionId: sid });
      return st.items.find(i => i.name === fileName);
    },
    async state(sid, fileName) {
      const i = await node.item(sid, fileName);
      return i ? `${i.state}/${i.reason ?? ''}` : '无';
    },
    incoming() {
      const d = join(dir, 'sync-incoming');
      return existsSync(d) ? readdirSync(d).sort().map(n => ({ name: n, size: statSync(join(d, n)).size })) : [];
    },
    pause() { coordinator.setPaused(true); },
    async resume() { coordinator.setPaused(false); await coordinator.resumeSync(); },
    dirty(sid) { rpc.broadcast('sync.dirty', { sessionId: sid, cursor: chat.getSessionCursor(sid) }); },
    attCalls: m => calls.filter(c => c.method === `sync.att.${m}`),
    async close() {
      if (closed) return;
      closed = true;
      // 先放行全部闸门：停在闸门上的调用不放行就永远不结束
      for (const g of Object.values(gates)) g.release();
      try { local.close(); } catch { /* 已关 */ }
      coordinator.stop();
      await rpc.close();
      await att.idle().catch(() => { /* 已停 */ });
      try { db.close(); } catch { /* 已关 */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
    },
  };
  return node;
}

/** 真实配对：listener 出配对码，dialer 跑产品的 remote.pair.join 并立即拨过去；等拨号方上线。
 *  mutual=true：加入时带上自己的监听端口，listener 学到地址后也拨回来（两端互拨）。 */
export async function pairNodes(dialer: AttNode, listener: AttNode, opts: { mutual?: boolean } = {}): Promise<void> {
  const begin = await listener.local.call('remote.pair.begin', {});
  await dialer.local.call('remote.pair.join', {
    host: '127.0.0.1', port: listener.port, pairingCode: begin.pairingCode, peerName: listener.name, listenPort: opts.mutual ? dialer.port : 0,
  });
  await waitFor(`${dialer.name} 拨到 ${listener.name}`, () => dialer.outbound.isOnline(listener.fp), 8000);
  if (opts.mutual) {
    listener.outbound.dialNow(dialer.fp);
    await waitFor(`${listener.name} 拨回 ${dialer.name}`, () => listener.outbound.isOnline(dialer.fp), 8000);
  }
}
