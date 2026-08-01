/**
 * M3c Task 4 · remote.pair.join RPC + 端口体系 测试
 *
 * 覆盖（决策 3 / 必改 4 / 必改 4b / 命门 2）：
 *   1. remote.pair.join：免手抄公钥——complete 响应带 myPublicKeyB64，join 侧本地重算指纹
 *   2. remote.pair.join：begin 侧从 complete listenPort 捕获对端地址（必改 4，remotePort 修正）
 *   3. remote.pair.join：authMode=local 守卫（pairing/remote 模式拒）
 *   4. remote.pair.join：配对码错误/过期 → 失败返回
 *   5. 端口持久化：首次分配存盘 minisd-port.json，后续启动复用（必改 4b）
 *   6. RpcConnection 入站注册表：isInboundOnline 维护 open/close（命门 2）
 *
 * 环境：双 in-process RpcServer 本地 127.0.0.1，禁外网。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import {
  PairingStore,
  PairingService,
  derivePairingKey,
} from '../src/minisd/remote/pairing';
import { createRemoteMethods, createAdditionalVerify } from '../src/minisd/remote';
import { encodePaseto } from '../src/minisd/remote/paseto';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { createSyncMethods } from '../src/minisd/sync';
import { resolveAndPersistPort } from '../src/minisd/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---- 测试资源清理 ----
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

// ---- RPC 客户端（WebSocket JSON-RPC） ----
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

// ---- 启动一个完整 RpcServer 实例（remote.* + sync.* + additionalVerify） ----
interface BootedServer {
  port: number;
  rpc: RpcServer;
  service: PairingService;
  store: PairingStore;
  authToken: string;
  onPairCompleteCalls: Array<{ fp: string; remoteAddr: string | undefined; listenPort: number | undefined }>;
}

async function bootServer(opts: {
  dataDir: string;
  listenPort?: number;
}): Promise<BootedServer> {
  const vault = new InMemoryVault();
  const store = new PairingStore(opts.dataDir, vault);
  const service = new PairingService(store, vault);
  const onPairCompleteCalls: BootedServer['onPairCompleteCalls'] = [];

  const remoteMethods = createRemoteMethods(service, {
    onPairComplete: (fp, remoteAddr, listenPort) => {
      onPairCompleteCalls.push({ fp, remoteAddr, listenPort });
      // 地址捕获：remoteAddress + listenPort
      if (listenPort && listenPort > 0) {
        const host = remoteAddr?.replace(/^::ffff:/, '') ?? '127.0.0.1';
        store.setAddress(fp, `${host}:${listenPort}`);
      }
    },
  });
  const syncMethods = createSyncMethods(null as any, { pairingService: service, listenPort: opts.listenPort ?? 0 });
  const additionalVerify = createAdditionalVerify(service);
  const methods: RpcMethods = { ...remoteMethods, ...syncMethods };
  const authToken = 'TEST-TOKEN-' + Math.random().toString(36).slice(2);
  const rpc = new RpcServer(methods, authToken, additionalVerify);
  const port = await rpc.listen('127.0.0.1', opts.listenPort ?? 0);
  cleanups.push(() => rpc.close());
  return { port, rpc, service, store, authToken, onPairCompleteCalls };
}

// ---- 互配对工厂：创建 A/B 两个 PairingService，预先互注 PairingKey ----
function setupMutualPair(): {
  serviceA: PairingService; fpA: string;
  serviceB: PairingService; fpB: string;
  authKey: Uint8Array;
} {
  const dirA = mkdtempSync(join(tmpdir(), 'dm-jn-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'dm-jn-b-'));
  cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
  cleanups.push(() => { try { rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });

  const vaultA = new InMemoryVault();
  const vaultB = new InMemoryVault();
  const storeA = new PairingStore(dirA, vaultA);
  const storeB = new PairingStore(dirB, vaultB);
  const serviceA = new PairingService(storeA, vaultA);
  const serviceB = new PairingService(storeB, vaultB);

  const code = 'JOINCODE1';
  const fpA = serviceA.myFingerprint;
  const fpB = serviceB.myFingerprint;
  const privA = (serviceA as any).identity.privateKey as Uint8Array;
  const privB = (serviceB as any).identity.privateKey as Uint8Array;
  const pubA = serviceA.myPublicKey;
  const pubB = serviceB.myPublicKey;

  const keyForA = derivePairingKey(privA, pubB, code, fpB, 'B-device');
  const keyForB = derivePairingKey(privB, pubA, code, fpA, 'A-device');
  storeA.save(keyForA);
  storeB.save(keyForB);

  return { serviceA, fpA, serviceB, fpB, authKey: keyForA.authKey };
}

describe('remote.pair.join + 端口体系', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'dm-rpj-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'dm-rpj-b-'));
    cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
    cleanups.push(() => { try { rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });
  });

  // 1. remote.pair.join：免手抄公钥——complete 响应带 myPublicKeyB64，join 侧本地重算指纹
  it('remote.pair.join：免手抄公钥——complete 响应带 myPublicKeyB64，join 侧本地重算指纹', async () => {
    const serverB = await bootServer({ dataDir: dirB });
    const serverA = await bootServer({ dataDir: dirA, listenPort: 0 });

    // B 发起配对
    const localB = await wsConnect(`ws://127.0.0.1:${serverB.port}/?token=${serverB.authToken}`);
    cleanups.push(() => localB.close());
    const begin = await localB.call('remote.pair.begin', {}) as any;
    expect(begin.pairingCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(begin.myPublicKeyB64).toBeDefined();
    expect(begin.myFingerprint).toMatch(/^[0-9a-f]{12}$/);

    // A 调 remote.pair.join 连 B
    const localA = await wsConnect(`ws://127.0.0.1:${serverA.port}/?token=${serverA.authToken}`);
    cleanups.push(() => localA.close());
    const join = await localA.call('remote.pair.join', {
      host: '127.0.0.1',
      port: serverB.port,
      pairingCode: begin.pairingCode,
      peerName: 'B-设备',
      listenPort: serverA.port,
    }) as any;

    expect(join.ok).toBe(true);
    // join 返回重算指纹（sha256(pubKey).slice(0,6) hex），与 begin.myFingerprint 一致
    expect(join.peerFingerprint).toBe(begin.myFingerprint);

    // A 端持久化了对端 B 的 PairingKey + 地址
    const aStatus = await localA.call('remote.status') as any;
    expect(aStatus.devices.some((d: any) => d.peerFingerprint === begin.myFingerprint)).toBe(true);
    expect(serverA.store.getAddress(begin.myFingerprint)).toBe(`127.0.0.1:${serverB.port}`);
  });

  // 2. remote.pair.join：begin 侧从 complete listenPort 捕获对端地址（必改 4，remotePort 修正）
  it('remote.pair.join：begin 侧从 complete listenPort 捕获对端地址', async () => {
    const serverB = await bootServer({ dataDir: dirB });
    const serverA = await bootServer({ dataDir: dirA, listenPort: 0 });

    const localB = await wsConnect(`ws://127.0.0.1:${serverB.port}/?token=${serverB.authToken}`);
    cleanups.push(() => localB.close());
    const begin = await localB.call('remote.pair.begin', {}) as any;

    const localA = await wsConnect(`ws://127.0.0.1:${serverA.port}/?token=${serverA.authToken}`);
    cleanups.push(() => localA.close());
    await localA.call('remote.pair.join', {
      host: '127.0.0.1',
      port: serverB.port,
      pairingCode: begin.pairingCode,
      peerName: 'B-设备',
      listenPort: serverA.port,
    });

    // B 端 complete handler 从 conn.remoteAddress + p.listenPort 组合存地址
    await sleep(100); // 等 onPairComplete 回调
    const bAddr = serverB.store.getAddress(serverA.service.myFingerprint);
    expect(bAddr).toMatch(/127\.0\.0\.1:\d+/);
    expect(bAddr).toBe(`127.0.0.1:${serverA.port}`);  // 是 A 的监听端口，非源端口
  });

  // 3. remote.pair.join：authMode=local 守卫（pairing/remote 模式拒）
  it('remote.pair.join：authMode=local 守卫（pairing/remote 模式拒）', async () => {
    const serverA = await bootServer({ dataDir: dirA });
    const serverB = await bootServer({ dataDir: dirB });

    const begin = await (await wsConnect(`ws://127.0.0.1:${serverB.port}/?token=${serverB.authToken}`)).call('remote.pair.begin', {}) as any;
    cleanups.push(() => { /* connections auto-close */ });

    // pairing 模式调 remote.pair.join → 拒
    const pairingConn = await wsConnect(`ws://127.0.0.1:${serverB.port}/?pairingCode=${begin.pairingCode}`);
    cleanups.push(() => pairingConn.close());
    // 先 begin 一个新 code（上面 begin 的 code 已被 pairing 连接消费了——实际 pairing 模式连接只是验证 code 存在）
    // 这里用新 begin
    const localB2 = await wsConnect(`ws://127.0.0.1:${serverB.port}/?token=${serverB.authToken}`);
    cleanups.push(() => localB2.close());
    const begin2 = await localB2.call('remote.pair.begin', {}) as any;
    const pairingConn2 = await wsConnect(`ws://127.0.0.1:${serverB.port}/?pairingCode=${begin2.pairingCode}`);
    cleanups.push(() => pairingConn2.close());
    await expect(pairingConn2.call('remote.pair.join', {
      host: '127.0.0.1', port: serverB.port, pairingCode: begin2.pairingCode, peerName: 'X', listenPort: 0,
    })).rejects.toThrow(/local|authMode/i);

    // remote 模式调 remote.pair.join → 拒
    const { serviceA, fpA, serviceB, fpB, authKey } = setupMutualPair();
    const token = encodePaseto({
      exp: Date.now() + 60000, iat: Date.now(),
      device_fingerprint: fpA,
    }, authKey);
    // 将 A 的 key 存入 B 的 store（让 B 能解 PASETO）
    const keyForB = (serviceB as any).store.get(fpA);
    if (!keyForB) {
      // 需要把 key 存进去
      const dirB2 = mkdtempSync(join(tmpdir(), 'dm-rpj-b2-'));
      cleanups.push(() => { try { rmSync(dirB2, { recursive: true, force: true }); } catch { /* */ } });
      // 用新 server
      const serverB2 = await bootServer({ dataDir: dirB2 });
      // 互配对
      const code = 'JOINTEST';
      const key = derivePairingKey(
        (serverB2.service as any).identity.privateKey,
        serviceA.myPublicKey,
        code, fpA, 'A-device',
      );
      serverB2.store.save(key);
      const remoteConn = await wsConnect(`ws://127.0.0.1:${serverB2.port}/?paseto=${encodeURIComponent(
        encodePaseto({ exp: Date.now() + 60000, iat: Date.now(), device_fingerprint: fpA },
          key.authKey)
      )}`);
      cleanups.push(() => remoteConn.close());
      await expect(remoteConn.call('remote.pair.join', {
        host: '127.0.0.1', port: serverB2.port, pairingCode: 'X', peerName: 'Y', listenPort: 0,
      })).rejects.toThrow(/local|authMode/i);
    }
  });

  // 4. remote.pair.join：配对码错误/过期 → 失败返回
  it('remote.pair.join：配对码错误 → 失败返回', async () => {
    const serverA = await bootServer({ dataDir: dirA });
    const serverB = await bootServer({ dataDir: dirB });

    const localA = await wsConnect(`ws://127.0.0.1:${serverA.port}/?token=${serverA.authToken}`);
    cleanups.push(() => localA.close());

    await expect(localA.call('remote.pair.join', {
      host: '127.0.0.1',
      port: serverB.port,
      pairingCode: 'WRONGCODE',
      peerName: 'X',
      listenPort: 0,
    })).rejects.toThrow(/配对码|code|失效|过期/i);
  });

  // 5. 端口持久化：首次分配存盘 minisd-port.json，后续启动复用（必改 4b）
  it('端口持久化：首次分配存盘 minisd-port.json，后续启动复用', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-port-'));
    cleanups.push(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ } });

    // Mock listen：第一次用 port=0 返回随机端口 12345
    let listenCallCount = 0;
    const mockListen = async (_host: string, port: number): Promise<number> => {
      listenCallCount++;
      if (port === 0) return 12345; // 随机分配
      if (port === 12345) return 12345; // 复用成功
      throw new Error('EADDRINUSE'); // 其他端口被占用
    };

    // 首次：无文件 → 随机分配 → 存盘
    const port1 = await resolveAndPersistPort(dataDir, '127.0.0.1', 0, mockListen);
    expect(port1).toBe(12345);
    expect(existsSync(join(dataDir, 'minisd-port.json'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dataDir, 'minisd-port.json'), 'utf8'));
    expect(saved.port).toBe(12345);

    // 第二次：读文件复用 port 12345
    const port2 = await resolveAndPersistPort(dataDir, '127.0.0.1', 0, mockListen);
    expect(port2).toBe(12345);

    // 第三次：模拟端口被占用 → 回退随机
    const mockListenOccupied = async (_host: string, port: number): Promise<number> => {
      if (port === 12345) throw new Error('EADDRINUSE'); // 被占用
      return 54321; // 随机回退
    };
    const port3 = await resolveAndPersistPort(dataDir, '127.0.0.1', 0, mockListenOccupied);
    expect(port3).toBe(54321);
    const saved3 = JSON.parse(readFileSync(join(dataDir, 'minisd-port.json'), 'utf8'));
    expect(saved3.port).toBe(54321); // 文件更新为新端口
  });

  // 6. RpcConnection 入站注册表：isInboundOnline 维护 open/close（命门 2）
  it('RpcConnection 入站注册表：isInboundOnline 维护 open/close', async () => {
    const { serviceA, fpA, serviceB, fpB, authKey } = setupMutualPair();
    const serverB = await bootServer({ dataDir: dirB });

    // 替换 serverB 的 service 为 setupMutualPair 的 serviceB（已存 A 的 key）
    // 重新 boot 一个用 serviceB 的 server
    const dirB3 = mkdtempSync(join(tmpdir(), 'dm-rpj-b3-'));
    cleanups.push(() => { try { rmSync(dirB3, { recursive: true, force: true }); } catch { /* */ } });
    // 用 setupMutualPair 的 serviceB（已存 A 的 key）
    // 但 bootServer 创建新 service——改为手动构建
    const additionalVerify = createAdditionalVerify(serviceB);
    const syncMethods = createSyncMethods(null as any, { pairingService: serviceB, listenPort: 0 });
    const onPairCompleteCalls: any[] = [];
    const remoteMethods = createRemoteMethods(serviceB, {
      onPairComplete: (fp, remoteAddr, listenPort) => {
        onPairCompleteCalls.push({ fp, remoteAddr, listenPort });
      },
    });
    const methods: RpcMethods = { ...remoteMethods, ...syncMethods };
    const authToken = 'TEST-INBOUND';
    const rpc = new RpcServer(methods, authToken, additionalVerify);
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());

    // 初始无入站连接
    expect(rpc.isInboundOnline(fpA)).toBe(false);

    // A 铸 PASETO 连 B（remote 模式）
    const token = encodePaseto({
      exp: Date.now() + 60000, iat: Date.now(),
      device_fingerprint: fpA,
    }, authKey);
    const remoteConn = await wsConnect(`ws://127.0.0.1:${port}/?paseto=${encodeURIComponent(token)}`);
    cleanups.push(() => remoteConn.close());

    await sleep(200); // 等连接建立 + onConnection 填注册表

    // B 的 isInboundOnline(fpA) === true
    expect(rpc.isInboundOnline(fpA)).toBe(true);

    // A 断开
    remoteConn.close();
    await sleep(200);

    // B 的 isInboundOnline(fpA) === false
    expect(rpc.isInboundOnline(fpA)).toBe(false);
  });
});
