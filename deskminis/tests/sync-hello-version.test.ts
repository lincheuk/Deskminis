/**
 * W2b-8 · sync.hello 带协议版本与能力位（缺失一律视为旧版）
 *
 * 钉住的行为（设计稿 §2「发布工程」：protocolVersion 2、caps {}、对端信息存 conn.syncPeer）：
 *   ① parseSyncHello 纯函数：没有合法版本号（≥2 的整数）一律旧版 {1, {}}，caps 只认严格 true；
 *      更高的版本号不拒绝（向前兼容）。peerHasCap(undefined, x) 恒 false。
 *   ② 应答端 handler：鉴权（「未配对设备」检查）通过之后才记 conn.syncPeer；
 *      响应多带 protocolVersion/caps；MAC 输入仍是 'm3c-hello'+nonce，带不带新字段算出同一个 mac。
 *   ③ 新发起端 ↔ 0.1.1 形状的应答端（只回 {mac, listenPort}）：照常上线，对端记为旧版。
 *   ③b 0.1.1 形状的发起端（只发 {nonce}）↔ 新应答端：mac 照常可验，应答端把它记为旧版。
 *   ④ 新 ↔ 新：发起端发 protocolVersion 2 与 caps，两端互记为 v2。
 *   ⑤ 向前兼容：应答端声明 v99 + 未知能力位，照常上线并如实记录。
 *
 * 0.1.1（tag v0.1.1 = 6c48c8b）的 sync.hello 与本步之前的 HEAD 逐字相同：
 * 请求 {nonce}、响应 {mac, listenPort}。所以 ③ ③b 用手写的旧形状就是在和 0.1.1 对拍。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService, derivePairingKey } from '../src/minisd/remote/pairing';
import { createAdditionalVerify, createRemoteMethods } from '../src/minisd/remote';
import { encodePaseto } from '../src/minisd/remote/paseto';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import { OutboundClient } from '../src/minisd/sync/outbound-client';
import {
  SYNC_PROTOCOL_VERSION,
  LOCAL_SYNC_CAPS,
  LEGACY_SYNC_PEER,
  parseSyncHello,
  peerHasCap,
} from '../src/minisd/sync/wire';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const LEGACY = { protocolVersion: 1, caps: {} };
const macHex = (key: Uint8Array, nonce: string): string =>
  Buffer.from(hmac(sha256, key, new TextEncoder().encode('m3c-hello' + nonce))).toString('hex');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

// ---- 互配对工厂（与 outbound-client.test.ts 同一做法：两端各存对方的 PairingKey） ----
function setupMutualPair(): { serviceA: PairingService; fpA: string; serviceB: PairingService; fpB: string; authKey: Uint8Array } {
  const dirA = mkdtempSync(join(tmpdir(), 'dm-hv-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'dm-hv-b-'));
  cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
  cleanups.push(() => { try { rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });
  const vaultA = new InMemoryVault();
  const vaultB = new InMemoryVault();
  const storeA = new PairingStore(dirA, vaultA);
  const storeB = new PairingStore(dirB, vaultB);
  const serviceA = new PairingService(storeA, vaultA);
  const serviceB = new PairingService(storeB, vaultB);
  const code = 'TESTCODE1';
  const fpA = serviceA.myFingerprint;
  const fpB = serviceB.myFingerprint;
  const privA = (serviceA as any).identity.privateKey as Uint8Array;
  const privB = (serviceB as any).identity.privateKey as Uint8Array;
  const keyForA = derivePairingKey(privA, serviceB.myPublicKey, code, fpB, 'B-device');
  const keyForB = derivePairingKey(privB, serviceA.myPublicKey, code, fpA, 'A-device');
  storeA.save(keyForA);
  storeB.save(keyForB);
  return { serviceA, fpA, serviceB, fpB, authKey: keyForA.authKey };
}

/** 起 B 侧 RpcServer；wrapHello 拿到真 handler，可包一层截获参数与 conn，或整个换成旧形状。 */
async function bootServer(service: PairingService, wrapHello?: (real: RpcMethods[string]) => RpcMethods[string]): Promise<number> {
  const syncMethods = createSyncMethods(null as any, { pairingService: service, listenPort: 0 });
  if (wrapHello) syncMethods['sync.hello'] = wrapHello(syncMethods['sync.hello']!);
  const methods: RpcMethods = { ...syncMethods, ...createRemoteMethods(service) };
  const rpc = new RpcServer(methods, 'LOCAL-TOKEN', createAdditionalVerify(service));
  const port = await rpc.listen('127.0.0.1', 0);
  cleanups.push(() => rpc.close());
  return port;
}

