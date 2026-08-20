/** G4 市场更新检查例（设计稿 §6/§8，任务步骤 D）：checkUpdates 三源比对 + 缓存绕过 +
 *  更新流安全（更新到恶意版本硬阻断——上游把干净包更新成恶意版本正是 ClawHavoc 二次投毒
 *  主通道）+ env 保留合并（纯函数表驱动）+ provenance 刷新 + 单条目失败不拖垮。
 *  隔离方式照 market-install.test.ts：本地 node:http fixture（可变状态——测试中途切换上游
 *  内容正是更新检查的本质场景）+ fetchImpl 域名重写（白名单闸校验的仍是生产 URL）。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

// 零执行副作用探针（照 market-install.test.ts 成例）
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnProbe = vi.fn((...a: unknown[]) => {
    throw new Error(`更新检查链路不得 spawn 进程（零执行副作用锚）: ${String(a[0])}`);
  });
  return { ...actual, spawn: spawnProbe as unknown as typeof actual.spawn };
});
import { openDb } from '../src/minisd/store/db';
import { MinisPaths } from '../src/minisd/paths';
import { SkillStore } from '../src/minisd/skills/store';
import { SkillImporter } from '../src/minisd/skills/importer';
import { McpServersStore } from '../src/minisd/mcp/config';
import { MarketClient } from '../src/minisd/market/client';
import { MarketCache } from '../src/minisd/market/cache';
import { ClawHubSource } from '../src/minisd/market/clawhub';
import { McpRegistrySource } from '../src/minisd/market/mcp-registry';
import { AwesomeDshSource } from '../src/minisd/market/awesome-dsh';
import { MarketInstaller, mergeEnvForUpdate } from '../src/minisd/market/install';
import type { MarketSource } from '../src/minisd/market/types';

// ── zip 构造（照 market-install.test.ts 成例：store-only） ──
const SKILL_MD_V1 = '---\nname: market-skill\ndescription: 市场技能\nversion: 1.0.0\n---\n# Market V1\n正文一。\n';
const SKILL_MD_V2 = '---\nname: market-skill\ndescription: 市场技能\nversion: 1.1.0\n---\n# Market V2\n正文二（更新版）。\n';
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameB, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameB.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameB);
    offset += 30 + nameB.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const ZIP_V1 = buildZip([{ name: 'SKILL.md', data: Buffer.from(SKILL_MD_V1) }]);
const ZIP_V2 = buildZip([
  { name: 'SKILL.md', data: Buffer.from(SKILL_MD_V2) },
  { name: 'refs/new.md', data: Buffer.from('新增参考') },
]);
function sha256(b: Buffer | string): string { return createHash('sha256').update(b).digest('hex'); }

// ── 可变 fixture 状态（更新检查的本质：测试中途切换上游内容） ──
interface EnvDeclFx { name: string; description?: string; isRequired?: boolean; isSecret?: boolean }
const fx = {
  clawhubZip: ZIP_V1,
  clawhubLatestVersion: '1.0.0',
  clawhubScanStatus: 'clean' as string,
  failDownloadSlugs: new Set<string>(),
  registryVersion: '2.0.0',
  registryEnv: [] as EnvDeclFx[],
  requests: [] as string[],
};

const clawhubDetailBody = (slug: string) => JSON.stringify({
  skill: { slug, displayName: `Skill ${slug}`, summary: '摘要', description: '# SKILL.md 正文', stats: { downloads: 1, stars: 2 } },
  latestVersion: { version: fx.clawhubLatestVersion }, metadata: null,
  owner: { handle: 'owner-0' }, moderation: null,
});
const clawhubScanBody = (status: string) => JSON.stringify({
  skill: { slug: 'x' }, version: { version: '1.0.0' }, moderation: null,
  security: { status, hasScanResult: true, checkedAt: 1, sha256hash: 'abc' },
});
const mcpDetailBody = () => JSON.stringify({
  server: {
    name: 'io.github.owner/mcp-fetch', title: 'Fetch', description: '抓网页', version: fx.registryVersion,
    packages: [{
      registryType: 'npm', registryBaseUrl: 'https://registry.npmjs.org',
      identifier: '@scope/mcp-fetch', version: fx.registryVersion, transport: { type: 'stdio' },
      environmentVariables: fx.registryEnv,
    }],
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
  },
  _meta: {},
});
const awesomeIndex = JSON.stringify({
  name: 'awesome-dsh-plugin', count: 1,
  plugins: [{
    name: 'dsh-skill-x', owner: 'someone', url: 'https://github.com/someone/x',
    page: 'https://awesome-dsh-plugin.com/p/x/', category: 'skill',
    description: { en: 'X skill', zh: 'X 技能' }, npm: null, stars: 1, downloads: 2, install: 'dsh plugin add x', added: '2026-08-16',
  }],
});

// ── 装配 ──
interface Ctx {
  installer: MarketInstaller;
  db: Database.Database;
  skillStore: SkillStore;
  mcpStore: McpServersStore;
  root: string;
  close(): Promise<void>;
}
let fixtureServer: Server;
let fixtureUrl: string;

function rewriteFetch(log: string[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    return fetch(url.replace(/^https:\/\/[^/]+/, fixtureUrl), init);
  }) as typeof fetch;
}

/** SkillImporter 的 GitHub 探针 fetch（awesome-dsh 条目 github-url 安装链路）。 */
function githubProbeFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/someone/x/contents/') {
      return new Response(JSON.stringify([
        { name: 'SKILL.md', path: 'SKILL.md', type: 'file', download_url: 'https://raw.githubusercontent.com/someone/x/main/SKILL.md' },
      ]), { headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://raw.githubusercontent.com/someone/x/main/SKILL.md') {
      return new Response(SKILL_MD_V1);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), 'dm-mkt-upd-'));
  const db = openDb(join(root, 'minis.db'));
  const paths = new MinisPaths(root);
  const client = new MarketClient(rewriteFetch(fx.requests));
  const cache = new MarketCache(db, client);
  const sources: MarketSource[] = [
    new ClawHubSource(cache),
    new McpRegistrySource(cache),
    new AwesomeDshSource(cache),
  ];
  const skillsRoot = join(root, 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  const skillStore = new SkillStore(db);
  const importer = new SkillImporter(skillsRoot, skillStore, githubProbeFetch());
  const mcpStore = new McpServersStore(paths);
  const installer = new MarketInstaller({
    db, sources, client, importer, skillStore, mcpStore,
    bridgeNodePath: join(root, 'resources', 'bridge-node.cmd'),
  });
  return { installer, db, skillStore, mcpStore, root, close: async () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function errOf(p: Promise<unknown>): Promise<Error> {
  return (await p.catch((e) => e)) as Error;
}

beforeAll(async () => {
  fixtureServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'https://fixture');
    const json = (s: string) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(s); };
    const mSkill = /^\/api\/v1\/skills\/([^/]+)$/.exec(u.pathname);
    const mScan = /^\/api\/v1\/skills\/([^/]+)\/scan$/.exec(u.pathname);
    if (u.pathname === '/api/v1/search') return json('{"results":[]}');
    if (mSkill) return json(clawhubDetailBody(mSkill[1]));
    if (mScan) return json(clawhubScanBody(fx.clawhubScanStatus));
    if (u.pathname === '/api/v1/download') {
      const slug = u.searchParams.get('slug') ?? '';
      if (fx.failDownloadSlugs.has(slug)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"boom"}');
      }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="x.zip"' });
      return res.end(fx.clawhubZip);
    }
    if (u.pathname === '/v0.1/servers/io.github.owner%2Fmcp-fetch/versions/latest') return json(mcpDetailBody());
    if (u.pathname === '/plugins.json') return json(awesomeIndex);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((res) => fixtureServer.listen(0, '127.0.0.1', res));
  fixtureUrl = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => fixtureServer.close(() => res()));
});

