/** D2 MCP 配置与存储层：servers.json 的读写与归一。
 *  本步只做配置 CRUD——不发起任何网络请求、不起子进程（连接在 D3/D4）。
 *  读写姿态对齐 ProviderStore：临时文件 + rename 原子写，手编笔误不崩 minisd 启动。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MinisPaths } from '../paths';

/** 归一后的条目内部形态。extra 收容所有未识别字段（oauth 等），
 *  写回时原样合并——与 Claude Desktop 生态互导不丢数据。 */
export interface McpServerEntry {
  name: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  note?: string;
  enabled: boolean;
  startupTimeoutSeconds?: number;
  createdAt?: string;
  updatedAt?: string;
  extra?: Record<string, unknown>;
}

/** $$NAME 引用名：NAME 形如 [A-Za-z_][A-Za-z0-9_]* */
const ENV_REF_RE = /\$\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 把字符串里所有 $$NAME 引用替换为对应环境变量值（支持嵌在中间与一串多引用）。
 * 任一变量未设置即抛错；错误信息只含引用名本身——
 * 因此先收集缺失名再替换，而不是边替换边拼结果，保证已解析值绝不进错误文本。
 */
export function resolveEnvRefs(value: string, env: Record<string, string | undefined> = process.env): string {
  const missing: string[] = [];
  for (const m of value.matchAll(ENV_REF_RE)) {
    if (env[m[1]] === undefined) missing.push(`$$${m[1]}`);
  }
  if (missing.length > 0) throw new Error(`环境变量未设置: ${[...new Set(missing)].join(', ')}`);
  return value.replace(ENV_REF_RE, (_s, n: string) => env[n] as string);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}
function asStringRecord(v: unknown): Record<string, string> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

// sse 的主流用法（独立 SSE 长连接端点）已被 streamable-http 的 POST 响应体 SSE 分支覆盖，
// 故 http / streamable-http / streamable_http / sse 四个别名一律归一为 streamable-http
const HTTP_TYPE_ALIASES = new Set(['http', 'streamable-http', 'streamable_http', 'sse']);
function isHttpAlias(v: unknown): boolean { return typeof v === 'string' && HTTP_TYPE_ALIASES.has(v); }

/** 归一时消费的键（不进 extra）；name 单独处理（键名或字段） */
const KNOWN_KEYS = new Set([
  'command', 'args', 'env', 'cwd', 'url', 'headers', 'note',
  'enabled', 'disabled', 'type', 'transport', 'startupTimeoutSeconds', 'createdAt', 'updatedAt',
]);

/** 单条解码：导入与 upsert 共用的唯一归一入口（单一事实源）。
 *  解码失败（name 空、command 是数字、既无 command 又无 url 等）返回 undefined——
 *  导入侧据此跳过该条不拖垮整文件，upsert 侧据此翻译成具体中文错误。 */
function decodeEntry(name: string, raw: Record<string, unknown>): McpServerEntry | undefined {
  if (typeof name !== 'string' || name.trim() === '') return undefined;
  if (raw.command !== undefined && typeof raw.command !== 'string') return undefined;
  if (raw.url !== undefined && typeof raw.url !== 'string') return undefined;
  const command = asString(raw.command);
  const url = asString(raw.url);
  // 判型：有 command → stdio；否则有 url → streamable-http；type 别名只在缺 command 时参与判型
  let transport: McpServerEntry['transport'] | undefined;
  if (command !== undefined) transport = 'stdio';
  else if (url !== undefined) transport = 'streamable-http';
  else if (isHttpAlias(raw.type) || isHttpAlias(raw.transport)) transport = 'streamable-http';
  if (transport === undefined) return undefined; // 既无 command 又无 url，不构成 server 定义
  if (transport === 'streamable-http' && url === undefined) return undefined;

  const entry: McpServerEntry = { name, transport, enabled: raw.disabled === true ? false : raw.enabled !== false };
  if (command !== undefined) entry.command = command;
  if (url !== undefined) entry.url = url;
  const args = asStringArray(raw.args); if (args) entry.args = args;
  const env = asStringRecord(raw.env); if (env) entry.env = env;
  const cwd = asString(raw.cwd); if (cwd !== undefined) entry.cwd = cwd;
  const headers = asStringRecord(raw.headers); if (headers) entry.headers = headers;
  const note = asString(raw.note); if (note !== undefined) entry.note = note;
  if (typeof raw.startupTimeoutSeconds === 'number') entry.startupTimeoutSeconds = raw.startupTimeoutSeconds;
  const createdAt = asString(raw.createdAt); if (createdAt) entry.createdAt = createdAt;
  const updatedAt = asString(raw.updatedAt); if (updatedAt) entry.updatedAt = updatedAt;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (k !== 'name' && !KNOWN_KEYS.has(k)) extra[k] = v;
  if (Object.keys(extra).length > 0) entry.extra = extra;
  return entry;
}

