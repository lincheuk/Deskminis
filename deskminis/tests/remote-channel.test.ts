/**
 * W3-sec6（安全审计第 2 条）：设备之间的远程连接走加密通道。
 *
 * 以前出站连接是 ws://…/?paseto=<令牌>，令牌在 URL 里明文走网络，之后的 JSON-RPC 帧（聊天内容、权限请求全文、同步的消息）
 * 也是明文——同一网络里的人在链路上直接读得到（审计用本机 TCP 转发器复现）。
 *
 * 现在：连 ?ch=1，第一帧是 hello（PASETO v4.local 用配对密钥 authKey 加密认证，里面带临时 X25519 公钥、jti、aud、exp）；
 * 服务端回 accept（自己的临时公钥 + HMAC(authKey, 握手记录)）；两端用临时 ECDH 结果、以配对时派生的 sessionSecret 为盐做 HKDF，
 * 得出两个方向各一把 XChaCha20-Poly1305 密钥，之后每一帧都加密，nonce 由方向与逐帧递增的计数构成（不随帧发送）——
 * 重放、乱序、丢帧、篡改都解不开，当场断开。网络来源只认这条路：?paseto= 只留给本机回环（测试与 e2e 脚本）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createServer, connect as tcpConnect, type Server } from 'node:net';
import { WebSocket } from 'ws';
import { x25519 } from '@noble/curves/ed25519.js';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService, derivePairingKey, type PairingKey } from '../src/minisd/remote/pairing';
import { createAdditionalVerify, createRemoteMethods } from '../src/minisd/remote';
import { encodePaseto } from '../src/minisd/remote/paseto';
import { RpcServer, type RpcMethods } from '../src/minisd/rpc/server';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import { OutboundClient } from '../src/minisd/sync/outbound-client';
import * as channelModule from '../src/minisd/remote/channel';

type Cipher = { seal(text: string): Uint8Array; open(frame: Uint8Array): string };
type Accept = { ok: true; peerFingerprint: string; reply: string; cipher: Cipher } | { ok: false };
interface ChannelApi {
  beginClientHandshake(keys: { authKey: Uint8Array; sessionSecret: Uint8Array }, myFp: string, peerFp: string, opts?: { now?: number }): { hello: string; finish(reply: string): Cipher };
}
const ch = channelModule as unknown as ChannelApi;
type WithChannel = { channel?: (hello: string) => Accept };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/** 两端互存对方的 PairingKey（同 sync-hello-version.test.ts 的做法）。 */
function setupMutualPair(): { serviceA: PairingService; fpA: string; serviceB: PairingService; fpB: string; keyAtA: PairingKey } {
  const dirA = mkdtempSync(join(tmpdir(), 'dm-ch-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'dm-ch-b-'));
  cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });
  const vaultA = new InMemoryVault();
  const vaultB = new InMemoryVault();
  const storeA = new PairingStore(dirA, vaultA);
  const storeB = new PairingStore(dirB, vaultB);
  const serviceA = new PairingService(storeA, vaultA);
  const serviceB = new PairingService(storeB, vaultB);
  const privA = (serviceA as any).identity.privateKey as Uint8Array;
  const privB = (serviceB as any).identity.privateKey as Uint8Array;
  const keyAtA = derivePairingKey(privA, serviceB.myPublicKey, 'CHCODE01', serviceB.myFingerprint, 'B');
  storeA.save(keyAtA);
  storeB.save(derivePairingKey(privB, serviceA.myPublicKey, 'CHCODE01', serviceA.myFingerprint, 'A'));
  return { serviceA, fpA: serviceA.myFingerprint, serviceB, fpB: serviceB.myFingerprint, keyAtA };
}

/** B 侧的通道受理器：与引擎同一来源（createAdditionalVerify 带出来的 channel）。 */
function acceptorOf(service: PairingService): (hello: string) => Accept {
  const verify = createAdditionalVerify(service) as unknown as WithChannel;
  expect(verify.channel, 'createAdditionalVerify 没有带出 channel 受理器').toBeTypeOf('function');
  return verify.channel!;
}