/** 每例重置 fixture 状态与请求日志。 */
beforeEach(() => {
  fx.clawhubZip = ZIP_V1; fx.clawhubLatestVersion = '1.0.0'; fx.clawhubScanStatus = 'clean';
  fx.failDownloadSlugs = new Set();
  fx.registryVersion = '2.0.0';
  fx.registryEnv = [
    { name: 'FETCH_API_KEY', description: '服务密钥', isRequired: true, isSecret: true },
    { name: 'FETCH_MODE', description: '运行模式', isRequired: false },
  ];
  fx.requests = [];
});

// ── 1. env 保留合并（纯函数表驱动，任务步骤 B） ───────────────────────────────

describe('G4 mergeEnvForUpdate（env 保留合并纯函数）', () => {
  const decls = (names: string[], required: string[]) =>
    names.map(n => ({ name: n, description: '', required: required.includes(n) }));

  it('旧值保留：已填的 env 值原样带过（更新不得丢用户配置）', () => {
    const r = mergeEnvForUpdate({ A: 'x', MODE: 'fast' }, decls(['A', 'MODE'], []), {});
    expect(r.env).toEqual({ A: 'x', MODE: 'fast' });
    expect(r.needInput).toEqual([]);
  });

  it('新增必填检出：新版本声明且旧值没有的必填键 → needInput（确认卡要求补填）', () => {
    const r = mergeEnvForUpdate({ A: 'x' }, decls(['A', 'NEW_REQ'], ['NEW_REQ']), {});
    expect(r.env).toEqual({ A: 'x' });
    expect(r.needInput).toEqual(['NEW_REQ']);
  });

  it('移除的键清理：旧值有但新版本不再声明的键 → 丢弃', () => {
    const r = mergeEnvForUpdate({ A: 'x', GONE: 'z' }, decls(['A'], []), {});
    expect(r.env).toEqual({ A: 'x' });
    expect(r.env.GONE).toBeUndefined();
  });

  it('本次输入优先于旧值（用户在确认卡里改了值）', () => {
    const r = mergeEnvForUpdate({ A: 'old' }, decls(['A'], []), { A: 'new' });
    expect(r.env).toEqual({ A: 'new' });
  });

  it('无旧值（首次安装）与现行安装行为一致：必填缺失 → needInput', () => {
    const r = mergeEnvForUpdate(undefined, decls(['A'], ['A']), {});
    expect(r.env).toEqual({});
    expect(r.needInput).toEqual(['A']);
    const r2 = mergeEnvForUpdate(undefined, decls(['A'], ['A']), { A: 'v' });
    expect(r2.env).toEqual({ A: 'v' });
    expect(r2.needInput).toEqual([]);
  });
});

