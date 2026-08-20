/** G1 三源适配器 + SQLite 缓存例（设计稿 §2/§7）：每适配器的搜索/详情字段映射（源字段 → MarketItem）、
 *  awesome-dsh kind 过滤（混合分类 fixture → 只有技能类入列）、分页（MCP registry 游标透传、
 *  ClawHub/awesome-dsh 本地切页）、缓存 TTL 软过期（未过期零网络 / 过期 ETag 304 只刷时间 /
 *  HTTP 500 与超时降级返回 stale 缓存 / 体积超限按失败处理）。fixture 用本地 node:http，
 *  fetchImpl 做「白名单域名 → 本地 fixture」重写（闸校验的仍是生产 URL，注入不绕闸）。 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { MarketClient } from '../src/minisd/market/client';
import { MarketCache } from '../src/minisd/market/cache';
import { ClawHubSource } from '../src/minisd/market/clawhub';
import { McpRegistrySource } from '../src/minisd/market/mcp-registry';
import { AwesomeDshSource } from '../src/minisd/market/awesome-dsh';

interface FixtureReq { method: string; url: string; headers: Record<string, string> }

/** 可编程 fixture：handler 可在测试中途替换（模拟源故障切换 500 / 挂起） */
class Fixture {
  readonly url: string;
  readonly requests: FixtureReq[] = [];
  private server: Server;
  private handler: (req: FixtureReq, res: ServerResponse) => void = () => {};
  private constructor(server: Server, port: number) {
    this.server = server;
    this.url = `http://127.0.0.1:${port}`;
  }
  static async start(): Promise<Fixture> {
    let fx!: Fixture;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v);
      const rec = { method: req.method ?? 'GET', url: req.url ?? '/', headers };
      fx.requests.push(rec);
      fx.handler(rec, res);
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    fx = new Fixture(server, (server.address() as AddressInfo).port);
    return fx;
  }
  set(h: (req: FixtureReq, res: ServerResponse) => void): void { this.handler = h; }
  /** 按路径前缀路由的默认 handler */
  close(): Promise<void> { return new Promise((res) => this.server.close(() => res())); }
}

/** 「白名单域名 → 本地 fixture」重写 fetch：MarketClient 的闸先于 fetch 校验生产 URL */
function rewriteFetch(base: string): typeof fetch {
  return (async (input: unknown, init?: RequestInit) =>
    fetch(String(input).replace(/^https:\/\/[^/]+/, base), init)) as typeof fetch;
}

async function errOf(p: Promise<unknown>): Promise<Error> {
  return (await p.catch((e) => e)) as Error;
}

// ── ClawHub fixture 数据（字段形态照 2026-08-20 实抓样例） ─────────────────────
const clawhubSearchBody = (n: number) => JSON.stringify({
  results: Array.from({ length: n }, (_, i) => ({
    slug: `skill-${i}`,
    displayName: `Skill ${i}`,
    summary: `技能 ${i} 的摘要`,
    downloads: 1000 + i,
    ownerHandle: `owner-${i % 2}`,
    isSuspicious: false,
    native: { skill: { isSuspicious: i === 3, stats: { downloads: 1000 + i, stars: 10 + i } } },
  })),
});
const clawhubDetailBody = JSON.stringify({
  skill: {
    slug: 'skill-0', displayName: 'Skill 0', summary: '技能 0 的摘要',
    description: '# SKILL.md 正文\n技能全文。',
    stats: { downloads: 1000, stars: 10 }, topics: ['tool'],
  },
  latestVersion: { version: '1.0.0' },
  metadata: null,
  owner: { handle: 'owner-0', displayName: 'Owner Zero' },
  moderation: null,
});
const clawhubScanBody = (status: string) => JSON.stringify({
  skill: { slug: 'skill-0', displayName: 'Skill 0' },
  version: { version: '1.0.0' },
  moderation: null,
  security: { status, hasScanResult: status !== 'none', checkedAt: 1, sha256hash: 'abc' },
});

