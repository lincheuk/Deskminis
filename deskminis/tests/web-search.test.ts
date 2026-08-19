/** web_search 工具：三 kind（brave/tavily/searxng）请求构造与响应映射、count 夹取、
 *  码点安全截断、超时/非 2xx 文案细分、密钥脱敏、web-search 权限类目 askOnce、
 *  SearchProviderStore（密钥只进 vault，get 只回 hasKey 布尔）。
 *  fetch 一律构造注入（捕获 init 断言方法/请求头/请求体，web-fetch.test.ts 同款模式）。 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeWebSearchTool, type ResolvedSearchProvider } from '../src/minisd/tools/web-search';
import { SearchProviderStore } from '../src/minisd/store/search-provider-store';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionDecision, PermissionGateway, PermissionRequest } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';

/** 捕获型 fetch mock：记录每次调用的 URL/方法/请求头/请求体，按完整 URL 精确路由响应。 */
interface CapturedCall { url: string; method: string; headers: Record<string, string>; body?: string }
function captureFetch(routes: Record<string, { status?: number; body?: string }>, calls: CapturedCall[] = []): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) for (const [k, v] of new Headers(init.headers as HeadersInit)) headers[k] = v;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const r = routes[String(input)];
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** 永不 resolve 的 fetch：signal 中止才拒绝——用于超时路径（中止原因映射回错误名，模拟原生 fetch 行为）。 */
function hangingFetch(calls: { count: number } = { count: 0 }): typeof fetch {
  return ((async (_input: unknown, init?: RequestInit) => {
    calls.count++;
    return new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => {
        const reason = (init.signal as AbortSignal).reason as DOMException | undefined;
        const e = new Error('aborted');
        e.name = reason?.name ?? 'AbortError';
        rej(e);
      });
    });
  }) as typeof fetch);
}

const allowAll: PermissionGateway = {
  async check(): Promise<PermissionDecision> { return 'allow'; },
  hasBridgeGrant: () => false,
};

function mkCtx(permissions: PermissionGateway = allowAll, signal?: AbortSignal) {
  const root = mkdtempSync(join(tmpdir(), 'dm-ws-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  return { sessionId: 'S1', paths, permissions, signal };
}

const cfgOf = (c: ResolvedSearchProvider | undefined) => () => c;
const BRAVE: ResolvedSearchProvider = { kind: 'brave', apiKey: 'BSKEY-SECRET' };
const TAVILY: ResolvedSearchProvider = { kind: 'tavily', apiKey: 'TVKEY-SECRET' };
const SEARX: ResolvedSearchProvider = { kind: 'searxng', baseUrl: 'https://searx.example' };

const braveOk = (results: unknown[]) => JSON.stringify({ web: { results } });
const resultsOk = (results: unknown[]) => JSON.stringify({ results });

describe('web_search 请求构造（1-3：URL/方法/请求头/请求体；key 只在头、绝不在 URL）', () => {
  it('brave：GET 官方端点，X-Subscription-Token 头 + Accept json，key 不出现在 URL', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = captureFetch(
      { 'https://api.search.brave.com/res/v1/web/search?q=vitest&count=5': { body: braveOk([]) } },
      calls,
    );
    const tool = makeWebSearchTool(cfgOf(BRAVE), fetchImpl);
    const r = await tool.execute({ query: 'vitest', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers['x-subscription-token']).toBe('BSKEY-SECRET');
    expect(calls[0].headers['accept']).toBe('application/json');
    expect(calls[0].url).not.toContain('BSKEY-SECRET');
    expect(calls[0].body).toBeUndefined();
  });

  it('tavily：POST 官方端点，Bearer 头 + JSON 请求体（query/max_results），key 只在头', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = captureFetch({ 'https://api.tavily.com/search': { body: resultsOk([]) } }, calls);
    const tool = makeWebSearchTool(cfgOf(TAVILY), fetchImpl);
    const r = await tool.execute({ query: 'vitest', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['authorization']).toBe('Bearer TVKEY-SECRET');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].body).toBeDefined();
    expect(JSON.parse(calls[0].body!)).toEqual({ query: 'vitest', max_results: 5 });
    expect(calls[0].body).not.toContain('TVKEY-SECRET');
  });

  it('searxng：GET <baseUrl>/search?q=…&format=json，无鉴权头', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = captureFetch(
      { 'https://searx.example/search?q=vitest&format=json': { body: resultsOk([]) } },
      calls,
    );
    const tool = makeWebSearchTool(cfgOf(SEARX), fetchImpl);
    const r = await tool.execute({ query: 'vitest', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://searx.example/search?q=vitest&format=json');
    expect(calls[0].headers['authorization']).toBeUndefined();
    expect(calls[0].headers['x-subscription-token']).toBeUndefined();
  });
});

describe('web_search count 夹取（4）', () => {
  it.each([
    [undefined, 5],
    [99, 10],
    [0, 1],
  ])('count=%s → 请求带 count=%s', async (input, expected) => {
    const calls: CapturedCall[] = [];
    const fetchImpl = captureFetch(
      { [`https://api.search.brave.com/res/v1/web/search?q=q&count=${expected}`]: { body: braveOk([]) } },
      calls,
    );
    const tool = makeWebSearchTool(cfgOf(BRAVE), fetchImpl);
    const p: Record<string, unknown> = { query: 'q', tool_title: '网络搜索' };
    if (input !== undefined) p.count = input;
    const r = await tool.execute(p, mkCtx());
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`count=${expected}`);
  });
});

