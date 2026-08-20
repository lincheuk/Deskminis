/** G1 市场读侧 RPC 例（设计稿 §6）：market.sources.list / market.search / market.detail 走通，
 *  search 聚合分页边界（每页 ≤30、跨页不重叠、游标透传）、kind 路由（skill 双源聚合 / mcp 单源）、
 *  参数校验（非法 kind / 坏游标 / 未知源前缀拒绝）。
 *  隔离方式：DESKMINIS_MARKET_FIXTURE_URL 把白名单域名请求重写到本地 node:http fixture
 *  （白名单闸校验的仍是生产 URL——闸在重写之前，注入不绕闸）。boot 模式照 skills-rpc.test.ts。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';

// ── fixture 数据 ─────────────────────────────────────────────────────────────
/** clawhub search：q=pdf 返回 20 条（供分页边界），空 q 返回空（照实抓行为），其余返回 2 条 */
const clawhubSearch = (q: string) => JSON.stringify({
  results: (q === 'pdf' ? Array.from({ length: 20 }, (_, i) => i) : q === '' ? [] : [0, 1]).map((i) => ({
    slug: `skill-${i}`,
    displayName: `Skill ${i}`,
    summary: `技能 ${i} 的摘要`,
    downloads: 1000 + i,
    ownerHandle: `owner-${i % 2}`,
    native: { skill: { isSuspicious: false, stats: { downloads: 1000 + i, stars: 10 + i } } },
  })),
});
const clawhubDetail = JSON.stringify({
  skill: {
    slug: 'skill-0', displayName: 'Skill 0', summary: '技能 0 的摘要',
    description: '# SKILL.md 正文（fixture）', stats: { downloads: 1000, stars: 10 }, topics: ['tool'],
  },
  latestVersion: { version: '1.0.0' }, metadata: null,
  owner: { handle: 'owner-0', displayName: 'Owner Zero' }, moderation: null,
});
const clawhubScan = JSON.stringify({
  skill: { slug: 'skill-0' }, version: { version: '1.0.0' }, moderation: null,
  security: { status: 'clean', hasScanResult: true, checkedAt: 1, sha256hash: 'abc' },
});
const mcpList = JSON.stringify({
  servers: [
    { server: { name: 'io.github.owner/mcp-fetch', title: 'Fetch', description: '抓网页', version: '1.0.0' }, _meta: {} },
    { server: { name: 'ai.smithery/srv', title: 'Srv', description: '服务', version: '1.0.0' }, _meta: {} },
  ],
  metadata: { nextCursor: 'CUR-RPC', count: 2 },
});
const mcpDetail = JSON.stringify({
  server: { name: 'io.github.owner/mcp-fetch', title: 'Fetch', description: '抓网页的 MCP 服务器', version: '2.0.0' },
  _meta: {},
});
const awesomeIndex = JSON.stringify({
  name: 'awesome-dsh-plugin', count: 3,
  plugins: [
    {
      name: 'dsh-skill-code-reviewer', owner: '7dgroup-ai', url: 'https://github.com/7dgroup-ai/x',
      page: 'https://awesome-dsh-plugin.com/p/x/', category: 'skill',
      description: { en: 'Code review skill', zh: '代码审查技能' },
      npm: null, stars: 3, downloads: 12, install: 'dsh plugin add x', added: '2026-08-17',
    },
    {
      name: 'dsh-skill-writer', owner: 'someone', url: 'https://github.com/someone/y',
      page: 'https://awesome-dsh-plugin.com/p/y/', category: 'skill',
      description: { en: 'Writing skill', zh: '写作技能' },
      npm: null, stars: 5, downloads: 30, install: 'dsh plugin add y', added: '2026-08-16',
    },
    {
      name: 'aurora-theme-clone', owner: 'themers', url: 'https://github.com/themers/z',
      page: 'https://awesome-dsh-plugin.com/p/z/', category: 'theme',
      description: { en: 'A theme', zh: '一个主题' },
      npm: 't', stars: 9, downloads: 99, install: 'dsh plugin add z', added: '2026-08-15',
    },
  ],
});

