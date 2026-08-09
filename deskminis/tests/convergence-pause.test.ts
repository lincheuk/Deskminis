/**
 * M6 Task 8 · R2 收敛正确性专项（双向 × 双角色，共四条子路径）
 *
 * 拓扑约定（remote.pair 语义：begin = 监听方托管等待入站，join = 拨号方主动拨入）：
 *   - 拨号方 = join 侧（主动拨入），监听方 = begin 侧（托管等待入站）。
 *   - converged 目标：解除暂停后两端收敛回一致，无永久丢失、无重复（id 幂等）。
 *
 * 方向 1（对端数据流入本端）：A 暂停 → B 改动 → A 恢复 → A 收敛到 B 的改动。
 *   - 1a：A 为监听方（B push 经 A 的 sync.push handler 收下合并）——收下照常，暂停期即已流入。
 *   - 1b：A 为拨号方（B dirty → A onRemoteDirty → pullFromPeer 收下合并）——pull 不受暂停影响。
 * 方向 2（本端数据流出到对端，镜像）：A 暂停 → A 本地改动 → A 恢复 → B 收到 A 的改动。
 *   - 2a：A 为监听方（恢复后 flush 广播 sync.dirty → B 拨号方 pull 拉取）——方案 A 覆盖监听方角色。
 *   - 2b：A 为拨号方（恢复后 flush pushToPeer 推给 B）——方案 A 覆盖拨号方角色。
 *
 * 先红后绿门控（硬要求）：方向 2 测试在"实现 Task 5 方案 A 之前"必须先红——本文件 2b 是门控主测试，
 * 已先红（commit 6e191b8）后转绿（commit 444d018）。剩余子路径为方案 A 落地后的全量补齐验证。
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

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { if (await cond()) break; } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(50);
  }
}

/** 建立双实例对。dialer='A'：A 拨 B（A 拨号方，B 监听方）；dialer='B'：B 拨 A（A 监听方，B 拨号方）。 */
async function setupTwoInstances(dialer: 'A' | 'B'): Promise<{
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

  // begin = 监听方（托管等待入站），join = 拨号方（主动拨入）
  if (dialer === 'A') {
    const begin = await localB.call('remote.pair.begin', {}) as any;
    await localA.call('remote.pair.join', {
      host: '127.0.0.1', port: instB.port, pairingCode: begin.pairingCode, peerName: 'B-设备', listenPort: 0,
    });
  } else {
    const begin = await localA.call('remote.pair.begin', {}) as any;
    await localB.call('remote.pair.join', {
      host: '127.0.0.1', port: instA.port, pairingCode: begin.pairingCode, peerName: 'A-设备', listenPort: 0,
    });
  }

  await waitFor('Pairing 互认', async () => {
    const st = await localA.call('remote.status') as any;
    return st.devices.some((d: any) => d.online === true);
  }, 5000);

  return { localA, localB, instA, instB, dirA, dirB };
}

async function msgCount(cli: RpcClient, sid: string): Promise<number> {
  const r = await cli.call('sync.pull', { sessionId: sid }) as any;
  return (r.messages as any[]).length;
}

