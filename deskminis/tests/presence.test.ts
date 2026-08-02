/**
 * M3c Task 5 · 在线状态 presence（出站 ∪ 入站）+ sync.dirty 双向监听 测试
 *
 * 覆盖（命门 2 + 决策 5）：
 *   1. remote.status：增 online/lastSeenAt 字段（出站 ∪ 入站合并两源，命门 2）
 *   2. presence：B 侧（监听方）看 A online=true（入站注册表，命门 2 补真断言）
 *   3. OutboundClient：onOnline/onOffline 翻转 + lastSeenAt 更新
 *   4. OutboundClient：监听对端 sync.dirty notify → onRemoteDirty 触发（拨号方职责）
 *
 * 环境：双 in-process RpcServer 本地 127.0.0.1，禁外网。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import {
  PairingStore,
  PairingService,
  derivePairingKey,
} from '../src/minisd/remote/pairing';
import { createAdditionalVerify, createRemoteMethods } from '../src/minisd/remote';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { createSyncMethods } from '../src/minisd/sync';
import { OutboundClient } from '../src/minisd/sync/outbound-client';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---- 测试资源清理 ----
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

// ---- 互配对工厂：创建 A/B 两个 PairingService，互相存入对方的 PairingKey + 地址 ----
function setupMutualPair(): {
  serviceA: PairingService; fpA: string; storeA: PairingStore;
  serviceB: PairingService; fpB: string; storeB: PairingStore;
  authKey: Uint8Array;
} {
  const dirA = mkdtempSync(join(tmpdir(), 'dm-pr-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'dm-pr-b-'));
  cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
  cleanups.push(() => { try { rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });

  const vaultA = new InMemoryVault();
  const vaultB = new InMemoryVault();
  const storeA = new PairingStore(dirA, vaultA);
  const storeB = new PairingStore(dirB, vaultB);
  const serviceA = new PairingService(storeA, vaultA);
  const serviceB = new PairingService(storeB, vaultB);

  const code = 'PRESENCE1';
  const fpA = serviceA.myFingerprint;
  const fpB = serviceB.myFingerprint;
  const privA = (serviceA as any).identity.privateKey as Uint8Array;
  const privB = (serviceB as any).identity.privateKey as Uint8Array;
  const pubA = serviceA.myPublicKey;
  const pubB = serviceB.myPublicKey;

  const keyForA = derivePairingKey(privA, pubB, code, fpB, 'B-device');
  const keyForB = derivePairingKey(privB, pubA, code, fpA, 'A-device');

  // ECDH 对称性断言
  if (!Buffer.from(keyForA.authKey).equals(Buffer.from(keyForB.authKey))) {
    throw new Error('ECDH 对称性失败');
  }

  storeA.save(keyForA);
  storeB.save(keyForB);
  // 互设地址（A 的地址给 B，B 的地址给 A）
  storeA.setAddress(fpB, '127.0.0.1:0'); // 占位，bootServer 后更新
  storeB.setAddress(fpA, '127.0.0.1:0');

  return { serviceA, fpA, storeA, serviceB, fpB, storeB, authKey: keyForA.authKey };
}

// ---- RPC 客户端 ----
interface RpcClient {
  ws: WebSocket;
  call: (method: string, params?: unknown) => Promise<unknown>;
  close: () => void;
}
function wsConnect(url: string): Promise<RpcClient> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let idc = 0;
    const pending = new Map<number, (m: any) => void>();
    ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    });
    ws.on('open', () => res({
      ws,
      call: (method: string, params?: unknown) => new Promise((resolve, reject) => {
        const id = ++idc;
        pending.set(id, m => m.error ? reject(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : resolve(m.result));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      }),
      close: () => { try { ws.close(); } catch { /* */ } },
    }));
    ws.on('error', rej);
  });
}

