/** G1 市场客户端守卫例（设计稿 §2/§7）：域名白名单**运行时闸**——白名单外直接 throw
 *  且闸在 fetch 之前（注入的 fetchImpl 绝不被调用，比源码扫描硬）；非 https 拒绝；
 *  超时（注入短时限验证行为而非等真 10s）；响应体积上限（读流计数超限即断 + truncated 标记）；
 *  并发 ≤2 信号量；请求头卫生（只带 accept 与条件 if-none-match，无任何本机标识头）；
 *  304 透传给缓存层。fixture 用本地 node:http（D3/D4 成例），fetchImpl 做
 *  「白名单域名 → 本地 fixture」的重写——闸校验的仍是生产 URL，注入不绕闸。 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MarketClient, assertWhitelisted, MARKET_DOMAIN_WHITELIST } from '../src/minisd/market/client';

/** 本地 fixture 服务器：记录收到的请求（方法/URL/头），按注入 handler 应答 */
interface FixtureReq { method: string; url: string; headers: Record<string, string> }
interface Fixture {
  url: string;
  requests: FixtureReq[];
  close(): Promise<void>;
}

async function startFixture(handler: (req: FixtureReq, res: ServerResponse) => void): Promise<Fixture> {
  const requests: FixtureReq[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v);
    const rec = { method: req.method ?? 'GET', url: req.url ?? '/', headers };
    requests.push(rec);
    handler(rec, res);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

const servers: Fixture[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });

/** 测试注入 fetch：把白名单 https 域名重写到本地 fixture——MarketClient 的闸在 fetch 之前运行，
 *  校验的始终是构造出的生产 URL；这里只做网络层路由模拟。 */
function rewriteFetch(base: string): typeof fetch {
  return (async (input: unknown, init?: RequestInit) =>
    fetch(String(input).replace(/^https:\/\/[^/]+/, base), init)) as typeof fetch;
}

/** 抓 rejection 的 Error（比 rejects.toThrow 更方便做多段断言） */
async function errOf(p: Promise<unknown>): Promise<Error> {
  return (await p.catch((e) => e)) as Error;
}

describe('白名单运行时闸', () => {
  it('MARKET_DOMAIN_WHITELIST 恰为三源实抓裁定的域名集合（编译期常量锚）', () => {
    // G1 步骤 A 首跑实抓确定：ClawHub / MCP 官方注册表 / awesome-dsh-plugin
    expect([...MARKET_DOMAIN_WHITELIST].sort()).toEqual([
      'awesome-dsh-plugin.com', 'clawhub.ai', 'registry.modelcontextprotocol.io',
    ]);
  });

  it('assertWhitelisted：三源域名放行；白名单外 / 非 https / 仿冒子域 / 非法 URL 一律 throw', async () => {
    expect(assertWhitelisted('https://clawhub.ai/api/v1/search?q=x').hostname).toBe('clawhub.ai');
    expect(assertWhitelisted('https://registry.modelcontextprotocol.io/v0.1/servers').hostname).toBe('registry.modelcontextprotocol.io');
    expect(assertWhitelisted('https://awesome-dsh-plugin.com/plugins.json').hostname).toBe('awesome-dsh-plugin.com');
    // 白名单外域名（「URL 查询串即外泄通道」纪律的锚点：fetch 只打白名单域名）
    const e1 = await errOfInSync(() => assertWhitelisted('https://evil.example/api'));
    expect(e1.message).toContain('白名单');
    const e2 = await errOfInSync(() => assertWhitelisted('http://clawhub.ai/api'));
    expect(e2.message).toContain('https');
    const e3 = await errOfInSync(() => assertWhitelisted('https://clawhub.ai.evil.com/api'));
    expect(e3.message).toContain('白名单');
    const e4 = await errOfInSync(() => assertWhitelisted('ht!tp://不是合法 URL'));
    expect(e4).toBeInstanceOf(Error);
  });

  it('fetchText 对白名单外域名直接 throw，且 fetchImpl 从未被调用（闸在 fetch 之前）', async () => {
    let called = 0;
    const spyFetch = (async () => { called++; return new Response('{}'); }) as typeof fetch;
    const c = new MarketClient(spyFetch);
    const e = await errOf(c.fetchText('https://evil.example/x', { maxBytes: 1024 }));
    expect(e.message).toContain('白名单');
    expect(called).toBe(0);
  });
});