// ── 2. checkUpdates 三源比对 + 缓存绕过 + 失败隔离 ────────────────────────────

describe('G4 market.checkUpdates（三源比对）', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  it('ClawHub：上游 zip 字节变化 → 可更新（current=本地版本，latest=latestVersion，verdict=最新 scan）', async () => {
    const r = await ctx.installer.install({ id: 'clawhub:owner-0/alpha', confirm: true });
    fx.clawhubZip = ZIP_V2; fx.clawhubLatestVersion = '1.1.0'; fx.clawhubScanStatus = 'suspicious';
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates.length).toBe(1);
    const u = rep.updates[0];
    expect(u.id).toBe('clawhub:owner-0/alpha');
    expect(u.kind).toBe('skill');
    expect(u.name).toBe('Skill alpha');
    expect(u.current).toBe('1.0.0');   // SkillStore frontmatter 版本
    expect(u.latest).toBe('1.1.0');    // detail latestVersion
    expect(u.verdict).toBe('warn');    // 新版本 scan 裁定
    expect(rep.unsupported).toEqual([]);
    expect(rep.errors).toBe(0);
  });

  it('ClawHub：下载字节 hash 一致 → 均为最新，且不再打 detail/scan 请求（省一次往返）', async () => {
    await ctx.installer.install({ id: 'clawhub:owner-0/alpha', confirm: true });
    // 原地清空：rewriteFetch 闭包持有 makeCtx 时的数组引用，重绑定会断流
    fx.requests.length = 0;
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates).toEqual([]);
    expect(rep.errors).toBe(0);
    // 只有 download 直取（fetchBytes 不经缓存）；detail/scan 零请求
    expect(fx.requests.some(u => u.includes('/api/v1/skills/'))).toBe(false);
    expect(fx.requests.some(u => u.includes('/api/v1/download'))).toBe(true);
  });

  it('MCP registry：detail version 抬高 → 可更新（hash 比对 包名@版本 自算）', async () => {
    await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: { FETCH_API_KEY: 'v1' },
    });
    fx.registryVersion = '2.1.0';
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates.length).toBe(1);
    const u = rep.updates[0];
    expect(u.id).toBe('mcp-registry:io.github.owner/mcp-fetch');
    expect(u.kind).toBe('mcp');
    expect(u.latest).toBe('2.1.0');
    expect(u.verdict).toBe('unscanned'); // 注册表无扫描裁定
    expect(rep.errors).toBe(0);
  });

  it('MCP registry：version 一致 → 均为最新', async () => {
    await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: { FETCH_API_KEY: 'v1' },
    });
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates).toEqual([]);
    expect(rep.errors).toBe(0);
  });

  it('awesome-dsh：GitHub URL 装载无版本概念 → unsupported，且零上游请求（不猜不装样子）', async () => {
    await ctx.installer.install({ id: 'awesome-dsh:someone/dsh-skill-x', confirm: true });
    fx.requests.length = 0; // 原地清空（闭包持有数组引用）
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates).toEqual([]);
    expect(rep.unsupported).toEqual(['awesome-dsh:someone/dsh-skill-x']);
    expect(rep.errors).toBe(0);
    expect(fx.requests.length).toBe(0); // unsupported 条目不打任何上游请求
  });

  it('本体已删的登记行先清理（installed 双向核对复用）：删技能后 checkUpdates 不再报它', async () => {
    const r = await ctx.installer.install({ id: 'clawhub:owner-0/alpha', confirm: true });
    rmSync(join(ctx.root, 'skills', r.localRef), { recursive: true, force: true });
    ctx.skillStore.delete(r.localRef);
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates).toEqual([]);
    expect(rep.unsupported).toEqual([]);
    expect(rep.errors).toBe(0);
  });
});

