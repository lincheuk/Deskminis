import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

function rpcClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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
  /** 粗暴地打断连接：先写一帧非法数据（触发 ws 的 receiver 错误），再直接销毁底层 socket */
  function breakSocket(): void {
    const sock = (ws as any)._socket as import('node:net').Socket;
    try { sock.write(Buffer.from([0xf1, 0x00])); } catch { /* 已断开 */ } // RSV 位非法的帧
    sock.destroy();
  }
  return { ready, call, notifications, ws, breakSocket, close: () => ws.close() };
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-rpc-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return srv;
}

describe('minisd JSON-RPC', () => {
  it('创建会话 + 列出 + 追加用户消息路径存在', async () => {
    const { port } = await boot();
    const c = rpcClient(port); await c.ready;
    const s = (await c.call('chat.sessions.create', { title: 'T' })).result;
    expect(s.title).toBe('T');
    const list = (await c.call('chat.sessions.list')).result;
    expect(list).toHaveLength(1);
    c.close();
  });
  it('未知方法返回 JSON-RPC error', async () => {
    const { port } = await boot();
    const c = rpcClient(port); await c.ready;
    const resp = await c.call('does.not.exist', {});
    expect(resp.error).toBeTruthy();
    expect(resp.error.code).toBe(-32601);
    c.close();
  });
  it('删除会话缺 confirm 报错', async () => {
    const { port } = await boot();
    const c = rpcClient(port); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const resp = await c.call('chat.sessions.delete', { sessionId: s.id });
    expect(resp.error).toBeTruthy();
    c.close();
  });
  it('chat.prompt 用假 provider 跑通并广播 chat.event', async () => {
    const { port } = await boot();
    const c = rpcClient(port); await c.ready;
    // 注册一个 openai-compat provider 指向本地假服务器
    // 这里用环境注入的 mock：startMinisd 在 DESKMINIS_FAKE_PROVIDER=1 时挂一个脚本化 provider
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, text: '你好', providerId: '__fake__' });
    await new Promise(r => setTimeout(r, 300));
    const events = c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === s.id);
    expect(events.some(e => e.params.event.kind === 'turnEnd')).toBe(true);
    c.close();
  });
  it('未配置 provider 时 chat.prompt 报错且不落库孤儿用户消息', async () => {
    const { port } = await boot(); // 全新数据目录：providers.json 不存在 ⇒ 无默认 provider
    const c = rpcClient(port); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const resp = await c.call('chat.prompt', { sessionId: s.id, text: '你好' }); // 不带 providerId ⇒ 走缺省默认值路径
    expect(resp.error).toBeTruthy();
    const msgs = (await c.call('chat.messages.list', { sessionId: s.id })).result;
    expect(msgs).toEqual([]);
    c.close();
  });
  it('一条连接被粗暴打断不会杀死守护进程', async () => {
    const { port } = await boot();
    const a = rpcClient(port); await a.ready;
    const b = rpcClient(port); await b.ready;
    expect((await b.call('chat.sessions.create', { title: 'B' })).result.title).toBe('B');
    // 缺少 per-connection 'error' 监听时，ws 会把协议错误抛成未捕获异常（真实进程里等于守护进程被杀）
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    let list: unknown[];
    try {
      a.breakSocket();
      await new Promise(r => setTimeout(r, 150));
      list = (await b.call('chat.sessions.list')).result; // 服务端仍存活
    } finally { process.off('uncaughtException', onUncaught); }
    expect(uncaught).toEqual([]);
    expect(list).toHaveLength(1);
    b.close();
  });
});
