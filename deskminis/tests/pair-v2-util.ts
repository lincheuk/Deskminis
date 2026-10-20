/** F11C 认证配对测试的共用夹具（文件名不匹配 *.test.ts，vitest 不把它当用例跑）。
 *
 *  - bootNode：真 PairingStore + PairingService + createRemoteMethods + createAdditionalVerify + RpcServer，手工装配。
 *    它和 minisd/index.ts 的真实接线不是同一段代码；真实接线上的路径由 tests/pair-v2-minisd.test.ts 另测。
 *  - FaultVault：按谓词让 vault 的读写出错，并记下每一次写入（能读出握手中写入过的密钥）。
 *  - mitm：WebSocket 层的中继（记录解码后的帧，可改写、丢弃、关闭、用闸门卡住）。
 *  - tap：原始 TCP 转发器（记字节）。
 *  - rawPair：手工帧客户端；FakeJoiner / fakeHost：直接用生产的纯函数加任意 w 拼出的对端（不经 scrypt）。
 *  时序一律靠闸门、注入的时钟与条件等待，不靠固定 sleep 猜。 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, connect as tcpConnect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { expect } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { InMemoryVault, type SecretVault } from '../src/minisd/store/provider-store';
import { PairingService, PairingStore, StaticIdentity, type PairingEvent } from '../src/minisd/remote/pairing';
import { createAdditionalVerify, createRemoteMethods, guardBusinessMethod } from '../src/minisd/remote';
import { beginClientHandshake, type ChannelKeys, type FrameCipher } from '../src/minisd/remote/channel';
import {
  derivePairingMaterial, encodePairConfirm, encodePairHello, encodePairReply, fingerprintOfPublicKey,
  pairContextHash, pairIdentity, parsePairConfirm, parsePairHello, parsePairReply,
  PAIR_DONE_FRAME, PAIR_FAIL_FRAME,
} from '../src/minisd/remote/pair-proto';
import { spake2Finish, spake2Password, spake2Share, SPAKE2_ORDER, type Spake2Output } from '../src/minisd/remote/spake2';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import { OutboundClient } from '../src/minisd/sync/outbound-client';
import { pairErrorCodeOf, type PairErrorCode, type PairingPolicy } from '../src/shared/pairing';

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 等条件成立（条件抛错视为未就绪）。用于「等某个事件已经发生」，不是用固定时长猜时序。 */
export async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await cond()) return; } catch { /* 未就绪 */ }
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(5);
  }
}

/** 闸门：测试拿着 open()，被卡住的一方等 wait。 */
export function gate(): { wait: Promise<void>; open(): void; opened: boolean } {
  let open!: () => void;
  const g = { wait: new Promise<void>(r => { open = r; }), open: () => { g.opened = true; open(); }, opened: false };
  return g;
}

