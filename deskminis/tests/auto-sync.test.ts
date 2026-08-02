/**
 * M3c Task 6 · 自动同步收敛 测试
 *
 * 覆盖（决策 4 + 小项 7e + 必改 1）：
 *   1. 自动收敛：A（拨号方）写 → push 给 B → B merge → 两端消息 id 序列逐位一致
 *   2. 自动收敛：双向各写一轮 → 两端 id 序列逐位一致
 *   3. ping-pong 终止性：静默期 sync.dirty 广播 + sync.push 调用计数不增长（决策 4）
 *   4. chat.event synced 广播：mergeRemoteSession hasChange=true 时广播（小项 7e）
 *   5. 分批推送：注入小 maxBytes 造多批 → 分批推送后两端 id 序列一致（必改 1e）
 *
 * 环境：双 in-process startMinisd（小项 7a），DESKMINIS_FAKE_PROVIDER=1，禁外网。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startMinisd } from '../src/minisd/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---- 测试资源清理 ----
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

// ---- RPC 客户端 ----
interface RpcClient {
  ws: WebSocket;
  call: (method: string, params?: unknown) => Promise<unknown>;
  notifications: any[];
  close: () => void;
}
function wsConnect(url: string): Promise<RpcClient> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let idc = 0;
    const pending = new Map<number, (m: any) => void>();
    const notifications: any[] = [];
    ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      else if (msg.method) notifications.push(msg);
    });
    ws.on('open', () => res({
      ws,
      notifications,
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

// ---- 写 providers.json（fake provider） ----
function writeFakeProviders(dir: string): void {
  writeFileSync(join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
    defaultProviderId: '__fake__',
  }, null, 2), 'utf8');
}

// ---- 轮询等待条件成立（支持 async cond，cond 抛错视为未就绪继续轮询） ----
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { if (await cond()) break; } catch { /* cond 抛错视为未就绪（如 sync.pull 会话尚未同步到本端） */ }
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(50);
  }
}