/** 在 B 上跑一次完整握手，返回两端的 cipher。 */
function handshake(p = setupMutualPair()): { client: Cipher; server: Cipher; p: ReturnType<typeof setupMutualPair> } {
  const accept = acceptorOf(p.serviceB);
  const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
  const r = accept(hs.hello);
  if (!r.ok) throw new Error('服务端拒了合法的 hello');
  expect(r.peerFingerprint).toBe(p.fpA);
  return { client: hs.finish(r.reply), server: r.cipher, p };
}

const helloToken = (hello: string): string => (JSON.parse(hello) as { token: string }).token;
/** 用 A 的 authKey 铸一个 hello，payload 可改，测服务端的各项校验。 */
function forgeHello(key: PairingKey, payload: Record<string, unknown>): string {
  return JSON.stringify({ t: 'dm.ch.hello', v: 1, token: encodePaseto(payload as any, key.authKey) });
}

describe('① 握手与逐帧加密', () => {
  it('两个方向各发几帧都能解开；同一侧的 cipher 解不开自己发出的帧（两个方向两把钥匙）', () => {
    const { client, server } = handshake();
    for (const text of ['{"a":1}', '中文 ✓ 🙂', 'x'.repeat(70_000)]) {
      expect(server.open(client.seal(text))).toBe(text);
      expect(client.open(server.seal(text))).toBe(text);
    }
    expect(() => client.open(client.seal('self'))).toThrow();
  });

  it('密文里看不到明文；同一句话连发两次，两帧密文不同（计数进了 nonce）', () => {
    const { client } = handshake();
    const a = Buffer.from(client.seal('SECRET-MARKER-123'));
    const b = Buffer.from(client.seal('SECRET-MARKER-123'));
    expect(a.includes(Buffer.from('SECRET-MARKER-123'))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it('篡改一个字节、重放、乱序、跳帧都解不开', () => {
    const { client, server } = handshake();
    const f1 = Buffer.from(client.seal('one'));
    const tampered = Buffer.from(f1); tampered[tampered.length - 1] ^= 1;
    expect(() => server.open(tampered)).toThrow();

    const { client: c2, server: s2 } = handshake();
    const g1 = c2.seal('one'), g2 = c2.seal('two');
    expect(() => s2.open(g2)).toThrow(); // 跳过第一帧

    const { client: c3, server: s3 } = handshake();
    const h1 = c3.seal('one');
    expect(s3.open(h1)).toBe('one');
    expect(() => s3.open(h1)).toThrow(); // 重放
    void g1;
  });

  it('每次握手的密钥都不同：上一条连接的帧，下一条连接解不开（临时 ECDH）', () => {
    const p = setupMutualPair();
    const first = handshake(p);
    const second = handshake(p);
    expect(() => second.server.open(first.client.seal('old'))).toThrow();
  });

  it('帧密钥绑着配对时派生的 sessionSecret：只拿到 authKey 的一方握得了手、解不开帧', () => {
    const p = setupMutualPair();
    const api = channelModule as unknown as { acceptChannelHello(hello: string, deps: unknown): Accept };
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    const keyAtB = p.serviceB.get(p.fpA)!;
    const r = api.acceptChannelHello(hs.hello, {
      myFingerprint: p.fpB,
      candidates: () => [{ peerFingerprint: p.fpA, keys: { authKey: keyAtB.authKey, sessionSecret: new Uint8Array(32).fill(9) } }],
      rememberJti: () => true,
    });
    if (!r.ok) throw new Error('authKey 对得上就该受理');
    const client = hs.finish(r.reply);
    expect(() => r.cipher.open(client.seal('x'))).toThrow();
  });

  it('hello 里没有明文的指纹与公钥：整帧只有版本号与一段 PASETO', () => {
    const p = setupMutualPair();
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    const parsed = JSON.parse(hs.hello);
    expect(Object.keys(parsed).sort()).toEqual(['t', 'token', 'v']);
    expect(parsed.token.startsWith('v4.local.')).toBe(true);
    expect(hs.hello).not.toContain(p.fpA);
  });
});

describe('② 服务端拒收的 hello', () => {
  const now = Date.now();
  const epk = (): string => Buffer.from(x25519.keygen().publicKey).toString('base64url');

  it('同一个 hello 第二次来（jti 重放）→ 拒', () => {
    const p = setupMutualPair();
    const accept = acceptorOf(p.serviceB);
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    expect(accept(hs.hello).ok).toBe(true);
    expect(accept(hs.hello).ok).toBe(false);
  });

  it.each([
    ['aud 不是本机', (fpB: string) => ({ aud: 'ffffffffffff', fpB })],
    ['没有 jti', () => ({ jti: undefined })],
    ['没有 epk', () => ({ epk: undefined })],
    ['epk 长度不对', () => ({ epk: Buffer.alloc(31).toString('base64url') })],
    ['epk 是低阶点（全零）', () => ({ epk: Buffer.alloc(32).toString('base64url') })],
    ['已过期', () => ({ exp: now - 1 })],
  ])('%s → 拒', (_name, patch) => {
    const p = setupMutualPair();
    const accept = acceptorOf(p.serviceB);
    const base: Record<string, unknown> = { exp: now + 60_000, iat: now, device_fingerprint: p.fpA, jti: `j-${Math.random()}`, aud: p.fpB, epk: epk() };
    const patched = { ...base, ...(patch as (fpB: string) => Record<string, unknown>)(p.fpB) };
    delete (patched as any).fpB;
    expect(accept(forgeHello(p.keyAtA, patched)).ok).toBe(false);
  });

  it('不是用任何一把配对密钥加密的 hello → 拒；不是 JSON 或类型不对 → 拒', () => {
    const p = setupMutualPair();
    const accept = acceptorOf(p.serviceB);
    const stranger = { ...p.keyAtA, authKey: new Uint8Array(32).fill(7) };
    expect(accept(ch.beginClientHandshake(stranger, p.fpA, p.fpB).hello).ok).toBe(false);
    expect(accept('not json').ok).toBe(false);
    expect(accept(JSON.stringify({ t: 'dm.ch.hello', v: 2, token: 'x' })).ok).toBe(false);
  });

  it('客户端校验 accept：MAC 对不上（冒充的服务端、被改过的临时公钥）→ finish 抛错', () => {
    const p = setupMutualPair();
    const accept = acceptorOf(p.serviceB);
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    const r = accept(hs.hello);
    if (!r.ok) throw new Error('应当受理');
    const reply = JSON.parse(r.reply);
    const forgedEpk = JSON.stringify({ ...reply, epk: Buffer.from(x25519.keygen().publicKey).toString('base64url') });
    expect(() => hs.finish(forgedEpk)).toThrow();
    const forgedMac = JSON.stringify({ ...reply, mac: Buffer.alloc(32).toString('base64url') });
    const hs2 = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    expect(() => hs2.finish(forgedMac)).toThrow();
  });

  it('通道用的令牌拿去走 ?paseto= 老路径 → 拒（两条路的令牌互不通用）', async () => {
    const p = setupMutualPair();
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    const verify = createAdditionalVerify(p.serviceB);
    const r = await verify({ req: {} as any, url: new URL(`ws://x/?paseto=${encodeURIComponent(helloToken(hs.hello))}`) });
    expect(r.ok).toBe(false);
  });
});

// ---- ③ RpcServer 接上通道 ----

interface Raw { ws: WebSocket; frames: Buffer[]; closed: Promise<number> }
function rawConnect(url: string): Promise<Raw> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const frames: Buffer[] = [];
    const closed = new Promise<number>(r => ws.on('close', code => r(code)));
    ws.on('message', d => frames.push(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)));
    ws.on('open', () => res({ ws, frames, closed }));
    ws.on('error', rej);
  });
}
async function waitFrames(r: Raw, n: number, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (r.frames.length < n) { if (Date.now() - t0 > ms) throw new Error(`等第 ${n} 帧超时`); await sleep(10); }
}