describe('预算上限（C 波纪律沿用）', () => {
  it('超时：fixture 挂起不响应，注入短时限 → 拒绝并归类为超时', async () => {
    const f = await startFixture((_req, res) => { /* 永不应答 */ });
    servers.push(f);
    const c = new MarketClient(rewriteFetch(f.url));
    const e = await errOf(c.fetchText('https://clawhub.ai/api/v1/search?q=x', { maxBytes: 1024, timeoutMs: 120 }));
    expect(['TimeoutError', 'AbortError']).toContain(e.name);
  });

  it('体积上限：读流计数超限即断（truncated:true，body 恰为上限字节，不先整读再截断）', async () => {
    const f = await startFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(64 * 1024));
    });
    servers.push(f);
    const c = new MarketClient(rewriteFetch(f.url));
    const r = await c.fetchText('https://clawhub.ai/api/v1/search?q=x', { maxBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(1024);
  });

  it('并发 ≤2：三个并行请求，fixture 观测到的在途峰值不超过 2（简单信号量）', async () => {
    let inflight = 0; let peak = 0;
    const f = await startFixture((_req, res) => {
      inflight++; peak = Math.max(peak, inflight);
      setTimeout(() => { inflight--; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, 80);
    });
    servers.push(f);
    const c = new MarketClient(rewriteFetch(f.url));
    await Promise.all([
      c.fetchText('https://clawhub.ai/a', { maxBytes: 1024 }),
      c.fetchText('https://clawhub.ai/b', { maxBytes: 1024 }),
      c.fetchText('https://clawhub.ai/c', { maxBytes: 1024 }),
    ]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(2); // 真并发了（否则信号量形同虚设）
  });
});

describe('请求卫生与条件请求', () => {
  it('请求头只带 accept（与条件 if-none-match）：无 authorization/cookie/x-* 等本机标识头', async () => {
    const f = await startFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: 'W/"abc"' });
      res.end('{}');
    });
    servers.push(f);
    const c = new MarketClient(rewriteFetch(f.url));
    await c.fetchText('https://clawhub.ai/api/v1/search?q=x', { maxBytes: 1024, etag: 'W/"abc"' });
    const h = f.requests[0].headers;
    expect(h['accept']).toBe('application/json');
    expect(h['if-none-match']).toBe('W/"abc"');
    // 不带任何本机标识 / 密钥 / telemetry 头（C 波密钥卫生红线）
    for (const bad of ['authorization', 'cookie', 'x-api-key', 'x-client-id', 'x-device-id']) {
      expect(h[bad]).toBeUndefined();
    }
  });

  it('304 透传：状态原样返回给缓存层（只刷 fetched_at 的判断在缓存层做）', async () => {
    const f = await startFixture((_req, res) => {
      res.writeHead(304, {});
      res.end();
    });
    servers.push(f);
    const c = new MarketClient(rewriteFetch(f.url));
    const r = await c.fetchText('https://clawhub.ai/api/v1/search?q=x', { maxBytes: 1024, etag: 'W/"abc"' });
    expect(r.status).toBe(304);
    expect(r.body).toBe('');
    expect(f.requests[0].headers['if-none-match']).toBe('W/"abc"');
  });

  it('URL 查询串只含编码后的搜索词等功能参数（无跟踪参数）', async () => {
    const f = await startFixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    servers.push(f);
    const c = new MarketClient(rewriteFetch(f.url));
    // 适配器构造 URL 的纪律锚：查询串是功能参数，不含任何标识/埋点
    await c.fetchText('https://clawhub.ai/api/v1/search?q=' + encodeURIComponent('中文 技能') + '&limit=30', { maxBytes: 1024 });
    const u = new URL('https://clawhub.ai' + f.requests[0].url);
    expect(u.search).toBe('?q=' + encodeURIComponent('中文 技能') + '&limit=30');
  });
});

/** 同步 throw 的抓取（assertWhitelisted 是同步闸） */
function errOfInSync(fn: () => unknown): Promise<Error> {
  try { fn(); return Promise.resolve(new Error('未抛出')); } catch (e) { return Promise.resolve(e as Error); }
}
