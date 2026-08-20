/** G2 市场安装链路（设计稿 §3/§4/§7）：installPlan（确认卡数据）/ install（执行）/ installed（双向核对）。
 *  安全闸全套（§4 安全核心）：
 *  - verdict 硬阻断：install 与 installPlan 都在服务端重取 detail 复核裁定（渲染进程传参一律不信）；
 *    malicious 直接 throw——本模块在接口上不存在任何跳过裁定的参数（ClawHavoc 教训），
 *    多传的未知键一律无视，行为不因多余参数而改变；
 *  - install 只接受源内条目 id（源前缀:条目），任意 URL 一律拒——手动导入走 skills.import /
 *    MCP 设置页表单，与市场面隔离（设计稿 §3）；
 *  - stdio 白名单闸（§1-6）：npx/uvx/docker + 桥随包 node（与 bridge/diagnostics 同一
 *    resolveBridgeNode 结果全等才认）；拦 npx -c / npx --call 逃逸形态与任意路径形态命令。
 *    白名单外命令的条目 plan 标 manualOnly（UI 显示「需手动配置」不给一键装），install 拒绝。
 *    args 数组原样传 spawn——既有 MCP spawn 纪律是 shell:false（mcp/stdio.ts），本就无 shell
 *    展开，闸不做 args 改写、只拦逃逸形态；
 *  - env 反向锚：MCP env 值只能来自本次 install 的 env 参数（确认卡收集），且只收注册表
 *    声明过的键——注册表数据里出现的任何 env 值（environmentVariables[].value、
 *    packages[].env）绝不带入 servers.json；
 *  - 技能安装零自动执行：下载 → 复用 SkillImporter（zip / github-url kind，走既有进度广播）
 *    → skills.changed；无进程 spawn、无市场白名单外的网络外呼。
 *  provenance 落 market_installs（MIGRATIONS[7]，纯追加）：供 installed 双向核对与 G4 更新检查。 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { MarketClient } from './client';
import type { MarketItem, MarketKind, MarketSource } from './types';
import { unzipToMemory, type ImportKind, type SkillImporter } from '../skills/importer';
import type { SkillStore } from '../skills/store';
import type { McpServersStore } from '../mcp/config';

/** ClawHub 安装物端点（2026-08-20 实抓 g2-dl2.txt）：GET /api/v1/download?slug=&ownerHandle=
 *  → 200 application/zip（attachment; filename="slug-version.zip"，根层 SKILL.md）。 */
const CLAWHUB_BASE = 'https://clawhub.ai';
/** 安装物下载预算：技能 zip 实抓 3.8KB；32MB 是宽裕的硬闸，超限即断不落半截。 */
const DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
/** SkillImporter 后台任务等待上限：zip 本地解压毫秒级；github-url 多文件逐个拉，给足余量。 */
const IMPORT_TIMEOUT_MS = 120_000;

// ── stdio 白名单闸（表驱动纯函数，§1-6）─────────────────────────────────────────

export interface StdioWhitelistOptions {
  /** 桥随包 node 的解析结果（bridge/server.ts resolveBridgeNode——与 diagnostics 同源）。 */
  bridgeNodePath?: string;
}
export interface StdioWhitelistResult { ok: boolean; reason?: string }

/** 允许的裸命令集合：包执行器三类。桥 node 是唯一允许的路径形态（见下）。 */
const STDIO_COMMAND_ALLOWLIST: readonly string[] = ['npx', 'uvx', 'docker'];

/** stdio 启动命令白名单闸：npx/uvx/docker 裸命令放行；桥 node 与 resolveBridgeNode 结果
 *  全等才放行（仿冒路径不认）；绝对路径 / 含路径分隔符的任意二进制一律拦。 */