async function bootB(p: ReturnType<typeof setupMutualPair>, host = '127.0.0.1', extra: RpcMethods = {}, opts: Record<string, unknown> = {}): Promise<{ rpc: RpcServer; port: number }> {
  const methods: RpcMethods = { ...createSyncMethods(null as any, { pairingService: p.serviceB, listenPort: 0 }), ...createRemoteMethods(p.serviceB), ...extra };
  const rpc = new RpcServer(methods, 'LOCAL-TOKEN', createAdditionalVerify(p.serviceB), opts as any);
  const port = await rpc.listen(host, 0);
  cleanups.push(() => rpc.close());
  return { rpc, port };
}

describe('③ RpcServer：?ch=1 先握手、再按加密帧收发', () => {
  it('握手之后调方法、收广播都走加密帧，链路上看不到明文；连接按 remote 记、带对端指纹', async () => {
    const p = setupMutualPair();
    let seen: { authMode?: string; fp?: string } = {};
    const { rpc, port } = await bootB(p, '127.0.0.1', { echo: (params, conn) => { seen = { authMode: conn.authMode, fp: conn.peerFingerprint }; return params; } });
    const r = await rawConnect(`ws://127.0.0.1:${port}/?ch=1`);
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    r.ws.send(hs.hello);
    await waitFrames(r, 1);
    const cipher = hs.finish(r.frames[0].toString('utf8'));
    expect(rpc.isInboundOnline(p.fpA)).toBe(true);

    r.ws.send(cipher.seal(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { m: 'SECRET-ECHO' } })));
    rpc.broadcast('chat.event', { text: 'SECRET-BROADCAST' });
    await waitFrames(r, 3);
    const wire = Buffer.concat(r.frames.slice(1));
    expect(wire.includes(Buffer.from('SECRET'))).toBe(false);
    const decoded = r.frames.slice(1).map(f => JSON.parse(cipher.open(new Uint8Array(f))));
    expect(decoded).toEqual(expect.arrayContaining([
      { jsonrpc: '2.0', id: 1, result: { m: 'SECRET-ECHO' } },
      { jsonrpc: '2.0', method: 'chat.event', params: { text: 'SECRET-BROADCAST' } },
    ]));
    expect(seen).toEqual({ authMode: 'remote', fp: p.fpA });
    r.ws.close();
  });

  it('握手之前：发明文请求 → 连接被关、没有回包；也收不到广播、不算在线', async () => {
    const p = setupMutualPair();
    let called = false;
    const { rpc, port } = await bootB(p, '127.0.0.1', { echo: () => { called = true; return 'x'; } });
    const r = await rawConnect(`ws://127.0.0.1:${port}/?ch=1`);
    rpc.broadcast('chat.event', { text: 'SECRET-BROADCAST' });
    r.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: {} }));
    await Promise.race([r.closed, sleep(2000).then(() => { throw new Error('握手前的明文请求没让连接关掉'); })]);
    expect(called).toBe(false);
    expect(r.frames).toEqual([]);
    expect(rpc.isInboundOnline(p.fpA)).toBe(false);
  });

  it('握手之后发明文帧（不是本通道的密文）→ 连接被关', async () => {
    const p = setupMutualPair();
    const { port } = await bootB(p, '127.0.0.1', { echo: (x) => x });
    const r = await rawConnect(`ws://127.0.0.1:${port}/?ch=1`);
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    r.ws.send(hs.hello);
    await waitFrames(r, 1);
    hs.finish(r.frames[0].toString('utf8'));
    r.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: {} }));
    await Promise.race([r.closed, sleep(2000).then(() => { throw new Error('明文帧没让连接关掉'); })]);
  });

  it('握手之后发一帧被改过的密文（二进制）→ 连接被关', async () => {
    const p = setupMutualPair();
    let called = false;
    const { port } = await bootB(p, '127.0.0.1', { echo: () => { called = true; return 'x'; } });
    const r = await rawConnect(`ws://127.0.0.1:${port}/?ch=1`);
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    r.ws.send(hs.hello);
    await waitFrames(r, 1);
    const cipher = hs.finish(r.frames[0].toString('utf8'));
    const frame = Buffer.from(cipher.seal(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'echo', params: {} })));
    frame[0] ^= 0xff;
    r.ws.send(frame);
    await Promise.race([r.closed, sleep(2000).then(() => { throw new Error('解不开的密文帧没让连接关掉'); })]);
    expect(called).toBe(false);
  });

  it('连上 ?ch=1 却一直不握手 → 到时由服务端关掉', async () => {
    const p = setupMutualPair();
    const { port } = await bootB(p, '127.0.0.1', {}, { channelHandshakeMs: 200 });
    const r = await rawConnect(`ws://127.0.0.1:${port}/?ch=1`);
    await Promise.race([r.closed, sleep(2000).then(() => { throw new Error('不握手的连接没有按时关掉'); })]);
  });

  const lanIp = (() => {
    for (const nets of Object.values(networkInterfaces())) for (const n of nets ?? []) if (n.family === 'IPv4' && !n.internal) return n.address;
    return undefined;
  })();
  it.skipIf(!lanIp)('网络来源：?paseto= 老路径一律拒（只留给本机回环），?ch=1 照常连得上', async () => {
    const p = setupMutualPair();
    const { port } = await bootB(p, '0.0.0.0');
    const legacy = encodePaseto({ exp: Date.now() + 60_000, iat: Date.now(), device_fingerprint: p.fpA }, p.keyAtA.authKey);
    await expect(rawConnect(`ws://${lanIp}:${port}/?paseto=${encodeURIComponent(legacy)}`)).rejects.toThrow(/401/);
    const viaLoopback = await rawConnect(`ws://127.0.0.1:${port}/?paseto=${encodeURIComponent(legacy)}`);
    viaLoopback.ws.close();
    const r = await rawConnect(`ws://${lanIp}:${port}/?ch=1`);
    const hs = ch.beginClientHandshake(p.keyAtA, p.fpA, p.fpB);
    r.ws.send(hs.hello);
    await waitFrames(r, 1);
    expect(() => hs.finish(r.frames[0].toString('utf8'))).not.toThrow();
    r.ws.close();
  });
});

