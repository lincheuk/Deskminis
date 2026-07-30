import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd, SYSTEM_PROMPT } from '../src/minisd/index';
import { bridgePipePath } from '../src/minisd/bridge/server';
import { pipeRequest } from './bridge-util';

beforeAll(() => {
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
});

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-minisd-br-'));
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return { ...srv, dataDir };
}

function rpcClient(port: number, authToken: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${authToken}`);
  let idc = 0;
  const pending = new Map<number, (v: never) => void>();
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg as never); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<{ result?: never; error?: { message: string } }> {
    const id = ++idc;
    return new Promise(res => { pending.set(id, res as never); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

describe('minisd 桥装配', () => {
  it('返回值带 bridgePipe 且与数据根派生一致；真管道可调 windows-device info（bypass 不问权限）', async () => {
    const { bridgePipe, dataDir } = await boot();
    expect(bridgePipe).toBe(bridgePipePath(dataDir));
    const env = await pipeRequest(bridgePipe!, {
      tool: 'windows-device', action: 'info', args: {},
      sessionId: 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789',
    });
    expect(env.ok).toBe(true);
    expect((env.data as Record<string, unknown>).computerName).toBe(process.env.COMPUTERNAME);
  }, 30000);

  it('权限定域端到端：管道调 clipboard get → RPC 收到 permission.request(kind=bridge-clipboard-read) → allow-session → 第二次不再问', async () => {
    const { port, authToken, bridgePipe } = await boot();
    const c = rpcClient(port, authToken);
    await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result as unknown as { id: string };

    // 偏差点：计划原文为 `const first = await pipeRequest(...)`，会使 pipeRequest 阻塞至权限应答前形成死锁。
    // 改为不 await：first 是 Promise，权限应答后才 await 取结果（与下文 `const firstResult = await first` 语义对齐）。
    const first = pipeRequest(bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: s.id });
    // 第一次调用触发询问：先等广播到达再应答
    for (let i = 0; i < 50 && !c.notifications.some(n => n.method === 'permission.request'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const permReq = c.notifications.find(n => n.method === 'permission.request');
    expect(permReq).toBeTruthy();
    const reqBody = permReq!.params.req as { kind: string; detail: string; sessionId: string; toolTitle: string };
    expect(reqBody.kind).toBe('bridge-clipboard-read');
    expect(reqBody.detail).toBe('windows-clipboard get');
    expect(reqBody.sessionId).toBe(s.id);
    await c.call('permission.respond', { requestId: permReq!.params.requestId, decision: 'allow-session' });
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    expect(typeof (firstResult.data as { text: string }).text).toBe('string');

    const nBefore = c.notifications.filter(n => n.method === 'permission.request').length;
    const second = await pipeRequest(bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: s.id });
    expect(second.ok).toBe(true);
    expect(c.notifications.filter(n => n.method === 'permission.request').length).toBe(nBefore); // 会话记忆生效
    c.close();
  }, 30000);

  it('同数据根管道被占：minisd 正常启动，bridgePipe 为 undefined（降级不拖垮）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-minisd-occ-'));
    const blocker = net.createServer();
    await new Promise<void>(res => blocker.listen(bridgePipePath(dataDir), res));
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    stop = srv.close;
    expect(srv.bridgePipe).toBeUndefined();
    expect(srv.port).toBeGreaterThan(0);
    await new Promise<void>(res => blocker.close(() => res()));
  });

  it('SYSTEM_PROMPT 含桥渐进披露段落（声明存在+调用法+--help，不含参数级文档）', () => {
    expect(SYSTEM_PROMPT).toContain('windows-notify');
    expect(SYSTEM_PROMPT).toContain('windows-clipboard');
    expect(SYSTEM_PROMPT).toContain('windows-open');
    expect(SYSTEM_PROMPT).toContain('windows-speak');
    expect(SYSTEM_PROMPT).toContain('windows-screenshot');
    expect(SYSTEM_PROMPT).toContain('windows-device');
    expect(SYSTEM_PROMPT).toContain('MINIS_BRIDGE_CLI');
    expect(SYSTEM_PROMPT).toContain('--help');
  });
});