/** 可拨动的时钟（毫秒）。 */
export function fakeClock(start = 1_800_000_000_000): { now: () => number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ---- vault ----

export type VaultOp = 'set' | 'get' | 'delete';
/** 'throw'：这一次操作抛错；'ignore'：这一次操作不生效（set / delete 什么都不做，get 读成不存在——模拟吞掉错误的凭据库）。 */
export type VaultFault = (op: VaultOp, key: string) => 'throw' | 'ignore' | undefined;

export class FaultVault implements SecretVault {
  readonly inner = new InMemoryVault();
  fault: VaultFault = () => undefined;
  /** 每一次 set / delete（不论成败）的键与值：抓实际副作用。 */
  readonly log: Array<{ op: 'set' | 'delete'; key: string; value?: string; applied: boolean }> = [];

  set(k: string, v: string): void {
    const f = this.fault('set', k);
    this.log.push({ op: 'set', key: k, value: v, applied: f === undefined });
    if (f === 'throw') throw new Error('FaultVault: set 失败');
    if (f === 'ignore') return;
    this.inner.set(k, v);
  }
  get(k: string): string | undefined {
    const f = this.fault('get', k);
    if (f === 'throw') throw new Error('FaultVault: get 失败');
    if (f === 'ignore') return undefined;
    return this.inner.get(k);
  }
  delete(k: string): void {
    const f = this.fault('delete', k);
    this.log.push({ op: 'delete', key: k, applied: f === undefined });
    if (f === 'throw') throw new Error('FaultVault: delete 失败');
    if (f === 'ignore') return;
    this.inner.delete(k);
  }
  /** 握手中往 pairing.<fp> 写入过的全部密钥（不论那次写入后来是否被回滚）。 */
  writtenKeys(fp: string): ChannelKeys[] {
    return this.log.filter(e => e.op === 'set' && e.key === `pairing.${fp}` && e.value).map(e => keysOfRaw(e.value!));
  }
  setsOf(fp: string): number { return this.log.filter(e => e.op === 'set' && e.key === `pairing.${fp}`).length; }
  pairingSets(): string[] { return this.log.filter(e => e.op === 'set' && e.key.startsWith('pairing.') && e.key !== 'pairing.static-identity').map(e => e.key); }
}

export function keysOfRaw(raw: string): ChannelKeys {
  const o = JSON.parse(raw) as { authKey: string; sessionSecret: string };
  return { authKey: new Uint8Array(Buffer.from(o.authKey, 'base64')), sessionSecret: new Uint8Array(Buffer.from(o.sessionSecret, 'base64')) };
}

// ---- 本机 local 连接 ----

export interface RpcClient {
  ws: WebSocket;
  notifications: Array<{ method: string; params: unknown }>;
  call(method: string, params?: unknown): Promise<any>;
  close(): void;
}
export function wsConnect(url: string): Promise<RpcClient> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let idc = 0;
    const pending = new Map<number, (m: any) => void>();
    const notifications: Array<{ method: string; params: unknown }> = [];
    ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      else if (msg.method) notifications.push(msg);
    });
    ws.on('open', () => res({
      ws, notifications,
      // 错误串原样透出（不加方法名前缀）：pairErrorCodeOf 要从开头取码
      call: (method, params) => new Promise((resolve, reject) => {
        const id = ++idc;
        pending.set(id, m => m.error ? reject(new Error(String(m.error.message ?? JSON.stringify(m.error)))) : resolve(m.result));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
      }),
      close: () => { try { ws.close(); } catch { /* */ } },
    }));
    ws.on('error', rej);
  });
}

/** 调一个预期失败的 RPC，返回 PairError 的码（不是 PairError 的失败返回原消息，成功返回 undefined）。 */
export async function pairCodeOf(p: Promise<unknown>): Promise<PairErrorCode | string | undefined> {
  try { await p; return undefined; } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return pairErrorCodeOf(msg) ?? `非 PairError: ${msg}`;
  }
}

// ---- 节点 ----

export interface NodeOpts {
  vault?: SecretVault;
  now?: () => number;
  policy?: PairingPolicy;
  pairStepMs?: number;
  joinStepMs?: number;
  codeTtlMs?: number;
}
export interface TestNode {
  dir: string;
  vault: SecretVault;
  store: PairingStore;
  service: PairingService;
  rpc: RpcServer;
  outbound: OutboundClient;
  port: number;
  fp: string;
  token: string;
  local: RpcClient;
  events: PairingEvent[];
  /** 走到 additionalVerify（?pairingCode= / ?paseto=）的升级请求的查询串。?pair=2 与 ?ch=1 不经过它。 */
  upgradeLog: string[];
  /** 业务方法 echo 的每一次调用（按连接的 authMode 与对端指纹）。 */
  echoCalls: Array<{ authMode: string; fp: string | undefined }>;
  policy: { value: PairingPolicy };
  isPaired(fp: string): boolean;
  close(): Promise<void>;
}

export type Cleanups = Array<() => Promise<void> | void>;