function makeClient(serviceA: PairingService, fpA: string, fpB: string, port: number): OutboundClient {
  ((serviceA as any).store as PairingStore).setAddress(fpB, `127.0.0.1:${port}`);
  const client = new OutboundClient(serviceA, fpA, {
    pingIntervalMs: 10000, pongTimeoutMs: 5000, reconnectBackoffMs: [10000], pasetoTtlMs: 60000,
  });
  cleanups.push(() => client.stop());
  return client;
}

async function waitOnline(client: OutboundClient, fp: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!client.isOnline(fp)) {
    if (Date.now() - t0 > ms) throw new Error(`等 ${fp} 上线超时`);
    await sleep(20);
  }
}

describe('① parseSyncHello / peerHasCap 纯函数', () => {
  it('本端声明：协议版本 2，能力位为空且冻结', () => {
    expect(SYNC_PROTOCOL_VERSION).toBe(2);
    expect(LOCAL_SYNC_CAPS).toEqual({});
    expect(Object.isFrozen(LOCAL_SYNC_CAPS)).toBe(true);
    expect(LEGACY_SYNC_PEER).toEqual(LEGACY);
  });

  it('只有 nonce（0.1.1 的请求形状）→ 旧版 {1, {}}', () => {
    expect(parseSyncHello({ nonce: 'x' })).toEqual(LEGACY);
  });

  it('只带 caps 不带版本号 → 按旧版处理，caps 一概忽略', () => {
    const peer = parseSyncHello({ caps: { a: true } });
    expect(peer).toEqual(LEGACY);
    expect(peerHasCap(peer, 'a')).toBe(false);
  });

  it('版本号不是 ≥2 的整数、或整体不是对象 → 旧版', () => {
    for (const raw of [
      { protocolVersion: '2' }, { protocolVersion: 1, caps: { a: true } }, { protocolVersion: 0 },
      { protocolVersion: 2.5 }, { protocolVersion: NaN }, { protocolVersion: Infinity }, { protocolVersion: -3 },
      null, undefined, [], 'hello', 42,
    ]) {
      expect(parseSyncHello(raw), JSON.stringify(raw) ?? String(raw)).toEqual(LEGACY);
    }
  });

  it('caps 只认值严格等于 true 的键，其余一律 false', () => {
    const peer = parseSyncHello({ protocolVersion: 2, caps: { a: true, b: 'true', c: 1, d: false, e: null } });
    expect(peer).toEqual({ protocolVersion: 2, caps: { a: true } });
    expect(peerHasCap(peer, 'a')).toBe(true);
    for (const k of ['b', 'c', 'd', 'e', 'zzz']) expect(peerHasCap(peer, k), k).toBe(false);
  });

  it('caps 不是普通对象（数组、字符串、null）→ 版本照记，能力为空', () => {
    for (const caps of [['a'], 'a', null, 7]) {
      expect(parseSyncHello({ protocolVersion: 2, caps })).toEqual({ protocolVersion: 2, caps: {} });
    }
    expect(parseSyncHello({ protocolVersion: 3 })).toEqual({ protocolVersion: 3, caps: {} });
  });

  it('能力位键名：字母开头、字母数字下划线、最长 32 位；最多记 32 个', () => {
    const long32 = 'a'.repeat(32);
    const long33 = 'a'.repeat(33);
    const peer = parseSyncHello({
      protocolVersion: 2,
      caps: { ok_1: true, [long32]: true, [long33]: true, '1bad': true, _x: true, 'has-dash': true, 'sp ace': true },
    });
    expect(Object.keys(peer.caps).sort()).toEqual([long32, 'ok_1'].sort());

    const many: Record<string, boolean> = {};
    for (let i = 0; i < 40; i++) many[`c${i}`] = true;
    expect(Object.keys(parseSyncHello({ protocolVersion: 2, caps: many }).caps)).toHaveLength(32);
  });

  it('原型链上的名字不算能力位（constructor / __proto__ / hasOwnProperty）', () => {
    const peer = parseSyncHello(JSON.parse('{"protocolVersion":2,"caps":{"__proto__":true,"x":true}}'));
    expect(peer.caps).toEqual({ x: true });
    for (const k of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) expect(peerHasCap(peer, k), k).toBe(false);
    expect(peerHasCap(LEGACY_SYNC_PEER, 'constructor')).toBe(false);
  });

  it('更高的版本号不拒绝，未知能力位保留（向前兼容）', () => {
    const peer = parseSyncHello({ protocolVersion: 99, caps: { future: true } });
    expect(peer).toEqual({ protocolVersion: 99, caps: { future: true } });
    expect(peerHasCap(peer, 'future')).toBe(true);
  });

  it('peerHasCap(undefined, x) 恒为 false', () => {
    expect(peerHasCap(undefined, 'a')).toBe(false);
    expect(peerHasCap(undefined, 'constructor')).toBe(false);
  });
});

