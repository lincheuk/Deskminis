/** 执行隔离第 2 步（二）：MCP 配置、技能、记忆被 DeskMinis 以外改过时，先让用户确认再用。
 *
 *  这三样是控制面：servers.json 里的启动命令会被执行，技能与记忆会进系统提示（SOUL.md 还按指令对待）。
 *  shell 与同一个用户的其它程序都能改它们，agent 只要在完全访问档下改一次，以后每次启动都会照着执行或注入。
 *
 *  做法：每一项（一台 MCP 服务器、一个技能目录、一个记忆文件）算一个指纹，记下用户认可过的指纹。
 *  - DeskMinis 自己写的（设置页增删改 MCP、导入或市场安装技能、memory_write 写日志）写完就记成认可；
 *    写之前这一项本来就没被认可的，写完照旧不认可（不能借一次正常保存把外部改动「洗白」）。
 *  - 用之前比对：指纹与认可的不同（新出现的、改过的）就先不用——MCP 不连接，技能不进索引，记忆文件不注入，
 *    并在界面上列出来，用户看过内容点确认之后才用。
 *  - 第一次运行这个版本时，已有的全部记成认可（老用户升级不用一项项确认）。
 *
 *  认可记录在 minis.db 的 settings 表里。同一个用户的程序也能改库，所以这是提高门槛、不是边界；
 *  边界要等第 3 步的低完整性沙箱（shell 读写不到数据根）。 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export type ControlKind = 'mcp' | 'skill' | 'memory';
export const CONTROL_KINDS: readonly ControlKind[] = ['mcp', 'skill', 'memory'];

/** 某一项的现状。key 在同一类里唯一：MCP 是服务器名，技能是目录名（id），记忆是文件名。 */
export interface ControlItem {
  kind: ControlKind;
  key: string;
  fingerprint: string;
  /** 界面上的标题，如「MCP 服务器 github」 */
  title: string;
  /** 给用户看的内容（启动命令、文件开头等），已截断、已遮掉像密钥的值。只在列待确认时才取，平时不读文件内容。 */
  preview: () => string;
}

export interface PendingItem extends ControlItem {
  /** new：认可记录里没有这一项；changed：有，但内容变了 */
  reason: 'new' | 'changed';
}

/** 发给界面的样子 */
export interface PendingView { kind: ControlKind; key: string; fingerprint: string; title: string; preview: string; reason: 'new' | 'changed' }

export const pendingView = (p: PendingItem): PendingView =>
  ({ kind: p.kind, key: p.key, fingerprint: p.fingerprint, title: p.title, preview: p.preview(), reason: p.reason });

export interface ApprovalStore { get(key: string): string | undefined; set(key: string, value: string): void }

export const CONTROL_APPROVALS_KEY = 'control.approved';

type Approvals = Record<ControlKind, Record<string, string>>;

const emptyApprovals = (): Approvals => ({ mcp: {}, skill: {}, memory: {} });

function parseApprovals(raw: string | undefined): Approvals | undefined {
  if (raw === undefined) return undefined;
  try {
    const o = JSON.parse(raw) as Partial<Record<ControlKind, unknown>>;
    const out = emptyApprovals();
    for (const k of CONTROL_KINDS) {
      const m = o[k];
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        for (const [key, fp] of Object.entries(m)) if (typeof fp === 'string') out[k][key] = fp;
      }
    }
    return out;
  } catch {
    // 记录坏了：当作什么都没认可（宁可多问），而不是当作第一次运行全部认可
    return emptyApprovals();
  }
}

/** 某一类的现状从哪里来。每次要用、要列待确认时现取（文件可能刚被改过）。 */
export type ControlSource = () => ControlItem[];

export interface ControlGuardOptions {
  store: ApprovalStore;
  sources: Record<ControlKind, ControlSource>;
  /** 待确认的集合变了（多了、少了、内容变了）时调用，用来通知界面 */
  onPendingChanged?: (pending: PendingItem[]) => void;
}

export class ControlGuard {
  private approvals: Approvals;
  private lastSignature = '';

  constructor(private readonly opts: ControlGuardOptions) {
    const saved = parseApprovals(opts.store.get(CONTROL_APPROVALS_KEY));
    if (saved) {
      this.approvals = saved;
    } else {
      // 第一次运行这个版本：现有的全部认可
      this.approvals = emptyApprovals();
      for (const k of CONTROL_KINDS) for (const it of this.current(k)) this.approvals[k][it.key] = it.fingerprint;
      this.persist();
    }
    this.lastSignature = this.signatureOf(this.computePending());
  }

  private persist(): void {
    this.opts.store.set(CONTROL_APPROVALS_KEY, JSON.stringify(this.approvals));
  }

