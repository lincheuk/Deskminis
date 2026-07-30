import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-files-'));
  process.env.DESKMINIS_TEST = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return { ...srv, dataDir };
}

/** 建会话并往其工作区播种文件。 */
async function seed(c: ReturnType<typeof rpcClient>, dataDir: string) {
  const s = (await c.call('chat.sessions.create', {})).result;
  const ws = join(dataDir, 'sessions', s.id, 'workspace');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  writeFileSync(join(ws, 'sub', 'b.txt'), 'inside-sub', 'utf8');
  writeFileSync(join(ws, 'a.txt'), '你好文件', 'utf8');
  writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  writeFileSync(join(ws, 'big.txt'), 'x'.repeat(300 * 1024), 'utf8');
  return { sessionId: s.id as string, ws };
}

describe('files.* RPC（工作区文件树）', () => {
  it('空工作区列根返回空数组', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('files.list', { sessionId: s.id })).result).toEqual([]);
    c.close();
  });

  it('列根：目录在前、按名排序，字段完整（name/path/kind/size/mtime）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.list', { sessionId })).result;
    expect(r.map((n: any) => n.path)).toEqual(['sub', 'a.txt', 'big.txt', 'bin.dat']);
    expect(r[0]).toMatchObject({ name: 'sub', path: 'sub', kind: 'dir', size: 0 });
    expect(r[1]).toMatchObject({ name: 'a.txt', path: 'a.txt', kind: 'file', size: Buffer.byteLength('你好文件') });
    expect(typeof r[1].mtime).toBe('number');
    expect(r[1].mtime).toBeGreaterThan(0);
    c.close();
  });

  it('列子目录：path 为工作区相对 POSIX 形式', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.list', { sessionId, dir: 'sub' })).result;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'b.txt', path: 'sub/b.txt', kind: 'file', size: Buffer.byteLength('inside-sub') });
    c.close();
  });

  it('files.read 读文本全文', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.read', { sessionId, path: 'a.txt' })).result;
    expect(r).toMatchObject({ path: 'a.txt', content: '你好文件', truncated: false, binary: false, size: Buffer.byteLength('你好文件') });
    c.close();
  });

  it('files.read 目标为目录时报错', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    expect((await c.call('files.read', { sessionId, path: 'sub' })).error).toBeTruthy();
    c.close();
  });

  it('二进制文件标记 binary、不返回内容', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.read', { sessionId, path: 'bin.dat' })).result;
    expect(r).toMatchObject({ path: 'bin.dat', binary: true, content: '', size: 3 });
    c.close();
  });

  it('超过 256KB 截断并置 truncated（不整文件读入内存）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.read', { sessionId, path: 'big.txt' })).result;
    expect(r.truncated).toBe(true);
    expect(r.binary).toBe(false);
    expect(r.size).toBe(300 * 1024);
    expect(r.content.length).toBe(256 * 1024);
    c.close();
  });

  it('不存在的路径报错', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    expect((await c.call('files.read', { sessionId, path: 'nope.txt' })).error).toBeTruthy();
    expect((await c.call('files.list', { sessionId, dir: 'nope-dir' })).error).toBeTruthy();
    c.close();
  });

  it('拒绝工作区外的绝对宿主路径（面板不是绕过权限网关的任意文件读取通道）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = await c.call('files.read', { sessionId, path: 'C:\\Windows' });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toContain('工作区');
    expect((await c.call('files.list', { sessionId, dir: 'C:\\Windows' })).error).toBeTruthy();
    c.close();
  });

  it('拒绝穿越与越界 guest 路径', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    expect((await c.call('files.list', { sessionId, dir: '..\\..\\..' })).error).toBeTruthy();
    expect((await c.call('files.list', { sessionId, dir: '/var/minis/memory' })).error).toBeTruthy();
    expect((await c.call('files.read', { sessionId, path: '/var/minis/workspace/../../minis.db' })).error).toBeTruthy();
    c.close();
  });

  it('非法 sessionId 被拒', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    expect((await c.call('files.list', { sessionId: '..\\..\\x' })).error).toBeTruthy();
    expect((await c.call('files.read', { sessionId: 'not-a-uuid', path: 'a.txt' })).error).toBeTruthy();
    c.close();
  });
});