describe('G4 checkUpdates 缓存绕过（ttlMs=0 条件请求）', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  it('detail 缓存在 24h TTL 内（刚装过）→ checkUpdates 仍真发条件请求并看到新版本', async () => {
    await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: { FETCH_API_KEY: 'v1' },
    });
    // install 已把 detail 写进缓存（TTL 24h）——此刻未过期
    fx.registryVersion = '2.1.0';
    fx.requests.length = 0; // 原地清空（闭包持有数组引用）
    const rep = await ctx.installer.checkUpdates();
    // 条件请求真的发了（detail 端点至少一次真实网络往返，不是缓存命中）
    const detailHits = fx.requests.filter(u => u.includes('/versions/latest')).length;
    expect(detailHits).toBeGreaterThanOrEqual(1);
    // 且看到的是新版本（缓存没有挡住 24h 内的更新）
    expect(rep.updates.length).toBe(1);
    expect(rep.updates[0].latest).toBe('2.1.0');
  });
});

describe('G4 单条目失败不拖垮整体', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  it('一条下载 500 → errors 计数、其余条目照常比对', async () => {
    await ctx.installer.install({ id: 'clawhub:owner-0/alpha', confirm: true });
    await ctx.installer.install({ id: 'clawhub:owner-0/beta', confirm: true });
    await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: { FETCH_API_KEY: 'v1' },
    });
    fx.clawhubZip = ZIP_V2; fx.clawhubLatestVersion = '1.1.0';
    fx.failDownloadSlugs = new Set(['beta']);
    const rep = await ctx.installer.checkUpdates();
    // alpha 照常检出可更新；beta 下载失败静默跳过并计数；mcp 一致为最新
    expect(rep.updates.map(u => u.id)).toEqual(['clawhub:owner-0/alpha']);
    expect(rep.errors).toBe(1);
  });
});

// ── 3. Update 流（install 原路复用 + 安全闸一分不少） ─────────────────────────

