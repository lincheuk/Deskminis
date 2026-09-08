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

describe('T6b · 绑定了自定义工作区之后，文件面板要看的是那个目录', () => {
  /** 这条从 MU5 加工作区覆盖起就一直是坏的，只是没人测过：
   *  `resolveInWorkspace` 里 `abs` 走 `resolveGuestPath`（**认覆盖值**），
   *  而围栏 `base` 写死成 `sessionBucket(sessionId,'workspace')`（**沙箱桶**）。
   *  两边基准不一致 → 绑定自定义目录后 `isInside` 恒假 →
   *  文件面板整个报「只允许访问会话工作区」，一个文件都列不出来。
   *
   *  `paths.workspaceOf()` 的注释早就写着「shell 的 cwd、终端启动目录、相对路径解析
   *  三处必须都走这里」——FilesService 是**第四个消费点**，当年漏了。 */
  it('list 列出的是绑定目录的内容，不是沙箱桶的', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken);
    await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;

    // 沙箱桶里放一个文件，绑定目录里放另一个——用文件名区分列的到底是哪个目录
    const bucket = join(dataDir, 'sessions', s.id, 'workspace');
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, 'ONLY-IN-SANDBOX.txt'), 'x', 'utf8');

    const proj = mkdtempSync(join(tmpdir(), 'dm-proj-'));
    writeFileSync(join(proj, 'ONLY-IN-PROJECT.txt'), 'y', 'utf8');

    const set = await c.call('workspace.set', { sessionId: s.id, root: proj });
    expect(set.error, JSON.stringify(set.error)).toBeUndefined();

    const listed = await c.call('files.list', { sessionId: s.id });
    expect(listed.error, `files.list 报错了：${JSON.stringify(listed.error)}`).toBeUndefined();
    const names = (listed.result as { name: string }[]).map(n => n.name);
    expect(names).toContain('ONLY-IN-PROJECT.txt');
    expect(names).not.toContain('ONLY-IN-SANDBOX.txt');
    c.close();
  });

  it('围栏仍然收死在绑定目录内——穿越到父目录要被拒', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken);
    await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const proj = mkdtempSync(join(tmpdir(), 'dm-proj2-'));
    mkdirSync(join(proj, 'inner'), { recursive: true });
    await c.call('workspace.set', { sessionId: s.id, root: join(proj, 'inner') });

    const up = await c.call('files.list', { sessionId: s.id, dir: '..' });
    expect(up.error, '穿越到父目录竟然放行了').toBeDefined();
    c.close();
  });

  it('恢复默认之后，列的又是沙箱桶', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken);
    await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const bucket = join(dataDir, 'sessions', s.id, 'workspace');
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, 'ONLY-IN-SANDBOX.txt'), 'x', 'utf8');
    const proj = mkdtempSync(join(tmpdir(), 'dm-proj3-'));
    writeFileSync(join(proj, 'ONLY-IN-PROJECT.txt'), 'y', 'utf8');

    await c.call('workspace.set', { sessionId: s.id, root: proj });
    await c.call('workspace.reset', { sessionId: s.id });
    const listed = await c.call('files.list', { sessionId: s.id });
    expect(listed.error).toBeUndefined();
    expect((listed.result as { name: string }[]).map(n => n.name)).toContain('ONLY-IN-SANDBOX.txt');
    c.close();
  });
});
