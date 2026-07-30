import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

const SKILL_MD = '---\nname: demo-skill\ndescription: 演示技能\nversion: 1.0.0\n---\n# Demo\n正文。\n';

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

async function boot(pre?: (dataDir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-skills-rpc-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  pre?.(dataDir);
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return { ...srv, dataDir };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 经 folder 导入造一个技能，返回其 id。 */
async function importDemo(c: ReturnType<typeof rpcClient>, dataDir: string): Promise<string> {
  const src = join(dataDir, '外部');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'SKILL.md'), SKILL_MD);
  const { taskId } = (await c.call('skills.import', { kind: 'folder', source: src })).result;
  const deadline = Date.now() + 5000;
  for (;;) {
    const t = (await c.call('skills.importStatus', { taskId })).result;
    if (t && t.state !== 'running') return t.succeeded[0] as string;
    if (Date.now() > deadline) throw new Error('等待导入任务超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('skills RPC', () => {
  it('启动时孤儿回收：skillsRoot 下不在表里的目录入库', async () => {
    const { port, authToken } = await boot((dataDir) => {
      mkdirSync(join(dataDir, 'skills', 'orphan-one'), { recursive: true });
      writeFileSync(join(dataDir, 'skills', 'orphan-one', 'SKILL.md'), SKILL_MD);
    });
    const c = rpcClient(port, authToken); await c.ready;
    const list = (await c.call('skills.list', {})).result;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('orphan-one');
    expect(list[0].name).toBe('demo-skill');
    expect(list[0].importSource).toBe('orphan');
    c.close();
  });
  it('skills.import folder → importStatus 轮询 → skills.list 可见', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const id = await importDemo(c, dataDir);
    expect(id).toBe('demo-skill');
    const list = (await c.call('skills.list', {})).result;
    expect(list.map((s: any) => s.id)).toEqual(['demo-skill']);
    expect(existsSync(join(dataDir, 'skills', 'demo-skill', 'SKILL.md'))).toBe(true);
    c.close();
  });
  it('skills.import 非法 kind / 空 source 报错；importStatus 未知 taskId 返回 null', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    expect((await c.call('skills.import', { kind: 'ftp', source: 'x' })).error).toBeTruthy();
    expect((await c.call('skills.import', { kind: 'folder', source: '  ' })).error).toBeTruthy();
    expect((await c.call('skills.importStatus', { taskId: '不存在' })).result).toBeNull();
    c.close();
  });
  it('skills.setEnabled 全局与会话覆盖；skills.list(sessionId) 只返回生效启用集', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const id = await importDemo(c, dataDir);
    const s = (await c.call('chat.sessions.create', {})).result;
    // 全局禁用 → 会话生效集为空
    await c.call('skills.setEnabled', { id, enabled: false });
    expect((await c.call('skills.list', { sessionId: s.id })).result).toEqual([]);
    expect((await c.call('skills.list', {})).result[0].isEnabled).toBe(false);
    // 会话覆盖启用 → 该会话又可见
    await c.call('skills.setEnabled', { id, enabled: true, sessionId: s.id });
    expect((await c.call('skills.list', { sessionId: s.id })).result).toHaveLength(1);
    c.close();
  });
  it('skills.delete 需 confirm:true；确认后目录与表行同删', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const id = await importDemo(c, dataDir);
    expect((await c.call('skills.delete', { id })).error).toBeTruthy();
    expect((await c.call('skills.delete', { id, confirm: true })).result).toEqual({ ok: true });
    expect((await c.call('skills.list', {})).result).toEqual([]);
    expect(existsSync(join(dataDir, 'skills', id))).toBe(false);
    c.close();
  });
  it('use_count 端到端：模型 file_read 技能 SKILL.md → 计数 +1', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const id = await importDemo(c, dataDir);
    const s = (await c.call('chat.sessions.create', {})).result;
    const script = `__tool__ file_read ${JSON.stringify({ path: `/var/minis/skills/${id}/SKILL.md`, tool_title: '读技能' })}`;
    await c.call('chat.prompt', { sessionId: s.id, text: script, providerId: '__fake__' });
    {
      const deadline = Date.now() + 5000;
      for (;;) {
        const list = (await c.call('skills.list', {})).result;
        if (list[0].useCount === 1) break;
        if (Date.now() > deadline) throw new Error('等待 use_count 计数超时');
        await new Promise(r => setTimeout(r, 20));
      }
    }
    // 读技能目录里的其他文件不计数
    await c.call('chat.prompt', { sessionId: s.id, text: `__tool__ file_read ${JSON.stringify({ path: '/var/minis/workspace/nope.txt', tool_title: '读别的' })}`, providerId: '__fake__' });
    await new Promise(r => setTimeout(r, 300));
    expect((await c.call('skills.list', {})).result[0].useCount).toBe(1);
    c.close();
  });
  it('技能变更广播 skills.changed；导入进度广播 skills.import.progress', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    await importDemo(c, dataDir);
    await waitFor('收到 skills.import.progress', () => c.notifications.some(n => n.method === 'skills.import.progress'));
    const id = 'demo-skill';
    await c.call('skills.setEnabled', { id, enabled: false });
    await waitFor('收到 skills.changed', () => c.notifications.some(n => n.method === 'skills.changed'));
    c.close();
  });
});