export function checkStdioWhitelist(command: string, args: string[], opts?: StdioWhitelistOptions): StdioWhitelistResult {
  // 桥 node 是唯一合法的路径形态命令：全等比对，不做前后缀匹配
  if (opts?.bridgeNodePath && command === opts.bridgeNodePath) return { ok: true };
  if (command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command)) {
    return { ok: false, reason: `stdio 命令不允许路径形态（仅裸命令 npx/uvx/docker 或桥 node）: ${command}` };
  }
  if (STDIO_COMMAND_ALLOWLIST.includes(command)) {
    // npx 的 shell 逃逸形态（goose 精确拦截成例）：-c/--call 与 --call= 等号连写一律拦
    const escape = args.find(a => a === '-c' || a === '--call' || a.startsWith('--call='));
    if (command === 'npx' && escape) {
      return { ok: false, reason: `npx 的 ${escape} 是 shell 逃逸形态，已拦截` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `stdio 命令不在白名单（npx/uvx/docker/桥 node）: ${command}` };
}

// ── MCP 注册表详情字段（2026-08-20 实抓 g2-probe-run.txt）─────────────────────

interface RegistryEnvVar { name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }
interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string };
  runtimeArguments?: Array<{ value?: string; type?: string }>;
  environmentVariables?: RegistryEnvVar[];
}
interface RegistryServerDetail {
  name?: string;
  packages?: RegistryPackage[];
  remotes?: Array<{ type?: string; url?: string }>;
}

// ── 对外数据形态 ──────────────────────────────────────────────────────────────

/** 确认卡 env 声明（§4-5）：只带键名与说明——值一律本地收集，绝无上游值。 */
export interface MarketEnvDecl {
  name: string;
  description: string;
  required: boolean;
  /** 只有真密标才带（缺席即非密）——确认卡据此走密文输入。 */
  isSecret?: true;
}

/** market.installPlan 返回（§4 确认卡数据全项）：来源与层级、将落盘的文件清单或完整启动
 *  命令（command+args 原样）、服务端重取的 verdict、gating、MCP env 需求。 */
export interface MarketInstallPlan {
  id: string;
  kind: MarketKind;
  source: { id: string; name: string; tier: 'official' | 'community' };
  name: string;
  /** 上游安全裁定（服务端重取——不信任渲染进程传参）。 */
  verdict: MarketItem['verdict'];
  /** 技能：将落盘的文件清单（zip 根层必含 SKILL.md；github-url 链路无逐文件清单可预告）。 */
  files?: string[];
  /** 安装物内容哈希（技能=下载字节自算 sha256；确认卡 hash 短串数据源）。 */
  contentHash?: string;
  /** MCP：完整启动命令（command+args 原样）。 */
  command?: { command: string; args: string[] };
  /** MCP：远端形态时的服务 URL。 */
  url?: string;
  /** MCP：servers.json 条目名。 */
  serverName?: string;
  /** MCP：env 需求（只带键名与说明，绝无值）。 */
  env?: MarketEnvDecl[];
  /** gating（§4-4）：必填 env 未收集到的键、启动命令二进制缺失。 */
  gating?: { envMissing?: string[]; binsMissing?: string[] };
  /** 白名单外 stdio 命令：UI 显示「需手动配置」，不给一键装（§1-6）。 */
  manualOnly?: true;
}

export interface MarketInstallResult {
  ok: true;
  kind: MarketKind;
  id: string;
  /** 技能 id（SkillStore）或 MCP server 名（servers.json）。 */
  localRef: string;
}