export class McpServersStore {
  private dir: string;
  private file: string;
  /** Map 天然保持插入序 → list() 与写回的键序即文件序 */
  private entries = new Map<string, McpServerEntry>();
  /** 整文件 JSON 解析失败按空配置处理（手编笔误不崩 minisd 启动），
   *  诊断字符串留在 store 上供以后的 UI 展示 */
  loadError: string | undefined;

  constructor(paths: MinisPaths) {
    this.dir = paths.globalDir('mcp-servers');
    this.file = join(this.dir, 'servers.json');
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  /** 三变体宽容导入：①标准 mcpServers 键控；③单裸条目（name=default）；②裸名字键控 map。
   *  判序依据：①有 mcpServers 对象键；③顶层自带 command/url（本身就是一个 server 定义）；
   *  其余按②处理，非对象值逐条跳过。 */
  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.loadError = `servers.json 解析失败: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (!isPlainObject(parsed)) {
      this.loadError = 'servers.json 顶层不是 JSON 对象';
      return;
    }
    const absorb = (name: string, raw: unknown): void => {
      if (!isPlainObject(raw)) return;
      const e = decodeEntry(name, raw);
      if (e) this.entries.set(e.name, e);
    };
    if (isPlainObject(parsed.mcpServers)) {
      for (const [name, raw] of Object.entries(parsed.mcpServers)) absorb(name, raw);
    } else if (typeof parsed.command === 'string' || typeof parsed.url === 'string') {
      absorb('default', parsed);
    } else {
      for (const [name, raw] of Object.entries(parsed)) absorb(name, raw);
    }
  }

  /** 原子写（对齐 ProviderStore 模式）；始终写标准形态，条目序保持插入序。
   *  extra 先铺、识别字段后盖——未识别字段原样合并，写回不丢数据。 */
  private save(): void {
    const out: Record<string, unknown> = {};
    for (const [name, e] of this.entries) {
      const o: Record<string, unknown> = { ...(e.extra ?? {}) };
      if (e.transport === 'stdio') {
        o.command = e.command;
        if (e.args) o.args = e.args;
        if (e.env) o.env = e.env;
        if (e.cwd !== undefined) o.cwd = e.cwd;
      } else {
        o.url = e.url;
        if (e.headers) o.headers = e.headers;
      }
      if (e.note !== undefined) o.note = e.note;
      // enabled 缺省 true，只在禁用时落盘——文件里看不到 enabled 就是启用
      if (!e.enabled) o.enabled = false;
      if (e.startupTimeoutSeconds !== undefined) o.startupTimeoutSeconds = e.startupTimeoutSeconds;
      if (e.createdAt) o.createdAt = e.createdAt;
      if (e.updatedAt) o.updatedAt = e.updatedAt;
      out[name] = o;
    }
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ mcpServers: out }, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /** 文件序（插入序）；返回副本，调用方改不到 store 内部状态 */
  list(): McpServerEntry[] {
    return [...this.entries.values()].map(e => ({ ...e }));
  }

  /** 与导入走同一套归一逻辑（decodeEntry 单一事实源），归一后校验：
   *  name 非空、stdio 必有 command、streamable-http 必有 url，非法抛中文 Error。
   *  新条目补 createdAt/updatedAt；更新条目只动 updatedAt，保留 createdAt 与 extra。 */
  upsert(input: Record<string, unknown>): McpServerEntry {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') throw new Error('MCP server 名称不能为空');
    const entry = decodeEntry(name, input);
    if (!entry) {
      if (input.command !== undefined && typeof input.command !== 'string') throw new Error('command 必须是字符串');
      if (input.url !== undefined && typeof input.url !== 'string') throw new Error('url 必须是字符串');
      if (typeof input.url === 'string' || isHttpAlias(input.type) || isHttpAlias(input.transport)) {
        throw new Error('streamable-http 类型必须提供 url');
      }
      throw new Error('stdio 类型必须提供 command');
    }
    const now = new Date().toISOString();
    const existing = this.entries.get(name);
    if (existing) {
      entry.createdAt = existing.createdAt;
      const merged = { ...existing.extra, ...entry.extra };
      entry.extra = Object.keys(merged).length > 0 ? merged : undefined;
    } else {
      entry.createdAt ??= now;
    }
    entry.updatedAt = now;
    this.entries.set(name, entry);
    this.save();
    return { ...entry };
  }

  remove(name: string): void {
    if (!this.entries.delete(name)) return;
    this.save();
  }

  toggle(name: string, enabled: boolean): void {
    const e = this.entries.get(name);
    if (!e) throw new Error(`MCP server 不存在: ${name}`);
    e.enabled = enabled === true;
    e.updatedAt = new Date().toISOString();
    this.save();
  }
}