// ---- 启动 RpcServer（含 remote.* + sync.hello + additionalVerify，注入 outbound/rpcServer 供 remote.status 合并） ----
async function bootServer(opts: {
  service: PairingService;
  store: PairingStore;
  listenPort?: number;
  outbound?: OutboundClient;
  rpcServerRef?: { rpc: RpcServer };
}): Promise<{ port: number; rpc: RpcServer; authToken: string }> {
  const { service, store, outbound } = opts;
  const additionalVerify = createAdditionalVerify(service);
  const syncMethods = createSyncMethods(null as any, { pairingService: service, listenPort: opts.listenPort ?? 0 });
  // remote.status 注入 outbound + rpcServer（命门 2 合并两源）——rpcServer 在 listen 后才有，用闭包引用
  let rpcRef: RpcServer | undefined;
  const remoteMethods = createRemoteMethods(service, {
    onPairComplete: (fp, remoteAddr, listenPort) => {
      if (listenPort && listenPort > 0) {
        const host = remoteAddr?.replace(/^::ffff:/, '') ?? '127.0.0.1';
        store.setAddress(fp, `${host}:${listenPort}`);
      }
    },
    getOutbound: () => outbound,
    getRpcServer: () => rpcRef,
  });
  const methods: RpcMethods = { ...syncMethods, ...remoteMethods };
  const authToken = 'PRESENCE-TOKEN-' + Math.random().toString(36).slice(2);
  const rpc = new RpcServer(methods, authToken, additionalVerify);
  rpcRef = rpc;
  if (opts.rpcServerRef) opts.rpcServerRef.rpc = rpc;
  const port = await rpc.listen('127.0.0.1', opts.listenPort ?? 0);
  cleanups.push(() => rpc.close());
  return { port, rpc, authToken };
}