export interface MarketInstalledItem {
  id: string;
  kind: MarketKind;
  localRef: string;
  contentHash?: string;
  installedAt: number;
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ParsedItemId { full: string; prefix: string; source: MarketSource; rest: string }

/** id 解析（install / installPlan 共用）：必须是「源前缀:条目」且前缀在源清单内。
 *  任意 URL（含白名单域名的 URL）一律拒——市场面与手动导入面隔离（§3）。 */
function parseItemId(raw: unknown, sources: MarketSource[]): ParsedItemId {
  if (typeof raw !== 'string' || raw === '') throw new Error('缺少市场条目 id');
  if (raw.includes('://')) {
    throw new Error('install 只接受源内条目 id（源前缀:条目），不接受 URL——手动导入请走 skills.import 或 MCP 设置页');
  }
  const idx = raw.indexOf(':');
  if (idx <= 0) throw new Error(`非法市场条目 id（应为 源前缀:条目）: ${raw}`);
  const prefix = raw.slice(0, idx);
  const source = sources.find(s => s.id === prefix);
  if (!source) throw new Error(`未知市场源前缀: ${prefix}`);
  const rest = raw.slice(idx + 1);
  if (rest === '') throw new Error(`非法市场条目 id（前缀后为空）: ${raw}`);
  return { full: raw, prefix, source, rest };
}

/** 注册表 env 声明 → 确认卡形态：只取键名/说明/必填/密标；value 等任何值字段一律丢弃。 */
function envDeclsOf(pkg: RegistryPackage | undefined): MarketEnvDecl[] {
  const out: MarketEnvDecl[] = [];
  for (const v of pkg?.environmentVariables ?? []) {
    if (typeof v?.name !== 'string' || v.name === '') continue;
    const d: MarketEnvDecl = {
      name: v.name,
      description: typeof v.description === 'string' ? v.description : '',
      required: v.isRequired === true,
    };
    if (v.isSecret === true) d.isSecret = true;
    out.push(d);
  }
  return out;
}

/** npm 包 → stdio 启动命令生成规则（g2-probe-run.txt 实抓）：
 *  command = runtimeHint（缺省 npx）；args = runtimeArguments 位置参数 + 包名；
 *  npx 保证 -y 在位（无 runtimeArguments 时即 npx -y <包名>——免交互安装）。
 *  runtimeHint 不在白名单内也原样生成——由白名单闸裁定（manualOnly），不在生成层猜。 */
function mcpCommandOf(pkg: RegistryPackage): { command: string; args: string[] } {
  const command = typeof pkg.runtimeHint === 'string' && pkg.runtimeHint !== '' ? pkg.runtimeHint : 'npx';
  const base = (pkg.runtimeArguments ?? [])
    .map(a => (a && typeof a.value === 'string' ? a.value : ''))
    .filter(v => v !== '');
  const args = [...base, pkg.identifier ?? ''];
  if (command === 'npx' && !args.includes('-y')) args.unshift('-y');
  return { command, args };
}

/** servers.json 条目名：反向 DNS 名（io.github.owner/mcp-fetch）里的 '/' 破坏键控形态 → 换 '-'。 */
function serverNameOf(detail: RegistryServerDetail, fallback: string): string {
  const name = typeof detail.name === 'string' && detail.name !== '' ? detail.name : fallback;
  return name.replaceAll('/', '-');
}

/** 启动命令二进制探测（gating §4-4 的 bins 项）：裸命令查 PATH，路径形态查存在性。
 *  探测故障不算缺失（信息项 fail-open，安装不在 bins 上硬拦——真缺时 spawn 会给「命令不存在」）。 */
function probeBinMissing(command: string): boolean {
  try {
    if (command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command)) {
      return !existsSync(command);
    }
    const r = process.platform === 'win32'
      ? spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
      : spawnSync('which', [command], { encoding: 'utf8', timeout: 3000 });
    return r.status !== 0;
  } catch {
    return false;
  }
}

/** MCP 安装形态裁定（plan 与 install 共用，单一事实源）：
 *  npm stdio 包优先（一键装，命令过白名单闸）；无则 https 远端 → streamable-http 条目；
 *  两者皆无（或命令白名单外）→ manualOnly。 */
interface McpInstallShape {
  serverName: string;
  stdio?: { pkg: RegistryPackage; command: { command: string; args: string[] }; whitelisted: boolean; denyReason?: string };
  remoteUrl?: string;
  envDecls: MarketEnvDecl[];
  manualOnly: boolean;
}

function deriveMcp(id: ParsedItemId, raw: unknown, bridgeNodePath: string | undefined): McpInstallShape {
  const detail = (raw ?? {}) as RegistryServerDetail;
  const packages = Array.isArray(detail.packages) ? detail.packages : [];
  const remotes = Array.isArray(detail.remotes) ? detail.remotes : [];
  const serverName = serverNameOf(detail, id.rest);
  const stdioPkg = packages.find(p => p?.registryType === 'npm' && p.transport?.type === 'stdio'
    && typeof p.identifier === 'string' && p.identifier !== '');
  const envDecls = envDeclsOf(stdioPkg ?? packages[0]);
  if (stdioPkg) {
    const command = mcpCommandOf(stdioPkg);
    const gate = checkStdioWhitelist(command.command, command.args, { bridgeNodePath });
    return {
      serverName,
      stdio: { pkg: stdioPkg, command, whitelisted: gate.ok, denyReason: gate.reason },
      envDecls,
      manualOnly: !gate.ok,
    };
  }
  const remote = remotes.find(r => typeof r?.url === 'string' && r.url.startsWith('https://'));
  if (remote) return { serverName, remoteUrl: remote.url, envDecls, manualOnly: false };
  return { serverName, envDecls, manualOnly: true };
}

// ── 安装器 ────────────────────────────────────────────────────────────────────

