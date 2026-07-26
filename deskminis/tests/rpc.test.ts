import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
  /** 粗暴地打断连接：先写一帧非法数据（触发 ws 的 receiver 错误），再直接销毁底层 socket */
  function breakSocket(): void {
    const sock = (ws as any)._socket as import('node:net').Socket;
    try { sock.write(Buffer.from([0xf1, 0x00])); } catch { /* 已断开 */ } // RSV 位非法的帧
    sock.destroy();
  }
  return { ready, call, notifications, ws, breakSocket, close: () => ws.close() };
}

async function boot(opts?: { permTimeoutMs?: number }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-rpc-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, ...opts });
  stop = srv.close;
  return { ...srv, dataDir };
}

/** 轮询等待条件成立，超时即失败（比固定 sleep 稳）。 */
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

/** 连一次，只回答"握手成功了吗"。用于认证用例：拒绝时 ws 发 'error'/'unexpected-response'。 */
function handshake(url: string, opts?: { origin?: string }): Promise<'open' | 'rejected'> {
  const ws = new WebSocket(url, opts);
  return new Promise<'open' | 'rejected'>(res => {
    ws.on('open', () => res('open'));
    ws.on('error', () => res('rejected'));
    ws.on('unexpected-response', () => res('rejected'));
  }).finally(() => ws.terminate());
}

describe('minisd JSON-RPC', () => {
  it('创建会话 + 列出 + 追加用户消息路径存在', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', { title: 'T' })).result;
    expect(s.title).toBe('T');
    const list = (await c.call('chat.sessions.list')).result;
    expect(list).toHaveLength(1);
    c.close();
  });
  it('未知方法返回 JSON-RPC error', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const resp = await c.call('does.not.exist', {});
    expect(resp.error).toBeTruthy();
    expect(resp.error.code).toBe(-32601);
    c.close();
  });
  it('删除会话缺 confirm 报错', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const resp = await c.call('chat.sessions.delete', { sessionId: s.id });
    expect(resp.error).toBeTruthy();
    c.close();
  });
  it('chat.prompt 用假 provider 跑通并广播 chat.event', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
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
    const { port, authToken } = await boot(); // 全新数据目录：providers.json 不存在 ⇒ 无默认 provider
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const resp = await c.call('chat.prompt', { sessionId: s.id, text: '你好' }); // 不带 providerId ⇒ 走缺省默认值路径
    expect(resp.error).toBeTruthy();
    const msgs = (await c.call('chat.messages.list', { sessionId: s.id })).result;
    expect(msgs).toEqual([]);
    c.close();
  });
  it('一条连接被粗暴打断不会杀死守护进程', async () => {
    const { port, authToken } = await boot();
    const a = rpcClient(port, authToken); await a.ready;
    const b = rpcClient(port, authToken); await b.ready;
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

  // ---- 认证：没有这道门，用户随便访问的一个网页就能连上本地端口驱动 agent，
  //      并且收到广播的 permission.request 后自己回 allow-session（自我批准执行命令）----
  it('不带 token 的连接被拒绝（任意网页场景）', async () => {
    const { port } = await boot();
    expect(await handshake(`ws://127.0.0.1:${port}`)).toBe('rejected');
    expect(await handshake(`ws://127.0.0.1:${port}/?token=`)).toBe('rejected');
  });
  it('token 错误的连接被拒绝', async () => {
    const { port, authToken } = await boot();
    expect(await handshake(`ws://127.0.0.1:${port}/?token=${authToken.toLowerCase()}`)).toBe('rejected');
    expect(await handshake(`ws://127.0.0.1:${port}/?token=NOT-THE-TOKEN`)).toBe('rejected');
  });
  it('第二道防线：带网页 Origin 的连接即使 token 正确也被拒', async () => {
    const { port, authToken } = await boot();
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(authToken)}`;
    expect(await handshake(url, { origin: 'https://evil.example' })).toBe('rejected');
    expect(await handshake(url, { origin: 'http://evil.example' })).toBe('rejected');
    expect(await handshake(url, { origin: 'file://' })).toBe('open'); // 打包后渲染进程走 file://
    expect(await handshake(url, { origin: 'http://localhost:5173' })).toBe('open'); // dev server
  });

  it('非法 sessionId 被拒且不在数据根外建目录', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const evil = `..\\..\\dm-pwned-${Date.now()}`;
    const resp = await c.call('chat.prompt', { sessionId: evil, text: '你好', providerId: '__fake__' });
    expect(resp.error).toBeTruthy();
    expect(resp.error.message).toContain('sessionId');
    expect(existsSync(join(dataDir, 'sessions', evil))).toBe(false);
    expect((await c.call('chat.messages.list', { sessionId: evil })).error).toBeTruthy();
    expect((await c.call('chat.sessions.delete', { sessionId: evil, confirm: true })).error).toBeTruthy();
    c.close();
  });
  it('空/纯空白 text 被拒（否则该会话被永久写坏）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '', providerId: '__fake__' })).error).toBeTruthy();
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '   \n\t ', providerId: '__fake__' })).error).toBeTruthy();
    expect((await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__' })).error).toBeTruthy();
    expect((await c.call('chat.messages.list', { sessionId: s.id })).result).toEqual([]); // 没有落库
    c.close();
  });
  it('同一会话并发 chat.prompt：第二次被拒（避免两个 agent 循环交错写历史）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const first = await c.call('chat.prompt', { sessionId: s.id, text: '第一条', providerId: '__fake__' });
    expect(first.result).toEqual({ ok: true });
    const second = await c.call('chat.prompt', { sessionId: s.id, text: '第二条', providerId: '__fake__' });
    expect(second.error).toBeTruthy();
    expect(second.error.message).toContain('运行中');
    await new Promise(r => setTimeout(r, 300)); // 等第一轮跑完，锁释放
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '第三条', providerId: '__fake__' })).result).toEqual({ ok: true });
    await new Promise(r => setTimeout(r, 300));
    c.close();
  });
  // ---- 权限卡片的生命周期：超时/响应都必须通知 UI，否则卡片永远悬在界面上 ----
  it('权限询问超时会广播 permission.resolved（卡片不再永久悬挂）', async () => {
    const { port, authToken } = await boot({ permTimeoutMs: 150 });
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-')), 'x.txt');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'x', tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;
    await waitFor('permission.resolved', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId));
    expect(existsSync(outside)).toBe(false); // 超时 = deny，文件不该被写出
    c.close();
  });
  it('permission.respond 也会广播 permission.resolved（多窗口同步）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-')), 'y.txt');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'ok', tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;
    await c.call('permission.respond', { requestId, decision: 'allow-once' });
    await waitFor('permission.resolved', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId));
    await waitFor('工具执行完成', () => existsSync(outside));
    expect(readFileSync(outside, 'utf8')).toBe('ok');
    await new Promise(r => setTimeout(r, 200)); // 让后续回合收尾，避免关库时循环还在跑
    c.close();
  });

  it('chat.cancel 校验 sessionId；对空闲会话也安全返回', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('chat.cancel', { sessionId: s.id })).result).toEqual({ ok: true });
    expect((await c.call('chat.cancel', { sessionId: '../../x' })).error).toBeTruthy();
    c.close();
  });
});