describe('presence（出站 ∪ 入站）+ sync.dirty 监听', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'dm-pres-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'dm-pres-b-'));
    cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
    cleanups.push(() => { try { rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });
  });

  // 1. remote.status：增 online/lastSeenAt 字段（出站 ∪ 入站合并两源，命门 2）
  it('remote.status：A 侧（拨号方）outbound online → devices[B].online=true + lastSeenAt>0', async () => {
    const { serviceA, fpA, storeA, serviceB, fpB, storeB, authKey } = setupMutualPair();

    // 先起 B，拿到 B 的端口
    const serverB = await bootServer({ service: serviceB, store: storeB });
    // A 的 outbound 指向 B
    storeA.setAddress(fpB, `127.0.0.1:${serverB.port}`);
    // A 的 outbound（先创建，bootServer 注入）
    const outboundA = new OutboundClient(serviceA, fpA, { pingIntervalMs: 1000, pongTimeoutMs: 2000 });
    cleanups.push(() => outboundA.stop());
    const serverA = await bootServer({ service: serviceA, store: storeA, outbound: outboundA });

    // A 拨 B（主从裁决：fpA < fpB 才主拨；若 fpA > fpB 则手动 dialNow）
    outboundA.dialNow(fpB);
    await sleep(1500); // 等 sync.hello 互认 + onOnline

    // A 侧 remote.status 看 B online
    const localA = await wsConnect(`ws://127.0.0.1:${serverA.port}/?token=${serverA.authToken}`);
    cleanups.push(() => localA.close());
    const aStatus = await localA.call('remote.status') as any;
    const bDev = aStatus.devices.find((d: any) => d.peerFingerprint === fpB);
    expect(bDev).toBeDefined();
    expect(bDev.online).toBe(true);
    expect(bDev.lastSeenAt).toBeGreaterThan(0);
  });

  // 2. presence：B 侧（监听方）看 A online=true（入站注册表，命门 2 补真断言）
  it('presence：B 侧（监听方）入站注册表 online=true（命门 2 补真断言）', async () => {
    const { serviceA, fpA, storeA, serviceB, fpB, storeB, authKey } = setupMutualPair();

    const serverB = await bootServer({ service: serviceB, store: storeB });
    storeA.setAddress(fpB, `127.0.0.1:${serverB.port}`);
    const outboundA = new OutboundClient(serviceA, fpA, { pingIntervalMs: 1000, pongTimeoutMs: 2000 });
    cleanups.push(() => outboundA.stop());
    const serverA = await bootServer({ service: serviceA, store: storeA, outbound: outboundA });

    outboundA.dialNow(fpB);
    await sleep(1500);

    // B 侧 remote.status 看 A online（入站注册表）
    const localB = await wsConnect(`ws://127.0.0.1:${serverB.port}/?token=${serverB.authToken}`);
    cleanups.push(() => localB.close());
    const bStatus = await localB.call('remote.status') as any;
    const aDev = bStatus.devices.find((d: any) => d.peerFingerprint === fpA);
    expect(aDev).toBeDefined();
    expect(aDev.online).toBe(true); // 入站注册表存活
  });

  // 3. OutboundClient：onOnline/onOffline 翻转 + lastSeenAt 更新
  it('OutboundClient：onOnline/onOffline 翻转 + lastSeenAt 更新', async () => {
    const { serviceA, fpA, storeA, serviceB, fpB, storeB, authKey } = setupMutualPair();

    const serverB = await bootServer({ service: serviceB, store: storeB });
    storeA.setAddress(fpB, `127.0.0.1:${serverB.port}`);
    const outboundA = new OutboundClient(serviceA, fpA, { pingIntervalMs: 1000, pongTimeoutMs: 2000 });
    cleanups.push(() => outboundA.stop());

    let onlineFp = '';
    let offlineFp = '';
    outboundA.onOnline = (fp) => { onlineFp = fp; };
    outboundA.onOffline = (fp) => { offlineFp = fp; };

    // 先起 B，A 拨 B
    outboundA.dialNow(fpB);
    await sleep(1500);
    expect(onlineFp).toBe(fpB);
    expect(outboundA.isOnline(fpB)).toBe(true);
    const seen1 = outboundA.lastSeen(fpB);
    expect(seen1).toBeGreaterThan(0);

    // 关闭 B → A onOffline
    await serverB.rpc.close();
    await sleep(2000); // 等 pong 超时判死或 close 事件
    expect(offlineFp).toBe(fpB);
    expect(outboundA.isOnline(fpB)).toBe(false);
    // lastSeenAt 停在最后在线时间（不归零）
    const seen2 = outboundA.lastSeen(fpB);
    expect(seen2).toBeGreaterThanOrEqual(seen1);
  });

  // 4. OutboundClient：监听对端 sync.dirty notify → onRemoteDirty 触发（拨号方职责）
  it('OutboundClient：监听对端 sync.dirty notify → onRemoteDirty 触发', async () => {
    const { serviceA, fpA, storeA, serviceB, fpB, storeB, authKey } = setupMutualPair();

    // B 端 bootServer 增 test.broadcastDirty 方法供测试触发 sync.dirty broadcast
    const additionalVerify = createAdditionalVerify(serviceB);
    const syncMethodsB = createSyncMethods(null as any, { pairingService: serviceB, listenPort: 0 });
    let rpcBRef: RpcServer | undefined;
    const remoteMethodsB = createRemoteMethods(serviceB, {
      getRpcServer: () => rpcBRef,
    });
    // 注入测试方法：broadcast sync.dirty
    const testMethods: RpcMethods = {
      ...syncMethodsB, ...remoteMethodsB,
      'test.broadcastDirty': (p: { sessionId: string }) => {
        if (!rpcBRef) throw new Error('rpc not ready');
        rpcBRef.broadcast('sync.dirty', { sessionId: p.sessionId, cursor: { lastMessageTs: Date.now() } });
        return { ok: true };
      },
    };
    const authTokenB = 'PRESENCE-DIRTY-B';
    const rpcB = new RpcServer(testMethods, authTokenB, additionalVerify);
    rpcBRef = rpcB;
    const portB = await rpcB.listen('127.0.0.1', 0);
    cleanups.push(() => rpcB.close());

    storeA.setAddress(fpB, `127.0.0.1:${portB}`);
    const outboundA = new OutboundClient(serviceA, fpA, { pingIntervalMs: 1000, pongTimeoutMs: 2000 });
    cleanups.push(() => outboundA.stop());
    // A 端也起 server（outbound 注入，供 remote.status 测试完整性）
    const serverA = await bootServer({ service: serviceA, store: storeA, outbound: outboundA });

    let dirtyFp = '';
    let dirtySid = '';
    outboundA.onRemoteDirty = (fp, sid) => { dirtyFp = fp; dirtySid = sid; };

    outboundA.dialNow(fpB);
    await sleep(1500); // 等 sync.hello 互认

    // B 端 broadcast sync.dirty
    const testSid = 'test-session-id';
    const localB = await wsConnect(`ws://127.0.0.1:${portB}/?token=${authTokenB}`);
    cleanups.push(() => localB.close());
    await (localB.call as any)('test.broadcastDirty', { sessionId: testSid });
    await sleep(500);

    expect(dirtyFp).toBe(fpB);
    expect(dirtySid).toBe(testSid);
  });
});
