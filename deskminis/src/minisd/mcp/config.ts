/** D2 MCP 配置与存储层：servers.json 的读写与归一。
 *  本步只做配置 CRUD——不发起任何网络请求、不起子进程（连接在 D3/D4）。
 *  读写姿态对齐 ProviderStore：临时文件 + rename 原子写，手编笔误不崩 minisd 启动。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** servers.json 读不出来的三类原因：read = 文件在但读不到（权限、占用、是个目录……）；
 *  parse = JSON 语法错；shape = 顶层不是对象。只作为枚举出 minisd，界面据此选横幅文案。 */
export type McpConfigErrorKind = 'read' | 'parse' | 'shape';

/** 拒写文案：常量，只允许拼 errno 码，**绝不拼 loadError 原文**——
 *  JSON.parse 的报错会带出约 10 字符的源码上下文（Electron 38 / V8 14 实测），可能正好是密钥片段；
 *  这句会经 RPC 原样到设置页和市场确认卡上。
 *  末句不叫人重启（W1a-5）：写前和设置页拉列表前都会对比磁盘重读，文件修好后回到这页再点一次就行。 */
function refuseMessage(kind: McpConfigErrorKind, code: string | undefined): string {
  if (kind === 'read') {
    return `servers.json 无法读取（${code ?? 'UNKNOWN'}）。为免覆盖原文件，MCP 服务器暂时不能添加、修改、启停或删除。`
      + '请检查文件权限或是否被其它程序占用，修好后回到这页即可。';
  }
  return 'servers.json 格式有误。为免覆盖你原来的配置，MCP 服务器暂时不能添加、修改、启停或删除。修好后回到这页即可。';
}

/** 一次读盘的结果：bytes = 读到了；absent = 没有文件（ENOENT）；error = 文件在但读不到（只留 errno 码） */
type DiskRead = { kind: 'bytes'; bytes: Buffer } | { kind: 'absent' } | { kind: 'error'; code: string };

export class McpServersStore {
  private dir: string;
  private file: string;
  /** Map 天然保持插入序 → list() 与写回的键序即文件序 */
  private entries = new Map<string, McpServerEntry>();
  /** 读盘出错时按空配置加载（手编笔误不崩 minisd 启动），但**之后拒绝一切写入**（见 assertWritable）。
   *  loadError 是诊断原文，只留在 minisd 内部（parse 类可能带文件片段）；对外只给 loadErrorKind 枚举。 */
  loadError: string | undefined;
  loadErrorKind: McpConfigErrorKind | undefined;
  /** read 类的 errno 码（EACCES / EISDIR / EBUSY…），拒写文案里用它告诉用户是哪种读不到 */
  loadErrorCode: string | undefined;
  /** W1a-5：上一次读到或写出的磁盘原文。null = 当时没有文件；undefined = 当时读不出来（下次一定重载）。
   *  设置页叫用户「env / headers 请直接改 servers.json」，而 save 会把内存副本整份写回——
   *  写前与设置页拉列表前拿它对比磁盘，变了就整份重读，手改的内容才不会被旧副本盖掉。
   *  比字节不比解码后的文本：非 UTF-8 的字节一律解码成 U+FFFD，只改了这些字节时文本对比看不出变化。 */
  private lastDisk: Buffer | null | undefined;

  constructor(paths: MinisPaths) {
    this.dir = paths.globalDir('mcp-servers');
    this.file = join(this.dir, 'servers.json');
    mkdirSync(this.dir, { recursive: true });
    this.load(this.readDisk());
  }

