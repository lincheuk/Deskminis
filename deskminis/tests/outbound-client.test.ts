/**
 * M3c Task 3 · OutboundClient 出站 WS 客户端测试
 *
 * 覆盖（决策 1/2/4/6）：
 *   1. sync.hello 互认成功 + onOnline 触发（决策 1 层 2）
 *   2. 假服务端不回 sync.hello → 不标 online（决策 1 层 2）
 *   3. 伪造 sync.hello mac → 断开 + 退避（决策 1 层 2）
 *   4. PASETO jti 重放 → 401 拒绝（决策 1 层 1）
 *   5. 主从裁决——myFp > peerFp 时不拨（决策 2）
 *   6. 断线重连退避（close 后按 backoff 重拨，决策 6）
 *   7. ping/pong 判死（pong 超时 → terminate → onOffline，决策 6）
 *   8. noProxy——HTTP_PROXY 设置时仍直连 LAN（红线 4e）
 *   9. PASETO 60s TTL 到期前重铸（连接存活超 TTL → 主动重连重铸 token 新 jti）
 *
 * 环境：双 in-process RpcServer 本地 127.0.0.1，禁外网。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import {
  PairingStore,
  PairingService,
  derivePairingKey,
  type PairingKey,
} from '../src/minisd/remote/pairing';
import { createAdditionalVerify, createRemoteMethods } from '../src/minisd/remote';
import { encodePaseto } from '../src/minisd/remote/paseto';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { createSyncMethods } from '../src/minisd/sync';
import { OutboundClient } from '../src/minisd/sync/outbound-client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pathJoin } from 'node:path';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---- 测试资源清理 ----
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

// ---- 互配对工厂：创建 A/B 两个 PairingService，互相存入对方的 PairingKey + 地址 ----
function setupMutualPair(): {
  serviceA: PairingService; fpA: string;
  serviceB: PairingService; fpB: string;
  authKey: Uint8Array;  // ECDH 对称，两端相同
} {
  const dirA = mkdtempSync(join(tmpdir(), 'dm-ob-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'dm-ob-b-'));
  cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
  cleanups.push(() => { try { rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });

  const vaultA = new InMemoryVault();
  const vaultB = new InMemoryVault();
  const storeA = new PairingStore(dirA, vaultA);
  const storeB = new PairingStore(dirB, vaultB);
  const serviceA = new PairingService(storeA, vaultA);
  const serviceB = new PairingService(storeB, vaultB);

  // 互配对：A 存 B 的 PairingKey，B 存 A 的 PairingKey
  // ECDH 对称性：derivePairingKey(A.priv, B.pub, code) === derivePairingKey(B.priv, A.pub, code)
  const code = 'TESTCODE1';
  const fpA = serviceA.myFingerprint;
  const fpB = serviceB.myFingerprint;
  const privA = (serviceA as any).identity.privateKey as Uint8Array;
  const privB = (serviceB as any).identity.privateKey as Uint8Array;
  const pubA = serviceA.myPublicKey;
  const pubB = serviceB.myPublicKey;

  const keyForA = derivePairingKey(privA, pubB, code, fpB, 'B-device');
  const keyForB = derivePairingKey(privB, pubA, code, fpA, 'A-device');

  // ECDH 对称性断言（调试期护栏）
  if (!Buffer.from(keyForA.authKey).equals(Buffer.from(keyForB.authKey))) {
    throw new Error('ECDH 对称性失败：两端 authKey 不一致');
  }

  storeA.save(keyForA);
  storeB.save(keyForB);

  return { serviceA, fpA, serviceB, fpB, authKey: keyForA.authKey };
}

// ---- 启动 B 侧 RpcServer（含 sync.hello + additionalVerify） ----
async function bootServer(opts: {
  service: PairingService;
  listenPort?: number;
  customHello?: (p: { nonce: string }, conn: RpcConnection) => unknown;
}): Promise<{ port: number; rpc: RpcServer }> {
  const { service, customHello } = opts;
  const additionalVerify = createAdditionalVerify(service);
  const syncMethods = createSyncMethods(
    // chat 参数：sync.hello 不依赖 chat，传 null（sync.push/pull 等本测试不调）
    null as any,
    { pairingService: service, listenPort: opts.listenPort ?? 0 },
  );
  // 如果有自定义 hello（伪造 mac 测试用），覆盖
  if (customHello) {
    (syncMethods as any)['sync.hello'] = customHello;
  }
  const remoteMethods = createRemoteMethods(service);
  const methods: RpcMethods = { ...syncMethods, ...remoteMethods };
  const rpc = new RpcServer(methods, 'LOCAL-TOKEN', additionalVerify);
  const port = await rpc.listen('127.0.0.1', opts.listenPort ?? 0);
  cleanups.push(() => rpc.close());
  return { port, rpc };
}

describe('OutboundClient', () => {
  let dirA: string;
  let vaultA: InMemoryVault;
  let storeA: PairingStore;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'dm-obc-'));
    vaultA = new InMemoryVault();
    storeA = new PairingStore(dirA, vaultA);
    cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
  });

  // 1. sync.hello 互认成功 + onOnline 触发（决策 1 层 2）
  it('sync.hello 互认成功 → onOnline 触发', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();
    const { port } = await bootServer({ service: serviceB, listenPort: 0 });

    // A 存 B 的地址
    storeA = (serviceA as any).store as PairingStore;
    storeA.setAddress(fpB, `127.0.0.1:${port}`);

    const client = new OutboundClient(serviceA, fpA, {
      pingIntervalMs: 10000,  // 长间隔避免干扰
      pongTimeoutMs: 5000,
      reconnectBackoffMs: [100],
      pasetoTtlMs: 60000,
    });
    cleanups.push(() => client.stop());

    let online = '';
    client.onOnline = fp => { online = fp; };
    client.dialNow(fpB);
    await sleep(500);
    expect(online).toBe(fpB);
  });

  // 2. 假服务端不回 sync.hello → 不标 online（决策 1 层 2）
  it('假服务端不回 sync.hello → onOnline 不触发', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();

    // 起一个裸 WebSocketServer（不注册 sync.hello）
    const bareWss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(r => bareWss.on('listening', () => r()));
    const port = (bareWss.address() as any).port;
    cleanups.push(() => new Promise<void>(r => bareWss.close(() => r())));

    storeA = (serviceA as any).store as PairingStore;
    storeA.setAddress(fpB, `127.0.0.1:${port}`);

    const client = new OutboundClient(serviceA, fpA, {
      pingIntervalMs: 10000,
      pongTimeoutMs: 5000,
      reconnectBackoffMs: [10000],  // 长退避避免重拨干扰
      pasetoTtlMs: 60000,
    });
    cleanups.push(() => client.stop());

    let online = '';
    client.onOnline = () => { online = 'should-not-fire'; };
    client.dialNow(fpB);
    await sleep(800);
    expect(online).toBe('');
  });

  // 3. 伪造 sync.hello mac → 断开 + 退避（决策 1 层 2）
  it('伪造 sync.hello mac → onOffline 触发', async () => {
    const { serviceA, fpA, serviceB, fpB, authKey } = setupMutualPair();
    // 用一个错误的 authKey 算 mac（模拟伪造）
    const wrongKey = new Uint8Array(32).fill(0xFF);
    const { port } = await bootServer({
      service: serviceB,
      listenPort: 0,
      customHello: (_p, _conn) => {
        // 返回用错误 key 算的 mac（客户端比对会失败）
        const { hmac } = require('@noble/hashes/hmac.js');
        const { sha256 } = require('@noble/hashes/sha2.js');
        const mac = hmac(sha256, wrongKey, new TextEncoder().encode('m3c-hello' + _p.nonce));
        return { mac: Buffer.from(mac).toString('hex'), listenPort: port };
      },
    });

    storeA = (serviceA as any).store as PairingStore;
    storeA.setAddress(fpB, `127.0.0.1:${port}`);

    const client = new OutboundClient(serviceA, fpA, {
      pingIntervalMs: 10000,
      pongTimeoutMs: 5000,
      reconnectBackoffMs: [10000],  // 长退避避免重拨干扰
      pasetoTtlMs: 60000,
    });
    cleanups.push(() => client.stop());

    let offline = '';
    client.onOffline = fp => { offline = fp; };
    client.dialNow(fpB);
    await sleep(800);
    expect(offline).toBe(fpB);
  });

  // 4. PASETO jti 重放 → 401 拒绝（决策 1 层 1）
  it('PASETO jti 重放 → 第二次 401 拒绝', async () => {
    const { serviceA, fpA, serviceB, fpB, authKey } = setupMutualPair();
    const { port } = await bootServer({ service: serviceB, listenPort: 0 });

    const now = Date.now();
    const dupJti = randomUUID();
    const token1 = encodePaseto({
      exp: now + 60000, iat: now,
      device_fingerprint: fpA, jti: dupJti, aud: fpB,
    }, authKey);
    const token2 = encodePaseto({
      exp: now + 60000, iat: now,
      device_fingerprint: fpA, jti: dupJti, aud: fpB,
    }, authKey);

    // 第一次拨：应连上（jti 未见）
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/?paseto=${encodeURIComponent(token1)}`);
    const r1 = await new Promise<'open' | 'error'>((res, rej) => {
      ws1.on('open', () => res('open'));
      ws1.on('error', e => res('error'));
    });
    expect(r1).toBe('open');
    ws1.close();

    await sleep(100);

    // 第二次拨同 jti：应 401 拒绝（jti 已见缓存）
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/?paseto=${encodeURIComponent(token2)}`);
    const r2 = await new Promise<'open' | 'error'>((res) => {
      ws2.on('open', () => res('open'));
      ws2.on('error', () => res('error'));
    });
    expect(r2).toBe('error');  // 401 拒绝
    try { ws2.close(); } catch { /* */ }
  });

  // 5. 主从裁决——myFp > peerFp 时不拨（决策 2）
  it('主从裁决：myFp > peerFp 时 start() 不拨', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();
    const { port } = await bootServer({ service: serviceB, listenPort: 0 });

    storeA = (serviceA as any).store as PairingStore;
    storeA.setAddress(fpB, `127.0.0.1:${port}`);

    // 构造一个 myFp > peerFp 的场景：
    // 如果 fpA < fpB，swap A/B 角色——让 serviceB 作为"本端"拨 serviceA
    // 如果 fpA > fpB，直接用 serviceA 拨 serviceB（不应拨）
    const client = new OutboundClient(serviceA, fpA, {
      pingIntervalMs: 10000,
      pongTimeoutMs: 5000,
      reconnectBackoffMs: [10000],
      pasetoTtlMs: 60000,
    });
    cleanups.push(() => client.stop());

    let online = '';
    client.onOnline = () => { online = 'should-not-fire'; };

    if (fpA > fpB) {
      // A 是大指纹 → 不应拨 B
      client.start();
      await sleep(300);
      expect(online).toBe('');
    } else {
      // A 是小指纹 → 会拨 B（online 应触发），改为验证反向：B 作为本端不拨 A
      // 用 serviceB 作为本端，fpB > fpA → 不拨
      const clientB = new OutboundClient(serviceB, fpB, {
        pingIntervalMs: 10000,
        pongTimeoutMs: 5000,
        reconnectBackoffMs: [10000],
        pasetoTtlMs: 60000,
      });
      cleanups.push(() => clientB.stop());
      // B 需要一个不存在的地址（拨不通也不应拨）
      (serviceB as any).store.setAddress(fpA, `127.0.0.1:${port}`);
      let onlineB = '';
      clientB.onOnline = () => { onlineB = 'should-not-fire'; };
      clientB.start();
      await sleep(300);
      expect(onlineB).toBe('');
    }
  });

  // 6. 断线重连退避（close 后按 backoff 重拨，决策 6）
  it('断线重连：B 重启后 A 重拨成功', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();

    // 用固定端口，方便重启后 A 重拨同一地址
    const { port, rpc } = await bootServer({ service: serviceB, listenPort: 0 });

    storeA = (serviceA as any).store as PairingStore;
    storeA.setAddress(fpB, `127.0.0.1:${port}`);

    const client = new OutboundClient(serviceA, fpA, {
      pingIntervalMs: 10000,
      pongTimeoutMs: 5000,
      reconnectBackoffMs: [50, 100, 200],
      pasetoTtlMs: 60000,
    });
    cleanups.push(() => client.stop());

    let onlineCount = 0;
    let offlineCount = 0;
    client.onOnline = () => { onlineCount++; };
    client.onOffline = () => { offlineCount++; };

    client.dialNow(fpB);
    await sleep(400);
    expect(onlineCount).toBe(1);

    // 关闭 B → A 应检测断线 → onOffline
    await rpc.close();
    await sleep(400);
    expect(offlineCount).toBeGreaterThanOrEqual(1);

    // 重启 B 在同端口 → A 按 backoff 重拨 → onOnline 再次触发
    await bootServer({ service: serviceB, listenPort: port });
    await sleep(1000);
    expect(onlineCount).toBeGreaterThanOrEqual(2);
  });

  // 7. ping/pong 判死（pong 超时 → terminate → onOffline，决策 6）
  it('ping/pong 判死：pong 超时 → onOffline', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();
    const { port } = await bootServer({ service: serviceB, listenPort: 0 });

    storeA = (serviceA as any).store as PairingStore;
    storeA.setAddress(fpB, `127.0.0.1:${port}`);

    const client = new OutboundClient(serviceA, fpA, {
      pingIntervalMs: 50,
      pongTimeoutMs: 150,
      reconnectBackoffMs: [10000],  // 长退避避免重拨干扰
      pasetoTtlMs: 60000,
    });
    cleanups.push(() => client.stop());

    let online = '';
    let offline = '';
    client.onOnline = fp => { online = fp; };
    client.onOffline = fp => { offline = fp; };

    client.dialNow(fpB);
    await sleep(400);
    expect(online).toBe(fpB);  // 互认成功

    // 移除客户端 ws 的 pong 监听器 → 下次 ping 后 pong 超时
    // OutboundClient 内部维护 connections Map，通过 internal API 访问 ws
    const conn = (client as any).connections?.get(fpB);
    expect(conn).toBeTruthy();
    const ws: WebSocket = conn.ws;
    ws.removeAllListeners('pong');  // 不再重置 pong 计时器

    await sleep(500);
    expect(offline).toBe(fpB);  // pong 超时 → onOffline
  });

  // 8. noProxy——HTTP_PROXY 设置时仍直连 LAN（红线 4e）
  it('noProxy：HTTP_PROXY 设置时仍直连 LAN', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();
    const { port } = await bootServer({ service: serviceB, listenPort: 0 });

    storeA = (serviceA as any).store as PairingStore;
    storeA.setAddress(fpB, `127.0.0.1:${port}`);

    // 设置恶意代理——ws 库不读 HTTP_PROXY，应直连成功
    const oldProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://evil-proxy:8080';
    cleanups.push(() => { if (oldProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = oldProxy; });

    const client = new OutboundClient(serviceA, fpA, {
      pingIntervalMs: 10000,
      pongTimeoutMs: 5000,
      reconnectBackoffMs: [100],
      pasetoTtlMs: 60000,
    });
    cleanups.push(() => client.stop());

    let online = '';
    client.onOnline = fp => { online = fp; };
    client.dialNow(fpB);
    await sleep(500);
    expect(online).toBe(fpB);  // 直连成功（不经代理）
  });

  // 9. PASETO 60s TTL 到期前重铸（连接存活超 TTL → 主动重连重铸 token 新 jti）
  it('PASETO TTL 到期前重铸：短 TTL → 重连 + 新 jti', async () => {
    const { serviceA, fpA, serviceB, fpB } = setupMutualPair();
    const { port } = await bootServer({ service: serviceB, listenPort: 0 });

    storeA = (serviceA as any).store as PairingStore;
    storeA.setAddress(fpB, `127.0.0.1:${port}`);

    const client = new OutboundClient(serviceA, fpA, {
      pingIntervalMs: 30,           // 短 ping 周期加速 TTL 检测
      pongTimeoutMs: 5000,
      reconnectBackoffMs: [20, 50],  // 短退避加速重连
      pasetoTtlMs: 150,             // 短 TTL 加速重铸
    });
    cleanups.push(() => client.stop());

    let onlineCount = 0;
    client.onOnline = () => { onlineCount++; };
    client.dialNow(fpB);
    await sleep(200);
    expect(onlineCount).toBeGreaterThanOrEqual(1);  // 首次互认成功

    // 等 TTL 过期 + 重连
    await sleep(500);
    expect(onlineCount).toBeGreaterThanOrEqual(2);  // TTL 重铸后重连成功
  });

  // M4.6 Task 2 — sync.hello mac 常量时间比较（A1）
  describe('M4.6 Task 2 — sync.hello mac 常量时间比较', () => {
    // 静态断言：实现必须用 timingSafeEqual（长度不同/空串下 `!==` 与 timingSafeEqual 行为一致，
    // 唯一可测差异是机制本身——读源码文本断言，行尾归一化）
    it('实现机制：doHello mac 校验使用 crypto.timingSafeEqual（源码静态断言）', () => {
      const srcFile = pathJoin(
        dirname(fileURLToPath(import.meta.url)),
        '../src/minisd/sync/outbound-client.ts',
      );
      const src = readFileSync(srcFile, 'utf8').replace(/\r\n/g, '\n');
      // 导入 + 调用点都出现 timingSafeEqual
      expect(src).toContain('timingSafeEqual');
      // 长度先行：先比长度再进 timingSafeEqual（timingSafeEqual 长度不等会抛，必须先比长度）
      expect(src).toMatch(/expectedBuf\.length === respBuf\.length/);
    });

    // 行为断言：对端返回长度不符的 mac（多/少字节）→ doHello 返回 false（onOffline），不抛错
    it('长度不符的 mac → 互认失败（onOffline），不抛错', async () => {
      const { serviceA, fpA, serviceB, fpB } = setupMutualPair();
      // 返回比正确 mac 短一字节的 hex（去掉末尾 2 个 hex 字符）
      const { port } = await bootServer({
        service: serviceB,
        listenPort: 0,
        customHello: (_p) => {
          const { hmac } = require('@noble/hashes/hmac.js');
          const { sha256 } = require('@noble/hashes/sha2.js');
          const mac = hmac(sha256, new Uint8Array(32).fill(0xAA), new TextEncoder().encode('m3c-hello' + _p.nonce));
          const hex = Buffer.from(mac).toString('hex');
          return { mac: hex.slice(0, hex.length - 2), listenPort: port }; // 少一字节
        },
      });

      storeA = (serviceA as any).store as PairingStore;
      storeA.setAddress(fpB, `127.0.0.1:${port}`);

      const client = new OutboundClient(serviceA, fpA, {
        pingIntervalMs: 10000,
        pongTimeoutMs: 5000,
        reconnectBackoffMs: [10000],
        pasetoTtlMs: 60000,
      });
      cleanups.push(() => client.stop());

      let offline = '';
      client.onOffline = fp => { offline = fp; };
      client.dialNow(fpB);
      await sleep(800);
      expect(offline).toBe(fpB); // 长度不符 → 互认失败，未抛错
    });
  });
});
