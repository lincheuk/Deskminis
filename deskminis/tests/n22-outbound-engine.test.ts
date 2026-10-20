import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import { wireClient, waitFor, type WireClient } from './state-sync-fixture';
import * as outbound from '../src/minisd/net/outbound-fetch';
import * as catalog from '../src/minisd/providers/model-catalog';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { McpManager } from '../src/minisd/mcp/manager';
import { MinisPaths } from '../src/minisd/paths';
import type { ToolContext } from '../src/minisd/tools/types';

const engines: CapturedEngine[] = [], clients: WireClient[] = [];
let hits: { url: string; init?: RequestInit }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (...data: unknown[]) => new Response(data.map(x => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
const route: typeof fetch = async (input, init) => {
  const url = String(input); hits.push({ url, init });
  if (url.startsWith('https://models.dev/')) return json({ n22: { models: { n22: { limit: { context: 200000, output: 4096 }, modalities: { input: ['text'], output: ['text'] } } } } });
  if (url.startsWith('https://basellm.github.io/')) return json({ success: true, data: [] });
  if (url.startsWith('https://raw.githubusercontent.com/') && !url.endsWith('/SKILL.md')) return json({});
  if (url.includes('/chat/completions')) return sse({ choices: [{ delta: { content: 'N22 synthetic' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]');
  if (url.endsWith('/v1/messages')) return sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'N22 synthetic' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' });
  if (url.includes(':streamGenerateContent')) return sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'N22 synthetic' }] }, finishReason: 'STOP' }] });
  if (url.endsWith('/models')) return json({ data: [{ id: 'n22-list' }] });
  if (url === 'https://web.example/page') return new Response('<html><body>N22 web result</body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.startsWith('https://api.search.brave.com/')) return json({ web: { results: [{ title: 'N22 search', url: 'https://web.example/result', description: 'found' }] } });
  if (url.startsWith('https://registry.modelcontextprotocol.io/')) return json({ servers: [] });
  if (url.startsWith('https://api.github.com/repos/n22/synthetic/contents/')) return json([{ type: 'file', name: 'SKILL.md', path: 'SKILL.md', download_url: 'https://raw.githubusercontent.com/n22/synthetic/main/SKILL.md' }]);
  if (url.endsWith('/n22/synthetic/main/SKILL.md')) return new Response('---\nname: n22-synthetic\ndescription: synthetic fixture\n---\nN22 fixture');
  if (url === 'https://mcp.example/probe' || url === 'https://mcp.example/managed') {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    const b = JSON.parse(String(init?.body));
    if (b.id === undefined) return new Response(null, { status: 202 });
    return json({ jsonrpc: '2.0', id: b.id, result: b.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'n22', version: '1' } } : { tools: [] } });
  }
  throw new Error('N22 未声明合成路由: ' + url);
};

beforeEach(() => {
  hits = [];
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('N22 绕过统一出口'); }));
  vi.spyOn(outbound, 'outboundFetch').mockImplementation(route);
  vi.spyOn(outbound, 'createOutboundFetch').mockReturnValue(route);
  // 漏掉目录包装时只会落到这个失败桩，绝不访问外部服务。
  vi.spyOn(catalog, 'createProxyFetch').mockReturnValue(async () => { throw new Error('N22 目录绕过统一出口'); });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const e of engines.splice(0).reverse()) await e.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function boot() { const e = await startCapturedEngine(); engines.push(e); return e; }
const call = (e: CapturedEngine, method: string, params: unknown = {}) => e.methods[method](params, probeConnection('local')) as Promise<any>;
async function wire(e: CapturedEngine) { const c = wireClient(e.handle.port, e.handle.authToken); clients.push(c); await c.ready; return c; }