  private current(kind: ControlKind): ControlItem[] {
    try { return this.opts.sources[kind](); } catch (e) {
      console.warn(`读取${kind}的现状失败（这次按没有处理）:`, e);
      return [];
    }
  }

  private computePending(): PendingItem[] {
    const out: PendingItem[] = [];
    for (const k of CONTROL_KINDS) {
      for (const it of this.current(k)) {
        const ok = this.approvals[k][it.key];
        if (ok !== it.fingerprint) out.push({ ...it, reason: ok === undefined ? 'new' : 'changed' });
      }
    }
    return out;
  }

  private signatureOf(p: readonly PendingItem[]): string {
    return p.map(i => `${i.kind}\0${i.key}\0${i.fingerprint}`).sort().join('\n');
  }

  /** 待确认的变了就通知一次。 */
  private notifyIfChanged(p: PendingItem[]): void {
    const sig = this.signatureOf(p);
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    try { this.opts.onPendingChanged?.(p); } catch { /* 通知失败不影响判定 */ }
  }

  /** 现在待确认的全部（顺带通知界面）。 */
  pending(): PendingItem[] {
    const p = this.computePending();
    this.notifyIfChanged(p);
    return p;
  }

  isApproved(kind: ControlKind, key: string, fingerprint: string): boolean {
    return this.approvals[kind][key] === fingerprint;
  }

  /** 这一类里现在可以用的 key（认可过、内容没变）。顺带检查待确认的有没有变化。 */
  approvedKeys(kind: ControlKind): Set<string> {
    const ok = new Set<string>();
    for (const it of this.current(kind)) if (this.isApproved(kind, it.key, it.fingerprint)) ok.add(it.key);
    this.pending();
    return ok;
  }

  /** 用户在界面上看过之后确认。指纹必须与现在的一致：看过之后又被改了，就不能拿旧的确认放行新的。 */
  confirm(kind: ControlKind, key: string, fingerprint: string): void {
    if (!CONTROL_KINDS.includes(kind)) throw new Error(`未知的类别: ${String(kind)}`);
    const now = this.current(kind).find(i => i.key === key);
    if (!now) throw new Error('这一项已经不在了');
    if (now.fingerprint !== fingerprint) throw new Error('内容在你查看之后又变了，请重新查看再确认');
    this.approvals[kind][key] = fingerprint;
    this.persist();
    this.pending();
  }

  /** DeskMinis 自己写完一项之后调用。before 是写之前的指纹（之前没有这一项时为 undefined）：
   *  之前就没被认可的，写完照旧不认可。after 为 undefined 表示这一项被删掉了。 */
  recordOwnWrite(kind: ControlKind, key: string, before: string | undefined, after: string | undefined): void {
    const wasOk = before === undefined || this.approvals[kind][key] === before;
    if (after === undefined) {
      delete this.approvals[kind][key];
    } else if (wasOk) {
      this.approvals[kind][key] = after;
    } else {
      return;
    }
    this.persist();
    this.pending();
  }

  /** 把一项改名之后调用：认可状态跟着名字走（没被认可的改了名也照旧不认可）。 */
  recordOwnRename(kind: ControlKind, from: string, to: string): void {
    const fp = this.approvals[kind][from];
    delete this.approvals[kind][from];
    if (fp !== undefined) this.approvals[kind][to] = fp;
    else delete this.approvals[kind][to];
    this.persist();
    this.pending();
  }
}

// ---------- 指纹与预览 ----------

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const PREVIEW_CHARS = 1500;
export function clip(text: string, max = PREVIEW_CHARS): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max).join('') + `\n…（还有 ${cps.length - max} 个字符没显示）`;
}