export interface MarketInstallerOptions {
  db: Database.Database;
  /** 与读侧共用的三源实例（同一份缓存与并发预算）。 */
  sources: MarketSource[];
  client: MarketClient;
  importer: SkillImporter;
  skillStore: SkillStore;
  mcpStore: McpServersStore;
  /** 桥随包 node 解析结果（白名单闸第四类命令）。 */
  bridgeNodePath?: string;
  /** 技能装成后的 skills.changed 广播钩子（index.ts 接 rpc.broadcast）。 */
  onSkillsChanged?: () => void;
}

interface InstallRow {
  item_id: string;
  kind: string;
  local_ref: string;
  content_hash: string | null;
  installed_at: number;
}

export class MarketInstaller {
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtSelect: Database.Statement;
  private readonly stmtDelete: Database.Statement;

  constructor(private readonly opts: MarketInstallerOptions) {
    // 同 item_id 重装走 upsert 覆盖（local_ref/installed_at 刷新），不双行
    this.stmtUpsert = opts.db.prepare(`INSERT INTO market_installs (item_id, kind, local_ref, content_hash, installed_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET kind=excluded.kind, local_ref=excluded.local_ref,
        content_hash=excluded.content_hash, installed_at=excluded.installed_at`);
    this.stmtSelect = opts.db.prepare(
      'SELECT item_id, kind, local_ref, content_hash, installed_at FROM market_installs WHERE kind = ? ORDER BY installed_at DESC, item_id ASC');
    this.stmtDelete = opts.db.prepare('DELETE FROM market_installs WHERE item_id = ?');
  }

  /** market.installPlan({id})：服务端组装确认卡数据（§4 全项）。
   *  verdict 服务端重取（不信任渲染进程传参）；技能 zip 真下载解包出文件清单（根层必含
   *  SKILL.md）；MCP 给完整启动命令（白名单外标 manualOnly）。 */
  async installPlan(p: { id?: unknown }): Promise<MarketInstallPlan> {
    const id = parseItemId(p.id, this.opts.sources);
    const detail = await id.source.detail(id.full); // 服务端重取（含 scan 裁定）
    const item = detail.item;
    const base: MarketInstallPlan = {
      id: id.full,
      kind: item.kind,
      source: { id: id.source.id, name: id.source.name, tier: id.source.tier },
      name: item.name,
      verdict: item.verdict,
    };
    if (item.kind === 'skill') return this.planSkill(id, base);
    return this.planMcp(id, item.raw, base);
  }

  private async planSkill(id: ParsedItemId, base: MarketInstallPlan): Promise<MarketInstallPlan> {
    if (id.prefix !== 'clawhub') {
      // awesome-dsh：GitHub 仓库整仓导入（importer github-url kind）——无逐文件清单可预告
      return base;
    }
    const m = /^clawhub:([^/]+)\/(.+)$/.exec(id.full);
    if (!m) throw new Error(`非法 clawhub 条目 id: ${id.full}`);
    const bytes = await this.downloadClawhubZip(m[1], m[2]);
    const files = [...(await unzipToMemory(bytes)).keys()].sort();
    if (!files.some(f => f.toLowerCase() === 'skill.md')) {
      throw new Error(`安装物 zip 根层缺少 SKILL.md（${id.full}）`);
    }
    return { ...base, files, contentHash: sha256Hex(bytes) };
  }

  private planMcp(id: ParsedItemId, raw: unknown, base: MarketInstallPlan): MarketInstallPlan {
    const shape = deriveMcp(id, raw, this.opts.bridgeNodePath);
    const plan: MarketInstallPlan = { ...base, serverName: shape.serverName, env: shape.envDecls };
    const gating: { envMissing?: string[]; binsMissing?: string[] } = {};
    // plan 阶段 env 尚未收集：全部必填键如实列为缺失（确认卡渲染输入框）
    const envMissing = shape.envDecls.filter(d => d.required).map(d => d.name);
    if (envMissing.length > 0) gating.envMissing = envMissing;
    if (shape.manualOnly) return { ...plan, manualOnly: true };
    if (shape.stdio) {
      plan.command = shape.stdio.command; // command+args 原样（§4-2）
      if (probeBinMissing(shape.stdio.command.command)) gating.binsMissing = [shape.stdio.command.command];
    } else if (shape.remoteUrl) {
      plan.url = shape.remoteUrl;
    }
    if (Object.keys(gating).length > 0) plan.gating = gating;
    return plan;
  }