interface Boot {
  port: number;
  authToken: string;
  dataDir: string;
  close(): Promise<void>;
}

let fixtureServer: Server;
let fixtureUrl: string;
let boot: Boot | undefined;
let ws: WebSocket | undefined;

function rpcCall(method: string, params?: unknown): Promise<any> {
  return new Promise((res) => {
    const id = Math.random().toString(36).slice(2);
    const onMsg = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.id === id) { ws!.off('message', onMsg); res(msg); }
    };
    ws!.on('message', onMsg);
    ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

beforeAll(async () => {
  // 本地 fixture：三源端点共用一个 server（路径不冲突：/api/v1/* /v0.1/* /plugins.json）
  fixtureServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'https://fixture');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/.well-known/clawhub.json') return res.end('{"apiBase":"https://clawhub.ai"}');
    if (u.pathname === '/api/v1/search') return res.end(clawhubSearch(u.searchParams.get('q') ?? ''));
    if (u.pathname === '/api/v1/skills/skill-0/scan') return res.end(clawhubScan);
    if (u.pathname === '/api/v1/skills/skill-0') return res.end(clawhubDetail);
    if (u.pathname === '/v0.1/servers') return res.end(mcpList);
    if (u.pathname === '/v0.1/servers/io.github.owner%2Fmcp-fetch/versions/latest') return res.end(mcpDetail);
    if (u.pathname === '/plugins.json') return res.end(awesomeIndex);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((res) => fixtureServer.listen(0, '127.0.0.1', res));
  fixtureUrl = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;

  // 隔离注入口：市场客户端把白名单域名重写到本地 fixture（闸仍校验生产 URL）
  process.env.DESKMINIS_MARKET_FIXTURE_URL = fixtureUrl;
  process.env.DESKMINIS_TEST = '1';
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-market-rpc-'));
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  boot = { ...srv, dataDir, close: srv.close };
  ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?token=${encodeURIComponent(srv.authToken)}`);
  await new Promise<void>((res, rej) => { ws!.on('open', () => res()); ws!.on('error', rej); });
});

afterAll(async () => {
  delete process.env.DESKMINIS_MARKET_FIXTURE_URL;
  delete process.env.DESKMINIS_TEST;
  ws?.close();
  await boot?.close();
  await new Promise<void>((res) => fixtureServer.close(() => res()));
});

describe('market.sources.list', () => {
  it('返回三源清单：id/tier/kinds 齐全且全部可达', async () => {
    const r = (await rpcCall('market.sources.list', {})).result;
    const ids = r.sources.map((s: any) => s.id).sort();
    expect(ids).toEqual(['awesome-dsh', 'clawhub', 'mcp-registry']);
    for (const s of r.sources) {
      expect(s.available).toBe(true);      // G1 三源全部实抓可用（无 B 计划占位）
      expect(s.reachable).toBe('ok');      // fixture 探活成功
      expect(typeof s.name).toBe('string');
      expect(Array.isArray(s.kinds)).toBe(true);
    }
  });
});

describe('market.search', () => {
  it('kind=skill q=pdf：聚合分页——首页 ≤30 条、翻页不重叠、并集恰为上游全量、游标到尽头消失', async () => {
    const p1 = (await rpcCall('market.search', { kind: 'skill', q: 'pdf' })).result;
    expect(p1.items.length).toBe(15); // skill 双源 → 每源配额 ceil(30/2)=15；awesome 无 pdf 匹配
    expect(p1.items.every((i: any) => i.id.startsWith('clawhub:'))).toBe(true);
    expect(p1.cursor).toBeTruthy();

    const p2 = (await rpcCall('market.search', { kind: 'skill', q: 'pdf', cursor: p1.cursor })).result;
    expect(p2.items.length).toBe(5);
    expect(p2.cursor).toBeUndefined(); // 上游 20 条取尽

    const ids1 = p1.items.map((i: any) => i.id);
    const ids2 = p2.items.map((i: any) => i.id);
    expect(new Set([...ids1, ...ids2]).size).toBe(20);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('kind=skill q=review：双源聚合在同一页（clawhub + awesome 前缀并存）', async () => {
    const r = (await rpcCall('market.search', { kind: 'skill', q: 'review' })).result;
    const prefixes = new Set(r.items.map((i: any) => i.id.split(':')[0]));
    expect(prefixes.has('clawhub')).toBe(true);
    expect(prefixes.has('awesome-dsh')).toBe(true);
    expect(r.items.length).toBeLessThanOrEqual(30);
    // awesome-dsh 的 theme 分类条目绝不出现（kind 过滤）
    expect(r.items.some((i: any) => i.id.includes('aurora-theme-clone'))).toBe(false);
  });

  it('kind=skill q=空：ClawHub 空 q 短路，awesome 全量入列（theme 仍被过滤）', async () => {
    const r = (await rpcCall('market.search', { kind: 'skill', q: '' })).result;
    expect(r.items.length).toBe(2);
    expect(r.items.every((i: any) => i.id.startsWith('awesome-dsh:'))).toBe(true);
  });

  it('kind=mcp q=fetch：单源路由 + 上游游标透传', async () => {
    const r = (await rpcCall('market.search', { kind: 'mcp', q: 'fetch' })).result;
    expect(r.items.every((i: any) => i.id.startsWith('mcp-registry:'))).toBe(true);
    expect(r.cursor).toBeTruthy();
    // 第二页把聚合游标传回（mcp-registry 是唯一源，游标即上游游标）
    const p2 = (await rpcCall('market.search', { kind: 'mcp', q: 'fetch', cursor: r.cursor })).result;
    expect(Array.isArray(p2.items)).toBe(true);
  });

  it('非法 kind / 坏游标 → 报错', async () => {
    expect((await rpcCall('market.search', { kind: 'plugin', q: 'x' })).error).toBeTruthy();
    expect((await rpcCall('market.search', { kind: 'skill', q: 'x', cursor: '这不是游标' })).error).toBeTruthy();
  });
});

describe('market.detail', () => {
  it('clawhub 条目：README 与 scan 裁定（clean → ok）', async () => {
    const r = (await rpcCall('market.detail', { id: 'clawhub:owner-0/skill-0' })).result;
    expect(r.item.id).toBe('clawhub:owner-0/skill-0');
    expect(r.item.kind).toBe('skill');
    expect(r.readme).toContain('# SKILL.md 正文（fixture）');
    expect(r.item.verdict).toBe('ok');
  });

  it('mcp-registry 条目：detail 走 versions/latest', async () => {
    const r = (await rpcCall('market.detail', { id: 'mcp-registry:io.github.owner/mcp-fetch' })).result;
    expect(r.item.kind).toBe('mcp');
    expect(r.readme).toContain('抓网页的 MCP 服务器');
    expect(r.item.verdict).toBe('unscanned');
  });

  it('awesome-dsh 条目：verdict=unscanned + tier=community（无上游扫描）', async () => {
    const r = (await rpcCall('market.detail', { id: 'awesome-dsh:7dgroup-ai/dsh-skill-code-reviewer' })).result;
    expect(r.item.verdict).toBe('unscanned');
    expect(r.item.sourceTier).toBe('community');
    expect(r.readme).toContain('Code review skill');
  });

  it('未知源前缀 / 缺 id → 报错', async () => {
    expect((await rpcCall('market.detail', { id: 'unknown:x' })).error).toBeTruthy();
    expect((await rpcCall('market.detail', {})).error).toBeTruthy();
  });
});
