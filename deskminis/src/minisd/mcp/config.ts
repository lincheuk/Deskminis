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

/** 单条序列化：save 写盘与 compose 打补丁共用同一份（W1a-6）——补丁的底稿与落盘同形，
 *  「以旧条目为底打补丁」里的「旧条目」才就是文件里那一条。
 *  extra 先铺、识别字段后盖；按传输类型只写该族字段；enabled 只在停用时落盘；不写 transport / type。 */
function encodeEntry(e: McpServerEntry): Record<string, unknown> {
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
  return o;
}

/** 两族字段：换传输类型时旧族要整族清掉。不清的话，stdio 改远端时 base 里的 command 还在，
 *  decodeEntry 见到 command 就判回 stdio，新填的 url 又被 save 按族静默丢掉——改了等于没改。 */
const FAMILY_FIELDS: Record<McpServerEntry['transport'], readonly string[]> = {
  stdio: ['command', 'args', 'env', 'cwd'],
  'streamable-http': ['url', 'headers'],
};

/** 补丁想换成哪种传输：显式 transport / type（http 别名或 'stdio'）优先；否则只给 command 判 stdio、
 *  只给 url 判 http；都看不出来就是不换（undefined）。 */
function targetTransport(patch: Record<string, unknown>): McpServerEntry['transport'] | undefined {
  for (const k of ['transport', 'type']) {
    const v = patch[k];
    if (isHttpAlias(v)) return 'streamable-http';
    if (v === 'stdio') return 'stdio';
  }
  const hasCommand = typeof patch.command === 'string';
  const hasUrl = typeof patch.url === 'string';
  if (hasCommand && !hasUrl) return 'stdio';
  if (hasUrl && !hasCommand) return 'streamable-http';
  return undefined;
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
   *  单条形态见 encodeEntry：extra 先铺、识别字段后盖——未识别字段原样合并，写回不丢数据。
   *  写的是调用方给的新 Map，**落盘成功后才换进内存**：写盘失败时内存仍与磁盘一致，
   *  设置页开关失败后重拉列表拿到的才是真相（否则界面会显示一个磁盘上并不存在的状态）。 */
  private save(next: Map<string, McpServerEntry> = this.entries): void {
    // 第二道防线：以后新增的写路径即使忘了在入口调 assertWritable，也覆盖不了读坏的文件
    this.assertWritable();
    const out: Record<string, unknown> = {};
    for (const [name, e] of next) out[name] = encodeEntry(e);
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

  /** W1a-6：以旧条目为底打补丁（原先是整条替换：只改一个备注，env / headers / cwd / 超时和停用状态就全没了；
   *  市场「更新」也会把用户停掉的服务器悄悄重新启用）。规则：
   *  - base = 现存的 renameFrom ?? name 那一条；底稿 = encodeEntry(base)，与落盘同形。
   *  - 输入里值为 undefined 的键当作没出现；null 表示删掉这个键（extra 键同样适用，如 oauth:null）——
   *    undefined 过 JSON-RPC 会被丢掉，表达不了「清空」，null 是 JSON 里唯一对所有字段都说得通的删除标记
   *    （与 JSON Merge Patch / RFC 7396 一致）；其它值整值覆盖，env / headers / args 不做深合并
   *    （市场更新「移除新版本不再声明的 env 键」靠的就是整值替换）。
   *  - 换传输类型时先清旧族字段（见 FAMILY_FIELDS）。
   *  - 没给 enabled / disabled 就保留旧值；给了其中一个，先删另一个，免得旧值把这次的意思压回去。
   *  - 最后经 decodeEntry 归一与校验（与导入同一入口），错误文案不变，判定依据是合并之后的条目。
   *  - createdAt 取 base 的；没有 base 时用输入的或当下。updatedAt 一律当下。
   *  - renameFrom 是控制键：在合并前剥掉（否则会被收进 extra 写进 servers.json），原位换键名，一次写盘完成。
   *  同名新建会合并进旧条目——由设置页在前端拦（设计稿 §2），后端不加控制键：市场同名时正是更新流程，要的就是合并。 */
  private compose(input: Record<string, unknown>): { entry: McpServerEntry; next: Map<string, McpServerEntry> } {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') throw new Error('MCP server 名称不能为空');
    const { name: _name, renameFrom: rawRenameFrom, ...rest } = input;
    let renameFrom: string | undefined;
    if (rawRenameFrom !== undefined && rawRenameFrom !== null) {
      if (typeof rawRenameFrom !== 'string') throw new Error('renameFrom 必须是字符串');
      if (rawRenameFrom !== name) renameFrom = rawRenameFrom;
    }
    const base = this.entries.get(renameFrom ?? name);
    if (renameFrom !== undefined) {
      if (!base) throw new Error(`MCP server 不存在: ${renameFrom}`);
      if (this.entries.has(name)) throw new Error(`已存在同名 MCP server: ${name}`);
    }
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;

    const raw: Record<string, unknown> = base ? encodeEntry(base) : {};
    const target = targetTransport(patch);
    if (base && target !== undefined && target !== base.transport) {
      for (const k of FAMILY_FIELDS[base.transport]) delete raw[k];
    }
    if ('enabled' in patch) delete raw.disabled;
    if ('disabled' in patch) delete raw.enabled;
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete raw[k];
      else raw[k] = v;
    }

    const entry = decodeEntry(name, raw);
    if (!entry) {
      if (raw.command !== undefined && typeof raw.command !== 'string') throw new Error('command 必须是字符串');
      if (raw.url !== undefined && typeof raw.url !== 'string') throw new Error('url 必须是字符串');
      if (typeof raw.url === 'string' || isHttpAlias(raw.type) || isHttpAlias(raw.transport)) {
        throw new Error('streamable-http 类型必须提供 url');
      }
      throw new Error('stdio 类型必须提供 command');
    }
    const now = new Date().toISOString();
    if (base) {
      if (base.createdAt) entry.createdAt = base.createdAt;
      else delete entry.createdAt;
    } else {
      entry.createdAt ??= now;
    }
    entry.updatedAt = now;

    let next: Map<string, McpServerEntry>;
    if (renameFrom !== undefined) {
      // 原位换键名：按原顺序重建，列表里这一行位置不变；新旧名在同一次 save 里一起落盘
      next = new Map();
      for (const [k, v] of this.entries) next.set(k === renameFrom ? name : k, k === renameFrom ? entry : v);
    } else {
      next = new Map(this.entries);
      next.set(name, entry); // 已有键原位替换，Map 保持原插入序
    }
    return { entry, next };
  }

  /** 新增或打补丁（规则见 compose）。写前先对比磁盘（W1a-5），读坏时拒写（W1a-4）。 */
  upsert(input: Record<string, unknown>): McpServerEntry {
    // 先对比磁盘（W1a-5）：应用开着时手改的内容先读进来，这次改动落在它上面，而不是落在旧副本上
    this.syncFromDisk();
    // 拒写排在名称校验之前：配置读坏时，用户先要知道的是「为什么什么都写不进去」
    this.assertWritable();
    const { entry, next } = this.compose(input);
    this.save(next);
    return { ...entry };
  }

  /** 试连预览（W1a-6）：与 upsert 同一套合并与校验，但不写盘、不改内存。
   *  编辑表单只提交改过的字段，已存的 env / headers / cwd / 超时要从这里带进试连——原先试连在一个
   *  空的 scratch store 里 upsert，需要环境变量的服务器在表单里试连必然失败。
   *  不受读坏拒写拦截：试连是「摸一下」，一个字节都不写。先对比磁盘，手改后的内容同样进试连。 */
  preview(input: Record<string, unknown>): McpServerEntry {
    this.syncFromDisk();
    return { ...this.compose(input).entry };
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