const SECRET_KEY_RE = /key|token|secret|passw|pwd|auth|cookie|credential/i;
/** 像密钥的值遮起来，只留首尾各两个字符。 */
export function maskValue(name: string, value: string): string {
  if (!SECRET_KEY_RE.test(name)) return value;
  if (value.length <= 6) return '••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

export interface McpLaunch {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

const sortedEntries = (r: Record<string, string> | undefined): Array<[string, string]> =>
  Object.entries(r ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** 只看决定「会执行什么、连到哪里、带什么」的字段：备注、启停、超时、时间戳改了不算。 */
export function mcpFingerprint(e: McpLaunch): string {
  return sha256(JSON.stringify([e.transport, e.command ?? null, e.args ?? [], sortedEntries(e.env), e.cwd ?? null, e.url ?? null, sortedEntries(e.headers)]));
}

const quoteArg = (a: string): string => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export function mcpPreview(e: McpLaunch): string {
  const lines: string[] = [];
  if (e.transport === 'stdio') {
    lines.push(`启动命令：${[e.command ?? '', ...(e.args ?? [])].map(quoteArg).join(' ')}`);
    if (e.cwd !== undefined) lines.push(`工作目录：${e.cwd}`);
    const env = sortedEntries(e.env);
    if (env.length) lines.push(`环境变量：\n${env.map(([k, v]) => `  ${k}=${maskValue(k, v)}`).join('\n')}`);
  } else {
    lines.push(`地址：${e.url ?? ''}`);
    const headers = sortedEntries(e.headers);
    if (headers.length) lines.push(`请求头：\n${headers.map(([k, v]) => `  ${k}: ${maskValue(k, v)}`).join('\n')}`);
  }
  return clip(lines.join('\n'));
}

/** 目录里的文件（相对路径，正斜杠，按字典序）。不跟随符号链接：链接记成「链接 → 目标」。 */
function walkFiles(dir: string, rel = '', out: Array<{ rel: string; abs: string; link?: string; size: number; mtimeMs: number }> = []): typeof out {
  let names: string[];
  try { names = readdirSync(join(dir, rel)); } catch { return out; }
  names.sort();
  for (const name of names) {
    const r = rel ? `${rel}/${name}` : name;
    const abs = join(dir, r);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) {
      let target = '';
      try { target = readlinkSync(abs); } catch { /* 读不出目标也记下这是个链接 */ }
      out.push({ rel: r, abs, link: target, size: 0, mtimeMs: st.mtimeMs });
    } else if (st.isDirectory()) {
      if (out.length < 5000) walkFiles(dir, r, out);
    } else if (st.isFile()) {
      out.push({ rel: r, abs, size: st.size, mtimeMs: st.mtimeMs });
    }
    if (out.length >= 5000) break;
  }
  return out;
}

/** 内容哈希最多读这么多字节；更大的技能目录按「路径 + 大小 + 修改时间」算（仍能发现改动，只是改回原样也算改过）。 */
const SKILL_HASH_BYTES = 32 * 1024 * 1024;

/** 技能目录的指纹：目录里所有文件的路径与内容。技能里的脚本也会被照着执行，所以不只看 SKILL.md。
 *  每次用技能前都要算：按「路径 + 大小 + 修改时间」缓存，没变就不重读内容。 */
export class SkillFingerprints {
  private cache = new Map<string, { sig: string; fp: string }>();

  of(dir: string): { fingerprint: string; files: string[] } {
    const files = walkFiles(dir);
    const sig = files.map(f => `${f.rel}\0${f.link ?? ''}\0${f.size}\0${f.mtimeMs}`).join('\n');
    const hit = this.cache.get(dir);
    if (hit && hit.sig === sig) return { fingerprint: hit.fp, files: files.map(f => f.rel) };
    const total = files.reduce((n, f) => n + f.size, 0);
    const h = createHash('sha256');
    if (total > SKILL_HASH_BYTES) {
      h.update('meta\n').update(sig);
    } else {
      for (const f of files) {
        h.update(f.rel).update('\0');
        if (f.link !== undefined) { h.update('link\0').update(f.link); continue; }
        try { h.update(readFileSync(f.abs)); } catch { h.update('unreadable'); }
        h.update('\0');
      }
    }
    const fp = h.digest('hex');
    this.cache.set(dir, { sig, fp });
    return { fingerprint: fp, files: files.map(f => f.rel) };
  }
}

/** 单个文件的指纹（内容的 sha256），按「大小 + 修改时间」缓存。读不出来的文件当作不存在。 */
export class FileFingerprints {
  private cache = new Map<string, { sig: string; fp: string }>();

  of(path: string): string | undefined {
    let st;
    try { st = lstatSync(path); } catch { this.cache.delete(path); return undefined; }
    if (!st.isFile()) return undefined;
    const sig = `${st.size}\0${st.mtimeMs}`;
    const hit = this.cache.get(path);
    if (hit && hit.sig === sig) return hit.fp;
    let fp: string;
    try { fp = sha256(readFileSync(path, 'utf8')); } catch { return undefined; }
    this.cache.set(path, { sig, fp });
    return fp;
  }
}

export function skillPreview(dir: string, files: readonly string[]): string {
  const md = files.find(f => f.toLowerCase() === 'skill.md');
  let body = '';
  if (md) { try { body = readFileSync(join(dir, md), 'utf8'); } catch { body = '（读不出 SKILL.md）'; } }
  const list = files.length > 20 ? [...files.slice(0, 20), `…还有 ${files.length - 20} 个文件`] : files;
  return clip(`目录：${dir}\n文件：${list.join('、') || '（空）'}\n\n${body}`);
}