describe('G4 Update 流（installPlan/install 原路复用）', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  it('更新到恶意版本硬阻断：install 层 throw，本体与 provenance 均不变（ClawHavoc 二次投毒主通道）', async () => {
    const r1 = await ctx.installer.install({ id: 'clawhub:owner-0/alpha', confirm: true });
    const before = ctx.installer.installed({ kind: 'skill' }).items[0];
    fx.clawhubZip = ZIP_V2; fx.clawhubLatestVersion = '1.1.0'; fx.clawhubScanStatus = 'malicious';
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates[0].verdict).toBe('malicious');
    // Update 就是 install：恶意新版本在安装层照拦（确认卡 confirm 也救不了）
    const e = await errOf(ctx.installer.install({ id: 'clawhub:owner-0/alpha', confirm: true }));
    expect(e.message).toContain('malicious');
    // 本体没被更新（还是 V1），provenance hash 没被刷新
    expect(readFileSync(join(ctx.root, 'skills', r1.localRef, 'SKILL.md'), 'utf8')).toContain('Market V1');
    const after = ctx.installer.installed({ kind: 'skill' }).items[0];
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.installedAt).toBe(before.installedAt);
  });

  it('技能更新：同 id 覆盖重装（无 -2 后缀）+ provenance 刷新（content_hash/installed_at 变化）+ SkillStore installed_at 保留', async () => {
    const r1 = await ctx.installer.install({ id: 'clawhub:owner-0/alpha', confirm: true });
    const skillBefore = ctx.skillStore.get(r1.localRef)!;
    const provBefore = ctx.installer.installed({ kind: 'skill' }).items[0];
    fx.clawhubZip = ZIP_V2; fx.clawhubLatestVersion = '1.1.0';
    await new Promise(r => setTimeout(r, 15)); // 确保 installed_at 时间戳可区分
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates.length).toBe(1);
    const r2 = await ctx.installer.install({ id: 'clawhub:owner-0/alpha', confirm: true });
    // 同 id 覆盖：不产生 -2 后缀的新技能
    expect(r2.localRef).toBe(r1.localRef);
    expect(ctx.skillStore.list().length).toBe(1);
    // 文件内容已更新（含新增文件）
    expect(readFileSync(join(ctx.root, 'skills', r1.localRef, 'SKILL.md'), 'utf8')).toContain('Market V2');
    expect(readFileSync(join(ctx.root, 'skills', r1.localRef, 'refs', 'new.md'), 'utf8')).toBe('新增参考');
    // provenance 刷新：新 content_hash 与 installed_at
    const provAfter = ctx.installer.installed({ kind: 'skill' }).items[0];
    expect(provAfter.contentHash).toBe(sha256(ZIP_V2));
    expect(provAfter.contentHash).not.toBe(provBefore.contentHash);
    expect(provAfter.installedAt).toBeGreaterThan(provBefore.installedAt);
    // SkillStore 行保留 installed_at（重装覆盖不重置入库时间）
    expect(ctx.skillStore.get(r1.localRef)!.installedAt).toBe(skillBefore.installedAt);
    expect(ctx.skillStore.get(r1.localRef)!.version).toBe('1.1.0');
    // 更新后已为最新：再查无更新
    expect((await ctx.installer.checkUpdates()).updates).toEqual([]);
  });

  it('MCP 更新 env 保留：旧值原样保留 + 新增必填检出（plan 提示补填）+ 移除的键清理', async () => {
    await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true,
      env: { FETCH_API_KEY: 'v1', FETCH_MODE: 'fast' },
    });
    // 新版本：抬 version + 新增必填 NEW_REQ
    fx.registryVersion = '2.1.0';
    fx.registryEnv = [
      { name: 'FETCH_API_KEY', description: '服务密钥', isRequired: true, isSecret: true },
      { name: 'FETCH_MODE', description: '运行模式', isRequired: false },
      { name: 'NEW_REQ', description: '新增必填', isRequired: true },
    ];
    const rep = await ctx.installer.checkUpdates();
    expect(rep.updates.length).toBe(1);
    // 确认卡：已存的键不再列为缺失（envPrefilled），只有新增必填要求补填
    const plan = await ctx.installer.installPlan({ id: 'mcp-registry:io.github.owner/mcp-fetch' });
    expect(plan.gating?.envMissing).toEqual(['NEW_REQ']);
    expect(plan.envPrefilled).toEqual(['FETCH_API_KEY', 'FETCH_MODE']);
    // 用户只补填新增必填：旧值（含密钥）原样保留
    const r = await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: { NEW_REQ: 'n' },
    });
    expect(r.localRef).toBe('io.github.owner-mcp-fetch');
    const entry = ctx.mcpStore.list().find(e => e.name === r.localRef)!;
    expect(entry.env).toEqual({ FETCH_API_KEY: 'v1', FETCH_MODE: 'fast', NEW_REQ: 'n' });
    // provenance 刷新为新版本 hash
    const prov = ctx.installer.installed({ kind: 'mcp' }).items[0];
    expect(prov.contentHash).toBe(sha256('@scope/mcp-fetch@2.1.0'));
    // 再升一版：新版本移除 FETCH_API_KEY/NEW_REQ → 更新后这两个键清理，MODE 保留
    fx.registryVersion = '2.2.0';
    fx.registryEnv = [{ name: 'FETCH_MODE', description: '运行模式', isRequired: false }];
    await ctx.installer.install({ id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: {} });
    const entry2 = ctx.mcpStore.list().find(e => e.name === 'io.github.owner-mcp-fetch')!;
    expect(entry2.env).toEqual({ FETCH_MODE: 'fast' });
  });

  it('MCP 更新必填缺失仍硬拦：新增必填未补填 → install 拒绝', async () => {
    await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: { FETCH_API_KEY: 'v1' },
    });
    fx.registryVersion = '2.1.0';
    fx.registryEnv = [
      { name: 'FETCH_API_KEY', description: '服务密钥', isRequired: true, isSecret: true },
      { name: 'NEW_REQ', description: '新增必填', isRequired: true },
    ];
    const e = await errOf(ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: {},
    }));
    expect(e.message).toContain('NEW_REQ');
  });
});