export async function bootNode(cleanups: Cleanups, opts: NodeOpts = {}): Promise<TestNode> {
  const dir = mkdtempSync(join(tmpdir(), 'dm-pairv2-'));
  const vault = opts.vault ?? new InMemoryVault();
  const store = new PairingStore(dir, vault);
  const policy = { value: opts.policy ?? ('authenticated' as PairingPolicy) };
  const events: PairingEvent[] = [];
  const service = new PairingService(store, vault, {
    policy: { get: () => policy.value, set: p => { policy.value = p; } },
    now: opts.now, joinStepMs: opts.joinStepMs, codeTtlMs: opts.codeTtlMs,
    onEvent: e => { events.push(e); },
  });
  const echoCalls: TestNode['echoCalls'] = [];
  const isPaired = (fp: string): boolean => service.get(fp) !== undefined;
  let rpc!: RpcServer;
  const outbound = new OutboundClient(service, service.myFingerprint, { reconnectBackoffMs: [50] });
  const syncOpts = { pairingService: service, listenPort: 0 };
  const methods: RpcMethods = {
    echo: (p: unknown, conn: RpcConnection) => { echoCalls.push({ authMode: conn.authMode, fp: conn.peerFingerprint }); return p; },
    'permission.respond': (_p: unknown, conn: RpcConnection) => { echoCalls.push({ authMode: conn.authMode, fp: conn.peerFingerprint }); return { ok: true }; },
    ...createSyncMethods(null as any, syncOpts),
  };
  // 与 minisd/index.ts 相同：remote.* 以外的方法统一包业务守卫
  for (const k of Object.keys(methods)) (methods as any)[k] = guardBusinessMethod((methods as any)[k], k, isPaired);
  Object.assign(methods, createRemoteMethods(service, { getOutbound: () => outbound, getRpcServer: () => rpc }));
  const av = createAdditionalVerify(service);
  const upgradeLog: string[] = [];
  const recorder = Object.assign(
    (info: Parameters<typeof av>[0]) => { upgradeLog.push(info.url.search); return av(info); },
    { channel: av.channel, pairing: av.pairing },
  );
  const token = 'LOCAL-TOKEN';
  rpc = new RpcServer(methods, token, recorder, { pairStepMs: opts.pairStepMs });
  const port = await rpc.listen('127.0.0.1', 0);
  syncOpts.listenPort = port;
  const local = await wsConnect(`ws://127.0.0.1:${port}/?token=${token}`);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    local.close();
    outbound.stop();
    await rpc.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  };
  cleanups.push(close);
  return { dir, vault, store, service, rpc, outbound, port, fp: service.myFingerprint, token, local, events, upgradeLog, echoCalls, policy, isPaired, close };
}

/** H 发起（经 local RPC）、J 加入。port 缺省是 H 的端口；测试可以换成中继的端口。 */
export async function beginOn(h: TestNode): Promise<{ code: string; protocol: number; attempts?: number }> {
  const r = await h.local.call('remote.pair.begin', {});
  return { code: String(r.pairingCode), protocol: r.protocol, attempts: r.attempts };
}
export function joinVia(j: TestNode, port: number, code: string, extra: { peerName?: string; listenPort?: number } = {}): Promise<any> {
  return j.local.call('remote.pair.join', { host: '127.0.0.1', port, pairingCode: code, ...extra });
}

// ---- 无残留断言 ----