// ── MCP registry fixture 数据 ────────────────────────────────────────────────
const mcpListBody = (names: string[], nextCursor?: string) => JSON.stringify({
  servers: names.map((n, i) => ({
    server: {
      name: n, title: `Server ${i}`, description: `MCP 服务器 ${n} 的描述`,
      version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.example/rpc' }],
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
  })),
  metadata: nextCursor ? { nextCursor, count: names.length } : { nextCursor: null, count: names.length },
});
const mcpDetailBody = (name: string) => JSON.stringify({
  server: {
    name, title: 'Server 0', description: `MCP 服务器 ${name} 的详情描述`, version: '2.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example/rpc' }],
  },
  _meta: {},
});

// ── awesome-dsh fixture 数据（混合分类：2 技能 + 1 主题 + 1 提及 MCP 的 DSH 代码插件） ──
const awesomeIndexBody = JSON.stringify({
  name: 'awesome-dsh-plugin', count: 4,
  plugins: [
    {
      name: 'dsh-skill-code-reviewer', owner: '7dgroup-ai', url: 'https://github.com/7dgroup-ai/x',
      page: 'https://awesome-dsh-plugin.com/p/7dgroup-ai/dsh-skill-code-reviewer/',
      category: 'skill',
      description: { en: 'Code review skill', zh: '代码审查技能' },
      npm: null, stars: 3, downloads: 12, install: 'dsh plugin add x', added: '2026-08-17',
    },
    {
      name: 'dsh-skill-writer', owner: 'someone', url: 'https://github.com/someone/y',
      page: 'https://awesome-dsh-plugin.com/p/someone/dsh-skill-writer/',
      category: 'skill',
      description: { en: 'Writing skill', zh: '写作技能' },
      npm: 'dsh-skill-writer', stars: 5, downloads: 30, install: 'dsh plugin add y', added: '2026-08-16',
    },
    {
      name: 'aurora-theme-clone', owner: 'themers', url: 'https://github.com/themers/z',
      page: 'https://awesome-dsh-plugin.com/p/themers/aurora-theme-clone/',
      category: 'theme',
      description: { en: 'A theme', zh: '一个主题' },
      npm: 'aurora-theme-clone', stars: 9, downloads: 99, install: 'dsh plugin add z', added: '2026-08-15',
    },
    {
      name: 'dsh-plugin-mcp-panel', owner: 'coders', url: 'https://github.com/coders/w',
      page: 'https://awesome-dsh-plugin.com/p/coders/dsh-plugin-mcp-panel/',
      category: 'tools',
      description: { en: 'MCP panel DSH plugin (code plugin)', zh: 'MCP 面板 DSH 代码插件' },
      npm: 'dsh-plugin-mcp-panel', stars: 2, downloads: 8, install: 'dsh plugin add w', added: '2026-08-14',
    },
  ],
});

// ── 测试装配 ────────────────────────────────────────────────────────────────
let fx: Fixture;
let db: Database.Database;
let cache: MarketCache;
let clawhub: ClawHubSource;
let registry: McpRegistrySource;
let awesome: AwesomeDshSource;

/** 默认路由：按路径分派三源的端点。
 *  写头统一走 json()：原实现先写 200 再对未匹配路径补写 404，触发
 *  「Cannot write headers after they are sent」未捕获异常（见偏离清单）。 */
function defaultRoutes(): void {
  fx.set((req, res) => {
    const u = new URL(req.url, 'https://x');
    const json = (status: number, body: string) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (u.pathname === '/api/v1/search') return json(200, clawhubSearchBody(5));
    if (u.pathname === '/api/v1/skills/skill-0') return json(200, clawhubDetailBody);
    if (u.pathname === '/api/v1/skills/skill-0/scan') return json(200, clawhubScanBody('clean'));
    if (u.pathname === '/v0.1/servers') return json(200, mcpListBody(['io.github.owner/mcp-fetch', 'ai.smithery/srv'], 'CUR-1'));
    if (u.pathname === '/v0.1/servers/io.github.owner%2Fmcp-fetch/versions/latest') return json(200, mcpDetailBody('io.github.owner/mcp-fetch'));
    if (u.pathname === '/plugins.json') return json(200, awesomeIndexBody);
    json(404, '{"error":"not found"}');
  });
}