  /** 不用 existsSync：它对任何 stat 错误都回 false，父目录 EACCES / ENOTDIR 也会被当成「没有文件」而照常可写 */
  private readDisk(): DiskRead {
    try {
      return { kind: 'bytes', bytes: readFileSync(this.file) };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return { kind: 'absent' };
      // 只留 errno 码（码来自 Node，形如 EACCES，校验一下再用），message 不出这个函数
      return { kind: 'error', code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN' };
    }
  }

  /** 三变体宽容导入：①标准 mcpServers 键控；③单裸条目（name=default）；②裸名字键控 map。
   *  判序依据：①有 mcpServers 对象键；③顶层自带 command/url（本身就是一个 server 定义）；
   *  其余按②处理，非对象值逐条跳过。调用方保证 entries 为空、三个 loadError 字段都是 undefined。 */
  private load(disk: DiskRead): void {
    if (disk.kind === 'absent') { this.lastDisk = null; return; } // 首次运行的正常路径：空配置，可写
    if (disk.kind === 'error') {
      // 其它读错误不再冒充「解析失败」
      this.lastDisk = undefined;
      this.loadErrorKind = 'read';
      this.loadErrorCode = disk.code;
      this.loadError = `servers.json 读取失败: ${disk.code}`;
      return;
    }
    this.lastDisk = disk.bytes;
    let text = disk.bytes.toString('utf8');
    // 记事本等编辑器存 UTF-8 时会带 BOM，JSON.parse 不认它——合法文件不能因此被判成损坏
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    // 0 字节或只有空白：文件里已经没有数据可丢，当可写的空配置；拒写只会让用户卡住、得自己去删文件
    if (text.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      this.loadErrorKind = 'parse';
      this.loadError = `servers.json 解析失败: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (!isPlainObject(parsed)) {
      this.loadErrorKind = 'shape';
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

  /** W1a-5：重读磁盘。与上次读到或写出的一样就什么都不做——内存本来就是它的样子。
   *  不一样就清空后整份重载，包括「上次读不出来」和「这次读不出来」：read 类没有原文可比，一律重来，
   *  权限或占用解除后就自动恢复。重载撞上坏文件会进入 loadError，写方法随后被 assertWritable 拒掉。
   *  文件被删（ENOENT）按空配置处理，与首次运行一致：用户删掉的条目不该被旧副本写回去。 */
  private syncFromDisk(): void {
    const disk = this.readDisk();
    if (disk.kind === 'absent' && this.lastDisk === null) return;
    if (disk.kind === 'bytes' && this.lastDisk instanceof Buffer && disk.bytes.equals(this.lastDisk)) return;
    this.entries = new Map();
    this.loadError = undefined;
    this.loadErrorKind = undefined;
    this.loadErrorCode = undefined;
    this.load(disk);
  }

  /** 只读不写：让内存跟上磁盘。mcp.servers.list 每次先调它——应用开着时手改的内容、写坏又修好的文件，
   *  回到设置页就能看到，拒写态也随之解除，不用重启。 */
  refresh(): void {
    this.syncFromDisk();
  }

  /** 读盘出错时内存是空的，而 save 会把内存副本整份写回——此时写任何一次都会把用户原来的配置抹掉。
   *  所以出错后拒绝一切写入，原文件留在原位不动（不改名、不备份）；修好之后，下一次重读（写前或拉列表时）自动解除。 */
  private assertWritable(): void {
    if (this.loadErrorKind) throw new Error(refuseMessage(this.loadErrorKind, this.loadErrorCode));
  }

  /** 原子写（对齐 ProviderStore 模式）；始终写标准形态，条目序保持插入序。
   *  extra 先铺、识别字段后盖——未识别字段原样合并，写回不丢数据。
   *  写的是调用方给的新 Map，**落盘成功后才换进内存**：写盘失败时内存仍与磁盘一致，
   *  设置页开关失败后重拉列表拿到的才是真相（否则界面会显示一个磁盘上并不存在的状态）。 */
  private save(next: Map<string, McpServerEntry> = this.entries): void {
    // 第二道防线：以后新增的写路径即使忘了在入口调 assertWritable，也覆盖不了读坏的文件
    this.assertWritable();
    const out: Record<string, unknown> = {};
    for (const [name, e] of next) {
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
    const text = JSON.stringify({ mcpServers: out }, null, 2);
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, this.file);
    this.entries = next;
    // 记下自己写出的原文：下次对比时它不算外部修改
    this.lastDisk = Buffer.from(text, 'utf8');
  }

  /** 文件序（插入序）；返回副本，调用方改不到 store 内部状态 */
  list(): McpServerEntry[] {
    return [...this.entries.values()].map(e => ({ ...e }));
  }

  /** 与导入走同一套归一逻辑（decodeEntry 单一事实源），归一后校验：
   *  name 非空、stdio 必有 command、streamable-http 必有 url，非法抛中文 Error。
   *  新条目补 createdAt/updatedAt；更新条目只动 updatedAt，保留 createdAt 与 extra。 */
  upsert(input: Record<string, unknown>): McpServerEntry {
    // 先对比磁盘（W1a-5）：应用开着时手改的内容先读进来，这次改动落在它上面，而不是落在旧副本上
    this.syncFromDisk();
    // 拒写排在名称校验之前：配置读坏时，用户先要知道的是「为什么什么都写不进去」
    this.assertWritable();
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
    const next = new Map(this.entries);
    next.set(name, entry); // 已有键原位替换，Map 保持原插入序
    this.save(next);
    return { ...entry };
  }

  /** 配置读坏时对不存在的名字也报拒写：否则「删掉了」其实什么都没发生，界面却当成功 */
  remove(name: string): void {
    this.syncFromDisk();
    this.assertWritable();
    if (!this.entries.has(name)) return;
    const next = new Map(this.entries);
    next.delete(name);
    this.save(next);
  }

  toggle(name: string, enabled: boolean): void {
    this.syncFromDisk();
    this.assertWritable();
    const e = this.entries.get(name);
    if (!e) throw new Error(`MCP server 不存在: ${name}`);
    // 换新对象而不是原地改：写盘失败时旧对象原样留在内存里
    const next = new Map(this.entries);
    next.set(name, { ...e, enabled: enabled === true, updatedAt: new Date().toISOString() });
    this.save(next);
  }
}
