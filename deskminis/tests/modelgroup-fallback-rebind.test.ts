/**
 * Z1 · 模型组降级成功后的会话改绑（设计稿 docs/specs/2026-09-24-model-group-ui-design.md §0 ②③）。
 *
 * 用**真 provider** + 测试内起的本地假 OpenAI 端点：主力 /fail 回 429、备用 /ok 流式回一段文本。
 * 不用 FakeProvider——它的 `__fail__` 会让组里每个成员一起失败，走不到「主力失败、备用接手」这条路；
 * 现有 rpc.test.ts 的「fallback 改写会话绑定时机」只测得了全失败那一半，成功改绑这一半此前**没有任何测试**。
 *
 * ① 改绑本身（M2b 设计 §4.2，修前就绿——特征测试，钉住行为不回归）；
 * ② 改绑后必须广播 chat.sessions.changed：否则前端 sessions[].modelBinding 停在 group:，
 *    会话菜单与模型胶囊都在显示一个已经不生效的绑定（立项探针 probe-z0 实测 stale: true）。
 *    平时被首回合自动命名的广播掩盖——所以这里先改名，让自动命名不触发；
 * ③ fallback 事件的 from 是主力的「名称(模型 id)」，不是 loop 给首个 slot 写死的内部标签 main
 *    （任务面板卡原样显示过「main → 备用(mock-backup)」）。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';

let mock: Server;
let mockPort = 0;
const hits: string[] = [];

beforeAll(async () => {
  mock = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(String(req.url));
      if (req.url?.startsWith('/fail/')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited (mock)' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '备用接手' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
  mockPort = (mock.address() as { port: number }).port;
});
afterAll(() => new Promise<void>(r => mock.close(() => r())));

let stop: (() => Promise<void>) | undefined;
const savedFake = process.env.DESKMINIS_FAKE_PROVIDER;
afterEach(async () => {
  await stop?.(); stop = undefined;
  if (savedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER; else process.env.DESKMINIS_FAKE_PROVIDER = savedFake;
});

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-z1-'));
  process.env.DESKMINIS_TEST = '1';                // InMemoryVault：不碰真凭据库
  delete process.env.DESKMINIS_FAKE_PROVIDER;      // 组成员必须是真 provider，否则全是 FakeProvider
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return srv;
}

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
  const call = (method: string, params?: unknown): Promise<any> => {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  };
  return { ready, call, notifications, close: () => ws.close() };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 建「主力(会 429) → 备用(正常)」两个免密钥 provider 与一个组，返回 id。 */
async function seed(c: ReturnType<typeof rpcClient>) {
  const a = (await c.call('provider.instances.create', { name: '主力', kind: 'ollama', baseUrl: `http://127.0.0.1:${mockPort}/fail/v1`, modelId: 'mock-primary' })).result;
  const b = (await c.call('provider.instances.create', { name: '备用', kind: 'ollama', baseUrl: `http://127.0.0.1:${mockPort}/ok/v1`, modelId: 'mock-backup' })).result;
  const g = (await c.call('modelgroup.create', { name: '主备', memberIds: [a.id, b.id] })).result;
  const s = (await c.call('chat.sessions.create', {})).result;
  // 先改名：自动命名只在标题仍是默认值时动手，它的广播会顺手刷新前端列表、把②掩盖掉
  await c.call('chat.sessions.rename', { sessionId: s.id, title: '改过名的会话' });
  return { a, b, g, s };
}

const eventsSince = (c: ReturnType<typeof rpcClient>, mark: number) =>
  c.notifications.slice(mark).filter(n => n.method === 'chat.event').map(n => n.params?.event);

describe('Z1 — 模型组降级成功后的改绑', () => {
  it('会话绑组：主力 429 → 备用接手 → 改绑 provider:备用，并广播 chat.sessions.changed；事件起点是主力的真名', async () => {
    hits.length = 0;
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { b, g, s } = await seed(c);
    await c.call('chat.sessions.setModelBinding', { sessionId: s.id, binding: `group:${g.id}` });

    const mark = c.notifications.length;
    const r = await c.call('chat.prompt', { sessionId: s.id, text: '你好' });
    expect(r.error).toBeUndefined();
    await waitFor('回合结束', () => eventsSince(c, mark).some(e => e?.kind === 'turnEnd' || e?.kind === 'error'), 15000);

    const evs = eventsSince(c, mark);
    expect(evs.find(e => e?.kind === 'error'), '不该以错误收场').toBeUndefined();
    const fb = evs.find(e => e?.kind === 'fallback');
    expect(fb, '主力 429 应当触发降级').toBeTruthy();
    // ③ 起点是主力的「名称(模型 id)」，与链上其余成员同一格式；不是内部标签 main
    expect(fb.from).toBe('主力(mock-primary)');
    expect(fb.to).toBe('备用(mock-backup)');
    // 主力确实被请求过一次、备用接了手（429 是 fallbackable：不重试、立刻换）
    expect(hits).toEqual(['/fail/v1/chat/completions', '/ok/v1/chat/completions']);

    // ① 特征：改绑落库
    const list = (await c.call('chat.sessions.list')).result;
    expect(list.find((x: { id: string }) => x.id === s.id)?.modelBinding).toBe(`provider:${b.id}`);

    // ② 改绑之后必须有一条 chat.sessions.changed（前端靠它重拉列表）
    const iFb = c.notifications.findIndex((n, i) => i >= mark && n.method === 'chat.event' && n.params?.event?.kind === 'fallback');
    await waitFor('改绑后的 chat.sessions.changed 广播', () => c.notifications.slice(iFb).some(n => n.method === 'chat.sessions.changed'), 3000);
    c.close();
  });

  it('显式 modelGroupId 调用同样给主力真名（两条组路径都要传）', async () => {
    hits.length = 0;
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { g, s } = await seed(c);

    const mark = c.notifications.length;
    await c.call('chat.prompt', { sessionId: s.id, text: '你好', modelGroupId: g.id });
    await waitFor('回合结束', () => eventsSince(c, mark).some(e => e?.kind === 'turnEnd' || e?.kind === 'error'), 15000);
    const fb = eventsSince(c, mark).find(e => e?.kind === 'fallback');
    expect(fb?.from).toBe('主力(mock-primary)');
    c.close();
  });
});