/** 把 market_cache 里指定 key 的 fetched_at 拨回过去（模拟 TTL 过期，不污染生产接口） */
function ageCache(keyLike: string, ageMs: number): void {
  db.prepare('UPDATE market_cache SET fetched_at = fetched_at - ? WHERE key LIKE ?').run(ageMs, keyLike);
}

beforeAll(async () => {
  fx = await Fixture.start();
  defaultRoutes();
  db = openDb(':memory:');
  // 客户端级短超时（300ms）：挂起用例不必等真 10s；生产默认 10s 在 client 常量
  cache = new MarketCache(db, new MarketClient(rewriteFetch(fx.url), { timeoutMs: 300 }));
  clawhub = new ClawHubSource(cache);
  registry = new McpRegistrySource(cache);
  awesome = new AwesomeDshSource(cache);
});
afterAll(async () => { db?.close(); await fx?.close(); });
afterEach(() => { defaultRoutes(); });

describe('ClawHub 适配器（搜索/详情映射）', () => {
  it('search：源字段 → MarketItem 映射（id 带源前缀 owner/slug、stats、verdict、sourceTier）', async () => {
    const page = await clawhub.search('pdf', 'skill', undefined, 2);
    expect(page.items).toHaveLength(2);
    const it0 = page.items[0];
    expect(it0.id).toBe('clawhub:owner-0/skill-0');
    expect(it0.kind).toBe('skill');
    expect(it0.name).toBe('Skill 0');
    expect(it0.author).toBe('owner-0');
    expect(it0.description).toBe('技能 0 的摘要');
    expect(it0.stats.downloads).toBe(1000);
    expect(it0.verdict).toBe('unscanned'); // 列表无扫描裁定，真实裁定在 detail/scan
    expect(it0.sourceTier).toBe('community'); // 社区上传：平台扫描≠官方背书（ClawHavoc 教训）
    expect(it0.category).toBeUndefined();
  });

  it('search：isSuspicious 条目 → verdict=warn（即便请求带了 nonSuspiciousOnly 也要如实映射）', async () => {
    const page = await clawhub.search('pdf', 'skill', undefined, 5);
    const susp = page.items.find(i => i.id === 'clawhub:owner-1/skill-3');
    expect(susp?.verdict).toBe('warn');
  });

  it('search：URL 查询串只含功能参数（q/limit/nonSuspiciousOnly，编码后的搜索词）', async () => {
    await clawhub.search('中文 技能', 'skill', undefined, 2);
    const u = new URL(fx.requests[fx.requests.length - 1].url, 'https://clawhub.ai');
    expect(u.pathname).toBe('/api/v1/search');
    expect(u.searchParams.get('q')).toBe('中文 技能');
    expect(u.searchParams.has('limit')).toBe(true);
    expect(u.searchParams.get('nonSuspiciousOnly')).toBe('true');
    expect([...u.searchParams.keys()].sort()).toEqual(['limit', 'nonSuspiciousOnly', 'q']);
  });

  it('search：kind=mcp（该源不服务）→ 空结果且零网络请求', async () => {
    const before = fx.requests.length;
    const page = await clawhub.search('x', 'mcp');
    expect(page.items).toEqual([]);
    expect(fx.requests.length).toBe(before);
  });

  it('search：空 q 本地短路（上游相关性搜索对空 q 本就返回空，不发请求）', async () => {
    const before = fx.requests.length;
    const page = await clawhub.search('', 'skill', undefined, 2);
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeUndefined();
    expect(fx.requests.length).toBe(before);
  });

  it('本地切页：上游 search 无游标 → 按偏移切页，cursor 递进到尽头消失', async () => {
    const p1 = await clawhub.search('pdf', 'skill', undefined, 2);
    expect(p1.items.map(i => i.id)).toEqual(['clawhub:owner-0/skill-0', 'clawhub:owner-1/skill-1']);
    expect(p1.cursor).toBe('2');
    const p2 = await clawhub.search('pdf', 'skill', '2', 2);
    expect(p2.items.map(i => i.id)).toEqual(['clawhub:owner-0/skill-2', 'clawhub:owner-1/skill-3']);
    expect(p2.cursor).toBe('4');
    const p3 = await clawhub.search('pdf', 'skill', '4', 2);
    // fixture 的 ownerHandle=owner-${i%2}：i=4 → owner-0（原期望 owner-1 是笔误，4%2=0，见偏离清单）
    expect(p3.items.map(i => i.id)).toEqual(['clawhub:owner-0/skill-4']);
    expect(p3.cursor).toBeUndefined();
  });

  it('详情：detail+scan 双取，README 取 skill.description（SKILL.md 全文），verdict 从 scan 裁定映射', async () => {
    const d = await clawhub.detail('clawhub:owner-0/skill-0');
    expect(d.item.id).toBe('clawhub:owner-0/skill-0');
    expect(d.item.name).toBe('Skill 0');
    expect(d.item.author).toBe('owner-0');
    expect(d.readme).toContain('# SKILL.md 正文');
    expect(d.item.verdict).toBe('ok'); // scan security.status = clean
    // 两条请求都打到带 ownerHandle 消歧的端点（裸 slug 会 409 AMBIGUOUS_SKILL_SLUG）
    const detailReq = fx.requests.find(r => r.url.startsWith('/api/v1/skills/skill-0?'));
    const scanReq = fx.requests.find(r => r.url.startsWith('/api/v1/skills/skill-0/scan?'));
    expect(new URL(detailReq!.url, 'https://x').searchParams.get('ownerHandle')).toBe('owner-0');
    expect(new URL(scanReq!.url, 'https://x').searchParams.get('ownerHandle')).toBe('owner-0');
  });

  it('详情裁定映射：suspicious→warn / malicious→malicious / scan 失败→unscanned 不拖垮详情', async () => {
    fx.set((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/api/v1/skills/skill-0/scan')) return res.end(clawhubScanBody('suspicious'));
      if (req.url.startsWith('/api/v1/skills/skill-0')) return res.end(clawhubDetailBody);
      res.writeHead(404); res.end('{}');
    });
    ageCache('clawhub:scan:%', 25 * 3600 * 1000);
    expect((await clawhub.detail('clawhub:owner-0/skill-0')).item.verdict).toBe('warn');

    fx.set((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/api/v1/skills/skill-0/scan')) return res.end(clawhubScanBody('malicious'));
      if (req.url.startsWith('/api/v1/skills/skill-0')) return res.end(clawhubDetailBody);
      res.writeHead(404); res.end('{}');
    });
    ageCache('clawhub:scan:%', 25 * 3600 * 1000);
    expect((await clawhub.detail('clawhub:owner-0/skill-0')).item.verdict).toBe('malicious');

    // scan 端点 500 且无缓存 → 详情仍返回，verdict 降级 unscanned（读侧不该被扫描端点拖死）
    fx.set((req, res) => {
      if (req.url.startsWith('/api/v1/skills/skill-0/scan')) { res.writeHead(500); return res.end('boom'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(clawhubDetailBody);
    });
    db.prepare("DELETE FROM market_cache WHERE key LIKE 'clawhub:scan:%'").run();
    const d = await clawhub.detail('clawhub:owner-0/skill-0');
    expect(d.item.verdict).toBe('unscanned');
    expect(d.readme).toContain('# SKILL.md 正文');
  });
});

describe('MCP 官方注册表适配器', () => {
  it('search：servers[].server 字段映射 + 上游游标透传（metadata.nextCursor 原样返回）', async () => {
    const page = await registry.search('fetch', 'mcp', undefined, 30);
    expect(page.items).toHaveLength(2);
    const it0 = page.items[0];
    expect(it0.id).toBe('mcp-registry:io.github.owner/mcp-fetch');
    expect(it0.kind).toBe('mcp');
    expect(it0.name).toBe('Server 0'); // title 优先于反向 DNS 名
    expect(it0.author).toBe('io.github.owner'); // 命名空间即发布者线索
    expect(it0.description).toContain('mcp-fetch');
    expect(it0.verdict).toBe('unscanned'); // 注册表无扫描
    expect(it0.sourceTier).toBe('community'); // 宽进提交，仅命名验证
    expect(page.cursor).toBe('CUR-1');
    // URL：limit 与 search（编码后搜索词）
    const u = new URL(fx.requests[fx.requests.length - 1].url, 'https://x');
    expect(u.pathname).toBe('/v0.1/servers');
    expect(u.searchParams.get('search')).toBe('fetch');
    expect(u.searchParams.get('limit')).toBe('30');
  });

  it('search：cursor 透传给上游（?cursor= 原样带上）', async () => {
    await registry.search('fetch', 'mcp', 'CUR-1', 30);
    const u = new URL(fx.requests[fx.requests.length - 1].url, 'https://x');
    expect(u.searchParams.get('cursor')).toBe('CUR-1');
  });

  it('search：kind=skill（该源不服务）→ 空结果且零网络请求', async () => {
    const before = fx.requests.length;
    expect((await registry.search('x', 'skill')).items).toEqual([]);
    expect(fx.requests.length).toBe(before);
  });

  it('详情：/v0.1/servers/{name %2F 编码}/versions/latest，readme 取 description', async () => {
    const d = await registry.detail('mcp-registry:io.github.owner/mcp-fetch');
    expect(d.item.id).toBe('mcp-registry:io.github.owner/mcp-fetch');
    expect(d.item.name).toBe('Server 0');
    expect(d.readme).toContain('详情描述');
    const hit = fx.requests.some(r => r.url === '/v0.1/servers/io.github.owner%2Fmcp-fetch/versions/latest');
    expect(hit).toBe(true);
  });

  it('详情：未知条目名 → 上游 404 → 抛错（detail 是定点查询，失败要响亮）', async () => {
    const e = await errOf(registry.detail('mcp-registry:io.github.owner/no-such'));
    expect(e).toBeInstanceOf(Error);
  });
});

describe('awesome-dsh 适配器（kind 过滤）', () => {
  it('混合分类 fixture → 只有 skill 分类入列（theme 丢弃；提及 MCP 的 DSH 代码插件同样丢弃）', async () => {
    const page = await awesome.search('', 'skill', undefined, 30);
    expect(page.items.map(i => i.id).sort()).toEqual([
      'awesome-dsh:7dgroup-ai/dsh-skill-code-reviewer',
      'awesome-dsh:someone/dsh-skill-writer',
    ]);
    const it0 = page.items.find(i => i.id.startsWith('awesome-dsh:7dgroup'))!;
    expect(it0.kind).toBe('skill');
    expect(it0.name).toBe('dsh-skill-code-reviewer');
    expect(it0.author).toBe('7dgroup-ai');
    expect(it0.description).toBe('Code review skill');
    expect(it0.stats.stars).toBe(3);
    expect(it0.verdict).toBe('unscanned'); // 无上游扫描，一律 unscanned（设计 §1-4b）
    expect(it0.sourceTier).toBe('community');
    expect(it0.category).toBe('skill');
  });

  it('search：kind=mcp → 空结果（该索引无 MCP 服务器类目，2026-08-20 实抓裁定）', async () => {
    expect((await awesome.search('', 'mcp')).items).toEqual([]);
  });

  it('search：本地按名称/描述过滤（中英文不区分大小写）', async () => {
    const page = await awesome.search('写作', 'skill', undefined, 30);
    expect(page.items.map(i => i.id)).toEqual(['awesome-dsh:someone/dsh-skill-writer']);
    const en = await awesome.search('code review', 'skill', undefined, 30);
    expect(en.items.map(i => i.id)).toEqual(['awesome-dsh:7dgroup-ai/dsh-skill-code-reviewer']);
  });

  it('本地切页：偏移游标递进，尽头消失', async () => {
    const p1 = await awesome.search('', 'skill', undefined, 1);
    expect(p1.items).toHaveLength(1);
    expect(p1.cursor).toBe('1');
    const p2 = await awesome.search('', 'skill', '1', 1);
    expect(p2.items).toHaveLength(1);
    expect(p2.cursor).toBeUndefined();
  });

  it('详情：从索引取条目，readme 汇合双语描述；verdict=unscanned', async () => {
    const d = await awesome.detail('awesome-dsh:7dgroup-ai/dsh-skill-code-reviewer');
    expect(d.item.name).toBe('dsh-skill-code-reviewer');
    expect(d.readme).toContain('Code review skill');
    expect(d.readme).toContain('代码审查技能');
    expect(d.item.verdict).toBe('unscanned');
  });

  it('ETag/304：过期后条件请求命中 304 → 沿用缓存正文且只刷 fetched_at（不再整取）', async () => {
    await awesome.search('', 'skill', undefined, 30); // 首取 200（记 etag）
    const reqsAfterFirst = fx.requests.filter(r => r.url === '/plugins.json').length;
    expect(reqsAfterFirst).toBe(1);
    ageCache('awesome-dsh:%', 16 * 60 * 1000); // TTL 15 分钟已过
    const page = await awesome.search('', 'skill', undefined, 30); // 条件请求
    expect(page.items).toHaveLength(2);
    const condReq = fx.requests.filter(r => r.url === '/plugins.json').pop()!;
    expect(condReq.headers['if-none-match']).toBeTruthy();
    expect(fx.requests.filter(r => r.url === '/plugins.json').length).toBe(2); // 只多了一条条件请求
    expect(page.stale).toBeFalsy();
  });
});

describe('缓存表行为（TTL 软过期 + 降级）', () => {
  /** 各例自管缓存状态（前例可能暖过缓存）：统一先清 awesome 键再构造所需状态 */
  const clearAwesome = () => db.prepare("DELETE FROM market_cache WHERE key LIKE 'awesome-dsh:%'").run();

  it('未过期直接命中：第二次调用零网络请求', async () => {
    clearAwesome();
    const before = fx.requests.length;
    await awesome.search('', 'skill', undefined, 30); // 未过期缓存不存在 → 发一次网络
    const mid = fx.requests.length;
    expect(mid).toBe(before + 1);
    await awesome.search('', 'skill', undefined, 30); // TTL 内 → 缓存命中零网络（性能纪律）
    expect(fx.requests.length).toBe(mid);
  });

  it('HTTP 500 且缓存已过期 → 降级返回过期缓存并带 stale:true', async () => {
    clearAwesome();
    await awesome.search('', 'skill', undefined, 30); // 暖缓存
    ageCache('awesome-dsh:%', 16 * 60 * 1000); // TTL 15 分钟已过
    fx.set((_req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('upstream boom'); });
    const page = await awesome.search('', 'skill', undefined, 30);
    expect(page.stale).toBe(true);
    expect(page.items).toHaveLength(2); // 旧数据还在
  });

  it('网络挂起（超时）且缓存已过期 → 降级返回 stale 缓存', async () => {
    clearAwesome();
    await awesome.search('', 'skill', undefined, 30); // 暖缓存（此时路由还是默认）
    ageCache('awesome-dsh:%', 16 * 60 * 1000);
    fx.set((_req, res) => { /* 永不应答：源故障 */ });
    const page = await awesome.search('', 'skill', undefined, 30);
    expect(page.stale).toBe(true);
    expect(page.items).toHaveLength(2);
  });

  it('无缓存且 HTTP 500 → 抛错（无旧数据可降级时失败要响亮，聚合层兜底）', async () => {
    clearAwesome();
    fx.set((_req, res) => { res.writeHead(500); res.end('boom'); });
    const e = await errOf(awesome.search('', 'skill', undefined, 30));
    expect(e).toBeInstanceOf(Error);
  });

  it('响应体积超限（截断）按失败处理：有缓存降级 stale，无缓存抛错', async () => {
    clearAwesome();
    await awesome.search('', 'skill', undefined, 30); // 暖缓存
    ageCache('awesome-dsh:%', 16 * 60 * 1000);
    fx.set((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(3 * 1024 * 1024)); // 列表上限 2MB
    });
    const page = await awesome.search('', 'skill', undefined, 30);
    expect(page.stale).toBe(true);
  });
});