function fileText(dir: string, name: string): string {
  const f = join(dir, name);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

/** 这个指纹在 node 上没有任何业务权限：没有生效的记录、不在线、业务方法没被非本机连接调到过、泄露的密钥握不了通道。 */
export async function expectNoAccess(node: TestNode, fp: string, leakedKeys: ChannelKeys[] = []): Promise<void> {
  const st = await node.local.call('remote.status');
  expect(st.devices.map((d: any) => d.peerFingerprint), 'remote.status 里不该有它').not.toContain(fp);
  expect(node.store.get(fp), 'store.get').toBeUndefined();
  expect(node.store.list().map(d => d.peerFingerprint)).not.toContain(fp);
  expect(node.isPaired(fp)).toBe(false);
  expect(node.echoCalls.filter(c => c.authMode !== 'local'), '业务方法不该被非本机连接调到').toEqual([]);
  expect(node.rpc.isInboundOnline(fp)).toBe(false);
  expect(node.outbound.isOnline(fp)).toBe(false);
  for (const keys of leakedKeys) {
    const d = await chDial(node.port, keys, fp, node.fp);
    expect(d.accepted, '握手中出现过的密钥不该握得上加密通道').toBe(false);
    d.close();
  }
}

/** expectNoAccess 之外，持久化的三处也没有它：vault、索引、地址簿。 */
export async function expectNoResidue(node: TestNode, fp: string, leakedKeys: ChannelKeys[] = []): Promise<void> {
  await expectNoAccess(node, fp, leakedKeys);
  const raw = node.vault instanceof FaultVault ? node.vault.inner.get(`pairing.${fp}`) : node.vault.get(`pairing.${fp}`);
  expect(raw, 'vault 里不该有 pairing.<fp>').toBeUndefined();
  expect(fileText(node.dir, 'pairing-index.json')).not.toContain(fp);
  expect(fileText(node.dir, 'peer-addresses.json')).not.toContain(fp);
}

// ---- 加密通道拨号（用给定密钥握 ?ch=1） ----

export interface ChDial {
  accepted: boolean;
  /** 握手之后收到的帧数（握手被受理时不含 accept 那一帧）。 */
  framesAfter(): number;
  /** 这条连接上收到的全部帧数（含握手应答）。握手没被受理时应当是 0。 */
  totalFrames(): number;
  closed: Promise<number>;
  isClosed(): boolean;
  /** 握手被受理后，在加密通道上调一个方法；返回解密后的回包，对端不回（连接被关）则 undefined。 */
  call(method: string, params?: unknown): Promise<any>;
  /** 在加密通道上发一个请求，不等回包（配合 stall 用：停读之后回包本来就收不到）。 */
  post(method: string, params?: unknown): void;
  /** 从现在起不再读入站数据：收不到、也就回不了对端的 close 帧——模拟不配合关闭握手的对端。照样能发。 */
  stall(): void;
  close(): void;
}
export function chDial(port: number, keys: ChannelKeys, myFp: string, peerFp: string, timeoutMs = 3000, alsoSend?: string): Promise<ChDial> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?ch=1`);
    const hs = beginClientHandshake(keys, myFp, peerFp);
    let cipher: FrameCipher | undefined;
    let after = 0;
    let total = 0;
    let isClosed = false;
    let settled = false;
    let posted = 0;
    const replies: any[] = [];
    let closeResolve!: (c: number) => void;
    const closed = new Promise<number>(r => { closeResolve = r; });
    const handle = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        accepted, framesAfter: () => after, totalFrames: () => total, closed, isClosed: () => isClosed,
        call: async (method, params) => {
          if (!cipher || isClosed) return undefined;
          const id = 1000 + replies.length + after;
          ws.send(cipher.seal(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })));
          let found: any;
          await waitFor(`${method} 的回包或连接关闭`, () => { found = replies.find(r => r.id === id); return found !== undefined || isClosed; }, timeoutMs);
          return found;
        },
        post: (method, params) => {
          if (!cipher) return;
          // 对端若已把套接字销毁，这里的写入可能报错：那正是「发不进去」，不算测试自己的错
          try { ws.send(cipher.seal(JSON.stringify({ jsonrpc: '2.0', id: 5000 + posted++, method, params: params ?? {} })), () => { /* 见上 */ }); } catch { /* 见上 */ }
        },
        stall: () => { ws.pause(); },
        close: () => { try { ws.terminate(); } catch { /* */ } },
      });
    };
    const timer = setTimeout(() => handle(false), timeoutMs);
    // alsoSend：紧跟在握手帧后面再发一帧明文（验证握手没被受理时它得不到任何回包）
    ws.on('open', () => { ws.send(hs.hello); if (alsoSend !== undefined) ws.send(alsoSend); });
    ws.on('message', (raw, isBinary) => {
      total++;
      if (!cipher) {
        if (isBinary) { handle(false); return; }
        try { cipher = hs.finish(String(raw)); handle(true); } catch { handle(false); }
        return;
      }
      after++;
      try { replies.push(JSON.parse(cipher.open(new Uint8Array(raw as Buffer)))); } catch { /* 解不开的帧只计数 */ }
    });
    ws.on('close', code => { isClosed = true; closeResolve(code); handle(false); });
    ws.on('error', () => { /* close 随后到 */ });
  });
}

// ---- 手工帧客户端 ----

export interface RawConn {
  /** 升级被拒时的状态码；连上了是 undefined。 */
  status?: number;
  ws?: WebSocket;
  frames: string[];
  binaryFrames: number;
  closed: Promise<number>;
  isClosed(): boolean;
  send(text: string): void;
  sendBinary(b: Uint8Array): void;
  /** 等到共收到 n 帧文本；连接先关了就返回 false。 */
  waitFrames(n: number, ms?: number): Promise<boolean>;
  close(): void;
}
export function rawConnect(url: string, wsOpts: { origin?: string } = {}): Promise<RawConn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, wsOpts);
    const frames: string[] = [];
    let binaryFrames = 0;
    let isClosed = false;
    let closeResolve!: (c: number) => void;
    const closed = new Promise<number>(r => { closeResolve = r; });
    const conn: RawConn = {
      ws, frames, get binaryFrames() { return binaryFrames; }, closed, isClosed: () => isClosed,
      send: t => ws.send(t),
      sendBinary: b => ws.send(b, { binary: true }),
      waitFrames: async (n, ms = 3000) => {
        await waitFor(`第 ${n} 帧或连接关闭`, () => frames.length >= n || isClosed, ms);
        return frames.length >= n;
      },
      close: () => { try { ws.terminate(); } catch { /* */ } },
    };
    ws.on('message', (raw, isBinary) => { if (isBinary) binaryFrames++; else frames.push(String(raw)); });
    ws.on('close', code => { isClosed = true; closeResolve(code); });
    ws.on('open', () => resolve(conn));
    ws.on('unexpected-response', (_req, res) => {
      isClosed = true;
      closeResolve(0);
      resolve({ ...conn, ws: undefined, status: res.statusCode, frames, closed, isClosed: () => true });
      try { _req.destroy(); } catch { /* */ }
    });
    ws.on('error', e => { if (!isClosed && ws.readyState !== WebSocket.OPEN) reject(e); });
  });
}
export const rawPair = (port: number, wsOpts: { origin?: string } = {}): Promise<RawConn> => rawConnect(`ws://127.0.0.1:${port}/?pair=2`, wsOpts);

/** 发一个升级请求，只看结局：连上了（'open'）、被拒（状态码），或时限内没有任何应答（'no-response'）。
 *  最后一种是「服务端在升级回调里抛了异常」的样子：既没有 101 也没有 4xx，套接字干挂着。
 *  rawConnect 遇到这种情况会一直等下去；这里到点自己掐断，不把挂着的套接字留给收尾（否则服务端关不掉）。 */
export function upgradeOutcome(url: string, timeoutMs = 3000): Promise<number | 'open' | 'no-response'> {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    let settled = false;
    const settle = (r: number | 'open' | 'no-response'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* */ }
      resolve(r);
    };
    const timer = setTimeout(() => settle('no-response'), timeoutMs);
    ws.on('open', () => settle('open'));
    ws.on('unexpected-response', (req, res) => { const code = res.statusCode ?? 0; try { req.destroy(); } catch { /* */ } settle(code); });
    ws.on('error', () => { /* 被拒之后掐断请求会报错；真正的结局由上面三条给出 */ });
  });
}