  /** market.install({id, confirm:true, env?})：安装执行。
   *  顺序即安全语义：malicious 硬阻断 → confirm 必须显式 true → 分流执行。
   *  多传的未知键一律无视（行为不因多余参数而改变）。 */
  async install(p: { id?: unknown; confirm?: unknown; env?: unknown }): Promise<MarketInstallResult> {
    const id = parseItemId(p.id, this.opts.sources);
    const detail = await id.source.detail(id.full); // 服务端复核 verdict——重取，不信任传参
    const item = detail.item;
    if (item.verdict === 'malicious') {
      // 无论 confirm 与否、无论多传什么键，一律拦（ClawHavoc 教训：绕过通道在接口上不存在）
      throw new Error(`上游安全裁定为 malicious，安装已硬阻断（${id.full}）`);
    }
    // 安装是状态变更（§6）：一律经确认卡——confirm 必须显式 true（warn/unscanned 红字/灰字在卡上另作提示）
    if (p.confirm !== true) throw new Error('安装需要 confirm:true（经确认卡确认后调用）');
    if (item.kind === 'skill') return this.installSkill(id, item);
    return this.installMcp(id, item.raw, p.env);
  }

  private async installSkill(id: ParsedItemId, item: MarketItem): Promise<MarketInstallResult> {
    if (id.prefix === 'clawhub') {
      const m = /^clawhub:([^/]+)\/(.+)$/.exec(id.full);
      if (!m) throw new Error(`非法 clawhub 条目 id: ${id.full}`);
      const bytes = await this.downloadClawhubZip(m[1], m[2]);
      const contentHash = sha256Hex(bytes);
      // 复用 SkillImporter zip kind（走既有进度广播）；临时文件名固定 skill.zip
      //（importSource=zip:skill.zip，与手动导入同形态）。零自动执行：只落盘+入库。
      const tmpDir = mkdtempSync(join(tmpdir(), 'dm-market-dl-'));
      let localRef: string;
      try {
        const zipPath = join(tmpDir, 'skill.zip');
        writeFileSync(zipPath, bytes);
        localRef = await this.runImport('zip', zipPath);
      } finally {
        // 临时目录清理失败不影响安装结果（tmpdir 下次系统清理兜底）。
        // 注：刻意不带删失败选项——本文件不得出现该字样（G2 类型层锚：绕过通道在物理上不存在）。
        try { rmSync(tmpDir, { recursive: true }); } catch { /* 已被移走或占用 */ }
      }
      this.recordInstall(id.full, 'skill', localRef, contentHash);
      this.opts.onSkillsChanged?.();
      return { ok: true, kind: 'skill', id: id.full, localRef };
    }
    if (id.prefix === 'awesome-dsh') {
      // 索引条目只带 GitHub 仓库 URL（实抓字段 url）→ importer github-url kind
      const raw = item.raw as { url?: unknown } | undefined;
      const url = typeof raw?.url === 'string' ? raw.url : '';
      if (!/^https:\/\/(www\.)?github\.com\//.test(url)) {
        throw new Error(`awesome-dsh 条目无 GitHub 仓库 URL，需手动配置: ${id.full}`);
      }
      const localRef = await this.runImport('github-url', url);
      this.recordInstall(id.full, 'skill', localRef, undefined);
      this.opts.onSkillsChanged?.();
      return { ok: true, kind: 'skill', id: id.full, localRef };
    }
    throw new Error(`源 ${id.prefix} 不提供技能安装`);
  }

