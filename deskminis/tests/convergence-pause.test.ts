/**
 * M6 Task 8 · R2 收敛正确性专项（方向 2 镜像：A 推 B，本端数据流出到对端）
 *
 * 先红后绿门控（硬要求）：本文件的方向 2 测试必须在"实现 Task 5 方案 A 之前"先红——
 * 场景：A 暂停 → A 本地改动 → A 恢复 → B 收到 A 的改动。
 * 判据：暂停期间 A 的 dirty 信号已被 flush 清空丢弃，恢复若只清标志不触发收敛（无方案 A），
 *       则 B 收不到 A 的改动（断言红）；实现方案 A（恢复时对全部 synced session 重 onDirty + flush）后转绿。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startMinisd } from '../src/minisd/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

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
      ws, notifications,
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

function writeFakeProviders(dir: string): void {
  writeFileSync(join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
    defaultProviderId: '__fake__',
  }, null, 2), 'utf8');
}

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { if (await cond()) break; } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(50);
  }
}

/** A 拨 B（A 是拨号方）：用于方向 2b。 */
async function setupTwoInstances(): Promise<{
  localA: RpcClient; localB: RpcClient;
  instA: { port: number; close(): Promise<void> }; instB: { port: number; close(): Promise<void> };
  dirA: string; dirB: string;
}> {
  const dirA = mkdtempSync(join(tmpdir(), 'dm-cv-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'dm-cv-b-'));
  cleanups.push(() => { try { rmSync(dirA, { recursive: true, force: true }); } catch { /* */ } });
  cleanups.push(() => { try { rmSync(dirB, { recursive: true, force: true }); } catch { /* */ } });
  writeFakeProviders(dirA);
  writeFakeProviders(dirB);

  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';

  const ra = await startMinisd({ dataDir: dirA, host: '127.0.0.1', port: 0 });
  const rb = await startMinisd({ dataDir: dirB, host: '127.0.0.1', port: 0 });
  const makeClose = (raw: typeof ra) => {
    let closed = false;
    return { port: raw.port, close: async () => { if (closed) return; closed = true; await raw.close(); } };
  };
  const instA = makeClose(ra);
  const instB = makeClose(rb);
  cleanups.push(() => instA.close());
  cleanups.push(() => instB.close());

  const localA = await wsConnect(`ws://127.0.0.1:${instA.port}/?token=${ra.authToken}`);
  const localB = await wsConnect(`ws://127.0.0.1:${instB.port}/?token=${rb.authToken}`);
  cleanups.push(() => localA.close());
  cleanups.push(() => localB.close());

  const begin = await localB.call('remote.pair.begin', {}) as any;
  await localA.call('remote.pair.join', {
    host: '127.0.0.1', port: instB.port, pairingCode: begin.pairingCode, peerName: 'B-设备', listenPort: 0,
  });

  await waitFor('A 拨 B 互认', async () => {
    const st = await localA.call('remote.status') as any;
    return st.devices.some((d: any) => d.online === true);
  }, 5000);

  return { localA, localB, instA, instB, dirA, dirB };
}

describe('R2 收敛方向 2（A 推 B：A 暂停 → A 改动 → A 恢复 → B 收到）', () => {
  it('方向 2：A 暂停 → A 写 → A 恢复 → B 收到 A 的改动（镜像；先红后绿门控）', async () => {
    const { localA, localB } = await setupTwoInstances();

    const s = await localA.call('chat.sessions.create', { title: 'dir2' }) as any;
    // 基线：写一条并等 B 收敛（确立连接 + 基线消息数）
    await localA.call('chat.prompt', { sessionId: s.id, text: '基线', providerId: '__fake__' });
    await waitFor('B 收到基线', async () => {
      const b = (await localB.call('sync.pull', { sessionId: s.id }) as any).messages;
      return b.length > 0;
    }, 5000);
    const baseline = ((await localB.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).length;

    // A 暂停
    const pauseRes = await localA.call('control.pause') as any;
    expect(pauseRes.syncPaused).toBe(true);

    // A 暂停期间写一条本地改动
    await localA.call('chat.prompt', { sessionId: s.id, text: '暂停期改动', providerId: '__fake__' });
    await sleep(400); // 让暂停期 dirty 触发 flush 并被丢弃（决策点 2-7：恢复无残留队列）

    // A 恢复（无方案 A 时：只清标志，不触发收敛）
    const resumeRes = await localA.call('control.resume') as any;
    expect(resumeRes.syncPaused).toBe(false);
    await sleep(800); // 若方案 A 存在，B 应在此窗口收到 A 的改动

    const after = ((await localB.call('sync.pull', { sessionId: s.id }) as any).messages as any[]).length;
    // 断言方向 2：恢复后 B 必须收到 A 暂停期写的改动（无方案 A 时此断言红）
    expect(after).toBeGreaterThan(baseline);
  }, 30000);
});