// ---- 攻击者 / 手工对端：生产的纯函数加任意 w，不经 scrypt ----

/** 随机的 w：不知道码的攻击者的一次猜测。 */
export function randomW(): bigint {
  const w = BigInt('0x' + randomBytes(40).toString('hex')) % SPAKE2_ORDER;
  return w === 0n ? 1n : w;
}

/** 手工的加入端（SPAKE2 的 A）。给它正确的 w 就是「知道码的 J」，给随机的 w 就是猜码的攻击者。 */
export class FakeJoiner {
  readonly identity: StaticIdentity;
  readonly fp: string;
  private pw;
  private own: { scalar: bigint; share: Uint8Array } | undefined;
  private ctxH: Uint8Array | undefined;
  out: Spake2Output | undefined;
  hostId: Uint8Array | undefined;
  constructor(w: bigint, identity = new StaticIdentity()) {
    this.identity = identity;
    this.fp = identity.fingerprint;
    this.pw = spake2Password(w);
  }
  hello(name = '', listenPort = 0, override: { id?: Uint8Array; pA?: Uint8Array } = {}): string {
    this.own = spake2Share('A', this.pw);
    this.ctxH = pairContextHash({ name, listenPort });
    return encodePairHello({ id: override.id ?? this.identity.publicKey, name, listenPort, pA: override.pA ?? this.own.share });
  }
  /** 处理 reply：返回对端的 cB 对不对（对 = 两端的 w 相同）。 */
  onReply(text: string): { cBok: boolean } {
    const m = parsePairReply(text);
    this.hostId = m.id;
    this.out = spake2Finish({
      role: 'A', pw: this.pw, scalar: this.own!.scalar, pA: this.own!.share, pB: m.pB,
      idA: pairIdentity('joiner', this.identity.publicKey), idB: pairIdentity('host', m.id), aad: this.ctxH!,
    });
    return { cBok: m.cB.length === this.out.cB.length && timingSafeEqual(Buffer.from(m.cB), Buffer.from(this.out.cB)) };
  }
  confirm(cA?: Uint8Array): string { return encodePairConfirm({ cA: cA ?? this.out!.cA }); }
  /** 握手成功时两端导出的配对密钥。 */
  keys(): ChannelKeys {
    const m = derivePairingMaterial(this.out!.Ke, this.ctxH!);
    return { authKey: m.authKey, sessionSecret: m.sessionSecret };
  }
}