  private installMcp(id: ParsedItemId, raw: unknown, envParam: unknown): MarketInstallResult {
    const shape = deriveMcp(id, raw, this.opts.bridgeNodePath);
    // env 参数形态校验：确认卡收集的 Record<string, string>
    const provided: Record<string, string> = {};
    if (envParam !== undefined) {
      if (typeof envParam !== 'object' || envParam === null || Array.isArray(envParam)) {
        throw new Error('env 参数必须是 Record<string, string>');
      }
      for (const [k, v] of Object.entries(envParam as Record<string, unknown>)) {
        if (typeof v !== 'string') throw new Error(`env[${k}] 必须是字符串`);
        provided[k] = v;
      }
    }
    // gating 硬校验（§4-4）：必填 env 缺失 → 拒
    const missing = shape.envDecls.filter(d => d.required && provided[d.name] === undefined).map(d => d.name);
    if (missing.length > 0) throw new Error(`必填环境变量缺失: ${missing.join(', ')}`);

    let entry: Record<string, unknown>;
    let contentHash: string | undefined;
    if (shape.stdio?.whitelisted) {
      // env 反向锚：值只能来自本次 install 参数，且只收声明过的键——
      // 注册表数据里的任何 env 值（value 字段、packages[].env）绝不带入
      const env: Record<string, string> = {};
      for (const d of shape.envDecls) {
        if (provided[d.name] !== undefined) env[d.name] = provided[d.name];
      }
      entry = {
        name: shape.serverName,
        transport: 'stdio',
        command: shape.stdio.command.command,
        args: shape.stdio.command.args,
      };
      if (Object.keys(env).length > 0) entry.env = env;
      contentHash = sha256Hex(`${shape.stdio.pkg.identifier ?? ''}@${shape.stdio.pkg.version ?? ''}`);
    } else if (shape.remoteUrl) {
      entry = { name: shape.serverName, transport: 'streamable-http', url: shape.remoteUrl };
      contentHash = sha256Hex(shape.remoteUrl);
    } else {
      throw new Error(`该条目无白名单内 stdio 启动命令${shape.stdio?.denyReason ? `（${shape.stdio.denyReason}）` : ''}，需手动配置: ${id.full}`);
    }
    const saved = this.opts.mcpStore.upsert(entry); // 复用 mcp.servers.upsert 的归一与原子写
    this.recordInstall(id.full, 'mcp', saved.name, contentHash);
    return { ok: true, kind: 'mcp', id: id.full, localRef: saved.name };
  }

  /** market.installed({kind})：provenance 表 + 本体现状双向核对（§6）。
   *  表里有但本体已删（技能目录/表行没了、servers.json 条目删了）→ 视为未装并清理登记行。 */
  installed(p: { kind?: unknown }): { items: MarketInstalledItem[] } {
    const kind = p.kind;
    if (kind !== 'skill' && kind !== 'mcp') throw new Error(`非法 kind: ${String(kind)}（应为 skill 或 mcp）`);
    const rows = this.stmtSelect.all(kind) as InstallRow[];
    const mcpNames = new Set(this.opts.mcpStore.list().map(e => e.name));
    const items: MarketInstalledItem[] = [];
    for (const r of rows) {
      const alive = kind === 'skill'
        ? this.opts.skillStore.get(r.local_ref) !== undefined
        : mcpNames.has(r.local_ref);
      if (!alive) {
        this.stmtDelete.run(r.item_id); // 本体已删：登记行清理，视为未装
        continue;
      }
      items.push({
        id: r.item_id,
        kind,
        localRef: r.local_ref,
        contentHash: r.content_hash ?? undefined,
        installedAt: r.installed_at,
      });
    }
    return { items };
  }

  private async downloadClawhubZip(owner: string, slug: string): Promise<Buffer> {
    const url = `${CLAWHUB_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}&ownerHandle=${encodeURIComponent(owner)}`;
    const r = await this.opts.client.fetchBytes(url, { maxBytes: DOWNLOAD_MAX_BYTES });
    return r.bytes;
  }

  /** 等 SkillImporter 后台任务收口（导入脱离 UI 生命周期，靠轮询 status；失败/超时响亮抛错）。 */
  private async runImport(kind: ImportKind, source: string): Promise<string> {
    const { taskId } = this.opts.importer.startImport(kind, source);
    const deadline = Date.now() + IMPORT_TIMEOUT_MS;
    for (;;) {
      const t = this.opts.importer.status(taskId);
      if (!t) throw new Error('导入任务状态丢失');
      if (t.state === 'failed') throw new Error(`技能导入失败: ${t.error ?? '未知错误'}`);
      if (t.state === 'done') {
        if (t.succeeded.length === 0) {
          throw new Error(`技能导入未成功: ${t.failures.map(f => `${f.name}(${f.error})`).join('; ') || '无失败明细'}`);
        }
        return t.succeeded[0];
      }
      if (Date.now() > deadline) throw new Error('技能导入超时');
      await new Promise(r => setTimeout(r, 10));
    }
  }

  private recordInstall(itemId: string, kind: MarketKind, localRef: string, contentHash: string | undefined): void {
    this.stmtUpsert.run(itemId, kind, localRef, contentHash ?? null, Date.now());
  }
}