describe('N22 真实引擎出口组装', () => {
  it.each([
    ['openai-compat', 'https://openai.example/v1', '/v1/chat/completions'],
    ['anthropic', 'https://anthropic.example', '/v1/messages'],
    ['gemini', 'https://gemini.example', ':streamGenerateContent'],
  ])('%s 模型对话经过出口并产出正文', async (kind, baseUrl, path) => {
    const e = await boot(), c = await wire(e);
    const p = await call(e, 'provider.instances.create', { name: 'N22', kind, baseUrl, modelId: 'n22-synthetic', apiKey: 'synthetic', contextWindow: 200000, maxOutputTokens: 4096 });
    const s = await call(e, 'chat.sessions.create', { title: 'N22' });
    await call(e, 'chat.prompt', { sessionId: s.id, providerId: p.id, text: 'N22 synthetic' });
    await waitFor('N22 result', () => vi.mocked(fetch).mock.calls.length > 0 || c.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === s.id && n.params.event?.kind === 'turnEnd'));
    expect(fetch).not.toHaveBeenCalled();
    expect(c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === s.id && n.params.event?.kind === 'textDelta').map(n => n.params.event.text).join('')).toBe('N22 synthetic');
    expect(hits.filter(h => h.url.startsWith(baseUrl) && h.url.includes(path)).length).toBeGreaterThan(0);
  });

  it('模型列表与主目录、备用目录都经过出口', async () => {
    // 主目录失败时仍经同一出口尝试原有备用目录。
    vi.mocked(outbound.createOutboundFetch).mockReturnValue(async (input, init) => {
      if (String(input).startsWith('https://models.dev/')) { hits.push({ url: String(input), init }); throw new Error('synthetic primary unavailable'); }
      return route(input, init);
    });
    const e = await boot();
    expect(await call(e, 'provider.models.fetch', { kind: 'openai-compat', baseUrl: 'https://openai.example/v1', apiKey: 'synthetic' })).toEqual({ models: ['n22-list'] });
    const p = await call(e, 'provider.instances.create', { name: 'list', kind: 'openai-compat', baseUrl: 'https://openai.example/v1', modelId: 'n22', apiKey: 'synthetic' });
    expect(await call(e, 'provider.models.fetch', { id: p.id })).toEqual({ models: ['n22-list'] });
    await call(e, 'provider.catalog.refresh');
    expect(hits.some(h => h.url.startsWith('https://models.dev/'))).toBe(true);
    expect(hits.some(h => h.url.startsWith('https://basellm.github.io/'))).toBe(true);
    expect(hits.filter(h => h.url === 'https://openai.example/v1/models')).toHaveLength(2);
  });

  it('组装的网页抓取、搜索工具经过出口并返回结果', async () => {
    const registered = vi.spyOn(ToolRegistry.prototype, 'register');
    const e = await boot();
    const registry = registered.mock.contexts[0] as ToolRegistry;
    expect(registry).toBeInstanceOf(ToolRegistry);
    const ctx: ToolContext = { sessionId: 'n22', paths: new MinisPaths(e.root), permissions: { check: async () => 'allow', hasBridgeGrant: () => false } };
    const fetched = await registry.execute('web_fetch', JSON.stringify({ url: 'https://web.example/page', tool_title: 'N22' }), ctx);
    expect(fetched.success).toBe(true); expect(fetched.output).toContain('N22 web result');
    await call(e, 'search.provider.set', { kind: 'brave', apiKey: 'synthetic' });
    const found = await registry.execute('web_search', JSON.stringify({ query: 'N22', tool_title: 'N22' }), ctx);
    expect(found.success).toBe(true); expect(found.output).toContain('N22 search');
    expect(hits.some(h => h.url === 'https://web.example/page')).toBe(true);
    expect(hits.some(h => h.url.startsWith('https://api.search.brave.com/'))).toBe(true);
  });

  it('远程 MCP 试连与运行时管理器都经过出口', async () => {
    const ensured = vi.spyOn(McpManager.prototype, 'ensureForRun');
    const e = await boot();
    expect(await call(e, 'mcp.servers.test', { name: 'probe', type: 'http', url: 'https://mcp.example/probe' })).toMatchObject({ ok: true, toolCount: 0 });
    await call(e, 'mcp.servers.upsert', { name: 'managed', type: 'http', url: 'https://mcp.example/managed', enabled: true });
    const p = await call(e, 'provider.instances.create', { name: 'mcp-run', kind: 'openai-compat', baseUrl: 'https://openai.example/v1', modelId: 'n22', apiKey: 'synthetic' });
    const s = await call(e, 'chat.sessions.create', { title: 'N22 MCP' }), c = await wire(e);
    await call(e, 'chat.prompt', { sessionId: s.id, providerId: p.id, text: 'synthetic' });
    await waitFor('MCP run finished', () => c.notifications.some(n => n.method === 'chat.event' && n.params.event?.kind === 'turnEnd'));
    expect(ensured).toHaveBeenCalled();
    for (const target of ['probe', 'managed']) {
      const methods = hits.filter(h => h.url === 'https://mcp.example/' + target && h.init?.body).map(h => JSON.parse(String(h.init!.body)).method);
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    }
  });

  it('扩展市场及 GitHub 技能 API、文件下载都经过出口', async () => {
    const e = await boot();
    expect(await call(e, 'market.search', { kind: 'mcp', q: 'N22' })).toEqual({ items: [] });
    expect(hits.some(h => h.url.startsWith('https://registry.modelcontextprotocol.io/'))).toBe(true);
    const task = await call(e, 'skills.import', { kind: 'github-url', source: 'https://github.com/n22/synthetic' });
    let status: any;
    await waitFor('技能导入完成', async () => { status = await call(e, 'skills.importStatus', task); return status.state !== 'running'; });
    expect(status).toMatchObject({ state: 'done', completed: 1, failures: [] });
    expect(status.succeeded).toHaveLength(1);
    expect(hits.some(h => h.url.startsWith('https://api.github.com/repos/n22/synthetic/contents/'))).toBe(true);
    expect(hits.some(h => h.url === 'https://raw.githubusercontent.com/n22/synthetic/main/SKILL.md')).toBe(true);
  });

  it.each(['legacy', 'authenticated'])('%s 真实回环配对、局域网同步不经过对外出口', async policy => {
    const a = await boot(), b = await boot();
    await call(a, 'remote.pair.setPolicy', { policy });
    await call(b, 'remote.pair.setPolicy', { policy });
    // 等启动目录预热完毕，然后清零；两端之间只发生配对与同步。
    await call(a, 'provider.catalog.refresh'); await call(b, 'provider.catalog.refresh'); hits.length = 0;
    const begin = await call(b, 'remote.pair.begin');
    await call(a, 'remote.pair.join', { host: '127.0.0.1', port: b.handle.port, pairingCode: begin.pairingCode, peerName: 'N22-B', listenPort: a.handle.listenPort });
    await waitFor('对端上线', async () => (await call(a, 'remote.status')).devices.some((d: any) => d.online));
    const s = await call(a, 'chat.sessions.create', { title: 'N22 sync direct' });
    await call(a, 'chat.sessions.setPinned', { sessionId: s.id, pinned: true });
    await waitFor('B 收到置顶会话', async () => (await call(b, 'chat.sessions.list')).some((x: any) => x.id === s.id && x.pinnedAt != null));
    expect(hits).toEqual([]);
  });
});