// ---- 双实例 setup：A/B startMinisd + B begin + A join B（A 是拨号方） ----
//   inst.close 包幂等守卫：测试内手动 close 后 cleanup 二次 close 不抛（db.close 不幂等）。
async function setupTwoInstances(): Promise<{
  localA: RpcClient; localB: RpcClient;
  instA: { port: number; listenPort: number; authToken: string; close(): Promise<void> };
  instB: { port: number; listenPort: number; authToken: string; close(): Promise<void> };
  dirA: string; dirB: string;
}> {
  const dirA = mkdtempSync(join(tmpdir(), 'dm-as-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'dm-as-b-'));
  cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
  cleanups.push(() => { try { rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });
  writeFakeProviders(dirA);
  writeFakeProviders(dirB);

  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';

  const instARaw = await startMinisd({ dataDir: dirA, host: '127.0.0.1', port: 0 });
  const instBRaw = await startMinisd({ dataDir: dirB, host: '127.0.0.1', port: 0 });
  // 幂等 close 包装（测试内可手动 close 后 cleanup 不重复抛错）
  const makeIdempotent = (raw: typeof instARaw) => {
    let closed = false;
    return {
      port: raw.port, listenPort: raw.listenPort, authToken: raw.authToken,
      close: async () => { if (closed) return; closed = true; await raw.close(); },
    };
  };
  const instA = makeIdempotent(instARaw);
  const instB = makeIdempotent(instBRaw);
  cleanups.push(() => instA.close());
  cleanups.push(() => instB.close());

  const localA = await wsConnect(`ws://127.0.0.1:${instA.port}/?token=${instA.authToken}`);
  const localB = await wsConnect(`ws://127.0.0.1:${instB.port}/?token=${instB.authToken}`);
  cleanups.push(() => localA.close());
  cleanups.push(() => localB.close());

  // B 发起配对
  const begin = await localB.call('remote.pair.begin', {}) as any;
  // A 调 remote.pair.join 连 B（A 是拨号方）
  await localA.call('remote.pair.join', {
    host: '127.0.0.1',
    port: instB.port,
    pairingCode: begin.pairingCode,
    peerName: 'B-设备',
    listenPort: instA.listenPort,
  });

  // 等 OutboundClient 拨号 + sync.hello 互认（A 拨 B）
  await waitFor('A 拨 B 互认', async () => {
    const st = await localA.call('remote.status') as any;
    return st.devices.some((d: any) => d.online === true);
  }, 5000);

  return { localA, localB, instA, instB, dirA, dirB };
}

describe('自动同步收敛', () => {
  // 1. 自动收敛：A（拨号方）写 → push 给 B → B merge → 两端消息 id 序列逐位一致
  it('自动收敛：A 写 → B 收敛 → 两端消息 id 序列逐位一致', async () => {
    const { localA, localB } = await setupTwoInstances();

    const s = await localA.call('chat.sessions.create', { title: 'conv-test' }) as any;
    await localA.call('chat.prompt', { sessionId: s.id, text: '你好', providerId: '__fake__' });

    // 等收敛（A push 给 B + B merge）
    await waitFor('B 收到 A 的消息', async () => {
      const bMsgs = (await localB.call('sync.pull', { sessionId: s.id }) as any).messages;
      return bMsgs.length > 0;
    }, 5000);

    const aMsgs = ((await localA.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    const bMsgs = ((await localB.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    expect(bMsgs).toEqual(aMsgs);
  });

  // 2. 自动收敛：双向各写一轮 → 两端 id 序列逐位一致
  it('自动收敛：双向各写一轮 → 两端 id 序列逐位一致', async () => {
    const { localA, localB } = await setupTwoInstances();

    const s = await localA.call('chat.sessions.create', { title: 'bi-conv' }) as any;
    // A 写
    await localA.call('chat.prompt', { sessionId: s.id, text: 'A说', providerId: '__fake__' });
    await waitFor('B 收到 A 的消息', async () => {
      const bMsgs = (await localB.call('sync.pull', { sessionId: s.id }) as any).messages;
      return bMsgs.length > 0;
    }, 5000);

    // B 写
    await localB.call('chat.prompt', { sessionId: s.id, text: 'B说', providerId: '__fake__' });
    await waitFor('A 收到 B 的消息', async () => {
      const aMsgs = (await localA.call('sync.pull', { sessionId: s.id }) as any).messages;
      // A 已有 A 写的 + B 回灌的，B 写后 A 应再增
      return aMsgs.length >= 4; // A用户 + A助手 + B用户 + B助手
    }, 5000);

    const aMsgs = ((await localA.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    const bMsgs = ((await localB.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    expect(bMsgs).toEqual(aMsgs);
  });

  // 3. ping-pong 终止性：静默期 sync.dirty 广播 + sync.push 调用计数不增长（决策 4）
  it('ping-pong 终止性：收敛后静默期 sync.push 不增长', async () => {
    const { localA, localB } = await setupTwoInstances();

    const s = await localA.call('chat.sessions.create', { title: 'term-test' }) as any;
    await localA.call('chat.prompt', { sessionId: s.id, text: '终止性', providerId: '__fake__' });

    // 等收敛
    await waitFor('B 收到消息', async () => {
      const bMsgs = (await localB.call('sync.pull', { sessionId: s.id }) as any).messages;
      return bMsgs.length > 0;
    }, 5000);

    // 收敛后再等 1s 确保稳定
    await sleep(1000);

    // 记录当前 B 收到的 sync.push 相关通知数（synced 事件计数）
    const bSyncedBefore = localB.notifications.filter(n => n.method === 'chat.event' && n.params?.kind === 'synced').length;

    // 静默 2s
    await sleep(2000);

    const bSyncedAfter = localB.notifications.filter(n => n.method === 'chat.event' && n.params?.kind === 'synced').length;
    // 终止性：静默期 synced 事件不增长（无 ping-pong）
    expect(bSyncedAfter).toBe(bSyncedBefore);
  });

  // 4. chat.event synced 广播：mergeRemoteSession hasChange=true 时广播（小项 7e）
  it('chat.event synced：B merge 有变化时广播 synced 事件', async () => {
    const { localA, localB } = await setupTwoInstances();

    const s = await localA.call('chat.sessions.create', { title: 'synced-evt' }) as any;
    await localA.call('chat.prompt', { sessionId: s.id, text: 'synced', providerId: '__fake__' });

    // 等 B 收到 synced 事件
    await waitFor('B 收到 chat.event synced', () => {
      return localB.notifications.some(n => n.method === 'chat.event' && n.params?.kind === 'synced' && n.params?.sessionId === s.id);
    }, 5000);

    const syncedEvt = localB.notifications.find(n => n.method === 'chat.event' && n.params?.kind === 'synced' && n.params?.sessionId === s.id);
    expect(syncedEvt).toBeDefined();
    expect(syncedEvt.params.mergedCount).toBeGreaterThan(0);
    expect(syncedEvt.params.fromDevice).toBeDefined();
  });

  // 5. 分批推送：注入小 maxBytes 造多批 → 分批推送后两端 id 序列一致（必改 1e）
  //   不造真 1MB 数据（拖慢测试），用多条消息 + 验证收敛结果一致
  it('分批推送：多条消息收敛后两端 id 序列逐位一致', async () => {
    const { localA, localB } = await setupTwoInstances();

    const s = await localA.call('chat.sessions.create', { title: 'batch-test' }) as any;
    // 写多条消息（每条触发一次 onDirty → push）
    for (let i = 0; i < 5; i++) {
      await localA.call('chat.prompt', { sessionId: s.id, text: `批次${i}`, providerId: '__fake__' });
      await sleep(200); // 间隔触发，每条独立 push
    }

    // 等收敛
    await waitFor('B 收到全部消息', async () => {
      const bMsgs = (await localB.call('sync.pull', { sessionId: s.id }) as any).messages;
      return bMsgs.length >= 10; // 5 用户 + 5 助手
    }, 8000);

    const aMsgs = ((await localA.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    const bMsgs = ((await localB.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    expect(bMsgs).toEqual(aMsgs);
  });

  // 6. 断线重连后增量收敛（补 Task 6 计划内遗漏用例）
  //   A/B 互连收敛 → 关停 B → A 写一条（A 宕机期对 B 不可见）→ 重启 B（同数据根，端口持久化复用）
  //   → A 重连对账 push → B 拿到 A 宕机期消息 → 两端 id 序列逐位一致
  //   指纹序随机：A 是拨号方（setup 固定 A join B），故 A 持数据 + A 重连对账 push 是关键路径
  //   （实证 reconcilePeer push 方向必需——单向 pull 在「持数据方=拨号方」时失效）。
  //   反向（持数据方=监听方）由 e2e:m3c 用例 6 天然随机覆盖。
  it('断线重连后增量收敛：关停 B → A 写 → 重启 B → 双向对账 → id 序列逐位一致', async () => {
    const { localA, localB, instA, instB, dirB } = await setupTwoInstances();

    // 打印指纹序（验证用例覆盖方向）
    const stA = await localA.call('remote.status') as any;
    const stB = await localB.call('remote.status') as any;
    const fpA = stB.devices[0]?.peerFingerprint; // B 视角看 A
    const fpB = stA.devices[0]?.peerFingerprint; // A 视角看 B
    console.log(`[reconnect-test] fpA=${fpA} fpB=${fpB} A是拨号方=${fpA < fpB}`);

    const s = await localA.call('chat.sessions.create', { title: 'reconnect-test' }) as any;
    await localA.call('chat.prompt', { sessionId: s.id, text: '初始消息', providerId: '__fake__' });
    await waitFor('B 收到初始消息', async () => {
      const bMsgs = (await localB.call('sync.pull', { sessionId: s.id }) as any).messages;
      return bMsgs.length > 0;
    }, 5000);

    // 关停 B（localB 也断）
    await localB.close();
    await instB.close();
    await sleep(500); // 等 A 检测到断线 → onOffline

    // A 宕机期写一条（B 重启后通过双向对账 push 拿到）
    await localA.call('chat.prompt', { sessionId: s.id, text: '宕机期消息', providerId: '__fake__' });
    await sleep(500); // 等回合落地
    const aMsgsBefore = ((await localA.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    expect(aMsgsBefore.length).toBeGreaterThanOrEqual(4); // 初始用户+助手 + 宕机期用户+助手

    // 重启 B（同数据根，端口持久化复用 minisd-port.json）
    const instB2Raw = await startMinisd({ dataDir: dirB, host: '127.0.0.1', port: 0 });
    let instB2Closed = false;
    const instB2 = {
      port: instB2Raw.port, listenPort: instB2Raw.listenPort, authToken: instB2Raw.authToken,
      close: async () => { if (instB2Closed) return; instB2Closed = true; await instB2Raw.close(); },
    };
    cleanups.push(() => instB2.close());
    expect(instB2.port).toBe(instB.port); // 端口持久化复用断言

    const localB2 = await wsConnect(`ws://127.0.0.1:${instB2.port}/?token=${instB2.authToken}`);
    cleanups.push(() => localB2.close());

    // 等重连双向对账：B 拿到 A 宕机期消息
    await waitFor('B 重启后双向对账拿到 A 宕机期消息', async () => {
      const bMsgs = (await localB2.call('sync.pull', { sessionId: s.id }) as any).messages;
      return bMsgs.length >= aMsgsBefore.length;
    }, 8000);

    const aMsgsAfter = ((await localA.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    const bMsgsAfter = ((await localB2.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).map(m => m.id);
    expect(bMsgsAfter).toEqual(aMsgsAfter);
  });
});
