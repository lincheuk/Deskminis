/**
 * W3-sec4（安全审计第 3、6 条）：配对与远程连接——撤销即断、广播分级。
 *
 * ③ 取消配对以前只删配对存储：authMode 在建连时定死，业务守卫只拒 pairing 模式、不复查指纹还配不配对，
 *    已经连着的远程客户端照样能调业务接口；出站那一侧的 disconnect 注释写着「unpair 时调」，实际没人调。
 * ⑥ 只拿着配对码连上的 pairing 连接，以前也收得到所有广播（chat.event、permission.request 全文）——broadcast 不看 authMode。
 *
 * 这里在 127.0.0.1 上真起 RpcServer，配 createRemoteMethods / createAdditionalVerify / guardBusinessMethod，客户端是真 WebSocket，
 * 远程客户端带真 PASETO。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService, StaticIdentity, derivePairingKey } from '../src/minisd/remote/pairing';
import { createRemoteMethods, createAdditionalVerify, guardBusinessMethod } from '../src/minisd/remote';
import { encodePaseto } from '../src/minisd/remote/paseto';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

interface Client { ws: WebSocket; frames: any[]; closed: Promise<void>; call(method: string, params?: unknown): Promise<any> }
function connect(port: number, query: string): Promise<Client> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
    const frames: any[] = [];
    const pending = new Map<number, (m: any) => void>();
    let idc = 0;
    const closed = new Promise<void>(r => ws.on('close', () => r()));
    ws.on('message', d => {
      const m = JSON.parse(String(d));
      frames.push(m);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    });
    ws.on('open', () => res({
      ws, frames, closed,
      call: (method, params) => new Promise((resolve, reject) => {
        const id = ++idc;
        pending.set(id, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
      }),
    }));
    ws.on('error', rej);
  });
}

let service: PairingService;
let store: PairingStore;
let rpc: RpcServer;
let port: number;
const disconnected: string[] = [];
const TOKEN = 'LOCAL-TOKEN-REVOKE';

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-revoke-'));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ } });
  const vault = new InMemoryVault();
  store = new PairingStore(dir, vault);
  service = new PairingService(store, vault);
  disconnected.length = 0;
  const business: RpcMethods = { 'chat.sessions.list': () => ({ sessions: [] }) };
  const isPaired = (fp: string): boolean => service.get(fp) !== undefined;
  for (const k of Object.keys(business)) business[k] = guardBusinessMethod(business[k], k, isPaired);
  const remote = createRemoteMethods(service, {
    getRpcServer: () => rpc,
    getOutbound: () => ({ isOnline: () => false, disconnect: (fp: string) => { disconnected.push(fp); } }),
  });
  rpc = new RpcServer({ ...business, ...remote }, TOKEN, createAdditionalVerify(service));
  port = await rpc.listen('127.0.0.1', 0);
  cleanups.push(() => rpc.close());
});

/** 让 service 认一个对端，返回它连过来用的 PASETO（会话路径：不带 jti）。 */
function pairPeer(): { fp: string; paseto: string } {
  const peer = new StaticIdentity();
  const me = new StaticIdentity();
  const key = derivePairingKey(me.privateKey, peer.publicKey, 'CODE1234', peer.fingerprint, 'peer');
  store.save(key);
  const paseto = encodePaseto({ exp: Date.now() + 60_000, iat: Date.now(), device_fingerprint: peer.fingerprint }, key.authKey);
  return { fp: peer.fingerprint, paseto };
}