export interface FakeHost {
  port: number;
  identity: StaticIdentity;
  fp: string;
  /** 收到的帧（解码后的文本），按到达顺序。 */
  received: string[];
  /** 收到的升级请求的 URL。 */
  urls: string[];
  /** 收到 confirm 且 cA 正确时导出的配对密钥。 */
  keys(): ChannelKeys | undefined;
  /** 收到 confirm（不论对错）。 */
  confirmSeen: Promise<void>;
  /** 放行收尾帧（behaviour 为 gated-* 时）。 */
  release(): void;
  close(): Promise<void>;
}
/** 手工的发起端（SPAKE2 的 B）：一个 WebSocket 服务器，按给定的 w 走握手。
 *  onConfirm：收到 confirm 之后怎么收尾——'done' 回 done；'fail' 回 fail；'silent' 什么都不回（也不关）；
 *  'gated-done' / 'gated-fail' 等 release() 之后再回。 */
export async function fakeHost(cleanups: Cleanups, o: {
  w: bigint;
  onConfirm?: 'done' | 'fail' | 'silent' | 'gated-done' | 'gated-fail';
  /** 改写要发出的 reply（测试角色反射等）。 */
  reply?: (hello: ReturnType<typeof parsePairHello>, honest: { id: Uint8Array; pB: Uint8Array; cB: Uint8Array }) => string;
}): Promise<FakeHost> {
  const identity = new StaticIdentity();
  const pw = spake2Password(o.w);
  const received: string[] = [];
  const urls: string[] = [];
  let keys: ChannelKeys | undefined;
  const seen = gate();
  const rel = gate();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => wss.on('listening', () => r()));
  wss.on('connection', (ws, req) => {
    urls.push(req.url ?? '');
    let out: Spake2Output | undefined;
    let ctxH: Uint8Array | undefined;
    ws.on('error', () => { /* */ });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const text = String(raw);
      received.push(text);
      if (!out) {
        let h;
        try { h = parsePairHello(text); } catch { ws.send(PAIR_FAIL_FRAME); ws.close(); return; }
        const own = spake2Share('B', pw);
        ctxH = pairContextHash({ name: h.name, listenPort: h.listenPort });
        out = spake2Finish({
          role: 'B', pw, scalar: own.scalar, pA: h.pA, pB: own.share,
          idA: pairIdentity('joiner', h.id), idB: pairIdentity('host', identity.publicKey), aad: ctxH,
        });
        const honest = { id: identity.publicKey, pB: own.share, cB: out.cB };
        ws.send(o.reply ? o.reply(h, honest) : encodePairReply(honest));
        return;
      }
      let c;
      try { c = parsePairConfirm(text); } catch { ws.send(PAIR_FAIL_FRAME); ws.close(); return; }
      if (c.cA.length === out.cA.length && timingSafeEqual(Buffer.from(c.cA), Buffer.from(out.cA))) {
        const m = derivePairingMaterial(out.Ke, ctxH!);
        keys = { authKey: m.authKey, sessionSecret: m.sessionSecret };
      }
      seen.open();
      const mode = o.onConfirm ?? 'done';
      const finish = (frame: string): void => { try { ws.send(frame); ws.close(); } catch { /* */ } };
      if (mode === 'done') finish(PAIR_DONE_FRAME);
      else if (mode === 'fail') finish(PAIR_FAIL_FRAME);
      else if (mode === 'gated-done') void rel.wait.then(() => finish(PAIR_DONE_FRAME));
      else if (mode === 'gated-fail') void rel.wait.then(() => finish(PAIR_FAIL_FRAME));
    });
  });
  const close = (): Promise<void> => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); });
  cleanups.push(close);
  return {
    port: (wss.address() as { port: number }).port, identity, fp: fingerprintOfPublicKey(identity.publicKey),
    received, urls, keys: () => keys, confirmSeen: seen.wait, release: () => rel.open(), close,
  };
}