describe('web_search 响应映射（5-7：各 kind 含一条字段缺失容错）', () => {
  it('brave：web.results[] 的 title/url/description → 编号三行；缺 url 的条目跳过', async () => {
    const fetchImpl = captureFetch({
      'https://api.search.brave.com/res/v1/web/search?q=q&count=5': {
        body: braveOk([
          { title: '结果一', url: 'https://a.com/1', description: '描述一' },
          { title: '缺 URL 被跳过', description: '没有链接' },
        ]),
      },
    });
    const tool = makeWebSearchTool(cfgOf(BRAVE), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('1. 结果一');
    expect(r.output).toContain('URL: https://a.com/1');
    expect(r.output).toContain('摘要: 描述一');
    expect(r.output).toContain('web_fetch'); // 末尾提示可用 web_fetch 读全文
    expect(r.output).not.toContain('缺 URL');
  });

  it('tavily：results[] 的 title/url/content → 编号三行；缺 content 的条目跳过', async () => {
    const fetchImpl = captureFetch({
      'https://api.tavily.com/search': {
        body: resultsOk([
          { title: '结果甲', url: 'https://b.com/1', content: '内容甲' },
          { title: '缺摘要被跳过', url: 'https://b.com/2' },
        ]),
      },
    });
    const tool = makeWebSearchTool(cfgOf(TAVILY), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('1. 结果甲');
    expect(r.output).toContain('URL: https://b.com/1');
    expect(r.output).toContain('摘要: 内容甲');
    expect(r.output).not.toContain('缺摘要');
  });

  it('searxng：results[] 的 title/url/content → 编号三行；缺 title 的条目跳过', async () => {
    const fetchImpl = captureFetch({
      'https://searx.example/search?q=q&format=json': {
        body: resultsOk([
          { url: 'https://c.com/1', content: '内容子' },
          { title: '正常条目', url: 'https://c.com/2', content: '内容丑' },
        ]),
      },
    });
    const tool = makeWebSearchTool(cfgOf(SEARX), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('1. 正常条目');
    expect(r.output).toContain('URL: https://c.com/2');
    expect(r.output).toContain('摘要: 内容丑');
    expect(r.output).not.toContain('内容子'); // 缺 title 的第一条整体跳过
  });
});

describe('web_search 截断防线（8）', () => {
  it('摘要超 500 码点按码点截断：emoji（代理对）不被切成乱码', async () => {
    const longDesc = '😀'.repeat(501) + '尾'; // 502 码点，截断后 500 个 emoji
    const fetchImpl = captureFetch({
      'https://api.search.brave.com/res/v1/web/search?q=q&count=5': {
        body: braveOk([{ title: 'T', url: 'https://a.com', description: longDesc }]),
      },
    });
    const tool = makeWebSearchTool(cfgOf(BRAVE), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(true);
    const line = r.output.split('\n').find(l => l.startsWith('   摘要: '))!;
    expect(line.split('😀').length - 1).toBe(500); // 恰好 500 个完整 emoji
    expect(r.output).not.toContain('\uFFFD');      // 没有切断代理对产生的替换符
  });

  it('总输出超 32KB 到限即截并注明', async () => {
    // 100 条 × ~500 字摘要 ≈ 53KB，超 32KB 上限
    const entries = Array.from({ length: 100 }, (_, i) => ({
      title: `标题${i}`, url: `https://a.com/${i}`, description: 'x'.repeat(500),
    }));
    const fetchImpl = captureFetch({
      'https://api.search.brave.com/res/v1/web/search?q=q&count=10': { body: braveOk(entries) },
    });
    const tool = makeWebSearchTool(cfgOf(BRAVE), fetchImpl);
    const r = await tool.execute({ query: 'q', count: 10, tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('[输出超过 32KB 被截断]');
    expect(Array.from(r.output).length).toBeLessThanOrEqual(32 * 1024 + 30);
  });
});

describe('web_search 超时与错误文案（9-13）', () => {
  it('超时返回工具错误（注入短超时避免测试等 15 秒）', async () => {
    const calls = { count: 0 };
    const tool = makeWebSearchTool(cfgOf(BRAVE), hangingFetch(calls), 20);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('搜索请求超时');
    expect(calls.count).toBe(1);
  });

  it.each([
    [401, '密钥无效或无权限', 'HTTP 401'],
    [403, '密钥无效或无权限', 'HTTP 403'],
  ])('HTTP %s → 密钥类文案；响应体里埋的 key 绝不进输出', async (status, ...fragments) => {
    const fetchImpl = captureFetch({
      'https://api.search.brave.com/res/v1/web/search?q=q&count=5': {
        status, body: `{"error":"unauthorized key=BSKEY-SECRET"}`,
      },
    });
    const tool = makeWebSearchTool(cfgOf(BRAVE), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(false);
    for (const f of fragments) expect(r.output).toContain(f);
    expect(r.output).toContain('请到设置检查搜索配置');
    expect(r.output).not.toContain('BSKEY-SECRET');
  });

  it('HTTP 429 → 限流文案；响应体里埋的 key 绝不进输出', async () => {
    const fetchImpl = captureFetch({
      'https://api.tavily.com/search': { status: 429, body: '{"detail":"rate limited TVKEY-SECRET"}' },
    });
    const tool = makeWebSearchTool(cfgOf(TAVILY), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('搜索服务限流，请稍后再试');
    expect(r.output).not.toContain('TVKEY-SECRET');
  });

  it('HTTP 500 → 暂不可用文案；响应体里埋的 key 绝不进输出', async () => {
    const fetchImpl = captureFetch({
      'https://searx.example/search?q=q&format=json': { status: 500, body: 'oops TVKEY-SECRET' },
    });
    const tool = makeWebSearchTool(cfgOf(SEARX), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('搜索服务暂不可用（HTTP 500）');
    expect(r.output).not.toContain('TVKEY-SECRET');
  });

  it('顶层 JSON 解析失败 → 固定兜底文案，不回显响应体', async () => {
    const fetchImpl = captureFetch({
      'https://api.search.brave.com/res/v1/web/search?q=q&count=5': { body: '<html>not json BSKEY-SECRET</html>' },
    });
    const tool = makeWebSearchTool(cfgOf(BRAVE), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toBe('搜索服务响应无法解析');
  });

  it('JSON 顶层非对象（如裸字符串）同样按无法解析处理', async () => {
    const fetchImpl = captureFetch({
      'https://api.search.brave.com/res/v1/web/search?q=q&count=5': { body: '"just a string"' },
    });
    const tool = makeWebSearchTool(cfgOf(BRAVE), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toBe('搜索服务响应无法解析');
  });
});

describe('web_search 未配置（14）', () => {
  it('getConfig 返回 undefined → 引导文案，且不发任何请求', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = captureFetch({}, calls);
    const tool = makeWebSearchTool(cfgOf(undefined), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('未配置搜索服务');
    expect(r.output).toContain('设置');
    expect(r.output).toContain('网络搜索');
    expect(calls).toHaveLength(0);
  });

  it('配置了 brave 但密钥缺失（脏配置）同样按未配置引导，不发请求', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = captureFetch({}, calls);
    const tool = makeWebSearchTool(cfgOf({ kind: 'brave' }), fetchImpl);
    const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('未配置搜索服务');
    expect(calls).toHaveLength(0);
  });
});

describe('web_search 权限类目（15）', () => {
  const route = { 'https://api.search.brave.com/res/v1/web/search?q=same+query&count=5': { body: braveOk([{ title: 'T', url: 'https://a.com', description: 'D' }]) } };

  it('默认 askOnce：kind=web-search 过卡（detail 是查询文本），同会话第二次不再询问', async () => {
    const asked: PermissionRequest[] = [];
    const gateway = new PermissionGatewayImpl(async req => { asked.push(req); return 'allow-session'; });
    const calls: CapturedCall[] = [];
    const tool = makeWebSearchTool(cfgOf(BRAVE), captureFetch(route, calls));
    const ctx = mkCtx(gateway);
    const r1 = await tool.execute({ query: 'same query', tool_title: '网络搜索' }, ctx);
    const r2 = await tool.execute({ query: 'same query', tool_title: '网络搜索' }, ctx);
    expect(r1.success && r2.success).toBe(true);
    expect(asked).toHaveLength(1); // 第二次走会话记忆，不再弹卡
    expect(asked[0]).toMatchObject({ kind: 'web-search', detail: 'same query' });
    expect(calls).toHaveLength(2);
  });

  it('deny → 拒绝文案且 fetch 从未被调用', async () => {
    const gateway = new PermissionGatewayImpl(async () => 'deny');
    const calls: CapturedCall[] = [];
    const tool = makeWebSearchTool(cfgOf(BRAVE), captureFetch(route, calls));
    const r = await tool.execute({ query: 'same query', tool_title: '网络搜索' }, mkCtx(gateway));
    expect(r.success).toBe(false);
    expect(r.output).toContain('拒绝');
    expect(calls).toHaveLength(0);
  });
});

describe('SearchProviderStore（16：密钥单向，get 不回读）', () => {
  function mkStore() {
    const dir = mkdtempSync(join(tmpdir(), 'dm-sps-'));
    const vault = new InMemoryVault();
    return { dir, vault, store: new SearchProviderStore(dir, vault) };
  }

  it('初始未配置：{kind:"none", hasKey:false}', () => {
    const { store } = mkStore();
    expect(store.get()).toEqual({ kind: 'none', hasKey: false });
    expect(store.resolve()).toBeUndefined();
  });

  it('set brave 后 get 只回 hasKey 布尔（绝不含 key 本体）；resolve 仅供内部消费', () => {
    const { store, vault } = mkStore();
    store.set({ kind: 'brave', apiKey: 'BK-SECRET' });
    expect(store.get()).toEqual({ kind: 'brave', hasKey: true });
    expect(JSON.stringify(store.get())).not.toContain('BK-SECRET');
    expect(store.resolve()).toEqual({ kind: 'brave', apiKey: 'BK-SECRET' });
    expect(vault.get('search-provider')).toBe('BK-SECRET');
  });

  it('同 kind 留空 = 保留原密钥；换 kind 不带新密钥 → 报错（旧密钥属于另一家服务）', () => {
    const { store } = mkStore();
    store.set({ kind: 'tavily', apiKey: 'TK' });
    store.set({ kind: 'tavily' }); // 只改其他字段，密钥不动
    expect(store.get().hasKey).toBe(true);
    expect(() => store.set({ kind: 'brave' })).toThrow('密钥');
  });

  it('searxng 存 baseUrl；切换到 searxng 时清掉旧密钥槽位', () => {
    const { store, vault } = mkStore();
    store.set({ kind: 'brave', apiKey: 'BK' });
    store.set({ kind: 'searxng', baseUrl: 'https://searx.example/' });
    expect(store.get()).toEqual({ kind: 'searxng', hasKey: false, baseUrl: 'https://searx.example/' });
    expect(vault.get('search-provider')).toBeUndefined();
    expect(store.resolve()).toEqual({ kind: 'searxng', baseUrl: 'https://searx.example/' });
  });

  it('searxng 缺 baseUrl / brave 缺密钥（新配置）→ 报错', () => {
    const { store } = mkStore();
    expect(() => store.set({ kind: 'searxng' })).toThrow('实例地址');
    expect(() => store.set({ kind: 'brave' })).toThrow('密钥');
  });

  it('kind 传 none/空 → 清除配置与密钥槽位', () => {
    const { store, vault } = mkStore();
    store.set({ kind: 'brave', apiKey: 'BK' });
    store.set({ kind: 'none' });
    expect(store.get()).toEqual({ kind: 'none', hasKey: false });
    expect(vault.get('search-provider')).toBeUndefined();
    store.set({ kind: 'brave', apiKey: 'BK2' });
    store.set({ kind: '' });
    expect(store.get().kind).toBe('none');
  });

  it('配置持久化：重开 store 状态一致，配置文件无密钥明文', () => {
    const { dir, vault } = mkStore();
    const s1 = new SearchProviderStore(dir, vault);
    s1.set({ kind: 'tavily', apiKey: 'TK-SECRET' });
    const s2 = new SearchProviderStore(dir, vault);
    expect(s2.get()).toEqual({ kind: 'tavily', hasKey: true });
    expect(s2.resolve()).toEqual({ kind: 'tavily', apiKey: 'TK-SECRET' });
    const cfgText = readFileSync(join(dir, 'search-provider.json'), 'utf8');
    expect(cfgText).not.toContain('TK-SECRET');
  });
});

describe('search.provider.* RPC（get 不回读 key；set 后 get 状态正确）', () => {
  it('set→get 经 RPC 往返：结果不含密钥本体', async () => {
    const { startMinisd } = await import('../src/minisd/index');
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-wsrpc-'));
    process.env.DESKMINIS_TEST = '1';
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?token=${encodeURIComponent(srv.authToken)}`);
      await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
      const call = (method: string, params?: unknown) => new Promise<any>(res => {
        const id = Math.random().toString(36).slice(2);
        const onMsg = (data: unknown) => {
          const msg = JSON.parse(String(data));
          if (msg.id === id) { ws.off('message', onMsg); res(msg); }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
      const empty = (await call('search.provider.get')).result;
      expect(empty).toEqual({ kind: 'none', hasKey: false });
      expect((await call('search.provider.set', { kind: 'brave', apiKey: 'RPC-SECRET' })).result).toEqual({ ok: true });
      const got = (await call('search.provider.get')).result;
      expect(got).toEqual({ kind: 'brave', hasKey: true });
      expect(JSON.stringify(got)).not.toContain('RPC-SECRET');
      ws.close();
    } finally {
      await srv.close();
    }
  });
});

describe('searxng baseUrl 尾斜杠规范化（17）', () => {
  it('带/不带尾斜杠发出完全相同的请求 URL', async () => {
    const target = 'https://searx.example/search?q=q&format=json';
    for (const baseUrl of ['https://searx.example', 'https://searx.example/', 'https://searx.example///']) {
      const calls: CapturedCall[] = [];
      const fetchImpl = captureFetch({ [target]: { body: resultsOk([]) } }, calls);
      const tool = makeWebSearchTool(cfgOf({ kind: 'searxng', baseUrl }), fetchImpl);
      const r = await tool.execute({ query: 'q', tool_title: '网络搜索' }, mkCtx());
      expect(r.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(target);
    }
  });
});
