import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import { wireClient, waitFor, type WireClient } from './state-sync-fixture';
import { n21CatalogFixture, GO_MODEL } from './n21-catalog-fixture';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import * as catalogModule from '../src/minisd/providers/model-catalog';
import { ChatStore } from '../src/minisd/store/chat-store';

let engine: CapturedEngine | undefined, client: WireClient | undefined, server: Server | undefined;
afterEach(async () => { client?.terminate(); await engine?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); } vi.restoreAllMocks(); vi.unstubAllEnvs(); engine = undefined; client = undefined; server = undefined; });

describe('N23 真实引擎会话头', () => {
  it('同一会话两轮、真实自动压缩和标题稳定，另一会话不同，列表与普通服务商不声明', async () => {
    vi.stubEnv('DESKMINIS_APP_VERSION', '0.3.0');
    const hits: { kind: string; headers: Record<string, unknown>; raw: string }[] = [];
    server = createServer(async (req, res) => {
      let raw = ''; for await (const b of req) raw += b;
      if (req.method === 'GET') { hits.push({ kind: 'models', headers: req.headers, raw }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: GO_MODEL }] })); return; }
      const body = JSON.parse(raw);
      const system = JSON.stringify(body.messages?.filter((m: any) => m.role === 'system'));
      const kind = system.includes('标题生成器') ? 'title' : system.includes('对话摘要助手') ? 'summary' : 'main';
      hits.push({ kind, headers: req.headers, raw });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = kind === 'title' ? 'N23标题' : kind === 'summary' ? 'N23已经完成历史协作，继续当前任务。' : 'N23回复';
      res.end('data: '+JSON.stringify({ choices: [{ delta: { content: text } }] })+'\n\ndata: '+JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const baseUrl = 'http://127.0.0.1:'+(server.address() as { port: number }).port+'/v1';
    const root = mkdtempSync(join(tmpdir(), 'dm-n23-'));
    const cat = new ModelCatalog(join(root, 'models-dev-cache.json'), async () => new Response(JSON.stringify(n21CatalogFixture()), { headers: { 'content-type': 'application/json' } }));
    expect(await cat.refresh(true)).toBe(true);
    vi.spyOn(catalogModule, 'createProxyFetch').mockReturnValue(async () => { throw new Error('N23 no external catalog'); });
    const created = vi.spyOn(ChatStore.prototype, 'createSession');
    engine = await startCapturedEngine({ dataDir: root });
    client = wireClient(engine.handle.port, engine.handle.authToken); await client.ready;
    const call = (method: string, params: unknown = {}) => engine!.methods[method](params, probeConnection('local')) as Promise<any>;
    const p = await call('provider.instances.create', { name: 'N23 Go', kind: 'openai-compat', baseUrl, modelId: GO_MODEL, apiKey: 'synthetic', catalogProviderId: 'opencode-go', contextWindow: 200000, maxOutputTokens: 4096 });
    const runtime = await call('provider.runtime.resolve', { id: p.id });
    expect(runtime.runtime.endpoint.catalogProviderId).toBe('opencode-go');
    const s = await call('chat.sessions.create');
    const store = created.mock.contexts.at(-1) as ChatStore;
    const send = async (id: string, text: string, providerId = p.id) => {
      const start = client!.notifications.length;
      await call('chat.prompt', { sessionId: id, text, providerId });
      await waitFor('N23 turn terminal', () => client!.notifications.slice(start).some(n => n.method === 'chat.event' && n.params.sessionId === id && ['turnEnd','error'].includes(n.params.event?.kind)));
      expect(client!.notifications.slice(start).filter(n => n.method === 'chat.event' && n.params.sessionId === id && n.params.event?.kind === 'error')).toEqual([]);
    };
    await send(s.id, 'N23第一轮');
    await waitFor('N23首轮标题', async () => (await call('chat.sessions.list')).some((x: any) => x.id === s.id && x.title === 'N23标题'));
    await send(s.id, 'N23第二轮');
    expect(hits.filter(h => h.kind === 'main')).toHaveLength(2);
    // 在同一个真实ChatStore补入合成历史，让当前槽位的真实自动压缩路径发请求。
    await call('provider.instances.update', { id: p.id, contextWindow: 32000 });
    const now = Date.now()/1000;
    for (let i = 0; i < 12; i++) store.appendMessage({ id: store.newId(), sessionId: s.id, role: i % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', value: 'old'.repeat(2700) }], createdAt: now+i/1000, streamInterruptCount: 0 });
    await send(s.id, 'N23压缩后的第三轮');
    expect(hits.some(h => h.kind === 'summary')).toBe(true);
    expect(store.getLatestCompactMarker(s.id)).toBeDefined();
    expect(hits.filter(h => h.kind === 'main')).toHaveLength(3);
    for (const h of hits) { expect(h.headers['x-opencode-session']).toBe(s.id); expect(h.headers['user-agent']).toBe('DeskMinis/0.3.0'); }
    const other = await call('chat.sessions.create'); expect(other.id).not.toBe(s.id);
    const cut = hits.length; await send(other.id, 'N23另一会话');
    await waitFor('N23第二会话标题', () => hits.slice(cut).some(h => h.kind === 'title'));
    expect(hits.slice(cut).map(h => h.headers['x-opencode-session'])).toEqual([other.id, other.id]);
    await call('provider.models.fetch', { id: p.id });
    expect(hits.at(-1)?.kind).toBe('models'); expect(hits.at(-1)?.headers['x-opencode-session']).toBeUndefined(); expect(hits.at(-1)?.headers['user-agent']).not.toMatch(/^DeskMinis(?:\/|$)/);
    const ordinary = await call('provider.instances.create', { name: 'ordinary', kind: 'openai-compat', baseUrl, modelId: GO_MODEL, apiKey: 'synthetic', contextWindow: 200000, maxOutputTokens: 4096 });
    const plain = await call('chat.sessions.create'), plainCut = hits.length;
    await send(plain.id, 'N23普通服务商', ordinary.id);
    await waitFor('普通服务商标题', () => hits.slice(plainCut).some(h => h.kind === 'title'));
    for (const h of hits.slice(plainCut)) { expect(h.headers['x-opencode-session']).toBeUndefined(); expect(h.headers['user-agent']).not.toMatch(/^DeskMinis(?:\/|$)/); }
  });
});

describe('N23 降级后的槽位身份', () => {
  it.each([true, false])('主槽位Go=%s，备用对话和标题跟随备用身份', async primaryGo => {
    vi.stubEnv('DESKMINIS_APP_VERSION', '0.3.0');
    const hits: { primary: boolean; title: boolean; headers: Record<string, unknown> }[] = [];
    server = createServer(async (req, res) => {
      let raw = ''; for await (const b of req) raw += b;
      const body = JSON.parse(raw), primary = req.url!.startsWith('/primary/'), title = JSON.stringify(body.messages).includes('标题生成器');
      hits.push({ primary, title, headers: req.headers });
      if (primary) { res.writeHead(400); res.end('synthetic primary failure'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: '+JSON.stringify({ choices: [{ delta: { content: title ? 'N23备用标题' : 'N23备用正文' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:'+(server.address() as { port: number }).port;
    const root = mkdtempSync(join(tmpdir(), 'dm-n23-fallback-'));
    const cat = new ModelCatalog(join(root, 'models-dev-cache.json'), async () => new Response(JSON.stringify(n21CatalogFixture())));
    expect(await cat.refresh(true)).toBe(true);
    vi.spyOn(catalogModule, 'createProxyFetch').mockReturnValue(async () => { throw new Error('N23 no external catalog'); });
    engine = await startCapturedEngine({ dataDir: root });
    const call = (method: string, params: unknown = {}) => engine!.methods[method](params, probeConnection('local')) as Promise<any>;
    const make = (path: string, go: boolean) => call('provider.instances.create', { name: path, kind: 'openai-compat', baseUrl: base+'/'+path+'/v1', modelId: GO_MODEL, apiKey: 'synthetic', ...(go ? { catalogProviderId: 'opencode-go' } : {}), contextWindow: 200000, maxOutputTokens: 4096 });
    const p = await make('primary', primaryGo), b = await make('backup', !primaryGo);
    const group = await call('modelgroup.create', { name: 'N23 chain', memberIds: [p.id,b.id] });
    const s = await call('chat.sessions.create');
    await call('chat.sessions.setModelBinding', { sessionId: s.id, binding: 'group:'+group.id });
    await call('chat.prompt', { sessionId: s.id, text: 'N23 fallback' });
    await waitFor('备用标题到达', () => hits.some(h => !h.primary && h.title));
    expect(hits).toHaveLength(3);
    for (const h of hits) {
      const go = h.primary ? primaryGo : !primaryGo;
      expect(h.headers['x-opencode-session']).toBe(go ? s.id : undefined);
      if (go) expect(h.headers['user-agent']).toBe('DeskMinis/0.3.0');
      else expect(h.headers['user-agent']).not.toMatch(/^DeskMinis(?:\/|$)/);
    }
  });
});