// ---- WebSocket 层中继 ----

export interface RelayFrame { dir: 'c2s' | 's2c'; index: number; text: string }
export type RelayAction = string | null | { close: true } | void;
export type RelayTransform = (f: RelayFrame) => RelayAction | Promise<RelayAction>;
export interface Relay {
  port: number;
  /** 双向全部解码后的帧（改写之前的原文）。 */
  frames: RelayFrame[];
  /** 实际转发出去的帧（改写之后）。 */
  forwarded: RelayFrame[];
  /** 每个升级请求的 URL 与头。 */
  upgrades: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}
/** WS 层中继：先带原样的查询串拨上游，上游放行才放行下游；上游拒绝则以同一状态码拒绝（401 能原样传回加入端）。
 *  transform 可返回改写后的文本、null（丢弃）、{close:true}，或一个 Promise（测试拿着闸门实现受控延迟）。 */
export async function mitm(cleanups: Cleanups, targetPort: number, transform?: RelayTransform): Promise<Relay> {
  const frames: RelayFrame[] = [];
  const forwarded: RelayFrame[] = [];
  const upgrades: Relay['upgrades'] = [];
  const ups = new Set<WebSocket>();
  const wss = new WebSocketServer({
    host: '127.0.0.1', port: 0,
    verifyClient: (info, cb) => {
      const url = info.req.url ?? '/';
      upgrades.push({ url, headers: { ...info.req.headers } });
      const up = new WebSocket(`ws://127.0.0.1:${targetPort}${url}`);
      ups.add(up);
      let settled = false;
      const early: Array<{ raw: Buffer; isBinary: boolean }> = [];
      (up as any).__early = early;
      up.on('message', (raw, isBinary) => { if ((up as any).__early) early.push({ raw: raw as Buffer, isBinary }); });
      up.once('open', () => { if (settled) return; settled = true; (info.req as any).__up = up; cb(true); });
      up.once('unexpected-response', (rq, res) => {
        if (settled) return; settled = true;
        try { rq.destroy(); } catch { /* */ }
        cb(false, res.statusCode ?? 502, 'Unauthorized');
      });
      up.on('error', () => { if (settled) return; settled = true; cb(false, 502, 'Bad Gateway'); });
    },
  });
  await new Promise<void>(r => wss.on('listening', () => r()));
  wss.on('connection', (down, req) => {
    const up = (req as any).__up as WebSocket;
    const pump = (dir: 'c2s' | 's2c', from: WebSocket, to: WebSocket): void => {
      let idx = 0;
      let chain: Promise<void> = Promise.resolve();
      const onMsg = (raw: Buffer, isBinary: boolean): void => {
        const index = idx++;
        chain = chain.then(async () => {
          if (isBinary) { if (to.readyState === WebSocket.OPEN) to.send(raw, { binary: true }); return; }
          const text = raw.toString('utf8');
          const f: RelayFrame = { dir, index, text };
          frames.push(f);
          const act = transform ? await transform(f) : undefined;
          if (act === null) return;
          if (typeof act === 'object' && act !== null) { try { down.close(); } catch { /* */ } try { up.close(); } catch { /* */ } return; }
          const outText = typeof act === 'string' ? act : text;
          forwarded.push({ dir, index, text: outText });
          if (to.readyState === WebSocket.OPEN) to.send(outText);
        }).catch(() => { /* 中继自己的错不影响测试断言 */ });
      };
      if (dir === 's2c') {
        const early = (from as any).__early as Array<{ raw: Buffer; isBinary: boolean }>;
        (from as any).__early = undefined;
        for (const e of early) onMsg(e.raw, e.isBinary);
      }
      from.on('message', (raw, isBinary) => onMsg(raw as Buffer, isBinary));
      // 一侧关了：等排队的帧都处理完再关另一侧
      from.on('close', () => { void chain.then(() => { try { to.close(); } catch { /* */ } }); });
      from.on('error', () => { /* close 随后到 */ });
    };
    pump('c2s', down, up);
    pump('s2c', up, down);
  });
  const close = (): Promise<void> => new Promise(r => {
    for (const c of wss.clients) c.terminate();
    for (const u of ups) { try { u.terminate(); } catch { /* */ } }
    wss.close(() => r());
  });
  cleanups.push(close);
  return { port: (wss.address() as { port: number }).port, frames, forwarded, upgrades, close };
}