describe('② 应答端 sync.hello handler', () => {
  const authKey = new Uint8Array(32).fill(7);
  const stubPairing = (key: Uint8Array | undefined) => ({ get: () => (key ? { authKey: key } : undefined) }) as any;
  const remoteConn = (): RpcConnection => ({ authMode: 'remote', peerFingerprint: 'fp-peer', notify: () => {} });

  it('0.1.1 请求 {nonce} → 响应带版本与能力位，conn.syncPeer 记为旧版，mac 与旧算法一致', async () => {
    const methods = createSyncMethods(null as any, { pairingService: stubPairing(authKey), listenPort: 4321 });
    const conn = remoteConn();
    const r = await methods['sync.hello']!({ nonce: 'n1' }, conn) as any;
    expect(r.protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
    expect(r.caps).toEqual({});
    expect(typeof r.caps).toBe('object');
    expect(r.listenPort).toBe(4321);
    expect(r.mac).toBe(macHex(authKey, 'n1'));
    expect(conn.syncPeer).toEqual(LEGACY);
  });

  it('带 protocolVersion/caps 的请求：mac 与只带 nonce 时相同（MAC 输入不变），conn.syncPeer 记下对端声明', async () => {
    const methods = createSyncMethods(null as any, { pairingService: stubPairing(authKey), listenPort: 0 });
    const conn = remoteConn();
    const r = await methods['sync.hello']!({ nonce: 'n1', protocolVersion: 2, caps: { a: true, b: 1 } }, conn) as any;
    expect(r.mac).toBe(macHex(authKey, 'n1'));
    expect(conn.syncPeer).toEqual({ protocolVersion: 2, caps: { a: true } });
  });

  it('响应里的 caps 是副本：改它不会污染本端声明', async () => {
    const methods = createSyncMethods(null as any, { pairingService: stubPairing(authKey), listenPort: 0 });
    const r = await methods['sync.hello']!({ nonce: 'n2' }, remoteConn()) as any;
    expect(r.caps).not.toBe(LOCAL_SYNC_CAPS);
  });

  it('未配对设备 → 抛错，且不记 conn.syncPeer（鉴权通过之后才记）', async () => {
    const methods = createSyncMethods(null as any, { pairingService: stubPairing(undefined), listenPort: 0 });
    const conn = remoteConn();
    await expect(methods['sync.hello']!({ nonce: 'n1', protocolVersion: 2, caps: { a: true } }, conn)).rejects.toThrow('未配对设备');
    expect(conn.syncPeer).toBeUndefined();
  });

  it('非 remote 连接 → 抛错，且不记 conn.syncPeer', async () => {
    const methods = createSyncMethods(null as any, { pairingService: stubPairing(authKey), listenPort: 0 });
    const conn: RpcConnection = { authMode: 'local', notify: () => {} };
    await expect(methods['sync.hello']!({ nonce: 'n1', protocolVersion: 2 }, conn)).rejects.toThrow(/authMode/);
    expect(conn.syncPeer).toBeUndefined();
  });
});

describe('③–⑤ 发起端 ↔ 应答端互通（真 WebSocket）', () => {
  it('③ 新发起端 → 0.1.1 形状应答端（只回 {mac, listenPort}）：照常上线，peerInfo 记为旧版', async () => {
    const { serviceA, fpA, serviceB, fpB, authKey } = setupMutualPair();
    let port = 0;
    // 与 6c48c8b 的 handler 同形：只读 nonce，只回 mac 与 listenPort
    port = await bootServer(serviceB, () => (p: { nonce: string }) => ({ mac: macHex(authKey, p.nonce), listenPort: port }));
    const client = makeClient(serviceA, fpA, fpB, port);
    let online = '';
    client.onOnline = fp => { online = fp; };
    expect(client.peerInfo(fpB)).toBeUndefined(); // 没拨号就没有对端信息
    client.dialNow(fpB);
    await waitOnline(client, fpB);
    expect(online).toBe(fpB);
    expect(client.peerInfo(fpB)).toEqual(LEGACY);
    // 离线后不再给对端信息（避免拿上一条连接的声明当现状）
    client.disconnect(fpB);
    expect(client.peerInfo(fpB)).toBeUndefined();
  });

  it('③b 0.1.1 形状发起端（只发 {nonce}）→ 新应答端：mac 可验、listenPort 照旧，应答端记为旧版', async () => {
    const { fpA, serviceB, fpB, authKey } = setupMutualPair();
    let seenConn: RpcConnection | undefined;
    const port = await bootServer(serviceB, real => (p, conn) => { seenConn = conn; return real(p, conn); });
    // 按 0.1.1 OutboundClient.dial 的做法铸 PASETO，再只发 {nonce}
    const now = Date.now();
    const token = encodePaseto({ exp: now + 60000, iat: now, device_fingerprint: fpA, jti: randomUUID(), aud: fpB }, authKey);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?paseto=${encodeURIComponent(token)}`);
    cleanups.push(() => { try { ws.terminate(); } catch { /* */ } });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const reply = new Promise<any>(resolve => ws.once('message', raw => resolve(JSON.parse(String(raw)))));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sync.hello', params: { nonce: 'old-nonce' } }));
    const msg = await reply;
    expect(msg.error).toBeUndefined();
    // 0.1.1 客户端只读这两个字段：必须仍然存在且语义不变
    expect(msg.result.mac).toBe(macHex(authKey, 'old-nonce'));
    expect(msg.result.listenPort).toBe(0);
    expect(seenConn?.syncPeer).toEqual(LEGACY);
  });

  it('④ 新 ↔ 新：发起端发 protocolVersion 2 与 caps，两端互记为 v2', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();
    let seenParams: any;
    let seenConn: RpcConnection | undefined;
    const port = await bootServer(serviceB, real => (p, conn) => { seenParams = p; seenConn = conn; return real(p, conn); });
    const client = makeClient(serviceA, fpA, fpB, port);
    client.dialNow(fpB);
    await waitOnline(client, fpB);
    expect(seenParams.protocolVersion).toBe(2);
    expect(seenParams.caps).toEqual({});
    expect(typeof seenParams.nonce).toBe('string');
    expect(client.peerInfo(fpB)?.protocolVersion).toBe(2);
    expect(client.peerInfo(fpB)).toEqual({ protocolVersion: 2, caps: {} });
    expect(seenConn?.syncPeer?.protocolVersion).toBe(2);
  });

  it('⑤ 向前兼容：应答端声明 v99 + 未知能力位 → 照常上线，如实记录', async () => {
    const { serviceA, fpA, serviceB, fpB, authKey } = setupMutualPair();
    let port = 0;
    port = await bootServer(serviceB, () => (p: { nonce: string }) => ({
      mac: macHex(authKey, p.nonce), listenPort: port, protocolVersion: 99, caps: { x: true, y: 'yes' },
    }));
    const client = makeClient(serviceA, fpA, fpB, port);
    client.dialNow(fpB);
    await waitOnline(client, fpB);
    expect(client.peerInfo(fpB)).toEqual({ protocolVersion: 99, caps: { x: true } });
    expect(peerHasCap(client.peerInfo(fpB), 'x')).toBe(true);
  });

  it('mac 伪造时即使声明了新版本也不上线，peerInfo 不记录', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();
    const wrongKey = new Uint8Array(32).fill(0xEE);
    let port = 0;
    port = await bootServer(serviceB, () => (p: { nonce: string }) => ({
      mac: macHex(wrongKey, p.nonce), listenPort: port, protocolVersion: 2, caps: { x: true },
    }));
    const client = makeClient(serviceA, fpA, fpB, port);
    let offline = '';
    client.onOffline = fp => { offline = fp; };
    client.dialNow(fpB);
    const t0 = Date.now();
    while (!offline && Date.now() - t0 < 3000) await sleep(20);
    expect(offline).toBe(fpB);
    expect(client.isOnline(fpB)).toBe(false);
    expect(client.peerInfo(fpB)).toBeUndefined();
    // 连接条目还在（等退避重拨），它记的对端信息必须仍是旧版缺省：MAC 校验通过之前不采信对端声明
    expect((client as any).connections.get(fpB)?.peer).toEqual(LEGACY);
  });
});