describe('R2 收敛方向 1（B 推 A：A 暂停 → B 改动 → A 恢复 → A 收敛到 B 的改动）', () => {
  it('1a：A 为监听方（B push 经 A 的 sync.push handler 收下合并）', async () => {
    const { localA, localB } = await setupTwoInstances('B');
    const s = await localA.call('chat.sessions.create', { title: 'dir1a' }) as any;
    await localA.call('chat.prompt', { sessionId: s.id, text: '基线', providerId: '__fake__' });
    await waitFor('A 基线收敛到 B', async () => (await msgCount(localB, s.id)) > 0, 5000);
    const baselineA = await msgCount(localA, s.id);

    await localA.call('control.pause') as any;
    await localB.call('chat.prompt', { sessionId: s.id, text: 'B改动', providerId: '__fake__' });
    await sleep(600); // B push → A sync.push 收下合并（收下照常，不因暂停受损）
    const during = await msgCount(localA, s.id);
    expect(during).toBeGreaterThan(baselineA); // 监听方 A 暂停期即已收下 B 的改动

    await localA.call('control.resume') as any;
    await sleep(400);
    await waitFor('A 收敛到 B 改动', async () => (await msgCount(localA, s.id)) === during, 3000);
    expect(await msgCount(localA, s.id)).toBeGreaterThan(baselineA);
  }, 30000);

  it('1b：A 为拨号方（B dirty → A onRemoteDirty → pullFromPeer 收下合并）', async () => {
    const { localA, localB } = await setupTwoInstances('A');
    const s = await localA.call('chat.sessions.create', { title: 'dir1b' }) as any;
    await localA.call('chat.prompt', { sessionId: s.id, text: '基线', providerId: '__fake__' });
    await waitFor('A 基线收敛到 B', async () => (await msgCount(localB, s.id)) > 0, 5000);
    const baselineA = await msgCount(localA, s.id);

    await localA.call('control.pause') as any;
    await localB.call('chat.prompt', { sessionId: s.id, text: 'B改动', providerId: '__fake__' });
    await sleep(800); // B 广播 sync.dirty → A onRemoteDirty → pullFromPeer（pull 不受暂停影响）
    const during = await msgCount(localA, s.id);
    expect(during).toBeGreaterThan(baselineA); // 拨号方 A 暂停期 pull 照常，已收下

    await localA.call('control.resume') as any;
    await waitFor('A 收敛到 B 改动', async () => (await msgCount(localA, s.id)) === during, 3000);
    expect(await msgCount(localA, s.id)).toBeGreaterThan(baselineA);
  }, 30000);
});

describe('R2 收敛方向 2（A 推 B：A 暂停 → A 本地改动 → A 恢复 → B 收到 A 的改动）', () => {
  it('2a：A 为监听方（恢复后 flush 广播 sync.dirty → B 拨号方 pull 拉取；方案 A 覆盖监听方角色）', async () => {
    const { localA, localB } = await setupTwoInstances('B');
    const s = await localA.call('chat.sessions.create', { title: 'dir2a' }) as any;
    await localA.call('chat.prompt', { sessionId: s.id, text: '基线', providerId: '__fake__' });
    await waitFor('基线收敛到 B', async () => (await msgCount(localB, s.id)) > 0, 5000);
    const baselineB = await msgCount(localB, s.id);

    await localA.call('control.pause') as any;

    // A 暂停期间写本地改动（dirty 被暂停阀丢弃，B 收不到）
    await localA.call('chat.prompt', { sessionId: s.id, text: '暂停期改动', providerId: '__fake__' });
    await sleep(400);
    expect(await msgCount(localB, s.id)).toBe(baselineB); // 暂停期 B 未收到（无方案 A 时恢复也收不到）

    // A 恢复：方案 A 对全部 synced session 重 onDirty + flush → 广播 sync.dirty → B pull
    const resumeRes = await localA.call('control.resume') as any;
    expect(resumeRes.syncPaused).toBe(false);
    await waitFor('B 收到 A 暂停期改动', async () => (await msgCount(localB, s.id)) > baselineB, 6000);
  }, 30000);

  it('2b：A 为拨号方（恢复后 flush pushToPeer 推给 B；先红后绿门控主测试）', async () => {
    const { localA, localB } = await setupTwoInstances('A');
    const s = await localA.call('chat.sessions.create', { title: 'dir2b' }) as any;
    await localA.call('chat.prompt', { sessionId: s.id, text: '基线', providerId: '__fake__' });
    await waitFor('基线收敛到 B', async () => (await msgCount(localB, s.id)) > 0, 5000);
    const baselineB = await msgCount(localB, s.id);

    await localA.call('control.pause') as any;

    await localA.call('chat.prompt', { sessionId: s.id, text: '暂停期改动', providerId: '__fake__' });
    await sleep(400);
    expect(await msgCount(localB, s.id)).toBe(baselineB); // 暂停期 B 未收到

    const resumeRes = await localA.call('control.resume') as any;
    expect(resumeRes.syncPaused).toBe(false);
    await waitFor('B 收到 A 暂停期改动', async () => (await msgCount(localB, s.id)) > baselineB, 6000);
  }, 30000);
});