// ---- 原始 TCP 转发器 ----

export async function tap(cleanups: Cleanups, targetPort: number): Promise<{ port: number; c2s: () => Buffer; s2c: () => Buffer; all: () => Buffer }> {
  const up: Buffer[] = [];
  const down: Buffer[] = [];
  const live = new Set<{ destroy(): void }>();
  const server: Server = createServer(sock => {
    const upstream = tcpConnect(targetPort, '127.0.0.1');
    live.add(sock); live.add(upstream);
    sock.on('data', (d: Buffer) => { up.push(d); upstream.write(d); });
    upstream.on('data', (d: Buffer) => { down.push(d); sock.write(d); });
    const end = (): void => { sock.destroy(); upstream.destroy(); live.delete(sock); live.delete(upstream); };
    sock.on('close', end); upstream.on('close', end); sock.on('error', end); upstream.on('error', end);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  // 收尾时先掐断还开着的转发连接（配对成功后的 ?ch=1 长连接会经过这里），否则 server.close 等不到结束
  cleanups.push(() => new Promise<void>(r => { for (const s of [...live]) s.destroy(); server.close(() => r()); }));
  return {
    port: (server.address() as { port: number }).port,
    c2s: () => Buffer.concat(up), s2c: () => Buffer.concat(down), all: () => Buffer.concat([...up, ...down]),
  };
}

/** 只数连接、不应答的假服务器：验证「本地拒绝的输入没有发出任何网络请求」「没有改走明文路径」。 */
export async function countingServer(cleanups: Cleanups): Promise<{ port: number; connections: () => number; requests: string[] }> {
  let n = 0;
  const requests: string[] = [];
  const server: Server = createServer(sock => {
    n++;
    sock.on('data', (d: Buffer) => { requests.push(d.toString('latin1')); sock.destroy(); });
    sock.on('error', () => { /* */ });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>(r => server.close(() => r())));
  return { port: (server.address() as { port: number }).port, connections: () => n, requests };
}
