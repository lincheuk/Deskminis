import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  const notifications: { method: string; params: any }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

/** 在指定数据根启动 minisd（复用同一数据根即可模拟「重启」）。 */
async function start(dataDir: string) {
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  return srv;
}

/** 轮询等待条件成立，超时即失败。 */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 让假 provider 发起一次真实工具调用（走权限网关）。 */
function toolScript(name: string, input: Record<string, unknown>): string {
  return `__tool__ ${name} ${JSON.stringify(input)}`;
}

describe('permission 档位预设（permission.preset）RPC', () => {
  it('默认档为 ask；setPreset 后 getPreset 读回新值；非法取值被拒', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-preset-'));
    const srv = await start(dataDir);
    stop = srv.close;
    const c = rpcClient(srv.port, srv.authToken); await c.ready;

    // 默认 ask（settings 无记录）
    expect((await c.call('permission.getPreset')).result.preset).toBe('ask');

    // 合法档位写回
    for (const preset of ['session', 'full', 'ask']) {
      const r = await c.call('permission.setPreset', { preset });
      expect(r.error).toBeFalsy();
      expect(r.result).toEqual({ ok: true, preset });
      expect((await c.call('permission.getPreset')).result.preset).toBe(preset);
    }

    // 非法取值被拒，且档位未被改动
    const bad = await c.call('permission.setPreset', { preset: 'nope' });
    expect(bad.error).toBeTruthy();
    expect((await c.call('permission.getPreset')).result.preset).toBe('ask');
    c.close();
  });

  it('setPreset 持久化 → 重启同一数据根后 getPreset 读回 full 且网关行为生效', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-preset-'));
    let srv = await start(dataDir);
    stop = srv.close;
    const c = rpcClient(srv.port, srv.authToken); await c.ready;
    await c.call('permission.setPreset', { preset: 'full' });
    expect((await c.call('permission.getPreset')).result.preset).toBe('full');
    c.close();
    await srv.close(); stop = undefined;

    // 重启同一数据根：档位读回 + 网关行为生效
    srv = await start(dataDir);
    stop = srv.close;
    const c2 = rpcClient(srv.port, srv.authToken); await c2.ready;
    expect((await c2.call('permission.getPreset')).result.preset).toBe('full');

    // 网关行为生效：'full' 下 file-write 直接放行，不广播 permission.request，文件被写出
    const s = (await c2.call('chat.sessions.create', { title: 'P' })).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-preset-out-')), 'w.txt');
    await c2.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'ok', tool_title: '写' }) });
    await waitFor('文件写出（full 档直接放行）', () => existsSync(outside));
    expect(c2.notifications.some(n => n.method === 'permission.request')).toBe(false); // 全程未询问
    expect((await import('node:fs')).readFileSync(outside, 'utf8')).toBe('ok');
    await new Promise(r => setTimeout(r, 200)); // 等回合收尾，避免关库时循环还在跑
    c2.close();
  });
});