// ---- ④ 真 OutboundClient 经过一个 TCP 转发器连 B：链路上记下的字节里没有明文 ----

async function tap(targetPort: number): Promise<{ port: number; bytes: () => Buffer }> {
  const chunks: Buffer[] = [];
  const server: Server = createServer(sock => {
    const up = tcpConnect(targetPort, '127.0.0.1');
    sock.on('data', (d: Buffer) => { chunks.push(d); up.write(d); });
    up.on('data', (d: Buffer) => { chunks.push(d); sock.write(d); });
    const end = (): void => { sock.destroy(); up.destroy(); };
    sock.on('close', end); up.on('close', end); sock.on('error', end); up.on('error', end);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>(r => server.close(() => r())));
  return { port: (server.address() as { port: number }).port, bytes: () => Buffer.concat(chunks) };
}

describe('④ 真出站客户端 + 链路转发器', () => {
  it('上线、同步互认、调方法、收通知：链路字节里没有消息内容，也没有 PASETO 令牌、配对密钥', async () => {
    const p = setupMutualPair();
    const { rpc, port } = await bootB(p, '127.0.0.1', { echo: (x) => x });
    const wire = await tap(port);
    ((p.serviceA as any).store as PairingStore).setAddress(p.fpB, `127.0.0.1:${wire.port}`);
    const client = new OutboundClient(p.serviceA, p.fpA, { pingIntervalMs: 10_000, pongTimeoutMs: 5_000, reconnectBackoffMs: [10_000], pasetoTtlMs: 60_000 });
    cleanups.push(() => client.stop());
    const dirty: string[] = [];
    client.onRemoteDirty = (_fp, sid) => dirty.push(sid);
    client.dialNow(p.fpB);
    const t0 = Date.now();
    while (!client.isOnline(p.fpB)) { if (Date.now() - t0 > 4000) throw new Error('出站客户端没上线'); await sleep(20); }

    expect(await client.callRpc(p.fpB, 'echo', { m: 'SECRET-CALL-MARKER' })).toEqual({ m: 'SECRET-CALL-MARKER' });
    rpc.broadcast('sync.dirty', { sessionId: 'SECRET-SESSION-MARKER' });
    const t1 = Date.now();
    while (dirty.length === 0) { if (Date.now() - t1 > 2000) throw new Error('没收到加密通道上的 sync.dirty'); await sleep(10); }
    expect(dirty).toEqual(['SECRET-SESSION-MARKER']);

    const bytes = wire.bytes();
    expect(bytes.length).toBeGreaterThan(0);
    for (const needle of ['SECRET-CALL-MARKER', 'SECRET-SESSION-MARKER', 'sync.hello', 'paseto=', Buffer.from(p.keyAtA.authKey).toString('hex')]) {
      expect(bytes.includes(Buffer.from(needle)), `链路上看得到 ${needle}`).toBe(false);
    }
    expect(bytes.includes(Buffer.from('?ch=1'))).toBe(true); // 确实是经过转发器的那条连接
  });
});