describe('③ 取消配对：已连着的远程连接当场断开，再调业务被拒', () => {
  it('remote.unpair 之后：该对端的入站连接被关、出站那一侧也断开；别的对端不受影响', async () => {
    const a = pairPeer();
    const b = pairPeer();
    const local = await connect(port, `token=${TOKEN}`);
    const ra = await connect(port, `paseto=${encodeURIComponent(a.paseto)}`);
    const rb = await connect(port, `paseto=${encodeURIComponent(b.paseto)}`);
    expect(await ra.call('chat.sessions.list')).toEqual({ sessions: [] });

    await local.call('remote.unpair', { peerFingerprint: a.fp });
    await Promise.race([ra.closed, sleep(2000).then(() => { throw new Error('取消配对之后远程连接没被关掉'); })]);
    // 客户端先看到关闭，服务端的 close 回调稍后才记账
    for (let i = 0; i < 50 && rpc.isInboundOnline(a.fp); i++) await sleep(20);
    expect(rpc.isInboundOnline(a.fp)).toBe(false);
    expect(disconnected).toEqual([a.fp]);
    expect(rb.ws.readyState).toBe(WebSocket.OPEN);
    expect(await rb.call('chat.sessions.list')).toEqual({ sessions: [] });
    local.ws.close(); rb.ws.close();
  });

  it('业务守卫每次都复查指纹还配不配对：配对被删（不经 remote.unpair）之后旧连接再调也被拒', async () => {
    const a = pairPeer();
    const ra = await connect(port, `paseto=${encodeURIComponent(a.paseto)}`);
    expect(await ra.call('chat.sessions.list')).toEqual({ sessions: [] });
    service.delete(a.fp);
    await expect(ra.call('chat.sessions.list')).rejects.toThrow(/配对/);
    await Promise.race([ra.closed, sleep(2000).then(() => { throw new Error('拒绝之后没关掉连接'); })]);
  });

  it('guardBusinessMethod：remote 连接没有指纹或指纹不在配对表里 → 拒；local 不受影响', () => {
    const ok = guardBusinessMethod((_p: unknown, _c: RpcConnection) => 'ok', 'chat.sessions.list', fp => fp === 'FP-OK');
    const conn = (authMode: RpcConnection['authMode'], peerFingerprint?: string): RpcConnection => ({ authMode, peerFingerprint, notify: () => {}, closeAfterReply: () => {} });
    expect(ok({}, conn('remote', 'FP-OK'))).toBe('ok');
    expect(() => ok({}, conn('remote', 'FP-GONE'))).toThrow(/配对/);
    expect(() => ok({}, conn('remote'))).toThrow(/配对/);
    expect(ok({}, conn('local'))).toBe('ok');
  });
});

describe('⑥ 配对阶段的连接只走配对协议', () => {
  it('只拿着配对码连上（还没 complete）：收不到业务广播；local 与 remote 照收', async () => {
    const a = pairPeer();
    const local = await connect(port, `token=${TOKEN}`);
    const begin = await local.call('remote.pair.begin');
    const pairing = await connect(port, `pairingCode=${begin.pairingCode}`);
    const remote = await connect(port, `paseto=${encodeURIComponent(a.paseto)}`);
    rpc.broadcast('chat.event', { sessionId: 'S1', event: { kind: 'text', text: 'SECRET-MARKER' } });
    await sleep(150);
    const got = (c: Client): boolean => c.frames.some(f => f.method === 'chat.event');
    expect(got(local)).toBe(true);
    expect(got(remote)).toBe(true);
    expect(got(pairing), 'pairing 连接收到了业务广播').toBe(false);
    local.ws.close(); pairing.ws.close(); remote.ws.close();
  });

  it('remote.pair.complete 回包之后，服务端关掉这条 pairing 连接（回包照样送到）', async () => {
    const local = await connect(port, `token=${TOKEN}`);
    const begin = await local.call('remote.pair.begin');
    const pairing = await connect(port, `pairingCode=${begin.pairingCode}`);
    const peer = new StaticIdentity();
    const r = await pairing.call('remote.pair.complete', {
      pairingCode: begin.pairingCode, peerPublicKey: Buffer.from(peer.publicKey).toString('base64'), peerFingerprint: peer.fingerprint,
    });
    expect(r.ok).toBe(true);
    await Promise.race([pairing.closed, sleep(2000).then(() => { throw new Error('配对完成之后 pairing 连接没被关掉'); })]);
    local.ws.close();
  });

  it('pairing 连接有时限：到点（配对码有效期）由服务端关掉', async () => {
    const short = new RpcServer({}, TOKEN, () => ({ ok: true, authMode: 'pairing' }), { pairingIdleMs: 200 });
    const p = await short.listen('127.0.0.1', 0);
    cleanups.push(() => short.close());
    const c = await connect(p, 'pairingCode=WHATEVER');
    await Promise.race([c.closed, sleep(2000).then(() => { throw new Error('pairing 连接没有按时关掉'); })]);
  });
});

describe('接线：引擎给两处业务守卫都带上配对复查', () => {
  it('src/minisd/index.ts 里每一处 guardBusinessMethod( 都传第三参 isPaired，且 isPaired 查的是 pairingService', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(__dirname, '..', 'src', 'minisd', 'index.ts'), 'utf8');
    const calls = [...src.matchAll(/guardBusinessMethod\(([^;\n]*)\)/g)].map(m => m[1]);
    expect(calls.length, '没找到 guardBusinessMethod 调用').toBeGreaterThanOrEqual(2);
    for (const args of calls) expect(args, `这一处没带配对复查：guardBusinessMethod(${args})`).toMatch(/,\s*isPaired\s*$/);
    expect(src).toMatch(/const isPaired = \(fp: string\): boolean => pairingService\.get\(fp\) !== undefined;/);
  });
});
