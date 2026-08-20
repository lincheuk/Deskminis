import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** H1 文本选区注释——RPC 面四件 + changed 广播（设计稿 §1-4）。
 *  权限：本地会话数据操作免批（与 sessions.rename 同级），但入参必须校验——
 *  会话不存在即拒（防孤儿注释）。 */

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

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-anno-'));
  process.env.DESKMINIS_TEST = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  const c = rpcClient(srv.port, srv.authToken);
  await c.ready;
  return c;
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('chat.annotations.*', () => {
  it('add → list 全链路 + changed 广播（带 sessionId）', async () => {
    const c = await boot();
    const s = (await c.call('chat.sessions.create', { title: '注释会话' })).result;
    const added = await c.call('chat.annotations.add', {
      sessionId: s.id, messageId: 'M1', exact: '要点句', prefix: '……前', suffix: '后……', note: '存疑',
    });
    expect(added.error).toBeUndefined();
    expect(added.result.id).toBeTruthy();
    const list = await c.call('chat.annotations.list', { sessionId: s.id });
    expect(list.result.annotations).toHaveLength(1);
    expect(list.result.annotations[0]).toMatchObject({ messageId: 'M1', exact: '要点句', note: '存疑' });
    await waitFor('changed 广播', () =>
      c.notifications.some(n => n.method === 'chat.annotations.changed' && n.params?.sessionId === s.id));
    c.close();
  });

  it('update 改 note、remove 删除，各自触发 changed 广播', async () => {
    const c = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    const a = (await c.call('chat.annotations.add', { sessionId: s.id, messageId: 'M1', exact: 'X' })).result;
    c.notifications.length = 0;
    const up = await c.call('chat.annotations.update', { id: a.id, note: '改后' });
    expect(up.error).toBeUndefined();
    await waitFor('update 广播', () =>
      c.notifications.some(n => n.method === 'chat.annotations.changed' && n.params?.sessionId === s.id));
    expect((await c.call('chat.annotations.list', { sessionId: s.id })).result.annotations[0].note).toBe('改后');

    c.notifications.length = 0;
    const rm = await c.call('chat.annotations.remove', { id: a.id });
    expect(rm.error).toBeUndefined();
    await waitFor('remove 广播', () =>
      c.notifications.some(n => n.method === 'chat.annotations.changed' && n.params?.sessionId === s.id));
    expect((await c.call('chat.annotations.list', { sessionId: s.id })).result.annotations).toHaveLength(0);
    c.close();
  });

  it('add 校验：exact 空拒、会话不存在拒（防孤儿注释）', async () => {
    const c = await boot();
    const s = (await c.call('chat.sessions.create', {})).result;
    // 断言到具体文案而非仅「有 error」——方法未实现时「未知方法」也是 error，那种绿是假绿
    const noExact = await c.call('chat.annotations.add', { sessionId: s.id, messageId: 'M1', exact: '' });
    expect(String(noExact.error?.message ?? '')).toContain('exact');
    // 格式合法但不存在的 id：assertSessionId 是格式闸，存在性检查在其后——'GHOST' 那种到不了这层
    const noSession = await c.call('chat.annotations.add', { sessionId: '00000000-0000-4000-8000-000000000000', messageId: 'M1', exact: 'X' });
    expect(String(noSession.error?.message ?? '')).toContain('会话不存在');
    c.close();
  });

  it('update/remove 未知 id 幂等返回 ok 且不广播', async () => {
    const c = await boot();
    await c.call('chat.sessions.create', {});
    c.notifications.length = 0;
    const up = await c.call('chat.annotations.update', { id: '不存在', note: 'x' });
    expect(up.error).toBeUndefined();
    expect(up.result.ok).toBe(true);
    const rm = await c.call('chat.annotations.remove', { id: '不存在' });
    expect(rm.error).toBeUndefined();
    expect(rm.result.ok).toBe(true);
    await new Promise(r => setTimeout(r, 100));
    expect(c.notifications.some(n => n.method === 'chat.annotations.changed')).toBe(false);
    c.close();
  });
});
